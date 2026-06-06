# Topic-Centric Knowledge Base — Architecture & Decomposition

**Date:** 2026-06-02
**Status:** Approved (architecture + decomposition); per-sub-project specs to follow.
**Supersedes:** the branch-centric compile → cross-branch merge pipeline (spec 108/110 lineage).

---

## 1. Motivation

The current pipeline compiles **per branch** (`compileBranch`: a branch's commit
summaries → topic pages) and then **merges across branches** into the `_wiki/`
layer. Branch was chosen as the compile unit for three reasons, only one of which
is intrinsic to the product goal:

1. **Recall scoping** (intrinsic): recall asks "what was I doing on *this branch*",
   so a per-branch artifact was directly consumable.
2. **Token-bounded batching** (incidental): a branch is a convenient partition to
   keep each LLM call under the output ceiling.
3. **Free human clustering** (incidental): commits on one branch are already
   thematically related, so per-branch compile produces coherent topics cheaply.

The product goal, restated, is **Karpathy's compounding wiki**
(<https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f>): an
LLM-maintained, **topic-organized** knowledge base built incrementally from a
stream of sources, where newer information supersedes stale information.

Against that goal the branch intermediate is **scaffolding, not the target**: a
topic that spans five branches over months gets fragmented across five per-branch
artifacts and then re-unified by the merge stage — fragment-then-reassemble, two
LLM passes, with information loss in the per-branch compression step. The
organizing unit should be the **topic**, and the synthesis should read the source
stream directly.

## 2. Goal

Automatically build and maintain a **topic-organized personal knowledge base**
from the continuously-produced stream of commit summaries, plans, notes, and
Memory Bank user files. Recall is **explicitly de-prioritized** — it is kept
working (re-pointed at the new KB) but is no longer a design driver.

## 3. Core principles (load-bearing — every sub-project must honor these)

1. **Topic is the organizing unit.** Branch is demoted to a *metadata tag* on a
   topic page (`relatedBranches`, for wiki backlinks/provenance) — it is no longer
   a compile/storage unit. (It is **not** a recall filter; recall does not read the
   KB — see §4.4.)

2. **Chronological fold, old → new.** Ingestion is a `scan`/`fold` over a
   time-ordered source stream, **not** an order-insensitive `reduce`. The KB at any
   moment equals "all sources up to the high-water mark, folded in timestamp
   order."

3. **Recency wins; stale claims are corrected, not appended.** Newer sources are
   closer to code truth. Old document content drifts from the implementation as
   features evolve. So a topic page is a **materialized view** — "the current
   projection of code truth onto this topic" — not an append-only log. Ingest must
   *overwrite or delete* claims that newer sources contradict. History lives in the
   immutable source layer; the topic layer only ever states "what is true now."

4. **Serialized ingestion.** A time-ordered fold cannot run concurrently against
   the same topic page. Reuse the existing file-locked, timestamp-ordered
   `QueueWorker`.

5. **Replayable.** Re-folding history (e.g. after a prompt change) is done by
   resetting the high-water mark and replaying sources in order. A single source
   cannot be re-folded out of timeline position.

## 4. Target architecture

### 4.1 Three layers (mirrors Karpathy)

| Layer | Content | Mutability | Reuse |
|---|---|---|---|
| **Sources** (system of record) | commit summaries / plans / notes / user files, each timestamped | immutable | existing orphan branch + Memory Bank |
| **Topic index** `topics/index.json` | per topic: `{ stableSlug, title, summary, relatedBranches, sourceRefs, lastUpdatedAt }`; drives index-driven routing | mutable | new (some fields from `CompiledTopic`) |
| **Topic pages** `topics/<slug>.json` (canonical) + `_wiki/<slug>.md` (rendered) | one page per topic = current-truth projection | mutable (may rewrite/delete) | render layer reuses `WikiMarkdownBuilder` / `FolderStorage` |
| **High-water mark** `topics/processed.json` | set of already-ingested source IDs | monotonic-growing | new (cursor pattern) |

All three derived artifacts go through the existing `StorageProvider`
(dual-write: orphan system-of-record + Memory Bank folder), because the KB is
**shared** and expensive to rebuild — local-only state would force every machine
to re-fold.

### 4.2 Ingest pipeline (the new core)

Triggered by the debounced batch worker (reuse `QueueWorker` compile-merge op +
`MergeTrigger` cooldown) or manually via `jolli compile`. Per batch:

```
1. Collect    take all sources NOT in processed.json, merge the four streams,
              sort old → new (deterministic tie-break)
2. Route      LLM reads the topic index + the new sources' headlines →
              routing plan: { existing slugs to reconcile, new topics to create },
              each mapped to its relevant source subset       (index-driven)
3. Reconcile  per affected topic, in time order: feed (current page + that page's
              assigned new sources, dated) → LLM rewrites the page applying
              recency-wins + stale-claim correction. New topics: create fresh.
4. Index      refresh touched topics' index entries; add new topic entries
5. Mark       add the fully-ingested sources to processed.json
6. Render     regenerate _wiki/ markdown from the updated topic pages
```

### 4.3 High-water mark = processed source-ID set

Tracked as the **set of ingested source IDs** (commit hash / file fingerprint),
not a single timestamp watermark. This decouples *"has this source been
processed"* (idempotency) from *"what is its logical time"* (recency ordering).
Consequence: a source that **arrives out of order** (a cherry-pick/rebase commit
dated yesterday but pushed today; a user file edited now but logically old) is
still ingested — and, being old, correctly **loses** to existing newer page
content under recency-wins. A plain timestamp watermark would silently skip it.

### 4.4 Recall (decoupled — does NOT read the topic KB)

> **Revised 2026-06-04.** The original plan re-pointed recall at the topic KB
> (filter topic pages by `relatedBranches`). **Cancelled** — the topic KB's data
> shape is fundamentally wrong for recall:
>
> - recall wants the **branch-scoped, chronological, episodic** narrative of "what
>   I did on this branch";
> - the topic KB is **cross-branch**, topic-organized, a **current-truth**
>   materialized view where **newer sources overwrite older ones** (principle 3).
>
> Filtering topic pages by `relatedBranches` yields cross-branch current-truth
> pages that merely *mention* the branch — with this branch's own contribution
> possibly already overwritten by later branches. The two products have **opposite
> data contracts** (KB: dedup + overwrite + cross-branch; recall: preserve +
> chronological + single-branch); one materialized view cannot serve both.
>
> **Decision:** recall depends on **no compiled/ingested artifact**. Its source is
> the immutable per-branch **commit summaries + plans + notes** on the orphan
> branch — its long-standing pre-compile behavior, to which `ContextCompiler`
> already falls back on cache miss. No dedicated recall change is built; the
> `compiledTopics` / `validateCache` / `buildCompiledTopics` layer is stripped from
> `ContextCompiler` as part of the SP5 teardown (§5), leaving recall on raw
> summaries. `relatedBranches` stays on the index as topic metadata (wiki
> backlinks), no longer a recall filter.

### 4.5 Error handling & replay

- **Per-page reconcile is small** (one page + a slice of sources), so `max_tokens`
  truncation is far less likely than the old 20-branch merge. A failed page leaves
  the **old page intact** and does **not** add its sources to `processed.json`, so
  the next batch retries it. Fail loud per page.
- **Replay** (prompt change / corruption): reset `processed.json` + clear topic
  pages, then replay all sources in timestamp order. A single source cannot be
  re-folded out of position (principle 5).

### 4.6 Removed

`compileBranch` / `compileBranches`; branch-batched `mergeBranches` /
`mergeOfMerges` / `mergeBranchesHierarchical`; per-branch `CompiledStore`
artifacts; `CacheValidator` branch/merge axes (replaced by the processed-ID set);
the `--all` / `--merge` branch semantics in `CompileCommand`.

## 5. Decomposition

Too large for one spec. Five sub-projects, each with its own spec → plan →
implementation cycle:

| # | Sub-project | Scope | Depends on |
|---|---|---|---|
| 1 | **Data model + unified timeline iterator** | `SourceRef`, processed-ID set, topic index, topic-page store schemas + read/write; the pure `listPendingSources` iterator | — (foundation) |
| 2 | **Ingest pipeline** | Collect → Route → Reconcile → Index → Mark → Render, incl. the two LLM prompts (route / reconcile) | 1 |
| 3 | **Trigger integration + CLI** | wire batch ingest into `QueueWorker` / `MergeTrigger` (debounced); reshape `jolli compile` to "ingest pending / full rebuild / reset-replay" | 2 |
| 4 | ~~**Recall re-point**~~ | **CANCELLED** (§4.4, revised 2026-06-04) — topic KB is unsuitable for branch-scoped recall. Recall stays on raw per-branch summaries; its decoupling from the compiled layer folds into SP5. | — |
| 5 | **Migration + removal** | delete per-branch compile/merge code + artifacts; **strip `compiledTopics`/`validateCache`/`buildCompiledTopics` from `ContextCompiler`** so recall reads raw summaries only; one-time backfill (replay full history into the KB) | 2, 3 |

Build order: 1 → 2 → 3 → 5 (SP4 cancelled). SP5 now owns the recall decoupling, so it must drop `ContextCompiler`'s compiled-layer calls in the same pass that deletes branch-compile + `CacheValidator`.

## 6. Non-goals / explicit trade-offs

- **Recall is NOT served by the topic KB** (§4.4, revised 2026-06-04). It keeps
  reading raw per-branch summaries/plans/notes. The only change recall sees is
  losing the `compiledTopics` density layer (it falls back to the raw-summary
  context it already produces on cache miss) — accepted; recall is de-prioritized
  and its data contract is incompatible with the KB anyway.
- **No vector DB / embeddings.** Index-driven routing per Karpathy's
  "context beats RAG below ~100k tokens"; revisit only if the index outgrows
  context.
- **Two LLM-pass branch fragment-then-reassemble is gone**, replaced by a single
  source → topic fold.

## 7. Open questions deferred to sub-project specs

- Exact route / reconcile prompt design and output schema (sub-project 2).
- Backfill ordering and idempotency at scale (sub-project 5).
- `processed.json` compaction strategy as history grows (sub-project 1 proposes a
  shape; revisit if it becomes large).

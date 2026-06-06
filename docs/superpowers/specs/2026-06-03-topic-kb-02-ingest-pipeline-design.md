# Topic KB — Sub-project 2: Ingest Pipeline

**Date:** 2026-06-03
**Status:** Design approved; ready for implementation-plan.
**Parent:** [Topic-Centric Knowledge Base — Architecture & Decomposition](2026-06-02-topic-centric-knowledge-base-design.md)
**Builds on:** [Sub-project 1 — Data Model & Timeline Iterator](2026-06-02-topic-kb-01-data-model-timeline-design.md)

---

## 1. Purpose

Turn the not-yet-ingested source stream (sub-project 1's `listPendingSources`) into maintained, topic-organized knowledge pages via two LLM steps — **route** (index-driven classification) and **reconcile** (per-page recency-wins synthesis) — then persist pages, update the index, advance the high-water mark, and re-render the visible wiki.

## 2. Scope

The pipeline + the two prompts + per-page persistence + wiki render. Exposes:
- `ingestPendingBatch(cwd, config, opts?)` — one batch (collect ≤N → route → reconcile → mark → render).
- `drainIngest(cwd, config, opts?)` — loop `ingestPendingBatch` until no pending sources remain (bounded by a max-iteration guard).

## 3. Out of scope

- **Visible `_wiki/*.md` render — moved to sub-project 3.** Plan-time discovery: rendering couples to `FolderStorage`'s private `generateWikiPages` and the `renderTopic(CompiledTopic, MergedKnowledge, …)` shape, plus active-provider concerns — heavier than the "thin adapter" this spec originally assumed. It is done alongside the trigger/CLI integration (which already has to touch `FolderStorage`). Sub-project 2 produces the **canonical layer only** (`topics/*.json` + `index.json` + watermark advance), which is independently testable and is exactly what recall (sub-project 4) reads.
- Wiring into `QueueWorker` / `MergeTrigger` / `jolli compile` — sub-project 3.
- Recall re-point — sub-project 4.
- Removing the branch-compile code + history backfill — sub-project 5.

## 4. Pipeline (one `ingestPendingBatch`)

```
1. Collect    pending = listPendingSources(cwd, processed); batch = pending.slice(0, N)   (N default 50)
              if batch empty → return { ingested: 0, done: true }
2. Route      one LLM call (action "route", JSON-in-text). Input: topic index (slug/title/summary)
              + the batch presented as a NUMBERED headline list [0..len-1]. Output JSON maps
              ordinals → topics (existing updates + proposed new topics). Parse + validate.
3. Reconcile  for each affected topic (existing updated ∪ new), one LLM call (action "reconcile",
              delimited): input = current page content (empty for new) + the full content of that
              topic's assigned sources. Output one ===TOPIC=== page. Save via TopicPageStore +
              upsert its TopicIndexEntry.
4. Mark       a source is added to processed.json ONLY if every topic it was routed to reconciled
              successfully. Partially/failed sources are left unprocessed (retried next batch).
5. Return     { ingested: <#sources marked>, touchedSlugs: [...], done: pending.length <= N }

(Visible _wiki/<slug>.md render is sub-project 3 — see §3. The pipeline returns touchedSlugs so the
 sub-project-3 trigger can render exactly the changed pages.)
```

`drainIngest` loops until `done` (guard: max iterations = `ceil(totalPending / N) + 2`, logged if hit).

### 4.1 Why route sees only headlines, reconcile sees full content

Route is a classifier — it decides *which* topics each source touches, needing only headlines (cheap, lets one call see the whole batch + whole index). Reconcile is the synthesizer — it needs each assigned source's full body, but only for one page's small source subset at a time. This keeps the expensive tokens on the reconcile side, amortized per page, instead of an all-sources × all-pages product.

## 5. Source content access (new component `SourceContent.ts`)

`listPendingSources` returns bare `SourceRef`s. The pipeline needs two projections, both keyed by `SourceRef`:

- `loadSourceHeadline(ref, cwd, ctx) → { ordinalLabel fields }` — cheap metadata for the route list:
  - `summary`: `commitMessage`, `commitDate`, `branch` (from the already-loaded `SummaryIndexEntry` — no extra read).
  - `plan`: `PlanEntry.title`, `updatedAt`, `branch`.
  - `note`: `NoteEntry.title`, `updatedAt`, `branch`.
  - `userfile`: `path`, `scope` (+ first heading line if cheap).
- `loadSourceContent(ref, cwd, storage?) → string | null` — full body for reconcile:
  - `summary`: `getSummary(ref.id, cwd, storage)` → format topics (trigger/decisions/response/files) into text (same shape as the existing `formatSummaryForCompile`).
  - `plan`: read `PlanEntry.sourcePath` file body (reuse `PlanPromptFormatter` body-reading helper).
  - `note`: read `NoteEntry.sourcePath` (`notes/<id>.md`) body (reuse `NotePromptFormatter` helper).
  - `userfile`: re-scan `listUserKnowledge` and match by `path@fingerprint`; `content` is already present. If the file changed since routing (fingerprint no longer matches → not found), return `null` and skip — the new fingerprint becomes a fresh pending source next batch.
  - Returns `null` when the source has vanished (deleted plan/note/file); the pipeline treats a `null` body as "drop this source from this reconcile" and, if that leaves a topic with no content, skips the page (logged) without marking the source processed.

`ctx` is the per-batch already-loaded index + plans registry, passed in so headline lookups don't re-read per source.

## 6. Route step

### 6.1 Input

- The current topic index as a compact list: `- <stableSlug> — <title>: <summary>` (one line per existing topic; empty when the KB is fresh).
- The batch as a numbered headline list:
  `[<n>] (<type>, <branch>, <date>) <headline>` for n in 0..len-1.

### 6.2 Output (JSON-in-text — `callLlm` has no native tool-use)

```jsonc
{
  "updates":   [ { "stableSlug": "auth-origin-allowlist", "sourceIndexes": [0, 3] } ],
  "newTopics": [ { "stableSlug": "rate-limiter", "title": "Rate limiter", "sourceIndexes": [1] } ]
}
```

- `sourceIndexes` reference the numbered headline list (NOT raw ids — avoids the LLM mangling long hashes or colliding ids across types). Mapped back to `SourceRef` by ordinal.
- One source ordinal MAY appear under multiple topics (one-to-many).
- `stableSlug` rules: lowercase kebab, 3–40 chars, encode the *concept*; reuse an existing slug from the index when the source belongs to a known topic (same rule the COMPILE/MERGE prompts already state).
- A source ordinal that route omits entirely is still marked processed (it carried no topical content), with a debug log — it is not silently lost, just deliberately un-filed.

### 6.3 Parsing & failure (fail-loud)

- `JSON.parse` the response; validate shape (arrays present, slugs kebab, indexes in range).
- If `stopReason === "max_tokens"` OR parse/validation fails → abort this batch, mark **nothing** processed, log an error, return `{ ingested: 0, done: false, error }`. The next invocation retries the same batch. (Mirrors the existing merge truncation fail-loud — never treat a partial map as complete.)
- Out-of-range / unknown-slug index entries are dropped with a WARN rather than failing the whole batch.

### 6.4 maxTokens

~16K (input is index + N headlines; output is a small mapping). Above the 16,384 streaming threshold so the call uses the no-deadline streaming path (same reason `COMPILE_MAX_TOKENS` does).

## 7. Reconcile step

### 7.1 Input (per affected topic)

- The current page's `content` (empty string for a new topic), plus its title/slug.
- The assigned sources' full bodies (`loadSourceContent`), each labeled with its date so the LLM can apply recency, ordered old→new.

### 7.2 Instructions (recency-wins materialized view)

The reconcile prompt instructs: produce the topic page as the **current-truth projection** — newer sources supersede older ones on conflict; **delete or rewrite** claims the newer sources contradict (do not append a changelog); keep the page self-contained. This is the principle-3 contract from the parent spec.

### 7.3 Output (delimited — same format family as `parseCompileResponse`)

One `===TOPIC===` block with `---TITLE---`, `---STABLESLUG---`, `---CONTENT---`, `---KEYDECISIONS---`, `---RELATEDBRANCHES---`, `---SOURCECOMMITS---`, **plus `---SUMMARY---`** (one-line index summary — see §9). The first six are exactly what `parseCompileResponse` extracts; `---SUMMARY---` is the one new field.

**Parser decision:** add an optional `---SUMMARY---` extraction so the standard parser is reused, not duplicated. Concretely: export `KnowledgeCompiler`'s private `extractField` helper (it is already the field reader `parseCompileResponse` uses) and have a thin reconcile parser call `parseCompileResponse` for the six standard fields + `extractField(block, "SUMMARY")` for the summary. No second delimited-parsing implementation. The pipeline takes the single parsed topic and writes a `TopicPage`:

- `content` ← `---CONTENT---`
- `relatedBranches` ← union of the page's prior `relatedBranches` and the assigned sources' branches (the LLM's `---RELATEDBRANCHES---` is advisory; the authoritative set is computed from the actual contributing sources).
- `sourceRefs` ← prior `sourceRefs` ∪ the assigned `SourceRef`s actually folded in.
- `lastUpdatedAt` ← batch wall-clock (stamped by the pipeline, not the LLM).
- `stableSlug`/`title` ← from route (new topics) or the existing page (updates); the LLM's echoed slug is validated to match, mismatch → keep the authoritative one + WARN.

### 7.4 Failure (fail-loud, per page)

If `stopReason === "max_tokens"` or `parseCompileResponse` yields zero topics → leave the existing page on disk untouched, do NOT add this page's sources toward their processed-eligibility, log an error. Other pages in the batch proceed. (A source routed only to this failed page stays unprocessed; a source also routed to a succeeded page is still held back until ALL its pages succeed — see §8.)

### 7.5 maxTokens

~64K (emits a full page), same as `COMPILE_MAX_TOKENS`.

## 8. Mark semantics (all-targets-succeed)

Per the one-to-many decision: track, per source ordinal, the set of topics it was routed to and whether each reconciled successfully. A source is added to `processed.json` (`addProcessed` + `saveProcessedSet`) **iff every** topic it targeted succeeded. This makes ingestion idempotent and lossless: a partial batch failure replays only the unfinished sources next time; succeeded pages are simply re-written identically when their other sources catch up.

## 9. Index update

- After each successful reconcile, upsert the topic's `TopicIndexEntry` (`stableSlug`, `title`, `summary` ← LLM-authored `---SUMMARY---` field added to reconcile output (one line), `relatedBranches`, `sourceRefs`, `lastUpdatedAt`). Persist via `TopicIndexStore`.
- Visible `_wiki/` render is **sub-project 3** (§3). `ingestPendingBatch` returns `touchedSlugs` so the trigger can render exactly the changed pages.

## 10. LLM integration points

- Add two templates to [`PromptTemplates.ts`](../../cli/src/core/PromptTemplates.ts): `route` and `reconcile`, each a module-level template constant + a `TEMPLATES` Map entry `["route", { action: "route", version: 1, template: ROUTE }]` (same pattern as `compile`/`merge`). This is the only in-repo change the **direct** `callLlm` path needs.
- **Cross-repo follow-up (NOT this sub-project):** the prompt-manager seed `V1_0Defaults.ts` lives in the separate `manager/` repo and is an intentional manual duplicate ("Manager must not import prompt sources from jollimemory"). It only affects the **proxy** LLM path. Mirroring `route`/`reconcile` there is a separate backend-repo task, tracked outside this CLI plan.
- Call via `callLlm({ action: "route" | "reconcile", params, model, maxTokens, apiKey, jolliApiKey })`, reusing `resolveModelId(config.model)`.

## 11. Components / files (indicative — finalize in plan)

| File | Responsibility |
|---|---|
| `cli/src/core/SourceContent.ts` | `loadSourceHeadline` + `loadSourceContent` per source type |
| `cli/src/core/IngestPipeline.ts` | `ingestPendingBatch`, `drainIngest`, mark-semantics bookkeeping |
| `cli/src/core/RoutePlan.ts` | route JSON parse + validation + ordinal→SourceRef mapping |
| `cli/src/core/PromptTemplates.ts` (modify) | add `route` + `reconcile` templates |
| `cli/src/core/KnowledgeCompiler.ts` (modify) | export `extractField` + `formatSummaryForCompile` for reuse (both currently private) |
| Reuse | `parseCompileResponse` (KnowledgeCompiler), `getSummary`, `loadPlansRegistry`, `listUserKnowledge`, `TopicPageStore`/`TopicIndexStore`/`ProcessedSourceStore` |

## 12. Testing (CLI floor: 97% stmt / 96% br / 97% fn / 97% line)

- `RoutePlan`: valid JSON → mapping; out-of-range index dropped+WARN; malformed JSON → error (not throw to caller); max_tokens → error; one source under multiple topics.
- `SourceContent`: each type's headline + body from a real fixture (project rule: real fixture per external/just-read type); vanished source → `null`.
- `IngestPipeline` (mock `callLlm`, `SourceContent`, stores): happy path marks all sources; reconcile failure on one page holds back its sources but not unrelated ones; a source spanning two pages with one page failing stays unprocessed; empty pending → no-op; `drainIngest` loops to empty and respects the iteration guard; recency ordering of source bodies into reconcile is old→new.
- Fail-loud: route max_tokens and reconcile max_tokens each leave state untouched + nothing marked.

## 13. Risks / explicit trade-offs

- **Two LLM calls per page-bearing batch minimum** (1 route + K reconcile). Accepted — it is the cost of topic-faithful synthesis; batch cap N bounds K.
- **JSON-in-text route is parse-fragile.** Mitigated by ordinal references (short, hard to mangle), shape validation, and fail-loud on truncation/parse error.
- **Render coupling — resolved by descoping.** Plan-time discovery showed the wiki renderer is tied to `MergedKnowledge` + `FolderStorage`'s private `generateWikiPages`, heavier than a thin adapter. Visible render moved to sub-project 3 (§3); sub-project 2 ships the canonical layer only.
- **`summary` field source.** Adding `---SUMMARY---` to reconcile output costs a little output but keeps the index summary LLM-authored and one-line; the alternative (deriving from page content mechanically) risks a poor routing signal. Chosen: LLM-authored.

# Topic KB — Sub-project 1: Data Model & Unified Timeline Iterator

**Date:** 2026-06-02
**Status:** Design approved; ready for implementation-plan.
**Parent:** [Topic-Centric Knowledge Base — Architecture & Decomposition](2026-06-02-topic-centric-knowledge-base-design.md)
**Scope:** data layer + one independently-testable iterator. **No LLM calls, no
ingest logic** (that is sub-project 2).

---

## 1. Purpose

Lay the foundation for the topic-centric KB: the on-disk schemas (source
reference, processed-ID set, topic index, topic-page store) and the pure function
that turns the heterogeneous source streams into a single deterministic,
time-ordered list of not-yet-ingested sources. Everything downstream (routing,
reconcile, replay) depends on this layer being correct.

## 2. Out of scope

- Any LLM call (routing, reconcile) — sub-project 2.
- Producing topic-page *content* — this sub-project defines the store and its
  read/write, but never fills a page.
- Wiring into `QueueWorker` / `MergeTrigger` / `jolli compile` — sub-project 3.
- Removing the existing branch-compile code — sub-project 5.

## 3. Data structures

### 3.1 `SourceRef`

```ts
type SourceType = "summary" | "plan" | "note" | "userfile";

interface SourceRef {
  type: SourceType;
  id: string;        // stable identity (see table)
  timestamp: string; // ISO 8601, used for chronological ordering
}
```

Per-type `id` / `timestamp` mapping:

| type | `id` | `timestamp` |
|---|---|---|
| `summary` | commit hash | `CommitSummary.commitDate` |
| `plan` | plan id | plan `updatedAt` (fallback `createdAt`) |
| `note` | note id / relative path | note timestamp |
| `userfile` | `path + "@" + fingerprint` | file mtime |

> **Implementation note — userfile mtime is promoted.** `MemoryBankScanner`'s
> `UserKnowledgeFile.mtime` is currently documented "debug-only, never used for
> cache logic." This sub-project promotes it to the chronological **ordering key**
> for user files. Update the field docstring accordingly; this is an intentional
> contract change, not an accidental dependency.

> **Implementation note — confirm plan/note timestamp fields against real schema
> during the plan phase.** The table above is the intended semantics; the exact
> field names on the plan/note types must be verified against `plans.json` /
> notes storage before coding (per the project rule: external/just-read data gets
> a real fixture, not a guessed shape).

### 3.2 Deterministic ordering

`listPendingSources` returns sources sorted by:

1. `timestamp` ascending (old → new), then
2. tie-break by `(type, id)` where `type` follows a fixed enum order
   (`summary < plan < note < userfile`) and `id` is compared lexicographically.

The tie-break guarantees identical output across machines and across replays for
the same input set — required by the parent spec's replayability principle.

### 3.3 Processed-ID set — `topics/processed.json`

The high-water mark, stored as the set of already-ingested source IDs (NOT a
timestamp). Proposed shape, grouped by type for compactness:

```jsonc
{
  "schemaVersion": 1,
  "processed": {
    "summary":  ["<commitHash>", ...],
    "plan":     ["<planId>", ...],
    "note":     ["<noteId>", ...],
    "userfile": ["<path@fingerprint>", ...]
  }
}
```

Membership test for a `SourceRef` is `processed[type].includes(id)` (backed by a
`Set` in memory). Compaction strategy is deferred (parent spec §7); the grouped
shape keeps it readable and bounded by source count.

### 3.4 Topic index — `topics/index.json`

```jsonc
{
  "schemaVersion": 1,
  "topics": [
    {
      "stableSlug": "auth-origin-allowlist",  // kebab, reuse KnowledgeCompiler slug rules
      "title": "Auth & origin allowlist",
      "summary": "One-line summary used for index-driven routing.",
      "relatedBranches": ["feature/x", "main"],
      "sourceRefs": [ { "type": "summary", "id": "<hash>", "timestamp": "..." } ],
      "lastUpdatedAt": "2026-06-02T..."
    }
  ]
}
```

`stableSlug` reuses the existing slug normalization rules from
`KnowledgeCompiler` (`normalizeSlug` / `slugifyTitle`) so slugs stay stable and
filename-safe. This sub-project defines the schema + read/write; it does not
populate `summary`/content (sub-project 2 does).

### 3.5 Topic-page store

- **Canonical:** `topics/<stableSlug>.json` — the structured page content recall
  and re-render read from. Minimal schema this sub-project commits to:
  ```jsonc
  { "schemaVersion": 1, "stableSlug": "...", "title": "...",
    "content": "", "relatedBranches": [], "sourceRefs": [],
    "lastUpdatedAt": "..." }
  ```
  Created/updated by sub-project 2; here we provide the schema + typed read/write
  + "list all topic pages."
- **Rendered:** `_wiki/<stableSlug>.md` — produced by the existing render layer
  (`WikiMarkdownBuilder` / `FolderStorage`). Not written by this sub-project.

## 4. The unified timeline iterator (the core deliverable)

A **pure** function — no side effects, no LLM, no mutation of stored state:

```ts
async function listPendingSources(
  storage: ReadStorage,          // resolves the four source streams
  processed: ProcessedSet,       // loaded topics/processed.json
): Promise<ReadonlyArray<SourceRef>>;
```

Behavior:

1. Enumerate all four source streams via the storage layer (summaries from the
   index, plans, notes, user files via `listUserKnowledge`).
2. Map each to a `SourceRef` (§3.1).
3. Filter out any ref already in `processed`.
4. Sort by the deterministic rule (§3.2).

It is a snapshot-in → list-out transform: given the same storage snapshot and the
same processed set, it always returns the same ordered list.

## 5. Storage ownership

`processed.json`, `index.json`, and every `topics/<slug>.json` are written through
the existing `StorageProvider` (dual-write: orphan system-of-record + Memory Bank
folder), matching how compiled/merged artifacts are persisted today. They are
**not** placed in the per-project `.jolli/jollimemory/` local dir — the KB is
shared, and local-only state would make each machine re-fold independently.

New storage paths live under a `topics/` prefix in the provider's namespace,
parallel to the existing `compiled/` and `compiled/merged/` prefixes.

## 6. Components / files (indicative — finalize in plan phase)

| File | Responsibility |
|---|---|
| `cli/src/core/TopicKBTypes.ts` | `SourceRef`, `SourceType`, `ProcessedSet`, topic index + page interfaces |
| `cli/src/core/ProcessedSourceStore.ts` | read/write `topics/processed.json`; membership + add |
| `cli/src/core/TopicIndexStore.ts` | read/write `topics/index.json` |
| `cli/src/core/TopicPageStore.ts` | read/write/list `topics/<slug>.json` |
| `cli/src/core/SourceTimeline.ts` | `listPendingSources` (the pure iterator) + `SourceRef` mappers |

(Reuse `KnowledgeCompiler` slug helpers, `MemoryBankScanner.listUserKnowledge`,
and `ReadStorageResolver` rather than re-implementing.)

## 7. Testing (CLI floor: 97% stmt / 96% br / 97% fn / 97% line)

`SourceTimeline` is the invariant-critical unit. Pin with tests:

- out-of-order input → strictly old→new output;
- equal timestamps → stable tie-break by `(type, id)`;
- refs present in `processed` are filtered out;
- empty sources / empty processed set;
- a `userfile` mtime drives its position (regression guard for the promoted field);
- mixed-type interleaving across all four streams sorts into one correct timeline.

Store modules: round-trip read/write, schemaVersion handling, missing-file →
empty default (not a throw), dual-write goes through the active provider.

Per-type `SourceRef` mappers: each maps id/timestamp from a real fixture of that
source type (not a guessed shape — project rule on external/just-read data).

## 8. Risks / explicit trade-offs

- **`processed.json` growth** — grows with total source count. Acceptable for now;
  compaction deferred (parent §7). Flagged, not silently capped.
- **Heterogeneous timestamp skew** — if a plan/note carries a wall-clock time from
  a different source than commit dates, ordering across types near the same instant
  relies on the `(type, id)` tie-break for determinism, not on cross-type clock
  accuracy. Documented so sub-project 2's recency reasoning treats near-ties as
  unordered-but-deterministic.

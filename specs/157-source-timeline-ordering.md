# 157. Source Timeline Ordering

## Topic Statement

Enumerate every not-yet-ingested development source across the four heterogeneous source streams into a single deterministic old-to-new ordered list keyed off a stable identity-set high-water mark.

## Scope

**In scope:**
- The four source streams folded into the timeline: root-only commit summaries, plan entries, note entries, user-authored knowledge files.
- The abstract shape of a single ingestable source reference (type, identity, timestamp, optional originating branch).
- The per-stream enumeration of every known source as references, including the conditional split between "folder layout" and "orphan-only legacy" paths for plans and notes.
- The root-only filter that excludes non-root commit summaries from the timeline.
- The disk-driven enumeration of user-authored knowledge files (independent of the summary index's branch list) and the deduplication of duplicates by `path@fingerprint`.
- The total order across the merged stream: epoch-ascending, then type-rank tie-break, then identifier lexical tie-break.
- The handling of unparseable timestamps in the total order.
- The processed-set filter applied to produce the pending list (already-ingested identifiers excluded).
- The persisted processed-set shape, its read-side tolerance to corruption and partial buckets, its membership test, and its idempotent append-only semantics.
- The read-side storage threading: which streams resolve through the provided storage snapshot and which always resolve from process-local state.

**Out of scope (boundaries):**
- The ingest pipeline that consumes this timeline, batches it, classifies each batch to topics, and reconciles topic pages (spec 152).
- The persisted topic page collection and routing index (spec 156).
- The summary index format and the orphan-branch summary tree (specs 04, 05).
- The plan archival semantics on commit that produce plan entries upstream (spec 42).
- The note archival semantics on commit that produce note entries upstream (spec 43).
- The memory-bank folder layout and manifest format that backs folder-mode plan/note enumeration.
- The user-knowledge file scanner that walks the memory-bank folders, computes per-file fingerprints, and assigns scope/branch.
- The session-tracker registry that backs orphan-mode plan/note enumeration.
- The active write storage and dual-write fan-out the processed-set persistence rides on.
- The credential resolution, prompt construction, and model calls performed downstream of the timeline.

## Data Contracts

### Source reference

A source reference identifies one ingestable development source. It carries:
- **Type** — exactly one of: a commit summary, a plan, a note, or a user-authored knowledge file.
- **Identity** — a string that is stable and unique within its type:
  - For a commit summary, the commit hash.
  - For a plan, the plan slug.
  - For a note, the note identifier.
  - For a user-authored knowledge file, the composite `<relative-path>@<content-fingerprint>`. The path is relative to the memory-bank root and the fingerprint is a content hash. The composite shape lets a file whose content changes resurface as a different identity in the next enumeration.
- **Timestamp** — an ISO-8601 instant, which may carry a timezone offset other than UTC. Used for chronological ordering.
- **Branch** — optional, present for branch-scoped streams (summary, plan, note) when the upstream record carries it; absent for user-authored knowledge files (which are repo-wide or global, not branch-scoped); also absent for plan/note references coming from a legacy orphan-only path because that registry's per-entry branch field was dropped in a migration.

### Source streams (enumeration inputs)

The timeline reads from four upstream surfaces:

1. **Commit summary index** — the persisted index of commit summaries, accessed through the read-side storage snapshot. Each entry carries at least a commit hash, a commit date, an originating branch, and a parent commit hash. The timeline includes only entries whose parent commit hash is absent (null or undefined) — the "root commit" filter described below.
2. **Plan/note source** — read through one of two paths chosen by the read-side storage:
   - **Folder layout (or dual-write):** read from a hidden manifest under the memory-bank root that lists every plan and note with its identity, title, originating branch, and last-updated timestamp.
   - **Orphan-only legacy:** read from a per-project plans-and-notes registry under the project's memory directory.
3. **User-authored knowledge file scanner** — invoked once per timeline call, returns a flat list of every user-authored knowledge file present on disk regardless of which branch folder it lives under. Each file carries a relative path, a content fingerprint, a modification time, a scope (repo/global/branch), and (for branch-scoped files) the originating branch.

### Processed-source set

The high-water mark is a versioned record of identifiers already folded into the knowledge base:
- A schema version (1).
- A bag of four buckets, one per source type, each holding a list of identifiers.

This shape is deliberately a **set of identifiers**, not a single timestamp watermark, so that a source surfacing out of chronological order (a late sync, an amended older commit, a backdated plan) is never silently skipped on the basis of a watermark it cannot cross.

On read:
- Missing file → an empty set with all four buckets present and empty.
- Unparseable JSON → an empty set (logged warning, never throws).
- Valid JSON missing the four-bucket map → all four buckets default to empty.
- Valid JSON with a partial bucket map → present buckets keep their values, missing buckets default to empty lists.

Membership: a reference is processed when its identifier appears in the bucket matching its type. The same identifier in a different type's bucket is not a match.

Append: returns a new set (the input is not mutated). Adding a reference whose identifier is already in its bucket is a no-op. Returns the four buckets fully copied, with the new identifiers appended in iteration order.

Persistence: written as pretty-printed JSON (tab-indented) through the active write storage to the same canonical processed-source path. The write description carries an "update topic KB processed-source set" tag for the dual-write commit log.

### Type rank (tie-break ordinal)

A fixed ordinal per source type, used only for tie-breaking when two references share an epoch:
- summary → 0
- plan → 1
- note → 2
- user-knowledge file → 3

This ordering is deterministic and is not interpreted as a precedence beyond breaking ties.

## Behavior

### Single-pass enumeration

The timeline produces references in a single pass over all four streams. It does not stream; it returns the full ordered list at once. Each call re-enumerates every stream — there is no incremental enumeration.

The pass:

1. Resolves a **read-side storage snapshot**. The caller may inject one; otherwise one is created from the working directory. This snapshot scopes the summary-index read only; plan/note and user-knowledge file streams resolve independently.
2. Determines whether the snapshot is the folder-layout variant. If so, the memory-bank root is extracted from it and used to drive folder-mode reads for plans/notes and the user-knowledge scan. If not (orphan-only snapshot), plans/notes come from the registry path and the user-knowledge scan goes through the working-directory-based entry point.
3. Reads the **commit summary index** through the snapshot. For each entry, if and only if its parent commit hash is absent (either explicitly `null` or the field is omitted entirely), a reference is emitted with type `summary`, identity = the commit hash, timestamp = the commit date, branch = the entry's originating branch.
   - Non-root entries (parent commit hash present) are silently skipped — these are child summaries within a tree whose root summary already represents the commit content for ingest purposes.
   - When the summary index is missing entirely (read returns null), no summary references are emitted but enumeration continues for the other streams.
4. Reads the **plan/note stream** via one of two paths:
   - **Folder/dual-write path** (read-side storage is the folder variant): every plan or note entry from the folder manifest emits a reference carrying its identity, the manifest's timestamp, and the originating branch (either from the manifest entry or derived from the visible path's first segment).
   - **Orphan-only legacy path** (read-side storage is not the folder variant): plan entries from the registry emit plan references with identity = plan slug and timestamp = last-updated; note entries from the registry emit note references with identity = note id and timestamp = last-updated. Neither carries a branch — the registry's per-entry branch field was deliberately removed in a migration. The optional `notes` key on the registry is treated as empty when absent.
5. Reads the **user-authored knowledge files** in a single disk-driven scan. The scan returns every file under the memory-bank root regardless of which branch folder it lives in. In folder mode the memory-bank root is taken from the read-side storage; in orphan-only mode the scan is invoked with the working directory and resolves the root itself.
   - Each file emits a reference with type `user-knowledge file`, identity = `<relative path>@<fingerprint>`, timestamp = the file's modification time. No branch is carried.
   - Duplicates emitted by the scanner (same `path@fingerprint`) are deduplicated by tracking seen identifiers; only the first occurrence is kept.
   - The disk-driven scan deliberately does not depend on the summary index's branch list. An earlier, since-removed index-driven enumeration skipped branch folders that had user notes but no summary yet; the disk-driven scan covers those branches even with an empty summary index.
6. Returns the concatenated list of all emitted references, unsorted.

### Total order

References are compared pairwise to produce the deterministic old-to-new order. The comparison applies four tiers in sequence:

1. **Epoch comparison.** Both timestamps are parsed to epoch instants. Parsing is done numerically — timestamps are not compared as strings, so timezone offsets are honoured (a wall-clock `08:00+09:00` resolves earlier in epoch than a `00:00Z` despite a later wall-clock string).
2. **NaN handling.** If exactly one timestamp parses to a finite epoch and the other does not, the unparseable one sorts **after** the valid one (unparseable timestamps are last). If both fail to parse, the comparison falls through to the next tier.
3. **Type rank.** When epochs are equal (or both unparseable), the type with the lower type rank sorts first: summary, then plan, then note, then user-knowledge file.
4. **Identity lexical.** When epochs and types are equal, identities are compared lexicographically (JavaScript string `<` / `>`).

The resulting order is total: any two distinct references have a defined relative order.

### Pending filter

To produce the **pending** list, the full enumerated reference list is filtered by the processed-source set: a reference is kept when its identifier is **not** in the bucket matching its type. The filter is applied first, then the surviving references are sorted by the total order. The output is a read-only array in old-to-new order.

This filter ordering — collect every stream first, then filter, then sort — is intentional: the comparator must run only on references that the consumer will actually receive, and the processed-set test by `(type, identity)` is the only authoritative test for "already ingested".

### Failure tolerance per stream

The timeline call is best-effort per stream in the following narrow senses:
- A missing summary index (read returns null) is treated as zero summary references and enumeration of the other streams continues unaffected.
- A registry with no `notes` key (orphan-only legacy mode) is treated as zero note references.
- A summary index entry with an absent (omitted) parent commit hash field is treated identically to one with an explicit null — both qualify as root.

The timeline does not otherwise wrap stream reads in catches; an exception thrown by an upstream loader (e.g. a manifest read error, a disk scan error) propagates out of the timeline call to the caller.

### Streaming vs eager enumeration

Enumeration is **eager**: the entire merged list is built in memory, filtered, then sorted. There is no incremental streaming interface and no checkpoint mid-enumeration. The eager design matches the consumer (the ingest pipeline) which slices a batch off the front of the sorted pending list per drain iteration.

### Determinism guarantee

For a given disk snapshot plus a given processed-source set, the function returns the same ordered pending list across calls. The only non-determinism would come from upstream loaders (e.g. a concurrent disk write between two reads inside the same call) — those races are out of scope here and visible to the caller as "the pending list reflects whatever was on disk at the moment each stream was read".

## State Transitions

### Per source reference

```
NEW           ─(emitted by an enumerator and not in processed set)──> PENDING (returned to caller)
NEW           ─(emitted by an enumerator and in processed set)─────> PROCESSED (filtered out, not returned)
PENDING       ─(consumer ingests successfully, adds identity to set)> PROCESSED (next call: filtered out)
PENDING       ─(consumer holds for retry, set unchanged)──────────> PENDING (next call: emitted again)
PROCESSED     ─(disk source vanishes from enumerator)──────────────> still PROCESSED in set; absent from list
USER-KNOWLEDGE-FILE PROCESSED with old fingerprint
              ─(file content changes)─> resurfaces as NEW under a new `path@fingerprint` identity;
                                        the old `path@fingerprint` stays in the processed set but is gone
                                        from the scan, so it harmlessly never re-emerges.
```

The "still in set, absent from list" case is intentional: the set is append-only across calls (the timeline itself never removes identifiers from it), and a vanished source need not be re-marked.

### Per processed-set call

```
empty set on disk         ─(read)──> empty set in memory (all four buckets present)
missing file              ─(read)──> empty set in memory
corrupt JSON              ─(read)──> empty set in memory (warning logged)
partial buckets on disk   ─(read)──> all four buckets present in memory (missing default to empty)
in-memory set + refs      ─(append)─> new in-memory set with refs added (idempotent per bucket)
in-memory set             ─(save)──> JSON on disk via active storage (tab-indented)
```

## Notable Behavior

- **Root-only summary inclusion.** Only commit summary entries whose parent commit hash is absent are emitted as references. The parent-commit-hash check accepts both an explicit `null` and an omitted field — both qualify a summary as root.
- **Epoch comparison, not string comparison.** ISO-8601 timestamps are parsed to instants before being compared, so a `+09:00` timestamp with a later wall-clock string can sort earlier than a `Z` timestamp with an earlier wall-clock string.
- **Unparseable timestamps sort last, deterministically.** Two unparseable timestamps fall through to the type/identity tie-break rather than producing undefined order.
- **Fixed type-rank tie-break ordinal.** The (summary, plan, note, user-knowledge file) ordering is the tie-break order — it is not a precedence rule beyond breaking ties.
- **Identity sort is byte-wise lexical, not numeric.** Two summary identities that look like hex commit hashes are still compared byte-by-byte (so `b` < `c`, no big-endian/numerical interpretation).
- **High-water mark is a set of identifiers, not a timestamp.** A source surfacing late in chronological order (a backdated plan, an amended older commit) is never silently skipped because of a watermark it cannot cross.
- **Bucket membership is by exact `(type, identity)`.** The same identifier under a different type's bucket does not match. This is the canonical answer to "has this source been processed".
- **Append is immutable and idempotent.** The input set is not mutated; appending a reference whose identifier is already in its bucket is a no-op. The caller can use the same in-memory set across multiple `addProcessed` calls without copy management.
- **Persisted file is human-readable.** The processed-source file is JSON, tab-indented; it stays an array on disk for readability even if an in-memory `Set` is later used for membership.
- **Folder-mode vs orphan-only branch on plan/note enumeration.** In folder mode the plan/note source emits a branch (either from the manifest entry or derived from the visible path's first folder segment). In orphan-only mode plan and note references carry no branch — the registry's per-entry branch field was deliberately stripped in a migration, and the timeline does not synthesise one. The folder-mode path remains branch-aware.
- **User-knowledge files have no branch on the reference even when scoped to one.** Per spec, branch is omitted for user-knowledge file references — the topic page derives related branches from the contributing branch-scoped sources only.
- **Disk-driven user-knowledge enumeration is independent of the summary index.** A branch folder containing only user notes (no summaries yet) is still surfaced. This is a deliberate fix for a previous index-driven enumeration that silently dropped such branches.
- **One scan per timeline call.** The user-knowledge scanner is invoked exactly once per timeline call, regardless of how many branches the project has. Earlier per-branch scanning is gone; the per-call `path@fingerprint` dedupe set guards against a rare same-file-twice case from the scanner itself.
- **Read-side storage scopes the summary index read only.** Plan and note enumeration in orphan-only mode always goes through the working-directory-based registry loader, never through the injected storage. User-knowledge file enumeration goes through the memory-bank-root entry point in folder mode and the working-directory entry point otherwise — also never through the injected storage. Callers that need to control plans, notes, or user files must mock those loaders directly; injecting a custom storage will not redirect those streams.
- **Stream errors propagate, they are not absorbed.** Only a missing summary index and a missing `notes` key are normalised away. Any other upstream throw (manifest read error, disk error inside the user-knowledge scan, etc.) propagates out to the caller.
- **Eager, not streaming.** The timeline call returns the complete ordered pending list in memory; the consumer slices a batch off the front. There is no checkpoint mid-enumeration and no incremental API.
- **Re-enumeration per call.** Each call re-reads every stream from the chosen surfaces. There is no in-memory cache across calls (a process-wide manifest mtime memo exists at the folder-plan/note source layer as an optimisation; semantically each call sees the freshest disk state).
- **Pending count for the iteration guard is the **first batch's** pending count.** The consumer caps drain iterations at `ceil(first-batch pending / batch size) + 2`; the timeline itself does not impose any count cap.

## Shared Behavior

- **Commit summary index format and root vs child entries.** Specs 04 and 05 describe the canonical summary tree structure and index entry shape (including the `parentCommitHash` field this timeline filters on). The timeline is a read-only consumer; it neither writes nor mutates the index.
- **Plan entry origin.** Plan entries reach the registry / manifest through the plan archival on commit flow (spec 42). The timeline consumes whatever entries that flow has produced.
- **Note entry origin.** Note entries reach the registry / manifest through the note archival on commit flow (spec 43). The timeline consumes whatever entries that flow has produced.
- **Ingest pipeline consumption.** The ingest pipeline (spec 152) calls into this timeline once per batch: it reads the pending list, slices the first N (default 50) for the route prompt, then loads headlines and bodies for those N references through their per-source loaders. The processed-source set is updated only after a successful reconcile + write; held sources surface again in the next call.
- **Topic page accumulation.** Successfully reconciled topic pages accumulate the contributing source references in their on-disk record. The processed-source set and the topic-page reference lists are independent: a source can be in a topic page's reference list and in the processed-source set, but the topic page is not the authority for "has this source been processed".
- **Storage provider abstraction.** The read-side storage snapshot scopes the summary-index read. Writes of the processed-source set go through the active write storage (which fans out to both layers of a dual-write provider). The two storages are deliberately distinct so reads see one consistent view while writes always reach both layers.

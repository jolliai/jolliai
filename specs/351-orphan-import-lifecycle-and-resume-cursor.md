# 351. Orphan Import Lifecycle and Resume Cursor

## Topic Statement

The single stored record that says where a repository's memory migration — from the parallel git ref into the local database — currently stands: its lifecycle state, the ordering fingerprint and mode-pinned position that let a killed run resume, and the three-state liveness verdict a reporting surface derives from it.

## Scope

**In scope:**

- Where the record lives, why it shares a key that predates the lifecycle fields, and why it is a database row rather than a file.
- The record's fields, including the rows written before the lifecycle fields existed and the unknown keys a record may carry.
- The cursor: the ordering it fingerprints, the mode it is pinned to, the position and written-count it carries, and the non-idempotent step it flags.
- The four moments the record is written — entry, per batch, failure, completion — and what each write keeps and drops.
- Resume legality, what a resume restores, and what it deliberately does not cover.
- What makes a re-run idempotent when no cursor survives.
- The read path used by a reporting surface, its three answers, and the conditions producing each.
- The rendered line for every state, and the three-state liveness rule behind the running one.

**Boundaries (consumed here, owned elsewhere):**

- The import itself — which row families it writes, the two write modes, the ordering it derives from the memory index and the file listing, the batching that groups whole trees — is owned by the memory source-of-truth topics. This spec covers only the record those steps write and read.
- The decision of *which* mode an import runs in, and the protection floor it carries, are defined by the **Dashboard Database Repository Backfill** topic (cross-ref 350).
- Resolving a working directory to a repository identity, and the repository row the record hangs off, are defined by the **Dashboard Repo Registry and Probe** topic (cross-ref 355).
- The freeze marker and the recorded switch that make a frozen source possible at all are defined by the **Orphan Branch Cutover Fence and Compare-and-Swap** topic (cross-ref 345).
- The database file's own health classification (present, present-with-sidecars, sidecars-only, absent) and the schema version stamp are owned by the store-and-schema topics; this spec states only which classification produces which answer.
- The rest of the status surface this record contributes one line to is owned by the status-command topic.

## Data Contracts

### Where the record lives

One row in `repo_state` per repository, key **`orphan-import`**, value a JSON object. Each property of that placement is a decision:

- **The key is reused, not new.** It already exists on disk in every database that has ever imported, where it was a completion receipt written once at the end of a successful run. Renaming it would orphan those rows — every reader would report a fully-migrated repository as never migrated — and a value row has no migration path.
- **It is a row, not a file.** The cursor is only meaningful if it advances in the *same transaction* as the rows it certifies, which a file cannot do; and the claim being recorded is a claim about the database, so a second witness elsewhere could only ever disagree with it.
- **It is not a schema change.** The table is (repository, key, value) with no constraint on the key, so adding this marker is an insert and the schema version does not move.

The stored vocabulary says "import" because the key does; the user-facing vocabulary is "migration". The divergence is deliberate — "migration" internally already names the unrelated Memory Bank folder migration.

### The record

| Field | Meaning |
| --- | --- |
| `state` | `running`, `done`, or `failed`. **Absent means `done`** — a row written before the lifecycle fields existed was only ever written on success. |
| `startedAt` | when the current run began |
| `heartbeatAt` | when the run last committed something |
| `pid` | the process id of the run |
| `done` | progress; **its meaning differs by state** — see below |
| `total` | the ordering's length; absent when no ordering could be derived |
| `cursor` | the resume position; present only while a run is unfinished |
| `error` | `failed` only |
| `at`, and every per-family row count, plus a per-kind breakdown of skipped artifacts | `done` only — the historical completion receipt, preserved verbatim |

The record also tolerates and preserves keys it does not know: the failure write spreads whatever was there before.

**`done` means two different things.** In a `running` record it is the **position in the ordering**, which counts entries that were skipped for an unparsable body and so never became rows. In the completion receipt it is the **number of memories actually written**. A reader comparing a mid-run `done` with a final one is comparing two different quantities.

### The cursor

| Field | Meaning |
| --- | --- |
| `fingerprint` | a hash over the ordered list of memory hashes, newline-joined. Order-sensitive, because the position indexes into it |
| `mode` | the write mode that produced this cursor. Optional — a cursor written before the field existed has none, and "unknown" never matches |
| `nextIndex` | the position to resume from; counts skipped entries too |
| `nodes` | memories actually **written** so far — deliberately not the position |
| `phase1Done` | reconciling mode only: whether the whole-repository position shift has already run |

The fingerprint is over the **ordering**, not over the source ref's tip. A tip moves for reasons that do not touch the memory set at all — a plan edit, a note — and invalidating the cursor for those would make a long import on an active repository unable to ever finish.

The mode pin cannot be folded into the fingerprint, because the ordering is identical in both modes. It exists because a cursor from a non-reconciling run, resumed by a later reconciling one, skipped the already-imported prefix: the reconciling mode's position shift moved those rows into the offset region, the settle pass never re-grounded them, and the residue cleanup then cleared their parent edges — turning every amend chain in the prefix into independent root memories.

The phase flag exists because that shift is **not idempotent** — a second application reaches twice the offset and trips the schema's ceiling check. It is written in the same transaction as the shift itself, which is what keeps the flag and the rows in agreement.

### Staleness threshold

**10 minutes** without a heartbeat before a reader stops calling a running record fresh. On its own this is **not** a liveness verdict — see the three-state rule below.

## Behavior

### Write 1 — entry

Written as early as it can be: after the repository row exists (the foreign key needs it) and before the first read of the source, because everything after that point is slow.

- `state: running`, `startedAt` and `pid` **restamped unconditionally** — inheriting a crashed run's dead process id would make this live process report itself as interrupted.
- Any cursor already stored is **carried forward untouched**; whether it still applies is decided later.
- `done: 0`, and no `total`. Every receipt field from a previous completion is dropped.

### Deriving the ordering

The ordering and its length come from the memory index plus the file listing, before a single memory body is read — that is what makes a denominator and a cursor possible at all, since the bodies are the longest part of the run. A repository whose index is unreadable has **no ordering, no fingerprint, no denominator and no cursor**: it falls back to reading everything in one pass, exactly as the import behaved before cursors existed.

### The resume decision

A stored cursor is usable only when **all** of these hold: an ordering was derived this run, a cursor exists, its fingerprint equals this run's, and its mode equals this run's mode. Anything else discards it and the run starts from the beginning — always safe, because every write in the loop is an upsert.

When it is usable:

- The position and the phase flag are adopted.
- The written-memory count is seeded from the cursor's own `nodes`, **not** from the position: memories an earlier run committed are still memories this source contributed, and the position counts entries that never became rows, so inheriting it would overstate what was stored.
- Every transcript already linked in the database is marked claimed, so the end-of-run sweep for unreferenced transcripts does not re-read and re-write the whole transcript tree on every resume.

### Write 2 — per batch

Each batch commits **the rows and the cursor in one transaction** — that is the entire guarantee. The heartbeat rides along rather than paying for a transaction of its own. Each write carries `state: running`, the unchanged `startedAt`, a **live** heartbeat stamp, the process id, the current position, the total when one exists, and the cursor when a fingerprint exists.

The heartbeat is stamped from a live clock even though every *stored data* timestamp in the run uses one frozen entry-time value. Stamping it with the frozen value meant it never advanced, so a run longer than the staleness threshold reported itself as abandoned while healthy.

Batches whose end lies at or before the resumed position are skipped outright; batch boundaries are a pure function of the fingerprinted ordering, so a cursor always lands exactly on one.

In reconciling mode the position shift runs first, if the phase flag says it has not, and stamps the cursor with the flag set inside the same transaction.

### What the cursor does not cover

Only the memory batch loop and the shift flag. Everything after the loop re-runs in full on every pass, resumed or not: the sweep of transcripts no memory claimed, the commit-alias rows, the document families and their progress rows, the topic pages and processed-source rows, the mode-specific cleanup of the offset region, the re-mount of the tree, and — in reconciling mode — the whole set reconciliation. Idempotence there rests entirely on those writes being keyed on business identity, not on the cursor.

The commit-alias pass carries one obligation beyond its own rows: it also **invalidates the cached rollup days** its aliases touch, and it does that **outside** the chunked transactions the aliases are written in — unlike the live write path, which invalidates inside the single transaction that writes the row. Neither the idempotence of the alias upsert nor the resume story changes: the alias rows are still keyed on business identity, and the precondition that each alias target exists is still asked *of the database* rather than assumed from what this run happens to have written.

Those tail steps also **never stamp a heartbeat**, so a long tail is indistinguishable from a stalled run to a concurrent reader.

### Write 3 — failure

Any throw out of the import is recorded before it propagates: the previous record is read, and `state: failed` plus the message are written over it. Recorded *here* rather than by the caller's per-repository error handler because by the time the error reaches that handler the database connection is closed — this is the last place a failure can still be written down. The error is rethrown unchanged; this marks, it does not swallow.

Every step is guarded and a failure to record is logged at debug and dropped: the reason this is running at all is that something already went wrong, and a database that is gone or locked must not turn a useful error into a confusing one.

Because the write **spreads the prior record**, the cursor survives — so the next run resumes from the last committed batch. It also means a failure that happens *before* the entry write leaves the previous completion receipt's fields (its stamp, its row counts) in place under a `failed` state.

A record with no repository row is not written at all.

### Write 4 — completion

Written after every tail step, as a single object:

- Every historical receipt field verbatim — the run's stamp, the per-family row counts, the per-kind skip breakdown — so readers predating the lifecycle fields keep working.
- `state: done`, the run's `startedAt`, a live heartbeat, the process id, `done` set to the **memories written**, and `total` when an ordering existed.
- **The cursor is removed** — the run finished, so there is nothing to resume from, and a leftover cursor would make the next run skip the whole repository.

### The read path

A read-only, degradation-safe lookup used by a reporting surface. It answers with exactly one of three kinds, keeping "no record" and "cannot ask" distinct — collapsing them would report an unreadable database as a repository that has never migrated, which reads as data loss.

| Condition, in order | Answer |
| --- | --- |
| the runtime has no flag-free built-in SQLite | **unavailable**, reason names the runtime version |
| the database file is missing but its write-ahead sidecars remain | **unavailable**, reason points at the recovery command |
| the database file is absent entirely | **none** |
| the stored schema version is newer than this build's | **unavailable**, reason names both versions |
| no repository row for this working directory's identity | **none** |
| no row at this key | **none** |
| a row exists | **record** |
| anything threw, including an unparsable stored value | **unavailable**, reason is the error message |

A missing database file is answered **none** ("never migrated") rather than "cannot ask": the answer is certain and it is the one the user can act on.

The same value read on an already-open handle — the path the import itself uses — behaves differently in one case: an **unparsable** value reads as *no record*, not as an error, so a corrupt value costs a resume rather than failing the run.

### The rendered line

| State | Rendered |
| --- | --- |
| unavailable | "Unavailable (`<reason>`)" |
| none | "Not migrated — run `jolli dashboard`" |
| done | "Migrated (`<n>` memories, `<when>`)" — the count is the receipt's written-memory figure, defaulting to 0; the relative time is omitted when the receipt has no stamp |
| failed | "Failed at `<progress>` — `<error>` (run `jolli dashboard` to retry)" |
| running, process gone | "Interrupted at `<progress>` — run `jolli dashboard` to resume" |
| running, process alive, heartbeat stale | "Migrating — `<progress>` memories, no progress for `<age>` (pid `<n>`)" |
| running, process alive, heartbeat fresh | "Migrating — `<progress>` memories (pid `<n>`)" |

`<progress>` is `done/total` when a total exists and `done` alone otherwise. Relative times are coarse on purpose: under a minute is "just now", then whole minutes up to an hour, then whole hours up to two days, then whole days.

### The three-state liveness rule

The middle state is the whole point.

1. **No live process with that id** → **interrupted**, regardless of how fresh the heartbeat is.
2. **Live process, heartbeat older than the threshold** → still **migrating**, annotated with how long it has been quiet.
3. **Live process, fresh heartbeat** → **migrating**.

Requiring both a live process and a fresh heartbeat would call a healthy long-running import dead: the run reads thousands of git objects, and the fallback for a missing index reads them in one uninstrumented span, so a quiet stretch is normal. Only a dead process is evidence of interruption. The threshold's other job is bounding how far a recycled process id can mislead the verdict.

## State Transitions

| From | Event | To |
| --- | --- | --- |
| *(no row)* | import begins | `running`, `done: 0`, no cursor |
| receipt without a `state` field | read | treated as `done` |
| `done` (cursor already removed) | import begins | `running`, receipt fields dropped, no cursor to carry |
| `failed` (cursor preserved) | import begins | `running`, cursor carried forward |
| `running` | reconciling mode's shift commits | cursor gains its phase flag |
| `running` | a batch commits | `running`, position and written-count advanced, heartbeat refreshed, cursor rewritten |
| `running` | the run throws | `failed`, message set, **cursor preserved** |
| `running` | every step completes | `done`, full receipt, **cursor removed** |
| any | fingerprint or mode differs on the next run | cursor ignored; the run restarts from the beginning |

## Notable Behavior

- **The entry write reports `done: 0` even when resuming.** The resumed position is only reflected once the first batch (or the reconciling shift) commits, so a status read taken in between shows no progress at all on a run that is most of the way through. (Notable.)
- **The heartbeat only advances on batch commits.** Every step after the batch loop — the unclaimed-transcript sweep, aliases, documents, topic pages, the re-mount, the reconciliation — runs without touching it, so a repository with a long tail renders as "migrating, no progress for *N*m" while perfectly healthy. The three-state rule is what keeps that from reading as "interrupted". (Notable.)
- **`done` changes meaning between the running record and the receipt** — position in the ordering versus memories written. They differ by exactly the entries skipped for an unparsable body. (Surprising.)
- **An unparsable stored value is answered two different ways.** The read-only reporting path treats it as "cannot ask"; the in-process path the import uses treats it as "no record", which merely costs a resume. Both are deliberate: the first must not advise a re-run that is not needed, the second must not fail a run over a value it is about to overwrite. (Surprising.)
- **A record with no `state` field is read as `done`.** Those rows predate the lifecycle fields and were only ever written on success; reading them as anything else would tell a fully-migrated repository to migrate again. (Notable.)
- **A cursor whose mode field is absent never matches**, so every cursor written before that field existed is discarded and its run starts over. Always safe, because every write in the loop is an upsert. (Notable.)
- **A failure that happens before the entry write leaves the previous completion receipt's fields in place under a `failed` state**, because the failure write spreads whatever was stored. The reported progress there is the old run's, not this one's. (Surprising.)
- **The completion write deletes the cursor, and that is load-bearing.** A cursor left behind on a finished run would make the next run believe the whole repository was already done. (Notable.)
- **A repository whose memory index is unreadable gets no cursor at all** — no fingerprint, no denominator, no resumability — and falls back to a single all-at-once pass. Its rendered progress is a bare count with no total. (Notable.)
- **A missing database file reports "never migrated" rather than "cannot ask"**, which is the opposite of how the same file state is treated when asking whether a repository has switched over. Two different questions with two different costs of being wrong. (Notable.)
- **The database file's presence is checked before any handle is opened**, so the reporting path never creates a schema as a side effect of asking a read-only question. (Notable.)

## Shared Behavior

- The import's row families, its two write modes, its ordering derivation and its tree batching are owned by the memory source-of-truth topics.
- The mode this run uses, and the protection floor that accompanies a frozen source, are decided by the **Dashboard Database Repository Backfill** topic (cross-ref 350).
- Repository identity resolution and the repository row this record hangs off are defined by the **Dashboard Repo Registry and Probe** topic (cross-ref 355).
- The freeze marker and recorded switch that make a frozen source possible are defined by the **Orphan Branch Cutover Fence and Compare-and-Swap** topic (cross-ref 345).
- The process-liveness probe behind the interrupted verdict is defined by the lock-primitive topic.
- The database file classification and schema version stamp are owned by the store-and-schema topics, as is the per-day rollup cache the commit-alias pass invalidates and the rule that a delete, re-ground or re-alias must name the days it invalidated.

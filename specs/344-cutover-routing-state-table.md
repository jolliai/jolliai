# 344. Cutover Routing State Table

## Topic Statement

Decide which of four routing states a repository is in from two independent witnesses — a per-clone freeze marker in the repository profile, plus a per-identity row in the machine-global memory database — so that the state, never a configuration value, chooses the storage backend behind every write as well as every read.

## Scope

**In scope:**

- The two witnesses, what each one is, and the precedence between them.
- The three answers the database witness can give, and the closed set of conditions that produce the "cannot ask" answer.
- The complete state table: every combination of witness answers and the state it produces, including the two combinations that produce the same state for opposite reasons.
- What each state yields on the **write** side (storage construction) and, separately, on the **read** side.
- The retired configuration key: where it is still read, where it is ignored, and what it still decides.
- The quiet boolean second-witness probe used by the ref-backed write path, and how its failure policy differs from the full routing decision.
- The shared classifier this module exports for "has the system of record moved off the freezable ref-backed branch": which of the four states it answers true for, and why it is stated once here rather than as a state set each long-lived host restates for itself.
- The per-process memo of repository identity that the routing decision keeps, and what it does *not* memo.
- Every consumer that branches on the state rather than on a backend, and what each does in the `blocked` state.

**Out of scope (boundaries):**

- What the freeze marker *means*, what it freezes, and the locked swap that creates it — covered by **Orphan Branch Cutover Fence and Compare-and-Swap** (345). This spec states only that its presence is one of the two witnesses.
- The distinction between resolving the *system of record* and resolving *read* storage, and the short-lived route memo one of them keeps — covered by **System-of-Record versus Read Storage Resolution** (346).
- The scaffolding around the two long-lived hosts' lazy re-probe of this state — the back-off window, the coalescing of a burst of concurrent probes, the one-way latch once a repository is seen switched, and each host's own rebuild step — belongs to the shared heal gate, a neighbouring topic. This spec states only that those hosts probe the state, what the classifier answers them, and what happens on the states it answers false for.
- The schema, migrations, and general contents of the machine-global memory database; only the one state row this decision reads is described here.
- How a repository acquires the identity the database row is keyed by.
- The internals of any backend the state selects (the ref-backed backend, the folder mirror, the database-backed backend, the dual-write composite).
- The Memory Bank write boundary that additionally gates the folder side of every writable state (spec 300).
- The durable repo-wide manual-disable opt-out, which is a separate axis and stops everything regardless of state (spec 145).

## Data Contracts

### Witness 1 — the freeze marker (per clone)

An optional record inside the per-repository profile document, which is anchored to the main working-tree root and therefore shared by every linked worktree of that clone. It carries a reason string, an ISO timestamp, and an optional map of frozen ref tips keyed by source root. Only its **presence** matters to this decision.

It is **per clone**: a second checkout of the same remote that the swap never enumerated, or a clone made after the swap, carries no marker at all. A profile document that is missing, unparseable, or not a JSON object reads as empty, so a wiped profile presents as "no marker".

### Witness 2 — the state row (per identity)

A row in the machine-global memory database (`jollimemory.db`, in the per-user state directory), located by first resolving the repository's **identity** — the canonical remote, or a hash of the main working-tree root when there is no usable remote — to a registered repository, then reading that repository's state entry under the key `cutover`.

Its value is a record carrying:

| Field | Meaning |
| --- | --- |
| tips | The frozen ref tip pinned at swap time, per source root. |
| cutoverVersion | Monotonic counter, incremented on each recorded swap for this identity. |
| committedAt | ISO timestamp of the swap. |
| schemaVersion | Integer, currently 1. |

Because the row is keyed by the **shared** identity, every clone of the same remote sees it — including one that carries no freeze marker.

### The database answer

Three values, kept deliberately distinct — "the row is absent" and "the question could not be asked" are never both encoded as nothing:

- **row** — the state record above.
- **no-row** — the database opened and either the identity is not a registered repository or the registered repository has no such state entry.
- **unavailable** — carries a reason string. Produced by exactly these conditions, evaluated in this order:
  1. The runtime cannot load the embedded database module without a command-line flag (the floor is Node 22.13).
  2. The database file is absent while its write-ahead sidecars remain — an alarming classification whose reason names the recovery command.
  3. The database file is absent outright (no sidecars either).
  4. Any thrown error while opening, querying, or parsing.

**The stored format number is not one of them, and its absence is the decision.** This read applies no version comparison and no compatibility test at all: a file stamped ahead of this build still answers this question correctly, because the state row is plain text in a key/value table, and answering "cannot ask" instead routed a cut-over repository's writes back onto its frozen ref — the exact loss the protocol exists to prevent.

Conditions 2 and 3 are decided from the presence of the database file and its two sidecar files; every combination in which the database file itself exists proceeds to open it.

### Routing state

A four-armed tagged value:

| State | Additional data |
| --- | --- |
| `uncutover` | An optional warning string, set only when the database was unreachable. |
| `legacy-fenced` | none |
| `cutover` | The state record read from the row. |
| `blocked` | A reason string (the database answer's reason). |

## Behavior

### Resolving the state

For a given working directory, in order:

1. Read the freeze marker. Any failure is treated as "no marker".
2. Read the database answer as defined above.
3. **A row outranks the marker.** If the answer is `row`, the state is `cutover` — whether or not a marker is present. The row is written strictly after the marker, so a repository in the normal end state carries both.
4. Otherwise, if a marker is present:
   - answer `no-row` → `legacy-fenced`. The freeze happened but the swap has not been recorded yet.
   - answer `unavailable` → `blocked`, carrying the reason. There is no safe backend: the ref-backed branch is frozen and the database cannot answer.
5. Otherwise (no marker):
   - answer `unavailable` → `uncutover`, carrying the reason as a warning, **and log that warning**. This repository has never been frozen, so the ref-backed branch is still authoritative and continuing is correct.
   - answer `no-row` → `uncutover`, silently.

The complete table:

| Freeze marker | Database answer | State |
| --- | --- | --- |
| present or absent | row | `cutover` |
| present | no-row | `legacy-fenced` |
| present | unavailable | `blocked` |
| absent | no-row | `uncutover` |
| absent | unavailable | `uncutover`, warning logged |

The two `uncutover` rows and the `blocked` row are the same database condition read against opposite marker states, and the asymmetry is the whole point: an unreadable database must never stop a repository that was never frozen (one surface upgrading the schema would otherwise halt every healthy repository on the machine), and must never be waved through for one that was.

The answer is computed **per call**. Nothing about it is memoized by this decision except the repository identity (see below), so a long-lived process observes a state change on its next call.

**A process holding an already-constructed storage object observes it too, on two hosts.** The per-worktree memory-tool daemon and the desktop editor's extension host each probe this state lazily on their own call paths and rebuild that object when the classifier below says the system of record has moved — the daemon by swapping the process-wide storage override, the editor host by dropping its cached storage. The ref-backed write path's own last-line checks (spec 345) remain, and are now the **trigger** for an unthrottled re-probe as well as a refusal: a write that struck the frozen branch is proof a switch landed inside the current back-off window, so the next call re-probes instead of trusting it. The window itself, the coalescing and the latch are the heal gate's.

### Identity memo

The identity resolution behind the database lookup forks version control to read the canonical remote, and the second-witness probe below runs on **every** ref-backed write. A working tree's identity cannot change under a live process, so the resolution is memoized per process, keyed by the caller's working directory (not by the resolved root — resolving the root would itself be the version-control call being avoided, and two directories inside one working tree simply take one memo entry each). The database answer itself is **not** memoized here.

### What each state yields on the WRITE side

Storage construction loads the configuration, resolves the state, and then:

| State | Constructed storage |
| --- | --- |
| `blocked` | **Throws.** The message names the reason and states that the frozen ref cannot be fallen back to, pointing at the recovery command or a surface upgrade. |
| `legacy-fenced` | The database-backed backend as the system of record, paired with the folder mirror in the dual-write composite. |
| `cutover` | Identical to `legacy-fenced`: database-backed system of record plus folder mirror. |
| `uncutover` | The ref-backed backend as the system of record, paired with the folder mirror in the dual-write composite. |

**Dual-write is invariant across all three writable states.** The state chooses only *which* backend is the system of record; the folder side is never narrowed. The one thing that drops the folder side is the Memory Bank write boundary (spec 300), which is consulted in every writable state: on a refusal, the `uncutover` route degrades to the ref-backed backend alone (with a warning naming the project path), and the two database-backed routes degrade to the database-backed backend alone (silently — that branch logs nothing).

### What each state yields on the READ side

A separate read-side resolution answers "which backend should I read from?" and is **not** the same question as "which backend holds the truth" (spec 346). It resolves the state first:

| State | Read backend |
| --- | --- |
| `blocked` | **Throws**, with the same shape of message as the write side. |
| `legacy-fenced` | The database-backed backend. |
| `cutover` | The database-backed backend. |
| `uncutover` | Dispatched on the retired configuration key — see below. |

In the `uncutover` state only, the read side reads the configuration key `storageMode`, defaulting to `dual-write` when absent, and:

1. For every value other than the literal `orphan`, consult the Memory Bank write boundary; on a refusal, log a warning naming the working directory and the mode, and return the ref-backed backend.
2. `orphan` → the ref-backed backend.
3. `folder` → the folder mirror alone.
4. `dual-write` → the folder mirror, unless its summary-index document reads as absent (log a warning, return the ref-backed backend) or its dirty marker is set (log a warning, return the ref-backed backend).
5. Any unrecognized value → log a warning and return the ref-backed backend.

The two database-backed states never construct a folder mirror at all, so they need no write-boundary consultation.

### The retired configuration key

`storageMode` remains declared as a live configuration value with three accepted spellings (`orphan`, `dual-write`, `folder`). At HEAD it decides **nothing on the write side**: storage construction reads it only to log that a residual value is being ignored, then routes by the state table above. Three consumers still branch on it, all on the read or report side: the `uncutover` read-side dispatch listed above; one state-reporting derivation (spec 300); and an editor host's detail-panel read, which declines to hand back a folder mirror at all when the key reads `orphan`. That last one is **not** scoped to a routing state, so it also fires on a frozen repository.

Consequence: a repository configured `storageMode: "orphan"` **dual-writes the folder mirror** on every write while reading from the ref-backed backend. There is no configuration value that can produce a folder-less or a ref-less write path any more; only the state table and the write boundary can.

### The quiet second-witness probe

A separate, boolean-valued probe answers only "does a state row exist for this working directory's identity?". It is used by the ref-backed write path as its second last-line check (spec 345) and differs from the full resolution in two ways that are both deliberate:

- **It fails open.** Every `unavailable` condition answers `false`, because an unfrozen repository must never be blocked from writing by a missing or broken database — and its caller has already consulted the freeze marker.
- **It is silent.** It logs nothing on the everyday "no database created yet" path that every pre-database write takes.

### The shared "has the source of truth moved" classifier

This module also exports one boolean *over* the state: has the system of record moved **off** the freezable ref-backed branch — i.e. must a long-lived process holding a pre-switch storage object rebuild it?

| State | Answer |
| --- | --- |
| `cutover` | **true** — the switch is committed. |
| `legacy-fenced` | **true** — frozen but not yet recorded; the ref-backed branch cannot be written and must not be read as current. |
| `uncutover` | **false** — the ref-backed branch is still authoritative. |
| `blocked` | **false** — the database is unreachable, and rebuilding there would only turn readable-but-stale reads into a hard throw. |

It lives here, rather than in each host, because it is a **product rule** and not a host detail. Both long-lived hosts above route through this one classifier, so the state set is stated once and a fifth state cannot change one host's behavior without changing the other's. The four-state table itself is unchanged by its existence.

### Consumers that branch on the state itself

Besides the two storage resolutions, these paths read the state directly:

- **The queue drain** refuses to start in the `blocked` state: it logs an error, leaves every queued entry intact (it *peeks* rather than dequeues, because dequeuing prunes entries older than seven days as a side effect — exactly the set this gate most needs to keep), and emits a terminal capture-progress event per queued commit so an interactive commit is not left blocking on a worker that will never run.
- **The interactive commit-progress watcher** short-circuits in the `blocked` state: it prints a one-line notice that capture is deferred and returns without watching, because a worker that exits in that state never takes the capture lock and an absent lock reads to the watcher as "not started yet" — the watch could only end by timing out.
- **The visible-Markdown heal command** may drop manifest rows whose backing file is gone **only** in the `uncutover` state. Every other state, and any error resolving the state, keeps every manifest row. This is decided from the state and explicitly *not* from `storageMode`, which would have answered "dual-write" for every repository including the frozen ones.
- **The v1→v3 index migration**, whose writes bypass the ref-backed backend's own gates, refuses unless the state is exactly `uncutover`.
- **The automatic swap attempt** (spec 345) short-circuits on `cutover` (nothing to do) and on `blocked` (the repository needs recovery, not another attempt).
- **The two long-lived hosts' heal gate** reads the classifier above rather than the state directly, and on every answer of false — `uncutover`, `blocked`, *and* a probe that failed outright — it leaves the existing, possibly frozen-backed storage exactly where it is and backs off. It logs **nothing** on that path.
- **The status sub-command** prints one line per state, and sets a failing exit code for `blocked` only.

## State Transitions

The state is derived, not stored; it changes when a witness changes.

- **`uncutover` → `legacy-fenced`** — the swap wrote a freeze marker into this clone's profile while the database still has no row for the identity. One-way: nothing revokes a marker automatically.
- **`legacy-fenced` → `cutover`** — the swap's transaction recorded the state row.
- **`uncutover` → `cutover`** — observed by a clone that never received a marker (a second checkout the swap did not enumerate, or a clone created afterwards) the moment the row lands, since the row alone is sufficient.
- **any state → `blocked`** — a repository carrying a marker (or committed elsewhere) loses its database: the file is deleted, its sidecars are orphaned, a read throws, or the runtime falls below the module floor. Reversible by restoring the database or upgrading the runtime.
- **`uncutover` → `uncutover` with a warning** — the same database conditions on a repository that carries no marker.
- **`cutover` → `legacy-fenced`** is reachable **without any state changing** when the identity is resolved inconsistently: a caller that hashes a linked worktree's own path rather than the main root produces a different identity than the one registered, finds the marker but no row, and lands in `legacy-fenced` — where the database-backed backend then refuses every write against a frozen ref. (Notable; the reason every identity resolution starts from the main working-tree root.)

## Notable Behavior

- **A configuration key is still declared live and still parsed, but decides nothing about where writes go.** It is read on the write path solely to log that it is being ignored. What remains is read-side only: picking between the folder mirror and the ref-backed backend while the repository is `uncutover`, plus one editor-host read gate that consults it in every state. (Surprising; a config-only backdoor was removed by ignoring it rather than by deleting it.)
- **A repository explicitly configured for ref-only storage now dual-writes the folder mirror.** The write side lost that branch entirely. The state-reporting derivation that mirrors the old behavior did not (spec 300), so such a repository reports one thing and does another. (Surprising; documented as reality in 300.)
- **Two identical database failures produce opposite outcomes.** The same unreadable database is a warning-and-carry-on for an unfrozen repository and a hard refusal for a frozen one. This is the single most load-bearing asymmetry in the table: collapsing it in either direction either strands a frozen repository's writes on a branch nothing reads, or lets one surface's schema bump halt every healthy repository on the machine. (Notable; central.)
- **`legacy-fenced` is the state a boolean loses.** "Frozen but not yet recorded" is neither "cut over" nor "not cut over", and folding it into the latter routes writes straight back onto the frozen branch. (Notable.)
- **The row outranks the marker, and the marker is never revoked.** The end state carries both, and `cutover` is decided without even looking at the marker. (Notable.)
- **A wiped profile silently un-freezes a clone as far as this decision is concerned.** The profile document lives in per-project gitignored state, and a read failure — including a corrupt or deleted file — presents as "no marker". Such a clone still lands in `cutover` if the database can answer, because the row is keyed by the shared identity; it lands in `uncutover` if the database cannot. (Surprising; the second witness exists precisely to cover the first half of that, and cannot cover the second.)
- **The full resolution logs on the healthy path only when there is no marker.** The `uncutover`-with-warning arm warns on every call, which for a repository that has simply never created a database is the ordinary state. Downstream resolvers deliberately do not re-log it. (Notable.)
- **The `blocked` state is a throw on both storage paths, and every other consumer treats it as "defer, do not degrade" — with two exceptions.** The system-of-record fallback shared by untargeted store operations degrades `blocked` to the ref-backed backend with a warning (spec 346). The heal gate is the second and the quieter one: `blocked` (and a failed probe) means "leave the existing, possibly frozen-backed storage in place", and it backs off with **no log line at all** — where the first at least warns. Those are the two places `blocked` does not fail loudly. (Surprising.)
- **The classifier over the state is a product rule, not a host convenience.** Both long-lived hosts ask this one question rather than each restating the "has the source of truth moved" state set, so a fifth state cannot change one host's behavior without changing the other's. It answers true for `cutover` and `legacy-fenced` only — `uncutover` still has the ref-backed branch as its source of truth, and rebuilding on `blocked` would trade a stale-but-successful read for a throw. (Notable.)
- **The database is opened on every routing call.** The decision memoizes only the identity, so a caller in a loop pays one database open per call unless it resolves through the memoizing sibling (spec 346). (Notable.)
- **A source comment asserts that neither frozen state is reachable in production "until the engine starts writing fences".** That is stale at HEAD: an automatic trigger presses the swap from the post-commit queue drain and from the dashboard command, so both frozen states are ordinary production states. (Notable; the comment is wrong, the code is not.)

## Shared Behavior

- The freeze marker's meaning, everything that changes once it is present, the locked compare-and-swap that writes it, and the drift probe that watches for writers that bypassed it are defined by **Orphan Branch Cutover Fence and Compare-and-Swap** (345).
- The difference between resolving the system of record and resolving read storage, the short-lived route memo, and the degradation that turns `blocked` into ref-backed reads are defined by **System-of-Record versus Read Storage Resolution** (346).
- The shared heal gate the two long-lived hosts wrap around this decision — its back-off window, its coalescing of concurrent probes, its one-way latch, the racing re-check before a rebuild, and each host's own rebuild step — is a neighbouring topic. This spec owns the classifier it asks and the states that classifier answers false for.
- The dual-write composite the two folder-bearing routes construct — its read/write fan-out, its dirty-flag protocol, and its shadow-only delegations — is defined by **Dual-Write Summary Storage**.
- The ref-backed backend's plumbing, and the two last-line refusals its write batch carries, are defined by **Orphan Branch Summary Storage**.
- The Memory Bank write boundary consulted in every writable state, its refusal vocabulary, and the separately-reported effective state derived from the retired key are defined by **Memory Bank Write Boundary and Effective-State Reporting** (300).
- The durable repo-wide manual-disable opt-out, which is a separate axis from this state and suppresses writes in every state, is defined by **Repo-Wide Manual Disable Flag** (145).

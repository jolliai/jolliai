# 03. Dual-Write Summary Storage

## Topic Statement

Fan every write across two backends — the repository's system of record and the Memory Bank folder mirror — serving every read from the system-of-record slot alone, and never letting a mirror failure fail the write.

## Scope

**In scope:**

- The composite's two slots, what may occupy each, and the identity it reports for itself.
- Which backend pairings are constructed, and the fact that the pairing is chosen by routing state rather than by any configuration value.
- The order writes are issued, what happens on failure of either slot, and the manual-disable gate that sits ahead of both.
- Initialization of both slots and what happens when the mirror's initialization fails.
- The dirty-marker protocol used to record that the mirror has fallen behind, and the exact set of operations that set and clear it.
- Which slot serves reads, listings, existence probes, the folder-root accessor, and the wiki-presence probe.
- Delegation of the optional operations that only a visible layer can implement, including the one whose target selection is not fixed to the mirror.
- The one delegated operation that does **not** catch, and therefore propagates.
- Where the composite is not constructed at all, and what is returned instead.

**Out of scope (boundaries):**

- **The former subject of this spec.** This spec used to describe a three-way selection between ref-only, folder-only and dual-write storage driven by a single configuration value. That selection no longer exists on the write side: the value is read only to log that it is being ignored, and the pairing is decided by the routing state. What survives of it — the value's one remaining read-side consumer, and the states that select each pairing — is defined by **Cutover Routing State Table** (344).
- The routing state table, its two witnesses, and the state in which storage construction throws instead of returning anything (344).
- The distinction between resolving the system of record and resolving read storage, and the fact that reads at a higher level often bypass this composite entirely (346).
- The internals of either slot: the ref-backed backend, the database-backed backend, and the folder mirror each have their own topic.
- The Memory Bank write boundary, its refusal vocabulary, and the effective-state record derived from it (spec 300). This spec states only where a refusal removes the mirror slot.
- The durable repo-wide manual-disable opt-out (spec 145). This spec states only that the composite carries the gate and why it needs its own.
- The schema or interpretation of the content written through either slot.
- Any background reconciliation between the two slots; this layer performs none.

## Data Contracts

### The two slots

| Slot | Role |
| --- | --- |
| system of record | Serves every read, listing and existence probe; written first. Publicly reachable on the composite so a caller can detect a database-backed system of record and take a backend-specific fast path. |
| mirror | Receives a copy of every write. Never read through the composite. |

Both slots implement the same storage contract (read one path, write a batch with a message, list under a prefix, check existence, initialize, plus the optional dirty-marker, visible-layer and wiki-layer entry points).

### Which pairings exist

The pairing is chosen by routing state (344), never by configuration:

| Routing state | System-of-record slot | Mirror slot |
| --- | --- | --- |
| `uncutover` | The ref-backed backend | The folder mirror |
| `legacy-fenced` | The database-backed backend | The folder mirror |
| `cutover` | The database-backed backend | The folder mirror |

In every one of those states, a refusal from the Memory Bank write boundary removes the mirror and **no composite is constructed** — the system-of-record backend is returned bare. In the remaining routing state, storage construction throws and nothing is constructed at all.

The mirror slot is therefore always the folder mirror in production, and the assignment is not configurable in either direction.

### Backend identity

The composite carries the contract's optional identity value and reports **its own** identity — `dual-write` — rather than forwarding either slot's. A diagnostic naming the active backend therefore names the composite, not the slot that actually answered the read. The value is diagnostic only: nothing branches on it and it is never persisted.

### Folder-root accessor

The composite exposes the folder root of its **mirror** slot (the system-of-record slot has none in the ref-backed case and does not carry one in the database-backed case). This is what a caller writing a disposable search index alongside the Memory Bank folder uses.

### Write batch

A list of file-write entries plus a message string, identical in shape to the per-backend contract.

### Dirty-marker protocol

Three optional operations, invoked on the **mirror only** and never on the system of record, using optional-call semantics so a slot that does not implement one turns the call into a no-op:

- **mark dirty**, carrying a contextual message — requested after any failed mirror write, and after any failed delegated visible-layer operation.
- **clear dirty** — requested after a successful mirror write batch, and only there.
- **is dirty** — forwarded through the composite so external code can observe the mirror's state without holding a direct reference. Answers false when the mirror does not implement it. One consumer of note is a schema migration that reads it to avoid stamping itself complete while the mirror has silently fallen behind.

## Behavior

### Read one path

Forward unchanged to the system-of-record slot. The mirror is never read. The composite adds no classification of its own: a null means "absent" exactly as the contract says, and any genuine read failure behind it has already been reported by the slot that could still see the cause.

### Read many paths

Forward to the system-of-record slot's batch read when it implements one; otherwise loop its single-path read and assemble the result map. The mirror is never read.

### List under a prefix / existence probe

Both forward unchanged to the system-of-record slot. The mirror is neither listed nor probed.

### Initialize

1. Initialize the system-of-record slot. A throw propagates to the caller.
2. Then initialize the mirror. A throw is logged at warning level and **swallowed**; the composite reports success regardless.

Because the mirror's initialization failure is swallowed, a later write batch retries it and either succeeds — silently repairing the earlier failure — or fails and sets the dirty marker.

### Write a batch

0. If the repository is **manually disabled**, return immediately, before either slot is touched. Both slots carry the same gate on their own write batches, so the writes themselves would already be no-ops; the composite needs its own gate because otherwise step 2's success tail would clear the mirror's dirty marker and record a never-performed mirror write as clean.
1. Write the system-of-record slot. A throw propagates to the caller and **the mirror is not written**.
2. Then, inside a catch:
   - On success, request "clear dirty" on the mirror.
   - On any throw, log a warning carrying the error's message (or the stringified value when it is not an error), then request "mark dirty" on the mirror. The composite reports success regardless.

There is no retry, no queue and no background reconciliation. A mirror that has been marked dirty stays dirty until an external process clears the marker or a subsequent successful write batch clears it.

The two writes are **sequential and system-of-record first**, never concurrent: a slow first write delays the mirror write. That ordering is also what makes retrying a refused batch safe — when the system-of-record slot refuses outright, as the ref-backed slot does past a freeze (345), the mirror has not been written yet, so a refused batch leaves no partial write for a retry to duplicate.

### Delegated visible-layer operations

Operations whose meaning applies only to a visible layer are delegated. For each, when the mirror does not implement it the call is a no-op returning a neutral value (false, zero, or nothing); when the delegated call throws, the composite catches, logs a warning naming the operation and the affected identifier, requests "mark dirty" on the mirror with a contextual message, and returns the neutral value. The throw does not propagate.

The delegated operations:

- Delete the visible Markdown for one summary entry (returns whether it deleted; neutral value false).
- Regenerate the visible Markdown for one summary entry from the hidden source (neutral value false).
- Delete a plan's visible Markdown (no return value).
- Delete a note's visible Markdown (no return value).
- Prune the per-repository branch-folder mappings for a set of branch names (returns the number actually removed; neutral value zero).
- Heal missing visible Markdown — see the next section, whose target selection differs.

None of these clear the dirty marker on success. Only a successful write batch does, so a mirror can stay dirty across many successful delegated operations.

### Healing missing visible Markdown

The only delegation whose target is not fixed to the mirror slot. The composite picks the **mirror** when it implements the operation, otherwise the **system-of-record slot** when it does, otherwise returns a zero result. The chosen side's name is carried into the log line so a post-mortem does not have to re-derive which slot ran.

It passes through the caller's "drop manifest rows whose backing file is also gone" flag, defaulting it to **true** at this seam because a caller reaching the composite has a truth source that can repopulate such a row. (The command that invokes it decides that flag from the routing state before it ever gets here — see 344.)

A successful delegation returns the target's counts. A throw returns zeroed counts plus an error string, and that string is prefixed with the error's system error code when present — the raw message often lacks the code that tells an operator what to do next. The failure also marks the target dirty.

### Topic wiki

- **Render** delegates to the mirror and is the one delegated operation with **no catch**: a mirror that throws while rendering propagates the throw to the caller, and no dirty marker is set. (Notable; every neighbouring delegation swallows.)
- **Presence probe** consults the mirror, answering false when it does not implement one. The system-of-record slot has no visible wiki layer.

## State Transitions

The composite itself holds no state. Its observable state is the mirror's dirty marker:

- **In sync → dirty** — a write batch whose system-of-record write succeeded and whose mirror write threw; or any caught delegated visible-layer operation that threw.
- **Dirty → in sync** — a subsequent write batch in which both slots succeeded. Nothing else clears it.
- **Initialization failures on either slot** are observable in the log but do not touch the marker.

The pairing itself changes only when a new composite is constructed: an instance never re-pairs itself, which is why the ref-backed slot re-checks the freeze from disk on every write batch (345). The hosts that hold such an instance do now detect a routing-state change out of band — a throttled route probe on their own call paths — and drop or replace the composite on that signal, not only on settings-save.

## Notable Behavior

- **This spec's former subject no longer exists.** The three-way selection between ref-only, folder-only and dual-write storage, driven by one configuration value, is gone from the write side: the value is read solely to log that it is being ignored. What replaced it is the routing state table (344), and the composite described here is what all three of its writable states construct. (Surprising; the configuration key is still declared, still accepted, and still decides one thing on the read side.)
- **Dual-write is invariant across the cutover.** The switch changes which backend is the system of record and never narrows the mirror side — the hidden layer of the folder mirror keeps being written past the freeze, because it is what the Memory Bank sync, the JetBrains sidebar reader and mirror-based recovery consume. (Notable; central.)
- **Reads never touch the mirror.** Every read, listing and existence probe inside the composite consults the system-of-record slot. Higher-level read resolution may pick the folder mirror *directly*, bypassing the composite — that is a different decision, defined by 344 and 346. (Notable.)
- **Mirror failures are invisible at the API surface.** A failed mirror write or initialization is a warning in the log and nothing else; the composite reports success. The dirty marker is the only durable trace. (Surprising; intentional.)
- **A system-of-record failure aborts the batch before the mirror is attempted.** The caller sees that slot's error verbatim and the mirror is left untouched — one write behind, and not marked dirty. (Notable.)
- **No partial rollback and no retry.** A system-of-record write that succeeded stays in place when the mirror fails; nothing is undone and nothing is queued. (Notable; intentional.)
- **The wiki render is the delegation that does not swallow.** Every other delegated visible-layer operation catches, marks dirty and returns a neutral value; the render propagates. (Surprising.)
- **Delegated operations mark dirty but never clear it.** Only a successful write batch clears the marker, so a mirror can remain dirty through any number of successful delegated repairs. (Surprising.)
- **The heal delegation can run against the system-of-record slot.** Its target selection prefers whichever slot implements the operation, mirror first — a fallback that exists only in case the two slots are ever constructed the other way round. In production wiring the mirror always implements it. (Notable.)
- **The heal seam defaults the destructive flag to true.** The composite defaults "drop manifest rows whose backing file is also gone" to true because a caller reaching a composite has a truth source to repopulate from. A folder-only caller bypasses the composite and must not set that flag — for it the manifest is the last record. (Notable; intentional.)
- **The composite names itself in diagnostics, not the slot that answered.** (Notable.)
- **The composite carries its own manual-disable gate even though both slots carry one.** Without it, a disabled repository's write batch would run the success tail and clear a dirty marker for a mirror write that never happened. (Notable.)
- **The folder-root accessor forwards the mirror's root, not the system of record's.** (Notable.)
- **Changing state does not back-fill.** Moving a repository from one pairing to another migrates nothing between backends; a separate one-shot migration exists for that, and it deliberately resolves its source as the system of record rather than as read storage (346). (Notable.)

## Shared Behavior

- The routing state table that decides which pairing is constructed, the state in which construction throws, and the retired configuration key's one surviving consumer are defined by **Cutover Routing State Table** (344).
- The difference between resolving the system of record and resolving read storage — including the untargeted fallback that bypasses this composite on a write and silently loses the mirror side — is defined by **System-of-Record versus Read Storage Resolution** (346).
- The Memory Bank write boundary whose refusal removes the mirror slot, its refusal vocabulary, and the separately-reported effective state are defined by **Memory Bank Write Boundary and Effective-State Reporting** (300).
- The durable repo-wide manual-disable opt-out that suppresses this composite's write batch is defined by **Repo-Wide Manual Disable Flag** (145).
- The ref-backed slot's plumbing, its two write-time freeze refusals, the storage contract's read semantics, and the optional identity value are defined by **Orphan Branch Summary Storage**.
- The mirror's three-layer on-disk shape, its manifest and branch-mapping registry, its atomic-write semantics, its dirty-marker persistence, and its wiki rebuild contract are defined by **Folder-Based Summary Storage**.
- The freeze marker that makes an in-process composite's ref-backed slot start throwing mid-life is defined by **Orphan Branch Cutover Fence and Compare-and-Swap** (345).
- The throttled route probe by which a long-lived host notices that switch and replaces the composite in place, and the single retry it performs against the refused write, are defined by **Stale Storage Heal After an Unwitnessed Cutover**.
- The schema of the content carried through both slots is defined by **Summary Tree Structure**.

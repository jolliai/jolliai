# Summary Schema Migration

## Topic Statement

A two-phase, idempotent migration that upgrades stored summaries from the legacy "flat records list" format to the current "unified hoist tree" format and upgrades the lookup index from its legacy shape to the current flat-with-parent-links shape, retaining the legacy data store for a 48-hour safety window before reclamation.

## Scope

**In scope:**
- The two phases of migration: payload reshape, then index rebuild.
- What triggers migration (operator-issued command versus automatic).
- Legacy retention window and the timestamp marker that gates reclamation.
- Reporting (counts of converted, skipped, failed).
- Idempotency on re-run, including resumption after interruption.
- Reader detection of format version and how readers handle a mixed corpus.
- What is preserved versus dropped during conversion.

**Out of scope:**
- The structure of the index itself (covered by the summary-index topic).
- The structure of the unified-hoist tree itself (covered by the summary-tree topic).
- The pipelines that write new summaries (covered by the pipeline topic).
- A separate, parallel migration from the durable store to a folder-based mirror (covered by the local-folder-mirror topic).

## Data Contracts

### Format-version markers

- A summary payload carries a numeric **version** field at its root. Versions below the unified-hoist threshold (legacy "v1") have a flat-records shape. Versions at or above the threshold have a tree shape.
- The lookup index carries a numeric **version** field at its container level. Two values are recognized: the legacy value and the current value.

### Migration completion marker

A single small structured record persisted alongside the current-format data. It contains:

- **migrated-at** (required, ISO timestamp): when the legacy-to-current payload migration completed.

The presence of this record signals that the legacy data store is in safety-retention mode and that re-running migration should short-circuit.

### Two distinct legacy stores

The migration operates on two separate legacy ledgers:

1. **The legacy payload store**: a parallel orphan-style branch holding flat-records payloads.
2. **The legacy-shaped index** sitting on the current branch but produced before the index format was upgraded.

These two are migrated by independent steps.

### Conversion shapes

The legacy payload contained a top-level envelope (commit hash, message, author, date, branch, generated-at, optional commit type, optional commit source, optional article URL) and a list of records. Each record carried a per-session contribution: per-record commit hash, message, date, transcript-entry count, optional conversation-turn count, optional LLM-call metadata, diff stats, and a list of topics.

The current payload is a tree of nodes; each node has the same envelope plus optional topics, recap, hoisted memory metadata, plans, notes, e2e-test scenarios, and an optional ordered list of children.

## Behavior

### What triggers migration

Migration runs only when an operator explicitly invokes the migration command. There is no automatic on-first-read migration. Readers tolerate the presence of legacy-format data; they do not silently rewrite it.

### Phase 1: legacy payload store → current payload store

1. Probe whether the legacy payload branch exists. If not, log "nothing to migrate" and proceed to Phase 2 with zero counts.
2. List every payload file under the legacy branch's payload prefix.
3. For each payload file:
   1. Read its contents. If unreadable, skip silently.
   2. Parse it. If unparseable, increment skipped, log a warning, and continue.
   3. If the parsed object lacks a flat-records list (already in tree shape), enqueue an unchanged copy for write to the current store and increment skipped.
   4. Otherwise convert (see "Conversion rules"), enqueue the converted payload, and increment migrated.
4. Rebuild the current-shape index from the legacy index, retaining only entries whose corresponding payload file is in the write queue (see "Index rebuild during phase 1"). Append the rebuilt index to the write queue.
5. Submit the entire queue as one atomic batch on the current branch.
6. If at least one payload was processed (migrated or skipped > 0), persist the migration completion marker on the current branch.

### Conversion rules (legacy payload → tree)

When converting one legacy payload:

- **Single-record payload**: produce one tree node by combining the envelope and the single record's fields. The envelope's per-commit metadata wins on overlap; the record contributes transcript-entry count, optional conversation-turn count, optional LLM-call metadata, diff stats, and topics. The article-URL field is renamed to its current name on the tree node. No children list is produced — this is a leaf node.
- **Multi-record payload**: produce a container root node carrying only the envelope (no own topics, no own diff stats). For each record, build a child node by combining: the record's own commit hash, message, and date; the parent envelope's author, branch, and generated-at; the record's transcript-entry count, optional conversation-turn count, optional LLM-call metadata, diff stats, and topics. Sort children by their commit dates, newest first. Attach as the root's children list.
- **Field renames**: the legacy "article URL" field is mapped to the current "doc URL" field on the resulting root.
- **Optional fields**: legacy commit type, commit source, and article URL are propagated to the converted root only when present.

### Index rebuild during phase 1

1. Read the legacy-shape index from the legacy payload branch. If absent or unparseable, skip the rebuild.
2. Build the set of commit hashes whose payload was queued for write in this phase.
3. Filter the legacy index's entries: keep those whose commit hash is in the queued set. Drop the rest.
4. Wrap the filtered entries in a container marked with the legacy version marker. (Phase 1 does not yet upgrade the index version marker — it only prevents dangling entries.)

### Phase 2: legacy-shaped index → current-shaped flat index

This phase runs whether or not Phase 1 found anything.

1. Load the index from the current branch.
2. If absent, log "nothing to migrate" and return zero counts.
3. If the index's version marker is already current, log "already migrated" and return zero counts.
4. For each entry in the legacy index:
   1. Read the corresponding root payload via the current store. If unreadable, increment skipped, log a warning, and continue.
   2. Walk the payload tree depth-first, producing one entry per node. The root's parent link is null; each descendant's parent link is its direct parent's commit hash. Compute and attach each node's source-tree hash where possible (best-effort; absence is not fatal). Attach root-only cached fields where applicable.
   3. Insert all produced entries into a working map, keyed by commit hash.
   4. Increment migrated by 1 (counting source roots, not produced entries).
   5. On any conversion exception, increment skipped, log a warning, and continue with the next entry.
5. Construct the new index container: current version marker, entries derived from the working map's values.
6. Persist the new index as a single atomic write. Callers must already hold the shared cross-process lock.

### Reporting

Each phase returns a pair of counts: **migrated** and **skipped**.

- A payload that converts cleanly counts as migrated (Phase 1) or its source-root counts as migrated (Phase 2).
- A payload that is unparseable, unreadable, already in current shape (Phase 1), or fails tree flattening (Phase 2) counts as skipped.
- A "nothing to migrate" outcome (no legacy data, or already current) returns zero/zero.
- The operator-facing command surfaces: per-phase headers, the migrated and skipped counts, a "no data found" line when both are zero, and a "retained for 48 hours" notice when Phase 1 produced any work and the marker was persisted.

### Idempotency on re-run

Operator re-invocation:

- **Phase 1**: probes the migration completion marker. If present, it short-circuits with a console notice ("migration already completed; legacy retained for 48 hours"), and proceeds straight to Phase 2.
- **Phase 2**: probes the current index's version marker. If already current, short-circuits with zero counts. Otherwise re-runs the flatten step from scratch.

A second invocation thus performs no payload writes once Phase 1 has succeeded once, and performs no index writes once Phase 2 has succeeded once.

### Interruption recovery

Both phases are atomic at the storage level: their entire write queue lands as one commit on the durable store, or the storage layer rejects it. There is no partial-write state to repair.

If Phase 1 commits its payload batch but never persists the completion marker (e.g. the process is killed between the two writes), the next invocation will re-run Phase 1 from scratch. The payload-write step is itself idempotent: every legacy payload that already exists in current shape on the destination flows through the "already in tree shape" path and is counted as skipped, not migrated. Outcome: a duplicate write of identical data, no semantic change.

If Phase 2 fails midway, the next invocation re-detects the legacy version marker and re-runs the full flatten from the legacy entries.

### Legacy retention window

Phase 1 does not delete the legacy payload branch. Instead:

1. The completion marker is persisted with the current timestamp.
2. A separate cleanup routine probes:
   - Whether the legacy branch still exists. If not, no-op.
   - Whether the completion marker exists and parses. If not, no-op (log: "skipping cleanup, marker missing").
   - The age of the marker. If less than 48 hours, no-op (log: "retained, X hours since migration").
   - Otherwise: delete the legacy branch ref. Log the elapsed hours.
3. The cleanup routine is safe to call repeatedly. It is invoked opportunistically (e.g. by routine maintenance paths, not by the migration command itself).

The 48-hour window provides operators a recovery channel: until reclamation, the original legacy data is byte-for-byte intact and inspectable.

### Reader behavior in a mixed corpus

Readers must tolerate both legacy-version and current-version payloads coexisting. The relevant rule:

- Look at the payload's own version field, not at any heuristic such as topic-list length or presence of a children list.
- For operations that need topics from a stored payload during a rewrite (e.g. preserving topics across a rebase pick), readers branch on the version:
  - **Current version**: the root is authoritative; read its topics list directly. An empty list is legitimate.
  - **Legacy version**: topics may live on the root, on children, or split between both (the latter is the legacy-amend shape, where the root carries delta topics and a single child carries pre-amend topics). Walk the entire tree and union the topic lists, stripping any per-node decoration that was added during traversal.
- For operations that need per-source grouping (e.g. preparing inputs for an LLM consolidation across a squash), readers similarly branch:
  - **Current version**: produce one source from the root itself.
  - **Legacy version**: produce one source per child; additionally, if the legacy root carries its own non-empty topics or its own recap, append the root as its own source — this preserves legacy-amend delta data that lives only on the root.

These rules guarantee no information loss when the writer for a downstream operation encounters legacy-format input.

### Per-entry resilience

Phase 1 and Phase 2 both proceed entry-by-entry: a single bad payload causes that one entry to be skipped, never aborts the run. The final batch contains every entry that succeeded.

## State Transitions

The system as a whole moves through these phases:

- **Pre-migration**: legacy payload branch present, current branch absent or empty, index (if any) at legacy version. No completion marker.
- **Phase 1 done, retention active**: legacy payload branch still present, current branch contains converted payloads and rebuilt-but-still-legacy-version index, completion marker present, marker age under 48 hours.
- **Phase 2 done, retention active**: same as above except the index is at current version.
- **Retention expired, legacy reclaimed**: legacy payload branch deleted, current branch unchanged, completion marker remains as a historical record.

Per-entry transitions during a phase: an entry is in one of {converted, skipped-as-already-current, skipped-due-to-error, skipped-due-to-unreadable}. Skips do not block other entries.

## Notable Behavior

### Two completely independent legacy ledgers

The payload migration and the index migration are not coupled. A workspace might have only legacy payloads (Phase 1 work, Phase 2 nothing), only a legacy index (Phase 1 nothing, Phase 2 work), both, or neither. The command runs both phases unconditionally and reports each separately.

### Phase 1's index rebuild keeps the legacy version marker

Phase 1 rebuilds the index to drop entries whose payload couldn't be migrated. It does not flip the version marker — that is Phase 2's job. The intermediate state (current-format payloads + legacy-version index) is fully consistent for legacy-aware readers.

### Tree-hash population on flatten

During Phase 2's depth-first flatten, each produced entry attempts to compute its source-tree hash. Failures are silent (the field is omitted). Cross-branch fallback simply cannot resolve those entries until a future scan succeeds.

### Single-record promotion preserves the original commit hash

When promoting a single-record legacy payload to a leaf node, the resulting node's commit hash is the legacy root's hash — not the inner record's hash. (In legacy single-record payloads they were always identical, but the rule is "envelope wins on overlap.") This guarantees that index entries built from the converted payload key on the same hash that callers will look up.

### Multi-record promotion creates a pure container

When promoting a multi-record payload, the resulting root has no own topics, no own diff stats, no own LLM-call metadata. Those fields exist only on the children. The tree's container node thus mirrors the structure produced by the current pipeline's squash-style merge.

### Safety net is a feature, not a bug

The 48-hour retention is intentional. Operators who notice a bad migration outcome have the legacy ledger intact for inspection and manual recovery. Reclamation happens passively through the cleanup probe, never as part of the migration command itself.

### "Already migrated" short-circuit reads only the marker

The Phase 1 short-circuit checks for the completion marker on the current branch alone. It does not re-list legacy payloads, does not parse them, and does not compare counts. Operators who want to force re-conversion must remove the marker manually.

## Shared Behavior

- **Summary index format** — the legacy and current shapes of the index, the version marker, the entry shape produced by Phase 2's flatten, and how readers branch on the index version.
- **Summary tree format** — the unified-hoist root contract, hoist-managed fields, and the per-version branching readers apply when extracting topics or per-source groups during downstream operations.
- **Storage backend** — atomic batch write semantics, branch-creation behavior, and the pure-plumbing read/write helpers used to manipulate the durable store without checkout.
- **Cross-process lock** — the shared lock that index writes (Phase 2) require their callers to hold.
- **Pipeline operations** — the live writers (commit, amend, squash, rebase pick) whose readers must tolerate the mixed corpus described above.

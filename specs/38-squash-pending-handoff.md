# Squash-Pending Handoff

## Topic Statement

A short-lived state record, written before a squash commit is created and consumed immediately after, that conveys the list of source commit hashes being collapsed so the consumer downstream can identify which existing summaries belong to the new commit.

## Scope

**In scope:**
- Shape of the squash-pending state record.
- Where the record is stored relative to the per-repository state directory.
- Conditions that cause the record to be produced.
- The parent-hash guard that protects against stale residue from an aborted operation.
- Deletion timing once the record has been read.
- Behavior when no record is present at consumption time.

**Out of scope:**
- How the consumer subsequently consolidates the summaries (covered by the squash consolidation topic).
- The queue file written for the operation itself (covered by the operation queue topic).
- The downstream archival of plans or notes (covered by their respective topics).

## Data Contracts

### Squash-pending record

A single structured record with these fields:

- **source hashes** (required, list of strings): the full commit hashes of every original commit being collapsed into the new commit, in the order recovered from the producer's evidence. Treated as an unordered set by the consumer.
- **expected parent hash** (optional, string): the commit hash that was at the tip of the working ref at the moment the record was produced. Used by the consumer as a stale-residue guard. Older records may omit this field; the consumer treats absence as an explicit opt-out from the guard rather than a failed match.
- **created at** (required, ISO timestamp): when the record was written.

### Location

The record lives at a fixed path inside the per-repository state directory used by the broader hook pipeline. There is at most one such record per repository at any time.

## Behavior

### Production

The record is written when either of these conditions is detected during commit message preparation:

1. The git operation in progress is a squash merge (the prepare-message source signal is "squash"). The list of source hashes is recovered from the squash-message scratch file maintained by git; lines matching a "commit followed by a 40-character hex hash" pattern provide each hash. If the scratch file produces no hashes, no record is written.
2. The git operation in progress is a manual reset-and-recommit pattern (a soft reset followed by a commit) detected by inspecting the recent operation log. The list of source hashes is the set of commits between the prior tip and the current tip.

In both production paths, the current working-ref tip is captured at the moment of writing and stored as the expected parent hash. Production is written atomically (write-and-rename) and is best-effort: if the producer fails, no record is written and the downstream consumer treats the operation as a normal commit.

### Consumption

After the squash commit has been created, the consumer:

1. Looks for the record at the fixed path.
2. If absent, treats the operation as a normal commit.
3. If present, parses it.
4. If the expected-parent-hash field is present, compares it to the parent of the just-created commit. On mismatch, the record is discarded as stale residue and the operation is treated as a normal commit. On match (or absence of the field), the source-hashes list is adopted.
5. The record is deleted regardless of whether its contents were used or discarded.

### File-not-present semantics

A missing record at consumption time is the normal case for non-squash commits and is not an error. The consumer never blocks on the absence of a record.

## State Transitions

The record passes through these states:

- **Absent** is the steady state.
- **Absent** → **Present** on production (squash-merge or reset-and-recommit detection).
- **Present** → **Absent** on consumption, regardless of whether the contents were validated or discarded as stale.
- **Present** → **Absent** on independent stale-record cleanup performed by housekeeping paths when the record's age exceeds 48 hours (decoupled from any specific commit lifecycle, since the producer might have run without a successful consumer). This 48-hour ceiling is the canonical value owned by this spec; it is enforced by the periodic cleanup process (see "Stale data cleanup"). Mid-session staleness can also be detected by the post-commit-time `expectedParentHash` guard, which works regardless of the record's age.

Stale records that survive past the ceiling are reaped by housekeeping; they never leak across distinct squash operations because the consumer always deletes the record after reading.

## Notable Behavior

### Stale-residue guard

The expected-parent-hash field exists specifically to defend against a scenario where the producer ran but the eventual squash commit was aborted, leaving a record on disk whose source-hashes list does not actually correspond to the next commit the user makes. By comparing the record's expected parent to the actual parent of the just-created commit, the consumer rejects orphan records without acting on them.

### Backward-compatible opt-out

When the field is absent (older records produced before the guard was introduced), the consumer skips the comparison and trusts the record. This preserves a one-time migration window without forcing readers to special-case empty strings vs missing fields.

### Best-effort production

A failure during production (unreadable scratch file, failed atomic write) leaves no record on disk. The consumer's "absence means normal commit" rule subsumes this case — the squash will simply be processed as if it were an independent new commit, with a warning logged at the producer.

### Single-slot semantics

There is only one record path per repository, so concurrent squash operations are not supported by this record. Concurrency is prevented at a higher level by the shared cross-process lock, not by this record's structure.

## Shared Behavior

- **Per-repository state directory** — the conventional directory under which all transient hook state is rooted.
- **Atomic write-and-rename** — the same primitive used elsewhere for state files.
- **Operation queue** — the queue file the consumer writes after parsing this record; consumes the source-hashes list when present and a sentinel "normal commit" type when absent.
- **Cross-process lock** — the shared lock that prevents two hook processes from racing on this record.
- **Housekeeping for stale state files** — the unrelated path that reaps records past the age ceiling.

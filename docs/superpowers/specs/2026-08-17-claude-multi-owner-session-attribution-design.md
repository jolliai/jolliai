# Claude multi-owner session attribution - design

**Date:** 2026-08-17
**Scope:** fix Claude conversation capture so one Claude session may be attributed to multiple worktrees and repositories without falling back to whole-session ownership, and add a bounded repair path for historical summaries that were written with `transcripts: []`.
**Depends on:** the current post-commit QueueWorker pipeline, the Claude Stop hook, and the existing Claude disk discoverer.

---

## 1. Problem

Claude capture currently has two different attribution paths:

- The post-commit summary path reads Claude sessions from the current worktree's `.jolli/jollimemory/sessions.json`.
- The dashboard and backfill paths can discover Claude transcripts from disk and attribute one session to multiple directories and repositories.

That split creates a correctness gap. A Claude session that was seen from a different worktree, or that touched multiple repositories during one conversation, can still appear in dashboard storage while the post-commit summary for a later commit writes `transcripts: []`.

The obvious patch, scanning sibling worktrees' `sessions.json`, is not sufficient. It only helps linked worktrees in one repository, does not cover cross-repo sessions, and still throws away the real evidence already present in the transcript: the set of working directories the session touched.

The second trap is cursor ownership. The current cursor model is keyed by `transcriptPath` inside one worktree's `cursors.json`. If a foreign-attributed Claude session is first consumed from a different owner with no local cursor, the reader starts from line 0 and only stops at `beforeTimestamp`. That would wrongly attribute the entire earlier portion of the session to the current commit.

## 2. Goals and non-goals

### 2.1 Goals

- Let one Claude session be attributed to more than one worktree and more than one repository.
- Keep commit summaries slice-based rather than whole-session based.
- Prevent a newly-attributed owner from consuming transcript history that predates that owner's first participation in the session.
- Keep the fast forward-capture path; do not make every post-commit summarization depend on a full transcript disk sweep.
- Add a repair path for historical summaries written with `transcripts: []`, but only when the missing transcript still exists locally and can be bounded safely.

### 2.2 Non-goals

- Do not redefine ownership for non-Claude sources in this slice.
- Do not rewrite the stored-transcript schema or the existing `summary.transcripts` contract.
- Do not promise recovery of transcripts that the host has already rotated or deleted.
- Do not collapse attribution to a machine-global "repo" cursor. Cursor advancement must remain isolated between worktrees.

## 3. Chosen model

The fix is a mixed model:

- Keep the Stop hook as the fast forward-capture entry.
- Introduce a Claude ownership ledger that records owner-specific evidence for each session.
- Use worktree-root ownership edges, not a single worktree-local session registry, to decide whether a commit may consume a Claude session.
- Seed an owner-specific cursor from the owner's first-seen position so the first consumption from that owner does not start at line 0.
- Use the Claude disk discoverer only for repair and for recovery when forward-capture evidence is missing.

This deliberately preserves the existing summary pipeline shape: a commit still stores only its own derived transcript slice, and `summary.transcripts` still points at a stored artifact generated at capture time.

## 4. Ownership semantics

### 4.1 Owner identity

The owner key is the current git worktree root, the same root `resolveStateRoot()` already resolves for hook entrypoints.

This is stricter than repository identity on purpose. Two linked worktrees of the same repository may be on different branches and may consume different parts of one long Claude session. Sharing a single repo-level cursor would let one worktree advance the other and recreate the current bug in a new form.

Cross-repo sessions are therefore represented as multiple ownership edges, one per worktree root that the session touched.

### 4.2 Ownership edge

Each Claude session may have zero or more ownership edges. An edge records:

- `ownerRoot`
- `firstSeenAt`
- `firstSeenLine`
- `lastSeenAt`
- optional `firstSeenCwd`
- optional `lastSeenCwd`

The edge is not just a yes/no relation. It is also the seed for owner-local consumption.

### 4.3 Session identity

The session key remains Claude-session identity, not owner identity:

- `source = "claude"`
- `sessionId`
- `transcriptPath`

Multiple owners may attach to the same session key.

## 5. Data storage

Add a Claude ownership ledger under `.jolli/jollimemory`, separate from `sessions.json`.

Suggested shape:

```json
{
  "version": 1,
  "sessions": {
    "claude:<sessionId>": {
      "sessionId": "...",
      "transcriptPath": "...",
      "source": "claude",
      "owners": {
        "/abs/worktree/root": {
          "firstSeenAt": "...",
          "firstSeenLine": 123,
          "lastSeenAt": "...",
          "firstSeenCwd": "...",
          "lastSeenCwd": "..."
        }
      }
    }
  }
}
```

This is intentionally parallel to, not a replacement for, `sessions.json`:

- `sessions.json` remains the cheap "recent sessions seen from here" registry.
- The Claude ownership ledger is the cross-owner truth for Claude attribution.

## 6. Forward capture

### 6.1 Stop hook write path

The Claude Stop hook continues to save the lightweight `SessionInfo` row into the current worktree's `sessions.json` for compatibility and cheap local reads.

In the same turn, it also updates the Claude ownership ledger:

- resolve `projectDir` to the current worktree root
- identify the Claude session by `sessionId` and `transcriptPath`
- scan only the newly-seen transcript range
- if this owner has not appeared before, write `firstSeenAt` and `firstSeenLine`
- always update `lastSeenAt`
- update `lastSeenCwd` from the latest matching line

The update is set-union / max-progress only. A later Stop hook may extend the edge but may not reset it.

### 6.2 Determining `firstSeenLine`

`firstSeenLine` must come from transcript evidence, not from "time the hook ran". The hook already has the transcript path and already maintains discovery cursors. The ownership update should therefore use the same newly-scanned line window and record the first line within that window whose `cwd` belongs to the current worktree root.

If no such line is present in the window, the owner edge is not created on that pass.

## 7. QueueWorker read path

### 7.1 Session candidate selection

For Claude only, QueueWorker should no longer rely exclusively on `loadAllSessions(cwd)`.

Instead:

1. read Claude candidates from the ownership ledger whose `owners` map contains the current worktree root
2. merge in the current worktree's `sessions.json` entries as a fallback / recent-session fast path
3. dedupe by `(source, sessionId, transcriptPath)`

Other sources keep their current behavior in this slice.

### 7.2 Owner-specific cursor

The current cursor key, effectively `(cwd, transcriptPath)`, is not enough for shared Claude sessions. Introduce owner-specific Claude consumption state keyed by:

- `ownerRoot`
- `transcriptPath`

This may live in a new file or in an extended cursor schema, but the logical rule is:

- the first read for owner `X` starts at `firstSeenLine`
- subsequent reads for owner `X` resume from owner `X`'s own cursor
- owner `A` and owner `B` never advance one another

### 7.3 First read from a foreign owner

This is the load-bearing rule of the design:

If the current owner has no saved consumption cursor for a Claude session, the reader must start from that owner's `firstSeenLine`, not from `0`.

`beforeTimestamp` is still used as the upper bound, exactly as today. The fix only changes the lower bound.

That preserves the desired semantics:

- ownership is shared
- stored commit transcripts remain slices
- the first commit in a newly-attributed owner does not absorb all earlier transcript history

## 8. Historical repair

### 8.1 Scope

Repair is bounded and conservative. It only attempts to fix summaries where:

- `summary.transcripts` is empty
- the missing conversation's transcript still exists locally
- an ownership edge exists for the current owner
- the edge has a safe lower bound
- the commit has a safe upper bound

### 8.2 Repair algorithm

For each candidate summary:

1. find Claude sessions whose ownership ledger contains the summary's owner root
2. seed the lower bound from the owner edge's `firstSeenLine`
3. seed the upper bound from the commit capture timestamp; fall back to commit time only if nothing more precise exists
4. read the slice with the owner-specific lower bound and the commit upper bound
5. if the slice yields no entries, do not repair
6. if the slice yields entries, store a derived transcript artifact and patch `summary.transcripts`

Repair must be idempotent. A summary already repaired should not create a second transcript artifact for the same evidence window.

### 8.3 Refusal rules

Repair must refuse to act when:

- the transcript file is gone
- the current owner cannot be proven
- only whole-session evidence exists and no owner-local lower bound can be established
- no safe upper bound can be established without risking inclusion of later turns

The system should prefer a false negative over a false positive.

## 9. UI and copy

The memory detail UI should distinguish three states:

- `No conversations were captured for this memory`
- `Conversation capture is missing but repair may still be possible`
- `Conversation capture was repaired from local transcript history`

`No conversations linked yet` is misleading for a memory whose capture already failed and will never complete automatically.

## 10. Testing

### 10.1 Forward capture

- creates an ownership edge when a Claude session first touches a worktree
- extends, but does not reset, an existing edge
- allows one Claude session to attach to two worktree owners
- allows one Claude session to attach to two repository owners
- keeps `sessions.json` local behavior unchanged for the current worktree

### 10.2 Owner-specific consumption

- first read from owner A starts at A's `firstSeenLine`
- first read from owner B starts at B's `firstSeenLine`
- owner A advancing its cursor does not advance owner B
- a foreign owner with no seed never falls back to `startLine = 0`
- `beforeTimestamp` still gates the upper bound correctly

### 10.3 Repair

- repairs a `transcripts: []` summary when transcript + owner edge + upper bound all exist
- refuses repair when transcript is missing
- refuses repair when owner proof is absent
- is idempotent across repeated repair runs

### 10.4 Regression coverage

- same-worktree Claude capture still works
- linked-worktree Claude capture now works even when the session was first seen elsewhere
- dashboard/backfill attribution and QueueWorker attribution agree for the same session-owner relation

## 11. Rollout and risk

The main risk is introducing a second cursor semantics that drifts from the current QueueWorker reader contract. To limit that risk:

- keep non-Claude sources unchanged in this slice
- reuse the existing transcript readers and `beforeTimestamp` logic
- add the owner-specific lower-bound logic outside the parser, as a Claude attribution concern

The second risk is over-repairing history. That is why repair is explicitly conservative and may refuse many summaries that are missing enough evidence.

## 12. Recommendation

Implement this in two phases on one branch:

1. forward fix
   add the ownership ledger, owner-specific Claude cursoring, and QueueWorker Claude reads through the new model
2. bounded repair
   add an explicit repair path for historical empty summaries and the UI copy distinction

The forward fix is the correctness blocker. Repair is valuable, but only after new captures are trustworthy.

# 269. Push-Pending Queue and Claim-Based Drain Engine

## Topic Statement

A per-project on-disk queue of commits whose memories still need to reach the personal space, plus the shared drain engine that every sync occasion calls through one of **two entry points** — `processPushPending` (confirmation-gated, source-tagged; the post-queue and activation occasions) and `processPrePushInline` (budget-bound, no confirmation wait, called synchronously from inside the pre-push hook and scoped to only that push's commits). Both entry points share one drain core: gate on opt-out and sign-in, atomically claim each commit so concurrent processes never double-upload, skip commits whose memory does not yet exist (or has been squashed away), reconstruct cross-branch attachment ownership, upload with bounded concurrency, and record per-commit success/failure with a retry budget that distinguishes operational faults from configuration faults.

## Scope

**In scope:**

- The on-disk queue file (`push-pending.json`): its version, per-commit entry fields, the read-time stale prune, and the empty-file unlink.
- The dedicated per-worktree file lock (`push-pending.lock`) that guards every mutation, and its relationship to (but separateness from) the sync/vault lock family.
- The merge-in semantics used to enqueue commits (new-key-only, with push-target accumulation).
- The atomic claim-for-push protocol and its staleness rule that prevents double-upload across concurrent processes.
- The batched update protocol (delete vs. patch), including the always-clear-the-claim rule and error-string truncation.
- The drain engine's full ordering: load → `syncOnPush` gate → per-repo outbound-push gate → sign-in gate → eligibility (retry ceiling + optional hash filter) → push-confirmation polling → atomic claim → memory-existence and squash-child gating → cross-branch attachment ownership → bounded-concurrency upload → per-commit accounting.
- The **mid-run** re-reads of the per-repo outbound-push opt-out (per batch, per commit, and inline just before the pre-push HTTP call), the `"held"` outcome they produce, and the claim-release rule that makes a held entry re-drainable.
- The retry classification (which failures burn the retry budget and which do not) and the retry ceiling.
- The push-confirmation polling: single-pass, per-target, ancestry-aware.
- The queue-worker post-drain fire-and-forget push trigger (the `post-queue` occasion) as it originates from this engine.
- The `processPrePushInline` entry point: its budget-checked phases (triage, payload build, batch-limit partitioning, single HTTP request), its release-claims-without-burning-retry behavior on any deferral, and the per-commit outcomes (pushed / generating / deferred / merged / failed) it feeds back to the pre-push hook's result list.
- Binding-cache maintenance riding along both entry points: a successful push persists the server's Space echo (`canPush: true`); a binding/auth/permission rejection clears it.

**Boundaries (consumed here, owned elsewhere):**

- The pre-push hook that enqueues commits and calls this engine's inline entry point directly (no spawn) is owned by spec 268.
- The startup / sign-in occasion that spawns a worker calling this engine over *every* pending entry is owned by spec 270.
- The single-commit personal-space upload (article assembly, attachment dedup) and the typed error classes this engine classifies are owned by specs 94 / 231 and the push client spec.
- The summary index (roots vs. children, per-commit branch attribution) this engine reads to gate squash-children and reconstruct ownership is owned by the summary-index specs (04 / 05).
- The shared PID-plus-mtime file-lock primitive underneath `push-pending.lock` is owned by the host lock primitive; the sync/vault lock family it sits beside is owned by specs 170–172 — **not modified here**.

## Data Contracts

### Queue file `push-pending.json`

Located in the per-project state directory (`<projectDir>/.jolli/jollimemory/push-pending.json`). Shape:

```
{
  "version": 1,
  "entries": {
    "<full 40-char commit hash>": {
      "branch": "feature/x",
      "enqueuedAt": "<ISO-8601>",
      "lastAttemptAt": "<ISO-8601>"?,   // set on every attempt (success or fail)
      "retryCount": <int>,              // increments only on an operational failure
      "lastError": "<string>"?,         // truncated to 200 chars
      "pushTargets": [                  // remote refs that can confirm the push landed
        { "remote": "origin",
          "remoteRef": "refs/heads/feature/x",
          "localSha": "<full 40-char commit hash>" }
      ]?,
      "claimedAt": "<ISO-8601>"?        // set while a process is actively pushing this entry
    }
  }
}
```

- `version` must equal `1`; a file with an unexpected shape, a parse error, or a missing file is treated as **empty** (logged, never thrown) so a corrupt state file can never block the flow.
- A successful confirmation of **any** one of an entry's `pushTargets` proves the commit reached the remote.
- The file is **unlinked** whenever it would otherwise be written empty, so a repo with nothing pending has no file at all (a cheap "is anything pending?" existence check for callers).

### Read-time stale prune

On every read, entries whose anchor timestamp — `lastAttemptAt` if present, else `enqueuedAt` — is **older than 7 days** are dropped. An entry with a malformed/unparseable anchor is treated as fresh and **kept** (dropping on parse error would silently lose legitimate work). The 7-day window is long enough for offline / end-of-week catch-up yet short enough that abandoned or retry-exhausted entries eventually clear on their own. When a prune empties the file it is unlinked. A prune that changes anything is written back under the lock (re-reading inside the lock first, so a concurrent enqueue is not clobbered).

### Dedicated lock `push-pending.lock`

Every mutation of the queue file goes through a dedicated per-worktree file lock named `push-pending.lock`, kept in the same per-worktree lock directory as the other locks. It is a **sibling of, not a member of**, the sync/vault lock family (specs 170–172) — those locks are not touched by this engine. Characteristics:

- **Bounded-wait with best-effort fallback:** a short wait budget (5 s) with a tight poll interval (25 ms). If it cannot be acquired in time, the guarded work proceeds anyway (best-effort) so a write that *must* land — a pre-push enqueue, the worker's success/failure accounting — is never silently dropped.
- **Every guarded section re-reads the file inside the lock** before mutating, so a lost update is avoided even under the best-effort fallback.
- **Must not be nested.**

Three writers can legitimately race and are all serialized by this lock: the pre-push enqueue (spec 268), the drain engine's own claim / accounting, and the queue worker's post-drain follow-up (spec 34).

### Claim staleness

`claimedAt` marks that some process is actively pushing an entry. A claim is honored for **5 minutes**; past that it is treated as stale and may be reclaimed by another process, so a crashed process never locks an entry forever. The 5-minute figure is sized for the worst-case push round: the bounded upload concurrency times the per-upload timeout, plus headroom for push-confirmation polling.

### Batched update (delete vs. patch)

Per-commit accounting is applied as a batch of updates under one lock acquisition. Each update is either:

- **delete** — remove the entry (the commit is done, or it was a squash-child, or its summary raced away).
- **patch** — update `lastAttemptAt`, `retryCount`, and/or `lastError` (a null clears `lastError`; a string overwrites and is **truncated to 200 chars**; an omitted field is left unchanged).

**Every patch also clears `claimedAt`** (writes it absent), releasing the claim so any process may retry the entry. An update targeting a hash no longer present is silently ignored.

### Retry ceiling and error classification

- **Retry ceiling: 3.** An entry whose `retryCount` has reached 3 is no longer eligible and is left to age out via the 7-day stale prune.
- **Error classification** decides whether a failure counts against the budget:
  - **Configuration / environment faults** — not-authenticated, **permission-denied**, **push-disabled**, binding-required, client-outdated — record the error (a short tag) but **do not increment** `retryCount`. These require an explicit user action (or an administrator's) to fix; retrying forever would burn the budget for nothing. The full ordered set is in `classifyError` (`cli/src/core/PushExecutor.ts:129-138`); the tags are `not-authenticated` / `permission-denied` / `push-disabled` / `binding-required` / `client-outdated`.
  - **`push-disabled`** is the per-repo outbound opt-out (spec 310), tripped mid-drain by the live re-check inside the orchestrator (`PushExecutor.ts:135`). It never burns a retry for two reasons: retrying cannot succeed until the user changes the setting, and the entry must survive intact so the **re-enable** drain picks it up.
  - **Operational faults** — network, 5xx, 4xx, anything else — **increment** `retryCount` so the entry eventually gives up.

### Drain source

`processPushPending` is called with one of **two** source tags, used for logging:

- `post-queue` — the queue worker's post-drain follow-up (spec 34); confined to a hash filter.
- `activation` — the startup / sign-in compensation retry (spec 270); no hash filter.

Both occasions run strictly **after** a git push has already completed, so confirmation polling no longer varies by source (see Push-confirmation polling below). `processPrePushInline` is a separate entry point, not source-tagged: it is called exactly once, synchronously, from inside the pre-push hook (spec 268), scoped to a `priorityHashes` list (that push's own commits, in push order) plus an absolute `deadlineAt`.

### Bounded concurrency

Per-commit uploads run at a bounded concurrency of **3** — matched to the small, IO-bound uploads and comfortably under any reasonable server rate limit.

## Behavior

### Enqueue (merge-in)

Enqueuing a batch of commit hashes under a branch (with an optional push-confirmation target):

1. Re-read the file inside the lock.
2. For each hash already present: leave its retry state untouched; if a push target was supplied and is not already tracked (deduped by the `remote` + `remoteRef` + `localSha` triple), append it.
3. For each new hash: create an entry with the given branch, `enqueuedAt = now`, `retryCount = 0`, and the push target (if any) as its first tracked target.
4. Write back (or unlink if empty). Existing entries' retry state is **never** reset by an enqueue.

### Atomic claim-for-push

Given a set of candidate hashes, under the lock:

1. Re-read the file.
2. For each candidate still present: if it has a `claimedAt` younger than 5 minutes, skip it (another process owns it); otherwise stamp `claimedAt = now` and mark it claimed.
3. Write back the stamped file and return the set of hashes this process actually claimed plus a snapshot of the entries.

This is what prevents two concurrent drains from both uploading the same commit and creating duplicate personal-space articles — the loser of the race sees a fresh `claimedAt` and skips.

### Drain engine (ordered)

1. **Pre-flight load.** Load the pending file (applying the stale prune). If there are no entries, return early ("no pending entries").
2. **Opt-out gate.** If `syncOnPush` is `false`, keep all entries (re-enabling should catch up) and return without uploading. This applies to **all** sources — activation and post-queue included, not just pre-push.
3. **Per-repo outbound-push gate.** Immediately after, `isOutboundPushAllowed(cwd)` (spec 310 — the composed `manuallyDisabled` + push-control predicate) is consulted. When it says no, keep all entries — re-enabling drains them — upload nothing, and return the empty result carrying the note **`"push disabled for this repo"`**. Both entry points carry it (`cli/src/core/PushExecutor.ts:411-417` for `processPushPending`, `:1040-1042` for `processPrePushInline`), and it applies to every caller exactly like `syncOnPush`. This is the gate that stops **automatic** leaks on every surface, because git hooks are source-neutral CLI code.
4. **Sign-in gate.** If there is no personal-space API key, keep all entries (the user may sign in later) and return without marking any failure.
5. **Eligibility.** Consider only entries under the retry ceiling; if a hash filter was supplied (the `post-queue` source), consider only hashes in the filter. Count the retry-exhausted ones separately. If nothing is eligible, return.
6. **Push-confirmation polling.** `processPushPending` runs strictly after a git push has already completed (post-queue and activation are both post-push occasions), so this is now **always single-pass**: one `ls-remote` check per push target, no polling loop. For each eligible entry it checks the remote's current tip for each of the entry's push targets: a target is confirmed if the remote ref's tip **equals** the target's `localSha`, **or** the remote ref has advanced past it but the target commit is an **ancestor** of the current remote tip (a later push already carried it). The push URL for each remote is resolved once. The old per-source distinction — up to 60 attempts at 1-second intervals for a `pre-push` source — was removed along with the detached worker's main-path role (spec 268 no longer spawns it on the main path). An entry with **no** push targets is treated as already confirmed (backward compatibility for legacy entries). If nothing confirms, return ("push not confirmed") — unconfirmed entries stay pending for a later retry. (`processPrePushInline` does not run this step at all — see its own subsection below.)
7. **Atomic claim.** Claim the confirmed hashes (above). If none were claimed (all taken by a concurrent process), return.
8. **Ensure storage.** Activate a storage backend if this process has none (a freshly-spawned worker, or the pre-push hook running `processPrePushInline`, both start fresh; the queue-worker path already has one).
9. **Memory-existence and squash-child gating.** For each claimed hash:
   - If the summary index shows the commit is now a **child** of another commit (it was squashed/merged into another root after being enqueued), **delete** the entry and count it as a merged child. Pushing a child standalone would recreate it as a root — a zombie duplicating the merged root's content whose personal-space article gets orphaned on the next cleanup.
   - Else if the commit's memory does not yet exist — no summary, or only a tree-hash-fallback summary whose commit hash does not match — **patch it with an empty patch** and count it as "no memory yet." The empty patch is **load-bearing**: because every patch clears `claimedAt`, this releases the claim so the queue worker's post-drain trigger can pick the entry up once the real summary lands. Without the release, the post-drain trigger would hit the still-fresh claim and skip — defeating the whole "push arrived before memory" compensation path.
   - Else the commit has memory and proceeds to upload.

   Apply these pre-flight deletes/patches as one batch. If nothing has memory, return.
10. **Cross-branch attachment ownership.** Reconstruct, per branch, which commit owns which plans / notes / references, so each pending commit uploads exactly the attachments it owns even when the user has since checked out a different branch:
   - For the **current** branch, load its summaries from the default-branch merge base to HEAD.
   - For **off-current** branches, reconstruct their context from the branch's **root** summaries (index entries with no parent) plus the pending commits themselves.
   - Within each branch context, sort summaries oldest-first and compute owned attachments, then map them back per commit hash.
11. **Bounded-concurrency upload.** Upload the with-memory commits at concurrency 3. For each: re-read the summary *immediately before* the network call (so a concurrent rewrite/cleanup cannot make it publish a stale summary); if it raced away or resolved to another commit's summary, delete the entry and record a failure. Otherwise upload the summary with its owned attachments; on success **delete** the entry; on failure classify the error and **patch** the entry (stamp `lastAttemptAt`, record the error tag, increment `retryCount` only for operational faults).
12. **Accounting.** Apply the upload results as one batch and return counts (attempted, pushed, failed, skipped-no-memory, skipped-retry-exhausted, deleted-children).

### Mid-run holds on the per-repo outbound opt-out

The entry gate (step 3) is checked **once**, which is what makes a disabled repo cheap to refuse — but a drain is a loop of network calls that can run for many seconds, and spec 310 requires the flag be read **live**. So the opt-out is re-read at three further points, and every one of them produces a distinct non-outcome called **held**: no attempt recorded, no `lastError`, no retry burned — the entry must end up *indistinguishable from one this drain never reached*.

| Re-read | Where | What happens |
|---|---|---|
| **Per batch** | `cli/src/core/PushExecutor.ts:619-640` (`processPushPending`) | Before each batch request. Every still-unattempted entry from this group onward is collected, its claim released into the run's existing `updateBatch` write, and the batch loop `break`s. |
| **Per commit** | `:828-833` (the individual-push fallback) | Before each commit's upload. The claim is released and the commit returns `"held"`. |
| **From the orchestrator** | `:860-864` | The orchestrator's own per-attachment live re-check (spec 310) can trip *between* attachments, after the per-commit gate passed. A `PushDisabledError` caught there is likewise converted to `"held"` with the claim released — deliberately **not** routed through `classifyError`, so nothing is recorded at all. |
| **Inline, pre-HTTP** | `:1291-1306` (`processPrePushInline`) | The inline entry gate ran at the top of the call, but summary reads and batch payload building sit in between. A toggle in that window releases the claims for the whole batch, defers them with the reason `outbound push disabled for this repo`, and returns the result with the note `"push disabled for this repo"`. Mirrors the `BatchUnsupportedError` path. |

**Releasing the claim is the load-bearing half.** "Leave the entry exactly as claimed" is the wrong instinct and was the original bug: the re-enable drain (spec 270's fourth occasion) is a *single detached pass* with no retry of its own, `claimForPush` honours a claim for `CLAIM_STALE_MS` (5 min), so entries the user just re-enabled would be skipped as "claimed by another process" and wait for an unrelated later trigger. The hold path therefore **writes to the pending store precisely in order to look untouched** — an empty patch, which clears `claimedAt` by the always-clear rule above.

### Queue-worker post-drain trigger (the `post-queue` occasion)

After the queue worker generates new summaries, it hands their hashes to this engine as a **fire-and-forget** call on the next tick, tagged `post-queue` with those hashes as the filter. It is deliberately not awaited: a slow or offline upload must never extend the worker's lock hold or delay its ingest phase; a failure is swallowed to a debug log and the entries survive for the next occasion. (Owned by spec 34; originates in this engine.)

### The inline entry point (`processPrePushInline`)

Called synchronously, once per push, from inside the pre-push hook (spec 268). Scoped to `priorityHashes` (that push's own commits, in push order) and an absolute `deadlineAt`. Diverges from `processPushPending` in exactly two ways — no push-confirmation wait, and a hard wall-clock deadline — otherwise it reuses the same building blocks (atomic claim, retry-ceiling eligibility, squash-child/no-memory triage, cross-branch attachment ownership reconstruction, and the batch upload endpoint):

- **No push-confirmation wait.** Optimistic: the hook runs before git transfers objects, so waiting for the remote to confirm would deadlock.
- **At most one HTTP request.** Eligible commits are packed into a single batch call, capped by item count and total content size; an item that does not fit is deferred, not attempted. An unsupported server (no batch endpoint) just defers everything.
- **A hard wall-clock deadline** is checked before triage, before payload build, and before the HTTP call. Once the remaining budget can't cover even the minimum useful HTTP window, remaining candidates are deferred rather than attempted.
- **Every deferral releases the claim** (an empty patch), so the next occasion (`post-queue` or `activation`) picks the entry up immediately — a deadline/limit deferral never burns retry budget.
- **One outcome per considered commit**, in push order: `pushed` (with URL), `generating`, `deferred`, `merged`, or `failed` (each with a short reason) — this is exactly the set the pre-push hook renders as its result list.

### Binding-cache maintenance

Both entry points maintain the local Space-binding cache as a side effect of pushing, at no extra request cost:

- A successful batch/summary push whose response echoes the server's resolved Space (`jmSpace {id, name}`) is persisted as a confirmed healthy (`canPush: true`) binding.
- A rejection classified `binding-required` / `not-authenticated` / `permission-denied` clears the cache.
- Older servers that echo nothing leave the cache untouched.

## State Transitions

### A queue entry

| From | Action | To |
| ---- | ------ | -- |
| absent | enqueued (new hash) | present, `retryCount 0`, unclaimed |
| present | enqueued again (same hash) | unchanged retry state; push target appended if new |
| present, unclaimed / stale-claimed | claim-for-push | present, `claimedAt` = now |
| claimed | upload succeeds | deleted |
| claimed | operational failure | patched: `retryCount+1`, error recorded, claim cleared |
| claimed | configuration failure | patched: error recorded, `retryCount` unchanged, claim cleared |
| claimed | commit now a squash-child | deleted (merged child) |
| claimed | memory not generated yet | empty-patch (claim cleared), left pending |
| claimed | budget/limit deferral (`processPrePushInline` only) | empty-patch (claim cleared), left pending, `retryCount` unchanged |
| claimed | outbound push disabled mid-run (per-batch / per-commit / orchestrator / inline pre-HTTP) | **held** — empty-patch (claim cleared), left pending, no `lastError`, `retryCount` unchanged |
| present | `retryCount` reaches 3 | ineligible; ages out via 7-day prune |
| present | anchor older than 7 days | pruned on next read |
| last entry removed | any delete/prune | file unlinked |

### A drain run (short-circuits, in order)

`no pending entries` → `syncOnPush disabled` → `push disabled for this repo` → `not signed in` → `no eligible entries` → `push not confirmed` → `all entries claimed by another process` → `no candidates with memory` (or `all candidates were merged children`) → upload proceeds (and may still stop mid-run on a `push disabled for this repo` hold).

## Notable Behavior

- **Two entry points share one drain core but diverge on confirmation and budget.** `processPushPending` always waits for single-pass confirmation and has no wall-clock ceiling; `processPrePushInline` never waits for confirmation and is hard-capped by the pre-push hook's budget. (Notable; architecture change.)
- **`pre-push` is no longer a valid drain source.** It was retired along with the detached worker's main-path role (spec 268); the only two `processPushPending` sources are now `post-queue` and `activation`. (Notable.)
- **`processPushPending` still confirms, but only ever needs a single check.** Both of its occasions (`post-queue`, `activation`) run strictly after a git push has already completed, so a single-pass `ls-remote` check (by equality or ancestry) is enough to guard against publishing for a push that was rejected — there is no longer a race to poll for. `processPrePushInline` runs *before* objects transfer and deliberately skips confirmation entirely (see its own subsection); optimism there is the trade-off for running synchronously inside the hook. (Notable; architecture change.)
- **The empty patch is a claim-release trick.** Patching a no-memory-yet entry with *no field changes* still clears its `claimedAt`, which is precisely the point — it hands the entry back so the post-drain trigger can retry it once the summary is generated. (Surprising; load-bearing.)
- **Squash-children are deleted, not pushed.** A commit that has become a child in the index after enqueue would, if pushed standalone, be recreated as a root zombie duplicating the merged root. Deleting the pending entry is the safe outcome. (Surprising; intentional.)
- **Configuration failures do not burn the retry budget.** Not-authenticated / permission-denied / push-disabled / binding-required / client-outdated need a user (or administrator) action, so they record the error but leave `retryCount` alone; only operational faults count toward the ceiling of 3. (Notable.)
- **A push-disabled hold is quieter than a configuration failure — it records nothing at all.** The five non-incrementing categories still write a `lastError` tag. A **mid-run** hold on the outbound opt-out does not even do that: it writes an empty patch whose only effect is clearing the claim, so the entry is byte-for-byte as if this drain had never reached it. The distinction matters because the re-enable drain is a single detached pass; an entry left claimed (or carrying a fresh `lastError`) would look attended-to and be skipped. (Surprising; the hold path writes to the store in order to look untouched.)
- **The per-repo gate is where automatic leaks are stopped for every surface.** Git hooks are source-neutral CLI code and always run these two entry points, so a push-disabled repository never auto-syncs regardless of which editor is installed. The editors' own gates only cover their manual push actions. (Notable; central design point — spec 310.)
- **The dedicated lock is separate from the sync/vault lock family.** `push-pending.lock` sits beside the sync and vault locks (specs 170–172) but is its own file; nothing here touches those locks. (Notable.)
- **A missing/corrupt/empty file is always treated as "nothing pending," never as an error.** The file's absence is the normal state between pushes, and any parse/shape problem degrades to empty so it can never block the push flow. (Notable.)
- **Cross-branch reconstruction lets memories sync from the "wrong" branch.** Because a user often checks out another branch before the worker runs, off-current branches are rebuilt from their index roots so each pending commit still uploads exactly the attachments it owns. (Notable.)
- **Best-effort lock means writes still land under contention.** If the dedicated lock can't be acquired within the budget, the guarded read-modify-write proceeds anyway (with an in-lock re-read), because losing a pre-push enqueue or a success/failure record would be worse than a rare racy write. (Surprising; intentional.)

## Shared Behavior

- The pre-push hook that enqueues commits and calls this engine's inline entry point directly (no spawn) is owned by spec 268.
- The startup / sign-in / **re-enable** retry over every pending entry, which spawns a detached worker to reach this engine, is owned by spec 270; the queue-worker post-drain trigger is owned by spec 34.
- The per-repo outbound opt-out this engine gates on (its store, its predicate, and the live-read requirement behind the mid-run re-reads) is owned by spec 310.
- The single-commit upload contract, attachment dedup, and the typed error classes classified here are owned by specs 94 / 231 and the push client spec.
- The summary index (roots vs. children, per-commit branch) read for squash-child gating and ownership reconstruction is owned by specs 04 / 05.
- The shared PID-plus-mtime file-lock primitive underneath `push-pending.lock` is inherited from the host lock primitive; the neighboring sync/vault lock family is owned by specs 170–172.

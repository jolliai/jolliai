# 269. Push-Pending Queue and Claim-Based Drain Engine

## Topic Statement

A per-project on-disk queue of commits whose memories still need to reach the personal space, plus the one drain engine every sync occasion calls through: gate on the opt-outs and sign-in, atomically claim each commit so concurrent processes never double-publish, skip commits whose memory does not exist yet (or has been squashed away), reconstruct cross-branch attachment ownership, upload one commit at a time under bounded concurrency while a heartbeat keeps the claims alive, and record each commit's accounting the moment it settles.

## Scope

**In scope:**

- The queue file: its version, per-commit entry fields, the read-time stale prune, and the empty-file unlink.
- The dedicated per-worktree file lock that guards every mutation, its bounded wait, and its best-effort fallback.
- The merge-in semantics used to enqueue commits (new-key-only, with push-target accumulation).
- The atomic claim-for-push protocol, its staleness rule, and the compare-and-swap claim-renewal heartbeat that keeps a long run's claims alive.
- The update protocol (delete vs. patch), including the always-clear-the-claim rule and error-string truncation.
- The drain's full ordering, and every option a caller can vary: a hash filter, skipping the remote-confirmation gate, skipping orphan deletion, a start-gate deadline, a per-commit settled callback, and an overridden push client.
- The retry classification (which failures burn the retry budget and which do not) and the retry ceiling.
- The single-pass, per-target, ancestry-aware push-confirmation check, and the caller that skips it.
- The two mid-run re-reads of the per-repo outbound-push opt-out, the `held` outcome they produce, and the claim-release rule that makes a held entry immediately re-drainable.
- The start-gate deferral, which defers without burning a retry.
- The per-commit outcome record (status, article URL, reason) the engine emits as each commit settles, on every return path including the early ones.
- Carrying forward an article id minted by a push whose local write-back failed, so a retry updates rather than duplicates; and keeping (rather than deleting) an entry whose orphan cleanup is still outstanding.
- Binding-cache maintenance riding along a successful push.
- The queue-drain occasion's fire-and-forget follow-up trigger, as it originates in this engine.

**Boundaries (consumed here, owned elsewhere):**

- The git pre-push hook that records this push's commits and watches a detached worker is defined by the Git Pre-Push Hook topic.
- The detached worker itself — its two modes, its runtime ceiling, its unfiltered confirmed tail pass — and the activation / sign-in / re-enable trigger that also launches it are defined by the Push-Pending Compensation Retry topic.
- The file-based request/result/liveness handoff between that hook and that worker is defined by the Pre-Push Worker Result Handoff topic.
- The single-commit personal-space upload (article assembly, per-kind attachment loop, orphan cleanup, the typed error taxonomy this engine classifies) is defined by the summary-push and context-push topics.
- The summary index (roots vs. children, per-commit branch attribution) read for squash-child gating and ownership reconstruction is defined by the summary-index topics.
- The per-repo outbound-push opt-out, its store, and its live-read requirement are defined by the Per-Repo Outbound-Push Control topic.
- The shared process-id-plus-mtime file-lock primitive underneath the queue lock is defined by the lock-primitive topic.

## Data Contracts

### The queue file

A JSON file in the per-project state directory, holding a schema version (currently `1`) and a map from full 40-character commit hash to an entry:

- **branch** — the branch the commit was recorded under.
- **enqueuedAt** — ISO-8601 timestamp of first record.
- **lastAttemptAt** — ISO-8601, set on every attempt (success or failure). Optional.
- **retryCount** — integer; increments only on an operational failure.
- **lastError** — short failure tag or message, truncated to 200 characters (the 200th character becomes an ellipsis). Optional.
- **pushedDocId** / **pushedUrl** — the article id and URL minted by a push whose local write-back failed, so the next attempt updates that article instead of creating a duplicate. Optional, and always written together.
- **pushTargets** — a list of `{remote, remoteRef, localSha}` triples; confirming **any one** of them proves the commit reached the remote. Optional.
- **claimedAt** — ISO-8601, present only while some process is actively pushing this entry.

A file with an unexpected shape, a parse error, or no file at all is treated as **empty** — logged, never thrown — so a corrupt state file can never block a push. The file is **unlinked** whenever it would otherwise be written empty, which makes mere existence a cheap "is anything pending?" check for callers.

### Read-time stale prune

On every read, an entry whose anchor timestamp — `lastAttemptAt` if present, else `enqueuedAt` — is older than **7 days** is dropped. An entry whose anchor does not parse is treated as fresh and **kept** (dropping on a parse error would silently lose legitimate work). A prune that changes anything is written back under the lock, re-reading inside the lock first so a concurrent enqueue is not clobbered; the read path takes the lock **only** when a prune is actually needed, keeping the common read lock-free. When a prune empties the file it is unlinked.

Retry-exhausted entries rely on this window to clear: nothing else deletes them.

### The queue lock

Every mutation goes through a dedicated per-worktree lock file, a sibling of (not a member of) the sync/vault lock family.

- **Bounded wait with best-effort fallback:** a 5-second budget polled every 25 ms. If the lock cannot be acquired in time, the guarded work proceeds anyway (with a warning), because losing a pre-push record or a success/failure entry would be worse than a rare racy write.
- **Every guarded section re-reads the file inside the lock** before mutating, so a lost update is avoided even under the fallback.

Several writers legitimately race and are all serialized here: the pre-push record, the drain's own claim/renewal/accounting writes, and the queue-drain follow-up.

### Claims, staleness, and the renewal token

`claimedAt` marks that some process is actively pushing an entry. A claim is honored for **5 minutes**; past that it is stale and may be taken over, so a crashed process never locks an entry forever.

`claimedAt` is a **bare timestamp with no holder identity**, so the exact value stamped by a claim doubles as that drain's ownership token. Renewal is therefore a **compare-and-swap**, not a freshness check: an entry is re-stamped only when its current `claimedAt` is byte-identical to the token the renewing drain holds. A freshness check would happily renew a claim another process had already taken over after this one stalled past the window, putting two processes back on the same commit.

The renewal interval is one third of the claim window (**100 seconds**), derived from it deliberately: at one third, a single missed beat still renews at two thirds of the window, where a half-window interval would put the retry exactly on the expiry boundary.

### Update protocol

Each update is either:

- **delete** — remove the entry (published, or a squash child, or its summary raced away).
- **patch** — set any of `lastAttemptAt`, `retryCount`, `lastError`, `pushedDocId`, `pushedUrl`. A null `lastError` clears the field; a string overwrites and is truncated; an omitted field is left unchanged.

**Every patch also clears `claimedAt`**, written as explicitly absent rather than merely omitted, releasing the claim so any process may retry the entry. An update naming a hash no longer present is silently ignored. Updates are applied under one lock acquisition, and a single-entry write takes the same lock as a multi-entry one, so a drain that commits each commit's accounting individually stays ordering-safe against concurrent tasks.

### Retry ceiling and error classification

- **Retry ceiling: 3.** An entry at the ceiling is no longer eligible and is left to age out via the 7-day prune.
- **Configuration / environment faults** record a short tag but **do not** increment the retry count, because retrying cannot succeed until a user (or an administrator) acts. The tags are: not-authenticated, permission-denied, push-disabled, binding-required, client-outdated.
- **Operational faults** — network, 5xx, 4xx, anything else — record the error text and **increment** the retry count so the entry eventually gives up.

### Drain sources and options

The engine takes one source tag, used **only** for logging — but that logging matters, because all callers share one function and one of them runs detached with no standard output, so the local debug log is the only way to tell which drain produced a line. The tags name the queue-drain follow-up, the activation/compensation drain, and the pre-push worker.

Six behaviors are caller-selectable:

- **Hash filter** — consider only these hashes. Used by the queue-drain follow-up (the summaries it just generated) and by the pre-push worker (this push's commits).
- **Skip push confirmation** — set only by the pre-push worker, because git calls the hook before transferring objects, so no remote ref has moved and every candidate would be refused.
- **Skip orphan cleanup** — set together with the above and for the same reason: deleting a remote article before git confirms the push can leave remote history intact with its memories gone and no pending entry left to restore them.
- **Start-gate deadline** — an epoch time after which no **new** commit push is started. Deliberately a start gate rather than a cancellation.
- **Per-commit settled callback** — invoked as each commit reaches a terminal state, so a detached caller can publish partial progress. Called from concurrent tasks, so it is expected to be synchronous and cheap.
- **Push client override** — a seam that also lets the detached worker raise its request timeout above the default.

### Per-commit outcome

Each settled commit produces a record carrying the hash, a status, an article URL (set only for a published commit), and a short human-readable reason (set for every other status). The statuses are:

- **pushed** — published this run.
- **generating** — no memory exists for the commit yet.
- **deferred** — eligible but held back (claimed elsewhere, run-time limit reached, or the outbound opt-out tripped mid-run).
- **merged** — the commit became a squash/merge child after being recorded.
- **failed** — retry budget exhausted, the summary changed mid-push, or an upload error.

These records are also mirrored into the engine's own result **on every return path, including the early short-circuits**, whenever a settled callback was supplied.

### Bounded concurrency

Per-commit uploads run at a bounded concurrency of **3**, matched to the small, IO-bound uploads and comfortably under any reasonable server rate limit.

## Behavior

### Enqueue (merge-in)

Recording a batch of commit hashes under a branch, with an optional confirmation target, under the lock:

1. Re-read the file inside the lock.
2. For a hash already present: leave its retry state untouched; if a target was supplied and is not already tracked (deduped on the full remote / remote-ref / local-sha triple), append it.
3. For a new hash: create an entry with the branch, the current time as `enqueuedAt`, a zero retry count, and the supplied target as its first tracked target.
4. Write back, or unlink if the result is empty. Existing entries' retry state is **never** reset by a record.

### Atomic claim-for-push

Given a set of candidate hashes, under the lock: re-read; for each candidate still present, skip it when it carries a `claimedAt` younger than the claim window (another process owns it), otherwise stamp the current time and mark it claimed; write back and return the claimed set, a snapshot of the entries **as they were before the stamp**, and the exact stamp used as the ownership token.

This is what prevents two concurrent drains from both publishing the same commit and creating duplicate articles — the loser sees a fresh claim and skips.

### Drain, in execution order

1. **Pre-flight load** (unlocked, cheap). If there are no entries, return with the note *no pending entries*.
2. **Sync-on-push opt-out gate.** When the sync-on-push setting is explicitly off, keep every entry (re-enabling should catch up), upload nothing, and return with the note *syncOnPush disabled*. This applies to **every** caller.
3. **Per-repo outbound-push gate.** When outbound push is not allowed for this repo, keep every entry, upload nothing, and return with the note *push disabled for this repo*. Also applies to every caller.
4. **Sign-in gate.** With no personal-space credential there is nowhere to publish: keep every entry (the user may sign in later), record no failure, and return with the note *not signed in*.
5. **Eligibility.** Consider only entries under the retry ceiling, and only hashes in the filter when one was supplied. An entry at the ceiling is counted separately and **immediately emits a `failed` outcome** with the reason "failed repeatedly — giving up", so a caller listing every commit of a push never leaves it unexplained. If nothing is eligible, return with the note *no eligible entries*.
6. **Push confirmation** (skipped by the pre-push worker). Resolve each distinct remote's push URL once, then check every distinct target **in one pass**: a target is confirmed when the remote ref's tip equals the target's local sha, **or** the remote ref has advanced past it and the target commit is an ancestor of the current remote tip (a later push already carried it). An entry is confirmed when any of its targets is; an entry with **no** targets is treated as confirmed, for backward compatibility with entries recorded before targets existed. A single pass suffices because every caller that keeps this gate runs strictly after a git push has already completed — there is nothing left to poll for. If nothing confirms, return with the note *push not confirmed*; unconfirmed entries stay pending.
7. **Atomic claim** over the confirmed set. Each hash **not** won emits a `deferred` outcome with the reason "another sync is already handling this commit" rather than being silently dropped. If nothing was claimed, return with the note *all entries claimed by another process*.
8. **Ensure storage.** Activate a storage backend if this process has none (a freshly-spawned worker starts fresh; the queue-drain path already has one).
9. **Triage.** For each claimed hash:
   - The commit is now a **child** of another commit in the summary index (it was squashed or merged into another root after being recorded) → **delete** the entry, count it as a merged child, emit `merged` with the reason "merged into another commit's memory". Publishing a child standalone would recreate it as a root — a zombie duplicating the merged root's content whose article is orphaned on the next cleanup pass.
   - The commit's memory does not exist yet — no summary at all, or a tree-hash-fallback summary whose recorded commit hash does not match — → **patch it with an empty patch**, count it as no-memory-yet, emit `generating` with the reason "memory still generating — will sync later". Rejecting the tree-hash fallback is what stops a squash-plus-push racing the merge worker and publishing a stale pre-squash summary.
   - Otherwise the commit has memory; its summary is kept for the upload, with any previously-minted article id grafted on (see below).

   These deletes and patches are applied as one update batch. If nothing has memory, return with the note *all candidates were merged children* when every skip was a merged child and none lacked memory, else *no candidates with memory*.
10. **Cross-branch attachment ownership.** Reconstruct, per branch, which commit owns which pushable-context items, so each pending commit publishes exactly what it owns even when the user has since checked out a different branch. For the **current** branch, load its summaries from the default-branch merge base to HEAD. For **off-current** branches, rebuild context from the index's root entries for those branches (fetching each root's summary, and only when the summary's own recorded hash matches). The pending commits' own summaries are layered on top. Within each branch context, summaries are sorted oldest-first by generation time and ownership is computed per registered context kind, then merged into one kind-keyed map.
11. **Upload**, at concurrency 3, with a claim-renewal heartbeat running for the duration (see below).
12. **Return** counts: attempted, published, failed, skipped-for-no-memory, skipped-for-retry-exhaustion, deleted children — plus the settled outcome list when a callback was supplied.

### Per-commit upload

For each commit, in flight up to the concurrency limit:

1. **Start gate.** When a start-gate deadline was supplied and has passed, patch the entry with an empty patch (releasing the claim), emit `deferred` with the reason "run time limit reached — will sync later", and report the commit as **held**. Checked before anything else so a commit that never started leaves no trace at all — no attempt, no error, no retry burned. Commits already in flight are untouched.
2. **Live outbound-push re-read.** When the repo's outbound push is no longer allowed, patch with an empty patch, emit `deferred` with the reason "outbound push disabled for this repo", and report **held**.
3. **Stale-summary guard.** Re-read the summary immediately before the network call. If it is gone, or resolved to another commit's summary, **delete** the entry, emit `failed` with the reason "summary changed mid-push", and count a failure.
4. **Publish** the summary with exactly the items it owns for **every** registered context kind — never a hand-built list of the three legacy kinds, which would silently publish zero of every other kind.
5. **Settle**, immediately, as one of:
   - **Write-back failed** — the article exists server-side but its id never reached local storage: patch the entry with the attempt time, an explanatory error string, and the minted article id and URL, so the next drain updates that article. The retry count is left alone: the push succeeded, only the bookkeeping needs another go.
   - **Cleanup still pending** — orphaned articles remain to be deleted (either because orphan deletion was skipped, or because a cleanup pass could not delete every id): patch (empty), so the entry **survives** for a later confirmed drain. Deleting it would strand those articles with nothing pointing at them.
   - **Clean success** — delete the entry.

   All three emit `pushed`, carrying the article URL when there is one, and count a success.
6. **On error:**
   - A **push-disabled refusal** raised by the upload path's own per-send re-read (which can trip *between* attachments, after step 2 passed) is converted to **held**: patch with an empty patch, emit `deferred` with the reason "outbound push disabled for this repo", record nothing at all. It is deliberately **not** routed through the failure classifier.
   - Otherwise classify the error. A binding-required, not-authenticated, or permission-denied rejection additionally **clears the local Space-binding cache**, since the server has just contradicted it. Then patch the entry with a **freshly stamped** attempt time (stamped per failure, not once per run: at commit granularity a drain routinely runs for minutes, so a shared timestamp would misdate late failures by the whole run length), the classified message, and an incremented retry count only for operational faults. Emit `failed` with a short user-facing reason, and count a failure.

Every one of those writes is committed **as the commit settles**, not buffered into one batch at the end. That is load-bearing: a drain routinely outlives the claim window, so buffering the ledger would mean a mid-run crash replays commits that already published, creating duplicate articles. A bookkeeping write that itself fails is logged and swallowed — the push already happened, and the entry stays claimed so a later drain re-reads the stored article id and updates rather than duplicates. The one case that loses the id is a write-back-failed patch failing here, since that patch **is** the backup copy of an id the local summary never received; two consecutive local write failures producing a duplicate article is the accepted floor.

Held commits are counted as neither published nor failed.

### Claim-renewal heartbeat

For the duration of the upload phase, a timer fires at the renewal interval and re-stamps every commit still in flight, comparing against the token this drain holds. The returned new stamp becomes the token for the next beat; when nothing matched — every commit is finished, gone, or now held by someone else — the **old** token is kept, so a later beat cannot resurrect a claim this drain no longer owns. A renewal failure is logged at debug and retried on the next beat. The timer does not keep the process alive, and is cleared when the upload phase ends.

### Recovered article id

Before uploading, a summary that carries no article id of its own adopts the id and URL recorded on its pending entry by an earlier push whose local write-back failed. The tenant gate stays downstream: the upload only reuses the id when the grafted URL passes it.

### Short user-facing failure reasons

The five configuration tags render as fixed sentences ("not signed in to Jolli", "no permission to write to the bound Jolli Space", "repo is not bound to a Jolli Space", "Jolli client is outdated — please update"; the push-disabled tag never reaches this path because that condition is reported as held). Any other message is whitespace-collapsed and truncated to 60 characters, the 60th becoming an ellipsis.

### Binding-cache maintenance

Riding along at no extra request cost: a successful push whose response echoes the server's resolved Space persists that Space locally as a confirmed, push-capable binding (last write wins across concurrent tasks, which is safe because they all observe the same binding). A binding-required / not-authenticated / permission-denied rejection clears the cache. A server that echoes nothing leaves it untouched. A cache hiccup is logged at debug and never fails a completed run.

### Queue-drain follow-up trigger

After new summaries are generated, their hashes are handed to this engine as a **fire-and-forget** call scheduled on the next tick, filtered to those hashes. It is deliberately not awaited: a slow or offline upload must never extend the generating worker's lock hold or delay its ingest phase. A failure is swallowed to the debug log and the entries survive for the next occasion. An empty hash list is a no-op.

## State Transitions

### A queue entry

| From | Action | To |
| ---- | ------ | -- |
| absent | recorded (new hash) | present, zero retries, unclaimed |
| present | recorded again (same hash) | retry state unchanged; confirmation target appended if new |
| present, unclaimed or stale-claimed | claim-for-push | claimed with a fresh stamp |
| claimed, mid-flight | heartbeat beat matching this drain's token | re-stamped; token advances |
| claimed, mid-flight | heartbeat beat matching nothing | untouched; drain keeps its old token |
| claimed | upload succeeds cleanly | deleted |
| claimed | upload succeeds, orphan cleanup outstanding | empty patch (claim cleared), left pending |
| claimed | upload succeeds, local write-back failed | patched with attempt time, an explanatory error, and the minted article id/URL; retry count unchanged |
| claimed | operational failure | patched: retry count +1, error recorded, claim cleared |
| claimed | configuration failure | patched: error recorded, retry count unchanged, claim cleared |
| claimed | commit is now a squash child | deleted |
| claimed | memory not generated yet | empty patch (claim cleared), left pending |
| claimed | summary raced away or resolved elsewhere | deleted, counted as a failure |
| claimed | start-gate deadline already passed | **held** — empty patch, left pending, nothing recorded |
| claimed | outbound push disabled mid-run (per-commit re-read, or the upload path's own re-check) | **held** — empty patch, left pending, no error, retry count unchanged |
| present | retry count reaches 3 | ineligible; ages out via the 7-day prune |
| present | anchor older than 7 days | pruned on next read |
| last entry removed | any delete or prune | file unlinked |

### A drain run (short-circuits, in order)

*no pending entries* → *syncOnPush disabled* → *push disabled for this repo* → *not signed in* → *no eligible entries* → *push not confirmed* → *all entries claimed by another process* → *no candidates with memory* / *all candidates were merged children* → upload proceeds (and may still hold individual commits mid-run).

## Notable Behavior

- **Every commit is its own request group.** The batch endpoint this engine used to prefer was removed: its payload cap sat above a typical gateway's body limit, and the resulting refusal was indistinguishable from an ordinary transient failure — it burned all three retries and then aged out silently, so the user simply saw memories never arrive. A per-commit request keeps the body proportional to one commit and lets a settled commit be reported the moment it lands, instead of all-or-nothing per batch. (Notable; architecture change.)
- **The empty patch is a claim-release trick.** Patching an entry with *no* field changes still clears its claim, which is precisely the point — every "we are not doing this one" path hands the entry straight back so the next occasion can take it. Without the release, the follow-up trigger would hit a still-fresh claim and skip, defeating the whole "the push arrived before the memory" compensation path. (Surprising; load-bearing.)
- **A held commit writes to the store in order to look untouched.** The five configuration failures still record an error tag. A mid-run hold records nothing at all — the entry ends up byte-for-byte as if this drain had never reached it, *including* being re-claimable. That matters because the re-enable drain is a single detached pass with no retry of its own: an entry left claimed would be skipped as "claimed by another process" for the full claim window and wait for an unrelated later trigger. "Leave the entry exactly as claimed" is the wrong instinct here. (Surprising; intentional.)
- **The claim token is a timestamp, so renewal must be an exact-match swap.** A claim someone else took over looks identical to this drain's own, so a "is it still fresh?" renewal would happily refresh *their* claim after this process stalled past the window — putting both processes on the same commit, both reading a summary with no article id, both creating an article. (Surprising; the reason renewal is a compare-and-swap.)
- **The run ceiling gates starts, never cancels.** Aborting a request in flight throws away an article id the server may already have minted, and the retry would then create a duplicate — the exact failure this whole per-commit path exists to avoid. So the ceiling stops the drain from *starting* more work and leaves the rest pending. (Notable.)
- **Squash children are deleted, not published.** A commit that has become a child in the index after being recorded would, if published standalone, be recreated as a root zombie duplicating the merged root. Deleting the pending entry is the safe outcome. (Surprising; intentional.)
- **An entry whose orphan cleanup is outstanding survives a *successful* push.** It is patched rather than deleted, because deleting it would strand the articles awaiting deletion with nothing left pointing at them — and only a confirmed drain may delete remote articles at all. (Surprising; a success that does not clear the entry.)
- **A write-back failure is recorded as a success that needs bookkeeping, not as a failure.** The retry count is untouched and the minted article id is copied onto the pending entry, so the next drain updates the same article. (Notable.)
- **Configuration failures do not burn the retry budget.** Not-authenticated, permission-denied, push-disabled, binding-required and client-outdated need a user or administrator action, so they record the tag and leave the retry count alone; only operational faults count toward the ceiling of 3. (Notable.)
- **Accounting is committed per commit, not per run.** A drain at commit granularity routinely runs longer than the claim window, so a buffered ledger would let a mid-run crash replay commits that already published. The per-failure timestamp follows from the same fact. (Notable; load-bearing.)
- **A hash the drain decides against still gets an outcome.** Retry-exhausted, lost-the-claim, merged, no-memory-yet, held and deferred all emit a per-commit record, and those records are attached to **every** return path including the earliest short-circuits — because the caller that renders them lists every commit of the push, and an unreported hash would be shown as still running long after this drain exited. (Notable.)
- **Cross-branch reconstruction lets memories publish from the "wrong" branch.** Users routinely check out another branch before the drain runs, so off-current branches are rebuilt from their index roots and each pending commit still publishes exactly what it owns. (Notable.)
- **A missing, corrupt or empty queue file is always "nothing pending", never an error.** Absence is the normal state between pushes, and any parse or shape problem degrades to empty so it can never block the push flow. (Notable.)
- **Best-effort locking means writes still land under contention.** If the queue lock cannot be acquired within its budget, the guarded read-modify-write proceeds anyway (still re-reading first), because losing a pre-push record or a success/failure record would be worse than a rare racy write. (Surprising; intentional.)
- **The confirmation check is single-pass by construction, and one caller skips it entirely.** Every caller that keeps it runs after git has finished transferring, so there is nothing to poll for. The pre-push worker runs before objects transfer, where the gate would refuse everything, so it skips both the confirmation and the orphan deletion that only a confirmed drain may do. (Notable.)
- **The source tag is logging only — and that is why it exists.** All callers share one function and one of them is detached with no standard output, so the local debug log is the only way to attribute a line to a drain. (Notable.)

## Shared Behavior

- The pre-push hook that records this push's commits, and the detached worker that drains them (its modes, ceilings and tail pass), are defined by the Git Pre-Push Hook and Push-Pending Compensation Retry topics; the file handoff between them is defined by the Pre-Push Worker Result Handoff topic.
- The per-repo outbound-push opt-out gated here (its store, its identity keying, and the live-read rule behind the mid-run re-reads) is defined by the Per-Repo Outbound-Push Control topic.
- The single-commit upload contract — per-kind attachment loop, article-id reuse gate, orphan cleanup, write-back — and the typed error classes classified here are defined by the summary-push and context-push topics.
- The classifier that decides which push failures are repo-wide (and therefore abort a loop rather than being collected per item) is defined by the Repo-Wide Push-Refusal Classification topic.
- The summary index read for squash-child gating and ownership reconstruction is defined by the summary-index topics.
- The shared file-lock primitive underneath the queue lock is defined by the lock-primitive topic.

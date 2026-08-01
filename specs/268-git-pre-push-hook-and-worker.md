# 268. Git Pre-Push Hook and Detached Sync Worker

## Topic Statement

A git pre-push hook that, before objects are transferred to a remote, parses the pushed refs, records the commits being pushed into the push-pending queue, then — when signed in and not opted out — synchronously pushes the batch-eligible ones straight to the bound Jolli Space within a small fixed wall-clock budget, before letting the push proceed. Publishing is optimistic: it never waits for remote confirmation, since waiting would deadlock git. The hook spawns nothing — commits that don't fit the budget, exceed batch limits, or fail stay queued for a separate, standalone compensation drain triggered by unrelated occasions (sign-in, `jolli enable`, extension/plugin activation), never by this hook. Every internal error plus a hard wall-clock ceiling guarantee the hook can never block or fail the push.

## Scope

**In scope:**

- The pre-push stdin protocol the hook consumes and how it is parsed into ref updates.
- The repo-wide manual-disable gate read before configuration is loaded, and its position relative to the `syncOnPush` opt-out.
- The three config-gated outcomes: full no-op (when `syncOnPush` is `false`), record-only-with-signed-out-preview (when there is no credential), and record-and-sync-inline (when signed in).
- The per-repo outbound-push gate that sits between the queue write and the sign-in check, and the **two** stderr notices it branches into (genuine opt-out vs. unreadable store).
- The special handling of the all-zero object id on either side of a ref update (branch deletion vs. brand-new remote branch).
- How the set of commits introduced by each ref update is enumerated, and how those commits are recorded (with a push-confirmation target, still used by the compensation drain) into the pending queue.
- The wall-clock sync budget and the hard-exit timer that backstops it.
- The call into the shared drain engine's inline entry point, scoped to only this push's commits, and the per-commit result list rendered to stderr from its response.
- The signed-out memory preview.
- The always-exit-success guarantee: the hook can never turn a push into a failure.
- The standard-input drain-and-release behavior shared by all stdin-reading hooks (the pipe must be released promptly so the hook process exits without holding the writer open).

**Boundaries (consumed here, owned elsewhere):**

- The on-disk shape of the pending queue file, its per-entry fields, the read-time stale prune, the dedicated file lock, and the full claim-based drain engine mechanics — including the inline entry point's triage / batching / deadline phases — are owned by the **push-pending queue and drain engine** spec (269). This spec only records entries into that queue, calls the inline entry point, and renders its result.
- The standalone compensation drain — `PrePushWorker` as an independently-invoked process, and its trigger/spawn mechanics — is owned by the **push-pending compensation retry** spec (270); this hook no longer spawns it.
- The mechanics of installing the pre-push hook file into the repository's git hooks (markers, chaining onto a pre-existing hook, preserving the prior exit status) are owned by the git-shell hook installation spec (45).
- The personal-space upload contract for a single commit's memory (article assembly, attachment dedup, the typed configuration/auth error taxonomy) is owned by specs 94 / 231 and the push client spec.

## Data Contracts

### Pre-push stdin protocol

Git feeds the hook, on standard input, one line per ref being pushed, each with four whitespace-separated fields:

```
<local-ref> <local-sha> <remote-ref> <remote-sha>
```

- Blank lines are skipped; any line with fewer than four fields is skipped.
- `<local-ref>` / `<remote-ref>` are full ref names (for example `refs/heads/feature/x`).
- `<local-sha>` / `<remote-sha>` are 40-character object ids, or the **all-zero object id** (forty `0`s) as a sentinel.

Git additionally passes the destination **remote name** as the hook's first positional argument; the hook uses it to stamp a push-confirmation target on each recorded commit. When absent, entries are recorded without a confirmation target.

### The all-zero object id sentinel

- **`<local-sha>` is all-zero** → this ref update is a **branch deletion**. There is nothing to sync; the ref update is skipped entirely.
- **`<remote-sha>` is all-zero** → this is a **brand-new remote branch** (no existing remote tip to diff against). The commit enumeration for such a ref takes every commit reachable from the local tip that is **not already reachable from any tracked remote**, rather than a two-dot range against the (nonexistent) remote tip — diffing against the zero id would error.
- Otherwise the enumeration is the set of commits introduced by advancing the remote tip to the local tip (the two-dot range `<remote-sha>..<local-sha>`), oldest-first.

### Branch name

The branch recorded for a ref update is the local ref with a leading `refs/heads/` stripped; any other ref shape is recorded verbatim.

### Synchronous sync budget

- **Total sync budget: 3,000 ms**, anchored at process start. Shared by local git reads, the pending-file write, and the single inline HTTP request made through the drain engine's inline entry point.
- **Hard-exit grace: 1,000 ms** extra, arming a last-resort timer that force-exits the process (code `0`) if the budget-bound work has not finished by then.

### Per-commit result markers (printed to stderr)

Each considered commit renders with one of five status markers:

- **pushed ✓** — uploaded this run; the article URL is shown.
- **generating …** — no memory exists yet; will sync later.
- **deferred …** — eligible but held back (budget exhausted, batch limits, claimed elsewhere, or no batch support on the server); will sync later.
- **merged –** — became a squash/merge child after being recorded; the standalone entry was dropped.
- **failed ✗** — retry budget exhausted, or an unrecoverable error.

The signed-out memory preview lists at most 3 commits (hash + subject), appending `...` when more exist or the scan hit its deadline.

## Behavior

### Hook entry (synchronous, budget-bound)

1. Anchor `startedAtMs` at process start and compute the deadline (`startedAtMs + 3000ms`).
2. Arm an unref'd hard-exit timer at `budget + 1000ms` grace that force-exits the process (code `0`) as a last resort, regardless of what else is happening. Standard input is read at the hook's own entry point, before the budget-bound body below is entered — so the pipe is drained on **every** path, including the gated ones (see the asymmetry note under Notable Behavior).
3. **Repo-wide manual-disable gate.** Read the repository's manual-disable flag. If it is set, log that the repository is manually disabled and return; exit success. The position is load-bearing: this gate sits **before** configuration is loaded in step 4, and therefore before the unrelated `syncOnPush` opt-out in step 5 is ever consulted. On the disabled path there is no push-pending queue write, no inline sync, no signed-out memory preview, and no result list — while the push itself proceeds normally. The flag's storage, priority, and migration are owned by the manual-disable spec.
4. Load configuration.
5. **Opt-out gate.** If the sync-on-push config flag (`syncOnPush`) is explicitly `false`, do nothing at all — no queue write, no sync — and return.
6. Parse the stdin block into ref updates and enumerate/record commits:
   - If `<local-sha>` is the all-zero id, skip it (branch deletion).
   - Derive the branch name from the local ref.
   - Enumerate the introduced commits (per the sentinel rules above), oldest-first. If enumeration fails, log a warning and treat the ref as contributing no commits (the ref is skipped, the push still proceeds).
   - If no commits, skip the ref.
   - Accumulate the commits into a run-wide set, and record them into the pending queue under the branch, attaching a push-confirmation target `{ remote, remoteRef, localSha }` when the remote name is known. (Recording semantics — new-key-only merge, target dedup — are owned by spec 269.)
7. If the run-wide set of commits is empty, return.
8. **Per-repo outbound-push gate, with a stderr notice.** Read `readPushDisabledState(cwd)` — the **state**, not the boolean (`cli/src/hooks/PrePushHook.ts:310`). When it reports disabled, the commits recorded in step 6 stay pending (a later re-enable catches them up), nothing is sent, and exactly one of two stderr lines is printed before returning:
   - **Genuine opt-out** (`error` unset, `:319-323`): `jollimemory: outbound push disabled for this repo — recorded locally; re-enable it with \`jolli push-control --enable\`.`
   - **Unreadable store** (`error` set, `:312-317`): `jollimemory: can't read your outbound-push setting, so nothing was sent — recorded locally. Run \`jolli push-control\` for detail (<error>).` — and the `--enable` hint is **deliberately withheld**, because on a corrupt store `--enable` rebuilds from empty and drops every repo's opt-out (spec 310). This is the one push-disabled notice a user cannot miss, which is exactly why it must not be the one that misleads.

   The notice exists because the inline drain would otherwise be silent: `processPrePushInline` also gates on the flag, but its empty result prints nothing.
9. **Not signed in** (no saved personal-space API key): still record the commits above (for a later sign-in catch-up via spec 270), but there is nowhere to sync to yet. Instead, best-effort print a **signed-out memory preview**: scan local storage, deadline-bound, for this push's own-hash non-child summaries in push order, up to 3, appending `...` if more exist or the deadline was hit; then a blank line and a `jolli auth login` call-to-action. Any failure in the scan logs at debug and prints nothing.
10. **Signed in:** call the shared drain engine's inline entry point (spec 269, `processPrePushInline`) with this push's hashes (in push order) and the deadline. Catch and log any throw from that call — it must never propagate. Log the returned counts, then render the result list (below).

The synchronous portion is deliberately budget-bound (a config read, a stdin parse, per-ref commit enumeration, one queue write, and — when signed in — one inline sync call) so the push is held for real work only up to the fixed budget.

### Always exit success

Any error thrown anywhere in the hook's work is caught and logged; the hook still exits with success. **The pre-push hook must never turn a `git push` into a failure or block it beyond its budget** — its sync work is strictly best-effort, and the hard-exit timer is the unconditional backstop.

### Rendering the result list

For each considered commit, in push order, print one stderr line: the status marker (see Data Contracts), the short 8-character hash, and the subject truncated/padded to 50 characters (resolved via one best-effort `git show -s` over all hashes together; a failure there leaves subjects blank) — followed by the article URL (for `pushed`) or a short reason (for the other markers). The list is preceded by a header line. Nothing is printed when there are no commits.

### No worker is spawned by this hook

`PrePushWorker` still exists on disk, but this hook never launches it. It survives only as the standalone compensation-drain entry point invoked from sign-in, `jolli enable`, and extension/plugin activation — see spec 270 for that launch.

### Standard-input drain-and-release (shared by all stdin-reading hooks)

The shared helper that reads a hook's entire standard input, on reaching end-of-input, **destroys the input stream before resolving** the collected text. A hook process must resolve promptly and must not keep the pipe open after it has consumed everything; leaving it open can hold the writing side (git) waiting. This applies to every hook that reads standard input, not only the pre-push hook.

## State Transitions

### A pushed ref update (hook's view)

| From | Condition | To |
| ---- | --------- | -- |
| Ref line on stdin | `<local-sha>` all-zero | Skipped (branch deletion) |
| Ref line on stdin | `<remote-sha>` all-zero | Enumerated as commits not on any tracked remote |
| Ref line on stdin | both sides real | Enumerated as the `<remote-sha>..<local-sha>` range |
| Enumerated, non-empty | — | Recorded into the pending queue (branch + confirmation target) |
| Enumerated, empty / enumeration failed | — | Contributes nothing; push proceeds |

### The hook run

| From | Condition | To |
| ---- | --------- | -- |
| Invoked | repository carries the manual-disable flag | Full no-op; configuration never loaded; exit success (stdin still drained) |
| Invoked | `syncOnPush` is `false` | Full no-op; exit success |
| Invoked | outbound push disabled for this repo, ≥1 commit recorded | Record only; no sync; **one** stderr notice with the `--enable` hint; exit success |
| Invoked | push-control store unreadable, ≥1 commit recorded | Record only; no sync; a **different** stderr notice naming the read error and pointing at `jolli push-control` (no `--enable` hint); exit success |
| Invoked | signed out, ≥1 commit recorded | Record + signed-out preview; no sync; exit success |
| Invoked | signed in, ≥1 commit recorded | Record + synchronous inline sync (budget-bound) + result list; exit success |
| Invoked | 0 commits after parsing | No sync; exit success |
| Invoked | any internal error | Logged; exit success |
| — | hard-exit timer fires | Force-exit code `0`, regardless |

## Notable Behavior

- **The hook can never fail a push.** Every internal error path is caught and swallowed, and the process exits with success unconditionally. (Surprising for a hook, but intentional: memory sync must never be able to block the user's git workflow.)
- **A brand-new remote branch uses a "not on any remote" enumeration, not a range.** A two-dot range against the all-zero remote id would error, so the hook falls back to "everything reachable locally that no tracked remote already has." (Surprising; intentional.)
- **The hook now deliberately blocks `git push` for real work, up to ~4s.** A trade against the old zero-latency, always-detached design; the hard-exit timer is the last-resort guarantee that the block cannot become indefinite. (Notable; a deliberate architecture change.)
- **Publishing is optimistic.** The hook runs before git transfers objects, so waiting for remote confirmation would deadlock — there is nothing to confirm against yet. A rejected push can therefore briefly leave a Space article for a commit that never reached the remote; a retry converges via `docId` reuse. (Surprising; intentional.)
- **Signed-out pushes surface already-generated memories with a sign-in hint**, rather than silently recording with no feedback. (Notable.)
- **A push-disabled repo prints one of two different notices, and the choice of which is a safety decision.** The hook reads the push-control *state* rather than the boolean precisely so it can tell "the user opted this repo out" apart from "the setting file could not be read" — the gate fails CLOSED, so an unreadable store reports disabled for every repo on the machine. Only the genuine opt-out gets the `jolli push-control --enable` hint; the unreadable branch deliberately withholds it, because on a corrupt store `--enable` rebuilds from empty and drops **every** repo's opt-out. The most unmissable notice in the product (it prints on every `git push`) must not be the one that recommends the destructive recovery. (Surprising; the same condition yields two notices on purpose — spec 310.)
- **Unlike the `syncOnPush` and manual-disable gates, the push-disabled gate still records the commits.** It sits *after* the queue write, so the backlog survives and the re-enable drain (spec 270) flushes it. The other two gates return before anything is written. (Notable; the ordering is the difference between "we'll catch up later" and "this push was never seen".)
- **The worker's spawn/launch mechanics moved to spec 270.** `PrePushWorker` is still a detached-spawn process, but it is now launched only by the standalone compensation-drain trigger (sign-in, `jolli enable`, activation), tagged with a `--trigger`; this hook performs no spawn at all. (Notable; architecture change.)
- **Destroying stdin after end-of-input is a correctness fix, not a cleanup nicety.** Hooks that leave the pipe open can hold git waiting; the shared reader destroys the stream before resolving. (Notable; affects every stdin-reading hook.)
- **This hook always drains its standard input, even when it is going to do nothing.** The read happens at the hook's entry point, before the budget-bound body and therefore before the manual-disable gate and the `syncOnPush` gate. The post-rewrite hook is the deliberate contrast: its gate precedes its own stdin read, so a disabled repository leaves that hook's rewrite mapping unread. Both are correct for their own pipe — pre-push must release git promptly, and the post-rewrite mapping has no later consumer — but "the hook drained its input" is not a signal that the hook did any work. (Surprising; the two stdin-reading hooks differ on purpose.)
- **The manual-disable gate outranks the `syncOnPush` opt-out and masks it.** The repo-wide flag is read before configuration is loaded, so on a disabled repository the sync-on-push setting is never consulted at all — no setting can re-enable push tracking against the opt-out. (Notable; a deliberate priority ordering.)

## Shared Behavior

- The repo-wide manual-disable flag read at step 3 — its storage, repo-wide anchoring, priority, migration, and the fact that the standalone compensation worker carries the same gate independently — is owned by the manual-disable spec.
- The pending queue file, its fields, the read-time stale prune, the dedicated lock, and the claim-based drain engine (this hook calls its inline entry point directly; the standalone worker calls its full entry point via spec 270) are owned by spec 269.
- The startup / sign-in retry of every pending entry (a different occasion that calls the same drain engine) is owned by spec 270; the queue-worker post-drain trigger (yet another occasion) is owned by spec 34.
- Installation of the pre-push hook file (markers, chaining, prior-exit-status preservation) is owned by spec 45.
- The per-repo outbound-push opt-out read at step 8 — its machine-global store, the `readPushDisabledState` state form, the fail-closed rule, and the "never recommend `--enable` on an unreadable store" policy this hook implements — is owned by spec 310.
- The single-commit personal-space upload contract and its typed error taxonomy are owned by specs 94 / 231 and the push client spec.
- The detached-spawn primitive (detached, hidden, streams-ignored, unref'd, sibling-script location guard, file-name auto-run guard) is now entirely spec 270's concern — it also underlies the git-operation queue worker (spec 34). This hook performs no spawn.

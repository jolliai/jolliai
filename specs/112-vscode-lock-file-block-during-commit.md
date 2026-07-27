# VS Code Lock File Block During Commit / Squash / Create PR

## Topic Statement

The shared guard the AI Commit, Squash, and Create-PR actions consult before they run, which aborts each action with a warning toast whenever the per-repo summary-drain lock file is present and not yet stale, so that user-driven git / PR operations cannot race the orphan-branch summary worker. Push is deliberately **not** gated, and the topic-KB ingest phase — which runs under its own separate lock — deliberately never trips this guard.

## Scope

**In scope:**
- The lock file's location: the per-repo summary-drain lock in the workspace's state directory.
- The presence + age check: the lock counts as "busy" only if it exists AND is younger than the staleness threshold.
- The 5-minute staleness threshold and what it means: a lock with a modification time older than 5 minutes is treated as crashed and ignored (the action proceeds).
- The user-visible behavior when busy: a warning toast with a fixed message and an immediate abort, with no wait/retry/poll loop.
- The user-visible behavior when not busy or stale: silent — the action proceeds.
- The set of actions that consult this guard at the start of their flow (AI Commit, Squash, and Create PR — the latter exposed on two webview surfaces).
- That Push does **not** consult the guard, and why.
- That the guard reads only the summary-drain lock and deliberately ignores the separate ingest lock.
- The `workerBusy` context key that mirrors the same summary-drain-lock state to drive command enablement.
- Failure mode: a missing lock file is treated as "not busy" (success path), not as an error.

**Out of scope:**
- The actual write semantics of the lock — who creates it, with what content, who removes it, and how it's atomically acquired. The actions only ever observe the file's existence and modification time; they never write or delete it. (Owned by spec 34.)
- The separate per-worktree ingest lock and its deferred-ingest hand-off (spec 259). This guard never reads it; it is named here only to state that ingest cannot block these actions.
- The summary worker's pipeline (LLM call, queue draining, orphan-branch writes) that is the reason the lock exists.
- The status-bar / sidebar busy indicator that is driven from the same lock-watch signal — covered by the status-bar items spec and the sidebar tab-state spec.
- The cosmetic ingest-phase display marker that drives a sidebar "building wiki/graph" pill; it is display-only and carries no gate role (specs 218, 259).
- The git-operation queue files that sit alongside the lock; they are unrelated to this guard.
- Modal wait-or-cancel UX. There is none. The action either proceeds immediately or aborts immediately.

## Data Contracts

### Lock file location

| Aspect | Value |
| --- | --- |
| Path | The summary-drain lock file, `<workspaceRoot>/.jolli/jollimemory/worker.lock`. |
| Scope | Per-workspace repository (one lock per repo, regardless of how many editor windows are open). |
| Held during | Summary generation only. Topic-KB ingest (wiki/graph build) runs under a **separate** per-worktree ingest lock (spec 259), so it never places or refreshes this file. |
| Visibility | Hidden from the user; lives under the same per-repo state directory as `sessions.json`, `plans.json`, the git-op queue, the sibling ingest lock, and other internal files. |

### Busy detection rule

| Input | "Busy" output |
| --- | --- |
| Lock file does not exist | False — proceed. |
| Lock file exists, modification time is younger than 5 minutes | True — abort with warning. |
| Lock file exists, modification time is 5 minutes or older | False — proceed (treat as crashed worker). |
| `stat` call throws for any reason | False — proceed (any "can't read it" outcome is treated as not-busy). |

The 5-minute threshold matches the same value the worker itself uses to decide a sibling lock is stale and reusable. The threshold is hard-coded; there is no setting that changes it.

### User-visible message

A single warning toast is shown when busy detection returns true:

> Jolli Memory: AI summary is being generated. Please wait a moment.

The message text is identical for every gated action.

### Command-enablement context key

Beyond the click-time guard, the extension mirrors the summary-drain lock's fresh/busy state into a `workerBusy` context key that drives the `enablement` of the contributed AI-Commit and Squash commands (so the buttons visibly disable while a summary runs). The key is now **exactly the raw summary-drain-lock busy flag** — there is no phase distinction and no ingest carve-out, because the ingest phase runs under a separate lock (spec 259) that neither the watcher nor this key observes. Because the click-time state can go stale during LLM message generation and a QuickPick, the gated command handlers re-check the guard right before executing rather than trusting the context key alone.

### Affected actions (and where the guard sits)

| Action | Trigger | Guard position |
| --- | --- | --- |
| AI Commit (the [✦] button on the Changes panel) | User click | Step 1, before any index snapshot, staging, message generation, or commit; re-checked after the message QuickPick. |
| Squash (the [⊞ Squash] button on the Branch History panel) | User click | Step 1, before validating selection, asking for force-push confirmation, or generating a squash message; re-checked after the QuickPick. |
| Create PR / Update PR — **standalone Create-PR webview** | User click "create" in that panel | Before building the PR body / issuing the create-or-update. On busy it posts a settle message so the disabled submit buttons re-enable for a retry. |
| Create PR / Update PR — **summary webview** | User opens the create-PR or update-PR flow from a summary | At the start of the prepare-create-PR and prepare-update-PR handlers, before loading branch summaries or building the body. |

Each action returns immediately on a busy result; nothing on disk changes.

### Push is not gated

Push (the push button on the Branch Commits panel) deliberately does **not** consult the guard. It only runs `git push` on the current code branch and shares no git ref or file with the summary worker (which writes summaries to the orphan branch + Memory Bank folder and never touches the remote), so there is no race to prevent.

## Behavior

### When the lock is fresh (< 5 minutes old)

1. The action's first step calls the busy check.
2. The check resolves to true.
3. The action shows the warning toast.
4. The action returns. No further work is done — no index snapshot, no LLM call, no progress UI, no panel refreshes, no error toast.

### When the lock is missing

1. The action's first step calls the busy check.
2. The check resolves to false (the `stat` throws ENOENT, swallowed and returned as "not busy").
3. The action proceeds with its normal flow.

### When the lock is stale (≥ 5 minutes old)

1. The action's first step calls the busy check.
2. The check resolves to false (existing file, but age past threshold).
3. The action proceeds with its normal flow. The action does not attempt to delete the stale lock — the worker that next acquires the lock will treat it as stale and overwrite it.

### When `stat` fails for any other reason

1. Any thrown error from reading the lock file's stat — permission denied, path-component-not-a-directory, transient I/O — is caught.
2. The check resolves to false.
3. The action proceeds. The rationale: failing-closed (treating an unreadable lock as "busy") would block the user with no recovery; failing-open lets the worker's own lock-acquisition contend if it is actually running.

## State Transitions

This is a synchronous check at the start of each action (plus one repeat of the same check after the QuickPick for Commit and Squash). No state machine, no polling loop, no user-facing retry — each "is the lock busy?" decision is one-shot and independent.

| Lock state at action start | Action outcome |
| --- | --- |
| Absent | Proceed |
| Fresh | Abort with warning toast |
| Stale (≥ 5 min) | Proceed |
| Unreadable | Proceed |

The AI Commit and Squash actions re-check the guard once more — after their message-generation QuickPick — because a summary drain can legitimately start while the user is mid-flow (message generation plus QuickPick can span seconds). Apart from that single re-check, the guard is not polled: once an action has cleared both checks and committed to its work it does not re-poll if the worker starts mid-flow. (The worker's own acquisition would block on whatever git operation the action is doing, but the action does not otherwise coordinate with it.)

## Notable Behavior

- **There is no wait-or-cancel modal.** The brief mentions polling cadence and timeouts; the actual behavior is a flat refusal with a fixed toast message. The user must explicitly retry the action after dismissing the toast. The motivation is keeping the UX flat: a modal with "Wait / Cancel" is harder to interpret than a transient warning the user can decide to act on. (Surprising; intentional.)
- **The threshold is exactly 5 minutes.** This is the same number the summary worker uses internally to decide its own stale-lock recovery, so the guard and the worker agree on what "this lock can be ignored" means without coordination. (Notable.)
- **Stale locks are not cleaned up by the actions.** Even when the guard sees a 7-minute-old lock and proceeds, the action does not remove the lock file. Cleanup is the next worker's responsibility. The action just gets out of the way. (Surprising; intentional.)
- **Any `stat` failure means "proceed".** Permission errors, ENOTDIR, transient I/O — all of them are swallowed and treated as "not busy". The asymmetry is deliberate: a misread lock should never cause the user's action to be blocked by something they cannot fix. (Notable.)
- **The same warning message is used for every gated action.** Commit, Squash, and both Create-PR surfaces display the identical toast. The user does not need to learn several different busy messages. (Notable.)
- **Push is intentionally exempt.** Only Commit, Squash, and Create PR gate; Push does not, because it touches neither the orphan summary branch nor the Memory Bank folder that the worker writes. (Surprising; intentional.)
- **Topic-KB ingest never trips the gate.** Ingest (wiki/graph build) runs under a separate per-worktree ingest lock (spec 259), not the summary-drain lock this guard reads, so a user can commit / squash / create a PR while a long ingest is in progress. The guard reads only `worker.lock`; it deliberately ignores `ingest.lock`. (Notable; the reason the two locks were split.)
- **The check is the very first step of each action.** It runs before any state mutation — before snapshotting the git index, before staging or unstaging files, before any progress notification appears, before any LLM call. A busy verdict therefore leaves the workspace untouched. (Notable.)
- **The same lock is the one the status-bar / sidebar busy indicator and the `workerBusy` context key watch.** The guard, the indicator, and the context key all observe the same summary-drain-lock file with the same threshold but via independent calls; the guard is one-shot at action time (with the one post-QuickPick re-check), the indicator and context key are event-driven via a file watcher on that lock. (Notable.)
- **There is no per-action override.** The user cannot force the commit to run while the worker holds the lock; there is no "I know what I'm doing" affordance. To proceed, the user must either wait for the worker to finish (the lock disappears) or wait for the lock to age past 5 minutes (the worker has crashed). (Surprising; intentional.)

## Shared Behavior

- **Same staleness threshold as the summary worker.** Both this guard and the worker's own summary-drain-lock acquisition logic treat 5 minutes as the cutoff; they observe the same on-disk file. Any change to one must change the other. (Lock ownership: spec 34.)
- **Same per-repo state directory.** The summary-drain lock lives next to `sessions.json`, `plans.json`, `cursors.json`, the git-operation queue, the squash-pending state file, and the sibling ingest lock (spec 259); it is one entry in a single fixed-purpose directory shared by every component that touches per-repo state.
- **Same on-disk worker.** All gated actions, plus the status-bar busy indicator, the sidebar Branch-tab busy chip, and the `workerBusy` context key, observe the same summary-drain-lock file written by the same background worker. There is exactly one writer of the lock per repo at any time.
- **Ingest lock is a distinct file this guard never reads.** The worker's ingest phase uses a separate per-worktree lock (spec 259); the busy read here is scoped to the summary-drain lock precisely so ingest cannot block user actions.

# VS Code AI Commit From Checkbox Selection

## Topic Statement

The Commit Selected action that snapshots the current git index, stages exactly the checkbox-selected files (handling deletions, sparse-excluded paths, and tracked-but-now-untracked entries correctly), generates a single-line commit message via the LLM, gates whether the Amend actions are offered based on whether the current HEAD is a commit this branch owns and the current user authored, and presents Commit / Amend / Amend (keep message) in an editable quick-pick that rolls the index back to the snapshot on cancel or any error.

## Scope

**In scope:**
- The pre-flight guards (manual-disable refusal, worker-busy lock, at least one checked file).
- The index snapshot taken before any staging change so cancel / error / failure paths can restore the working tree exactly.
- The staging diff between "selected by checkbox" and "currently in the index", including how deletions, sparse-excluded files, and untracked entries are handled.
- The LLM input set (staged diff only — no transcripts, no narrative, no prior summaries) and what the user sees while it runs.
- The amend-safety check: whether the current HEAD is a commit this branch owns (measured from the branch's true fork point, not the mainline merge-base) and was authored by the current user, and whether HEAD is also reachable from another branch.
- The three-action quick-pick (Commit / Amend / Amend keep message), its dynamic title swap when the Amend actions are available, its restricted-to-Commit-only form when they are not, the empty-message rejection rule, and the free-form-text vs. filter behavior.
- The defensive re-check of amend safety inside the commit action execution, which covers the race between the picker opening and accept.
- Re-staging immediately before running the chosen action so edits made while reviewing the message are captured.
- The push-detection check that runs on Amend so the user is told a force-push will be needed.
- Post-commit re-staging of files that were already staged before the flow started but were not part of this commit.
- The success notification and the panel refreshes that follow.
- Every error/cancel branch — what gets shown, what gets restored, what is logged.

**Out of scope:**
- Push itself — the success toast nudges the user toward the Push action; this flow never pushes.
- The post-commit summarization pipeline that runs after the commit lands (queue worker, hook, summary generation).
- Squash — a separate action with its own preconditions and prompt.
- The LLM call internals (prompt template, model alias, token budget). This spec only states what the action passes in and gets back.
- Worker-busy lock semantics (file location, staleness threshold, probe failure handling) — the lock-file guard topic owns those.
- Storage of the resulting summary — the orphan-branch storage topic owns that.

## Data Contracts

### Inputs gathered before the flow runs

- **Selected file list** — every file the user has currently checked in the Changes panel. Each carries its repository-relative path and a status code that tells the action whether it is tracked, untracked, modified, deleted, or sparse-excluded.
- **All-files list** — every file the Changes panel currently shows, regardless of selection. Used to compute the unselected-but-tracked set.
- **Currently-staged paths** — the set of paths the index considers staged at the moment the user invoked the action. Used to know which paths were staged before the action started so they can be re-staged afterwards.

### The index snapshot

A single opaque token (the hash of a tree object) captured before any staging change. The snapshot preserves the entire index state — including partial-hunk staging, intent-to-add entries, and mode-only changes — and is the sole rollback target for cancel and error paths. Conflict markers in the working tree are detected at snapshot time and surfaced as an error before any modification happens.

### The selected-vs-unselected staging diff

Two derived sets, both computed off the file list above:

| Set | Membership rule |
| --- | --- |
| Paths to stage | Every path in the selected list, regardless of status code. |
| Paths to unstage | Every path in the all-files list that is **not** selected **and** has a tracked status code (i.e. not the untracked status). |

The "stage" set is allowed to contain missing paths — a file the user deleted is still legitimately staged so the deletion is committed. The "unstage" set deliberately excludes untracked files because un-staging a path the index has never seen is an error.

### Inputs passed to the LLM call

Only the staged diff, the current branch name, and the list of staged file paths. Conversation transcripts, prior summaries, and any session context are explicitly **not** passed.

### The result of the LLM call

A single-line trimmed string. The user sees it pre-filled in the quick-pick.

### Generation-failure text

A generation failure surfaces as an error toast reading `Jolli Memory: Failed to generate commit message: <text>`. `<text>` is normally the failure's own message. There is exactly one substitution: a failure classified as "the local agent is installed but not signed in" is replaced with specific sign-in guidance —

> Claude Code is installed but not signed in. Open a terminal, run `claude`, and sign in with /login — or switch the AI provider in Jolli Memory settings.

The raw message for that failure ("Not logged in · Please run /login") presumes an already-open agent session the user does not have, which is why it is overridden rather than passed through. Every other failure keeps its own message verbatim; a thrown non-error value is stringified.

### Amend availability

Before the quick-pick is shown, the action resolves whether the Amend actions may be offered. The result is a boolean `allowed` flag and, when false, a user-visible reason clause (lowercase, no leading capital).

The check is three-tiered, evaluated in order:

1. **Own-commits check** — resolves the branch's true fork point (see below) and tests whether HEAD equals that point. If HEAD equals the fork point the branch has no commit of its own, and `allowed` is false with reason "this branch has no commit of yours to amend".

2. **Author check** — compares the HEAD commit's author email with the current `git config user.email` (case-insensitive). An empty HEAD author email or an empty configured email each count as a mismatch. If the emails do not match, `allowed` is false with reason "the latest commit was authored by someone else".

3. **Shared-tip check** — queries every local and remote ref that contains HEAD. The current branch's own ref (`refs/heads/<branch>`), its configured upstream (`refs/remotes/<upstream>`), and `refs/remotes/origin/<branch>` (the same-named remote copy written by a push without `-u`) are all excluded. If any other ref remains, HEAD is also reachable from another branch, and `allowed` is false with reason "the latest commit also belongs to another branch".

When all three checks pass, `allowed` is true.

A failure to complete the own-commits check (for example, an empty repository with no HEAD) is treated as `allowed` false with the same "no commit of yours" reason.

#### Fork point resolution for the own-commits check

The "own commits" base — the point from which the branch's work is counted — is resolved from the branch's true fork point, not from the mainline merge-base. The resolution rule, in priority order:

1. Look for an explicit "branch: Created from …" entry in the branch reflog. If found, use that commit as the candidate fork point.
2. Validate the candidate: it must still be an ancestor of HEAD. If it has become stale (the branch was reset or rebased onto a different branch after creation), discard it and fall back to the mainline merge-base.
3. For a valid candidate that differs from the mainline merge-base: adopt it only when the mainline merge-base is itself an ancestor of the candidate (i.e. the candidate is downstream of main, as in the "cut from release/develop" case). Otherwise use the mainline merge-base.
4. When the mainline merge-base is unresolvable (no origin/main, upstream/main, or main ref), use the validated creation-point directly.
5. Detached HEAD has no branch reflog; the mainline merge-base is used without a reflog lookup.
6. When the reflog has entries but no explicit "branch: Created from …" record (the creation entry has expired), the creation-point guess is skipped entirely to avoid silently dropping the branch's earliest commit; the mainline merge-base is used.

### The three quick-pick actions

| Item | What it does |
| --- | --- |
| Commit | Create a new commit with the trimmed text in the input field. |
| Commit (Amend) | Rewrite the previous commit, replacing its message with the trimmed text in the input field. |
| Commit (Amend, keep message) | Rewrite the previous commit, keeping its existing message. The text in the input field is ignored. |

### Quick-pick UI rules

- The input field is pre-filled with the LLM's output and is editable.
- Filtering on label, description, and detail is **disabled** so the user's typed text is treated as a free-form message rather than a filter query against the three action items.
- When the Amend actions are available (`allowed` is true): the title is "Edit the commit message, then select an action". It swaps to "Input will be ignored — reuses last commit message" when the user highlights "Amend, keep message", and reverts to the default when any other action is highlighted.
- When the Amend actions are not available (`allowed` is false): the title is "Only Commit is available — <reason>" (the reason clause from the availability check, as written). The two Amend items are absent from the item list entirely — they are not greyed out, not disabled, not present at all. The title is fixed and does not update on active-item changes.
- On accept, an empty (or whitespace-only) input field is rejected for "Commit" and "Amend"; the quick-pick stays open. Empty input is accepted for "Amend, keep message" because the input is ignored anyway.
- Dismissing the quick-pick (Escape, click-away, or any other hide) without first accepting is treated as cancel.

## Behavior

### When the user invokes Commit Selected

0. **Refuse outright when the repository is manually disabled**, with the informational message "Jolli Memory is disabled for this project — enable it first." and no further work. This guard sits **ahead of everything else** — ahead of the worker-busy lock probe and ahead of the engagement-telemetry gathering — so a refused invocation records no "memory committed" event and takes no lock reading.
1. Run the worker-busy guard. If busy, show the warning toast and return.
2. Read the selected file list. If empty, show "No files are selected. Please check at least one file before committing." and return.
3. Snapshot the index tree. On failure: if conflict markers were detected, surface that specific error; otherwise surface a generic "Could not read the current git index. Commit aborted to avoid data loss." Either way, return without staging anything.
4. Capture the currently-staged paths so the post-commit step can re-stage anything that was staged before the action but was not in this commit.
5. Stage the "to stage" set. Then unstage the "to unstage" set (skipped when empty). On any failure: surface the failure, restore the index tree from the snapshot, return.
6. Show a non-cancellable progress notification ("Generating commit message…") while the LLM call runs. On failure: surface the failure using the generation-failure text rule above (the local-agent sign-in case gets its own guidance sentence; everything else shows its own message), log it, restore the index tree, return.
7. Resolve the amend availability (the three-tiered check described in Data Contracts). A failure to resolve is treated as "not allowed". The result governs which items appear in the quick-pick and what the title says.
8. Show the quick-pick pre-filled with the generated message. On cancel/dismiss: restore the index tree, return.
9. Re-check the worker-busy guard. If the worker has become busy since step 1 (the lock was in the exempt ingest phase at click time and has since moved to a blocking summary run), show the worker-busy warning, restore the index tree, and return without committing.
10. Re-stage the "to stage" set a second time so any edits the user made between step 5 and now are picked up. Then run the chosen action:
    - **Commit** — write a new commit with the trimmed input.
    - **Amend** or **Amend, keep message** — run a fresh amend-availability check before touching the index. If the fresh check finds the action no longer allowed (the state may have changed since step 7), throw an error (surfaced as a commit-failed toast) and restore the index. Otherwise, read whether the previous commit was already pushed, capture the previous commit's hash, and rewrite the previous commit with the trimmed input (Amend) or without changing the message (Amend, keep message). After the rewrite, capture the new hash.
    On any failure: surface the failure, restore the index tree, return.
11. For both amend variants: if the previous commit was already pushed, show an informational toast warning the user that a force-push will be needed.
12. Re-stage any path that was staged before the action started but was not in the "to stage" set, so a partially-staged "stage X for this commit, but keep Y staged for later" workflow is preserved. If this re-stage fails, show a warning toast — the commit itself succeeded, so this is non-fatal.
13. Show the success toast: "Successfully committed. post-commit hook is generating a summary in the background.".
14. Refresh the Changes panel, the Branch History panel, the Status panel, and the status bar.

### Push detection happens before the amend, not after

The "was the previous commit pushed?" probe runs before the amend rewrites the commit, inside the execution of the Amend action (step 10). Probing afterwards would compare a brand-new hash to the upstream and falsely report the commit as un-pushed.

### Restoration is by tree snapshot, not by re-running the staging diff

Every error and cancel path restores the index by writing the captured tree back, not by replaying the staging operations in reverse. This is what preserves partial-hunk staging, intent-to-add entries, and mode-only changes that were present before the action ran.

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Idle | User clicks Commit Selected | Guarded |
| Guarded | Repository manually disabled | Idle (informational toast; nothing probed, nothing recorded) |
| Guarded | Worker busy | Idle (warning toast) |
| Guarded | Nothing checked | Idle (warning toast) |
| Guarded | At least one checked, no worker | Snapshotted |
| Snapshotted | Snapshot fails | Idle (error toast) |
| Snapshotted | Snapshot succeeds | Staged |
| Staged | Stage / unstage fails | Idle (error toast, index restored) |
| Staged | Stage / unstage succeeds | Generating |
| Generating | LLM fails | Idle (error toast — sign-in guidance for the local-agent-not-signed-in case, otherwise the failure's own message; index restored) |
| Generating | LLM succeeds | Reviewing |
| Reviewing | User dismisses or accepts empty for non-keep-message action | Idle (index restored) |
| Reviewing | User accepts | WorkerRecheck |
| WorkerRecheck | Worker became busy during generation / review | Idle (warning toast, index restored) |
| WorkerRecheck | Worker still idle | Committing |
| Committing | Re-stage or commit/amend fails (including fresh amend-safety block) | Idle (error toast, index restored) |
| Committing | Action succeeds | Restoring |
| Restoring | Re-stage of pre-flow staged files succeeds | Notified |
| Restoring | Re-stage of pre-flow staged files fails | Notified (extra warning toast — non-fatal) |
| Notified | Refresh complete | Idle |

The index has exactly two persistent states from the user's perspective: "the state before the action started" (the snapshot, restored on every cancel and error path) and "the state right after the chosen action ran plus any pre-flow staged files re-applied" (the only state that survives a successful run).

## Notable Behavior

- **The manual-disable guard exists for the command-palette route, not the button.** The sidebar collapses to its disabled panel in a manually-disabled repository, so the Commit Selected button is not on screen at all — but the command stays registered and reachable from the palette. The guard is what stops that route from writing into a repository the user has opted out of. It is deliberately the *first* thing the invocation does, so the engagement telemetry that the normal path gathers off the click path is not recorded for a refused attempt either. (Notable; see 304.)
- **Checkboxes are UI-only; the action is the staging.** The Changes panel does not stage on click — staging happens entirely inside this flow at step 5. Anything the user did in another tool (terminal `git add`, source-control panel) before running the action is picked up via the "currently-staged paths" snapshot and restored after the commit, but the checkbox set is the authoritative input to the commit itself. (Surprising; intentional — mirrors GitHub Desktop, not the built-in source-control panel.)
- **Deletions including ignored-and-deleted are stage-able.** Allowing the stage list to contain missing paths means that a file the user removed from the working tree (whether or not it was tracked at action time) can be the subject of a commit. Without this, deleting a file would require an extra workaround to land. (Notable.)
- **Sparse-excluded and untracked-but-not-checked files are intentionally not unstaged.** A path that the index has never seen would error on un-stage. Filtering them out keeps the unstage step from spuriously failing on repositories using sparse-checkout, partial clones, or just unrelated untracked files. (Notable.)
- **Re-staging happens twice.** Once at step 5 (before the LLM call, so the diff the LLM sees is correct) and once at step 10 (right before the chosen action runs, so any edits the user made while reviewing the LLM's wording are still committed). Both are intentional; removing either would either feed stale content to the LLM or drop just-saved edits from the commit. (Surprising; intentional.)
- **No "use raw user-typed message" fallback when the LLM fails.** The flow aborts with an error toast and the index is restored. The user must retry the action — there is no hatch where the user can hand-type a message when the LLM is unreachable. (Surprising; intentional.)
- **One generation failure gets a rewritten message; the rest are passed through.** The "local agent installed but not signed in" case is the only classified failure with its own copy, because its underlying message tells the user to run a slash command inside an agent session they do not have open — actionable-looking, but useless from a toast. Every other failure shows its own text so nothing is hidden. (Notable.)
- **Quick-pick filtering is disabled for a real reason.** With filtering on, typing the commit message would filter the three action items out of the active set; nothing would be active and Enter would never fire. Disabling filtering is the entire reason the message-text-as-input approach works at all. (Surprising; intentional.)
- **Empty-message accept keeps the quick-pick open.** For Commit and Amend, an empty input on accept is silently rejected — the quick-pick stays visible and the user keeps editing. Only "Amend, keep message" allows an empty input, because that variant ignores the input field entirely. (Notable.)
- **Pre-flow staged files survive the commit.** A user who had staged a file via terminal before running the action will find that file still staged afterwards — even if it was not in the checkbox selection — provided the post-commit re-stage step succeeds. If it fails, a non-fatal warning toast asks the user to re-stage manually. (Notable.)
- **The push-detection toast for amend is informational, not a confirmation gate.** The action does not prompt before amending an already-pushed commit; it amends and then tells the user a force-push will be needed. Force-push itself is the Push action's job. (Notable.)
- **The progress notification is non-cancellable.** Once the LLM call starts, there is no in-flight cancel button. The user must wait for the LLM to return (or fail) before any further interaction. (Notable.)
- **Generic error wording obscures the snapshot mechanism.** When the snapshot itself fails for any reason other than conflict markers, the user sees the same "Could not read the current git index" toast — the action does not leak the underlying file-system or git error into the UI to keep the abort message coherent. (Notable.)
- **Amend actions are removed, not disabled.** When the availability check finds Amend unsafe, the two Amend items do not appear in the quick-pick item list at all. The title names the reason. This design is forced by VS Code's QuickPick API, which has no disabled/greyed state for items — a greyed item would still be selectable. (Notable.)
- **"Own commits" is measured from the branch's true fork point, not from main.** A branch freshly cut from `release/1.0` (or any branch other than main) starts with its tip equal to that fork point and no commits of its own. Measuring from the mainline merge-base would wrongly count the base branch's shared tip as this branch's own work, allowing Amend on a commit that belongs to that base branch. The fork-point resolution (reflog "Created from" entry + ancestry validation) is therefore safety-critical, not a display nicety. (Surprising; intentional.)
- **A branch-shared tip is a third independent gate.** After a `git reset --hard` or `git rebase --onto` onto a branch that descends from the reflog creation point, HEAD can be a commit that other branch still points at while the fork-point calculation still looks valid. The shared-tip check (`for-each-ref --contains=HEAD`) closes this gap. It runs only after the first two checks pass. (Notable.)
- **Amend safety is checked twice.** At step 7, before the quick-pick opens, to determine which items to show. At step 10, before executing the Amend action, as a defensive re-check for the race between the picker opening and the user accepting. The second check matters because qp.items[0] is used as a fallback selection on accept — if the picker somehow surfaced an Amend item while the branch state was changing, the re-check catches it and throws an error that routes through the standard commit-failed toast and index-restore path. (Surprising; intentional.)

## Shared Behavior

- **Manual-disable opt-out** — the durable repo-wide opt-out this action's first guard reads, and the zero-write contract it belongs to, are owned by **Zero-Write Contract for a Manually-Disabled Repository** (304); the sidebar's disabled panel that hides this action's button is owned by the onboarding-panel topic.
- **Worker-busy lock guard** — the same warning toast and probe used by Push and Squash blocks this action when a summary is being generated. This action also re-checks the guard after the quick-pick is shown (step 9), not only at action invocation time.
- **LLM commit-message generation** — the prompt, the model alias, the credential resolution, and the single-line output contract are owned by the AI commit-message generation topic. There is a **single** generation implementation: this action calls it in-process, and the JVM-based plugin surface reaches the same implementation out-of-process, so the two surfaces cannot drift. The failure classification this action's toast rule keys on is produced by that shared implementation, and the JVM surface maps it to the same guidance sentence.
- **Index snapshot tooling** — the tree-write / tree-read mechanic is shared with Squash, which also restores by snapshot on error.
- **Post-commit summary pipeline** — the success toast points users toward the queue-worker driven summarization that runs asynchronously after this action finishes.
- **Push action** — the "force-push needed after amend" hint is purely advisory; the Push action's own warning dialog is what actually gates the force-push.
- **Amend summary migration** — when an Amend action completes, the post-commit hook enqueues an amend operation that migrates the prior summary to the new hash. The gating described in this spec (when the action is offered) is distinct from the migration pipeline (what happens to the summary after the rewrite). The migration is covered by the amend summary migration topic.

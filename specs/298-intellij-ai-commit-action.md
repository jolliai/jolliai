# 298. IntelliJ AI Commit Action

## Topic Statement

The IDE plugin's "AI Commit" action: a re-entrancy-guarded background flow that snapshots the git index, stages the Changes panel's checked files and unstages the rest, aborts cleanly when nothing was actually staged, obtains a commit message from the command-line surface, offers a three-way review dialog (Commit / Amend / Amend keep-message), executes the chosen commit, restores any pre-existing staging that was not part of this commit, and explicitly nudges the IDE to re-read git state so the just-committed files stop being offered again.

## Scope

**In scope:**
- The action's enablement rule and the thread it is computed on.
- The per-project re-entrancy guard and every path that must release it.
- The working directory the whole flow runs against, and why that choice matters in a multi-worktree checkout.
- The busy-worker pre-check and its dialog.
- The absence of any in-plugin credential pre-check, and where credential gating happens instead.
- File selection: the Changes panel's checked set, its fallback, and the derivation of the unselected-tracked set.
- The index snapshot and the two restore paths (cancel, failure).
- The flush of unsaved editor buffers immediately before staging, and why it sits there rather than at flow entry.
- The empty-stage abort and its dialog.
- The delegated message generation: what is sent, what comes back, cancellation, timeout, and error classification.
- The review dialog's three actions and its message-blank rules.
- The re-stage-before-commit step, the three commit variants, the already-pushed amend warning, and the race-safe "working tree is clean" downgrade.
- Prior-staging preservation.
- The explicit IDE VCS refresh after commit and after each abort.
- The success dialog.

**Out of scope (boundaries):**
- The Changes panel itself — its data sources, its checkbox model, and the concurrency-safe collection this action reads from a background thread — owned by the changes-panel spec (122).
- Commit-message generation itself (the prompt, the model call, the credential resolution including the local-agent source) — owned by the command-line surface's commit-message spec (14) and the credential-priority spec (10).
- The post-commit summary pipeline this action's commit triggers — owned by the queue/worker specs.
- The DCO sign-off setting's storage and its UI — owned by the settings-dialog spec (135). Its (non-)effect on this action is in scope and recorded below.
- The squash action, which shares the busy-worker pre-check and the delegated-generation seam but is otherwise its own flow — spec 299.
- The delegated-invocation transport (runtime resolution, the response contract, the timeout, cancellation) — owned by the IDE-delegation spec; this spec states only what this action relies on.

## Data Contracts

### Working directory

The whole flow runs against the **current worktree root**, not the shared main-repository root. This is load-bearing: the delegated generation reads *this* worktree's staged index, and the post-commit marker files it writes must land in *this* worktree's state directory. The shared main-repository root is correct only for genuinely repo-wide state. Using it here previously produced a real defect in a multi-worktree checkout — the generated message described the wrong staged diff, and the post-commit markers were written where the firing hook would not look for them.

If the project has no base path the action returns silently (after releasing the guard).

### Re-entrancy guard

A boolean guard **per project**, held for the whole flow (staging → generation → dialog → commit) and released on every terminal path.

- It is shared across every entry point within a project — the panel button, the working-memory surface's button, and the action-system invocation each may construct their own action instance, so the guard cannot live on the instance.
- It is keyed by project rather than being a single process-wide flag, because two open windows must commit independently and a leaked flag in one must never lock the other. A process-wide flag turned any dialog-thread throw into an IDE-wide "AI commit stuck until restart".
- The guard map is never pruned; an entry survives project close so a mid-close re-entry still lands on the same flag.
- A second trigger while a flow is active is **ignored silently** (logged, no dialog).

### Selection inputs

| Input | Source | Fallback |
| --- | --- | --- |
| Selected files | The Changes panel's checked set, when non-empty. | Every changed file the project service reports. |
| All files (for computing the unselected set) | The Changes panel's full row list. | Every changed file the project service reports. |
| Unselected tracked set | Every row not in the selected set **whose status is not untracked**. Untracked files are excluded because unstaging a path that was never in the index errors. | — |

An empty selected set aborts with "No changed files to commit."

### Index snapshot

Before any staging, the flow captures two things: a tree object representing the current index, and the list of paths that were already staged. A failure to capture the index tree aborts the flow with "Could not read the current git index. Commit aborted to avoid data loss." — deliberately refusing to proceed rather than risk an unrestorable index.

### Delegated generation

The message is produced by a one-shot invocation of the command-line surface's generation entry point for the commit-message action. **The request body is empty**: the far side reads the staged diff, the changed-file list, and the branch from git itself, so the only input is the working directory. The response is a single JSON line; a success envelope carries the message, an error envelope carries a classified error name and a message.

Contract points this action depends on:
- **A generous multi-minute wall-clock budget**, because the local-agent provider drives a whole agent turn rather than a single API call. Exceeding it kills the child and surfaces a timeout error.
- **Cancellation is honoured.** The progress indicator's cancelled state is polled while waiting, and cancelling destroys the child process — otherwise a local-agent turn would keep running under a retired progress bar.
- **Exactly one error name is translated into guidance.** A local-agent authentication failure becomes "Claude Code is installed but not signed in. Open a terminal, run `claude`, and sign in with /login — or switch the AI provider in Jolli Memory settings." Every other error name passes its message through verbatim.
- A missing message in a success envelope is treated as a failure.

### Review dialog

Title "AI Commit". An editable multi-line text area pre-filled with the generated message, labelled "Edit commit message:". Four buttons:

| Button | Result |
| --- | --- |
| `Commit` (the default/OK button) | Commit with the edited message. **Blocked when the message is blank** — the dialog stays open. |
| `Amend` | Amend the previous commit with the edited message. Also blocked when blank. |
| `Amend (keep message)` | Amend the previous commit and keep its existing message. **Not** blocked on blank, since the message is unused. |
| `Cancel` | Abandon; the index is restored to the snapshot. |

## Behavior

### Enablement

The action is enabled when all of: a status snapshot exists, the repository is enabled, no summary worker is busy **for this worktree**, and the Changes panel reports at least one checked file.

The worker-busy check is deliberately keyed to the same worktree the flow will run against — otherwise a busy worker in the main checkout would grey out a sibling worktree's button and vice versa.

Enablement is computed on a **background** thread, not the UI thread, because it consults the project service and reads the worker lock — both I/O-shaped. That is also why the Changes panel's selection collection must be safe to read off the UI thread (spec 122).

### Flow

1. **Acquire the guard.** Already held ⇒ return silently.
2. **Resolve the worktree root.** Absent ⇒ release and return.
3. **Busy-worker pre-check.** A fresh worker lock ⇒ release the guard and show "AI summary is being generated. Please wait a moment."
4. **No credential pre-check.** The flow deliberately performs none. Credential gating happens on the far side, which understands the local-agent provider (no API key at all) as well as the direct and proxy sources; an in-plugin environment-variable check would wrongly reject a local-agent user.
5. **Collect the selection** and derive the unselected-tracked set. Empty selection ⇒ warn and return.
6. Everything below runs in a **cancellable background task** titled "Jolli Memory: Generating commit message...".
7. **Snapshot the index** (tree object + already-staged paths). Failure ⇒ abort with the data-loss dialog.
8. **Flush unsaved editor buffers to disk, then stage the selected paths and unstage the unselected tracked paths.** The flush is required because the two halves disagree about what "changed" means: the file-selection surface reads the IDE's in-memory change tracker, which sees unsaved buffer edits, while staging shells out to a process that only ever sees the filesystem. Its placement is deliberate — it happens *at* the staging step, not at flow entry, so a flow that aborts earlier (a busy worker, an empty selection, a failed index snapshot) never writes unrelated open buffers to disk as a side effect.
9. **Empty-stage abort.** Re-read the staged set. If it is empty, restore the index from the snapshot, refresh the IDE's git view, and show "No changes to commit — the selected files have no modifications." This is the common case where the IDE's change cache is stale right after an external commit: continuing would call the model on an empty diff and end in a confusing git error.
10. **Generate the message** (delegated, as above).
11. **Show the review dialog on the UI thread.** A throw from the dialog itself is caught in its own handler that restores the index, releases the guard, and shows "AI commit dialog failed: …". Without that bracket, a dialog throw would escape both the background task's handler and the commit block's release, leaking the guard permanently and silently disabling the action for the rest of the session.
12. On confirmation, back on a background thread:
    1. **Re-stage the selected paths** — this captures any edits the user made while the dialog was open.
    2. **Record the host-source marker** so the post-commit pipeline knows this commit came from the IDE. It is written through the shared session-state layer, not by this action.
    3. **Determine whether the current head was already pushed — before amending.** Asking afterwards would compare the freshly rewritten head against the remote and always read as unpushed.
    4. **Run the chosen commit variant.**
    5. **Race-safe downgrade.** A non-zero exit on the plain commit path whose output says there is nothing to commit is treated as a race: an external process cleaned the working tree while the dialog was open. Restore the index, refresh the IDE's git view, and show "No changes to commit — the working tree is clean." Every other non-zero exit, and every failure on the two amend paths, is surfaced as an error.
    6. **Already-pushed amend warning.** When an amend rewrote a head that was already pushed: "Commit amended. The original was already pushed — you'll need to force push to update the remote."
    7. **Preserve prior staging.** Any path that was staged before the flow but is not part of this commit is re-staged.
    8. **Refresh the IDE's git view** (below).
    9. Show "Committed! Post-commit hook is generating a summary in the background." and refresh status.
13. On cancellation, restore the index from the snapshot and release the guard.

Any failure inside the commit block restores the index from the snapshot and shows "Commit failed: …". Failures before the dialog show "Failed: …".

### The IDE git-state refresh

Every commit and every abort path ends with an explicit three-part nudge to the IDE: refresh the worktree root's virtual-file subtree recursively, update each git repository the IDE knows about, and mark the whole change scope dirty.

This is required because the commit runs in an **external** git process the IDE cannot observe. Without the nudge the IDE's change tracker keeps reporting the just-committed files, so the Changes panel re-offers them and the very next AI Commit attempt fails with "nothing to commit". The nudge runs on a background thread (updating a repository re-reads git metadata synchronously) and its failures only log — a missed refresh degrades to the old stale-panel behavior rather than breaking the commit.

## State Transitions

```
[disabled] ── no snapshot / not enabled / worker busy (this worktree) / nothing checked
[enabled]  ── all four satisfied

[trigger] ──guard already held──────────────► ignored silently
[trigger] ──guard acquired──────────────────► [staging]

[staging] ──index snapshot failed───────────► abort (data-loss dialog), guard released
          ──unsaved editor buffers flushed to disk (only once staging is actually reached)──
[staging] ──staged set empty────────────────► index restored, IDE refreshed,
                                              "No changes to commit — the selected files
                                               have no modifications.", guard released
                                              (now reachable only when the files genuinely
                                               have no modifications on disk)
[staging] ──staged──────────────────────────► [generating]

[generating] ──error envelope / no message──► "Failed: …", index untouched, guard released
[generating] ──user cancels progress────────► process killed, guard released
[generating] ──timeout──────────────────────► process killed, "Failed: …", guard released
[generating] ──message────────────────────── ► [review dialog]

[review dialog] ──Cancel───────────────────► index restored, guard released
[review dialog] ──dialog threw─────────────► index restored, error dialog, guard released
[review dialog] ──Commit / Amend / Amend-keep► [committing]

[committing] ──"nothing to commit" on plain commit──► index restored, IDE refreshed,
                                                      "…the working tree is clean.",
                                                      guard released
[committing] ──other non-zero exit / throw──► index restored, "Commit failed: …", guard released
[committing] ──success──────────────────────► prior staging restored, IDE refreshed,
                                              success dialog, status refreshed, guard released
[committing] ──success after amend of a pushed head──► additional force-push notice
```

## Notable Behavior

- **The flow runs against the current worktree, and that fixed a real defect.** It previously ran against the shared main-repository root, which meant the generated message was derived from the wrong staged diff and the post-commit marker files were written where the firing hook would not read them. Every worktree now commits against its own index and its own state directory.
- **There is no credential pre-check in the plugin, deliberately.** Gating is entirely on the far side, which supports a local-agent provider that has no API key at all. The retired in-plugin check tested for a direct key, a platform key, and an environment variable — and would have rejected precisely the local-agent user the delegated path handles fine.
- **A second trigger is ignored, not queued and not reported.** Multiple entry points can fire within a beat; each would otherwise open its own dialog and race on the same files. The user sees nothing.
- **The guard is per project because a process-wide one was a fleet-wide outage.** A throw on the dialog thread leaked the flag; with a single static flag that disabled AI Commit in every open window until the IDE restarted.
- **The dialog step has its own exception bracket.** Because showing the dialog is scheduled rather than called inline, a throw there is outside both the background task's handler and the commit block's release. The bracket exists solely to guarantee the guard is released and the index restored on that path.
- **Two separate "nothing to commit" outcomes exist, at different points, with different copy.** The pre-generation one ("the selected files have no modifications") catches a stale change cache before spending a model call. The post-dialog one ("the working tree is clean") catches an external process cleaning the tree while the dialog was open. Both restore the index and refresh the IDE; neither is presented as an error.

  The pre-generation one used to fire for a second, wrong reason: **an unsaved edit appeared in the selection surface yet staged nothing**, because the surface reads the in-memory change tracker while staging reads the filesystem, so the flow aborted with "the selected files have no modifications" over a file the user could plainly see was modified. Flushing unsaved buffers immediately before staging removed that case, and the abort is now reachable only when the files genuinely have no modifications on disk.
- **The clean-tree downgrade applies only to the plain commit path.** An amend that fails for the same reason is surfaced as an error, because an amend of a clean tree is not a benign race.
- **Whether the head was pushed is checked before the amend, not after.** Checked afterwards it would always read as unpushed, and the force-push warning would never appear.
- **Files are staged twice.** Once before generation (so the model sees the right diff) and again after the dialog closes (so edits made while the dialog was open are included). The second staging can therefore change what is committed relative to what the message describes.
- **Staging that predates the flow is restored, not lost.** Paths staged before the action ran that are not part of this commit are re-staged afterwards, so the action does not silently unstage a user's unrelated work.
- **The index snapshot is the only safety net, and a failure to take it aborts the flow.** The action would rather refuse than proceed without a restore point.
- **Enablement runs on a background thread, which constrains the Changes panel.** The selection collection this action reads must tolerate being read off the UI thread while UI-thread refreshes rebuild it; that requirement originates here (spec 122).
- **The success dialog promises a background summary.** It says the post-commit hook is generating one — an assertion about the far side, not about anything this action verified.
- **The DCO sign-off setting has no effect on this action.** None of the three commit variants adds a sign-off flag, and nothing on this surface reads the setting at commit time. The setting is persisted to the shared configuration and is honoured by the other host surface's commit, amend, and squash paths — so a user who enables the checkbox in this IDE's settings gets signed-off commits from that surface and unsigned commits from this one, despite the checkbox label explicitly naming "commit / amend / squash".

## Shared Behavior

- **Changes panel (spec 122)** — supplies the checked selection and the full row list; its concurrency-safe selection collection exists because this action's enablement check reads it off the UI thread.
- **Commit-message generation (spec 14)** — the single implementation of the prompt, the model call, and the output contract, reached here by a one-shot delegated invocation. This surface contributes the review dialog, the staging snapshot/restore, the re-entrancy guard, and the error classification.
- **Credential priority (spec 10)** — resolves which credential drives generation, including the local-agent source this surface has no in-process support for.
- **Session-state layer** — writes the host-source marker this action records before committing; the marker file has one writer, on the far side.
- **Post-commit queue and worker** — consume the commit and the host-source marker to produce the summary the success dialog refers to.
- **Squash action (spec 299)** — shares the busy-worker pre-check, the worktree-root choice, the delegated-generation seam, and the error classification.
- **Settings dialog (spec 135)** — owns the DCO sign-off preference's UI and persistence. This action does not consult it, so the preference does not affect commits made here.

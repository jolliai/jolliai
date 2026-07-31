# 299. IntelliJ Squash Action

## Topic Statement

The IDE plugin's "Squash" action: a **two-step gesture** whose first activation only turns on the commits panel's squash-selection mode (revealing the per-row checkboxes), and whose second activation takes the range the user then checked, warns before rewriting already-pushed history, obtains a consolidated commit message from the command-line surface, offers a two-way dialog (Squash / Squash & Push), then resets to the oldest selected commit's parent and re-commits in process — writing the squash-pending and host-source markers first so the post-commit pipeline knows to consolidate the source memories rather than summarize a new commit from scratch. The mode is switched off again when the operation finishes, however it finishes.

## Scope

**In scope:**
- The action's enablement rule and the thread it is computed on.
- The two-step gesture: which activation turns the commits panel's squash-selection mode on, which one runs the rewrite, which ones do nothing, and the one case that still falls through to the pre-existing single-activation behavior.
- Where the commit count that gates the two-step guard is read from, and the fallback used before the panel's own list has loaded.
- Turning the selection mode off again on every terminal outcome, including the squash-succeeded-but-push-failed one.
- The working directory the flow runs against, and why that choice matters in a multi-worktree checkout.
- The busy-worker pre-check, the foreign-mode bail-out, and the minimum-commit-count check.
- The absence of any in-plugin credential gate, and the narrowing that the retired gate caused.
- The already-pushed force-push warning dialog: its copy, its button label, and its sizing rule.
- The delegated message generation: the oldest-first hash list it sends, what it does *not* send, cancellation, timeout, and error classification.
- The two-action confirmation dialog and its blank-message rule.
- The telemetry event recorded on confirmation.
- The state snapshot (index tree + head) and the restore-on-failure path.
- Fork-point resolution, including the root-commit case.
- The two pre-commit markers, written through the shared session-state layer.
- The reset-and-commit sequence, the optional force push, and the partial-success outcome when the push fails.
- The success dialog.

**Out of scope (boundaries):**
- The commits panel that supplies the selection, its range-selection rules, the on-screen appearance of squash-selection mode (the checkboxes, the control strip with its live count / Squash / Cancel controls), and its foreign (read-only) mode — owned by the commits-panel spec (123). This spec owns only which activation of *this* action flips that mode and when the mode is switched back off.
- Squash-message generation itself (the prompt, the model call, the credential resolution including the local-agent source) — owned by the command-line surface's generation path and the credential-priority spec (10).
- Summary consolidation — how the source memories are merged into one, the expansion, the hoisting, the mechanical fallback — owned by the squash-consolidation spec (13). This action only produces the commit and the pending marker that trigger it.
- The squash-pending marker's on-disk shape and the hook that consumes it — owned by the queue/worker and commit-message-preparation specs.
- The AI commit action, which shares the busy-worker pre-check, the worktree-root choice, and the delegated-generation seam — spec 298.
- The delegated-invocation transport (runtime resolution, response contract, timeout, cancellation) — owned by the IDE-delegation spec.

## Data Contracts

### Working directory

The flow runs against the **current worktree root**, not the shared main-repository root. This is load-bearing: the post-commit hook fires from the worktree and reads the squash-pending marker from *that* worktree's state directory. Writing the marker anywhere else means the hook finds nothing and the squash is summarized as an ordinary commit instead of a consolidation. Using the shared main-repository root here previously produced exactly that defect in a multi-worktree checkout.

If the project has no base path the action returns silently.

### The two-step gesture

Activating the action does one of four things, decided before anything is generated or rewritten:

| Condition on activation | Outcome |
| --- | --- |
| The commits panel is present, the branch has ≥2 commits, and selection mode is **off** | Turn selection mode on and **stop**. Nothing is generated, nothing is rewritten, no dialog appears. |
| The commits panel is present, the branch has ≥2 commits, selection mode is **on**, fewer than 2 commits checked | Do nothing, silently. No dialog — the control strip already tells the user to pick two or more, so a second message would be redundant. |
| The commits panel is present, the branch has ≥2 commits, selection mode is **on**, 2 or more checked | Run the whole flow below against exactly those checked commits. |
| The commits panel is absent, or the branch has fewer than 2 commits | Fall through to the pre-existing single-activation behavior: use the panel's selection if it is non-empty, else every commit on the branch — which then fails the two-commit minimum and warns. |

Because turning the mode on also clears any prior selection, the first activation never leaves a set of commits already checked.

**Why the gesture is two-step.** Previously a single activation with nothing selected fell straight through to "every commit on the branch": one click rewrote the **entire** branch's history and consolidated every one of its memories — irreversible, and on an unpushed branch it did so without even showing the force-push warning, because no commit was pushed. Requiring the user to see checkboxes appear and check the specific memories closes that.

**Where the commit count comes from.** The ≥2 test reads the commits panel's **already-loaded** list rather than re-running the branch listing, which is a multi-step git round-trip plus a stored-memory read per commit and would be paid on the UI thread by every "just turn the mode on" activation. Because that list is populated asynchronously, it is empty for a short window after the tool window opens; in that window the action *does* pay for the real listing once. Without that fallback a count of zero would look like "fewer than 2 commits" and skip the guard entirely — precisely when the panel looks empty.

### Commit selection and ordering

| Input | Source | Fallback |
| --- | --- | --- |
| Commits to squash | The commits panel's selected range, when non-empty. | Every commit on the branch. |

Both sources return **newest-first**. The action reverses to oldest-first for every downstream use: the hash list sent for generation, the fork-point derivation, and the marker.

Fewer than two commits aborts with "Need at least 2 commits to squash."

If the commits panel is in foreign (read-only) mode the action returns silently — a foreign repository's history is not this project's to rewrite.

### Leaving selection mode

Selection mode is turned back off, dropping whatever was checked, on every terminal outcome of a run that got as far as committing:

- The squash succeeded (with or without the requested push).
- The squash succeeded but the follow-up force push **failed** — the history was already rewritten, so from the panel's point of view the operation is over.

This keeps the action symmetric with the control strip's own Cancel control and stops a stale set of checkboxes from feeding the next activation. Every earlier exit (declined force-push warning, generation failure, cancelled or blank confirmation, snapshot failure, unresolvable fork point, failed reset/commit) leaves the mode as it was, so the user's selection survives a retry.

### Force-push warning

When any selected commit is already pushed, a modal appears before anything else happens. Its body is:

- "\<N\> of the selected commit(s) have already been pushed to remote:", then
- one bullet per pushed commit as `• <short-hash> <first 60 characters of the subject>`, then
- "Squashing will rewrite history. You will need to force push afterwards." and "This may affect collaborators on the same branch."

The confirm button reads **"Continue (I know force push is needed)"**. A warning icon sits to the left of the text. The body auto-sizes to its natural height and only grows a scroll bar when that height would exceed two-thirds of the screen. Declining returns without any change.

### Delegated generation

The message is produced by a one-shot invocation of the command-line surface's generation entry point for the squash-message action. The request carries **only the oldest-first list of source commit hashes**. Everything else — each hash's commit subject, each hash's stored memory, the ticket identifier, and whether this is a full-branch squash — is re-derived on the far side from that same range. The host deliberately does not read them: doing so would duplicate one stored-memory read per commit on every squash.

The response is a single JSON line; a success envelope carries the message, an error envelope carries a classified error name and message. The same transport contract as the commit action applies: a generous multi-minute budget (the local-agent provider drives a whole agent turn), a polled cancellation that destroys the child, and one error name — a local-agent authentication failure — translated into sign-in guidance while every other message passes through verbatim.

**Generation failure aborts the squash.** There is no mechanical-message fallback on this surface: the error is shown as "Failed to generate squash message: …" and nothing is rewritten.

### Confirmation dialog

Title "Squash \<N\> Commits". An editable multi-line text area pre-filled with the generated message, labelled "Edit squash commit message:". Buttons:

| Button | Result |
| --- | --- |
| `Squash` (the default/OK button) | Reset and commit. |
| `Squash & Push` | Reset, commit, then force-push with lease. |
| `Cancel` | Abandon; nothing has been changed yet. |

A blank message after either confirm button silently abandons the flow (no dialog, no change).

### State snapshot

Before the rewrite the flow captures the current index as a tree object **and** the current head hash. A failure to capture either aborts with "Could not snapshot the current git state. Squash aborted to avoid data loss."

### Fork point

The reset target is the **parent of the oldest selected commit**, not the merge base with the trunk. Using the merge base would reset every commit on the branch rather than only the selected ones.

Two cases:
- **Normal:** the oldest commit has a parent; that parent is the reset target. A parent that cannot be resolved aborts with "Failed to resolve parent of oldest commit (\<hash\>)."
- **Root commit:** the oldest selected commit has no parent. There is nothing to reset to, so the head reference is deleted outright, leaving the index populated and no commit — the subsequent commit then creates a fresh root.

### Pre-commit markers

Two markers are recorded before the rewrite, both **through the shared session-state layer** rather than written by this action:

1. A **host-source marker**, so the post-commit pipeline knows the operation came from this IDE.
2. A **squash-pending marker** carrying the oldest-first source hash list and an expected-parent hash — the fork point, or the oldest commit's own hash in the root-commit case.

## Behavior

### Enablement

Enabled when all of: a status snapshot exists, the repository is enabled, no summary worker is busy **for this worktree**, the commits panel is not in foreign mode, and **the branch is not already fully merged into the mainline**. The worker-busy check is keyed to the same worktree the flow will run against, so a busy worker in a sibling checkout does not grey out this one's button.

The merged-branch condition is new. Selection mode refuses to open on a merged branch (the panel treats that as a read-only history view), so without disabling the control an activation there would turn nothing on and then fall out without a message — a button that looks live and does nothing. Disabling it says so up front.

### Flow

1. Resolve the worktree root; absent ⇒ return.
2. **Busy-worker pre-check** ⇒ "AI summary is being generated. Please wait a moment."
3. **Foreign-mode bail-out** ⇒ return silently.
4. **Two-step gate** (see the contract above): turn selection mode on and stop; or no-op silently; or continue with the checked commits; or fall through.
5. **Collect commits** (the checked range, else the whole branch). Fewer than two ⇒ warn and return.
6. **Force-push warning** when any selected commit is already pushed. Declining ends the flow.
7. Everything below runs in a **non-cancellable background task** titled "Jolli Memory: Squashing...".
8. **Generate the consolidated message** (delegated, as above). Failure ⇒ error dialog, flow ends, nothing rewritten.
9. **Show the confirmation dialog on the UI thread.** Cancel or a blank message ⇒ flow ends.
10. **Record a telemetry event** naming the squash and a bucketed commit count (the exact count is not sent).
11. On a background thread:
    1. **Snapshot** the index tree and head. Failure ⇒ data-loss dialog, flow ends.
    2. **Resolve the fork point** (or detect the root-commit case). Failure ⇒ error dialog, flow ends.
    3. **Write the host-source and squash-pending markers.**
    4. **Reset**: soft-reset to the fork point, or delete the head reference in the root case.
    5. **Commit** with the edited message.
    6. Any failure in steps 4–5 ⇒ soft-reset back to the original head, restore the index from the snapshot, and show "Squash failed: \<message\>" followed by "Your staging area and HEAD have been restored."
    7. **Optional force push**, when the user chose Squash & Push: push with lease under a bounded timeout. A push failure is a **partial success** — "Squash succeeded but push failed. You can push manually." — and the flow ends there without any rollback, because the squash itself succeeded. **Selection mode is turned off** on this path too.
    8. Show "\<N\> commits squashed" (or "squashed and pushed") followed by "Post-commit hook is merging summaries in the background.", **turn selection mode off**, and refresh status.

## State Transitions

```
[disabled] ── no snapshot / not enabled / worker busy (this worktree) /
              commits panel foreign / branch already merged into mainline
[enabled]  ── all five satisfied

[trigger] ──worker busy──────────────────────► warning dialog
[trigger] ──foreign mode─────────────────────► silent return

  ── two-step gate (panel present, branch has ≥2 commits) ──
[trigger] ──selection mode OFF───────────────► selection mode ON (selection cleared), STOP
                                               (nothing generated, nothing rewritten)
[trigger] ──mode ON, <2 checked──────────────► silent no-op (strip already says "pick 2+")
[trigger] ──mode ON, ≥2 checked──────────────► [collect the checked commits]
  ── fall-through (panel absent, or branch has <2 commits) ──
[trigger] ────────────────────────────────────► [collect: selection if any, else whole branch]

[collect] ──fewer than 2 commits─────────────► warning dialog
[collect] ──any commit already pushed────────► [force-push warning]
[force-push warning] ──declined──────────────► no change (mode left as it was)
[force-push warning] ──confirmed─────────────► [generating]
[collect] ──none pushed──────────────────────► [generating]

[generating] ──error / empty message─────────► "Failed to generate squash message: …", no change
[generating] ──message───────────────────────► [confirmation dialog]

[confirmation dialog] ──Cancel / blank───────► no change (mode left as it was)
[confirmation dialog] ──Squash───────────────► [rewriting] (push = no)
[confirmation dialog] ──Squash & Push────────► [rewriting] (push = yes)

[rewriting] ──snapshot failed────────────────► data-loss dialog, no change (mode left on)
[rewriting] ──fork point unresolvable────────► error dialog, no change (markers not yet written,
                                               mode left on)
[rewriting] ──reset or commit failed─────────► head + index restored, "…have been restored.",
                                               markers ALREADY WRITTEN and left behind,
                                               mode left on
[rewriting] ──committed, push = no───────────► success dialog, SELECTION MODE OFF, status refreshed
[rewriting] ──committed, push failed─────────► "Squash succeeded but push failed."
                                               (no rollback), SELECTION MODE OFF, status refreshed
[rewriting] ──committed and pushed───────────► success dialog, SELECTION MODE OFF, status refreshed
```

## Notable Behavior

- **The gesture is two-step, and that closed an irreversible one-click whole-branch rewrite.** The first activation only reveals the checkboxes; the second runs. Previously one activation with nothing selected fell through to "every commit on the branch", rewriting the whole branch's history and consolidating every memory in it — and on an unpushed branch it did so without even the force-push warning, since nothing was pushed to warn about. The "in mode with fewer than two checked" case is a deliberate silent no-op rather than a dialog, because the control strip is already telling the user to pick two or more. (Notable; the fix is the reason the extra click exists.)
- **The commit count that gates the guard comes from the panel's already-loaded list, with a real listing as the cold-start fallback.** Re-running the branch listing on every "just turn the mode on" activation would put a multi-step git round-trip plus a per-commit stored-memory read on the UI thread. But the panel's list is loaded asynchronously and is briefly empty after the tool window opens, and a count of zero would read as "fewer than 2 commits" and skip the guard entirely — exactly in the window where the panel looks empty. So an unloaded panel pays for the listing once rather than losing the protection. (Notable.)
- **Enablement now also disables on an already-merged branch.** Selection mode refuses to open there, so without this the button would look live, turn nothing on, and fall out silently — a dead control with no explanation. (Notable.)
- **The control strip's own Squash control re-activates this same registered action rather than having a private path.** It therefore inherits every one of this action's conditions, while its own enabled state tracks only "two or more checked" — so it can look available while a summary worker is busy for this worktree, even though the action's own control would be greyed out. That does not leave the user without an answer: the busy-worker condition is re-checked as the very first step of the flow and produces the "wait a moment" warning, so a click on that path is explained rather than ignored. Whether the platform declines to run an action it considers disabled before the handler is entered at all is a platform contract, and not observable from this repository — so the two enabled states being different predicates is the defensible finding, not a silent dead control. (Notable.)
- **Selection mode is switched off when the operation finishes — including when the squash succeeded but the push failed.** The history has already been rewritten on that path, so the operation is over from the panel's point of view; leaving the checkboxes up would hand the next activation a stale selection. Every earlier exit deliberately leaves the mode alone so a retry keeps the user's picks.
- **The mode itself survives a background refresh; only the selection is dropped.** A refresh that finds a different commit sequence (a rebase, an amend, a new commit, a branch switch) clears what was checked but does not turn the mode off, so the checkboxes stay up and empty. (Notable.)
- **The flow runs against the current worktree, and that fixed a real defect.** It previously ran against the shared main-repository root, so the squash-pending marker was written where the firing post-commit hook does not look. The consequence was silent and confusing: the squash succeeded but its memories were never consolidated — the new commit got summarized from scratch and the source memories were left as-is.
- **The retired credential gate ignored two of the three credential sources.** The previous in-plugin gate checked only for a configured direct API key. A user signed in to the platform (proxy credential) or using a local-agent subscription was refused a squash they were fully entitled to. Delegating the gate removed that narrowing: the far side resolves all three sources uniformly, and this action performs no credential check at all.
- **Generation failure aborts; there is no host-side fallback message.** The consolidation pipeline on the far side has a mechanical fallback for a failed *consolidation*, but this action has none for a failed *message generation* — a failed call means nothing is rewritten. That is deliberate: rewriting history under a placeholder message is worse than not rewriting.
- **The reset target is the oldest selected commit's parent, not the trunk merge base.** The merge base would swallow every commit on the branch. This is what makes a partial-range squash possible.
- **A root-commit squash deletes the head reference instead of resetting.** With no parent there is nothing to reset to; the index survives the deletion, so the following commit produces a fresh root commit. The squash-pending marker's expected-parent field carries the oldest commit's own hash in this case, since there is no parent to name.
- **The markers are written before the rewrite and are not cleaned up if the rewrite fails.** Steps 4–5 restore the head and index, but the host-source and squash-pending markers stay on disk. A subsequent unrelated commit in that worktree can therefore be interpreted as the squash the marker describes. The fork-point failure path, by contrast, aborts *before* writing them.
- **A failed push after a successful squash is not rolled back.** The history has already been rewritten locally; undoing it would be more destructive than leaving the user to push manually. The message says exactly that.
- **The force-push warning shows only the pushed subset, capped per line.** Each bullet carries the short hash and the first 60 characters of the subject; the dialog does not list the unpushed commits at all.
- **The warning dialog's confirm button is deliberately verbose.** "Continue (I know force push is needed)" is an acknowledgement, not an "OK" — the wording is part of the contract.
- **The warning body sizes itself and only scrolls past two-thirds of the screen height.** A three-commit warning shows as a compact modal; a fifty-commit warning grows to two-thirds height and then scrolls.
- **The background task is not cancellable, unlike the commit action's.** Once the squash task starts there is no user-facing cancel — although the generation step still honours the indicator's cancelled state internally, so a cancellation arriving from elsewhere does kill the child process.
- **Telemetry records a bucketed count, not the exact number of commits.** The commit count is coarsened before it leaves the process.
- **The success dialog promises background consolidation.** It says the post-commit hook is merging summaries — an assertion about the far side, not something this action verified.
- **The DCO sign-off setting has no effect here.** The squash commit is created without a sign-off flag, and nothing on this surface reads the setting. The same preference *is* honoured by the other host surface's squash. (See spec 135.)

## Shared Behavior

- **Commits panel (spec 123)** — supplies the selected range, the per-commit pushed flag, the loaded commit count the two-step guard reads, the already-merged signal enablement now keys on, and the foreign-mode signal this action bails out on. It also owns the on-screen selection mode this action turns on and off, and its control strip re-dispatches this same action.
- **Squash-message generation** — the single implementation of the consolidated-message prompt and model call, reached here by a one-shot delegated invocation carrying only the oldest-first hash list.
- **Credential priority (spec 10)** — resolves which credential drives generation, uniformly across the direct, proxy, and local-agent sources. This action performs no gate of its own.
- **Squash consolidation (spec 13)** — the single implementation that merges the source memories into one. This action is a *producer* for it: the squash-pending marker and the resulting commit are its trigger. There is no host-side consolidation logic.
- **Session-state layer** — the single writer of the host-source and squash-pending markers this action records.
- **Commit-message-preparation hook and post-commit worker** — consume the squash-pending marker and run the consolidation the success dialog refers to.
- **AI commit action (spec 298)** — shares the busy-worker pre-check, the worktree-root choice, the delegated-generation seam, and the error classification; differs in having a re-entrancy guard (this action has none) and a cancellable task.

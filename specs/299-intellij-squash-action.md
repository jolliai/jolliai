# 299. IntelliJ Squash Action

## Topic Statement

The IDE plugin's "Squash" action: it takes the commits panel's selected range (or the whole branch), warns before rewriting already-pushed history, obtains a consolidated commit message from the command-line surface, offers a two-way dialog (Squash / Squash & Push), then resets to the oldest selected commit's parent and re-commits in process — writing the squash-pending and host-source markers first so the post-commit pipeline knows to consolidate the source memories rather than summarize a new commit from scratch.

## Scope

**In scope:**
- The action's enablement rule and the thread it is computed on.
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
- The commits panel that supplies the selection, its range-selection rules, and its foreign (read-only) mode — owned by the commits-panel spec (123).
- Squash-message generation itself (the prompt, the model call, the credential resolution including the local-agent source) — owned by the command-line surface's generation path and the credential-priority spec (10).
- Summary consolidation — how the source memories are merged into one, the expansion, the hoisting, the mechanical fallback — owned by the squash-consolidation spec (13). This action only produces the commit and the pending marker that trigger it.
- The squash-pending marker's on-disk shape and the hook that consumes it — owned by the queue/worker and commit-message-preparation specs.
- The AI commit action, which shares the busy-worker pre-check, the worktree-root choice, and the delegated-generation seam — spec 298.
- The delegated-invocation transport (runtime resolution, response contract, timeout, cancellation) — owned by the IDE-delegation spec.

## Data Contracts

### Working directory

The flow runs against the **current worktree root**, not the shared main-repository root. This is load-bearing: the post-commit hook fires from the worktree and reads the squash-pending marker from *that* worktree's state directory. Writing the marker anywhere else means the hook finds nothing and the squash is summarized as an ordinary commit instead of a consolidation. Using the shared main-repository root here previously produced exactly that defect in a multi-worktree checkout.

If the project has no base path the action returns silently.

### Commit selection and ordering

| Input | Source | Fallback |
| --- | --- | --- |
| Commits to squash | The commits panel's selected range, when non-empty. | Every commit on the branch. |

Both sources return **newest-first**. The action reverses to oldest-first for every downstream use: the hash list sent for generation, the fork-point derivation, and the marker.

Fewer than two commits aborts with "Need at least 2 commits to squash."

If the commits panel is in foreign (read-only) mode the action returns silently — a foreign repository's history is not this project's to rewrite.

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

Enabled when all of: a status snapshot exists, the repository is enabled, no summary worker is busy **for this worktree**, and the commits panel is not in foreign mode. The worker-busy check is keyed to the same worktree the flow will run against, so a busy worker in a sibling checkout does not grey out this one's button.

### Flow

1. Resolve the worktree root; absent ⇒ return.
2. **Busy-worker pre-check** ⇒ "AI summary is being generated. Please wait a moment."
3. **Foreign-mode bail-out** ⇒ return silently.
4. **Collect commits** (selected range, else the whole branch). Fewer than two ⇒ warn and return.
5. **Force-push warning** when any selected commit is already pushed. Declining ends the flow.
6. Everything below runs in a **non-cancellable background task** titled "Jolli Memory: Squashing...".
7. **Generate the consolidated message** (delegated, as above). Failure ⇒ error dialog, flow ends, nothing rewritten.
8. **Show the confirmation dialog on the UI thread.** Cancel or a blank message ⇒ flow ends.
9. **Record a telemetry event** naming the squash and a bucketed commit count (the exact count is not sent).
10. On a background thread:
    1. **Snapshot** the index tree and head. Failure ⇒ data-loss dialog, flow ends.
    2. **Resolve the fork point** (or detect the root-commit case). Failure ⇒ error dialog, flow ends.
    3. **Write the host-source and squash-pending markers.**
    4. **Reset**: soft-reset to the fork point, or delete the head reference in the root case.
    5. **Commit** with the edited message.
    6. Any failure in steps 4–5 ⇒ soft-reset back to the original head, restore the index from the snapshot, and show "Squash failed: \<message\>" followed by "Your staging area and HEAD have been restored."
    7. **Optional force push**, when the user chose Squash & Push: push with lease under a bounded timeout. A push failure is a **partial success** — "Squash succeeded but push failed. You can push manually." — and the flow ends there without any rollback, because the squash itself succeeded.
    8. Show "\<N\> commits squashed" (or "squashed and pushed") followed by "Post-commit hook is merging summaries in the background.", and refresh status.

## State Transitions

```
[disabled] ── no snapshot / not enabled / worker busy (this worktree) / commits panel foreign
[enabled]  ── all four satisfied

[trigger] ──worker busy──────────────────────► warning dialog
[trigger] ──foreign mode─────────────────────► silent return
[trigger] ──fewer than 2 commits─────────────► warning dialog
[trigger] ──any commit already pushed────────► [force-push warning]
[force-push warning] ──declined──────────────► no change
[force-push warning] ──confirmed─────────────► [generating]
[trigger] ──none pushed──────────────────────► [generating]

[generating] ──error / empty message─────────► "Failed to generate squash message: …", no change
[generating] ──message───────────────────────► [confirmation dialog]

[confirmation dialog] ──Cancel / blank───────► no change
[confirmation dialog] ──Squash───────────────► [rewriting] (push = no)
[confirmation dialog] ──Squash & Push────────► [rewriting] (push = yes)

[rewriting] ──snapshot failed────────────────► data-loss dialog, no change
[rewriting] ──fork point unresolvable────────► error dialog, no change (markers not yet written)
[rewriting] ──reset or commit failed─────────► head + index restored, "…have been restored.",
                                               markers ALREADY WRITTEN and left behind
[rewriting] ──committed, push = no───────────► success dialog, status refreshed
[rewriting] ──committed, push failed─────────► "Squash succeeded but push failed."
                                               (no rollback), status refreshed
[rewriting] ──committed and pushed───────────► success dialog, status refreshed
```

## Notable Behavior

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

- **Commits panel (spec 123)** — supplies the selected range, the per-commit pushed flag, and the foreign-mode signal this action bails out on.
- **Squash-message generation** — the single implementation of the consolidated-message prompt and model call, reached here by a one-shot delegated invocation carrying only the oldest-first hash list.
- **Credential priority (spec 10)** — resolves which credential drives generation, uniformly across the direct, proxy, and local-agent sources. This action performs no gate of its own.
- **Squash consolidation (spec 13)** — the single implementation that merges the source memories into one. This action is a *producer* for it: the squash-pending marker and the resulting commit are its trigger. There is no host-side consolidation logic.
- **Session-state layer** — the single writer of the host-source and squash-pending markers this action records.
- **Commit-message-preparation hook and post-commit worker** — consume the squash-pending marker and run the consolidation the success dialog refers to.
- **AI commit action (spec 298)** — shares the busy-worker pre-check, the worktree-root choice, the delegated-generation seam, and the error classification; differs in having a re-entrancy guard (this action has none) and a cancellable task.

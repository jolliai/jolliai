# VS Code Push Command With force-with-lease

## Topic Statement

The Push action that detects whether a normal push will succeed and, when a force-push is genuinely required, only proceeds after a modal warning that names the commit at risk and the reason the rewrite is happening — every force-push runs with a "lease on the remote ref" so a teammate's pushed commit cannot be silently overwritten.

## Scope

**In scope:**
- The pre-flight guards: worker-busy guard, "branch has at least one commit ahead of base", and the implicit precondition that the current branch has an upstream the action can target.
- Two entry points to the warning modal: "the head commit is already on the remote" (force-push is required up-front) and "the normal push was rejected as non-fast-forward" (force-push is offered as a fallback).
- The pre-force-push divergence probe shared by both entry points, its three shapes (behind-only / diverged / clean rewrite) and the inconclusive-probe fallback.
- The **blocked** outcome (behind-only refusal) and its distinct refusal modal, versus the confirm/decline outcomes of the force-push modal.
- The exact contents of the modal — what it shows about the commit, the conditional lost-commits detail line, why a force-push is happening, and the affirmative button label.
- The detail-line wording that differs between a single-commit branch and a multi-commit branch.
- The lease semantics that the affirmative button promises: a force-push is only executed if the remote ref still points where the local replica thought it did.
- Cancellation paths from the modal (Cancel, click-away, Escape) and the caller's behavior afterwards.
- The error path when a normal push fails for a reason other than non-fast-forward.
- The success notification distinguishing "pushed" from "force-pushed" and the panel refreshes that follow.

**Out of scope:**
- The Squash action's own modal that warns about force-pushing already-pushed commits before the squash even starts. Squash & Push is a different code path with its own preconditions.
- The lock-file guard mechanics (lock location, staleness, probe failure semantics) — that is the lock-file guard topic.
- How "is this commit already on the remote?" is computed under the hood (which ref, which transport).
- The summary panel's own push-to-cloud action, which targets Jolli Memory and is unrelated to the git remote push.
- Any source-control panel push affordance built into the editor, including its own confirmation dialogs.

## Data Contracts

### Pre-flight inputs

The action consumes a snapshot of the branch commits — newest first — that lists every commit between the upstream's tip and HEAD. Each commit carries:

- A short hash (a stable identifier shown to the user).
- Its commit message (truncated to 80 characters when shown in the modal).
- A flag indicating whether the commit is reachable from the upstream tracking ref (i.e. "is this commit already on the remote?").

If the snapshot is empty, the branch has nothing ahead of the upstream and the action exits with a warning ("No commits to push on the current branch.").

### The warning modal

Two trigger paths share a single modal layout:

| Field | Content |
| --- | --- |
| Heading | "This operation may rewrite remote history." |
| Detail line | Single-commit branch: `Commit: <shortHash> <message-truncated-to-80-chars>`. Multi-commit branch: `HEAD (N commits): <shortHash> <message-truncated-to-80-chars>`. |
| Lost-commits detail line (conditional) | Appended only when the divergence probe (below) found remote-only commits a force-push would drop: `Warning: this will permanently delete <N> commit(s) that exist only on the remote.` |
| Reason line | Trigger-specific: "HEAD is already on remote. Force push will rewrite remote branch history." (up-front trigger), or "Remote branch has diverged. Force push will overwrite remote history." (rejected-fallback trigger). |
| Footer | "This may affect collaborators on the same branch." |
| Affirmative button | "Force Push (--force-with-lease)" |
| Implicit Cancel | The modal's standard Cancel / Esc / click-away. |

The modal is **modal**: nothing in the editor advances until the user picks one option.

### The pre-force-push divergence probe

Before **either** trigger shows the force-push modal, a divergence probe runs so the action can distinguish a genuine history rewrite (safe to force-push) from a branch that is merely behind a collaborator's new commits (must rebase, never force). The probe:

1. Refreshes just this branch's remote-tracking ref (fetches the one branch), because the rejection means the *real* remote has moved and the local tracking ref may be stale.
2. Counts **remote-only** commits (on the remote tip, missing from local HEAD — the commits a force-push would permanently drop) and **local-only** commits (on local HEAD, missing from the remote tip).

It yields one of three shapes:

| Probe shape | Condition | Consequence |
| --- | --- | --- |
| **Behind-only** | remote-only > 0 **and** local-only == 0 | The branch was not rewritten, it is simply behind. **Refuse**: show a distinct modal warning (below), do **not** offer force-push, return the **blocked** outcome. |
| **Diverged** | remote-only > 0 **and** local-only > 0 | A real rewrite that would also drop remote commits. Show the force-push modal **with** the lost-commits detail line naming the remote-only count. |
| **Clean rewrite** | remote-only == 0 | A rewrite that drops nothing on the remote. Show the force-push modal with no lost-commits line. |

When the probe is **inconclusive** (detached HEAD, no remote-tracking ref, git/network error), it falls back to the plain force-push modal (no lost-commits line) rather than blocking — a legitimate rewrite is never blocked by a transient probe failure.

### The behind-only refusal modal

Shown instead of the force-push modal when the probe reports behind-only. It is a plain warning (no force-push affirmative button — the only choice is dismissal): it names the branch and the remote-only count, states the branch is simply behind (not a rewrite), and directs the user to pull/rebase to integrate the remote commits, warning that force-pushing here would permanently delete those remote commits. After it is dismissed the action returns **blocked** and does nothing further.

### The lease guarantee on force-push

Every force-push the action issues runs with a "lease on the remote ref" — the operation aborts if the remote tip does not match what the local replica observed when the user invoked the action. This converts the failure mode of a force-push from "silently overwrites the teammate's pushed commit" to "fails loudly when the remote has moved".

### Result of the action

A success toast names what actually happened:

- "Successfully pushed the current branch." after a normal push.
- "Successfully force-pushed the current branch." after a force-push.

After the toast, the Branch History, Changes, Status panels and the status bar all refresh.

A **blocked** outcome (behind-only refusal) shows only the refusal modal above; after dismissal the action returns without a success toast and without touching refs. A **declined** outcome (user cancelled the force-push modal) likewise returns silently. Neither refreshes the panels.

## Behavior

### When the user invokes Push

1. Run the worker-busy guard. If busy, show the warning toast and return.
2. Read the branch-commits snapshot. If empty, show "No commits to push on the current branch." and return.
3. Inspect the head commit's "is on remote" flag.
   - **Already on remote** (up-front force-push trigger): run the divergence gate with the "HEAD is already on remote" reason line. The gate runs the divergence probe, then either **blocks** (behind-only refusal modal → return), shows the force-push modal (with the lost-commits line when remote-only commits exist) and returns **confirmed**/**declined**. On declined, return. On confirmed, run a force-push (with the lease).
   - **Not on remote**: attempt a normal push.
     - If the normal push succeeds, jump to step 5.
     - If the normal push fails and the failure is recognizable as a "non-fast-forward" rejection (the remote rejected the push because the remote tip is not an ancestor of the local tip), run the divergence gate with the "Remote branch has diverged" reason line — same three outcomes as above. On blocked or declined, return. On confirmed, run a force-push (with the lease).
     - If the normal push fails for any other reason, surface the error and return.
4. If the force-push fails, surface the error and return.
5. Show the success toast (wording depends on whether a normal push or a force-push ran), then refresh all panels and the status bar.

Both triggers route through the **same** gate, so a branch that is merely behind the remote is refused regardless of whether the head was already on the remote or the normal push was rejected.

### Recognizing a non-fast-forward rejection

The action treats a push failure as non-fast-forward when the failure text contains any of these markers (case-insensitive): "non-fast-forward", "fetch first", "[rejected]", or "tip of your current branch is behind". Any other failure short-circuits to the generic error path — the user is not asked to force-push to recover from, e.g., a network error or an authentication failure.

### Modal cancellation

Picking Cancel, pressing Escape, or clicking outside the modal all resolve the same way: the action returns silently. No toast is shown ("you cancelled" is self-evident from the absence of progress); nothing in the index, working tree, or refs is touched.

### Single-commit vs. multi-commit modal copy

The detail line is the only piece that varies between the two branch shapes. A single-commit branch shows `Commit: <hash> <msg>`, framing the warning as "you're rewriting *this* commit". A multi-commit branch shows `HEAD (N commits): <hash> <msg>`, framing the warning as "you're rewriting N commits and HEAD is the one named here". The reason line and footer are identical regardless of branch shape.

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Idle | User clicks Push | Guarded |
| Guarded | Worker busy | Idle (warning toast) |
| Guarded | No commits ahead | Idle (warning toast) |
| Guarded | Head already on remote | Probing (up-front) |
| Guarded | Head not on remote | Pushing |
| Pushing | Push succeeds | Notified |
| Pushing | Push rejected as non-fast-forward | Probing (fallback) |
| Pushing | Push fails for any other reason | Idle (error toast) |
| Probing | Behind-only (remote-only > 0, local-only == 0) | Idle (behind-only refusal modal; blocked) |
| Probing | Diverged / clean rewrite / inconclusive | Confirming |
| Confirming | User picks affirmative | ForcePushing |
| Confirming | User cancels | Idle |
| ForcePushing | Force-push succeeds | Notified |
| ForcePushing | Force-push fails | Idle (error toast) |
| Notified | Refresh complete | Idle |

The "Confirming" state is the same force-push modal regardless of how the action got there — only the reason line and the presence of the lost-commits detail line differ. The "Probing" step precedes it for both triggers and can short-circuit to the blocked (behind-only) outcome.

## Notable Behavior

- **Force-push is refused outright when the branch is merely behind.** The divergence probe distinguishes a real rewrite from a behind-only branch (remote-only commits, no local-only commits); in the behind-only case the action shows a refusal modal, returns blocked, and **never** offers force-push — the user must pull/rebase first. This closes the hole where the old flow offered force-push for every non-fast-forward rejection and would clobber a collaborator's commits. (Notable; the load-bearing safety change.)
- **The lost-commits detail line names the count.** When force-push *is* offered but would drop remote-only commits (a diverged branch), the confirmation modal gains a line naming how many remote-only commits will be permanently deleted, so the user confirms with the cost in view. (Notable.)
- **An inconclusive probe never blocks a legitimate rewrite.** If the divergence can't be measured (detached HEAD, no tracking ref, git/network error), the gate falls back to the plain force-push confirmation rather than refusing. (Notable; permissive.)
- **The probe fetches before counting.** The rejection means the real remote has moved, so the local tracking ref may be stale; the probe refreshes just this branch's ref before measuring, or the counts would be wrong. (Notable.)
- **Up-front force-push trigger fires before any push attempt.** If the head commit is already on the remote (the typical "I just amended a pushed commit" case), the action skips the normal-push attempt entirely and goes straight to the modal. This avoids burning a network round-trip on a push the action already knows will be rejected, and it makes the modal's reason line more accurate ("HEAD is already on remote" vs. "the remote rejected your push"). (Notable.)
- **The lease — not the warning — is the safety net.** Cancelling the modal protects against accidental rewrites from the user; the lease protects against rewrites that race a teammate's push. Both safeguards are independent: the user can still force-push but only succeed when the remote really is where the local replica saw it last. (Notable.)
- **Non-fast-forward detection is text-pattern-based on the push tool's failure output.** Other push failures (auth, network, permission) bypass the fallback modal — the user gets the raw error and is expected to fix the underlying problem before retrying. (Notable.)
- **The detail line in the modal is truncated, the reason line is not.** The commit message is clipped to 80 characters because the modal is meant to be glanceable; the reason line is short enough not to need clipping. (Notable.)
- **Multi-commit force-push counts and names HEAD only.** When 5 commits are ahead and the user is about to force-push them, the modal says "HEAD (5 commits): <hash> <msg>". The four older commits are not enumerated in the modal — the user is expected to read the Branch History panel before invoking Push, not from inside the warning. (Surprising; intentional — keeps the modal short.)
- **The affirmative button label always names the lease.** The string the user clicks is "Force Push (--force-with-lease)" — the lease wording is part of the button label, not buried in a description. This is what teaches the user, on every encounter, that the force-push is the lease-protected variant. (Notable.)
- **No "skip the warning next time" affordance.** Every force-push pays the modal tax. The action does not offer a "remember my choice" checkbox; there is no per-branch or per-session bypass. (Surprising; intentional — every force-push is a "this could affect collaborators" event.)
- **No special-case for protected branches.** The action does not distinguish main/master from any other branch when deciding whether to show the modal or to allow the force-push — protection of those branches is delegated to the remote (e.g., the forge's branch-protection rules). The action will happily attempt a force-push on any branch the user is currently on; the remote rejects it if branch protection is in place, and that rejection flows through the action's generic error path. (Notable.)
- **Cancel is fully silent.** The action never tells the user "you cancelled" via a toast; the absence of the success toast is the cancel signal. This keeps the toast feed for events the user might not have noticed. (Notable.)
- **Both push variants emit the same success toast structure.** Only the verb differs ("pushed" vs. "force-pushed") so the user can tell which path actually ran without reading the panel-refresh-driven UI changes. (Notable.)

## Shared Behavior

- **Worker-busy lock guard** — the same probe and warning toast used by Commit and Squash also gate this action.
- **Branch History panel** — the source of the snapshot that drives the "is this branch empty?" check and the modal's commit detail line.
- **Squash & Push** — a sibling flow on the Branch History panel that bundles a squash and a force-push into one operation; its own confirmation modal precedes the squash, and the force-push it issues uses the same lease semantics as this action.
- **Create PR push step** — the PR-creation flow (spec 99) reuses this exact modal (same heading, reason wording for the diverged case, footer, and "Force Push (--force-with-lease)" button) when its initial push is rejected as non-fast-forward. It is the **fallback** trigger only: Create PR passes no commit-detail line (it has no commit-count context) and never uses the up-front "HEAD already on remote" trigger — it always attempts a normal push first. The non-fast-forward text-marker recognition is shared with that flow.
- **Status bar / Status panel / Changes panel** — refreshed by the post-success step so the rest of the UI catches up to the new remote state.

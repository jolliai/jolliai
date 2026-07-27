# IntelliJ Force-Push Gate

## Topic Statement

A shared utility that detects a non-fast-forward push rejection from error text, probes how a local branch and its remote-tracking ref have actually diverged, and gates a real force-push behind a confirmation dialog (or an outright refusal) built from that probe. The utility itself is reachable from exactly one live surface today: the embedded per-commit Create-PR form's submit handler. A second, dedicated caller exists in the codebase with the same shape as a stand-alone push command, but it is not wired into any menu, toolbar, or keybinding — it is present-but-unwired, not a live user-facing feature.

## Scope

In scope:
- Recognizing a push rejection as non-fast-forward (NFF) from its error text.
- Probing divergence between local HEAD and the branch's remote-tracking ref: refreshing the remote-tracking data first, then counting commits unique to each side.
- The gate decision and its dialog(s): behind-only refusal, or a confirm/decline force-push prompt with a conditional lost-commits warning.
- Executing the actual force-push, using the lease-protected variant.
- The threading contract dividing this into off-UI-thread I/O (probe, force-push) and on-UI-thread-only decision (the dialog).
- Reachability: which caller(s) can actually reach this gate through a discovered UI surface, and which cannot.

Out of scope:
- The branch-level Create-PR view's own push step, which discards its push result outright and never reaches this gate — see the divergence note below and cross-ref 251.
- A separate, unrelated pre-warning shown by the squash flow before it force-pushes already-pushed commits as part of a squash. That is a different decision with different wording and is intentionally not routed through this gate.
- The git-command wrapper's mechanics for capturing and returning stderr on a failed process — this gate's detection step depends on that capability but does not implement it; see cross-ref 126.
- The VS Code analog's own implementation — covered by cross-ref 107; only the behavioral divergence between the two is recorded here.

## Data Contracts

**Divergence result.** Produced by the probe for a given branch:
- The branch name it was computed for.
- Remote-only count: commits reachable from the remote tip that are missing from local HEAD — the commits a force-push would permanently delete.
- Local-only count: commits on local HEAD missing from the remote tip.
- A behind-only flag, true exactly when remote-only is greater than zero and local-only is zero (the branch was never rewritten locally — it is simply behind).

The probe result is null when divergence can't be measured: a detached-HEAD-shaped branch name, or any failure while querying either count (network error, git error) — caught and converted to null rather than propagated.

**Gate outcome.** One of three values: confirmed, declined, blocked.

## Behavior

1. **NFF detection.** The push failure's error text is lower-cased and checked for four marker phrases (case-insensitive): "non-fast-forward", "fetch first", "[rejected]", "tip of your current branch is behind". A match classifies the failure as NFF; anything else is treated as an unrelated failure and the caller surfaces the raw error without ever reaching the gate.

2. **Divergence probe** (run only after an NFF classification). Bails immediately (returns null) for a detached-HEAD-shaped branch name. Otherwise it first refreshes just that one branch's remote-tracking data — because the rejection means the real remote has moved and a stale local view would produce wrong counts — then counts remote-only and local-only commits as defined above. The whole probe is wrapped in error handling: any exception is logged and converted to a null (inconclusive) result rather than surfacing to the caller.

3. **Gate decision and dialog** — pure decision plus UI, performs no I/O of its own:
   - If the probe result is non-null and behind-only: shows a warning-only dialog (no force-push option offered at all) naming the branch and the remote-only count, stating this is not a history rewrite — the branch is simply behind — directing the user to pull or rebase and push again, and warning that force-pushing here would permanently delete those remote commits. Returns blocked.
   - Otherwise (diverged, clean rewrite, or the probe was inconclusive/null): shows a yes/no confirmation. Its body always opens with "This operation may rewrite remote history.", then a caller-supplied reason line, then — only when the probe is non-null and reports a remote-only count greater than zero — an appended lost-commits warning naming that count, then a fixed footer about affecting collaborators on the same branch. The affirmative button is labeled with the lease-protected variant, not a bare "force push". Choosing it returns confirmed; declining (or otherwise dismissing) returns declined.

4. **Execution.** On confirmed, runs a force-push against the single branch at its remote using the lease-protected variant — never a bare/unconditional force.

5. **Threading contract.** The probe (step 2) and the force-push (step 4) both do git I/O and are designed to run off the UI thread; the dialog (step 3) does no I/O and must run on the UI thread. The one reachable caller honors this exactly: it runs the probe on a background thread, blocks that same background thread while showing the dialog synchronously on the UI thread, then — on confirmed — runs the force-push back on the background thread.

## State Transitions

Push attempted → success → done (gate never entered).
Push attempted → failure → classify:
- not NFF → error surfaced, done (gate never entered).
- NFF → probe (off UI thread) → gate dialog (UI thread) →
  - behind-only → refusal dialog shown → **blocked** → done.
  - otherwise → confirm/decline dialog shown → **declined** → done, or → **confirmed** → force-push (off UI thread) → done (success or its own failure surfaced by the caller).

## Reachability — present-but-unwired vs. live

- **UNREACHABLE.** A dedicated stand-alone push action is built directly on this gate: it has its own busy-guard, its own plain-push-then-NFF-fallback flow, and reuses this gate's probe/dialog/execute sequence exactly as described above (mirroring the shape of the VS Code analog in cross-ref 107). This action is **not registered** in the plugin's action manifest — it has no menu entry, no toolbar entry, no keybinding — and no other registered action or panel invokes it programmatically. There is no discovered path by which a user can trigger it. It must be documented as present-but-unwired code, not as a live feature.
- **REACHABLE — the one live consumer.** The embedded per-commit Create-PR form's submit handler (cross-ref 120) is the only path that actually reaches this gate. When its own push step fails, it runs step 1 (NFF classification); on an NFF result it runs the probe (step 2) off the UI thread, shows the gate dialog (step 3) by blocking that background thread while the dialog runs on the UI thread, and branches on the outcome:
  - blocked → the form surfaces its own "push blocked, pull or rebase" status message and stops (in addition to the gate's own refusal dialog already shown in step 3 — the user sees both).
  - declined → the form surfaces its own "push cancelled" status message and stops.
  - confirmed → the form runs the force-push (step 4); on success it continues to find-or-create the PR; on failure it surfaces its own force-push-failed status message and stops.
- **NOT THIS GATE.** The branch-level Create-PR view (cross-ref 251) also pushes as the first step of its own submit flow, but it discards that push's result entirely — there is no NFF classification, no probe, no gate dialog, and no force-push ever offered from that surface. Do not attribute this gate's behavior to it.

## Divergence from the VS Code analog (cross-ref 107)

- VS Code's dedicated push command reaches its equivalent gate through **two** triggers: an up-front trigger (the head commit is already on the remote, detected before a push is even attempted) and the post-rejection fallback. IntelliJ's only reachable consumer has **only** the post-rejection fallback trigger — there is no up-front "HEAD already on remote" check anywhere in the reachable path; the gate here is only ever entered after a push has actually been attempted and rejected.
- IntelliJ's unwired, present-but-dead dedicated action mirrors the VS Code command's overall shape (busy guard, plain-push-then-fallback), but since it is unreachable it contributes no observable behavior to the product today.

## Notable Behavior

- Behind-only is the one divergence shape that permanently forecloses force-push through this gate — there is no bypass or override inside the gate itself; the only way past it is to actually pull/rebase and retry.
- An inconclusive probe (null — detached HEAD, or the count queries themselves failed) is deliberately treated as permissive: it falls through to the plain confirm/decline dialog rather than blocking, so a transient measurement failure never prevents a legitimate history rewrite.
- The confirmation button's label itself names the force-push variant that will run (the lease-protected one) — the user learns which kind of force-push they're authorizing directly from the button they click, not from separate text.
- The reason line shown in the confirm/decline dialog is supplied by the caller, not fixed by the gate — the one reachable caller uses different wording than the unwired action's default, so the same gate produces slightly different prompt text depending on which flow reached it (moot today since only one caller is reachable).
- On the blocked outcome, the user sees two messages in sequence: the gate's own modal refusal dialog (shown synchronously as part of the gate call), followed by the reachable caller's own separate status message in its own UI surface once the gate call returns. The gate does not suppress or coordinate with the caller's own messaging.

## Shared Behavior

- The git-command wrapper's newer full-result return shape (exit code, stdout, and stderr populated on every path, including failure) is what gives this gate's detection step something to pattern-match against in the first place — see cross-ref 126.
- The one reachable consumer is part of the embedded per-commit summary/PR form's message-handling — see cross-ref 120.

## Cross-references

- 107 — VS Code's analogous push-gate, including the up-front "HEAD already on remote" trigger that this gate's reachable path lacks.
- 120 — the embedded per-commit Create-PR form whose submit handler is this gate's only reachable consumer.
- 126 — the git command wrapper's full-result return shape that this gate's NFF-detection step consumes.
- 251 — the branch-level Create-PR view, which pushes but does **not** use this gate; explicitly excluded from this spec's claims.

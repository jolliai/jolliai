# VS Code Auto-Enable on Activation

## Topic Statement

When the IDE activates a git workspace where the project's git hooks are not yet installed, the extension auto-installs them via the same path the explicit Enable command uses, suppressed only by a repo-wide manual-disable flag shared with the CLI and every worktree of the repository.

## Scope

**In scope:**
- The preconditions that must all hold before auto-enable runs.
- The ordering relationship between auto-enable and the hook-path staleness step of the activation lifecycle.
- The operation performed when all preconditions hold and what state is updated on success.
- The failure-handling contract (logged, swallowed, no user-visible notification).
- Why there is no first-run flag and how subsequent activations short-circuit.

**Out of scope:**
- The full activation lifecycle sequence (owned by spec 100).
- The internal mechanics of the bridge-level enable path (each step of hook installation is owned by specs 44–45).
- The repo-wide manual-disable flag itself — its storage, migration, and priority (owned by spec 145).
- The onboarding panel and its own visibility rules (owned by spec 142).
- Auth and API-key configuration flows.

## Data Contracts

### Preconditions (evaluated in order)

| # | Precondition | Source of truth |
|---|---|---|
| 1 | Activation has reached the hook-path staleness step. | Implicit: the staleness step only runs in the full activation branch (workspace + git present). Degraded branches return before this step is reached. |
| 2 | The status snapshot, already available from the same async chain, reports the project as not currently enabled (hooks are not installed in this worktree). | Status snapshot produced earlier in the staleness step. |
| 3 | Reading the repo-wide manual-disable flag returns false (no opt-out recorded). | A boolean field in a profile file anchored at the repository's main worktree root, shared by the CLI and every worktree; any read/parse error maps to false. If the field has never been set, a legacy per-worktree marker (checked across every worktree of the repo) is consulted as a one-time migration fallback. Consulted **asynchronously and exactly once** per activation, and that one read is shared with the sibling new-worktree auto-repair path in the same step — see "Preconditions 2 and 3's reads are shared" below. |

The three preconditions themselves are unchanged by the zero-write contract. What changed is what happens **before** them: the hook-path staleness check that precondition 1 sits inside is no longer even invoked when the session's in-process write gate is set (a "no mismatch" answer is synthesized in its place). The staleness step's downstream chain — and therefore this substep — still runs; the durable read in precondition 3 is what actually stops auto-enable. So a disabled repository reaches this substep and is turned away by precondition 3, not by an earlier short-circuit. Cross-reference: spec 100 step 16, spec 145, and `specs/304-manually-disabled-zero-write-contract.md`.

None of the three arms of the configured boolean is a precondition: not the cloud session, not the vendor API key, and not the recorded local-agent provider. Auto-enable installs the git hooks regardless of whether the user is configured. The unconfigured user sees the onboarding panel in parallel; the hooks are installed silently so that supplying a credential — signing in, entering a key, or adopting a local agent tool — becomes the only remaining step.

### State updated on success

When all preconditions hold and the bridge-level enable completes without error:

| Item | What changes |
|---|---|
| On-disk hook installation | Hooks are present in this worktree. |
| Status snapshot | Re-read from disk; reflects the new enabled state. |
| Status bar | Repaints to reflect the new enabled state. |
| Host-local enabled state | Updated to mirror the value returned by the status refresh. |
| Sidebar provider | Notified of the enabled-changed transition, which propagates the change to the webview. |

## Behavior

### Normal path

During the hook-path staleness step of the full activation branch, after the staleness check itself has been evaluated, the auto-enable substep runs. It evaluates the three preconditions in order and, if all hold, calls the same bridge-level enable path that the explicit Enable command uses. On successful completion it runs the four state-update operations listed above in sequence: status refresh, status-bar repaint, host-state mirror, sidebar notification.

### Failure path

Any error thrown by the bridge-level enable path is caught, logged at warning level with the failure message, and discarded. No toast, no modal, no sidebar banner is shown. The repo-wide manual-disable flag is not touched. Auth errors, hook-install errors, and unexpected exceptions all collapse into the same warn-and-continue outcome. The hook installer's own per-step log lines are still emitted; auto-enable only orchestrates the top-level call.

### Subsequent activations

There is no first-run flag. On every activation the staleness step runs and the same precondition evaluation runs. Once auto-enable has succeeded, precondition 2 (project not enabled) is false on the next activation, so the substep exits immediately without calling the enable path. The combination of (a) hooks being present and (b) the absence of the opt-out marker is the complete state machine; no separate first-run tracking is needed.

## State Transitions

```
[Staleness step reached]
        │
        ▼
  Project enabled?  ──── yes ──► (skip; nothing to do)
        │
        no
        ▼
  Manual-disable flag set?  ──── yes ──► (skip; user opted out)
        │
        no
        ▼
  Call bridge-level enable
        │
    ┌───┴───┐
  error    success
    │         │
    ▼         ▼
  log warn  refresh status → repaint status bar
  swallow   → mirror host state → notify sidebar
              (auto-enable will short-circuit on
               next activation at precondition 2)
```

## Notable Behavior

- **The previous explicit-Enable-first-activation requirement is retired.** The new contract is that a project is implicitly enabled on first activation unless the user has explicitly opted out, even before the user has supplied any summarization credential at all.
- **Failures are silent because the user has not asked for anything.** A noisy failure on first activation would be jarring for a user who has not yet interacted with the product. The explicit Enable command from the sidebar disabled panel remains available if the user wants diagnostics.
- **Auto-enable is not independently gated on "not in a degraded branch."** The staleness step itself only runs on the full branch, so by the time auto-enable is reached the degraded-branch check has already been satisfied. There is no redundant guard here.
- **The hook installer is responsible for its own per-step logging.** Auto-enable does not re-log installer progress lines; it only logs at warning level when the top-level call returns an error.
- **The status refresh after a successful auto-enable is a re-read of disk state, not an optimistic toggle.** This ensures the host's view of enabled state is always consistent with what is actually installed on disk.
- **The opt-out is now repo-wide, not per-worktree.** The manual-disable flag is anchored to the main worktree root and shared with the CLI; opting out from any worktree or from the CLI suppresses auto-enable in every worktree of the repository.
- **Preconditions 2 and 3's reads are now shared with a sibling auto-repair path** (reinstalling hooks in a new worktree of an already-enabled project) — both reads happen once before either branch runs. Precondition 3's source is read asynchronously from disk exactly once and the boolean is reused by both branches, so the two paths can never disagree about the opt-out within one activation. This does not change what the three preconditions are.
- **The staleness step that hosts this substep can now be skipped without skipping the substep.** When the session's in-process write gate is set, the staleness operation is not invoked and a synthetic "no mismatch" stands in — but the async chain it fronts still runs to completion, so auto-enable is still evaluated and still refused, by precondition 3. Auto-enable therefore has exactly one reason to decline on a disabled repository, not two. (Notable; the two gates look redundant but sit on different reads — see spec 145.)

## Shared Behavior

- **Activation lifecycle (spec 100)** owns the staleness step and the surrounding full-branch sequence. Auto-enable is a substep of step 16 in that sequence.
- **Bridge-level enable path** is shared with the explicit Enable command. Both surfaces converge on the same install mechanics; changes to enable mechanics are automatically inherited by auto-enable.
- **Repo-wide manual-disable flag (spec 145)** owns the flag's storage location, write/clear ordering, error-handling, and legacy-marker migration. This spec only consumes a boolean read.
- **Onboarding panel (spec 142)** is independent. Auto-enable can complete while the user is still unconfigured, in which case the onboarding panel remains visible alongside a now-enabled hook installation. Spec 142 also owns the three-armed configured derivation this spec deliberately does not consult, and the local-agent tool sweep that runs in the same activation but in an earlier step.
- **Hook installation orchestration (spec 44)** owns the per-step mechanics invoked by the bridge-level enable path.

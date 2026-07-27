# 213. Create-PR Branch Classification

## Topic Statement

When a user opens or submits the Create-PR form, a classifier runs two read-only git probes to determine whether the summary's recorded branch is still the correct branch to scope the PR to. The classifier distinguishes five cases — same branch, renamed/deleted branch (successor), detached HEAD, genuine cross-branch view, and deleted with no successor — and either allows PR creation (possibly redirected to the current branch) or surfaces a blocking message and a specific surface command. A second, lighter guard at form-submit time catches the TOCTOU window where the user switches branches after the form opens.

## Scope

**In scope:**

- The five classification outcomes and the exact input conditions that produce each.
- The two git probes (local-ref existence check; commit ancestry check) and the order they run.
- The fast-exit paths that skip one or both probes.
- The three user-facing blocking messages (one per blocking outcome, shared across both guard sites).
- The `effectiveBranch` value produced for each outcome and how it propagates into PR scoping.
- The panel-level prepare-time guard (`prepareCreatePr`) and how it sets the panel's pending branch for the submit path.
- The submit-time second guard (`createPr`) that catches mid-form branch switches.
- The foreign-repo panel short-circuit that bypasses the classifier entirely.
- The status-check route (`checkPrStatus`) that uses the classifier purely for branch resolution, never for blocking.
- The body-aggregation consequence: when `effectiveBranch` differs from the current branch, the multi-summary aggregation is suppressed and only the clicked summary is used.

**Out of scope (boundaries):**

- What the classifier's outputs trigger inside the broader Create-PR flow (push, `gh pr create`, temp-file handling, form display) — that is **PR Creation and Update via gh** (spec 99).
- The `gh` precondition probes, PR lookup, PR body content, and dual-marker embedding — all in spec 99.
- How `currentBranch` is read (normalized to `"HEAD"` on detached-HEAD or git error) — that read happens before the classifier is called and is the caller's responsibility.
- The worker-busy guard that runs before the classifier at prepare time — same pattern as Commit/Squash; not specific to this classifier.
- The Update-PR path: it uses the same `effectiveBranch` resolution but runs no blocking guard; that behavior is spec 99.
- The dedicated Create-PR pane (**VS Code Create-PR View**, spec 237) does **not** run this classifier at all — it resolves its branch directly (the anchor summary's recorded branch, or the current branch) and has no cross-branch / rename / detached-HEAD blocking at open. Only the lighter submit-time check-again guard (below) applies to it.

## Data Contracts

### Classifier inputs

| Input | Type | Meaning |
|---|---|---|
| Summary branch | optional string | The branch name captured when the commit was made. Absent for summaries created before the field existed. |
| Current branch | string | The branch currently checked out, normalized by the caller: the literal sentinel `"HEAD"` means "could not determine" (detached HEAD or git error). |
| Commit hash | optional string | The summary's commit hash. Used only for the ancestry probe. Absent means the ancestry probe is skipped. |
| Working directory | string | The project root, forwarded to the two git probes. |

### Classification outcomes

| Outcome kind | `effectiveBranch` field | Meaning |
|---|---|---|
| `ok` | summary branch | Summary branch equals current branch, or no summary branch exists. |
| `okAsCurrent` | current branch | Summary branch was renamed or deleted, and the current branch contains the summary's commit. |
| `detachedHead` | (none) | Current branch is the sentinel `"HEAD"`. |
| `crossBranch` | (none; `summaryBranch` field) | Summary branch differs from current branch, and the old ref still exists as a local ref. |
| `originalGone` | (none; `summaryBranch` field) | Summary branch differs from current branch, the old ref is gone, but the commit is not on the current branch (or no commit hash was supplied). |

Only `ok` and `okAsCurrent` allow the Create-PR action to proceed. The other three are blocking.

### Git probes

Both probes are read-only; neither modifies refs, the index, or the working tree.

| Probe | What is checked | Result true / false |
|---|---|---|
| Local-ref existence | Whether the summary's branch name still exists as a local ref (the same mechanism used to check whether an orphan branch exists). Runs only when summary branch ≠ current branch. | True = old ref still present; false = old ref gone. |
| Commit ancestry | Whether the summary's commit hash is an ancestor of `HEAD`. Runs only when the old ref is gone **and** a commit hash was supplied. | True = current branch contains the commit; false = it does not. |

The ancestry check always targets `HEAD` as the descendant, regardless of the current branch's name.

### Blocking messages

One user-facing warning message per blocking outcome. Both guard sites (prepare time and submit time) use the same message text so the user sees identical copy regardless of where the block fires:

| Outcome | Message |
|---|---|
| `detachedHead` (with summary branch) | `Cannot determine the current branch (detached HEAD or git error). Resolve the repository state, then retry creating the PR for <summaryBranch>.` |
| `detachedHead` (no summary branch) | `Cannot determine the current branch (detached HEAD or git error). Resolve the repository state, then retry creating the PR.` |
| `crossBranch` | `This summary is on branch <summaryBranch>. Checkout <summaryBranch> to create its PR.` |
| `originalGone` | `The branch this summary was created on (<summaryBranch>) no longer exists, and its commit is not on the current branch — there is no branch to create a PR from.` |

The detached-HEAD message intentionally never instructs the user to "Checkout HEAD" — `HEAD` is not a valid branch to create a PR from, and the old string "Cannot create a PR — the memory's commit is not in the current branch's history" would have been misleading in this case.

### Submit-time TOCTOU guard inputs

| Input | Meaning |
|---|---|
| `expectedBranch` | The `effectiveBranch` value recorded by the panel at prepare time. Passed through to the submit handler. Optional: absent means "no branch context" (same as `ok`). |
| Live current branch | Read fresh at submit time. Normalized to `"HEAD"` on detached HEAD or git error. |

## Behavior

### Classification decision tree

1. If no summary branch is supplied → return `ok` with current branch as effective branch. No git probes run.
2. If current branch equals the `"HEAD"` sentinel → return `detachedHead`. No git probes run.
3. If summary branch equals current branch → return `ok` with the summary branch as effective branch. No git probes run.
4. Run the local-ref existence probe for the summary branch.
   - If the old ref still exists → return `crossBranch`. The ancestry probe does not run: containment is irrelevant when the old ref is live.
5. (Old ref is gone.) If a commit hash was supplied, run the ancestry probe.
   - If the commit is an ancestor of `HEAD` → return `okAsCurrent` with current branch as effective branch.
6. Return `originalGone`. This covers: old ref gone with no commit hash; old ref gone and commit not on current branch.

### Prepare-time guard (`prepareCreatePr`)

Runs before the Create-PR form is shown to the user:

1. If no summary branch is present on the loaded summary, skip classification. The panel's pending branch is set to whatever value the summary has (may be `undefined`). Proceed to show the form.
2. Read the current branch (single read, reused below).
3. Run the classifier with the summary's branch, the current branch, the summary's commit hash, and the workspace root.
4. Derive the blocking message from the outcome. If a blocking message exists:
   a. Show the blocking message as a warning notification.
   b. Send the surface command `prCreateBlockedCrossBranch` carrying `summaryBranch` and `currentBranch`.
   c. Return. The form is not shown.
5. If no blocking message: set the panel's pending branch to `effectiveBranchFor(decision, summary.branch)` (the current branch for `okAsCurrent`; the summary branch for `ok`).
6. Use the effective branch for body aggregation (see below) and proceed to show the form.

### Submit-time second guard (`createPr`)

Runs when the user submits the Create-PR form, after the form was already opened by the prepare path:

1. Read the current branch fresh.
2. If the current branch is the `"HEAD"` sentinel: show the shared detached-HEAD warning message; send `prCreateBlockedCrossBranch` with the expected branch and `"HEAD"`; return.
3. If an expected branch was set at prepare time and it no longer matches the live current branch: show a TOCTOU warning (`"The current branch changed to <live> (the form was opened for <expected>). Reopen Create PR to continue."`); send `prCreateBlockedCrossBranch`; return.
4. Otherwise proceed with the push and `gh pr create` (spec 99).

The full five-outcome classifier does not re-run at submit time. The submit guard covers only detached HEAD and mid-form branch switches; richer cross-branch / original-gone scenarios were decided at prepare time.

### Status-check branch resolution (`checkPrStatus` and `resolveEffectiveBranch`)

The classifier is also called on every status-check request (and by the prepare-update-PR path). Here it is used purely for `effectiveBranch` resolution, not for blocking:

1. If the panel is displaying a foreign-repo summary, skip the classifier. Return the summary's own branch unchanged.
2. If no summary branch is present, skip the classifier. Return `undefined`.
3. Read the current branch; run the classifier.
4. Call `effectiveBranchFor(decision, summary.branch)`:
   - `ok` or `okAsCurrent` → return `decision.effectiveBranch`.
   - Any blocking outcome (`detachedHead`, `crossBranch`, `originalGone`) → return the summary branch as a fallback (the status check will use it for the PR lookup; no blocking message is shown here).
5. Pass the resolved effective branch to the status check.

This means a renamed branch transparently follows the rename for PR status display (the status check queries the current branch's PR instead of a stale name). A blocked case still queries whatever branch it can (the summary branch); the status check resolves PR status by branch name for whatever branch it is given (spec 99).

### Body-aggregation consequence

When building the PR body at prepare time, the aggregation of all branch summaries (`base..HEAD`) runs only when `effectiveBranch` equals the current branch. When they differ — meaning the user is viewing a summary on a different branch — the aggregation is suppressed and only the clicked summary is included. This prevents the PR body from describing commits that are not related to the PR's branch. The single `getCurrentBranch` read is shared between the classifier and the aggregation decision.

## State Transitions

The classifier itself is stateless; it maps inputs to an outcome on each call. The panel holds one piece of mutable state touched by this flow:

| State | What changes |
|---|---|
| `pendingPrBranch` | Set by the prepare-time guard to `effectiveBranch` on success (or left as `summary.branch` when the guard is skipped). Passed verbatim to the submit handler as `expectedBranch`. Cleared to `undefined` on panel reset (loading a new summary). |

Surface command transitions driven by classification:

| Classification outcome | Surface command sent | PR form visible? |
|---|---|---|
| `ok` or `okAsCurrent` | `prShowCreateForm` (proceed) | Yes |
| `detachedHead` | `prCreateBlockedCrossBranch` | No |
| `crossBranch` | `prCreateBlockedCrossBranch` | No |
| `originalGone` | `prCreateBlockedCrossBranch` | No |
| TOCTOU (submit guard) | `prCreateBlockedCrossBranch` | N/A (form was already open) |

## Notable Behavior

- **Branch equality is checked before any git probe.** When summary branch equals current branch, the function returns immediately. No I/O occurs. (Notable; no unnecessary probes for the common case.)
- **Ancestry probe runs only when the old ref is gone.** When the old ref still exists as a local ref, containment is irrelevant — the PR should stay on the old branch regardless of whether the current branch also happens to contain the commit. The ancestry probe is skipped in this case. (Notable; prevents false `okAsCurrent` when both branches share a commit.)
- **Renamed branch is detected by local-ref absence, not by any git rename record.** `git branch -m` deletes the old ref; `git checkout otherbranch` does not. This is the distinguishing signal. An unrelated checkout that doesn't touch the old branch leaves the old ref alive, so the flow stays in `crossBranch`. (Notable; the core insight of the classifier.)
- **Missing commit hash degrades to `originalGone` without probing ancestry.** A summary with no commit hash cannot have its reachability verified, so the safe fallback is to block. This affects only summaries from before the commit hash field was recorded. (Notable; conservative.)
- **`detachedHead` is a separate outcome from `crossBranch`.** Before this classifier existed, both would have been collapsed into a generic "not on the right branch" block. The distinction matters for the message: `crossBranch` tells the user to check out a specific branch; `detachedHead` tells the user the repo state itself is broken and to fix it first. "Checkout HEAD" would be actively wrong advice. (Surprising; intentional.)
- **The submit-time guard does not re-run the full classifier.** It only checks the current branch against the value set at prepare time. The assumption is that the prepare-time classification was thorough; the submit guard only catches the TOCTOU race. Re-running the classifier at submit time would be safe but would add two git I/O calls on every form submission. (Notable.)
- **Foreign-repo panels bypass the classifier entirely in all paths.** The classifier queries local git refs (`git rev-parse --verify refs/heads/<b>`) and local ancestry (`git merge-base --is-ancestor`), which are meaningless for a summary from a different repository. The `createPr` and `prepareCreatePr` commands are additionally denied at dispatch for foreign panels; the classifier bypass in `resolveEffectiveBranch` is an extra safeguard on the status-check path that does reach foreign panels. (Notable.)
- **Both guard sites share the same blocking-message helpers.** The wording is centralized so a future wording change in one place propagates to both prepare-time notifications and submit-time notifications. (Notable.)
- **Body aggregation follows `effectiveBranch`, not `currentBranch`.** When `effectiveBranch` (after rename resolution) differs from `currentBranch`, the multi-summary aggregation is suppressed. This means a user viewing a cross-branch summary (allowed by Memory Bank's cross-branch browse feature) always gets a single-summary PR body, never accidentally aggregating commits from the currently checked-out branch into a PR that belongs to a different branch. (Surprising; intentional.)

## Shared Behavior

- The PR status lookup on the resolved effective branch — and the form/button behavior it drives — is defined by **PR Creation and Update via gh** (spec 99), not here. This spec's classifier only resolves the `effectiveBranch` that feeds that status check; this classifier (not the status check) is the surface that blocks a cross-branch Create-PR with a message at prepare time.
- The worker-busy guard that runs before `prepareCreatePr` and gates the Create-PR path is the same pattern used by Commit and Squash.
- The `git push -u origin HEAD` that follows a successful prepare-time classification, and the `gh pr create` call, are defined by **PR Creation and Update via gh** (spec 99).

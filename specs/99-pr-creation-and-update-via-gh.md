# 99. PR Creation and Update via gh

## Topic Statement

Create, look up, and update a GitHub pull request through the `gh` CLI by first probing that `gh` is installed and authenticated, looking the PR up by the **branch name the summary was scoped to** (the branch the summary was generated on, or the current branch when no summary is in view) in a single `gh pr list --state all --head <branch>` round-trip that returns the open PR plus the closed/merged history, refusing to create a PR when the panel's prepare-time classifier flagged the branch as un-creatable (and re-checking the current branch at submit time), and routing all body and title writes through `gh pr edit` / `gh pr create` with the body delivered via a temp file (`--body-file`) — never as an inline argument.

## Scope

**In scope:**

- The two precondition probes (`gh --version`, `gh auth status`) and their retry-once policy.
- The PR lookup (`gh pr list --state all --head <branch> --json number,url,title,body,state,isCrossRepository`), the sealed three-outcome lookup result it produces (open PR found / no open PR / lookup error), the fork (cross-repository) row filter, the multiple-open-PR de-dup, and the closed/merged **PR history strip**.
- The PR creation (`git push -u origin HEAD` then `gh pr create --title <t> --body-file <path>`).
- The shared branch-push step (pushed/cancelled result), the pre-push PR existence re-check with the create→update and update→create fallbacks, the granular per-step progress messages, and the succeeded/failed submit-outcome return.
- The two Create-PR-pane submit paths that **push first** (Create and Update), versus the legacy embedded edit flow's update path that never pushes.
- The PR description edit (`gh pr edit <num> --body-file <path>`) and the title edit (`gh pr edit <num> --title <t>`).
- The error-mapping for each failure mode (binary missing, transient spawn error, auth, generic non-zero, non-array / unparseable JSON, non-fast-forward push).
- The submit-time second guard on `Create PR` (detached HEAD / mid-form branch switch).
- The foreign-repo routing (`--repo <url>`) and the foreign-repo-with-no-summary-branch short-circuit to `unavailable`.
- Temp-file handling for the body (creation, write, removal, even on error).

**Out of scope (boundaries):**

- The full five-outcome Create-PR branch classifier (same-branch / renamed-or-deleted-successor / detached-HEAD / cross-branch / deleted-with-no-successor), its two git probes, the three prepare-time blocking messages, and how it resolves the effective branch the lookup is scoped to; see **Create-PR Branch Classification** (spec 213). This spec consumes the resolved branch and the submit-time TOCTOU guard only.
- The marker-wrapped block content itself (what goes between `<!-- jollimemory-summary-start -->` and the closing marker); see **PR Description Dual-Marker Embedding**.
- The marker locator regex and the replace-or-append rule; see **PR Description Dual-Marker Embedding**.
- The Jolli-backend push, the binding flow, and the `426` / `412` mappings; see the cloud-push specs.
- The summary's branch field on disk; this spec consumes it as a value but does not define how it is recorded.
- The branch summary loader that enumerates `base..HEAD`; see **PR Description Dual-Marker Embedding**.
- Any web-frontend GitHub interactions; the only GitHub channel here is `gh` on the local machine.

## Data Contracts

### `gh` precondition probes

| Probe              | Command                | Purpose                                                                                    |
| ------------------ | ---------------------- | ------------------------------------------------------------------------------------------ |
| Installed          | `gh --version`         | Confirms the `gh` binary is reachable on `PATH`. `ENOENT` ⇒ not installed (definitive).    |
| Authenticated      | `gh auth status`       | Confirms `gh` has a usable credential.                                                      |

Both must pass — in this order — before any state-changing command runs.

#### Probe failure classification

| Classification | When                                                                                                                                                  | User-facing status            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `installed`    | The probe exited 0.                                                                                                                                   | `gh` available; proceed.      |
| `notFound`     | Spawn failed with `ENOENT`. Definitive — no retry.                                                                                                    | `notInstalled` to the surface. |
| `nonZero`      | The probe ran but exited with a numeric non-zero code. For `gh auth status` this is read as "unauthenticated" after one retry; for `gh --version` it is read as "transient" after one retry. | `notAuthenticated` (auth probe) or `unavailable` (install probe). |
| `transient`    | Spawn error other than `ENOENT` (e.g. `EACCES`, `EBUSY`, signal kill). Retried once.                                                                  | `unavailable` after retry.     |

The retry-once delay is 500 ms by default. Both probes retry **once**: a brief Credential Manager hiccup (Windows) or a transient spawn error must not look like "not authenticated" or "not installed". `ENOENT` is the only error that skips retry — it is definitive.

#### Probe return values to the surface

| Status              | Trigger                                                              | UI text                                                                                                          |
| ------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `notInstalled`      | `gh --version` returned `notFound`.                                  | `GitHub CLI (gh) is not installed. Install it from https://cli.github.com/ and reload the window.`               |
| `notAuthenticated`  | `gh auth status` returned `nonZero` after one retry.                 | `GitHub CLI (gh) is not authenticated. Run "gh auth login" in a terminal, then retry.`                           |
| `unavailable`       | `gh --version` returned `transient` after one retry, or `gh auth status` returned `transient` after one retry, or any unexpected exception was thrown during the check. | When the exception carried a message (git failure such as detached HEAD, `.git/index.lock`, permission), the surface attaches that message as a `reason`: `Could not load PR status — <reason>. Retry, or check the extension log.` Otherwise (transient `gh` probe failure with no message): `Could not reach GitHub CLI (gh). This is often transient — retry, or check the extension log.` |

### Branch resolution

PR operations are **branch-scoped, not commit-scoped**. The lookup is always run against an explicit branch name; the commit hash is intentionally ignored at lookup time so the same PR is found across squash / amend / rebase that rewrote the hash.

The target branch is the **effective branch** the panel resolves for the displayed summary (see spec 213): the summary's own recorded branch normally, the current branch when the summary's branch was renamed/deleted away and the current checkout carries the commit, or — when no summary is in view — the current branch (`git rev-parse --abbrev-ref HEAD`). A blocked classifier outcome (cross-branch, original-gone, detached-HEAD) still resolves to the summary's branch as a fallback so the status check can display *that* branch's PR; the classifier never blocks the status check itself.

This spec does not decide the effective branch — it receives it. `gh pr list`, `gh pr create`, and `gh pr edit` are always invoked with that explicit branch (or, for foreign repos, with `--repo <url>`); none rely on `HEAD` semantics.

### PR lookup

`gh pr list --state all --head <branch> --json number,url,title,body,state,isCrossRepository` (plus `--repo <url>` when looking up a foreign repo).

`list` (not `view`) is used so the open PR **and** the closed/merged history come back in a single round-trip. `gh pr view <branch>` returns only the most-recent PR regardless of state, so a force-pushed branch with one merged PR plus one open PR would have shown only the open one and dropped the merged one from the UI. `gh pr list` returns `[]` (success exit, empty JSON array) when nothing matches, so no stderr regex is needed to recognize "no PR".

The lookup produces a sealed three-outcome result:

| Outcome        | When                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `found`        | At least one well-formed **OPEN** row survives the fork filter. Carries the open PR plus the history strip. |
| `noPr`         | Zero open rows survive. Carries the history strip (may be empty). This is **not** an error — it includes the case where only merged/closed PRs exist. |
| `lookupError`  | `gh` exited non-zero, returned non-array JSON, or returned unparseable JSON. Carries a human-readable `reason`. |

This sealed result deliberately replaces the previous `PrInfo | undefined` return, which collapsed real-no-PR, auth/network failure, unparseable JSON, and zero-numbered JSON into the same `undefined` — leading callers to show "No PR found" + Create-PR for all four and inviting duplicate PRs after a token lapse.

Row processing, in order:

1. **Well-formedness filter** — drop any row whose `number` is not `> 0` or whose `state` is not a string. (`gh` has returned `number: 0` in edge cases.)
2. **Fork filter** — drop any row with `isCrossRepository === true`. `--head <branch>` matches by branch name alone, so a contributor fork sharing the head-branch name would otherwise be picked up; dropping fork rows scopes the panel to upstream-owned PRs. Dropped fork IDs are logged at warn.
3. **Open selection** — among surviving rows with `state === "OPEN"`, sort by descending number and take the highest. GitHub allows at most one open PR per head branch, so this is normally 0 or 1; if more than one appears (replication lag / stale cache), the highest is kept as active and the rest are logged at warn.
4. **History strip** — surviving rows with `state === "MERGED"` or `state === "CLOSED"`, sorted by descending number, become the `history` array, each carrying `{ number, url, state }`.

| Lookup outcome | Surface result                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `found`        | `ready` with `{ number, url, title }` plus `history`.                                                |
| `noPr`         | `noPr` with the queried branch plus `history`. The "No PR for branch …" line is logged at debug only when the branch has **zero** PRs of any state (a closed/merged-only branch still flows to `noPr` but is not "no PR at all"). |
| `lookupError`  | `unavailable` with the lookup's `reason` attached (same channel as the outer-catch git/gh failures), so the surface shows the real cause and a `Retry` button rather than a misleading `Create PR`. |

### PR creation

`gh pr create --title <title> --body-file <tmpPath>`

Preceded by a submit-time second guard (below) and then `git push -u origin HEAD` to ensure the branch exists on the remote.

| Outcome                                                              | Surface result                                                                                |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Submit-time guard blocks (detached HEAD or mid-form branch switch).  | A warning toast plus `prCreateBlockedCrossBranch` (carrying the expected and current branch). No push, no create. |
| `git push` rejected as **non-fast-forward**.                          | A modal force-push confirmation is shown (see below). If the user confirms, the branch is re-pushed with a lease and the flow continues to create. If the user declines, `prCreateFailed` is surfaced and the flow stops (no error toast — the declined modal is self-evident). |
| `git push` failure for **any other reason** (auth, network, …).      | The push error message is surfaced verbatim with `Create PR failed — <message>`, plus `prCreateFailed`. |
| Force-push (`--force-with-lease`) failure after a confirmed retry.    | The error message is surfaced verbatim with `Create PR failed — <message>`, plus `prCreateFailed`. |
| `gh pr create` failure (any).                                         | The error message is surfaced verbatim with `Create PR failed — <message>`, plus `prCreateFailed`. |
| Success.                                                              | `gh`'s stdout (the new PR URL) is trimmed and returned. The surface refreshes the PR section (re-runs the status check scoped to the expected branch), then shows an info notification with an `Open PR` action that opens the URL externally. |

#### Non-fast-forward push during create

A normal push is rejected as non-fast-forward when the branch was already pushed and its local history was then rewritten (rebase / amend / squash / reset), **or** when the branch is merely behind the remote. The create flow recognizes this rejection by the same case-insensitive markers the push-button command uses — the failure text contains any of "non-fast-forward", "fetch first", "[rejected]", or "tip of your current branch is behind". On that rejection it runs the **shared divergence gate** (spec 107): the gate probes how local and remote diverge and then either **blocks** the push outright (behind-only case — remote-only commits with no local-only commits: a refusal modal is shown and the push step returns a cancelled result, so the create/update handler surfaces a plain failure with **no** error toast, never offering force-push), or shows the **shared** modal force-push confirmation. That confirmation is byte-identical to the push-button command's — but the create flow passes **no** HEAD/commit-count detail line (it has no commit-count context); it may still gain the shared **lost-commits detail line** naming the remote-only count when force-push would drop remote commits:

| Field | Content |
| --- | --- |
| Heading | "This operation may rewrite remote history." |
| Lost-commits detail line (conditional) | Appended when the gate found remote-only commits force-push would drop (see spec 107). |
| Reason line | "Remote branch has diverged. Force push will overwrite remote history." |
| Footer | "This may affect collaborators on the same branch." |
| Affirmative button | "Force Push (--force-with-lease)" |
| Implicit Cancel | The modal's standard Cancel / Esc / click-away. |

If the user confirms, the branch is re-pushed with a lease on the remote ref (the push aborts if the remote tip moved in a way the local clone hasn't observed — never a bare force). If the user cancels, **or the gate blocked the push (behind-only)**, `prCreateFailed` is surfaced and the create stops; nothing is force-pushed and no PR is created (the behind-only refusal modal is the user's only feedback — no extra error toast). Any push failure that is **not** a non-fast-forward rejection (auth, network, permission) is never routed to the modal — it falls straight to the verbatim `Create PR failed — <message>` path.

#### Submit-time second guard

Before pushing, the create handler re-reads the current branch (normalized to the literal `HEAD` sentinel on detached HEAD or git error) and compares it against the `expectedBranch` recorded by the panel at prepare time:

- Current branch is `HEAD` → block with the shared detached-HEAD message (spec 213) and `prCreateBlockedCrossBranch`.
- `expectedBranch` is set and no longer equals the live current branch → block with `The current branch changed to <current> (the form was opened for <expected>). Reopen Create PR to continue.` and `prCreateBlockedCrossBranch`.
- `expectedBranch` is undefined (no summary context) → proceed against the current branch.

This guard catches only the TOCTOU window where the user switched branches after the form opened; the richer cross-branch / original-gone / rename decisions are made at prepare time by the classifier (spec 213). The full classifier is **not** re-run here.

The body is delivered via `--body-file <tmpPath>` — a temp file written to the OS temp directory with a unique filename — never as an inline `--body` argument. The temp file is removed in a `finally` block whether or not the call succeeded.

### PR description edit

`gh pr edit <number> --body-file <tmpPath>`

Same temp-file handling as creation. The body is the new body computed by the dual-marker replace-or-append.

### PR title edit

`gh pr edit <number> --title <title>`

Sent only when the new title differs from the existing one. The title is not piped through a temp file (it is short, single-line).

### Shared branch-push step

All submit paths that push route through **one** shared branch-push implementation, so the force-push negotiation can't drift between them. It attempts a normal `git push -u origin HEAD`; on a non-fast-forward rejection it runs the divergence gate (spec 107) and, on confirmation, re-pushes with `--force-with-lease`. It returns a discriminated result:

- **pushed** — the branch is on the remote (normal push succeeded, or the confirmed force-push succeeded).
- **cancelled** — the user declined the force-push modal, **or** the gate blocked the push (behind-only). The caller aborts quietly without an error toast.

Any non-fast-forward push failure (auth, network, permission) propagates unchanged to the caller's outer catch and the verbatim `… failed — <message>` path.

### Submit-outcome return

Each pane submit path returns a **succeeded / failed** outcome. The pane uses it to gate what happens next: only **succeeded** triggers the post-success share-to-Space step and the refresh/settle sequence; **failed** means the handler has already posted the failure/block surface message and shown any toast, and the pane simply re-enables its buttons.

### Granular progress messages

Across all pushing submit paths the handler posts human-readable progress lines the pane renders below its disabled buttons — "Pushing branch to origin…", "Updating pull request #N…", "Creating pull request…". These are **mid-flight** state, not settle signals; the pane keeps its buttons disabled through them and clears them only on a terminal settle (spec 237).

### Create-PR pane: push-first submit paths

The dedicated Create-PR pane (spec 237) has two submit paths. Both resolve **PR existence via the lookup BEFORE any push**, because the push step may force-push (rewriting remote history) and must never run only to discover the create/update was unsafe. Both apply the submit-time cross-branch guard first (detached-HEAD / branch-switch), identical in shape to the create guard above.

**Create button → push-first create with a create→update fallback.** After the branch guard, look the branch's PR up again:

| Pre-push lookup | Behavior |
| --- | --- |
| `lookupError` | **Abort without pushing.** Error toast `Create PR failed — could not verify the pull request: <reason>`, `prCreateFailed`, outcome **failed**. Force-pushing + creating here could produce a duplicate PR if one actually still exists. |
| `found` (an open PR exists even though the pane rendered "Create") | **Modal confirm** ("An open pull request (#N) already exists for <branch>. Update it with this draft instead?", affirmative "Update Existing PR"). Declining (or dismissing) → `prCreateFailed`, **failed**, nothing pushed. Confirming → push (shared step), then **sync** the drafted title/body into PR #N (title edit only when changed; body merged via the dual-marker replace-or-append so manual content outside the markers survives). Outcome **succeeded**. |
| `noPr` | Push (shared step), then `gh pr create`. Outcome **succeeded**. |

**Update button → push-first update.** The pane's Update button (rendered when the render-time lookup found an open PR) also resolves existence before pushing:

| Pre-push lookup | Behavior |
| --- | --- |
| `lookupError` | **Abort without pushing.** Error toast `Update PR failed — could not verify the pull request: <reason>`, `prCreateFailed`, **failed**. |
| `found` | Push (shared step), then sync the drafted title/body into the existing PR (same title-if-changed + dual-marker body merge). **succeeded**. |
| `noPr` (the tracked PR was closed/merged between render and submit) | **Modal confirm** ("The pull request for <branch> no longer exists (it was closed or merged). Push this branch and create a new PR?", affirmative "Create New PR"). Declining → `prCreateFailed`, **failed**. Confirming → push, then `gh pr create` fresh. **succeeded**. |

Both push-first paths surface failures on the **`prCreateFailed`** channel (the pane's listener keys on that), not `prUpdateFailed`.

This is distinct from the **legacy** embedded edit flow's update path (below), which never pushes. The "Update PR never pushes" claim holds only for that legacy path.

### Branch guards across operations

| Operation     | Guard                                                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Create PR`   | Blocking is decided at **prepare** time by the classifier (spec 213) and re-checked at **submit** time by the lighter guard above. This spec only carries the submit-time guard; the prepare-time five-outcome classification and its three blocking messages are spec 213. |
| `Update PR` (legacy embedded edit flow) | No blocking guard, no push. The lookup is run against the resolved effective branch; if no open PR exists for it, the update surfaces a warning and `prUpdateFailed` rather than blocking. |
| `Update PR` (Create-PR pane, push-first) | Applies the same submit-time cross-branch guard as `Create PR` (detached-HEAD / branch-switch) because it pushes; resolves PR existence before pushing (see "Create-PR pane: push-first submit paths"). |
| `Status check` | Never blocks. It resolves the effective branch (spec 213), runs the lookup, and emits `ready` / `noPr` / `unavailable`. There is **no** `crossBranch` flag in the status result; a cross-branch view simply queries (and displays) the summary's branch's PR. The `noPr` state always offers a `Create PR` button — the prepare-time classifier is what actually refuses an un-creatable branch when that button is clicked. |

### Force-push / rewritten-commit handling

PR **lookup** is branch-scoped and commit-hash-agnostic, so a summary whose commit was force-pushed away is still found by branch name; the rename/delete edge cases are handled by the prepare-time classifier (spec 213), not by commit reachability here.

The **Create PR push step** does negotiate a force-push when its initial `git push` is rejected as non-fast-forward (the branch was pushed and then rewritten) — see "Non-fast-forward push during create" above. This mirrors the push-button command's fallback: detect the rejection by text markers, show the shared confirmation modal, and retry with a lease. The proactive "is HEAD already on remote, force-push up-front before any push attempt" trigger is **not** part of this flow — that up-front trigger lives only on the push-button command; the create flow always attempts a normal push first and only offers the force-push as a post-rejection fallback. The **Create-PR pane's push-first Update path** does the same post-rejection negotiation (it pushes through the shared branch-push step). Only the **legacy** embedded edit flow's update path does no force-push negotiation at all — it never pushes.

### Temp-file lifecycle

| Step    | Behavior                                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------------------- |
| Create  | Filename `jollimemory-pr-<hex>.md` (12 hex characters from a CSPRNG) inside the OS temp directory.                 |
| Write   | UTF-8 content.                                                                                                     |
| Pass    | Path is passed to `gh` via `--body-file`.                                                                          |
| Remove  | In a `finally` block. Failure to remove is swallowed (log-and-ignore) — the OS will clean it up eventually.        |

### Status check sequencing

1. If a foreign-repo URL was supplied **and** no summary branch was supplied, surface `unavailable` and stop. (The current-branch fallback would describe the wrong repo, so a foreign lookup must carry an explicit branch.)
2. Pick `targetBranch`: the supplied summary/effective branch, falling back to the current branch (`git rev-parse --abbrev-ref HEAD`) when none is supplied.
3. Probe `gh --version`. On `notFound`, surface `notInstalled` and stop.
4. On `error`, surface `unavailable` and stop.
5. Probe `gh auth status`. On `unauthenticated`, surface `notAuthenticated` and stop.
6. On `error`, surface `unavailable` and stop.
7. Look up the PR for `targetBranch` (routing through `--repo <url>` when a foreign-repo URL was supplied).
   - `lookupError` → surface `unavailable` with the `reason`.
   - `noPr` → surface `noPr` with `branch: targetBranch` and the `history` strip.
   - `found` → surface `ready` with `{ number, url, title }` and the `history` strip.
8. Any unexpected exception anywhere in steps 2–7 is caught and surfaced as `unavailable` with the exception message attached as `reason`.

## Behavior

### Status check

Run the sequence above. The surface shows the appropriate status text and action button (`Retry`, `Create PR`, or `Edit PR`).

### Prepare the create form

1. The panel runs the prepare-time classifier (spec 213). On a blocking outcome it shows the warning and `prCreateBlockedCrossBranch`, and the form is **not** shown. (This branch-decision step is owned by spec 213; this spec resumes once the classifier allows the form.)
2. The panel records the resolved effective branch as the pending branch (passed to the create handler later as `expectedBranch`).
3. Compose the proposed PR body (the dual-marker block wrapping the aggregated branch markdown; aggregation is suppressed when the effective branch differs from the current branch — see spec 213).
4. Send the proposed title and body to the surface as `prShowCreateForm`.

### Create the PR

1. Run the submit-time second guard (detached HEAD / mid-form branch switch). On a block, surface the warning plus `prCreateBlockedCrossBranch` and stop.
2. Surface `prCreating`.
3. `git push -u origin HEAD`. If this is rejected as a non-fast-forward (text markers above):
   - Show the shared force-push confirmation modal (no commit-detail line).
   - If declined, surface `prCreateFailed` and stop — no force-push, no create.
   - If confirmed, re-push the branch with `--force-with-lease` and continue. A lease failure (remote moved) falls through to the failure path in step 9.
   - Any other (non-fast-forward) push failure also falls through to step 9 unchanged.
4. Write the body to a temp file.
5. `gh pr create --title <userTitle> --body-file <tmpPath>`.
6. Trim and capture the stdout (the new PR URL).
7. Refresh the status (re-run the status check scoped to the expected branch).
8. Show an info notification with `Open PR` that opens the URL.
9. On any failure, surface `prCreateFailed` and `Create PR failed — <message>`. Always remove the temp file.

### Prepare the update form

1. Resolve the effective branch for the displayed summary (spec 213).
2. Look up the PR for that branch.
   - `lookupError` → show an error toast and re-run the status check (so the Edit-PR button, which set itself to "Loading…", repaints). Stop.
   - `noPr` → show `No pull request found for branch <name>.` and re-run the status check. Stop.
3. Compose the new body by running the dual-marker replace-or-append against the existing open PR's body.
4. Send the existing title (verbatim — no commit-message override on update) and the new body to the surface as `prShowUpdateForm`.

### Update the PR

1. Surface `prUpdating`.
2. Resolve the effective branch and look up the PR again (state may have changed since the form opened).
   - `lookupError` → surface `prUpdateFailed` and an error toast. Stop.
   - `noPr` → surface `prUpdateFailed` and a warning toast. Stop.
3. If the user-edited title differs from the existing PR title, run `gh pr edit <num> --title <title>`.
4. Run `gh pr edit <num> --body-file <tmpPath>` with the user-edited body.
5. Refresh the status (scoped to the same branch). Show an info notification with `Open PR`.
6. On any failure, surface `prUpdateFailed` and `Update PR failed — <message>`. Always remove the temp file.

## State Transitions

The PR-section in the surface has these states. Every transition is driven by a `prStatus` message produced by the status check, or by a form-submit message:

- **`loading`** (initial) → one of `notInstalled`, `notAuthenticated`, `unavailable`, `noPr`, `ready`.
- **`notInstalled`** is terminal until the user reloads.
- **`notAuthenticated`** offers a `Retry` button that re-runs the status check.
- **`unavailable`** offers a `Retry` button that re-runs the status check. Its text includes the `reason` when one was attached.
- **`noPr`** always offers a `Create PR` button (the prepare-time classifier refuses an un-creatable branch when clicked). When the branch's empty state has no E2E tests yet, it additionally offers a `Generate E2E + Create PR` chain button. The closed/merged **history strip** ("Previously: #N (merged) · #M (closed) · …") is rendered beneath the actions when the lookup returned history.
- **`ready`** offers an `Edit PR` button, renders the open PR as a clickable link, and renders the history strip when present.
- The form (create or update) submits → `prCreating` / `prUpdating` (button disabled) → on success a status refresh; on failure `prCreateFailed` / `prUpdateFailed` re-enables the button. A blocked create emits `prCreateBlockedCrossBranch`, which reverts any "Loading…"/"Creating…" button (including the E2E chain button) back to a clickable state.

Cancel from the form returns the section to whatever state it was in before the form opened (`ready` or `noPr`), with the corresponding visibility restored, and restores the history strip from the cached last history (no re-query of `gh`).

The history strip skips any entry whose URL is not `https://`-prefixed (defense in depth against a malformed/compromised `gh` response smuggling a `javascript:` / `data:` link), and the "·" separator is emitted per rendered entry so a dropped entry never leaves a stranded bullet.

## Notable Behavior

- **Both probes retry once.** A brief Credential Manager hiccup or transient spawn error must not look like "not authenticated" or "not installed". The retry delay is 500 ms. (Notable; defensive.)
- **`ENOENT` is definitive — no retry.** If the binary is missing, retrying does not help. (Notable.)
- **Lookup uses `gh pr list`, not `gh pr view`.** `view` returns only the most-recent PR regardless of state; `list --state all` returns the open PR plus the full closed/merged history in one round-trip, which is what the history strip needs. `list` returns an empty JSON array (not a non-zero exit) for "no PR", so no stderr regex is needed to recognize the miss. (Notable.)
- **The lookup result is a sealed three-outcome union.** `found` / `noPr` / `lookupError` — replacing the old `PrInfo | undefined`, which collapsed real-no-PR, auth/network failure, unparseable JSON, and zero-numbered JSON into the same value and let callers show a misleading `Create PR` for all four. (Notable; the reason the union exists.)
- **Fork (cross-repository) PRs are filtered out.** `--head <branch>` matches by branch name alone, so a contributor fork sharing the head-branch name would otherwise be picked up and — if highest-numbered — selected as the active PR, making `Edit PR` a wrong-target write vector. Rows with `isCrossRepository === true` are dropped. (Notable; defensive.)
- **Multiple open PRs are de-duplicated defensively.** GitHub allows at most one open PR per head branch, so the highest-numbered OPEN row is kept and any others (replication-lag anomaly) are logged at warn. The history type deliberately never carries `OPEN`. (Notable; defensive.)
- **Bodies always go through `--body-file`.** Never inline. This avoids shell-quoting and argument-length issues with multi-line markdown, and also removes any chance of injecting flags through the body. The temp file is created with a CSPRNG filename in the OS temp dir and is removed in a `finally` block. (Notable; defensive.)
- **Title is sent inline.** It is short, single-line, and user-edited; the `--title` argument is fine. (Notable.)
- **PR operations are branch-scoped, not commit-scoped.** The lookup keys on a branch name and ignores the commit hash, so it stays correct across squash / amend / rebase that rewrote the hash. The previous reachability-based cross-branch decision (`git merge-base --is-ancestor <commit> HEAD`) is gone; rename/delete edge cases are now resolved by the prepare-time branch classifier (spec 213) instead. (Notable; the load-bearing change.)
- **The status check never blocks and has no `crossBranch` flag.** It resolves the effective branch (spec 213) and queries it; the `noPr` state always offers `Create PR`, and an un-creatable branch is refused only when that button is clicked (by the prepare-time classifier). (Notable.)
- **The submit-time guard catches only the TOCTOU window.** It re-reads the current branch and compares it to the branch the form was opened for; the full five-outcome classification is not re-run at submit time. (Notable.)
- **Status check never throws; it always emits a `prStatus` message.** Any unexpected exception is caught and surfaced as `unavailable` with the exception message attached as `reason`, so a git failure (detached HEAD, `.git/index.lock`, permission) reads as itself rather than as a misleading "Could not reach GitHub CLI (gh)". The webview never wedges on a missing reply. (Notable; defensive.)
- **Foreign-repo lookups route through `--repo <url>` and require an explicit branch.** A panel showing a summary from another repo (Memory Bank cross-repo browsing) queries that repo's PR; if the foreign repo has no remote URL, or no summary branch was supplied, the status short-circuits to `unavailable` rather than silently querying the current workspace. (Notable.)
- **`Edit PR` does not commit-message-override the title on update.** It uses the existing PR title. The user can still change it in the form, but the form is pre-filled with the live PR title, not the local commit message. Create, by contrast, pre-fills with the commit message because there is no PR title yet. (Notable.)
- **The push (`git push -u origin HEAD`) runs **before** `gh pr create`.** A `gh pr create` against an unpushed branch would fail. The push uses `-u` so subsequent pushes know the upstream. (Notable.)
- **A successful `Create PR` returns the new PR URL on stdout.** The flow trims that string and uses it for the `Open PR` action. There is no extra lookup round-trip after create for the URL — just the status refresh that re-uses the same `gh pr list` path as the initial check to repaint the section. (Notable.)
- **The Create-PR push step negotiates a force-push on a non-fast-forward rejection.** When `git push -u origin HEAD` is rejected because the branch was rewritten after it was first pushed, the create flow shows the same shared force-push confirmation modal the push-button command uses (minus the commit-detail line) and, on confirmation, retries with `--force-with-lease`. A declined modal stops the create silently (`prCreateFailed`, no toast). Any non-fast-forward push failure (auth, network) still surfaces verbatim. The Update-PR flow does no such negotiation (it never pushes). (Notable; the two push entry points share one modal so users see identical wording wherever a force-push is offered.)
- **Only the post-rejection force-push trigger is shared, not the up-front one.** The push-button command also force-pushes *proactively* when HEAD is already on the remote (skipping the doomed normal push). The create flow has no such proactive trigger — it always tries a normal push first and only offers the force-push as a fallback after the rejection. (Notable.)
- **The body the user submits is whatever is in the textarea.** The dual-marker block is pre-filled into the textarea, but the surface does not re-sanitize what the user types. If the user mangles or removes the markers in the textarea, that is what gets pushed. (Notable.)
- **The pane's push-first paths re-check PR existence before pushing.** Because the shared push step can force-push, both the pane's Create and Update paths run the branch lookup *before* touching the remote and refuse to push on `lookupError` (never force-push + create a duplicate when a PR may still exist). A render-time "Create" that turns out to have an open PR confirms a switch to update; a render-time "Update" whose PR vanished confirms creating fresh. (Notable; the reason the pre-push re-check exists.)
- **The create flow can fall back to updating, and the update flow to creating.** The mode the pane rendered is only a hint; the submit-time lookup is authoritative, and each direction asks for explicit modal confirmation before diverging from the rendered mode. (Notable.)
- **The push step can refuse outright (behind-only).** When the branch is merely behind the remote, the shared divergence gate blocks the push (refusal modal, no force-push offered) and the handler surfaces a plain failure with no extra error toast — the create/update simply stops. (Notable; the load-bearing safety change, shared with spec 107.)
- **The pane's push-first update surfaces on the create channel.** Both push-first paths post `prCreateFailed` on failure/block (the pane listens on that channel), not `prUpdateFailed`; `prUpdateFailed` remains the legacy embedded edit flow's channel. (Notable.)
- **Submit paths return a succeeded/failed outcome.** The pane gates the post-success share-to-Space step and its refresh/settle sequence on that outcome; a failed submit means the handler already surfaced the failure and the pane just re-enables its buttons. (Notable.)
- **Progress messages are mid-flight, not settle signals.** "Pushing…", "Updating #N…", and "Creating…" keep the pane's buttons disabled; only a terminal settle re-enables them (spec 237). (Notable.)

## Shared Behavior

- The marker-wrapped block content the body carries (and the regex that locates it for in-place replace) is defined by **PR Description Dual-Marker Embedding**.
- The branch enumeration of `<base>..HEAD` that the aggregating block reads is defined by **PR Description Dual-Marker Embedding**.
- The modal force-push confirmation shown by the pane's push steps (wording, button label, lease semantics), the pre-force-push **divergence gate**, its **blocked** (behind-only) outcome, and the conditional lost-commits detail line are all the **same** shared mechanism defined by the **VS Code Push Command With force-with-lease** topic (spec 107). The push-button command's proactive "HEAD already on remote" up-front trigger is part of that topic, not this one.
- The Jolli document URLs that may appear inside the marker-wrapped block are produced by **Summary Push to Jolli Space**.
- The dedicated Create-PR pane that drives the push-first submit paths — its view-model, submit-time worker-busy guard, host-side re-entry lock, and post-success refresh/settle — is **VS Code Create-PR View** (spec 237).

# 237. VS Code Create-PR View

## Topic Statement

Assemble a branch-scoped pull-request draft — title, body, included memories, diff stats, and E2E scenarios — into a view-model, then present it in a dedicated, editable webview pane that lets the user review the draft, optionally edit the title/body in place, and submit it to the git host through the host-CLI create/update path. The pane is opened per current branch, resolves create-vs-update mode from the host (not the webview), and after a successful submit rebuilds itself from storage, re-resolves the open PR, and (when signed in) shares the branch's memories to the user's Memory Space.

## Scope

**In scope:**

- The command entry point that opens the pane, scoped to the repository's resolved default branch and the caller's current sign-in state.
- The view-model assembly: how the anchor summary is chosen, how title/body are derived, how memories / diff stats / E2E scenarios are gathered, and the empty short-circuit.
- The create-vs-update mode resolution (host-side PR lookup, best-effort) and the heading/label/pill swaps it drives.
- The submit-time worker-busy guard and the host-side re-entry lock.
- The in-place view/edit toggle, the two submit affordances funnelling to one submit message, and the blank-field fallback.
- The copy-body action.
- The post-submit refresh/settle sequence (rebuild from storage, re-resolve PR, share to Space, single terminal settle) and its best-effort/independent semantics.
- The sign-in notice and its in-place swap.
- The PR-history strip and the scheme-guarded link opening.
- The pane's data contract (the view-model field list).

**Out of scope (boundaries):**

- The host-CLI PR mechanics the submit paths invoke — precondition probes, PR lookup, temp-file body delivery, create-vs-update-with-push submit logic, force-push negotiation; see **PR Creation and Update via gh** (spec 99).
- The five-outcome branch classifier and its prepare-time/submit-time blocking. This pane deliberately does **not** run that classifier at open time; see **Create-PR Branch Classification** (spec 213).
- The PR title/body content and the shared title/body builders this pane consumes; see **PR Description Generation** (spec 209) and **PR Description Dual-Marker Embedding** (spec 98).
- The per-file diff preview opened from the Files-changed list; see **VS Code Create-PR Diff Preview** (spec 238).
- The markdown→HTML rendering of the body panel; see **Create-PR Body Markdown Assembly** (spec 239).
- The post-success sharing of branch memories to the Memory Space (reference only); see **Summary Push to Jolli Space** (spec 94).
- The branch-summary enumeration and default-branch base resolution; consumed as black-box inputs.

## Data Contracts

### Entry point

A single command opens (or reveals) the pane. It is invoked with:

- The repository's **resolved default branch** (the remote head, e.g. `origin/HEAD`), used as the diff/aggregation base — **not** a hardcoded `main`. This matches the base the share-to-Space step uses, so the pane counts and shares the same commit set.
- The caller's current sign-in state.

If the branch has no committed memories the pane is **not** opened: an info notification ("no committed memories on this branch — nothing to open a PR from") is shown and the command returns.

### View-model

The pane renders from a single view-model. Two groups of fields exist: those the pure builder computes from storage, and those the host populates because they require side effects the builder can't perform.

| Field | Source | Meaning |
|---|---|---|
| Branch | builder | The PR's head branch: the anchor summary's recorded branch, or the current branch when the anchor has none. |
| Base branch | builder | The repository's resolved default branch (the diff base). |
| Memory count | builder | Number of summaries loaded for the branch. |
| Missing count | builder | Commits on the branch with no recorded summary. |
| Insertions / deletions / files-changed | builder | Diff stats of the branch delta base vs HEAD. |
| Title | builder | PR title derived from the anchor summary (shared title builder). |
| Body markdown | builder | Raw PR body markdown, **without** idempotent markers. |
| Memories | builder | One row per summary: commit hash + first line of the commit message (newest not distinguished). |
| Files | builder | One row per changed file: path, directory, status code, and — for a rename — the old (base-side) path. |
| E2E scenarios | builder | Test scenarios **aggregated across all included summaries**. |
| Existing PR | host | The branch's open PR (number + URL), when one exists. Absent ⇒ create mode. |
| PR history | host | The branch's closed/merged PRs (number, URL, state), newest-first. |
| Signed in | host | Whether the user is signed in to the Memory Space. Absent is treated as signed-out (never falsely claim signed-in). |

### Anchor and aggregation

Branch summaries are loaded in chronological order (oldest first). The **anchor** is the newest summary (the last element). Title and body are derived from the anchor via the shared PR title/body builders (spec 209). Because those builders themselves aggregate across all summaries when more than one exists, and because the anchor's newest commit may carry no E2E scenarios, the pane deliberately aggregates E2E scenarios across **every** included summary rather than reading only the anchor's — so the E2E section is not blanked just because the newest commit generated none.

### This pane is a third direct consumer of the shared builders

The pane calls the shared PR title and body builders **directly**, bypassing the full PR-description orchestrator (spec 209), and applies its **own** empty short-circuit: zero summaries → an empty sentinel that suppresses the pane, rather than the orchestrator's thrown error. The body it holds is builder output with no idempotent markers; markers are added only at submit time.

## Behavior

### Opening the pane

1. Build the view-model from storage for the resolved default branch. If empty, show the info notification and stop.
2. Set the sign-in field from the caller.
3. Best-effort host PR lookup for the branch (spec 99): if an open PR exists, record it (drives update mode); if closed/merged PRs exist, record them as history. A lookup failure (host CLI missing / unauthenticated / transient) is swallowed — the pane opens in create mode with no history.
4. If a pane is already open, re-render it with the new view-model and reveal it; otherwise create a single-instance pane and render.

**No branch classifier runs at open** (contrast spec 213): the branch is taken from the anchor's recorded branch or the current branch, with no cross-branch / rename / detached-HEAD blocking. Only the lighter submit-time guards apply.

### Create vs update mode

Mode is **host-resolved**, not chosen by the webview:

- An open PR was found ⇒ **update** mode: the heading and primary button read "Update…", and a clickable "PR #N" pill links to it.
- No open PR (or the lookup failed) ⇒ **create** mode: "Create…" heading/button, no pill.

The webview sends the **same** submit message in both modes. The host is the source of truth for which submit path actually runs (push-first update of the existing PR vs create-a-fresh-PR); see spec 99.

### Submit guards

On a submit message, two guards run before any host PR work:

1. **Worker-busy guard** — a single, non-blocking check of whether the summary worker is blocking-busy. If busy: show a warning toast, immediately re-enable the pane's buttons (post the settle signal so the disabled buttons don't stick), and return. It never retries, never polls, and does **not** consume the queue-status wait engine. It runs before the create/update branch, so it covers both modes.
2. **Host-side re-entry lock** — an instance-level in-flight flag spanning re-renders. Re-invoking the open command re-renders the same pane and resets the webview's own transient in-flight flag, so without a host-side lock a second click while the first submit is still awaiting could fire concurrent pushes and a duplicate PR. A submit arriving while the lock is held is refused (buttons re-enabled for a later retry).

### In-place edit

- The pane has a read-only view mode and an edit mode; toggling between them is **client-side only** (no host round-trip). Cancel returns to view mode with the typed values retained.
- Both the read-only primary button and the edit-form primary button funnel to the **same** submit message.
- The submitted title/body are the edited values when present; a field that **trims to empty** silently falls back to the drafted value — a blank title or body is never submitted.
- The body is wrapped in idempotent markers at submit time (both the edited and drafted paths).

### Copy body

Writes the marker-wrapped **drafted** body (not the edit-form contents) to the system clipboard and shows a **native** confirmation toast. There is no in-webview "copied" toast.

### Post-submit refresh and settle

The submit paths return a succeeded/failed outcome (spec 99). On **failure or block**, the submit path has already emitted the failure/block signal the buttons listen for; the pane stays put with the edit form open for a retry. On **success**:

1. If signed in: post a progress message and share the branch's memories to the Memory Space (reference only — spec 94). A share failure is surfaced as a non-blocking toast and **never** rolls back the already-created PR. An unexpected throw here is caught so it can't skip the settle below.
2. **Rebuild** the whole view-model from fresh storage. The share step persists freshly-minted document URLs back to each summary; a rebuild picks them up so the body now carries those links (absent at first render, nothing had been pushed yet). Best-effort: a rebuild failure logs and falls back to the prior view-model.
3. **Re-resolve** the open PR for the branch. This flips a fresh create into update mode (clickable pill), and re-points an update that fell back to creating a new PR at the new one. Independently best-effort.
4. Post a **single terminal settle signal** that re-enables the buttons, clears the progress line, and returns to read-only view.

Mid-flight progress messages (pushing / updating / creating / sharing) are **not** settle signals — the buttons stay disabled and the progress line keeps updating through the whole operation, including the share step. Only the terminal settle re-enables the pane.

### Sign-in notice

A notice above the title panel has a signed-in variant (creating the PR also shares the memories) and a signed-out variant (a Sign-In affordance plus "or create the PR now; it stays a normal git PR"). When the user signs in (typically from that very affordance), the host pushes an auth-changed message and the notice swaps variants **in place** — deliberately not a re-render, which would wipe any title/body typed into the edit form. The Sign-In affordance kicks off the browser OAuth flow; on success the host posts the swap message.

### PR-history strip

When the branch has closed/merged PRs, a lightweight "Previously: #N (merged) · #M (closed) · …" strip renders under the meta strip. Each entry, and the open-PR pill, is a link that posts its URL to the host; the host opens it externally only behind an **http(s)-only scheme guard** (a `file:` / `command:` / `vscode:` URL is rejected and logged). This mirrors the defense-in-depth scheme check on the PR-lookup rows in spec 99.

### Other row actions

- Clicking a memory row opens that memory's summary view.
- Clicking a Files-changed row opens the per-file diff preview (spec 238).

## State Transitions

The pane is a single-instance webview. Its host-side mutable state:

| State | What changes |
|---|---|
| Current view-model | Set on render; rebuilt after a successful submit. |
| Sign-in flag | Set on render and updated in place by the auth-changed message. |
| Re-entry in-flight flag | Set true across a submit; cleared in a finally so a failure never wedges the lock. |

Webview button states, driven by host messages:

- **Idle (read-only or edit)** → submit → **In-flight** (buttons disabled; progress line shows).
- **In-flight** → failure/block signal → **Idle** (buttons re-enabled; stays on the submitted mode so an edit can be fixed and retried).
- **In-flight** → terminal settle signal → **Idle, read-only** (buttons re-enabled; edit form dismissed).
- Mid-flight progress messages keep the pane **In-flight**.

## Notable Behavior

- **The pane never runs the branch classifier at open.** It resolves its branch directly (anchor's branch or current) with no cross-branch/rename/detached blocking. Only the submit-time guards apply. This is the deliberate divergence from the summary-panel Create-PR flow (spec 213). (Notable.)
- **Create-vs-update is host-resolved and best-effort.** A host lookup failure leaves the pane in create mode; the submit path re-checks existence before any push, so a masked existing PR never becomes a silent duplicate (spec 99). (Notable.)
- **The worker-busy guard is a single non-blocking probe, not a wait.** It refuses once and re-enables the buttons; it does not drain or wait on the queue. (Notable.)
- **Two in-flight guards, at two layers.** The webview's transient flag stops a double-click within one render; the host-side lock survives re-renders of the singleton. Both are needed because re-invoking the open command resets the webview flag. (Notable.)
- **Blank edited fields fall back to the draft.** Trimming a field to empty submits the drafted value, so the user can never accidentally push a PR with a blank title or body. (Notable; defensive.)
- **Copy uses the drafted body, not the edit-form text.** The clipboard always gets the marker-wrapped draft even if the user has typed edits into the (unsubmitted) form. (Notable.)
- **E2E scenarios aggregate across all summaries, not just the anchor.** A newest commit without scenarios doesn't blank the E2E section. (Notable.)
- **The post-submit rebuild is what surfaces the freshly-minted memory links.** At first render nothing had been shared, so the body had no Memory-Space links; rebuilding from storage after the share step picks them up. (Notable.)
- **Every post-submit step is independently best-effort.** Share, rebuild, and PR re-resolve each catch their own failures and fall back; the success toast already confirmed the PR, so none of them blanks the pane. (Notable; permissive.)
- **The sign-in notice swaps in place to preserve edits.** A full re-render would discard anything typed into the edit form, so auth changes are applied via a targeted message. (Notable.)
- **The malformed-summary render is guarded.** Because summaries are deserialized without read-time schema validation, the E2E section coerces each title/step/expected value to a string and tolerates a non-array field — a single synchronous build with no render try/catch would otherwise white-screen the whole pane on one bad summary. (Surprising; defensive.)

## Shared Behavior

- The host-CLI PR create/update mechanics, precondition probes, PR lookup, and the two push-first submit paths this pane triggers are defined by **PR Creation and Update via gh** (spec 99).
- The shared PR title and body builders (three-tier title, single- vs multi-commit body) are defined by **PR Description Generation** (spec 209); their internal section layout and the marker wrapping are **PR Description Dual-Marker Embedding** (spec 98).
- The branch classifier this pane deliberately skips is **Create-PR Branch Classification** (spec 213).
- The per-file diff preview opened from the Files-changed list is **VS Code Create-PR Diff Preview** (spec 238).
- The markdown→HTML rendering of the body panel is **Create-PR Body Markdown Assembly** (spec 239).
- The post-success sharing of branch memories to the Memory Space is **Summary Push to Jolli Space** (spec 94).

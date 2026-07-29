# IntelliJ Create-PR View

## Topic Statement

A dedicated, branch-level "Create PR" editor tab in the JVM IDE that aggregates **every** committed memory on the current branch into a single pull-request draft, and — when the user is signed in — shares those memories to the Jolli backend in the **same** submit action. It is distinct from, and coexists with, the pre-existing per-memory Create-PR form embedded in a single memory's summary viewer: this view is one draft for the whole branch, drawn from the branch's newest memory but backed by the full memory set.

## Scope

**In scope:**

- The trigger from the bottom action bar's "Create pull request" button, which opens this branch-level view (as opposed to the pre-existing row-level action that opens the newest memory's summary viewer).
- The view-model assembly: aggregate all branch memories newest-first; anchor the PR title, body, and end-to-end scenarios on the newest memory; compute branch-delta diff stats (insertions / deletions / files) over `base..HEAD` where the base is the shared own-commits-base resolver; flag whether HEAD has unpushed changes; detect an existing open PR for the branch; detect whether a Jolli site key is configured (signed-in); sum a branch-wide token/cost total across every committed memory.
- The branch token/cost banner rendered under the heading.
- The editor-tab plumbing: a virtual file whose identity is the branch name, so re-triggering on the same branch reuses the open tab instead of stacking; a hide-default-editor policy; a read-only virtual file.
- The embedded webview and its base64 message tunnel (both directions), inbound and outbound message vocabularies.
- The theming inputs and their disagreement: the pre-load shell colour taken from the IDE's live editor background, the light/dark palette taken from the widget theme's brightness flag, and the page's own hard-coded per-theme background.
- The fact that this view constructs and destroys its own embedded-browser instance rather than borrowing a pooled one.
- The submit flow: push the branch, then find-or-create-or-update the PR, then share the included memories (when signed in), then rebuild and re-render so the view flips into update mode.
- The binding-required resolution handled inline via the binding-chooser dialog, resolved at most once per submit even across multiple shared memories.
- Cross-panel synchronization via a memory-state publish/subscribe channel so the commits list, any open memory summary, and this view converge on one source of truth after any of them creates a PR or shares a memory.
- The dirty-edit guard that prevents a cross-panel refresh from clobbering unsaved title/body edits.
- The fallback rendering path when the webview cannot be created.
- The "commit first" hint when the branch has no committed memories.

**Out of scope (boundaries):**

- The per-commit Create-PR form embedded in a single memory's summary viewer (a separate surface that continues to exist independently) — see the embedded-summary-viewer spec.
- The reusable share core that this view invokes per included memory (plan push, summary push, orphan cleanup, telemetry) — see the share-to-Jolli spec.
- The push/list-spaces/create-binding wire protocol, tenant resolution, and the status-code mappings — see the summary-push, binding-required-flow, plugin-outdated-flow, and tenant-resolution specs.
- The binding-chooser dialog's own internal behavior — see the binding-chooser-dialog spec.
- The own-commits-base / branch-creation-point resolver's algorithm — see the commits-panel spec.
- The `gh`-driven PR create/update/lookup operations — owned by the PR service.
- The VS Code branch-classification blocking rules — **deliberately not consumed here** (see Notable Behavior).

## Data Contracts

### Trigger and gating

The bottom action bar's "Create pull request" button asks the commits surface to open this view. Opening:

1. Runs on a background thread (it shells out to git and `gh`).
2. Builds the view model from real branch data. If the branch has **no** committed memories, the build returns nothing and the user is shown an informational hint: `No committed memory on this branch yet. Commit first, then create a PR.`
3. Otherwise opens the view as an editor tab.

When the action bar is showing a foreign (read-only) repo/branch, the Create-PR button is hidden entirely.

### View model (the create-PR draft)

Built once per open/refresh from branch data:

| Field | Meaning |
| --- | --- |
| Branch | The current branch name (from the newest memory, falling back to the live current-branch lookup). |
| Main branch | The mainline branch name the PR targets (defaults to the conventional main name). |
| Memory count | Number of committed memories aggregated. |
| Insertions / Deletions / Files changed | Aggregate diff stats over the branch delta `base..HEAD`. |
| Title | PR title — the first line of the **newest** memory's commit message. |
| Body markdown | PR body drafted from the newest memory. Carries **no** idempotent markers; the markers are applied at submit time. |
| Memories | One row per memory, newest-first: `{ commit hash, title (first line of its commit message), shared-article URL or none }`. |
| Files | One row per changed file in the branch delta: `{ path, directory, single-letter status }`. Rename codes normalize to a bare `R`. |
| E2E scenarios | The newest memory's end-to-end test scenarios (may be empty). |
| Existing PR | `{ number, url }` when an open PR already exists for the branch; otherwise none. Its presence flips the view into update mode. |
| Signed-in | True when a Jolli site key is configured. Gates the "also share to Jolli" copy and behavior. |
| Included summaries | The full memory objects, newest-first — the payload the share step pushes. |
| Has unpushed changes | True when HEAD is not yet on the branch's remote (something to push). Defaults to true so create-mode and tests are not accidentally treated as up to date. |
| Branch token/cost totals | Token breakdown (input/output/cached) and estimated cost summed across **every** committed memory on the branch — see the token/cost banner below. `null`/no-data when no committed memory on the branch carried usage. |

### Branch token/cost banner (NEW)

Rendered directly under the page heading, above the meta strip: a branch-wide token/cost total summed across every committed memory on the branch (not just the newest one the rest of the draft is anchored on). It has two states:

| State | Condition | Rendering |
| ----- | --------- | --------- |
| Data present | The branch total has any recorded usage | The bold token total, an estimated-cost figure (prefer each contributing memory's already-decided stored-or-Sonnet-estimate cost, summed — never re-priced at this level), a three-segment colored bar (input / output / cached — green / grey / blue, the same convention as the per-commit embedded viewer's own banner, spec 120), a legend, and — when any contributing memory lacked recorded usage — a "partial" note. |
| Not reported | No committed memory on the branch has any recorded usage | The literal text "Token usage not reported for this branch" (no bar, no cost). |

Unlike the per-commit embedded viewer's banner (spec 120), which has a third "tokens-only, no breakdown" state, this branch banner has no such middle state: because the branch total is built purely by summing each commit's already-computed breakdown, a nonzero total always carries a breakdown to render as a bar. The banner's markup and color variables are declared independently here rather than shared with the per-commit viewer's stylesheet — they're kept visually identical by convention, not by a shared component, so a future change to one does not automatically apply to the other.

### Delta base resolution

The branch delta's base (`base..HEAD`) is resolved to match the commits-panel listing exactly, so the stats and file list line up with the memories shown:

1. Pick the first resolvable mainline ref among the remote-main, upstream-main, and local-main candidates; fall back to the local main name.
2. Compute the merge-base of HEAD and that ref. If there is no common ancestor, the delta is empty (zero stats, no files).
3. If the merge-base equals HEAD (a fresh branch with no own commits), use the merge-base directly.
4. Otherwise narrow the base to the branch's own-commits base via the shared own-commits-base / branch-creation-point resolver, so a branch cut from a feature or release branch does not inherit the parent branch's commits.

### Inbound messages (page → host)

Carried as base64-encoded JSON over the single host-bridge channel:

| Message | Payload | Purpose |
| --- | --- | --- |
| create-PR | `{ title?, body? }` | Push the branch and create or update the PR, then share the included memories when signed in. Blank/absent title or body fall back to the view-model values. |
| copy-body | `{ body? }` | Wrap the (possibly edited) body in the idempotent markers and place it on the system clipboard. |
| open-memory | `{ hash }` | Open the named included memory as a summary editor tab (resolved from the already-loaded included-summaries — no host round-trip). |
| open-diff | `{ path }` | Open the repo-relative file in the editor. Paths that are absolute (leading separator) or contain a parent-traversal segment are silently rejected. |
| open-pr | `{ url }` | Open the existing PR URL in the system browser. |
| sign-in | (none) | Start the sign-in flow; on success the view re-renders with the signed-in affordances. |
| edit-state | `{ editing }` | The dirty-flag guard: the page reports that the user has unsaved title/body edits. |

### Outbound messages (host → page)

Dispatched over a single custom event; the page branches on the message name:

| Message | Effect on the page |
| --- | --- |
| creating | Enter the in-flight state; show a status line (e.g. "Pushing branch…"). |
| progress | Update the status line (used during the share step, e.g. "PR ready — sharing memories to Jolli…"). |
| created | Leave the in-flight state; show a final status line. |
| error | Leave the in-flight state; show the error text in the status line. |
| body-copied | Show a transient toast confirming the clipboard copy. |

External `http`/`https` link clicks inside the page are intercepted at the host request layer and routed to the system browser (identical policy to the embedded summary viewer).

## Behavior

### Editor-tab identity

The view is hosted by a virtual file whose equality and hash are **the branch name alone**. Re-triggering "Create PR" on the same branch therefore reopens the same tab rather than stacking a new one; a different branch opens a distinct tab. The tab is read-only, titled for the branch, and uses a hide-default-editor policy so no fallback text editor competes with it.

### Theming and the first load

**Before the first content load**, the IDE's live editor background colour is read and applied to both the hosting component and the embedded browser's initial blank page. The browser keeps the blank page painted until the real page commits its first frame, so this is what stops the initial blank-to-content navigation from flashing white. It applies to the *first* load only; a re-render replaces content with content, where the previous page stays painted and there is no blank page to cover.

**Theming divergence worth recording.** The pre-load colour above comes from the **editor colour scheme**, while the light/dark palette baked into the page comes from the **widget theme's brightness flag** — two independent settings that can disagree. The memory-summary view (spec 120) derives both from one colour precisely so they cannot; this view was given the pre-load background treatment without that second half. This view's page background is also not the editor colour at all: its stylesheet is declared independently of the memory-summary view's and carries a hard-coded background per theme, so the pre-load shell colour and the page's own background differ whenever the editor scheme's background is not that hard-coded value.

### Rendering

The page renders, top to bottom: the heading; the branch token/cost banner (see above); a meta strip (branch → main, an optional PR-number link, the "drafted from N memories" count, and the aggregate diff stats); a sign-in-aware sub-line describing the one-click share; an editable Title panel; an editable Body panel (rendered from markdown for display, with a hidden textarea editor); a "Memories included" list (each row opens its memory, and shows a muted "shared" marker when it already has a shared-article URL); an optional E2E test-guide panel (only when the newest memory has scenarios); a "Files changed" list (each row opens its file); and an action row with the primary button, an Edit toggle, a Copy-body button, and — in update mode when there are no unpushed commits — an informational hint.

Update vs create mode is driven solely by whether an open PR already exists: the heading and primary-button label switch between create and update wording, and the meta strip shows the PR-number link.

### Edit toggle

The Edit button flips the Title and Body panels between their read-only display and inline editors. Toggling back re-renders the display from the current edits. Create/Update and Copy-body always submit the live editor values, so the edited and un-edited paths share one code path.

### Dirty-edit guard

Any real content change in an input, textarea, or content-editable region makes the page emit the edit-state message with the editing flag set. The host records the view as dirty. A cross-panel memory-state notification (see below) that would rebuild and reload the page **returns early while dirty**, so in-progress typing is never silently dropped; the state re-syncs on the next full reload. A full reload (which replaces the DOM and therefore discards any prior edits regardless) clears the dirty flag so future notifications can refresh again. The guard is re-checked both before and after the background rebuild.

### Submit flow (create-PR message)

On a background thread, within one trace scope:

1. Post the creating message ("Pushing branch…").
2. Push the branch to its remote.
3. Look up the PR for the branch.
   - **Open PR exists (update):** merge the freshly built body into the existing PR body's marker region, **preserving any user-authored text outside the markers**, then update the PR with the new title and merged body. The PR URL is the existing one.
   - **No open PR (create):** wrap the body in the idempotent markers and create a new PR with the title and wrapped body.
4. If signed in, share the included memories (see below); capture a human-readable partial-success suffix.
5. Rebuild the view model from fresh data (new PR lookup + summaries). On success, replace the model and re-render — this flips the view into update mode, so a subsequent submit updates the PR rather than erroring on a duplicate create. If the rebuild fails, post the created message with the share suffix instead.
6. Show an informational dialog with the PR URL and the share suffix.
7. Notify the memory-state channel so the other surfaces re-read (a PR now exists and memories may have been shared).

On any exception during the flow: post the error message with the failure text and show an error dialog. (The branch push and PR calls are not retried here.)

### Sharing the included memories

Only when a Jolli site key is configured and a base URL can be resolved (from the key, falling back to the saved site URL). For each included memory, newest-first, the view invokes the reusable share core (which pushes the memory's plans and the memory itself, persists the updated memory, and cleans up orphaned docs). It counts successes and failures and can stop the whole batch early:

- **Binding required** on a memory: resolve the binding **at most once per submit**. The first time, list the available spaces and open the binding-chooser dialog (modal, resolved synchronously on the UI thread; skipped if a chooser for this repo is already open). If the user selects a space, retry that memory once and continue the batch with the binding treated as resolved for all remaining memories. If the user refuses or the binding cannot be resolved, stop the batch with reason "space not bound".
- **Unauthorized** (key rejected): stop the batch with reason "sign-in rejected".
- **Plugin outdated:** stop the batch with reason "plugin outdated".
- **Any other per-memory failure:** count it as failed and continue to the next memory.

The suffix reported back to the success toast is honest about partial results:

| Condition | Suffix |
| --- | --- |
| Batch stopped early | ` Sharing stopped (<reason>) — shared <n> of <total> to Jolli. See log.` |
| Some memories failed | ` Shared <n> of <total> to Jolli — <f> failed. See log.` |
| All attempted succeeded | ` Shared <n> memory/memories to Jolli.` |
| Nothing shared | ` Sharing failed — 0 of <total> shared to Jolli. See log.` |

While sharing runs, a progress message updates the page status line.

### Cross-panel synchronization

A single memory-state publish/subscribe channel ties together every surface that displays two shared facts: the branch's PR (there is exactly one PR per branch) and each memory's shared-article URL. This view, the commits list, and any open memory summary all subscribe. When any of them creates/updates a PR or shares a memory, it notifies the channel; every subscriber re-reads the shared truth and re-renders so they never disagree. This view's subscriber rebuilds the model off a background thread and re-renders — subject to the dirty-edit guard above. The view unsubscribes when disposed.

### Open-memory and open-diff

- Open-memory resolves the memory from the already-loaded included set and opens it as a summary editor tab; an unknown hash is ignored.
- Open-diff opens the repo-relative file in the editor after the traversal/absolute-path rejection. Despite its message name, it opens the file, not a side-by-side diff.

### Copy body

Copy-body takes the live (possibly edited) body, wraps it in the idempotent markers (the same wrapping create-mode submits), copies it to the clipboard, and confirms with a toast. In update mode the copy is the wrapped body — it does not perform the marker-region merge that a real update submit does.

### Fallback rendering

If the embedded webview cannot be instantiated in this environment, the view degrades to a read-only text component showing the PR body markdown as plain text. None of the interactive messages are available in that fallback.

## State Transitions

```
[action bar: Create PR clicked]
  background: build branch view model
    if no committed memories → show "commit first" hint; stop
    else → open (or reuse) the branch-keyed editor tab

[view opened]
  render create-or-update page from the model
  subscribe to the memory-state channel

[user edits title/body]
  page emits edit-state(editing=true) → host marks view dirty

[memory-state notification arrives]
  if dirty → ignore (keep unsaved edits)
  else → rebuild model in background; re-render

[user clicks primary (create-PR)]
  post creating
  push branch
  find PR:
    found → merge body into marker region → update PR
    none  → wrap body in markers → create PR
  if signed in → share included memories (binding resolved ≤ once; stop on auth/outdated/binding-refusal)
  rebuild model:
    success → re-render (now update mode); clear dirty
    failure → post created(with share suffix)
  show info dialog (PR url + share suffix)
  notify memory-state channel
  on exception → post error; show error dialog

[user clicks a memory row] → open that memory as a summary tab
[user clicks a file row]   → open that repo file (reject absolute / traversal)
[user clicks PR link]      → open PR url in system browser
[user clicks sign-in]      → run sign-in; on success re-render signed-in

[view disposed]
  unsubscribe from the memory-state channel; dispose the webview
```

## Notable Behavior

- **This view is branch-level; the per-memory Create-PR form still exists.** The bottom action bar now opens this aggregate view. The older row-level action opens the newest memory's summary viewer, whose own embedded per-commit Create-PR form is unchanged. Both surfaces coexist. (Notable.)
- **The draft is anchored on the newest memory but backed by the whole branch.** Title, body, and E2E scenarios come from the newest memory; the diff stats span the branch delta; the "memories included" list and the share payload span every committed memory. (Notable.)
- **The branch token/cost banner is branch-wide, unlike the rest of the draft.** It sums usage across every committed memory on the branch (not just the newest), mirroring the branch-level scope of the diff stats and memories list rather than the newest-memory anchor used for title/body/E2E. It has one fewer state than the per-commit viewer's equivalent banner (no "tokens-only" middle state) because the branch total is built purely by summing already-computed per-commit breakdowns. (Notable.)
- **This view has no force-push / non-fast-forward handling.** Unlike the embedded per-commit Create-PR form (spec 120, spec 264), the submit flow here pushes the branch and discards the result without inspecting it for a non-fast-forward rejection — there is no divergence check or confirmation gate on this surface. (Notable divergence, not a defect being tracked here.)
- **The delta base uses the own-commits-base resolver, not a plain merge-base with main.** This keeps the stats/files aligned with the commits-panel listing and prevents a branch cut from a feature/release branch from counting the parent branch's commits. (Notable.)
- **Update mode never disables the primary button, despite the model's stated intent.** The view model documents that the primary button should dim when there are no unpushed commits; the rendered page deliberately overrides this — the PR body is drafted from editable memory content that can change without a new git commit, so an update is always a valid action. When there are no unpushed commits it only shows an informational hint, and the button stays enabled. (Bug-shaped divergence; the rendered reality wins.)
- **Binding is resolved at most once per submit.** Even when several memories each hit a binding-required verdict, the chooser opens only for the first; once the user picks a space, the rest of the batch proceeds without re-prompting. A refusal stops the whole batch. (Notable.)
- **The batch stop reasons are diagnosable, per-memory failures are merely counted.** Auth rejection, plugin-outdated, and binding refusal halt the batch with a named reason; any other memory's failure is counted and skipped, and the suffix always points at the log for detail. (Notable.)
- **The submit is honest about partial success.** The success toast never implies every memory shared when some failed or the batch stopped early. (Notable.)
- **The tab is keyed by branch.** Re-triggering on the same branch reuses the tab; this is why the virtual file's identity is the branch name and nothing else. (Notable.)
- **open-diff opens a file, not a diff.** The inbound message is named for a diff but the handler opens the working-tree file in the editor. The path is validated to be repo-relative (no leading separator, no parent-traversal segment) before opening. (Naming quirk; reality is a file open.)
- **The dirty-edit guard trades staleness for safety.** A cross-panel refresh that arrives while the user is typing is dropped rather than reloading and losing the edits; the view re-syncs on the next reload. Losing in-progress typing is treated as the worse failure. (Surprising; intentional.)
- **The VS Code branch-classification blocking rules are not consumed here.** That surface can block PR creation on branch classification; this view has no such guard and always builds from the branch's committed-memory set. (Divergence; intentional.)
- **The pre-content blank page is theme-coloured, which is what removes the white flash on open.** The embedded browser keeps the previous document painted until the new one commits a frame, so colouring the blank page (and the hosting component) covers the whole parse-and-first-paint window of the first load. A re-render is content-to-content and needs no such cover. (Notable.)
- **Three theming inputs, only two of which agree by construction.** The pre-load shell colour is the live editor background; the light/dark palette is the widget theme's brightness flag; the page's own background is a hard-coded per-theme value in this view's independently-declared stylesheet. So the shell and the page can be different shades, and the palette can be chosen for the opposite brightness from the shell. The memory-summary view (spec 120) collapses all three onto one colour; this view does not. (Divergence; not yet closed here.)
- **This view is not pooled.** It constructs its own embedded browser instance and destroys it on disposal, unlike the memory-summary tab which borrows one from the project-scoped pool and hands it back. It is consequently not counted against that pool's capacity (spec 302). (Notable.)
- **Update preserves user text outside the markers.** An update merges the freshly built body only into the marker region, so hand-authored prose the user added outside the markers survives; a create wraps the whole body in fresh markers. (Notable.)

## Shared Behavior

- **Message tunnel** — the base64-encoded-JSON bidirectional bridge and the external-link interception are the same mechanism the embedded summary viewer uses.
- **Own-commits-base / branch-creation-point resolver** — the delta base and the commits-panel listing share this resolver (commits-panel spec).
- **Reusable share core** — each included memory's push (plans + summary + orphan cleanup + telemetry) is delegated to the share-to-Jolli core (share-to-Jolli spec).
- **Binding-chooser dialog** — the inline binding-required resolution reuses the binding-chooser dialog and its outcome contract (binding-chooser-dialog spec).
- **Memory-state publish/subscribe** — the cross-panel synchronization channel shared with the commits list and the summary viewer.
- **PR service** — branch push, PR lookup, create, update, and the marker-region merge/wrap helpers.
- **Summary viewer / summary virtual file** — the destination of an open-memory click.
- **Summary-push, binding-required-flow, plugin-outdated-flow, tenant-resolution specs** — the wire-level contracts the share core rides on.

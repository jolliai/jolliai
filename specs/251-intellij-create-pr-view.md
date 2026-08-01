# IntelliJ Create-PR View

## Topic Statement

A dedicated, branch-level "Create PR" editor tab in the JVM IDE that aggregates **every** committed memory on the current branch into a single pull-request draft, and — when the user is signed in — shares those memories to the Jolli backend in the **same** submit action. It is distinct from, and coexists with, the pre-existing per-memory Create-PR form embedded in a single memory's summary viewer: this view is one draft for the whole branch, drawn from the branch's newest memory but backed by the full memory set.

## Scope

**In scope:**

- The trigger from the bottom action bar's "Create pull request" button, which opens this branch-level view (as opposed to the pre-existing row-level action that opens the newest memory's summary viewer).
- The **two-stage open**: a cheap draft that puts the tab on screen immediately, then a full draft that replaces it, and everything that happens in between (loading placeholders, disabled controls) or goes wrong (a load-failure state, two ways the swap can miss its tab).
- The view-model assembly: aggregate all branch memories newest-first; anchor the PR title, body, and end-to-end scenarios on the newest memory; compute branch-delta diff stats (insertions / deletions / files) over `base..HEAD` where the base is the shared own-commits-base resolver; flag whether HEAD has unpushed changes; detect an existing open PR for the branch; detect whether a Jolli site key is configured (signed-in); sum a branch-wide token/cost total across every committed memory.
- The branch token/cost banner rendered under the heading.
- The editor-tab plumbing: a virtual file whose identity is the branch name, so re-triggering on the same branch reuses the open tab instead of stacking; a hide-default-editor policy; a read-only virtual file. Plus the fact that the carrier holds the draft it was opened with and is never updated afterwards.
- The embedded webview and its base64 message tunnel (both directions), inbound and outbound message vocabularies.
- The theming inputs and their disagreement: the pre-load shell colour taken from the IDE's live editor background, the light/dark palette taken from the widget theme's brightness flag, and the page's own hard-coded per-theme background.
- The borrowed pooled embedded-browser instance: the lease taken at construction, the tag it carries, the hand-back on close, and what a refused lease degrades to.
- Where the PR body's markdown is turned into HTML (in the host, baked into the page) and the render round trip that runs when the user leaves the inline editor.
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
- The TTL cache that memoizes the existing-PR lookup and the tool-presence / sign-in probes, and this view's obligation to invalidate a branch on submit — see **309. IntelliJ PR-Status Cache**. This topic owns only *when* this view invalidates and why the ordering matters.
- The embedded-browser pool's checkout / hand-back discipline, capacity, and refusal semantics — see **302. IntelliJ Embedded-Browser Pool**. This view is one of its consumers.
- The PR-body markdown-to-HTML renderer itself (its whitelist, escaping contract, and inline passes) — see **239. Create-PR Body Markdown Assembly**. This topic owns only when it is invoked and what happens to its output.
- The single-memory-tab reuse rule that a memory-row click goes through — see **121. IntelliJ Summary Virtual-File Editor**.
- The VS Code branch-classification blocking rules — **deliberately not consumed here** (see Notable Behavior).

## Data Contracts

### Trigger and gating

The bottom action bar's "Create pull request" button asks the commits surface to open this view. Opening runs entirely off the interface thread (it shells out to git and `gh`) and proceeds in **two stages** — see *Two-stage open* under Behavior. In outline:

1. Build the **cheap draft**. If the branch has **no** committed memory the cheap build returns nothing and the user is shown an informational hint: `No committed memory on this branch yet. Commit first, then create a PR.` No tab is opened, and any tab already open is left alone.
2. Otherwise put the tab on screen from the cheap draft (or activate and focus the tab already open for that branch).
3. Build the **full draft** and swap it into the tab whose branch matches.

When the action bar is showing a foreign (read-only) repo/branch, the Create-PR button is hidden entirely.

### View model (the create-PR draft)

One shape serves all three states — cheap, full, and load-failed — distinguished by the two state fields at the end of the table. Built from branch data on open, on refresh, and after a submit:

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
| Loading | True while this is the **cheap** draft: only branch, main branch, memory count, aggregate diff totals, title, signed-in, and the token totals are real; body, memories, files, scenarios, and existing-PR are placeholders awaiting the full draft. Drives the loading placeholders and the disabled controls. |
| Load failure | A message, non-null only when the **full** build failed after the cheap draft was already on screen. Set together with clearing the loading flag, so the page drops its placeholders, re-enables its controls, and shows an alert strip carrying this message. |

### The cheap draft vs the full draft

| Field | Cheap draft | Full draft |
| --- | --- | --- |
| Branch | The **live current branch**. | The anchor memory's **recorded** branch, falling back to the live current branch when that is blank. |
| Memory count | Count of branch commits that have a memory, from the commit-brief list only. | Count of memories actually read. |
| Insertions / deletions / files changed | One aggregate branch-delta summary call — totals only, no per-file parse. | Per-file numeric + status parse of the same delta. |
| Title | First line of the newest brief's commit message. | First line of the newest memory's commit message. |
| Signed-in | Real (local config, no network). | Real. |
| Branch token/cost totals | Real (already carried by the brief list). | Real. |
| Body markdown | Empty. | Drafted from the newest memory. |
| Memories / files / E2E scenarios | Empty. | Real. |
| Existing PR | None. | The real lookup. |
| Has unpushed changes | Optimistically true. | The real check. |

The cheap build therefore skips the three expensive things: the per-memory storage reads, the existing-PR lookup, and the per-file diff parse. Both builds share the same "no committed memory ⇒ return nothing" contract, so the "commit first" hint has exactly one code path.

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
| render-body | `{ body }` | Sent when the user leaves the inline editor. Asks the host to render this raw markdown to HTML and send it back. |

### Outbound messages (host → page)

Dispatched over a single custom event; the page branches on the message name:

| Message | Effect on the page |
| --- | --- |
| creating | Enter the in-flight state; show a status line (e.g. "Pushing branch…"). |
| progress | Update the status line (used during the share step, e.g. "PR ready — sharing memories to Jolli…"). |
| created | Leave the in-flight state; show a final status line. |
| error | Leave the in-flight state; show the error text in the status line. |
| body-copied | Show a transient toast confirming the clipboard copy. |
| body-rendered | Replace the body display's contents with the supplied HTML, in place. Nothing else on the page re-renders. |

The `created` message additionally clears the host's dirty flag (see the dirty-edit guard) — it is treated as an acknowledgement that whatever the user had edited is now persisted on the forge.

External `http`/`https` link clicks inside the page are intercepted at the host request layer and routed to the system browser (identical policy to the embedded summary viewer).

## Behavior

### Two-stage open

Both stages run on one background job, hopping to the interface thread only to touch the editor manager.

**Stage one — cheap draft, fast tab.** Build the cheap draft, then on the interface thread:

1. If the cheap draft exists, look for an already-open Create-PR tab **whose branch equals it**. If one is found, activate and focus it and stop — the cheap draft is discarded, and stage two will refresh that tab. The lookup is branch-filtered rather than "the first Create-PR tab found" precisely so that with two Create-PR tabs open the user lands on the one they meant.
2. Otherwise, if the cheap draft is nothing (no committed memory), show the "commit first" hint and stop. Note the ordering: because the tab lookup is skipped entirely when there is no cheap draft, the hint appears even if a Create-PR tab is currently open.
3. Otherwise open a new tab from the cheap draft. Any stale tab for a different branch is left open.

Re-triggering focuses the existing tab **through the carrier the tab is already holding**, not through a freshly built equal-by-branch carrier. Both dedupe correctly, but only the former reliably moves keyboard focus onto the existing tab when another tab is currently active — which is why the identity-equality dedupe alone was not enough.

**Stage two — full draft, swap.** Build the full draft, then on the interface thread find the Create-PR tab **whose branch matches the full draft's branch** and hand it the draft. A non-matching or already-closed tab is **skipped and logged**; nothing is created and no other tab is touched. Matching by branch rather than by "the first tab found" is what stops a slow in-flight swap from leaking one branch's memories, body, and files into a tab the user has since opened for a different branch.

Two failure modes are funnelled into the same load-failure draft (below): the full build **raising**, and the full build **returning nothing** (every memory read failed, or the branch changed between the stages). Letting the second fall through untreated would strand the tab in its loading state exactly as an exception would.

### Loading state

While the tab holds the cheap draft:

- The memories and files panels render animated placeholder rows, **as many as the known counts say** (clamped to a small maximum) so the panel's height does not jump when the real rows arrive. The body panel renders a fixed set of placeholder bars.
- The primary control reads a loading label and is **disabled**.
- Edit and Copy-body are **disabled too**. This is not cosmetic: the page reports any real input as an unsaved edit, and the host's dirty guard makes a pending swap **bail** when the view is dirty. An edit begun during the load window would therefore latch the tab on the cheap draft for its whole lifetime — placeholders forever, an existing PR reported as absent, and every cross-panel refresh silently dropped. Disabling the two controls that can open an editor closes that window.

The tab is otherwise fully interactive throughout: rows are inert placeholders, but the view is live and the swap is non-blocking.

### Load-failure state

A full-build failure swaps in a draft that keeps the cheap fields, clears the loading flag, and carries a failure message. The page then:

- shows an alert strip under the heading: it states the view could not finish loading, names the reason, and tells the user to re-trigger Create PR to retry;
- stops the placeholders in all three panels — animated placeholders would read as "still loading" when nothing more is coming;
- re-enables all three controls, so the user can inspect and copy whatever partial fields survived before retrying.

There is no automatic retry. Re-triggering from the action bar re-runs the whole two-stage pipeline.

### Editor-tab identity

The view is hosted by a virtual file whose equality and hash are **the branch name alone**. Re-triggering "Create PR" on the same branch therefore reopens the same tab rather than stacking a new one; a different branch opens a distinct tab. The tab is read-only, titled for the branch, and uses a hide-default-editor policy so no fallback text editor competes with it.

The carrier holds the draft it was constructed with and **is never updated**. Every swap goes to the live view inside the tab, not to the carrier. So an editor re-created from the same carrier — a split, or a reopen from the editor's own persisted state — reconstructs from the *cheap* draft, with no stage two behind it to complete it.

### The borrowed embedded browser

The view **borrows** an instance from the project-scoped embedded-browser pool (spec 302), tagged with its branch so it is identifiable in pool diagnostics, and attaches its message channel and its link-interception observer through the lease. On close it hands the lease back rather than destroying the instance — hopping to the interface thread first, because editor teardown can arrive off it during project close and the pool refuses an off-thread hand-back. A refused lease (or any construction failure) falls through to the plain-text fallback below.

Because the borrowed instance may still be showing the previous tenant's page, the open transition is **previous-content-to-new-content** rather than blank-to-content.

### Theming and the first load

**Before the first content load**, the IDE's live editor background colour is read and applied to both the hosting component and the embedded browser's initial blank page. The browser keeps whatever it is currently showing painted until the real page commits its first frame, so colouring the blank page is what stops a *pristine* borrowed instance from flashing white on the way to first content. When the borrowed instance was already carrying a previous tenant's page there is no blank page to cover at all — that transition is content-to-content, and so is every subsequent re-render within the tab.

**Theming divergence worth recording.** The pre-load colour above comes from the **editor colour scheme**, while the light/dark palette baked into the page comes from the **widget theme's brightness flag** — two independent settings that can disagree. The memory-summary view (spec 120) derives both from one colour precisely so they cannot; this view was given the pre-load background treatment without that second half. This view's page background is also not the editor colour at all: its stylesheet is declared independently of the memory-summary view's and carries a hard-coded background per theme, so the pre-load shell colour and the page's own background differ whenever the editor scheme's background is not that hard-coded value.

### Rendering

The whole page document is assembled **off the interface thread** — it is tens to low hundreds of milliseconds of string work, and building it inline used to freeze the UI for the duration of the first paint. Each build stamps a monotonic supersession counter on entry and is **dropped** on the hop back if a newer build has been queued meanwhile, so a burst of rebuilds can never let a slower stale document overwrite a fresher one. A build that raises is logged and abandoned, leaving the current page in place.

The page renders, top to bottom: the heading; an optional load-failure alert strip; the branch token/cost banner (see above); a meta strip (branch → main, an optional PR-number link, the "drafted from N memories" count, and the aggregate diff stats); a sign-in-aware sub-line describing the one-click share; an editable Title panel; an editable Body panel (the body's markdown already rendered to HTML, with a hidden textarea editor beside it); a "Memories included" list (each row opens its memory, and shows a muted "shared" marker when it already has a shared-article URL); an optional E2E test-guide panel (only when the newest memory has scenarios); a "Files changed" list (each row opens its file); and an action row with the primary button, an Edit toggle, a Copy-body button, and — in update mode when there are no unpushed commits — an informational hint.

Update vs create mode is driven solely by whether an open PR already exists: the heading and primary-button label switch between create and update wording, and the meta strip shows the PR-number link.

### The body panel and its render round trip

The PR body's markdown is turned into HTML **in the host** and baked into the page document at build time. The page carries no markdown parser of its own. That is what makes the folding markup the body carries (the details / summary / blockquote / line-break structure the PR-description builder emits for topics) fold natively in the panel instead of appearing as escaped tag text, which is how it used to render when the page parsed the markdown itself.

Leaving the inline editor therefore needs a round trip, and this view is the only surface that has one:

1. The page sends the raw textarea contents to the host.
2. The host renders them on a background thread with the same renderer that produced the initial paint.
3. The rendered HTML comes back and is swapped into the body display **in place**. There is no page reload, so scroll position and every other panel survive untouched, and the textarea keeps its value so clicking Edit again resumes the same editing session.
4. A render failure is logged and **nothing is sent back** — the previous, now-stale rendering stays on screen with no error surface. The raw text is still what a submit or a Copy-body sends, so the stale display is cosmetic.

Because the same renderer serves the first paint and the post-edit refresh, the two renderings of one body cannot disagree.

### Edit toggle

The Edit button flips the Title and Body panels between their read-only display and inline editors, relabelling itself. Toggling back copies the title input into the title display directly and re-renders the body through the round trip above. Create/Update and Copy-body always submit the live editor values, so the edited and un-edited paths share one code path.

### Dirty-edit guard

Any real content change in an input, textarea, or content-editable region makes the page emit the edit-state message with the editing flag set. The host records the view as dirty. Both refresh paths **return early while dirty** — a cross-panel memory-state notification (see below) and a stage-two swap — so in-progress typing is never silently dropped; the state re-syncs on the next full reload. For the notification path the guard is re-checked both before and after the background rebuild.

Three things clear the flag:

- A full reload, which replaces the whole document and therefore discards any prior edits regardless.
- A **completed-submit acknowledgement**, treated as "whatever was edited is now on the forge". This is what closes a previously permanent latch: when the post-submit rebuild returned nothing, the only message the page received was that acknowledgement, no reload happened, and the flag stayed set for the tab's lifetime — short-circuiting every later cross-panel refresh.
- Nothing else. In particular, leaving the inline editor does not clear it.

### Submit flow (create-PR message)

On a background thread, within one trace scope:

1. Post the creating message ("Pushing branch…").
2. Push the branch to its remote.
3. Look up the PR for the branch — **directly, bypassing the PR-status cache**, so a stale label can never make this step take the wrong action.
   - **Open PR exists (update):** merge the freshly built body into the existing PR body's marker region, **preserving any user-authored text outside the markers**, then update the PR with the new title and merged body. The PR URL is the existing one.
   - **No open PR (create):** wrap the body in the idempotent markers and create a new PR with the title and wrapped body.
4. If signed in, share the included memories (see below); capture a human-readable partial-success suffix.
5. **Invalidate the PR-status cache for the branch captured at submit entry** — before the rebuild in the next step reads it. Two orderings are load-bearing here and both were chosen deliberately:
   - *Before, not after, the rebuild.* The rebuild goes through the cache, which almost certainly holds a "no PR" verdict from the tab's own load. Invalidating afterwards leaves the rebuild reading that stale verdict, so the view re-renders with create wording and no PR link immediately after publishing a PR. The cross-panel notification in step 7 usually self-corrects it — but only while the user has not started typing, since the dirty guard drops that refresh outright.
   - *The branch captured at submit entry, not the branch the rebuild reports.* Submit is a one-to-three second network operation and the user can check out another branch inside it. The rebuild would then report the new branch, and invalidating that key would leave the branch just published on holding its stale "no PR" verdict for the whole freshness window — so this view, the commits list, and any open memory tab would all keep claiming no PR exists for it.
6. Rebuild the view model from fresh data (new PR lookup + summaries). On success, replace the model and re-render — this flips the view into update mode, so a subsequent submit updates the PR rather than erroring on a duplicate create. If the rebuild fails or returns nothing, post the created message with the share suffix instead (which also clears the dirty flag).
7. Show an informational dialog with the PR URL and the share suffix.
8. Notify the memory-state channel so the other surfaces re-read (a PR now exists and memories may have been shared).

On any exception during the flow: post the error message with the failure text and show an error dialog. (The branch push and PR calls are not retried here.)

### Sharing the included memories

Only when a Jolli site key is configured and a base URL can be resolved (from the key, falling back to the saved site URL). For each included memory, newest-first, the view invokes the reusable share core (which pushes the memory's plans and the memory itself, persists the updated memory, and cleans up orphaned docs). It counts successes and failures and can stop the whole batch early:

- **Binding required** on a memory: resolve the binding **at most once per submit**. The first time, list the available spaces and open the binding-chooser dialog (modal, resolved synchronously on the UI thread; skipped if a chooser for this repo is already open). If the user selects a space, retry that memory once and continue the batch with the binding treated as resolved for all remaining memories. If the user refuses or the binding cannot be resolved, stop the batch with reason "space not bound".
- **Any repo-wide refusal:** stop the batch with that refusal's own reason — see the classifier below.
- **Any other per-memory failure:** count it as failed and continue to the next memory.

#### The repo-wide stop classifier (`repoWideStopReason`)

Every included memory belongs to the **same** repo, so a sign-in / permission / opt-out / gate verdict applies to all of them: continuing would fire N doomed requests and report one repo-wide condition as N per-memory failures. `CreatePrPanel.repoWideStopReason` (`intellij/src/main/kotlin/ai/jolli/jollimemory/toolwindow/CreatePrPanel.kt:481-493`) maps each such throwable to a user-facing stop reason, or `null` for "count it and move on":

| Throwable | Stop reason |
|---|---|
| `UnauthorizedError` | `sign-in rejected` |
| `PermissionDeniedError` | `not allowed — ask an administrator` (credential valid, server refused — e.g. the repo isn't allowlisted; an admin problem, not a sign-in one) |
| `PluginOutdatedError` | `plugin outdated` |
| `PushDisabledError` | `outbound push disabled` (the user opted this repo out — spec 310; **not** a failure) |
| `PushGateUnavailableError` | `couldn't verify the push setting` (the gate could not be evaluated, fail-closed; nothing was sent) |

`BindingRequiredError` is deliberately **absent**: it is recoverable here (the chooser runs, then the memory is retried), so it is handled by its own arm above rather than classified as a stop.

It is a **function, not a chain of `catch` arms**, because the share loop has two failure sites — the first attempt (`:536`) and the post-binding retry (`:526`) — and each new repo-wide type would otherwise have to be added to both. It only ever got added to one, which is exactly how a repo-wide refusal raised by the retry ended up counted as a single per-memory failure. See spec 327 for the canonical set and how this classifier differs from the plugin's *other* one.

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

Because that rebuild always produces a full draft, a notification is also the one thing besides a re-trigger that can rescue a tab whose stage-two swap missed it.

### Open-memory and open-diff

- Open-memory resolves the memory from the already-loaded included set and **reuses the single open memory tab** if there is one, swapping its content and activating it; otherwise it opens a new memory tab. An unknown hash is ignored. (In the loading state the included set is empty, so every row is a placeholder and no click resolves — but the placeholder rows are inert anyway.)
- Open-diff opens the repo-relative file in the editor after the traversal/absolute-path rejection. Despite its message name, it opens the file, not a side-by-side diff.

### Copy body

Copy-body takes the live (possibly edited) body, wraps it in the idempotent markers (the same wrapping create-mode submits), copies it to the clipboard, and confirms with a toast. In update mode the copy is the wrapped body — it does not perform the marker-region merge that a real update submit does.

### Fallback rendering

If a pooled embedded browser cannot be obtained — a refused lease (wrong thread, disposed pool) or an environment without the embedded-browser capability, all of which surface identically — the view degrades to a read-only text component showing the PR body markdown as plain text. None of the interactive messages are available in that fallback, no lease is retained, and the later teardown hands nothing back. In the loading state the body is empty, so the fallback shows an empty pane.

## State Transitions

```
[action bar: Create PR clicked]
  background: build CHEAP draft
    no committed memories             → show "commit first" hint; stop (even if a tab is open)
    tab already open for that branch  → activate + focus it; discard the cheap draft
    else                              → open the branch-keyed tab from the cheap draft
  background: build FULL draft
    build raised, or returned nothing → load-failure draft (cheap fields + message)
    swap into the tab whose branch MATCHES
      no match / tab closed           → skip + log  (tab stays in loading state)
      dirty                           → skip        (tab stays in loading state)

[view opened]
  borrow a pooled embedded browser (tagged with the branch); refused → plain-text fallback
  build the page off the interface thread (supersession-guarded); render
  subscribe to the memory-state channel

[loading state]  (cheap draft)
  placeholders sized from the known counts; primary shows "Loading…" and is disabled
  Edit + Copy-body disabled too (an edit here would latch the dirty guard against the swap)

[load-failure state]
  alert strip names the reason and says to re-trigger; placeholders stop
  all three controls re-enabled; counts still show branch totals; lists empty; body blank

[user edits title/body]
  page emits edit-state(editing=true) → host marks view dirty

[user leaves the inline editor]
  page sends the raw body → host renders on a background thread
    → HTML swapped into the body display in place (no reload)
    → render failed → nothing returned; stale display stays

[memory-state notification arrives]
  if dirty → ignore (keep unsaved edits)
  else → rebuild model in background; re-render (also rescues a missed swap)

[user clicks primary (create-PR)]
  snapshot the branch
  post creating
  push branch
  find PR (bypassing the PR-status cache):
    found → merge body into marker region → update PR
    none  → wrap body in markers → create PR
  if signed in → share included memories (binding resolved ≤ once; stop on auth/outdated/binding-refusal)
  invalidate the PR-status cache for the SNAPSHOTTED branch  ← before the rebuild
  rebuild model:
    success → re-render (now update mode); clear dirty
    failure/nothing → post created(with share suffix) → clears dirty
  show info dialog (PR url + share suffix)
  notify memory-state channel
  on exception → post error; show error dialog

[user clicks a memory row] → reuse the open memory tab, or open one
[user clicks a file row]   → open that repo file (reject absolute / traversal)
[user clicks PR link]      → open PR url in system browser
[user clicks sign-in]      → run sign-in; on success re-render signed-in

[view disposed]
  unsubscribe from the memory-state channel
  hand the browser lease back to the pool (hopping to the interface thread if needed)
```

## Notable Behavior

- **This view is branch-level; the per-memory Create-PR form still exists.** The bottom action bar now opens this aggregate view. The older row-level action opens the newest memory's summary viewer, whose own embedded per-commit Create-PR form is unchanged. Both surfaces coexist. (Notable.)
- **The draft is anchored on the newest memory but backed by the whole branch.** Title, body, and E2E scenarios come from the newest memory; the diff stats span the branch delta; the "memories included" list and the share payload span every committed memory. (Notable.)
- **The branch token/cost banner is branch-wide, unlike the rest of the draft.** It sums usage across every committed memory on the branch (not just the newest), mirroring the branch-level scope of the diff stats and memories list rather than the newest-memory anchor used for title/body/E2E. It has one fewer state than the per-commit viewer's equivalent banner (no "tokens-only" middle state) because the branch total is built purely by summing already-computed per-commit breakdowns. (Notable.)
- **This view has no force-push / non-fast-forward handling.** Unlike the embedded per-commit Create-PR form (spec 120, spec 264), the submit flow here pushes the branch and discards the result without inspecting it for a non-fast-forward rejection — there is no divergence check or confirmation gate on this surface. (Notable divergence, not a defect being tracked here.)
- **The delta base uses the own-commits-base resolver, not a plain merge-base with main.** This keeps the stats/files aligned with the commits-panel listing and prevents a branch cut from a feature/release branch from counting the parent branch's commits. (Notable.)
- **The loading draft is the only draft state that disables the primary control.** The view model documents that the primary button should dim when there are no unpushed commits; the rendered page deliberately overrides this — the PR body is drafted from editable memory content that can change without a new git commit, so an update is always a valid action. When there are no unpushed commits it only shows an informational hint. Update mode, create mode, and the load-failure state all leave the control enabled; only the loading draft disables it, and a submit in flight disables it for the duration. (Bug-shaped divergence on the up-to-date intent; the rendered reality wins.)
- **The primary control carries an up-to-date marker attribute that nothing reads.** The page stamps the computed "no new commits to push" verdict onto the control as an attribute; no script, style rule, or handler on the page ever consults it. Inert — presumably a leftover from the dimming behaviour that was deliberately dropped. (Record as inert; do not build on it.)
- **Entering the inline editor clears the primary control's disabled flag.** The page does this so a dimmed control would re-enable once the user starts editing — but nothing dims it any more, so the only reachable effect is during a submit in flight: clicking Edit then makes the control *look* enabled while a further click still does nothing, because the in-flight guard rejects it. In the loading state the Edit control is itself disabled, so the path cannot be reached there. (Vestigial; harmless.)
- **Binding is resolved at most once per submit.** Even when several memories each hit a binding-required verdict, the chooser opens only for the first; once the user picks a space, the rest of the batch proceeds without re-prompting. A refusal stops the whole batch. (Notable.)
- **The batch stop reasons are diagnosable, per-memory failures are merely counted.** Auth rejection, permission-denied, plugin-outdated, the outbound-push opt-out, an unevaluable push gate, and binding refusal halt the batch with a named reason; any other memory's failure is counted and skipped, and the suffix always points at the log for detail. (Notable.)
- **This is the plugin's SECOND repo-wide classifier, and it does not match the first.** `JolliPushOrchestrator.isFatalPushError` (spec 263) is a boolean over the attachment loops; `repoWideStopReason` is a reason-string map over the Create-PR share loop. They differ in **two** entries, not one: `BindingRequiredError` is fatal in the orchestrator (which cannot run a chooser) but recoverable here, and `UnauthorizedError` is a stop here but is **absent** from the orchestrator's set. The second asymmetry is not documented as deliberate anywhere — `repoWideStopReason`'s own comment asserts that "every other repo-wide type belongs in both", which makes the `UnauthorizedError` gap read as an instance of exactly the drift that comment warns about. (Surprising; a real divergence — see spec 327.)
- **One stop reason is not an error at all.** `outbound push disabled` names the user's own per-repo opt-out (spec 310); the batch stops because nothing more can be sent, not because anything went wrong. (Notable.)
- **The submit is honest about partial success.** The success toast never implies every memory shared when some failed or the batch stopped early. (Notable.)
- **The tab is keyed by branch.** Re-triggering on the same branch reuses the tab; this is why the virtual file's identity is the branch name and nothing else. (Notable.)
- **open-diff opens a file, not a diff.** The inbound message is named for a diff but the handler opens the working-tree file in the editor. The path is validated to be repo-relative (no leading separator, no parent-traversal segment) before opening. (Naming quirk; reality is a file open.)
- **The dirty-edit guard trades staleness for safety.** A cross-panel refresh that arrives while the user is typing is dropped rather than reloading and losing the edits; the view re-syncs on the next reload. Losing in-progress typing is treated as the worse failure. (Surprising; intentional.)
- **The VS Code branch-classification blocking rules are not consumed here.** That surface can block PR creation on branch classification; this view has no such guard and always builds from the branch's committed-memory set. (Divergence; intentional.)
- **The white flash is now mostly gone because the browser is borrowed, not because of the coloured blank page.** The embedded browser keeps whatever it is showing painted until the new document commits a frame. A borrowed instance is usually already carrying the previous tenant's page, so opening this view is a **previous-content-to-new-content** transition with nothing to cover. The theme-coloured blank page and hosting component still matter, but only for the narrower case of a freshly constructed, pristine instance. (Changed rationale; the mechanism is the pool.)
- **Three theming inputs, only two of which agree by construction.** The pre-load shell colour is the live editor background; the light/dark palette is the widget theme's brightness flag; the page's own background is a hard-coded per-theme value in this view's independently-declared stylesheet. So the shell and the page can be different shades, and the palette can be chosen for the opposite brightness from the shell. The memory-summary view (spec 120) collapses all three onto one colour; this view does not. (Divergence; not yet closed here.)
- **This view is pooled.** It borrows an instance from the project-scoped embedded-browser pool, tagged with its branch, and hands the lease back on close instead of destroying the instance — sharing one warm renderer with the memory-detail tab and counting against the pool's capacity like any other consumer (spec 302). An earlier version of this view built and destroyed its own instance outside the pool; that is no longer true. (Changed.)
- **The hand-back hops to the interface thread.** Editor teardown can arrive off that thread during project close, and the pool refuses an off-thread hand-back in a way that strands the instance permanently, so the view checks and hops rather than assuming. (Notable; the same precaution the memory tab takes.)
- **Update preserves user text outside the markers.** An update merges the freshly built body only into the marker region, so hand-authored prose the user added outside the markers survives; a create wraps the whole body in fresh markers. (Notable.)
- **Opening is two-staged, and the second stage can miss.** The tab appears from a cheap draft in well under a second and is then completed by a full draft — but the completion is delivered by finding the tab whose branch matches, so it can find nothing. See the two stuck-loading paths below. (Notable; the cost of the fast open.)
- **Stuck loading, path one: the two stages derive the branch differently.** Stage one takes the **live current branch**; stage two takes the **anchor memory's recorded branch**, falling back to git only when that is blank. When the two disagree — a renamed branch, or a memory recorded under a different branch name — the swap's branch-matched lookup finds no tab, logs the skip, and the tab stays in its disabled loading state with animated placeholders and a "Loading…" primary control. Nothing retries. Only re-triggering Create PR or a cross-panel memory-state notification gets it out. (Surprising; reachable.)
- **Stuck loading, path two: the carrier is never re-drafted.** Every swap goes to the live view, never to the virtual file that identifies the tab, so the carrier keeps the cheap draft forever. An editor re-created from that carrier — a split, or a reopen — reconstructs from the cheap draft with no stage two behind it, and therefore opens directly into a loading state that will never complete on its own. (Surprising; reachable.)
- **The load-failure state shows honest counts over empty lists.** The failure draft keeps the cheap fields, so the memories count and files-changed count still show real branch totals while both lists render empty and the body is blank. The primary control also reads the **create** wording even when the branch already has a PR, because the failed draft carries no existing-PR verdict. None of this makes the action wrong: submit re-resolves the PR for real and bypasses the cache, so an update is still an update. The label lies; the behaviour does not. (Surprising; deliberate trade against a permanent "Loading…".)
- **Disabling Edit and Copy-body during the load is a correctness fix, not polish.** Any keystroke in a revealed editor marks the view dirty, and the dirty guard makes the pending swap bail — which would latch the tab on the cheap draft for its entire lifetime. Both controls are therefore disabled until the swap lands or fails. (Surprising; intentional.)
- **The page no longer parses markdown; the host does, at build time.** The body's HTML is baked into the document, which is what makes the folding markup fold natively instead of appearing as escaped tag text — the bug this replaced. The same renderer is then re-invoked through a round trip when the user leaves the editor, so the first paint and the post-edit rendering cannot disagree. (Notable; see spec 239.)
- **A failed post-edit render leaves the stale body on screen with no error surface.** The host logs it and sends nothing back, so the panel keeps showing the pre-edit rendering. Only cosmetic — the raw text is what a submit or a Copy-body sends. (Surprising; silent.)
- **The post-edit render replaces the body in place, so nothing else moves.** No page reload means scroll position, the other panels, and the textarea's contents all survive; clicking Edit again resumes the same editing session. (Notable; the reason the round trip exists rather than a rebuild.)
- **A completed-submit acknowledgement clears the dirty flag, closing a permanent latch.** When the post-submit rebuild returned nothing, the page received only that acknowledgement — no reload, so previously nothing cleared the flag and every later cross-panel refresh was short-circuited for the tab's lifetime. (Fixed; the acknowledgement is now treated as "persisted".)
- **Page builds are supersession-guarded.** Each build is stamped on entry and dropped on the way back if a newer one has been queued, so a burst — a swap landing right behind an edit-state, say — can never let a slower stale document overwrite a fresher one. (Notable.)
- **Re-triggering focuses the existing tab through the tab's own carrier.** Opening a freshly built, equal-by-branch carrier does dedupe, but empirically does not reliably move keyboard focus onto the already-open tab when another tab is active. Focusing through the existing reference is the fix; the cheap draft built for that click is discarded. (Notable.)
- **A memory-row click reuses the single open memory tab.** Rather than opening a tab per memory, the click swaps the open memory tab's content and activates it — the plugin's one-live-memory-tab rule (spec 121). (Notable.)

## Shared Behavior

- **Message tunnel** — the base64-encoded-JSON bidirectional bridge and the external-link interception are the same mechanism the embedded summary viewer uses.
- **Own-commits-base / branch-creation-point resolver** — the delta base and the commits-panel listing share this resolver (commits-panel spec).
- **Reusable share core** — each included memory's push (plans + summary + orphan cleanup + telemetry) is delegated to the share-to-Jolli core (share-to-Jolli spec).
- **Binding-chooser dialog** — the inline binding-required resolution reuses the binding-chooser dialog and its outcome contract (binding-chooser-dialog spec).
- **Memory-state publish/subscribe** — the cross-panel synchronization channel shared with the commits list and the summary viewer.
- **PR service** — branch push, PR lookup, create, update, and the marker-region merge/wrap helpers.
- **309. IntelliJ PR-Status Cache** — memoizes the existing-PR verdict and the tool-presence / sign-in probes this view's draft build reads, and owns the retention and freshness rules. This view is one of its three consumers and one of its three invalidators; its submit path deliberately bypasses it.
- **302. IntelliJ Embedded-Browser Pool** — the instance this view borrows, the lease it attaches its message channel and link observer through, and the refusal that lands in the plain-text fallback.
- **239. Create-PR Body Markdown Assembly** — the renderer the host invokes for the initial body and again for the post-edit round trip; the same contract is implemented independently in the editor extension.
- **121. IntelliJ Summary Virtual-File Editor** — the one-live-memory-tab reuse rule an open-memory click goes through, and the destination it lands on.
- **Summary-push, binding-required-flow, plugin-outdated-flow, tenant-resolution specs** — the wire-level contracts the share core rides on.
- **327. Repo-Wide Push-Refusal Classification** — the canonical set `repoWideStopReason` covers, and the plugin's other Kotlin classifier (`JolliPushOrchestrator.isFatalPushError`, spec 263) it diverges from.
- **310. Per-Repo Outbound-Push Control** — the opt-out behind the `outbound push disabled` / `couldn't verify the push setting` stop reasons.

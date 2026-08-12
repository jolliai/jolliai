# 356. Local Dashboard Browser Application

## Topic Statement

The no-build browser application the local dashboard serves: a page-per-view application whose stylesheet and every script are **inlined into each served document**, which boots from a model already embedded in that document, keeps its own client-side view state, opens Settings as a modal that is not a route, refreshes only one of its views on a timer, and reads its mutation credential from the page rather than from a URL.

## Scope

**In scope:**

- What the served document contains and what it does **not** request — the zero-external-request property and why the scripts are inlined rather than fetched.
- The two page globals (the model and the mutation token) and the boot sequence over them.
- The render dispatch: shell first, then exactly one view renderer.
- The shell: the navigation list and its gating, the range control and its calendar popover, the scope chip, the coverage footer, and the tier attribute.
- Link construction — which parameters survive a click and which are deliberately dropped.
- The four page views' behavior, and which of their controls re-render locally versus re-fetch.
- The **Settings modal**: how it opens, what it fetches, its controlled form and dirty gate, its per-section lazy loads, and its immediate-apply toggles.
- The periodic refresh loop: which view it runs on, what it does on a schema mismatch, and what it does on failure.
- How the mutation token is obtained and which requests carry it.
- The content-free telemetry beacon and the events it emits.

**Boundaries (consumed here, owned elsewhere):**

- Every route this application calls, the security checks each is subject to, and how the document is assembled — spec 352. This spec covers only what the browser does with what it is given.
- The payloads it renders and every figure in them — spec 353. Field meanings are not restated here.
- The write protocol behind those payloads (spec 354) and the registry the Repositories view lists (spec 355).
- The mutation semantics behind the Settings actions: masked-key reuse on save, the cross-repository hook sweep, folder validation rules, sign-in's browser flow, the memory-bank migration, the manual sync, and the backfill engine.
- Visual design: colors, spacing, iconography, and the individual element structure of any card.

## Data Contracts

### What the served document is

One self-contained document per page render: the stylesheet, the two page globals, and every application script arrive already inlined in it, in a load order the service fixes (how the document is assembled is spec 352's).

**Nothing is served as a file.** There is no static asset route at all — a request for a script or stylesheet path answers "not found" — so the application has no cacheable, independently-versioned unit: a page render always ships the current build's scripts alongside the current data.

**The page issues zero external network requests.** Every icon is inline SVG written into the markup; there are no font, image, frame or stylesheet references; the only URL-shaped value in the stylesheet is a single inline `data:` SVG (whose XML namespace declaration is an identifier, not a fetch). Every request the application issues is a same-origin relative path, and nothing uses a long-lived transport. This is what makes the service's refusal to emit any cross-origin header cost the page nothing.

The one thing that reaches outside is not a request the page makes: an archived reference row renders the upstream URL as an ordinary link the **reader** may click, restricted to the two safe schemes and opened in a new context with no referrer.

### The two page globals

| Global | Set when | Read by |
| --- | --- | --- |
| The **model** | Always, on a page render | The boot script (renders it), the link builders, and the refresh loop (replaces it) |
| The **mutation token** | Only when the service has one | The write helpers and the model refetch |

Both are written into the document as inline script assignments; the token is deliberately never placed in a URL, so it stays out of referrers, history and logs.

A **third** global is the application's own, created by each script rather than inlined by the service: the shared namespace every module hangs its helpers and its cross-module view state on (the selected axis, each card's split tab, the feed's expanded flag, the memories tree's tab / collapsed set / search text). Nothing in it survives a page load, which is what makes every view state below "client state that survives a refresh tick but not a navigation".

### The parameter set a link carries

Links are built in one place so navigation, the range control and the refresh loop cannot disagree about what survives a click:

- **repo** — the current scope, emitted as the **shortest unambiguous token**: the display name when exactly one repository carries it, the full identity otherwise. (The service accepts both.)
- **range** — emitted **whenever known**, never omitted because it "equals the default". Both directions of that omission were wrong about what the default is, so a bookmarked non-default range silently became the default on the first rebuild of the URL.
- **from / to** — carried **only** with a custom range, so switching to a preset drops them in the same click.
- **dimension** — the axis last selected in this tab, falling back to **the axis the payload says was used**, not to nothing: before the first selection a deep-linked axis was absent from every rebuilt URL, so the poll silently re-asked for the default and the chart changed under the reader. It is also the one parameter a sidebar click does **not** drop, so the chart axis follows the reader across pages.

Page-specific parameters (a memory's hash, its owning repository, a page cursor) are appended to that base with the correct separator chosen for them.

## Behaviors (execution order)

### Boot

1. Read the model global. **If it is absent, nothing happens at all** — no render, no error state.
2. Render: the shell, then the one view renderer for the model's view.
3. Start the refresh loop (which no-ops on every view but one).
4. Emit an "opened" telemetry event **once per browser session** — navigation is a full page load, so a naive call would fire on every page — carrying a first-run flag derived from a persistent per-profile marker. The whole step is wrapped so blocked storage (private browsing) cannot break boot.

### Render dispatch

The shell renders first, then a per-view renderer. The application container is given the card-grid layout only for the activity view; the standup board supplies its own three-column layout and must not sit inside another grid. Settings has **no** entry in this table — it is a modal.

**An unrecognised view falls back to the activity renderer.** Unreachable at HEAD, on two counts: only the four routed page views can be inlined into a page render, and the refresh loop re-asks for the view the page already has, so the reply can only echo it back. The fallback would also not be a graceful one — the activity renderer dereferences its own payload unconditionally, so a fifth view would throw rather than degrade. (Unreachable; one added route is all that stands between it and being reached.)

### The shell

Rendered on every render, including every refresh tick.

- **Page title and subtitle** per view; the document title is set to match.
- **A tier attribute** on the root element, which the stylesheet keys chip and locked-preview treatments off, so the shell reflects the adoption tier with no branching in the view modules.
- **The navigation list**: a Dashboard group rendered flat under a non-interactive group label with two children (the activity dashboard and the daily standup), then Memories, then Repositories. **Settings is pinned to the sidebar's bottom edge in its own slot**, a sibling of the scrolling list rather than its last row — a persistent destination.
- **Gating**: the Dashboard group's two children and Memories are marked disabled when no repository is enabled, mirroring the service's own redirect. Repositories is never gated — it is the row that opens the gate, so it must stay reachable with zero repositories. The disable exists only so a click does not visibly bounce through a redirect; the redirect is the enforcement.
- **Every navigation is a full page load, not a client-side swap**, so every view is deep-linkable and reload-safe. The rows are **buttons that assign a location**, not anchors — so the destinations are real URLs but the sidebar itself supports no middle-click, no open-in-new-tab, and no hover target. (In the memories tree the same is true of a row click; the one genuine anchor in the application is the upstream reference link.)
- **A sidebar click drops both the range and the repository scope.** The sidebar changes *page*, and every page's default is all repositories; a single-repository scope is only ever established by an explicit act on one repository (a per-row button, or a memory deep link), and carrying it through the sidebar made it permanent, since nothing on any page offers a way back.
- **The Settings row is intercepted before navigation**: it opens the modal in place. The client therefore never issues a request for a settings page path (which the service does not route).
- **The range control is shown only on the view whose payload carries a window** — the standup board is a fixed two-day board, so it has none and the control is hidden there.
- **The coverage footer** is filled as text (never as markup, so a message containing punctuation renders as written) and hides itself when empty, since an empty element still occupied space on the views that carry no note.
- **The synced chip** is shown only at the third adoption tier. **Unreachable at HEAD** — tier detection never reaches it — so the chip is permanently hidden.

### The range control and its calendar

Three presets, labelled by their day counts, plus a Custom popover. The presets are a strict subset of the windows the payload can carry (spec 353), so a window reachable only by URL has no button to sit under — and one of the three has no entry in the shell's short-label table either, so the scope chip prints its raw date bounds where the card headings print a phrase. Clicking a preset navigates; clicking the already-active preset still navigates but emits **no** telemetry, because only a real change is a change.

The popover is a two-month calendar:

- **"Today" is derived from the model's generated instant using the browser's own calendar fields — the same fields the day cells are labelled with.** Deriving it in the payload's zone while the cells stayed browser-local put the "disable future days" boundary off by one whenever the viewer's zone differed from the server's, so either today was disabled or tomorrow was selectable and then silently clamped.
- Selection is start-then-end; clicking before the current start restarts the selection. The footer states how many days are selected.
- Apply navigates with the custom range and its bounds; Cancel and Escape close it. The Escape handler is tracked across renders and removed before re-binding — the shell re-renders on every refresh tick, so an untracked listener would accumulate for the life of the tab.
- **An in-progress selection survives the refresh tick.** The pending selection lives outside the render closure precisely so a background refresh cannot discard unsaved user input, and an open popover is **re-rendered** on that tick rather than left alone: everything else rebinds to the new closure while the day buttons already in the document still call the previous one, so a click after a tick updated one closure's state while Apply read another's — navigating to the pre-tick window, or silently doing nothing.

### The activity dashboard

Cards in a fixed order: skills, MCP servers, tokens, spend, decisions, recall, then the feed.

**The feed is one of two things.** At the memory tier with at least one memory card it is the Memory Activity list — memories grouped by branch or by time bucket, each row opening that memory in a new tab, with a captured/gaps/decisions summary above it. Otherwise it is the raw session list, collapsed to the shared page size with a "show all / show fewer" toggle, and at the lowest tier an upsell panel is appended **last** in the card, because it is the call to action rather than a list footer.

Controls split cleanly by whether the answer is already in the payload:

| Control | Behavior |
| --- | --- |
| The tokens card's split tabs | "By type" is local; "by model" and "by repo" **re-fetch** — but only when the axis is not already the one they want, because they share the series query and move the axis to match. This is the **only** control that changes the series axis at HEAD. |
| The MCP card's split tabs | Always local — both views are the same rows in one payload, grouped differently. |
| Memory Activity's branch/time tabs, the feed's expand | Local re-render over the same model. |

**Two handlers in this page are wired to controls that no longer exist** and can therefore never run: one that would re-fetch on a dedicated group-by chip, and one that would toggle a card into a table. Nothing in the markup carries the hooks either binds against, and the chip's own label table and axis captions are likewise unreferenced. One user-visible trace survives: an empty-state line still tells the reader to switch a group-by control that is not on the page, and names the card by a title it no longer carries. (Unreachable; the axis is still switchable, but only through the tokens card's tabs above.)

Grouping keys that come from user-controlled strings (branch names, ticket ids, models, repository names) are accumulated into prototype-less maps. A branch named after an inherited object member otherwise made the lookup hand back a function — dropping that series from the chart silently, or throwing and blanking the whole page.

### The daily standup

Three columns — Yesterday, Today, Risks — plus a context strip and a draft sheet.

- Below the memory tier, Yesterday is the raw trail (commits grouped by repository-and-branch together, sessions in a per-repository group of their own because nothing records which branch a session was on and filing it under one would be a guess printed as a header). At the memory tier it becomes outcomes: one line per commit with its cost, turns, diff and the decision its memory recorded, and the session trail drops out.
- Today carries commits, live sessions (all sessions below the memory tier), TODO insights, and the uncommitted-work rows.
- **The Risks column renders the blocker / question / gotcha insights, which the payload can never contain** (spec 353) — so at the memory tier it always shows its "nothing flagged" note, and below it shows a locked upsell. The per-risk addressee marker is unreachable for the same reason.
- The context strip states **whose** commits are shown, in both directions and never silently: an identity chip when filtered, and an explicit "every author — no git identity configured" chip when not. It also shows up to three ticket chips derived from the two days' commits, and a chip stating outright what is missing (step progress) rather than inventing a status.
- **The draft sheet is the page's actual product.** Its markdown is built to match the columns exactly (the same TODO/risk routing), rendered into an **editable** textarea, copied to the clipboard on open *and* on the button, and its subtitle leads with the unfiltered warning when there is one — what you are about to paste containing a teammate's commit matters more than where the lines came from. Escape closes it, bound as an assignment rather than an accumulating listener so the refresh tick replaces the handler instead of stacking another.

### Repositories

Lists the registered repositories with their memory badge and one action each: Go to dashboard (once a repository has memories — it already reads real activity, so the row collapses to the one action that matters), Pause (a setup-phase action), or Resume. A busy row shows a working state; a failure renders a callout. The empty state instructs the reader to run the enable command inside the target repository.

**Nothing here starts or polls a job.** Pause and resume are single requests that finish within the request, so this view shows no progress and rejoins nothing.

### Memories

A tree beside a detail pane.

**The tree** groups by repository, then (in the branches view) by branch, keyed on repository **identity** rather than display name — two different projects whose directories share a name merged into one node whose rows then all pointed at the wrong repository. Groups collapse per key; the tabs, the collapsed set and the search text are client state that survives a refresh tick but not a page load.

- The search box filters the **loaded** rows in the browser. Its match count is reported separately from the load footer's, and deliberately never merged with it: the filter ran over what is loaded while the footer compares two server-side totals, so pairing them would state a match count against a set the filter never saw.
- **"Load more" fetches exactly one page and appends it.** Never chained, never automatic: a render-driven chain reflows the tree under the reader's cursor mid-click and spends a request per page of history nobody may scroll to.
  - The request is keyed on the **last row the client holds**, not an offset (spec 353 owns why).
  - Arriving rows are deduped against what is held, because a commit landing between two clicks shifts rows and a repeat is cheap to drop where a gap would be invisible.
  - The total is **adopted from the page**, not left at the value the document was rendered with.
  - A **cursor-missing** answer **replaces** the loaded rows with the returned first page rather than appending — appending would re-add rows the dedupe then drops and re-send the same dead cursor forever. An empty first page there is the same answer, not a special case: the tree simply empties. This check runs **before** the empty-page check below, because the two overlap when the last reachable memory is the one that vanished.
  - An **empty page** while the client believes more exist means the total moved: the page is believed, the total is set to what is loaded, and the footer retires rather than leaving a button that answers every click with nothing.
  - A **failed page** keeps everything that did arrive and turns the footer into a retry, with the failure stated next to the count it stopped from growing.
  - All of that paging state lives on the model's own list object, so a refresh that replaces the model starts again from its own first page instead of stranding it or appending onto the previous one's rows.
- **Selecting a memory is a real navigation** carrying the hash and the owning repository as a *detail* parameter — never as the page scope, which would collapse the tree to one repository as the price of opening one memory.
- **A re-render into an existing page refreshes the tree and the detail but leaves the toolbar in place**, so a reader mid-filter does not lose focus and caret every tick.

**The detail pane** renders the memory's header, token meter, counts, recap, then conversations, context, topics, files and verification scenarios. Two behaviors matter:

- **The token meter's headline and bar use different denominators**, matching the editor: the headline is the reported total, while the three segment widths divide by the segments' own sum, because a folded session can report a scalar count with no breakdown and dividing the widths by the total would underfill the bar.
- **Copy Recall Prompt** assembles a short prompt — an instruction line, then the memory's title, recap, branch and hash, each omitted when absent — and writes it to the clipboard, reporting success (briefly, on the button itself) or unavailability there.

**The context viewer** is one shared dialog. The body is fetched on click rather than shipped with the detail, because a memory can carry several full documents the reader usually never opens, and it is rendered as **preformatted text, not markup**: this application has no markdown renderer, and injecting a document an agent wrote into the document tree is not a corner worth cutting. A failure never leaves the dialog on its loading text — the message includes the status and suggests restarting a long-running server, because a server started before this endpoint existed answers the same "not found" as a genuinely missing document and the fix differs.

Inside a context row, an upstream link is a real navigation nested in a row that is itself a button. Pointer activation and **Enter** on the link are exempted from the row's handler so the click does not also open the archived snapshot; **Space is deliberately not exempted**, because it does not activate a link at all, so exempting it would have traded a working affordance for nothing.

### The Settings modal

Opened from the pinned navigation row over whatever page is showing; **it is not a route and never changes the URL.**

1. The overlay is revealed showing a loading state, and its chrome is wired (the close control, and a click on the backdrop closes).
2. It **fetches the settings payload itself** — the one payload the service refuses to a caller without the page token, since it carries masked keys, sign-in state and a folder path. It is never taken from the inlined model.
3. On success the form is seeded and the modal renders: a section rail — AI Agents, AI Summary, Sync to Jolli, Memory Bank, Others — beside a scrolling content column, with a fixed close band above and a persistent action bar below.
4. On failure it renders an error state with a **Try again** control that re-runs the whole open.

The close control is re-created by every write into the modal body (loading, error, and each render), so it is re-wired each time rather than once at open, and the close band is identical in all three states so it never moves.

**The form is fully controlled.** Every editable value lives in one form object seeded once from the payload; renderers read from it and every edit writes back to it, so switching sections keeps unsaved edits and one Apply saves them all.

- **The action bar is present on every section**, because hiding it on one would strand edits made on another. Apply is disabled until the form diverges from the baseline captured at load, so an unchanged form cannot fire the expensive save on a stray click.
- Each edit updates the Apply button's enabled state and clears a stale save banner **without a full re-render**, so a text field does not lose focus mid-type.
- **Changing the provider is the one edit that re-renders**, because it swaps the whole provider card.
- **The masked keys are the only key material the page ever holds**; the form seeds from them and submits them back unchanged unless edited.
- **Apply validates client-side that at least one agent remains enabled** before sending, and after a successful save it **re-fetches** the payload and reseeds the form — the server is authoritative. A partial success (some repositories' hooks failed to sync) is reported in the banner.
- The global-instructions toggle is tri-state under the hood: turning it off returns it to "never decided" when that is what it started as, rather than asserting an explicit disable.
- **The Folder Path field is checked on blur** against the server, purely advisorily (the save gate re-checks), and the verdict line is updated by a targeted write rather than a re-render so the field keeps focus. A fresh edit invalidates the previous verdict. The reply is discarded if the field's value changed while it was in flight.
- **Two sections lazy-load on first entry**: the per-repository push list, and the missing-summaries count. A failed push-list load sets an error that also **closes the guard** which would otherwise re-fire the request on every render, hammering a failing endpoint forever; switching sections clears it and retries.
- **The per-repository push toggles apply immediately** — no Apply — and report their result on a status line under the toggled row. A failure states that nothing changed and **reloads the persisted list** so the switch snaps back to what is actually stored.
- The remaining actions (sign in, sign out, probe the local agent, migrate, sync now, generate missing summaries) each set a busy state, render, and report into the same banner; sign-in and sign-out reseed the form from a fresh fetch afterwards.

### The refresh loop

- **It runs on the activity dashboard only.** That page reads like a live instrument and is the one a user leaves open; everywhere else a poll only costs — the standup is a draft the reader is editing and a re-render underneath them is actively hostile, and the other two change on user actions that already refresh them. Every view keeps the manual refresh path; only the timer is scoped.
- The interval is **30 seconds**. Each tick refetches the model for exactly the parameters the page was rendered with.
- **The refetch carries the token even though the route answers without one.** The token is what tells the service this is the page's own request rather than a cross-site read, and a tokenless answer omits the one field that costs money to produce — so without it the poll would silently drop the compressed decision line the page was rendered with.
- **A schema-version mismatch triggers a full page reload**, not a re-render. A tab left open across an upgrade is talking to a service whose payload shapes may have moved on, and reloading refetches the current document rather than patching an old one in place.
- **A failed refresh re-renders the last known model anyway.** Callers clear local UI state before handing over the repaint (a row's busy flag, for instance), so swallowing the failure silently left that row stuck in its working state with no controls until a manual reload. Re-rendering the same model is idempotent.

### The request helpers and the token

Three shapes, and which of them carries the token is a deliberate split:

| Request | Token |
| --- | --- |
| Every write (the JSON POST helper) | **Yes**, as a request header |
| The gated reads the modal and its sections use (the JSON GET helper) | **Yes** |
| The model refetch | **Yes** — see above |
| The context-document fetch | **No** — a plain public read |
| The telemetry beacon | **No** — it sits ahead of the token gate |

Both JSON helpers parse the body defensively, treat a non-success status as a failure carrying the server's error text (falling back to the status code), and surface it as a thrown error the calling view turns into a visible message.

### Telemetry

A fire-and-forget beacon, preferring the browser's beacon transport so the event survives the full-page navigation a nav or range click triggers, falling back to a keep-alive request. It is wrapped so it can never break the interface, and it is **content-free**: only bucketed values and fixed discriminators, never raw counts or user text. **Four event names, emitted from six places**: the page being opened (with a first-run flag); a view switch, only when the view actually changes; a range change, only on a real change — from a preset it reports the user-facing day-count label rather than the internal token, but the calendar's Apply reports the internal `custom` token instead, so the two spellings of one event disagree; and a chart split change, only on a real change, from either of the two cards that carry split tabs.

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Any page | Sidebar row click | Full navigation to that view, **range and repository scope dropped** |
| Any page | Settings row click | Settings modal opens over the page; URL unchanged |
| Settings modal, loading | Payload arrives | Rendered form, dirty gate closed |
| Settings modal, loading | Fetch fails | Error state with a retry that re-runs the open |
| Settings modal, clean | Any edit | Dirty — Apply enabled, stale banner cleared |
| Settings modal, dirty | Apply succeeds | Busy → banner → payload re-fetched → form reseeded clean |
| Settings modal, any state | Close control, or backdrop click | Hidden; nothing persisted |
| Activity dashboard | 30 s tick, same schema | Model replaced, page re-rendered |
| Activity dashboard | 30 s tick, schema differs | **Full page reload** |
| Activity dashboard | 30 s tick fails | Last model re-rendered unchanged |
| Range popover, closed | Custom clicked | Open, seeded from the current window |
| Range popover, mid-selection | Refresh tick | **Stays open**, re-rendered, selection preserved |
| Range popover, open | Apply with both bounds | Navigation to the custom window |
| Range popover, open | Cancel / Escape | Closed, pending selection discarded |
| Memories tree | "Load more" succeeds | Page appended (deduped), total adopted |
| Memories tree | "Load more" reports a missing cursor | Loaded rows **replaced** by the returned first page |
| Memories tree | "Load more" returns nothing | Total set to what is loaded; footer retires |
| Memories tree | "Load more" fails | Loaded rows kept; footer becomes a retry |
| Memories tree | Row click | Navigation carrying the hash and the **owning** repository, page scope untouched |
| Context dialog | Row activation | Loading → fetched body as preformatted text, or a message naming the status |
| Repositories row | Pause / Resume | Busy → request → model refetch → re-render (or an error callout) |

## Notable / Surprising Behavior

- **The application is inlined, not served.** There is no static asset route, so nothing about the page can be cached, versioned or fetched independently — a page render always ships the current build's scripts along with the current data. (Notable; it is also what makes the zero-external-request property hold trivially.)
- **The page issues no external request of any kind.** Every icon is inline markup, and the stylesheet's one URL-shaped value is an inline `data:` image; the other two URL-shaped values in the application are a same-document fragment reference and the reader-clicked upstream reference link. (Verified.)
- **The sidebar is buttons, not anchors.** Navigation is real and deep-linkable, but there is no href to middle-click or open in a new tab. (Surprising.)
- **Two controls the page still has handlers for do not exist in its markup**, so an axis chip and a table toggle are both permanently dead — and an empty-state line still directs the reader to one of them. (Unreachable at HEAD.)
- **A missing model global renders nothing at all** — no error, no empty state, just a blank shell. (Surprising.)
- **The synced chip can never appear**, because the tier it is gated on is never detected. (Unreachable at HEAD.)
- **The Risks column can never have content**, because the insight kinds it filters for are never produced. (Unreachable at HEAD; the column and its locked-tier upsell both still render.)
- **A sidebar click silently drops the repository scope**, and that is deliberate: nothing on any page offers a way back to all repositories, so a scope carried through navigation was permanent. (Surprising.)
- **The range parameter is always emitted, never omitted as "the default".** Two independent copies of "what the default is" disagreed, and the shorter URL was not worth a client-side copy of a server-side default. (Notable.)
- **The calendar's "today" is computed with the browser's own calendar fields on purpose**, matching the cell labels rather than the payload's zone — the alternative put the future-day boundary off by one for any viewer in a different zone. (Surprising; the "correct" choice is the broken one here.)
- **An open range popover is re-rendered on the refresh tick rather than left alone.** Leaving it meant the day buttons still called a stale closure while Apply read a fresh one, so a click after a tick navigated to the wrong window or did nothing. (Surprising.)
- **The model refetch carries the token even though the route does not require one**, purely so the answer keeps the field that costs money to produce. (Surprising.)
- **A failed refresh still repaints.** Callers clear their own busy state before handing over the repaint and depend on it happening. (Notable.)
- **A version mismatch reloads rather than re-renders**, because an old page cannot be trusted to read a newer payload shape. (Notable.)
- **Settings is a modal with no route**, so it can be opened over any page and leaves the URL alone — and the client therefore never requests the settings path the service does not serve. (Notable.)
- **The settings payload is fetched, never read from the inlined model**, because it is the one payload the service gates on the page token. (Notable.)
- **The context viewer renders documents as preformatted text.** No markdown is interpreted, deliberately: the body was written by an agent and there is no renderer worth adding for it. (Security-relevant.)
- **Space does not activate a nested link, so it is not exempted from the row handler** — exempting it would have removed the only way to open the dialog from a focused link without adding anything. (Surprising; the asymmetry with Enter is intentional.)
- **The cursor-missing check must run before the empty-page check**, because the two overlap exactly when the last reachable memory is the one that vanished, and the wrong order left dead rows on screen with the total set to their count. (Surprising.)
- **Paging state lives on the payload's list object, not on a module-level flag**, so a refresh that swaps the payload cannot strand the new list at its first page or append its rows onto the old one's. (Notable.)
- **The memories toolbar is deliberately excluded from a re-render into an existing page**, so a reader mid-filter keeps focus and caret through every tick. (Notable.)
- **A failed push-list load closes the guard that would re-fetch it**, because a render-driven retry against a failing endpoint loops forever. (Notable.)
- **Grouping maps are prototype-less wherever the keys are user-controlled strings** — a branch named after an inherited member either dropped its series silently or blanked the page. (Surprising; measured.)
- **The standup's Escape handler is assigned rather than added**, precisely so the 30-second re-render replaces it instead of stacking copies; the calendar's, which must be added, is explicitly removed before re-binding for the same reason. (Notable.)
- **The standup draft is editable and is copied on open as well as on the button**, so the one-click path stays fast while the sheet is what makes the draft correctable before it is posted. (Notable.)

## Shared Behavior

- Every route called here, the checks each is subject to, page assembly, and the token's minting and inlining are owned by spec 352.
- Every payload rendered here, and the meaning of every figure in it, is owned by spec 353 — including the two facts this application renders around: the tier that never reaches its third value, and the insight kinds that are never produced.
- The registry the Repositories view lists and acts on is owned by spec 355.
- The settings mutation semantics behind Apply and the per-repository toggles — masked-key reuse, the cross-repository hook sweep, folder validation, sign-in, migration, sync and backfill — are owned by their own topics.
- Telemetry buffering, consent, and whether a forwarded event is recorded at all are owned by the telemetry topic; this spec covers only what the page emits and when.

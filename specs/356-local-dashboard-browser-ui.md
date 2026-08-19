# 356. Local Dashboard Browser Application

## Topic Statement

The no-build browser application the local dashboard serves: a page-per-view application whose stylesheet and every script are **inlined into each served document**, which boots from a model already embedded in that document, keeps its own client-side view state, opens Settings as a modal that is not a route, refreshes only one of its views on a timer, and reads its mutation credential from the page rather than from a URL.

## Scope

**In scope:**

- What the served document contains and what it does **not** request — the zero-external-request property and why the scripts are inlined rather than fetched.
- The one link a reader may click out of: its scheme allowlist, the normalised probe the allowlist is tested against, and what happens to a URL that clears neither.
- The two page globals (the model and the mutation token) and the boot sequence over them.
- The render dispatch: shell first, then exactly one view renderer.
- The shell: the navigation list, the two optional rows a machine-global preference hides by default, the range control and its calendar popover, the scope chip, the coverage footer, and the tier attribute.
- Link construction — which parameters survive a click and which are deliberately dropped.
- Each page view's behavior, and which of their controls re-render locally versus re-fetch.
- The **Settings modal**: how it opens, what it fetches, its controlled form and dirty gate, its per-section lazy loads, its two immediate-apply controls, its non-gating availability probe, the page-level repaint a save can trigger, and the client state that survives a close.
- The periodic refresh loop: which view it runs on, what it does on a schema mismatch, and what it does on failure.
- How the mutation token is obtained and which requests carry it.
- The content-free telemetry beacon and the events it emits.

**Boundaries (consumed here, owned elsewhere):**

- Every route this application calls, the security checks each is subject to, and how the document is assembled — spec 352. This spec covers only what the browser does with what it is given.
- The payloads it renders and every figure in them — spec 353. Field meanings are not restated here.
- The write protocol behind those payloads (spec 354) and the repository registry (spec 355), which no view lists any more — its list became the topbar picker.
- The mutation semantics behind the Settings actions — masked-key reuse on save, the cross-repository hook sweep, folder validation rules — spec 363; the access boundary those endpoints sit behind and the backfill's concurrency guard — spec 352; the push toggles' machine-global store and per-row wording — spec 310. Sign-in's browser flow, the memory-bank migration, the manual sync and the backfill engine itself have their own topics.
- Three things the views here only render the result of, each a neighbouring topic: the store behind the machine-wide session-statistics switch and the upload channel it governs; the repair verdict an empty conversations list is worded from; and how a memory's archived turns are grouped into the conversations this page lists and opens.
- Visual design: colors, spacing, iconography, and the individual element structure of any card.

## Data Contracts

### What the served document is

One self-contained document per page render: the stylesheet, the two page globals, and every application script arrive already inlined in it, in a load order the service fixes (how the document is assembled is spec 352's).

**Nothing is served as a file.** There is no static asset route at all — a request for a script or stylesheet path answers "not found" — so the application has no cacheable, independently-versioned unit: a page render always ships the current build's scripts alongside the current data.

**The page issues zero external network requests.** Every icon is inline SVG written into the markup; there are no external font, image, frame or stylesheet references (the frames the application does open are same-origin relative routes of its own); the only URL-shaped value in the stylesheet is a single inline `data:` SVG (whose XML namespace declaration is an identifier, not a fetch). Every request the application issues is a same-origin relative path, and nothing uses a long-lived transport. This is what makes the service's refusal to emit any cross-origin header cost the page nothing.

**Re-audited at HEAD, and nothing has been added that could break it.** The only new call is one more same-origin relative POST, and the memory detail's new lock indicator is a text glyph rather than an image — so no URL-shaped value of any kind was introduced.

The one thing that reaches outside is not a request the page makes: an archived reference row renders the upstream URL as an ordinary link the **reader** may click, scheme-allowlisted and opened in a new context with no referrer.

### The link allowlist

The allowlist admits **three literal schemes** — the two web schemes and the mail scheme — and it is an allowlist rather than a filter because the URL comes from an archived third-party reference and this page holds the mutation token, so a script-scheme URL reaching an anchor would run authenticated against the mutating routes. Escaping cannot help: a script scheme survives every HTML escape intact.

**The test runs on a NORMALISED PROBE while the ESCAPED ORIGINAL is what gets rendered**, and both halves are load-bearing. A browser does not read a scheme byte-for-byte: it removes tab, line-feed and carriage-return from **anywhere** in a URL and trims leading control characters and spaces before it looks. The probe reproduces exactly those two rules, then lower-cases — so an obfuscated script scheme with a newline inside it is recognised and refused, while the value handed to the attribute is still the original the browser will actually parse.

Two consequences follow:

- A URL whose scheme the browser cannot read at all is a **relative** URL, so it resolves against this origin and renders as a **dead same-origin link** rather than escalating into another scheme. That is why a probe stricter than the browser is safe here and a probe looser than it is not.
- The allowlist is narrower than the web but **not narrower than the data**: every builtin reference source stores a web URL, including the ones whose desktop apps also register a private scheme — so nothing is being swallowed today. Admitting an app scheme later is a decision about what this page hands to the operating system, and the row must still render (unlinked) when the answer is no.

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
- **dimension** — the axis last selected in this tab, falling back to **the axis the payload says was used**, not to nothing: before the first selection a deep-linked axis was absent from every rebuilt URL, so the poll silently re-asked for the default and the chart changed under the reader. A sidebar click does not drop it either — **range is the only parameter a sidebar click clears** — so the chart axis follows the reader across pages.

Page-specific parameters (a memory's hash, its owning repository, a page cursor) are appended to that base with the correct separator chosen for them.

## Behaviors (execution order)

### Boot

1. Read the model global. **If it is absent, nothing happens at all** — no render, no error state.
2. Render: the shell, then the one view renderer for the model's view.
3. Start the refresh loop (which no-ops on every view but one).
4. Emit an "opened" telemetry event **once per browser session** — navigation is a full page load, so a naive call would fire on every page — carrying a first-run flag derived from a persistent per-profile marker. The whole step is wrapped so blocked storage (private browsing) cannot break boot.

### Render dispatch

The shell renders first, then a per-view renderer. The application container is given the card-grid layout only for the activity view; the standup board supplies its own column layout and must not sit inside another grid. Settings has **no** entry in this table — it is a modal.

**An unrecognised view falls back to the activity renderer.** Unreachable at HEAD, on two counts: only a routed page view can be inlined into a page render, and the refresh loop re-asks for the view the page already has, so the reply can only echo it back. The fallback would also not be a graceful one — the activity renderer dereferences its own payload unconditionally, so an unrecognised view would throw rather than degrade. (Unreachable; one added route with no renderer is all that stands between it and being reached.)

### The shell

Rendered on every render, including every refresh tick.

- **Page title and subtitle** per view; the document title is set to match.
- **A tier attribute** on the root element, which the stylesheet keys the synced chip and the locked-preview treatments off, so the shell reflects the adoption tier with no branching in the view modules. **The synced chip is the only chip left on that attribute**: a second topbar chip stating that the server runs locally and nothing leaves the machine has been removed from both the markup and the stylesheet, so the page no longer asserts that property anywhere in its own interface. **And the property no longer holds** — four tables of the local database are uploaded by default, and this same page now carries the switch that turns that off (Settings → Sync to Jolli). The chip's removal is therefore no longer the loss of a true statement.
- **The navigation list**: a Dashboard group rendered flat under a non-interactive group label with two children (the activity dashboard and the daily standup), then Memories, then Knowledge, then Graph — but **the last two rows are optional and hidden by default**. Each names its own flag in the payload's `menus` block (`menus.knowledge`, `menus.graph`), each flag is a machine-global preference the reader switches on in Settings → Advanced, and the test is strict: an absent block, a partial one, or a non-boolean value all read as **hidden**, so a payload from a service that could not read the preference never reveals a row nobody asked for. The rows stay in the one table whether they are shown or not, so **order among the shown rows never drifts from the enabled case**. **Settings is pinned to the sidebar's bottom edge in its own slot**, a sibling of the scrolling list rather than its last row — built outside the filtered list, so it can never be filtered away — a persistent destination, and the only entry with no page path of its own.
- **Only the row is hidden.** Both views stay routed, so a direct URL is answered normally; each keeps its **page title and subtitle, which come from a separate per-view table rather than from the navigation list**, so a hidden view still renders its own identity with no matching row anywhere in the sidebar; and the Knowledge page's per-repository link to that repository's graph keeps working. Nothing stops being produced either — the preference is about the sidebar and nothing else.
- **No row is gated by repository count any more, and that absence follows the service.** Rows used to be marked disabled when no repository was enabled, mirroring the service's own redirect so that a dead row and a redirect could not disagree; the never-gated row below them was the one that opened the gate. That row is retired, so the gate has nowhere to send anyone and the service no longer redirects — "nothing enabled yet" is rendered as a state on the page the user lands on. **The one filter left is the optional-row preference above, and it is a preference rather than a gate**: the service does not mirror it, and a hidden row's route answers normally instead of redirecting somewhere the reader did not ask for.
- **Knowledge and Graph are scoped by a different repository set from every row above them** — the Memory Bank folder's, not the registry's — which is why neither participates in the topbar repository picker.

**The topbar repository picker** is what replaced the retired Repositories page's list. It offers every repository the registry knows, ordered by display name, each row carrying its sessions over the last 7 local days — and it selects a **set**, not a single repository, matching the payload's list-shaped scope (353). Three per-row states are marked rather than filtered out, and each changes what the row may offer: a **paused** repository still appears and still counts in the aggregates (hiding them made an all-paused dashboard read as "no repositories yet"); a **missing** one appears because its memories are still worth reaching, but must not present itself as a working checkout, and being able to say the entry is dead is precisely what gates the row's forget control; and a repository whose whole **volume** is unavailable — an unplugged drive rather than a deleted folder — is distinguished from the previous state so the row can say something true and ask for a stronger confirmation, instead of offering to forget a repository that is merely unplugged.
- **Every navigation is a full page load, not a client-side swap**, so every view is deep-linkable and reload-safe. The rows are **buttons that assign a location**, not anchors — so the destinations are real URLs but the sidebar itself supports no middle-click, no open-in-new-tab, and no hover target. (In the memories tree the same is true of a row click. Genuine anchors do exist, and there is more than one: the archived reference row's upstream link, and the Knowledge page's per-repository link to that repository's graph.)
- **A sidebar click drops the range and keeps the repository scope.** It rebuilds the link with the range cleared and every other parameter carried through, the scope included — so a set selected in the topbar picker survives a change of page, and only the window resets to the landing page's default. (Predates this delta: recorded here as dropping the scope too, with a rationale about a scope that could never be un-set.)
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

Cards in a fixed order: skills, MCP servers, tokens, decisions, spend, then the feed. (Recorded here as tokens, spend, decisions — wrong before this delta as well as after it.) The widths describe **two bands over the full-width feed**: an equal-third band (skills, MCP servers, tokens) above a half-and-half band (decisions, spend). **The recall card is retired** — its payload no longer exists (353), and what survives of recall reporting is a single row inside the tool-usage card.

**Tokens and decisions swapped bands in this range, and each adopted the other's headline shape.** The card that moved into a third of a row lost its right-aligned headline aside and now prints a larger single-line block figure under its title; the card that moved into the half row gained the aside. So the headline shape belongs to the **seat, not the card** — the aside only fits a half-row-or-wider head, which is what makes it move with the width rather than with the widget. **Each card's empty state follows the seat too, and both deliberately pass no aside**: there is no figure to right-align when the card has no data, and the panel beneath states the whole situation already.

**The feed is one of two things.** At the memory tier with at least one memory card it is the Memory Activity list — memories grouped by branch or by time bucket, each row opening that memory in a new tab, with a captured/gaps/decisions summary above it. Otherwise it is the raw session list, collapsed to the shared page size with a "show all / show fewer" toggle, and at the lowest tier an upsell panel is appended **last** in the card, because it is the call to action rather than a list footer.

Controls split cleanly by whether the answer is already in the payload:

| Control | Behavior |
| --- | --- |
| The tokens card's split tabs | "By type" is local; "by model" and "by repo" **re-fetch** — but only when the axis is not already the one they want, because they share the series query and move the axis to match. This is the **only** control that changes the series axis at HEAD. |
| The MCP card's split tabs | Always local — both views are the same rows in one payload, grouped differently. |
| Memory Activity's branch/time tabs, the feed's expand | Local re-render over the same model. |

**One handler in this page is wired to a control that no longer exists** and can therefore never run: the one that would toggle a card into a table. Nothing in the markup carries the hook it binds against. (Recorded here as two — the second, a re-fetch on a dedicated group-by chip, is gone along with its label table; that predates this delta.) One user-visible trace survives: when the shared axis sits on the other dimension, the tokens card prints an empty note telling the reader to switch a group-by control that is not on the page, and names the card it shares the axis with by a title that card no longer carries — and since the swap that card sits **one band below** rather than beside it, so the instruction now points off the reader's current row as well as at a control that is not there. (Unreachable; the axis is still switchable, but only through the tokens card's tabs above.)

Grouping keys that come from user-controlled strings (branch names, ticket ids, models, repository names) are accumulated into prototype-less maps. A branch named after an inherited object member otherwise made the lookup hand back a function — dropping that series from the chart silently, or throwing and blanking the whole page.

### The daily standup

**Two columns — Yesterday and Today — plus a context strip.** Both columns are **commits only**, flat, and identical in shape.

- **Today states what LANDED today**, which is the constraint the rest follows from. A session is not a commit, and a live session or an uncommitted worktree is work *in flight* — putting either under a heading every reader takes to mean "done" made the column assert something the board cannot know.
- The two columns are also required to list the same rows the activity page's Memory Activity card lists for the same day, so a reader comparing the two surfaces never has to work out whether a difference in wording is a difference in data. **They are not the same query, and the gap is worth knowing**: that card lists memory rows for the window with no author filter, while these columns list author-**filtered** commits. On an ordinary machine the two coincide, because a memory exists only for a commit this machine summarized. They come apart in two directions — a commit of yours that never got a memory shows only here, and a teammate's commit that somehow did shows only there. Keeping the author filter is deliberate, because the board is read out as your own work, so treat the alignment as "same fields, same labels" rather than as an invariant that the two lists are equal.
- **The third column is gone, and it was removed rather than fixed because nothing can fill it.** It rendered the blocker / question / gotcha insights, and the query derives insights from each memory topic's own decisions and todo text — so those are the only two kinds the payload can ever hold, deliberately (a blocker is not guessed from prose). The column therefore always showed its "nothing flagged" note at the memory tier and an upsell for a feature that could not be filled below it. Reinstating it means teaching the summarizer to record those kinds first; a filter on its own has nothing to select. The per-risk addressee marker went with it.
- **Three payload fields are still queried and deliberately not rendered**: the two days' sessions, and the uncommitted-work rows. They are the only local record of "in progress", and the column that would want them has not been designed — but a renderer putting any of them back into a day column re-opens the decision above. A fourth field, the mined insights, survives for one reason only: its mere **presence** is what the renderer reads to decide how many fields a commit row may show, i.e. it carries the memory tier and nothing else.
- The context strip states **whose** commits are shown, in both directions and never silently: an identity chip when filtered, and an explicit "every author — no git identity configured" chip when not. It also shows up to three ticket chips derived from the two days' commits. **The step-progress chip is gone** — it existed to state outright that step progress was missing, and was dropped along with the slimming rather than being filled in.
- **The draft sheet is gone.** An editable markdown sheet built to match the columns, copied to the clipboard on open as well as on its button, with the unfiltered warning leading its subtitle and Escape closing it, used to be described here as the page's actual product. Nothing of it remains — no sheet, no clipboard write, no Escape handler — so the board is the two columns and the context strip, and its product is what a reader copies out of them by hand. (Predates this delta.)

### Knowledge

Browses the human-readable wiki layer of the Memory Bank folder — **not** the machine-level database, which carries no wiki. A repository picker selects which folder to browse, and the file list beneath it is the browsable pages that repository's compile step produced. Selecting one loads it into a sandboxed frame served by a companion route.

Two identity facts govern this view and are the whole reason it is separate from the rest of the application:

- **The repository key here is the Memory Bank folder's own directory name**, a different identity space from the registry the other views are scoped by. Both companion routes resolve that key back to a folder by matching it against the discovered folder list, and **never** by joining caller input into a path — so a key containing traversal segments cannot escape the root.
- **A source-commit link inside a rendered page jumps to the memory that produced it**, and the link carries the owning repository's *registry* scope token rather than the folder directory name, so the jump scopes correctly even when two repositories share a display name.

### Graph

The per-repository knowledge graph. This page is **only** the sandboxed frame — it carries no application chrome of its own — so the "which repository" control lives inside the visualisation's own header rather than in the shell. That control self-navigates the frame to another repository, carrying the current theme, and immediately before navigating it posts the chosen repository to the parent page so the outer URL tracks the frame's repository; without that, a refresh, bookmark or shared link would reopen the previous one. The message is one-way and carries only the repository key, and **the parent validates it against its own list**, so nothing in the page trusts the frame.

A repository with no graph yet gets a friendly page carrying the command to build one, deliberately served as a success rather than an error so the frame shows guidance instead of a browser failure.

**The retired Repositories view.** A page listing registered repositories with a memory badge and a pause/resume action per row used to exist. It is gone: its path is unrouted, its token is not accepted, its sidebar row is removed, and its module is no longer part of the asset inventory. Nothing redirects to it. Its list became the topbar repository picker; its pause/resume actions were **removed outright**, not relocated. "No repository is enabled yet" is now a state the activity dashboard renders rather than a place to be sent, and enabling one is done in the target repository rather than here. (A Decisions page was retired the same way earlier, folded into Memories, and likewise kept only its redirect.)

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

**The detail pane** renders the memory's header, token meter, counts, recap, then conversations, context, topics, files and verification scenarios, and closes with a footer. Several behaviors matter:

- **The token meter's headline and bar use different denominators**, matching the editor: the headline is the reported total, while the three segment widths divide by the segments' own sum, because a folded session can report a scalar count with no breakdown and dividing the widths by the total would underfill the bar.
- **Each conversation row carries the session identifier as its tooltip**, and that is **not** the only thing the identifier is in the payload for — it also keys the row's own conversation-dialog fetch, so a row without one is inert rather than merely untooltipped. (Predates this delta: recorded here as tooltip-only.) The three visible fields cannot tell two conversations from the same source apart — same glyph, same source label, and titles that a first-user-message fallback can make near-duplicates — so a memory fed by three sessions of one agent was unreadable and could not be matched against the recorded sessions or a log line. **When the archive carries no identifier the whole attribute is omitted**, never filled with a placeholder: an absent tooltip says nothing, where a rendered "unknown" would say something false about the session. A dialog that fails to load never sits on its loading text — the message names the status and suggests restarting a long-running server, because a server started before that endpoint existed answers the same "not found" as a genuinely missing conversation and the fix differs.
- **An empty conversations list prints one of three sentences**, chosen from a repair verdict the service attaches to the detail (`transcriptRepairState`): one says the capture is missing but a repair may still be possible, one says it was already repaired from local transcript history, and the third — the plainest — says nothing was captured. **Anything absent or unrecognised takes the plainest**, and the optimistic sentence is never guessed at, because it invites a repair with nothing to work from. The verdict never decides *whether* the empty block renders — the empty list still does that — and the service computes it only when a memory is actually selected, so a tree render with no selection carries none. What the verdict means and how it is derived is a neighbouring topic.
- **Copy Recall Prompt** assembles a short prompt — an instruction line, then the memory's title, recap, branch and hash, each omitted when absent — and writes it to the clipboard, reporting success (briefly, on the button itself) or unavailability there.

**The footer** closes the pane below its sections, and is **absent on the no-selection placeholder**. It is two lines: a transcript-privacy note, then the product signature.

- The privacy note's **subject is chosen by how many conversations this pane lists** — the figure is dropped entirely at zero, and the plural is kept at one, since one conversation can still be several transcript files. The claim itself (the transcripts stay in the repo and are never included in shared exports) does not change with the count.
- The signature is stamped with **this memory's own generation instant** (`generatedAtMs` on the detail, not the model's), so it names when the memory was written and does not move under a refresh tick, and it carries the generating provider when one was recorded — that clause is **omitted rather than placeheld** when it was not.

**The footer's stamp is the application's one long-form local date-and-time, and nothing else uses it.** Its **locale is pinned** rather than taken from the viewer — matching what the editor surfaces and the Markdown export print, so one memory reads the same wherever it is opened — while its **zone is the model's**, like every other date on the page. It renders year, long month, day, hour and minute: no seconds, no weekday, **truncating rather than rounding**, zero-padding the minute but not the hour, and printing midnight and noon on the twelve-hour clock. Its fallback, reached only when the zone itself is invalid, returns a **different clock and a different shape** — a twenty-four-hour UTC stamp with no meridiem. That fallback would itself throw on a non-finite instant, which is exactly the input a fallback exists for; it is unreachable today only because its one caller is guaranteed a finite instant by the service.

**The context viewer** is one shared dialog. The body is loaded on click rather than shipped with the detail, because a memory can carry several full documents the reader usually never opens, and it is loaded as **a sandboxed frame onto a companion route that renders the markdown itself** — the same arrangement the Knowledge page's wiki frame uses. (Predates this delta: recorded here as preformatted text on the grounds that this application has no markdown renderer.) The frame, not the absence of a renderer, is what makes rendering safe: with no same-origin permission the rendered document sits in an opaque origin and can reach neither the mutation token this page holds, nor the model, nor this page's own tree — which was the actual alternative on the table. Closing resets the frame, so one memory's document is never briefly visible under another's title.

Inside a context row, an upstream link is a real navigation nested in a row that is itself a button. Pointer activation and **Enter** on the link are exempted from the row's handler so the click does not also open the archived snapshot; **Space is deliberately not exempted**, because it does not activate a link at all, so exempting it would have traded a working affordance for nothing.

### The Settings modal

Opened from the pinned navigation row over whatever page is showing; **it is not a route and never changes the URL.**

1. The overlay is revealed showing a loading state, and its chrome is wired (the close control, and a click on the backdrop closes).
2. It **fetches the settings payload itself** — the one payload the service refuses to a caller without the page token, since it carries masked keys, sign-in state and a folder path. It is never taken from the inlined model.
3. On success the form is seeded and the modal renders: a section rail — AI Agents, AI Summary, Sync to Jolli, Memory Bank, Others, Advanced — beside a scrolling content column, with a fixed close band above and a persistent action bar below. **Advanced is the one section with no counterpart in the editor host's settings panel**, because it configures this application's own sidebar, which that panel does not render; the other five mirror that panel's tabs down to their label, hint, placeholder and button text.
4. On failure it renders an error state with a **Try again** control that re-runs the whole open.

The close control is re-created by every write into the modal body (loading, error, and each render), so it is re-wired each time rather than once at open, and the close band is identical in all three states so it never moves.

**The form is fully controlled.** Every editable value lives in one form object seeded once from the payload; renderers read from it and every edit writes back to it, so switching sections keeps unsaved edits and one Apply saves them all.

- **The action bar is present on every section**, because hiding it on one would strand edits made on another. Apply is disabled until the form diverges from the baseline captured at load, so an unchanged form cannot fire the expensive save on a stray click.
- Each edit updates the Apply button's enabled state and clears a stale save banner **without a full re-render**, so a text field does not lose focus mid-type.
- **Changing the provider is the one edit that re-renders**, because it swaps the whole provider card.
- **The masked keys are the only key material the page ever holds**; the form seeds from them and submits them back unchanged unless edited.
- **Apply validates client-side that at least one agent remains enabled** before sending, and after a successful save it **re-fetches** the payload and reseeds the form — the server is authoritative. A partial success (some repositories' hooks failed to sync) is reported in the banner.
- **A successful Apply may additionally repaint the page underneath the modal**, and this is the first time the settings modal drives a page-level refetch at all. It happens only when the sidebar preferences just saved differ from what the sidebar was rendered from — otherwise the repaint is gratuitous — and **that comparison is made against the page's own model, never the modal's copy**. The question is whether what the sidebar is showing still matches what was saved, and the sidebar was rendered from the page's payload; asking the modal's copy gets it backwards exactly when the two have drifted, since another surface switching a row off moves the page's model while the open modal still holds the old value, so re-saving from here would read as unchanged and skip the repaint that was most needed. Two consequences are load-bearing: on the graph page the framed visualisation is rebuilt, and on the memories page any additionally-loaded pages of the tree are discarded, because that paging state lives on the model the refetch replaces. The two refetches are independent and the order they land in does not matter — one rewrites the modal's body, the other the shell and the one view renderer.
- The global-instructions toggle is tri-state under the hood: turning it off returns it to "never decided" when that is what it started as, rather than asserting an explicit disable.
- **The Folder Path field is checked on blur** against the server, purely advisorily (the save gate re-checks), and the verdict line is updated by a targeted write rather than a re-render so the field keeps focus. A fresh edit invalidates the previous verdict. The reply is discarded if the field's value changed while it was in flight.
- **Two sections lazy-load on first entry**: the per-repository push list, and the missing-summaries count. A failed push-list load sets an error that also **closes the guard** which would otherwise re-fire the request on every render, hammering a failing endpoint forever; switching sections clears it and retries. A **failed count** load is likewise never retried — the failure is held as a real "no count" rather than as "not yet asked" — while a successful backfill drops the cached count so the line reloads on the next entry.
- **Two controls bypass Apply and write immediately, and they are the only controls in the modal that do.** They are not the whole of the Sync to Jolli section either — the account card, whose arm is sign-in or sign-out, is rendered above both of them (that control is one of the remaining actions below). A single **machine-wide session-statistics switch** sits **above** the per-repository list; the per-repository push toggles sit beneath it. Both post to their own endpoint on change — the switch to `/api/settings/set-sync-sessions` — and both report their outcome **beside their own row** rather than in the shared banner. The session switch is additionally **withheld from the batched payload** Apply submits, so a save cannot undo a toggle made after the page loaded (the server leaves a value it was not sent alone); the per-repository list was never in the form at all. The block beneath the switch was retitled to name memories per repository. The push toggles' store, per-row wording, and the reload that snaps a failed switch back to what is stored are spec 310's; the switch's own store and the upload channel it governs are a neighbouring topic.
- The remaining actions (sign in, sign out, probe the local agent, migrate, sync now, generate missing summaries) each set a busy state, render, and report into the same banner; sign-in and sign-out reseed the form from a fresh fetch afterwards.
- **The local-agent availability probe is a manual button and its result gates nothing.** It renders beside the button and does not touch Apply — unlike the desktop editor's equivalent, where a confirmed-unavailable verdict disables saving on every tab at once and an in-flight one holds the click.

**Closing the modal only hides the overlay, so most of its state outlives it.** The selected section, the loaded push list, the missing count, the probe result and the session-statistics **status line** all survive a close and are still there on the next open. What follows:

- The two lazy loads are **once per page LOAD**, not once per open — reopening the modal does not re-ask either endpoint.
- The modal **reopens on the last-used section**, not on the first one.
- Only the form — and the session-statistics switch, which is seeded beside it rather than inside it — is reseeded on each open, from a fresh payload fetch, because the server is authoritative for the values.
- **The session-statistics switch's position and its status line are therefore retained on different terms**, and they can disagree. The position is reseeded from the fresh fetch on every open; the status line is not cleared by an open, and only a rail switch clears it. So after switching the statistics off, closing, and having the value changed back from another surface, reopening shows a **checked** switch above an emphatic line asserting that nothing is uploaded on any repository, with nothing on screen resolving which is true. The older per-repository status line does not have this, because the list it reports against is retained alongside it — the row's own position is as stale as its line.

### The refresh loop

- **It runs on the activity dashboard only.** That page reads like a live instrument and is the one a user leaves open; everywhere else a poll only costs — the standup is a board the reader is reading out or copying from and a re-render underneath them is actively hostile, and the other two change on user actions that already refresh them. Every view keeps the manual refresh path; only the timer is scoped.
- **One manual trigger is new, and it can fire on any view**: a successful Settings Apply whose sidebar preferences changed drives a page-level refetch over whatever page the modal was opened on (see the Settings modal above). It is the first such trigger the settings modal has ever had, and it runs the same refetch the timer does — including the schema-mismatch reload and the repaint-on-failure below.
- The interval is **30 seconds**. Each tick refetches the model for exactly the parameters the page was rendered with.
- **The refetch carries the token even though the route answers without one.** The token is what tells the service this is the page's own request rather than a cross-site read, and a tokenless answer omits the one field that costs money to produce — so without it the poll would silently drop the compressed decision line the page was rendered with.
- **A schema-version mismatch triggers a full page reload**, not a re-render. A tab left open across an upgrade is talking to a service whose payload shapes may have moved on, and reloading refetches the current document rather than patching an old one in place.
- **A failed refresh re-renders the last known model anyway.** Callers clear local UI state before handing over the repaint (a row's busy flag, for instance), so swallowing the failure silently left that row stuck in its working state with no controls until a manual reload. Re-rendering the same model is idempotent.
- **A tick repaints the page underneath an open Settings modal without disturbing it.** The repaint writes the shell and the one view renderer; the modal is a separate fixed layer with its own body, which nothing on that path touches. So a form mid-edit, a mid-flight lazy load and a busy action all survive every tick, and the page behind the overlay stays live.

### The request helpers and the token

Which requests carry the token is a deliberate split:

| Request | Token |
| --- | --- |
| Every write (the JSON POST helper) | **Yes**, as a request header |
| The gated reads the modal and its sections use (the JSON GET helper) | **Yes** |
| The model refetch | **Yes** — see above |
| The framed context document, and the conversation dialog's own fetch | **No** — plain public reads (the framed document arrives as a frame navigation rather than a helper call) |
| The telemetry beacon | **No** — it sits ahead of the token gate |

Both JSON helpers parse the body defensively, treat a non-success status as a failure carrying the server's error text (falling back to the status code), and surface it as a thrown error the calling view turns into a visible message.

### Telemetry

A fire-and-forget beacon, preferring the browser's beacon transport so the event survives the full-page navigation a nav or range click triggers, falling back to a keep-alive request. It is wrapped so it can never break the interface, and it is **content-free**: only bucketed values and fixed discriminators, never raw counts or user text. **Four event names, emitted from six places**: the page being opened (with a first-run flag); a view switch, only when the view actually changes; a range change, only on a real change — from a preset it reports the user-facing day-count label rather than the internal token, but the calendar's Apply reports the internal `custom` token instead, so the two spellings of one event disagree; and a chart split change, only on a real change, from either of the two cards that carry split tabs.

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Any page | Sidebar row click | Full navigation to that view, **range dropped, repository scope carried** |
| Any page | An optional row's preference switched on in Advanced | That row appears in the navigation list; the route was already answering either way |
| Any page | Settings row click | Settings modal opens over the page; URL unchanged |
| Settings modal, loading | Payload arrives | Rendered form, dirty gate closed |
| Settings modal, loading | Fetch fails | Error state with a retry that re-runs the open |
| Settings modal, clean | Any edit | Dirty — Apply enabled, stale banner cleared |
| Settings modal, dirty | Apply succeeds | Busy → banner → payload re-fetched → form reseeded clean |
| Settings modal, dirty | Apply succeeds and the saved sidebar preferences differ from the page's model | As above, **plus** the page underneath is refetched and repainted (framed graph rebuilt; memories paging discarded) |
| Settings modal, Sync to Jolli | Session-statistics switch changed | Posted immediately; the outcome is reported under that row, never in the shared banner, and the batched Apply never carries the field |
| Settings modal, any state | Close control, or backdrop click | Hidden; nothing persisted to disk, but the section, push list, missing count, probe result and session-statistics status line are all **retained** |
| Settings modal, hidden with state | Pinned row clicked again | Reopens on the **last-used section**; neither lazy load re-fires |
| Activity dashboard, Settings modal open | 30 s tick | Page underneath repainted; the modal is untouched |
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
| Context dialog | Row activation | The sandboxed frame is pointed at the companion route, which renders the document; closing blanks the frame |
| Conversation row | Row activation (only with a session identifier) | Dialog opens and fetches that session's conversation; a failure states the status and suggests restarting a long-running server |
| Memory detail | Selection with an empty conversations list | The empty block prints one of three sentences, chosen from the attached repair verdict; anything absent or unrecognised takes the plainest |
| Knowledge repository picker | Selection | Loads that folder's page list; selecting a page loads it into the sandboxed frame |
| Graph in-frame repository switcher | Selection | The frame self-navigates, carrying the theme, and posts the key to the parent so the outer URL tracks it |

## Notable / Surprising Behavior

- **The application is inlined, not served.** There is no static asset route, so nothing about the page can be cached, versioned or fetched independently — a page render always ships the current build's scripts along with the current data. (Notable; it is also what makes the zero-external-request property hold trivially.)
- **The page issues no external request of any kind.** Every icon is inline markup, and the stylesheet's one URL-shaped value is an inline `data:` image; every other URL-shaped value in the application is a same-origin relative path, a same-document fragment reference, or the reader-clicked upstream reference link. (Verified, and re-audited at HEAD: the only addition since is one more same-origin relative POST, and the memory footer's lock indicator is a text glyph rather than an image — no URL-shaped value of any kind was added.)
- **The two folder-backed rows are hidden by default, and only the row is hidden.** Both views stay routed, both keep the page title and subtitle they draw from a separate per-view table, and the Knowledge page's link into a repository's graph keeps working — so a hidden view can render its full identity with no matching row anywhere in the sidebar. An absent, partial or non-boolean preference reads as hidden. (Surprising; the pages ship unreachable from the navigation.)
- **The sidebar is buttons, not anchors.** Navigation is real and deep-linkable, but there is no href to middle-click or open in a new tab. Real anchors exist elsewhere, and there is more than one — the upstream reference link and the Knowledge page's per-repository graph link. (Surprising.)
- **One control the page still has a handler for does not exist in its markup**, so a table toggle is permanently dead — and an empty-state line still directs the reader to a group-by control that was removed with its own handler. (Unreachable at HEAD; recorded here as two dead handlers before this delta.)
- **A card's headline shape belongs to its seat, not to the card.** Tokens and decisions swapped bands, and each took the other's head with the width: the third-of-a-row seat prints a block figure under the title, the half-row seat prints a right-aligned aside. Both cards' empty states follow the seat too, and both deliberately pass no aside. (Notable.)
- **A missing model global renders nothing at all** — no error, no empty state, just a blank shell. (Surprising.)
- **The synced chip can never appear**, because the tier it is gated on is never detected. (Unreachable at HEAD.)
- **The Risks column was deleted rather than left unreachable.** Its insight kinds are never produced, so it always rendered an empty note or an upsell; the standup now has two columns and neither the column nor its locked-tier upsell exists. This is the resolution of what was previously recorded here as an unreachable render path.
- **A sidebar click drops the range and nothing else.** The repository scope, the axis and the custom bounds all ride through a change of page; only the window resets. (Notable; recorded here before this delta as dropping the scope as well, with a rationale for a behavior the page does not have.)
- **The range parameter is always emitted, never omitted as "the default".** Two independent copies of "what the default is" disagreed, and the shorter URL was not worth a client-side copy of a server-side default. (Notable.)
- **The calendar's "today" is computed with the browser's own calendar fields on purpose**, matching the cell labels rather than the payload's zone — the alternative put the future-day boundary off by one for any viewer in a different zone. (Surprising; the "correct" choice is the broken one here.)
- **An open range popover is re-rendered on the refresh tick rather than left alone.** Leaving it meant the day buttons still called a stale closure while Apply read a fresh one, so a click after a tick navigated to the wrong window or did nothing. (Surprising.)
- **The model refetch carries the token even though the route does not require one**, purely so the answer keeps the field that costs money to produce. (Surprising.)
- **A failed refresh still repaints.** Callers clear their own busy state before handing over the repaint and depend on it happening. (Notable.)
- **A version mismatch reloads rather than re-renders**, because an old page cannot be trusted to read a newer payload shape. (Notable.)
- **Settings is a modal with no route**, so it can be opened over any page and leaves the URL alone — and the client therefore never requests the settings path the service does not serve. (Notable.)
- **The settings payload is fetched, never read from the inlined model**, because it is the one payload the service gates on the page token. (Notable.)
- **The context viewer renders documents as markdown, inside a sandboxed frame onto a companion route.** The frame is the safeguard, not the absence of a renderer: with no same-origin permission the rendered document cannot reach the mutation token, the model, or this page's own tree — which is what made injecting an agent-written document into *this* document the unacceptable alternative. (Security-relevant; recorded here before this delta as preformatted text on the grounds that the application has no markdown renderer.)
- **Space does not activate a nested link, so it is not exempted from the row handler** — exempting it would have removed the only way to open the dialog from a focused link without adding anything. (Surprising; the asymmetry with Enter is intentional.)
- **The cursor-missing check must run before the empty-page check**, because the two overlap exactly when the last reachable memory is the one that vanished, and the wrong order left dead rows on screen with the total set to their count. (Surprising.)
- **Paging state lives on the payload's list object, not on a module-level flag**, so a refresh that swaps the payload cannot strand the new list at its first page or append its rows onto the old one's. (Notable.)
- **The memories toolbar is deliberately excluded from a re-render into an existing page**, so a reader mid-filter keeps focus and caret through every tick. (Notable.)
- **A failed push-list load closes the guard that would re-fetch it**, because a render-driven retry against a failing endpoint loops forever. (Notable.)
- **Closing the Settings modal only hides it, so its state outlives the close.** The section, the push list, the missing count, the probe result and the session-statistics status line are all still there on the next open — which makes the two "lazy-load on first entry" fetches once per page **load** rather than once per open, and makes the modal reopen where the reader left it rather than on the first section. (Surprising; "first entry" reads as per-open.)
- **The 30-second tick repaints the page underneath an open modal and cannot disturb it.** The repaint writes the shell and one view renderer; the modal body is a separate fixed layer nothing on that path touches. (Notable.)
- **The local-agent availability probe is manual and gates nothing here.** The desktop editor's equivalent disables Apply on a confirmed negative — for the whole panel — and holds a click made mid-check; this modal's button only prints a line. (Surprising; the same check, two entirely different consequences.)
- **The link allowlist tests a normalised probe and renders the escaped original.** Three literal schemes are admitted (the two web schemes and the mail scheme); the probe strips tab, line-feed and carriage-return from anywhere, trims leading control characters and spaces, and lower-cases — mirroring exactly what a browser does before it reads a scheme, which is what refuses an obfuscated script scheme. Because the probe never becomes the attribute, a URL the browser cannot read a scheme out of is a relative one, so the worst case is a dead same-origin link rather than an escalation. (Security-relevant; the escaping alone would not have stopped it.)
- **A conversation row's tooltip is the session identifier, and it is omitted rather than placeheld.** It is the only field distinguishing two conversations from one source; when the archive has no identifier the attribute is dropped, because "unknown" would be a claim about the session and no tooltip is not. **The same identifier also keys the row's conversation-dialog fetch**, so a row without one is inert rather than merely untooltipped. (Notable; recorded here before this delta as a tooltip and nothing more.)
- **The memory footer's privacy note counts CONVERSATIONS, where the editor surface's footer counts transcript FILES.** One conversation can be several files and one file several conversations, so the two surfaces print different figures for the same memory — and this one prints the figure a reader can check by counting the rows above it. The two footers differ in their stamp as well: this one carries the memory's own generation instant, the editor's a render-time clock. The other editor surface's footer carries neither a privacy note nor a count at all. (Notable.)
- **The footer's long-form stamp has a fallback with a different clock and a different shape** — a twenty-four-hour UTC stamp with no meridiem, against a pinned-locale twelve-hour local one — reached only when the zone itself is invalid. That fallback would itself throw on a non-finite instant, i.e. on exactly the input a fallback is for; it is unreachable today only because its one caller is guaranteed a finite instant by the service. (Unreachable at HEAD; surprising where it is reachable.)
- **The topbar's local-only chip is gone from the markup and the stylesheet, and the property it asserted no longer holds.** Only the synced chip is still keyed off the tier attribute, so the page never states in its own interface that it runs locally and sends nothing — which is just as well: four tables of the local database are uploaded by default, and this same page now carries the switch that turns that off. (Notable; recorded here before this delta as an unasserted property that "merely holds". The tier attribute drives one chip, not two.)
- **Closing the Settings modal leaves the session-statistics switch and its status line on different terms, and they can contradict each other on screen.** The switch's position is reseeded from a fresh fetch on every open; the line is cleared only by a rail switch. Turn the statistics off, close, have the value changed back from another surface, and reopening shows a checked switch above an emphatic line saying nothing is uploaded anywhere, with nothing resolving which is true. The per-repository line escapes this only because the list it reports against is retained alongside it. (Surprising.)
- **A Settings save can repaint the page underneath the modal**, and it is the first thing in the modal that reaches out of it. It fires only when the saved sidebar preferences differ from **the page's** model — never the modal's copy, which is backwards precisely when the two have drifted — and it costs the framed graph's state on one page and the memories tree's loaded pages on another, because that paging state lives on the model the refetch replaces. (Surprising; a settings save is not otherwise a navigation.)
- **Grouping maps are prototype-less wherever the keys are user-controlled strings** — a branch named after an inherited member either dropped its series silently or blanked the page. (Surprising; measured.)
- **The calendar's Escape handler is tracked across renders and removed before re-binding**, because the shell re-renders on every refresh tick and an untracked listener would accumulate for the life of the tab. The standup's equivalent is gone with the draft sheet it closed. (Notable.)
- **The standup's draft sheet was removed, not kept unreachable.** The editable markdown sheet that mirrored the columns, copied itself on open and on its button, and led with the unfiltered warning is gone entirely — sheet, clipboard write and Escape handler alike — so the board is the two columns and the context strip. (Notable; recorded here before this delta as the page's actual product.)

## Shared Behavior

- Every route called here, the checks each is subject to, page assembly, and the token's minting and inlining are owned by spec 352.
- Every payload rendered here, and the meaning of every figure in it, is owned by spec 353 — including the two facts this application renders around: the tier that never reaches its third value, and the insight kinds that are never produced.
- The repository registry is owned by spec 355. No view lists or acts on it any more: its list became the topbar repository picker, and the retired view's pause/resume actions were **removed outright** rather than relocated. (Settings does carry a per-repository push toggle, and a machine-wide session-statistics switch above it, but both govern outbound publishing rather than whether a repository is enabled.)
- The Memory Bank folder layout the Knowledge and Graph views browse — its discovery, its per-repository root, and the visible wiki layer a compile step regenerates wholesale — is owned by the Memory Bank and wiki topics. This view only enumerates and renders what is there, and guards every read independently because that layer is rewritten wholesale rather than patched.
- The settings mutation semantics behind Apply — masked-key reuse, the cross-repository hook sweep, folder validation, and what the modal's own migrate hint gets wrong — are owned by spec 363; the access boundary its endpoints sit behind and the backfill's concurrency guard by spec 352; the per-repository push toggles' store, row contents and per-row wording by spec 310; and sign-in's browser flow, the migrate routine, the sync round and the backfill engine by their own topics. The machine-wide session-statistics switch's store and the upload channel behind it — what is sent, which repositories it covers, and what is withheld — are a neighbouring topic; this spec owns only the switch as a control. Likewise the modal's Advanced section owns no preference semantics: the two sidebar flags are ordinary settings values, and what a hidden row does *not* stop is stated in the shell above. So this spec owns only the modal as client behaviour: its open sequence, its controlled form and dirty gate, its lazy loads and their guard, its two immediate-apply controls, the probe that gates nothing, the conditional page repaint a save can drive, and the state that survives a close.
- The repair verdict an empty conversations list is worded from, and the grouping of a memory's archived turns into the conversations this pane lists and opens, are each a neighbouring topic. This spec owns only the three sentences and the fallback among them, and the row's own affordance.
- Telemetry buffering, consent, and whether a forwarded event is recorded at all are owned by the telemetry topic; this spec covers only what the page emits and when.

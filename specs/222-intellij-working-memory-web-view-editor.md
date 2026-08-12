# 222. IntelliJ Working Memory Web View Editor

## Topic Statement

A read-only embedded-browser editor tab that renders "the full memory the next commit will save" — branch and change stats, a proposed-title placeholder, a token-status line, and three lists (active conversations, linked context, changed files) plus privacy/local-first notes — and carries one button that bridges back into the IDE to run the AI commit, opened as a single reusable tab via a dedicated virtual file and editor provider.

## Scope

**In scope:**

- The trigger: a "Review" action elsewhere opens this tab; there is exactly one logical Working Memory per project, so the tab is reused rather than duplicated.
- The virtual-file contract: a single-identity in-memory file whose name is `✨ Working Memory`, read-only, all instances equal.
- The provider contract: it claims only this virtual-file class, declares a fixed editor-type id, hides the default editor, and is available during indexing.
- The editor wrapper: name, always-clean state, no-op state setter, and disposal that tears down the embedded browser and its bridge.
- The embedded-browser body and its graceful fallback when the embedded browser is unavailable.
- The one-way data gathered for the view: branch, change stats (insertions/deletions/files vs `HEAD`), a detected ticket id, a token-status label, the active-conversation list, the linked-context list, and the changed-file list.
- The rendered page structure and its fixed copy (title, intro, proposed-title block, token meter, three lists with empty-state rows, privacy note, commit-note, local-first note, and the Commit Memory button).
- The JS↔host bridge: the page calls a single host function with a JSON command; the host recognizes `commitMemory` (run the AI commit on the UI thread) and `toggleExclude` (leave a context row in or out of the next memory, off the UI thread).
- The leave-out toggle on a context row, and the special case the aggregate skills row forces on it.
- The reload-on-status-change behavior: the page is rebuilt off the UI thread and reloaded whenever project status changes.
- External-link handling: http/https navigations open in the system browser instead of inside the panel.
- The theming inputs and their disagreement: the pre-load shell colour taken from the IDE's live editor background, the light/dark palette taken from the widget theme's brightness flag, and the page's own background left at the borrowed stylesheet's dark default.
- The fact that this view constructs and destroys its own embedded-browser instance rather than borrowing a pooled one.

**Out of scope (boundaries):**

- The AI-commit action that the Commit Memory button runs — its own spec; this view only sends the command and invokes the action with an explicit project context.
- The active-session aggregator that supplies the conversation list — its own spec.
- The plans/notes/references registry that supplies the context list — its own spec.
- The git wrapper that supplies the current branch and the diff stats — its own spec; this view only calls it and parses the textual output.
- The changed-files query — owned by the project service.
- The shared summary CSS theme tokens reused by the page — owned by the summary-view styling; this view only layers extra rules on top.
- The per-producer logo SVG assets inlined into the page — owned by the icon resource set.
- The "Review" button that triggers the open — owned by the working-memory section container spec.
- The file-discard command the same bridge also carries, and the confirmation, git work and editor refresh behind it — owned by the discard spec.
- Which skills count as still-uncommitted, how the aggregate row's label is composed, and the bridge adapter that answers both — owned by specs 319, 323 and 336.
- The exclusion store the toggle writes into — owned by spec 188.

## Data Contracts

### Trigger and tab reuse

The tab is opened by handing a Working Memory virtual file to the IDE's open-file mechanism with focus. Because all instances of the virtual file are equal (single fixed identity), opening it again surfaces the existing tab rather than opening a second one.

### Virtual-file shape

| Property | Value |
| --- | --- |
| name | `✨ Working Memory` |
| extension | empty |
| writable | `false` |
| equality | every instance equals every other instance (identity is a single constant) |

### Provider contract

| Field | Value |
| --- | --- |
| editor-type id | `jollimemory-working-memory` |
| accept | true only for the Working Memory virtual-file class |
| policy | hide the default editor |
| available during indexing | yes |

### Editor wrapper

| Trait | Value |
| --- | --- |
| display name | `Working Memory` |
| modified | always `false` (never dirty) |
| valid | always `true` |
| set-state | no-op |
| dispose | tears down the embedded browser, the bridge query handler, and unsubscribes the status listener |

### The view model (gathered one-way)

| Field | Source / rule |
| --- | --- |
| branch | The git wrapper's current branch, or `unknown`. |
| files changed / insertions / deletions | Parsed from a `diff HEAD --shortstat` run (staged + unstaged vs `HEAD`). When the shortstat yields zero files (e.g. only untracked), the file count falls back to the changed-files query size. |
| detected ticket | The first `[A-Z]+-\d+` match found in a context item tagged `L` (Linear) or `J` (Jira), else the first such match in the branch name, else none. |
| token label | A fixed `N/A tokens` — live sessions carry no token usage in this surface; usage is captured only when the memory is generated at commit time. |
| conversations | The active-session aggregator's current conversations, each mapped to `(producer, title-or-fallback, message-count)`; on any failure, an empty list. |
| context | The shared "what the next memory would claim" answer — plans, notes, references and the current leave-out set in one round trip — plus the aggregate skills row from a second (see below). |
| files | The changed-files query, each split into file name, directory, and a one-letter status (default `M`). |

### Context-list rules

Each context row carries a tag glyph, a title, the **exclusion kind** it belongs to, the **key** the leave-out toggle writes, and whether it is currently left out. Rows that are left out stay listed, struck through, with an add-back affordance — the view never drops a row because the user unchecked it.

The plan / note / reference rows come from the shared "what the next memory would claim" answer, which arrives together with the current leave-out set in one round trip. That answer is deliberately narrower than the browsable Context panel's list, and it already drops plans and notes whose source file is gone; this view applies **no filter of its own**, and in particular no branch filter — uncommitted working-area items follow the user across a checkout and bind to a branch only at commit.

- **Plans**: tag `P`, key = the plan's slug.
- **Notes**: tag `N`, key = the note's id.
- **References**: tag from the shared source-presentation table rather than a local mapping — whatever letter that table returns. Every tag is a single letter (Linear `L`, Jira `J`, GitHub `G`, Notion `N`, and so on), with a neutral `R` for a source this surface's enum does not yet cover. The table is owned by spec 313. Key = the reference's map key. The title comes with the payload rather than being looked up here, so the row is not labelled by a second, host-side rule.
- **Skills**: at most **one** aggregate row for every skill captured this session, tag `S`, appended last and shown only when the set is non-empty. Its figures come from a **second** round trip, deliberately not from the raw skill registry: a skill row survives archival (guarded, not deleted, so a later re-entry is still detectable), so the raw map would list every skill ever used as if it were pending. Its title is the label the shared implementation composes.

**The skills row's key is the empty string**, and that is a contract, not a placeholder: one row stands for every captured skill, so there is no single key to carry. It reads as left-out only when **every** captured skill's key is in the leave-out set, so a partially-excluded set renders as included and the next click excludes the remainder rather than re-including what was already out.

**The letter `S` is overloaded, and on this surface nothing disambiguates it.** Across the product `S` is a snippet note, this skills aggregate, and the Slack reference source; `J` is both Jira and the product's own memory-lookup source; `Z` is both Zoom kinds. The sibling panels tell them apart by the badge's colour — but every tag glyph here renders in one uniform outlined chip with no per-kind hue at all, so a reader of this list has only the letter. (Surprising; observed.)

### Rendered page (fixed structure and copy)

In order:

1. Title `Working Memory`.
2. Meta strip: branch · a `NOT COMMITTED` chip · stats `+<ins> −<del> · <N> file(s)`.
3. Intro paragraph explaining everything shown is included and nothing is committed until Commit Memory.
4. Proposed-title block: label `Proposed title` with an `AI` pill, the text "An AI-written commit message is generated when you commit.", and a grid line `Target commit next on <branch>` plus an optional `Detected ticket <id>`.
5. Token meter: the token label followed by `· captured by this memory`.
6. Conversations list (count badge), each row = inlined producer logo SVG (dark variant when available) + title + optional `<n> msg(s)`; empty row text `No active conversations in the last 2 days.`
7. Context list (count badge — the number of rendered rows, so the aggregate skills row counts as one), each row = tag glyph + title + the leave-out toggle; empty row text `No linked plans, notes, references, or skills.`
8. Files list (count badge), each row = file name (monospace) + optional directory subline + a status glyph colored by status; empty row text `No changed files.`
9. Privacy note about transcripts staying in the repo.
10. Commit-note explaining the commit covers files only; conversations/context stay local.
11. A local-first note with a database glyph.
12. A full-width `Commit Memory` button.

### Bridge protocol

- The host injects a single global function the page can call with a string message.
- The page's Commit Memory button calls that function with `{"command":"commitMemory"}`; a context row's leave-out toggle calls it with `{"command":"toggleExclude", kind, key, excluded}`. (A file row's discard button uses the same channel; that command is out of scope here.)
- The host parses the message and dispatches on the command. `commitMemory` runs the AI commit **on the UI thread**, because the first thing it does is open dialogs. `toggleExclude` runs **off** the UI thread, because writing the leave-out set is a cross-process round trip that can take a cold start to answer; it touches no UI itself and hops back for the refresh it triggers.
- **The `toggleExclude` dispatch guards on the key being present, not on it being non-empty**, which is precisely what lets the aggregate skills row's empty key through. A blank-key guard here would make that row's toggle a silent no-op.
- Any parse failure is logged and ignored. The host always returns an `ok` response.

## Behavior

### Opening / building

1. The tab is created with the embedded-browser body.
2. **Before the first content load**, the IDE's live editor background colour is read and applied to both the hosting component and the embedded browser's initial blank page. The browser keeps the blank page painted until the real page commits its first frame, so this is what stops the blank-to-content navigation from flashing white.
3. The body builds the HTML from the gathered view and the current light/dark theme and loads it.
4. A status listener is registered so the page reloads on every status change.

**Theming divergence worth recording.** The pre-load background in step 2 comes from the **editor colour scheme**, while the light/dark palette baked into the page in step 3 comes from the **widget theme's brightness flag** — two independent settings that can disagree. The memory-summary view (spec 120) derives both from one colour precisely so they cannot; this view was given the pre-load background treatment without that second half.

The page's own background is a third, separate input, and it is currently wrong in the light case. This page borrows the memory-summary view's stylesheet, whose background variable is a parameter with a **dark default**; this view passes only the light/dark flag and never supplies a colour. So the page always paints a near-black background: correct-looking under a dark widget theme, and under a **light** widget theme a near-black page rendered with the light palette's near-black text — the page's own content is effectively unreadable. The pre-load shell colour also stops matching the page's background whenever the editor scheme's background is not that same near-black. See Notable Behavior.

If the embedded browser cannot be created, the body falls back to a read-only monospace text area reading that the preview requires the embedded browser; no further data gathering or bridge is set up.

### External links

A navigation handler intercepts http/https URLs and opens them in the system browser, cancelling the in-panel navigation; other URLs proceed normally.

### Reload on status change

On each status-change fire: rebuild the HTML off the UI thread, then reload it into the browser on the UI thread. If the browser is gone, the reload is skipped.

### Commit Memory

1. The page calls the bridge with `commitMemory`.
2. The host marshals to the UI thread and resolves the AI-commit action; if absent, nothing happens.
3. The host builds an action event with an explicit project data context (so the project resolves the same way it would from the tool window) and performs the action.

### Leaving a context row out of the next memory

Off the UI thread:

1. **The aggregate skills row is special-cased on its empty key.** It resolves the current set of captured skills and writes **every** one of their keys in a single bulk operation. Leaving any behind would strand that skill in a state the reader has no affordance to see or change, because the row is the only surface for all of them.
2. Every other kind writes its single key.
3. On failure the write is logged and the refresh is skipped, so the row stays showing what the store still holds.
4. On success the view announces the selection change (so other open reviews reload) and directly refreshes the sidebar panel that mirrors the same state — plans, notes, references and skills all live in one such panel, conversations in another. Those panels listen on a different channel than this announcement, so without the direct refresh a leave-out here would not move their checkboxes, and both must agree because the commit reads the same store all of them write.

**An empty skill-key set is treated as "do nothing", not as "exclude nothing".** The row is only drawn when skills were captured, so an empty resolution means either that the read failed (it degrades to empty rather than reporting failure, so the surrounding failure handling cannot see it) or that a commit in another window archived them between render and click. Writing an empty bulk operation would rewrite the store unchanged and report success — the click would vanish with nothing to explain it. The write is skipped and logged, and the refresh still runs, so the checkbox resyncs or the stale row disappears.

### Disposal

Remove the status listener, dispose the bridge query handler, and dispose the embedded browser.

## State Transitions

```
[Review opens the tab]
  open Working-Memory virtual file (focus)
    [tab already exists] → bring to front (single identity)
    [no tab] → provider claims → build editor

[editor built]
  try create embedded browser
    [ok] → register bridge query handler
           install http/https → system-browser navigation handler
           loadHTML(buildHtml(gatherView(), isDark, bridgeScript))
           addStatusListener(reload)
    [fail] → show "preview requires the embedded browser" text area

[gatherView()]
  branch ← gitOps.currentBranch ?? "unknown"
  (files, ins, del) ← parse(diff HEAD --shortstat); files ← files>0 ? files : changedFiles.size
  conversations ← aggregator.list().map{...}  (catch → [])
  context ← shared claim-set answer (plans + notes + references + leave-out set)
            then, when non-empty, one aggregate skills row (second round trip, empty key)
  detectedTicket ← ticket regex over L/J context title, else over branch, else null
  tokenLabel ← "N/A tokens"
  files ← changedFiles().map{name, dir, status}

[status change]
  off-UI: html ← buildHtml(...) ; on-UI: browser.loadHTML(html)

[page → bridge "toggleExclude" {kind, key, excluded}]
  (key present, possibly empty — an empty key is the skills row)
  off-UI:
    [kind == skills] → resolve every captured skill's key
                        [none resolved] → log; skip the write
                        [else]          → one bulk write of them all
    [else]           → write the single key
    [write failed]   → log; no refresh
    [ok]             → announce selection change; refresh the mirroring sidebar panel;
                       reload this review

[page → bridge "commitMemory"]
  on-UI: action ← lookup AI-commit ; if null → no-op
         event ← createFromAnAction(action, project context)
         action.performed(event)

[disposed]
  removeStatusListener ; jsQuery.dispose() ; browser.dispose()
```

## Notable Behavior

- **There is exactly one Working Memory tab per project.** The virtual file's identity is a single constant, so every open collapses to the same tab.
- **The view is presentational, but no longer strictly one-way.** It renders a snapshot and edits no artifact, yet two of its controls write: the Commit Memory button runs the AI-commit action, and a context row's toggle writes the next memory's leave-out set (a file row's discard is a third, owned elsewhere).
- **The token label is always `N/A tokens` here.** Live sessions in this surface carry no token usage; the real token count is captured only when the memory is generated at commit time.
- **Change stats are diff-vs-`HEAD`, staged + unstaged.** The shortstat is parsed textually; when it reports zero files (e.g. only untracked files exist) the file count falls back to the changed-files query, but insertions/deletions remain whatever the shortstat reported (zero in that case).
- **The detected-ticket heuristic prefers a Linear/Jira context item over the branch name.** It scans the first `L`/`J`-tagged context title first, then the branch. The literal `"L"`/`"J"` comparison is unchanged, but the tags it now compares against come from the shared source table (spec 313), where `J` is deliberately shared by Jira **and** the product's own memory-lookup source — so a Jolli Memory reference can be selected as the "detected ticket" when it sorts first. (Surprising; observed, not intended.)
- **The context list applies no visibility rule of its own.** Which plans, notes and references the next memory would claim is decided by the shared implementation and arrives as one answer, with the leave-out set riding along; this view renders it. A file-existence check that used to live here was a shared rule restated locally, and it would have gone stale the moment the commit path's own skip condition changed. There is no branch filter either — working-area items follow the reader across a checkout.
- **One row stands for every captured skill, and it is the only row with no key.** The collapse is deliberate (a session routinely enters a dozen skills and this list cannot absorb a dozen affordance-free rows), and every consequence follows from it: the toggle is all-or-nothing, the row reads as left-out only when every member is, and the bridge's presence-not-emptiness guard is what keeps the empty key from being dropped in transit. (Central design point.)
- **A partially-excluded skill set renders as included.** The next click then excludes the remainder rather than re-including what was already out, which is the only behaviour that cannot lose a reader's earlier decision through a row that shows one aggregate state for many items.
- **The skills row costs an extra round trip that the rest of the list does not.** Plans, notes, references and the leave-out set arrive together; skills are fetched separately, and deliberately not read off the raw registry, because a skill row survives archival and the raw map would present every skill ever used as pending.
- **External links escape the panel.** http/https navigation opens in the system browser; the embedded page never navigates away.
- **The Commit Memory bridge supplies an explicit project context.** Invoking the action from the embedded panel's own component context could resolve a null project; the host therefore builds the event with the project data context directly.
- **The page reuses the shared summary theme tokens** and layers working-memory-specific rules on top, so it visually matches the memory-summary and PR web views.
- **The pre-content blank page is theme-coloured, which is what removes the white flash on open.** The embedded browser keeps the previous document painted until the new one commits a frame, so colouring the blank page (and the hosting component) covers the whole parse-and-first-paint window. (Notable.)
- **This view's pre-load shell colour and its palette come from two settings that can disagree.** The shell colour is the live editor background; the light/dark palette is the widget theme's brightness flag. The memory-summary view (spec 120) derives both from one colour to make that impossible — this view does not. (Divergence; not yet closed here.)
- **Under a light widget theme this page is currently unreadable.** It borrows the memory-summary stylesheet, whose page-background variable is a parameter with a dark default, and passes only the light/dark flag — never a colour. The light palette therefore renders near-black text on a near-black page. The dark case looks right by coincidence of that default, and even there the page's background stops matching the pre-load shell colour whenever the editor scheme's background is not that same near-black. (Bug-shaped; the rendered reality is what is recorded here.)
- **This view is not pooled.** It constructs its own embedded browser instance and destroys it on disposal, unlike the memory-summary tab which borrows one from the project-scoped pool and hands it back. It is consequently not counted against that pool's capacity (spec 302). (Notable.)
- **The embedded-browser-unavailable fallback is inert.** When the browser cannot be created, only a static message is shown; no view is gathered, no bridge exists, and the Commit Memory path is unreachable from that tab.
- **The tab is always clean.** It never shows a dirty dot, never prompts on close, and is not restored across IDE restarts (no backing path).

## Shared Behavior

- **AI-commit action** — run by the Commit Memory button; its own spec.
- **Active-session aggregator** — supplies the conversation list.
- **Shared working-context answer** — supplies the plan / note / reference rows and the leave-out set in one round trip, and owns every rule about which of them the next memory would claim.
- **Skills projection and its aggregate label** (specs 319, 323) reached through the bridge adapter (spec 336) — supplies the single skills row and its title.
- **Exclusion selection store** (spec 188) — the destination of the leave-out toggle; the live CONTEXT panel (spec 132) writes the same keys and is refreshed directly by this view.
- **Git wrapper** — supplies the branch and the shortstat diff parsed for change stats.
- **Project service** — supplies the changed-files query, the working directory, and the status listener that drives reloads.
- **Shared summary CSS theme** — the base styling the page layers onto.
- **Producer logo resource set** — the inlined per-producer SVGs in the conversation rows.
- **Working Memory section container** — owns the Review button that opens this tab.
- **IDE editor manager** — performs identity-based tab reuse and routes the editor lifecycle.

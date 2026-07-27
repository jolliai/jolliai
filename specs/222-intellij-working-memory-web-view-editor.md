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
- The JS↔host bridge: the page calls a single host function with a JSON command; the host recognizes the `commitMemory` command and runs the AI commit on the UI thread.
- The reload-on-status-change behavior: the page is rebuilt off the UI thread and reloaded whenever project status changes.
- External-link handling: http/https navigations open in the system browser instead of inside the panel.
- The light/dark theming sourced from the IDE's current theme.

**Out of scope (boundaries):**

- The AI-commit action that the Commit Memory button runs — its own spec; this view only sends the command and invokes the action with an explicit project context.
- The active-session aggregator that supplies the conversation list — its own spec.
- The plans/notes/references registry that supplies the context list — its own spec.
- The git wrapper that supplies the current branch and the diff stats — its own spec; this view only calls it and parses the textual output.
- The changed-files query — owned by the project service.
- The shared summary CSS theme tokens reused by the page — owned by the summary-view styling; this view only layers extra rules on top.
- The per-producer logo SVG assets inlined into the page — owned by the icon resource set.
- The "Review" button that triggers the open — owned by the working-memory section container spec.

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
| context | Uncommitted plans and notes on the current branch plus all references (see below). |
| files | The changed-files query, each split into file name, directory, and a one-letter status (default `M`). |

### Context-list rules

For each entry in the plans/notes/references registry:

- **Plans**: skipped if ignored, already committed (has a commit hash), on a different non-blank branch, or whose source file no longer exists; otherwise added with tag `P`.
- **Notes**: skipped if ignored, already committed, or on a different non-blank branch; otherwise added with tag `N`.
- **References**: always added, with a tag by source — Linear `L`, Jira `J`, GitHub `GH`, Notion `No`.

### Rendered page (fixed structure and copy)

In order:

1. Title `Working Memory`.
2. Meta strip: branch · a `NOT COMMITTED` chip · stats `+<ins> −<del> · <N> file(s)`.
3. Intro paragraph explaining everything shown is included and nothing is committed until Commit Memory.
4. Proposed-title block: label `Proposed title` with an `AI` pill, the text "An AI-written commit message is generated when you commit.", and a grid line `Target commit next on <branch>` plus an optional `Detected ticket <id>`.
5. Token meter: the token label followed by `· captured by this memory`.
6. Conversations list (count badge), each row = inlined producer logo SVG (dark variant when available) + title + optional `<n> msg(s)`; empty row text `No active conversations in the last 2 days.`
7. Context list (count badge), each row = tag glyph + title; empty row text `No linked plans, notes, or references.`
8. Files list (count badge), each row = file name (monospace) + optional directory subline + a status glyph colored by status; empty row text `No changed files.`
9. Privacy note about transcripts staying in the repo.
10. Commit-note explaining the commit covers files only; conversations/context stay local.
11. A local-first note with a database glyph.
12. A full-width `Commit Memory` button.

### Bridge protocol

- The host injects a single global function the page can call with a string message.
- The page's Commit Memory button calls that function with `{"command":"commitMemory"}`.
- The host parses the message; on command `commitMemory` it runs the AI commit on the UI thread. Any parse failure is logged and ignored. The host always returns an `ok` response.

## Behavior

### Opening / building

1. The tab is created with the embedded-browser body.
2. The body builds the HTML from the gathered view and the current light/dark theme and loads it.
3. A status listener is registered so the page reloads on every status change.

If the embedded browser cannot be created, the body falls back to a read-only monospace text area reading that the preview requires the embedded browser; no further data gathering or bridge is set up.

### External links

A navigation handler intercepts http/https URLs and opens them in the system browser, cancelling the in-panel navigation; other URLs proceed normally.

### Reload on status change

On each status-change fire: rebuild the HTML off the UI thread, then reload it into the browser on the UI thread. If the browser is gone, the reload is skipped.

### Commit Memory

1. The page calls the bridge with `commitMemory`.
2. The host marshals to the UI thread and resolves the AI-commit action; if absent, nothing happens.
3. The host builds an action event with an explicit project data context (so the project resolves the same way it would from the tool window) and performs the action.

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
  context ← uncommitted plans + uncommitted notes (this branch) + all references
  detectedTicket ← ticket regex over L/J context title, else over branch, else null
  tokenLabel ← "N/A tokens"
  files ← changedFiles().map{name, dir, status}

[status change]
  off-UI: html ← buildHtml(...) ; on-UI: browser.loadHTML(html)

[page → bridge "commitMemory"]
  on-UI: action ← lookup AI-commit ; if null → no-op
         event ← createFromAnAction(action, project context)
         action.performed(event)

[disposed]
  removeStatusListener ; jsQuery.dispose() ; browser.dispose()
```

## Notable Behavior

- **There is exactly one Working Memory tab per project.** The virtual file's identity is a single constant, so every open collapses to the same tab.
- **The view is presentational and one-way.** It renders a snapshot; the only write path is the Commit Memory button, which runs the AI-commit action — the page itself edits nothing.
- **The token label is always `N/A tokens` here.** Live sessions in this surface carry no token usage; the real token count is captured only when the memory is generated at commit time.
- **Change stats are diff-vs-`HEAD`, staged + unstaged.** The shortstat is parsed textually; when it reports zero files (e.g. only untracked files exist) the file count falls back to the changed-files query, but insertions/deletions remain whatever the shortstat reported (zero in that case).
- **The detected-ticket heuristic prefers a Linear/Jira context item over the branch name.** It scans the first `L`/`J`-tagged context title first, then the branch.
- **Context excludes committed and cross-branch plans/notes, but never filters references.** A reference is always listed regardless of branch or commit state.
- **Plans are also dropped if their source file is gone; notes are not file-existence-checked.** The two kinds have slightly different visibility rules in the context gather.
- **External links escape the panel.** http/https navigation opens in the system browser; the embedded page never navigates away.
- **The Commit Memory bridge supplies an explicit project context.** Invoking the action from the embedded panel's own component context could resolve a null project; the host therefore builds the event with the project data context directly.
- **The page reuses the shared summary theme tokens** and layers working-memory-specific rules on top, so it visually matches the memory-summary and PR web views.
- **The embedded-browser-unavailable fallback is inert.** When the browser cannot be created, only a static message is shown; no view is gathered, no bridge exists, and the Commit Memory path is unreachable from that tab.
- **The tab is always clean.** It never shows a dirty dot, never prompts on close, and is not restored across IDE restarts (no backing path).

## Shared Behavior

- **AI-commit action** — run by the Commit Memory button; its own spec.
- **Active-session aggregator** — supplies the conversation list.
- **Plans/notes/references registry** — supplies the context list.
- **Git wrapper** — supplies the branch and the shortstat diff parsed for change stats.
- **Project service** — supplies the changed-files query, the working directory, and the status listener that drives reloads.
- **Shared summary CSS theme** — the base styling the page layers onto.
- **Producer logo resource set** — the inlined per-producer SVGs in the conversation rows.
- **Working Memory section container** — owns the Review button that opens this tab.
- **IDE editor manager** — performs identity-based tab reuse and routes the editor lifecycle.

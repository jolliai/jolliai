# IntelliJ Commits Panel

## Topic Statement

The COMMITS section of the JolliMemory tool window — a row-per-commit list that walks the current branch from `HEAD` back to its merge-base with `main`, rendering each commit as a collapsed card showing a title line, a sub-line with relative age / short hash / per-commit token spend, and a chips row with PR / sync / E2E status; expanding a card reveals four structured groups (SHIPPED, CONVERSATIONS, CONTEXT, FILES); a branch-level token-usage meter sits above the commit list; and a per-row checkbox drives a range-based selection used by the squash-multiple-commits flow.

## Scope

**In scope:**
- The commit range the panel walks: from the branch's own-commits base (the merge-base of `HEAD` and the project's main branch, then narrowed to the branch creation point) forward to `HEAD` (this is the unmerged-history, own-commits-only view).
- Per-row anatomy of the collapsed state: arrow, optional checkbox, title line (message + pushed badge + type badge), sub-line (relative date · short hash · token spend), chips row (PR chip, SYNCED/LOCAL chip, optional E2E chip), and "Show memory details" link.
- The expand-to-show-groups behavior: arrow flips, body expands, detail loads on first expand; the SHIPPED / CONVERSATIONS / CONTEXT / FILES four-group structure always renders with headers and empty-state rows.
- The lazy-load deduplication rule: concurrent expands of the same commit share a single in-flight bundle.
- The merged-mode behavior: when the branch's tip is reachable from `main`, the panel becomes a read-only history view (no checkboxes).
- The single-commit mode: when the branch contains exactly one commit beyond the merge-base, the checkbox is also hidden.
- The range-based checkbox semantics: clicking a row's checkbox checks (or unchecks) a contiguous run from the most recent commit down to that row.
- The "toggle select all" semantics for the section toolbar.
- Two panel-level open actions consumed by the action bar: a pre-existing "open the branch's most-recent memory" action (opens the newest memory-bearing commit's summary viewer, whose embedded per-commit Create-PR form still exists), and a new "open the branch-level Create-PR view" action.
- The branch-level token-usage meter: a bold total, an estimated-cost figure, a three-segment colored bar (input / output / cached), a legend, a partial-data callout, and an info popover.
- Per-commit token spend and estimated cost shown on the collapsed sub-line.
- Render-time pagination of the commit-row list itself: a fixed page size that grows per "Show N more" click and resets only when the listed commit-hash sequence changes (as opposed to every background refresh).
- The branch-level PR status lookup: fetched once per refresh from the `gh` CLI; drives the PR chip on every memory row and the SHIPPED group's PR entry.
- The PR history strip: closed/merged PRs for the branch are returned alongside the open PR in a single `gh pr list --state all` call.
- The hover popup (1 s delay, 200 ms grace): commit title, relative date with clock icon, optional type badge, file/insertion/deletion stats, short hash, optional "View Memory" link.
- The hover action icons (revealed on row hover): Pin, Copy recall prompt, Share — visible only for memory-bearing rows.
- The SHIPPED group: three fixed entries (PR, E2E guide, Synced to Jolli), each showing done/not-done state with distinct icon and chip.
- The CONVERSATIONS group: per-session rows with source badge, title, message count; on hover swaps to Open and optional Resume actions; resume is gated on the session file existing locally and the source being Claude.
- The CONTEXT group: plans (P), notes (N), and external references (L/J/GH/No tags), with clickable URL when available.
- The FILES group: per-file rows; single click opens the parent↔commit diff.
- The "Hide memory details" link at the bottom of expanded content and "Show memory details" link on the collapsed row.
- The click-to-open-summary behavior: clicking anywhere on the row body (not arrow, checkbox, or hover icons) opens the memory as an editor tab.
- The auto-refresh sources (status changes, project-level git-repo changes, VCS config changes) and the stale-result discard rule.
- The squash-transcript fallback: when a commit has no transcript of its own, its children's transcripts are aggregated for the CONVERSATIONS group.
- Foreign mode: read-only view of memories from a different repo/branch sourced from the local Memory Bank folder.

**Out of scope:**
- The ai-commit flow that consumes the selection (squash-multiple-commits) — separate spec.
- The contents of the embedded HTML summary view that opens when a row is clicked — separate spec.
- The Memories panel's flat memory list (this panel groups by commit; the Memories panel is a flat global view).
- The git plumbing that determines "is this branch fully merged into main" — abstracted as a project-service call.
- The cloud push that flips the sync state — owned by the cloud-API spec.
- The PR creation / update flows (triggered from the memory editor, not from the commits panel directly) — separate spec.
- The conversation-usage computation from transcripts (computed once at post-commit time; the panel reads and tree-aggregates the already-stored breakdown/cost fields from the memory) — separate spec.

## Data Contracts

### Commit range

The panel renders the commits that the branch has on top of `main` — that is, walking back from `HEAD` to the branch's own-commits base. The main-branch ref is resolved in priority order: `origin/main`, `upstream/main`, `main`. The range is inclusive of the branch tip, exclusive of the base. A branch that has not diverged from `main` (zero commits ahead) renders the empty-state message.

The base is **not** the plain merge-base with main: after computing the merge-base, the panel narrows it to the branch's own-commits base via the shared own-commits-base / branch-creation-point resolver (see below). This means a branch cut from a feature or release branch — including a brand-new branch that still shares its parent's tip — lists only its **own** commits, not the parent branch's shared history. When the narrowed base equals `HEAD` the branch has no own commits yet and the panel clears. This is what fixes committed memories from carrying over or clearing incorrectly on a freshly cut branch.

When on `main` itself and an `origin/main` ref exists, the range is `origin/main..HEAD` so locally committed but not yet pushed commits are visible.

When the merge-base equals `HEAD` (the branch tip is fully contained in the mainline), the panel takes one of two paths depending on whether the resolved mainline ref is an origin ref — this replaces an earlier, simpler description ("when the merge-base equals `HEAD` and no remote exists, the panel shows empty") that no longer matches the code:

- **Mainline ref is an origin ref** (e.g. `origin/main`): unchanged — the range is `<origin-ref>..HEAD` as above.
- **Mainline ref is not an origin ref** (it resolved to an upstream ref or the local `main`, i.e. no remote is configured): the panel enters a **merged-mode history view** instead of clearing. It resolves the branch's own creation point from the reflog and lists `<creation-point>..HEAD`, filtered to commits authored by the current git user. This is what lets a no-remote repo keep showing committed memories on `main` (or on a branch that has been fully merged) rather than an empty panel.

Merged mode requires two additional signals, both derived from the branch's reflog:

- **An "own-commit" signal**: at least one reflog entry must record an actual commit operation (as opposed to a branch-creation, checkout, rebase, reset, or pull entry). A branch/`main` whose reflog shows only creation/rebase/reset activity — never a commit of its own — has authored nothing, so the panel returns the empty state rather than crediting it with the mainline's history.
- **An author filter**: the current git user's configured name. If it is unset, the panel returns empty rather than showing an unfiltered (unscoped) history, because merged mode is author-scoped by design.

The reflog-derived creation point used as the range base: scan the reflog oldest→newest for an explicit "branch created from X" entry; if none is found, fall back to the oldest surviving reflog entry. Returns nothing (aborting merged mode entirely) for a detached HEAD or an empty/unavailable reflog.

Note this merged-mode base resolution is deliberately more permissive than the own-commits-base resolver below: it always falls back to the oldest surviving reflog entry when no explicit creation marker is found, whereas the own-commits-base resolver requires the explicit marker and refuses to guess. This is intentional, not an inconsistency — the fork-point narrowing below must never guess (a wrong guess would silently drop the branch's own first commit from the non-merged listing), while merged mode already gates on the own-commit signal and an author filter, so a slightly-approximate base is an acceptable trade there.

**Notable divergence from the VS Code sidebar (pre-existing, not introduced here):** VS Code's equivalent enters its merged-mode view whenever merge-base equals HEAD, with **no** origin carve-out — it applies the author filter even when a live origin remote exists. This panel's origin carve-out (an unfiltered range when an origin ref is present) is a partial port of that behavior — a genuine platform difference between the two tools, not a regression in this change.

### Own-commits-base resolver

A shared resolver narrows a mainline merge-base to the point where the branch was actually cut, so "own commits" are measured from the fork point rather than from mainline. Given the branch name and the mainline merge-base:

1. Find the branch's reflog creation point, requiring an **explicit** "created from" reflog entry (a guessed oldest-surviving entry is refused, because once the real creation entry has expired the oldest survivor is often the branch's own first commit — guessing it would silently drop that commit). If unavailable, fall back to the merge-base.
2. If the creation point equals the merge-base (cut directly from main), use the merge-base.
3. If the creation point is no longer an ancestor of `HEAD` (stale after a reset/rebase-onto), fall back to the merge-base.
4. If the mainline ref was unresolvable (empty merge-base), trust the validated creation point directly.
5. Otherwise adopt the creation point only when it sits downstream of the merge-base (the "cut from a release/develop branch" case); else use the merge-base.

The **same** resolver is reused by the branch-level Create-PR view's delta-base computation, so its diff stats and file list stay aligned with the exact commit set this panel lists (see the Create-PR-view spec).

### Per-commit row data

Each row's input fields:

| Field             | Meaning                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `hash`            | Full commit hash.                                                                                    |
| `shortHash`       | First 7 characters of the hash.                                                                      |
| `message`         | Commit subject line (no body).                                                                       |
| `author`          | Author name.                                                                                         |
| `date`            | Commit date in ISO-8601 form.                                                                        |
| `shortDate`       | Pre-formatted `MM-DD` string (locale-zone-aware).                                                    |
| `filesChanged`    | Total file count in the commit.                                                                      |
| `insertions`      | Total lines inserted.                                                                                |
| `deletions`       | Total lines deleted.                                                                                 |
| `hasSummary`      | `true` when a stored memory exists for this hash (including tree-hash aliases).                      |
| `isPushed`        | `true` when the commit is reachable from the branch's push base ref (upstream or `origin/<branch>`). |
| `commitType`      | `null` for regular commits; otherwise a label like `amend` or `squash`.                             |
| `tokenBreakdown`  | Conversation token breakdown (input / output / cached), tree-aggregated across the memory's whole consolidation tree; `null` when nothing in the tree recorded usage. |
| `estimatedCostUsd`| Estimated USD cost of the row's usage, per the cost rule below; `null` when nothing to price.       |
| `e2eScenarioCount`| Number of E2E test scenarios on this memory (0 = no guide).                                         |
| `isSyncedToJolli` | `true` when a Jolli Space doc ID or URL is stored on the memory.                                    |
| `jolliDocUrl`     | Direct URL to the Jolli Space article, when synced.                                                  |
| `conversationTurns`| Count of human turns across contributing conversations, from the stored summary.                   |
| `contextCount`    | Count of linked context items (plans + notes + references).                                          |

### Token usage data

The row's usage was previously read as a single legacy scalar token-usage object off the stored memory's root summary; that no longer matches the code. The row's usage is now the memory's canonical conversation-token breakdown (input / output / cached segments) plus an estimated cost, both **tree-aggregated** across the memory's whole consolidation tree rather than read off the root node alone. This fixes a real display bug: a squash/amend/rebase memory carries its tokens on the folded child nodes, not the root, so a shallow root-only read previously showed "N/A" on the list for exactly the memories whose detail view (which already aggregated the tree) showed real numbers.

- **Breakdown**: the sum of input / output / cache-creation tokens across every node in the tree. Cache-*read* is deliberately excluded everywhere in this pipeline (it is a cumulative per-turn running total, so summing it would double-count and inflate figures by an order of magnitude) — "cached" always means cache-creation.
- **Cost rule**: prefer the memory's stored per-model cost estimate, summed across the tree (a pure sum — no re-pricing, no fallback logic at the aggregation step itself); when no node in the tree carries a priced estimate (legacy or token-only memories that predate cost capture), fall back to a rough estimate priced at fixed list rates from the aggregated breakdown. This "prefer stored, else estimate" decision is made once, at the point each row's data is assembled — the per-row sub-line and the branch-level total below both simply consume (or, for the branch total, sum) that already-decided per-commit figure; neither re-derives a fallback estimate of its own.

When nothing in the tree recorded usage, the row's breakdown and cost are both `null`, and the commit's usage is not counted toward branch totals (see below).

### Branch token totals

The branch-level totals are computed by summing across all memory-bearing commits:

| Field              | Meaning                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `input`             | Sum of input tokens across commits with a recorded breakdown.                                  |
| `output`            | Sum of output tokens.                                                                           |
| `cached`            | Sum of cache-creation tokens (cache-read is excluded everywhere; see above).                    |
| `total`             | `input + output + cached`.                                                                      |
| `partial`           | `true` when any memory-bearing commit had no recorded breakdown.                                |
| `hasData`           | `true` when `total > 0` (gates bar + legend rendering).                                         |
| `estimatedCostUsd`  | Sum of each contributing commit's already-decided cost figure (see the cost rule above); `null` when no contributing commit carried a priced estimate — never re-derived at this level. |

Code-only commits (no memory) are ignored by the aggregation. A memory-bearing commit with no recorded breakdown sets `partial = true` but contributes no counts and no cost.

### Per-row collapsed layout

A commit row is a vertical stack:

1. **Top line** (`BorderLayout`): WEST = arrow + optional checkbox; CENTER = title + sub-line stacked vertically; EAST = hover action icons (initially hidden).
2. **Chips row** (right-aligned flow): optional PR chip, SYNCED or LOCAL chip, optional E2E chip.
3. **"Show memory details" link** (right-aligned, hidden while expanded).

The title label shows `<message>[<pushed-badge>][<type-badge>]` where the pushed badge is a space + cloud emoji and the type badge is ` [<type>]`. The sub-line shows `<relative-age> · <shortHash> · <N tokens>` (or `N/A tokens` when no breakdown is recorded), followed by `· <≈$cost>` when the row carries an estimated cost.

### Chips

| Chip          | When shown                             | Color  |
| ------------- | -------------------------------------- | ------ |
| `PR #N`       | Branch has an open PR                  | green  |
| `SYNCED`      | `isSyncedToJolli` is true              | green  |
| `LOCAL`       | `isSyncedToJolli` is false             | dim    |
| `E2E`         | `hasE2eGuide` is true                  | green  |

The PR chip is branch-level (identical value on every row that shows it); SYNCED/LOCAL and E2E are per-commit.

### Expanded groups

The expanded container holds four groups rendered by `renderExpandedGroups`, always in order:

1. **SHIPPED** — exactly three entries: PR status, E2E guide status, Synced-to-Jolli status. Done entries have full-color icon + click action; not-yet-done entries are dim with a descriptor chip and either no action or a link to the memory editor.
2. **CONVERSATIONS** — one row per committed conversation (source logo, title, message count). Empty state: `"<N turns> conversation turns (details not stored)"` or `"No conversations"`.
3. **CONTEXT** — one row per plan, note, or external reference. Tag chips: `P` (plan), `N` (note), `L` (Linear), `J` (Jira), `GH` (GitHub), `No` (Notion). Empty state: `"No linked context"`.
4. **FILES** — one row per changed file (file-type icon, filename, relative path, status badge). Empty state: `"No files"`.

Each group is preceded by a bold dim header `"<TITLE> (<count>)"` and a separator (except the first group). The total "Hide memory details" link is appended after the last group.

### PR lookup result (sealed)

`PrLookup` is a sealed result returned by the PR service for a branch:

| Variant        | Meaning                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| `Found`        | An open PR exists. Carries `PrInfo` (number, url, title, body) and a `history` list of closed/merged PRs for the branch. |
| `NoPr`         | No open PR. Carries only the `history` list.                                |
| `LookupError`  | The `gh` call failed or returned unparseable data. Carries a reason string. |

The `history` list in `Found` and `NoPr` contains closed/merged PRs for the branch sorted by number descending. Cross-repository (fork) PRs are filtered out. The history list is surfaced in the summary editor's PR section (separate spec); the commits panel uses only the `Found.pr` data.

### File-row data (inside an expanded commit's FILES group)

| Field          | Meaning                                                       |
| -------------- | ------------------------------------------------------------- |
| `relativePath` | Path relative to the repository root.                         |
| `oldPath`      | For renames: the previous path. Otherwise null.               |
| `statusCode`   | Single-letter porcelain code: `M`, `A`, `D`, `R`.             |

The file-row badge color: yellow = modified, green = added, red = deleted, blue = renamed; gray is the default for unmatched codes.

### Hover popup content

A native `JWindow` shown 1 s after the cursor enters a row, dismissed 200 ms after the cursor fully leaves both the row and the popup. Contains:

1. Commit message in bold.
2. Relative date with a clock icon (full form: "3 hours ago").
3. Commit type with a tag icon, when set.
4. Separator, then file/insertion/deletion stats (clauses omitted if zero).
5. Separator, then short hash in monospaced font with a node icon.
6. When `hasSummary`, a "View Memory" link that opens the memory editor tab and dismisses the popup.

### Selection state

A set keyed by commit hash, panel-local. Mutated only by:

- The per-row checkbox toggle (range rule).
- The section's "toggle select all" action.

Cleared automatically whenever the commit sequence changes (different hashes than last refresh).

### Single-commit / merged modes

| Condition                                | Effect                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `commits.size <= 1`                      | Checkboxes hidden on every row. Range selection not applicable.             |
| The branch is merged into main           | Checkboxes hidden on every row. The panel is a read-only history view.      |

### Empty / placeholder states

| Condition                                | Body                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| Status not yet loaded                    | "Initializing Jolli Memory..."                                             |
| Status loaded but the repository is not enabled | "Jolli Memory is not enabled for this repository." then, on a second line, "Open the Status panel to install hooks and enable it." |
| Branch has no commits ahead of main      | "Start coding — your commit memories will appear here. Every commit on this branch will be automatically summarized." |

The not-yet-loaded and not-enabled cases are now **two distinct states**, where they previously shared the initializing message. The split is deliberate: showing "Initializing…" for a repository that will never initialize because nothing is installed misled users into waiting for a background task that was not running. The disabled copy instead names the situation and points at the Status panel, where hooks can be installed.

## Behavior

### Initial render

On panel construction:

1. The panel registers a project-status listener.
2. It subscribes to the project-level git-repository-change channel with a 500 ms debounced refresh handler.
3. It subscribes to the VCS configuration change channel with the same 500 ms debounced handler (catches terminal branch operations).
4. It schedules a background "list branch commits" query and renders the initializing placeholder until the result arrives.

### Row creation rules

For each commit:

- The arrow label uses a right-pointing triangle when collapsed, down-pointing when expanded.
- The checkbox is created only when not in single-commit or merged mode; its initial selection is read from the panel's selection set.
- The title label is the commit message (or the short hash if the message is empty), with the cloud badge appended only if `isPushed`, the type badge appended only if `commitType` is non-null.
- The sub-line is always `<relative age> · <shortHash> · <N tokens>` where N is the row's token breakdown total formatted as compact (e.g. `61k`, `1.4M`) or the literal string `N/A tokens` when no breakdown is recorded, with `· <≈$cost>` appended when a cost estimate exists. The sub-line is always rendered; it does not depend on `hasSummary`.
- The chips row is always shown; on code-only commits it shows `LOCAL` and no PR or E2E chip.
- The "Show memory details" link is always present, right-aligned, and hidden while expanded.
- Hover action icons (Pin / Copy recall / Share) are created only for memory-bearing rows; they start hidden and reveal on hover.
- The row click listener opens the memory editor (no-op on non-memory commits); the arrow click listener toggles expand/collapse only.

### Token meter

The token meter is always rendered above the commit list (even when commits exist but none has recorded usage). Its structure:

1. A bold `"<N> tokens"` (or `"N/A tokens"` if `hasData` is false).
2. When a branch cost total exists, a dim `"· <≈$cost>"` figure next to the total (never rendered as `"≈$0.00"` — it's absent rather than zero when nothing is priced).
3. When `partial`, a dim `"· partial"` label to the right of the total (and cost, if present).
4. A circled `"?"` button that opens an info balloon explaining that the number is a lower bound (sources that don't report usage are excluded, as are older memories).
5. When `hasData`: a three-segment color bar proportional to `input / output / cached` widths, using fixed segment colors — input = green, output = grey, cache = blue — matching the same convention as the embedded summary viewer's own token/cost banner (see the embedded-HTML-viewer spec); a legend row showing each segment's value and label.

The token meter is not shown when the commit list is empty (empty-state placeholder replaces the entire content area).

### Click semantics

| Interaction                                        | Action                                           |
| -------------------------------------------------- | ------------------------------------------------ |
| Click on the arrow label                           | Toggle expand/collapse.                          |
| Click on the "Show memory details" link             | Toggle expand (same as arrow).                   |
| Click on the "Hide memory details" link             | Toggle expand (collapse).                        |
| Click anywhere else on the row (not checkbox, not hover icons) | Open the memory as an editor tab (if `hasSummary`). |
| Click on a hover action icon (Pin / Copy / Share)  | Execute that action.                             |
| Click on a file row inside an expanded commit      | Open the parent↔commit diff.                     |
| Click on a SHIPPED entry with an action             | Execute the linked action (browse PR URL, open memory editor, browse Jolli URL). |
| Click on a conversation row                        | Open the conversation content.                   |
| Click on a conversation's "Open" hover icon         | Open the conversation content.                   |
| Click on a conversation's "Resume" hover icon (Claude only, file present) | Open a new terminal tab and resume the session. |
| Click on a CONTEXT row title with a URL             | Open the URL in the system browser.              |

Note: there is no double-click-to-open-memory behavior. A single click on the row body opens the memory.

### Expand/collapse

Toggling expand:

1. Flips the per-row `isExpanded` state.
2. Switches the arrow icon.
3. Shows or hides the file container.
4. Toggles the visibility of the "Show memory details" link (hidden while expanded; the "Hide memory details" link at the bottom of the expanded content takes over).
5. If newly expanding and the detail has not been loaded yet, kicks off a background bundle load.

The first expand of a commit fetches a bundle containing: the full `CommitSummary`, the committed conversations (with squash-transcript fallback), and the changed files. Concurrent expands of the same commit share a single `CompletableFuture` (keyed by commit hash, populated atomically on first request). On failure, the cache entry is removed so a future expand can retry.

While the bundle is in flight, the container shows `"Loading..."`. On completion, `renderExpandedGroups` builds the four group sections. On failure, `"(failed to load)"` is shown.

### Squash-transcript fallback

When gathering conversations for the CONVERSATIONS group: if the commit has no transcript of its own and its `CommitSummary.children` is non-empty, the conversations from the child commits are aggregated instead. Aggregation dedupes by `"<source>|<sessionId>"` key, summing message counts for duplicates. Nested squashes are recursed.

### File-row click → diff

A single click on a file row inside an expanded commit opens a diff:

- Left content: `git show <commitHash>~1:<oldPath-or-relativePath>`. For status `A`, the left is empty.
- Right content: `git show <commitHash>:<relativePath>`. For status `D`, the right is empty.
- Tab title: `<relativePath> (<shortHash>)`. Diff labels: `<shortHash>~1` ↔ `<shortHash>`.

### Range-based checkbox toggle

Clicking a row's checkbox (when checkboxes are visible) toggles a contiguous run anchored at the row:

- If the row was already checked, the click unchecks **this row and all older commits** (this row through the end of the list).
- If the row was unchecked, the click checks **this row and all newer commits** (the top of the list through this row).

After mutating the selection set, every checkbox in the panel is re-synced from the set so the visible state is consistent.

This rule produces a contiguous "newest-N" selection that the squash-multiple-commits flow consumes.

### Toggle select all

The section's "toggle select all" toolbar action:

- No-op when `commits.size <= 1`.
- If every commit is currently selected, the selection is cleared.
- Otherwise, every commit is added to the selection set.

### PR lookup

After fetching the branch commits, the panel performs one `gh pr list --state all --head <branch>` call (off-EDT) to resolve the branch-level PR. The result is stored as `prLookup` and shared by all row renders for that refresh cycle.

The call is skipped when:
- The branch is not published (no `@{upstream}` and no `refs/remotes/origin/<branch>`).
- `gh` is not installed or not authenticated.

Note: published is detected via `@{upstream}` or the origin remote ref, **not** by whether the local tip is pushed. This means a branch that was pushed then locally amended still shows its PR chip.

Cross-repository (fork) PRs are filtered from the result.

### Auto-refresh

Three refresh sources, all running through the same `refresh()` entry point:

| Source                          | Reason it fires                                                          | Debounce |
| ------------------------------- | ------------------------------------------------------------------------ | -------- |
| Project status listener         | Enabled flag flipped, install completed, etc.                            | none (immediate) |
| Project-level git-repo change   | A commit landed, branch was switched, index was updated, rebase, amend.  | 500 ms   |
| VCS configuration change        | Catches branch operations performed in a terminal outside the IDE.       | 500 ms   |

The panel uses a monotonic version counter to discard stale background results: if a newer refresh started before the old one's query returned, the old result is dropped.

A second `forceRefresh()` entry point exists that bypasses the version-discard mechanism; it is used by the action bar when it needs a guaranteed update.

When the new commit list differs from the previous one (any change in the hash sequence), the selection set and the detail cache are cleared, and the visible page (below) resets to the base page size. The expand/collapse states are reset because the row list is rebuilt from scratch.

### Pagination

The commit-row list is paged at render time, independently of the underlying commit-range query (which always resolves and returns the full range in one pass — there is no query-level paging).

- **Page size**: a fixed number of rows (the same page size used by the per-commit expanded-group row caps, though this is a separate, list-scoped counter).
- **Growth**: each click on a "Show N more" row (appended below the last visible row whenever more commits remain) grows the visible count by one page size and re-renders the list.
- **Reset condition**: the visible count resets to the base page size **only** when the ordered commit-hash sequence differs from the previous refresh's sequence (the same condition that clears the selection set and detail cache — see Auto-refresh above). A background refresh that returns the identical hash sequence — for example, a summary completing for an already-listed commit, or a periodic status tick with no new commits — leaves the current page size untouched, so the user's "Show N more" progress survives content-identical refreshes and the list does not visually collapse while being read.

### Memory open path

Clicking the row body (when `hasSummary` is true):

1. Asynchronously fetch the full `CommitSummary` by commit hash.
2. On the UI thread:
   - If found, wrap in the summary virtual-file class and open it via the IDE's editor manager (reuses an existing tab when one is open for the same hash).
   - If not found, show an informational dialog: `"No summary found for <short-hash>"`.

### Hover popup

After the cursor has been inside a row for 1 s, a native popup window appears below the row. The popup has a 200 ms grace period on exit: moving from the row to the popup does not dismiss it. Moving fully outside both regions starts the grace timer.

### Foreign mode

When another panel (e.g. Memory Bank explorer) calls `setForeignMode(repo, branch)`, the panel switches to a read-only view of memories from that repo/branch, sourced from the local Memory Bank folder cache. The normal git-based commit list is replaced with a flat list of foreign memory rows (eye icon, title, relative date, copy-recall-prompt button). Clicking a row reads its `CommitSummary` JSON from the Memory Bank folder and opens it as a read-only summary editor tab.

`clearForeignMode()` restores normal operation and triggers a standard refresh.

## State Transitions

```
[panel construction]
  subscribe to status listener
  subscribe to git-repo change channel (debounced 500 ms)
  subscribe to VCS config change channel (debounced 500 ms)
  spawn initial background refresh

[refresh]
  if foreignMode → re-filter KB cache, re-render foreign list
  version++
  background: list branch commits, check is-merged, lookup branch PR
  on response:
    if version mismatch → discard
    if status == null → "Initializing Jolli Memory..."
    else if !status.enabled → "not enabled for this repository" placeholder
    else if commits.empty → empty-branch placeholder
    else:
      if hash sequence changed:
        clear selection
        clear detail cache
        reset visible page to base page size
      isMerged ← projectService.isBranchMerged()
      prLookup ← lookupBranchPr() [skipped if branch unpublished or gh unavailable]
      render token meter (always, above list)
      rebuild commit rows; reset row states (collapsed, details-not-loaded)

[user clicks arrow or "Show/Hide memory details"]
  toggle expand/collapse
  toggle "Show memory details" link visibility
  if expanding for the first time: kick off lazy bundle load (summary + conversations + files)

[user clicks row body (hasSummary)]
  fetch summary async → open summary editor tab

[user clicks a file row inside an expanded commit]
  open diff: parent ↔ commit for that file

[user clicks a checkbox on row at index i (not single-commit, not merged)]
  if row was checked → uncheck rows i..end
  if row was unchecked → check rows 0..i
  re-sync all checkbox visuals from selection set

[section toolbar: toggle select all]
  if commits.size <= 1: no-op
  else if all selected: clear selection
  else: select all
  re-sync visuals

[user clicks PR chip]
  opens the PR URL in the system browser (via SHIPPED group row action)

[user hovers a row for 1 s]
  show hover popup below the row

[user moves cursor fully off row and popup for 200 ms]
  dismiss hover popup

[user clicks "View Memory" in hover popup]
  dismiss popup, open summary editor tab

[conversation row hover]
  hide message count; show Open + optional Resume action icons

[conversation row click or Open icon click]
  open conversation content in editor

[Resume icon click (Claude only, file present)]
  open terminal tab and resume session

[hash sequence changes (rebase, amend, branch switch, new commit)]
  clear selection; clear detail cache; reset visible page to base page size; rebuild rows

[setForeignMode(repo, branch)]
  switch to read-only KB view

[clearForeignMode()]
  restore normal commit view, refresh

[panel disposed]
  unsubscribe; cancel debounce timer; dismiss hover popup
```

## Notable Behavior

- **The range is `merge-base ↔ HEAD`, not "all branch commits".** Commits reachable from `main` are not shown; the panel is the unmerged-history view.
- **Token meter is always shown when there are commits.** Even when every commit has no recorded breakdown, the meter renders `"N/A tokens"` without a bar, so the panel's structure is consistent. The meter is absent only when the list is empty (placeholder replaces the content area).
- **Per-commit token spend and cost appear on the sub-line of every row.** Neither is gated on `hasSummary`; a code-only commit's sub-line still shows `"N/A tokens"` so the layout is uniform. Cost is never shown for a row/branch with no priced estimate — the UI omits it rather than showing a misleading `"≈$0.00"`.
- **Cost is decided once, then only summed.** The "prefer stored per-model estimate, else a rough estimate at fixed list rates" decision happens once per commit at the point row data is assembled. The per-row sub-line and the branch-total aggregator downstream never re-derive that decision — the branch total is a pure sum of each contributing commit's already-decided figure.
- **Token-bar segment colors are fixed and consistent with the embedded summary viewer:** input = green, output = grey, cache = blue, in both this meter and the per-commit detail view's own token/cost banner (embedded-HTML-viewer spec).
- **The `partial` flag is a lower-bound signal, not an error.** It is set when a source (e.g. Cursor) does not report usage, or when old memories predate usage capture. The "· partial" label and the info popover communicate this explicitly.
- **No-remote merged mode is a genuine alternate path, not an empty fallback.** When the resolved mainline ref is not an origin ref and the merge-base equals HEAD, the panel resolves the branch's own reflog creation point and lists the current user's own commits from there — rather than clearing — so a no-remote repo (or `main` itself) still shows committed memories. It requires both a reflog "own-commit" signal and a resolvable git user name; missing either clears the panel rather than over-listing. (Notable; fixes a previously-empty no-remote case.)
- **The IntelliJ origin carve-out is a pre-existing, partial divergence from VS Code, not a new one.** VS Code's equivalent merged-mode view applies its author filter unconditionally (no origin carve-out); this panel skips merged mode (and the author filter) whenever the mainline ref is a live origin ref. This is a genuine platform difference that predates this pass — record it as notable, not as a regression.
- **Commit-list pagination is render-time only and independent of the git-log query.** The underlying commit-range query always resolves and returns the full listed range; only the number of rows the panel *renders* is paged, starting at a fixed page size and growing by that same increment on each "Show N more" click. The page size resets to the base page size only when the ordered commit-hash sequence differs from the previous refresh — a content-identical background refresh (e.g., a summary landing on an already-listed commit, or a periodic status tick) leaves the user's current page untouched so the list doesn't visually snap shut mid-read.
- **Branch PR lookup runs once per refresh.** A single `gh` call resolves the open PR and the closed-PR history strip for the branch; the result is reused by all row chips and the SHIPPED group. This avoids one `gh` spawn per memory row.
- **PR lookup is gated on branch being published, not on commits being pushed.** A branch that was pushed then locally amended retains its PR chip because the PR lives on the remote; gating on pushed commits would wrongly hide the chip after a squash.
- **The `PrLookup` result is a sealed type.** `Found` / `NoPr` / `LookupError` replace the previous single nullable PR result; `NoPr` and `Found` both carry a `history` list of closed/merged PRs for the branch.
- **Merged mode is read-only.** When the branch has been fully merged into main, checkboxes vanish. Expand, click-to-open-summary, and hover popup still work.
- **Single-commit mode also hides checkboxes.** A range squash with one commit is meaningless.
- **Range checkboxes produce only newest-N selections.** A click on the third row checks rows 0–2 or unchecks rows 2–end. Only "toggle select all" produces a full-set shape (all-or-nothing), which is by construction contiguous.
- **The selection clears the moment the hash sequence changes.** A rebase or amend invalidates whatever was selected before; the panel does not try to map old-hash selection onto new-hash rows.
- **Detail bundle loads lazily and concurrently safely.** Two near-simultaneous expands of the same commit share one query. The cache survives until the hash sequence changes. A failed load removes the cache entry so the next expand retries.
- **All four expanded groups always render.** An empty CONVERSATIONS, CONTEXT, or FILES group shows a plain-text placeholder row rather than being absent. This ensures the expanded panel has consistent structure across commits.
- **The "Show memory details" / "Hide memory details" links are the primary expand toggle for most users.** The arrow also works; both call the same `toggleExpand` handler.
- **A single click on the row body opens the memory.** There is no double-click-to-open path; that affordance was removed. The eye icon has been replaced by the row-body click and the "View Memory" hover popup link.
- **Hover action icons are initially hidden.** Pin / Copy recall prompt / Share appear only while the cursor is inside the row bounds, and only for memory-bearing rows. Leaving the row hides them again, with a bounds-check to avoid flickering when moving between child components.
- **The squash-transcript fallback is transparent to the user.** When a squashed commit has no direct transcript, the CONVERSATIONS group aggregates the child commits' sessions. Deduplication is by session key; message counts are summed across children.
- **Foreign mode is a full panel takeover.** When active, all normal git-based rendering is bypassed; the panel shows a read-only flat list from the Memory Bank folder. Refreshes re-filter the in-memory KB cache without hitting git.
- **File-row diff content is always sourced from `git show`, both sides.** Unlike the Changes panel (which pulls the working-tree side from VFS), the Commits panel diffs historical revisions where there is no "working tree" notion.
- **The empty-branch placeholder is two-line marketing copy.** It prompts the user to start coding; this is the only placeholder with that tone.
- **Every index-, alias- and tree-level computation in this panel is a cross-process round-trip.** Alias resolution, root-hash walking, the "which of these commits have a memory" filter, the tree-hash alias scan, and the whole tree aggregation (diff stats, turns, tokens, breakdown, cost, topic count, source nodes, duration) are all served by the shared implementations over a bridge action, not computed in the host process. Two consequences: a rendering pass costs a set of round-trips that scales with the commit list, and each of them can fail as a transport error rather than a data error.
- **Tree aggregation is memoized per memory document.** The many per-tree figures a row needs are collapsed into **one** round-trip per unique memory, cached in a small fixed-capacity access-ordered cache keyed on the serialized memory. The cache is mutated under a lock while the round-trip itself runs outside it, so two rows asking about the same memory concurrently may both issue the call — correct, just occasionally redundant. Because the key is the serialized memory, any edit to a memory invalidates its entry naturally.
- **The "prefer the stored price, else fall back to the standard mid-tier rate" cost rule is still computed in the host process.** When no node in a tree carries a priced estimate, the host applies its own fallback rate. That is the one piece of cost logic that did not move to the shared implementation, so it is the one place where this surface's cost figure can diverge from another surface's.
- **The memory bodies themselves are still read natively.** The panel resolves *which* memories exist through bridged index and alias operations, then fetches each body with a direct in-process read of the memory ref. So the enumeration honors the shared index while the content always comes off the orphan branch, regardless of the configured storage mode.
- **File-row diff sourcing is unchanged and native.** Historical revisions are read with direct in-process show-at-revision calls, as before.
- **The commit range is measured from the fork point, not the mainline merge-base.** Narrowing the merge-base to the own-commits base via the shared resolver is what prevents a branch cut from a feature/release branch (or a brand-new branch still at its parent's tip) from inheriting the parent branch's commits as its own. The narrowed base equalling `HEAD` clears the panel. (Notable; fixes carry-over/clearing on a new branch.)
- **The bottom action bar's "Create PR" button opens the branch-level Create-PR view, not a single memory.** It calls the panel's new open-Create-PR-view action, which aggregates every committed memory on the branch into one draft (see the Create-PR-view spec). The older per-memory path — opening the newest memory's summary viewer with its embedded per-commit form — still exists as a distinct action. (Notable.)

## Cross-topic Boundaries

- **Conversation-usage computation** (writing the token breakdown, per-model usage, and estimated cost onto the stored memory) is performed at post-commit time by the summarization pipeline (post-commit-pipeline spec), not by the commits panel. The panel reads the already-stored, tree-aggregatable fields. This is out of scope here.
- **PR history strip** (`PrHistoryEntry` list on `NoPr`/`Found`) is carried through the data contract but rendered only in the summary editor's PR section, not in the commits panel itself. The commits panel consumes only `Found.pr` for the chip.
- **The Memories panel** (a separate "Committed Memories" panel in the tool window, distinct from the Commits panel) has its own token meter and evidence groups redesign. Those specs are separate topics; the Commits panel described here is the branch-scoped panel under the COMMITS section header, not the global Memories panel.

## Shared Behavior

- **Project status surface** — feeds the `enabled` flag the panel keys its placeholders on.
- **Project service** — owns "list branch commits" (with memory enrichment), "list commit files", "is branch merged", "fetch memory by hash", "get committed conversations". Its memory-enrichment step is a hybrid: index / alias / tree work is delegated over a bridge action, memory bodies are read natively off the memory ref.
- **Summary index and summary-tree implementations** — the shared owners of alias resolution, root-hash walking, the have-a-memory filter, the alias scan, and every tree aggregation this panel renders. The host holds only a small memoization cache over them and the mid-tier-rate cost fallback.
- **PR service** — owns `gh` interaction, `findPrForBranch`, the sealed `PrLookup` result.
- **Git operations bridge** — runs `git show <ref>:<path>` for the diff branches.
- **Summary virtual-file wrapper** — the surface that the row-click open path lands on.
- **IDE diff viewer** — the destination for click-on-file-row.
- **IDE terminal** — the destination for the Resume session action (Claude only).
- **Squash-multiple-commits flow** — the consumer of the panel's range selection.
- **Section toolbar** — the surface where "toggle select all" and "refresh" actions are anchored.
- **Memory Bank folder cache** — the data source for foreign mode.
- **Own-commits-base / branch-creation-point resolver** — used to narrow the listed commit range to the branch's own commits; the same resolver aligns the Create-PR view's diff stats (Create-PR-view spec).
- **Branch-level Create-PR view** — the destination of the action bar's Create-PR button, opened via this panel's open-Create-PR-view action (Create-PR-view spec).
- **Post-commit summarization pipeline** — the write-time source of the token breakdown, per-model usage, and estimated cost every row and the branch meter here read and tree-aggregate (post-commit-pipeline spec).

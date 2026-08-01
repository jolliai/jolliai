# IntelliJ Commits Panel

## Topic Statement

The COMMITS section of the JolliMemory tool window — a row-per-commit list that walks the current branch from `HEAD` back to its merge-base with `main`, rendering each commit as a collapsed card showing a title line, a sub-line with relative age / short hash / per-commit token spend, and a single affordance row carrying the cloud-sync chip, a compact overflow chip standing in for the remaining status chips, and the expand link; expanding a card reveals four structured groups (SHIPPED, CONVERSATIONS, CONTEXT, FILES); a branch-level token-usage meter sits above the commit list; and a transient, opt-in **squash-selection mode** reveals per-row checkboxes plus a control strip, driving the range-based selection the squash-multiple-commits flow consumes.

## Scope

**In scope:**
- The commit range the panel walks: from the branch's own-commits base (the merge-base of `HEAD` and the project's main branch, then narrowed to the branch creation point) forward to `HEAD` (this is the unmerged-history, own-commits-only view) — and the single alternate range used when the branch tip is already fully contained in the mainline.
- Per-row anatomy of the collapsed state: arrow, optional checkbox (squash-selection mode only), a memory-present glyph on memory-bearing rows, title line (optional memory reference chip + message + pushed badge + type badge), sub-line (relative date · short hash · token spend), and one full-width affordance row (cloud-sync chip + optional overflow chip + the hidden-at-rest status chips + expand link).
- The expand-to-show-groups behavior: arrow flips, body expands, detail loads on first expand; the SHIPPED / CONVERSATIONS / CONTEXT / FILES four-group structure always renders with headers and empty-state rows.
- The lazy-load deduplication rule: concurrent expands of the same commit share a single in-flight bundle.
- **Squash-selection mode**: the transient, opt-in state that reveals the row checkboxes and inserts a control strip between the token meter and the row list; how it is entered, what it clears, and every way it ends.
- The merged-mode behavior: when the branch's tip is reachable from `main`, the panel becomes a read-only history view (checkboxes can never be shown, and selection mode refuses to open).
- The single-commit mode: when the branch contains exactly one commit beyond the merge-base, checkboxes can never be shown either.
- The range-based checkbox semantics (inside selection mode only): clicking a row's checkbox checks (or unchecks) a contiguous run from the most recent commit down to that row.
- The two-step "toggle select all" semantics for the section toolbar.
- Two panel-level open actions consumed by the action bar: a pre-existing "open the branch's most-recent memory" action (opens the newest memory-bearing commit's summary viewer, whose embedded per-commit Create-PR form still exists), and a new "open the branch-level Create-PR view" action.
- The branch-level token-usage meter: a bold total, an estimated-cost figure, a branch scope label shown only when there is data, a partial-data callout, a right-edge help affordance whose hover and click both give the full explanation, a three-segment colored bar (input / output / cached), and a legend with rounded-square markers.
- Per-commit token spend and estimated cost shown on the collapsed sub-line.
- Render-time pagination of the commit-row list itself: a fixed page size that grows per "Show N more" click and resets only when the listed commit-hash sequence changes (as opposed to every background refresh).
- The branch-level PR status lookup: requested once per refresh, served through a shared short-lived cache in front of the `gh` CLI; drives the PR chip on every memory row and the SHIPPED group's PR entry.
- The PR history strip: closed/merged PRs for the branch are returned alongside the open PR in a single `gh pr list --state all` call.
- The hover action icons (revealed on row hover): Pin, Copy recall prompt, View memory — visible only for memory-bearing rows, with their horizontal space reserved while hidden.
- The SHIPPED group: three fixed entries (PR, E2E guide, Synced to Jolli), each showing done/not-done state with distinct icon and chip.
- The CONVERSATIONS group: per-session rows with source badge, title, message count; on hover swaps to Open and optional Resume actions; resume is gated on the session file existing locally and the source being Claude.
- The CONTEXT group: plans (P), notes (N), and external references (single-letter tags from the shared source-presentation table, spec 313), with clickable URL when available and an archived-Markdown source view when not.
- The FILES group: per-file rows; single click opens the parent↔commit diff.
- The "Hide memory details" link at the bottom of expanded content and the "Show memory details" link that rides the collapsed row's affordance row.
- The click-to-open-summary behavior: clicking anywhere on the row body (not arrow, checkbox, overflow chip, or hover icons) shows the memory in the project's single shared memory tab.
- The auto-refresh sources (status changes, project-level git-repo changes, VCS config changes) and the stale-result discard rule.
- The squash-transcript fallback: when a commit has no transcript of its own, its children's transcripts are aggregated for the CONVERSATIONS group.
- Foreign mode: read-only view of memories from a different repo/branch sourced from the local Memory Bank folder.

**Out of scope:**
- The ai-commit flow that consumes the selection (squash-multiple-commits) — separate spec (299). In particular, *which activation of the Squash action* turns selection mode on, the action's own enablement rules, and when it switches the mode back off are owned there; this spec owns what the mode looks like and what it does to the panel's own state.
- The shared short-lived PR-status cache the branch lookup now goes through — its keying, its lifetimes, its dedup-under-contention behavior, and its invalidation are owned by spec 309. Only what this panel asks of it and what it gets back are in scope here.
- The shared single-memory-tab opener that the row-open path now hands off to — the one-tab-per-project contract and the content-swap mechanics are owned by spec 121.
- The branch-level Create-PR view's own open path (its two-stage load and its tab-matching rules) — owned by the Create-PR-view spec, even though the action lives on this panel.
- The contents of the embedded HTML summary view that opens when a row is clicked — separate spec.
- The memory reference identifier's format, its "only when pushed" presence rule on a list row, its hover hint, its clipboard payload, its confirmation balloon, and its exclusion from the row's open-on-click behaviour — owned by spec 301. Only the chip's slot in this row's geometry is in scope here.
- The Memories panel's flat memory list (this panel groups by commit; the Memories panel is a flat global view).
- The git plumbing that determines "is this branch fully merged into main" — abstracted as a project-service call.
- The cloud push that flips the sync state — owned by the cloud-API spec.
- The PR creation / update flows (triggered from the memory editor, not from the commits panel directly) — separate spec.
- The conversation-usage computation from transcripts (computed once at post-commit time; the panel reads and tree-aggregates the already-stored breakdown/cost fields from the memory) — separate spec.

## Data Contracts

### Commit range

The panel renders the commits that the branch has on top of `main` — that is, walking back from `HEAD` to the branch's own-commits base. The main-branch ref is resolved in priority order: `origin/main`, `upstream/main`, `main`. The range is inclusive of the branch tip, exclusive of the base. A branch that has not diverged from `main` (zero commits ahead) does **not** simply render the empty-state message — it falls into the merged-mode history view described below, and only clears when that mode's own requirements are unmet.

The base is **not** the plain merge-base with main: after computing the merge-base, the panel narrows it to the branch's own-commits base via the shared own-commits-base / branch-creation-point resolver (see below). This means a branch cut from a feature or release branch — including a brand-new branch that still shares its parent's tip — lists only its **own** commits, not the parent branch's shared history. When the narrowed base equals `HEAD` the branch has no own commits yet and the panel clears. This is what fixes committed memories from carrying over or clearing incorrectly on a freshly cut branch.

When the merge-base equals `HEAD` (the branch tip is fully contained in the mainline — the user is on `main` itself, or on a branch that has been fully merged), there is exactly **one** path, regardless of whether the resolved mainline ref is a remote-tracking ref: the panel enters a **merged-mode history view** instead of clearing. It resolves the branch's own creation point from the reflog and lists `<creation-point>..HEAD`, filtered to commits authored by the current git user. This is what lets `main` (or a fully-merged branch) keep showing committed memories rather than an empty panel — whether or not a remote is configured, and whether or not the local tip is already pushed.

Merged mode requires two additional signals, both derived from the branch's reflog:

- **An "own-commit" signal**: at least one reflog entry must record an actual commit operation (as opposed to a branch-creation, checkout, rebase, reset, or pull entry). A branch/`main` whose reflog shows only creation/rebase/reset activity — never a commit of its own — has authored nothing, so the panel returns the empty state rather than crediting it with the mainline's history.
- **An author filter**: the current git user's configured name. If it is unset, the panel returns empty rather than showing an unfiltered (unscoped) history, because merged mode is author-scoped by design.

The author filter is applied as a **literal substring** match, not as a pattern match, so a configured name containing pattern metacharacters (`J. Doe (Acme)`) matches the intended commits instead of erroring or matching the wrong ones. The switch into literal matching is **global to that one listing invocation** — it retunes every pattern-taking operand in the same call, not just the author one. Today the author filter is the only such operand, so the switch is safe; adding a second pattern-taking operand (a message filter, a committer filter) alongside it would silently make that one literal too.

The reflog-derived creation point used as the range base: scan the reflog oldest→newest for an explicit "branch created from X" entry; if none is found, fall back to the oldest surviving reflog entry. Returns nothing (aborting merged mode entirely) for a detached HEAD or an empty/unavailable reflog.

Note this merged-mode base resolution is deliberately more permissive than the own-commits-base resolver below: it always falls back to the oldest surviving reflog entry when no explicit creation marker is found, whereas the own-commits-base resolver requires the explicit marker and refuses to guess. This is intentional, not an inconsistency — the fork-point narrowing below must never guess (a wrong guess would silently drop the branch's own first commit from the non-merged listing), while merged mode already gates on the own-commit signal and an author filter, so a slightly-approximate base is an acceptable trade there.

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

The per-commit change statistics (`filesChanged` / `insertions` / `deletions`) come from the **same single listing invocation** that produces the metadata, rather than one additional child process per listed commit. A commit for which the listing emits no statistics line at all — a commit whose diff is empty — keeps zeros for all three. One incidental consequence: a repository's very first commit now reports its real statistics, where the previous per-commit comparison against a non-existent parent always failed and left zeros.

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

A commit row is a vertical stack of **two** lines (it was three before; the separate expand-link line is gone):

1. **Top line**: WEST = arrow + optional checkbox + optional memory-present glyph; CENTER = title (optionally prefixed by the memory reference chip) + sub-line stacked vertically; EAST = hover action icons (initially hidden, but their space reserved).
2. **Affordance row** (one full-width line, hidden entirely while expanded): the SYNCED-or-LOCAL cloud chip pinned to the left edge; then, only when there is something to reveal, a compact overflow chip; then the overflow chip's hidden-at-rest chips in place; then the "Show memory details ▾" link pinned to the right edge.

The **memory-present glyph** is a small link-coloured block sitting between the arrow/checkbox and the title, rendered **only** on memory-bearing rows. It is the row's at-rest "this commit has a memory" cue — the one signal that does not require hovering or expanding.

The title label shows `<message>[<pushed-badge>][<type-badge>]` where the pushed badge is a space + cloud emoji and the type badge is ` [<type>]`. The sub-line shows `<relative-age> · <shortHash> · <N tokens>` (or `N/A tokens` when no breakdown is recorded), followed by `· <≈$cost>` when the row carries an estimated cost.

A memory row that has been pushed to a Space additionally carries a clickable **memory reference chip** ahead of the title. The identifier's format, the strict "only when pushed" rule that governs whether the chip appears at all, its hover hint, its clipboard payload, its confirmation balloon, and its exclusion from the row's open-on-click behaviour are all owned by spec 301 and are not restated here. What this panel owns is the chip's place in the row's geometry: the chip occupies a **leading slot pinned to the top** of the title area, with the wrapping title beside it, so a commit message that wraps onto further lines hang-indents under the first character of its own first line rather than running back underneath the chip. The row's height computation subtracts the chip's width from the width it hands the wrapping title; without that subtraction the title's last line clips.

### Chips

| Chip          | When shown                             | Color  | At rest |
| ------------- | -------------------------------------- | ------ | ------- |
| `SYNCED`      | `isSyncedToJolli` is true              | green  | Visible, pinned to the row's left edge. |
| `LOCAL`       | `isSyncedToJolli` is false             | dim    | Visible, pinned to the row's left edge. |
| `PR #N`       | Branch has an open PR                  | green  | **Hidden** behind the overflow chip. |
| `E2E`         | `hasE2eGuide` is true                  | green  | **Hidden** behind the overflow chip. |
| `+N` overflow | Only when at least one of the hidden chips applies (`N` = how many) | dim | Visible. |

The PR chip is branch-level (identical value on every row that shows it); SYNCED/LOCAL and E2E are per-commit.

Only the cloud chip (SYNCED or LOCAL) is shown at rest. The PR and E2E chips are built but start hidden; the overflow chip stands in for them, and clicking it reveals them **in place** on that row and removes the overflow chip itself. The reveal is per-row and **not remembered** — any rebuild of the row list (a new commit, an amend, the asynchronous PR re-paint, a "Show N more" click) puts every row back to the collapsed-chip state.

A direct consequence: **a reader scanning the list cannot tell at a glance which commits have an end-to-end guide, or that the branch has a pull request at all.** Both facts now require a per-row click on the overflow chip, or expanding the row into its SHIPPED group.

### Expanded groups

The expanded container holds four groups, always in order:

1. **SHIPPED** — exactly three entries: PR status, E2E guide status, Synced-to-Jolli status. Done entries have full-color icon + click action; not-yet-done entries are dim with a descriptor chip and either no action or a link to the memory editor.
2. **CONVERSATIONS** — one row per committed conversation (source logo, title, message count). Empty state: `"<N turns> conversation turns (details not stored)"` or `"No conversations"`.
3. **CONTEXT** — one row per plan, note, or external reference. Plans and notes carry the outlined dim chips `P` and `N`. Reference rows do **not** use a local tag table: the tag letter and its colour both come from the shared source-presentation table (spec 313), which is single-letter across all twelve sources — `L` Linear, `J` Jira, `G` GitHub, `N` Notion, `S` Slack, `J` Jolli Memory, `7` Context7, `C` Confluence, `A` Asana, `M` monday.com, `Z` Zoom Doc, `Z` Zoom Meeting — with a neutral `R` for a source this surface's enum does not yet cover. Empty state: `"No linked context"`.

   The reference chip is also a **different widget**: plans and notes render the outlined dim chip, while a reference row passes the source's brand colour through and gets a **filled, rounded, brand-coloured badge** with bold white text instead — the same visual weight the sibling VS Code surface paints. The distinction is made by whether a colour is supplied: supplying one selects the filled badge, omitting one selects the outlined chip. (Corrected: this spec previously listed a single outlined chip set including the two-letter tags `GH` and `No`; neither the two-letter form nor the uniform outlined chip survives.)
4. **FILES** — one row per changed file (file-type icon, filename, relative path, status badge). Empty state: `"No files"`.

Each group is preceded by a bold dim header `"<TITLE> (<count>)"`. There are **no separator lines between groups any more** — the groups are separated by spacing alone (each header after the first gets a little more room above it than the first one does), and the header font is a touch smaller than before. The effect is a calm block rather than a bordered card. The total "Hide memory details" link is appended after the last group.

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

### Squash-selection mode

A transient, panel-local on/off state. It is the **only** state in which row checkboxes exist.

Entering it:

- Reveals a checkbox on every visible row.
- **Clears any prior selection**, so the reader is never handed a set of already-checked commits they did not opt into.
- Inserts a **control strip** between the token-usage meter and the row list, carrying, left to right:
  - a live count reading `"<N> memories selected"` once two or more are checked, and otherwise telling the reader to pick two or more (with the current count in parentheses);
  - a **Squash** control, disabled while fewer than two are checked;
  - a **Cancel** control that exits the mode and drops the selection.
- Both the count and the Squash control's enabled state are re-synced on every selection change, so the strip never lags the checkboxes.

It refuses to open at all — and the strip is never inserted — when the branch is merged into the mainline or the branch has fewer than two commits.

Leaving it (by Cancel, or automatically once a squash operation finishes) hides the checkboxes and the strip and **clears the selection again**.

Because the selection is cleared on both entry and exit, no selection exists while the mode is off — which is to say, no selection can exist while the checkboxes are hidden at rest.

### Selection state

A set keyed by commit hash, panel-local. Mutated only by:

- The per-row checkbox toggle (range rule) — reachable only inside selection mode.
- The section's "toggle select all" action — and only on its *second* activation (see below).
- Entering and leaving selection mode, both of which clear it.

Cleared automatically whenever the commit sequence changes (different hashes than last refresh). That clear does **not** turn selection mode off: the checkboxes stay up, emptied.

### Modes that suppress checkboxes

| Condition                                | Effect                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| Selection mode is off (the resting state) | Checkboxes hidden on every row. This is what the reader sees by default.   |
| `commits.size <= 1`                      | Checkboxes never shown. Range selection not applicable, and selection mode cannot be entered. |
| The branch is merged into main           | Checkboxes never shown. The panel is a read-only history view, and selection mode cannot be entered. |

### Empty / placeholder states

| Condition                                | Body                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| Status not yet loaded                    | "Initializing Jolli Memory..."                                             |
| Status loaded but the repository is not enabled | "Jolli Memory is not enabled for this repository." then, on a second line, "Open the Status panel to install hooks and enable it." |
| The listing returned no commits (no own commits and no usable merged-mode history) | "Start coding — your commit memories will appear here. Every commit on this branch will be automatically summarized." |

The not-yet-loaded and not-enabled cases are now **two distinct states**, where they previously shared the initializing message. The split is deliberate: showing "Initializing…" for a repository that will never initialize because nothing is installed misled users into waiting for a background task that was not running. The disabled copy instead names the situation and points at the Status panel, where hooks can be installed.

## Behavior

### Initial render

On panel construction:

1. The initializing placeholder is painted **synchronously**, on the UI thread, as part of construction — so the panel's very first frame is never blank while a background listing runs.
2. The panel registers a project-status listener.
3. It subscribes to the project-level git-repository-change channel with a 500 ms debounced refresh handler.
4. It subscribes to the VCS configuration change channel with the same 500 ms debounced handler (catches terminal branch operations).
5. It launches an initial background "list branch commits" query **only when no status snapshot exists yet**. Registering the status listener already fires an immediate callback whenever a snapshot is cached (see the project-service spec), and that callback schedules a refresh of its own — so launching one unconditionally meant two refreshes racing, with one full listing round-trip computed and then discarded.

### Row creation rules

For each commit:

- The arrow label uses a right-pointing triangle when collapsed, down-pointing when expanded.
- The checkbox is created only when selection mode is on **and** the panel is not in single-commit or merged mode; its initial selection is read from the panel's selection set.
- The memory-present glyph is created only when `hasSummary`, and sits after the arrow/checkbox.
- The title label is the commit message (or the short hash if the message is empty), with the cloud badge appended only if `isPushed`, the type badge appended only if `commitType` is non-null.
- The sub-line is always `<relative age> · <shortHash> · <N tokens>` where N is the row's token breakdown total formatted as compact (e.g. `61k`, `1.4M`) or the literal string `N/A tokens` when no breakdown is recorded, with `· <≈$cost>` appended when a cost estimate exists. The sub-line is always rendered; it does not depend on `hasSummary`.
- The affordance row is always shown while collapsed, on memory-bearing and code-only commits alike; a code-only commit shows `LOCAL` and the expand link, plus an overflow chip if the branch-level PR chip applies (the PR chip is not gated on the row having a memory).
- The "Show memory details" link is always present, pinned to the affordance row's right edge. Expanding hides the **whole affordance row** — cloud chip, overflow chip and link together — and the "Hide memory details" link at the bottom of the expanded content takes over. (Previously only the link itself was hidden, so the chips stayed visible above an expanded body.)
- Hover action icons (Pin / Copy recall prompt / View memory) are created only for memory-bearing rows; they start hidden and reveal on hover. Their **horizontal space is reserved while they are hidden**, so revealing them on hover no longer widens the row's right side, re-wrap the subject onto another line, and make the row jump height mid-hover.
- The row click listener shows the memory in the shared memory tab (no-op on non-memory commits); the arrow click listener toggles expand/collapse only.

### Token meter

The token meter is always rendered above the commit list (even when commits exist but none has recorded usage). Its structure:

1. A bold `"<N> tokens"` (or `"N/A tokens"` if `hasData` is false).
2. When a branch cost total exists, a dim `"· <≈$cost>"` figure next to the total (never rendered as `"≈$0.00"` — it's absent rather than zero when nothing is priced).
3. A dim scope label reading `"· this branch"`, shown **only when `hasData` is true**. It is deliberately suppressed on the `"N/A tokens"` header so an empty measurement does not read as a claim about the branch.
4. When `partial`, a dim `"· partial"` label to the right of the above.
5. A circled `"?"` help affordance, **pushed to the far right of the header line** (the total and its adornments stay left; the help sits at the opposite edge). Hovering it now shows the **same full explanation** the click opens — previously the hover showed only a short "How this total is counted" hint and the full text was click-only. Clicking still opens the stickier balloon. The explanation says the total is summed across memories whose source reports token usage, that sources which don't report it are not counted, and that **cache tokens aren't tracked** — so the real total is higher.
6. When `hasData`: a three-segment color bar proportional to `input / output / cached` widths, using fixed segment colors — **input = green, output = blue, cache = grey**; a legend row showing each segment's value and label, each marked by a small **rounded square** (previously a circular dot).

The token meter is not shown when the commit list is empty (empty-state placeholder replaces the entire content area).

Two problems live in this meter as written:

- **The segment colors no longer agree with the per-memory detail view.** Output and cache were swapped here; the per-memory detail view's own token/cost banner still renders output = grey and cache = blue. The two surfaces now disagree on the meaning of the second and third colors, so the same figures read as different segments depending on which surface the user is looking at. This is a **live inconsistency to be resolved**, not a deliberate per-surface distinction.
- **The help explanation contradicts the meter it explains.** The text says cache tokens aren't tracked, while the bar and legend both carry a "cached" segment with a real number in it. One of the two is wrong; the spec records the contradiction rather than picking a side.

### Click semantics

| Interaction                                        | Action                                           |
| -------------------------------------------------- | ------------------------------------------------ |
| Click on the arrow label                           | Toggle expand/collapse.                          |
| Click on the "Show memory details" link             | Toggle expand (same as arrow).                   |
| Click on the "Hide memory details" link             | Toggle expand (collapse).                        |
| Click on the overflow chip                          | Reveal that row's hidden status chips in place and remove the overflow chip. Does not open the memory, does not expand. |
| Click anywhere else on the row (not checkbox, not the overflow chip, not hover icons) | Show the memory in the shared memory tab (if `hasSummary`). |
| Click on a hover action icon (Pin / Copy recall prompt / View memory) | Execute that action. |
| Click on the control strip's Squash control         | Re-activate the registered Squash action (spec 299) against the current selection. |
| Click on the control strip's Cancel control         | Leave selection mode; the selection is dropped.  |
| Click on a file row inside an expanded commit      | Open the parent↔commit diff.                     |
| Click on a SHIPPED entry with an action             | Execute the linked action (browse PR URL, open memory editor, browse Jolli URL). |
| Click on a conversation row                        | Open the conversation content.                   |
| Click on a conversation's "Open" hover icon         | Open the conversation content.                   |
| Click on a conversation's "Resume" hover icon (Claude only, file present) | Open a new terminal tab and resume the session. |
| Click on a CONTEXT reference row that has an upstream URL | Open the URL in the system browser.        |
| Click on a CONTEXT reference row that has **no** upstream URL | Read the reference's archived Markdown body from storage and open it in the host editor in **source view**. |

Note: there is no double-click-to-open-memory behavior. A single click on the row body opens the memory.

"The row body" is narrower than it looks: the open-on-click gesture is carried by the title, the sub-line, the arrow/checkbox strip and the row's own background — **not** by the affordance row and **not** by the memory-present glyph. Clicking the blank space beside the cloud chip, or the glyph itself, does nothing at all.

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

### Squash-selection mode

The mode is off at rest and is only ever turned on deliberately. Two gestures turn it on: the section toolbar's Squash action's first activation (owned by spec 299), and the section toolbar's "toggle select all" action's first activation (below). Both go through the same entry path, which refuses when the branch is merged or has fewer than two commits, clears the selection, and rebuilds the row list so the checkboxes and the control strip appear.

While the mode is on, the control strip sits between the token meter and the row list. Its Squash control **re-activates the same registered Squash action** rather than owning a private squash path. That has a visible consequence: the strip's control enables purely on "two or more checked", so it can look available under conditions that would have the action's own control greyed out — while a summary worker is busy for this worktree, for instance. On that particular condition the user is not left guessing: the action re-checks for a busy worker as the first thing it does and explains itself ("wait a moment"), so the click produces feedback rather than silence. Whether the platform instead refuses a disabled action before its handler is ever reached is a platform contract, not something this repository shows either way (spec 299 owns the action's own conditions).

The mode is turned off by the strip's Cancel control, and automatically by the squash flow once an operation finishes — including the case where the squash succeeded but the follow-up push failed (spec 299 owns exactly which outcomes do this). Either way the selection is cleared, so stale checkboxes cannot feed the next action.

A background refresh that changes the commit sequence clears the selection but leaves the mode on; the checkboxes stay up, emptied.

### Range-based checkbox toggle

Clicking a row's checkbox (only reachable inside selection mode) toggles a contiguous run anchored at the row:

- If the row was already checked, the click unchecks **this row and all older commits** (this row through the end of the list).
- If the row was unchecked, the click checks **this row and all newer commits** (the top of the list through this row).

After mutating the selection set, every checkbox in the panel is re-synced from the set, and the control strip's count and Squash-control enabled state are re-synced too, so the visible state is consistent.

This rule produces a contiguous "newest-N" selection that the squash-multiple-commits flow consumes.

### Toggle select all (two-step)

The section's "toggle select all" toolbar action is also a two-step gesture:

- **No-op** when `commits.size <= 1` **or** the branch is merged into the mainline — it does nothing at all in those cases.
- **First activation, selection mode off**: it does **not** build a selection. It enters selection mode (revealing the checkboxes and clearing the selection) and stops.
- **Second activation, selection mode on**: if every commit is currently selected, the selection is cleared; otherwise every commit is added to the selection set. Either way the change is visible on the checkboxes the previous activation revealed.

The reason for the extra step: building an invisible whole-branch selection and handing it to an irreversible history rewrite was the failure mode being closed. A single activation used to populate the selection set with every commit on the branch while no checkbox was on screen to show it, and that hidden set then fed the Squash action.

### PR lookup

The panel asks for the branch-level PR once per refresh (off the UI thread). The request now goes through a **shared short-lived cache** in front of the `gh` CLI rather than calling the CLI directly, and the same cache serves the per-memory detail view's own PR-status check. Consequences:

- However many memory tabs the user opens on a branch, the tool is asked at most **once per branch per cache window** instead of once per surface per open.
- The cache window is short (about a minute for the PR lookup itself; presence/authentication checks are held longer), so a PR opened, merged or closed **outside the IDE can read stale for up to about that window**.

Spec 309 owns the cache's keying, its lifetimes, its behavior under concurrent callers, and its invalidation; it is not restated here.

The result is held for the refresh and shared by all row renders.

**The lookup does not gate the first paint.** After the commit listing returns, the panel renders the list immediately using the **previous** refresh's PR value — which is nothing at all on the first refresh, so the first paint of a fresh panel carries no PR chip and no PR entry in the SHIPPED group. The lookup then runs in the background (it is a network round-trip, typically seconds) and the list is re-painted with the result when it lands. A result whose refresh generation has already been superseded by a newer refresh is discarded rather than applied, so a slow lookup cannot flip the PR chip back to a stale value.

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

The panel uses a monotonic version counter to discard stale background results: if a newer refresh started before the old one's query returned, the old result is dropped. A failure of the listing on this versioned path is recorded in the log rather than silently swallowed; the panel still falls back to an empty list. (The bypass-version force path below still swallows its failures.)

A second `forceRefresh()` entry point exists that bypasses the version-discard mechanism; it is used by the action bar when it needs a guaranteed update.

When the new commit list differs from the previous one (any change in the hash sequence), the selection set and the detail cache are cleared, and the visible page (below) resets to the base page size. Selection mode itself is **not** turned off by this — if it was on, the checkboxes stay on screen with nothing checked. Every rebuild also collapses each row's revealed status chips back behind the overflow chip.

**Expand/collapse state survives a rebuild.** Every rebuild of the row list first snapshots which commits were expanded and re-applies that state to the freshly built rows. This matters because a rebuild is no longer only a user-visible content change: the asynchronous PR-lookup re-paint arrives seconds after the first paint, and without the snapshot it would silently collapse rows the user had opened in the meantime. A restored row renders straight from its already-resolved detail bundle when one is cached, so no `"Loading..."` placeholder flashes; when the bundle is not cached (or a previous load failed), the row falls back to the normal asynchronous load and does briefly show the placeholder. Rows whose commit is no longer listed are simply dropped.

### Pagination

The commit-row list is paged at render time, independently of the underlying commit-range query (which always resolves and returns the full range in one pass — there is no query-level paging).

- **Page size**: a fixed number of rows (the same page size used by the per-commit expanded-group row caps, though this is a separate, list-scoped counter).
- **Growth**: each click on a "Show N more" row (appended below the last visible row whenever more commits remain) grows the visible count by one page size and re-renders the list.
- **Reset condition**: the visible count resets to the base page size **only** when the ordered commit-hash sequence differs from the previous refresh's sequence (the same condition that clears the selection set and detail cache — see Auto-refresh above). A background refresh that returns the identical hash sequence — for example, a summary completing for an already-listed commit, or a periodic status tick with no new commits — leaves the current page size untouched, so the user's "Show N more" progress survives content-identical refreshes and the list does not visually collapse while being read.

### Memory open path

Clicking the row body (when `hasSummary` is true), or the View-memory hover action:

1. Asynchronously fetch the full memory by commit hash.
2. On the UI thread:
   - If found, hand it to the **shared single-memory-tab opener** (spec 121) rather than opening a tab directly. That opener keeps at most one memory tab per project: if a memory tab is already open it swaps its content to this memory and activates it, whatever memory was previously in it; otherwise it opens the one tab. So opening a memory from this panel **replaces** whatever memory the reader had open.
   - If not found, show an informational dialog: `"No summary found for <short-hash>"`.

### Row hover treatment

Entering a row tints it and reveals its hover action icons — that is now the **whole** of the hover treatment; nothing is shown above or below the row. Leaving it clears both. Two invariants govern this:

- **At most one row is tinted at any time.** The panel tracks which row currently carries the tint, and the *first* thing a new row's hover-enter does is clear the previously tracked row. A lost exit event on the previous row — which really happens: an action icon that has just been hidden can still dispatch its own exit, and asking that hidden component where it is on screen fails — therefore cannot leave two rows tinted at once. An exit event whose source is no longer on screen clears the tint unconditionally instead of trying to test whether the cursor is still inside the row. Rebuilding the row list also drops the tracked row, so a subsequent hover cannot try to clear a row belonging to a discarded render.
- **The row paints its own tint, after its ancestor has drawn, and is not marked opaque.** The tint is translucent. Letting the row's own background fill do the work meant the fill happened without the ancestor being redrawn first, so every region *not* covered by a child widget — the chips row's right padding, the "Show memory details" gutter, the row's own vertical padding — accumulated the previous frame plus the tint. The visible symptom was a row that appeared tinted on one side and flat on the other.

The memory reference chip participates in the row's hover treatment like any other child, so hovering it tints the row and reveals the row's hover actions exactly as hovering the title does.

### Foreign mode

When another panel (e.g. Memory Bank explorer) puts this panel into foreign mode for a given repo/branch, it switches to a read-only view of memories from that repo/branch, sourced from the local Memory Bank folder cache. The normal git-based commit list is replaced with a flat list of foreign memory rows (eye icon, title, relative date, copy-recall-prompt button). Clicking a row reads its memory from the Memory Bank folder and shows it in the **same shared memory tab** in read-only mode — so it replaces whatever was in that tab, including one of the reader's own memories, and flips the tab read-only.

Clearing foreign mode restores normal operation and triggers a standard refresh.

## State Transitions

```
[panel construction]
  paint "Initializing Jolli Memory..." synchronously (first frame is never blank)
  subscribe to status listener
    [status snapshot already cached] → listener fires immediately → schedules refresh
  subscribe to git-repo change channel (debounced 500 ms)
  subscribe to VCS config change channel (debounced 500 ms)
  [no status snapshot yet] → spawn initial background refresh
  [snapshot exists]        → no extra refresh (the listener's already covers it)

[refresh]
  if foreignMode → re-filter KB cache, re-render foreign list
  version++
  background: list branch commits, check is-merged
  on response:
    if version mismatch → discard
    if listing threw → log the failure; fall back to an empty list
    if status == null → "Initializing Jolli Memory..."
    else if !status.enabled → "not enabled for this repository" placeholder
    else if commits.empty → empty-branch placeholder
    else:
      if hash sequence changed:
        clear selection
        clear detail cache
        reset visible page to base page size
      isMerged ← "is this branch merged into the mainline?"
      render token meter (always, above list)
      [selection mode on AND not merged AND ≥2 commits] → insert the control strip
                                                          under the meter
      snapshot expanded hashes; rebuild commit rows using the PREVIOUS PR result
        (every row's hidden status chips are collapsed again — the reveal is not
         remembered)
      restore expanded rows (from cached detail bundle if present, else async load)

  then, in the background (does not gate the paint above):
    PR result ← branch PR lookup via the shared cache
                  [skipped if branch unpublished or the tool is unavailable/unauthenticated]
      if version mismatch → discard the result
      else → store it and re-paint the list (expanded rows restored again)

[user clicks arrow or "Show/Hide memory details"]
  toggle expand/collapse
  toggle the WHOLE affordance row's visibility (cloud chip + overflow chip + link)
  if expanding for the first time: kick off lazy bundle load (summary + conversations + files)

[user clicks row body (hasSummary), or the View-memory hover action]
  fetch memory async → hand to the shared single-memory-tab opener
    (replaces whatever memory that one tab held)

[user clicks a row's overflow chip]
  reveal that row's hidden status chips in place; remove the overflow chip
  (not remembered — the next rebuild collapses them again)

[user clicks a file row inside an expanded commit]
  open diff: parent ↔ commit for that file

[section toolbar: Squash — first activation]     (owned by spec 299)
  [merged branch, or <2 commits] → nothing
  else → ENTER selection mode: clear selection, reveal checkboxes,
         insert the control strip; STOP

[section toolbar: Squash — second activation]    (owned by spec 299)
  [<2 checked] → silent no-op (the strip already says to pick 2+)
  [≥2 checked] → run the squash flow on exactly those

[user clicks a checkbox on row at index i]       (only reachable in selection mode)
  if row was checked → uncheck rows i..end
  if row was unchecked → check rows 0..i
  re-sync all checkbox visuals from selection set
  re-sync the strip's count label + Squash-control enabled state

[section toolbar: toggle select all]
  if commits.size <= 1 or branch is merged: no-op
  else if selection mode is OFF: ENTER selection mode (clears selection); STOP
  else if all selected: clear selection
  else: select all
  re-sync visuals + strip

[control strip: Squash control]
  re-activate the registered Squash action (inherits ALL its conditions — the strip's
  own control enables on "2+ checked" alone, so it can look available while the action
  would not run; on the worker-busy condition the action explains itself instead)

[control strip: Cancel control]
  EXIT selection mode: hide checkboxes + strip, clear selection

[squash operation finishes]                      (owned by spec 299)
  [succeeded] or [succeeded but push failed] → EXIT selection mode
  [any earlier abort]                        → mode left as it was

[user clicks PR chip]
  opens the PR URL in the system browser (via SHIPPED group row action)

[conversation row hover]
  hide message count; show Open + optional Resume action icons

[conversation row click or Open icon click]
  open conversation content in editor

[Resume icon click (Claude only, file present)]
  open terminal tab and resume session

[hash sequence changes (rebase, amend, branch switch, new commit)]
  clear selection; clear detail cache; reset visible page to base page size; rebuild rows
  (selection mode is NOT turned off — the checkboxes stay up, emptied)
  (expanded rows that still exist in the new list stay expanded; their detail reloads)

[cursor enters a row]
  clear the previously tinted row's tint (even if its own exit was lost)
  tint this row; reveal its hover action icons; record it as the tinted row
  (nothing else — no delayed card)

[cursor exits a row]
  [source or row no longer on screen] → clear tint unconditionally
  [otherwise] → clear tint only when the cursor is outside the row's bounds

[panel enters foreign mode for a repo/branch]
  switch to read-only Memory Bank view
  [row clicked] → show that memory in the shared memory tab, read-only
                  (replaces whatever it held; flips the tab read-only)

[panel leaves foreign mode]
  restore normal commit view, refresh

[panel disposed]
  unsubscribe; cancel debounce timer
```

## Notable Behavior

- **The range is `merge-base ↔ HEAD` while the branch has own commits, and something else entirely once it does not.** On a diverged branch the panel is the unmerged-history view and commits reachable from `main` are not shown. The moment the branch tip is fully contained in the mainline — on `main` itself, or after the branch is merged — that framing stops applying: the panel switches to the author-scoped merged-mode view and deliberately *does* show commits reachable from the mainline.
- **Token meter is always shown when there are commits.** Even when every commit has no recorded breakdown, the meter renders `"N/A tokens"` without a bar, so the panel's structure is consistent. The meter is absent only when the list is empty (placeholder replaces the content area).
- **Per-commit token spend and cost appear on the sub-line of every row.** Neither is gated on `hasSummary`; a code-only commit's sub-line still shows `"N/A tokens"` so the layout is uniform. Cost is never shown for a row/branch with no priced estimate — the UI omits it rather than showing a misleading `"≈$0.00"`.
- **Cost is decided once, then only summed.** The "prefer stored per-model estimate, else a rough estimate at fixed list rates" decision happens once per commit at the point row data is assembled. The per-row sub-line and the branch-total aggregator downstream never re-derive that decision — the branch total is a pure sum of each contributing commit's already-decided figure.
- **Token-bar segment colors now DISAGREE with the per-memory detail view, and that is a live inconsistency.** This meter renders input = green, output = blue, cache = grey. The per-commit detail view's own token/cost banner (embedded-HTML-viewer spec) still renders input = green, output = grey, cache = blue. Output and cache were swapped here and only here, so the second and third segments mean different things on the two surfaces. This is not a deliberate per-surface distinction — it is a defect to be resolved by making one surface match the other. (Notable; regression introduced alongside the meter's restyle.)
- **The token meter's help text contradicts the meter's own "cached" segment.** The explanation states that cache tokens aren't tracked, while the bar and the legend both carry a "cached" segment with a real figure in it. One of the two is wrong. The same text is now used for both the hover hint and the click-opened balloon, so the contradiction is visible from either gesture. (Notable; unresolved.)
- **The token-meter header gained a branch scope label, and it is suppressed when there is nothing to scope.** The dim "this branch" label appears only when usage data exists, so the `"N/A tokens"` header stands alone rather than making a claim about an empty measurement. The help affordance moved to the opposite edge of the header line, and its hover now shows the full explanation instead of a one-line hint. Legend markers became rounded squares instead of circular dots.
- **The `partial` flag is a lower-bound signal, not an error.** It is set when a source (e.g. Cursor) does not report usage, or when old memories predate usage capture. The "· partial" label and the info popover communicate this explicitly.
- **Merged mode is the only path when the branch tip is fully contained in the mainline, and that closed a whole-panel blindness.** The panel previously short-circuited that case to "the commits not yet on the remote" whenever the resolved mainline ref was remote-tracking. That range is empty by definition on a fully-synced mainline or release branch, so on `main` — or on any branch already pushed in full — the panel **hid every already-pushed memory** and looked as if nothing had ever been summarized. There is now no carve-out: the panel always resolves the branch's own reflog creation point and lists the current user's own commits from there. It still requires both a reflog "own-commit" signal and a resolvable git user name; missing either clears the panel rather than over-listing. (Notable; fixes a panel that was empty for the most common branch.)
- **The author scoping is a literal substring match, and the switch that makes it literal is global to the invocation.** A configured user name containing pattern metacharacters resolves correctly instead of erroring or matching the wrong commits. The cost is that the same switch retunes every pattern-taking operand in that one listing call; the author filter happens to be the only one today, so a future message- or committer-filter added beside it would silently become literal too. (Notable; latent footgun.)
- **Per-commit change statistics ride along with the listing — but nothing in this panel renders them any more.** Files/insertions/deletions still come from the same single invocation that produces each row's metadata, instead of one extra child process per listed commit, and a repository's first commit (which the old per-comparison could never stat) still reports real numbers. The panel simply no longer has a surface that shows them: they were the delayed hover card's contribution, and it is gone (see below). (Notable.)
- **Commit-list pagination is render-time only and independent of the git-log query.** The underlying commit-range query always resolves and returns the full listed range; only the number of rows the panel *renders* is paged, starting at a fixed page size and growing by that same increment on each "Show N more" click. The page size resets to the base page size only when the ordered commit-hash sequence differs from the previous refresh — a content-identical background refresh (e.g., a summary landing on an already-listed commit, or a periodic status tick) leaves the user's current page untouched so the list doesn't visually snap shut mid-read.
- **Branch PR lookup runs once per refresh, and now goes through a cache shared with the per-memory view.** One lookup resolves the open PR and the closed-PR history strip for the branch, and its result is reused by all row chips and the SHIPPED group — that was already true. What is new is that the request is served by a shared short-lived cache rather than calling the tool directly, and the per-memory detail view's own PR check uses the same cache. So the tool is asked at most once per branch per cache window however many memory tabs the reader opens. The trade: a PR opened, merged or closed **outside the IDE can read stale for up to about that window** (roughly a minute). Cache internals — keying, lifetimes, dedup under concurrent callers, invalidation — are owned by spec 309. (Notable.)
- **The PR lookup no longer gates the first paint, so the PR chip arrives late.** The list is painted with the previous refresh's PR value and re-painted when the network lookup returns. On the very first refresh of a fresh panel that previous value is nothing, so the PR chip and the SHIPPED group's PR entry are genuinely absent for the first second or two and then appear — the trade made to stop a seconds-long network call from holding the whole list back. A superseded lookup result is thrown away rather than applied, so the chip never flickers back to a stale value. (Surprising; intentional.)
- **A rebuild preserves expansion, and the async PR re-paint is why it has to.** Expanded rows are snapshotted and re-applied on every rebuild; a restored row renders from its cached detail bundle with no loading flash when one exists, and falls back to the asynchronous load (with the placeholder) when it does not. Without this, the PR re-paint arriving seconds after the first paint would collapse whatever the user had just opened. (Notable.)
- **Exactly one row can be tinted, enforced on enter rather than on exit.** Clearing the previously tinted row is the first thing a hover-enter does, because exit events are genuinely lossy here — a just-hidden action icon can dispatch an exit that cannot be located on screen. The row also paints its own translucent tint after its ancestor has drawn instead of relying on an opaque background fill, which is what fixed a row appearing tinted on one side and flat on the other. (Notable; both are bug fixes.)
- **PR lookup is gated on branch being published, not on commits being pushed.** A branch that was pushed then locally amended retains its PR chip because the PR lives on the remote; gating on pushed commits would wrongly hide the chip after a squash.
- **The `PrLookup` result is a sealed type.** `Found` / `NoPr` / `LookupError` replace the previous single nullable PR result; `NoPr` and `Found` both carry a `history` list of closed/merged PRs for the branch.
- **Checkboxes are opt-in, and three separate conditions keep them hidden.** They are absent in the resting state (selection mode off — this is what the reader sees by default), absent forever when the branch lists exactly one commit, and absent forever when the branch is fully merged into the mainline. The latter two also refuse to let selection mode open at all. Nothing about the list looks selectable until the reader asks for it.
- **Entering selection mode deliberately clears any prior selection.** The reader is never handed a set of already-checked memories they did not pick. Leaving the mode clears it again — so, because both transitions clear, **no selection exists while the checkboxes are hidden at rest**. (Notable; the "hidden selection" state that used to be reachable is what made the old whole-branch squash surprising.)
- **The mode ends by itself once a squash finishes — including when the squash succeeded but the push failed.** The history is already rewritten on that path, so leaving the checkboxes up would hand the next activation a stale selection. Earlier aborts leave the mode alone so a retry keeps the reader's picks. (Owned by spec 299; recorded here because it mutates this panel's state.)
- **The control strip's Squash control is a re-activation of the registered action, not a private path.** It therefore inherits every one of that action's conditions, while its own enabled state tracks only "two or more checked" — so it can look available in situations where the action itself would not run. The worker-busy case is the one that is actually checked twice: the action re-tests it and tells the user to wait, so the click is answered rather than swallowed. What happens when the platform considers the action disabled before reaching its handler is a platform contract this repository does not settle. (Notable; the two enabled states are deliberately not the same predicate.)
- **Merged mode is read-only.** When the branch has been fully merged into main, checkboxes can never appear and selection mode refuses to open. Expand and click-to-open-memory still work.
- **Single-commit mode also hides checkboxes.** A range squash with one commit is meaningless.
- **Range checkboxes produce only newest-N selections.** A click on the third row checks rows 0–2 or unchecks rows 2–end. Only "toggle select all" produces a full-set shape (all-or-nothing), which is by construction contiguous.
- **"Toggle select all" is two-step, and the reason is the same irreversible-rewrite hazard.** Outside selection mode the header control does not build a selection at all — it enters the mode (revealing checkboxes, clearing the selection) and stops. Only a second activation selects or clears everything, visibly. It does nothing whatsoever on a merged branch or with a single commit. The failure mode being closed: one activation used to populate the selection set with every commit on the branch while no checkbox was on screen to show it, and that invisible whole-branch selection then fed an irreversible history rewrite. (Notable; bug fix.)
- **The selection clears the moment the hash sequence changes, but selection mode does not.** A rebase or amend invalidates whatever was selected before; the panel does not try to map old-hash selection onto new-hash rows. The checkboxes stay on screen, emptied.
- **Detail bundle loads lazily and concurrently safely.** Two near-simultaneous expands of the same commit share one query. The cache survives until the hash sequence changes. A failed load removes the cache entry so the next expand retries.
- **All four expanded groups always render.** An empty CONVERSATIONS, CONTEXT, or FILES group shows a plain-text placeholder row rather than being absent. This ensures the expanded panel has consistent structure across commits.
- **A reference row with no upstream URL now opens the reference itself, not the commit.** Track-only sources (the product's own memory lookups, documentation lookups, and any other reference the extractor captured without a link) have no URL to browse. Such a row used to be a link-styled dead end that fell back to the whole commit memory; it now reads that reference's **archived Markdown body** from storage on a pooled thread and opens it in the host editor. The commit-memory fallback survives only as a second-order fallback: it fires when the archived body cannot be read *and* the commit actually has a memory. When neither holds, the click does nothing. The archived read itself is spec 317's; this panel owns only the dispatch and the two fallbacks.
- **That body opens in source view, not rendered preview, and that is deliberate.** The archived file's YAML frontmatter (source, native identifier, title, referenced-at timestamp, originating tool name) and its HTML-comment markers are the point of opening it — a rendered preview hides both. The editor is therefore explicitly switched to the editor-only layout after opening, matching the sibling VS Code surface, which opens the same content as an untitled Markdown document rather than a preview. (Notable; the sole place this panel deliberately declines to render Markdown.)
- **The "Show memory details" / "Hide memory details" links are the primary expand toggle for most users.** The arrow also works; both run the same toggle.
- **Expanding now hides the whole affordance row, cloud chip included.** Previously only the expand link itself hid, so the chips stayed visible above the expanded body. The "Hide memory details" link at the bottom of the expanded content is the only remaining toggle while a row is open. (Notable.)
- **The delayed hover detail card is gone.** Hovering a row used to bring up, after a short dwell, a small card carrying the commit subject, a relative date, an optional type badge, the file/insertion/deletion change statistics, the short hash, and a link into the memory — with its own show delay and exit grace period, and its own teardown on panel disposal. All of that has been removed; hovering a row now only tints it and reveals its action icons. Everything the card showed is still reachable somewhere on the row or by expanding it — subject and short hash on the row's own two lines, relative age on the sub-line, type badge appended to the title, and the memory itself via the row click or the View-memory action — **except the change statistics**, which have no at-rest surface any more and are only implied once the row is expanded (the FILES group's own count gives the file count; the inserted/deleted line counts are no longer displayed by this panel at all). The removal was a casualty of the selection-mode restructure rather than a design decision, and the code records re-adding the card as a follow-up. (Notable; a real loss.)
- **A single click on the row body opens the memory.** There is no double-click-to-open path. The eye-style affordance is now a hover action ("View memory") alongside the row-body click, replacing the deleted card's link.
- **Hover action icons are initially hidden but their space is reserved.** Pin / Copy recall prompt / View memory appear only while the cursor is inside the row bounds, and only for memory-bearing rows. Leaving the row hides them again, with a bounds-check to avoid flickering when moving between child components. Because the row now reserves their width even while they are hidden, revealing them no longer narrows the title, re-wraps the subject onto an extra line, and makes the row jump height mid-hover. (Notable; bug fix.)
- **Per-row Share was removed from the hover actions.** Sharing a single memory is now reachable only from inside that memory's own view; sharing the whole branch remains on the bottom action bar. A reader who wants to share one memory must open it first. (Notable.)
- **A memory-present glyph is the only at-rest cue that a commit carries a memory.** A small link-coloured block sits between the arrow/checkbox and the title on memory-bearing rows and nowhere else — so the distinction is visible without hovering (which is what used to reveal the memory-only action icons) or expanding.
- **The squash-transcript fallback is transparent to the user.** When a squashed commit has no direct transcript, the CONVERSATIONS group aggregates the child commits' sessions. Deduplication is by session key; message counts are summed across children.
- **Only the cloud-sync chip survives at rest; the rest hide behind an overflow chip.** A reader scanning the collapsed list sees SYNCED-or-LOCAL and nothing else about status: the pull-request chip and the end-to-end chip are built but hidden, and a compact overflow chip stands in for them. Clicking it reveals them in place on that one row, and the reveal is **not remembered** across a rebuild — so any new commit, amend, "Show N more" click, or the asynchronous PR re-paint collapses every row back. The cost is real: a reader **cannot tell at a glance which commits have an end-to-end guide, or that the branch has a pull request at all.** (Notable; a deliberate calm-at-rest trade with a discoverability cost.)
- **Expanded group headers are separated by spacing, not lines.** The separator between groups was removed and the header font shrank slightly, so the expanded body reads as one calm block rather than a stack of bordered cards.
- **Opening a memory replaces whatever memory the reader had open.** The row-open path hands off to the shared single-memory-tab opener (spec 121), which keeps at most one memory tab per project and swaps that tab's content in place. There is no way from this panel to have two memories open side by side.
- **Foreign mode is a full panel takeover, and it commandeers the reader's memory tab.** When active, all normal git-based rendering is bypassed; the panel shows a read-only flat list from the Memory Bank folder, and refreshes re-filter the in-memory cache without hitting git. Clicking a foreign row shows that memory in the **same** shared memory tab in read-only mode — replacing whatever was there, including one of the reader's own memories, and flipping the tab read-only. (Surprising.)
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
- **The PR status cache** (spec 309) owns the caching layer this panel's branch lookup now sits behind — its keys, its lifetimes, its dedup behavior when two surfaces ask at once, and how a PR-creating surface invalidates it. This panel owns only the request it makes and the staleness the reader can observe as a result.
- **The shared single-memory-tab opener** (spec 121) owns the one-tab-per-project contract and the content-swap mechanics. This panel is one of its callers, in both normal and foreign (read-only) mode.
- **The branch-level Create-PR view's open path** changed in the same change set but is owned by the Create-PR-view spec, not here. This panel owns only the fact that its action bar's Create PR button triggers it.

## Shared Behavior

- **Project status surface** — feeds the `enabled` flag the panel keys its placeholders on.
- **Project service** — owns "list branch commits" (with memory enrichment), "list commit files", "is branch merged", "fetch memory by hash", "get committed conversations". Its memory-enrichment step is a hybrid: index / alias / tree work is delegated over a bridge action, memory bodies are read natively off the memory ref.
- **Summary index and summary-tree implementations** — the shared owners of alias resolution, root-hash walking, the have-a-memory filter, the alias scan, and every tree aggregation this panel renders. The host holds only a small memoization cache over them and the mid-tier-rate cost fallback.
- **PR service** — owns `gh` interaction, the branch PR lookup, the sealed `PrLookup` result.
- **PR status cache (spec 309)** — the shared short-lived cache the branch lookup is now requested through, also serving the per-memory detail view's PR check. Owns keying, lifetimes, concurrent-caller dedup, and invalidation.
- **Single memory tab (spec 121)** — the one memory tab per project that every open path from this panel lands in, in normal and read-only mode.
- **Git operations bridge** — runs `git show <ref>:<path>` for the diff branches.
- **Summary virtual-file wrapper** — the surface that the row-click open path lands on.
- **IDE diff viewer** — the destination for click-on-file-row.
- **IDE terminal** — the destination for the Resume session action (Claude only).
- **Squash-multiple-commits flow (spec 299)** — the consumer of the panel's range selection. It also decides *which* activation turns this panel's selection mode on, reads the panel's loaded commit count and merged flag for its own gating, and turns the mode off again on the operation's terminal outcomes. The control strip's Squash control re-activates it.
- **Section toolbar** — the surface where the Squash, "toggle select all", and "refresh" actions are anchored.
- **Memory Bank folder cache** — the data source for foreign mode.
- **Own-commits-base / branch-creation-point resolver** — used to narrow the listed commit range to the branch's own commits; the same resolver aligns the Create-PR view's diff stats (Create-PR-view spec).
- **Branch-level Create-PR view** — the destination of the action bar's Create-PR button, opened via this panel's open-Create-PR-view action (Create-PR-view spec).
- **Post-commit summarization pipeline** — the write-time source of the token breakdown, per-model usage, and estimated cost every row and the branch meter here read and tree-aggregate (post-commit-pipeline spec).
- **Memory reference identifier and copy chip** (spec 301) — owns the identifier's format, the strict presence rule that decides whether a row shows a chip at all, and everything the chip does when clicked. This panel owns only where the chip sits in the row and how the wrapping title measures around it.
- **Source presentation table** (spec 313) — owns the twelve sources' letter tags, brand colours, human labels, the neutral unknown placeholder, and the rule deciding whether a reference's display title leads with its native identifier. This panel reads that table for the CONTEXT reference rows' badge letter, badge colour, and title, and holds no letter table of its own.
- **Archived-reference body read** (spec 317) — owns the read that backs the no-URL reference click: the source-plus-archived-key lookup, the stem derivation, and the silent decline this panel treats as "fall back to the commit memory".

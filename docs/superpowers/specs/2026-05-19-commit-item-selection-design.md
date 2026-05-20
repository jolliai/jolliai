# Commit-time item selection (conversations, plans, notes, files)

Date: 2026-05-19
Status: Draft — pending implementation plan

## Summary

Today every active conversation, plan, note, and changed file is automatically rolled into the next commit's summary (or, for files, into the next commit itself). The user has no way to say "skip this one" without permanently hiding or ignoring the item.

This spec introduces a per-item selection layer for the four kinds of items shown in the sidebar — **conversations**, **plans**, **notes**, and **changed files** — using a uniform "default selected, user can uncheck to exclude" model. Excluded items stay in the workspace exactly where they were; they're simply not fed to the next summary pipeline / commit.

Exclusion is **sticky**: an unchecked item stays excluded across commits, amends, rebases, and editor restarts until the user explicitly re-checks it. This makes the new checkbox semantically distinct from the existing permanent **hide / ignore** mechanisms — those make the row disappear; *this* keeps the row visible (so the user knows it exists and can re-include it later) but holds it out of the next summary.

## Goals

- Per-row checkboxes on conversations, plans, and notes rows in the sidebar.
- A "Select / Deselect All" icon button in each section's sticky title bar, **with the same shape and behavior as the existing Changes / Commits Select-All button** (single codicon `check-all` icon, toggles between "all selected" and "all deselected"; no tri-state UI).
- Default = selected, for all four kinds (conversations, plans, notes, files). A freshly seen item is selected; the user has to explicitly uncheck it.
- An item's exclusion state is **sticky**: it stays excluded across commits, amends, rebases, editor restarts, and project re-opens, until the user explicitly re-checks it. The new mechanism is therefore distinct from — and orthogonal to — the existing permanent **hide / ignore** flags.
- Excluded conversations / plans / notes stay visible in the sidebar with an unchecked box (so the user knows the item exists and can put it back in).

## Non-goals

- Replacing or merging the existing **permanent** hide/ignore mechanisms (`HiddenConversationsStore`, `PlanEntry.ignored`, `NoteEntry.ignored`). Those keep their current behavior; selection is orthogonal.
- Adding a per-row "ignore from now on" toggle. Permanent ignore stays where it is today (delete-all-entries for conversations; right-click menu for plans/notes).
- Cross-branch / cross-worktree selection memory. Selection is per project dir (worktree-aware via the existing `.jolli/jollimemory/` resolver) and per commit cycle.
- Selecting individual *entries within* a conversation transcript. Selection is at the conversation level only.
- Changing the **Commits panel** default selection. That panel drives squash (history-rewrite), not summary-input selection; its existing "default unselected" stays. See "Commits panel default — intentionally unchanged".

## Current state (verified)

- **Conversations sidebar** ([SidebarWebviewProvider.ts](../../../vscode/src/views/SidebarWebviewProvider.ts), [ActiveSessionsProvider.ts](../../../vscode/src/services/ActiveSessionsProvider.ts), [ActiveSessionAggregator.ts](../../../cli/src/core/ActiveSessionAggregator.ts)): renders all sessions ≤48h, minus those in `HiddenConversationsStore`. No selection model.
- **Plans & Notes** (`SidebarMessages.ts:branch:plansData`, `PlansProvider.serialize()`): renders all non-`ignored` entries via `SerializedTreeItem`. The type already has an optional `isSelected` field, but it's only populated for changes / commits rows today.
- **Changes panel** ([FilesStore.ts](../../../vscode/src/stores/FilesStore.ts) lines 70–153): uses GitHub-Desktop-style in-memory `selectedPaths: Set<string>`; **default is unselected** today — `FilesStore.refresh()` lines 143–153 only seed into `selectedPaths` when the bridge returns `isSelected:true`, and the bridge always returns `false` in production. A `toggleSelectAll()` button already exists.
- **Commits panel** ([CommitsStore.ts](../../../vscode/src/stores/CommitsStore.ts) lines 142–190): separate `checkedHashes: Set<string>` with **range semantics** — checking commit N also checks 0..N; unchecking N also unchecks N..end (because squash operates on a contiguous range from HEAD). Default is unselected; the panel is used to drive `Squash Selected` (disabled below 2 commits) and `Push Branch`. **This spec intentionally does not change the Commits-panel default** — see "File panel default" below for the rationale.
- **Commit pipeline** ([QueueWorker.ts](../../../cli/src/hooks/QueueWorker.ts) `runSummaryPipeline`): loads transcripts via `loadSessionTranscripts(cwd)`, plans/notes via `detectActivePlansForBranch` / `detectActiveNotesForBranch`, then calls `generateSummary()`. No filtering hook exists between "load all" and "pass to LLM".
- **Existing wire messages**: `branch:toggleFileSelection`, `branch:toggleCommitSelection`. Both already round-trip through `SidebarWebviewProvider.handleOutbound()` → `applyFileCheckbox` / `applyCommitCheckbox` callbacks → store. No equivalents for conversations / plans / notes.

## Semantics

### Default

Every visible item is selected by default. "Visible" means: passes the existing filters (recency window, hidden / ignored, exclude patterns). Permanently hidden / ignored items are not shown and therefore not selectable — they're already out.

A "new" item — one not previously seen by the selection store — is treated as selected. The store records exclusions, not selections, so absence of a record means included.

### Excluding (unchecking)

Unchecking an item:

- For conversations / plans / notes: writes the item key into `commit-selection.json`. From that moment on, every pipeline run skips the item, until the user explicitly re-checks (which removes the key) or the item permanently disappears via hide / ignore (which makes the entry a harmless no-op).
- For files: removes the path from `FilesStore.selectedPaths`. Sticky within the current sidebar session; on next refresh after a commit lands or on editor restart, the path is reseeded as selected (see "File panel default" below).

### Lifecycle of an exclusion

1. User unchecks item X at T₀ → key written into `commit-selection.json`.
2. User runs any git operation that triggers `runSummaryPipeline` (`commit`, `amend`, …) at T₁ → pipeline reads the exclusion set, filters X out, generates / regenerates the summary. **File is not cleared.**
3. Sidebar re-renders → X still rendered, still unchecked.
4. User makes another commit at T₂ → X again filtered out.
5. User re-checks X at T₃ → key removed from `commit-selection.json`.
6. User's next commit at T₄ → X is included in the summary.

The same flow applies to plans and notes. There is no automatic reset point: amend, rebase, squash, editor restart, branch switch — none of these touch `commit-selection.json`.

If X is permanently hidden / ignored between T₁ and T₃, X stops being rendered (so the user cannot uncheck or re-check it) but its key may linger in `commit-selection.json`. That residual entry is harmless: it cannot match anything in the candidate set, so it's a no-op filter. No proactive GC.

### When does the exclusion set get cleared?

**Only by explicit user action**, never automatically. The user clears an exclusion by:

- Re-checking the row's checkbox (removes that single key).
- Clicking the section's "Select / Deselect All" button when not already all-selected (the toggle flips everything to selected, removing every visible key from the store in one atomic write).
- Manually deleting / editing `<projectDir>/.jolli/jollimemory/commit-selection.json` (advanced; not exposed in UI).

No git operation, no pipeline outcome, no `op.type` distinction, and no editor lifecycle event modifies the file.

(Files are not in `commit-selection.json` — their selection is in-memory in `FilesStore`. See "Storage" below.)

## UX

### Per-row checkbox

Conversation rows and plan/note rows render a leading checkbox, sized and aligned to match the existing file/commit checkbox in the Changes / Commits panels. Default state is checked.

Toggling fires a new outbound message (see "Wire protocol" below). The extension persists the toggle and re-pushes the updated panel data; the row's checkbox reflects the post-persist state, so a failed write surfaces as the checkbox snapping back.

### Per-section Select / Deselect All button

Each new section's sticky title bar gets an icon button matching the existing Changes / Commits pattern at [SidebarScriptBuilder.ts:2378](../../../vscode/src/views/SidebarScriptBuilder.ts) / [:2401](../../../vscode/src/views/SidebarScriptBuilder.ts):

- **Conversations** header: `iconButton('conversations-select-all', 'Select/Deselect All Conversations', 'check-all')`
- **Plans & Notes** header: `iconButton('plans-select-all', 'Select/Deselect All Plans & Notes', 'check-all')`

(The Changes panel already has this button; no UI change there — the only file-panel change is the default state, below.)

Click behavior — same as `FilesStore.toggleSelectAll()`:

- If **every visible item is selected** → deselect all visible.
- Otherwise (none selected, or mixed) → select all visible.

There is no tri-state visual; the icon is a single static codicon. State is computed from the rows on each click.

Scope of "all visible" = items currently in the panel's rendered list, i.e. after recency / hidden / ignore / exclude filters. Items off-screen (e.g. hidden conversations, archived plans) are unaffected.

Plans & Notes share one button — it covers both plans rows and notes rows in that panel — matching how the section combines both kinds today.

### File panel default

`FilesStore.refresh()`'s post-prune seeding step adds **every** path in `raw` to `selectedPaths`, not just the bridge's `isSelected:true` rows. Net effect: a freshly populated panel arrives with every file checked. The existing prune-stale-selections step still removes paths no longer in `raw`; the existing exclude-pattern prune in `applyExcludeFilterChange()` still kicks excluded paths out. User unchecks still work and persist for as long as the file remains in `raw` (i.e., until the next commit clears the working-tree change, or until the user re-stages externally).

This brings file behavior into line with conversations / plans / notes: **default fully included, opt out per commit**.

### Commits panel default — intentionally unchanged

The Commits-panel default stays **unselected**, despite the surface similarity to the Files panel. The Commits panel drives `Squash Selected` (and `Push Branch` for the multi-commit case), which is a destructive history-rewriting operation gated by 2-or-more contiguous commits. Auto-pre-selecting every commit on the branch would default the UI to "squash the whole branch every time" — far higher blast radius than "include this conversation in the summary".

Squash is also semantically different from the four kinds this spec actually targets:

- Files, conversations, plans, notes are **inputs** that the user can include or omit from a generated artifact (a commit, a summary). The default "include everything, opt out specific items" matches the user's likely intent.
- Commits in the Commits panel are **history-rewrite targets**: they describe an operation the user must consciously opt into. The default "select nothing, opt in specific items" matches the much-higher-stakes nature of the action.

If the user later wants Commits to also default-select, that's a separate, much-larger UX decision — out of scope for this spec.

## Storage

### Conversations / plans / notes — on disk

New module: `cli/src/core/CommitSelectionStore.ts`.

File: `<projectDir>/.jolli/jollimemory/commit-selection.json` (resolved via the existing `getJolliMemoryDir(cwd)` so worktrees each get their own).

Shape:

```jsonc
{
  "excludedConversations": [
    { "source": "claude" | "codex" | "gemini" | "cursor" | "opencode" | "copilot-cli" | "copilot-chat", "sessionId": "..." }
  ],
  "excludedPlans":  ["plan-uuid-1", "plan-uuid-2"],
  "excludedNotes":  ["note-uuid-1"]
}
```

API:

- `readExclusions(cwd): CommitExclusions` — returns empty sets on missing / malformed file.
- `setExcluded(cwd, kind, key, excluded: boolean): void` — atomic tmp+rename write; idempotent. `excluded=false` removes the key.
- `setAllExcluded(cwd, kind, keys, excluded: boolean): void` — single-write bulk variant for the Select / Deselect All command. Bulk-add or bulk-remove every key in `keys`.

There is no `clear()` method. Removing every exclusion happens via `setAllExcluded(…, false)` driven by the user's Select-All action. Keeping the file shape stable (even when empty) makes diffs / debugging easier than alternating between "file present" and "file absent".

Write atomicity: tmp file + rename, same as `HiddenConversationsStore` ([HiddenConversationsStore.ts](../../../cli/src/core/HiddenConversationsStore.ts)). Concurrent QueueWorker reads and sidebar toggles are safe: the worker reads once at the start of `runSummaryPipeline`; a toggle landing after that read just takes effect on the next pipeline run.

Stale-key tolerance: filters intersect the exclusion set with the candidate set. An exclusion entry for a session that has aged out of the 48h window, or a plan that's been archived, is a no-op at filter time. No proactive GC — keys naturally accumulate but each one is a small string, and the user can always trigger Select-All to wipe the visible portion. If the file grows unwieldy (multiple kilobytes), that's a signal the user has been excluding aggressively and may want to convert the long-term exclusions to permanent hide / ignore — out of scope for this spec but worth noting in a follow-up.

### Files — in-memory only

Files reuse `FilesStore.selectedPaths` unchanged. They are **not** added to `commit-selection.json` because:

- File selection already gates a separate, durable channel — the git index — via `bridge.stageFiles(selectedPaths)`. Once a file is staged + committed, the working-tree state is already mutated; there's no "did this exclusion get consumed" question to answer post-hoc.
- Persisting file unchecks across editor restarts is out of scope — the file may even have disappeared from `git status` by then, and translating between "this exact file in this exact state" and "the user's intent about that file" is its own design problem.

The only file-side code change is in `FilesStore.refresh()`: seed `selectedPaths` with every entry of `raw`. File exclusion is sticky **only within the current sidebar session**; that's a deliberate scope limit, consistent with how today's selected-file set already behaves (just inverted default).

## Wire protocol

### Webview → Extension — per-row toggles

Three new variants on `SidebarOutboundMsg`:

```ts
{ type: "branch:toggleConversationSelection";
  source: ConversationSource;
  sessionId: string;
  selected: boolean }

{ type: "branch:togglePlanSelection";
  planId: string;
  selected: boolean }

{ type: "branch:toggleNoteSelection";
  noteId: string;
  selected: boolean }
```

### Webview → Extension — section-level Select / Deselect All

Reuses the existing icon-button → `{type:'command', command:'…'}` channel (see `cmdMap` at [SidebarScriptBuilder.ts:2936](../../../vscode/src/views/SidebarScriptBuilder.ts)). Two new entries:

```js
'conversations-select-all': 'jollimemory.selectAllConversations',
'plans-select-all':         'jollimemory.selectAllPlansAndNotes',
```

Two new VSCode commands registered in `Extension.ts` alongside `jollimemory.selectAllFiles`:

- `jollimemory.selectAllConversations`: ask the conversations store / aggregator for the current visible-set; if every one is selected (i.e. zero entries in `excludedConversations` intersect the visible-set) → write all visible into `excludedConversations`; otherwise → remove the visible-set entries from `excludedConversations`. Then trigger a re-push.
- `jollimemory.selectAllPlansAndNotes`: same logic over plans + notes combined. The store call writes both `excludedPlans` and `excludedNotes` in a single `setAllExcluded` batch (or two — the file is rewritten atomically once either way).

No per-section "set all" outbound message — the command goes through the same channel as `jollimemory.selectAllFiles` does today.

### Extension → Webview (existing message shapes)

- `ActiveConversationItem` gains `isSelected: boolean` (required, default true, computed by the extension from `commit-selection.json` ∩ visible-set).
- `SerializedTreeItem` already has optional `isSelected` — for plan / note rows, the `PlansProvider` populates it from `commit-selection.json` ∩ visible-set; for file / commit rows, behavior is unchanged.
- Section header buttons render a fixed codicon and do not display selection state — no new field needed. The toggle decision is made server-side when the command fires, reading the current selection state from the store.

### Extension callbacks

Mirroring the existing `applyFileCheckbox` / `applyCommitCheckbox`, `SidebarWebviewProvider.deps` gains:

```ts
applyConversationCheckbox?: (source: ConversationSource, sessionId: string, selected: boolean) => void;
applyPlanCheckbox?:         (planId: string, selected: boolean) => void;
applyNoteCheckbox?:         (noteId: string, selected: boolean) => void;
```

These wire through to `CommitSelectionStore` writes, then trigger a panel re-push (re-read `commit-selection.json` → re-emit `branch:conversationsData` / `branch:plansData`).

## Commit pipeline integration

`QueueWorker.runSummaryPipeline` (see [QueueWorker.ts](../../../cli/src/hooks/QueueWorker.ts)) changes:

1. Near the top of the pipeline (before `loadSessionTranscripts` and `detectActivePlansForBranch` / `detectActiveNotesForBranch`):

   ```ts
   const exclusions = CommitSelectionStore.readExclusions(cwd);
   ```

2. After `loadSessionTranscripts(cwd)`, filter:

   ```ts
   sessions = sessions.filter(s => !exclusions.conversations.has(`${s.source}:${s.sessionId}`));
   ```

3. After `detectActivePlansForBranch` / `detectActiveNotesForBranch`, filter the returned arrays by `exclusions.plans` / `exclusions.notes` (set membership on `id`).

That's the whole change. The pipeline **never writes** to `commit-selection.json` — there is no clear step, no per-`op.type` branching, no failure-vs-success bookkeeping. Read once, filter, proceed.

The squash / rebase-squash code path (`runSquashPipeline` / `generateSquashConsolidation`) does not read or write `commit-selection.json`. The rebase-pick path likewise does not touch it.

## Testing

CLI (must hit the 97 % coverage floor on new code):

- `CommitSelectionStore.test.ts`:
  - empty file / missing file / malformed JSON → returns empty.
  - `setExcluded(kind, key, true)` writes the key; `setExcluded(kind, key, false)` removes it.
  - `setAllExcluded` bulk-adds and bulk-removes a key set in a single write.
  - Atomic write under concurrent process simulation (tmp+rename collision).
  - File with stale keys is still readable and yields a usable set.

- `QueueWorker.selection.test.ts`:
  - Exclusion of one conversation → that transcript is absent from `generateSummary` input.
  - Exclusion of one plan / note → absent from `formatPlansBlock` / `formatNotesBlock`.
  - Pipeline never writes to `commit-selection.json`: file present before → still present after (initial-commit, amend, squash, rebase-pick, rebase-squash, and failure paths).
  - Two consecutive commits with the same exclusion file → same item filtered out both times.
  - Re-checking the item (via `setExcluded(…, false)` between two commits) → first commit excludes, second commit includes.

VSCode:

- `SidebarWebviewProvider.test.ts`:
  - `branch:toggleConversationSelection` outbound → `applyConversationCheckbox` callback invoked with correct args.
  - Same for plan / note toggle.

- `Extension.ts` command-registration tests (or a focused new test file):
  - `jollimemory.selectAllConversations` with mixed state → all flipped to selected (exclusions for visible-set removed).
  - Same command with all-selected state → all flipped to deselected (visible-set added to exclusions).
  - `jollimemory.selectAllPlansAndNotes` covers both plans and notes in one atomic write.

- `ActiveSessionsProvider.test.ts`:
  - `isSelected` is `false` exactly when `commit-selection.json` lists `{source, sessionId}`.
  - `isSelected` defaults to `true` for items not in the exclusion file.

- `FilesStore.test.ts`:
  - Refresh against `raw` of N new files → `selectedPaths.size === N`.
  - User unchecks one → `selectedPaths.size === N-1`.
  - Refresh again with same `raw` → unchecked path stays unchecked (selection survives within session).
  - Refresh with one path removed → `selectedPaths` is pruned to N-1.

- Sidebar webview render (script-builder unit tests):
  - Conversation row with `isSelected:false` renders an unchecked box.
  - Section header icon button renders with the right action id (`conversations-select-all` / `plans-select-all`) and is mapped to the right VSCode command in `cmdMap`.

## Risks & mitigations

- **Exclusion is forever until reverted.** Because exclusion is sticky across commits, amends, restarts, and sessions, a user who unchecks an item once and forgets about it will see that item silently absent from every future summary. Mitigation: the sidebar always reflects the on-disk state, so excluded rows render unchecked — the "I excluded this" intent is always visually surfaced; the section "Select / Deselect All" button is also a one-click escape valve to wipe the visible portion of the exclusion set.

- **VSCode webview CSP blocks inline styles.** Memory note `feedback_vscode_webview_csp_no_inline.md` reminds us: all checkbox styling and event wiring goes through a CSS class + `addEventListener`, never inline `style=""` or `onclick=""`.

- **Template-literal backtick trap.** Per `feedback_sidebar_script_builder_backtick_trap.md`: any new `buildXxx` template literal that mentions JS identifiers in comments must single/double-quote them — backticks inside the literal will silently truncate the script.

- **Lazy-data race.** Per `feedback_lazy_data_trigger_on_all_entrypoints.md`: when `commit-selection.json` is the lazy source for `isSelected`, every entrypoint (initial load, tab switch, post-toggle re-push, post-pipeline refresh) must trigger a re-read.

- **Worktree dual writes.** Two worktrees share the orphan branch but each has its own `.jolli/jollimemory/`. Selection in worktree A does not bleed into worktree B — that's the intended isolation.

- **Test coverage regression.** CLI floor is 97 % statements / 96 % branches. `CommitSelectionStore` must come with a focused test file, and the `QueueWorker.runSummaryPipeline` branches added by the filter step are testable via the existing fixture pattern in `QueueWorker.overlay.test.ts`.

## Out-of-scope follow-ups

These are deliberately deferred — call them out in the PR description so reviewers know they were considered:

- A confirmation toast when committing with > 0 excluded items.
- Keyboard shortcuts on the Select / Deselect All button.
- Exposing the same selection over the IntelliJ plugin. The Kotlin port can be added once the on-disk format is stable; until then IntelliJ commits behave as today (everything included).

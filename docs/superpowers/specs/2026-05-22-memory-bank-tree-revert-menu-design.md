# Memory Bank Tree View — Revert Right-Click Menu — Design

**Status:** Design
**Date:** 2026-05-22
**Branch:** fix-badge-count

## Problem

The Memory Bank sidebar (a webview-rendered tree in `vscode/src/views/SidebarScriptBuilder.ts`) already marks user-edited `.md` files with a trailing `✎` codicon — driven by the `isDiverged` flag on `FolderNode`. But the *only* revert entry points today are:

1. The native VS Code Explorer right-click menu (`contributes.menus.explorer/context` in `vscode/package.json`).
2. The "Edited on disk" `showInformationMessage` toast that fires when the user opens a diverged file from the sidebar.

A user browsing the Memory Bank tree who right-clicks a `✎`-marked row currently gets *no* revert action even though the webview already has a context menu wired for memory files (Copy Recall Prompt / Open in Claude Code / View Memory — `SidebarScriptBuilder.ts:2200-2231`).

## Goal

Add a "Revert to System Version" entry to the Memory Bank tree webview's right-click context menu so users can revert without leaving the sidebar.

## Non-goals

- New backend revert logic. `jollimemory.revertMemoryFileEdits` (Extension.ts:2366-2467) already handles commit / plan / note types and refreshes the `✎` marker on success. We reuse it.
- A confirmation modal. The existing native-menu revert and toast-bar `[Revert]` action both single-click; consistency wins. Revert is reversible (user can re-edit) so the no-modal pattern is acceptable.
- Adding revert to non-tracked files. The menu is gated on manifest membership.
- Cross-surface changes (IntelliJ). The sidebar there is being refactored separately and uses a different (native Swing tree) model.

## Design

### Decisions (confirmed with user)

1. **Visibility**: Revert entry appears only when `isDiverged === true`. Avoids menu clutter on the common path and matches the `✎` marker's gating exactly — if you see the marker, you can revert.
2. **File kinds**: Memory, plan, and note all get the entry. All three are revertable in the backend and all three display `✎`.
3. **Wording**: "Revert to System Version" — matches the success toast `Reverted to system version: <path>` already emitted by Extension.ts:2459.
4. **Menu placement**: After the existing memory-only actions, separated by `{ separator: true }`. For plan/note (which have no other memory-style actions), the menu contains only the Revert entry.

### Component changes

#### 1. `vscode/src/views/SidebarScriptBuilder.ts` — renderer + handler

**Renderer** (line 1354 area, file-node attrs):

Add `data-diverged="1"` to file rows when `child.isDiverged === true`. Directories and non-diverged files omit the attribute (HTML "boolean attr" convention; matches existing `data-current-repo` pattern on line 1353).

**Context menu** (line 2200-2231 area):

Refactor the existing handler so:
- `data-kind === "file"` rows with `data-file-kind ∈ {memory, plan, note}` all enter the menu-building path (currently only `memory`).
- Build the base menu items per file kind:
  - `memory` → existing 3 items (Copy Recall Prompt / Open in Claude Code / View Memory)
  - `plan` / `note` → empty base list
- If `data-diverged === "1"`:
  - If base list is non-empty, append `{ separator: true }`
  - Append `{ label: 'Revert to System Version', command: 'jollimemory.revertMemoryFileByRelPath', args: [relPath] }` where `relPath = node.getAttribute('data-path')`
- If the final list is empty, fall through (no menu shown, native menu suppressed — current behavior for non-revertable files).

#### 2. `vscode/src/Extension.ts` — new wrapper command

Register `jollimemory.revertMemoryFileByRelPath(relPath: string)`:

```ts
vscode.commands.registerCommand(
    "jollimemory.revertMemoryFileByRelPath",
    async (relPath: unknown) => {
        if (typeof relPath !== "string" || relPath.length === 0) return;
        const abs = join(sidebarKbParent, relPath);
        await vscode.commands.executeCommand(
            "jollimemory.revertMemoryFileEdits",
            abs,
        );
    },
),
```

`sidebarKbParent` is the `let`-bound parent path declared at Extension.ts:665 and reassigned by the config-change handler (line 697-698). Reusing the same `join(sidebarKbParent, relPath)` expression that `resolveKbAbs` uses (Extension.ts:851) keeps the wrapper in lockstep with config changes without needing a method on `SidebarWebviewProvider`.

#### 3. Manifest visibility on the wire — already correct

`FolderNode.isDiverged` is already populated by `KbFoldersService.listInRepo` and serialized to the webview via `kb:foldersData`. No protocol changes.

### Data flow (end-to-end)

```
User right-clicks diverged row in webview tree
  → contextmenu handler reads data-path / data-file-kind / data-diverged
  → showContextMenu(...) renders the popup with Revert entry
  → click on Revert → vscode.postMessage({ type: 'command',
                       command: 'jollimemory.revertMemoryFileByRelPath',
                       args: [relPath] })
  → SidebarWebviewProvider.handleOutbound 'command' case
    → executeCommand('jollimemory.revertMemoryFileByRelPath', relPath)
      → resolveKbAbs(relPath) → absPath
      → executeCommand('jollimemory.revertMemoryFileEdits', absPath)
        → existing revert flow (bridge.resolveMemoryFile → forceRegenerate* →
          decorationProvider.refreshUri → sidebarProvider.refreshKnowledgeBaseFolders)
        → ✎ marker disappears on next tree render; toast confirms
```

### Edge cases

- **`relPath === ""`** (root): rejected at the type guard in the wrapper; `data-kind` is `dir` or `repo` for the root and contextmenu only adds Revert for files anyway.
- **`isDiverged` flips between render and click**: harmless — the underlying revert command no-ops gracefully if the file is no longer diverged (or even if it's gone). Toast still shows "Reverted" because the regenerator writes the system version unconditionally; that's the right behavior (re-establishes the manifest fingerprint).
- **`resolveKbAbs` returns nothing** (no current kbRoot): wrapper returns silently. Webview would not be showing folder content in this case anyway.
- **Manifest entry missing** (file under kbRoot but not manifest-tracked): existing `revertMemoryFileEdits` shows the warning toast `cannot revert — file is not under a known kbRoot`. We don't pre-filter on the webview side because `isDiverged` is only set for manifest-tracked files, so this state isn't reachable via the menu.

## Testing

- `vscode/src/views/SidebarScriptBuilder.test.ts`:
  - Render a tree with one diverged file and one non-diverged file → assert only the diverged row carries `data-diverged="1"`.
  - (Existing tests for the `✎` codicon stay; this assertion is on the attribute that drives the new menu logic.)
- `vscode/src/Extension.test.ts`:
  - Register the wrapper command, invoke with a known relPath, assert `revertMemoryFileEdits` is called with the resolved absPath.
  - Invoke with `""` → no-op.
  - Invoke with non-string → no-op.

Coverage stays at or above the existing 97 % bar (the wrapper command is ~10 lines, fully exercised).

## Files changed

| File | Change |
|---|---|
| `vscode/src/views/SidebarScriptBuilder.ts` | Add `data-diverged` attr; extend contextmenu handler to memory/plan/note + Revert entry |
| `vscode/src/Extension.ts` | Register `jollimemory.revertMemoryFileByRelPath` wrapper command (reuses `sidebarKbParent` directly) |
| `vscode/src/views/SidebarScriptBuilder.test.ts` | Assert `data-diverged` attribute on diverged rows |
| `vscode/src/Extension.test.ts` | Behavioral test for wrapper command |
| `vscode/package.json` | (No change — no new menu contributions or commands listed publicly; the wrapper is webview-internal.) |

## Open questions

None.

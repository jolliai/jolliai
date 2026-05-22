# Memory Bank Tree View — Revert Right-Click Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Revert to System Version" entry to the Memory Bank webview's right-click context menu, visible only on `isDiverged === true` file rows, for memory / plan / note kinds.

**Architecture:** Pure UI addition. Renderer emits a new `data-diverged="1"` attribute on diverged file rows; the existing webview `contextmenu` handler grows a conditional entry that posts a generic `command` outbound. A thin extension-side wrapper command resolves the kbRoot-relative path to absolute and delegates to the already-existing `jollimemory.revertMemoryFileEdits`.

**Tech Stack:** TypeScript, Vitest, esbuild, VS Code Extension API.

**Per-task convention (per `feedback_no_per_task_commit_and_test` memory):** Tasks contain code only — write failing test + implementation. **Do not** run `npm` or `git commit` inside task steps. A single Task 4 at the end runs `npm run all` + commit once.

**Spec:** [docs/superpowers/specs/2026-05-22-memory-bank-tree-revert-menu-design.md](../specs/2026-05-22-memory-bank-tree-revert-menu-design.md)

---

### Task 1: Renderer — emit `data-diverged` attribute on diverged file rows

**Files:**
- Modify: `vscode/src/views/SidebarScriptBuilder.ts:1343-1357`
- Modify: `vscode/src/views/SidebarScriptBuilder.test.ts:391-395`

**Why:** The webview's contextmenu handler currently dispatches off `data-file-kind` only. It needs a second axis (divergence) to gate the new Revert entry without making round-trips to the host. Mirrors the existing `data-current-repo` boolean-attr pattern on line 1353.

- [ ] **Step 1: Add the failing test**

In `vscode/src/views/SidebarScriptBuilder.test.ts`, immediately after the existing "attaches data-file-kind and data-key attributes to file tree nodes" test (line 391-395), add:

```ts
	it("emits data-diverged='1' on file tree nodes when isDiverged is true", () => {
		const js = buildSidebarScript();
		// The renderer must add the attribute conditional on child.isDiverged,
		// not unconditionally — the contextmenu handler uses its presence as
		// the gating signal for the Revert entry.
		expect(js).toContain("child.isDiverged");
		expect(js).toContain("data-diverged");
		expect(js).toContain("'1'");
	});
```

Expected: FAIL — `data-diverged` does not appear in the generated source string yet.

- [ ] **Step 2: Implement — add the attribute in renderFolderChildren**

In `vscode/src/views/SidebarScriptBuilder.ts`, find lines 1343-1357 (the `attrs = { ... }` block inside `renderFolderChildren`). Currently the file-only branch reads:

```js
      if (!isDir) {
        attrs['data-file-kind'] = fileKind;
        if (child.fileKey) attrs['data-key'] = child.fileKey;
      }
```

Change it to also set `data-diverged` when truthy:

```js
      if (!isDir) {
        attrs['data-file-kind'] = fileKind;
        if (child.fileKey) attrs['data-key'] = child.fileKey;
        // Drives the conditional "Revert to System Version" entry in the
        // right-click contextmenu. Mirrors the ✎ codicon below (line 1425+):
        // if the marker shows, the menu entry shows. Boolean-attr convention
        // — presence means true, absence means false — same as the
        // data-current-repo flag on the repo-root container above.
        if (child.isDiverged) attrs['data-diverged'] = '1';
      }
```

The test from Step 1 now passes (`buildSidebarScript()` includes the new lines as plain JS text).

---

### Task 2: Context menu handler — add conditional Revert entry for memory/plan/note

**Files:**
- Modify: `vscode/src/views/SidebarScriptBuilder.ts:2200-2231`
- Modify: `vscode/src/views/SidebarScriptBuilder.test.ts:397-406`

**Why:** Today the contextmenu only fires for `data-file-kind === 'memory'` and shows a fixed 3-item menu. The new Revert entry must (a) extend the eligible kinds to memory/plan/note, (b) appear only when `data-diverged === "1"`, (c) sit at the bottom of the menu separated by `{ separator: true }` when other entries precede it.

- [ ] **Step 1: Update the existing right-click test to reflect new behavior**

In `vscode/src/views/SidebarScriptBuilder.test.ts:397-406`, the existing test currently reads:

```ts
	it("right-click on a folder tree-node preventDefaults but shows no menu unless it's a memory file", () => {
		const js = buildSidebarScript();
		// The contextmenu handler must check data-file-kind === 'memory' before
		// opening a custom menu — directories and non-memory files are silent.
		expect(js).toContain("data-file-kind");
		expect(js).toContain("'memory'");
		expect(js).toContain("jollimemory.copyRecallPrompt");
		expect(js).toContain("jollimemory.openInClaudeCode");
		expect(js).toContain("jollimemory.viewMemorySummary");
	});
```

Replace with:

```ts
	it("right-click on a folder tree-node opens menu for memory/plan/note files, silent on dirs / other", () => {
		const js = buildSidebarScript();
		// Memory rows still get the legacy 3-action menu, keyed off manifest hash.
		expect(js).toContain("data-file-kind");
		expect(js).toContain("'memory'");
		expect(js).toContain("jollimemory.copyRecallPrompt");
		expect(js).toContain("jollimemory.openInClaudeCode");
		expect(js).toContain("jollimemory.viewMemorySummary");
		// Plan and note rows now also enter the menu-building path so they can
		// receive the conditional Revert entry. The renderer recognises all
		// three manifest-tracked kinds as menu-eligible.
		expect(js).toContain("'plan'");
		expect(js).toContain("'note'");
	});

	it("contextmenu appends Revert entry only when data-diverged='1'", () => {
		const js = buildSidebarScript();
		// The Revert entry is gated on the attribute set in Task 1; without
		// it the menu is unchanged for non-edited files.
		expect(js).toContain("data-diverged");
		expect(js).toContain("Revert to System Version");
		// Wrapper command is the relPath-aware variant; the abs-path form
		// `revertMemoryFileEdits` is invoked indirectly from the extension side.
		expect(js).toContain("jollimemory.revertMemoryFileByRelPath");
	});
```

Expected: FAIL — `data-diverged`, `'plan'`, `'note'`, `Revert to System Version`, and `jollimemory.revertMemoryFileByRelPath` are not yet in the contextmenu handler.

- [ ] **Step 2: Implement — rewrite the contextmenu file-row branch**

In `vscode/src/views/SidebarScriptBuilder.ts`, find lines 2200-2231 (the `tabContents.kb.addEventListener('contextmenu', ...)` handler) and locate the branch starting at line 2202:

```js
    if (node) {
      e.preventDefault();
      dismissHoverCard();
      if (node.getAttribute('data-kind') !== 'file') return;
      if (node.getAttribute('data-file-kind') !== 'memory') return;
      const key = node.getAttribute('data-key');
      if (!key) return;
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Copy Recall Prompt',  command: 'jollimemory.copyRecallPrompt',  args: [key] },
        { label: 'Open in Claude Code', command: 'jollimemory.openInClaudeCode',  args: [key] },
        { separator: true },
        { label: 'View Memory',         command: 'jollimemory.viewMemorySummary', args: [key] },
      ]);
      return;
    }
```

Replace with:

```js
    if (node) {
      e.preventDefault();
      dismissHoverCard();
      if (node.getAttribute('data-kind') !== 'file') return;
      const fileKind = node.getAttribute('data-file-kind');
      // Build menu items per file kind. memory carries the legacy 3-action
      // set keyed off the manifest hash; plan / note are revert-only and
      // start with an empty base list.
      const items = [];
      if (fileKind === 'memory') {
        const key = node.getAttribute('data-key');
        if (!key) return;
        items.push({ label: 'Copy Recall Prompt',  command: 'jollimemory.copyRecallPrompt',  args: [key] });
        items.push({ label: 'Open in Claude Code', command: 'jollimemory.openInClaudeCode',  args: [key] });
        items.push({ separator: true });
        items.push({ label: 'View Memory',         command: 'jollimemory.viewMemorySummary', args: [key] });
      } else if (fileKind !== 'plan' && fileKind !== 'note') {
        // Untracked / other files — keep current silent-no-menu behavior so
        // the native browser context menu (Cut/Copy/Reload) also stays
        // suppressed by the preventDefault above.
        return;
      }
      // Append Revert when the renderer flagged this row as diverged. The
      // data-diverged='1' attribute is set in renderFolderChildren above
      // mirroring the ✎ codicon — so menu visibility tracks the marker
      // exactly. relPath drives the kbRoot-relative wrapper command which
      // resolves to an abs path host-side before delegating to the
      // existing jollimemory.revertMemoryFileEdits handler.
      if (node.getAttribute('data-diverged') === '1') {
        const relPath = node.getAttribute('data-path');
        if (relPath) {
          if (items.length > 0) items.push({ separator: true });
          items.push({ label: 'Revert to System Version', command: 'jollimemory.revertMemoryFileByRelPath', args: [relPath] });
        }
      }
      if (items.length === 0) return;
      showContextMenu(e.clientX, e.clientY, items);
      return;
    }
```

Tests from Step 1 now pass — all the asserted literals are present in `buildSidebarScript()` output.

---

### Task 3: Register `jollimemory.revertMemoryFileByRelPath` wrapper command

**Files:**
- Modify: `vscode/src/Extension.ts:2366-2467` (insert new command registration adjacent to existing revert command)
- Modify: `vscode/src/Extension.test.ts:3653` (add new describe block adjacent to `revertMemoryFileEdits` tests)

**Why:** The webview only knows kbRoot-relative paths (`data-path`). The existing revert command takes `absPath`. Adding a thin wrapper that resolves via the same `join(sidebarKbParent, relPath)` expression `resolveKbAbs` uses keeps the wrapper aligned with config-change re-bindings of `sidebarKbParent`.

- [ ] **Step 1: Add the failing test**

In `vscode/src/Extension.test.ts`, find the `describe("revertMemoryFileEdits", () => { ... })` block (starting around line 3653). Immediately after that block closes, add:

```ts
		// ── revertMemoryFileByRelPath (webview wrapper) ──────────────────────
		// Webview's right-click "Revert to System Version" menu posts the
		// kbRoot-relative path back to the host. This wrapper resolves it to
		// abs via the same `join(sidebarKbParent, relPath)` expression
		// `resolveKbAbs` uses, then delegates to the abs-path command above.
		describe("revertMemoryFileByRelPath", () => {
			it("resolves relPath under sidebarKbParent and delegates to revertMemoryFileEdits", async () => {
				const handler = getRegisteredCommand(
					"jollimemory.revertMemoryFileByRelPath",
				);
				await handler("repo/main/foo-abcdef12.md");
				expect(executeCommand).toHaveBeenCalledWith(
					"jollimemory.revertMemoryFileEdits",
					"/test/kb-parent/repo/main/foo-abcdef12.md",
				);
			});

			it("no-ops on empty string relPath without calling the abs command", async () => {
				const handler = getRegisteredCommand(
					"jollimemory.revertMemoryFileByRelPath",
				);
				executeCommand.mockClear();
				await handler("");
				expect(executeCommand).not.toHaveBeenCalledWith(
					"jollimemory.revertMemoryFileEdits",
					expect.anything(),
				);
			});

			it("no-ops on non-string input", async () => {
				const handler = getRegisteredCommand(
					"jollimemory.revertMemoryFileByRelPath",
				);
				executeCommand.mockClear();
				await handler(undefined);
				await handler(42);
				expect(executeCommand).not.toHaveBeenCalledWith(
					"jollimemory.revertMemoryFileEdits",
					expect.anything(),
				);
			});
		});
```

Expected: FAIL — `getRegisteredCommand("jollimemory.revertMemoryFileByRelPath")` returns undefined; calling `undefined(...)` throws.

- [ ] **Step 2: Register the wrapper command**

In `vscode/src/Extension.ts`, find the end of the `vscode.commands.registerCommand("jollimemory.revertMemoryFileEdits", ...)` registration at line 2467 (closing `),` of that registerCommand call). Immediately after that line, insert a new registration:

```ts
			// Webview-facing variant of revertMemoryFileEdits. The Memory Bank
			// sidebar's right-click menu only knows kbRoot-relative paths
			// (`FolderNode.relPath` → `data-path` attribute), so we resolve
			// here using the same `join(sidebarKbParent, relPath)` expression
			// `resolveKbAbs` uses (line 851) — keeping the wrapper aligned
			// with config-change re-binds of `sidebarKbParent`. Bad input is
			// dropped silently (matches the abs-path command's defensive
			// guard pattern at line 2369).
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

Verify `join` is already imported at the top of Extension.ts (it's used at line 851 for `resolveKbAbs`, so no new import needed).

Tests from Step 1 now pass.

---

### Task 4: Final verification + commit

**Files:** none (orchestration only)

**Why:** Per the user's `feedback_no_per_task_commit_and_test` convention, the build / lint / test pipeline and commit step run once at the end rather than per task.

- [ ] **Step 1: Run the full pre-commit gate**

```bash
cd /Users/flyer/jolli/code/jollimemory-worktrees/feature-wt1
npm run all
```

Expected: clean → build → lint → test all pass. CLI coverage threshold (97 % statements / 96 % branches / 97 % functions / 97 % lines) holds; VS Code workspace tests pass.

If `npm run all` fails:
- Lint errors → `npm run lint:fix` then re-run.
- Test failures → fix in place (do not loosen assertions to make red green).
- Build errors → re-check Task 2 / Task 3 code blocks against the literal expressions the tests assert on.

- [ ] **Step 2: Commit**

Stage only the four touched files plus the spec & plan docs:

```bash
git add \
  vscode/src/views/SidebarScriptBuilder.ts \
  vscode/src/views/SidebarScriptBuilder.test.ts \
  vscode/src/Extension.ts \
  vscode/src/Extension.test.ts \
  docs/superpowers/specs/2026-05-22-memory-bank-tree-revert-menu-design.md \
  docs/superpowers/plans/2026-05-22-memory-bank-tree-revert-menu.md
```

```bash
git commit -s -m "$(cat <<'EOF'
Add Revert action to Memory Bank tree view right-click menu

The Memory Bank sidebar already shows a ✎ codicon on user-edited
.md rows, but right-clicking a diverged row offered no path back to
the system version. Native Explorer-context menu and the "Edited
on disk" toast already carried Revert; the webview tree did not.

- Renderer emits data-diverged="1" on FolderNodes flagged by
  KbFoldersService.computeIsDiverged, mirroring the ✎ marker.
- Webview contextmenu handler grows a conditional "Revert to System
  Version" entry for memory / plan / note rows when the attribute
  is present. memory rows keep the existing 3-action menu above
  the separator; plan / note rows had no menu before and now show
  Revert only.
- New jollimemory.revertMemoryFileByRelPath wrapper command
  resolves kbRoot-relative paths via the same join(sidebarKbParent,
  relPath) expression resolveKbAbs uses, then delegates to the
  existing jollimemory.revertMemoryFileEdits abs-path command —
  no new backend logic, no protocol extension.

Signed-off-by: Flyer Li <flyer.li@jolli.ai>
EOF
)"
```

**Critical:** Do NOT use `--no-verify`. Do NOT include `Co-Authored-By: Claude …` or `🤖 Generated with …` footers — only the DCO `Signed-off-by:` trailer. (See [CLAUDE.md](../../../CLAUDE.md) Critical rules + `feedback_no_claude_coauthor` memory.)

---

## Self-review

- **Spec coverage:** Renderer attr (Task 1), menu wiring (Task 2), wrapper command (Task 3), commit pipeline (Task 4). All four "Files changed" rows in the spec map to a task.
- **No placeholders:** every code block is literal. No "TBD" / "add appropriate error handling" / "similar to Task N".
- **Type consistency:** command name `jollimemory.revertMemoryFileByRelPath` is used in Task 2 (menu wiring), Task 3 (command registration + tests), and Task 4 (commit msg). `data-diverged="1"` (string) is used in Task 1 (renderer) and Task 2 (handler attribute check). `sidebarKbParent` and `join` are existing identifiers in Extension.ts; Task 3 reuses them.

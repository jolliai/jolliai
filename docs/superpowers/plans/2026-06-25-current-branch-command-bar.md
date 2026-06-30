# Current Branch Command Bar + Branch Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Current Branch view's sticky bottom command bar (`Commit | Create PR | ⋯`), move the commit action into it (removing the in-section button), and add branch-level **Recall in Claude Code** / **Copy recall prompt for other tools** (in the `⋯` menu) backed by two new host commands.

**Architecture:** Pure sidebar-webview presentation + message dispatch (`SidebarScriptBuilder`/`SidebarCssBuilder`) plus two thin host commands in `Extension.ts` backed by a shared `buildBranchRecallPrompt` helper that reuses `compileTaskContext` + `renderContextMarkdown` (CLI core, bundled). The Create PR button dispatches the `jollimemory.createPrForBranch` command built in the **Create PR Pane** plan (prerequisite).

**Tech Stack:** TypeScript ESM (bundled to CJS), Vitest + coverage-v8, Biome, `vscode` webview API.

**Prerequisite:** `docs/superpowers/plans/2026-06-25-create-pr-pane.md` must be implemented first (it registers `jollimemory.createPrForBranch`). The footer's Create PR button targets that command.

## Global Constraints

- DCO sign-off (`git commit -s`). No `Co-Authored-By: Claude` / `🤖 Generated with` trailers.
- `npm run all` must pass before commit. vscode coverage threshold **97%** (all four metrics).
- Biome: tabs, 120 cols; `noExplicitAny`/`noUnusedImports`/`noUnusedVariables` are errors; warnings fail.
- Webview CSP: **no inline `style=` / inline handlers.** Show/hide via the `.hidden` class (never the HTML `hidden` attribute or `el.hidden = x` — `display:flex` overrides it). Events via the existing delegated `tabContents.branch` click listener / `data-action` attributes.
- Before deleting a `classList.toggle('hidden', x)`, check the HTML's initial `.hidden` state (toggle does double duty).
- Single-row tree updates must not call `foldersReset`; not relevant here but keep delegated handlers precise.
- `/* v8 ignore start/stop */` blocks for unavoidable coverage gaps (single-line `ignore next` does not work in this package).

---

### Task 1: `buildBranchRecallPrompt` helper

A shared async helper that compiles the current branch's recall context to a markdown prompt string. Used by both recall commands; isolated for unit testing without `vscode`.

**Files:**
- Create: `vscode/src/views/BranchRecall.ts`
- Test: `vscode/src/views/BranchRecall.test.ts`

**Interfaces:**
- Consumes: `compileTaskContext(options, cwd)` and `renderContextMarkdown(ctx, budget?)` from `../../../cli/src/core/ContextCompiler.js`.
- Produces:
```ts
export async function buildBranchRecallPrompt(
	cwd: string,
	branch: string,
): Promise<{ prompt: string; commitCount: number }>;
```

- [ ] **Step 1: Write the failing test**

```ts
// vscode/src/views/BranchRecall.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../cli/src/core/ContextCompiler.js", () => ({
	compileTaskContext: vi.fn().mockResolvedValue({ commitCount: 0 }),
	renderContextMarkdown: vi.fn().mockReturnValue("# Recall\n"),
}));

import { compileTaskContext, renderContextMarkdown } from "../../../cli/src/core/ContextCompiler.js";
import { buildBranchRecallPrompt } from "./BranchRecall";

describe("buildBranchRecallPrompt", () => {
	it("returns commitCount 0 and skips markdown render when the branch is empty", async () => {
		const res = await buildBranchRecallPrompt("/repo", "feature/x");
		expect(res.commitCount).toBe(0);
		expect(res.prompt).toBe("");
		expect(renderContextMarkdown).not.toHaveBeenCalled();
		expect(compileTaskContext).toHaveBeenCalledWith({ branch: "feature/x" }, "/repo");
	});

	it("renders the markdown prompt when commits exist", async () => {
		(compileTaskContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ commitCount: 3 });
		const res = await buildBranchRecallPrompt("/repo", "feature/x");
		expect(res.commitCount).toBe(3);
		expect(res.prompt).toBe("# Recall\n");
		expect(renderContextMarkdown).toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run (from `vscode/`): `node ./scripts/run-vitest.mjs run src/views/BranchRecall.test.ts`
Expected: FAIL — `buildBranchRecallPrompt` not found.

- [ ] **Step 3: Implement**

```ts
// vscode/src/views/BranchRecall.ts
import { compileTaskContext, renderContextMarkdown } from "../../../cli/src/core/ContextCompiler.js";

export async function buildBranchRecallPrompt(
	cwd: string,
	branch: string,
): Promise<{ prompt: string; commitCount: number }> {
	const ctx = await compileTaskContext({ branch }, cwd);
	if (ctx.commitCount === 0) return { prompt: "", commitCount: 0 };
	return { prompt: renderContextMarkdown(ctx), commitCount: ctx.commitCount };
}
```

> **Implementer note:** confirm `compileTaskContext`'s first arg shape — it takes `ContextOptions`; `{ branch }` is the minimal form (other fields optional). Grep `ContextOptions` in `ContextCompiler.ts` and pass only `branch` unless a token budget is wanted (then add `tokenBudget: DEFAULT_TOKEN_BUDGET`).

- [ ] **Step 4: Run to verify pass**

Run: `node ./scripts/run-vitest.mjs run src/views/BranchRecall.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/BranchRecall.ts vscode/src/views/BranchRecall.test.ts
git commit -s -m "feat(vscode): branch-level recall prompt builder"
```

---

### Task 2: Register `recallBranchInClaudeCode` + `copyBranchRecallPrompt` commands

**Files:**
- Modify: `vscode/src/Extension.ts` (register near `openInClaudeCode` / `copyRecallPrompt`)
- Test: extend the existing command test file if present (grep `openInClaudeCode` in `vscode/src/*.test.ts`); else add `vscode/src/Extension.recall.test.ts`.

**Interfaces:**
- Consumes: `buildBranchRecallPrompt` (Task 1), `bridge.getCurrentBranch()`, `workspaceRoot`, `vscode.env.openExternal`, `vscode.env.clipboard.writeText`.
- Produces: command ids `jollimemory.recallBranchInClaudeCode`, `jollimemory.copyBranchRecallPrompt`.

- [ ] **Step 1: Write the failing test**

```ts
// vscode/src/Extension.recall.test.ts (or extend existing command test)
import { describe, expect, it, vi } from "vitest";

const openExternal = vi.fn();
const writeText = vi.fn();
const showInformationMessage = vi.fn();
vi.mock("vscode", () => ({
	Uri: { parse: (s: string) => ({ toString: () => s }) },
	env: { openExternal, clipboard: { writeText } },
	window: { showInformationMessage, createOutputChannel: () => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() }) },
	commands: { registerCommand: (_id: string, _cb: unknown) => ({ dispose() {} }) },
}));
vi.mock("./views/BranchRecall.js", () => ({ buildBranchRecallPrompt: vi.fn() }));

import { buildBranchRecallPrompt } from "./views/BranchRecall.js";
// Import the small command factory you extract in Step 3:
import { runRecallInClaudeCode, runCopyBranchRecallPrompt } from "./commands/BranchRecallCommands.js";

const bridge = { getCurrentBranch: vi.fn().mockResolvedValue("feature/x") } as never;

describe("branch recall commands", () => {
	it("recallInClaudeCode opens the Claude Code URI with the prompt", async () => {
		(buildBranchRecallPrompt as ReturnType<typeof vi.fn>).mockResolvedValue({ prompt: "P", commitCount: 2 });
		await runRecallInClaudeCode(bridge, "/repo");
		expect(openExternal).toHaveBeenCalledTimes(1);
		expect(openExternal.mock.calls[0][0].toString()).toContain("anthropic.claude-code/open?prompt=");
	});

	it("recallInClaudeCode shows an info message and does not open when branch is empty", async () => {
		(buildBranchRecallPrompt as ReturnType<typeof vi.fn>).mockResolvedValue({ prompt: "", commitCount: 0 });
		await runRecallInClaudeCode(bridge, "/repo");
		expect(openExternal).not.toHaveBeenCalled();
		expect(showInformationMessage).toHaveBeenCalled();
	});

	it("copyBranchRecallPrompt writes the prompt to the clipboard", async () => {
		(buildBranchRecallPrompt as ReturnType<typeof vi.fn>).mockResolvedValue({ prompt: "P", commitCount: 1 });
		await runCopyBranchRecallPrompt(bridge, "/repo");
		expect(writeText).toHaveBeenCalledWith("P");
	});

	it("copyBranchRecallPrompt skips clipboard + warns when empty", async () => {
		(buildBranchRecallPrompt as ReturnType<typeof vi.fn>).mockResolvedValue({ prompt: "", commitCount: 0 });
		await runCopyBranchRecallPrompt(bridge, "/repo");
		expect(writeText).not.toHaveBeenCalled();
		expect(showInformationMessage).toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node ./scripts/run-vitest.mjs run src/Extension.recall.test.ts`
Expected: FAIL — `./commands/BranchRecallCommands.js` not found.

- [ ] **Step 3: Implement the command factory + register**

```ts
// vscode/src/commands/BranchRecallCommands.ts
import * as vscode from "vscode";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import { buildBranchRecallPrompt } from "../views/BranchRecall.js";

const EMPTY_MSG = "No Jolli Memory records on this branch yet.";

export async function runRecallInClaudeCode(bridge: JolliMemoryBridge, cwd: string): Promise<void> {
	const branch = await bridge.getCurrentBranch();
	const { prompt, commitCount } = await buildBranchRecallPrompt(cwd, branch);
	if (commitCount === 0) { await vscode.window.showInformationMessage(EMPTY_MSG); return; }
	const uri = vscode.Uri.parse(`vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`);
	await vscode.env.openExternal(uri);
}

export async function runCopyBranchRecallPrompt(bridge: JolliMemoryBridge, cwd: string): Promise<void> {
	const branch = await bridge.getCurrentBranch();
	const { prompt, commitCount } = await buildBranchRecallPrompt(cwd, branch);
	if (commitCount === 0) { await vscode.window.showInformationMessage(EMPTY_MSG); return; }
	await vscode.env.clipboard.writeText(prompt);
	await vscode.window.showInformationMessage("Recall prompt copied — paste it into Codex, Cursor, or any AI tool.");
}
```
In `Extension.ts` (near `openInClaudeCode`):
```ts
import { runCopyBranchRecallPrompt, runRecallInClaudeCode } from "./commands/BranchRecallCommands.js";
// …
vscode.commands.registerCommand("jollimemory.recallBranchInClaudeCode", () => runRecallInClaudeCode(bridge, workspaceRoot)),
vscode.commands.registerCommand("jollimemory.copyBranchRecallPrompt", () => runCopyBranchRecallPrompt(bridge, workspaceRoot)),
```

- [ ] **Step 4: Run to verify pass**

Run: `node ./scripts/run-vitest.mjs run src/Extension.recall.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add vscode/src/commands/BranchRecallCommands.ts vscode/src/Extension.ts vscode/src/Extension.recall.test.ts
git commit -s -m "feat(vscode): branch-level recall commands (Claude Code + copy prompt)"
```

---

### Task 3: Render the Current Branch command bar (footer)

Add the `.branch-footer` to `renderBranch()` and remove the in-section commit button.

**Files:**
- Modify: `vscode/src/views/SidebarScriptBuilder.ts` — add `renderBranchFooter()`, append it in `renderBranch()` (workspace mode only), remove the `renderCommitMemoryButton` mount from the `changes` section path, add footer click delegation + the `⋯` menu.
- Modify: `vscode/src/views/SidebarCssBuilder.ts` — `.branch-footer` styles.
- Test: `vscode/src/views/SidebarScriptBuilder.test.ts`, `vscode/src/views/SidebarCssBuilder.test.ts`.

**Interfaces:**
- Consumes (existing in-file helpers): `el(tag, attrs, children)`, `iconButton(id, title, codicon, opts?)`, `showContextMenu(x, y, items)`, `isViewingForeign()`, `isWorkerBlocking()`, `branchData.changes`, `branchData.commits`, `mountIn`.
- Produces: `renderBranchFooter()` returning a `.branch-footer` DOM node; the footer posts `{ type: 'command', command: 'jollimemory.commitAI' }` (Commit), `{ type: 'command', command: 'jollimemory.createPrForBranch' }` (Create PR), and opens `showContextMenu` with the two recall items (⋯).

- [ ] **Step 1: Write the failing test (script builder)**

```ts
// add to vscode/src/views/SidebarScriptBuilder.test.ts
it("Current Branch renders a bottom command bar with Commit, Create PR and ⋯", () => {
	const js = buildSidebarScript(/* existing args used by sibling tests */);
	expect(js).toContain("branch-footer");
	expect(js).toContain("jollimemory.createPrForBranch");
	expect(js).toContain("jollimemory.recallBranchInClaudeCode");
	expect(js).toContain("jollimemory.copyBranchRecallPrompt");
});
it("no longer mounts the in-section Commit Memory button", () => {
	const js = buildSidebarScript(/* … */);
	// The old bottom-of-Changes CTA helper is gone; footer owns commit now.
	expect(js).not.toContain("renderCommitMemoryButton");
	expect(js).not.toContain("commit-memory-action");
});
```

> **Implementer note:** match the exact `buildSidebarScript(...)` call shape used by neighbouring tests in this file. These are string-contains assertions against the generated script (the builder returns one template literal); per the project's "backtick trap" rule, do not put backticks in comments inside that literal.

- [ ] **Step 2: Run to verify failure**

Run: `node ./scripts/run-vitest.mjs run src/views/SidebarScriptBuilder.test.ts -t "command bar"`
Expected: FAIL.

- [ ] **Step 3: Implement footer render + remove old button**

In `SidebarScriptBuilder.ts`:
1. Delete `renderCommitMemoryButton` and its mount in `renderSection`'s `s.id === 'changes'` branch (the `sectionKids.push(renderCommitMemoryButton())`), and the `commit-memory-btn` click block in the `tabContents.branch` listener.
2. Add a `renderBranchFooter()`:
```js
function renderBranchFooter() {
  var changes = branchData.changes || [];
  var selectedCount = changes.filter(function (c) { return !!c.isSelected; }).length;
  var commitDisabled = selectedCount === 0 || isWorkerBlocking();
  var prDisabled = (branchData.commits || []).length === 0;
  var commitBtn = el('button', {
    className: 'cmd-btn primary', 'data-action': 'footer-commit', 'aria-label': 'Commit',
  }, [el('i', { className: 'codicon codicon-sparkle' }), el('span', { text: 'Commit' })]);
  if (commitDisabled) commitBtn.disabled = true;
  var prBtn = el('button', {
    className: 'cmd-btn', 'data-action': 'footer-create-pr', 'aria-label': 'Create PR',
  }, [el('i', { className: 'codicon codicon-git-pull-request' }), el('span', { text: 'Create PR' })]);
  if (prDisabled) prBtn.disabled = true;
  var moreBtn = el('button', {
    className: 'cmd-btn aa-more', 'data-action': 'footer-more', 'aria-label': 'More branch actions',
  }, [el('i', { className: 'codicon codicon-ellipsis' })]);
  return el('div', { className: 'branch-footer' }, [commitBtn, prBtn, moreBtn]);
}
```
3. In `renderBranch()`, after `nodesToMount.push(renderSection(committedMemoriesSection));`, append the footer only in workspace mode:
```js
mountIn(container, nodesToMount);
if (!foreign) {
  // Footer is a sticky sibling of the scrolling sections; appended last so it
  // pins to the bottom of the branch view. Hidden in foreign read-only mode.
  container.appendChild(renderBranchFooter());
}
```
4. In the `tabContents.branch` click listener, add (before the section-header collapse catch-all):
```js
var footerCommit = e.target.closest('.cmd-btn[data-action="footer-commit"]');
if (footerCommit && !footerCommit.disabled) {
  vscode.postMessage({ type: 'command', command: 'jollimemory.commitAI' });
  e.stopPropagation(); return;
}
var footerPr = e.target.closest('.cmd-btn[data-action="footer-create-pr"]');
if (footerPr && !footerPr.disabled) {
  vscode.postMessage({ type: 'command', command: 'jollimemory.createPrForBranch' });
  e.stopPropagation(); return;
}
var footerMore = e.target.closest('.cmd-btn[data-action="footer-more"]');
if (footerMore) {
  var r = footerMore.getBoundingClientRect();
  // Open upward: showContextMenu clamps to viewport, so passing the button top
  // lets the menu sit above the footer rather than off-screen below it.
  showContextMenu(r.left, Math.max(0, r.top - 4), [
    { label: 'Recall in Claude Code', command: 'jollimemory.recallBranchInClaudeCode', args: [] },
    { label: 'Copy recall prompt for other tools', command: 'jollimemory.copyBranchRecallPrompt', args: [] },
  ]);
  e.stopPropagation(); return;
}
```

- [ ] **Step 4: CSS — add `.branch-footer`**

In `SidebarCssBuilder.ts`:
```css
.branch-footer {
  position: sticky;
  bottom: 0;
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 8px;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
}
.branch-footer .cmd-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 2px;
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  cursor: pointer;
}
.branch-footer .cmd-btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.branch-footer .cmd-btn:disabled { opacity: 0.5; cursor: default; }
.branch-footer .cmd-btn.aa-more { margin-left: auto; }
```
Add a `SidebarCssBuilder.test.ts` assertion:
```ts
it("styles the Current Branch command-bar footer", () => {
	const css = buildSidebarCss();
	expect(css).toContain(".branch-footer");
	expect(css).toMatch(/\.branch-footer\s*{[^}]*position:\s*sticky/);
});
```

- [ ] **Step 5: Run to verify pass**

Run: `node ./scripts/run-vitest.mjs run src/views/SidebarScriptBuilder.test.ts src/views/SidebarCssBuilder.test.ts`
Expected: PASS. Fix any sibling test that asserted on the now-removed `commit-memory-action` button (update it to assert the footer Commit button instead).

- [ ] **Step 6: Commit**

```bash
git add vscode/src/views/SidebarScriptBuilder.ts vscode/src/views/SidebarCssBuilder.ts vscode/src/views/SidebarScriptBuilder.test.ts vscode/src/views/SidebarCssBuilder.test.ts
git commit -s -m "feat(vscode): Current Branch bottom command bar (Commit | Create PR | More)"
```

---

### Task 4: Foreign-mode hiding + disabled-state regression tests

Lock the contract: footer present in workspace mode, absent in foreign read-only mode; Commit disabled with no selection / worker busy; Create PR disabled with no committed memories.

**Files:**
- Test: `vscode/src/views/SidebarScriptBuilder.test.ts`

- [ ] **Step 1: Add tests**

```ts
it("omits the command bar in foreign read-only mode", () => {
	// Drive renderBranch via the foreign-selection path the sibling foreign
	// tests use (set state.selectedRepoName !== currentRepoName), then assert
	// the rendered DOM/string has no .branch-footer in that mode.
	// (Mirror the existing foreign-mode test harness in this file.)
});
it("disables Create PR when the branch has no committed memories", () => {
	// branchData.commits = [] → prBtn.disabled true.
});
```
Fill these using the file's existing render-harness (the sibling tests already construct `branchData` / `state` and invoke the render path). Match their exact setup.

- [ ] **Step 2: Run**

Run: `node ./scripts/run-vitest.mjs run src/views/SidebarScriptBuilder.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add vscode/src/views/SidebarScriptBuilder.test.ts
git commit -s -m "test(vscode): command-bar foreign-hide + disabled-state contracts"
```

---

### Task 5: Full gate + manual smoke

- [ ] **Step 1: Full chain**

Run (repo root): `npm run all`
Expected: clean → build → lint → test pass; vscode coverage ≥ 97% (all metrics). Add focused tests for any uncovered footer branch.

- [ ] **Step 2: Manual smoke (built artifact)**

`cd vscode && npm run build` → **Developer: Reload Window**. On a branch with staged changes + ≥1 committed memory:
- Footer shows `Commit | Create PR | ⋯` pinned at the bottom; content scrolls behind it.
- Commit fires AI-commit; Create PR opens the pane (from the prerequisite plan); ⋯ shows the two recall items and they open Claude Code / copy the prompt.
- Switch to a foreign repo/branch via the breadcrumb → footer disappears.
- The old in-section "Commit Memory" button is gone.

- [ ] **Step 3: Commit any final coverage tests**

```bash
git add vscode/src/views/*.test.ts
git commit -s -m "test(vscode): cover command-bar edge cases"
```

---

## Self-Review

**Spec coverage (§ from `2026-06-25-…-design.md`):**
- §4.1 mount + sticky + foreign-hide → Task 3 Step 3 + Task 4. §4.2 buttons + disabled rules + remove in-section button → Task 3. §4.2 `⋯` menu items → Task 3 Step 3. §5.1 `buildBranchRecallPrompt` → Task 1. §5.2/§5.3 recall commands → Task 2. Create PR button → dispatches `jollimemory.createPrForBranch` (prerequisite plan).
- §2 out-of-scope: no split-button, no `⋯ More` long-tail, no Share — honored (only two recall items; Create PR + Commit).

**Placeholder scan:** Task 4 step bodies are intentionally harness-dependent (the file's existing foreign/render harness must be matched) and flagged as such with the exact state to set — not silent TODOs. Every code-bearing step (Tasks 1–3) has complete code.

**Type consistency:** command ids are spelled identically across Task 2 (registration), Task 3 (footer dispatch), and the prerequisite plan (`jollimemory.createPrForBranch`). `data-action` values (`footer-commit`/`footer-create-pr`/`footer-more`) match between `renderBranchFooter` and the click delegation. `showContextMenu(x, y, items)` item shape (`{ label, command, args }`) matches the existing helper.

**Cross-plan dependency:** Create PR button is inert until the prerequisite plan registers `jollimemory.createPrForBranch`; sequence the prerequisite first (noted in header).

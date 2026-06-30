# Current Branch panel — mockup alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the VS Code sidebar **Current Branch** view to the `jollimemory-design` master mock — relocate Commit into a body `Commit Memory | Review` pair, reshape the footer to `Create PR | Share | ⋯`, add a Committed Memories token bar, and enrich Working Memory rows.

**Architecture:** Mostly webview-only changes in `vscode/src/views/SidebarScriptBuilder.ts` (DOM builders) + `SidebarCssBuilder.ts` (styles), asserted by substring tests on `buildSidebarScript()` / `buildSidebarCss()`. Two host additions: a new `branch:tokenStats` inbound message (aggregated in `SidebarWebviewProvider`) and two new commands (`reviewNextMemory` opening a new `NextMemoryPreviewPanel`, `shareBranchPlaceholder` showing an info message), wired in `Extension.ts`.

**Tech Stack:** TypeScript (ESM in `cli`, esbuild→CJS in `vscode`), Vitest, Biome (tabs, 120 cols), VS Code webview API. The sidebar script is a single template-literal string built by `buildSidebarScript()`; the DOM is built via the `el(tag, attrs, children)` helper. Tests assert on the **emitted JS string** via `expect(js).toContain(...)`.

## Global Constraints

- **DCO sign-off on every commit** — `git commit -s`. No `Co-Authored-By: Claude …` / `🤖 Generated with …` trailers.
- **`npm run all` must pass before commit** (clean → build → lint → test). Run it once at the end, not per task (project convention: no per-task run/commit; write code per task, batch `npm run all` + commits at the end of a review checkpoint).
- **Do not regress CLI coverage** — code under `cli/src/` held to 97% stmts / 96% branches / 97% funcs / 97% lines. (This plan adds no `cli/src` code; token aggregation lives in `vscode/src`.)
- **Webview CSP:** no inline `style=` / inline event handlers. Dynamic styles via CSS class; events via the existing delegated click handler on `tabContents.branch` + `data-action` attributes. Show/hide via the `.hidden` class, never the HTML `hidden` attribute.
- **Builder backtick trap:** never put a backtick inside the `buildSidebarScript()` / `buildSidebarCss()` template literal (it truncates the whole literal). Quote identifiers in comments with single/double quotes.
- **Path normalization:** any `\`→`/` work goes through `toForwardSlash` / sanctioned helpers, never inline `replace`.
- **Selection stays checkbox-based** — do NOT adopt the mockup's strikethrough-for-excluded styling.
- **Share is a placeholder only** — the button must not imply a committed Share contract; its command shows a "coming soon" info message.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `vscode/src/views/SidebarScriptBuilder.ts` | Sidebar DOM builders (the script string) | Modify `renderConversationRow` (3794), `renderPlanRow` (3660), `renderBranch` (3287), `renderBranchFooter` (3561); add `renderCommitReviewBar`, `renderTokenBar`; add `branch:tokenStats` handler + `tokenStats` state; add `review`/`share` dispatch |
| `vscode/src/views/SidebarCssBuilder.ts` | Sidebar styles | Add `.source-dot*`, `.usage-note`, `.commit-review-bar`, `.token-bar*` classes |
| `vscode/src/views/SidebarMessages.ts` | Webview↔host message protocol | Add `branch:tokenStats` to `SidebarInboundMsg` |
| `vscode/src/views/SidebarWebviewProvider.ts` | Host data push | Compute + post `branch:tokenStats` alongside `branch:commitsData` |
| `vscode/src/views/NextMemoryPreviewPanel.ts` | NEW editor-column webview: preview the next memory's selected items | Create |
| `vscode/src/Extension.ts` | Command registration | Register `jollimemory.reviewNextMemory`, `jollimemory.shareBranchPlaceholder` |
| `vscode/package.json` | Command contributions | Declare the two new commands |

Test files: `SidebarScriptBuilder.test.ts`, `SidebarCssBuilder.test.ts`, `SidebarMessages.test.ts`, new `NextMemoryPreviewPanel.test.ts`.

---

## Task 1: CONVERSATIONS row — source dot, "N msgs", usage sub-label

**Files:**
- Modify: `vscode/src/views/SidebarScriptBuilder.ts:3831-3838` (the badge/count/time tail of `renderConversationRow`)
- Modify: `vscode/src/views/SidebarCssBuilder.ts` (add source-dot + usage-note classes)
- Test: `vscode/src/views/SidebarScriptBuilder.test.ts`, `vscode/src/views/SidebarCssBuilder.test.ts`

**Interfaces:**
- Consumes: `item.source` (TranscriptSource), `item.messageCount` (number) — already in scope inside `renderConversationRow`.
- Produces: row markup classes `source-dot`, `source-dot--<source>`, `msgs`, `usage-note`.

- [ ] **Step 1: Write the failing test** (append to `SidebarScriptBuilder.test.ts`)

```ts
it("conversation row shows a source dot, 'N msgs', and a usage sub-label", () => {
	const js = buildSidebarScript();
	// source becomes a colored dot keyed by item.source (not a text badge pill)
	expect(js).toContain("'source-dot source-dot-' + item.source");
	// message count rendered as "N msgs"
	expect(js).toContain("item.messageCount) + ' msgs'");
	// static usage placeholder sub-label (no usage field on the item yet)
	expect(js).toContain("usage not reported");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts -t "source dot"`
Expected: FAIL (strings not present).

- [ ] **Step 3: Implement** — replace `SidebarScriptBuilder.ts:3831-3838` (the `badge` + `count` + `time` block) with:

```ts
    kids.push(el('span', {
      className: 'source-dot source-dot-' + item.source,
      'aria-label': providerLabel(item.source),
    }));
    kids.push(el('span', { className: 'msgs', text: String(item.messageCount) + ' msgs' }));
    // ActiveConversationItem carries no token-usage figure yet, so the row shows
    // a static placeholder where the mockup shows per-conversation usage. Wiring
    // real usage is a follow-up (see the 2026-06-26 spec, out-of-scope).
    kids.push(el('span', { className: 'usage-note', text: 'usage not reported' }));
```

(`relative`/`time` is dropped from the row tail; the relative time remains available via the hover/title `displayTitle` already passed to `attachTextTip`.)

- [ ] **Step 4: Add CSS** — in `SidebarCssBuilder.ts`, add to the returned style string (near the existing conversation-row / badge rules):

```css
.source-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; margin: 0 4px; background: var(--vscode-descriptionForeground); }
.source-dot-claude { background: var(--vscode-charts-orange); }
.source-dot-codex { background: var(--vscode-charts-green); }
.source-dot-gemini { background: var(--vscode-charts-blue); }
.source-dot-opencode, .source-dot-cursor, .source-dot-copilot { background: var(--vscode-charts-blue); }
.conversation-row .msgs { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 0.9em; white-space: nowrap; }
.conversation-row .usage-note { color: var(--vscode-descriptionForeground); opacity: 0.7; font-size: 0.85em; margin-left: 6px; white-space: nowrap; }
```

- [ ] **Step 5: Add the CSS test** (append to `SidebarCssBuilder.test.ts`)

```ts
it("defines source-dot and usage-note styles", () => {
	const css = buildSidebarCss();
	expect(css).toContain(".source-dot");
	expect(css).toContain(".source-dot-claude");
	expect(css).toContain(".usage-note");
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts src/views/SidebarCssBuilder.test.ts`
Expected: PASS (including the existing `new Function(...)` parse smoke test, which guards against backtick/syntax breakage).

---

## Task 2: CONTEXT row — right-aligned token count — DROPPED

> **Dropped during execution (2026-06-26).** Re-verified against the rendered mockup: CONTEXT rows have **no** per-row token counts. The only right-side affordance is the header `+` add control, which already exists (`renderSectionActions` 'plans' → `plans-add-menu`). With checkboxes retained (not the mockup's strikethrough), CONTEXT needs no change. The steps below are left for the record but were not implemented (a dormant `item.tokenLabel` render would be dead code — the serializer never sets the field).


**Files:**
- Modify: `vscode/src/views/SidebarScriptBuilder.ts` inside `renderPlanRow` (starts 3660)
- Modify: `vscode/src/views/SidebarCssBuilder.ts`
- Test: `SidebarScriptBuilder.test.ts`, `SidebarCssBuilder.test.ts`

**Interfaces:**
- Consumes: `item.planHover.commitHash` presence and any token figure already on the serialized plan/note row. Context rows that have no associated token figure render no count.
- Produces: class `ctx-tokens`.

> Note: the CONTEXT section's "+" add affordance already exists (`renderSectionActions` 'plans' branch emits `iconButton('plans-add-menu', …, 'add')`, 3592) — no work needed there.

- [ ] **Step 1: Write the failing test**

```ts
it("context (plan/note) row renders a right-aligned token count when present", () => {
	const js = buildSidebarScript();
	expect(js).toContain("'ctx-tokens'");
	// only rendered when the row carries a formatted token figure
	expect(js).toContain("item.tokenLabel");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts -t "token count"`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `renderPlanRow`, just before the row's inline-actions/return, append a token-count span when `item.tokenLabel` is set (a preformatted string like `"42k"`, supplied by the serializer; absent rows render nothing):

```ts
    if (item.tokenLabel) {
      kids.push(el('span', { className: 'ctx-tokens', text: item.tokenLabel }));
    }
```

(`item.tokenLabel` is an optional display string on the serialized context row. If the serializer does not yet populate it, the span simply never renders — graceful and non-breaking. Populating it from real per-context token figures is folded in only if the data already exists on the row; otherwise it stays dormant until a follow-up, matching the spec's "omitted otherwise" rule.)

- [ ] **Step 4: Add CSS**

```css
.ctx-tokens { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 0.85em; white-space: nowrap; }
```

- [ ] **Step 5: CSS test**

```ts
it("defines ctx-tokens style", () => {
	expect(buildSidebarCss()).toContain(".ctx-tokens");
});
```

- [ ] **Step 6: Run tests**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts src/views/SidebarCssBuilder.test.ts`
Expected: PASS.

---

## Task 3: Relocate Commit → body `Commit Memory | Review`; reshape footer to `Create PR | Share | ⋯`

This is one task: Commit must never be "nowhere" — moving it out of the footer and into the body happen together.

**Files:**
- Modify: `vscode/src/views/SidebarScriptBuilder.ts` — add `renderCommitReviewBar`; mount it in `renderBranch` (after the memory group, before Committed Memories); rewrite `renderBranchFooter` (3561-3578); extend the footer/body `data-action` click dispatch (near 4320-4335).
- Modify: `vscode/src/views/SidebarCssBuilder.ts` — `.commit-review-bar`.
- Test: `SidebarScriptBuilder.test.ts`, `SidebarCssBuilder.test.ts`.

**Interfaces:**
- Consumes: `branchData.changes` (selection count), `isWorkerBlocking()`, `branchData.commits` (PR enablement), `isViewingForeign()`.
- Produces: `data-action` values `body-commit`, `body-review`, `footer-create-pr`, `footer-share`, `footer-more`.

- [ ] **Step 1: Write the failing tests**

```ts
it("renders a body Commit Memory | Review bar and removes Commit from the footer", () => {
	const js = buildSidebarScript();
	expect(js).toContain("function renderCommitReviewBar");
	expect(js).toContain("'data-action': 'body-commit'");
	expect(js).toContain("'data-action': 'body-review'");
	expect(js).toContain("Commit Memory");
	expect(js).toContain("Review");
	// footer no longer carries the commit action
	expect(js).not.toContain("'data-action': 'footer-commit'");
});

it("footer is Create PR | Share | More", () => {
	const js = buildSidebarScript();
	expect(js).toContain("'data-action': 'footer-create-pr'");
	expect(js).toContain("'data-action': 'footer-share'");
	expect(js).toContain("'data-action': 'footer-more'");
});

it("Review dispatches reviewNextMemory and Share dispatches the placeholder", () => {
	const js = buildSidebarScript();
	expect(js).toContain("jollimemory.reviewNextMemory");
	expect(js).toContain("jollimemory.shareBranchPlaceholder");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts -t "Commit Memory | Review"`
Expected: FAIL.

- [ ] **Step 3: Add `renderCommitReviewBar`** (new function near `renderBranchFooter`, ~3560):

```ts
  function renderCommitReviewBar() {
    var changes = branchData.changes || [];
    var selectedCount = changes.filter(function (c) { return !!c.isSelected; }).length;
    var disabled = selectedCount === 0 || isWorkerBlocking();
    var commitBtn = el('button', {
      className: 'cmd-btn primary', 'data-action': 'body-commit', 'aria-label': 'Commit Memory',
    }, [el('i', { className: 'codicon codicon-sparkle' }), el('span', { text: 'Commit Memory' })]);
    if (disabled) commitBtn.disabled = true;
    var reviewBtn = el('button', {
      className: 'cmd-btn', 'data-action': 'body-review', 'aria-label': 'Review next memory',
    }, [el('i', { className: 'codicon codicon-eye' }), el('span', { text: 'Review' })]);
    if (disabled) reviewBtn.disabled = true;
    return el('div', { className: 'commit-review-bar' }, [commitBtn, reviewBtn]);
  }
```

- [ ] **Step 4: Mount it in `renderBranch`** — change the non-foreign mount block (3367) so the bar sits after the memory group and before Committed Memories:

```ts
      nodesToMount.push(renderMemoryGroup(subSections));
      nodesToMount.push(renderCommitReviewBar());
```

- [ ] **Step 5: Rewrite `renderBranchFooter`** (3561-3578) — drop Commit, add Share:

```ts
  function renderBranchFooter() {
    var prDisabled = (branchData.commits || []).length === 0;
    var prBtn = el('button', {
      className: 'cmd-btn', 'data-action': 'footer-create-pr', 'aria-label': 'Create PR',
    }, [el('i', { className: 'codicon codicon-git-pull-request' }), el('span', { text: 'Create PR' })]);
    if (prDisabled) prBtn.disabled = true;
    var shareBtn = el('button', {
      className: 'cmd-btn', 'data-action': 'footer-share', 'aria-label': 'Share',
    }, [el('i', { className: 'codicon codicon-export' }), el('span', { text: 'Share' })]);
    var moreBtn = el('button', {
      className: 'cmd-btn aa-more', 'data-action': 'footer-more', 'aria-label': 'More branch actions',
    }, [el('i', { className: 'codicon codicon-ellipsis' })]);
    return el('div', { className: 'branch-footer' }, [prBtn, shareBtn, moreBtn]);
  }
```

- [ ] **Step 6: Wire the click dispatch** — in the delegated branch click handler, find the `footer-commit` case (it dispatched the commit path) and replace/extend so `body-commit` runs the commit path, `body-review` posts review, `footer-share` posts the placeholder. Locate the existing `data-action` switch near 4300-4335; add:

```ts
      if (action === 'body-commit') { vscode.postMessage({ type: 'command', command: 'jollimemory.commitMemory' }); return; }
      if (action === 'body-review') { vscode.postMessage({ type: 'command', command: 'jollimemory.reviewNextMemory' }); return; }
      if (action === 'footer-share') { vscode.postMessage({ type: 'command', command: 'jollimemory.shareBranchPlaceholder' }); return; }
```

(Use the SAME command id the removed `footer-commit` handler used for the commit action — replace `jollimemory.commitMemory` above with that exact id if it differs; grep the old `footer-commit` branch to confirm before deleting it. Remove the now-dead `footer-commit` branch.)

- [ ] **Step 7: Add CSS** (`SidebarCssBuilder.ts`):

```css
.commit-review-bar { display: flex; gap: 6px; padding: 8px 12px; }
.commit-review-bar .cmd-btn { flex: 1 1 auto; }
```

- [ ] **Step 8: CSS test**

```ts
it("defines commit-review-bar style", () => {
	expect(buildSidebarCss()).toContain(".commit-review-bar");
});
```

- [ ] **Step 9: Run tests**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts src/views/SidebarCssBuilder.test.ts`
Expected: PASS, including the `new Function(...)` parse smoke test.

---

## Task 4: Host commands — `reviewNextMemory` (+ `NextMemoryPreviewPanel`) and `shareBranchPlaceholder`

**Files:**
- Create: `vscode/src/views/NextMemoryPreviewPanel.ts`
- Modify: `vscode/src/Extension.ts` (register both commands)
- Modify: `vscode/package.json` (`contributes.commands`)
- Test: `vscode/src/views/NextMemoryPreviewPanel.test.ts`

**Interfaces:**
- Consumes: the same selection feeds the commit path reads — current conversations / plans / changes with their `isSelected` flags, available from the provider's branch data source. Model the constructor on `CreatePrWebviewPanel` (editor-column webview, `show(...)` static).
- Produces: `NextMemoryPreviewPanel.show(context, selection)` where `selection = { conversations: {title}[], context: {title}[], files: {path}[] }`; an `buildNextMemoryHtml(selection)` pure function for testability.

- [ ] **Step 1: Write the failing test** (`NextMemoryPreviewPanel.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { buildNextMemoryHtml } from "./NextMemoryPreviewPanel";

describe("buildNextMemoryHtml", () => {
	it("renders the three selected groups with counts", () => {
		const html = buildNextMemoryHtml({
			conversations: [{ title: "Sidebar redesign" }],
			context: [{ title: "redesign plan" }],
			files: [{ path: "SidebarHtmlBuilder.ts" }],
		});
		expect(html).toContain("Conversations");
		expect(html).toContain("Sidebar redesign");
		expect(html).toContain("Context");
		expect(html).toContain("Files");
		expect(html).toContain("SidebarHtmlBuilder.ts");
	});
	it("shows an empty state when nothing is selected", () => {
		const html = buildNextMemoryHtml({ conversations: [], context: [], files: [] });
		expect(html).toContain("Nothing selected");
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vscode -- src/views/NextMemoryPreviewPanel.test.ts`
Expected: FAIL (module not found / export missing).

- [ ] **Step 3: Implement `NextMemoryPreviewPanel.ts`** — pure HTML builder + a thin panel wrapper modelled on `CreatePrWebviewPanel`:

```ts
import * as vscode from "vscode";

export interface NextMemorySelection {
	readonly conversations: ReadonlyArray<{ readonly title: string }>;
	readonly context: ReadonlyArray<{ readonly title: string }>;
	readonly files: ReadonlyArray<{ readonly path: string }>;
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function group(title: string, items: ReadonlyArray<string>): string {
	if (items.length === 0) return "";
	const lis = items.map((t) => `<li>${esc(t)}</li>`).join("");
	return `<section><h2>${title} (${items.length})</h2><ul>${lis}</ul></section>`;
}

export function buildNextMemoryHtml(sel: NextMemorySelection): string {
	const total = sel.conversations.length + sel.context.length + sel.files.length;
	if (total === 0) {
		return `<!doctype html><html><body><p class="empty">Nothing selected — check items in the Current Branch view to include them in the next memory.</p></body></html>`;
	}
	const body =
		group("Conversations", sel.conversations.map((c) => c.title)) +
		group("Context", sel.context.map((c) => c.title)) +
		group("Files", sel.files.map((f) => f.path));
	return `<!doctype html><html><body><h1>Next memory preview</h1>${body}</body></html>`;
}

export class NextMemoryPreviewPanel {
	private static current: vscode.WebviewPanel | undefined;
	static show(selection: NextMemorySelection): void {
		const panel = NextMemoryPreviewPanel.current ??= vscode.window.createWebviewPanel(
			"jollimemory.nextMemoryPreview",
			"Next memory preview",
			vscode.ViewColumn.Active,
			{ enableScripts: false },
		);
		panel.onDidDispose(() => { NextMemoryPreviewPanel.current = undefined; });
		panel.webview.html = buildNextMemoryHtml(selection);
		panel.reveal(vscode.ViewColumn.Active);
	}
}
```

- [ ] **Step 4: Register commands in `Extension.ts`** — alongside the existing `createPrForBranch` registration:

```ts
context.subscriptions.push(
	vscode.commands.registerCommand("jollimemory.reviewNextMemory", async () => {
		const selection = await provider.getNextMemorySelection(); // returns NextMemorySelection from current branch data
		NextMemoryPreviewPanel.show(selection);
	}),
	vscode.commands.registerCommand("jollimemory.shareBranchPlaceholder", () => {
		vscode.window.showInformationMessage("Sharing is coming soon.");
	}),
);
```

(`provider.getNextMemorySelection()` projects the provider's already-loaded conversations/plans/changes filtered by `isSelected` into `NextMemorySelection`. Add that small method to `SidebarWebviewProvider` reading the same in-memory feeds it pushes via `branch:*Data`.)

- [ ] **Step 5: Declare commands in `package.json`** (`contributes.commands`):

```json
{ "command": "jollimemory.reviewNextMemory", "title": "Jolli Memory: Review Next Memory" },
{ "command": "jollimemory.shareBranchPlaceholder", "title": "Jolli Memory: Share Branch" }
```

- [ ] **Step 6: Run tests**

Run: `npm run test:vscode -- src/views/NextMemoryPreviewPanel.test.ts`
Expected: PASS.

---

## Task 5: `branch:tokenStats` message + host aggregation + Committed Memories token bar

**Files:**
- Modify: `vscode/src/views/SidebarMessages.ts` (add inbound message)
- Modify: `vscode/src/views/SidebarWebviewProvider.ts` (compute + post)
- Modify: `vscode/src/views/SidebarScriptBuilder.ts` (`tokenStats` state, handler, `renderTokenBar`, mount in Committed Memories)
- Modify: `vscode/src/views/SidebarCssBuilder.ts` (`.token-bar*`)
- Test: `SidebarMessages.test.ts`, `SidebarScriptBuilder.test.ts`, `SidebarCssBuilder.test.ts`

**Interfaces:**
- Produces: inbound `{ type: "branch:tokenStats"; input: number; output: number; total: number; scope: "branch" }`. **No `cached` field** — `LlmCallMetadata` (cli/src/Types.ts:209) carries only `inputTokens`/`outputTokens`, so the bar shows input + output only (spec §8 `cached` dropped per the §12 degradation rule).
- Consumes (webview): `state.tokenStats` (the last received payload or null).

- [ ] **Step 1: Add the message type** — in `SidebarMessages.ts` `SidebarInboundMsg` union, add:

```ts
	| {
			readonly type: "branch:tokenStats";
			readonly input: number;
			readonly output: number;
			readonly total: number;
			readonly scope: "branch";
	  }
```

- [ ] **Step 2: Write failing webview test**

```ts
it("renders a Committed Memories token bar from branch:tokenStats", () => {
	const js = buildSidebarScript();
	expect(js).toContain("'branch:tokenStats'");
	expect(js).toContain("function renderTokenBar");
	expect(js).toContain("tokens · this branch");
	// degrades to hidden when no stats received
	expect(js).toContain("state.tokenStats");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts -t "token bar"`
Expected: FAIL.

- [ ] **Step 4: Implement webview side** — (a) add `tokenStats: null` to the `state` object; (b) handle the message in the `handleMessage` switch:

```ts
      case 'branch:tokenStats':
        state.tokenStats = { input: msg.input, output: msg.output, total: msg.total };
        if (state.activeTab === 'branch') renderBranch();
        break;
```

(c) add the builder (shared helper so Memory Bank / Knowledge specs reuse it):

```ts
  function renderTokenBar(stats) {
    if (!stats || !stats.total) return null;
    var inputPct = Math.round((stats.input / stats.total) * 100);
    var outputPct = Math.round((stats.output / stats.total) * 100);
    var bar = el('div', { className: 'token-bar' }, [
      el('span', { className: 'token-seg token-seg--input', 'data-pct': String(inputPct) }),
      el('span', { className: 'token-seg token-seg--output', 'data-pct': String(outputPct) }),
    ]);
    var label = el('div', { className: 'token-bar-label', text: formatTokens(stats.total) + ' tokens · this branch' });
    var legend = el('div', { className: 'token-bar-legend' }, [
      el('span', { className: 'tk-leg tk-leg--input', text: formatTokens(stats.input) + ' input' }),
      el('span', { className: 'tk-leg tk-leg--output', text: formatTokens(stats.output) + ' output' }),
    ]);
    return el('div', { className: 'token-bar-wrap' }, [label, bar, legend]);
  }
```

(`formatTokens(n)` → "1.8M" / "118k": reuse an existing humanize helper if one exists in the script; otherwise add a 6-line one. The per-segment width is set via the `data-pct` attribute + a CSS rule `[data-pct]{width:attr(...)}` is NOT reliable — instead the bar uses flex-grow proportional to the counts: set `flex-grow` via class is impossible without inline style, so use a small fixed set of width classes OR render the segments as a flex row with `flex: <count>` — see Step 6 CSS note.)

(d) mount it: in `renderSection` for the `commits` section, or in `renderBranch` after building `committedMemoriesSection`, prepend `renderTokenBar(state.tokenStats)` to the section body when non-foreign. Concretely, in `renderBranch` replace the `nodesToMount.push(renderSection(committedMemoriesSection));` line with:

```ts
    var committedSection = renderSection(committedMemoriesSection);
    if (!foreign && state.tokenStats) {
      var bar = renderTokenBar(state.tokenStats);
      var body = committedSection.querySelector('.section-body');
      if (bar && body) body.insertBefore(bar, body.firstChild);
    }
    nodesToMount.push(committedSection);
```

- [ ] **Step 5: Avoid the inline-style CSP trap for proportional widths** — set segment proportions with a CSS custom property applied via `setAttribute('style', ...)` is forbidden. Instead give each segment `flex-grow` through the DOM property (allowed: it's a property, not the inline `style` attribute string), e.g. after building the bar:

```ts
    bar.children[0].style.flexGrow = String(stats.input);
    bar.children[1].style.flexGrow = String(stats.output);
```

> CSP note: the project bans the inline `style=` HTML *attribute* and inline `<style>`/handlers; setting `element.style.flexGrow` from the trusted, nonce'd script is the sanctioned dynamic-style path (same mechanism the existing renderers use for measured layout). Confirm against an existing `.style.` usage in the file; if none exists, fall back to 5 bucketed width classes (`.token-seg--w10`…`.token-seg--w90`) chosen by rounding `inputPct` to the nearest 10.

- [ ] **Step 6: Add CSS**

```css
.token-bar-wrap { padding: 4px 12px 8px; }
.token-bar-label { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 4px; }
.token-bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; background: var(--vscode-input-background); }
.token-seg { display: block; height: 100%; }
.token-seg--input { background: var(--vscode-charts-green); }
.token-seg--output { background: var(--vscode-charts-blue); }
.token-bar-legend { display: flex; gap: 12px; margin-top: 4px; font-size: 0.8em; color: var(--vscode-descriptionForeground); }
```

- [ ] **Step 7: Implement host aggregation** — in `SidebarWebviewProvider.ts`, where `branch:commitsData` is built/posted, also compute and post the stats by summing `llmMetadata.inputTokens`/`outputTokens` across the branch's loaded summaries:

```ts
let input = 0, output = 0;
for (const s of branchSummaries) {
	input += s.llmMetadata?.inputTokens ?? 0;
	output += s.llmMetadata?.outputTokens ?? 0;
}
if (input + output > 0) {
	view.webview.postMessage({ type: "branch:tokenStats", input, output, total: input + output, scope: "branch" });
}
```

(Use the same `branchSummaries` collection the commits feed already iterates; name it to match the existing variable. Skip the post in foreign-readonly mode — no per-foreign aggregate in this spec.)

- [ ] **Step 8: Add message + CSS tests**

```ts
// SidebarMessages.test.ts (type-level / shape smoke if present), else SidebarScriptBuilder substring is enough.
// SidebarCssBuilder.test.ts:
it("defines token-bar styles", () => {
	const css = buildSidebarCss();
	expect(css).toContain(".token-bar");
	expect(css).toContain(".token-seg--input");
});
```

- [ ] **Step 9: Run tests**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts src/views/SidebarCssBuilder.test.ts src/views/SidebarMessages.test.ts`
Expected: PASS.

---

## Task 6: State coverage + live verification

**Files:**
- Modify: `vscode/src/views/SidebarScriptBuilder.test.ts` (state assertions)
- Use: `scratchpad/preview/render-sidebar.mts` (existing fixture harness) for screenshot verification

**Interfaces:** none new — assert the gating rules already implemented.

- [ ] **Step 1: Write state-coverage tests**

```ts
it("foreign-readonly hides the body Commit|Review bar, footer, and token bar", () => {
	const js = buildSidebarScript();
	// renderCommitReviewBar + footer are only mounted in the non-foreign branch
	expect(js).toContain("if (!foreign) {");
	// token bar is gated on !foreign
	expect(js).toContain("if (!foreign && state.tokenStats)");
});
```

- [ ] **Step 2: Run to verify it fails (if gating not yet present), then confirm it passes after Tasks 3 & 5**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts -t "foreign-readonly hides"`
Expected: PASS (gating added in Tasks 3 & 5).

- [ ] **Step 3: Re-render the preview harness and screenshot every state**

Run:
```bash
cd /Users/flyer/jolli/code/jollimemory && cd cli && npm run build && cd ..
npx tsx /private/tmp/.../scratchpad/preview/render-sidebar.mts   # path from the brainstorming session
```
Then serve `scratchpad/preview` over HTTP and screenshot `out/branch-normal.html`, `branch-empty.html`, `branch-foreign.html` (the harness already renders these). Visually compare each against the mockup intent (`jollimemory-design/dist/sidebar.normal.intent.html`): confirm the body `Commit Memory | Review` pair, footer `Create PR | Share | ⋯`, the token bar, and the conversation/context row metadata all match the intent's information architecture.

Expected: normal shows all four changes; empty disables Commit/Review and hides the token bar; foreign hides the body bar + footer + token bar.

---

## Final checkpoint (run once, then commit)

- [ ] **Run the full gate**

Run: `cd /Users/flyer/jolli/code/jollimemory && npm run all`
Expected: clean → build → lint → test all PASS. Biome must report no warnings (CI uses `--error-on-warnings`).

- [ ] **Commit** (one or a few logical commits; DCO sign-off; no Claude trailer)

```bash
git add vscode/ docs/superpowers/plans/
git commit -s -m "feat(vscode): align Current Branch panel to mockup

Relocate Commit into a body Commit Memory | Review pair, reshape the
footer to Create PR | Share | ⋯ (Share placeholder), add a Committed
Memories token bar (branch:tokenStats), and enrich Working Memory rows
(source dot, N msgs, context token counts). Adds NextMemoryPreviewPanel
behind the Review action. Supersedes the 2026-06-25 command-bar layout."
```

- [ ] **Update the 06-25 spec** — add a one-line note at its top: `> Superseded for the command-bar layout by 2026-06-26-current-branch-panel-mockup-alignment-design.md.` Commit with the same conventions.

---

## Self-review notes (author)

- **Spec coverage:** §4 CONVERSATIONS → Task 1; §4 CONTEXT → Task 2 (note "+" pre-exists); §5 body pair + §7 footer → Task 3; §6 Next Memory panel → Task 4; §8 token bar → Task 5; §9 states → Task 6. All spec sections mapped.
- **Deviation from spec (intentional, flagged):** token bar `cached` segment dropped (no `cachedTokens` field in `LlmCallMetadata`) — matches spec §12 degradation. "+" add-context already exists — Task 2 reduced to token count only.
- **Type consistency:** `branch:tokenStats` shape `{input, output, total, scope}` is identical in SidebarMessages.ts, the host post, and the webview handler. `data-action` ids (`body-commit`, `body-review`, `footer-create-pr`, `footer-share`, `footer-more`) are consistent across `renderCommitReviewBar`, `renderBranchFooter`, and the dispatch block.
- **Verify-before-claim:** the existing `new Function(...)` parse test in `SidebarScriptBuilder.test.ts` guards every template-literal edit against the backtick trap; Task 6 adds live screenshot verification before completion.
- **Open implementation lookups (resolve while coding, not placeholders):** the exact command id the old `footer-commit` dispatched (Task 3 Step 6 — grep before deleting); whether a `formatTokens` humanizer already exists in the script (Task 5 Step 4); whether any `.style.` assignment already exists to confirm the CSP-sanctioned dynamic-width path vs. the bucketed-class fallback (Task 5 Step 5).

---

## Task 7a: Committed-memory inline evidence groups + "Show/Hide memory details" toggle

Added 2026-06-27 (spec §13). Pure reuse of the Memory Bank evidence machinery — see the Explore map: evidence is commitHash-keyed and the Branch committed row already toggles `state.commitsExpanded[item.id]` where `item.id` is the commit hash.

**Files:**
- Modify: `vscode/src/views/SidebarScriptBuilder.ts` — `renderCommitRow` (~4084) expanded-body branch; reuse `renderMemoryEvidence` (2324), `evidenceCache`/`evidencePending` (2139), the `kb:expandMemory` lazy-fetch trigger (2283-2298) and the `kb:memoryEvidence` handler (it already calls a re-render).
- Modify: `vscode/src/views/SidebarCssBuilder.ts` if a toggle-label style is needed.
- Test: `SidebarScriptBuilder.test.ts`.

**Interfaces:**
- Consumes: `state.commitsExpanded[hash]`, `evidenceCache[hash]`, `renderMemoryEvidence(hash, evidence)`, outbound `{type:'kb:expandMemory', commitHash}`.
- Produces: a "memory details" labeled toggle (`data-action`/`data-commit-toggle`-driven, same state key as the chevron).

- [ ] **Step 1: Read the actuals first.** Read `renderCommitRow` (4084-4227), the commit-toggle click handler (4485-4493), `renderMemoryEvidence` (2324-2485), and the Timeline lazy-fetch block (2283-2298) so the wiring matches reality (line numbers may have shifted after Tasks 1/3/5).

- [ ] **Step 2: Write the failing test** (`SidebarScriptBuilder.test.ts`)

```ts
it("committed memory row expands to inline evidence groups + a memory-details toggle", () => {
	const js = buildSidebarScript();
	// expanded committed row with a memory reuses renderMemoryEvidence (not just file children)
	expect(js).toContain("renderMemoryEvidence(");
	// a labeled show/hide affordance for the memory detail
	expect(js).toContain("memory details");
	// the existing lazy channel drives it
	expect(js).toContain("'kb:expandMemory'");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts -t "inline evidence groups"`
Expected: FAIL (`renderMemoryEvidence(` not referenced from the branch-commit path; "memory details" label absent).

- [ ] **Step 4: Implement.** In `renderCommitRow`'s expanded branch: for a row WITH a memory (`item.hasMemory` / `contextValue==='commitWithMemory'`), render the evidence instead of file-children-only:
  - On expand, if `evidenceCache[item.id]` is present, mount `renderMemoryEvidence(item.id, evidenceCache[item.id])`; else post `{type:'kb:expandMemory', commitHash:item.id}` (guarded by `evidencePending[item.id]`) and mount a "Loading…" placeholder — mirror the Timeline block at 2283-2298 exactly (the `kb:memoryEvidence` handler already re-renders the active tab).
  - Plain commits without a memory keep the current `renderCommitFileRow` children behavior.
  - Add a "Show memory details" / "Hide memory details" text affordance in the row (label reflects `state.commitsExpanded[item.id]`) that toggles the SAME `state.commitsExpanded[item.id]` the chevron uses (reuse the existing `[data-commit-toggle]` handler — give the label the same `data-commit-toggle` attribute + hash, so no new handler is needed).
  - No backtick in the literal; events via delegated handler + `data-*`; show/hide via `.hidden`.

- [ ] **Step 5: Run tests + parse smoke**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts`
Expected: PASS, incl. the `new Function(...)` parse smoke test.

- [ ] **Step 6: Commit** (DCO sign-off, no Claude trailer).

---

## Task 7b: SHIPPED group (Push-to-Jolli status + Create-PR action)

Added 2026-06-27 (spec §13.3). Heavier — adds host data + ship actions. Documented degradation: no live per-row PR-number status.

**Files:**
- Modify: `vscode/src/providers/HistoryTreeProvider.ts` (~206-264 serialize) — carry `jolliDocUrl?: string` from the summary onto the committed `SerializedTreeItem`.
- Modify: `vscode/src/views/SidebarMessages.ts` — add `jolliDocUrl?: string` to `SerializedTreeItem` (commits-only, like `hasMemory`).
- Modify: `vscode/src/views/SidebarScriptBuilder.ts` — render the SHIPPED group (two rows) at the top of the expanded memory body (above the evidence groups from 7a); dispatch ship actions.
- Modify: `vscode/src/views/SidebarCssBuilder.ts` — `.shipped-*` rows.
- Test: `SidebarScriptBuilder.test.ts`, `SidebarMessages.test.ts` if present, `HistoryTreeProvider` test if one exists.

**Interfaces:**
- Consumes: `item.jolliDocUrl` (optional), `item.id` (commit hash).
- Produces: `data-action` `ship-create-pr` and `ship-push-jolli` (each carrying `data-hash=item.id`).

- [ ] **Step 1: Confirm the reuse path FIRST (report if blocked).** Grep `Extension.ts` for a registered command that creates a PR for / pushes a SINGLE memory by commit hash, and how a memory's `SummaryWebviewPanel` is opened by hash (e.g. `jollimemory.openMemory`/`openCommit`). Decide the action target:
  - Push: if a per-memory push command exists, dispatch it with the hash; else the action opens the memory's `SummaryWebviewPanel` (which owns Push-to-Jolli). Report which.
  - Create PR: the action opens the memory's `SummaryWebviewPanel` (owns the per-memory create-PR flow). Do NOT reuse the branch-level `createPrForBranch` (different scope).
  If neither a command nor an open-by-hash path exists, report NEEDS_CONTEXT.

- [ ] **Step 2: Plumb `jolliDocUrl`.** Add `readonly jolliDocUrl?: string;` to `SerializedTreeItem` in `SidebarMessages.ts` (with a commits-only doc comment, like `hasMemory`). In `HistoryTreeProvider` serialize (~224), set it from the summary's `jolliDocUrl` when the commit has a memory.

- [ ] **Step 3: Write the failing test**

```ts
it("expanded memory row renders a SHIPPED group: Create PR action + Push/Synced status", () => {
	const js = buildSidebarScript();
	expect(js).toContain("'data-action': 'ship-create-pr'");
	expect(js).toContain("'data-action': 'ship-push-jolli'");
	expect(js).toContain("Push to Jolli");
	expect(js).toContain("create PR");
	// synced state keys off jolliDocUrl
	expect(js).toContain("item.jolliDocUrl");
});
```

- [ ] **Step 4: Run to verify it fails.**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts -t "SHIPPED group"`
Expected: FAIL.

- [ ] **Step 5: Implement** the SHIPPED group in the expanded memory body (above evidence groups):
  - Push row: `item.jolliDocUrl` present → "Synced" + a link affordance to `jolliDocUrl`; absent → "Not pushed — Push to Jolli" with `data-action='ship-push-jolli' data-hash=item.id`.
  - PR row: "create PR from this memory" with `data-action='ship-create-pr' data-hash=item.id` (no live PR status — documented degradation, spec §13.3).
  - Wire both `data-action`s in the delegated branch click handler to the reuse path confirmed in Step 1 (dispatch the command / open the memory panel by hash).
  - CSS `.shipped-row` etc.; CSP rules; no backtick.

- [ ] **Step 6: Run tests + parse smoke.**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts src/views/SidebarMessages.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit** (DCO sign-off).

---

## Task 7 verification + gate

- [ ] Re-run the preview harness, add a `branch:commitsData` fixture row with `hasMemory:true` + a `kb:memoryEvidence` fixture so the expanded detail renders; screenshot the expanded committed memory and compare against the mockup (SHIPPED + Conversations/Context/Files + toggle).
- [ ] Full gate: `npm run all` → EXIT 0, vscode coverage ≥ floor.
- [ ] Update the ledger (Task 7a / 7b / verify lines).

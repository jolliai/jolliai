# Sidebar View Shell (PR1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the icon-overlay sidebar navigation with an explicit three-view switch — **Current Branch / Memory Bank / Knowledge** — adding a stub Knowledge view, so later PRs have a shell to hang the redesigned content on.

**Architecture:** The sidebar webview is built from template-literal strings by three builders (`SidebarHtmlBuilder` = static skeleton, `SidebarCssBuilder` = styles, `SidebarScriptBuilder` = the client IIFE). Tests assert on the *generated string* (`expect(js).toContain(...)`) plus a `new Function(...)` parse smoke test — there is no jsdom execution. PR1 keeps the internal tab keys (`branch` / `kb` / `status`) to minimize ripple, **adds** a `knowledge` tab key, promotes `kb` from an overlay icon to a first-class view button, demotes nothing (Status stays an icon overlay, Settings stays a ⚙ icon), and renders a Knowledge stub. Navigation still flows through the existing `switchTab(tab)` dispatch.

**Tech Stack:** TypeScript (ESM), esbuild bundle (CJS output for the VS Code host), Vitest, Biome. VS Code webview with strict CSP.

## Global Constraints

- **DCO sign-off on every commit** — `git commit -s`. No `Co-Authored-By: Claude …` / `🤖 Generated with …` trailers.
- **`npm run all` must pass before commit** (clean → build → lint → test). Run from repo root.
- **Biome:** tabs, 4-wide, 120-column limit. `noExplicitAny`, `noUnusedImports/Variables` are errors; warnings fail CI.
- **CSP — no inline style / no inline JS.** Dynamic visibility uses the `.hidden` class (`display: none !important`), never the HTML `hidden` attribute or `el.hidden = X` (loses to `display: flex`). View-switch styling lives in a CSS class, never an inline `style=`.
- **Builder backtick trap:** the builders return one template literal each — never write a backtick inside a comment or string in the builder body; quote identifiers with single/double quotes.
- **CLI coverage floor (97/96/97/97) applies to `cli/src` only** — this PR touches `vscode/src`, which has no such gate, but its existing tests must still pass.
- **Cross-package imports under `vscode/src/**` (e.g. `../../../cli/src/...`) are intentional** — resolved at esbuild bundle time. Do not "clean up" into package imports.

---

### Task 1: Widen the `SidebarTab` type and refresh scope

**Files:**
- Modify: `vscode/src/views/SidebarMessages.ts:14` (the `SidebarTab` union) and `:541` (the `refresh` outbound `scope` union)
- Modify: `vscode/src/views/SidebarWebviewProvider.ts:774` (`handleRefresh` parameter type)
- Test: `vscode/src/views/SidebarMessages.test.ts`

**Interfaces:**
- Produces: `SidebarTab = "kb" | "branch" | "status" | "knowledge"`. The `refresh` outbound message's `scope` accepts `"kb" | "branch" | "status" | "knowledge" | "all"`. Later tasks rely on `"knowledge"` being a legal `SidebarTab` (used as `state.activeTab` and as a refresh scope).

- [ ] **Step 1: Write the failing test**

Add to `vscode/src/views/SidebarMessages.test.ts` (inside the top-level `describe`, or create the file's describe if testing types for the first time):

```ts
it("admits 'knowledge' as a SidebarTab and refresh scope", () => {
	const tab: SidebarTab = "knowledge";
	const msg: SidebarOutboundMsg = { type: "refresh", scope: "knowledge" };
	expect(tab).toBe("knowledge");
	expect(msg.type).toBe("refresh");
});
```

Ensure the imports at the top of the test file include the types:

```ts
import type { SidebarOutboundMsg, SidebarTab } from "./SidebarMessages.js";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run typecheck -w vscode`
Expected: FAIL — `Type '"knowledge"' is not assignable to type 'SidebarTab'` (and the same for `scope`).

- [ ] **Step 3: Widen the unions**

In `vscode/src/views/SidebarMessages.ts`, change line 14:

```ts
export type SidebarTab = "kb" | "branch" | "status" | "knowledge";
```

In the same file, change the `refresh` outbound member's `scope` (currently `scope: "kb" | "branch" | "status" | "all"`):

```ts
	| {
			readonly type: "refresh";
			readonly scope: "kb" | "branch" | "status" | "knowledge" | "all";
	  };
```

In `vscode/src/views/SidebarWebviewProvider.ts`, change the `handleRefresh` signature:

```ts
	private handleRefresh(scope: "kb" | "branch" | "status" | "knowledge" | "all"): void {
```

No new branch is needed inside `handleRefresh`: the Knowledge view is a stub with no host-side data feed in PR1, so a `"knowledge"` scope is a deliberate host no-op (the existing `if`-chain simply doesn't match it). A later PR adds the wiki refresh branch.

- [ ] **Step 4: Run the test + typecheck to verify they pass**

Run: `npm run typecheck -w vscode && npm run test:vscode -- src/views/SidebarMessages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/SidebarMessages.ts vscode/src/views/SidebarWebviewProvider.ts vscode/src/views/SidebarMessages.test.ts
git commit -s -m "feat(vscode): add knowledge to SidebarTab + refresh scope"
```

---

### Task 2: Add the view-switch row + Knowledge content panel to the HTML skeleton

**Files:**
- Modify: `vscode/src/views/SidebarHtmlBuilder.ts` (tab-bar-right icon strip `:157-167`, after the tab-bar close `:168`, and the tab-content panels `:171-179`)
- Test: `vscode/src/views/SidebarHtmlBuilder.test.ts`

**Interfaces:**
- Produces: a `<div class="view-switch hidden" id="view-switch">` containing three `<button class="view-tab" data-tab="branch|kb|knowledge">` buttons (the `branch` button starts with class `view-tab active`), and a `<div class="tab-content hidden" id="tab-content-knowledge">` panel. The `kb-icon-btn` button is removed from the right-side icon strip. Later tasks query `#view-switch`, `.view-tab[data-tab]`, and `#tab-content-knowledge`.

- [ ] **Step 1: Update the failing tests to express the new skeleton**

In `vscode/src/views/SidebarHtmlBuilder.test.ts`:

Rename the icon-strip test and replace its icon assertions (the block at lines 36-78). Replace:

```ts
		expect(html).toContain('id="kb-icon-btn"');
		expect(html).toContain('data-tab="kb"');
		expect(html).toContain('id="settings-icon-btn"');
		expect(html).toContain('data-action="open-settings"');
		expect(html).toContain('id="status-icon-btn"');
		expect(html).toContain('data-tab="status"');
		expect(html).toContain("codicon-circle-filled");
		// The branch label is now part of the breadcrumb, not a tab button.
		// data-tab="branch" no longer appears anywhere because Branch is the
		// implicit default view that surfaces whenever no overlay is active.
		expect(html).not.toContain('data-tab="branch"');
```

with:

```ts
		// Memory Bank moved out of the icon strip into the view-switch row, so
		// only Settings + Status remain as right-side icons.
		expect(html).not.toContain('id="kb-icon-btn"');
		expect(html).toContain('id="settings-icon-btn"');
		expect(html).toContain('data-action="open-settings"');
		expect(html).toContain('id="status-icon-btn"');
		expect(html).toContain('data-tab="status"');
		expect(html).toContain("codicon-circle-filled");
```

Add a new test after that block:

```ts
	it("renders the three-view switch with Current Branch / Memory Bank / Knowledge", () => {
		const html = buildSidebarHtml(
			"n",
			"vscode-resource:",
			"https://example/codicon.css",
			SIDEBAR_EMPTY_STRINGS,
		);
		// The view-switch is hidden by default (like tab-bar) so it doesn't
		// peek through during the loading-panel phase.
		expect(html).toMatch(/<div class="view-switch hidden" id="view-switch"/);
		expect(html).toContain('class="view-tab active" type="button" data-tab="branch"');
		expect(html).toContain('data-tab="kb"');
		expect(html).toContain('data-tab="knowledge"');
		expect(html).toContain("Current Branch");
		expect(html).toContain("Memory Bank");
		expect(html).toContain("Knowledge");
	});
```

Update the "3 tab content panels" test (lines 80-90) to include knowledge:

```ts
	it("includes 4 tab content panels with stable ids", () => {
		const html = buildSidebarHtml(
			"n",
			"vscode-resource:",
			"https://example/codicon.css",
			SIDEBAR_EMPTY_STRINGS,
		);
		expect(html).toContain('id="tab-content-kb"');
		expect(html).toContain('id="tab-content-branch"');
		expect(html).toContain('id="tab-content-status"');
		expect(html).toContain('id="tab-content-knowledge"');
	});
```

Update the loading-default test (lines 207-226) to also assert the new elements start hidden — append inside it:

```ts
		expect(html).toMatch(/<div class="view-switch hidden" id="view-switch"/);
		expect(html).toMatch(
			/<div class="tab-content hidden" id="tab-content-knowledge"/,
		);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:vscode -- src/views/SidebarHtmlBuilder.test.ts`
Expected: FAIL — `#view-switch`, `data-tab="knowledge"`, `#tab-content-knowledge` not found; `id="kb-icon-btn"` still present.

- [ ] **Step 3: Remove the kb icon button**

In `vscode/src/views/SidebarHtmlBuilder.ts`, delete the Memory Bank icon button from `.tab-bar-right` (currently lines 158-160):

```html
        <button class="tab tab-icon" type="button" data-tab="kb" id="kb-icon-btn" aria-label="Memory Bank">
          <i class="codicon codicon-book" aria-hidden="true"></i>
        </button>
```

so `.tab-bar-right` now contains only the Settings and Status buttons.

- [ ] **Step 4: Add the view-switch row**

In the same file, immediately after the `.tab-bar` closing `</div>` (the line after `</div>` that closes `tab-bar-right` + `tab-bar`, currently line 168) and before `<div class="dropdown-menu hidden" id="breadcrumb-menu" role="menu"></div>`, insert:

```html
    <div class="view-switch hidden" id="view-switch" role="tablist" aria-label="Jolli Memory views">
      <button class="view-tab active" type="button" data-tab="branch" role="tab">Current Branch</button>
      <button class="view-tab" type="button" data-tab="kb" role="tab">Memory Bank</button>
      <button class="view-tab" type="button" data-tab="knowledge" role="tab">Knowledge</button>
    </div>
```

- [ ] **Step 5: Add the Knowledge content panel**

In the same file, immediately after the `tab-content-branch` panel (currently line 172) insert:

```html
    <div class="tab-content hidden" id="tab-content-knowledge"><p class="placeholder">Loading...</p></div>
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test:vscode -- src/views/SidebarHtmlBuilder.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add vscode/src/views/SidebarHtmlBuilder.ts vscode/src/views/SidebarHtmlBuilder.test.ts
git commit -s -m "feat(vscode): add three-view switch + Knowledge panel to sidebar skeleton"
```

---

### Task 3: Style the view-switch

**Files:**
- Modify: `vscode/src/views/SidebarCssBuilder.ts` (insert after the `.tab.active` rule, currently `:134`)
- Test: `vscode/src/views/SidebarCssBuilder.test.ts`

**Interfaces:**
- Produces: `.view-switch` and `.view-tab` (+ `:hover`, `.active`) CSS rules. No interface other than class names already emitted in Task 2.

- [ ] **Step 1: Write the failing test**

Add to `vscode/src/views/SidebarCssBuilder.test.ts` (inside the top-level describe):

```ts
it("styles the view-switch row and its view-tab buttons", () => {
	const css = buildSidebarCss();
	expect(css).toContain(".view-switch");
	expect(css).toContain(".view-tab");
	expect(css).toContain(".view-tab.active");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:vscode -- src/views/SidebarCssBuilder.test.ts`
Expected: FAIL — `.view-switch` not found.

- [ ] **Step 3: Add the CSS**

In `vscode/src/views/SidebarCssBuilder.ts`, immediately after the `.tab.active { … }` rule (currently line 134), insert:

```css
  /* View switch — the three primary views (Current Branch / Memory Bank /
     Knowledge) as a segmented text-button row under the header bar. Each
     button carries data-tab so the script's switchTab dispatch (and the
     .active sync, broadened to [data-tab]) drives it like the legacy icons. */
  .view-switch {
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 2px 6px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    flex-shrink: 0;
  }
  .view-tab {
    flex: 1 1 0;
    padding: 5px 8px;
    border: none;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    border-radius: 3px;
    font-size: 11px;
    font-family: inherit;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .view-tab:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  .view-tab.active {
    background: var(--vscode-toolbar-activeBackground, rgba(0,122,204,0.2));
    color: var(--vscode-foreground);
    font-weight: 600;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:vscode -- src/views/SidebarCssBuilder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/SidebarCssBuilder.ts vscode/src/views/SidebarCssBuilder.test.ts
git commit -s -m "feat(vscode): style the sidebar view-switch row"
```

---

### Task 4: Wire the view-switch + Knowledge stub in the client script

**Files:**
- Modify: `vscode/src/views/SidebarScriptBuilder.ts` — DOM refs (`:126`, `:131`, `:180-184`, `:265`), tab switching (`:283`, `:293-306`, after `:320`), toolbar (`:421-422` and `:478`), `applyEnabled` (`:924`, `:934`, `:945-947`), `applyConfigured` (`:971-975`), and a new `renderKnowledge` function.
- Test: `vscode/src/views/SidebarScriptBuilder.test.ts`

**Interfaces:**
- Consumes (Task 2): `#view-switch`, `.view-tab[data-tab]` buttons, `#tab-content-knowledge`.
- Consumes (Task 1): `"knowledge"` as a legal `SidebarTab`.
- Produces: `tabContents.knowledge`; a `viewSwitch` DOM ref; a `renderKnowledge()` function; `.view-tab[data-tab]` click → `switchTab(target)`; `.active` sync broadened from `.tab[data-tab]` to `[data-tab]`; a Knowledge branch in `renderToolbar`; refresh scope sourced directly from `state.activeTab`.

- [ ] **Step 1: Write the failing tests**

Add to `vscode/src/views/SidebarScriptBuilder.test.ts`:

```ts
it("registers the knowledge tab content and a renderKnowledge stub", () => {
	const js = buildSidebarScript();
	expect(js).toContain("tab-content-knowledge");
	expect(js).toContain("function renderKnowledge");
});

it("wires the view-switch buttons to switchTab", () => {
	const js = buildSidebarScript();
	expect(js).toContain(".view-tab[data-tab]");
	expect(js).toContain("view-switch");
});

it("syncs the active class across all [data-tab] elements, not just .tab", () => {
	const js = buildSidebarScript();
	// Broadened selector so the view-switch buttons receive .active too.
	expect(js).toContain("querySelectorAll('[data-tab]')");
});

it("sources the refresh scope from the active tab so knowledge maps correctly", () => {
	const js = buildSidebarScript();
	expect(js).toContain("scope: state.activeTab");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts`
Expected: FAIL — `function renderKnowledge`, `.view-tab[data-tab]`, `querySelectorAll('[data-tab]')`, `scope: state.activeTab` not found.

- [ ] **Step 3: Add the `tabContents.knowledge` entry and the `viewSwitch` ref; drop the dead kb-icon ref**

In `vscode/src/views/SidebarScriptBuilder.ts`, add a `viewSwitch` ref next to the `tabBar` ref (line 126 area):

```js
  const tabBar = document.getElementById('tab-bar');
  const viewSwitch = document.getElementById('view-switch');
```

Remove the now-dead `kbIconBtn` ref (line 131) and its tooltip line (line 265):

```js
  const kbIconBtn = document.getElementById('kb-icon-btn');   // DELETE
```
```js
  if (kbIconBtn) attachTextTip(kbIconBtn, 'Memory Bank');     // DELETE
```

Extend the `tabContents` map (lines 180-184) to include knowledge:

```js
  const tabContents = {
    kb: document.getElementById('tab-content-kb'),
    branch: document.getElementById('tab-content-branch'),
    status: document.getElementById('tab-content-status'),
    knowledge: document.getElementById('tab-content-knowledge')
  };
```

- [ ] **Step 4: Broaden the `.active` sync selector and add the knowledge render branch in `switchTab`**

In `switchTab` (line 283), change the selector:

```js
    document.querySelectorAll('[data-tab]').forEach(function(elBtn) {
      elBtn.classList.toggle('active', elBtn.getAttribute('data-tab') === tab);
    });
```

In the same function, add a knowledge branch after the existing `kb` branch (after line 306, inside the `if (tab === 'branch') … else if (tab === 'kb') {…}` chain):

```js
    else if (tab === 'knowledge') renderKnowledge();
```

- [ ] **Step 5: Add the view-switch click wiring**

Immediately after the existing icon click handler (the `document.querySelectorAll('.tab[data-tab]')` block ending at line 320), add:

```js
  // View-switch buttons always navigate to their view (no toggle-to-Branch
  // collapse — that behavior is reserved for the Status icon overlay).
  document.querySelectorAll('.view-tab[data-tab]').forEach(function(elBtn) {
    elBtn.addEventListener('click', function() {
      switchTab(elBtn.getAttribute('data-tab'));
    });
  });
```

- [ ] **Step 6: Add the `renderKnowledge` stub**

Add a new function next to the other render functions (e.g. directly after `renderStatus`, near line 1308 — anywhere in the IIFE scope is fine since they're hoisted declarations):

```js
  // Knowledge view (PR1 stub). The repo-grouped wiki tree lands in a later PR;
  // for now the view exists so navigation has a third destination.
  function renderKnowledge() {
    const container = tabContents.knowledge;
    clear(container);
    container.appendChild(el('p', { className: 'placeholder', text: 'Knowledge wiki — coming soon.' }));
  }
```

- [ ] **Step 7: Add the Knowledge toolbar branch and simplify the refresh scope**

In `renderToolbar`, replace the final `} else {` that opens the Branch branch (line 422) with a Knowledge branch followed by the Branch `else`:

```js
      mountIn(tabToolbar, items);
    } else if (state.activeTab === 'knowledge') {
      // Knowledge view (PR1 stub): a single Refresh action. The wiki / graph
      // toolbar controls land in a later PR.
      mountIn(tabToolbar, [iconButton('refresh', 'Refresh', 'refresh')]);
    } else {
```

In the toolbar click handler (line 478), replace the refresh-scope ternary with the active tab directly (every `SidebarTab` value is a legal refresh scope):

```js
    if (action === 'refresh') {
      vscode.postMessage({ type: 'refresh', scope: state.activeTab });
    } else if (action === 'kb-mode-folders' || action === 'kb-mode-memories') {
```

- [ ] **Step 8: Handle the knowledge panel + view-switch in `applyEnabled` and `applyConfigured`**

In `applyEnabled`, hide/show the view-switch alongside the tab bar (line 924):

```js
    tabBar.classList.toggle('hidden', !enabled);
    viewSwitch.classList.toggle('hidden', !enabled);
    tabToolbar.classList.toggle('hidden', !enabled);
```

Broaden the `.active` sync selector in the `enabled` branch (line 934):

```js
      document.querySelectorAll('[data-tab]').forEach(function(elBtn) {
        elBtn.classList.toggle('active', elBtn.getAttribute('data-tab') === state.activeTab);
      });
```

In the `else` (disabled) branch, hide the knowledge panel too and broaden the clear-active selector (lines 945-950):

```js
      tabContents.kb.classList.add('hidden');
      tabContents.branch.classList.add('hidden');
      tabContents.status.classList.add('hidden');
      tabContents.knowledge.classList.add('hidden');
      document.querySelectorAll('[data-tab]').forEach(function(elBtn) {
        elBtn.classList.remove('active');
      });
```

In `applyConfigured`, in the `!configured` onboarding branch (lines 971-975), hide the view-switch and the knowledge panel so the onboarding flow owns the full viewport:

```js
      tabBar.classList.add('hidden');
      viewSwitch.classList.add('hidden');
      tabToolbar.classList.add('hidden');
      tabContents.kb.classList.add('hidden');
      tabContents.branch.classList.add('hidden');
      tabContents.status.classList.add('hidden');
      tabContents.knowledge.classList.add('hidden');
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm run test:vscode -- src/views/SidebarScriptBuilder.test.ts`
Expected: PASS (including the existing `new Function(...)` parse smoke test and the "wires tab clicks to switchTab" test).

- [ ] **Step 10: Commit**

```bash
git add vscode/src/views/SidebarScriptBuilder.ts vscode/src/views/SidebarScriptBuilder.test.ts
git commit -s -m "feat(vscode): drive sidebar navigation from the three-view switch"
```

---

### Task 5: Full build/lint/test gate + manual smoke

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate**

Run: `npm run all`
Expected: PASS — clean → build → lint → test across cli + vscode. If a previously-passing test asserted the old icon nav (e.g. an `SidebarWebviewProvider.test.ts` case exercising a `kb` overlay-toggle), update it to the view-switch model and re-run. Fix any Biome tab/line-width findings.

- [ ] **Step 2: Manual smoke in the Extension Development Host**

```bash
cd vscode && npm run deploy
```
Then **Developer: Reload Window**. Verify:
- The header shows the three-view switch: **Current Branch** (active by default) / **Memory Bank** / **Knowledge**, with Settings ⚙ + Status ⏻ icons on the right and no Memory Bank icon.
- Clicking **Memory Bank** shows the existing folders/timeline content; clicking **Knowledge** shows "Knowledge wiki — coming soon."; clicking **Current Branch** returns to the branch content.
- The Status ⏻ icon still toggles the Status overlay and collapses back on a second click.
- Disabling the extension (Status → Disable) hides the view-switch and shows the disabled panel; re-enabling restores it.

- [ ] **Step 3: Commit any test/lint fixups**

```bash
git add -A
git commit -s -m "test(vscode): align sidebar nav tests with the view-switch shell"
```

---

## Self-Review

**1. Spec coverage:** This plan implements only PR1 (the view shell) from the spec's §2 global shell + the foundation for §3/§5/§6 views. The feedback deltas (①–④) are explicitly deferred to PR2-4 per the agreed decomposition — not in scope here. No PR1 requirement is unaddressed.

**2. Placeholder scan:** No `TBD`/`TODO`/"handle edge cases" — every code step shows exact code. The Knowledge view content is intentionally a stub (its real content is a later PR), and that is stated as the deliverable, not a placeholder.

**3. Type consistency:** `SidebarTab` gains `"knowledge"` (Task 1) and is used as `state.activeTab` (Task 4 `switchTab`/`renderToolbar`) and as the refresh `scope` (Task 4 Step 7) — consistent. `tabContents.knowledge` (Task 4 Step 3) is referenced by `switchTab` (Step 4), `applyEnabled` (Step 8), and `applyConfigured` (Step 8) under the same key. `#view-switch` / `#tab-content-knowledge` ids match between Task 2 (HTML), Task 3 (CSS classes), and Task 4 (script refs). `renderKnowledge` is declared (Step 6) and called (Step 4) under the same name.

import { describe, expect, it } from "vitest";
import { buildSidebarScript } from "./SidebarScriptBuilder";

describe("SidebarScriptBuilder", () => {
	it("returns a JS string", () => {
		const js = buildSidebarScript();
		expect(typeof js).toBe("string");
		expect(js.length).toBeGreaterThan(0);
	});

	it("output parses as valid JS — backtick / undeclared-symbol smoke test", () => {
		// Regression for two bug classes that ship-tested but tests-passed:
		//   1. Backtick trap: SidebarScriptBuilder warns about it in its
		//      docstring because an unescaped backtick inside the template
		//      literal closes the outer literal early and corrupts the JS.
		//      Substring assertions like `toContain("function foo")` happily
		//      match a truncated, syntactically-broken script.
		//   2. Empty-panel ReferenceError: a renderer referencing an
		//      undeclared symbol crashes only when the empty path actually
		//      renders, which substring tests don't catch.
		//
		// Wrapping in `new Function(...)` parses the entire body under strict-
		// mode constraints (any stray backtick, missing paren, unbalanced
		// template-literal, or reference to a reserved word fails here).
		// The webview-host globals are passed in as parameters so the script
		// body sees `acquireVsCodeApi` as a defined name at parse time.
		const js = buildSidebarScript();
		expect(
			() => new Function("window", "document", "acquireVsCodeApi", js),
		).not.toThrow();
	});

	it("acquires the VSCode API", () => {
		const js = buildSidebarScript();
		expect(js).toContain("acquireVsCodeApi");
	});

	it("registers a message listener and posts ready on load", () => {
		const js = buildSidebarScript();
		expect(js).toContain("addEventListener('message'");
		expect(js).toContain("type: 'ready'");
	});

	it("wires tab clicks to switchTab", () => {
		const js = buildSidebarScript();
		expect(js).toContain("data-tab");
		expect(js).toContain("switchTab");
	});

	it("persists state via vscode.setState", () => {
		const js = buildSidebarScript();
		expect(js).toContain("vscode.setState");
		expect(js).toContain("vscode.getState");
	});

	it("declares a DOM helper named el", () => {
		const js = buildSidebarScript();
		expect(js).toContain("function el(");
		expect(js).toContain("createElement");
	});

	it("does not use innerHTML for dynamic content", () => {
		const js = buildSidebarScript();
		// Static skeleton uses HTML strings server-side; client-side DOM construction
		// must avoid innerHTML to prevent XSS via untrusted data.
		expect(js).not.toMatch(/\.innerHTML\s*=/);
	});

	it("includes a renderStatus function", () => {
		const js = buildSidebarScript();
		expect(js).toContain("function renderStatus");
	});

	it("handles status:data inbound messages", () => {
		const js = buildSidebarScript();
		expect(js).toContain("'status:data'");
	});

	it("uses createElement for status rows", () => {
		const js = buildSidebarScript();
		// Each row built via el(), not innerHTML.
		expect(js).not.toMatch(/\.innerHTML\s*=/);
	});

	it("renders codicon glyphs in renderStatus", () => {
		const js = buildSidebarScript();
		expect(js).toContain("codicon codicon-' + e.iconKey");
	});

	it("declares a renderFolders function", () => {
		const js = buildSidebarScript();
		expect(js).toContain("function renderFolders");
	});

	it("handles kb:foldersData inbound messages", () => {
		const js = buildSidebarScript();
		expect(js).toContain("'kb:foldersData'");
	});

	it("handles kb:foldersReset by clearing folderCache and re-arming the auto-expand latch", () => {
		const js = buildSidebarScript();
		expect(js).toContain("'kb:foldersReset'");
		// Cache must be wiped (not just root) — rebuild may rename paths at any depth.
		expect(js).toContain("delete folderCache[k]");
		// One-shot latch is reset so the post-migration current-repo node gets
		// auto-expanded on the next kb:foldersData arrival.
		expect(js).toContain("currentRepoAutoExpanded = false");
		// No more kbRepoFolder plumbing — the per-repo (current) suffix carries
		// the "which repo is yours" signal directly inside the tree, so there's
		// nothing to thread through kb:foldersReset's payload.
		expect(js).not.toContain("kbRepoFolder");
	});

	it("grafts cached subtrees onto every reply so refresh keeps folders expanded", () => {
		const js = buildSidebarScript();
		// Graft helper exists and is applied to EVERY merged reply (the merge
		// reads its result into `grafted`), not just the root — so an out-of-order
		// per-folder reply can't collapse a deeper expansion.
		expect(js).toContain("graftExpandedFromCache");
		expect(js).toContain("const grafted = graftExpandedFromCache(tree)");
	});

	it("handles kb:markDiverged / kb:clearDiverged through one in-place flag flip", () => {
		const js = buildSidebarScript();
		// Both inbound cases exist and route to the SAME shared helper with
		// opposite truth values — mark and clear can't drift apart.
		expect(js).toContain("'kb:markDiverged'");
		expect(js).toContain("'kb:clearDiverged'");
		expect(js).toContain("setFileDivergedFlag(msg.path, true)");
		expect(js).toContain("setFileDivergedFlag(msg.path, false)");
		expect(js).toContain("function setFileDivergedFlag");
		// In-place flip rebuilds the matching child with the new flag value.
		expect(js).toContain("{ isDiverged: diverged }");
		// The flip must NOT wipe folderCache — that's foldersReset's job and would
		// collapse every expanded branch directory. Bound the assertion to the
		// setFileDivergedFlag body (up to the next top-level function) so it can't
		// pass vacuously against foldersReset's cache-wipe loop elsewhere.
		expect(js).not.toMatch(
			/function setFileDivergedFlag[\s\S]*?delete folderCache\[[\s\S]*?\n {2}function /,
		);
	});

	it("re-requests every already-expanded folder on manual refresh so isDiverged is recomputed", () => {
		const js = buildSidebarScript();
		// requestExpandedRefresh re-requests fresh data for each expanded dir so a
		// file edited on disk while the sidebar was open gets its ✎ marker on
		// refresh (cache-only reuse left nested isDiverged stale). Bounded to the
		// requestExpandedRefresh body (up to mergeFolders) so it can't pass
		// vacuously on the unrelated kb:expandFolder in maybeAutoExpandCurrentRepo.
		expect(js).toMatch(
			/function requestExpandedRefresh[\s\S]*?type:\s*'kb:expandFolder'[\s\S]*?function mergeFolders/,
		);
		// The fan-out fires ONLY from the root merge — gating it on relPath === ''
		// is what keeps a per-folder reply from re-posting (and looping).
		expect(js).toMatch(
			/if\s*\(tree\.relPath === ''\) requestExpandedRefresh\(tree\)/,
		);
	});

	it("grafts cached expansion onto every reply without re-requesting (order-independent, no collapse)", () => {
		const js = buildSidebarScript();
		// graftExpandedFromCache is the PURE expansion-preserver: it must NOT post
		// kb:expandFolder (that belongs to requestExpandedRefresh). If it did, each
		// per-folder reply would re-post for its descendants and amplify. Bounded
		// to the graft body (up to requestExpandedRefresh).
		expect(js).toContain("function graftExpandedFromCache");
		expect(js).not.toMatch(
			/function graftExpandedFromCache[\s\S]*?type:\s*'kb:expandFolder'[\s\S]*?function requestExpandedRefresh/,
		);
		// mergeFolders grafts EVERY reply (not gated on relPath === '') so an
		// out-of-order per-folder reply can't overwrite a deeper expansion with a
		// lazy child and collapse it.
		expect(js).toMatch(
			/function mergeFolders\(tree\)\s*\{\s*const grafted = graftExpandedFromCache\(tree\)/,
		);
	});

	it("propagateUp defensively merges repo-level identity fields onto lazy-expand responses", () => {
		// Regression guard: an expand-repo-root response from KbFoldersService
		// historically lacked the parent-root identity fields (configured name,
		// isRepoRoot, isCurrentRepo). propagateUp used a full object replace,
		// which then nuked those fields off folderCache[''].children[idx] —
		// the repo rendered as a nameless folder. The defensive merge below
		// preserves them when the incoming node forgot them. Pinned as a
		// safety net alongside the server-side fix in KbFoldersService.
		const js = buildSidebarScript();
		// The conditional that triggers the merge — must be present AND must
		// gate on BOTH "old has isRepoRoot" AND "new doesn't" (so legitimate
		// transitions like demoting a repo aren't blocked).
		expect(js).toMatch(
			/oldChild\s*&&\s*oldChild\.isRepoRoot\s*&&\s*!currentNode\.isRepoRoot/,
		);
		// All three identity fields are folded forward — name (display),
		// isRepoRoot (icon + class), isCurrentRepo (highlight).
		expect(js).toMatch(/name:\s*oldChild\.name/);
		expect(js).toMatch(/isRepoRoot:\s*oldChild\.isRepoRoot/);
		expect(js).toMatch(/isCurrentRepo:\s*oldChild\.isCurrentRepo/);
	});

	it("renders Settings, Sign-in/out, Disable, Refresh icons on the Status tab toolbar", () => {
		const js = buildSidebarScript();
		// The 4 actions wired in renderToolbar's status branch.
		expect(js).toContain("'open-settings'");
		expect(js).toContain("'sign-in'");
		expect(js).toContain("'sign-out'");
		expect(js).toContain("'disable-jolli'");
		// Toolbar click handler dispatches each as a generic command postMessage.
		expect(js).toContain("'jollimemory.openSettings'");
		expect(js).toContain("'jollimemory.signIn'");
		expect(js).toContain("'jollimemory.signOut'");
		expect(js).toContain("'jollimemory.disableJolliMemory'");
	});

	it("handles auth:changed by re-rendering toolbar when on Status tab", () => {
		const js = buildSidebarScript();
		expect(js).toContain("'auth:changed'");
		expect(js).toContain("state.authenticated = !!msg.authenticated");
	});

	it("hides the loading-panel on the first host message (any type), not only on init", () => {
		const js = buildSidebarScript();
		// The loading-panel is unhidden in HTML (no .hidden) and must be hidden
		// before any apply* call decides which of the configured / disabled /
		// tab-UI panels to surface. The hand-off used to live inside the init
		// case, but statusStore.refresh during initialLoad posts
		// configured:changed / enabled:changed BEFORE init — those handlers
		// call applyEnabled/applyConfigured which surface the disabled-panel
		// or onboarding-panel while loading is still up. Hiding at the top of
		// handleMessage (before the switch) covers every state-bearing path.
		expect(js).toContain("getElementById('loading-panel')");
		const fnStart = js.indexOf("function handleMessage");
		const switchStart = js.indexOf("switch", fnStart);
		expect(fnStart).toBeGreaterThan(-1);
		expect(switchStart).toBeGreaterThan(fnStart);
		expect(js.slice(fnStart, switchStart)).toContain(
			"loadingPanel.classList.add('hidden')",
		);
		// And the redundant hide inside the init case is gone — keeping it
		// duplicated invites future drift where someone updates one site but
		// not the other.
		const initStart = js.indexOf("case 'init'");
		const initEnd = js.indexOf("case ", initStart + 1);
		expect(initStart).toBeGreaterThan(-1);
		expect(js.slice(initStart, initEnd)).not.toContain(
			"loadingPanel.classList.add('hidden')",
		);
	});

	it("disabled mode hides every tab-content and shows the disabled-panel only", () => {
		const js = buildSidebarScript();
		// applyEnabled(false) lets the new disabled-panel take the entire
		// viewport: every tab-content is hidden, the tab bar is hidden, and
		// only the disabled-panel sibling is visible. The legacy
		// disabled-banner stays hidden — it's reserved for the degraded
		// fallback (no-workspace / no-git) which applyDegraded sets up
		// explicitly afterwards.
		expect(js).toContain("tabContents.kb.classList.add('hidden')");
		expect(js).toContain("tabContents.branch.classList.add('hidden')");
		expect(js).toContain("tabContents.status.classList.add('hidden')");
		// `.toggle('hidden', !!enabled)` covers both directions:
		// hidden when enabled, visible when disabled.
		expect(js).toMatch(
			/disabledPanel\.classList\.toggle\(['"]hidden['"], !!enabled\)/,
		);
		expect(js).toMatch(/tabBar\.classList\.toggle\(['"]hidden['"], !enabled\)/);
		expect(js).toContain("disabledBanner.classList.add('hidden')");
	});

	it("wires the disabled-panel Enable button to jollimemory.enableJolliMemory", () => {
		const js = buildSidebarScript();
		expect(js).toContain("getElementById('disabled-enable-btn')");
		// The button is its own listener (separate from the legacy in-Status
		// banner enable-btn) and dispatches the Enable command.
		expect(js).toMatch(
			/disabledEnableBtn\.addEventListener\(['"]click['"][\s\S]{0,200}jollimemory\.enableJolliMemory/,
		);
	});

	it("applyDegraded keeps the legacy disabled-banner path (Status panel + banner re-shown after applyEnabled(false))", () => {
		const js = buildSidebarScript();
		// applyDegraded must explicitly un-hide the Status tab content and
		// the disabled-banner because applyEnabled(false) hides both.
		// Without these, the reason-specific CTA (Open Folder / Initialize
		// Git) would be invisible and the user would be stuck on a blank
		// disabled-panel with the wrong button.
		const start = js.indexOf("function applyDegraded");
		const end = js.indexOf("function ", start + 1);
		expect(start).toBeGreaterThan(-1);
		const body = js.slice(start, end);
		expect(body).toContain("disabledPanel.classList.add('hidden')");
		expect(body).toContain("tabContents.status.classList.remove('hidden')");
		expect(body).toContain("disabledBanner.classList.remove('hidden')");
	});

	it("re-renders toolbar on enabled:changed (Disable button visibility depends on enabled)", () => {
		const js = buildSidebarScript();
		// Confirm renderToolbar() is called inside the enabled:changed handler.
		const handlerStart = js.indexOf("'enabled:changed'");
		const handlerEnd = js.indexOf("break", handlerStart);
		expect(handlerStart).toBeGreaterThan(-1);
		expect(js.slice(handlerStart, handlerEnd)).toContain("renderToolbar()");
	});

	it("renders shared indicator chrome (worker on Branch, sync-phase on Memory Bank)", () => {
		const js = buildSidebarScript();
		// Shared indicator chrome: spinner for info, error icon for sticky
		// sync failures. The post-commit "AI summary in progress…" label is
		// still emitted (used by the Branch tab worker indicator); the
		// sync-phase variant reuses the same chrome on the Memory Bank tab.
		expect(js).toContain("toolbar-worker-status");
		expect(js).toContain("codicon-loading codicon-modifier-spin");
		expect(js).toContain("codicon-error");
		expect(js).toContain("AI summary in progress…");
		// Sync-phase indicator is wired into the Memory Bank tab toolbar so
		// it sits next to the Sync-now action that drives it.
		expect(js).toContain("buildToolbarIndicator(state.syncPhase)");
	});

	it("handles sync:phase by re-rendering the Memory Bank toolbar", () => {
		const js = buildSidebarScript();
		expect(js).toContain("'sync:phase'");
		const handlerStart = js.indexOf("'sync:phase'");
		const handlerEnd = js.indexOf("case ", handlerStart + 1);
		expect(handlerStart).toBeGreaterThan(-1);
		const body = js.slice(handlerStart, handlerEnd);
		expect(body).toContain("state.syncPhase");
		// Sync moves memories to/from the Personal Space — indicator lives
		// on the Memory Bank tab toolbar, not the Branch toolbar.
		expect(body).toContain("state.activeTab === 'kb'");
		expect(body).not.toContain("state.activeTab === 'branch'");
		expect(body).toContain("renderToolbar()");
	});

	it("handles worker:busy by re-rendering toolbar AND branch on the Branch tab", () => {
		const js = buildSidebarScript();
		expect(js).toContain("'worker:busy'");
		// Idempotent: skip re-render when the flag did not change.
		expect(js).toContain("if (state.workerBusy === next) break;");
		// Scoped re-render: only Branch tab needs to repaint. Take the whole
		// case body (up to the next `case `) since the early-return `break;` for
		// the no-change branch sits before the activeTab guard.
		const handlerStart = js.indexOf("'worker:busy'");
		const handlerEnd = js.indexOf("case ", handlerStart + 1);
		expect(handlerStart).toBeGreaterThan(-1);
		const body = js.slice(handlerStart, handlerEnd);
		expect(body).toContain("state.activeTab === 'branch'");
		// Toolbar repaint covers the "AI summary in progress…" indicator.
		expect(body).toContain("renderToolbar()");
		// Branch repaint covers the changes section's Commit-AI button —
		// its disabled state depends on state.workerBusy, and renderToolbar
		// alone wouldn't refresh it (section actions live in renderBranch).
		expect(body).toContain("renderBranch()");
	});

	it("posts kb:expandFolder when an unexpanded folder is clicked", () => {
		const js = buildSidebarScript();
		expect(js).toContain("kb:expandFolder");
	});

	it("attaches a dynamic tooltip to the Status indicator that follows OK/Warning/Error", () => {
		const js = buildSidebarScript();
		// One-time attach at script init (the icon lives in the static skeleton).
		expect(js).toContain(
			"if (statusIconBtn) attachTextTip(statusIconBtn, 'Jolli Memory: All good')",
		);
		// renderStatus picks the tip in the same loop that picks the indicator
		// class, so the dot color and the tooltip can never disagree.
		expect(js).toContain("tip = 'Jolli Memory: Errors'");
		expect(js).toContain("tip = 'Jolli Memory: Warnings'");
		expect(js).toContain("statusIconBtn.dataset.tip = tip");
		// attachTextTip prefers dataset.tip on show so dynamic updates don't
		// require re-attaching listeners.
		expect(js).toContain("showTextTip(el.dataset.tip || text");
	});

	it("dismisses the text tooltip on mousedown so VSCode modal overlays don't pin it visible", () => {
		const js = buildSidebarScript();
		// VSCode native modals (force-push confirm via showWarningMessage,
		// command palettes, etc.) overlay the webview without dispatching
		// mouseleave. Without a mousedown dismissal the tooltip outlives the
		// click and stays pinned until the user wiggles the mouse off and back.
		expect(js).toMatch(
			/el\.addEventListener\('mousedown', function\(\) \{\s*hideTextTip\(\);\s*\}\);/,
		);
	});

	it("routes every row/button tooltip through attachTextTip — no leftover native title= on interactive elements", () => {
		const js = buildSidebarScript();
		// Native title= is unreliable in VSCode webviews (focus transitions
		// suppress it, modal overlays pin it, hover-rest timers reset per node).
		// Every clickable element and row wrapper should go through the
		// attachTextTip helper instead. Whitelist: the kb-search-input (form
		// input following the standard placeholder + title pattern) and the
		// explicit `title: null` suppression on plan/note/linear rows that drive
		// the .hover-card popover are the only DOM-attribute title:s that may
		// remain.
		const offenders = [
			"title: 'Discard Changes'",
			"title: 'Discard'",
			"title: 'View Memory'",
			"title: 'Copy commit hash'",
			"title: 'Open plan'",
			"title: 'Open note'",
			"title: 'Open in Linear'",
			"title: 'Edit'",
			"title: 'Remove'",
			"title: 'Ignore'",
			"title: 'Conversation content has been modified'",
			"title: item.tooltip || ''",
			"title: expanded ? 'Collapse' : 'Expand'",
			"title: fileKind === 'plan' ? 'Plan' : 'Note'",
		];
		for (const o of offenders) {
			expect(js).not.toContain(o);
		}
		// `title: displayTitle,` survives intentionally — that one is the
		// vscode.postMessage payload field on branch:openConversation, not a
		// DOM attribute. The DOM-attribute conversation-row title was rewritten
		// to attachTextTip(root, displayTitle).
	});

	it("guards section re-renders with hideTextTip so a row teardown can't orphan a visible tip", () => {
		const js = buildSidebarScript();
		// Each top-level renderer mounts a fresh subtree via mountIn — the
		// outgoing rows lose their mouseleave listeners with no chance to fire,
		// so any tip currently pinned to one of them would survive past the
		// re-render. Mirror the renderStatus / renderToolbar pattern. The regex
		// allows line comments between `function foo() {` and `hideTextTip();`
		// so explanatory blocks above the guard don't break the assertion.
		const guardRe = (name: string) =>
			new RegExp(
				`function ${name}\\(\\) \\{(?:\\s*//[^\\n]*\\n)*\\s*hideTextTip\\(\\);`,
			);
		expect(js).toMatch(guardRe("renderBranch"));
		expect(js).toMatch(guardRe("renderMemories"));
		expect(js).toMatch(guardRe("renderFolders"));
	});

	it("changes-row discard button uses attachTextTip instead of native title", () => {
		const js = buildSidebarScript();
		// Specific regression check for the original bug report: the discard
		// icon on Changes rows lost its tooltip intermittently and pinned
		// across the force-push native modal.
		expect(js).toMatch(/attachTextTip\(\s*el\('button',\s*\{[^}]*'data-inline':\s*'discard',[^}]*\},\s*\[el\('i',\s*\{\s*className:\s*'codicon codicon-discard'\s*\}\)\]\),\s*'Discard Changes',\s*\)/);
	});

	it("re-requests root listing when switching into KB folders mode with empty cache", () => {
		const js = buildSidebarScript();
		// Without this, init-time fetch is the only kb:expandFolder trigger and
		// folders mode shows "Loading..." forever for users who first land on
		// Branch/Status and only later click Memory Bank.
		expect(js).toContain(
			"if (!folderCache['']) vscode.postMessage({ type: 'kb:expandFolder', path: '' })",
		);
	});

	it("renders M/P/N letter glyphs for memory/plan/note file nodes", () => {
		const js = buildSidebarScript();
		// Check the literal mapping is present so the renderer assigns a kind-
		// specific glyph (rather than a generic 📄) to manifest-tracked files.
		expect(js).toContain("fileKind === 'memory'");
		expect(js).toContain("fileKind === 'plan'");
		expect(js).toContain("fileKind === 'note'");
		expect(js).toContain("kb-icon-");
	});

	it("attaches data-file-kind and data-key attributes to file tree nodes", () => {
		const js = buildSidebarScript();
		expect(js).toContain("data-file-kind");
		expect(js).toContain("data-key");
	});

	it("emits data-diverged='1' on file tree nodes when isDiverged is true", () => {
		const js = buildSidebarScript();
		// The renderer must add the attribute conditional on child.isDiverged,
		// not unconditionally — the contextmenu handler uses its presence as
		// the gating signal for the Revert entry. Boolean-attr convention
		// (presence = true) matches the surrounding data-current-repo pattern.
		expect(js).toContain("child.isDiverged");
		expect(js).toContain("data-diverged");
		expect(js).toContain("'1'");
	});

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
		// The Revert entry is gated on the attribute set by the renderer; without
		// it the menu is unchanged for non-edited files. Wrapper command is the
		// relPath-aware variant — the abs-path form revertMemoryFileEdits is
		// invoked indirectly from the extension side.
		expect(js).toContain("data-diverged");
		expect(js).toContain("Revert to System Version");
		expect(js).toContain("jollimemory.revertMemoryFileByRelPath");
	});

	it("declares renderMemories function", () => {
		const js = buildSidebarScript();
		expect(js).toContain("function renderMemories");
	});

	it("declares Folders/Memories toggle actions", () => {
		const js = buildSidebarScript();
		expect(js).toContain("'kb-mode-folders'");
		expect(js).toContain("'kb-mode-memories'");
	});

	it("renders an always-visible search input in memories mode", () => {
		const js = buildSidebarScript();
		// Search affordance is now an inline <input> with a leading codicon —
		// no toggle button. The input id is referenced by both the toolbar
		// builder and the global keydown listener that fires kb:search.
		expect(js).toContain("kb-search-input");
		expect(js).toContain("'kb:search'");
		expect(js).toContain("'kb:clearSearch'");
		// No more toggle button:
		expect(js).not.toContain("'kb-toggle-search'");
	});

	it("renders repos as top-level nodes (no Memory Bank header banner)", () => {
		const js = buildSidebarScript();
		// renderFolders() has no separate header — repos render directly at
		// depth 0. The banner row would have re-emitted data-kind="repo-root";
		// removing that surface is the observable contract here.
		expect(js).not.toContain("'data-kind': 'repo-root'");
		expect(js).toContain("renderFolderChildren(root.children, 0)");
	});

	it("auto-expands the current repo via kb:expandFolder on first delivery", () => {
		const js = buildSidebarScript();
		// One-shot helper that walks root.children, finds the
		// isCurrentRepo+isRepoRoot entry, and fires kb:expandFolder against
		// its repoDirName. Without it the user has to click the current repo
		// after every reload — the IntelliJ Memory Bank tool window auto-
		// expands the current repo and this matches that UX.
		expect(js).toContain("maybeAutoExpandCurrentRepo");
		expect(js).toContain("currentRepoAutoExpanded");
		expect(js).toMatch(/isCurrentRepo && c\.isRepoRoot/);
	});

	it("re-arms the auto-expand guard on kb:foldersReset", () => {
		const js = buildSidebarScript();
		// Migrate to Memory Bank emits kb:foldersReset and may rename the
		// current repo's folder. The next kb:foldersData must auto-expand
		// the (potentially renamed) current repo, so the one-shot has to
		// reset alongside the cache wipe.
		expect(js).toMatch(/kb:foldersReset[\s\S]*currentRepoAutoExpanded = false/);
	});

	it("treats data-kind=repo clicks as expand/collapse (not openFile)", () => {
		const js = buildSidebarScript();
		// Repo nodes are directories on disk; the previous handler fell
		// through to kb:openFile because data-kind was 'repo' (not 'dir'),
		// and the host's openTextDocument failed with "is a directory" —
		// see the screenshot in this task's review. Repos must share the
		// dir branch's toggle logic.
		expect(js).toMatch(/kind === 'dir' \|\| kind === 'repo'/);
		// And the dead 'repo-root' early-return is gone with the banner.
		expect(js).not.toContain("if (kind === 'repo-root') return");
	});

	it("uses a codicon for the refresh button (matches VSCode toolbar style)", () => {
		const js = buildSidebarScript();
		// The toolbar builder calls iconButton('refresh', 'Refresh', 'refresh')
		// which renders <i class="codicon codicon-refresh">. Check the helper
		// invocation since the literal class name is built via concatenation.
		expect(js).toMatch(/iconButton\('refresh',\s*'Refresh',\s*'refresh'\)/);
		expect(js).toContain("'codicon codicon-' + codicon");
	});

	it("renders memory-row without a title attribute (custom hover card replaces native tooltip)", () => {
		const js = buildSidebarScript();
		// The legacy `title: m.tooltip` would surface a duplicate native tooltip
		// next to the custom hover card. Make sure that's gone.
		expect(js).not.toContain("title: m.tooltip");
	});

	it("renders a custom hover card with codicons + command links (1:1 native MarkdownString tooltip parity)", () => {
		const js = buildSidebarScript();
		expect(js).toContain("function renderHoverCard");
		// Codicons matching the legacy MarkdownString tooltip.
		expect(js).toContain("codicon-clock");
		expect(js).toContain("codicon-git-branch");
		expect(js).toContain("codicon-eye");
		// Command links — must dispatch via the existing 'command' message
		// type so SidebarWebviewProvider routes them through executeCommand.
		expect(js).toContain("'jollimemory.copyCommitHash'");
		expect(js).toContain("'jollimemory.viewMemorySummary'");
	});

	it("positions hover card via JS-driven CSSStyleDeclaration writes (CSP-safe)", () => {
		const js = buildSidebarScript();
		// CSP forbids HTML inline style attributes but allows runtime style
		// property writes — this matches the existing context-menu pattern.
		expect(js).toContain("hoverCardEl.style.left");
		expect(js).toContain("hoverCardEl.style.top");
	});

	it("caps hover-card height + scrolls when neither side of the cursor fits the natural height", () => {
		const js = buildSidebarScript();
		// Regression: when a memory row is near the panel bottom, flipping the
		// card above the cursor could still overflow if the card's natural
		// height exceeds the space above. The fit-or-clamp branch must pick
		// the larger side and cap maxHeight + enable overflowY so the card
		// never bleeds past the viewport edge.
		expect(js).toContain("spaceBelow");
		expect(js).toContain("spaceAbove");
		expect(js).toContain("hoverCardEl.style.maxHeight");
		expect(js).toContain("hoverCardEl.style.overflowY");
	});

	it("renders a copy-recall-prompt button on each memory row", () => {
		const js = buildSidebarScript();
		// Inline action wired to jollimemory.copyRecallPrompt with the row's
		// commit hash — clicking it must not bubble into kb:openMemory.
		expect(js).toContain("'data-inline': 'copy-recall'");
		expect(js).toContain("'data-hash': m.commitHash");
		expect(js).toContain("codicon-copy");
		expect(js).toContain("'jollimemory.copyRecallPrompt'");
	});

	it("formats relative time", () => {
		const js = buildSidebarScript();
		expect(js).toContain("function timeAgo");
	});

	it("handles kb:memoriesData inbound messages", () => {
		const js = buildSidebarScript();
		expect(js).toContain("'kb:memoriesData'");
	});

	it("declares renderBranch function", () => {
		const js = buildSidebarScript();
		expect(js).toContain("function renderBranch");
	});

	it("renders 3 named sections in branch tab", () => {
		const js = buildSidebarScript();
		expect(js).toContain("'plans'");
		expect(js).toContain("'changes'");
		expect(js).toContain("'commits'");
	});

	it("posts section:toggle on header click", () => {
		const js = buildSidebarScript();
		expect(js).toContain("section:toggle");
	});

	it("handles branch:plansData / changesData / commitsData inbound", () => {
		const js = buildSidebarScript();
		expect(js).toContain("'branch:plansData'");
		expect(js).toContain("'branch:changesData'");
		expect(js).toContain("'branch:commitsData'");
	});

	it("renders Plans section actions (add submenu only — refresh moved to global toolbar)", () => {
		const js = buildSidebarScript();
		expect(js).toContain("'plans-add-menu'");
		expect(js).not.toContain("'plans-refresh'");
	});

	it("forwards branch:openPlan when a plan row is clicked", () => {
		const js = buildSidebarScript();
		expect(js).toContain("branch:openPlan");
	});

	it("renders Changes section action (Select All)", () => {
		const js = buildSidebarScript();
		expect(js).toContain("'changes-select-all'");
	});

	it("forwards branch:openChange when a file row is clicked", () => {
		const js = buildSidebarScript();
		expect(js).toContain("branch:openChange");
	});

	it("declares a context menu component", () => {
		const js = buildSidebarScript();
		expect(js).toContain("function showContextMenu");
	});

	it("renders Commits section action (Select All)", () => {
		const js = buildSidebarScript();
		expect(js).toContain("'commits-select-all'");
	});

	it("forwards branch:openCommit when a commit row is clicked", () => {
		const js = buildSidebarScript();
		expect(js).toContain("branch:openCommit");
	});

	it("does not introduce innerHTML usage", () => {
		const js = buildSidebarScript();
		expect(js).not.toMatch(/\.innerHTML\s*=/);
	});

	it("posts open-settings command when settings button is clicked", () => {
		const js = buildSidebarScript();
		expect(js).toContain("open-settings");
		expect(js).toContain("jollimemory.openSettings");
	});

	it("updates status indicator color class in renderStatus", () => {
		const js = buildSidebarScript();
		expect(js).toContain("status-icon-btn");
		expect(js).toContain("status-icon-ok");
		expect(js).toContain("status-icon-warn");
		expect(js).toContain("status-icon-error");
		expect(js).toContain("codicon-circle-filled");
	});

	it("attaches the plain-text tooltip helper to status entry rows", () => {
		const js = buildSidebarScript();
		// Native title= on rows / children was unreliable in VSCode webviews
		// (focus transitions, IPC quirks, per-node hover-rest timer reset).
		// Rows now use attachTextTip(row, e.tooltip || '') instead, which
		// drives a custom .text-tip element via mouseenter/mouseleave.
		expect(js).toContain("attachTextTip(row, e.tooltip || '')");
		expect(js).not.toContain("title: e.tooltip || ''");
	});

	describe("renderPlanRow", () => {
		it("declares a function named renderPlanRow", () => {
			const js = buildSidebarScript();
			expect(js).toContain("function renderPlanRow");
		});

		it("routes plan inline edit to jollimemory.editPlan", () => {
			const js = buildSidebarScript();
			expect(js).toContain("'jollimemory.editPlan'");
		});

		it("routes note inline edit to jollimemory.editNote", () => {
			const js = buildSidebarScript();
			expect(js).toContain("'jollimemory.editNote'");
		});

		it("routes note inline remove to jollimemory.removeNote", () => {
			const js = buildSidebarScript();
			expect(js).toContain("'jollimemory.removeNote'");
		});

		it("uses contextValue to switch between plan and note commands", () => {
			const js = buildSidebarScript();
			expect(js).toMatch(/ctx\s*===\s*['"]note['"]/);
		});
	});

	describe("renderChangeRow", () => {
		it("declares a function named renderChangeRow", () => {
			const js = buildSidebarScript();
			expect(js).toContain("function renderChangeRow");
		});

		it("renders an <input type=checkbox> element bound to isSelected", () => {
			const js = buildSidebarScript();
			expect(js).toContain("type: 'checkbox'");
			expect(js).toMatch(/isSelected/);
		});

		it("applies a .gs-<gitStatus> class on the label", () => {
			const js = buildSidebarScript();
			expect(js).toMatch(/'gs-'\s*\+/);
		});

		it("emits codicon class for file icons (codicon-diff-modified etc)", () => {
			const js = buildSidebarScript();
			expect(js).toMatch(/codicon-diff-/);
		});

		it("posts branch:toggleFileSelection on checkbox change with stopPropagation", () => {
			const js = buildSidebarScript();
			expect(js).toContain("type: 'branch:toggleFileSelection'");
			expect(js).toContain("stopPropagation");
		});

		it("renders a discard inline button on file rows", () => {
			const js = buildSidebarScript();
			expect(js).toContain("'data-inline': 'discard'");
		});

		it("uses the codicon-discard glyph (no emoji) for inline discard", () => {
			const js = buildSidebarScript();
			expect(js).toContain("codicon codicon-discard");
		});

		it("routes inline-discard click through branch:discardFile, not the generic command bridge", () => {
			// Regression: jollimemory.discardFileChanges expects a FileItem
			// instance (it reads item.fileStatus.{relativePath,statusCode}).
			// Posting `{type:'command', command:'jollimemory.discardFileChanges',
			// args:[id]}` hands it a bare absolutePath string and the
			// `if (!item?.fileStatus) return;` guard silently swallows the
			// click. The dedicated branch:discardFile message lets the host
			// rebuild the FileItem-shape from filePath/relativePath/statusCode.
			const js = buildSidebarScript();
			expect(js).toContain("type: 'branch:discardFile'");
			// Belt-and-braces: the old generic-command form must NOT come back.
			expect(js).not.toMatch(
				/command:\s*['"]jollimemory\.discardFileChanges['"]/,
			);
		});

		it("inline-discard and context-menu discard both carry indexStatus + worktreeStatus + originalPath", () => {
			// Regression: bridge.discardFiles dispatches on the raw porcelain v1
			// columns (worktree-only restore vs staged-worktree restore vs unlink
			// for untracked / rename pair). Routing only the collapsed
			// statusCode used to land every file in the
			// `git restore --staged --worktree` branch and silently fail for
			// untracked files — the activity-bar badge stayed at the pre-discard
			// count even though the user had clicked discard.
			//
			// File rows must expose the porcelain columns as data-* attrs,
			// and BOTH discard senders (inline button + context menu) must read
			// them off the row when posting branch:discardFile.
			const js = buildSidebarScript();
			expect(js).toContain("'data-index-status'");
			expect(js).toContain("'data-worktree-status'");
			expect(js).toContain("'data-original-path'");
			expect(js).toContain("data-index-status");
			expect(js).toContain("data-worktree-status");
			expect(js).toContain("data-original-path");
			// Two readers (inline button + context menu) — count both.
			const indexAttrReads = js.match(/data-index-status'/g)?.length ?? 0;
			expect(indexAttrReads).toBeGreaterThanOrEqual(3); // 1 setter + 2 readers
		});

		it("renders dirname-only description (not the full path)", () => {
			const js = buildSidebarScript();
			// Visual parity with renderCommitFileRow: changes rows show the
			// directory portion of relativePath next to the label, not the
			// full path. The lastIndexOf('/') slice is the truncation marker.
			const renderChangeRow = js.slice(
				js.indexOf("function renderChangeRow"),
				js.indexOf("function renderCommitRow"),
			);
			expect(renderChangeRow).toContain("className: 'desc'");
			expect(renderChangeRow).toContain("lastIndexOf('/')");
			// Must NOT push the full description (would render the basename
			// twice — once as label, once as desc).
			expect(renderChangeRow).not.toMatch(
				/className:\s*['"]desc['"][^}]*text:\s*item\.description\b/,
			);
		});

		it("renders trailing gs-letter status indicator", () => {
			const js = buildSidebarScript();
			const renderChangeRow = js.slice(
				js.indexOf("function renderChangeRow"),
				js.indexOf("function renderCommitRow"),
			);
			expect(renderChangeRow).toContain("'gs-letter gs-'");
		});

		it("uses pathToFileCodicon (file-type) instead of gitStatusToCodicon", () => {
			const js = buildSidebarScript();
			const renderChangeRow = js.slice(
				js.indexOf("function renderChangeRow"),
				js.indexOf("function renderCommitRow"),
			);
			// Two-channel encoding parity with commit-file: shape = file
			// kind, color = git status. Diff-modified-style dots are
			// retired here; gitStatusToCodicon may still exist for legacy
			// callers but renderChangeRow must not call it.
			expect(renderChangeRow).toContain("pathToFileCodicon(");
			expect(renderChangeRow).not.toContain("gitStatusToCodicon(");
		});

		it("tags changes rows with .tree-node--changes for the hover-reveal scope", () => {
			const js = buildSidebarScript();
			expect(js).toContain("'tree-node tree-node--changes'");
		});
	});

	describe("renderCommitRow", () => {
		it("declares a function named renderCommitRow", () => {
			const js = buildSidebarScript();
			expect(js).toContain("function renderCommitRow");
		});

		it("shows a viewSummary inline only for commitWithMemory contextValue", () => {
			const js = buildSidebarScript();
			expect(js).toMatch(/contextValue\s*===\s*['"]commitWithMemory['"]/);
			expect(js).toContain("'data-inline': 'viewSummary'");
		});

		it("renderSection routes to per-section row renderer based on section id", () => {
			const js = buildSidebarScript();
			// Confirm renderSection picks renderPlanRow / renderChangeRow / renderCommitRow.
			expect(js).toMatch(/renderPlanRow/);
			expect(js).toMatch(/renderChangeRow/);
			expect(js).toMatch(/renderCommitRow/);
		});

		it("fills the leading slot with a git-commit codicon when no checkbox is shown", () => {
			const js = buildSidebarScript();
			// Visual parity with the legacy native TreeView: HistoryTreeProvider
			// used to set iconPath = ThemeIcon("git-commit") in single-commit /
			// merged modes; the webview must do the same so the column doesn't
			// look empty when checkboxes are hidden.
			const renderCommitRow = js.slice(
				js.indexOf("function renderCommitRow"),
				js.indexOf("function renderCommitFileRow"),
			);
			expect(renderCommitRow).toContain("'codicon codicon-git-commit'");
		});
	});

	describe("plans toolbar", () => {
		it("renders only the ➕ submenu trigger (no per-section refresh)", () => {
			const js = buildSidebarScript();
			expect(js).toMatch(/iconButton\('plans-add-menu',/);
			expect(js).not.toContain("'plans-refresh'");
		});

		it("uses the codicon-add glyph for the add menu trigger", () => {
			const js = buildSidebarScript();
			expect(js).toMatch(/iconButton\('plans-add-menu',.*?'add'\)/);
		});

		it("plans-add-menu click invokes showContextMenu with three add commands", () => {
			const js = buildSidebarScript();
			expect(js).toContain("'jollimemory.addPlan'");
			expect(js).toContain("'jollimemory.addMarkdownNote'");
			expect(js).toContain("'jollimemory.addTextSnippet'");
		});
	});

	describe("changes toolbar", () => {
		it("renders three buttons: select-all, commitAI, discard (refresh removed)", () => {
			const js = buildSidebarScript();
			expect(js).toMatch(/iconButton\('changes-select-all',/);
			expect(js).toMatch(/iconButton\('changes-commit-ai',/);
			expect(js).toMatch(/iconButton\('changes-discard',/);
			expect(js).not.toContain("'changes-refresh'");
		});

		it("uses codicons matching package.json contributes (check-all / sparkle / discard)", () => {
			const js = buildSidebarScript();
			// `[,)]` accepts either a closing paren (no opts arg) or a comma
			// (followed by a 4th-arg opts object such as { disabled: ... }) —
			// the assertion only cares about the codicon string itself.
			expect(js).toMatch(/iconButton\('changes-select-all',.*?'check-all'[,)]/);
			expect(js).toMatch(/iconButton\('changes-commit-ai',.*?'sparkle'[,)]/);
			expect(js).toMatch(/iconButton\('changes-discard',.*?'discard'[,)]/);
		});

		it("routes changes-commit-ai to jollimemory.commitAI", () => {
			const js = buildSidebarScript();
			expect(js).toContain("'jollimemory.commitAI'");
		});

		it("routes changes-discard to jollimemory.discardSelectedChanges", () => {
			const js = buildSidebarScript();
			expect(js).toContain("'jollimemory.discardSelectedChanges'");
		});

		it("disables changes-commit-ai while a background AI summary is in progress", () => {
			const js = buildSidebarScript();
			// Even with selected changes, the Commit-AI button must stay
			// disabled when state.workerBusy is true — kicking off another
			// LLM call while the queue worker is mid-flight risks racing
			// the same provider / hitting rate limits. Discard stays
			// available because it's purely local (no LLM).
			expect(js).toMatch(
				/iconButton\('changes-commit-ai',[\s\S]*?disabled:\s*noneSelected\s*\|\|\s*state\.workerBusy/,
			);
			// Discard's disabled condition must NOT include workerBusy.
			expect(js).toMatch(
				/iconButton\('changes-discard',[\s\S]*?disabled:\s*noneSelected\s*\}/,
			);
		});
	});

	describe("section header click delegation", () => {
		// Section action buttons (+, ↻, ✓, etc.) live INSIDE .section-header.
		// If the click handler matches .section-header first and toggles
		// collapse before checking .section-actions, every action click also
		// collapses the panel — observed bug: + on Plans shows no menu, ↻ on
		// Changes/Commits does nothing, both end up just folding the section.
		// The action-button check must come before the header collapse check.
		it("checks .section-actions [data-action] before .section-header collapse", () => {
			const js = buildSidebarScript();
			const sectionActionIdx = js.indexOf(".section-actions [data-action]");
			const sectionHeaderIdx = js.indexOf(".section-header");
			expect(sectionActionIdx).toBeGreaterThan(-1);
			expect(sectionHeaderIdx).toBeGreaterThan(-1);
			expect(sectionActionIdx).toBeLessThan(sectionHeaderIdx);
		});
	});

	describe("commits toolbar mode-aware", () => {
		it("declares branchData.commitsMode field consumed by renderSectionActions", () => {
			const js = buildSidebarScript();
			expect(js).toContain("commitsMode");
		});

		it("renders multi mode toolbar action: squash", () => {
			const js = buildSidebarScript();
			expect(js).toMatch(/iconButton\('commits-squash',/);
		});

		it("does not render a per-section refresh in commits toolbar", () => {
			const js = buildSidebarScript();
			expect(js).not.toContain("'commits-refresh'");
		});

		it("renders single mode toolbar action: pushBranch", () => {
			const js = buildSidebarScript();
			expect(js).toMatch(/iconButton\('commits-push-branch',/);
		});

		it("multi mode toolbar includes pushBranch alongside select-all and squash", () => {
			// Multi-commit branches now support push directly (no squash precondition).
			// Assert the multi branch in the rendered JS contains all three button ids.
			const js = buildSidebarScript();
			const multiMatch = js.match(
				/if \(m === 'multi'\)[\s\S]*?return \[([\s\S]*?)\];/,
			);
			expect(multiMatch).not.toBeNull();
			const multiArr = multiMatch?.[1] ?? "";
			expect(multiArr).toMatch(/iconButton\('commits-select-all',/);
			expect(multiArr).toMatch(/iconButton\('commits-squash',/);
			expect(multiArr).toMatch(/iconButton\('commits-push-branch',/);
		});

		it("uses codicons matching package.json contributes (check-all / git-merge / cloud-upload)", () => {
			const js = buildSidebarScript();
			// `[,)]` accepts either a closing paren (no opts arg) or a comma
			// (followed by a 4th-arg opts object such as { disabled: ... }).
			expect(js).toMatch(/iconButton\('commits-select-all',.*?'check-all'[,)]/);
			expect(js).toMatch(/iconButton\('commits-squash',.*?'git-merge'[,)]/);
			expect(js).toMatch(
				/iconButton\('commits-push-branch',.*?'cloud-upload'[,)]/,
			);
		});

		it("routes commits-squash to jollimemory.squash", () => {
			const js = buildSidebarScript();
			expect(js).toContain("'jollimemory.squash'");
		});

		it("routes commits-push-branch to jollimemory.pushBranch", () => {
			const js = buildSidebarScript();
			expect(js).toContain("'jollimemory.pushBranch'");
		});
	});

	describe("native context menu suppression", () => {
		it("KB tab suppresses the native menu on empty area (preventDefault on the no-row branch)", () => {
			const js = buildSidebarScript();
			// The no-memory-row branch must call preventDefault before bailing —
			// otherwise the embedded Chromium Cut/Copy/Paste menu shows through.
			expect(js).toMatch(
				/\.memory-row\[data-hash\]'\);\s*if\s*\(!row\)\s*\{\s*e\.preventDefault\(\);\s*return;/,
			);
		});

		it("Branch tab preventDefaults at the top of its contextmenu handler (covers all sections)", () => {
			const js = buildSidebarScript();
			expect(js).toMatch(
				/tabContents\.branch\.addEventListener\('contextmenu',\s*function\(e\)\s*\{\s*e\.preventDefault\(\);/,
			);
		});

		it("Status tab attaches a contextmenu handler that preventDefaults", () => {
			const js = buildSidebarScript();
			expect(js).toMatch(
				/tabContents\.status\.addEventListener\('contextmenu',\s*function\(e\)\s*\{\s*e\.preventDefault\(\);/,
			);
		});
	});

	describe("Plans & Notes / Changes context menus", () => {
		it("Plans & Notes rows show 'Edit Plan' / 'Edit Note' depending on contextValue", () => {
			const js = buildSidebarScript();
			// ctx === 'note' picks editNote + 'Edit Note'; plan/plansItem fall through
			// to editPlan + 'Edit Plan'. Both labels must appear in the bundled script.
			expect(js).toContain("'Edit Plan'");
			expect(js).toContain("'Edit Note'");
			expect(js).toContain("'jollimemory.editPlan'");
			expect(js).toContain("'jollimemory.editNote'");
		});

		it("Plans & Notes context menu handler matches plan / plansItem / note contextValues", () => {
			const js = buildSidebarScript();
			expect(js).toContain(
				"ctx === 'plan' || ctx === 'plansItem' || ctx === 'note'",
			);
		});

		it("Changes rows show a 'Discard Changes' entry that posts branch:discardFile", () => {
			const js = buildSidebarScript();
			expect(js).toContain("'Discard Changes'");
			// The Discard Changes entry routes through rawMessage so it can target
			// branch:discardFile (not the generic 'command' bridge).
			expect(js).toContain("rawMessage:");
			expect(js).toContain("'branch:discardFile'");
		});

		it("showContextMenu wires data-raw-msg for items carrying rawMessage", () => {
			const js = buildSidebarScript();
			expect(js).toContain("'data-raw-msg'");
		});

		it("ctxMenu click handler dispatches data-raw-msg verbatim before falling back to data-cmd", () => {
			const js = buildSidebarScript();
			// Regex anchored on the click handler body — the raw branch must run
			// first, otherwise rawMessage items would be interpreted as
			// { type: 'command', command: null }.
			expect(js).toMatch(
				/ctxMenu\.addEventListener\('click',[\s\S]*?data-raw-msg[\s\S]*?data-cmd/,
			);
		});
	});

	describe("onboarding panel toggle", () => {
		it("handles configured:changed messages", () => {
			const js = buildSidebarScript();
			expect(js).toContain("'configured:changed'");
		});

		it("configured:changed false→true (onboarding completed) switches to the Status tab", () => {
			const js = buildSidebarScript();
			// Both onboarding completion paths — sign-in OAuth callback and
			// inline API key save — flip configured from false to true via
			// statusStore.refresh, so the same handler must land the user on
			// the Status tab (where they see auth state, settings entry, and
			// the worker indicator) instead of the default Branch tab.
			const start = js.indexOf("case 'configured:changed'");
			expect(start).toBeGreaterThan(-1);
			const end = js.indexOf("case '", start + 1);
			const body = js.slice(start, end);
			// Capture the prior value BEFORE applyConfigured mutates it; the
			// edge detection collapses to !wasConfigured && msg.configured.
			// Reading state.configured AFTER applyConfigured would always
			// reflect the new value and the edge detection would collapse to
			// always-false (true→true) or always-true (false→false), neither
			// of which fires switchTab('status') correctly.
			expect(body).toMatch(
				/const\s+wasConfigured\s*=\s*state\.configured[\s\S]{0,200}applyConfigured\(/,
			);
			expect(body).toMatch(
				/!wasConfigured[\s\S]{0,40}switchTab\(['"]status['"]\)/,
			);
		});

		it("configured:changed true→true (already configured) does NOT auto-switch the user's tab", () => {
			const js = buildSidebarScript();
			// Re-broadcasts of configured=true happen routinely (host
			// statusStore.refresh during background polls, init race). We
			// must not yank the user out of whatever tab they're on — the
			// auto-switch is gated on the false→true edge, not the value.
			const start = js.indexOf("case 'configured:changed'");
			const end = js.indexOf("case '", start + 1);
			const body = js.slice(start, end);
			// The switchTab('status') call MUST be guarded by !wasConfigured.
			// A bare switchTab('status') inside the msg.configured branch
			// would steal the tab on every same-value push.
			const switchIdx = body.indexOf("switchTab('status')");
			expect(switchIdx).toBeGreaterThan(-1);
			// Walk backwards to the nearest `if` and assert it gates on the edge.
			const guardSlice = body.slice(0, switchIdx);
			const lastIfIdx = guardSlice.lastIndexOf("if");
			expect(lastIfIdx).toBeGreaterThan(-1);
			expect(guardSlice.slice(lastIfIdx)).toContain("!wasConfigured");
		});

		it("references the onboarding panel id when toggling visibility", () => {
			const js = buildSidebarScript();
			expect(js).toContain("onboarding-panel");
		});

		it("wires onboarding signin button to dispatch jollimemory.signIn", () => {
			const js = buildSidebarScript();
			expect(js).toContain("onboarding-signin-btn");
			expect(js).toContain("'jollimemory.signIn'");
		});

		it("wires onboarding apikey button to swap into the inline apikey-panel (NOT openSettings)", () => {
			const js = buildSidebarScript();
			expect(js).toContain("onboarding-apikey-btn");
			// Configure API Key now stays in-panel: it switches to the
			// apikey-panel sibling instead of opening the full Settings
			// webview, so the user sees a single API key field instead of
			// the dozen unrelated Settings options.
			const start = js.indexOf("onboardingApikeyBtn.addEventListener");
			const end = js.indexOf("});", start);
			expect(start).toBeGreaterThan(-1);
			const handler = js.slice(start, end);
			expect(handler).toContain("showApikeyPanel");
			// The handler MUST NOT post the openSettings command — that's
			// the legacy gear-icon path and would re-open the regression.
			expect(handler).not.toContain("jollimemory.openSettings");
		});

		it("apikey-panel: showApikeyPanel hides onboarding cards and shows the input view (and resets transient state)", () => {
			const js = buildSidebarScript();
			expect(js).toContain("function showApikeyPanel");
			const start = js.indexOf("function showApikeyPanel");
			const end = js.indexOf("function ", start + 1);
			const body = js.slice(start, end);
			// Mutually exclusive view swap.
			expect(body).toContain("onboardingPanel.classList.add('hidden')");
			expect(body).toContain("apikeyPanel.classList.remove('hidden')");
			// Reset transient state on every (re-)entry: clear any stale
			// error / value / saving label that might have been left over
			// from a prior attempt the user backed out of.
			expect(body).toContain("apikeyError.classList.add('hidden')");
			expect(body).toContain("apikeyError.textContent = ''");
			expect(body).toContain("apikeyInput.value = ''");
			expect(body).toContain("apikeySaveBtn.disabled = true");
			expect(body).toMatch(/apikeySaveBtn\.textContent\s*=\s*['"]Save['"]/);
		});

		it("apikey-panel: Save button disabled while input is empty, enabled on non-empty trim", () => {
			const js = buildSidebarScript();
			// The button starts disabled (HTML attribute) and the input
			// listener flips it based on `value.trim().length === 0`. Trim
			// matters because pasting "  sk-ant-...  " with stray whitespace
			// would otherwise look valid client-side and then fail server-side.
			expect(js).toMatch(
				/apikeyInput\.addEventListener\(['"]input['"][\s\S]{0,400}apikeySaveBtn\.disabled\s*=\s*apikeyInput\.value\.trim\(\)\.length\s*===\s*0/,
			);
		});

		it("apikey-panel: Enter key in the input submits when Save is enabled", () => {
			const js = buildSidebarScript();
			// Keyboard accelerator parity with the click path. preventDefault
			// stops the form-submit-style page reload that would otherwise
			// blow away the webview state.
			expect(js).toMatch(
				/apikeyInput\.addEventListener\(['"]keydown['"][\s\S]{0,400}e\.key\s*===\s*['"]Enter['"][\s\S]{0,200}submitApikey\(\)/,
			);
		});

		it("apikey-panel: submitApikey dispatches jollimemory.saveAnthropicApiKey with the trimmed key and shows Saving…", () => {
			const js = buildSidebarScript();
			expect(js).toContain("function submitApikey");
			const start = js.indexOf("function submitApikey");
			const end = js.indexOf("\n  }", start);
			const body = js.slice(start, end);
			// Trim is enforced once more on the host-bound side so a race
			// where the disabled flag got bypassed (focus-lost + click
			// timing) still doesn't ship whitespace to disk.
			expect(body).toMatch(/apikeyInput\.value\.trim\(\)/);
			expect(body).toMatch(/apikeySaveBtn\.textContent\s*=\s*['"]Saving/);
			expect(body).toContain("'jollimemory.saveAnthropicApiKey'");
			// The arg is forwarded as args:[key] so executeCommand's variadic
			// invocation in SidebarWebviewProvider.handleOutbound spreads it
			// into the registered handler's first positional parameter.
			expect(body).toMatch(/args:\s*\[\s*key\s*\]/);
		});

		it("apikey-panel: Back button restores the onboarding cards view", () => {
			const js = buildSidebarScript();
			expect(js).toContain("function showOnboardingPanel");
			expect(js).toMatch(
				/apikeyBackBtn\.addEventListener\(['"]click['"]\s*,\s*showOnboardingPanel\)/,
			);
		});

		it("apikey-panel: apikey:saveError re-enables Save and surfaces the message inline (only when panel is still active)", () => {
			const js = buildSidebarScript();
			// Anchor on the case label to avoid landing on the comment that
			// also mentions the message type inside submitApikey.
			expect(js).toContain("case 'apikey:saveError'");
			const start = js.indexOf("case 'apikey:saveError'");
			const end = js.indexOf("break", start);
			const body = js.slice(start, end);
			// Guard: if the panel was already retired by applyConfigured
			// (success raced past us), don't re-show the input — the user
			// is already on the main UI and a stale error would be confusing.
			expect(body).toContain("apikeyPanel.classList.contains('hidden')");
			// Re-enable Save (re-deriving from input.trim()) and restore the
			// label so the user can edit and retry.
			expect(body).toMatch(/apikeySaveBtn\.disabled\s*=/);
			expect(body).toMatch(/apikeySaveBtn\.textContent\s*=\s*['"]Save['"]/);
			expect(body).toContain("apikeyError.classList.remove('hidden')");
			// Fall-back string when the host posts an empty/non-string message.
			expect(body).toContain("Failed to save the API key.");
		});

		it("applyConfigured(true) hides the apikey-panel along with the onboarding-panel", () => {
			const js = buildSidebarScript();
			// The apikey-panel is a sub-view of the configured===false flow,
			// so the same configured:changed(true) hand-off that retires the
			// onboarding cards must retire the input view too. Otherwise a
			// successful save would flip configured but leave the input
			// stranded on top of the tab UI.
			const start = js.indexOf("function applyConfigured");
			const trueBranch = js.indexOf(
				"onboardingPanel.classList.add('hidden')",
				start,
			);
			expect(trueBranch).toBeGreaterThan(-1);
			const window = js.slice(trueBranch, trueBranch + 400);
			expect(window).toContain("apikeyPanel.classList.add('hidden')");
		});

		it("applyConfigured(false) resets to the cards view (not the apikey-panel)", () => {
			const js = buildSidebarScript();
			// The apikey-panel is not a stable state — it's a transient
			// sub-view the user opted into. If configured flips back to
			// false (e.g. user signed out), reset to the cards so they can
			// pick API key OR Sign In again, not whichever sub-view they
			// happened to be on last.
			const start = js.indexOf("function applyConfigured");
			const falseBranch = js.indexOf(
				"onboardingPanel.classList.remove('hidden')",
				start,
			);
			expect(falseBranch).toBeGreaterThan(-1);
			const window = js.slice(falseBranch, falseBranch + 400);
			expect(window).toContain("apikeyPanel.classList.add('hidden')");
		});

		it("reads configured from init state", () => {
			const js = buildSidebarScript();
			// The init handler must consult msg.state.configured to pick the
			// onboarding-vs-main branch on first paint.
			expect(js).toMatch(/msg\.state\.configured/);
		});

		it("applyConfigured(true) un-hides the tabBar via applyEnabled's toggle", () => {
			const js = buildSidebarScript();
			// applyConfigured(false) adds .hidden to #tab-bar to clear room
			// for the onboarding panel. applyConfigured(true) delegates to
			// applyEnabled(state.enabled), which now owns the tabBar
			// .hidden flag (see "disabled mode hides every tab-content..."
			// for the toggle assertion). The path back from onboarding is
			// therefore covered by that single toggle in applyEnabled —
			// when the host pushes enabled === true, tabBar reappears.
			expect(js).toContain("function applyConfigured");
			// The configured===true branch must end by delegating to applyEnabled
			// so the tab bar / toolbar / contents resync against the host's
			// enabled flag instead of being left stuck in onboarding-hidden state.
			const start = js.indexOf("function applyConfigured");
			const end = js.indexOf("function ", start + 1);
			expect(js.slice(start, end)).toMatch(/applyEnabled\(state\.enabled\)/);
		});
	});

	describe("Commit Memory button visibility on the Changes section", () => {
		// User-visible CTA must remain rendered (a) when Changes is empty (so
		// users can discover it during onboarding before they've staged
		// anything), AND (b) when the Changes section is collapsed (Commit
		// Memory is a group action across Plans + Changes + Commits — folding
		// Changes alone shouldn't hide it). It is implicitly hidden in
		// foreign-readonly mode because the whole Changes section is dropped
		// above the predicate. Neither items.length nor `collapsed` may gate
		// the push site.
		it("pushes the button on the Changes section without gating on items.length or collapsed", () => {
			const js = buildSidebarScript();
			// Find the push site. Must match `s.id === 'changes'` but NOT
			// include `!collapsed` (regression — collapsing Changes hid the
			// group CTA) nor `s.items.length` (regression — empty Changes hid
			// the discoverability affordance).
			const renderSectionStart = js.indexOf("function renderSection");
			expect(renderSectionStart).toBeGreaterThan(-1);
			const renderSectionEnd = js.indexOf(
				"function ",
				renderSectionStart + "function renderSection".length,
			);
			const body = js.slice(renderSectionStart, renderSectionEnd);
			expect(body).toMatch(
				/if\s*\(\s*s\.id\s*===\s*'changes'\s*\)\s*\{\s*sectionKids\.push\(renderCommitMemoryButton\(\)\)/,
			);
			// Defense-in-depth: neither old buggy predicate may reappear.
			expect(body).not.toMatch(
				/s\.items\.length\s*>\s*0[\s\S]{0,80}renderCommitMemoryButton/,
			);
			expect(body).not.toMatch(
				/!collapsed[\s\S]{0,80}renderCommitMemoryButton/,
			);
		});

		it("renders a 'Viewing memories from <repo> / <branch>' banner in foreign mode with conditional (read-only) suffix", () => {
			// Visual companion to the foreign-readonly CSS hook class: in
			// foreign mode the workspace-bound sections (plans / changes /
			// conversations) all drop out, leaving the Memories list alone.
			// Without an explicit label users have no in-panel signal that
			// they are viewing another repo. IntelliJ's CommitsPanel renders
			// the same banner (CommitsPanel.kt:722) — pinning the wording so
			// the two surfaces stay aligned. The text builder lives in
			// SidebarScriptBuilder so the message wording is searchable from
			// the same place the foreign-mode branching logic lives.
			//
			// The "(read-only)" suffix is gated on `repoForeign` (selectedRepo
			// != currentRepo). Browsing another branch in the workspace repo
			// drops the suffix because that branch is not actually read-only —
			// the user could check it out. Both flavors keep the banner element
			// + the trailing reset affordance.
			const js = buildSidebarScript();
			// Banner text fragment — kept as a single literal so renames are
			// loud (greppable). Wording stays in lockstep with IntelliJ's.
			expect(js).toContain("Viewing memories from");
			// Suffix is conditional on repoForeign — the ternary is the
			// single source of truth, so renaming "(read-only)" without
			// touching both sides will not regress silently.
			expect(js).toMatch(/repoForeign\s*\?\s*' \(read-only\)'\s*:\s*''/);
			// Banner element carries its own CSS class so SidebarCssBuilder
			// can style it independently of the existing
			// `conversations-warning` partial-data banner.
			expect(js).toContain("'foreign-banner'");
		});

		it("foreign-banner trails a 'Switch back to current workspace' reset button (CSP-safe <button data-action=...>)", () => {
			// CSP forbids inline onclick / javascript: hrefs in the sidebar
			// webview, so the reset affordance must be a <button> wired
			// through tabContents.branch's click delegation block. This
			// test pins three things: button label, data-action key, and
			// CSS class so the styling/dispatch contract stays intact.
			const js = buildSidebarScript();
			expect(js).toContain("Switch back to current workspace");
			expect(js).toContain("'reset-to-workspace'");
			expect(js).toContain("'foreign-banner-reset'");
		});

		it("reset-to-workspace click posts two selection:request messages (repo first, then branch) so workspace identity collapses cleanly", () => {
			// Host-side handleSelectionRequest is single-field if/else — a
			// combined { repoName, branchName } payload would silently drop
			// the branch. The fix is two messages: repo first (host auto-picks
			// branches[0]), then branch (overrides the auto-pick with the real
			// workspace branch). If a future change merges these into one
			// payload, that handler must learn to handle both fields together
			// — this test catches the regression.
			const js = buildSidebarScript();
			const branchClickIdx = js.indexOf(
				"tabContents.branch.addEventListener('click'",
			);
			expect(branchClickIdx).toBeGreaterThan(-1);
			// Slice generously — the reset block is at the top of the handler
			// but later branches (commitMemoryBtn, section actions) are also
			// captured, which is fine for a containment assertion.
			const handler = js.slice(branchClickIdx, branchClickIdx + 4000);
			expect(handler).toContain('data-action="reset-to-workspace"');
			expect(handler).toMatch(
				/selection:request[\s\S]{0,200}repoName:\s*state\.currentRepoName/,
			);
			expect(handler).toMatch(
				/selection:request[\s\S]{0,200}branchName:\s*state\.branchName/,
			);
		});

		it("Changes section is dropped entirely in foreign-readonly mode (renderBranch only pushes plans/changes when !foreign)", () => {
			const js = buildSidebarScript();
			// The two non-Memories sections must be guarded by the foreign check
			// so the button predicate above never has a chance to match a foreign
			// branch tab. This is the implicit "hide the button when foreign"
			// path: no section, no predicate match, no button.
			const renderBranchStart = js.indexOf("function renderBranch");
			expect(renderBranchStart).toBeGreaterThan(-1);
			const renderBranchEnd = js.indexOf(
				"function ",
				renderBranchStart + "function renderBranch".length,
			);
			const body = js.slice(renderBranchStart, renderBranchEnd);
			expect(body).toMatch(/const foreign\s*=\s*isViewingForeign\(\)/);
			expect(body).toMatch(/if\s*\(\s*!foreign\s*\)/);
		});
	});

	describe("foreign-mode memory click routes through cross-repo lookup", () => {
		// Regression: after switching to a foreign repo/branch via the breadcrumb,
		// clicking a row in the Branch tab's Memories section silently no-ops.
		// Root cause: `branch:openCommit` → `jollimemory.viewSummary` →
		// `bridge.getSummary` is single-repo. Foreign memories live in another
		// repo's FolderStorage, so getSummary returns null and the handler's
		// `if (!summary) return;` swallows the click. The fix: in foreign mode,
		// route through `kb:openMemory` (→ `viewMemorySummary` → cross-repo
		// `getSummaryAnyRepoWithSource`), same path the KB tab already uses.
		it("commitWithMemory row click posts kb:openMemory in foreign mode", () => {
			const js = buildSidebarScript();
			// Locate the row-dispatch block inside tabContents.branch click handler.
			const branchClickIdx = js.indexOf(
				"tabContents.branch.addEventListener('click'",
			);
			expect(branchClickIdx).toBeGreaterThan(-1);
			const ctxBlockIdx = js.indexOf(
				"ctx === 'commit' || ctx === 'commitWithMemory'",
				branchClickIdx,
			);
			expect(ctxBlockIdx).toBeGreaterThan(-1);
			// The window after the predicate must show both branches:
			// foreign → kb:openMemory; workspace → branch:openCommit.
			const window = js.slice(ctxBlockIdx, ctxBlockIdx + 1200);
			expect(window).toContain("isViewingForeign()");
			expect(window).toContain("'kb:openMemory'");
			expect(window).toContain("'branch:openCommit'");
		});

		it("inline viewSummary button routes through viewMemorySummary in foreign mode", () => {
			const js = buildSidebarScript();
			// Find the inline-action `viewSummary` branch inside the Branch tab
			// click handler — the eye-icon button on commitWithMemory rows.
			const viewSummaryIdx = js.indexOf("action === 'viewSummary'");
			expect(viewSummaryIdx).toBeGreaterThan(-1);
			const window = js.slice(viewSummaryIdx, viewSummaryIdx + 800);
			// Foreign mode must dispatch the cross-repo command; workspace mode
			// keeps the single-repo viewSummary (panel slot "commit").
			expect(window).toContain("isViewingForeign()");
			expect(window).toContain("'jollimemory.viewMemorySummary'");
			expect(window).toContain("'jollimemory.viewSummary'");
		});

		it("foreign-mode commitWithMemory inline button is a copy-recall iconbtn (codicon-copy), not eye", () => {
			// Cross-repo browsing is dominated by "pull this memory into the
			// AI" — the primary inline tap-target switches to Copy Recall
			// Prompt to match the KB-tab timeline view. The eye affordance
			// still exists in the hover-card and contextmenu, so View Memory
			// is not lost.
			const js = buildSidebarScript();
			// Locate renderCommitRow's hasMem branch (where the inline button
			// lives) — we slice from the function header through the !hasMem
			// fallback so the assertions are contained.
			const fnIdx = js.indexOf("function renderCommitRow(");
			expect(fnIdx).toBeGreaterThan(-1);
			const fnEnd = js.indexOf("function ", fnIdx + 1);
			const body = js.slice(fnIdx, fnEnd > 0 ? fnEnd : fnIdx + 6000);
			// The branch must be gated on isViewingForeign() — non-foreign
			// rows must still render the eye/viewSummary affordance.
			expect(body).toContain("isViewingForeign()");
			expect(body).toMatch(/'data-inline':\s*'copy-recall'/);
			expect(body).toMatch(/codicon-copy/);
			// And the non-foreign branch must still be present so workspace
			// muscle memory is unchanged.
			expect(body).toMatch(/'data-inline':\s*'viewSummary'/);
			expect(body).toMatch(/codicon-eye/);
		});

		it("inline copy-recall dispatch posts jollimemory.copyRecallPrompt with the row id", () => {
			// The click delegation block on tabContents.branch must learn
			// about the new copy-recall action; otherwise the foreign-mode
			// icon click would no-op. id (= commitHash) flows through args[]
			// so copyRecallPrompt can resolve via the multi-repo index.
			//
			// Anchor the search at the Branch tab click handler — there's an
			// earlier copy-recall block on tabContents.kb that uses data-hash
			// instead of data-id, and a naive js.indexOf would land on that
			// (and pass the args:[hash] form on the wrong surface).
			const js = buildSidebarScript();
			const branchClickIdx = js.indexOf(
				"tabContents.branch.addEventListener('click'",
			);
			expect(branchClickIdx).toBeGreaterThan(-1);
			const idx = js.indexOf("action === 'copy-recall'", branchClickIdx);
			expect(idx).toBeGreaterThan(-1);
			const window = js.slice(idx, idx + 600);
			expect(window).toContain("'jollimemory.copyRecallPrompt'");
			expect(window).toMatch(/args:\s*\[id\]/);
		});

		it("foreign-mode commitWithMemory contextmenu mirrors the KB-tab timeline view (Copy Recall Prompt / Open in Claude Code / sep / View Memory)", () => {
			// Pins the cross-surface alignment — the KB tab's memory-row
			// contextmenu and the Branch tab's foreign Memories contextmenu
			// must share the same 3-action set so users get one mental model
			// for "right-click a memory". View Memory routes through
			// viewMemorySummary (cross-repo storage), NOT viewSummary
			// (workspace-only), or the click silently misses.
			const js = buildSidebarScript();
			const ctxIdx = js.indexOf(
				"tabContents.branch.addEventListener('contextmenu'",
			);
			expect(ctxIdx).toBeGreaterThan(-1);
			const window = js.slice(ctxIdx, ctxIdx + 2400);
			// Foreign branch of the commit/commitWithMemory predicate must
			// be gated explicitly (otherwise workspace-view would also flip).
			expect(window).toMatch(
				/isViewingForeign\(\)\s*&&\s*ctx\s*===\s*'commitWithMemory'/,
			);
			expect(window).toContain("'jollimemory.copyRecallPrompt'");
			expect(window).toContain("'jollimemory.openInClaudeCode'");
			expect(window).toContain("'jollimemory.viewMemorySummary'");
			// And the workspace path must still ship its original two-item
			// menu — View Memory (single-repo viewSummary) + Copy Commit Hash.
			expect(window).toContain("'jollimemory.viewSummary'");
			expect(window).toContain("'jollimemory.copyCommitHash'");
		});
	});

	describe("selection:set lazy branch-memories trigger", () => {
		// Regression: when the user picked a foreign branch directly (without
		// first picking a repo) the trigger guarded on state.selectedRepoName,
		// which is undefined on that path. The request never fired, the
		// Memories list rendered empty until the user also picked a repo.
		// Render, isViewingForeign, and the response handler all use the
		// `selectedX || currentX` fallback; the trigger must match.
		it("falls back to currentRepoName/branchName when the explicit pick omits the repo", () => {
			const js = buildSidebarScript();
			const setStart = js.indexOf("case 'selection:set'");
			expect(setStart).toBeGreaterThan(-1);
			const setEnd = js.indexOf("case '", setStart + 1);
			const block = js.slice(setStart, setEnd);
			// Both the repo and branch must be computed via the fallback —
			// otherwise picking only a branch (workspace repo + foreign branch)
			// never reaches selection:requestBranchMemories.
			expect(block).toMatch(
				/state\.selectedRepoName\s*\|\|\s*state\.currentRepoName/,
			);
			expect(block).toMatch(
				/state\.selectedBranchName\s*\|\|\s*state\.branchName/,
			);
			// And the resulting `repo`/`branch` locals must be what the trigger
			// sends to the host (not the raw state.selected* properties).
			expect(block).toMatch(
				/selection:requestBranchMemories[\s\S]*repoName:\s*repo[\s\S]*branchName:\s*branch/,
			);
		});
	});

	describe("selection:invalidateBranchMemories handler", () => {
		// Pins the three-way cache-key alignment (trigger / response / render)
		// extended to a fourth call site: invalidate. branchMemoriesCache is
		// session-sticky once written, so toolbar Refresh in foreign mode would
		// be a no-op without this handler. The fallback expression here must
		// match the other three call sites or invalidate refetches an empty key.
		it("drops every cache entry and re-fires the request with the same fallback key", () => {
			const js = buildSidebarScript();
			const caseStart = js.indexOf("case 'selection:invalidateBranchMemories'");
			expect(caseStart).toBeGreaterThan(-1);
			const caseEnd = js.indexOf("case '", caseStart + 1);
			const block = js.slice(caseStart, caseEnd);

			// All cached keys are dropped — refresh implies the user expects a
			// fresh read for any repo+branch they navigate to next, not just
			// the active one.
			expect(block).toMatch(
				/for\s*\(\s*const\s+\w+\s+in\s+branchMemoriesCache\s*\)\s*delete/,
			);
			expect(block).toMatch(
				/for\s*\(\s*const\s+\w+\s+in\s+branchMemoriesPending\s*\)\s*delete/,
			);

			// Same fallback expression as the selection:set trigger and the
			// response-match check — drift here means refresh sends a request
			// for one key while the render path reads from another.
			expect(block).toMatch(
				/state\.selectedRepoName\s*\|\|\s*state\.currentRepoName/,
			);
			expect(block).toMatch(
				/state\.selectedBranchName\s*\|\|\s*state\.branchName/,
			);
			expect(block).toMatch(
				/selection:requestBranchMemories[\s\S]*repoName:\s*repo[\s\S]*branchName:\s*branch/,
			);
		});
	});

	describe("breadcrumb dropdown filter + scrolling", () => {
		it("renders the menu body as a search header plus a scrollable list", () => {
			const js = buildSidebarScript();
			// The list container is what scrolls (overflow-y is on .dropdown-list,
			// not the outer .dropdown-menu) so the search header stays pinned.
			expect(js).toContain("className: 'dropdown-list'");
			expect(js).toContain("className: 'dropdown-search'");
		});

		it("only shows the filter input when the list is large enough to be worth searching", () => {
			const js = buildSidebarScript();
			// Threshold is encoded as a single constant so a future tweak only
			// touches one place; keep the assertion loose enough to survive a
			// rename but tight enough to catch a silent removal.
			expect(js).toMatch(/SEARCH_THRESHOLD\s*=\s*\d+/);
			expect(js).toContain("items.length >= SEARCH_THRESHOLD");
		});

		it("filters items by case-insensitive substring against the item label", () => {
			const js = buildSidebarScript();
			// Lowercase the query and the label, then check substring inclusion.
			// Matching the source verbatim is brittle, but these two anchors
			// together pin the algorithm down.
			expect(js).toMatch(/\.toLowerCase\(\)/);
			expect(js).toMatch(/rows\[i\]\.label\.indexOf\(q\)/);
		});

		it("toggles a 'No matches' message when the filter produces zero visible rows", () => {
			const js = buildSidebarScript();
			expect(js).toContain("'No matches'");
			expect(js).toContain(
				"emptyMsg.classList.toggle('hidden', visible !== 0)",
			);
		});

		it("clamps the menu height to the space below the anchor so the list scrolls in-bounds", () => {
			const js = buildSidebarScript();
			// CSS caps at 50vh; JS tightens to whatever space is left below the
			// anchor. Without this the dropdown overflows the viewport bottom
			// edge with no scrollbar (the bug being fixed here).
			expect(js).toContain("window.innerHeight - r.bottom");
			expect(js).toContain("breadcrumbMenu.style.maxHeight");
		});

		it("focuses the filter input on open so the user can type immediately", () => {
			const js = buildSidebarScript();
			expect(js).toContain("searchInput.focus()");
		});
	});

	describe("Entity row icon", () => {
		// Final shape after the multi-source refactor: the row uses the codicon
		// `issues` glyph for Linear / Jira / GitHub (provider-supplied
		// via iconKey on the SerializedTreeItem) and `file-text` for Notion.
		// No brand-specific colour class — the user explicitly rejected brand
		// tints to keep rows visually uniform.
		it("does not apply any brand-specific colour class on entity rows", () => {
			const js = buildSidebarScript();
			// Webview-side: no per-brand icon-color class is emitted, nor any
			// per-source ThemeColor mapping leaking into the JS.
			expect(js).not.toContain("icon-color-linear");
			expect(js).not.toContain("icon-color-jira");
			expect(js).not.toContain("icon-color-github");
			expect(js).not.toContain("icon-color-notion");
		});
	});

	describe("Entity hover card", () => {
		// The plain-text tooltip routed through textContent (the prior plan/note
		// fallback) showed markdown source verbatim for entity rows — backslash
		// escapes from escMd plus literal ** / $() markers. Entity rows now
		// drive the same .hover-card popover used by the Memories section so
		// they get the rich codicon layout (source badge, status circle,
		// priority flame, label tag, Open-in-<Source> link).
		it("declares renderReferenceHoverCard for the multi-source entity card body", () => {
			// The earlier per-kind show / schedule functions were collapsed
			// into a single scheduleShowBranchHoverCard once plans and notes
			// also went through the hover card — only the renderer is
			// kind-specific now. See the "Plan / Note / Entity hover card"
			// describe block for the unified-dispatch tests.
			const js = buildSidebarScript();
			expect(js).toContain("function renderReferenceHoverCard");
		});

		it("Open-in-<Source> hover-card link uses data-cmd + data-hash so the shared dispatch works", () => {
			const js = buildSidebarScript();
			// The hoverCardEl click handler routes [data-cmd][data-hash] →
			// vscode.postMessage({command, args:[hash]}). Reusing those attribute
			// names means we don't duplicate the dispatch code.
			expect(js).toContain("'data-cmd': 'jollimemory.openReferenceInBrowser'");
			expect(js).toMatch(/'data-hash':\s*mapKey/);
		});

		it("renders one generic codicon row per opaque field + Open-in-<Source> action", () => {
			// The renderer no longer hardcodes per-field codicons (status / priority
			// / labels). It iterates the opaque `fields` bag and reads each field's
			// adapter-chosen icon at runtime, falling back to `circle-small`. The
			// Open-in-<Source> action keeps its hardcoded link-external icon.
			const js = buildSidebarScript();
			expect(js).toContain("for (const f of (h.fields || []))");
			expect(js).toContain("'codicon codicon-' + (f.icon || 'circle-small')");
			expect(js).toContain("'hc-row'");
			expect(js).toContain("codicon-link-external");
		});

		it("renderPlanRow suppresses native title= on every row type (all three drive the hover card)", () => {
			const js = buildSidebarScript();
			const fnStart = js.indexOf("function renderPlanRow");
			const fnEnd = js.indexOf("function gitStatusToCodicon", fnStart);
			const body = js.slice(fnStart, fnEnd);
			// Plan / note / entity rows all route through the shared hover-card
			// mouseover handler now, so the native title attribute is
			// universally nulled — keeping it would surface a duplicate
			// tooltip on an independent timer.
			expect(body).toContain("title: null");
			expect(body).not.toContain("title: item.tooltip");
		});

		it("includes a per-source badge in the title row so users can disambiguate Linear / Jira / GitHub / Notion at a glance", () => {
			// The badge is the minimum-viable source-surfacing — single
			// letter (L / J / GH / N) rather than a full brand icon. Source
			// label lookup is a literal object so a regression that drops
			// a source key would also trip this test.
			const js = buildSidebarScript();
			expect(js).toContain("hc-source-badge");
			expect(js).toContain("linear: 'L'");
			expect(js).toContain("jira: 'J'");
			expect(js).toContain("github: 'GH'");
			expect(js).toContain("notion: 'N'");
		});
	});

	describe("Plan / Note / Entity hover card", () => {
		// The three Plans & Notes section row types share one popover element
		// (#memory-hover) and one set of show / hide timers — only the content
		// renderer differs. mouseover dispatches on data-context to pick the
		// right renderPlan/Note/EntityHoverCard.
		it("declares renderPlanHoverCard + renderNoteHoverCard alongside Entity's", () => {
			const js = buildSidebarScript();
			expect(js).toContain("function renderPlanHoverCard");
			expect(js).toContain("function renderNoteHoverCard");
			expect(js).toContain("function renderReferenceHoverCard");
		});

		it("plan hover card includes clock + filename rows + Open-Plan action (no edit-count row)", () => {
			const js = buildSidebarScript();
			const fnStart = js.indexOf("function renderPlanHoverCard");
			const fnEnd = js.indexOf("function renderNoteHoverCard", fnStart);
			const body = js.slice(fnStart, fnEnd);
			expect(body).toContain("codicon-clock");
			expect(body).toContain("codicon-markdown");
			// "edited N times" was removed — the count is populated by
			// transcript scanning and misses non-Claude plan touches, so
			// it routinely showed "0 times" for actively-edited plans.
			expect(body).not.toContain("h.editInfo");
			expect(body).not.toContain("codicon-edit");
			expect(body).toContain("'jollimemory.openPlanForPreview'");
			// Committed plans get the copy-hash link in addition to Open Plan.
			expect(body).toContain("'jollimemory.copyCommitHash'");
		});

		it("note hover card swaps file icon by format and exposes Open-Note action", () => {
			const js = buildSidebarScript();
			const fnStart = js.indexOf("function renderNoteHoverCard");
			const fnEnd = js.indexOf("function renderReferenceHoverCard", fnStart);
			const body = js.slice(fnStart, fnEnd);
			expect(body).toContain("'codicon-comment'");
			expect(body).toContain("'codicon-note'");
			expect(body).toContain("'jollimemory.openNoteForPreview'");
		});

		it("mouseover dispatches by data-context to plan / note / entity renderers", () => {
			const js = buildSidebarScript();
			// Single selector + branch on ctx — three separate listeners would
			// invite race conditions on the show / hide timers.
			expect(js).toContain("'.tree-node[data-id]'");
			expect(js).toMatch(
				/ctx\s*!==\s*'plan'\s*&&\s*ctx\s*!==\s*'note'\s*&&\s*ctx\s*!==\s*'reference'/,
			);
			expect(js).toContain("renderPlanHoverCard(rowId");
			expect(js).toContain("renderNoteHoverCard(rowId");
			expect(js).toContain("renderReferenceHoverCard(rowId");
		});

		it("unified lookup reads planHover / noteHover / referenceHover off the matching serialized item", () => {
			const js = buildSidebarScript();
			expect(js).toContain("function lookupBranchHoverById");
			expect(js).toContain("items[i].planHover");
			expect(js).toContain("items[i].noteHover");
			expect(js).toContain("items[i].referenceHover");
		});

		it("trash button (data-inline='remove') routes by row contextValue to the right command", () => {
			// Regression: renderPlanRow shared one inline-actions block across
			// plan / note / entity rows (all hardcoded data-inline="remove").
			// The click delegation initially branched only plan-vs-note, so
			// entity rows fell into the else and dispatched jollimemory.removePlan
			// with an entity mapKey — which removePlan doesn't recognize, so the
			// trash button silently no-op'd on entity rows while working on
			// plan/note rows. The three-way ternary in the dispatch ensures
			// each row type's trash routes to its own host-side handler.
			const js = buildSidebarScript();
			expect(js).toContain("'jollimemory.removeNote'");
			expect(js).toContain("'jollimemory.removePlan'");
			expect(js).toContain("'jollimemory.ignoreReference'");
			// The three branches must coexist in the same dispatch — a future
			// regression that dropped any of them would re-introduce the
			// silent-no-op symptom on the corresponding row type.
			expect(js).toMatch(
				/ctx\s*===\s*'note'[\s\S]{0,150}ctx\s*===\s*'reference'/,
			);
		});
	});

	// ── Active Conversations partial-data hint ────────────────────────────
	// `branch:conversationsData` now carries a `failedSources` array. When
	// non-empty, the Branch tab's Active Conversations section must render
	// a small banner above the rows so the user understands the list is
	// incomplete rather than truly empty.
	//
	// NOTE: this whole file uses string assertions on the generated script
	// rather than executing it in a DOM (jsdom). The checks below probe
	// specific control-flow tokens (the `.length` guard, the className,
	// and the message-handler field assignment) so that a regression that
	// drops the guard or the banner element will trip these tests, not
	// just a regression that renames the variable. Promoting this file to
	// jsdom-backed behavior testing is a separate follow-up.
	describe("failedSources partial-data warning", () => {
		it("stores failedSources from the incoming message onto branchData so the renderer can read it", () => {
			const js = buildSidebarScript();
			// The branch:conversationsData handler must assign the array
			// from the message — assignment shape, not just word presence.
			expect(js).toMatch(
				/conversationsFailedSources\s*=\s*[^;]*msg\.failedSources/,
			);
		});

		it("renders the warning element only when failedSources is non-empty", () => {
			const js = buildSidebarScript();
			// The renderer must (a) read the array from branchData, (b)
			// guard on length > 0 before producing the warning string, and
			// (c) emit the className the CSS layer styles. All three
			// together prove the banner is conditional, not always-rendered.
			expect(js).toContain("branchData.conversationsFailedSources");
			expect(js).toMatch(/\.length\s*>\s*0/);
			expect(js).toContain("'conversations-warning'");
		});
	});

	// ── Per-row selection checkboxes (conversations, plans, notes) ────────────
	// Task 8: each conversation row, plan row, and note row renders a leading
	// checkbox that posts a toggle message when changed. Tests assert on the
	// generated JS/HTML strings because the wider test suite uses string-based
	// assertions throughout (no jsdom execution).
	describe("per-row selection checkboxes", () => {
		it("renderConversationRow emits a jm-conv-check checkbox with data-source and data-session", () => {
			const js = buildSidebarScript();
			// The 'jm-conv-check' class must appear in the renderConversationRow
			// function body.
			const fnStart = js.indexOf("function renderConversationRow");
			const fnEnd = js.indexOf("\n  function ", fnStart + 1);
			const fn =
				fnEnd > fnStart
					? js.slice(fnStart, fnEnd)
					: js.slice(fnStart, fnStart + 3000);
			expect(fn).toContain("'jm-conv-check'");
			expect(fn).toContain("'data-source'");
			expect(fn).toContain("'data-session'");
			// The '.checked' assignment that drives the isSelected state.
			expect(fn).toMatch(/\.checked\s*=\s*!!item\.isSelected/);
		});

		it("renderConversationRow guards the click listener against checkbox clicks", () => {
			const js = buildSidebarScript();
			const fnStart = js.indexOf("function renderConversationRow");
			const fnEnd = js.indexOf("\n  function ", fnStart + 1);
			const fn =
				fnEnd > fnStart
					? js.slice(fnStart, fnEnd)
					: js.slice(fnStart, fnStart + 3000);
			// The direct click listener must bail out when the click target
			// is a checkbox, so clicking 'jm-conv-check' does not also open
			// the conversation panel.
			expect(fn).toMatch(/\[data-checkbox="1"\]/);
		});

		it("renderConversationRow emits a codicon-edit marker when item.isEdited is true", () => {
			const js = buildSidebarScript();
			const fnStart = js.indexOf("function renderConversationRow");
			const fnEnd = js.indexOf("\n  function ", fnStart + 1);
			const fn =
				fnEnd > fnStart
					? js.slice(fnStart, fnEnd)
					: js.slice(fnStart, fnStart + 3000);
			expect(fn).toContain("if (item.isEdited)");
			// The marker is a codicon glyph (not a pill) so it reads as a status
			// modifier on the title rather than a second badge competing with the
			// AI agent badge for visual weight.
			expect(fn).toContain("'codicon codicon-edit edited-icon'");
			expect(fn).toContain("'aria-label': 'Edited'");
			// Tooltip is driven by attachTextTip (custom popover) instead of
			// native title= — the title attribute is unreliable across webview
			// focus transitions, see the attachTextTip helper docstring.
			expect(fn).toContain("'Conversation content has been modified'");
			expect(fn).toMatch(/attachTextTip\(\s*el\('i',/);
		});

		it("renderFolderChildren emits a codicon-edit marker on file rows when child.isDiverged is true", () => {
			// Mirrors the conversation-row edit indicator (above): same glyph,
			// same .edited-icon class, same color token via SidebarCssBuilder,
			// so a user familiar with the conversations 'edited' affordance
			// reads the KB tree's on-disk-divergence marker the same way.
			// Tooltip phrasing matches MemoryFileDecorationProvider so the
			// webview tree and the explorer badge speak with one voice.
			const js = buildSidebarScript();
			const fnStart = js.indexOf("function renderFolderChildren");
			const fnEnd = js.indexOf("\n  function ", fnStart + 1);
			const fn =
				fnEnd > fnStart
					? js.slice(fnStart, fnEnd)
					: js.slice(fnStart, fnStart + 3000);
			// Guard is on the file row only (directories cannot diverge);
			// the !isDir prefix gates the push.
			expect(fn).toContain("if (!isDir && child.isDiverged)");
			expect(fn).toContain("'codicon codicon-edit edited-icon'");
			expect(fn).toContain("'aria-label': 'Edited'");
			expect(fn).toContain("'Edited on disk — system view unavailable'");
			expect(fn).toMatch(/attachTextTip\(\s*el\('i',/);
		});

		it("renderPlanRow emits a jm-plan-check checkbox with data-plan-id for plan rows", () => {
			const js = buildSidebarScript();
			const fnStart = js.indexOf("function renderPlanRow");
			const fnEnd = js.indexOf("\n  function ", fnStart + 1);
			const fn =
				fnEnd > fnStart
					? js.slice(fnStart, fnEnd)
					: js.slice(fnStart, fnStart + 3000);
			expect(fn).toContain("'jm-plan-check'");
			expect(fn).toContain("'data-plan-id'");
			// The plan slug is stored in item.id and carried into 'data-plan-id'.
			expect(fn).toMatch(/data-plan-id.*item\.id/);
		});

		it("renderPlanRow emits a jm-note-check checkbox with data-note-id for note rows", () => {
			const js = buildSidebarScript();
			const fnStart = js.indexOf("function renderPlanRow");
			const fnEnd = js.indexOf("\n  function ", fnStart + 1);
			const fn =
				fnEnd > fnStart
					? js.slice(fnStart, fnEnd)
					: js.slice(fnStart, fnStart + 3000);
			expect(fn).toContain("'jm-note-check'");
			expect(fn).toContain("'data-note-id'");
			// The note id is stored in item.id and carried into 'data-note-id'.
			expect(fn).toMatch(/data-note-id.*item\.id/);
		});

		it("renderPlanRow emits a jm-reference-check checkbox with data-reference-key for entity rows", () => {
			const js = buildSidebarScript();
			const fnStart = js.indexOf("function renderPlanRow");
			const fnEnd = js.indexOf("\n  function ", fnStart + 1);
			const fn =
				fnEnd > fnStart
					? js.slice(fnStart, fnEnd)
					: js.slice(fnStart, fnStart + 3000);
			expect(fn).toContain("'jm-reference-check'");
			expect(fn).toContain("'data-reference-key'");
			// The mapKey is stored in item.id (entity.mapKey from PlansTreeProvider.serialize)
			// and carried into 'data-reference-key'.
			expect(fn).toMatch(/data-reference-key.*item\.id/);
			// The isReference branch still discriminates which checkbox class is emitted.
			expect(fn).toMatch(/isReference/);
		});

		it("change listener posts branch:toggleConversationSelection for jm-conv-check", () => {
			const js = buildSidebarScript();
			expect(js).toContain("type: 'branch:toggleConversationSelection'");
			expect(js).toContain("'jm-conv-check'");
		});

		it("change listener posts branch:togglePlanSelection for jm-plan-check", () => {
			const js = buildSidebarScript();
			expect(js).toContain("type: 'branch:togglePlanSelection'");
			expect(js).toContain("'jm-plan-check'");
		});

		it("change listener posts branch:toggleNoteSelection for jm-note-check", () => {
			const js = buildSidebarScript();
			expect(js).toContain("type: 'branch:toggleNoteSelection'");
			expect(js).toContain("'jm-note-check'");
		});

		it("change listener posts branch:toggleReferenceSelection for jm-reference-check with mapKey from data-reference-key", () => {
			const js = buildSidebarScript();
			expect(js).toContain("type: 'branch:toggleReferenceSelection'");
			expect(js).toContain("'jm-reference-check'");
			// Confirm the mapKey is read from data-reference-key rather than
			// being conflated with data-plan-id / data-note-id.
			expect(js).toMatch(/mapKey:\s*cb\.getAttribute\(['"]data-reference-key['"]\)/);
		});

		it("change listener sends planId from data-plan-id and noteId from data-note-id", () => {
			const js = buildSidebarScript();
			expect(js).toContain("getAttribute('data-plan-id')");
			expect(js).toContain("getAttribute('data-note-id')");
		});

		it("change listener sends source and sessionId from data-source and data-session", () => {
			const js = buildSidebarScript();
			// Conversation toggle reads data-source and data-session off the checkbox.
			expect(js).toContain("getAttribute('data-source')");
			expect(js).toContain("getAttribute('data-session')");
		});
	});

	it("selects the Updating Memory Bank label for the ingest phase", () => {
		const js = buildSidebarScript();
		expect(js).toContain("Updating Memory Bank…");
		expect(js).toContain("state.workerPhase === 'ingest'");
	});

	it("keeps the default AI summary label for non-ingest busy state", () => {
		const js = buildSidebarScript();
		expect(js).toContain("AI summary in progress…");
	});

	it("handles the worker:phase message channel", () => {
		const js = buildSidebarScript();
		expect(js).toContain("case 'worker:phase'");
	});
});

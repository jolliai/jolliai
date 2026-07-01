import { describe, expect, it } from "vitest";
import { buildSidebarScript } from "./SidebarScriptBuilder";

describe("SidebarScriptBuilder", () => {
	it("returns a JS string", () => {
		const js = buildSidebarScript();
		expect(typeof js).toBe("string");
		expect(js.length).toBeGreaterThan(0);
	});

	it("emits the per-repo knowledge-graph button and its click dispatch", () => {
		const js = buildSidebarScript();
		// The repo row renders a trailing view-graph button...
		expect(js).toContain("'data-action': 'view-graph'");
		expect(js).toContain("'data-repo': child.relPath");
		// ...and the kb click delegation dispatches the command with the repo arg.
		expect(js).toContain("jollimemory.viewKnowledgeGraph");
		expect(js).toContain('[data-action="view-graph"]');
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

	it("renders the knowledge stub on init when it is the restored active tab", () => {
		// Regression: switchTab() early-returns when getState() already restored
		// activeTab, so the init handler must paint knowledge explicitly or the
		// recreated webview stays stuck on the "Loading..." HTML placeholder.
		const js = buildSidebarScript();
		expect(js).toContain("state.activeTab === 'knowledge'");
		expect(js).toContain("renderKnowledge()");
	});

	it("posts a refresh scope message on toolbar Refresh (knowledge tab gets host data)", () => {
		// The knowledge view now has host-driven data (kb:knowledgeData) so toolbar
		// Refresh posts a 'refresh' scope message rather than re-rendering locally.
		const js = buildSidebarScript();
		expect(js).toContain("vscode.postMessage({ type: 'refresh', scope: state.activeTab });");
	});

	it("renders the Knowledge view: Overview + graph entry + repo/category/topic tree", () => {
		const js = buildSidebarScript();
		expect(js).toContain("'kb:knowledgeData'");
		expect(js).toContain("function renderKnowledge");
		expect(js).toContain("Overview");
		// single graph entry reuses the existing command (not a graph-list mode)
		expect(js).toContain("jollimemory.viewKnowledgeGraph");
		// no leftover stub
		expect(js).not.toContain("Knowledge wiki — coming soon.");
	});

	it("shows a Build CTA when a repo has no compiled wiki, and Rebuild reuses compileNow", () => {
		const js = buildSidebarScript();
		expect(js).toContain("jollimemory.compileNow");
		expect(js).toContain("Build Knowledge Wiki");
	});

	it("filters the Knowledge tree by a search query", () => {
		const js = buildSidebarScript();
		expect(js).toContain("knowledgeQuery");
		expect(js).toContain("Search topics");
	});

	// Regression guards for the Current Branch / Knowledge review findings.
	// These are substring assertions; the `new Function(...)` parse smoke test
	// above is what guarantees the surrounding edits stay syntactically valid.
	describe("review fixes (Bug 1-6)", () => {
		it("Bug 1: conversation rows carry data-context so the native menu stays suppressed", () => {
			const js = buildSidebarScript();
			// The contextmenu listener filters via closest('.tree-node[data-context]');
			// an absent attribute is not matched by the presence selector, so the
			// native menu would leak. Pin itself moved to a hover-revealed inline
			// button (canPinConv gate), so there is no custom conversation menu.
			expect(js).toContain("'data-context': 'conversation'");
			expect(js).toContain("const canPinConv");
		});

		it("Bug 3: foreign-memory conversation evidence rows are static (no open dispatch)", () => {
			const js = buildSidebarScript();
			// Mirrors the Files group's isForeignMemory guard: static class + tip,
			// no click wiring to branch:openConversation against a non-local path.
			expect(js).toContain(
				"'memory-evidence-row' + (isForeignMemory ? ' memory-evidence-row--static' : '')",
			);
			expect(js).toContain(
				"Conversations are only available for memories in the current workspace",
			);
		});

		it("Bug 4: a pin re-appearing expands the Pinned section instead of leaving it collapsed-empty", () => {
			const js = buildSidebarScript();
			expect(js).toContain("pinsHydrated");
			expect(js).toContain("state.sectionsCollapsed['pinned'] = false");
		});

		it("Bug 5: kb:expandMemory is de-duplicated by an in-flight pending guard", () => {
			const js = buildSidebarScript();
			expect(js).toContain("evidencePending");
			expect(js).toContain("if (!evidencePending[hash])");
			expect(js).toContain("delete evidencePending[msg.commitHash]");
		});

		it("Bug 6: Overview/Graph are single at top only for one repo, else nested per repo", () => {
			const js = buildSidebarScript();
			expect(js).toContain("function knRepoEntries(repo)");
			expect(js).toContain("visibleRepos.length === 1");
			expect(js).toContain("visibleRepos.length > 1");
		});

		it("foreign-readonly hides the body Commit|Review bar, footer, and token bar", () => {
			const js = buildSidebarScript();
			// renderCommitReviewBar + footer are only mounted in the non-foreign branch
			expect(js).toContain("if (!foreign) {");
			// token bar is gated on !foreign
			expect(js).toContain("if (!foreign && state.tokenStats)");
		});
	});

	it("conversation row leads with a per-source brand icon and 'N msgs' (no static usage placeholder)", () => {
		const js = buildSidebarScript();
		// Leading glyph is now the source-typed brand icon (replaces the old
		// generic comment glyph + trailing colored source-dot), with a hover tip.
		expect(js).toContain("convSourceIcon(item.source)");
		expect(js).toContain("'icon conv-source-icon'");
		expect(js).toContain("providerLabel(item.source)");
		// The trailing source-dot is gone.
		expect(js).not.toContain("'source-dot source-dot-' + item.source");
		// message count rendered as "N msgs"
		expect(js).toContain("item.messageCount) + ' msgs'");
		// The old "usage not reported" placeholder is gone — no token data exists,
		// so stamping it on every row was noise (and wrong for sources that report).
		expect(js).not.toContain("usage not reported");
	});

	it("defines a per-source brand-icon map covering every provider", () => {
		const js = buildSidebarScript();
		expect(js).toContain("var SOURCE_ICON_SVG = {");
		for (const src of ["claude", "codex", "gemini", "cursor", "copilot", "opencode"]) {
			expect(js).toContain(`${src}:`);
		}
		// copilot-chat reuses the Copilot mark.
		expect(js).toContain("SOURCE_ICON_SVG['copilot-chat'] = SOURCE_ICON_SVG.copilot");
		// Parsed as a trusted constant via DOMParser, not innerHTML.
		expect(js).toContain("new DOMParser().parseFromString(markup, 'image/svg+xml')");
		expect(js).not.toContain(".innerHTML = markup");
	});

	describe("Working Memory strikethrough-exclude", () => {
		it("declares a shared excludeToggle helper that renders a ✕/+ row-excl button", () => {
			const js = buildSidebarScript();
			expect(js).toContain("function excludeToggle(");
			expect(js).toContain("row-excl");
			expect(js).toContain("'data-exclude-toggle'");
			// '+' (add back) vs close (leave out) codicons, flipped by selection.
			expect(js).toContain("codicon-add");
			expect(js).toContain("codicon-close");
		});

		it("conversation row reflects exclusion via an .excluded class instead of an unchecked visible box", () => {
			const js = buildSidebarScript();
			const renderConversationRow = js.slice(
				js.indexOf("function renderConversationRow"),
				js.indexOf("function providerLabel"),
			);
			// included-by-default: the row carries 'excluded' only when !isSelected.
			expect(renderConversationRow).toContain("excluded");
			expect(renderConversationRow).toContain("excludeToggle(");
		});

		it("wires a delegated click handler that flips the hidden checkbox and redispatches change", () => {
			const js = buildSidebarScript();
			expect(js).toContain("[data-exclude-toggle]");
			// reuses the existing per-kind change roundtrip rather than a new message
			expect(js).toContain("new Event('change'");
		});

		it("context rows (plan/note/reference) also carry the exclude toggle", () => {
			const js = buildSidebarScript();
			const renderPlanRow = js.slice(
				js.indexOf("function renderPlanRow"),
				js.indexOf("function renderConversationRow"),
			);
			expect(renderPlanRow).toContain("excludeToggle(");
			expect(renderPlanRow).toContain(" excluded");
		});

		it("file change rows also carry the exclude toggle (Discard stays distinct)", () => {
			const js = buildSidebarScript();
			const renderChangeRow = js.slice(
				js.indexOf("function renderChangeRow"),
				js.indexOf("function renderCommitRow"),
			);
			expect(renderChangeRow).toContain("excludeToggle(");
			expect(renderChangeRow).toContain(" excluded");
			// the destructive discard affordance is untouched
			expect(renderChangeRow).toContain("'discard'");
		});
	});

	it("always renders the Pinned section with an empty-state when nothing is pinned", () => {
		const js = buildSidebarScript();
		// The empty-state copy (mockup) is present...
		expect(js).toContain("Nothing pinned.");
		// ...and the section is no longer gated behind a non-empty pins check.
		const branch = js.slice(
			js.indexOf("function renderBranch"),
			js.indexOf("function renderShowMoreRow"),
		);
		expect(branch).not.toContain("if (pinsData.length > 0)");
		expect(branch).toContain("'data-section': 'pinned'");
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

	it("renders toolbar indicator chrome (sync-phase) plus the post-commit worker label", () => {
		const js = buildSidebarScript();
		// toolbar-worker-status is the Memory Bank tab's sync-phase chrome
		// (spinner for info, error icon for sticky sync failures). The
		// post-commit "AI summary in progress…" label is still emitted, now by
		// the Committed Memories header indicator (renderWorkerSignal)
		// rather than the removed Branch toolbar.
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
		// Idempotent: skip re-render when neither the flag nor the attached
		// summarizing hash changed.
		expect(js).toContain(
			"if (state.workerBusy === next && state.summarizingHash === nextHash) break;",
		);
		// The host attaches the HEAD short hash while busy; the handler stores it
		// for the "Summarizing <hash>…" Working Memory row.
		expect(js).toContain("const nextHash = next ? (msg.commit || null) : null;");
		expect(js).toContain("state.summarizingHash = nextHash;");
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

	it("drops the in-webview Status indicator tooltip wiring (moved to native title bar)", () => {
		const js = buildSidebarScript();
		// The header-bar Status icon + its OK/Warning/Error dot tooltip are gone;
		// Status is now a native view/title icon.
		expect(js).not.toContain("statusIconBtn");
		expect(js).not.toContain("'Jolli Memory: All good'");
		expect(js).not.toContain("tip = 'Jolli Memory: Errors'");
		// attachTextTip's dataset.tip-on-show mechanism stays — it still drives
		// the tooltips on status entry rows and toolbar buttons.
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
		// depth 0 (repoChildren is root.children optionally scoped to a single
		// repo by the 'Showing' filter). The banner row would have re-emitted
		// data-kind="repo-root"; removing that surface is the observable contract.
		expect(js).not.toContain("'data-kind': 'repo-root'");
		expect(js).toContain("renderFolderChildren(repoChildren, 0)");
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

	it("renders the Current Memory group and Committed Memories sections", () => {
		const js = buildSidebarScript();
		// Working Memory groups Conversations / Context / Files under one header.
		expect(js).toContain("Working Memory");
		expect(js).toContain("Committed Memories");
		// The internal section ids are unchanged (selection + collapse keys).
		expect(js).toContain("id: 'conversations'");
		expect(js).toContain("id: 'changes'");
		expect(js).toContain("id: 'commits'");
	});

	it("labels the Current Memory sub-sections Conversations / Context / Files", () => {
		const js = buildSidebarScript();
		expect(js).toContain("Conversations");
		expect(js).toContain("Context");
		expect(js).toContain("Files");
	});

	it("renders Working Memory as a collapsible header with a refresh action (select-all removed)", () => {
		const js = buildSidebarScript();
		// Header is clickable to fold the whole group (data-cm-header marker).
		expect(js).toContain("'data-cm-header': '1'");
		// Select-All is no longer rendered as a header icon (mockup: per-row ✕/+
		// exclude under the included-by-default model). Refresh stays, always-on.
		expect(js).not.toMatch(/iconButton\('current-memory-select-all',/);
		expect(js).toMatch(/iconButton\('current-memory-refresh',/);
	});

	it("scopes the two header refresh buttons to branch-current / branch-commits", () => {
		const js = buildSidebarScript();
		expect(js).toContain("scope: 'branch-current'");
		expect(js).toContain("scope: 'branch-commits'");
	});

	it("uses the unified codicon chevron (not the legacy text twirl) for collapse affordances", () => {
		const js = buildSidebarScript();
		expect(js).toContain("function chevron(");
		expect(js).toContain("codicon-chevron-right");
		// The old text-arrow twirls are gone from the section/group headers.
		expect(js).not.toContain("text: '▾'");
		expect(js).not.toContain("isCollapsed('pinned') ? '▸' : '▾'");
	});

	it("renders a per-sub-section item count and a Show-more preview cap", () => {
		const js = buildSidebarScript();
		expect(js).toContain("section-count");
		expect(js).toContain("SUBSECTION_PREVIEW");
		expect(js).toContain("'data-show-more'");
		expect(js).toContain("Show less");
		expect(js).toContain("function renderShowMoreRow(");
	});

	it("drops the Branch toolbar entirely (refresh + AI-summary signal relocated)", () => {
		const js = buildSidebarScript();
		// renderToolbar early-returns for the Branch tab, clearing + hiding the
		// bar so no empty strip shows above the tree.
		expect(js).toContain("clear(tabToolbar);");
		expect(js).toContain("tabToolbar.classList.add('hidden');");
		// applyEnabled also hides the bar on the Branch tab (covers boot-on-Branch
		// where switchTab early-returns and renderToolbar never runs).
		expect(js).toContain("!enabled || state.activeTab === 'branch'");
	});

	it("shows the AI-summary worker signal in the Committed Memories header", () => {
		const js = buildSidebarScript();
		expect(js).toContain("function renderWorkerSignal(");
		// Only the commits section header mounts the indicator.
		expect(js).toContain("if (s.id === 'commits') {");
		expect(js).toContain("renderWorkerSignal()");
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

	it("toggles the Status overlay via the status:toggle message (native title-bar icon)", () => {
		const js = buildSidebarScript();
		// Status moved to the native "JOLLI MEMORY" title bar; the click arrives
		// as the 'status:toggle' inbound message and drives toggleStatusOverlay.
		expect(js).toContain("case 'status:toggle':");
		expect(js).toContain("toggleStatusOverlay");
		expect(js).toMatch(/function toggleStatusOverlay\(\)/);
		// The old in-webview health dot (and its color classes) is gone.
		expect(js).not.toContain("status-icon-btn");
		expect(js).not.toContain("status-icon-ok");
		expect(js).not.toContain("codicon-circle-filled");
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

		it("renders no leading file-type icon (filename tint + status letter carry git state)", () => {
			const js = buildSidebarScript();
			const renderChangeRow = js.slice(
				js.indexOf("function renderChangeRow"),
				js.indexOf("function renderCommitRow"),
			);
			// Parity with the committed-memory evidence "Files" rows: no leading
			// codicon at all. The git state reads from the .gs-{code} filename
			// tint and the trailing gs-letter, so neither the file-type icon
			// (pathToFileCodicon) nor the legacy status glyph (gitStatusToCodicon)
			// is rendered on the row.
			expect(renderChangeRow).not.toContain("pathToFileCodicon(");
			expect(renderChangeRow).not.toContain("gitStatusToCodicon(");
			expect(renderChangeRow).not.toContain("className: 'icon'");
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

		it("committed-memory inline-actions are Pin + Copy Recall + Share (no viewSummary)", () => {
			const js = buildSidebarScript();
			// Scope to renderCommitRow body only.
			const fnIdx = js.indexOf("function renderCommitRow(");
			expect(fnIdx).toBeGreaterThan(-1);
			const fnEnd = js.indexOf("function ", fnIdx + 1);
			const body = js.slice(fnIdx, fnEnd > 0 ? fnEnd : fnIdx + 6000);
			// Workspace rows: Pin, Copy Recall, Share all present.
			expect(body).toMatch(/'data-inline':\s*'pin'/);
			expect(body).toMatch(/'data-inline':\s*'copy-recall'/);
			expect(body).toMatch(/'data-inline':\s*'share'/);
			// View Memory (eye) must be gone from the inline-actions block.
			expect(body).not.toMatch(/'data-inline':\s*'viewSummary'/);
		});

		it("omits the inline short-date (.desc) on committed-memory rows; keeps it for plain commits", () => {
			const js = buildSidebarScript();
			const fnIdx = js.indexOf("function renderCommitRow(");
			const fnEnd = js.indexOf("function ", fnIdx + 1);
			const body = js.slice(fnIdx, fnEnd > 0 ? fnEnd : fnIdx + 6000);
			// The short-date span is gated on !hasMem — memory rows carry the
			// relative date in .mem-subline instead, so the MM-DD desc is dropped.
			expect(body).toContain("item.description && !hasMem");
		});

		it("renderSection routes to per-section row renderer based on section id", () => {
			const js = buildSidebarScript();
			// Confirm renderSection picks renderPlanRow / renderChangeRow / renderCommitRow.
			expect(js).toMatch(/renderPlanRow/);
			expect(js).toMatch(/renderChangeRow/);
			expect(js).toMatch(/renderCommitRow/);
		});

		it("drops the leading git-commit dot for every commit row; only squash mode fills the slot (checkbox)", () => {
			const js = buildSidebarScript();
			// The leading git-commit dot was removed for ALL rows — memory rows (M
			// glyph) and code-only / mid-summary commits (</> glyph) alike. The
			// glyph already conveys type, and a code commit mid-AI-summary read as a
			// memory row that confusingly still showed the dot. Slot defaults to
			// null; only squash-selection mode puts a checkbox in it.
			const renderCommitRow = js.slice(
				js.indexOf("function renderCommitRow"),
				js.indexOf("function renderCommitFileRow"),
			);
			// No git-commit codicon anywhere in the row builder.
			expect(renderCommitRow).not.toContain("codicon-git-commit");
			// Slot defaults to null; the checkbox path is the only one that fills it.
			expect(renderCommitRow).toContain("let leading = null;");
			expect(renderCommitRow).toContain("'data-checkbox-kind': 'commit'");
		});

		it("committed memory row expands to inline evidence groups + a memory-details toggle", () => {
			const js = buildSidebarScript();
			// Scope assertions to renderCommitRow body only (not the whole output)
			// so a match inside renderMemoryEvidence or another renderer doesn't
			// let a missing renderCommitRow call pass silently.
			const renderCommitRow = js.slice(
				js.indexOf("function renderCommitRow"),
				js.indexOf("function renderCommitFileRow"),
			);
			// expanded committed row with a memory reuses renderMemoryEvidence (not just file children)
			expect(renderCommitRow).toContain("renderMemoryEvidence(");
			// a labeled show/hide affordance for the memory detail
			expect(renderCommitRow).toContain("memory details");
			// the existing lazy channel drives it
			expect(renderCommitRow).toContain("'kb:expandMemory'");
		});

		it("expanded memory row renders a SHIPPED group: Create PR action + Push/Synced status", () => {
			const js = buildSidebarScript();
			const renderCommitRow = js.slice(
				js.indexOf("function renderCommitRow"),
				js.indexOf("function renderCommitFileRow"),
			);
			// The SHIPPED rows themselves moved to buildShippedGroup (so the in-place
			// PR updater can rebuild a single group); renderCommitRow now just calls
			// it, forwarding the synced-state field.
			expect(renderCommitRow).toContain("buildShippedGroup(hash, memBranch, item.e2eCount, item.jolliDocUrl)");
			const shipped = js.slice(
				js.indexOf("function buildShippedGroup"),
				js.indexOf("function updatePrStatusInPlace"),
			);
			expect(shipped).toContain("'data-action': 'ship-create-pr'");
			expect(shipped).toContain("'data-action': 'ship-push-jolli'");
			expect(shipped).toContain("Push to Jolli");
			expect(shipped).toContain("create PR");
			// synced state keys off the jolliDocUrl param.
			expect(shipped).toContain("if (jolliDocUrl)");
		});

		it("committed memory row has no inline LOCAL/SYNCED cloud chip (sync state lives in the expanded SHIPPED group)", () => {
			const js = buildSidebarScript();
			const renderCommitRow = js.slice(
				js.indexOf("function renderCommitRow"),
				js.indexOf("function renderCommitFileRow"),
			);
			// The always-visible inline cloud chip was removed to de-clutter the
			// collapsed row. Its strip + class vocabulary must be gone…
			expect(renderCommitRow).not.toContain("'mem-chips'");
			expect(renderCommitRow).not.toContain("cloud-chip");
			expect(renderCommitRow).not.toContain("LOCAL");
			// …but sync state is still surfaced: renderCommitRow forwards
			// item.jolliDocUrl to buildShippedGroup, which renders the SYNCED row.
			expect(renderCommitRow).toContain("item.jolliDocUrl");
			const shipped = js.slice(
				js.indexOf("function buildShippedGroup"),
				js.indexOf("function updatePrStatusInPlace"),
			);
			expect(shipped).toContain("SYNCED");
		});

		it("the show-details toggle carries a chevron glyph (mockup .mem-evd look)", () => {
			const js = buildSidebarScript();
			const renderCommitRow = js.slice(
				js.indexOf("function renderCommitRow"),
				js.indexOf("function renderCommitFileRow"),
			);
			// The "Show memory details" affordance gains a disclosure chevron so it
			// reads as an expander, not body text.
			expect(renderCommitRow).toContain("memory-details-chevron");
		});

		it("expanded evidence ends with a right-aligned 'Hide memory details' collapse control", () => {
			const js = buildSidebarScript();
			const renderMemoryEvidence = js.slice(
				js.indexOf("function renderMemoryEvidence"),
				js.indexOf("function renderHoverCard"),
			);
			// A bottom collapse button mirrors the mockup's .mem-collapse; it reuses
			// the same data-commit-toggle channel as the chevron so one click path
			// drives expand + collapse.
			expect(renderMemoryEvidence).toContain("memory-evidence-collapse");
			expect(renderMemoryEvidence).toContain("Hide memory details");
			expect(renderMemoryEvidence).toContain("'data-commit-toggle'");
		});

		it("evidence group labels drop the leading codicon (mockup label typography)", () => {
			const js = buildSidebarScript();
			const renderMemoryEvidence = js.slice(
				js.indexOf("function renderMemoryEvidence"),
				js.indexOf("function renderHoverCard"),
			);
			// makeGroup no longer injects an icon into the group label — the label
			// is plain uppercase text separated by whitespace (no divider) in CSS.
			expect(renderMemoryEvidence).not.toContain("'codicon ' + iconClass");
		});

		it("delegated click handler wires ship-push-jolli and ship-create-pr to viewSummary", () => {
			const js = buildSidebarScript();
			expect(js).toContain("'ship-push-jolli'");
			expect(js).toContain("'ship-create-pr'");
			// Both dispatch viewSummary (or viewMemorySummary in foreign mode) with the hash
			expect(js).toContain("'jollimemory.viewSummary'");
		});

		it("delegated click handler intercepts .shipped-link[href] and dispatches vscode.open", () => {
			const js = buildSidebarScript();
			// Guard that catches anchor clicks before the generic fallthrough
			expect(js).toContain(".shipped-link[href]");
			// Dispatches the built-in vscode.open command via the command channel
			expect(js).toContain("'vscode.open'");
		});

		describe("Task A5: SHIPPED group — PR / E2E / Synced rows", () => {
			function getShippedGroupScope(js: string): string {
				// The SHIPPED group (PR / E2E / Synced rows) was extracted into
				// buildShippedGroup so the in-place kb:prStatus updater can rebuild a
				// single group without a whole-tree re-render. Scope to that function
				// (between it and the updatePrStatusInPlace helper that follows it).
				return js.slice(
					js.indexOf("function buildShippedGroup"),
					js.indexOf("function updatePrStatusInPlace"),
				);
			}

			it("Synced row: jolliDocUrl present renders Synced-to-Jolli label + SYNCED badge + shipped-link", () => {
				const js = buildSidebarScript();
				const scope = getShippedGroupScope(js);
				// Must reference jolliDocUrl to gate the synced row (now a
				// buildShippedGroup parameter rather than item.jolliDocUrl).
				expect(scope).toContain("if (jolliDocUrl)");
				// Synced row label text
				expect(scope).toContain("Synced to Jolli");
				// SYNCED badge class
				expect(scope).toContain("ship-badge--synced");
				// The link carries the jolliDocUrl so the delegated .shipped-link handler opens it
				expect(scope).toContain("shipped-link");
			});

			it("Synced row: jolliDocUrl absent falls back to ship-push-jolli action (push affordance not lost)", () => {
				const js = buildSidebarScript();
				const scope = getShippedGroupScope(js);
				// The push action must still be present as the else-branch
				expect(scope).toContain("'data-action': 'ship-push-jolli'");
				expect(scope).toContain("Push to Jolli");
			});

			it("E2E row rendered only when e2eCount > 0: shows label + scenario count", () => {
				const js = buildSidebarScript();
				const scope = getShippedGroupScope(js);
				// Gated on e2eCount being truthy / > 0
				expect(scope).toContain("e2eCount");
				// Row label text
				expect(scope).toContain("E2E test guide");
				// Shows the count number
				expect(scope).toContain("scenarios");
			});

			it("E2E row is NOT rendered when e2eCount is absent or 0 (guard present)", () => {
				const js = buildSidebarScript();
				const scope = getShippedGroupScope(js);
				// The guard expression (item.e2eCount or e2eCount with > 0 check) must appear
				// so the row is conditional. The mere presence of e2eCount in an if-guard satisfies this.
				expect(scope).toMatch(/if\s*\([^)]*e2eCount/);
			});

			it("on memory expand the client posts kb:requestPrStatus with the branch", () => {
				const js = buildSidebarScript();
				const scope = getShippedGroupScope(js);
				// The lazy request fires on expand (same entry path as kb:expandMemory)
				expect(scope).toContain("'kb:requestPrStatus'");
				// Keyed by branch (item.hover.branch or state.branchName fallback)
				expect(scope).toContain("branch");
			});

			it("prStatusCache and prStatusPending guards prevent duplicate requests", () => {
				const js = buildSidebarScript();
				// Both cache and pending maps must exist to mirror the evidenceCache/evidencePending pattern
				expect(js).toContain("prStatusCache");
				expect(js).toContain("prStatusPending");
			});

			it("kb:prStatus handler stores result and re-renders", () => {
				const js = buildSidebarScript();
				// The inbound message handler case
				expect(js).toContain("'kb:prStatus'");
				// It stores into the cache keyed by branch
				expect(js).toContain("prStatusCache");
			});

			it("kb:prStatus with pr present renders PR-number row with codicon + OPEN badge", () => {
				const js = buildSidebarScript();
				const scope = getShippedGroupScope(js);
				// The PR row references the pr number
				expect(scope).toContain("pr.number");
				// OPEN badge class
				expect(scope).toContain("ship-badge--open");
				// git-pull-request codicon
				expect(scope).toContain("codicon-git-pull-request");
			});

			it("kb:prStatus with pr null falls back to ship-create-pr action (create-PR affordance not lost)", () => {
				const js = buildSidebarScript();
				const scope = getShippedGroupScope(js);
				// The create-PR fallback action must still be rendered when pr is null
				expect(scope).toContain("'data-action': 'ship-create-pr'");
			});
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
		it("renders no action icons on the Files header (mockup: per-row Discard + Commit Memory button)", () => {
			const js = buildSidebarScript();
			// Select-All / Commit-AI / Discard icons are retired from the header:
			// commit moved to the Working Memory Commit Memory button, Discard is
			// per-row, and Select-All is obsolete under included-by-default.
			expect(js).not.toMatch(/iconButton\('changes-select-all',/);
			expect(js).not.toMatch(/iconButton\('changes-commit-ai',/);
			expect(js).not.toMatch(/iconButton\('changes-discard',/);
			expect(js).not.toContain("'changes-refresh'");
		});

		it("gates entering squash mode while a background AI summary is in progress", () => {
			const js = buildSidebarScript();
			// The "Squash memories…" enter button is disabled during a blocking
			// worker run (ingest exempt via isWorkerBlocking), mirroring the
			// SquashCommand handler gate. The actual confirm lives in the squash
			// bar (gated on 2+ selected || worker busy — asserted below).
			expect(js).toMatch(
				/iconButton\('commits-enter-squash',[\s\S]*?disabled:\s*isWorkerBlocking\(\)/,
			);
			// Squash bar confirm is gated on selection count AND worker busy.
			expect(js).toMatch(/selected < 2 \|\| isWorkerBlocking\(\)/);
			// Push Branch is not worker-gated at all.
			expect(js).toMatch(
				/iconButton\('commits-push-branch', 'Push Branch', 'cloud-upload'\)/,
			);
		});

		it("exempts the ingest phase from disabling commit actions", () => {
			const js = buildSidebarScript();
			// isWorkerBlocking is the single busy predicate for commit actions:
			// busy in any phase except an `ingest*` sub-phase (prefix match so
			// ingest:wiki / ingest:graph both stay exempt).
			expect(js).toContain(
				"return state.workerBusy && !(state.workerPhase && state.workerPhase.indexOf('ingest') === 0);",
			);
			// Both commit entry points go through it: the Commit-AI icon button
			// (asserted above) and the body-bar Commit Memory button.
			expect(js).toMatch(
				/var disabled = selectedCount === 0 \|\| isWorkerBlocking\(\);/,
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

	describe("commits toolbar — explicit squash mode", () => {
		it("header offers a 'Squash memories…' enter action (git-merge), not a permanent squash button", () => {
			const js = buildSidebarScript();
			// New: an enter-mode action that flips the client-side squashMode flag.
			expect(js).toMatch(/iconButton\('commits-enter-squash',.*?'git-merge'[,)]/);
			// Old commitsMode 'multi'/'single' branching is gone.
			expect(js).not.toMatch(/if \(m === 'multi'\)/);
		});

		it("commit-row checkbox visibility keys off the squashMode flag, not commitsMode", () => {
			const js = buildSidebarScript();
			expect(js).toContain("let squashMode = false;");
			expect(js).toMatch(/const isMulti = squashMode && !isViewingForeign\(\);/);
		});

		it("renders a Committed Memories refresh action (global toolbar refresh removed)", () => {
			const js = buildSidebarScript();
			expect(js).toContain("'commits-refresh'");
			expect(js).toMatch(/iconButton\('commits-refresh',/);
		});

		it("shows Push Branch when commits exist", () => {
			const js = buildSidebarScript();
			expect(js).toMatch(/iconButton\('commits-push-branch',.*?'cloud-upload'[,)]/);
		});

		it("entering squash mode flips the flag, clears host selection, and re-renders", () => {
			const js = buildSidebarScript();
			// Now also posts branch:deselectAllCommits between the flag flip and the
			// re-render so a prior session's checks don't surface as stale boxes.
			expect(js).toMatch(
				/a === 'commits-enter-squash'[\s\S]{0,120}squashMode = true;[\s\S]{0,200}'branch:deselectAllCommits'[\s\S]{0,80}renderBranch\(\)/,
			);
		});

		it("renders a squash confirm bar with Select-all / Squash / Cancel, gated on 2+ selected", () => {
			const js = buildSidebarScript();
			expect(js).toContain("function renderSquashBar(");
			expect(js).toContain("'squash-select-all'");
			expect(js).toContain("'squash-confirm'");
			expect(js).toContain("'squash-cancel'");
			expect(js).toContain("Select 2+ memories to squash");
		});

		it("squash bar actions: confirm posts squash, cancel exits, select-all reuses selectAllCommits", () => {
			const js = buildSidebarScript();
			expect(js).toMatch(/act === 'squash-cancel'[\s\S]{0,80}squashMode = false/);
			expect(js).toMatch(/act === 'squash-confirm'[\s\S]{0,400}'jollimemory\.squash'/);
			expect(js).toMatch(/act === 'squash-select-all'[\s\S]{0,220}'jollimemory\.selectAllCommits'/);
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
			// ctx === 'note' picks editNote + 'Edit Note'; plan picks
			// editPlan + 'Edit Plan'. Both labels must appear in the bundled script.
			expect(js).toContain("'Edit Plan'");
			expect(js).toContain("'Edit Note'");
			expect(js).toContain("'jollimemory.editNote'");
			expect(js).toContain("'jollimemory.editPlan'");
		});

		it("Plans & Notes context menu handler matches plan / note contextValues", () => {
			const js = buildSidebarScript();
			expect(js).toContain("ctx === 'plan' || ctx === 'note'");
		});

		it("plan / note context menus carry the unified Preview / Edit / Remove entries", () => {
			const js = buildSidebarScript();
			// Preview re-posts the row-click message (rawMessage), Edit and
			// Remove go through the generic command bridge. The same 'Preview'
			// and 'Remove' labels are shared with the reference menu.
			expect(js).toContain("'Preview'");
			expect(js).toContain("'jollimemory.removePlan'");
			expect(js).toContain("'jollimemory.removeNote'");
			expect(js).toMatch(
				/\{ type: 'branch:openNote', noteId: id \}\s*:\s*\{ type: 'branch:openPlan', planId: id \}/,
			);
		});

		it("reference context menu shows Preview / Edit Markdown / Open in Browser / Remove", () => {
			const js = buildSidebarScript();
			expect(js).toContain("'Edit Markdown'");
			expect(js).toContain("'Open in Browser'");
			expect(js).toMatch(/\{ type: 'branch:openReferencePreview',\s+mapKey: id \}/);
			expect(js).toMatch(/\{ type: 'branch:openReferenceMarkdown',\s+mapKey: id \}/);
			expect(js).toMatch(/\{ type: 'branch:ignoreReference',\s+mapKey: id \}/);
		});

		it("reference row click posts branch:openReferencePreview (click = preview, edit via menu)", () => {
			const js = buildSidebarScript();
			expect(js).toContain(
				"vscode.postMessage({ type: 'branch:openReferencePreview', mapKey: id });",
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

	describe("Current Branch command bar footer", () => {
		it("Current Branch renders a bottom command bar with Commit, Create PR and more", () => {
			const js = buildSidebarScript();
			expect(js).toContain("branch-footer");
			expect(js).toContain("jollimemory.createPrForBranch");
			expect(js).toContain("jollimemory.recallBranchInClaudeCode");
			expect(js).toContain("jollimemory.copyBranchRecallPrompt");
		});

		it("no longer mounts the in-section Commit Memory button", () => {
			const js = buildSidebarScript();
			// The old bottom-of-Changes CTA helper is gone; footer owns commit now.
			expect(js).not.toContain("renderCommitMemoryButton");
			expect(js).not.toContain("commit-memory-action");
		});

		it("footer is appended in renderBranch only when not in foreign mode", () => {
			const js = buildSidebarScript();
			// renderBranch must guard the footer append with the foreign check.
			const renderBranchStart = js.indexOf("function renderBranch");
			expect(renderBranchStart).toBeGreaterThan(-1);
			const renderBranchEnd = js.indexOf(
				"function ",
				renderBranchStart + "function renderBranch".length,
			);
			const body = js.slice(renderBranchStart, renderBranchEnd);
			expect(body).toMatch(/if\s*\(\s*!foreign\s*\)/);
			expect(body).toContain("renderBranchFooter");
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

		describe("foreign-hide + disabled-state regression contracts", () => {
			// NOTE: This suite asserts on the GENERATED SCRIPT STRING, not on a
			// live DOM. The existing test harness throughout this file is
			// string-based (no jsdom execution), so behavioral DOM tests are not
			// possible without a heavier harness. These are structural assertions
			// that pin the control-flow tokens so a regression that removes a guard
			// or swaps a predicate fails loudly.
			//
			// Slicing strategy: renderBranchFooter contains inline anonymous
			// functions (e.g. `function (c) { return !!c.isSelected; }`), so
			// `indexOf("function ")` from fnStart+1 terminates too early. We use
			// `indexOf("\n  function ", fnStart + 1)` (two-space top-level indent
			// matching the surrounding source conventions) to find the NEXT
			// top-level function, consistent with the renderConversationRow tests
			// in this file. For renderBranch we use the same slice pattern as the
			// sibling "footer is appended in renderBranch only when not in foreign
			// mode" test (which is already green) so we reuse its indexing logic.

			it("omits the command bar in foreign read-only mode — renderBranchFooter is called inside the !foreign block", () => {
				// The footer append (container.appendChild(renderBranchFooter()))
				// must be inside the same if(!foreign) block as the workspace-only
				// sections. Slicing renderBranch and asserting that renderBranchFooter
				// appears only after the !foreign guard (and not outside it) locks
				// the structural invariant.
				const js = buildSidebarScript();
				const renderBranchStart = js.indexOf("function renderBranch");
				expect(renderBranchStart).toBeGreaterThan(-1);
				const renderBranchEnd = js.indexOf(
					"\n  function ",
					renderBranchStart + "function renderBranch".length,
				);
				const body = js.slice(renderBranchStart, renderBranchEnd > renderBranchStart ? renderBranchEnd : renderBranchStart + 8000);
				// Guard must precede footer call.
				const foreignGuardIdx = body.search(/if\s*\(\s*!foreign\s*\)/);
				const footerCallIdx = body.indexOf("renderBranchFooter");
				expect(foreignGuardIdx).toBeGreaterThan(-1);
				expect(footerCallIdx).toBeGreaterThan(foreignGuardIdx);
				// renderBranchFooter must not appear anywhere outside/before the guard.
				expect(body.slice(0, foreignGuardIdx)).not.toContain("renderBranchFooter");
			});

			it("Commit button disabled predicate: selectedCount === 0 OR isWorkerBlocking()", () => {
				// The disabled flag governs the body-bar Commit Memory and Review buttons.
				// Both arms of the OR must be present: zero-selection (no staged files to
				// commit) and worker-blocking (summary run in progress, ingest phase exempt).
				// Either arm alone would leave a broken path — e.g. a no-selection check
				// without the worker check lets the user double-trigger an LLM run mid-summary.
				const js = buildSidebarScript();
				// Use whole-script assertions — the anonymous `function (c) { ... }`
				// inside the filter body prevents a clean `indexOf("function ")` slice.
				// These strings are unique to renderCommitReviewBar in the generated output.
				expect(js).toMatch(
					/var disabled = selectedCount === 0 \|\| isWorkerBlocking\(\);/,
				);
				// The flag gates the button's disabled attribute.
				expect(js).toContain("if (disabled) commitBtn.disabled = true");
			});

			it("Create PR button is disabled when the branch has no committed memories (commits.length === 0)", () => {
				// prDisabled reads from branchData.commits with a fallback empty array
				// so it never throws on an uninitialised payload. The Create PR command
				// has no meaningful target when there are no committed memories on the
				// branch.
				const js = buildSidebarScript();
				expect(js).toMatch(
					/var prDisabled = \(branchData\.commits \|\| \[\]\)\.length === 0;/,
				);
				// The flag gates the button's disabled attribute.
				expect(js).toContain("if (prDisabled) prBtn.disabled = true");
			});

			it("positive case: renderCommitReviewBar has exactly two conditional disables (commit + review), renderBranchFooter has exactly one (PR)", () => {
				// Guard: the only `.disabled = true` assignments inside each function
				// must be the guarded-by-if ones. An unconditional disable would mean
				// a button can never be enabled regardless of state.
				// We slice using the two-space-indent next-function marker to avoid
				// the anonymous-function-inside-filter truncation trap.
				const js = buildSidebarScript();
				const barStart = js.indexOf("function renderCommitReviewBar");
				expect(barStart).toBeGreaterThan(-1);
				const barEnd = js.indexOf("\n  function ", barStart + 1);
				const barBody = js.slice(barStart, barEnd > barStart ? barEnd : barStart + 2000);
				// Exactly two conditional disables in the body bar — commit and review.
				const barDisabled = barBody.match(/\.disabled\s*=\s*true/g) ?? [];
				expect(barDisabled).toHaveLength(2);

				const fnStart = js.indexOf("function renderBranchFooter");
				expect(fnStart).toBeGreaterThan(-1);
				const fnEnd = js.indexOf("\n  function ", fnStart + 1);
				const footerBody = js.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 2000);
				// Exactly one conditional disable in the footer — Create PR only.
				const footerDisabled = footerBody.match(/\.disabled\s*=\s*true/g) ?? [];
				expect(footerDisabled).toHaveLength(1);
				expect(footerBody).toContain("if (prDisabled) prBtn.disabled = true");
			});
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

		it("workspace commitWithMemory row click also posts kb:openMemory (not the silent commit slot)", () => {
			// Regression: a workspace memory whose summary lives under a
			// pre-amend hash (commit was amended) had its branch-tab row become
			// unclickable — branch:openCommit → viewSummary → single-hash
			// getSummary missed and silently returned. commitWithMemory rows
			// must route to kb:openMemory regardless of foreign vs workspace so
			// the cross-hash/cross-repo lookup (alias-resolving + "No summary
			// found" feedback) runs instead of the silent commit-slot lookup.
			const js = buildSidebarScript();
			const ctxBlockIdx = js.indexOf(
				"ctx === 'commit' || ctx === 'commitWithMemory'",
			);
			expect(ctxBlockIdx).toBeGreaterThan(-1);
			const window = js.slice(ctxBlockIdx, ctxBlockIdx + 1200);
			// The dispatch predicate must trigger kb:openMemory for
			// commitWithMemory rows OR foreign mode — i.e. not gated on
			// isViewingForeign() alone (which left workspace memory rows on the
			// silent path).
			expect(window).toMatch(/ctx === 'commitWithMemory' \|\| isViewingForeign\(\)/);
			expect(window).toContain("'kb:openMemory'");
			// Plain commit rows still keep the commit slot.
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

		it("both workspace and foreign committed-memory rows expose copy-recall; only workspace exposes pin", () => {
			// Both workspace and foreign rows now show Copy Recall Prompt as
			// an inline button. Workspace rows additionally show Pin (and
			// Share). Foreign rows keep Pin suppressed (as before) but gain
			// Share alongside copy-recall.
			const js = buildSidebarScript();
			const fnIdx = js.indexOf("function renderCommitRow(");
			expect(fnIdx).toBeGreaterThan(-1);
			const fnEnd = js.indexOf("function ", fnIdx + 1);
			const body = js.slice(fnIdx, fnEnd > 0 ? fnEnd : fnIdx + 6000);
			// isViewingForeign gate still controls Pin suppression.
			expect(body).toContain("isViewingForeign()");
			// copy-recall and share appear in both branches.
			expect(body).toMatch(/'data-inline':\s*'copy-recall'/);
			expect(body).toMatch(/'data-inline':\s*'share'/);
			// pin appears only in the non-foreign branch.
			expect(body).toMatch(/'data-inline':\s*'pin'/);
			// eye/viewSummary must be gone from inline-actions entirely.
			expect(body).not.toMatch(/'data-inline':\s*'viewSummary'/);
			expect(body).not.toMatch(/codicon-eye/);
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
		// Reversed from the earlier "no brand tints" decision: CONTEXT rows
		// (plan / note / reference) now use the colored square letter badge
		// (mem-ctx-badge, via the shared ctxBadge helper) so they match the
		// committed-memory evidence "Context" rows and the mockup. References
		// take their hue from the provider (linear / jira / github / notion).
		it("renderPlanRow uses the shared ctxBadge letter badge (not a codicon icon)", () => {
			const js = buildSidebarScript();
			const fnStart = js.indexOf("function renderPlanRow");
			const fnEnd = js.indexOf("function gitStatusToCodicon", fnStart);
			const body = js.slice(fnStart, fnEnd);
			// Leading glyph is the badge, not the old codicon-iconKey span.
			expect(body).toContain("ctxBadge(badgeKind, badgeSource)");
			expect(body).not.toContain("'codicon codicon-' + iconKey");
			// References derive their provider from the forwarded referenceHover.
			expect(body).toContain("item.referenceHover.source");
		});

		it("ctxBadge maps kind/source to the mem-ctx-badge variant + letter", () => {
			const js = buildSidebarScript();
			const fnStart = js.indexOf("function ctxBadge");
			const fnEnd = js.indexOf("function renderMemoryEvidence", fnStart);
			const body = js.slice(fnStart, fnEnd);
			expect(body).toContain("'mem-ctx-badge mem-ctx-badge--' + badgeKind");
			// Per-source reference letters live here now (L / J / G / N / R).
			expect(body).toContain("'linear'");
			expect(body).toContain("'jira'");
			expect(body).toContain("'github'");
			expect(body).toContain("'notion'");
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

		it("edit button (data-inline='edit') renders left of the trash button with the small variant", () => {
			const js = buildSidebarScript();
			const fnStart = js.indexOf("function renderPlanRow");
			const fnEnd = js.indexOf("function renderConversationRow", fnStart);
			const body = js.slice(fnStart, fnEnd);
			// 📌 (pin, plan/note only) before ✎ before 🗑 inside inline-actions.
			const pinIdx = body.indexOf("'data-inline': 'pin'");
			const editIdx = body.indexOf("'data-inline': 'edit'");
			const removeIdx = body.indexOf("'data-inline': 'remove'");
			expect(pinIdx).toBeGreaterThan(-1);
			expect(editIdx).toBeGreaterThan(pinIdx);
			expect(removeIdx).toBeGreaterThan(editIdx);
			expect(body).toContain("codicon-edit");
			// Pin / edit / remove all use the small variant so they stay visually
			// subordinate to the Memories rows' View Memory eye — a missing
			// occurrence would mean one of them silently lost it. The exclude
			// toggle (✕/+) is the 4th small iconbtn in the cluster.
			const smCount = body.split("iconbtn iconbtn--sm").length - 1;
			expect(smCount).toBe(4);
			// Tooltip mirrors the context menu's per-type edit labels.
			expect(body).toContain("'Edit Markdown'");
			expect(body).toContain("'Edit Note'");
			expect(body).toContain("'Edit Plan'");
		});

		it("edit button click routes by row contextValue, mirroring the context menu's edit entry", () => {
			const js = buildSidebarScript();
			// Pin the ctx → target PAIRING, not just co-occurrence — a swapped
			// ternary (note → editPlan) must fail these, so each regex requires
			// the ctx check immediately before its own target.
			expect(js).toMatch(/action\s*===\s*'edit'[\s\S]{0,400}ctx\s*===\s*'reference'[\s\S]{0,120}branch:openReferenceMarkdown/);
			expect(js).toMatch(/action\s*===\s*'edit'[\s\S]{0,400}ctx\s*===\s*'note'\s*\?\s*'jollimemory\.editNote'\s*:\s*'jollimemory\.editPlan'/);
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

	it("renders a compact build pill (Wiki / Graph) for the ingest phase, full label in the title", () => {
		const js = buildSidebarScript();
		// Non-blocking Memory Bank build → a compact pill mirroring the ● AI pill:
		// a spinner + a short phase word that never truncates in a narrow header.
		expect(js).toContain("className: 'section-build-pill'");
		expect(js).toContain("section-build-spin");
		expect(js).toContain("className: 'section-build-text', text: short");
		// Short word per sub-phase; the verbose label survives only as the title.
		expect(js).toContain("const short = isGraph ? 'Graph' : 'Wiki';");
		expect(js).toContain("Building knowledge graph…");
		expect(js).toContain("Building knowledge wiki…");
		// graph is the more specific prefix and must be tested before the wiki
		// fallback, else 'ingest:graph' would match the wiki branch.
		expect(js).toContain("state.workerPhase.indexOf('ingest:graph') === 0");
		expect(js).toContain("state.workerPhase.indexOf('ingest') === 0");
		// The retired single-value label must be gone.
		expect(js).not.toContain("Updating Memory Bank…");
	});

	it("keeps the default AI summary label for non-ingest busy state", () => {
		const js = buildSidebarScript();
		expect(js).toContain("AI summary in progress…");
	});

	it("renders a compact '● AI' pill for the blocking summary instead of inline text", () => {
		const js = buildSidebarScript();
		// Blocking (non-ingest) branch returns the pill; the full phrase survives
		// only as the pill's hover title.
		expect(js).toContain("className: 'section-ai-pill'");
		expect(js).toContain("className: 'section-ai-dot'");
		expect(js).toContain("className: 'section-ai-text', text: 'AI'");
		// The spinner-and-text status is now reserved for the ingest phases only.
		expect(js).toContain("const isIngest = state.workerPhase && state.workerPhase.indexOf('ingest') === 0;");
	});

	it("renders a neutral 'Working…' Working Memory row gated on blocking busy state", () => {
		const js = buildSidebarScript();
		expect(js).toContain("function renderSummarizingRow(");
		// Only during a blocking worker run (busy && no ingest phase).
		expect(js).toContain("if (!state.workerBusy || state.workerPhase) return null;");
		// busy && no phase does NOT prove summarization (worker:busy and
		// worker:phase are independent channels; a Memory Bank ingest run can be
		// busy before its phase signal lands), so the label is neutral, not
		// "Summarizing…". Names the commit from the host-attached hash, degrading
		// to a bare label.
		expect(js).toContain("'Working on ' + hash + '…'");
		expect(js).toContain("'Working…'");
		// The misleading summarize-specific label must be gone.
		expect(js).not.toContain("'Summarizing ' + hash + '…'");
		expect(js).not.toContain("'Summarizing…'");
		expect(js).toContain("summarizing-row");
		// Mounted ahead of the sub-sections inside the Working Memory body.
		expect(js).toContain("if (summarizing) bodyKids.push(summarizing);");
	});

	it("worker:phase keeps any ingest* sub-phase verbatim and clears anything else", () => {
		const js = buildSidebarScript();
		const handlerStart = js.indexOf("case 'worker:phase'");
		const handlerEnd = js.indexOf("case ", handlerStart + 1);
		const body = js.slice(handlerStart, handlerEnd);
		// Prefix-gated pass-through: ingest:wiki / ingest:graph survive, summary → null.
		expect(body).toContain("(msg.phase && msg.phase.indexOf('ingest') === 0) ? msg.phase : null");
	});

	it("handles the worker:phase message channel", () => {
		const js = buildSidebarScript();
		expect(js).toContain("case 'worker:phase'");
	});

	it("re-renders toolbar AND branch when worker:phase changes on the Branch tab", () => {
		const js = buildSidebarScript();
		// The phase drives the commit buttons' disabled state (ingest is exempt
		// from blocking — isWorkerBlocking), so renderToolbar alone is not
		// enough: section actions live in renderBranch.
		const handlerStart = js.indexOf("case 'worker:phase'");
		const handlerEnd = js.indexOf("case ", handlerStart + 1);
		expect(handlerStart).toBeGreaterThan(-1);
		const body = js.slice(handlerStart, handlerEnd);
		// Idempotent: skip re-render when the phase did not change.
		expect(body).toContain("if (state.workerPhase === nextPhase) break;");
		expect(body).toContain("renderToolbar()");
		expect(body).toContain("renderBranch()");
	});

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

	it("handles branch:pinsData and renders a Pinned section", () => {
		const js = buildSidebarScript();
		expect(js).toContain("'branch:pinsData'");
		expect(js).toContain("function renderPinned");
	});

	it("wires pin / unpin row actions", () => {
		const js = buildSidebarScript();
		expect(js).toContain("type: 'branch:pin'");
		expect(js).toContain("type: 'branch:unpin'");
	});

	it("conversation pin includes source and transcriptPath in the branch:pin message", () => {
		const js = buildSidebarScript();
		// The inline pin handler for conversation rows reads source and transcriptPath
		// from the row's data attributes so they survive into the persisted PinEntry.
		expect(js).toContain("data-transcript-path");
		expect(js).toContain("convSource");
		expect(js).toContain("convTranscriptPath");
		// The pin message for a conversation row carries both fields.
		expect(js).toMatch(/source:\s*convSource/);
		expect(js).toMatch(/transcriptPath:\s*convTranscriptPath/);
		// Pin is not offered when either field is empty — a conversation that
		// cannot be reopened must not be pinnable (the hover Pin button is only
		// rendered when canPinConv holds).
		expect(js).toMatch(/canPinConv\s*=\s*!isViewingForeign\(\)\s*&&\s*!!item\.source\s*&&\s*!!item\.transcriptPath/);
	});

	it("reference rows pin by mapKey and reopen via branch:openReferencePreview", () => {
		const js = buildSidebarScript();
		// Inline pin handler: reference rows emit kind 'reference' keyed by the
		// row's data-id (which is the reference mapKey).
		expect(js).toMatch(/ctx === 'reference'[\s\S]{0,160}kind:\s*'reference',\s*id:\s*id/);
		// renderPinnedRow reopens a pinned reference through its preview path,
		// passing pin.id as the mapKey.
		expect(js).toMatch(/case 'reference':[\s\S]{0,300}type:\s*'branch:openReferencePreview',\s*mapKey:\s*pin\.id/);
		// The pinned-row icon map carries a reference entry (else it would fall
		// back to the generic 'pin' codicon).
		expect(js).toContain("reference:    'link-external'");
	});

	it("pinned conversation row posts full branch:openConversation with source and transcriptPath", () => {
		const js = buildSidebarScript();
		// renderPinnedRow for conversation must include source and transcriptPath
		// so SidebarWebviewProvider accepts the message (it guards on both fields).
		expect(js).toMatch(/source:\s*pin\.source/);
		expect(js).toMatch(/transcriptPath:\s*pin\.transcriptPath/);
		expect(js).toMatch(/title:\s*pin\.title/);
	});

	it("pinned conversation row renders the per-source brand icon (like live CONVERSATIONS rows)", () => {
		const js = buildSidebarScript();
		const renderPinnedRow = js.slice(
			js.indexOf("function renderPinnedRow"),
			js.indexOf("function renderPinned("),
		);
		// Conversation pins use convSourceIcon + the conv-source-icon column,
		// not the generic comment-discussion codicon, so the brand glyph shows.
		expect(renderPinnedRow).toMatch(/pin\.kind === 'conversation' && pin\.source/);
		expect(renderPinnedRow).toContain("convSourceIcon(pin.source)");
		expect(renderPinnedRow).toContain("'icon conv-source-icon'");
	});

	it("pinned context + memory icons match the committed-memory section", () => {
		const js = buildSidebarScript();
		const renderPinnedRow = js.slice(
			js.indexOf("function renderPinnedRow"),
			js.indexOf("function renderPinned("),
		);
		// plan / note / reference pins → the shared colored letter badge. The
		// reference provider comes from the "source:nativeId" mapKey (pin.id).
		expect(renderPinnedRow).toContain("ctxBadge(pin.kind, refSource)");
		expect(renderPinnedRow).toContain("String(pin.id || '').split(':')[0]");
		// memory pins → blue kb-icon-memory markdown glyph (was untinted gray).
		expect(renderPinnedRow).toMatch(/pin\.kind === 'memory'/);
		expect(renderPinnedRow).toContain("'icon kb-icon-memory'");
	});

	it("handles kb:memoryEvidence and renders memory evidence in the Timeline", () => {
		const js = buildSidebarScript();
		expect(js).toContain("'kb:memoryEvidence'");
		expect(js).toContain("function renderMemoryEvidence");
	});

	// Lockstep with the live CONVERSATIONS rows and Pinned rows: the
	// committed-memory conversation row surfaces the agent identity via the
	// shared per-source brand glyph (convSourceIcon) and a trailing "N msgs"
	// count — NOT a source text pill, and no longer the old generic
	// colored-comment glyph (.mem-conv-icon.src-*).
	it("committed-memory conversation evidence row uses the per-source brand glyph + trailing msg count", () => {
		const js = buildSidebarScript();
		// Isolate the Conversations evidence group (between its makeGroup call
		// and the following Context group) so the convSourceIcon assertion can't
		// be satisfied by the live-row / Pinned-row usages elsewhere in the file.
		const start = js.indexOf("makeGroup('Conversations'");
		const end = js.indexOf("makeGroup('Context'", start);
		const body = js.slice(start, end);
		expect(body).toContain("conv-source-icon' }, [convSourceIcon(item.source)]");
		expect(body).toContain("String(item.messageCount) + ' msgs'");
		// The old generic colored-comment glyph is gone from the evidence row.
		expect(body).not.toContain("codicon-comment mem-conv-icon");
		expect(body).not.toContain("' src-' + item.source");
		// The source text pill (both flavors) is gone from the evidence row.
		expect(body).not.toContain("'badge transcript-source-' + item.source");
		expect(body).not.toContain("'memory-evidence-source'");
	});

	// BUG 3: clicking a committed-memory conversation must open the ARCHIVED
	// snapshot (kb:openEvidenceConversation with commitHash), NOT the live
	// branch:openConversation path whose cursor-trimmed read is empty for a
	// committed memory.
	it("committed-memory conversation evidence row opens the archived snapshot via kb:openEvidenceConversation", () => {
		const js = buildSidebarScript();
		expect(js).toContain("type: 'kb:openEvidenceConversation'");
		expect(js).toContain("commitHash: commitHash");
	});

	it("lazily requests memory evidence on expand", () => {
		const js = buildSidebarScript();
		expect(js).toContain("type: 'kb:expandMemory'");
	});

	it("groups Timeline memories under relative-time labels", () => {
		const js = buildSidebarScript();
		expect(js).toContain("function timeGroupLabel");
		expect(js).toContain("Today");
		expect(js).toContain("Earlier this week");
	});

	it("scopes the Timeline by the repo filter and shows it on the Memory Bank view", () => {
		const js = buildSidebarScript();
		expect(js).toContain("repo-filter");
		expect(js).toContain("kbRepoFilter");
	});

	it("scopes the Folders tree by the repo filter using the raw repoName", () => {
		const js = buildSidebarScript();
		// renderFolders filters repo roots on the same repoName key the Showing
		// dropdown and the Memories / Knowledge renderers compare against.
		expect(js).toContain("c.repoName === kbRepoFilter");
		// Picking a repo while in Folders mode re-renders the tree (not just the
		// Timeline / Knowledge views).
		expect(js).toContain("else if (state.kbMode === 'folders') renderFolders();");
	});

	it("hides the repo/branch breadcrumb on the Memory Bank and Knowledge views", () => {
		const js = buildSidebarScript();
		// The 'Showing' repo-filter is the sole repo selector on those tabs, so
		// the whole breadcrumb is hidden to avoid a redundant second dropdown.
		expect(js).toContain("breadcrumbEl.classList.toggle('hidden', isKb)");
	});

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

	it("Review dispatches reviewNextMemory; footer Share and the row icon dispatch the share commands", () => {
		const js = buildSidebarScript();
		expect(js).toContain("jollimemory.reviewNextMemory");
		expect(js).toContain("jollimemory.shareBranch");
		expect(js).toContain("jollimemory.shareMemory");
	});

	it("renders a Committed Memories token bar from branch:tokenStats", () => {
		const js = buildSidebarScript();
		expect(js).toContain("'branch:tokenStats'");
		expect(js).toContain("function renderTokenBar");
		// Label now carries a cache-aware cost estimate between the token total
		// and the "this branch" scope: "<total> tokens · ≈$X.XX · this branch".
		expect(js).toContain("' tokens \xB7 '");
		expect(js).toContain("' \xB7 this branch'");
		// degrades to hidden when no stats received
		expect(js).toContain("state.tokenStats");
		// bucketed CSS width class (not inline style)
		expect(js).toContain("token-seg--w");
		// cached is the third segment + legend item, gated on cached > 0.
		expect(js).toContain("token-seg--cached");
		expect(js).toContain("' cached'");
		expect(js).toContain("cached: msg.cached || 0");
		// total reconciles input + output + cached.
		// "?" help affordance explains the partial-reporting total + the cost.
		expect(js).toContain("token-bar-help");
		expect(js).toContain("codicon-question");
	});

	it("token bar shows a cache-aware Sonnet-priced cost estimate in the label", () => {
		const js = buildSidebarScript();
		// Sonnet 4.6 rates per million tokens: input 3, output 15, cached at the
		// cache-read rate 0.30 (a floor — cached folds read + the pricier creation).
		expect(js).toContain("(stats.input * 3 + stats.output * 15 + cached * 0.3) / 1000000");
		// Rendered as "≈$X.XX", with a "<$0.01" floor for sub-cent branches.
		expect(js).toContain("'≈$'");
		expect(js).toContain("'<$0.01'");
		expect(js).toContain("costUsd.toFixed(2)");
	});

	it("token bar tooltip reports N-of-M reporting memories and the Sonnet cost caveat", () => {
		const js = buildSidebarScript();
		// reporting / memories counts are plumbed through state.tokenStats…
		expect(js).toContain("reporting: msg.reporting || 0");
		expect(js).toContain("memories: msg.memories || 0");
		// …and drive the mockup's partial-reporting tooltip line.
		expect(js).toContain("memories on this branch report token usage");
		expect(js).toContain("don’t report it");
		// Cost caveat sentence (assumes Sonnet pricing, counts reporting only).
		expect(js).toContain("assumes Sonnet pricing");
		expect(js).toContain("actual spend may be higher");
	});

	it("branch-tab mouseover handler skips hover-card for commitWithMemory rows", () => {
		// The row subline + expandable memory-details replace the hover card for
		// committed-memory rows; the popover must never show for them. The gate
		// must live in the COMMIT hover-card show path (the handler that calls
		// scheduleShowHoverCard with 'data-id'), NOT in the plan/note/reference
		// handler. Plain 'commit' rows must still reach scheduleShowHoverCard.
		const js = buildSidebarScript();
		// The branch-tab commit card handler passes the row id via the `sid`
		// local (the KB tab uses 'data-hash' inline), so anchor on that to find
		// the right call-site.
		const branchScheduleCall = "scheduleShowHoverCard(sid, e.clientX, e.clientY)";
		const scheduleIdx = js.indexOf(branchScheduleCall);
		expect(scheduleIdx).toBeGreaterThan(-1);
		// Walk back to the nearest preceding branch mouseover addEventListener.
		const moMarker = "tabContents.branch.addEventListener('mouseover'";
		const moIdx = js.lastIndexOf(moMarker, scheduleIdx);
		expect(moIdx).toBeGreaterThan(-1);
		// Slice from the handler open to just past the scheduleShowHoverCard call.
		const handlerWindow = js.slice(moIdx, scheduleIdx + 100);
		// Must suppress commitWithMemory before reaching scheduleShowHoverCard.
		expect(handlerWindow).toContain("commitWithMemory");
		// Plain 'commit' context must NOT be unconditionally excluded — it is
		// handled via isCommitRow and must reach scheduleShowHoverCard.
		expect(handlerWindow).not.toMatch(/ctx\s*===\s*'commit'\s*\)/);
	});

	it("branch-tab commit hover-card is suppressed for the row being AI-summarized", () => {
		// During the blocking AI summary, the HEAD commit is still a plain
		// 'commit' row (it becomes a hover-less 'commitWithMemory' row only once
		// the summary lands). The mouseover handler must bail BEFORE
		// scheduleShowHoverCard when the row id matches the summarizing hash, so
		// the popover never shows mid-generation. summarizingHash is a SHORT hash
		// and the row id is the FULL hash → the guard must prefix-match, not ===.
		const js = buildSidebarScript();
		const branchScheduleCall = "scheduleShowHoverCard(sid, e.clientX, e.clientY)";
		const scheduleIdx = js.indexOf(branchScheduleCall);
		expect(scheduleIdx).toBeGreaterThan(-1);
		const moMarker = "tabContents.branch.addEventListener('mouseover'";
		const moIdx = js.lastIndexOf(moMarker, scheduleIdx);
		const handlerWindow = js.slice(moIdx, scheduleIdx);
		// Gated on the blocking-summary state + the summarizing hash...
		expect(handlerWindow).toContain("isWorkerBlocking()");
		expect(handlerWindow).toContain("state.summarizingHash");
		// ...and matched by prefix (short hash is a prefix of the full row id).
		expect(handlerWindow).toContain("sid.indexOf(state.summarizingHash) === 0");
		// Must NOT use strict equality (full vs short hash would never match).
		expect(handlerWindow).not.toContain("sid === state.summarizingHash");
	});

	describe("Task A4: committed-memory row subline (time · hash · tokens)", () => {
		// Slice renderCommitRow from the script for scoped assertions.
		function getRenderCommitRow(js: string): string {
			const start = js.indexOf("function renderCommitRow");
			const end = js.indexOf("\n  function ", start + 1);
			return js.slice(start, end > start ? end : undefined);
		}

		it("renderCommitRow hasMem branch builds a .mem-subline element", () => {
			const js = buildSidebarScript();
			const fn = getRenderCommitRow(js);
			expect(fn).toContain("'mem-subline'");
		});

		it("renderCommitRow hasMem branch references item.hover.relativeDate in the subline", () => {
			const js = buildSidebarScript();
			const fn = getRenderCommitRow(js);
			// The subline must pull relativeDate from the hover payload.
			expect(fn).toContain("item.hover.relativeDate");
		});

		it("renderCommitRow hasMem branch references item.hover.shortHash in the subline", () => {
			const js = buildSidebarScript();
			const fn = getRenderCommitRow(js);
			// shortHash must be emitted in the subline (monospace class).
			expect(fn).toContain("item.hover.shortHash");
			// The hash segment must carry a monospace class.
			expect(fn).toContain("mem-sub-hash");
		});

		it("renderCommitRow hasMem branch calls formatTokens(item.conversationTokens) in the subline", () => {
			const js = buildSidebarScript();
			const fn = getRenderCommitRow(js);
			expect(fn).toContain("formatTokens(item.conversationTokens)");
		});

		it("token segment is gated on typeof item.conversationTokens === 'number' (never renders undefined)", () => {
			const js = buildSidebarScript();
			const fn = getRenderCommitRow(js);
			// The guard must be present so the segment is absent when conversationTokens is undefined.
			expect(fn).toContain("typeof item.conversationTokens === 'number'");
		});

		it("dot separators between subline segments use a .mem-sub-sep span (not a bare literal dot)", () => {
			const js = buildSidebarScript();
			const fn = getRenderCommitRow(js);
			expect(fn).toContain("mem-sub-sep");
		});
	});

	describe("code-review fixes S1-S8", () => {
		it("S1: knowledge search restores focus + exact caret on host-pushed renders", () => {
			const js = buildSidebarScript();
			const fn = js.slice(
				js.indexOf("function renderKnowledge"),
				js.indexOf("// Click delegation for status entries"),
			);
			// Capture the live input's focus + selection range BEFORE mountIn
			// destroys it (covers a kb:knowledgeData arriving mid-typing).
			expect(fn).toContain("document.activeElement === liveInput");
			expect(fn).toContain("liveInput.selectionStart");
			expect(fn).toContain("liveInput.selectionEnd");
			// Restore fires for both the host-pushed path (inputWasFocused) and the
			// debounced-search path (knRestoreSearchFocus).
			expect(fn).toContain("if (inputWasFocused || knRestoreSearchFocus)");
			// Replays the exact range when captured, else falls back to end-of-value.
			expect(fn).toContain("inp.setSelectionRange(savedSelStart, savedSelEnd)");
		});

		it("S2: squash enter and cancel post branch:deselectAllCommits; confirm does not (race)", () => {
			const js = buildSidebarScript();
			// Enter squash clears stale host-side selection.
			const enterScope = js.slice(
				js.indexOf("a === 'commits-enter-squash'"),
				js.indexOf("const cmdMap = {"),
			);
			expect(enterScope).toContain("type: 'branch:deselectAllCommits'");
			// Cancel clears on exit.
			const exitScope = js.slice(
				js.indexOf("if (act === 'squash-cancel')"),
				js.indexOf("// Commit rows: data-checkbox-kind"),
			);
			expect(exitScope).toContain("type: 'branch:deselectAllCommits'");
			// Confirm must NOT post deselect (it would race the async squash read).
			const confirmScope = exitScope.slice(exitScope.indexOf("act === 'squash-confirm'"));
			expect(confirmScope).not.toContain("branch:deselectAllCommits");
		});

		it("S3: subsectionShowAll[s.id] is reset when a sub-section shrinks to/below the cap", () => {
			const js = buildSidebarScript();
			expect(js).toContain("if (s.subsection && !overLimit && state.subsectionShowAll[s.id])");
			expect(js).toContain("delete state.subsectionShowAll[s.id];");
		});

		it("S4: token bar floors buckets and clamps cached so input+cached never crowds out output", () => {
			const js = buildSidebarScript();
			const fn = js.slice(
				js.indexOf("function renderTokenBar"),
				js.indexOf("function renderBranch"),
			);
			// Floor, not round — round-up on both segments could push the sum past 100.
			expect(fn).toContain("Math.floor((n / stats.total) * 100 / 10) * 10");
			// Cached is clamped to leave at least one 10% slot for the output segment.
			expect(fn).toContain("Math.min(bucket(cached), 90 - inputW)");
			// Negative clamp guard.
			expect(fn).toContain("if (cachedW < 0) cachedW = 0;");
		});

		// Pure-function repro for the S4 overflow: simulate the bucket+clamp math the
		// way the webview computes it and assert the fixed widths can never sum to
		// >= 100% (which would collapse the flex output segment / overflow the bar).
		it("S4 repro: input% + cached% bucket+clamp stays <= 90 for adversarial splits", () => {
			function bucket(n: number, total: number): number {
				const pct = Math.floor((n / total) * 100 / 10) * 10;
				return pct < 0 ? 0 : pct > 100 ? 100 : pct;
			}
			function widths(input: number, cached: number, total: number): [number, number] {
				const inputW = bucket(input, total);
				let cachedW = Math.min(bucket(cached, total), 90 - inputW);
				if (cachedW < 0) cachedW = 0;
				return [inputW, cachedW];
			}
			// The classic failing case: both segments ~46-49% → old round() gave 50+50=100,
			// crushing output. floor+clamp keeps room.
			const cases: Array<[number, number, number]> = [
				[46, 46, 100],
				[49, 49, 100],
				[48, 48, 100],
				[90, 9, 100],
				[55, 44, 100],
				[1, 99, 100],
			];
			for (const [input, cached, total] of cases) {
				const [iw, cw] = widths(input, cached, total);
				expect(iw + cw).toBeLessThanOrEqual(90);
				// Output (flex remainder) always has at least 10% of room.
				expect(100 - (iw + cw)).toBeGreaterThanOrEqual(10);
			}
		});

		it("S6: kb:memoryEvidence updates one row in place and only full-renders on miss", () => {
			const js = buildSidebarScript();
			const handler = js.slice(
				js.indexOf("case 'kb:memoryEvidence'"),
				js.indexOf("case 'kb:prStatus'"),
			);
			// Calls the in-place updater first.
			expect(handler).toContain("updateMemoryEvidenceInPlace(msg.commitHash, msg.evidence)");
			// Full re-render only when the row isn't currently mounted.
			expect(handler).toContain("if (!placedEvidence)");
			// The in-place updater scans forward siblings and replaces only the
			// evidence/loading node (single-row update, not a tree reset).
			const updater = js.slice(
				js.indexOf("function updateMemoryEvidenceInPlace"),
				js.indexOf("function cssAttrEscape"),
			);
			expect(updater).toContain("nextElementSibling");
			expect(updater).toContain("renderMemoryEvidence(hash, evidence)");
			// It targets BOTH the KB memory-row and the Branch commit row.
			expect(updater).toContain(".memory-row[data-hash=");
			expect(updater).toContain(".tree-node[data-id=");
			// The whole-tree fallback is GUARDED by the in-place miss, never
			// unconditional (the regression being fixed).
			expect(handler).toContain("if (!placedEvidence)");
			expect(handler).not.toContain(
				"if (state.activeTab === 'kb' && state.kbMode === 'memories') renderMemories();\n        if (state.activeTab === 'branch') renderBranch();",
			);
		});

		it("S6: kb:prStatus rebuilds only the matching shipped-group(s) in place", () => {
			const js = buildSidebarScript();
			const handler = js.slice(
				js.indexOf("case 'kb:prStatus'"),
				js.indexOf("case 'branch:plansData'"),
			);
			expect(handler).toContain("updatePrStatusInPlace(msg.branch)");
			expect(handler).toContain("if (!placedPr)");
			const updater = js.slice(
				js.indexOf("function updatePrStatusInPlace"),
				js.indexOf("function updateMemoryEvidenceInPlace"),
			);
			// Locates groups by the data-pr-branch tag and replaces each in place.
			expect(updater).toContain(".shipped-group[data-pr-branch]");
			expect(updater).toContain("g.replaceWith(fresh)");
			// Rebuilds via the shared builder, not a whole renderBranch.
			expect(updater).toContain("buildShippedGroup(hash, branch, e2eCount, jolliDocUrl)");
		});

		it("S6: shipped-group carries the data-* the in-place PR updater needs", () => {
			const js = buildSidebarScript();
			const fn = js.slice(
				js.indexOf("function buildShippedGroup"),
				js.indexOf("function updatePrStatusInPlace"),
			);
			expect(fn).toContain("'data-pr-branch': memBranch || ''");
			expect(fn).toContain("'data-pr-hash': hash");
			expect(fn).toContain("'data-e2e-count'");
			expect(fn).toContain("'data-jolli-doc-url'");
		});
	});
});

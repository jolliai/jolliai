import { describe, expect, it } from "vitest";
import { buildSidebarScript } from "./SidebarScriptBuilder";

describe("SidebarScriptBuilder", () => {
	it("returns a JS string", () => {
		const js = buildSidebarScript();
		expect(typeof js).toBe("string");
		expect(js.length).toBeGreaterThan(0);
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

	it("handles kb:foldersReset by clearing folderCache and refreshing the repo header", () => {
		const js = buildSidebarScript();
		expect(js).toContain("'kb:foldersReset'");
		// Cache must be wiped (not just root) — rebuild may rename paths at any depth.
		expect(js).toContain("delete folderCache[k]");
		// Repo header label is replaced when the host signals a rename
		// (e.g. Rebuild → -N suffix), so the new name shows up immediately.
		expect(js).toContain("kbRepoFolder = msg.kbRepoFolder");
		// The dead auto-expand-by-name latch is gone — the repo header is
		// rendered as a tree node now, no auto-expand-on-arrival needed.
		expect(js).not.toContain("kbRepoFolderExpanded");
	});

	it("re-attaches cached subtrees onto root listings so manual refresh keeps folders expanded", () => {
		const js = buildSidebarScript();
		// Reattach helper exists, runs only for root, and recurses for depth.
		expect(js).toContain("reattachExpandedFromCache");
		expect(js).toContain(
			"if (tree.relPath === '') tree = reattachExpandedFromCache(tree)",
		);
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

	it("disabled mode forces Status panel visible and hides KB/Branch panels", () => {
		const js = buildSidebarScript();
		// Explicit visibility flips for the disabled branch of applyEnabled.
		// We toggle the .hidden class (instead of the HTML hidden attribute)
		// because UA-stylesheet display:none for [hidden] loses to author
		// rules like display:flex on .tab-bar / .tab-toolbar.
		expect(js).toContain("tabContents.kb.classList.add('hidden')");
		expect(js).toContain("tabContents.branch.classList.add('hidden')");
		expect(js).toContain("tabContents.status.classList.remove('hidden')");
	});

	it("re-renders toolbar on enabled:changed (Disable button visibility depends on enabled)", () => {
		const js = buildSidebarScript();
		// Confirm renderToolbar() is called inside the enabled:changed handler.
		const handlerStart = js.indexOf("'enabled:changed'");
		const handlerEnd = js.indexOf("break", handlerStart);
		expect(handlerStart).toBeGreaterThan(-1);
		expect(js.slice(handlerStart, handlerEnd)).toContain("renderToolbar()");
	});

	it("renders an AI summary indicator on the Branch tab toolbar when workerBusy", () => {
		const js = buildSidebarScript();
		// The indicator container + spinning loading codicon + label live in
		// renderToolbar's branch (else) branch.
		expect(js).toContain("toolbar-worker-status");
		expect(js).toContain("codicon-loading codicon-modifier-spin");
		expect(js).toContain("AI summary in progress…");
	});

	it("handles worker:busy by re-rendering toolbar only when on Branch tab", () => {
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
		expect(js.slice(handlerStart, handlerEnd)).toContain(
			"state.activeTab === 'branch'",
		);
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

	it("renders kbRepoFolder as a repo-root header above the folder tree", () => {
		const js = buildSidebarScript();
		// renderFolders() must build a tree-node with data-kind="repo-root"
		// whose label comes from kbRepoFolder. This is the IntelliJ-parity
		// header that shows the real repo name (origin URL basename), not
		// the worktree directory name. Children render at depth 1 below it.
		expect(js).toContain("'data-kind': 'repo-root'");
		expect(js).toContain("kbRepoFolder || 'Memory Bank'");
		expect(js).toContain("renderFolderChildren(root.children, 1)");
		// Repo-root clicks must early-return so the header doesn't accidentally
		// fire kb:openFile (it has no data-path).
		expect(js).toContain("if (kind === 'repo-root') return");
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
});

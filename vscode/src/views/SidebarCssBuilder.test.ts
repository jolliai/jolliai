import { describe, expect, it } from "vitest";
import { buildSidebarCss } from "./SidebarCssBuilder";

describe("SidebarCssBuilder", () => {
	it("returns CSS string", () => {
		const css = buildSidebarCss();
		expect(typeof css).toBe("string");
		expect(css.length).toBeGreaterThan(0);
	});

	it("uses VSCode theme variables", () => {
		const css = buildSidebarCss();
		expect(css).toContain("var(--vscode-foreground)");
		expect(css).toContain("var(--vscode-editor-background)");
	});

	it("declares the .sidebar-root and .tab-bar classes", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".sidebar-root");
		expect(css).toContain(".tab-bar");
		expect(css).toContain(".tab.active");
	});

	it("declares the .collapsible-section class", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".collapsible-section");
	});

	it("declares the .tree-node class with indent attribute selectors", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".tree-node");
		expect(css).toContain("[data-indent");
	});

	it("tints memory/plan/note codicon glyphs in the icon column", () => {
		// Migrated from "M/P/N badge styles": the icon column now renders a
		// codicon-markdown glyph and the .kb-icon-{kind} class colors the
		// glyph. Badge squares moved out to a trailing .kb-tag (see below).
		const css = buildSidebarCss();
		expect(css).toMatch(/\.tree-node\s+\.icon\.kb-icon-memory\s+\.codicon/);
		expect(css).toMatch(/\.tree-node\s+\.icon\.kb-icon-plan\s+\.codicon/);
		expect(css).toMatch(/\.tree-node\s+\.icon\.kb-icon-note\s+\.codicon/);
	});

	it("declares trailing .kb-tag chips for plan / note files (no memory tag)", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".tree-node .kb-tag");
		expect(css).toContain(".tree-node .kb-tag-plan");
		expect(css).toContain(".tree-node .kb-tag-note");
		// Memory has no trailing tag — the tinted icon already conveys it.
		expect(css).not.toContain(".kb-tag-memory");
	});

	it("styles the repo-root header (bold label, decorative cursor, no hover bg)", () => {
		// The repo-root header mirrors IntelliJ KBExplorerPanel's repo node:
		// bolded label for the current repo, and decorative (non-clickable)
		// because folding the whole KB tree isn't useful in a single-repo view.
		// Hover background is suppressed so the row doesn't suggest interaction.
		const css = buildSidebarCss();
		expect(css).toMatch(
			/\.tree-node\[data-kind="repo-root"\][^{]*{\s*cursor:\s*default/,
		);
		expect(css).toMatch(
			/\.tree-node\[data-kind="repo-root"\]\s*>\s*\.label\s*{\s*font-weight:\s*600/,
		);
		expect(css).toMatch(
			/\.tree-node\[data-kind="repo-root"\]:hover\s*{\s*background:\s*transparent/,
		);
	});
});

describe("hover-reveal actions use visibility (no reflow)", () => {
	// History: an earlier display-toggle attempt on .section-actions caused
	// header-height flicker on mouse-enter because display:none collapses the
	// slot. The fix across the sidebar — for both .section-header and
	// .memory-row — is to use visibility:hidden ↔ visibility:visible, which
	// keeps the slot reserved at rest and avoids any layout shift.
	//
	// .tree-node rows still keep their inline actions always-visible: each row
	// is short enough that an extra hover gate would be more noise than help.

	it("keeps .tree-node .inline-actions always visible (no hover gate)", () => {
		const css = buildSidebarCss();
		expect(css).not.toMatch(
			/\.tree-node\s+\.inline-actions\s*{[^}]*opacity:\s*0/,
		);
		expect(css).not.toMatch(
			/\.tree-node\s+\.inline-actions\s*{[^}]*visibility:\s*hidden/,
		);
		expect(css).not.toMatch(/\.tree-node:hover\s*\.inline-actions/);
	});

	it("never uses display:none for .section-actions (would reflow header)", () => {
		const css = buildSidebarCss();
		expect(css).not.toMatch(/\.section-actions\s*{[^}]*display:\s*none/);
		expect(css).not.toMatch(
			/\.section-header:hover\s*\.section-actions\s*{[^}]*display:\s*/,
		);
	});

	it("section-header reveals its .section-actions on hover via visibility", () => {
		const css = buildSidebarCss();
		expect(css).toMatch(/\.section-actions\s*{[^}]*visibility:\s*hidden/);
		expect(css).toMatch(
			/\.section-header:hover\s+\.section-actions\s*{[^}]*visibility:\s*visible/,
		);
	});

	it("memory-row reveals its inline-actions on hover via visibility", () => {
		const css = buildSidebarCss();
		expect(css).toMatch(
			/\.memory-row\s+\.inline-actions\s*{[^}]*visibility:\s*hidden/,
		);
		expect(css).toMatch(
			/\.memory-row:hover\s+\.inline-actions\s*{[^}]*visibility:\s*visible/,
		);
	});

	it("changes rows reveal their inline-actions on hover via visibility", () => {
		const css = buildSidebarCss();
		// .tree-node--changes is the modifier class added by renderChangeRow
		// so hover-reveal stays scoped to the Changes section (plans / commits
		// keep their always-visible inline buttons).
		expect(css).toMatch(
			/\.tree-node--changes\s+\.inline-actions\s*{[^}]*visibility:\s*hidden/,
		);
		expect(css).toMatch(
			/\.tree-node--changes:hover\s+\.inline-actions\s*{[^}]*visibility:\s*visible/,
		);
	});
});

describe("git decoration colors", () => {
	it("uses --vscode-gitDecoration-* variables for .gs-M/.gs-A/.gs-D etc", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".gs-M");
		expect(css).toContain("--vscode-gitDecoration-modifiedResourceForeground");
		expect(css).toContain(".gs-A");
		expect(css).toContain("--vscode-gitDecoration-addedResourceForeground");
		expect(css).toContain(".gs-D");
		expect(css).toContain("--vscode-gitDecoration-deletedResourceForeground");
		expect(css).toContain(".gs-U");
		expect(css).toContain("--vscode-gitDecoration-untrackedResourceForeground");
		expect(css).toContain(".gs-R");
		expect(css).toContain("--vscode-gitDecoration-renamedResourceForeground");
	});
});

describe("kb-search-box (always-visible toolbar search input)", () => {
	it("declares .kb-search-box wrapper with leading icon and themed input", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".kb-search-box");
		expect(css).toContain(".kb-search-icon");
		// Uses theme tokens so it picks up native VSCode input styling.
		expect(css).toContain("var(--vscode-input-background)");
		expect(css).toContain("var(--vscode-input-foreground)");
	});

	it("does not retain the obsolete .search-row toggle styles", () => {
		const css = buildSidebarCss();
		// The toggle button + inline search-row pattern was replaced by the
		// always-visible toolbar input.
		expect(css).not.toContain(".search-row");
	});

	it("declares .toolbar-worker-status to push the indicator left and shrink gracefully", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".toolbar-worker-status");
		// flex:1 1 auto packs the refresh button to the right edge (same trick
		// as .kb-search-box). min-width:0 lets the label ellipsis-truncate
		// rather than overflow.
		expect(css).toMatch(/\.toolbar-worker-status\s*{[\s\S]*?flex:\s*1 1 auto/);
		expect(css).toMatch(/\.toolbar-worker-status\s*{[\s\S]*?min-width:\s*0/);
		expect(css).toContain(".toolbar-worker-status-text");
		expect(css).toContain("text-overflow: ellipsis");
	});
});

describe("checkbox + row-leading", () => {
	it("declares fixed-width .row-leading column", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".row-leading");
		expect(css).toMatch(/\.row-leading\s*{[^}]*width:\s*18px/);
	});

	it("themes the checkbox via --vscode-checkbox-background", () => {
		const css = buildSidebarCss();
		expect(css).toContain('.row-leading input[type="checkbox"]');
		expect(css).toContain("var(--vscode-checkbox-background)");
	});
});

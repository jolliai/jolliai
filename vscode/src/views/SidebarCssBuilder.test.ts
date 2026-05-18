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

	it("bolds repo nodes (no longer has the dead repo-root banner styling)", () => {
		// There's no Memory Bank header / banner row — repos sit at the top of
		// the tree directly. The only surviving repo-level cue is
		// the bold label on `[data-kind="repo"]`, which marks repos as the
		// primary grouping in the flat listing. The previous repo-root rules
		// (cursor:default, suppressed hover-bg) are removed since they styled
		// a row that no longer renders.
		const css = buildSidebarCss();
		expect(css).toMatch(
			/\.tree-node\[data-kind="repo"\]\s*>\s*\.label\s*{\s*font-weight:\s*600/,
		);
		expect(css).not.toContain('[data-kind="repo-root"]');
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

describe("file-row truncation priority (dirname-first, filename last-resort)", () => {
	// Product decision: in BOTH the Changes panel and the COMMITS expanded
	// commit-file rows, the dirname (.desc) absorbs essentially all overflow
	// first; the filename (.label) only begins to ellipsize once the dirname
	// has fully collapsed to 0. The two row kinds were briefly split during
	// rollout (commit-file rows kept their legacy 60% label cap) but a
	// follow-up unified them. The 60% cap is explicitly guarded as REMOVED
	// below so a future merge can't reintroduce the asymmetric behavior.
	//
	// Why both labels CAN shrink (flex: 0 1 auto, not 0 0 auto): when even a
	// fully-collapsed dirname can't make the row fit — e.g. a very long
	// *.integration.test.ts in the Changes panel with the hover-only discard
	// icon visible — the filename overflows the row visibly. Allowing the
	// label to shrink at low priority (flex-shrink:1 vs desc's 9999) makes
	// the filename ellipsize as a last resort instead of leaking out.

	it("changes-row filename shrinks at LOW priority (flex:0 1 auto + ellipsis)", () => {
		const css = buildSidebarCss();
		expect(css).toMatch(
			/\.tree-node\.tree-node--changes\s+\.label[^{]*{[^}]*flex:\s*0\s+1\s+auto/,
		);
		expect(css).toMatch(
			/\.tree-node\.tree-node--changes\s+\.label[^{]*{[^}]*max-width:\s*none/,
		);
		expect(css).toMatch(
			/\.tree-node\.tree-node--changes\s+\.label[^{]*{[^}]*text-overflow:\s*ellipsis/,
		);
	});

	it("commit-file row filename gets the same low-priority shrink (no 60% cap)", () => {
		// Pinned because this rule was previously asymmetric — commit-file
		// rows used to cap the label at 60% so the dirname could sit
		// alongside it. The flip removes that cap. Regressing back to the
		// 60% cap would silently revert the unified UX.
		const css = buildSidebarCss();
		expect(css).toMatch(
			/\.tree-node\[data-context="commitFile"\][^{]*{[^}]*flex:\s*0\s+1\s+auto/,
		);
		expect(css).toMatch(
			/\.tree-node\[data-context="commitFile"\][^{]*{[^}]*max-width:\s*none/,
		);
		// Negative assertion: the legacy 60% cap must not reappear anywhere
		// scoped to commit-file rows.
		expect(css).not.toMatch(
			/\.tree-node\[data-context="commitFile"\][^{]*{[^}]*max-width:\s*60%/,
		);
	});

	it("dirname desc shrinks at HIGH priority (flex-shrink: 9999, with ellipsis)", () => {
		// The 9999 vs 1 ratio is what enforces the priority — desc absorbs
		// ~all overflow before the label gives up a single pixel. min-width:0
		// is load-bearing: flex items default to min-width:auto (content-
		// based), which would prevent text-overflow:ellipsis from ever firing.
		// Both selectors must satisfy the rule — they're combined in source.
		const css = buildSidebarCss();
		for (const selector of [
			'\\.tree-node\\[data-context="commitFile"\\]\\s+\\.desc',
			"\\.tree-node\\.tree-node--changes\\s+\\.desc",
		]) {
			expect(css).toMatch(
				new RegExp(`${selector}[^{]*{[^}]*flex:\\s*0\\s+9999\\s+auto`),
			);
			expect(css).toMatch(new RegExp(`${selector}[^{]*{[^}]*min-width:\\s*0`));
			expect(css).toMatch(
				new RegExp(`${selector}[^{]*{[^}]*text-overflow:\\s*ellipsis`),
			);
		}
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

describe("onboarding panel styles", () => {
	it("declares the onboarding-panel and card classes", () => {
		const css = buildSidebarCss();
		expect(css).toMatch(/\.onboarding-panel\b/);
		expect(css).toMatch(/\.ob-card\b/);
		expect(css).toMatch(/\.ob-card--recommended\b/);
	});

	it("declares the RECOMMENDED badge", () => {
		const css = buildSidebarCss();
		expect(css).toMatch(/\.ob-badge\b/);
	});

	it("declares primary and secondary onboarding buttons", () => {
		const css = buildSidebarCss();
		expect(css).toMatch(/\.ob-btn--primary\b/);
		expect(css).toMatch(/\.ob-btn--secondary\b/);
	});

	it("uses VSCode theme tokens (focusBorder, button-background)", () => {
		const css = buildSidebarCss();
		// The recommended outline + RECOMMENDED badge accent colour come from
		// --vscode-focusBorder so they adapt to Light / Dark / High-Contrast
		// themes without hard-coded hex values.
		expect(css).toContain("var(--vscode-focusBorder)");
		expect(css).toContain("var(--vscode-button-background)");
	});

	it("renders the OR divider with flex-1 lines on either side", () => {
		const css = buildSidebarCss();
		expect(css).toMatch(/\.ob-or\b/);
		expect(css).toMatch(/\.ob-or::before/);
		expect(css).toMatch(/\.ob-or::after/);
	});

	it("declares a .loading-panel rule for the first-paint placeholder", () => {
		const css = buildSidebarCss();
		// The loading panel sits between webview-load and the host's first
		// `init` message. Without dedicated centering styles it would
		// render as a top-left codicon — this rule is what makes it look
		// like a proper "Loading…" placeholder during reload.
		expect(css).toMatch(/\.loading-panel\b/);
		expect(css).toContain("var(--vscode-descriptionForeground)");
	});

	it("shares the onboarding-panel container rule with .disabled-panel and .apikey-panel", () => {
		const css = buildSidebarCss();
		// All three full-viewport configured===false views (onboarding cards,
		// apikey input, and disabled CTA) reuse the same container rule
		// (padding/scroll/height) by way of a multi-selector rule rather
		// than redeclaring the same declarations. This keeps tweaks to
		// onboarding spacing in lockstep across every sibling panel.
		expect(css).toMatch(
			/\.onboarding-panel\s*,\s*\.disabled-panel\s*,\s*\.apikey-panel\s*\{/,
		);
	});

	it("declares apikey-panel-specific styles for input + inline error", () => {
		const css = buildSidebarCss();
		// The inline API key entry has three custom pieces beyond the shared
		// container: the label (.apikey-label), the password input
		// (.apikey-input), and the inline error span (.apikey-error). The
		// input is themed via --vscode-input-* so it matches Settings + the
		// rest of the host UI.
		expect(css).toMatch(/\.apikey-label\b/);
		expect(css).toMatch(/\.apikey-input\b/);
		expect(css).toMatch(/\.apikey-error\b/);
		expect(css).toContain("var(--vscode-input-background)");
		expect(css).toContain("var(--vscode-errorForeground)");
	});

	it("disables the .ob-btn:disabled state so the Save button has visible affordance when empty", () => {
		const css = buildSidebarCss();
		// The apikey-panel Save button starts disabled and toggles based on
		// input value. Without the :disabled rule it'd look identical to the
		// active state, which would make the apikey form look broken on
		// first paint.
		expect(css).toMatch(/\.ob-btn:disabled\s*\{/);
	});

	it("caps the breadcrumb dropdown and lets the inner list scroll", () => {
		const css = buildSidebarCss();
		// The outer .dropdown-menu becomes a flex column so the search header
		// stays pinned while .dropdown-list scrolls. Without max-height the
		// long branch list overflows the viewport with no scrollbar (the
		// original bug). Without min-height:0 on the flex child, overflow on
		// .dropdown-list is silently ignored — a classic flex foot-gun.
		expect(css).toMatch(/\.dropdown-menu\s*\{[^}]*max-height:\s*50vh/);
		expect(css).toMatch(/\.dropdown-menu\s*\{[^}]*flex-direction:\s*column/);
		expect(css).toMatch(/\.dropdown-list\s*\{[^}]*overflow-y:\s*auto/);
		expect(css).toMatch(/\.dropdown-list\s*\{[^}]*min-height:\s*0/);
	});

	it("declares the breadcrumb dropdown search and empty-state classes", () => {
		const css = buildSidebarCss();
		// Search input is themed against --vscode-input-* so it matches the
		// rest of the host UI. The empty-state row is the "No matches" line
		// the script shows when the filter clears every row.
		expect(css).toContain(".dropdown-search");
		expect(css).toContain(".dropdown-empty");
		expect(css).toContain("var(--vscode-input-background)");
	});

	describe("CONVERSATIONS source badge", () => {
		it("declares an outline-pill .badge on conversation rows", () => {
			// The badge column on each conversation row uses an outline pill
			// (border + same-hue text + half-transparent fill) instead of the
			// solid --vscode-badge-background chip, so per-source brand colors
			// can override fg/bg/border without fighting a solid backdrop.
			const css = buildSidebarCss();
			expect(css).toMatch(
				/\.tree-node\.conversation-row\s+\.badge\s*\{[^}]*border:\s*1px solid/,
			);
			expect(css).toMatch(
				/\.tree-node\.conversation-row\s+\.badge\s*\{[^}]*background:\s*transparent/,
			);
		});

		it("declares per-source brand colors for every TranscriptSource", () => {
			// Each TranscriptSource value gets its own .transcript-source-* rule
			// with a matching color + border-color + half-transparent background.
			// If a new TranscriptSource lands in cli/src/Types.ts, this test must
			// be updated alongside it so the sidebar never falls back to the
			// neutral "unknown" outline silently.
			const css = buildSidebarCss();
			const sources = [
				"claude",
				"cursor",
				"codex",
				"gemini",
				"opencode",
				"copilot",
				"copilot-chat",
			];
			for (const source of sources) {
				const re = new RegExp(
					`\\.transcript-source-${source}\\b[^{]*\\{[^}]*color:\\s*#[0-9a-f]{3,6}[^}]*border-color:`,
					"i",
				);
				expect(css).toMatch(re);
			}
		});

		it("brand-color rules out-specify the neutral .badge fallback", () => {
			// Regression guard: the neutral '.tree-node.conversation-row .badge'
			// rule has specificity 0,3,0. A bare '.transcript-source-X' rule
			// (0,1,0) loses the cascade and the badge stays gray. Every brand
			// rule must include the conversation-row + badge prefix so it
			// reaches 0,4,0 and actually paints.
			const css = buildSidebarCss();
			const sources = [
				"claude",
				"cursor",
				"codex",
				"gemini",
				"opencode",
				"copilot",
				"copilot-chat",
			];
			for (const source of sources) {
				const re = new RegExp(
					`\\.tree-node\\.conversation-row\\s+\\.badge\\.transcript-source-${source}\\b`,
				);
				expect(css).toMatch(re);
			}
		});
	});
});

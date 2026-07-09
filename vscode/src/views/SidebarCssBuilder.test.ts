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

	it("styles the per-repo knowledge-graph button (hover-revealed, right-aligned)", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".repo-graph-btn");
		expect(css).toContain(".tree-node:hover .repo-graph-btn");
	});

	it("declares the .sidebar-root and .tab-bar classes", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".sidebar-root");
		expect(css).toContain(".tab-bar");
		// The in-header icon strip (.tab / .tab-bar-right / status-icon color
		// classes) was removed when Settings + Status moved to the native
		// title bar — only the breadcrumb lives in the header now.
		expect(css).not.toContain(".tab-bar-right");
		expect(css).not.toContain(".status-icon-ok");
	});

	it("styles the view-switch row and its view-tab buttons", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".view-switch");
		expect(css).toContain(".view-tab");
		expect(css).toContain(".view-tab.active");
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

	it("declares the small iconbtn variant used by Plans & Notes inline actions", () => {
		// Plans & Notes rows carry two trailing buttons (edit + remove); the
		// --sm variant keeps them lighter than the default 24x22/14px iconbtn
		// (the Memories rows' View Memory eye keeps the default size).
		const css = buildSidebarCss();
		expect(css).toMatch(/\.iconbtn--sm\s*{[^}]*width:\s*20px/);
		expect(css).toMatch(/\.iconbtn--sm\s*{[^}]*height:\s*18px/);
		expect(css).toMatch(/\.iconbtn--sm\s*{[^}]*font-size:\s*12px/);
		// The glyph override is the part that actually shrinks the icon:
		// codicon.css pins font: 16px on .codicon[class*='codicon-'] with
		// higher specificity, so the button-level font-size alone never
		// reaches the glyph.
		expect(css).toMatch(/\.iconbtn--sm\s+\.codicon\s*{[^}]*font-size:\s*12px/);
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

	it("styles Timeline time-group labels", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".tl-group-label");
	});

	it("styles the repo filter and scopes it to the Memory Bank view", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".repo-filter");
	});

	it("defines conversation source-icon and usage-note styles", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".icon.conv-source-icon");
		expect(css).toContain(".conv-source-svg");
		expect(css).toContain(".usage-note");
	});

	it("defines the blocking-summary AI pill and Summarizing row styles", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".section-ai-pill");
		expect(css).toContain(".section-ai-dot");
		expect(css).toContain("@keyframes jm-ai-pulse");
		expect(css).toContain(".tree-node.summarizing-row");
	});

	it("defines the compact build pill for the Memory Bank ingest phase", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".section-build-pill");
		expect(css).toContain(".section-build-spin");
		// The retired inline worker-status text style is gone (replaced by the pill).
		expect(css).not.toContain(".section-worker-status");
	});
});

describe("hover-reveal actions use visibility (no reflow)", () => {
	// History: an earlier display-toggle attempt on .section-actions caused
	// header-height flicker on mouse-enter because display:none collapses the
	// slot. The fix across the sidebar is to use visibility:hidden ↔
	// visibility:visible (never display) so revealing the actions never shifts
	// layout. .memory-row + .tree-node--changes rows keep that hover model (the
	// reserved slot is acceptable on a row). Section-HEADER actions, by contrast,
	// are now ALWAYS visible (in-flow, margin-left:auto) — Context's +, Committed
	// Memories' squash/push/refresh stay discoverable without a hover — so the
	// no-reflow concern doesn't apply to them (nothing toggles).
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

	it("keeps section-header .section-actions always visible (no hover gate)", () => {
		const css = buildSidebarCss();
		// Always-visible: never hidden via visibility, never revealed on hover.
		expect(css).not.toMatch(/\.section-actions\s*{[^}]*visibility:\s*hidden/);
		expect(css).not.toMatch(/\.section-header:hover\s+\.section-actions/);
		expect(css).not.toMatch(/\.memory-group-header:hover\s+\.section-actions/);
		// In-flow, right-pinned via margin-left:auto.
		expect(css).toMatch(
			/\.collapsible-section\s+\.section-actions\s*{[^}]*margin-left:\s*auto/,
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
		// Only commit-file rows still inline the dirname as .desc; changes rows
		// now stack it as .change-dir (see the stacked-dir test below).
		const css = buildSidebarCss();
		const selector = '\\.tree-node\\[data-context="commitFile"\\]\\s+\\.desc';
		expect(css).toMatch(new RegExp(`${selector}[^{]*{[^}]*flex:\\s*0\\s+9999\\s+auto`));
		expect(css).toMatch(new RegExp(`${selector}[^{]*{[^}]*min-width:\\s*0`));
		expect(css).toMatch(new RegExp(`${selector}[^{]*{[^}]*text-overflow:\\s*ellipsis`));
	});

	it("changes rows stack the directory under the filename (.change-text column + .change-dir)", () => {
		const css = buildSidebarCss();
		expect(css).toMatch(/\.tree-node\.tree-node--changes\s+\.change-text[^{]*{[^}]*flex-direction:\s*column/);
		expect(css).toMatch(/\.tree-node\.tree-node--changes\s+\.change-dir[^{]*{[^}]*text-overflow:\s*ellipsis/);
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
		// Sticky-error variant for sync terminal failures.
		expect(css).toContain(".toolbar-worker-icon-error");
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
		// The three full-viewport panels (onboarding cards, apikey input, disabled
		// CTA) reuse the same container rule (padding/scroll/height) via a
		// multi-selector rule rather than redeclaring the same declarations.
		expect(css).toMatch(/\.onboarding-panel\s*,\s*\.disabled-panel\s*,\s*\.apikey-panel\s*\{/);
	});

	it("styles .backfill-panel as an in-flow bordered card (not a full-viewport panel)", () => {
		const css = buildSidebarCss();
		// The cold-start card is a bordered card at the top of the Branch tab
		// (mockup .setup-card), NOT a full-viewport panel — it must have its own
		// border/radius rule and must NOT be in the height:100% container group.
		expect(css).toMatch(/\.backfill-panel\s*\{[^}]*border-radius/);
		expect(css).not.toMatch(/\.apikey-panel\s*,\s*\.backfill-panel/);
		// The ✓ note and 🔒 footer sit under top-border dividers (mockup sf-auto/sf-honest).
		expect(css).toMatch(/\.bf-note\s*\{[^}]*border-top/);
		expect(css).toMatch(/\.bf-honest\s*\{[^}]*border-top/);
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

		// The committed-memory conversation evidence row now shares the live rows'
		// per-source brand glyph (.conv-source-icon / .conv-source-svg) plus a
		// trailing "N msgs" count (.memory-evidence-row .msgs). The old generic
		// per-source comment tint (.mem-conv-icon.src-*) is retired.
		it("declares the shared brand-glyph styles + the trailing msg-count style", () => {
			const css = buildSidebarCss();
			expect(css).toMatch(/\.memory-evidence-row\s+\.msgs\s*\{[^}]*margin-left:\s*auto/);
			expect(css).toMatch(/\.conv-source-svg\s*\{[^}]*width:\s*16px/);
			// The retired per-source comment tint is gone.
			expect(css).not.toMatch(/\.mem-conv-icon/);
			// The retired source pill base rule is gone from the evidence row.
			expect(css).not.toMatch(/\.memory-evidence-row\s+\.badge\s*\{/);
		});

		// Context evidence badges: colored square letter chips replacing the old
		// monochrome codicons (P plan / N note / L linear / J jira / G github / N notion).
		it("declares the context letter-badge base + per-kind hues", () => {
			const css = buildSidebarCss();
			expect(css).toMatch(/\.mem-ctx-badge\s*\{[^}]*border-radius/);
			for (const kind of ["plan", "note", "linear", "jira", "github", "notion", "reference"]) {
				expect(css).toMatch(new RegExp(`\\.mem-ctx-badge--${kind}\\b[^{]*\\{[^}]*background:`));
			}
		});

		// File evidence rows: two-line filename (git-status tinted) over muted dir,
		// with the trailing status letter pinned right.
		it("declares the stacked file-row layout + trailing status letter", () => {
			const css = buildSidebarCss();
			expect(css).toMatch(/\.memory-evidence-file\s+\.mef-text\s*\{[^}]*flex-direction:\s*column/);
			expect(css).toMatch(/\.memory-evidence-file\s+\.mef-dir\s*\{[^}]*var\(--vscode-descriptionForeground\)/);
			expect(css).toMatch(/\.memory-evidence-row\s+\.gs-letter\s*\{[^}]*margin-left:\s*auto/);
		});
	});

	// BUG 4: the "Show/Hide memory details" affordance shipped with no CSS at
	// all and rendered as bare unstyled text. It must read as a muted dotted-
	// underline disclosure link that lifts to the link hue on hover.
	describe(".commit-memory-details-toggle — Show/Hide memory details affordance", () => {
		it("styles the toggle as a quiet inline expander with a chevron and hover hue", () => {
			const css = buildSidebarCss();
			expect(css).toMatch(
				/\.commit-memory-details-toggle\s*\{[^}]*cursor:\s*pointer[^}]*\}/,
			);
			// Mockup .mem-evd look: inline-flex with a trailing chevron, no underline.
			expect(css).toMatch(
				/\.commit-memory-details-toggle\s*\{[^}]*display:\s*inline-flex/,
			);
			expect(css).toContain(".memory-details-chevron");
			expect(css).toMatch(
				/\.commit-memory-details-toggle:hover\s*\{[^}]*color:\s*var\(--vscode-textLink-foreground\)/,
			);
		});
	});

	// Same class of bug as BUG 4: the reference hover-card's source badge shipped
	// as a bare unstyled letter glued to the title ("SConsolidate…"). The card now
	// reuses the shared context-row chip (.mem-ctx-badge, per-source brand hue) so
	// it matches the sidebar context rows; .hc-title stays a plain block, so the
	// only card-scoped tweak is spacing/alignment of the inline chip.
	describe(".mem-ctx-badge inside the reference hover-card title", () => {
		it("nudges the reused context chip with spacing + inline alignment", () => {
			const css = buildSidebarCss();
			expect(css).toMatch(
				/\.hover-card\s+\.hc-title\s+\.mem-ctx-badge\s*\{[^}]*margin-right/,
			);
			expect(css).toMatch(
				/\.hover-card\s+\.hc-title\s+\.mem-ctx-badge\s*\{[^}]*vertical-align/,
			);
		});
	});

	describe(".edited-icon — applies to both conversation rows and KB folder file rows", () => {
		it("declares the visual block under both scopes with the same color token", () => {
			// The KB folders tree renders the same codicon-edit ✎ glyph that
			// conversation rows do, with the same color token, so a user who
			// recognizes one indicator recognizes both. We DON'T relax to a
			// bare '.edited-icon' selector because conversation rows carry an
			// extra +4px margin grouping (see .conversation-row .badge group
			// above) that KB tree rows should not inherit.
			const css = buildSidebarCss();
			expect(css).toMatch(
				/\.tree-node\.conversation-row\s+\.edited-icon\s*\{[^}]*color:\s*var\(--vscode-gitDecoration-modifiedResourceForeground/,
			);
			expect(css).toMatch(
				/\.tree-node\[data-kind="file"\]\s+\.edited-icon\s*\{[^}]*color:\s*var\(--vscode-gitDecoration-modifiedResourceForeground/,
			);
		});
	});

	it("styles the Current Memory group and its sub-sections", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".memory-group");
		expect(css).toContain(".subsection");
		// Each sub-section body reserves a ~4-row minimum height so the blocks
		// keep a stable rhythm and don't collapse when sparse/empty. Pinned and
		// Committed Memories (top-level sections) share the same floor.
		expect(css).toMatch(/\.subsection\s+\.section-body\s*,/);
		expect(css).toMatch(
			/\.collapsible-section\[data-section="pinned"\]\s*>\s*\.section-body\s*,/,
		);
		expect(css).toMatch(
			/\.collapsible-section\[data-section="commits"\]\s*>\s*\.section-body\s*{[^}]*min-height:\s*88px/,
		);
		// Pinned rows are top-level .tree-node (no .subsection class), so they must
		// re-derive the sub-section alignment explicitly: pull the row in to 14px
		// and drop the dead .twirl placeholder, so the pinned leading icon column
		// lines up with the Conversations / Context / Files rows below instead of
		// sitting ~10px further right.
		expect(css).toMatch(
			/\.collapsible-section\[data-section="pinned"\]\s*>\s*\.section-body\s+\.tree-node\s*{[^}]*padding-left:\s*14px/,
		);
		expect(css).toMatch(
			/\.collapsible-section\[data-section="pinned"\]\s*>\s*\.section-body\s+\.tree-node\s*>\s*\.twirl\s*{[^}]*display:\s*none/,
		);
	});

	it("styles the Current Branch command-bar footer (absolute, fixed height)", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".branch-footer");
		// Absolutely positioned + fixed height, pinned to the sidebar bottom.
		expect(css).toMatch(/\.branch-footer\s*{[^}]*position:\s*absolute/);
		expect(css).toMatch(/\.branch-footer\s*{[^}]*bottom:\s*0/);
		expect(css).toMatch(/\.branch-footer\s*{[^}]*height:\s*44px/);
		// Action buttons stretch to share the bar width (scale with the sidebar);
		// the overflow (...) button hugs its glyph instead.
		expect(css).toMatch(/\.branch-footer\s+\.cmd-btn\s*{[^}]*flex:\s*1/);
		expect(css).toMatch(/\.branch-footer\s+\.cmd-btn\.aa-more\s*{[^}]*flex:\s*0 0 auto/);
		// Containing block + content clearance for the overlaid bar.
		expect(css).toMatch(/\.sidebar-root\s*{[^}]*position:\s*relative/);
		expect(css).toMatch(/#tab-content-branch\s*{[^}]*padding-bottom/);
	});

	it("defines commit-review-bar style", () => {
		expect(buildSidebarCss()).toContain(".commit-review-bar");
	});

	it("drops the old inline committed-memory cloud-sync chip styles", () => {
		// The always-visible inline sync pill was removed from the commit row, so
		// its dedicated classes are gone. Sync state now lives only in the expanded
		// SHIPPED group, styled by .ship-badge--synced (asserted below).
		const css = buildSidebarCss();
		expect(css).not.toContain(".mem-chips");
		expect(css).not.toContain(".cloud-chip");
	});

	it("defines the strikethrough-exclude affordance styles", () => {
		const css = buildSidebarCss();
		// The ✕/+ toggle and the struck-through excluded row.
		expect(css).toContain(".row-excl");
		expect(css).toContain(".excluded");
		// The raw include checkbox is hidden on rows that carry the toggle, so
		// it can act purely as a hidden state-holder.
		expect(css).toContain(".row-excl");
		expect(css).toMatch(/:has\(\s*\.row-excl\s*\)/);
	});

	it("aligns expanded memory evidence to the mockup (whitespace-separated groups + bottom collapse)", () => {
		const css = buildSidebarCss();
		// Groups (Conversations / Context / Files) are separated by whitespace,
		// not a divider line — matching the mockup's .mem-files .mem-group.
		expect(css).toMatch(/\.memory-evidence-group:first-child\s+\.memory-evidence-group-label/);
		expect(css).not.toMatch(/\.memory-evidence-group-label\s*{[^}]*border-top/);
		expect(css).toContain(".memory-evidence-collapse");
		expect(css).toContain(".memory-details-chevron");
	});

	it("defines token-bar styles", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".token-bar");
		expect(css).toContain(".token-seg--input");
		// cached segment + legend swatch, plus the "?" help affordance row.
		expect(css).toContain(".token-seg--cached");
		// Widths are exact percentages set via el.style.width (CSP-safe property
		// write), so no bucketed width classes exist anymore.
		expect(css).not.toContain(".token-seg--w");
		expect(css).not.toContain(".token-seg--present");
		expect(css).toContain(".tk-leg--cached::before");
		expect(css).toContain(".token-bar-help");
		expect(css).toContain(".token-bar-label-row");
	});

	it("defines .mem-subline, .mem-sub-hash, and .mem-sub-sep styles", () => {
		const css = buildSidebarCss();
		// Subline container: flex row, muted color.
		expect(css).toContain(".mem-subline");
		expect(css).toMatch(/\.mem-subline\s*{[^}]*display:\s*flex/);
		expect(css).toMatch(/\.mem-subline\s*{[^}]*var\(--vscode-descriptionForeground\)/);
		// Hash: monospace font family.
		expect(css).toContain(".mem-sub-hash");
		expect(css).toMatch(/\.mem-sub-hash\s*{[^}]*font-family/);
		// Separator span.
		expect(css).toContain(".mem-sub-sep");
	});

	it("defines .ship-badge base class for SHIPPED group status chips", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".ship-badge");
	});

	it("defines .ship-badge--open (green) for the open-PR chip", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".ship-badge--open");
		// Uses a green hue (charts-green or testing-iconPassed fallback)
		expect(css).toMatch(/\.ship-badge--open\s*{[^}]*var\(--vscode-charts-green/);
	});

	it("defines .ship-badge--synced for the Synced chip (reuses cloud-synced or charts-green hue)", () => {
		const css = buildSidebarCss();
		expect(css).toContain(".ship-badge--synced");
	});
});

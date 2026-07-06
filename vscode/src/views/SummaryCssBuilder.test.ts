import { describe, expect, it, vi } from "vitest";

// ─── Mock PrCommentService ──────────────────────────────────────────────────
vi.mock("../services/PrCommentService.js", () => ({
	buildPrSectionCss: () => "/* pr-css */",
}));

import { buildCss } from "./SummaryCssBuilder.js";

describe("SummaryCssBuilder", () => {
	const css = buildCss();

	it("returns a non-empty string", () => {
		expect(css).toBeTruthy();
		expect(typeof css).toBe("string");
		expect(css.length).toBeGreaterThan(0);
	});

	it("contains light theme variables", () => {
		expect(css).toContain("body.vscode-light");
	});

	it("contains dark theme variables", () => {
		expect(css).toContain("body.vscode-dark");
	});

	it("contains high contrast theme variables", () => {
		expect(css).toContain("vscode-high-contrast");
	});

	it("contains expected CSS class names", () => {
		expect(css).toContain(".toggle");
		expect(css).toContain(".callout");
		expect(css).toContain(".page");
		expect(css).toContain(".mem-details");
		expect(css).toContain(".md-row");
		expect(css).toContain(".hash");
		expect(css).toContain(".pill");
		expect(css).toContain(".separator");
	});

	it("lets the [hidden] attribute actually hide a filtered collaborator row (display:flex must not override it)", () => {
		const css = buildCss();
		expect(css).toContain(".share-collab-row[hidden]");
	});

	it("Export button gets a plain .meta-export rule with no split-toggle !important overrides", () => {
		// Regression: .meta-export previously stacked with the two-button
		// split-toggle skeleton (border-radius/padding/font-size all
		// !important), which silently crushed the single Export button.
		// That skeleton (.split-btn-group / .split-toggle) must be gone.
		expect(css).not.toContain(".split-btn-group");
		expect(css).not.toContain(".split-toggle");
		expect(css).toContain(".export-menu-group");
		expect(css).toContain(".meta-strip .action-btn.meta-export");
	});

	it("styles the meta-strip Share/Export as the mockup's borderless secondary buttons with icon gap", () => {
		// Mockup `.btn.secondary`: inline-flex + gap for the leading icon,
		// borderless, semibold, 6px radius — not the bordered text-only look.
		const rule = css.slice(css.indexOf(".meta-strip .action-btn.meta-share"));
		expect(rule).toMatch(/display:\s*inline-flex/);
		expect(rule).toMatch(/gap:\s*6px/);
		expect(rule).toMatch(/border:\s*none/);
		expect(rule).toMatch(/font-weight:\s*600/);
		// Share's inline SVG and Export's codicons are sized to the compact button.
		expect(css).toContain(".meta-strip .action-btn .sico");
		expect(css).toContain(".meta-strip .action-btn .codicon");
	});

	it("contains the PR section CSS from buildPrSectionCss()", () => {
		expect(css).toContain("/* pr-css */");
	});

	// ─── Token meter (.tmeter) ─────────────────────────────────────────────
	describe("token meter", () => {
		it("contains the .tmeter shell, na state, head, and bar classes", () => {
			expect(css).toContain(".tmeter {");
			expect(css).toContain(".tmeter.na");
			expect(css).toContain(".tmeter-head");
			expect(css).toContain(".tmeter-bar");
		});

		it("contains the three segment classes and legend/dot classes", () => {
			expect(css).toContain(".seg-in");
			expect(css).toContain(".seg-out");
			expect(css).toContain(".seg-cache");
			expect(css).toContain(".tmeter-legend");
			expect(css).toContain(".lg-dot");
		});

		it("contains the help popover classes, hidden until pinned", () => {
			expect(css).toContain(".tok-help-wrap");
			expect(css).toContain(".tok-help");
			expect(css).toContain(".tok-pop");
			expect(css).toMatch(/\.tok-help-wrap\.pinned\s+\.tok-pop\s*\{[^}]*display:\s*block/);
		});

		it("segments have no inline width — widths must be set via data-pct in script", () => {
			expect(css).not.toMatch(/\.seg-in\s*\{[^}]*width:\s*\d/);
		});
	});

	it("contains callout variable definitions", () => {
		expect(css).toContain("--callout-trigger-bg");
		expect(css).toContain("--callout-response-bg");
		expect(css).toContain("--callout-decisions-bg");
		expect(css).toContain("--callout-todo-bg");
		expect(css).toContain("--callout-detail-bg");
		expect(css).toContain("--callout-detail-label");
	});

	// ─── Foreign-repo read-only mode ──────────────────────────────────────
	// SummaryHtmlBuilder marks .page with `foreign-readonly` when the loaded
	// summary belongs to a non-current repo. The CSS below hides every
	// destructive control. PR section is NOT hidden — checkPrStatus is
	// reachable in foreign mode via gh `--repo <remoteUrl>` so the panel
	// still surfaces the foreign repo's PR (read-only).
	describe("foreign-readonly mode", () => {
		it("hides every non-whitelisted button under .page.foreign-readonly", () => {
			expect(css).toMatch(
				/\.page\.foreign-readonly\s+button:not\(\[data-foreign-safe\]\)\s*\{[^}]*display:\s*none/,
			);
		});
	});
});

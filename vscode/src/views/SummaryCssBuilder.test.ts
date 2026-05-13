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
		expect(css).toContain(".properties");
		expect(css).toContain(".prop-row");
		expect(css).toContain(".hash");
		expect(css).toContain(".pill");
		expect(css).toContain(".separator");
	});

	it("contains the PR section CSS from buildPrSectionCss()", () => {
		expect(css).toContain("/* pr-css */");
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

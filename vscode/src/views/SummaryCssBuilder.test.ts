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
});

import { describe, expect, it } from "vitest";
import { buildSettingsCss } from "./SettingsCssBuilder.js";

describe("SettingsCssBuilder", () => {
	const css = buildSettingsCss();

	it("returns a non-empty string", () => {
		expect(css).toBeTruthy();
		expect(typeof css).toBe("string");
		expect(css.length).toBeGreaterThan(0);
	});

	it("contains VS Code theme variables for inputs", () => {
		expect(css).toContain("--vscode-input-background");
		expect(css).toContain("--vscode-input-foreground");
		expect(css).toContain("--vscode-input-border");
	});

	it("contains VS Code button variables", () => {
		expect(css).toContain("--vscode-button-background");
		expect(css).toContain("--vscode-button-foreground");
	});

	it("contains form layout classes", () => {
		expect(css).toContain(".settings-page");
		expect(css).toContain(".tab-panel");
		expect(css).toContain(".settings-row");
		expect(css).toContain(".settings-label");
	});

	it("contains tab navigation styles", () => {
		expect(css).toContain(".tab-nav");
		expect(css).toContain(".tab-button");
		expect(css).toContain(".tab-active");
	});

	it("contains a global .hidden display switch", () => {
		// The webview's tab/card show-hide convention relies on this single
		// class winning over any other display:* on the same element. Per
		// CLAUDE.md memory: "vscode webview 用 .hidden class 切显隐".
		expect(css).toMatch(/\.hidden\s*\{\s*display\s*:\s*none\s*!important/);
	});

	it("contains card-panel styles for provider/sync state cards", () => {
		expect(css).toContain(".card-panel");
	});

	it("contains status indicator styles", () => {
		expect(css).toContain(".status-ok");
		expect(css).toContain(".status-warn");
	});

	it("contains toggle switch styles", () => {
		expect(css).toContain(".toggle-switch");
	});

	// Regression: long hints (e.g. Copilot's) used to push the toggle out
	// of the right edge because `.settings-label` is `flex-shrink: 0` and
	// nothing else in `.toggle-row` flex-grew, so the label was sized to
	// max-content (the hint on one line). The fix lets the label flex into
	// available space inside toggle rows so the hint wraps.
	it("lets toggle-row labels flex so long hints wrap instead of pushing the toggle out", () => {
		// `.toggle-row .settings-label { flex: 1; min-width: 0; ... }`
		expect(css).toMatch(
			/\.toggle-row\s+\.settings-label\s*\{[^}]*\bflex\s*:\s*1\b[^}]*\bmin-width\s*:\s*0\b/s,
		);
		// `.toggle-row` declares a gap so the now-flex-grown label keeps
		// breathing room between itself and the toggle.
		expect(css).toMatch(/\.toggle-row\s*\{[^}]*\bgap\s*:\s*\d/s);
	});

	it("contains validation error styles", () => {
		expect(css).toContain(".error");
		expect(css).toContain(".error-message");
	});

	it("contains action bar styles", () => {
		expect(css).toContain(".action-bar");
	});

	it("gives .browse-btn a disabled style (e.g. Generate Missing Summaries with 0 missing)", () => {
		// The button's `disabled` attr is set when the missing count is 0; without
		// a :disabled rule it looked fully clickable. It must dim + show not-allowed.
		expect(css).toMatch(/\.browse-btn:disabled\s*\{[^}]*cursor\s*:\s*not-allowed/s);
	});
});

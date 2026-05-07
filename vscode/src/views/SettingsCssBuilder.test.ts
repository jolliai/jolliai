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
		expect(css).toContain(".settings-group");
		expect(css).toContain(".settings-row");
		expect(css).toContain(".settings-label");
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
});

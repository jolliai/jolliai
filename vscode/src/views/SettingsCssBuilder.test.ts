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

	it("contains validation error styles", () => {
		expect(css).toContain(".error");
		expect(css).toContain(".error-message");
	});

	it("contains action bar styles", () => {
		expect(css).toContain(".action-bar");
	});
});

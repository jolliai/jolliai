import { describe, expect, it } from "vitest";
import { buildSettingsScript } from "./SettingsScriptBuilder.js";

describe("SettingsScriptBuilder", () => {
	const script = buildSettingsScript();

	it("returns a non-empty string", () => {
		expect(script).toBeTruthy();
		expect(typeof script).toBe("string");
		expect(script.length).toBeGreaterThan(0);
	});

	it("acquires the VS Code API", () => {
		expect(script).toContain("acquireVsCodeApi()");
	});

	it("contains loadSettings message handler", () => {
		expect(script).toContain("loadSettings");
	});

	it("contains applySettings message handler", () => {
		expect(script).toContain("applySettings");
	});

	it("contains settingsLoaded handler", () => {
		expect(script).toContain("settingsLoaded");
	});

	it("contains settingsSaved handler", () => {
		expect(script).toContain("settingsSaved");
	});

	it("does not contain scope switching logic", () => {
		expect(script).not.toContain("scopeSelect");
		expect(script).not.toContain("currentScope");
		expect(script).not.toContain("initialScope");
	});

	it("contains validation logic for API key prefixes", () => {
		expect(script).toContain("sk-ant-");
		expect(script).toContain("sk-jol-");
	});

	it("includes all Jolli hosts in the allowlist", () => {
		expect(script).toContain("'jolli.ai'");
		expect(script).toContain("'jolli.dev'");
		expect(script).toContain("'jolli.cloud'");
		expect(script).toContain("'jolli-local.me'");
	});

	it("contains dirty tracking logic", () => {
		expect(script).toContain("isDirty");
	});

	it("contains masking detection logic", () => {
		expect(script).toContain("maskedApiKey");
		expect(script).toContain("maskedJolliApiKey");
	});

	it("validates at least one integration must be enabled", () => {
		expect(script).toContain("integrations-error");
		expect(script).toContain("At least one integration must be enabled");
		expect(script).toContain("openCodeEnabled");
	});
});

import { describe, expect, it, vi } from "vitest";

vi.mock("./SettingsCssBuilder.js", () => ({
	buildSettingsCss: () => "/* settings-css */",
}));
vi.mock("./SettingsScriptBuilder.js", () => ({
	buildSettingsScript: () => "/* settings-script */",
}));

import { buildSettingsHtml } from "./SettingsHtmlBuilder.js";

describe("SettingsHtmlBuilder", () => {
	const html = buildSettingsHtml("test-nonce");

	it("returns valid HTML with doctype", () => {
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("</html>");
	});

	it("includes CSP meta with nonce", () => {
		expect(html).toContain("nonce-test-nonce");
	});

	it("includes CSS from builder", () => {
		expect(html).toContain("/* settings-css */");
	});

	it("includes script from builder", () => {
		expect(html).toContain("/* settings-script */");
	});

	it("does not contain scope dropdown", () => {
		expect(html).not.toContain('id="scope"');
	});

	it("contains config file path hint near API key", () => {
		expect(html).toContain("Stored in ~/.jolli/jollimemory/config.json");
	});

	it("contains AI Configuration group", () => {
		expect(html).toContain("AI Configuration");
		expect(html).toContain('id="apiKey"');
		expect(html).toContain('id="model"');
		expect(html).toContain('id="maxTokens"');
	});

	it("contains model dropdown options", () => {
		expect(html).toContain('value="haiku"');
		expect(html).toContain('value="sonnet"');
		expect(html).toContain('value="opus"');
	});

	it("contains Integrations group", () => {
		expect(html).toContain("Integrations");
		expect(html).toContain('id="jolliApiKey"');
		expect(html).toContain('id="claudeEnabled"');
		expect(html).toContain('id="codexEnabled"');
		expect(html).toContain('id="geminiEnabled"');
	});

	it("contains Files group with exclude patterns", () => {
		expect(html).toContain("Files");
		expect(html).toContain('id="excludePatterns"');
	});

	it("contains Apply Changes button", () => {
		expect(html).toContain("Apply Changes");
		expect(html).toContain("apply-btn");
	});

	it("contains error message containers for validated fields", () => {
		expect(html).toContain('id="apiKey-error"');
		expect(html).toContain('id="jolliApiKey-error"');
		expect(html).toContain('id="maxTokens-error"');
		expect(html).toContain('id="integrations-error"');
	});

	it("contains Local Memories section with localFolder input and Browse button", () => {
		expect(html).toContain("Local Memories");
		expect(html).toContain('id="localFolder"');
		expect(html).toContain("readonly");
		expect(html).toContain('id="browseLocalFolderBtn"');
		expect(html).toContain("Browse");
	});

	it("contains push action radio buttons", () => {
		expect(html).toContain('id="pushActionJolli"');
		expect(html).toContain('id="pushActionBoth"');
		expect(html).toContain('value="jolli"');
		expect(html).toContain('value="both"');
		expect(html).toContain("Push to Jolli only");
		expect(html).toContain("Push to Jolli &amp; Local");
	});

	it("contains Default Push Action legend", () => {
		expect(html).toContain("Default Push Action");
		expect(html).toContain('id="pushActionBothHint"');
	});
});

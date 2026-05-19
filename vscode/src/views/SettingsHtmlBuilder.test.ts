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

	// ── Tab navigation ──

	it("contains the 5 tab buttons", () => {
		expect(html).toContain('data-tab="agents"');
		expect(html).toContain('data-tab="summary"');
		expect(html).toContain('data-tab="sync"');
		expect(html).toContain('data-tab="bank"');
		expect(html).toContain('data-tab="others"');
		expect(html).toContain(">AI Agents<");
		expect(html).toContain(">AI Summary<");
		expect(html).toContain(">Sync to Jolli<");
		expect(html).toContain(">Memory Bank<");
		expect(html).toContain(">Others<");
	});

	it("contains the 5 tab panels keyed by data-panel", () => {
		expect(html).toContain('data-panel="agents"');
		expect(html).toContain('data-panel="summary"');
		expect(html).toContain('data-panel="sync"');
		expect(html).toContain('data-panel="bank"');
		expect(html).toContain('data-panel="others"');
	});

	// ── AI Agents tab ──

	it("AI Agents tab lists all six per-source toggles", () => {
		expect(html).toContain('id="claudeEnabled"');
		expect(html).toContain('id="codexEnabled"');
		expect(html).toContain('id="geminiEnabled"');
		expect(html).toContain('id="openCodeEnabled"');
		expect(html).toContain('id="cursorEnabled"');
		expect(html).toContain('id="copilotEnabled"');
	});

	it("Copilot toggle description mentions both CLI and Chat sources", () => {
		expect(html).toContain("Copilot CLI");
		expect(html).toContain("Copilot Chat");
	});

	it("AI Agents tab carries the integrations validation slot", () => {
		expect(html).toContain('id="integrations-error"');
	});

	// ── AI Summary tab ──

	it("AI Summary tab contains the Provider dropdown", () => {
		expect(html).toContain('id="aiProvider"');
		expect(html).toContain('value="anthropic"');
		expect(html).toContain('value="jolli"');
	});

	it("AI Summary tab contains the four provider cards", () => {
		expect(html).toContain('data-card="anthropic"');
		expect(html).toContain('data-card="jolli-ok"');
		expect(html).toContain('data-card="jolli-nokey"');
		expect(html).toContain('data-card="jolli-signin"');
	});

	it("Anthropic card carries API key, model, and max tokens fields", () => {
		expect(html).toContain('id="apiKey"');
		expect(html).toContain('id="model"');
		expect(html).toContain('id="maxTokens"');
		expect(html).toContain("Stored in ~/.jolli/jollimemory/config.json");
	});

	it("model dropdown has the three Claude tiers", () => {
		expect(html).toContain('value="haiku"');
		expect(html).toContain('value="sonnet"');
		expect(html).toContain('value="opus"');
	});

	it("Anthropic card has a missing-key warning slot wired to anthropicMissingWarn", () => {
		expect(html).toContain('id="anthropicMissingWarn"');
	});

	it("Jolli signed-in card has site label and Advanced toggle", () => {
		expect(html).toContain('id="jolliSiteLabel"');
		expect(html).toContain('data-advanced="summary"');
		expect(html).toContain('data-advanced-panel="summary"');
		expect(html).toContain('id="jolliApiKey"');
	});

	it("Jolli no-key card has its own API key input + re-login button", () => {
		expect(html).toContain('id="jolliApiKeyNoKey"');
		expect(html).toContain('id="summaryReLoginBtn"');
		expect(html).toContain('data-advanced="summary-nokey"');
	});

	it("Jolli signed-out card exposes a sign-in button", () => {
		expect(html).toContain('id="summarySignInBtn"');
	});

	// ── Sync to Jolli tab ──

	it("Sync tab contains signed-in / signed-out cards", () => {
		expect(html).toContain('data-sync-card="signed-in"');
		expect(html).toContain('data-sync-card="signed-out"');
		expect(html).toContain('id="syncSignInBtn"');
		expect(html).toContain('id="syncSignOutBtn"');
	});

	// ── Memory Bank tab (Sort Order intentionally absent) ──

	it("Memory Bank tab contains folder path input + Browse button", () => {
		expect(html).toContain('id="localFolder"');
		expect(html).toContain("readonly");
		expect(html).toContain('id="browseLocalFolderBtn"');
		expect(html).toContain("Browse");
	});

	it("Memory Bank tab contains the Migrate to Memory Bank button", () => {
		expect(html).toContain('id="rebuildKbBtn"');
		expect(html).toContain("Migrate to Memory Bank");
		expect(html).toContain('id="rebuildKbStatus"');
	});

	it("Memory Bank tab does NOT contain a Sort Order control", () => {
		// Intentionally omitted from this surface — IntelliJ exposes it but the
		// vscode panel shouldn't grow an extra toggle that nothing reads in
		// vscode-side code.
		expect(html).not.toMatch(/id=["']sortOrder["']/i);
		expect(html).not.toContain("Sort Order");
	});

	// ── Others tab (Pause Jolli Memory intentionally absent) ──

	it("Others tab contains the exclude patterns input", () => {
		expect(html).toContain('id="excludePatterns"');
	});

	it("Others tab does NOT contain a Pause Jolli Memory checkbox", () => {
		// Intentionally omitted — pause is an IntelliJ-only feature.
		expect(html).not.toMatch(/id=["']paused["']/i);
		expect(html).not.toContain("Pause Jolli Memory");
	});

	it("Others tab contains the DCO sign-off toggle", () => {
		expect(html).toContain('id="dcoSignoff"');
		expect(html).toContain("Sign commits with DCO");
		// Hint references the trailer added by `-s`.
		expect(html).toContain("Signed-off-by");
	});

	// ── Action bar / shared ──

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

	it("no longer contains the Default Push Action UI (removed)", () => {
		expect(html).not.toContain("Default Push Action");
		expect(html).not.toContain('id="pushActionJolli"');
		expect(html).not.toContain('id="pushActionBoth"');
		expect(html).not.toContain("Push to Jolli only");
	});
});

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

	it("AI Agents tab lists all per-source toggles", () => {
		expect(html).toContain('id="claudeEnabled"');
		expect(html).toContain('id="codexEnabled"');
		expect(html).toContain('id="geminiEnabled"');
		expect(html).toContain('id="openCodeEnabled"');
		expect(html).toContain('id="cursorEnabled"');
		expect(html).toContain('id="devinEnabled"');
		expect(html).toContain('id="copilotEnabled"');
		expect(html).toContain('id="clineEnabled"');
		expect(html).toContain('id="antigravityEnabled"');
		expect(html).toContain('id="kimiEnabled"');
	});

	it("does not render a separate Cursor CLI toggle (shares the Cursor toggle)", () => {
		expect(html).not.toContain('id="cursorCliEnabled"');
	});

	it("Cursor toggle description mentions both the Composer IDE and the cursor-agent CLI", () => {
		expect(html).toContain("Composer IDE");
		expect(html).toContain("cursor-agent CLI");
	});

	it("Cline toggle description mentions both CLI and VS Code sources", () => {
		expect(html).toContain("Cline CLI");
		expect(html).toContain("VS Code");
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

	it("renders the local-agent provider option and its card", () => {
		expect(html).toContain('value="local-agent"');
		expect(html).toContain('data-card="local-agent"');
		expect(html).toContain('id="localAgentTool"');
		expect(html).toContain('value="claude-code"');
	});

	it("agent-tool dropdown lists all local agent tools with their display labels", () => {
		expect(html).toContain('<option value="claude-code">Claude Code</option>');
		expect(html).toContain('<option value="codex">Codex</option>');
		expect(html).toContain('<option value="cursor-agent">Cursor</option>');
		expect(html).toContain('<option value="opencode">OpenCode</option>');
		expect(html).toContain('<option value="kimi">Kimi Code</option>');
	});

	it("agent-tool hint is tool-agnostic, not Claude-specific", () => {
		expect(html).not.toContain("Uses your local Claude Code login");
		expect(html).toContain("Uses your local agent's own login");
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

	it("Memory Bank tab contains the effective-state line, initially hidden", () => {
		// Starts with the `.hidden` class (never the HTML `hidden` attribute, which
		// `display: flex` silently overrides) so the row can't flash a verdict the
		// host hasn't sent yet.
		expect(html).toContain('id="memoryBankState"');
		expect(html).toContain('id="memoryBankStateText"');
		expect(html).toMatch(/class="status-off hidden" id="memoryBankState"/);
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

describe("SettingsHtmlBuilder — local-agent model picker", () => {
	const html = buildSettingsHtml("nonce123");

	it("renders the model row, hidden until a pinned tool is selected", () => {
		// Hidden in the markup rather than absent: the script toggles it as the
		// tool picker changes, and an initially-visible row would flash for the
		// unpinned tools on every panel open.
		expect(html).toContain('class="settings-row hidden" id="localAgentModelRow"');
		// `id="localAgentModelRow"` CONTAINS `id="localAgentModel"`, so asserting
		// the bare id would be satisfied by the row above and would still pass with
		// the <select> deleted. Match the tag.
		expect(html).toContain('<select id="localAgentModel">');
	});

	it("tags every model option with the tool it belongs to", () => {
		// The document is built once while the tool picker changes client-side, so
		// data-tool is what lets the script filter the shared list.
		expect(html).toMatch(/<option value="haiku" data-tool="claude-code">/);
		expect(html).toMatch(/<option value="inherit" data-tool="claude-code">/);
	});

	it("marks the default option, since the list order no longer identifies it", () => {
		// The options are ordered to match the Anthropic model picker, which puts
		// Sonnet in the MIDDLE. The row's fallback reads this attribute — picking
		// the first visible option instead would land on Haiku and quietly
		// downgrade the machine on a tool switch.
		expect(html).toMatch(/<option value="sonnet" data-tool="claude-code" data-default="true">/);
		expect(html.match(/data-default="true"/g)).toHaveLength(1);
	});

	it("renders the model options in the same order and wording as the Anthropic picker", () => {
		// Two pickers a few rows apart that name the same three model families
		// differently read as two different settings.
		const anthropic = /<select id="model">([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
		const local = /<select id="localAgentModel">([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
		const labels = (block: string) => [...block.matchAll(/>([^<]+)<\/option>/g)].map((m) => m[1].trim());
		const anthropicLabels = labels(anthropic);
		expect(anthropicLabels.length).toBe(3);
		// The local list is the Anthropic list plus the inherit escape hatch, which
		// has no Anthropic counterpart and keeps its own wording.
		expect(labels(local).slice(0, 3)).toEqual(anthropicLabels);
		expect(labels(local).at(-1)).toContain("own setting");
	});

	it("contributes no options for a tool with no pinned models", () => {
		for (const tool of ["codex", "cursor-agent", "opencode", "kimi"]) {
			expect(html).not.toContain(`data-tool="${tool}"`);
		}
	});

	it("hides every conditional block with the .hidden class, never the `hidden` attribute", () => {
		// A shipped regression this pins: the model row was given .settings-row for
		// its spacing while still using the `hidden` ATTRIBUTE. An author-stylesheet
		// `display: flex` beats the UA's `[hidden] { display: none }`, so the row
		// stayed on screen for a tool that pins no model — visually broken while
		// every fake-DOM test passed, because a fake DOM has no stylesheet to
		// resolve. Only a shape check on the markup can see it.
		expect(html).not.toMatch(/<[^>]*\shidden\s*>/);
	});

	it("escapes model labels rather than interpolating them raw", () => {
		// The labels are project constants today, but they reach the document
		// through interpolation — escaping is what keeps that true if one ever
		// grows an apostrophe or an angle bracket.
		expect(html).toContain("Use Claude Code&#39;s own setting");
		expect(html).not.toContain("Use Claude Code's own setting");
	});
});

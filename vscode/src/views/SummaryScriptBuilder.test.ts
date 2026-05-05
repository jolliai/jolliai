import { describe, expect, it, vi } from "vitest";

// ─── Mock PrCommentService ──────────────────────────────────────────────────
vi.mock("../services/PrCommentService.js", () => ({
	buildPrSectionScript: () => "/* pr-script */",
	buildPrMessageScript: () => "/* pr-msg-script */",
}));

import { buildScript } from "./SummaryScriptBuilder.js";

describe("SummaryScriptBuilder", () => {
	const script = buildScript();

	it("returns a non-empty string", () => {
		expect(script).toBeTruthy();
		expect(typeof script).toBe("string");
		expect(script.length).toBeGreaterThan(0);
	});

	it("produces parseable JavaScript (catches syntax errors at build time)", () => {
		// Try to parse the script via Function constructor — throws on syntax errors.
		// This catches issues like backticks inside template literals, unbalanced
		// braces, or stray template-literal delimiters that would otherwise only
		// surface at webview runtime.
		expect(() => new Function(script)).not.toThrow();
	});

	it("contains vscode API initialization", () => {
		expect(script).toContain("acquireVsCodeApi");
	});

	it("contains toggle expand/collapse handlers", () => {
		expect(script).toContain(".toggle-header");
		expect(script).toContain("classList.toggle");
	});

	it("toggle-header binding is idempotent and reused by E2E re-render path", () => {
		// E2E section is replaced wholesale on e2eTestUpdated / e2eScenarioUpdated;
		// new headers must get the click handler too. Guarded by a `_toggleAttached`
		// marker so both the page-level pass and attachE2eHandlers can call the
		// shared helper without double-binding.
		expect(script).toContain("function attachToggleHeader");
		expect(script).toContain("_toggleAttached");
		// The shared helper is invoked by attachE2eHandlers on its root parameter.
		// We assert the call exists inside the function body by locating it after
		// the function definition.
		const e2eHandlerStart = script.indexOf("function attachE2eHandlers");
		expect(e2eHandlerStart).toBeGreaterThan(0);
		const e2eHandlerSection = script.slice(e2eHandlerStart);
		expect(e2eHandlerSection).toContain(
			"querySelectorAll('.toggle-header').forEach(attachToggleHeader)",
		);
	});

	it("contains hash copy functionality", () => {
		expect(script).toContain(".hash-copy");
		expect(script).toContain("navigator.clipboard.writeText");
	});

	it("contains Copy Markdown button handler", () => {
		expect(script).toContain("copyMdBtn");
		expect(script).toContain("copyMarkdown");
	});

	it("contains push button handler with 'push' command", () => {
		expect(script).toContain("pushJolliBtn");
		expect(script).toContain("command: 'push'");
		// Old command name should NOT appear anywhere in the script
		expect(script).not.toContain("command: 'pushToJolli'");
	});

	it("reads pushAction from data attribute on the push button", () => {
		expect(script).toContain("pushBtn.dataset.pushAction");
	});

	it("contains combined push result handler for pushToJolliResult and pushToLocalResult", () => {
		expect(script).toContain("pushToJolliResult");
		expect(script).toContain("pushToLocalResult");
	});

	it("contains pending result tracking variables", () => {
		expect(script).toContain("pendingJolli");
		expect(script).toContain("pendingLocal");
	});

	it("contains the PR section script from buildPrSectionScript()", () => {
		expect(script).toContain("/* pr-script */");
	});

	it("contains the PR message script from buildPrMessageScript()", () => {
		expect(script).toContain("/* pr-msg-script */");
	});

	it("contains topic edit/delete handlers", () => {
		expect(script).toContain("topic-delete-btn");
		expect(script).toContain("topic-edit-btn");
		expect(script).toContain("deleteTopic");
		expect(script).toContain("enterEditMode");
	});

	it("contains E2E test handlers", () => {
		expect(script).toContain("e2eTestSection");
		// New section-level toolbar handler (Collapse-All for E2E).
		expect(script).toContain("toggleAllE2eBtn");
		// Per-scenario inline edit/delete handlers.
		expect(script).toContain("e2e-edit-btn");
		expect(script).toContain("e2e-delete-btn");
		expect(script).toContain("enterE2eEditMode");
		expect(script).toContain("editE2eScenario");
		expect(script).toContain("deleteE2eScenario");
		// Surgical per-scenario replacement message.
		expect(script).toContain("e2eScenarioUpdated");
		// Bulk-markdown-edit removed; no e2e-editing class anymore.
		expect(script).not.toContain("e2e-editing");
	});

	it("contains message event listener", () => {
		expect(script).toContain("addEventListener('message'");
	});

	it("contains note preview action handler", () => {
		expect(script).toContain("previewNote");
	});

	it("contains note translate action handler", () => {
		expect(script).toContain("translateNote");
	});

	it("contains note translate status message handlers", () => {
		expect(script).toContain("noteTranslating");
		expect(script).toContain("noteTranslateError");
		expect(script).toContain("note-translate-btn");
	});

	it("maps transcript sources to provider labels", () => {
		expect(script).toContain("function getSourceLabel");
		expect(script).toContain("source === 'opencode'");
		expect(script).toContain("return 'OpenCode'");
		expect(script).toContain("source === 'gemini'");
		expect(script).toContain("return 'Gemini'");
		expect(script).toContain("source === 'cursor'");
		expect(script).toContain("return 'Cursor'");
	});

	it("maps 'copilot' source to 'Copilot' label", () => {
		expect(script).toContain("source === 'copilot'");
		expect(script).toContain("return 'Copilot'");
	});

	it("appends 'cursor' and 'copilot' to sourceOrder", () => {
		expect(script).toContain(
			"'claude', 'codex', 'gemini', 'opencode', 'cursor', 'copilot'",
		);
	});
});

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

	it("re-enables the push button on pushToJolliResult and disables it on pushStarted", () => {
		// The Jolli-only push pathway is the only one left after the
		// pushAction/local-push removal — the script must consume the single
		// pushToJolliResult message and never branch on a `pushAction` value
		// or wait for a (now-gone) pushToLocalResult.
		expect(script).toContain("pushToJolliResult");
		expect(script).toContain("pushStarted");
		expect(script).not.toContain("pushToLocalResult");
		expect(script).not.toContain("pushAction");
		expect(script).not.toContain("pendingLocal");
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

	it("renders 'Copilot Chat' label for copilot-chat source", () => {
		expect(script).toContain("source === 'copilot-chat'");
		expect(script).toContain("return 'Copilot Chat'");
	});

	it("places copilot-chat after copilot in source ordering", () => {
		expect(script).toMatch(/'copilot',\s*'copilot-chat'/);
	});

	describe("Regenerate summary re-render wiring", () => {
		// The emitted JS runs in the webview iframe and is not unit-testable
		// at runtime in vitest. These string-contain assertions pin the
		// regenerate handlers in place so a refactor that drops them breaks
		// the build instead of silently regressing webview behavior. Each
		// matches a load-bearing line from SummaryScriptBuilder's
		// summaryRegenerated branch.

		it("emits the named handler so success-path re-binds the new #toggleAllBtn", () => {
			// Function defined and called once at page-load init.
			expect(script).toContain("function attachToggleAllBtnHandler");
			// Re-invoked from the summaryRegenerated message branch because
			// replaceSection swaps in a brand-new #toggleAllBtn element whose
			// click listener doesn't carry over from the old DOM.
			expect(script).toMatch(/summaryRegenerated[\s\S]*attachToggleAllBtnHandler\(\)/);
		});

		it("resets allCollapsed to false before re-binding so button text matches the freshly-uncollapsed topics", () => {
			expect(script).toMatch(
				/summaryRegenerated[\s\S]*allCollapsed\s*=\s*false[\s\S]*attachToggleAllBtnHandler/,
			);
		});

		it("re-attaches toggle-header handlers on the new topics root (collapse on click still works)", () => {
			expect(script).toMatch(
				/summaryRegenerated[\s\S]*\.toggle-header[\s\S]*attachToggleHeader/,
			);
		});

		it("does NOT re-attach attachRegenerateSummaryHandler in the success path (button lives outside topicsSection / recapSection)", () => {
			// The regenerate button is in the Conversations card, which
			// replaceSection never touches; re-attaching would double-bind
			// the listener and post N messages on the Nth click after N
			// regenerates.
			const summaryRegeneratedBranch = script.split("summaryRegenerated")[1] ?? "";
			const cancelBranch = summaryRegeneratedBranch.split("summaryRegenerateError")[0] ?? "";
			expect(cancelBranch).not.toContain("attachRegenerateSummaryHandler(");
		});
	});

	describe("Linear issue actions", () => {
		it("routes the 3 Linear actions through their own data-action cases", () => {
			// Each case must read the data-linear-key attribute and post a
			// message back to the host with that key. The host-side handlers
			// in SummaryWebviewPanel rely on this exact case-name spelling.
			expect(script).toContain("case 'openLinearIssue'");
			expect(script).toContain("case 'openLinearIssueMarkdown'");
			expect(script).toContain("case 'removeLinearIssue'");
		});

		it("openLinearIssue forwards both archivedKey and url so the host doesn't re-query orphan branch", () => {
			expect(script).toContain("'data-linear-url'");
			expect(script).toMatch(
				/command:\s*'openLinearIssue',\s*archivedKey:[^,]+,\s*url:/,
			);
		});

		it("removeLinearIssue forwards archivedKey + ticketId so the host can mark both registry keys ignored", () => {
			expect(script).toContain("'data-linear-ticket'");
			expect(script).toMatch(
				/command:\s*'removeLinearIssue',\s*archivedKey:[^,]+,\s*ticketId:/,
			);
		});
	});
});

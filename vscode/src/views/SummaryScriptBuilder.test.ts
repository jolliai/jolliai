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

		it("does NOT re-attach attachRegenerateSummaryDelegate in the success path (delegate bound once on .page survives banner DOM replacement)", () => {
			// The regenerate buttons (#regenerateSummaryBtn in the Conversations
			// card, #summaryErrorRegenerateBtn in the top banner) are reached
			// via an event delegate on .page bound once at script init.
			// Re-attaching in the regenerate success branch would double-bind
			// the listener and post N messages on the Nth click after N
			// regenerates.
			const summaryRegeneratedBranch = script.split("summaryRegenerated")[1] ?? "";
			const cancelBranch = summaryRegeneratedBranch.split("summaryRegenerateError")[0] ?? "";
			expect(cancelBranch).not.toContain("attachRegenerateSummaryDelegate(");
			// Defensive: assert the delegate is wired exactly once across the
			// whole script (at top-level init). A future regression that adds
			// a second call anywhere would break this. We count "call sites"
			// (call expression with trailing `;`), not the function declaration
			// (which has `() {`).
			const delegateCallMatches = script.match(/attachRegenerateSummaryDelegate\(\);/g) ?? [];
			expect(delegateCallMatches.length).toBe(1);
		});

		it("enters regenerating-readonly mode on summaryRegenerating (banner + page class)", () => {
			// CSS for .page.regenerating-readonly hides every action button via
			// the foreign-safe whitelist, and the banner explains why. The
			// previous freezeSummarySections / thawSummarySections approach
			// has been removed in favor of this single class toggle — pin
			// it so a refactor doesn't silently revert.
			expect(script).toContain("function enterRegeneratingReadonly");
			expect(script).toContain("function leaveRegeneratingReadonly");
			expect(script).toContain("regenerating-readonly");
			expect(script).toMatch(
				/summaryRegenerating[\s\S]*enterRegeneratingReadonly\(\)/,
			);
		});

		it("leaves regenerating-readonly on BOTH success and error/cancel paths", () => {
			// Either summaryRegenerated OR summaryRegenerateError must
			// restore the page chrome — otherwise the user is stuck with
			// every action button hidden until they reload.
			expect(script).toMatch(
				/summaryRegenerated[\s\S]*leaveRegeneratingReadonly\(\)/,
			);
			expect(script).toMatch(
				/summaryRegenerateError[\s\S]*leaveRegeneratingReadonly\(\)/,
			);
		});

		it("inserts a banner with the regenerating-banner-spinner element so users see a spinner", () => {
			expect(script).toContain("regenerating-banner-spinner");
			expect(script).toContain("regenerating-banner-text");
			expect(script).toContain("Regenerating summary");
		});

		it("does NOT contain the removed freeze/thaw helpers (deprecated by regenerating-readonly)", () => {
			expect(script).not.toContain("function freezeSummarySections");
			expect(script).not.toContain("function thawSummarySections");
			expect(script).not.toContain("function resetRegenerateButton");
		});
	});

	describe("Reference actions (Plan-parity, Choice A — no Linear-specific message names)", () => {
		it("routes all 7 *Reference actions through dedicated data-action cases", () => {
			// Each case must read the data-reference-* attributes and post a
			// message back to the host with that payload. The host-side
			// handlers in SummaryWebviewPanel rely on this exact case-name
			// spelling.
			expect(script).toContain("case 'previewReference'");
			expect(script).toContain("case 'openReferenceExternal'");
			expect(script).toContain("case 'translateReference'");
			expect(script).toContain("case 'loadReferenceContent'");
			expect(script).toContain("case 'saveReferenceEdit'");
			expect(script).toContain("case 'cancelReferenceEdit'");
			expect(script).toContain("case 'removeReference'");
		});

		it("drops the 3 legacy Linear-specific data-action cases (Choice A)", () => {
			// Choice A in the design: delete openLinearIssue / openLinear-
			// IssueMarkdown / removeLinearIssue entirely from the dispatch
			// layer. Linear rows go through the same *Entity actions as
			// every other source.
			expect(script).not.toContain("case 'openLinearIssue'");
			expect(script).not.toContain("case 'openLinearIssueMarkdown'");
			expect(script).not.toContain("case 'removeLinearIssue'");
		});

		it("previewEntity forwards archivedKey + source + nativeId + title so the host can dispatch by source and confirm without a re-query", () => {
			expect(script).toContain("'data-reference-key'");
			expect(script).toContain("'data-reference-source'");
			expect(script).toContain("'data-reference-native-id'");
			expect(script).toContain("'data-reference-title'");
			expect(script).toMatch(
				/command:\s*'previewReference',\s*archivedKey:[^,]+,\s*source:[^,]+,\s*nativeId:[^,]+,\s*title:/,
			);
		});

		it("openEntityExternal round-trips the URL via data-reference-url (host re-validates the http(s) scheme at the sink)", () => {
			expect(script).toContain("'data-reference-url'");
			expect(script).toMatch(
				/command:\s*'openReferenceExternal',\s*url:/,
			);
		});

		it("removeEntity forwards archivedKey + source + nativeId + title (host needs nativeId for both the dialog message and the legacy ticketId guard-key dispatch)", () => {
			expect(script).toMatch(
				/command:\s*'removeReference',\s*archivedKey:[^,]+,\s*source:[^,]+,\s*nativeId:[^,]+,\s*title:/,
			);
		});

		it("saveReferenceEdit / cancelReferenceEdit strip the per-source prefix generically (mirrors buildReferenceRow's stripSourcePrefix for all sources, not just linear)", () => {
			// buildReferenceRow's element id strips the "<source>:" prefix for
			// EVERY source, so the dispatcher must too — otherwise jira/github/
			// notion rows compute `reference-jira-jira:KEY-…` and the textarea
			// lookup misses. Guard against regressing to the linear-only form.
			expect(script).toContain("seKey.indexOf(seSource + ':')");
			expect(script).toContain("ceKey.indexOf(ceSource + ':')");
			expect(script).not.toContain("seSource === 'linear'");
			expect(script).toContain("'.plan-edit-textarea'");
		});
	});
});

import { describe, expect, it } from "vitest";

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

	it("defaults the single header Share button to commit kind (no ▾ menu)", () => {
		expect(script).toContain(`var defaultShareKind = "commit";`);
		// The branch/memory choice lives in the sidebar entries — no dropdown here.
		expect(script).not.toContain("shareDropdown");
		expect(script).not.toContain("shareThisBranchBtn");
		// No auto-open baked in by default.
		expect(script).not.toContain('shareOpen("');
	});

	it("flips the button default when the panel was entered via share-this-branch", () => {
		// Sidebar share entries thread the kind through so the button and modal
		// title stay consistent with the entry the user clicked ("Share this
		// branch" vs "Share this memory").
		const branchScript = buildScript({ defaultShareKind: "branch", autoOpenShare: true });
		expect(branchScript).toContain(`var defaultShareKind = "branch";`);
		expect(branchScript).toContain("'Share this branch as a read-only link'");
		expect(branchScript).toContain('shareOpen("branch");');
		expect(() => new Function(branchScript)).not.toThrow();
	});

	it("bakes a one-shot commit-kind shareOpen for the per-memory share entry", () => {
		const commitScript = buildScript({ defaultShareKind: "commit", autoOpenShare: true });
		expect(commitScript).toContain('shareOpen("commit");');
		expect(() => new Function(commitScript)).not.toThrow();
	});

	it("preserves the user's picked access tier across a linkless re-render (no revert to the org default)", () => {
		// Regression: selecting "people" before a link exists must not snap the dropdown
		// back to the org default (which a later Copy would mint as an org-wide link).
		// Fallback order: user's explicit pick → the branch's last-used tier (defaults,
		// seeded when an amend re-keyed the previous subject) → org/people default.
		expect(script).toContain("shareUserPickedTier = v;");
		expect(script).toContain(
			"shareUserPickedTier || (shareDefaults && shareDefaults.visibility) || (shareCanOrg ? 'org' : 'people')",
		);
		// The old unconditional revert must be gone.
		expect(script).not.toContain("shareAccessSelect.value = shareLink ? shareLink.visibility : (shareCanOrg ? 'org' : 'people')");
		expect(() => new Function(script)).not.toThrow();
	});

	it("resets the in-session picked tier on open so it can't leak into the next subject", () => {
		// Issue #5: shareUserPickedTier is per-open state; a tier picked on one subject
		// must not shadow the next subject's seeded default. shareOpen clears it.
		const openBody = script.slice(script.indexOf("function shareOpen(kind)"), script.indexOf("function shareClose()"));
		expect(openBody).toContain("shareUserPickedTier = '';");
		expect(() => new Function(script)).not.toThrow();
	});

	it("clamps a seeded 'org' tier to 'people' when the current key has no org capability", () => {
		// Issue #6: a prior share's 'org' default (or a stale picked tier) is invalid when
		// shareCanOrg is false (org <option> hidden+disabled) — seeding it would leave the
		// select on an unrepresentable tier and a later Copy would mint an org link the key
		// can't back. The clamp downgrades it to 'people'.
		expect(script).toContain("if (seededTier === 'org' && !shareCanOrg) { seededTier = 'people'; }");
		expect(() => new Function(script)).not.toThrow();
	});

	it("shows an existing link's tier verbatim — the org→people clamp is seed-only", () => {
		// A real link renders its actual visibility; clamping it would mislabel a live 'org'
		// link as 'people' if the key's org capability later lapsed. The clamp lives in the
		// no-link (seed) branch only, AFTER the real-link assignment.
		expect(script).toContain("seededTier = shareLink.visibility;");
		const clampIdx = script.indexOf("if (seededTier === 'org' && !shareCanOrg)");
		const linkTierIdx = script.indexOf("seededTier = shareLink.visibility;");
		expect(linkTierIdx).toBeGreaterThanOrEqual(0);
		expect(clampIdx).toBeGreaterThan(linkTierIdx);
		expect(() => new Function(script)).not.toThrow();
	});

	it("restores the branch's last-used people ONCE per open (staged in invite mode, nothing auto-granted)", () => {
		// A subject with no link but last-used defaults (amend re-keyed the previous
		// commit share) prefills the previous recipients as staged invitees and enters
		// invite mode — a single Send re-grants them; Cancel drops to the main pane.
		expect(script).toContain("shareDefaults = state.defaults || null;");
		expect(script).toContain("shareDefaultsPrefilled = true;");
		expect(script).toContain("shareDefaults.recipients.forEach(function(e) { shareStagePending(e); });");
		// One prefill per modal open: the flag resets when the modal opens.
		const openBody = script.slice(script.indexOf("function shareOpen(kind)"), script.indexOf("function shareClose()"));
		expect(openBody).toContain("shareDefaultsPrefilled = false;");
		expect(() => new Function(script)).not.toThrow();
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

	it("wires the Export button (#exportMenuToggle) to toggle the #exportMenu dropdown by id, not by split-button class", () => {
		expect(script).toContain("getElementById('exportMenuToggle')");
		expect(script).toContain("getElementById('exportMenu')");
		expect(script).toContain("dropdownMenu.classList.toggle('open')");
		// Wiring must key off ids, never the retired split-btn-group/split-toggle classes.
		expect(script).not.toContain("split-toggle");
		expect(script).not.toContain("split-btn-group");
	});

	it("contains push button handler with 'push' command", () => {
		expect(script).toContain("pushJolliBtn");
		expect(script).toContain("command: 'push'");
		// Old command name should NOT appear anywhere in the script
		expect(script).not.toContain("command: 'pushToJolli'");
	});

	it("push button always posts push and never branches to openJolli", () => {
		// The synced-vs-local distinction is now purely a label ("Update on
		// Jolli" vs "Push to Jolli"); the click always posts push, which
		// re-uploads the doc in place when it already exists. The old
		// data-jolli-open / openJolli open-in-browser path was removed.
		expect(script).not.toContain("data-jolli-open");
		expect(script).not.toContain("openJolli");
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

	it("defines a Cline brand glyph and aliases cline-cli to it", () => {
		expect(script).toContain("cline:");
		expect(script).toContain("SOURCE_ICON_SVG['cline-cli'] = SOURCE_ICON_SVG.cline");
	});

	it("includes both Cline sources in sourceOrder", () => {
		expect(script).toMatch(/'copilot-chat',\s*'cline',\s*'cline-cli'/);
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

	describe("partial refresh (Option B) message handlers", () => {
		it("topicsUpdated rebuilds the section: ESC cleanup, replace, re-attach, and PRESERVE per-topic collapse", () => {
			expect(script).toContain("msg.command === 'topicsUpdated'");
			expect(script).toContain("replaceSection('topicsSection', msg.html)");
			// Per-topic collapse is snapshotted by the stable data-topic payload
			// (the topic-<index> id renumbers on delete) and restored after the
			// rebuild, so deleting one topic does NOT re-expand the others.
			expect(script).toContain("collapseByTopic");
			expect(script).toContain("getAttribute('data-topic')");
			// allCollapsed is recomputed from the restored DOM (NOT forced false),
			// so the #toggleAllBtn label stays accurate.
			expect(script).toContain(
				"allCollapsed = topicCount > 0 && everyCollapsed",
			);
			expect(script).toContain("attachToggleAllBtnHandler()");
			// ESC cleanup on still-editing topics before the nodes are discarded.
			expect(script).toContain("classList.contains('editing')");
		});

		it("topicUpdated preserves collapse via the `collapsed` class (not the no-op `open`)", () => {
			// Slice the single-topic-edit handler so the assertions are specific
			// to it (the `open` class is still used elsewhere for dropdown menus).
			const start = script.indexOf("msg.command === 'topicUpdated'");
			const end = script.indexOf("topicUpdateError");
			const block = script.slice(start, end);
			expect(block).toContain("wasCollapsed");
			expect(block).toContain("classList.contains('collapsed')");
			// Regression guard: the old no-op `open` snapshot must be gone here.
			expect(block).not.toContain("'open'");
		});

		it("plansAndNotesUpdated replaces the section and re-binds the snippet inputs", () => {
			expect(script).toContain("msg.command === 'plansAndNotesUpdated'");
			expect(script).toContain(
				"replaceSection('plansAndNotesSection', msg.html)",
			);
			// Snippet form input listeners are per-element (lost on replace) → re-bound.
			expect(script).toContain("function bindPlansAndNotesSection()");
			expect(script).toContain("bindPlansAndNotesSection()");
		});

		it("plansAndNotesUpdated syncs the CONTEXT chip in #contextPanel's header (outside the replaced section)", () => {
			// The visible "CONTEXT N" count is #contextPanel's panel-header .sec-count,
			// which sits OUTSIDE #plansAndNotesSection (that section's own header is
			// CSS-hidden), so replaceSection can't touch it — it must be updated from
			// the message's count field.
			expect(script).toContain("getElementById('contextPanel')");
			expect(script).toContain(".panel-header .sec-count");
			expect(script).toContain("String(msg.count)");
		});

		it("jolliRowUpdated targets the header row by id", () => {
			expect(script).toContain("msg.command === 'jolliRowUpdated'");
			expect(script).toContain("getElementById('jolliRow')");
		});

		it("replaceSection strips a stale trailing <hr> only when the new html ends in one (generalized beyond recap)", () => {
			expect(script).toContain("function replaceSection(id, html)");
			expect(script).toContain("lastNew.tagName === 'HR'");
			// The old recap-only special-case (id === 'recapSection') is gone.
			expect(script).not.toContain("id === 'recapSection'");
		});
	});

	// ─── Token meter (.tmeter): segment widths + help popover pin ─────────────
	describe("token meter", () => {
		it("sets segment widths from data-pct after load (CSP forbids inline style)", () => {
			expect(script).toContain(".tmeter-bar [data-pct]");
			expect(script).toContain("el.style.width = el.dataset.pct + '%'");
		});

		it("wires the .tok-help button to toggle .pinned on its .tok-help-wrap", () => {
			expect(script).toContain(".tok-help");
			expect(script).toContain("closest('.tok-help-wrap')");
			expect(script).toContain("classList.add('pinned')");
			expect(script).toContain("classList.remove('pinned')");
		});
	});

	// ─── Conversations inline rows (mockup alignment, Task 7) ────────────────
	describe("conversations inline rows", () => {
		it("requests conversation data (loadConversations) on bind", () => {
			expect(script).toContain("command: 'loadConversations'");
		});

		it("renders inline .row markup with a src badge, title, N msgs and a detach button on conversationsData", () => {
			expect(script).toContain("msg.command === 'conversationsData'");
			expect(script).toContain('class="row"');
			expect(script).toContain("badge src-");
			expect(script).toContain('class="r-title"');
			expect(script).toContain(" msgs");
			expect(script).toContain("conv-detach");
			// Uses the shared source-label helper for the badge text.
			expect(script).toContain("getSourceLabel(");
		});

		it("wires .conv-detach to post conversationDetach with hash + sessionId + source (delegation, no inline handler)", () => {
			expect(script).toContain("conv-detach");
			expect(script).toContain("command: 'conversationDetach'");
			expect(script).toContain("source: row.getAttribute('data-source')");
		});

		it("renders each row with a data-source attribute so detach can match the source:sessionId composite key", () => {
			// Two different sources can mint the same raw sessionId, so
			// matching detach by sessionId alone risks resolving to (or
			// removing) the wrong row — data-source is the disambiguator.
			expect(script).toContain('data-source="');
		});

		// Task 11 gating verification: the detach button is destructive (it
		// rewrites the orphan-branch transcript via conversationDetach — see
		// SummaryWebviewPanel's FOREIGN_SAFE_COMMANDS comment), so it must NOT
		// carry data-foreign-safe. Without that omission the
		// `.page.foreign-readonly button:not([data-foreign-safe])` CSS rule
		// (and its stale-readonly twin) would fail to hide it.
		it("conv-detach button does not carry data-foreign-safe", () => {
			const detachButtonMatch = script.match(/<button class="icon-btn danger conv-detach"[^>]*>/);
			expect(detachButtonMatch).not.toBeNull();
			expect(detachButtonMatch?.[0]).not.toContain("data-foreign-safe");
		});

		it("removes the row in place and decrements the count on conversationDetached ack", () => {
			expect(script).toContain("msg.command === 'conversationDetached'");
			// In-place removal (mirrors sidebar precise update), not a full rebuild.
			expect(script).toContain(".row[data-session=");
		});

		it("matches the acked row by the source:sessionId composite key, not sessionId alone", () => {
			expect(script).toContain("function conversationRowSelector(sessionId, source)");
			expect(script).toContain('[data-source="');
			expect(script).toContain("conversationRowSelector(sid, msg.source)");
		});
	});

	// ─── Files panel (per-file status + diff, Task 9) ────────────────────────
	describe("files panel", () => {
		it("requests file rows (loadFiles) on bind", () => {
			expect(script).toContain("command: 'loadFiles'");
		});

		it("renders per-file rows with status badge classes on files:rows", () => {
			expect(script).toContain("msg.command === 'files:rows'");
			expect(script).toContain("fname-");
			expect(script).toContain("gs gs-");
		});

		it("emits data-path and data-status on resolvable rows", () => {
			expect(script).toContain("data-path=\"");
			expect(script).toContain("data-status=\"");
		});

		it("emits data-old-path only for resolvable rename (status R) rows", () => {
			expect(script).toContain("f.status === 'R' && f.oldPath");
			expect(script).toContain("data-old-path=\"");
		});

		it("renders off-branch rows as .row.is-unresolvable with no data-path and a files-offbranch-hint naming the branch", () => {
			expect(script).toContain("row is-unresolvable");
			expect(script).toContain("dataPath = offBranch ? ''");
			expect(script).toContain("files-offbranch-hint");
			expect(script).toContain("Check out <code>");
			expect(script).toContain("esc(branch)");
		});

		it("wires a resolvable file row click to post openFileDiff with path, commitHash, status, and oldPath", () => {
			expect(script).toContain("#filesPanel .row[data-path]");
			expect(script).toContain("command: 'openFileDiff'");
			expect(script).toContain("oldPath: row.getAttribute('data-old-path') || undefined");
		});
	});

	// ─── Dead-code sweep: PR card moved to its own pane in an earlier task ────
	describe("dead PR/E2E chain remnants", () => {
		it("does not reference createPrWithE2eBtn or window.prChainE2eThenCreate (PR card lives in CreatePrWebviewPanel now)", () => {
			expect(script).not.toContain("createPrWithE2eBtn");
			expect(script).not.toContain("prChainE2eThenCreate");
		});
	});

	// ─── Excluded-context delete dispatch (guards the HtmlBuilder ↔ host wiring) ──
	describe("removeExcludedContext dispatch", () => {
		it("reads data-excluded-* and posts the command (a typo in any attribute name would silently break the button)", () => {
			expect(script).toContain("case 'removeExcludedContext'");
			// Attribute names must match SummaryHtmlBuilder.buildExcludedRow exactly.
			expect(script).toContain("data-excluded-kind");
			expect(script).toContain("data-excluded-key");
			expect(script).toContain("data-excluded-title");
			expect(script).toContain("command: 'removeExcludedContext'");
		});
	});
});

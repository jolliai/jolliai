import { describe, expect, it } from "vitest";
import { buildTranscriptEntriesScript } from "./TranscriptEntryRenderer.js";

describe("buildTranscriptEntriesScript", () => {
	it("emits a self-contained renderTranscriptEntries function", () => {
		const script = buildTranscriptEntriesScript();
		expect(script).toContain("function renderTranscriptEntries");
		expect(script).toContain("data-role");
	});

	it("does not contain stray backticks that would terminate a parent template literal", () => {
		const script = buildTranscriptEntriesScript();
		expect(script.includes("`")).toBe(false);
	});

	it("uses addEventListener (no inline event handlers)", () => {
		const script = buildTranscriptEntriesScript();
		expect(script).not.toMatch(/onclick=/);
		expect(script).toMatch(/addEventListener/);
	});

	// The next four tests pin grouping + sort behavior at the source level
	// (substring assertions on the generated JS string). Promoting these to
	// jsdom execution would catch more regressions but is a separate
	// follow-up — for now we pin the specific tokens that encode the rules.

	it("groups by (source, sessionId) so same sessionId across sources lives in different tabs", () => {
		const script = buildTranscriptEntriesScript();
		// Composite key matches the panel-registry pattern from
		// ConversationDetailsPanel and HiddenConversationsStore.
		expect(script).toContain("(e.source || 'claude') + ':' + e.sessionId");
	});

	it("sorts entries within a group by timestamp with '' tie-break", () => {
		const script = buildTranscriptEntriesScript();
		// localeCompare with `(a.timestamp || '')` handles missing
		// timestamps deterministically (empty string sorts first), which
		// keeps the modal stable for sessions where some rows lack times.
		expect(script).toMatch(
			/\(a\.timestamp \|\| ''\)\.localeCompare\(b\.timestamp \|\| ''\)/,
		);
	});

	it("sorts group tabs by each group's earliest entry timestamp", () => {
		const script = buildTranscriptEntriesScript();
		// The group-ordering pass reads entries[0].timestamp for each
		// group after the within-group sort already ran — so [0] is
		// genuinely the earliest entry of that group.
		expect(script).toMatch(/groups\[a\]\.entries\[0\][^;]*timestamp/);
		expect(script).toMatch(/groups\[b\]\.entries\[0\][^;]*timestamp/);
	});

	it("getSourceLabel returns each of the 7 known TranscriptSource labels with 'Claude' as the default", () => {
		const script = buildTranscriptEntriesScript();
		expect(script).toContain("source === 'codex'");
		expect(script).toContain("'Codex'");
		expect(script).toContain("source === 'gemini'");
		expect(script).toContain("'Gemini'");
		expect(script).toContain("source === 'opencode'");
		expect(script).toContain("'OpenCode'");
		expect(script).toContain("source === 'cursor'");
		expect(script).toContain("'Cursor'");
		expect(script).toContain("source === 'copilot'");
		expect(script).toContain("'Copilot'");
		expect(script).toContain("source === 'copilot-chat'");
		expect(script).toContain("'Copilot Chat'");
		// Default: unknown source labelled as Claude (back-compat with
		// SessionInfo.source being optional and defaulting to claude).
		expect(script).toMatch(/return 'Claude';\s*}/);
	});
});

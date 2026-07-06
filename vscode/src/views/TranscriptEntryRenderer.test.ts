import { describe, expect, it } from "vitest";
import { buildSourceLabelScript } from "./TranscriptEntryRenderer.js";

describe("buildSourceLabelScript", () => {
	it("emits a self-contained getSourceLabel function", () => {
		const script = buildSourceLabelScript();
		expect(script).toContain("function getSourceLabel");
	});

	it("does not contain stray backticks that would terminate a parent template literal", () => {
		const script = buildSourceLabelScript();
		expect(script.includes("`")).toBe(false);
	});

	it("returns each of the 7 known TranscriptSource labels with 'Claude' as the default", () => {
		const script = buildSourceLabelScript();
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

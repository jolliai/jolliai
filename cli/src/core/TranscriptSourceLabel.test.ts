import { describe, expect, it } from "vitest";
import { transcriptSourceLabel } from "./TranscriptSourceLabel.js";

describe("transcriptSourceLabel", () => {
	it("returns the friendly label for each known source (matches the current webview behavior)", () => {
		expect(transcriptSourceLabel("claude")).toBe("Claude");
		expect(transcriptSourceLabel("codex")).toBe("Codex");
		expect(transcriptSourceLabel("cursor")).toBe("Cursor");
		// Note: 'Copilot' not 'Copilot CLI' — matches the pre-existing
		// TranscriptEntryRenderer.ts getSourceLabel behavior.
		expect(transcriptSourceLabel("copilot")).toBe("Copilot");
		expect(transcriptSourceLabel("copilot-chat")).toBe("Copilot Chat");
		expect(transcriptSourceLabel("gemini")).toBe("Gemini");
		expect(transcriptSourceLabel("opencode")).toBe("OpenCode");
	});

	it("falls back to 'Claude' for unknown sources (matches the current webview behavior)", () => {
		expect(transcriptSourceLabel("unknown" as never)).toBe("Claude");
	});

	it("falls back to 'Claude' when source is undefined (matches the current webview behavior)", () => {
		expect(transcriptSourceLabel(undefined)).toBe("Claude");
	});
});

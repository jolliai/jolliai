import { describe, expect, it } from "vitest";
import type { TranscriptSource } from "../../Types.js";
import { scanCursorSkillLines } from "./CursorSkillScanner.js";
import { getSkillScanner } from "./SkillTranscriptScanner.js";

/**
 * The dispatch table's membership, pinned directly.
 *
 * `SkillExtractor.test.ts` mocks this table, so nothing there can catch an entry that
 * was never added — and a missing entry fails silently: `supports()` returns false and
 * the source simply reports no skills, which is indistinguishable from a user who used
 * none.
 */
describe("getSkillScanner", () => {
	it("serves both Cursor sources from ONE scanner under ONE SkillSource", () => {
		// Both read the same agent-transcripts JSONL and the envelope is identical in
		// each, so a second scanner would only duplicate the matcher. `source: "cursor"`
		// for both because they share one user-facing toggle — splitting the
		// `<source>:<skill>` registry key would show one user's skill twice.
		for (const source of ["cursor", "cursor-cli"] as const) {
			const entry = getSkillScanner(source);
			expect(entry, source).toBeDefined();
			expect(entry?.source, source).toBe("cursor");
			expect(entry?.scan, source).toBe(scanCursorSkillLines);
		}
	});

	it("serves the other hosts that have a scanner", () => {
		for (const source of ["claude", "codex", "kimi"] as const) {
			expect(getSkillScanner(source), source).toBeDefined();
		}
	});

	it("answers undefined for a source with no skill extraction", () => {
		// Not a wish-list. `opencode` has skill discovery through its OWN reader (SQLite
		// rows, not JSONL lines) so it is absent from this line-oriented table on
		// purpose; the rest have no on-disk invocation record that has been captured.
		for (const source of ["opencode", "copilot", "copilot-chat", "cline", "cline-cli", "devin", "antigravity"]) {
			expect(getSkillScanner(source as TranscriptSource), source).toBeUndefined();
		}
	});
});

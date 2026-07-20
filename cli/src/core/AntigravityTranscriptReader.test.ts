import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REAL_TRANSCRIPT_FULL } from "../testUtils/antigravityFixture.js";
import { readAntigravityTranscript } from "./AntigravityTranscriptReader.js";

function writeTranscript(lines: ReadonlyArray<Record<string, unknown>>): string {
	const dir = mkdtempSync(join(tmpdir(), "agy-tr-"));
	const path = join(dir, "transcript_full.jsonl");
	writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	return path;
}

describe("readAntigravityTranscript", () => {
	it("maps USER_INPUT→human (unwrapped) and PLANNER_RESPONSE→assistant, skips CHECKPOINT/HISTORY", async () => {
		const path = writeTranscript(REAL_TRANSCRIPT_FULL);
		const result = await readAntigravityTranscript(path);
		expect(result.entries[0].role).toBe("human");
		expect(result.entries[0].content).toBe("查看当前分支");
		expect(result.entries.some((e) => e.role === "assistant" && e.content.includes("当前分支是"))).toBe(true);
		// CHECKPOINT / CONVERSATION_HISTORY never surface as entries.
		expect(result.entries.every((e) => !e.content.includes("CHECKPOINT"))).toBe(true);
		expect(result.entries.every((e) => !e.content.includes("CONVERSATION_HISTORY"))).toBe(true);
	});

	it("summarizes tool_calls on the assistant turn", async () => {
		const path = writeTranscript(REAL_TRANSCRIPT_FULL);
		const result = await readAntigravityTranscript(path);
		expect(result.entries.some((e) => e.content.includes("git branch --show-current"))).toBe(true);
	});

	it("resumes from cursor.lineNumber (no re-emission)", async () => {
		const path = writeTranscript(REAL_TRANSCRIPT_FULL);
		const first = await readAntigravityTranscript(path);
		const again = await readAntigravityTranscript(path, first.newCursor);
		expect(again.entries).toHaveLength(0);
		expect(again.newCursor.lineNumber).toBe(first.newCursor.lineNumber);
	});

	it("stops before an entry at/after beforeTimestamp and resumes there", async () => {
		const path = writeTranscript(REAL_TRANSCRIPT_FULL);
		// Cut off at the RUN_COMMAND timestamp (step 3 onward excluded).
		const result = await readAntigravityTranscript(path, undefined, "2026-07-19T09:46:52Z");
		expect(result.entries.every((e) => !e.content.includes("feature/cline-cli-source") || e.role === "human")).toBe(
			true,
		);
		expect(result.newCursor.lineNumber).toBeLessThan(REAL_TRANSCRIPT_FULL.length);
	});

	it("returns empty for a missing file", async () => {
		const result = await readAntigravityTranscript("/no/such/transcript_full.jsonl");
		expect(result.entries).toHaveLength(0);
		expect(result.totalLinesRead).toBe(0);
	});
});

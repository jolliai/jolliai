import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REAL_TRANSCRIPT_FULL } from "../testUtils/antigravityFixture.js";
import { readAntigravityTranscript, unwrapUserRequest } from "./AntigravityTranscriptReader.js";

function writeRaw(text: string): string {
	const dir = mkdtempSync(join(tmpdir(), "agy-tr-"));
	const path = join(dir, "transcript_full.jsonl");
	writeFileSync(path, text);
	return path;
}

function writeTranscript(lines: ReadonlyArray<Record<string, unknown>>): string {
	return writeRaw(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
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

	it("preserves the caller's cursor on a missing file instead of rewinding to 0", async () => {
		const cursor = { transcriptPath: "/no/such/t.jsonl", lineNumber: 7, updatedAt: "2026-07-19T09:00:00Z" };
		const result = await readAntigravityTranscript("/no/such/t.jsonl", cursor);
		expect(result.newCursor).toEqual(cursor);
	});

	// A torn write (Antigravity appends while we read) leaves a half-flushed line.
	// It must be skipped, not abort the whole read — the lines after it are valid.
	it("skips a malformed JSONL line and keeps reading", async () => {
		const path = writeRaw(
			[
				JSON.stringify({ type: "USER_INPUT", created_at: "2026-07-19T09:46:50Z", content: "first" }),
				'{"type":"USER_INPUT","content":',
				JSON.stringify({ type: "USER_INPUT", created_at: "2026-07-19T09:46:51Z", content: "third" }),
			].join("\n"),
		);
		const result = await readAntigravityTranscript(path);
		expect(result.entries.map((e) => e.content)).toEqual(["first\n\nthird"]);
		expect(result.totalLinesRead).toBe(3);
	});

	// `created_at` is present on every row of a real transcript, but the reader
	// must not stamp a non-string value onto the entry (nor let it drive lastTs).
	it("leaves the timestamp undefined when created_at is not a string", async () => {
		const path = writeTranscript([{ type: "USER_INPUT", created_at: 1_784_631_456, content: "no iso stamp" }]);
		const result = await readAntigravityTranscript(path);
		expect(result.entries).toEqual([{ role: "human", content: "no iso stamp", timestamp: undefined }]);
	});

	it("drops rows whose payload carries nothing to show", async () => {
		const path = writeTranscript([
			// USER_INPUT with an empty envelope → no human text.
			{ type: "USER_INPUT", created_at: "2026-07-19T09:00:00Z", content: "<USER_REQUEST></USER_REQUEST>" },
			// PLANNER_RESPONSE with neither content nor tool_calls.
			{ type: "PLANNER_RESPONSE", created_at: "2026-07-19T09:00:01Z" },
			// PLANNER_RESPONSE whose tool_calls is not an array.
			{ type: "PLANNER_RESPONSE", created_at: "2026-07-19T09:00:02Z", tool_calls: "run_command" },
			// RUN_COMMAND that produced no output.
			{ type: "RUN_COMMAND", created_at: "2026-07-19T09:00:03Z", content: "" },
			// A row type the reader deliberately ignores.
			{ type: "LIST_DIRECTORY", created_at: "2026-07-19T09:00:04Z", content: "src/" },
		]);
		const result = await readAntigravityTranscript(path);
		expect(result.entries).toEqual([]);
		expect(result.totalLinesRead).toBe(5);
	});

	// toolCallSummary's three detail sources: CommandLine (covered by the real
	// fixture), toolSummary, and neither — plus a tool call missing `name`/`args`
	// entirely, which must degrade to the bare "↪ tool" marker.
	it("summarizes tool_calls that lack CommandLine, name, or args", async () => {
		const path = writeTranscript([
			{
				type: "PLANNER_RESPONSE",
				created_at: "2026-07-19T09:00:00Z",
				tool_calls: [
					{ name: "view_file", args: { toolSummary: "Read src/app.ts" } },
					{ name: "grep_search", args: { AbsolutePath: "/repo" } },
					{},
				],
			},
		]);
		const result = await readAntigravityTranscript(path);
		expect(result.entries[0].content).toBe("↪ view_file: Read src/app.ts\n↪ grep_search\n↪ tool");
	});
});

describe("unwrapUserRequest", () => {
	it("returns the trimmed inner text when the envelope is present", () => {
		expect(unwrapUserRequest("<USER_REQUEST>\n  查看当前分支\n</USER_REQUEST>\ntrailing")).toBe("查看当前分支");
	});

	it("returns the trimmed whole string when the envelope is absent", () => {
		expect(unwrapUserRequest("  plain user text  ")).toBe("plain user text");
	});
});

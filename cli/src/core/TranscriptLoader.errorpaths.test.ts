/**
 * Coverage for the silent error paths in `loadTranscript`:
 *   1. The `if (!isEnoent(err))` falsy branch in the gemini block (line ~46) —
 *      an ENOENT thrown out of `readGeminiTranscript` must be swallowed
 *      without a warn log. The existing happy-path gemini test uses a missing
 *      real file, but `readGeminiTranscript` swallows ENOENT internally —
 *      it never propagates up, so neither arm of the catch's `isEnoent` was
 *      being exercised. Mocking the reader lets us force the propagation.
 *
 *   2. The `parseSkipped++` increment + end-of-stream debug log for the
 *      JSONL line-streaming path. The claude / codex parsers route through
 *      `TranscriptParser.parseLine` which swallows JSON errors internally and
 *      returns `null`, so they NEVER reach the `try { parse(line) } catch`.
 *      Only `parseCopilotChat` does a raw `JSON.parse(line)` that throws on
 *      malformed input — so a copilot-chat fixture with a bad-JSON line is
 *      the trigger for this branch.
 *
 * Kept in a separate file from `TranscriptLoader.test.ts` because the gemini
 * mock would conflict with that suite's real-fixture gemini tests.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./GeminiTranscriptReader.js", () => ({
	readGeminiTranscript: vi.fn(),
}));

import { readGeminiTranscript } from "./GeminiTranscriptReader.js";
import { loadTranscript } from "./TranscriptLoader.js";

const enoent = (path: string): NodeJS.ErrnoException => {
	const e: NodeJS.ErrnoException = new Error(`ENOENT: no such file, open '${path}'`);
	e.code = "ENOENT";
	return e;
};

describe("loadTranscript error paths", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "transcript-loader-err-"));
		vi.mocked(readGeminiTranscript).mockReset();
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("swallows ENOENT thrown by readGeminiTranscript without warn-logging", async () => {
		vi.mocked(readGeminiTranscript).mockRejectedValueOnce(enoent("/missing.json"));
		const result = await loadTranscript({
			source: "gemini",
			transcriptPath: "/missing.json",
		});
		expect(result).toEqual([]);
	});

	it("warn-logs and returns [] when readGeminiTranscript throws a non-ENOENT error", async () => {
		// Companion to the ENOENT case — exercises the truthy arm of
		// `if (!isEnoent(err))` so both branches are covered.
		vi.mocked(readGeminiTranscript).mockRejectedValueOnce(new Error("malformed JSON"));
		const result = await loadTranscript({
			source: "gemini",
			transcriptPath: "/corrupt.json",
		});
		expect(result).toEqual([]);
	});

	it("skips lines whose JSONL parser throws and still keeps the well-formed entries", async () => {
		// `parseCopilotChat` calls `JSON.parse(line)` raw — a non-JSON line
		// throws SyntaxError → the outer `try { parse(line) } catch` increments
		// parseSkipped, then a single end-of-stream debug log fires. The well-
		// formed line still lands in the result.
		const file = join(dir, "cc-mixed.jsonl");
		writeFileSync(
			file,
			[
				"this line is not json",
				'{"value":{"message":{"text":"hello","role":"user"}}}',
				"also not json {",
				'{"value":{"message":{"text":"world","role":"assistant"}}}',
				"",
			].join("\n"),
		);
		const result = await loadTranscript({ source: "copilot-chat", transcriptPath: file });
		expect(result).toHaveLength(2);
		expect(result[0].content).toBe("hello");
		expect(result[1].content).toBe("world");
	});
});

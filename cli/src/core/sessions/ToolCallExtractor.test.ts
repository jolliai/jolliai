import { describe, expect, it, vi } from "vitest";
import type { ToolCallCount, TranscriptReadResult, TranscriptSource } from "../../Types.js";
import type { SessionSignalInput } from "./SessionSignalExtractor.js";
import { toolCallExtractor } from "./ToolCallExtractor.js";

function readResult(over: Partial<TranscriptReadResult> = {}): TranscriptReadResult {
	return {
		entries: [],
		newCursor: { transcriptPath: "/tmp/s1.jsonl", lineNumber: 0, updatedAt: "2026-08-01T00:00:00.000Z" },
		totalLinesRead: 0,
		...over,
	};
}

/** An input whose `read()` behaves however the case needs; `lines()` is unused here. */
function input(read: () => Promise<TranscriptReadResult>, source: TranscriptSource = "claude"): SessionSignalInput {
	return {
		source,
		sessionId: "s1",
		transcriptPath: "/tmp/s1.jsonl",
		content: { read, lines: async () => undefined },
	};
}

describe("toolCallExtractor.supports", () => {
	it("answers from TOOL_RECORDING_SOURCES rather than a list of its own", () => {
		// The set is half probed and half hand-maintained against real captures, and it
		// already carries the rule that matters — a source joins only once its reader
		// has been written against a real transcript.
		expect(toolCallExtractor.supports("claude")).toBe(true);
		expect(toolCallExtractor.supports("codex")).toBe(true);
	});

	it("declines a source the set does not carry", () => {
		// A source wrongly included would report `toolUse: []`, which every consumer
		// reads as the positive claim "this agent called no tools".
		//
		// `cursor` used to be the example here and no longer is: its conversations are
		// now read from the same agent-transcripts JSONL as `cursor-cli`, which is where
		// their tool_use blocks live at all. `copilot` takes its place — its tool records
		// are still unproven, and the set's membership is pinned in
		// `TranscriptParserToolUse.test.ts`.
		expect(toolCallExtractor.supports("copilot" as TranscriptSource)).toBe(false);
	});

	it("accepts cursor, whose reader now populates toolUse", () => {
		expect(toolCallExtractor.supports("cursor" as TranscriptSource)).toBe(true);
	});
});

describe("toolCallExtractor.extract", () => {
	it("forwards the reader's buckets", async () => {
		const tools: ToolCallCount[] = [{ name: "Bash", kind: "builtin", calls: 2 }];
		const signals = await toolCallExtractor.extract(input(async () => readResult({ toolUse: tools })));
		expect(signals).toEqual({ tools });
	});

	it("forwards an EMPTY bucket list, which is a real answer", async () => {
		// "Called no tools" is worth storing. It must not be turned into absence.
		const signals = await toolCallExtractor.extract(input(async () => readResult({ toolUse: [] })));
		expect(signals).toEqual({ tools: [] });
		expect(signals.tools).toHaveLength(0);
	});

	it("reports ABSENCE when the reader produced no `toolUse` at all", async () => {
		// Absence means this slice could not say; the two must not collapse.
		const signals = await toolCallExtractor.extract(input(async () => readResult()));
		expect(signals).toEqual({});
		expect(signals.tools).toBeUndefined();
	});

	it("rethrows a failed read with the session named, rather than swallowing it", async () => {
		// An unreadable transcript and a transcript with no tool calls are different
		// facts. Returning `{}` here would spell them the same way — the caller is what
		// decides the consequence.
		const boom = async (): Promise<TranscriptReadResult> => {
			throw new Error("database is locked");
		};
		await expect(toolCallExtractor.extract(input(boom, "codex"))).rejects.toThrow(
			/tool-call extraction failed for codex\/s1: database is locked/,
		);
	});

	it("reads the transcript exactly once per extraction", async () => {
		const read = vi.fn(async () => readResult({ toolUse: [] }));
		await toolCallExtractor.extract(input(read));
		expect(read).toHaveBeenCalledTimes(1);
	});
});

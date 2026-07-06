import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sumConversationTokens } from "./ConversationTokenTotals.js";

const tmpDirs: string[] = [];
afterEach(async () => {
	// Actually remove the transcript temp dirs so repeated runs don't leak them.
	await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
	tmpDirs.length = 0;
});

async function writeClaudeTranscript(lines: ReadonlyArray<Record<string, unknown>>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "jolli-token-totals-"));
	tmpDirs.push(dir);
	const path = join(dir, "session.jsonl");
	await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n"), "utf-8");
	return path;
}

describe("sumConversationTokens", () => {
	it("sums usage across selected Claude conversations, ignoring cache_read", async () => {
		// Shape mirrors the real Claude Code transcript schema already pinned in
		// cli/src/core/TranscriptReader.test.ts (usage lives at message.usage).
		const claudePath = await writeClaudeTranscript([
			{
				timestamp: "2026-07-01T00:00:00.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					usage: {
						input_tokens: 100,
						cache_creation_input_tokens: 20,
						cache_read_input_tokens: 5000,
						output_tokens: 5,
					},
				},
			},
			{
				timestamp: "2026-07-01T00:01:00.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "more" }],
					usage: {
						input_tokens: 50,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 5100,
						output_tokens: 10,
					},
				},
			},
		]);

		const result = await sumConversationTokens([{ source: "claude", transcriptPath: claudePath }]);

		// 100 + 20 + 5 + 50 + 0 + 10 = 185; cache_read_input_tokens is never summed
		// (see the parser comment in TranscriptParser.ts for why).
		expect(result).toEqual({
			input: 150,
			output: 15,
			cached: 20,
			total: 185,
			reportingCount: 1,
			totalCount: 1,
		});
	});

	it("reports non-Claude sources as non-reporting without reading a file", async () => {
		const result = await sumConversationTokens([{ source: "codex", transcriptPath: "/does/not/exist.jsonl" }]);
		expect(result).toEqual({ input: 0, output: 0, cached: 0, total: 0, reportingCount: 0, totalCount: 1 });
	});

	it("degrades a single unreadable Claude transcript to zero without throwing", async () => {
		const result = await sumConversationTokens([{ source: "claude", transcriptPath: "/does/not/exist.jsonl" }]);
		expect(result).toEqual({ input: 0, output: 0, cached: 0, total: 0, reportingCount: 0, totalCount: 1 });
	});

	it("does not count a readable Claude transcript that contributes zero tokens as reporting", async () => {
		// A window with no assistant `usage` lines (here: a lone user turn) parses
		// fine but yields an all-zero usageBreakdown. readTranscript always returns
		// a breakdown object, so reportingCount must gate on a non-zero sum — else
		// this empty-but-readable transcript would inflate the "N reporting" count.
		const claudePath = await writeClaudeTranscript([
			{
				timestamp: "2026-07-01T00:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "hello" }] },
			},
		]);

		const result = await sumConversationTokens([{ source: "claude", transcriptPath: claudePath }]);

		expect(result).toEqual({ input: 0, output: 0, cached: 0, total: 0, reportingCount: 0, totalCount: 1 });
	});

	it("returns all zeros for an empty entry list", async () => {
		expect(await sumConversationTokens([])).toEqual({
			input: 0,
			output: 0,
			cached: 0,
			total: 0,
			reportingCount: 0,
			totalCount: 0,
		});
	});
});

import { beforeAll, describe, expect, it, vi } from "vitest";

// Suppress console output during tests
beforeAll(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

import { ClaudeTranscriptParser, CodexTranscriptParser, getParserForSource } from "./TranscriptParser.js";

// ─── CodexTranscriptParser ───────────────────────────────────────────────────

describe("CodexTranscriptParser", () => {
	const parser = new CodexTranscriptParser();

	describe("user messages", () => {
		it("parses event_msg/user_message into a human entry", () => {
			const line = JSON.stringify({
				timestamp: "2026-03-22T02:07:31.214Z",
				type: "event_msg",
				payload: { type: "user_message", message: "Fix the login bug\n" },
			});
			const entry = parser.parseLine(line, 0);
			expect(entry).toEqual({
				role: "human",
				content: "Fix the login bug",
				timestamp: "2026-03-22T02:07:31.214Z",
			});
		});

		it("trims whitespace from user message", () => {
			const line = JSON.stringify({
				timestamp: "2026-03-22T02:07:31.214Z",
				type: "event_msg",
				payload: { type: "user_message", message: "  hello world  \n" },
			});
			const entry = parser.parseLine(line, 0);
			expect(entry?.content).toBe("hello world");
		});

		it("returns null for empty user message", () => {
			const line = JSON.stringify({
				timestamp: "2026-03-22T02:07:31.214Z",
				type: "event_msg",
				payload: { type: "user_message", message: "   " },
			});
			expect(parser.parseLine(line, 0)).toBeNull();
		});

		it("returns null when message field is missing", () => {
			const line = JSON.stringify({
				timestamp: "2026-03-22T02:07:31.214Z",
				type: "event_msg",
				payload: { type: "user_message" },
			});
			expect(parser.parseLine(line, 0)).toBeNull();
		});

		it("returns null when message field is not a string", () => {
			const line = JSON.stringify({
				timestamp: "2026-03-22T02:07:31.214Z",
				type: "event_msg",
				payload: { type: "user_message", message: 123 },
			});
			expect(parser.parseLine(line, 0)).toBeNull();
		});
	});

	describe("agent messages", () => {
		it("parses event_msg/agent_message with final_answer phase", () => {
			const line = JSON.stringify({
				timestamp: "2026-03-22T02:08:00.000Z",
				type: "event_msg",
				payload: { type: "agent_message", message: "I fixed the bug.", phase: "final_answer" },
			});
			const entry = parser.parseLine(line, 1);
			expect(entry).toEqual({
				role: "assistant",
				content: "I fixed the bug.",
				timestamp: "2026-03-22T02:08:00.000Z",
			});
		});

		it("parses event_msg/agent_message with commentary phase", () => {
			const line = JSON.stringify({
				timestamp: "2026-03-22T02:07:45.000Z",
				type: "event_msg",
				payload: { type: "agent_message", message: "Looking at the auth module...", phase: "commentary" },
			});
			const entry = parser.parseLine(line, 1);
			expect(entry).toEqual({
				role: "assistant",
				content: "Looking at the auth module...",
				timestamp: "2026-03-22T02:07:45.000Z",
			});
		});

		it("returns null for empty agent message", () => {
			const line = JSON.stringify({
				timestamp: "2026-03-22T02:08:00.000Z",
				type: "event_msg",
				payload: { type: "agent_message", message: "" },
			});
			expect(parser.parseLine(line, 0)).toBeNull();
		});
	});

	describe("skipped event types", () => {
		const skippedTypes = [
			{ type: "session_meta", payload: { id: "abc", cwd: "/tmp" } },
			{ type: "turn_context", payload: { turn_id: "abc", cwd: "/tmp" } },
			{ type: "response_item", payload: { type: "message", role: "user", content: [] } },
			{ type: "response_item", payload: { type: "function_call", name: "exec_command" } },
			{ type: "response_item", payload: { type: "function_call_output", output: "ok" } },
			{ type: "response_item", payload: { type: "reasoning", summary: [] } },
			{ type: "compacted", payload: { message: "", replacement_history: [] } },
		];

		for (const event of skippedTypes) {
			it(`skips ${event.type} events`, () => {
				const line = JSON.stringify({ timestamp: "2026-03-22T00:00:00Z", ...event });
				expect(parser.parseLine(line, 0)).toBeNull();
			});
		}

		const skippedEventMsgSubtypes = [
			"token_count",
			"task_started",
			"task_complete",
			"turn_aborted",
			"context_compacted",
			"agent_reasoning",
		];

		for (const subtype of skippedEventMsgSubtypes) {
			it(`skips event_msg/${subtype}`, () => {
				const line = JSON.stringify({
					timestamp: "2026-03-22T00:00:00Z",
					type: "event_msg",
					payload: { type: subtype, message: "some data" },
				});
				expect(parser.parseLine(line, 0)).toBeNull();
			});
		}
	});

	describe("error handling", () => {
		it("returns null for invalid JSON", () => {
			expect(parser.parseLine("not valid json", 0)).toBeNull();
		});

		it("returns null for empty string", () => {
			expect(parser.parseLine("", 0)).toBeNull();
		});

		it("returns null when payload is missing", () => {
			const line = JSON.stringify({ timestamp: "2026-03-22T00:00:00Z", type: "event_msg" });
			expect(parser.parseLine(line, 0)).toBeNull();
		});

		it("returns null when payload is not an object", () => {
			const line = JSON.stringify({ timestamp: "2026-03-22T00:00:00Z", type: "event_msg", payload: "string" });
			expect(parser.parseLine(line, 0)).toBeNull();
		});

		it("handles missing timestamp gracefully", () => {
			const line = JSON.stringify({
				type: "event_msg",
				payload: { type: "user_message", message: "hello" },
			});
			const entry = parser.parseLine(line, 0);
			expect(entry).toEqual({ role: "human", content: "hello", timestamp: undefined });
		});
	});
});

// ─── ClaudeTranscriptParser ──────────────────────────────────────────────────

describe("ClaudeTranscriptParser", () => {
	const parser = new ClaudeTranscriptParser();

	it("parses a Claude user message", () => {
		const line = JSON.stringify({
			message: { role: "user", content: "Fix the bug" },
			timestamp: "2026-03-22T00:00:00Z",
		});
		const entry = parser.parseLine(line, 0);
		expect(entry).not.toBeNull();
		expect(entry?.role).toBe("human");
		expect(entry?.content).toBe("Fix the bug");
	});

	it("parses a Claude assistant message", () => {
		const line = JSON.stringify({
			message: { role: "assistant", content: [{ type: "text", text: "Done!" }] },
			timestamp: "2026-03-22T00:00:00Z",
		});
		const entry = parser.parseLine(line, 0);
		expect(entry).not.toBeNull();
		expect(entry?.role).toBe("assistant");
		expect(entry?.content).toBe("Done!");
	});

	it("returns null for non-message lines", () => {
		const line = JSON.stringify({ type: "toolUseResult", content: "..." });
		expect(parser.parseLine(line, 0)).toBeNull();
	});

	describe("parseUsageTokens", () => {
		it("sums input + cache_creation + output, EXCLUDING the cumulative cache_read prefix", () => {
			const line = JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					usage: {
						input_tokens: 100,
						cache_creation_input_tokens: 20,
						cache_read_input_tokens: 300,
						output_tokens: 5,
					},
				},
			});
			// 100 + 20 + 5 = 125. cache_read_input_tokens (300) is intentionally NOT
			// summed — it is the cumulative re-read of an already-counted cached prefix.
			expect(parser.parseUsageTokens(line, 1)).toBe(125);
		});

		// Real-fixture regression for C6. These three usage objects are copied verbatim
		// from a real Claude transcript on disk
		// (~/.claude/projects/-Users-flyer-jolli-code-worktrees-jolli-wt-2/050d4420-…​.jsonl,
		// captured 2026-06-14). They prove cache_read_input_tokens is CUMULATIVE: it grows
		// 16036 → 26231 → 50109 across the three turns while each turn's own new spend
		// (input + cache_creation + output) is independent. Summing cache_read across the
		// slice would add 16036+26231+50109 = 92376 of double-counted cached prefix.
		it("does not inflate by summing the cumulative cache_read across real-transcript turns", () => {
			const realTurns = [
				{
					input_tokens: 21060,
					cache_creation_input_tokens: 10195,
					cache_read_input_tokens: 16036,
					output_tokens: 359,
				},
				{
					input_tokens: 1,
					cache_creation_input_tokens: 23878,
					cache_read_input_tokens: 26231,
					output_tokens: 655,
				},
				{
					input_tokens: 2,
					cache_creation_input_tokens: 2192,
					cache_read_input_tokens: 50109,
					output_tokens: 229,
				},
			];
			const lines = realTurns.map((usage) =>
				JSON.stringify({
					type: "assistant",
					message: { role: "assistant", content: [{ type: "text", text: "x" }], usage },
				}),
			);
			const total = lines.reduce((acc, l) => acc + parser.parseUsageTokens(l, 0), 0);
			// Per-turn deltas only: (21060+10195+359) + (1+23878+655) + (2+2192+229) = 31614 + 24534 + 2423 = 58571.
			expect(total).toBe(58571);
			// And it excludes the 92376 of cumulative cache_read that the old summation added.
			expect(total).toBeLessThan(58571 + 92376);
		});

		it("returns 0 for human/user lines and malformed JSON", () => {
			expect(
				parser.parseUsageTokens(JSON.stringify({ type: "user", message: { role: "user", content: "x" } }), 1),
			).toBe(0);
			expect(parser.parseUsageTokens("{not json", 1)).toBe(0);
		});
	});
});

// ─── getParserForSource factory ──────────────────────────────────────────────

describe("getParserForSource", () => {
	it("returns ClaudeTranscriptParser for 'claude'", () => {
		const parser = getParserForSource("claude");
		expect(parser).toBeInstanceOf(ClaudeTranscriptParser);
	});

	it("returns CodexTranscriptParser for 'codex'", () => {
		const parser = getParserForSource("codex");
		expect(parser).toBeInstanceOf(CodexTranscriptParser);
	});

	it("returns the same singleton instances on repeated calls", () => {
		const a = getParserForSource("codex");
		const b = getParserForSource("codex");
		expect(a).toBe(b);
	});
});

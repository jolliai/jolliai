import { beforeAll, describe, expect, it, vi } from "vitest";

// Suppress console output during tests
beforeAll(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

import {
	ClaudeTranscriptParser,
	CodexTranscriptParser,
	extractKimiText,
	getParserForSource,
	KimiTranscriptParser,
} from "./TranscriptParser.js";

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
		it("emits message.id as the dedupKey so repeated block lines collapse to one response", () => {
			const line = JSON.stringify({
				type: "assistant",
				message: {
					id: "msg_01EWeKJMpUeBRTNGECP3PiaQ",
					role: "assistant",
					content: [{ type: "thinking", thinking: "…" }],
					usage: { input_tokens: 15654, cache_creation_input_tokens: 23100, output_tokens: 1402 },
				},
			});
			expect(parser.parseUsageTokens(line, 1)).toEqual({
				input: 15654,
				output: 1402,
				cached: 23100,
				dedupKey: "msg_01EWeKJMpUeBRTNGECP3PiaQ",
			});
		});

		it("omits dedupKey when the line carries no message.id, so the line still counts", () => {
			const line = JSON.stringify({
				type: "assistant",
				message: { role: "assistant", content: [], usage: { input_tokens: 7, output_tokens: 1 } },
			});
			const parsed = parser.parseUsageTokens(line, 1);
			expect(parsed).toEqual({ input: 7, output: 1, cached: 0 });
			expect(parsed.dedupKey).toBeUndefined();
		});

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
			// input=100, output=5, cached(cache_creation)=20 → 125 total.
			// cache_read_input_tokens (300) is intentionally NOT included — it is the
			// cumulative re-read of an already-counted cached prefix.
			const b = parser.parseUsageTokens(line, 1);
			expect(b).toEqual({ input: 100, output: 5, cached: 20 });
			expect(b.input + b.output + b.cached).toBe(125);
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
			const total = lines.reduce((acc, l) => {
				const b = parser.parseUsageTokens(l, 0);
				return acc + b.input + b.output + b.cached;
			}, 0);
			// Per-turn deltas only: (21060+10195+359) + (1+23878+655) + (2+2192+229) = 31614 + 24534 + 2423 = 58571.
			expect(total).toBe(58571);
			// And it excludes the 92376 of cumulative cache_read that the old summation added.
			expect(total).toBeLessThan(58571 + 92376);
		});

		it("returns a zeroed breakdown for human/user lines and malformed JSON", () => {
			expect(
				parser.parseUsageTokens(JSON.stringify({ type: "user", message: { role: "user", content: "x" } }), 1),
			).toEqual({ input: 0, output: 0, cached: 0 });
			expect(parser.parseUsageTokens("{not json", 1)).toEqual({ input: 0, output: 0, cached: 0 });
		});

		it("coerces non-numeric usage fields to 0", () => {
			// A usage object is present, but its fields are non-numeric (e.g. null / string) —
			// each key falls through the `typeof … === "number"` guard to 0.
			const line = JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					usage: { input_tokens: null, cache_creation_input_tokens: "20", output_tokens: undefined },
				},
			});
			expect(parser.parseUsageTokens(line, 1)).toEqual({ input: 0, output: 0, cached: 0 });
		});
	});

	describe("parseTimestamp", () => {
		it("returns the ISO timestamp from a real Claude assistant line", () => {
			const line = JSON.stringify({
				type: "assistant",
				message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
				timestamp: "2026-06-14T18:03:11.482Z",
			});
			expect(parser.parseTimestamp(line, 1)).toBe("2026-06-14T18:03:11.482Z");
		});

		it("returns undefined when the timestamp field is absent or non-string", () => {
			expect(parser.parseTimestamp(JSON.stringify({ type: "assistant" }), 1)).toBeUndefined();
			expect(parser.parseTimestamp(JSON.stringify({ timestamp: 12345 }), 1)).toBeUndefined();
		});

		it("returns undefined for malformed JSON (catch branch)", () => {
			expect(parser.parseTimestamp("{not json", 1)).toBeUndefined();
		});
	});

	describe("parseUsageByModel", () => {
		const turn = (model: string | undefined, usage: Record<string, number>): string =>
			JSON.stringify({
				type: "assistant",
				message: { role: "assistant", content: [{ type: "text", text: "x" }], model, usage },
			});

		// Real-shape regression: Claude Code writes one line per content block of a
		// single assistant response and repeats that response's whole `usage` object
		// verbatim on each. The `message.id` + usage values below are copied from a
		// real transcript (~/.claude/projects/-Users-flyer-jolli-code-jollimemory/
		// 9cc7113b-….jsonl, captured 2026-07-29) where msg_01EWeKJMpUeBRTNGECP3PiaQ
		// spans 5 lines: thinking, text, and three parallel tool_use blocks — all
		// carrying in=15654 out=1402 cc=23100. Summing per line bills that one API
		// call 5×. Across that file, 186 of 262 responses repeat this way, inflating
		// the total 2.54×; the worst measured file inflated 10.13×.
		it("counts one response once even when its blocks span five lines (real transcript shape)", () => {
			const usage = {
				input_tokens: 15654,
				cache_creation_input_tokens: 23100,
				cache_read_input_tokens: 18831,
				output_tokens: 1402,
			};
			const blockLine = (content: unknown): string =>
				JSON.stringify({
					type: "assistant",
					message: {
						id: "msg_01EWeKJMpUeBRTNGECP3PiaQ",
						role: "assistant",
						model: "claude-opus-5",
						stop_reason: "tool_use",
						content: [content],
						usage,
					},
				});
			const lines = [
				blockLine({ type: "thinking", thinking: "…" }),
				blockLine({ type: "text", text: "Let me check three files." }),
				blockLine({ type: "tool_use", id: "toolu_1", name: "Read", input: {} }),
				blockLine({ type: "tool_use", id: "toolu_2", name: "Read", input: {} }),
				blockLine({ type: "tool_use", id: "toolu_3", name: "Read", input: {} }),
			];
			expect(parser.parseUsageByModel(lines)).toEqual([
				{ model: "claude-opus-5", provider: "anthropic", input: 15654, output: 1402, cached: 23100 },
			]);
		});

		it("still sums distinct responses that share a model", () => {
			const withId = (id: string, usage: Record<string, number>): string =>
				JSON.stringify({
					type: "assistant",
					message: { id, role: "assistant", model: "claude-opus-5", content: [], usage },
				});
			const lines = [
				withId("msg_a", { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 2 }),
				withId("msg_a", { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 2 }), // repeat block
				withId("msg_b", { input_tokens: 30, output_tokens: 3, cache_creation_input_tokens: 4 }),
			];
			expect(parser.parseUsageByModel(lines)).toEqual([
				{ model: "claude-opus-5", provider: "anthropic", input: 40, output: 4, cached: 6 },
			]);
		});

		it("buckets by model with the same segment semantics as parseUsageTokens", () => {
			const line = turn("claude-opus-4-8", {
				input_tokens: 100,
				cache_creation_input_tokens: 20,
				cache_read_input_tokens: 300, // cumulative — must be excluded
				output_tokens: 5,
			});
			expect(parser.parseUsageByModel([line])).toEqual([
				{ model: "claude-opus-4-8", provider: "anthropic", input: 100, output: 5, cached: 20 },
			]);
		});

		it("sums turns of the same model into one bucket", () => {
			const lines = [
				turn("claude-opus-4-8", { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 2 }),
				turn("claude-opus-4-8", { input_tokens: 30, output_tokens: 3, cache_creation_input_tokens: 4 }),
			];
			expect(parser.parseUsageByModel(lines)).toEqual([
				{ model: "claude-opus-4-8", provider: "anthropic", input: 40, output: 4, cached: 6 },
			]);
		});

		it("splits distinct models into separate buckets (mid-session model switch)", () => {
			const lines = [
				turn("claude-opus-4-8", { input_tokens: 10, output_tokens: 1 }),
				turn("claude-haiku-4-5", { input_tokens: 20, output_tokens: 2 }),
			];
			const result = parser.parseUsageByModel(lines);
			expect(result).toHaveLength(2);
			expect(result).toContainEqual({
				model: "claude-opus-4-8",
				provider: "anthropic",
				input: 10,
				output: 1,
				cached: 0,
			});
			expect(result).toContainEqual({
				model: "claude-haiku-4-5",
				provider: "anthropic",
				input: 20,
				output: 2,
				cached: 0,
			});
		});

		it("segments summed across buckets equal the parseUsageTokens total", () => {
			const lines = [
				turn("claude-opus-4-8", { input_tokens: 100, output_tokens: 5, cache_creation_input_tokens: 20 }),
				turn("claude-haiku-4-5", { input_tokens: 40, output_tokens: 3, cache_creation_input_tokens: 1 }),
			];
			const byModel = parser.parseUsageByModel(lines);
			const modelSum = byModel.reduce((a, m) => a + m.input + m.output + m.cached, 0);
			const lineSum = lines.reduce((a, l) => {
				const b = parser.parseUsageTokens(l, 0);
				return a + b.input + b.output + b.cached;
			}, 0);
			expect(modelSum).toBe(lineSum);
		});

		it("buckets usage-bearing lines with no model under an empty id, and skips lines without usage", () => {
			const lines = [
				turn(undefined, { input_tokens: 7, output_tokens: 1 }),
				JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
				"{not json",
			];
			expect(parser.parseUsageByModel(lines)).toEqual([
				{ model: "", provider: "anthropic", input: 7, output: 1, cached: 0 },
			]);
		});

		it("returns an empty array when no line carries usage", () => {
			expect(parser.parseUsageByModel(["{not json", ""])).toEqual([]);
		});
	});
});

// ─── KimiTranscriptParser ────────────────────────────────────────────────────

describe("KimiTranscriptParser", () => {
	const parser = new KimiTranscriptParser();

	it("parses a turn.prompt event into a human entry (input array + ms-epoch time)", () => {
		const line = JSON.stringify({
			type: "turn.prompt",
			input: [{ type: "text", text: "Refactor the reader" }],
			origin: { kind: "user" },
			time: 1785887000029,
		});
		expect(parser.parseLine(line, 0)).toEqual({
			role: "human",
			content: "Refactor the reader",
			timestamp: new Date(1785887000029).toISOString(),
		});
	});

	it("parses a content.part text (wrapped in context.append_loop_event) into an assistant entry", () => {
		const line = JSON.stringify({
			type: "context.append_loop_event",
			event: { type: "content.part", part: { type: "text", text: "Done." } },
			time: 1785887143120,
		});
		expect(parser.parseLine(line, 0)).toEqual({
			role: "assistant",
			content: "Done.",
			timestamp: new Date(1785887143120).toISOString(),
		});
	});

	it("accepts a bare (unwrapped) content.part and a string turn.prompt input", () => {
		expect(
			parser.parseLine(JSON.stringify({ type: "content.part", part: { type: "text", text: "yo" } }), 0),
		).toEqual({ role: "assistant", content: "yo", timestamp: undefined });
		expect(parser.parseLine(JSON.stringify({ type: "turn.prompt", input: "hello" }), 0)).toEqual({
			role: "human",
			content: "hello",
			timestamp: undefined,
		});
	});

	it("skips think parts, non-text parts, empty text, and non-conversation events", () => {
		// reasoning
		expect(
			parser.parseLine(
				JSON.stringify({
					type: "context.append_loop_event",
					event: { type: "content.part", part: { type: "think", think: "hmm" } },
				}),
				0,
			),
		).toBeNull();
		// empty assistant text
		expect(
			parser.parseLine(
				JSON.stringify({
					type: "context.append_loop_event",
					event: { type: "content.part", part: { type: "text", text: "  " } },
				}),
				0,
			),
		).toBeNull();
		// a loop event that is not a content.part
		expect(
			parser.parseLine(JSON.stringify({ type: "context.append_loop_event", event: { type: "step.begin" } }), 0),
		).toBeNull();
		// the replayed user message copy is skipped (turn.prompt is the canonical user turn)
		expect(
			parser.parseLine(
				JSON.stringify({ type: "context.append_message", message: { role: "user", content: [] } }),
				0,
			),
		).toBeNull();
		// unrelated events
		expect(parser.parseLine(JSON.stringify({ type: "usage.record", time: 1 }), 0)).toBeNull();
		expect(parser.parseLine(JSON.stringify({ type: "metadata" }), 0)).toBeNull();
	});

	it("returns null for malformed JSON", () => {
		expect(parser.parseLine("{not json", 0)).toBeNull();
	});

	it("parseTimestamp reads the ms-epoch time, a string timestamp, and undefined otherwise", () => {
		expect(parser.parseTimestamp(JSON.stringify({ time: 1785887143120 }))).toBe(
			new Date(1785887143120).toISOString(),
		);
		expect(parser.parseTimestamp(JSON.stringify({ timestamp: "2026-08-06T00:00:00.000Z" }))).toBe(
			"2026-08-06T00:00:00.000Z",
		);
		expect(parser.parseTimestamp(JSON.stringify({ foo: 1 }))).toBeUndefined();
		expect(parser.parseTimestamp("nope")).toBeUndefined();
	});
});

describe("extractKimiText", () => {
	it("handles a string, a text block, an array, and drops non-text", () => {
		expect(extractKimiText("hi")).toBe("hi");
		expect(extractKimiText({ type: "text", text: "hi" })).toBe("hi");
		expect(extractKimiText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe(
			"a\nb",
		);
		expect(extractKimiText({ type: "image", data: "…" })).toBeNull();
		expect(extractKimiText("")).toBeNull();
		expect(extractKimiText(42)).toBeNull();
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

	it("returns KimiTranscriptParser for 'kimi'", () => {
		const parser = getParserForSource("kimi");
		expect(parser).toBeInstanceOf(KimiTranscriptParser);
	});

	it("returns the same singleton instances on repeated calls", () => {
		const a = getParserForSource("codex");
		const b = getParserForSource("codex");
		expect(a).toBe(b);
	});
});

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

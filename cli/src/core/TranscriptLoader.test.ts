import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// sqlite-backed readers are mocked: this file's job is to verify the
// dispatch decision in `loadTranscript`, not to re-test each reader's
// SQLite query plan. Each reader has its own end-to-end test suite
// (OpenCodeTranscriptReader.test.ts, CursorTranscriptReader.test.ts,
// CopilotTranscriptReader.test.ts) that uses real `DatabaseSync` fixtures.
vi.mock("./OpenCodeTranscriptReader.js", () => ({
	readOpenCodeTranscript: vi.fn(),
}));
vi.mock("./CursorTranscriptReader.js", () => ({
	readCursorTranscript: vi.fn(),
}));
vi.mock("./CopilotTranscriptReader.js", () => ({
	readCopilotTranscript: vi.fn(),
}));
vi.mock("./ClineTranscriptReader.js", () => ({
	readClineTranscript: vi.fn(),
}));
vi.mock("./ClineCliTranscriptReader.js", () => ({
	readClineCliTranscript: vi.fn(),
}));

import { readClineCliTranscript } from "./ClineCliTranscriptReader.js";
import { readClineTranscript } from "./ClineTranscriptReader.js";
import { readCopilotTranscript } from "./CopilotTranscriptReader.js";
import { readCursorTranscript } from "./CursorTranscriptReader.js";
import { readOpenCodeTranscript } from "./OpenCodeTranscriptReader.js";
import { loadTranscript } from "./TranscriptLoader.js";

describe("loadTranscript", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "transcript-loader-"));
		vi.mocked(readOpenCodeTranscript).mockReset();
		vi.mocked(readCursorTranscript).mockReset();
		vi.mocked(readCopilotTranscript).mockReset();
		vi.mocked(readClineTranscript).mockReset();
		vi.mocked(readClineCliTranscript).mockReset();
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("loads claude JSONL into TranscriptEntry array (user/assistant)", async () => {
		const file = join(dir, "claude.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"user","message":{"role":"user","content":"hi"}}',
				'{"type":"assistant","message":{"role":"assistant","content":"hello"}}',
				'{"type":"ai-title","aiTitle":"chat"}',
				"",
			].join("\n"),
		);
		const result = await loadTranscript({ source: "claude", transcriptPath: file });
		expect(result).toHaveLength(2);
		expect(result[0].role).toBe("human");
		expect(result[0].content).toBe("hi");
		expect(result[1].role).toBe("assistant");
	});

	it("returns empty array when the file is missing", async () => {
		const result = await loadTranscript({ source: "claude", transcriptPath: join(dir, "missing.jsonl") });
		expect(result).toEqual([]);
	});

	it("skips malformed lines", async () => {
		const file = join(dir, "bad.jsonl");
		writeFileSync(file, 'not json\n{"type":"user","message":{"role":"user","content":"x"}}\n');
		const result = await loadTranscript({ source: "claude", transcriptPath: file });
		expect(result).toHaveLength(1);
	});

	// Codex JSONL schema (verified against real
	// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl produced by codex CLI
	// 0.98.0+): each line is `{ timestamp, type, payload }`. Conversation
	// turns live in `type: "event_msg"` with `payload.type:
	// "user_message" | "agent_message"` — these carry the clean text the
	// user typed and the assistant displayed. The `type: "response_item"`
	// rows mirror the same turns but with system-injected wrappers
	// (`<environment_context>`, `<permissions instructions>`, etc.) and
	// must be skipped. This matches the CodexTranscriptParser used by the
	// post-commit summary pipeline (TranscriptParser.ts) — both consumers
	// share one source of truth.
	it("loads codex JSONL extracting only event_msg/user_message and event_msg/agent_message", async () => {
		const file = join(dir, "codex.jsonl");
		writeFileSync(
			file,
			[
				'{"timestamp":"2026-05-18T10:00:00.000Z","type":"session_meta","payload":{"id":"s1","cwd":"/x"}}',
				'{"timestamp":"2026-05-18T10:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}',
				// response_item turns are the system-injected wrappers — must be skipped
				'{"timestamp":"2026-05-18T10:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context><cwd>/x</cwd></environment_context>"}]}}',
				// the matching event_msg/user_message is the clean text — kept
				'{"timestamp":"2026-05-18T10:00:03.000Z","type":"event_msg","payload":{"type":"user_message","message":"hi"}}',
				'{"timestamp":"2026-05-18T10:00:04.000Z","type":"turn_context","payload":{"x":1}}',
				'{"timestamp":"2026-05-18T10:00:05.000Z","type":"response_item","payload":{"type":"reasoning","summary":[]}}',
				'{"timestamp":"2026-05-18T10:00:06.000Z","type":"event_msg","payload":{"type":"agent_message","message":"hello"}}',
				// function_call rows are NOT conversation turns
				'{"timestamp":"2026-05-18T10:00:07.000Z","type":"response_item","payload":{"type":"function_call","name":"bash"}}',
				'{"timestamp":"2026-05-18T10:00:08.000Z","type":"response_item","payload":{"type":"function_call_output","output":"ok"}}',
				"",
			].join("\n"),
		);
		const result = await loadTranscript({ source: "codex", transcriptPath: file });
		expect(result).toHaveLength(2);
		expect(result[0].role).toBe("human");
		expect(result[0].content).toBe("hi");
		expect(result[0].timestamp).toBe("2026-05-18T10:00:03.000Z");
		expect(result[1].role).toBe("assistant");
		expect(result[1].content).toBe("hello");
	});

	it("skips codex message lines with empty body", async () => {
		const file = join(dir, "codex-empty.jsonl");
		writeFileSync(
			file,
			'{"timestamp":"2026-05-18T10:00:00.000Z","type":"event_msg","payload":{"type":"user_message","message":""}}\n',
		);
		const result = await loadTranscript({ source: "codex", transcriptPath: file });
		expect(result).toEqual([]);
	});

	it("loads gemini (single JSON document, via GeminiTranscriptReader)", async () => {
		const file = join(dir, "gemini-session.json");
		writeFileSync(
			file,
			JSON.stringify({
				sessionId: "s1",
				messages: [
					{ id: "m1", type: "user", timestamp: "2026-05-15T00:00:00Z", content: "hi gemini" },
					{ id: "m2", type: "gemini", timestamp: "2026-05-15T00:00:01Z", content: "hello back" },
					{ id: "m3", type: "info", timestamp: "2026-05-15T00:00:02Z", content: "skipped" },
				],
			}),
		);
		const result = await loadTranscript({ source: "gemini", transcriptPath: file });
		expect(result).toHaveLength(2);
		expect(result[0].role).toBe("human");
		expect(result[0].content).toBe("hi gemini");
		expect(result[1].role).toBe("assistant");
	});

	it("returns empty array for gemini when file is missing", async () => {
		const result = await loadTranscript({
			source: "gemini",
			transcriptPath: join(dir, "missing.json"),
		});
		expect(result).toEqual([]);
	});

	// sqlite-backed sources (opencode/cursor/copilot) dispatch to dedicated
	// async readers — same pattern as gemini, not the JSONL line parsers.
	// transcriptPath is the synthetic "<dbPath>#<sessionId>" format produced
	// by each session discoverer.
	it("dispatches opencode source to readOpenCodeTranscript with the synthetic path", async () => {
		vi.mocked(readOpenCodeTranscript).mockResolvedValueOnce({
			entries: [
				{ role: "human", content: "opencode hi" },
				{ role: "assistant", content: "opencode reply" },
			],
			newCursor: { transcriptPath: "/db.sqlite#sess-1", lineNumber: 2, updatedAt: "2026-05-17T00:00:00Z" },
			totalLinesRead: 2,
		});
		const result = await loadTranscript({ source: "opencode", transcriptPath: "/db.sqlite#sess-1" });
		expect(readOpenCodeTranscript).toHaveBeenCalledWith("/db.sqlite#sess-1");
		expect(result).toEqual([
			{ role: "human", content: "opencode hi" },
			{ role: "assistant", content: "opencode reply" },
		]);
	});

	it("dispatches cursor source to readCursorTranscript with the synthetic path", async () => {
		vi.mocked(readCursorTranscript).mockResolvedValueOnce({
			entries: [{ role: "human", content: "cursor hi" }],
			newCursor: { transcriptPath: "/state.vscdb#composer-1", lineNumber: 1, updatedAt: "2026-05-17T00:00:00Z" },
			totalLinesRead: 1,
		});
		const result = await loadTranscript({ source: "cursor", transcriptPath: "/state.vscdb#composer-1" });
		expect(readCursorTranscript).toHaveBeenCalledWith("/state.vscdb#composer-1");
		expect(result).toEqual([{ role: "human", content: "cursor hi" }]);
	});

	it("dispatches copilot source to readCopilotTranscript with the synthetic path", async () => {
		vi.mocked(readCopilotTranscript).mockResolvedValueOnce({
			entries: [{ role: "assistant", content: "copilot reply" }],
			newCursor: { transcriptPath: "/session-store.db#sess-1", lineNumber: 1, updatedAt: "2026-05-17T00:00:00Z" },
			totalLinesRead: 1,
		});
		const result = await loadTranscript({ source: "copilot", transcriptPath: "/session-store.db#sess-1" });
		expect(readCopilotTranscript).toHaveBeenCalledWith("/session-store.db#sess-1");
		expect(result).toEqual([{ role: "assistant", content: "copilot reply" }]);
	});

	it("dispatches cline source to readClineTranscript with the synthetic path", async () => {
		vi.mocked(readClineTranscript).mockResolvedValueOnce({
			entries: [{ role: "human", content: "cline hi" }],
			newCursor: {
				transcriptPath: "/cline/task-1/ui_messages.json",
				lineNumber: 1,
				updatedAt: "2026-05-17T00:00:00Z",
			},
			totalLinesRead: 1,
		});
		const result = await loadTranscript({ source: "cline", transcriptPath: "/cline/task-1/ui_messages.json" });
		expect(readClineTranscript).toHaveBeenCalledWith("/cline/task-1/ui_messages.json");
		expect(result).toEqual([{ role: "human", content: "cline hi" }]);
	});

	it("dispatches cline-cli source to readClineCliTranscript with the synthetic path", async () => {
		vi.mocked(readClineCliTranscript).mockResolvedValueOnce({
			entries: [{ role: "assistant", content: "cline-cli reply" }],
			newCursor: {
				transcriptPath: "/cline-cli/session-1.json",
				lineNumber: 1,
				updatedAt: "2026-05-17T00:00:00Z",
			},
			totalLinesRead: 1,
		});
		const result = await loadTranscript({ source: "cline-cli", transcriptPath: "/cline-cli/session-1.json" });
		expect(readClineCliTranscript).toHaveBeenCalledWith("/cline-cli/session-1.json");
		expect(result).toEqual([{ role: "assistant", content: "cline-cli reply" }]);
	});

	// Each sqlite-backed reader's catch branch — proves loader errors degrade
	// to "" instead of bubbling out to the panel.
	it("returns [] when readOpenCodeTranscript throws", async () => {
		vi.mocked(readOpenCodeTranscript).mockRejectedValueOnce(new Error("missing #sessionId"));
		const result = await loadTranscript({ source: "opencode", transcriptPath: "/no-hash-path" });
		expect(result).toEqual([]);
	});

	it("returns [] when readCursorTranscript throws", async () => {
		vi.mocked(readCursorTranscript).mockRejectedValueOnce(new Error("locked"));
		const result = await loadTranscript({ source: "cursor", transcriptPath: "/state.vscdb#x" });
		expect(result).toEqual([]);
	});

	it("returns [] when readCopilotTranscript throws", async () => {
		vi.mocked(readCopilotTranscript).mockRejectedValueOnce(new Error("schema drift"));
		const result = await loadTranscript({ source: "copilot", transcriptPath: "/session-store.db#x" });
		expect(result).toEqual([]);
	});

	it("returns [] when readClineTranscript throws", async () => {
		vi.mocked(readClineTranscript).mockRejectedValueOnce(new Error("parse error"));
		const result = await loadTranscript({ source: "cline", transcriptPath: "/cline/task-x/ui_messages.json" });
		expect(result).toEqual([]);
	});

	it("returns [] when readClineCliTranscript throws", async () => {
		vi.mocked(readClineCliTranscript).mockRejectedValueOnce(new Error("parse error"));
		const result = await loadTranscript({ source: "cline-cli", transcriptPath: "/cline-cli/session-x.json" });
		expect(result).toEqual([]);
	});

	// ENOENT is the "expected absence" branch — readers can race with the
	// source app rotating / pruning the file, so a missing DB must not log
	// at warn level. Mock the rejection with a real fs-shaped ENOENT object
	// for each sqlite-backed dispatch so both halves of the `isEnoent`
	// branch (warn / silent) are exercised.
	const enoent = (path: string): NodeJS.ErrnoException => {
		const e: NodeJS.ErrnoException = new Error(`ENOENT: no such file, open '${path}'`);
		e.code = "ENOENT";
		return e;
	};

	it("returns [] silently when readOpenCodeTranscript throws ENOENT (no warn branch)", async () => {
		vi.mocked(readOpenCodeTranscript).mockRejectedValueOnce(enoent("/missing.db"));
		const result = await loadTranscript({ source: "opencode", transcriptPath: "/missing.db#x" });
		expect(result).toEqual([]);
	});

	it("returns [] silently when readCursorTranscript throws ENOENT (no warn branch)", async () => {
		vi.mocked(readCursorTranscript).mockRejectedValueOnce(enoent("/missing.vscdb"));
		const result = await loadTranscript({ source: "cursor", transcriptPath: "/missing.vscdb#x" });
		expect(result).toEqual([]);
	});

	it("returns [] silently when readCopilotTranscript throws ENOENT (no warn branch)", async () => {
		vi.mocked(readCopilotTranscript).mockRejectedValueOnce(enoent("/missing.db"));
		const result = await loadTranscript({ source: "copilot", transcriptPath: "/missing.db#x" });
		expect(result).toEqual([]);
	});

	it("returns [] silently when readClineTranscript throws ENOENT (no warn branch)", async () => {
		vi.mocked(readClineTranscript).mockRejectedValueOnce(enoent("/missing/ui_messages.json"));
		const result = await loadTranscript({ source: "cline", transcriptPath: "/missing/ui_messages.json" });
		expect(result).toEqual([]);
	});

	it("returns [] silently when readClineCliTranscript throws ENOENT (no warn branch)", async () => {
		vi.mocked(readClineCliTranscript).mockRejectedValueOnce(enoent("/missing/session-x.json"));
		const result = await loadTranscript({ source: "cline-cli", transcriptPath: "/missing/session-x.json" });
		expect(result).toEqual([]);
	});

	it("loads copilot-chat JSONL patch documents", async () => {
		const file = join(dir, "cc.jsonl");
		writeFileSync(
			file,
			[
				'{"value":{"message":{"text":"user msg","role":"user"}}}',
				'{"value":{"message":{"text":"asst reply","role":"assistant"}}}',
				'{"value":{"message":{"text":"other","role":"system"}}}',
				'{"value":{"message":{"role":"user"}}}',
				'{"value":{}}',
				"",
			].join("\n"),
		);
		const result = await loadTranscript({ source: "copilot-chat", transcriptPath: file });
		expect(result).toHaveLength(2);
		expect(result[0].role).toBe("human");
		expect(result[0].content).toBe("user msg");
		expect(result[1].role).toBe("assistant");
	});

	it("skips claude lines with empty array content", async () => {
		const file = join(dir, "claude-empty.jsonl");
		writeFileSync(file, '{"type":"user","message":{"role":"user","content":[]}}\n');
		const result = await loadTranscript({ source: "claude", transcriptPath: file });
		expect(result).toEqual([]);
	});

	it("loads claude array content joined with newline (real Anthropic API shape)", async () => {
		// Real Claude transcripts use the Anthropic content-block format:
		// `[{type:"text", text:"..."}]` — bare strings and items without
		// `type:"text"` are NOT real Claude entries. The canonical
		// `extractContent` (TranscriptReader.ts) only joins type:"text"
		// blocks, matching the post-commit summary pipeline.
		const file = join(dir, "claude-arr.jsonl");
		writeFileSync(
			file,
			'{"type":"user","message":{"role":"user","content":[{"type":"text","text":"x"},{"type":"text","text":"y"}]}}\n',
		);
		const result = await loadTranscript({ source: "claude", transcriptPath: file });
		expect(result).toHaveLength(1);
		expect(result[0].content).toBe("x\ny");
	});

	// Silent-failure observability:
	// • A line that fails JSON.parse increments parseSkipped and triggers
	//   the end-of-stream debug log (still continues the stream).
	// • Opening a directory in place of a file rejects with EISDIR — the
	//   non-ENOENT branch of the outer catch is exercised.
	it("counts and skips per-line JSON parse failures without aborting the stream", async () => {
		const file = join(dir, "claude-mixed.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"user","message":{"role":"user","content":"hi"}}',
				"this is not json",
				'{"type":"assistant","message":{"role":"assistant","content":"hello"}}',
				"",
			].join("\n"),
		);
		const result = await loadTranscript({ source: "claude", transcriptPath: file });
		expect(result.map((e) => e.content)).toEqual(["hi", "hello"]);
	});

	it("returns [] without throwing when the stream cannot be opened (non-ENOENT)", async () => {
		const result = await loadTranscript({ source: "claude", transcriptPath: dir });
		expect(result).toEqual([]);
	});

	it("returns [] without throwing when the gemini transcript path is a directory (non-ENOENT)", async () => {
		const result = await loadTranscript({ source: "gemini", transcriptPath: dir });
		expect(result).toEqual([]);
	});

	// `stringify`'s default branch — claude entry whose `content` is neither
	// a string nor an array (e.g. a number). The parser returns undefined
	// for that row, so it's omitted from the output.
	it("drops claude lines whose content is neither string nor array (stringify default branch)", async () => {
		const file = join(dir, "claude-num-content.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"user","message":{"role":"user","content":42}}',
				'{"type":"assistant","message":{"role":"assistant","content":"kept"}}',
				"",
			].join("\n"),
		);
		const result = await loadTranscript({ source: "claude", transcriptPath: file });
		expect(result.map((e) => e.content)).toEqual(["kept"]);
	});

	// extractContent's array branch (TranscriptReader.ts): non-`type:"text"`
	// blocks — thinking blocks, tool_use blocks, malformed objects — are
	// silently filtered out, matching what the post-commit summary
	// pipeline already does. Only text blocks contribute to the joined
	// content; the entry survives as long as at least one text block did.
	it("extractContent array path drops non-text blocks (thinking / malformed / bare values)", async () => {
		const file = join(dir, "claude-mixed-blocks.jsonl");
		writeFileSync(
			file,
			[
				// Mix: thinking block (dropped), text block (kept), tool_use
				// block (dropped), missing-type object (dropped), bare string
				// (dropped — canonical only accepts {type:"text", text}).
				'{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"answer"},{"type":"tool_use","name":"bash"},{"foo":"x"},"bare"]}}',
				"",
			].join("\n"),
		);
		const result = await loadTranscript({ source: "claude", transcriptPath: file });
		expect(result).toHaveLength(1);
		expect(result[0].content).toBe("answer");
	});

	it("stringify returns undefined for an empty-array content (no parts contributed)", async () => {
		const file = join(dir, "claude-empty-arr.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"user","message":{"role":"user","content":[]}}',
				'{"type":"assistant","message":{"role":"assistant","content":"survives"}}',
				"",
			].join("\n"),
		);
		const result = await loadTranscript({ source: "claude", transcriptPath: file });
		expect(result.map((e) => e.content)).toEqual(["survives"]);
	});

	// Empty / blank lines are skipped via the early `continue` — they never
	// reach the parser. Pairs with the parseSkipped non-zero path.
	it("skips empty/blank lines without invoking parser", async () => {
		const file = join(dir, "blanks.jsonl");
		writeFileSync(
			file,
			[
				"",
				'{"type":"user","message":{"role":"user","content":"first"}}',
				"",
				'{"type":"assistant","message":{"role":"assistant","content":"second"}}',
				"",
			].join("\n"),
		);
		const result = await loadTranscript({ source: "claude", transcriptPath: file });
		expect(result.map((e) => e.content)).toEqual(["first", "second"]);
	});

	// Gemini reader path with ENOENT — must not log, must return [].
	it("returns [] silently when gemini transcript file does not exist (ENOENT)", async () => {
		const result = await loadTranscript({ source: "gemini", transcriptPath: join(dir, "missing.json") });
		expect(result).toEqual([]);
	});

	// copilot-chat parser branches: missing message, non-string text, role
	// in neither "user" nor "assistant" — each returns undefined and the
	// row is silently skipped.
	it("drops copilot-chat lines missing the message field or unknown role", async () => {
		const file = join(dir, "cc-edge.jsonl");
		writeFileSync(
			file,
			[
				// value.message missing entirely — early return.
				'{"value":{}}',
				// text is non-string — early return.
				'{"value":{"message":{"text":42,"role":"user"}}}',
				// role neither user nor assistant — early return.
				'{"value":{"message":{"text":"x","role":"system"}}}',
				// Good row — kept.
				'{"value":{"message":{"text":"valid","role":"user"}}}',
				"",
			].join("\n"),
		);
		const result = await loadTranscript({ source: "copilot-chat", transcriptPath: file });
		expect(result).toEqual([{ role: "human", content: "valid" }]);
	});

	// Scan A of CopilotChatSessionDiscoverer reads `~/.copilot/session-state/
	// <sid>/events.jsonl` — Copilot CLI runtime's event stream surfaced as
	// "Copilot Chat with copilotcli-backend models". Schema is
	//   { type, id, parentId, timestamp, data }
	// with messages typed as `user.message` / `assistant.message`. The
	// remaining event types (session.start/shutdown, system.message,
	// assistant.turn_start/end, tool.execution_*) are noise from the
	// transcript-display perspective and must be silently skipped.
	it("loads copilot-chat events.jsonl envelope (Copilot CLI runtime)", async () => {
		const file = join(dir, "cc-events.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"session.start","data":{"sessionId":"s"},"timestamp":"2026-05-18T02:29:41.877Z"}',
				'{"type":"system.message","data":{"role":"system","content":"sys prompt"}}',
				'{"type":"user.message","data":{"content":"why no chat?"},"timestamp":"2026-05-18T02:29:42.000Z"}',
				'{"type":"assistant.turn_start","data":{}}',
				'{"type":"assistant.message","data":{"content":"let me check","toolRequests":[{"id":"t1"}]},"timestamp":"2026-05-18T02:29:43.000Z"}',
				'{"type":"tool.execution_start","data":{"toolId":"t1"}}',
				'{"type":"tool.execution_complete","data":{"toolId":"t1","result":"ok"}}',
				'{"type":"assistant.turn_end","data":{}}',
				'{"type":"session.shutdown","data":{}}',
				"",
			].join("\n"),
		);
		const result = await loadTranscript({ source: "copilot-chat", transcriptPath: file });
		expect(result).toEqual([
			{ role: "human", content: "why no chat?", timestamp: "2026-05-18T02:29:42.000Z" },
			{ role: "assistant", content: "let me check", timestamp: "2026-05-18T02:29:43.000Z" },
		]);
	});

	// events.jsonl edge cases: a `user.message` / `assistant.message` whose
	// `data.content` is missing or non-string is unusable; an unrelated
	// `type` value falls through with nothing to render. All three skip
	// silently, leaving only well-formed messages.
	it("drops copilot-chat events.jsonl lines with missing/non-string content or unknown type", async () => {
		const file = join(dir, "cc-events-edge.jsonl");
		writeFileSync(
			file,
			[
				// user.message with non-string content — skip.
				'{"type":"user.message","data":{"content":42}}',
				// assistant.message with no content field — skip.
				'{"type":"assistant.message","data":{}}',
				// completely unknown type — skip.
				'{"type":"telemetry.heartbeat","data":{"ts":1}}',
				// Good row to anchor the assertion.
				'{"type":"user.message","data":{"content":"kept"}}',
				"",
			].join("\n"),
		);
		const result = await loadTranscript({ source: "copilot-chat", transcriptPath: file });
		expect(result).toEqual([{ role: "human", content: "kept" }]);
	});
});

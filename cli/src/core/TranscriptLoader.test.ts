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
vi.mock("./DevinTranscriptReader.js", () => ({
	readDevinTranscript: vi.fn(),
}));
vi.mock("./CursorCliTranscriptReader.js", () => ({
	readCursorCliTranscript: vi.fn(),
}));
// Hybrid mocks for the two readers that some tests still exercise against real
// files — the spy delegates to the actual implementation by default so dispatch
// tests keep working, and individual tests can override with
// `mockRejectedValueOnce` to force a non-ENOENT throw path.
vi.mock("./GeminiTranscriptReader.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./GeminiTranscriptReader.js")>();
	return { ...actual, readGeminiTranscript: vi.fn(actual.readGeminiTranscript) };
});
vi.mock("./AntigravityTranscriptReader.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./AntigravityTranscriptReader.js")>();
	return { ...actual, readAntigravityTranscript: vi.fn(actual.readAntigravityTranscript) };
});

import { readAntigravityTranscript } from "./AntigravityTranscriptReader.js";
import { readClineCliTranscript } from "./ClineCliTranscriptReader.js";
import { readClineTranscript } from "./ClineTranscriptReader.js";
import { readCopilotTranscript } from "./CopilotTranscriptReader.js";
import { readCursorCliTranscript } from "./CursorCliTranscriptReader.js";
import { readCursorTranscript } from "./CursorTranscriptReader.js";
import { readDevinTranscript } from "./DevinTranscriptReader.js";
import { readGeminiTranscript } from "./GeminiTranscriptReader.js";
import { readOpenCodeTranscript } from "./OpenCodeTranscriptReader.js";
import { loadTranscript } from "./TranscriptLoader.js";

/** An ENOENT-coded error — the shape every reader-level "file is gone" surfaces as.
 * Optional `path` is appended in the message form real Node errors carry, for tests
 * that want a specific file mentioned. */
function enoent(path?: string): NodeJS.ErrnoException {
	const message = path ? `ENOENT: no such file or directory, open '${path}'` : "ENOENT: no such file or directory";
	const err = new Error(message) as NodeJS.ErrnoException;
	err.code = "ENOENT";
	return err;
}

function readResult(entries: Array<{ role: "human" | "assistant"; content: string }>, path: string) {
	return {
		entries,
		newCursor: { transcriptPath: path, lineNumber: entries.length, updatedAt: "2026-07-19T00:00:00Z" },
		totalLinesRead: entries.length,
	};
}

describe("loadTranscript", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "transcript-loader-"));
		vi.mocked(readOpenCodeTranscript).mockReset();
		vi.mocked(readCursorTranscript).mockReset();
		vi.mocked(readCopilotTranscript).mockReset();
		vi.mocked(readClineTranscript).mockReset();
		vi.mocked(readClineCliTranscript).mockReset();
		vi.mocked(readDevinTranscript).mockReset();
		vi.mocked(readCursorCliTranscript).mockReset();
		// Hybrid mocks: clear call history but keep the real implementation as
		// the default so file-backed dispatch tests still work; individual tests
		// override with `mockRejectedValueOnce` to force non-ENOENT throw paths.
		vi.mocked(readGeminiTranscript).mockClear();
		vi.mocked(readAntigravityTranscript).mockClear();
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

	it("loads codex JSONL extracting response_item/message user+assistant turns (event_msg retired, injections skipped)", async () => {
		const file = join(dir, "codex.jsonl");
		writeFileSync(
			file,
			[
				'{"timestamp":"2026-05-18T10:00:00.000Z","type":"session_meta","payload":{"id":"s1","cwd":"/x"}}',
				'{"timestamp":"2026-05-18T10:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}',
				// injected system wrapper as a user-role response_item — must be skipped
				'{"timestamp":"2026-05-18T10:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context><cwd>/x</cwd></environment_context>"}]}}',
				// genuine user turn — kept
				'{"timestamp":"2026-05-18T10:00:03.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}',
				// event_msg conversation turns are RETIRED — Codex stopped writing them and they now duplicate response_item; must be skipped
				'{"timestamp":"2026-05-18T10:00:04.000Z","type":"event_msg","payload":{"type":"user_message","message":"stale duplicate"}}',
				'{"timestamp":"2026-05-18T10:00:05.000Z","type":"turn_context","payload":{"x":1}}',
				'{"timestamp":"2026-05-18T10:00:06.000Z","type":"response_item","payload":{"type":"reasoning","summary":[]}}',
				// genuine assistant turn — kept
				'{"timestamp":"2026-05-18T10:00:07.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}',
				'{"timestamp":"2026-05-18T10:00:08.000Z","type":"event_msg","payload":{"type":"agent_message","message":"stale agent duplicate"}}',
				// function_call rows are NOT conversation turns
				'{"timestamp":"2026-05-18T10:00:09.000Z","type":"response_item","payload":{"type":"function_call","name":"bash"}}',
				'{"timestamp":"2026-05-18T10:00:10.000Z","type":"response_item","payload":{"type":"function_call_output","output":"ok"}}',
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
		expect(result[1].timestamp).toBe("2026-05-18T10:00:07.000Z");
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

	it("loads kimi wire.jsonl extracting turn.prompt + content.part text (skipping think)", async () => {
		const file = join(dir, "wire.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"metadata","protocol_version":1}',
				'{"type":"turn.prompt","input":[{"type":"text","text":"do it"}],"time":1785887000029}',
				'{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"think","think":"planning"}},"time":1785887000030}',
				'{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"done"}},"time":1785887000031}',
				"",
			].join("\n"),
		);
		const result = await loadTranscript({ source: "kimi", transcriptPath: file });
		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({ role: "human", content: "do it" });
		expect(result[1]).toMatchObject({ role: "assistant", content: "done" });
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

	it("dispatches cursor source to the JSONL reader when discovery upgraded the path", async () => {
		// `upgradeToJsonlTranscripts` points an IDE composer at its `agent-transcripts`
		// JSONL whenever one exists — measured, 4 of 4 composers on a real machine. That
		// path has no `#composerId`, so the composer-store reader THROWS on it, and this
		// function's catch turns a throw into an EMPTY transcript: the conversation
		// detail pane would render "no entries" for a conversation full of them.
		const jsonl = "/Users/me/.cursor/projects/enc/agent-transcripts/u1/u1.jsonl";
		vi.mocked(readCursorCliTranscript).mockResolvedValueOnce(
			readResult([{ role: "human", content: "from the jsonl" }], jsonl),
		);
		const result = await loadTranscript({ source: "cursor", transcriptPath: jsonl });
		expect(readCursorCliTranscript).toHaveBeenCalledWith(jsonl);
		expect(readCursorTranscript).not.toHaveBeenCalled();
		expect(result).toEqual([{ role: "human", content: "from the jsonl" }]);
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

	it("dispatches antigravity source to readAntigravityTranscript (reads the real jsonl)", async () => {
		const file = join(dir, "transcript_full.jsonl");
		writeFileSync(
			file,
			`${[
				{
					type: "USER_INPUT",
					created_at: "2026-07-19T09:46:50Z",
					content: "<USER_REQUEST>\nhi\n</USER_REQUEST>",
				},
				{ type: "PLANNER_RESPONSE", created_at: "2026-07-19T09:46:51Z", content: "hello" },
			]
				.map((l) => JSON.stringify(l))
				.join("\n")}\n`,
		);
		const result = await loadTranscript({ source: "antigravity", transcriptPath: file });
		expect(result).toEqual([
			{ role: "human", content: "hi", timestamp: "2026-07-19T09:46:50Z" },
			{ role: "assistant", content: "hello", timestamp: "2026-07-19T09:46:51Z" },
		]);
	});

	it("returns [] for a missing antigravity transcript", async () => {
		const result = await loadTranscript({ source: "antigravity", transcriptPath: join(dir, "nope.jsonl") });
		expect(result).toEqual([]);
	});

	it("dispatches devin source to readDevinTranscript with the synthetic db#session path", async () => {
		const path = "/devin/sessions.db#sess-1";
		vi.mocked(readDevinTranscript).mockResolvedValueOnce(
			readResult([{ role: "human", content: "devin ask" }], path),
		);
		const result = await loadTranscript({ source: "devin", transcriptPath: path });
		expect(readDevinTranscript).toHaveBeenCalledWith(path);
		expect(result).toEqual([{ role: "human", content: "devin ask" }]);
	});

	it("dispatches cursor-cli source to readCursorCliTranscript", async () => {
		const path = "/cursor/agent-transcripts/u1/u1.jsonl";
		vi.mocked(readCursorCliTranscript).mockResolvedValueOnce(
			readResult([{ role: "assistant", content: "cursor-cli reply" }], path),
		);
		const result = await loadTranscript({ source: "cursor-cli", transcriptPath: path });
		expect(readCursorCliTranscript).toHaveBeenCalledWith(path);
		expect(result).toEqual([{ role: "assistant", content: "cursor-cli reply" }]);
	});

	// Two arms per reader: a vanished file (ENOENT) is routine and must stay
	// silent, while anything else is worth a warning. Both degrade to [] so a
	// single unreadable session never takes down the panel.
	it.each([
		["devin", readDevinTranscript, "/devin/sessions.db#sess-1"],
		["cursor-cli", readCursorCliTranscript, "/cursor/u1.jsonl"],
		["antigravity", readAntigravityTranscript, "/agy/transcript_full.jsonl"],
	] as const)("returns [] when the %s reader throws, ENOENT or otherwise", async (source, reader, path) => {
		vi.mocked(reader).mockRejectedValueOnce(enoent(path));
		expect(await loadTranscript({ source, transcriptPath: path })).toEqual([]);

		vi.mocked(reader).mockRejectedValueOnce(new Error("schema drift"));
		expect(await loadTranscript({ source, transcriptPath: path })).toEqual([]);
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
	// at warn level. The shared `enoent(path)` helper at the top of the file
	// produces the fs-shaped error; these tests exercise both halves of the
	// `isEnoent` branch (warn / silent) per dispatch.

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

	// Gemini reader swallows its own file-read errors and returns empty by
	// default — so the outer catch in loadTranscript is normally not entered.
	// Force each branch via the hybrid mock so both stay exercised.
	// (devin / cursor-cli / antigravity are already covered by the it.each
	// "returns [] when the %s reader throws, ENOENT or otherwise" above.)
	it("returns [] and warns when readGeminiTranscript throws a non-ENOENT error", async () => {
		vi.mocked(readGeminiTranscript).mockRejectedValueOnce(new Error("gemini: corrupted json"));
		const result = await loadTranscript({
			source: "gemini",
			transcriptPath: "/some/path.json",
		});
		expect(result).toEqual([]);
	});

	it("returns [] silently when readGeminiTranscript throws ENOENT (no warn)", async () => {
		vi.mocked(readGeminiTranscript).mockRejectedValueOnce(enoent("/missing.json"));
		const result = await loadTranscript({
			source: "gemini",
			transcriptPath: "/missing.json",
		});
		expect(result).toEqual([]);
	});

	// copilot-chat's per-line parser throws on invalid JSON (JSON.parse), so
	// unparseable lines increment `parseSkipped` inside the stream loop and
	// the end-of-stream `parseSkipped > 0` debug log fires. This is the only
	// source whose parser throws today — claude/codex parsers return
	// undefined on schema drift instead.
	it("increments the skip counter for unparseable copilot-chat lines and logs the total", async () => {
		const file = join(dir, "cc-mixed.jsonl");
		writeFileSync(
			file,
			[
				"this is not json at all",
				'{"value":{"message":{"text":"kept","role":"user"}}}',
				"another bogus line ]}[",
				"",
			].join("\n"),
		);
		const result = await loadTranscript({ source: "copilot-chat", transcriptPath: file });
		expect(result).toEqual([{ role: "human", content: "kept" }]);
	});
});

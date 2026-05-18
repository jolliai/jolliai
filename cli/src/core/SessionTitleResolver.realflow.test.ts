/**
 * Real-flow tests for resolveSessionTitle that exercise each per-source
 * line parser end-to-end by writing actual transcript files to a tmpdir.
 *
 * The sibling test file `SessionTitleResolver.test.ts` mocks FallbackTitle
 * so the per-source PARSE_LINE functions are never invoked. This file does
 * NOT mock anything — it pins behavior of every parseXxxUserLine branch.
 *
 * For sources whose real transcripts are NOT JSONL (gemini is a single JSON
 * document, copilot-chat is sqlite-backed), the per-line parsers in
 * SessionTitleResolver are unreachable in production. We still cover their
 * branches with synthetic JSONL inputs that match each parser's match path.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSessionTitle } from "./SessionTitleResolver.js";

describe("resolveSessionTitle — real-flow fallback parsing", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "resolver-flow-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("codex: parses role:user lines", async () => {
		const file = join(dir, "codex.jsonl");
		writeFileSync(file, '{"role":"user","content":"refactor the auth layer"}\n');
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "codex",
		});
		expect(title).toBe("refactor the auth layer");
	});

	it("codex: parses array-content user lines", async () => {
		const file = join(dir, "codex-arr.jsonl");
		writeFileSync(file, '{"role":"user","content":[{"text":"part a"},{"text":"part b"}]}\n');
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "codex",
		});
		expect(title).toBe("part a part b");
	});

	it("codex: skips non-user lines and returns first user body", async () => {
		const file = join(dir, "codex-mixed.jsonl");
		writeFileSync(
			file,
			['{"role":"assistant","content":"first reply"}', '{"role":"user","content":"hello there"}', ""].join("\n"),
		);
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "codex",
		});
		expect(title).toBe("hello there");
	});

	it("claude: falls back to first user message when no ai-title row exists", async () => {
		const file = join(dir, "claude.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"system","content":"setup"}',
				'{"type":"user","message":{"content":"plain user message"}}',
				"",
			].join("\n"),
		);
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "claude",
		});
		expect(title).toBe("plain user message");
	});

	it("claude: parses array-content user message", async () => {
		const file = join(dir, "claude-arr.jsonl");
		writeFileSync(file, '{"type":"user","message":{"content":[{"text":"alpha"},{"text":"beta"}]}}\n');
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "claude",
		});
		expect(title).toBe("alpha beta");
	});

	it("claude: uses top-level content when message.content is missing", async () => {
		const file = join(dir, "claude-flat.jsonl");
		writeFileSync(file, '{"type":"user","content":"flat content"}\n');
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "claude",
		});
		expect(title).toBe("flat content");
	});

	// stringifyContent fallthrough: when `content` is neither string nor
	// array (e.g. a number, an object lacking a `text` field, undefined),
	// the parser returns undefined and the scan keeps looking. The next
	// valid user line still wins. Pins the default-branch behavior so a
	// future refactor that lets through "[object Object]" trips this test.
	it("claude: stringifyContent returns undefined for non-string/non-array content, scan continues", async () => {
		const file = join(dir, "claude-nonstring-content.jsonl");
		writeFileSync(
			file,
			[
				// content is a number — stringifyContent default branch.
				'{"type":"user","message":{"content":42}}',
				// Then a valid user row. Its body should be returned.
				'{"type":"user","message":{"content":"second user wins"}}',
				"",
			].join("\n"),
		);
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "claude",
		});
		expect(title).toBe("second user wins");
	});

	it("codex: stringifyContent skips array-content with no text blocks (next user wins)", async () => {
		const file = join(dir, "codex-empty-arr.jsonl");
		writeFileSync(
			file,
			[
				// Empty array → stringifyContent returns undefined.
				'{"role":"user","content":[]}',
				// Array of objects with no `text` field — same default branch.
				'{"role":"user","content":[{"unrelated":"x"}]}',
				// First parseable user row.
				'{"role":"user","content":"codex valid"}',
				"",
			].join("\n"),
		);
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "codex",
		});
		expect(title).toBe("codex valid");
	});

	it("gemini: parses type:user lines with array-of-parts content (real schema)", async () => {
		// Real Gemini transcripts mark user turns with `type: "user"` and
		// store content as either a string or a `[{ text: "..." }, ...]`
		// Part array — see GeminiTranscriptReader for the canonical shape.
		// Earlier the parser checked `role: "user"` and never matched, so
		// every Gemini session fell through to (untitled session).
		const file = join(dir, "gemini-parts.jsonl");
		writeFileSync(file, '{"type":"user","content":[{"text":"build a calc"},{"text":"in react"}]}\n');
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "gemini",
		});
		expect(title).toBe("build a calc in react");
	});

	it("gemini: parses type:user with bare-string content", async () => {
		const file = join(dir, "gemini-string.jsonl");
		writeFileSync(file, '{"type":"user","content":"hello gemini"}\n');
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "gemini",
		});
		expect(title).toBe("hello gemini");
	});

	it("gemini: top-level text field is the final fallback when content is absent", async () => {
		// Defensive — the canonical schema uses `content`, but the parser
		// still accepts a top-level `text` as a final fallback in case a
		// future Gemini variant promotes it. This pins that fallback.
		const file = join(dir, "gemini-text-fallback.jsonl");
		writeFileSync(file, '{"type":"user","text":"text-only fallback"}\n');
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "gemini",
		});
		expect(title).toBe("text-only fallback");
	});

	it("copilot-chat: per-line parser handles {value:{message:{text}}} (synthetic)", async () => {
		// Real Copilot Chat is sqlite-backed; the per-line parser is
		// unreachable in practice but defined for completeness.
		const file = join(dir, "synthetic-cc.jsonl");
		writeFileSync(file, '{"value":{"message":{"text":"hello copilot chat","role":"user"}}}\n');
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "copilot-chat",
		});
		expect(title).toBe("hello copilot chat");
	});

	it("copilot-chat: parser uses value.content when no message.text", async () => {
		const file = join(dir, "synthetic-cc2.jsonl");
		writeFileSync(file, '{"value":{"content":"plain content"}}\n');
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "copilot-chat",
		});
		expect(title).toBe("plain content");
	});

	it("copilot-chat: returns UNTITLED when value is absent/non-object", async () => {
		const file = join(dir, "synthetic-cc3.jsonl");
		writeFileSync(file, '{"unrelated":"shape"}\n');
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "copilot-chat",
		});
		expect(title).toBe("(untitled session)");
	});

	// copilot-chat: line that fails JSON.parse — `safeParse` catches and
	// returns undefined; parser short-circuits on the `if (!obj)` guard.
	it("copilot-chat: skips lines that fail JSON.parse and reads the next valid one", async () => {
		const file = join(dir, "cc-mixed.jsonl");
		writeFileSync(
			file,
			["this is not json", '{"value":{"message":{"text":"valid","role":"user"}}}', ""].join("\n"),
		);
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "copilot-chat",
		});
		expect(title).toBe("valid");
	});

	// copilot-chat shape B — the `~/.copilot/session-state/<sid>/events.jsonl`
	// flavor that TranscriptLoader.parseCopilotChat already handles. Before
	// this branch existed, the detail panel would render the conversation
	// correctly (loader supports it) while the sidebar title stayed at
	// "(untitled session)" — a split the design doc explicitly rules out.
	it("copilot-chat: per-line parser handles {type:'user.message', data:{content}} event envelope", async () => {
		const file = join(dir, "synthetic-cc-event.jsonl");
		writeFileSync(file, '{"type":"user.message","data":{"content":"event-envelope hello"}}\n');
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "copilot-chat",
		});
		expect(title).toBe("event-envelope hello");
	});

	// Non-user event types must not be picked up as title candidates —
	// `assistant.message`, `session.start`, etc. should fall through to
	// the next valid user.message row.
	it("copilot-chat: skips non-user.message event types and continues", async () => {
		const file = join(dir, "cc-event-mixed.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"session.start","data":{"content":"meta"}}',
				'{"type":"assistant.message","data":{"content":"I am the assistant"}}',
				'{"type":"user.message","data":{"content":"the real first user turn"}}',
				"",
			].join("\n"),
		);
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "copilot-chat",
		});
		expect(title).toBe("the real first user turn");
	});

	// user.message with non-string content (e.g. data.content is an array
	// of `{ text }` blocks) flows through stringifyContent's array branch,
	// joining the text fragments with spaces.
	it("copilot-chat: user.message with structured content array stringifies the parts", async () => {
		const file = join(dir, "cc-event-array.jsonl");
		writeFileSync(file, '{"type":"user.message","data":{"content":[{"text":"hello"},{"text":"world"}]}}\n');
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "copilot-chat",
		});
		expect(title).toBe("hello world");
	});

	// user.message with unparseable content (data.content is a number)
	// must fall through to the outer return rather than coercing to "42";
	// stringifyContent only handles strings and array-of-blocks.
	it("copilot-chat: user.message with unstringifiable content falls through", async () => {
		const file = join(dir, "cc-event-bad.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"user.message","data":{"content":42}}',
				'{"type":"user.message","data":{"content":"second wins"}}',
				"",
			].join("\n"),
		);
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "copilot-chat",
		});
		expect(title).toBe("second wins");
	});

	// copilot-chat: `if (text)` evaluates falsy when stringifyContent
	// returned a non-empty result that the truthiness check accepts. The
	// inverse path — content present but stringifyContent returns
	// undefined → `text` is undefined → `if (text)` falsy → fall through
	// to the outer `return undefined`. Combined with a follow-up valid
	// row this pins the cascade.
	it("copilot-chat: when content is present but unstringifiable, scan continues", async () => {
		const file = join(dir, "cc-unstring.jsonl");
		writeFileSync(
			file,
			[
				// value.content present but is a number — stringifyContent
				// returns undefined → outer parser returns undefined → continue.
				'{"value":{"content":42}}',
				'{"value":{"message":{"text":"second wins","role":"user"}}}',
				"",
			].join("\n"),
		);
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "copilot-chat",
		});
		expect(title).toBe("second wins");
	});

	// gemini parser: `type` is something other than "user" — early return.
	// parseGeminiUserLine: `{type:"user"}` with neither stringifiable `content`
	// nor a top-level `text` string falls through to the trailing
	// `return undefined`. Pins the falsy arm of `if (typeof text === "string")`
	// so neither the bare-text fallback path nor its inverse can regress.
	it("gemini: type:user with no content and no text falls through to UNTITLED", async () => {
		const file = join(dir, "gemini-empty-user.jsonl");
		writeFileSync(
			file,
			[
				// stringifyContent rejects: content is a number, not string/array.
				'{"type":"user","content":42}',
				// text is a number, also unstringifiable through the fallback.
				'{"type":"user","text":999}',
				// No content, no text at all.
				'{"type":"user"}',
				"",
			].join("\n"),
		);
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "gemini",
		});
		expect(title).toBe("(untitled session)");
	});

	// parseCopilotChatUserLine shape B: `{type:"user.message"}` without a
	// `data` field — `if (data && typeof data === "object")` short-circuits
	// to false and the parser returns undefined. Combined with a follow-up
	// valid line, verifies the scan continues rather than aborting on the
	// malformed envelope.
	it("copilot-chat: user.message without data field falls through, next valid line wins", async () => {
		const file = join(dir, "cc-event-no-data.jsonl");
		writeFileSync(
			file,
			[
				// data field absent
				'{"type":"user.message"}',
				// data is a number — fails the `typeof data === "object"` guard
				'{"type":"user.message","data":7}',
				// data is null — fails the truthiness guard
				'{"type":"user.message","data":null}',
				// Valid envelope after the malformed ones.
				'{"type":"user.message","data":{"content":"finally"}}',
				"",
			].join("\n"),
		);
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "copilot-chat",
		});
		expect(title).toBe("finally");
	});

	it("gemini: skips non-user type lines", async () => {
		const file = join(dir, "gemini-assistant.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"gemini","content":"not the title"}',
				'{"type":"info","content":"some info"}',
				'{"type":"user","content":"this one"}',
				"",
			].join("\n"),
		);
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "gemini",
		});
		expect(title).toBe("this one");
	});

	// stringifyContent: array branch where the element is a bare string
	// (not an object with `.text`). Covered through claude's parser, which
	// flows array entries through stringifyContent.
	it("claude: stringifyContent joins array elements that are bare strings", async () => {
		const file = join(dir, "claude-bare-strs.jsonl");
		writeFileSync(file, '{"type":"user","message":{"content":["alpha","beta"]}}\n');
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "claude",
		});
		expect(title).toBe("alpha beta");
	});

	// `session.source ?? "claude"` — when the SessionInfo predates the
	// multi-source schema and has no `source` field, the resolver must
	// default to claude and use the claude parser cascade.
	it("defaults to the claude parser when session.source is undefined", async () => {
		const file = join(dir, "no-source.jsonl");
		writeFileSync(file, '{"type":"user","message":{"content":"claude default"}}\n');
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			// source intentionally omitted — exercises the `?? "claude"` arm.
		});
		expect(title).toBe("claude default");
	});

	// claude parseClaudeUserLine: safeParse returns undefined for unparseable
	// JSON — the parser short-circuits via `if (!obj) return undefined`.
	it("claude: skips lines that fail JSON.parse, finds next valid user message", async () => {
		const file = join(dir, "claude-bad-then-good.jsonl");
		writeFileSync(
			file,
			["this is not json at all", '{"type":"user","message":{"content":"good claude"}}', ""].join("\n"),
		);
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "claude",
		});
		expect(title).toBe("good claude");
	});

	// codex parseCodexUserLine: safeParse returns undefined for unparseable JSON.
	it("codex: skips lines that fail JSON.parse, finds next valid user message", async () => {
		const file = join(dir, "codex-bad-then-good.jsonl");
		writeFileSync(file, ["not json", '{"role":"user","content":"good codex"}', ""].join("\n"));
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "codex",
		});
		expect(title).toBe("good codex");
	});

	// gemini parser: safeParse returns undefined for unparseable JSON.
	it("gemini: skips lines that fail JSON.parse and reads the next valid one", async () => {
		const file = join(dir, "gemini-mixed.jsonl");
		writeFileSync(file, ["this is not json", '{"type":"user","content":"gemini valid"}', ""].join("\n"));
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "gemini",
		});
		expect(title).toBe("gemini valid");
	});

	// stringifyContent's array branch: an element that is NEITHER a string
	// NOR an object (e.g. a number) is skipped. Subsequent string-shaped
	// elements still contribute.
	it("claude: stringifyContent skips array elements that are neither string nor object", async () => {
		const file = join(dir, "claude-mixed-arr.jsonl");
		writeFileSync(file, '{"type":"user","message":{"content":[42, "kept", true, {"text":"also-kept"}]}}\n');
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "claude",
		});
		expect(title).toBe("kept also-kept");
	});

	it("returns UNTITLED_SESSION for a transcript with no user messages", async () => {
		const file = join(dir, "empty.jsonl");
		writeFileSync(file, '{"role":"assistant","content":"hi"}\n');
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "codex",
		});
		expect(title).toBe("(untitled session)");
	});

	it("opencode/cursor/copilot: parsers return undefined intentionally; falls back to UNTITLED", async () => {
		// These three sources always carry SessionInfo.title from their discoverer.
		// If we somehow get here without a native title (e.g., empty title at row time),
		// the per-line parser returns undefined and we fall through.
		const file = join(dir, "any.jsonl");
		writeFileSync(file, '{"role":"user","content":"anything"}\n');
		for (const source of ["opencode", "cursor", "copilot"] as const) {
			const title = await resolveSessionTitle({
				sessionId: "s",
				transcriptPath: file,
				updatedAt: "2026-05-15T00:00:00Z",
				source,
			});
			expect(title).toBe("(untitled session)");
		}
	});

	it("ignores malformed JSON lines and falls through", async () => {
		const file = join(dir, "bad.jsonl");
		writeFileSync(
			file,
			["not json at all", '"just a string"', '{"role":"user","content":"real one"}', ""].join("\n"),
		);
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "codex",
		});
		expect(title).toBe("real one");
	});

	it("ignores content arrays with no extractable text", async () => {
		const file = join(dir, "empty-blocks.jsonl");
		writeFileSync(
			file,
			['{"role":"user","content":[{"image":"x"},{}]}', '{"role":"user","content":"final"}', ""].join("\n"),
		);
		const title = await resolveSessionTitle({
			sessionId: "s",
			transcriptPath: file,
			updatedAt: "2026-05-15T00:00:00Z",
			source: "codex",
		});
		expect(title).toBe("final");
	});
});

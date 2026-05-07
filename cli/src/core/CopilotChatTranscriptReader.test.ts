import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _deleteAtPath, _replayPatches, _setAtPath, readCopilotChatTranscript } from "./CopilotChatTranscriptReader.js";

describe("_setAtPath", () => {
	it("sets a leaf string key on an object", () => {
		const doc: Record<string, unknown> = { a: { b: 1 } };
		_setAtPath(doc, ["a", "b"], 42);
		expect(doc).toEqual({ a: { b: 42 } });
	});

	it("creates intermediate objects when string segments are missing", () => {
		const doc: Record<string, unknown> = {};
		_setAtPath(doc, ["a", "b", "c"], "x");
		expect(doc).toEqual({ a: { b: { c: "x" } } });
	});

	it("creates intermediate arrays when next segment is numeric", () => {
		const doc: Record<string, unknown> = {};
		_setAtPath(doc, ["requests", 0, "message"], { text: "hi" });
		expect(doc).toEqual({ requests: [{ message: { text: "hi" } }] });
	});

	it("appends to an existing array at the next index", () => {
		const doc: Record<string, unknown> = { requests: [{ message: { text: "first" } }] };
		_setAtPath(doc, ["requests", 1], { message: { text: "second" } });
		expect((doc.requests as unknown[]).length).toBe(2);
		expect((doc.requests as unknown[])[1]).toEqual({ message: { text: "second" } });
	});

	it("grows arrays with sparse undefined slots when index is past length", () => {
		const doc: Record<string, unknown> = { requests: [] };
		_setAtPath(doc, ["requests", 2], { v: 1 });
		expect((doc.requests as unknown[]).length).toBe(3);
		expect((doc.requests as unknown[])[0]).toBeUndefined();
		expect((doc.requests as unknown[])[2]).toEqual({ v: 1 });
	});

	it("overwrites an existing leaf value", () => {
		const doc: Record<string, unknown> = { a: 1 };
		_setAtPath(doc, ["a"], 2);
		expect(doc).toEqual({ a: 2 });
	});

	it("handles empty path by replacing nothing (root replacement is replayPatches's job, not ours)", () => {
		const doc: Record<string, unknown> = { a: 1 };
		_setAtPath(doc, [], 99);
		// Empty path is undefined behavior in patch terms — we expect no change here
		// since the caller (replayPatches kind:0) handles root replacement directly.
		expect(doc).toEqual({ a: 1 });
	});
});

describe("_deleteAtPath", () => {
	it("deletes an object property", () => {
		const doc: Record<string, unknown> = { a: 1, b: 2 };
		_deleteAtPath(doc, ["a"]);
		expect(doc).toEqual({ b: 2 });
	});

	it("removes an array element via splice (preserves array semantics)", () => {
		const doc: Record<string, unknown> = { a: [10, 20, 30] };
		_deleteAtPath(doc, ["a", 1]);
		expect(doc.a).toEqual([10, 30]);
	});

	it("is a no-op when the path doesn't exist", () => {
		const doc: Record<string, unknown> = { a: 1 };
		_deleteAtPath(doc, ["b", "c"]);
		expect(doc).toEqual({ a: 1 });
	});

	it("is a no-op for empty path", () => {
		const doc: Record<string, unknown> = { a: 1 };
		_deleteAtPath(doc, []);
		expect(doc).toEqual({ a: 1 });
	});

	it("is a no-op when array index is out of bounds", () => {
		const doc: Record<string, unknown> = { a: [10, 20] };
		_deleteAtPath(doc, ["a", 5]);
		expect(doc.a).toEqual([10, 20]);
	});

	it("is a no-op when an intermediate path segment is null/undefined", () => {
		const doc: Record<string, unknown> = { a: null };
		_deleteAtPath(doc, ["a", "b", "c"]);
		expect(doc).toEqual({ a: null });
		const doc2: Record<string, unknown> = {};
		_deleteAtPath(doc2, ["missing", "child"]);
		expect(doc2).toEqual({});
	});

	it("is a no-op when the parent of the target is null", () => {
		const doc: Record<string, unknown> = { a: { b: null } };
		_deleteAtPath(doc, ["a", "b", "c"]);
		expect(doc).toEqual({ a: { b: null } });
	});
});

describe("_replayPatches", () => {
	it("returns empty doc when input is empty", () => {
		expect(_replayPatches([])).toEqual({});
	});

	it("applies kind:0 as full document replacement", () => {
		const lines = [JSON.stringify({ kind: 0, v: { foo: "bar", requests: [] } })];
		expect(_replayPatches(lines)).toEqual({ foo: "bar", requests: [] });
	});

	it("applies kind:1 as set-at-path", () => {
		const lines = [
			JSON.stringify({ kind: 0, v: { requests: [] } }),
			JSON.stringify({ kind: 1, k: ["requests", 0, "message"], v: { text: "hello" } }),
		];
		expect(_replayPatches(lines)).toEqual({ requests: [{ message: { text: "hello" } }] });
	});

	it("applies kind:2 as delete-at-path", () => {
		const lines = [
			JSON.stringify({ kind: 0, v: { pendingRequests: [{ id: "x" }] } }),
			JSON.stringify({ kind: 2, k: ["pendingRequests", 0] }),
		];
		expect(_replayPatches(lines)).toEqual({ pendingRequests: [] });
	});

	it("applies patches in file order", () => {
		const lines = [
			JSON.stringify({ kind: 0, v: { a: 1 } }),
			JSON.stringify({ kind: 1, k: ["a"], v: 2 }),
			JSON.stringify({ kind: 1, k: ["a"], v: 3 }),
		];
		expect(_replayPatches(lines)).toEqual({ a: 3 });
	});

	it("warns and skips on unknown kind, leaving doc untouched", () => {
		const lines = [
			JSON.stringify({ kind: 0, v: { a: 1 } }),
			JSON.stringify({ kind: 99, k: ["a"], v: "should-be-ignored" }),
		];
		expect(_replayPatches(lines)).toEqual({ a: 1 });
	});

	it("throws on JSON parse failure (caller handles mid-write)", () => {
		const lines = [JSON.stringify({ kind: 0, v: {} }), "{not-json"];
		expect(() => _replayPatches(lines)).toThrow();
	});
});

describe("readCopilotChatTranscript", () => {
	let tmpRoot: string;
	let sessionsDir: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "copilot-chat-reader-"));
		sessionsDir = join(tmpRoot, "chatSessions");
		mkdirSync(sessionsDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	function writeJsonl(name: string, events: object[]): string {
		const path = join(sessionsDir, name);
		writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n"));
		return path;
	}

	it("returns empty entries for an init-only file (cursor.lineNumber stays 0)", async () => {
		const path = writeJsonl("a.jsonl", [{ kind: 0, v: { requests: [] } }]);
		const result = await readCopilotChatTranscript(path);
		expect(result.entries).toEqual([]);
		expect(result.newCursor.transcriptPath).toBe(path);
		expect(result.newCursor.lineNumber).toBe(0);
	});

	it("emits one human + one assistant per request with content", async () => {
		const events = [
			{ kind: 0, v: { requests: [] } },
			{ kind: 1, k: ["requests", 0, "message", "text"], v: "hello" },
			{ kind: 1, k: ["requests", 0, "response"], v: [{ value: "hi there" }] },
		];
		const path = writeJsonl("b.jsonl", events);
		const result = await readCopilotChatTranscript(path);
		expect(result.entries).toEqual([
			{ role: "human", content: "hello" },
			{ role: "assistant", content: "hi there" },
		]);
		expect(result.newCursor.lineNumber).toBe(1);
	});

	it("flattens multi-chunk response[] into a single assistant entry", async () => {
		const events = [
			{ kind: 0, v: { requests: [] } },
			{ kind: 1, k: ["requests", 0, "message", "text"], v: "explain" },
			{ kind: 1, k: ["requests", 0, "response"], v: [{ value: "Part A " }, { value: "Part B" }] },
		];
		const path = writeJsonl("c.jsonl", events);
		const result = await readCopilotChatTranscript(path);
		expect(result.entries.find((e) => e.role === "assistant")?.content).toBe("Part A Part B");
	});

	it("only emits requests at index >= cursor.lineNumber", async () => {
		const events = [
			{ kind: 0, v: { requests: [] } },
			{ kind: 1, k: ["requests", 0, "message", "text"], v: "first" },
			{ kind: 1, k: ["requests", 0, "response"], v: [{ value: "r1" }] },
			{ kind: 1, k: ["requests", 1, "message", "text"], v: "second" },
			{ kind: 1, k: ["requests", 1, "response"], v: [{ value: "r2" }] },
		];
		const path = writeJsonl("d.jsonl", events);
		const result = await readCopilotChatTranscript(path, {
			transcriptPath: path,
			lineNumber: 1,
			updatedAt: "2026-05-06T00:00:00Z",
		});
		expect(result.entries).toEqual([
			{ role: "human", content: "second" },
			{ role: "assistant", content: "r2" },
		]);
		expect(result.newCursor.lineNumber).toBe(2);
	});

	it("skips requests with empty/missing message.text", async () => {
		const events = [
			{ kind: 0, v: { requests: [] } },
			{ kind: 1, k: ["requests", 0, "message", "text"], v: "" },
			{ kind: 1, k: ["requests", 0, "response"], v: [{ value: "answer" }] },
		];
		const path = writeJsonl("e.jsonl", events);
		const result = await readCopilotChatTranscript(path);
		expect(result.entries).toEqual([{ role: "assistant", content: "answer" }]);
	});

	it("skips requests with empty assistant response", async () => {
		const events = [
			{ kind: 0, v: { requests: [] } },
			{ kind: 1, k: ["requests", 0, "message", "text"], v: "question" },
			{ kind: 1, k: ["requests", 0, "response"], v: [] },
		];
		const path = writeJsonl("f.jsonl", events);
		const result = await readCopilotChatTranscript(path);
		expect(result.entries).toEqual([{ role: "human", content: "question" }]);
	});

	it("ignores response chunks whose `value` is missing or non-string", async () => {
		// vscode occasionally emits chunks with no value (e.g. tool-only turns) — these
		// should contribute "" to the joined assistant text rather than blow up.
		const events = [
			{ kind: 0, v: { requests: [] } },
			{ kind: 1, k: ["requests", 0, "message", "text"], v: "Q" },
			{
				kind: 1,
				k: ["requests", 0, "response"],
				v: [{ value: "Hello " }, {}, { value: 42 }, { value: "world" }],
			},
		];
		const path = writeJsonl("g.jsonl", events);
		const result = await readCopilotChatTranscript(path);
		expect(result.entries.find((e) => e.role === "assistant")?.content).toBe("Hello world");
	});

	it("treats response that is not an array as empty (no assistant entry)", async () => {
		const events = [{ kind: 0, v: { requests: [{ message: { text: "ask" }, response: "oops-string" }] } }];
		const path = writeJsonl("h.jsonl", events);
		const result = await readCopilotChatTranscript(path);
		expect(result.entries).toEqual([{ role: "human", content: "ask" }]);
	});

	it("throws CopilotChatScanError on mid-write JSON parse failure (kind=parse)", async () => {
		const path = join(sessionsDir, "g.jsonl");
		writeFileSync(path, `${JSON.stringify({ kind: 0, v: { requests: [] } })}\n{not-json`);
		await expect(readCopilotChatTranscript(path)).rejects.toThrow(/parse/);
	});

	it("throws CopilotChatScanError when file is missing (kind=fs)", async () => {
		await expect(readCopilotChatTranscript(join(sessionsDir, "does-not-exist.jsonl"))).rejects.toThrow(
			/fs|ENOENT/i,
		);
	});

	it("treats empty file as init-less doc → no entries, no throw", async () => {
		const path = join(sessionsDir, "empty.jsonl");
		writeFileSync(path, "");
		const result = await readCopilotChatTranscript(path);
		expect(result.entries).toEqual([]);
	});

	it("throws schema error when requests is not an array", async () => {
		const path = writeJsonl("bad-shape.jsonl", [{ kind: 0, v: { requests: "not-an-array" } }]);
		await expect(readCopilotChatTranscript(path)).rejects.toThrow(/schema|requests/);
	});
});

describe("readCopilotChatTranscript dispatcher", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "copilot-chat-rdr-"));
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("routes <wsHash>/chatSessions/<sid>.jsonl to patch-log reader (yields requests entries)", async () => {
		const wsDir = join(tmpRoot, "ws1", "chatSessions");
		mkdirSync(wsDir, { recursive: true });
		const path = join(wsDir, "abc123.jsonl");
		const lines = [
			JSON.stringify({ kind: 0, v: { requests: [] } }),
			JSON.stringify({
				kind: 1,
				k: ["requests", 0],
				v: { message: { text: "hello" }, response: [{ value: "world" }] },
			}),
		];
		writeFileSync(path, lines.join("\n"));
		const result = await readCopilotChatTranscript(path);
		expect(result.entries).toEqual([
			{ role: "human", content: "hello" },
			{ role: "assistant", content: "world" },
		]);
	});

	it("throws on an unrecognized path pattern", async () => {
		const path = join(tmpRoot, "random", "thing.txt");
		mkdirSync(join(tmpRoot, "random"), { recursive: true });
		writeFileSync(path, "{}");
		await expect(readCopilotChatTranscript(path)).rejects.toThrow(/unrecognized.*path/i);
	});
});

describe("readCopilotChatTranscript via events.jsonl path", () => {
	let tmpRoot: string;
	let sessionDir: string;
	let eventsPath: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "copilot-events-"));
		sessionDir = join(tmpRoot, ".copilot", "session-state", "sess-1");
		mkdirSync(sessionDir, { recursive: true });
		eventsPath = join(sessionDir, "events.jsonl");
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	function writeEvents(events: ReadonlyArray<unknown>): void {
		writeFileSync(eventsPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
	}

	it("emits user.message and non-empty assistant.message in file order", async () => {
		writeEvents([
			{ type: "session.start", data: {}, timestamp: "2026-05-07T10:00:00.000Z" },
			{ type: "system.message", data: { content: "system prompt" }, timestamp: "2026-05-07T10:00:01.000Z" },
			{ type: "user.message", data: { content: "hi" }, timestamp: "2026-05-07T10:00:02.000Z" },
			{ type: "assistant.turn_start", data: {}, timestamp: "2026-05-07T10:00:03.000Z" },
			{ type: "assistant.message", data: { content: "hello there" }, timestamp: "2026-05-07T10:00:04.000Z" },
			{ type: "tool.execution_start", data: {}, timestamp: "2026-05-07T10:00:05.000Z" },
			{ type: "tool.execution_complete", data: {}, timestamp: "2026-05-07T10:00:06.000Z" },
			{ type: "assistant.turn_end", data: {}, timestamp: "2026-05-07T10:00:07.000Z" },
		]);
		const result = await readCopilotChatTranscript(eventsPath);
		expect(result.entries).toEqual([
			{ role: "human", content: "hi", timestamp: "2026-05-07T10:00:02.000Z" },
			{ role: "assistant", content: "hello there", timestamp: "2026-05-07T10:00:04.000Z" },
		]);
		expect(result.newCursor.lineNumber).toBe(8);
	});

	it("drops assistant.message with empty content (tool-only turn)", async () => {
		writeEvents([
			{ type: "user.message", data: { content: "do tool" }, timestamp: "2026-05-07T10:00:00.000Z" },
			{
				type: "assistant.message",
				data: { content: "", toolRequests: [{ name: "shell" }] },
				timestamp: "2026-05-07T10:00:01.000Z",
			},
			{ type: "assistant.message", data: { content: "ok done" }, timestamp: "2026-05-07T10:00:02.000Z" },
		]);
		const result = await readCopilotChatTranscript(eventsPath);
		expect(result.entries).toEqual([
			{ role: "human", content: "do tool", timestamp: "2026-05-07T10:00:00.000Z" },
			{ role: "assistant", content: "ok done", timestamp: "2026-05-07T10:00:02.000Z" },
		]);
	});

	it("returns no entries when file contains only non-conversation events", async () => {
		writeEvents([
			{ type: "session.start", data: {} },
			{ type: "session.shutdown", data: {} },
		]);
		const result = await readCopilotChatTranscript(eventsPath);
		expect(result.entries).toEqual([]);
		expect(result.newCursor.lineNumber).toBe(2);
	});

	it("advances past a malformed line and continues", async () => {
		writeFileSync(
			eventsPath,
			`${[
				JSON.stringify({
					type: "user.message",
					data: { content: "before" },
					timestamp: "2026-05-07T10:00:00.000Z",
				}),
				"{not valid json",
				JSON.stringify({
					type: "assistant.message",
					data: { content: "after" },
					timestamp: "2026-05-07T10:00:01.000Z",
				}),
			].join("\n")}\n`,
		);
		const result = await readCopilotChatTranscript(eventsPath);
		expect(result.entries).toEqual([
			{ role: "human", content: "before", timestamp: "2026-05-07T10:00:00.000Z" },
			{ role: "assistant", content: "after", timestamp: "2026-05-07T10:00:01.000Z" },
		]);
		expect(result.newCursor.lineNumber).toBe(3);
	});

	it("respects cursor.lineNumber as resume point", async () => {
		writeEvents([
			{ type: "user.message", data: { content: "old" }, timestamp: "2026-05-07T09:00:00.000Z" },
			{ type: "assistant.message", data: { content: "old reply" }, timestamp: "2026-05-07T09:00:01.000Z" },
			{ type: "user.message", data: { content: "new" }, timestamp: "2026-05-07T10:00:00.000Z" },
			{ type: "assistant.message", data: { content: "new reply" }, timestamp: "2026-05-07T10:00:01.000Z" },
		]);
		const result = await readCopilotChatTranscript(eventsPath, {
			transcriptPath: eventsPath,
			lineNumber: 2,
			updatedAt: "2026-05-07T09:30:00.000Z",
		});
		expect(result.entries).toEqual([
			{ role: "human", content: "new", timestamp: "2026-05-07T10:00:00.000Z" },
			{ role: "assistant", content: "new reply", timestamp: "2026-05-07T10:00:01.000Z" },
		]);
		expect(result.newCursor.lineNumber).toBe(4);
	});

	it("emits entries with timestamp:undefined when event has no timestamp", async () => {
		writeEvents([
			{ type: "user.message", data: { content: "no-ts" } },
			{ type: "assistant.message", data: { content: "also no-ts" } },
		]);
		const result = await readCopilotChatTranscript(eventsPath);
		expect(result.entries).toEqual([
			{ role: "human", content: "no-ts" },
			{ role: "assistant", content: "also no-ts" },
		]);
	});
});

describe("readCopilotChatTranscript beforeTimestamp gate", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "copilot-cutoff-"));
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("events.jsonl: stops at first event whose timestamp > beforeTimestamp without consuming it", async () => {
		const sessionDir = join(tmpRoot, ".copilot", "session-state", "s1");
		mkdirSync(sessionDir, { recursive: true });
		const path = join(sessionDir, "events.jsonl");
		writeFileSync(
			path,
			`${[
				JSON.stringify({
					type: "user.message",
					data: { content: "early" },
					timestamp: "2026-05-07T09:00:00.000Z",
				}),
				JSON.stringify({
					type: "assistant.message",
					data: { content: "early reply" },
					timestamp: "2026-05-07T09:00:30.000Z",
				}),
				JSON.stringify({
					type: "user.message",
					data: { content: "late" },
					timestamp: "2026-05-07T11:00:00.000Z",
				}),
			].join("\n")}\n`,
		);
		const result = await readCopilotChatTranscript(path, undefined, "2026-05-07T10:00:00.000Z");
		expect(result.entries).toEqual([
			{ role: "human", content: "early", timestamp: "2026-05-07T09:00:00.000Z" },
			{ role: "assistant", content: "early reply", timestamp: "2026-05-07T09:00:30.000Z" },
		]);
		// Cursor must NOT advance past the unconsumed late line — it sits at line 2.
		expect(result.newCursor.lineNumber).toBe(2);
	});

	it("events.jsonl: events without timestamp are emitted (treated as before-cutoff)", async () => {
		const sessionDir = join(tmpRoot, ".copilot", "session-state", "s2");
		mkdirSync(sessionDir, { recursive: true });
		const path = join(sessionDir, "events.jsonl");
		writeFileSync(
			path,
			`${[
				JSON.stringify({ type: "user.message", data: { content: "untimed" } }),
				JSON.stringify({ type: "assistant.message", data: { content: "untimed reply" } }),
			].join("\n")}\n`,
		);
		const result = await readCopilotChatTranscript(path, undefined, "2026-05-07T10:00:00.000Z");
		expect(result.entries.length).toBe(2);
	});

	it("patch log: stops emitting at first request whose timestamp > beforeTimestamp without advancing cursor past it", async () => {
		const wsDir = join(tmpRoot, "ws1", "chatSessions");
		mkdirSync(wsDir, { recursive: true });
		const path = join(wsDir, "p1.jsonl");
		writeFileSync(
			path,
			[
				JSON.stringify({ kind: 0, v: { requests: [] } }),
				JSON.stringify({
					kind: 1,
					k: ["requests", 0],
					v: {
						message: { text: "early" },
						response: [{ value: "early reply" }],
						timestamp: Date.parse("2026-05-07T09:00:00.000Z"),
					},
				}),
				JSON.stringify({
					kind: 1,
					k: ["requests", 1],
					v: {
						message: { text: "late" },
						response: [{ value: "late reply" }],
						timestamp: Date.parse("2026-05-07T11:00:00.000Z"),
					},
				}),
			].join("\n"),
		);
		const result = await readCopilotChatTranscript(path, undefined, "2026-05-07T10:00:00.000Z");
		expect(result.entries).toEqual([
			{ role: "human", content: "early" },
			{ role: "assistant", content: "early reply" },
		]);
		// Cursor stays at requests[1] so the next read picks up "late".
		expect(result.newCursor.lineNumber).toBe(1);
	});

	it("patch log: requests without numeric timestamp are emitted (treated as before-cutoff)", async () => {
		const wsDir = join(tmpRoot, "ws1", "chatSessions");
		mkdirSync(wsDir, { recursive: true });
		const path = join(wsDir, "p2.jsonl");
		writeFileSync(
			path,
			[
				JSON.stringify({ kind: 0, v: { requests: [] } }),
				JSON.stringify({
					kind: 1,
					k: ["requests", 0],
					v: { message: { text: "no-ts" }, response: [{ value: "no-ts reply" }] },
				}),
			].join("\n"),
		);
		const result = await readCopilotChatTranscript(path, undefined, "2026-05-07T10:00:00.000Z");
		expect(result.entries.length).toBe(2);
	});
});

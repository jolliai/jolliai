import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import type { ToolCallCount, TranscriptCursor } from "../Types.js";
import { createHermesDb, type HermesSessionInput } from "../testUtils/hermesDbFixture.js";
import { readHermesTranscript } from "./HermesTranscriptReader.js";

/** 2026-08-26T03:00:00Z and onwards, in the epoch SECONDS Hermes stores. */
const T0 = Date.UTC(2026, 7, 26, 3, 0, 0) / 1000;
const at = (offsetSec: number): number => T0 + offsetSec;

const SESSION_ID = "20260826_110913_b7d8a8";

function bucket(toolUse: ReadonlyArray<ToolCallCount> | undefined, name: string): ToolCallCount | undefined {
	return toolUse?.find((t) => t.name === name);
}

describe("HermesTranscriptReader", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "hermes-reader-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function dbWith(
		session: Partial<HermesSessionInput> & Pick<HermesSessionInput, "messages">,
	): Promise<string> {
		const dbPath = await createHermesDb(tempDir, [{ id: SESSION_ID, startedAt: T0, cwd: "/tmp/proj", ...session }]);
		return `${dbPath}#${SESSION_ID}`;
	}

	describe("conversation", () => {
		it("maps user/assistant rows and drops tool-result rows", async () => {
			const path = await dbWith({
				messages: [
					{ role: "user", content: "check the hooks", timestamp: at(0) },
					{ role: "assistant", content: "Looking into it.", timestamp: at(1) },
					{ role: "tool", toolName: "terminal", content: '{"output": "..."}', timestamp: at(2) },
					{ role: "assistant", content: "Hermes supports hooks.", timestamp: at(3) },
				],
			});
			const result = await readHermesTranscript(path);
			expect(result.entries).toEqual([
				{ role: "human", content: "check the hooks", timestamp: new Date(at(0) * 1000).toISOString() },
				{
					// The two assistant turns are consecutive once the tool row is
					// dropped, so `mergeConsecutiveEntries` folds them into one.
					role: "assistant",
					content: "Looking into it.\n\nHermes supports hooks.",
					timestamp: new Date(at(1) * 1000).toISOString(),
				},
			]);
			expect(result.totalLinesRead).toBe(4);
			expect(result.newCursor.lineNumber).toBe(4);
			expect(result.newCursor.anchorId).toBe("4");
		});

		it("skips empty and system rows without losing their tool calls", async () => {
			// An assistant turn that is PURE tool calls carries `content: ""`, so the
			// tally is the only record left of that activity.
			const path = await dbWith({
				messages: [
					{ role: "system", content: "you are hermes", timestamp: at(0) },
					{ role: "assistant", content: "", timestamp: at(1), toolCalls: [{ id: "c1", name: "terminal" }] },
					{ role: "assistant", content: "   ", timestamp: at(2), displayKind: "hidden" },
				],
			});
			const result = await readHermesTranscript(path);
			expect(result.entries).toEqual([]);
			expect(bucket(result.toolUse, "terminal")?.calls).toBe(1);
		});

		it("returns an empty-but-present toolUse for a session that called nothing", async () => {
			// EMPTY is the positive claim "no tools"; ABSENT would mean "this source
			// cannot report tools at all" — see TOOL_RECORDING_SOURCES.
			const path = await dbWith({ messages: [{ role: "user", content: "hi", timestamp: at(0) }] });
			const result = await readHermesTranscript(path);
			expect(result.toolUse).toEqual([]);
		});

		it("reads a session with no rows at all", async () => {
			const path = await dbWith({ messages: [] });
			const result = await readHermesTranscript(path);
			expect(result.entries).toEqual([]);
			expect(result.newCursor.anchorId).toBeUndefined();
		});
	});

	describe("which rows count as history", () => {
		it("keeps compaction-archived turns and the summary, drops rewound ones", async () => {
			const path = await dbWith({
				messages: [
					// Replaced by a compaction: active=0 but compacted=1 — real history.
					{ role: "user", content: "the original ask", timestamp: at(0), active: 0, compacted: 1 },
					// The summary Hermes inserted in their place.
					{
						role: "assistant",
						content: "Summary of earlier turns.",
						timestamp: at(1),
						compressedSummary: 1,
					},
					// Rewound by the user: active=0, compacted=0 — explicitly undone.
					{ role: "user", content: "a turn I took back", timestamp: at(2), active: 0, compacted: 0 },
					{ role: "user", content: "what I actually asked", timestamp: at(3) },
				],
			});
			const result = await readHermesTranscript(path);
			expect(result.entries.map((e) => e.content)).toEqual([
				"the original ask",
				"Summary of earlier turns.",
				"what I actually asked",
			]);
		});
	});

	describe("tool calls", () => {
		it("classifies builtin, MCP and skill calls, stamped with the row's own instant", async () => {
			const path = await dbWith({
				messages: [
					{
						role: "assistant",
						content: "working",
						timestamp: at(10),
						toolCalls: [
							{ id: "c1", name: "terminal", args: { command: "ls" } },
							// A DIRECT `mcp__` name — the Tier 0 shape, where the session has
							// nothing deferrable so everything is called by its own name. The
							// BRIDGED shape a session with MCP servers actually produces is the
							// next test; both are real and both must classify.
							{ id: "c2", name: "mcp__jollimemory__search", args: { query: "x" } },
							{ id: "c3", name: "skill_view", args: { name: "hermes-agent" } },
						],
					},
				],
			});
			const result = await readHermesTranscript(path);
			expect(bucket(result.toolUse, "terminal")).toMatchObject({ kind: "builtin", calls: 1 });
			expect(bucket(result.toolUse, "jollimemory.search")).toMatchObject({
				kind: "mcp",
				server: "jollimemory",
				calls: 1,
			});
			// Re-attributed to the SKILL, not counted as one builtin named skill_view:
			// "which skills does this person use" is the question being asked.
			expect(bucket(result.toolUse, "hermes-agent")).toMatchObject({ kind: "skill", calls: 1 });
			for (const name of ["terminal", "jollimemory.search", "hermes-agent"]) {
				expect(bucket(result.toolUse, name)?.lastCallAtMs).toBe(at(10) * 1000);
			}
		});

		it("rounds a fractional-second timestamp to integer ms — the sink is INTEGER", async () => {
			// Hermes' `messages.timestamp` column is REAL, and a real capture from
			// this machine had timestamps like 1787729417.26218 — a bare `* 1000`
			// leaks 1787729417262.18 (a float) into `lastCallAtMs`, which
			// `session_tool_use.last_call_at_ms` refuses ("cannot store REAL value
			// in INTEGER column") and takes the whole `commit.summary` projection
			// down under retry. The reader rounds at source so no consumer has to.
			const path = await dbWith({
				messages: [
					{
						role: "assistant",
						content: "working",
						timestamp: 1_787_729_417.26218,
						toolCalls: [{ id: "c1", name: "terminal", args: { command: "ls" } }],
					},
				],
			});
			const result = await readHermesTranscript(path);
			const atMs = bucket(result.toolUse, "terminal")?.lastCallAtMs;
			expect(atMs).toBeDefined();
			expect(Number.isInteger(atMs)).toBe(true);
			expect(atMs).toBe(1_787_729_417_262);
		});

		it("unwraps the tool_call bridge to the real MCP server", async () => {
			// The exact `tool_calls` value captured from a real Hermes v0.20.5 run
			// against a live MCP server. Progressive tool disclosure hides MCP tools
			// behind a `tool_call` bridge, so reading `function.name` alone files every
			// MCP call in this product as one `builtin:tool_call` bucket — which reads
			// as "this person uses no MCP servers".
			const dbPath = await createHermesDb(tempDir, [{ id: SESSION_ID, startedAt: T0, cwd: "/tmp/proj" }]);
			const { DatabaseSync } = await import("node:sqlite");
			const db = new DatabaseSync(dbPath);
			db.prepare(
				`INSERT INTO messages (session_id, role, content, tool_calls, timestamp, active, compacted, _compressed_summary)
				 VALUES (:s, 'assistant', '', :tc, :ts, 1, 0, 0)`,
			).run({
				s: SESSION_ID,
				tc: JSON.stringify([
					{
						id: "toolu_011FZXzcqEhjFYhaEqUq6vRy",
						call_id: "toolu_011FZXzcqEhjFYhaEqUq6vRy",
						response_item_id: "fc_toolu_011FZXzcqEhjFYhaEqUq6vRy",
						type: "function",
						function: {
							name: "tool_call",
							arguments: '{"name": "mcp__jollimemory__search", "arguments": {"query": "hermes"}}',
						},
					},
				]),
				ts: at(1),
			});
			db.close();
			const result = await readHermesTranscript(`${dbPath}#${SESSION_ID}`);
			expect(bucket(result.toolUse, "jollimemory.search")).toMatchObject({
				kind: "mcp",
				server: "jollimemory",
				calls: 1,
			});
		});

		it("counts each call once, keyed on its own id", async () => {
			const path = await dbWith({
				messages: [
					{
						role: "assistant",
						content: "",
						timestamp: at(1),
						toolCalls: [
							{ id: "c1", name: "terminal" },
							{ id: "c2", name: "terminal" },
						],
					},
					// Same call id again (a re-read of an overlapping slice must not double-count).
					{ role: "assistant", content: "", timestamp: at(2), toolCalls: [{ id: "c1", name: "terminal" }] },
				],
			});
			const result = await readHermesTranscript(path);
			expect(bucket(result.toolUse, "terminal")?.calls).toBe(2);
		});

		it("keeps a skill_view whose arguments name no skill as a builtin", async () => {
			const path = await dbWith({
				messages: [
					{ role: "assistant", content: "", timestamp: at(1), toolCalls: [{ id: "c1", name: "skill_view" }] },
				],
			});
			const result = await readHermesTranscript(path);
			expect(bucket(result.toolUse, "skill_view")).toMatchObject({ kind: "builtin", calls: 1 });
		});

		it("keeps a skill_view with unreadable arguments as a builtin", async () => {
			// `function.arguments` is a JSON STRING, so every way it can fail to yield
			// a skill name has to degrade to the builtin rather than drop the call:
			// unparseable, a JSON scalar, and an object with no usable `name`.
			const dbPath = await createHermesDb(tempDir, [{ id: SESSION_ID, startedAt: T0, cwd: "/tmp/proj" }]);
			const { DatabaseSync } = await import("node:sqlite");
			const db = new DatabaseSync(dbPath);
			const insert = db.prepare(
				`INSERT INTO messages (session_id, role, content, tool_calls, timestamp, active, compacted, _compressed_summary)
				 VALUES (:s, 'assistant', '', :tc, :ts, 1, 0, 0)`,
			);
			for (const [i, args] of ["{not json", "123", "null", '{"name":""}', '{"name":7}'].entries()) {
				insert.run({
					s: SESSION_ID,
					tc: JSON.stringify([{ id: `c${i}`, function: { name: "skill_view", arguments: args } }]),
					ts: at(i),
				});
			}
			db.close();
			const result = await readHermesTranscript(`${dbPath}#${SESSION_ID}`);
			expect(result.toolUse).toHaveLength(1);
			expect(bucket(result.toolUse, "skill_view")).toMatchObject({ kind: "builtin", calls: 5 });
		});

		it("tolerates malformed tool_calls payloads", async () => {
			// Raw writes: unparseable JSON, a non-array, a null entry, an entry with no
			// name, and a bare `{name}` with no `function` wrapper (a flattened schema
			// must still count rather than silently reporting zero).
			const dbPath = await createHermesDb(tempDir, [{ id: SESSION_ID, startedAt: T0, cwd: "/tmp/proj" }]);
			const { DatabaseSync } = await import("node:sqlite");
			const db = new DatabaseSync(dbPath);
			const insert = db.prepare(
				`INSERT INTO messages (session_id, role, content, tool_calls, timestamp, active, compacted, _compressed_summary)
				 VALUES (:s, 'assistant', '', :tc, :ts, 1, 0, 0)`,
			);
			insert.run({ s: SESSION_ID, tc: "{not json", ts: at(1) });
			insert.run({ s: SESSION_ID, tc: '{"not":"an array"}', ts: at(2) });
			insert.run({ s: SESSION_ID, tc: '[null, {}, {"function":{"name":""}}]', ts: at(3) });
			insert.run({ s: SESSION_ID, tc: '[{"name":"flattened"}]', ts: at(4) });
			db.close();
			const result = await readHermesTranscript(`${dbPath}#${SESSION_ID}`);
			expect(result.toolUse?.map((t) => t.name)).toEqual(["flattened"]);
		});

		it("falls back to call_id, empty arguments and a NULL content row", async () => {
			// Three shapes real rows take: a `tool_calls` entry carrying only
			// `call_id` (no `id`), a `skill_view` whose `arguments` is the empty
			// string, and a row whose `content` column is NULL rather than "".
			const dbPath = await createHermesDb(tempDir, [{ id: SESSION_ID, startedAt: T0, cwd: "/tmp/proj" }]);
			const { DatabaseSync } = await import("node:sqlite");
			const db = new DatabaseSync(dbPath);
			db.prepare(
				`INSERT INTO messages (session_id, role, content, tool_calls, timestamp, active, compacted, _compressed_summary)
				 VALUES (:s, 'assistant', NULL, :tc, :ts, 1, 0, 0)`,
			).run({
				s: SESSION_ID,
				tc: JSON.stringify([
					{ call_id: "only-call-id", function: { name: "terminal" } },
					{ id: "c2", function: { name: "skill_view", arguments: "" } },
				]),
				ts: at(1),
			});
			db.close();
			const result = await readHermesTranscript(`${dbPath}#${SESSION_ID}`);
			expect(result.entries).toEqual([]);
			expect(bucket(result.toolUse, "terminal")).toMatchObject({ kind: "builtin", calls: 1 });
			expect(bucket(result.toolUse, "skill_view")).toMatchObject({ kind: "builtin", calls: 1 });
		});

		it("counts a call on an untimed row without inventing an instant", async () => {
			const dbPath = await createHermesDb(tempDir, [{ id: SESSION_ID, startedAt: T0, cwd: "/tmp/proj" }]);
			const { DatabaseSync } = await import("node:sqlite");
			const db = new DatabaseSync(dbPath);
			db.prepare(
				`INSERT INTO messages (session_id, role, content, tool_calls, timestamp, active, compacted, _compressed_summary)
				 VALUES (:s, 'assistant', '', '[{"id":"c1","function":{"name":"terminal"}}]', 'drifted', 1, 0, 0)`,
			).run({ s: SESSION_ID });
			db.close();
			const result = await readHermesTranscript(`${dbPath}#${SESSION_ID}`);
			expect(bucket(result.toolUse, "terminal")).toMatchObject({ calls: 1 });
			expect(bucket(result.toolUse, "terminal")?.lastCallAtMs).toBeUndefined();
		});
	});

	describe("resuming", () => {
		const threeTurns: HermesSessionInput["messages"] = [
			{ role: "user", content: "one", timestamp: at(0) },
			{ role: "assistant", content: "two", timestamp: at(1) },
			{ role: "user", content: "three", timestamp: at(2) },
		];

		it("resumes after the anchored row", async () => {
			const path = await dbWith({ messages: threeTurns });
			const cursor: TranscriptCursor = {
				transcriptPath: path,
				lineNumber: 2,
				updatedAt: new Date().toISOString(),
				anchorId: "2",
			};
			const result = await readHermesTranscript(path, cursor);
			expect(result.entries.map((e) => e.content)).toEqual(["three"]);
			expect(result.totalLinesRead).toBe(1);
			expect(result.newCursor.anchorId).toBe("3");
		});

		it("resumes positionally from a cursor written before anchors existed", async () => {
			const path = await dbWith({ messages: threeTurns });
			const cursor: TranscriptCursor = {
				transcriptPath: path,
				lineNumber: 2,
				updatedAt: new Date().toISOString(),
			};
			const result = await readHermesTranscript(path, cursor);
			expect(result.entries.map((e) => e.content)).toEqual(["three"]);
		});

		it("prefers the anchor over a stale position after a rewind shortened the sequence", async () => {
			// Row 2 was rewound away. A positional resume at 2 would land on the LAST
			// row and skip nothing visible here — but the anchor is what makes the
			// resume point mean the same thing before and after the shrink.
			const path = await dbWith({
				messages: [
					{ role: "user", content: "one", timestamp: at(0) },
					{ role: "assistant", content: "rewound", timestamp: at(1), active: 0, compacted: 0 },
					{ role: "user", content: "three", timestamp: at(2) },
				],
			});
			const cursor: TranscriptCursor = {
				transcriptPath: path,
				lineNumber: 2,
				updatedAt: new Date().toISOString(),
				anchorId: "1",
			};
			const result = await readHermesTranscript(path, cursor);
			expect(result.entries.map((e) => e.content)).toEqual(["three"]);
		});

		it("falls back to the clamped position when the anchor is gone", async () => {
			const path = await dbWith({ messages: threeTurns });
			const cursor: TranscriptCursor = {
				transcriptPath: path,
				lineNumber: 99,
				updatedAt: new Date().toISOString(),
				anchorId: "4242",
			};
			const result = await readHermesTranscript(path, cursor);
			expect(result.entries).toEqual([]);
			// The stale anchor is re-pointed at a row that actually exists rather than
			// carried forward — the next read then resumes from a real position.
			expect(result.newCursor.anchorId).toBe("3");
		});

		it("carries the incoming anchor forward when there is nothing to anchor on", async () => {
			const path = await dbWith({ messages: [] });
			const cursor: TranscriptCursor = {
				transcriptPath: path,
				lineNumber: 0,
				updatedAt: new Date().toISOString(),
				anchorId: "7",
			};
			const result = await readHermesTranscript(path, cursor);
			expect(result.newCursor.anchorId).toBe("7");
		});

		it("ignores a non-numeric anchor and uses the position", async () => {
			const path = await dbWith({ messages: threeTurns });
			const cursor: TranscriptCursor = {
				transcriptPath: path,
				lineNumber: 1,
				updatedAt: new Date().toISOString(),
				anchorId: "not-a-number",
			};
			const result = await readHermesTranscript(path, cursor);
			expect(result.entries.map((e) => e.content)).toEqual(["two", "three"]);
		});

		it("reads from the start with no cursor at all", async () => {
			const path = await dbWith({ messages: threeTurns });
			const result = await readHermesTranscript(path, null);
			expect(result.entries).toHaveLength(3);
		});
	});

	describe("beforeTimestamp", () => {
		it("stops at the cutoff and reports the consumed position", async () => {
			const path = await dbWith({
				messages: [
					{ role: "user", content: "before", timestamp: at(0) },
					{ role: "assistant", content: "also before", timestamp: at(10) },
					{ role: "user", content: "after", timestamp: at(100) },
				],
			});
			const result = await readHermesTranscript(path, null, new Date(at(50) * 1000).toISOString());
			expect(result.entries.map((e) => e.content)).toEqual(["before", "also before"]);
			// Under a cutoff the cursor records what was actually consumed, not the
			// full length — the rest belongs to a later commit.
			expect(result.newCursor.lineNumber).toBe(2);
			expect(result.newCursor.anchorId).toBe("2");
		});
	});

	describe("failures", () => {
		it("throws on a path with no session component", async () => {
			await expect(readHermesTranscript("/tmp/state.db")).rejects.toThrow(/Invalid Hermes transcript path/);
		});

		it("throws when the database cannot be opened", async () => {
			await expect(readHermesTranscript(`${join(tempDir, "gone.db")}#${SESSION_ID}`)).rejects.toThrow(
				/Cannot read Hermes session/,
			);
		});
	});
});

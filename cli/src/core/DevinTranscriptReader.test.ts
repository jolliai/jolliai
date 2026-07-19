import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Suppress console output (readDevinTranscript logs via createLogger → console).
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import { createDevinDb, sampleDevinMessageForest } from "../testUtils/devinDbFixture.js";
import { readDevinTranscript } from "./DevinTranscriptReader.js";

const SESSION_ID = "devin-session-1";
const BASE_CREATED_AT = 1_700_000_000; // epoch seconds

describe("readDevinTranscript", () => {
	let tempDir: string;
	let dbPath: string;
	let transcriptPath: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "devin-transcript-"));
		dbPath = await createDevinDb(tempDir, [
			{
				id: SESSION_ID,
				workingDirectory: "/repo",
				lastActivityAt: BASE_CREATED_AT + 10,
				mainChainId: 5,
				messageNodes: sampleDevinMessageForest(BASE_CREATED_AT),
			},
		]);
		transcriptPath = `${dbPath}#${SESSION_ID}`;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("reconstructs the main chain, keeping only human/assistant with content", async () => {
		const { entries } = await readDevinTranscript(transcriptPath);
		// Fixture's real conversation: user asks, assistant answers (after merging
		// the consecutive assistant turns produced by the tool round-trip).
		expect(entries.length).toBeGreaterThanOrEqual(2);
		expect(entries.every((e) => e.role === "human" || e.role === "assistant")).toBe(true);
		expect(entries.every((e) => e.content.trim().length > 0)).toBe(true);
		expect(entries[0]).toMatchObject({ role: "human" });
		expect(entries.at(-1)).toMatchObject({ role: "assistant" });
	});

	it("drops system/tool nodes and the discarded sibling regeneration", async () => {
		const { entries } = await readDevinTranscript(transcriptPath);
		const allContent = entries.map((e) => e.content).join("\n");
		expect(allContent).not.toContain("You are Devin, an AI software engineer.");
		expect(allContent).not.toContain('{"branch":"main"}');
		expect(allContent).not.toContain("(discarded regeneration)");
		expect(allContent).toContain("What is the current git branch?");
		expect(allContent).toContain("You are on branch main.");
	});

	it("returns an advancing cursor", async () => {
		const { newCursor } = await readDevinTranscript(transcriptPath);
		expect(newCursor.transcriptPath).toBe(transcriptPath);
		expect(newCursor.lineNumber).toBeGreaterThan(0);
	});

	it("resuming from the returned cursor yields no further entries", async () => {
		const first = await readDevinTranscript(transcriptPath);
		const second = await readDevinTranscript(transcriptPath, first.newCursor);
		expect(second.entries).toEqual([]);
		expect(second.totalLinesRead).toBe(0);
	});

	it("stops consuming at a beforeTimestamp cutoff and advances the cursor only that far", async () => {
		// Cut off right at the tool node's timestamp (baseCreatedAt + 3), strictly before
		// the final assistant node (baseCreatedAt + 4) — which is excluded (t > cutoff).
		const cutoff = new Date((BASE_CREATED_AT + 3) * 1000).toISOString();
		const { entries, newCursor } = await readDevinTranscript(transcriptPath, null, cutoff);
		expect(entries.some((e) => e.content.includes("You are on branch main."))).toBe(false);
		// Cursor should not have advanced all the way to the full chain length (5).
		expect(newCursor.lineNumber).toBeLessThan(5);
	});

	it("falls back to the latest leaf when main_chain_id is NULL", async () => {
		const dir = await mkdtemp(join(tmpdir(), "devin-null-tip-"));
		const nullTipCreatedAt = BASE_CREATED_AT + 100;
		const p = await createDevinDb(dir, [
			{
				id: "s",
				workingDirectory: "/repo",
				lastActivityAt: nullTipCreatedAt,
				mainChainId: null,
				messageNodes: [
					{ nodeId: 1, parentNodeId: null, role: "user", content: "hi", createdAt: nullTipCreatedAt },
					{
						nodeId: 2,
						parentNodeId: 1,
						role: "assistant",
						content: "hello",
						createdAt: nullTipCreatedAt + 1,
					},
				],
			},
		]);

		const { entries } = await readDevinTranscript(`${p}#s`);
		expect(entries).toEqual([
			{ role: "human", content: "hi", timestamp: new Date(nullTipCreatedAt * 1000).toISOString() },
			{ role: "assistant", content: "hello", timestamp: new Date((nullTipCreatedAt + 1) * 1000).toISOString() },
		]);

		await rm(dir, { recursive: true, force: true });
	});

	it("guards against a cycle in parent_node_id and still returns without hanging", async () => {
		const dir = await mkdtemp(join(tmpdir(), "devin-cycle-"));
		const cycleCreatedAt = BASE_CREATED_AT + 200;
		const p = await createDevinDb(dir, [
			{
				id: "s",
				workingDirectory: "/repo",
				lastActivityAt: cycleCreatedAt,
				mainChainId: 2,
				// 1 -> 2 -> 1 -> ... (cycle)
				messageNodes: [
					{ nodeId: 1, parentNodeId: 2, role: "user", content: "cyclic-a", createdAt: cycleCreatedAt },
					{
						nodeId: 2,
						parentNodeId: 1,
						role: "assistant",
						content: "cyclic-b",
						createdAt: cycleCreatedAt + 1,
					},
				],
			},
		]);

		const { entries } = await readDevinTranscript(`${p}#s`);
		// Both nodes are visited exactly once each before the cycle guard stops the walk.
		expect(entries.length).toBe(2);

		await rm(dir, { recursive: true, force: true });
	});

	it("stops walking at a dangling parent reference", async () => {
		const dir = await mkdtemp(join(tmpdir(), "devin-dangling-"));
		const danglingCreatedAt = BASE_CREATED_AT + 300;
		const p = await createDevinDb(dir, [
			{
				id: "s",
				workingDirectory: "/repo",
				lastActivityAt: danglingCreatedAt,
				mainChainId: 2,
				// node 2's parent (99) does not exist in this session's forest.
				messageNodes: [
					{
						nodeId: 2,
						parentNodeId: 99,
						role: "assistant",
						content: "orphaned-tip",
						createdAt: danglingCreatedAt,
					},
				],
			},
		]);

		const { entries } = await readDevinTranscript(`${p}#s`);
		expect(entries).toEqual([
			{ role: "assistant", content: "orphaned-tip", timestamp: new Date(danglingCreatedAt * 1000).toISOString() },
		]);

		await rm(dir, { recursive: true, force: true });
	});

	it("falls back to the latest leaf when main_chain_id points at a node absent from this session", async () => {
		const dir = await mkdtemp(join(tmpdir(), "devin-absent-tip-"));
		const absentTipCreatedAt = BASE_CREATED_AT + 400;
		const p = await createDevinDb(dir, [
			{
				id: "s",
				workingDirectory: "/repo",
				lastActivityAt: absentTipCreatedAt,
				// 999 does not correspond to any row in this session's message_nodes —
				// exercises the `!byId.has(tip)` branch (distinct from `tip === null`).
				mainChainId: 999,
				messageNodes: [
					{ nodeId: 1, parentNodeId: null, role: "user", content: "hi", createdAt: absentTipCreatedAt },
					{
						nodeId: 2,
						parentNodeId: 1,
						role: "assistant",
						content: "discarded sibling",
						createdAt: absentTipCreatedAt + 1,
					},
					{
						nodeId: 3,
						parentNodeId: 1,
						role: "assistant",
						content: "final reply",
						createdAt: absentTipCreatedAt + 2,
					},
				],
			},
		]);

		const { entries } = await readDevinTranscript(`${p}#s`);
		// Falls back to the latest-created leaf (node 3 at +2, not sibling node 2 at +1,
		// and not the absent tip 999) and walks its full parent chain (3 -> 1).
		expect(entries).toEqual([
			{ role: "human", content: "hi", timestamp: new Date(absentTipCreatedAt * 1000).toISOString() },
			{
				role: "assistant",
				content: "final reply",
				timestamp: new Date((absentTipCreatedAt + 2) * 1000).toISOString(),
			},
		]);

		await rm(dir, { recursive: true, force: true });
	});

	it("skips a node whose chat_message is invalid JSON", async () => {
		const dir = await mkdtemp(join(tmpdir(), "devin-badjson-"));
		const p = join(dir, "s.db");
		const db = new DatabaseSync(p);
		db.exec(
			"CREATE TABLE sessions(id TEXT, main_chain_id INTEGER); CREATE TABLE message_nodes(session_id TEXT, node_id INTEGER, parent_node_id INTEGER, chat_message TEXT);",
		);
		db.prepare("INSERT INTO sessions VALUES('s', 2)").run();
		db.prepare("INSERT INTO message_nodes VALUES('s',1,NULL,?)").run("{not valid json");
		db.prepare("INSERT INTO message_nodes VALUES('s',2,1,?)").run(
			JSON.stringify({ role: "assistant", content: "ok", metadata: { created_at: "2026-07-18T00:00:00Z" } }),
		);
		db.close();

		const { entries } = await readDevinTranscript(`${p}#s`);
		expect(entries).toEqual([{ role: "assistant", content: "ok", timestamp: "2026-07-18T00:00:00Z" }]);

		await rm(dir, { recursive: true, force: true });
	});

	it("breaks a NULL-tip fallback tie on the greater node_id when leaf timestamps are equal", async () => {
		const dir = await mkdtemp(join(tmpdir(), "devin-tie-break-"));
		const p = join(dir, "s.db");
		const db = new DatabaseSync(p);
		db.exec(
			"CREATE TABLE sessions(id TEXT, main_chain_id INTEGER); CREATE TABLE message_nodes(session_id TEXT, node_id INTEGER, parent_node_id INTEGER, chat_message TEXT);",
		);
		db.prepare("INSERT INTO sessions VALUES('s', NULL)").run();
		const mk = (role: string, content: string) =>
			JSON.stringify({ role, content, metadata: { created_at: "2026-07-18T00:00:00Z" } });
		// Two root leaves with identical created_at; the fallback must pick the greater
		// node_id (5), independent of scan order (node 5 inserted first, node 1 second).
		db.prepare("INSERT INTO message_nodes VALUES('s',5,NULL,?)").run(mk("assistant", "should-win"));
		db.prepare("INSERT INTO message_nodes VALUES('s',1,NULL,?)").run(mk("user", "should-lose"));
		db.close();

		const { entries } = await readDevinTranscript(`${p}#s`);
		expect(entries).toEqual([{ role: "assistant", content: "should-win", timestamp: "2026-07-18T00:00:00Z" }]);

		await rm(dir, { recursive: true, force: true });
	});

	it("treats a node with no role field as unmapped and a node with no content field as empty", async () => {
		const dir = await mkdtemp(join(tmpdir(), "devin-missing-fields-"));
		const p = join(dir, "s.db");
		const db = new DatabaseSync(p);
		db.exec(
			"CREATE TABLE sessions(id TEXT, main_chain_id INTEGER); CREATE TABLE message_nodes(session_id TEXT, node_id INTEGER, parent_node_id INTEGER, chat_message TEXT);",
		);
		db.prepare("INSERT INTO sessions VALUES('s', 3)").run();
		// node 1: role missing entirely -> role mapping is undefined -> skipped regardless of content.
		db.prepare("INSERT INTO message_nodes VALUES('s',1,NULL,?)").run(
			JSON.stringify({ content: "no role here", metadata: { created_at: "2026-07-18T00:00:00Z" } }),
		);
		// node 2: content missing entirely -> defaults to "" -> skipped even though role maps.
		db.prepare("INSERT INTO message_nodes VALUES('s',2,1,?)").run(
			JSON.stringify({ role: "user", metadata: { created_at: "2026-07-18T00:00:00Z" } }),
		);
		// node 3: normal, keeps the chain non-empty.
		db.prepare("INSERT INTO message_nodes VALUES('s',3,2,?)").run(
			JSON.stringify({ role: "assistant", content: "kept", metadata: { created_at: "2026-07-18T00:00:00Z" } }),
		);
		db.close();

		const { entries } = await readDevinTranscript(`${p}#s`);
		expect(entries).toEqual([{ role: "assistant", content: "kept", timestamp: "2026-07-18T00:00:00Z" }]);

		await rm(dir, { recursive: true, force: true });
	});

	it("treats a node with no metadata as having no timestamp, even under a beforeTimestamp cutoff", async () => {
		const dir = await mkdtemp(join(tmpdir(), "devin-no-metadata-"));
		const p = join(dir, "s.db");
		const db = new DatabaseSync(p);
		db.exec(
			"CREATE TABLE sessions(id TEXT, main_chain_id INTEGER); CREATE TABLE message_nodes(session_id TEXT, node_id INTEGER, parent_node_id INTEGER, chat_message TEXT);",
		);
		db.prepare("INSERT INTO sessions VALUES('s', 1)").run();
		// No `metadata` key at all -> optional chaining short-circuits -> timestamp undefined.
		db.prepare("INSERT INTO message_nodes VALUES('s',1,NULL,?)").run(
			JSON.stringify({ role: "user", content: "no metadata here" }),
		);
		db.close();

		const { entries } = await readDevinTranscript(`${p}#s`, null, "2026-07-18T00:00:00Z");
		expect(entries).toEqual([{ role: "human", content: "no metadata here", timestamp: undefined }]);

		await rm(dir, { recursive: true, force: true });
	});

	it("ignores an unparsable created_at string under a cutoff (does not break the walk)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "devin-bad-timestamp-"));
		const p = join(dir, "s.db");
		const db = new DatabaseSync(p);
		db.exec(
			"CREATE TABLE sessions(id TEXT, main_chain_id INTEGER); CREATE TABLE message_nodes(session_id TEXT, node_id INTEGER, parent_node_id INTEGER, chat_message TEXT);",
		);
		db.prepare("INSERT INTO sessions VALUES('s', 1)").run();
		db.prepare("INSERT INTO message_nodes VALUES('s',1,NULL,?)").run(
			JSON.stringify({ role: "user", content: "unparsable ts", metadata: { created_at: "not-a-real-date" } }),
		);
		db.close();

		const { entries } = await readDevinTranscript(`${p}#s`, null, "2026-07-18T00:00:00Z");
		expect(entries).toEqual([{ role: "human", content: "unparsable ts", timestamp: "not-a-real-date" }]);

		await rm(dir, { recursive: true, force: true });
	});

	it("picks the latest-created leaf, not the greatest node_id, when main_chain_id is NULL", async () => {
		// Discarded sibling (node 2) has the HIGHER node_id but an EARLIER created_at;
		// the accepted answer (node 1) is lower-id but newer. A max-by-node_id fallback
		// would reconstruct the discarded branch — the latest-leaf fallback must not.
		const dir = await mkdtemp(join(tmpdir(), "devin-leaf-fallback-"));
		const base = BASE_CREATED_AT + 500;
		const p = await createDevinDb(dir, [
			{
				id: "s",
				workingDirectory: "/repo",
				lastActivityAt: base + 5,
				mainChainId: null,
				messageNodes: [
					{ nodeId: 0, parentNodeId: null, role: "user", content: "question", createdAt: base },
					{ nodeId: 1, parentNodeId: 0, role: "assistant", content: "accepted answer", createdAt: base + 5 },
					{ nodeId: 2, parentNodeId: 0, role: "assistant", content: "discarded answer", createdAt: base + 1 },
				],
			},
		]);

		const { entries } = await readDevinTranscript(`${p}#s`);
		const text = entries.map((e) => e.content).join("\n");
		expect(text).toContain("accepted answer");
		expect(text).not.toContain("discarded answer");

		await rm(dir, { recursive: true, force: true });
	});

	it("re-reads regenerated content after a regeneration behind the cursor (anchor-based resume)", async () => {
		// Session begins as 0(q1) -> 1(a1) -> 2(q2) -> 3(a2 original), tip=3.
		const dir = await mkdtemp(join(tmpdir(), "devin-regen-"));
		const base = BASE_CREATED_AT + 600;
		const p = await createDevinDb(dir, [
			{
				id: "s",
				workingDirectory: "/repo",
				lastActivityAt: base + 3,
				mainChainId: 3,
				messageNodes: [
					{ nodeId: 0, parentNodeId: null, role: "user", content: "q1", createdAt: base },
					{ nodeId: 1, parentNodeId: 0, role: "assistant", content: "a1", createdAt: base + 1 },
					{ nodeId: 2, parentNodeId: 1, role: "user", content: "q2", createdAt: base + 2 },
					{ nodeId: 3, parentNodeId: 2, role: "assistant", content: "a2-original", createdAt: base + 3 },
				],
			},
		]);

		const first = await readDevinTranscript(`${p}#s`);
		expect(first.newCursor.anchorId).toBe("3");
		expect(first.entries.map((e) => e.content)).toContain("a2-original");

		// User regenerates turn q2: new branch 1 -> 4(q2-regen) -> 5(a2-regen); tip repointed to 5.
		// Node 3 is now a discarded sibling that no longer sits on the accepted chain.
		const db = new DatabaseSync(p);
		const mk = (role: string, content: string, createdSec: number) =>
			JSON.stringify({ role, content, metadata: { created_at: new Date(createdSec * 1000).toISOString() } });
		db.prepare(
			"INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?,?,?,?,?)",
		).run("s", 4, 1, mk("user", "q2-regen", base + 4), base + 4);
		db.prepare(
			"INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?,?,?,?,?)",
		).run("s", 5, 4, mk("assistant", "a2-regen", base + 5), base + 5);
		db.prepare("UPDATE sessions SET main_chain_id = 5 WHERE id = 's'").run();
		db.close();

		// Resuming from the pre-regeneration cursor: the anchor (node 3) is gone from the
		// chain, so we re-read from the start and RECOVER the regenerated turns rather than
		// slicing past them (which a raw positional cursor would have silently dropped).
		const second = await readDevinTranscript(`${p}#s`, first.newCursor);
		const text = second.entries.map((e) => e.content).join("\n");
		expect(text).toContain("q2-regen");
		expect(text).toContain("a2-regen");
		expect(second.newCursor.anchorId).toBe("5");

		await rm(dir, { recursive: true, force: true });
	});

	it("advances past only newly-appended nodes when the anchor is still on the chain", async () => {
		const dir = await mkdtemp(join(tmpdir(), "devin-append-"));
		const base = BASE_CREATED_AT + 700;
		const p = await createDevinDb(dir, [
			{
				id: "s",
				workingDirectory: "/repo",
				lastActivityAt: base + 1,
				mainChainId: 1,
				messageNodes: [
					{ nodeId: 0, parentNodeId: null, role: "user", content: "hello", createdAt: base },
					{ nodeId: 1, parentNodeId: 0, role: "assistant", content: "hi there", createdAt: base + 1 },
				],
			},
		]);

		const first = await readDevinTranscript(`${p}#s`);
		expect(first.newCursor.anchorId).toBe("1");

		// Append a follow-up assistant node and extend the accepted chain to it.
		const db = new DatabaseSync(p);
		const mk = (role: string, content: string, createdSec: number) =>
			JSON.stringify({ role, content, metadata: { created_at: new Date(createdSec * 1000).toISOString() } });
		db.prepare(
			"INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?,?,?,?,?)",
		).run("s", 2, 1, mk("assistant", "follow-up", base + 2), base + 2);
		db.prepare("UPDATE sessions SET main_chain_id = 2 WHERE id = 's'").run();
		db.close();

		const second = await readDevinTranscript(`${p}#s`, first.newCursor);
		expect(second.entries.map((e) => e.content)).toEqual(["follow-up"]);
		expect(second.newCursor.anchorId).toBe("2");

		await rm(dir, { recursive: true, force: true });
	});

	it("falls back to the positional lineNumber for a legacy cursor without an anchorId", async () => {
		// A cursor persisted before anchors existed carries only lineNumber. The reader
		// must still resume positionally (and clamp an over-long lineNumber to the chain).
		const first = await readDevinTranscript(transcriptPath);
		const legacyCursor = {
			transcriptPath,
			lineNumber: first.newCursor.lineNumber,
			updatedAt: "2026-07-18T00:00:00Z",
		};
		const second = await readDevinTranscript(transcriptPath, legacyCursor);
		expect(second.entries).toEqual([]);

		const overshoot = { transcriptPath, lineNumber: 9999, updatedAt: "2026-07-18T00:00:00Z" };
		const third = await readDevinTranscript(transcriptPath, overshoot);
		expect(third.entries).toEqual([]);
	});

	it("returns no entries when a NULL-tip session has no message_nodes at all", async () => {
		const dir = await mkdtemp(join(tmpdir(), "devin-empty-forest-"));
		const p = join(dir, "s.db");
		const db = new DatabaseSync(p);
		db.exec(
			"CREATE TABLE sessions(id TEXT, main_chain_id INTEGER); CREATE TABLE message_nodes(session_id TEXT, node_id INTEGER, parent_node_id INTEGER, chat_message TEXT);",
		);
		db.prepare("INSERT INTO sessions VALUES('s', NULL)").run();
		db.close();

		const { entries, newCursor } = await readDevinTranscript(`${p}#s`);
		expect(entries).toEqual([]);
		expect(newCursor.anchorId).toBeUndefined();

		await rm(dir, { recursive: true, force: true });
	});

	it("tolerates an invalid-JSON leaf while scoring the NULL-tip fallback", async () => {
		const dir = await mkdtemp(join(tmpdir(), "devin-badjson-leaf-"));
		const p = join(dir, "s.db");
		const db = new DatabaseSync(p);
		db.exec(
			"CREATE TABLE sessions(id TEXT, main_chain_id INTEGER); CREATE TABLE message_nodes(session_id TEXT, node_id INTEGER, parent_node_id INTEGER, chat_message TEXT);",
		);
		db.prepare("INSERT INTO sessions VALUES('s', NULL)").run();
		// node 1: a root leaf whose chat_message is unparsable → nodeCreatedMs → NaN (ranks lowest).
		db.prepare("INSERT INTO message_nodes VALUES('s',1,NULL,?)").run("{broken json");
		// node 2: a timestamped root leaf → wins the fallback and reconstructs cleanly.
		db.prepare("INSERT INTO message_nodes VALUES('s',2,NULL,?)").run(
			JSON.stringify({ role: "assistant", content: "winner", metadata: { created_at: "2026-07-18T00:00:00Z" } }),
		);
		db.close();

		const { entries } = await readDevinTranscript(`${p}#s`);
		expect(entries).toEqual([{ role: "assistant", content: "winner", timestamp: "2026-07-18T00:00:00Z" }]);

		await rm(dir, { recursive: true, force: true });
	});

	it("preserves the underlying error code on the wrapped read failure", async () => {
		// A directory at the DB path makes node:sqlite throw a coded error (ERR_SQLITE_ERROR);
		// the wrapper must carry that code so TranscriptLoader's isEnoent-style guards work.
		const dir = await mkdtemp(join(tmpdir(), "devin-coded-err-"));
		const asDir = join(dir, "is-a-dir.db");
		await mkdir(asDir, { recursive: true });

		await expect(readDevinTranscript(`${asDir}#s`)).rejects.toMatchObject({
			message: expect.stringContaining("Cannot read Devin session"),
			code: expect.any(String),
		});

		await rm(dir, { recursive: true, force: true });
	});

	it("throws a wrapped error for an unknown session", async () => {
		await expect(readDevinTranscript(`${dbPath}#does-not-exist`)).rejects.toThrow("Cannot read Devin session");
	});

	it("throws a wrapped error for a malformed transcript path (no '#')", async () => {
		await expect(readDevinTranscript("/no/hash/here")).rejects.toThrow();
	});
});

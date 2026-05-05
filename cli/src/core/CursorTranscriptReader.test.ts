import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

import { readCursorTranscript } from "./CursorTranscriptReader.js";

const CURSOR_DDL = [
	`CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)`,
	`CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)`,
];

interface BubbleFixture {
	bubbleId: string;
	type: 1 | 2;
	text: string;
	createdAt: string;
}

function createCursorTranscriptDb(dbPath: string, composerId: string, bubbles: ReadonlyArray<BubbleFixture>): void {
	const db = new DatabaseSync(dbPath);
	for (const sql of CURSOR_DDL) db.prepare(sql).run();

	const composerData = JSON.stringify({
		_v: 16,
		composerId,
		name: "Test composer",
		createdAt: Date.now(),
		lastUpdatedAt: Date.now(),
		fullConversationHeadersOnly: bubbles.map((b) => ({ bubbleId: b.bubbleId, type: b.type, grouping: null })),
		status: "completed",
		unifiedMode: "agent",
	});
	db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(`composerData:${composerId}`, composerData);

	for (const b of bubbles) {
		const bubbleData = JSON.stringify({
			_v: 3,
			bubbleId: b.bubbleId,
			type: b.type,
			text: b.text,
			createdAt: b.createdAt,
		});
		db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
			`bubbleId:${composerId}:${b.bubbleId}`,
			bubbleData,
		);
	}
	db.close();
}

describe("readCursorTranscript", () => {
	let tmpDir: string;
	let dbPath: string;
	const composerId = "11111111-2222-3333-4444-555555555555";

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cursor-tr-"));
		await mkdir(tmpDir, { recursive: true });
		dbPath = join(tmpDir, "state.vscdb");
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("rejects malformed synthetic paths", async () => {
		await expect(readCursorTranscript("/no/hash/in/path")).rejects.toThrow(/missing #composerId/);
		await expect(readCursorTranscript("#only-id")).rejects.toThrow(/empty/);
		await expect(readCursorTranscript("/path#")).rejects.toThrow(/empty/);
	});

	it("returns ordered user/assistant entries with type→role mapping", async () => {
		createCursorTranscriptDb(dbPath, composerId, [
			{ bubbleId: "b1", type: 1, text: "what is 2 + 2?", createdAt: "2026-05-03T10:00:00.000Z" },
			{ bubbleId: "b2", type: 2, text: "2 + 2 = 4.", createdAt: "2026-05-03T10:00:01.000Z" },
			{ bubbleId: "b3", type: 1, text: "thanks", createdAt: "2026-05-03T10:00:02.000Z" },
		]);

		const result = await readCursorTranscript(`${dbPath}#${composerId}`);

		expect(result.entries).toEqual([
			{ role: "human", content: "what is 2 + 2?", timestamp: "2026-05-03T10:00:00.000Z" },
			{ role: "assistant", content: "2 + 2 = 4.", timestamp: "2026-05-03T10:00:01.000Z" },
			{ role: "human", content: "thanks", timestamp: "2026-05-03T10:00:02.000Z" },
		]);
		expect(result.newCursor.lineNumber).toBe(3);
		expect(result.totalLinesRead).toBe(3);
	});

	it("merges consecutive same-role entries", async () => {
		createCursorTranscriptDb(dbPath, composerId, [
			{ bubbleId: "b1", type: 2, text: "Looking at the file...", createdAt: "2026-05-03T10:00:00.000Z" },
			{ bubbleId: "b2", type: 2, text: "I see the issue.", createdAt: "2026-05-03T10:00:01.000Z" },
			{ bubbleId: "b3", type: 1, text: "what is it?", createdAt: "2026-05-03T10:00:02.000Z" },
		]);

		const result = await readCursorTranscript(`${dbPath}#${composerId}`);
		expect(result.entries).toHaveLength(2);
		expect(result.entries[0].role).toBe("assistant");
		expect(result.entries[0].content).toBe("Looking at the file...\n\nI see the issue.");
		expect(result.entries[1].role).toBe("human");
	});

	it("skips bubbles with empty text", async () => {
		createCursorTranscriptDb(dbPath, composerId, [
			{ bubbleId: "b1", type: 1, text: "hi", createdAt: "2026-05-03T10:00:00.000Z" },
			{ bubbleId: "b2", type: 2, text: "", createdAt: "2026-05-03T10:00:01.000Z" },
			{ bubbleId: "b3", type: 1, text: "ping", createdAt: "2026-05-03T10:00:02.000Z" },
		]);

		const result = await readCursorTranscript(`${dbPath}#${composerId}`);
		expect(result.entries.map((e) => e.role)).toEqual(["human"]);
	});

	it("skips bubbles whose type does not map to a role", async () => {
		createCursorTranscriptDb(dbPath, composerId, [
			{ bubbleId: "b1", type: 1, text: "hi", createdAt: "2026-05-03T10:00:00.000Z" },
			{ bubbleId: "b2", type: 99 as unknown as 1, text: "system noise", createdAt: "2026-05-03T10:00:01.000Z" },
		]);
		const result = await readCursorTranscript(`${dbPath}#${composerId}`);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].role).toBe("human");
	});

	it("skips already-read bubbles when given a cursor", async () => {
		createCursorTranscriptDb(dbPath, composerId, [
			{ bubbleId: "b1", type: 1, text: "first", createdAt: "2026-05-03T10:00:00.000Z" },
			{ bubbleId: "b2", type: 2, text: "second", createdAt: "2026-05-03T10:00:01.000Z" },
			{ bubbleId: "b3", type: 1, text: "third", createdAt: "2026-05-03T10:00:02.000Z" },
		]);

		const result = await readCursorTranscript(`${dbPath}#${composerId}`, {
			transcriptPath: `${dbPath}#${composerId}`,
			lineNumber: 2,
			updatedAt: "2026-05-03T10:00:01.000Z",
		});
		expect(result.entries).toEqual([{ role: "human", content: "third", timestamp: "2026-05-03T10:00:02.000Z" }]);
		expect(result.newCursor.lineNumber).toBe(3);
	});

	it("respects beforeTimestamp cutoff and advances cursor only to last consumed", async () => {
		createCursorTranscriptDb(dbPath, composerId, [
			{ bubbleId: "b1", type: 1, text: "first", createdAt: "2026-05-03T10:00:00.000Z" },
			{ bubbleId: "b2", type: 2, text: "second", createdAt: "2026-05-03T10:00:01.000Z" },
			{ bubbleId: "b3", type: 1, text: "after-cutoff", createdAt: "2026-05-03T10:00:05.000Z" },
		]);

		const result = await readCursorTranscript(`${dbPath}#${composerId}`, null, "2026-05-03T10:00:01.500Z");
		expect(result.entries.map((e) => e.content)).toEqual(["first", "second"]);
		expect(result.newCursor.lineNumber).toBe(2);
	});

	it("falls back to header.type and empty text when bubble row omits those fields", async () => {
		// Cursor bubble rows can omit `type` and `text` — the reader must fall
		// back to the header's type and treat missing/empty text as a skip.
		// This exercises the `bubble.type ?? header.type` and `(bubble.text ?? "").trim()`
		// nullish branches that fully-populated fixtures don't reach.
		const db = new DatabaseSync(dbPath);
		for (const sql of CURSOR_DDL) db.prepare(sql).run();
		const composerData = JSON.stringify({
			composerId,
			fullConversationHeadersOnly: [
				{ bubbleId: "b1", type: 1, grouping: null }, // header carries the type
				{ bubbleId: "b2", type: 1, grouping: null }, // header carries the type
			],
		});
		db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
			`composerData:${composerId}`,
			composerData,
		);
		// b1 has no `type` field → falls back to header.type=1; no `text` field → "" → skipped
		db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
			`bubbleId:${composerId}:b1`,
			JSON.stringify({ bubbleId: "b1", createdAt: "2026-05-03T10:00:00.000Z" }),
		);
		// b2 has no `type` field but has text → falls back to header.type=1, role=human
		db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
			`bubbleId:${composerId}:b2`,
			JSON.stringify({ bubbleId: "b2", text: "fallback works", createdAt: "2026-05-03T10:00:01.000Z" }),
		);
		db.close();

		const result = await readCursorTranscript(`${dbPath}#${composerId}`);
		expect(result.entries).toEqual([
			{ role: "human", content: "fallback works", timestamp: "2026-05-03T10:00:01.000Z" },
		]);
	});

	it("treats composerData with no fullConversationHeadersOnly field as empty", async () => {
		// Schema-drift guard: if Cursor renames or drops fullConversationHeadersOnly,
		// the reader must coerce to [] rather than crash. Covers the `?? []` branch.
		const db = new DatabaseSync(dbPath);
		for (const sql of CURSOR_DDL) db.prepare(sql).run();
		db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
			`composerData:${composerId}`,
			JSON.stringify({ composerId }), // no fullConversationHeadersOnly
		);
		db.close();

		const result = await readCursorTranscript(`${dbPath}#${composerId}`);
		expect(result.entries).toEqual([]);
		expect(result.newCursor.lineNumber).toBe(0);
	});

	it("skips bubbles whose type cannot be inferred (header.type also missing)", async () => {
		// Both bubble.type and header.type missing — type stays undefined, so
		// the role lookup short-circuits to undefined and the bubble is skipped.
		// Covers the `type !== undefined ? ... : undefined` falsy branch.
		const db = new DatabaseSync(dbPath);
		for (const sql of CURSOR_DDL) db.prepare(sql).run();
		db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
			`composerData:${composerId}`,
			JSON.stringify({
				composerId,
				fullConversationHeadersOnly: [{ bubbleId: "b1", grouping: null }], // no type
			}),
		);
		db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
			`bubbleId:${composerId}:b1`,
			JSON.stringify({ bubbleId: "b1", text: "untyped", createdAt: "2026-05-03T10:00:00.000Z" }),
			// no type field on the bubble either
		);
		db.close();

		const result = await readCursorTranscript(`${dbPath}#${composerId}`);
		expect(result.entries).toEqual([]);
	});

	it("throws a friendly error when the composer is not in the DB", async () => {
		createCursorTranscriptDb(dbPath, composerId, []);
		await expect(readCursorTranscript(`${dbPath}#missing-id`)).rejects.toThrow(/Cannot read Cursor session/);
	});

	it("throws a friendly error when composerData row exists but is not valid JSON", async () => {
		const db = new DatabaseSync(dbPath);
		for (const sql of CURSOR_DDL) db.prepare(sql).run();
		// Row present (so the "not found" branch is skipped) but value is garbage —
		// JSON.parse throws, and the inner catch at L92-93 rewrites to a typed error
		// which the outer catch then surfaces as the user-facing "Cannot read..." message.
		db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
			`composerData:${composerId}`,
			"{not valid json",
		);
		db.close();

		await expect(readCursorTranscript(`${dbPath}#${composerId}`)).rejects.toThrow(/Cannot read Cursor session/);
	});

	it("skips bubbles whose row is missing from the DB without crashing", async () => {
		// Build the composer header listing 3 bubbles, but only insert 2 of them
		const db = new DatabaseSync(dbPath);
		for (const sql of CURSOR_DDL) db.prepare(sql).run();
		const composerData = JSON.stringify({
			_v: 16,
			composerId,
			name: "Test composer",
			createdAt: Date.now(),
			lastUpdatedAt: Date.now(),
			fullConversationHeadersOnly: [
				{ bubbleId: "b1", type: 1, grouping: null },
				{ bubbleId: "b2-missing", type: 2, grouping: null },
				{ bubbleId: "b3", type: 1, grouping: null },
			],
			status: "completed",
			unifiedMode: "agent",
		});
		db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
			`composerData:${composerId}`,
			composerData,
		);
		// Insert b1 and b3 but NOT b2-missing
		for (const b of [
			{ bubbleId: "b1", type: 1, text: "first", createdAt: "2026-05-03T10:00:00.000Z" },
			{ bubbleId: "b3", type: 1, text: "third", createdAt: "2026-05-03T10:00:02.000Z" },
		]) {
			db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
				`bubbleId:${composerId}:${b.bubbleId}`,
				JSON.stringify({
					_v: 3,
					bubbleId: b.bubbleId,
					type: b.type,
					text: b.text,
					createdAt: b.createdAt,
				}),
			);
		}
		db.close();

		const result = await readCursorTranscript(`${dbPath}#${composerId}`);
		// The two consecutive "human" entries get merged into one (b2 missing was skipped);
		// cursor advances past all 3 header positions.
		expect(result.entries).toEqual([
			{ role: "human", content: "first\n\nthird", timestamp: "2026-05-03T10:00:00.000Z" },
		]);
		expect(result.newCursor.lineNumber).toBe(3);
	});

	it("skips bubbles whose row JSON is malformed", async () => {
		const db = new DatabaseSync(dbPath);
		for (const sql of CURSOR_DDL) db.prepare(sql).run();
		const composerData = JSON.stringify({
			_v: 16,
			composerId,
			name: "Test composer",
			createdAt: Date.now(),
			lastUpdatedAt: Date.now(),
			fullConversationHeadersOnly: [
				{ bubbleId: "b1", type: 1, grouping: null },
				{ bubbleId: "b2-bad", type: 2, grouping: null },
				{ bubbleId: "b3", type: 1, grouping: null },
			],
			status: "completed",
			unifiedMode: "agent",
		});
		db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
			`composerData:${composerId}`,
			composerData,
		);
		db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
			`bubbleId:${composerId}:b1`,
			JSON.stringify({ _v: 3, bubbleId: "b1", type: 1, text: "first", createdAt: "2026-05-03T10:00:00.000Z" }),
		);
		// b2-bad row has unparseable JSON
		db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
			`bubbleId:${composerId}:b2-bad`,
			"{not valid json",
		);
		db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
			`bubbleId:${composerId}:b3`,
			JSON.stringify({ _v: 3, bubbleId: "b3", type: 1, text: "third", createdAt: "2026-05-03T10:00:02.000Z" }),
		);
		db.close();

		const result = await readCursorTranscript(`${dbPath}#${composerId}`);
		expect(result.entries).toEqual([
			{ role: "human", content: "first\n\nthird", timestamp: "2026-05-03T10:00:00.000Z" },
		]);
		expect(result.newCursor.lineNumber).toBe(3);
	});
});

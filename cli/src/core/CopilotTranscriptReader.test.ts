import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCHEMA_STATEMENTS = [
	"CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT)",
	`CREATE TABLE turns (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id TEXT NOT NULL,
		turn_index INTEGER NOT NULL,
		user_message TEXT, assistant_response TEXT, timestamp TEXT
	)`,
];

interface SeedTurn {
	turn_index: number;
	user_message?: string | null;
	assistant_response?: string | null;
	timestamp?: string;
}

async function makeDb(sessionId: string, turns: SeedTurn[]): Promise<{ dbPath: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "copilot-tr-"));
	const dbPath = join(dir, "session-store.db");
	const db = new DatabaseSync(dbPath);
	for (const stmt of SCHEMA_STATEMENTS) db.prepare(stmt).run();
	db.prepare("INSERT INTO sessions (id, cwd) VALUES (?, '/x')").run(sessionId);
	const ins = db.prepare(
		"INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?, ?, ?, ?, ?)",
	);
	for (const t of turns) {
		ins.run(
			sessionId,
			t.turn_index,
			t.user_message ?? null,
			t.assistant_response ?? null,
			t.timestamp ?? "2026-05-05T07:00:00.000Z",
		);
	}
	db.close();
	return { dbPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("readCopilotTranscript", () => {
	let cleanups: Array<() => Promise<void>>;

	beforeEach(() => {
		cleanups = [];
	});
	afterEach(async () => {
		for (const c of cleanups) await c();
	});

	it("returns ordered human/assistant entries", async () => {
		const { dbPath, cleanup } = await makeDb("s1", [
			{ turn_index: 0, user_message: "hi", assistant_response: "hello" },
			{ turn_index: 1, user_message: "how are you", assistant_response: "good" },
		]);
		cleanups.push(cleanup);
		const { readCopilotTranscript } = await import("./CopilotTranscriptReader.js");
		const result = await readCopilotTranscript(`${dbPath}#s1`);
		expect(result.entries.map((e) => [e.role, e.content])).toEqual([
			["human", "hi"],
			["assistant", "hello"],
			["human", "how are you"],
			["assistant", "good"],
		]);
		expect(result.totalLinesRead).toBe(2);
		expect(result.newCursor.lineNumber).toBe(2);
	});

	it("skips empty/null messages within a turn", async () => {
		const { dbPath, cleanup } = await makeDb("s1", [
			{ turn_index: 0, user_message: "hi", assistant_response: null },
			{ turn_index: 1, user_message: "", assistant_response: "ack" },
		]);
		cleanups.push(cleanup);
		const { readCopilotTranscript } = await import("./CopilotTranscriptReader.js");
		const result = await readCopilotTranscript(`${dbPath}#s1`);
		expect(result.entries.map((e) => [e.role, e.content])).toEqual([
			["human", "hi"],
			["assistant", "ack"],
		]);
	});

	it("resumes from a cursor", async () => {
		const { dbPath, cleanup } = await makeDb("s1", [
			{ turn_index: 0, user_message: "first", assistant_response: "ok" },
			{ turn_index: 1, user_message: "second", assistant_response: "yep" },
		]);
		cleanups.push(cleanup);
		const { readCopilotTranscript } = await import("./CopilotTranscriptReader.js");
		const result = await readCopilotTranscript(`${dbPath}#s1`, {
			transcriptPath: `${dbPath}#s1`,
			lineNumber: 1,
			updatedAt: "2026-05-05T07:00:00.000Z",
		});
		expect(result.entries.map((e) => e.content)).toEqual(["second", "yep"]);
	});

	it("respects beforeTimestamp cutoff", async () => {
		const { dbPath, cleanup } = await makeDb("s1", [
			{ turn_index: 0, user_message: "early", assistant_response: "ok", timestamp: "2026-05-05T07:00:00.000Z" },
			{ turn_index: 1, user_message: "late", assistant_response: "no", timestamp: "2026-05-05T09:00:00.000Z" },
		]);
		cleanups.push(cleanup);
		const { readCopilotTranscript } = await import("./CopilotTranscriptReader.js");
		const result = await readCopilotTranscript(`${dbPath}#s1`, null, "2026-05-05T08:00:00.000Z");
		expect(result.entries.map((e) => e.content)).toEqual(["early", "ok"]);
		expect(result.newCursor.lineNumber).toBe(1);
	});

	it("throws on a malformed transcriptPath", async () => {
		const { readCopilotTranscript } = await import("./CopilotTranscriptReader.js");
		await expect(readCopilotTranscript("no-hash-marker")).rejects.toThrow(/Invalid Copilot transcript path/);
	});

	it("throws when transcriptPath has empty dbPath", async () => {
		const { readCopilotTranscript } = await import("./CopilotTranscriptReader.js");
		await expect(readCopilotTranscript("#only-session-id")).rejects.toThrow(/empty dbPath/);
	});

	it("throws when transcriptPath has empty sessionId", async () => {
		const { readCopilotTranscript } = await import("./CopilotTranscriptReader.js");
		await expect(readCopilotTranscript("/some/db#")).rejects.toThrow(/empty.*sessionId|empty dbPath or sessionId/);
	});

	it("respects both cursor and beforeTimestamp together", async () => {
		const { dbPath, cleanup } = await makeDb("s1", [
			{ turn_index: 0, user_message: "first", assistant_response: "ok", timestamp: "2026-05-05T07:00:00.000Z" },
			{ turn_index: 1, user_message: "middle", assistant_response: "yep", timestamp: "2026-05-05T08:00:00.000Z" },
			{ turn_index: 2, user_message: "late", assistant_response: "no", timestamp: "2026-05-05T10:00:00.000Z" },
		]);
		cleanups.push(cleanup);
		const { readCopilotTranscript } = await import("./CopilotTranscriptReader.js");
		// Resume from index 1 (skip "first"), with cutoff that excludes "late"
		const result = await readCopilotTranscript(
			`${dbPath}#s1`,
			{ transcriptPath: `${dbPath}#s1`, lineNumber: 1, updatedAt: "2026-05-05T07:00:00.000Z" },
			"2026-05-05T09:00:00.000Z",
		);
		expect(result.entries.map((e) => e.content)).toEqual(["middle", "yep"]);
		expect(result.newCursor.lineNumber).toBe(2);
	});

	it("returns empty when the session has no rows", async () => {
		const { dbPath, cleanup } = await makeDb("s1", []);
		cleanups.push(cleanup);
		const { readCopilotTranscript } = await import("./CopilotTranscriptReader.js");
		const result = await readCopilotTranscript(`${dbPath}#s1`);
		expect(result.entries).toEqual([]);
		expect(result.newCursor.lineNumber).toBe(0);
	});

	it("throws when the Copilot transcript DB cannot be opened", async () => {
		const { readCopilotTranscript } = await import("./CopilotTranscriptReader.js");
		await expect(readCopilotTranscript("/tmp/nonexistent.db#s1")).rejects.toThrow(/Cannot read Copilot session/);
	});

	it("emits entries without a timestamp when the row's timestamp column is NULL", async () => {
		const dir = await mkdtemp(join(tmpdir(), "copilot-tr-"));
		const dbPath = join(dir, "session-store.db");
		const db = new DatabaseSync(dbPath);
		for (const stmt of SCHEMA_STATEMENTS) db.prepare(stmt).run();
		db.prepare("INSERT INTO sessions (id, cwd) VALUES ('s1', '/x')").run();
		db.prepare(
			"INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES ('s1', 0, 'hi', 'hello', NULL)",
		).run();
		db.close();
		cleanups.push(() => rm(dir, { recursive: true, force: true }));

		const { readCopilotTranscript } = await import("./CopilotTranscriptReader.js");
		const result = await readCopilotTranscript(`${dbPath}#s1`);

		expect(result.entries.map((e) => [e.role, e.content, e.timestamp])).toEqual([
			["human", "hi", undefined],
			["assistant", "hello", undefined],
		]);
	});
});

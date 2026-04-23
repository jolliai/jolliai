import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import { readOpenCodeTranscript } from "./OpenCodeTranscriptReader.js";

/**
 * Creates an OpenCode SQLite DB with the real schema and inserts test data.
 * Returns the synthetic transcript path for the given session.
 */
async function createTestDb(
	dir: string,
	sessionId: string,
	messages: ReadonlyArray<{
		id: string;
		role: string;
		parts: ReadonlyArray<{ type: string; text?: string; [key: string]: unknown }>;
		time_created: number;
	}>,
): Promise<string> {
	await mkdir(dir, { recursive: true });
	const dbPath = join(dir, "opencode.db");

	const db = new DatabaseSync(dbPath);

	const ddl = [
		`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL DEFAULT '[]')`,
		`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', version TEXT NOT NULL DEFAULT '1', time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, FOREIGN KEY (project_id) REFERENCES project(id))`,
		`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, FOREIGN KEY (session_id) REFERENCES session(id))`,
		`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, FOREIGN KEY (message_id) REFERENCES message(id))`,
	];
	for (const sql of ddl) {
		db.prepare(sql).run();
	}

	const now = Date.now();
	db.prepare("INSERT INTO project (id, worktree, time_created, time_updated) VALUES (?, ?, ?, ?)").run(
		"proj-1",
		"/test",
		now,
		now,
	);
	db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)").run(
		sessionId,
		"proj-1",
		"/test",
		"Test",
		"1",
		now,
		now,
	);

	const insertMessage = db.prepare(
		"INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
	);
	const insertPart = db.prepare(
		"INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
	);

	for (const m of messages) {
		const msgData = JSON.stringify({ role: m.role });
		insertMessage.run(m.id, sessionId, m.time_created, m.time_created, msgData);

		for (let i = 0; i < m.parts.length; i++) {
			const partData = JSON.stringify(m.parts[i]);
			insertPart.run(`${m.id}-p${i}`, m.id, sessionId, m.time_created + i, m.time_created + i, partData);
		}
	}

	db.close();
	return `${dbPath}#${sessionId}`;
}

describe("OpenCodeTranscriptReader", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "opencode-reader-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("reads user and assistant messages, skipping system and tool roles", async () => {
		const now = Date.now();
		const transcriptPath = await createTestDb(tempDir, "sess-1", [
			{ id: "m1", role: "user", parts: [{ type: "text", text: "Fix the bug" }], time_created: now },
			{ id: "m2", role: "system", parts: [{ type: "text", text: "You are helpful" }], time_created: now + 1 },
			{ id: "m3", role: "assistant", parts: [{ type: "text", text: "Done fixing" }], time_created: now + 2 },
			{ id: "m4", role: "tool", parts: [{ type: "text", text: "tool output" }], time_created: now + 3 },
		]);

		const result = await readOpenCodeTranscript(transcriptPath);

		expect(result.entries).toHaveLength(2);
		expect(result.entries[0]).toEqual(expect.objectContaining({ role: "human", content: "Fix the bug" }));
		expect(result.entries[1]).toEqual(expect.objectContaining({ role: "assistant", content: "Done fixing" }));
	});

	it("extracts only text parts, skipping tool and patch parts", async () => {
		const now = Date.now();
		const transcriptPath = await createTestDb(tempDir, "sess-2", [
			{
				id: "m1",
				role: "assistant",
				parts: [
					{ type: "text", text: "Here is the fix" },
					{ type: "tool", tool: "bash", callID: "c1" },
					{ type: "patch", hash: "abc123" },
				],
				time_created: now,
			},
		]);

		const result = await readOpenCodeTranscript(transcriptPath);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].content).toBe("Here is the fix");
	});

	it("supports cursor-based incremental reading", async () => {
		const now = Date.now();
		const transcriptPath = await createTestDb(tempDir, "sess-3", [
			{ id: "m1", role: "user", parts: [{ type: "text", text: "First" }], time_created: now },
			{ id: "m2", role: "assistant", parts: [{ type: "text", text: "Reply 1" }], time_created: now + 1 },
			{ id: "m3", role: "user", parts: [{ type: "text", text: "Second" }], time_created: now + 2 },
			{ id: "m4", role: "assistant", parts: [{ type: "text", text: "Reply 2" }], time_created: now + 3 },
		]);

		const first = await readOpenCodeTranscript(transcriptPath);
		expect(first.entries).toHaveLength(4);
		expect(first.newCursor.lineNumber).toBe(4);

		const second = await readOpenCodeTranscript(transcriptPath, first.newCursor);
		expect(second.entries).toHaveLength(0);
		expect(second.totalLinesRead).toBe(0);
	});

	it("merges consecutive same-role entries", async () => {
		const now = Date.now();
		const transcriptPath = await createTestDb(tempDir, "sess-4", [
			{ id: "m1", role: "assistant", parts: [{ type: "text", text: "Part 1" }], time_created: now },
			{ id: "m2", role: "assistant", parts: [{ type: "text", text: "Part 2" }], time_created: now + 1 },
			{ id: "m3", role: "user", parts: [{ type: "text", text: "Question" }], time_created: now + 2 },
		]);

		const result = await readOpenCodeTranscript(transcriptPath);

		expect(result.entries).toHaveLength(2);
		expect(result.entries[0].role).toBe("assistant");
		expect(result.entries[0].content).toContain("Part 1");
		expect(result.entries[0].content).toContain("Part 2");
		expect(result.entries[1].role).toBe("human");
	});

	it("returns empty entries for session with no messages", async () => {
		const transcriptPath = await createTestDb(tempDir, "sess-5", []);

		const result = await readOpenCodeTranscript(transcriptPath);

		expect(result.entries).toHaveLength(0);
		expect(result.totalLinesRead).toBe(0);
		expect(result.newCursor.lineNumber).toBe(0);
	});

	it("skips messages with empty text content", async () => {
		const now = Date.now();
		const transcriptPath = await createTestDb(tempDir, "sess-6", [
			{ id: "m1", role: "user", parts: [{ type: "text", text: "   " }], time_created: now },
			{ id: "m2", role: "assistant", parts: [{ type: "text", text: "Real reply" }], time_created: now + 1 },
		]);

		const result = await readOpenCodeTranscript(transcriptPath);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].content).toBe("Real reply");
	});

	it("handles malformed message data JSON gracefully", async () => {
		const now = Date.now();
		await mkdir(tempDir, { recursive: true });
		const dbPath = join(tempDir, "opencode.db");
		const db = new DatabaseSync(dbPath);

		const ddl = [
			`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL DEFAULT '[]')`,
			`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', version TEXT NOT NULL DEFAULT '1', time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, FOREIGN KEY (project_id) REFERENCES project(id))`,
			`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, FOREIGN KEY (session_id) REFERENCES session(id))`,
			`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, FOREIGN KEY (message_id) REFERENCES message(id))`,
		];
		for (const sql of ddl) {
			db.prepare(sql).run();
		}

		db.prepare("INSERT INTO project (id, worktree, time_created, time_updated) VALUES (?, ?, ?, ?)").run(
			"p1",
			"/",
			now,
			now,
		);
		db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)").run("sess-7", "p1", "/", "Test", "1", now, now);
		db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("m1", "sess-7", now, now, "not valid json");
		db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
			"m2",
			"sess-7",
			now + 1,
			now + 1,
			JSON.stringify({ role: "assistant" }),
		);
		db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
			"m2-p0",
			"m2",
			"sess-7",
			now + 1,
			now + 1,
			JSON.stringify({ type: "text", text: "Valid reply" }),
		);
		db.close();

		const result = await readOpenCodeTranscript(`${dbPath}#sess-7`);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].content).toBe("Valid reply");
	});

	it("skips messages whose time_created is not a finite number (schema drift)", async () => {
		const now = Date.now();
		const transcriptPath = await createTestDb(tempDir, "sess-drift", [
			{ id: "good", role: "user", parts: [{ type: "text", text: "real message" }], time_created: now },
		]);
		const dbPath = transcriptPath.split("#")[0];
		// SQLite's INTEGER affinity preserves non-numeric TEXT at rest, simulating
		// a drifted OpenCode schema where time_created is not a valid number.
		const db = new DatabaseSync(dbPath);
		db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
			"bad",
			"sess-drift",
			"garbage",
			"garbage",
			JSON.stringify({ role: "assistant" }),
		);
		db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
			"bad-p0",
			"bad",
			"sess-drift",
			0,
			0,
			JSON.stringify({ type: "text", text: "would-throw-toISOString" }),
		);
		db.close();

		const result = await readOpenCodeTranscript(transcriptPath);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].content).toBe("real message");
	});

	it("converts time_created unix ms to ISO 8601 timestamps", async () => {
		const timestamp = 1711900000000;
		const transcriptPath = await createTestDb(tempDir, "sess-8", [
			{ id: "m1", role: "user", parts: [{ type: "text", text: "Hello" }], time_created: timestamp },
		]);

		const result = await readOpenCodeTranscript(transcriptPath);

		expect(result.entries[0].timestamp).toBe(new Date(timestamp).toISOString());
	});

	it("throws on invalid synthetic path (missing #sessionId)", async () => {
		await expect(readOpenCodeTranscript("/no/hash/separator")).rejects.toThrow("missing #sessionId");
	});

	it("throws on invalid synthetic path with an empty dbPath or session id", async () => {
		await expect(readOpenCodeTranscript("#sess-x")).rejects.toThrow("empty dbPath or sessionId");
		await expect(readOpenCodeTranscript("/tmp/opencode.db#")).rejects.toThrow("empty dbPath or sessionId");
	});

	it("throws when DB file does not exist", async () => {
		const fakePath = join(tempDir, "nonexistent.db#sess-x");
		await expect(readOpenCodeTranscript(fakePath)).rejects.toThrow();
	});

	it("joins multiple text parts within a single message", async () => {
		const now = Date.now();
		const transcriptPath = await createTestDb(tempDir, "sess-9", [
			{
				id: "m1",
				role: "assistant",
				parts: [
					{ type: "text", text: "Line one" },
					{ type: "text", text: "Line two" },
				],
				time_created: now,
			},
		]);

		const result = await readOpenCodeTranscript(transcriptPath);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].content).toBe("Line one\nLine two");
	});

	it("preserves cursor transcriptPath as the synthetic path", async () => {
		const now = Date.now();
		const transcriptPath = await createTestDb(tempDir, "sess-10", [
			{ id: "m1", role: "user", parts: [{ type: "text", text: "Hello" }], time_created: now },
		]);

		const result = await readOpenCodeTranscript(transcriptPath);

		expect(result.newCursor.transcriptPath).toBe(transcriptPath);
	});

	it("handles messages with no parts (LEFT JOIN returns null)", async () => {
		const now = Date.now();
		const transcriptPath = await createTestDb(tempDir, "sess-11", [
			{ id: "m1", role: "assistant", parts: [], time_created: now },
			{ id: "m2", role: "user", parts: [{ type: "text", text: "Hello" }], time_created: now + 1 },
		]);

		const result = await readOpenCodeTranscript(transcriptPath);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].content).toBe("Hello");
	});

	it("skips malformed part JSON and keeps valid text parts from the same message", async () => {
		const now = Date.now();
		await mkdir(tempDir, { recursive: true });
		const dbPath = join(tempDir, "opencode.db");
		const db = new DatabaseSync(dbPath);

		for (const sql of [
			`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL DEFAULT '[]')`,
			`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', version TEXT NOT NULL DEFAULT '1', time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, FOREIGN KEY (project_id) REFERENCES project(id))`,
			`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, FOREIGN KEY (session_id) REFERENCES session(id))`,
			`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, FOREIGN KEY (message_id) REFERENCES message(id))`,
		]) {
			db.prepare(sql).run();
		}

		db.prepare("INSERT INTO project (id, worktree, time_created, time_updated) VALUES (?, ?, ?, ?)").run(
			"p1",
			"/",
			now,
			now,
		);
		db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)").run("sess-15", "p1", "/", "Test", "1", now, now);
		db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
			"m1",
			"sess-15",
			now,
			now,
			JSON.stringify({ role: "assistant" }),
		);
		db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run("m1-p0", "m1", "sess-15", now, now, "not json");
		db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
			"m1-p1",
			"m1",
			"sess-15",
			now + 1,
			now + 1,
			JSON.stringify({ type: "text", text: "Valid text" }),
		);
		db.close();

		const result = await readOpenCodeTranscript(`${dbPath}#sess-15`);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].content).toBe("Valid text");
	});

	it("stops consuming messages at beforeTimestamp cutoff", async () => {
		const base = 1711900000000;
		const transcriptPath = await createTestDb(tempDir, "sess-12", [
			{ id: "m1", role: "user", parts: [{ type: "text", text: "Before" }], time_created: base },
			{ id: "m2", role: "assistant", parts: [{ type: "text", text: "Reply" }], time_created: base + 1000 },
			{ id: "m3", role: "user", parts: [{ type: "text", text: "After" }], time_created: base + 5000 },
			{ id: "m4", role: "assistant", parts: [{ type: "text", text: "Late reply" }], time_created: base + 6000 },
		]);

		// Cutoff between m2 and m3
		const cutoff = new Date(base + 2000).toISOString();
		const result = await readOpenCodeTranscript(transcriptPath, null, cutoff);

		expect(result.entries).toHaveLength(2);
		expect(result.entries[0].content).toBe("Before");
		expect(result.entries[1].content).toBe("Reply");
		// Cursor advances only to the last consumed message, not end
		expect(result.newCursor.lineNumber).toBe(2);
	});

	it("advances cursor to end when no beforeTimestamp is provided", async () => {
		const base = 1711900000000;
		const transcriptPath = await createTestDb(tempDir, "sess-13", [
			{ id: "m1", role: "user", parts: [{ type: "text", text: "Hello" }], time_created: base },
			{ id: "m2", role: "assistant", parts: [{ type: "text", text: "World" }], time_created: base + 1000 },
		]);

		// Without beforeTimestamp, cursor should advance to end of all messages
		const result = await readOpenCodeTranscript(transcriptPath);

		expect(result.entries).toHaveLength(2);
		expect(result.newCursor.lineNumber).toBe(2);
	});

	it("resumes from cursor after beforeTimestamp-limited read", async () => {
		const base = 1711900000000;
		const transcriptPath = await createTestDb(tempDir, "sess-14", [
			{ id: "m1", role: "user", parts: [{ type: "text", text: "First" }], time_created: base },
			{ id: "m2", role: "assistant", parts: [{ type: "text", text: "Reply 1" }], time_created: base + 1000 },
			{ id: "m3", role: "user", parts: [{ type: "text", text: "Second" }], time_created: base + 5000 },
			{ id: "m4", role: "assistant", parts: [{ type: "text", text: "Reply 2" }], time_created: base + 6000 },
		]);

		// First read: cutoff after m2
		const cutoff1 = new Date(base + 2000).toISOString();
		const first = await readOpenCodeTranscript(transcriptPath, null, cutoff1);
		expect(first.entries).toHaveLength(2);
		expect(first.newCursor.lineNumber).toBe(2);

		// Second read: no cutoff, pick up remaining messages
		const second = await readOpenCodeTranscript(transcriptPath, first.newCursor);
		expect(second.entries).toHaveLength(2);
		expect(second.entries[0].content).toBe("Second");
		expect(second.entries[1].content).toBe("Reply 2");
	});
});

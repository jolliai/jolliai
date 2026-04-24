import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

// Mock homedir so tests don't depend on real home directory
const { mockHomedir } = vi.hoisted(() => ({
	mockHomedir: vi.fn().mockReturnValue(""),
}));
vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: mockHomedir };
});

import {
	classifyScanError,
	discoverOpenCodeSessions,
	getOpenCodeDbPath,
	hasNodeSqliteSupport,
	isOpenCodeInstalled,
	NODE_SQLITE_MIN_VERSION,
	scanOpenCodeSessions,
} from "./OpenCodeSessionDiscoverer.js";

/**
 * Creates a minimal OpenCode SQLite database with the real schema.
 * Returns the path to the DB file.
 */
async function createOpenCodeDb(
	dbDir: string,
	sessions: ReadonlyArray<{
		id: string;
		title?: string;
		directory: string;
		parent_id?: string | null;
		project_id?: string;
		time_created: number;
		time_updated: number;
	}>,
): Promise<string> {
	await mkdir(dbDir, { recursive: true });
	const dbPath = join(dbDir, "opencode.db");

	const db = new DatabaseSync(dbPath);

	const ddl = [
		`CREATE TABLE project (
			id TEXT PRIMARY KEY,
			worktree TEXT NOT NULL,
			name TEXT,
			time_created INTEGER NOT NULL,
			time_updated INTEGER NOT NULL,
			sandboxes TEXT NOT NULL DEFAULT '[]'
		)`,
		`CREATE TABLE session (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL,
			parent_id TEXT,
			slug TEXT NOT NULL DEFAULT '',
			directory TEXT NOT NULL,
			title TEXT NOT NULL DEFAULT '',
			version TEXT NOT NULL DEFAULT '1',
			time_created INTEGER NOT NULL,
			time_updated INTEGER NOT NULL,
			FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
		)`,
		`CREATE TABLE message (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			time_created INTEGER NOT NULL,
			time_updated INTEGER NOT NULL,
			data TEXT NOT NULL,
			FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
		)`,
		`CREATE TABLE part (
			id TEXT PRIMARY KEY,
			message_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			time_created INTEGER NOT NULL,
			time_updated INTEGER NOT NULL,
			data TEXT NOT NULL,
			FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
		)`,
	];
	for (const sql of ddl) {
		db.prepare(sql).run();
	}

	const defaultProjectId = "proj-test";
	db.prepare("INSERT INTO project (id, worktree, time_created, time_updated) VALUES (?, ?, ?, ?)").run(
		defaultProjectId,
		"/test",
		Date.now(),
		Date.now(),
	);

	const insertSession = db.prepare(
		"INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	for (const s of sessions) {
		insertSession.run(
			s.id,
			s.project_id ?? defaultProjectId,
			s.parent_id ?? null,
			s.directory,
			s.title ?? "Test Session",
			s.time_created,
			s.time_updated,
		);
	}

	db.close();
	return dbPath;
}

describe("OpenCodeSessionDiscoverer", () => {
	let tempDir: string;
	let fakeHome: string;
	const projectDir = "/Users/test/my-project";
	const savedXdgDataHome = process.env.XDG_DATA_HOME;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "opencode-test-"));
		fakeHome = await mkdtemp(join(tmpdir(), "opencode-home-"));
		mockHomedir.mockReturnValue(fakeHome);
		delete process.env.XDG_DATA_HOME;
	});

	afterEach(async () => {
		// Restore XDG_DATA_HOME to avoid leaking between tests
		if (savedXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = savedXdgDataHome;
		await rm(tempDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	describe("getOpenCodeDbPath", () => {
		it("returns the default XDG path under home directory", () => {
			delete process.env.XDG_DATA_HOME;
			mockHomedir.mockReturnValue("/home/user");
			expect(getOpenCodeDbPath()).toBe(join("/home/user", ".local/share/opencode/opencode.db"));
		});

		it("respects XDG_DATA_HOME when set", () => {
			process.env.XDG_DATA_HOME = "/custom/data";
			expect(getOpenCodeDbPath()).toBe(join("/custom/data", "opencode/opencode.db"));
		});
	});

	describe("isOpenCodeInstalled", () => {
		it("returns true when global opencode.db exists", async () => {
			const dbDir = join(fakeHome, ".local", "share", "opencode");
			await createOpenCodeDb(dbDir, []);
			expect(await isOpenCodeInstalled()).toBe(true);
		});

		it("returns false when opencode.db does not exist", async () => {
			expect(await isOpenCodeInstalled()).toBe(false);
		});

		it("returns false when directory exists but DB file does not", async () => {
			await mkdir(join(fakeHome, ".local", "share", "opencode"), { recursive: true });
			expect(await isOpenCodeInstalled()).toBe(false);
		});

		it("finds opencode.db at custom XDG_DATA_HOME", async () => {
			const customData = join(tempDir, "custom-data");
			process.env.XDG_DATA_HOME = customData;
			const dbDir = join(customData, "opencode");
			await createOpenCodeDb(dbDir, []);
			expect(await isOpenCodeInstalled()).toBe(true);
		});

		it("returns false when runtime Node version is below the node:sqlite threshold", async () => {
			// Even with a real DB file, an unsupported Node runtime must report "not installed"
			// so the UI never shows a detected-but-unusable OpenCode integration.
			const dbDir = join(fakeHome, ".local", "share", "opencode");
			await createOpenCodeDb(dbDir, []);
			const originalDescriptor = Object.getOwnPropertyDescriptor(process.versions, "node");
			Object.defineProperty(process.versions, "node", { value: "20.15.0", configurable: true });
			try {
				expect(await isOpenCodeInstalled()).toBe(false);
			} finally {
				/* v8 ignore next -- Object.getOwnPropertyDescriptor on a standard process field always returns a descriptor on supported runtimes */
				if (originalDescriptor) Object.defineProperty(process.versions, "node", originalDescriptor);
			}
		});
	});

	describe("hasNodeSqliteSupport", () => {
		const { major, minor } = NODE_SQLITE_MIN_VERSION;

		it("returns true on exactly the minimum version", () => {
			expect(hasNodeSqliteSupport(`${major}.${minor}.0`)).toBe(true);
		});

		it("returns true on a later major", () => {
			expect(hasNodeSqliteSupport(`${major + 1}.0.0`)).toBe(true);
		});

		it("returns true on a later minor within the same major", () => {
			expect(hasNodeSqliteSupport(`${major}.${minor + 1}.0`)).toBe(true);
		});

		it("returns false on an earlier minor within the same major", () => {
			// minor=0 covers the "earlier minor" branch even when NODE_SQLITE_MIN_VERSION.minor is 0
			// (the comparison is `>=`, so 22.0.0 < 22.5.0 returns false).
			expect(hasNodeSqliteSupport(`${major}.0.0`)).toBe(false);
		});

		it("returns false on an earlier major", () => {
			expect(hasNodeSqliteSupport(`${major - 1}.99.0`)).toBe(false);
		});

		it("treats prerelease tags correctly (major.minor extracted from prefix)", () => {
			expect(hasNodeSqliteSupport("22.5.0-nightly20260101")).toBe(true);
			expect(hasNodeSqliteSupport("20.15.0-nightly20260101")).toBe(false);
		});
	});

	describe("discoverOpenCodeSessions", () => {
		it("discovers recent top-level sessions for the given project", async () => {
			const now = Date.now();
			const dbDir = join(fakeHome, ".local", "share", "opencode");
			await createOpenCodeDb(dbDir, [
				{ id: "s1", directory: projectDir, time_created: now - 1000, time_updated: now - 500 },
				{ id: "s2", directory: projectDir, time_created: now - 2000, time_updated: now - 100 },
			]);

			const sessions = await discoverOpenCodeSessions(projectDir);

			expect(sessions).toHaveLength(2);
			expect(sessions[0].sessionId).toBe("s2");
			expect(sessions[1].sessionId).toBe("s1");
			expect(sessions[0].source).toBe("opencode");
			expect(sessions[0].transcriptPath).toContain("#s2");
		});

		it("filters out sessions from other projects", async () => {
			const now = Date.now();
			const dbDir = join(fakeHome, ".local", "share", "opencode");
			await createOpenCodeDb(dbDir, [
				{ id: "mine", directory: projectDir, time_created: now - 1000, time_updated: now - 100 },
				{
					id: "other",
					directory: "/Users/test/other-project",
					time_created: now - 500,
					time_updated: now - 50,
				},
			]);

			const sessions = await discoverOpenCodeSessions(projectDir);

			expect(sessions).toHaveLength(1);
			expect(sessions[0].sessionId).toBe("mine");
		});

		it("filters out stale sessions older than 48 hours", async () => {
			const now = Date.now();
			const old = now - 49 * 60 * 60 * 1000;
			const dbDir = join(fakeHome, ".local", "share", "opencode");
			await createOpenCodeDb(dbDir, [
				{ id: "fresh", directory: projectDir, time_created: now - 1000, time_updated: now - 100 },
				{ id: "stale", directory: projectDir, time_created: old, time_updated: old },
			]);

			const sessions = await discoverOpenCodeSessions(projectDir);

			expect(sessions).toHaveLength(1);
			expect(sessions[0].sessionId).toBe("fresh");
		});

		it("includes child sessions from auto-compaction (non-null parent_id)", async () => {
			const now = Date.now();
			const dbDir = join(fakeHome, ".local", "share", "opencode");
			await createOpenCodeDb(dbDir, [
				{ id: "parent", directory: projectDir, time_created: now - 1000, time_updated: now - 100 },
				{
					id: "child",
					directory: projectDir,
					parent_id: "parent",
					time_created: now - 500,
					time_updated: now - 50,
				},
			]);

			const sessions = await discoverOpenCodeSessions(projectDir);

			// Both parent and compacted child sessions are discovered
			expect(sessions).toHaveLength(2);
			const ids = sessions.map((s) => s.sessionId);
			expect(ids).toContain("parent");
			expect(ids).toContain("child");
		});

		it("returns empty array when DB does not exist", async () => {
			const sessions = await discoverOpenCodeSessions(projectDir);
			expect(sessions).toHaveLength(0);
		});

		it("returns empty array when DB has no matching sessions", async () => {
			const dbDir = join(fakeHome, ".local", "share", "opencode");
			await createOpenCodeDb(dbDir, []);
			const sessions = await discoverOpenCodeSessions(projectDir);
			expect(sessions).toHaveLength(0);
		});

		it("converts time_updated from unix ms to ISO 8601", async () => {
			const now = Date.now();
			const dbDir = join(fakeHome, ".local", "share", "opencode");
			await createOpenCodeDb(dbDir, [
				{ id: "ts-test", directory: projectDir, time_created: now - 1000, time_updated: now },
			]);

			const sessions = await discoverOpenCodeSessions(projectDir);

			expect(sessions[0].updatedAt).toBe(new Date(now).toISOString());
		});

		it("matches directory case-insensitively on Windows and macOS (drive-letter / path-casing drift)", async () => {
			// Reproduces the real Windows bug observed in debug.log:
			//   worker pipeline spawned with cwd "E:\\jollimemory-3" → stored by OpenCode
			//   extension status reported projectDir "e:\\jollimemory-3" → exact-match missed
			// Both describe the same directory on a case-insensitive filesystem, so the
			// SQL must match regardless of drive-letter casing on Windows / macOS.
			// Linux filesystems are case-sensitive, so exact-match is the correct behaviour
			// there and this test asserts the lookup returns empty.
			const now = Date.now();
			const dbDir = join(fakeHome, ".local", "share", "opencode");
			const storedDir = "E:\\jollimemory-3";
			const queryDir = "e:\\jollimemory-3";
			await createOpenCodeDb(dbDir, [
				{ id: "drive-letter", directory: storedDir, time_created: now - 1000, time_updated: now },
			]);

			const sessions = await discoverOpenCodeSessions(queryDir);

			const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
			if (caseInsensitive) {
				expect(sessions.map((s) => s.sessionId)).toEqual(["drive-letter"]);
			} else {
				expect(sessions).toHaveLength(0);
			}
		});

		it("skips sessions whose time_updated is not a finite number (schema drift)", async () => {
			const now = Date.now();
			const dbDir = join(fakeHome, ".local", "share", "opencode");
			const dbPath = await createOpenCodeDb(dbDir, [
				{ id: "good", directory: projectDir, time_created: now - 1000, time_updated: now },
			]);
			// SQLite's INTEGER column affinity does not coerce non-numeric TEXT —
			// the value stays TEXT at rest, simulating schema drift or corrupted data.
			const db = new DatabaseSync(dbPath);
			db.prepare(
				"INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run("bad", "proj-test", null, projectDir, "Bad", now - 500, "not-a-number");
			db.close();

			const sessions = await discoverOpenCodeSessions(projectDir);

			expect(sessions.map((s) => s.sessionId)).toEqual(["good"]);
		});
	});

	describe("scanOpenCodeSessions error classification", () => {
		it("returns no error when DB is missing (ENOENT treated as 'not installed')", async () => {
			const result = await scanOpenCodeSessions(projectDir);
			expect(result.sessions).toEqual([]);
			expect(result.error).toBeUndefined();
		});

		it("classifies a garbage DB file as corrupt and surfaces the error", async () => {
			const dbDir = join(fakeHome, ".local", "share", "opencode");
			await mkdir(dbDir, { recursive: true });
			// Write bytes that are not a valid SQLite header → SQLITE_NOTADB.
			await writeFile(join(dbDir, "opencode.db"), "this is not an SQLite database");

			const result = await scanOpenCodeSessions(projectDir);

			expect(result.sessions).toEqual([]);
			expect(result.error).toBeDefined();
			// node:sqlite errors on a non-DB may surface as "not a database" or "file is not a database"
			expect(["corrupt", "unknown"]).toContain(result.error?.kind);
		});

		it("classifies missing session table as schema drift", async () => {
			const dbDir = join(fakeHome, ".local", "share", "opencode");
			await mkdir(dbDir, { recursive: true });
			// Create a valid SQLite DB but without the `session` table OpenCode expects.
			const dbPath = join(dbDir, "opencode.db");
			const db = new DatabaseSync(dbPath);
			db.prepare("CREATE TABLE unrelated (id TEXT)").run();
			db.close();

			const result = await scanOpenCodeSessions(projectDir);

			expect(result.sessions).toEqual([]);
			expect(result.error?.kind).toBe("schema");
		});

		it("discoverOpenCodeSessions (compat wrapper) still returns only sessions on real failures", async () => {
			const dbDir = join(fakeHome, ".local", "share", "opencode");
			await mkdir(dbDir, { recursive: true });
			await writeFile(join(dbDir, "opencode.db"), "garbage");

			// The compat wrapper must not throw, even though the scan hit a real error.
			const sessions = await discoverOpenCodeSessions(projectDir);
			expect(sessions).toEqual([]);
		});
	});

	describe("classifyScanError", () => {
		function err(message: string, code?: string): Error & { code?: string } {
			const e = new Error(message) as Error & { code?: string };
			if (code !== undefined) e.code = code;
			return e;
		}

		it("returns null for ENOENT (silent 'not installed')", () => {
			expect(classifyScanError(err("…", "ENOENT"))).toBeNull();
		});

		it("classifies EACCES and EPERM as permission", () => {
			expect(classifyScanError(err("denied", "EACCES"))?.kind).toBe("permission");
			expect(classifyScanError(err("denied", "EPERM"))?.kind).toBe("permission");
		});

		it("classifies SQLITE_CANTOPEN / 'unable to open' as permission", () => {
			expect(classifyScanError(err("SQLITE_CANTOPEN: file failed to open"))?.kind).toBe("permission");
			expect(classifyScanError(err("unable to open database file"))?.kind).toBe("permission");
		});

		it("classifies SQLITE_CORRUPT and similar as corrupt", () => {
			expect(classifyScanError(err("SQLITE_CORRUPT: database disk image is malformed"))?.kind).toBe("corrupt");
			expect(classifyScanError(err("file is not a database"))?.kind).toBe("corrupt");
			expect(classifyScanError(err("SQLITE_NOTADB"))?.kind).toBe("corrupt");
		});

		it("classifies SQLITE_BUSY / SQLITE_LOCKED as locked", () => {
			expect(classifyScanError(err("SQLITE_BUSY: database is locked"))?.kind).toBe("locked");
			expect(classifyScanError(err("database is locked"))?.kind).toBe("locked");
			expect(classifyScanError(err("SQLITE_LOCKED"))?.kind).toBe("locked");
		});

		it("classifies 'no such table'/'no such column' as schema drift", () => {
			expect(classifyScanError(err("no such table: session"))?.kind).toBe("schema");
			expect(classifyScanError(err("no such column: time_updated"))?.kind).toBe("schema");
		});

		it("falls back to 'unknown' for unrecognized errors", () => {
			const classified = classifyScanError(err("totally unexpected disk failure"));
			expect(classified?.kind).toBe("unknown");
			expect(classified?.message).toBe("totally unexpected disk failure");
		});

		it("handles non-Error throws by stringifying", () => {
			const classified = classifyScanError("raw string rejection");
			expect(classified?.kind).toBe("unknown");
			expect(classified?.message).toBe("raw string rejection");
		});
	});
});

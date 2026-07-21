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

// The directory match runs through `normalizePathForCompare`, which reads
// `process.platform` directly. Override it per-test so the case-sensitivity
// branch is deterministic regardless of host OS, and restore in afterEach.
const savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");
function setPlatform(os: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: os, configurable: true });
}

import {
	discoverOpenCodeSessions,
	getOpenCodeDbPath,
	isOpenCodeInstalled,
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
		/* v8 ignore next -- the platform descriptor is always present on supported runtimes */
		if (savedPlatform) Object.defineProperty(process, "platform", savedPlatform);
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

	describe("discoverOpenCodeSessions", () => {
		it("discovers recent top-level sessions for the given project", async () => {
			const now = Date.now();
			const dbDir = join(fakeHome, ".local", "share", "opencode");
			await createOpenCodeDb(dbDir, [
				{ id: "s1", directory: projectDir, time_created: now - 1000, time_updated: now - 500 },
				{ id: "s2", directory: projectDir, time_created: now - 2000, time_updated: now - 100 },
			]);

			const sessions = await discoverOpenCodeSessions(projectDir);

			// The query has no ORDER BY — all matching rows are kept regardless of order —
			// so assert on set membership rather than a specific ordering.
			expect(sessions).toHaveLength(2);
			const byId = new Map(sessions.map((s) => [s.sessionId, s]));
			expect([...byId.keys()].sort()).toEqual(["s1", "s2"]);
			expect(byId.get("s2")?.source).toBe("opencode");
			expect(byId.get("s2")?.transcriptPath).toContain("#s2");
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

		// JOLLI-2015: a session run from a subdirectory of the project (common in a
		// monorepo, `cd packages/foo && opencode`) IS attributed to the repo via
		// prefix/containment matching — semantics shared with Devin.
		it("discovers a session run in a subdirectory of the project (prefix match)", async () => {
			const now = Date.now();
			const dbDir = join(fakeHome, ".local", "share", "opencode");
			await createOpenCodeDb(dbDir, [
				{
					id: "in-subdir",
					directory: join(projectDir, "packages", "foo"),
					time_created: now - 1000,
					time_updated: now - 100,
				},
			]);

			const sessions = await discoverOpenCodeSessions(projectDir);
			expect(sessions.map((s) => s.sessionId)).toEqual(["in-subdir"]);
		});

		// A session living in a NESTED git repo / submodule inside the worktree
		// belongs to the inner repo's own post-commit, not this one — an intervening
		// `.git` excludes it. Uses a real temp dir so `.git` can exist on disk.
		it("does NOT discover a session inside a nested git repo under the project", async () => {
			const now = Date.now();
			const dbDir = join(fakeHome, ".local", "share", "opencode");
			const realRepo = await mkdtemp(join(tmpdir(), "opencode-nested-"));
			try {
				const nested = join(realRepo, "vendor", "lib");
				await mkdir(join(nested, ".git"), { recursive: true });
				await createOpenCodeDb(dbDir, [
					{ id: "nested", directory: nested, time_created: now - 1000, time_updated: now - 100 },
				]);

				expect(await discoverOpenCodeSessions(realRepo)).toHaveLength(0);
			} finally {
				await rm(realRepo, { recursive: true, force: true });
			}
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

		it("propagates the native session title from the DB into SessionInfo.title", async () => {
			const now = Date.now();
			const dbDir = join(fakeHome, ".local", "share", "opencode");
			await createOpenCodeDb(dbDir, [
				{
					id: "titled",
					directory: projectDir,
					title: "Refactor session storage layer",
					time_created: now - 1000,
					time_updated: now - 100,
				},
			]);

			const result = await scanOpenCodeSessions(projectDir);

			expect(result.sessions).toHaveLength(1);
			expect(result.sessions[0].title).toBe("Refactor session storage layer");
		});

		// Coverage: `title` is propagated only when the DB cell is a
		// non-blank string. An empty / whitespace-only / non-string title
		// must collapse to `undefined` so the resolver's fallback cascade
		// runs instead of surfacing a blank label.
		it.each([
			["empty string", ""],
			["whitespace only", "   \t"],
		])("collapses to undefined title when row.title is %s", async (_label, raw) => {
			const now = Date.now();
			const dbDir = join(fakeHome, ".local", "share", "opencode");
			await createOpenCodeDb(dbDir, [
				{
					id: "blank-title",
					directory: projectDir,
					title: raw,
					time_created: now - 1000,
					time_updated: now - 100,
				},
			]);
			const result = await scanOpenCodeSessions(projectDir);
			expect(result.sessions).toHaveLength(1);
			expect(result.sessions[0].title).toBeUndefined();
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

		it.each(["darwin", "win32"] as const)(
			"matches directory case-insensitively on %s (drive-letter / path-casing drift)",
			async (osName) => {
				// Reproduces the real Windows bug observed in debug.log:
				//   worker pipeline spawned with cwd "E:\\jollimemory-3" → stored by OpenCode
				//   extension status reported projectDir "e:\\jollimemory-3" → exact-match missed
				// Both describe the same directory on a case-insensitive filesystem, so the
				// match must hold regardless of drive-letter casing on Windows / macOS.
				// `sessionDirBelongsToRepo` folds case via `normalizePathForCompare`, which
				// reads `process.platform` — so drive the platform there, not the node:os mock.
				// Linux's case-sensitive behaviour is asserted by the next test.
				setPlatform(osName);
				const now = Date.now();
				const dbDir = join(fakeHome, ".local", "share", "opencode");
				const storedDir = "E:\\jollimemory-3";
				const queryDir = "e:\\jollimemory-3";
				await createOpenCodeDb(dbDir, [
					{ id: "drive-letter", directory: storedDir, time_created: now - 1000, time_updated: now },
				]);

				const sessions = await discoverOpenCodeSessions(queryDir);

				expect(sessions.map((s) => s.sessionId)).toEqual(["drive-letter"]);
			},
		);

		it("matches directory exactly (case-sensitive) on linux", async () => {
			// Linux filesystems are case-sensitive, so a casing mismatch must NOT
			// resolve to the same session. This exercises the case-sensitive branch of
			// `normalizePathForCompare` (no lowercasing) that darwin/win32 hosts skip.
			setPlatform("linux");
			const now = Date.now();
			const dbDir = join(fakeHome, ".local", "share", "opencode");
			const storedDir = "/home/flyer/Project";
			await createOpenCodeDb(dbDir, [
				{ id: "exact-1", directory: storedDir, time_created: now - 1000, time_updated: now },
			]);

			// Lowercased query MUST NOT match the original-cased stored directory.
			expect(await discoverOpenCodeSessions("/home/flyer/project")).toHaveLength(0);
			// Same-cased query DOES match — confirms the linux branch was reached.
			const sessions = await discoverOpenCodeSessions("/home/flyer/Project");
			expect(sessions.map((s) => s.sessionId)).toEqual(["exact-1"]);
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
});

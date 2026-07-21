import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

// The directory match now runs through `normalizePathForCompare`, which reads
// `process.platform` directly. Override it per-test so the case-sensitivity
// branch is deterministic regardless of host OS, and restore in afterEach.
const savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");
function setPlatform(os: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: os, configurable: true });
}

import { createDevinDb, sampleDevinMessageForest } from "../testUtils/devinDbFixture.js";
import {
	discoverDevinSessions,
	getDevinSessionsDbPath,
	isDevinInstalled,
	scanDevinSessions,
	scanDevinSessionsAt,
} from "./DevinSessionDiscoverer.js";

describe("DevinSessionDiscoverer", () => {
	let tempDir: string;
	let fakeDataHome: string;
	const projectDir = "/tmp/proj";
	const savedXdgDataHome = process.env.XDG_DATA_HOME;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "devin-test-"));
		fakeDataHome = await mkdtemp(join(tmpdir(), "devin-data-"));
		process.env.XDG_DATA_HOME = fakeDataHome;
		setPlatform("darwin");
	});

	afterEach(async () => {
		if (savedXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = savedXdgDataHome;
		/* v8 ignore next -- the platform descriptor is always present on supported runtimes */
		if (savedPlatform) Object.defineProperty(process, "platform", savedPlatform);
		await rm(tempDir, { recursive: true, force: true });
		await rm(fakeDataHome, { recursive: true, force: true });
	});

	describe("getDevinSessionsDbPath", () => {
		it("resolves under the given home when XDG_DATA_HOME is unset", () => {
			delete process.env.XDG_DATA_HOME;
			expect(getDevinSessionsDbPath("/home/u")).toBe(
				join("/home/u", ".local", "share", "devin", "cli", "sessions.db"),
			);
		});

		it("respects XDG_DATA_HOME when set", () => {
			process.env.XDG_DATA_HOME = "/custom/data";
			expect(getDevinSessionsDbPath("/home/u")).toBe(join("/custom/data", "devin", "cli", "sessions.db"));
		});

		it("falls back to the OS home directory when no home is given", () => {
			delete process.env.XDG_DATA_HOME;
			expect(getDevinSessionsDbPath()).toBe(join(homedir(), ".local", "share", "devin", "cli", "sessions.db"));
		});

		// On win32 Devin stores its DB under %APPDATA%\devin\cli (Roaming), NOT the
		// XDG layout — verified on a real Windows install
		// (C:\Users\<u>\AppData\Roaming\devin\cli\sessions.db). Without this branch
		// isDevinInstalled() is always false on Windows and the source never appears.
		it("uses %APPDATA% on win32 (and ignores XDG_DATA_HOME there)", () => {
			setPlatform("win32");
			// beforeEach set XDG_DATA_HOME; win32 must not consult it.
			const savedAppData = process.env.APPDATA;
			process.env.APPDATA = "C:\\Users\\sanshi\\AppData\\Roaming";
			try {
				expect(getDevinSessionsDbPath("C:\\Users\\sanshi")).toBe(
					join("C:\\Users\\sanshi\\AppData\\Roaming", "devin", "cli", "sessions.db"),
				);
			} finally {
				if (savedAppData === undefined) delete process.env.APPDATA;
				else process.env.APPDATA = savedAppData;
			}
		});

		it("falls back to ~/AppData/Roaming on win32 when APPDATA is unset", () => {
			setPlatform("win32");
			const savedAppData = process.env.APPDATA;
			delete process.env.APPDATA;
			try {
				expect(getDevinSessionsDbPath("C:\\Users\\sanshi")).toBe(
					join("C:\\Users\\sanshi", "AppData", "Roaming", "devin", "cli", "sessions.db"),
				);
			} finally {
				if (savedAppData === undefined) delete process.env.APPDATA;
				else process.env.APPDATA = savedAppData;
			}
		});
	});

	describe("isDevinInstalled", () => {
		it("returns true when sessions.db exists as a file", async () => {
			const dbDir = join(fakeDataHome, "devin", "cli");
			await mkdir(dbDir, { recursive: true });
			await writeFile(join(dbDir, "sessions.db"), "");
			expect(await isDevinInstalled()).toBe(true);
		});

		it("returns false when sessions.db does not exist", async () => {
			expect(await isDevinInstalled()).toBe(false);
		});

		it("returns false when the path exists but is a directory, not a file", async () => {
			await mkdir(join(fakeDataHome, "devin", "cli", "sessions.db"), { recursive: true });
			expect(await isDevinInstalled()).toBe(false);
		});

		it("returns false when runtime Node version is below the node:sqlite threshold", async () => {
			const dbDir = join(fakeDataHome, "devin", "cli");
			await mkdir(dbDir, { recursive: true });
			await writeFile(join(dbDir, "sessions.db"), "");
			const originalDescriptor = Object.getOwnPropertyDescriptor(process.versions, "node");
			Object.defineProperty(process.versions, "node", { value: "20.15.0", configurable: true });
			try {
				expect(await isDevinInstalled()).toBe(false);
			} finally {
				/* v8 ignore next -- Object.getOwnPropertyDescriptor on a standard process field always returns a descriptor on supported runtimes */
				if (originalDescriptor) Object.defineProperty(process.versions, "node", originalDescriptor);
			}
		});
	});

	describe("scanDevinSessions / discoverDevinSessions", () => {
		it("discovers the session matching its working_directory", async () => {
			const dbDir = join(fakeDataHome, "devin", "cli");
			const nowSec = Math.floor(Date.now() / 1000);
			const dbPath = await createDevinDb(dbDir, [
				{
					id: "sess-view-branch",
					workingDirectory: projectDir,
					title: "view current branch",
					lastActivityAt: nowSec - 100,
					mainChainId: 5,
					messageNodes: sampleDevinMessageForest(nowSec - 110),
				},
			]);

			const result = await scanDevinSessions(projectDir);

			expect(result.error).toBeUndefined();
			expect(result.sessions).toHaveLength(1);
			expect(result.sessions[0]).toMatchObject({
				sessionId: "sess-view-branch",
				source: "devin",
				title: "view current branch",
				transcriptPath: `${dbPath}#sess-view-branch`,
			});
		});

		it("returns no sessions for an unrelated directory", async () => {
			const dbDir = join(fakeDataHome, "devin", "cli");
			const nowSec = Math.floor(Date.now() / 1000);
			await createDevinDb(dbDir, [{ id: "sess-1", workingDirectory: projectDir, lastActivityAt: nowSec - 100 }]);

			const sessions = await discoverDevinSessions("/somewhere/else");

			expect(sessions).toEqual([]);
		});

		it("filters out stale sessions older than 48 hours", async () => {
			const dbDir = join(fakeDataHome, "devin", "cli");
			const nowSec = Math.floor(Date.now() / 1000);
			const staleSec = nowSec - 49 * 60 * 60;
			await createDevinDb(dbDir, [
				{ id: "fresh", workingDirectory: projectDir, lastActivityAt: nowSec - 100 },
				{ id: "stale", workingDirectory: projectDir, lastActivityAt: staleSec },
			]);

			const sessions = await discoverDevinSessions(projectDir);

			expect(sessions.map((s) => s.sessionId)).toEqual(["fresh"]);
		});

		it("filters out hidden sessions", async () => {
			const dbDir = join(fakeDataHome, "devin", "cli");
			const nowSec = Math.floor(Date.now() / 1000);
			await createDevinDb(dbDir, [
				{ id: "visible", workingDirectory: projectDir, lastActivityAt: nowSec - 100, hidden: 0 },
				{ id: "hidden-one", workingDirectory: projectDir, lastActivityAt: nowSec - 50, hidden: 1 },
			]);

			const sessions = await discoverDevinSessions(projectDir);

			expect(sessions.map((s) => s.sessionId)).toEqual(["visible"]);
		});

		it("converts last_activity_at from unix seconds to ISO 8601", async () => {
			const dbDir = join(fakeDataHome, "devin", "cli");
			const nowSec = Math.floor(Date.now() / 1000);
			await createDevinDb(dbDir, [{ id: "ts-test", workingDirectory: projectDir, lastActivityAt: nowSec }]);

			const sessions = await discoverDevinSessions(projectDir);

			expect(sessions[0].updatedAt).toBe(new Date(nowSec * 1000).toISOString());
		});

		it.each([
			["empty string", ""],
			["whitespace only", "   \t"],
		])("collapses to undefined title when row.title is %s", async (_label, raw) => {
			const dbDir = join(fakeDataHome, "devin", "cli");
			const nowSec = Math.floor(Date.now() / 1000);
			await createDevinDb(dbDir, [
				{ id: "blank-title", workingDirectory: projectDir, title: raw, lastActivityAt: nowSec - 100 },
			]);

			const sessions = await discoverDevinSessions(projectDir);

			expect(sessions[0].title).toBeUndefined();
		});

		it.each(["darwin", "win32"] as const)("matches working_directory case-insensitively on %s", async (osName) => {
			setPlatform(osName);
			const nowSec = Math.floor(Date.now() / 1000);
			const storedDir = "/Tmp/Proj";
			// Use scanDevinSessionsAt with an explicit DB path: this test exercises
			// case-insensitive *directory matching*, not per-OS DB path resolution
			// (that has its own getDevinSessionsDbPath tests, and win32 now resolves
			// the DB under %APPDATA%, not the XDG fixture home).
			const dbPath = await createDevinDb(tempDir, [
				{ id: "case-test", workingDirectory: storedDir, lastActivityAt: nowSec },
			]);

			const result = await scanDevinSessionsAt(dbPath, "/tmp/proj");

			expect(result.sessions.map((s) => s.sessionId)).toEqual(["case-test"]);
		});

		it("matches working_directory exactly (case-sensitive) on linux", async () => {
			setPlatform("linux");
			const dbDir = join(fakeDataHome, "devin", "cli");
			const nowSec = Math.floor(Date.now() / 1000);
			const storedDir = "/home/flyer/Project";
			await createDevinDb(dbDir, [{ id: "exact-1", workingDirectory: storedDir, lastActivityAt: nowSec }]);

			expect(await discoverDevinSessions("/home/flyer/project")).toHaveLength(0);
			const sessions = await discoverDevinSessions(storedDir);
			expect(sessions.map((s) => s.sessionId)).toEqual(["exact-1"]);
		});

		it("matches despite a trailing-slash mismatch in working_directory", async () => {
			setPlatform("linux");
			const dbDir = join(fakeDataHome, "devin", "cli");
			const nowSec = Math.floor(Date.now() / 1000);
			// Devin persisted the path with a trailing slash; the caller passes none.
			await createDevinDb(dbDir, [
				{ id: "slash", workingDirectory: "/home/flyer/proj/", lastActivityAt: nowSec },
			]);
			expect((await discoverDevinSessions("/home/flyer/proj")).map((s) => s.sessionId)).toEqual(["slash"]);
		});

		it("matches a `\\`-separated stored path against a `/`-separated request on win32", async () => {
			setPlatform("win32");
			const nowSec = Math.floor(Date.now() / 1000);
			const dbPath = await createDevinDb(tempDir, [
				{ id: "win", workingDirectory: "C:\\Users\\Dev\\proj", lastActivityAt: nowSec },
			]);

			const result = await scanDevinSessionsAt(dbPath, "C:/Users/Dev/proj");

			expect(result.sessions.map((s) => s.sessionId)).toEqual(["win"]);
		});

		it("discovers a session matched only via workspace_dirs (attached worktree)", async () => {
			const dbDir = join(fakeDataHome, "devin", "cli");
			const nowSec = Math.floor(Date.now() / 1000);
			// working_directory is an unrelated dir; the current project is only
			// reachable through the additional workspace_dirs list.
			await createDevinDb(dbDir, [
				{
					id: "attached",
					workingDirectory: "/tmp/other",
					workspaceDirs: JSON.stringify(["/tmp/first", projectDir]),
					lastActivityAt: nowSec - 100,
				},
			]);

			const sessions = await discoverDevinSessions(projectDir);

			expect(sessions.map((s) => s.sessionId)).toEqual(["attached"]);
		});

		it("normalizes workspace_dirs entries (trailing slash / separator) before matching", async () => {
			setPlatform("win32");
			const nowSec = Math.floor(Date.now() / 1000);
			const dbPath = await createDevinDb(tempDir, [
				{
					id: "ws-normalized",
					workingDirectory: "C:\\Users\\Dev\\other",
					workspaceDirs: JSON.stringify(["C:\\Users\\Dev\\proj\\"]),
					lastActivityAt: nowSec,
				},
			]);

			const result = await scanDevinSessionsAt(dbPath, "C:/Users/Dev/proj");

			expect(result.sessions.map((s) => s.sessionId)).toEqual(["ws-normalized"]);
		});

		it("still returns no session when neither working_directory nor workspace_dirs match", async () => {
			const dbDir = join(fakeDataHome, "devin", "cli");
			const nowSec = Math.floor(Date.now() / 1000);
			await createDevinDb(dbDir, [
				{
					id: "unrelated",
					workingDirectory: "/tmp/other",
					workspaceDirs: JSON.stringify(["/tmp/elsewhere"]),
					lastActivityAt: nowSec - 100,
				},
			]);

			expect(await discoverDevinSessions(projectDir)).toEqual([]);
		});

		// JOLLI-2015: a session started from a *subdirectory* of the project —
		// common in a monorepo (`cd packages/foo && devin …`) — IS attributed to
		// the repo. Matching is prefix/containment (see sessionMatchesDir docstring
		// → sessionDirBelongsToRepo), so the child path resolves to the repo root.
		// This replaced the previous exact-equality contract that silently dropped
		// every subdirectory session.
		it("matches a session started in a subdirectory of the project (prefix match)", async () => {
			const dbDir = join(fakeDataHome, "devin", "cli");
			const nowSec = Math.floor(Date.now() / 1000);
			await createDevinDb(dbDir, [
				{
					id: "in-subdir",
					workingDirectory: join(projectDir, "packages", "foo"),
					lastActivityAt: nowSec - 100,
				},
			]);

			const sessions = await discoverDevinSessions(projectDir);
			expect(sessions.map((s) => s.sessionId)).toEqual(["in-subdir"]);
		});

		// The prefix match must not swallow a session that lives in a NESTED git
		// repo / submodule inside the worktree — that session belongs to the inner
		// repo's own post-commit. An intervening `.git` between the session dir and
		// the repo root excludes it (see sessionDirBelongsToRepo). Uses a real temp
		// dir so `.git` can exist on disk.
		it("does NOT match a session inside a nested git repo under the project", async () => {
			const dbDir = join(fakeDataHome, "devin", "cli");
			const nowSec = Math.floor(Date.now() / 1000);
			const realRepo = await mkdtemp(join(tmpdir(), "devin-nested-"));
			try {
				const nested = join(realRepo, "vendor", "lib");
				await mkdir(join(nested, ".git"), { recursive: true });
				await createDevinDb(dbDir, [{ id: "nested", workingDirectory: nested, lastActivityAt: nowSec - 100 }]);

				expect(await discoverDevinSessions(realRepo)).toEqual([]);
			} finally {
				await rm(realRepo, { recursive: true, force: true });
			}
		});

		it.each([
			["malformed JSON", "{not valid json"],
			["a non-array payload", '"just a string"'],
			["non-string entries", "[42, null, {}]"],
		])("tolerates %s in workspace_dirs and falls back to working_directory", async (_label, raw) => {
			const dbDir = join(fakeDataHome, "devin", "cli");
			const nowSec = Math.floor(Date.now() / 1000);
			await createDevinDb(dbDir, [
				{ id: "wd-match", workingDirectory: projectDir, workspaceDirs: raw, lastActivityAt: nowSec - 100 },
			]);

			// A bad workspace_dirs value must not throw / sink the scan; the row
			// still matches on its working_directory.
			expect((await discoverDevinSessions(projectDir)).map((s) => s.sessionId)).toEqual(["wd-match"]);
		});

		it("returns a silent empty result (no error) when the runtime lacks node:sqlite", async () => {
			const dbDir = join(fakeDataHome, "devin", "cli");
			const nowSec = Math.floor(Date.now() / 1000);
			await createDevinDb(dbDir, [{ id: "unsupported", workingDirectory: projectDir, lastActivityAt: nowSec }]);

			const originalDescriptor = Object.getOwnPropertyDescriptor(process.versions, "node");
			Object.defineProperty(process.versions, "node", { value: "20.15.0", configurable: true });
			try {
				const result = await scanDevinSessions(projectDir);
				expect(result.sessions).toEqual([]);
				expect(result.error).toBeUndefined();
			} finally {
				/* v8 ignore next -- descriptor always present on supported runtimes */
				if (originalDescriptor) Object.defineProperty(process.versions, "node", originalDescriptor);
			}
		});

		it("returns empty array when DB does not exist", async () => {
			const sessions = await discoverDevinSessions(projectDir);
			expect(sessions).toEqual([]);
		});

		it("skips a row whose last_activity_at is non-finite (schema drift)", async () => {
			const dbDir = join(fakeDataHome, "devin", "cli");
			const nowSec = Math.floor(Date.now() / 1000);
			const dbPath = await createDevinDb(dbDir, [
				{ id: "good", workingDirectory: projectDir, lastActivityAt: nowSec },
			]);
			// SQLite's INTEGER column affinity does not coerce non-numeric TEXT —
			// the value stays TEXT at rest, simulating schema drift or corrupted data.
			const db = new DatabaseSync(dbPath);
			db.prepare(
				`INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, hidden)
				 VALUES ('bad-session', :dir, 'anthropic', 'claude', 'plan', 0, 'not-a-number', 0)`,
			).run({ dir: projectDir });
			db.close();

			const sessions = await discoverDevinSessions(projectDir);

			expect(sessions.map((s) => s.sessionId)).toEqual(["good"]);
		});
	});

	describe("scanDevinSessions error classification", () => {
		it("returns no error when DB is missing (ENOENT treated as 'not installed')", async () => {
			const result = await scanDevinSessions(projectDir);
			expect(result.sessions).toEqual([]);
			expect(result.error).toBeUndefined();
		});

		it("classifies a garbage DB file as corrupt and surfaces the error", async () => {
			const dbDir = join(fakeDataHome, "devin", "cli");
			await mkdir(dbDir, { recursive: true });
			await writeFile(join(dbDir, "sessions.db"), "this is not an SQLite database");

			const result = await scanDevinSessions(projectDir);

			expect(result.sessions).toEqual([]);
			expect(result.error).toBeDefined();
			expect(result.error?.kind).toBe("corrupt");
		});

		it("classifies missing sessions table as schema drift", async () => {
			const dbDir = join(fakeDataHome, "devin", "cli");
			await mkdir(dbDir, { recursive: true });
			const dbPath = join(dbDir, "sessions.db");
			const db = new DatabaseSync(dbPath);
			db.prepare("CREATE TABLE unrelated (id TEXT)").run();
			db.close();

			const result = await scanDevinSessions(projectDir);

			expect(result.sessions).toEqual([]);
			expect(result.error?.kind).toBe("schema");
		});

		it("discoverDevinSessions (compat wrapper) still returns only sessions on real failures", async () => {
			const dbDir = join(fakeDataHome, "devin", "cli");
			await mkdir(dbDir, { recursive: true });
			await writeFile(join(dbDir, "sessions.db"), "garbage");

			const sessions = await discoverDevinSessions(projectDir);
			expect(sessions).toEqual([]);
		});
	});
});

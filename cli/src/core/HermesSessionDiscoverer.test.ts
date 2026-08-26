import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

// The directory match runs through `normalizePathForCompare`, which reads
// `process.platform` directly. Override it per-test so the case-sensitivity
// branch is deterministic regardless of host OS, and restore in afterEach.
const savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");
function setPlatform(os: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: os, configurable: true });
}

// Partial mock: everything in SqliteHelpers stays real, but `hasNodeSqliteSupport`
// becomes overridable so the Node-<22.13 arms can be exercised on this (22.13+)
// test runtime. Mirrors `AntigravityDetector.test.ts`.
vi.mock("./SqliteHelpers.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./SqliteHelpers.js")>();
	return { ...actual, hasNodeSqliteSupport: vi.fn(actual.hasNodeSqliteSupport) };
});

import { createHermesDb } from "../testUtils/hermesDbFixture.js";
import {
	discoverHermesSessions,
	getHermesHomeDir,
	getHermesStateDbPath,
	hermesSessionsForRepo,
	isHermesInstalled,
	isHermesPresent,
	listHermesStateDbPaths,
	scanHermesSessionsAt,
	scanHermesSessionsOnDisk,
	scanHermesSessionsOnDiskAt,
} from "./HermesSessionDiscoverer.js";
import { hasNodeSqliteSupport } from "./SqliteHelpers.js";

/** Epoch SECONDS, the unit every Hermes timestamp column uses. */
function secondsAgo(ms: number): number {
	return (Date.now() - ms) / 1000;
}

const HOUR_MS = 60 * 60 * 1000;

describe("HermesSessionDiscoverer", () => {
	let tempDir: string;
	let fakeHome: string;
	const projectDir = "/tmp/proj";
	const savedHermesHome = process.env.HERMES_HOME;
	const savedLocalAppData = process.env.LOCALAPPDATA;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "hermes-test-"));
		fakeHome = await mkdtemp(join(tmpdir(), "hermes-home-"));
		process.env.HERMES_HOME = fakeHome;
		setPlatform("darwin");
	});

	afterEach(async () => {
		if (savedHermesHome === undefined) delete process.env.HERMES_HOME;
		else process.env.HERMES_HOME = savedHermesHome;
		if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = savedLocalAppData;
		/* v8 ignore next -- the platform descriptor is always present on supported runtimes */
		if (savedPlatform) Object.defineProperty(process, "platform", savedPlatform);
		await rm(tempDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	describe("getHermesHomeDir", () => {
		it("prefers HERMES_HOME over every platform default", () => {
			process.env.HERMES_HOME = "/custom/hermes";
			expect(getHermesHomeDir("/home/u")).toBe("/custom/hermes");
			setPlatform("win32");
			expect(getHermesHomeDir("/home/u")).toBe("/custom/hermes");
		});

		it("ignores a blank HERMES_HOME", () => {
			process.env.HERMES_HOME = "   ";
			expect(getHermesHomeDir("/home/u")).toBe(join("/home/u", ".hermes"));
		});

		it("falls back to ~/.hermes on POSIX", () => {
			delete process.env.HERMES_HOME;
			expect(getHermesHomeDir("/home/u")).toBe(join("/home/u", ".hermes"));
		});

		// win32 Hermes uses %LOCALAPPDATA%\hermes, NOT the POSIX dotfile layout —
		// read out of `hermes_constants._get_platform_default_hermes_home`. Without
		// this branch `isHermesInstalled()` is always false on Windows and the
		// source silently never appears in the status tree.
		it("uses %LOCALAPPDATA% on win32", () => {
			delete process.env.HERMES_HOME;
			setPlatform("win32");
			process.env.LOCALAPPDATA = "C:\\Users\\u\\AppData\\Local";
			expect(getHermesHomeDir("/home/u")).toBe(join("C:\\Users\\u\\AppData\\Local", "hermes"));
		});

		it("falls back to <home>/AppData/Local on win32 without LOCALAPPDATA", () => {
			delete process.env.HERMES_HOME;
			delete process.env.LOCALAPPDATA;
			setPlatform("win32");
			expect(getHermesHomeDir("/home/u")).toBe(join("/home/u", "AppData", "Local", "hermes"));
		});

		it("falls back to the OS home directory when no home is given", () => {
			delete process.env.HERMES_HOME;
			expect(getHermesStateDbPath()).toBe(join(homedir(), ".hermes", "state.db"));
		});
	});

	describe("listHermesStateDbPaths", () => {
		it("returns the default database even when it does not exist", async () => {
			// Absence is the caller's stat pre-flight to decide, not this function's:
			// short-circuiting here would collapse "not installed" into "unreadable".
			expect(await listHermesStateDbPaths()).toEqual([join(fakeHome, "state.db")]);
		});

		it("includes each named profile that has a database, default first", async () => {
			await createHermesDb(fakeHome, []);
			await createHermesDb(join(fakeHome, "profiles", "work"), []);
			await createHermesDb(join(fakeHome, "profiles", "personal"), []);
			const paths = await listHermesStateDbPaths();
			expect(paths[0]).toBe(join(fakeHome, "state.db"));
			expect(paths.slice(1).sort()).toEqual(
				[
					join(fakeHome, "profiles", "personal", "state.db"),
					join(fakeHome, "profiles", "work", "state.db"),
				].sort(),
			);
		});

		it("skips a profile directory with no database and a non-directory entry", async () => {
			await mkdir(join(fakeHome, "profiles", "empty"), { recursive: true });
			await writeFile(join(fakeHome, "profiles", "stray.txt"), "x");
			expect(await listHermesStateDbPaths()).toEqual([join(fakeHome, "state.db")]);
		});

		it("yields only the default when profiles/ is unreadable", async () => {
			// A permission error one level down must not lose the default profile.
			expect(await listHermesStateDbPaths(join(tempDir, "nope"))).toHaveLength(1);
		});
	});

	describe("detection", () => {
		it("isHermesInstalled is false with no database anywhere", async () => {
			expect(await isHermesInstalled()).toBe(false);
		});

		it("isHermesInstalled is true for the default database", async () => {
			await createHermesDb(fakeHome, []);
			expect(await isHermesInstalled()).toBe(true);
		});

		it("isHermesInstalled is true for a profile-only install", async () => {
			// The whole reason profiles are enumerated: this user's default state.db
			// does not exist, and reporting "not installed" would render as the
			// positive claim that they have never used Hermes.
			await createHermesDb(join(fakeHome, "profiles", "work"), []);
			expect(await isHermesInstalled()).toBe(true);
		});

		it("isHermesPresent accepts the home directory alone", async () => {
			// The natural ordering — install Hermes, `jolli enable`, then start
			// chatting — has a home directory and no conversations yet.
			expect(await isHermesPresent()).toBe(true);
		});

		it("isHermesPresent is true once a database exists", async () => {
			await createHermesDb(fakeHome, []);
			expect(await isHermesPresent()).toBe(true);
		});

		it("isHermesPresent is false when nothing is on disk", async () => {
			process.env.HERMES_HOME = join(tempDir, "absent");
			expect(await isHermesPresent()).toBe(false);
		});

		it("isHermesInstalled is false below the Node floor even with a database present", async () => {
			// "detected but 0 sessions" would be a lie on a runtime that cannot open
			// the store at all — the status tree must say "not installed" instead.
			await createHermesDb(fakeHome, []);
			vi.mocked(hasNodeSqliteSupport).mockReturnValueOnce(false);
			expect(await isHermesInstalled()).toBe(false);
		});

		it("scans nothing — and reports no failure — below the Node floor", async () => {
			// "not supported" is not a scan failure: an error here would light up the
			// partial-data indicator on a runtime that simply cannot read SQLite.
			const dbPath = await createHermesDb(tempDir, [
				{ id: "s1", startedAt: secondsAgo(HOUR_MS), cwd: projectDir },
			]);
			vi.mocked(hasNodeSqliteSupport).mockReturnValueOnce(false);
			expect(await scanHermesSessionsOnDiskAt([dbPath])).toEqual({ sessions: [] });
		});
	});

	describe("scanHermesSessionsOnDiskAt", () => {
		it("returns an in-window session with both recorded directories", async () => {
			const dbPath = await createHermesDb(tempDir, [
				{
					id: "20260826_110913_b7d8a8",
					startedAt: secondsAgo(2 * HOUR_MS),
					lastActivityAt: secondsAgo(HOUR_MS),
					gitRepoRoot: projectDir,
					cwd: `${projectDir}/packages/foo`,
					title: "Wire up the hook",
				},
			]);
			const { sessions, error } = await scanHermesSessionsOnDiskAt([dbPath]);
			expect(error).toBeUndefined();
			expect(sessions).toHaveLength(1);
			expect(sessions[0].session).toMatchObject({
				sessionId: "20260826_110913_b7d8a8",
				transcriptPath: `${dbPath}#20260826_110913_b7d8a8`,
				source: "hermes",
				title: "Wire up the hook",
			});
			// git_repo_root first, then cwd — both carried, which is what makes the
			// disjunction Hermes itself uses fall out of "any directory matches".
			expect(sessions[0].dirs).toEqual([projectDir, `${projectDir}/packages/foo`]);
		});

		it("drops sessions outside the window and honours a widened one", async () => {
			const dbPath = await createHermesDb(tempDir, [
				{ id: "fresh", startedAt: secondsAgo(HOUR_MS), cwd: projectDir },
				{ id: "old", startedAt: secondsAgo(72 * HOUR_MS), cwd: projectDir },
			]);
			const dflt = await scanHermesSessionsOnDiskAt([dbPath]);
			expect(dflt.sessions.map((s) => s.session.sessionId)).toEqual(["fresh"]);
			const wide = await scanHermesSessionsOnDiskAt([dbPath], 7 * 24 * HOUR_MS);
			expect(wide.sessions.map((s) => s.session.sessionId).sort()).toEqual(["fresh", "old"]);
		});

		it("uses started_at when last_activity_at is null", async () => {
			// The COALESCE: a comparison against NULL is neither true nor false, so
			// without it a session that has produced no turn yet vanishes.
			const dbPath = await createHermesDb(tempDir, [
				{ id: "s1", startedAt: secondsAgo(HOUR_MS), lastActivityAt: null, cwd: projectDir },
			]);
			const { sessions } = await scanHermesSessionsOnDiskAt([dbPath]);
			expect(sessions).toHaveLength(1);
		});

		it("excludes hidden sessions but keeps archived ones", async () => {
			// Archiving is a filing action; the conversation still happened.
			const dbPath = await createHermesDb(tempDir, [
				{ id: "hidden", startedAt: secondsAgo(HOUR_MS), cwd: projectDir, hidden: 1 },
				{ id: "archived", startedAt: secondsAgo(HOUR_MS), cwd: projectDir, archived: 1 },
			]);
			const { sessions } = await scanHermesSessionsOnDiskAt([dbPath]);
			expect(sessions.map((s) => s.session.sessionId)).toEqual(["archived"]);
		});

		it("carries no directories for a session recorded outside any project", async () => {
			// Empty dirs match nothing, which is correct: such a session cannot be
			// attributed, and "no directories therefore no objection" would attach it
			// to every repo on the machine.
			const dbPath = await createHermesDb(tempDir, [
				{ id: "s1", startedAt: secondsAgo(HOUR_MS), cwd: null, gitRepoRoot: "   " },
			]);
			const { sessions } = await scanHermesSessionsOnDiskAt([dbPath]);
			expect(sessions[0].dirs).toEqual([]);
			expect(hermesSessionsForRepo(sessions, projectDir)).toEqual([]);
		});

		it("de-duplicates identical git_repo_root and cwd", async () => {
			const dbPath = await createHermesDb(tempDir, [
				{ id: "s1", startedAt: secondsAgo(HOUR_MS), cwd: projectDir, gitRepoRoot: projectDir },
			]);
			const { sessions } = await scanHermesSessionsOnDiskAt([dbPath]);
			expect(sessions[0].dirs).toEqual([projectDir]);
		});

		it("omits a blank title rather than reporting one", async () => {
			const dbPath = await createHermesDb(tempDir, [
				{ id: "s1", startedAt: secondsAgo(HOUR_MS), cwd: projectDir, title: "   " },
			]);
			const { sessions } = await scanHermesSessionsOnDiskAt([dbPath]);
			expect(sessions[0].session.title).toBeUndefined();
		});

		it("skips a row whose activity timestamp is not a number", async () => {
			// Reachable, not defensive: SQLite's REAL *affinity* stores a non-numeric
			// string verbatim, so one drifted row would reach `new Date(NaN)` and its
			// RangeError would take the whole scan down with it.
			const dbPath = await createHermesDb(tempDir, [
				{ id: "ok", startedAt: secondsAgo(HOUR_MS), cwd: projectDir },
			]);
			const db = new DatabaseSync(dbPath);
			db.prepare(
				`INSERT INTO sessions (id, source, started_at, last_activity_at, cwd, archived, hidden)
				 VALUES ('drifted', 'cli', 'not-a-timestamp', 'not-a-timestamp', :cwd, 0, 0)`,
			).run({ cwd: projectDir });
			db.close();
			const { sessions } = await scanHermesSessionsOnDiskAt([dbPath], 10 * 365 * 24 * HOUR_MS);
			expect(sessions.map((s) => s.session.sessionId)).toEqual(["ok"]);
		});

		it("is silent about a missing database", async () => {
			const result = await scanHermesSessionsOnDiskAt([join(tempDir, "gone", "state.db")]);
			expect(result).toEqual({ sessions: [] });
		});

		it("reports a corrupt database as a genuine failure, not as zero sessions", async () => {
			const bogus = join(tempDir, "state.db");
			await writeFile(bogus, "this is not a database");
			const { sessions, error } = await scanHermesSessionsOnDiskAt([bogus]);
			expect(sessions).toEqual([]);
			expect(error?.kind).toBe("corrupt");
		});

		it("keeps the readable profile's sessions when another database is broken", async () => {
			// PARTIAL, not total: a broken profile must not erase the default one.
			const good = await createHermesDb(join(tempDir, "good"), [
				{ id: "s1", startedAt: secondsAgo(HOUR_MS), cwd: projectDir },
			]);
			const bad = join(tempDir, "bad-state.db");
			await writeFile(bad, "nope");
			const { sessions, error } = await scanHermesSessionsOnDiskAt([bad, good]);
			expect(sessions.map((s) => s.session.sessionId)).toEqual(["s1"]);
			expect(error?.kind).toBe("corrupt");
		});

		it("scans the resolved home when called without explicit paths", async () => {
			await createHermesDb(fakeHome, [{ id: "s1", startedAt: secondsAgo(HOUR_MS), cwd: projectDir }]);
			const { sessions } = await scanHermesSessionsOnDisk();
			expect(sessions.map((s) => s.session.sessionId)).toEqual(["s1"]);
		});
	});

	describe("repo attribution", () => {
		it("claims a session started in a subdirectory of the repo", async () => {
			const dbPath = await createHermesDb(tempDir, [
				{ id: "sub", startedAt: secondsAgo(HOUR_MS), cwd: `${projectDir}/packages/foo` },
				{ id: "elsewhere", startedAt: secondsAgo(HOUR_MS), cwd: "/tmp/other" },
			]);
			const { sessions } = await scanHermesSessionsAt([dbPath], projectDir);
			expect(sessions.map((s) => s.sessionId)).toEqual(["sub"]);
		});

		it("claims a session by git_repo_root when its cwd is elsewhere", async () => {
			// `--in DIR` / `--no-restore-cwd` can resume a session outside the tree the
			// repo root was derived from; carrying both columns is what keeps it.
			const dbPath = await createHermesDb(tempDir, [
				{ id: "resumed", startedAt: secondsAgo(HOUR_MS), gitRepoRoot: projectDir, cwd: "/tmp/other" },
			]);
			const { sessions } = await scanHermesSessionsAt([dbPath], projectDir);
			expect(sessions.map((s) => s.sessionId)).toEqual(["resumed"]);
		});

		it("forwards a scan error alongside the narrowed sessions", async () => {
			const bad = join(tempDir, "state.db");
			await writeFile(bad, "nope");
			const { sessions, error } = await scanHermesSessionsAt([bad], projectDir);
			expect(sessions).toEqual([]);
			expect(error?.kind).toBe("corrupt");
		});
	});

	describe("discoverHermesSessions", () => {
		it("returns only the session array for the resolved home", async () => {
			await createHermesDb(fakeHome, [
				{ id: "mine", startedAt: secondsAgo(HOUR_MS), cwd: projectDir },
				{ id: "theirs", startedAt: secondsAgo(HOUR_MS), cwd: "/tmp/other" },
			]);
			expect((await discoverHermesSessions(projectDir)).map((s) => s.sessionId)).toEqual(["mine"]);
		});

		it("finds a conversation held in a named profile", async () => {
			await createHermesDb(join(fakeHome, "profiles", "work"), [
				{ id: "in-profile", startedAt: secondsAgo(HOUR_MS), cwd: projectDir },
			]);
			const sessions = await discoverHermesSessions(projectDir);
			expect(sessions.map((s) => s.sessionId)).toEqual(["in-profile"]);
			expect(sessions[0].transcriptPath).toContain(join("profiles", "work"));
		});
	});
});

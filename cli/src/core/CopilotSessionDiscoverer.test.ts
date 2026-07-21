import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CopilotSessionDiscoverer.normalizeCwd() runs path.resolve() on the projectDir
// before the SQL match. Tests must seed `cwd` with the same resolve() output so
// the value at row-time and query-time agree on every platform — a literal
// "/p" string seeded on Windows would never match resolve("/p") = "<drive>:\\p".
const platformPath = (p: string): string => resolve(p);

// scanCopilotSessions filters rows older than 48 hours. Seed timestamps relative
// to Date.now() so fixtures stay fresh forever (a hardcoded ISO string would
// silently cross the 48h cutoff once the test suite is more than 2 days old).
const isoFromNow = (msAgo = 1_000): string => new Date(Date.now() - msAgo).toISOString();

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, stat: vi.fn(actual.stat) };
});

const SCHEMA_STATEMENTS = [
	`CREATE TABLE sessions (
		id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT,
		branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT
	)`,
	`CREATE TABLE turns (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id TEXT NOT NULL,
		turn_index INTEGER NOT NULL,
		user_message TEXT, assistant_response TEXT, timestamp TEXT
	)`,
];

interface SeedSession {
	id: string;
	// `null` seeds a SQL NULL cwd — Copilot CLI stores this for sessions started
	// outside any project (see the null-cwd regression test below).
	cwd: string | null;
	updated_at: string;
	// Optional override for the sessions.summary column. `undefined` (default)
	// inserts SQL NULL — matches the historical fixture shape so existing tests
	// stay unchanged. Explicit `null` also maps to NULL; any string is passed
	// through verbatim, including the empty string.
	summary?: string | null;
}

async function makeFixtureDb(sessions: SeedSession[]): Promise<{ dbPath: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "copilot-disc-"));
	const dbPath = join(dir, "session-store.db");
	const db = new DatabaseSync(dbPath);
	for (const stmt of SCHEMA_STATEMENTS) db.prepare(stmt).run();
	const insertSql =
		"INSERT INTO sessions (id, cwd, repository, host_type, branch, summary, created_at, updated_at) " +
		"VALUES (?, ?, NULL, 'github', NULL, ?, ?, ?)";
	const insert = db.prepare(insertSql);
	for (const s of sessions) insert.run(s.id, s.cwd, s.summary ?? null, s.updated_at, s.updated_at);
	db.close();
	return { dbPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("scanCopilotSessions", () => {
	let cleanups: Array<() => Promise<void>>;

	beforeEach(async () => {
		cleanups = [];
		// vi.restoreAllMocks() does not unwind mockRejectedValue/mockResolvedValue
		// applied to a vi.fn() created inside a module mock factory, so any test
		// that mocks `stat` would leak its rejection into later tests. Reset to
		// the real implementation explicitly.
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		vi.mocked(stat).mockReset().mockImplementation(actual.stat);
	});
	afterEach(async () => {
		for (const c of cleanups) await c();
		vi.restoreAllMocks();
	});

	async function withFixture(seeds: SeedSession[]) {
		const fx = await makeFixtureDb(seeds);
		cleanups.push(fx.cleanup);
		const detector = await import("./CopilotDetector.js");
		vi.spyOn(detector, "getCopilotDbPath").mockReturnValue(fx.dbPath);
		return fx;
	}

	it("returns sessions whose cwd matches the project directory", async () => {
		await withFixture([
			{ id: "a", cwd: platformPath("/Users/x/project"), updated_at: isoFromNow(1_000) },
			{ id: "b", cwd: platformPath("/other"), updated_at: isoFromNow() },
		]);
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions } = await scanCopilotSessions(platformPath("/Users/x/project"));
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({ sessionId: "a", source: "copilot" });
		expect(sessions[0].transcriptPath).toMatch(/session-store\.db#a$/);
	});

	// JOLLI-2015: a session run from a subdirectory of the project (common in a
	// monorepo, `cd packages/foo && copilot`) IS attributed to the repo via
	// prefix/containment matching — semantics shared with Devin/OpenCode.
	it("returns a session run in a subdirectory of the project (prefix match)", async () => {
		await withFixture([
			{ id: "sub", cwd: platformPath("/Users/x/project/packages/foo"), updated_at: isoFromNow() },
		]);
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions } = await scanCopilotSessions(platformPath("/Users/x/project"));
		expect(sessions.map((s) => s.sessionId)).toEqual(["sub"]);
	});

	// A session living in a NESTED git repo / submodule inside the worktree belongs
	// to the inner repo's own post-commit, not this one — an intervening `.git`
	// excludes it. Uses a real temp dir so `.git` can exist on disk.
	it("does NOT return a session inside a nested git repo under the project", async () => {
		const { mkdir } = await import("node:fs/promises");
		const realRepo = await mkdtemp(join(tmpdir(), "copilot-nested-"));
		cleanups.push(() => rm(realRepo, { recursive: true, force: true }));
		const nested = join(realRepo, "vendor", "lib");
		await mkdir(join(nested, ".git"), { recursive: true });
		await withFixture([{ id: "nested", cwd: resolve(nested), updated_at: isoFromNow() }]);
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions } = await scanCopilotSessions(resolve(realRepo));
		expect(sessions).toEqual([]);
	});

	it("returns every matching session (order is not part of the contract)", async () => {
		// The query has no ORDER BY — all rows passing the directory + staleness filters
		// are kept regardless of order — so assert on set membership, not order.
		await withFixture([
			{ id: "older", cwd: platformPath("/p"), updated_at: isoFromNow(2_000) },
			{ id: "newer", cwd: platformPath("/p"), updated_at: isoFromNow(1_000) },
		]);
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions } = await scanCopilotSessions(platformPath("/p"));
		expect(sessions.map((s) => s.sessionId).sort()).toEqual(["newer", "older"]);
	});

	it("normalizes trailing slashes on the projectDir", async () => {
		await withFixture([{ id: "a", cwd: platformPath("/Users/x/project"), updated_at: isoFromNow() }]);
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		// Forward slash is tolerated by both posix and win32 path.resolve, so
		// `${platformPath(...)}/` is a valid trailing-slash variant on every OS.
		const { sessions } = await scanCopilotSessions(`${platformPath("/Users/x/project")}/`);
		expect(sessions).toHaveLength(1);
	});

	it("matches case-insensitively on darwin/win32", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		await withFixture([{ id: "a", cwd: platformPath("/Users/X/Project"), updated_at: isoFromNow() }]);
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions } = await scanCopilotSessions(platformPath("/users/x/project"));
		expect(sessions).toHaveLength(1);
	});

	it("does NOT match case-insensitively on linux", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		await withFixture([{ id: "a", cwd: platformPath("/Users/X/Project"), updated_at: isoFromNow() }]);
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions } = await scanCopilotSessions(platformPath("/users/x/project"));
		expect(sessions).toHaveLength(0);
	});

	it("returns empty when nothing matches", async () => {
		await withFixture([{ id: "a", cwd: platformPath("/elsewhere"), updated_at: isoFromNow() }]);
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions } = await scanCopilotSessions(platformPath("/Users/x/project"));
		expect(sessions).toEqual([]);
	});

	it("filters out sessions older than the 48h staleness window", async () => {
		const FORTY_NINE_HOURS_MS = 49 * 60 * 60 * 1000;
		await withFixture([
			{ id: "fresh", cwd: platformPath("/p"), updated_at: isoFromNow(1_000) },
			{ id: "stale", cwd: platformPath("/p"), updated_at: isoFromNow(FORTY_NINE_HOURS_MS) },
		]);
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions } = await scanCopilotSessions(platformPath("/p"));
		expect(sessions.map((s) => s.sessionId)).toEqual(["fresh"]);
	});

	it("returns empty silently when the DB file is missing", async () => {
		const detector = await import("./CopilotDetector.js");
		vi.spyOn(detector, "getCopilotDbPath").mockReturnValue(join(tmpdir(), "copilot-disc-missing", "x.db"));
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions, error } = await scanCopilotSessions(platformPath("/Users/x/project"));
		expect(sessions).toEqual([]);
		expect(error).toBeUndefined();
	});

	it("classifies a corrupt DB as a scan error", async () => {
		const dir = await mkdtemp(join(tmpdir(), "copilot-disc-"));
		const dbPath = join(dir, "session-store.db");
		await writeFile(dbPath, "not a sqlite file");
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const detector = await import("./CopilotDetector.js");
		vi.spyOn(detector, "getCopilotDbPath").mockReturnValue(dbPath);
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions, error } = await scanCopilotSessions(platformPath("/Users/x/project"));
		expect(sessions).toEqual([]);
		expect(error?.kind).toBe("corrupt");
	});

	// Regression: Copilot CLI stores cwd = NULL for a session started outside any
	// project. The scan maps `sessionDirBelongsToRepo` over every row in one
	// flatMap, so a null-cwd row must be skipped rather than throwing — otherwise
	// that single poison row aborts the whole scan and drops every session (the
	// "Copilot capture stopped working" bug: one null row → source flagged
	// unavailable, zero sessions summarized).
	it("skips a null-cwd row without poisoning the rest of the scan", async () => {
		await withFixture([
			{ id: "null-cwd", cwd: null, updated_at: isoFromNow(1_000) },
			{ id: "good", cwd: platformPath("/p"), updated_at: isoFromNow(2_000) },
		]);
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions, error } = await scanCopilotSessions(platformPath("/p"));
		expect(error).toBeUndefined();
		expect(sessions.map((s) => s.sessionId)).toEqual(["good"]);
	});

	it("skips a row whose updated_at is non-finite", async () => {
		await withFixture([
			{ id: "good", cwd: platformPath("/p"), updated_at: isoFromNow() },
			{ id: "bad", cwd: platformPath("/p"), updated_at: "not-a-date" },
		]);
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions } = await scanCopilotSessions(platformPath("/p"));
		expect(sessions.map((s) => s.sessionId)).toEqual(["good"]);
	});

	it("returns a scan error when the Copilot DB stat fails with permission denied", async () => {
		await withFixture([{ id: "a", cwd: platformPath("/Users/x/project"), updated_at: isoFromNow() }]);
		vi.mocked(stat).mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));

		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions, error } = await scanCopilotSessions(platformPath("/Users/x/project"));

		expect(sessions).toEqual([]);
		expect(error?.kind).toBe("permission");
	});

	it("discoverCopilotSessions returns sessions unchanged when the scan succeeds", async () => {
		await withFixture([{ id: "a", cwd: platformPath("/p"), updated_at: isoFromNow() }]);
		const { discoverCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const sessions = await discoverCopilotSessions(platformPath("/p"));
		expect(sessions.map((s) => s.sessionId)).toEqual(["a"]);
	});

	it("propagates the sessions.summary column to SessionInfo.title", async () => {
		await withFixture([
			{
				id: "a",
				cwd: platformPath("/p"),
				updated_at: isoFromNow(),
				summary: "怎么测试copilot integration?",
			},
		]);
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions } = await scanCopilotSessions(platformPath("/p"));
		expect(sessions).toHaveLength(1);
		expect(sessions[0].title).toBe("怎么测试copilot integration?");
	});

	it("leaves title undefined when summary is null or empty string", async () => {
		await withFixture([
			{ id: "null-summary", cwd: platformPath("/p"), updated_at: isoFromNow(1_000), summary: null },
			{ id: "empty-summary", cwd: platformPath("/p"), updated_at: isoFromNow(2_000), summary: "" },
		]);
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions } = await scanCopilotSessions(platformPath("/p"));
		expect(sessions).toHaveLength(2);
		for (const s of sessions) expect(s.title).toBeUndefined();
	});

	it("discoverCopilotSessions returns an empty list and logs a warning when the scan fails", async () => {
		const dir = await mkdtemp(join(tmpdir(), "copilot-disc-"));
		const dbPath = join(dir, "session-store.db");
		await writeFile(dbPath, "not a sqlite file");
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const detector = await import("./CopilotDetector.js");
		vi.spyOn(detector, "getCopilotDbPath").mockReturnValue(dbPath);

		const { discoverCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const sessions = await discoverCopilotSessions(platformPath("/p"));

		expect(sessions).toEqual([]);
	});
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Partial, for the two seams that decide what this module is allowed to do:
 * whether `node:sqlite` exists at all, and whether one repo's transaction
 * succeeded. Neither can be provoked with a real database — the first is a
 * property of the runtime, and every table that could reject a delete cascades
 * — and both guard behaviour that is the whole point of the module (never
 * remove a registry entry whose rows are still there).
 */
vi.mock("./DashboardDb.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./DashboardDb.js")>();
	return { ...actual, canUseDashboardDb: vi.fn(() => true), inTransaction: vi.fn(actual.inTransaction) };
});

const realDb = await vi.importActual<typeof import("./DashboardDb.js")>("./DashboardDb.js");

import { canUseDashboardDb, type DashboardDbHandle, inTransaction, withDashboardDb } from "./DashboardDb.js";
import { STATS_EVENT_SCHEMA_VERSION } from "./DashboardModel.js";
import {
	backupRepoRegistry,
	classifyRegistryEntry,
	forgetRepo,
	forgetRepos,
	pruneDisposableRepos,
	repoChildTables,
	surveyRepoRegistry,
	volumeReachable,
} from "./RepoForget.js";
import { getRepoRegistryPath, type RegisteredRepo } from "./RepoRegistry.js";
import { drainPending } from "./StatsWriter.js";

/**
 * Every fixture lives under this ONE temp dir, and it doubles as the temp root
 * the disposable predicate is told about. Naming it explicitly rather than
 * letting the predicate call `os.tmpdir()` is what keeps these cases meaningful
 * on macOS, where the recorded path and `tmpdir()` disagree by a symlink.
 */
let dir: string;
let configDir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-forget-"));
	configDir = join(dir, "config");
	mkdirSync(configDir, { recursive: true });
	dbPath = join(dir, "dashboard.db");
	// `clearMocks` drops the factory's implementations, so both seams are re-armed
	// to their real behaviour before every case.
	vi.mocked(canUseDashboardDb).mockReturnValue(true);
	vi.mocked(inTransaction).mockImplementation(realDb.inTransaction);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const entry = (over: Partial<RegisteredRepo> & { repoIdentity: string }): RegisteredRepo => ({
	repoName: "repo",
	worktreeRoot: join(dir, "gone"),
	enabledAt: "2026-08-01T00:00:00.000Z",
	...over,
});

function writeRegistry(repos: ReadonlyArray<RegisteredRepo>): void {
	writeFileSync(getRepoRegistryPath(configDir), `${JSON.stringify({ version: 1, repos }, null, 2)}\n`, "utf-8");
}

function readRegistryRaw(): { repos: ReadonlyArray<RegisteredRepo>; instanceId?: string } {
	return JSON.parse(readFileSync(getRepoRegistryPath(configDir), "utf-8"));
}

/** Creates the schema and hands the caller a handle to seed rows with. */
async function withDb<T>(fn: (db: DashboardDbHandle) => T): Promise<T> {
	return withDashboardDb(fn, { dbPath });
}

/** One repo row plus one row in every table that references `repos.id`. */
async function seedRepoWithChildren(identity: string): Promise<number> {
	return withDb((db) => {
		db.prepare(
			"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES (?, 'repo', ?, '1970-01-01T00:00:00.000Z')",
		).run(identity, join(dir, "gone"));
		const id = (db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(identity) as { id: number }).id;
		db.prepare("INSERT INTO branches (repo_id, name) VALUES (?, 'main')").run(id);
		// `event_id` is UNIQUE across the table, so it has to carry the identity —
		// two seeded repos otherwise collide on the second insert.
		db.prepare(
			`INSERT INTO commits (event_id, repo_id, hash, branch, message, committed_at_ms)
			 VALUES (?, ?, 'abc1234', 'main', 'a commit', 1)`,
		).run(`commit:${identity}`, id);
		db.prepare("INSERT INTO repo_state (repo_id, key, value) VALUES (?, 'k', 'v')").run(id);
		db.prepare(
			"INSERT INTO ingest_cursors (repo_id, source, cursor, updated_at_ms) VALUES (?, 'sot-import', 'x', 1)",
		).run(id);
		return id;
	});
}

async function countIn(table: string, repoId: number): Promise<number> {
	return withDb(
		(db) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE repo_id = ?`).get(repoId) as { n: number }).n,
	);
}

describe("repoChildTables", () => {
	/**
	 * Pins the derived set. A table added later that references `repos.id` would
	 * otherwise turn into a foreign-key failure at removal time, long after the
	 * schema change that caused it — this makes it a visible test edit instead.
	 */
	it("derives exactly the tables that reference repos.id", async () => {
		const derived = await withDb((db) => repoChildTables(db).map((t) => `${t.table}.${t.column}`));
		expect(derived).toEqual([
			"branches.repo_id",
			"commits.repo_id",
			"context.repo_id",
			"ingest_cursors.repo_id",
			"memories.repo_id",
			"recall_receipts.repo_id",
			"repo_state.repo_id",
			"sessions.repo_id",
			"topic_pages.repo_id",
			"topic_processed_sources.repo_id",
			"transcripts.repo_id",
			"worktree_status.repo_id",
		]);
	});

	it("never names repos itself — the row it guards has to go last", async () => {
		const derived = await withDb((db) => repoChildTables(db).map((t) => t.table));
		expect(derived).not.toContain("repos");
	});

	it("finds a reference that omits the parent column", async () => {
		// `REFERENCES repos` without `(id)` reports `to: null`. Our own schema always
		// names the column, but accepting both is what stops a future table slipping
		// through by using the shorter form — and then failing the final DELETE.
		const found = await withDb((db) => {
			db.exec("CREATE TABLE later_table (repo_id INTEGER REFERENCES repos, note TEXT)");
			return repoChildTables(db).some((t) => t.table === "later_table" && t.column === "repo_id");
		});
		expect(found).toBe(true);
	});
});

describe("forgetRepo", () => {
	it("deletes the repo row and every child row", async () => {
		const id = await seedRepoWithChildren("local:aaa");
		writeRegistry([entry({ repoIdentity: "local:aaa" })]);

		const result = await forgetRepo("local:aaa", { configDir, dbPath });

		expect(result.repoRowDeleted).toBe(true);
		expect(result.childRowsDeleted).toBe(4);
		expect(result.removedFromRegistry).toBe(true);
		expect(result.error).toBeUndefined();
		await expect(withDb((db) => db.prepare("SELECT COUNT(*) AS n FROM repos").get())).resolves.toEqual({ n: 0 });
		expect(await countIn("branches", id)).toBe(0);
		expect(await countIn("commits", id)).toBe(0);
		expect(await countIn("repo_state", id)).toBe(0);
		expect(await countIn("ingest_cursors", id)).toBe(0);
		expect(readRegistryRaw().repos).toEqual([]);
	});

	it("leaves every other repo's rows alone", async () => {
		await seedRepoWithChildren("local:aaa");
		const keptId = await seedRepoWithChildren("local:bbb");

		await forgetRepo("local:aaa", { configDir, dbPath });

		expect(await countIn("branches", keptId)).toBe(1);
		expect(await countIn("commits", keptId)).toBe(1);
	});

	it("reports zeros for an identity nothing on this machine knows", async () => {
		await withDb(() => undefined);
		const result = await forgetRepo("local:never-seen", { configDir, dbPath });
		expect(result).toEqual({
			identity: "local:never-seen",
			removedFromRegistry: false,
			repoRowDeleted: false,
			childRowsDeleted: 0,
			pendingEventsDeleted: 0,
		});
	});

	it("is idempotent — a second call changes nothing and still does not throw", async () => {
		await seedRepoWithChildren("local:aaa");
		writeRegistry([entry({ repoIdentity: "local:aaa" })]);
		await forgetRepo("local:aaa", { configDir, dbPath });

		const again = await forgetRepo("local:aaa", { configDir, dbPath });

		expect(again.repoRowDeleted).toBe(false);
		expect(again.removedFromRegistry).toBe(false);
	});

	/**
	 * The failure the whole module exists to prevent: `ensureRepoRow` inserts a
	 * placeholder from an event's identity alone, so one unprojected row brings the
	 * repo back on the next drain and the removal silently undoes itself.
	 */
	it("deletes unprojected events, so a drain cannot resurrect the repo", async () => {
		await seedRepoWithChildren("local:aaa");
		writeRegistry([entry({ repoIdentity: "local:aaa" })]);
		await withDb((db) => {
			db.prepare(
				`INSERT INTO events_raw (event_id, repo_identity, type, schema_version, received_at, data_json, projection_status)
				 VALUES ('e1', 'local:aaa', 'session.upserted', ?, '2026-08-01T00:00:00.000Z', ?, 'pending')`,
			).run(
				STATS_EVENT_SCHEMA_VERSION,
				JSON.stringify({
					type: "session.upserted",
					repoIdentity: "local:aaa",
					source: "claude",
					sessionId: "s1",
					updatedAtMs: 1,
					messageCount: 1,
					models: [],
				}),
			);
		});

		const result = await forgetRepo("local:aaa", { configDir, dbPath });
		expect(result.pendingEventsDeleted).toBe(1);

		await withDb((db) => drainPending(db));
		await expect(withDb((db) => db.prepare("SELECT COUNT(*) AS n FROM repos").get())).resolves.toEqual({ n: 0 });
	});

	it("keeps already-projected events, which are history rather than pending work", async () => {
		await seedRepoWithChildren("local:aaa");
		await withDb((db) => {
			db.prepare(
				`INSERT INTO events_raw (event_id, repo_identity, type, schema_version, received_at, data_json, projection_status)
				 VALUES ('done', 'local:aaa', 'session.upserted', ?, '2026-08-01T00:00:00.000Z', '{}', 'projected')`,
			).run(STATS_EVENT_SCHEMA_VERSION);
		});

		const result = await forgetRepo("local:aaa", { configDir, dbPath });

		expect(result.pendingEventsDeleted).toBe(0);
		await expect(withDb((db) => db.prepare("SELECT COUNT(*) AS n FROM events_raw").get())).resolves.toEqual({
			n: 1,
		});
	});

	/**
	 * A `failed` row is revivable by the drain (`unknown-type` rows are reset to
	 * pending on a build that understands them), so leaving one behind is the same
	 * resurrection with a delay.
	 */
	it("deletes failed events too, since the drain revives them", async () => {
		writeRegistry([entry({ repoIdentity: "local:aaa" })]);
		await withDb((db) => {
			db.prepare(
				`INSERT INTO events_raw (event_id, repo_identity, type, schema_version, received_at, data_json, projection_status, failed_kind)
				 VALUES ('bad', 'local:aaa', 'session.upserted', ?, '2026-08-01T00:00:00.000Z', '{}', 'failed', 'unknown-type')`,
			).run(STATS_EVENT_SCHEMA_VERSION);
		});

		const result = await forgetRepo("local:aaa", { configDir, dbPath });

		expect(result.pendingEventsDeleted).toBe(1);
	});

	it("removes the registry entry with no database on disk, without creating one", async () => {
		writeRegistry([entry({ repoIdentity: "local:aaa" })]);

		const result = await forgetRepo("local:aaa", { configDir, dbPath });

		expect(result.removedFromRegistry).toBe(true);
		expect(result.repoRowDeleted).toBe(false);
		expect(existsSync(dbPath)).toBe(false);
	});

	it("keeps the registry's instance-id witness across a removal", async () => {
		writeFileSync(
			getRepoRegistryPath(configDir),
			`${JSON.stringify({ version: 1, repos: [entry({ repoIdentity: "local:aaa" })], instanceId: "id-1" })}\n`,
			"utf-8",
		);

		await forgetRepo("local:aaa", { configDir, dbPath });

		expect(readRegistryRaw().instanceId).toBe("id-1");
	});
});

describe("forgetRepos", () => {
	it("de-duplicates the identities it was handed", async () => {
		await seedRepoWithChildren("local:aaa");
		const results = await forgetRepos(["local:aaa", "local:aaa"], { configDir, dbPath });
		expect(results).toHaveLength(1);
	});

	it("answers an empty list without opening anything", async () => {
		await expect(forgetRepos([], { configDir, dbPath })).resolves.toEqual([]);
		expect(existsSync(dbPath)).toBe(false);
	});

	it("falls back to the machine database path when none is given", async () => {
		// HOME is isolated per test file, so this reaches a scratch path rather than
		// the developer's own database — and there is nothing there, which is the
		// "no rows to lose" branch.
		const [result] = await forgetRepos(["local:aaa"], { configDir });
		expect(result.repoRowDeleted).toBe(false);
	});

	it("opens the machine database when one exists at the default path", async () => {
		// Still the isolated HOME. Creating it first is what takes the OTHER side of
		// the "was a dbPath given?" branch, so the default path is really exercised.
		await withDashboardDb((db) => {
			db.prepare(
				`INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at)
				 VALUES ('local:default', 'r', '/gone', '1970-01-01T00:00:00.000Z')`,
			).run();
		});

		const [result] = await forgetRepos(["local:default"], { configDir });

		expect(result.repoRowDeleted).toBe(true);
	});

	/**
	 * The refusal that keeps the two halves consistent. Removing the registry
	 * entries with no way to delete the rows would leave rows the page still
	 * renders and no later sweep can see — the registry no longer lists them.
	 */
	it("throws instead of removing anything when node:sqlite is unavailable", async () => {
		vi.mocked(canUseDashboardDb).mockReturnValue(false);
		writeRegistry([entry({ repoIdentity: "local:aaa" })]);

		await expect(forgetRepos(["local:aaa"], { configDir, dbPath })).rejects.toThrow(/node:sqlite/);
		expect(readRegistryRaw().repos).toHaveLength(1);
	});

	it("confines a failed transaction to its own identity and keeps its registry entry", async () => {
		await seedRepoWithChildren("local:bad");
		await seedRepoWithChildren("local:good");
		writeRegistry([entry({ repoIdentity: "local:bad" }), entry({ repoIdentity: "local:good" })]);
		let seen = 0;
		vi.mocked(inTransaction).mockImplementation((db, fn) => {
			seen += 1;
			// First identity only: a lock lost on one repo must not roll back the
			// others, nor stop the sweep finishing them.
			if (seen === 1) throw new Error("database is locked");
			return realDb.inTransaction(db, fn);
		});

		const [bad, good] = await forgetRepos(["local:bad", "local:good"], { configDir, dbPath });

		expect(bad.error).toBe("database is locked");
		expect(bad.removedFromRegistry).toBe(false);
		expect(good.error).toBeUndefined();
		expect(good.repoRowDeleted).toBe(true);
		// The one that failed keeps BOTH its rows and its entry, so the next attempt
		// can still find it.
		expect(readRegistryRaw().repos.map((r) => r.repoIdentity)).toEqual(["local:bad"]);
		await expect(withDb((db) => db.prepare("SELECT COUNT(*) AS n FROM repos").get())).resolves.toEqual({ n: 1 });
	});
});

describe("volumeReachable", () => {
	it("is true when some ancestor exists", () => {
		expect(volumeReachable(join(dir, "no", "such", "child"))).toBe(true);
	});

	it("is false when the walk runs out of path — an unmounted drive", () => {
		// Injected: on POSIX every absolute path bottoms out at a live `/`, so this
		// branch is unreachable with the real filesystem.
		expect(volumeReachable("Z:\\gone\\repo", () => false)).toBe(false);
	});
});

describe("classifyRegistryEntry", () => {
	const tempRoots = () => [dir];

	it("calls an entry with a live checkout live", () => {
		const root = join(dir, "live");
		mkdirSync(root);
		const repo = entry({ repoIdentity: "local:aaa", worktreeRoot: root, worktrees: [root] });
		expect(classifyRegistryEntry(repo, { tempRoots: tempRoots(), platform: "linux" })).toBe("live");
	});

	it("calls a gone temp checkout with a local: identity disposable", () => {
		const repo = entry({ repoIdentity: "local:aaa", worktreeRoot: join(dir, "gone") });
		expect(classifyRegistryEntry(repo, { tempRoots: tempRoots(), platform: "linux" })).toBe("disposable");
	});

	it("calls a gone checkout on a present volume dead", () => {
		const repo = entry({ repoIdentity: "https://github.com/a/b", worktreeRoot: join(dir, "gone") });
		expect(classifyRegistryEntry(repo, { tempRoots: tempRoots(), platform: "linux" })).toBe("dead");
	});

	it("calls a gone checkout whose volume is missing unavailable", () => {
		const repo = entry({ repoIdentity: "https://github.com/a/b", worktreeRoot: "Z:\\work\\repo" });
		const verdict = classifyRegistryEntry(repo, {
			tempRoots: tempRoots(),
			platform: "win32",
			pathExists: () => false,
		});
		expect(verdict).toBe("unavailable");
	});
});

describe("surveyRepoRegistry", () => {
	it("groups every entry, disabled ones included", async () => {
		const live = join(dir, "live");
		mkdirSync(live);
		writeRegistry([
			entry({ repoIdentity: "local:live", worktreeRoot: live, worktrees: [live] }),
			entry({ repoIdentity: "local:temp", worktreeRoot: join(dir, "gone-1") }),
			// Disabled AND gone: `listActiveRepos` would filter it out, which is why
			// the survey reads the whole registry.
			entry({
				repoIdentity: "https://github.com/a/b",
				worktreeRoot: join(dir, "gone-2"),
				disabledAt: "2026-08-02T00:00:00.000Z",
			}),
		]);

		const survey = await surveyRepoRegistry({ configDir, tempRoots: [dir], platform: "linux" });

		expect(survey.live.map((r) => r.repoIdentity)).toEqual(["local:live"]);
		expect(survey.disposable.map((r) => r.repoIdentity)).toEqual(["local:temp"]);
		expect(survey.dead.map((r) => r.repoIdentity)).toEqual(["https://github.com/a/b"]);
		expect(survey.unavailable).toEqual([]);
	});

	it("answers an empty survey when no registry exists yet", async () => {
		const survey = await surveyRepoRegistry({ configDir });
		expect(survey).toEqual({ live: [], disposable: [], dead: [], unavailable: [] });
	});

	it("finds a database row the registry no longer lists", async () => {
		// The shape that hurts most: the page renders it, and a registry-only survey
		// calls the machine clean. Both stores are written by different paths.
		await seedRepoWithChildren("local:orphan");
		writeRegistry([]);

		const survey = await surveyRepoRegistry({ configDir, dbPath, tempRoots: [dir], platform: "linux" });

		expect(survey.disposable.map((r) => r.repoIdentity)).toEqual(["local:orphan"]);
	});

	it("ignores the placeholder row an event creates before its repo registers", async () => {
		// `ensureRepoRow` stores the identity in `worktree_root`, so there is no
		// directory to judge and nothing to remove yet.
		await withDb((db) => {
			db.prepare(
				`INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at)
				 VALUES ('local:pending', 'local:pending', 'local:pending', '1970-01-01T00:00:00.000Z')`,
			).run();
		});
		writeRegistry([]);

		const survey = await surveyRepoRegistry({ configDir, dbPath, tempRoots: [dir], platform: "linux" });

		expect(survey).toEqual({ live: [], disposable: [], dead: [], unavailable: [] });
	});

	it("does not double-count a repo that is in both stores", async () => {
		await seedRepoWithChildren("local:temp");
		writeRegistry([entry({ repoIdentity: "local:temp", worktreeRoot: join(dir, "gone-1") })]);

		const survey = await surveyRepoRegistry({ configDir, dbPath, tempRoots: [dir], platform: "linux" });

		expect(survey.disposable).toHaveLength(1);
	});

	it("still answers from the registry when the database cannot be read", async () => {
		// A DIRECTORY where the database should be: `existsSync` says yes, the open
		// fails, and the registry half must still be reported.
		mkdirSync(dbPath, { recursive: true });
		writeRegistry([entry({ repoIdentity: "local:temp", worktreeRoot: join(dir, "gone-1") })]);

		const survey = await surveyRepoRegistry({ configDir, dbPath, tempRoots: [dir], platform: "linux" });

		expect(survey.disposable.map((r) => r.repoIdentity)).toEqual(["local:temp"]);
	});

	it("skips the database half on a runtime without node:sqlite", async () => {
		vi.mocked(canUseDashboardDb).mockReturnValue(false);
		await seedRepoWithChildren("local:orphan");
		vi.mocked(canUseDashboardDb).mockReturnValue(false);
		writeRegistry([]);

		const survey = await surveyRepoRegistry({ configDir, dbPath, tempRoots: [dir], platform: "linux" });

		expect(survey).toEqual({ live: [], disposable: [], dead: [], unavailable: [] });
	});
});

describe("pruneDisposableRepos", () => {
	it("removes the temp fixture and nothing else", async () => {
		const live = join(dir, "live");
		mkdirSync(live);
		await seedRepoWithChildren("local:temp");
		const keptId = await seedRepoWithChildren("https://github.com/a/b");
		writeRegistry([
			entry({ repoIdentity: "local:live", worktreeRoot: live, worktrees: [live] }),
			entry({ repoIdentity: "local:temp", worktreeRoot: join(dir, "gone-1") }),
			entry({ repoIdentity: "https://github.com/a/b", worktreeRoot: join(dir, "gone-2") }),
		]);

		const pruned = await pruneDisposableRepos({ configDir, dbPath, tempRoots: [dir], platform: "linux" });

		expect(pruned.map((r) => r.identity)).toEqual(["local:temp"]);
		expect(readRegistryRaw().repos.map((r) => r.repoIdentity)).toEqual(["local:live", "https://github.com/a/b"]);
		// The remote-backed dead entry keeps its rows: only `doctor --fix` may take
		// those, because a folder that is merely unmounted looks identical here.
		expect(await countIn("commits", keptId)).toBe(1);
	});

	it("prunes an entry the database never had a row for", async () => {
		// The registry and the `repos` table are written by different paths, so an
		// entry can exist with nothing projected behind it. The removal still has to
		// take the registry entry, and report the row as absent rather than deleted.
		await seedRepoWithChildren("https://github.com/a/b");
		writeRegistry([entry({ repoIdentity: "local:temp", worktreeRoot: join(dir, "gone-1") })]);

		const pruned = await pruneDisposableRepos({ configDir, dbPath, tempRoots: [dir], platform: "linux" });

		expect(pruned).toHaveLength(1);
		expect(pruned[0].repoRowDeleted).toBe(false);
		expect(pruned[0].removedFromRegistry).toBe(true);
		expect(readRegistryRaw().repos).toEqual([]);
	});

	it("does nothing when every entry is live or merely dead", async () => {
		writeRegistry([entry({ repoIdentity: "https://github.com/a/b", worktreeRoot: join(dir, "gone") })]);
		const pruned = await pruneDisposableRepos({ configDir, dbPath, tempRoots: [dir], platform: "linux" });
		expect(pruned).toEqual([]);
		expect(readRegistryRaw().repos).toHaveLength(1);
	});

	/** A session in progress under `%TEMP%` is a working repo, not garbage. */
	it("spares a temp checkout that still exists", async () => {
		const alive = join(dir, "scratch");
		mkdirSync(alive);
		writeRegistry([entry({ repoIdentity: "local:scratch", worktreeRoot: alive, worktrees: [alive] })]);

		const pruned = await pruneDisposableRepos({ configDir, dbPath, tempRoots: [dir], platform: "linux" });

		expect(pruned).toEqual([]);
		expect(readRegistryRaw().repos).toHaveLength(1);
	});

	it("stands down on a runtime without node:sqlite instead of half-removing", async () => {
		vi.mocked(canUseDashboardDb).mockReturnValue(false);
		writeRegistry([entry({ repoIdentity: "local:temp", worktreeRoot: join(dir, "gone-1") })]);

		expect(await pruneDisposableRepos({ configDir, dbPath, tempRoots: [dir], platform: "linux" })).toEqual([]);
		expect(readRegistryRaw().repos).toHaveLength(1);
	});

	it("reports a failed removal rather than claiming it pruned the entry", async () => {
		await seedRepoWithChildren("local:temp");
		writeRegistry([entry({ repoIdentity: "local:temp", worktreeRoot: join(dir, "gone-1") })]);
		vi.mocked(inTransaction).mockImplementation(() => {
			throw new Error("database is locked");
		});

		const pruned = await pruneDisposableRepos({ configDir, dbPath, tempRoots: [dir], platform: "linux" });

		expect(pruned).toHaveLength(1);
		expect(pruned[0].error).toBe("database is locked");
		expect(readRegistryRaw().repos).toHaveLength(1);
	});

	/** It runs on the dashboard launch path: a machine that cannot prune still gets its page. */
	it("never throws — an unopenable database is a log line", async () => {
		// A DIRECTORY where the database should be: `existsSync` says yes, the open
		// fails, so the throw comes from inside `forgetRepos`.
		mkdirSync(dbPath, { recursive: true });
		writeRegistry([entry({ repoIdentity: "local:temp", worktreeRoot: join(dir, "gone-1") })]);

		expect(await pruneDisposableRepos({ configDir, dbPath, tempRoots: [dir], platform: "linux" })).toEqual([]);
		expect(readRegistryRaw().repos).toHaveLength(1);
	});

	it("spares an entry that mixes a temp path with a real one", async () => {
		writeRegistry([
			entry({
				repoIdentity: "local:mixed",
				worktreeRoot: join(dir, "gone"),
				worktrees: ["/home/dev/real-project", join(dir, "gone")],
			}),
		]);

		const pruned = await pruneDisposableRepos({ configDir, dbPath, tempRoots: [dir], platform: "linux" });

		expect(pruned).toEqual([]);
	});
});

describe("backupRepoRegistry", () => {
	it("copies the registry beside itself with a UTC stamp", () => {
		writeRegistry([entry({ repoIdentity: "local:aaa" })]);

		const saved = backupRepoRegistry(Date.UTC(2026, 7, 17, 3, 4, 5), configDir);

		expect(saved).toBe(`${getRepoRegistryPath(configDir)}.20260817T030405Z.bak`);
		expect(saved && JSON.parse(readFileSync(saved, "utf-8")).repos).toHaveLength(1);
	});

	it("answers null when there is no registry to copy", () => {
		expect(backupRepoRegistry(Date.now(), configDir)).toBeNull();
	});
});

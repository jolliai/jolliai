import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withIsolatedHome } from "../testUtils/isolatedHome.js";
import {
	addColumnIfMissing,
	BUSY_TIMEOUT_BY_ROLE,
	canUseDashboardDb,
	type DashboardDbHandle,
	DashboardRuntimeError,
	DEFAULT_BUSY_TIMEOUT_MS,
	dbHasUnknownMigrations,
	ensureDashboardDbExists,
	getDashboardDbPath,
	inTransaction,
	isSchemaCurrent,
	MIGRATIONS,
	type MigrationLogRow,
	migrateDashboardDb,
	readMigrationLog,
	readMigrationLogState,
	recordMigrationAsApplied,
	verifyMigrationLog,
	withDashboardDb,
	withReadonlyDashboardDb,
	withRepairDashboardDb,
} from "./DashboardDb.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-dashdb-"));
	dbPath = join(dir, "dashboard.db");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Raw handle — deliberately bypasses every gate the module applies on open. */
async function rawDb(path: string): Promise<DashboardDbHandle> {
	const { DatabaseSync } = await import("node:sqlite");
	return new DatabaseSync(path) as unknown as DashboardDbHandle;
}

/**
 * A database as an OLDER build left it: the first `upTo` entries applied, the version
 * stamped, and no migration log — the state a 0.99.11 install is in when it first
 * meets a build that has one. Runs the exported entries rather than copying their SQL,
 * which would drift.
 *
 * It still writes the stamp, and that is now the POINT rather than a leftover: nothing
 * reads the key any more, so a fixture carrying one is what proves the migration pass
 * ignores it and replays every entry regardless.
 */
async function buildLegacyDb(path: string, upTo: number): Promise<void> {
	const raw = await rawDb(path);
	try {
		for (let slot = 0; slot < upTo; slot++) MIGRATIONS[slot].run(raw);
		raw.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(upTo));
	} finally {
		raw.close();
	}
}

/** Column names of a table, for the add-column assertions. */
function columnsOf(db: DashboardDbHandle, table: string): ReadonlyArray<string> {
	const rows = db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as ReadonlyArray<{ name: string }>;
	return rows.map((r) => r.name);
}

/** Names the log records as run, read raw. `undefined` when there is no log. */
async function appliedNames(path: string): Promise<ReadonlySet<string> | undefined> {
	const rows = await readLog(path);
	if (!rows) return undefined;
	const names = new Set<string>();
	for (const row of rows) if (row.outcome === "applied" || row.outcome === "baseline") names.add(row.name);
	return names;
}

/**
 * Records a migration name this build does not carry — the way a NEWER build would
 * leave the log after writing to the same file.
 *
 * This is the replacement for stamping a higher version number: "someone newer has
 * been here" is now a fact about names, which is what the log stores.
 */
async function recordForeignMigration(path: string, name: string): Promise<void> {
	const raw = await rawDb(path);
	try {
		raw.prepare(
			`INSERT INTO schema_migrations (slot, name, outcome, applied_by, applied_at_ms, duration_ms, ddl)
			 VALUES (99, ?, 'applied', 'cli/99.0.0', 0, 0, '')`,
		).run(name);
	} finally {
		raw.close();
	}
}

/** Every entry this build carries is recorded as run — the "fully migrated" check. */
async function expectFullyMigrated(path: string): Promise<void> {
	const names = await appliedNames(path);
	expect(names).toBeDefined();
	for (const m of MIGRATIONS) expect(names?.has(m.name), `${m.name} is not recorded as run`).toBe(true);
}

/** The log, read raw. Returns undefined when the table does not exist. */
async function readLog(path: string): Promise<ReadonlyArray<MigrationLogRow> | undefined> {
	const raw = await rawDb(path);
	try {
		return readMigrationLog(raw);
	} finally {
		raw.close();
	}
}

describe("canUseDashboardDb", () => {
	it("accepts the flag-free floor and above", () => {
		expect(canUseDashboardDb("22.13.0")).toBe(true);
		expect(canUseDashboardDb("23.4.0")).toBe(true);
		expect(canUseDashboardDb("24.10.0")).toBe(true);
	});

	it("rejects runtimes below 22.13 — including the 22.5 flag-gated floor", () => {
		expect(canUseDashboardDb("22.5.0")).toBe(false);
		expect(canUseDashboardDb("22.12.9")).toBe(false);
		expect(canUseDashboardDb("18.19.0")).toBe(false);
	});

	it("uses the running process version by default", () => {
		// The suite itself runs on >= 22.13 (see .nvmrc) — this pins that assumption.
		expect(canUseDashboardDb()).toBe(true);
	});
});

describe("DashboardRuntimeError", () => {
	it("names the floor and the running version", () => {
		const err = new DashboardRuntimeError("18.19.0");
		expect(err.message).toContain("22.13");
		expect(err.message).toContain("18.19.0");
		expect(err.name).toBe("DashboardRuntimeError");
	});
});

describe("getDashboardDbPath", () => {
	it("lives in the machine-global config dir", () => {
		expect(getDashboardDbPath()).toContain(join(".jolli", "jollimemory", "jollimemory.db"));
	});
});

describe("withDashboardDb", () => {
	it("creates the schema on first open and records every migration", async () => {
		// "Fully migrated" is asked of the log by name. There is no version number to
		// compare against any more — see the note at the top of DashboardDb.ts.
		await withDashboardDb(() => undefined, { dbPath });
		await expectFullyMigrated(dbPath);
	});

	it("writes no schema_version key at all", async () => {
		// The stamp is read (for pre-log databases) and never written. A fresh database
		// must therefore not have the key — this is what proves the write path is gone
		// rather than merely unused.
		await withDashboardDb(() => undefined, { dbPath });
		const raw = await rawDb(dbPath);
		try {
			const row = raw.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
			expect(row).toBeUndefined();
		} finally {
			raw.close();
		}
	});

	it("creates every table the writer and query layers depend on", async () => {
		const tables = await withDashboardDb(
			(db) =>
				(
					db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
						name: string;
					}>
				).map((r) => r.name),
			{ dbPath },
		);
		for (const expected of [
			"schema_meta",
			"repos",
			"sessions",
			"session_model_usage",
			"commits",
			"commit_branches",
			"worktree_status",
			"events_raw",
			"ingest_cursors",
			// Memory source of truth (SotSchema.ts)
			"repo_state",
			"memories",
			"commit_aliases",
			"transcripts",
			"memory_transcripts",
			"transcript_sessions",
			"context_kinds",
			"context",
			"plan_progress",
			"topic_pages",
			"topic_source_refs",
			"topic_processed_sources",
		]) {
			expect(tables).toContain(expected);
		}
	});

	it("does not create the objects the SQLite cutover retired", async () => {
		// Each of these is a decision, not an omission, so a reappearance should
		// fail here rather than be discovered later:
		//   memory_node_revisions / memory_current_revisions — one row per commit,
		//     multi-versioning was an empty promise (all three tables measured the
		//     same row count) and nothing read history.
		//   memory_fts / docs_fts — search keeps the existing Orama engine and only
		//     changes its data source, so the database builds no search tables and
		//     inherits none of the "index out of step with the table" failures.
		//   repo_worktrees — nothing queried it; the authoritative list of
		//     checkouts is the registry file, which has to live outside the DB
		//     because recovery needs it when the DB is gone.
		const tables = await withDashboardDb(
			(db) =>
				(
					db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as {
						name: string;
					}[]
				).map((r) => r.name),
			{ dbPath },
		);
		for (const retired of [
			// Account-level limit tracking read out of Claude Code's local cache.
			// Both shapes are gone with the feature — a leftover dev dashboard.db
			// keeps its unused table, but nothing recreates one.
			"usage_samples",
			"usage_observations",
			"memory_nodes",
			"memory_node_revisions",
			"memory_current_revisions",
			"memory_fts",
			"docs",
			"doc_kinds",
			"docs_fts",
			"node_transcripts",
			"repo_worktrees",
			"v_memory_current",
		]) {
			expect(tables, `${retired} should not exist`).not.toContain(retired);
		}
	});

	it("has no numeric STORED generated column on memories", async () => {
		// The invariant that keeps one dirty summary from being rejected as a whole
		// row: STRICT type-checks STORED generated columns (a REAL where INTEGER is
		// declared fails the INSERT), and a rejected write is a permanently lost
		// summary because queue entries are deleted fire-and-forget. VIRTUAL
		// columns are not type-checked, so numeric projections must stay VIRTUAL.
		// Read from table_xinfo rather than eyeballing the DDL: "let me index this
		// one" is exactly how it would regress.
		const cols = await withDashboardDb(
			(db) => db.prepare("SELECT name, type, hidden FROM pragma_table_xinfo('memories')").all(),
			{ dbPath },
		);
		// hidden: 2 = VIRTUAL generated, 3 = STORED generated (SQLite's encoding).
		const storedGenerated = (cols as { name: string; type: string; hidden: number }[]).filter(
			(c) => c.hidden === 3,
		);
		expect(storedGenerated.length).toBeGreaterThan(0);
		for (const col of storedGenerated) {
			expect(col.type, `STORED generated column ${col.name} must be TEXT`).toBe("TEXT");
		}
	});

	it("creates the v7 views", async () => {
		const views = await withDashboardDb(
			(db) =>
				(
					db.prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name").all() as Array<{
						name: string;
					}>
				).map((r) => r.name),
			{ dbPath },
		);
		// No views at all. The memory layer never had one — querying memories is
		// querying `memories` — and v_topic_index, which assembled
		// topics/index.json, was dropped once SqliteStorage was found to rebuild
		// that index from the base tables without ever reading it.
		expect(views).toEqual([]);
	});

	it("is idempotent — a second open re-runs no migration", async () => {
		await withDashboardDb(() => undefined, { dbPath });
		await withDashboardDb(() => undefined, { dbPath });
		// One `applied` row per entry, not two: the second open found every name in the
		// log and had nothing to do. (Re-running would also be harmless now — every
		// entry is re-runnable — so this asserts the log, which is what decides.)
		const rows = await readLog(dbPath);
		const applied = (rows ?? []).filter((r) => r.outcome === "applied").map((r) => r.name);
		expect(applied).toEqual(MIGRATIONS.map((m) => m.name));
	});

	it("enforces foreign keys — a child row without its repo is rejected", async () => {
		await expect(
			withDashboardDb(
				(db) => {
					db.prepare(
						"INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms) VALUES ('e', 9999, 'claude', 's', 1)",
					).run();
				},
				{ dbPath },
			),
		).rejects.toThrow(/FOREIGN KEY/i);
	});

	it("refuses to delete a repo that owns rows — now on the foreign key, not the retired trigger", async () => {
		const result = await withDashboardDb(
			(db) => {
				db.prepare(
					"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES ('r', 'r', '/r', 't')",
				).run();
				db.prepare(
					"INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms) VALUES ('e', (SELECT id FROM repos WHERE repo_identity = 'r'), 'claude', 's', 1)",
				).run();
				// `repos_no_delete` used to abort this with "never deleted". With the
				// trigger dropped (REPOS_DELETE_ALLOWED_DDL) the guarantee that matters
				// — a repo's memories cannot be silently wiped — is carried by the NO
				// ACTION foreign keys, which hold because `foreign_keys` is ON in both
				// WRITE_PRAGMAS and READ_PRAGMAS.
				expect(() => db.prepare("DELETE FROM repos WHERE repo_identity = 'r'").run()).toThrow(/FOREIGN KEY/i);
				// The sanctioned path is still soft-disable in place, children untouched.
				db.prepare("UPDATE repos SET disabled_at = 'now' WHERE repo_identity = 'r'").run();
				return {
					sessions: (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n,
					disabled: (
						db.prepare("SELECT disabled_at FROM repos WHERE repo_identity = 'r'").get() as {
							disabled_at: string;
						}
					).disabled_at,
				};
			},
			{ dbPath },
		);
		expect(result.sessions).toBe(1);
		expect(result.disabled).toBe("now");
	});

	it("allows deleting a repo that owns nothing — the case the trigger used to block", async () => {
		const remaining = await withDashboardDb(
			(db) => {
				db.prepare(
					"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES ('empty', 'e', '/e', 't')",
				).run();
				db.prepare("DELETE FROM repos WHERE repo_identity = 'empty'").run();
				return (
					db.prepare("SELECT COUNT(*) AS n FROM repos WHERE repo_identity = 'empty'").get() as { n: number }
				).n;
			},
			{ dbPath },
		);
		expect(remaining).toBe(0);
	});

	it("still cascades intra-repo deletes — removing a commit clears its branch rows", async () => {
		const count = await withDashboardDb(
			(db) => {
				db.prepare(
					"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES ('r', 'r', '/r', 't')",
				).run();
				db.prepare(
					"INSERT INTO commits (event_id, repo_id, hash, committed_at_ms) VALUES ('c', (SELECT id FROM repos WHERE repo_identity = 'r'), 'h', 1)",
				).run();
				db.prepare(
					"INSERT INTO branches (repo_id, name) VALUES ((SELECT id FROM repos WHERE repo_identity = 'r'), 'main')",
				).run();
				db.prepare("DELETE FROM commits WHERE event_id = 'c'").run();
				return (db.prepare("SELECT COUNT(*) AS n FROM commit_branches").get() as { n: number }).n;
			},
			{ dbPath },
		);
		expect(count).toBe(0);
	});

	it("creates session_activity, keyed per (session, bucket) and rejecting a REAL bucket", async () => {
		const rows = await withDashboardDb(
			(db) =>
				db
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_activity'")
					.all() as ReadonlyArray<{ name: string }>,
			{ dbPath },
		);
		expect(rows).toHaveLength(1);

		// STRICT is what turns a forgotten Math.floor into a loud failure instead
		// of a fractional bucket that silently defeats the primary key.
		await withDashboardDb(
			(db) => {
				// `enabled_at` is NOT NULL with no default — omitting it fails the insert.
				db.prepare(
					"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES (?, ?, ?, ?)",
				).run("repo-1", "repo-1", "/tmp/repo-1", "2026-08-11T00:00:00.000Z");
				db.prepare(
					`INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms)
				 VALUES ('s-evt', 1, 'claude', 's1', 1786425300000)`,
				).run();
				db.prepare(
					"INSERT INTO session_activity (session_event_id, bucket_ms, recorded_at_ms) VALUES (?, ?, ?)",
				).run("s-evt", 1786425300000, 1786425400000);
				expect(() =>
					db
						.prepare(
							"INSERT INTO session_activity (session_event_id, bucket_ms, recorded_at_ms) VALUES (?, ?, ?)",
						)
						.run("s-evt", 1786425300000.5, 1786425400000),
				).toThrow(/REAL/);

				// `recorded_at_ms` is NOT NULL with no default — the in-place edit to
				// migration entry 5 is what bought that (an appended ALTER TABLE could
				// only have added it nullable), so pin it rather than let a future
				// "just append a migration" quietly relax it.
				expect(() =>
					db
						.prepare("INSERT INTO session_activity (session_event_id, bucket_ms) VALUES (?, ?)")
						.run("s-evt", 1),
				).toThrow(/NOT NULL/);
			},
			{ dbPath },
		);
	});
});

describe("withReadonlyDashboardDb", () => {
	it("can read what the writer wrote", async () => {
		await withDashboardDb(
			(db) => {
				db.prepare(
					"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES ('r', 'n', '/w', 't')",
				).run();
			},
			{ dbPath },
		);
		const name = await withReadonlyDashboardDb(
			(db) =>
				(db.prepare("SELECT repo_name FROM repos WHERE repo_identity = 'r'").get() as { repo_name: string })
					.repo_name,
			{ dbPath },
		);
		expect(name).toBe("n");
	});

	it("cannot write — the read-only boundary is enforced by SQLite itself", async () => {
		await withDashboardDb(() => undefined, { dbPath });
		await expect(
			withReadonlyDashboardDb(
				(db) => {
					db.prepare(
						"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES ('x', 'x', '/x', 't')",
					).run();
				},
				{ dbPath },
			),
		).rejects.toThrow(/readonly/i);
	});

	it("fails cleanly when no writer has created the database yet", async () => {
		await expect(withReadonlyDashboardDb(() => undefined, { dbPath: join(dir, "absent.db") })).rejects.toThrow();
	});
});

describe("inTransaction", () => {
	it("rolls back everything the callback wrote when it throws", async () => {
		const count = await withDashboardDb(
			(db) => {
				expect(() =>
					inTransaction(db, () => {
						db.prepare(
							"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES ('r', 'r', '/r', 't')",
						).run();
						throw new Error("boom");
					}),
				).toThrow("boom");
				return (db.prepare("SELECT COUNT(*) AS n FROM repos").get() as { n: number }).n;
			},
			{ dbPath },
		);
		expect(count).toBe(0);
	});

	it("commits on success", async () => {
		const count = await withDashboardDb(
			(db) => {
				inTransaction(db, () => {
					db.prepare(
						"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES ('r', 'r', '/r', 't')",
					).run();
				});
				return (db.prepare("SELECT COUNT(*) AS n FROM repos").get() as { n: number }).n;
			},
			{ dbPath },
		);
		expect(count).toBe(1);
	});
});

describe("migrateDashboardDb", () => {
	it("migrates a fresh database and is a no-op the second time", async () => {
		const { DatabaseSync } = await import("node:sqlite");
		const raw = new DatabaseSync(join(dir, "fresh.db")) as unknown as DashboardDbHandle;
		try {
			expect(isSchemaCurrent(raw)).toBe(false);
			migrateDashboardDb(raw);
			expect(isSchemaCurrent(raw)).toBe(true);
			migrateDashboardDb(raw);
			expect(isSchemaCurrent(raw)).toBe(true);
			// Migrating writes no version anywhere — the key is never created.
			expect(raw.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toBeUndefined();
		} finally {
			raw.close();
		}
	});

	it("ignores a leftover schema_version stamp entirely, garbage or not", async () => {
		// The stamp used to decide which entries were skipped as `baseline`. Nothing
		// reads it now, so neither a plausible value nor an unparseable one can change
		// what runs: both databases end up fully migrated with the same log.
		const { DatabaseSync } = await import("node:sqlite");
		const names = async (file: string, stamp: string): Promise<ReadonlyArray<string>> => {
			const raw = new DatabaseSync(join(dir, file)) as unknown as DashboardDbHandle;
			try {
				raw.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT)");
				raw.prepare("INSERT INTO schema_meta VALUES ('schema_version', ?)").run(stamp);
				migrateDashboardDb(raw);
				expect(isSchemaCurrent(raw)).toBe(true);
				return (readMigrationLog(raw) ?? []).filter((r) => r.outcome === "applied").map((r) => r.name);
			} finally {
				raw.close();
			}
		};
		const everyName = MIGRATIONS.map((m) => m.name);
		expect(await names("stamped.db", "5")).toEqual(everyName);
		expect(await names("garbage.db", "not-a-number")).toEqual(everyName);
	});

	it("replaying against a database another writer already migrated is a no-op", async () => {
		// The cross-process race at every shipped version bump: two writers (CLI
		// hook + extension tick) both read the version before either migrates;
		// the loser's BEGIN IMMEDIATE parks until the winner commits, and
		// replaying the winner's entry used to die on `duplicate column name` /
		// `table schema_meta already exists` — an error the busy-retry loop
		// correctly refuses to classify as `locked`, so the loser's whole write
		// failed. Simulated deterministically by faking ONLY the entry read
		// (stale version 0); every statement after BEGIN IMMEDIATE hits the
		// real, fully migrated file — exactly what the loser sees at lock grant.
		const { DatabaseSync } = await import("node:sqlite");
		const racePath = join(dir, "race.db");
		const winner = new DatabaseSync(racePath) as unknown as DashboardDbHandle;
		migrateDashboardDb(winner);
		winner.close();

		const real = new DatabaseSync(racePath) as unknown as DashboardDbHandle;
		let staleEntryRead = true;
		const loser = new Proxy(real as object, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (prop !== "prepare") {
					return typeof value === "function" ? (value as CallableFunction).bind(target) : value;
				}
				return (sql: string) => {
					if (staleEntryRead && sql.includes("schema_meta")) {
						staleEntryRead = false;
						return { get: () => undefined };
					}
					return real.prepare(sql);
				};
			},
		}) as DashboardDbHandle;
		try {
			expect(() => migrateDashboardDb(loser)).not.toThrow();
			expect(isSchemaCurrent(real)).toBe(true);
		} finally {
			real.close();
		}
	});
});

describe("schema creation", () => {
	it("is idempotent — a second open of a current file changes nothing", async () => {
		await withDashboardDb(() => undefined, { dbPath });
		const before = await withDashboardDb((db) => isSchemaCurrent(db), { dbPath });
		const after = await withDashboardDb((db) => isSchemaCurrent(db), { dbPath });
		expect(before).toBe(true);
		expect(after).toBe(true);
	});

	it("supports the repos DML shapes the writers use — UPSERT, UPDATE, child FK", async () => {
		await withDashboardDb(
			(db) => {
				// The three shapes StatsWriter/DbBackfill actually use, replayed verbatim
				// against the surrogate-key repos table.
				db.prepare(
					`INSERT INTO repos (repo_identity, repo_name, worktree_root, remote_url, enabled_at, disabled_at)
					 VALUES ('r', 'old', '/w', NULL, 't', NULL)
					 ON CONFLICT(repo_identity) DO UPDATE SET repo_name = excluded.repo_name`,
				).run();
				db.prepare(
					`INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES ('r', 'new', '/w2', 't')
					 ON CONFLICT(repo_identity) DO UPDATE SET repo_name = excluded.repo_name, worktree_root = excluded.worktree_root`,
				).run();
				db.prepare(
					"UPDATE repos SET bootstrap_state = 'done', last_ingested_at = 't2' WHERE repo_identity = 'r'",
				).run();
				// Children key on repos(id); a nonexistent id is what the FK rejects.
				expect(() =>
					db
						.prepare(
							"INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms) VALUES ('e', 9999, 'claude', 's', 1)",
						)
						.run(),
				).toThrow(/FOREIGN KEY/i);
			},
			{ dbPath },
		);
		const row = await withReadonlyDashboardDb(
			(db) =>
				db
					.prepare(
						"SELECT id, repo_name, worktree_root, bootstrap_state FROM repos WHERE repo_identity = 'r'",
					)
					.get(),
			{ dbPath },
		);
		expect(row).toEqual({ id: 1, repo_name: "new", worktree_root: "/w2", bootstrap_state: "done" });
	});
});

describe("sync-stamp backfill", () => {
	// The stamps arrived as a migration over databases that already had rows, and
	// the whole promise is that the FIRST sync selects what business time would
	// have selected. A fresh database proves none of that — its tables are empty
	// when the entry runs — so this stops at the version before the stamps, seeds
	// the rows a real machine would have, and then migrates the rest of the way.
	async function migrateFromBeforeStamps(seed: (db: DashboardDbHandle) => void): Promise<DashboardDbHandle> {
		const { DatabaseSync } = await import("node:sqlite");
		const raw = new DatabaseSync(dbPath) as unknown as DashboardDbHandle;
		// Everything up to (not including) SESSION_STATS_SYNC_DDL — the entry that
		// carries the sync stamps — located by NAME rather than a hard-coded count: a
		// migration appended ahead of it would otherwise silently change which version
		// this seeds, and the seeded rows are the whole point of the test.
		const stampIndex = MIGRATIONS.findIndex((m) => m.name === "SESSION_STATS_SYNC_DDL");
		for (let slot = 0; slot < stampIndex; slot++) MIGRATIONS[slot].run(raw);
		raw.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(stampIndex));
		// The log is what `migrateDashboardDb` decides from once its own entry
		// (`SCHEMA_MIGRATIONS_DDL`) has run — the version stamp only speaks for a
		// database with no log table at all. Seeding the entries above as applied is
		// therefore what makes this a database at that version rather than one whose
		// every entry looks unrun.
		for (let slot = 0; slot < stampIndex; slot++) recordMigrationAsApplied(raw, MIGRATIONS[slot].name);
		seed(raw);
		migrateDashboardDb(raw);
		return raw;
	}

	it("dates pre-existing rows from their business clock, not from 'now'", async () => {
		const raw = await migrateFromBeforeStamps((db) => {
			db.exec(
				"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES ('r', 'jolli', '/w', 1)",
			);
			db.exec(
				`INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms)
				 VALUES ('s1', 1, 'claude', 'sess-1', 1000)`,
			);
			db.exec(
				`INSERT INTO session_model_usage (session_event_id, model, input_tokens, output_tokens, cached_tokens)
				 VALUES ('s1', 'claude-opus-4-8', 1, 2, 3)`,
			);
			db.exec(
				`INSERT INTO session_tool_use (session_event_id, tool_name, kind, calls)
				 VALUES ('s1', 'Read', 'builtin', 4)`,
			);
			db.exec(
				`INSERT INTO recall_receipts (receipt_id, repo_id, at_ms, surface, hit, commit_count)
				 VALUES ('rc1', 1, 2000, 'cli', 1, 0)`,
			);
		});
		try {
			const one = (sql: string) => (raw.prepare(sql).get() as { v: number }).v;
			// The session's own clock, and the parent's for its two child tables —
			// so a cursor placed by business time sees exactly these rows.
			expect(one("SELECT written_at_ms AS v FROM sessions")).toBe(1000);
			expect(one("SELECT updated_at_ms AS v FROM session_model_usage")).toBe(1000);
			expect(one("SELECT updated_at_ms AS v FROM session_tool_use")).toBe(1000);
			expect(one("SELECT updated_at_ms AS v FROM recall_receipts")).toBe(2000);
			// Commits are stamped 0 on purpose: "written before we tracked this",
			// which is exactly right for a row that has not changed since and never
			// makes a settled rollup day look stale.
			expect(isSchemaCurrent(raw)).toBe(true);
		} finally {
			raw.close();
		}
	});

	it("survives a child row whose parent session is gone", async () => {
		// The column is NOT NULL, so the backfill's subquery returning NULL would
		// abort the migration — and an aborted migration is a database nobody can
		// open. COALESCE is what keeps an orphan cheap: it lands on 0.
		const raw = await migrateFromBeforeStamps((db) => {
			db.exec("PRAGMA foreign_keys = OFF");
			db.exec(
				`INSERT INTO session_model_usage (session_event_id, model, input_tokens, output_tokens, cached_tokens)
				 VALUES ('missing', 'claude-opus-4-8', 1, 2, 3)`,
			);
		});
		try {
			expect((raw.prepare("SELECT updated_at_ms AS v FROM session_model_usage").get() as { v: number }).v).toBe(
				0,
			);
			expect(isSchemaCurrent(raw)).toBe(true);
		} finally {
			raw.close();
		}
	});
});

describe("transactional migration runner", () => {
	it("rolls a failed entry back — nothing claims it ran, and a retry succeeds", async () => {
		// A pre-existing `memories` table with the wrong shape makes the baseline entry
		// fail part-way through, after it has already created earlier tables inside the
		// transaction.
		//
		// Note WHERE it now fails. `CREATE TABLE IF NOT EXISTS memories` skips over the
		// impostor silently, so the entry gets as far as indexing it and dies on the
		// missing column instead of on `table memories already exists`. That is the
		// idempotency pass showing through: a guarded CREATE cannot report a conflict,
		// so a table of the wrong shape is discovered later and less directly.
		const { DatabaseSync } = await import("node:sqlite");
		{
			const raw = new DatabaseSync(dbPath) as unknown as DashboardDbHandle;
			try {
				raw.exec("CREATE TABLE memories (wrong TEXT)");
			} finally {
				raw.close();
			}
		}

		await expect(withDashboardDb(() => undefined, { dbPath })).rejects.toThrow(/no such column/);

		// Nothing half-applied: the rollback took the tables the entry had already
		// created with it, and nothing claims the entry ran.
		const raw = new DatabaseSync(dbPath) as unknown as DashboardDbHandle;
		try {
			expect(isSchemaCurrent(raw)).toBe(false);
			expect(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'repos'").get()).toEqual({ n: 0 });
			raw.exec("DROP TABLE memories");
		} finally {
			raw.close();
		}

		// With the obstacle gone the same file migrates cleanly.
		expect(await withDashboardDb((db) => isSchemaCurrent(db), { dbPath })).toBe(true);
	});

	it("restores foreign_keys = ON even when a migration entry throws", async () => {
		const { DatabaseSync } = await import("node:sqlite");
		const raw = new DatabaseSync(dbPath) as unknown as DashboardDbHandle;
		try {
			raw.exec("PRAGMA foreign_keys = ON");
			raw.exec("CREATE TABLE memories (wrong TEXT)");
			expect(() => migrateDashboardDb(raw)).toThrow();
			// The finally must have re-asserted the pragma, or every CASCADE in the
			// caller's batch would silently stop firing.
			expect((raw.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
		} finally {
			raw.close();
		}
	});

	it("NEVER refuses a database a newer build has written to", async () => {
		// The assertion the whole change exists for. Measured before it: five MCP
		// servers, the dashboard server and the VS Code extension host all died on
		// the same error for a schema bump that added two tables and five nullable
		// columns. There is no gate left — not a version one, not a floor one, and
		// there is no longer even a number one could be built from.
		await withDashboardDb(() => undefined, { dbPath });
		await recordForeignMigration(dbPath, "2099-01-01-0000-from-the-future");
		await expect(withDashboardDb(() => "opened", { dbPath })).resolves.toBe("opened");
		// And it can still WRITE — the half that was actually broken, since reads were
		// never version-gated in the first place.
		await expect(
			withDashboardDb(
				(db) => {
					db.prepare("INSERT INTO schema_meta (key, value) VALUES ('probe', 'written') ").run();
					return (db.prepare("SELECT value FROM schema_meta WHERE key = 'probe'").get() as { value: string })
						.value;
				},
				{ dbPath },
			),
		).resolves.toBe("written");
	});

	it("writes neither a version nor a compatibility floor key", async () => {
		// Three keys were tried and removed: `min_compatible_version`,
		// `min_compatible_release`, and finally `schema_version` itself. Their absence
		// is pinned so none comes back by accident — a floor a build cannot see is worse
		// than no floor, and this database is not where compatibility is decided.
		await withDashboardDb(() => undefined, { dbPath });
		const keys = await withReadonlyDashboardDb(
			(db) => (db.prepare("SELECT key FROM schema_meta").all() as Array<{ key: string }>).map((r) => r.key),
			{ dbPath },
		);
		expect(keys).not.toContain("schema_version");
		expect(keys.filter((k) => k.includes("compatible"))).toEqual([]);
	});

	it("warns ONCE per process about a migration it does not know", async () => {
		// This path is on the git hook, so a warn per open would flood the log. The
		// set is module-scoped and keyed by the migration name, so the second open of
		// the same file is silent. This warning replaced the format-ahead one: it says
		// WHICH migration and WHICH surface, where a version comparison could only say
		// that two integers differed.
		//
		// A name unique to this test, because that de-duplication set is module-scoped
		// and therefore shared across the whole file — a name another test already
		// warned about would arrive here pre-silenced.
		await withDashboardDb(() => undefined, { dbPath });
		await recordForeignMigration(dbPath, "2099-02-02-0000-warn-once-probe");
		const lines: string[] = [];
		const spy = vi
			.spyOn(console, "warn")
			.mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
		try {
			await withDashboardDb(() => undefined, { dbPath });
			await withDashboardDb(() => undefined, { dbPath });
		} finally {
			spy.mockRestore();
		}
		// EXACTLY one, not "at most one": the point is that the second open is silent,
		// and an assertion that passes on zero would not notice the line disappearing.
		const unknown = lines.filter((l) => l.includes("2099-02-02-0000-warn-once-probe"));
		expect(unknown).toHaveLength(1);
		expect(unknown[0]).toContain("unknown to this build");
		// Names the surface: six kinds of process share one debug.log, so a line that
		// says only "this build" cannot answer which of them could not see the data.
		expect(unknown[0]).toMatch(/\(([a-z-]+\/\S+)\)/);
	});
});

describe("owner-only permissions (§11 defect 1)", () => {
	/*
	 * POSIX-only: `chmod` on Windows moves the read-only bit and nothing else, and `stat`
	 * reports a fixed 0666/0777, so these would be assertions about a permission model
	 * that does not exist there — the same gate `JsonMcpWriter.test.ts` and
	 * `CodexTomlWriter.test.ts` put on their own mode checks. Applied per test rather
	 * than to the describe, because the sidecar-tolerance case below is about the chmod
	 * loop surviving ENOENT and is worth running on every platform.
	 */
	const itPosix = it.skipIf(process.platform === "win32");

	itPosix("creates the directory 0700 and the database 0600", async () => {
		const nested = join(dir, "cfg");
		const target = join(nested, "dashboard.db");
		await withDashboardDb(() => undefined, { dbPath: target });

		expect(statSync(nested).mode & 0o777).toBe(0o700);
		expect(statSync(target).mode & 0o777).toBe(0o600);
	});

	itPosix("tightens a database an older build left world-readable", async () => {
		await withDashboardDb(() => undefined, { dbPath });
		// Simulate the pre-fix state: 0644 file inside a 0755 directory.
		chmodSync(dbPath, 0o644);
		chmodSync(dir, 0o755);

		await withDashboardDb(() => undefined, { dbPath });

		expect(statSync(dbPath).mode & 0o777).toBe(0o600);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
	});

	itPosix("leaves the WAL sidecars owner-only too", async () => {
		// Hold the handle open across a write so -wal/-shm exist while we look.
		await withDashboardDb(
			(db) => {
				db.prepare(
					"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES ('r','r','/w','t')",
				).run();
				for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
					if (existsSync(sidecar)) expect(statSync(sidecar).mode & 0o777).toBe(0o600);
				}
			},
			{ dbPath },
		);
	});

	itPosix("does not chmod on a read-only open — readers never touch permissions", async () => {
		await withDashboardDb(() => undefined, { dbPath });
		chmodSync(dbPath, 0o640);

		await withReadonlyDashboardDb(() => undefined, { dbPath });

		// Unchanged: only the write path asserts ownership, so a reader cannot
		// surprise the user by rewriting modes on a file it was only inspecting.
		expect(statSync(dbPath).mode & 0o777).toBe(0o640);
	});

	it("tolerates absent WAL sidecars (the normal case) without warning or failure", async () => {
		// After a clean close the sidecars are gone, so the chmod loop hits ENOENT
		// on two of its three paths every time — that must be silent, not noisy.
		await withDashboardDb(() => undefined, { dbPath });
		expect(existsSync(`${dbPath}-wal`)).toBe(false);
		await expect(withDashboardDb(() => "ok", { dbPath })).resolves.toBe("ok");
	});
});

describe("write-lock waiting (§10.1)", () => {
	it("applies the caller's busy_timeout to the connection", async () => {
		const timeout = await withDashboardDb(
			(db) => (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
			{ dbPath, busyTimeoutMs: 777 },
		);
		expect(timeout).toBe(777);
	});

	it("defaults to DEFAULT_BUSY_TIMEOUT_MS", async () => {
		const timeout = await withDashboardDb(
			(db) => (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
			{ dbPath },
		);
		expect(timeout).toBe(DEFAULT_BUSY_TIMEOUT_MS);
	});

	it("gives the editor host a shorter wait than a detached worker", () => {
		// The editor writes on the thread that draws the UI, so waiting is a freeze;
		// a detached worker has nobody waiting on it and should not drop data.
		expect(BUSY_TIMEOUT_BY_ROLE.vscode).toBeLessThan(BUSY_TIMEOUT_BY_ROLE["queue-worker"]);
		expect(BUSY_TIMEOUT_BY_ROLE.vscode).toBeLessThan(DEFAULT_BUSY_TIMEOUT_MS);
	});
});

describe("the migration log — identity is the name, not the slot", () => {
	it("logs every entry it applies, with a real client identity and a duration", async () => {
		await withDashboardDb(() => undefined, { dbPath });
		const rows = await readLog(dbPath);
		expect(rows?.map((r) => r.name)).toEqual(MIGRATIONS.map((m) => m.name));
		expect(rows?.every((r) => r.outcome === "applied")).toBe(true);
		// The identity is JOLLI_CLIENT_HEADER — '<kind>/<version>' — and never a
		// literal: the point of the column is naming the surface a user would go
		// and upgrade.
		expect(rows?.every((r) => /^[a-z-]+\/\S+$/.test(r.applied_by))).toBe(true);
		expect(rows?.every((r) => r.duration_ms >= 0)).toBe(true);
		// Slot is recorded but decides nothing.
		expect(rows?.map((r) => r.slot)).toEqual(MIGRATIONS.map((_m, i) => i));
	});

	it("stores the SQL verbatim, so the log answers 'what actually ran' offline", async () => {
		await withDashboardDb(() => undefined, { dbPath });
		const rows = await readLog(dbPath);
		for (const row of rows ?? []) {
			// `sql ?? ""`: a code entry has no SQL to store, and the empty string is what
			// makes it compare equal to itself for ever instead of reporting drift
			// against a body that was never SQL in the first place.
			expect(row.ddl).toBe(MIGRATIONS[row.slot].sql ?? "");
		}
	});

	it("replays every entry on a pre-log database, recording observations and no inference", async () => {
		// The behaviour that replaced baseline seeding. A pre-log database used to have
		// entries 0..stamp-1 marked `baseline` and SKIPPED, on a mapping from the stamp
		// to this build's list that could only ever be a guess — and a wrong guess skips
		// an entry, which is the failure this file exists to prevent. Now every entry
		// runs: the ones the database already satisfies are no-ops, because every entry
		// is re-runnable.
		await buildLegacyDb(dbPath, 5);
		await withDashboardDb(() => undefined, { dbPath });
		const rows = await readLog(dbPath);
		// Every name, in list order, and every one of them an `applied` row — this pass
		// watched each entry run. Derived from MIGRATIONS rather than spelled out: a
		// hardcoded list breaks on the next append for no reason.
		expect(rows?.filter((r) => r.outcome === "applied").map((r) => r.name)).toEqual(MIGRATIONS.map((m) => m.name));
		// Nothing infers any more. `baseline` remains a legal outcome — 0.99.12/0.99.13
		// wrote it and it is still read as "done" — but no code path produces one.
		expect(rows?.some((r) => r.outcome === "baseline")).toBe(false);
	});

	it("fills a gap a stamp claimed was already applied", async () => {
		// The reason baseline seeding was retired, as a failing-then-passing case rather
		// than an argument. A stamp of 5 asserts that entries 0..4 ran; this database has
		// only run 0..3, which is exactly what a stamp from the older NUMBERED list can
		// mean, since its position 4 was not this list's entry 4.
		//
		// Under the seeding this was unrecoverable: entry 4 was marked `baseline`, skipped,
		// and its column never appeared — on a machine whose log then said the migration
		// had run. Replaying reaches it.
		const raw = await rawDb(dbPath);
		try {
			for (let slot = 0; slot < 4; slot++) MIGRATIONS[slot].run(raw);
			raw.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '5')").run();
			// The gap: entry 4 is `TOOL_CALL_TIME_DDL`, and its column is absent.
			expect(MIGRATIONS[4].name).toBe("TOOL_CALL_TIME_DDL");
			expect(columnsOf(raw, "session_tool_use")).not.toContain("last_call_at_ms");
		} finally {
			raw.close();
		}
		await withDashboardDb(() => undefined, { dbPath });
		const after = await rawDb(dbPath);
		try {
			expect(columnsOf(after, "session_tool_use")).toContain("last_call_at_ms");
		} finally {
			after.close();
		}
	});

	it("drops repos_no_delete when upgrading a database that predates the entry", async () => {
		// The behaviour REPOS_DELETE_ALLOWED_DDL exists for, on the path that
		// matters: an existing install, not a fresh one. `BASELINE_DDL` is frozen
		// and still creates the trigger, so every database ever made has it and
		// only this entry takes it away.
		await buildLegacyDb(dbPath, 5);
		const before = await rawDb(dbPath);
		try {
			expect(before.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()).toEqual([
				{ name: "repos_no_delete" },
			]);
		} finally {
			before.close();
		}
		const after = await withDashboardDb(
			(db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all(),
			{ dbPath },
		);
		expect(after).toEqual([]);
	});

	it("re-applies a MISSING name on a database that is already past it — the self-heal", async () => {
		// The whole reason identity moved off the slot. Two branches each appended an
		// entry; after the merge the file's log is missing one of them while its
		// version says "finished". Name-keyed, the missing one is simply applied.
		await withDashboardDb(() => undefined, { dbPath });
		const raw = await rawDb(dbPath);
		try {
			raw.prepare("DELETE FROM schema_migrations WHERE name = ?").run("EVENT_FAILED_KIND_DDL");
			raw.exec("ALTER TABLE events_raw DROP COLUMN failed_kind");
		} finally {
			raw.close();
		}
		await withDashboardDb(() => undefined, { dbPath });
		const rows = await readLog(dbPath);
		expect(rows?.filter((r) => r.name === "EVENT_FAILED_KIND_DDL" && r.outcome === "applied")).toHaveLength(1);
		// And nothing else was disturbed: the entries around it stay recorded exactly
		// once. (There is no version stamp left to be dragged backwards.)
		await expectFullyMigrated(dbPath);
	});

	it("records a 'skipped' row when another writer got there first", async () => {
		// The concurrency path, which is the only one a single-threaded test has to
		// stage: the pass decides to apply an entry, then finds it already applied
		// once it holds the write lock (a rival writer committed in between). That
		// used to be a bare `continue` leaving no trace anywhere — and a skipped
		// entry that nobody comes back to is precisely the bug this table exists for.
		await withDashboardDb(() => undefined, { dbPath });
		const raw = await rawDb(dbPath);
		try {
			// Hide one name from the FIRST log read only. The second read happens
			// inside BEGIN IMMEDIATE and sees the real rows — exactly what a rival's
			// commit looks like from in here.
			let reads = 0;
			const hidden = "RECALL_RECEIPTS_DDL";
			const patched: DashboardDbHandle = {
				exec: (sql) => raw.exec(sql),
				close: () => raw.close(),
				prepare: (sql) => {
					const stmt = raw.prepare(sql);
					if (!sql.includes("FROM schema_migrations")) return stmt;
					return {
						...stmt,
						all: (...params) => {
							const rows = stmt.all(...params) as MigrationLogRow[];
							reads += 1;
							return reads === 1 ? rows.filter((r) => r.name !== hidden) : rows;
						},
						get: (...params) => stmt.get(...params),
						run: (...params) => stmt.run(...params),
					};
				},
			};
			migrateDashboardDb(patched, { appliedBy: "test/1.0" });
			const rows = readMigrationLog(raw);
			expect(rows?.filter((r) => r.outcome === "skipped").map((r) => r.name)).toEqual([hidden]);
			// And nothing was re-executed: the entry's original applied row still
			// stands alone.
			expect(rows?.filter((r) => r.name === hidden && r.outcome === "applied")).toHaveLength(1);
		} finally {
			raw.close();
		}
	});

	it("flushes rows applied before the log table existed even when it then SKIPS the creating entry", async () => {
		// The Critical race, reproduced deterministically. This pass applies the pre-log
		// entries (their DDL runs, the rows held in memory because there is nowhere yet to
		// record them); a RIVAL that started from version 0 then creates the log table and
		// records ONLY the entries from the log slot on; and this pass SKIPS every one of
		// them. The skip used to `continue` without flushing the held rows, so those slots
		// were absent from the log, re-ran on the next open, and died on a duplicate object
		// — permanently. The flush is now unconditional at the skip.
		const raw = await rawDb(dbPath);
		try {
			const logSlot = MIGRATIONS.findIndex((m) => m.name === "SCHEMA_MIGRATIONS_DDL");
			let rivalRan = false;
			const logTableExists = (): boolean => {
				try {
					(raw.prepare("SELECT 1 FROM schema_migrations LIMIT 1") as { get: () => unknown }).get();
					return true;
				} catch {
					return false;
				}
			};
			// "This pass has applied every pre-log entry" is detected from the SCHEMA
			// rather than from a version stamp — there is no stamp any more. The entry
			// just before the log one adds `session_tool_use.last_call_at_ms`, so that
			// column existing while the log table does not is exactly the window.
			const lastPreLogColumnExists = (): boolean => {
				try {
					const cols = raw
						.prepare("SELECT name FROM pragma_table_info('session_tool_use')")
						.all() as ReadonlyArray<{ name?: string }>;
					return cols.some((c) => c.name === "last_call_at_ms");
				} catch {
					return false;
				}
			};
			// A monotone clock that, the instant that window opens, stands in for the
			// rival: it creates the table and records slots logSlot..end, leaving the
			// earlier slots unrecorded so this pass's held rows are their only evidence.
			// `startedAt = now()` runs before this pass's BEGIN IMMEDIATE, so the file is
			// unlocked here and the rival's writes commit cleanly.
			let t = 1;
			const now = (): number => {
				if (!rivalRan && !logTableExists() && lastPreLogColumnExists()) {
					rivalRan = true;
					for (let s = logSlot; s < MIGRATIONS.length; s++) MIGRATIONS[s].run(raw);
					for (let s = logSlot; s < MIGRATIONS.length; s++) {
						raw.prepare(
							"INSERT INTO schema_migrations (slot, name, outcome, applied_by, applied_at_ms, duration_ms, ddl) VALUES (?, ?, 'applied', 'rival/1.0', 0, 0, ?)",
						).run(s, MIGRATIONS[s].name, MIGRATIONS[s].sql ?? "");
					}
				}
				return t++;
			};
			migrateDashboardDb(raw, { appliedBy: "test/1.0", now });
			expect(rivalRan).toBe(true);
			const recorded = new Set(
				readMigrationLog(raw)
					?.filter((r) => r.outcome === "applied" || r.outcome === "baseline")
					.map((r) => r.name),
			);
			// EVERY migration name is recorded — the held pre-log rows survived the skip.
			for (const m of MIGRATIONS) expect(recorded.has(m.name)).toBe(true);
			// And the proof it matters: a second pass has nothing to re-run, so it does not
			// throw on a duplicate object — the permanent-corruption symptom.
			expect(() => migrateDashboardDb(raw, { appliedBy: "test/1.0" })).not.toThrow();
		} finally {
			raw.close();
		}
	});

	it("re-runs cleanly when the log has lost a row", async () => {
		// What the idempotency pass bought, on the state that used to be unrecoverable:
		// the log loses a row (a hand-edit, a restore from an older backup) while the
		// objects that entry created are still in the schema. Every entry re-runs
		// without touching anything, so the pass repairs the log instead of dying on
		// `table already exists` on every open from then on.
		await withDashboardDb(() => undefined, { dbPath });
		const raw = await rawDb(dbPath);
		try {
			raw.prepare("DELETE FROM schema_migrations WHERE name = ?").run("RECALL_RECEIPTS_DDL");
			expect(isSchemaCurrent(raw)).toBe(false);
			expect(() => migrateDashboardDb(raw, { appliedBy: "test/1.0" })).not.toThrow();
			expect(isSchemaCurrent(raw)).toBe(true);
		} finally {
			raw.close();
		}
	});

	it("keeps a 'failed' row even though the transaction rolled back", async () => {
		// Written after the ROLLBACK, outside the transaction, or it would vanish
		// with the change it describes — and most callers of withDashboardDb swallow
		// the exception, so this row can be the only evidence a user ever has.
		//
		// The failure is INJECTED rather than provoked by deleting a log row and letting
		// the entry re-run. That used to work because re-running died on `duplicate
		// column`; every entry is re-runnable now, so a replay is a no-op and there is
		// no natural way left to make one fail. Which is the point of the idempotency
		// pass — but this row's mechanism still needs proving, so the throw comes from a
		// handle that refuses the one statement.
		await withDashboardDb(() => undefined, { dbPath });
		const raw = await rawDb(dbPath);
		try {
			raw.prepare("DELETE FROM schema_migrations WHERE name = ?").run("TOOL_CALL_TIME_DDL");
			// The column has to be gone as well, or `addColumnIfMissing` sees it, returns
			// early, and the entry never reaches the statement being sabotaged.
			raw.exec("ALTER TABLE session_tool_use DROP COLUMN last_call_at_ms");
			const patched = new Proxy(raw as object, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (prop !== "exec") {
						return typeof value === "function" ? (value as CallableFunction).bind(target) : value;
					}
					return (sql: string) => {
						if (sql.includes("last_call_at_ms")) throw new Error("injected migration failure");
						return raw.exec(sql);
					};
				},
			}) as DashboardDbHandle;
			expect(() => migrateDashboardDb(patched, { appliedBy: "test/1.0" })).toThrow(/injected/);
			const rows = readMigrationLog(raw);
			const failed = rows?.filter((r) => r.outcome === "failed");
			expect(failed?.map((r) => r.name)).toEqual(["TOOL_CALL_TIME_DDL"]);
			expect(failed?.[0]?.applied_by).toBe("test/1.0");
		} finally {
			raw.close();
		}
	});

	it("says nothing when a logged body differs from this build's", async () => {
		// The content drift check is GONE, and this pins its absence rather than leaving
		// a silence nobody chose. It compared each logged `ddl` byte-for-byte against
		// this build's and warned on a difference — which cannot tell our own equivalent
		// rewrite from another build's work. Measured against 0.99.13, the idempotency
		// pass would have made six of its seven entries report drift on every existing
		// install, for a change that altered nothing.
		await withDashboardDb(() => undefined, { dbPath });
		const raw = await rawDb(dbPath);
		const lines: string[] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
		try {
			raw.prepare("UPDATE schema_migrations SET ddl = 'totally different bytes' WHERE name = ?").run(
				"SKILL_CONTEXT_KIND_DDL",
			);
			verifyMigrationLog(raw);
			expect(lines.filter((l) => l.includes("DIFFERENT DDL"))).toHaveLength(0);
		} finally {
			spy.mockRestore();
			raw.close();
		}
	});

	it("tolerates a database with no log table — the entry that creates it is in the list", async () => {
		const raw = await rawDb(dbPath);
		try {
			expect(readMigrationLog(raw)).toBeUndefined();
			expect(() => verifyMigrationLog(raw)).not.toThrow();
		} finally {
			raw.close();
		}
		// The full pass, from empty, has to survive checking for a table it is about
		// to create.
		await expect(withDashboardDb(() => "ok", { dbPath })).resolves.toBe("ok");
	});

	it("warns — never throws — about a migration this build has never heard of", async () => {
		await withDashboardDb(() => undefined, { dbPath });
		const raw = await rawDb(dbPath);
		try {
			raw.prepare("UPDATE schema_migrations SET name = ? WHERE name = ?").run(
				"SOME_UNMERGED_BRANCH_DDL",
				"SKILL_CONTEXT_KIND_DDL",
			);
			// A file legitimately shared by two builds in rotation must stay usable;
			// the foreign name is a clue, not a fault.
			expect(() => verifyMigrationLog(raw)).not.toThrow();
		} finally {
			raw.close();
		}
	});

	it("records a migration as applied by APPENDING a row — the missing-row repair", async () => {
		// The one state a name key cannot fix by itself: the log lost a row while the
		// column that entry created is still in the schema, so the next open would
		// re-run it and die on `duplicate column`. `doctor --mark-migration` writes the
		// row back. An append, never an UPDATE — the log stays a log.
		await withDashboardDb(() => undefined, { dbPath });
		const raw = await rawDb(dbPath);
		try {
			raw.prepare("DELETE FROM schema_migrations WHERE name = ?").run("TOOL_CALL_TIME_DDL");
			expect(recordMigrationAsApplied(raw, "TOOL_CALL_TIME_DDL", { appliedBy: "test/1.0" })).toBe(true);
			const rows = readMigrationLog(raw)?.filter((r) => r.name === "TOOL_CALL_TIME_DDL");
			expect(rows).toHaveLength(1);
			expect(rows?.[0]?.applied_by).toBe("test/1.0");
			// A name this build does not carry has no DDL to record.
			expect(recordMigrationAsApplied(raw, "NOT_A_MIGRATION")).toBe(false);
		} finally {
			raw.close();
		}
	});

	it("reports a log table it cannot READ as unreadable, never as absent", async () => {
		// The state the whole table exists to diagnose. Answering `none` here sends the
		// reader looking for a database that predates the log — and makes the migration
		// pass believe the version stamp is trustworthy evidence.
		await withDashboardDb(() => undefined, { dbPath });
		const raw = await rawDb(dbPath);
		try {
			raw.exec("ALTER TABLE schema_migrations RENAME COLUMN ddl TO ddl_moved_by_another_build");
			const state = readMigrationLogState(raw);
			expect(state.kind).toBe("unreadable");
			if (state.kind === "unreadable") expect(state.reason).toContain("ddl");
			// The convenience wrapper still collapses both to undefined — callers that act
			// on the difference are the ones that must ask for the state.
			expect(readMigrationLog(raw)).toBeUndefined();
			// Nothing may throw over it, and nothing may be written into it.
			expect(() => verifyMigrationLog(raw)).not.toThrow();
			expect(recordMigrationAsApplied(raw, "TOOL_CALL_TIME_DDL")).toBe(false);
		} finally {
			raw.close();
		}
	});

	it("reports a database that cannot answer AT ALL as unreadable, never as pre-log", async () => {
		// A garbage or truncated file opens fine — SQLite reads no page until the first
		// statement — so the failure lands on the table-existence probe. Answering
		// "absent" for a probe that itself failed reported a corrupt database as "no
		// migration log yet", i.e. the pre-log message, to the one reader who cannot act
		// on it. `tableConfirmed` is what keeps the two apart.
		const { writeFileSync } = await import("node:fs");
		writeFileSync(dbPath, "this is not a database");
		const raw = await rawDb(dbPath);
		try {
			const state = readMigrationLogState(raw);
			expect(state.kind).toBe("unreadable");
			if (state.kind === "unreadable") expect(state.tableConfirmed).toBe(false);
			expect(() => verifyMigrationLog(raw)).not.toThrow();
		} finally {
			raw.close();
		}
	});

	it("migrates from the version stamp over a damaged log, warns, and seeds NOTHING", async () => {
		await withDashboardDb(() => undefined, { dbPath });
		const raw = await rawDb(dbPath);
		const lines: string[] = [];
		const spy = vi
			.spyOn(console, "warn")
			.mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
		const countRows = () => (raw.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n;
		try {
			const before = countRows();
			raw.exec("ALTER TABLE schema_migrations RENAME COLUMN name TO name_moved_by_another_build");
			expect(() => migrateDashboardDb(raw, { appliedBy: "test/1.0" })).not.toThrow();
			// Writing inference into a table whose shape this build cannot read is how a
			// half-written log gets manufactured; the row count is untouched.
			expect(countRows()).toBe(before);
		} finally {
			spy.mockRestore();
			raw.close();
		}
		expect(lines.filter((l) => l.includes("could not be read"))).toHaveLength(1);
	});
});

describe("withRepairDashboardDb", () => {
	it("refuses nothing — its whole job is skipping the migration pass", async () => {
		// Not a bypass around a gate any more (there is none). The pass is the thing it
		// must skip: `--mark-migration` repairs a database whose log lost a row, and a
		// pass would re-run that entry into `duplicate column` before the repair ran.
		await withDashboardDb(() => undefined, { dbPath });
		await expect(withRepairDashboardDb(() => "ok", { dbPath })).resolves.toBe("ok");
	});

	it("does not migrate, so it cannot repair by moving the thing under repair", async () => {
		// Proved by the log table's continued ABSENCE. It used to be proved by the
		// version stamp still reading 5, which is no longer observable — nothing reads
		// that key. A pre-log database is the sharpest case: the pass this open must skip
		// is the one that would create the log and replay every entry.
		await buildLegacyDb(dbPath, 5);
		await withRepairDashboardDb(() => undefined, { dbPath });
		await expect(withReadonlyDashboardDb((db) => readMigrationLogState(db).kind, { dbPath })).resolves.toBe("none");
	});
});

describe("the in-lock skip predicate", () => {
	it("re-applies an entry the in-lock read sees as 'baseline', not 'applied'", async () => {
		// The `|| baseline` half of the in-lock skip predicate. Staged like the
		// `skipped`-row test: the FIRST log read (which computes `done`) hides one name
		// so it lands in `todo`, and the in-lock read then reports that name with a
		// `baseline` outcome — a rival that seeded it from a version stamp while this
		// pass held the entry pending. The predicate must treat baseline as "already
		// run" and skip rather than re-execute.
		await withDashboardDb(() => undefined, { dbPath });
		const raw = await rawDb(dbPath);
		try {
			const hidden = "RECALL_RECEIPTS_DDL";
			let reads = 0;
			const patched: DashboardDbHandle = {
				exec: (sql) => raw.exec(sql),
				close: () => raw.close(),
				prepare: (sql) => {
					const stmt = raw.prepare(sql);
					if (!sql.includes("FROM schema_migrations")) return stmt;
					return {
						...stmt,
						all: (...params) => {
							const rows = stmt.all(...params) as MigrationLogRow[];
							reads += 1;
							if (reads === 1) return rows.filter((r) => r.name !== hidden);
							return rows.map((r) => (r.name === hidden ? { ...r, outcome: "baseline" } : r));
						},
						get: (...params) => stmt.get(...params),
						run: (...params) => stmt.run(...params),
					};
				},
			};
			migrateDashboardDb(patched, { appliedBy: "test/1.0" });
			const rows = readMigrationLog(raw);
			// It skipped rather than re-ran: a `skipped` row is appended and the entry's
			// original `applied` row still stands alone.
			expect(rows?.filter((r) => r.outcome === "skipped").map((r) => r.name)).toEqual([hidden]);
			expect(rows?.filter((r) => r.name === hidden && r.outcome === "applied")).toHaveLength(1);
		} finally {
			raw.close();
		}
	});

	it("migrates a database whose log cannot be READ AT ALL — warns tableConfirmed=false", async () => {
		// The `tableConfirmed` false arm of the migrate-time warn: a garbage file whose
		// existence probe itself fails, so migration proceeds from the version stamp and
		// records nothing before the first DDL statement dies on the corrupt file.
		const { writeFileSync } = await import("node:fs");
		writeFileSync(dbPath, "this is not a database");
		const raw = await rawDb(dbPath);
		const lines: string[] = [];
		const spy = vi
			.spyOn(console, "warn")
			.mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
		try {
			expect(() => migrateDashboardDb(raw, { appliedBy: "test/1.0" })).toThrow();
		} finally {
			spy.mockRestore();
			raw.close();
		}
		expect(lines.filter((l) => l.includes("could not be queried for its migration log"))).toHaveLength(1);
	});

	it("tolerates a rival having already applied entries to a PRE-LOG database", async () => {
		// This replaces a `readSchemaVersion(db) > slot` fence that used to sit inside
		// the write lock. It looked like version machinery but guarded a concurrency
		// case: on a database with no log table there is nothing to consult, so a writer
		// that woke from BEGIN IMMEDIATE after a rival had committed would REPLAY an
		// entry. That was fatal only because entries were not re-runnable — it died on
		// `table already exists`. Now the replay is a sequence of statements that do
		// nothing, so the fence was removed and this is the invariant that took over.
		await buildLegacyDb(dbPath, 5);
		const rival = await rawDb(dbPath);
		try {
			// The rival applies everything from the log entry onward and records it.
			for (let s = 5; s < MIGRATIONS.length; s++) MIGRATIONS[s].run(rival);
		} finally {
			rival.close();
		}
		// The loser now runs with no knowledge of that: it saw the pre-log state, so its
		// todo list still contains every entry from 5 on.
		const raw = await rawDb(dbPath);
		try {
			expect(() => migrateDashboardDb(raw, { appliedBy: "test/1.0" })).not.toThrow();
			expect(isSchemaCurrent(raw)).toBe(true);
		} finally {
			raw.close();
		}
	});
});

describe("addColumnIfMissing", () => {
	it("adds a column that is absent and leaves an existing one alone", async () => {
		const raw = await rawDb(dbPath);
		try {
			raw.exec("CREATE TABLE t (a TEXT)");
			addColumnIfMissing(raw, "t", "b", "INTEGER NOT NULL DEFAULT 7");
			raw.exec("INSERT INTO t (a) VALUES ('x')");
			expect(raw.prepare("SELECT b FROM t").get()).toEqual({ b: 7 });
			// Second call is the point: SQLite has no ADD COLUMN IF NOT EXISTS, so
			// without the pragma probe this throws `duplicate column name`.
			expect(() => addColumnIfMissing(raw, "t", "b", "INTEGER NOT NULL DEFAULT 7")).not.toThrow();
			expect(raw.prepare("SELECT b FROM t").get()).toEqual({ b: 7 });
		} finally {
			raw.close();
		}
	});

	it("refuses identifiers it would have to interpolate unsafely", async () => {
		// The names are source constants today, but they ARE interpolated — a table or
		// column name cannot be a bound parameter — so an unvalidated one is exactly
		// what CodeQL flags, and rightly.
		const raw = await rawDb(dbPath);
		try {
			raw.exec("CREATE TABLE t (a TEXT)");
			expect(() => addColumnIfMissing(raw, "t; DROP TABLE t", "b", "TEXT")).toThrow(/unsafe table name/);
			expect(() => addColumnIfMissing(raw, "t", "b TEXT, c", "TEXT")).toThrow(/unsafe column name/);
			expect(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 't'").get()).toEqual({ n: 1 });
		} finally {
			raw.close();
		}
	});

	it("refuses a column declaration it would have to interpolate unsafely", async () => {
		// `decl` is interpolated exactly like `table`/`column` — a type + constraint
		// clause cannot be a bound parameter either — so it needs the same guard. Every
		// call site today passes a literal ("TEXT", "INTEGER NOT NULL DEFAULT 0"); this
		// is what stops a future one that computes `decl` from anything else.
		const raw = await rawDb(dbPath);
		try {
			raw.exec("CREATE TABLE t (a TEXT)");
			expect(() => addColumnIfMissing(raw, "t", "b", "TEXT; DROP TABLE t")).toThrow(/unsafe column declaration/);
			expect(() => addColumnIfMissing(raw, "t", "b", "TEXT DEFAULT (SELECT sqlite_version())")).toThrow(
				/unsafe column declaration/,
			);
			expect(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 't'").get()).toEqual({ n: 1 });
			expect(columnsOf(raw, "t")).not.toContain("b");
		} finally {
			raw.close();
		}
	});
});

describe("dbHasUnknownMigrations", () => {
	it("is false for a database this build fully understands", async () => {
		await withDashboardDb(() => undefined, { dbPath });
		await expect(withReadonlyDashboardDb(dbHasUnknownMigrations, { dbPath })).resolves.toBe(false);
	});

	it("is true once a newer build has recorded a name this one lacks", async () => {
		// The replacement for comparing version numbers. A name is evidence; a number
		// was a proxy that moved only with DDL — it missed a newer build whose change
		// added no columns and fired for one whose additions this build reads fine.
		await withDashboardDb(() => undefined, { dbPath });
		await recordForeignMigration(dbPath, "2099-01-01-0000-from-the-future");
		await expect(withReadonlyDashboardDb(dbHasUnknownMigrations, { dbPath })).resolves.toBe(true);
	});

	it("is false when there is no log to read", async () => {
		// Deliberate direction: the callers use this to decline OPTIONAL work
		// (maintaining a derived cache), so an unreadable log must not stop work they
		// can perfectly well do. A database with a broken log has louder problems, and
		// they are reported elsewhere.
		const raw = await rawDb(dbPath);
		try {
			expect(dbHasUnknownMigrations(raw)).toBe(false);
		} finally {
			raw.close();
		}
	});
});

/**
 * The guard behind the rule "every entry survives being run twice".
 *
 * It is the only enforcement that scales: a regex over the SQL can catch a bare
 * `CREATE TABLE`, but not an `INSERT` without `OR IGNORE`, not an `UPDATE` whose
 * `WHERE` fails to exclude the rows it just wrote, and nothing at all inside a code
 * entry. Running each entry a second time and demanding the schema and row counts
 * are unchanged catches all of those, including in entries nobody has written yet.
 */
describe("every migration is re-runnable", () => {
	/** Schema + row counts: the two things a second run must not disturb. */
	function snapshot(db: DashboardDbHandle): string {
		const objects = db
			.prepare("SELECT type, name, COALESCE(sql, '') AS sql FROM sqlite_master ORDER BY type, name")
			.all() as ReadonlyArray<{ type: string; name: string; sql: string }>;
		const counts = objects
			.filter((o) => o.type === "table")
			.map((o) => {
				const row = db.prepare(`SELECT COUNT(*) AS n FROM "${o.name}"`).get() as { n: number };
				return `${o.name}=${row.n}`;
			});
		return JSON.stringify({ objects, counts });
	}

	for (const [slot, m] of MIGRATIONS.entries()) {
		it(`${m.name} changes nothing on a second run`, async () => {
			const raw = await rawDb(join(dir, `rerun-${slot}.db`));
			try {
				for (let s = 0; s < slot; s++) MIGRATIONS[s].run(raw);
				m.run(raw);
				const after = snapshot(raw);
				// The assertion: this must neither throw nor alter anything.
				expect(() => m.run(raw)).not.toThrow();
				expect(snapshot(raw)).toBe(after);
			} finally {
				raw.close();
			}
		});
	}
});

/**
 * The other half of "re-runnable", and the half the test above cannot reach.
 *
 * That one starts from an EMPTY database and compares the schema plus row COUNTS. Both
 * limits matter, and together they leave one shape of entry completely unguarded: a
 * backfill whose second run rewrites rows that are already correct. With no rows on
 * disk there is nothing for it to rewrite, and a rewrite that touches N rows and
 * inserts none leaves the count identical — so such an entry passes twice over.
 *
 * The entries that write DATA rather than schema are exactly the ones this covers:
 * today the four sync-stamp `UPDATE`s and the `context_kinds` seed (see
 * {@link dataWrittenTables}, which derives that set from the DDL rather than listing
 * it, so a future backfill cannot join the list unnoticed).
 *
 * The property asserted is the honest form: the FIRST run may change data — that is
 * what a backfill is for — and every run after it must change nothing. So the data is
 * seeded as the current writers leave it, the whole list is replayed in order, and
 * every row is compared by VALUE. Per-entry, so a failure names the culprit rather
 * than the list.
 *
 * ⚠ It also pins one thing the per-entry test structurally cannot: the schema after a
 * FULL replay. `BASELINE_DDL` re-creates the `repos_no_delete` trigger that
 * `REPOS_DELETE_ALLOWED_DDL` drops six entries later, so the schema legitimately
 * differs MID-replay and only the end state is a property worth asserting.
 *
 * ⚠ EVERY database here is `:memory:`, and that is a safety requirement rather than a
 * speed one — do not "simplify" it to the shared temp `dbPath`. This is the only test
 * in this file that INSERTS rows, so it is the only one whose bug could pollute a real
 * database with fabricated sessions and repos. A temp path is safe by CONVENTION (the
 * path is right, the cleanup runs); an in-memory database is safe by CONSTRUCTION —
 * there is no path to point at the wrong file, no `-wal` sidecar, and nothing left
 * behind if the process dies mid-test. The seeding tests need one connection and never
 * reopen, so the file buys them nothing to trade against that.
 */
describe("replaying every migration over populated data changes nothing", () => {
	/** See the ⚠ above: never a real or temp path. */
	const IN_MEMORY = ":memory:";

	/**
	 * Rows shaped the way the CURRENT writers leave them, which is what makes the
	 * assertion meaningful rather than merely true.
	 *
	 * Each backfill is `WHERE <stamp> = 0`, so a seed of nothing but non-zero stamps
	 * would satisfy every predicate vacuously. Every table therefore gets BOTH shapes:
	 * a normal row, and the one a completed backfill deliberately leaves at 0 (a row
	 * whose business time is itself 0 — "written before we tracked this"). That second
	 * row is the one whose re-run must be a no-op, and it is the only row that proves it.
	 *
	 * `SYNC_STAMP_NULL_BACKFILL_DDL`'s `IS NULL` clauses cannot be exercised from here
	 * and are not meant to be: those columns are `NOT NULL` on any schema built by this
	 * list, and the clause exists for databases a pre-log build left nullable (see its
	 * docblock). Reaching it would mean hand-building a database this build cannot
	 * produce.
	 */
	function seedWriterShapedRows(db: DashboardDbHandle): void {
		db.exec(`
INSERT INTO repos (id, repo_identity, repo_name, worktree_root, enabled_at)
     VALUES (1, 'local:seed', 'seed-repo', '/tmp/seed', '2026-08-01T00:00:00Z');
-- A normal session, and one whose own business time is 0.
INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms, written_at_ms)
     VALUES ('ev-normal', 1, 'claude', 's-normal', 1000, 1000),
            ('ev-zero',   1, 'claude', 's-zero',      0,       0);
INSERT INTO session_model_usage (session_event_id, model, updated_at_ms)
     VALUES ('ev-normal', 'claude-opus-5', 1000),
            ('ev-zero',   'claude-opus-5',    0);
INSERT INTO session_tool_use (session_event_id, tool_name, kind, calls, updated_at_ms)
     VALUES ('ev-normal', 'Read',  'builtin', 3, 1000),
            ('ev-zero',   'Write', 'builtin', 1,    0);
INSERT INTO recall_receipts (receipt_id, repo_id, at_ms, surface, hit, updated_at_ms)
     VALUES ('r-normal', 1, 500, 'cli', 1, 500),
            ('r-zero',   1,   0, 'cli', 0,   0);
`);
	}

	/** Every row of every table, by VALUE — what the count-only snapshot cannot see. */
	function dataSnapshot(db: DashboardDbHandle): string {
		const tables = (
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all() as ReadonlyArray<{ name: string }>
		).map((row) => row.name);
		const dump: Record<string, unknown> = {};
		for (const table of tables) {
			const columns = (
				db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as ReadonlyArray<{ name: string }>
			).map((row) => row.name);
			// Order by every column so the comparison cannot depend on row order.
			const order = columns.map((_, index) => index + 1).join(", ");
			dump[table] = db.prepare(`SELECT * FROM "${table}" ORDER BY ${order}`).all();
		}
		return JSON.stringify(dump);
	}

	/** The schema, for the end-of-replay assertion only. See the ⚠ above. */
	function schemaSnapshot(db: DashboardDbHandle): string {
		return JSON.stringify(
			db.prepare("SELECT type, name, COALESCE(sql, '') AS sql FROM sqlite_master ORDER BY type, name").all(),
		);
	}

	it("leaves every seeded row byte-identical, entry by entry", async () => {
		const raw = await rawDb(IN_MEMORY);
		try {
			for (const migration of MIGRATIONS) migration.run(raw);
			seedWriterShapedRows(raw);
			const dataBefore = dataSnapshot(raw);
			const schemaBefore = schemaSnapshot(raw);
			for (const migration of MIGRATIONS) {
				migration.run(raw);
				expect(dataSnapshot(raw), `${migration.name} changed data on a replay`).toBe(dataBefore);
			}
			// Only after the WHOLE list: the trigger BASELINE_DDL re-creates is dropped
			// again by REPOS_DELETE_ALLOWED_DDL, so mid-replay divergence is expected.
			expect(schemaSnapshot(raw), "a full replay changed the schema").toBe(schemaBefore);
		} finally {
			raw.close();
		}
	});

	it("seeds every table the migrations write data to", async () => {
		// The anti-vacuity guard. Without it the test above passes forever on a seed
		// that stopped covering the tables a backfill touches — which is precisely how
		// the empty-database gap it was written to close came about.
		const raw = await rawDb(IN_MEMORY);
		try {
			for (const migration of MIGRATIONS) migration.run(raw);
			seedWriterShapedRows(raw);
			const written = await dataWrittenTables();
			expect(written.length).toBeGreaterThan(0);
			for (const table of written) {
				const row = raw.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
				expect(row.n, `${table} is written by a migration but has no seeded rows`).toBeGreaterThan(0);
			}
		} finally {
			raw.close();
		}
	});
});

/**
 * Every table any DDL statement writes DATA to, derived by scanning source text.
 *
 * Derived rather than listed for the reason this repo keeps re-learning: a hand-kept
 * list of "the tables with backfills" goes stale silently, and the failure is a test
 * that still passes. The SQL used to live entirely in `SotSchema.ts`'s exported
 * string constants; now it lives one entry per file under `migrations/`, and not
 * every backfill is an EXPORTED string there — `applySessionStatsSchema` execs
 * template literals that are local `const`s of their own module
 * (`2026-08-18-0000-session-stats-sync.ts`'s `SYNC_STAMP_ZERO_BACKFILL_SQL` and
 * friends), invisible to an `import()` + `Object.values` scan. So this reads the
 * raw SOURCE TEXT of every migration file instead of importing it — a scan of
 * `DbMigration.sql` alone would miss every code entry's backfill, exported or not.
 *
 * Two things the scan must not mistake for a write, both of which it did on the first
 * attempt. Comment lines are dropped, because the prose around these statements says
 * things like "`DELETE FROM stats_daily` is therefore always safe" and a scan that
 * believed it would demand a seed for a table no migration writes — dropping `--`
 * SQL comments is not enough on its own any more, since the surrounding TypeScript
 * docblocks use `*` / `//`, so those are dropped too. And a match must begin a LINE:
 * `ON UPDATE CASCADE` is a referential action, not a statement, and a bare `UPDATE`
 * alternative captured `CASCADE` as a table name. Anchoring is what distinguishes
 * them — every real statement in this DDL starts its own line, while
 * `ON UPDATE` / `ON DELETE` is always preceded by its `ON`.
 */
async function dataWrittenTables(): Promise<ReadonlyArray<string>> {
	const migrationsDir = join(import.meta.dirname, "migrations");
	const sources = readdirSync(migrationsDir)
		.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
		.map((f) => readFileSync(join(migrationsDir, f), "utf8"));
	const found = new Set<string>();
	for (const source of sources) {
		const sql = source
			.split("\n")
			.filter((line) => !/^\s*(--|\/\/|\*)/.test(line))
			.join("\n");
		const statement = /^\s*(?:UPDATE|DELETE\s+FROM|INSERT(?:\s+OR\s+\w+)?\s+INTO)\s+([a-z_]+)/gim;
		for (const match of sql.matchAll(statement)) found.add(match[1]);
	}
	return [...found].sort();
}

/**
 * Companion tests for the entries that carry no `sql` now live BESIDE their entry —
 * one `<same-file-name>.test.ts` per code entry under `migrations/` — since every
 * entry now has its own file. See `migrations/index.ts`'s import list for which
 * file backs which entry. `MigrationFingerprints.test.ts`'s "requires a companion
 * test" check looks for that sibling file, not for a mention in this one.
 */

/**
 * A handle whose `schema_migrations` reads misbehave in specific ways — for the
 * defensive edges of the log probes that a real SQLite file never reaches.
 */
function fakeMigrationHandle(opts: {
	orderByThrows?: boolean;
	countGet?: () => unknown;
	countThrows?: boolean;
}): DashboardDbHandle {
	return {
		exec: () => undefined,
		close: () => undefined,
		prepare: (sql: string) => ({
			all: () => {
				if (sql.includes("ORDER BY seq") && opts.orderByThrows) throw new Error("boom read");
				return [];
			},
			get: () => {
				if (sql.includes("COUNT(*)")) {
					if (opts.countThrows) throw new Error("cannot count");
					return opts.countGet ? opts.countGet() : { n: 0 };
				}
				return undefined;
			},
			run: () => undefined,
		}),
	};
}

describe("migration-log probe edges", () => {
	it("treats a COUNT that returns no row as 'absent' — the (row?.n ?? 0) fallback", () => {
		// migrationLogTableExists' nullish guard: SQLite's COUNT(*) always yields a row,
		// so only a misbehaving handle reaches `row` undefined — and it must read as
		// absent, not throw. Driven through readMigrationLogState, whose ORDER BY read
		// throws first so the existence probe runs.
		const state = readMigrationLogState(fakeMigrationHandle({ orderByThrows: true, countGet: () => undefined }));
		expect(state.kind).toBe("none");
	});

	it("keeps the newest row per name when an unknown name repeats, and warns once", () => {
		// latestByName's `seen` branch: a name appearing twice makes the second
		// iteration compare `row.seq > seen.seq`. Verified via the unknown-name warn,
		// which also exercises the once-per-process de-dup (`if (has(name)) continue`)
		// on the second verify.
		const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			return withDashboardDb(() => undefined, { dbPath }).then(async () => {
				const raw = await rawDb(dbPath);
				try {
					const name = "AGENT7_REPEAT_UNKNOWN_DDL";
					for (const seq of [900, 901]) {
						raw.prepare(
							`INSERT INTO schema_migrations (seq, slot, name, outcome, applied_by, applied_at_ms, duration_ms, ddl)
							 VALUES (?, 0, ?, 'applied', 'other/1.0', 0, 0, 'x')`,
						).run(seq, name);
					}
					expect(() => verifyMigrationLog(raw)).not.toThrow();
					// Second pass: the name is now in the warned set, so the unknown-name
					// loop hits its `continue`.
					expect(() => verifyMigrationLog(raw)).not.toThrow();
				} finally {
					raw.close();
				}
			});
		} finally {
			spy.mockRestore();
		}
	});

	it("keeps the highest-seq row per name even when rows arrive newest-first", () => {
		// latestByName must keep the greatest `seq`, not the last one iterated — so a
		// handle that hands back a repeated name in DESCENDING seq order exercises the
		// `row.seq > seen.seq` FALSE arm (keep the one already held).
		const dupRow = (seq: number): MigrationLogRow => ({
			seq,
			slot: 1,
			name: "RECALL_RECEIPTS_DDL",
			outcome: "applied",
			applied_by: "other/1.0",
			applied_at_ms: 0,
			duration_ms: 0,
			ddl: MIGRATIONS[1].sql ?? "",
		});
		const rows = [dupRow(10), dupRow(5)];
		const fake: DashboardDbHandle = {
			exec: () => undefined,
			close: () => undefined,
			prepare: (sql: string) => ({
				all: () => (sql.includes("ORDER BY seq") ? rows : []),
				get: () => undefined,
				run: () => undefined,
			}),
		};
		expect(() => verifyMigrationLog(fake)).not.toThrow();
	});

	it("readAppliedMigrationNames ignores rows that are neither applied nor baseline", async () => {
		// The `outcome === 'applied' || outcome === 'baseline'` guard, FALSE arm: a
		// `failed` row must not count as run, so isSchemaCurrent still sees that name as
		// missing.
		await withDashboardDb(() => undefined, { dbPath });
		const raw = await rawDb(dbPath);
		try {
			raw.prepare("DELETE FROM schema_migrations WHERE name = ?").run("TOOL_CALL_TIME_DDL");
			raw.prepare(
				`INSERT INTO schema_migrations (slot, name, outcome, applied_by, applied_at_ms, duration_ms, ddl)
				 VALUES (4, 'TOOL_CALL_TIME_DDL', 'failed', 'other/1.0', 0, 0, 'x')`,
			).run();
			// The name has only a `failed` row now, so the schema reads as not current.
			expect(isSchemaCurrent(raw)).toBe(false);
		} finally {
			raw.close();
		}
	});
});

describe("verifyMigrationLog unreadable-log warn (once per process, both shapes)", () => {
	// The once-per-process guard means only ONE of the two ternary arms can run per
	// module instance, so each is driven against a freshly re-imported module whose
	// warned-set is empty.
	async function freshModule(): Promise<typeof import("./DashboardDb.js")> {
		vi.resetModules();
		return import("./DashboardDb.js");
	}
	function unreadableHandle(tableConfirmed: boolean): DashboardDbHandle {
		return {
			exec: () => undefined,
			close: () => undefined,
			prepare: (sql: string) => ({
				all: () => {
					if (sql.includes("ORDER BY seq")) throw new Error("boom read");
					return [];
				},
				get: () => {
					if (sql.includes("COUNT(*)")) {
						if (!tableConfirmed) throw new Error("cannot count");
						return { n: 1 };
					}
					return undefined;
				},
				run: () => undefined,
			}),
		};
	}

	afterEach(() => {
		vi.resetModules();
	});

	it("warns 'exists but could not be read' when the table is confirmed present", async () => {
		const mod = await freshModule();
		const lines: string[] = [];
		const spy = vi
			.spyOn(console, "warn")
			.mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
		try {
			expect(() => mod.verifyMigrationLog(unreadableHandle(true))).not.toThrow();
		} finally {
			spy.mockRestore();
		}
		expect(lines.filter((l) => l.includes("exists but could not be read"))).toHaveLength(1);
	});

	it("warns 'could not be queried' when even the existence probe fails", async () => {
		const mod = await freshModule();
		const lines: string[] = [];
		const spy = vi
			.spyOn(console, "warn")
			.mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
		try {
			expect(() => mod.verifyMigrationLog(unreadableHandle(false))).not.toThrow();
		} finally {
			spy.mockRestore();
		}
		expect(lines.filter((l) => l.includes("could not be queried for its migration log"))).toHaveLength(1);
	});
});

describe("openDb gating and retry", () => {
	it("throws DashboardRuntimeError when the runtime is below the SQLite floor", async () => {
		// The `!canUseDashboardDb()` guard at the top of every open. Driven by faking the
		// running Node version below 22.13 for one call.
		const realVersions = process.versions;
		Object.defineProperty(process, "versions", {
			value: { ...realVersions, node: "18.19.0" },
			configurable: true,
		});
		try {
			await expect(withReadonlyDashboardDb(() => undefined, { dbPath })).rejects.toBeInstanceOf(
				DashboardRuntimeError,
			);
		} finally {
			Object.defineProperty(process, "versions", { value: realVersions, configurable: true });
		}
	});

	it("retries a locked open with backoff, then gives up after maxAttempts", async () => {
		// The `SQLITE_BUSY` retry loop: a DatabaseSync that always reports a locked
		// database exercises the backoff sleep (attempt < maxAttempts) and the final
		// throw (attempt >= maxAttempts). Mocked node:sqlite, scoped to a fresh module
		// so the real one keeps serving every other test.
		vi.resetModules();
		let attempts = 0;
		vi.doMock("node:sqlite", () => ({
			DatabaseSync: class {
				constructor() {
					attempts += 1;
					throw new Error("SQLITE_BUSY: database is locked");
				}
			},
		}));
		try {
			const mod = await import("./DashboardDb.js");
			await expect(
				mod.withReadonlyDashboardDb(() => undefined, { dbPath, maxAttempts: 2, baseDelayMs: 1 }),
			).rejects.toThrow(/database is locked/);
			// One retry (the backoff timer) plus the final attempt.
			expect(attempts).toBe(2);
		} finally {
			vi.doUnmock("node:sqlite");
			vi.resetModules();
		}
	});
});

describe("isSchemaCurrent / ensureDashboardDbExists", () => {
	it("falls back to the version stamp when there is no readable log", async () => {
		// readAppliedMigrationNames returns undefined (no schema_migrations table), so
		// isSchemaCurrent answers off the version stamp — 0 here, below this build.
		const raw = await rawDb(dbPath);
		try {
			expect(isSchemaCurrent(raw)).toBe(false);
		} finally {
			raw.close();
		}
	});

	it("counts 'baseline' rows as applied when deciding the schema is current", async () => {
		// binary-expr for `outcome === 'applied' || outcome === 'baseline'` in
		// readAppliedMigrationNames. The row is staged by hand: nothing writes that
		// outcome any more, but 0.99.12/0.99.13 did, so a database whose only record of
		// an entry is a baseline row is a real state — and reading it as anything but
		// "done" would replay that entry on every open for ever.
		await withDashboardDb(() => undefined, { dbPath });
		const raw = await rawDb(dbPath);
		try {
			raw.prepare("DELETE FROM schema_migrations WHERE name = ?").run("BASELINE_DDL");
			raw.prepare(
				`INSERT INTO schema_migrations (slot, name, outcome, applied_by, applied_at_ms, duration_ms, ddl)
				 VALUES (0, 'BASELINE_DDL', 'baseline', 'old/0.99.12', 0, 0, '')`,
			).run();
			expect(isSchemaCurrent(raw)).toBe(true);
		} finally {
			raw.close();
		}
	});

	it("ensureDashboardDbExists creates a fresh database when none exists", async () => {
		// `isSchemaCurrent`, not a version: nothing writes `schema_version` any more, so
		// the log is the only thing that can say the file arrived at this build's schema.
		const fresh = join(dir, "fresh-ensure.db");
		expect(existsSync(fresh)).toBe(false);
		await ensureDashboardDbExists({ dbPath: fresh });
		await expect(withReadonlyDashboardDb(isSchemaCurrent, { dbPath: fresh })).resolves.toBe(true);
	});

	it("ensureDashboardDbExists returns early when the existing database is already current", async () => {
		await withDashboardDb(() => undefined, { dbPath });
		// No throw and no change: the current-schema short-circuit is taken.
		await expect(ensureDashboardDbExists({ dbPath })).resolves.toBeUndefined();
		await expect(withReadonlyDashboardDb(isSchemaCurrent, { dbPath })).resolves.toBe(true);
	});

	it("ensureDashboardDbExists migrates an existing but stale database", async () => {
		// existsSync is true but isSchemaCurrent is false (a legacy pre-log DB at v5), so
		// it falls through to the writable open that migrates the rest of the way. The
		// leftover stamp stays at 5 for ever — it is evidence about the past, not state
		// this build maintains — so the log is what the assertion has to read.
		await buildLegacyDb(dbPath, 5);
		await expect(withReadonlyDashboardDb(isSchemaCurrent, { dbPath })).resolves.toBe(false);
		await ensureDashboardDbExists({ dbPath });
		await expect(withReadonlyDashboardDb(isSchemaCurrent, { dbPath })).resolves.toBe(true);
	});

	it("ensureDashboardDbExists resolves the machine path when no dbPath is given", async () => {
		// The `opts.dbPath ?? getDashboardDbPath()` fallback in both ensureDashboardDbExists
		// and openDb. The home directory is redirected into the temp dir so the
		// machine-global path lands there instead of the developer's real config dir.
		//
		// ⚠ Through `withIsolatedHome`, never a hand-rolled `process.env.HOME = …`: that
		// is isolation on POSIX and a no-op on win32, where `os.homedir()` reads
		// USERPROFILE instead. This test had the hand-rolled form, so on Windows it
		// resolved the DEVELOPER'S real `~/.jolli/jollimemory/jollimemory.db` and ran
		// `ensureDashboardDbExists` against it — migrations included — before failing on
		// an assertion about the path. CI is ubuntu, so nothing caught it.
		//
		// The path is also asserted BEFORE anything is created, which is the other half:
		// a future platform whose variable the helper does not set becomes a red test
		// rather than a write to real data.
		const home = join(dir, "home");
		await withIsolatedHome(home, async () => {
			expect(getDashboardDbPath().startsWith(home)).toBe(true);
			await ensureDashboardDbExists();
			expect(existsSync(getDashboardDbPath())).toBe(true);
		});
	});

	const itPosix = it.skipIf(process.platform === "win32");

	itPosix("ensureDashboardDbExists returns quietly when an existing file cannot be opened", async () => {
		// The catch that swallows an unreadable existing database: `existsSync` is true,
		// but the read-only probe throws (permission denied), so the function returns
		// without trying to create/migrate — that is the caller's own open to surface.
		await withDashboardDb(() => undefined, { dbPath });
		chmodSync(dbPath, 0o000);
		try {
			await expect(ensureDashboardDbExists({ dbPath })).resolves.toBeUndefined();
		} finally {
			chmodSync(dbPath, 0o600);
		}
	});
});

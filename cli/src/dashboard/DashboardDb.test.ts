import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BUSY_TIMEOUT_BY_ROLE,
	canUseDashboardDb,
	DASHBOARD_SCHEMA_VERSION,
	type DashboardDbHandle,
	DashboardRuntimeError,
	DEFAULT_BUSY_TIMEOUT_MS,
	findDriftedMigrations,
	getDashboardDbPath,
	inTransaction,
	MIGRATIONS,
	type MigrationLogRow,
	migrateDashboardDb,
	readMigrationLog,
	readMigrationLogState,
	readSchemaVersion,
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

/** Stamps `schema_version` directly — the way a newer build would leave it. */
async function stampSchema(path: string, version: number): Promise<void> {
	const raw = await rawDb(path);
	try {
		raw.prepare(
			`INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		).run(String(version));
	} finally {
		raw.close();
	}
}

/**
 * A database as an OLDER build left it: the first `upTo` entries applied, the
 * version stamped, and no migration log — the state every existing install is in
 * when it first meets the log. Executes the exported entries rather than copying
 * their DDL, which would drift.
 */
async function buildLegacyDb(path: string, upTo: number): Promise<void> {
	const raw = await rawDb(path);
	try {
		for (let slot = 0; slot < upTo; slot++) raw.exec(MIGRATIONS[slot].ddl);
		raw.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(upTo));
	} finally {
		raw.close();
	}
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
	it("creates the schema on first open and reports the current version", async () => {
		const version = await withDashboardDb((db) => readSchemaVersion(db), { dbPath });
		expect(version).toBe(DASHBOARD_SCHEMA_VERSION);
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
		// Would throw on CREATE TABLE collisions if migrations re-ran unguarded.
		const version = await withDashboardDb((db) => readSchemaVersion(db), { dbPath });
		expect(version).toBe(DASHBOARD_SCHEMA_VERSION);
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

	it("ends at the version this build declares", async () => {
		// Against the CONSTANT, never a literal: a literal here is a second place to
		// remember on every append, and `MigrationFingerprints.test.ts` already pins
		// the constant to `MIGRATIONS.length`. What this adds is that a real database
		// actually arrives there — the fingerprint test never opens one.
		const version = await withDashboardDb((db) => readSchemaVersion(db), { dbPath });
		expect(version).toBe(DASHBOARD_SCHEMA_VERSION);
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

describe("readSchemaVersion / migrateDashboardDb", () => {
	it("treats a database without schema_meta as version 0", async () => {
		const { DatabaseSync } = await import("node:sqlite");
		const raw = new DatabaseSync(join(dir, "fresh.db")) as unknown as DashboardDbHandle;
		try {
			expect(readSchemaVersion(raw)).toBe(0);
			migrateDashboardDb(raw);
			expect(readSchemaVersion(raw)).toBe(DASHBOARD_SCHEMA_VERSION);
			// Second call: no-op.
			migrateDashboardDb(raw);
			expect(readSchemaVersion(raw)).toBe(DASHBOARD_SCHEMA_VERSION);
		} finally {
			raw.close();
		}
	});

	it("treats a garbage schema_version value as version 0", async () => {
		const { DatabaseSync } = await import("node:sqlite");
		const raw = new DatabaseSync(join(dir, "garbage.db")) as unknown as DashboardDbHandle;
		try {
			raw.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT)");
			raw.exec("INSERT INTO schema_meta VALUES ('schema_version', 'not-a-number')");
			expect(readSchemaVersion(raw)).toBe(0);
		} finally {
			raw.close();
		}
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
			expect(readSchemaVersion(real)).toBe(DASHBOARD_SCHEMA_VERSION);
		} finally {
			real.close();
		}
	});
});

describe("schema creation", () => {
	it("is idempotent — a second open of a current file changes nothing", async () => {
		await withDashboardDb(() => undefined, { dbPath });
		const before = await withDashboardDb((db) => readSchemaVersion(db), { dbPath });
		const after = await withDashboardDb((db) => readSchemaVersion(db), { dbPath });
		expect(before).toBe(after);
		expect(after).toBe(DASHBOARD_SCHEMA_VERSION);
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
		for (let slot = 0; slot < stampIndex; slot++) raw.exec(MIGRATIONS[slot].ddl);
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
			expect(readSchemaVersion(raw)).toBe(DASHBOARD_SCHEMA_VERSION);
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
			expect(readSchemaVersion(raw)).toBe(DASHBOARD_SCHEMA_VERSION);
		} finally {
			raw.close();
		}
	});
});

describe("transactional migration runner", () => {
	it("rolls a failed entry back — the version does not move and a retry succeeds", async () => {
		// A conflicting object makes the entry fail part-way through, after it has
		// already created earlier tables inside the transaction.
		const { DatabaseSync } = await import("node:sqlite");
		{
			const raw = new DatabaseSync(dbPath) as unknown as DashboardDbHandle;
			try {
				raw.exec("CREATE TABLE memories (wrong TEXT)");
			} finally {
				raw.close();
			}
		}

		await expect(withDashboardDb(() => undefined, { dbPath })).rejects.toThrow(/memories/);

		// Nothing half-applied: the rollback took the tables the entry had already
		// created with it, and the version never moved off 0.
		const raw = new DatabaseSync(dbPath) as unknown as DashboardDbHandle;
		try {
			expect(readSchemaVersion(raw)).toBe(0);
			expect(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'repos'").get()).toEqual({ n: 0 });
			raw.exec("DROP TABLE memories");
		} finally {
			raw.close();
		}

		// With the obstacle gone the same file migrates cleanly.
		expect(await withDashboardDb((db) => readSchemaVersion(db), { dbPath })).toBe(DASHBOARD_SCHEMA_VERSION);
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

	it("NEVER refuses a database, however far ahead its format is", async () => {
		// The assertion the whole change exists for. Measured before it: five MCP
		// servers, the dashboard server and the VS Code extension host all died on
		// the same error for a schema bump that added two tables and five nullable
		// columns. There is no gate left — not a version one, not a floor one.
		await withDashboardDb(() => undefined, { dbPath });
		await stampSchema(dbPath, DASHBOARD_SCHEMA_VERSION + 3);
		await expect(withDashboardDb((db) => readSchemaVersion(db), { dbPath })).resolves.toBe(
			DASHBOARD_SCHEMA_VERSION + 3,
		);
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

	it("writes no compatibility floor key at all", async () => {
		// Two keys were tried and removed (`min_compatible_version`, then
		// `min_compatible_release`). Their absence is pinned so neither comes back by
		// accident: a floor a build cannot see is worse than no floor, and this
		// database is not where cross-surface compatibility is decided.
		await withDashboardDb(() => undefined, { dbPath });
		const keys = await withReadonlyDashboardDb(
			(db) => (db.prepare("SELECT key FROM schema_meta").all() as Array<{ key: string }>).map((r) => r.key),
			{ dbPath },
		);
		expect(keys).toContain("schema_version");
		expect(keys.filter((k) => k.includes("compatible"))).toEqual([]);
	});

	it("warns ONCE per process about a format it cannot fully read", async () => {
		// This path is on the git hook, so a warn per open would flood the log. The
		// counter is module-scoped and keyed by the version, so the second open of the
		// same file is silent.
		await withDashboardDb(() => undefined, { dbPath });
		await stampSchema(dbPath, DASHBOARD_SCHEMA_VERSION + 1);
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
		const ahead = lines.filter((l) => l.includes("not visible here"));
		expect(ahead).toHaveLength(1);
		// Names the surface: six kinds of process share one debug.log, so a line that
		// says only "this build" cannot answer which of them could not see the data.
		expect(ahead[0]).toMatch(/\(([a-z-]+\/\S+)\)/);
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

	it("stores the DDL verbatim, so the log answers 'what actually ran' offline", async () => {
		await withDashboardDb(() => undefined, { dbPath });
		const rows = await readLog(dbPath);
		for (const row of rows ?? []) {
			expect(row.ddl).toBe(MIGRATIONS[row.slot].ddl);
		}
	});

	it("seeds a pre-log database as 'baseline', not as 'applied'", async () => {
		await buildLegacyDb(dbPath, 5);
		await withDashboardDb(() => undefined, { dbPath });
		const rows = await readLog(dbPath);
		const seeded = rows?.filter((r) => r.outcome === "baseline");
		// One per entry the version stamp claims, named from THIS build's list —
		// which is a guess, and says so in the outcome rather than posing as an
		// observation.
		expect(seeded?.map((r) => r.name)).toEqual(MIGRATIONS.slice(0, 5).map((m) => m.name));
		// Everything from the version stamp onward really ran — starting with the
		// entry that created the table — and those rows come after the seeds, so
		// `seq` order still reads as history. Derived from MIGRATIONS rather than
		// spelled out: a hardcoded tail breaks on the next append for no reason.
		const observed = rows?.filter((r) => r.outcome === "applied");
		expect(observed?.map((r) => r.name)).toEqual(MIGRATIONS.slice(5).map((m) => m.name));
		expect(observed?.[0]?.seq).toBeGreaterThan(seeded?.[4]?.seq ?? 0);
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
		// And the version stamp was not dragged backwards to the re-applied slot.
		await expect(withReadonlyDashboardDb(readSchemaVersion, { dbPath })).resolves.toBe(DASHBOARD_SCHEMA_VERSION);
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
			// A monotone clock that, the instant this pass has applied every pre-log entry
			// (the version stamp has reached the log slot) but not yet created the log table,
			// stands in for the rival: it creates the table and records slots logSlot..end,
			// leaving the earlier slots unrecorded so this pass's held rows are their only
			// evidence. `startedAt = now()` runs before this pass's BEGIN IMMEDIATE, so the
			// file is unlocked here and the rival's writes commit cleanly.
			let t = 1;
			const now = (): number => {
				if (!rivalRan && !logTableExists() && readSchemaVersion(raw) >= logSlot) {
					rivalRan = true;
					for (let s = logSlot; s < MIGRATIONS.length; s++) raw.exec(MIGRATIONS[s].ddl);
					for (let s = logSlot; s < MIGRATIONS.length; s++) {
						raw.prepare(
							"INSERT INTO schema_migrations (slot, name, outcome, applied_by, applied_at_ms, duration_ms, ddl) VALUES (?, ?, 'applied', 'rival/1.0', 0, 0, ?)",
						).run(s, MIGRATIONS[s].name, MIGRATIONS[s].ddl);
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

	it("pins DASHBOARD_SCHEMA_VERSION to MIGRATIONS.length", () => {
		// A hand-maintained literal — it cannot be written `= MIGRATIONS.length` in place,
		// as that array is declared later in the file and the reference would hit the TDZ.
		// This pins the two together: appending a migration without bumping the version, or
		// two branches that each append one, fails HERE instead of silently on disk.
		expect(DASHBOARD_SCHEMA_VERSION).toBe(MIGRATIONS.length);
	});

	it("keeps a 'failed' row even though the transaction rolled back", async () => {
		// Written after the ROLLBACK, outside the transaction, or it would vanish
		// with the change it describes — and most callers of withDashboardDb swallow
		// the exception, so this row can be the only evidence a user ever has.
		await withDashboardDb(() => undefined, { dbPath });
		const raw = await rawDb(dbPath);
		try {
			raw.prepare("DELETE FROM schema_migrations WHERE name = ?").run("TOOL_CALL_TIME_DDL");
			// The column is still there, so re-applying the entry dies on duplicate.
			expect(() => migrateDashboardDb(raw, { appliedBy: "test/1.0" })).toThrow();
			const rows = readMigrationLog(raw);
			const failed = rows?.filter((r) => r.outcome === "failed");
			expect(failed?.map((r) => r.name)).toEqual(["TOOL_CALL_TIME_DDL"]);
			expect(failed?.[0]?.applied_by).toBe("test/1.0");
		} finally {
			raw.close();
		}
	});

	it("WARNS about drifted DDL and keeps working — never refuses the database", async () => {
		// It used to throw. Two measurements killed that: the comparison is byte-exact
		// while 64% of the baseline entry is SQL comments (22,967 of 35,673 chars), so
		// re-wrapping a comment would have made every existing database refuse writes;
		// and `MigrationFingerprints.test.ts` already fails on such an edit in CI, on
		// the author's machine, before it can ship.
		await withDashboardDb(() => undefined, { dbPath });
		const raw = await rawDb(dbPath);
		try {
			raw.prepare("UPDATE schema_migrations SET ddl = ? WHERE name = ?").run(
				"-- something another branch shipped",
				"RECALL_RECEIPTS_DDL",
			);
		} finally {
			raw.close();
		}
		const lines: string[] = [];
		const spy = vi
			.spyOn(console, "warn")
			.mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
		try {
			await expect(withDashboardDb(() => "ok", { dbPath })).resolves.toBe("ok");
		} finally {
			spy.mockRestore();
		}
		const drift = lines.filter((l) => l.includes("DIFFERENT DDL"));
		// Named, attributed, and pointed at the report — once per name per process.
		expect(drift).toHaveLength(1);
		expect(drift[0]).toContain("RECALL_RECEIPTS_DDL");
		expect(drift[0]).toContain("jolli doctor --schema-log");
		expect(drift[0]).toMatch(/\(([a-z-]+\/\S+)\)/);
	});

	it("still REPORTS drift for the doctor listing", async () => {
		// The warn is per-process; the report has to work on any handle at any time.
		await withDashboardDb(() => undefined, { dbPath });
		const raw = await rawDb(dbPath);
		try {
			raw.prepare("UPDATE schema_migrations SET ddl = 'drifted' WHERE name = ?").run("SKILL_CONTEXT_KIND_DDL");
			expect(() => verifyMigrationLog(raw)).not.toThrow();
			expect(findDriftedMigrations(raw).map((r) => r.name)).toEqual(["SKILL_CONTEXT_KIND_DDL"]);
		} finally {
			raw.close();
		}
	});

	it("keeps reporting drift when a LATER non-applied row exists under the same name", async () => {
		// The whole reason the drift key is "newest APPLIED row", not "newest row". A
		// reachable sequence: an older build really applies drifted DDL, then a later
		// writer stale-reads the name as missing (or steps over it for any other reason)
		// and appends `skipped` carrying this build's DDL. Keyed off the newest row of any
		// outcome, that row buries the applied one and BOTH the runtime warning and
		// `doctor --schema-log` go quiet about a schema that still differs.
		await withDashboardDb(() => undefined, { dbPath });
		const raw = await rawDb(dbPath);
		try {
			raw.prepare("UPDATE schema_migrations SET ddl = 'what the older build ran' WHERE name = ?").run(
				"SKILL_CONTEXT_KIND_DDL",
			);
			raw.prepare(
				`INSERT INTO schema_migrations (slot, name, outcome, applied_by, applied_at_ms, duration_ms, ddl)
				 VALUES (0, 'SKILL_CONTEXT_KIND_DDL', 'skipped', 'test/1.0', 0, 0, 'this build''s DDL')`,
			).run();
			const drifted = findDriftedMigrations(raw);
			expect(drifted.map((r) => r.name)).toEqual(["SKILL_CONTEXT_KIND_DDL"]);
			// And it is the APPLIED row that is reported — the one that says what the
			// schema was actually built from.
			expect(drifted[0]?.outcome).toBe("applied");
			expect(drifted[0]?.ddl).toBe("what the older build ran");
		} finally {
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

	it("passes a name with no row, and a seeded row, rather than guessing about them", async () => {
		await buildLegacyDb(dbPath, 5);
		await withDashboardDb(() => undefined, { dbPath });
		const raw = await rawDb(dbPath);
		try {
			// Seeded rows are inference, so comparing DDL against them would report
			// drift nobody observed. Rows deleted outright are simply unknown.
			raw.prepare(
				"UPDATE schema_migrations SET ddl = 'whatever the old build ran' WHERE outcome = 'baseline'",
			).run();
			expect(() => verifyMigrationLog(raw)).not.toThrow();
			raw.prepare("DELETE FROM schema_migrations WHERE name = ?").run("SCHEMA_MIGRATIONS_DDL");
			expect(() => verifyMigrationLog(raw)).not.toThrow();
		} finally {
			raw.close();
		}
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
		await stampSchema(dbPath, 999);
		await expect(withRepairDashboardDb(() => "ok", { dbPath })).resolves.toBe("ok");
	});

	it("does not migrate, so it cannot repair by moving the thing under repair", async () => {
		await buildLegacyDb(dbPath, 5);
		await withRepairDashboardDb(() => undefined, { dbPath });
		await expect(withReadonlyDashboardDb(readSchemaVersion, { dbPath })).resolves.toBe(5);
	});
});

describe("edges of the version reader", () => {
	it("reads a database with no schema_meta at all as version 0", async () => {
		const raw = await rawDb(dbPath);
		try {
			expect(readSchemaVersion(raw)).toBe(0);
		} finally {
			raw.close();
		}
	});

	it("skips silently when a rival bumps the version of a PRE-LOG database", async () => {
		// The one skip that cannot be recorded: there is no log table yet, so the
		// version stamp is both the fence and the only evidence. Staged by making the
		// in-lock version read (the second one) answer higher, which is exactly what a
		// rival writer's commit looks like from inside BEGIN IMMEDIATE.
		await buildLegacyDb(dbPath, 5);
		const raw = await rawDb(dbPath);
		try {
			let versionReads = 0;
			const patched: DashboardDbHandle = {
				exec: (sql) => raw.exec(sql),
				close: () => raw.close(),
				prepare: (sql) => {
					const stmt = raw.prepare(sql);
					if (!sql.includes("'schema_version'")) return stmt;
					return {
						all: (...p) => stmt.all(...p),
						run: (...p) => stmt.run(...p),
						get: (...p) => {
							versionReads += 1;
							return versionReads === 1 ? stmt.get(...p) : { value: "99" };
						},
					};
				},
			};
			migrateDashboardDb(patched, { appliedBy: "test/1.0" });
			// Nothing ran, and nothing claims to have: the log table still does not exist.
			expect(readMigrationLog(raw)).toBeUndefined();
		} finally {
			raw.close();
		}
	});
});

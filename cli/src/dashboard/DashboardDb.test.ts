import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BUSY_TIMEOUT_BY_ROLE,
	canUseDashboardDb,
	DASHBOARD_SCHEMA_VERSION,
	type DashboardDbHandle,
	DashboardRuntimeError,
	DashboardSchemaAheadError,
	DEFAULT_BUSY_TIMEOUT_MS,
	getDashboardDbPath,
	inTransaction,
	migrateDashboardDb,
	readSchemaVersion,
	withDashboardDb,
	withReadonlyDashboardDb,
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

	it("never deletes repo rows — the v7 policy trigger blocks it, disable is an UPDATE", async () => {
		const result = await withDashboardDb(
			(db) => {
				db.prepare(
					"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES ('r', 'r', '/r', 't')",
				).run();
				db.prepare(
					"INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms) VALUES ('e', (SELECT id FROM repos WHERE repo_identity = 'r'), 'claude', 's', 1)",
				).run();
				expect(() => db.prepare("DELETE FROM repos WHERE repo_identity = 'r'").run()).toThrow(/never deleted/i);
				// The sanctioned path: soft-disable in place, children untouched.
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

	it("refuses a database written by a newer build instead of guessing", async () => {
		await withDashboardDb(() => undefined, { dbPath });
		const { DatabaseSync } = await import("node:sqlite");
		const raw = new DatabaseSync(dbPath) as unknown as DashboardDbHandle;
		try {
			raw.exec(`UPDATE schema_meta SET value = '${DASHBOARD_SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`);
		} finally {
			raw.close();
		}
		await expect(withDashboardDb(() => undefined, { dbPath })).rejects.toThrow(DashboardSchemaAheadError);
		await expect(withDashboardDb(() => undefined, { dbPath })).rejects.toThrow(/delete that file/);
	});
});

describe("owner-only permissions (§11 defect 1)", () => {
	it("creates the directory 0700 and the database 0600", async () => {
		const nested = join(dir, "cfg");
		const target = join(nested, "dashboard.db");
		await withDashboardDb(() => undefined, { dbPath: target });

		expect(statSync(nested).mode & 0o777).toBe(0o700);
		expect(statSync(target).mode & 0o777).toBe(0o600);
	});

	it("tightens a database an older build left world-readable", async () => {
		await withDashboardDb(() => undefined, { dbPath });
		// Simulate the pre-fix state: 0644 file inside a 0755 directory.
		chmodSync(dbPath, 0o644);
		chmodSync(dir, 0o755);

		await withDashboardDb(() => undefined, { dbPath });

		expect(statSync(dbPath).mode & 0o777).toBe(0o600);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
	});

	it("leaves the WAL sidecars owner-only too", async () => {
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

	it("does not chmod on a read-only open — readers never touch permissions", async () => {
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

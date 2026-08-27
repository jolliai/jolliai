import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withDashboardDb } from "./DashboardDb.js";
import { SYNCED_COLUMNS } from "./SessionPushManifest.js";
import {
	businessTimeColumn,
	KEYSET_COLUMNS,
	SYNC_STAMP_COLUMNS,
	SYNC_STAMP_TABLES,
	syncStampColumn,
	WINDOW_SOURCES,
} from "./SyncColumns.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-synccols-"));
	dbPath = join(dir, "dashboard.db");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function columnsOf(table: string): Promise<string[]> {
	return withDashboardDb(
		(db) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name),
		{ dbPath },
	);
}

async function isNotNull(table: string, column: string): Promise<boolean> {
	return withDashboardDb(
		(db) =>
			(db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[]).some(
				(r) => r.name === column && r.notnull === 1,
			),
		{ dbPath },
	);
}

describe("sync stamp columns", () => {
	// The map is the only thing standing between a caller and `WHERE
	// updated_at_ms >= ?` against all five outbound tables — which compiles, runs, and
	// reads the wrong column on `sessions`. Pin every entry against the real
	// schema so a rename cannot pass silently.
	it("names a column that actually exists on each table", async () => {
		for (const table of SYNC_STAMP_TABLES) {
			expect(await columnsOf(table)).toContain(syncStampColumn(table));
		}
	});

	it("keeps sessions on its own name, because updated_at_ms is taken there", async () => {
		// Not cosmetic: `sessions.updated_at_ms` is the business clock, and the
		// commit-summary path deliberately does not bump it. Collapsing the two
		// names would put the sync back on the column that cannot see an
		// enrichment.
		expect(SYNC_STAMP_COLUMNS.sessions).toBe("written_at_ms");
		expect(await columnsOf("sessions")).toContain("updated_at_ms");
		expect(SYNC_STAMP_COLUMNS.sessions).not.toBe(businessTimeColumn("sessions"));
	});

	it("never points at a table's business time column", async () => {
		for (const table of SYNC_STAMP_TABLES) {
			const business = businessTimeColumn(table);
			if (business) expect(syncStampColumn(table)).not.toBe(business);
		}
	});

	it("names a business column that exists, where one is declared", async () => {
		for (const table of SYNC_STAMP_TABLES) {
			const business = businessTimeColumn(table);
			if (business) expect(await columnsOf(table)).toContain(business);
		}
	});

	// The first-run window has to reach EVERY synced table, and a table with no
	// clock of its own reaches it through the parent session. `WindowSource` is a
	// union so "neither" cannot be expressed at all — what is left to check is that
	// whichever column the entry names is real.
	it("names a real column on whichever side of the window it uses", async () => {
		for (const table of SYNC_STAMP_TABLES) {
			const source = WINDOW_SOURCES[table];
			if ("own" in source) {
				expect(await columnsOf(table)).toContain(source.own);
			} else {
				expect(await columnsOf(table)).toContain(source.parent);
				// The window resolves through `sessions.event_id`, so the parent column
				// has to be the one that points at it.
				expect(await columnsOf("sessions")).toContain("event_id");
			}
		}
	});

	// A NULL stamp is invisible to a cursor forever, so the migration backfills
	// every pre-existing row from its best available approximation. A fresh
	// database has no rows to check, so this asserts the shape the backfill
	// depends on: the two child tables can reach a parent timestamp.
	it("leaves the child tables able to reach their parent's clock", async () => {
		for (const table of ["session_model_usage", "session_tool_use"]) {
			expect(await columnsOf(table)).toContain("session_event_id");
		}
		expect(await columnsOf("sessions")).toContain("event_id");
	});

	// The other half of "a NULL stamp is invisible forever", and the half a
	// backfill cannot cover: `WHERE stamp >= ?` answers NULL — not false — for a
	// NULL stamp, so such a row is unselectable by every cursor there will ever
	// be. A nullable column would put that one orphaned child row (or one future
	// INSERT that forgets the field) permanently outside the sync with nothing
	// anywhere to report it, which is precisely the silent-wrong-set failure this
	// module exists to prevent.
	it("declares every stamp NOT NULL, so a cursor comparison is never NULL", async () => {
		for (const table of SYNC_STAMP_TABLES) {
			expect(await isNotNull(table, syncStampColumn(table))).toBe(true);
		}
		// The same rule on the two stamps that live outside the map.
		expect(await isNotNull("commits", "written_at_ms")).toBe(true);
		expect(await isNotNull("session_usage_events", "updated_at_ms")).toBe(true);
	});
});

describe("keyset columns", () => {
	/** The table's PRIMARY KEY, in key order, straight from SQLite. */
	async function primaryKeyOf(table: string): Promise<string[]> {
		return withDashboardDb(
			(db) =>
				(db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[])
					.filter((r) => r.pk > 0)
					.sort((a, b) => a.pk - b.pk)
					.map((r) => r.name),
			{ dbPath },
		);
	}

	it("is exactly each table's PRIMARY KEY, in key order", async () => {
		// Uniqueness is the whole property: the cursor is `(stamp, ...these)` and
		// paging only advances because that tuple cannot repeat. A subset of the PK
		// is not unique — two rows would share a cursor position and the page would
		// either stall or skip — and a superset is not what ORDER BY can index.
		// Order matters as much as membership: the SELECT's ORDER BY repeats these
		// columns, and a different order does not error, it silently pages over rows.
		for (const table of SYNC_STAMP_TABLES) {
			expect(KEYSET_COLUMNS[table]).toEqual(await primaryKeyOf(table));
		}
	});

	it("is carried on the wire, so the next cursor can be read off the row just sent", async () => {
		// The next cursor is taken from the LAST ROW of the page, which is the row
		// as it goes out. A key column missing from `SYNCED_COLUMNS` would be absent
		// there, `String(undefined ?? "")` would make it `""`, and the cursor would
		// silently rewind to the start of that millisecond every pass — the same
		// stall, arrived at from the other side.
		for (const table of SYNC_STAMP_TABLES) {
			for (const column of KEYSET_COLUMNS[table]) {
				expect(SYNCED_COLUMNS[table]).toContain(column);
			}
		}
	});

	it("covers every synced table", () => {
		expect(Object.keys(KEYSET_COLUMNS).sort()).toEqual([...SYNC_STAMP_TABLES].sort());
	});

	it("drives skill-invocation paging from the full keyset index", async () => {
		await withDashboardDb(
			(db) => {
				const plan = db
					.prepare(
						`EXPLAIN QUERY PLAN
						 SELECT * FROM skill_invocations t
						  WHERE (t.updated_at_ms, t.session_event_id, t.skill_name, t.at_ms) >= (?, ?, ?, ?)
						  ORDER BY t.updated_at_ms, t.session_event_id, t.skill_name, t.at_ms
						  LIMIT ?`,
					)
					.all(0, "", "", "", 500) as Array<{ detail: string }>;
				const details = plan.map((row) => row.detail).join("\n");
				expect(details).toContain("ix_si_keyset");
				expect(details).not.toMatch(/SCAN t|USE TEMP B-TREE/);
			},
			{ dbPath },
		);
	});
});

describe("sync stamps are never NULL", () => {
	// The invariant every cursor rests on, asserted rather than assumed.
	//
	// `WHERE (<stamp>, …) >= (?, …)` answers NULL — not true — for a NULL stamp,
	// so such a row is invisible to EVERY cursor for ever, and nothing reports it.
	// `SYNC_STAMP_DDL` declares these columns NOT NULL, but a database handed them
	// by a pre-log build records that entry as `baseline` and never applies the
	// declaration: measured on a real machine as 30 sessions, 201 tool-use rows and
	// 56 model-usage rows stuck permanently outside the channel.
	it("has a number in every stamp column after migration", async () => {
		await withDashboardDb(
			(db) => {
				db.prepare(
					`INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at)
				 VALUES ('r', 'r', '/w', 1)`,
				).run();
				db.prepare(
					`INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms)
				 VALUES ('e1', 1, 'claude', 's1', 1000)`,
				).run();
				db.prepare(
					`INSERT INTO session_model_usage (session_event_id, model) VALUES ('e1', 'claude-opus-5')`,
				).run();
				db.prepare(
					`INSERT INTO session_tool_use (session_event_id, tool_name, kind) VALUES ('e1', 'Read', 'builtin')`,
				).run();

				// A row inserted WITHOUT naming the stamp must still have one — that is
				// what `NOT NULL DEFAULT 0` buys, and what its absence took away.
				for (const table of SYNC_STAMP_TABLES) {
					const column = syncStampColumn(table);
					const nulls = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IS NULL`).get() as {
						n: number;
					};
					expect({ table, nulls: nulls.n }).toEqual({ table, nulls: 0 });
				}
			},
			{ dbPath },
		);
	});
});

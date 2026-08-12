import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withDashboardDb } from "./DashboardDb.js";
import { BUSINESS_TIME_COLUMNS, SYNC_STAMP_COLUMNS, SYNC_STAMP_TABLES, syncStampColumn } from "./SyncColumns.js";

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
	// updated_at_ms >= ?` against all four tables — which compiles, runs, and
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
		expect(SYNC_STAMP_COLUMNS.sessions).not.toBe(BUSINESS_TIME_COLUMNS.sessions);
	});

	it("never points at a table's business time column", async () => {
		for (const table of SYNC_STAMP_TABLES) {
			const business = BUSINESS_TIME_COLUMNS[table];
			if (business) expect(syncStampColumn(table)).not.toBe(business);
		}
	});

	it("names a business column that exists, where one is declared", async () => {
		for (const table of SYNC_STAMP_TABLES) {
			const business = BUSINESS_TIME_COLUMNS[table];
			if (business) expect(await columnsOf(table)).toContain(business);
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

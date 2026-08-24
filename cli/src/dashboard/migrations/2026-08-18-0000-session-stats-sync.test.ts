import { describe, expect, it } from "vitest";
import type { DashboardDbHandle } from "../DashboardDb.js";
import { MIGRATIONS } from "./index.js";

/** Raw handle — deliberately bypasses every gate `DashboardDb.ts` applies on open. */
async function rawDb(): Promise<DashboardDbHandle> {
	const { DatabaseSync } = await import("node:sqlite");
	return new DatabaseSync(":memory:") as unknown as DashboardDbHandle;
}

/** Column names of a table, for the add-column assertions. */
function columnsOf(db: DashboardDbHandle, table: string): ReadonlyArray<string> {
	const rows = db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as ReadonlyArray<{ name: string }>;
	return rows.map((r) => r.name);
}

/** Names of every object of one kind in the schema. */
function objectNames(db: DashboardDbHandle, type: "table" | "index"): ReadonlyArray<string> {
	const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name").all(type) as ReadonlyArray<{
		name: string;
	}>;
	return rows.map((r) => r.name);
}

/**
 * Every object the session-statistics schema owns, asserted one by one.
 *
 * `SESSION_STATS_SYNC_DDL` is a code entry, so no fingerprint covers its body and
 * this list is the only thing that pins what it produces — which is why it names
 * every object rather than asserting "it did not throw". Required by
 * `MigrationFingerprints.test.ts` — see the same note in `EVENT_FAILED_KIND_DDL.test.ts`.
 */
const SESSION_STATS_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
	["sessions", "written_at_ms"],
	["session_model_usage", "updated_at_ms"],
	["session_tool_use", "updated_at_ms"],
	["recall_receipts", "updated_at_ms"],
	["commits", "written_at_ms"],
];
const SESSION_STATS_TABLES = ["session_usage_events", "stats_daily"] as const;
const SESSION_STATS_INDEXES = [
	"ix_sue_at",
	"ix_sue_sync",
	"ix_stats_daily_day",
	"ix_sessions_written",
	"ix_smu_sync",
	"ix_stu_sync",
	"ix_recall_receipts_sync",
	"ix_commits_written",
	"ix_mem_written",
	"ix_sessions_keyset",
	"ix_smu_keyset",
	"ix_stu_keyset",
	"ix_recall_receipts_keyset",
] as const;

function expectSessionStatsSchema(db: DashboardDbHandle): void {
	for (const [table, column] of SESSION_STATS_COLUMNS) {
		expect(columnsOf(db, table), `${table}.${column}`).toContain(column);
	}
	for (const table of SESSION_STATS_TABLES) expect(objectNames(db, "table")).toContain(table);
	for (const index of SESSION_STATS_INDEXES) expect(objectNames(db, "index")).toContain(index);
}

describe("SESSION_STATS_SYNC_DDL", () => {
	it("creates every object the sync depends on", async () => {
		const raw = await rawDb();
		try {
			const slot = MIGRATIONS.findIndex((m) => m.name === "SESSION_STATS_SYNC_DDL");
			for (let s = 0; s <= slot; s++) MIGRATIONS[s].run(raw);
			expectSessionStatsSchema(raw);
		} finally {
			raw.close();
		}
	});
});

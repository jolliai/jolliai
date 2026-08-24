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

/**
 * One of the two entries that shipped as `ALTER TABLE … ADD COLUMN` and had to
 * become a code entry, because SQLite cannot express an add-column step
 * re-runnably in SQL. Required by `MigrationFingerprints.test.ts` — see the same
 * note in `EVENT_FAILED_KIND_DDL.test.ts`.
 */
describe("SKILL_TOKEN_USAGE_DDL", () => {
	it("adds every column its original ALTERs did", async () => {
		const raw = await rawDb();
		try {
			const slot = MIGRATIONS.findIndex((m) => m.name === "SKILL_TOKEN_USAGE_DDL");
			const columns: ReadonlyArray<readonly [table: string, column: string]> = [
				["session_tool_use", "input_tokens"],
				["session_tool_use", "output_tokens"],
				["session_tool_use", "cached_tokens"],
				["session_tool_use", "usage_confidence"],
			];
			for (let s = 0; s < slot; s++) MIGRATIONS[s].run(raw);
			// Absent beforehand, so an entry that adds the WRONG column cannot pass by
			// finding an earlier entry's work already in place.
			for (const [table, column] of columns) {
				expect(columnsOf(raw, table), `${table}.${column}`).not.toContain(column);
			}

			MIGRATIONS[slot].run(raw);

			for (const [table, column] of columns) {
				expect(columnsOf(raw, table), `${table}.${column}`).toContain(column);
			}
		} finally {
			raw.close();
		}
	});
});

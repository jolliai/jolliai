import { describe, expect, it } from "vitest";
import type { DashboardDbHandle } from "../DashboardDb.js";
import { MIGRATIONS } from "./index.js";

/** Raw handle — deliberately bypasses every gate `DashboardDb.ts` applies on open. */
async function rawDb(): Promise<DashboardDbHandle> {
	const { DatabaseSync } = await import("node:sqlite");
	return new DatabaseSync(":memory:") as unknown as DashboardDbHandle;
}

/** Column names of a table, for the add-column assertion. */
function columnsOf(db: DashboardDbHandle, table: string): ReadonlyArray<string> {
	const rows = db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as ReadonlyArray<{ name: string }>;
	return rows.map((r) => r.name);
}

/**
 * Companion test for the entry that carries no `sql`, required by
 * `MigrationFingerprints.test.ts`: a code entry's body is invisible to the
 * fingerprint check (the log stores `sql ?? ""`, so it compares equal to itself
 * for ever), which makes this assertion the only thing standing between a
 * rewritten `run` and a silently different schema.
 */
describe("EVENT_FAILED_KIND_DDL", () => {
	it("adds events_raw.failed_kind", async () => {
		const raw = await rawDb();
		try {
			const slot = MIGRATIONS.findIndex((m) => m.name === "EVENT_FAILED_KIND_DDL");
			for (let s = 0; s < slot; s++) MIGRATIONS[s].run(raw);
			expect(columnsOf(raw, "events_raw")).not.toContain("failed_kind");
			MIGRATIONS[slot].run(raw);
			expect(columnsOf(raw, "events_raw")).toContain("failed_kind");
		} finally {
			raw.close();
		}
	});
});

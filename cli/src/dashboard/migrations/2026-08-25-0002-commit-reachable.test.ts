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
 * A code entry has no fingerprint, so this companion test is its only guard — see the
 * entry's own file for why the column exists. The commit-tier twin of
 * `2026-08-25-0001-memory-reachable`.
 */
describe("2026-08-25-0002-commit-reachable", () => {
	it("adds commits.reachable", async () => {
		const raw = await rawDb();
		try {
			const slot = MIGRATIONS.findIndex((m) => m.name === "2026-08-25-0002-commit-reachable");
			for (let s = 0; s < slot; s++) MIGRATIONS[s].run(raw);
			expect(columnsOf(raw, "commits")).not.toContain("reachable");
			MIGRATIONS[slot].run(raw);
			expect(columnsOf(raw, "commits")).toContain("reachable");
		} finally {
			raw.close();
		}
	});
});

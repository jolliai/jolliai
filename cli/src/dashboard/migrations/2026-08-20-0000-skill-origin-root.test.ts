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
 * Another add-column entry, same shape as `SKILL_PLUGIN_DDL.test.ts` and
 * `SKILL_TOKEN_USAGE_DDL.test.ts` — see this entry's own file for why it exists.
 */
describe("SKILL_ORIGIN_ROOT_DDL", () => {
	it("adds session_tool_use.origin_root", async () => {
		const raw = await rawDb();
		try {
			const slot = MIGRATIONS.findIndex((m) => m.name === "SKILL_ORIGIN_ROOT_DDL");
			for (let s = 0; s < slot; s++) MIGRATIONS[s].run(raw);
			expect(columnsOf(raw, "session_tool_use")).not.toContain("origin_root");
			MIGRATIONS[slot].run(raw);
			expect(columnsOf(raw, "session_tool_use")).toContain("origin_root");
		} finally {
			raw.close();
		}
	});
});

import { describe, expect, it } from "vitest";
import type { DashboardDbHandle } from "../DashboardDb.js";
import { MIGRATIONS } from "./index.js";

async function rawDb(): Promise<DashboardDbHandle> {
	const { DatabaseSync } = await import("node:sqlite");
	return new DatabaseSync(":memory:") as unknown as DashboardDbHandle;
}

describe("2026-08-27-0922-skill-invocation-sync-stamp", () => {
	it("adds a non-null zero-backed write stamp without changing the invocation key", async () => {
		const raw = await rawDb();
		try {
			const slot = MIGRATIONS.findIndex((m) => m.name === "2026-08-27-0922-skill-invocation-sync-stamp");
			for (let index = 0; index < slot; index++) MIGRATIONS[index].run(raw);
			raw.prepare(
				`INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at)
				 VALUES ('r1', 'repo', '/worktree', 1)`,
			).run();
			raw.prepare(
				`INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms)
				 VALUES ('e1', 1, 'claude', 's1', 1)`,
			).run();
			raw.prepare(
				`INSERT INTO skill_invocations
				   (session_event_id, skill_name, at_ms, ok, ok_confidence)
				 VALUES ('e1', 'review', 10, 1, 'observed')`,
			).run();

			MIGRATIONS[slot].run(raw);
			const columns = raw.prepare("PRAGMA table_info(skill_invocations)").all() as ReadonlyArray<{
				name: string;
				notnull: number;
				pk: number;
			}>;
			const stamp = columns.find((column) => column.name === "updated_at_ms");
			expect(stamp).toMatchObject({ notnull: 1, pk: 0 });
			expect(raw.prepare("SELECT updated_at_ms FROM skill_invocations").get()).toEqual({ updated_at_ms: 0 });
		} finally {
			raw.close();
		}
	});
});

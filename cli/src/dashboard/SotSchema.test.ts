/**
 * SotSchema.test — the memory SOT tables' engine-enforced invariants.
 *
 * These are constraints the schema itself guarantees (CHECKs, FKs, generated
 * columns) plus the inspection queries that cover what a single-row constraint
 * cannot express. Tested against a real migrated database rather than through
 * the importer, because the importer is one caller and these properties have to
 * hold for every future one — a DDL edit that quietly drops a guard fails here
 * instead of surfacing as corrupted memory later. Each rule's rationale is on
 * the constraint it guards, in the DDL.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type DashboardDbHandle, withDashboardDb } from "./DashboardDb.js";
import { REORDER_OFFSET, SOT_INSPECTION_QUERIES } from "./SotSchema.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-sotschema-"));
	dbPath = join(dir, "dashboard.db");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Runs `fn` against a migrated database seeded with one repo. */
function withSot<T>(fn: (db: DashboardDbHandle, repoId: number) => T): Promise<T> {
	return withDashboardDb(
		(db) => {
			db.prepare(
				"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES ('r', 'r', '/w', 't')",
			).run();
			const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = 'r'").get() as { id: number };
			return fn(db, id);
		},
		{ dbPath },
	);
}

/** Inserts one memory row; every column has a usable default. */
function insertMemory(
	db: DashboardDbHandle,
	repoId: number,
	hash: string,
	opts: {
		parent?: string | null;
		pos?: number | null;
		root?: string;
		depth?: number;
		summary?: Record<string, unknown>;
	} = {},
): void {
	const summary = {
		commitHash: hash,
		commitMessage: `msg ${hash}`,
		commitDate: "2026-01-01T00:00:00Z",
		...opts.summary,
	};
	db.prepare(
		`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
		                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1)`,
	).run(
		repoId,
		hash,
		opts.parent ?? null,
		opts.pos ?? null,
		opts.root ?? hash,
		opts.depth ?? 0,
		JSON.stringify(summary),
	);
}

describe("tree shape is the engine's job", () => {
	it("rejects a root that carries a position, and a child that lacks one", async () => {
		await withSot((db, repoId) => {
			// One CHECK covers both directions, which is why neither needs its own.
			expect(() => insertMemory(db, repoId, "a", { pos: 0 })).toThrow(/CHECK constraint failed/);
			insertMemory(db, repoId, "root");
			expect(() => insertMemory(db, repoId, "b", { parent: "root", pos: null, depth: 1 })).toThrow(
				/CHECK constraint failed/,
			);
		});
	});

	it("rejects a negative position, so reorder temporaries have to shift upward", async () => {
		await withSot((db, repoId) => {
			insertMemory(db, repoId, "root");
			expect(() => insertMemory(db, repoId, "kid", { parent: "root", pos: -1, depth: 1 })).toThrow(
				/CHECK constraint failed/,
			);
		});
	});

	it("keeps sibling positions unique while allowing many roots", async () => {
		await withSot((db, repoId) => {
			// Roots do not collide: parent_hash and child_pos are both NULL and SQLite
			// treats every NULL in a unique index as distinct.
			insertMemory(db, repoId, "r1");
			insertMemory(db, repoId, "r2");
			insertMemory(db, repoId, "kid1", { parent: "r1", pos: 0, root: "r1", depth: 1 });
			expect(() => insertMemory(db, repoId, "kid2", { parent: "r1", pos: 0, root: "r1", depth: 1 })).toThrow(
				/UNIQUE constraint failed/,
			);
			// The same position under a different parent is fine.
			insertMemory(db, repoId, "kid3", { parent: "r2", pos: 0, root: "r2", depth: 1 });
		});
	});

	it("cascades a root deletion through the whole subtree", async () => {
		const remaining = await withSot((db, repoId) => {
			insertMemory(db, repoId, "root");
			insertMemory(db, repoId, "mid", { parent: "root", pos: 0, root: "root", depth: 1 });
			insertMemory(db, repoId, "leaf", { parent: "mid", pos: 0, root: "root", depth: 2 });
			db.prepare("DELETE FROM memories WHERE repo_id = ? AND commit_hash = 'root'").run(repoId);
			// This is why pruning is a whole-tree decision by root_hash and never a
			// row-by-row one by date: deleting any ancestor takes its descendants.
			return (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
		});
		expect(remaining).toBe(0);
	});
});

describe("sibling reorder", () => {
	it("collides in a single statement, which is why the reorder is two-phase", async () => {
		await withSot((db, repoId) => {
			insertMemory(db, repoId, "root");
			insertMemory(db, repoId, "a", { parent: "root", pos: 0, root: "root", depth: 1 });
			insertMemory(db, repoId, "b", { parent: "root", pos: 1, root: "root", depth: 1 });
			// UNIQUE is checked row by row, so the swap hits itself half-way through.
			// `defer_foreign_keys` does not help: it defers foreign keys, not unique
			// constraints.
			expect(() =>
				db
					.prepare(
						`UPDATE memories SET child_pos = CASE child_pos WHEN 0 THEN 1 ELSE 0 END
						 WHERE repo_id = ? AND parent_hash = 'root'`,
					)
					.run(repoId),
			).toThrow(/UNIQUE constraint failed/);
		});
	});

	it("succeeds when positions are shifted into the offset region first", async () => {
		const first = await withSot((db, repoId) => {
			insertMemory(db, repoId, "root");
			insertMemory(db, repoId, "a", { parent: "root", pos: 0, root: "root", depth: 1 });
			insertMemory(db, repoId, "b", { parent: "root", pos: 1, root: "root", depth: 1 });
			db.exec("BEGIN");
			db.prepare(
				`UPDATE memories SET child_pos = child_pos + ${REORDER_OFFSET}
				 WHERE repo_id = ? AND child_pos IS NOT NULL`,
			).run(repoId);
			db.prepare("UPDATE memories SET child_pos = 1 WHERE repo_id = ? AND commit_hash = 'a'").run(repoId);
			db.prepare("UPDATE memories SET child_pos = 0 WHERE repo_id = ? AND commit_hash = 'b'").run(repoId);
			db.exec("COMMIT");
			return db.prepare("SELECT commit_hash FROM memories WHERE child_pos = 0").get();
		});
		expect(first).toEqual({ commit_hash: "b" });
	});

	it("still admits the offset temporaries — the table bound cannot be the tight one", async () => {
		await withSot((db, repoId) => {
			insertMemory(db, repoId, "root");
			// A position parked in the offset region has to be legal, or phase one of
			// every reorder would fail. The tight bound (settled values stay below
			// REORDER_OFFSET) is an assertion in the write module for that reason.
			insertMemory(db, repoId, "a", { parent: "root", pos: REORDER_OFFSET, root: "root", depth: 1 });
			// Offsetting twice is what the loose bound catches: crash residue picked
			// up by a retried reorder.
			expect(() =>
				db
					.prepare(`UPDATE memories SET child_pos = child_pos + ${REORDER_OFFSET} WHERE repo_id = ?`)
					.run(repoId),
			).toThrow(/CHECK constraint failed/);
		});
	});
});

describe("generated columns", () => {
	it("projects query columns out of summary_json so they cannot drift", async () => {
		const row = await withSot((db, repoId) => {
			insertMemory(db, repoId, "a", {
				summary: {
					branch: "feat/x",
					commitType: "commit",
					recap: "did a thing",
					conversationTurns: 12,
					estimatedCostUsd: 0.25,
					diffStats: { filesChanged: 3, insertions: 40, deletions: 2 },
					ticketId: "JOLLI-1",
				},
			});
			return db
				.prepare(
					`SELECT branch, commit_type, recap, turns, est_cost_usd, files_changed, insertions,
					        deletions, ticket_id FROM memories`,
				)
				.get();
		});
		expect(row).toEqual({
			branch: "feat/x",
			commit_type: "commit",
			recap: "did a thing",
			turns: 12,
			est_cost_usd: 0.25,
			files_changed: 3,
			insertions: 40,
			deletions: 2,
			ticket_id: "JOLLI-1",
		});
	});

	it("degrades an off-type number to NULL instead of rejecting the row", async () => {
		// The whole point of the json_type gate. A float turn count or a string cost
		// must not cost us the summary: the queue entry that produced it is deleted
		// fire-and-forget, so a rejected write is a permanent loss.
		const row = await withSot((db, repoId) => {
			insertMemory(db, repoId, "a", {
				summary: { conversationTurns: 12.5, conversationTokens: "many", diffStats: { insertions: 1.5 } },
			});
			return db.prepare("SELECT turns, tokens, insertions FROM memories").get();
		});
		expect(row).toEqual({ turns: null, tokens: null, insertions: null });
	});

	it("keeps a REAL cost, because est_cost_usd gates on integer OR real", async () => {
		const row = await withSot((db, repoId) => {
			insertMemory(db, repoId, "a", { summary: { estimatedCostUsd: 1.75 } });
			return db.prepare("SELECT est_cost_usd FROM memories").get();
		});
		expect(row).toEqual({ est_cost_usd: 1.75 });
	});
});

describe("transcripts", () => {
	it("round-trips a compressed body and projects its sessions", async () => {
		const { body, sessions } = await withSot((db, repoId) => {
			insertMemory(db, repoId, "a");
			const original = JSON.stringify({ sessions: [{ sessionId: "s1", source: "claude" }, { sessionId: "s2" }] });
			db.prepare(
				"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, 't1', ?, 1)",
			).run(repoId, deflateSync(Buffer.from(original, "utf8")));
			db.prepare(
				"INSERT INTO memory_transcripts (repo_id, commit_hash, transcript_id) VALUES (?, 'a', 't1')",
			).run(repoId);
			for (const [id, src] of [
				["s1", "claude"],
				["s2", null],
			] as const)
				db.prepare(
					"INSERT INTO transcript_sessions (repo_id, transcript_id, session_id, source) VALUES (?, 't1', ?, ?)",
				).run(repoId, id, src);
			const blob = (db.prepare("SELECT sessions_blob AS b FROM transcripts").get() as { b: Uint8Array }).b;
			return {
				body: inflateSync(Buffer.from(blob)).toString("utf8"),
				sessions: db.prepare("SELECT session_id, source FROM transcript_sessions ORDER BY session_id").all(),
			};
		});
		expect(JSON.parse(body)).toEqual({ sessions: [{ sessionId: "s1", source: "claude" }, { sessionId: "s2" }] });
		// source is legitimately NULL on older data, which is why the index leads
		// with session_id.
		expect(sessions).toEqual([
			{ session_id: "s1", source: "claude" },
			{ session_id: "s2", source: null },
		]);
	});

	it("refuses a link to an unknown transcript", async () => {
		await withSot((db, repoId) => {
			insertMemory(db, repoId, "a");
			expect(() =>
				db
					.prepare(
						"INSERT INTO memory_transcripts (repo_id, commit_hash, transcript_id) VALUES (?, 'a', 'nope')",
					)
					.run(repoId),
			).toThrow(/FOREIGN KEY constraint failed/);
		});
	});
});

describe("context and plan progress", () => {
	const insertPlan = (db: DashboardDbHandle, repoId: number, slug: string): void => {
		db.prepare(
			"INSERT INTO context (repo_id, kind, context_key, body_md, created_at_ms) VALUES (?, 'plan', ?, '# plan', 1)",
		).run(repoId, slug);
	};
	const insertProgress = (db: DashboardDbHandle, repoId: number, slug: string): void => {
		db.prepare(
			"INSERT INTO plan_progress (repo_id, plan_slug, artifact_json, updated_at_ms) VALUES (?, ?, '{}', 1)",
		).run(repoId, slug);
	};

	it("rejects field combinations that make no sense for the kind", async () => {
		await withSot((db, repoId) => {
			expect(() =>
				db
					.prepare(
						`INSERT INTO context (repo_id, kind, context_key, original_slug, body_md, created_at_ms)
						 VALUES (?, 'note', 'n1', 'something', 'body', 1)`,
					)
					.run(repoId),
			).toThrow(/CHECK constraint failed/);
		});
	});

	it("accepts a new kind after it is registered — no table rebuild", async () => {
		await withSot((db, repoId) => {
			const insert = () =>
				db
					.prepare(
						"INSERT INTO context (repo_id, kind, context_key, body_md, created_at_ms) VALUES (?, 'x', 'k', 'b', 1)",
					)
					.run(repoId);
			expect(insert).toThrow(/FOREIGN KEY constraint failed/);
			db.prepare("INSERT INTO context_kinds (kind) VALUES ('x')").run();
			insert();
		});
	});

	it("requires an existing plan, and a note cannot stand in for one", async () => {
		await withSot((db, repoId) => {
			db.prepare(
				"INSERT INTO context (repo_id, kind, context_key, body_md, created_at_ms) VALUES (?, 'note', 'n1', 'b', 1)",
			).run(repoId);
			expect(() => insertProgress(db, repoId, "missing")).toThrow(/FOREIGN KEY constraint failed/);
			// plan_key is NULL for a note, and NULL matches no foreign key, so a note
			// cannot be referenced even by its own key.
			expect(() => insertProgress(db, repoId, "n1")).toThrow(/FOREIGN KEY constraint failed/);
		});
	});

	it("carries progress along when a plan is renamed in place", async () => {
		// ON UPDATE CASCADE is not decoration: plan slugs get normalized and
		// rewritten, and plan_progress is an LLM artifact that cannot be reproduced.
		// Without the cascade the rename is either rejected or silently destructive.
		const rows = await withSot((db, repoId) => {
			insertPlan(db, repoId, "old-slug");
			insertProgress(db, repoId, "old-slug");
			db.prepare("UPDATE context SET context_key = 'new-slug' WHERE repo_id = ? AND kind = 'plan'").run(repoId);
			return db.prepare("SELECT plan_slug FROM plan_progress").all();
		});
		expect(rows).toEqual([{ plan_slug: "new-slug" }]);
	});

	it("takes progress with the plan on delete", async () => {
		const n = await withSot((db, repoId) => {
			insertPlan(db, repoId, "p");
			insertProgress(db, repoId, "p");
			db.prepare("DELETE FROM context WHERE repo_id = ? AND kind = 'plan'").run(repoId);
			return (db.prepare("SELECT COUNT(*) AS n FROM plan_progress").get() as { n: number }).n;
		});
		expect(n).toBe(0);
	});

	it("lets a plan with no progress flip kind — the foreign key is not what blocks that", async () => {
		// Worth pinning because it is easy to believe the foreign key prevents this.
		// It does not: what rejects a kind flip is the child's NOT NULL after the
		// cascade nulls its key, so it only bites when a progress row exists. Kind
		// immutability is therefore write-module discipline, not a schema guarantee.
		await withSot((db, repoId) => {
			insertPlan(db, repoId, "p");
			db.prepare("UPDATE context SET kind = 'note' WHERE repo_id = ? AND context_key = 'p'").run(repoId);
			expect(db.prepare("SELECT kind, plan_key FROM context").get()).toEqual({ kind: "note", plan_key: null });
		});
	});

	it("blocks the same flip once progress exists", async () => {
		await withSot((db, repoId) => {
			insertPlan(db, repoId, "p");
			insertProgress(db, repoId, "p");
			expect(() =>
				db.prepare("UPDATE context SET kind = 'note' WHERE repo_id = ? AND context_key = 'p'").run(repoId),
			).toThrow(/NOT NULL constraint failed/);
		});
	});
});

describe("topic KB", () => {
	const insertPage = (db: DashboardDbHandle, repoId: number): void => {
		db.prepare(
			`INSERT INTO topic_pages (repo_id, stable_slug, title, content_md, last_updated_at)
			 VALUES (?, 't', 'T', '#', '2026-01-01T00:00:00Z')`,
		).run(repoId);
	};
	const addRef = (db: DashboardDbHandle, repoId: number, pos: number, id: string): void => {
		db.prepare(
			`INSERT INTO topic_source_refs (repo_id, stable_slug, pos, ref_type, ref_id, ts)
			 VALUES (?, 't', ?, 'summary', ?, '2026-01-01T00:00:00Z')`,
		).run(repoId, pos, id);
	};

	it("replaces source refs as a whole group, which is how position churn is avoided", async () => {
		const rows = await withSot((db, repoId) => {
			insertPage(db, repoId);
			addRef(db, repoId, 0, "a");
			addRef(db, repoId, 1, "b");
			// Reordering row by row would collide on UNIQUE(repo_id, stable_slug, pos)
			// exactly like child_pos. This table has no self-referencing foreign key,
			// so the group can simply be replaced — no offset machinery needed.
			db.exec("BEGIN");
			db.prepare("DELETE FROM topic_source_refs WHERE repo_id = ? AND stable_slug = 't'").run(repoId);
			addRef(db, repoId, 0, "b");
			addRef(db, repoId, 1, "a");
			db.exec("COMMIT");
			return db.prepare("SELECT pos, ref_id FROM topic_source_refs ORDER BY pos").all();
		});
		expect(rows).toEqual([
			{ pos: 0, ref_id: "b" },
			{ pos: 1, ref_id: "a" },
		]);
	});

	it("rejects a negative position", async () => {
		await withSot((db, repoId) => {
			insertPage(db, repoId);
			expect(() => addRef(db, repoId, -1, "a")).toThrow(/CHECK constraint failed/);
		});
	});
});

describe("inspection queries", () => {
	it("all four return no rows on a healthy database", async () => {
		const counts = await withSot((db, repoId) => {
			insertMemory(db, repoId, "root", { summary: { transcripts: [] } });
			insertMemory(db, repoId, "kid", { parent: "root", pos: 0, root: "root", depth: 1 });
			return {
				child: db.prepare(SOT_INSPECTION_QUERIES.childTopology).all().length,
				residue: db.prepare(SOT_INSPECTION_QUERIES.reorderResidue).all(REORDER_OFFSET).length,
				root: db.prepare(SOT_INSPECTION_QUERIES.rootTopology).all().length,
				links: db.prepare(SOT_INSPECTION_QUERIES.linkSet).all().length,
			};
		});
		expect(counts).toEqual({ child: 0, residue: 0, root: 0, links: 0 });
	});

	it("catches a subtree whose root_hash was not propagated on remount", async () => {
		// The failure mode the plan calls out: a remount that updates only the row
		// being moved leaves its descendants pointing at the old root.
		const bad = await withSot((db, repoId) => {
			insertMemory(db, repoId, "root");
			insertMemory(db, repoId, "kid", { parent: "root", pos: 0, root: "root", depth: 1 });
			db.prepare("UPDATE memories SET root_hash = 'elsewhere' WHERE repo_id = ? AND commit_hash = 'root'").run(
				repoId,
			);
			return db.prepare(SOT_INSPECTION_QUERIES.childTopology).all();
		});
		expect(bad).toEqual([{ commit_hash: "kid" }]);
	});

	it("catches rows abandoned in the offset region by a crashed reorder", async () => {
		const bad = await withSot((db, repoId) => {
			insertMemory(db, repoId, "root");
			insertMemory(db, repoId, "kid", { parent: "root", pos: REORDER_OFFSET + 3, root: "root", depth: 1 });
			return db.prepare(SOT_INSPECTION_QUERIES.reorderResidue).all(REORDER_OFFSET);
		});
		expect(bad).toEqual([{ commit_hash: "kid" }]);
	});

	it("catches a root whose depth is wrong", async () => {
		const bad = await withSot((db, repoId) => {
			insertMemory(db, repoId, "root", { depth: 4 });
			return db.prepare(SOT_INSPECTION_QUERIES.rootTopology).all();
		});
		expect(bad).toEqual([{ commit_hash: "root" }]);
	});

	it("catches a summary that still declares a transcript the link table dropped", async () => {
		// The post-squash state. Links do not affect file reassembly, so the
		// equivalence harness is blind to this and only this query sees it.
		const bad = await withSot((db, repoId) => {
			insertMemory(db, repoId, "a", { summary: { transcripts: ["t1"] } });
			db.prepare(
				"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, 't1', x'00', 1)",
			).run(repoId);
			return db.prepare(SOT_INSPECTION_QUERIES.linkSet).all();
		});
		expect(bad).toEqual([{ commit_hash: "a" }]);
	});

	it("tolerates a declared transcript whose file never existed", async () => {
		// Dangling references are tolerated on the orphan branch today, so the
		// database must not be stricter: the query compares against transcripts that
		// actually exist, which makes this state legal rather than a finding.
		const bad = await withSot((db, repoId) => {
			insertMemory(db, repoId, "a", { summary: { transcripts: ["never-written"] } });
			return db.prepare(SOT_INSPECTION_QUERIES.linkSet).all();
		});
		expect(bad).toEqual([]);
	});
});

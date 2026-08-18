/**
 * SotWrite — the write half of the SQLite source of truth.
 *
 * The properties under test are the ones the plan calls out as easy to get
 * wrong: a batch lands in dependency order no matter how the caller shuffled
 * it; a summary write replaces its link set exactly; sibling reordering
 * survives UNIQUE(parent, pos); a child file refresh keeps its mount point; a
 * remount moves whole subtrees; index/catalog writes are no-ops that still
 * harvest what only they carry.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../core/SqliteStorage.js";
import type { CommitSummary, FileWrite } from "../Types.js";
import { withDashboardDb, withReadonlyDashboardDb } from "./DashboardDb.js";

let dir: string;
let dbPath: string;
let storage: SqliteStorage;

const REPO = "https://example.com/acme/app.git";

const summary = (hash: string, over: Record<string, unknown> = {}): CommitSummary =>
	({
		version: "5",
		commitHash: hash,
		commitMessage: `msg ${hash.slice(0, 4)}`,
		commitDate: "2026-07-01T00:00:00.000Z",
		branch: "main",
		commitType: "commit",
		topics: [],
		children: [],
		...over,
	}) as unknown as CommitSummary;

const H = (c: string): string => c.repeat(40);
const file = (path: string, content: unknown): FileWrite => ({
	path,
	content: typeof content === "string" ? content : JSON.stringify(content, null, "\t"),
});

async function rows<T>(sql: string, ...params: Array<string | number>): Promise<T[]> {
	return withReadonlyDashboardDb((db) => db.prepare(sql).all(...(params as string[])) as T[], { dbPath });
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "jolli-sot-write-"));
	dbPath = join(dir, "jollimemory.db");
	await withDashboardDb(
		(db) =>
			db
				.prepare("INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES (?, ?, ?, ?)")
				.run(REPO, "app", "/w", "t"),
		{ dbPath },
	);
	storage = new SqliteStorage(REPO, dbPath);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("dependency ordering", () => {
	it("lands a shuffled batch: links after transcripts, progress after plans", async () => {
		// Deliberately the WORST caller order: progress before its plan, a
		// summary referencing a transcript that appears later in the batch.
		await storage.writeFiles(
			[
				file("plan-progress/my-plan.json", { planSlug: "my-plan", version: 1 }),
				file(`summaries/${H("a")}.json`, summary(H("a"), { transcripts: ["t-1"] })),
				file("plans/my-plan.md", "# my plan\nbody\n"),
				file("transcripts/t-1.json", { sessions: [{ sessionId: "s1", source: "claude" }] }),
			],
			"m",
		);
		const links = await rows<{ transcript_id: string }>(
			"SELECT transcript_id FROM memory_transcripts WHERE commit_hash = ?",
			H("a"),
		);
		expect(links).toEqual([{ transcript_id: "t-1" }]);
		expect(await rows("SELECT plan_slug FROM plan_progress")).toEqual([{ plan_slug: "my-plan" }]);
		expect(await rows("SELECT session_id FROM transcript_sessions WHERE transcript_id = 't-1'")).toEqual([
			{ session_id: "s1" },
		]);
	});

	it("skips plan-progress whose plan exists nowhere instead of rolling back the batch", async () => {
		// It IS a caller bug, but throwing charged the wrong account: the batch is one
		// transaction and a commit's plan-progress rides in it beside its own
		// summaries/<hash>.json, so the rollback discarded the MEMORY. The artifact is
		// derived and regenerable; the memory is not.
		await expect(
			storage.writeFiles([file("plan-progress/lost.json", { planSlug: "lost" })], "m"),
		).resolves.toBeUndefined();
		expect(await rows("SELECT plan_slug FROM plan_progress WHERE plan_slug = 'lost'")).toEqual([]);
	});

	it("rejects a path no table backs, rolling back the whole batch", async () => {
		await expect(
			storage.writeFiles([file("plans/ok.md", "# ok"), file("mystery/thing.bin", "x")], "m"),
		).rejects.toThrow(/no table backs/);
		expect(await rows("SELECT context_key FROM context")).toEqual([]);
	});
});

describe("archived skills", () => {
	const KEY = "claude/superpowers-brainstorming-a1b2c3d4-abc12345";
	const PATH = `skills/${KEY}.md`;

	// The bug this pins: `skills/` reached no table, so `classify` threw and the
	// WHOLE batch rolled back. On a cut-over repo that meant every commit from a
	// session that used a skill lost its memory, non-intermittently — and the
	// cutover's containment compare never visited a skill path, so it could not
	// notice before certifying the freeze.
	it("round-trips a skill through the context table", async () => {
		await storage.writeFiles([file(PATH, "---\nname: brainstorming\n---\n# Brainstorming")], "m");

		expect(await storage.readFile(PATH)).toContain("# Brainstorming");
		expect(await storage.listFiles("skills/")).toEqual([PATH]);
		expect(await rows("SELECT kind, context_key FROM context")).toEqual([{ kind: "skill", context_key: KEY }]);
	});

	it("lands beside a memory in ONE batch instead of aborting it", async () => {
		await storage.writeFiles([file(`summaries/${H("a")}.json`, summary(H("a"))), file(PATH, "# S")], "m");

		expect(await rows("SELECT commit_hash FROM memories")).toEqual([{ commit_hash: H("a") }]);
		expect(await rows("SELECT context_key FROM context WHERE kind = 'skill'")).toEqual([{ context_key: KEY }]);
	});

	it("stores no branch, even though the key ends in a hash8 a memory owns", async () => {
		// `branchFromMemories` resolves any `-<hash8>` suffix to that memory's branch,
		// and a skill key carries one. `context` CHECKs branch to plan/note, so
		// writing it would abort the batch — the guard has to be kind-aware.
		await storage.writeFiles([file(`summaries/${H("a")}.json`, summary(H("a"), { branch: "feat/x" }))], "m");
		await storage.writeFiles([file(`skills/claude/thing-${H("a").slice(0, 8)}.md`, "# S")], "m");

		expect(await rows("SELECT branch, source, native_id FROM context WHERE kind = 'skill'")).toEqual([
			{ branch: null, source: null, native_id: null },
		]);
	});

	it("deletes a skill without touching the other kinds", async () => {
		await storage.writeFiles([file(PATH, "# S"), file("notes/n1.md", "# N")], "m");
		await storage.writeFiles([{ path: PATH, content: "", delete: true }], "m");

		expect(await storage.readFile(PATH)).toBeNull();
		expect(await rows("SELECT kind FROM context")).toEqual([{ kind: "note" }]);
	});
});

describe("summary trees", () => {
	it("writes a tree, then converges on a replay with fewer topics", async () => {
		const tree = summary(H("a"), {
			topics: [{ title: "T1" }, { title: "T2" }],
			children: [summary(H("b"), { topics: [{ title: "C1" }] })],
		});
		await storage.writeFiles([file(`summaries/${H("a")}.json`, tree)], "m");
		expect(await rows("SELECT COUNT(*) AS n FROM memory_topics")).toEqual([{ n: 3 }]);

		const regenerated = summary(H("a"), { topics: [{ title: "T1" }], children: [summary(H("b"))] });
		await storage.writeFiles([file(`summaries/${H("a")}.json`, regenerated)], "m");
		// Group replacement: the surplus topic rows are gone, not stranded.
		expect(await rows("SELECT COUNT(*) AS n FROM memory_topics")).toEqual([{ n: 1 }]);
		expect(await rows("SELECT depth FROM memories WHERE commit_hash = ?", H("b"))).toEqual([{ depth: 1 }]);
	});

	it("reorders siblings without tripping UNIQUE(parent, pos)", async () => {
		const before = summary(H("a"), { children: [summary(H("b")), summary(H("c"))] });
		await storage.writeFiles([file(`summaries/${H("a")}.json`, before)], "m");
		const after = summary(H("a"), { children: [summary(H("c")), summary(H("b"))] });
		await storage.writeFiles([file(`summaries/${H("a")}.json`, after)], "m");
		const kids = await rows<{ commit_hash: string; child_pos: number }>(
			"SELECT commit_hash, child_pos FROM memories WHERE parent_hash = ? ORDER BY child_pos",
			H("a"),
		);
		expect(kids).toEqual([
			{ commit_hash: H("c"), child_pos: 0 },
			{ commit_hash: H("b"), child_pos: 1 },
		]);
	});

	it("reorders siblings when the batch lists a child's own file before the parent's", async () => {
		// The child file re-anchors itself from its stored mount point, which at
		// that moment is parked in the offset region. Leaving it parked is what
		// keeps the parent's walk from colliding with it — see landSummaries.
		await storage.writeFiles(
			[
				file(
					`summaries/${H("a")}.json`,
					summary(H("a"), { children: [summary(H("b")), summary(H("c")), summary(H("d"))] }),
				),
			],
			"m",
		);
		await storage.writeFiles(
			[
				file(`summaries/${H("c")}.json`, summary(H("c"))),
				file(
					`summaries/${H("a")}.json`,
					summary(H("a"), { children: [summary(H("d")), summary(H("b")), summary(H("c"))] }),
				),
			],
			"m",
		);
		const kids = await rows<{ commit_hash: string; child_pos: number }>(
			"SELECT commit_hash, child_pos FROM memories WHERE parent_hash = ? ORDER BY child_pos",
			H("a"),
		);
		expect(kids).toEqual([
			{ commit_hash: H("d"), child_pos: 0 },
			{ commit_hash: H("b"), child_pos: 1 },
			{ commit_hash: H("c"), child_pos: 2 },
		]);
		expect(await rows("SELECT COUNT(*) AS n FROM memories WHERE child_pos >= 1000000")).toEqual([{ n: 0 }]);
	});

	it("re-grounds a re-anchoring top node whose ground position the new set took", async () => {
		await storage.writeFiles(
			[file(`summaries/${H("a")}.json`, summary(H("a"), { children: [summary(H("b")), summary(H("c"))] }))],
			"m",
		);
		// b's own file rides in the same batch that drops b from a's children and
		// moves c onto b's old position 0.
		await storage.writeFiles(
			[
				file(`summaries/${H("b")}.json`, summary(H("b"))),
				file(`summaries/${H("a")}.json`, summary(H("a"), { children: [summary(H("c"))] })),
			],
			"m",
		);
		expect(await rows("SELECT parent_hash, child_pos FROM memories WHERE commit_hash = ?", H("b"))).toEqual([
			{ parent_hash: null, child_pos: null },
		]);
		expect(await rows("SELECT child_pos FROM memories WHERE commit_hash = ?", H("c"))).toEqual([{ child_pos: 0 }]);
		expect(await rows("SELECT COUNT(*) AS n FROM memories WHERE child_pos >= 1000000")).toEqual([{ n: 0 }]);
	});

	it("re-grounds a re-anchoring top node the new set dropped, free ground slot or not", async () => {
		// Same shape as above except b sat LAST, so nothing in the new set takes
		// its position 2. A free slot is not a reason to keep the edge: `a.json`
		// no longer lists b, and a seed import of these same files makes b a root.
		await storage.writeFiles(
			[
				file(
					`summaries/${H("a")}.json`,
					summary(H("a"), { children: [summary(H("c")), summary(H("d")), summary(H("b"))] }),
				),
			],
			"m",
		);
		await storage.writeFiles(
			[
				file(`summaries/${H("b")}.json`, summary(H("b"))),
				file(`summaries/${H("a")}.json`, summary(H("a"), { children: [summary(H("c")), summary(H("d"))] })),
			],
			"m",
		);
		expect(await rows("SELECT parent_hash, child_pos, depth FROM memories WHERE commit_hash = ?", H("b"))).toEqual([
			{ parent_hash: null, child_pos: null, depth: 0 },
		]);
		const kids = await rows<{ commit_hash: string; child_pos: number }>(
			"SELECT commit_hash, child_pos FROM memories WHERE parent_hash = ? ORDER BY child_pos",
			H("a"),
		);
		expect(kids).toEqual([
			{ commit_hash: H("c"), child_pos: 0 },
			{ commit_hash: H("d"), child_pos: 1 },
		]);
		expect(await rows("SELECT COUNT(*) AS n FROM memories WHERE child_pos >= 1000000")).toEqual([{ n: 0 }]);
	});

	it("remounts an old root as a child, moving its whole subtree", async () => {
		// b is a root with child c (depth 1). An amend then claims b under a.
		await storage.writeFiles(
			[file(`summaries/${H("b")}.json`, summary(H("b"), { children: [summary(H("c"))] }))],
			"m",
		);
		await storage.writeFiles(
			[
				file(
					`summaries/${H("a")}.json`,
					summary(H("a"), { children: [summary(H("b"), { children: [summary(H("c"))] })] }),
				),
			],
			"m",
		);
		const all = await rows<{ commit_hash: string; root_hash: string; depth: number }>(
			"SELECT commit_hash, root_hash, depth FROM memories ORDER BY depth",
		);
		expect(all).toEqual([
			{ commit_hash: H("a"), root_hash: H("a"), depth: 0 },
			{ commit_hash: H("b"), root_hash: H("a"), depth: 1 },
			{ commit_hash: H("c"), root_hash: H("a"), depth: 2 },
		]);
	});

	it("keeps a child's mount point when its own file is refreshed", async () => {
		await storage.writeFiles(
			[file(`summaries/${H("a")}.json`, summary(H("a"), { children: [summary(H("b"))] }))],
			"m",
		);
		// The child-file refresh (what pushes and migrations do) knows nothing
		// about a; landing it must not tear b out of a's tree.
		await storage.writeFiles([file(`summaries/${H("b")}.json`, summary(H("b"), { recap: "updated" }))], "m");
		const b = await rows<{ parent_hash: string; root_hash: string; depth: number }>(
			"SELECT parent_hash, root_hash, depth FROM memories WHERE commit_hash = ?",
			H("b"),
		);
		expect(b).toEqual([{ parent_hash: H("a"), root_hash: H("a"), depth: 1 }]);
		const read = JSON.parse((await storage.readFile(`summaries/${H("b")}.json`)) as string) as CommitSummary;
		expect(read.recap).toBe("updated");
	});

	it("re-grounds a stored child the new tree no longer claims", async () => {
		await storage.writeFiles(
			[file(`summaries/${H("a")}.json`, summary(H("a"), { children: [summary(H("b")), summary(H("c"))] }))],
			"m",
		);
		await storage.writeFiles(
			[file(`summaries/${H("a")}.json`, summary(H("a"), { children: [summary(H("c"))] }))],
			"m",
		);
		// b's own file still exists in the model, so b becomes a root — never a
		// silent delete — and nothing lingers in the reorder offset region.
		const b = await rows<{ parent_hash: string | null; child_pos: number | null; depth: number }>(
			"SELECT parent_hash, child_pos, depth FROM memories WHERE commit_hash = ?",
			H("b"),
		);
		expect(b).toEqual([{ parent_hash: null, child_pos: null, depth: 0 }]);
		expect(await rows("SELECT COUNT(*) AS n FROM memories WHERE child_pos >= 1000000")).toEqual([{ n: 0 }]);
	});

	it("deletes a node as a whole-tree cascade", async () => {
		await storage.writeFiles(
			[file(`summaries/${H("a")}.json`, summary(H("a"), { children: [summary(H("b"))] }))],
			"m",
		);
		await storage.writeFiles([{ path: `summaries/${H("a")}.json`, content: "", delete: true }], "m");
		expect(await rows("SELECT COUNT(*) AS n FROM memories")).toEqual([{ n: 0 }]);
	});

	it("throws on a cycle among the claimed edges and rolls back", async () => {
		await storage.writeFiles(
			[file(`summaries/${H("a")}.json`, summary(H("a"), { children: [summary(H("b"))] }))],
			"m",
		);
		// The batch claims both directions at once -- a.json keeps b as its child
		// while b.json claims a as ITS child -- so the edges form a↔b and neither
		// is a root.
		await expect(
			storage.writeFiles(
				[
					file(`summaries/${H("a")}.json`, summary(H("a"), { children: [summary(H("b"))] })),
					file(`summaries/${H("b")}.json`, summary(H("b"), { children: [summary(H("a"))] })),
				],
				"m",
			),
		).rejects.toThrow(/cycle/);
		// Rolled back: the original topology is intact.
		expect(await rows("SELECT parent_hash FROM memories WHERE commit_hash = ?", H("b"))).toEqual([
			{ parent_hash: H("a") },
		]);
	});

	it("rejects an unparsable summary before touching the database", async () => {
		await expect(storage.writeFiles([file(`summaries/${H("a")}.json`, "not json")], "m")).rejects.toThrow(
			/unparsable summary/,
		);
	});
});

describe("links", () => {
	it("replaces the link set exactly and drops dangling references", async () => {
		await storage.writeFiles(
			[
				file("transcripts/t-1.json", { sessions: [{ sessionId: "s1" }] }),
				file("transcripts/t-2.json", { sessions: [{ sessionId: "s2" }] }),
				file(`summaries/${H("a")}.json`, summary(H("a"), { transcripts: ["t-1", "t-2"] })),
			],
			"m",
		);
		// A rebase swaps the transcript set; t-9 never had a file (dangling —
		// tolerated on the orphan, so it must be a drop here, not an error).
		await storage.writeFiles(
			[file(`summaries/${H("a")}.json`, summary(H("a"), { transcripts: ["t-2", "t-9"] }))],
			"m",
		);
		expect(await rows("SELECT transcript_id FROM memory_transcripts WHERE commit_hash = ?", H("a"))).toEqual([
			{ transcript_id: "t-2" },
		]);
	});

	// The reverse write order — summary first, transcript later — is what
	// `saveTranscriptsBatch` (ide-bridge `transcripts-save`) produces. The link
	// used to be dropped as "dangling" and nothing re-derived it, so the
	// dashboard's session↔commit join silently lost the commit.
	it("links a transcript stored AFTER the summary that references it", async () => {
		await storage.writeFiles([file(`summaries/${H("a")}.json`, summary(H("a"), { transcripts: ["t-1"] }))], "m");
		expect(await rows("SELECT COUNT(*) AS n FROM memory_transcripts")).toEqual([{ n: 0 }]);

		await storage.writeFiles([file("transcripts/t-1.json", { sessions: [{ sessionId: "s1" }] })], "m");
		expect(await rows("SELECT commit_hash, transcript_id FROM memory_transcripts")).toEqual([
			{ commit_hash: H("a"), transcript_id: "t-1" },
		]);
	});

	it("does not link a transcript to a memory that never referenced it", async () => {
		await storage.writeFiles([file(`summaries/${H("a")}.json`, summary(H("a"), { transcripts: ["t-9"] }))], "m");
		await storage.writeFiles([file("transcripts/t-1.json", { sessions: [{ sessionId: "s1" }] })], "m");
		expect(await rows("SELECT COUNT(*) AS n FROM memory_transcripts")).toEqual([{ n: 0 }]);
	});

	// A batch carrying both must keep landLinks' replacement authoritative:
	// the backfill runs after it and must not resurrect a dropped link.
	it("lets a same-batch summary write remain the authority on its link set", async () => {
		await storage.writeFiles(
			[
				file("transcripts/t-1.json", { sessions: [{ sessionId: "s1" }] }),
				file(`summaries/${H("a")}.json`, summary(H("a"), { transcripts: ["t-1"] })),
			],
			"m",
		);
		// Re-written with an empty transcript list, alongside the transcript again.
		await storage.writeFiles(
			[
				file("transcripts/t-1.json", { sessions: [{ sessionId: "s1" }] }),
				file(`summaries/${H("a")}.json`, summary(H("a"), { transcripts: [] })),
			],
			"m",
		);
		expect(await rows("SELECT COUNT(*) AS n FROM memory_transcripts")).toEqual([{ n: 0 }]);
	});

	it("deleting a transcript clears its links and sessions first", async () => {
		await storage.writeFiles(
			[
				file("transcripts/t-1.json", { sessions: [{ sessionId: "s1" }] }),
				file(`summaries/${H("a")}.json`, summary(H("a"), { transcripts: ["t-1"] })),
			],
			"m",
		);
		await storage.writeFiles([{ path: "transcripts/t-1.json", content: "", delete: true }], "m");
		expect(await rows("SELECT COUNT(*) AS n FROM transcripts")).toEqual([{ n: 0 }]);
		expect(await rows("SELECT COUNT(*) AS n FROM memory_transcripts")).toEqual([{ n: 0 }]);
		expect(await rows("SELECT COUNT(*) AS n FROM transcript_sessions")).toEqual([{ n: 0 }]);
	});

	// The batch is ONE transaction, so throwing on a bad artifact rolls back the
	// memory riding alongside it — the orphan backend stored these bytes verbatim
	// and could not fail this way at all. Skip loudly, keep the rest.
	it("skips an unparsable transcript without losing the memory in the same batch", async () => {
		await storage.writeFiles(
			[file(`summaries/${H("a")}.json`, summary(H("a"))), file("transcripts/t-1.json", "{]")],
			"m",
		);
		expect(await rows("SELECT commit_hash FROM memories")).toEqual([{ commit_hash: H("a") }]);
		expect(await rows("SELECT COUNT(*) AS n FROM transcripts")).toEqual([{ n: 0 }]);
	});
});

describe("no-op writes that still harvest", () => {
	it("index.json contributes treeHash and nothing else", async () => {
		await storage.writeFiles(
			[
				file(`summaries/${H("a")}.json`, summary(H("a"))),
				file("index.json", {
					version: 3,
					entries: [{ commitHash: H("a"), parentCommitHash: null, treeHash: H("9"), branch: "main" }],
				}),
				file("catalog.json", { version: 1, entries: [] }),
			],
			"m",
		);
		expect(await rows("SELECT tree_hash FROM memories WHERE commit_hash = ?", H("a"))).toEqual([
			{ tree_hash: H("9") },
		]);
		// A later batch without an index keeps the stored value (COALESCE).
		await storage.writeFiles([file(`summaries/${H("a")}.json`, summary(H("a"), { recap: "r2" }))], "m");
		expect(await rows("SELECT tree_hash FROM memories WHERE commit_hash = ?", H("a"))).toEqual([
			{ tree_hash: H("9") },
		]);
	});

	it("index.json also contributes tree-hash aliases — the scanner's only persistence", async () => {
		await storage.writeFiles([file(`summaries/${H("a")}.json`, summary(H("a")))], "m");
		// The alias scanner's batch: index.json ALONE, carrying the alias map.
		await storage.writeFiles(
			[
				file("index.json", {
					version: 3,
					entries: [{ commitHash: H("a"), parentCommitHash: null }],
					commitAliases: { [H("9")]: H("a"), [H("8")]: H("7") },
				}),
			],
			"m",
		);
		// The resolvable alias landed; the one pointing at a memory this
		// database never saw is dropped (orphan tolerated it, so must we).
		expect(await rows("SELECT old_hash, target_hash FROM commit_aliases")).toEqual([
			{ old_hash: H("9"), target_hash: H("a") },
		]);
	});

	it("forgets both cached days an alias moves a memory between", async () => {
		// An alias is the one write that MOVES a memory between calendar days: the
		// landing rule falls through to the aliasing commit's committer date once the
		// memory's own commit row is gone. `commit_aliases` carries no write stamp, so
		// the rollup's staleness scan cannot see it — both the day it leaves and the
		// day it arrives on have to be forgotten here, or the memory is counted twice
		// (once in each day's cached copy) until something unrelated rebuilds them.
		const { localDayKey, machineTimeZone } = await import("./LocalDays.js");
		const tz = machineTimeZone();
		// The memory's own `commitDate`, i.e. where it lands with no commit row.
		const leaves = Date.parse("2026-07-01T00:00:00.000Z");
		// The surviving commit's COMMITTER date — deliberately a different day.
		const arrives = Date.parse("2026-07-15T12:00:00.000Z");
		await storage.writeFiles([file(`summaries/${H("a")}.json`, summary(H("a")))], "m");
		await withDashboardDb(
			(db) => {
				const repoId = (db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(REPO) as { id: number })
					.id;
				db.prepare(
					`INSERT INTO commits (event_id, repo_id, hash, branch, message, committed_at_ms, written_at_ms)
					 VALUES (?, ?, ?, 'main', 'm', ?, ?)`,
				).run(`commit:${H("9")}`, repoId, H("9"), arrives, arrives);
				const settle = db.prepare(
					`INSERT INTO stats_daily (repo_id, tz, day, kind, series_key, value, cost_usd, built_at_ms, updated_at_ms)
					 VALUES (?, ?, ?, 'model', 'sonnet', 1, 0, 1, 1)`,
				);
				settle.run(repoId, tz, localDayKey(leaves, tz));
				settle.run(repoId, tz, localDayKey(arrives, tz));
			},
			{ dbPath },
		);

		await storage.writeFiles(
			[
				file("index.json", {
					version: 3,
					entries: [{ commitHash: H("a"), parentCommitHash: null }],
					commitAliases: { [H("9")]: H("a") },
				}),
			],
			"m",
		);

		expect(await rows("SELECT day FROM stats_daily")).toEqual([]);
	});

	it("forgets the day a RETARGETED alias drops its previous target back onto", async () => {
		// The gap the shared `upsertCommitAlias` closed. Retargeting `old_hash` moves
		// the INCOMING target onto the aliasing commit's day — which this loop always
		// handled — and simultaneously drops the OUTGOING one back to its own
		// `commit_date_ms`. That second day used to be named nowhere: the previous
		// target was never read, `commit_aliases` carries no stamp the rollup's
		// staleness scan can see, and an old day gets no further writes — so its
		// cached copy served a count missing that memory indefinitely.
		const { localDayKey, machineTimeZone } = await import("./LocalDays.js");
		const tz = machineTimeZone();
		// Where a memory with no commit row of its own lands: its own `commitDate`.
		// THREE distinct days, and that is what gives this case its teeth: the two
		// memories must not share a fallback day, or the old code's "read the
		// incoming target" would have named the outgoing one's day by coincidence.
		const aFallback = Date.parse("2026-07-01T00:00:00.000Z");
		const bFallback = Date.parse("2026-06-10T00:00:00.000Z");
		// The aliasing commit's COMMITTER date — deliberately a third day.
		const aliased = Date.parse("2026-07-15T12:00:00.000Z");
		await storage.writeFiles(
			[
				file(`summaries/${H("a")}.json`, summary(H("a"))),
				file(`summaries/${H("b")}.json`, summary(H("b"), { commitDate: "2026-06-10T00:00:00.000Z" })),
			],
			"m",
		);
		await withDashboardDb(
			(db) => {
				const repoId = (db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(REPO) as { id: number })
					.id;
				db.prepare(
					`INSERT INTO commits (event_id, repo_id, hash, branch, message, committed_at_ms, written_at_ms)
					 VALUES (?, ?, ?, 'main', 'm', ?, ?)`,
				).run(`commit:${H("9")}`, repoId, H("9"), aliased, aliased);
			},
			{ dbPath },
		);
		const index = (target: string) =>
			file("index.json", {
				version: 3,
				entries: [
					{ commitHash: H("a"), parentCommitHash: null },
					{ commitHash: H("b"), parentCommitHash: null },
				],
				commitAliases: { [H("9")]: target },
			});

		// First landing: `a` is the target, so it sits on the aliased day.
		await storage.writeFiles([index(H("a"))], "m");
		// Settle a cached day for each landing this retarget will touch, AFTER the
		// first alias landed so it is not swept by that write's own invalidation.
		await withDashboardDb(
			(db) => {
				const repoId = (db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(REPO) as { id: number })
					.id;
				const settle = db.prepare(
					`INSERT INTO stats_daily (repo_id, tz, day, kind, series_key, value, cost_usd, built_at_ms, updated_at_ms)
					 VALUES (?, ?, ?, 'model', 'sonnet', 1, 0, 1, 1)`,
				);
				settle.run(repoId, tz, localDayKey(aFallback, tz));
				settle.run(repoId, tz, localDayKey(bFallback, tz));
				settle.run(repoId, tz, localDayKey(aliased, tz));
			},
			{ dbPath },
		);

		// The retarget.
		await storage.writeFiles([index(H("b"))], "m");

		expect(await rows("SELECT old_hash, target_hash FROM commit_aliases")).toEqual([
			{ old_hash: H("9"), target_hash: H("b") },
		]);
		// All three are gone: `b` left its own fallback day, both memories crossed the
		// aliased day, and `a` came back to ITS fallback day — that last one is what
		// used to survive, holding a count that no longer included `a`.
		expect(await rows("SELECT day FROM stats_daily")).toEqual([]);
	});

	it("delete of index/catalog/v5-marker changes nothing", async () => {
		await storage.writeFiles(
			[
				file("schema-v5-migration.json", '{"status":"completed"}'),
				{ path: "index.json", content: "", delete: true },
				{ path: "catalog.json", content: "", delete: true },
			],
			"m",
		);
		await storage.writeFiles([{ path: "schema-v5-migration.json", content: "", delete: true }], "m");
		// The completed-marker cannot be un-said by a delete.
		expect(await storage.readFile("schema-v5-migration.json")).toBe('{"status":"completed"}');
	});
});

describe("context and topics", () => {
	it("projects plan/note/reference columns like the importer does", async () => {
		await storage.writeFiles(
			[
				file(
					`summaries/${"d1e2f300".padEnd(40, "0")}.json`,
					summary("d1e2f300".padEnd(40, "0"), { branch: "feat-x" }),
				),
			],
			"m",
		);
		await storage.writeFiles(
			[
				file("plans/my-plan-d1e2f300.md", "# Plan title\nbody"),
				file("notes/note-1.md", "note body"),
				file(
					"references/linear/JOLLI-1.md",
					[
						"---",
						'source: "linear"',
						'nativeId: "JOLLI-1"',
						'title: "T"',
						'url: "https://linear.app/x"',
						'referencedAt: "2026-07-01T00:00:00.000Z"',
						'sourceToolName: "mcp"',
						"---",
						"",
						"body",
						"",
					].join("\n"),
				),
			],
			"m",
		);
		const plan = await rows<{ branch: string | null; original_slug: string | null; title: string | null }>(
			"SELECT branch, original_slug, title FROM context WHERE kind = 'plan'",
		);
		// branch resolved by hash8 suffix against memories — the index is not a
		// table any more, so the lookup goes to the rows themselves.
		expect(plan).toEqual([{ branch: "feat-x", original_slug: "my-plan", title: "Plan title" }]);
		const ref = await rows<{ source: string; native_id: string; url: string }>(
			"SELECT source, native_id, url FROM context WHERE kind = 'reference'",
		);
		expect(ref).toEqual([{ source: "linear", native_id: "JOLLI-1", url: "https://linear.app/x" }]);
		await storage.writeFiles([{ path: "notes/note-1.md", content: "", delete: true }], "m");
		expect(await rows("SELECT COUNT(*) AS n FROM context WHERE kind = 'note'")).toEqual([{ n: 0 }]);
	});

	// One odd legacy reference used to take EVERY reference for that commit with
	// it, plus the memory itself. SotImport has always skipped the same file.
	it("skips a reference with unparsable frontmatter and keeps its batch", async () => {
		await storage.writeFiles(
			[file(`summaries/${H("a")}.json`, summary(H("a"))), file("references/x/y.md", "no frontmatter")],
			"m",
		);
		expect(await rows("SELECT commit_hash FROM memories")).toEqual([{ commit_hash: H("a") }]);
		expect(await rows("SELECT COUNT(*) AS n FROM context WHERE kind = 'reference'")).toEqual([{ n: 0 }]);
	});

	it("round-trips a topic page and applies the index-borne summary", async () => {
		const page = {
			schemaVersion: 1,
			stableSlug: "alpha",
			title: "Alpha",
			content: "# A",
			relatedBranches: ["main"],
			sourceRefs: [{ type: "summary", id: H("a"), timestamp: "2026-07-01T00:00:00.000Z", branch: "main" }],
			lastUpdatedAt: "2026-07-03T00:00:00.000Z",
		};
		await storage.writeFiles(
			[
				file("topics/alpha.json", page),
				file("topics/index.json", {
					schemaVersion: 1,
					topics: [
						{ ...page, summary: "About alpha" },
						{ stableSlug: "ghost", summary: "no page row" },
					],
				}),
				file("topics/processed.json", {
					schemaVersion: 1,
					processed: { summary: [H("a")], plan: [], note: [], userfile: [] },
				}),
			],
			"m",
		);
		expect(await storage.readFile("topics/alpha.json")).toBe(JSON.stringify(page, null, "\t"));
		expect(await rows("SELECT summary FROM topic_pages WHERE stable_slug = 'alpha'")).toEqual([
			{ summary: "About alpha" },
		]);
		// ghost had no page row: logged and dropped, never fabricated.
		expect(await rows("SELECT COUNT(*) AS n FROM topic_pages")).toEqual([{ n: 1 }]);
		expect(await rows("SELECT source_id FROM topic_processed_sources")).toEqual([{ source_id: H("a") }]);

		// processed.json is the whole high-water mark: landing a smaller one shrinks.
		await storage.writeFiles(
			[
				file("topics/processed.json", {
					schemaVersion: 1,
					processed: { summary: [], plan: ["p1"], note: [], userfile: [] },
				}),
			],
			"m",
		);
		expect(await rows("SELECT source_type, source_id FROM topic_processed_sources")).toEqual([
			{ source_type: "plan", source_id: "p1" },
		]);
		await storage.writeFiles([{ path: "topics/alpha.json", content: "", delete: true }], "m");
		expect(await rows("SELECT COUNT(*) AS n FROM topic_source_refs")).toEqual([{ n: 0 }]);
	});

	it("skips unparsable topic artifacts and keeps its batch", async () => {
		await storage.writeFiles(
			[file(`summaries/${H("a")}.json`, summary(H("a"))), file("topics/bad.json", "{}")],
			"m",
		);
		expect(await rows("SELECT commit_hash FROM memories")).toEqual([{ commit_hash: H("a") }]);
		expect(await rows("SELECT COUNT(*) AS n FROM topic_pages")).toEqual([{ n: 0 }]);
	});

	// Skipping keeps the PREVIOUS high-water set — the safe direction, since
	// re-processing a source is idempotent. And it must not swallow the
	// unrelated v5-state write that rides in the same batch.
	it("skips an unparsable processed set, keeping the stored one and the rest of the batch", async () => {
		await storage.writeFiles([file("topics/processed.json", { processed: { summary: ["s1"] } })], "m");
		expect(await rows("SELECT source_id FROM topic_processed_sources")).toEqual([{ source_id: "s1" }]);

		await storage.writeFiles(
			[file("topics/processed.json", "{}"), file("schema-v5-migration.json", { done: true })],
			"m",
		);
		expect(await rows("SELECT source_id FROM topic_processed_sources")).toEqual([{ source_id: "s1" }]);
		expect(await rows("SELECT COUNT(*) AS n FROM repo_state WHERE key = 'v5-migration'")).toEqual([{ n: 1 }]);
	});

	it("refuses writes for an unregistered repo", async () => {
		const other = new SqliteStorage("https://example.com/other.git", dbPath);
		await expect(other.writeFiles([file("plans/p.md", "# p")], "m")).rejects.toThrow(/unregistered/);
	});
});

describe("edge shapes the main flows never hit", () => {
	it("handles keyless-children summaries, titleless topics and sessionless sessions", async () => {
		const keyless = { ...summary(H("e"), { topics: [{ title: "" }, { title: "ok" }] }) } as Record<string, unknown>;
		delete keyless.children;
		await storage.writeFiles(
			[
				file(`summaries/${H("e")}.json`, keyless),
				file("transcripts/t-x.json", { sessions: [{ notSessionId: true }, { sessionId: "s9" }] }),
			],
			"m",
		);
		// The titleless topic is dropped (NOT NULL column), the good one lands.
		expect(await rows("SELECT title FROM memory_topics WHERE commit_hash = ?", H("e"))).toEqual([{ title: "ok" }]);
		expect(await rows("SELECT session_id FROM transcript_sessions")).toEqual([{ session_id: "s9" }]);
		// A summary without a children key never gains one on readback.
		expect("children" in JSON.parse((await storage.readFile(`summaries/${H("e")}.json`)) as string)).toBe(false);
	});

	it("settles a child file written in the same batch as its reordering parent", async () => {
		await storage.writeFiles(
			[file(`summaries/${H("a")}.json`, summary(H("a"), { children: [summary(H("b")), summary(H("c"))] }))],
			"m",
		);
		// One batch: the parent swaps its children AND c's own file is refreshed.
		// c's mount-point lookup sees the offset-parked position and must strip
		// the offset so the settled order wins.
		await storage.writeFiles(
			[
				file(`summaries/${H("c")}.json`, summary(H("c"), { recap: "r" })),
				file(`summaries/${H("a")}.json`, summary(H("a"), { children: [summary(H("c")), summary(H("b"))] })),
			],
			"m",
		);
		const kids = await rows<{ commit_hash: string; child_pos: number }>(
			"SELECT commit_hash, child_pos FROM memories WHERE parent_hash = ? ORDER BY child_pos",
			H("a"),
		);
		expect(kids).toEqual([
			{ commit_hash: H("c"), child_pos: 0 },
			{ commit_hash: H("b"), child_pos: 1 },
		]);
		expect(await rows("SELECT COUNT(*) AS n FROM memories WHERE child_pos >= 1000000")).toEqual([{ n: 0 }]);
	});

	it("progress: delete, unparsable content and path-slug fallback", async () => {
		await storage.writeFiles([file("plans/p1.md", "# p1")], "m");
		// Skipped, not thrown: same one-transaction reasoning as the orphaned-plan
		// case this function already handled that way.
		await storage.writeFiles([file("plan-progress/p1.json", "{]")], "m");
		expect(await rows("SELECT COUNT(*) AS n FROM plan_progress")).toEqual([{ n: 0 }]);
		// No planSlug in the artifact: the path names the plan.
		await storage.writeFiles([file("plan-progress/p1.json", { version: 2 })], "m");
		expect(await rows("SELECT plan_slug FROM plan_progress")).toEqual([{ plan_slug: "p1" }]);
		await storage.writeFiles([{ path: "plan-progress/p1.json", content: "", delete: true }], "m");
		expect(await rows("SELECT COUNT(*) AS n FROM plan_progress")).toEqual([{ n: 0 }]);
	});

	it("tolerates unparsable index.json and a topics/index.json delete", async () => {
		await storage.writeFiles(
			[
				file(`summaries/${H("a")}.json`, summary(H("a"))),
				file("index.json", "not json"),
				{ path: "topics/index.json", content: "", delete: true },
			],
			"m",
		);
		// Nothing to harvest, nothing to break.
		expect(await rows("SELECT tree_hash FROM memories WHERE commit_hash = ?", H("a"))).toEqual([
			{ tree_hash: null },
		]);
	});

	it("defaults topic page schemaVersion and relatedBranches; plans without a memory keep no branch", async () => {
		await storage.writeFiles(
			[
				file("topics/min.json", {
					stableSlug: "min",
					title: "Min",
					content: "# m",
					sourceRefs: [{ type: "plan", id: "p", timestamp: "t" }],
					lastUpdatedAt: "2026-07-03T00:00:00.000Z",
				}),
				file("plans/loose-plan.md", "body without heading"),
			],
			"m",
		);
		expect(await rows("SELECT payload_version, related_branches_json FROM topic_pages")).toEqual([
			{ payload_version: 1, related_branches_json: "[]" },
		]);
		expect(await rows("SELECT branch, original_slug, title FROM context WHERE kind = 'plan'")).toEqual([
			{ branch: null, original_slug: null, title: null },
		]);
		expect(await rows("SELECT branch FROM topic_source_refs")).toEqual([{ branch: null }]);
	});
});

describe("optional fields absent", () => {
	it("covers index entries without treeHash, topic entries without summary, refs without url", async () => {
		await storage.writeFiles(
			[
				file(
					`summaries/${H("a")}.json`,
					summary(H("a"), { topics: [{ title: "T", category: "feature", importance: "high" }] }),
				),
				file("index.json", { version: 3, entries: [{ commitHash: H("a"), parentCommitHash: null }] }),
				file("topics/index.json", "not json"),
				file("plans/orphan-abcdef12.md", "# suffixed but matching no memory"),
			],
			"m",
		);
		expect(await rows("SELECT tree_hash FROM memories WHERE commit_hash = ?", H("a"))).toEqual([
			{ tree_hash: null },
		]);
		expect(await rows("SELECT category, importance FROM memory_topics")).toEqual([
			{ category: "feature", importance: "high" },
		]);
		expect(await rows("SELECT branch FROM context WHERE context_key = 'orphan-abcdef12'")).toEqual([
			{ branch: null },
		]);

		await storage.writeFiles(
			[
				file("topics/index.json", {
					schemaVersion: 1,
					topics: [{ stableSlug: "alpha" }, { title: "no slug", summary: "s" }],
				}),
				file("topics/norefs.json", {
					schemaVersion: 1,
					stableSlug: "norefs",
					title: "N",
					content: "# n",
					relatedBranches: [],
					lastUpdatedAt: "2026-07-03T00:00:00.000Z",
				}),
				{ path: "topics/processed.json", content: "", delete: true },
				file(
					"references/jollimemory/lookup.md",
					[
						"---",
						'source: "jollimemory"',
						'nativeId: "lookup-1"',
						'title: "Local lookup"',
						'referencedAt: "2026-07-01T00:00:00.000Z"',
						'sourceToolName: "mcp"',
						"---",
						"",
						"body",
						"",
					].join("\n"),
				),
			],
			"m",
		);
		expect(await rows("SELECT COUNT(*) AS n FROM topic_source_refs WHERE stable_slug = 'norefs'")).toEqual([
			{ n: 0 },
		]);
		// url is the one legitimately optional scalar (a jollimemory reference
		// has no external destination); sourceToolName is parser-required.
		expect(await rows("SELECT url, tool_name FROM context WHERE kind = 'reference'")).toEqual([
			{ url: null, tool_name: "mcp" },
		]);
	});
});

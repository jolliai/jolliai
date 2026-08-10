import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// import type { KnowledgeGraph } from "../graph/GraphSchema.js"; // parked with the graph case
import { withDashboardDb } from "./DashboardDb.js";
import type { CommitCreatedEvent, SessionUpsertedEvent, WorktreeStatusEvent } from "./DashboardModel.js";
import type { RegisteredRepo } from "./RepoRegistry.js";

vi.mock("./DashboardCollector.js", () => ({
	collectCommitEvents: vi.fn(),
	collectRepoGraph: vi.fn(),
	collectSessionEvents: vi.fn(),
	collectSummaryEvents: vi.fn(),
	collectWorktreeEvent: vi.fn(),
}));
vi.mock("../core/GitOps.js", () => ({
	getHeadHash: vi.fn(),
	// Backfill now imports `existingWorktrees` from RepoRegistry as a value, which
	// pulls GitRemoteUtils → execGit into the graph; a mock missing these exports
	// fails every test in the file at import time.
	execGit: vi.fn(),
	getProjectRootDir: vi.fn(),
	// The seed-legality check lists the orphan tip through GitRefStorage, which
	// reaches this export; unmocked it would spawn git against a worktree these
	// tests never create.
	listFilesInBranch: vi.fn(),
}));
vi.mock("../core/SummaryStore.js", () => ({
	getIndex: vi.fn(),
}));
vi.mock("../core/RepoProfile.js", () => ({
	readCutoverFence: vi.fn(),
}));
// The importer has its own suite (SotImport.test.ts) driven by an in-memory
// StorageProvider; here we only care that the wiring calls it and that its
// failures are isolated per repo.
// Partial, not a hand-written surface: everything except the importer itself is
// real, so a new helper Backfill starts calling (EMPTY_IMPORT_RESULT, the
// protect-timestamp resolver, …) keeps working instead of failing every test in
// this file with "no export is defined on the mock".
vi.mock("./SotImport.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./SotImport.js")>()),
	importRepoMemory: vi.fn(),
}));

import { execGit, getHeadHash, listFilesInBranch } from "../core/GitOps.js";
import { readCutoverFence } from "../core/RepoProfile.js";
import { getIndex } from "../core/SummaryStore.js";
import { backfillRepo, backfillRepos, pruneUnreachableCommits } from "./Backfill.js";
import {
	collectCommitEvents,
	collectRepoGraph,
	collectSessionEvents,
	collectSummaryEvents,
	collectWorktreeEvent,
} from "./DashboardCollector.js";
import { importRepoMemory } from "./SotImport.js";

let dir: string;
let dbPath: string;

const repo: RegisteredRepo = {
	repoIdentity: "https://github.com/jolliai/jolliai",
	repoName: "jolliai",
	worktreeRoot: "/home/dev/jolli",
	remoteUrl: "https://github.com/jolliai/jolliai",
	enabledAt: "2026-01-01T00:00:00.000Z",
};

const commitEvent = (hash: string): CommitCreatedEvent => ({
	type: "commit.created",
	repoIdentity: repo.repoIdentity,
	hash,
	committedAtMs: 1_700_000_000_000,
	message: `commit ${hash}`,
	branches: ["main"],
});

const sessionEvent: SessionUpsertedEvent = {
	type: "session.upserted",
	repoIdentity: repo.repoIdentity,
	source: "claude",
	sessionId: "s1",
	updatedAtMs: 1_700_000_050_000,
};

const worktreeEvent: WorktreeStatusEvent = {
	type: "worktree.status",
	repoIdentity: repo.repoIdentity,
	branch: "main",
	filesChanged: 1,
	insertions: 2,
	deletions: 3,
	observedAtMs: 1_700_000_060_000,
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-backfill-"));
	dbPath = join(dir, "dashboard.db");
	vi.mocked(getHeadHash).mockResolvedValue("head-1");
	// `checkoutFingerprint` reads `.exitCode`/`.stdout`; an undefined return would
	// throw inside every backfill. Empty branch-tip output is a valid answer —
	// except for the orphan-tip rev-parse, which has to resolve to a commit sha
	// or the whole memory import is (correctly) skipped as branch-less.
	vi.mocked(execGit).mockImplementation(async (args) =>
		args[0] === "rev-parse" && args[1] === "--verify"
			? { stdout: `${"ab".repeat(20)}\n`, stderr: "", exitCode: 0 }
			: { stdout: "", stderr: "", exitCode: 0 },
	);
	// An empty orphan listing keeps the seed-legality check honest: with no stored
	// memories nothing is "absent from the tip", so the mode stays `seed` unless a
	// test says otherwise.
	vi.mocked(listFilesInBranch).mockResolvedValue([]);
	vi.mocked(collectCommitEvents).mockResolvedValue([commitEvent("aaa"), commitEvent("bbb")]);
	vi.mocked(collectSessionEvents).mockResolvedValue([sessionEvent]);
	vi.mocked(collectSummaryEvents).mockResolvedValue({ events: [], complete: true });
	vi.mocked(collectWorktreeEvent).mockResolvedValue(worktreeEvent);
	// No knowledge graph by default — it is opt-in per test, like the summaries.
	vi.mocked(collectRepoGraph).mockResolvedValue(null);
	vi.mocked(importRepoMemory).mockResolvedValue({
		nodes: 0,
		updated: 0,
		commitTopics: 0,
		aliases: 0,
		transcripts: 0,
		links: 0,
		docs: 0,
		planProgress: 0,
		topics: 0,
		skipped: 0,
		pruned: 0,
	});
	// No summary store by default — the summaries sweep is opt-in per test.
	vi.mocked(getIndex).mockResolvedValue(null);
	// Not fenced for cutover by default — the orphan branch is still authoritative.
	vi.mocked(readCutoverFence).mockResolvedValue(null);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function query<T>(sql: string, ...params: unknown[]): Promise<T[]> {
	return withDashboardDb((db) => db.prepare(sql).all(...params) as T[], { dbPath });
}

describe("backfillRepo — bootstrap", () => {
	it("imports commits, sessions and worktree state, then marks the repo done", async () => {
		const result = await backfillRepo({ repo, dbPath });
		expect(result.mode).toBe("bootstrapped");
		expect(result.eventsApplied).toBe(5); // repo.enabled + 2 commits + session + worktree

		const repos = await query<{ repo_name: string; bootstrap_state: string }>(
			"SELECT repo_name, bootstrap_state FROM repos",
		);
		expect(repos).toEqual([{ repo_name: "jolliai", bootstrap_state: "done" }]);
		expect((await query("SELECT hash FROM commits")).length).toBe(2);
		expect((await query("SELECT event_id FROM sessions")).length).toBe(1);
		expect((await query("SELECT branch FROM worktree_status")).length).toBe(1);
	});

	it("records cursors: HEAD for commits, max updatedAt for sessions", async () => {
		await backfillRepo({ repo, dbPath, now: () => 42 });
		const cursors = await query<{ source: string; cursor: string }>(
			"SELECT source, cursor FROM ingest_cursors ORDER BY source",
		);
		expect(cursors).toEqual([
			// The commit cursor is per-checkout (`<path>@<head>+<branch-tips hash>`,
			// sorted) so a commit landing in a second clone — or a branch moving
			// without HEAD moving — cannot read as "nothing changed". Matched by shape
			// rather than a pinned digest of the fixture's empty ref output.
			{ source: "git-commits", cursor: expect.stringMatching(/^\/home\/dev\/jolli@head-1\+[0-9a-f]{64}$/) },
			{ source: "sessions", cursor: String(sessionEvent.updatedAtMs) },
			// The memory import's own signal: the orphan tip (a hash of everything it
			// reads) plus the mode, since seed and catch-up do not write the same rows.
			{ source: "sot-import", cursor: `${"ab".repeat(20)}#seed` },
		]);
	});

	// PARKED with `repo_graphs` and Backfill's call site (see SotSchema): the
	// graph page was removed, so the artifact is collected and stored by
	// nothing. Restore this case together with the three of them.
	// it("imports the repo's knowledge-graph artifact alongside everything else", async () => {
	// vi.mocked(collectRepoGraph).mockResolvedValue({
	// schemaVersion: 1,
	// generatedAt: "2026-07-29T10:00:00.000Z",
	// source: "jolli",
	// topicFingerprints: {},
	// topicMetaFingerprints: {},
	// // Counts come from the ARRAYS, not from `stats` — stats is a rollup the
	// // builder writes and could lag; the arrays are the artifact itself.
	// stats: { categories: 9, topics: 9, units: 9, edges: 9, intraTopicEdges: 9 },
	// categories: [{ id: "c1" }],
	// topics: [{ slug: "t1" }, { slug: "t2" }],
	// units: [{ id: "u1" }, { id: "u2" }, { id: "u3" }],
	// edges: [{ from: "u1", to: "u2" }],
	// coChangeTopicEdges: [],
	// } as unknown as KnowledgeGraph);
	// await backfillRepo({ repo, dbPath });
	// const row = await withDashboardDb(
	// (db) =>
	// db
	// .prepare(
	// "SELECT r.repo_identity, g.generated_at, g.topics, g.units FROM repo_graphs g JOIN repos r ON r.id = g.repo_id",
	// )
	// .get() as Record<string, unknown>,
	// { dbPath },
	// );
	// // The counts are indexed alongside the blob so a caller can size the graph
	// // without parsing a few hundred KB of JSON.
	// expect(row).toEqual({
	// repo_identity: repo.repoIdentity,
	// generated_at: "2026-07-29T10:00:00.000Z",
	// topics: 2,
	// units: 3,
	// });
	// });

	it("is idempotent — running twice does not duplicate rows", async () => {
		await backfillRepo({ repo, dbPath });
		vi.mocked(getHeadHash).mockResolvedValue("head-2"); // force a re-collect
		await backfillRepo({ repo, dbPath });
		expect((await query("SELECT hash FROM commits")).length).toBe(2);
	});

	// The write-ahead log's retention pass rides `applyStatsEvents`, which this
	// path does not use (it calls `applyToDb` directly to stay inside one
	// handle). `events_raw.event_id` is deliberately not unique, so without a
	// prune of its own a machine that only ever runs `jolli dashboard` grows the
	// log forever.
	it("prunes aged projected events on the way out", async () => {
		const OLD = new Date(Date.parse("2026-01-01T00:00:00Z")).toISOString();
		await withDashboardDb(
			(db) => {
				db.prepare(
					`INSERT INTO events_raw (event_id, repo_identity, type, schema_version, received_at,
					                         data_json, projection_status)
					 VALUES ('stale', ?, 'session.upserted', 1, ?, '{}', 'projected')`,
				).run(repo.repoIdentity, OLD);
			},
			{ dbPath },
		);
		expect((await query("SELECT event_id FROM events_raw WHERE event_id = 'stale'")).length).toBe(1);

		await backfillRepo({ repo, dbPath, now: () => Date.parse("2026-08-09T00:00:00Z") });

		expect((await query("SELECT event_id FROM events_raw WHERE event_id = 'stale'")).length).toBe(0);
	});

	// `pending` and `failed` are never pruned regardless of age: pending is the
	// crash-recovery record a later writer drains, failed is the evidence.
	it("leaves aged pending and failed events alone", async () => {
		const OLD = new Date(Date.parse("2026-01-01T00:00:00Z")).toISOString();
		await withDashboardDb(
			(db) => {
				for (const status of ["pending", "failed"]) {
					db.prepare(
						`INSERT INTO events_raw (event_id, repo_identity, type, schema_version, received_at,
						                         data_json, projection_status)
						 VALUES (?, ?, 'unknown.type', 1, ?, '{}', ?)`,
					).run(status, repo.repoIdentity, OLD, status);
				}
			},
			{ dbPath },
		);

		await backfillRepo({ repo, dbPath, now: () => Date.parse("2026-08-09T00:00:00Z") });

		const kept = await query<{ event_id: string }>(
			"SELECT event_id FROM events_raw WHERE event_id IN ('pending','failed') ORDER BY event_id",
		);
		expect(kept.map((r) => r.event_id)).toEqual(["failed", "pending"]);
	});
});

describe("backfillRepo — recovery", () => {
	it("skips the git sweep when HEAD matches the cursor", async () => {
		await backfillRepo({ repo, dbPath });
		vi.mocked(collectCommitEvents).mockClear();
		const result = await backfillRepo({ repo, dbPath });
		expect(collectCommitEvents).not.toHaveBeenCalled();
		// Sessions and worktree are still re-projected (idempotent, cheap).
		expect(collectSessionEvents).toHaveBeenCalledTimes(2);
		expect(result.mode).toBe("recovered");
	});

	it("re-sweeps when a branch tip moves without HEAD moving", async () => {
		await backfillRepo({ repo, dbPath });
		vi.mocked(collectCommitEvents).mockClear();
		// Same HEAD, different branch tips — a branch that is not the checked-out one
		// was deleted, rebased or gained a commit. A HEAD-only cursor read this as
		// "nothing changed", so prune never ran and branch reachability went stale.
		vi.mocked(execGit).mockResolvedValue({
			stdout: "refs/heads/main aaa\nrefs/heads/feature/x ddd\n",
			stderr: "",
			exitCode: 0,
		});
		await backfillRepo({ repo, dbPath });
		expect(collectCommitEvents).toHaveBeenCalled();
	});

	it("does NOT re-sweep when only Jolli's own storage ref moved", async () => {
		// The orphan branch gains a commit on every memory write — a commit, a
		// regenerate, a plan edit, a squash consolidation — and it lives under
		// refs/heads like any other branch. Hashing its tip meant this cursor could
		// never converge in a repo that is actually being used, so `jolli dashboard`
		// re-swept git history on essentially every launch. Its commits are not
		// collected either, so a tip this ignores cannot change a row.
		const tips = (orphan: string) => async (args: ReadonlyArray<string>) =>
			args[0] === "rev-parse" && args[1] === "--verify"
				? { stdout: `${"ab".repeat(20)}\n`, stderr: "", exitCode: 0 }
				: {
						stdout: `refs/heads/main aaa\nrefs/heads/jollimemory/summaries/v3 ${orphan}\n`,
						stderr: "",
						exitCode: 0,
					};
		vi.mocked(execGit).mockImplementation(tips("mem-1"));
		await backfillRepo({ repo, dbPath });
		vi.mocked(collectCommitEvents).mockClear();
		vi.mocked(execGit).mockImplementation(tips("mem-2"));
		await backfillRepo({ repo, dbPath });
		expect(collectCommitEvents).not.toHaveBeenCalled();
	});

	it("projects only the commits a re-sweep actually changed", async () => {
		// The daily case: a commit lands on the branch being worked on. The sweep has
		// to LIST every reachable commit (the prune is computed against that set, and
		// branch reachability changes for old commits whenever a branch moves), but
		// projecting the unchanged ones re-ran an UPSERT + DELETE + re-INSERT per
		// commit to arrive at the bytes already there. Measured on a real 2.5k-commit
		// repo: one new commit went from 2457 projections to 1.
		await backfillRepo({ repo, dbPath });
		// A pass with nothing to do still re-projects the always-on tiers, so THAT is
		// the baseline to compare against rather than a hard-coded count.
		const idle = await backfillRepo({ repo, dbPath });
		vi.mocked(getHeadHash).mockResolvedValue("head-2");
		vi.mocked(collectCommitEvents).mockResolvedValue([commitEvent("aaa"), commitEvent("bbb"), commitEvent("ccc")]);
		const result = await backfillRepo({ repo, dbPath });
		// Exactly one more: `ccc`. `aaa` and `bbb` are listed by the sweep and used
		// for the prune, but neither reaches the projection.
		expect(result.eventsApplied).toBe(idle.eventsApplied + 1);
		const hashes = (await query<{ hash: string }>("SELECT hash FROM commits ORDER BY hash")).map((r) => r.hash);
		expect(hashes).toEqual(["aaa", "bbb", "ccc"]);
	});

	it("re-projects a commit whose branch reachability changed", async () => {
		// `branches` is replace-when-present, so a stale set is a wrong answer to
		// "group by branch" — this is the one field that legitimately changes for an
		// OLD commit, and skipping it is what a naive "already stored" test would do.
		await backfillRepo({ repo, dbPath });
		vi.mocked(getHeadHash).mockResolvedValue("head-2");
		vi.mocked(collectCommitEvents).mockResolvedValue([
			{ ...commitEvent("aaa"), branches: ["main", "feature/x"] },
			commitEvent("bbb"),
		]);
		await backfillRepo({ repo, dbPath });
		const names = (
			await query<{ name: string }>(
				`SELECT b.name FROM commit_branches cb
				   JOIN branches b ON b.id = cb.branch_id
				   JOIN commits c  ON c.id = cb.commit_id
				  WHERE c.hash = 'aaa' ORDER BY b.name`,
			)
		).map((r) => r.name);
		expect(names).toEqual(["feature/x", "main"]);
	});

	it("re-offers a commit whose file rows were never collected", async () => {
		// `knownHashes` is what the collector skips its `--numstat` for, and it means
		// "file rows ARE stored", not "the commit row exists". A numstat that failed
		// once leaves the commit stored with no `commit_files` rows; keying the skip
		// off the commit row made that gap permanent, because the only pass that
		// re-scanned everything was a bootstrap and `bootstrap_state` never returns
		// to that. Here `aaa` collected its files and `bbb` did not.
		vi.mocked(collectCommitEvents).mockResolvedValue([
			{ ...commitEvent("aaa"), files: [{ path: "src/a.ts", insertions: 1, deletions: 0 }] },
			commitEvent("bbb"),
		]);
		await backfillRepo({ repo, dbPath });
		vi.mocked(collectCommitEvents).mockClear();

		vi.mocked(getHeadHash).mockResolvedValue("head-2");
		await backfillRepo({ repo, dbPath });

		const known = vi.mocked(collectCommitEvents).mock.calls[0]?.[0].knownHashes;
		expect([...(known ?? [])]).toEqual(["aaa"]);
	});

	it("prunes commits that a rewrite made unreachable (set reconciliation)", async () => {
		await backfillRepo({ repo, dbPath });
		// Rebase: bbb rewritten to ccc, HEAD moved.
		vi.mocked(getHeadHash).mockResolvedValue("head-2");
		vi.mocked(collectCommitEvents).mockResolvedValue([commitEvent("aaa"), commitEvent("ccc")]);
		await backfillRepo({ repo, dbPath });
		const hashes = (await query<{ hash: string }>("SELECT hash FROM commits ORDER BY hash")).map((r) => r.hash);
		expect(hashes).toEqual(["aaa", "ccc"]);
	});

	it("keeps every commit and the cursor when a checkout's collection FAILS", async () => {
		// The 10 MB `execGit` stdout cap reports overflow as exit 1, and the collector
		// used to answer that with []. The caller reads [] as "this repo reaches no
		// commits", so the prune wiped the commit layer (with its CASCADEs) — and then
		// advanced the cursor, so the next pass skipped collection entirely and the
		// blank persisted until some unrelated ref moved.
		await backfillRepo({ repo, dbPath });
		const before = await query<{ hash: string }>("SELECT hash FROM commits ORDER BY hash");
		const cursorBefore = await query<{ cursor: string }>("SELECT cursor FROM ingest_cursors WHERE source = 'git'");

		vi.mocked(getHeadHash).mockResolvedValue("head-2");
		vi.mocked(collectCommitEvents).mockRejectedValue(new Error("git log failed: stdout limit exceeded"));
		await backfillRepo({ repo, dbPath });

		expect(await query<{ hash: string }>("SELECT hash FROM commits ORDER BY hash")).toEqual(before);
		// Cursor unmoved, so the next pass re-collects instead of trusting the gap.
		expect(await query<{ cursor: string }>("SELECT cursor FROM ingest_cursors WHERE source = 'git'")).toEqual(
			cursorBefore,
		);
	});

	it("still recovers sessions when HEAD is unreadable (worktree gone mid-run)", async () => {
		vi.mocked(getHeadHash).mockRejectedValue(new Error("not a repo"));
		const result = await backfillRepo({ repo, dbPath });
		expect(result.mode).toBe("bootstrapped");
		expect((await query("SELECT event_id FROM sessions")).length).toBe(1);
		// No commit cursor written without a HEAD to anchor it. The memory import's
		// cursor is unaffected — it is anchored on the orphan tip, which resolves
		// whether or not HEAD does.
		const cursors = await query<{ source: string }>("SELECT source FROM ingest_cursors ORDER BY source");
		expect(cursors).toEqual([{ source: "sessions" }, { source: "sot-import" }]);
	});

	it("skips the worktree event when the collector returns null", async () => {
		vi.mocked(collectWorktreeEvent).mockResolvedValue(null);
		await backfillRepo({ repo, dbPath });
		expect(await query("SELECT branch FROM worktree_status")).toEqual([]);
	});
});

describe("pruneUnreachableCommits", () => {
	it("returns 0 and writes nothing when everything is reachable", async () => {
		await backfillRepo({ repo, dbPath });
		const pruned = await withDashboardDb(
			(db) => pruneUnreachableCommits(db, repo.repoIdentity, new Set(["aaa", "bbb"])),
			{ dbPath },
		);
		expect(pruned).toBe(0);
	});

	it("cascades: pruning a commit removes its branch links", async () => {
		await backfillRepo({ repo, dbPath });
		const pruned = await withDashboardDb((db) => pruneUnreachableCommits(db, repo.repoIdentity, new Set(["aaa"])), {
			dbPath,
		});
		expect(pruned).toBe(1);
		const links = await query<{ commit_id: number }>("SELECT commit_id FROM commit_branches");
		// The surviving link belongs to the commit that stayed reachable; the pruned
		// commit's rows went with it through the foreign key, no trigger involved.
		expect(links).toEqual([{ commit_id: expect.any(Number) }]);
	});
});

describe("backfillRepos", () => {
	it("continues past a repo whose backfill throws", async () => {
		const broken: RegisteredRepo = {
			...repo,
			repoIdentity: "local:broken",
			repoName: "broken",
			worktreeRoot: "/gone",
		};
		vi.mocked(collectSessionEvents).mockImplementation(async (opts) => {
			if (opts.repoIdentity === "local:broken") throw new Error("worktree deleted");
			return [sessionEvent];
		});
		const results = await backfillRepos([broken, repo], { dbPath });
		expect(results).toHaveLength(2);
		// `repoName` and `error` ride on every result now: a repo that failed to
		// import used to reach the log and nothing else, so the caller had no way to
		// name it on screen.
		expect(results[0]).toEqual({
			mode: "skipped",
			eventsApplied: 0,
			repoName: "broken",
			error: expect.stringContaining("worktree deleted"),
		});
		expect(results[1].mode).toBe("bootstrapped");
	});
});

describe("backfillRepo — SOT import wiring (v7)", () => {
	it("runs the importer for the repo and reports its row counts", async () => {
		vi.mocked(importRepoMemory).mockResolvedValue({
			nodes: 3,
			updated: 3,
			commitTopics: 0,
			aliases: 1,
			transcripts: 2,
			links: 2,
			docs: 4,
			planProgress: 1,
			topics: 1,
			skipped: 0,
			pruned: 2,
		});

		const result = await backfillRepo({ repo, dbPath, now: () => 4242 });

		expect(result.sotImport).toMatchObject({ nodes: 3, docs: 4, planProgress: 1, pruned: 2 });
		expect(importRepoMemory).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ repo, nowMs: 4242 }),
		);
	});

	it("forwards an injected storage provider so the importer never spawns git", async () => {
		// `listFiles` is not decoration: the seed-legality check lists the source
		// before it picks a mode, so a provider stub without it never reaches the
		// importer at all.
		const storage = { kind: "orphan-branch" as const, listFiles: async () => [] } as never;
		await backfillRepo({ repo, dbPath, storage });
		expect(importRepoMemory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ storage }));
	});

	it("imports in seed mode while the repo has never been fenced for cutover", async () => {
		await backfillRepo({ repo, dbPath });
		expect(importRepoMemory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mode: "seed" }));
	});

	it("imports in catch-up mode when the project has more than one checkout", async () => {
		// `seed` reconciles against ONE checkout's orphan branch while `repo_id` is
		// shared by every clone of the identity, so it deleted the memories only the
		// other clone had. The commit tier merges every checkout before pruning; the
		// importer reads a single pinned provider and cannot, so it drops to the
		// never-deleting mode. A stale row beats a deletion nobody asked for — the
		// same trade the missing-orphan-tip case already makes.
		const a = mkdtempSync(join(tmpdir(), "jolli-wt-a-"));
		const b = mkdtempSync(join(tmpdir(), "jolli-wt-b-"));
		try {
			await backfillRepo({ repo: { ...repo, worktrees: [a, b] }, dbPath });
			expect(importRepoMemory).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ mode: "catch-up" }),
			);
		} finally {
			rmSync(a, { recursive: true, force: true });
			rmSync(b, { recursive: true, force: true });
		}
	});

	it("imports in catch-up mode once the repo is fenced for cutover, never seed", async () => {
		// Fenced: new memories now land in SQLite only. Seed's delete-based
		// reconciliation reading the now-frozen orphan branch would treat every
		// one of them as "removed from the branch" and prune them right back out.
		vi.mocked(readCutoverFence).mockResolvedValue({ reason: "cutover", at: "2026-08-06T00:00:00.000Z" });
		await backfillRepo({ repo, dbPath });
		expect(importRepoMemory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mode: "catch-up" }));
	});

	it("skips the memory import entirely when the orphan tip has not moved", async () => {
		// The import is not free just because it converges: a seed pass shifts every
		// child_pos, re-upserts every row and rewrites every topic and link row —
		// seconds of every `jolli dashboard`, on a source that has not changed a
		// byte. The tip is a hash of that whole source, so "unchanged tip" is an
		// exact answer, not a heuristic.
		await backfillRepo({ repo, dbPath });
		vi.mocked(importRepoMemory).mockClear();

		const result = await backfillRepo({ repo, dbPath });

		expect(importRepoMemory).not.toHaveBeenCalled();
		// The count still has to be right: the caller prints it, and a zero here
		// reads as "your memories are gone" on a healthy repo.
		expect(result.sotImport).toMatchObject({ nodes: 0, updated: 0 });
	});

	it("re-imports once the orphan tip moves", async () => {
		await backfillRepo({ repo, dbPath });
		vi.mocked(importRepoMemory).mockClear();
		vi.mocked(execGit).mockImplementation(async (args) =>
			args[0] === "rev-parse" && args[1] === "--verify"
				? { stdout: `${"cd".repeat(20)}\n`, stderr: "", exitCode: 0 }
				: { stdout: "", stderr: "", exitCode: 0 },
		);

		await backfillRepo({ repo, dbPath });

		expect(importRepoMemory).toHaveBeenCalledTimes(1);
	});

	it("re-imports when the mode changes under a standing tip", async () => {
		// A repo that gains a fence (or a second checkout) switches to catch-up
		// without the branch moving, and the two modes do not write the same rows —
		// seed reconciles, catch-up never deletes. A tip-only cursor would skip the
		// one pass where the difference matters.
		await backfillRepo({ repo, dbPath });
		vi.mocked(importRepoMemory).mockClear();
		vi.mocked(readCutoverFence).mockResolvedValue({ reason: "cutover", at: "2026-08-06T00:00:00.000Z" });

		await backfillRepo({ repo, dbPath });

		expect(importRepoMemory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mode: "catch-up" }));
	});

	it("keeps re-importing while the bootstrap has never completed", async () => {
		// The cursor lives in the database it guards, but a database can be restored
		// or half-built; a repo still marked pending has not proven its rows are
		// there, and a wrong skip costs the repo's memories while a wrong import
		// costs one pass.
		await backfillRepo({ repo, dbPath });
		await withDashboardDb(
			(db) => {
				db.prepare("UPDATE repos SET bootstrap_state = 'pending'").run();
			},
			{ dbPath },
		);
		vi.mocked(importRepoMemory).mockClear();

		await backfillRepo({ repo, dbPath });

		expect(importRepoMemory).toHaveBeenCalledTimes(1);
	});

	it("isolates an importer failure to its own repo", async () => {
		const other: RegisteredRepo = { ...repo, repoIdentity: "local:other", repoName: "other" };
		vi.mocked(importRepoMemory).mockImplementation(async (_db, opts) => {
			if (opts.repo.repoIdentity === repo.repoIdentity) throw new Error("orphan branch unreadable");
			return {
				nodes: 1,
				updated: 1,
				commitTopics: 0,
				aliases: 0,
				transcripts: 0,
				links: 0,
				docs: 0,
				planProgress: 0,
				topics: 0,
				skipped: 0,
				pruned: 0,
			};
		});

		const results = await backfillRepos([repo, other], { dbPath });

		expect(results[0]).toEqual({
			mode: "skipped",
			eventsApplied: 0,
			repoName: "jolliai",
			error: expect.stringContaining("orphan branch unreadable"),
		});
		expect(results[1].mode).toBe("bootstrapped");
		expect(results[1].sotImport?.nodes).toBe(1);
	});
});

describe("backfillRepo — summaries sweep (memory tier)", () => {
	const summaryEvent = {
		type: "commit.summary" as const,
		repoIdentity: repo.repoIdentity,
		hash: "aaa",
		committedAtMs: 1_700_000_000_000,
		turns: 6,
		tokens: 4200,
		estCostUsd: 1.2,
		ticketId: "JOLLI-2069",
		insights: [{ kind: "decision" as const, text: "chose sqlite" }],
		references: [],
		sessionLinks: [],
	};

	it("sweeps summaries during bootstrap and enriches the commit row", async () => {
		vi.mocked(getIndex).mockResolvedValue({ version: 3, entries: [] });
		vi.mocked(collectSummaryEvents).mockResolvedValue({ events: [summaryEvent], complete: true });

		await backfillRepo({ repo, dbPath });

		// The enrichment copies are gone (A3b): the sweep's job is the commits
		// row; turns/ticket/insights live on the memory tables, which the
		// backfill's own memory import fills from the orphan branch.
		const commits = await query<{ hash: string }>("SELECT hash FROM commits WHERE hash = 'aaa'");
		expect(commits).toEqual([{ hash: "aaa" }]);
	});

	it("skips the sweep when the index fingerprint is unchanged, re-sweeps when it changes", async () => {
		vi.mocked(getIndex).mockResolvedValue({ version: 3, entries: [] });
		vi.mocked(collectSummaryEvents).mockResolvedValue({ events: [summaryEvent], complete: true });

		await backfillRepo({ repo, dbPath });
		expect(collectSummaryEvents).toHaveBeenCalledTimes(1);

		// Same index content → recovery skips the expensive summary read.
		await backfillRepo({ repo, dbPath });
		expect(collectSummaryEvents).toHaveBeenCalledTimes(1);

		// Index changed (new summary stored) → sweep again.
		vi.mocked(getIndex).mockResolvedValue({
			version: 3,
			entries: [
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "m",
					commitDate: "2026-07-30T00:00:00Z",
					branch: "main",
					generatedAt: "2026-07-30T00:01:00Z",
				},
			],
		});
		await backfillRepo({ repo, dbPath });
		expect(collectSummaryEvents).toHaveBeenCalledTimes(2);
	});

	it("skips the sweep entirely when there is no summary index", async () => {
		await backfillRepo({ repo, dbPath });
		expect(collectSummaryEvents).not.toHaveBeenCalled();
	});

	// The cursor is the index's content hash, so advancing it after a partial
	// sweep makes every later pass skip collection outright — one transient
	// `git show` failure would hide that memory from the dashboard forever.
	it("does not advance the summaries cursor after an incomplete sweep", async () => {
		vi.mocked(getIndex).mockResolvedValue({ version: 3, entries: [] });
		vi.mocked(collectSummaryEvents).mockResolvedValue({ events: [summaryEvent], complete: false });

		await backfillRepo({ repo, dbPath });
		expect(collectSummaryEvents).toHaveBeenCalledTimes(1);

		// Same index content, but the cursor never moved — so the next pass
		// re-reads instead of trusting an incomplete result.
		await backfillRepo({ repo, dbPath });
		expect(collectSummaryEvents).toHaveBeenCalledTimes(2);

		// A clean sweep finally parks it.
		vi.mocked(collectSummaryEvents).mockResolvedValue({ events: [summaryEvent], complete: true });
		await backfillRepo({ repo, dbPath });
		expect(collectSummaryEvents).toHaveBeenCalledTimes(3);
		await backfillRepo({ repo, dbPath });
		expect(collectSummaryEvents).toHaveBeenCalledTimes(3);
	});

	it("announces the sweep only when it is going to run", async () => {
		// The marker is the caller's evidence that something is worth narrating, so
		// a skipped sweep has to be silent — announcing "Indexing stored memories…"
		// and then doing nothing is what made every launch look like a re-migration.
		vi.mocked(getIndex).mockResolvedValue({ version: 3, entries: [] });
		vi.mocked(collectSummaryEvents).mockResolvedValue({ events: [summaryEvent], complete: true });
		const kinds = async (): Promise<string[]> => {
			const seen: string[] = [];
			await backfillRepo({
				repo,
				dbPath,
				onProgress: (p) => {
					if (p.done === 0) seen.push(p.kind);
				},
			});
			return seen;
		};

		expect(await kinds()).toContain("summaries");
		// Second pass: same index, so the sweep is gated out — and unannounced.
		expect(await kinds()).not.toContain("summaries");
	});
});

describe("multiple checkouts of one project (§10.2)", () => {
	it("collects from every existing worktree and prunes against the union", async () => {
		// Two checkouts of one project: each has a commit the other lacks. Before
		// this fix only `worktreeRoot` was swept, so the other clone's commit never
		// arrived — and pruning per worktree would have deleted it on every pass.
		const a = mkdtempSync(join(tmpdir(), "jolli-wt-a-"));
		const b = mkdtempSync(join(tmpdir(), "jolli-wt-b-"));
		try {
			vi.mocked(collectCommitEvents).mockImplementation(async ({ cwd }) => [
				{
					type: "commit.created" as const,
					repoIdentity: repo.repoIdentity,
					hash: cwd === a ? "only-in-a" : "only-in-b",
					committedAtMs: 1_700_000_000_000,
				},
			]);

			await backfillRepo({ repo: { ...repo, worktrees: [a, b] }, dbPath });

			const hashes = await withDashboardDb(
				(db) =>
					(db.prepare("SELECT hash FROM commits ORDER BY hash").all() as Array<{ hash: string }>).map(
						(r) => r.hash,
					),
				{ dbPath },
			);
			expect(hashes).toEqual(["only-in-a", "only-in-b"]);
		} finally {
			rmSync(a, { recursive: true, force: true });
			rmSync(b, { recursive: true, force: true });
		}
	});

	it("unions branch reachability for a commit both checkouts can see", async () => {
		// The regression this pins: `commit.created` replaces the stored branch set
		// (that is how a deleted branch is pruned), so applying each checkout's
		// events in turn left only the LAST sweep's branches — silently wiping
		// branch names known only to the other clone. Observed live on two clones
		// of one remote: 7 of 26 branches unique to the second checkout vanished,
		// specifically the old merged ones whose commits the first clone also has.
		const a = mkdtempSync(join(tmpdir(), "jolli-wt-a-"));
		const b = mkdtempSync(join(tmpdir(), "jolli-wt-b-"));
		try {
			vi.mocked(collectCommitEvents).mockImplementation(async ({ cwd }) => [
				{
					type: "commit.created" as const,
					repoIdentity: repo.repoIdentity,
					hash: "shared",
					committedAtMs: 1_700_000_000_000,
					branches: cwd === a ? ["main", "only-a"] : ["main", "only-b"],
				},
			]);

			await backfillRepo({ repo: { ...repo, worktrees: [a, b] }, dbPath });

			const branches = await withDashboardDb(
				(db) =>
					(
						db
							.prepare(
								"SELECT b.name AS branch FROM commit_branches cb JOIN branches b ON b.id = cb.branch_id ORDER BY b.name",
							)
							.all() as Array<{
							branch: string;
						}>
					).map((r) => r.branch),
				{ dbPath },
			);
			expect(branches).toEqual(["main", "only-a", "only-b"]);
		} finally {
			rmSync(a, { recursive: true, force: true });
			rmSync(b, { recursive: true, force: true });
		}
	});

	it("emits no branches at all when one checkout reported none", async () => {
		// `branches` absent means "that checkout's branch scan was incomplete — keep
		// what is stored", so a union built from one contributor is a PARTIAL claim,
		// and the projection replaces the set with it. Writing it would drop the
		// branches only the unreadable checkout knew; the merged event therefore
		// stays silent and a later complete sweep fills the attribution in.
		const a2 = mkdtempSync(join(tmpdir(), "jolli-wt-a-"));
		const b2 = mkdtempSync(join(tmpdir(), "jolli-wt-b-"));
		try {
			vi.mocked(collectCommitEvents).mockImplementation(async ({ cwd }) => [
				{
					type: "commit.created" as const,
					repoIdentity: repo.repoIdentity,
					hash: "shared",
					committedAtMs: 1_700_000_000_000,
					...(cwd === a2 ? { branches: ["only-a"] } : {}),
				},
			]);

			await backfillRepo({ repo: { ...repo, worktrees: [a2, b2] }, dbPath });

			const branches = await withDashboardDb(
				(db) =>
					(
						db
							.prepare(
								"SELECT b.name AS branch FROM commit_branches cb JOIN branches b ON b.id = cb.branch_id",
							)
							.all() as Array<{ branch: string }>
					).map((r) => r.branch),
				{ dbPath },
			);
			expect(branches).toEqual([]);
		} finally {
			rmSync(a2, { recursive: true, force: true });
			rmSync(b2, { recursive: true, force: true });
		}
	});

	it("keeps the stored branch set when NEITHER checkout could attribute the commit", async () => {
		// The regression: the merge wrote `branches` unconditionally, so two omissions
		// unioned into `[]` — and `[]` is the meaningful claim "no branch reaches this
		// commit", which deletes every commit_branches row. A repo with two checkouts
		// and one failed `for-each-ref` (or a MAX_BRANCHES truncation) lost its whole
		// branch attribution on the next sweep.
		const a3 = mkdtempSync(join(tmpdir(), "jolli-wt-a-"));
		const b3 = mkdtempSync(join(tmpdir(), "jolli-wt-b-"));
		try {
			// Pass 1: both checkouts attribute the commit, so the set lands.
			vi.mocked(collectCommitEvents).mockImplementation(async () => [
				{
					type: "commit.created" as const,
					repoIdentity: repo.repoIdentity,
					hash: "shared",
					committedAtMs: 1_700_000_000_000,
					branches: ["main"],
				},
			]);
			await backfillRepo({ repo: { ...repo, worktrees: [a3, b3] }, dbPath });

			// Pass 2: neither checkout's branch scan completed.
			vi.mocked(collectCommitEvents).mockImplementation(async () => [
				{
					type: "commit.created" as const,
					repoIdentity: repo.repoIdentity,
					hash: "shared",
					committedAtMs: 1_700_000_000_000,
					message: "touched, so the row is re-projected",
				},
			]);
			await backfillRepo({ repo: { ...repo, worktrees: [a3, b3] }, dbPath });

			const branches = await withDashboardDb(
				(db) =>
					(
						db
							.prepare(
								"SELECT b.name AS branch FROM commit_branches cb JOIN branches b ON b.id = cb.branch_id",
							)
							.all() as Array<{ branch: string }>
					).map((r) => r.branch),
				{ dbPath },
			);
			expect(branches).toEqual(["main"]);
		} finally {
			rmSync(a3, { recursive: true, force: true });
			rmSync(b3, { recursive: true, force: true });
		}
	});

	it("builds the commit cursor from every checkout, so a commit in either invalidates it", async () => {
		const a = mkdtempSync(join(tmpdir(), "jolli-wt-a-"));
		const b = mkdtempSync(join(tmpdir(), "jolli-wt-b-"));
		try {
			vi.mocked(getHeadHash).mockImplementation(async (cwd?: string) => (cwd === a ? "head-a" : "head-b"));
			// Branch tips unreadable → documented degradation to HEAD alone, which
			// keeps this assertion about the per-checkout composition, not hashing.
			vi.mocked(execGit).mockResolvedValue({ stdout: "", stderr: "", exitCode: 1 });

			await backfillRepo({ repo: { ...repo, worktrees: [a, b] }, dbPath });

			const cursor = await withDashboardDb(
				(db) =>
					(
						db.prepare("SELECT cursor FROM ingest_cursors WHERE source = 'git-commits'").get() as {
							cursor: string;
						}
					).cursor,
				{ dbPath },
			);
			// Sorted `<path>@<head>` pairs: a new commit in either checkout changes it.
			expect(cursor).toBe([`${a}@head-a`, `${b}@head-b`].sort().join(" "));
		} finally {
			rmSync(a, { recursive: true, force: true });
			rmSync(b, { recursive: true, force: true });
		}
	});
});

/**
 * The progress channel. Its whole reason to exist is the measured shape of a
 * first run: ~64 s of scanning against ~3 s of migrating, so the SCANS are what
 * the user has to be told about. Each is announced with a `done: 0` marker
 * before it runs, because a phase that reports only on completion cannot break
 * the silence during it.
 */
describe("backfillRepo — progress", () => {
	it("announces every phase before it runs, and forwards the importer's counter", async () => {
		vi.mocked(importRepoMemory).mockImplementation(async (_db, opts) => {
			opts.onProgress?.({ done: 1, total: 2 });
			opts.onProgress?.({ done: 2, total: 2 });
			return {
				nodes: 2,
				updated: 2,
				commitTopics: 0,
				aliases: 0,
				transcripts: 0,
				links: 0,
				docs: 0,
				planProgress: 0,
				topics: 0,
				skipped: 0,
				pruned: 0,
			};
		});
		const seen: Array<{ kind: string; done: number; total?: number; detail?: string }> = [];
		await backfillRepo({
			repo,
			dbPath,
			onProgress: (p) =>
				seen.push({
					kind: p.kind,
					done: p.done,
					...(p.total !== undefined ? { total: p.total } : {}),
					...(p.detail ? { detail: p.detail } : {}),
				}),
		});

		// Phase order is the execution order, and each slow phase leads with a
		// zero-count marker — but only a phase that is actually going to run. No
		// readable index here (`getIndex` → null), so the summary sweep is skipped
		// and stays silent; the caller reads a marker as "there is work worth
		// narrating" and decides whether to show its progress block at all.
		expect(seen.filter((p) => p.done === 0).map((p) => p.kind)).toEqual(["commits", "sessions"]);
		// The importer's per-memory events arrive tagged as this repo's.
		expect(seen.filter((p) => p.kind === "memories")).toEqual([
			{ kind: "memories", done: 1, total: 2 },
			{ kind: "memories", done: 2, total: 2 },
		]);
	});

	it("names each checkout, because each one pays its own git scan", async () => {
		// A second checkout doubles the longest silence of the run (measured 11 s
		// and 20 s on this machine's two), so the two must be distinguishable.
		// Real directories: `existingWorktrees` drops paths that are not on disk,
		// so a fabricated pair collapses back to one checkout and the test would
		// pass for the wrong reason.
		const a = mkdtempSync(join(tmpdir(), "jolli-wt-a-"));
		const b = mkdtempSync(join(tmpdir(), "jolli-wt-b-"));
		try {
			const seen: string[] = [];
			await backfillRepo({
				repo: { ...repo, worktrees: [a, b] },
				dbPath,
				onProgress: (p) => {
					if (p.kind === "commits" && p.done === 0) seen.push(p.detail ?? "(none)");
				},
			});
			expect(seen).toEqual(["checkout 1 of 2", "checkout 2 of 2"]);
		} finally {
			rmSync(a, { recursive: true, force: true });
			rmSync(b, { recursive: true, force: true });
		}
	});

	it("omits the checkout qualifier when there is only one", async () => {
		const seen: Array<string | undefined> = [];
		await backfillRepo({
			repo,
			dbPath,
			onProgress: (p) => {
				if (p.kind === "commits" && p.done === 0) seen.push(p.detail);
			},
		});
		expect(seen).toEqual([undefined]);
	});

	it("backfillRepos stamps each repo's place in the run", async () => {
		const other: RegisteredRepo = { ...repo, repoIdentity: "https://example.com/other.git", repoName: "other" };
		const seen: Array<{ repoName: string; repoIndex: number; repoTotal: number }> = [];
		await backfillRepos([repo, other], {
			dbPath,
			onProgress: (p) => seen.push({ repoName: p.repoName, repoIndex: p.repoIndex, repoTotal: p.repoTotal }),
		});
		expect(seen.some((p) => p.repoName === "jolliai" && p.repoIndex === 1 && p.repoTotal === 2)).toBe(true);
		expect(seen.some((p) => p.repoName === "other" && p.repoIndex === 2 && p.repoTotal === 2)).toBe(true);
	});

	it("runs unchanged when no callback is supplied", async () => {
		const result = await backfillRepo({ repo, dbPath });
		expect(result.mode).toBe("bootstrapped");
	});
});

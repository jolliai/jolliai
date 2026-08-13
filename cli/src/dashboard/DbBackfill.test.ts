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
	// A pure key builder, not a seam: the backfill maps every session event through
	// it to report which sessions a pass processed. A `vi.fn()` here returns
	// undefined and the map throws, which this whole-module factory turns into
	// `mode: "skipped"` on every repo rather than into a readable failure. Its real
	// behaviour is pinned by DashboardCollector.test.ts.
	sessionPassKey: (source: string, sessionId: string) => `${source}:${sessionId}`,
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
	// The commit tier's branch-attribution read is threaded from here now. Left
	// unmocked it is `undefined` and every test in this file dies on the call, so
	// the identity default doubles as the assertion target for the seam below.
	resolveReadStorage: vi.fn(),
}));
// `dbBackfillRepos` scans `~/.claude/projects` and `~/.codex/sessions` once per run.
// Both are mocked because the real scans read the DEVELOPER's home directory:
// unmocked, every case in this file would walk whatever transcripts happen to be on
// the machine — slow, and its results would vary per machine. Their own behaviour is
// covered by each discoverer's suite against a temp tree.
// EVERY machine-global scan is mocked, not just the two that are asserted on. These
// read the developer's real home directory (~/.claude, ~/.cursor, ~/.codex, the
// OpenCode and Devin databases, …), so an unmocked one makes this suite depend on
// which AI tools the machine running it happens to have installed — the exact kind of
// environment coupling that made the original per-repo profile misleading.
vi.mock("../core/ClaudeSessionDiscoverer.js", () => ({
	scanClaudeSessionsOnDisk: vi.fn(),
}));
vi.mock("../core/CodexSessionDiscoverer.js", () => ({
	scanCodexSessionsOnDisk: vi.fn(),
}));
vi.mock("../core/CursorSessionDiscoverer.js", () => ({
	scanCursorComposersOnDisk: vi.fn(async () => ({ composers: [] })),
}));
vi.mock("../core/KimiSessionDiscoverer.js", () => ({
	scanKimiSessionsOnDisk: vi.fn(async () => []),
}));
vi.mock("../core/OpenCodeSessionDiscoverer.js", () => ({
	scanOpenCodeSessionsOnDisk: vi.fn(async () => ({ sessions: [] })),
}));
vi.mock("../core/CopilotSessionDiscoverer.js", () => ({
	scanCopilotSessionsOnDisk: vi.fn(async () => ({ sessions: [] })),
}));
vi.mock("../core/CopilotChatSessionDiscoverer.js", () => ({
	scanCopilotChatSessionsOnDisk: vi.fn(async () => ({ sessions: [] })),
}));
vi.mock("../core/ClineSessionDiscoverer.js", () => ({
	scanClineSessionsOnDisk: vi.fn(async () => ({ sessions: [] })),
}));
vi.mock("../core/ClineCliSessionDiscoverer.js", () => ({
	scanClineCliSessionsOnDisk: vi.fn(async () => ({ sessions: [] })),
}));
vi.mock("../core/DevinSessionDiscoverer.js", () => ({
	scanDevinSessionsOnDisk: vi.fn(async () => ({ sessions: [] })),
}));
vi.mock("../core/CursorCliSessionDiscoverer.js", () => ({
	scanCursorCliSessionsOnDisk: vi.fn(async () => ({ sessions: [] })),
}));
vi.mock("../core/AntigravitySessionDiscoverer.js", () => ({
	scanAntigravitySessionsOnDisk: vi.fn(async () => ({ sessions: [] })),
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

import { scanAntigravitySessionsOnDisk } from "../core/AntigravitySessionDiscoverer.js";
import { scanClaudeSessionsOnDisk } from "../core/ClaudeSessionDiscoverer.js";
import { scanClineCliSessionsOnDisk } from "../core/ClineCliSessionDiscoverer.js";
import { scanClineSessionsOnDisk } from "../core/ClineSessionDiscoverer.js";
import { scanCodexSessionsOnDisk } from "../core/CodexSessionDiscoverer.js";
import { scanCopilotChatSessionsOnDisk } from "../core/CopilotChatSessionDiscoverer.js";
import { scanCopilotSessionsOnDisk } from "../core/CopilotSessionDiscoverer.js";
import { scanCursorCliSessionsOnDisk } from "../core/CursorCliSessionDiscoverer.js";
import { scanCursorComposersOnDisk } from "../core/CursorSessionDiscoverer.js";
import { scanDevinSessionsOnDisk } from "../core/DevinSessionDiscoverer.js";
import { execGit, getHeadHash, listFilesInBranch } from "../core/GitOps.js";
import { scanKimiSessionsOnDisk } from "../core/KimiSessionDiscoverer.js";
import { scanOpenCodeSessionsOnDisk } from "../core/OpenCodeSessionDiscoverer.js";
import { readCutoverFence } from "../core/RepoProfile.js";
import { BACKFILL_SESSION_WINDOW_MS } from "../core/SessionWindow.js";
import { getIndex, resolveReadStorage } from "../core/SummaryStore.js";
import {
	collectCommitEvents,
	collectRepoGraph,
	collectSessionEvents,
	collectSummaryEvents,
	collectWorktreeEvent,
} from "./DashboardCollector.js";
import { dbBackfillRepo, dbBackfillRepos, pruneUnreachableCommits } from "./DbBackfill.js";
import { importRepoMemory } from "./SotImport.js";

let dir: string;
let dbPath: string;

const repo: RegisteredRepo = {
	repoIdentity: "https://github.com/jolliai/jolliai",
	repoName: "jolliai",
	// Must be a directory that EXISTS: `dbBackfillRepos` drops a repo whose every
	// recorded checkout is gone (see its own describe block), so a fixture on a
	// made-up path would silently be skipped instead of swept. Nothing is read
	// from it — the collectors are mocked.
	worktreeRoot: tmpdir(),
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
	// Carried because it is what makes the stored row a READ receipt: `started_at_ms`
	// comes from the transcript's first entry, so only a full read can produce it, and
	// `readKnownSessions` counts a row as evidence on exactly that basis. An event
	// without it projects a row indistinguishable from one a commit summary seeded.
	startedAtMs: 1_700_000_000_000,
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
	// An empty disk scan by default. It must RESOLVE rather than return undefined:
	// `dbBackfillRepos` attaches a `.catch` to the call, so a bare `vi.fn()` with no
	// return value throws a TypeError before any repo is swept.
	vi.mocked(scanClaudeSessionsOnDisk).mockResolvedValue([]);
	vi.mocked(scanCodexSessionsOnDisk).mockResolvedValue([]);
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
	// Identity: the real one answers `opts.storage` when given one, and the
	// ambient system of record otherwise. `null` stands in for "no override" —
	// what the collector then does with it is `collectCommitEvents`' own suite.
	vi.mocked(resolveReadStorage).mockImplementation(async (storage) => storage as never);
	// Not fenced for cutover by default — the orphan branch is still authoritative.
	vi.mocked(readCutoverFence).mockResolvedValue(null);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function query<T>(sql: string, ...params: unknown[]): Promise<T[]> {
	return withDashboardDb((db) => db.prepare(sql).all(...params) as T[], { dbPath });
}

/** The branch axis's own view of one commit: `commit_branches`, resolved to names. */
async function branchesOf(hash: string): Promise<string[]> {
	const rows = await query<{ name: string }>(
		`SELECT b.name FROM commit_branches cb
		   JOIN branches b ON b.id = cb.branch_id
		   JOIN commits c  ON c.id = cb.commit_id
		  WHERE c.hash = ? ORDER BY b.name`,
		hash,
	);
	return rows.map((r) => r.name);
}

describe("dbBackfillRepo — bootstrap", () => {
	it("imports commits, sessions and worktree state, then marks the repo done", async () => {
		const result = await dbBackfillRepo({ repo, dbPath });
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
		await dbBackfillRepo({ repo, dbPath, now: () => 42 });
		const cursors = await query<{ source: string; cursor: string }>(
			"SELECT source, cursor FROM ingest_cursors ORDER BY source",
		);
		expect(cursors).toEqual([
			// The commit cursor is per-checkout (`<path>@<head>+<branch-tips hash>`,
			// sorted) so a commit landing in a second clone — or a branch moving
			// without HEAD moving — cannot read as "nothing changed". Matched by shape
			// rather than a pinned digest of the fixture's empty ref output.
			// The path prefix is the fixture's own root (an existing directory — see
			// the fixture), asserted below rather than inlined into the pattern.
			{ source: "git-commits", cursor: expect.stringMatching(/@head-1\+[0-9a-f]{64}$/) },
			{ source: "sessions", cursor: String(sessionEvent.updatedAtMs) },
			// NOT a high-water mark like the others — a receipt. It records which build's
			// full transcript read produced the stored session rows, and it is the only
			// thing that makes the per-session skip safe to trust. See
			// `SESSION_READ_GENERATION`.
			{ source: "sessions-read-generation", cursor: "3" },
			// The memory import's own signal: the orphan tip (a hash of everything it
			// reads) plus the mode, since seed and catch-up do not write the same rows.
			{ source: "sot-import", cursor: `${"ab".repeat(20)}#seed` },
		]);
		expect(cursors[0].cursor.startsWith(`${repo.worktreeRoot}@`)).toBe(true);
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
	// await dbBackfillRepo({ repo, dbPath });
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
		await dbBackfillRepo({ repo, dbPath });
		vi.mocked(getHeadHash).mockResolvedValue("head-2"); // force a re-collect
		await dbBackfillRepo({ repo, dbPath });
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

		await dbBackfillRepo({ repo, dbPath, now: () => Date.parse("2026-08-09T00:00:00Z") });

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

		await dbBackfillRepo({ repo, dbPath, now: () => Date.parse("2026-08-09T00:00:00Z") });

		const kept = await query<{ event_id: string }>(
			"SELECT event_id FROM events_raw WHERE event_id IN ('pending','failed') ORDER BY event_id",
		);
		expect(kept.map((r) => r.event_id)).toEqual(["failed", "pending"]);
	});
});

describe("dbBackfillRepo — recovery", () => {
	it("skips the git sweep when HEAD matches the cursor", async () => {
		await dbBackfillRepo({ repo, dbPath });
		vi.mocked(collectCommitEvents).mockClear();
		const result = await dbBackfillRepo({ repo, dbPath });
		expect(collectCommitEvents).not.toHaveBeenCalled();
		// Sessions and worktree are still re-projected (idempotent, cheap).
		expect(collectSessionEvents).toHaveBeenCalledTimes(2);
		expect(result.mode).toBe("recovered");
	});

	it("re-sweeps when a branch tip moves without HEAD moving", async () => {
		await dbBackfillRepo({ repo, dbPath });
		vi.mocked(collectCommitEvents).mockClear();
		// Same HEAD, different branch tips — a branch that is not the checked-out one
		// was deleted, rebased or gained a commit. A HEAD-only cursor read this as
		// "nothing changed", so prune never ran and branch reachability went stale.
		vi.mocked(execGit).mockResolvedValue({
			stdout: "refs/heads/main aaa\nrefs/heads/feature/x ddd\n",
			stderr: "",
			exitCode: 0,
		});
		await dbBackfillRepo({ repo, dbPath });
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
		await dbBackfillRepo({ repo, dbPath });
		vi.mocked(collectCommitEvents).mockClear();
		vi.mocked(execGit).mockImplementation(tips("mem-2"));
		await dbBackfillRepo({ repo, dbPath });
		expect(collectCommitEvents).not.toHaveBeenCalled();
	});

	it("projects only the commits a re-sweep actually changed", async () => {
		// The daily case: a commit lands on the branch being worked on. The sweep has
		// to LIST every reachable commit (the prune is computed against that set, and
		// branch reachability changes for old commits whenever a branch moves), but
		// projecting the unchanged ones re-ran an UPSERT + DELETE + re-INSERT per
		// commit to arrive at the bytes already there. Measured on a real 2.5k-commit
		// repo: one new commit went from 2457 projections to 1.
		await dbBackfillRepo({ repo, dbPath });
		// A pass with nothing to do still re-projects the always-on tiers, so THAT is
		// the baseline to compare against rather than a hard-coded count.
		const idle = await dbBackfillRepo({ repo, dbPath });
		vi.mocked(getHeadHash).mockResolvedValue("head-2");
		vi.mocked(collectCommitEvents).mockResolvedValue([commitEvent("aaa"), commitEvent("bbb"), commitEvent("ccc")]);
		const result = await dbBackfillRepo({ repo, dbPath });
		// Exactly one more: `ccc`. `aaa` and `bbb` are listed by the sweep and used
		// for the prune, but neither reaches the projection.
		expect(result.eventsApplied).toBe(idle.eventsApplied + 1);
		const hashes = (await query<{ hash: string }>("SELECT hash FROM commits ORDER BY hash")).map((r) => r.hash);
		expect(hashes).toEqual(["aaa", "bbb", "ccc"]);
	});

	it("re-projects a commit whose branch attribution changed", async () => {
		// `branches` is replace-when-present, so a stale set is a wrong answer to
		// "group by branch" — this is the one field that legitimately changes for an
		// OLD commit, and skipping it is what a naive "already stored" test would do.
		// (It used to change because a reachability window reshuffled, which never
		// converged; it now changes only when the recorded branch really does — a
		// late-arriving memory or an amend. See `unchangedCommitEvent`.)
		await dbBackfillRepo({ repo, dbPath });
		vi.mocked(getHeadHash).mockResolvedValue("head-2");
		vi.mocked(collectCommitEvents).mockResolvedValue([
			{ ...commitEvent("aaa"), branches: ["main", "feature/x"] },
			commitEvent("bbb"),
		]);
		await dbBackfillRepo({ repo, dbPath });
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

	it("fills branch attribution for a commit whose memory arrived after it", async () => {
		// The gap the churn was accidentally papering over. A commit lands before its
		// memory exists, so the first sweep records no branch for it; the summary
		// arrives moments later. While the reachability window thrashed, EVERY pass
		// re-emitted every commit and re-read the recorded branch, so this filled
		// itself as a side effect of the bug. Now that a commit converges after one
		// projection, the late fill is a distinct transition that has to work on its
		// own — and three UI cards render `commits.branch`.
		//
		// `[]`, not absent: the commit genuinely has no recorded branch yet, and that
		// answer must CLEAR rows rather than preserve them.
		vi.mocked(collectCommitEvents).mockResolvedValue([{ ...commitEvent("aaa"), branch: undefined, branches: [] }]);
		await dbBackfillRepo({ repo, dbPath });
		expect(await query<{ branch: string | null }>("SELECT branch FROM commits WHERE hash = 'aaa'")).toEqual([
			{ branch: null },
		]);
		expect(await query("SELECT 1 FROM commit_branches")).toEqual([]);

		// The memory lands. One more emission, and it is a real change.
		const beforeFill = await dbBackfillRepo({ repo, dbPath });
		vi.mocked(getHeadHash).mockResolvedValue("head-2");
		vi.mocked(collectCommitEvents).mockResolvedValue([
			{ ...commitEvent("aaa"), branch: "feature/x", branches: ["feature/x"] },
		]);
		const filled = await dbBackfillRepo({ repo, dbPath });
		expect(filled.eventsApplied).toBe(beforeFill.eventsApplied + 1);
		expect(await query<{ branch: string | null }>("SELECT branch FROM commits WHERE hash = 'aaa'")).toEqual([
			{ branch: "feature/x" },
		]);
		// Exactly one row — the whole point of the new shape.
		expect(
			await query<{ name: string }>(
				`SELECT b.name FROM commit_branches cb JOIN branches b ON b.id = cb.branch_id`,
			),
		).toEqual([{ name: "feature/x" }]);

		// And it converges: a further identical pass emits nothing new.
		vi.mocked(getHeadHash).mockResolvedValue("head-3");
		const settled = await dbBackfillRepo({ repo, dbPath });
		expect(settled.eventsApplied).toBe(beforeFill.eventsApplied);
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
		await dbBackfillRepo({ repo, dbPath });
		vi.mocked(collectCommitEvents).mockClear();

		vi.mocked(getHeadHash).mockResolvedValue("head-2");
		await dbBackfillRepo({ repo, dbPath });

		const known = vi.mocked(collectCommitEvents).mock.calls[0]?.[0].knownHashes;
		expect([...(known ?? [])]).toEqual(["aaa"]);
	});

	it("prunes commits that a rewrite made unreachable (set reconciliation)", async () => {
		await dbBackfillRepo({ repo, dbPath });
		// Rebase: bbb rewritten to ccc, HEAD moved.
		vi.mocked(getHeadHash).mockResolvedValue("head-2");
		vi.mocked(collectCommitEvents).mockResolvedValue([commitEvent("aaa"), commitEvent("ccc")]);
		await dbBackfillRepo({ repo, dbPath });
		const hashes = (await query<{ hash: string }>("SELECT hash FROM commits ORDER BY hash")).map((r) => r.hash);
		expect(hashes).toEqual(["aaa", "ccc"]);
	});

	it("keeps every commit and the cursor when a checkout's collection FAILS", async () => {
		// The 10 MB `execGit` stdout cap reports overflow as exit 1, and the collector
		// used to answer that with []. The caller reads [] as "this repo reaches no
		// commits", so the prune wiped the commit layer (with its CASCADEs) — and then
		// advanced the cursor, so the next pass skipped collection entirely and the
		// blank persisted until some unrelated ref moved.
		await dbBackfillRepo({ repo, dbPath });
		const before = await query<{ hash: string }>("SELECT hash FROM commits ORDER BY hash");
		const cursorBefore = await query<{ cursor: string }>("SELECT cursor FROM ingest_cursors WHERE source = 'git'");

		vi.mocked(getHeadHash).mockResolvedValue("head-2");
		vi.mocked(collectCommitEvents).mockRejectedValue(new Error("git log failed: stdout limit exceeded"));
		await dbBackfillRepo({ repo, dbPath });

		expect(await query<{ hash: string }>("SELECT hash FROM commits ORDER BY hash")).toEqual(before);
		// Cursor unmoved, so the next pass re-collects instead of trusting the gap.
		expect(await query<{ cursor: string }>("SELECT cursor FROM ingest_cursors WHERE source = 'git'")).toEqual(
			cursorBefore,
		);
	});

	it("still recovers sessions when HEAD is unreadable (worktree gone mid-run)", async () => {
		vi.mocked(getHeadHash).mockRejectedValue(new Error("not a repo"));
		const result = await dbBackfillRepo({ repo, dbPath });
		expect(result.mode).toBe("bootstrapped");
		expect((await query("SELECT event_id FROM sessions")).length).toBe(1);
		// No commit cursor written without a HEAD to anchor it. The memory import's
		// cursor is unaffected — it is anchored on the orphan tip, which resolves
		// whether or not HEAD does.
		const cursors = await query<{ source: string }>("SELECT source FROM ingest_cursors ORDER BY source");
		expect(cursors).toEqual([
			{ source: "sessions" },
			{ source: "sessions-read-generation" },
			{ source: "sot-import" },
		]);
	});

	it("skips the worktree event when the collector returns null", async () => {
		vi.mocked(collectWorktreeEvent).mockResolvedValue(null);
		await dbBackfillRepo({ repo, dbPath });
		expect(await query("SELECT branch FROM worktree_status")).toEqual([]);
	});
});

describe("pruneUnreachableCommits", () => {
	it("returns 0 and writes nothing when everything is reachable", async () => {
		await dbBackfillRepo({ repo, dbPath });
		const pruned = await withDashboardDb(
			(db) => pruneUnreachableCommits(db, repo.repoIdentity, new Set(["aaa", "bbb"])),
			{ dbPath },
		);
		expect(pruned).toBe(0);
	});

	it("cascades: pruning a commit removes its branch links", async () => {
		await dbBackfillRepo({ repo, dbPath });
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

describe("dbBackfillRepos", () => {
	it("continues past a repo whose backfill throws", async () => {
		// Live path on purpose: this is the "the sweep threw" case, distinct from
		// the "the checkout is gone" case below, which never reaches the sweep.
		const broken: RegisteredRepo = {
			...repo,
			repoIdentity: "local:broken",
			repoName: "broken",
		};
		vi.mocked(collectSessionEvents).mockImplementation(async (opts) => {
			if (opts.repoIdentity === "local:broken") throw new Error("worktree deleted");
			return [sessionEvent];
		});
		const results = await dbBackfillRepos([broken, repo], { dbPath });
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

	it("reports a repo whose every recorded checkout is gone, without sweeping it", async () => {
		// The registry is append-only in practice, so a repo whose directory was
		// deleted stays in it forever. Sweeping it runs git against a path that does
		// not exist — three warnings per pass, on every `jolli dashboard` launch —
		// and it is not a failure the caller should print as "migration failed".
		//
		// Reported all the same, under its own mode: the identical evidence describes
		// an unmounted share, where the user is still expecting these memories, and
		// the log line the sweep-suppression left behind is at `debug` — which CLI
		// mode keeps off the terminal entirely. `unavailable` is what lets the caller
		// say it once without calling it a failure.
		const gone: RegisteredRepo = {
			...repo,
			repoIdentity: "local:gone",
			repoName: "gone",
			worktreeRoot: join(dir, "deleted"),
			worktrees: [join(dir, "deleted"), join(dir, "also-deleted")],
		};
		const results = await dbBackfillRepos([gone, repo], { dbPath });
		// Worked-on repos first; the untouched entries are appended.
		expect(results.map((r) => r.repoName)).toEqual(["jolliai", "gone"]);
		expect(results[1]).toEqual({ mode: "unavailable", eventsApplied: 0, repoName: "gone" });
		// Not swept at all: no collector ever saw it.
		expect(vi.mocked(collectSessionEvents).mock.calls.every((c) => c[0].repoIdentity !== "local:gone")).toBe(true);
	});

	it("does not scan machine-global stores when no repo has a live checkout", async () => {
		const gone: RegisteredRepo = {
			...repo,
			repoIdentity: "local:only-gone",
			worktreeRoot: join(dir, "deleted"),
		};

		await dbBackfillRepos([gone], { dbPath });

		expect(scanClaudeSessionsOnDisk).not.toHaveBeenCalled();
		expect(scanCodexSessionsOnDisk).not.toHaveBeenCalled();
		expect(scanCursorComposersOnDisk).not.toHaveBeenCalled();
	});

	it("keeps a custom session loader isolated from real machine-global stores", async () => {
		const loadSessions = vi.fn(async () => []);

		await dbBackfillRepos([repo], { dbPath, loadSessions });

		expect(scanClaudeSessionsOnDisk).not.toHaveBeenCalled();
		expect(scanCodexSessionsOnDisk).not.toHaveBeenCalled();
		expect(scanCursorComposersOnDisk).not.toHaveBeenCalled();
		expect(vi.mocked(collectSessionEvents).mock.calls[0][0].loadSessions).toBe(loadSessions);
		expect(vi.mocked(collectSessionEvents).mock.calls[0][0].preScanned).toEqual({});
	});

	it("counts only the surviving repos when stamping each one's place in the run", async () => {
		// `repoTotal` follows the list that is actually swept, so a dead entry does
		// not make the progress line count to a total it will never reach.
		const gone: RegisteredRepo = { ...repo, repoIdentity: "local:gone2", worktreeRoot: join(dir, "deleted") };
		const seen: number[] = [];
		await dbBackfillRepos([gone, repo], { dbPath, onProgress: (p) => seen.push(p.repoTotal) });
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((total) => total === 1)).toBe(true);
	});

	it("scans the Claude transcript tree ONCE for the whole run, not once per repo", async () => {
		// The point of hoisting it out of the loop: that tree is machine-global, so a
		// per-repo scan re-reads every transcript once per registered repo.
		const second: RegisteredRepo = { ...repo, repoIdentity: "local:second", repoName: "second" };
		const third: RegisteredRepo = { ...repo, repoIdentity: "local:third", repoName: "third" };

		await dbBackfillRepos([repo, second, third], { dbPath });

		expect(scanClaudeSessionsOnDisk).toHaveBeenCalledTimes(1);
		// …and every repo still received it.
		const seen = vi.mocked(collectSessionEvents).mock.calls.map((c) => c[0].preScanned?.claude);
		expect(seen).toHaveLength(3);
		expect(seen.every((d) => d !== undefined)).toBe(true);
	});

	it("uses a caller-supplied scan instead of running its own", async () => {
		const supplied = [
			{
				sessionId: "d1",
				transcriptPath: "/t/d1.jsonl",
				updatedAt: "2026-07-30T08:00:00.000Z",
				dirs: ["/w"],
				complete: true,
			},
		];

		await dbBackfillRepos([repo], { dbPath, preScanned: { claude: supplied } });

		expect(scanClaudeSessionsOnDisk).not.toHaveBeenCalled();
		expect(vi.mocked(collectSessionEvents).mock.calls[0][0].preScanned?.claude).toEqual(supplied);
	});

	it("does not let the scans skip anything on a first pass", async () => {
		// No repo has completed a session pass yet, so nothing in the database can be
		// trusted as a receipt — see `readRecordedSessions`. The scan must read
		// everything properly exactly once.
		await dbBackfillRepos([repo], { dbPath });

		expect(vi.mocked(scanClaudeSessionsOnDisk).mock.calls[0][0]?.alreadyRecorded).toBeUndefined();
	});

	it("lets the scans skip once every repo has completed a session pass", async () => {
		await dbBackfillRepos([repo], { dbPath });
		vi.mocked(scanClaudeSessionsOnDisk).mockClear();

		await dbBackfillRepos([repo], { dbPath });

		expect(vi.mocked(scanClaudeSessionsOnDisk).mock.calls[0][0]?.alreadyRecorded).toBeDefined();
	});

	it("turns skipping off for the whole run when one repo is newly registered", async () => {
		// The reason the gate is over EVERY repo rather than per repo: a fresh repo has
		// no rows, and skipping on another repo's evidence would leave it permanently
		// without them.
		await dbBackfillRepos([repo], { dbPath });
		const fresh: RegisteredRepo = { ...repo, repoIdentity: "local:fresh", repoName: "fresh" };
		vi.mocked(scanClaudeSessionsOnDisk).mockClear();

		await dbBackfillRepos([repo, fresh], { dbPath });

		expect(vi.mocked(scanClaudeSessionsOnDisk).mock.calls[0][0]?.alreadyRecorded).toBeUndefined();
	});

	it("keeps sweeping when the disk scan fails", async () => {
		// Not fatal by design: every other source scans its own store, and the
		// `sessions.json` half of the collector still carries Claude — so a failed scan
		// costs Claude its pre-48 h reach, never the run.
		vi.mocked(scanClaudeSessionsOnDisk).mockRejectedValue(new Error("home directory unreadable"));

		const results = await dbBackfillRepos([repo], { dbPath });

		expect(results[0].mode).toBe("bootstrapped");
		expect(vi.mocked(collectSessionEvents).mock.calls[0][0].preScanned?.claude).toBeUndefined();
	});

	it("scans the Codex rollout tree ONCE for the whole run too", async () => {
		// `~/.codex/sessions/` is keyed by DATE, so it has the same per-repo repetition
		// as the Claude tree — measured 68 ms per repo, 201 ms across three.
		const second: RegisteredRepo = { ...repo, repoIdentity: "local:second", repoName: "second" };

		await dbBackfillRepos([repo, second], { dbPath });

		expect(scanCodexSessionsOnDisk).toHaveBeenCalledTimes(1);
		expect(scanCodexSessionsOnDisk).toHaveBeenCalledWith(BACKFILL_SESSION_WINDOW_MS);
		expect(vi.mocked(collectSessionEvents).mock.calls.every((c) => c[0].preScanned?.codex !== undefined)).toBe(
			true,
		);
	});

	it("falls back to per-repo Codex scans — not to an empty set — when its scan fails", async () => {
		// `undefined`, not `[]`. An empty array is the positive claim "the scan ran and
		// found nothing", which makes the collector skip its own codex loader and lose the
		// source outright. Absence sends it back to scanning per repo.
		vi.mocked(scanCodexSessionsOnDisk).mockRejectedValue(new Error("codex home unreadable"));

		const results = await dbBackfillRepos([repo], { dbPath });

		expect(results[0].mode).toBe("bootstrapped");
		expect(vi.mocked(collectSessionEvents).mock.calls[0][0].preScanned?.codex).toBeUndefined();
	});

	// Every other machine-global store, held to the same two guarantees: scanned once
	// per RUN, and handed to every repo. Table-driven because the failure they guard
	// against is per-source and silent — a source left out of the hoist just goes back
	// to costing a full store read per repo, with an identical result set.
	const HOISTED_SCANS = [
		{ key: "cursor", spy: () => scanCursorComposersOnDisk },
		{ key: "kimi", spy: () => scanKimiSessionsOnDisk },
		{ key: "opencode", spy: () => scanOpenCodeSessionsOnDisk },
		{ key: "copilot", spy: () => scanCopilotSessionsOnDisk },
		// Keyed by the source TAG now, not by a camel-cased field name — the two
		// spellings used to be hand-mapped, and the map is gone.
		{ key: "copilot-chat", spy: () => scanCopilotChatSessionsOnDisk },
		{ key: "cline", spy: () => scanClineSessionsOnDisk },
		{ key: "cline-cli", spy: () => scanClineCliSessionsOnDisk },
		{ key: "devin", spy: () => scanDevinSessionsOnDisk },
		{ key: "cursor-cli", spy: () => scanCursorCliSessionsOnDisk },
		{ key: "antigravity", spy: () => scanAntigravitySessionsOnDisk },
	] as const;

	for (const { key, spy } of HOISTED_SCANS) {
		it(`scans the ${key} store ONCE for the whole run and gives it to every repo`, async () => {
			const second: RegisteredRepo = { ...repo, repoIdentity: "local:second", repoName: "second" };
			const third: RegisteredRepo = { ...repo, repoIdentity: "local:third", repoName: "third" };

			await dbBackfillRepos([repo, second, third], { dbPath });

			expect(spy()).toHaveBeenCalledTimes(1);
			const seen = vi.mocked(collectSessionEvents).mock.calls.map((c) => c[0].preScanned?.[key]);
			expect(seen).toHaveLength(3);
			expect(seen.every((d) => d !== undefined)).toBe(true);
		});

		it(`falls back to per-repo ${key} scans when its scan fails`, async () => {
			// Same rule as Codex: absence, never `[]`. Per source, so one broken store
			// costs that source its run-wide scan and nothing else.
			vi.mocked(spy()).mockRejectedValue(new Error(`${key} store unreadable`));

			const results = await dbBackfillRepos([repo], { dbPath });

			expect(results[0].mode).toBe("bootstrapped");
			expect(vi.mocked(collectSessionEvents).mock.calls[0][0].preScanned?.[key]).toBeUndefined();
		});
	}

	it("treats a scan that reported failure on its ERROR CHANNEL as absence too", async () => {
		// Most of these discoverers never throw — they answer `{ sessions, error }` and let
		// the caller decide. Reading `.sessions` alone spelled a failed scan as `[]`, which
		// is the positive claim "the store was read and holds nothing": the per-repo
		// fallback was skipped for the whole run, and the pass reported that nothing as a
		// fact about the agent.
		vi.mocked(scanOpenCodeSessionsOnDisk).mockResolvedValue({
			sessions: [],
			error: { kind: "locked", message: "database is locked" },
		});

		const results = await dbBackfillRepos([repo], { dbPath });

		expect(results[0].mode).toBe("bootstrapped");
		expect(vi.mocked(collectSessionEvents).mock.calls[0][0].preScanned?.opencode).toBeUndefined();
	});

	it("keeps a PARTIAL scan's sessions instead of discarding them", async () => {
		// Cline scans each editor flavour independently and Copilot Chat each workspace, so
		// an error beside sessions means "some of it was unreadable", not "this failed".
		// Only empty-AND-errored is a total failure.
		vi.mocked(scanOpenCodeSessionsOnDisk).mockResolvedValue({
			sessions: [
				{
					session: {
						sessionId: "oc1",
						transcriptPath: "/tmp/oc.db#oc1",
						updatedAt: "2026-08-01T00:00:00.000Z",
						source: "opencode",
					},
					dirs: [repo.worktreeRoot],
				},
			],
			error: { kind: "permission", message: "one store unreadable" },
		});

		await dbBackfillRepos([repo], { dbPath });

		expect(vi.mocked(collectSessionEvents).mock.calls[0][0].preScanned?.opencode).toHaveLength(1);
	});

	it("gives every source the back-fill's wider window, not each source's 48 h default", async () => {
		// The reason the back-fill has its own scan path at all. A source left on the
		// default silently contributes only two days of history to a seven-day import.
		await dbBackfillRepos([repo], { dbPath });

		expect(scanCodexSessionsOnDisk).toHaveBeenCalledWith(BACKFILL_SESSION_WINDOW_MS);
		expect(scanKimiSessionsOnDisk).toHaveBeenCalledWith(BACKFILL_SESSION_WINDOW_MS);
		expect(scanOpenCodeSessionsOnDisk).toHaveBeenCalledWith(BACKFILL_SESSION_WINDOW_MS);
		expect(scanCopilotSessionsOnDisk).toHaveBeenCalledWith(BACKFILL_SESSION_WINDOW_MS);
		expect(scanCopilotChatSessionsOnDisk).toHaveBeenCalledWith(BACKFILL_SESSION_WINDOW_MS);
		expect(scanDevinSessionsOnDisk).toHaveBeenCalledWith(BACKFILL_SESSION_WINDOW_MS);
		// These three take the window behind their own directory-override seams.
		expect(scanClineSessionsOnDisk).toHaveBeenCalledWith(undefined, BACKFILL_SESSION_WINDOW_MS);
		expect(scanClineCliSessionsOnDisk).toHaveBeenCalledWith(undefined, BACKFILL_SESSION_WINDOW_MS);
		expect(scanCursorCliSessionsOnDisk).toHaveBeenCalledWith(undefined, undefined, BACKFILL_SESSION_WINDOW_MS);
		expect(scanAntigravitySessionsOnDisk).toHaveBeenCalledWith(undefined, BACKFILL_SESSION_WINDOW_MS);
		// Cursor Composer is the exception and must NOT take one: its anchors bypass the
		// window, so filtering at scan time would drop anchored composers. The window is
		// applied per repo instead, in `cursorSessionsForRepo`.
		expect(scanCursorComposersOnDisk).toHaveBeenCalledWith();
	});
});

describe("dbBackfillRepo — per-session skip", () => {
	/** Runs one sweep and returns the predicate the collector was handed. */
	async function capturePredicate(): Promise<
		(source: "claude" | "codex" | "cursor", sessionId: string, updatedAtMs: number) => boolean
	> {
		await dbBackfillRepo({ repo, dbPath });
		const opts = vi.mocked(collectSessionEvents).mock.calls.at(-1)?.[0];
		const predicate = opts?.isAlreadyCurrent;
		if (!predicate) throw new Error("collector received no isAlreadyCurrent predicate");
		return predicate;
	}

	it("skips a session the database already holds at its instant", async () => {
		// First sweep stores `sessionEvent` (source claude, id s1, at 1_700_000_050_000).
		await dbBackfillRepo({ repo, dbPath });
		const predicate = await capturePredicate();

		expect(predicate("claude", "s1", 1_700_000_050_000)).toBe(true);
	});

	it("skips a session the database holds at a LATER instant", async () => {
		await dbBackfillRepo({ repo, dbPath });
		const predicate = await capturePredicate();

		expect(predicate("claude", "s1", 1_700_000_040_000)).toBe(true);
	});

	it("does NOT skip a session that has moved on since it was stored", async () => {
		// The case a repo-wide high-water mark gets wrong: resuming an old conversation.
		await dbBackfillRepo({ repo, dbPath });
		const predicate = await capturePredicate();

		expect(predicate("claude", "s1", 1_700_000_060_000)).toBe(false);
	});

	it("does NOT skip a session the database has never seen", async () => {
		await dbBackfillRepo({ repo, dbPath });
		const predicate = await capturePredicate();

		expect(predicate("claude", "never-stored", 1)).toBe(false);
	});

	it("keys the skip on source as well as id", async () => {
		await dbBackfillRepo({ repo, dbPath });
		const predicate = await capturePredicate();

		// Same session id, different agent — a different conversation entirely.
		expect(predicate("codex", "s1", 1_700_000_050_000)).toBe(false);
	});

	it("does NOT skip a session whose only row was seeded by a commit summary", async () => {
		// The permanent-skip trap. A summary's session links seed a row stamped with the
		// COMMIT's time, which is necessarily later than the conversation's last turn — so
		// taken as a receipt it skips that transcript on every pass forever, and the seed's
		// ON CONFLICT never rewrites the instant that would walk it back. A seed can arrive
		// at any moment (the QueueWorker writes one from post-commit), which is why the
		// generation gate cannot cover it and the row itself has to be disqualified.
		await dbBackfillRepo({ repo, dbPath });
		await withDashboardDb(
			(db) => {
				db.prepare(
					`INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms, message_count)
					 VALUES ('session:seeded', (SELECT id FROM repos WHERE repo_identity = ?), 'codex', 'seeded-1', ?, 4)`,
				).run(repo.repoIdentity, 1_700_000_900_000);
			},
			{ dbPath },
		);

		const predicate = await capturePredicate();

		expect(predicate("codex", "seeded-1", 1_700_000_050_000)).toBe(false);
	});

	it("does NOT skip a session whose row carries only a title", async () => {
		// The other way a row looks like a receipt without being one. `sessionEventFromInfo`
		// resolves the title BEFORE it opens the transcript and keeps it when that read
		// throws, and every source with a native title column (opencode, cursor, devin,
		// cline, copilot, antigravity) answers from the discoverer without reading anything.
		// So a store that was momentarily locked writes a title and nothing else — and
		// counting that as a receipt strands the session there: no message count, no
		// duration, no tokens, no tools, no skills, never re-read until it gains a turn.
		await dbBackfillRepo({ repo, dbPath });
		await withDashboardDb(
			(db) => {
				db.prepare(
					`INSERT INTO sessions (event_id, repo_id, source, session_id, title, updated_at_ms)
					 VALUES ('session:titled', (SELECT id FROM repos WHERE repo_identity = ?), 'cursor', 'locked-1', 'Fix the parser', ?)`,
				).run(repo.repoIdentity, 1_700_000_050_000);
			},
			{ dbPath },
		);

		const predicate = await capturePredicate();

		expect(predicate("cursor", "locked-1", 1_700_000_050_000)).toBe(false);
	});

	it("hands the collector NO predicate on the first sweep of a repo", async () => {
		// The receipt gate. A `sessions` row proves when a session last spoke, never that
		// this build read its transcript — and the summaries tier, which runs first, seeds
		// rows stamped with the COMMIT's time, necessarily later than the last turn. So a
		// repo with no recorded read-generation gets one pass with no skipping at all,
		// which is what stops a first back-fill from skipping the very sessions it exists
		// to read.
		await dbBackfillRepo({ repo, dbPath });

		expect(vi.mocked(collectSessionEvents).mock.calls.at(-1)?.[0].isAlreadyCurrent).toBeUndefined();
	});

	it("records the read generation, so the next sweep may skip", async () => {
		await dbBackfillRepo({ repo, dbPath });

		const cursors = await query<{ source: string; cursor: string }>(
			"SELECT source, cursor FROM ingest_cursors WHERE source = 'sessions-read-generation'",
		);
		expect(cursors).toEqual([{ source: "sessions-read-generation", cursor: "3" }]);
		// And the second sweep is the one that gets a predicate.
		await dbBackfillRepo({ repo, dbPath });
		expect(vi.mocked(collectSessionEvents).mock.calls.at(-1)?.[0].isAlreadyCurrent).toBeDefined();
	});

	it("re-opens every transcript when the recorded generation is stale", async () => {
		// What a parser improvement relies on: a session that has not spoken since keeps
		// whatever the old read stored, because its instant has not moved. Bumping the
		// generation is the only thing that reaches it.
		await dbBackfillRepo({ repo, dbPath });
		await withDashboardDb(
			(db) => {
				db.prepare(
					"UPDATE ingest_cursors SET cursor = 'stale' WHERE source = 'sessions-read-generation'",
				).run();
			},
			{ dbPath },
		);

		await dbBackfillRepo({ repo, dbPath });

		expect(vi.mocked(collectSessionEvents).mock.calls.at(-1)?.[0].isAlreadyCurrent).toBeUndefined();
	});

	it("records the generation even after a sweep that discovered nothing", async () => {
		// A partial pass cannot mislead the next one: a session that was never discovered
		// has no row, so the skip has nothing to match it against.
		vi.mocked(collectSessionEvents).mockResolvedValue([]);

		await dbBackfillRepo({ repo, dbPath });

		const cursors = await query<{ cursor: string }>(
			"SELECT cursor FROM ingest_cursors WHERE source = 'sessions-read-generation'",
		);
		expect(cursors).toEqual([{ cursor: "3" }]);
	});
});

describe("dbBackfillRepo — SOT import wiring (v7)", () => {
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

		const result = await dbBackfillRepo({ repo, dbPath, now: () => 4242 });

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
		await dbBackfillRepo({ repo, dbPath, storage });
		expect(importRepoMemory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ storage }));
	});

	it("gives the same injected provider to the COMMIT sweep, not just the importer", async () => {
		// The commit tier reads `index.json` too — that is where branch attribution
		// comes from — and it used to take whatever `getIndex`'s ambient fallback
		// resolved instead. So the seam covered half the pass: a test could feed the
		// importer one index while the attribution came from the real machine.
		const storage = { kind: "orphan-branch" as const, listFiles: async () => [] } as never;
		await dbBackfillRepo({ repo, dbPath, storage });
		expect(vi.mocked(resolveReadStorage).mock.calls[0]?.[0]).toBe(storage);
		expect(vi.mocked(collectCommitEvents).mock.calls[0]?.[0].storage).toBe(storage);
	});

	it("threads ONE routed provider into the commit sweep, resolved outside the db handle", async () => {
		// Not `orphanStorage`: that one is pinned to the orphan tip, which a fenced
		// repo has frozen — attribution for every post-fence commit would come back
		// empty and DELETE its rows. The routed system of record is right in both
		// states, so what the sweep must receive is this resolver's answer.
		const routed = { kind: "sqlite" as const } as never;
		vi.mocked(resolveReadStorage).mockResolvedValue(routed);
		await dbBackfillRepo({ repo, dbPath });
		// One resolution for the pass, not one per checkout.
		expect(resolveReadStorage).toHaveBeenCalledTimes(1);
		expect(vi.mocked(collectCommitEvents).mock.calls[0]?.[0].storage).toBe(routed);
	});

	it("imports in seed mode while the repo has never been fenced for cutover", async () => {
		await dbBackfillRepo({ repo, dbPath });
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
			await dbBackfillRepo({ repo: { ...repo, worktrees: [a, b] }, dbPath });
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
		await dbBackfillRepo({ repo, dbPath });
		expect(importRepoMemory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mode: "catch-up" }));
	});

	it("skips the memory import entirely when the orphan tip has not moved", async () => {
		// The import is not free just because it converges: a seed pass shifts every
		// child_pos, re-upserts every row and rewrites every topic and link row —
		// seconds of every `jolli dashboard`, on a source that has not changed a
		// byte. The tip is a hash of that whole source, so "unchanged tip" is an
		// exact answer, not a heuristic.
		await dbBackfillRepo({ repo, dbPath });
		vi.mocked(importRepoMemory).mockClear();

		const result = await dbBackfillRepo({ repo, dbPath });

		expect(importRepoMemory).not.toHaveBeenCalled();
		// The count still has to be right: the caller prints it, and a zero here
		// reads as "your memories are gone" on a healthy repo.
		expect(result.sotImport).toMatchObject({ nodes: 0, updated: 0 });
	});

	it("re-imports once the orphan tip moves", async () => {
		await dbBackfillRepo({ repo, dbPath });
		vi.mocked(importRepoMemory).mockClear();
		vi.mocked(execGit).mockImplementation(async (args) =>
			args[0] === "rev-parse" && args[1] === "--verify"
				? { stdout: `${"cd".repeat(20)}\n`, stderr: "", exitCode: 0 }
				: { stdout: "", stderr: "", exitCode: 0 },
		);

		await dbBackfillRepo({ repo, dbPath });

		expect(importRepoMemory).toHaveBeenCalledTimes(1);
	});

	it("re-imports when the mode changes under a standing tip", async () => {
		// A repo that gains a fence (or a second checkout) switches to catch-up
		// without the branch moving, and the two modes do not write the same rows —
		// seed reconciles, catch-up never deletes. A tip-only cursor would skip the
		// one pass where the difference matters.
		await dbBackfillRepo({ repo, dbPath });
		vi.mocked(importRepoMemory).mockClear();
		vi.mocked(readCutoverFence).mockResolvedValue({ reason: "cutover", at: "2026-08-06T00:00:00.000Z" });

		await dbBackfillRepo({ repo, dbPath });

		expect(importRepoMemory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mode: "catch-up" }));
	});

	it("keeps re-importing while the bootstrap has never completed", async () => {
		// The cursor lives in the database it guards, but a database can be restored
		// or half-built; a repo still marked pending has not proven its rows are
		// there, and a wrong skip costs the repo's memories while a wrong import
		// costs one pass.
		await dbBackfillRepo({ repo, dbPath });
		await withDashboardDb(
			(db) => {
				db.prepare("UPDATE repos SET bootstrap_state = 'pending'").run();
			},
			{ dbPath },
		);
		vi.mocked(importRepoMemory).mockClear();

		await dbBackfillRepo({ repo, dbPath });

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

		const results = await dbBackfillRepos([repo, other], { dbPath });

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

describe("dbBackfillRepo — summaries sweep (memory tier)", () => {
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

		await dbBackfillRepo({ repo, dbPath });

		// The enrichment copies are gone (A3b): the sweep's job is the commits
		// row; turns/ticket/insights live on the memory tables, which the
		// backfill's own memory import fills from the orphan branch.
		const commits = await query<{ hash: string }>("SELECT hash FROM commits WHERE hash = 'aaa'");
		expect(commits).toEqual([{ hash: "aaa" }]);
	});

	it("skips the sweep when the index fingerprint is unchanged, re-sweeps when it changes", async () => {
		vi.mocked(getIndex).mockResolvedValue({ version: 3, entries: [] });
		vi.mocked(collectSummaryEvents).mockResolvedValue({ events: [summaryEvent], complete: true });

		await dbBackfillRepo({ repo, dbPath });
		expect(collectSummaryEvents).toHaveBeenCalledTimes(1);

		// Same index content → recovery skips the expensive summary read.
		await dbBackfillRepo({ repo, dbPath });
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
		await dbBackfillRepo({ repo, dbPath });
		expect(collectSummaryEvents).toHaveBeenCalledTimes(2);
	});

	it("skips the sweep entirely when there is no summary index", async () => {
		await dbBackfillRepo({ repo, dbPath });
		expect(collectSummaryEvents).not.toHaveBeenCalled();
	});

	// The cursor is the index's content hash, so advancing it after a partial
	// sweep makes every later pass skip collection outright — one transient
	// `git show` failure would hide that memory from the dashboard forever.
	it("does not advance the summaries cursor after an incomplete sweep", async () => {
		vi.mocked(getIndex).mockResolvedValue({ version: 3, entries: [] });
		vi.mocked(collectSummaryEvents).mockResolvedValue({ events: [summaryEvent], complete: false });

		await dbBackfillRepo({ repo, dbPath });
		expect(collectSummaryEvents).toHaveBeenCalledTimes(1);

		// Same index content, but the cursor never moved — so the next pass
		// re-reads instead of trusting an incomplete result.
		await dbBackfillRepo({ repo, dbPath });
		expect(collectSummaryEvents).toHaveBeenCalledTimes(2);

		// A clean sweep finally parks it.
		vi.mocked(collectSummaryEvents).mockResolvedValue({ events: [summaryEvent], complete: true });
		await dbBackfillRepo({ repo, dbPath });
		expect(collectSummaryEvents).toHaveBeenCalledTimes(3);
		await dbBackfillRepo({ repo, dbPath });
		expect(collectSummaryEvents).toHaveBeenCalledTimes(3);
	});

	it("lands branch attribution from a summary that arrived after the sweep", async () => {
		// THE ordinary race, and the one the commit tier structurally cannot close:
		// its cursor hashes HEAD plus `refs/heads` minus Jolli's own refs, so the
		// orphan branch gaining the memory moves nothing it watches. Pass 2 skips
		// `collectCommitEvents` entirely — if `commit.summary` only wrote the
		// `commits.branch` column, the branch axis (which joins `commit_branches`)
		// would keep reading nothing until an unrelated ref happened to move.
		vi.mocked(collectCommitEvents).mockResolvedValue([{ ...commitEvent("aaa"), branches: [] }]);
		await dbBackfillRepo({ repo, dbPath });
		expect(await branchesOf("aaa")).toEqual([]);

		vi.mocked(collectCommitEvents).mockClear();
		vi.mocked(getIndex).mockResolvedValue({ version: 3, entries: [] });
		vi.mocked(collectSummaryEvents).mockResolvedValue({
			events: [{ ...summaryEvent, branch: "feature/x" }],
			complete: true,
		});

		// Nothing in git moved — only the orphan branch did.
		await dbBackfillRepo({ repo, dbPath });

		expect(collectCommitEvents).not.toHaveBeenCalled();
		expect(await branchesOf("aaa")).toEqual(["feature/x"]);
	});

	it("leaves stored attribution alone for a summary that records no branch", async () => {
		// The absent half of the same replace-when-present contract. Only
		// `commit.created` may claim "no branch", because only it can tell an
		// unreadable index from one that does not list the hash; a summary without
		// a branch knows nothing and must not clear what the sweep established.
		await dbBackfillRepo({ repo, dbPath });
		expect(await branchesOf("aaa")).toEqual(["main"]);

		vi.mocked(getIndex).mockResolvedValue({ version: 3, entries: [] });
		vi.mocked(collectSummaryEvents).mockResolvedValue({ events: [summaryEvent], complete: true });
		await dbBackfillRepo({ repo, dbPath });

		expect(await branchesOf("aaa")).toEqual(["main"]);
	});

	it("announces the sweep only when it is going to run", async () => {
		// The marker is the caller's evidence that something is worth narrating, so
		// a skipped sweep has to be silent — announcing "Indexing stored memories…"
		// and then doing nothing is what made every launch look like a re-migration.
		vi.mocked(getIndex).mockResolvedValue({ version: 3, entries: [] });
		vi.mocked(collectSummaryEvents).mockResolvedValue({ events: [summaryEvent], complete: true });
		const kinds = async (): Promise<string[]> => {
			const seen: string[] = [];
			await dbBackfillRepo({
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

	/** Rows the write-ahead log holds for one summary's projection identity. */
	const loggedSummaries = async (hash: string): Promise<number> => {
		const rows = await query<{ n: number }>(
			"SELECT COUNT(*) AS n FROM events_raw WHERE event_id = ?",
			`commit-summary:${repo.repoIdentity}:${hash}`,
		);
		return rows[0]?.n ?? 0;
	};

	/** Opens the tier's gate by making the index content differ from last pass. */
	const changeIndex = (n: number): void => {
		vi.mocked(getIndex).mockResolvedValue({
			version: 3,
			entries: Array.from({ length: n }, (_, i) => ({
				commitHash: `idx${i}`,
				parentCommitHash: null,
				commitMessage: "m",
				commitDate: "2026-07-30T00:00:00Z",
				branch: "main",
				generatedAt: "2026-07-30T00:01:00Z",
			})),
		});
	};

	// Carries a branch and a message, so its FIRST projection genuinely writes
	// something: the bare fixture above adds nothing once `commit.created` has made
	// the row, and is therefore skipped from pass one — correct, but it cannot show
	// a re-run.
	const attributedSummary = { ...summaryEvent, branch: "main", message: "summarized aaa" };

	it("does not re-enqueue a summary whose projection would write nothing", async () => {
		// The index gate is all-or-nothing: one new memory anywhere re-collects the
		// WHOLE set, so without a per-event comparison every stored summary is
		// re-logged and re-projected on each pass. Measured at 219 events per
		// `jolli dashboard` run, every copy byte-identical (JOLLI-2224).
		changeIndex(0);
		vi.mocked(collectSummaryEvents).mockResolvedValue({ events: [attributedSummary], complete: true });
		await dbBackfillRepo({ repo, dbPath });
		expect(await loggedSummaries("aaa")).toBe(1);

		changeIndex(1);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSummaries("aaa")).toBe(1);
	});

	it("still projects a summary whose branch changed", async () => {
		// The skip must not swallow a real change: this is the late-arriving
		// attribution the tier above exists to land.
		changeIndex(0);
		vi.mocked(collectSummaryEvents).mockResolvedValue({ events: [attributedSummary], complete: true });
		await dbBackfillRepo({ repo, dbPath });

		changeIndex(1);
		vi.mocked(collectSummaryEvents).mockResolvedValue({
			events: [{ ...attributedSummary, branch: "feature/x" }],
			complete: true,
		});
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSummaries("aaa")).toBe(2);
		expect(await branchesOf("aaa")).toEqual(["feature/x"]);
	});

	it("still projects a summary carrying a session link the database lacks", async () => {
		// `projectCommitSummary` also SEEDS sessions — a session older than the
		// agents' own retention exists nowhere else. Comparing only the commits
		// columns would skip the event and lose that row silently.
		changeIndex(0);
		vi.mocked(collectSummaryEvents).mockResolvedValue({ events: [attributedSummary], complete: true });
		await dbBackfillRepo({ repo, dbPath });

		changeIndex(1);
		vi.mocked(collectSummaryEvents).mockResolvedValue({
			events: [
				{
					...attributedSummary,
					sessionLinks: [{ source: "codex" as const, sessionId: "old-1", confidence: "exact" as const }],
				},
			],
			complete: true,
		});
		await dbBackfillRepo({ repo, dbPath });

		const seeded = await query<{ session_id: string }>(
			"SELECT session_id FROM sessions WHERE session_id = 'old-1'",
		);
		expect(seeded).toEqual([{ session_id: "old-1" }]);
	});

	it("still projects a summary whose commit row does not exist yet, when git could not be read", async () => {
		// The summary can legitimately arrive first — `CommitSummaryEvent` carries
		// `committedAtMs` precisely so the projection can create the row. With no
		// reachable set to consult (the collection failed, so nothing was pruned
		// either) a missing row has to be read that way.
		vi.mocked(collectCommitEvents).mockRejectedValue(new Error("git log exploded"));
		changeIndex(0);
		vi.mocked(collectSummaryEvents).mockResolvedValue({ events: [attributedSummary], complete: true });

		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSummaries("aaa")).toBe(1);
		expect(await branchesOf("aaa")).toEqual(["main"]);
	});

	it("does not re-enqueue a summary whose commit the prune has removed", async () => {
		// The two tiers used to ping-pong: this tier's `INSERT INTO commits` recreates
		// a row for a hash git can no longer reach, and the next pass's
		// `pruneUnreachableCommits` deletes it again — 74 events per run that could
		// never converge (JOLLI-2224). A COMPLETE commit collection is what makes the
		// two cases distinguishable: it runs first and would have collected the commit
		// if git still had it, so a missing row here means the commit is gone.
		vi.mocked(collectCommitEvents).mockResolvedValue([commitEvent("bbb")]);
		changeIndex(0);
		vi.mocked(collectSummaryEvents).mockResolvedValue({ events: [attributedSummary], complete: true });

		await dbBackfillRepo({ repo, dbPath });
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSummaries("aaa")).toBe(0);
		const rows = await query<{ hash: string }>("SELECT hash FROM commits WHERE hash = 'aaa'");
		expect(rows).toEqual([]);
	});

	it("still seeds a pruned commit's sessions, which exist nowhere else", async () => {
		// The half that must survive the skip above: `projectCommitSummary` seeds
		// `sessions` from the links independently of the commits row, and a session
		// older than the agents' own retention has no other record. Only the
		// commits-row half of the effect is pointless.
		vi.mocked(collectCommitEvents).mockResolvedValue([commitEvent("bbb")]);
		changeIndex(0);
		vi.mocked(collectSummaryEvents).mockResolvedValue({
			events: [
				{
					...attributedSummary,
					sessionLinks: [{ source: "codex" as const, sessionId: "old-1", confidence: "exact" as const }],
				},
			],
			complete: true,
		});

		await dbBackfillRepo({ repo, dbPath });

		const seeded = await query<{ session_id: string }>(
			"SELECT session_id FROM sessions WHERE session_id = 'old-1'",
		);
		expect(seeded).toEqual([{ session_id: "old-1" }]);
	});

	it("still projects a summary after a commit sweep cleared its attribution", async () => {
		// The case a `commits.branch` comparison alone would miss, and it is the
		// ordinary one: `commit.created` writes its `branch` COLUMN with COALESCE
		// (absent keeps the stored value) but replaces `commit_branches` outright, so
		// an index that does not list the hash clears the ROWS while the column still
		// reads "main". Skipping there would leave the branch axis empty until an
		// unrelated ref happened to move.
		changeIndex(0);
		vi.mocked(collectSummaryEvents).mockResolvedValue({ events: [attributedSummary], complete: true });
		await dbBackfillRepo({ repo, dbPath });
		expect(await branchesOf("aaa")).toEqual(["main"]);

		// The sweep's own message matches what the summary stored, so the comparison
		// gets past the columns and has only `commit_branches` left to disagree on —
		// which is the whole point of this case.
		vi.mocked(getHeadHash).mockResolvedValue("head-2");
		vi.mocked(collectCommitEvents).mockResolvedValue([
			{ ...commitEvent("aaa"), message: attributedSummary.message, branches: [] },
		]);
		changeIndex(1);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSummaries("aaa")).toBe(2);
		expect(await branchesOf("aaa")).toEqual(["main"]);
	});

	it("still projects a summary whose link can upgrade a sessions-only row", async () => {
		// The seed's own gate: a link with a model split turns a `sessions-only` row
		// into `full`. That is the one case where the session row EXISTS and the
		// event still has work to do, so presence alone is not the predicate.
		const link = { source: "codex" as const, sessionId: "old-1", confidence: "exact" as const };
		changeIndex(0);
		vi.mocked(collectSummaryEvents).mockResolvedValue({
			events: [{ ...attributedSummary, sessionLinks: [link] }],
			complete: true,
		});
		await dbBackfillRepo({ repo, dbPath });

		changeIndex(1);
		vi.mocked(collectSummaryEvents).mockResolvedValue({
			events: [
				{
					...attributedSummary,
					sessionLinks: [
						{
							...link,
							models: [{ model: "claude-opus-5", inputTokens: 30, outputTokens: 7, cachedTokens: 0 }],
						},
					],
				},
			],
			complete: true,
		});
		await dbBackfillRepo({ repo, dbPath });

		const row = await query<{ token_coverage: string; input_tokens: number }>(
			"SELECT token_coverage, input_tokens FROM sessions WHERE session_id = 'old-1'",
		);
		expect(row).toEqual([{ token_coverage: "full", input_tokens: 30 }]);
	});

	it("still projects a summary whose commit message changed", async () => {
		// `git commit --amend -m` followed by a regeneration: same hash namespace,
		// new message. The `commits` row is COALESCE-updated from this event, so a
		// present message that differs is a real write.
		changeIndex(0);
		vi.mocked(collectSummaryEvents).mockResolvedValue({ events: [attributedSummary], complete: true });
		await dbBackfillRepo({ repo, dbPath });

		changeIndex(1);
		vi.mocked(collectSummaryEvents).mockResolvedValue({
			events: [{ ...attributedSummary, message: "reworded aaa" }],
			complete: true,
		});
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSummaries("aaa")).toBe(2);
		const rows = await query<{ message: string }>("SELECT message FROM commits WHERE hash = 'aaa'");
		expect(rows).toEqual([{ message: "reworded aaa" }]);
	});

	it("skips a summary that records no session links at all", async () => {
		// `sessionLinks` is optional on the wire, not merely empty — the loop has to
		// read an absent list as "nothing to seed" rather than throw.
		const { sessionLinks: _drop, ...linkless } = attributedSummary;
		changeIndex(0);
		vi.mocked(collectSummaryEvents).mockResolvedValue({ events: [linkless], complete: true });
		await dbBackfillRepo({ repo, dbPath });
		expect(await loggedSummaries("aaa")).toBe(1);

		changeIndex(1);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSummaries("aaa")).toBe(1);
	});
});

describe("dbBackfillRepo — sessions sweep", () => {
	/** Rows the write-ahead log holds for one session's projection identity. */
	const loggedSessions = async (sessionId: string): Promise<number> => {
		const rows = await query<{ n: number }>(
			"SELECT COUNT(*) AS n FROM events_raw WHERE event_id = ?",
			`session:${repo.repoIdentity}:claude:${sessionId}`,
		);
		return rows[0]?.n ?? 0;
	};

	it("does not re-enqueue a session whose projection would write nothing", async () => {
		// This tier has NO cursor at all — spec 350 records the `sessions` cursor as
		// observability only — so every discoverable session was re-logged on every
		// pass. Half of them carry no usage at all and are pure repeats (JOLLI-2224).
		await dbBackfillRepo({ repo, dbPath });
		expect(await loggedSessions("s1")).toBe(1);

		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(1);
	});

	it("still projects a session whose transcript moved on", async () => {
		await dbBackfillRepo({ repo, dbPath });

		vi.mocked(collectSessionEvents).mockResolvedValue([
			{ ...sessionEvent, updatedAtMs: sessionEvent.updatedAtMs + 1000, messageCount: 12 },
		]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		const row = await query<{ message_count: number }>(
			"SELECT message_count FROM sessions WHERE session_id = 's1'",
		);
		expect(row).toEqual([{ message_count: 12 }]);
	});

	// Every column the comparison reads, so an unchanged re-read has to clear all
	// of them rather than falling through on absent fields.
	const richSession: SessionUpsertedEvent = {
		...sessionEvent,
		title: "a conversation",
		startedAtMs: 1_700_000_000_000,
		messageCount: 9,
		durationMs: 45_000,
		inputTokens: 120,
		outputTokens: 40,
		cachedTokens: 8,
		estCostUsd: 0.031,
		tokenCoverage: "full",
		pricesAsOf: "2026-07-30",
	};

	it("does not re-enqueue a fully-populated session that is byte-identical", async () => {
		vi.mocked(collectSessionEvents).mockResolvedValue([richSession]);
		await dbBackfillRepo({ repo, dbPath });
		expect(await loggedSessions("s1")).toBe(1);

		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(1);
	});

	it("still projects a session whose token totals moved without its timestamp", async () => {
		// A better parser re-reading the same transcript slice: `updated_at_ms` is
		// unchanged, so the tokens are the only thing that can say the row is stale.
		vi.mocked(collectSessionEvents).mockResolvedValue([richSession]);
		await dbBackfillRepo({ repo, dbPath });

		vi.mocked(collectSessionEvents).mockResolvedValue([{ ...richSession, inputTokens: 500 }]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		const row = await query<{ input_tokens: number }>("SELECT input_tokens FROM sessions WHERE session_id = 's1'");
		expect(row).toEqual([{ input_tokens: 500 }]);
	});

	it("still projects a session whose title arrived later", async () => {
		// A COALESCE'd column: absent leaves the stored value alone (and is not a
		// difference), but a present one that disagrees is a real write.
		const { title: _none, ...untitled } = richSession;
		vi.mocked(collectSessionEvents).mockResolvedValue([untitled]);
		await dbBackfillRepo({ repo, dbPath });

		vi.mocked(collectSessionEvents).mockResolvedValue([richSession]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		const row = await query<{ title: string }>("SELECT title FROM sessions WHERE session_id = 's1'");
		expect(row).toEqual([{ title: "a conversation" }]);
	});

	it("still projects a session whose model split arrived later", async () => {
		// The child tables are replace-when-observed, so a session that had no split
		// and now has one is a real write — the same shape as a COALESCE'd column
		// filling in, one table further down.
		await dbBackfillRepo({ repo, dbPath });

		vi.mocked(collectSessionEvents).mockResolvedValue([
			{
				...sessionEvent,
				models: [{ model: "claude-opus-5", inputTokens: 10, outputTokens: 5, cachedTokens: 0 }],
			},
		]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		const usage = await query<{ model: string }>("SELECT model FROM session_model_usage");
		expect(usage).toEqual([{ model: "claude-opus-5" }]);
	});

	// The child tables are the LAST source of per-run churn: measured on a real
	// machine, two back-to-back `jolli dashboard` runs each re-projected the same
	// 17 sessions, byte-identical, purely because they carried a model split
	// (JOLLI-2224 follow-up). Every one of these events is compared against the
	// rows it would write rather than against `projectSession`'s merge RULES —
	// the rules are what a restatement would drift from.
	const modelSession: SessionUpsertedEvent = {
		...sessionEvent,
		tokenCoverage: "full",
		models: [
			{ model: "claude-opus-5", inputTokens: 100, outputTokens: 50, cachedTokens: 10, estCostUsd: 0.5 },
			{ model: "claude-haiku-4-5", inputTokens: 20, outputTokens: 5, cachedTokens: 0 },
		],
	};

	const toolSession: SessionUpsertedEvent = {
		...sessionEvent,
		tools: [
			{ name: "Bash", kind: "builtin", calls: 40, lastCallAtMs: 1_700_000_040_000 },
			{ name: "jollimemory.recall", kind: "mcp", server: "jollimemory", calls: 1 },
		],
	};

	it("does not re-enqueue a session whose model split is unchanged", async () => {
		vi.mocked(collectSessionEvents).mockResolvedValue([modelSession]);
		await dbBackfillRepo({ repo, dbPath });
		expect(await loggedSessions("s1")).toBe(1);

		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(1);
	});

	it("still projects a session whose model split moved", async () => {
		vi.mocked(collectSessionEvents).mockResolvedValue([modelSession]);
		await dbBackfillRepo({ repo, dbPath });

		const [opus, haiku] = modelSession.models ?? [];
		vi.mocked(collectSessionEvents).mockResolvedValue([
			{ ...modelSession, models: [{ ...opus, outputTokens: 900 }, haiku] },
		]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		const row = await query<{ output_tokens: number }>(
			"SELECT output_tokens FROM session_model_usage WHERE model = 'claude-opus-5'",
		);
		expect(row).toEqual([{ output_tokens: 900 }]);
	});

	it("still projects a session that dropped a model", async () => {
		// The split is replaced WHOLESALE, so a shrinking set is a real write even
		// though every surviving row is identical — comparing only the rows the
		// event carries would leave the dropped one behind forever.
		vi.mocked(collectSessionEvents).mockResolvedValue([modelSession]);
		await dbBackfillRepo({ repo, dbPath });

		vi.mocked(collectSessionEvents).mockResolvedValue([
			{ ...modelSession, models: [(modelSession.models ?? [])[0]] },
		]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		const rows = await query<{ model: string }>("SELECT model FROM session_model_usage ORDER BY model");
		expect(rows).toEqual([{ model: "claude-opus-5" }]);
	});

	it("still projects a session that swapped one model for another", async () => {
		// Equal cardinality, so the size check passes and only the per-key lookup can
		// tell these apart. A rename is the ordinary way this happens.
		vi.mocked(collectSessionEvents).mockResolvedValue([modelSession]);
		await dbBackfillRepo({ repo, dbPath });

		const [opus, haiku] = modelSession.models ?? [];
		vi.mocked(collectSessionEvents).mockResolvedValue([
			{ ...modelSession, models: [opus, { ...haiku, model: "claude-haiku-5" }] },
		]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		const rows = await query<{ model: string }>("SELECT model FROM session_model_usage ORDER BY model");
		expect(rows).toEqual([{ model: "claude-haiku-5" }, { model: "claude-opus-5" }]);
	});

	it("still projects a session whose model was repriced", async () => {
		// Same tokens, different cost — a `PRICES_AS_OF` bump re-costing an existing
		// split. Nothing in the token columns moves, so the cost is the only witness.
		vi.mocked(collectSessionEvents).mockResolvedValue([modelSession]);
		await dbBackfillRepo({ repo, dbPath });

		const [opus, haiku] = modelSession.models ?? [];
		vi.mocked(collectSessionEvents).mockResolvedValue([
			{ ...modelSession, models: [{ ...opus, estCostUsd: 0.75 }, haiku] },
		]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		const row = await query<{ est_cost_usd: number }>("SELECT est_cost_usd FROM sessions WHERE session_id = 's1'");
		expect(row).toEqual([{ est_cost_usd: 0.75 }]);
	});

	it("still projects a session whose cost moved with no model split to explain it", async () => {
		// `est_cost_usd` cannot ride with the verbatim COALESCE'd columns — a split
		// makes its written value a SUM — so it is compared on its own. This is the
		// no-split half of that comparison.
		vi.mocked(collectSessionEvents).mockResolvedValue([richSession]);
		await dbBackfillRepo({ repo, dbPath });

		vi.mocked(collectSessionEvents).mockResolvedValue([{ ...richSession, estCostUsd: 0.99 }]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		const row = await query<{ est_cost_usd: number }>("SELECT est_cost_usd FROM sessions WHERE session_id = 's1'");
		expect(row).toEqual([{ est_cost_usd: 0.99 }]);
	});

	it("still projects a session whose stored display model went stale", async () => {
		// `sessions.model` is COALESCE'd and derived (highest-token model), so it can
		// disagree with a split that itself matches — an older build that picked the
		// primary differently leaves exactly this state behind. Compared separately
		// for that reason; the split alone would call this session unchanged.
		vi.mocked(collectSessionEvents).mockResolvedValue([modelSession]);
		await dbBackfillRepo({ repo, dbPath });
		await withDashboardDb((db) => db.prepare("UPDATE sessions SET model = 'claude-haiku-4-5'").run(), { dbPath });

		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		const row = await query<{ model: string }>("SELECT model FROM sessions WHERE session_id = 's1'");
		expect(row).toEqual([{ model: "claude-opus-5" }]);
	});

	it("does not re-enqueue a usage-less re-read carrying an empty model split", async () => {
		// `models: []` with no scalar tokens is "unobserved", not "no models": the
		// projection's delete is gated on `hasUsage`, so it writes NOTHING and the
		// stored split survives. Comparing the empty list against the stored rows
		// would call that a difference and re-project on every pass.
		vi.mocked(collectSessionEvents).mockResolvedValue([modelSession]);
		await dbBackfillRepo({ repo, dbPath });

		const { models: _dropped, tokenCoverage: _coverage, ...bare } = modelSession;
		vi.mocked(collectSessionEvents).mockResolvedValue([{ ...bare, models: [] }]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(1);
		const rows = await query<{ model: string }>("SELECT model FROM session_model_usage ORDER BY model");
		expect(rows).toEqual([{ model: "claude-haiku-4-5" }, { model: "claude-opus-5" }]);
	});

	it("does not re-enqueue an unobserved re-read that restates the stored coverage", async () => {
		// No tokens and no split, so the projection carries the stored values
		// forward and only `token_coverage` is even eligible to move. Restating the
		// value it already holds is not a move.
		const unobserved: SessionUpsertedEvent = { ...sessionEvent, tokenCoverage: "sessions-only" };
		vi.mocked(collectSessionEvents).mockResolvedValue([unobserved]);
		await dbBackfillRepo({ repo, dbPath });
		expect(await loggedSessions("s1")).toBe(1);

		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(1);
	});

	it("still projects an unobserved re-read whose cost moved", async () => {
		// `est_cost_usd` is the one derived column that does not ride on `hasUsage`:
		// its fallback chain reaches the event's own scalar BEFORE the stored value,
		// so a token-less event carrying a price writes it. Comparing only
		// `token_coverage` on this branch skipped such an event forever, and the
		// price it brought never reached the row.
		const priced: SessionUpsertedEvent = { ...sessionEvent, estCostUsd: 0.25 };
		vi.mocked(collectSessionEvents).mockResolvedValue([priced]);
		await dbBackfillRepo({ repo, dbPath });

		vi.mocked(collectSessionEvents).mockResolvedValue([{ ...priced, estCostUsd: 0.4 }]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		const row = await query<{ est_cost_usd: number }>("SELECT est_cost_usd FROM sessions WHERE session_id = 's1'");
		expect(row).toEqual([{ est_cost_usd: 0.4 }]);
	});

	it("does not re-enqueue an unobserved re-read restating the stored cost", async () => {
		// The other half of the check above: hoisting the cost comparison ahead of
		// the carry-forward return must not turn a token-less session into one that
		// re-projects on every pass just because it carries a price at all.
		vi.mocked(collectSessionEvents).mockResolvedValue([{ ...sessionEvent, estCostUsd: 0.25 }]);
		await dbBackfillRepo({ repo, dbPath });
		expect(await loggedSessions("s1")).toBe(1);

		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(1);
	});

	it("does not re-enqueue a session whose tokens are observed without a coverage claim", async () => {
		// An event that observed usage but names no coverage is written as
		// `sessions-only`, so the comparison has to apply the same default rather
		// than reading the absent field as "no opinion".
		const { tokenCoverage: _absent, ...unclaimed } = richSession;
		vi.mocked(collectSessionEvents).mockResolvedValue([unclaimed]);
		await dbBackfillRepo({ repo, dbPath });
		expect(await loggedSessions("s1")).toBe(1);

		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(1);
	});

	it("does not re-enqueue a session whose tool calls are unchanged", async () => {
		vi.mocked(collectSessionEvents).mockResolvedValue([toolSession]);
		await dbBackfillRepo({ repo, dbPath });
		expect(await loggedSessions("s1")).toBe(1);

		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(1);
	});

	it("still projects a session whose tool call count moved", async () => {
		vi.mocked(collectSessionEvents).mockResolvedValue([toolSession]);
		await dbBackfillRepo({ repo, dbPath });

		const [bash, recall] = toolSession.tools ?? [];
		vi.mocked(collectSessionEvents).mockResolvedValue([
			{ ...toolSession, tools: [{ ...bash, calls: 41 }, recall] },
		]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		const row = await query<{ calls: number }>("SELECT calls FROM session_tool_use WHERE tool_name = 'Bash'");
		expect(row).toEqual([{ calls: 41 }]);
	});

	it("still projects a session that dropped a tool", async () => {
		vi.mocked(collectSessionEvents).mockResolvedValue([toolSession]);
		await dbBackfillRepo({ repo, dbPath });

		vi.mocked(collectSessionEvents).mockResolvedValue([{ ...toolSession, tools: [(toolSession.tools ?? [])[0]] }]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		const rows = await query<{ tool_name: string }>("SELECT tool_name FROM session_tool_use");
		expect(rows).toEqual([{ tool_name: "Bash" }]);
	});

	it("still projects a session whose tool list repeats one name and kind", async () => {
		// A repeated `(name, kind)` COLLAPSES on insert — the pair is that table's
		// key — so N entries can produce fewer than N rows. Counting entries against
		// stored rows is therefore not enough on its own: here two entries meet two
		// stored rows, and projecting would leave ONE, deleting `Read`.
		const bash = { name: "Bash", kind: "builtin", calls: 40, lastCallAtMs: 1_700_000_040_000 } as const;
		vi.mocked(collectSessionEvents).mockResolvedValue([
			{ ...sessionEvent, tools: [bash, { name: "Read", kind: "builtin", calls: 3 }] },
		]);
		await dbBackfillRepo({ repo, dbPath });

		vi.mocked(collectSessionEvents).mockResolvedValue([{ ...sessionEvent, tools: [bash, bash] }]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		const rows = await query<{ tool_name: string }>("SELECT tool_name FROM session_tool_use ORDER BY tool_name");
		expect(rows).toEqual([{ tool_name: "Bash" }]);
	});

	it("still projects a session that swapped one tool for another", async () => {
		vi.mocked(collectSessionEvents).mockResolvedValue([toolSession]);
		await dbBackfillRepo({ repo, dbPath });

		const [bash, recall] = toolSession.tools ?? [];
		vi.mocked(collectSessionEvents).mockResolvedValue([
			{ ...toolSession, tools: [bash, { ...recall, name: "jollimemory.search" }] },
		]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		const rows = await query<{ tool_name: string }>("SELECT tool_name FROM session_tool_use ORDER BY tool_name");
		expect(rows).toEqual([{ tool_name: "Bash" }, { tool_name: "jollimemory.search" }]);
	});

	it("still projects a session whose MCP tool changed server", async () => {
		// `server` is not part of the key, so a tool that moved between servers keeps
		// its row identity — only the column moves, and only this check sees it.
		vi.mocked(collectSessionEvents).mockResolvedValue([toolSession]);
		await dbBackfillRepo({ repo, dbPath });

		const [bash, recall] = toolSession.tools ?? [];
		vi.mocked(collectSessionEvents).mockResolvedValue([
			{ ...toolSession, tools: [bash, { ...recall, server: "jollimemory-remote" }] },
		]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		const row = await query<{ server: string }>("SELECT server FROM session_tool_use WHERE kind = 'mcp'");
		expect(row).toEqual([{ server: "jollimemory-remote" }]);
	});

	it("still projects a session whose tool lost its recorded instant", async () => {
		// The MAX around `last_call_at_ms` cannot save the stored instant here: the
		// projection DELETEs the tool rows before inserting, so there is no
		// conflicting row for it to consult and the re-read's absent time lands as
		// NULL. That erasure is a real write, which is exactly why this comparison
		// may not treat "no instant" as equal to a stored one.
		vi.mocked(collectSessionEvents).mockResolvedValue([toolSession]);
		await dbBackfillRepo({ repo, dbPath });

		const [bash, recall] = toolSession.tools ?? [];
		const { lastCallAtMs: _gone, ...timeless } = bash;
		vi.mocked(collectSessionEvents).mockResolvedValue([{ ...toolSession, tools: [timeless, recall] }]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
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

			await dbBackfillRepo({ repo: { ...repo, worktrees: [a, b] }, dbPath });

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

			await dbBackfillRepo({ repo: { ...repo, worktrees: [a, b] }, dbPath });

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

			await dbBackfillRepo({ repo: { ...repo, worktrees: [a2, b2] }, dbPath });

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
		// where neither could load a summary index lost its whole branch attribution
		// on the next sweep.
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
			await dbBackfillRepo({ repo: { ...repo, worktrees: [a3, b3] }, dbPath });

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
			await dbBackfillRepo({ repo: { ...repo, worktrees: [a3, b3] }, dbPath });

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

			await dbBackfillRepo({ repo: { ...repo, worktrees: [a, b] }, dbPath });

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
describe("dbBackfillRepo — progress", () => {
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
		await dbBackfillRepo({
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
			await dbBackfillRepo({
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
		await dbBackfillRepo({
			repo,
			dbPath,
			onProgress: (p) => {
				if (p.kind === "commits" && p.done === 0) seen.push(p.detail);
			},
		});
		expect(seen).toEqual([undefined]);
	});

	it("dbBackfillRepos stamps each repo's place in the run", async () => {
		const other: RegisteredRepo = { ...repo, repoIdentity: "https://example.com/other.git", repoName: "other" };
		const seen: Array<{ repoName: string; repoIndex: number; repoTotal: number }> = [];
		await dbBackfillRepos([repo, other], {
			dbPath,
			onProgress: (p) => seen.push({ repoName: p.repoName, repoIndex: p.repoIndex, repoTotal: p.repoTotal }),
		});
		expect(seen.some((p) => p.repoName === "jolliai" && p.repoIndex === 1 && p.repoTotal === 2)).toBe(true);
		expect(seen.some((p) => p.repoName === "other" && p.repoIndex === 2 && p.repoTotal === 2)).toBe(true);
	});

	it("runs unchanged when no callback is supplied", async () => {
		const result = await dbBackfillRepo({ repo, dbPath });
		expect(result.mode).toBe("bootstrapped");
	});
});

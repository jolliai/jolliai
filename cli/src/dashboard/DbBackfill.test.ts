import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// import type { KnowledgeGraph } from "../graph/GraphSchema.js"; // parked with the graph case
import type { StorageProvider } from "../core/StorageProvider.js";
import type { DashboardDbHandle } from "./DashboardDb.js";
import { getDashboardDbPath, withDashboardDb, withReadonlyDashboardDb } from "./DashboardDb.js";
import type {
	CommitCreatedEvent,
	CommitSummaryEvent,
	SessionUpsertedEvent,
	StatsModelUsage,
	WorktreeStatusEvent,
} from "./DashboardModel.js";
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
	// The session tier scopes itself to every linked worktree. The real helper
	// shells `git worktree list`; here the fixture repo IS the only checkout, so
	// the default answer is the identity — the same thing the real one degrades to
	// when git cannot answer.
	resolveWorktreeRoots: vi.fn(async (dir: string) => [dir]),
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
	// `isRepoDisabled` (via RepoRegistry) asks this for every registered checkout.
	// Default OFF so the existing cases sweep as before; the paused-repo cases below
	// flip it per worktree.
	readManualDisableFlagSync: vi.fn(() => false),
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
import { execGit, getHeadHash, listFilesInBranch, resolveWorktreeRoots } from "../core/GitOps.js";
import { scanKimiSessionsOnDisk } from "../core/KimiSessionDiscoverer.js";
import { scanOpenCodeSessionsOnDisk } from "../core/OpenCodeSessionDiscoverer.js";
import { readCutoverFence, readManualDisableFlagSync } from "../core/RepoProfile.js";
import { BACKFILL_SESSION_WINDOW_MS } from "../core/SessionWindow.js";
import { getIndex, resolveReadStorage } from "../core/SummaryStore.js";
import type { SkillUsage, StoredTranscript, ToolCallCount } from "../Types.js";
import { withIsolatedHome } from "../testUtils/isolatedHome.js";
import {
	collectCommitEvents,
	collectRepoGraph,
	collectSessionEvents,
	collectSummaryEvents,
	collectWorktreeEvent,
} from "./DashboardCollector.js";
import { sessionEventId } from "./DashboardModel.js";
import {
	backfillStoredActivity,
	dbBackfillRepo,
	dbBackfillRepos,
	dbRescanSessions,
	projectRepoRegistryState,
	pruneUnreachableCommits,
} from "./DbBackfill.js";
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

/**
 * Runs `fn` against a machine config with these keys set.
 *
 * A real `config.json` in a real (scratch) HOME rather than a mock, because the thing
 * under test is precisely that these tiers now READ that file — mocking `loadConfig`
 * would assert the wiring against itself. The harness already points HOME at a
 * per-worker scratch directory, so the default in every other test is "no config file",
 * i.e. every source enabled.
 */
async function withDisabledSources<T>(config: Record<string, boolean>, fn: () => Promise<T>): Promise<T> {
	const home = mkdtempSync(join(tmpdir(), "jolli-gate-home-"));
	mkdirSync(join(home, ".jolli", "jollimemory"), { recursive: true });
	writeFileSync(join(home, ".jolli", "jollimemory", "config.json"), JSON.stringify(config));
	try {
		return await withIsolatedHome(home, fn);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-backfill-"));
	dbPath = join(dir, "dashboard.db");
	// Re-armed per test, not left to the factory: `clearMocks` drops call history but
	// KEEPS an implementation, so a paused-repo case flipping this to `true` would
	// otherwise switch off every repo in every test that follows it.
	vi.mocked(readManualDisableFlagSync).mockReturnValue(false);
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

/** One repo's `disabled_at`, or null when it is enabled or has no row yet. */
async function pausedAt(repoIdentity: string): Promise<string | null> {
	const rows = await query<{ disabled_at: string | null }>(
		"SELECT disabled_at FROM repos WHERE repo_identity = ?",
		repoIdentity,
	);
	return rows[0]?.disabled_at ?? null;
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
			{ source: "sessions-read-generation", cursor: "9" },
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

	it("projects a switched-off repo's paused state and imports nothing for it", async () => {
		// Both halves matter. Nothing may be imported for a repo the user turned off —
		// and its PAUSED STATE still has to reach the database, because every read
		// surface filters on `repos.disabled_at IS NULL`. Filtering it out further
		// upstream leaves that column NULL forever, so a repo disabled from the VS Code
		// sidebar keeps counting in every KPI and reads as enabled on the page.
		const off: RegisteredRepo = { ...repo, repoIdentity: "local:off", repoName: "off" };
		await dbBackfillRepos([off], { dbPath });
		expect(await pausedAt("local:off")).toBeNull();

		vi.mocked(collectSessionEvents).mockClear();
		vi.mocked(readManualDisableFlagSync).mockReturnValue(true);
		const results = await dbBackfillRepos([off], { dbPath });

		expect(results).toEqual([{ mode: "disabled", eventsApplied: 0, repoName: "off" }]);
		// Never swept on the paused pass: no collector saw it.
		expect(vi.mocked(collectSessionEvents)).not.toHaveBeenCalled();
		expect(await pausedAt("local:off")).toEqual(expect.any(String));
	});

	it("preserves the paused timestamp across re-projections, and clears it on re-enable", async () => {
		// A boolean cannot say WHEN the user flipped it, so the stamp is minted on the
		// NULL → set transition and left alone afterwards. Re-minting it would be
		// invisible today (only nullness is read) and wrong the moment anything shows
		// "paused since": every `jolli dashboard` re-projects, so the date would track
		// the last launch instead of the decision.
		const off: RegisteredRepo = { ...repo, repoIdentity: "local:off", repoName: "off" };
		await dbBackfillRepos([off], { dbPath });
		vi.mocked(readManualDisableFlagSync).mockReturnValue(true);
		await dbBackfillRepos([off], { dbPath, now: () => 1_000 });
		const first = await pausedAt("local:off");
		expect(first).toEqual(expect.any(String));

		await dbBackfillRepos([off], { dbPath, now: () => 90_000_000 });
		expect(await pausedAt("local:off")).toBe(first);

		// Re-enabled: the ordinary enabled projection clears the column, so a later
		// pause mints a fresh stamp rather than resurrecting this one.
		vi.mocked(readManualDisableFlagSync).mockReturnValue(false);
		await dbBackfillRepos([off], { dbPath });
		expect(await pausedAt("local:off")).toBeNull();
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

	it("does not open a store the user switched off in Settings", async () => {
		// The toggle used to reach four surfaces and not this one: a user who turned
		// Cursor off saw it vanish from the sidebar and from their commit summaries while
		// `jolli dashboard` kept scanning its store and writing its sessions on every run.
		await withDisabledSources({ cursorEnabled: false }, () => dbBackfillRepos([repo], { dbPath }));

		expect(scanCursorComposersOnDisk).not.toHaveBeenCalled();
		// The other sources are untouched — this is a per-source switch, not a kill switch.
		expect(scanCodexSessionsOnDisk).toHaveBeenCalled();
		expect(scanClaudeSessionsOnDisk).toHaveBeenCalled();
	});

	it("opens every store when nothing is switched off", async () => {
		// The other direction, so the test above cannot pass by the scan never running.
		await dbBackfillRepos([repo], { dbPath });

		expect(scanCursorComposersOnDisk).toHaveBeenCalled();
	});

	it("hands the session tier its checkouts and its worktrees as SEPARATE lists", async () => {
		// Two granularities, and conflating them loses sessions. `worktreeRoots` is the
		// union of every linked worktree of every registered checkout, because a
		// conversation is keyed by the directory it ran in. `checkoutRoots` names the
		// checkouts themselves, because that is what a worktree-spanning source is asked
		// at — such a source resolves the worktrees of the repository it is HANDED, so
		// one call answers for one clone and reaches no other clone's `.git`.
		const cloneB = join(dir, "clone-b");
		mkdirSync(cloneB, { recursive: true });
		vi.mocked(resolveWorktreeRoots).mockImplementation(async (root: string) => [root, join(root, "wt")]);

		await dbBackfillRepos([{ ...repo, worktrees: [repo.worktreeRoot, cloneB] }], { dbPath });

		const opts = vi.mocked(collectSessionEvents).mock.calls[0][0];
		expect([...(opts.checkoutRoots ?? [])].sort()).toEqual([repo.worktreeRoot, cloneB].sort());
		// The linked worktrees reach the per-root half and only that half.
		expect(opts.worktreeRoots).toContain(join(cloneB, "wt"));
		expect(opts.checkoutRoots).not.toContain(join(cloneB, "wt"));
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
		expect(cursors).toEqual([{ source: "sessions-read-generation", cursor: "9" }]);
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
		expect(cursors).toEqual([{ cursor: "9" }]);
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

	it("still projects a session whose activity buckets arrived later", async () => {
		// The regression this comparison exists to stop repeating: `session_activity`
		// shipped as a new table, so every already-stored session was byte-identical on
		// every OTHER column and the event was dropped before the projection could
		// insert a single bucket. Re-reading the transcript does not help — it rebuilds
		// the event, and this is the gate the event dies at.
		vi.mocked(collectSessionEvents).mockResolvedValue([richSession]);
		await dbBackfillRepo({ repo, dbPath });

		vi.mocked(collectSessionEvents).mockResolvedValue([
			{ ...richSession, activityBuckets: [1_700_000_000_000, 1_700_000_900_000] },
		]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		const rows = await query<{ bucket_ms: number }>(
			`SELECT a.bucket_ms FROM session_activity a
			   JOIN sessions s ON s.event_id = a.session_event_id
			  WHERE s.session_id = 's1' ORDER BY a.bucket_ms`,
		);
		expect(rows).toEqual([{ bucket_ms: 1_700_000_000_000 }, { bucket_ms: 1_700_000_900_000 }]);
	});

	it("does not re-enqueue a session whose buckets are all stored, including a shrinking re-read", async () => {
		// CONTAINMENT, not set equality. A re-read that yields FEWER buckets is routine
		// (a host truncated its store, Devin's regenerated main chain walks a different
		// branch), and the insert-only projection would keep the missing ones anyway —
		// so calling that a change would re-project the session on every pass forever to
		// write nothing at all.
		const withBuckets = { ...richSession, activityBuckets: [1_700_000_000_000, 1_700_000_900_000] };
		vi.mocked(collectSessionEvents).mockResolvedValue([withBuckets]);
		await dbBackfillRepo({ repo, dbPath });
		expect(await loggedSessions("s1")).toBe(1);

		vi.mocked(collectSessionEvents).mockResolvedValue([withBuckets]);
		await dbBackfillRepo({ repo, dbPath });
		vi.mocked(collectSessionEvents).mockResolvedValue([{ ...richSession, activityBuckets: [1_700_000_000_000] }]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(1);
		const rows = await query<{ c: number }>(
			`SELECT COUNT(*) c FROM session_activity a
			   JOIN sessions s ON s.event_id = a.session_event_id
			  WHERE s.session_id = 's1'`,
		);
		expect(rows).toEqual([{ c: 2 }]);
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

	it("does not re-enqueue a session whose split names ONE model twice", async () => {
		// The write path merges same-model entries (`ON CONFLICT(session_event_id, model)
		// DO UPDATE … + excluded`), so two segments of one model land as one summed row.
		// The comparison used to skip that fold on the strength of a docblock claiming a
		// duplicate "would throw, not merge" — true before the conflict clause, false after
		// — so `models.length !== stored.size` reported CHANGED forever. Permanent churn:
		// every dashboard run and every 30-second tick re-projected the session and appended
		// another byte-identical `events_raw` row, kept for `PROJECTED_RETENTION_DAYS`.
		const split: SessionUpsertedEvent = {
			...sessionEvent,
			tokenCoverage: "full",
			models: [
				{ model: "claude-opus-5", inputTokens: 100, outputTokens: 50, cachedTokens: 10, estCostUsd: 0.5 },
				{ model: "claude-opus-5", inputTokens: 7, outputTokens: 3, cachedTokens: 1, estCostUsd: 0.25 },
			],
		};
		vi.mocked(collectSessionEvents).mockResolvedValue([split]);
		await dbBackfillRepo({ repo, dbPath });
		expect(await loggedSessions("s1")).toBe(1);
		// One row, summed — the shape the comparison has to be measured against.
		expect(
			await query(
				"SELECT model, input_tokens, output_tokens, cached_tokens, est_cost_usd FROM session_model_usage",
			),
		).toEqual([
			{ model: "claude-opus-5", input_tokens: 107, output_tokens: 53, cached_tokens: 11, est_cost_usd: 0.75 },
		]);

		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(1);
	});

	it("keeps a summed cost NULL when both duplicate segments are unpriced", async () => {
		// NULL means "unpriced", not zero — the upsert's cost arm is a CASE for exactly this
		// reason, and the comparison's fold has to reproduce it. Summing two unpriced
		// segments as `0 + 0` would store a priced 0.00, which every reader takes for a real
		// answer, and would then also disagree with the stored row on every later pass.
		vi.mocked(collectSessionEvents).mockResolvedValue([
			{
				...sessionEvent,
				tokenCoverage: "full",
				models: [
					{ model: "claude-opus-5", inputTokens: 100, outputTokens: 50, cachedTokens: 0 },
					{ model: "claude-opus-5", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
				],
			},
		]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await query("SELECT est_cost_usd FROM session_model_usage")).toEqual([{ est_cost_usd: null }]);

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

	it("does not re-enqueue sparse tool evidence that the writer would preserve", async () => {
		// A truncated transcript can lose attribution and see only an earlier call.
		// StatsWriter carries the tokens forward and takes the later timestamp, so the
		// unchanged filter must compare against that merged result or this session is
		// re-projected forever while its stored row never moves.
		const lastCallAtMs = 1_700_000_040_000;
		const attributed = {
			name: "code-review",
			kind: "skill" as const,
			calls: 1,
			lastCallAtMs,
			usage: { input: 1, output: 2, cached: 3, confidence: "attributed" as const },
		};
		vi.mocked(collectSessionEvents).mockResolvedValue([{ ...sessionEvent, tools: [attributed] }]);
		await dbBackfillRepo({ repo, dbPath });
		expect(await loggedSessions("s1")).toBe(1);

		const { usage: _lost, ...withoutUsage } = attributed;
		vi.mocked(collectSessionEvents).mockResolvedValue([
			{ ...sessionEvent, tools: [{ ...withoutUsage, lastCallAtMs: lastCallAtMs - 1_000 }] },
		]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(1);
		expect(
			await query(
				`SELECT last_call_at_ms, input_tokens, output_tokens, cached_tokens, usage_confidence
				   FROM session_tool_use WHERE tool_name = 'code-review'`,
			),
		).toEqual([
			{
				last_call_at_ms: lastCallAtMs,
				input_tokens: 1,
				output_tokens: 2,
				cached_tokens: 3,
				usage_confidence: "attributed",
			},
		]);
	});

	it("projects each independently changed skill-usage field", async () => {
		const skill = {
			name: "code-review",
			kind: "skill" as const,
			calls: 1,
			usage: { input: 1, output: 2, cached: 3, confidence: "attributed" as const },
		};
		const eventWithUsage = (usage: SkillUsage): SessionUpsertedEvent => ({
			...sessionEvent,
			tools: [{ ...skill, usage }],
		});

		const revisions = [
			skill.usage,
			{ ...skill.usage, input: 9 },
			{ ...skill.usage, input: 9, output: 8 },
			{ ...skill.usage, input: 9, output: 8, cached: 7 },
			{ input: 9, output: 8, cached: 7, confidence: "estimated" as const },
		];
		for (const usage of revisions) {
			vi.mocked(collectSessionEvents).mockResolvedValue([eventWithUsage(usage)]);
			await dbBackfillRepo({ repo, dbPath });
		}

		expect(await loggedSessions("s1")).toBe(revisions.length);
		expect(
			await query<{
				input_tokens: number;
				output_tokens: number;
				cached_tokens: number;
				usage_confidence: string;
			}>(
				`SELECT input_tokens, output_tokens, cached_tokens, usage_confidence
				   FROM session_tool_use WHERE kind = 'skill'`,
			),
		).toEqual([{ input_tokens: 9, output_tokens: 8, cached_tokens: 7, usage_confidence: "estimated" }]);
	});

	/**
	 * The per-entry table is a THIRD child table this comparison has to mirror, and
	 * omitting it left `skill_invocations` permanently empty when it shipped: the
	 * generation bump re-read every transcript and this function threw the result away
	 * because the call counts had not moved. Same trap as the token columns on
	 * `StoredToolRow`, one table further along.
	 */
	const skillSession: SessionUpsertedEvent = {
		...sessionEvent,
		tools: [
			{
				name: "code-review",
				kind: "skill",
				calls: 1,
				invocations: [{ at: "2026-08-01T10:00:00.000Z", ok: true, entryPath: "tool" }],
			},
		],
	};

	it("does not re-enqueue a session whose skill entries are unchanged", async () => {
		vi.mocked(collectSessionEvents).mockResolvedValue([skillSession]);
		await dbBackfillRepo({ repo, dbPath });
		expect(await loggedSessions("s1")).toBe(1);

		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(1);
	});

	it("still projects a session whose only change is a NEW skill entry", async () => {
		// The call count moves with it here, but the point is the row that has to land:
		// a second entry at its own instant, which only the per-entry comparison can ask
		// about.
		vi.mocked(collectSessionEvents).mockResolvedValue([skillSession]);
		await dbBackfillRepo({ repo, dbPath });

		const [skill] = skillSession.tools ?? [];
		vi.mocked(collectSessionEvents).mockResolvedValue([
			{
				...skillSession,
				tools: [
					{
						...skill,
						calls: 2,
						invocations: [
							{ at: "2026-08-01T11:00:00.000Z", ok: true, entryPath: "tool" },
							{ at: "2026-08-01T10:00:00.000Z", ok: true, entryPath: "tool" },
						],
					},
				],
			},
		]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		expect(await query<{ n: number }>("SELECT COUNT(*) AS n FROM skill_invocations")).toEqual([{ n: 2 }]);
	});

	it("still projects a new skill entry when the aggregate call count is unchanged", async () => {
		// A generation bump can discover invocation detail that the older reader never
		// emitted. The aggregate row is already byte-identical in that case, so only
		// the missing detail row can make the re-read observable.
		const [skill] = skillSession.tools ?? [];
		vi.mocked(collectSessionEvents).mockResolvedValue([
			{ ...skillSession, tools: [{ ...skill, invocations: undefined }] },
		]);
		await dbBackfillRepo({ repo, dbPath });

		vi.mocked(collectSessionEvents).mockResolvedValue([skillSession]);
		await dbBackfillRepo({ repo, dbPath });
		// The reverse read is intentionally one-sided: detail learned on the second
		// pass survives when a compacted transcript no longer emits it, and the third
		// pass settles instead of re-projecting forever.
		vi.mocked(collectSessionEvents).mockResolvedValue([
			{ ...skillSession, tools: [{ ...skill, invocations: undefined }] },
		]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		expect(await query<{ n: number }>("SELECT COUNT(*) AS n FROM skill_invocations")).toEqual([{ n: 1 }]);
	});

	it("still projects a session whose entry OUTCOME moved, with every other figure equal", async () => {
		// The case the count cannot see: a window that closed mid-invocation stored an
		// optimistic `ok: true`, and the re-read that learned it failed carries the same
		// name, the same count and the same instant. Reporting it unchanged would freeze
		// that optimism in the database forever.
		vi.mocked(collectSessionEvents).mockResolvedValue([skillSession]);
		await dbBackfillRepo({ repo, dbPath });

		const [skill] = skillSession.tools ?? [];
		vi.mocked(collectSessionEvents).mockResolvedValue([
			{
				...skillSession,
				tools: [
					{
						...skill,
						invocations: [
							{
								at: "2026-08-01T10:00:00.000Z",
								ok: false,
								entryPath: "tool",
								outcomeObserved: true,
							},
						],
					},
				],
			},
		]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		expect(await query<{ ok: number }>("SELECT ok FROM skill_invocations")).toEqual([{ ok: 0 }]);
	});

	it("still projects a session whose optimistic outcome became observed", async () => {
		const [skill] = skillSession.tools ?? [];
		vi.mocked(collectSessionEvents).mockResolvedValue([
			{
				...skillSession,
				tools: [
					{
						...skill,
						invocations: [
							{
								at: "2026-08-01T10:00:00.000Z",
								ok: true,
								entryPath: "tool",
								outcomeObserved: false,
							},
						],
					},
				],
			},
		]);
		await dbBackfillRepo({ repo, dbPath });

		vi.mocked(collectSessionEvents).mockResolvedValue([
			{
				...skillSession,
				tools: [
					{
						...skill,
						invocations: [
							{
								at: "2026-08-01T10:00:00.000Z",
								ok: true,
								entryPath: "tool",
								outcomeObserved: true,
							},
						],
					},
				],
			},
		]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		expect(await query<{ ok_confidence: string }>("SELECT ok_confidence FROM skill_invocations")).toEqual([
			{ ok_confidence: "observed" },
		]);
	});

	it("projects each independently changed skill-entry field", async () => {
		const at = "2026-08-01T10:00:00.000Z";
		const eventWithEntry = (
			invocation: {
				at: string;
				ok: boolean;
				entryPath?: "tool" | "command";
				outcomeObserved?: boolean;
				args?: string;
				bodyChars?: number;
			},
			detection?: "heuristic",
		): SessionUpsertedEvent => ({
			...sessionEvent,
			tools: [
				{
					name: "code-review",
					kind: "skill",
					calls: 1,
					...(detection ? { detection } : {}),
					invocations: [invocation],
				},
			],
		});

		const revisions: SessionUpsertedEvent[] = [
			eventWithEntry({ at, ok: true, entryPath: "tool", args: "--base main", bodyChars: 100 }),
			// Identical, and deliberately still carrying args/body: exercises the
			// COALESCE-aware equality path before the following mutations.
			eventWithEntry({ at, ok: true, entryPath: "tool", args: "--base main", bodyChars: 100 }),
			// The path changes, but weaker confidence cannot erase the observed result.
			eventWithEntry({ at, ok: true, entryPath: "command", args: "--base main", bodyChars: 100 }),
			// Unknown still changes entry_path independently.
			eventWithEntry({ at, ok: true, args: "--base main", bodyChars: 100 }),
			eventWithEntry({ at, ok: true, args: "--base main", bodyChars: 100 }, "heuristic"),
			eventWithEntry({ at, ok: true, args: "--base release", bodyChars: 100 }, "heuristic"),
			eventWithEntry({ at, ok: true, args: "--base release", bodyChars: 200 }, "heuristic"),
		];
		for (const event of revisions) {
			vi.mocked(collectSessionEvents).mockResolvedValue([event]);
			await dbBackfillRepo({ repo, dbPath });
		}

		// Seven reads, but the byte-identical second one is the only no-op.
		expect(await loggedSessions("s1")).toBe(revisions.length - 1);
		expect(
			await query<{
				ok_confidence: string;
				detection: string;
				entry_path: string | null;
				args: string;
				body_chars: number;
			}>("SELECT ok_confidence, detection, entry_path, args, body_chars FROM skill_invocations"),
		).toEqual([
			{
				ok_confidence: "observed",
				detection: "heuristic",
				entry_path: null,
				args: "--base release",
				body_chars: 200,
			},
		]);
	});

	it("ignores an unparseable skill-entry instant just like the writer", async () => {
		const event: SessionUpsertedEvent = {
			...sessionEvent,
			tools: [
				{
					name: "code-review",
					kind: "skill",
					calls: 1,
					invocations: [{ at: "not-a-date", ok: true, entryPath: "tool" }],
				},
			],
		};
		vi.mocked(collectSessionEvents).mockResolvedValue([event]);
		await dbBackfillRepo({ repo, dbPath });
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(1);
		expect(await query<{ n: number }>("SELECT COUNT(*) AS n FROM skill_invocations")).toEqual([{ n: 0 }]);
	});

	it("still projects a session whose skill gained a plugin label", async () => {
		vi.mocked(collectSessionEvents).mockResolvedValue([skillSession]);
		await dbBackfillRepo({ repo, dbPath });

		const [skill] = skillSession.tools ?? [];
		vi.mocked(collectSessionEvents).mockResolvedValue([
			{ ...skillSession, tools: [{ ...skill, plugin: "superpowers" }] },
		]);
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		expect(await query<{ plugin: string }>("SELECT plugin FROM session_tool_use WHERE kind = 'skill'")).toEqual([
			{ plugin: "superpowers" },
		]);
	});

	it("does not re-enqueue over a stored entry the newer read no longer mentions", async () => {
		// One-sided on purpose: the detail table is add-or-update with no DELETE, so a
		// row the event dropped is not a difference this projection would resolve.
		// Comparing sizes would re-project the session on every pass, forever, without
		// ever removing the row.
		const [skill] = skillSession.tools ?? [];
		vi.mocked(collectSessionEvents).mockResolvedValue([
			{
				...skillSession,
				tools: [
					{
						...skill,
						calls: 2,
						invocations: [
							{ at: "2026-08-01T11:00:00.000Z", ok: true, entryPath: "tool" },
							{ at: "2026-08-01T10:00:00.000Z", ok: true, entryPath: "tool" },
						],
					},
				],
			},
		]);
		await dbBackfillRepo({ repo, dbPath });
		expect(await loggedSessions("s1")).toBe(1);

		// A compacted conversation: the older entry is gone from the transcript, and the
		// count follows it down. `calls` moving is what makes this project once; the
		// assertion that matters is that it settles instead of re-projecting forever.
		vi.mocked(collectSessionEvents).mockResolvedValue([skillSession]);
		await dbBackfillRepo({ repo, dbPath });
		await dbBackfillRepo({ repo, dbPath });

		expect(await loggedSessions("s1")).toBe(2);
		expect(await query<{ n: number }>("SELECT COUNT(*) AS n FROM skill_invocations")).toEqual([{ n: 2 }]);
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

describe("dbRescanSessions", () => {
	/**
	 * Establishes a baseline — a completed session pass, which is exactly what
	 * `dbBackfillRepo` records: the generation cursor plus one `sessions` row per
	 * discovered session (here `s1` at `sessionEvent.updatedAtMs`).
	 */
	const withBaseline = async (): Promise<void> => {
		await dbBackfillRepo({ repo, dbPath });
	};

	/**
	 * An empty database, with no cursor for any repo.
	 *
	 * Needed explicitly now that phase 1 is a READ-ONLY open: a background timer must not
	 * create a machine-global database, so an absent file is answered `no-database`
	 * instead of being materialised. A case about a MISSING BASELINE therefore has to
	 * supply the file itself, or it is testing the other branch.
	 */
	const withEmptyDb = async (): Promise<void> => {
		await withDashboardDb(() => undefined, { dbPath });
	};

	/** The stored value of one `ingest_cursors` row for the fixture repo. */
	const cursorFor = (source: string): Promise<string | undefined> =>
		withDashboardDb(
			(db) => {
				const row = db
					.prepare(
						`SELECT c.cursor FROM ingest_cursors c JOIN repos r ON r.id = c.repo_id
						  WHERE r.repo_identity = ? AND c.source = ?`,
					)
					.get(repo.repoIdentity, source) as { cursor?: string } | undefined;
				return row?.cursor;
			},
			{ dbPath },
		);

	it("does nothing when no source has opted in", async () => {
		await withBaseline();

		await expect(dbRescanSessions({ repos: [repo], dbPath, sources: [], emitted: new Map() })).resolves.toEqual({
			reposScanned: 0,
			reposWithoutBaseline: 0,
			discovered: 0,
			processed: 0,
			eventsApplied: 0,
			failedSources: [],
			// Zero because this return happens BEFORE phase 1 reads the database — the
			// count is genuinely unknown here, not observed to be zero. See `idleWith`.
			failedEvents: 0,
			// Named rather than left to the caller to infer from an all-zero shape. The
			// off switch is supposed to read as "nothing to do", not as a prompt to run
			// `jolli dashboard` for a count of zero repos.
			idleReason: "no-sources",
		});
	});

	it("skips a re-scanned source the user switched off, and names it apart from the off switch", async () => {
		// A timer is where ignoring the toggle is least defensible: a user who turned
		// Codex off would have had its rollout tree stat-ed and its conversations re-read
		// every 30 seconds for the machine's whole uptime, with nothing on screen to say
		// it was still happening.
		//
		// `sources-disabled`, not `no-sources`: the latter is the documented build-level
		// off switch ("no definition declares daemonRescan"), and reporting it here would
		// describe the build rather than the user's own decision.
		const result = await withDisabledSources({ codexEnabled: false }, () =>
			dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() }),
		);

		expect(result.idleReason).toBe("sources-disabled");
		expect(scanCodexSessionsOnDisk).not.toHaveBeenCalled();
	});

	it("names 'no live checkout' apart from a missing baseline", async () => {
		// The other all-zero return. It used to be indistinguishable from a genuine
		// missing baseline, so the daemon told the user to run `jolli dashboard` in
		// repositories whose checkouts had been deleted.
		const gone: RegisteredRepo = { ...repo, worktreeRoot: join(dir, "gone") };

		const result = await dbRescanSessions({ repos: [gone], dbPath, emitted: new Map() });

		expect(result.idleReason).toBe("no-live-repos");
	});

	it("leaves the reason unset when the repos are simply un-baselined", async () => {
		await withEmptyDb();

		const result = await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() });

		expect(result.reposWithoutBaseline).toBe(1);
		expect(result.idleReason).toBeUndefined();
	});

	it("passes over a repo with no completed session pass", async () => {
		// Deliberately no `withBaseline()`. Without a generation cursor there is no
		// trustworthy set of stored instants to compare against, so every discovered
		// session would look new and the timer would re-parse the repo's whole history.
		await withEmptyDb();

		const result = await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() });

		expect(result.reposScanned).toBe(0);
		expect(result.reposWithoutBaseline).toBe(1);
		expect(result.processed).toBe(0);
	});

	it("answers 'no database' rather than creating one", async () => {
		// Phase 1 is a read-only open, so a machine that has never run `jolli dashboard`
		// gets an answer instead of a database. The writable handle used to CREATE
		// `jollimemory.db` here — a machine-global side effect from a background timer,
		// every 30 seconds, on a machine whose user never asked for it.
		const result = await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() });

		expect(result.idleReason).toBe("no-database");
		expect(existsSync(dbPath)).toBe(false);
	});

	it("answers 'database unusable' for a file it cannot read, rather than throwing", async () => {
		// `existsSync` answers "is there a file", not "is there a usable database": a
		// zero-byte or truncated `jollimemory.db` (a crashed create, an interrupted copy)
		// opens READ-ONLY without error and throws on the first statement. Left as a
		// rejection that became ONE warn for the daemon's entire lifetime — the caller's
		// dedup keys on the message — followed by permanent silence, for a state nothing on
		// this path can repair (it deliberately never migrates).
		writeFileSync(dbPath, "");

		const result = await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() });

		expect(result.idleReason).toBe("database-unusable");
		expect(result.reposScanned).toBe(0);
	});

	it("threads its window into the SCAN, not only into the collector", async () => {
		// The option was documented "so both passes see one set" while `scanAllStores`
		// hard-coded the back-fill's width — which made it purely decorative in the one
		// direction that matters: a wider window silently found nothing extra, because
		// nothing older than the pinned width was ever scanned. That is verbatim the failure
		// the code this replaced had documented.
		await withBaseline();

		await dbRescanSessions({ repos: [repo], dbPath, windowMs: 12_345, emitted: new Map() });

		expect(scanCodexSessionsOnDisk).toHaveBeenCalledWith(12_345);
	});

	it("passes every sibling checkout and worktree to the collector, matching the back-fill", async () => {
		// Regression: the tick used to hand `collectSessionEvents` only `cwd`, so it
		// narrowed `preScanned` against one checkout and a sibling's sessions failed
		// every source's path-containment rule by construction — invisible until the
		// next full back-fill. It must pass the SAME roots `dbBackfillRepo` does.
		const a = mkdtempSync(join(tmpdir(), "jolli-rescan-a-"));
		const b = mkdtempSync(join(tmpdir(), "jolli-rescan-b-"));
		try {
			vi.mocked(resolveWorktreeRoots).mockImplementation(async (root: string) => [root, join(root, "wt")]);
			const multi = { ...repo, worktrees: [a, b] };
			await dbBackfillRepo({ repo: multi, dbPath });
			vi.mocked(collectSessionEvents).mockClear();

			await dbRescanSessions({ repos: [multi], dbPath, emitted: new Map() });

			// Order is `existingWorktrees`' (newest checkout first), not asserted here —
			// what matters for the regression is that BOTH checkouts and BOTH their
			// linked worktrees reach the collector.
			const call = vi.mocked(collectSessionEvents).mock.calls.at(-1)?.[0];
			expect([...(call?.checkoutRoots ?? [])].sort()).toEqual([a, b].sort());
			expect([...(call?.worktreeRoots ?? [])].sort()).toEqual([a, join(a, "wt"), b, join(b, "wt")].sort());
		} finally {
			rmSync(a, { recursive: true, force: true });
			rmSync(b, { recursive: true, force: true });
		}
	});

	it("accepts a baseline recorded at an OLDER read generation", async () => {
		// PRESENCE, not equality. Requiring an exact match made every `SESSION_READ_
		// GENERATION` bump a silent, machine-wide off switch: on upgrade each repo still
		// carries the previous number, so no repo has a baseline, the pass warns once and
		// the timer does nothing until the user opens the dashboard — which is exactly the
		// user this feature exists for. A repo on an older generation has real read
		// receipts; they are simply the old scanner's, and healing those is the
		// back-fill's job, not the timer's.
		await withBaseline();
		await withDashboardDb(
			(db) =>
				db
					.prepare(
						`UPDATE ingest_cursors SET cursor = '1'
						  WHERE source = 'sessions-read-generation'`,
					)
					.run(),
			{ dbPath },
		);

		const result = await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() });

		expect(result.reposScanned).toBe(1);
		expect(result.reposWithoutBaseline).toBe(0);
	});

	it("still passes over a repo whose generation cursor is blank", async () => {
		// The cursor column is a free-form string; "" is not a generation any pass ever
		// claimed to have completed, so it counts as absent rather than as a baseline.
		await withBaseline();
		await withDashboardDb(
			(db) => db.prepare("UPDATE ingest_cursors SET cursor = '' WHERE source = 'sessions-read-generation'").run(),
			{ dbPath },
		);

		const result = await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() });

		expect(result.reposScanned).toBe(0);
		expect(result.reposWithoutBaseline).toBe(1);
	});

	it("re-projects a moved session and leaves both session cursors untouched", async () => {
		await withBaseline();
		const sessionsCursor = await cursorFor("sessions");
		const generation = await cursorFor("sessions-read-generation");
		vi.mocked(collectSessionEvents).mockResolvedValue([
			{ ...sessionEvent, updatedAtMs: sessionEvent.updatedAtMs + 60_000 },
		]);

		const result = await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() });

		expect(result.reposScanned).toBe(1);
		expect(result.processed).toBe(1);
		expect(result.eventsApplied).toBeGreaterThan(0);
		// The two writes this pass must never make: the generation cursor is the claim
		// "a FULL session pass completed", which a subset re-scan has not done, and
		// `sessions` is the back-fill's own progress marker.
		expect(await cursorFor("sessions")).toBe(sessionsCursor);
		expect(await cursorFor("sessions-read-generation")).toBe(generation);
	});

	it("writes no events_raw row for an event identical to the stored session", async () => {
		// The shape a 30-second timer meets constantly and a dashboard run almost never
		// does: the per-session skip could NOT stop this session — `readKnownSessions`
		// counts only `started_at_ms`/`duration_ms`, so a rollout that parsed to zero
		// entries has no receipt and is re-read every single tick — yet the row it would
		// write is the one already there. Unfiltered, that is one `events_raw` row every
		// 30 s that changes nothing, kept for `PROJECTED_RETENTION_DAYS`. The filter is
		// `dbBackfillRepo`'s own; this pins that the two apply phases share it.
		await withBaseline();
		const before = await query<{ n: number }>("SELECT COUNT(*) AS n FROM events_raw");
		vi.mocked(collectSessionEvents).mockResolvedValue([sessionEvent]);

		const result = await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() });

		// Discovered and re-read all the same — `processed` counts the read, not the write.
		expect(result.processed).toBe(1);
		expect(result.eventsApplied).toBe(0);
		expect(await query<{ n: number }>("SELECT COUNT(*) AS n FROM events_raw")).toEqual(before);
	});

	it("reports an unchanged tick with nothing applied", async () => {
		await withBaseline();
		vi.mocked(collectSessionEvents).mockResolvedValue([]);

		const result = await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() });

		expect(result.reposScanned).toBe(1);
		expect(result.processed).toBe(0);
		expect(result.eventsApplied).toBe(0);
	});

	it("builds the skip predicate from the stored instants, treating an equal one as current", async () => {
		await withBaseline();
		vi.mocked(collectSessionEvents).mockResolvedValue([]);

		await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() });
		const opts = vi.mocked(collectSessionEvents).mock.calls.at(-1)?.[0];

		expect(opts?.isAlreadyCurrent?.("claude", "s1", sessionEvent.updatedAtMs)).toBe(true);
		expect(opts?.isAlreadyCurrent?.("claude", "s1", sessionEvent.updatedAtMs + 1)).toBe(false);
		expect(opts?.isAlreadyCurrent?.("claude", "never-seen", 1)).toBe(false);
	});

	it("confines the tick to the opted-in sources with an empty loader", async () => {
		// The collector's default loader would run every other agent's per-repo discoverer
		// once per repo, every tick. Pinned because nothing else would notice it happening.
		await withBaseline();
		vi.mocked(collectSessionEvents).mockResolvedValue([]);

		await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() });
		const opts = vi.mocked(collectSessionEvents).mock.calls.at(-1)?.[0];

		await expect(opts?.loadSessions?.(repo.worktreeRoot)).resolves.toEqual([]);
	});

	it("reports a source whose machine-wide scan failed", async () => {
		await withBaseline();
		vi.mocked(scanCodexSessionsOnDisk).mockRejectedValue(new Error("store unreadable"));
		vi.mocked(collectSessionEvents).mockResolvedValue([]);

		const result = await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() });

		expect(result.failedSources).toEqual(["codex"]);
	});

	it("drops a repo whose recorded checkout no longer exists", async () => {
		const gone: RegisteredRepo = { ...repo, worktreeRoot: join(dir, "gone") };

		const result = await dbRescanSessions({ repos: [gone], dbPath, emitted: new Map() });

		expect(result.reposScanned).toBe(0);
		expect(result.reposWithoutBaseline).toBe(0);
	});

	/**
	 * The emission gate — `emitted`.
	 *
	 * Every case here uses a session with NO read receipt (no `startedAtMs`, no
	 * `durationMs`), because that is the only shape where the gate is reachable at all:
	 * `readKnownSessions` counts a row as evidence on exactly those two columns, so a
	 * session without them is invisible to the database gate no matter how many times
	 * it has been processed. Real examples are a rollout that parsed to zero entries
	 * (measured: 1 of 16 in-window Codex rollouts on one machine) and any event whose
	 * projection failed and therefore wrote no row at all.
	 */
	describe("emission gate", () => {
		/** A session the database gate can never recognise. See the block comment. */
		const noReceipt: SessionUpsertedEvent = {
			type: "session.upserted",
			repoIdentity: repo.repoIdentity,
			source: "codex",
			sessionId: "no-receipt",
			updatedAtMs: 1_700_000_090_000,
		};

		/** The predicate `collectSessionEvents` was handed on the most recent tick. */
		const lastPredicate = () => vi.mocked(collectSessionEvents).mock.calls.at(-1)?.[0].isAlreadyCurrent;

		/**
		 * A collector that HONOURS the skip predicate, the way the real one does.
		 *
		 * `mockResolvedValue` cannot express this feature at all: it returns its event
		 * whatever the gate says, so every assertion would be about a predicate rather
		 * than about an outcome. Asking the predicate from inside the mock is also the
		 * only way to see what it answered DURING a tick — read afterwards it reflects
		 * the map as the same tick left it, which is how the first draft of this suite
		 * managed to assert the opposite of what happened.
		 *
		 * Returns the per-tick answers so a case can pin "read, then skipped".
		 */
		const collectorHonouringGate = (event: SessionUpsertedEvent): ReadonlyArray<boolean> => {
			const skips: boolean[] = [];
			vi.mocked(collectSessionEvents).mockImplementation(async (opts) => {
				const skip = opts.isAlreadyCurrent?.(event.source, event.sessionId, event.updatedAtMs) ?? false;
				skips.push(skip);
				return skip ? [] : [event];
			});
			return skips;
		};

		it("skips a session it already emitted for, which the database gate cannot", async () => {
			await withBaseline();
			const skips = collectorHonouringGate(noReceipt);
			const emitted = new Map<string, number>();
			const before = await query<{ n: number }>("SELECT COUNT(*) AS n FROM events_raw");

			await dbRescanSessions({ repos: [repo], dbPath, emitted });
			await dbRescanSessions({ repos: [repo], dbPath, emitted });
			await dbRescanSessions({ repos: [repo], dbPath, emitted });

			// Read once, then skipped — the database holds no receipt for this session on
			// any of the three ticks, so the database gate said "not current" every time.
			expect(skips).toEqual([false, true, true]);
			// And the outcome that matters: ONE row, not one per tick. Unfiltered this is
			// 2,880 identical rows a day, none of which the prune ever removes.
			const after = await query<{ n: number }>("SELECT COUNT(*) AS n FROM events_raw");
			expect((after[0]?.n ?? 0) - (before[0]?.n ?? 0)).toBe(1);
		});

		it("lets a session through again once its file has grown", async () => {
			// The gate must never become a permanent block: it records a VERSION, not the
			// session, so a conversation that gains a turn is read again.
			await withBaseline();
			const emitted = new Map<string, number>();
			collectorHonouringGate(noReceipt);
			await dbRescanSessions({ repos: [repo], dbPath, emitted });

			const grown = { ...noReceipt, updatedAtMs: noReceipt.updatedAtMs + 60_000 };
			const skips = collectorHonouringGate(grown);
			const result = await dbRescanSessions({ repos: [repo], dbPath, emitted });

			expect(skips).toEqual([false]);
			expect(result.processed).toBe(1);
		});

		it("refuses a NEW key once the cap is reached, rather than clearing the map", async () => {
			// The whole-map clear the two `CodexSessionDiscoverer` memos use cannot converge
			// here, and that asymmetry is the decision: their refill is one `readdir`, while
			// this map's is a full scan of the largest table PLUS an event for every parked
			// session — and the seed comes from the same population that just overflowed, so a
			// clear lands back over the limit on the very next tick, every 30 s, with the gate
			// empty the whole time.
			await withBaseline();
			collectorHonouringGate(noReceipt);
			const emitted = new Map<string, number>([["session:someone-else:codex:kept", 1]]);

			await dbRescanSessions({ repos: [repo], dbPath, emitted, emittedLimit: 1 });

			expect([...emitted.keys()]).toEqual(["session:someone-else:codex:kept"]);
		});

		it("still refreshes a key it already holds when full", async () => {
			// The freshness update cannot grow the map, so the cap must not block it —
			// otherwise a full gate would freeze every entry at its first observed instant and
			// permanently stop re-reading the conversations it does still cover.
			await withBaseline();
			collectorHonouringGate(noReceipt);
			const emitted = new Map<string, number>([[noReceiptId(), 1]]);

			await dbRescanSessions({ repos: [repo], dbPath, emitted, emittedLimit: 1 });

			expect(emitted.get(noReceiptId())).toBe(noReceipt.updatedAtMs);
		});

		it("prunes projected events past retention, like the other two apply paths", async () => {
			// `applyStatsEvents` and `dbBackfillRepo` both prune; this path did not. On the
			// machine the feature exists for — a user who never opens the dashboard — the timer
			// is the ONLY writer of `session.upserted` rows, so nothing ever deleted a
			// `projected` row past `PROJECTED_RETENTION_DAYS` and the table only grew. That
			// feeds straight back into the seed, which is a full scan of exactly this table.
			await withBaseline();
			await logRawRow("session:someone-else:codex:ancient", JSON.stringify(noReceipt));
			collectorHonouringGate(noReceipt);

			await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() });

			const left = await query<{ n: number }>(
				"SELECT COUNT(*) AS n FROM events_raw WHERE event_id = 'session:someone-else:codex:ancient'",
			);
			expect(left[0]?.n).toBe(0);
		});

		it("records the OBSERVED instant, not the moment the row was written", async () => {
			// The difference is the one way this scheme can lose data. The mtime is sampled
			// before the transcript is read, so the recorded value is at or BEFORE the
			// content read — anything appended in between makes the next tick's mtime
			// larger and triggers a re-read. A write instant would be LATER than such an
			// append and would stamp it as already-seen, permanently, if the session then
			// stopped growing. Pinned by asserting the boundary sits exactly on the event's
			// own instant rather than somewhere after it.
			await withBaseline();
			collectorHonouringGate(noReceipt);
			const emitted = new Map<string, number>();

			await dbRescanSessions({ repos: [repo], dbPath, emitted });

			expect([...emitted.values()]).toContain(noReceipt.updatedAtMs);
		});

		it("records a session whose event the unchanged-filter dropped", async () => {
			// `unchangedSessionEvent` only ever prevented the WRITE. The read had already
			// happened, so the gate has to record it too — otherwise the identical session
			// is re-read (whole transcript, every tick) forever while never writing a row,
			// and the saving is only half of what it looks like.
			await withBaseline();
			vi.mocked(collectSessionEvents).mockResolvedValue([sessionEvent]);
			const emitted = new Map<string, number>();

			const result = await dbRescanSessions({ repos: [repo], dbPath, emitted });

			expect(result.eventsApplied).toBe(0);
			expect(lastPredicate()?.("claude", "s1", sessionEvent.updatedAtMs)).toBe(true);
		});

		it("seeds from the log so a restart does not re-emit", async () => {
			// A fresh map is what a restarted daemon has. Without the seed it would emit
			// once more for every already-parked session on its first tick.
			await withBaseline();
			collectorHonouringGate(noReceipt);
			await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() });

			const afterRestart = new Map<string, number>();
			const skips = collectorHonouringGate(noReceipt);
			await dbRescanSessions({ repos: [repo], dbPath, emitted: afterRestart, seedEmitted: true });

			expect(skips).toEqual([true]);
		});

		/**
		 * Appends one raw `session.upserted` row carrying `dataJson` VERBATIM.
		 *
		 * Written straight to `events_raw` rather than through a tick because that is the
		 * only way to put a document in the log this pass did not produce — another
		 * producer's claim, a value of the wrong type, or bytes that are not JSON at all,
		 * which is what the cases below are about. `projected` so the drain leaves it
		 * alone: a pending row would be projected into the same `sessions` row and the case
		 * would be measuring the projection instead of the seed.
		 */
		const logRawRow = (eventId: string, dataJson: string): Promise<void> =>
			withDashboardDb(
				(db) => {
					db.prepare(
						`INSERT INTO events_raw
						   (event_id, repo_identity, type, schema_version, received_at, data_json, projection_status)
						 VALUES (?, ?, 'session.upserted', 1, ?, ?, 'projected')`,
					).run(
						eventId,
						repo.repoIdentity,
						new Date(noReceipt.updatedAtMs + 600_000).toISOString(),
						dataJson,
					);
				},
				{ dbPath },
			);

		/** The event id of the fixture's no-receipt session. */
		const noReceiptId = (): string => sessionEventId(repo.repoIdentity, noReceipt.source, noReceipt.sessionId);

		/** That session, claimed at `updatedAtMs` by a producer other than this pass. */
		const logRow = (updatedAtMs: unknown): Promise<void> =>
			logRawRow(noReceiptId(), JSON.stringify({ ...noReceipt, updatedAtMs }));

		it("seeds the OBSERVED mtime, so an append inside a producer's write window survives a restart", async () => {
			// The scenario a write instant loses, end to end — and the reason it is data
			// loss rather than a delay. A producer samples the mtime, spends its collect
			// phase (a whole-repo git walk), then inserts, so `received_at` lands after any
			// turn the user added in between. Seeding THAT judged the turn already-seen and
			// permanently: the gate suppressed the read that would have corrected the entry,
			// so no tick could overwrite it, and every restart re-seeded the same value.
			await withBaseline();
			collectorHonouringGate(noReceipt);
			// Tick 1 records the sampled version but writes the row two minutes later.
			await dbRescanSessions({
				repos: [repo],
				dbPath,
				emitted: new Map(),
				now: () => noReceipt.updatedAtMs + 120_000,
			});

			// The user appended 30 s after the sample — inside that window — then stopped.
			const grown = { ...noReceipt, updatedAtMs: noReceipt.updatedAtMs + 30_000 };
			const skips = collectorHonouringGate(grown);
			const result = await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map(), seedEmitted: true });

			expect(skips).toEqual([false]);
			expect(result.processed).toBe(1);
		});

		it("treats a row with no usable instant as ungated rather than guessing one", async () => {
			// A row from a build that recorded no mtime, or one whose value is not a number.
			// Absent is the only safe answer: no entry costs one redundant read, while any
			// default — `received_at` above all — reinstates the defect on exactly the rows
			// least likely to be looked at.
			await withBaseline();
			await logRow("not-a-number");
			const skips = collectorHonouringGate(noReceipt);

			await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map(), seedEmitted: true });

			expect(skips).toEqual([false]);
		});

		it("survives an unparseable row belonging to a DIFFERENT session", async () => {
			// Parsed in SQL this was fatal AND permanent. `json_type`/`json_extract` abort the
			// whole statement on the first malformed document — measured: no rows for any
			// group, not a NULL for the offending one — so the seed threw, phase 1 rejected,
			// the tick reported `failed` at DEBUG, and `seeded` never flipped because it is
			// set from a successful result. Every later tick, and every later process, re-ran
			// the same throwing statement: re-scanning was dead machine-wide.
			//
			// Not a corruption-only scenario either, which is what made it worth closing
			// before release: `drainPending` catches `JSON.parse` and parks the row `failed`,
			// and the prune deletes only `projected` rows, so an unparseable row is a state
			// the system deliberately produces and then keeps forever.
			await withBaseline();
			collectorHonouringGate(noReceipt);
			await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() });
			await logRawRow("session:someone-elses-repo:codex:poison", "{ this is not json");

			const skips = collectorHonouringGate(noReceipt);
			const result = await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map(), seedEmitted: true });

			// The bad row cost only itself — this session's entry seeded normally.
			expect(result.idleReason).toBeUndefined();
			expect(skips).toEqual([true]);
		});

		it("treats an unparseable row of its OWN as absent rather than falling back", async () => {
			// The seed reads each session's NEWEST row, so an unreadable one costs that
			// session its entry even though an older row of its own parses fine. Reaching
			// back to that older row would widen the gate on the strength of the weaker
			// record; absence costs one redundant read.
			await withBaseline();
			collectorHonouringGate(noReceipt);
			await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() });
			await logRawRow(noReceiptId(), "{ this is not json");

			const skips = collectorHonouringGate(noReceipt);
			await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map(), seedEmitted: true });

			expect(skips).toEqual([false]);
		});

		it("does not seed over an instant this process already observed", async () => {
			// The merge guard. Both sides hold observed mtimes now, so a seed can no longer be
			// the downgrade this once protected against — but the seed is whatever a session's
			// NEWEST row says, which may be another producer's, so it can disagree in either
			// direction. What this keeps is the observation THIS pass made and verified on the
			// tick; taking the other would trust a claim to have read a version it never saw.
			await withBaseline();
			collectorHonouringGate(noReceipt);
			const emitted = new Map<string, number>();
			await dbRescanSessions({ repos: [repo], dbPath, emitted });
			await logRow(noReceipt.updatedAtMs + 60_000);

			await dbRescanSessions({ repos: [repo], dbPath, emitted, seedEmitted: true });

			// Still this process's own instant, so a file one millisecond past it is read.
			// The seeded value sits a minute above and would swallow it.
			expect([...emitted.values()]).toContain(noReceipt.updatedAtMs);
			expect(lastPredicate()?.("codex", "no-receipt", noReceipt.updatedAtMs + 1)).toBe(false);
		});

		it("reports how many events are parked unprojected", async () => {
			await withBaseline();
			vi.mocked(collectSessionEvents).mockResolvedValue([]);
			await withDashboardDb(
				(db) =>
					db
						.prepare(
							`UPDATE events_raw SET projection_status = 'failed', failed_kind = 'error'
							  WHERE seq = (SELECT MIN(seq) FROM events_raw)`,
						)
						.run(),
				{ dbPath },
			);

			const result = await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() });

			expect(result.failedEvents).toBe(1);
		});

		it("counts a parked event whose reason predates the failed_kind column", async () => {
			// `failed_kind` arrived in a migration, so a row parked by an older build reads
			// NULL — and `NULL = 'unknown-type'` is NULL, not false. Inside the count's
			// `NOT (…)` that NULL propagated and `WHERE` discarded the row, so exactly the
			// rows `drainPending` can never revive (NULL is not a reason it knows) were the
			// ones the count could not see: permanently stuck AND permanently invisible,
			// which is the opposite of what narrowing the count was for.
			//
			// The type is pinned to a KNOWN one deliberately. With an unknown type the third
			// conjunct is false, the `NOT` yields true, and the row is counted even with the
			// bug present — so a case that left the type alone could pass either way.
			await withBaseline();
			vi.mocked(collectSessionEvents).mockResolvedValue([]);
			await withDashboardDb(
				(db) =>
					db
						.prepare(
							`UPDATE events_raw
							    SET projection_status = 'failed', failed_kind = NULL, type = 'session.upserted'
							  WHERE seq = (SELECT MIN(seq) FROM events_raw)`,
						)
						.run(),
				{ dbPath },
			);

			const result = await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() });

			expect(result.failedEvents).toBe(1);
		});

		/**
		 * `events_raw`'s columns, read through a READ-ONLY handle.
		 *
		 * Read-only is the whole point rather than a detail: `withDashboardDb` MIGRATES on
		 * open, so the file-wide `query` helper would re-add a dropped column as a side
		 * effect of asking about it, and the two cases below would pass whatever the pass
		 * under test had done.
		 */
		const eventColumns = (): Promise<string[]> =>
			withReadonlyDashboardDb(
				(db) =>
					(db.prepare("PRAGMA table_info(events_raw)").all() as Array<{ name: string }>).map((c) => c.name),
				{ dbPath },
			);

		it("counts parked events on a schema that has no failed_kind column at all", async () => {
			// Phase 1 holds a READ-ONLY handle, which by contract never migrates, so on a
			// database still behind that migration the narrowed count raises `no such
			// column`. Reachable on an ordinary upgrade — this pass ticks every 30 s and can
			// easily run before the first commit gives the database its first writable open.
			// Left to throw it took the WHOLE pass down as `database-unusable`, and the early
			// return meant the writable phase that would have migrated never ran.
			//
			// Simulated by dropping the column and LEAVING the migration logged as applied,
			// so nothing re-adds it. That isolates the phase this case is about: the whole
			// pass runs against a schema with no `failed_kind`, start to finish.
			//
			// It is deliberately NOT the real pre-migration shape — a genuine old database
			// has no log row either, so its first writable open migrates and heals. That is
			// the sibling case below; this one would not reach it anyway, since
			// `collectSessionEvents` is empty here and phase 3 only opens when a repo
			// produced events. So what this proves is exactly one thing: phase 1 degraded
			// instead of taking the pass down.
			await withBaseline();
			vi.mocked(collectSessionEvents).mockResolvedValue([]);
			await withDashboardDb(
				(db) => {
					db.prepare(
						`UPDATE events_raw SET projection_status = 'failed'
						  WHERE seq = (SELECT MIN(seq) FROM events_raw)`,
					).run();
					db.exec("ALTER TABLE events_raw DROP COLUMN failed_kind");
				},
				{ dbPath },
			);

			const result = await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() });

			// Counted, not guessed: before that migration nothing could be parked as
			// `unknown-type` — there was no column to record a reason in — so every `failed`
			// row IS stuck and the un-narrowed count is the exact answer.
			expect(result.failedEvents).toBe(1);
			// And the pass itself still ran, rather than reporting the database unusable.
			expect(result.idleReason).toBeUndefined();
			expect(result.reposScanned).toBe(1);

			// The column is STILL gone — nothing here re-added it, because the migration is
			// still logged as applied and no writable open happened. Asserted so this case
			// and its sibling are a genuine pair: the sibling's identical read observes the
			// column back, which it could not do if the read itself were what created it.
			expect(await eventColumns()).not.toContain("failed_kind");
		});

		it("heals a genuinely pre-migration database on the same tick", async () => {
			// The consequence the degradation exists to protect, end to end. The failure it
			// replaced was not just a wrong count: phase 1 threw, the pass returned
			// `database-unusable`, and the early return meant the WRITABLE phase — the one
			// that would have migrated the column back — never ran. So the tick that could
			// have fixed the database was precisely the tick the missing column aborted, and
			// the next one repeated it, every 30 seconds, forever.
			//
			// The real pre-migration shape, unlike the case above: the log row goes too, so
			// `migrateDashboardDb` reads the entry as never applied and re-runs it. Its DDL
			// is a single `ALTER TABLE … ADD COLUMN`, which is why re-running is a repair
			// rather than a `duplicate column`.
			await withBaseline();
			// A CHANGED event, so the repo produces something to apply: phase 3's writable
			// open is gated on `pending.length > 0`, and it is that open that migrates.
			vi.mocked(collectSessionEvents).mockResolvedValue([
				{ ...sessionEvent, updatedAtMs: sessionEvent.updatedAtMs + 60_000 },
			]);
			await withDashboardDb(
				(db) => {
					db.prepare(
						`UPDATE events_raw SET projection_status = 'failed'
						  WHERE seq = (SELECT MIN(seq) FROM events_raw)`,
					).run();
					db.exec("ALTER TABLE events_raw DROP COLUMN failed_kind");
					db.prepare("DELETE FROM schema_migrations WHERE name = 'EVENT_FAILED_KIND_DDL'").run();
				},
				{ dbPath },
			);

			const result = await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map() });

			// Phase 1 still answered — read-only, so it saw the old schema and degraded.
			expect(result.failedEvents).toBe(1);
			expect(result.idleReason).toBeUndefined();
			// And phase 3 ran, which is what carried the repair.
			expect(result.eventsApplied).toBe(1);

			expect(await eventColumns()).toContain("failed_kind");
		});
	});
});

describe("DbBackfill — coverage edges", () => {
	function repoId(db: DashboardDbHandle, identity: string = repo.repoIdentity): number {
		return (db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(identity) as { id: number }).id;
	}
	function insertMemory(db: DashboardDbHandle, id: number, hash: string): void {
		db.prepare(
			`INSERT INTO memories (repo_id, commit_hash, root_hash, summary_json, first_seen_ms, written_at_ms, commit_date_ms)
			 VALUES (?, ?, ?, '{}', 0, 0, 0)`,
		).run(id, hash, hash);
	}
	function insertTranscript(db: DashboardDbHandle, id: number, tid: string, stored: StoredTranscript): void {
		const blob = deflateSync(Buffer.from(JSON.stringify(stored)));
		db.prepare(
			"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, ?, ?, 0)",
		).run(id, tid, blob);
	}
	function linkSession(db: DashboardDbHandle, id: number, tid: string, sessionId: string, source: string): void {
		db.prepare(
			"INSERT INTO transcript_sessions (repo_id, transcript_id, session_id, source) VALUES (?, ?, ?, ?)",
		).run(id, tid, sessionId, source);
	}
	function insertSessionRow(db: DashboardDbHandle, id: number, source: string, sessionId: string): string {
		const eventId = sessionEventId(repo.repoIdentity, source, sessionId);
		db.prepare(
			"INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms) VALUES (?, ?, ?, ?, 1)",
		).run(eventId, id, source, sessionId);
		return eventId;
	}

	it("hashes branch tips into the commit cursor when for-each-ref returns real lines", async () => {
		// checkoutFingerprint's filter runs over non-empty ref lines: `line && !isJolliInternalRef(...)`.
		vi.mocked(execGit).mockImplementation(async (args) => {
			if (args[0] === "rev-parse" && args[1] === "--verify")
				return { stdout: `${"ab".repeat(20)}\n`, stderr: "", exitCode: 0 };
			if (args[0] === "for-each-ref")
				return { stdout: "refs/heads/main aaaaaaaaaa\n\n", stderr: "", exitCode: 0 };
			return { stdout: "", stderr: "", exitCode: 0 };
		});
		await dbBackfillRepo({ repo, dbPath });
		const cursor = (
			await query<{ cursor: string }>("SELECT cursor FROM ingest_cursors WHERE source = 'git-commits'")
		)[0].cursor;
		expect(cursor).toMatch(/@head-1\+[0-9a-f]{64}$/);
	});

	it("treats a failed getIndex as no summary index", async () => {
		// summaryIndexFingerprint's `.catch(() => null)`.
		vi.mocked(getIndex).mockRejectedValue(new Error("index unreadable"));
		const result = await dbBackfillRepo({ repo, dbPath });
		expect(result.mode).toBe("bootstrapped");
		expect((await query("SELECT source FROM ingest_cursors WHERE source = 'summaries'")).length).toBe(0);
	});

	it("omits remoteUrl from the enabled event when the repo has none", async () => {
		// repoEnabledEvent's `repo.remoteUrl ? { remoteUrl } : {}` empty arm.
		const result = await dbBackfillRepo({ repo: { ...repo, remoteUrl: undefined }, dbPath });
		expect(result.mode).toBe("bootstrapped");
	});

	it("projects a disabled repo's paused state with a freshly minted timestamp", async () => {
		// projectRepoRegistryState's disabled arm and the null side of
		// `storedDisabledAt(...) ?? new Date(now())` — driven through dbBackfillRepos (the
		// same path the sibling paused-state tests use) rather than a direct sync call. A
		// direct call has to force `readManualDisableFlagSync` true so the real
		// `isRepoDisabled` chain reports disabled; under a full-suite run that mock can lose
		// its return value to worker scheduling, and the real chain then reports ENABLED,
		// silently skipping the arm under test (measured as a flaky `null` paused_at). Going
		// through dbBackfillRepos keeps the arm covered while matching the proven-stable
		// mechanism above.
		const off: RegisteredRepo = { ...repo, repoIdentity: "local:off", repoName: "off" };
		await dbBackfillRepos([off], { dbPath }); // enabled first: creates the row, disabled_at NULL
		vi.mocked(readManualDisableFlagSync).mockReturnValue(true);
		await dbBackfillRepos([off], { dbPath, now: () => 1234 });
		expect(await pausedAt("local:off")).toBe(new Date(1234).toISOString());
	});

	it("does not mark firstRun on a recovered commit re-sweep", async () => {
		// The commits phase-start marker's `isBootstrap ? { firstRun } : {}` empty arm.
		await dbBackfillRepo({ repo, dbPath });
		vi.mocked(getHeadHash).mockResolvedValue("head-2");
		const markers: Array<{ kind: string; done: number; firstRun?: boolean }> = [];
		await dbBackfillRepo({ repo, dbPath, onProgress: (p) => markers.push(p) });
		const start = markers.find((m) => m.kind === "commits" && m.done === 0);
		expect(start).toBeDefined();
		expect(start?.firstRun).toBeUndefined();
	});

	it("reports a fully-skipped source in the session breakdown", async () => {
		// The session tier's onCounts callback and `processedBySource[source] ?? 0`.
		vi.mocked(collectSessionEvents).mockImplementation(async (o) => {
			o.onCounts?.({
				discovered: 1,
				skipped: 1,
				bySource: { cursor: { discovered: 1, skipped: 1 } },
				discoveredKeys: ["cursor:c1"],
				skippedKeys: ["cursor:c1"],
			});
			return [];
		});
		const result = await dbBackfillRepo({ repo, dbPath });
		expect(result.sessions?.bySource.cursor).toEqual({ discovered: 1, skipped: 1, processed: 0 });
	});

	it("forwards importer progress with and without a total", async () => {
		// The importer onProgress wrapper's `p.total !== undefined ? { total } : {}`.
		vi.mocked(importRepoMemory).mockImplementation(async (_db, o) => {
			o.onProgress?.({ done: 1, total: 3 });
			o.onProgress?.({ done: 2 });
			return {
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
			};
		});
		const mem: Array<{ done: number; total?: number }> = [];
		await dbBackfillRepo({
			repo,
			dbPath,
			onProgress: (p) => {
				if (p.kind === "memories") mem.push({ done: p.done, total: p.total });
			},
		});
		expect(mem).toContainEqual({ done: 1, total: 3 });
		expect(mem).toContainEqual({ done: 2, total: undefined });
	});

	it("drops to catch-up when a cutover is recorded but the fence is gone", async () => {
		// The seed-legality `hasCutoverRecord` branch.
		await dbBackfillRepo({ repo, dbPath });
		await withDashboardDb(
			(db) => {
				db.prepare("INSERT INTO repo_state (repo_id, key, value) VALUES (?, 'cutover', '{}')").run(repoId(db));
			},
			{ dbPath },
		);
		const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			await dbBackfillRepo({ repo, dbPath });
		} finally {
			spy.mockRestore();
		}
		expect(importRepoMemory).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({ mode: "catch-up" }),
		);
	});

	function storageListing(entries: string[]): StorageProvider {
		return {
			listFiles: async (prefix: string) => (prefix === "summaries/" ? entries : []),
		} as unknown as StorageProvider;
	}

	it("drops to catch-up when a single stored memory is absent from the orphan tip", async () => {
		// unlisted === 1 arms of the two ternaries, plus the listing filter/map callbacks.
		await dbBackfillRepo({ repo, dbPath });
		await withDashboardDb((db) => insertMemory(db, repoId(db), "hash-0"), { dbPath });
		const storage = storageListing(["summaries/other.json", "summaries/skip.txt"]);
		const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			await dbBackfillRepo({ repo, dbPath, storage });
		} finally {
			spy.mockRestore();
		}
		expect(importRepoMemory).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({ mode: "catch-up" }),
		);
	});

	it("drops to catch-up when several stored memories are absent from the orphan tip", async () => {
		// unlisted > 1 arms of the two ternaries.
		await dbBackfillRepo({ repo, dbPath });
		await withDashboardDb(
			(db) => {
				const id = repoId(db);
				insertMemory(db, id, "hash-0");
				insertMemory(db, id, "hash-1");
			},
			{ dbPath },
		);
		const storage = storageListing(["summaries/other.json"]);
		const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			await dbBackfillRepo({ repo, dbPath, storage });
		} finally {
			spy.mockRestore();
		}
		expect(importRepoMemory).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({ mode: "catch-up" }),
		);
	});

	it("re-projects a session whose tool recorded a later call", async () => {
		// sameToolSet's `lastCallAtMs > row.lastCallAtMs` branch.
		const tools1: ToolCallCount[] = [{ name: "Bash", kind: "builtin", calls: 1, lastCallAtMs: 100 }];
		vi.mocked(collectSessionEvents).mockResolvedValue([{ ...sessionEvent, tools: tools1 }]);
		await dbBackfillRepo({ repo, dbPath });
		const tools2: ToolCallCount[] = [{ name: "Bash", kind: "builtin", calls: 1, lastCallAtMs: 200 }];
		vi.mocked(collectSessionEvents).mockResolvedValue([{ ...sessionEvent, tools: tools2 }]);
		await dbBackfillRepo({ repo, dbPath });
		const row = (await query<{ last_call_at_ms: number }>("SELECT last_call_at_ms FROM session_tool_use"))[0];
		expect(row.last_call_at_ms).toBe(200);
	});

	it("compares a summary's sessions-only links with and without models", async () => {
		// unchangedSummaryEvent's `coverage === 'sessions-only' && (link.models ?? []).length > 0`:
		// the not-return arm (model-less link) and the return arm (link that carries models).
		const base = {
			type: "commit.summary" as const,
			repoIdentity: repo.repoIdentity,
			hash: "aaa",
			committedAtMs: 1_700_000_000_000,
			references: [],
		};
		// Pass 1: seed sa and sb as sessions-only (neither link carries models).
		vi.mocked(getIndex).mockResolvedValue({ version: 3, entries: [] });
		vi.mocked(collectSummaryEvents).mockResolvedValue({
			events: [
				{
					...base,
					sessionLinks: [
						{ source: "claude" as const, sessionId: "sa", confidence: "exact" as const },
						{ source: "claude" as const, sessionId: "sb", confidence: "exact" as const },
					],
				},
			],
			complete: true,
		});
		await dbBackfillRepo({ repo, dbPath });
		// Pass 2: change the index so the tier re-sweeps; sb stays model-less (the
		// not-return arm), sa now carries models (the return arm). Both rows are still
		// stored `sessions-only` at comparison time.
		vi.mocked(getIndex).mockResolvedValue({
			version: 3,
			entries: [
				{
					commitHash: "zzz",
					parentCommitHash: null,
					commitMessage: "m",
					commitDate: "2026-07-30T00:00:00Z",
					branch: "main",
					generatedAt: "2026-07-30T00:01:00Z",
				},
			],
		});
		vi.mocked(collectSummaryEvents).mockResolvedValue({
			events: [
				{
					...base,
					sessionLinks: [
						{ source: "claude" as const, sessionId: "sb", confidence: "exact" as const },
						{
							source: "claude" as const,
							sessionId: "sa",
							confidence: "exact" as const,
							models: [{ model: "claude-opus-4-8", inputTokens: 1, outputTokens: 1, cachedTokens: 0 }],
						},
					],
				},
			],
			complete: true,
		});
		await dbBackfillRepo({ repo, dbPath });
		const ids = (
			await query<{ session_id: string }>(
				"SELECT session_id FROM sessions WHERE session_id IN ('sa', 'sb') ORDER BY session_id",
			)
		).map((r) => r.session_id);
		expect(ids).toEqual(["sa", "sb"]);
	});

	it("warns without advancing the summaries cursor when a summary fails to project", async () => {
		// The cursor-skip warn's `summaries.complete ? 0 : 1` = 0 arm: the read COMPLETED
		// but a summary event parked unprojected (pending > 0). Pass 2 is a recovered pass
		// whose commit tier is cursor-skipped, so `reachableHashes` stays null and the
		// unstored-hash event is judged CHANGED rather than pruned — then it parks because
		// this build cannot project its type.
		await dbBackfillRepo({ repo, dbPath });
		vi.mocked(getIndex).mockResolvedValue({
			version: 3,
			entries: [
				{
					commitHash: "zzz",
					parentCommitHash: null,
					commitMessage: "m",
					commitDate: "2026-07-30T00:00:00Z",
					branch: "main",
					generatedAt: "2026-07-30T00:01:00Z",
				},
			],
		});
		vi.mocked(collectSummaryEvents).mockResolvedValue({
			events: [
				{
					type: "commit.summary",
					repoIdentity: repo.repoIdentity,
					hash: "newhash",
					committedAtMs: 1_700_000_000_000,
					references: [],
					// A session link whose model omits the token fields the seed inserts →
					// the projection throws and the event parks, though the read completed.
					sessionLinks: [
						{
							source: "claude",
							sessionId: "px",
							confidence: "exact",
							models: [
								{ inputTokens: 1, outputTokens: 1, cachedTokens: 0 } as unknown as StatsModelUsage,
							],
						},
					],
				} as unknown as CommitSummaryEvent,
			],
			complete: true,
		});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			await dbBackfillRepo({ repo, dbPath });
		} finally {
			warnSpy.mockRestore();
			errSpy.mockRestore();
		}
		// Pass 1 wrote no summaries cursor (getIndex was null), and this pass did not
		// advance one either, because the sweep left an event pending.
		expect((await query("SELECT cursor FROM ingest_cursors WHERE source = 'summaries'")).length).toBe(0);
	});

	it("re-projects each commit field difference on a re-sweep", async () => {
		// unchangedCommitEvent's per-field return-false checks (committed_at, message,
		// author_name/email, files_changed, insertions, deletions) and the branch loop.
		const full = (hash: string, over: Record<string, unknown> = {}): CommitCreatedEvent =>
			({
				type: "commit.created",
				repoIdentity: repo.repoIdentity,
				hash,
				committedAtMs: 1_700_000_000_000,
				message: "msg",
				authorName: "Alice",
				authorEmail: "a@example.com",
				filesChanged: 1,
				insertions: 2,
				deletions: 3,
				branches: ["main"],
				...over,
			}) as CommitCreatedEvent;
		const hashes = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"];
		vi.mocked(collectCommitEvents).mockResolvedValue(hashes.map((h) => full(h)));
		await dbBackfillRepo({ repo, dbPath });
		// Re-sweep with one field changed per commit (c8 unchanged; c9 a different branch;
		// c10 carries no branch set at all, so the branch comparison is skipped).
		vi.mocked(getHeadHash).mockResolvedValue("head-2");
		vi.mocked(collectCommitEvents).mockResolvedValue([
			full("c1", { committedAtMs: 42 }),
			full("c2", { message: "other" }),
			full("c3", { authorName: "Bob" }),
			full("c4", { authorEmail: "b@example.com" }),
			full("c5", { filesChanged: 9 }),
			full("c6", { insertions: 9 }),
			full("c7", { deletions: 9 }),
			full("c8"),
			full("c9", { branches: ["feature"] }),
			full("c10", { branches: undefined }),
		]);
		await dbBackfillRepo({ repo, dbPath });
		expect((await query("SELECT hash FROM commits")).length).toBe(10);
	});

	it("seeds the emission gate from the log, with and without a limit", async () => {
		// readEmittedFromLog's `limit === undefined ? … : … LIMIT ?` and its args.
		await dbBackfillRepo({ repo, dbPath });
		const withLimit = new Map<string, number>();
		await dbRescanSessions({ repos: [repo], dbPath, emitted: withLimit, seedEmitted: true, emittedLimit: 100 });
		const noLimit = new Map<string, number>();
		await dbRescanSessions({ repos: [repo], dbPath, emitted: noLimit, seedEmitted: true });
		expect(noLimit.size).toBeGreaterThanOrEqual(withLimit.size);
		expect(noLimit.size).toBeGreaterThan(0);
	});

	it("counts discovered sessions and reads no failures from a caller-supplied scan", async () => {
		// dbRescanSessions' onCounts callback, `preScanned ? undefined : …`, `scan?.failures ?? []`.
		await dbBackfillRepo({ repo, dbPath });
		vi.mocked(collectSessionEvents).mockImplementation(async (o) => {
			o.onCounts?.({ discovered: 2, skipped: 0, bySource: {}, discoveredKeys: [], skippedKeys: [] });
			return [{ ...sessionEvent, updatedAtMs: sessionEvent.updatedAtMs + 60_000 }];
		});
		const result = await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map(), preScanned: {} });
		expect(result.discovered).toBe(2);
	});

	it("logs and continues when a per-repo scan throws inside the tick", async () => {
		// dbRescanSessions' per-repo catch.
		await dbBackfillRepo({ repo, dbPath });
		vi.mocked(collectSessionEvents).mockRejectedValue(new Error("scan boom"));
		const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		let result: Awaited<ReturnType<typeof dbRescanSessions>>;
		try {
			result = await dbRescanSessions({ repos: [repo], dbPath, emitted: new Map(), preScanned: {} });
		} finally {
			spy.mockRestore();
		}
		expect(result.processed).toBe(0);
	});

	it("skips already-recorded sessions across repos on a second pass", async () => {
		// readRecordedSessions: floor across two repos (`instant < seen`), the returned
		// predicate, and its invocation by an opted-in scanner.
		const repo2: RegisteredRepo = { ...repo, repoIdentity: "https://github.com/jolliai/other", repoName: "other" };
		vi.mocked(collectSessionEvents).mockImplementation(async (o) => [
			{ ...sessionEvent, repoIdentity: o.repoIdentity },
		]);
		await dbBackfillRepos([repo, repo2], { dbPath });
		let predicateCalled = false;
		vi.mocked(scanClaudeSessionsOnDisk).mockImplementation(async (o) => {
			const alreadyRecorded = (o as { alreadyRecorded?: (s: string, id: string, ms: number) => boolean })
				.alreadyRecorded;
			if (alreadyRecorded) {
				alreadyRecorded("claude", "s1", sessionEvent.updatedAtMs);
				predicateCalled = true;
			}
			return [];
		});
		await dbBackfillRepos([repo, repo2], { dbPath });
		expect(predicateCalled).toBe(true);
	});

	it("uses the machine dashboard path when dbBackfillRepos gets no dbPath", async () => {
		// The `rest.dbPath ? { dbPath } : {}` empty arms and `?? getDashboardDbPath()`.
		const realHome = process.env.HOME;
		process.env.HOME = join(dir, "home-repos");
		try {
			const results = await dbBackfillRepos([repo], {});
			expect(results[0].mode).toBe("bootstrapped");
			expect(existsSync(getDashboardDbPath())).toBe(true);
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
		}
	});

	it("projects paused repos against the machine path when given no dbPath", async () => {
		// The paused-repos `rest.dbPath ? { dbPath } : {}` empty arm.
		vi.mocked(readManualDisableFlagSync).mockReturnValue(true);
		const realHome = process.env.HOME;
		process.env.HOME = join(dir, "home-paused");
		try {
			const results = await dbBackfillRepos([repo], {});
			expect(results[0].mode).toBe("disabled");
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
		}
	});

	it("reports paused repos as skipped when their projection open fails", async () => {
		// The paused-repos catch → mapped to `skipped`.
		vi.mocked(readManualDisableFlagSync).mockReturnValue(true);
		const blocker = join(dir, "blocker-file");
		writeFileSync(blocker, "x");
		const badPath = join(blocker, "nested", "db.db");
		const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const results = await dbBackfillRepos([repo], { dbPath: badPath });
			expect(results[0]).toMatchObject({ mode: "skipped", error: expect.any(String) });
		} finally {
			spy.mockRestore();
		}
	});

	it("uses the machine dashboard path when dbRescanSessions gets no dbPath", async () => {
		// dbRescanSessions' `opts.dbPath ? { dbPath } : {}` and `opts.dbPath ?? getDashboardDbPath()`.
		const realHome = process.env.HOME;
		process.env.HOME = join(dir, "home-rescan");
		try {
			const result = await dbRescanSessions({ repos: [repo], emitted: new Map() });
			expect(result.idleReason).toBe("no-database");
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
		}
	});

	it("backfillStoredActivity: writes buckets, skipping bad, source-less and covered rows", async () => {
		// backfillStoredActivity's `stored.sessions ?? []`, source guard, uncovered guard,
		// and the unreadable-blob catch.
		const written = await withDashboardDb(
			(db) => {
				// A repo row (FK target).
				db.prepare(
					"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES (?, ?, ?, 't')",
				).run(repo.repoIdentity, repo.repoName, repo.worktreeRoot);
				const id = repoId(db);

				insertSessionRow(db, id, "claude", "good-sess");
				insertSessionRow(db, id, "claude", "no-buckets");
				const good = {
					sessions: [
						{
							sessionId: "good-sess",
							source: "claude",
							entries: [{ timestamp: "2026-08-01T00:00:00.000Z" }],
						},
						{ sessionId: "no-source", entries: [{ timestamp: "2026-08-01T00:00:00.000Z" }] },
						{ sessionId: "not-uncovered", source: "claude", entries: [] },
						// Uncovered and has a source, but its entries carry no timestamp → 0 buckets.
						{ sessionId: "no-buckets", source: "claude", entries: [{}] },
					],
				} as unknown as StoredTranscript;
				insertTranscript(db, id, "t-good", good);
				linkSession(db, id, "t-good", "good-sess", "claude");

				// A transcript whose parsed body has no `sessions` key at all.
				insertSessionRow(db, id, "claude", "empty-sess");
				insertTranscript(db, id, "t-empty", {} as unknown as StoredTranscript);
				linkSession(db, id, "t-empty", "empty-sess", "claude");

				// A blob that cannot be inflated → per-row catch.
				insertSessionRow(db, id, "claude", "bad-sess");
				db.prepare(
					"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, ?, ?, 0)",
				).run(id, "t-bad", Buffer.from("not a deflate stream"));
				linkSession(db, id, "t-bad", "bad-sess", "claude");

				const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
				try {
					return backfillStoredActivity(db);
				} finally {
					spy.mockRestore();
				}
			},
			{ dbPath },
		);
		expect(written).toBe(1);
	});

	it("dbBackfillRepos backfills stored activity for uncovered sessions", async () => {
		// dbBackfillRepos' `if (covered > 0)` log branch.
		await dbBackfillRepo({ repo, dbPath });
		await withDashboardDb(
			(db) => {
				const id = repoId(db);
				insertSessionRow(db, id, "claude", "act-sess");
				const good = {
					sessions: [
						{
							sessionId: "act-sess",
							source: "claude",
							entries: [{ timestamp: "2026-08-01T00:00:00.000Z" }],
						},
					],
				} as unknown as StoredTranscript;
				insertTranscript(db, id, "t-act", good);
				linkSession(db, id, "t-act", "act-sess", "claude");
			},
			{ dbPath },
		);
		await dbBackfillRepos([repo], { dbPath });
		const rows = await query(
			`SELECT 1 FROM session_activity a JOIN sessions s ON s.event_id = a.session_event_id
			  WHERE s.session_id = 'act-sess'`,
		);
		expect(rows.length).toBeGreaterThan(0);
	});

	it("pruneUnreachableCommits forgets the day a surviving memory lands on", async () => {
		// The `landed?.at_ms != null` push branch: a pruned commit whose memory survives
		// moves to another calendar day, which must be forgotten too.
		const removed = await withDashboardDb(
			(db) => {
				db.prepare(
					"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES (?, ?, ?, 't')",
				).run(repo.repoIdentity, repo.repoName, repo.worktreeRoot);
				const id = repoId(db);
				db.prepare(
					"INSERT INTO commits (event_id, repo_id, hash, committed_at_ms) VALUES ('e', ?, 'x', 111)",
				).run(id);
				db.prepare(
					`INSERT INTO memories (repo_id, commit_hash, root_hash, summary_json, first_seen_ms, written_at_ms, commit_date_ms)
					 VALUES (?, 'x', 'x', '{}', 0, 0, 222)`,
				).run(id);
				return pruneUnreachableCommits(db, repo.repoIdentity, new Set());
			},
			{ dbPath },
		);
		expect(removed).toBe(1);
	});

	it("projects an enabled repo's registry row (the non-disabled arm)", async () => {
		// projectRepoRegistryState's `: repoEnabledEvent(repo)` arm.
		vi.mocked(readManualDisableFlagSync).mockReturnValue(false);
		await withDashboardDb((db) => projectRepoRegistryState(db, repo), { dbPath });
		expect(await pausedAt(repo.repoIdentity)).toBeNull();
		expect((await query("SELECT repo_name FROM repos WHERE repo_identity = ?", repo.repoIdentity)).length).toBe(1);
	});

	it("falls back to no-skip when the recorded-sessions pre-read fails", async () => {
		// readRecordedSessions' catch: a corrupt database opens but throws on first use.
		writeFileSync(dbPath, "not a database");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const results = await dbBackfillRepos([repo], { dbPath });
			expect(results[0].mode).toBe("skipped");
		} finally {
			warnSpy.mockRestore();
			errSpy.mockRestore();
		}
	});
});

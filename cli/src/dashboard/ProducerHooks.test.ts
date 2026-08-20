import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real temp-file SQLite underneath (via the injectable dbPath); git and the
// runtime gate are the only seams mocked. `getCanonicalRepoUrl` inside
// resolveRepoIdentity sees the mocked execGit fail and falls back to the
// hashed-path identity, which is exactly the local-only repo behaviour.
vi.mock("../core/GitOps.js", () => ({
	execGit: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 1 }),
	getCommitInfo: vi.fn(),
	getCurrentBranch: vi.fn(),
	getProjectRootDir: vi.fn(),
}));

vi.mock("./DashboardDb.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./DashboardDb.js")>();
	return { ...actual, canUseDashboardDb: vi.fn().mockReturnValue(true) };
});

// Partial: only the opt-out flag is a seam (the memories refresh honours it),
// everything else — createLogger above all — must stay real.
vi.mock("../Logger.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../Logger.js")>();
	return { ...actual, isManuallyDisabled: vi.fn().mockReturnValue(false) };
});

// The transcript read inside sessionEventFromInfo — pinned so a "claude"
// session gets deterministic usage without a real JSONL file.
// The QueueWorker path enriches drained commits with their stored summary;
// mocked so no orphan-branch read happens. Enabled per test.
vi.mock("../core/SummaryStore.js", () => ({
	getSummary: vi.fn().mockResolvedValue(null),
	readTranscriptsForCommits: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("../core/TranscriptReader.js", () => ({
	readTranscript: vi.fn().mockResolvedValue({
		entries: [
			{ role: "human", content: "q", timestamp: "2026-07-30T08:00:00Z" },
			{ role: "assistant", content: "a", timestamp: "2026-07-30T08:05:00Z" },
		],
		newCursor: { transcriptPath: "/t", lineNumber: 2, updatedAt: "2026-07-30T08:05:00Z" },
		totalLinesRead: 2,
		usageByModel: [{ model: "claude-opus-5", provider: "anthropic", input: 100, output: 50, cached: 0 }],
	}),
}));

// The memories live-refresh reads the just-stored files through the active
// storage; a mutable in-memory map plays that role (empty = no memory stored).
const storageFiles = new Map<string, string>();
vi.mock("../core/StorageFactory.js", () => ({
	createStorage: async () => ({
		readFile: async (path: string) => storageFiles.get(path) ?? null,
	}),
}));

import { execGit, getCommitInfo, getCurrentBranch, getProjectRootDir } from "../core/GitOps.js";
import { getSummary } from "../core/SummaryStore.js";
import { isManuallyDisabled } from "../Logger.js";
import type { CommitInfo, SessionInfo } from "../Types.js";
import { canUseDashboardDb, withDashboardDb } from "./DashboardDb.js";
import {
	recordCommitsFromWorker,
	recordMemoryEdit,
	recordRecallReceipt,
	recordSessionFromHook,
	recordSessionsFromTick,
	resetProducerCaches,
} from "./ProducerHooks.js";
import { readRepoRegistry, resolveRepoIdentity } from "./RepoRegistry.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-prodhooks-"));
	dbPath = join(dir, "dashboard.db");
	resetProducerCaches();
	vi.mocked(canUseDashboardDb).mockReturnValue(true);
	vi.mocked(getProjectRootDir).mockResolvedValue("/repo");
	vi.mocked(execGit).mockResolvedValue({ stdout: "", stderr: "", exitCode: 1 });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const sessionInfo = (over: Partial<SessionInfo> = {}): SessionInfo => ({
	sessionId: "s1",
	transcriptPath: "/transcripts/s1.jsonl",
	updatedAt: "2026-07-30T08:05:00Z",
	source: "claude",
	...over,
});

function readRows(sql: string): Promise<Array<Record<string, unknown>>> {
	return withDashboardDb((db) => db.prepare(sql).all() as Array<Record<string, unknown>>, { dbPath });
}

describe("recordSessionFromHook", () => {
	it("projects the session with transcript usage into the DB", async () => {
		const ok = await recordSessionFromHook("/repo", sessionInfo(), dbPath);
		expect(ok).toBe(true);

		const rows = await readRows("SELECT source, session_id, input_tokens, output_tokens FROM sessions");
		expect(rows).toEqual([{ source: "claude", session_id: "s1", input_tokens: 100, output_tokens: 50 }]);
		// The identity fell back to the hashed worktree path (no remote).
		const repos = await readRows("SELECT repo_identity FROM repos");
		expect(String(repos[0].repo_identity)).toMatch(/^local:[0-9a-f]{32}$/);
	});

	it("persists a metadata-only row when a live hook has no transcript path", async () => {
		const ok = await recordSessionFromHook(
			"/repo",
			{
				sessionId: "pathless",
				updatedAt: "2026-07-30T08:05:00Z",
				source: "cursor",
			},
			dbPath,
		);
		expect(ok).toBe(true);

		const rows = await readRows("SELECT source, session_id, message_count FROM sessions");
		expect(rows).toEqual([{ source: "cursor", session_id: "pathless", message_count: null }]);
	});

	it("skips silently when the runtime lacks flag-free node:sqlite", async () => {
		vi.mocked(canUseDashboardDb).mockReturnValue(false);
		const ok = await recordSessionFromHook("/repo", sessionInfo(), dbPath);
		expect(ok).toBe(false);
		expect(getProjectRootDir).not.toHaveBeenCalled();
	});

	it("never throws when identity resolution fails", async () => {
		vi.mocked(getProjectRootDir).mockRejectedValue(new Error("not a git repo"));
		await expect(recordSessionFromHook("/nowhere", sessionInfo(), dbPath)).resolves.toBe(false);
	});

	it("drops a session whose updatedAt is unparseable", async () => {
		const ok = await recordSessionFromHook("/repo", sessionInfo({ updatedAt: "not-a-date" }), dbPath);
		expect(ok).toBe(false);
	});
});

describe("recordRecallReceipt", () => {
	const hit = {
		hit: true,
		commitCount: 2,
		commits: [{ hash: "a".repeat(40), date: "2026-07-25" }],
		atMs: 1_700_000_000_000,
	};

	// The suite itself may be running inside an agent that exports this — the
	// default must be "no session", not whatever the developer's shell carries.
	beforeEach(() => {
		delete process.env.CLAUDE_CODE_SESSION_ID;
	});
	afterEach(() => {
		delete process.env.CLAUDE_CODE_SESSION_ID;
	});

	it("writes one receipt row carrying the surface and the served commits", async () => {
		expect(await recordRecallReceipt("/repo", hit, "mcp", dbPath)).toBe(true);
		expect(
			await readRows("SELECT surface, session_id, hit, commit_count, commits_json FROM recall_receipts"),
		).toEqual([
			{
				surface: "mcp",
				session_id: null,
				hit: 1,
				commit_count: 2,
				commits_json: JSON.stringify([{ hash: "a".repeat(40), date: "2026-07-25" }]),
			},
		]);
	});

	it("attributes the call to the agent session the host advertised", async () => {
		process.env.CLAUDE_CODE_SESSION_ID = "sess-uuid";
		await recordRecallReceipt("/repo", hit, "mcp", dbPath);
		expect(await readRows("SELECT session_id FROM recall_receipts")).toEqual([{ session_id: "sess-uuid" }]);
	});

	it("leaves the session unattributed rather than guessing when the env is blank", async () => {
		process.env.CLAUDE_CODE_SESSION_ID = "   ";
		await recordRecallReceipt("/repo", hit, "cli", dbPath);
		expect(await readRows("SELECT surface, session_id FROM recall_receipts")).toEqual([
			{ surface: "cli", session_id: null },
		]);
	});

	it("stamps a call that carries no atMs of its own", async () => {
		await recordRecallReceipt("/repo", { hit: false, commitCount: 0, commits: [] }, "cli", dbPath);
		const rows = await readRows("SELECT at_ms FROM recall_receipts");
		expect(Number(rows[0].at_ms)).toBeGreaterThan(0);
	});

	it("skips silently when the runtime lacks flag-free node:sqlite", async () => {
		vi.mocked(canUseDashboardDb).mockReturnValue(false);
		expect(await recordRecallReceipt("/repo", hit, "mcp", dbPath)).toBe(false);
		expect(existsSync(dbPath)).toBe(false);
	});

	it("never throws when identity resolution fails — a receipt is worth less than the answer", async () => {
		vi.mocked(getProjectRootDir).mockRejectedValue(new Error("not a git repo"));
		await expect(recordRecallReceipt("/nowhere", hit, "cli", dbPath)).resolves.toBe(false);
	});
});

describe("recordCommitsFromWorker", () => {
	beforeEach(() => {
		vi.mocked(getCurrentBranch).mockResolvedValue("feature/x");
		vi.mocked(getCommitInfo).mockResolvedValue({
			hash: "abc123",
			message: "feat: add thing\n\nbody",
			author: "Dev",
			date: "2026-07-30T09:00:00Z",
		} as CommitInfo);
		// observeWorktree's `git diff --shortstat HEAD`
		vi.mocked(execGit).mockImplementation((args: ReadonlyArray<string>) =>
			Promise.resolve(
				args[0] === "diff"
					? { stdout: " 2 files changed, 7 insertions(+), 1 deletion(-)", stderr: "", exitCode: 0 }
					: { stdout: "", stderr: "", exitCode: 1 },
			),
		);
	});

	it("writes commit rows, branch reachability and worktree status", async () => {
		const ok = await recordCommitsFromWorker("/repo", new Set(["abc123"]), dbPath);
		expect(ok).toBe(true);

		const commits = await readRows("SELECT hash, branch, message FROM commits");
		expect(commits).toEqual([{ hash: "abc123", branch: "feature/x", message: "feat: add thing" }]);
		const branches = await readRows(
			"SELECT b.name AS branch FROM commit_branches cb JOIN branches b ON b.id = cb.branch_id",
		);
		expect(branches).toEqual([{ branch: "feature/x" }]);
		const worktree = await readRows("SELECT files_changed, insertions, deletions FROM worktree_status");
		expect(worktree).toEqual([{ files_changed: 2, insertions: 7, deletions: 1 }]);
	});

	it("skips hashes git cannot read but keeps the rest of the batch", async () => {
		vi.mocked(getCommitInfo)
			.mockRejectedValueOnce(new Error("bad object"))
			.mockResolvedValueOnce({
				hash: "def456",
				message: "fix",
				author: "Dev",
				date: "2026-07-30T10:00:00Z",
			} as CommitInfo);

		const ok = await recordCommitsFromWorker("/repo", ["gone", "def456"], dbPath);
		expect(ok).toBe(true);
		const commits = await readRows("SELECT hash FROM commits");
		expect(commits).toEqual([{ hash: "def456" }]);
	});

	it("omits branch fields on a detached HEAD", async () => {
		vi.mocked(getCurrentBranch).mockResolvedValue("HEAD");
		await recordCommitsFromWorker("/repo", ["abc123"], dbPath);
		const commits = await readRows("SELECT branch FROM commits");
		expect(commits).toEqual([{ branch: null }]);
		expect(await readRows("SELECT * FROM commit_branches")).toEqual([]);
	});

	it("enriches the commit with its stored summary when one exists (memory tier)", async () => {
		vi.mocked(getSummary).mockResolvedValue({
			version: 5,
			commitHash: "abc123",
			commitMessage: "feat: add thing",
			commitAuthor: "Dev",
			commitDate: "2026-07-30T09:00:00Z",
			branch: "feature/x",
			generatedAt: "2026-07-30T09:01:00Z",
			ticketId: "JOLLI-2069",
			conversationTurns: 5,
			conversationTokens: 9000,
			estimatedCostUsd: 0.8,
			topics: [{ title: "T", trigger: "t", response: "r", decisions: "went with X" }],
			transcripts: [],
			// biome-ignore lint/suspicious/noExplicitAny: minimal CommitSummary fixture
		} as any);

		await recordCommitsFromWorker("/repo", ["abc123"], dbPath);

		const commits = await readRows("SELECT hash FROM commits");
		expect(commits).toEqual([{ hash: "abc123" }]);
		// The enrichment lands on the memory tables now (A3b) — via the live
		// refresh when the storage carries the summary file. This test's storage
		// map is empty, so the point pinned here is just that the projection no
		// longer writes copies anywhere else.
		const memories = await readRows("SELECT COUNT(*) AS n FROM memories");
		expect(memories).toEqual([{ n: 0 }]);
	});

	it("survives a summary read failure — the plain commit row still lands", async () => {
		vi.mocked(getSummary).mockRejectedValue(new Error("orphan read failed"));
		const ok = await recordCommitsFromWorker("/repo", ["abc123"], dbPath);
		expect(ok).toBe(true);
		expect((await readRows("SELECT hash FROM commits")).length).toBe(1);
	});
});

describe("recordSessionsFromTick", () => {
	it("writes only sessions newer than the last tick write", async () => {
		vi.mocked(getCurrentBranch).mockResolvedValue("main");
		const first = await recordSessionsFromTick("/repo", [sessionInfo()], dbPath);
		expect(first).toBe(true);

		// Same payload again — nothing moved, so nothing is written.
		const second = await recordSessionsFromTick("/repo", [sessionInfo()], dbPath);
		expect(second).toBe(false);

		// A newer update goes through.
		const third = await recordSessionsFromTick(
			"/repo",
			[sessionInfo({ updatedAt: "2026-07-30T09:00:00Z" })],
			dbPath,
		);
		expect(third).toBe(true);
	});

	it("refreshes worktree status alongside the session write", async () => {
		vi.mocked(getCurrentBranch).mockResolvedValue("main");
		vi.mocked(execGit).mockImplementation((args: ReadonlyArray<string>) =>
			Promise.resolve(
				args[0] === "diff"
					? { stdout: " 1 file changed, 3 insertions(+)", stderr: "", exitCode: 0 }
					: { stdout: "", stderr: "", exitCode: 1 },
			),
		);
		await recordSessionsFromTick("/repo", [sessionInfo()], dbPath);
		const worktree = await readRows("SELECT branch, files_changed, insertions FROM worktree_status");
		expect(worktree).toEqual([{ branch: "main", files_changed: 1, insertions: 3 }]);
	});

	it("returns false for an empty tick", async () => {
		expect(await recordSessionsFromTick("/repo", [], dbPath)).toBe(false);
	});

	it("does not advance the watermark when the write fails", async () => {
		vi.mocked(getCurrentBranch).mockResolvedValue("main");
		// The worktree observation is part of the same batch, so blowing it up is a
		// write that never lands — exactly what a busy DB looks like from here.
		vi.mocked(execGit).mockImplementation((args: ReadonlyArray<string>) =>
			args[0] === "diff"
				? Promise.reject(new Error("git exploded"))
				: Promise.resolve({ stdout: "", stderr: "", exitCode: 1 }),
		);
		expect(await recordSessionsFromTick("/repo", [sessionInfo()], dbPath)).toBe(false);
		expect(await readRows("SELECT session_id FROM sessions")).toEqual([]);

		// The very same session must still be eligible on the next tick — advancing
		// the watermark on a dropped batch skipped it until it changed again.
		vi.mocked(execGit).mockResolvedValue({ stdout: "", stderr: "", exitCode: 1 });
		expect(await recordSessionsFromTick("/repo", [sessionInfo()], dbPath)).toBe(true);
		expect(await readRows("SELECT session_id FROM sessions")).toEqual([{ session_id: "s1" }]);
	});
});

describe("repo self-registration", () => {
	// The registry is exercised for real here — `configDirFor(dbPath)` scopes it
	// to this test's temp dir. Mocking it would have hidden the bug this suite
	// caught: before the scoping existed, these very tests wrote a `/repo` entry
	// into the developer's real ~/.jolli registry.
	it("registers a repo the registry has never seen (closes the already-enabled gap)", async () => {
		await recordSessionFromHook("/repo", sessionInfo(), dbPath);

		const registry = await readRepoRegistry(dir);
		expect(registry.repos).toHaveLength(1);
		expect(registry.repos[0]).toMatchObject({ worktreeRoot: "/repo" });
		// Registered active: JSON omits the key entirely rather than storing null.
		expect(registry.repos[0]).not.toHaveProperty("disabledAt");
	});

	it("retries registration on a later call when the first attempt failed", async () => {
		// The identity memo used to be written BEFORE registration was attempted, so
		// one transient failure (locked file, a bad IO moment) short-circuited every
		// later call in the process — permanently, in a long-lived host like the VS
		// Code extension. Resolving the identity is the cheap half; the registry write
		// is the part worth another attempt.
		const registryPath = join(dir, "dashboard-repos.json");
		// A directory where the file belongs: the write fails, the read yields nothing.
		mkdirSync(registryPath, { recursive: true });
		await recordSessionFromHook("/repo", sessionInfo(), dbPath);
		rmSync(registryPath, { recursive: true, force: true });

		await recordSessionFromHook("/repo", sessionInfo(), dbPath);

		expect((await readRepoRegistry(dir)).repos).toHaveLength(1);
	});

	it("writes the registry beside the DB, never to the machine-level config dir", async () => {
		await recordSessionFromHook("/repo", sessionInfo(), dbPath);
		expect(existsSync(join(dir, "dashboard-repos.json"))).toBe(true);
	});

	it("does not re-register a repo already in the registry", async () => {
		const { identity } = await resolveRepoIdentity("/repo");
		await writeFile(
			join(dir, "dashboard-repos.json"),
			JSON.stringify({
				version: 1,
				repos: [{ repoIdentity: identity, repoName: "pinned", worktreeRoot: "/repo", enabledAt: "t" }],
			}),
		);

		await recordSessionFromHook("/repo", sessionInfo(), dbPath);

		// Untouched: still the pinned name, still one row.
		const registry = await readRepoRegistry(dir);
		expect(registry.repos).toEqual([
			{ repoIdentity: identity, repoName: "pinned", worktreeRoot: "/repo", enabledAt: "t" },
		]);
	});

	it("rewrites nothing for a known identity whose checkout is already listed", async () => {
		// A known identity ends the check: no `registerRepo`, so the row is left
		// exactly as written. It used to matter because rebuilding the row cleared the
		// registry's own disable stamp; that stamp is gone (the switch lives in each
		// repo's `profile.json` now), but a stray hook still has no business
		// restating a name, reordering `worktreeRoot`, or refreshing `enabledAt`.
		const { identity } = await resolveRepoIdentity("/repo");
		const row = { repoIdentity: identity, repoName: "hand-named", worktreeRoot: "/repo", enabledAt: "t" };
		await writeFile(join(dir, "dashboard-repos.json"), JSON.stringify({ version: 1, repos: [row] }));

		await recordSessionFromHook("/repo", sessionInfo(), dbPath);

		expect((await readRepoRegistry(dir)).repos).toEqual([row]);
	});

	it("lists a second clone of a known identity — union-only, the rest of the row untouched", async () => {
		// Clones share one identity, so "known" used to end the check here and clone
		// B's worktree never entered the list — making B structurally invisible to the
		// cutover's source enumeration (never imported, never fenced, its history
		// stranded). Adding it must stay a pure union.
		const { identity } = await resolveRepoIdentity("/repo");
		await writeFile(
			join(dir, "dashboard-repos.json"),
			JSON.stringify({
				version: 1,
				repos: [
					{
						repoIdentity: identity,
						repoName: "repo",
						worktreeRoot: "/clone-a",
						worktrees: ["/clone-a"],
						enabledAt: "t",
					},
				],
			}),
		);

		await recordSessionFromHook("/repo", sessionInfo(), dbPath);

		const [entry] = (await readRepoRegistry(dir)).repos;
		expect(entry.worktrees).toEqual(["/clone-a", "/repo"]);
		expect(entry.worktreeRoot).toBe("/clone-a");
		expect(entry.enabledAt).toBe("t");
	});

	it("still writes the stats when the registry file is corrupt", async () => {
		await writeFile(join(dir, "dashboard-repos.json"), "{not json");

		const ok = await recordSessionFromHook("/repo", sessionInfo(), dbPath);

		expect(ok).toBe(true);
		expect(await readRows("SELECT session_id FROM sessions")).toEqual([{ session_id: "s1" }]);
	});
});

describe("memories live-refresh on commit.summary", () => {
	it("upserts the stored summary and its transcripts into the memory tables", async () => {
		vi.mocked(getCommitInfo).mockResolvedValue({
			hash: "a".repeat(40),
			author: "a",
			date: "2026-07-30T08:00:00Z",
			message: "m",
		} as CommitInfo);
		vi.mocked(getCurrentBranch).mockResolvedValue("main");
		const summary = {
			version: "5",
			commitHash: "a".repeat(40),
			commitMessage: "m",
			commitDate: "2026-07-30T08:00:00Z",
			branch: "main",
			commitType: "commit",
			topics: [{ title: "T", category: "feature" }],
			children: [],
			transcripts: ["t-1"],
		};
		storageFiles.set(`summaries/${"a".repeat(40)}.json`, JSON.stringify(summary, null, "\t"));
		storageFiles.set("transcripts/t-1.json", JSON.stringify({ sessions: [{ sessionId: "s1" }] }, null, "\t"));
		try {
			await recordCommitsFromWorker("/repo", ["a".repeat(40)], dbPath);
			const rows = await withDashboardDb(
				(db) => ({
					memories: db.prepare("SELECT commit_hash, branch FROM memories").all(),
					topics: db.prepare("SELECT title, category FROM memory_topics").all(),
					links: db.prepare("SELECT transcript_id FROM memory_transcripts").all(),
				}),
				{ dbPath },
			);
			expect(rows.memories).toEqual([{ commit_hash: "a".repeat(40), branch: "main" }]);
			expect(rows.topics).toEqual([{ title: "T", category: "feature" }]);
			expect(rows.links).toEqual([{ transcript_id: "t-1" }]);
		} finally {
			storageFiles.clear();
		}
	});

	it("drops a missing transcript file; the enrichment path alone still lands the row", async () => {
		// getCommitInfo fails (no commit.created), but the summary enrichment
		// still produces commit.summary — which ensures the repos row — and the
		// refresh lands the memory with its dangling transcript link dropped.
		vi.mocked(getCommitInfo).mockRejectedValue(new Error("gone"));
		const summary = {
			version: "5",
			commitHash: "c".repeat(40),
			commitMessage: "m",
			commitDate: "2026-07-30T08:00:00Z",
			branch: "main",
			commitType: "commit",
			topics: [],
			children: [],
			transcripts: ["t-missing"],
		};
		vi.mocked(getSummary).mockResolvedValue(summary as never);
		storageFiles.set(`summaries/${"c".repeat(40)}.json`, JSON.stringify(summary, null, "\t"));
		try {
			await recordCommitsFromWorker("/repo", ["c".repeat(40)], dbPath);
			const rows = await withDashboardDb(
				(db) => ({
					memories: (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n,
					links: (db.prepare("SELECT COUNT(*) AS n FROM memory_transcripts").get() as { n: number }).n,
				}),
				{ dbPath },
			);
			expect(rows.memories).toBe(1);
			expect(rows.links).toBe(0);
		} finally {
			storageFiles.clear();
			vi.mocked(getSummary).mockResolvedValue(null);
		}
	});

	it("writes no memory rows on a manually-disabled repo", async () => {
		// `refreshMemoryRows` calls applyMemoryWrites directly, so the gate
		// inside SqliteStorage.writeFiles never runs on this path — and
		// recordMemoryEdit's callers invoke it unconditionally after a
		// storeSummary that itself no-ops when disabled. The content would be
		// unchanged, but a repo the user turned off must not get its database
		// created and its rows rewritten behind their back.
		vi.mocked(isManuallyDisabled).mockReturnValue(true);
		const summary = {
			version: "5",
			commitHash: "e".repeat(40),
			commitMessage: "m",
			commitDate: "2026-07-30T08:00:00Z",
			branch: "main",
			commitType: "commit",
			topics: [],
			children: [],
		};
		vi.mocked(getSummary).mockResolvedValue(summary as never);
		storageFiles.set(`summaries/${"e".repeat(40)}.json`, JSON.stringify(summary, null, "\t"));
		try {
			await recordMemoryEdit("/repo", ["e".repeat(40)], dbPath);
			expect(existsSync(dbPath)).toBe(false);
		} finally {
			storageFiles.clear();
			vi.mocked(getSummary).mockResolvedValue(null);
			vi.mocked(isManuallyDisabled).mockReturnValue(false);
		}
	});

	it("a commit without a stored memory refreshes nothing and stays non-fatal", async () => {
		vi.mocked(getCommitInfo).mockResolvedValue({
			hash: "b".repeat(40),
			author: "a",
			date: "2026-07-30T08:00:00Z",
			message: "m",
		} as CommitInfo);
		vi.mocked(getCurrentBranch).mockResolvedValue("main");
		await recordCommitsFromWorker("/repo", ["b".repeat(40)], dbPath);
		const n = await withDashboardDb(
			(db) => (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n,
			{ dbPath },
		);
		expect(n).toBe(0);
	});
});

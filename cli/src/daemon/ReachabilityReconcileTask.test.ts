import { beforeEach, describe, expect, it, vi } from "vitest";

const logLines: Array<{ level: string; text: string }> = [];
vi.mock("../Logger.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		createLogger: () => ({
			info: (...a: unknown[]) => logLines.push({ level: "info", text: a.join(" ") }),
			warn: (...a: unknown[]) => logLines.push({ level: "warn", text: a.join(" ") }),
			debug: () => undefined,
			error: () => undefined,
		}),
	};
});
vi.mock("../dashboard/RepoRegistry.js", () => ({
	listActiveRepos: vi.fn(),
	existingWorktrees: vi.fn(),
}));
vi.mock("../core/GitOps.js", () => ({ listReachableCommits: vi.fn(), listBranchTips: vi.fn() }));
vi.mock("../dashboard/DashboardDb.js", () => ({ withDashboardDb: vi.fn() }));
vi.mock("../dashboard/DbBackfill.js", () => ({
	markMemoriesReachability: vi.fn(),
	markCommitsReachability: vi.fn(),
}));

import { listBranchTips, listReachableCommits } from "../core/GitOps.js";
import { withDashboardDb } from "../dashboard/DashboardDb.js";
import { markCommitsReachability, markMemoriesReachability } from "../dashboard/DbBackfill.js";
import { existingWorktrees, listActiveRepos, type RegisteredRepo } from "../dashboard/RepoRegistry.js";
import {
	REACHABILITY_RECONCILE_TASK_NAME,
	REACHABILITY_RECONCILE_TICK_MS,
	reachabilityReconcileTask,
} from "./ReachabilityReconcileTask.js";

const repo: RegisteredRepo = {
	repoIdentity: "https://github.com/jolliai/jolliai",
	repoName: "jolliai",
	worktreeRoot: "/w/jolliai",
	enabledAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
	logLines.length = 0;
	vi.mocked(listActiveRepos).mockResolvedValue([repo]);
	vi.mocked(existingWorktrees).mockReturnValue([repo.worktreeRoot]);
	vi.mocked(listReachableCommits).mockResolvedValue(["h1", "h2"]);
	vi.mocked(listBranchTips).mockResolvedValue(["tip1"]);
	// Default: run the callback with a stub db and let the marks answer.
	vi.mocked(withDashboardDb).mockImplementation(async (fn) => fn({} as never));
	vi.mocked(markMemoriesReachability).mockReturnValue(3);
	vi.mocked(markCommitsReachability).mockReturnValue(2);
});

describe("reachabilityReconcileTask", () => {
	it("exposes the shared name and tick interval", () => {
		const task = reachabilityReconcileTask();
		expect(task.name).toBe(REACHABILITY_RECONCILE_TASK_NAME);
		expect(task.tickIntervalMs).toBe(REACHABILITY_RECONCILE_TICK_MS);
	});

	it("reconciles each active repo against the union of its worktrees' reachable sets", async () => {
		vi.mocked(existingWorktrees).mockReturnValue(["/w/a", "/w/b"]);
		vi.mocked(listReachableCommits).mockResolvedValueOnce(["h1"]).mockResolvedValueOnce(["h2", "h3"]);
		const result = await reachabilityReconcileTask().run();
		// 3 memory flips + 2 commit flips, both tiers from the one git set.
		expect(result).toBe("reconciled 1 repo(s), 5 flip(s)");
		// The union of both worktrees is what BOTH marks see, never one alone.
		const union = new Set(["h1", "h2", "h3"]);
		expect(markMemoriesReachability).toHaveBeenCalledWith(expect.anything(), repo.repoIdentity, union);
		expect(markCommitsReachability).toHaveBeenCalledWith(expect.anything(), repo.repoIdentity, union);
	});

	it("skips the expensive rev-list + apply on a second tick when the branch tips are unchanged", async () => {
		const task = reachabilityReconcileTask();
		expect(await task.run()).toBe("reconciled 1 repo(s), 5 flip(s)");
		// Same tips → nothing could have changed; the second tick never touches git's
		// history walk or the DB.
		vi.mocked(listReachableCommits).mockClear();
		vi.mocked(withDashboardDb).mockClear();
		expect(await task.run()).toBe("up to date (1 repo(s) unchanged)");
		expect(listReachableCommits).not.toHaveBeenCalled();
		expect(withDashboardDb).not.toHaveBeenCalled();
	});

	it("reconciles only the changed repo on a later tick, reporting the unchanged ones", async () => {
		const repoB: RegisteredRepo = {
			...repo,
			repoIdentity: "https://github.com/jolliai/other",
			worktreeRoot: "/w/other",
		};
		vi.mocked(listActiveRepos).mockResolvedValue([repo, repoB]);
		vi.mocked(existingWorktrees).mockImplementation((r) => [r.worktreeRoot]);
		vi.mocked(listBranchTips).mockImplementation(async (cwd) => (cwd === repoB.worktreeRoot ? ["b1"] : ["tip1"]));
		const task = reachabilityReconcileTask();
		expect(await task.run()).toBe("reconciled 2 repo(s), 10 flip(s)");
		// Only repoB's tip moves; repo stays cached and is skipped.
		vi.mocked(listBranchTips).mockImplementation(async (cwd) => (cwd === repoB.worktreeRoot ? ["b2"] : ["tip1"]));
		expect(await task.run()).toBe("reconciled 1 repo(s), 5 flip(s), 1 unchanged");
	});

	it("re-runs when a branch tip moves between ticks", async () => {
		const task = reachabilityReconcileTask();
		expect(await task.run()).toBe("reconciled 1 repo(s), 5 flip(s)");
		vi.mocked(listBranchTips).mockResolvedValue(["tip2"]);
		expect(await task.run()).toBe("reconciled 1 repo(s), 5 flip(s)");
		expect(listReachableCommits).toHaveBeenCalledTimes(2);
	});

	it("does not cache an unreadable repo, so it retries on the next tick", async () => {
		// Git answers for nothing: both the cheap tip read and the rev-list fail.
		vi.mocked(listBranchTips).mockResolvedValue(null);
		vi.mocked(listReachableCommits).mockResolvedValue(null);
		const task = reachabilityReconcileTask();
		expect(await task.run()).toBe("no repos readable");
		// Tips unchanged, but the repo was never cached (git could not answer), so the
		// gate must NOT short-circuit it — the rev-list is attempted again.
		vi.mocked(listReachableCommits).mockClear();
		expect(await task.run()).toBe("no repos readable");
		expect(listReachableCommits).toHaveBeenCalled();
	});

	it("evicts a repo that leaves the registry, so re-registering it re-runs rather than skipping", async () => {
		const repoB: RegisteredRepo = {
			...repo,
			repoIdentity: "https://github.com/jolliai/other",
			worktreeRoot: "/w/other",
		};
		vi.mocked(existingWorktrees).mockImplementation((r) => [r.worktreeRoot]);
		const task = reachabilityReconcileTask();
		// Tick 1: both repos cached.
		vi.mocked(listActiveRepos).mockResolvedValue([repo, repoB]);
		expect(await task.run()).toBe("reconciled 2 repo(s), 10 flip(s)");
		// Tick 2: repoB leaves the registry (repo stays, so the list is non-empty and the
		// eviction loop runs). repo is unchanged and skipped.
		vi.mocked(listActiveRepos).mockResolvedValue([repo]);
		expect(await task.run()).toBe("up to date (1 repo(s) unchanged)");
		// Tick 3: repoB back with unchanged tips; because it was evicted it re-runs the
		// full rev-list + apply rather than matching its stale signature.
		vi.mocked(listActiveRepos).mockResolvedValue([repo, repoB]);
		vi.mocked(listReachableCommits).mockClear();
		expect(await task.run()).toBe("reconciled 1 repo(s), 5 flip(s), 1 unchanged");
		expect(listReachableCommits).toHaveBeenCalled();
	});

	it("returns early when no repos are active", async () => {
		vi.mocked(listActiveRepos).mockResolvedValue([]);
		expect(await reachabilityReconcileTask().run()).toBe("no active repos");
		expect(withDashboardDb).not.toHaveBeenCalled();
	});

	it("skips a repo whose git is unreadable rather than marking everything unreachable", async () => {
		// A null from every worktree must NOT open the DB and mark all memories 0 —
		// the empty-set hide-everything failure the read-path fail-open guarded.
		vi.mocked(listReachableCommits).mockResolvedValue(null);
		expect(await reachabilityReconcileTask().run()).toBe("no repos readable");
		expect(withDashboardDb).not.toHaveBeenCalled();
		expect(markMemoriesReachability).not.toHaveBeenCalled();
	});

	it("reports a failure instead of throwing, so the scheduler keeps ticking", async () => {
		vi.mocked(listActiveRepos).mockRejectedValue(new Error("registry unreadable"));
		const result = await reachabilityReconcileTask().run();
		expect(result).toBe("failed: registry unreadable");
		expect(logLines.some((l) => l.level === "warn" && l.text.includes("registry unreadable"))).toBe(true);
	});
});

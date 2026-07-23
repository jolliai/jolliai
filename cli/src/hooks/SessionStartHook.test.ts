import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary, PlansRegistry, SummaryIndex } from "../Types.js";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn().mockReturnValue(false),
	readFileSync: vi.fn().mockReturnValue("{}"),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
	rmSync: vi.fn(),
}));

// Partial mock — keep the real `normalizePlansRegistry` (used by the briefing
// path) but control `loadConfig` so the login-reminder credential check is
// deterministic and never reads the dev machine's real config. `saveConfig` is
// stubbed so the plugin default-provider seed never touches real disk.
vi.mock("../core/SessionTracker.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/SessionTracker.js")>();
	return {
		...actual,
		loadConfig: vi.fn().mockResolvedValue({}),
		saveConfig: vi.fn().mockResolvedValue(undefined),
	};
});

vi.mock("../core/SummaryStore.js", () => ({
	getIndex: vi.fn(),
}));

vi.mock("../core/GitOps.js", () => ({
	readFileFromBranch: vi.fn(),
}));

vi.mock("../core/RepoProfile.js", () => ({
	readManualDisableFlag: vi.fn().mockResolvedValue(false),
}));

vi.mock("../core/SummaryTree.js", () => ({
	collectAllTopics: vi.fn().mockReturnValue([]),
}));

vi.mock("./HookUtils.js", () => ({
	readStdin: vi.fn().mockResolvedValue(JSON.stringify({ cwd: "/test" })),
}));

vi.mock("../Logger.js", () => ({
	createLogger: () => ({
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	}),
	setLogDir: vi.fn(),
	ORPHAN_BRANCH: "jollimemory/summaries/v3",
}));

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFileFromBranch } from "../core/GitOps.js";
import { readManualDisableFlag } from "../core/RepoProfile.js";
import { loadConfig, saveConfig } from "../core/SessionTracker.js";
import { getIndex } from "../core/SummaryStore.js";
import { collectAllTopics } from "../core/SummaryTree.js";

const mockExecFileSync = vi.mocked(execFileSync);
const mockGetIndex = vi.mocked(getIndex);
const mockReadFileFromBranch = vi.mocked(readFileFromBranch);
const mockCollectAllTopics = vi.mocked(collectAllTopics);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockRmSync = vi.mocked(rmSync);
const mockLoadConfig = vi.mocked(loadConfig);
const mockSaveConfig = vi.mocked(saveConfig);

function makeIndex(entries: SummaryIndex["entries"]): SummaryIndex {
	return { version: 3, entries };
}

function makeSummary(overrides: Partial<CommitSummary> = {}): CommitSummary {
	return {
		version: 3,
		commitHash: "aaa",
		commitMessage: "Test commit",
		commitAuthor: "dev",
		commitDate: "2026-03-29T10:00:00.000Z",
		branch: "feature/test-branch",
		generatedAt: "2026-03-29T10:01:00.000Z",
		stats: { filesChanged: 5, insertions: 100, deletions: 20 },
		topics: [],
		...overrides,
	};
}

// Import after mocks
const {
	main,
	buildSessionStartContext,
	computeLoginReminder,
	formatRecallSuggestion,
	getLoginReminder,
	ensurePluginDefaultProvider,
	getAuthFailureReminder,
} = await import("./SessionStartHook.js");

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SessionStartHook", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockExecFileSync.mockReturnValue("feature/test-branch\n" as never);
		mockReadFileFromBranch.mockResolvedValue(null);
		mockExistsSync.mockReturnValue(false);
		vi.mocked(readManualDisableFlag).mockResolvedValue(false);
	});

	// ─── Skip conditions ────────────────────────────────────────────────────

	it("should no-op when spawned by the local-agent backend (re-entry guard)", async () => {
		process.env.JOLLI_LOCAL_AGENT_CHILD = "1";
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			await main();
			// Bails before resolving the branch — no briefing, no self-recursion.
			expect(mockExecFileSync).not.toHaveBeenCalled();
			expect(writeSpy).not.toHaveBeenCalled();
		} finally {
			writeSpy.mockRestore();
			delete process.env.JOLLI_LOCAL_AGENT_CHILD;
		}
	});

	it("should emit no context while the repo is manually disabled", async () => {
		vi.mocked(readManualDisableFlag).mockResolvedValue(true);
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		expect(mockExecFileSync).not.toHaveBeenCalled();
		expect(mockGetIndex).not.toHaveBeenCalled();
		expect(writeSpy).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});

	it("should skip main/master/develop branches", async () => {
		mockExecFileSync.mockReturnValue("main\n" as never);
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		expect(writeSpy).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});

	it("should skip all reserved branches (develop, staging, production, development)", async () => {
		for (const branch of ["develop", "staging", "production", "development"]) {
			vi.clearAllMocks();
			mockExecFileSync.mockReturnValue(`${branch}\n` as never);
			mockExistsSync.mockReturnValue(false);
			mockReadFileFromBranch.mockResolvedValue(null);

			const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			await main();
			expect(writeSpy).not.toHaveBeenCalled();
			writeSpy.mockRestore();
		}
	});

	it("should skip when branch has no index records", async () => {
		mockGetIndex.mockResolvedValue(makeIndex([]));
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		expect(writeSpy).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});

	it("should skip when only 1 commit made today", async () => {
		const today = new Date().toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "Just started",
					commitDate: today,
					branch: "feature/test-branch",
					generatedAt: today,
				},
			]),
		);
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		expect(writeSpy).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});

	it("should skip when getCurrentBranch returns null (empty output)", async () => {
		mockExecFileSync.mockReturnValue("\n" as never);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();
		expect(writeSpy).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});

	it("should skip when getCurrentBranch throws", async () => {
		mockExecFileSync.mockImplementation(() => {
			throw new Error("git not found");
		});

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();
		expect(writeSpy).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});

	it("should skip when index is unavailable", async () => {
		mockGetIndex.mockResolvedValue(null);
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		expect(writeSpy).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});

	it("should skip when branch only has child entries", async () => {
		const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "child1",
					parentCommitHash: "root1",
					commitMessage: "Child commit",
					commitDate: recentDate,
					branch: "feature/test-branch",
					generatedAt: recentDate,
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();
		expect(writeSpy).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});

	// ─── Basic briefing output ──────────────────────────────────────────────

	it("should output briefing with commit count and dates", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "First commit",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Second commit",
					commitDate: "2026-03-29T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-29T10:01:00.000Z",
				},
			]),
		);
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		expect(writeSpy).toHaveBeenCalledTimes(1);
		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("Jolli Memory");
		expect(output).toContain("feature/test-branch");
		expect(output).toContain("2 commits");
		writeSpy.mockRestore();
	});

	it("should suggest recall when > 3 days since last commit", async () => {
		const oldDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "Old commit",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Recent-ish commit",
					commitDate: oldDate,
					branch: "feature/test-branch",
					generatedAt: oldDate,
				},
			]),
		);
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		expect(writeSpy).toHaveBeenCalledTimes(1);
		const output = writeSpy.mock.calls[0][0] as string;
		// CLI build → the recall CTA is the `jolli recall` command, NOT a jolli-recall skill.
		expect(output).toContain("jolli recall");
		expect(output).not.toContain("jolli-recall");
		expect(output).toContain("days since last commit");
		writeSpy.mockRestore();
	});

	it("should show tip when last commit was 1-3 days ago", async () => {
		const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "Older commit",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Recent commit",
					commitDate: recentDate,
					branch: "feature/test-branch",
					generatedAt: recentDate,
				},
			]),
		);
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		expect(writeSpy).toHaveBeenCalledTimes(1);
		const output = writeSpy.mock.calls[0][0] as string;
		// Non-plugin (CLI build): the tip names the `jolli recall` command, never a
		// jolli-recall skill (the plugin surface uses `/jolli:recall` instead).
		expect(output).toContain("Tip: run `jolli recall` for full context");
		expect(output).not.toContain("jolli-recall");
		expect(output).not.toContain("Warning:");
		writeSpy.mockRestore();
	});

	it("should return cached briefing when cache is valid", async () => {
		const { existsSync, readFileSync } = await import("node:fs");
		const mockExists = vi.mocked(existsSync);
		const mockRead = vi.mocked(readFileSync);

		// git branch returns feature/test-branch, HEAD returns specific hash
		mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
			const a = args as string[];
			if (a.includes("--show-current")) return "feature/test-branch\n";
			if (a.includes("HEAD")) return "deadbeef123\n";
			return "";
		});

		mockExists.mockReturnValue(true);
		mockRead.mockReturnValue(
			JSON.stringify({
				branch: "feature/test-branch",
				lastCommitHash: "deadbeef123",
				briefingText: "cached briefing text",
				generatedAt: new Date().toISOString(),
			}),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		expect(writeSpy).toHaveBeenCalledWith("cached briefing text");
		// Index should NOT be loaded when cache hits
		expect(mockGetIndex).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});

	it("should invalidate cache when branch differs", async () => {
		const { existsSync, readFileSync } = await import("node:fs");
		const mockExists = vi.mocked(existsSync);
		const mockRead = vi.mocked(readFileSync);

		mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
			const a = args as string[];
			if (a.includes("--show-current")) return "feature/test-branch\n";
			if (a.includes("HEAD")) return "deadbeef123\n";
			return "";
		});

		mockExists.mockReturnValue(true);
		mockRead.mockReturnValue(
			JSON.stringify({
				branch: "feature/different-branch",
				lastCommitHash: "deadbeef123",
				briefingText: "stale cache",
				generatedAt: new Date().toISOString(),
			}),
		);

		const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "Commit 1",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Commit 2",
					commitDate: recentDate,
					branch: "feature/test-branch",
					generatedAt: recentDate,
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		// Should generate fresh briefing, not return stale cache
		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("[Jolli Memory");
		expect(output).not.toBe("stale cache");
		writeSpy.mockRestore();
	});

	it("should invalidate cache when HEAD hash differs", async () => {
		const { existsSync, readFileSync } = await import("node:fs");
		const mockExists = vi.mocked(existsSync);
		const mockRead = vi.mocked(readFileSync);

		mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
			const a = args as string[];
			if (a.includes("--show-current")) return "feature/test-branch\n";
			if (a.includes("HEAD")) return "newhead456\n";
			return "";
		});

		mockExists.mockReturnValue(true);
		mockRead.mockReturnValue(
			JSON.stringify({
				branch: "feature/test-branch",
				lastCommitHash: "oldhead789",
				briefingText: "stale cache",
				generatedAt: new Date().toISOString(),
			}),
		);

		const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "Commit 1",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Commit 2",
					commitDate: recentDate,
					branch: "feature/test-branch",
					generatedAt: recentDate,
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("[Jolli Memory");
		writeSpy.mockRestore();
	});

	it("should use lastEntry.commitHash for cache when HEAD is unavailable", async () => {
		const { existsSync, writeFileSync } = await import("node:fs");
		const mockExists = vi.mocked(existsSync);
		const mockWrite = vi.mocked(writeFileSync);

		mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
			const a = args as string[];
			if (a.includes("--show-current")) return "feature/test-branch\n";
			if (a.includes("HEAD")) throw new Error("detached HEAD");
			return "";
		});

		mockExists.mockReturnValue(false);

		const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa111",
					parentCommitHash: null,
					commitMessage: "Old commit",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "bbb222",
					parentCommitHash: null,
					commitMessage: "Last commit",
					commitDate: recentDate,
					branch: "feature/test-branch",
					generatedAt: recentDate,
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		expect(writeSpy).toHaveBeenCalledTimes(1);
		// Cache should use lastEntry.commitHash as fallback
		const writeCall = mockWrite.mock.calls[0];
		const cached = JSON.parse(writeCall[1] as string);
		expect(cached.lastCommitHash).toBe("bbb222");
		writeSpy.mockRestore();
	});

	it("should save briefing cache and create dir when missing", async () => {
		const { existsSync, writeFileSync, mkdirSync } = await import("node:fs");
		const mockExists = vi.mocked(existsSync);
		const mockWrite = vi.mocked(writeFileSync);
		const mockMkdir = vi.mocked(mkdirSync);

		mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
			const a = args as string[];
			if (a.includes("--show-current")) return "feature/test-branch\n";
			if (a.includes("HEAD")) return "headhash123\n";
			return "";
		});

		mockExists.mockReturnValue(false);

		const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "First",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Second",
					commitDate: recentDate,
					branch: "feature/test-branch",
					generatedAt: recentDate,
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		// Should create the directory
		expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining("jollimemory"), { recursive: true });
		// Should write the cache file
		expect(mockWrite).toHaveBeenCalled();
		const writeCall = mockWrite.mock.calls[0];
		expect(writeCall[0]).toContain("briefing-cache.json");
		writeSpy.mockRestore();
	});

	it("should handle cache write failure gracefully", async () => {
		const { existsSync, writeFileSync, mkdirSync } = await import("node:fs");
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(mkdirSync).mockImplementation(() => {
			throw new Error("permission denied");
		});

		const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "First",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Second",
					commitDate: recentDate,
					branch: "feature/test-branch",
					generatedAt: recentDate,
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		// Should still produce briefing despite cache write failure
		expect(writeSpy).toHaveBeenCalledTimes(1);
		expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});

	it("should handle malformed cache JSON gracefully", async () => {
		const { existsSync, readFileSync } = await import("node:fs");
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockReturnValue("not valid json {{{");

		const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "First",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Second",
					commitDate: recentDate,
					branch: "feature/test-branch",
					generatedAt: recentDate,
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		// Should fall through to fresh generation
		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("[Jolli Memory");
		writeSpy.mockRestore();
	});

	it("should silently handle stdin errors without blocking", async () => {
		const { readStdin } = await import("./HookUtils.js");
		vi.mocked(readStdin).mockRejectedValueOnce(new Error("stdin broken"));

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		// Should not throw, should not write
		expect(writeSpy).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});

	it("should fall back to process.cwd() when cwd is not in stdin", async () => {
		const { readStdin } = await import("./HookUtils.js");
		vi.mocked(readStdin).mockResolvedValueOnce(JSON.stringify({}));
		mockGetIndex.mockResolvedValue(null);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		expect(writeSpy).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});

	it("should exclude child entries from root count", async () => {
		const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "root1",
					parentCommitHash: null,
					commitMessage: "Root commit",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "child1",
					parentCommitHash: "root1",
					commitMessage: "Child commit",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "root2",
					parentCommitHash: null,
					commitMessage: "Second root",
					commitDate: recentDate,
					branch: "feature/test-branch",
					generatedAt: recentDate,
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("2 commits");
		writeSpy.mockRestore();
	});

	it("should ignore entries from other branches and include undefined parent hashes as roots", async () => {
		const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "other-branch-root",
					parentCommitHash: null,
					commitMessage: "Other branch",
					commitDate: olderDate,
					branch: "feature/other-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "root-null",
					parentCommitHash: null,
					commitMessage: "Current branch root",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "root-undefined",
					parentCommitHash: undefined,
					commitMessage: "Newest current branch root",
					commitDate: recentDate,
					branch: "feature/test-branch",
					generatedAt: recentDate,
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		expect(writeSpy).toHaveBeenCalledTimes(1);
		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("2 commits");
		expect(output).not.toContain("Other branch");
		writeSpy.mockRestore();
	});

	// ─── Enriched data (diffStats, decisions, plans, topics) ────────────────

	it("should include diffStats when available in index entries", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "First commit",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-28T10:01:00.000Z",
					diffStats: { filesChanged: 5, insertions: 120, deletions: 30 },
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Second commit",
					commitDate: "2026-03-29T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-29T10:01:00.000Z",
					diffStats: { filesChanged: 3, insertions: 50, deletions: 10 },
				},
			]),
		);
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		expect(writeSpy).toHaveBeenCalledTimes(1);
		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("8 files");
		expect(output).toContain("+170");
		expect(output).toContain("-40");
		writeSpy.mockRestore();
	});

	it("should include topic title from last summary", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "First commit",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Second commit",
					commitDate: "2026-03-29T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-29T10:01:00.000Z",
				},
			]),
		);
		mockReadFileFromBranch.mockResolvedValue(JSON.stringify(makeSummary({ commitHash: "bbb" })));
		mockCollectAllTopics.mockReturnValue([
			{
				title: "Implement token refresh flow",
				trigger: "Need auto-refresh",
				response: "Built token refresh",
				decisions: "JWT + rotating refresh tokens",
				commitDate: "2026-03-29",
			},
		]);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("Implement token refresh flow");
		writeSpy.mockRestore();
	});

	it("should include key decisions from last summary", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "Commit A",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Commit B",
					commitDate: "2026-03-29T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-29T10:01:00.000Z",
				},
			]),
		);
		mockReadFileFromBranch.mockResolvedValue(JSON.stringify(makeSummary()));
		mockCollectAllTopics.mockReturnValue([
			{
				title: "Auth implementation",
				trigger: "Need auth",
				response: "Built auth",
				decisions: "Interface-based provider pattern",
				commitDate: "2026-03-29",
			},
			{
				title: "Token management",
				trigger: "Need tokens",
				response: "Built tokens",
				decisions: "JWT + rotating refresh tokens 15min/7d",
				commitDate: "2026-03-29",
			},
		]);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("Decisions:");
		expect(output).toContain("Interface-based provider pattern");
		expect(output).toContain("JWT + rotating refresh tokens 15min/7d");
		writeSpy.mockRestore();
	});

	it("should include associated plan names from plans.json", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "First",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Second",
					commitDate: "2026-03-29T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-29T10:01:00.000Z",
				},
			]),
		);
		const plansRegistry: PlansRegistry = {
			version: 1,
			plans: {
				"oauth-strategy": {
					slug: "oauth-strategy",
					title: "OAuth2 Integration Strategy",
					sourcePath: "plans/oauth-strategy.md",
					addedAt: "2026-03-28T10:00:00.000Z",
					updatedAt: "2026-03-29T10:00:00.000Z",
					commitHash: null,
				},
				"second-active-plan": {
					slug: "second-active-plan",
					title: "Second Active Plan",
					sourcePath: "plans/second.md",
					addedAt: "2026-03-28T10:00:00.000Z",
					updatedAt: "2026-03-28T10:00:00.000Z",
					commitHash: null,
				},
				"archived-plan": {
					slug: "archived-plan",
					title: "Already Archived Plan",
					sourcePath: "plans/archived.md",
					addedAt: "2026-03-27T10:00:00.000Z",
					updatedAt: "2026-03-28T10:00:00.000Z",
					commitHash: "abc123",
				},
			},
		};
		mockExistsSync.mockImplementation((path) => {
			return typeof path === "string" && path.endsWith("plans.json");
		});
		mockReadFileSync.mockReturnValue(JSON.stringify(plansRegistry));

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("Plans:");
		// All uncommitted plans are listed regardless of branch (branch/ignored scoping removed)
		expect(output).toContain("OAuth2 Integration Strategy");
		expect(output).toContain("Second Active Plan");
		// Committed (associated) plans are excluded from the active-plan list
		expect(output).not.toContain("Already Archived Plan");
		writeSpy.mockRestore();
	});

	it("excludes legacy soft-deleted (ignored) plans via §14 normalization", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "First",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
			]),
		);
		// `ghost-plan` carries a legacy `ignored:true` (a field no longer in the
		// type) — SessionStartHook must route through normalizePlansRegistry so it
		// is dropped rather than surfaced as an active associated plan.
		const plansRegistry = {
			version: 1,
			plans: {
				"active-plan": {
					slug: "active-plan",
					title: "Active Plan",
					sourcePath: "plans/active.md",
					addedAt: "2026-03-28T10:00:00.000Z",
					updatedAt: "2026-03-28T10:00:00.000Z",
					commitHash: null,
				},
				"ghost-plan": {
					slug: "ghost-plan",
					title: "Ghost Plan",
					sourcePath: "plans/ghost.md",
					addedAt: "2026-03-28T10:00:00.000Z",
					updatedAt: "2026-03-28T10:00:00.000Z",
					commitHash: null,
					ignored: true,
				},
			},
		} as unknown as PlansRegistry;
		mockExistsSync.mockImplementation((path) => {
			return typeof path === "string" && path.endsWith("plans.json");
		});
		mockReadFileSync.mockReturnValue(JSON.stringify(plansRegistry));

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("Active Plan");
		expect(output).not.toContain("Ghost Plan");
		writeSpy.mockRestore();
	});

	it("should fallback to commit message when summary load fails", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "Add OAuth scaffolding",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Implement token refresh",
					commitDate: "2026-03-29T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-29T10:01:00.000Z",
				},
			]),
		);
		mockReadFileFromBranch.mockResolvedValue(null);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("Implement token refresh");
		writeSpy.mockRestore();
	});

	it("should only load the last commit's summary (not all summaries)", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "old-hash",
					parentCommitHash: null,
					commitMessage: "Old commit",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
				{
					commitHash: "new-hash",
					parentCommitHash: null,
					commitMessage: "New commit",
					commitDate: "2026-03-29T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-29T10:01:00.000Z",
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		expect(mockReadFileFromBranch).toHaveBeenCalledTimes(1);
		expect(mockReadFileFromBranch).toHaveBeenCalledWith(
			"jollimemory/summaries/v3",
			"summaries/new-hash.json",
			"/test",
		);
		writeSpy.mockRestore();
	});

	it("should truncate decisions exceeding 200 chars", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "Commit A",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Commit B",
					commitDate: "2026-03-29T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-29T10:01:00.000Z",
				},
			]),
		);
		const longDecision1 = "A".repeat(120);
		const longDecision2 = "B".repeat(120);
		mockReadFileFromBranch.mockResolvedValue(JSON.stringify(makeSummary()));
		mockCollectAllTopics.mockReturnValue([
			{ title: "Topic A", trigger: "t", response: "r", decisions: longDecision1, commitDate: "2026-03-29" },
			{ title: "Topic B", trigger: "t", response: "r", decisions: longDecision2, commitDate: "2026-03-29" },
		]);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("Decisions:");
		expect(output).toContain(longDecision1);
		expect(output).not.toContain(longDecision2);
		writeSpy.mockRestore();
	});

	it("should hard-cap a single decision that exceeds 200 chars", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "Commit A",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Commit B",
					commitDate: "2026-03-29T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-29T10:01:00.000Z",
				},
			]),
		);
		const hugeDecision = "X".repeat(300);
		mockReadFileFromBranch.mockResolvedValue(JSON.stringify(makeSummary()));
		mockCollectAllTopics.mockReturnValue([
			{ title: "Topic", trigger: "t", response: "r", decisions: hugeDecision, commitDate: "2026-03-29" },
		]);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("Decisions:");
		// Should be truncated with ellipsis, not the full 300-char string
		expect(output).not.toContain(hugeDecision);
		expect(output).toContain("…");
		writeSpy.mockRestore();
	});

	// ─── Time gap behavior ──────────────────────────────────────────────────

	it("should suggest recall when > 3 days since last commit", async () => {
		const oldDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "Old commit",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Recent-ish commit",
					commitDate: oldDate,
					branch: "feature/test-branch",
					generatedAt: oldDate,
				},
			]),
		);
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		expect(writeSpy).toHaveBeenCalledTimes(1);
		const output = writeSpy.mock.calls[0][0] as string;
		// CLI build → the recall CTA is the `jolli recall` command, NOT a jolli-recall skill.
		expect(output).toContain("jolli recall");
		expect(output).not.toContain("jolli-recall");
		expect(output).toContain("days since last commit");
		writeSpy.mockRestore();
	});

	it("should show tip when last commit was 1-3 days ago", async () => {
		const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "Older commit",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Recent commit",
					commitDate: recentDate,
					branch: "feature/test-branch",
					generatedAt: recentDate,
				},
			]),
		);
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		expect(writeSpy).toHaveBeenCalledTimes(1);
		const output = writeSpy.mock.calls[0][0] as string;
		// Non-plugin (CLI build): the tip names the `jolli recall` command, never a
		// jolli-recall skill (the plugin surface uses `/jolli:recall` instead).
		expect(output).toContain("Tip: run `jolli recall` for full context");
		expect(output).not.toContain("jolli-recall");
		expect(output).not.toContain("Warning:");
		writeSpy.mockRestore();
	});

	it("should not include tip or warning when last commit is today with 2+ commits", async () => {
		const todayDate = new Date().toISOString();
		const olderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "Older commit",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Today commit",
					commitDate: todayDate,
					branch: "feature/test-branch",
					generatedAt: todayDate,
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).not.toContain("Warning:");
		expect(output).not.toContain("Tip:");
		writeSpy.mockRestore();
	});

	// ─── Cache behavior ─────────────────────────────────────────────────────

	it("should return cached briefing when cache is valid", async () => {
		mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
			const a = args as string[];
			if (a.includes("--show-current")) return "feature/test-branch\n";
			if (a.includes("HEAD")) return "deadbeef123\n";
			return "";
		});

		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			JSON.stringify({
				branch: "feature/test-branch",
				lastCommitHash: "deadbeef123",
				briefingText: "cached briefing text",
				generatedAt: new Date().toISOString(),
			}),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		expect(writeSpy).toHaveBeenCalledWith("cached briefing text");
		expect(mockGetIndex).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});

	it("should invalidate cache when branch differs", async () => {
		mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
			const a = args as string[];
			if (a.includes("--show-current")) return "feature/test-branch\n";
			if (a.includes("HEAD")) return "deadbeef123\n";
			return "";
		});

		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			JSON.stringify({
				branch: "feature/different-branch",
				lastCommitHash: "deadbeef123",
				briefingText: "stale cache",
				generatedAt: new Date().toISOString(),
			}),
		);

		const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "Commit 1",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Commit 2",
					commitDate: recentDate,
					branch: "feature/test-branch",
					generatedAt: recentDate,
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("[Jolli Memory");
		expect(output).not.toBe("stale cache");
		writeSpy.mockRestore();
	});

	it("should invalidate cache when HEAD hash differs", async () => {
		mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
			const a = args as string[];
			if (a.includes("--show-current")) return "feature/test-branch\n";
			if (a.includes("HEAD")) return "newhead456\n";
			return "";
		});

		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			JSON.stringify({
				branch: "feature/test-branch",
				lastCommitHash: "oldhead789",
				briefingText: "stale cache",
				generatedAt: new Date().toISOString(),
			}),
		);

		const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "Commit 1",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Commit 2",
					commitDate: recentDate,
					branch: "feature/test-branch",
					generatedAt: recentDate,
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("[Jolli Memory");
		writeSpy.mockRestore();
	});

	it("should use lastEntry.commitHash for cache when HEAD is unavailable", async () => {
		const { mkdirSync } = await import("node:fs");
		vi.mocked(mkdirSync).mockImplementation(() => undefined as never);
		const mockWrite = vi.mocked(writeFileSync);

		mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
			const a = args as string[];
			if (a.includes("--show-current")) return "feature/test-branch\n";
			if (a.includes("HEAD")) throw new Error("detached HEAD");
			return "";
		});

		const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa111",
					parentCommitHash: null,
					commitMessage: "Old commit",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "bbb222",
					parentCommitHash: null,
					commitMessage: "Last commit",
					commitDate: recentDate,
					branch: "feature/test-branch",
					generatedAt: recentDate,
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		expect(writeSpy).toHaveBeenCalledTimes(1);
		const writeCall = mockWrite.mock.calls[0];
		const cached = JSON.parse(writeCall[1] as string);
		expect(cached.lastCommitHash).toBe("bbb222");
		writeSpy.mockRestore();
	});

	it("should save briefing cache and create dir when missing", async () => {
		const { mkdirSync } = await import("node:fs");
		const mockMkdir = vi.mocked(mkdirSync);
		mockMkdir.mockImplementation(() => undefined as never);
		const mockWrite = vi.mocked(writeFileSync);

		mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
			const a = args as string[];
			if (a.includes("--show-current")) return "feature/test-branch\n";
			if (a.includes("HEAD")) return "headhash123\n";
			return "";
		});

		mockExistsSync.mockReturnValue(false);

		const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "First",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Second",
					commitDate: recentDate,
					branch: "feature/test-branch",
					generatedAt: recentDate,
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining("jollimemory"), { recursive: true });
		expect(mockWrite).toHaveBeenCalled();
		const writeCall = mockWrite.mock.calls[0];
		expect(writeCall[0]).toContain("briefing-cache.json");
		writeSpy.mockRestore();
	});

	it("should handle cache write failure gracefully", async () => {
		const { mkdirSync } = await import("node:fs");
		vi.mocked(mkdirSync).mockImplementation(() => {
			throw new Error("permission denied");
		});

		const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "First",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Second",
					commitDate: recentDate,
					branch: "feature/test-branch",
					generatedAt: recentDate,
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		expect(writeSpy).toHaveBeenCalledTimes(1);
		expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});

	it("should handle malformed cache JSON gracefully", async () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue("not valid json {{{");

		const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "First",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Second",
					commitDate: recentDate,
					branch: "feature/test-branch",
					generatedAt: recentDate,
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("[Jolli Memory");
		writeSpy.mockRestore();
	});

	it("should save cache with existing dir (no mkdir needed)", async () => {
		const { mkdirSync } = await import("node:fs");
		const mockMkdir = vi.mocked(mkdirSync);

		mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
			const a = args as string[];
			if (a.includes("--show-current")) return "feature/test-branch\n";
			if (a.includes("HEAD")) return "headhash123\n";
			return "";
		});

		mockExistsSync.mockImplementation((p: unknown) => {
			if (typeof p === "string" && p.includes("briefing-cache")) return false;
			return true;
		});

		const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "First",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Second",
					commitDate: recentDate,
					branch: "feature/test-branch",
					generatedAt: recentDate,
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		expect(mockMkdir).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});

	it("should use lastEntry hash when getCurrentHeadHash returns empty string", async () => {
		mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
			const a = args as string[];
			if (a.includes("--show-current")) return "feature/test-branch\n";
			if (a.includes("HEAD")) return "\n";
			return "";
		});

		const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "First",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Second",
					commitDate: recentDate,
					branch: "feature/test-branch",
					generatedAt: recentDate,
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		expect(writeSpy).toHaveBeenCalledTimes(1);
		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("[Jolli Memory");
		const writeCalls = vi.mocked(writeFileSync).mock.calls;
		if (writeCalls.length > 0) {
			const cached = JSON.parse(writeCalls[0][1] as string);
			expect(cached.lastCommitHash).toBe("bbb");
		}
		writeSpy.mockRestore();
	});

	it("should invalidate cache when getCurrentHeadHash returns null", async () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			JSON.stringify({
				branch: "feature/test-branch",
				lastCommitHash: "somehash",
				briefingText: "cached",
				generatedAt: new Date().toISOString(),
			}),
		);

		mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
			const a = args as string[];
			if (a.includes("--show-current")) return "feature/test-branch\n";
			if (a.includes("HEAD")) throw new Error("no HEAD");
			return "";
		});

		const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const olderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "First",
					commitDate: olderDate,
					branch: "feature/test-branch",
					generatedAt: olderDate,
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Second",
					commitDate: recentDate,
					branch: "feature/test-branch",
					generatedAt: recentDate,
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("[Jolli Memory");
		writeSpy.mockRestore();
	});

	// ─── Error handling ─────────────────────────────────────────────────────

	it("should silently handle stdin errors without blocking", async () => {
		const { readStdin } = await import("./HookUtils.js");
		vi.mocked(readStdin).mockRejectedValueOnce(new Error("stdin broken"));

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		expect(writeSpy).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});

	it("should fall back to process.cwd() when cwd is not in stdin", async () => {
		const { readStdin } = await import("./HookUtils.js");
		vi.mocked(readStdin).mockResolvedValueOnce(JSON.stringify({}));
		mockGetIndex.mockResolvedValue(null);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		expect(writeSpy).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});

	it("should skip when stdin contains invalid JSON", async () => {
		const { readStdin } = await import("./HookUtils.js");
		vi.mocked(readStdin).mockResolvedValueOnce("not-json");

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		expect(writeSpy).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});

	// ─── Edge cases ─────────────────────────────────────────────────────────

	it("should time out without writing when briefing generation stalls", async () => {
		vi.useFakeTimers();
		mockGetIndex.mockImplementation(
			() =>
				new Promise(() => {
					// Keep generateBriefing pending so the timeout branch wins.
				}),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const mainPromise = main();

		await vi.advanceTimersByTimeAsync(500);
		await mainPromise;

		expect(writeSpy).not.toHaveBeenCalled();
		writeSpy.mockRestore();
		vi.useRealTimers();
	});

	it("should execute main from the script entry point", async () => {
		vi.resetModules();
		const originalArgv1 = process.argv[1];
		process.argv[1] = new URL("./SessionStartHook.ts", import.meta.url).pathname;
		mockGetIndex.mockResolvedValue(null);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await import("./SessionStartHook.js");
		await Promise.resolve();

		expect(writeSpy).not.toHaveBeenCalled();
		writeSpy.mockRestore();
		process.argv[1] = originalArgv1;
	});

	it("should fallback gracefully when summary JSON is malformed", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "First commit",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Last commit",
					commitDate: "2026-03-29T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-29T10:01:00.000Z",
				},
			]),
		);
		// Return malformed JSON to trigger the catch block in loadLastSummary
		mockReadFileFromBranch.mockResolvedValue("{ not valid json ::::");

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main();

		// Should still produce output (graceful degradation without topic/decisions)
		expect(writeSpy).toHaveBeenCalledTimes(1);
		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("[Jolli Memory");
		writeSpy.mockRestore();
	});

	it("should include topic title and decisions in briefing when summary has topics", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "Feature work",
					commitDate: "2026-03-29T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-29T10:01:00.000Z",
				},
			]),
		);
		// Return valid summary JSON for loadLastSummary
		mockReadFileFromBranch.mockResolvedValue(JSON.stringify(makeSummary()));
		// Return topics with decisions
		mockCollectAllTopics.mockReturnValue([
			{ title: "Add dark mode", trigger: "Requested", response: "Done", decisions: "Used CSS variables" },
			{ title: "Fix sidebar", trigger: "Bug", response: "Fixed", decisions: "" },
		]);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		expect(writeSpy).toHaveBeenCalledTimes(1);
		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("Fix sidebar"); // Last topic title
		writeSpy.mockRestore();
	});

	it("should fallback to commit message when summary has empty topics array", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "First commit",
					commitDate: "2026-03-28T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-28T10:01:00.000Z",
				},
				{
					commitHash: "bbb",
					parentCommitHash: null,
					commitMessage: "Last commit message",
					commitDate: "2026-03-29T10:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-29T10:01:00.000Z",
				},
			]),
		);
		// Valid summary JSON but topics are empty
		mockReadFileFromBranch.mockResolvedValue(JSON.stringify(makeSummary()));
		mockCollectAllTopics.mockReturnValue([]);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		expect(writeSpy).toHaveBeenCalledTimes(1);
		const output = writeSpy.mock.calls[0][0] as string;
		// With no topics, should fallback to commit message for "Last:" line
		expect(output).toContain("Last: Last commit message");
		writeSpy.mockRestore();
	});

	it("should render unknown dates when commit dates are empty", async () => {
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "Undated commit",
					commitDate: "",
					branch: "feature/test-branch",
					// Both dates empty → getDisplayDate falls back to "" → formatDate renders "unknown"
					generatedAt: "",
				},
			]),
		);

		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();

		expect(writeSpy).toHaveBeenCalledTimes(1);
		const output = writeSpy.mock.calls[0][0] as string;
		expect(output).toContain("1 commits (unknown ~ unknown)");
		expect(output).toContain("(unknown)");
		writeSpy.mockRestore();
	});
});

// ─── Plugin default provider ─────────────────────────────────────────────────

describe("ensurePluginDefaultProvider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSaveConfig.mockResolvedValue(undefined);
	});

	it("seeds aiProvider=local-agent + localAgentTool on the plugin surface when unset", async () => {
		const wrote = await ensurePluginDefaultProvider("claude-plugin", {});
		expect(wrote).toBe(true);
		expect(mockSaveConfig).toHaveBeenCalledWith({ aiProvider: "local-agent", localAgentTool: "claude-code" });
	});

	it("does nothing off the plugin build (cli / vscode keep their own default-derivation)", async () => {
		expect(await ensurePluginDefaultProvider("cli", {})).toBe(false);
		expect(await ensurePluginDefaultProvider("vscode-plugin", {})).toBe(false);
		expect(mockSaveConfig).not.toHaveBeenCalled();
	});

	it("never overwrites an explicit provider choice", async () => {
		for (const aiProvider of ["anthropic", "jolli", "local-agent"] as const) {
			expect(await ensurePluginDefaultProvider("claude-plugin", { aiProvider })).toBe(false);
		}
		expect(mockSaveConfig).not.toHaveBeenCalled();
	});

	it("swallows a config-write failure so session startup is never blocked", async () => {
		mockSaveConfig.mockRejectedValueOnce(new Error("disk full"));
		expect(await ensurePluginDefaultProvider("claude-plugin", {})).toBe(false);
	});
});

// ─── Login reminder ──────────────────────────────────────────────────────────

describe("computeLoginReminder", () => {
	it("returns the reminder for the claude-plugin surface with no credential and no dismiss", () => {
		const text = computeLoginReminder("claude-plugin", false, false);
		expect(text).toContain("/jolli:login");
		expect(text).toContain("Not signed in");
	});

	it("returns null for non-plugin surfaces (cli / vscode) even without a credential", () => {
		expect(computeLoginReminder("cli", false, false)).toBeNull();
		expect(computeLoginReminder("vscode-plugin", false, false)).toBeNull();
	});

	it("returns null when a credential is configured", () => {
		expect(computeLoginReminder("claude-plugin", true, false)).toBeNull();
	});

	it("returns null when the reminder has been dismissed", () => {
		expect(computeLoginReminder("claude-plugin", false, true)).toBeNull();
	});
});

describe("formatRecallSuggestion", () => {
	it("returns null when the last commit is same-day (0 days)", () => {
		expect(formatRecallSuggestion(0, "cli")).toBeNull();
		expect(formatRecallSuggestion(0, "claude-plugin")).toBeNull();
	});

	it("uses the /jolli:recall namespaced skill on the Claude Code plugin surface", () => {
		expect(formatRecallSuggestion(2, "claude-plugin")).toBe("Tip: run /jolli:recall for full context");
		expect(formatRecallSuggestion(9, "claude-plugin")).toBe(
			"Warning: 9 days since last commit. Run /jolli:recall for full context.",
		);
	});

	it("uses the `jolli recall` CLI on non-plugin surfaces and never names a jolli-recall skill", () => {
		for (const kind of ["cli", "vscode-plugin", "intellij-plugin"]) {
			const tip = formatRecallSuggestion(2, kind);
			const warning = formatRecallSuggestion(9, kind);
			expect(tip).toBe("Tip: run `jolli recall` for full context");
			expect(warning).toBe("Warning: 9 days since last commit. Run `jolli recall` for full context.");
			expect(tip).not.toContain("jolli-recall");
			expect(warning).not.toContain("jolli-recall");
		}
	});

	it("switches from Tip to Warning past the 3-day threshold", () => {
		expect(formatRecallSuggestion(3, "cli")?.startsWith("Tip:")).toBe(true);
		expect(formatRecallSuggestion(4, "cli")?.startsWith("Warning:")).toBe(true);
	});
});

describe("getLoginReminder", () => {
	const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.ANTHROPIC_API_KEY;
		mockLoadConfig.mockResolvedValue({});
		mockExistsSync.mockReturnValue(false);
	});

	afterEach(() => {
		if (savedAnthropicKey === undefined) {
			delete process.env.ANTHROPIC_API_KEY;
		} else {
			process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
		}
	});

	// The CLI test build fixes __JOLLI_CLIENT_KIND__ to "cli", so the returned
	// value is always null here — these tests exercise the credential/marker
	// wiring and side effects (the reminder text itself is covered above).
	it("removes a stale dismiss marker once a credential is present", async () => {
		mockLoadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-test" });
		mockExistsSync.mockReturnValue(true);

		const result = await getLoginReminder("/test");

		expect(mockRmSync).toHaveBeenCalledWith(expect.stringContaining("login-reminder-dismissed"));
		expect(result).toBeNull();
	});

	it("treats the local-agent provider as credentialed (no key needed)", async () => {
		// local-agent drives the tool's own subscription login, so it has NO
		// apiKey/jolliApiKey/ANTHROPIC_API_KEY yet still generates memories. It must
		// count as credentialed — proven here by the stale marker being cleaned up
		// (the `hasCredential === true` side effect), not left in place.
		mockLoadConfig.mockResolvedValue({ aiProvider: "local-agent" });
		mockExistsSync.mockReturnValue(true);

		const result = await getLoginReminder("/test");

		expect(mockRmSync).toHaveBeenCalledWith(expect.stringContaining("login-reminder-dismissed"));
		expect(result).toBeNull();
	});

	it("tolerates a marker-cleanup failure", async () => {
		mockLoadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-test" });
		mockExistsSync.mockReturnValue(true);
		mockRmSync.mockImplementation(() => {
			throw new Error("EACCES");
		});

		await expect(getLoginReminder("/test")).resolves.toBeNull();
		expect(mockRmSync).toHaveBeenCalled();
	});

	it("does not remove the marker when no credential is present", async () => {
		mockLoadConfig.mockResolvedValue({});
		mockExistsSync.mockReturnValue(true);

		const result = await getLoginReminder("/test");

		expect(mockRmSync).not.toHaveBeenCalled();
		expect(result).toBeNull();
	});
});

describe("getAuthFailureReminder", () => {
	const AUTH = "local-agent-auth" as const;

	function indexWith(...marks: Array<{ hash: string; date: string }>): SummaryIndex {
		return makeIndex(
			marks.map(({ hash, date }) => ({
				commitHash: hash,
				parentCommitHash: null,
				commitMessage: `commit ${hash}`,
				commitDate: date,
				branch: "feature/test-branch",
				generatedAt: date,
			})),
		);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		mockExecFileSync.mockReturnValue("feature/test-branch\n" as never);
	});

	it("returns the reminder when the newest commit carries the auth marker", async () => {
		mockGetIndex.mockResolvedValue(indexWith({ hash: "newest", date: "2026-03-29T12:00:00.000Z" }));
		mockReadFileFromBranch.mockResolvedValue(JSON.stringify(makeSummary({ summaryError: AUTH })));

		const result = await getAuthFailureReminder("/test", "claude-plugin");

		expect(result).toContain("the Claude login used for local generation has expired");
		expect(result).toContain("claude auth login");
		expect(result).toContain("jolli configure --set aiProvider");
		// It read the newest commit's summary file.
		expect(mockReadFileFromBranch).toHaveBeenCalledWith(
			"jollimemory/summaries/v3",
			"summaries/newest.json",
			"/test",
		);
	});

	it("returns null once the newest commit is healthy again (auto-clear)", async () => {
		mockGetIndex.mockResolvedValue(indexWith({ hash: "newest", date: "2026-03-29T12:00:00.000Z" }));
		mockReadFileFromBranch.mockResolvedValue(JSON.stringify(makeSummary({ summaryError: undefined })));

		expect(await getAuthFailureReminder("/test", "claude-plugin")).toBeNull();
	});

	it("does not fire for a generic llm-failed marker (auth-specific only)", async () => {
		mockGetIndex.mockResolvedValue(indexWith({ hash: "newest", date: "2026-03-29T12:00:00.000Z" }));
		mockReadFileFromBranch.mockResolvedValue(JSON.stringify(makeSummary({ summaryError: "llm-failed" })));

		expect(await getAuthFailureReminder("/test", "claude-plugin")).toBeNull();
	});

	it("checks only the NEWEST commit — an old auth failure under a newer healthy commit is silent", async () => {
		mockGetIndex.mockResolvedValue(
			indexWith(
				{ hash: "older-failed", date: "2026-03-29T09:00:00.000Z" },
				{ hash: "newest-ok", date: "2026-03-29T12:00:00.000Z" },
			),
		);
		// The hook must read the newest ("newest-ok"), which is healthy → no reminder.
		mockReadFileFromBranch.mockResolvedValue(JSON.stringify(makeSummary({ summaryError: undefined })));

		expect(await getAuthFailureReminder("/test", "claude-plugin")).toBeNull();
		expect(mockReadFileFromBranch).toHaveBeenCalledWith(
			"jollimemory/summaries/v3",
			"summaries/newest-ok.json",
			"/test",
		);
	});

	it("is gated to the Claude Code plugin — other client kinds never see it", async () => {
		mockGetIndex.mockResolvedValue(indexWith({ hash: "newest", date: "2026-03-29T12:00:00.000Z" }));
		mockReadFileFromBranch.mockResolvedValue(JSON.stringify(makeSummary({ summaryError: AUTH })));

		expect(await getAuthFailureReminder("/test", "cli")).toBeNull();
		// Gated out before any git/index work.
		expect(mockGetIndex).not.toHaveBeenCalled();
	});

	it("fires on main too — an auth failure is branch-independent (NOT skipped like the briefing)", async () => {
		mockExecFileSync.mockReturnValue("main\n" as never);
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "onmain",
					parentCommitHash: null,
					commitMessage: "commit on main",
					commitDate: "2026-03-29T12:00:00.000Z",
					branch: "main",
					generatedAt: "2026-03-29T12:00:00.000Z",
				},
			]),
		);
		mockReadFileFromBranch.mockResolvedValue(JSON.stringify(makeSummary({ branch: "main", summaryError: AUTH })));

		expect(await getAuthFailureReminder("/test", "claude-plugin")).toContain("claude auth login");
	});

	it("returns null on a detached HEAD (no branch)", async () => {
		mockExecFileSync.mockReturnValue("\n" as never);
		expect(await getAuthFailureReminder("/test", "claude-plugin")).toBeNull();
		expect(mockGetIndex).not.toHaveBeenCalled();
	});

	it("returns null when there is no index", async () => {
		mockGetIndex.mockResolvedValue(null);
		expect(await getAuthFailureReminder("/test", "claude-plugin")).toBeNull();
	});

	it("returns null when the branch has no root entries", async () => {
		mockGetIndex.mockResolvedValue(makeIndex([]));
		expect(await getAuthFailureReminder("/test", "claude-plugin")).toBeNull();
	});

	it("returns null (not throw) when the summary file is missing", async () => {
		mockGetIndex.mockResolvedValue(indexWith({ hash: "newest", date: "2026-03-29T12:00:00.000Z" }));
		mockReadFileFromBranch.mockResolvedValue(null);
		expect(await getAuthFailureReminder("/test", "claude-plugin")).toBeNull();
	});
});

// The PluginBootstrap path (the ONLY caller that passes includePluginReminders:
// true) mocks buildSessionStartContext wholesale, so these are the sole tests that
// exercise the reminder-assembly branch end-to-end. Without them, deleting the
// getAuthFailureReminder / getLoginReminder wiring inside buildSessionStartContext
// would leave every test green.
describe("buildSessionStartContext — plugin reminder assembly", () => {
	const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;

	beforeEach(() => {
		vi.clearAllMocks();
		// The not-signed-in reminder is gated on hasLlmCredentials, which counts the
		// ANTHROPIC_API_KEY env var — clear it so a dev machine's key can't suppress it.
		delete process.env.ANTHROPIC_API_KEY;
		mockExecFileSync.mockReturnValue("feature/test-branch\n" as never);
		mockReadFileFromBranch.mockResolvedValue(null);
		mockExistsSync.mockReturnValue(false);
		mockLoadConfig.mockResolvedValue({});
		vi.mocked(readManualDisableFlag).mockResolvedValue(false);
	});

	afterEach(() => {
		if (savedAnthropicKey === undefined) {
			delete process.env.ANTHROPIC_API_KEY;
		} else {
			process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
		}
	});

	it("assembles BOTH the auth-failure and not-signed-in reminders (includePluginReminders: true)", async () => {
		// Newest commit failed on an expired local login → auth reminder fires.
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "newest",
					parentCommitHash: null,
					commitMessage: "commit newest",
					commitDate: "2026-03-29T12:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-29T12:00:00.000Z",
				},
			]),
		);
		mockReadFileFromBranch.mockResolvedValue(JSON.stringify(makeSummary({ summaryError: "local-agent-auth" })));
		// No credential + no dismiss marker → not-signed-in reminder fires too.
		mockLoadConfig.mockResolvedValue({});
		mockExistsSync.mockReturnValue(false);

		const result = await buildSessionStartContext("/test", "claude-plugin", {
			includeBriefing: false,
			includePluginReminders: true,
		});

		expect(result).not.toBeNull();
		// Auth-failure section (from getAuthFailureReminder).
		expect(result).toContain("the Claude login used for local generation has expired");
		// Not-signed-in section (from getLoginReminder → computeLoginReminder).
		expect(result).toContain("/jolli:login");
		// Ordered auth-failure first, then not-signed-in, joined by a blank line.
		expect((result as string).indexOf("has expired")).toBeLessThan((result as string).indexOf("/jolli:login"));
		expect(result).toContain("\n\n");
	});

	it("skips both reminders when includePluginReminders is false, even with reminder triggers present", async () => {
		// Same triggering state as above — but the false gate must consult neither
		// getAuthFailureReminder nor getLoginReminder, so the result is null.
		mockGetIndex.mockResolvedValue(
			makeIndex([
				{
					commitHash: "newest",
					parentCommitHash: null,
					commitMessage: "commit newest",
					commitDate: "2026-03-29T12:00:00.000Z",
					branch: "feature/test-branch",
					generatedAt: "2026-03-29T12:00:00.000Z",
				},
			]),
		);
		mockReadFileFromBranch.mockResolvedValue(JSON.stringify(makeSummary({ summaryError: "local-agent-auth" })));

		const result = await buildSessionStartContext("/test", "claude-plugin", {
			includeBriefing: false,
			includePluginReminders: false,
		});

		expect(result).toBeNull();
		// The reminder path never read the config/marker.
		expect(mockLoadConfig).not.toHaveBeenCalled();
	});
});

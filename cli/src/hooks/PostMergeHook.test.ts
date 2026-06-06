import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractMergedBranches, handlePostMerge } from "./PostMergeHook.js";

vi.mock("../core/GitOps.js", () => ({
	execGit: vi.fn(),
}));

vi.mock("../core/SessionTracker.js", () => ({
	loadConfig: vi.fn(),
	getGlobalConfigDir: vi.fn().mockReturnValue("/home/user/.jolli/jollimemory"),
}));

vi.mock("./QueueWorker.js", () => ({
	launchWorker: vi.fn(),
}));

vi.mock("../core/IngestTrigger.js", () => ({
	enqueueIngestOperation: vi.fn().mockResolvedValue(true),
}));

import { execGit } from "../core/GitOps.js";
import { enqueueIngestOperation } from "../core/IngestTrigger.js";
import { loadConfig } from "../core/SessionTracker.js";
import { launchWorker } from "./QueueWorker.js";

const mockExecGit = vi.mocked(execGit);
const mockLoadConfig = vi.mocked(loadConfig);
const mockLaunchWorker = vi.mocked(launchWorker);
const mockEnqueueIngest = vi.mocked(enqueueIngestOperation);

describe("extractMergedBranches", () => {
	it("should extract branch name from Merge branch pattern", () => {
		const branches = extractMergedBranches("Merge branch 'feature/oauth' into main");
		expect(branches).toEqual(["feature/oauth"]);
	});

	it("should extract branch from GitHub PR merge pattern", () => {
		const branches = extractMergedBranches("Merge pull request #42 from user/feature/oauth");
		expect(branches).toEqual(["feature/oauth"]);
	});

	it("should handle multiple merge commits", () => {
		const logOutput = "Merge branch 'feature/oauth' into main\nMerge branch 'feature/auth' into main";
		const branches = extractMergedBranches(logOutput);
		expect(branches).toEqual(["feature/oauth", "feature/auth"]);
	});

	it("should return empty array for fast-forward pulls", () => {
		expect(extractMergedBranches("")).toEqual([]);
	});

	it("should return empty array for whitespace-only input", () => {
		expect(extractMergedBranches("   \n  ")).toEqual([]);
	});

	it("should handle GitHub-style PR with nested path", () => {
		const branches = extractMergedBranches("Merge pull request #123 from org/feature/my-branch");
		expect(branches).toEqual(["feature/my-branch"]);
	});
});

describe("handlePostMerge", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockEnqueueIngest.mockResolvedValue(true);
	});

	it("should skip when no merge commits detected", async () => {
		mockExecGit.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

		await handlePostMerge("/test");

		expect(mockLoadConfig).not.toHaveBeenCalled();
		expect(mockEnqueueIngest).not.toHaveBeenCalled();
		expect(mockLaunchWorker).not.toHaveBeenCalled();
	});

	it("should skip when git log fails", async () => {
		mockExecGit.mockResolvedValue({ stdout: "", stderr: "error", exitCode: 1 });

		await handlePostMerge("/test");

		expect(mockLoadConfig).not.toHaveBeenCalled();
	});

	it("should skip when no API key configured", async () => {
		mockExecGit.mockResolvedValue({
			stdout: "Merge branch 'feature/oauth' into main",
			stderr: "",
			exitCode: 0,
		});
		mockLoadConfig.mockResolvedValue({});
		const origKey = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;

		await handlePostMerge("/test");

		expect(mockEnqueueIngest).not.toHaveBeenCalled();
		expect(mockLaunchWorker).not.toHaveBeenCalled();
		if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
	});

	it("enqueues ONE ingest op (not N compile ops) for N merged branches + launches the worker once", async () => {
		mockExecGit.mockResolvedValue({
			stdout: "Merge branch 'feature/oauth' into main",
			stderr: "",
			exitCode: 0,
		});
		mockLoadConfig.mockResolvedValue({ apiKey: "sk-test" });

		await handlePostMerge("/test");

		// SP3: one ingest op total, not one compile op per branch
		expect(mockEnqueueIngest).toHaveBeenCalledOnce();
		expect(mockEnqueueIngest).toHaveBeenCalledWith("/test", "post-merge");
		// Worker is launched once for the entire pull range
		expect(mockLaunchWorker).toHaveBeenCalledOnce();
	});

	it("N merged branches enqueue exactly ONE ingest op (not N compile ops)", async () => {
		mockExecGit.mockResolvedValue({
			stdout: "Merge branch 'feature/a' into main\nMerge branch 'feature/b' into main",
			stderr: "",
			exitCode: 0,
		});
		mockLoadConfig.mockResolvedValue({ apiKey: "sk-test" });

		await handlePostMerge("/test");

		expect(mockEnqueueIngest).toHaveBeenCalledOnce();
		expect(mockLaunchWorker).toHaveBeenCalledOnce();
	});

	it("still enqueues when a merge has content but no parseable branch name (repo-wide ingest needs none)", async () => {
		// `git log --merges` returned a real merge, but its subject matches neither
		// the "Merge branch '…'" nor the "Merge pull request #N from …" pattern
		// (customized message / "Merge remote-tracking branch …" / git-host variant).
		// SP3's ingest op is repo-wide, so the missing branch name must NOT drop it.
		mockExecGit.mockResolvedValue({
			stdout: "Reconcile upstream history",
			stderr: "",
			exitCode: 0,
		});
		mockLoadConfig.mockResolvedValue({ apiKey: "sk-test" });

		await handlePostMerge("/test");

		expect(mockEnqueueIngest).toHaveBeenCalledOnce();
		expect(mockEnqueueIngest).toHaveBeenCalledWith("/test", "post-merge");
		expect(mockLaunchWorker).toHaveBeenCalledOnce();
	});

	it("falls back to HEAD when the reflog is unavailable (fresh worktree) and HEAD is a merge", async () => {
		// `git log HEAD@{1}..HEAD` fatals in a freshly-added linked worktree whose
		// HEAD reflog has no second entry. The hook must still detect the merge that
		// just landed at HEAD rather than silently skipping the ingest.
		mockExecGit.mockImplementation(async (args: readonly string[]) => {
			const cmd = args.join(" ");
			if (cmd.includes("HEAD@{1}..HEAD")) {
				return { stdout: "", stderr: "fatal: ambiguous argument 'HEAD@{1}'", exitCode: 128 };
			}
			if (cmd.includes("%P")) return { stdout: "parent1 parent2", stderr: "", exitCode: 0 };
			if (cmd.includes("%s")) {
				return { stdout: "Merge branch 'feature/oauth' into main", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		});
		mockLoadConfig.mockResolvedValue({ apiKey: "sk-test" });

		await handlePostMerge("/test");

		expect(mockEnqueueIngest).toHaveBeenCalledOnce();
		expect(mockEnqueueIngest).toHaveBeenCalledWith("/test", "post-merge");
		expect(mockLaunchWorker).toHaveBeenCalledOnce();
	});

	it("skips when the reflog is unavailable and HEAD is not a merge (fast-forward pull)", async () => {
		mockExecGit.mockImplementation(async (args: readonly string[]) => {
			const cmd = args.join(" ");
			if (cmd.includes("HEAD@{1}..HEAD")) return { stdout: "", stderr: "fatal", exitCode: 128 };
			if (cmd.includes("%P")) return { stdout: "singleparent", stderr: "", exitCode: 0 };
			return { stdout: "", stderr: "", exitCode: 0 };
		});

		await handlePostMerge("/test");

		expect(mockLoadConfig).not.toHaveBeenCalled();
		expect(mockEnqueueIngest).not.toHaveBeenCalled();
	});

	it("does not launch the worker when the ingest enqueue is refused", async () => {
		mockExecGit.mockResolvedValue({
			stdout: "Merge branch 'feature/x' into main",
			stderr: "",
			exitCode: 0,
		});
		mockLoadConfig.mockResolvedValue({ apiKey: "sk-test" });
		mockEnqueueIngest.mockResolvedValue(false);

		await handlePostMerge("/test");

		expect(mockEnqueueIngest).toHaveBeenCalledOnce();
		expect(mockLaunchWorker).not.toHaveBeenCalled();
	});
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// probeRepo's git-shaped facts (branch, missing-summary count, canonical
// identity) come from real subprocess/storage calls elsewhere in the
// codebase — mocked here so this stays a fast, deterministic unit test, on
// the same terms as the write-surface tests in DashboardServer.test.ts.
vi.mock("../backfill/BackfillEngine.js", () => ({
	countMissingSummaries: vi.fn().mockResolvedValue({ total: 42, missing: 5 }),
}));
vi.mock("../core/GitOps.js", () => ({
	getCurrentBranch: vi.fn().mockResolvedValue("main"),
}));
vi.mock("./RepoRegistry.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./RepoRegistry.js")>();
	return {
		...actual,
		resolveRepoIdentity: vi
			.fn()
			.mockResolvedValue({ identity: "repo-1", remoteUrl: "https://github.com/acme/api" }),
		listActiveRepos: vi.fn().mockResolvedValue([]),
	};
});

import { countMissingSummaries } from "../backfill/BackfillEngine.js";
import { getCurrentBranch } from "../core/GitOps.js";
import { probeRepo } from "./RepoProbe.js";
import { listActiveRepos, resolveRepoIdentity } from "./RepoRegistry.js";

describe("probeRepo", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-repoprobe-"));
		vi.mocked(listActiveRepos).mockResolvedValue([]);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	it("reports isGitRepo:false with nothing else for a folder with no .git", async () => {
		const result = await probeRepo(dir);
		expect(result).toEqual({ isGitRepo: false, alreadyAdded: false });
		expect(resolveRepoIdentity).not.toHaveBeenCalled();
	});

	it("reports real facts for a git repo: name, remote, branch, commit counts", async () => {
		mkdirSync(join(dir, ".git"));
		const result = await probeRepo(dir);
		expect(result.isGitRepo).toBe(true);
		expect(result.name).toBe("api");
		expect(result.remote).toBe("https://github.com/acme/api");
		expect(result.branch).toBe("main");
		expect(result.commits).toBe(42);
		expect(result.withoutMemoryYet).toBe(5);
		expect(result.alreadyAdded).toBe(false);
	});

	it("flags alreadyAdded when the resolved identity matches a registered repo", async () => {
		mkdirSync(join(dir, ".git"));
		vi.mocked(listActiveRepos).mockResolvedValue([
			{ repoIdentity: "repo-1", repoName: "api", worktreeRoot: dir, enabledAt: "t" },
		]);
		const result = await probeRepo(dir);
		expect(result.alreadyAdded).toBe(true);
	});

	it("omits remote for a local-only repo (resolveRepoIdentity's file:// fallback)", async () => {
		mkdirSync(join(dir, ".git"));
		vi.mocked(resolveRepoIdentity).mockResolvedValueOnce({ identity: "local:abc123" });
		const result = await probeRepo(dir);
		expect(result.remote).toBeUndefined();
	});

	it("omits branch when it cannot be read, rather than reporting a fabricated one", async () => {
		mkdirSync(join(dir, ".git"));
		vi.mocked(getCurrentBranch).mockRejectedValueOnce(new Error("detached HEAD"));
		const result = await probeRepo(dir);
		expect(result.branch).toBeUndefined();
	});

	it("degrades commit counts to 0 rather than throwing when countMissingSummaries fails", async () => {
		mkdirSync(join(dir, ".git"));
		vi.mocked(countMissingSummaries).mockRejectedValueOnce(new Error("not a git repo after all"));
		const result = await probeRepo(dir);
		expect(result.commits).toBe(0);
		expect(result.withoutMemoryYet).toBe(0);
	});

	it("respects an explicit configDir when checking for an existing registration", async () => {
		mkdirSync(join(dir, ".git"));
		writeFileSync(join(dir, "marker"), "x"); // just to prove dir is used, not a real registry read
		await probeRepo(dir, "/some/config/dir");
		expect(listActiveRepos).toHaveBeenCalledWith("/some/config/dir");
	});
});

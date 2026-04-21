import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: vi.fn().mockReturnValue(false),
		readFileSync: vi.fn().mockReturnValue(""),
		statSync: vi.fn().mockImplementation(() => {
			throw new Error("ENOENT");
		}),
	};
});

vi.mock("../core/GitOps.js", () => ({
	getLastReflogAction: vi.fn().mockResolvedValue(""),
	getHeadHash: vi.fn().mockResolvedValue("aaaa000011112222333344445555666677778888"),
	readOrigHead: vi.fn().mockResolvedValue(null),
	isAncestor: vi.fn().mockResolvedValue(false),
	getCommitRange: vi.fn().mockResolvedValue([]),
}));

vi.mock("../core/SessionTracker.js", () => ({
	loadSquashPending: vi.fn().mockResolvedValue(null),
	saveSquashPending: vi.fn().mockResolvedValue(undefined),
}));

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { getCommitRange, getHeadHash, getLastReflogAction, isAncestor, readOrigHead } from "../core/GitOps.js";
import { loadSquashPending, saveSquashPending } from "../core/SessionTracker.js";
import {
	detectCommitOperation,
	detectResetSquash,
	readLastReflogSubject,
	resolveGitDir,
} from "./GitOperationDetector.js";

describe("GitOperationDetector", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		// Default: statSync throws so resolveGitDir falls back to dotGit path
		vi.mocked(existsSync).mockReturnValue(false);
		delete process.env.GIT_REFLOG_ACTION;
	});

	describe("readLastReflogSubject", () => {
		it("should return the trimmed reflog subject on success", () => {
			vi.mocked(execSync).mockReturnValueOnce("commit (amend): Fix typo\n");

			const result = readLastReflogSubject("/test/repo");

			expect(result).toBe("commit (amend): Fix typo");
			expect(execSync).toHaveBeenCalledWith("git reflog -1 --format=%gs", {
				cwd: "/test/repo",
				encoding: "utf-8",
			});
		});

		it("should return null when execSync throws", () => {
			vi.mocked(execSync).mockImplementationOnce(() => {
				throw new Error("fatal: reflog is empty");
			});

			const result = readLastReflogSubject("/test/repo");

			expect(result).toBeNull();
		});
	});

	describe("detectResetSquash", () => {
		const CWD = "/test/project";
		const HEAD_HASH = "aaaa000011112222333344445555666677778888";
		const ORIG_HEAD_HASH = "bbbb000011112222333344445555666677778888";
		const SQUASHED_HASHES = [
			"cccc000011112222333344445555666677778888",
			"dddd000011112222333344445555666677778888",
		];

		/** Configures all mocks for a successful reset-squash detection. */
		function setupHappyPath(): void {
			vi.mocked(loadSquashPending).mockResolvedValueOnce(null);
			vi.mocked(getLastReflogAction).mockResolvedValueOnce("reset: moving to HEAD~2");
			vi.mocked(readOrigHead).mockResolvedValueOnce(ORIG_HEAD_HASH);
			vi.mocked(getHeadHash).mockResolvedValueOnce(HEAD_HASH);
			vi.mocked(isAncestor).mockResolvedValueOnce(true);
			vi.mocked(getCommitRange).mockResolvedValueOnce(SQUASHED_HASHES);
			vi.mocked(saveSquashPending).mockResolvedValueOnce(undefined);
		}

		it("should detect reset-squash and save squash-pending (happy path)", async () => {
			setupHappyPath();

			const result = await detectResetSquash(CWD);

			expect(result).toBe(true);
			expect(saveSquashPending).toHaveBeenCalledWith([...SQUASHED_HASHES], HEAD_HASH, CWD);
		});

		it("should return false when squash-pending.json already exists (step 0)", async () => {
			vi.mocked(loadSquashPending).mockResolvedValueOnce({
				sourceHashes: ["aaa"],
				expectedParentHash: "bbb",
			} as never);

			const result = await detectResetSquash(CWD);

			expect(result).toBe(false);
			expect(getLastReflogAction).not.toHaveBeenCalled();
			expect(saveSquashPending).not.toHaveBeenCalled();
		});

		it("should return false when reflog does not start with 'reset:' (step 1)", async () => {
			vi.mocked(loadSquashPending).mockResolvedValueOnce(null);
			vi.mocked(getLastReflogAction).mockResolvedValueOnce("commit: Add new feature");

			const result = await detectResetSquash(CWD);

			expect(result).toBe(false);
			expect(readOrigHead).not.toHaveBeenCalled();
			expect(saveSquashPending).not.toHaveBeenCalled();
		});

		it("should return false when ORIG_HEAD is null (step 2)", async () => {
			vi.mocked(loadSquashPending).mockResolvedValueOnce(null);
			vi.mocked(getLastReflogAction).mockResolvedValueOnce("reset: moving to HEAD~3");
			vi.mocked(readOrigHead).mockResolvedValueOnce(null);

			const result = await detectResetSquash(CWD);

			expect(result).toBe(false);
			expect(isAncestor).not.toHaveBeenCalled();
			expect(saveSquashPending).not.toHaveBeenCalled();
		});

		it("should return false when HEAD is not an ancestor of ORIG_HEAD (step 3)", async () => {
			vi.mocked(loadSquashPending).mockResolvedValueOnce(null);
			vi.mocked(getLastReflogAction).mockResolvedValueOnce("reset: moving to HEAD~3");
			vi.mocked(readOrigHead).mockResolvedValueOnce(ORIG_HEAD_HASH);
			vi.mocked(getHeadHash).mockResolvedValueOnce(HEAD_HASH);
			vi.mocked(isAncestor).mockResolvedValueOnce(false);

			const result = await detectResetSquash(CWD);

			expect(result).toBe(false);
			expect(getCommitRange).not.toHaveBeenCalled();
			expect(saveSquashPending).not.toHaveBeenCalled();
		});

		it("should return false when commit range is empty (step 4)", async () => {
			vi.mocked(loadSquashPending).mockResolvedValueOnce(null);
			vi.mocked(getLastReflogAction).mockResolvedValueOnce("reset: moving to HEAD~0");
			vi.mocked(readOrigHead).mockResolvedValueOnce(ORIG_HEAD_HASH);
			vi.mocked(getHeadHash).mockResolvedValueOnce(HEAD_HASH);
			vi.mocked(isAncestor).mockResolvedValueOnce(true);
			vi.mocked(getCommitRange).mockResolvedValueOnce([]);

			const result = await detectResetSquash(CWD);

			expect(result).toBe(false);
			expect(saveSquashPending).not.toHaveBeenCalled();
		});
	});

	describe("resolveGitDir", () => {
		it("should return .git path when statSync throws (not a git repo)", () => {
			vi.mocked(statSync).mockImplementation(() => {
				throw new Error("ENOENT");
			});

			const result = resolveGitDir("/test/project");

			expect(result).toContain(".git");
		});

		it("should return .git path when .git is a directory", () => {
			vi.mocked(statSync).mockReturnValue({ isFile: () => false } as ReturnType<typeof statSync>);

			const result = resolveGitDir("/test/project");

			expect(result).toContain(".git");
		});

		it("should resolve gitdir from .git file with absolute path", () => {
			vi.mocked(statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof statSync>);
			vi.mocked(readFileSync).mockReturnValue("gitdir: /repo/.git/worktrees/my-wt\n");

			const result = resolveGitDir("/test/project");

			expect(result).toBe("/repo/.git/worktrees/my-wt");
		});

		it("should resolve gitdir from .git file with relative path", () => {
			vi.mocked(statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof statSync>);
			vi.mocked(readFileSync).mockReturnValue("gitdir: ../.git/worktrees/my-wt\n");

			const result = resolveGitDir("/test/project");

			// Path separator is platform-dependent (\ on Windows, / elsewhere) — normalize for comparison.
			expect(result.replace(/\\/g, "/")).toContain(".git/worktrees/my-wt");
		});

		it("should fall back to .git path when .git file has no gitdir line", () => {
			vi.mocked(statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof statSync>);
			vi.mocked(readFileSync).mockReturnValue("some random content\n");

			const result = resolveGitDir("/test/project");

			expect(result).toContain(".git");
		});
	});

	describe("detectCommitOperation", () => {
		const CWD = "/test/project";

		it("should detect rebase via GIT_REFLOG_ACTION", () => {
			process.env.GIT_REFLOG_ACTION = "rebase (pick)";

			const result = detectCommitOperation(CWD);

			expect(result).toEqual({ type: "rebase" });
		});

		it("should detect rebase via filesystem (rebase-merge dir)", () => {
			// existsSync returns true for rebase-merge path
			vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith("rebase-merge"));

			const result = detectCommitOperation(CWD);

			expect(result).toEqual({ type: "rebase" });
		});

		it("should detect squash via squash-pending.json", () => {
			vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith("squash-pending.json"));

			const result = detectCommitOperation(CWD);

			expect(result.type).toBe("squash");
			expect(result.squashPendingPath).toContain("squash-pending.json");
		});

		it("should detect amend via reflog subject", () => {
			vi.mocked(execSync).mockReturnValueOnce("commit (amend): fix typo\n");

			const result = detectCommitOperation(CWD);

			expect(result).toEqual({ type: "amend" });
		});

		it("should detect cherry-pick via GIT_REFLOG_ACTION", () => {
			process.env.GIT_REFLOG_ACTION = "cherry-pick";

			const result = detectCommitOperation(CWD);

			expect(result).toEqual({ type: "cherry-pick" });
		});

		it("should detect revert via GIT_REFLOG_ACTION", () => {
			process.env.GIT_REFLOG_ACTION = "revert";

			const result = detectCommitOperation(CWD);

			expect(result).toEqual({ type: "revert" });
		});

		it("should default to commit when nothing else matches", () => {
			// execSync returns normal commit reflog
			vi.mocked(execSync).mockReturnValueOnce("commit: add feature\n");

			const result = detectCommitOperation(CWD);

			expect(result).toEqual({ type: "commit" });
		});

		it("should default to commit when reflog read fails", () => {
			vi.mocked(execSync).mockImplementationOnce(() => {
				throw new Error("reflog empty");
			});

			const result = detectCommitOperation(CWD);

			expect(result).toEqual({ type: "commit" });
		});
	});
});

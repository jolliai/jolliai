import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** NUL byte separator — git ls-tree -z uses \0 instead of \n between entries. */
const NUL = "\x00";

/**
 * Mock strategy:
 *
 * - `execGit` uses promisified `execFile` → mocked via `mockExecFileAsync`
 *   (returned by our fake `promisify`).
 * - `execGitWithStdin` uses `spawn` → mocked via `mockSpawn`, which
 *   returns a fake ChildProcess with stdin/stdout/stderr EventEmitters.
 *   Results are queued with `mockSpawnSuccess` / `mockSpawnFailure`.
 */
const { mockExecFileAsync, mockSpawn } = vi.hoisted(() => ({
	mockExecFileAsync: vi.fn(),
	mockSpawn: vi.fn(),
}));

vi.mock("node:util", () => ({
	promisify: vi.fn(() => mockExecFileAsync),
}));

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
	spawn: mockSpawn,
}));

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import {
	batchReadFilesFromBranch,
	ensureOrphanBranch,
	execGit,
	getCommitInfo,
	getCommitRange,
	getCurrentBranch,
	getDefaultBranch,
	getDiffContent,
	getDiffStats,
	getGitCommonDir,
	getHeadCommitInfo,
	getHeadHash,
	getLastReflogAction,
	getParentHash,
	getProjectRootDir,
	getRepoContributors,
	getStagedDiffStats,
	getTreeHash,
	getWorkingTreeDiffStats,
	isAncestor,
	isInsideGitRepo,
	listFilesInBranch,
	listWorktrees,
	orphanBranchExists,
	readFileFromBranch,
	readOrigHead,
	resolveGitHooksDir,
	writeFileToBranch,
	writeMultipleFilesToBranch,
} from "./GitOps.js";

/** Queue a successful git response (for execGit → promisified execFile) */
function mockSuccess(stdout: string, stderr = ""): void {
	mockExecFileAsync.mockResolvedValueOnce({ stdout, stderr });
}

/** Queue a failed git response (for execGit → promisified execFile) */
function mockFailure(code: number | string, stderr: string, stdout = ""): void {
	const error = new Error(stderr) as Error & {
		code: number | string;
		stdout: string;
		stderr: string;
	};
	error.code = code;
	error.stdout = stdout;
	error.stderr = stderr;
	mockExecFileAsync.mockRejectedValueOnce(error);
}

/**
 * Queue a successful spawn result (for execGitWithStdin → spawn).
 * Creates a fake ChildProcess that emits stdout data and close(0).
 */
function mockSpawnSuccess(stdout: string): void {
	mockSpawn.mockImplementationOnce(() => {
		// stdin is itself an EventEmitter so production code that attaches
		// `proc.stdin.on('error', ...)` doesn't blow up on these mocks. `write`
		// returns true (buffer not full) so the backpressure-aware writer in
		// runFastImport streams straight through without awaiting a `drain`
		// that these one-shot mocks never emit.
		const stdin = Object.assign(new EventEmitter(), { write: vi.fn().mockReturnValue(true), end: vi.fn() });
		const proc = Object.assign(new EventEmitter(), {
			stdin,
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
		});
		// Fire events after listeners are attached (next microtask)
		queueMicrotask(() => {
			proc.stdout.emit("data", Buffer.from(stdout));
			proc.emit("close", 0);
		});
		return proc;
	});
}

/**
 * Queue a failed spawn result (for execGitWithStdin → spawn).
 * Creates a fake ChildProcess that emits stderr data and close(exitCode).
 */
function mockSpawnFailure(exitCode: number, stderr: string): void {
	mockSpawn.mockImplementationOnce(() => {
		// stdin is itself an EventEmitter so production code that attaches
		// `proc.stdin.on('error', ...)` doesn't blow up on these mocks. `write`
		// returns true (buffer not full) so the backpressure-aware writer in
		// runFastImport streams straight through without awaiting a `drain`
		// that these one-shot mocks never emit.
		const stdin = Object.assign(new EventEmitter(), { write: vi.fn().mockReturnValue(true), end: vi.fn() });
		const proc = Object.assign(new EventEmitter(), {
			stdin,
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
		});
		queueMicrotask(() => {
			proc.stderr.emit("data", Buffer.from(stderr));
			proc.emit("close", exitCode);
		});
		return proc;
	});
}

/**
 * Queue a successful spawn that emits stdout in caller-controlled chunks.
 * Used by `batchReadFilesFromBranch` tests where the parser's correctness
 * depends on handling chunk boundaries (header / body split across `data`
 * events). Chunks are emitted in order on the same tick.
 */
function mockSpawnStreamingSuccess(chunks: ReadonlyArray<Buffer | string>): void {
	mockSpawn.mockImplementationOnce(() => {
		// stdin is itself an EventEmitter so production code that attaches
		// `proc.stdin.on('error', ...)` doesn't blow up on these mocks. `write`
		// returns true (buffer not full) so the backpressure-aware writer in
		// runFastImport streams straight through without awaiting a `drain`
		// that these one-shot mocks never emit.
		const stdin = Object.assign(new EventEmitter(), { write: vi.fn().mockReturnValue(true), end: vi.fn() });
		const proc = Object.assign(new EventEmitter(), {
			stdin,
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
		});
		queueMicrotask(() => {
			for (const chunk of chunks) {
				proc.stdout.emit("data", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			proc.emit("close", 0);
		});
		return proc;
	});
}

describe("GitOps", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		// Re-suppress console after reset
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	describe("execGit", () => {
		it("should execute git commands and return result", async () => {
			mockSuccess("abc123\n");
			const result = await execGit(["rev-parse", "HEAD"]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("abc123");
		});

		it("should pass cwd via the spawn options bag (not the git -C flag)", async () => {
			// Originally `execGit` injected `-C <cwd>` into argv. After PR #149
			// it routes `cwd` through `child_process`'s options bag instead —
			// equivalent behavior on disk, but keeps the path string out of
			// argv and silences CodeQL's `js/shell-command-constructed-from-input`.
			mockSuccess("main\n");
			await execGit(["branch"], "/my/project");
			expect(mockExecFileAsync).toHaveBeenCalledWith(
				"git",
				["branch"],
				expect.objectContaining({ maxBuffer: expect.any(Number), cwd: "/my/project" }),
			);
		});

		it("should handle command failure", async () => {
			mockFailure(128, "fatal: not a git repository");
			const result = await execGit(["status"]);
			expect(result.exitCode).toBe(128);
			expect(result.stderr).toContain("not a git repository");
		});

		it("should handle ENOENT (git not found)", async () => {
			mockFailure("ENOENT", "");
			const result = await execGit(["status"]);
			expect(result.exitCode).toBe(127);
		});

		it("should handle generic error code as exit code 1", async () => {
			const error = new Error("unknown") as Error & {
				code: undefined;
				stdout: string;
				stderr: string;
			};
			error.code = undefined;
			error.stdout = "";
			error.stderr = "some error";
			mockExecFileAsync.mockRejectedValueOnce(error);
			const result = await execGit(["status"]);
			expect(result.exitCode).toBe(1);
		});

		it("should fall back to the error message when stdout and stderr are missing", async () => {
			const error = new Error("message only") as Error & {
				code?: number | string;
				stdout?: string;
				stderr?: string;
			};
			delete error.code;
			delete error.stdout;
			delete error.stderr;
			mockExecFileAsync.mockRejectedValueOnce(error);

			const result = await execGit(["status"]);

			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("message only");
			expect(result.exitCode).toBe(1);
		});
	});

	describe("getHeadCommitInfo", () => {
		it("should parse commit info from git log", async () => {
			mockSuccess("abc123def456\n");
			mockSuccess("abc123def456\x00Fix login bug\x00John Doe\x002026-02-19T10:00:00+08:00");

			const info = await getHeadCommitInfo();
			expect(info.hash).toBe("abc123def456");
			expect(info.message).toBe("Fix login bug");
			expect(info.author).toBe("John Doe");
			expect(info.date).toBe("2026-02-19T10:00:00+08:00");
		});

		it("should throw on git failure for rev-parse", async () => {
			mockFailure(128, "fatal: not a git repository");
			await expect(getHeadCommitInfo()).rejects.toThrow("Failed to get HEAD hash");
		});

		it("should throw on git log failure", async () => {
			mockSuccess("abc123def456\n");
			mockFailure(128, "fatal: bad object");
			await expect(getHeadCommitInfo()).rejects.toThrow("Failed to get commit info");
		});

		it("should throw on unexpected log format", async () => {
			mockSuccess("abc123def456\n");
			mockSuccess("incomplete-output");
			await expect(getHeadCommitInfo()).rejects.toThrow("Unexpected git log format");
		});
	});

	describe("getDiffContent", () => {
		it("should return diff content", async () => {
			mockSuccess("diff --git a/file.ts b/file.ts\n+added line\n");
			const diff = await getDiffContent("HEAD~1", "HEAD");
			expect(diff).toContain("added line");
		});

		it("returns the full diff when it fits the default budget", async () => {
			// Default budget is 150_000 chars; a 50K diff must come back intact,
			// not truncated to the old 30K cap that silently dropped most files.
			const diff = "x".repeat(50000);
			mockSuccess(diff);
			const result = await getDiffContent("HEAD~1", "HEAD");
			expect(result).toBe(diff);
		});

		it("truncates a diff that exceeds the lowered 150K default budget", async () => {
			// No explicit maxChars → the default applies. At 160K the diff must come
			// back truncated with the --stat header; if the default were still the
			// old 200K this 160K body would pass through intact, failing this test.
			// Lowering the default keeps a whole-tree squash regenerate's prompt
			// inside the LLM wall-clock budget instead of aborting mid-flight.
			const body = "z".repeat(160000);
			const stat = " a.ts | 9 +++\n 1 file changed, 9 insertions(+)\n";
			mockSuccess(body); // git diff <range>
			mockSuccess(stat); // git diff --stat <range>
			const result = await getDiffContent("HEAD~1", "HEAD");
			expect(result.length).toBeLessThanOrEqual(150000);
			expect(result).toContain("1 file changed");
			expect(result).toContain("truncated");
		});

		it("prepends the full --stat file list and stays within budget when the diff exceeds maxChars", async () => {
			// A naive substring would drop the tail — for a large commit the LLM
			// would only see the first few alphabetical files and summarise them as
			// if they were the whole change. Prepend the complete file list so every
			// file stays visible, then fill the remaining budget with the head of
			// the body.
			const body = "x".repeat(50000);
			const stat =
				" cli/src/Types.ts | 50 +++---\n vscode/src/Foo.ts | 30 ++--\n 82 files changed, 2931 insertions(+), 6279 deletions(-)\n";
			mockSuccess(body); // git diff <range>
			mockSuccess(stat); // git diff --stat <range>
			const result = await getDiffContent("HEAD~1", "HEAD", undefined, 10000);
			expect(result).toContain("82 files changed"); // stat summary present
			expect(result).toContain("cli/src/Types.ts"); // every file still listed
			expect(result).toContain("vscode/src/Foo.ts");
			expect(result.length).toBeLessThanOrEqual(10000); // stays within budget
			expect(result).toContain("x"); // some body still included
		});

		it("still returns the truncated body head with a marker when the --stat call fails", async () => {
			const body = "y".repeat(50000);
			mockSuccess(body); // git diff <range>
			mockFailure(1, "stat boom"); // git diff --stat fails
			const result = await getDiffContent("HEAD~1", "HEAD", undefined, 10000);
			expect(result.length).toBeLessThanOrEqual(10000);
			expect(result).toContain("y"); // body head still present
			expect(result).toContain("truncated"); // truncation marker still present
		});

		it("should fallback to empty tree diff when main diff fails", async () => {
			mockFailure(128, "fatal: bad revision");
			mockSuccess("4b825dc642cb6eb9a060e54bf899d8b2516d6faa\n");
			mockSuccess("diff --git a/new.ts\n+new file content\n");

			const diff = await getDiffContent("HEAD~1", "HEAD");
			expect(diff).toContain("new file content");
		});
	});

	describe("getDiffStats", () => {
		it("should parse diff stat output", async () => {
			mockSuccess(" file.ts | 10 ++++---\n 3 files changed, 45 insertions(+), 12 deletions(-)\n");
			const stats = await getDiffStats("HEAD~1", "HEAD");
			expect(stats.filesChanged).toBe(3);
			expect(stats.insertions).toBe(45);
			expect(stats.deletions).toBe(12);
		});

		it("should handle empty diff stats", async () => {
			mockSuccess("");
			const stats = await getDiffStats("HEAD~1", "HEAD");
			expect(stats.filesChanged).toBe(0);
			expect(stats.insertions).toBe(0);
			expect(stats.deletions).toBe(0);
		});
	});

	describe("getStagedDiffStats", () => {
		it("parses a staged diff summary line", async () => {
			mockSuccess(" file.ts | 10 ++++---\n 2 files changed, 14 insertions(+), 3 deletions(-)\n");
			const stats = await getStagedDiffStats("/repo");
			expect(stats).toEqual({ filesChanged: 2, insertions: 14, deletions: 3 });
			expect(mockExecFileAsync).toHaveBeenCalledWith(
				"git",
				["diff", "--stat", "--cached"],
				expect.objectContaining({ cwd: "/repo" }),
			);
		});

		it("returns zeros when nothing is staged", async () => {
			mockSuccess("");
			const stats = await getStagedDiffStats("/repo");
			expect(stats).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
		});
	});

	describe("getWorkingTreeDiffStats", () => {
		it("diffs the given paths against HEAD and parses the summary line", async () => {
			mockSuccess(" a.ts | 4 ++--\n b.ts | 6 +++---\n 2 files changed, 5 insertions(+), 5 deletions(-)\n");
			const stats = await getWorkingTreeDiffStats(["a.ts", "b.ts"], "/repo");
			expect(stats).toEqual({ filesChanged: 2, insertions: 5, deletions: 5 });
			expect(mockExecFileAsync).toHaveBeenCalledWith(
				"git",
				["diff", "--stat", "HEAD", "--", "a.ts", "b.ts"],
				expect.objectContaining({ cwd: "/repo" }),
			);
		});

		it("short-circuits to zeros without invoking git for an empty path list", async () => {
			const stats = await getWorkingTreeDiffStats([], "/repo");
			expect(stats).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
			expect(mockExecFileAsync).not.toHaveBeenCalled();
		});

		it("returns zeros when the selected paths have no changes", async () => {
			mockSuccess("");
			const stats = await getWorkingTreeDiffStats(["a.ts"], "/repo");
			expect(stats).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
		});

		it("counts untracked selected files' additions on top of the tracked diff", async () => {
			mockSuccess(" a.ts | 4 ++--\n 1 file changed, 2 insertions(+), 1 deletion(-)\n"); // diff --stat HEAD
			mockSuccess("new.ts\nlogo.png\n"); // ls-files --others (two untracked)
			mockSuccess("12\t0\tnew.ts\n"); // numstat new.ts → +12
			mockSuccess("-\t-\tlogo.png\n"); // numstat binary → additions "-" skipped, still counts as a file
			const stats = await getWorkingTreeDiffStats(["a.ts", "new.ts", "logo.png"], "/repo");
			// tracked (1 file, +2, −1) + 2 untracked files, +12 additions from the text one
			expect(stats).toEqual({ filesChanged: 3, insertions: 14, deletions: 1 });
			expect(mockExecFileAsync).toHaveBeenCalledWith(
				"git",
				["ls-files", "--others", "--exclude-standard", "--", "a.ts", "new.ts", "logo.png"],
				expect.objectContaining({ cwd: "/repo" }),
			);
			expect(mockExecFileAsync).toHaveBeenCalledWith(
				"git",
				["diff", "--no-index", "--numstat", "--", "/dev/null", "new.ts"],
				expect.objectContaining({ cwd: "/repo" }),
			);
		});

		it("returns only the tracked stats when the selection has no untracked files", async () => {
			mockSuccess(" a.ts | 4 ++--\n 1 file changed, 2 insertions(+), 1 deletion(-)\n"); // diff --stat HEAD
			mockSuccess(""); // ls-files --others → none
			const stats = await getWorkingTreeDiffStats(["a.ts"], "/repo");
			expect(stats).toEqual({ filesChanged: 1, insertions: 2, deletions: 1 });
		});
	});

	describe("getCommitInfo", () => {
		it("should parse commit info for a given hash", async () => {
			mockSuccess("abc123def456\x00Fix login bug\x00John Doe\x002026-02-19T10:00:00+08:00");

			const info = await getCommitInfo("abc123def456");
			expect(info.hash).toBe("abc123def456");
			expect(info.message).toBe("Fix login bug");
			expect(info.author).toBe("John Doe");
			expect(info.date).toBe("2026-02-19T10:00:00+08:00");
		});

		it("should pass the given hash as an argument to git log", async () => {
			mockSuccess("abc123def456\x00Fix bug\x00John\x002026-02-19T10:00:00+08:00");

			await getCommitInfo("abc123def456", "/my/project");
			expect(mockExecFileAsync).toHaveBeenCalledWith(
				"git",
				expect.arrayContaining(["abc123def456"]),
				expect.any(Object),
			);
		});

		it("should throw on git log failure", async () => {
			mockFailure(128, "fatal: bad object abc123");
			await expect(getCommitInfo("abc123")).rejects.toThrow("Failed to get commit info for abc123");
		});

		it("should throw on unexpected log format (too few parts)", async () => {
			mockSuccess("incomplete-output");
			await expect(getCommitInfo("abc123")).rejects.toThrow("Unexpected git log format for abc123");
		});
	});

	describe("getCurrentBranch", () => {
		it("should return branch name", async () => {
			mockSuccess("feature/my-branch\n");
			const branch = await getCurrentBranch();
			expect(branch).toBe("feature/my-branch");
		});

		it("should throw on failure", async () => {
			mockFailure(128, "fatal: not a git repo");
			await expect(getCurrentBranch()).rejects.toThrow("Failed to get current branch");
		});
	});

	describe("getDefaultBranch", () => {
		it("returns the branch from origin/HEAD, stripping the origin/ prefix", async () => {
			mockSuccess("origin/develop\n");
			expect(await getDefaultBranch()).toBe("develop");
		});

		it("falls back to main when origin/HEAD is unset", async () => {
			mockFailure(128, "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref");
			expect(await getDefaultBranch()).toBe("main");
		});

		it("falls back to main when origin/HEAD resolves empty", async () => {
			mockSuccess("\n");
			expect(await getDefaultBranch()).toBe("main");
		});
	});

	describe("getRepoContributors", () => {
		it("dedupes by lowercased email, tallies counts, sorts most-commits-first", async () => {
			mockSuccess(
				[
					`Ada Lovelace\x00ada@example.com`,
					`A. Lovelace\x00ADA@example.com`,
					`Grace Hopper\x00grace@example.com`,
					`Ada Lovelace\x00ada@example.com`,
				].join("\n"),
			);
			const contributors = await getRepoContributors();
			expect(contributors).toEqual([
				{ name: "Ada Lovelace", email: "ada@example.com", commitCount: 3 },
				{ name: "Grace Hopper", email: "grace@example.com", commitCount: 1 },
			]);
		});

		it("keeps the most recent non-empty name across renames (git log is newest-first)", async () => {
			mockSuccess(
				[
					`\x00bob@example.com`, // newest commit, empty name → fall through
					`Bob Smith\x00bob@example.com`, // current display name (most recent non-empty)
					`bob-old\x00bob@example.com`, // oldest name — must not win
				].join("\n"),
			);
			expect(await getRepoContributors()).toEqual([
				{ name: "Bob Smith", email: "bob@example.com", commitCount: 3 },
			]);
		});

		it("returns [] when git log fails (e.g. outside a work tree)", async () => {
			mockFailure(128, "fatal: not a git repository");
			expect(await getRepoContributors()).toEqual([]);
		});

		it("returns [] for a repo with no commits (empty stdout)", async () => {
			mockSuccess("");
			expect(await getRepoContributors()).toEqual([]);
		});

		it("filters out non-deliverable placeholder emails (GitHub noreply)", async () => {
			mockSuccess(
				[
					`Ada Lovelace\x00ada@example.com`,
					`Bot\x0049699333+dependabot[bot]@users.noreply.github.com`,
					`Ghost\x00noreply@github.com`,
					`No Reply\x00no-reply@example.com`,
				].join("\n"),
			);
			expect(await getRepoContributors()).toEqual([
				{ name: "Ada Lovelace", email: "ada@example.com", commitCount: 1 },
			]);
		});

		it("skips lines with no email and tolerates an empty name", async () => {
			mockSuccess([`malformed-no-nul-line`, `\x00solo@example.com`].join("\n"));
			expect(await getRepoContributors()).toEqual([{ name: "", email: "solo@example.com", commitCount: 1 }]);
		});

		it("caps the result at max", async () => {
			mockSuccess([`A\x00a@x.com`, `B\x00b@x.com`, `C\x00c@x.com`].join("\n"));
			expect(await getRepoContributors(undefined, 2)).toHaveLength(2);
		});
	});

	describe("orphanBranchExists", () => {
		it("should return true when branch exists", async () => {
			mockSuccess("abc123\n");
			const exists = await orphanBranchExists("my-branch");
			expect(exists).toBe(true);
		});

		it("should return false when branch does not exist", async () => {
			mockFailure(128, "fatal: not a valid ref");
			const exists = await orphanBranchExists("nonexistent");
			expect(exists).toBe(false);
		});
	});

	// --- Orphan branch operations ---
	// writeBlob and writeTree now use spawn (via execGitWithStdin),
	// while other git commands still use promisified execFile.

	describe("ensureOrphanBranch", () => {
		it("should skip creation when branch already exists", async () => {
			mockSuccess("abc123\n"); // rev-parse --verify succeeds
			await ensureOrphanBranch("test-branch");
			expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it("should create branch when it does not exist", async () => {
			// 1. orphanBranchExists → rev-parse fails (execGit)
			mockFailure(128, "not a valid ref");
			// 2. writeBlob → hash-object -w --stdin (spawn)
			mockSpawnSuccess("blob_hash_123\n");
			// 3. writeTree → mktree (spawn)
			mockSpawnSuccess("tree_hash_456\n");
			// 4. commit-tree (execGit)
			mockSuccess("commit_hash_789\n");
			// 5. update-ref (execGit)
			mockSuccess("\n");

			await ensureOrphanBranch("new-branch");
			expect(mockExecFileAsync).toHaveBeenCalledTimes(3);
			expect(mockSpawn).toHaveBeenCalledTimes(2);
		});

		it("should pass cwd to spawn-based commands when provided", async () => {
			// 1. orphanBranchExists → rev-parse fails (execGit with cwd)
			mockFailure(128, "not a valid ref");
			// 2. writeBlob → hash-object (spawn with cwd)
			mockSpawnSuccess("blob_hash_cwd\n");
			// 3. writeTree → mktree (spawn with cwd)
			mockSpawnSuccess("tree_hash_cwd\n");
			// 4. commit-tree (execGit with cwd)
			mockSuccess("commit_hash_cwd\n");
			// 5. update-ref (execGit with cwd)
			mockSuccess("\n");

			await ensureOrphanBranch("new-branch", "/my/project");

			// `cwd` now rides the spawn options bag, not argv. The git command
			// itself (`hash-object -w --stdin`) lives in argv unchanged.
			expect(mockSpawn).toHaveBeenCalledWith(
				"git",
				expect.any(Array),
				expect.objectContaining({ cwd: "/my/project" }),
			);
		});

		it("should throw on commit-tree failure", async () => {
			mockFailure(128, "not a valid ref"); // orphanBranchExists
			mockSpawnSuccess("blob_hash\n"); // writeBlob (spawn)
			mockSpawnSuccess("tree_hash\n"); // writeTree (spawn)
			mockFailure(128, "commit-tree failed"); // commit-tree fails

			await expect(ensureOrphanBranch("bad")).rejects.toThrow("Failed to create commit");
		});

		it("should throw on update-ref failure", async () => {
			mockFailure(128, "not a valid ref"); // orphanBranchExists
			mockSpawnSuccess("blob_hash\n"); // writeBlob (spawn)
			mockSpawnSuccess("tree_hash\n"); // writeTree (spawn)
			mockSuccess("commit_hash\n"); // commit-tree
			mockFailure(128, "update-ref failed"); // update-ref fails

			await expect(ensureOrphanBranch("bad")).rejects.toThrow("Failed to update ref");
		});

		it("should throw when writeBlob fails via spawn", async () => {
			mockFailure(128, "not a valid ref"); // orphanBranchExists
			mockSpawnFailure(128, "hash-object error"); // writeBlob fails

			await expect(ensureOrphanBranch("bad")).rejects.toThrow("hash-object failed");
		});

		it("should throw when writeTree fails via spawn", async () => {
			mockFailure(128, "not a valid ref"); // orphanBranchExists
			mockSpawnSuccess("blob_hash\n"); // writeBlob ok
			mockSpawnFailure(128, "mktree error"); // writeTree fails

			await expect(ensureOrphanBranch("bad")).rejects.toThrow("mktree failed");
		});
	});

	describe("readFileFromBranch", () => {
		it("should return file content when it exists", async () => {
			mockSuccess('{"version": 1}');
			const content = await readFileFromBranch("branch", "index.json");
			expect(content).toBe('{"version": 1}');
		});

		it("should return null when file does not exist", async () => {
			mockFailure(128, "fatal: Path does not exist");
			const content = await readFileFromBranch("branch", "nonexistent.json");
			expect(content).toBeNull();
		});
	});

	describe("writeFileToBranch", () => {
		it("should write a flat file to existing branch", async () => {
			// ensureOrphanBranch: branch already exists (execGit)
			mockSuccess("abc\n"); // orphanBranchExists → rev-parse
			// Get branch tip (execGit)
			mockSuccess("parent_hash\n");
			// Get current tree (execGit)
			mockSuccess("root_tree\n");
			// writeBlob (spawn)
			mockSpawnSuccess("new_blob\n");
			// replaceInTree → ls-tree -z root_tree (execGit)
			mockSuccess(`100644 blob old\tindex.json${NUL}`);
			// replaceInTree → writeTree (spawn)
			mockSpawnSuccess("new_root_tree\n");
			// commit-tree (execGit)
			mockSuccess("new_commit\n");
			// update-ref (execGit)
			mockSuccess("\n");

			await writeFileToBranch("branch", "test.json", "{}", "Add test.json");
			expect(mockExecFileAsync).toHaveBeenCalledTimes(6);
			expect(mockSpawn).toHaveBeenCalledTimes(2);
		});

		it("should handle nested file paths (new subdirectory)", async () => {
			// ensureOrphanBranch: branch exists (execGit)
			mockSuccess("abc\n");
			// Get tip (execGit)
			mockSuccess("parent\n");
			// Get tree (execGit)
			mockSuccess("root_tree\n");
			// writeBlob (spawn)
			mockSpawnSuccess("new_blob\n");
			// updateTreeWithFile("summaries/abc.json"):
			//   ls-tree root_tree summaries/ → not found (execGit)
			mockSuccess("");
			//   writeTree("") → empty subtree (spawn)
			mockSpawnSuccess("empty_sub\n");
			//   recursive: replaceInTree(empty_sub, "abc.json", blob)
			//     ls-tree -z empty_sub → empty (execGit)
			mockSuccess("");
			//     writeTree → new subtree (spawn)
			mockSpawnSuccess("new_sub\n");
			//   replaceInTree(root_tree, "summaries", tree)
			//     ls-tree -z root_tree (execGit)
			mockSuccess(`100644 blob idx\tindex.json${NUL}`);
			//     writeTree → new root (spawn)
			mockSpawnSuccess("new_root\n");
			// commit-tree (execGit)
			mockSuccess("new_commit\n");
			// update-ref (execGit)
			mockSuccess("\n");

			await writeFileToBranch("branch", "summaries/abc.json", "{}", "Add");
			expect(mockExecFileAsync).toHaveBeenCalledTimes(8);
			expect(mockSpawn).toHaveBeenCalledTimes(4);
		});

		it("should handle nested paths with existing subdirectory", async () => {
			mockSuccess("abc123\n"); // orphanBranchExists (execGit)
			mockSuccess("aabbcc\n"); // tip (execGit)
			mockSuccess("ddeeff\n"); // tree root_tree (execGit)
			mockSpawnSuccess("ff0011\n"); // writeBlob (spawn)
			// ls-tree for "summaries/" → directory exists (execGit)
			mockSuccess("040000 tree aabb11\tsummaries\n");
			// recursive: replaceInTree(aabb11, "abc.json")
			mockSuccess(`100644 blob cc2233\texisting.json${NUL}`); // ls-tree -z aabb11 (execGit)
			mockSpawnSuccess("dd4455\n"); // writeTree (updated subtree) (spawn)
			// replaceInTree(ddeeff, "summaries") (execGit)
			mockSuccess(`040000 tree aabb11\tsummaries${NUL}100644 blob ee6677\tindex.json${NUL}`);
			mockSpawnSuccess("ff8899\n"); // writeTree (new root) (spawn)
			mockSuccess("001122\n"); // commit-tree (execGit)
			mockSuccess("\n"); // update-ref (execGit)

			await writeFileToBranch("branch", "summaries/abc.json", "{}", "Add");
			expect(mockExecFileAsync).toHaveBeenCalledTimes(8);
			expect(mockSpawn).toHaveBeenCalledTimes(3);
		});

		it("should throw on failed tip rev-parse", async () => {
			mockSuccess("abc\n"); // orphanBranchExists
			mockFailure(128, "fatal: bad ref"); // tip rev-parse fails

			await expect(writeFileToBranch("branch", "test.json", "{}", "msg")).rejects.toThrow(
				"Failed to get branch tip",
			);
		});

		it("should throw on failed tree rev-parse", async () => {
			mockSuccess("abc\n"); // orphanBranchExists
			mockSuccess("parent\n"); // tip
			mockFailure(128, "fatal: bad tree"); // tree rev-parse fails

			await expect(writeFileToBranch("branch", "test.json", "{}", "msg")).rejects.toThrow("Failed to get tree");
		});

		it("should throw on commit-tree failure", async () => {
			mockSuccess("abc\n"); // orphanBranchExists (execGit)
			mockSuccess("parent\n"); // tip (execGit)
			mockSuccess("root_tree\n"); // tree (execGit)
			mockSpawnSuccess("new_blob\n"); // writeBlob (spawn)
			mockSuccess(""); // ls-tree -z (execGit)
			mockSpawnSuccess("new_root\n"); // writeTree (spawn)
			mockFailure(128, "commit-tree error"); // commit-tree fails (execGit)

			await expect(writeFileToBranch("branch", "test.json", "{}", "msg")).rejects.toThrow(
				"Failed to create commit",
			);
		});

		it("should throw on update-ref failure", async () => {
			mockSuccess("abc\n"); // orphanBranchExists (execGit)
			mockSuccess("parent\n"); // tip (execGit)
			mockSuccess("root_tree\n"); // tree (execGit)
			mockSpawnSuccess("new_blob\n"); // writeBlob (spawn)
			mockSuccess(""); // ls-tree -z (execGit)
			mockSpawnSuccess("new_root\n"); // writeTree (spawn)
			mockSuccess("new_commit\n"); // commit-tree (execGit)
			mockFailure(128, "update-ref error"); // update-ref fails (execGit)

			await expect(writeFileToBranch("branch", "test.json", "{}", "msg")).rejects.toThrow("Failed to update ref");
		});
	});

	describe("listFilesInBranch", () => {
		it("should return file list", async () => {
			mockSuccess(`summaries/hash1.json${NUL}summaries/hash2.json${NUL}`);
			const files = await listFilesInBranch("branch", "summaries/");
			expect(files).toEqual(["summaries/hash1.json", "summaries/hash2.json"]);
		});

		it("should return empty array when branch does not exist", async () => {
			mockFailure(128, "not valid ref");
			const files = await listFilesInBranch("nonexistent", "summaries/");
			expect(files).toEqual([]);
		});

		it("should return empty array for empty listing", async () => {
			mockSuccess("");
			const files = await listFilesInBranch("branch", "summaries/");
			expect(files).toEqual([]);
		});
	});

	describe("batchReadFilesFromBranch", () => {
		// The cat-file --batch protocol per response:
		//     "<sha> blob <byte-len>\n" + <byte-len bytes of body> + "\n"
		// or for a missing entry:
		//     "<request> missing\n"   (no body, no trailing LF beyond the header)
		// These helpers assemble those byte sequences so individual tests stay
		// focused on the parsing behavior under test instead of protocol
		// boilerplate.
		function buildHeader(sha: string, size: number): string {
			return `${sha} blob ${size}\n`;
		}
		function buildResponse(sha: string, body: string): Buffer {
			const bodyBuf = Buffer.from(body, "utf8");
			return Buffer.concat([
				Buffer.from(buildHeader(sha, bodyBuf.length), "utf8"),
				bodyBuf,
				Buffer.from("\n", "utf8"),
			]);
		}

		function getSpawnStdinWrites(callIndex = 0): ReadonlyArray<string> {
			const proc = mockSpawn.mock.results[callIndex].value;
			return (proc.stdin.write.mock.calls as ReadonlyArray<[unknown]>).map((call) => String(call[0]));
		}

		it("returns an empty map and does not spawn when the path list is empty", async () => {
			const result = await batchReadFilesFromBranch("branch", []);
			expect(result.size).toBe(0);
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it("reads a single file via cat-file --batch and returns its content", async () => {
			mockSpawnStreamingSuccess([buildResponse("aaaaaaaa", "hello world")]);

			const result = await batchReadFilesFromBranch("branch", ["summaries/a.json"]);

			expect(result.get("summaries/a.json")).toBe("hello world");
			expect(mockSpawn).toHaveBeenCalledWith(
				"git",
				expect.arrayContaining(["cat-file", "--batch"]),
				expect.any(Object),
			);
			// Verify that the request was written using the <branch>:<path> form.
			expect(getSpawnStdinWrites()).toEqual(["branch:summaries/a.json\n"]);
		});

		it("preserves request ordering across multiple files in one batch", async () => {
			mockSpawnStreamingSuccess([
				buildResponse("aaa", "first"),
				buildResponse("bbb", "second"),
				buildResponse("ccc", "third"),
			]);

			const result = await batchReadFilesFromBranch("branch", ["p/1", "p/2", "p/3"]);

			expect(result.get("p/1")).toBe("first");
			expect(result.get("p/2")).toBe("second");
			expect(result.get("p/3")).toBe("third");
		});

		it("maps missing entries to null while keeping found entries in the same call", async () => {
			mockSpawnStreamingSuccess([
				buildResponse("aaa", "exists"),
				Buffer.from("branch:missing/file.json missing\n", "utf8"),
				buildResponse("ccc", "also exists"),
			]);

			const result = await batchReadFilesFromBranch("branch", ["found/a", "missing/file.json", "found/b"]);

			expect(result.get("found/a")).toBe("exists");
			expect(result.get("missing/file.json")).toBeNull();
			expect(result.get("found/b")).toBe("also exists");
		});

		it("parses correctly when stdout chunks split header from body", async () => {
			// The parser's state machine has to ride out a `data` event that ends
			// mid-record. Split one full response into two arbitrary halves: the
			// header + first byte of body in chunk 1, the rest of the body and
			// trailing LF in chunk 2.
			const full = buildResponse("aaa", "split across chunks");
			const split = Math.floor(full.length / 3);
			mockSpawnStreamingSuccess([full.subarray(0, split), full.subarray(split)]);

			const result = await batchReadFilesFromBranch("branch", ["p"]);

			expect(result.get("p")).toBe("split across chunks");
		});

		it("parses correctly when a chunk ends exactly at the header's terminating LF", async () => {
			// Edge case: the OS pipe write boundary lands exactly after the
			// header's LF and before the first body byte. Hits the
			// `bytesRemaining > 0 && pending.length === 0` early-return inside
			// the body branch — without that guard the parser would call
			// `pending.subarray(0, take)` with `take=0` and emit an empty body.
			const body = "01234567";
			const header = Buffer.from(`aaa blob ${body.length}\n`, "utf8");
			mockSpawnStreamingSuccess([header, Buffer.from(`${body}\n`, "utf8")]);

			const result = await batchReadFilesFromBranch("branch", ["p"]);

			expect(result.get("p")).toBe(body);
		});

		it("parses correctly when the body is split across multiple chunks", async () => {
			// Header arrives in full, then body comes in two halves. Exercises
			// the `bytesRemaining > 0; return` early-exit that keeps the parser
			// waiting for more body bytes without re-entering the header phase.
			const body = "0123456789ABCDEFGHIJ"; // 20 bytes
			const header = Buffer.from(`aaa blob ${body.length}\n`, "utf8");
			const halfPoint = 8;
			mockSpawnStreamingSuccess([
				Buffer.concat([header, Buffer.from(body.substring(0, halfPoint), "utf8")]),
				Buffer.from(body.substring(halfPoint), "utf8"),
				Buffer.from("\n", "utf8"), // trailing LF alone in its own chunk
			]);

			const result = await batchReadFilesFromBranch("branch", ["p"]);

			expect(result.get("p")).toBe(body);
		});

		it("ignores stderr emissions while still resolving on a zero exit code", async () => {
			// git can print informational messages to stderr (e.g. warnings)
			// without failing. The accumulator captures them so that a later
			// non-zero exit can surface them, but a successful close path must
			// still resolve normally regardless of stderr content.
			mockSpawn.mockImplementationOnce(() => {
				const stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
				const proc = Object.assign(new EventEmitter(), {
					stdin,
					stdout: new EventEmitter(),
					stderr: new EventEmitter(),
				});
				queueMicrotask(() => {
					proc.stderr.emit("data", Buffer.from("warning: harmless\n"));
					proc.stdout.emit("data", buildResponse("aaa", "ok"));
					proc.emit("close", 0);
				});
				return proc;
			});

			const result = await batchReadFilesFromBranch("branch", ["p"]);
			expect(result.get("p")).toBe("ok");
		});

		it("parses correctly when one stdout chunk packs multiple responses", async () => {
			// Concatenate three responses into one buffer to simulate the case
			// where cat-file flushes several entries in a single OS-level pipe write.
			mockSpawnStreamingSuccess([
				Buffer.concat([buildResponse("a", "one"), buildResponse("b", "two"), buildResponse("c", "three")]),
			]);

			const result = await batchReadFilesFromBranch("branch", ["p1", "p2", "p3"]);

			expect(result.get("p1")).toBe("one");
			expect(result.get("p2")).toBe("two");
			expect(result.get("p3")).toBe("three");
		});

		it("uses byte length (not character length) when consuming UTF-8 bodies", async () => {
			// "é" is two UTF-8 bytes; if the parser used string-length it would
			// truncate the body or mis-frame the next response.
			mockSpawnStreamingSuccess([buildResponse("aaa", "café")]);

			const result = await batchReadFilesFromBranch("branch", ["p"]);

			expect(result.get("p")).toBe("café");
		});

		it("handles zero-byte bodies correctly", async () => {
			// Empty blob: header says size 0, no body bytes, single trailing LF.
			mockSpawnStreamingSuccess([Buffer.from("aaa blob 0\n\n", "utf8")]);

			const result = await batchReadFilesFromBranch("branch", ["p"]);

			expect(result.get("p")).toBe("");
		});

		it("propagates cwd via spawn's options bag (not as `git -C` in argv)", async () => {
			mockSpawnStreamingSuccess([buildResponse("a", "x")]);

			await batchReadFilesFromBranch("branch", ["p"], "/some/repo");

			expect(mockSpawn).toHaveBeenCalledWith(
				"git",
				expect.arrayContaining(["cat-file", "--batch"]),
				expect.objectContaining({ cwd: "/some/repo" }),
			);
		});

		it("rejects (not crash) when stdin emits EPIPE because cat-file exited early", async () => {
			// Regression guard: without the `proc.stdin.on('error', ...)` handler,
			// EPIPE from an early subprocess exit becomes an unhandled stream
			// error and Node 22 terminates the process. We stand up a stdin that
			// emits "error" instead of accepting writes, and assert the helper's
			// promise rejects with that exact error.
			const epipeError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
			mockSpawn.mockImplementationOnce(() => {
				const stdin = new EventEmitter() as EventEmitter & { write: typeof vi.fn; end: typeof vi.fn };
				stdin.write = vi.fn();
				stdin.end = vi.fn();
				const proc = Object.assign(new EventEmitter(), {
					stdin,
					stdout: new EventEmitter(),
					stderr: new EventEmitter(),
				});
				queueMicrotask(() => {
					stdin.emit("error", epipeError);
				});
				return proc;
			});

			await expect(batchReadFilesFromBranch("branch", ["p"])).rejects.toThrow("write EPIPE");
		});
	});

	describe("writeMultipleFilesToBranch (fast-import path)", () => {
		// The fast-import-based implementation always issues exactly one spawn
		// (the import itself); the four execFile calls are the branch-existence
		// probe inside ensureOrphanBranch, the parent rev-parse, and the two
		// `git var` lookups for author/committer identity. This helper joins all
		// stdin chunks written to that single spawn so the assertions below can
		// pattern-match against the actual fast-import protocol text.
		function captureFastImportStdin(spawnCallIndex = 0): string {
			const proc = mockSpawn.mock.results[spawnCallIndex].value;
			const chunks = proc.stdin.write.mock.calls as ReadonlyArray<[unknown]>;
			const buffers = chunks.map((call) => {
				const arg = call[0];
				if (Buffer.isBuffer(arg)) return arg;
				return Buffer.from(String(arg), "utf8");
			});
			return Buffer.concat(buffers).toString("utf8");
		}

		// Convenience: queue the four execGit responses every successful call
		// resolves (orphan probe → tip rev-parse → author ident → committer
		// ident) and queue a successful spawn for fast-import.
		function mockHappyPathPreamble(parent: string): void {
			mockSuccess("abc\n"); // ensureOrphanBranch → orphanBranchExists rev-parse
			mockSuccess(`${parent}\n`); // tip rev-parse
			mockSuccess("Alice <alice@example.com> 1700000000 +0000\n"); // GIT_AUTHOR_IDENT
			mockSuccess("Alice <alice@example.com> 1700000000 +0000\n"); // GIT_COMMITTER_IDENT
		}

		it("streams blob + commit records for multiple writes in a single spawn", async () => {
			mockHappyPathPreamble("parent_hash");
			mockSpawnSuccess("");

			await writeMultipleFilesToBranch(
				"branch",
				[
					{ path: "summaries/abc123.json", content: '{"summary": true}' },
					{ path: "index.json", content: '{"version": 1}' },
				],
				"Add summary and update index",
			);

			// fast-import + the four read-only execGit calls listed in
			// mockHappyPathPreamble. The historical pipeline issued 9 execGits
			// and 6 spawns for the same input — see commit history of this file.
			expect(mockSpawn).toHaveBeenCalledTimes(1);
			expect(mockExecFileAsync).toHaveBeenCalledTimes(4);
			expect(mockSpawn).toHaveBeenCalledWith(
				"git",
				expect.arrayContaining(["fast-import", "--quiet", "--done"]),
				expect.any(Object),
			);

			const stream = captureFastImportStdin();
			// Two blobs, each with its own mark, in declaration order.
			expect(stream).toContain("blob\nmark :1\ndata 17\n"); // '{"summary": true}'
			expect(stream).toContain('{"summary": true}');
			expect(stream).toContain("blob\nmark :2\ndata 14\n"); // '{"version": 1}'
			expect(stream).toContain('{"version": 1}');
			// Commit record targets the right ref, chains onto our observed parent,
			// and references the marks above by index in declaration order.
			expect(stream).toContain("commit refs/heads/branch\n");
			expect(stream).toContain("author Alice <alice@example.com> 1700000000 +0000\n");
			expect(stream).toContain("committer Alice <alice@example.com> 1700000000 +0000\n");
			expect(stream).toContain("from parent_hash\n");
			expect(stream).toContain("M 100644 :1 summaries/abc123.json\n");
			expect(stream).toContain("M 100644 :2 index.json\n");
			expect(stream).toMatch(/done\n$/);
		});

		it("emits a single blob and one M directive for the simplest single-file write", async () => {
			mockHappyPathPreamble("parent_hash");
			mockSpawnSuccess("");

			await writeMultipleFilesToBranch("branch", [{ path: "test.json", content: "{}" }], "msg");

			const stream = captureFastImportStdin();
			expect(stream).toContain("blob\nmark :1\ndata 2\n");
			expect(stream).toContain("M 100644 :1 test.json\n");
			expect(stream).not.toContain("\nD ");
		});

		it("emits only D directives (no blob records) when the batch is delete-only", async () => {
			mockHappyPathPreamble("parent_hash");
			mockSpawnSuccess("");

			await writeMultipleFilesToBranch(
				"branch",
				[
					{ path: "transcripts/hash.json", content: "", delete: true },
					{ path: "summaries/old.json", content: "", delete: true },
				],
				"Delete two files",
			);

			const stream = captureFastImportStdin();
			expect(stream).not.toContain("blob\n");
			expect(stream).not.toContain("\nM ");
			expect(stream).toContain("D transcripts/hash.json\n");
			expect(stream).toContain("D summaries/old.json\n");
		});

		it("interleaves write and delete entries in a single commit record", async () => {
			mockHappyPathPreamble("parent_hash");
			mockSpawnSuccess("");

			await writeMultipleFilesToBranch(
				"branch",
				[
					{ path: "summaries/new.json", content: '{"v": 5}' },
					{ path: "transcripts/old.json", content: "", delete: true },
				],
				"Mixed batch",
			);

			const stream = captureFastImportStdin();
			// One blob for the write, no blob for the delete.
			expect(stream).toContain("blob\nmark :1\n");
			// Commit body has both M and D directives.
			expect(stream).toContain("M 100644 :1 summaries/new.json\n");
			expect(stream).toContain("D transcripts/old.json\n");
		});

		it("produces an empty-tree commit when the file list is empty", async () => {
			mockHappyPathPreamble("parent_hash");
			mockSpawnSuccess("");

			await writeMultipleFilesToBranch("branch", [], "Empty batch");

			const stream = captureFastImportStdin();
			expect(stream).not.toContain("blob\n");
			expect(stream).not.toContain("\nM ");
			expect(stream).not.toContain("\nD ");
			// Commit + parent are still emitted, so the resulting commit replays
			// the parent tree unchanged — same as the historical behavior.
			expect(stream).toContain("commit refs/heads/branch\n");
			expect(stream).toContain("from parent_hash\n");
			expect(stream).toMatch(/done\n$/);
		});

		it("uses Buffer.byteLength when computing data sizes so multi-byte UTF-8 is preserved", async () => {
			mockHappyPathPreamble("parent_hash");
			mockSpawnSuccess("");

			// 'é' is two UTF-8 bytes; using string.length would emit `data 1`
			// and corrupt the blob. We assert on the byte count via the protocol.
			await writeMultipleFilesToBranch("branch", [{ path: "x.txt", content: "é" }], "utf-8");

			const stream = captureFastImportStdin();
			expect(stream).toContain("data 2\n");
		});

		it("propagates cwd via spawn's options bag for both execGit and the fast-import spawn", async () => {
			mockHappyPathPreamble("parent_hash");
			mockSpawnSuccess("");

			await writeMultipleFilesToBranch("branch", [{ path: "test.json", content: "{}" }], "msg", "/some/repo");

			expect(mockSpawn).toHaveBeenCalledWith(
				"git",
				expect.arrayContaining(["fast-import", "--quiet", "--done"]),
				expect.objectContaining({ cwd: "/some/repo" }),
			);
		});

		it("throws when the parent rev-parse fails before fast-import is spawned", async () => {
			mockSuccess("abc\n"); // ensureOrphanBranch
			mockFailure(128, "fatal: bad ref"); // tip rev-parse

			await expect(
				writeMultipleFilesToBranch("branch", [{ path: "test.json", content: "{}" }], "msg"),
			).rejects.toThrow("Failed to get branch tip");
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it("throws when GIT_AUTHOR_IDENT cannot be resolved", async () => {
			mockSuccess("abc\n"); // ensureOrphanBranch
			mockSuccess("parent\n"); // tip
			mockFailure(128, "fatal: empty ident name"); // git var GIT_AUTHOR_IDENT

			await expect(
				writeMultipleFilesToBranch("branch", [{ path: "test.json", content: "{}" }], "msg"),
			).rejects.toThrow("Failed to read GIT_AUTHOR_IDENT");
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it("throws when GIT_COMMITTER_IDENT cannot be resolved", async () => {
			mockSuccess("abc\n"); // ensureOrphanBranch
			mockSuccess("parent\n"); // tip
			mockSuccess("Alice <alice@example.com> 1700000000 +0000\n"); // GIT_AUTHOR_IDENT
			mockFailure(128, "fatal: empty ident email"); // GIT_COMMITTER_IDENT

			await expect(
				writeMultipleFilesToBranch("branch", [{ path: "test.json", content: "{}" }], "msg"),
			).rejects.toThrow("Failed to read GIT_COMMITTER_IDENT");
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it("surfaces fast-import's exit code and stderr when the subprocess fails", async () => {
			mockHappyPathPreamble("parent_hash");
			mockSpawnFailure(128, "fatal: Unsupported command: gibberish");

			await expect(
				writeMultipleFilesToBranch("branch", [{ path: "test.json", content: "{}" }], "msg"),
			).rejects.toThrow(/git fast-import failed.*Unsupported command/);
		});

		it("rejects (not crash) when stdin emits EPIPE during the streaming writes", async () => {
			// Same regression guard as `batchReadFilesFromBranch` — the
			// streaming-write helper must attach `proc.stdin.on('error', ...)`
			// or async EPIPEs (fast-import OOM / bad `from <parent>` /
			// signal during the body write) become unhandled stream errors
			// that crash the Node process. We swap in a stdin that emits
			// "error" instead of accepting writes and assert the promise
			// rejects cleanly.
			mockHappyPathPreamble("parent_hash");
			const epipeError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
			mockSpawn.mockImplementationOnce(() => {
				const stdin = new EventEmitter() as EventEmitter & { write: typeof vi.fn; end: typeof vi.fn };
				stdin.write = vi.fn();
				stdin.end = vi.fn();
				const proc = Object.assign(new EventEmitter(), {
					stdin,
					stdout: new EventEmitter(),
					stderr: new EventEmitter(),
				});
				queueMicrotask(() => {
					stdin.emit("error", epipeError);
				});
				return proc;
			});

			await expect(
				writeMultipleFilesToBranch("branch", [{ path: "test.json", content: "{}" }], "msg"),
			).rejects.toThrow("write EPIPE");
		});

		it("honors backpressure: waits for 'drain' when stdin.write reports the buffer is full", async () => {
			// The streaming writer must pause on `write() === false` and resume on
			// the next `drain` rather than queuing every chunk in memory. Here the
			// first chunk reports the buffer full; the writer awaits `drain`, then
			// streams the rest and finishes. If backpressure were mishandled the
			// promise would hang (write returned false, no further progress).
			mockHappyPathPreamble("parent_hash");
			mockSpawn.mockImplementationOnce(() => {
				const stdin = Object.assign(new EventEmitter(), {
					// Buffer full on the first chunk, fine for every chunk after.
					write: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
					end: vi.fn(),
				});
				const proc = Object.assign(new EventEmitter(), {
					stdin,
					stdout: new EventEmitter(),
					stderr: new EventEmitter(),
				});
				queueMicrotask(() => {
					// Release the awaited `drain`, then let fast-import exit cleanly.
					stdin.emit("drain");
					queueMicrotask(() => proc.emit("close", 0));
				});
				return proc;
			});

			await expect(
				writeMultipleFilesToBranch(
					"branch",
					[
						{ path: "a.json", content: '{"a":1}' },
						{ path: "b.json", content: '{"b":2}' },
					],
					"msg",
				),
			).resolves.toBeUndefined();

			// Writing continued past the drain (more than the single full chunk).
			const proc = mockSpawn.mock.results[0].value;
			expect(proc.stdin.write.mock.calls.length).toBeGreaterThan(1);
		});

		it("C-style-quotes an M-directive path containing a double-quote or newline", async () => {
			// fast-import REQUIRES quoting when a path contains LF or starts with
			// a quote; an unquoted such path would split the directive / corrupt
			// the stream. Program-generated paths never hit this, but the writer
			// must stay correct for arbitrary paths.
			mockHappyPathPreamble("parent_hash");
			mockSpawnSuccess("");

			await writeMultipleFilesToBranch("branch", [{ path: 'a"b\nc.json', content: "{}" }], "msg");

			const stream = captureFastImportStdin();
			// `"` → `\"`, LF → `\n`, wrapped in double-quotes. The directive stays
			// on one line because the embedded newline is now escaped.
			expect(stream).toContain('M 100644 :1 "a\\"b\\nc.json"\n');
		});

		it("leaves an ordinary (quote/newline-free) path unquoted in the M directive", async () => {
			mockHappyPathPreamble("parent_hash");
			mockSpawnSuccess("");

			await writeMultipleFilesToBranch("branch", [{ path: "summaries/abc.json", content: "{}" }], "msg");

			const stream = captureFastImportStdin();
			expect(stream).toContain("M 100644 :1 summaries/abc.json\n");
		});
	});

	describe("getTreeHash", () => {
		it("should extract the tree hash from cat-file output", async () => {
			mockSuccess("tree abcdef1234567890\nparent 1234567890abcdef\nauthor Jane <jane@example.com> 0 +0000\n");
			await expect(getTreeHash("commit123")).resolves.toBe("abcdef1234567890");
		});

		it("should return null when cat-file fails", async () => {
			mockFailure(128, "fatal: Not a valid object name");
			await expect(getTreeHash("missing")).resolves.toBeNull();
		});

		it("should return null when cat-file output has no tree line", async () => {
			mockSuccess("author Jane <jane@example.com> 0 +0000\ncommitter Jane <jane@example.com> 0 +0000\n");
			await expect(getTreeHash("weird")).resolves.toBeNull();
		});
	});

	// ── Reset-squash helper functions ────────────────────────────────────

	describe("getLastReflogAction", () => {
		it("should return the reflog description on success", async () => {
			mockSuccess("reset: moving to HEAD~3\n");
			const action = await getLastReflogAction("/test/repo");
			expect(action).toBe("reset: moving to HEAD~3");
		});

		it("should return empty string on failure", async () => {
			mockFailure(128, "fatal: reflog is empty");
			const action = await getLastReflogAction("/test/repo");
			expect(action).toBe("");
		});

		it("should return empty string when reflog output is empty", async () => {
			mockSuccess("");
			const action = await getLastReflogAction("/test/repo");
			expect(action).toBe("");
		});
	});

	describe("readOrigHead", () => {
		it("should return the ORIG_HEAD hash on success", async () => {
			mockSuccess("abc123def456abc123def456abc123def456abc1\n");
			const hash = await readOrigHead("/test/repo");
			expect(hash).toBe("abc123def456abc123def456abc123def456abc1");
		});

		it("should return null when ORIG_HEAD does not exist", async () => {
			mockFailure(128, "fatal: bad revision 'ORIG_HEAD'");
			const hash = await readOrigHead("/test/repo");
			expect(hash).toBeNull();
		});

		it("should return null when result is empty", async () => {
			mockSuccess("");
			const hash = await readOrigHead("/test/repo");
			expect(hash).toBeNull();
		});
	});

	describe("isAncestor", () => {
		it("should return true when ancestor relationship holds", async () => {
			mockSuccess("");
			const result = await isAncestor("abc123", "def456", "/test/repo");
			expect(result).toBe(true);
		});

		it("should return false when not an ancestor", async () => {
			mockFailure(1, "");
			const result = await isAncestor("abc123", "def456", "/test/repo");
			expect(result).toBe(false);
		});
	});

	describe("getHeadHash", () => {
		it("should return trimmed HEAD hash", async () => {
			mockSuccess("abc123def456\n");
			const hash = await getHeadHash();
			expect(hash).toBe("abc123def456");
		});

		it("should throw on failure", async () => {
			mockFailure(128, "fatal: not a git repo");
			await expect(getHeadHash()).rejects.toThrow("Failed to get HEAD hash");
		});
	});

	describe("getParentHash", () => {
		it("should return trimmed parent hash", async () => {
			mockSuccess("parent123\n");
			const hash = await getParentHash();
			expect(hash).toBe("parent123");
		});

		it("should return null when HEAD has no parent (first commit)", async () => {
			mockFailure(128, "fatal: bad revision");
			const hash = await getParentHash();
			expect(hash).toBeNull();
		});

		it("should return null when stdout is empty", async () => {
			mockSuccess("");
			const hash = await getParentHash();
			expect(hash).toBeNull();
		});
	});

	describe("getCommitRange", () => {
		it("should return commit hashes in the range", async () => {
			mockSuccess("aaa111\nbbb222\nccc333\n");
			const hashes = await getCommitRange("from", "to", "/test/repo");
			expect(hashes).toEqual(["aaa111", "bbb222", "ccc333"]);
		});

		it("should return empty array when range is empty", async () => {
			mockSuccess("");
			const hashes = await getCommitRange("same", "same", "/test/repo");
			expect(hashes).toEqual([]);
		});

		it("should return empty array on failure", async () => {
			mockFailure(128, "fatal: bad revision");
			const hashes = await getCommitRange("bad", "ref", "/test/repo");
			expect(hashes).toEqual([]);
		});
	});

	describe("getGitCommonDir", () => {
		it("should return the .git directory for a regular repo", async () => {
			mockSuccess(".git\n");
			const commonDir = await getGitCommonDir("/my/project");
			expect(commonDir).toBe(resolve("/my/project", ".git"));
		});

		it("should resolve a relative path against cwd", async () => {
			// Worktrees return a relative path like "../../.git" or an absolute path.
			// Verify that relative paths are resolved against the provided cwd.
			mockSuccess("../../.git\n");
			const commonDir = await getGitCommonDir("/repo/worktrees/wt-1");
			expect(commonDir).toBe(resolve("/repo/worktrees/wt-1", "../../.git"));
		});

		it("should return an absolute path unchanged when git returns one", async () => {
			mockSuccess("/absolute/path/to/.git\n");
			const commonDir = await getGitCommonDir("/my/project");
			expect(commonDir).toBe(resolve("/my/project", "/absolute/path/to/.git"));
		});

		it("should throw on failure", async () => {
			mockFailure(128, "fatal: not a git repository");
			await expect(getGitCommonDir("/not/a/repo")).rejects.toThrow("Failed to get git common dir");
		});
	});

	describe("getProjectRootDir", () => {
		it("should return the parent of the git common dir", async () => {
			mockSuccess(".git\n");
			const rootDir = await getProjectRootDir("/my/project");
			expect(rootDir).toBe(resolve("/my/project"));
		});

		it("should resolve worktree common dir to main repo root", async () => {
			mockSuccess("../../.git\n");
			const rootDir = await getProjectRootDir("/repo/worktrees/wt-1");
			expect(rootDir).toBe(resolve("/repo/worktrees/wt-1", "../.."));
		});
	});

	describe("isInsideGitRepo", () => {
		it("returns true inside a normal work tree", async () => {
			mockSuccess(".git");
			expect(await isInsideGitRepo("/main/repo")).toBe(true);
		});

		it("returns true for a bare repo hosting linked worktrees (git-dir resolves)", async () => {
			mockSuccess("/some/bare.git");
			expect(await isInsideGitRepo("/some/bare")).toBe(true);
		});

		it("returns false (never throws) outside a repo", async () => {
			mockFailure(128, "fatal: not a git repository (or any of the parent directories): .git");
			expect(await isInsideGitRepo("/not/a/repo")).toBe(false);
		});
	});

	describe("listWorktrees", () => {
		it("should return at least the main worktree", async () => {
			mockSuccess("worktree /main/repo\nHEAD abc123\nbranch refs/heads/main\n");
			const worktrees = await listWorktrees("/main/repo");
			expect(worktrees.length).toBeGreaterThanOrEqual(1);
			expect(worktrees[0]).toBe("/main/repo");
		});

		it("should return multiple worktrees when they exist", async () => {
			mockSuccess(
				"worktree /main/repo\nHEAD abc123\nbranch refs/heads/main\n\n" +
					"worktree /main/worktrees/feature-a\nHEAD def456\nbranch refs/heads/feature/feature-a\n",
			);
			const worktrees = await listWorktrees("/main/repo");
			expect(worktrees).toEqual(["/main/repo", "/main/worktrees/feature-a"]);
		});

		it("should throw on failure", async () => {
			mockFailure(128, "fatal: not a git repository");
			await expect(listWorktrees("/not/a/repo")).rejects.toThrow("Failed to list worktrees");
		});
	});

	// resolveGitHooksDir uses real fs, so these tests use actual temp directories.
	describe("resolveGitHooksDir", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "jm-gitops-hooks-test-"));
		});

		afterEach(async () => {
			await rm(tempDir, { recursive: true, force: true });
		});

		it("should return <projectDir>/.git/hooks for a regular repo (directory .git)", async () => {
			// Regular repo: .git is a directory
			await mkdir(join(tempDir, ".git", "hooks"), { recursive: true });

			const hooksDir = await resolveGitHooksDir(tempDir);
			expect(hooksDir).toBe(join(tempDir, ".git", "hooks"));
		});

		it("should resolve hooks from a worktree (gitdir pointing into .git/worktrees/)", async () => {
			// Worktree: .git is a file pointing to a worktrees/<name> directory
			const mainDotGit = join(tempDir, "main-repo", ".git");
			const worktreeDir = join(tempDir, "wt", "feature");
			const worktreeGitDir = join(mainDotGit, "worktrees", "feature");

			// Set up the main repo's .git structure
			await mkdir(join(mainDotGit, "hooks"), { recursive: true });
			await mkdir(worktreeGitDir, { recursive: true });

			// Create the worktree directory with .git as a file
			await mkdir(worktreeDir, { recursive: true });
			await writeFile(join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf-8");

			const hooksDir = await resolveGitHooksDir(worktreeDir);
			// Hooks should point to the main repo's .git/hooks (not .git/worktrees/feature/hooks)
			expect(hooksDir).toBe(join(mainDotGit, "hooks"));
		});

		it("should resolve hooks from a non-worktree gitlink (gitdir without /worktrees/ segment)", async () => {
			// Non-worktree gitlink: .git is a file pointing directly to a bare git dir
			const bareGitDir = join(tempDir, "bare.git");
			const projectDir = join(tempDir, "project");

			await mkdir(join(bareGitDir, "hooks"), { recursive: true });
			await mkdir(projectDir, { recursive: true });
			// .git file points to a bare git dir (no /worktrees/ path segment)
			await writeFile(join(projectDir, ".git"), `gitdir: ${bareGitDir}\n`, "utf-8");

			const hooksDir = await resolveGitHooksDir(projectDir);
			// For a non-worktree gitlink, hooks are inside the resolved gitdir
			expect(hooksDir).toBe(join(bareGitDir, "hooks"));
		});

		it("should throw when a gitlink file is malformed", async () => {
			const projectDir = join(tempDir, "project");
			await mkdir(projectDir, { recursive: true });
			await writeFile(join(projectDir, ".git"), "not-a-gitdir-pointer\n", "utf-8");

			await expect(resolveGitHooksDir(projectDir)).rejects.toThrow("Unexpected .git file content");
		});
	});

	describe("spawn-backed git helpers", () => {
		it("should reject when spawn emits an error event", async () => {
			mockFailure(128, "not a valid ref");
			mockSpawn.mockImplementationOnce(() => {
				const proc = Object.assign(new EventEmitter(), {
					stdin: { write: vi.fn(), end: vi.fn() },
					stdout: new EventEmitter(),
					stderr: new EventEmitter(),
				});
				queueMicrotask(() => {
					proc.emit("error", new Error("spawn failed"));
				});
				return proc;
			});

			await expect(ensureOrphanBranch("broken-branch")).rejects.toThrow("spawn failed");
		});

		it("should throw when existing subtree metadata is malformed", async () => {
			mockSuccess("abc\n");
			mockSuccess("parent\n");
			mockSuccess("root_tree\n");
			mockSpawnSuccess("new_blob\n");
			mockSuccess("not-a-tree-line\n");

			await expect(writeFileToBranch("branch", "summaries/abc.json", "{}", "Add")).rejects.toThrow(
				"Unexpected ls-tree output",
			);
		});
	});
});

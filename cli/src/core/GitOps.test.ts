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
	ensureOrphanBranch,
	execGit,
	getCommitInfo,
	getCommitRange,
	getCurrentBranch,
	getDiffContent,
	getDiffStats,
	getGitCommonDir,
	getHeadCommitInfo,
	getHeadHash,
	getLastReflogAction,
	getParentHash,
	getProjectRootDir,
	getTreeHash,
	isAncestor,
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
		const proc = Object.assign(new EventEmitter(), {
			stdin: { write: vi.fn(), end: vi.fn() },
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
		const proc = Object.assign(new EventEmitter(), {
			stdin: { write: vi.fn(), end: vi.fn() },
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

		it("should pass cwd via -C flag", async () => {
			mockSuccess("main\n");
			await execGit(["branch"], "/my/project");
			expect(mockExecFileAsync).toHaveBeenCalledWith(
				"git",
				["-C", "/my/project", "branch"],
				expect.objectContaining({ maxBuffer: expect.any(Number) }),
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

		it("should truncate diff to maxChars", async () => {
			const longDiff = "x".repeat(50000);
			mockSuccess(longDiff);
			const diff = await getDiffContent("HEAD~1", "HEAD", undefined, 100);
			expect(diff.length).toBe(100);
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

			// Verify spawn was called with -C flag for cwd
			expect(mockSpawn).toHaveBeenCalledWith(
				"git",
				expect.arrayContaining(["-C", "/my/project"]),
				expect.any(Object),
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

	describe("writeMultipleFilesToBranch", () => {
		it("should write multiple files in a single commit", async () => {
			// ensureOrphanBranch: branch already exists (execGit)
			mockSuccess("abc\n"); // orphanBranchExists → rev-parse
			// Get branch tip (execGit)
			mockSuccess("parent_hash\n");
			// Get current tree (execGit)
			mockSuccess("root_tree\n");

			// --- File 1: nested path "summaries/abc123.json" ---
			// writeBlob (spawn)
			mockSpawnSuccess("blob_summary\n");
			// updateTreeWithFile → ls-tree root_tree summaries → not found (execGit)
			mockSuccess("");
			// writeTree("") → empty subtree (spawn)
			mockSpawnSuccess("empty_sub\n");
			// replaceInTree(empty_sub, "abc123.json") → ls-tree -z (execGit)
			mockSuccess("");
			// writeTree → new subtree (spawn)
			mockSpawnSuccess("new_sub\n");
			// replaceInTree(root_tree, "summaries") → ls-tree -z (execGit)
			mockSuccess(`100644 blob idx\tindex.json${NUL}`);
			// writeTree → intermediate root (spawn)
			mockSpawnSuccess("mid_root\n");

			// --- File 2: flat path "index.json" ---
			// writeBlob (spawn)
			mockSpawnSuccess("blob_index\n");
			// replaceInTree(mid_root, "index.json") → ls-tree -z (execGit)
			mockSuccess(`100644 blob idx\tindex.json${NUL}040000 tree sub\tsummaries${NUL}`);
			// writeTree → final root (spawn)
			mockSpawnSuccess("final_root\n");

			// commit-tree (execGit)
			mockSuccess("new_commit\n");
			// update-ref (execGit)
			mockSuccess("\n");

			await writeMultipleFilesToBranch(
				"branch",
				[
					{ path: "summaries/abc123.json", content: '{"summary": true}' },
					{ path: "index.json", content: '{"version": 1}' },
				],
				"Add summary and update index",
			);

			// Single commit-tree and single update-ref
			expect(mockExecFileAsync).toHaveBeenCalledTimes(9);
			expect(mockSpawn).toHaveBeenCalledTimes(6);
		});

		it("should throw on tip failure", async () => {
			mockSuccess("abc\n"); // orphanBranchExists
			mockFailure(128, "fatal: bad ref"); // tip rev-parse fails

			await expect(
				writeMultipleFilesToBranch("branch", [{ path: "test.json", content: "{}" }], "msg"),
			).rejects.toThrow("Failed to get branch tip");
		});

		it("should throw on tree failure", async () => {
			mockSuccess("abc\n"); // orphanBranchExists
			mockSuccess("parent\n"); // tip
			mockFailure(128, "fatal: bad tree"); // tree rev-parse fails

			await expect(
				writeMultipleFilesToBranch("branch", [{ path: "test.json", content: "{}" }], "msg"),
			).rejects.toThrow("Failed to get tree");
		});

		it("should throw on commit-tree failure", async () => {
			mockSuccess("abc\n"); // orphanBranchExists
			mockSuccess("parent\n"); // tip
			mockSuccess("root_tree\n"); // tree
			mockSpawnSuccess("blob\n"); // writeBlob
			mockSuccess(""); // ls-tree -z
			mockSpawnSuccess("new_tree\n"); // writeTree
			mockFailure(128, "commit-tree error"); // commit-tree fails

			await expect(
				writeMultipleFilesToBranch("branch", [{ path: "test.json", content: "{}" }], "msg"),
			).rejects.toThrow("Failed to create commit");
		});

		it("should throw on update-ref failure", async () => {
			mockSuccess("abc\n"); // orphanBranchExists
			mockSuccess("parent\n"); // tip
			mockSuccess("root_tree\n"); // tree
			mockSpawnSuccess("blob\n"); // writeBlob
			mockSuccess(""); // ls-tree -z
			mockSpawnSuccess("new_tree\n"); // writeTree
			mockSuccess("new_commit\n"); // commit-tree
			mockFailure(128, "update-ref error"); // update-ref fails

			await expect(
				writeMultipleFilesToBranch("branch", [{ path: "test.json", content: "{}" }], "msg"),
			).rejects.toThrow("Failed to update ref");
		});

		it("should delete files and collapse empty subdirectories in a single commit", async () => {
			mockSuccess("abc\n"); // orphanBranchExists
			mockSuccess("parent\n"); // tip
			mockSuccess("root_tree\n"); // tree
			// removeFileFromTree(root_tree, "transcripts/hash.json")
			mockSuccess(
				"040000 tree aabbccddeeff00112233445566778899aabbccdd\ttranscripts\n100644 blob a1b2c3d4\tindex.json\n",
			); // ls-tree root_tree transcripts (no -z, used by removeFileFromTree regex)
			mockSuccess(`100644 blob 11223344556677889900aabbccddeeff00112233\thash.json${NUL}`); // removeFromTree ls-tree -z sub_tree
			mockSpawnSuccess("\n"); // writeTree("") => empty tree
			mockSuccess(""); // ls-tree newSubTree empty (no -z, used by removeFileFromTree)
			mockSuccess(
				`040000 tree aabbccddeeff00112233445566778899aabbccdd\ttranscripts${NUL}100644 blob a1b2c3d4\tindex.json${NUL}`,
			); // removeFromTree(root_tree, "transcripts") ls-tree -z
			mockSpawnSuccess("pruned_root\n"); // writeTree(pruned root)
			mockSuccess("new_commit\n"); // commit-tree
			mockSuccess("\n"); // update-ref

			await writeMultipleFilesToBranch(
				"branch",
				[{ path: "transcripts/hash.json", content: "", delete: true }],
				"Delete transcript",
			);

			expect(mockExecFileAsync).toHaveBeenCalledWith(
				"git",
				expect.arrayContaining(["commit-tree", "pruned_root", "-p", "parent", "-m", "Delete transcript"]),
				expect.any(Object),
			);
			expect(mockSpawn).toHaveBeenCalledTimes(2);
		});

		it("should ignore deletion when the target subdirectory does not exist", async () => {
			mockSuccess("abc\n"); // orphanBranchExists
			mockSuccess("parent\n"); // tip
			mockSuccess("root_tree\n"); // tree
			mockSuccess(""); // ls-tree root_tree missingDir
			mockSuccess("new_commit\n"); // commit-tree
			mockSuccess("\n"); // update-ref

			await writeMultipleFilesToBranch(
				"branch",
				[{ path: "missing/file.json", content: "", delete: true }],
				"Delete missing file",
			);

			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it("should ignore deletion when the subdirectory tree entry is malformed", async () => {
			mockSuccess("abc\n"); // orphanBranchExists
			mockSuccess("parent\n"); // tip
			mockSuccess("root_tree\n"); // tree
			mockSuccess("100644 blob not-a-tree\ttranscripts\n"); // ls-tree root_tree transcripts
			mockSuccess("new_commit\n"); // commit-tree
			mockSuccess("\n"); // update-ref

			await writeMultipleFilesToBranch(
				"branch",
				[{ path: "transcripts/hash.json", content: "", delete: true }],
				"Delete malformed nested file",
			);

			expect(mockSpawn).not.toHaveBeenCalled();
			expect(mockExecFileAsync).toHaveBeenCalledWith(
				"git",
				expect.arrayContaining([
					"commit-tree",
					"root_tree",
					"-p",
					"parent",
					"-m",
					"Delete malformed nested file",
				]),
				expect.any(Object),
			);
		});

		it("should delete a nested file while keeping the parent subtree when entries remain", async () => {
			mockSuccess("abc\n"); // orphanBranchExists
			mockSuccess("parent\n"); // tip
			mockSuccess("root_tree\n"); // tree
			// removeFileFromTree(root_tree, "transcripts/hash.json"):
			// 1. ls-tree root_tree transcripts (no -z, regex match)
			mockSuccess(
				"040000 tree aabbccddeeff00112233445566778899aabbccdd\ttranscripts\n100644 blob rootblob\tindex.json\n",
			);
			// 2. removeFromTree(subtree, "hash.json") → ls-tree -z subtree
			mockSuccess(
				`100644 blob 1111111111111111111111111111111111111111\thash.json${NUL}100644 blob 2222222222222222222222222222222222222222\tkeep.json${NUL}`,
			);
			// 3. writeTree(filtered entries)
			mockSpawnSuccess("trimmed_subtree\n");
			// 4. ls-tree trimmed_subtree (no -z, check if empty)
			mockSuccess("100644 blob 2222222222222222222222222222222222222222\tkeep.json\n");
			// 5. replaceInTree(root, "transcripts", tree) → ls-tree -z root
			mockSuccess(
				`040000 tree aabbccddeeff00112233445566778899aabbccdd\ttranscripts${NUL}100644 blob rootblob\tindex.json${NUL}`,
			);
			mockSpawnSuccess("updated_root\n"); // writeTree(updated root)
			mockSuccess("new_commit\n"); // commit-tree
			mockSuccess("\n"); // update-ref

			await writeMultipleFilesToBranch(
				"branch",
				[{ path: "transcripts/hash.json", content: "", delete: true }],
				"Delete nested transcript only",
			);

			expect(mockExecFileAsync).toHaveBeenCalledWith(
				"git",
				expect.arrayContaining([
					"commit-tree",
					"updated_root",
					"-p",
					"parent",
					"-m",
					"Delete nested transcript only",
				]),
				expect.any(Object),
			);
		});

		it("should ignore deletion when the target file is missing from an existing subdirectory", async () => {
			mockSuccess("abc\n"); // orphanBranchExists
			mockSuccess("parent\n"); // tip
			mockSuccess("root_tree\n"); // tree
			// removeFileFromTree(root_tree, "transcripts/hash.json"):
			// 1. ls-tree root_tree transcripts (no -z, regex)
			mockSuccess(
				"040000 tree aabbccddeeff00112233445566778899aabbccdd\ttranscripts\n100644 blob rootblob\tindex.json\n",
			);
			// 2. removeFromTree(subtree, "hash.json") → ls-tree -z — hash.json not found, no-op
			mockSuccess(`100644 blob 2222222222222222222222222222222222222222\tkeep.json${NUL}`);
			// 3. ls-tree newSubTree (no -z, check if empty) — unchanged, still non-empty
			mockSuccess("100644 blob 2222222222222222222222222222222222222222\tkeep.json\n");
			// 4. replaceInTree(root, "transcripts") → ls-tree -z root
			mockSuccess(
				`040000 tree aabbccddeeff00112233445566778899aabbccdd\ttranscripts${NUL}100644 blob rootblob\tindex.json${NUL}`,
			);
			mockSpawnSuccess("updated_root\n"); // writeTree(updated root)
			mockSuccess("new_commit\n"); // commit-tree
			mockSuccess("\n"); // update-ref

			await writeMultipleFilesToBranch(
				"branch",
				[{ path: "transcripts/hash.json", content: "", delete: true }],
				"Delete already-missing nested file",
			);

			expect(mockExecFileAsync).toHaveBeenCalledWith(
				"git",
				expect.arrayContaining([
					"commit-tree",
					"updated_root",
					"-p",
					"parent",
					"-m",
					"Delete already-missing nested file",
				]),
				expect.any(Object),
			);
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

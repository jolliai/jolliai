/**
 * Git Operations Module
 *
 * Wraps git commands using child_process.execFile.
 * Includes orphan branch operations using git plumbing commands
 * (hash-object, mktree, commit-tree, update-ref) to avoid checkout.
 *
 * Pattern adapted from: tools/jolliagent/src/tools/tools/git_shared.ts
 */

import { execFile, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../Logger.js";
import type { CommitInfo, DiffStats, FileWrite, GitCommandResult } from "../Types.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_BUFFER_BYTES = 10 * 1024 * 1024; // 10MB
/** NUL byte — used as entry separator in `git ls-tree -z` output. */
const NUL = "\x00";

const log = createLogger("GitOps");

/**
 * Executes a git command and returns the result.
 * Logs the command being executed and its outcome.
 */
export async function execGit(args: ReadonlyArray<string>, cwd?: string): Promise<GitCommandResult> {
	const fullArgs = cwd ? ["-C", cwd, ...args] : [...args];
	log.debug("git %s", fullArgs.join(" "));

	try {
		const { stdout, stderr } = await execFileAsync("git", fullArgs, {
			maxBuffer: MAX_GIT_BUFFER_BYTES,
			windowsHide: true,
		});
		const result: GitCommandResult = {
			stdout: stdout.trimEnd(),
			stderr: stderr.trim(),
			exitCode: 0,
		};
		return result;
	} catch (error: unknown) {
		const err = error as { stdout?: string; stderr?: string; code?: number | string; message?: string };
		const exitCode = typeof err.code === "number" ? err.code : err.code === "ENOENT" ? 127 : 1;
		/* v8 ignore start - defensive: null-coalescing for error properties that may be missing */
		const result: GitCommandResult = {
			stdout: (err.stdout ?? "").trimEnd(),
			stderr: (err.stderr ?? err.message ?? "").trim(),
			exitCode,
		};
		/* v8 ignore stop */
		log.debug("git command failed (exit: %d, stderr: %s)", exitCode, result.stderr.substring(0, 200));
		return result;
	}
}

/**
 * Gets information about the HEAD commit.
 */
export async function getHeadCommitInfo(cwd?: string): Promise<CommitInfo> {
	const hashResult = await execGit(["rev-parse", "HEAD"], cwd);
	if (hashResult.exitCode !== 0) {
		throw new Error(`Failed to get HEAD hash: ${hashResult.stderr}`);
	}

	// Use %x00 as delimiter for safe parsing
	const logResult = await execGit(["log", "-1", "--pretty=format:%H%x00%s%x00%an%x00%aI"], cwd);
	if (logResult.exitCode !== 0) {
		throw new Error(`Failed to get commit info: ${logResult.stderr}`);
	}

	const parts = logResult.stdout.split("\0");
	if (parts.length < 4) {
		throw new Error(`Unexpected git log format: ${logResult.stdout}`);
	}

	const info: CommitInfo = {
		hash: parts[0],
		message: parts[1],
		author: parts[2],
		date: parts[3],
	};
	log.info("HEAD commit: %s - %s", info.hash.substring(0, 8), info.message.substring(0, 60));
	return info;
}

/**
 * Returns the current HEAD commit hash (git rev-parse HEAD).
 * Used by PrepareMsgHook to record the expected parent for squash-pending validation.
 */
export async function getHeadHash(cwd?: string): Promise<string> {
	const result = await execGit(["rev-parse", "HEAD"], cwd);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to get HEAD hash: ${result.stderr}`);
	}
	return result.stdout.trim();
}

/**
 * Returns the parent hash of HEAD (git rev-parse HEAD~1).
 * Used by PostCommitHook Worker to validate squash-pending.expectedParentHash.
 * Returns null when HEAD has no parent (first commit in repo).
 */
export async function getParentHash(cwd?: string): Promise<string | null> {
	const result = await execGit(["rev-parse", "HEAD~1"], cwd);
	if (result.exitCode !== 0) {
		return null;
	}
	const hash = result.stdout.trim();
	return hash || null;
}

/**
 * Returns the description of the most recent reflog entry (git reflog -1 --format=%gs).
 * Examples: "reset: moving to HEAD~3", "commit: Fix bug", "rebase (squash): ..."
 * Returns empty string if reflog is empty or inaccessible.
 */
export async function getLastReflogAction(cwd?: string): Promise<string> {
	const result = await execGit(["reflog", "-1", "--format=%gs"], cwd);
	if (result.exitCode !== 0) {
		return "";
	}
	return result.stdout.trim();
}

/**
 * Returns the contents of ORIG_HEAD (set by git reset, merge, rebase).
 * Returns null if ORIG_HEAD does not exist (e.g. no reset has happened).
 */
export async function readOrigHead(cwd?: string): Promise<string | null> {
	const result = await execGit(["rev-parse", "ORIG_HEAD"], cwd);
	if (result.exitCode !== 0) {
		return null;
	}
	const hash = result.stdout.trim();
	return hash || null;
}

/**
 * Checks whether `ancestor` is an ancestor of `descendant` in the commit graph.
 * Uses `git merge-base --is-ancestor` (exit code 0 = yes, 1 = no).
 * Returns false if either ref is invalid.
 */
export async function isAncestor(ancestor: string, descendant: string, cwd?: string): Promise<boolean> {
	const result = await execGit(["merge-base", "--is-ancestor", ancestor, descendant], cwd);
	return result.exitCode === 0;
}

/**
 * Returns the list of commit hashes in the range (fromExclude, toInclude].
 * Uses `git rev-list fromExclude..toInclude`.
 * Returns empty array if the range is empty or either ref is invalid.
 */
export async function getCommitRange(
	fromExclude: string,
	toInclude: string,
	cwd?: string,
): Promise<ReadonlyArray<string>> {
	const result = await execGit(["rev-list", `${fromExclude}..${toInclude}`], cwd);
	if (result.exitCode !== 0 || !result.stdout.trim()) {
		return [];
	}
	return result.stdout
		.trim()
		.split("\n")
		.filter((h) => h.length > 0);
}

/**
 * Gets information about a specific commit by hash.
 * Unlike getHeadCommitInfo, this queries a specific hash rather than HEAD.
 */
export async function getCommitInfo(hash: string, cwd?: string): Promise<CommitInfo> {
	const logResult = await execGit(["log", "-1", "--pretty=format:%H%x00%s%x00%an%x00%aI", hash], cwd);
	if (logResult.exitCode !== 0) {
		throw new Error(`Failed to get commit info for ${hash}: ${logResult.stderr}`);
	}

	const parts = logResult.stdout.split("\0");
	if (parts.length < 4) {
		throw new Error(`Unexpected git log format for ${hash}: ${logResult.stdout}`);
	}

	const info: CommitInfo = {
		hash: parts[0],
		message: parts[1],
		author: parts[2],
		date: parts[3],
	};
	log.info("Commit %s: %s", info.hash.substring(0, 8), info.message.substring(0, 60));
	return info;
}

/**
 * Gets the diff content between two refs.
 * Truncates to maxChars to stay within API limits.
 */
export async function getDiffContent(fromRef: string, toRef: string, cwd?: string, maxChars = 30000): Promise<string> {
	const result = await execGit(["diff", `${fromRef}..${toRef}`], cwd);
	if (result.exitCode !== 0) {
		// For first commit, there's no parent — get the full diff
		log.warn("Diff failed, trying diff of HEAD against empty tree");
		const emptyTree = await execGit(["hash-object", "-t", "tree", "/dev/null"], cwd);
		const fallback = await execGit(["diff", emptyTree.stdout.trim(), toRef], cwd);
		const content = fallback.stdout.substring(0, maxChars);
		return content;
	}

	const content = result.stdout.substring(0, maxChars);
	return content;
}

/**
 * Gets diff statistics (files changed, insertions, deletions).
 */
export async function getDiffStats(fromRef: string, toRef: string, cwd?: string): Promise<DiffStats> {
	const result = await execGit(["diff", "--stat", `${fromRef}..${toRef}`], cwd);

	// Parse the last line like: "3 files changed, 45 insertions(+), 12 deletions(-)"
	/* v8 ignore start - defensive: split() always returns at least one element, pop() never returns undefined */
	const lastLine = result.stdout.split("\n").pop() ?? "";
	/* v8 ignore stop */
	const filesMatch = lastLine.match(/(\d+)\s+files?\s+changed/);
	const insertMatch = lastLine.match(/(\d+)\s+insertions?/);
	const deleteMatch = lastLine.match(/(\d+)\s+deletions?/);

	const stats: DiffStats = {
		filesChanged: filesMatch ? Number.parseInt(filesMatch[1], 10) : 0,
		insertions: insertMatch ? Number.parseInt(insertMatch[1], 10) : 0,
		deletions: deleteMatch ? Number.parseInt(deleteMatch[1], 10) : 0,
	};
	return stats;
}

/**
 * Gets the current branch name.
 */
export async function getCurrentBranch(cwd?: string): Promise<string> {
	const result = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to get current branch: ${result.stderr}`);
	}
	const branch = result.stdout.trim();
	return branch;
}

/**
 * Checks if an orphan branch exists.
 */
export async function orphanBranchExists(branch: string, cwd?: string): Promise<boolean> {
	const result = await execGit(["rev-parse", "--verify", `refs/heads/${branch}`], cwd);
	const exists = result.exitCode === 0;
	return exists;
}

/**
 * Creates an orphan branch using git plumbing commands.
 * This does NOT checkout the branch — it only creates the ref.
 *
 * Plumbing flow:
 *   1. Write initial content as a blob (hash-object)
 *   2. Create a tree from the blob (mktree)
 *   3. Create a commit from the tree (commit-tree)
 *   4. Point the branch ref at the commit (update-ref)
 */
export async function ensureOrphanBranch(branch: string, cwd?: string): Promise<void> {
	if (await orphanBranchExists(branch, cwd)) {
		return;
	}

	log.info("Creating orphan branch '%s' using plumbing commands", branch);

	// Step 1: Write initial index.json as a blob (via stdin pipe)
	const initialIndex = JSON.stringify({ version: 1, entries: [] }, null, "\t");
	const blobHash = await writeBlob(initialIndex, cwd);
	log.debug("Created blob: %s", blobHash);

	// Step 2: Create a tree containing the index.json file
	const treeInput = `100644 blob ${blobHash}\tindex.json\n`;
	const treeHash = await writeTree(treeInput, cwd);
	log.debug("Created tree: %s", treeHash);

	// Step 3: Create a commit with no parents (orphan)
	const commitResult = await execGit(["commit-tree", treeHash, "-m", "Initialize Jolli Memory summaries"], cwd);
	if (commitResult.exitCode !== 0) {
		throw new Error(`Failed to create commit: ${commitResult.stderr}`);
	}
	const commitHash = commitResult.stdout.trim();
	log.debug("Created commit: %s", commitHash);

	// Step 4: Point the branch at the commit
	const refResult = await execGit(["update-ref", `refs/heads/${branch}`, commitHash], cwd);
	if (refResult.exitCode !== 0) {
		throw new Error(`Failed to update ref: ${refResult.stderr}`);
	}

	log.info("Orphan branch '%s' created successfully", branch);
}

/**
 * Reads a file from a branch without checking it out.
 * Returns null if the file doesn't exist.
 */
export async function readFileFromBranch(branch: string, filePath: string, cwd?: string): Promise<string | null> {
	log.debug("Reading file from branch: %s:%s", branch, filePath);
	const result = await execGit(["show", `${branch}:${filePath}`], cwd);
	if (result.exitCode !== 0) {
		log.debug("File not found: %s:%s", branch, filePath);
		return null;
	}
	return result.stdout;
}

/**
 * Writes a file to a branch using git plumbing commands.
 * Does NOT checkout the branch — works entirely through object database.
 *
 * Strategy: Read current tree → update with new file → create new commit → update ref
 */
export async function writeFileToBranch(
	branch: string,
	filePath: string,
	content: string,
	commitMessage: string,
	cwd?: string,
): Promise<void> {
	// Ensure branch exists
	await ensureOrphanBranch(branch, cwd);

	// Get the current commit hash of the branch
	const tipResult = await execGit(["rev-parse", `refs/heads/${branch}`], cwd);
	if (tipResult.exitCode !== 0) {
		throw new Error(`Failed to get branch tip: ${tipResult.stderr}`);
	}
	const parentCommit = tipResult.stdout.trim();

	// Get the current tree
	const treeResult = await execGit(["rev-parse", `${parentCommit}^{tree}`], cwd);
	if (treeResult.exitCode !== 0) {
		throw new Error(`Failed to get tree: ${treeResult.stderr}`);
	}
	const currentTree = treeResult.stdout.trim();

	// Write the new file content as a blob
	const blobHash = await writeBlob(content, cwd);

	// Read the current tree entries and build new tree
	const newTree = await updateTreeWithFile(currentTree, filePath, blobHash, cwd);

	// Create a new commit
	const commitResult = await execGit(["commit-tree", newTree, "-p", parentCommit, "-m", commitMessage], cwd);
	if (commitResult.exitCode !== 0) {
		throw new Error(`Failed to create commit: ${commitResult.stderr}`);
	}
	const newCommit = commitResult.stdout.trim();

	// Update the branch ref
	const refResult = await execGit(["update-ref", `refs/heads/${branch}`, newCommit], cwd);
	if (refResult.exitCode !== 0) {
		throw new Error(`Failed to update ref: ${refResult.stderr}`);
	}

	log.info("File written to branch '%s' successfully (commit: %s)", branch, newCommit.substring(0, 8));
}

/**
 * Writes multiple files to a branch in a single atomic commit.
 * More efficient than calling writeFileToBranch multiple times because it
 * only performs ensureOrphanBranch, rev-parse, commit-tree, and update-ref once.
 */
export async function writeMultipleFilesToBranch(
	branch: string,
	files: ReadonlyArray<FileWrite>,
	commitMessage: string,
	cwd?: string,
): Promise<void> {
	// Ensure branch exists (single check)
	await ensureOrphanBranch(branch, cwd);

	// Get the current commit hash of the branch
	const tipResult = await execGit(["rev-parse", `refs/heads/${branch}`], cwd);
	if (tipResult.exitCode !== 0) {
		throw new Error(`Failed to get branch tip: ${tipResult.stderr}`);
	}
	const parentCommit = tipResult.stdout.trim();

	// Get the current tree
	const treeResult = await execGit(["rev-parse", `${parentCommit}^{tree}`], cwd);
	if (treeResult.exitCode !== 0) {
		throw new Error(`Failed to get tree: ${treeResult.stderr}`);
	}

	// Accumulate tree updates across all files (writes and deletes)
	let currentTree = treeResult.stdout.trim();
	for (const file of files) {
		if (file.delete) {
			currentTree = await removeFileFromTree(currentTree, file.path, cwd);
		} else {
			const blobHash = await writeBlob(file.content, cwd);
			currentTree = await updateTreeWithFile(currentTree, file.path, blobHash, cwd);
		}
	}

	// Create a single commit for all file changes
	const commitResult = await execGit(["commit-tree", currentTree, "-p", parentCommit, "-m", commitMessage], cwd);
	if (commitResult.exitCode !== 0) {
		throw new Error(`Failed to create commit: ${commitResult.stderr}`);
	}
	const newCommit = commitResult.stdout.trim();

	// Update the branch ref once
	const refResult = await execGit(["update-ref", `refs/heads/${branch}`, newCommit], cwd);
	if (refResult.exitCode !== 0) {
		throw new Error(`Failed to update ref: ${refResult.stderr}`);
	}

	const writeCount = files.filter((f) => !f.delete).length;
	const deleteCount = files.filter((f) => f.delete).length;
	log.info(
		"Updated branch '%s': %d written, %d deleted (commit: %s)",
		branch,
		writeCount,
		deleteCount,
		newCommit.substring(0, 8),
	);
}

/**
 * Returns the git tree hash for a given commit hash.
 * Two commits with identical code content have the same tree hash, enabling
 * cross-branch summary matching (e.g. GitHub squash merge vs feature branch).
 *
 * Uses `git cat-file -p <hash>` and parses the `tree <hash>` line.
 * Returns null if the commit doesn't exist or the command fails.
 */
export async function getTreeHash(commitHash: string, cwd?: string): Promise<string | null> {
	const result = await execGit(["cat-file", "-p", commitHash], cwd);
	if (result.exitCode !== 0) {
		return null;
	}
	const match = result.stdout.match(/^tree ([a-f0-9]+)/m);
	return match ? match[1] : null;
}

/**
 * Lists files in a branch under a given path prefix.
 */
export async function listFilesInBranch(branch: string, prefix: string, cwd?: string): Promise<ReadonlyArray<string>> {
	log.debug("Listing files in branch %s under prefix '%s'", branch, prefix);
	// Use -z so git outputs raw filenames (no quoting/escaping for non-ASCII names)
	const result = await execGit(["ls-tree", "-z", "-r", "--name-only", branch, prefix], cwd);
	if (result.exitCode !== 0) {
		log.debug("Failed to list files (branch may not exist): %s", result.stderr);
		return [];
	}
	const files = result.stdout.split(NUL).filter((f) => f.length > 0);
	log.debug("Found %d files", files.length);
	return files;
}

/**
 * Returns the resolved absolute path to the common git directory.
 * In a regular repo this is the `.git` folder; in a worktree it resolves to
 * the shared `.git` directory of the main repo.
 *
 * Runs `git rev-parse --git-common-dir` and resolves the result against `cwd`
 * so that relative paths (as returned inside worktrees) become absolute.
 */
export async function getGitCommonDir(cwd: string): Promise<string> {
	const result = await execGit(["rev-parse", "--git-common-dir"], cwd);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to get git common dir: ${result.stderr}`);
	}
	const dir = result.stdout.trim();
	return resolve(cwd, dir);
}

/**
 * Returns the root directory of the main repository from the git common directory.
 * For regular repos: resolves `.git` → parent directory.
 * For worktrees: resolves the shared `.git` → main repo root.
 *
 * This is the canonical location for project-scoped config files
 * (e.g., `.jolli/jollimemory/config.json`).
 */
export async function getProjectRootDir(cwd: string): Promise<string> {
	const gitCommonDir = await getGitCommonDir(cwd);
	return dirname(gitCommonDir);
}

/**
 * Returns the absolute paths of all git worktrees for the repository.
 * Parses the output of `git worktree list --porcelain` and extracts lines
 * starting with "worktree " to collect each worktree path.
 * The main worktree is always first in the returned array.
 */
export async function listWorktrees(cwd: string): Promise<ReadonlyArray<string>> {
	const result = await execGit(["worktree", "list", "--porcelain"], cwd);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to list worktrees: ${result.stderr}`);
	}
	const paths = result.stdout
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length).trim());
	return paths;
}

/**
 * Resolves the git hooks directory, handling both regular repos and worktrees.
 *
 * In a worktree, `.git` is a file containing `gitdir: <path>` pointing to the
 * actual git directory. We need to find the hooks dir in the real git directory.
 */
export async function resolveGitHooksDir(projectDir: string): Promise<string> {
	const dotGit = join(projectDir, ".git");
	const dotGitStat = await stat(dotGit);

	if (dotGitStat.isDirectory()) {
		// Regular repo: .git is a directory
		return join(dotGit, "hooks");
	}

	// Worktree: .git is a file with "gitdir: <path>"
	const content = await readFile(dotGit, "utf-8");
	const match = content.trim().match(/^gitdir:\s*(.+)$/);
	/* v8 ignore start - defensive: malformed .git file */
	if (!match) {
		throw new Error(`Unexpected .git file content: ${content.trim()}`);
	}
	/* v8 ignore stop */

	// The gitdir path may be relative or absolute
	const gitDir = match[1].trim();
	const resolvedGitDir = resolve(projectDir, gitDir);

	// For worktrees, hooks are in the common dir (parent of worktrees/)
	// e.g., gitdir: /repo/.git/worktrees/my-worktree → hooks at /repo/.git/hooks
	const worktreesIndex = resolvedGitDir.replace(/\\/g, "/").lastIndexOf("/worktrees/");
	if (worktreesIndex >= 0) {
		const commonGitDir = resolvedGitDir.substring(0, worktreesIndex);
		return join(commonGitDir, "hooks");
	}

	// Non-worktree gitlink: hooks are directly in the gitdir
	return join(resolvedGitDir, "hooks");
}

// --- Internal helpers ---

/**
 * Executes a git command with data piped to stdin via spawn.
 *
 * NOTE: We cannot use execFileAsync (promisified execFile) for this because
 * the `input` option is only supported by synchronous variants (execFileSync,
 * execSync). Using `input` with execFile silently ignores it, causing the
 * child process to hang waiting for stdin data that never arrives.
 */
function execGitWithStdin(args: ReadonlyArray<string>, input: string, cwd?: string): Promise<string> {
	const fullArgs = cwd ? ["-C", cwd, ...args] : [...args];
	log.debug("git (stdin) %s", fullArgs.join(" "));

	return new Promise((resolve, reject) => {
		const proc = spawn("git", fullArgs, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`git ${args[0]} failed (exit ${code}): ${stderr.trim()}`));
			} else {
				resolve(stdout.trim());
			}
		});

		/* v8 ignore start - spawn error only occurs if git binary is not found */
		proc.on("error", (err) => {
			reject(err);
		});
		/* v8 ignore stop */

		proc.stdin.write(input);
		proc.stdin.end();
	});
}

/**
 * Writes content as a git blob object and returns the hash.
 * Uses spawn to pipe content to git hash-object via stdin.
 */
async function writeBlob(content: string, cwd?: string): Promise<string> {
	return execGitWithStdin(["hash-object", "-w", "--stdin"], content, cwd);
}

/**
 * Creates a git tree from the provided tree-format input string.
 * Uses spawn to pipe tree entries to git mktree via stdin.
 */
async function writeTree(treeInput: string, cwd?: string): Promise<string> {
	return execGitWithStdin(["mktree"], treeInput, cwd);
}

/**
 * Updates a tree by adding/replacing a file at the given path.
 * Handles nested directories (e.g., "summaries/abc123.json").
 *
 * For a simple flat file (no '/'), modifies the tree directly.
 * For a nested path, creates subtrees recursively.
 */
async function updateTreeWithFile(
	currentTree: string,
	filePath: string,
	blobHash: string,
	cwd?: string,
): Promise<string> {
	const parts = filePath.split("/");

	if (parts.length === 1) {
		// Simple case: file in root of tree
		return await replaceInTree(currentTree, parts[0], "100644", "blob", blobHash, cwd);
	}

	// Nested case: need to handle subdirectories
	const dirName = parts[0];
	const remainingPath = parts.slice(1).join("/");

	// Get the current subtree for this directory (if it exists).
	// NOTE: Do NOT append "/" — `git ls-tree <tree> dir/` lists CONTENTS of
	// the directory (blob entries), while `git ls-tree <tree> dir` returns the
	// directory entry itself (040000 tree <hash>).
	const lsResult = await execGit(["ls-tree", currentTree, dirName], cwd);
	let subTreeHash: string;

	if (lsResult.exitCode === 0 && lsResult.stdout.trim()) {
		// Directory exists — extract its tree hash
		const match = lsResult.stdout.match(/^(\d+)\s+tree\s+([a-f0-9]+)\t/);
		/* v8 ignore start - defensive: git ls-tree should always produce a valid tree line */
		if (!match) {
			throw new Error(`Unexpected ls-tree output: ${lsResult.stdout}`);
		}
		/* v8 ignore stop */
		subTreeHash = match[2];
	} else {
		// Directory doesn't exist — create an empty tree
		subTreeHash = await writeTree("", cwd);
	}

	// Recursively update the subtree
	const newSubTree = await updateTreeWithFile(subTreeHash, remainingPath, blobHash, cwd);

	// Replace the directory entry in the parent tree
	return await replaceInTree(currentTree, dirName, "040000", "tree", newSubTree, cwd);
}

/**
 * Replaces or adds an entry in a tree object.
 * Reads the current tree, filters out the old entry, adds the new one, writes a new tree.
 */
async function replaceInTree(
	treeHash: string,
	name: string,
	mode: string,
	type: string,
	objectHash: string,
	cwd?: string,
): Promise<string> {
	// Use -z so git outputs raw filenames (no quoting/escaping for non-ASCII names)
	const lsResult = await execGit(["ls-tree", "-z", treeHash], cwd);
	const existingEntries = lsResult.stdout
		.split(NUL)
		.filter((line) => line.length > 0)
		.filter((line) => {
			// Filter out the entry we're replacing
			const entryName = line.split("\t")[1];
			return entryName !== name;
		});

	// Add the new/updated entry
	existingEntries.push(`${mode} ${type} ${objectHash}\t${name}`);

	// mktree accepts entries in any order and produces a deterministic tree hash,
	// so no explicit sorting is needed.
	const treeInput = `${existingEntries.join("\n")}\n`;
	return await writeTree(treeInput, cwd);
}

/**
 * Removes a file from a tree at the given path.
 * Handles nested directories (e.g., "transcripts/abc123.json").
 * If a subdirectory becomes empty after removal, it is also removed from its parent.
 * Returns the original tree unchanged if the file does not exist.
 */
async function removeFileFromTree(currentTree: string, filePath: string, cwd?: string): Promise<string> {
	const parts = filePath.split("/");

	if (parts.length === 1) {
		return await removeFromTree(currentTree, parts[0], cwd);
	}

	// Nested case: recurse into subdirectory
	const dirName = parts[0];
	const remainingPath = parts.slice(1).join("/");

	const lsResult = await execGit(["ls-tree", currentTree, dirName], cwd);
	if (lsResult.exitCode !== 0 || !lsResult.stdout.trim()) {
		// Directory doesn't exist — nothing to remove
		return currentTree;
	}

	const match = lsResult.stdout.match(/^(\d+)\s+tree\s+([a-f0-9]+)\t/);
	if (!match) return currentTree;
	const subTreeHash = match[2];

	const newSubTree = await removeFileFromTree(subTreeHash, remainingPath, cwd);

	// If the subtree is now empty, remove the directory entry from the parent
	const subEntries = await execGit(["ls-tree", newSubTree], cwd);
	if (subEntries.exitCode === 0 && !subEntries.stdout.trim()) {
		return await removeFromTree(currentTree, dirName, cwd);
	}

	return await replaceInTree(currentTree, dirName, "040000", "tree", newSubTree, cwd);
}

/**
 * Removes an entry from a tree object by name.
 * Returns the original tree unchanged if the entry does not exist.
 */
async function removeFromTree(treeHash: string, name: string, cwd?: string): Promise<string> {
	// Use -z so git outputs raw filenames (no quoting/escaping for non-ASCII names)
	const lsResult = await execGit(["ls-tree", "-z", treeHash], cwd);
	const entries = lsResult.stdout.split(NUL).filter((line) => line.length > 0);

	const filtered = entries.filter((line) => {
		const entryName = line.split("\t")[1];
		return entryName !== name;
	});

	// Nothing was removed — return original tree
	if (filtered.length === entries.length) return treeHash;

	if (filtered.length === 0) {
		// All entries removed — return an empty tree
		return await writeTree("", cwd);
	}

	const treeInput = `${filtered.join("\n")}\n`;
	return await writeTree(treeInput, cwd);
}

/**
 * JolliMemoryBridge
 *
 * The central bridge between the VSCode extension UI and jollimemory core.
 *
 * Architecture:
 * - enable/disable/status → direct calls to Installer functions (no CLI subprocess)
 * - All data operations (getSummary, listSummaries, transcript reading, etc.) →
 *   direct imports bundled by esbuild (ESM → CJS via esbuild)
 * - All git operations → subprocess via execGit() helper
 */

import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { lstat, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getDiffStats } from "../../cli/src/core/GitOps.js";
import type {
	LocalPushResult,
	SatelliteFile,
} from "../../cli/src/core/LocalPusher.js";
import { pushSummaryToLocal as corePushSummaryToLocal } from "../../cli/src/core/LocalPusher.js";
import {
	savePluginSource,
	saveSquashPending,
} from "../../cli/src/core/SessionTracker.js";
import { createStorage } from "../../cli/src/core/StorageFactory.js";
import type { StorageProvider } from "../../cli/src/core/StorageProvider.js";
import {
	generateCommitMessage,
	generateSquashMessage,
} from "../../cli/src/core/Summarizer.js";
import { getDisplayDate } from "../../cli/src/core/SummaryFormat.js";
import { buildMarkdown } from "../../cli/src/core/SummaryMarkdownBuilder.js";
import {
	getIndexEntryMap,
	getSummary,
	listSummaries,
	readNoteFromBranch,
	readPlanFromBranch,
	scanTreeHashAliases,
} from "../../cli/src/core/SummaryStore.js";
import {
	compareSemver,
	deriveSourceTag,
	traverseDistPaths,
} from "../../cli/src/install/DistPathResolver.js";
import {
	getStatus as installerGetStatus,
	install as installerInstall,
	uninstall as installerUninstall,
} from "../../cli/src/install/Installer.js";
import { ORPHAN_BRANCH } from "../../cli/src/Logger.js";
import type {
	CommitSummary,
	NoteFormat,
	StatusInfo,
	SummaryIndexEntry,
} from "../../cli/src/Types.js";
import { detectNotes, removeNote, saveNote } from "./core/NoteService.js";
import { detectPlans, ignorePlan } from "./core/PlanService.js";
import type {
	BranchCommit,
	BranchCommitsResult,
	CommitFileInfo,
	FileStatus,
	NoteInfo,
	PlanInfo,
} from "./Types.js";
import { mergeCommitMessages } from "./util/CommitMessageUtils.js";
import { log } from "./util/Logger.js";
import { loadGlobalConfig } from "./util/WorkspaceUtils.js";

const execFileAsync = promisify(execFile);

// ─── Git helpers ────────────────────────────────────────────────────────────

/**
 * Runs a git command in the given directory and returns stdout.
 * Throws on non-zero exit.
 */
async function execGit(args: Array<string>, cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		encoding: "utf8",
	});
	return stdout;
}

/**
 * Runs a git command and returns stdout, or empty string on error.
 * Used when the command may legitimately fail (e.g. no remote, no commits).
 */
async function tryExecGit(args: Array<string>, cwd: string): Promise<string> {
	try {
		return await execGit(args, cwd);
	} catch {
		return "";
	}
}

function shortHash(hash: string | undefined): string | undefined {
	return hash ? hash.substring(0, 8) : undefined;
}

/**
 * Removes a file or directory from disk. Silently ignores ENOENT
 * (path already deleted externally between confirmation and execution).
 */
async function removeFromDisk(absolutePath: string): Promise<void> {
	try {
		const stat = await lstat(absolutePath);
		if (stat.isDirectory()) {
			await rm(absolutePath, { recursive: true });
		} else {
			await unlink(absolutePath);
		}
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		throw err;
	}
}

function shortHashes(hashes: ReadonlyArray<string>): Array<string> {
	return hashes.map((hash) => hash.substring(0, 8));
}

/**
 * Returns true if the file content contains JolliMemory hook identifiers
 * (e.g. "StopHook", "PostCommitHook") but does NOT contain "dist-path",
 * meaning the hooks are still in the old hardcoded-path format and need migration.
 */
function hasUnmigratedHooks(content: string): boolean {
	const lower = content.toLowerCase();
	const hasJolliMemoryHook =
		lower.includes("stophook") || lower.includes("postcommithook");
	return hasJolliMemoryHook && !lower.includes("dist-path");
}

/**
 * Normalizes a filesystem path for equality comparison.
 *
 * Handles three sources of spurious inequality that can leak in between the
 * `context.extensionPath` we get at runtime and the `distDir` we previously
 * wrote to `dist-paths/<source>`:
 *   1. Mixed separators (`\` vs `/`) — Windows freely mixes both.
 *   2. Case differences — Windows/macOS filesystems are case-insensitive by
 *      default, so `C:\Users` and `c:\users` refer to the same directory.
 *   3. Trailing slashes.
 *
 * NOT resolved: symlinks and `..` segments. `realpath` would require extra I/O
 * and could mask legitimate upgrades if either endpoint is a stale symlink.
 */
function normalizePathForCompare(p: string): string {
	const unified = p.replace(/\\/g, "/").replace(/\/+$/, "");
	/* v8 ignore start -- process.platform is fixed per test-runner host (macOS CI); covering the Linux branch would require a cross-platform matrix */
	return process.platform === "win32" || process.platform === "darwin"
		? unified.toLowerCase()
		: unified;
	/* v8 ignore stop */
}

// ─── JolliMemoryBridge class ─────────────────────────────────────────────────

export class JolliMemoryBridge {
	/** Absolute path to the workspace root (git repo) */
	readonly cwd: string;

	/**
	 * Storage backend the bridge passes explicitly into every SummaryStore call,
	 * so reads honour the user's storageMode (orphan / dual-write / folder)
	 * without relying on the module-level `setActiveStorage` global. The
	 * QueueWorker still uses that global because it lives in a separate process;
	 * the extension process owns this instance instead.
	 *
	 * Lazy: created on first `getStorage()` call rather than in the constructor,
	 * so bridge methods that don't touch SummaryStore (git ops, install, etc.)
	 * don't pay for config reads / FolderStorage init they'll never use.
	 * `reloadStorage()` clears the cache so the next `getStorage()` rebuilds
	 * from the latest config (used after a settings-save changes storageMode
	 * or localFolder).
	 */
	private storagePromise: Promise<StorageProvider> | null = null;

	constructor(
		/** Absolute path to the workspace root (git repo) */
		cwd: string,
	) {
		this.cwd = cwd;
	}

	/**
	 * Returns the current StorageProvider, awaiting the initial creation or any
	 * in-flight reload. Internal helper used by every SummaryStore wrapper below.
	 */
	private getStorage(): Promise<StorageProvider> {
		if (!this.storagePromise) {
			this.storagePromise = createStorage(this.cwd, this.cwd);
		}
		return this.storagePromise;
	}

	/**
	 * Drops the cached storage backend so the next `getStorage()` rebuilds
	 * from the latest config. Called by the settings-save callback after the
	 * user changes `storageMode` or `localFolder` so subsequent reads hit the
	 * right backend without requiring a window reload.
	 */
	reloadStorage(): void {
		this.storagePromise = null;
	}

	// ── Enable / Disable ──────────────────────────────────────────────────

	/** Enables JolliMemory hooks by calling Installer.install() directly. */
	async enable(): Promise<{ success: boolean; message: string }> {
		log.info("bridge", "enable() called");
		const result = await installerInstall(this.cwd, {
			source: "vscode-extension",
		});
		return { success: result.success, message: result.message ?? "enabled" };
	}

	/**
	 * Auto-installs hooks for the current worktree when the project is already enabled.
	 */
	async autoInstallForWorktree(): Promise<void> {
		log.info("bridge", "Auto-installing hooks for new worktree");
		await installerInstall(this.cwd, { source: "vscode-extension" });
	}

	/** Disables JolliMemory hooks by calling Installer.uninstall() directly. */
	async disable(): Promise<{ success: boolean; message: string }> {
		log.info("bridge", "disable() called");
		const result = await installerUninstall(this.cwd);
		return { success: result.success, message: result.message ?? "disabled" };
	}

	/**
	 * Checks whether this extension's per-source dist-paths/<source> entry is
	 * up to date and re-enables if needed.
	 *
	 * Logic:
	 *   1. Detect legacy (pre-dist-path) hooks → re-enable to migrate.
	 *   2. Compute this extension's source tag (cursor / vscode / windsurf / ...).
	 *   3. If `dist-paths/<self-tag>` is missing or its path is invalid →
	 *      re-enable to write a fresh entry (this only touches our own file).
	 *   4. Always look across all sources for the highest version. If a higher
	 *      version exists than this extension's, return a versionMismatch hint
	 *      so the UI can suggest an update.
	 *
	 * Note: this no longer overwrites another source's dist-path. Each source
	 * owns its own per-source file; runtime selection (`run-hook`)
	 * picks the highest available at hook trigger time.
	 *
	 * Called once on activation; errors are swallowed so they never block startup.
	 *
	 * @param extensionPath - Absolute path to the extension's dist/ directory
	 * @returns Version mismatch info if a newer registered source exists.
	 */
	async refreshHookPathsIfStale(
		extensionPath: string,
	): Promise<
		| { resolvedVersion: string; extensionVersion: string; source: string }
		| undefined
	> {
		log.debug("bridge", "Checking hook paths for staleness", { extensionPath });

		// Check for legacy hooks that predate the dist-path format entirely
		if (this.hasUnmigratedLocalHooks()) {
			log.info("bridge", "Legacy hooks detected — re-enabling to migrate");
			await this.enable();
			return;
		}

		// Determine our source tag from the extension install path
		const selfTag = deriveSourceTag(extensionPath);
		const globalDir = join(homedir(), ".jolli", "jollimemory");
		const allSources = traverseDistPaths(globalDir);
		const ownEntry = allSources.find((e) => e.source === selfTag);

		// If our own dist-paths/<selfTag> is missing, its target is invalid, or
		// points to a different install of this same IDE (e.g. VSCode upgraded
		// from 0.97.5 to 0.97.6 and the old versioned extension dir still
		// exists on disk so `available` is still true), re-enable so we
		// register a fresh entry. Doesn't touch other sources.
		//
		// Path-based comparison (not version-based): two sequential extension
		// releases can bundle the same @jolli.ai/cli core version, so comparing
		// `ownEntry.version` against `__PKG_VERSION__` would miss the upgrade.
		// The dist path always embeds the extension version (e.g. the VSCode
		// marketplace writes to `jolli.jollimemory-vscode-<ext-ver>/dist`), so
		// a path mismatch is a reliable staleness signal.
		const expectedDistDir = normalizePathForCompare(
			join(extensionPath, "dist"),
		);
		const registeredDistDir = ownEntry
			? normalizePathForCompare(ownEntry.distDir)
			: "";
		const distDirMatches = ownEntry && expectedDistDir === registeredDistDir;
		if (!ownEntry || !ownEntry.available || !distDirMatches) {
			log.info(
				"bridge",
				`Own dist-paths/${selfTag} missing, stale, or pointing elsewhere — re-enabling`,
			);
			await this.enable();
			return;
		}

		// Always check across ALL sources for the highest version. If something
		// higher is registered, surface a versionMismatch hint for the UI.
		/* v8 ignore start -- compile-time ternary: always "dev" under vitest, always __PKG_VERSION__ in bundled builds */
		const extensionVersion =
			typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "dev";
		/* v8 ignore stop */
		let highest = ownEntry;
		for (const entry of allSources) {
			if (
				entry.available &&
				compareSemver(entry.version, highest.version) > 0
			) {
				highest = entry;
			}
		}
		if (
			extensionVersion !== "dev" &&
			highest.source !== selfTag &&
			compareSemver(highest.version, extensionVersion) > 0
		) {
			return {
				resolvedVersion: highest.version,
				extensionVersion,
				source: highest.source,
			};
		}

		log.debug(
			"bridge",
			`dist-paths/${selfTag}@${ownEntry.version} is fresh — no action needed`,
		);
		return;
	}

	/**
	 * Quick check: does this repo's settings.local.json have JolliMemory hooks
	 * that haven't been migrated to the dist-path format yet?
	 */
	private hasUnmigratedLocalHooks(): boolean {
		const localSettings = join(this.cwd, ".claude", "settings.local.json");
		if (!existsSync(localSettings)) {
			return false;
		}
		return hasUnmigratedHooks(readFileSync(localSettings, "utf8"));
	}

	// ── Status ────────────────────────────────────────────────────────────

	/** Returns the current JolliMemory status by calling Installer.getStatus() directly. */
	async getStatus(): Promise<StatusInfo> {
		try {
			return await installerGetStatus(this.cwd);
		} catch (err) {
			log.error("bridge", "getStatus() failed: %s", String(err));
			return {
				enabled: false,
				claudeHookInstalled: false,
				gitHookInstalled: false,
				geminiHookInstalled: false,
				activeSessions: 0,
				mostRecentSession: null,
				summaryCount: 0,
				orphanBranch: ORPHAN_BRANCH,
				codexDetected: false,
				geminiDetected: false,
			};
		}
	}

	// ── File operations ───────────────────────────────────────────────────

	/**
	 * Lists all changed files in the working tree.
	 * All files are returned with isSelected=false — selection state is managed
	 * entirely in-memory by FilesTreeProvider (GitHub Desktop model).
	 *
	 * Uses `-z` (NUL-separated) mode so paths are output verbatim — no quoting,
	 * no escaping, no ambiguity with filenames containing ` -> ` or newlines.
	 * This matches VS Code's built-in Source Control implementation.
	 */
	async listFiles(): Promise<Array<FileStatus>> {
		// `-uall` forces git to expand untracked directories into individual file
		// entries instead of collapsing them into a single `?? dir/` row. Without
		// it, a freshly created folder full of untracked files surfaces as one
		// directory row in CHANGES — visually misleading and not actionable
		// (the open / discard handlers expect file paths). Matches VS Code's
		// built-in Source Control extension which uses the same flag.
		const raw = await tryExecGit(
			["status", "-z", "--porcelain=v1", "-uall"],
			this.cwd,
		);
		if (!raw) {
			return [];
		}

		const files: Array<FileStatus> = [];

		// -z format: entries are NUL-separated.
		// Normal entry:  "XY PATH\0"
		// Rename/copy:   "XY NEWPATH\0OLDPATH\0"
		const segments = raw.split("\0");

		let i = 0;
		while (i < segments.length) {
			const segment = segments[i];
			if (segment.length < 3) {
				i++;
				continue;
			}

			const stagedCode = segment[0];
			const unstagedCode = segment[1];
			const resolvedPath = segment.substring(3);

			// For rename/copy, the NEXT NUL-separated segment is the original path.
			let originalPath: string | undefined;
			if (stagedCode === "R" || stagedCode === "C") {
				i++;
				originalPath = segments[i];
			}

			const hasIndexEntry = stagedCode !== " " && stagedCode !== "?";
			const statusCode = hasIndexEntry ? stagedCode : unstagedCode;

			// Belt-and-suspenders: even with -uall, skip any directory-shaped
			// entry (path ending with "/"). Some git configurations
			// (`status.showUntrackedFiles=normal` overriding our flag, certain
			// submodule states) can still emit one. The CHANGES list is files-only.
			if (resolvedPath.endsWith("/")) {
				i++;
				continue;
			}

			files.push({
				absolutePath: join(this.cwd, resolvedPath),
				relativePath: resolvedPath,
				statusCode,
				indexStatus: stagedCode,
				worktreeStatus: unstagedCode,
				...(originalPath ? { originalPath } : {}),
				isSelected: false,
			});
			i++;
		}

		return files;
	}

	/**
	 * Lists files changed in a specific commit.
	 *
	 * Flags:
	 * - `-M`              rename detection (without it, renames appear as D+A pairs)
	 * - `--root`          root commits (no parent) emit files as Added instead of empty
	 * - `-m`              merge commits produce per-parent diffs (otherwise empty output);
	 *                     the parser below stops after the first block so only the
	 *                     first-parent diff is kept (--first-parent is a log-traversal
	 *                     option and has no effect on diff-tree for a single commit)
	 */
	async listCommitFiles(hash: string): Promise<Array<CommitFileInfo>> {
		const raw = await tryExecGit(
			[
				"-c",
				"core.quotepath=false",
				"diff-tree",
				"-m",
				"--first-parent",
				"-M",
				"-r",
				"--name-status",
				"--root",
				hash,
			],
			this.cwd,
		);
		if (!raw) {
			return [];
		}

		const files: Array<CommitFileInfo> = [];
		let seenFiles = false;

		for (const line of raw.split("\n")) {
			const entry = line.endsWith("\r") ? line.slice(0, -1) : line;
			// Hash header or empty line — if we already parsed files from the
			// first block, a second header means we hit the next parent's diff
			// (merge commits with -m emit one block per parent).  Stop here so
			// we only keep the first-parent diff.
			if (!entry || !entry.includes("\t")) {
				if (seenFiles) {
					break;
				}
				continue;
			}
			seenFiles = true;

			const parts = entry.split("\t");
			const rawStatus = parts[0];

			// Normalize: strip similarity percentage from rename codes (e.g. "R100" → "R")
			const statusCode = rawStatus.startsWith("R") ? "R" : rawStatus;

			if (statusCode === "R" && parts.length >= 3) {
				// Rename line: R100\told/path\tnew/path
				files.push({ relativePath: parts[2], statusCode, oldPath: parts[1] });
			} else {
				// Normal line: M\tpath/to/file
				files.push({ relativePath: parts[1], statusCode });
			}
		}

		return files;
	}

	/**
	 * Stages multiple files.
	 *
	 * Default mode (no `allowMissing`): plain `git add --`. If any path
	 * is unreachable (missing from worktree AND not in the index), git
	 * fails with "pathspec did not match any files" and the rejection
	 * surfaces to the caller — this is what the restore-previously-
	 * staged flow (`CommitCommand.ts:200` / `SquashCommand.ts:205`)
	 * relies on to warn the user that a prior staging state could not
	 * be reinstated.
	 *
	 * `allowMissing: true` (AI-commit selection path): partition paths
	 * by on-disk existence. Present paths go through `git add`; absent
	 * paths go through `git rm --cached --ignore-unmatch`. This covers
	 * the deletion flavours that `git add` refuses (gitignored +
	 * deleted, sparse-excluded, skip-worktree, staged-add-then-deleted,
	 * post-`git rm --cached` deletions, and the status-vs-commit race).
	 * See JOLLI-1326 for the full rationale.
	 *
	 * The existence check is `lstatSync(..., { throwIfNoEntry: false })`
	 * rather than `existsSync` — the latter dereferences symlinks and
	 * would misclassify a dangling symlink as absent, even though git
	 * stages dangling symlinks normally (it uses `lstat` internally).
	 *
	 * Invocations are sequential to preserve index.lock safety; errors
	 * propagate unchanged so the caller's `restoreIndex()` path can
	 * recover.
	 */
	async stageFiles(
		relativePaths: Array<string>,
		opts: { allowMissing?: boolean } = {},
	): Promise<void> {
		if (relativePaths.length === 0) {
			return;
		}

		if (!opts.allowMissing) {
			await execGit(["add", "--", ...relativePaths], this.cwd);
			return;
		}

		const existing: Array<string> = [];
		const missing: Array<string> = [];
		for (const p of relativePaths) {
			if (
				lstatSync(join(this.cwd, p), { throwIfNoEntry: false }) !== undefined
			) {
				existing.push(p);
			} else {
				missing.push(p);
			}
		}

		if (existing.length > 0) {
			await execGit(["add", "--", ...existing], this.cwd);
		}
		if (missing.length > 0) {
			await execGit(
				["rm", "--cached", "--ignore-unmatch", "--", ...missing],
				this.cwd,
			);
		}
	}

	/** Unstages multiple files in a single git restore invocation to avoid index.lock contention. */
	async unstageFiles(relativePaths: Array<string>): Promise<void> {
		if (relativePaths.length === 0) {
			return;
		}
		await execGit(["restore", "--staged", "--", ...relativePaths], this.cwd);
	}

	/**
	 * Discards changes for a set of files, returning each to its HEAD state.
	 *
	 * Handles all index/worktree status combinations:
	 * - Staged changes (M /D ): `git restore --staged --worktree`
	 * - Unstaged changes ( M/ D): `git restore --`
	 * - Both staged+unstaged (MM): `git restore --staged --worktree`
	 * - Added files (A /AM): `git restore --staged` + remove from disk
	 * - Untracked files (??): remove from disk (files and directories)
	 * - Renames (R /RM): unstage both paths, restore old, remove new
	 *
	 * Files are grouped by operation type so each git command runs once per group.
	 */
	async discardFiles(files: ReadonlyArray<FileStatus>): Promise<void> {
		// Group files by the required discard operation
		const stagedWorktreePaths: Array<string> = [];
		const worktreeOnlyPaths: Array<string> = [];
		const addedFiles: Array<FileStatus> = [];
		const untrackedFiles: Array<FileStatus> = [];
		const renamedFiles: Array<FileStatus> = [];

		for (const file of files) {
			const { indexStatus, worktreeStatus } = file;

			if (indexStatus === "R") {
				renamedFiles.push(file);
			} else if (indexStatus === "A" || indexStatus === "C") {
				addedFiles.push(file);
			} else if (indexStatus === "?" && worktreeStatus === "?") {
				untrackedFiles.push(file);
			} else if (indexStatus !== " " && indexStatus !== "?") {
				// Staged change (M /D /MM) — restore both index and worktree
				stagedWorktreePaths.push(file.relativePath);
			} else {
				// Worktree-only change ( M/ D) — restore worktree only
				worktreeOnlyPaths.push(file.relativePath);
			}
		}

		// 1. Restore staged+worktree files in one batch
		if (stagedWorktreePaths.length > 0) {
			await execGit(
				["restore", "--staged", "--worktree", "--", ...stagedWorktreePaths],
				this.cwd,
			);
		}

		// 2. Restore worktree-only files in one batch
		if (worktreeOnlyPaths.length > 0) {
			await execGit(["restore", "--", ...worktreeOnlyPaths], this.cwd);
		}

		// 3. Handle added files: unstage then remove from disk
		if (addedFiles.length > 0) {
			await execGit(
				["restore", "--staged", "--", ...addedFiles.map((f) => f.relativePath)],
				this.cwd,
			);
			for (const file of addedFiles) {
				await removeFromDisk(file.absolutePath);
			}
		}

		// 4. Handle renames: unstage both paths, restore old, remove new
		for (const file of renamedFiles) {
			const restorePaths = file.originalPath
				? [file.relativePath, file.originalPath]
				: [file.relativePath];
			await execGit(["restore", "--staged", "--", ...restorePaths], this.cwd);
			if (file.originalPath) {
				await execGit(["restore", "--", file.originalPath], this.cwd);
			}
			await removeFromDisk(file.absolutePath);
		}

		// 5. Remove untracked files/directories
		for (const file of untrackedFiles) {
			await removeFromDisk(file.absolutePath);
		}
	}

	// ── Commit message generation ─────────────────────────────────────────

	/**
	 * Generates a commit message using the Anthropic API.
	 *
	 * Only the staged diff and branch name are sent — no conversation transcripts.
	 * This keeps the call fast and cheap. The full transcript context is reserved
	 * for the post-commit hook which generates the detailed structured summary.
	 */
	async generateCommitMessage(): Promise<string> {
		log.info("bridge", "generateCommitMessage() — loading context");
		const [stagedDiff, branch, config] = await Promise.all([
			tryExecGit(["diff", "--cached"], this.cwd),
			this.getCurrentBranch(),
			loadGlobalConfig(),
		]);

		log.debug("bridge", "Context loaded", {
			diffLength: stagedDiff.length,
			branch,
			hasApiKey: !!config.apiKey,
			model: config.model,
		});

		const stagedFiles = await this.getStagedFilePaths();
		log.debug("bridge", `Staged files: ${stagedFiles.length}`, { stagedFiles });

		const result = await generateCommitMessage({
			stagedDiff,
			branch,
			stagedFiles,
			config,
		});
		log.info("bridge", "Commit message generated", { result });
		return result;
	}

	// ── Commit operations ─────────────────────────────────────────────────

	/** Creates a new commit with the given message. Returns the new commit hash. */
	async commit(message: string): Promise<string> {
		log.info("bridge", "commit()", { message });
		await savePluginSource(this.cwd);
		await execGit(["commit", "-m", message], this.cwd);
		const hash = await this.getHEADHash();
		log.info("bridge", `Commit created: ${hash}`);
		return hash;
	}

	/** Amends the HEAD commit with a new message. Returns the new commit hash. */
	async amendCommit(message: string): Promise<string> {
		const headBeforeAmend = await this.getHEADHash();
		log.info("bridge", "amendCommit()", {
			message,
			headBeforeAmend: shortHash(headBeforeAmend),
		});
		// Write plugin-source so the queue entry gets commitSource:"plugin".
		// Amend detection is handled by post-rewrite(amend) which enqueues the operation
		// with the old→new hash mapping from git's stdin.
		await savePluginSource(this.cwd);
		await execGit(["commit", "--amend", "-m", message], this.cwd);
		const hash = await this.getHEADHash();
		log.info("bridge", "Amend created", {
			headBeforeAmend: shortHash(headBeforeAmend),
			headAfterAmend: shortHash(hash),
		});
		return hash;
	}

	/** Amends the HEAD commit without changing the message. Returns the new commit hash. */
	async amendCommitNoEdit(): Promise<string> {
		const headBeforeAmend = await this.getHEADHash();
		log.info("bridge", "amendCommitNoEdit()", {
			headBeforeAmend: shortHash(headBeforeAmend),
		});
		await savePluginSource(this.cwd);
		await execGit(["commit", "--amend", "--no-edit"], this.cwd);
		const hash = await this.getHEADHash();
		log.info("bridge", "Amend (no-edit) created", {
			headBeforeAmend: shortHash(headBeforeAmend),
			headAfterAmend: shortHash(hash),
		});
		return hash;
	}

	// ── Branch history ────────────────────────────────────────────────────

	/**
	 * Lists commits on the current branch that are NOT in the preferred mainline base.
	 *
	 * Base resolution priority:
	 * 1) origin/<mainBranch>  (preferred, avoids stale local main)
	 * 2) upstream/<mainBranch>
	 * 3) <mainBranch>         (local fallback)
	 *
	 * When the branch is fully merged into main (mergeBase == HEAD), switches to
	 * "merged mode": uses git reflog to find the branch creation point, then
	 * filters commits by the current git user (--author). This provides a
	 * read-only history view of "my commits on this branch" after merge.
	 *
	 * Results are ordered newest-first (HEAD first).
	 */
	async listBranchCommits(mainBranch: string): Promise<BranchCommitsResult> {
		const emptyResult: BranchCommitsResult = { commits: [], isMerged: false };

		const branch = await this.getCurrentBranch();
		const baseRef = await this.resolveHistoryBaseRef(mainBranch);
		const headHash = await this.getHEADHash();

		// Find the fork point from the selected base ref
		let mergeBase = (
			await tryExecGit(["merge-base", "HEAD", baseRef], this.cwd)
		).trim();
		if (!mergeBase) {
			return emptyResult;
		}

		let isMerged = false;
		let authorFilter: string | undefined;

		if (mergeBase === headHash) {
			// Branch is fully merged into main — attempt merged mode
			const creationPoint = await this.findBranchCreationPoint(branch);
			if (!creationPoint) {
				return emptyResult;
			}

			authorFilter = await this.getCurrentUserName();
			if (!authorFilter) {
				return emptyResult;
			}

			mergeBase = creationPoint;
			isMerged = true;
			log.info("bridge", "Merged mode activated", {
				branch,
				creationPoint: creationPoint.substring(0, 8),
				author: authorFilter,
			});
		}

		// Build git log command with optional --author filter
		const logArgs = [
			"log",
			`${mergeBase}..HEAD`,
			"--pretty=format:%H%x00%s%x00%an%x00%ae%x00%aI%x00%x00",
		];
		if (authorFilter) {
			logArgs.push(`--author=${authorFilter}`);
		}

		const logOutput = await tryExecGit(logArgs, this.cwd);
		// No commits between merge-base and HEAD — either the branch is truly merged,
		// or it's a brand-new branch with no diverging commits yet. In either case,
		// force isMerged=false so we don't show "merged — read-only history" for
		// empty branches that simply haven't diverged from main.
		if (!logOutput.trim()) {
			return { commits: [], isMerged: false };
		}

		// Parse log entries (split on the double-NUL separator)
		const rawEntries = logOutput
			.split("\0\0\n")
			.filter((e) => e.trim().length > 0);

		// Detect which commits have been pushed to branch upstream (if any).
		// In merged mode all commits are inherently pushed, so skip the check.
		const pushBaseRef = isMerged
			? undefined
			: await this.resolvePushBaseRef(branch);
		const unpushedHashes = new Set<string>();
		if (pushBaseRef) {
			const unpushedOutput = await tryExecGit(
				["rev-list", `${pushBaseRef}..HEAD`],
				this.cwd,
			);
			for (const hash of unpushedOutput.split("\n")) {
				if (hash) {
					unpushedHashes.add(hash);
				}
			}
		}

		// Parse all commit hashes first, then batch-read the index (one git show)
		const parsedEntries = rawEntries
			.map((entry) => entry.split("\0"))
			.filter((parts) => parts.length >= 5);

		const commitHashes = parsedEntries.map((parts) => parts[0]);
		const storage = await this.getStorage();
		const indexEntryMap = await getIndexEntryMap(this.cwd, storage);

		const commits: Array<BranchCommit> = [];

		for (const parts of parsedEntries) {
			const [hash, message, author, authorEmail, isoDate] = parts;

			const entry = indexEntryMap.get(hash);
			const meta = await resolveCommitMeta(entry, hash, this.cwd);

			const date = new Date(isoDate);
			const shortDate = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

			commits.push({
				hash,
				shortHash: hash.substring(0, 7),
				message,
				author,
				authorEmail,
				date: isoDate,
				shortDate,
				topicCount: meta.topicCount,
				insertions: meta.insertions,
				deletions: meta.deletions,
				filesChanged: meta.filesChanged,
				// In merged mode all commits are already pushed
				isPushed: isMerged
					? true
					: pushBaseRef
						? !unpushedHashes.has(hash)
						: false,
				hasSummary: indexEntryMap.has(hash),
				...(meta.commitType && { commitType: meta.commitType }),
			});
		}

		// Background: scan unmatched commits for tree hash aliases (cross-branch matching).
		// Fire-and-forget — when new aliases are found, callers should refresh the panel.
		const unmatchedHashes = commitHashes.filter((h) => !indexEntryMap.has(h));
		if (unmatchedHashes.length > 0) {
			void scanTreeHashAliases(unmatchedHashes, this.cwd, storage).then(
				(anyFound) => {
					if (anyFound) {
						log.info(
							"commits",
							"Tree hash aliases found — panel refresh recommended",
						);
					}
				},
			);
		}

		const cachedCount = commits.filter(
			(c) => indexEntryMap.get(c.hash)?.diffStats,
		).length;
		const fallbackCount = commits.length - cachedCount;
		log.debug(
			"commits",
			`Loaded ${commits.length} commits on ${branch} (${cachedCount} cached, ${fallbackCount} fallback to git diff --stat)`,
		);

		return { commits, isMerged };
	}

	/**
	 * Resolves the comparison base for branch history.
	 * Prefer remote mainline refs to avoid showing commits that are already in
	 * remote main but missing from a stale local main branch.
	 */
	private async resolveHistoryBaseRef(mainBranch: string): Promise<string> {
		const candidates = [
			`origin/${mainBranch}`,
			`upstream/${mainBranch}`,
			mainBranch,
		].filter((ref) => ref.length > 0);

		for (const ref of candidates) {
			if (await this.refExists(ref)) {
				return ref;
			}
		}

		// Defensive fallback; preserves previous behavior.
		return mainBranch;
	}

	/**
	 * Resolves the push comparison base for "isPushed" status.
	 * Priority:
	 * 1) current branch upstream (@{upstream})
	 * 2) origin/<currentBranch>
	 * 3) no base (branch not published yet)
	 */
	private async resolvePushBaseRef(
		branch: string,
	): Promise<string | undefined> {
		const upstreamRef = (
			await tryExecGit(
				["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
				this.cwd,
			)
		).trim();
		if (upstreamRef && (await this.refExists(upstreamRef))) {
			return upstreamRef;
		}

		const originBranchRef = `origin/${branch}`;
		if (await this.refExists(originBranchRef)) {
			return originBranchRef;
		}

		return;
	}

	/** Returns true when the given git ref resolves locally. */
	private async refExists(ref: string): Promise<boolean> {
		const resolved = (
			await tryExecGit(["rev-parse", "--verify", "--quiet", ref], this.cwd)
		).trim();
		return resolved.length > 0;
	}

	/**
	 * Uses git reflog to find the commit where a branch was originally created.
	 * Returns the hash at creation, or undefined if the reflog has expired or
	 * is unavailable (e.g. after a fresh clone).
	 */
	private async findBranchCreationPoint(
		branch: string,
	): Promise<string | undefined> {
		const reflog = await tryExecGit(
			["reflog", "show", branch, "--format=%H %gs"],
			this.cwd,
		);
		if (!reflog.trim()) {
			return;
		}

		const lines = reflog.split("\n").filter(Boolean);

		// Look for the explicit "branch: Created from ..." entry (scan from oldest)
		for (let i = lines.length - 1; i >= 0; i--) {
			if (lines[i].includes("branch: Created from")) {
				return lines[i].split(" ")[0];
			}
		}

		// Fallback: use the oldest reflog entry
		const oldest = lines[lines.length - 1];
		return oldest.split(" ")[0];
	}

	/**
	 * Returns true if the current HEAD commit has already been pushed to the
	 * branch upstream. Used to show a toast after amend so the user knows
	 * a force push will be needed.
	 */
	async isHeadPushed(): Promise<boolean> {
		const branch = await this.getCurrentBranch();
		const pushBaseRef = await this.resolvePushBaseRef(branch);
		if (!pushBaseRef) {
			return false;
		}

		const headHash = await this.getHEADHash();
		const unpushedOutput = await tryExecGit(
			["rev-list", `${pushBaseRef}..HEAD`],
			this.cwd,
		);
		const unpushedHashes = new Set(unpushedOutput.split("\n").filter(Boolean));
		return !unpushedHashes.has(headHash);
	}

	/**
	 * Executes a git push, automatically adding `-u origin <branch>` when the
	 * current branch has no tracking upstream configured yet (first push of a
	 * new local branch).
	 *
	 * @param extraArgs - Additional flags to pass, e.g. ["--force-with-lease"]
	 */
	private async execPush(extraArgs: Array<string> = []): Promise<void> {
		const branch = await this.getCurrentBranch();
		const upstreamRef = (
			await tryExecGit(
				["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
				this.cwd,
			)
		).trim();

		// Extract the remote branch name from the upstream ref (e.g. "origin/main" → "main").
		const slashIdx = upstreamRef ? upstreamRef.indexOf("/") : -1;
		const remoteBranch =
			slashIdx > 0 ? upstreamRef.substring(slashIdx + 1) : "";

		if (upstreamRef && remoteBranch === branch) {
			// Upstream tracks a same-named remote branch — normal push works fine.
			await execGit(["push", ...extraArgs], this.cwd);
		} else {
			// Either no upstream, or upstream tracks a different branch (e.g. origin/main
			// for a feature branch). Push to a same-named remote branch and set tracking.
			log.info("bridge", "Setting upstream", {
				target: `origin/${branch}`,
				was: upstreamRef || "none",
			});
			await execGit(["push", "-u", "origin", branch, ...extraArgs], this.cwd);
		}
	}

	// ── Squash operations ─────────────────────────────────────────────────

	/**
	 * Generates a squash commit message by merging the commit messages
	 * of the selected commits. No LLM call — purely string manipulation.
	 *
	 * Preserves the original verb from the first commit's prefix.
	 * "Part of PROJ-123: X" + "Part of PROJ-123: Y" → "Part of PROJ-123: X; Y".
	 */
	async generateSquashMessage(hashes: ReadonlyArray<string>): Promise<string> {
		const messages: Array<string> = [];
		for (const hash of hashes) {
			const msg = (
				await tryExecGit(["log", "-1", "--pretty=format:%s", hash], this.cwd)
			).trim();
			if (msg) {
				messages.push(msg);
			}
		}
		return mergeCommitMessages(messages);
	}

	/**
	 * Generates a squash commit message using LLM.
	 *
	 * Reads each commit's message and summary topics (title + trigger),
	 * determines whether this is a full or partial squash, and calls the
	 * Anthropic API to produce a concise single-line message.
	 *
	 * Falls back to the string-merge method if the API call fails.
	 */
	async generateSquashMessageWithLLM(
		hashes: ReadonlyArray<string>,
	): Promise<string> {
		const config = await loadGlobalConfig();
		if (!config.apiKey && !config.jolliApiKey) {
			log.warn(
				"bridge",
				"No LLM provider — falling back to string-merge squash message",
			);
			return this.generateSquashMessage(hashes);
		}

		// Collect commit messages + summary topics
		const commits: Array<{
			message: string;
			topics: Array<{ title: string; trigger: string }>;
		}> = [];
		let ticketId: string | undefined;

		const storage = await this.getStorage();
		for (const hash of hashes) {
			const msg = (
				await tryExecGit(["log", "-1", "--pretty=format:%s", hash], this.cwd)
			).trim();
			const summary = await getSummary(hash, this.cwd, storage);
			const topics =
				summary?.topics?.map((t) => ({ title: t.title, trigger: t.trigger })) ??
				[];

			// Take the first non-empty ticketId
			if (!ticketId && summary?.ticketId) {
				ticketId = summary.ticketId;
			}

			commits.push({ message: msg || "(no message)", topics });
		}

		// Determine full vs partial squash
		let totalBranchCommits = hashes.length;
		try {
			const countStr = (
				await tryExecGit(["rev-list", "--count", "origin/main..HEAD"], this.cwd)
			).trim();
			totalBranchCommits = Number.parseInt(countStr, 10) || hashes.length;
		} catch {
			/* use hashes.length as default */
		}
		const isFullSquash = hashes.length >= totalBranchCommits;

		log.info(
			"bridge",
			`generateSquashMessageWithLLM: ${commits.length} commits, isFullSquash=${isFullSquash}, ticketId=${ticketId ?? "none"}`,
		);
		log.debug("bridge", "generateSquashMessageWithLLM hashes", {
			hashes: shortHashes(hashes),
		});
		log.debug("bridge", "generateSquashMessageWithLLM params", {
			ticketId: ticketId ?? "none",
			isFullSquash,
			commits: commits.map((c) => ({
				message: c.message,
				topicCount: c.topics.length,
				topics: c.topics.map((t) => t.title),
			})),
		});

		try {
			return await generateSquashMessage({
				ticketId,
				commits,
				isFullSquash,
				config,
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn("bridge", `LLM squash message failed, falling back: ${msg}`);
			return this.generateSquashMessage(hashes);
		}
	}

	/**
	 * Squashes the given commits (oldest→newest, newest must be HEAD) into one.
	 *
	 * Steps:
	 * 1. Write squash-pending.json with the old hashes BEFORE committing,
	 *    so the post-commit hook can automatically merge the summaries.
	 * 2. git reset --soft <parent of oldest>
	 * 3. git commit -m <message>
	 *
	 * Returns the new commit hash.
	 */
	async squashCommits(
		hashes: ReadonlyArray<string>,
		message: string,
	): Promise<string> {
		const headBeforeSquash = await this.getHEADHash();
		log.info("bridge", `squashCommits: ${hashes.length} commits`, {
			hashes: shortHashes(hashes),
			message,
			headBeforeSquash: shortHash(headBeforeSquash),
			oldestHash: shortHash(hashes[0]),
			newestHash: shortHash(hashes[hashes.length - 1]),
		});
		const oldestHash = hashes[0];

		// Step 0: write plugin-source marker so the Worker knows this came from the plugin
		await savePluginSource(this.cwd);

		// Step 1: find the parent of the oldest commit (the fork point).
		// This becomes the expectedParentHash for squash-pending validation.
		const forkPointHash = (
			await execGit(["rev-parse", `${oldestHash}^`], this.cwd)
		).trim();
		log.debug("bridge", "Resolved squash fork point", {
			headBeforeSquash: shortHash(headBeforeSquash),
			forkPointHash: shortHash(forkPointHash),
			oldestHash: shortHash(oldestHash),
		});

		// Step 2: write squash-pending.json so the post-commit hook merges summaries.
		// The expectedParentHash is the fork point because after reset --soft,
		// HEAD moves there and the squash commit's parent will be the fork point.
		await saveSquashPending([...hashes], forkPointHash, this.cwd);
		log.debug("bridge", "squash-pending.json written", {
			hashes: shortHashes(hashes),
			forkPointHash: shortHash(forkPointHash),
		});

		// Step 3: reset HEAD to the fork point (all changes go back to staging)
		await execGit(["reset", "--soft", forkPointHash], this.cwd);
		log.debug("bridge", "git reset --soft complete");

		// Step 4: create the squash commit
		await execGit(["commit", "-m", message], this.cwd);
		const newHash = await this.getHEADHash();
		log.info("bridge", "Squash commit created", {
			headBeforeSquash: shortHash(headBeforeSquash),
			newHash: shortHash(newHash),
			forkPointHash: shortHash(forkPointHash),
		});
		return newHash;
	}

	/** Squashes commits and then force-pushes. Returns the new commit hash. */
	async squashAndPush(
		hashes: ReadonlyArray<string>,
		message: string,
	): Promise<string> {
		const newHash = await this.squashCommits(hashes, message);
		await this.execPush(["--force-with-lease"]);
		return newHash;
	}

	/** Pushes the current branch without rewriting history. */
	async pushCurrentBranch(): Promise<void> {
		await this.execPush();
	}

	/** Force-pushes the current branch. */
	async forcePush(): Promise<void> {
		await this.execPush(["--force-with-lease"]);
	}

	// ── Summary access ────────────────────────────────────────────────────

	/** Lists the most recent summaries from the JolliMemory orphan branch. */
	async listSummaries(count: number): Promise<Array<CommitSummary>> {
		const storage = await this.getStorage();
		const entries = await listSummaries(count, this.cwd, storage);
		const summaries: Array<CommitSummary> = [];
		for (const entry of entries) {
			const summary = await getSummary(entry.commitHash, this.cwd, storage);
			if (summary) {
				summaries.push(summary);
			}
		}
		return summaries;
	}

	/** Cached sorted root entries from the orphan branch index. */
	private cachedRootEntries: ReadonlyArray<SummaryIndexEntry> | null = null;

	/**
	 * Lists lightweight summary index entries (no full summary loading) and
	 * returns the total root count in a single index read. Sorted newest-first.
	 * Used by the Memories panel for fast rendering.
	 *
	 * Results are cached; call {@link invalidateEntriesCache} when the orphan
	 * ref changes to force a re-read on the next call.
	 *
	 * @param filter — optional case-insensitive substring matched against
	 *   commitMessage and branch. When provided, only matching entries are
	 *   returned and totalCount reflects the filtered set.
	 */
	async listSummaryEntries(
		count: number,
		offset = 0,
		filter?: string,
	): Promise<{
		entries: ReadonlyArray<SummaryIndexEntry>;
		totalCount: number;
	}> {
		if (!this.cachedRootEntries) {
			const storage = await this.getStorage();
			const map = await getIndexEntryMap(this.cwd, storage);
			// Deduplicate: aliases map different keys to the same entry object.
			const seen = new Set<string>();
			this.cachedRootEntries = [...map.values()]
				.filter((e) => {
					if (e.parentCommitHash != null || seen.has(e.commitHash)) {
						return false;
					}
					seen.add(e.commitHash);
					return true;
				})
				.sort(
					(a, b) =>
						Date.parse(getDisplayDate(b)) - Date.parse(getDisplayDate(a)),
				);
		}

		let entries = this.cachedRootEntries;
		if (filter) {
			const lower = filter.toLowerCase();
			entries = entries.filter(
				(e) =>
					e.commitMessage.toLowerCase().includes(lower) ||
					e.branch.toLowerCase().includes(lower),
			);
		}
		return {
			entries: entries.slice(offset, offset + count),
			totalCount: entries.length,
		};
	}

	/** Clears the cached root entries so the next listSummaryEntries call re-reads the index. */
	invalidateEntriesCache(): void {
		this.cachedRootEntries = null;
	}

	/** Returns the full summary for a single commit hash, or null if not found. */
	async getSummary(hash: string): Promise<CommitSummary | null> {
		const storage = await this.getStorage();
		return getSummary(hash, this.cwd, storage);
	}

	// ── Git utility methods ───────────────────────────────────────────────

	/** Returns the git user.name configured for this repo. */
	async getCurrentUserName(): Promise<string> {
		return (await tryExecGit(["config", "user.name"], this.cwd)).trim();
	}

	/** Returns the current branch name. */
	async getCurrentBranch(): Promise<string> {
		return (
			(
				await tryExecGit(["rev-parse", "--abbrev-ref", "HEAD"], this.cwd)
			).trim() || "HEAD"
		);
	}

	/** Returns the HEAD commit message (used for Amend pre-fill). */
	async getHEADMessage(): Promise<string> {
		return (
			await tryExecGit(["log", "-1", "--pretty=format:%s"], this.cwd)
		).trim();
	}

	/** Returns the current HEAD commit hash. */
	async getHEADHash(): Promise<string> {
		return (await execGit(["rev-parse", "HEAD"], this.cwd)).trim();
	}

	// ── Private helpers ───────────────────────────────────────────────────

	/**
	 * Returns file paths currently staged in the git index.
	 *
	 * Uses `-z` (NUL-separated) so paths are output verbatim — no quoting of
	 * unicode or control chars. Matches `listFiles()` so paths produced here
	 * flow cleanly through `stageFiles()`'s `existsSync`-based partition.
	 */
	async getStagedFilePaths(): Promise<Array<string>> {
		const output = await tryExecGit(
			["diff", "--cached", "-z", "--name-only"],
			this.cwd,
		);
		return output.split("\0").filter(Boolean);
	}

	/**
	 * Stages all unmerged files (stage 1/2/3) so that git write-tree succeeds.
	 *
	 * Design decision: files appearing in the Changes panel are treated as
	 * successfully merged — we trust git's merge result and do NOT inspect
	 * file contents for conflict markers (`<<<<<<<`). If a file shows up in
	 * the merged changes list, the user (or git) has already resolved any
	 * conflicts. This simplifies the commit flow and avoids false positives
	 * from conflict-marker-like strings in source code.
	 */
	private async stageUnmergedFiles(): Promise<void> {
		const output = await tryExecGit(
			["diff", "--name-only", "--diff-filter=U"],
			this.cwd,
		);
		const unmerged = output.split("\n").filter(Boolean);
		if (unmerged.length > 0) {
			await execGit(["add", "--", ...unmerged], this.cwd);
			log.info("bridge", `Staged ${unmerged.length} unmerged file(s)`);
		}
	}

	/**
	 * Snapshots the entire index as a tree object (git write-tree).
	 * Unlike getStagedFilePaths(), this preserves partial-hunk staging,
	 * intent-to-add entries, and mode-only changes.
	 *
	 * Any unmerged index entries (from merge/rebase/cherry-pick) are
	 * automatically staged first — we assume the working-tree version is
	 * the intended resolution, so no conflict detection is needed.
	 */
	async saveIndexTree(): Promise<string> {
		await this.stageUnmergedFiles();
		const treeSha = (await execGit(["write-tree"], this.cwd)).trim();
		return treeSha;
	}

	/**
	 * Restores the index from a tree object previously saved by saveIndexTree().
	 * Does not touch the working tree.
	 */
	async restoreIndexTree(treeSha: string): Promise<void> {
		await execGit(["read-tree", treeSha], this.cwd);
	}

	/** Resets the git index to HEAD without touching the working tree (mixed reset). */
	async resetIndex(): Promise<void> {
		// Mixed reset (no flags): clears the index back to HEAD without touching the working tree.
		await execGit(["reset"], this.cwd);
	}

	// ── Plans ────────────────────────────────────────────────────────────

	/** Lists Claude Code plan files detected from active session transcripts. */
	listPlans(): Promise<Array<PlanInfo>> {
		return detectPlans(this.cwd);
	}

	/** Marks a plan as ignored in plans.json (hidden from PLANS panel). */
	async removePlan(slug: string): Promise<void> {
		await ignorePlan(slug, this.cwd);
	}

	// ── Notes ────────────────────────────────────────────────────────────

	/** Lists user-created notes from plans.json registry. */
	listNotes(): Promise<Array<NoteInfo>> {
		return detectNotes(this.cwd);
	}

	/** Creates or updates a note. */
	saveNote(
		id: string | undefined,
		title: string,
		content: string,
		format: NoteFormat,
	): Promise<NoteInfo> {
		return saveNote(id, title, content, format, this.cwd);
	}

	/** Removes a note: deletes file for uncommitted notes, removes from registry. */
	async removeNote(id: string): Promise<void> {
		await removeNote(id, this.cwd);
	}

	// ── Local push ───────────────────────────────────────────────────────

	/**
	 * Pushes a commit summary and its associated plans/notes to a local folder.
	 *
	 * Loads the full summary, filters plans and notes by commit hash, reads
	 * each file from disk, builds the summary markdown, and delegates to the
	 * core {@link corePushSummaryToLocal} function.
	 *
	 * @param commitHash - The commit hash whose summary to push
	 * @param folder     - Destination folder for the exported files
	 * @throws If no summary exists for the given commit hash
	 */
	async pushSummaryToLocal(
		commitHash: string,
		folder: string,
	): Promise<LocalPushResult> {
		const summary = await this.getSummary(commitHash);
		if (!summary) {
			throw new Error(`No summary found for commit ${commitHash}`);
		}

		const [allPlans, allNotes] = await Promise.all([
			this.listPlans(),
			this.listNotes(),
		]);

		const matchedPlans = allPlans.filter((p) => p.commitHash === commitHash);
		const matchedNotes = allNotes.filter((n) => n.commitHash === commitHash);

		// Build URL lookup maps from the summary's plan/note references.
		// Older CommitSummary records may lack these fields, so default to empty arrays.
		const planUrlBySlug = new Map(
			(summary.plans ?? []).map((p) => [p.slug, p.jolliPlanDocUrl]),
		);
		const noteUrlById = new Map(
			(summary.notes ?? []).map((n) => [n.id, n.jolliNoteDocUrl]),
		);

		const satellites: Array<SatelliteFile> = [];
		const storage = await this.getStorage();

		// Plans: read from disk if available, otherwise fall back to orphan branch
		// (committed/archived plans have filePath="" and only exist on the orphan branch)
		for (const plan of matchedPlans) {
			const content = plan.filePath
				? readFileSync(plan.filePath, "utf-8")
				: await readPlanFromBranch(plan.slug, this.cwd, storage);
			/* v8 ignore start -- both readFileSync (on-disk plan) and readPlanFromBranch (orphan-branch plan) return non-empty strings for any plan that was linked to this commit; empty content indicates corruption and is defensively skipped */
			if (!content) {
				continue;
			}
			/* v8 ignore stop */
			satellites.push({
				slug: plan.slug,
				title: plan.title,
				content,
				jolliUrl: planUrlBySlug.get(plan.slug),
			});
		}

		// Notes: read from disk if available, otherwise fall back to orphan branch.
		// Snippet notes carry inline content in the summary and may have no file on disk.
		const noteRefById = new Map((summary.notes ?? []).map((n) => [n.id, n]));
		for (const note of matchedNotes) {
			let content: string | null = null;
			if (note.filePath) {
				content = readFileSync(note.filePath, "utf-8");
			} else {
				const noteRef = noteRefById.get(note.id);
				content =
					noteRef?.format === "snippet" && noteRef.content
						? noteRef.content
						: await readNoteFromBranch(note.id, this.cwd, storage);
			}
			if (!content) {
				continue;
			}
			satellites.push({
				slug: note.id,
				title: note.title,
				content,
				jolliUrl: noteUrlById.get(note.id),
			});
		}

		const summaryMarkdown = buildMarkdown(summary);

		return corePushSummaryToLocal({
			folder,
			summary,
			summaryMarkdown,
			satellites,
			cwd: this.cwd,
		});
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extracts display-level metadata for a commit from the index entry (fast) or git diff (fallback). */
async function resolveCommitMeta(
	entry: SummaryIndexEntry | undefined,
	hash: string,
	cwd: string,
): Promise<{
	insertions: number;
	deletions: number;
	filesChanged: number;
	topicCount: number;
	commitType: string | undefined;
}> {
	const commitType =
		entry?.commitType && entry.commitType !== "commit"
			? entry.commitType
			: undefined;
	const topicCount = entry?.topicCount ?? 0;

	if (entry?.diffStats) {
		// Fast path: read cached metadata from index (zero git calls)
		return { ...entry.diffStats, topicCount, commitType };
	}

	// Fallback: no cached diffStats (old entry or no summary) — use shared getDiffStats from GitOps.
	// getDiffStats returns zeroes when git diff fails (e.g. first commit with no parent),
	// because execGit internally catches all errors and returns empty stdout.
	const stats = await getDiffStats(`${hash}^`, hash, cwd);
	return { ...stats, topicCount, commitType };
}

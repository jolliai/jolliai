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

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { lstat, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { FolderStorage } from "../../cli/src/core/FolderStorage.js";
import { getDiffStats } from "../../cli/src/core/GitOps.js";
import { filterToBranchHeads } from "../../cli/src/core/HeadEntryFilter.js";
import {
	extractRepoName,
	getRemoteUrl,
	resolveKbParent,
} from "../../cli/src/core/KBPathResolver.js";
import {
	type DiscoveredRepo,
	discoverRepos,
} from "../../cli/src/core/KBRepoDiscoverer.js";
import type { ManifestEntry } from "../../cli/src/core/KBTypes.js";
import { MetadataManager } from "../../cli/src/core/MetadataManager.js";
import { OrphanBranchStorage } from "../../cli/src/core/OrphanBranchStorage.js";
import { normalizePathForCompare, toForwardSlash } from "../../cli/src/core/PathUtils.js";
import {
	loadConfig,
	savePluginSource,
	saveSquashPending,
} from "../../cli/src/core/SessionTracker.js";
import {
	createFolderStorage,
	createStorage,
} from "../../cli/src/core/StorageFactory.js";
import type { StorageProvider } from "../../cli/src/core/StorageProvider.js";
import {
	generateCommitMessage,
	generateSquashMessage,
} from "../../cli/src/core/Summarizer.js";
import { getDisplayDate } from "../../cli/src/core/SummaryFormat.js";
import {
	deleteNoteVisibleArtifact,
	deletePlanVisibleArtifact,
	getIndexEntryMap,
	getSummary,
	getTranscriptHashes,
	indexNeedsMigration,
	listSummaries,
	migrateIndexToV3,
	readTranscript,
	readTranscriptsForCommits,
	saveTranscriptsBatch,
	scanTreeHashAliases,
	storeNotes,
	storePlans,
	storeReferences,
	storeSummary,
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
	NoteReference,
	PlanProgressArtifact,
	PlanReference,
	SourceId,
	StatusInfo,
	StoredTranscript,
	SummaryIndexEntry,
} from "../../cli/src/Types.js";
import { execFileAsyncHidden } from "../../cli/src/util/Subprocess.js";
import {
	detectReferences,
	openReferenceInBrowser as openReferenceInBrowserImpl,
	openReferenceMarkdown as openReferenceMarkdownImpl,
	removeReference,
} from "./core/ReferenceService.js";
import {
	archiveNoteForCommit,
	detectNotes,
	removeNote,
	saveNote,
} from "./core/NoteService.js";
import {
	archivePlanForCommit,
	detectPlans,
	removePlan,
} from "./core/PlanService.js";
import type {
	BranchCommit,
	BranchCommitsResult,
	CommitFileInfo,
	FileStatus,
	NoteInfo,
	PlanInfo,
	ReferenceInfo,
} from "./Types.js";
import { mergeCommitMessages } from "./util/CommitMessageUtils.js";
import { log } from "./util/Logger.js";
import { loadGlobalConfig } from "./util/WorkspaceUtils.js";

// ─── Git helpers ────────────────────────────────────────────────────────────

/**
 * Runs a git command in the given directory and returns stdout.
 * Throws on non-zero exit.
 */
async function execGit(args: Array<string>, cwd: string): Promise<string> {
	const { stdout } = await execFileAsyncHidden("git", args, {
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

// ─── JolliMemoryBridge class ─────────────────────────────────────────────────

export class JolliMemoryBridge {
	/** Absolute path to the workspace root (git repo) */
	readonly cwd: string;

	/**
	 * Storage backend used for **writes** against the current workspace
	 * repo. Reads use {@link readStoragePromise} instead — see that
	 * field for the why.
	 *
	 * Lazy: built on first {@link getStorage} call so bridge methods
	 * that don't touch SummaryStore (git ops, install, …) don't pay for
	 * config reads. {@link reloadStorage} clears the cache so the next
	 * call rebuilds against the latest config.
	 */
	private storagePromise: Promise<StorageProvider> | null = null;

	/**
	 * Read-side storage for the current workspace repo.
	 *
	 * Invariant pinned by this field: every workspace-repo READ
	 * (Memories, Timeline, branch-memories, single-summary, branch-
	 * history index lookup) sees whatever lives on disk under
	 * `<localFolder>/<repo>/.jolli/`, matching the surface that the
	 * Memory Bank tree view walks and that foreign-repo paths
	 * ({@link listSummaryEntries} step 2, {@link getSummaryAnyRepo})
	 * already use. Reading via `DualWriteStorage.readFile` would silently
	 * miss any row written there by anything other than this device's
	 * local commits (sync, external migration, sibling IDE on the same
	 * folder) because `DualWriteStorage.readFile` is pinned to the
	 * orphan-branch primary — see [DualWriteStorage.ts:21](../../cli/src/core/DualWriteStorage.ts).
	 *
	 * Mode handling (resolved by {@link createReadStorage}):
	 * - `dual-write` (default): FolderStorage when the folder both has
	 *   an index AND is clean (no shadow-dirty marker). OrphanBranchStorage
	 *   when either signal indicates the folder isn't a complete current
	 *   picture — a freshly wiped folder doesn't surface as "no memories"
	 *   while orphan is intact, and a folder whose last shadow write
	 *   failed doesn't surface stale rows while orphan holds the
	 *   authoritative update.
	 * - `folder`: FolderStorage unconditionally (user opted out of
	 *   orphan).
	 * - `orphan`: OrphanBranchStorage (legacy single-mode behavior).
	 *
	 * Cleared by {@link reloadStorage} so a settings-driven `storageMode`
	 * or `localFolder` flip takes effect on the next read.
	 */
	private readStoragePromise: Promise<StorageProvider> | null = null;

	/**
	 * Short-lived cache for the {@link loadConfig} + {@link discoverRepos}
	 * pair that {@link findRepoForAbsPath} hits per `.md` URI shown by the
	 * file-decoration provider. Without this, VS Code's per-URI
	 * `provideFileDecoration` polling fires a config read + filesystem
	 * scan for every visible markdown file on every explorer scroll —
	 * O(N) FS hits per redraw on Memory-Bank-heavy workspaces.
	 *
	 * The TTL is intentionally short (a few seconds) so users don't
	 * notice staleness after editing settings; {@link reloadStorage} also
	 * invalidates the cache explicitly on settings-save.
	 */
	private discoveryCache: {
		cfg: Record<string, unknown>;
		repos: DiscoveredRepo[];
		expiresAt: number;
	} | null = null;
	private static readonly DISCOVERY_CACHE_TTL_MS = 3000;

	constructor(
		/** Absolute path to the workspace root (git repo) */
		cwd: string,
	) {
		this.cwd = cwd;
	}

	private async getDiscoveryCached(): Promise<{
		cfg: Record<string, unknown>;
		repos: DiscoveredRepo[];
	}> {
		const now = Date.now();
		if (this.discoveryCache && this.discoveryCache.expiresAt > now) {
			return { cfg: this.discoveryCache.cfg, repos: this.discoveryCache.repos };
		}
		const cfg = (await loadConfig()) as Record<string, unknown>;
		const customKBPath = cfg.localFolder as string | undefined;
		const kbParent = resolveKbParent(customKBPath);
		const currentRepoName = extractRepoName(this.cwd);
		const currentRemoteUrl = getRemoteUrl(this.cwd);
		const repos = discoverRepos(currentRepoName, currentRemoteUrl, kbParent);
		this.discoveryCache = {
			cfg,
			repos,
			expiresAt: now + JolliMemoryBridge.DISCOVERY_CACHE_TTL_MS,
		};
		return { cfg, repos };
	}

	/** Lazy-resolved write storage. See {@link storagePromise}. */
	private getStorage(): Promise<StorageProvider> {
		if (!this.storagePromise) {
			// Reset on rejection so the next caller gets a fresh attempt
			// instead of awaiting the cached rejected promise forever.
			this.storagePromise = createStorage(this.cwd, this.cwd).catch((err) => {
				this.storagePromise = null;
				throw err;
			});
		}
		return this.storagePromise;
	}

	/** Lazy-resolved read storage. See {@link readStoragePromise}. */
	private getReadStorage(): Promise<StorageProvider> {
		if (!this.readStoragePromise) {
			this.readStoragePromise = this.createReadStorage().catch((err) => {
				this.readStoragePromise = null;
				throw err;
			});
		}
		return this.readStoragePromise;
	}

	private async createReadStorage(): Promise<StorageProvider> {
		// `loadConfig` (SessionTracker.loadConfigFromDir) swallows all
		// errors internally and resolves to `{}` on a missing/corrupt
		// file — it never rejects. So no try/catch here. Surfacing a
		// corrupt config to the user is a separate concern (would mean
		// changing SessionTracker to propagate parse errors).
		const config = (await loadConfig()) as Record<string, unknown>;
		const mode = (config.storageMode as string | undefined) ?? "dual-write";
		// Mode dispatch mirrors `StorageFactory.createStorage`'s switch so a
		// config typo (e.g. `duallwrite`) doesn't land write on orphan and
		// read on folder — both sides would refuse to read each other's
		// data and the only signal would be a baffled user. Unknown modes
		// fall back to orphan on both sides; the legitimate folder-mode
		// reads still flow through the explicit "folder" case.
		switch (mode) {
			case "orphan":
				return new OrphanBranchStorage(this.cwd);
			case "folder":
				return createFolderStorage(this.cwd, config.localFolder as string | undefined);
			case "dual-write": {
				const folder = createFolderStorage(this.cwd, config.localFolder as string | undefined);
				if ((await folder.readFile("index.json")) === null) {
					// Folder has no index yet. Three legitimate paths land here:
					//   1. Fresh install before MigrationEngine has finished
					//      copying orphan → folder.
					//   2. User wiped `<localFolder>/<repo>/.jolli/` while the
					//      orphan branch on the workspace repo still holds data.
					//   3. Truly empty repo (no commits with summaries yet) —
					//      orphan is empty too, so the fallback returns empty
					//      as well, indistinguishable from reading folder.
					// In cases (1) and (2) the orphan branch is the only source
					// of truth that still has the user's data; reading the folder
					// would render "no memories" while orphan is intact. Fall
					// back to orphan so the panel shows real data and the user
					// gets a chance to notice and re-run migration.
					//
					// The fallback is also why `refreshMemories` calls
					// `reloadReadStorage()`: once the user reruns migration or
					// the folder is repopulated via iCloud/peer sync, the next
					// manual refresh must re-probe rather than serve a cached
					// orphan-only instance forever.
					log.warn(
						"bridge",
						"createReadStorage: folder lacks index.json — falling back to orphan branch (migration incomplete, or folder wiped)",
					);
					return new OrphanBranchStorage(this.cwd);
				}
				// `DualWriteStorage.writeFiles` marks the folder dirty
				// whenever a shadow write fails (best-effort shadow path
				// keeps the orphan-primary write atomic). A dirty folder
				// means its index.json / payloads have diverged from the
				// authoritative orphan branch: stale entries, missing new
				// rows, or both. Routing reads through the folder in that
				// state surfaces silently-wrong memories while the orphan
				// copy is intact. Same fallback path as the no-index case
				// — trust orphan whenever the folder isn't a complete,
				// current picture. The dirty marker is cleared by the
				// next successful `DualWriteStorage.writeFiles`, after
				// which `reloadReadStorage()` (settings-save, refresh)
				// will re-probe and pick FolderStorage again.
				if (folder.isDirty?.()) {
					log.warn(
						"bridge",
						"createReadStorage: folder shadow is dirty — falling back to orphan branch (last shadow write failed)",
					);
					return new OrphanBranchStorage(this.cwd);
				}
				return folder;
			}
			default:
				log.warn(
					"bridge",
					`createReadStorage: unknown storageMode=${mode} — defaulting to orphan branch`,
				);
				return new OrphanBranchStorage(this.cwd);
		}
	}

	/**
	 * Drops the cached storage backends and the aggregated entries
	 * cache so the next read/write rebuilds against the latest config.
	 * Called by the settings-save callback after `storageMode` or
	 * `localFolder` changes.
	 *
	 * Both `storagePromise` and `readStoragePromise` must be cleared
	 * together — leaving the read cache after an `orphan` ↔ `dual-write`
	 * flip would silently keep reads on the previous mode's storage.
	 * Entries cache is cleared because `localFolder` changes the
	 * discoverable set of foreign repos under the Memory Bank parent.
	 */
	reloadStorage(): void {
		this.storagePromise = null;
		this.readStoragePromise = null;
		this.cachedRootEntries = null;
		this.discoveryCache = null;
	}

	/**
	 * Drops only the read-storage cache so the next read operation re-runs
	 * `createReadStorage` and re-probes the folder/orphan fallback decision.
	 *
	 * Use case: a user-initiated refresh (`jollimemory.refreshMemories`)
	 * after a peer-sync repopulates the Memory Bank folder. Without this,
	 * a dual-write session that fell back to OrphanBranchStorage on first
	 * read (because `<localFolder>/<repo>/.jolli/index.json` was still
	 * missing) would keep serving that cached instance forever, so the
	 * folder-side rows iCloud just dropped in would stay invisible until
	 * the next window reload or a settings flip.
	 *
	 * Separate from `reloadStorage()`: this method intentionally keeps the
	 * write-storage cache hot so the refresh button doesn't churn the
	 * (config-load + factory) path in the common case where the user has
	 * not changed mode/localFolder.
	 */
	reloadReadStorage(): void {
		this.readStoragePromise = null;
	}

	// ── Enable / Disable ──────────────────────────────────────────────────

	/**
	 * Enables JolliMemory hooks by calling Installer.install() directly.
	 *
	 * `source: "vscode-extension"` is load-bearing: it tells the Installer to
	 * skip its own v5 schema migration because Extension.ts runs that step
	 * with `setMigrating(true/false)` to drive the sidebar spinner. Without
	 * this flag both call sites race for `orphan-write.lock` and one of them
	 * times out after 30 s. If a future caller is added here, copy the flag.
	 */
	async enable(): Promise<{ success: boolean; message: string }> {
		log.info("bridge", "enable() called");
		const result = await installerInstall(this.cwd, {
			source: "vscode-extension",
		});
		return { success: result.success, message: result.message ?? "enabled" };
	}

	/**
	 * Auto-installs hooks for the current worktree when the project is already enabled.
	 *
	 * Same `source: "vscode-extension"` contract as `enable()` — see that
	 * doc-comment for the v5 migration / lock-contention rationale.
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
			const storage = await this.getStorage();
			return await installerGetStatus(this.cwd, storage);
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

	/**
	 * Returns `["-s"]` when the user has enabled DCO sign-off in settings,
	 * otherwise `[]`. Read on each call so a settings flip takes effect
	 * immediately without an extension reload.
	 */
	private async signoffArgs(): Promise<Array<string>> {
		const cfg = await loadConfig();
		return cfg.dcoSignoff ? ["-s"] : [];
	}

	/** Creates a new commit with the given message. Returns the new commit hash. */
	async commit(message: string): Promise<string> {
		log.info("bridge", "commit()", { message });
		await savePluginSource(this.cwd);
		const signoff = await this.signoffArgs();
		await execGit(["commit", ...signoff, "-m", message], this.cwd);
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
		const signoff = await this.signoffArgs();
		await execGit(["commit", "--amend", ...signoff, "-m", message], this.cwd);
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
		const signoff = await this.signoffArgs();
		await execGit(["commit", "--amend", ...signoff, "--no-edit"], this.cwd);
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
		// readStorage drives the index lookup; writeStorage stays on the
		// dual-write composite so the background alias scan below keeps
		// landing aliases on both backends. See {@link readStoragePromise}.
		const readStorage = await this.getReadStorage();
		const writeStorage = await this.getStorage();
		const indexEntryMap = await getIndexEntryMap(this.cwd, readStorage);

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
			void scanTreeHashAliases(
				unmatchedHashes,
				this.cwd,
				writeStorage,
				readStorage,
			).then((anyFound) => {
				if (anyFound) {
					log.info(
						"commits",
						"Tree hash aliases found — panel refresh recommended",
					);
				}
			});
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

		// Read path — see {@link readStoragePromise}. Without this, a
		// row that's on disk but absent from the orphan branch would
		// contribute no topics to the merged squash message.
		const storage = await this.getReadStorage();
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
		const signoff = await this.signoffArgs();
		await execGit(["commit", ...signoff, "-m", message], this.cwd);
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

	/** Lists the most recent summaries for the workspace repo. */
	async listSummaries(count: number): Promise<Array<CommitSummary>> {
		const storage = await this.getReadStorage();
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
	 * Aggregates entries across every repo discovered under the user's Memory
	 * Bank parent (`localFolder`), tagging each with its source `repoName`.
	 * The current workspace repo is loaded via the bridge's configured
	 * storage (so orphan / dual-write users keep their original read path);
	 * every other repo is read straight from its FolderStorage shadow on
	 * disk. orphan-only users see only the current repo because foreign
	 * orphan branches aren't reachable from this workspace.
	 *
	 * Results are cached; call {@link invalidateEntriesCache} when the orphan
	 * ref changes to force a re-read on the next call.
	 *
	 * @param filter — optional case-insensitive substring matched against
	 *   commitMessage, branch, and repoName. Mirrors IntelliJ's Memory Bank
	 *   search behaviour: the repo name itself is searchable so a query like
	 *   "jolli" surfaces every memory across that repo.
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
			const merged: SummaryIndexEntry[] = [];
			const currentRepoName = extractRepoName(this.cwd);

			// 1. Current workspace repo — read via getReadStorage() so
			//    the surface matches step 2 below (FolderStorage). See
			//    {@link readStoragePromise} for mode handling.
			try {
				const storage = await this.getReadStorage();
				const map = await getIndexEntryMap(this.cwd, storage);
				for (const entry of map.values()) {
					merged.push({ ...entry, repoName: currentRepoName });
				}
			} catch (err) {
				log.warn(
					"listSummaryEntries",
					`Failed to load current-repo entries: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}

			// 2. Every other discovered repo — read straight from FolderStorage.
			//    The current repo is skipped here because we've already loaded
			//    it via its primary storage above; loading it again via folder
			//    would double-count entries (deduping below would still drop the
			//    duplicates, but the extra IO is wasted).
			try {
				const cfg = (await loadConfig()) as Record<string, unknown>;
				const customKBPath = cfg.localFolder as string | undefined;
				const kbParent = resolveKbParent(customKBPath);
				const currentRemoteUrl = getRemoteUrl(this.cwd);
				const repos = discoverRepos(
					currentRepoName,
					currentRemoteUrl,
					kbParent,
				);
				for (const repo of repos) {
					if (repo.isCurrentRepo) continue;
					try {
						const mm = new MetadataManager(join(repo.kbRoot, ".jolli"));
						const repoStorage = new FolderStorage(repo.kbRoot, mm);
						const map = await getIndexEntryMap(undefined, repoStorage);
						for (const entry of map.values()) {
							merged.push({ ...entry, repoName: repo.repoName });
						}
					} catch (err) {
						log.warn(
							"listSummaryEntries",
							`Failed to load entries from repo '${repo.repoName}': ${
								err instanceof Error ? err.message : String(err)
							}`,
						);
					}
				}
				/* v8 ignore start -- defensive logger coercion: `err instanceof Error` is the standard JS rejection shape; the `: String(err)` arm only fires if a non-Error value is thrown (rare in practice, exercised at the PlansStore layer for the same ternary pattern). */
			} catch (err) {
				log.warn(
					"listSummaryEntries",
					`Multi-repo discovery failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
			/* v8 ignore stop */

			// Head filter is the headline behavior: keeps only v4 Hoist roots
			// (`parentCommitHash == null` — the live commit version), hiding
			// every older version hoisted into some head's children[]. The
			// trailing dedup is a separate concern — same commit can appear
			// under two repos via tree-hash aliasing, and the current-repo
			// copy wins (it was pushed to `merged` first in step 1).
			const seen = new Set<string>();
			const heads = filterToBranchHeads(merged);
			this.cachedRootEntries = heads
				.filter((e) => {
					if (seen.has(e.commitHash)) return false;
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
					e.branch.toLowerCase().includes(lower) ||
					(e.repoName ?? "").toLowerCase().includes(lower),
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

	/**
	 * Lists every head {@link SummaryIndexEntry} stored for one specific
	 * repo's one specific branch. Used by the sidebar's foreign-readonly view
	 * where the user picked a non-workspace branch from the breadcrumb
	 * dropdown and expects the Memories section to match the Memory Bank
	 * tree's count for that branch.
	 *
	 * Filter semantics aligned with {@link listSummaryEntries}: both apply
	 * {@link filterToBranchHeads} — only entries with `parentCommitHash == null`
	 * (v4 Hoist roots, the live commit versions) surface. Older versions that
	 * have been hoisted into some head's children[] stay hidden. This keeps
	 * the Memory Bank tree count, Memories panel count, and these counts in
	 * agreement.
	 *
	 * Storage resolution: workspace repo → {@link getReadStorage};
	 * foreign repo → a fresh `FolderStorage` rooted at that repo's
	 * kbRoot, mirroring {@link listSummaryEntries} step 2.
	 */
	async listBranchMemories(
		repoName: string,
		branchName: string,
	): Promise<ReadonlyArray<SummaryIndexEntry>> {
		const currentRepoName = extractRepoName(this.cwd);
		let storage: StorageProvider;
		let cwd: string | undefined;
		if (repoName === currentRepoName) {
			storage = await this.getReadStorage();
			cwd = this.cwd;
		} else {
			try {
				const cfg = (await loadConfig()) as Record<string, unknown>;
				const customKBPath = cfg.localFolder as string | undefined;
				const kbParent = resolveKbParent(customKBPath);
				const currentRemoteUrl = getRemoteUrl(this.cwd);
				const repos = discoverRepos(
					currentRepoName,
					currentRemoteUrl,
					kbParent,
				);
				const target = repos.find((r) => r.repoName === repoName);
				if (!target) return [];
				/* v8 ignore start -- cross-repo storage adoption: triggered when listing memories for a repo OTHER than the workspace's source repo (folder-mode user inspecting another repo's tree). Standard Bridge tests cover the same-repo flow; the cross-repo path is exercised end-to-end through KbFoldersService integration */
				const mm = new MetadataManager(join(target.kbRoot, ".jolli"));
				storage = new FolderStorage(target.kbRoot, mm);
				cwd = undefined;
				/* v8 ignore stop */
			} catch (err) {
				log.warn(
					"listBranchMemories",
					`Failed to resolve foreign repo '${repoName}': ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
				return [];
			}
		}

		try {
			const map = await getIndexEntryMap(cwd, storage);
			// `getIndexEntryMap` registers each entry under both its canonical
			// commitHash AND every alias hash from `index.commitAliases` (set by
			// rebase-pick / tree-hash cross-branch matching). So `map.values()`
			// can return the same entry object multiple times. Dedup by
			// commitHash before returning, mirroring listSummaryEntries' step 3.
			const seen = new Set<string>();
			const branchEntries: SummaryIndexEntry[] = [];
			for (const entry of map.values()) {
				if (entry.branch !== branchName) continue;
				if (seen.has(entry.commitHash)) continue;
				seen.add(entry.commitHash);
				branchEntries.push({ ...entry, repoName });
			}
			const heads = filterToBranchHeads(branchEntries);
			heads.sort(
				(a, b) => Date.parse(getDisplayDate(b)) - Date.parse(getDisplayDate(a)),
			);
			return heads;
		} catch (err) {
			log.warn(
				"listBranchMemories",
				`Failed to load entries: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return [];
		}
	}

	/**
	 * Returns the full summary for a single commit hash, or null if not found.
	 *
	 * **May throw `AmbiguousHashError`** if `hash` is an abbreviated SHA that
	 * matches multiple index entries. All current callers pass full 40-char
	 * SHAs (sidebar items, URI-handler regex `[0-9a-f]{40}`), so the throw is
	 * structurally unreachable today — but if a future caller wires user-
	 * typed abbreviations through here (e.g. a "go to commit" quick-pick),
	 * wrap this in try/catch and surface a "use a longer prefix" hint.
	 */
	async getSummary(hash: string): Promise<CommitSummary | null> {
		const storage = await this.getReadStorage();
		return getSummary(hash, this.cwd, storage);
	}

	/**
	 * Cross-repo summary lookup. Tries the current repo's storage first (fast
	 * path); on miss, scans every other repo discovered under the Memory Bank
	 * parent (`localFolder`) using its FolderStorage shadow. Mirrors the same
	 * discovery walk as {@link listSummaryEntries} so the Timeline view's
	 * aggregated list and its detail-fetch click path stay in lockstep.
	 *
	 * Used by callers that present cross-repo data (Timeline, Memory Bank file
	 * clicks). The single-repo {@link getSummary} stays the right choice for
	 * paths that are guaranteed current-repo-only (COMMITS view, plain commit
	 * hash deep links from this workspace).
	 *
	 * Returns null only when no repo under the Memory Bank parent has a
	 * matching summary.
	 */
	async getSummaryAnyRepo(hash: string): Promise<CommitSummary | null> {
		return (await this.getSummaryAnyRepoWithSource(hash)).summary;
	}

	/**
	 * Same lookup as {@link getSummaryAnyRepo} but also returns the source
	 * repo's `repoName` and `remoteUrl` when the hit came from a non-current
	 * repo. Callers that need to gate write actions on foreign-vs-local
	 * provenance use `sourceRepoName`; callers that need to drive read-only
	 * remote queries against the foreign repo (e.g. `gh pr view --repo …`)
	 * use `sourceRemoteUrl`. Callers that only need to render the summary
	 * use the thinner {@link getSummaryAnyRepo} wrapper.
	 *
	 * `sourceRepoName: null` means the summary was found in the current
	 * workspace's primary storage — safe for read+write. A non-null value
	 * means the summary lives in another repo's FolderStorage; the caller
	 * must treat the panel as read-only. `sourceRemoteUrl` is null when no
	 * remoteUrl was recorded in that KB folder's config (local-only repo).
	 */
	async getSummaryAnyRepoWithSource(hash: string): Promise<{
		summary: CommitSummary | null;
		sourceRepoName: string | null;
		sourceRemoteUrl: string | null;
	}> {
		const current = await this.getSummary(hash);
		if (current) {
			return {
				summary: current,
				sourceRepoName: null,
				sourceRemoteUrl: null,
			};
		}

		try {
			const cfg = (await loadConfig()) as Record<string, unknown>;
			const customKBPath = cfg.localFolder as string | undefined;
			const kbParent = resolveKbParent(customKBPath);
			const currentRepoName = extractRepoName(this.cwd);
			const currentRemoteUrl = getRemoteUrl(this.cwd);
			const repos = discoverRepos(currentRepoName, currentRemoteUrl, kbParent);
			for (const repo of repos) {
				if (repo.isCurrentRepo) continue;
				try {
					const mm = new MetadataManager(join(repo.kbRoot, ".jolli"));
					const repoStorage = new FolderStorage(repo.kbRoot, mm);
					const summary = await getSummary(hash, undefined, repoStorage);
					if (summary) {
						return {
							summary,
							sourceRepoName: repo.repoName,
							sourceRemoteUrl: repo.remoteUrl,
						};
					}
				} catch (err) {
					log.warn(
						"getSummaryAnyRepo",
						`Failed to scan repo '${repo.repoName}': ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}
			}
		} catch (err) {
			log.warn(
				"getSummaryAnyRepo",
				`Multi-repo discovery failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
		return { summary: null, sourceRepoName: null, sourceRemoteUrl: null };
	}

	/**
	 * Builds a {@link StorageProvider} rooted at a foreign repo's Memory Bank
	 * `.jolli/` directory so callers can issue cross-repo reads (transcripts,
	 * plans, notes) without going through the current workspace's primary
	 * storage. Callers pass back the `sourceRepoName` / `sourceRemoteUrl`
	 * returned by {@link getSummaryAnyRepoWithSource}; this method re-runs
	 * the same {@link discoverRepos} scan and finds the matching foreign
	 * repo, preferring `remoteUrl` over `repoName` (mirrors
	 * `KBRepoDiscoverer.isCurrentRepo`'s identity rule).
	 *
	 * Returns null when no foreign repo matches — caller should fall back to
	 * displaying empty content rather than reading from the wrong storage.
	 * Skips the currentRepo entry intentionally: this factory exists only to
	 * enable foreign-mode reads; returning the current repo would be a silent
	 * no-op against caller intent.
	 */
	/**
	 * Builds a {@link StorageProvider} rooted at the CURRENT workspace's
	 * Memory Bank `.jolli/` directory. Counterpart to
	 * {@link createStorageForRepo}: that one is foreign-only; this one
	 * returns the `isCurrentRepo` match from the same discovery scan.
	 *
	 * The SummaryWebviewPanel passes the result as `readStorage` for every
	 * detail panel (local + foreign) so all detail-panel reads
	 * (transcripts, plans, notes) uniformly hit the Memory Bank folder
	 * layer instead of the dual-write primary (orphan branch).
	 *
	 * Returns null when:
	 *   - `storageMode === "orphan"`: orphan-only users have no folder
	 *     shadow, so reading from one would surface stale leftovers or
	 *     blanks. Callers fall back to bridge-default reads (orphan
	 *     branch via the active StorageProvider), preserving the source-
	 *     of-truth contract for users who opted out of dual-write.
	 *   - No matching kbRoot is discoverable yet (fresh repo whose KB
	 *     folder hasn't been created).
	 */
	async createReadStorageForCurrentRepo(): Promise<{
		storage: StorageProvider;
		kbRoot: string;
	} | null> {
		try {
			const { cfg, repos } = await this.getDiscoveryCached();
			if (cfg.storageMode === "orphan") return null;
			for (const repo of repos) {
				if (!repo.isCurrentRepo) continue;
				const mm = new MetadataManager(join(repo.kbRoot, ".jolli"));
				const storage = new FolderStorage(repo.kbRoot, mm);
				return { storage, kbRoot: repo.kbRoot };
			}
			/* v8 ignore start -- defensive logger coercion: same pattern as listSummaryEntries above; non-Error rejections are rare. */
		} catch (err) {
			log.warn(
				"createReadStorageForCurrentRepo",
				`Discovery failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		/* v8 ignore stop */
		return null;
	}

	async createStorageForRepo(
		repoName: string,
		remoteUrl: string | null,
	): Promise<{ storage: StorageProvider; kbRoot: string } | null> {
		try {
			const cfg = (await loadConfig()) as Record<string, unknown>;
			const customKBPath = cfg.localFolder as string | undefined;
			const kbParent = resolveKbParent(customKBPath);
			const currentRepoName = extractRepoName(this.cwd);
			const currentRemoteUrl = getRemoteUrl(this.cwd);
			const repos = discoverRepos(currentRepoName, currentRemoteUrl, kbParent);
			for (const repo of repos) {
				if (repo.isCurrentRepo) continue;
				const urlMatches =
					remoteUrl != null &&
					repo.remoteUrl != null &&
					repo.remoteUrl === remoteUrl;
				const nameMatches = repo.repoName === repoName;
				if (!urlMatches && !nameMatches) continue;
				// When the caller supplied a remoteUrl AND this repo has one, we
				// require the remote to match — name-only matches across distinct
				// remotes would be a silent identity collision (folder renames
				// produce this; see KBRepoDiscoverer.isCurrentRepo).
				if (
					remoteUrl != null &&
					repo.remoteUrl != null &&
					repo.remoteUrl !== remoteUrl
				) {
					continue;
				}
				const mm = new MetadataManager(join(repo.kbRoot, ".jolli"));
				const storage = new FolderStorage(repo.kbRoot, mm);
				return { storage, kbRoot: repo.kbRoot };
			}
			/* v8 ignore start -- defensive logger coercion: same pattern as createReadStorageForCurrentRepo above; non-Error rejections are rare. */
		} catch (err) {
			log.warn(
				"createStorageForRepo",
				`Discovery failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		/* v8 ignore stop */
		return null;
	}

	/**
	 * Locates the Memory Bank repo that contains `absPath` and returns the
	 * matching {@link DiscoveredRepo} alongside a {@link MetadataManager} and
	 * the kbRoot-relative path. Returns null if the file isn't under any
	 * discovered kbRoot or if discovery itself fails.
	 *
	 * Shared by {@link isMemoryFileDivergedOnDisk} and
	 * {@link resolveMemoryFile}; both used to inline this discovery walk
	 * verbatim, so any future change to identity resolution (e.g. trailing-
	 * slash handling, symlink resolution, Windows case folding) only has to
	 * land here.
	 *
	 * Path comparison runs `normalizePathForCompare` over both endpoints for
	 * the `startsWith` check so it survives Windows separator/case mismatches.
	 * The returned `relPath` is produced from a separator-only normalization
	 * of the original `absPath` — backslashes flipped to forward slashes but
	 * casing preserved — because {@link FolderStorage} writes manifest
	 * entries with literal `/` joins (e.g. `${branchFolder}/${fileName}`) at
	 * the branch's original casing, and {@link MetadataManager.findByPath}
	 * does strict `===` matching. Re-using `absNormalized` for the slice
	 * would lowercase the branch name on darwin/win32 and miss every entry
	 * for branches with uppercase characters (see user memory
	 * `feedback_windows_path_separator_and_case.md`).
	 */
	private async findRepoForAbsPath(absPath: string): Promise<{
		repo: DiscoveredRepo;
		mm: MetadataManager;
		relPath: string;
	} | null> {
		try {
			const { repos } = await this.getDiscoveryCached();
			const absNormalized = normalizePathForCompare(absPath);
			const absSlashed = toForwardSlash(absPath);
			for (const repo of repos) {
				const kbRootSlashed = toForwardSlash(repo.kbRoot);
				const prefixSlashed = kbRootSlashed.endsWith("/")
					? kbRootSlashed
					: `${kbRootSlashed}/`;
				const prefixNormalized = normalizePathForCompare(prefixSlashed);
				if (!absNormalized.startsWith(prefixNormalized)) continue;
				const relPath = absSlashed.slice(prefixSlashed.length);
				const mm = new MetadataManager(join(repo.kbRoot, ".jolli"));
				return { repo, mm, relPath };
			}
		} catch (err) {
			log.warn(
				"findRepoForAbsPath",
				`${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return null;
	}

	/**
	 * Returns true if `absPath` is under a known Memory Bank kbRoot AND its
	 * sha256 differs from the manifest fingerprint recorded when the system
	 * last wrote that path. Used by the VS Code extension to drive the
	 * divergence banner, decoration provider, and revert command.
	 *
	 * Returns false on any of: absPath not under a known kbRoot; manifest
	 * has no fingerprint (legacy); file matches manifest. The "false on
	 * unknown" choice is deliberate — the decoration provider asks about
	 * every VS Code file URI it sees and must not flag files outside the
	 * Memory Bank.
	 */
	async isMemoryFileDivergedOnDisk(absPath: string): Promise<boolean> {
		const located = await this.findRepoForAbsPath(absPath);
		if (!located) return false;
		const { repo, mm, relPath } = located;
		const entry = mm.findByPath(relPath);
		if (!entry) return false;
		const storage = new FolderStorage(repo.kbRoot, mm);
		return storage.isUserEditedOnDisk(absPath, entry.fingerprint);
	}

	/**
	 * Locate the FolderStorage + manifest entry responsible for `absPath`,
	 * or null if the file is not under any known Memory Bank kbRoot. Used
	 * by the revert command to dispatch to the correct regenerate helper.
	 */
	async resolveMemoryFile(absPath: string): Promise<{
		folderStorage: FolderStorage;
		manifestEntry: ManifestEntry;
	} | null> {
		const located = await this.findRepoForAbsPath(absPath);
		if (!located) return null;
		const { repo, mm, relPath } = located;
		const manifestEntry = mm.findByPath(relPath);
		if (!manifestEntry) return null;
		const folderStorage = new FolderStorage(repo.kbRoot, mm);
		return { folderStorage, manifestEntry };
	}

	// ── Storage-threaded writers (webview-initiated) ─────────────────────
	//
	// All `SummaryStore` writers default to `resolveStorage(undefined, cwd)`,
	// which falls back to a fresh `OrphanBranchStorage(cwd)` because the
	// extension process never installs `setActiveStorage` (only QueueWorker
	// does — it runs in a separate process). That fallback writes only to the
	// orphan branch, leaving the Memory Bank folder out of sync whenever a
	// panel action (translate / editTopic / removePlan / archiveLinear / …)
	// rewrites a summary or content artifact.
	//
	// These thin wrappers fetch the Bridge's `DualWriteStorage` once and pass
	// it through to the underlying writer's new `storage?` parameter, so
	// every webview-driven write hits both backends. Callers in
	// `SummaryWebviewPanel` use these instead of importing the SummaryStore /
	// PlanService / NoteService writers directly.

	/**
	 * Loads the orphan-branch index entry map via the Bridge's storage
	 * instance. Threading storage matters in folder-mode (or any non-default
	 * `storageMode`) because the default `resolveStorage()` falls back to a
	 * fresh `OrphanBranchStorage` that would read the wrong file. Callers like
	 * the SummaryWebviewPanel's stale-commit guard rely on the live index, so
	 * routing through the Bridge keeps the read consistent with every
	 * webview-driven write.
	 */
	async getSummaryIndexEntryMap(): Promise<
		ReadonlyMap<string, import("../../cli/src/Types.js").SummaryIndexEntry>
	> {
		const storage = await this.getReadStorage();
		return getIndexEntryMap(this.cwd, storage);
	}

	/**
	 * Writes a summary via the Bridge's DualWriteStorage instance.
	 *
	 * Threads `readStorage` so storeSummary's index/catalog base preserves rows
	 * that exist only on the read side (FolderStorage in dual-write mode) —
	 * e.g. peer-synced entries from another machine that the workspace's
	 * orphan branch hasn't caught up to yet. Without this, a force-write
	 * rewrites the index from orphan-only rows and the dual-write below
	 * silently drops those folder-only rows on the shadow.
	 *
	 * `artifacts.transcript.id` is the v5 transcript ID under which the data
	 * lands on the orphan branch (`transcripts/{id}.json`). The caller MUST
	 * also include that ID in `summary.transcripts` for the migration / read
	 * paths to find it later — `storeSummary` does not stamp it on automatically.
	 */
	async storeSummary(
		summary: CommitSummary,
		force = false,
		artifacts?: {
			readonly transcript?: { readonly id: string; readonly data: StoredTranscript };
			readonly planProgress?: ReadonlyArray<PlanProgressArtifact>;
		},
	): Promise<void> {
		const storage = await this.getStorage();
		const readStorage = await this.getReadStorage();
		await storeSummary(summary, this.cwd, force, artifacts, storage, readStorage);
	}

	/**
	 * Loads regenerate-context (confirm-dialog counts) through the Bridge's
	 * read StorageProvider so peer-synced FolderStorage transcripts/archives
	 * surface in the dialog and reach the LLM context. The previous version
	 * used `getStorage()`, which in dual-write mode is a `DualWriteStorage`
	 * whose `readFile` only ever touches the orphan-branch primary — so any
	 * artifact synced into the folder shadow from another machine before the
	 * orphan branch caught up was invisible to regenerate.
	 */
	async loadRegenerateContext(
		summary: CommitSummary,
	): Promise<import("../../cli/src/core/RegenerateContext.js").RegenerateContext> {
		const storage = await this.getReadStorage();
		const { loadRegenerateContext } = await import(
			"../../cli/src/core/RegenerateContext.js"
		);
		return loadRegenerateContext(summary, this.cwd, storage);
	}

	/**
	 * Runs the regenerate-summary LLM call through the Bridge's read
	 * StorageProvider — same folder-sync rationale as
	 * `loadRegenerateContext`. Result is returned to the caller; the
	 * subsequent persist happens via `storeSummary`, which threads the
	 * write storage separately.
	 */
	async regenerateSummary(
		summary: CommitSummary,
		config: import("../../cli/src/Types.js").LlmConfig,
	): Promise<import("../../cli/src/core/Regenerator.js").RegenerateResult> {
		const storage = await this.getReadStorage();
		const { regenerateSummary } = await import("../../cli/src/core/Regenerator.js");
		return regenerateSummary(summary, this.cwd, config, storage);
	}

	/** Writes plan files (orphan-branch + Memory Bank visible MD). */
	async storePlans(
		planFiles: ReadonlyArray<{ slug: string; content: string }>,
		commitMessage: string,
		branch?: string,
	): Promise<void> {
		const storage = await this.getStorage();
		await storePlans(planFiles, commitMessage, this.cwd, branch, storage);
	}

	/** Writes note files (orphan-branch + Memory Bank visible MD). */
	async storeNotes(
		noteFiles: ReadonlyArray<{ id: string; content: string }>,
		commitMessage: string,
		branch?: string,
	): Promise<void> {
		const storage = await this.getStorage();
		await storeNotes(noteFiles, commitMessage, this.cwd, branch, storage);
	}

	/**
	 * Writes multi-source reference archived snapshots (Linear / Jira / GitHub /
	 * Notion). The `references/<source>/<sanitized-bareKey>.md` path layout is
	 * applied inside SummaryStore.storeReferences. Used by the Summary panel's
	 * inline edit Save handler.
	 */
	async storeReferences(
		referenceFiles: ReadonlyArray<{
			archivedKey: string;
			source: SourceId;
			content: string;
		}>,
		commitMessage: string,
		branch?: string,
	): Promise<void> {
		const storage = await this.getStorage();
		await storeReferences(
			referenceFiles,
			commitMessage,
			this.cwd,
			branch,
			storage,
		);
	}

	/** Batched transcript write+delete. */
	async saveTranscriptsBatch(
		writes: ReadonlyArray<{
			readonly hash: string;
			readonly data: StoredTranscript;
		}>,
		deletes: ReadonlyArray<string>,
	): Promise<void> {
		const storage = await this.getStorage();
		await saveTranscriptsBatch(writes, deletes, this.cwd, storage);
	}

	/** Returns the set of commit hashes that have transcript files. */
	async getTranscriptHashes(): Promise<Set<string>> {
		const storage = await this.getStorage();
		return getTranscriptHashes(this.cwd, storage);
	}

	/** Reads a single transcript by commit hash, or null if absent. */
	async readTranscript(commitHash: string): Promise<StoredTranscript | null> {
		const storage = await this.getStorage();
		return readTranscript(commitHash, this.cwd, storage);
	}

	/** Reads transcripts for a batch of commit hashes. */
	async readTranscriptsForCommits(
		commitHashes: ReadonlyArray<string>,
	): Promise<Map<string, StoredTranscript>> {
		const storage = await this.getStorage();
		return readTranscriptsForCommits(commitHashes, this.cwd, storage);
	}

	/** Returns true if the index needs migration to v3 flat format. */
	async indexNeedsMigration(): Promise<boolean> {
		const storage = await this.getStorage();
		return indexNeedsMigration(this.cwd, storage);
	}

	/** Migrates a v1 index to v3 flat format. */
	async migrateIndexToV3(): Promise<{ migrated: number; skipped: number }> {
		const storage = await this.getStorage();
		return migrateIndexToV3(this.cwd, storage);
	}

	/** Archives a plan and associates it with a commit. */
	async archivePlanForCommit(
		slug: string,
		commitHash: string,
	): Promise<PlanReference | null> {
		const storage = await this.getStorage();
		return archivePlanForCommit(slug, commitHash, this.cwd, storage);
	}

	/** Archives a note and associates it with a commit. */
	async archiveNoteForCommit(
		id: string,
		commitHash: string,
	): Promise<NoteReference | null> {
		const storage = await this.getStorage();
		return archiveNoteForCommit(id, commitHash, this.cwd, storage);
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
		await removePlan(slug, this.cwd);
	}

	/**
	 * Cleans up the user-visible `<branch>/plan--<slug>.md` in the Memory Bank
	 * folder. Routed through the Bridge's storage instance so the call honours
	 * the configured `storageMode` (dual-write / folder-only) — calling the
	 * SummaryStore wrapper directly from the panel would fall back to a fresh
	 * `OrphanBranchStorage(cwd)` (no visible-layer methods) and silently no-op,
	 * because the extension process does not install `setActiveStorage`.
	 * No-op when the active backend has no visible layer (orphan-only mode).
	 */
	async cleanupVisiblePlanArtifact(
		slug: string,
		branch: string,
	): Promise<void> {
		const storage = await this.getStorage();
		await deletePlanVisibleArtifact(slug, branch, this.cwd, storage);
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

	/**
	 * Cleans up the user-visible `<branch>/note--<id>.md` in the Memory Bank
	 * folder. See `cleanupVisiblePlanArtifact` for why this must route through
	 * the Bridge's storage instance rather than the SummaryStore wrapper's
	 * default-storage fallback.
	 */
	async cleanupVisibleNoteArtifact(id: string, branch: string): Promise<void> {
		const storage = await this.getStorage();
		await deleteNoteVisibleArtifact(id, branch, this.cwd, storage);
	}

	// ── Multi-source references ──────────────────────────────────────────

	/**
	 * Lists multi-source external references (Linear / Jira / GitHub / Notion)
	 * discovered from MCP transcripts. The panel tree consumes this list
	 * directly through the ReferenceItem renderer.
	 */
	listReferences(): Promise<ReadonlyArray<ReferenceInfo>> {
		return detectReferences(this.cwd);
	}

	/** Hard-removes a reference (registry row + backing markdown) by mapKey. Allows revival. */
	async removeReference(mapKey: string): Promise<void> {
		await removeReference(this.cwd, mapKey);
	}

	/** Opens the reference's upstream URL in the user's default browser. */
	openReferenceInBrowser(info: ReferenceInfo): Promise<boolean> {
		return openReferenceInBrowserImpl(info);
	}

	/** Opens the per-reference markdown file in a VS Code editor tab. */
	openReferenceMarkdown(info: ReferenceInfo): Promise<void> {
		return openReferenceMarkdownImpl(info);
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

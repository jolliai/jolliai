/**
 * KbFoldersService
 *
 * Provides a lazy view of the Memory Bank directory for the sidebar's Folders
 * tab. Mirrors IntelliJ's Memory Bank tool window: the tree is rooted at the
 * user's `localFolder` (`<kbParent>`) and each direct child is either a
 * discovered repo (`<kbParent>/<repoDirName>/.jolli/config.json`) or a
 * user-created top-level entry (folder or file) sitting under the same
 * parent. Repos are surfaced regardless of whether they belong to the
 * currently opened project — opening one project doesn't hide memories from
 * other projects; user entries surface so the Memory Bank folder doubles as
 * a place to drop ad-hoc notes / files without them disappearing into the
 * filesystem.
 *
 * relPath protocol used by the webview's lazy-expand traffic:
 *
 *   ""                            → the parent node; children are repo nodes
 *                                   (isRepoRoot=true) followed by user
 *                                   entries (plain folders/files).
 *   "<repoDirName>"               → that repo's root; children are the repo's
 *                                   branch folders / files.
 *   "<repoDirName>/<sub>/..."     → a path inside a specific repo.
 *   "<userDir>" / "<userDir>/..." → a user-created top-level directory and
 *                                   its descendants. Same listing flow as a
 *                                   repo, just without manifest enrichment
 *                                   (no `.jolli/manifest.json` exists under
 *                                   user folders, so `buildManifestLookup`
 *                                   returns an empty Map and every file
 *                                   falls through to `fileKind: "other"`).
 *
 * The first path segment is the on-disk basename under `<kbParent>` — either
 * a repo directory name (which may carry a `-2`/`-3`/... collision suffix)
 * or a user-created folder/file name. The two namespaces are distinguished
 * by looking up the first segment against `discoverRepos`, falling through
 * to a plain-fs lookup when it misses. That keeps the protocol unambiguous
 * even when two repos resolve to the same `config.repoName` (rare, but
 * possible after `findFreshKBPath`).
 *
 * File classification (`fileKind` / `fileKey`) is read from the owning repo's
 * `<repoRoot>/.jolli/manifest.json`. Manifest entries map `type: "commit" |
 * "plan" | "note"` to UI-level `fileKind: "memory" | "plan" | "note"`;
 * unlisted files get `"other"`.
 *
 * `fileTitle` priority for `.md` files:
 *   1. Manifest entry `title` (if present) — authoritative.
 *   2. First H1 (or YAML frontmatter `title:`) inside the file — fallback.
 *   3. Bare filename — final fallback in the renderer.
 */

import type { Dirent } from "node:fs";
import { existsSync, promises as fs, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { SummaryIndex } from "../../../cli/src/Types.js";
import { FolderStorage } from "../../../cli/src/core/FolderStorage.js";
import { archiveKBFolder } from "../../../cli/src/core/KBPathResolver.js";
import {
	type DiscoveredRepo,
	discoverRepos,
} from "../../../cli/src/core/KBRepoDiscoverer.js";
import type { Manifest, ManifestEntry } from "../../../cli/src/core/KBTypes.js";
import { MetadataManager } from "../../../cli/src/core/MetadataManager.js";
import { isManuallyDisabled } from "../../../cli/src/Logger.js";
import type { FolderFileKind, FolderNode } from "../views/SidebarMessages.js";

/**
 * The data the service needs to enumerate repos and identify the user's
 * "home" repo. Supplied lazily so changes in `localFolder` or workspace
 * picked up by Extension.ts take effect on the next listing without
 * recreating the service.
 */
export interface KbFoldersContext {
	/** The Memory Bank parent folder (`localFolder` config, validated). */
	readonly kbParent: string;
	/**
	 * Identity of the currently opened project — used to mark the matching
	 * repo as `isCurrentRepo` so the UI can highlight / auto-expand it.
	 * Both fields may be null (non-git workspace, fresh checkout, ...).
	 */
	readonly currentRepoName: string | null;
	readonly currentRemoteUrl: string | null;
}

/**
 * Optional callback the consumer can pass to be notified when a background
 * heal pass actually regenerated visible `.md` files. The consumer is
 * expected to refresh the sidebar tree so the recovered files become visible
 * without the user having to click again.
 */
export type KbFoldersHealedCallback = (info: {
	repoDirName: string;
	healed: number;
	droppedIds: readonly string[];
}) => void;

export class KbFoldersService {
	/**
	 * Absolute kbRoot paths whose last heal pass returned `healed=0 && failed=0`.
	 * The manifest is in sync with disk; future listChildren calls for those
	 * repos skip the reconcile + heal pipeline entirely. Cleared by
	 * `notifyDirty()` so manual refresh / external write events re-arm the
	 * check. Keyed by absolute path rather than dirName so that switching
	 * `kbParent` (the user's "Local Folder" setting) cannot leak a clean memo
	 * onto a same-basename repo under the new parent.
	 */
	private readonly cleanRepos = new Set<string>();

	constructor(
		private readonly getContext: () => KbFoldersContext,
		private readonly onHealed?: KbFoldersHealedCallback,
	) {}

	/**
	 * Drop the per-session "this repo is clean" memo. Called from
	 * `SidebarWebviewProvider.refreshKnowledgeBaseFolders()` so every refresh
	 * path — manual Refresh button, settings save, migration, rebuild, kbParent
	 * move — re-arms the check on the next listChildren. The optional
	 * `kbRoot` argument scopes invalidation to a single repo for callers that
	 * know exactly which one changed; omit it to clear the whole memo.
	 */
	notifyDirty(kbRoot?: string): void {
		if (kbRoot) this.cleanRepos.delete(kbRoot);
		else this.cleanRepos.clear();
	}

	/**
	 * Archives Memory Bank folders that were claimed for something that never
	 * turned out to be a useful repo, so the Folders tab stops listing rows the
	 * user has no reason to browse. This is the ONLY mutation the sidebar's
	 * Refresh performs.
	 *
	 * REFRESH'S CONTRACT — Refresh clears folders that a past bug created and
	 * that never held anything; it NEVER moves a folder holding memories. That is
	 * the whole reason this sweep is keyed on emptiness and nothing else, and why
	 * DUPLICATE folders are deliberately out of scope here even though they are
	 * the more visible annoyance: collapsing duplicates means picking one of
	 * several populated folders and burying the rest, since an archive is a plain
	 * move that cannot merge them. The only correct survivor is one rebuilt from
	 * the orphan branch (the system of record), which is Migrate's job — so
	 * duplicates belong to Migrate, and a Refresh stays a safe, lossless action
	 * the user can click without thinking. An earlier revision did wire a
	 * duplicate-collapsing pass into Refresh; it was withdrawn for exactly this
	 * reason. Do not re-add one here.
	 *
	 * WHY these folders exist: `resolveKBPath` CLAIMS the folder it returns
	 * (writes `.jolli/config.json`) and takes its `repoName` from whatever cwd the
	 * calling process happened to have. Every jollimemory process that ran outside
	 * a real project therefore materialized a folder named after that cwd —
	 * `system32`, `unknown`, `tmp.XXXXXX`, an agent's temp dir, a doc title a
	 * local-agent run used as its working directory. `checkClaimable` is the gate
	 * that stops NEW ones (see its docstring for the full taxonomy), but it can't
	 * retract the pile already on disk from before it shipped, and users have to
	 * clear those by hand today. The same shape also comes from browsing: opening
	 * an unrelated checkout once claims its folder, and if no commit ever lands
	 * there the folder stays forever empty.
	 *
	 * RULE — archive only a folder that holds NOTHING (see {@link isEmptyKbFolder}):
	 * no summaries in `index.json`, no rows in `manifest.json`, no visible files
	 * or branch dirs, and nothing under `.jolli/` beyond the inert metadata stubs
	 * `MetadataManager.ensure()` seeds. Emptiness is the whole test on purpose:
	 *   - It cannot lose memories. Archiving is a move, and an empty folder has
	 *     nothing to move; if the repo becomes active again `resolveKBPath`
	 *     re-claims the same path on the next write.
	 *   - It needs no name heuristics. Guessing junk from a *name* (`system32`,
	 *     `tmp.*`, "looks like a doc title") would eventually archive someone's
	 *     legitimately-named repo, and a populated `system32` folder means the
	 *     user really does keep memories for a project by that name.
	 *   - It covers the empty-but-real-remote rows too (a checkout opened once,
	 *     never committed to). Those identify a real repo but hold nothing, so the
	 *     row is pure noise; the folder returns the moment it earns content.
	 *
	 * Anything unrecognized under `.jolli/` — including the `shadow-status.json`
	 * dirty marker, which records that a shadow write to this folder FAILED
	 * (`DualWriteStorage` writes it only from a write's `catch`) — counts as
	 * content and keeps the folder. Unknown state is never assumed disposable.
	 *
	 * NEVER touched: the current project's folder, or any folder carrying the
	 * current project's `repoName`. A fresh install's own folder is legitimately
	 * empty until the first commit lands, and archiving it on the Refresh the user
	 * clicked to look at it would spawn one archive dir per click.
	 *
	 * Folders without `.jolli/config.json` are invisible to `discoverRepos` and so
	 * never candidates — user-dropped notes and files under `<kbParent>` are out
	 * of scope by construction.
	 *
	 * ACTION: a MOVE into the hidden `<kbParent>/.jolli/archive/` dir — the same
	 * recoverable path the Migrate-to-Memory-Bank flow uses — never a delete, so
	 * a mis-classification is undoable. The orphan branch remains the system of
	 * record regardless.
	 *
	 * @returns the list of folder paths that were archived (empty if none).
	 */
	async archiveUnusedFolders(): Promise<string[]> {
		const ctx = this.getContext();
		const repos = discoverRepos(
			ctx.currentRepoName,
			ctx.currentRemoteUrl,
			ctx.kbParent,
		);
		const archived: string[] = [];
		for (const repo of repos) {
			// Two-part current-repo guard. `isCurrentRepo` is remote-first, so it
			// misses a same-repo folder whose config holds a different transport
			// or host alias for the current project's remote — exactly the shape
			// that spawns an extra empty folder in the first place. Matching the
			// name as well keeps every folder that could be the one this session
			// is about to write into.
			if (repo.isCurrentRepo) continue;
			if (ctx.currentRepoName != null && repo.repoName === ctx.currentRepoName) {
				continue;
			}
			if (!isEmptyKbFolder(repo.kbRoot)) continue;
			const dest = archiveKBFolder(repo.kbRoot, ctx.kbParent);
			if (dest) archived.push(repo.kbRoot);
		}
		if (archived.length > 0) this.cleanRepos.clear();
		return archived;
	}

	/**
	 * Absolute path of the hidden archive directory
	 * (`<kbParent>/.jolli/archive/`) that {@link archiveUnusedFolders} moves
	 * swept folders into — the same recoverable location the Migrate flow uses
	 * (`archiveKBFolder`). Exposed so the sidebar's post-sweep toast can offer a
	 * "Reveal Archive" action: the folders are recoverable, and this is where.
	 */
	archiveDir(): string {
		return join(this.getContext().kbParent, ".jolli", "archive");
	}

	/**
	 * Enumerates every Memory Bank repo under `<kbParent>`. Wraps `discoverRepos`
	 * with the cached context (kbParent / currentRepoName / currentRemoteUrl).
	 * Used by the sidebar breadcrumb to populate the repo dropdown — `isCurrentRepo`
	 * flags the workspace's own repo for sorting / labeling.
	 */
	listRepos(): readonly DiscoveredRepo[] {
		const ctx = this.getContext();
		return discoverRepos(
			ctx.currentRepoName,
			ctx.currentRemoteUrl,
			ctx.kbParent,
		);
	}

	/**
	 * Lists every branch known for a discovered repo. The source of truth is
	 * `<kbRoot>/.jolli/branches.json` (`MetadataManager.listBranchMappings()`),
	 * not a `readdirSync` of `<kbRoot>` — git allows `/` in branch names which
	 * get sanitized on disk, and the mapping preserves the original branch
	 * name; scanning the filesystem would also surface user-dropped folders as
	 * fake branches. Result is de-duplicated and sorted alphabetically. An
	 * unknown repo returns `[]`; a fresh repo with no `branches.json` yet
	 * also returns `[]` because `MetadataManager` defaults to an empty
	 * mapping registry (readJson swallows missing-file / parse errors).
	 *
	 * Index-based head filter (v4 Hoist): a branch is hidden when it appears
	 * in `branches.json` AND in `index.json`, but every one of its index
	 * entries is a hoisted child (`parentCommitHash != null`). Under cross-
	 * branch amend / cherry-pick / rebase the head moves to the destination
	 * branch while hoisted children retain their original `branch` field;
	 * `StaleChildMarkdownCleanup` then deletes their visible `.md`, leaving
	 * the original branch with a registered mapping but no on-disk content
	 * (the "ghost branch" sidebar bug). Cross-checking against the index
	 * here is defence-in-depth: the cleanup path also prunes orphaned
	 * mappings now, but this filter survives partial cleanup, pre-migration
	 * upgrades, and any future writer that forgets to prune.
	 *
	 * Fresh-repo safety: a mapping that was created via
	 * `resolveFolderForBranch` before any commit landed has zero matching
	 * entries in the index — that's NOT a ghost. The check requires the
	 * branch to actually appear in the index before it can be hidden.
	 *
	 * `index.json` missing or unparseable falls back to mapping-only output.
	 */
	listBranches(repoName: string): readonly string[] {
		const repo = this.listRepos().find((r) => r.repoName === repoName);
		if (!repo) return [];
		const mm = new MetadataManager(join(repo.kbRoot, ".jolli"));
		const mapped = mm.listBranchMappings().map((m) => m.branch);
		if (mapped.length === 0) return [];

		const indexSummary = readBranchIndexSummary(join(repo.kbRoot, ".jolli", "index.json"));
		const visible = indexSummary
			? mapped.filter((b) => indexSummary.withHead.has(b) || !indexSummary.inIndex.has(b))
			: mapped;
		return Array.from(new Set(visible)).sort();
	}

	async listChildren(relPath: string): Promise<FolderNode> {
		const safe = this.validateRelPath(relPath);
		const ctx = this.getContext();

		if (safe === "") {
			return this.listParentRoot(ctx);
		}

		const [firstSeg, ...rest] = safe.split("/");
		const repos = discoverRepos(
			ctx.currentRepoName,
			ctx.currentRemoteUrl,
			ctx.kbParent,
		);
		const repo = repos.find((r) => r.dirName === firstSeg);
		const subRel = rest.join("/");

		if (repo) {
			// Reconcile manifest paths against the live filesystem before
			// listing inside this repo. Matches IntelliJ's KBExplorerPanel.
			// Without this the VSCode Folders tab kept stale manifest paths
			// after a user manually renamed a branch folder, dropping every
			// file in that folder back to fileKind="other" — labels disappeared
			// even though the orphan branch and .jolli/index.json were intact.
			// Runs on every list-inside-repo (not just subRel === "") so a
			// webview lazy-expand that lands on a deep path directly still
			// reaches a self-healed manifest. Per-call cost stays bounded
			// because reconcile() short-circuits when every manifest path is
			// still on disk; the full walk only fires after a real rename.
			//
			// Heal awaits inline (not fire-and-forget): the regenerated `.md`
			// files MUST be on disk before listInRepo enumerates the folder,
			// otherwise this listChildren call returns a tree that still
			// omits the recovered files and the user has to refresh again.
			// Heal is cheap in steady state — M existsSync + one manifest
			// read; the per-session `cleanRepos` set skips even that once the
			// manifest is known clean.
			//
			// Folder-only safety: heal here passes `dropOrphanedManifestEntries:
			// false` explicitly. Manifest rows whose hidden JSON is also missing
			// are kept (failed++) rather than silently deleted — the sidebar
			// path can't tell whether the active StorageProvider is folder-only
			// or dual-write (it constructs a bare FolderStorage to skip the
			// per-listing factory cost), so we MUST assume folder-only and
			// preserve. The explicit `jolli heal-folder` CLI reads the
			// storageMode config and is the place where dropping can be opted
			// into. Passing the flag explicitly (rather than relying on the
			// FolderStorage default) makes that contract visible at the call
			// site and survives future signature changes.
			//
			// Concurrency note: this path now writes (regenerate + possibly
			// replaceFiles) but holds no lock. Two concurrent listChildren
			// calls on the same repo (e.g. webview re-init racing with manual
			// Refresh) can both miss `cleanRepos` and both run heal. Single
			// `.md` writes are safe (atomicWrite); the manifest read-modify-
			// write window is bounded by reconcile + replaceFiles, both via
			// MetadataManager's atomicWrite. With drop disabled here, the only
			// manifest mutation the sidebar heal can do is `updateManifest`
			// inside regenerate, which is keyed by fileId and is idempotent
			// under concurrent re-runs.
			// Reconcile + heal both write (manifest rewrite, regenerated .md) —
			// skipped while manually disabled; the tree below still lists.
			if (!this.cleanRepos.has(repo.kbRoot) && !isManuallyDisabled()) {
				try {
					const mm = new MetadataManager(join(repo.kbRoot, ".jolli"));
					mm.reconcile(repo.kbRoot);
					const storage = new FolderStorage(repo.kbRoot, mm);
					const healResult = await storage.healMissingVisibleMarkdown({
						dropOrphanedManifestEntries: false,
					});
					if (healResult.healed === 0 && healResult.failed === 0) {
						this.cleanRepos.add(repo.kbRoot);
					}
					if (healResult.healed > 0) {
						this.onHealed?.({
							repoDirName: firstSeg,
							healed: healResult.healed,
							droppedIds: healResult.droppedIds ?? [],
						});
					}
				} catch (err) {
					// Surface user-actionable disk / permission errors so the
					// extension's debug log captures them. Heal is best-effort
					// for labelling — we still list the tree below.
					const code = (err as NodeJS.ErrnoException)?.code;
					const message = err instanceof Error ? err.message : String(err);
					if (
						code === "ENOSPC" ||
						code === "EROFS" ||
						code === "EACCES" ||
						code === "EPERM"
					) {
						// Loud category — caller should consider toasting.
						console.warn(
							`[KbFolders] heal blocked for ${firstSeg} [${code}]: ${message}`,
						);
					} else {
						console.warn(
							`[KbFolders] heal failed for ${firstSeg} [${code ?? "?"}]: ${message}`,
						);
					}
				}
			}
			const node = await this.listInRepo(repo.kbRoot, subRel);
			// Prefix every relPath with the firstSeg so cached webview paths
			// continue to round-trip through the same protocol on re-expand.
			const prefixed = rewriteRelPath(node, firstSeg);
			// Expanding a repo at its OWN root (no subpath) needs to restore the
			// repo-level identity fields that listInRepo can't know — name (the
			// configured repoName, not the empty basename), isRepoRoot (drives
			// the repo icon and the "(current)" suffix), and isCurrentRepo.
			// Without this, propagateUp on the webview side would replace the
			// rich entry from listParentRoot with a featureless folder node,
			// stripping the repo's display name and current-repo highlight.
			if (subRel === "") {
				return {
					...prefixed,
					name: repoDisplayName(repo),
					repoName: repo.repoName,
					isRepoRoot: true,
					isCurrentRepo: repo.isCurrentRepo,
				};
			}
			return prefixed;
		}

		// Plain top-level entry fallback: a folder/file the user dropped under
		// `<kbParent>` directly. listInRepo's flow happens to be the right
		// behaviour for this — the missing `.jolli/manifest.json` lookup
		// returns empty and every file falls through to fileKind:"other"
		// without any extra branching.
		const plainAbs = join(ctx.kbParent, firstSeg);
		let plainStat: Awaited<ReturnType<typeof fs.stat>>;
		try {
			plainStat = await fs.stat(plainAbs);
		} catch {
			// Stale request (entry deleted, renamed, or never existed). Surface
			// a clear message so the caller can drop its cached path and
			// re-list the root.
			throw new Error(`Unknown repo: ${firstSeg}`);
		}
		if (!plainStat.isDirectory()) {
			// Top-level plain files have no children to expand. The webview
			// shouldn't ask listChildren for a file leaf, so this is a
			// defensive throw rather than a normal path.
			throw new Error(`Cannot expand non-directory: ${firstSeg}`);
		}
		const node = await this.listInRepo(plainAbs, subRel);
		const prefixed = rewriteRelPath(node, firstSeg);
		if (subRel === "") {
			// Same name-restoration as the repo branch above. Plain folders
			// don't get isRepoRoot / isCurrentRepo — those visual cues are
			// reserved for managed Memory Bank repos.
			return { ...prefixed, name: firstSeg };
		}
		return prefixed;
	}

	private async listParentRoot(ctx: KbFoldersContext): Promise<FolderNode> {
		const repos = discoverRepos(
			ctx.currentRepoName,
			ctx.currentRemoteUrl,
			ctx.kbParent,
		);
		const repoChildren: FolderNode[] = repos.map((repo) => ({
			name: repoDisplayName(repo),
			repoName: repo.repoName,
			relPath: repo.dirName,
			isDirectory: true,
			children: undefined,
			isRepoRoot: true,
			isCurrentRepo: repo.isCurrentRepo,
		}));

		// User-created top-level entries: any direct child of `<kbParent>` that
		// isn't already represented as a discovered repo. discoverRepos already
		// resolved kbParent (default vs override + ENOENT-tolerant); this scan
		// uses the same path so the two listings stay consistent.
		const repoDirNames = new Set(repos.map((r) => r.dirName));
		const userChildren = await this.listUserTopLevelEntries(
			ctx.kbParent,
			repoDirNames,
		);

		return {
			name: "",
			relPath: "",
			isDirectory: true,
			children: [...repoChildren, ...userChildren],
		};
	}

	/**
	 * Scans `<kbParent>` for user-created top-level entries (directories and
	 * files lacking a `.jolli/config.json`). Sort order: dirs first, then
	 * files, each alphabetized. Concatenated AFTER the repo entries so the
	 * Memory Bank-managed group always reads as the primary listing.
	 *
	 * Dotfiles/dotdirs (`.git/`, `.DS_Store`, `.vscode/`, `.jolli/` left over
	 * from a deleted repo, etc.) are filtered out — matches the inside-repo
	 * listing's hide-all-dotfiles rule so the root reads consistently.
	 *
	 * Failure modes: a missing/unreadable `<kbParent>` → empty list (mirrors
	 * the discoverRepos behaviour for the same condition). Per-entry stat
	 * failures (dangling symlink, permission denial) silently skip that
	 * entry so one bad dirent can't break the whole listing.
	 */
	private async listUserTopLevelEntries(
		kbParent: string,
		repoDirNames: Set<string>,
	): Promise<FolderNode[]> {
		// Explicit `Dirent<string>[]` — without it, recent `@types/node`
		// resolves the `withFileTypes` overload to `Dirent<Buffer>[]`
		// because of overload precedence rules, then every `e.name`
		// access becomes `NonSharedBuffer` instead of `string`.
		let entries: Dirent<string>[];
		try {
			entries = (await fs.readdir(kbParent, {
				withFileTypes: true,
			})) as Dirent<string>[];
		} catch {
			return [];
		}
		const filtered = entries.filter(
			(e) => !e.name.startsWith(".") && !repoDirNames.has(e.name),
		);
		filtered.sort((a, b) => {
			const ad = a.isDirectory();
			const bd = b.isDirectory();
			if (ad !== bd) return ad ? -1 : 1;
			return a.name.localeCompare(b.name);
		});

		const out: FolderNode[] = await Promise.all(
			filtered.map(async (e): Promise<FolderNode | null> => {
				if (e.isDirectory()) {
					return {
						name: e.name,
						relPath: e.name,
						isDirectory: true,
						children: undefined,
					};
				}
				if (e.isFile()) {
					const abs = join(kbParent, e.name);
					const title = await deriveMdTitle(abs, e.name);
					return {
						name: e.name,
						relPath: e.name,
						isDirectory: false,
						children: [],
						fileKind: "other",
						fileTitle: title,
					};
				}
				// Symlinks, FIFOs, sockets, etc — skip silently. Matches
				// the inside-repo behaviour (which also uses Dirent.isDirectory
				// / isFile and ignores other types).
				return null;
			}),
		).then((nodes) => nodes.filter((n): n is FolderNode => n !== null));
		return out;
	}

	/**
	 * Lists one path inside a specific repo's KB root. Mirrors the original
	 * (single-repo) behavior of this service — same dotfile filtering,
	 * manifest enrichment, title derivation. The returned node's `relPath`
	 * is repo-relative; the caller prefixes the repoDirName afterwards.
	 */
	private async listInRepo(
		repoRoot: string,
		relPath: string,
	): Promise<FolderNode> {
		const abs = relPath === "" ? repoRoot : join(repoRoot, relPath);

		// NOTE: fs.stat/readdir follow symlinks. If the user has a symlink in
		// a repo's kbRoot pointing outside (e.g. kbRoot/link -> /etc), this
		// service will list the target's contents. Treated as intentional —
		// users may legitimately organize their KB with symlinks — but it
		// means the repo boundary is soft, not enforced at the fs layer.
		//
		// We don't catch ENOENT here: discoverRepos already gated on
		// `<repoRoot>/.jolli/config.json` existing, so `<repoRoot>` itself
		// always exists by the time we reach this code path. Stale subpath
		// requests surface as thrown errors, which SidebarWebviewProvider
		// .handleExpandFolder catches and converts into an empty-tree post
		// so the webview leaves its Loading state.
		const stat = await fs.stat(abs);
		if (!stat.isDirectory()) {
			const lookup = await this.buildManifestLookup(repoRoot);
			const entry = lookup.get(relPath);
			const name = relPathName(relPath);
			const title = entry?.title ?? (await deriveMdTitle(abs, name));
			return {
				name,
				relPath,
				isDirectory: false,
				children: [],
				fileKind: classify(entry),
				fileKey: entry?.fileId,
				fileTitle: title,
				fileBranch: entry?.source?.branch,
				isDiverged: computeIsDiverged(abs, entry?.fingerprint),
			};
		}

		const entries = await fs.readdir(abs, { withFileTypes: true });
		// Hide all dotfiles/dotdirs at every level: `.jolli/` (bookkeeping),
		// `.git/`, `.DS_Store`, `.gitignore`, `.vscode/`, etc. Users who want
		// to see specific dotfiles can navigate to them directly via VSCode's
		// Explorer; the sidebar's Folders tab is for the user-visible KB.
		const filtered = entries.filter((e) => !e.name.startsWith("."));
		filtered.sort((a, b) => {
			const ad = a.isDirectory();
			const bd = b.isDirectory();
			if (ad !== bd) return ad ? -1 : 1;
			return a.name.localeCompare(b.name);
		});

		// Read manifest once per listing. Files-only branch skips it (no
		// children to classify); the small per-listing IO cost is preferable
		// to a stale cache that could mis-label a freshly written memory.
		const lookup = filtered.some((e) => !e.isDirectory())
			? await this.buildManifestLookup(repoRoot)
			: new Map<string, ManifestEntry>();

		const children: FolderNode[] = await Promise.all(
			filtered.map(async (e): Promise<FolderNode> => {
				const childRelPath = relPath === "" ? e.name : `${relPath}/${e.name}`;
				if (e.isDirectory()) {
					return {
						name: e.name,
						relPath: childRelPath,
						isDirectory: true,
						children: undefined,
					};
				}
				const entry = lookup.get(childRelPath);
				const childAbs = join(abs, e.name);
				const title =
					entry?.title ?? (await deriveMdTitle(childAbs, e.name));
				return {
					name: e.name,
					relPath: childRelPath,
					isDirectory: false,
					children: [],
					fileKind: classify(entry),
					fileKey: entry?.fileId,
					fileTitle: title,
					fileBranch: entry?.source?.branch,
					isDiverged: computeIsDiverged(childAbs, entry?.fingerprint),
				};
			}),
		);

		return {
			name: relPathName(relPath),
			relPath,
			isDirectory: true,
			children,
		};
	}

	private async buildManifestLookup(
		repoRoot: string,
	): Promise<Map<string, ManifestEntry>> {
		const path = join(repoRoot, ".jolli", "manifest.json");
		let raw: string;
		try {
			raw = await fs.readFile(path, "utf8");
		} catch {
			// No manifest yet (fresh KB, or KB used only for user-dropped files):
			// every file naturally falls through to `fileKind: "other"`.
			return new Map();
		}
		let parsed: Manifest;
		try {
			parsed = JSON.parse(raw) as Manifest;
		} catch {
			return new Map();
		}
		const map = new Map<string, ManifestEntry>();
		for (const e of parsed.files ?? []) map.set(e.path, e);
		return map;
	}

	private validateRelPath(p: string): string {
		if (isAbsolute(p)) {
			throw new Error(`Invalid path: absolute paths not allowed (${p})`);
		}
		const norm = normalize(p)
			.replace(/\\/g, "/")
			.replace(/^\/+/, "")
			.replace(/\/+$/, "");
		if (
			norm.startsWith("..") ||
			norm.includes("/../") ||
			norm.endsWith("/..")
		) {
			throw new Error(`Invalid path: outside kbRoot (${p})`);
		}
		if (norm === "." || norm === "") return "";
		return norm;
	}
}

/**
 * Repo-row label for the sidebar's flat top-level listing. When the on-disk
 * basename matches the configured repo name we show just the repo name; when
 * they diverge — almost always because `findFreshKBPath` appended a `-2`/`-3`
 * collision suffix to keep two repos with the same `config.repoName` from
 * stomping on each other — we surface the basename in parentheses so the user
 * can tell which row is which. The "(current)" CSS suffix on the active repo
 * is a separate visual cue and is unaffected by this label.
 */
function repoDisplayName(repo: DiscoveredRepo): string {
	return repo.repoName === repo.dirName
		? repo.repoName
		: `${repo.repoName} (${repo.dirName})`;
}

/**
 * Entries under `<kbRoot>/.jolli/` that carry no memories on their own — the
 * schema stubs `MetadataManager.ensure()` seeds when a folder is claimed, plus
 * the two bookkeeping files a claim can leave behind. Every other name (
 * `summaries/`, `transcripts/`, `plans/`, `notes/`, `references/`, `catalog.json`,
 * `topics/`, `graph/`, anything a future writer adds) counts as content and
 * keeps the folder.
 *
 * `index.json` / `manifest.json` are inert only in the sense that their
 * PRESENCE proves nothing — {@link isEmptyKbFolder} still reads both and
 * requires them to hold zero entries.
 *
 * `shadow-status.json` is deliberately ABSENT: that is the dual-write dirty
 * marker, and `DualWriteStorage` writes it ONLY from a write's `catch`, so its
 * presence means the last shadow write to this folder FAILED — not that one is
 * currently in flight. Either way a write meant to land here didn't, so the
 * folder is not the inert-empty shape this sweep targets and is kept.
 */
const INERT_JOLLI_ENTRIES: ReadonlySet<string> = new Set([
	"config.json",
	"branches.json",
	"manifest.json",
	"index.json",
	"migration.json",
]);

/**
 * OS-generated files that appear inside any browsed directory and say nothing
 * about whether the user keeps memories there. Ignored when deciding emptiness
 * so a single Finder/Explorer visit can't pin a junk folder in the tree
 * forever. Names are stored lowercase and matched case-insensitively via
 * {@link isOsNoise}: `Thumbs.db` is often written lowercase (`thumbs.db`) on
 * Windows, and macOS filesystems are case-insensitive by default.
 */
const OS_NOISE_FILES: ReadonlySet<string> = new Set([".ds_store", "thumbs.db"]);

function isOsNoise(name: string): boolean {
	return OS_NOISE_FILES.has(name.toLowerCase());
}

/**
 * True when `kbRoot` is a claimed-but-empty Memory Bank folder: nothing the
 * user could browse and nothing the system recorded. The emptiness test behind
 * {@link KbFoldersService.archiveUnusedFolders} — see that method for why
 * emptiness (rather than the folder's name or its missing remote) is the whole
 * criterion.
 *
 * Every check is "keep unless proven empty", so an unreadable directory, an
 * unparseable manifest, or any name this code doesn't recognize resolves to
 * `false` (keep). A folder is only archived on positive evidence that it holds
 * nothing.
 */
function isEmptyKbFolder(kbRoot: string): boolean {
	let top: Dirent<string>[];
	try {
		top = readdirSync(kbRoot, { withFileTypes: true }) as Dirent<string>[];
	} catch {
		// Unreadable (permissions, vanished mid-scan) — not provably empty, and
		// `archiveKBFolder` would fail on it anyway.
		return false;
	}
	for (const e of top) {
		if (e.name === ".jolli") continue;
		if (isOsNoise(e.name)) continue;
		// A visible branch dir / `.md`, or a dotfile we don't recognize (a `.git`
		// the user init'd here, an editor workspace file) — real content.
		return false;
	}

	let jolli: Dirent<string>[];
	try {
		jolli = readdirSync(join(kbRoot, ".jolli"), {
			withFileTypes: true,
		}) as Dirent<string>[];
	} catch {
		// `discoverRepos` only yields folders whose `.jolli/config.json` parsed,
		// so this is a vanished-mid-scan race, not a normal state.
		return false;
	}
	for (const e of jolli) {
		// Same OS-noise skip as the top-level loop: a `.jolli/.DS_Store` a
		// Finder visit dropped is not content, and without this it would pin the
		// junk folder permanently (the strict allowlist below rejects it).
		if (isOsNoise(e.name)) continue;
		if (!INERT_JOLLI_ENTRIES.has(e.name)) return false;
	}

	// `countIndexEntries` reads a missing OR unparseable index as 0. That is safe
	// here only because a folder holding real summaries also holds
	// `.jolli/summaries/`, which the allowlist above already rejected — a corrupt
	// index alone can never make a populated folder look empty.
	if (countIndexEntries(kbRoot) > 0) return false;
	return countManifestFiles(kbRoot) === 0;
}

/**
 * Number of rows in `<kbRoot>/.jolli/manifest.json`, or `-1` when the file
 * exists but can't be read or parsed. The sentinel keeps
 * {@link isEmptyKbFolder}'s `=== 0` test from treating a corrupt manifest as
 * proof of emptiness; a missing manifest is a genuine `0` (nothing was ever
 * written).
 */
function countManifestFiles(kbRoot: string): number {
	const path = join(kbRoot, ".jolli", "manifest.json");
	if (!existsSync(path)) return 0;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Manifest;
		return Array.isArray(parsed.files) ? parsed.files.length : -1;
	} catch {
		return -1;
	}
}

/**
 * Number of summaries recorded in `<kbRoot>/.jolli/index.json`, or `0` when the
 * file is missing or unparseable. Reading a missing index as "empty" is what
 * {@link isEmptyKbFolder} needs (a folder that never got an index never got a
 * summary); the unparseable case is safe there because a folder holding real
 * summaries also holds `.jolli/summaries/`, which that check rejects first.
 */
function countIndexEntries(kbRoot: string): number {
	try {
		const parsed = JSON.parse(
			readFileSync(join(kbRoot, ".jolli", "index.json"), "utf-8"),
		) as SummaryIndex;
		return Array.isArray(parsed.entries) ? parsed.entries.length : 0;
	} catch {
		return 0;
	}
}

/**
 * Walks a FolderNode tree and prepends `prefix/` to every `relPath`, so a
 * node produced relative to a single repo (`branch/foo.md`) becomes
 * addressable relative to the Memory Bank parent (`myrepo/branch/foo.md`).
 * Only relPaths are rewritten; names stay as-is.
 */
function rewriteRelPath(node: FolderNode, prefix: string): FolderNode {
	const prefixed = node.relPath === "" ? prefix : `${prefix}/${node.relPath}`;
	const children = node.children?.map((c) => rewriteRelPath(c, prefix));
	return { ...node, relPath: prefixed, children };
}

function classify(entry: ManifestEntry | undefined): FolderFileKind {
	if (!entry) return "other";
	if (entry.type === "commit") return "memory";
	return entry.type;
}

/**
 * Returns true when the on-disk `.md` differs from the manifest fingerprint —
 * i.e. the user edited the visible copy outside the system. Mirrors
 * `FolderStorage.isUserEditedOnDisk` semantics so the KB folders tree's ✎
 * marker reads consistently with `MemoryFileDecorationProvider`'s explorer
 * badge:
 *   - no fingerprint (untracked, or pre-fingerprint legacy row) → false
 *   - file missing → false (the cleanup pipeline owns that case)
 *   - read error → true (be conservative: surface the ✎ rather than hide it)
 * Synchronous + cheap: a single `readFileSync` + `sha256` per manifest-tracked
 * file. KbFoldersService callers pay this once per listing, batched with the
 * already-existing `deriveMdTitle` IO.
 */
function computeIsDiverged(
	absPath: string,
	fingerprint: string | undefined,
): boolean {
	if (!fingerprint) return false;
	if (!existsSync(absPath)) return false;
	try {
		return MetadataManager.sha256(readFileSync(absPath, "utf-8")) !== fingerprint;
	} catch {
		return true;
	}
}

function relPathName(rel: string): string {
	if (rel === "") return "";
	const parts = rel.split("/");
	return parts[parts.length - 1];
}

/**
 * Title-extraction head size. ~1 KB is enough for a YAML frontmatter block
 * plus the first heading of any reasonably-formatted markdown file. We cap
 * the read because `listChildren` runs N IOs per .md file in the listing,
 * and an unbounded read would amplify that cost on folders full of large
 * notes.
 */
const MD_TITLE_HEAD_BYTES = 1024;

async function deriveMdTitle(
	absPath: string,
	name: string,
): Promise<string | undefined> {
	if (!name.toLowerCase().endsWith(".md")) return undefined;
	let head: string;
	try {
		const handle = await fs.open(absPath, "r");
		try {
			const buf = Buffer.alloc(MD_TITLE_HEAD_BYTES);
			const { bytesRead } = await handle.read(buf, 0, MD_TITLE_HEAD_BYTES, 0);
			head = buf.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
	return parseMdTitle(head);
}

export function parseMdTitle(text: string): string | undefined {
	let s = text.replace(/^﻿/, "");
	// YAML frontmatter `---\n ... \n---` — extract `title: ...` if present
	// and strip the block before scanning for an H1, so we don't mistake a
	// frontmatter line beginning with `#` (a YAML comment) for a heading.
	const fmMatch = s.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (fmMatch) {
		const titleLine = fmMatch[1].match(
			/^[ \t]*title[ \t]*:[ \t]*(.+?)[ \t]*$/im,
		);
		if (titleLine) {
			const v = stripQuotes(titleLine[1]).trim();
			if (v) return v;
		}
		s = s.slice(fmMatch[0].length);
	}
	for (const rawLine of s.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "") continue;
		const h1 = line.match(/^#[ \t]+(.+?)[ \t]*#*[ \t]*$/);
		if (h1) {
			return h1[1].trim();
		}
		// First non-blank line isn't an H1 → no title; keep filename.
		return undefined;
	}
	return undefined;
}

/**
 * Reads `<kbRoot>/.jolli/index.json` and projects it into two branch sets used
 * by `listBranches`:
 *  - `withHead`: branches that have at least one entry with
 *    `parentCommitHash == null` — the v4 Hoist live-head invariant
 *    ([HeadEntryFilter](../../../cli/src/core/HeadEntryFilter.ts) is the
 *    canonical definition).
 *  - `inIndex`:  branches that appear in any entry, head or hoisted child.
 *
 * Returns `null` when the index is missing or unparseable so the caller
 * falls back to mapping-only output (fresh repo, pre-write, or transient
 * corruption — none should cause the sidebar to silently hide branches).
 */
function readBranchIndexSummary(
	indexPath: string,
): { withHead: Set<string>; inIndex: Set<string> } | null {
	if (!existsSync(indexPath)) return null;
	let parsed: SummaryIndex;
	try {
		parsed = JSON.parse(readFileSync(indexPath, "utf-8")) as SummaryIndex;
	} catch {
		return null;
	}
	const withHead = new Set<string>();
	const inIndex = new Set<string>();
	for (const e of parsed.entries ?? []) {
		inIndex.add(e.branch);
		if (e.parentCommitHash == null) withHead.add(e.branch);
	}
	return { withHead, inIndex };
}

function stripQuotes(s: string): string {
	if (s.length >= 2) {
		const first = s[0];
		const last = s[s.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return s.slice(1, -1);
		}
	}
	return s;
}

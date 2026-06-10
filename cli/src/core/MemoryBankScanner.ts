/**
 * MemoryBankScanner — surfaces user-written markdown in Memory Bank as raw
 * compile input. Replaces the spec 89 decision #4 `jolli import` command per
 * spec 108 Correction 1: the vehicle is upgraded from "user runs a command"
 * to "user drops files in Memory Bank via Obsidian".
 *
 * Identification rule (AND of two checks):
 *  1. file path NOT present in `<kbRoot>/.jolli/manifest.json` files[].path set
 *  2. filename does NOT match the generated `-[0-9a-f]{8}\.md$` suffix
 *
 * Scope mapping (per spec 108):
 *   <localFolder>/*.md                          → global
 *   <kbRoot>/*.md                               → repo
 *   <kbRoot>/<branchFolder>/*.md (passing rule) → branch
 *
 * Failure modes (silent / WARN-then-skip per spec 108):
 *   - Memory Bank not configured / kbRoot missing → empty result
 *   - manifest.json missing                       → fall back to hash-suffix rule, WARN
 *   - per-file read failure                       → skip + WARN
 */

import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createLogger } from "../Logger.js";
import { extractRepoName, getRemoteUrl, resolveKBPath } from "./KBPathResolver.js";
import { MetadataManager } from "./MetadataManager.js";
import { toForwardSlash } from "./PathUtils.js";
import { loadConfig } from "./SessionTracker.js";

const log = createLogger("MemoryBankScanner");

/**
 * The `-<8-hex>.md` suffix shape FolderStorage uses for generated commit
 * markdown. Matching the **same** regex shape spec 108 calls out so a future
 * change to FolderStorage's slug convention has to update both sides.
 */
const GENERATED_SUFFIX_RE = /-[0-9a-f]{8}\.md$/;

/**
 * Secondary rule companion to {@link GENERATED_SUFFIX_RE}: FolderStorage names
 * generated plan/note/wiki visible files `plan--<slug>.md`, `note--<id>.md`,
 * and `topic--<slug>.md` — none of which carry the `-<8hex>.md` suffix. Without
 * this prefix guard, a missing/corrupt manifest (empty primary rule) would let
 * those generated files through as "user knowledge", double-folding the same
 * plan/note into topic pages. The `--` separator makes a collision with a real
 * user filename unlikely.
 */
const GENERATED_PREFIX_RE = /^(?:plan|note|topic)--/;

export type UserKnowledgeScope = "global" | "repo" | "branch";

export interface UserKnowledgeFile {
	/** Path relative to the Memory Bank parent (`localFolder`), POSIX-separator. */
	readonly path: string;
	readonly absolutePath: string;
	readonly scope: UserKnowledgeScope;
	/** Present only when scope === "branch". */
	readonly branch?: string;
	/** sha256 of the on-disk content; same algorithm as the manifest's `fingerprint`. */
	readonly fingerprint: string;
	readonly content: string;
	/**
	 * ISO 8601 mtime. Promoted to the chronological **ordering key** for user
	 * files in the topic KB timeline fold (see SourceTimeline.listPendingSources):
	 * a user file's position in the old→new source stream is its mtime. Not used
	 * for cache-invalidation logic (that is the fingerprint's job).
	 */
	readonly mtime: string;
}

/**
 * Scans the Memory Bank folder for user-written markdown visible to the
 * given (cwd, branch). When `branch` is omitted only global + repo scopes
 * are returned.
 */
export async function listUserKnowledge(cwd: string, branch?: string): Promise<ReadonlyArray<UserKnowledgeFile>> {
	const kbRoot = await tryResolveKBRoot(cwd);
	if (!kbRoot) return [];
	return listUserKnowledgeFromRoot(kbRoot, branch);
}

/**
 * Scans a Memory Bank folder for user-written markdown by explicit `kbRoot`,
 * without deriving it from a git `cwd`. Used by the multi-repo compile sweep,
 * whose targets have no git working tree.
 */
export async function listUserKnowledgeFromRoot(
	kbRoot: string,
	branch?: string,
): Promise<ReadonlyArray<UserKnowledgeFile>> {
	if (!existsSync(kbRoot)) {
		log.debug("Memory Bank kbRoot not present: %s", kbRoot);
		return [];
	}

	const localFolderRoot = dirname(kbRoot);
	const metadata = new MetadataManager(join(kbRoot, ".jolli"));
	const manifestPaths = readManifestPaths(metadata, kbRoot);

	const results: UserKnowledgeFile[] = [];

	// 1. Global scope — `<localFolder>/*.md` (top-level only, not recursed
	//    into repo subfolders). These live outside `kbRoot`, never appear in
	//    manifest, so only the hash-suffix rule applies.
	collectMarkdown({
		dir: localFolderRoot,
		scope: "global",
		kbRoot,
		localFolderRoot,
		manifestPaths,
		out: results,
	});

	// 2. Repo scope — `<kbRoot>/*.md` (top-level only).
	collectMarkdown({
		dir: kbRoot,
		scope: "repo",
		kbRoot,
		localFolderRoot,
		manifestPaths,
		out: results,
	});

	// 3. Branch scope — `<kbRoot>/<branchFolder>/*.md`. Resolves the folder
	//    name via branches.json first (so renames are honored), falling back
	//    to MetadataManager.transcodeBranchName when no mapping exists.
	if (branch) {
		const branchFolder = resolveBranchFolder(metadata, branch);
		const branchDir = join(kbRoot, branchFolder);
		if (existsSync(branchDir)) {
			collectMarkdown({
				dir: branchDir,
				scope: "branch",
				kbRoot,
				localFolderRoot,
				manifestPaths,
				out: results,
				branch,
			});
		}
	}

	return results;
}

/** kbRoot subfolders that are never branch folders and must not be scanned as
 *  user knowledge: `.jolli` (canonical JSON) and `_wiki` (generated topic pages). */
const SYSTEM_SUBDIRS = new Set([".jolli", "_wiki"]);

/**
 * Primary identification set: paths recorded in manifest.json. Missing or
 * unreadable manifest degrades to "secondary rule only" with a WARN — per the
 * spec 108 failure-mode table.
 */
function readManifestPaths(metadata: MetadataManager, kbRoot: string): Set<string> {
	try {
		return new Set(metadata.readManifest().files.map((f) => f.path));
	} catch (err: unknown) {
		log.warn(
			"Failed to read manifest at %s — falling back to hash-suffix identification only: %s",
			kbRoot,
			(err as Error).message,
		);
		return new Set();
	}
}

/**
 * Scans a Memory Bank folder for ALL user-written markdown — global, repo, and
 * **every branch folder physically present on disk** — without needing a branch
 * argument or a summary index. The per-branch, index-driven scan
 * ({@link listUserKnowledgeFromRoot}) silently missed branch folders that have
 * no summary yet (fresh repo, branch-only user notes); this disk-driven sweep is
 * the source of truth for ingest enumeration and for branch-scoped content reads.
 * Branch label is reverse-mapped from branches.json, falling back to the folder
 * name when no mapping exists.
 */
export async function listAllUserKnowledgeFromRoot(kbRoot: string): Promise<ReadonlyArray<UserKnowledgeFile>> {
	if (!existsSync(kbRoot)) {
		log.debug("Memory Bank kbRoot not present: %s", kbRoot);
		return [];
	}

	const localFolderRoot = dirname(kbRoot);
	const metadata = new MetadataManager(join(kbRoot, ".jolli"));
	const manifestPaths = readManifestPaths(metadata, kbRoot);
	const results: UserKnowledgeFile[] = [];

	collectMarkdown({ dir: localFolderRoot, scope: "global", kbRoot, localFolderRoot, manifestPaths, out: results });
	collectMarkdown({ dir: kbRoot, scope: "repo", kbRoot, localFolderRoot, manifestPaths, out: results });

	let subdirs: Dirent[];
	try {
		subdirs = readdirSync(kbRoot, { withFileTypes: true });
		/* v8 ignore start -- defensive: kbRoot readdir failure (permission / race). existsSync gates above; same ESM-mock limitation as collectMarkdown's catch. */
	} catch {
		return results;
	}
	/* v8 ignore stop */
	for (const d of subdirs) {
		if (!d.isDirectory() || SYSTEM_SUBDIRS.has(d.name)) continue;
		collectMarkdown({
			dir: join(kbRoot, d.name),
			scope: "branch",
			kbRoot,
			localFolderRoot,
			manifestPaths,
			out: results,
			// Shared folder→branch resolver (handles missing branches.json fallback).
			branch: metadata.folderToBranch(d.name),
		});
	}
	return results;
}

/**
 * cwd-resolving wrapper over {@link listAllUserKnowledgeFromRoot} (resolves the
 * Memory Bank root from config + git remote, mirroring {@link listUserKnowledge}).
 */
export async function listAllUserKnowledge(cwd: string): Promise<ReadonlyArray<UserKnowledgeFile>> {
	const kbRoot = await tryResolveKBRoot(cwd);
	if (!kbRoot) return [];
	return listAllUserKnowledgeFromRoot(kbRoot);
}

interface CollectArgs {
	readonly dir: string;
	readonly scope: UserKnowledgeScope;
	readonly kbRoot: string;
	readonly localFolderRoot: string;
	readonly manifestPaths: Set<string>;
	readonly out: UserKnowledgeFile[];
	readonly branch?: string;
}

function collectMarkdown(args: CollectArgs): void {
	const { dir, scope, kbRoot, localFolderRoot, manifestPaths, out, branch } = args;
	let entries: string[];
	try {
		entries = readdirSync(dir);
		/* v8 ignore start -- defensive: directory unreadable (permission / race). Cannot be reproduced with vi.spyOn on a frozen `node:fs` ESM namespace, so the catch is held as a no-op silent-skip safety net rather than left untested. */
	} catch {
		return;
	}
	/* v8 ignore stop */

	for (const name of entries) {
		if (!name.endsWith(".md")) continue;
		// Secondary rule: drop anything that looks generated. Cheap, applies
		// even when manifest is missing/corrupt. Covers both summary visible
		// files (`<slug>-<8hex>.md`) and prefix-named plan/note/topic pages.
		if (GENERATED_SUFFIX_RE.test(name) || GENERATED_PREFIX_RE.test(name)) continue;

		const absolutePath = join(dir, name);
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(absolutePath);
			/* v8 ignore start -- defensive: per-file stat failure (file vanishes between readdir and stat). Same ESM-mock limitation as the readdir catch above. */
		} catch {
			continue;
		}
		/* v8 ignore stop */
		if (!st.isFile()) continue;

		// Primary rule (skipped for "global" because global files live outside
		// kbRoot and can never appear in this kbRoot's manifest).
		if (scope !== "global") {
			const manifestRelPath = toForwardSlash(relative(kbRoot, absolutePath));
			if (manifestPaths.has(manifestRelPath)) continue;
		}

		let content: string;
		try {
			content = readFileSync(absolutePath, "utf-8");
			/* v8 ignore start -- defensive: per-file read failure (race with deletion / EACCES). Same ESM-mock limitation as the readdir catch above. */
		} catch (err: unknown) {
			log.warn("Failed to read user file %s: %s", absolutePath, (err as Error).message);
			continue;
		}
		/* v8 ignore stop */

		// Shared helper (NOT an inline createHash) so this fingerprint stays in
		// lockstep with the manifest fingerprint and SourceContent's verify hash.
		const fingerprint = MetadataManager.sha256(content);
		const localRelPath = toForwardSlash(relative(localFolderRoot, absolutePath));

		out.push({
			path: localRelPath,
			absolutePath,
			scope,
			...(branch && { branch }),
			fingerprint,
			content,
			mtime: st.mtime.toISOString(),
		});
	}
}

function resolveBranchFolder(metadata: MetadataManager, branch: string): string {
	try {
		const mappings = metadata.listBranchMappings();
		const mapping = mappings.find((m) => m.branch === branch);
		if (mapping) return mapping.folder;
	} catch {
		// Falls through to transcoded default
	}
	return MetadataManager.transcodeBranchName(branch);
}

async function tryResolveKBRoot(cwd: string): Promise<string | null> {
	try {
		const config = (await loadConfig()) as { localFolder?: string };
		const customKBPath = config.localFolder;
		const repoName = extractRepoName(cwd);
		const remoteUrl = getRemoteUrl(cwd);
		return resolveKBPath(repoName, remoteUrl, customKBPath);
	} catch (err: unknown) {
		log.debug("Memory Bank kbRoot resolution failed for cwd %s: %s", cwd, (err as Error).message);
		return null;
	}
}

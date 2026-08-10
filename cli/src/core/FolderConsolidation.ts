/**
 * FolderConsolidation — merges duplicate Memory Bank folders for ONE repo into a
 * single survivor, chosen by comparing folder contents against each other and
 * against the orphan branch (the system of record).
 *
 * Why this exists: a repo could split across `<repo>` and `<repo>-2` folders —
 * most often because a `~/.ssh/config` host alias made the same remote fold to
 * two different keys (fixed at the identity layer in `KBPathResolver`, but that
 * fix cannot retract the folders already on disk). PR #443's Refresh sweep only
 * archives *empty* folders; a populated duplicate needs a real merge.
 *
 * The three cases (the classifier picks one; the executor acts on it):
 *
 *  - **identical** — every folder holds the same set of summaries. Keep the
 *    shortest-named folder, archive the rest. Nothing is moved (they match).
 *  - **orphan-superset** — folders differ, but the orphan branch already
 *    contains every folder's summaries. Rebuild one clean folder from the
 *    orphan branch (the existing Migrate-to-Memory-Bank flow) and archive the
 *    pile — lossless because the source of truth has everything.
 *  - **union-largest** — some folder holds summaries the orphan branch does
 *    NOT (typically written by another clone whose orphan branch lives
 *    elsewhere). Rebuilding from the orphan branch would DROP those, so instead
 *    fold every folder into the largest one (copy-if-absent across every layer),
 *    merge the metadata indexes, then archive the drained duplicates.
 *
 * Scoped to a single repo — the caller passes the currently-open repo's
 * identity. Archiving is `KBPathResolver.archiveKBFolder` (a recoverable move
 * into `<parent>/.jolli/archive/`), never a hard delete.
 *
 * Product rule, so it lives in `cli/src/core` (VS Code imports it; IntelliJ can
 * reach it over the ide-bridge later).
 */

import { copyFileSync, type Dirent, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { createLogger } from "../Logger.js";
import type { SummaryIndex } from "../Types.js";
import { FolderStorage } from "./FolderStorage.js";
import { archiveKBFolder, findRepoFolders, initializeKBFolder, resolveKbParent } from "./KBPathResolver.js";
import type { BranchesJson, Manifest } from "./KBTypes.js";
import { MetadataManager } from "./MetadataManager.js";
import { MigrationEngine } from "./MigrationEngine.js";
import { toForwardSlash } from "./PathUtils.js";
import { resolveSotStorage } from "./SotStorageResolver.js";
import type { StorageProvider } from "./StorageProvider.js";

const log = createLogger("FolderConsolidation");

// Indirection so tests can supply a fake source of truth (a FolderStorage over a
// temp dir) instead of standing up a real orphan branch. Production always uses
// `resolveSotStorage`.
let sotResolver: (cwd: string) => Promise<StorageProvider> = resolveSotStorage;

/** Test seam: override the source-of-truth resolver. Pass `null` to restore. */
export function __setSotResolverForTests(fn: ((cwd: string) => Promise<StorageProvider>) | null): void {
	sotResolver = fn ?? resolveSotStorage;
}

export type ConsolidationKind = "identical" | "orphan-superset" | "union-largest";

export interface ConsolidationPlan {
	readonly kind: ConsolidationKind;
	readonly repoName: string;
	/** Absolute paths of every folder that currently holds this repo (≥ 2). */
	readonly folders: readonly string[];
	/**
	 * The folder that will remain live. For `orphan-superset` this is the
	 * canonical `<parent>/<repo>` base slot the rebuild lands on (which may
	 * itself be archived-then-recreated); for the other kinds it is an existing
	 * folder in {@link folders}.
	 */
	readonly survivor: string;
	/** Folders that will be archived. For `orphan-superset` this is ALL folders. */
	readonly archived: readonly string[];
	readonly counts: {
		/** folder path → summary count. */
		readonly perFolder: Readonly<Record<string, number>>;
		readonly orphan: number;
		readonly union: number;
		readonly survivor: number;
		/** Summaries the survivor gains from the others (`union − survivor`). */
		readonly added: number;
	};
}

export interface ConsolidationResult {
	readonly kind: ConsolidationKind;
	readonly survivor: string;
	readonly archived: readonly string[];
	readonly summariesAfter: number;
}

/** `.jolli/` top-level files that are merged (index) or survivor-owned — never raw-copied. */
const MERGED_OR_OWNED_META: ReadonlySet<string> = new Set([
	".jolli/index.json",
	".jolli/manifest.json",
	".jolli/branches.json",
	".jolli/config.json",
	".jolli/migration.json",
	".jolli/shadow-status.json",
]);

/**
 * Classifies the duplicate folders for the given repo, or returns `null` when
 * there is nothing to consolidate (fewer than two folders).
 */
export async function classifyDuplicateFolders(
	cwd: string,
	repoName: string,
	remoteUrl: string | null,
	customPath?: string,
): Promise<ConsolidationPlan | null> {
	const folders = findRepoFolders(repoName, remoteUrl, customPath);
	if (folders.length < 2) return null;

	const perFolder: Record<string, number> = {};
	const hashSets = new Map<string, Set<string>>();
	const union = new Set<string>();
	for (const folder of folders) {
		const hashes = readSummaryHashes(folder);
		hashSets.set(folder, hashes);
		perFolder[folder] = hashes.size;
		for (const h of hashes) union.add(h);
	}

	const orphan = await readOrphanSummaryHashes(cwd);
	const first = hashSets.get(folders[0]) ?? new Set<string>();
	const allEqual = folders.every((f) => setsEqual(hashSets.get(f) ?? new Set(), first));

	let kind: ConsolidationKind;
	let survivor: string;
	let archived: readonly string[];
	if (allEqual) {
		kind = "identical";
		survivor = shortestNamed(folders);
		archived = folders.filter((f) => f !== survivor);
	} else if (isSubset(union, orphan)) {
		kind = "orphan-superset";
		// The rebuild lands on the canonical base slot; the whole pile is archived
		// first (the base included), mirroring rebuildKnowledgeBase.
		survivor = join(resolveKbParent(customPath), repoName);
		archived = folders;
	} else {
		kind = "union-largest";
		survivor = largestNamed(folders, perFolder);
		archived = folders.filter((f) => f !== survivor);
	}

	return {
		kind,
		repoName,
		folders,
		survivor,
		archived,
		counts: {
			perFolder,
			orphan: orphan.size,
			union: union.size,
			survivor: perFolder[survivor] ?? 0,
			added: union.size - (perFolder[survivor] ?? 0),
		},
	};
}

/**
 * Executes a plan produced by {@link classifyDuplicateFolders}. Returns a
 * summary of what happened.
 */
export async function executeConsolidation(
	plan: ConsolidationPlan,
	cwd: string,
	remoteUrl: string | null,
	customPath?: string,
): Promise<ConsolidationResult> {
	if (plan.kind === "orphan-superset") {
		return rebuildFromOrphan(plan, cwd, remoteUrl, customPath);
	}
	return mergeIntoSurvivor(plan, customPath);
}

// ── Executors ──────────────────────────────────────────────────────────────

async function mergeIntoSurvivor(plan: ConsolidationPlan, customPath?: string): Promise<ConsolidationResult> {
	const survivor = plan.survivor;
	mkdirSync(join(survivor, ".jolli"), { recursive: true });

	// 1. Copy every layer (hidden + visible) from each other folder into the
	//    survivor when absent. A plain copy-if-absent cannot lose data: the
	//    survivor keeps its own version of any path they share, and gains the
	//    rest. The merged/owned metadata files are handled in step 2 instead.
	for (const other of plan.archived) {
		copyTreeIfAbsent(other, survivor);
	}

	// 2. Union the three metadata indexes (survivor entries win on conflict).
	mergeIndexes(survivor, plan.archived);

	// 3. Regenerate any missing visible summary markdown (safety net — copied
	//    raw above, this fixes gaps left by an interrupted earlier write).
	const mm = new MetadataManager(join(survivor, ".jolli"));
	const folder = new FolderStorage(survivor, mm);
	await folder.healMissingVisibleMarkdown();

	// 4. Archive the drained duplicates (recoverable move).
	for (const other of plan.archived) {
		archiveKBFolder(other, customPath);
	}

	return {
		kind: plan.kind,
		survivor,
		archived: plan.archived,
		summariesAfter: readSummaryHashes(survivor).size,
	};
}

async function rebuildFromOrphan(
	plan: ConsolidationPlan,
	cwd: string,
	remoteUrl: string | null,
	customPath?: string,
): Promise<ConsolidationResult> {
	const sot = await sotResolver(cwd);
	// Defensive: `orphan-superset` implies a non-empty orphan branch, but if the
	// source of truth is somehow gone, fall back to a lossless folder merge
	// rather than archiving everything and rebuilding nothing.
	if (!(await sot.exists())) {
		log.warn("rebuildFromOrphan: no source of truth — falling back to folder merge");
		const survivor = largestNamed(plan.folders, plan.counts.perFolder);
		return mergeIntoSurvivor(
			{ ...plan, kind: "union-largest", survivor, archived: plan.folders.filter((f) => f !== survivor) },
			customPath,
		);
	}

	// Archive the whole pile first (base included) so the rebuild lands back on
	// the canonical base slot — the same sequence as rebuildKnowledgeBase.
	for (const folder of plan.folders) {
		archiveKBFolder(folder, customPath);
	}

	const base = plan.survivor;
	initializeKBFolder(base, plan.repoName, remoteUrl);
	const mm = new MetadataManager(join(base, ".jolli"));
	const folder = new FolderStorage(base, mm);
	await folder.ensure();
	await new MigrationEngine(sot, folder, mm).runMigration();

	return {
		kind: plan.kind,
		survivor: base,
		archived: plan.folders,
		summariesAfter: readSummaryHashes(base).size,
	};
}

// ── Metadata merge ───────────────────────────────────────────────────────────

function mergeIndexes(survivor: string, others: readonly string[]): void {
	mergeIndexJson(survivor, others);
	mergeManifestJson(survivor, others);
	mergeBranchesJson(survivor, others);
}

function mergeIndexJson(survivor: string, others: readonly string[]): void {
	const survivorMm = new MetadataManager(join(survivor, ".jolli"));
	const base = survivorMm.readIndex();
	const byHash = new Map<string, SummaryIndex["entries"][number]>();
	const aliases: Record<string, string> = {};
	let version: SummaryIndex["version"] = base?.version ?? 3;

	// Survivor first so its entries win on conflict.
	const sources = [survivor, ...others];
	for (const root of sources) {
		const idx = new MetadataManager(join(root, ".jolli")).readIndex();
		if (!idx) continue;
		if (root === survivor) version = idx.version;
		for (const [k, v] of Object.entries(idx.commitAliases ?? {})) {
			if (!(k in aliases)) aliases[k] = v;
		}
		for (const entry of idx.entries ?? []) {
			if (entry?.commitHash && !byHash.has(entry.commitHash)) byHash.set(entry.commitHash, entry);
		}
	}

	const merged: SummaryIndex = {
		version,
		entries: [...byHash.values()],
		...(Object.keys(aliases).length > 0 ? { commitAliases: aliases } : {}),
	};
	atomicWriteJson(join(survivor, ".jolli", "index.json"), merged);
}

function mergeManifestJson(survivor: string, others: readonly string[]): void {
	const byId = new Map<string, Manifest["files"][number]>();
	let version = 1;
	for (const root of [survivor, ...others]) {
		const manifest = new MetadataManager(join(root, ".jolli")).readManifest();
		if (root === survivor) version = manifest.version;
		for (const file of manifest.files) {
			if (file?.fileId && !byId.has(file.fileId)) byId.set(file.fileId, file);
		}
	}
	atomicWriteJson(join(survivor, ".jolli", "manifest.json"), { version, files: [...byId.values()] });
}

function mergeBranchesJson(survivor: string, others: readonly string[]): void {
	const byBranch = new Map<string, BranchesJson["mappings"][number]>();
	let version = 1;
	for (const root of [survivor, ...others]) {
		const branches = new MetadataManager(join(root, ".jolli")).readBranches();
		if (root === survivor) version = branches.version;
		for (const mapping of branches.mappings) {
			if (mapping?.branch && !byBranch.has(mapping.branch)) byBranch.set(mapping.branch, mapping);
		}
	}
	atomicWriteJson(join(survivor, ".jolli", "branches.json"), { version, mappings: [...byBranch.values()] });
}

// ── Filesystem helpers ───────────────────────────────────────────────────────

/** Recursively copies files from `src` into `dst`, skipping any that already exist. */
function copyTreeIfAbsent(src: string, dst: string): void {
	walkFiles(src, (absPath) => {
		const rel = toForwardSlash(relative(src, absPath));
		if (MERGED_OR_OWNED_META.has(rel)) return;
		// Never descend into a nested archive or a git dir (per-repo folders have
		// neither, but the Memory Bank root can — belt and braces).
		if (rel.startsWith(".jolli/archive/") || rel === ".git" || rel.startsWith(".git/")) return;
		const target = join(dst, rel);
		if (existsSync(target)) return;
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(absPath, target);
	});
}

function walkFiles(dir: string, onFile: (absPath: string) => void): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		/* v8 ignore next -- defensive: an unreadable subdir mid-walk (permission/race); skip it rather than abort the merge */
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "archive" || entry.name === ".git") continue;
			walkFiles(full, onFile);
		} else if (entry.isFile()) {
			onFile(full);
		}
	}
}

function readSummaryHashes(folderRoot: string): Set<string> {
	const out = new Set<string>();
	let names: string[];
	try {
		names = readdirSync(join(folderRoot, ".jolli", "summaries"));
	} catch {
		return out;
	}
	for (const name of names) {
		if (name.endsWith(".json")) out.add(name.slice(0, -".json".length));
	}
	return out;
}

async function readOrphanSummaryHashes(cwd: string): Promise<Set<string>> {
	const out = new Set<string>();
	try {
		const sot = await sotResolver(cwd);
		if (!(await sot.exists())) return out;
		for (const path of await sot.listFiles("summaries")) {
			const name = basename(path);
			if (name.endsWith(".json")) out.add(name.slice(0, -".json".length));
		}
	} catch (err) {
		// Treat an unreadable source of truth as empty → the safe `union-largest`
		// branch (fold folders together) rather than a rebuild that could drop data.
		log.warn("readOrphanSummaryHashes failed: %s", err instanceof Error ? err.message : String(err));
	}
	return out;
}

function atomicWriteJson(path: string, obj: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(obj, null, "\t"), "utf-8");
	renameSync(tmp, path);
}

// ── Set / selection helpers ──────────────────────────────────────────────────

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const v of a) if (!b.has(v)) return false;
	return true;
}

function isSubset(subset: Set<string>, superset: Set<string>): boolean {
	for (const v of subset) if (!superset.has(v)) return false;
	return true;
}

/** Folder with the shortest basename; ties broken lexicographically for determinism. */
function shortestNamed(folders: readonly string[]): string {
	return [...folders].sort((a, b) => {
		const la = basename(a).length;
		const lb = basename(b).length;
		return la !== lb ? la - lb : basename(a).localeCompare(basename(b));
	})[0];
}

/** Folder with the most summaries; ties broken by {@link shortestNamed}. */
function largestNamed(folders: readonly string[], perFolder: Readonly<Record<string, number>>): string {
	const max = Math.max(...folders.map((f) => perFolder[f] ?? 0));
	const tied = folders.filter((f) => (perFolder[f] ?? 0) === max);
	return shortestNamed(tied);
}

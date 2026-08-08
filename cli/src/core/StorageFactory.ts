/**
 * StorageFactory — creates the StorageProvider the CUTOVER STATE dictates.
 *
 * `storageMode` is retired (phase D): a residual config value is ignored with
 * a log line — it was a config-only backdoor that could route writes around
 * the source of truth ("folder" never wrote the database at all). Routing is
 * now the four-state cutover table:
 *
 * - `uncutover`      → orphan + FolderStorage dual-write (the orphan branch
 *                       is the source of truth)
 * - `legacy-fenced`  → SqliteStorage + FolderStorage dual-write: the orphan
 *                       branch is frozen while the CAS is pending, and writing
 *                       it would strand data
 * - `cutover`        → SqliteStorage + FolderStorage dual-write
 * - `blocked`        → throw: a fenced/cut-over repo whose database is
 *                       unavailable has NOWHERE safe to write — falling back
 *                       to orphan is exactly the loss the fence prevents
 *
 * DUAL-WRITE IS INVARIANT across all three writable states: one write to the
 * system of record, one full write to the Memory Bank folder. The cutover only
 * swaps WHICH backend is the system of record; it never narrows the folder
 * side. (The folder side is skipped only when the project is not claimable —
 * a temp dir must not materialize a Memory Bank folder.)
 *
 * Neither fenced state is reachable in production until the cutover engine
 * (D4) starts writing fences, so landing the routing first is safe.
 */

import { join } from "node:path";
import { resolveCutoverRoute } from "../dashboard/CutoverRouter.js";
import { resolveRepoIdentityForCwd } from "../dashboard/RepoRegistry.js";
import { createLogger } from "../Logger.js";
import { DualWriteStorage } from "./DualWriteStorage.js";
import { FolderStorage } from "./FolderStorage.js";
import { extractRepoName, getRemoteUrl, isClaimableProject, resolveKBPath } from "./KBPathResolver.js";
import { MetadataManager } from "./MetadataManager.js";
import { OrphanBranchStorage } from "./OrphanBranchStorage.js";
import { loadConfig } from "./SessionTracker.js";
import { SqliteStorage } from "./SqliteStorage.js";
import type { StorageProvider } from "./StorageProvider.js";

const log = createLogger("StorageFactory");

export async function createStorage(projectPath: string, cwd?: string): Promise<StorageProvider> {
	let config: Record<string, unknown>;
	try {
		config = (await loadConfig()) as Record<string, unknown>;
	} catch (err) {
		log.warn("Failed to load config, falling back to defaults: %s", (err as Error).message);
		config = {};
	}
	if (config.storageMode !== undefined) {
		// Retired key. "folder" users revert to dual-write until this repo cuts
		// over — acceptable, because folder-only meant the memories were never
		// in the source of truth to begin with.
		log.info("ignoring retired storageMode=%s — routing is decided by the cutover state", config.storageMode);
	}
	const customKBPath = config.localFolder as string | undefined;

	const route = await resolveCutoverRoute(projectPath);
	log.info("StorageFactory.create: route=%s, projectPath=%s", route.state, projectPath);

	if (route.state === "blocked") {
		throw new Error(
			`storage unavailable: ${route.reason} — this repo's orphan branch is frozen (cutover), ` +
				"so writes cannot fall back to it; run 'jolli doctor --recover' or upgrade this surface",
		);
	}
	if (route.state === "legacy-fenced" || route.state === "cutover") {
		const { identity } = await resolveRepoIdentityForCwd(projectPath);
		const sqlite = new SqliteStorage(identity);
		// Dual-write is INVARIANT across the cutover: one write to the system of
		// record, one full write to the Memory Bank. All the cutover changes is
		// which backend is the system of record — SQLite here instead of the
		// orphan branch. The folder side stays identical to the uncutover route,
		// hidden JSON included, because that layer is what the Memory Bank sync,
		// the IntelliJ sidebar reader and mirror-based recovery consume. Same
		// claimable gate as below — a temp dir must not claim a Memory Bank folder.
		if (isClaimableProject(projectPath, customKBPath)) {
			return new DualWriteStorage(sqlite, createFolderStorage(projectPath, customKBPath));
		}
		return sqlite;
	}

	// uncutover — today's behavior, orphan branch authoritative.
	// Write-boundary gate: a non-project cwd (an agent's throwaway temp dir, the
	// Memory Bank folder itself, a bare `/tmp`) must never claim a folder under
	// `localFolder`. Degrade to orphan-only instead of materializing junk that
	// only the user can clean up. See KBPathResolver.isClaimableProject.
	if (!isClaimableProject(projectPath, customKBPath)) {
		log.warn(
			"Not a claimable project (no git worktree, or inside the Memory Bank folder): %s — using orphan-only storage",
			projectPath,
		);
		return new OrphanBranchStorage(cwd);
	}
	const orphan = new OrphanBranchStorage(cwd);
	const folder = createFolderStorage(projectPath, customKBPath);
	return new DualWriteStorage(orphan, folder);
}

/**
 * Builds a FolderStorage rooted at `<localFolder>/<repoName>/` for the given
 * project. Single source of truth for the kbRoot derivation so `createStorage`
 * (write path) and any caller that needs a read-only FolderStorage instance
 * (e.g. the VS Code bridge's `getReadStorage`) stay in lockstep — picking the
 * same `extractRepoName` / `getRemoteUrl` / `resolveKBPath` chain.
 */
export function createFolderStorage(projectPath: string, customKBPath?: string): FolderStorage {
	const repoName = extractRepoName(projectPath);
	const remoteUrl = getRemoteUrl(projectPath);
	const kbRoot = resolveKBPath(repoName, remoteUrl, customKBPath);
	const metadataManager = new MetadataManager(join(kbRoot, ".jolli"));
	return new FolderStorage(kbRoot, metadataManager);
}

/**
 * Builds a folder-only FolderStorage at an explicit kbRoot — for the multi-repo
 * compile sweep, where the target repo has no git working tree (only its
 * `<localFolder>/<repo>/` folder). No orphan side: swept repos write folder-only.
 */
export function createFolderStorageAtRoot(kbRoot: string): FolderStorage {
	return new FolderStorage(kbRoot, new MetadataManager(join(kbRoot, ".jolli")));
}

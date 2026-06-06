/**
 * StorageFactory — creates the appropriate StorageProvider based on config.
 *
 * Storage modes:
 * - "orphan" (default): OrphanBranchStorage only
 * - "dual-write": writes to both orphan branch and folder, reads from orphan
 * - "folder": FolderStorage only
 */

import { join } from "node:path";
import { createLogger } from "../Logger.js";
import { DualWriteStorage } from "./DualWriteStorage.js";
import { FolderStorage } from "./FolderStorage.js";
import { extractRepoName, getRemoteUrl, resolveKBPath } from "./KBPathResolver.js";
import { MetadataManager } from "./MetadataManager.js";
import { OrphanBranchStorage } from "./OrphanBranchStorage.js";
import { loadConfig } from "./SessionTracker.js";
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
	const mode = (config.storageMode as string | undefined) ?? "dual-write";
	// `localFolder` is the user-configured KB parent directory (set via the
	// VS Code Settings panel's "Local Folder" input). `resolveKBPath` appends
	// the repo name as a subfolder, so `localFolder=~/MyKB` puts this repo at
	// `~/MyKB/<repoName>/`.
	const customKBPath = config.localFolder as string | undefined;

	log.info("StorageFactory.create: storageMode=%s, projectPath=%s", mode, projectPath);

	switch (mode) {
		case "dual-write": {
			const orphan = new OrphanBranchStorage(cwd);
			const folder = createFolderStorage(projectPath, customKBPath);
			log.info("Storage mode: dual-write (primary=orphan, shadow=folder)");
			return new DualWriteStorage(orphan, folder);
		}
		case "folder": {
			log.info("Storage mode: folder");
			return createFolderStorage(projectPath, customKBPath);
		}
		default: {
			log.info("Storage mode: orphan (default)");
			return new OrphanBranchStorage(cwd);
		}
	}
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

/**
 * ReadStorageResolver — picks the appropriate read-side StorageProvider for a
 * given project, mirroring the dispatch logic that lives in VSCode's
 * `JolliMemoryBridge.createReadStorage`.
 *
 * spec 110 — CLI compile/recall code paths historically read via the default
 * StorageProvider (which in dual-write mode resolves to `OrphanBranchStorage`
 * as the primary). VSCode instead reads from `FolderStorage` directly (with a
 * fallback to orphan when the folder layer is incomplete). Compile must use
 * the same view as the VSCode UI: otherwise the LLM works from a different
 * snapshot than what the user sees, and downstream wiki / cache fingerprints
 * drift between the two surfaces.
 *
 * Three legitimate fallback-to-orphan paths in dual-write mode:
 *   1. Fresh install where MigrationEngine hasn't run yet.
 *   2. User wiped `<localFolder>/<repo>/.jolli/` while orphan still has data.
 *   3. Folder shadow is dirty (last write to shadow failed) — orphan holds
 *      the authoritative copy.
 *
 * Unknown `storageMode` values fall back to orphan on both read and write
 * sides (see `StorageFactory.createStorage`) so a config typo doesn't split
 * the storage layer mid-pipeline.
 */

import { createLogger } from "../Logger.js";
import { OrphanBranchStorage } from "./OrphanBranchStorage.js";
import { loadConfig } from "./SessionTracker.js";
import { createFolderStorage } from "./StorageFactory.js";
import type { StorageProvider } from "./StorageProvider.js";

const log = createLogger("ReadStorageResolver");

/**
 * Returns the appropriate read-side StorageProvider for `cwd`.
 *
 * Caller is responsible for caching when applicable — this function does
 * fresh `loadConfig()` + (in dual-write mode) `folder.readFile("index.json")`
 * probes every call. VSCode's `JolliMemoryBridge` memoizes the result and
 * invalidates on settings-save; CLI call sites (one-shot compile / recall)
 * typically don't need caching because they exit after a single read pass.
 */
export async function createReadStorage(cwd: string): Promise<StorageProvider> {
	const config = (await loadConfig()) as Record<string, unknown>;
	const mode = (config.storageMode as string | undefined) ?? "dual-write";

	switch (mode) {
		case "orphan":
			return new OrphanBranchStorage(cwd);
		case "folder":
			return createFolderStorage(cwd, config.localFolder as string | undefined);
		case "dual-write": {
			const folder = createFolderStorage(cwd, config.localFolder as string | undefined);
			if ((await folder.readFile("index.json")) === null) {
				log.warn(
					"createReadStorage: folder lacks index.json — falling back to orphan branch (migration incomplete, or folder wiped)",
				);
				return new OrphanBranchStorage(cwd);
			}
			if (folder.isDirty?.()) {
				log.warn(
					"createReadStorage: folder shadow is dirty — falling back to orphan branch (last shadow write failed)",
				);
				return new OrphanBranchStorage(cwd);
			}
			return folder;
		}
		default:
			log.warn("createReadStorage: unknown storageMode=%s — defaulting to orphan branch", mode);
			return new OrphanBranchStorage(cwd);
	}
}

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
 * Three legitimate fallback-to-orphan paths in the pre-cutover (`uncutover`)
 * state:
 *   1. Fresh install where MigrationEngine hasn't run yet.
 *   2. User wiped `<localFolder>/<repo>/.jolli/` while orphan still has data.
 *   3. Folder shadow is dirty (last write to shadow failed) — orphan holds
 *      the authoritative copy.
 *
 * Unknown `storageMode` values fall back to orphan in that state (see
 * `StorageFactory.createStorage`) so a config typo doesn't split the storage
 * layer mid-pipeline.
 *
 * `storageMode`-driven dispatch below only runs in `uncutover` — the same gate
 * `StorageFactory.createStorage` applies on the write side. `legacy-fenced`
 * and `cutover` route straight to `SqliteStorage` regardless of `storageMode`
 * (a residual value there is retired, not a live read-mode switch): without
 * this, `GenerateCommand` / `SourceTimeline` / `IngestPipeline` would keep
 * reading FolderStorage/OrphanBranchStorage off a stale config key after the
 * repo's orphan branch froze, silently working from the wrong backend instead
 * of the SQLite database the write side already cut over to.
 */

import { resolveCutoverRoute } from "../dashboard/CutoverRouter.js";
import { resolveRepoIdentityForCwd } from "../dashboard/RepoRegistry.js";
import { createLogger } from "../Logger.js";
import { isClaimableProject } from "./KBPathResolver.js";
import { OrphanBranchStorage } from "./OrphanBranchStorage.js";
import { loadConfig } from "./SessionTracker.js";
import { SqliteStorage } from "./SqliteStorage.js";
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
 *
 * READ side, but still gated by `isClaimableProject`: `createFolderStorage`
 * resolves its kbRoot through `resolveKBPath`, which *claims* the folder it
 * returns. So a read from a non-project cwd creates the very junk folder the
 * write-side gate exists to prevent — the gate has to sit on every caller of
 * `createFolderStorage`, not just `StorageFactory.createStorage`. Degrading to
 * orphan costs nothing here: in dual-write the folder probe would have missed
 * (`index.json` absent in a folder that only just came into existence) and
 * fallen back to orphan anyway — just after leaving the folder behind. The
 * SQLite routes below never touch `createFolderStorage`, so they need no
 * claimable check at all.
 */
export async function createReadStorage(cwd: string): Promise<StorageProvider> {
	const route = await resolveCutoverRoute(cwd);
	if (route.state === "blocked") {
		throw new Error(
			`storage unavailable: ${route.reason} — this repo's orphan branch is frozen (cutover), ` +
				"so reads cannot fall back to it; run 'jolli doctor --recover' or upgrade this surface",
		);
	}
	if (route.state === "legacy-fenced" || route.state === "cutover") {
		const { identity } = await resolveRepoIdentityForCwd(cwd);
		return new SqliteStorage(identity);
	}

	const config = (await loadConfig()) as Record<string, unknown>;
	const mode = (config.storageMode as string | undefined) ?? "dual-write";

	// Same shape as `StorageFactory.createStorage`: skipped entirely in orphan
	// mode (no folder is touched there, so the gate's git subprocess would be
	// pure overhead), consulted for every mode that can reach the folder layer.
	if (mode !== "orphan" && !isClaimableProject(cwd, config.localFolder as string | undefined)) {
		log.warn(
			"createReadStorage: not a claimable project (no git worktree, or inside the Memory Bank folder): %s — reading from the orphan branch instead of %s",
			cwd,
			mode,
		);
		return new OrphanBranchStorage(cwd);
	}

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

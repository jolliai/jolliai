/**
 * MemoryBankMigration — shared orphan-branch → Memory Bank folder migration
 * entry point.
 *
 * Wraps the `MigrationEngine` folder migration with its surrounding steps for
 * callers that cannot import the engine in-process: the ide-bridge
 * `migrate-memory-bank` action (IdeBridgeCommand.ts) runs this on behalf of
 * the IntelliJ plugin over the daemon / one-shot bridge transport. VS Code
 * bundles `cli/src/**` and runs `MigrationEngine.runMigration()` directly
 * from its `activate()` path.
 *
 * Behaviour mirrors `ensureKBInitAndMigrated` in SyncCommand.ts (the
 * canonical shared step, itself a mirror of the VS Code `initializeKB()`
 * block):
 *   - no orphan branch yet → nothing to migrate, report an empty completed run
 *   - migration not completed → full `runMigration()` (copies summaries /
 *     transcripts / plans / notes onto disk)
 *   - already completed → idempotent `runStaleChildCleanup()` reconcile, so
 *     the "visible folder shows only heads" invariant self-heals on every
 *     startup exactly as it does for VS Code
 *
 * Like `jolli sync-memory-bank`, this does NOT require a Jolli sign-in: the
 * local folder migration is on by default and must run even for users who
 * never connect a Personal Space.
 */

import { join } from "node:path";
import { FolderStorage } from "./FolderStorage.js";
import { extractRepoName, getRemoteUrl, resolveKBPath } from "./KBPathResolver.js";
import { MetadataManager } from "./MetadataManager.js";
import { MigrationEngine } from "./MigrationEngine.js";
import { OrphanBranchStorage } from "./OrphanBranchStorage.js";
import { loadConfig } from "./SessionTracker.js";

/** The subset of MigrationState the IDE caller needs for its status line. */
interface MigrateResult {
	readonly status: string;
	readonly totalEntries: number;
	readonly migratedEntries: number;
}

/**
 * Runs the orphan → folder migration for [cwd], resolving the Memory Bank root
 * from the shared config exactly as `ensureKBInitAndMigrated` does. Exported for
 * unit tests. Never touches the orphan branch as anything but a read source.
 */
export async function runMemoryBankMigration(cwd: string): Promise<MigrateResult> {
	const config = await loadConfig();
	const repoName = extractRepoName(cwd);
	const remoteUrl = getRemoteUrl(cwd);
	const kbRoot = resolveKBPath(repoName, remoteUrl, config.localFolder);

	const orphan = new OrphanBranchStorage(cwd);
	if (!(await orphan.exists())) {
		return { status: "completed", totalEntries: 0, migratedEntries: 0 };
	}

	const mm = new MetadataManager(join(kbRoot, ".jolli"));
	const folder = new FolderStorage(kbRoot, mm);
	await folder.ensure();
	const engine = new MigrationEngine(orphan, folder, mm);

	const state = mm.readMigrationState();
	if (!state || state.status !== "completed") {
		const result = await engine.runMigration();
		return {
			status: result.status,
			totalEntries: result.totalEntries,
			migratedEntries: result.migratedEntries,
		};
	}

	// Already migrated: run the idempotent stale-child reconcile every startup,
	// matching the VS Code activate path (see MigrationEngine.runStaleChildCleanup).
	const reconciled = await engine.runStaleChildCleanup();
	return {
		status: reconciled.status,
		totalEntries: reconciled.totalEntries,
		migratedEntries: reconciled.migratedEntries,
	};
}

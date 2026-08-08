/**
 * MemoryBankMigration — shared system-of-record → Memory Bank folder migration
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
 *   - the system of record holds nothing yet → nothing to migrate, report an
 *     empty completed run
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
import { loadConfig } from "./SessionTracker.js";
import { resolveSotStorage } from "./SotStorageResolver.js";

/** The subset of MigrationState the IDE caller needs for its status line. */
interface MigrateResult {
	readonly status: string;
	readonly totalEntries: number;
	readonly migratedEntries: number;
}

/**
 * Runs the system-of-record → folder migration for [cwd], resolving the Memory
 * Bank root from the shared config exactly as `ensureKBInitAndMigrated` does.
 * Exported for unit tests. Never touches the source as anything but a read.
 */
export async function runMemoryBankMigration(cwd: string): Promise<MigrateResult> {
	const config = await loadConfig();
	const repoName = extractRepoName(cwd);
	const remoteUrl = getRemoteUrl(cwd);
	const kbRoot = resolveKBPath(repoName, remoteUrl, config.localFolder);

	// Resolved by route, not hard-coded to the orphan branch: past a cutover
	// that branch is frozen, and a clone made after one has no branch at all —
	// which reported "nothing to migrate" and produced an empty Memory Bank.
	const sot = await resolveSotStorage(cwd);
	if (!(await sot.exists())) {
		return { status: "completed", totalEntries: 0, migratedEntries: 0 };
	}

	const mm = new MetadataManager(join(kbRoot, ".jolli"));
	const folder = new FolderStorage(kbRoot, mm);
	await folder.ensure();
	const engine = new MigrationEngine(sot, folder, mm);

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

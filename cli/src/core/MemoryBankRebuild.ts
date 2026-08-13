/**
 * MemoryBankRebuild — the "Migrate to Memory Bank" orchestration, extracted from
 * the VS Code command body (`jollimemory.rebuildKnowledgeBase`) into shared core
 * so the dashboard server, VS Code and any future host all drive the SAME steps.
 * Before this it lived only in the extension; there was no single core routine
 * and no CLI command (`jolli migrate` is the unrelated schema migration), so a
 * second host could only re-implement it and drift.
 *
 * The sequence is load-bearing: archive EVERY existing folder for the repo
 * FIRST (freeing the canonical base slot so the migration lands back on `<repo>`
 * instead of climbing to `<repo>-N`), then claim the freed slot and migrate from
 * the system of record (the orphan branch) into it. Safe to archive before
 * migrating because the migration source is the orphan branch, not these
 * folders — a crash mid-migrate self-heals on the next activation.
 *
 * Host-side concerns (sidebar refreshes, cache invalidation) stay in the host;
 * this returns only the outcome.
 */

import { readManualDisableFlag } from "./RepoProfile.js";

export interface MemoryBankRebuildResult {
	readonly ok: boolean;
	readonly message: string;
	/** The folder migrated into, when the rebuild ran. */
	readonly folder?: string;
}

export interface MemoryBankRebuildOptions {
	/**
	 * Vault-lock wait budget. Defaults to `DEFAULT_PULL_LOCK_WAIT_MS` (10 s) —
	 * long enough to sit out a summary write, short enough that a user who clicked
	 * Migrate gets an answer. A test seam only; no production caller sets it.
	 */
	readonly lockWaitMs?: number;
}

/**
 * Re-migrates the repo at `cwd` from the orphan branch into a fresh Memory Bank
 * folder (the previous folders are archived, not deleted). Refuses when the repo
 * is manually disabled, when there are no stored memories to rebuild, or when
 * another vault writer holds `vault-write.lock`.
 *
 * The lock is not optional. This archives EVERY folder for the repo and then
 * re-migrates into the freed slot — a multi-second, many-file rewrite of the same
 * working tree a QueueWorker drain, a sync round or a compile may be mid-write in.
 * Unlocked, it tore across their `git status` snapshots exactly the way
 * `KbFoldersService`'s two sweeps are locked to prevent. Being a plain file lock
 * that refuses even its own PID, it doubles as the in-flight guard: a second
 * concurrent call in THIS process (a double-clicked button, two hosts driving one
 * CLI) is reported busy rather than archiving what the first just created.
 */
export async function rebuildMemoryBank(
	cwd: string,
	opts: MemoryBankRebuildOptions = {},
): Promise<MemoryBankRebuildResult> {
	// While manually disabled, `folder.ensure()` and the repoint would run even
	// though the identity write is gated — one call would de-identify the old
	// folder while migrating nothing. Refuse outright, as the VS Code command does.
	if (await readManualDisableFlag(cwd)) {
		return { ok: false, message: "Jolli Memory is disabled for this project — enable it first." };
	}

	const { resolveKbParent } = await import("./KBPathResolver.js");
	const { loadConfig: loadConfigForVault } = await import("./SessionTracker.js");
	const { DEFAULT_PULL_LOCK_WAIT_MS, withVaultWriteLock } = await import("../sync/VaultWriteLock.js");
	const vaultRoot = resolveKbParent((await loadConfigForVault()).localFolder);
	const outcome = await withVaultWriteLock(
		vaultRoot,
		{ wait: opts.lockWaitMs ?? DEFAULT_PULL_LOCK_WAIT_MS },
		() => rebuildLocked(cwd),
		{
			// Same contract as every other holder: wake a QueueWorker that timed out
			// waiting on this lock. Imported inside the lambda so the ordinary path
			// never pulls QueueWorker's reader/detector graph into a migrate.
			/* v8 ignore start -- fires only when a worker is actually queued behind this lock */
			launch: (workerCwd: string): void => {
				void import("../hooks/QueueWorker.js").then(({ launchWorker }) => launchWorker(workerCwd));
			},
			/* v8 ignore stop */
		},
	);
	if (!outcome.ran) {
		return {
			ok: false,
			message: "Jolli Memory is busy writing to the Memory Bank right now — try again shortly.",
		};
	}
	return outcome.value;
}

/** The archive-then-migrate sequence, always run while holding `vault-write.lock`. */
async function rebuildLocked(cwd: string): Promise<MemoryBankRebuildResult> {
	const { extractRepoName, getRemoteUrl, initializeKBFolder, findRepoFolders, peekKBPath, archiveKBFolder } =
		await import("./KBPathResolver.js");
	const { MetadataManager } = await import("./MetadataManager.js");
	const { resolveSotStorage } = await import("./SotStorageResolver.js");
	const { detectStoredMemories } = await import("./StoredMemories.js");
	const { FolderStorage } = await import("./FolderStorage.js");
	const { MigrationEngine } = await import("./MigrationEngine.js");
	const { join } = await import("node:path");
	const { loadConfig } = await import("./SessionTracker.js");

	const repoName = extractRepoName(cwd);
	const remoteUrl = getRemoteUrl(cwd);
	const config = await loadConfig();
	const customKBPath = config.localFolder;

	const sot = await resolveSotStorage(cwd);
	// NOT `exists()`: this archives every existing folder before re-migrating, and
	// past a cutover `exists()` is true for any enabled repo. `unknown` (a read
	// failure) exits like `none` — the destructive path must never run on a guess.
	const presence = await detectStoredMemories(sot);
	if (presence !== "some") {
		return {
			ok: false,
			message:
				presence === "none"
					? "No stored memories found — nothing to rebuild."
					: "Could not read stored memories — leaving the Memory Bank untouched.",
		};
	}

	// Archive the whole pile FIRST (base `<repo>` slot included) so the migration
	// below lands on the canonical base name rather than climbing to `<repo>-N`.
	for (const stale of findRepoFolders(repoName, remoteUrl, customKBPath)) {
		archiveKBFolder(stale, customKBPath);
	}

	const newKbRoot = peekKBPath(repoName, remoteUrl, customKBPath);
	initializeKBFolder(newKbRoot, repoName, remoteUrl);

	const mm = new MetadataManager(join(newKbRoot, ".jolli"));
	const folder = new FolderStorage(newKbRoot, mm);
	await folder.ensure();
	const engine = new MigrationEngine(sot, folder, mm);
	const result = await engine.runMigration();

	if (result.status === "completed") {
		return { ok: true, message: `${result.migratedEntries} memories migrated to ${newKbRoot}`, folder: newKbRoot };
	}
	return {
		ok: false,
		message: `Rebuild ${result.status}: ${result.migratedEntries}/${result.totalEntries} entries (${newKbRoot})`,
		folder: newKbRoot,
	};
}

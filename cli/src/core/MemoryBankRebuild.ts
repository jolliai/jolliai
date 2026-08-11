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

/**
 * Re-migrates the repo at `cwd` from the orphan branch into a fresh Memory Bank
 * folder (the previous folders are archived, not deleted). Refuses when the repo
 * is manually disabled, or when there are no stored memories to rebuild.
 */
export async function rebuildMemoryBank(cwd: string): Promise<MemoryBankRebuildResult> {
	// While manually disabled, `folder.ensure()` and the repoint would run even
	// though the identity write is gated — one call would de-identify the old
	// folder while migrating nothing. Refuse outright, as the VS Code command does.
	if (await readManualDisableFlag(cwd)) {
		return { ok: false, message: "Jolli Memory is disabled for this project — enable it first." };
	}

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

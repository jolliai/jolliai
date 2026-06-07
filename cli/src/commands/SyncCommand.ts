/**
 * `jolli sync-memory-bank` — manually drive one Memory Bank sync round from
 * the terminal.
 *
 * The auto-sync polling timer lives in the IDE plugin (`StatusOrchestrator`).
 * This command exists for the cases the timer doesn't cover:
 *   - users who don't keep the IDE open
 *   - scripted environments (CI, devcontainer setup)
 *   - debugging a sync issue without bouncing the IDE
 *
 * Plan §0.7: the only precondition is a valid `jolliApiKey`; `autoSyncEnabled`
 * gates the polling tick, not manual rounds. `buildSyncEngine` returns null
 * when the user isn't signed in — we surface that as an actionable hint
 * pointing at `jolli auth login`, mirroring the IDE's "open Settings" toast.
 *
 * Conflict policy: the CLI cannot meaningfully prompt for a binary pick
 * (no diff viewer, no live conflicts panel), so the injected `ConflictUi`
 * always returns "skip". Skipped conflict paths are printed to stdout so
 * the user can resolve them manually in their editor — there is no
 * persisted conflicts store today (see backlog: wire SyncStateStore
 * recordConflict + IDE Conflicts panel end-to-end).
 */

import { join } from "node:path";
import type { Command } from "commander";
import { FolderStorage } from "../core/FolderStorage.js";
import { extractRepoName, getRemoteUrl, resolveKBPath } from "../core/KBPathResolver.js";
import { MetadataManager } from "../core/MetadataManager.js";
import { MigrationEngine } from "../core/MigrationEngine.js";
import { OrphanBranchStorage } from "../core/OrphanBranchStorage.js";
import { loadConfig } from "../core/SessionTracker.js";
import { createLogger, errMsg, setLogDir } from "../Logger.js";
import { CliConflictUi } from "../sync/CliConflictUi.js";
import { buildSyncEngine } from "../sync/SyncBootstrap.js";
import type { SyncRoundResult } from "../sync/SyncTypes.js";
import { resolveProjectDir } from "./CliUtils.js";

const log = createLogger("sync");

interface SyncCommandOptions {
	readonly cwd: string;
	readonly transcripts?: boolean;
}

export async function runSync(options: SyncCommandOptions): Promise<number> {
	const config = await loadConfig();
	if (!config.jolliApiKey) {
		console.error("\n  Sync requires a Jolli sign-in. Run `jolli auth login` and try again.\n");
		return 1;
	}

	// Claim the Memory Bank folder for this repo and run the orphan→folder
	// migration if needed. The VS Code activate path does this on every
	// window open; without an equivalent step here, a CLI-only user whose
	// pre-0.99 memory still lives on the orphan branch would push an empty
	// FolderStorage to Personal Space and never sync the real data (P3#7).
	try {
		await ensureKBInitAndMigrated(options.cwd, config.localFolder);
	} catch (err) {
		// Don't hard-fail on migration errors — the round can still sync
		// whatever did make it to disk. Surface as a warning so the user
		// knows something is off; the next `jolli sync-memory-bank` will
		// retry the migration.
		console.error(`\n  Warning: Memory Bank init/migration partial failure: ${errMsg(err)}\n`);
		log.warn("ensureKBInitAndMigrated threw: %s", errMsg(err));
	}

	let engine: Awaited<ReturnType<typeof buildSyncEngine>>;
	try {
		engine = await buildSyncEngine({ cwd: options.cwd, ui: new CliConflictUi() });
	} catch (err) {
		console.error(`\n  Sync aborted: ${errMsg(err)}\n`);
		log.error("buildSyncEngine threw: %s", errMsg(err));
		return 1;
	}

	if (engine === null) {
		// buildSyncEngine only returns null when jolliApiKey is missing, but
		// loadConfig races with `auth logout`. Keep the message aligned with
		// the precondition check above.
		console.error("\n  Sync dormant: signed-out state detected mid-round. Run `jolli auth login`.\n");
		return 1;
	}

	const transcripts = options.transcripts === true || config.syncTranscripts === true;
	console.log("\n  Syncing Memory Bank to Personal Space…");

	let result: SyncRoundResult;
	try {
		result = await engine.runRound({ cwd: options.cwd, reason: "manual", transcripts });
	} catch (err) {
		console.error(`\n  Sync failed: ${errMsg(err)}\n`);
		log.error("runRound threw: %s", errMsg(err));
		return 1;
	}

	return reportResult(result);
}

function reportResult(result: SyncRoundResult): number {
	const { newState, pushed, pulled, fetched, conflicts, lastError } = result;
	switch (newState) {
		case "synced":
			console.log(
				`  Synced. fetched=${fetched} pulled=${pulled} pushed=${pushed} conflicts=${conflicts.length}\n`,
			);
			return 0;
		case "syncing":
			// Another process (likely the IDE's polling tick) holds sync.lock.
			// Not an error — the in-flight round will finish the work.
			console.log("  Another sync round is already in flight (lock held). Skipped.\n");
			return 0;
		case "conflicts": {
			const paths = conflicts.map((c) => `    ${c.path}`).join("\n");
			console.log(
				`  Sync completed with ${conflicts.length} unresolved conflict(s):\n` +
					`${paths}\n` +
					"  Edit the file(s) to keep the version you want, then re-run `jolli sync-memory-bank`.\n",
			);
			return 0;
		}
		case "offline": {
			const code = lastError?.code ?? "unknown";
			const msg = lastError?.message ?? "no error message";
			console.error(`\n  Sync failed (${code}): ${msg}\n`);
			return 1;
		}
	}
}

/**
 * Mirror of the VS Code activate-time KB init + migration block (see
 * `vscode/src/Extension.ts initializeKB()`). Kept in sync structurally:
 *
 *   1. `resolveKBPath` claims `<localFolder>/<repo>/` and writes identity
 *      into `.jolli/config.json` so FolderStorage / sync see the same path.
 *   2. If an orphan branch exists and migration has not completed, run the
 *      full `MigrationEngine.runMigration()` to copy summaries / transcripts
 *      / plans / notes onto disk.
 *   3. If migration already completed but the v3 stale-child cleanup has
 *      not, run that idempotent pass.
 *
 * Behaviour matches the IDE path: this **must** run before `buildSyncEngine`
 * so the first push contains real Memory Bank content. The IDE version also
 * pokes the sidebar webview; the CLI has no sidebar so that step is dropped.
 * Exported for unit tests.
 */
export async function ensureKBInitAndMigrated(cwd: string, localFolder: string | undefined): Promise<void> {
	const repoName = extractRepoName(cwd);
	const remoteUrl = getRemoteUrl(cwd);
	const kbRoot = resolveKBPath(repoName, remoteUrl, localFolder);

	const orphan = new OrphanBranchStorage(cwd);
	if (!(await orphan.exists())) return;

	const mm = new MetadataManager(join(kbRoot, ".jolli"));
	const migrationState = mm.readMigrationState();
	if (!migrationState || migrationState.status !== "completed") {
		const folder = new FolderStorage(kbRoot, mm);
		await folder.ensure();
		const engine = new MigrationEngine(orphan, folder, mm);
		const result = await engine.runMigration();
		log.info("KB auto-migration: %s (%d/%d entries)", result.status, result.migratedEntries, result.totalEntries);
	} else {
		// Already migrated: run the stale-child reconcile every sync (not gated
		// on staleChildCleanup.completedAt — that stamp only retires the one-shot
		// 0.99.2 head-regen inside runStaleChildCleanup). Sweeps orphaned visible
		// .md for children hoisted on dormant branches the QueueWorker tail
		// cleanup never revisits.
		const folder = new FolderStorage(kbRoot, mm);
		await folder.ensure();
		const engine = new MigrationEngine(orphan, folder, mm);
		const result = await engine.runStaleChildCleanup();
		log.info(
			"KB stale-child reconcile: swept=%d completedAt=%s",
			result.swept,
			result.staleChildCleanup?.completedAt ?? "n/a",
		);
	}
}

export function registerSyncCommand(program: Command): void {
	program
		.command("sync-memory-bank")
		.description("Sync this repo's Memory Bank with your Personal Space")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.option("--transcripts", "Include raw transcripts in this round (overrides syncTranscripts config = true)")
		.action(async (options: { cwd: string; transcripts?: boolean }) => {
			setLogDir(options.cwd);
			log.info("Running 'sync' command");
			const exit = await runSync({
				cwd: options.cwd,
				transcripts: options.transcripts,
			});
			if (exit !== 0) process.exitCode = exit;
		});
}

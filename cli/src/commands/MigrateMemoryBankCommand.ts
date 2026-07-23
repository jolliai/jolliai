/**
 * MigrateMemoryBankCommand — hidden machine-facing bridge for the
 * orphan-branch → Memory Bank folder migration.
 *
 * `jolli migrate-memory-bank` exposes the `MigrationEngine` folder migration to
 * callers that cannot import it in-process. The VS Code extension bundles
 * `cli/src/**` and runs `MigrationEngine.runMigration()` directly from its
 * `activate()` path; the IntelliJ plugin is a JVM process, so it spawns
 * `node Cli.js migrate-memory-bank --cwd <dir>` and reads a single-line JSON
 * response from stdout.
 *
 * Behaviour mirrors `ensureKBInitAndMigrated` in SyncCommand.ts (the canonical
 * shared step, itself a mirror of the VS Code `initializeKB()` block):
 *   - no orphan branch yet → nothing to migrate, report an empty completed run
 *   - migration not completed → full `runMigration()` (copies summaries /
 *     transcripts / plans / notes onto disk)
 *   - already completed → idempotent `runStaleChildCleanup()` reconcile, so the
 *     "visible folder shows only heads" invariant self-heals on every startup
 *     exactly as it does for VS Code
 *
 * Unlike `jolli sync-memory-bank`, this does NOT require a Jolli sign-in: the
 * local folder migration is on by default and must run even for users who never
 * connect a Personal Space.
 *
 * Output contract (single line on stdout):
 *   - success — `{ "type": "migrate-memory-bank", "status": "…",
 *                  "totalEntries": <n>, "migratedEntries": <n> }`
 *   - failure — `{ "type": "error", "message": "…", "errorName": "…" }` with a
 *                non-zero exit code, matching the `generate` bridge so the
 *                IntelliJ plugin can reuse one JSON-response parser.
 *
 * The command is hidden from `jolli --help`: it is IDE plumbing.
 */

import { join } from "node:path";
import type { Command } from "commander";
import { FolderStorage } from "../core/FolderStorage.js";
import { extractRepoName, getRemoteUrl, resolveKBPath } from "../core/KBPathResolver.js";
import { MetadataManager } from "../core/MetadataManager.js";
import { MigrationEngine } from "../core/MigrationEngine.js";
import { OrphanBranchStorage } from "../core/OrphanBranchStorage.js";
import { loadConfig } from "../core/SessionTracker.js";
import { setLogDir } from "../Logger.js";
import { resolveProjectDir } from "./CliUtils.js";

interface MigrateMemoryBankOptions {
	cwd: string;
}

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

/**
 * Registers the hidden `migrate-memory-bank` command on the given program.
 */
export function registerMigrateMemoryBankCommand(program: Command): void {
	program
		.command("migrate-memory-bank", { hidden: true })
		.description("Orphan-branch → Memory Bank folder migration bridge for IDE plugins (JSON on stdout)")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: MigrateMemoryBankOptions) => {
			try {
				setLogDir(options.cwd);
				const result = await runMemoryBankMigration(options.cwd);
				console.log(JSON.stringify({ type: "migrate-memory-bank", ...result }));
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				const errorName = error instanceof Error ? error.name : "Error";
				console.log(JSON.stringify({ type: "error", message, errorName }));
				process.exitCode = 1;
			}
		});
}

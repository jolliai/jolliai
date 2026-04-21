/**
 * MigrateCommand — Migrate summaries to v3 format.
 *
 * Provides the `migrate` CLI command that converts orphan branch data
 * from v1 to v3 tree format and upgrades the index to v3 flat format.
 */

import type { Command } from "commander";
import { hasMigrationMeta, migrateV1toV3, writeMigrationMeta } from "../core/SummaryMigration.js";
import { indexNeedsMigration, migrateIndexToV3 } from "../core/SummaryStore.js";
import { createLogger, setLogDir } from "../Logger.js";
import { resolveProjectDir } from "./CliUtils.js";

const log = createLogger("MigrateCommand");

/**
 * Registers the `migrate` command on the given Commander program.
 */
export function registerMigrateCommand(program: Command): void {
	program
		.command("migrate")
		.description("Migrate summaries: v1 orphan branch → v3 tree format, then index v1 → v3 flat format")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: { cwd: string }) => {
			setLogDir(options.cwd);

			log.info("Running 'migrate' command");

			// Step 1: v1 orphan branch → v3 tree format
			const alreadyMigrated = await hasMigrationMeta(options.cwd);
			if (alreadyMigrated) {
				console.log(
					"\n  Orphan branch migration already completed. V1 branch retained for 48h as a safety net.",
				);
			} else {
				console.log("\n  Step 1: Migrating orphan branch to v3 tree format...");
				const { migrated, skipped } = await migrateV1toV3(options.cwd);

				if (migrated > 0) {
					console.log(`  Migrated: ${migrated} summaries converted to tree format`);
				}
				if (skipped > 0) {
					console.log(`  Skipped:  ${skipped} summaries (already in tree format or unparseable)`);
				}
				if (migrated === 0 && skipped === 0) {
					console.log("  No summaries found in v1 branch.");
				}
				if (migrated > 0 || skipped > 0) {
					await writeMigrationMeta(options.cwd);
					console.log("  V1 branch retained for 48 hours as a safety net.");
				}
			}

			// Step 2: index v1 → v3 flat format (all nodes with parentCommitHash + treeHash)
			console.log("\n  Step 2: Migrating index to v3 flat format...");
			const needsIndexMigration = await indexNeedsMigration(options.cwd);
			if (!needsIndexMigration) {
				console.log("  Index is already in v3 flat format.");
			} else {
				const { migrated: indexMigrated, skipped: indexSkipped } = await migrateIndexToV3(options.cwd);
				if (indexMigrated > 0) {
					console.log(`  Migrated: ${indexMigrated} index entries upgraded to v3 flat format`);
				}
				if (indexSkipped > 0) {
					console.log(`  Skipped:  ${indexSkipped} entries (summary file missing or unparseable)`);
				}
				if (indexMigrated === 0 && indexSkipped === 0) {
					console.log("  No index entries found.");
				}
			}

			console.log("");
		});
}

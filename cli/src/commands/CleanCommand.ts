/**
 * CleanCommand — Removes redundant/expired data that is safe to delete.
 *
 * Scope (vs `doctor`): clean handles cleanup; doctor handles faults.
 * The two commands have no overlapping checks.
 *
 * Targets:
 * 1. Stale sessions — sessions.json entries not updated for 48h.
 * 2. Stale queue entries — `.jolli/jollimemory/git-op-queue/*.json` older than 7 days.
 * 3. Stale squash-pending.json — older than 48h.
 *
 * NOTE: orphan `summaries/{childHash}.json` and `transcripts/{childHash}.json`
 * files are intentionally NOT deleted. Under the unified Hoist model (schema
 * v4), `stripFunctionalMetadata` removes topics + recap from embedded children
 * so the independent `summaries/{childHash}.json` file is the ONLY surviving
 * source of the child's original topics/recap. Transcripts have always been
 * by-hash artifacts that the display layer reads via
 * `collectAllTranscriptHashes`. Both files are tiny (KB) so disk savings would
 * be negligible; the audit / read-by-hash benefit of keeping them dominates.
 */

import type { Command } from "commander";
import {
	checkStaleSquashPending,
	countStaleQueueEntries,
	countStaleSessions,
	deleteSquashPending,
	pruneStaleQueueEntries,
	pruneStaleSessions,
} from "../core/SessionTracker.js";
import { createLogger, setLogDir } from "../Logger.js";
import { isInteractive, promptText, resolveProjectDir } from "./CliUtils.js";

const log = createLogger("clean");

/**
 * Removes redundant/expired data — cleanup operations that free disk space but
 * never affect functionality.
 */
async function runClean(cwd: string, dryRun: boolean, skipPrompt: boolean): Promise<void> {
	// 1. Stale sessions
	const staleSessionCount = await countStaleSessions(cwd);

	// 2. Stale queue entries
	const staleQueueCount = await countStaleQueueEntries(cwd);

	// 3. Stale squash-pending
	const hasStaleSquash = await checkStaleSquashPending(cwd);

	// Print summary
	console.log("\n  Jolli Memory Clean");
	console.log("  ──────────────────────────────────────");
	console.log(`  Stale sessions:       ${staleSessionCount} entries`);
	console.log(`  Stale Git queue:      ${staleQueueCount} entries`);
	console.log(`  Stale squash-pending: ${hasStaleSquash ? "1 file" : "none"}`);

	const totalItems = staleQueueCount + (hasStaleSquash ? 1 : 0) + staleSessionCount;

	if (totalItems === 0) {
		console.log("\n  Nothing to clean — all data is current.\n");
		return;
	}

	if (dryRun) {
		console.log(`\n  [dry-run] Would remove ${totalItems} item${totalItems === 1 ? "" : "s"}.\n`);
		return;
	}

	// Confirmation gate. `--yes` bypasses entirely; otherwise we must have a TTY
	// to prompt on. Refusing in non-TTY (rather than silently proceeding) keeps
	// the safety contract intact for CI, pipes, and redirected stdin — callers
	// that genuinely want unattended deletion pass `--yes` explicitly.
	if (!skipPrompt) {
		if (!isInteractive()) {
			console.error(
				"\n  Refusing to delete in non-interactive mode. Pass --yes to confirm, or --dry-run to preview.\n",
			);
			process.exitCode = 1;
			return;
		}
		console.log("");
		console.log("  All items above are expired data past their retention window.");
		console.log("  Deleting them is safe and will NOT affect any functionality.");
		const answer = await promptText(
			/* v8 ignore next -- singular/plural ternary always takes one path in tests */
			`\n  Proceed to remove ${totalItems} item${totalItems === 1 ? "" : "s"}? [y/N]: `,
		);
		const lower = answer.trim().toLowerCase();
		if (lower !== "y" && lower !== "yes") {
			console.log("\n  Aborted. Nothing was removed.\n");
			return;
		}
	}

	// Apply cleanups
	let removed = 0;

	// 2. Stale queue entries
	if (staleQueueCount > 0) {
		const pruned = await pruneStaleQueueEntries(cwd);
		removed += pruned;
	}

	// 3. Stale squash-pending
	/* v8 ignore start -- defensive: requires real stale squash-pending file */
	if (hasStaleSquash) {
		await deleteSquashPending(cwd);
		removed++;
	}
	/* v8 ignore stop */

	// 1. Stale sessions
	/* v8 ignore start -- defensive: requires real stale sessions in test env */
	if (staleSessionCount > 0) {
		const pruned = await pruneStaleSessions(cwd);
		removed += pruned;
	}
	/* v8 ignore stop */

	console.log(`\n  Removed ${removed} item${removed === 1 ? "" : "s"}.\n`);
}

/** Registers the `clean` sub-command on the given Commander program. */
export function registerCleanCommand(program: Command): void {
	program
		.command("clean")
		.description("Remove expired data (stale sessions, queue entries, squash-pending markers)")
		.option("--dry-run", "Show what would be removed without actually deleting")
		.option("-y, --yes", "Skip confirmation prompt")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: { cwd: string; dryRun?: boolean; yes?: boolean }) => {
			setLogDir(options.cwd);
			log.info("Running 'clean' command");
			await runClean(options.cwd, options.dryRun === true, options.yes === true);
		});
}

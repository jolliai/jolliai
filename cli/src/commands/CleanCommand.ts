/**
 * CleanCommand — Removes redundant/expired data that is safe to delete.
 *
 * Scope (vs `doctor`): clean handles cleanup; doctor handles faults.
 * The two commands have no overlapping checks.
 *
 * Targets:
 * 1. Orphan summary files — after amend/squash, old commits' summary files remain
 *    on the orphan branch but their content is now embedded as `children` in the
 *    new root's summary.
 * 2. Orphan transcript files — same logic for `transcripts/{hash}.json`.
 * 3. Stale sessions — sessions.json entries not updated for 48h.
 * 4. Stale queue entries — `.jolli/jollimemory/git-op-queue/*.json` older than 7 days.
 * 5. Stale squash-pending.json — older than 48h.
 */

import type { Command } from "commander";
import { listFilesInBranch, writeMultipleFilesToBranch } from "../core/GitOps.js";
import {
	checkStaleSquashPending,
	countStaleQueueEntries,
	countStaleSessions,
	deleteSquashPending,
	pruneStaleQueueEntries,
	pruneStaleSessions,
} from "../core/SessionTracker.js";
import { getIndex } from "../core/SummaryStore.js";
import { createLogger, ORPHAN_BRANCH, setLogDir } from "../Logger.js";
import { isInteractive, promptText, resolveProjectDir } from "./CliUtils.js";

const log = createLogger("clean");

/**
 * Scan results for a single cleanup target (orphan files on the orphan branch).
 *
 * Only counts are tracked — byte sizes are intentionally omitted because clean's
 * purpose is hygiene (removing redundant data), not disk-space reclamation.
 * The data involved is trivially small (JSON files, ~KB at most), so showing
 * byte sizes adds noise without informing user decisions.
 */
interface CleanTarget {
	readonly count: number;
	/** Orphan branch paths to delete. */
	readonly branchFiles: ReadonlyArray<string>;
}

/**
 * Removes redundant/expired data — cleanup operations that free disk space but
 * never affect functionality.
 */
async function runClean(cwd: string, dryRun: boolean, skipPrompt: boolean): Promise<void> {
	// 1 + 2. Orphan summary/transcript files on orphan branch
	const [orphanSummaries, orphanTranscripts] = await scanOrphanBranchFiles(cwd);

	// 3. Stale sessions
	const staleSessionCount = await countStaleSessions(cwd);

	// 4. Stale queue entries
	const staleQueueCount = await countStaleQueueEntries(cwd);

	// 5. Stale squash-pending
	const hasStaleSquash = await checkStaleSquashPending(cwd);

	// Print summary
	console.log("\n  Jolli Memory Clean");
	console.log("  ──────────────────────────────────────");
	console.log(`  Orphan summaries:     ${orphanSummaries.count} files`);
	console.log(`  Orphan transcripts:   ${orphanTranscripts.count} files`);
	console.log(`  Stale sessions:       ${staleSessionCount} entries`);
	console.log(`  Stale Git queue:      ${staleQueueCount} entries`);
	console.log(`  Stale squash-pending: ${hasStaleSquash ? "1 file" : "none"}`);

	const totalBranchFiles = orphanSummaries.count + orphanTranscripts.count;
	const totalItems = totalBranchFiles + staleQueueCount + (hasStaleSquash ? 1 : 0) + staleSessionCount;

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
		console.log("  All items above are redundant or expired data:");
		console.log("   - Orphan files: already embedded as `children` in merged summaries.");
		console.log("   - Stale sessions/Git queue/squash-pending: past their retention window.");
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

	// 1 + 2. Delete orphan branch files in a single atomic commit
	if (totalBranchFiles > 0) {
		const filesToDelete = [...orphanSummaries.branchFiles, ...orphanTranscripts.branchFiles].map((path) => ({
			path,
			content: "",
			delete: true,
		}));

		await writeMultipleFilesToBranch(
			ORPHAN_BRANCH,
			filesToDelete,
			/* v8 ignore next -- singular/plural ternary always takes one path in tests */
			`Clean ${totalBranchFiles} orphan file${totalBranchFiles === 1 ? "" : "s"} after amend/squash`,
			cwd,
		);
		removed += totalBranchFiles;
	}

	// 3. Stale queue entries
	if (staleQueueCount > 0) {
		const pruned = await pruneStaleQueueEntries(cwd);
		removed += pruned;
	}

	// 5. Stale squash-pending
	/* v8 ignore start -- defensive: requires real stale squash-pending file */
	if (hasStaleSquash) {
		await deleteSquashPending(cwd);
		removed++;
	}
	/* v8 ignore stop */

	// 6. Stale sessions
	/* v8 ignore start -- defensive: requires real stale sessions in test env */
	if (staleSessionCount > 0) {
		const pruned = await pruneStaleSessions(cwd);
		removed += pruned;
	}
	/* v8 ignore stop */

	console.log(`\n  Removed ${removed} item${removed === 1 ? "" : "s"}.\n`);
}

/**
 * Scans the orphan branch for redundant summary/transcript files whose content is
 * already embedded as `children` in merged root summaries.
 */
async function scanOrphanBranchFiles(cwd: string): Promise<[CleanTarget, CleanTarget]> {
	const empty: CleanTarget = { count: 0, branchFiles: [] };
	const index = await getIndex(cwd);
	if (!index) return [empty, empty];

	const childHashes = new Set<string>();
	for (const entry of index.entries) {
		/* v8 ignore start -- requires index entries with parentCommitHash set */
		if (entry.parentCommitHash != null) {
			childHashes.add(entry.commitHash);
		}
		/* v8 ignore stop */
	}
	if (childHashes.size === 0) return [empty, empty];

	const [summaryFiles, transcriptFiles] = await Promise.all([
		listFilesInBranch(ORPHAN_BRANCH, "summaries/", cwd),
		listFilesInBranch(ORPHAN_BRANCH, "transcripts/", cwd),
	]);

	const filterRedundant = (files: ReadonlyArray<string>, pattern: RegExp): string[] =>
		files.filter((path) => {
			const match = path.match(pattern);
			return match != null && childHashes.has(match[1]);
		});

	const summaryPaths = filterRedundant(summaryFiles, /^summaries\/([a-f0-9]+)\.json$/);
	const transcriptPaths = filterRedundant(transcriptFiles, /^transcripts\/([a-f0-9]+)\.json$/);

	return [
		{ count: summaryPaths.length, branchFiles: summaryPaths },
		{ count: transcriptPaths.length, branchFiles: transcriptPaths },
	];
}

/** Registers the `clean` sub-command on the given Commander program. */
export function registerCleanCommand(program: Command): void {
	program
		.command("clean")
		.description("Remove redundant data (orphan summary/transcript files after amend/squash, stale queue entries)")
		.option("--dry-run", "Show what would be removed without actually deleting")
		.option("-y, --yes", "Skip confirmation prompt")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: { cwd: string; dryRun?: boolean; yes?: boolean }) => {
			setLogDir(options.cwd);
			log.info("Running 'clean' command");
			await runClean(options.cwd, options.dryRun === true, options.yes === true);
		});
}

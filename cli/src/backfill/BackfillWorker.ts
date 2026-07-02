#!/usr/bin/env node
/**
 * BackfillWorker — detached background worker that back-fills summaries for the
 * most recent commits right after `jolli enable`.
 *
 * The attribution + generation phase is isolated from the live QueueWorker (no
 * shared lock, queue, or cursor). The ONE exception is intentional: after the
 * whole batch, BackfillEngine enqueues a single ingest op and launches the live
 * QueueWorker to drain it (reusing the post-commit wiki/graph path). It is
 * spawned detached (stdio ignored) so `enable` returns immediately and the
 * (potentially slow, LLM-bound) catch-up never blocks the user. Failures are
 * logged to debug.log only — they must never affect the enable result.
 *
 * Invoked as: `node BackfillWorker.js --worker --cwd <dir>`
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, setLogDir } from "../Logger.js";
import { spawnHidden } from "../util/Subprocess.js";
import { recentCommitHashes, runBackfill } from "./BackfillEngine.js";

const log = createLogger("BackfillWorker");

/** Number of most-recent commits the enable-time catch-up considers. */
export const ENABLE_BACKFILL_COUNT = 20;

/**
 * Spawns the BackfillWorker as a detached process. Mirrors
 * `QueueWorker.launchWorker`: resolves the sibling `BackfillWorker.js` by
 * directory + filename (NOT import.meta.url, which would point at the caller's
 * bundle once esbuild inlines this function) and never blocks the caller.
 */
export function launchBackfillWorker(cwd: string): void {
	const dir = dirname(fileURLToPath(import.meta.url));
	const scriptPath = join(dir, "BackfillWorker.js");
	if (!existsSync(scriptPath)) {
		log.error("BackfillWorker.js not found at %s — skipping enable-time back-fill", scriptPath);
		return;
	}
	const child = spawnHidden(process.execPath, [scriptPath, "--worker", "--cwd", cwd], {
		detached: true,
		stdio: "ignore",
		cwd,
	});
	child.unref();
	log.info("Back-fill worker spawned (PID: %d)", child.pid ?? -1);
}

/** Parses `--cwd <dir>` from argv (defaults to process.cwd()). Exported for tests. */
export function parseCwd(argv: ReadonlyArray<string>): string {
	const i = argv.indexOf("--cwd");
	return i >= 0 && argv[i + 1] ? argv[i + 1] : process.cwd();
}

/** Worker entry point: back-fills the last {@link ENABLE_BACKFILL_COUNT} commits. */
export async function runWorker(cwd: string): Promise<void> {
	setLogDir(cwd);
	log.info("Back-fill worker started (cwd=%s)", cwd);
	// recentCommitHashes scopes to the local user's own commits (see its doc).
	const hashes = await recentCommitHashes(cwd, ENABLE_BACKFILL_COUNT);
	if (hashes.length === 0) {
		log.info("No commits to back-fill — exiting");
		return;
	}
	// Uses the shared DEFAULT_BACKFILL_TIER (see BackfillEngine) — every entry point
	// attributes at the same tier; the per-summary confidence badge flags weaker turns.
	const report = await runBackfill({ cwd, hashes });
	log.info(
		"Back-fill complete: %d generated, %d skipped, %d error(s) of %d candidate(s)",
		report.generated,
		report.skipped,
		report.errors,
		report.total,
	);
}

// Auto-execute only when run directly as a worker (not when imported).
/* v8 ignore start */
function isWorkerInvocation(): boolean {
	return !process.env.VITEST && process.argv.includes("--worker");
}

if (isWorkerInvocation()) {
	runWorker(parseCwd(process.argv)).catch((error: unknown) => {
		log.error("Back-fill worker fatal error: %s", (error as Error).message);
		process.exit(1);
	});
}
/* v8 ignore stop */

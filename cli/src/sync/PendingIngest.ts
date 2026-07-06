/**
 * Per-worktree pending-ingest hand-off for the QueueWorker ingest phase.
 *
 * The degenerate sibling of {@link ./PendingWorkers}. `PendingWorkers` is the
 * per-VAULT, cross-repo registry for workers that time out on the per-vault
 * `vault-write.lock`; it must fan out to many sibling repos. `ingest.lock` is
 * per-worktree, so the only worker that ever needs waking is THIS worktree's
 * own next run — the registry collapses to a single `ingest-pending` flag file
 * next to `ingest.lock`.
 *
 * Flow (see `QueueWorker.runWorker`'s ingest phase):
 *   - A worker that loses the fail-fast `acquireIngestLock` calls
 *     `recordPendingIngest`, then retries the acquire once. Recording BEFORE
 *     the retry closes the record/acquire TOCTOU: if the holder releases in the
 *     gap, either our retry wins the lock, or the holder's `wakePendingIngest`
 *     already sees our flag — the ingest can't be stranded either way (mirrors
 *     the `vault-write.lock` fail-fast retry in `runWorker`).
 *   - The worker that DID hold `ingest.lock` calls `wakePendingIngest` AFTER
 *     `releaseIngestLock` in its `finally`. The wake must follow the release
 *     because `launchWorker` is a detached spawn — the freshly-spawned worker
 *     has to be able to win the now-free lock.
 *
 * `launchWorker` is idempotent: a worker that starts against an ingest-free
 * queue drains nothing in its ingest phase and exits cheaply, so waking after
 * the holder already consumed every ingest entry is a benign no-op. We
 * therefore do NOT re-check the queue here — keeping this module free of any
 * SessionTracker/queue coupling, exactly as `PendingWorkers` stays free of the
 * spawn helper.
 */

import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, getJolliMemoryDir } from "../Logger.js";

const log = createLogger("Sync:PendingIngest");

/** Single-slot flag file; presence = "this worktree has an ingest worker waiting". */
export const INGEST_PENDING_FILE = "ingest-pending";

function pendingIngestPath(cwd?: string): string {
	return join(getJolliMemoryDir(cwd), INGEST_PENDING_FILE);
}

/**
 * Records that a worker wanted to run ingest for `cwd` but lost the
 * `ingest.lock` race, so the current holder should re-spawn it on release.
 * Idempotent (single flag file) and best-effort — a write failure only means
 * this waiter won't be auto-woken; its queue entry stays on disk for the next
 * post-commit hook.
 */
export async function recordPendingIngest(cwd?: string): Promise<void> {
	try {
		await mkdir(getJolliMemoryDir(cwd), { recursive: true });
		await writeFile(pendingIngestPath(cwd), new Date().toISOString(), "utf-8");
		log.info("Recorded pending ingest for this worktree");
	} catch (e) {
		log.warn("recordPendingIngest failed (non-fatal): %s", (e as Error).message);
	}
}

/**
 * Reads-and-clears the pending-ingest flag. Returns true when a waiter was
 * recorded (and has now been consumed). Deleting BEFORE the caller acts on the
 * result mirrors `consumePendingWorkers`: a producer that races in after the
 * `rm` simply re-arms the flag for the next release.
 */
export async function consumePendingIngest(cwd?: string): Promise<boolean> {
	const path = pendingIngestPath(cwd);
	try {
		await stat(path);
	} catch {
		return false; // no flag — nothing pending
	}
	try {
		await rm(path, { force: true });
	} catch (e) {
		// The stat above proved it existed; a failed rm would leave the flag to
		// trigger one redundant (idempotent) spawn next time. Non-fatal.
		log.warn("consumePendingIngest: rm failed (non-fatal): %s", (e as Error).message);
	}
	return true;
}

/**
 * If a pending-ingest waiter was recorded for `cwd`, consume the flag and
 * `launch` a fresh worker so the recorded waiter's ingest work isn't stranded
 * until the next commit. MUST be called AFTER `releaseIngestLock` so the
 * spawned worker can win the lock.
 *
 * `launch` is injected (not imported) so this stays in the sync layer, matching
 * `wakePendingWorkers`. Best-effort: a launch failure is logged and swallowed —
 * the waiter's queue entry remains on disk for the next post-commit hook.
 */
export async function wakePendingIngest(cwd: string, launch: (cwd: string) => void): Promise<void> {
	const wasPending = await consumePendingIngest(cwd);
	if (!wasPending) return;
	try {
		log.info("Waking pending ingest worker for this worktree");
		launch(cwd);
	} catch (e) {
		log.warn("wakePendingIngest: launch failed (non-fatal): %s", (e as Error).message);
	}
}

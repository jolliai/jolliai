/**
 * File-based lock primitives for Jolli Memory.
 *
 * Two locks live side-by-side under `.jolli/jollimemory/`:
 *
 *   - `worker.lock`        — held by QueueWorker for the duration of a queue drain
 *                            (typically 30-60 s while the LLM runs). Fail-fast: a second
 *                            worker that tries to acquire it returns false immediately so
 *                            only one drain runs at a time. PostRewriteHook / PostCommitHook
 *                            consult `isWorkerLockHeld` to decide whether to spawn a new
 *                            worker.
 *
 *   - `orphan-write.lock`  — held by anyone writing to the orphan summary branch,
 *                            including the worker itself (briefly, around each
 *                            `writeFiles` critical section). Acquired with a poll
 *                            loop and a caller-chosen timeout because contention is
 *                            millisecond-scale and waiting briefly avoids needless
 *                            "deferred" outcomes.
 *
 * Splitting the two roles is the fix for the orphan-queue-entry race: previously a
 * single `lock` file served both purposes, so a non-worker holder (e.g.
 * `scanTreeHashAliases`) made `isLockHeld` return true and PostRewriteHook
 * incorrectly assumed a Worker was running.
 */

import { mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, getJolliMemoryDir } from "../Logger.js";

const log = createLogger("Locks");

export const WORKER_LOCK_FILE = "worker.lock";
export const ORPHAN_WRITE_LOCK_FILE = "orphan-write.lock";

/** Lock timeout: a lock older than this is considered stale and reclaimable. */
export const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Default wait budget for `acquireOrphanWriteLock` (background callers). */
export const DEFAULT_ORPHAN_WRITE_TIMEOUT_MS = 1000;

/** Default poll interval while waiting for `orphan-write.lock`. */
export const DEFAULT_ORPHAN_WRITE_POLL_MS = 50;

/** Optional knobs for `acquireOrphanWriteLock`. */
export interface OrphanWriteLockOpts {
	readonly timeoutMs?: number;
	readonly pollMs?: number;
}

async function ensureLockDir(cwd?: string): Promise<string> {
	const dir = getJolliMemoryDir(cwd);
	await mkdir(dir, { recursive: true });
	return dir;
}

/**
 * Best-effort single attempt at creating `lockPath` exclusively.
 * Returns true on success. Returns false if another process already holds it
 * (and the existing lock is fresh) or if a filesystem error blocked us.
 *
 * Stale locks (older than `LOCK_TIMEOUT_MS`) are removed and the caller will
 * succeed on the retry / next call.
 */
async function tryAcquireOnce(lockPath: string): Promise<boolean> {
	try {
		const lockStat = await stat(lockPath);
		const age = Date.now() - lockStat.mtimeMs;
		if (age < LOCK_TIMEOUT_MS) {
			return false;
		}
		log.warn("Removing stale lock file %s (age: %dms)", lockPath, age);
		await rm(lockPath, { force: true });
	} catch (error: unknown) {
		const err = error as { code?: string };
		/* v8 ignore start -- defensive: non-ENOENT errors from stat are rare filesystem issues */
		if (err.code !== "ENOENT") {
			log.error("Failed to check lock file %s: %s", lockPath, (error as Error).message);
			return false;
		}
		/* v8 ignore stop */
	}

	try {
		await writeFile(lockPath, String(process.pid), { flag: "wx" });
		return true;
		/* v8 ignore start -- race condition: another process grabbed the lock between check and write */
	} catch {
		return false;
	}
	/* v8 ignore stop */
}

/**
 * Acquires the worker lock. Fail-fast: returns false immediately when another
 * worker already holds it.
 */
export async function acquireWorkerLock(cwd?: string): Promise<boolean> {
	const dir = await ensureLockDir(cwd);
	return tryAcquireOnce(join(dir, WORKER_LOCK_FILE));
}

/**
 * Releases the worker lock. Swallows filesystem errors — releasing is
 * best-effort and we never want a release failure to crash a hook.
 */
export async function releaseWorkerLock(cwd?: string): Promise<void> {
	const dir = getJolliMemoryDir(cwd);
	try {
		await rm(join(dir, WORKER_LOCK_FILE), { force: true });
		/* v8 ignore next 3 -- filesystem permission error during lock release */
	} catch (error: unknown) {
		log.error("Failed to release worker lock: %s", (error as Error).message);
	}
}

/**
 * Returns true when `worker.lock` exists and is younger than `LOCK_TIMEOUT_MS`.
 * Used by PostRewriteHook and PostCommitHook to decide whether a worker is
 * already running. The check intentionally ignores `orphan-write.lock` so a
 * brief background writer (scanTreeHashAliases, getCatalogWithLazyBuild) does
 * not falsely advertise "worker is running".
 */
export async function isWorkerLockHeld(cwd?: string): Promise<boolean> {
	const dir = getJolliMemoryDir(cwd);
	const lockPath = join(dir, WORKER_LOCK_FILE);
	try {
		const lockStat = await stat(lockPath);
		return Date.now() - lockStat.mtimeMs < LOCK_TIMEOUT_MS;
	} catch {
		return false;
	}
}

/**
 * Returns true when `worker.lock` exists but is older than `LOCK_TIMEOUT_MS`.
 * Used by `doctor` to detect a crashed worker that left its lock behind.
 */
export async function isWorkerLockStale(cwd?: string): Promise<boolean> {
	const dir = getJolliMemoryDir(cwd);
	const lockPath = join(dir, WORKER_LOCK_FILE);
	try {
		const lockStat = await stat(lockPath);
		return Date.now() - lockStat.mtimeMs >= LOCK_TIMEOUT_MS;
	} catch {
		return false;
	}
}

/**
 * Bumps the mtime on `worker.lock` so a long-running worker (e.g. an LLM call
 * that exceeds `LOCK_TIMEOUT_MS`) cannot be stolen by the stale-lock reclaimer.
 * The worker calls this on a periodic timer for the duration of its run.
 *
 * Silently ignores ENOENT and any other filesystem error — a missing lock means
 * the worker is no longer holding it, and a transient utimes failure is not
 * worth crashing on.
 */
export async function refreshWorkerLockMtime(cwd?: string): Promise<void> {
	const dir = getJolliMemoryDir(cwd);
	const lockPath = join(dir, WORKER_LOCK_FILE);
	try {
		const now = new Date();
		await utimes(lockPath, now, now);
		/* v8 ignore next 3 -- transient utimes failure on a lock file is intentionally swallowed */
	} catch {
		// Lock file gone or filesystem hiccup — refresh is best-effort.
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquires `orphan-write.lock`, waiting up to `timeoutMs` for an existing
 * holder to release it. Returns true on success, false on timeout.
 *
 * `orphan-write.lock` is held only for the brief window of a single
 * `StorageProvider.writeFiles` call (read-modify-write of index/catalog),
 * so even a 1 s poll budget is enough to ride out almost all real contention.
 * The worker uses 5 s — its writes are post-LLM and must land.
 */
export async function acquireOrphanWriteLock(cwd?: string, opts: OrphanWriteLockOpts = {}): Promise<boolean> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_ORPHAN_WRITE_TIMEOUT_MS;
	const pollMs = opts.pollMs ?? DEFAULT_ORPHAN_WRITE_POLL_MS;
	const dir = await ensureLockDir(cwd);
	const lockPath = join(dir, ORPHAN_WRITE_LOCK_FILE);
	const deadline = Date.now() + timeoutMs;

	while (true) {
		if (await tryAcquireOnce(lockPath)) return true;
		if (Date.now() >= deadline) return false;
		await sleep(pollMs);
	}
}

/**
 * Releases `orphan-write.lock`. Like `releaseWorkerLock`, swallows errors so a
 * failed release never propagates back to a hook or queue worker.
 */
export async function releaseOrphanWriteLock(cwd?: string): Promise<void> {
	const dir = getJolliMemoryDir(cwd);
	try {
		await rm(join(dir, ORPHAN_WRITE_LOCK_FILE), { force: true });
		/* v8 ignore next 3 -- filesystem permission error during lock release */
	} catch (error: unknown) {
		log.error("Failed to release orphan-write lock: %s", (error as Error).message);
	}
}

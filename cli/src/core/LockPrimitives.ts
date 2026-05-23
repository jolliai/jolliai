/**
 * Reusable file-lock primitives shared by all jollimemory file locks.
 *
 * Three locks live in three distinct directories and serve different scopes
 * (`worker.lock` per-worktree, `orphan-write.lock` per-repo, `sync.lock`
 * global per user), but they all share the same on-disk convention:
 *
 *   - PID written into the file as ASCII
 *   - mtime is the freshness signal
 *   - locks older than `LOCK_TIMEOUT_MS` are reclaimable by the next acquirer
 *   - releases are PID-checked to prevent the stale-reclaim race where
 *     process A's finally block deletes process B's freshly-acquired lock
 *
 * This module owns those mechanics so the wrapper layers (`Locks.ts` for
 * worker/orphan-write, `sync/SyncLock.ts` for sync.lock) stay thin.
 *
 * **Stale-reclaim race not closed.** Between B's `stat` (sees age ≥ TIMEOUT)
 * and B's `rm`, A can fire one mtime refresh and bump fresh — B then deletes
 * a now-fresh lock and both believe they hold it. Closing this needs an
 * atomic "rm-iff-mtime-unchanged" primitive (link/rename pattern), out of
 * scope. The window requires a sub-millisecond gap at the one boundary tick
 * inside a 60 s refresh cycle — vanishingly unlikely. Documented here so
 * future readers don't reinvent a half-fix.
 */

import { readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createLogger } from "../Logger.js";

const log = createLogger("LockPrimitives");

/**
 * Stale-reclaim threshold for all jollimemory file locks.
 *
 * Invariant: must be greater than 2 × the longest heartbeat interval of any
 * caller. Today the worker bumps mtime every 60 s while running, so 5 min
 * leaves ample margin for a missed GC tick or slow scheduler. Sync rounds
 * are shorter (no LLM by default), but follow the same convention.
 */
export const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

/** Optional knobs for `acquireWithPoll`. */
export interface PollOpts {
	readonly timeoutMs: number;
	readonly pollMs: number;
}

/** Small sleep helper for poll loops. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns true iff the OS reports a process with the given numeric PID is
 * currently alive (any state, including stopped). We use `process.kill(pid, 0)`
 * which performs the permission + existence check WITHOUT delivering a signal.
 *
 * Returns false for:
 *   - non-numeric / empty input (orphaned write from a corrupted lock file)
 *   - the PID doesn't exist (ESRCH) → owner crashed without releasing
 *   - permission denied (EPERM) — process exists under another uid; we treat
 *     as "alive" defensively to avoid stealing another user's lock
 *
 * Exported so unit tests can stub it via spy if needed; release / acquire
 * helpers below call it as a regular import.
 */
export function isPidAlive(pidStr: string): boolean {
	const pid = Number(pidStr);
	if (!Number.isInteger(pid) || pid <= 0) return false;
	if (pid === process.pid) return true; // Optimization: us is us.
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		const code = (error as { code?: string }).code;
		// ESRCH = no such process → definitely dead → caller can reclaim.
		// EPERM = exists but we can't signal it → treat as alive (don't
		// steal someone else's lock). Other errors err on alive side too.
		if (code === "ESRCH") return false;
		return true;
	}
}

/**
 * Best-effort single attempt at creating `lockPath` exclusively.
 * Returns true on success. Returns false if another process already holds it
 * (and the existing lock is fresh AND the holding PID is still alive) or if a
 * filesystem error blocked us.
 *
 * Stale locks are removed automatically — "stale" means either:
 *   1. `mtime` older than `LOCK_TIMEOUT_MS` (heartbeat lapsed → process
 *      probably hung), OR
 *   2. the written PID is no longer alive (`isPidAlive` returns false →
 *      owner crashed without running the release path; mtime check would
 *      otherwise wait the full 5 min before noticing).
 *
 * Adding (2) closes the "VS Code force-killed mid-round leaves lock stuck
 * for ≤5 min" footgun without weakening (1) — a slow-but-alive holder still
 * gets its full timeout.
 */
export async function tryAcquireOnce(lockPath: string): Promise<boolean> {
	try {
		const lockStat = await stat(lockPath);
		const age = Date.now() - lockStat.mtimeMs;
		const ownerPid = await readLockOwnerPid(lockPath);
		const ownerDead = ownerPid !== null && !isPidAlive(ownerPid);
		if (!ownerDead && age < LOCK_TIMEOUT_MS) {
			return false;
		}
		if (ownerDead) {
			log.warn("Removing orphaned lock %s (PID %s no longer running)", lockPath, ownerPid);
		} else {
			log.warn("Removing stale lock file %s (age: %dms)", lockPath, age);
		}
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
 * Reads the PID currently written into `lockPath`. Returns null when the file
 * is missing or unreadable — callers treat that as "not ours".
 */
export async function readLockOwnerPid(lockPath: string): Promise<string | null> {
	try {
		const content = await readFile(lockPath, "utf-8");
		const pid = content.trim();
		return pid.length > 0 ? pid : null;
		/* v8 ignore next 3 -- ENOENT / unreadable: caller treats null as "not ours" */
	} catch {
		return null;
	}
}

/**
 * Removes `lockPath` only if its written PID matches the current process.
 * No-op when the file is missing OR owned by another PID — protects against
 * the stale-reclaim race where this process's release would otherwise delete
 * a different process's freshly-acquired lock.
 */
export async function releaseIfOwned(lockPath: string, label: string): Promise<void> {
	const ownerPid = await readLockOwnerPid(lockPath);
	if (ownerPid !== null && ownerPid !== String(process.pid)) {
		log.warn(
			"Skipping release of %s: held by pid %s, not us (pid %s) — stale-reclaim race",
			label,
			ownerPid,
			process.pid,
		);
		return;
	}
	try {
		await rm(lockPath, { force: true });
		/* v8 ignore next 3 -- filesystem permission error during lock release */
	} catch (error: unknown) {
		log.error("Failed to release %s: %s", label, (error as Error).message);
	}
}

/**
 * Polls `tryAcquireOnce` up to `timeoutMs` total, `pollMs` between attempts.
 * Returns true on success, false on timeout. A `timeoutMs <= 0` collapses to
 * a single fail-fast attempt — useful for callers that prefer to defer
 * rather than block (e.g. a periodic plugin watcher tick).
 */
export async function acquireWithPoll(lockPath: string, opts: PollOpts): Promise<boolean> {
	if (opts.timeoutMs <= 0) {
		return tryAcquireOnce(lockPath);
	}
	const deadline = Date.now() + opts.timeoutMs;
	while (true) {
		if (await tryAcquireOnce(lockPath)) return true;
		if (Date.now() >= deadline) return false;
		await sleep(opts.pollMs);
	}
}

/**
 * Bumps `lockPath`'s mtime so the staleness check sees a fresh lock. Skipped
 * when the lock is owned by a different PID — refreshing someone else's lock
 * would extend the lifetime of a lock the holder already lost (after a
 * stale-reclaim) and let the original holder believe it still owns the lock
 * when it doesn't.
 */
export async function refreshLockMtime(lockPath: string): Promise<void> {
	const ownerPid = await readLockOwnerPid(lockPath);
	if (ownerPid !== null && ownerPid !== String(process.pid)) {
		return;
	}
	try {
		const now = new Date();
		await utimes(lockPath, now, now);
		/* v8 ignore next 3 -- transient utimes failure on a lock file is intentionally swallowed */
	} catch {
		// Lock file gone or filesystem hiccup — refresh is best-effort.
	}
}

/**
 * Returns true when `lockPath` exists and is younger than `LOCK_TIMEOUT_MS`.
 * Used by callers that need to detect "is anyone currently running?" without
 * trying to acquire.
 */
export async function isLockHeld(lockPath: string): Promise<boolean> {
	try {
		const lockStat = await stat(lockPath);
		return Date.now() - lockStat.mtimeMs < LOCK_TIMEOUT_MS;
		/* v8 ignore next 3 -- ENOENT: lock doesn't exist, return false */
	} catch {
		return false;
	}
}

/**
 * Returns true when `lockPath` exists but is older than `LOCK_TIMEOUT_MS` —
 * a crashed holder left it behind and the next acquirer will reclaim it. Used
 * by `doctor` and similar diagnostics, not the acquire path.
 */
export async function isLockStale(lockPath: string): Promise<boolean> {
	try {
		const lockStat = await stat(lockPath);
		return Date.now() - lockStat.mtimeMs >= LOCK_TIMEOUT_MS;
		/* v8 ignore next 3 -- ENOENT: lock doesn't exist, return false */
	} catch {
		return false;
	}
}

/**
 * Global per-user lock for Memory Bank sync rounds.
 *
 * Unlike `worker.lock` (per-worktree, in `<cwd>/.jolli/jollimemory/`) and
 * `orphan-write.lock` (per-repo, in `<git-common-dir>/jollimemory/`),
 * `sync.lock` lives at `~/.jolli/jollimemory/sync.lock` and serializes sync
 * rounds across **all** worktrees and the long-lived VS Code plugin watcher
 * for a single user. Only one sync round runs at a time, machine-wide.
 *
 * Acquire semantics follow the source plan's
 * `vscode-plugin-memory-bank-final-plan.md §3 阶段 2 step 1`:
 *
 *   - **VS Code polling tick**: 10 s default budget; callers can pass
 *     `{ timeoutMs: 0 }` for fail-fast when the poll should never block
 *     the UI thread. The poll fires every 90 min anyway, so deferred work
 *     catches up on the next tick.
 *   - **Manual "Sync now" button**: same 10 s — a user explicitly asked
 *     for a round so a short wait is acceptable.
 *
 * (The post-commit hook does NOT take this lock — the auto post-commit
 * sync was dropped in Phase 4 to keep `git commit` UX clean.)
 *
 * PID + mtime mechanics are shared with `worker.lock` and `orphan-write.lock`
 * via `cli/src/core/LockPrimitives.ts`.
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { acquireWithPoll, isLockHeld, refreshLockMtime, releaseIfOwned } from "../core/LockPrimitives.js";
import { SYNC_LOCK_FILE } from "../core/Locks.js";

/** Default budget for `acquireSyncLock` — matches source plan flock 10s. */
export const DEFAULT_SYNC_LOCK_TIMEOUT_MS = 10_000;

/** Default poll interval while waiting for `sync.lock`. */
export const DEFAULT_SYNC_LOCK_POLL_MS = 100;

/** Optional knobs for `acquireSyncLock`. */
export interface SyncLockOpts {
	/** Max wait for the lock. `0` = single fail-fast attempt. Default 10 s. */
	readonly timeoutMs?: number;
	/** Poll interval while waiting. Default 100 ms. */
	readonly pollMs?: number;
}

/**
 * Returns the absolute path to `<sync-lock-dir>/sync.lock`.
 *
 * Default: `~/.jolli/jollimemory/sync.lock`. The acceptance suite — and
 * any other harness that needs to isolate sync state from the user's
 * real Jolli install — can override the directory via the
 * `JOLLI_SYNC_LOCK_DIR` env var. Without that override, parallel local
 * VS Code / CLI sync rounds collide with the test suite on the same
 * shared lockfile and tests deadlock at 5 s `acquireSyncLock` timeouts
 * before any business logic runs (P3#5).
 */
export function getSyncLockPath(): string {
	const override = process.env.JOLLI_SYNC_LOCK_DIR;
	const dir = override !== undefined && override !== "" ? override : join(homedir(), ".jolli", "jollimemory");
	return join(dir, SYNC_LOCK_FILE);
}

/**
 * Acquires `sync.lock`, waiting up to `opts.timeoutMs` for an existing holder
 * to release it. Returns true on success, false on timeout.
 *
 * Always creates the lock's parent directory before attempting acquisition —
 * `~/.jolli/jollimemory/` may not exist on a fresh install before any other
 * jollimemory state has been written.
 */
export async function acquireSyncLock(opts: SyncLockOpts = {}): Promise<boolean> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_SYNC_LOCK_TIMEOUT_MS;
	const pollMs = opts.pollMs ?? DEFAULT_SYNC_LOCK_POLL_MS;
	const lockPath = getSyncLockPath();
	await mkdir(dirname(lockPath), { recursive: true });
	return acquireWithPoll(lockPath, { timeoutMs, pollMs });
}

/**
 * Releases `sync.lock` — only if the lock file's PID matches us. Mirrors
 * `releaseWorkerLock` / `releaseOrphanWriteLock`; all three share the same
 * PID-checked release primitive to prevent the stale-reclaim race.
 */
export async function releaseSyncLock(): Promise<void> {
	await releaseIfOwned(getSyncLockPath(), "sync.lock");
}

/**
 * Bumps `sync.lock`'s mtime so a long-running round (Tier 2 LLM call,
 * slow network) cannot be stolen by the stale-lock reclaimer. Callers
 * invoke this on a periodic timer for the duration of the round.
 */
export async function refreshSyncLockMtime(): Promise<void> {
	await refreshLockMtime(getSyncLockPath());
}

/**
 * Returns true when `sync.lock` exists and is younger than `LOCK_TIMEOUT_MS`.
 * Used by the VS Code status orchestrator to detect "another round is in
 * flight" without trying to acquire (avoids creating contention for a quick
 * status probe).
 */
export async function isSyncLockHeld(): Promise<boolean> {
	return isLockHeld(getSyncLockPath());
}

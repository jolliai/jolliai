package ai.jolli.jollimemory.sync

import java.nio.file.Files
import java.nio.file.Path

/**
 * Global per-user lock for Memory Bank sync rounds.
 *
 * Port of `cli/src/sync/SyncLock.ts`.
 *
 * Lives at `~/.jolli/jollimemory/sync.lock` and serializes sync rounds
 * across all worktrees and the long-lived plugin watcher for a single user.
 * Only one sync round runs at a time, machine-wide.
 */

data class SyncLockOpts(
	val timeoutMs: Long = SyncLock.DEFAULT_TIMEOUT_MS,
	val pollMs: Long = SyncLock.DEFAULT_POLL_MS,
)

object SyncLock {

	const val DEFAULT_TIMEOUT_MS = 10_000L
	const val DEFAULT_POLL_MS = 100L
	private const val SYNC_LOCK_FILE = "sync.lock"

	/**
	 * Returns the absolute path to `sync.lock`.
	 * Respects `JOLLI_SYNC_LOCK_DIR` env override for test isolation.
	 */
	fun getSyncLockPath(): Path {
		val override = System.getenv("JOLLI_SYNC_LOCK_DIR")
		val dir = if (!override.isNullOrEmpty()) {
			Path.of(override)
		} else {
			Path.of(System.getProperty("user.home"), ".jolli", "jollimemory")
		}
		return dir.resolve(SYNC_LOCK_FILE)
	}

	/**
	 * Acquires `sync.lock`, waiting up to [opts] timeout. Returns true on
	 * success, false on timeout. Creates parent directory if needed.
	 */
	fun acquire(opts: SyncLockOpts = SyncLockOpts()): Boolean {
		val lockPath = getSyncLockPath()
		Files.createDirectories(lockPath.parent)
		return LockPrimitives.acquireWithPoll(lockPath, opts.timeoutMs, opts.pollMs)
	}

	/**
	 * Releases `sync.lock` — only if the lock file's PID matches us.
	 */
	fun release() {
		LockPrimitives.releaseIfOwned(getSyncLockPath(), "sync.lock")
	}

	/** Bumps mtime so a long-running round doesn't get reclaimed. */
	fun refreshMtime() {
		LockPrimitives.refreshLockMtime(getSyncLockPath())
	}

	/** Returns true when `sync.lock` exists and is fresh. */
	fun isHeld(): Boolean {
		return LockPrimitives.isLockHeld(getSyncLockPath())
	}
}

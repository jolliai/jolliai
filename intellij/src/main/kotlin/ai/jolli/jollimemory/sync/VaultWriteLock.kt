package ai.jolli.jollimemory.sync

import java.nio.file.Files
import java.nio.file.Path

/**
 * Per-vault writer lock — coordinates sync vs QueueWorker.
 *
 * Port of `cli/src/sync/VaultWriteLock.ts`.
 *
 * Held by callers that mutate the vault working tree, with asymmetric scope:
 *   - QueueWorker holds for the entire drain
 *   - SyncEngine holds only during pullRebase + conflict resolution
 */

sealed class VaultWriteLockMode {
	object FailFast : VaultWriteLockMode()
	data class Wait(val ms: Long) : VaultWriteLockMode()
}

interface VaultWriteLockHandle {
	fun release()
	fun refresh()
}

object VaultWriteLock {

	const val DEFAULT_WAIT_MS = 60_000L
	const val DEFAULT_PULL_LOCK_WAIT_MS = 10_000L
	const val DEFAULT_POLL_MS = 100L

	/**
	 * Acquires `vault-write.lock` for the vault rooted at [vaultRoot].
	 * Returns a handle on success, or null on miss/timeout.
	 */
	fun acquire(vaultRoot: String, mode: VaultWriteLockMode): VaultWriteLockHandle? {
		val lockPath = getVaultWriteLockPath(vaultRoot)
		Files.createDirectories(lockPath.parent)

		val acquired = when (mode) {
			is VaultWriteLockMode.FailFast -> LockPrimitives.tryAcquireOnce(lockPath)
			is VaultWriteLockMode.Wait -> LockPrimitives.acquireWithPoll(
				lockPath, mode.ms, DEFAULT_POLL_MS
			)
		}

		if (!acquired) return null

		return object : VaultWriteLockHandle {
			override fun release() {
				LockPrimitives.releaseIfOwned(lockPath, "vault-write.lock")
			}

			override fun refresh() {
				LockPrimitives.refreshLockMtime(lockPath)
			}
		}
	}

	/**
	 * Returns true when `vault-write.lock` exists and is fresh. Diagnostic only.
	 */
	fun isHeld(vaultRoot: String): Boolean {
		return LockPrimitives.isLockHeld(getVaultWriteLockPath(vaultRoot))
	}
}

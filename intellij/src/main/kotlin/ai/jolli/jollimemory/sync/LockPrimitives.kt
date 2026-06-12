package ai.jolli.jollimemory.sync

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.FileTime
import java.time.Instant

/**
 * Reusable file-lock primitives shared by all jollimemory file locks.
 *
 * Port of `cli/src/core/LockPrimitives.ts`.
 *
 * On-disk convention:
 *   - PID written into the file as ASCII
 *   - mtime is the freshness signal
 *   - locks older than [LOCK_TIMEOUT_MS] are reclaimable by the next acquirer
 *   - releases are PID-checked to prevent the stale-reclaim race
 */
object LockPrimitives {

	/** Stale-reclaim threshold — 5 minutes. */
	const val LOCK_TIMEOUT_MS = 5L * 60 * 1000

	private val myPid: Long = ProcessHandle.current().pid()

	/**
	 * Returns true iff the OS reports a process with the given PID is alive.
	 */
	fun isPidAlive(pid: Long): Boolean {
		if (pid <= 0) return false
		if (pid == myPid) return true
		return ProcessHandle.of(pid).map { it.isAlive }.orElse(false)
	}

	/**
	 * Best-effort single attempt at creating [lockPath] exclusively.
	 * Returns true on success. Stale locks (mtime > [LOCK_TIMEOUT_MS] or
	 * dead PID) are removed automatically.
	 */
	fun tryAcquireOnce(lockPath: Path): Boolean {
		if (Files.exists(lockPath)) {
			try {
				val mtime = Files.getLastModifiedTime(lockPath).toMillis()
				val age = System.currentTimeMillis() - mtime
				val ownerPid = readLockOwnerPid(lockPath)
				val ownerDead = ownerPid != null && !isPidAlive(ownerPid)
				if (!ownerDead && age < LOCK_TIMEOUT_MS) {
					return false
				}
				Files.deleteIfExists(lockPath)
			} catch (_: java.nio.file.NoSuchFileException) {
				// Deleted between exists check and stat — proceed.
			} catch (_: Exception) {
				return false
			}
		}

		return try {
			Files.write(
				lockPath,
				myPid.toString().toByteArray(),
				StandardOpenOption.CREATE_NEW,
				StandardOpenOption.WRITE,
			)
			true
		} catch (_: java.nio.file.FileAlreadyExistsException) {
			false
		} catch (_: Exception) {
			false
		}
	}

	/**
	 * Reads the PID written into [lockPath]. Returns null when the file
	 * is missing or unreadable.
	 */
	fun readLockOwnerPid(lockPath: Path): Long? {
		return try {
			val content = Files.readString(lockPath).trim()
			if (content.isEmpty()) null else content.toLongOrNull()
		} catch (_: Exception) {
			null
		}
	}

	/**
	 * Removes [lockPath] only if its written PID matches the current process.
	 */
	fun releaseIfOwned(lockPath: Path, @Suppress("UNUSED_PARAMETER") label: String) {
		val ownerPid = readLockOwnerPid(lockPath)
		if (ownerPid != null && ownerPid != myPid) {
			return
		}
		try {
			Files.deleteIfExists(lockPath)
		} catch (_: Exception) {
			// Best-effort.
		}
	}

	/**
	 * Polls [tryAcquireOnce] up to [timeoutMs], sleeping [pollMs] between
	 * attempts. Returns true on success, false on timeout.
	 */
	fun acquireWithPoll(lockPath: Path, timeoutMs: Long, pollMs: Long): Boolean {
		if (timeoutMs <= 0) {
			return tryAcquireOnce(lockPath)
		}
		val deadline = System.currentTimeMillis() + timeoutMs
		while (true) {
			if (tryAcquireOnce(lockPath)) return true
			if (System.currentTimeMillis() >= deadline) return false
			Thread.sleep(pollMs)
		}
	}

	/**
	 * Bumps [lockPath]'s mtime so the staleness check sees a fresh lock.
	 * Skipped when the lock is owned by a different PID.
	 */
	fun refreshLockMtime(lockPath: Path) {
		val ownerPid = readLockOwnerPid(lockPath)
		if (ownerPid != null && ownerPid != myPid) return
		try {
			Files.setLastModifiedTime(lockPath, FileTime.from(Instant.now()))
		} catch (_: Exception) {
			// Best-effort.
		}
	}

	/**
	 * Returns true when [lockPath] exists and is younger than [LOCK_TIMEOUT_MS].
	 */
	fun isLockHeld(lockPath: Path): Boolean {
		return try {
			val mtime = Files.getLastModifiedTime(lockPath).toMillis()
			System.currentTimeMillis() - mtime < LOCK_TIMEOUT_MS
		} catch (_: Exception) {
			false
		}
	}
}

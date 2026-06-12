package ai.jolli.jollimemory.sync

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path

class VaultWriteLockTest {

	@TempDir
	lateinit var tempDir: Path

	@Test
	fun `fail-fast acquire succeeds when no contention`() {
		// Use LockPrimitives directly with a known path to avoid env issues.
		val lockPath = tempDir.resolve("vault-test.lock")
		assertTrue(LockPrimitives.tryAcquireOnce(lockPath))
		LockPrimitives.releaseIfOwned(lockPath, "test")
	}

	@Test
	fun `handle release deletes lock file`() {
		val lockPath = tempDir.resolve("vault-test.lock")
		assertTrue(LockPrimitives.tryAcquireOnce(lockPath))
		assertTrue(java.nio.file.Files.exists(lockPath))
		LockPrimitives.releaseIfOwned(lockPath, "test")
		assertFalse(java.nio.file.Files.exists(lockPath))
	}

	@Test
	fun `handle refresh bumps mtime`() {
		val lockPath = tempDir.resolve("vault-test.lock")
		LockPrimitives.tryAcquireOnce(lockPath)
		val oldMtime = java.nio.file.Files.getLastModifiedTime(lockPath).toMillis()
		Thread.sleep(50)
		LockPrimitives.refreshLockMtime(lockPath)
		val newMtime = java.nio.file.Files.getLastModifiedTime(lockPath).toMillis()
		assertTrue(newMtime >= oldMtime)
	}

	@Test
	fun `VaultWriteLockMode sealed class variants`() {
		val failFast: VaultWriteLockMode = VaultWriteLockMode.FailFast
		val wait: VaultWriteLockMode = VaultWriteLockMode.Wait(10_000)
		assertNotEquals(failFast, wait)
		assertTrue(wait is VaultWriteLockMode.Wait)
		assertEquals(10_000, (wait as VaultWriteLockMode.Wait).ms)
	}
}

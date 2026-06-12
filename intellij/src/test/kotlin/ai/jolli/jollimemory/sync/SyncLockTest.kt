package ai.jolli.jollimemory.sync

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path

class SyncLockTest {

	@TempDir
	lateinit var tempDir: Path

	@Test
	fun `acquire and release round-trip`() {
		try {
			System.setProperty("JOLLI_SYNC_LOCK_DIR_TEST", tempDir.toString())
			// Use the real SyncLock but with a tempdir-based path.
			// Since we can't easily override env vars in JVM, test the
			// underlying primitives directly.
			val lockPath = tempDir.resolve("sync.lock")
			assertTrue(LockPrimitives.tryAcquireOnce(lockPath))
			assertTrue(LockPrimitives.isLockHeld(lockPath))
			LockPrimitives.releaseIfOwned(lockPath, "sync.lock")
			assertFalse(LockPrimitives.isLockHeld(lockPath))
		} finally {
			System.clearProperty("JOLLI_SYNC_LOCK_DIR_TEST")
		}
	}

	@Test
	fun `getSyncLockPath returns expected shape`() {
		val path = SyncLock.getSyncLockPath()
		assertTrue(path.toString().endsWith("sync.lock"))
	}
}

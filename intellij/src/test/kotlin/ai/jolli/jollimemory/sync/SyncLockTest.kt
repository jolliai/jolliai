package ai.jolli.jollimemory.sync

import ai.jolli.jollimemory.core.fakeHookEnv
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path

class SyncLockTest {

	@TempDir
	lateinit var tempDir: Path

	@Test
	fun `acquire and release round-trip`() {
		val lockPath = tempDir.resolve("sync.lock")
		assertTrue(LockPrimitives.tryAcquireOnce(lockPath))
		assertTrue(LockPrimitives.isLockHeld(lockPath))
		LockPrimitives.releaseIfOwned(lockPath, "sync.lock")
		assertFalse(LockPrimitives.isLockHeld(lockPath))
	}

	@Test
	fun `getSyncLockPath resolves under the injected home`() {
		val path = SyncLock.getSyncLockPath(fakeHookEnv(userHome = tempDir.toFile()))
		assertTrue(path.toString().endsWith("sync.lock"))
		assertTrue(path.startsWith(tempDir))
	}

	@Test
	fun `getSyncLockPath honors the JOLLI_SYNC_LOCK_DIR override`() {
		val override = tempDir.resolve("custom-lock-dir")
		val env = fakeHookEnv(env = mapOf("JOLLI_SYNC_LOCK_DIR" to override.toString()))
		assertEquals(override.resolve("sync.lock"), SyncLock.getSyncLockPath(env))
	}
}

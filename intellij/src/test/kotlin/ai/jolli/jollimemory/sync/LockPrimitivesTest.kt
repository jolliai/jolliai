package ai.jolli.jollimemory.sync

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.FileTime
import java.time.Instant

class LockPrimitivesTest {

	@TempDir
	lateinit var tempDir: Path

	// ── tryAcquireOnce ───────────────────────────────────────────────

	@Test
	fun `acquires lock on empty directory`() {
		val lockPath = tempDir.resolve("test.lock")
		assertTrue(LockPrimitives.tryAcquireOnce(lockPath))
		assertTrue(Files.exists(lockPath))
		val content = Files.readString(lockPath).trim()
		assertEquals(ProcessHandle.current().pid().toString(), content)
	}

	@Test
	fun `fails when lock is fresh and held by current process`() {
		val lockPath = tempDir.resolve("test.lock")
		assertTrue(LockPrimitives.tryAcquireOnce(lockPath))
		// Second attempt should fail — lock is fresh and PID is alive.
		assertFalse(LockPrimitives.tryAcquireOnce(lockPath))
	}

	@Test
	fun `reclaims stale lock`() {
		val lockPath = tempDir.resolve("test.lock")
		Files.writeString(lockPath, "99999999") // fake PID
		// Set mtime to 10 minutes ago.
		val oldTime = Instant.now().minusMillis(10 * 60 * 1000)
		Files.setLastModifiedTime(lockPath, FileTime.from(oldTime))
		assertTrue(LockPrimitives.tryAcquireOnce(lockPath))
	}

	@Test
	fun `reclaims lock with dead PID even if mtime is fresh`() {
		val lockPath = tempDir.resolve("test.lock")
		// PID 99999999 is almost certainly not running.
		Files.writeString(lockPath, "99999999")
		assertTrue(LockPrimitives.tryAcquireOnce(lockPath))
	}

	// ── releaseIfOwned ───────────────────────────────────────────────

	@Test
	fun `releases own lock`() {
		val lockPath = tempDir.resolve("test.lock")
		LockPrimitives.tryAcquireOnce(lockPath)
		assertTrue(Files.exists(lockPath))
		LockPrimitives.releaseIfOwned(lockPath, "test")
		assertFalse(Files.exists(lockPath))
	}

	@Test
	fun `does not release lock held by another PID`() {
		val lockPath = tempDir.resolve("test.lock")
		Files.writeString(lockPath, "99999999")
		LockPrimitives.releaseIfOwned(lockPath, "test")
		// File should still exist — we didn't own it.
		assertTrue(Files.exists(lockPath))
	}

	@Test
	fun `release is no-op on missing file`() {
		val lockPath = tempDir.resolve("nonexistent.lock")
		// Should not throw.
		LockPrimitives.releaseIfOwned(lockPath, "test")
	}

	// ── acquireWithPoll ──────────────────────────────────────────────

	@Test
	fun `acquireWithPoll succeeds immediately when no contention`() {
		val lockPath = tempDir.resolve("test.lock")
		assertTrue(LockPrimitives.acquireWithPoll(lockPath, 1000, 50))
	}

	@Test
	fun `acquireWithPoll times out on held lock`() {
		val lockPath = tempDir.resolve("test.lock")
		// Write a "held by another alive process" lock — use PID 1 which is
		// always alive on most OSes.
		Files.writeString(lockPath, "1")
		assertFalse(LockPrimitives.acquireWithPoll(lockPath, 200, 50))
	}

	@Test
	fun `acquireWithPoll with zero timeout is fail-fast`() {
		val lockPath = tempDir.resolve("test.lock")
		assertTrue(LockPrimitives.acquireWithPoll(lockPath, 0, 50))
	}

	// ── refreshLockMtime ─────────────────────────────────────────────

	@Test
	fun `refreshes mtime of own lock`() {
		val lockPath = tempDir.resolve("test.lock")
		LockPrimitives.tryAcquireOnce(lockPath)
		val oldTime = Instant.now().minusMillis(60_000)
		Files.setLastModifiedTime(lockPath, FileTime.from(oldTime))
		LockPrimitives.refreshLockMtime(lockPath)
		val newMtime = Files.getLastModifiedTime(lockPath).toMillis()
		assertTrue(System.currentTimeMillis() - newMtime < 5000)
	}

	@Test
	fun `does not refresh lock held by another PID`() {
		val lockPath = tempDir.resolve("test.lock")
		Files.writeString(lockPath, "99999999")
		val oldTime = Instant.now().minusMillis(60_000)
		Files.setLastModifiedTime(lockPath, FileTime.from(oldTime))
		LockPrimitives.refreshLockMtime(lockPath)
		val mtime = Files.getLastModifiedTime(lockPath).toMillis()
		// Should still be old — we didn't own it.
		assertTrue(System.currentTimeMillis() - mtime > 30_000)
	}

	// ── isLockHeld ───────────────────────────────────────────────────

	@Test
	fun `isLockHeld returns true for fresh lock`() {
		val lockPath = tempDir.resolve("test.lock")
		LockPrimitives.tryAcquireOnce(lockPath)
		assertTrue(LockPrimitives.isLockHeld(lockPath))
	}

	@Test
	fun `isLockHeld returns false for stale lock`() {
		val lockPath = tempDir.resolve("test.lock")
		Files.writeString(lockPath, "12345")
		val oldTime = Instant.now().minusMillis(10 * 60 * 1000)
		Files.setLastModifiedTime(lockPath, FileTime.from(oldTime))
		assertFalse(LockPrimitives.isLockHeld(lockPath))
	}

	@Test
	fun `isLockHeld returns false for missing lock`() {
		val lockPath = tempDir.resolve("nonexistent.lock")
		assertFalse(LockPrimitives.isLockHeld(lockPath))
	}

	// ── isPidAlive ───────────────────────────────────────────────────

	@Test
	fun `current process is alive`() {
		assertTrue(LockPrimitives.isPidAlive(ProcessHandle.current().pid()))
	}

	@Test
	fun `bogus PID is not alive`() {
		assertFalse(LockPrimitives.isPidAlive(99999999))
	}

	@Test
	fun `negative PID is not alive`() {
		assertFalse(LockPrimitives.isPidAlive(-1))
	}

	@Test
	fun `zero PID is not alive`() {
		assertFalse(LockPrimitives.isPidAlive(0))
	}
}

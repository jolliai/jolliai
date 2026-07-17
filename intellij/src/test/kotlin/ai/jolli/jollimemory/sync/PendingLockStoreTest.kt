package ai.jolli.jollimemory.sync

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.junit.jupiter.api.parallel.ResourceLock
import java.nio.file.Files
import java.nio.file.Path

// PendingLockStore.write() names its tmp file after the PID, which every class
// in the single-JVM parallel run shares — two concurrent writers use the same
// tmp path and the loser's rename throws NoSuchFileException. The lock
// serialises this class against SyncEngineTest, the other writer of that file.
@ResourceLock("pending-lock")
class PendingLockStoreTest {

	// NOTE: PendingLockStore uses a hardcoded path under ~/.jolli/jollimemory/.
	// These tests exercise the read/write/clear logic by writing directly to
	// that location. In a real test environment, we'd use a temp override.
	// For now, we test the data structures and hash consistency.

	@Test
	fun `ReadPendingLockResult holds correct values`() {
		val result = ReadPendingLockResult(
			lockOwnerToken = "token-123",
			mintedAt = 1000L,
		)
		assertEquals("token-123", result.lockOwnerToken)
		assertEquals(1000L, result.mintedAt)
	}

	@Test
	fun `read returns null for missing file`() {
		// Before any write, read should return null for any key.
		// This may read from the real path but that's fine — it's a read-only check.
		val result = PendingLockStore.read("sk-jol-nonexistent-key-for-testing-only")
		assertNull(result)
	}

	@Test
	fun `write and read round-trip`() {
		val testKey = "sk-jol-test-key-pending-lock-roundtrip-${System.nanoTime()}"
		try {
			PendingLockStore.write(testKey, "lock-token-abc", 42_000L)
			val result = PendingLockStore.read(testKey)
			assertNotNull(result)
			assertEquals("lock-token-abc", result!!.lockOwnerToken)
			assertEquals(42_000L, result.mintedAt)
		} finally {
			PendingLockStore.clear()
		}
	}

	@Test
	fun `read returns null for wrong API key`() {
		val testKey = "sk-jol-test-key-pending-lock-wrongkey-${System.nanoTime()}"
		try {
			PendingLockStore.write(testKey, "lock-token-xyz", 100_000L)
			val result = PendingLockStore.read("sk-jol-different-key")
			assertNull(result)
		} finally {
			PendingLockStore.clear()
		}
	}

	@Test
	fun `clear removes the file`() {
		val testKey = "sk-jol-test-key-pending-lock-clear-${System.nanoTime()}"
		PendingLockStore.write(testKey, "lock-token-clear", 200_000L)
		PendingLockStore.clear()
		val result = PendingLockStore.read(testKey)
		assertNull(result)
	}
}

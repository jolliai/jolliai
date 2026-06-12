package ai.jolli.jollimemory.sync

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path

class VaultLockPathTest {

	@TempDir
	lateinit var tempDir: Path

	@Test
	fun `canonicalisation is stable across calls`() {
		val a = canonicaliseLocalFolder(tempDir.toString())
		val b = canonicaliseLocalFolder(tempDir.toString())
		assertEquals(a, b)
	}

	@Test
	fun `canonicalisation resolves trailing separator`() {
		val withSlash = canonicaliseLocalFolder(tempDir.toString() + "/")
		val without = canonicaliseLocalFolder(tempDir.toString())
		assertEquals(withSlash, without)
	}

	@Test
	fun `empty input throws`() {
		assertThrows(IllegalArgumentException::class.java) {
			canonicaliseLocalFolder("")
		}
	}

	@Test
	fun `getVaultWriteLockPath returns deterministic hash`() {
		val path1 = getVaultWriteLockPath(tempDir.toString())
		val path2 = getVaultWriteLockPath(tempDir.toString())
		assertEquals(path1, path2)
		assertTrue(path1.fileName.toString().startsWith("vault-"))
		assertTrue(path1.fileName.toString().endsWith(".lock"))
	}

	@Test
	fun `different paths produce different lock files`() {
		val path1 = getVaultWriteLockPath(tempDir.resolve("a").toString())
		val path2 = getVaultWriteLockPath(tempDir.resolve("b").toString())
		assertNotEquals(path1, path2)
	}

	@Test
	fun `tilde expansion works`() {
		val home = System.getProperty("user.home")
		val fromTilde = canonicaliseLocalFolder("~/test-folder")
		val fromFull = canonicaliseLocalFolder("$home/test-folder")
		assertEquals(fromTilde, fromFull)
	}
}

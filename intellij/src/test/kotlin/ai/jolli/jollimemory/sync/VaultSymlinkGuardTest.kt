package ai.jolli.jollimemory.sync

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

class VaultSymlinkGuardTest {

	@TempDir
	lateinit var tempDir: Path

	@Test
	fun `passes with real directories`() {
		val vault = tempDir.resolve("vault")
		Files.createDirectories(vault.resolve("repo/.jolli/summaries"))
		// Should not throw.
		assertNoSymlinksInPath(
			vault.toString(),
			vault.resolve("repo/.jolli/summaries/abc.json").toString(),
		)
	}

	@Test
	fun `passes when intermediate dirs do not exist`() {
		val vault = tempDir.resolve("vault2")
		Files.createDirectories(vault)
		// Deeper dirs don't exist yet — should not throw (ENOENT is tolerated).
		assertNoSymlinksInPath(
			vault.toString(),
			vault.resolve("new-repo/.jolli/summaries/abc.json").toString(),
		)
	}

	@Test
	fun `throws when target escapes vault`() {
		val vault = tempDir.resolve("vault3")
		Files.createDirectories(vault)
		assertThrows(IllegalArgumentException::class.java) {
			assertNoSymlinksInPath(
				vault.toString(),
				tempDir.resolve("outside/file.json").toString(),
			)
		}
	}

	@Test
	fun `throws when intermediate segment is a symlink`() {
		val vault = tempDir.resolve("vault4")
		Files.createDirectories(vault)
		val realTarget = tempDir.resolve("real-target")
		Files.createDirectories(realTarget)
		// Create a symlink inside the vault pointing outside.
		val link = vault.resolve("evil-link")
		Files.createSymbolicLink(link, realTarget)
		assertThrows(IllegalStateException::class.java) {
			assertNoSymlinksInPath(
				vault.toString(),
				vault.resolve("evil-link/file.json").toString(),
			)
		}
	}

	@Test
	fun `throws when segment is a regular file instead of directory`() {
		val vault = tempDir.resolve("vault5")
		Files.createDirectories(vault)
		Files.writeString(vault.resolve("not-a-dir"), "content")
		assertThrows(IllegalStateException::class.java) {
			assertNoSymlinksInPath(
				vault.toString(),
				vault.resolve("not-a-dir/file.json").toString(),
			)
		}
	}

	@Test
	fun `throws when target equals vault root`() {
		val vault = tempDir.resolve("vault6")
		Files.createDirectories(vault)
		assertThrows(IllegalArgumentException::class.java) {
			assertNoSymlinksInPath(vault.toString(), vault.toString())
		}
	}
}

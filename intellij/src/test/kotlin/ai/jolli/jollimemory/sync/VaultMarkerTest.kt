package ai.jolli.jollimemory.sync

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

class VaultMarkerTest {

	@TempDir
	lateinit var tempDir: Path

	private fun makeCreds(
		gitUrl: String = "https://github.com/jolli-vaults/test-user.git",
	) = GitCredentials(
		token = "ghs_test",
		gitUrl = gitUrl,
		expiresAt = System.currentTimeMillis() + 3_600_000L,
		repoFullName = "jolli-vaults/test-user",
		defaultBranch = "main",
		githubRepoCreated = false,
		alreadyVaultBound = false,
		lockOwnerToken = "lock-123",
	)

	// ── normalizeGitUrl ──────────────────────────────────────────────

	@Test
	fun `strips trailing dot-git`() {
		assertEquals(
			"https://github.com/jolli-vaults/test",
			normalizeGitUrl("https://github.com/jolli-vaults/test.git"),
		)
	}

	@Test
	fun `strips auth segment`() {
		assertEquals(
			"https://github.com/jolli-vaults/test",
			normalizeGitUrl("https://x-access-token:ghs_abc@github.com/jolli-vaults/test.git"),
		)
	}

	@Test
	fun `lowercases host always`() {
		assertEquals(
			"https://github.com/jolli-vaults/test",
			normalizeGitUrl("https://GitHub.COM/jolli-vaults/test"),
		)
	}

	@Test
	fun `lowercases path for GitHub`() {
		assertEquals(
			"https://github.com/jolli-vaults/test",
			normalizeGitUrl("https://github.com/Jolli-Vaults/TEST"),
		)
	}

	@Test
	fun `preserves path case for non-GitHub hosts`() {
		assertEquals(
			"https://git.example.com/MyOrg/MyRepo",
			normalizeGitUrl("https://git.example.com/MyOrg/MyRepo"),
		)
	}

	@Test
	fun `strips trailing slash`() {
		assertEquals(
			"https://github.com/jolli-vaults/test",
			normalizeGitUrl("https://github.com/jolli-vaults/test/"),
		)
	}

	@Test
	fun `returns non-https URLs unchanged`() {
		val url = "git@github.com:user/repo.git"
		assertEquals(url, normalizeGitUrl(url))
	}

	// ── writeVaultMarker + readVaultMarker ────────────────────────────

	@Test
	fun `write and read round-trip`() {
		val root = tempDir.toString()
		Files.createDirectories(Path.of(root, ".git"))
		val creds = makeCreds()
		writeVaultMarker(root, creds)
		val marker = readVaultMarker(root)
		assertNotNull(marker)
		assertEquals("jolli-memory-bank", marker!!.kind)
		assertEquals(1, marker.version)
		assertEquals(normalizeGitUrl(creds.gitUrl), marker.gitUrl)
		assertEquals("jolli-vaults/test-user", marker.repoFullName)
		assertEquals("main", marker.defaultBranch)
	}

	@Test
	fun `readVaultMarker returns null for missing marker`() {
		val root = tempDir.resolve("empty").toString()
		Files.createDirectories(Path.of(root, ".git"))
		assertNull(readVaultMarker(root))
	}

	@Test
	fun `readVaultMarker returns null for corrupt JSON`() {
		val root = tempDir.toString()
		val markerPath = Path.of(root, ".git", "jolli-vault-identity.json")
		Files.createDirectories(markerPath.parent)
		Files.writeString(markerPath, "not json")
		assertNull(readVaultMarker(root))
	}

	@Test
	fun `readVaultMarker returns null for wrong kind`() {
		val root = tempDir.toString()
		val markerPath = Path.of(root, ".git", "jolli-vault-identity.json")
		Files.createDirectories(markerPath.parent)
		Files.writeString(markerPath, """{"kind":"wrong","version":1,"gitUrl":"https://x.com/a/b"}""")
		assertNull(readVaultMarker(root))
	}

	// ── verifyVaultMarker ────────────────────────────────────────────

	@Test
	fun `verify succeeds with matching URLs`() {
		val root = tempDir.toString()
		Files.createDirectories(Path.of(root, ".git"))
		val creds = makeCreds()
		writeVaultMarker(root, creds)
		val verdict = verifyVaultMarker(root, creds.gitUrl, creds)
		assertTrue(verdict is VaultVerdict.Ok)
	}

	@Test
	fun `verify fails with missing marker`() {
		val root = tempDir.resolve("empty2").toString()
		Files.createDirectories(Path.of(root, ".git"))
		val creds = makeCreds()
		val verdict = verifyVaultMarker(root, creds.gitUrl, creds)
		assertTrue(verdict is VaultVerdict.Failed)
		assertEquals("missing_marker", (verdict as VaultVerdict.Failed).reason)
	}

	@Test
	fun `verify fails with URL mismatch`() {
		val root = tempDir.toString()
		Files.createDirectories(Path.of(root, ".git"))
		val creds = makeCreds()
		writeVaultMarker(root, creds)
		val otherCreds = makeCreds(gitUrl = "https://github.com/other-org/other-repo.git")
		val verdict = verifyVaultMarker(root, creds.gitUrl, otherCreds)
		assertTrue(verdict is VaultVerdict.Failed)
		assertEquals("url_mismatch", (verdict as VaultVerdict.Failed).reason)
	}

	@Test
	fun `verify fails with null origin URL`() {
		val root = tempDir.toString()
		Files.createDirectories(Path.of(root, ".git"))
		val creds = makeCreds()
		writeVaultMarker(root, creds)
		val verdict = verifyVaultMarker(root, null, creds)
		assertTrue(verdict is VaultVerdict.Failed)
		assertEquals("url_mismatch", (verdict as VaultVerdict.Failed).reason)
	}

	@Test
	fun `verify flags needsRewrite when stored URL differs in case`() {
		val root = tempDir.toString()
		Files.createDirectories(Path.of(root, ".git"))
		// Write marker with uppercase path (simulating old client).
		val markerPath = Path.of(root, ".git", "jolli-vault-identity.json")
		Files.writeString(
			markerPath,
			"""{"kind":"jolli-memory-bank","version":1,"createdAt":"","gitUrl":"https://github.com/Jolli-Vaults/Test-User","repoFullName":"jolli-vaults/test-user","defaultBranch":"main"}""",
		)
		val creds = makeCreds(gitUrl = "https://github.com/jolli-vaults/test-user")
		val verdict = verifyVaultMarker(root, creds.gitUrl, creds)
		assertTrue(verdict is VaultVerdict.Ok)
		assertTrue((verdict as VaultVerdict.Ok).needsRewrite)
	}
}

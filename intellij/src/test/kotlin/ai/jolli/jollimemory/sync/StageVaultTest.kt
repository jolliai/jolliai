package ai.jolli.jollimemory.sync

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

class StageVaultTest {

	@TempDir
	lateinit var tempDir: Path

	private fun staticRunner(result: ExecResult): ProcessRunner {
		return object : ProcessRunner {
			override fun exec(command: List<String>, cwd: String?, env: Map<String, String>, timeoutMs: Long?): ExecResult {
				return result
			}
		}
	}

	private class RecordingRunner(private val responses: ArrayDeque<ExecResult>) : ProcessRunner {
		val calls = mutableListOf<List<String>>()
		override fun exec(command: List<String>, cwd: String?, env: Map<String, String>, timeoutMs: Long?): ExecResult {
			calls.add(command)
			return if (responses.isNotEmpty()) responses.removeFirst() else ExecResult("", "", 0)
		}
	}

	private val defaultCredentials = GitCredentials(
		token = "ghs_test",
		gitUrl = "https://github.com/test/vault.git",
		expiresAt = System.currentTimeMillis() + 3_600_000L,
		repoFullName = "test/vault",
		defaultBranch = "main",
		githubRepoCreated = false,
		alreadyVaultBound = false,
		lockOwnerToken = "lock-123",
	)

	private val fakeAskpass: (String) -> AskpassHandle = { _ ->
		AskpassHandle(
			scriptPath = "/fake/askpass.sh",
			env = mapOf("GIT_ASKPASS" to "/fake/askpass.sh"),
		)
	}

	/**
	 * Creates a SyncGitClient backed by a [RecordingRunner] that returns
	 * canned responses. The runner records all commands for assertion.
	 */
	private fun clientWithRunner(runner: ProcessRunner): SyncGitClient {
		return SyncGitClient(
			vaultRoot = tempDir.toString(),
			credentials = defaultCredentials,
			askpassProvider = fakeAskpass,
			processRunner = runner,
		)
	}

	// ── Empty status ─────────────────────────────────────────────────

	@Test
	fun `empty status produces empty report`() {
		val runner = staticRunner(ExecResult(stdout = "", stderr = "", exitCode = 0))
		val client = clientWithRunner(runner)
		val report = stageVault(client, tempDir.toString(), StageVaultOpts(syncTranscripts = true))
		assertEquals(0, report.added)
		assertEquals(0, report.removed)
		assertEquals(0, report.skipped)
		assertTrue(report.unowned.isEmpty())
		assertTrue(report.symlinked.isEmpty())
	}

	// ── Classify and stage ───────────────────────────────────────────

	@Test
	fun `stages owned add and tracks kind`() {
		// Simulate: new file my-repo/.jolli/config.json (added, untracked)
		val statusOutput = "?? my-repo/.jolli/config.json\u0000"
		val recording = RecordingRunner(
			ArrayDeque(
				listOf(
					// statusPorcelainZ
					ExecResult(stdout = statusOutput, stderr = "", exitCode = 0),
					// stageAddPaths
					ExecResult(stdout = "", stderr = "", exitCode = 0),
				)
			)
		)
		val client = clientWithRunner(recording)

		// Create the file on disk so symlink check passes.
		val filePath = tempDir.resolve("my-repo/.jolli/config.json")
		Files.createDirectories(filePath.parent)
		Files.writeString(filePath, "{}")

		val report = stageVault(client, tempDir.toString(), StageVaultOpts(syncTranscripts = true))
		assertEquals(1, report.added)
		assertEquals(0, report.removed)
		assertTrue(report.unowned.isEmpty())
	}

	// ── Unowned paths ────────────────────────────────────────────────

	@Test
	fun `unowned paths are not staged`() {
		val statusOutput = "?? .DS_Store\u0000"
		val runner = staticRunner(ExecResult(stdout = statusOutput, stderr = "", exitCode = 0))
		val client = clientWithRunner(runner)
		val report = stageVault(client, tempDir.toString(), StageVaultOpts(syncTranscripts = true))
		assertEquals(0, report.added)
		assertEquals(1, report.unowned.size)
		assertEquals(".DS_Store", report.unowned[0])
	}

	// ── Transcript filtering ─────────────────────────────────────────

	@Test
	fun `transcripts skipped when syncTranscripts is false`() {
		val statusOutput = "?? my-repo/.jolli/transcripts/abc1234.json\u0000"
		val runner = staticRunner(ExecResult(stdout = statusOutput, stderr = "", exitCode = 0))
		val client = clientWithRunner(runner)
		val report = stageVault(client, tempDir.toString(), StageVaultOpts(syncTranscripts = false))
		assertEquals(0, report.added)
		assertEquals(1, report.skipped)
	}

	// ── Deletion handling ────────────────────────────────────────────

	@Test
	fun `deletion of owned path is staged as removal`() {
		val statusOutput = " D my-repo/.jolli/config.json\u0000"
		val recording = RecordingRunner(
			ArrayDeque(
				listOf(
					// statusPorcelainZ
					ExecResult(stdout = statusOutput, stderr = "", exitCode = 0),
					// stageRemovePaths
					ExecResult(stdout = "", stderr = "", exitCode = 0),
				)
			)
		)
		val client = clientWithRunner(recording)
		val report = stageVault(client, tempDir.toString(), StageVaultOpts(syncTranscripts = true))
		assertEquals(0, report.added)
		assertEquals(1, report.removed)
	}

	// ── Symlink blocking ─────────────────────────────────────────────

	@Test
	fun `symlink at leaf is blocked`() {
		val statusOutput = "?? my-repo/.jolli/index.json\u0000"
		val runner = staticRunner(ExecResult(stdout = statusOutput, stderr = "", exitCode = 0))
		val client = clientWithRunner(runner)

		// Create a symlink instead of a real file.
		val target = tempDir.resolve("real-target.json")
		Files.writeString(target, "{}")
		val link = tempDir.resolve("my-repo/.jolli/index.json")
		Files.createDirectories(link.parent)
		createSymbolicLinkOrSkip(link, target)

		val report = stageVault(client, tempDir.toString(), StageVaultOpts(syncTranscripts = true))
		assertEquals(0, report.added)
		assertEquals(1, report.symlinked.size)
	}

	// ── StageReport data class ───────────────────────────────────────

	@Test
	fun `StageReport holds correct values`() {
		val report = StageReport(
			added = 5,
			removed = 2,
			skipped = 1,
			unowned = listOf("a", "b"),
			symlinked = listOf("c"),
			byKind = mapOf("SUMMARY" to 3, "REPO_CONFIG" to 2),
		)
		assertEquals(5, report.added)
		assertEquals(2, report.removed)
		assertEquals(1, report.skipped)
		assertEquals(2, report.unowned.size)
		assertEquals(1, report.symlinked.size)
	}
}

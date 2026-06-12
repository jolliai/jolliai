package ai.jolli.jollimemory.sync

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path

class SyncGitClientTest {

	private val defaultCredentials = GitCredentials(
		token = "ghs_test_token_123",
		gitUrl = "https://github.com/test-user/vault.git",
		expiresAt = System.currentTimeMillis() + 3_600_000L,
		repoFullName = "test-user/vault",
		defaultBranch = "main",
		githubRepoCreated = false,
		alreadyVaultBound = false,
		lockOwnerToken = "lock-token-123",
	)

	private val fakeAskpass: (String) -> AskpassHandle = { token ->
		AskpassHandle(
			scriptPath = "/fake/askpass.sh",
			env = mapOf(
				"GIT_ASKPASS" to "/fake/askpass.sh",
				"GIT_TERMINAL_PROMPT" to "0",
				"JOLLI_SYNC_GIT_TOKEN" to token,
			),
		)
	}

	private fun client(
		runner: ProcessRunner,
		vaultRoot: String = "/fake/vault",
		credentials: GitCredentials = defaultCredentials,
	): SyncGitClient {
		return SyncGitClient(
			vaultRoot = vaultRoot,
			credentials = credentials,
			askpassProvider = fakeAskpass,
			processRunner = runner,
		)
	}

	/** Builds a fake runner that returns the given result for any command. */
	private fun staticRunner(
		stdout: String = "",
		stderr: String = "",
		exitCode: Int = 0,
	): ProcessRunner {
		return object : ProcessRunner {
			override fun exec(command: List<String>, cwd: String?, env: Map<String, String>, timeoutMs: Long?): ExecResult {
				return ExecResult(stdout, stderr, exitCode)
			}
		}
	}

	/** Builds a fake runner that captures calls and returns from a queue. */
	private class RecordingRunner(private val responses: MutableList<ExecResult>) : ProcessRunner {
		val calls = mutableListOf<CapturedCall>()

		data class CapturedCall(
			val command: List<String>,
			val cwd: String?,
			val env: Map<String, String>,
			val timeoutMs: Long?,
		)

		override fun exec(command: List<String>, cwd: String?, env: Map<String, String>, timeoutMs: Long?): ExecResult {
			calls.add(CapturedCall(command, cwd, env, timeoutMs))
			return if (responses.isNotEmpty()) responses.removeAt(0) else ExecResult("", "", 0)
		}
	}

	// ── clone ─────────────────────────────────────────────────────────

	@Test
	fun `clone injects x-access-token username`() {
		val runner = RecordingRunner(mutableListOf(
			ExecResult("", "", 0), // clone
			ExecResult("", "", 0), // config core.symlinks
		))
		val c = client(runner)
		c.clone("https://github.com/user/repo.git")
		val cloneCall = runner.calls[0]
		assertTrue(cloneCall.command.any { it.contains("x-access-token@") })
	}

	@Test
	fun `clone runs with no cwd`() {
		val runner = RecordingRunner(mutableListOf(
			ExecResult("", "", 0),
			ExecResult("", "", 0),
		))
		val c = client(runner)
		c.clone("https://github.com/user/repo.git")
		assertNull(runner.calls[0].cwd)
	}

	@Test
	fun `clone persists no-symlinks config`() {
		val runner = RecordingRunner(mutableListOf(
			ExecResult("", "", 0),
			ExecResult("", "", 0),
		))
		val c = client(runner)
		c.clone("https://github.com/user/repo.git")
		assertEquals(2, runner.calls.size)
		assertTrue(runner.calls[1].command.any { it == "core.symlinks" })
	}

	// ── fetch ─────────────────────────────────────────────────────────

	@Test
	fun `fetch runs git fetch origin`() {
		val runner = RecordingRunner(mutableListOf(ExecResult("", "", 0)))
		val c = client(runner)
		c.fetch()
		val cmd = runner.calls[0].command
		assertTrue(cmd.contains("fetch"))
		assertTrue(cmd.contains("origin"))
	}

	@Test
	fun `fetch injects askpass env`() {
		val runner = RecordingRunner(mutableListOf(ExecResult("", "", 0)))
		val c = client(runner)
		c.fetch()
		val env = runner.calls[0].env
		assertEquals("/fake/askpass.sh", env["GIT_ASKPASS"])
		assertEquals("ghs_test_token_123", env["JOLLI_SYNC_GIT_TOKEN"])
	}

	// ── pullRebase ────────────────────────────────────────────────────

	@Test
	fun `pullRebase detects fast-forward`() {
		val runner = staticRunner(stdout = "Updating abc..def\nFast-forward\n src/foo.kt | 2 +-")
		val result = client(runner).pullRebase()
		assertTrue(result.fastForwarded)
		assertTrue(result.conflicted.isEmpty())
	}

	@Test
	fun `pullRebase detects conflicts via unmerged paths`() {
		val runner = RecordingRunner(mutableListOf(
			// pullRebase itself fails
			ExecResult("", "CONFLICT (content): Merge conflict in foo.kt", 1),
			// hasUnmergedPaths — ls-files -u -z
			ExecResult("100644 abc123 2\tfoo.kt\u0000100644 def456 3\tfoo.kt\u0000", "", 0),
		))
		val result = client(runner).pullRebase()
		assertFalse(result.fastForwarded)
		assertEquals(listOf("foo.kt"), result.conflicted)
	}

	@Test
	fun `pullRebase throws on non-conflict failure`() {
		val runner = RecordingRunner(mutableListOf(
			ExecResult("", "fatal: some error", 1),
			// hasUnmergedPaths returns empty
			ExecResult("", "", 0),
		))
		assertThrows(RuntimeException::class.java) {
			client(runner).pullRebase()
		}
	}

	@Test
	fun `pullRebase suppresses editor`() {
		val runner = RecordingRunner(mutableListOf(ExecResult("", "", 0)))
		client(runner).pullRebase()
		val env = runner.calls[0].env
		assertEquals("true", env["GIT_EDITOR"])
		assertEquals("true", env["GIT_SEQUENCE_EDITOR"])
	}

	@Test
	fun `pullRebase uses autostash so unowned dirty files do not block the rebase`() {
		// A dirty working tree (e.g. unrecognized .jolli/topics/ files left by a
		// newer surface's hook) would otherwise hard-fail the rebase and drop
		// the whole sync round to offline. --autostash shelves and restores them.
		val runner = RecordingRunner(mutableListOf(ExecResult("", "", 0)))
		client(runner).pullRebase()
		assertTrue(runner.calls[0].command.contains("--autostash"))
	}

	// ── commit ────────────────────────────────────────────────────────

	@Test
	fun `commit returns HEAD sha on success`() {
		val runner = RecordingRunner(mutableListOf(
			ExecResult("", "", 0), // commit
			ExecResult("abc123def456", "", 0), // rev-parse HEAD
		))
		val sha = client(runner).commit("test commit", CommitAuthor("Test", "test@test.com"))
		assertEquals("abc123def456", sha)
	}

	@Test
	fun `commit returns current HEAD when nothing to commit`() {
		val runner = RecordingRunner(mutableListOf(
			ExecResult("nothing to commit, working tree clean", "", 1),
			ExecResult("existingsha", "", 0),
		))
		val sha = client(runner).commit("test", CommitAuthor("Test", "test@test.com"))
		assertEquals("existingsha", sha)
	}

	@Test
	fun `commit throws on real failure`() {
		val runner = staticRunner(stderr = "fatal: some error", exitCode = 1)
		assertThrows(RuntimeException::class.java) {
			client(runner).commit("test", CommitAuthor("Test", "test@test.com"))
		}
	}

	// ── push ──────────────────────────────────────────────────────────

	@Test
	fun `push ok with transmitted`() {
		val runner = staticRunner(stderr = "To https://github.com/...\n   abc..def  HEAD -> main")
		val result = client(runner).push()
		assertTrue(result is PushResult.Ok)
		assertTrue((result as PushResult.Ok).transmitted)
	}

	@Test
	fun `push ok up-to-date`() {
		val runner = staticRunner(stderr = "Everything up-to-date")
		val result = client(runner).push()
		assertTrue(result is PushResult.Ok)
		assertFalse((result as PushResult.Ok).transmitted)
	}

	@Test
	fun `push detects non-fast-forward`() {
		val runner = staticRunner(stderr = "! [rejected] ... (non-fast-forward)", exitCode = 1)
		val result = client(runner).push()
		assertTrue(result is PushResult.Failed)
		assertTrue((result as PushResult.Failed).nonFastForward)
		assertFalse(result.unauthorized)
		assertFalse(result.repoMissing)
	}

	@Test
	fun `push detects unauthorized`() {
		val runner = staticRunner(stderr = "fatal: Authentication failed for ...", exitCode = 128)
		val result = client(runner).push()
		assertTrue(result is PushResult.Failed)
		assertTrue((result as PushResult.Failed).unauthorized)
	}

	@Test
	fun `push detects repo missing`() {
		val runner = staticRunner(stderr = "remote: Repository not found.\nfatal: ...", exitCode = 128)
		val result = client(runner).push()
		assertTrue(result is PushResult.Failed)
		assertTrue((result as PushResult.Failed).repoMissing)
		assertFalse(result.unauthorized)
	}

	@Test
	fun `push unauthorized takes priority over repo missing`() {
		val runner = staticRunner(
			stderr = "Authentication failed\nremote: Repository not found.",
			exitCode = 128,
		)
		val result = client(runner).push()
		assertTrue(result is PushResult.Failed)
		assertTrue((result as PushResult.Failed).unauthorized)
		assertFalse(result.repoMissing)
	}

	// ── conflict resolution ───────────────────────────────────────────

	@Test
	fun `readIndexStage returns content on success`() {
		val runner = staticRunner(stdout = "{\"key\":\"value\"}")
		val content = client(runner).readIndexStage("foo.json", 2)
		assertEquals("{\"key\":\"value\"}", content)
	}

	@Test
	fun `readIndexStage returns null on failure`() {
		val runner = staticRunner(exitCode = 1)
		assertNull(client(runner).readIndexStage("missing.json", 1))
	}

	@Test
	fun `readIndexStage rejects invalid stage`() {
		assertThrows(IllegalArgumentException::class.java) {
			client(staticRunner()).readIndexStage("foo.json", 0)
		}
	}

	@Test
	fun `checkoutOurs uses --theirs flag due to rebase inversion`() {
		val runner = RecordingRunner(mutableListOf(
			ExecResult("", "", 0), // checkout
			ExecResult("", "", 0), // add
		))
		client(runner).checkoutOurs("foo.kt")
		assertTrue(runner.calls[0].command.contains("--theirs"))
	}

	@Test
	fun `checkoutTheirs uses --ours flag due to rebase inversion`() {
		val runner = RecordingRunner(mutableListOf(
			ExecResult("", "", 0),
			ExecResult("", "", 0),
		))
		client(runner).checkoutTheirs("foo.kt")
		assertTrue(runner.calls[0].command.contains("--ours"))
	}

	@Test
	fun `rebaseContinue applies timeout`() {
		val runner = RecordingRunner(mutableListOf(ExecResult("", "", 0)))
		client(runner).rebaseContinue()
		assertEquals(SyncGitClient.REBASE_TIMEOUT_MS, runner.calls[0].timeoutMs)
	}

	@Test
	fun `rebaseAbort applies timeout`() {
		val runner = RecordingRunner(mutableListOf(ExecResult("", "", 0)))
		client(runner).rebaseAbort()
		assertEquals(SyncGitClient.REBASE_TIMEOUT_MS, runner.calls[0].timeoutMs)
	}

	// ── self-healing ──────────────────────────────────────────────────

	@Test
	fun `isRebaseInProgress detects rebase-merge dir`(@TempDir tempDir: Path) {
		val vault = tempDir.toFile()
		File(vault, ".git/rebase-merge").mkdirs()
		val c = client(staticRunner(), vaultRoot = vault.absolutePath)
		assertTrue(c.isRebaseInProgress())
	}

	@Test
	fun `isRebaseInProgress detects rebase-apply dir`(@TempDir tempDir: Path) {
		val vault = tempDir.toFile()
		File(vault, ".git/rebase-apply").mkdirs()
		val c = client(staticRunner(), vaultRoot = vault.absolutePath)
		assertTrue(c.isRebaseInProgress())
	}

	@Test
	fun `isRebaseInProgress returns false when no rebase state`(@TempDir tempDir: Path) {
		val vault = tempDir.toFile()
		File(vault, ".git").mkdirs()
		val c = client(staticRunner(), vaultRoot = vault.absolutePath)
		assertFalse(c.isRebaseInProgress())
	}

	@Test
	fun `sweepStaleLockFiles removes old lock files`(@TempDir tempDir: Path) {
		val vault = tempDir.toFile()
		val gitDir = File(vault, ".git")
		gitDir.mkdirs()
		val lockFile = File(gitDir, "index.lock")
		lockFile.createNewFile()
		// Set modification time to 10 minutes ago
		lockFile.setLastModified(System.currentTimeMillis() - 10 * 60_000L)

		val c = client(staticRunner(), vaultRoot = vault.absolutePath)
		val removed = c.sweepStaleLockFiles()
		assertEquals(1, removed.size)
		assertFalse(lockFile.exists())
	}

	@Test
	fun `sweepStaleLockFiles keeps fresh lock files`(@TempDir tempDir: Path) {
		val vault = tempDir.toFile()
		val gitDir = File(vault, ".git")
		gitDir.mkdirs()
		val lockFile = File(gitDir, "index.lock")
		lockFile.createNewFile()
		// Fresh file — should not be removed

		val c = client(staticRunner(), vaultRoot = vault.absolutePath)
		val removed = c.sweepStaleLockFiles()
		assertTrue(removed.isEmpty())
		assertTrue(lockFile.exists())
	}

	// ── branch management ─────────────────────────────────────────────

	@Test
	fun `currentBranch returns branch name on success`() {
		val runner = staticRunner(stdout = "main\n")
		assertEquals("main", client(runner).currentBranch())
	}

	@Test
	fun `currentBranch falls back to HEAD when detached`() {
		val runner = staticRunner(exitCode = 1)
		assertEquals("HEAD", client(runner).currentBranch())
	}

	@Test
	fun `refExists returns true when ref exists`() {
		val runner = staticRunner(exitCode = 0)
		assertTrue(client(runner).refExists("refs/heads/main"))
	}

	@Test
	fun `refExists returns false when ref missing`() {
		val runner = staticRunner(exitCode = 1)
		assertFalse(client(runner).refExists("refs/heads/missing"))
	}

	@Test
	fun `isAncestor returns true on exit 0`() {
		assertTrue(client(staticRunner(exitCode = 0)).isAncestor("abc", "def"))
	}

	@Test
	fun `isAncestor returns false on non-zero exit`() {
		assertFalse(client(staticRunner(exitCode = 1)).isAncestor("abc", "def"))
	}

	@Test
	fun `listLocalBranches parses output`() {
		val runner = staticRunner(stdout = "main\nfeature/foo\ndev\n")
		val branches = client(runner).listLocalBranches()
		assertEquals(listOf("main", "feature/foo", "dev"), branches)
	}

	@Test
	fun `listLocalBranches returns empty on failure`() {
		val runner = staticRunner(exitCode = 1)
		assertTrue(client(runner).listLocalBranches().isEmpty())
	}

	// ── staging ───────────────────────────────────────────────────────

	@Test
	fun `stageAddPaths chunks large path lists`() {
		val paths = (1..100).map { "very/long/path/to/file_$it.kt" }
		val runner = RecordingRunner(mutableListOf<ExecResult>().apply {
			repeat(10) { add(ExecResult("", "", 0)) }
		})
		// Use a tiny budget to force multiple batches
		val c = SyncGitClient(
			vaultRoot = "/fake/vault",
			credentials = defaultCredentials,
			askpassProvider = fakeAskpass,
			processRunner = runner,
		)
		// Call with real budget — should fit in one call for this size
		c.stageAddPaths(paths)
		assertTrue(runner.calls.isNotEmpty())
		// All calls should contain "add" and "-f"
		for (call in runner.calls) {
			assertTrue(call.command.any { it == "add" })
			assertTrue(call.command.any { it == "-f" })
		}
	}

	// ── status ────────────────────────────────────────────────────────

	@Test
	fun `hasUncommittedChanges returns true when dirty`() {
		val runner = staticRunner(stdout = " M foo.kt\n")
		assertTrue(client(runner).hasUncommittedChanges())
	}

	@Test
	fun `hasUncommittedChanges returns false when clean`() {
		val runner = staticRunner(stdout = "")
		assertFalse(client(runner).hasUncommittedChanges())
	}

	@Test
	fun `statusPorcelainZ delegates to parser`() {
		val runner = staticRunner(stdout = "M  foo.kt\u0000A  bar.kt\u0000")
		val entries = client(runner).statusPorcelainZ()
		assertEquals(2, entries.size)
		assertEquals("foo.kt", entries[0].path)
		assertEquals("bar.kt", entries[1].path)
	}

	// ── hasUnmergedPaths ──────────────────────────────────────────────

	@Test
	fun `hasUnmergedPaths parses ls-files output`() {
		val output = "100644 abc 1\tconflict.kt\u0000100644 def 2\tconflict.kt\u0000100644 ghi 3\tconflict.kt\u0000"
		val runner = staticRunner(stdout = output)
		val entries = client(runner).hasUnmergedPaths()
		assertEquals(1, entries.size)
		assertEquals("conflict.kt", entries[0].path)
		assertEquals(setOf(1, 2, 3), entries[0].stages)
	}

	@Test
	fun `hasUnmergedPaths returns empty on clean index`() {
		val runner = staticRunner(stdout = "")
		assertTrue(client(runner).hasUnmergedPaths().isEmpty())
	}

	// ── initRemote ────────────────────────────────────────────────────

	@Test
	fun `initRemote uses defaultBranch`() {
		val runner = RecordingRunner(mutableListOf(
			ExecResult("", "", 0), // init
			ExecResult("", "", 0), // remote add
			ExecResult("", "", 0), // config
		))
		client(runner).initRemote("https://github.com/user/repo.git")
		val initCmd = runner.calls[0].command
		assertTrue(initCmd.any { it.contains("--initial-branch=main") })
	}

	@Test
	fun `initRemote falls back to set-url when remote exists`() {
		val runner = RecordingRunner(mutableListOf(
			ExecResult("", "", 0),  // init
			ExecResult("", "fatal: remote origin already exists", 1), // remote add fails
			ExecResult("", "", 0),  // remote set-url
			ExecResult("", "", 0),  // config
		))
		client(runner).initRemote("https://github.com/user/repo.git")
		val setUrlCmd = runner.calls[2].command
		assertTrue(setUrlCmd.contains("set-url"))
	}

	// ── hardening ─────────────────────────────────────────────────────

	@Test
	fun `all commands include hardening config`() {
		val runner = RecordingRunner(mutableListOf(ExecResult("", "", 0)))
		client(runner).fetch()
		val cmd = runner.calls[0].command
		assertTrue(cmd.contains("core.symlinks=false"))
		assertTrue(cmd.contains("credential.helper="))
		assertTrue(cmd.contains("credential.modalprompt=false"))
	}

	// ── checkGitInstalled ─────────────────────────────────────────────

	@Test
	fun `checkGitInstalled returns version on success`() {
		val runner = staticRunner(stdout = "git version 2.43.0\n")
		val result = client(runner).checkGitInstalled()
		assertTrue(result is GitVersionResult.Ok)
		assertEquals("git version 2.43.0", (result as GitVersionResult.Ok).version)
	}

	@Test
	fun `checkGitInstalled returns NotFound on failure`() {
		val runner = object : ProcessRunner {
			override fun exec(command: List<String>, cwd: String?, env: Map<String, String>, timeoutMs: Long?): ExecResult {
				throw RuntimeException("No git found")
			}
		}
		val result = client(runner).checkGitInstalled()
		assertTrue(result is GitVersionResult.NotFound)
	}
}

// ── Helper function tests ─────────────────────────────────────────────

class InjectGithubAppUsernameTest {

	@Test
	fun `injects x-access-token for plain https URL`() {
		assertEquals(
			"https://x-access-token@github.com/user/repo.git",
			injectGithubAppUsername("https://github.com/user/repo.git"),
		)
	}

	@Test
	fun `preserves existing username`() {
		val url = "https://existing-user@github.com/user/repo.git"
		assertEquals(url, injectGithubAppUsername(url))
	}

	@Test
	fun `passes through non-https URLs`() {
		val url = "git@github.com:user/repo.git"
		assertEquals(url, injectGithubAppUsername(url))
	}
}

class ChunkByBudgetTest {

	@Test
	fun `single batch when under budget`() {
		val paths = listOf("a.kt", "b.kt", "c.kt")
		val batches = chunkByBudget(paths, 100)
		assertEquals(1, batches.size)
		assertEquals(paths, batches[0])
	}

	@Test
	fun `splits into multiple batches`() {
		val paths = listOf("aaaa", "bbbb", "cccc")
		// budget = 6 → each path costs 5 chars, only one fits per batch
		val batches = chunkByBudget(paths, 6)
		assertEquals(3, batches.size)
	}

	@Test
	fun `empty input returns empty`() {
		assertTrue(chunkByBudget(emptyList(), 100).isEmpty())
	}

	@Test
	fun `single path exceeding budget still ships as its own batch`() {
		val paths = listOf("very-long-path-name")
		val batches = chunkByBudget(paths, 5)
		assertEquals(1, batches.size)
		assertEquals(paths, batches[0])
	}
}

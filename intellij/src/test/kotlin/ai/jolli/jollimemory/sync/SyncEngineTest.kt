package ai.jolli.jollimemory.sync

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.IOException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpHeaders
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.HttpResponse.BodyHandler
import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64
import java.util.Optional
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLSession

/**
 * End-to-end tests for [SyncEngine.runRound].
 *
 * Uses a fake [HttpClient] for backend calls and a scripted [ProcessRunner]
 * for git commands to verify the full pipeline without network or git.
 */
class SyncEngineTest {

	@TempDir
	lateinit var tempDir: Path

	// ── Helpers ─────────────────────────────────────────────────────

	private val testApiKey = buildApiKey(
		"""{"t":"test-tenant","u":"https://test-tenant.jolli.ai"}""",
	)

	private fun buildApiKey(meta: String): String {
		val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(meta.toByteArray())
		val secret = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32))
		return "sk-jol-$encoded.$secret"
	}

	private val defaultCreds = GitCredentials(
		token = "ghs_test",
		gitUrl = "https://github.com/test/vault.git",
		expiresAt = System.currentTimeMillis() + 3_600_000L,
		repoFullName = "test/vault",
		defaultBranch = "main",
		githubRepoCreated = false,
		alreadyVaultBound = true,
		lockOwnerToken = "lock-123",
	)

	private val defaultContext = RoundContext(
		memoryBankRoot = "", // overridden per test
		repoFolderName = "test-repo",
		repoIdentity = "https://github.com/test/vault",
		author = CommitAuthor(name = "Test", email = "test@test.com"),
	)

	private val defaultRound = SyncRoundOptions(
		cwd = "/tmp/project",
		reason = "manual",
		transcripts = true,
	)

	// Mint response JSON matching what SyncBackendClient expects.
	private val mintResponseJson = """
		{
			"token": "ghs_test",
			"expiresAt": ${System.currentTimeMillis() + 3_600_000L},
			"repoCloneUrl": "https://github.com/test/vault.git",
			"repoFullName": "test/vault",
			"defaultBranch": "main",
			"githubRepoCreated": false,
			"alreadyVaultBound": true,
			"lockOwnerToken": "lock-123"
		}
	""".trimIndent()

	/**
	 * A [ProcessRunner] that returns scripted responses in order.
	 * Falls back to an empty success result when the script is exhausted.
	 */
	private class ScriptedRunner(private val responses: ArrayDeque<ExecResult> = ArrayDeque()) : ProcessRunner {
		val calls = mutableListOf<List<String>>()
		override fun exec(command: List<String>, cwd: String?, env: Map<String, String>, timeoutMs: Long?): ExecResult {
			calls.add(command)
			return if (responses.isNotEmpty()) responses.removeFirst() else ExecResult("", "", 0)
		}
	}

	/**
	 * A [ProcessRunner] that decides responses based on git command patterns.
	 * More flexible than [ScriptedRunner] for complex pipelines.
	 */
	private class SmartRunner(
		private val gitVersion: String = "git version 2.43.0",
		private val fetchOk: Boolean = true,
		private val pullOk: Boolean = true,
		private val pushOk: Boolean = true,
		private val pushTransmitted: Boolean = true,
		private val statusOutput: String = "",
		private val currentBranch: String = "main",
		private val headSha: String = "abc1234",
		private val remoteHeadSha: String = "abc1234",
		private val refExistsResult: Boolean = true,
		private val isRebaseInProgress: Boolean = false,
		private val originUrl: String = "https://github.com/test/vault.git",
	) : ProcessRunner {
		val calls = mutableListOf<List<String>>()

		override fun exec(command: List<String>, cwd: String?, env: Map<String, String>, timeoutMs: Long?): ExecResult {
			calls.add(command)
			val joined = command.joinToString(" ")

			// git --version
			if (joined.contains("--version")) {
				return ExecResult(gitVersion, "", 0)
			}

			// git remote get-url origin — the vault identity guard reads this to
			// verify the configured origin matches the minted credentials. Without
			// a stub the round fails verifyVaultMarker and degrades to OFFLINE.
			if (joined.contains("remote") && joined.contains("get-url")) {
				return ExecResult(originUrl, "", 0)
			}

			// git status --porcelain -z
			if (joined.contains("status") && joined.contains("--porcelain")) {
				return ExecResult(statusOutput, "", 0)
			}

			// git symbolic-ref --short HEAD
			if (joined.contains("symbolic-ref")) {
				return ExecResult(currentBranch, "", 0)
			}

			// git rev-parse
			if (joined.contains("rev-parse")) {
				val sha = if (joined.contains("remotes/origin")) remoteHeadSha else headSha
				return ExecResult(sha, "", 0)
			}

			// git show-ref --verify
			if (joined.contains("show-ref")) {
				return if (refExistsResult) ExecResult("abc1234 refs/remotes/origin/main", "", 0)
				else ExecResult("", "", 1)
			}

			// git fetch
			if (joined.contains("fetch")) {
				return if (fetchOk) ExecResult("", "", 0)
				else ExecResult("", "fatal: authentication failed", 128)
			}

			// git pull --rebase
			if (joined.contains("pull") && joined.contains("--rebase")) {
				return if (pullOk) ExecResult("Already up to date.", "", 0)
				else ExecResult("", "CONFLICT (content)", 1)
			}

			// git push
			if (joined.contains("push")) {
				return if (pushOk) {
					if (pushTransmitted) ExecResult("", "To https://github.com/test/vault.git\n   abc..def  HEAD -> main", 0)
					else ExecResult("Everything up-to-date", "", 0)
				} else {
					ExecResult("", "! [rejected] HEAD -> main (non-fast-forward)", 1)
				}
			}

			// git commit
			if (joined.contains("commit")) {
				return ExecResult("[main abc1234] commit message", "", 0)
			}

			// Rebase in progress check (ls .git/rebase-merge)
			if (joined.contains("rebase-merge") || joined.contains("rebase-apply")) {
				return if (isRebaseInProgress) ExecResult("", "", 0) else ExecResult("", "", 1)
			}

			// Default: success
			return ExecResult("", "", 0)
		}
	}

	/**
	 * Builds a [SyncBackendClient] with a fake HTTP layer that responds
	 * differently based on path and call count.
	 */
	private class FakeBackend(
		apiKey: String,
		private val mintHandler: (Int) -> HttpResponse<String>,
	) {
		var notifyPushCalled = false
		var releaseLockCalled = false
		var releaseLockToken: String? = null

		val client = SyncBackendClient(
			httpClient = object : HttpClient() {
				val mintCount = AtomicInteger(0)

				override fun cookieHandler() = Optional.empty<java.net.CookieHandler>()
				override fun connectTimeout() = Optional.empty<java.time.Duration>()
				override fun followRedirects() = Redirect.NEVER
				override fun proxy() = Optional.empty<java.net.ProxySelector>()
				override fun sslContext(): javax.net.ssl.SSLContext = javax.net.ssl.SSLContext.getDefault()
				override fun sslParameters(): javax.net.ssl.SSLParameters = javax.net.ssl.SSLParameters()
				override fun authenticator() = Optional.empty<java.net.Authenticator>()
				override fun version() = Version.HTTP_2
				override fun executor() = Optional.empty<java.util.concurrent.Executor>()
				override fun newWebSocketBuilder(): java.net.http.WebSocket.Builder = throw UnsupportedOperationException()

				@Suppress("UNCHECKED_CAST")
				override fun <T : Any?> send(request: HttpRequest, handler: BodyHandler<T>): HttpResponse<T> {
					val path = request.uri().path
					if (path.endsWith("/credentials")) {
						val resp = mintHandler(mintCount.incrementAndGet())
						return resp as HttpResponse<T>
					}
					if (path.endsWith("/notify-push")) {
						notifyPushCalled = true
						return fakeResp(200, """{"ok":true}""", request.uri()) as HttpResponse<T>
					}
					if (path.endsWith("/release-lock")) {
						releaseLockCalled = true
						return fakeResp(200, """{"ok":true}""", request.uri()) as HttpResponse<T>
					}
					return fakeResp(200, """{}""", request.uri()) as HttpResponse<T>
				}

				override fun <T : Any?> sendAsync(r: HttpRequest, h: BodyHandler<T>) = throw UnsupportedOperationException()
				override fun <T : Any?> sendAsync(r: HttpRequest, h: BodyHandler<T>, p: HttpResponse.PushPromiseHandler<T>?) = throw UnsupportedOperationException()
			},
			baseUrlOverride = "https://test-tenant.jolli.ai",
			jolliApiKeyProvider = { apiKey },
		)
	}

	companion object {
		fun fakeResp(status: Int, body: String, uri: URI): HttpResponse<String> {
			return object : HttpResponse<String> {
				override fun statusCode() = status
				override fun body() = body
				override fun headers(): HttpHeaders = HttpHeaders.of(emptyMap()) { _, _ -> true }
				override fun request(): HttpRequest = HttpRequest.newBuilder(uri).build()
				override fun previousResponse() = Optional.empty<HttpResponse<String>>()
				override fun sslSession() = Optional.empty<SSLSession>()
				override fun uri() = uri
				override fun version() = HttpClient.Version.HTTP_2
			}
		}
	}

	private fun mintOkResponse(uri: URI = URI.create("https://test-tenant.jolli.ai/api/mb-sync/credentials")): HttpResponse<String> {
		return fakeResp(200, mintResponseJson, uri)
	}

	/** Sets up a vault directory with .git/ and a vault marker so the steady-state path runs. */
	private fun setupVault(): Path {
		val vault = tempDir.resolve("vault")
		Files.createDirectories(vault.resolve(".git"))
		// Write a vault marker.
		val markerPath = vault.resolve(".git/jolli-vault-identity.json")
		Files.writeString(markerPath, """
			{
				"kind": "jolli-memory-bank",
				"version": 1,
				"createdAt": "2024-01-01T00:00:00Z",
				"gitUrl": "https://github.com/test/vault",
				"repoFullName": "test/vault",
				"defaultBranch": "main"
			}
		""".trimIndent())
		return vault
	}

	private fun buildEngine(
		backend: FakeBackend,
		runner: ProcessRunner,
		vaultRoot: String,
	): SyncEngine {
		return SyncEngine(SyncEngineOpts(
			backend = backend.client,
			resolveContext = { round ->
				defaultContext.copy(memoryBankRoot = vaultRoot)
			},
			makeGitClient = GitClientFactory { creds, mbRoot ->
				SyncGitClient(
					vaultRoot = mbRoot,
					credentials = creds,
					askpassProvider = { _ ->
						AskpassHandle(scriptPath = "/fake/askpass", env = mapOf("GIT_ASKPASS" to "/fake/askpass"))
					},
					processRunner = runner,
				)
			},
			lockTimeoutMs = 5_000L,
			refreshIntervalMs = 60_000L,
			sleepFn = { /* no-op for tests */ },
			vaultLockedRetrySchedule = listOf(10L, 10L, 10L), // fast retries
		))
	}

	// ── Tests ───────────────────────────────────────────────────────

	@Test
	fun `clean round with idle short-circuit returns SYNCED pushed=false`() {
		val vault = setupVault()
		val runner = SmartRunner(
			headSha = "abc1234",
			remoteHeadSha = "abc1234",
			statusOutput = "", // no dirty paths
		)
		val backend = FakeBackend(testApiKey) { mintOkResponse() }
		val engine = buildEngine(backend, runner, vault.toString())

		val result = engine.runRound(defaultRound)

		assertEquals(SyncState.SYNCED, result.newState)
		assertFalse(result.pushed)
		assertTrue(result.fetched)
		assertNull(result.lastError)
	}

	@Test
	fun `clean round with local changes returns SYNCED pushed=true`() {
		val vault = setupVault()
		// Report dirty owned path, then clean status for the idle check.
		val runner = SmartRunner(
			headSha = "abc1234",
			remoteHeadSha = "def5678", // different = not idle
			statusOutput = "", // stage vault will see nothing, but idle check fails
		)
		val backend = FakeBackend(testApiKey) { mintOkResponse() }
		val engine = buildEngine(backend, runner, vault.toString())

		val result = engine.runRound(defaultRound)

		assertEquals(SyncState.SYNCED, result.newState)
		assertTrue(result.pushed)
		assertTrue(result.fetched)
	}

	@Test
	fun `mint 423 retry succeeds on second attempt`() {
		val vault = setupVault()
		val runner = SmartRunner()
		var lockedWaitCalled = false

		val backend = FakeBackend(testApiKey) { callNum ->
			if (callNum == 1) fakeResp(423, """{"error":"vault_locked"}""", URI.create("https://test-tenant.jolli.ai/api/mb-sync/credentials"))
			else mintOkResponse()
		}

		val engine = SyncEngine(SyncEngineOpts(
			backend = backend.client,
			resolveContext = { defaultContext.copy(memoryBankRoot = vault.toString()) },
			makeGitClient = GitClientFactory { creds, mbRoot ->
				SyncGitClient(mbRoot, creds, { AskpassHandle("/fake", mapOf()) }, runner)
			},
			lockTimeoutMs = 5_000L,
			sleepFn = {},
			vaultLockedRetrySchedule = listOf(10L, 10L, 10L),
			onLockedWait = { lockedWaitCalled = true },
		))

		val result = engine.runRound(defaultRound)

		assertEquals(SyncState.SYNCED, result.newState)
		assertTrue(lockedWaitCalled)
	}

	@Test
	fun `mint 423 exhausted returns OFFLINE VAULT_LOCKED`() {
		val vault = setupVault()
		val runner = SmartRunner()

		val backend = FakeBackend(testApiKey) { _ ->
			fakeResp(423, """{"error":"vault_locked"}""", URI.create("https://test-tenant.jolli.ai/api/mb-sync/credentials"))
		}
		val engine = buildEngine(backend, runner, vault.toString())

		val result = engine.runRound(defaultRound)

		assertEquals(SyncState.OFFLINE, result.newState)
		assertEquals(SyncErrorCode.VAULT_LOCKED, result.lastError?.code)
	}

	@Test
	fun `mint network error returns OFFLINE NETWORK`() {
		val vault = setupVault()
		val runner = SmartRunner()

		val backend = FakeBackend(testApiKey) { _ ->
			throw IOException("Connection refused")
		}

		// Need a backend that actually throws network errors.
		val backendClient = SyncBackendClient(
			httpClient = object : HttpClient() {
				override fun cookieHandler() = Optional.empty<java.net.CookieHandler>()
				override fun connectTimeout() = Optional.empty<java.time.Duration>()
				override fun followRedirects() = Redirect.NEVER
				override fun proxy() = Optional.empty<java.net.ProxySelector>()
				override fun sslContext(): javax.net.ssl.SSLContext = javax.net.ssl.SSLContext.getDefault()
				override fun sslParameters(): javax.net.ssl.SSLParameters = javax.net.ssl.SSLParameters()
				override fun authenticator() = Optional.empty<java.net.Authenticator>()
				override fun version() = Version.HTTP_2
				override fun executor() = Optional.empty<java.util.concurrent.Executor>()
				override fun newWebSocketBuilder(): java.net.http.WebSocket.Builder = throw UnsupportedOperationException()
				@Suppress("UNCHECKED_CAST")
				override fun <T : Any?> send(r: HttpRequest, h: BodyHandler<T>): HttpResponse<T> = throw IOException("Connection refused")
				override fun <T : Any?> sendAsync(r: HttpRequest, h: BodyHandler<T>) = throw UnsupportedOperationException()
				override fun <T : Any?> sendAsync(r: HttpRequest, h: BodyHandler<T>, p: HttpResponse.PushPromiseHandler<T>?) = throw UnsupportedOperationException()
			},
			baseUrlOverride = "https://test-tenant.jolli.ai",
			jolliApiKeyProvider = { testApiKey },
		)

		val engine = SyncEngine(SyncEngineOpts(
			backend = backendClient,
			resolveContext = { defaultContext.copy(memoryBankRoot = vault.toString()) },
			makeGitClient = GitClientFactory { creds, mbRoot ->
				SyncGitClient(mbRoot, creds, { AskpassHandle("/fake", mapOf()) }, runner)
			},
			lockTimeoutMs = 5_000L,
			sleepFn = {},
			vaultLockedRetrySchedule = listOf(10L),
		))

		val result = engine.runRound(defaultRound)

		assertEquals(SyncState.OFFLINE, result.newState)
		assertEquals(SyncErrorCode.NETWORK, result.lastError?.code)
	}

	@Test
	fun `mint unauthorized returns OFFLINE MINT_FAILED`() {
		val vault = setupVault()
		val runner = SmartRunner()

		val backend = FakeBackend(testApiKey) { _ ->
			fakeResp(401, """{"error":"unauthorized"}""", URI.create("https://test-tenant.jolli.ai/api/mb-sync/credentials"))
		}
		val engine = buildEngine(backend, runner, vault.toString())

		val result = engine.runRound(defaultRound)

		assertEquals(SyncState.OFFLINE, result.newState)
		assertEquals(SyncErrorCode.MINT_FAILED, result.lastError?.code)
	}

	@Test
	fun `git missing returns OFFLINE GIT_MISSING`() {
		val vault = setupVault()
		// SmartRunner with empty git version to trigger NotFound.
		val runner = SmartRunner(gitVersion = "")
		val backend = FakeBackend(testApiKey) { mintOkResponse() }

		// Need a runner where checkGitInstalled returns NotFound.
		// The SmartRunner always returns a version string which parses as Ok.
		// Use a scripted runner: first call is git --version with exit code 1.
		val scriptedRunner = object : ProcessRunner {
			override fun exec(command: List<String>, cwd: String?, env: Map<String, String>, timeoutMs: Long?): ExecResult {
				if (command.any { it == "--version" }) {
					throw RuntimeException("git not found")
				}
				return ExecResult("", "", 0)
			}
		}

		val engine = buildEngine(backend, scriptedRunner, vault.toString())
		val result = engine.runRound(defaultRound)

		assertEquals(SyncState.OFFLINE, result.newState)
		assertEquals(SyncErrorCode.GIT_MISSING, result.lastError?.code)
	}

	@Test
	fun `vault marker mismatch returns OFFLINE VAULT_MISMATCH`() {
		val vault = tempDir.resolve("vault-mismatch")
		Files.createDirectories(vault.resolve(".git"))
		// Write marker with different git URL.
		val markerPath = vault.resolve(".git/jolli-vault-identity.json")
		Files.writeString(markerPath, """
			{
				"kind": "jolli-memory-bank",
				"version": 1,
				"createdAt": "2024-01-01T00:00:00Z",
				"gitUrl": "https://github.com/other-org/other-repo",
				"repoFullName": "other-org/other-repo",
				"defaultBranch": "main"
			}
		""".trimIndent())

		// SmartRunner that returns a different origin URL.
		val runner = object : ProcessRunner {
			override fun exec(command: List<String>, cwd: String?, env: Map<String, String>, timeoutMs: Long?): ExecResult {
				val joined = command.joinToString(" ")
				if (joined.contains("--version")) return ExecResult("git version 2.43.0", "", 0)
				if (joined.contains("rebase-merge") || joined.contains("rebase-apply"))
					return ExecResult("", "", 1) // not in progress
				// git remote get-url origin
				if (joined.contains("remote") && joined.contains("get-url")) {
					return ExecResult("https://github.com/other-org/other-repo.git", "", 0)
				}
				return ExecResult("", "", 0)
			}
		}

		val backend = FakeBackend(testApiKey) { mintOkResponse() }
		val engine = buildEngine(backend, runner, vault.toString())

		val result = engine.runRound(defaultRound)

		assertEquals(SyncState.OFFLINE, result.newState)
		assertEquals(SyncErrorCode.VAULT_MISMATCH, result.lastError?.code)
	}

	@Test
	fun `lock release called in finally on mid-round error`() {
		val vault = setupVault()
		val backend = FakeBackend(testApiKey) { mintOkResponse() }

		// Runner that throws on fetch to cause a mid-round failure.
		val runner = object : ProcessRunner {
			override fun exec(command: List<String>, cwd: String?, env: Map<String, String>, timeoutMs: Long?): ExecResult {
				val joined = command.joinToString(" ")
				if (joined.contains("--version")) return ExecResult("git version 2.43.0", "", 0)
				if (joined.contains("rebase-merge") || joined.contains("rebase-apply"))
					return ExecResult("", "", 1)
				if (joined.contains("fetch")) return ExecResult("", "fatal: something went wrong", 128)
				return ExecResult("", "", 0)
			}
		}

		val engine = buildEngine(backend, runner, vault.toString())
		val result = engine.runRound(defaultRound)

		assertEquals(SyncState.OFFLINE, result.newState)
		// The backend's releaseLock should have been called in finally.
		assertTrue(backend.releaseLockCalled)
	}

	@Test
	fun `notify push clears releaseInFinally`() {
		val vault = setupVault()
		val runner = SmartRunner(
			headSha = "abc1234",
			remoteHeadSha = "def5678", // not idle
			pushTransmitted = true,
		)
		val backend = FakeBackend(testApiKey) { mintOkResponse() }
		val engine = buildEngine(backend, runner, vault.toString())

		val result = engine.runRound(defaultRound)

		assertEquals(SyncState.SYNCED, result.newState)
		assertTrue(backend.notifyPushCalled)
		// releaseLock should NOT be called because notifyPush succeeded.
		assertFalse(backend.releaseLockCalled)
	}

	@Test
	fun `SyncRoundResult data class holds correct values`() {
		val result = SyncRoundResult(
			fetched = true,
			pulled = true,
			pushed = false,
			conflicts = listOf("a.json"),
			newState = SyncState.CONFLICTS,
			lastError = null,
			canary = CanaryReport(symlinked = listOf("s"), unowned = listOf("u")),
		)
		assertTrue(result.fetched)
		assertTrue(result.pulled)
		assertFalse(result.pushed)
		assertEquals(1, result.conflicts.size)
		assertEquals(SyncState.CONFLICTS, result.newState)
		assertEquals(1, result.canary?.symlinked?.size)
		assertEquals(1, result.canary?.unowned?.size)
	}

	@Test
	fun `SyncErrorCode transient classification`() {
		assertTrue(SyncErrorCode.NETWORK.isTransient)
		assertFalse(SyncErrorCode.MINT_FAILED.isTransient)
		assertFalse(SyncErrorCode.VAULT_LOCKED.isTransient)
		assertFalse(SyncErrorCode.GIT_MISSING.isTransient)
	}
}

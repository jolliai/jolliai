package ai.jolli.jollimemory.sync

import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.IOException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpHeaders
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.HttpResponse.BodyHandler
import java.util.Base64
import java.util.Optional
import javax.net.ssl.SSLSession

/**
 * Unit tests for [SyncBackendClient]. Uses a fake [HttpClient] injected via
 * the constructor to avoid real network calls.
 */
class SyncBackendClientTest {

	// ── Test helpers ────────────────────────────────────────────────────

	private val testApiKey = buildApiKey(
		"""{"t":"test-tenant","u":"https://test-tenant.jolli.ai"}""",
	)

	private fun buildApiKey(meta: String): String {
		val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(meta.toByteArray())
		val secret = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32))
		return "sk-jol-$encoded.$secret"
	}

	/**
	 * Builds a [SyncBackendClient] whose HTTP layer returns [responseBody]
	 * at [statusCode] for every request. Captures the last [HttpRequest]
	 * sent so tests can assert on URL, headers, etc.
	 */
	private class FakeHttpSetup(
		private val statusCode: Int,
		private val responseBody: String,
		apiKey: String,
	) {
		var lastRequest: HttpRequest? = null

		val client = SyncBackendClient(
			httpClient = fakeHttpClient { req ->
				lastRequest = req
				fakeResponse(statusCode, responseBody, req.uri())
			},
			baseUrlOverride = "https://test-tenant.jolli.ai",
			jolliApiKeyProvider = { apiKey },
		)
	}

	private fun setup(statusCode: Int, responseBody: String) =
		FakeHttpSetup(statusCode, responseBody, testApiKey)

	// ── mintGitCredentials ──────────────────────────────────────────────

	@Nested
	inner class MintGitCredentials {
		private val validMintResponse = """
			{
				"token": "ghs_abc123",
				"expiresAt": 1700000000000,
				"repoCloneUrl": "https://github.com/jolli-vaults/test.git",
				"repoFullName": "jolli-vaults/test",
				"defaultBranch": "main",
				"githubRepoCreated": true,
				"alreadyVaultBound": false,
				"lockOwnerToken": "abc123def456abc123def456abc123de"
			}
		""".trimIndent()

		@Test
		fun `parses successful mint response`() {
			val s = setup(200, validMintResponse)
			val creds = s.client.mintGitCredentials()

			creds.gitUrl shouldBe "https://github.com/jolli-vaults/test.git"
			creds.token shouldBe "ghs_abc123"
			creds.expiresAt shouldBe 1700000000000L
			creds.repoFullName shouldBe "jolli-vaults/test"
			creds.defaultBranch shouldBe "main"
			creds.githubRepoCreated shouldBe true
			creds.alreadyVaultBound shouldBe false
			creds.lockOwnerToken shouldBe "abc123def456abc123def456abc123de"
		}

		@Test
		fun `parses ISO 8601 expiresAt string`() {
			val body = validMintResponse.replace("1700000000000", "\"2023-11-14T22:13:20Z\"")
			val s = setup(200, body)
			val creds = s.client.mintGitCredentials()
			creds.expiresAt shouldBe 1700000000000L
		}

		@Test
		fun `sends POST to correct endpoint`() {
			val s = setup(200, validMintResponse)
			s.client.mintGitCredentials()

			s.lastRequest shouldNotBe null
			s.lastRequest!!.uri().path shouldBe "/api/mb-sync/credentials"
			s.lastRequest!!.method() shouldBe "POST"
		}

		@Test
		fun `sends auth and client headers`() {
			val s = setup(200, validMintResponse)
			s.client.mintGitCredentials()

			val headers = s.lastRequest!!.headers()
			headers.firstValue("Authorization").get() shouldContain "Bearer sk-jol-"
			headers.firstValue("x-jolli-client").get() shouldContain "intellij-plugin/"
		}

		@Test
		fun `throws on missing required fields`() {
			val s = setup(200, """{"token": "ghs_abc"}""")
			val ex = assertThrows<SyncBackendError> { s.client.mintGitCredentials() }
			ex.status shouldBe 502
			ex.message!! shouldContain "incomplete mint response"
		}

		@Test
		fun `throws on non-https clone URL`() {
			val body = validMintResponse.replace("https://github.com", "http://github.com")
			val s = setup(200, body)
			val ex = assertThrows<SyncBackendError> { s.client.mintGitCredentials() }
			ex.status shouldBe 502
			ex.message!! shouldContain "non-https"
		}

		@Test
		fun `throws on unparseable clone URL`() {
			val body = validMintResponse.replace(
				"https://github.com/jolli-vaults/test.git",
				"not a url at all",
			)
			val s = setup(200, body)
			// URI.create may or may not throw on "not a url at all" — either
			// the parse fails (unparseable) or the scheme check fails (non-https).
			assertThrows<SyncBackendError> { s.client.mintGitCredentials() }
		}

		@Test
		fun `throws on invalid expiresAt`() {
			val body = validMintResponse.replace("1700000000000", "\"not-a-date\"")
			val s = setup(200, body)
			val ex = assertThrows<SyncBackendError> { s.client.mintGitCredentials() }
			ex.status shouldBe 502
			ex.message!! shouldContain "invalid expiresAt"
		}
	}

	// ── notifyPush ──────────────────────────────────────────────────────

	@Nested
	inner class NotifyPush {
		@Test
		fun `sends POST to correct endpoint`() {
			val s = setup(200, "{}")
			s.client.notifyPush("abc1234", "main", "lock-token-123")

			s.lastRequest!!.uri().path shouldBe "/api/mb-sync/notify-push"
			s.lastRequest!!.method() shouldBe "POST"
		}
	}

	// ── releaseLock ─────────────────────────────────────────────────────

	@Nested
	inner class ReleaseLock {
		@Test
		fun `sends POST to correct endpoint`() {
			val s = setup(200, "{}")
			s.client.releaseLock("lock-token-123")

			s.lastRequest!!.uri().path shouldBe "/api/mb-sync/release-lock"
			s.lastRequest!!.method() shouldBe "POST"
		}
	}

	// ── getLegacyContent ────────────────────────────────────────────────

	@Nested
	inner class GetLegacyContent {
		@Test
		fun `parses response with docs`() {
			val body = """
				{
					"spaceId": 1,
					"spaceSlug": "my-space",
					"alreadyMigrated": false,
					"docs": [{
						"id": 10,
						"jrn": "jrn:doc:10",
						"slug": "test-doc",
						"path": "/test",
						"docType": "summary",
						"parentId": null,
						"content": "# Hello",
						"contentType": "markdown",
						"sortOrder": 0,
						"createdAt": "2024-01-01T00:00:00Z",
						"updatedAt": "2024-01-02T00:00:00Z"
					}]
				}
			""".trimIndent()
			val s = setup(200, body)
			val result = s.client.getLegacyContent()

			result.spaceId shouldBe 1
			result.spaceSlug shouldBe "my-space"
			result.alreadyMigrated shouldBe false
			result.docs.size shouldBe 1
			result.docs[0].id shouldBe 10
			result.docs[0].content shouldBe "# Hello"
			result.docs[0].parentId shouldBe null
		}

		@Test
		fun `parses already-migrated response`() {
			val body = """{"spaceId":1,"spaceSlug":"s","alreadyMigrated":true,"docs":[]}"""
			val s = setup(200, body)
			val result = s.client.getLegacyContent()
			result.alreadyMigrated shouldBe true
			result.docs shouldBe emptyList()
		}

		@Test
		fun `sends GET to correct endpoint`() {
			val body = """{"spaceId":1,"spaceSlug":"s","alreadyMigrated":true,"docs":[]}"""
			val s = setup(200, body)
			s.client.getLegacyContent()
			s.lastRequest!!.method() shouldBe "GET"
			s.lastRequest!!.uri().path shouldBe "/api/mb-sync/legacy-content"
		}
	}

	// ── completeMigration ───────────────────────────────────────────────

	@Nested
	inner class CompleteMigration {
		@Test
		fun `parses response`() {
			val s = setup(200, """{"alreadyMigrated": false}""")
			val result = s.client.completeMigration("abc1234", "lock-token")
			result.alreadyMigrated shouldBe false
		}

		@Test
		fun `handles already-migrated`() {
			val s = setup(200, """{"alreadyMigrated": true}""")
			val result = s.client.completeMigration("abc1234", "lock-token")
			result.alreadyMigrated shouldBe true
		}
	}

	// ── Error dispatch ──────────────────────────────────────────────────

	@Nested
	inner class ErrorDispatch {
		@Test
		fun `401 throws SyncBackendUnauthorizedError`() {
			val s = setup(401, """{"error":"unauthorized"}""")
			assertThrows<SyncBackendUnauthorizedError> { s.client.mintGitCredentials() }
		}

		@Test
		fun `403 throws SyncBackendUnauthorizedError`() {
			val s = setup(403, """{"error":"forbidden"}""")
			assertThrows<SyncBackendUnauthorizedError> { s.client.mintGitCredentials() }
		}

		@Test
		fun `423 throws VaultLockedError`() {
			val s = setup(423, """{"error":"vault_locked"}""")
			assertThrows<VaultLockedError> { s.client.mintGitCredentials() }
		}

		@Test
		fun `503 pending_flush_failed throws WebFlushPendingError`() {
			val body = """{"error":"pending_flush_failed","retryAfterSeconds":45}"""
			val s = setup(503, body)
			val ex = assertThrows<WebFlushPendingError> { s.client.mintGitCredentials() }
			ex.retryAfterSeconds shouldBe 45
		}

		@Test
		fun `503 pending_flush_failed defaults retryAfterSeconds to 30`() {
			val body = """{"error":"pending_flush_failed"}"""
			val s = setup(503, body)
			val ex = assertThrows<WebFlushPendingError> { s.client.mintGitCredentials() }
			ex.retryAfterSeconds shouldBe 30
		}

		@Test
		fun `503 non-pending_flush throws generic SyncBackendError`() {
			val s = setup(503, """{"error":"service_unavailable"}""")
			val ex = assertThrows<SyncBackendError> { s.client.mintGitCredentials() }
			ex.status shouldBe 503
			(ex is WebFlushPendingError) shouldBe false
		}

		@Test
		fun `other non-2xx throws generic SyncBackendError`() {
			val s = setup(500, """{"error":"internal"}""")
			val ex = assertThrows<SyncBackendError> { s.client.mintGitCredentials() }
			ex.status shouldBe 500
		}

		@Test
		fun `no API key throws SyncBackendUnauthorizedError`() {
			val client = SyncBackendClient(
				jolliApiKeyProvider = { null },
				baseUrlOverride = "https://test.jolli.ai",
			)
			assertThrows<SyncBackendUnauthorizedError> { client.mintGitCredentials() }
		}

		@Test
		fun `invalid API key throws SyncBackendUnauthorizedError`() {
			val client = SyncBackendClient(
				jolliApiKeyProvider = { "not-a-valid-key" },
				baseUrlOverride = "https://test.jolli.ai",
			)
			assertThrows<SyncBackendUnauthorizedError> { client.mintGitCredentials() }
		}

		@Test
		fun `network failure throws SyncBackendNetworkError`() {
			val client = SyncBackendClient(
				httpClient = fakeHttpClient { throw IOException("Connection refused") },
				jolliApiKeyProvider = { testApiKey },
				baseUrlOverride = "https://test.jolli.ai",
			)
			assertThrows<SyncBackendNetworkError> { client.mintGitCredentials() }
		}
	}

	// ── getJolliApiKey ──────────────────────────────────────────────────

	@Nested
	inner class GetJolliApiKey {
		@Test
		fun `returns key from provider`() {
			val client = SyncBackendClient(jolliApiKeyProvider = { "sk-jol-test" })
			client.getJolliApiKey() shouldBe "sk-jol-test"
		}

		@Test
		fun `returns null when signed out`() {
			val client = SyncBackendClient(jolliApiKeyProvider = { null })
			client.getJolliApiKey() shouldBe null
		}
	}
}

// ── Fake HttpClient infrastructure ──────────────────────────────────────

/**
 * Creates a minimal [HttpClient] that delegates every `send()` call to
 * [handler]. Good enough for unit-testing request/response contracts without
 * a real server or a mocking library dependency.
 */
private fun fakeHttpClient(handler: (HttpRequest) -> HttpResponse<String>): HttpClient {
	return object : HttpClient() {
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
		override fun <T : Any?> send(request: HttpRequest, responseBodyHandler: BodyHandler<T>): HttpResponse<T> {
			return handler(request) as HttpResponse<T>
		}

		override fun <T : Any?> sendAsync(
			request: HttpRequest,
			responseBodyHandler: BodyHandler<T>,
		) = throw UnsupportedOperationException()

		override fun <T : Any?> sendAsync(
			request: HttpRequest,
			responseBodyHandler: BodyHandler<T>,
			pushPromiseHandler: HttpResponse.PushPromiseHandler<T>?,
		) = throw UnsupportedOperationException()
	}
}

/** Creates a minimal [HttpResponse] with the given status and body. */
private fun fakeResponse(statusCode: Int, body: String, uri: URI): HttpResponse<String> {
	return object : HttpResponse<String> {
		override fun statusCode() = statusCode
		override fun body() = body
		override fun headers(): HttpHeaders = HttpHeaders.of(emptyMap()) { _, _ -> true }
		override fun request(): HttpRequest = HttpRequest.newBuilder(uri).build()
		override fun previousResponse() = Optional.empty<HttpResponse<String>>()
		override fun sslSession() = Optional.empty<SSLSession>()
		override fun uri() = uri
		override fun version() = HttpClient.Version.HTTP_2
	}
}

package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.auth.JolliAuthUtils
import ai.jolli.jollimemory.core.JolliMemoryConfig
import ai.jolli.jollimemory.core.SessionTracker
import com.sun.net.httpserver.HttpServer
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.mockk.every
import io.mockk.mockkObject
import io.mockk.slot
import io.mockk.unmockkObject
import io.mockk.verify
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class JolliAuthServiceTest {

    // --- parseQuery tests ---

    @Test
    fun `parseQuery parses standard query string`() {
        val result = JolliAuthService.parseQuery("token=abc&space=my-org&jolli_api_key=sk-123")
        result["token"] shouldBe "abc"
        result["space"] shouldBe "my-org"
        result["jolli_api_key"] shouldBe "sk-123"
    }

    @Test
    fun `parseQuery returns empty map for blank input`() {
        JolliAuthService.parseQuery("") shouldBe emptyMap()
        JolliAuthService.parseQuery("   ") shouldBe emptyMap()
    }

    @Test
    fun `parseQuery handles URL-encoded values`() {
        val result = JolliAuthService.parseQuery("callback=http%3A%2F%2Flocalhost%3A8080%2Fpath")
        result["callback"] shouldBe "http://localhost:8080/path"
    }

    @Test
    fun `parseQuery handles param with no value`() {
        val result = JolliAuthService.parseQuery("token=abc&empty")
        result["token"] shouldBe "abc"
        result["empty"] shouldBe ""
    }

    @Test
    fun `parseQuery last value wins for duplicate keys`() {
        val result = JolliAuthService.parseQuery("key=first&key=second")
        result["key"] shouldBe "second"
    }

    // --- buildLoginUrl tests ---

    @Test
    fun `buildLoginUrl pairs client with client_version and orders params consistently`() {
        // client=intellij + client_version is what the backend reads via
        // useCaptureCliCallback to populate signup_source /
        // signup_client_version. Mirrors the CLI / VS Code login URL shape —
        // keep these params in lockstep across all three surfaces.
        val url = JolliAuthService.buildLoginUrl(
            jolliUrl = "https://app.jolli.ai",
            callbackUrl = "http://localhost:54321/callback?state=abc",
            clientVersion = "1.4.2",
            generateApiKey = true,
        )
        url shouldContain "https://app.jolli.ai/login?cli_callback="
        url shouldContain "client=intellij"
        url shouldContain "client_version=1.4.2"
        url shouldContain "generate_api_key=true"
        // Callback must be percent-encoded so the `?state=` inside doesn't
        // collide with the outer query string's `&`.
        url shouldContain "http%3A%2F%2Flocalhost%3A54321%2Fcallback%3Fstate%3Dabc"
        // Param order should match CLI / VS Code:
        // cli_callback → client → client_version → generate_api_key. A pinned
        // ordering keeps the three surfaces' URLs visually comparable in
        // captures / logs and protects against silent drift when one surface
        // is refactored in isolation.
        val clientIdx = url.indexOf("client=intellij")
        val versionIdx = url.indexOf("client_version=")
        val generateIdx = url.indexOf("generate_api_key=")
        (clientIdx < versionIdx) shouldBe true
        (versionIdx < generateIdx) shouldBe true
    }

    @Test
    fun `buildLoginUrl omits generate_api_key when caller flags an existing key`() {
        // Preserves manually configured keys: if we always asked the server to
        // mint one, the new key would clobber the existing entry on sign-in.
        // Matches CLI's `if (!config.jolliApiKey) loginUrl += "&generate_api_key=true"`
        // and VS Code's `generateKeyParam = jolliApiKey ? "" : "&generate_api_key=true"`.
        val url = JolliAuthService.buildLoginUrl(
            jolliUrl = "https://app.jolli.ai",
            callbackUrl = "http://localhost:54321/callback",
            clientVersion = "1.4.2",
            generateApiKey = false,
        )
        url shouldContain "client=intellij"
        url shouldContain "client_version=1.4.2"
        (url.contains("generate_api_key")) shouldBe false
    }

    @Test
    fun `buildLoginUrl URL-encodes unusual version strings defensively`() {
        // The fallback "0.0.0" and normal semver are URL-safe, but a stray
        // pre-release tag with "+" or whitespace would otherwise be lost.
        // Encoding keeps the param value round-trippable on the server.
        val url = JolliAuthService.buildLoginUrl(
            jolliUrl = "https://app.jolli.ai",
            callbackUrl = "http://localhost:54321/callback",
            clientVersion = "1.4.2+build 7",
            generateApiKey = true,
        )
        url shouldContain "client_version=1.4.2%2Bbuild+7"
    }

    // --- getErrorMessage tests ---

    @Test
    fun `getErrorMessage returns message for known codes`() {
        JolliAuthService.getErrorMessage("access_denied") shouldContain "denied"
        JolliAuthService.getErrorMessage("invalid_request") shouldContain "Invalid"
        JolliAuthService.getErrorMessage("server_error") shouldContain "Server error"
        JolliAuthService.getErrorMessage("temporarily_unavailable") shouldContain "unavailable"
    }

    @Test
    fun `getErrorMessage includes code for unknown errors`() {
        val result = JolliAuthService.getErrorMessage("something_weird")
        result shouldContain "something_weird"
    }

    // --- signOut tests ---

    @AfterEach
    fun tearDown() {
        try { unmockkObject(SessionTracker) } catch (_: Exception) {}
        try { unmockkObject(JolliAuthUtils) } catch (_: Exception) {}
    }

    @Test
    fun `signOut clears both authToken and jolliApiKey`() {
        // The API key carries the tenant URL that sync/LLM routing extract via
        // parseJolliApiKey. Leaving it behind pins a later sign-in (into a
        // different tenant) to the old host. Clear both in one write — mirrors
        // VS Code's clearAuthCredentials.
        mockkObject(SessionTracker)
        every { SessionTracker.getGlobalConfigDir() } returns "/fake/global"
        every { SessionTracker.loadConfigFromDir("/fake/global") } returns JolliMemoryConfig(
            authToken = "old-token",
            jolliApiKey = "sk-jol-stale-tenant",
        )
        val savedConfig = slot<JolliMemoryConfig>()
        every { SessionTracker.saveConfigToDir(capture(savedConfig), "/fake/global") } returns Unit

        JolliAuthService.signOut()

        savedConfig.captured.authToken shouldBe null
        savedConfig.captured.jolliApiKey shouldBe null
    }

    @Test
    fun `signOut preserves unrelated config fields`() {
        // Only the auth credentials are cleared — model, provider, etc. survive.
        mockkObject(SessionTracker)
        every { SessionTracker.getGlobalConfigDir() } returns "/fake/global"
        every { SessionTracker.loadConfigFromDir("/fake/global") } returns JolliMemoryConfig(
            authToken = "old-token",
            jolliApiKey = "sk-jol-stale",
            aiProvider = "jolli",
            storageMode = "dual-write",
        )
        val savedConfig = slot<JolliMemoryConfig>()
        every { SessionTracker.saveConfigToDir(capture(savedConfig), "/fake/global") } returns Unit

        JolliAuthService.signOut()

        savedConfig.captured.aiProvider shouldBe "jolli"
        savedConfig.captured.storageMode shouldBe "dual-write"
    }

    @Test
    fun `signOut notifies auth listeners`() {
        mockkObject(SessionTracker)
        every { SessionTracker.getGlobalConfigDir() } returns "/fake/global"
        every { SessionTracker.loadConfigFromDir("/fake/global") } returns JolliMemoryConfig()
        every { SessionTracker.saveConfigToDir(any(), any()) } returns Unit

        var notified = false
        val disposable = JolliAuthService.addAuthListener { notified = true }

        JolliAuthService.signOut()

        notified shouldBe true
        disposable.dispose()
    }

    // --- getErrorMessage tests for new error codes ---

    @Test
    fun `getErrorMessage returns messages for JOLLI-1270 error codes`() {
        JolliAuthService.getErrorMessage("oauth_failed") shouldContain "OAuth"
        JolliAuthService.getErrorMessage("session_missing") shouldContain "Session"
        JolliAuthService.getErrorMessage("no_verified_emails") shouldContain "verified email"
        JolliAuthService.getErrorMessage("user_denied") shouldContain "cancelled"
        JolliAuthService.getErrorMessage("invalid_callback") shouldContain "rejected"
        JolliAuthService.getErrorMessage("failed_to_get_token") shouldContain "credentials"
        JolliAuthService.getErrorMessage("auth_fetch_failed") shouldContain "fetch"
        JolliAuthService.getErrorMessage("invalid_provider") shouldContain "provider"
    }

    // --- exchangeCode tests ---

    /** Bypasses origin allowlist so tests can use http://127.0.0.1. */
    private fun allowLocalOrigins() {
        mockkObject(JolliAuthUtils)
        every { JolliAuthUtils.assertJolliOriginAllowed(any()) } returns Unit
    }

    /** Starts a local HTTP server that responds with the given status and body. */
    private fun startFakeExchangeServer(statusCode: Int, body: String): HttpServer {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/auth/cli-exchange") { exchange ->
            val bytes = body.toByteArray(Charsets.UTF_8)
            exchange.sendResponseHeaders(statusCode, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        return server
    }

    @Test
    fun `exchangeCode returns token and optional fields on success`() {
        allowLocalOrigins()
        val server = startFakeExchangeServer(200, """{"token":"jwt-abc","jolliApiKey":"sk-jol-123","space":"my-space"}""")
        try {
            val result = JolliAuthService.exchangeCode("http://127.0.0.1:${server.address.port}", "test-code")
            result.token shouldBe "jwt-abc"
            result.jolliApiKey shouldBe "sk-jol-123"
            result.space shouldBe "my-space"
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `exchangeCode returns token when optional fields are absent`() {
        allowLocalOrigins()
        val server = startFakeExchangeServer(200, """{"token":"jwt-only"}""")
        try {
            val result = JolliAuthService.exchangeCode("http://127.0.0.1:${server.address.port}", "test-code")
            result.token shouldBe "jwt-only"
            result.jolliApiKey shouldBe null
            result.space shouldBe null
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `exchangeCode throws on 404 (expired code)`() {
        allowLocalOrigins()
        val server = startFakeExchangeServer(404, """{"error":"not_found"}""")
        try {
            val ex = assertThrows<RuntimeException> {
                JolliAuthService.exchangeCode("http://127.0.0.1:${server.address.port}", "expired-code")
            }
            ex.message shouldContain "expired or already used"
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `exchangeCode throws on non-OK status`() {
        allowLocalOrigins()
        val server = startFakeExchangeServer(500, """{"error":"internal"}""")
        try {
            val ex = assertThrows<RuntimeException> {
                JolliAuthService.exchangeCode("http://127.0.0.1:${server.address.port}", "some-code")
            }
            ex.message shouldContain "HTTP 500"
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `exchangeCode throws on missing token in response`() {
        allowLocalOrigins()
        val server = startFakeExchangeServer(200, """{"jolliApiKey":"sk-jol-123"}""")
        try {
            val ex = assertThrows<RuntimeException> {
                JolliAuthService.exchangeCode("http://127.0.0.1:${server.address.port}", "some-code")
            }
            ex.message shouldContain "did not include a token"
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `exchangeCode throws on malformed JSON response`() {
        allowLocalOrigins()
        val server = startFakeExchangeServer(200, "not json at all")
        try {
            val ex = assertThrows<RuntimeException> {
                JolliAuthService.exchangeCode("http://127.0.0.1:${server.address.port}", "some-code")
            }
            ex.message shouldContain "malformed response"
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `exchangeCode throws on network error`() {
        allowLocalOrigins()
        // Connect to a port with nothing listening
        val ex = assertThrows<RuntimeException> {
            JolliAuthService.exchangeCode("http://127.0.0.1:1", "some-code")
        }
        ex.message shouldContain "Couldn't reach Jolli"
    }

    @Test
    fun `exchangeCode sends tenant slug header for path-based URLs`() {
        allowLocalOrigins()
        var receivedSlug: String? = null
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/auth/cli-exchange") { exchange ->
            receivedSlug = exchange.requestHeaders.getFirst("x-tenant-slug")
            val body = """{"token":"jwt-abc"}""".toByteArray(Charsets.UTF_8)
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
        try {
            JolliAuthService.exchangeCode("http://127.0.0.1:${server.address.port}/dev", "test-code")
            receivedSlug shouldBe "dev"
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `exchangeCode does not send tenant slug for root URLs`() {
        allowLocalOrigins()
        var receivedSlug: String? = "should-be-null"
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/auth/cli-exchange") { exchange ->
            receivedSlug = exchange.requestHeaders.getFirst("x-tenant-slug")
            val body = """{"token":"jwt-abc"}""".toByteArray(Charsets.UTF_8)
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
        try {
            JolliAuthService.exchangeCode("http://127.0.0.1:${server.address.port}", "test-code")
            receivedSlug shouldBe null
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `exchangeCode rejects non-allowlisted origin`() {
        val ex = assertThrows<IllegalArgumentException> {
            JolliAuthService.exchangeCode("https://evil.com", "some-code")
        }
        ex.message shouldContain "Rejected Jolli origin"
    }

    // --- login timeout test ---

    @Test
    fun `times out and fires onError when no callback arrives`() {
        val latch = CountDownLatch(1)
        val errorMessages = mutableListOf<String>()
        val successCount = AtomicInteger(0)

        JolliAuthService.login(
            timeoutSeconds = 0L,
            onSuccess = { successCount.incrementAndGet() },
            onError = { msg ->
                synchronized(errorMessages) { errorMessages += msg }
                latch.countDown()
            },
        )

        latch.await(5, TimeUnit.SECONDS) shouldBe true
        successCount.get() shouldBe 0
        synchronized(errorMessages) {
            errorMessages.size shouldBe 1
            errorMessages.single() shouldContain "timed out"
        }
    }
}

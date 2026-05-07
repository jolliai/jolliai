package ai.jolli.jollimemory.services

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
    }

    @Test
    fun `signOut clears authToken but preserves jolliApiKey`() {
        mockkObject(SessionTracker)
        every { SessionTracker.getGlobalConfigDir() } returns "/fake/global"
        every { SessionTracker.loadConfigFromDir("/fake/global") } returns JolliMemoryConfig(
            authToken = "old-token",
            jolliApiKey = "sk-jol-keep-me",
        )
        val savedConfig = slot<JolliMemoryConfig>()
        every { SessionTracker.saveConfigToDir(capture(savedConfig), "/fake/global") } returns Unit

        JolliAuthService.signOut()

        savedConfig.captured.authToken shouldBe null
        savedConfig.captured.jolliApiKey shouldBe "sk-jol-keep-me"
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
        // Connect to a port with nothing listening
        val ex = assertThrows<RuntimeException> {
            JolliAuthService.exchangeCode("http://127.0.0.1:1", "some-code")
        }
        ex.message shouldContain "Couldn't reach Jolli"
    }

    @Test
    fun `exchangeCode sends tenant slug header for path-based URLs`() {
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

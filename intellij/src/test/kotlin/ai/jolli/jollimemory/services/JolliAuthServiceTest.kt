package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.core.JolliMemoryConfig
import ai.jolli.jollimemory.core.SessionTracker
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.mockk.every
import io.mockk.mockkObject
import io.mockk.slot
import io.mockk.unmockkObject
import io.mockk.verify
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
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

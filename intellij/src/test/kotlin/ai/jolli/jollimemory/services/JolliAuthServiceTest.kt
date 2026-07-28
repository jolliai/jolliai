package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.bridge.CliIntegrations
import ai.jolli.jollimemory.core.JolliMemoryConfig
import ai.jolli.jollimemory.core.SessionTracker
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldMatch
import io.mockk.every
import io.mockk.mockkObject
import io.mockk.slot
import io.mockk.unmockkObject
import io.mockk.verify
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.parallel.Execution
import org.junit.jupiter.api.parallel.ExecutionMode
import org.junit.jupiter.api.parallel.Isolated
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

// Temporary guard while this class still mutates JVM globals (mockkObject).
// Remove when migrated to HookEnv injection.
@Isolated
// MockK's recorder is JVM-global; @Nested classes are scheduled as independent
// parallel units, so intra-class concurrency corrupts stubbing too. SAME_THREAD
// is inherited by all nested classes and serializes this whole file.
@Execution(ExecutionMode.SAME_THREAD)
class JolliAuthServiceTest {

    @AfterEach
    fun tearDown() {
        unmockkObject(SessionTracker)
        unmockkObject(CliIntegrations)
        unmockkObject(ai.jolli.jollimemory.core.telemetry.Telemetry)
    }

    /**
     * Runs [block] and waits for the resulting auth-listener notification.
     * [JolliAuthService.signOut] and the loopback `/callback` handler both
     * dispatch off the caller's thread (ide-bridge round-trips run on pooled
     * threads / server-executor threads), so a test that asserted right after
     * the call would race the background thread.
     */
    private fun awaitAuthNotification(timeoutMs: Long = 5_000, block: () -> Unit) {
        val latch = CountDownLatch(1)
        val disposable = JolliAuthService.addAuthListener { latch.countDown() }
        try {
            block()
            latch.await(timeoutMs, TimeUnit.MILLISECONDS) shouldBe true
        } finally {
            disposable.dispose()
        }
    }

    // --- buildLoginUrlViaIdeBridge tests ---

    @Test
    fun `buildLoginUrlViaIdeBridge forwards every field and returns the CLI's URL verbatim`() {
        // URL construction itself lives in the CLI (cli/src/auth/AuthCallback.ts
        // jolliPageUrl, covered by IdeBridgeCommand.test.ts). All this adapter
        // owes is a faithful request and an unmodified response.
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns "/fake"
        val bridgeRequest = slot<String>()
        every { CliIntegrations.runIdeBridge(any(), "auth", capture(bridgeRequest)) } returns
            JsonObject().apply { addProperty("url", "https://app.jolli.ai/login?cli_callback=cb&state=abc123") }

        val url = JolliAuthService.buildLoginUrlViaIdeBridge(
            jolliUrl = "https://app.jolli.ai",
            callbackUrl = "http://localhost:12345/callback",
            state = "abc123",
            clientVersion = "1.4.2",
            generateApiKey = true,
            installId = "inst-1",
        )

        url shouldBe "https://app.jolli.ai/login?cli_callback=cb&state=abc123"
        val req = JsonParser.parseString(bridgeRequest.captured).asJsonObject
        req.get("operation").asString shouldBe "build-login-url"
        req.get("jolliUrl").asString shouldBe "https://app.jolli.ai"
        // The adapter forwards whatever callbackUrl it is handed, verbatim.
        // `login()` is the one that builds a `http://localhost:<port>/callback`
        // URL — see `login builds a loopback callback URL`.
        req.get("callbackUrl").asString shouldBe "http://localhost:12345/callback"
        req.get("state").asString shouldBe "abc123"
        req.get("clientVersion").asString shouldBe "1.4.2"
        req.get("generateApiKey").asBoolean shouldBe true
        req.get("installId").asString shouldBe "inst-1"
    }

    @Test
    fun `buildLoginUrlViaIdeBridge omits a blank installId`() {
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns "/fake"
        val bridgeRequest = slot<String>()
        every { CliIntegrations.runIdeBridge(any(), "auth", capture(bridgeRequest)) } returns
            JsonObject().apply { addProperty("url", "https://app.jolli.ai/login") }

        JolliAuthService.buildLoginUrlViaIdeBridge(
            jolliUrl = "https://app.jolli.ai",
            callbackUrl = "http://localhost:12345/callback",
            state = "s",
            clientVersion = "1.0.0",
            generateApiKey = false,
            installId = "",
        )

        JsonParser.parseString(bridgeRequest.captured).asJsonObject.has("installId") shouldBe false
    }

    @Test
    fun `buildLoginUrlViaIdeBridge throws when bridge returns no URL`() {
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns "/fake"
        every { CliIntegrations.runIdeBridge(any(), any(), any(), any()) } returns JsonObject()

        val ex = org.junit.jupiter.api.assertThrows<RuntimeException> {
            JolliAuthService.buildLoginUrlViaIdeBridge(
                jolliUrl = "https://app.jolli.ai",
                callbackUrl = "http://localhost:12345/callback",
                state = "s",
                clientVersion = "1.0.0",
                generateApiKey = false,
            )
        }
        ex.message shouldContain "no login URL"
    }

    // --- handleAuthCallbackViaIdeBridge tests ---

    @Test
    fun `handleAuthCallbackViaIdeBridge returns success result`() {
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns "/fake"
        every { CliIntegrations.runIdeBridge(any(), any(), any(), any()) } answers {
            val json = thirdArg<String>()
            val req = JsonParser.parseString(json).asJsonObject
            req.get("operation").asString shouldBe "handle-auth-callback"
            req.get("queryString").asString shouldBe "state=s1&code=c1"
            req.get("expectedState").asString shouldBe "s1"
            JsonObject().apply {
                addProperty("success", true)
                // redirectUrl is emitted by the CLI for VS Code / IntelliJ parity
                // but ignored on this side — there is no browser tab to redirect.
                addProperty("redirectUrl", "https://jolli.ai/cli-complete")
                addProperty("token", "tok")
                addProperty("space", "sp")
                addProperty("jolliApiKey", "sk-jol-x")
            }
        }

        val result = JolliAuthService.handleAuthCallbackViaIdeBridge("https://jolli.ai", "state=s1&code=c1", "s1")
        result.success shouldBe true
        result.token shouldBe "tok"
        result.space shouldBe "sp"
        result.jolliApiKey shouldBe "sk-jol-x"
    }

    @Test
    fun `handleAuthCallbackViaIdeBridge returns failure on state mismatch`() {
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns "/fake"
        every { CliIntegrations.runIdeBridge(any(), any(), any(), any()) } returns JsonObject().apply {
            addProperty("success", false)
            addProperty("errorCode", "invalid_callback")
            addProperty("errorMessage", "Invalid login state")
        }

        val result = JolliAuthService.handleAuthCallbackViaIdeBridge("https://jolli.ai", "state=wrong", "expected")
        result.success shouldBe false
        result.errorCode shouldBe "invalid_callback"
        result.errorMessage shouldBe "Invalid login state"
    }

    @Test
    fun `handleAuthCallbackViaIdeBridge reports concrete cause when the bridge is unreachable`() {
        // "Node.js not found" is actionable; "server error" is not.
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns "/fake"
        every { CliIntegrations.runIdeBridge(any(), any(), any(), any()) } throws
            CliIntegrations.CliBridgeException(null, "Node.js not found")

        val result = JolliAuthService.handleAuthCallbackViaIdeBridge("https://jolli.ai", "state=s1&code=c1", "s1")
        result.success shouldBe false
        result.errorCode shouldBe "server_error"
        result.errorMessage shouldContain "Node.js not found"
    }

    @Test
    fun `handleAuthCallbackViaIdeBridge reports concrete cause on an unexpected failure`() {
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns "/fake"
        every { CliIntegrations.runIdeBridge(any(), any(), any(), any()) } throws RuntimeException("socket closed")

        val result = JolliAuthService.handleAuthCallbackViaIdeBridge("https://jolli.ai", "state=s1&code=c1", "s1")
        result.success shouldBe false
        result.errorMessage shouldContain "socket closed"
    }

    @Test
    fun `handleAuthCallbackViaIdeBridge preserves the CLI's structured errorName on typed failures`() {
        // When the CLI raises a typed CliBridgeException (bad field, off-allowlist
        // tenant URL), the specific errorName must survive as errorCode — losing
        // it would collapse every case to the generic `server_error` bucket the
        // pre-bridge Kotlin path did not have. Only the untyped path (errorName
        // null) falls back to `server_error`.
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns "/fake"
        every { CliIntegrations.runIdeBridge(any(), any(), any(), any()) } throws
            CliIntegrations.CliBridgeException("invalid_request", "Off-allowlist tenant URL.")

        val result = JolliAuthService.handleAuthCallbackViaIdeBridge("https://jolli.ai", "state=s1&code=c1", "s1")
        result.success shouldBe false
        result.errorCode shouldBe "invalid_request"
        result.errorMessage shouldContain "Off-allowlist tenant URL."
    }

    @Test
    fun `handleAuthCallbackViaIdeBridge handles malformed response`() {
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns "/fake"
        every { CliIntegrations.runIdeBridge(any(), any(), any(), any()) } returns
            com.google.gson.JsonPrimitive("not-an-object")

        val result = JolliAuthService.handleAuthCallbackViaIdeBridge("https://jolli.ai", "state=s1", "s1")
        result.success shouldBe false
        result.errorCode shouldBe "server_error"
    }

    @Test
    fun `handleAuthCallbackViaIdeBridge treats JSON nulls as absent`() {
        // The CLI emits `space: null` / `jolliApiKey: null` rather than omitting
        // the keys; Gson would otherwise hand back the string "null".
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns "/fake"
        every { CliIntegrations.runIdeBridge(any(), any(), any(), any()) } returns JsonObject().apply {
            addProperty("success", true)
            addProperty("token", "tok")
            add("space", com.google.gson.JsonNull.INSTANCE)
            add("jolliApiKey", com.google.gson.JsonNull.INSTANCE)
        }

        val result = JolliAuthService.handleAuthCallbackViaIdeBridge("https://jolli.ai", "state=s1&code=c1", "s1")
        result.success shouldBe true
        result.space shouldBe null
        result.jolliApiKey shouldBe null
    }

    @Test
    fun `handleAuthCallbackViaIdeBridge names the IDE's own recovery path`() {
        // The shared CLI table can't hard-code the user_denied retry sentence —
        // the CLI names a command, VS Code its side panel, IntelliJ Settings.
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns "/fake"
        val bridgeRequest = slot<String>()
        // The 4-arg overload — this call sends OAUTH_CALLBACK_BRIDGE_TIMEOUT_SECONDS.
        // Matching only the 3-arg shape would silently miss and leave `bridgeRequest`
        // uncaptured.
        every {
            CliIntegrations.runIdeBridge(any(), "auth", capture(bridgeRequest), any())
        } returns JsonObject()

        JolliAuthService.handleAuthCallbackViaIdeBridge("https://jolli.ai", "state=s1&code=c1", "s1")

        val req = JsonParser.parseString(bridgeRequest.captured).asJsonObject
        req.get("retryHint").asString shouldBe "You can try again from Settings."
    }

    // --- applyCallbackResult tests ---

    /** Records which UI callback fired, so "exactly one, exactly once" is assertable. */
    private class CallbackSpy {
        val successes = mutableListOf<JolliAuthService.LoginResult>()
        val errors = mutableListOf<String>()

        fun apply(result: JolliAuthService.AuthCallbackResult) =
            JolliAuthService.applyCallbackResult(result, { successes += it }, { errors += it })
    }

    @Test
    fun `applyCallbackResult fires onSuccess on success`() {
        val spy = CallbackSpy()
        spy.apply(
            JolliAuthService.AuthCallbackResult(
                success = true,
                redirectUrl = "https://jolli.ai/cli-complete",
                token = "tok",
                jolliApiKey = "sk-jol-x",
            ),
        )

        spy.successes.single().token shouldBe "tok"
        spy.successes.single().jolliApiKey shouldBe "sk-jol-x"
        spy.errors.size shouldBe 0
    }

    @Test
    fun `applyCallbackResult treats a tokenless success as a failure`() {
        // A malformed bridge response must not leave the IDE believing it is
        // signed in — the pre-bridge code raised "no token" here too.
        val spy = CallbackSpy()
        spy.apply(JolliAuthService.AuthCallbackResult(success = true, redirectUrl = null))

        spy.successes.size shouldBe 0
        spy.errors.single() shouldBe JolliAuthService.MSG_NO_TOKEN
    }

    @Test
    fun `applyCallbackResult fires onError on a structured failure`() {
        val spy = CallbackSpy()
        spy.apply(
            JolliAuthService.AuthCallbackResult(
                success = false,
                redirectUrl = null,
                errorCode = "user_denied",
                errorMessage = "Sign-in was cancelled. You can try again.",
            ),
        )

        // A sentence, not a raw error code — this is what the IDE balloon shows.
        spy.errors.single() shouldBe "Sign-in was cancelled. You can try again."
        spy.successes.size shouldBe 0
    }

    @Test
    fun `applyCallbackResult falls back to a generic message when the bridge omits one`() {
        val spy = CallbackSpy()
        spy.apply(
            JolliAuthService.AuthCallbackResult(
                success = false,
                redirectUrl = null,
                errorCode = "server_error",
                errorMessage = null,
            ),
        )

        spy.errors.single() shouldBe "Login failed"
        spy.successes.size shouldBe 0
    }

    @Test
    fun `applyCallbackResult forwards the CLI's errorCode as content-free telemetry`() {
        // Regression coverage for the "PR description promised telemetry keeps the
        // specific classification but errorCode was never consumed" review.
        // Every rejected callback flows through trackError(where="signin") so the
        // sign-in-funnel dashboard sees the CLI's specific bucket (invalid_callback,
        // access_denied, user_denied, …) instead of collapsing to a single opaque
        // error.
        mockkObject(ai.jolli.jollimemory.core.telemetry.Telemetry)
        every {
            ai.jolli.jollimemory.core.telemetry.Telemetry.trackError(any(), any(), any(), any())
        } returns Unit

        val spy = CallbackSpy()
        spy.apply(
            JolliAuthService.AuthCallbackResult(
                success = false,
                redirectUrl = null,
                errorCode = "invalid_callback",
                errorMessage = "state mismatch",
            ),
        )

        verify(exactly = 1) {
            ai.jolli.jollimemory.core.telemetry.Telemetry.trackError(
                where = "signin",
                code = "invalid_callback",
            )
        }
        spy.errors.single() shouldBe "state mismatch"
    }

    @Test
    fun `applyCallbackResult tags a tokenless success with its own telemetry code`() {
        // A CLI success that omitted the token is a distinct failure mode from a
        // structured rejection — tag it separately so it does not disappear into
        // the generic `server_error` bucket.
        mockkObject(ai.jolli.jollimemory.core.telemetry.Telemetry)
        every {
            ai.jolli.jollimemory.core.telemetry.Telemetry.trackError(any(), any(), any(), any())
        } returns Unit

        val spy = CallbackSpy()
        spy.apply(JolliAuthService.AuthCallbackResult(success = true, redirectUrl = null))

        verify(exactly = 1) {
            ai.jolli.jollimemory.core.telemetry.Telemetry.trackError(where = "signin", code = "no_token")
        }
        spy.errors.single() shouldBe JolliAuthService.MSG_NO_TOKEN
    }

    @Test
    fun `applyCallbackResult defaults telemetry to server_error when the CLI omits errorCode`() {
        // Defensive: an untyped throw path (Node missing, daemon unreachable) in
        // handleAuthCallbackViaIdeBridge falls back to `server_error` at the wire
        // layer, but a bridge response that literally omits errorCode must still
        // produce a valid trackError call — dropping it silently would leave the
        // funnel dashboard with a missing failure event.
        mockkObject(ai.jolli.jollimemory.core.telemetry.Telemetry)
        every {
            ai.jolli.jollimemory.core.telemetry.Telemetry.trackError(any(), any(), any(), any())
        } returns Unit

        val spy = CallbackSpy()
        spy.apply(
            JolliAuthService.AuthCallbackResult(
                success = false,
                redirectUrl = null,
                errorCode = null,
                errorMessage = "boom",
            ),
        )

        verify(exactly = 1) {
            ai.jolli.jollimemory.core.telemetry.Telemetry.trackError(where = "signin", code = "server_error")
        }
    }

    // --- signOut tests ---

    @Test
    fun `signOut clears both authToken and jolliApiKey via fallback`() {
        // When ide-bridge is unreachable, signOut falls back to direct config write.
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns "/fake"
        every { CliIntegrations.runIdeBridge(any(), any(), any(), any()) } throws RuntimeException("no CLI")

        mockkObject(SessionTracker)
        every { SessionTracker.getGlobalConfigDir() } returns "/fake/global"
        every { SessionTracker.loadConfigFromDir("/fake/global") } returns JolliMemoryConfig(
            authToken = "old-token",
            jolliApiKey = "sk-jol-stale-tenant",
        )
        val savedConfig = slot<JolliMemoryConfig>()
        every { SessionTracker.saveConfigToDir(capture(savedConfig), "/fake/global") } returns Unit

        awaitAuthNotification { JolliAuthService.signOut() }

        savedConfig.captured.authToken shouldBe null
        savedConfig.captured.jolliApiKey shouldBe null
    }

    @Test
    fun `signOut fallback preserves unrelated config fields including aiProvider`() {
        // The fallback deliberately leaves aiProvider alone: unlike the CLI it
        // cannot tell whether "jolli" came from a Jolli sign-in. The bridge path
        // DOES roll it back — see `signOut delegates to ide-bridge`.
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns "/fake"
        every { CliIntegrations.runIdeBridge(any(), any(), any(), any()) } throws RuntimeException("no CLI")

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

        awaitAuthNotification { JolliAuthService.signOut() }

        savedConfig.captured.aiProvider shouldBe "jolli"
        savedConfig.captured.storageMode shouldBe "dual-write"
    }

    @Test
    fun `signOut notifies auth listeners`() {
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns "/fake"
        every { CliIntegrations.runIdeBridge(any(), any(), any(), any()) } throws RuntimeException("no CLI")

        mockkObject(SessionTracker)
        every { SessionTracker.getGlobalConfigDir() } returns "/fake/global"
        every { SessionTracker.loadConfigFromDir("/fake/global") } returns JolliMemoryConfig()
        every { SessionTracker.saveConfigToDir(any(), any()) } returns Unit

        var notified = false
        val disposable = JolliAuthService.addAuthListener { notified = true }

        awaitAuthNotification { JolliAuthService.signOut() }

        notified shouldBe true
        disposable.dispose()
    }

    @Test
    fun `signOut delegates to ide-bridge and skips the local write entirely`() {
        // The CLI's clearAuthCredentials owns the write, and it also rolls
        // aiProvider back from "jolli" — a deliberate behavior change from the
        // pre-bridge Kotlin path, which preserved it. A local write on top would
        // resurrect the old semantics.
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns "/fake"
        val bridgeRequest = slot<String>()
        every { CliIntegrations.runIdeBridge(any(), "auth", capture(bridgeRequest)) } returns JsonObject().apply {
            addProperty("ok", true)
        }

        mockkObject(SessionTracker)
        every { SessionTracker.getGlobalConfigDir() } returns "/fake/global"
        every { SessionTracker.loadConfigFromDir(any()) } returns JolliMemoryConfig()
        every { SessionTracker.saveConfigToDir(any(), any()) } returns Unit

        awaitAuthNotification { JolliAuthService.signOut() }

        JsonParser.parseString(bridgeRequest.captured).asJsonObject.get("operation").asString shouldBe "sign-out"
        verify(exactly = 0) { SessionTracker.saveConfigToDir(any(), any()) }
    }

    @Test
    fun `signOut runs off the calling thread`() {
        // signOut is wired straight to a Swing button and now does an ide-bridge
        // round-trip (~500 ms-2 s on a cold IDE). Running it inline would block
        // the EDT past the platform's 300 ms slow-operation threshold.
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns "/fake"
        val bridgeThread = java.util.concurrent.atomic.AtomicReference<String>()
        every { CliIntegrations.runIdeBridge(any(), any(), any(), any()) } answers {
            bridgeThread.set(Thread.currentThread().name)
            JsonObject()
        }

        awaitAuthNotification { JolliAuthService.signOut() }

        bridgeThread.get() shouldNotBe Thread.currentThread().name
    }

    // --- login + handleAuthCallback tests ---

    @Test
    fun `login builds the URL off the calling thread`() {
        // login() is invoked straight from Swing action listeners. The bridge
        // round-trip is a ~500 ms-2 s Node spawn on a cold IDE, so doing it
        // inline would block the EDT past the 300 ms slow-operation threshold.
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns System.getProperty("user.home")
        val bridgeThread = java.util.concurrent.atomic.AtomicReference<String>()
        val bridgeCalled = CountDownLatch(1)
        every { CliIntegrations.runIdeBridge(any(), any(), any(), any()) } answers {
            bridgeThread.set(Thread.currentThread().name)
            bridgeCalled.countDown()
            // No "url" field → buildLoginUrlViaIdeBridge throws, which the
            // background block must swallow into a single onError.
            JsonObject()
        }

        val errors = CountDownLatch(1)
        JolliAuthService.login(
            onSuccess = {},
            onError = { errors.countDown() },
        )

        bridgeCalled.await(5, TimeUnit.SECONDS) shouldBe true
        bridgeThread.get() shouldNotBe Thread.currentThread().name
        errors.await(5, TimeUnit.SECONDS) shouldBe true
    }

    @Test
    fun `login builds a loopback callback URL`() {
        // The CSRF nonce travels only as the top-level `state` login param
        // (added by buildLoginUrlViaIdeBridge). Code-exchange servers echo it
        // on the `?code=` callback; the legacy `?token=` branch has no CSRF
        // check by design (pre-code-exchange servers never echo state). Both
        // match main CLI / VS Code semantics, so there's no need to embed
        // state in the callback URL itself — it's a plain
        // `http://localhost:<port>/callback`.
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns System.getProperty("user.home")
        val bridgeRequest = java.util.concurrent.atomic.AtomicReference<String>()
        val bridgeCalled = CountDownLatch(1)
        every { CliIntegrations.runIdeBridge(any(), any(), any(), any()) } answers {
            bridgeRequest.set(arg<String>(2))
            bridgeCalled.countDown()
            JsonObject()
        }

        val errors = CountDownLatch(1)
        JolliAuthService.login(onSuccess = {}, onError = { errors.countDown() })

        bridgeCalled.await(5, TimeUnit.SECONDS) shouldBe true
        errors.await(5, TimeUnit.SECONDS) shouldBe true
        val req = JsonParser.parseString(bridgeRequest.get()).asJsonObject
        // 16 random bytes rendered as hex.
        val state = req.get("state").asString
        state.length shouldBe 32
        val callbackUrl = req.get("callbackUrl").asString
        callbackUrl shouldMatch Regex("^http://localhost:\\d+/callback$")
    }

    @Test
    fun `browser callback fires onSuccess and 302s to the ide-bridge redirectUrl`() {
        // End-to-end: login() spins up a loopback server; simulate the browser
        // by GETting http://localhost:<port>/callback. handleAuthCallbackViaIdeBridge
        // returns a success result with a redirectUrl, so the server must
        // 302 the browser there.
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns System.getProperty("user.home")

        val loginState = java.util.concurrent.atomic.AtomicReference<String>()
        val loginCallbackUrl = java.util.concurrent.atomic.AtomicReference<String>()
        val loginBridgeCalled = CountDownLatch(1)
        every { CliIntegrations.runIdeBridge(any(), any(), any(), any()) } answers {
            val req = JsonParser.parseString(arg<String>(2)).asJsonObject
            when (req.get("operation").asString) {
                "build-login-url" -> {
                    loginState.set(req.get("state").asString)
                    loginCallbackUrl.set(req.get("callbackUrl").asString)
                    loginBridgeCalled.countDown()
                    JsonObject().apply { addProperty("url", "https://jolli.ai/login") }
                }
                "handle-auth-callback" -> JsonObject().apply {
                    addProperty("success", true)
                    addProperty("redirectUrl", "https://jolli.ai/cli-complete")
                    addProperty("token", "tok-1")
                    addProperty("jolliApiKey", "sk-jol-x")
                }
                else -> JsonObject()
            }
        }

        val successes = mutableListOf<JolliAuthService.LoginResult>()
        val successLatch = CountDownLatch(1)
        JolliAuthService.login(
            onSuccess = { r ->
                synchronized(successes) { successes += r }
                successLatch.countDown()
            },
            onError = { /* no-op */ },
        )

        loginBridgeCalled.await(5, TimeUnit.SECONDS) shouldBe true
        val port = extractPort(loginCallbackUrl.get())
        val state = loginState.get()

        val conn = openLoopback("http://127.0.0.1:$port/callback?state=$state&code=c1")
        try {
            conn.responseCode shouldBe 302
            conn.getHeaderField("Location") shouldBe "https://jolli.ai/cli-complete"
        } finally {
            conn.disconnect()
        }

        successLatch.await(5, TimeUnit.SECONDS) shouldBe true
        synchronized(successes) { successes.single().token shouldBe "tok-1" }
    }

    @Test
    fun `browser callback fires onError on a structured ide-bridge failure`() {
        // A state-mismatch or invalid_callback comes back from the ide-bridge
        // as a structured failure with a redirectUrl to /cli-complete?error=…
        // The server 302s the browser to the completion page AND fires onError
        // so the IDE can show the toast.
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns System.getProperty("user.home")

        val loginCallbackUrl = java.util.concurrent.atomic.AtomicReference<String>()
        val loginBridgeCalled = CountDownLatch(1)
        every { CliIntegrations.runIdeBridge(any(), any(), any(), any()) } answers {
            val req = JsonParser.parseString(arg<String>(2)).asJsonObject
            when (req.get("operation").asString) {
                "build-login-url" -> {
                    loginCallbackUrl.set(req.get("callbackUrl").asString)
                    loginBridgeCalled.countDown()
                    JsonObject().apply { addProperty("url", "https://jolli.ai/login") }
                }
                "handle-auth-callback" -> JsonObject().apply {
                    addProperty("success", false)
                    addProperty("redirectUrl", "https://jolli.ai/cli-complete?error=invalid_callback")
                    addProperty("errorCode", "invalid_callback")
                    addProperty("errorMessage", "State mismatch")
                }
                else -> JsonObject()
            }
        }

        val errorLatch = CountDownLatch(1)
        val errorMessages = mutableListOf<String>()
        JolliAuthService.login(
            onSuccess = { /* no-op */ },
            onError = { msg ->
                synchronized(errorMessages) { errorMessages += msg }
                errorLatch.countDown()
            },
        )

        loginBridgeCalled.await(5, TimeUnit.SECONDS) shouldBe true
        val port = extractPort(loginCallbackUrl.get())

        val conn = openLoopback("http://127.0.0.1:$port/callback?state=wrong&code=c1")
        try {
            conn.responseCode shouldBe 302
            conn.getHeaderField("Location") shouldBe
                "https://jolli.ai/cli-complete?error=invalid_callback"
        } finally {
            conn.disconnect()
        }

        errorLatch.await(5, TimeUnit.SECONDS) shouldBe true
        synchronized(errorMessages) { errorMessages.single() shouldBe "State mismatch" }
    }

    @Test
    fun `a second login supersedes the first — the first server is torn down`() {
        // Silent supersede: a second login() call shuts down the first server
        // without firing any callback for it, then starts a fresh server.
        // The first login's callbacks are silently dropped. Mirrors VS Code's
        // "second click overwrites pendingState" behavior.
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns System.getProperty("user.home")

        val callbackUrls = java.util.concurrent.CopyOnWriteArrayList<String>()
        val loginBarrier = java.util.concurrent.Semaphore(0)
        every { CliIntegrations.runIdeBridge(any(), any(), any(), any()) } answers {
            val req = JsonParser.parseString(arg<String>(2)).asJsonObject
            if (req.get("operation").asString == "build-login-url") {
                callbackUrls += req.get("callbackUrl").asString
                loginBarrier.release()
                JsonObject().apply { addProperty("url", "https://jolli.ai/login") }
            } else {
                JsonObject().apply {
                    addProperty("success", true)
                    addProperty("token", "tok")
                }
            }
        }

        val successCount1 = AtomicInteger(0)
        val errorCount1 = AtomicInteger(0)
        JolliAuthService.login(
            onSuccess = { successCount1.incrementAndGet() },
            onError = { errorCount1.incrementAndGet() },
        )
        loginBarrier.acquire()

        val firstPort = extractPort(callbackUrls[0])

        JolliAuthService.login(
            onSuccess = { /* no-op */ },
            onError = { /* no-op */ },
        )
        loginBarrier.acquire()

        // The first server must be torn down. A callback against the old port
        // now fails to connect (or fails to establish) — proof the old server
        // is gone. Give the executor a moment to release the socket.
        Thread.sleep(200)
        val connectSucceeded = try {
            val conn = openLoopback("http://127.0.0.1:$firstPort/callback?state=x&code=y")
            try {
                conn.responseCode
                true
            } finally {
                conn.disconnect()
            }
        } catch (_: Exception) {
            false
        }
        connectSucceeded shouldBe false

        // First login's callbacks were dropped by the supersede.
        successCount1.get() shouldBe 0
        errorCount1.get() shouldBe 0
    }

    @Test
    fun `login fires onError when the ide-bridge build-login-url call fails`() {
        // A missing Node / off-allowlist tenant / thrown BrowserUtil must
        // surface as onError so the user sees why nothing happened after they
        // clicked Sign In.
        mockkObject(CliIntegrations)
        every { CliIntegrations.resolveDefaultCwd() } returns System.getProperty("user.home")
        every { CliIntegrations.runIdeBridge(any(), any(), any(), any()) } throws RuntimeException("boom")

        val errors = CountDownLatch(1)
        val errorMessages = mutableListOf<String>()
        JolliAuthService.login(
            onSuccess = {},
            onError = { msg ->
                synchronized(errorMessages) { errorMessages += msg }
                errors.countDown()
            },
        )
        errors.await(5, TimeUnit.SECONDS) shouldBe true
        synchronized(errorMessages) { errorMessages.single() shouldContain "Failed to start login" }
    }

    // ── loopback test helpers ───────────────────────────────────────────

    /** Extract the port from a `http://localhost:<port>/callback` URL. */
    private fun extractPort(callbackUrl: String): Int {
        val match = Regex("^http://localhost:(\\d+)/callback$").matchEntire(callbackUrl)
            ?: error("Not a loopback callback URL: $callbackUrl")
        return match.groupValues[1].toInt()
    }

    /**
     * Open an HTTP connection to a loopback URL without following redirects
     * so tests can assert on the 302 + Location header the callback handler
     * emits.
     */
    private fun openLoopback(url: String): java.net.HttpURLConnection {
        val conn = java.net.URI.create(url).toURL().openConnection() as java.net.HttpURLConnection
        conn.instanceFollowRedirects = false
        conn.connectTimeout = 5_000
        conn.readTimeout = 5_000
        return conn
    }
}

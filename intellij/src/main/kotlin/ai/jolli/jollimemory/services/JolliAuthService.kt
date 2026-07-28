package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.auth.JolliAuthUtils
import ai.jolli.jollimemory.auth.JolliConfigStore
import ai.jolli.jollimemory.auth.JolliUrlConfig
import ai.jolli.jollimemory.bridge.CliIntegrations
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.telemetry.Telemetry
import ai.jolli.jollimemory.core.telemetry.TelemetryActivation
import ai.jolli.jollimemory.core.telemetry.TelemetrySharedConfig
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.security.SecureRandom
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * OAuth login flow for Jolli — opens the browser to the sign-in page and
 * receives the completion callback via a local loopback HTTP server.
 *
 * Business logic (URL building, CSRF validation, code exchange, credential
 * persistence) is delegated to the CLI's ide-bridge `auth` actions so the CLI
 * remains the single source of truth across CLI / VS Code / IntelliJ surfaces.
 * This class is a thin platform adapter: it owns the loopback HTTP server
 * lifecycle, [BrowserUtil.browse], and the Swing UI notification fan-out.
 *
 * Callback UX mirrors VS Code (see `vscode/src/services/AuthService.ts`):
 *
 *  - SILENT SUPERSEDE — a second [login] call before the first completes
 *    silently shuts down the first server and starts a fresh one. No error
 *    balloon, no "another sign-in is in progress" dialog. Matches VS Code's
 *    "second click overwrites `pendingState`".
 *  - NEVER BLOCKS THE UI — if the user closes the browser tab or wanders off,
 *    the loopback server sits idle for at most [PENDING_LOGIN_TTL_MINUTES],
 *    then silently shuts down to release the port. No onError fires; no
 *    notification is shown. The user just re-clicks Sign In whenever.
 *  - onError is fired ONLY on real launch failures (ide-bridge unreachable,
 *    off-allowlist tenant URL, port bind failure, [BrowserUtil.browse]
 *    throwing) or on a structured callback failure (state mismatch, code
 *    exchange rejected). Never on tab close, TTL expiry, or supersede.
 *  - The browser tab lands on `<jolliUrl>/cli-complete` after a callback —
 *    the same completion page VS Code users see. Loopback returns a 302 to
 *    the URL the ide-bridge produced.
 *
 * UX DIFFERENCE vs VS Code: on successful sign-in, VS Code's OS URI handler
 * brings the VS Code window to the foreground automatically. This loopback
 * flow does NOT reopen the IntelliJ window — the user has to switch back
 * from the browser themselves. Chosen deliberately over `jetbrains://`
 * dispatch: loopback works on any macOS/Windows/Linux install without
 * requiring JetBrains Toolbox (or any JB IDE having launched at least once)
 * to register the `jetbrains://` URL scheme handler.
 *
 * Two deliberate exceptions to "everything goes through the bridge":
 *
 *  - [isSignedIn] stays a local config read. It is polled from Swing paint
 *    and action-update paths, where even a daemon round-trip per poll would
 *    make the UI sluggish.
 *  - The signOut fallback keeps a direct config-clear path so users can log
 *    out even when the ide-bridge is unreachable.
 */
object JolliAuthService {

    private val log = JmLogger.create("JolliAuthService")

    /**
     * How long the loopback callback server sits listening before it silently
     * shuts down to release the port. Mirrors VS Code's `PENDING_STATE_TTL_MS
     * = 5 min` — the server-side `state` TTL is typically ~10 min, so this
     * closes the local resource first and lets the server-side one age out
     * naturally.
     *
     * Deliberately silent: no UI callback fires when this expires. The only
     * reason it exists is to free the TCP port. Every user-visible outcome
     * comes from either a real callback (success/failure) or a real launch
     * failure — not from timing out.
     */
    private const val PENDING_LOGIN_TTL_MINUTES: Long = 5L

    /**
     * Hard cap on the `handle-auth-callback` ide-bridge round-trip. The
     * shared [CliIntegrations.IDE_BRIDGE_TIMEOUT_SECONDS] (300 s) is chosen
     * for batch ops like push / store-summary; here 25 s is a small grace
     * window above the CLI's own `CLI_EXCHANGE_TIMEOUT_MS` (20 s in
     * `cli/src/auth/CliExchange.ts`) plus the spawn cost (~500 ms daemon /
     * ~2 s cold one-shot). Setting this BELOW the CLI's inner HTTP timeout
     * risks `destroyForcibly()` killing the subprocess after the server has
     * accepted the single-use code but before we receive the response —
     * which strands the user with a "used" code and a confusing error.
     */
    private const val OAUTH_CALLBACK_BRIDGE_TIMEOUT_SECONDS = 25L

    /** Reported when the CLI signals success but omits the token — never treat that as signed in. */
    internal const val MSG_NO_TOKEN = "Sign-in failed: no token was returned. Please try again."

    /**
     * Surface-specific "how to retry" sentence appended to the CLI's
     * `user_denied` message. The shared table can't hard-code it — the CLI
     * names a command and VS Code names its side panel.
     */
    private const val RETRY_HINT = "You can try again from Settings."

    // ── loopback server state ────────────────────────────────────────────

    @Volatile
    private var server: HttpServer? = null

    @Volatile
    private var serverExecutor: ExecutorService? = null

    private val timeoutExecutor: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "JolliAuth-server-ttl").apply { isDaemon = true }
        }

    @Volatile
    private var timeoutTask: ScheduledFuture<*>? = null

    /**
     * Guards against firing user callbacks twice for the same attempt — if
     * the browser callback and the TTL fire concurrently, whoever loses the
     * CAS becomes a no-op. Reset on every new [login] call.
     */
    private val completed = AtomicBoolean(false)

    // ── auth listeners + isSignedIn cache ────────────────────────────────

    private val authListeners = java.util.concurrent.CopyOnWriteArrayList<() -> Unit>()

    fun addAuthListener(listener: () -> Unit): Disposable {
        authListeners.add(listener)
        return Disposable { authListeners.remove(listener) }
    }

    private fun notifyAuthListeners() {
        signedInCache = null
        signedInCacheExpiresAt = 0L
        authListeners.forEach { it() }
    }

    /**
     * Cached result of the last is-signed-in probe. isSignedIn() is polled on
     * every action-update tick and toolbar refresh — even with the daemon
     * fast path, avoiding a bridge round-trip per poll keeps the UI reactive.
     * Invalidated inside [notifyAuthListeners] so login success and signOut
     * both force the next call to re-query.
     *
     * A short TTL ([SIGNED_IN_CACHE_TTL_MS]) ensures external token changes —
     * `jolli login` / `jolli sign-out` from a terminal while the IDE is open —
     * become visible within a few seconds instead of never.
     */
    @Volatile
    private var signedInCache: Boolean? = null

    @Volatile
    private var signedInCacheExpiresAt: Long = 0L

    private const val SIGNED_IN_CACHE_TTL_MS: Long = 5_000

    fun isSignedIn(): Boolean {
        val cached = signedInCache
        if (cached != null && System.currentTimeMillis() < signedInCacheExpiresAt) return cached
        val v = JolliConfigStore.loadAuthToken() != null
        signedInCache = v
        signedInCacheExpiresAt = System.currentTimeMillis() + SIGNED_IN_CACHE_TTL_MS
        return v
    }

    // ── data classes ─────────────────────────────────────────────────────

    /** Credentials handed back to the caller on successful sign-in. */
    data class LoginResult(
        val token: String,
        val space: String? = null,
        val jolliApiKey: String? = null,
    )

    /**
     * Structured result from the CLI ide-bridge `handle-auth-callback` action.
     * `redirectUrl` is a URL on the Jolli frontend (typically
     * `<jolliUrl>/cli-complete[?error=...]`) — the loopback callback handler
     * 302s the browser there so the user lands on the same completion page
     * as the VS Code flow.
     */
    data class AuthCallbackResult(
        val success: Boolean,
        val redirectUrl: String?,
        val token: String? = null,
        val space: String? = null,
        val jolliApiKey: String? = null,
        val errorCode: String? = null,
        val errorMessage: String? = null,
    )

    // ── login ────────────────────────────────────────────────────────────

    /**
     * Start the OAuth login flow. Spins up a loopback HTTP server on a
     * random port, opens the browser to the Jolli sign-in page, and waits
     * for the callback.
     *
     * See the class docstring for supersede / TTL / onError contract —
     * `onError` fires ONLY on real launch failures or structured callback
     * failures, NEVER on tab close or timeout.
     *
     * @param forceFreshApiKey force the server to mint a fresh Jolli API key
     *   even when the existing key already matches the target tenant.
     *   User-initiated "Sign In" actions pass `true` so a manual recovery
     *   from a revoked same-tenant key actually replaces the dead key
     *   (otherwise `shouldRequestFreshApiKey` keeps it).
     * @param onSuccess invoked on the server-executor thread on successful
     *   sign-in.
     * @param onError invoked on the server-executor thread (callback path)
     *   or the pooled thread (launch path) — never on tab close, TTL expiry,
     *   or supersede.
     */
    fun login(
        forceFreshApiKey: Boolean = false,
        onSuccess: (result: LoginResult) -> Unit,
        onError: (message: String) -> Unit,
    ) {
        // Silent supersede: kill any previous server + timer without firing
        // a callback. A stale attempt's browser tab, if it later completes,
        // will hit either a closed port (no-op) or the new server with a
        // stale state that gets rejected as CSRF mismatch.
        shutdown()
        completed.set(false)

        val jolliUrl = JolliUrlConfig.getJolliUrl()

        // Bind loopback port up front so we know it succeeded before
        // launching the browser. Port bind failures (EADDRINUSE, sandbox
        // restrictions) are rare but must surface — the user just clicked
        // Sign In and nothing else will tell them.
        val httpServer = try {
            HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        } catch (e: Exception) {
            log.warn("Failed to bind loopback callback server: ${e.message}")
            onError("Couldn't start the sign-in listener: ${e.message}")
            return
        }
        val executor = Executors.newSingleThreadExecutor { r ->
            Thread(r, "JolliAuth-callback").apply { isDaemon = true }
        }
        httpServer.executor = executor
        server = httpServer
        serverExecutor = executor

        val port = httpServer.address.port
        val stateBytes = ByteArray(16)
        SecureRandom().nextBytes(stateBytes)
        val state = stateBytes.joinToString("") { "%02x".format(it) }
        val callbackUrl = "http://localhost:$port/callback"

        httpServer.createContext("/callback") { exchange ->
            // If the TTL fired between the browser hitting this endpoint and
            // this handler running, the previous shutdown() already tore the
            // server down — this shouldn't be reachable, but the CAS guards
            // against firing user callbacks twice even so.
            if (!completed.compareAndSet(false, true)) {
                respondPlain(exchange, 408, "Sign-in has already ended. Please try again.")
                return@createContext
            }
            try {
                val queryString = exchange.requestURI.query ?: ""
                log.info("Callback received on loopback (port=%d)", port)

                val result = handleAuthCallbackViaIdeBridge(jolliUrl, queryString, state)

                // Answer the browser first, then dispatch to Swing callbacks.
                // Success or structured failure → 302 to the `redirectUrl`
                // the ide-bridge produced (typically `<jolliUrl>/cli-complete`,
                // the same page VS Code users land on). Bridge-level failure
                // has no completion URL to offer, so fall back to plain text —
                // and, critically, use a success-specific body on 200 so a
                // version-drifted CLI that omits `redirectUrl` doesn't leave
                // the browser reading "Sign-in failed" while the IDE flips to
                // signed-in.
                val redirect = result.redirectUrl
                if (!redirect.isNullOrBlank()) {
                    exchange.responseHeaders.add("Location", redirect)
                    exchange.sendResponseHeaders(302, -1)
                    exchange.close()
                } else if (result.success) {
                    respondPlain(exchange, 200, "Sign-in complete. You can close this window.")
                } else {
                    respondPlain(exchange, 500, result.errorMessage ?: "Sign-in failed. Please try again.")
                }

                applyCallbackResult(result, onSuccess, onError)
            } catch (e: Exception) {
                log.warn("Callback handler failed: ${e.message}")
                try {
                    respondPlain(exchange, 500, "Sign-in failed: ${e.message}")
                } catch (_: Exception) {
                    // Response may already be committed — nothing more to do.
                }
                onError("Callback handler failed: ${e.message}")
            } finally {
                shutdown()
            }
        }

        try {
            httpServer.start()
            log.info("OAuth loopback server started on port %d", port)
        } catch (e: Exception) {
            log.warn("Failed to start loopback server: ${e.message}")
            shutdown()
            onError("Couldn't start the sign-in listener: ${e.message}")
            return
        }

        // Silent TTL. Only reason it exists is to release the port — every
        // user-visible outcome comes from the callback (success/failure) or
        // from a real launch failure below.
        timeoutTask = timeoutExecutor.schedule({
            if (completed.compareAndSet(false, true)) {
                log.info("Sign-in loopback expired silently after %d min", PENDING_LOGIN_TTL_MINUTES)
                shutdown()
            }
        }, PENDING_LOGIN_TTL_MINUTES, TimeUnit.MINUTES)

        // Off-EDT: config read, telemetry write, ide-bridge round-trip
        // (~5-20 ms daemon, ~500 ms-2 s cold one-shot) and browser launch.
        // login() is called straight from Swing action listeners.
        runOffEdt {
            try {
                val existingApiKey = SessionTracker.loadConfig().jolliApiKey
                Telemetry.track("signin_started", mapOf("trigger" to "intellij"))
                val loginUrl = buildLoginUrlViaIdeBridge(
                    jolliUrl = jolliUrl,
                    callbackUrl = callbackUrl,
                    state = state,
                    clientVersion = JolliApiClient.pluginVersion,
                    generateApiKey = forceFreshApiKey ||
                        JolliAuthUtils.shouldRequestFreshApiKey(existingApiKey, jolliUrl),
                    installId = TelemetrySharedConfig.getOrCreateInstallId().first,
                )
                log.info("Opening browser for sign-in")
                BrowserUtil.browse(loginUrl)
            } catch (e: Exception) {
                // Real launch failure — no callback will ever arrive. Users
                // need a visible signal because they just clicked Sign In and
                // nothing else will surface it. Matches VS Code's
                // `openExternal` throw handling.
                log.warn("Failed to start OAuth flow: ${e.message}")
                if (completed.compareAndSet(false, true)) {
                    shutdown()
                    onError("Failed to start login: ${e.message}")
                }
            }
        }
    }

    // ── sign out ─────────────────────────────────────────────────────────

    /**
     * Clears the stored credentials.
     *
     * Runs off the EDT: sign-out is wired straight to a Swing button and
     * does an ide-bridge round-trip. Every registered auth listener already
     * re-enters the EDT via `invokeLater`, so notifying from a pooled thread
     * is safe.
     *
     * BEHAVIOR CHANGE vs the pre-bridge Kotlin implementation: the CLI's
     * `clearAuthCredentials` also rolls `aiProvider` back from "jolli" to
     * unset, where the old Kotlin write preserved it. That is deliberate —
     * leaving "jolli" behind pins LLM routing to the proxy after the
     * credentials are gone. The fallback path below intentionally does NOT
     * clear it, because it cannot know whether the value came from a Jolli
     * sign-in.
     */
    fun signOut() = runOffEdt {
        try {
            val request = JsonObject().apply { addProperty("operation", "sign-out") }
            CliIntegrations.runIdeBridge(CliIntegrations.resolveDefaultCwd(), "auth", Gson().toJson(request))
        } catch (e: Exception) {
            log.warn("ide-bridge sign-out failed, falling back to direct config clear: ${e.message}")
            val globalDir = SessionTracker.getGlobalConfigDir()
            val existing = SessionTracker.loadConfigFromDir(globalDir)
            SessionTracker.saveConfigToDir(existing.copy(authToken = null, jolliApiKey = null), globalDir)
        }
        Telemetry.track("signed_out")
        notifyAuthListeners()
    }

    /**
     * Full teardown for plugin unload. This is an `object`, so its
     * [timeoutExecutor] thread and the [authListeners] list would otherwise
     * pin the plugin classloader after a dynamic unload. Called from
     * [ai.jolli.jollimemory.JolliDynamicUnloadCleaner] on `beforePluginUnload`.
     */
    fun shutdownForUnload() {
        shutdown()
        timeoutExecutor.shutdownNow()
        authListeners.clear()
    }

    // ── server lifecycle helpers ─────────────────────────────────────────

    /**
     * Idempotently closes the loopback server, its executor, and cancels
     * the TTL timer. Safe to call from any thread and when nothing is
     * running. Does NOT fire any user-facing callback — the caller is
     * responsible for onError if one is warranted.
     */
    private fun shutdown() {
        timeoutTask?.cancel(false)
        timeoutTask = null
        // stop(0) — no grace period. The callback handler's `finally { shutdown() }`
        // runs AFTER `exchange.close()` (or `exchange.responseBody.use`) has already
        // flushed the browser response, so there is no in-flight exchange left to
        // wait on; giving stop() a grace window only delays supersede — a second
        // login() would then race the old server's teardown for the port.
        server?.stop(0)
        server = null
        serverExecutor?.shutdownNow()
        serverExecutor = null
    }

    /**
     * Writes a plain-text HTTP response. Used only when the ide-bridge
     * couldn't produce a redirect URL (bridge unreachable, malformed
     * response) — the happy path always 302s to `<jolliUrl>/cli-complete`.
     */
    private fun respondPlain(exchange: HttpExchange, statusCode: Int, message: String) {
        val bytes = message.toByteArray(Charsets.UTF_8)
        exchange.responseHeaders.add("Content-Type", "text/plain; charset=utf-8")
        exchange.sendResponseHeaders(statusCode, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    // ── callback outcome ─────────────────────────────────────────────────

    /**
     * Applies a resolved callback: fires exactly one of [onSuccess] /
     * [onError], notifies auth listeners on success, and (on success)
     * schedules the persistence + telemetry side effects off the caller's
     * thread so the loopback callback handler can release its executor and
     * accept a supersede.
     *
     * Callbacks fire SYNCHRONOUSLY on the caller's thread — every existing UI
     * hop already re-enters the EDT via `SwingUtilities.invokeLater`, so
     * threading is safe, and unit tests can assert the outcome without
     * awaiting a latch. Only the disk/telemetry IO moves off-thread, which
     * the browser never waits on (the 302 has already been flushed by the
     * time [applyCallbackResult] runs — see the caller in [login]).
     *
     * Kept as a separate function so the outcome rules — a success with no
     * token is a failure, neither callback is ever invoked twice — are
     * unit-testable without a live loopback HTTP round-trip.
     */
    internal fun applyCallbackResult(
        result: AuthCallbackResult,
        onSuccess: (result: LoginResult) -> Unit,
        onError: (message: String) -> Unit,
    ) {
        if (!result.success) {
            // Preserve the CLI's classified errorName (`invalid_callback`,
            // `failed_to_get_token`, `access_denied`, …) on the content-free
            // telemetry channel so the sign-in funnel dashboard keeps the
            // specific failure code instead of every rejected callback
            // collapsing to a single opaque error bucket. Emitted BEFORE the
            // UI onError so the event is buffered even if the caller decides
            // to shutdown() the loopback synchronously.
            Telemetry.trackError(where = "signin", code = result.errorCode ?: "server_error")
            onError(result.errorMessage ?: "Login failed")
            return
        }

        val token = result.token
        if (token.isNullOrBlank()) {
            // Never report a tokenless success as signed in. A CLI success
            // that omitted the token is a distinct failure mode from a
            // structured callback failure, so we tag it with its own code
            // rather than reusing the generic `server_error` bucket.
            Telemetry.trackError(where = "signin", code = "no_token")
            onError(MSG_NO_TOKEN)
            return
        }

        val loginResult = LoginResult(token = token, space = result.space, jolliApiKey = result.jolliApiKey)
        // Fire the UI callback + invalidate the isSignedIn cache first: the
        // banner / toolbar flip that follows must not wait on the pooled
        // thread. `notifyAuthListeners` only invalidates the cache and posts
        // to CopyOnWriteArrayList — both cheap — and every listener re-enters
        // the EDT via `invokeLater` on its own.
        notifyAuthListeners()
        onSuccess(loginResult)

        // Persist the space, refresh telemetry env, and emit the conversion
        // event on a pooled thread — none of these are on the UI's critical
        // path (the banner has already flipped, the browser has already
        // received its 302). Order-preserving: refreshEnv must land BEFORE
        // Telemetry.track so the event carries the new tenant's env, not the
        // pre-sign-in origin's. saveSpace is unordered vs the other two.
        // The CLI deliberately does not emit `signin_completed` — doing it in
        // both places would double-count the conversion.
        runOffEdt {
            if (!loginResult.space.isNullOrBlank()) {
                JolliConfigStore.saveSpace(loginResult.space)
            }
            TelemetryActivation.refreshEnv()
            Telemetry.track("signin_completed", mapOf("api_key_minted" to !loginResult.jolliApiKey.isNullOrBlank()))
        }
    }

    // ── ide-bridge adapters ──────────────────────────────────────────────

    /**
     * Builds the OAuth launch URL via the CLI ide-bridge `build-login-url`
     * action. The CLI constructs the URL with proper encoding and param
     * ordering — IntelliJ just forwards the result to BrowserUtil.browse.
     */
    internal fun buildLoginUrlViaIdeBridge(
        jolliUrl: String,
        callbackUrl: String,
        state: String,
        clientVersion: String,
        generateApiKey: Boolean,
        installId: String? = null,
    ): String {
        val request = JsonObject().apply {
            addProperty("operation", "build-login-url")
            addProperty("jolliUrl", jolliUrl)
            addProperty("callbackUrl", callbackUrl)
            addProperty("state", state)
            addProperty("clientVersion", clientVersion)
            addProperty("generateApiKey", generateApiKey)
            if (!installId.isNullOrBlank()) addProperty("installId", installId)
        }
        val response = try {
            CliIntegrations.runIdeBridge(CliIntegrations.resolveDefaultCwd(), "auth", Gson().toJson(request))
        } catch (e: Exception) {
            throw RuntimeException("Failed to build login URL via CLI bridge: ${e.message}", e)
        }
        val url = response?.takeIf { it.isJsonObject }?.asJsonObject
            ?.get("url")?.takeIf { it.isJsonPrimitive }?.asString
        if (url.isNullOrBlank()) {
            throw RuntimeException("CLI bridge returned no login URL")
        }
        return url
    }

    /**
     * Delegates the full auth callback processing to the CLI ide-bridge
     * `handle-auth-callback` action. The CLI parses the query string,
     * validates the CSRF state (on the `?code=` branch), redeems the code
     * (or accepts the legacy `?token=` without CSRF, matching main CLI /
     * VS Code semantics), persists credentials, and returns a structured
     * result plus the `redirectUrl` to hand back to the browser.
     */
    internal fun handleAuthCallbackViaIdeBridge(
        jolliUrl: String,
        queryString: String,
        expectedState: String,
    ): AuthCallbackResult {
        val request = JsonObject().apply {
            addProperty("operation", "handle-auth-callback")
            addProperty("jolliUrl", jolliUrl)
            addProperty("queryString", queryString)
            addProperty("expectedState", expectedState)
            addProperty("retryHint", RETRY_HINT)
        }
        val response = try {
            // Tight cap: the browser is synchronously blocked on this
            // response, and a wedged bridge would leave the tab hanging on
            // the loopback for the full ceiling. Fail fast so the user sees
            // an error page instead of a spinner.
            CliIntegrations.runIdeBridge(
                CliIntegrations.resolveDefaultCwd(),
                "auth",
                Gson().toJson(request),
                timeoutSeconds = OAUTH_CALLBACK_BRIDGE_TIMEOUT_SECONDS,
            )
        } catch (e: CliIntegrations.CliBridgeException) {
            // A business-logic error from the CLI. handle-auth-callback
            // returns its failures structurally, so reaching here means the
            // request itself was rejected (bad field, off-allowlist tenant
            // URL). Preserve the CLI's `errorName` as the `errorCode` so
            // telemetry / balloon copy keep the specific classification —
            // collapsing every case to `server_error` loses the diagnostic
            // detail the pre-bridge Kotlin path used to expose.
            log.warn("ide-bridge handle-auth-callback failed: ${e.message}")
            return bridgeUnavailable(
                message = e.message ?: "Couldn't reach the Jolli CLI to complete sign-in.",
                errorCode = e.errorName ?: "server_error",
            )
        } catch (e: Exception) {
            // Node missing, daemon unreachable, timeout. Surface the concrete
            // cause: "Node.js not found — …" is actionable, "server error" is
            // not. Untyped throw → no errorName is available; fall back to
            // the generic `server_error` bucket.
            log.warn("ide-bridge handle-auth-callback unexpected error: ${e.message}")
            return bridgeUnavailable(e.message ?: "Couldn't reach the Jolli CLI to complete sign-in.")
        }
        val obj = response?.takeIf { it.isJsonObject }?.asJsonObject
            ?: return bridgeUnavailable("The Jolli CLI returned a malformed response.")
        // `success` reads `isBoolean` explicitly rather than the looser
        // `isJsonPrimitive`: Gson's `.asBoolean` on a numeric primitive throws
        // UnsupportedOperationException, and on a string returns
        // `Boolean.parseBoolean` — both would misrepresent a drifted CLI
        // response. Mirrors the same pattern used by [JolliApiClient]'s
        // `boolOrFalse` helper.
        return AuthCallbackResult(
            success = obj.get("success")
                ?.takeIf { it.isJsonPrimitive && (it as com.google.gson.JsonPrimitive).isBoolean }
                ?.asBoolean ?: false,
            redirectUrl = obj.get("redirectUrl")?.takeIf { !it.isJsonNull && it.isJsonPrimitive }?.asString,
            token = obj.get("token")?.takeIf { !it.isJsonNull && it.isJsonPrimitive }?.asString,
            space = obj.get("space")?.takeIf { !it.isJsonNull && it.isJsonPrimitive }?.asString,
            jolliApiKey = obj.get("jolliApiKey")?.takeIf { !it.isJsonNull && it.isJsonPrimitive }?.asString,
            errorCode = obj.get("errorCode")?.takeIf { !it.isJsonNull && it.isJsonPrimitive }?.asString,
            errorMessage = obj.get("errorMessage")?.takeIf { !it.isJsonNull && it.isJsonPrimitive }?.asString,
        )
    }

    /**
     * Failure result for "the CLI produced no answer". The `redirectUrl`
     * field is left null; the loopback handler falls back to a plain-text
     * page in that case (no completion URL to redirect to).
     *
     * `errorCode` defaults to `"server_error"` for the untyped path (Node
     * missing, daemon unreachable, timeout) but callers on the CLI-typed
     * path forward the original `errorName` so classification survives.
     */
    private fun bridgeUnavailable(message: String, errorCode: String = "server_error") = AuthCallbackResult(
        success = false,
        redirectUrl = null,
        errorCode = errorCode,
        errorMessage = message,
    )

    // ── threading ────────────────────────────────────────────────────────

    /**
     * Runs [block] off the EDT.
     *
     * Falls back to a plain daemon thread when no [com.intellij.openapi.application.Application]
     * exists — plain unit tests instantiate this object without the platform,
     * and `getApplication()` legitimately returns null before app init.
     */
    private fun runOffEdt(block: () -> Unit) {
        // Explicit Runnable: executeOnPooledThread is overloaded on
        // Runnable/Callable, and a bare `() -> Unit` value is ambiguous.
        val runnable = Runnable { block() }
        val app = ApplicationManager.getApplication()
        if (app != null) {
            app.executeOnPooledThread(runnable)
        } else {
            Thread(runnable, "JolliAuth-bg").apply { isDaemon = true }.start()
        }
    }
}

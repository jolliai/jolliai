package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.auth.JolliConfigStore
import ai.jolli.jollimemory.auth.JolliUrlConfig
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SessionTracker
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.SecureRandom
import java.time.Duration
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * OAuth login flow for Jolli — spins up a localhost callback server,
 * opens the browser, and captures the token redirect.
 */
// TODO: test comment for jollimemory summary verification
object JolliAuthService {

    private val log = JmLogger.create("JolliAuthService")

    private const val DEFAULT_LOGIN_TIMEOUT_SECONDS = 60L

    @Volatile
    private var server: HttpServer? = null

    @Volatile
    private var serverExecutor: java.util.concurrent.ExecutorService? = null

    private val timeoutExecutor: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "JolliAuth-timeout").apply { isDaemon = true }
        }

    @Volatile
    private var timeoutTask: ScheduledFuture<*>? = null

    private val completed = AtomicBoolean(false)

    private val authListeners = java.util.concurrent.CopyOnWriteArrayList<() -> Unit>()

    fun addAuthListener(listener: () -> Unit): Disposable {
        authListeners.add(listener)
        return Disposable { authListeners.remove(listener) }
    }

    private fun notifyAuthListeners() { authListeners.forEach { it() } }

    fun isSignedIn(): Boolean = JolliConfigStore.loadAuthToken() != null

    /**
     * Start the OAuth login flow.
     * Opens the browser to the Jolli login page with a localhost callback.
     */
    data class LoginResult(
        val token: String,
        val space: String? = null,
        val jolliApiKey: String? = null,
    )

    fun login(
        timeoutSeconds: Long = DEFAULT_LOGIN_TIMEOUT_SECONDS,
        onSuccess: (result: LoginResult) -> Unit,
        onError: (message: String) -> Unit,
    ) {
        // Shut down any previous server
        shutdown()
        completed.set(false)

        try {
            val httpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
            val executor = Executors.newSingleThreadExecutor()
            httpServer.executor = executor
            server = httpServer
            serverExecutor = executor

            val port = httpServer.address.port
            val jolliUrl = JolliUrlConfig.getJolliUrl()
            val stateBytes = ByteArray(16)
            SecureRandom().nextBytes(stateBytes)
            val state = stateBytes.joinToString("") { "%02x".format(it) }
            val callbackUrl = "http://localhost:$port/callback?state=$state"
            val encodedCallback = java.net.URLEncoder.encode(callbackUrl, Charsets.UTF_8)
            val loginUrl = "$jolliUrl/login?cli_callback=$encodedCallback" +
                "&generate_api_key=true&client=intellij"
            log.info("Login URL: %s", loginUrl)

            httpServer.createContext("/callback") { exchange ->
                if (!completed.compareAndSet(false, true)) {
                    try { sendHtml(exchange, errorHtml("Login already timed out — please try again."), 408) } catch (_: Exception) {}
                    return@createContext
                }
                try {
                    val query = exchange.requestURI.query ?: ""
                    val params = parseQuery(query)
                    log.info("Callback received — state expected=%s, received=%s", state, params["state"])

                    val returnedState = params["state"]
                    if (returnedState != state) {
                        val html = errorHtml("Invalid login state — possible CSRF attack. Please try again.")
                        sendHtml(exchange, html, 403)
                        onError("Invalid login state. Please try again.")
                        shutdown()
                        return@createContext
                    }

                    val error = params["error"]
                    if (error != null) {
                        val message = getErrorMessage(error)
                        val html = errorHtml(message)
                        sendHtml(exchange, html, 400)
                        onError(message)
                    } else {
                        val code = params["code"]
                        val legacyToken = params["token"]

                        val result: LoginResult = if (!code.isNullOrBlank()) {
                            // JOLLI-1270 code-exchange (preferred)
                            try {
                                exchangeCode(jolliUrl, code)
                            } catch (e: Exception) {
                                val msg = e.message ?: "Code exchange failed"
                                sendHtml(exchange, errorHtml(msg), 400)
                                onError(msg)
                                shutdown()
                                return@createContext
                            }
                        } else if (!legacyToken.isNullOrBlank()) {
                            // Legacy token-in-URL fallback for pre-1270 servers
                            log.warn("Using legacy token-in-URL callback — server has not been upgraded to code-exchange (JOLLI-1270).")
                            LoginResult(
                                token = legacyToken,
                                space = params["space"],
                                jolliApiKey = params["jolli_api_key"],
                            )
                        } else {
                            val msg = "No authorization code or token received from server."
                            sendHtml(exchange, errorHtml(msg), 400)
                            onError(msg)
                            shutdown()
                            return@createContext
                        }

                        val globalDir = SessionTracker.getGlobalConfigDir()
                        val existing = SessionTracker.loadConfigFromDir(globalDir)
                        SessionTracker.saveConfigToDir(existing.copy(
                            authToken = result.token,
                            jolliApiKey = if (!result.jolliApiKey.isNullOrBlank()) result.jolliApiKey else existing.jolliApiKey,
                        ), globalDir)
                        if (!result.space.isNullOrBlank()) {
                            JolliConfigStore.saveSpace(result.space)
                        }

                        val html = successHtml()
                        sendHtml(exchange, html, 200)
                        notifyAuthListeners()
                        onSuccess(result)
                    }
                } catch (e: Exception) {
                    log.warn("Callback error: ${e.message}")
                    try {
                        sendHtml(exchange, errorHtml("Unexpected error: ${e.message}"), 500)
                    } catch (_: Exception) { }
                    onError("Callback error: ${e.message}")
                } finally {
                    shutdown()
                }
            }

            httpServer.start()
            log.info("OAuth callback server started on port $port")

            timeoutTask = timeoutExecutor.schedule({
                if (completed.compareAndSet(false, true)) {
                    log.info("Login timed out after ${timeoutSeconds}s")
                    shutdown()
                    onError("Login timed out — please try again.")
                }
            }, timeoutSeconds, TimeUnit.SECONDS)

            BrowserUtil.browse(loginUrl)
        } catch (e: Exception) {
            log.warn("Failed to start OAuth flow: ${e.message}")
            shutdown()
            onError("Failed to start login: ${e.message}")
        }
    }

    fun signOut() {
        val globalDir = SessionTracker.getGlobalConfigDir()
        val existing = SessionTracker.loadConfigFromDir(globalDir)
        SessionTracker.saveConfigToDir(existing.copy(authToken = null), globalDir)
        notifyAuthListeners()
    }

    private fun shutdown() {
        timeoutTask?.cancel(false)
        timeoutTask = null
        server?.stop(1)
        server = null
        serverExecutor?.shutdownNow()
        serverExecutor = null
    }

    internal fun parseQuery(query: String): Map<String, String> {
        if (query.isBlank()) return emptyMap()
        return query.split("&").associate { param ->
            val parts = param.split("=", limit = 2)
            val key = java.net.URLDecoder.decode(parts[0], Charsets.UTF_8)
            val value = if (parts.size > 1) java.net.URLDecoder.decode(parts[1], Charsets.UTF_8) else ""
            key to value
        }
    }

    /**
     * Exchanges a single-use authorization code for credentials via POST to
     * `/api/auth/cli-exchange`. Mirrors the CLI's `exchangeCliCode()`.
     */
    internal fun exchangeCode(jolliUrl: String, code: String): LoginResult {
        val parsed = URI.create(jolliUrl)
        val origin = "${parsed.scheme}://${parsed.authority}"
        val tenantSlug = parsed.path.split('/').firstOrNull { it.isNotEmpty() }

        val exchangeUrl = "$origin/api/auth/cli-exchange"
        val requestBody = Gson().toJson(mapOf("code" to code))
        val requestBuilder = HttpRequest.newBuilder()
            .uri(URI.create(exchangeUrl))
            .header("content-type", "application/json")
            .timeout(Duration.ofSeconds(20))
            .POST(HttpRequest.BodyPublishers.ofString(requestBody))

        if (tenantSlug != null) {
            requestBuilder.header("x-tenant-slug", tenantSlug)
        }

        val response: HttpResponse<String>
        try {
            response = HttpClient.newHttpClient()
                .send(requestBuilder.build(), HttpResponse.BodyHandlers.ofString())
        } catch (e: Exception) {
            throw RuntimeException("Couldn't reach Jolli to complete sign-in: ${e.message}")
        }

        if (response.statusCode() == 404) {
            throw RuntimeException("Sign-in code expired or already used. Please try signing in again.")
        }
        if (response.statusCode() !in 200..299) {
            throw RuntimeException("Sign-in failed (HTTP ${response.statusCode()}).")
        }

        val payload: JsonObject
        try {
            payload = Gson().fromJson(response.body(), JsonObject::class.java)
        } catch (e: Exception) {
            throw RuntimeException("Sign-in failed: server returned malformed response (${e.message}).")
        }

        val token = payload.get("token")?.takeIf { it.isJsonPrimitive }?.asString
        if (token.isNullOrBlank()) {
            throw RuntimeException("Sign-in failed: server response did not include a token.")
        }

        val jolliApiKey = payload.get("jolliApiKey")?.takeIf { it.isJsonPrimitive }?.asString
        val space = payload.get("space")?.takeIf { it.isJsonPrimitive }?.asString

        return LoginResult(token = token, space = space, jolliApiKey = jolliApiKey)
    }

    internal fun getErrorMessage(code: String): String = when (code) {
        "access_denied" -> "Access was denied. Please try again."
        "invalid_request" -> "Invalid login request. Please try again."
        "server_error" -> "Server error during login. Please try again later."
        "temporarily_unavailable" -> "Service temporarily unavailable. Please try again later."
        "oauth_failed" -> "OAuth authentication failed. Please try again."
        "session_missing" -> "Session expired or missing. Please try again."
        "invalid_provider" -> "Invalid authentication provider."
        "auth_fetch_failed" -> "Failed to fetch user information from the authentication provider."
        "no_verified_emails" -> "No verified email addresses found on your account."
        "failed_to_get_token" -> "We couldn't retrieve your credentials. Please try signing in again."
        "user_denied" -> "Sign-in was cancelled. You can try again from Settings."
        "invalid_callback" -> "The sign-in callback was rejected by the server. Please try again."
        else -> "Login failed: $code"
    }

    private fun sendHtml(exchange: com.sun.net.httpserver.HttpExchange, html: String, statusCode: Int) {
        val bytes = html.toByteArray(Charsets.UTF_8)
        exchange.responseHeaders.add("Content-Type", "text/html; charset=utf-8")
        exchange.sendResponseHeaders(statusCode, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    private fun successHtml(): String = """
        <!DOCTYPE html>
        <html><head><title>Jolli - Signed In</title>
        <style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f8f9fa}
        .card{text-align:center;padding:2rem;border-radius:12px;background:white;box-shadow:0 2px 8px rgba(0,0,0,.1)}
        h1{color:#22c55e;margin-bottom:.5rem}p{color:#6b7280}</style></head>
        <body><div class="card"><h1>&#10003; Signed In</h1><p>You can close this tab and return to your IDE.</p></div></body></html>
    """.trimIndent()

    private fun errorHtml(message: String): String = """
        <!DOCTYPE html>
        <html><head><title>Jolli - Login Failed</title>
        <style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f8f9fa}
        .card{text-align:center;padding:2rem;border-radius:12px;background:white;box-shadow:0 2px 8px rgba(0,0,0,.1)}
        h1{color:#ef4444;margin-bottom:.5rem}p{color:#6b7280}</style></head>
        <body><div class="card"><h1>&#10007; Login Failed</h1><p>${message.replace("<", "&lt;").replace(">", "&gt;")}</p></div></body></html>
    """.trimIndent()
}

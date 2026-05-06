package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.auth.JolliConfigStore
import ai.jolli.jollimemory.core.JmLogger
import com.google.gson.Gson
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.Base64

/**
 * JolliApiClient — Kotlin port of JolliPushService.ts
 *
 * HTTP client for pushing JolliMemory commit summaries to a Jolli Space.
 * Authenticates via API key (Bearer token) and posts Markdown content
 * to the `/api/push/jollimemory` endpoint.
 *
 * Handles two URL patterns for multi-tenant support:
 * - Path-based (dev): "http://localhost:3000/acme/" -> x-tenant-slug header
 * - Subdomain-based (prod): "https://test1.jolli.ai" -> subdomain resolved by backend
 *
 * Sends `x-jolli-client: intellij-plugin/<version>` on every request so the
 * server can identify the caller and apply the IntelliJ-specific minimum
 * version gate. The version is read once from the classpath resource
 * `/jollimemory-plugin-version.txt`, which `processResources` populates at
 * build time from `project.version` in build.gradle.kts. Keeping the lookup
 * inside this client preserves its "pure HTTP, no IntelliJ Platform deps"
 * shape — the same posture as the VS Code TypeScript port.
 */
object JolliApiClient {

    private val log = JmLogger.create("JolliApiClient")
    private val gson = Gson()
    private val client: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(30))
        .build()

    private const val VERSION_RESOURCE_PATH = "/jollimemory-plugin-version.txt"

    /**
     * Last-resort version sent if the classpath resource is missing. `0.0.0`
     * is intentional: it will fail any server-side minimum-version gate and
     * surface a build/packaging mistake loudly instead of silently shipping a
     * misleading version string.
     */
    private const val FALLBACK_PLUGIN_VERSION = "0.0.0"

    /**
     * IntelliJ plugin version sent in the `x-jolli-client` header. Resolved
     * once on first use from the classpath resource baked in by
     * `processResources` (see build.gradle.kts).
     */
    internal val pluginVersion: String by lazy { loadPluginVersion() }

    private fun loadPluginVersion(): String {
        val raw = try {
            javaClass.getResourceAsStream(VERSION_RESOURCE_PATH)
                ?.bufferedReader(Charsets.UTF_8)
                ?.use { it.readText() }
        } catch (e: Exception) {
            log.warn("Failed to read plugin version resource: ${e.message}")
            null
        }
        val trimmed = raw?.trim().orEmpty()
        if (trimmed.isEmpty()) {
            log.warn("Plugin version resource missing or empty at $VERSION_RESOURCE_PATH; using fallback $FALLBACK_PLUGIN_VERSION")
            return FALLBACK_PLUGIN_VERSION
        }
        return trimmed
    }

    /** Payload sent to the Jolli push endpoint. */
    data class JolliPushPayload(
        val title: String,
        val content: String,
        val commitHash: String,
        val branch: String? = null,
        val subFolder: String? = null,
        val docId: Int? = null,
    )

    /** Response from a successful push. */
    data class JolliPushResult(
        val url: String,
        val docId: Int,
        val jrn: String,
        val created: Boolean,
    )

    /**
     * Metadata embedded in a new-format Jolli API key.
     * - t: tenant slug (used as x-tenant-slug header for path-based tenants)
     * - u: full base URL (e.g., "https://acme.jolli.ai" or "https://jolli.ai/acme")
     * - o: org slug (used as x-org-slug header for multi-org routing; absent in old keys)
     */
    data class JolliApiKeyMeta(
        val t: String,
        val u: String,
        val o: String? = null,
    )

    /** Thrown when the server rejects the request due to outdated plugin version (HTTP 426). */
    class PluginOutdatedError(message: String) : RuntimeException(message)

    /**
     * Parsed base URL with optional tenant slug extracted from the path.
     *
     * Path-based: "http://localhost:3000/acme/" -> origin "http://localhost:3000", tenantSlug "acme"
     * Subdomain:  "https://test1.jolli.ai"      -> origin "https://test1.jolli.ai", tenantSlug null
     */
    private data class ParsedBaseUrl(
        val origin: String,
        val tenantSlug: String?,
    )

    /**
     * Parses the tenant metadata embedded in a new-format Jolli API key.
     *
     * New format: sk-jol-{base64url(JSON meta)}.{base64url(32 random bytes)}
     * Old format: sk-jol-{32 hex chars} -- returns null
     *
     * @param key Jolli API key string
     * @return Parsed metadata, or null if the key uses the old format or cannot be decoded
     */
    fun parseJolliApiKey(key: String): JolliApiKeyMeta? {
        if (!key.startsWith("sk-jol-")) return null

        val rest = key.substring("sk-jol-".length)
        val dotIndex = rest.indexOf('.')
        if (dotIndex == -1) return null

        return try {
            // Base64 URL decode the metadata portion
            val metaPart = rest.substring(0, dotIndex)
            val decoder = Base64.getUrlDecoder()
            val metaJson = String(decoder.decode(metaPart), Charsets.UTF_8)

            @Suppress("UNCHECKED_CAST")
            val meta = gson.fromJson(metaJson, Map::class.java) as Map<String, Any?>
            val t = meta["t"] as? String ?: return null
            val u = meta["u"] as? String ?: return null
            val o = meta["o"] as? String

            JolliApiKeyMeta(t = t, u = u, o = o)
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Pushes a commit summary to a Jolli Space via the push API.
     *
     * @param baseUrl Jolli site base URL. If null, falls back to the URL embedded in the API key.
     * @param apiKey Jolli API key (sk-jol-...)
     * @param payload Summary content to push
     * @return Push result with article URL and metadata
     * @throws RuntimeException if the push fails (network error, non-2xx response, or missing base URL)
     * @throws PluginOutdatedError if the server returns HTTP 426
     */
    fun pushToJolli(
        baseUrl: String?,
        apiKey: String,
        payload: JolliPushPayload,
    ): JolliPushResult {
        val keyMeta = parseJolliApiKey(apiKey)
        val resolvedBaseUrl = baseUrl ?: keyMeta?.u
            ?: throw RuntimeException(
                "Jolli site URL could not be determined. " +
                    "Please regenerate your Jolli API Key and set it again (STATUS panel)."
            )

        val parsed = parseBaseUrl(resolvedBaseUrl)
        val targetUri = URI.create("${parsed.origin}/api/push/jollimemory")

        val body = gson.toJson(payload)
        val requestBuilder = HttpRequest.newBuilder()
            .uri(targetUri)
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer $apiKey")
            .header("x-jolli-client", "intellij-plugin/$pluginVersion")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .timeout(Duration.ofSeconds(60))

        // For path-based multi-tenancy, send the tenant slug as a header
        if (parsed.tenantSlug != null) {
            requestBuilder.header("x-tenant-slug", parsed.tenantSlug)
        }

        // Send org slug so TenantMiddleware routes to the correct org schema
        if (keyMeta?.o != null) {
            requestBuilder.header("x-org-slug", keyMeta.o)
        }

        val response = client.send(requestBuilder.build(), HttpResponse.BodyHandlers.ofString())
        val raw = response.body() ?: ""
        val statusCode = response.statusCode()

        return parseResponse(raw, statusCode)
    }

    /**
     * Deletes an orphaned JolliMemory article from the server.
     * Used to clean up articles from squashed/rebased commits.
     */
    fun deleteFromJolli(baseUrl: String?, apiKey: String, docId: Int) {
        val keyMeta = parseJolliApiKey(apiKey)
        val resolvedBaseUrl = baseUrl ?: keyMeta?.u
            ?: throw RuntimeException("Jolli site URL could not be determined.")

        val parsed = parseBaseUrl(resolvedBaseUrl)
        val targetUri = URI.create("${parsed.origin}/api/push/jollimemory/$docId")

        val requestBuilder = HttpRequest.newBuilder()
            .uri(targetUri)
            .header("Authorization", "Bearer $apiKey")
            .header("x-jolli-client", "intellij-plugin/$pluginVersion")
            .DELETE()
            .timeout(Duration.ofSeconds(30))

        if (parsed.tenantSlug != null) {
            requestBuilder.header("x-tenant-slug", parsed.tenantSlug)
        }
        if (keyMeta?.o != null) {
            requestBuilder.header("x-org-slug", keyMeta.o)
        }

        val response = client.send(requestBuilder.build(), HttpResponse.BodyHandlers.ofString())
        val statusCode = response.statusCode()

        if (statusCode != 200 && statusCode != 204) {
            throw RuntimeException("Delete failed with status $statusCode")
        }
    }

    /**
     * Resolves the effective bearer token for Jolli API calls.
     * Priority: explicit Jolli API key > OAuth auth token from ~/.jolli/jollimemory/config.json.
     */
    fun resolveToken(jolliApiKey: String?): String? {
        if (!jolliApiKey.isNullOrBlank()) return jolliApiKey
        return JolliConfigStore.loadAuthToken()
    }

    // ── LLM Proxy ─────────────────────────────────────────────────────────

    /** Response from the LLM proxy endpoint. */
    data class LlmProxyResult(
        val text: String?,
        val inputTokens: Int,
        val outputTokens: Int,
    )

    /** Payload sent to the LLM proxy endpoint. */
    private data class LlmProxyPayload(
        val action: String,
        val params: Map<String, String>,
    )

    /**
     * Calls the Jolli LLM proxy endpoint.
     * The backend owns the prompt template — we just send the action key and params.
     */
    fun callLlmProxy(apiKey: String, action: String, params: Map<String, String>): LlmProxyResult {
        val keyMeta = parseJolliApiKey(apiKey)
        val resolvedBaseUrl = keyMeta?.u
            ?: throw RuntimeException(
                "Jolli site URL could not be determined from API key. " +
                    "Please regenerate your Jolli API Key."
            )

        val parsed = parseBaseUrl(resolvedBaseUrl)
        val targetUri = URI.create("${parsed.origin}/api/push/llm/complete")

        val body = gson.toJson(LlmProxyPayload(action, params))
        val requestBuilder = HttpRequest.newBuilder()
            .uri(targetUri)
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer $apiKey")
            .header("x-jolli-client", "intellij-plugin/$pluginVersion")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .timeout(Duration.ofSeconds(120))

        if (parsed.tenantSlug != null) {
            requestBuilder.header("x-tenant-slug", parsed.tenantSlug)
        }
        if (keyMeta.o != null) {
            requestBuilder.header("x-org-slug", keyMeta.o)
        }

        val response = client.send(requestBuilder.build(), HttpResponse.BodyHandlers.ofString())
        val raw = response.body() ?: ""
        val statusCode = response.statusCode()

        if (statusCode !in 200..299) {
            log.warn("LLM proxy error %d: %s", statusCode, raw.take(500))
            throw RuntimeException("LLM proxy error (HTTP $statusCode): ${raw.take(200)}")
        }

        return try {
            @Suppress("UNCHECKED_CAST")
            val json = gson.fromJson(raw, Map::class.java) as Map<String, Any?>
            LlmProxyResult(
                text = json["text"] as? String,
                inputTokens = (json["inputTokens"] as? Double)?.toInt() ?: 0,
                outputTokens = (json["outputTokens"] as? Double)?.toInt() ?: 0,
            )
        } catch (_: Exception) {
            throw RuntimeException("Invalid JSON from LLM proxy (HTTP $statusCode): ${raw.take(200)}")
        }
    }

    // ── Internal helpers ────────────────────────────────────────────────────

    /**
     * Extracts the origin and optional tenant slug from a Jolli base URL.
     * If the URL has a non-empty path (e.g. "/test1/"), the first segment is the tenant slug.
     */
    private fun parseBaseUrl(baseUrl: String): ParsedBaseUrl {
        val uri = URI.create(baseUrl)
        val pathSegments = (uri.path ?: "")
            .trim('/')
            .split("/")
            .filter { it.isNotEmpty() }

        val origin = "${uri.scheme}://${uri.authority}"
        val tenantSlug = pathSegments.firstOrNull()

        return ParsedBaseUrl(origin = origin, tenantSlug = tenantSlug)
    }

    /** Parses a push response, handling errors and status codes. */
    private fun parseResponse(raw: String, statusCode: Int): JolliPushResult {
        return try {
            @Suppress("UNCHECKED_CAST")
            val json = gson.fromJson(raw, Map::class.java) as Map<String, Any?>

            if (statusCode in 200..299) {
                JolliPushResult(
                    url = json["url"] as? String ?: "",
                    docId = (json["docId"] as? Double)?.toInt() ?: 0,
                    jrn = json["jrn"] as? String ?: "",
                    created = json["created"] as? Boolean ?: false,
                )
            } else if (statusCode == 426) {
                throw PluginOutdatedError(
                    json["message"] as? String
                        ?: "Plugin version is outdated. Please update to the latest version."
                )
            } else {
                throw RuntimeException(
                    json["error"] as? String ?: "HTTP $statusCode"
                )
            }
        } catch (e: PluginOutdatedError) {
            throw e
        } catch (e: RuntimeException) {
            throw e
        } catch (_: Exception) {
            throw RuntimeException("Invalid JSON response (HTTP $statusCode): ${raw.take(200)}")
        }
    }
}

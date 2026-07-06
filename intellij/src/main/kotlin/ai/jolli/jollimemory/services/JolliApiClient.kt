package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.auth.JolliConfigStore
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.TraceContext
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
        val docType: String,
        val branch: String? = null,
        val docId: Int? = null,
        val repoUrl: String? = null,
        val relativePath: String? = null,
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

    /** Thrown when the server rejects the API key (HTTP 401/403) — invalid/disabled/wrong org. */
    class UnauthorizedError(message: String) : RuntimeException(message)

    /** Thrown when the server returns 412 because the repo has no space binding yet. */
    class BindingRequiredError(
        val repoUrl: String,
        message: String = "This repo is not bound to a Memory space yet.",
    ) : RuntimeException(message)

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
        // Old format `sk-jol-<32 hex chars>` has no embedded meta.
        if (!rest.contains(".")) return null

        // Scan EVERY dot-separated segment (not just the first) and return the first
        // that base64url-decodes to JSON carrying string `t` + `u`. This handles both
        // Format A (`sk-jol-<metaB64>.<secretB64>`, meta in segment 0) and Format B /
        // JWT-shaped (`sk-jol-<headerB64>.<payloadB64>.<sigB64>`, meta in segment 1).
        // Must stay in lockstep with the canonical parser in
        // cli/src/core/JolliApiUtils.ts (and the VS Code bundle).
        val decoder = Base64.getUrlDecoder()
        for (segment in rest.split(".")) {
            try {
                val metaJson = String(decoder.decode(segment), Charsets.UTF_8)
                @Suppress("UNCHECKED_CAST")
                val meta = gson.fromJson(metaJson, Map::class.java) as? Map<String, Any?> ?: continue
                val t = meta["t"] as? String ?: continue
                val u = meta["u"] as? String ?: continue
                val o = meta["o"] as? String
                return JolliApiKeyMeta(t = t, u = u, o = o)
            } catch (_: Exception) {
                // Segment isn't valid base64url JSON — try the next one.
            }
        }
        return null
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

        // Jolli trace context: carry the ambient operation's id (set by the
        // withTrace scope around the action) so this request shares one id with
        // the operation's log lines; fall back to a fresh value outside any scope.
        requestBuilder.header(TraceContext.HEADER_NAME, TraceContext.currentTraceHeader() ?: TraceContext.newTraceHeader())

        val response = client.send(requestBuilder.build(), HttpResponse.BodyHandlers.ofString())
        val raw = response.body() ?: ""
        val statusCode = response.statusCode()

        return parseResponse(raw, statusCode, payload.repoUrl)
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

        // Jolli trace context: carry the ambient operation's id (set by the
        // withTrace scope around the action) so this request shares one id with
        // the operation's log lines; fall back to a fresh value outside any scope.
        requestBuilder.header(TraceContext.HEADER_NAME, TraceContext.currentTraceHeader() ?: TraceContext.newTraceHeader())

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

        // Jolli trace context: carry the ambient operation's id (set by the
        // withTrace scope around the action) so this request shares one id with
        // the operation's log lines; fall back to a fresh value outside any scope.
        requestBuilder.header(TraceContext.HEADER_NAME, TraceContext.currentTraceHeader() ?: TraceContext.newTraceHeader())

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

    // ── JM Space Binding endpoints (JOLLI-1335) ──────────────────────────

    /** Result of GET /api/jolli-memory/spaces. */
    data class JmSpacesListResult(
        val spaces: List<ai.jolli.jollimemory.toolwindow.JmSpaceSummary>,
        val defaultSpaceId: Int?,
    )

    /**
     * GET /api/jolli-memory/spaces
     *
     * Lists existing JolliMemory spaces visible to the authenticated user.
     * Accepts both a flat array body and a `{ spaces, defaultSpaceId }` envelope
     * from the server (the flat form yields `defaultSpaceId = null`).
     */
    fun listSpaces(baseUrl: String, apiKey: String): JmSpacesListResult {
        val keyMeta = parseJolliApiKey(apiKey)
        val parsed = parseBaseUrl(baseUrl)
        val targetUri = URI.create("${parsed.origin}/api/jolli-memory/spaces")

        val requestBuilder = HttpRequest.newBuilder()
            .uri(targetUri)
            .header("Authorization", "Bearer $apiKey")
            .header("x-jolli-client", "intellij-plugin/$pluginVersion")
            .GET()
            .timeout(Duration.ofSeconds(30))

        if (parsed.tenantSlug != null) {
            requestBuilder.header("x-tenant-slug", parsed.tenantSlug)
        }
        if (keyMeta?.o != null) {
            requestBuilder.header("x-org-slug", keyMeta.o)
        }

        // Jolli trace context: carry the ambient operation's id (set by the
        // withTrace scope around the action) so this request shares one id with
        // the operation's log lines; fall back to a fresh value outside any scope.
        requestBuilder.header(TraceContext.HEADER_NAME, TraceContext.currentTraceHeader() ?: TraceContext.newTraceHeader())

        val response = client.send(requestBuilder.build(), HttpResponse.BodyHandlers.ofString())
        val raw = response.body() ?: ""
        val statusCode = response.statusCode()

        if (statusCode == 426) {
            throw PluginOutdatedError("Plugin version is outdated. Please update to the latest version.")
        }
        if (statusCode !in 200..299) {
            throw RuntimeException("Failed to list spaces (HTTP $statusCode): ${raw.take(200)}")
        }

        return try {
            val element = gson.fromJson(raw, com.google.gson.JsonElement::class.java)
            if (element.isJsonArray) {
                val spaces = element.asJsonArray.map { el ->
                    val obj = el.asJsonObject
                    ai.jolli.jollimemory.toolwindow.JmSpaceSummary(
                        id = obj.get("id").asInt,
                        name = obj.get("name").asString,
                        slug = obj.get("slug").asString,
                    )
                }
                JmSpacesListResult(spaces, defaultSpaceId = null)
            } else {
                val obj = element.asJsonObject
                val spacesArr = obj.getAsJsonArray("spaces") ?: com.google.gson.JsonArray()
                val spaces = spacesArr.map { el ->
                    val s = el.asJsonObject
                    ai.jolli.jollimemory.toolwindow.JmSpaceSummary(
                        id = s.get("id").asInt,
                        name = s.get("name").asString,
                        slug = s.get("slug").asString,
                    )
                }
                val defaultId = obj.get("defaultSpaceId")?.takeIf { it.isJsonPrimitive }?.asInt
                JmSpacesListResult(spaces, defaultSpaceId = defaultId)
            }
        } catch (_: Exception) {
            throw RuntimeException("Invalid JSON from list-spaces (HTTP $statusCode): ${raw.take(200)}")
        }
    }

    /**
     * POST /api/jolli-memory/bindings
     *
     * Binds a repo to a JM space. On success returns the binding info.
     * Throws [ai.jolli.jollimemory.toolwindow.BindingAlreadyExistsException]
     * on 409 when another user already bound the same repo (race condition).
     */
    fun createBinding(
        baseUrl: String,
        apiKey: String,
        repoUrl: String,
        repoName: String,
        jmSpaceId: Int,
    ): ai.jolli.jollimemory.toolwindow.BindingChooserResult {
        val keyMeta = parseJolliApiKey(apiKey)
        val parsed = parseBaseUrl(baseUrl)
        val targetUri = URI.create("${parsed.origin}/api/jolli-memory/bindings")

        val body = gson.toJson(mapOf(
            "repoUrl" to repoUrl,
            "repoName" to repoName,
            "jmSpaceId" to jmSpaceId,
        ))

        val requestBuilder = HttpRequest.newBuilder()
            .uri(targetUri)
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer $apiKey")
            .header("x-jolli-client", "intellij-plugin/$pluginVersion")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .timeout(Duration.ofSeconds(30))

        if (parsed.tenantSlug != null) {
            requestBuilder.header("x-tenant-slug", parsed.tenantSlug)
        }
        if (keyMeta?.o != null) {
            requestBuilder.header("x-org-slug", keyMeta.o)
        }

        // Jolli trace context: carry the ambient operation's id (set by the
        // withTrace scope around the action) so this request shares one id with
        // the operation's log lines; fall back to a fresh value outside any scope.
        requestBuilder.header(TraceContext.HEADER_NAME, TraceContext.currentTraceHeader() ?: TraceContext.newTraceHeader())

        val response = client.send(requestBuilder.build(), HttpResponse.BodyHandlers.ofString())
        val raw = response.body() ?: ""
        val statusCode = response.statusCode()

        if (statusCode == 426) {
            throw PluginOutdatedError("Plugin version is outdated. Please update to the latest version.")
        }

        return try {
            @Suppress("UNCHECKED_CAST")
            val json = gson.fromJson(raw, Map::class.java) as Map<String, Any?>

            if (statusCode == 409 && json["error"] == "binding_already_exists") {
                throw ai.jolli.jollimemory.toolwindow.BindingAlreadyExistsException(
                    ai.jolli.jollimemory.toolwindow.BindingChooserResult(
                        id = (json["id"] as? Double)?.toInt() ?: 0,
                        jmSpaceId = (json["jmSpaceId"] as? Double)?.toInt() ?: 0,
                        jmSpaceName = json["jmSpaceName"] as? String ?: "",
                        repoName = json["repoName"] as? String ?: "",
                    ),
                )
            }

            if (statusCode !in 200..299) {
                throw RuntimeException(json["error"] as? String ?: "HTTP $statusCode")
            }

            ai.jolli.jollimemory.toolwindow.BindingChooserResult(
                id = (json["id"] as? Double)?.toInt() ?: 0,
                jmSpaceId = (json["jmSpaceId"] as? Double)?.toInt() ?: 0,
                jmSpaceName = json["jmSpaceName"] as? String ?: "",
                repoName = json["repoName"] as? String ?: "",
            )
        } catch (e: ai.jolli.jollimemory.toolwindow.BindingAlreadyExistsException) {
            throw e
        } catch (e: PluginOutdatedError) {
            throw e
        } catch (e: RuntimeException) {
            throw e
        } catch (_: Exception) {
            throw RuntimeException("Invalid JSON from create-binding (HTTP $statusCode): ${raw.take(200)}")
        }
    }

    // ── Branch share (live, Space-backed) endpoints ─────────────────────────
    // Kotlin port of vscode/src/services/JolliShareService.ts (live-share ops).
    // These target /api/share/branch and reference live Space docs (a `covered`
    // allowlist via LiveRef) instead of a frozen content blob. Auth is the same
    // Bearer + x-jolli-client + x-tenant-slug/x-org-slug + trace scheme as push.

    /** Thrown when a share has been revoked or expired (HTTP 410 / `revoked: true`). */
    class ShareRevokedError(message: String = "This share has been stopped.") : RuntimeException(message)

    /** Body posted to create a live share. No `content` blob — references live docs via [ref]. */
    data class LiveSharePayload(
        val repoUrl: String,
        val repoName: String,
        val branch: String,
        /** "branch" | "commit" */
        val kind: String,
        /** "public" | "org" | "people" */
        val visibility: String,
        val decisionCount: Int,
        /** Still sent: backs the NOT-NULL columns + the server's idempotency indexes. */
        val headCommitHash: String,
        val commitHashes: List<String>,
        /** Display slug — distinct from the push folder identity in [ref]. */
        val branchSlug: String? = null,
        val ref: ai.jolli.jollimemory.core.BranchShareStore.LiveRef,
        /** `people` access allowlist (lowercased emails). Omit for public/org. */
        val recipients: List<String>? = null,
    )

    /** Response from creating a live share. `token` is absent for `org`/`people` shares. */
    data class LiveShareResult(
        val shareId: String,
        val shareUrl: String,
        val expiresAt: String,
        /** "public" | "org" | "people" */
        val visibility: String,
        val token: String? = null,
        /** Server-confirmed `people` allowlist (echoed back). */
        val recipients: List<String>? = null,
    )

    /** Patch for a live share update — any subset may be sent; server echoes only changed fields. */
    data class LiveSharePatch(
        val visibility: String? = null,
        val expiresAt: String? = null,
        val ref: ai.jolli.jollimemory.core.BranchShareStore.LiveRef? = null,
        val recipients: List<String>? = null,
    )

    /** Partial result from a live-share PATCH — any field may be absent (link unchanged, etc.). */
    data class LiveShareUpdateResult(
        val shareId: String? = null,
        val shareUrl: String? = null,
        val expiresAt: String? = null,
        val visibility: String? = null,
        val token: String? = null,
        val recipients: List<String>? = null,
    )

    /** Response from a successful expiry update (PATCH). */
    data class ShareExpiryResult(
        val shareId: String,
        val expiresAt: String,
    )

    /** An org member offered as a recipient candidate (name + deliverable email). */
    data class OrgMember(val name: String, val email: String)

    private fun resolveShareBaseUrl(baseUrl: String?, apiKey: String): String {
        return baseUrl ?: parseJolliApiKey(apiKey)?.u
            ?: throw RuntimeException(
                "Jolli site URL could not be determined. " +
                    "Please regenerate your Jolli API Key and set it again (STATUS panel)."
            )
    }

    /** Sends an authed request to a Jolli API path; centralizes the header + send boilerplate. */
    private fun sendAuthed(
        method: String,
        resolvedBaseUrl: String,
        apiKey: String,
        path: String,
        body: String?,
        timeoutSec: Long = 60,
    ): HttpResponse<String> {
        val keyMeta = parseJolliApiKey(apiKey)
        val parsed = parseBaseUrl(resolvedBaseUrl)
        val targetUri = URI.create("${parsed.origin}$path")
        val builder = HttpRequest.newBuilder()
            .uri(targetUri)
            .header("Authorization", "Bearer $apiKey")
            .header("x-jolli-client", "intellij-plugin/$pluginVersion")
            .timeout(Duration.ofSeconds(timeoutSec))
        if (body != null) builder.header("Content-Type", "application/json")
        when (method) {
            "POST" -> builder.POST(HttpRequest.BodyPublishers.ofString(body ?: ""))
            "PATCH" -> builder.method("PATCH", HttpRequest.BodyPublishers.ofString(body ?: ""))
            "DELETE" -> builder.DELETE()
            else -> builder.GET()
        }
        if (parsed.tenantSlug != null) builder.header("x-tenant-slug", parsed.tenantSlug)
        if (keyMeta?.o != null) builder.header("x-org-slug", keyMeta.o)
        builder.header(TraceContext.HEADER_NAME, TraceContext.currentTraceHeader() ?: TraceContext.newTraceHeader())
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
    }

    /** Maps a non-2xx response to the right error (426 → outdated, else detail + status). */
    private fun shareError(status: Int, json: com.google.gson.JsonObject?, raw: String): RuntimeException {
        if (status == 426) {
            return PluginOutdatedError(
                json?.get("message")?.takeIf { it.isJsonPrimitive }?.asString
                    ?: "Plugin version is outdated. Please update to the latest version."
            )
        }
        val detail = listOfNotNull(
            json?.get("error")?.takeIf { it.isJsonPrimitive }?.asString,
            json?.get("message")?.takeIf { it.isJsonPrimitive }?.asString,
        ).joinToString(" — ")
        val suffix = if (json == null) ": ${raw.take(200)}" else ""
        return RuntimeException("${detail.ifEmpty { "request failed" }} (HTTP $status)$suffix")
    }

    private fun parseObjectOrNull(raw: String): com.google.gson.JsonObject? = try {
        if (raw.isEmpty()) null else gson.fromJson(raw, com.google.gson.JsonElement::class.java)
            ?.takeIf { it.isJsonObject }?.asJsonObject
    } catch (_: Exception) {
        null
    }

    private fun com.google.gson.JsonObject.str(key: String): String? =
        get(key)?.takeIf { it.isJsonPrimitive }?.asString

    private fun com.google.gson.JsonObject.stringList(key: String): List<String>? =
        get(key)?.takeIf { it.isJsonArray }?.asJsonArray
            ?.mapNotNull { it.takeIf { e -> e.isJsonPrimitive }?.asString }

    /** Creates a live share. Requires `shareId` + `shareUrl`; `token` only for `public`. */
    fun createLiveShare(baseUrl: String?, apiKey: String, payload: LiveSharePayload): LiveShareResult {
        val resolved = resolveShareBaseUrl(baseUrl, apiKey)
        val response = sendAuthed("POST", resolved, apiKey, "/api/share/branch", gson.toJson(payload))
        val raw = response.body() ?: ""
        val status = response.statusCode()
        val json = parseObjectOrNull(raw)
        if (status in 200..299) {
            val shareId = json?.get("shareId")?.takeIf { it.isJsonPrimitive }?.asString
            val shareUrl = json?.str("shareUrl")
            if (shareId == null || shareUrl == null) {
                throw RuntimeException(
                    "Share endpoint returned an unexpected response (missing shareId/shareUrl). HTTP $status: ${raw.take(300)}"
                )
            }
            return LiveShareResult(
                shareId = shareId,
                shareUrl = shareUrl,
                expiresAt = json.str("expiresAt") ?: "",
                visibility = json.str("visibility") ?: payload.visibility,
                token = json.str("token"),
                recipients = json.stringList("recipients"),
            )
        }
        throw shareError(status, json, raw)
    }

    /** Updates a live share (visibility / covered ref / expiry / recipients) via PATCH. */
    fun updateLiveShare(baseUrl: String?, apiKey: String, shareId: String, patch: LiveSharePatch): LiveShareUpdateResult {
        val resolved = resolveShareBaseUrl(baseUrl, apiKey)
        val path = "/api/share/branch/${java.net.URLEncoder.encode(shareId, Charsets.UTF_8)}"
        val response = sendAuthed("PATCH", resolved, apiKey, path, gson.toJson(patch))
        val raw = response.body() ?: ""
        val status = response.statusCode()
        val json = parseObjectOrNull(raw)
        // A recipients-only / non-`public`-toggle PATCH legitimately returns NO `shareUrl`
        // (the link didn't change), so accept any 2xx with a body — the caller falls back.
        if (status in 200..299 && json != null) {
            return LiveShareUpdateResult(
                shareId = json.get("shareId")?.takeIf { it.isJsonPrimitive }?.asString,
                shareUrl = json.str("shareUrl"),
                expiresAt = json.str("expiresAt"),
                visibility = json.str("visibility"),
                token = json.str("token"),
                recipients = json.stringList("recipients"),
            )
        }
        throw shareError(status, json, raw)
    }

    /** Revokes a live share by id. 404 = already gone → idempotent success. */
    fun revokeShare(baseUrl: String?, apiKey: String, shareId: String) {
        val resolved = resolveShareBaseUrl(baseUrl, apiKey)
        val path = "/api/share/branch/${java.net.URLEncoder.encode(shareId, Charsets.UTF_8)}"
        val response = sendAuthed("DELETE", resolved, apiKey, path, null, timeoutSec = 30)
        val status = response.statusCode()
        if (status != 200 && status != 204 && status != 404) {
            throw RuntimeException("Revoke failed with status $status")
        }
    }

    /**
     * Adjusts an existing share's expiry via `PATCH /api/share/branch/:shareId`.
     * `expiresAt` is an absolute ISO timestamp. Returns the server-confirmed value.
     */
    fun updateShareExpiry(baseUrl: String?, apiKey: String, shareId: String, expiresAt: String): ShareExpiryResult {
        val resolved = resolveShareBaseUrl(baseUrl, apiKey)
        val path = "/api/share/branch/${java.net.URLEncoder.encode(shareId, Charsets.UTF_8)}"
        val response = sendAuthed("PATCH", resolved, apiKey, path, gson.toJson(mapOf("expiresAt" to expiresAt)))
        val raw = response.body() ?: ""
        val status = response.statusCode()
        val json = parseObjectOrNull(raw)
        val confirmed = json?.str("expiresAt")
        if (status in 200..299 && confirmed != null) {
            return ShareExpiryResult(
                shareId = json.get("shareId")?.takeIf { it.isJsonPrimitive }?.asString ?: shareId,
                expiresAt = confirmed,
            )
        }
        throw shareError(status, json, raw)
    }

    /**
     * Lists active org members as recipient candidates (name + email), via
     * `GET /api/jolli-memory/org-members`. Best-effort: returns [] on any error.
     */
    fun listOrgMembers(baseUrl: String?, apiKey: String): List<OrgMember> {
        return try {
            val resolved = resolveShareBaseUrl(baseUrl, apiKey)
            val response = sendAuthed("GET", resolved, apiKey, "/api/jolli-memory/org-members", null, timeoutSec = 30)
            val status = response.statusCode()
            if (status !in 200..299) return emptyList()
            val json = parseObjectOrNull(response.body() ?: "") ?: return emptyList()
            val rows = json.get("members")?.takeIf { it.isJsonArray }?.asJsonArray ?: return emptyList()
            rows.mapNotNull { el ->
                val obj = el.takeIf { it.isJsonObject }?.asJsonObject ?: return@mapNotNull null
                val email = obj.str("email")?.trim().orEmpty()
                if (email.isEmpty()) null else OrgMember(name = obj.str("name") ?: "", email = email)
            }
        } catch (_: Exception) {
            emptyList()
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
    private fun parseResponse(raw: String, statusCode: Int, payloadRepoUrl: String? = null): JolliPushResult {
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
            } else if (statusCode == 412 && json["error"] == "binding_required") {
                throw BindingRequiredError(
                    repoUrl = json["repoUrl"] as? String ?: payloadRepoUrl ?: "",
                )
            } else if (statusCode == 426) {
                throw PluginOutdatedError(
                    json["message"] as? String
                        ?: "Plugin version is outdated. Please update to the latest version."
                )
            } else if (statusCode == 401 || statusCode == 403) {
                throw UnauthorizedError(
                    json["error"] as? String ?: "Invalid or disabled API key"
                )
            } else {
                throw RuntimeException(
                    json["error"] as? String ?: "HTTP $statusCode"
                )
            }
        } catch (e: BindingRequiredError) {
            throw e
        } catch (e: PluginOutdatedError) {
            throw e
        } catch (e: RuntimeException) {
            throw e
        } catch (_: Exception) {
            throw RuntimeException("Invalid JSON response (HTTP $statusCode): ${raw.take(200)}")
        }
    }
}

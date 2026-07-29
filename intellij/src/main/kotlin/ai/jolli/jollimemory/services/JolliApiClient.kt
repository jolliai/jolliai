package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.auth.JolliConfigStore
import ai.jolli.jollimemory.bridge.CliIntegrations
import ai.jolli.jollimemory.core.JmLogger
import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import java.util.Base64

/**
 * JolliApiClient — thin facade over the bundled CLI's `jolli ide-bridge` bridge.
 *
 * Historically this object was a full Kotlin HTTP client for the Jolli backend
 * (push / delete / list-spaces / bindings / live-share / org-members / LLM
 * proxy). Every backend call now dispatches through [CliIntegrations.runIdeBridge]
 * so the CLI is the single implementation of that HTTP contract; the same-named
 * DTOs are kept as pass-through data classes so existing UI callers and
 * MockK-based unit tests stay unchanged.
 *
 * [parseJolliApiKey] deliberately stays a pure-Kotlin port: it is called from
 * EDT paths (StatusPanel refresh, SettingsDialog, SummaryPanel pre-flight) and
 * making it a bridge subprocess call would drag those UI paths through a
 * ~5–20 ms daemon round-trip (or a ~500 ms–2 s cold Node spawn) each time.
 * The tradeoff is a three-way lockstep with `cli/src/core/JolliApiUtils.ts`
 * and the VS Code bundle — do not diverge without updating all three.
 *
 * The `pluginVersion` string and [serializeSummaryJson] are also Kotlin-side
 * utilities — none of them touches the network.
 */
object JolliApiClient {

    private val log = JmLogger.create("JolliApiClient")
    private val gson = Gson()

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

    /**
     * `x-jolli-client` header value the CLI should stamp on every jolli-api
     * request originated by this plugin. Without threading this through the
     * ide-bridge the CLI would send its own bundled-build header
     * (`cli/<cli-version>`), silently opting the plugin out of the server's
     * per-surface min-version gate + surface-aware behavior + surface-level
     * API attribution. Kept in lockstep with the shape enforced by
     * `cli/src/core/ClientHeader.ts`.
     */
    internal val intellijClientHeader: String by lazy { "intellij-plugin/$pluginVersion" }

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
        /**
         * Structured twin of [content] for `docType == "summary"` pushes: the enriched
         * summary JSON carrying the raw `conversationTokens` / breakdown the "Task usage"
         * markdown line renders, so the server receives exact numbers, not just prose.
         * Null (and omitted by Gson) for plan/note pushes or when the JSON exceeds the
         * server cap — see [serializeSummaryJson]. Mirrors the CLI/VS Code `summaryJson`
         * field (cli/src/core/JolliMemoryPushOrchestrator.ts).
         */
        val summaryJson: String? = null,
    )

    /**
     * Byte cap for the serialized summary JSON riding on a summary push. The server
     * rejects `summaryJson` above 2 MB; staying well under leaves headroom for the
     * markdown `content` sharing the same request body. Oversized JSON is simply
     * omitted — the markdown push must never fail on account of the sidecar. Matches
     * `MAX_SUMMARY_JSON_BYTES` in cli/src/core/JolliMemoryPushOrchestrator.ts.
     */
    private const val MAX_SUMMARY_JSON_BYTES = 1_572_864

    /**
     * Serializes a summary for the [JolliPushPayload.summaryJson] field: the enriched
     * summary (plan/note URLs woven in) minus the client push-state fields —
     * `jolliDocId` / `jolliDocUrl` churn per push and `orphanedDocIds` is cleanup
     * bookkeeping, none of which is commit content the share page should see. Returns
     * null above [MAX_SUMMARY_JSON_BYTES] (push markdown only). Byte-for-byte port of
     * the CLI `serializeSummaryJson`; keep in lockstep.
     */
    fun serializeSummaryJson(summary: ai.jolli.jollimemory.core.CommitSummary): String? {
        val stripped = summary.copy(jolliDocId = null, jolliDocUrl = null, orphanedDocIds = null)
        val json = gson.toJson(stripped)
        if (json.toByteArray(Charsets.UTF_8).size > MAX_SUMMARY_JSON_BYTES) {
            log.warn(
                "Summary JSON for ${summary.commitHash.take(8)} exceeds $MAX_SUMMARY_JSON_BYTES bytes — pushing markdown only",
            )
            return null
        }
        return json
    }

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

    /** Thrown when the server rejects the API key (HTTP 401) — invalid/disabled/wrong org. */
    class UnauthorizedError(message: String) : RuntimeException(message)

    /**
     * The server accepted the credential but refused the push. Two server shapes
     * map here: a 412 `repo_not_allowlisted` (the repo is not registered in a
     * restricted Space — an admin must add it) and a push-path 403 (an ownership
     * mismatch). Distinct from [UnauthorizedError]: the user should contact an
     * admin, not re-login. Mirrors the CLI / VS Code `PermissionDeniedError` so
     * all three clients surface the same actionable text (cross-client parity).
     */
    class PermissionDeniedError(message: String) : RuntimeException(message)

    /** Thrown when the server returns 412 because the repo has no space binding yet. */
    class BindingRequiredError(
        val repoUrl: String,
        message: String = "This repo is not bound to a Memory space yet.",
    ) : RuntimeException(message)

    /**
     * Parses the tenant metadata embedded in a new-format Jolli API key.
     *
     * New format: sk-jol-{base64url(JSON meta)}.{base64url(32 random bytes)}
     * Old format: sk-jol-{32 hex chars} -- returns null
     *
     * Kept as pure local Kotlin (no bridge call) because EDT callers
     * (StatusPanel refresh, SettingsDialog, SummaryPanel push pre-flight)
     * invoke this synchronously; a subprocess round-trip here would violate
     * IntelliJ's 300 ms slow-EDT floor. Must stay in lockstep with the
     * canonical parser in `cli/src/core/JolliApiUtils.ts` (and the VS Code
     * bundle).
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
     * Pushes a commit summary to a Jolli Space via the CLI ide-bridge.
     *
     * @param cwd the working tree of the repo being pushed FROM. Required (not
     *   defaulted) because the CLI side evaluates the per-repo outbound-push
     *   opt-out against it — a default would silently re-introduce the
     *   wrong-project gate described on `callJolliApi`. Callers already hold it:
     *   `PushContext.workspaceRoot` / the panel's project `cwd`.
     * @param baseUrl Jolli site base URL override. When null the CLI derives it from the API key metadata.
     * @param apiKey Jolli API key (sk-jol-...)
     * @param payload Summary content to push
     */
    fun pushToJolli(
        cwd: String,
        baseUrl: String?,
        apiKey: String,
        payload: JolliPushPayload,
    ): JolliPushResult {
        val request = JsonObject().apply {
            addProperty("operation", "push")
            addProperty("apiKey", apiKey)
            if (baseUrl != null) addProperty("baseUrl", baseUrl)
            add("payload", pushPayloadJson(payload))
        }
        val response = callJolliApi(request, payload.repoUrl, cwd)
        val obj = response.asJsonObjectOrNull()
            ?: throw RuntimeException("push endpoint returned a non-object response")
        return parsePushResponse(obj)
    }

    /**
     * Serializes a push payload for the CLI `jolli-api` bridge. Marked `internal`
     * so the wire-contract test pins each field name literally: a silent rename
     * on either side of the bridge (Kotlin `docId` → `id`, CLI `PushPayload.docId`
     * → `PushPayload.documentId`) makes `push` drop that value to the response
     * default and the doc re-CREATEs on every commit instead of updating.
     * `pushPayloadJson` must stay in lockstep with `PushPayload` in
     * [`cli/src/core/JolliMemoryPushClient.ts`].
     */
    internal fun pushPayloadJson(payload: JolliPushPayload): JsonObject = JsonObject().apply {
        addProperty("title", payload.title)
        addProperty("content", payload.content)
        addProperty("commitHash", payload.commitHash)
        addProperty("docType", payload.docType)
        if (payload.branch != null) addProperty("branch", payload.branch)
        if (payload.docId != null) addProperty("docId", payload.docId)
        if (payload.repoUrl != null) addProperty("repoUrl", payload.repoUrl)
        if (payload.relativePath != null) addProperty("relativePath", payload.relativePath)
        if (payload.summaryJson != null) addProperty("summaryJson", payload.summaryJson)
    }

    /**
     * Parses a push response into [JolliPushResult]. Split out (rather than
     * inlined into [pushToJolli]) so the wire-contract test can pin each field
     * name literally: a rename on either side (`docId` → `id`, `jrn` → `jolliRn`)
     * would otherwise silently collapse the value to the default (`0` / `""`)
     * and make the article link unusable — the same drift class [pushPayloadJson]
     * guards against for the request direction. Must stay in lockstep with
     * `PushResult` in [`cli/src/core/JolliMemoryPushClient.ts`].
     */
    internal fun parsePushResponse(obj: JsonObject): JolliPushResult = JolliPushResult(
        url = obj.stringOrNull("url").orEmpty(),
        docId = obj.intOrZero("docId"),
        jrn = obj.stringOrNull("jrn").orEmpty(),
        created = obj.boolOrFalse("created"),
    )

    /**
     * Deletes an orphaned JolliMemory article from the server.
     *
     * @param cwd the working tree of the repo the article belongs to — required
     *   for the same reason as [pushToJolli]'s: `delete` is per-repo gated.
     */
    fun deleteFromJolli(cwd: String, baseUrl: String?, apiKey: String, docId: Int) {
        val request = JsonObject().apply {
            addProperty("operation", "delete")
            addProperty("apiKey", apiKey)
            if (baseUrl != null) addProperty("baseUrl", baseUrl)
            addProperty("docId", docId)
        }
        callJolliApi(request, cwd = cwd)
    }

    /**
     * Resolves the effective bearer token for Jolli API calls.
     * Priority: explicit Jolli API key > OAuth auth token from ~/.jolli/jollimemory/config.json.
     */
    fun resolveToken(jolliApiKey: String?): String? {
        if (!jolliApiKey.isNullOrBlank()) return jolliApiKey
        return JolliConfigStore.loadAuthToken()
    }

    // ── JM Space Binding endpoints (JOLLI-1335) ──────────────────────────

    /** Result of GET /api/jolli-memory/spaces. */
    data class JmSpacesListResult(
        val spaces: List<ai.jolli.jollimemory.toolwindow.JmSpaceSummary>,
        val defaultSpaceId: Int?,
    )

    /** Lists existing JolliMemory spaces visible to the authenticated user. */
    fun listSpaces(baseUrl: String, apiKey: String): JmSpacesListResult {
        val request = JsonObject().apply {
            addProperty("operation", "list-spaces")
            addProperty("apiKey", apiKey)
            addProperty("baseUrl", baseUrl)
        }
        val obj = callJolliApi(request).asJsonObjectOrNull()
            ?: throw RuntimeException("Invalid response from list-spaces")
        return parseListSpacesResponse(obj)
    }

    /**
     * Parses the `list-spaces` response. Extracted so the wire-contract test
     * can pin `id` / `name` / `slug` / `defaultSpaceId` literally. Must stay in
     * lockstep with `listSpaces()` in [`cli/src/core/JolliMemoryPushClient.ts`].
     */
    internal fun parseListSpacesResponse(obj: JsonObject): JmSpacesListResult {
        val spaces = obj.get("spaces")?.takeIf { it.isJsonArray }?.asJsonArray ?: JsonArray()
        val parsed = spaces.map { el ->
            val s = el.asJsonObject
            ai.jolli.jollimemory.toolwindow.JmSpaceSummary(
                id = s.intOrZero("id"),
                name = s.stringOrNull("name").orEmpty(),
                slug = s.stringOrNull("slug").orEmpty(),
            )
        }
        val defaultSpaceId = obj.get("defaultSpaceId")
            ?.takeIf { it.isJsonPrimitive && (it as JsonPrimitive).isNumber }
            ?.asInt
        return JmSpacesListResult(parsed, defaultSpaceId)
    }

    /**
     * Binds a repo to a JM space. Throws
     * [ai.jolli.jollimemory.toolwindow.BindingAlreadyExistsException] when the
     * CLI reports the 409 race collision.
     */
    fun createBinding(
        baseUrl: String,
        apiKey: String,
        repoUrl: String,
        repoName: String,
        jmSpaceId: Int,
    ): ai.jolli.jollimemory.toolwindow.BindingChooserResult {
        val request = JsonObject().apply {
            addProperty("operation", "create-binding")
            addProperty("apiKey", apiKey)
            addProperty("baseUrl", baseUrl)
            addProperty("repoUrl", repoUrl)
            addProperty("repoName", repoName)
            addProperty("jmSpaceId", jmSpaceId)
            // Bypasses [callJolliApi] (see below), so stamp the clientHeader
            // manually — otherwise the CLI would emit `cli/<version>` for this
            // path only.
            addProperty("clientHeader", intellijClientHeader)
        }
        // Call runIdeBridge DIRECTLY, not through callJolliApi: the shared
        // helper wraps every CliBridgeException in remapBridgeException, which
        // routes BindingAlreadyExistsError to a plain RuntimeException — the
        // structured `existingSpaceId` needed for the 409 race-winner banner
        // (so the push can settle on the winning binding) would be lost
        // before this catch could see it. See [mapCreateBindingBridgeException].
        val obj = try {
            CliIntegrations.runIdeBridge(
                CliIntegrations.resolveDefaultCwd(),
                "jolli-api",
                gson.toJson(request),
            ).asJsonObjectOrNull()
                ?: throw RuntimeException("Invalid response from create-binding")
        } catch (e: CliIntegrations.CliBridgeException) {
            throw mapCreateBindingBridgeException(e, repoUrl, repoName)
        }
        return parseCreateBindingResponse(obj)
    }

    /**
     * Parses the `create-binding` response. Extracted so the wire-contract test
     * can pin `bindingId` / `jmSpaceId` / `repoName` literally — a rename to
     * `id` on the Kotlin read side (matching the raw row column) or a rename
     * to `jmSpaceId` → `jmSpaceIdx` on the CLI emit side would silently
     * collapse to 0 and the caller would think the create succeeded against
     * space 0. Must stay in lockstep with `createBinding()` in
     * [`cli/src/core/JolliMemoryPushClient.ts`].
     *
     * `jmSpaceName` is intentionally "": the server's `POST /bindings` response
     * (both 2xx and 409) has no space-name field. The race-winner banner in
     * BindingChooserDialog is authored to work without a name.
     */
    internal fun parseCreateBindingResponse(obj: JsonObject): ai.jolli.jollimemory.toolwindow.BindingChooserResult =
        ai.jolli.jollimemory.toolwindow.BindingChooserResult(
            id = obj.intOrZero("bindingId"),
            jmSpaceId = obj.intOrZero("jmSpaceId"),
            jmSpaceName = "",
            repoName = obj.stringOrNull("repoName").orEmpty(),
        )

    /**
     * Maps a `CliBridgeException` raised by the `create-binding` jolli-api
     * action. `BindingAlreadyExistsError` becomes
     * [ai.jolli.jollimemory.toolwindow.BindingAlreadyExistsException] carrying
     * the winning binding's `existingSpaceId` so the subsequent push settles
     * on the correct Space; every other errorName routes through the shared
     * [remapBridgeException]. `jmSpaceName` is not carried (server does not
     * send it — see [createBinding]).
     *
     * Extracted from [createBinding] so it can be unit-tested — the actual
     * bridge call spawns a Node subprocess and the intellij/ test rules
     * (AGENTS.md, `check-global-state.sh`) forbid the `mockkStatic`/`mockkObject`
     * needed to stub it.
     */
    internal fun mapCreateBindingBridgeException(
        e: CliIntegrations.CliBridgeException,
        repoUrl: String,
        repoName: String,
    ): RuntimeException {
        if (e.errorName == "BindingAlreadyExistsError") {
            val existingSpaceId = e.details.get("existingSpaceId")
                ?.takeIf { it.isJsonPrimitive && (it as JsonPrimitive).isNumber }
                ?.asInt ?: 0
            return ai.jolli.jollimemory.toolwindow.BindingAlreadyExistsException(
                ai.jolli.jollimemory.toolwindow.BindingChooserResult(
                    id = 0,
                    jmSpaceId = existingSpaceId,
                    jmSpaceName = "",
                    repoName = repoName,
                ),
            )
        }
        return remapBridgeException(e, repoUrl)
    }

    // ── Branch share (live, Space-backed) endpoints ─────────────────────────

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

    /** Response from POST /api/share/branch/:shareId/invite — server merges the allowlist, then emails. */
    data class ShareInviteResult(
        val sent: List<String>,
        val failed: List<String>,
    )

    /** An org member offered as a recipient candidate (name + deliverable email). */
    data class OrgMember(val name: String, val email: String)

    /** Creates a live share. Requires `shareId` + `shareUrl`; `token` only for `public`. */
    fun createLiveShare(baseUrl: String?, apiKey: String, payload: LiveSharePayload): LiveShareResult {
        val request = JsonObject().apply {
            addProperty("operation", "create-share")
            addProperty("apiKey", apiKey)
            if (baseUrl != null) addProperty("baseUrl", baseUrl)
            add("payload", liveSharePayloadJson(payload))
        }
        val obj = callJolliApi(request).asJsonObjectOrNull()
            ?: throw RuntimeException("Invalid response from create-share")
        val shareId = obj.stringOrNull("shareId")
            ?: throw RuntimeException("Share endpoint returned an unexpected response (missing shareId).")
        val shareUrl = obj.stringOrNull("shareUrl")
            ?: throw RuntimeException("Share endpoint returned an unexpected response (missing shareUrl).")
        return LiveShareResult(
            shareId = shareId,
            shareUrl = shareUrl,
            expiresAt = obj.stringOrNull("expiresAt").orEmpty(),
            visibility = obj.stringOrNull("visibility") ?: payload.visibility,
            token = obj.stringOrNull("token"),
            recipients = obj.stringList("recipients"),
        )
    }

    /**
     * Serializes a live-share create payload. Marked `internal` so the
     * wire-contract test pins each field name literally — a rename here or
     * on the CLI side (`LiveSharePayload` in [`cli/src/core/JolliShareClient.ts`])
     * would silently drop the value at the wire and the server would fall back
     * to schema defaults (public visibility, empty commit list). The two must
     * stay in lockstep.
     */
    internal fun liveSharePayloadJson(payload: LiveSharePayload): JsonObject = JsonObject().apply {
        addProperty("repoUrl", payload.repoUrl)
        addProperty("repoName", payload.repoName)
        addProperty("branch", payload.branch)
        addProperty("kind", payload.kind)
        addProperty("visibility", payload.visibility)
        addProperty("decisionCount", payload.decisionCount)
        addProperty("headCommitHash", payload.headCommitHash)
        val hashes = JsonArray().apply { payload.commitHashes.forEach { add(it) } }
        add("commitHashes", hashes)
        if (payload.branchSlug != null) addProperty("branchSlug", payload.branchSlug)
        add("ref", gson.toJsonTree(payload.ref))
        if (payload.recipients != null) {
            val arr = JsonArray().apply { payload.recipients.forEach { add(it) } }
            add("recipients", arr)
        }
    }

    /** Updates a live share (visibility / covered ref / expiry / recipients) via PATCH. */
    fun updateLiveShare(baseUrl: String?, apiKey: String, shareId: String, patch: LiveSharePatch): LiveShareUpdateResult {
        val request = JsonObject().apply {
            addProperty("operation", "update-share")
            addProperty("apiKey", apiKey)
            if (baseUrl != null) addProperty("baseUrl", baseUrl)
            addProperty("shareId", shareId)
            add("patch", liveSharePatchJson(patch))
        }
        val obj = callJolliApi(request).asJsonObjectOrNull()
            ?: throw RuntimeException("Invalid response from update-share")
        return LiveShareUpdateResult(
            shareId = obj.stringOrNull("shareId"),
            shareUrl = obj.stringOrNull("shareUrl"),
            expiresAt = obj.stringOrNull("expiresAt"),
            visibility = obj.stringOrNull("visibility"),
            token = obj.stringOrNull("token"),
            recipients = obj.stringList("recipients"),
        )
    }

    /**
     * Serializes a live-share update patch. Marked `internal` so the
     * wire-contract test pins each field name literally — same rationale as
     * [liveSharePayloadJson]. Fields absent from the patch are omitted so the
     * server treats them as "unchanged"; a rename would silently drop the
     * caller's intent (e.g. a `visibility` change fails to apply and the share
     * stays public).
     */
    internal fun liveSharePatchJson(patch: LiveSharePatch): JsonObject = JsonObject().apply {
        if (patch.visibility != null) addProperty("visibility", patch.visibility)
        if (patch.expiresAt != null) addProperty("expiresAt", patch.expiresAt)
        if (patch.ref != null) add("ref", gson.toJsonTree(patch.ref))
        if (patch.recipients != null) {
            val arr = JsonArray().apply { patch.recipients.forEach { add(it) } }
            add("recipients", arr)
        }
    }

    /** Revokes a live share by id. 404 = already gone → idempotent success (handled by the CLI client, see cli/src/core/JolliShareClient.ts). */
    fun revokeShare(baseUrl: String?, apiKey: String, shareId: String) {
        val request = JsonObject().apply {
            addProperty("operation", "revoke-share")
            addProperty("apiKey", apiKey)
            if (baseUrl != null) addProperty("baseUrl", baseUrl)
            addProperty("shareId", shareId)
        }
        callJolliApi(request)
    }

    /**
     * Sends invite emails and grants access via `POST /api/share/branch/:shareId/invite`.
     * The server merges the recipients into the allowlist first (granting access to the view
     * URL), then emails each — mail failures do NOT revoke access. Returns sent/failed lists.
     */
    fun sendShareInviteAndGrantAccess(
        baseUrl: String?,
        apiKey: String,
        shareId: String,
        recipients: List<String>,
        message: String? = null,
    ): ShareInviteResult {
        val request = JsonObject().apply {
            addProperty("operation", "invite-share")
            addProperty("apiKey", apiKey)
            if (baseUrl != null) addProperty("baseUrl", baseUrl)
            addProperty("shareId", shareId)
            val arr = JsonArray().apply { recipients.forEach { add(it) } }
            add("recipients", arr)
            if (message != null) addProperty("message", message)
        }
        val obj = callJolliApi(request).asJsonObjectOrNull()
            ?: throw RuntimeException("Invalid response from invite-share")
        return ShareInviteResult(
            sent = obj.stringList("sent") ?: emptyList(),
            failed = obj.stringList("failed") ?: emptyList(),
        )
    }

    /**
     * Lists active org members as recipient candidates (name + email). Best-effort:
     * returns [] on any error.
     */
    fun listOrgMembers(baseUrl: String?, apiKey: String): List<OrgMember> {
        return try {
            val request = JsonObject().apply {
                addProperty("operation", "list-org-members")
                addProperty("apiKey", apiKey)
                if (baseUrl != null) addProperty("baseUrl", baseUrl)
            }
            val obj = callJolliApi(request).asJsonObjectOrNull() ?: return emptyList()
            val members = obj.get("members")?.takeIf { it.isJsonArray }?.asJsonArray ?: return emptyList()
            members.mapNotNull { el ->
                val m = el.takeIf { it.isJsonObject }?.asJsonObject ?: return@mapNotNull null
                val email = m.stringOrNull("email")?.trim().orEmpty()
                if (email.isEmpty()) null else OrgMember(name = m.stringOrNull("name").orEmpty(), email = email)
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    // ── Internal helpers ────────────────────────────────────────────────────

    /**
     * Sends one `jolli-api` bridge request and maps common typed errors back to
     * their Kotlin exception counterparts. [payloadRepoUrl] is threaded so a
     * `BindingRequiredError` without a `repoUrl` field in the CLI-side error
     * detail can still fall back to the payload's own repo URL.
     *
     * [cwd] names the repo the request acts ON, and is REQUIRED for any operation
     * the CLI side gates per-repo — today `push` and `delete`, which consult
     * `isOutboundPushAllowed(cwd)` (spec 306). Only operations whose answer does
     * not depend on which project serves them (`list-spaces`, `create-binding`,
     * the `*-share` calls — reads, binding metadata, or the separate live-share
     * channel) may leave it null and fall back to [CliIntegrations.resolveDefaultCwd],
     * whose contract is exactly that: "any open project answers identically".
     * Passing that default for a gated op would evaluate the opt-out against the
     * FIRST open project's repo, so in a multi-project IDE project B's push could
     * be blocked by project A's setting.
     *
     * Stamps `clientHeader` on every request so the CLI-side `x-jolli-client`
     * identifies the plugin (`intellij-plugin/<plugin-version>`) rather than
     * the bundled CLI build. See [intellijClientHeader].
     */
    private fun callJolliApi(request: JsonObject, payloadRepoUrl: String? = null, cwd: String? = null): JsonElement {
        request.addProperty("clientHeader", intellijClientHeader)
        return try {
            CliIntegrations.runIdeBridge(cwd ?: CliIntegrations.resolveDefaultCwd(), "jolli-api", gson.toJson(request))
        } catch (e: CliIntegrations.CliBridgeException) {
            throw remapBridgeException(e, payloadRepoUrl)
        }
    }

    /**
     * Maps the CLI's structured error envelope (see IdeBridgeCommand.ts's
     * `copyPrimitiveErrorFields`) to the Kotlin exception the UI still branches
     * on. `NotAuthenticatedError` is a bad/expired credential (re-login) and maps
     * to [UnauthorizedError]; `PermissionDeniedError` is a credential-OK refusal
     * (repo not allowlisted / ownership mismatch — contact an admin) and maps to
     * the distinct [PermissionDeniedError] so the panels can surface the
     * admin-oriented text. Mirrors the CLI / VS Code split (cross-client parity).
     */
    internal fun remapBridgeException(e: CliIntegrations.CliBridgeException, payloadRepoUrl: String?): RuntimeException {
        return when (e.errorName) {
            "ClientOutdatedError" -> PluginOutdatedError(e.message ?: "Plugin outdated")
            "NotAuthenticatedError" -> UnauthorizedError(e.message ?: "Not authenticated")
            "PermissionDeniedError" -> PermissionDeniedError(e.message ?: "You don't have permission to push to this Space.")
            // The per-repo outbound-push opt-out (spec 306), refused by the CLI's own
            // gate mid-call. Push sites gate before calling, but that check and the
            // CLI's straddle a round trip: a flag flipped in between (or by another
            // surface) arrives here, and without this branch it degraded to the plain
            // RuntimeException below — surfacing a user opt-out as a push failure and
            // skipping the quiet "re-enable to push" handling the panels already have.
            //
            // Deliberately DROPS the bridge message: the CLI's wording names a CLI
            // command (`jolli push-control --enable`), so the IDE-worded default is
            // used instead, keeping this path's text identical to the pre-call gate's
            // (JolliShareService.shareSummary / LiveShareController).
            "PushDisabledError" -> JolliShareService.PushDisabledError()
            "BindingRequiredError" -> {
                val repoUrl = e.details.get("repoUrl")
                    ?.takeIf { it.isJsonPrimitive }?.asString
                    ?: payloadRepoUrl.orEmpty()
                BindingRequiredError(repoUrl = repoUrl, message = e.message ?: "Binding required")
            }
            "ShareRevokedError" -> ShareRevokedError(e.message ?: "This share has been stopped.")
            // Note: "BindingAlreadyExistsError" is deliberately absent here —
            // [mapCreateBindingBridgeException] handles it before falling
            // through, so it can read the structured `existingSpaceId` needed
            // for the race-winner banner (so the push can settle on the
            // winning binding). Reaching this branch with that errorName
            // means a caller other than createBinding hit it, so the plain
            // RuntimeException fallback is the right behavior.
            else -> RuntimeException(e.message ?: "unknown CLI bridge error")
        }
    }

    private fun JsonElement?.asJsonObjectOrNull(): JsonObject? =
        this?.takeIf { !it.isJsonNull && it.isJsonObject }?.asJsonObject

    private fun JsonObject.stringOrNull(key: String): String? =
        get(key)?.takeIf { !it.isJsonNull && it.isJsonPrimitive }?.asString

    private fun JsonObject.intOrZero(key: String): Int =
        get(key)?.takeIf { it.isJsonPrimitive && (it as JsonPrimitive).isNumber }?.asInt ?: 0

    private fun JsonObject.boolOrFalse(key: String): Boolean =
        get(key)?.takeIf { it.isJsonPrimitive && (it as JsonPrimitive).isBoolean }?.asBoolean ?: false

    private fun JsonObject.stringList(key: String): List<String>? =
        get(key)?.takeIf { it.isJsonArray }?.asJsonArray
            ?.mapNotNull { it.takeIf { e -> e.isJsonPrimitive }?.asString }
}

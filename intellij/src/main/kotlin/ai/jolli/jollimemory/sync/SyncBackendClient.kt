package ai.jolli.jollimemory.sync

import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliApiClient
import com.google.gson.Gson
import java.io.IOException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.HttpTimeoutException
import java.time.Duration

/**
 * HTTP client for the Memory Bank sync backend endpoints.
 *
 * Five endpoints under `/api/mb-sync/`:
 *
 *   - `POST /credentials` — mint a short-lived GitHub Installation Token and
 *     acquire the personal-space write-lock.
 *   - `POST /notify-push` — fire-and-forget "I just pushed" notification;
 *     releases the write-lock on the success path.
 *   - `POST /release-lock` — explicit write-lock release on failure paths.
 *   - `GET /legacy-content` — dump legacy DB docs for first-bind migration.
 *   - `POST /complete-migration` — flip backing from DB to git.
 *
 * All calls authenticate with `Authorization: Bearer <jolliApiKey>` and route
 * via the tenant URL encoded in the API key (same pattern as [JolliApiClient]).
 *
 * Constructor parameters are test seams — production callers use the defaults.
 */
class SyncBackendClient(
	private val httpClient: HttpClient = HttpClient.newBuilder()
		.connectTimeout(Duration.ofSeconds(10))
		.build(),
	private val baseUrlOverride: String? = null,
	private val jolliApiKeyProvider: () -> String? = ::defaultJolliApiKeyProvider,
	private val timeoutMs: Long = DEFAULT_TIMEOUT_MS,
) {

	private val log = JmLogger.create("SyncBackendClient")
	private val gson = Gson()

	/**
	 * Mints a fresh GitHub Installation Token and reports the personal space's
	 * current backing. On the user's first call, the backend provisions the
	 * GitHub repo transparently. Returns [GitCredentials] with the short-lived
	 * token, vault repo info, and a [GitCredentials.lockOwnerToken] for the
	 * per-space write-lock.
	 */
	fun mintGitCredentials(): GitCredentials {
		val body = request<Map<String, Any?>>("POST", "/api/mb-sync/credentials", emptyMap<String, Any>())

		val missing = missingMintFields(body)
		if (missing.isNotEmpty()) {
			throw SyncBackendError(
				502,
				"Sync backend returned an incomplete mint response (missing ${missing.joinToString(", ")})",
				gson.toJson(body),
			)
		}

		val cloneUrl = body["repoCloneUrl"] as String
		val parsedCloneUrl = try {
			URI.create(cloneUrl)
		} catch (_: Exception) {
			throw SyncBackendError(
				502,
				"Sync backend returned an unparseable repoCloneUrl: $cloneUrl",
				gson.toJson(body),
			)
		}
		if (parsedCloneUrl.scheme != "https") {
			throw SyncBackendError(
				502,
				"Sync backend returned a non-https repoCloneUrl (${parsedCloneUrl.scheme}://…); refusing to attach bearer token over cleartext",
				gson.toJson(body),
			)
		}

		val expiresAtRaw = body["expiresAt"]
		val expiresAt: Long = when (expiresAtRaw) {
			is Number -> expiresAtRaw.toLong()
			is String -> {
				val parsed = try {
					java.time.Instant.parse(expiresAtRaw).toEpochMilli()
				} catch (_: Exception) {
					throw SyncBackendError(
						502,
						"Sync backend returned an invalid expiresAt: $expiresAtRaw",
						gson.toJson(body),
					)
				}
				parsed
			}
			else -> throw SyncBackendError(
				502,
				"Sync backend returned an invalid expiresAt: $expiresAtRaw",
				gson.toJson(body),
			)
		}

		return GitCredentials(
			gitUrl = cloneUrl,
			token = body["token"] as String,
			expiresAt = expiresAt,
			repoFullName = body["repoFullName"] as String,
			defaultBranch = body["defaultBranch"] as String,
			githubRepoCreated = body["githubRepoCreated"] as? Boolean ?: false,
			alreadyVaultBound = body["alreadyVaultBound"] as Boolean,
			lockOwnerToken = body["lockOwnerToken"] as String,
		)
	}

	/**
	 * Fire-and-forget notification that [commitSha] was just pushed on [branch].
	 * Releases the personal-space write-lock on the success path.
	 * Callers should swallow errors — the webhook + reconciler cover lost messages.
	 */
	fun notifyPush(commitSha: String, branch: String, lockOwnerToken: String) {
		request<Any>("POST", "/api/mb-sync/notify-push", mapOf(
			"commitSha" to commitSha,
			"branch" to branch,
			"lockOwnerToken" to lockOwnerToken,
		))
	}

	/**
	 * Explicit write-lock release for failure paths. Called from the round's
	 * finally block when neither [notifyPush] nor [completeMigration] ran.
	 * Callers MUST swallow errors — the backend's TTL is the backstop.
	 */
	fun releaseLock(lockOwnerToken: String) {
		request<Any>("POST", "/api/mb-sync/release-lock", mapOf(
			"lockOwnerToken" to lockOwnerToken,
		))
	}

	/**
	 * Fetches legacy `backing_type=db` content for first-bind migration.
	 * Idempotent: once the space is git-backed, returns
	 * `alreadyMigrated = true` with an empty `docs` list.
	 */
	fun getLegacyContent(): LegacyContentResponse {
		val body = request<Map<String, Any?>>("GET", "/api/mb-sync/legacy-content", null)

		@Suppress("UNCHECKED_CAST")
		val rawDocs = body["docs"] as? List<Map<String, Any?>> ?: emptyList()
		val docs = rawDocs.map { d ->
			LegacyDoc(
				id = (d["id"] as Number).toInt(),
				jrn = d["jrn"] as String,
				slug = d["slug"] as String,
				path = d["path"] as String,
				docType = d["docType"] as String,
				parentId = (d["parentId"] as? Number)?.toInt(),
				content = d["content"] as String,
				contentType = d["contentType"] as String,
				sortOrder = (d["sortOrder"] as Number).toInt(),
				createdAt = d["createdAt"] as String,
				updatedAt = d["updatedAt"] as String,
			)
		}

		return LegacyContentResponse(
			spaceId = (body["spaceId"] as Number).toInt(),
			spaceSlug = body["spaceSlug"] as String,
			alreadyMigrated = body["alreadyMigrated"] as Boolean,
			docs = docs,
		)
	}

	/**
	 * Tells the backend that first-bind migration is complete: flip the space
	 * from `backing_type=db` to git. Releases the write-lock. Idempotent.
	 */
	fun completeMigration(commitSha: String, lockOwnerToken: String): CompleteMigrationResult {
		val body = request<Map<String, Any?>>("POST", "/api/mb-sync/complete-migration", mapOf(
			"commitSha" to commitSha,
			"lockOwnerToken" to lockOwnerToken,
		))
		return CompleteMigrationResult(
			alreadyMigrated = body["alreadyMigrated"] as? Boolean ?: false,
		)
	}

	/**
	 * Exposes the currently-resolved `jolliApiKey` so the engine can scope
	 * `pending-lock.json` entries by a hash of the key. Returns `null` when
	 * the user is signed out.
	 */
	fun getJolliApiKey(): String? = jolliApiKeyProvider()

	// ── Internal HTTP plumbing ──────────────────────────────────────────

	private inline fun <reified T> request(method: String, path: String, payload: Any?): T {
		val apiKey = jolliApiKeyProvider()
		if (apiKey.isNullOrBlank()) {
			throw SyncBackendUnauthorizedError("""{"error":"no_jolli_api_key"}""")
		}
		val keyMeta = JolliApiClient.parseJolliApiKey(apiKey)
		if (keyMeta == null) {
			throw SyncBackendUnauthorizedError("""{"error":"invalid_jolli_api_key"}""")
		}

		val baseUrl = baseUrlOverride ?: keyMeta.u
		val parsed = parseBaseUrl(baseUrl)
		val url = URI.create("${parsed.origin}$path")
		log.info("request: %s %s", method, url)

		val requestBuilder = HttpRequest.newBuilder()
			.uri(url)
			.header("Authorization", "Bearer $apiKey")
			.header("x-jolli-client", "intellij-plugin/${JolliApiClient.pluginVersion}")
			.timeout(Duration.ofMillis(timeoutMs))

		if (parsed.tenantSlug != null) {
			requestBuilder.header("x-tenant-slug", parsed.tenantSlug)
		}
		if (keyMeta.o != null) {
			requestBuilder.header("x-org-slug", keyMeta.o)
		}

		when (method) {
			"GET" -> requestBuilder.GET()
			"POST" -> {
				requestBuilder.header("Content-Type", "application/json")
				requestBuilder.POST(HttpRequest.BodyPublishers.ofString(gson.toJson(payload ?: emptyMap<String, Any>())))
			}
		}

		val response: HttpResponse<String>
		try {
			response = httpClient.send(requestBuilder.build(), HttpResponse.BodyHandlers.ofString())
		} catch (e: HttpTimeoutException) {
			throw SyncBackendNetworkError(e)
		} catch (e: IOException) {
			throw SyncBackendNetworkError(e)
		}

		val text = response.body() ?: ""
		val statusCode = response.statusCode()

		if (statusCode == 401 || statusCode == 403) {
			throw SyncBackendUnauthorizedError(text)
		}
		if (statusCode == 423) {
			throw VaultLockedError(text)
		}
		if (statusCode == 503) {
			val pendingFlush = tryParsePendingFlush(text)
			if (pendingFlush != null) {
				throw WebFlushPendingError(text, pendingFlush.retryAfterSeconds)
			}
		}
		if (statusCode !in 200..299) {
			throw SyncBackendError(statusCode, "Sync backend returned $statusCode", text)
		}
		if (text.isEmpty()) {
			@Suppress("UNCHECKED_CAST")
			return emptyMap<String, Any?>() as T
		}
		return try {
			@Suppress("UNCHECKED_CAST")
			gson.fromJson(text, Map::class.java) as T
		} catch (_: Exception) {
			throw SyncBackendError(502, "Sync backend returned non-JSON 2xx body", text.take(1024))
		}
	}

	private data class ParsedBaseUrl(val origin: String, val tenantSlug: String?)

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

	private fun missingMintFields(body: Map<String, Any?>): List<String> {
		val missing = mutableListOf<String>()
		if (body["token"] == null) missing.add("token")
		if (body["expiresAt"] == null) missing.add("expiresAt")
		if (body["repoCloneUrl"] == null) missing.add("repoCloneUrl")
		if (body["repoFullName"] == null) missing.add("repoFullName")
		if (body["defaultBranch"] == null) missing.add("defaultBranch")
		if (body["alreadyVaultBound"] !is Boolean) missing.add("alreadyVaultBound")
		if (body["lockOwnerToken"] == null) missing.add("lockOwnerToken")
		return missing
	}

	private data class PendingFlushInfo(val retryAfterSeconds: Int)

	private fun tryParsePendingFlush(text: String): PendingFlushInfo? {
		return try {
			@Suppress("UNCHECKED_CAST")
			val body = gson.fromJson(text, Map::class.java) as? Map<String, Any?> ?: return null
			if (body["error"] != "pending_flush_failed") return null
			val raw = body["retryAfterSeconds"]
			val retryAfterSeconds = when (raw) {
				is Number -> if (raw.toInt() > 0) raw.toInt() else 30
				else -> 30
			}
			PendingFlushInfo(retryAfterSeconds)
		} catch (_: Exception) {
			null
		}
	}

	companion object {
		private const val DEFAULT_TIMEOUT_MS = 10_000L
	}
}

// ── Error hierarchy ─────────────────────────────────────────────────────

/** Generic non-2xx response from the sync backend. */
open class SyncBackendError(
	val status: Int,
	message: String,
	val body: String,
) : RuntimeException(message)

/** 401/403 — auth token rejected. Engine maps this to re-mint + retry. */
class SyncBackendUnauthorizedError(body: String) : SyncBackendError(
	401, "Sync backend rejected the auth token (401)", body,
)

/** 423 — vault write-lock held by another device. Engine retries with backoff. */
class VaultLockedError(body: String) : SyncBackendError(
	423, "Personal Space is being synced by another device", body,
)

/**
 * 503 with `pending_flush_failed` — backend's web-side flusher hasn't pushed
 * pending edits to GitHub yet. Engine retries after [retryAfterSeconds].
 */
class WebFlushPendingError(body: String, val retryAfterSeconds: Int) : SyncBackendError(
	503, "Waiting for web edits to upload to GitHub", body,
)

/** Network-layer failure (DNS, refused, timeout). Transient — next round may succeed. */
class SyncBackendNetworkError(override val cause: Throwable?) : RuntimeException(
	"Sync backend unreachable", cause,
)

// ── Data classes ────────────────────────────────────────────────────────

/** Short-lived GitHub Installation Token + vault info from `POST /credentials`. */
data class GitCredentials(
	val gitUrl: String,
	val token: String,
	/** Epoch milliseconds (UTC). */
	val expiresAt: Long,
	val repoFullName: String,
	val defaultBranch: String,
	val githubRepoCreated: Boolean,
	val alreadyVaultBound: Boolean,
	/** Per-space write-lock owner token. Echo back to notify-push / release-lock. */
	val lockOwnerToken: String,
)

/** A single doc from `GET /legacy-content`. */
data class LegacyDoc(
	val id: Int,
	val jrn: String,
	val slug: String,
	val path: String,
	val docType: String,
	val parentId: Int?,
	val content: String,
	val contentType: String,
	val sortOrder: Int,
	val createdAt: String,
	val updatedAt: String,
)

/** Response from `GET /legacy-content`. */
data class LegacyContentResponse(
	val spaceId: Int,
	val spaceSlug: String,
	val alreadyMigrated: Boolean,
	val docs: List<LegacyDoc>,
)

/** Response from `POST /complete-migration`. */
data class CompleteMigrationResult(
	val alreadyMigrated: Boolean,
)

// ── Default provider ────────────────────────────────────────────────────

private fun defaultJolliApiKeyProvider(): String? {
	val config = SessionTracker.loadConfigFromDir(SessionTracker.getGlobalConfigDir())
	return config.jolliApiKey?.takeIf { it.isNotBlank() }
}

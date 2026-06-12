package ai.jolli.jollimemory.auth

import ai.jolli.jollimemory.services.JolliApiClient
import java.net.URI

/**
 * Shared auth helpers for the IntelliJ plugin — Kotlin port of
 * `cli/src/core/JolliApiUtils.ts`.
 */
object JolliAuthUtils {

	private val ALLOWED_JOLLI_HOSTS = listOf("jolli.ai", "jolli.dev", "jolli.cloud", "jolli-local.me")

	/**
	 * Validates a Jolli API key: decodes it and checks the embedded origin
	 * against the allowlist. Mirrors the CLI's `validateJolliApiKey`.
	 */
	fun validateJolliApiKey(key: String) {
		val meta = JolliApiClient.parseJolliApiKey(key)
			?: throw IllegalArgumentException(
				"Rejected Jolli API key: cannot be decoded. Paste the key exactly as issued by Jolli.",
			)
		assertJolliOriginAllowed(meta.u)
	}

	/**
	 * Rejects origins that are not on the Jolli allowlist (HTTPS-only,
	 * suffix-boundary match). Mirrors the CLI's `assertJolliOriginAllowed`.
	 */
	fun assertJolliOriginAllowed(origin: String) {
		val uri: URI
		try {
			uri = URI.create(origin)
		} catch (_: Exception) {
			throw IllegalArgumentException("Rejected Jolli origin (unparseable): $origin")
		}

		val scheme = uri.scheme?.lowercase()
		val host = uri.host?.lowercase().orEmpty()
		val ok = scheme == "https" &&
			host.isNotEmpty() &&
			ALLOWED_JOLLI_HOSTS.any { h -> host == h || host.endsWith(".$h") }

		if (!ok) {
			throw IllegalArgumentException(
				"Rejected Jolli origin \"$origin\". " +
					"Only https://*.jolli.ai, https://*.jolli.dev, https://*.jolli.cloud, " +
					"and https://*.jolli-local.me are permitted.",
			)
		}
	}

	/**
	 * Sign-in helper: returns true when the upcoming login should ask the server
	 * to mint a fresh Jolli API key. Mirrors the CLI's `shouldRequestFreshApiKey`.
	 *
	 * The rule:
	 *   - No key on disk → request a fresh one (otherwise the user can't push).
	 *   - Key on disk whose embedded tenant differs from `jolliUrl` → request a
	 *     fresh one so a cross-tenant switch completes in a single sign-in. Without
	 *     this, the callback returns no new key, the stale key stays on disk, and
	 *     sync keeps routing to the old tenant via the key's embedded `meta.u`.
	 *   - Otherwise (key matches the target tenant, or is undecodable legacy) →
	 *     don't request a fresh one; a sign-in here is a re-auth, not a provision.
	 */
	fun shouldRequestFreshApiKey(existingKey: String?, jolliUrl: String): Boolean {
		if (existingKey.isNullOrBlank()) return true
		return !apiKeyMatchesTenant(existingKey, jolliUrl)
	}

	/**
	 * True when [existingKey]'s embedded tenant (origin + first path segment)
	 * matches [jolliUrl]. An undecodable key counts as a match — we can't prove
	 * it's stale, and dropping a hand-typed key would surprise the user. Mirrors
	 * the CLI's `apiKeyMatchesTenant`: origin compares case-insensitively (host is
	 * case-insensitive per RFC 3986 §6.2.2.1) while the tenant slug compares
	 * case-SENSITIVELY because it flows downstream verbatim as `x-tenant-slug`.
	 */
	private fun apiKeyMatchesTenant(existingKey: String, jolliUrl: String): Boolean {
		val meta = JolliApiClient.parseJolliApiKey(existingKey) ?: return true
		return try {
			val fromKey = parseBaseUrl(meta.u)
			val target = parseBaseUrl(jolliUrl)
			fromKey.origin == target.origin && fromKey.tenantSlug == target.tenantSlug
		} catch (_: Exception) {
			true
		}
	}

	private data class BaseUrlParts(val origin: String, val tenantSlug: String?)

	private fun parseBaseUrl(url: String): BaseUrlParts {
		val uri = URI.create(url)
		val scheme = uri.scheme?.lowercase().orEmpty()
		val authority = uri.authority?.lowercase().orEmpty()
		val tenantSlug = (uri.path ?: "")
			.trim('/')
			.split("/")
			.firstOrNull { it.isNotEmpty() }
		return BaseUrlParts(origin = "$scheme://$authority", tenantSlug = tenantSlug)
	}
}

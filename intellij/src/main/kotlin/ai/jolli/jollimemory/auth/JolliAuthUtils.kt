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
}

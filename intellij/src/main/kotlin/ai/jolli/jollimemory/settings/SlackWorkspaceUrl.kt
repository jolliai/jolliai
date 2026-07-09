package ai.jolli.jollimemory.settings

import java.net.URI

/**
 * Validation + normalization for the `slack.workspaceUrl` setting.
 *
 * Mirrors the CLI's `isAllowedSlackHost` + origin normalization
 * (cli/src/commands/ConfigureCommand.ts): HTTPS-only, host must be `slack.com`
 * or a subdomain of it (suffix-boundary check), and the persisted value is the
 * normalized origin (scheme + host, no trailing slash or path) so the reference
 * extractor's `${workspaceUrl}/archives/...` reconstruction can't produce a
 * double slash from a trailing-slash input.
 */
object SlackWorkspaceUrl {

	private fun isAllowedHost(host: String): Boolean =
		host == "slack.com" || host.endsWith(".slack.com")

	/**
	 * Returns the normalized origin for a valid `https://<workspace>.slack.com`
	 * URL, or null when the input is blank, malformed, non-HTTPS, or not a
	 * slack.com host.
	 */
	fun normalizeOrNull(raw: String): String? {
		val trimmed = raw.trim()
		if (trimmed.isEmpty()) return null
		val uri = try {
			URI(trimmed)
		} catch (_: Exception) {
			return null
		}
		val scheme = uri.scheme?.lowercase() ?: return null
		if (scheme != "https") return null
		val host = uri.host?.lowercase() ?: return null
		if (!isAllowedHost(host)) return null
		val port = uri.port
		return if (port != -1) "https://$host:$port" else "https://$host"
	}
}

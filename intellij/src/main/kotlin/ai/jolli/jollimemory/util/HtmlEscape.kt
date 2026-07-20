package ai.jolli.jollimemory.util

/**
 * Minimal HTML escape for user-supplied text embedded in JBLabel HTML content or
 * IntelliJ Notification body (paths and version strings from
 * [ai.jolli.jollimemory.bridge.RejectedCandidate], status messages, etc.). Only
 * the four characters that can break out of text context are escaped — enough
 * for the non-strict HTML renderer used in both places. Kept as a single shared
 * helper so the tool window's "Node.js required" panel and the startup error
 * notification cannot drift out of sync on their escape rules.
 */
internal fun escapeHtml(text: String): String =
	text.replace("&", "&amp;")
		.replace("<", "&lt;")
		.replace(">", "&gt;")
		.replace("\"", "&quot;")

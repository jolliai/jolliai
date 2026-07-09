package ai.jolli.jollimemory.core.references

import com.google.gson.JsonElement

/**
 * SlackNormalize — Kotlin port of SlackNormalize.ts.
 *
 * Parse the `slack_read_thread` result blob into a canonical object the Slack
 * adapter can read with plain path ops.
 *
 * The MCP result is human-readable text (`=== THREAD PARENT MESSAGE ===`,
 * `Message TS: …`, `--- Reply N of M ---`), NOT structured JSON, and carries
 * neither a url nor the channel id. The url (from the pasted permalink) and the
 * channel id (from the tool_use input) are threaded in via `ctx`.
 *
 * Defensive by contract: any shape we can't parse returns null (the caller
 * voids the reference), never throws — the blob format is defined by the MCP
 * wrapper's presentation layer, not a stable API, so it may drift.
 */
object SlackNormalize {

	private val PARENT_TS_RE = Regex("Message TS:\\s*(\\d{7,}\\.\\d+)")
	private const val REPLY_MARKER = "=== THREAD REPLIES"
	private val REPLY_COUNT_RE = Regex("=== THREAD REPLIES \\((\\d+) total\\) ===")

	/**
	 * First non-empty line after the parent's `Message TS:` line → title. Applied
	 * ONLY to the parent segment (everything before the first `=== THREAD REPLIES`
	 * marker): a parent message with no text body (e.g. a file-only post) must
	 * fall back to `Slack thread <ts>`, never borrow a reply's body as the title.
	 */
	private val PARENT_BODY_RE = Regex("Message TS:\\s*\\d{7,}\\.\\d+\\r?\\n([^\\r\\n]+)")

	data class Canonical(
		val channelId: String,
		val parentTs: String,
		val title: String,
		val text: String,
		val replyCount: Int,
		val url: String?,
	)

	private fun readMessages(rawResult: JsonElement?): String? {
		if (rawResult == null || !rawResult.isJsonObject) return null
		return rawResult.asJsonObject.stringOrNull("messages")
	}

	fun normalizeSlackThread(rawResult: JsonElement?, channelId: String, url: String?): Canonical? {
		val blob = readMessages(rawResult) ?: return null

		val tsMatch = PARENT_TS_RE.find(blob) ?: return null // no parent ts → not a usable thread
		val parentTs = tsMatch.groupValues[1]

		// Confine title extraction to the parent block so an empty-bodied parent
		// can't pick up the first reply's text as the title.
		val replyIdx = blob.indexOf(REPLY_MARKER)
		val parentSegment = if (replyIdx == -1) blob else blob.substring(0, replyIdx)
		val titleMatch = PARENT_BODY_RE.find(parentSegment)
		val title = titleMatch?.groupValues?.get(1)?.trim() ?: "Slack thread $parentTs"

		val replyMatch = REPLY_COUNT_RE.find(blob)
		val replyCount = replyMatch?.groupValues?.get(1)?.toIntOrNull() ?: 0

		return Canonical(
			channelId = channelId,
			parentTs = parentTs,
			title = title,
			text = blob.trim(),
			replyCount = replyCount,
			url = url,
		)
	}
}

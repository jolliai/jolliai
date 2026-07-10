package ai.jolli.jollimemory.core.references

import com.google.gson.JsonParser

/**
 * SlackPermalink — Kotlin port of SlackPermalink.ts.
 *
 * Parse a Slack thread permalink and harvest permalinks from a transcript's
 * role:user text blocks. The permalink is the capture anchor for Slack
 * references: it carries the workspace subdomain (absent from every MCP
 * payload) plus the channel + parent ts, so it supplies the authoritative url.
 *
 * We scan ONLY role:user `message.content` text blocks — not "last-prompt"
 * metadata lines and not tool_result content — because the same permalink can
 * appear in several line types, which would otherwise double-count one thread.
 */
object SlackPermalink {

	/**
	 * `.../archives/<channel>/p<16 digits>` — the dotless ts (16 digits: 10-digit
	 * seconds + 6-digit microseconds) becomes `<10>.<6>`.
	 */
	private val PERMALINK_RE =
		Regex("https://([a-z0-9][a-z0-9-]*)\\.slack\\.com/archives/([A-Z0-9]+)/p(\\d{16})")

	data class Parsed(
		val workspace: String,
		val channel: String,
		val parentTs: String,
		val url: String,
	)

	/** Insert the decimal point 6 digits from the end (Slack ts format). */
	private fun dottedTs(pDigits: String): String =
		"${pDigits.substring(0, pDigits.length - 6)}.${pDigits.substring(pDigits.length - 6)}"

	fun parseSlackPermalink(raw: String): Parsed? {
		val m = PERMALINK_RE.find(raw) ?: return null
		return Parsed(
			workspace = m.groupValues[1],
			channel = m.groupValues[2],
			parentTs = dottedTs(m.groupValues[3]),
			url = m.value,
		)
	}

	/** Map keyed by `<channel>:<parentTs>` → permalink url, from role:user text only. */
	fun scanUserPermalinks(lines: List<String>): Map<String, String> {
		val out = mutableMapOf<String, String>()
		for (line in lines) {
			if (!line.contains(".slack.com/archives/")) continue
			val parsed = try {
				JsonParser.parseString(line)
			} catch (_: Exception) {
				continue
			}
			if (!parsed.isJsonObject) continue
			val msg = parsed.asJsonObject.objectOrNull("message") ?: continue
			if (msg.stringOrNull("role") != "user") continue
			// `message.content` is EITHER an array of blocks OR a plain string. A
			// directly-typed user prompt (the common case for a pasted permalink)
			// serializes `content` as a plain string, not a text-block array — so
			// handle both forms, else typed permalinks are silently missed and every
			// capture falls back to linkless.
			val contentArr = msg.arrayOrNull("content")
			if (contentArr != null) {
				for (block in contentArr) {
					if (!block.isJsonObject) continue
					val b = block.asJsonObject
					if (b.stringOrNull("type") != "text") continue
					val text = b.stringOrNull("text") ?: continue
					parseSlackPermalink(text)?.let { out["${it.channel}:${it.parentTs}"] = it.url }
				}
			} else {
				val text = msg.stringOrNull("content") ?: continue
				parseSlackPermalink(text)?.let { out["${it.channel}:${it.parentTs}"] = it.url }
			}
		}
		return out
	}
}

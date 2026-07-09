package ai.jolli.jollimemory.core.references

import com.google.gson.JsonObject

/**
 * SlackAdapter — [SourceAdapter] for the Slack MCP server (slack_read_thread).
 *
 * Unlike the other adapters, Slack does NOT operate on the raw MCP tool_result
 * payload. The `slack_read_thread` blob is human-readable text carrying neither
 * a url nor the channel id. The [ClaudeEnvelopeParser] normalizes that blob
 * (via [SlackNormalize]) plus out-of-payload context (channel id from the
 * tool_use input, url from a pasted permalink or `slack.workspaceUrl`) into a
 * synthetic canonical [JsonObject]; [extractRef] reads plain paths off that.
 *
 * `url` is OPTIONAL (unique among sources): when no permalink was pasted and no
 * workspace URL is configured, the thread is still captured, linkless.
 */
object SlackAdapter : SourceAdapter {

	private const val MAX_CHARS = 8000
	private const val MAX_TOTAL = 40000

	/** `<channel>-<parentTs>` — e.g. `C0123ABCD-1699999999.001200`. */
	private val NATIVE_ID_RE = Regex("^[A-Z0-9]+-\\d{7,}\\.\\d+$")

	override val id = SourceId.slack
	override val maxCharsPerReference = MAX_CHARS
	override val wrapperKeys = emptyList<String>()

	override fun extractRef(payload: JsonObject, toolName: String, referencedAt: String): Reference? {
		val channelId = payload.stringOrNull("channelId") ?: return null
		val parentTs = payload.stringOrNull("parentTs") ?: return null

		val nativeId = "$channelId-$parentTs"
		if (!NATIVE_ID_RE.matches(nativeId)) return null

		val title = payload.stringOrNull("title")
		if (title.isNullOrEmpty()) return null // require ".+"

		// url is optional, but if present it must be an https URL (require "^https://").
		// A present-but-invalid url voids the reference, matching the CLI's evalField.
		val urlRaw = payload.stringOrNull("url")
		val url = if (urlRaw != null) {
			if (!urlRaw.startsWith("https://")) return null
			urlRaw
		} else {
			null
		}

		val replyCount = payload.intOrNull("replyCount") ?: 0
		val text = payload.stringOrNull("text")

		return Reference(
			mapKey = "slack:$nativeId",
			source = SourceId.slack,
			nativeId = nativeId,
			title = title,
			url = url,
			description = text?.ifEmpty { null },
			fields = listOf(
				ReferenceField("entity-type", "Type", "thread", "comment-discussion"),
				ReferenceField("replies", "Replies", replyCount.toString(), "reply"),
				ReferenceField("channel", "Channel", channelId, "symbol-namespace"),
			),
			toolName = toolName,
			referencedAt = referencedAt,
		)
	}

	override fun renderPromptBlock(refs: List<Reference>, opts: RenderOptions): String {
		if (refs.isEmpty()) return ""
		val maxPer = opts.maxCharsPerReference ?: MAX_CHARS
		val maxTotal = opts.maxTotalChars ?: MAX_TOTAL
		val selected = selectByBudget(refs, maxPer, maxTotal) { renderOne(it, maxPer) }
		if (selected.isEmpty()) return ""
		return "<slack-threads>\n${selected.joinToString("\n") { renderOne(it, maxPer) }}\n</slack-threads>"
	}

	private fun renderOne(ref: Reference, maxChars: Int): String = buildString {
		val attrs = mutableListOf("id=\"${PromptXmlEscape.escapeForAttr(ref.nativeId)}\"")
		ref.fields?.forEach { f -> attrs.add("${f.key}=\"${PromptXmlEscape.escapeForAttr(f.value)}\"") }
		appendLine("<thread ${attrs.joinToString(" ")}>")
		appendLine("  <title>${PromptXmlEscape.escapeForText(ref.title)}</title>")
		if (!ref.url.isNullOrEmpty()) {
			appendLine("  <url>${PromptXmlEscape.escapeForText(ref.url)}</url>")
		}
		if (ref.description != null) {
			appendLine("  <messages>")
			appendLine(PromptXmlEscape.escapeForText(truncate(ref.description, maxChars)))
			appendLine("  </messages>")
		}
		append("</thread>")
	}
}

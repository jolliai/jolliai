package ai.jolli.jollimemory.core.references

import com.google.gson.JsonObject
import java.net.URI

/**
 * NotionAdapter — [SourceAdapter] for the Notion MCP server (notion-fetch only).
 *
 * Only `metadata.type === "page"` is accepted. 32-hex page id is extracted
 * from the URL. Higher char budgets (30 KB/60 KB) since Notion pages are
 * typically larger than ticket descriptions.
 */
object NotionAdapter : SourceAdapter {

	private const val MAX_CHARS = 30000
	private const val MAX_TOTAL = 60000
	private val PAGE_ID_RE = Regex("[-/]([0-9a-fA-F]{32})(?=[/?#]|$)")
	private val ALLOWED_HOSTS = setOf("www.notion.so", "notion.so", "app.notion.com")

	override val id = SourceId.notion
	override val maxCharsPerReference = MAX_CHARS
	override val wrapperKeys = listOf("results", "items", "pages")

	override fun extractRef(payload: JsonObject, toolName: String, referencedAt: String): Reference? {
		val metadata = payload.objectOrNull("metadata") ?: return null
		val pageType = metadata.stringOrNull("type")
		if (pageType != "page") return null

		val title = payload.stringOrNull("title")
		if (title.isNullOrEmpty()) return null
		val url = payload.stringOrNull("url") ?: return null
		if (!isAllowedHost(url)) return null

		val matches = PAGE_ID_RE.findAll(url).toList()
		if (matches.isEmpty()) return null
		val pageId = matches.last().groupValues[1].lowercase()

		val text = payload.stringOrNull("text") ?: ""
		val envelope = NotionEnvelope.parse(text)

		return Reference(
			mapKey = "notion:$pageId",
			source = SourceId.notion,
			nativeId = pageId,
			title = title,
			url = url,
			fields = listOf(ReferenceField("entity-type", "Type", "page", "symbol-class")),
			description = envelope.content.ifEmpty { null },
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
		return "<notion-pages>\n${selected.joinToString("\n") { renderOne(it, maxPer) }}\n</notion-pages>"
	}

	private fun isAllowedHost(url: String): Boolean {
		return try {
			val u = URI(url)
			if (u.scheme != "https") return false
			val host = u.host ?: return false
			if (host in ALLOWED_HOSTS) return true
			host.endsWith(".notion.site")
		} catch (_: Exception) {
			false
		}
	}

	private fun renderOne(ref: Reference, maxChars: Int): String = buildString {
		appendLine("<page id=\"${PromptXmlEscape.escapeForAttr(ref.nativeId)}\">")
		appendLine("  <title>${PromptXmlEscape.escapeForText(ref.title)}</title>")
		appendLine("  <url>${PromptXmlEscape.escapeForText(ref.url)}</url>")
		if (ref.description != null) {
			appendLine("  <content>")
			appendLine(PromptXmlEscape.escapeForText(truncate(ref.description, maxChars)))
			appendLine("  </content>")
		}
		append("</page>")
	}
}

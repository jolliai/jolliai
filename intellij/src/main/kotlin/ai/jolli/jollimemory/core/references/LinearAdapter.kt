package ai.jolli.jollimemory.core.references

import com.google.gson.JsonObject

/**
 * LinearAdapter — [SourceAdapter] for the Linear MCP server.
 *
 * Validates `id` matches `^[A-Z][A-Z0-9_]*-\d+$`, reads
 * status/priority/labels/description from the payload.
 */
object LinearAdapter : SourceAdapter {

	private val TICKET_ID_RE = Regex("^[A-Z][A-Z0-9_]*-\\d+$")
	private val URL_RE = Regex("^https?://")
	private const val DEFAULT_MAX_CHARS = 4000
	private const val DEFAULT_MAX_TOTAL = 30000

	override val id = SourceId.linear
	override val maxCharsPerReference = DEFAULT_MAX_CHARS
	override val wrapperKeys = listOf("items", "issues", "nodes", "results")

	override fun extractRef(payload: JsonObject, toolName: String, referencedAt: String): Reference? {
		val ticketId = payload.stringOrNull("id") ?: return null
		if (!TICKET_ID_RE.matches(ticketId)) return null
		val title = payload.stringOrNull("title")
		if (title.isNullOrEmpty()) return null
		val url = payload.stringOrNull("url") ?: return null
		if (!URL_RE.containsMatchIn(url)) return null

		val status = payload.stringOrNull("status")?.ifEmpty { null }
		val priority = readPriority(payload)
		val labels = readLabels(payload)
		val description = payload.stringOrNull("description")?.ifEmpty { null }

		val fields = buildFields(status, priority, labels)
		return Reference(
			mapKey = "linear:$ticketId",
			source = SourceId.linear,
			nativeId = ticketId,
			title = title,
			url = url,
			fields = fields.ifEmpty { null },
			description = description,
			toolName = toolName,
			referencedAt = referencedAt,
		)
	}

	override fun renderPromptBlock(refs: List<Reference>, opts: RenderOptions): String {
		if (refs.isEmpty()) return ""
		val maxPer = opts.maxCharsPerReference ?: DEFAULT_MAX_CHARS
		val maxTotal = opts.maxTotalChars ?: DEFAULT_MAX_TOTAL
		val selected = selectByBudget(refs, maxPer, maxTotal) { renderOne(it, maxPer) }
		if (selected.isEmpty()) return ""
		return "<linear-issues>\n${selected.joinToString("\n") { renderOne(it, maxPer) }}\n</linear-issues>"
	}

	private fun readPriority(obj: JsonObject): String? {
		val p = obj.get("priority") ?: return null
		if (p.isJsonPrimitive && p.asJsonPrimitive.isString) {
			val s = p.asString
			return s.ifEmpty { null }
		}
		if (p.isJsonObject) {
			val name = p.asJsonObject.stringOrNull("name")
			return name?.ifEmpty { null }
		}
		return null
	}

	private fun readLabels(obj: JsonObject): List<String>? {
		val arr = obj.arrayOrNull("labels") ?: return null
		val strs = arr.filter { it.isJsonPrimitive && it.asJsonPrimitive.isString }
			.map { it.asString }
			.filter { it.isNotEmpty() }
		return strs.ifEmpty { null }
	}

	private fun buildFields(
		status: String?,
		priority: String?,
		labels: List<String>?,
	): List<ReferenceField> {
		val fields = mutableListOf<ReferenceField>()
		if (status != null) fields.add(ReferenceField("status", "Status", status, "circle-large-filled"))
		if (priority != null) fields.add(ReferenceField("priority", "Priority", priority, "flame"))
		if (!labels.isNullOrEmpty()) fields.add(ReferenceField("labels", "Labels", labels.joinToString(", "), "tag"))
		return fields
	}

	private fun renderOne(ref: Reference, maxChars: Int): String = buildString {
		val attrs = mutableListOf("id=\"${PromptXmlEscape.escapeForAttr(ref.nativeId)}\"")
		ref.fields?.forEach { f -> attrs.add("${f.key}=\"${PromptXmlEscape.escapeForAttr(f.value)}\"") }
		appendLine("<issue ${attrs.joinToString(" ")}>")
		appendLine("  <title>${PromptXmlEscape.escapeForText(ref.title)}</title>")
		appendLine("  <url>${PromptXmlEscape.escapeForText(ref.url)}</url>")
		if (ref.description != null) {
			appendLine("  <description>")
			appendLine(PromptXmlEscape.escapeForText(truncate(ref.description, maxChars)))
			appendLine("  </description>")
		}
		append("</issue>")
	}
}

/** Select refs by char budget, most-recent first, then re-sort chronologically. */
internal fun selectByBudget(
	refs: List<Reference>,
	maxPer: Int,
	maxTotal: Int,
	render: (Reference) -> String,
): List<Reference> {
	val sorted = refs.sortedBy { it.referencedAt }
	val reversed = sorted.reversed()
	val selected = mutableListOf<Reference>()
	var total = 0
	for (r in reversed) {
		val rendered = render(r)
		if (total + rendered.length > maxTotal) break
		selected.add(r)
		total += rendered.length
	}
	selected.reverse()
	return selected
}

internal fun truncate(s: String, max: Int): String {
	if (s.length <= max) return s
	return "${s.substring(0, max)}\n…[truncated, ${s.length - max} more chars]"
}

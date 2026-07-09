package ai.jolli.jollimemory.core.references

import com.google.gson.JsonObject

/**
 * JiraAdapter — [SourceAdapter] for the Atlassian Jira MCP server.
 *
 * Reads `key` as nativeId, `fields.summary` as title, `webUrl` as url.
 * Status/priority come from nested `fields.status.name` / `fields.priority.name`.
 */
object JiraAdapter : SourceAdapter {

	private val JIRA_KEY_RE = Regex("^[A-Z][A-Z0-9_]*-\\d+$")
	private val URL_RE = Regex("^https?://")
	private const val DEFAULT_MAX_CHARS = 4000
	private const val DEFAULT_MAX_TOTAL = 30000

	override val id = SourceId.jira
	override val maxCharsPerReference = DEFAULT_MAX_CHARS
	override val wrapperKeys = listOf("nodes", "issues", "items", "results")

	override fun extractRef(payload: JsonObject, toolName: String, referencedAt: String): Reference? {
		val key = payload.stringOrNull("key") ?: return null
		if (!JIRA_KEY_RE.matches(key)) return null
		val fields = payload.objectOrNull("fields") ?: return null
		val summary = fields.stringOrNull("summary")
		if (summary.isNullOrEmpty()) return null
		val url = payload.stringOrNull("webUrl") ?: return null
		if (!URL_RE.containsMatchIn(url)) return null

		val status = readNestedName(fields, "status")
		val priority = readNestedName(fields, "priority")
		val labels = readLabels(fields)
		val description = fields.stringOrNull("description")?.ifEmpty { null }

		val refFields = buildFields(status, priority, labels)
		return Reference(
			mapKey = "jira:$key",
			source = SourceId.jira,
			nativeId = key,
			title = summary,
			url = url,
			fields = refFields.ifEmpty { null },
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
		return "<jira-issues>\n${selected.joinToString("\n") { renderOne(it, maxPer) }}\n</jira-issues>"
	}

	/** Read `obj[field].name` or fall back to `obj[field]` as a string. */
	private fun readNestedName(obj: JsonObject, field: String): String? {
		val el = obj.get(field) ?: return null
		if (el.isJsonObject) {
			val name = el.asJsonObject.stringOrNull("name")
			return name?.ifEmpty { null }
		}
		if (el.isJsonPrimitive && el.asJsonPrimitive.isString) {
			val s = el.asString
			return s.ifEmpty { null }
		}
		return null
	}

	private fun readLabels(fields: JsonObject): List<String>? {
		val arr = fields.arrayOrNull("labels") ?: return null
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
		appendLine("  <url>${PromptXmlEscape.escapeForText(ref.url.orEmpty())}</url>")
		if (ref.description != null) {
			appendLine("  <description>")
			appendLine(PromptXmlEscape.escapeForText(truncate(ref.description, maxChars)))
			appendLine("  </description>")
		}
		append("</issue>")
	}
}

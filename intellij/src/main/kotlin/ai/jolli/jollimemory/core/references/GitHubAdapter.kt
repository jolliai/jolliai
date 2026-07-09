package ai.jolli.jollimemory.core.references

import com.google.gson.JsonObject

/**
 * GitHubAdapter — [SourceAdapter] for the GitHub MCP server.
 *
 * Derives `owner/repo#number` from `html_url` or `repository.full_name`.
 * HTML-entity-decodes `body` via [HtmlEntities].
 */
object GitHubAdapter : SourceAdapter {

	private val URL_RE = Regex("^https?://")
	private val HTML_URL_RE = Regex("^https?://github\\.com/([^/]+)/([^/]+)/(?:issues|pull)/(\\d+)")
	private const val DEFAULT_MAX_CHARS = 4000
	private const val DEFAULT_MAX_TOTAL = 30000

	override val id = SourceId.github
	override val maxCharsPerReference = DEFAULT_MAX_CHARS
	override val wrapperKeys = listOf("items", "issues", "nodes", "results")

	override fun extractRef(payload: JsonObject, toolName: String, referencedAt: String): Reference? {
		val number = payload.intOrNull("number") ?: return null
		val title = payload.stringOrNull("title")
		if (title.isNullOrEmpty()) return null
		val htmlUrl = payload.stringOrNull("html_url") ?: return null
		if (!URL_RE.containsMatchIn(htmlUrl)) return null

		val ownerRepo = deriveOwnerRepo(payload) ?: return null
		val nativeId = "${ownerRepo.first}/${ownerRepo.second}#$number"

		val state = payload.stringOrNull("state")?.ifEmpty { null }
		val labels = readStringList(payload, "labels")
		val assignees = readStringList(payload, "assignees")
		val milestone = readObjectName(payload.get("milestone"), "title")
		val entityType = readObjectName(payload.get("issue_type"), "name")
		val bodyRaw = payload.stringOrNull("body")?.ifEmpty { null }
		val description = bodyRaw?.let { HtmlEntities.decode(it) }

		val fields = buildFields(state, labels, assignees, milestone, entityType)
		return Reference(
			mapKey = "github:$nativeId",
			source = SourceId.github,
			nativeId = nativeId,
			title = title,
			url = htmlUrl,
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
		return "<github-issues>\n${selected.joinToString("\n") { renderOne(it, maxPer) }}\n</github-issues>"
	}

	private fun deriveOwnerRepo(obj: JsonObject): Pair<String, String>? {
		// Preferred: repository.full_name = "owner/repo"
		val repo = obj.objectOrNull("repository")
		if (repo != null) {
			val fullName = repo.stringOrNull("full_name")
			if (fullName != null) {
				val parts = fullName.split("/")
				if (parts.size == 2 && parts[0].isNotEmpty() && parts[1].isNotEmpty()) {
					return parts[0] to parts[1]
				}
			}
		}
		// Fallback: parse html_url
		val url = obj.stringOrNull("html_url") ?: return null
		val m = HTML_URL_RE.find(url) ?: return null
		return m.groupValues[1] to m.groupValues[2]
	}

	private fun readStringList(obj: JsonObject, key: String): List<String>? {
		val arr = obj.arrayOrNull(key) ?: return null
		val strs = arr.filter { it.isJsonPrimitive && it.asJsonPrimitive.isString }
			.map { it.asString }
			.filter { it.isNotEmpty() }
		return strs.ifEmpty { null }
	}

	/** Accept either `{name|title: string}` object form OR bare string. */
	private fun readObjectName(el: com.google.gson.JsonElement?, key: String): String? {
		if (el == null) return null
		if (el.isJsonPrimitive && el.asJsonPrimitive.isString) {
			val s = el.asString
			return s.ifEmpty { null }
		}
		if (el.isJsonObject) {
			val v = el.asJsonObject.stringOrNull(key)
			return v?.ifEmpty { null }
		}
		return null
	}

	private fun buildFields(
		status: String?,
		labels: List<String>?,
		assignees: List<String>?,
		milestone: String?,
		entityType: String?,
	): List<ReferenceField> {
		val fields = mutableListOf<ReferenceField>()
		if (status != null) fields.add(ReferenceField("status", "Status", status, "circle-large-filled"))
		if (!labels.isNullOrEmpty()) fields.add(ReferenceField("labels", "Labels", labels.joinToString(", "), "tag"))
		if (!assignees.isNullOrEmpty()) fields.add(ReferenceField("assignees", "Assignees", assignees.joinToString(", "), "account"))
		if (milestone != null) fields.add(ReferenceField("milestone", "Milestone", milestone, "milestone"))
		if (entityType != null) fields.add(ReferenceField("entity-type", "Type", entityType, "symbol-class"))
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

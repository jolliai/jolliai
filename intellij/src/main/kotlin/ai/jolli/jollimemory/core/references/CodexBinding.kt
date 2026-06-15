package ai.jolli.jollimemory.core.references

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject

/**
 * Codex producer binding — resolves `codex_apps` connector tool identities
 * to their source adapter.
 *
 * Two lookup paths mirror the two rollout shapes:
 *   - `function_call`     → (namespace suffix + short `name`)
 *   - `mcp_tool_call_end` → (`invocation.tool`)
 */
object CodexBinding {

	const val CODEX_APPS_NAMESPACE_PREFIX = "mcp__codex_apps__"

	interface Binding {
		val id: SourceId
		val namespaceSuffix: String
		val functionCallNames: Set<String>
		val invocationTools: Set<String>
		val canonicalToolName: String
		fun normalize(business: JsonElement?): JsonElement?
		/** Optional recovery for malformed output. Returns null when nothing usable. */
		fun recover(eventPayload: JsonElement?, rawOutput: String): JsonElement? = null
	}

	// --- Per-source bindings ---

	private val linear = object : Binding {
		override val id = SourceId.linear
		override val namespaceSuffix = "linear"
		override val functionCallNames = setOf("_fetch")
		override val invocationTools = setOf("linear_fetch")
		override val canonicalToolName = "mcp__linear__get_issue"
		override fun normalize(business: JsonElement?) = business
	}

	private val notion = object : Binding {
		override val id = SourceId.notion
		override val namespaceSuffix = "notion"
		override val functionCallNames = setOf("_fetch")
		override val invocationTools = setOf("notion_fetch")
		override val canonicalToolName = "mcp__claude_ai_Notion__notion-fetch"
		override fun normalize(business: JsonElement?) = business
	}

	private val github = object : Binding {
		override val id = SourceId.github
		override val namespaceSuffix = "github"
		override val functionCallNames = setOf("_fetch_issue", "_search_issues")
		override val invocationTools = setOf("github_fetch_issue", "github_search_issues")
		override val canonicalToolName = "mcp__github__issue_read"
		override fun normalize(business: JsonElement?): JsonElement? =
			normalizeEntities(business, listOf("issues")) { GitHubNormalize.reshape(it) }
	}

	private val jira = object : Binding {
		override val id = SourceId.jira
		override val namespaceSuffix = "atlassian_rovo"
		override val functionCallNames = setOf("_getjiraissue")
		override val invocationTools = setOf("atlassian rovo_getjiraissue")
		override val canonicalToolName = "mcp__claude_ai_Atlassian__getJiraIssue"

		override fun normalize(business: JsonElement?): JsonElement? = normalizeJira(business)

		override fun recover(eventPayload: JsonElement?, rawOutput: String): JsonElement? =
			recoverJiraWebUrl(eventPayload, rawOutput)
	}

	// --- Registry ---

	private val ALL_BINDINGS = listOf(linear, notion, github, jira)

	private val BY_NAMESPACE_SUFFIX: Map<String, Binding> =
		ALL_BINDINGS.associateBy { it.namespaceSuffix }

	private val BY_INVOCATION_TOOL: Map<String, Binding> =
		ALL_BINDINGS.flatMap { b -> b.invocationTools.map { tool -> tool to b } }.toMap()

	/** Resolve a `function_call`'s (namespace, short name) to its binding. */
	fun fromFunctionCall(namespace: String, name: String): Binding? {
		if (!namespace.startsWith(CODEX_APPS_NAMESPACE_PREFIX)) return null
		val suffix = namespace.substring(CODEX_APPS_NAMESPACE_PREFIX.length)
		val binding = BY_NAMESPACE_SUFFIX[suffix] ?: return null
		return if (name in binding.functionCallNames) binding else null
	}

	/** Resolve a `mcp_tool_call_end` event's `invocation.tool` to its binding. */
	fun fromInvocationTool(tool: String): Binding? = BY_INVOCATION_TOOL[tool]

	// --- Jira-specific normalization ---

	private val WEB_URL_FIELD = Regex(""""webUrl"\s*:\s*"(https://[^"\s]+/browse/[^"\s]+)"""")

	private fun latestRepresentation(versioned: JsonObject?, field: String): JsonElement? {
		val rep = versioned?.objectOrNull(field) ?: return null
		var best: JsonElement? = null
		var bestVersion = -1.0
		for ((version, value) in rep.entrySet()) {
			val n = version.toDoubleOrNull()
			if (n != null && n > bestVersion) {
				best = value
				bestVersion = n
			}
		}
		return best
	}

	/** Minimal ADF (Atlassian Document Format) → plain text. */
	private fun adfToText(node: JsonElement?): String {
		if (node == null || !node.isJsonObject) return ""
		val obj = node.asJsonObject
		val type = obj.stringOrNull("type")
		if (type == "text") return obj.stringOrNull("text") ?: ""
		val children = obj.arrayOrNull("content") ?: JsonArray()
		val inline = children.joinToString("") { adfToText(it) }
		return when (type) {
			"heading" -> {
				val level = obj.objectOrNull("attrs")?.intOrNull("level") ?: 1
				"${"#".repeat(level.coerceIn(1, 6))} $inline"
			}
			"paragraph", "codeBlock" -> inline
			"blockquote" -> children.joinToString("\n") { "> ${adfToText(it)}" }
			"bulletList" -> children.joinToString("\n") { "- ${adfToText(it)}" }
			"orderedList" -> children.mapIndexed { i, c -> "${i + 1}. ${adfToText(c)}" }.joinToString("\n")
			"doc" -> children.joinToString("\n\n") { adfToText(it) }
			else -> inline
		}
	}

	private fun descriptionFromVersionedRepresentations(versioned: JsonObject?): String? {
		val value = latestRepresentation(versioned, "description") ?: return null
		val text = if (value.isJsonPrimitive && value.asJsonPrimitive.isString) value.asString else adfToText(value)
		val trimmed = text.trim()
		return trimmed.ifEmpty { null }
	}

	private fun reshapeJiraNode(node: JsonElement?): JsonElement? {
		if (node == null || !node.isJsonObject) return node
		val obj = node.asJsonObject
		val existing = obj.objectOrNull("fields")
		// Already adapter-shaped: leave it.
		if (existing != null) {
			val summary = existing.stringOrNull("summary")
			if (!summary.isNullOrEmpty()) return node
		}
		val versioned = obj.objectOrNull("versionedRepresentations")
		val summaryValue = latestRepresentation(versioned, "summary")
		if (summaryValue == null || !summaryValue.isJsonPrimitive) return node
		val summaryStr = summaryValue.asString
		if (summaryStr.isEmpty()) return node

		val fields = existing?.deepCopy() ?: JsonObject()
		fields.addProperty("summary", summaryStr)
		val description = descriptionFromVersionedRepresentations(versioned)
		if (description != null) fields.addProperty("description", description)

		val result = obj.deepCopy()
		result.add("fields", fields)
		return result
	}

	private fun normalizeJira(business: JsonElement?): JsonElement? {
		if (business == null || !business.isJsonObject) return business
		val obj = business.asJsonObject
		val issues = obj.objectOrNull("issues")
		if (issues != null) {
			val nodes = issues.arrayOrNull("nodes")
			if (nodes != null) {
				val newNodes = JsonArray()
				nodes.forEach { newNodes.add(reshapeJiraNode(it)) }
				val newIssues = issues.deepCopy()
				newIssues.add("nodes", newNodes)
				val result = obj.deepCopy()
				result.add("issues", newIssues)
				return result
			}
		}
		return reshapeJiraNode(business)
	}

	private fun recoverJiraWebUrl(eventPayload: JsonElement?, rawOutput: String): JsonElement? {
		if (eventPayload == null || !eventPayload.isJsonObject) return null
		val obj = eventPayload.asJsonObject
		val existing = obj.stringOrNull("webUrl")
		if (!existing.isNullOrEmpty()) return eventPayload
		val urlMatch = WEB_URL_FIELD.find(rawOutput) ?: return null
		val result = obj.deepCopy()
		result.addProperty("webUrl", urlMatch.groupValues[1])
		return normalizeJira(result)
	}

	// --- Shared normalization helper ---

	/** Handle both single-entity and collection-wrapped responses. */
	private fun normalizeEntities(
		business: JsonElement?,
		collectionKeys: List<String>,
		normalizeEntity: (JsonElement?) -> JsonElement?,
	): JsonElement? {
		if (business == null || !business.isJsonObject) return business
		val obj = business.asJsonObject
		for (key in collectionKeys) {
			val arr = obj.arrayOrNull(key)
			if (arr != null) {
				val newArr = JsonArray()
				arr.forEach { newArr.add(normalizeEntity(it)) }
				val result = obj.deepCopy()
				result.add(key, newArr)
				return result
			}
		}
		return normalizeEntity(business)
	}
}

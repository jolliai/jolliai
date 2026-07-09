package ai.jolli.jollimemory.core.references

import ai.jolli.jollimemory.core.JmLogger
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * ClaudeEnvelopeParser — the Claude Code transcript envelope.
 *
 * Pairs `tool_use` blocks (assistant role) with `tool_result` blocks (user role)
 * by `tool_use_id`. Uses the [ClaudeBinding] to resolve which source adapter
 * each tool call belongs to.
 */
object ClaudeEnvelopeParser : TranscriptEnvelopeParser {

	private val log = JmLogger.create("ClaudeEnvelopeParser")
	private const val TOOL_USE_ID_SUBSTR = "\"tool_use_id\""

	private data class PendingEntry(
		val toolName: String,
		val timestamp: String?,
		val adapter: SourceAdapter,
		val normalize: (JsonElement?) -> JsonElement?,
		/** CLI (shell) entries require a successful command. */
		val requireSuccess: Boolean,
		/**
		 * The tool_use `input`, retained only for Slack (`adapter.id == slack`).
		 * Slack's normalize needs both the payload AND out-of-payload context
		 * (`channel_id` / `message_ts` from the originating tool_use) that no other
		 * source needs — every other MCP source's normalize is identity and never
		 * looks at this field.
		 */
		val toolInput: JsonObject? = null,
	)

	override fun parse(lines: List<String>, opts: ExtractOptions, adapters: List<SourceAdapter>): EnvelopeParseResult {
		val nameNeedles = buildList {
			ClaudeBinding.TOOL_PREFIXES.forEach { add("\"name\":\"$it") }
			ClaudeBinding.SHELL_TOOL_NAMES.forEach { add("\"name\":\"$it\"") }
		}
		val adapterFor = { id: SourceId -> adapters.find { it.id == id } }

		val fromLine = opts.fromLineNumber ?: 0
		val pending = mutableMapOf<String, PendingEntry>()
		val results = mutableListOf<NormalizedToolResult>()
		var lastConsumed = fromLine
		// Slack's normalize needs a url no MCP payload carries; the pasted permalink
		// (if any) is the only place it lives. Scanned once up front so every user
		// text line is visited exactly once regardless of how many Slack
		// tool_results follow it.
		val permalinks = SlackPermalink.scanUserPermalinks(lines)

		for (i in fromLine until lines.size) {
			val line = lines[i]
			lastConsumed = i + 1
			if (line.isBlank()) continue

			val hasAdapterNeedle = nameNeedles.any { line.contains(it) }
			val couldBeToolResult = pending.isNotEmpty() && line.contains(TOOL_USE_ID_SUBSTR)
			if (!hasAdapterNeedle && !couldBeToolResult) continue

			val parsed: JsonObject
			try {
				val el = JsonParser.parseString(line)
				if (!el.isJsonObject) continue
				parsed = el.asJsonObject
			} catch (e: Exception) {
				log.warn("Skipping malformed transcript line %d: %s", i, e.message)
				continue
			}

			val role = readRole(parsed) ?: continue
			val blocks = readContentBlocks(parsed) ?: continue
			val timestamp = readTimestamp(parsed)

			when (role) {
				"assistant" -> collectToolUses(blocks, timestamp, opts.beforeTimestamp, pending, adapterFor)
				"user" -> collectToolResults(blocks, i + 1, timestamp, opts.beforeTimestamp, pending, results, permalinks, opts)
			}
		}

		return EnvelopeParseResult(results, lastConsumed)
	}

	private fun readRole(parsed: JsonObject): String? {
		val message = parsed.objectOrNull("message") ?: return null
		val role = message.stringOrNull("role") ?: return null
		return if (role == "assistant" || role == "user") role else null
	}

	private fun readContentBlocks(parsed: JsonObject): JsonArray? {
		val message = parsed.objectOrNull("message") ?: return null
		return message.arrayOrNull("content")
	}

	private fun readTimestamp(parsed: JsonObject): String? = parsed.stringOrNull("timestamp")

	private fun collectToolUses(
		blocks: JsonArray,
		timestamp: String?,
		beforeTimestamp: String?,
		pending: MutableMap<String, PendingEntry>,
		adapterFor: (SourceId) -> SourceAdapter?,
	) {
		if (beforeTimestamp != null && timestamp != null && timestamp > beforeTimestamp) return
		for (block in blocks) {
			if (!block.isJsonObject) continue
			val b = block.asJsonObject
			if (b.stringOrNull("type") != "tool_use") continue
			val id = b.stringOrNull("id") ?: continue
			val name = b.stringOrNull("name") ?: continue
			val input = b.objectOrNull("input")
			val resolved = ClaudeBinding.resolve(name, input) ?: continue
			val adapter = adapterFor(resolved.sourceId) ?: continue
			pending[id] = PendingEntry(
				toolName = resolved.toolName,
				timestamp = timestamp,
				adapter = adapter,
				normalize = resolved.normalize,
				requireSuccess = resolved.kind == ClaudeBinding.Kind.cli,
				// Only Slack's normalize needs the tool_use input (channel_id /
				// message_ts); every other source's normalize is identity and never
				// reads toolInput, so it's left null for them.
				toolInput = if (adapter.id == SourceId.slack) input else null,
			)
		}
	}

	/** `{channelId, messageTs}` off a Slack tool_use's `input`, or null if malformed. */
	private fun readSlackToolInput(input: JsonObject?): Pair<String, String>? {
		if (input == null) return null
		val channelId = input.stringOrNull("channel_id") ?: return null
		val messageTs = input.stringOrNull("message_ts") ?: return null
		return channelId to messageTs
	}

	private fun collectToolResults(
		blocks: JsonArray,
		lineNumber: Int,
		timestamp: String?,
		beforeTimestamp: String?,
		pending: MutableMap<String, PendingEntry>,
		results: MutableList<NormalizedToolResult>,
		permalinks: Map<String, String>,
		opts: ExtractOptions,
	) {
		if (beforeTimestamp != null && timestamp != null && timestamp > beforeTimestamp) return
		for (block in blocks) {
			if (!block.isJsonObject) continue
			val b = block.asJsonObject
			if (b.stringOrNull("type") != "tool_result") continue
			val toolUseId = b.stringOrNull("tool_use_id") ?: continue
			val pendingEntry = pending[toolUseId] ?: continue
			// CLI entries require success
			if (pendingEntry.requireSuccess && b.boolOrNull("is_error") == true) {
				pending.remove(toolUseId)
				continue
			}
			val payloadText = extractResultPayloadText(b.get("content"))
			if (payloadText == null) {
				pending.remove(toolUseId)
				continue
			}
			val parsedPayload: JsonElement
			try {
				parsedPayload = JsonParser.parseString(payloadText)
			} catch (e: Exception) {
				log.warn("Dropping tool_result for %s (%s): payload parse failed: %s", toolUseId, pendingEntry.toolName, e.message)
				pending.remove(toolUseId)
				continue
			}

			// Slack needs both the payload AND out-of-payload context (channel_id /
			// message_ts from the tool_use, url from the permalink map or config) that
			// no other source's identity normalize reads. Handled as a distinct branch:
			// build a synthetic canonical payload the SlackAdapter reads with plain
			// paths, keeping SourceAdapter.extractRef's signature unchanged.
			if (pendingEntry.adapter.id == SourceId.slack) {
				val slackInput = readSlackToolInput(pendingEntry.toolInput)
				if (slackInput == null) {
					pending.remove(toolUseId)
					continue
				}
				val (channelId, messageTs) = slackInput
				val url = permalinks["$channelId:$messageTs"]
					?: opts.slackWorkspaceUrl?.let { "$it/archives/$channelId/p${messageTs.replace(".", "")}" }
				val canonical = SlackNormalize.normalizeSlackThread(parsedPayload, channelId, url)
				if (canonical == null) {
					pending.remove(toolUseId)
					continue
				}
				val synthetic = JsonObject().apply {
					addProperty("channelId", canonical.channelId)
					addProperty("parentTs", canonical.parentTs)
					addProperty("title", canonical.title)
					addProperty("text", canonical.text)
					addProperty("replyCount", canonical.replyCount)
					if (canonical.url != null) addProperty("url", canonical.url)
				}
				results.add(NormalizedToolResult(
					adapter = pendingEntry.adapter,
					toolName = pendingEntry.toolName,
					payload = synthetic,
					lineNumber = lineNumber,
					referencedAt = timestamp ?: "",
				))
				pending.remove(toolUseId)
				continue
			}

			results.add(NormalizedToolResult(
				adapter = pendingEntry.adapter,
				toolName = pendingEntry.toolName,
				payload = pendingEntry.normalize(parsedPayload),
				lineNumber = lineNumber,
				referencedAt = timestamp ?: "",
			))
			pending.remove(toolUseId)
		}
	}

	private fun extractResultPayloadText(content: JsonElement?): String? {
		if (content == null) return null
		if (content.isJsonPrimitive && content.asJsonPrimitive.isString) return content.asString
		if (!content.isJsonArray) return null
		val parts = mutableListOf<String>()
		for (block in content.asJsonArray) {
			if (!block.isJsonObject) continue
			val b = block.asJsonObject
			if (b.stringOrNull("type") == "text") {
				val text = b.stringOrNull("text")
				if (text != null) parts.add(text)
			}
		}
		return if (parts.isNotEmpty()) parts.joinToString("") else null
	}
}

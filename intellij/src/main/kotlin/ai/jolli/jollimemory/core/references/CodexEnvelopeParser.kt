package ai.jolli.jollimemory.core.references

import ai.jolli.jollimemory.core.JmLogger
import com.google.gson.JsonElement
import com.google.gson.JsonParser

/**
 * CodexEnvelopeParser — the OpenAI Codex `codex_apps` connector envelope.
 *
 * Codex rollout JSONL encodes each MCP call across up to three line types:
 *   - `function_call`        — request
 *   - `function_call_output` — result (PRIMARY, richest payload)
 *   - `mcp_tool_call_end`    — event (FALLBACK)
 *
 * This parser correlates request+result by `call_id`.
 */
object CodexEnvelopeParser : TranscriptEnvelopeParser {

	private val log = JmLogger.create("CodexEnvelopeParser")
	private const val OUTPUT_MARKER = "\nOutput:\n"
	private val EXIT_CODE_RE = Regex("^Exit code:\\s*(-?\\d+)")

	override fun parse(lines: List<String>, opts: ExtractOptions, adapters: List<SourceAdapter>): EnvelopeParseResult {
		val fromLine = opts.fromLineNumber ?: 0
		val adapterFor = { id: SourceId -> adapters.find { it.id == id } }

		val calls = mutableMapOf<String, FunctionCallRow>()
		val shellCalls = mutableMapOf<String, ShellCallRow>()
		val outputs = mutableMapOf<String, FunctionOutputRow>()
		val events = mutableListOf<ToolCallEndRow>()
		val resultSeen = mutableSetOf<String>()
		var lastConsumed = fromLine

		for (i in fromLine until lines.size) {
			val line = lines[i]
			lastConsumed = i + 1
			if (line.isEmpty()) continue

			if (!line.contains("mcp__codex_apps__") &&
				!line.contains("mcp_tool_call_end") &&
				!line.contains("function_call_output") &&
				!line.contains("shell_command")
			) continue

			val parsed: com.google.gson.JsonObject
			try {
				val el = JsonParser.parseString(line)
				if (!el.isJsonObject) continue
				parsed = el.asJsonObject
			} catch (e: Exception) {
				log.warn("Skipping malformed Codex line %d: %s", i, e.message)
				continue
			}

			val payload = parsed.objectOrNull("payload") ?: continue
			val referencedAt = parsed.stringOrNull("timestamp") ?: ""
			val callId = payload.stringOrNull("call_id")
			val type = payload.stringOrNull("type")

			when (type) {
				"function_call" -> {
					val namespace = payload.stringOrNull("namespace")
					val name = payload.stringOrNull("name")
					// Shell CLI fallback
					if (callId != null && name == "shell_command") {
						val command = readShellCommand(payload.stringOrNull("arguments"))
						if (command != null) {
							val binding = CliBinding.matchCommand(command)
							if (binding != null) shellCalls[callId] = ShellCallRow(binding, i)
						}
					} else if (callId != null && namespace != null && name != null) {
						calls[callId] = FunctionCallRow(namespace, name, i)
					}
				}
				"function_call_output" -> {
					val output = payload.stringOrNull("output")
					if (callId != null) resultSeen.add(callId)
					if (afterCutoff(referencedAt, opts.beforeTimestamp)) {}
					else if (callId != null && output != null) {
						outputs[callId] = FunctionOutputRow(output, i + 1, referencedAt)
					}
				}
				"mcp_tool_call_end" -> {
					if (callId != null) resultSeen.add(callId)
					if (afterCutoff(referencedAt, opts.beforeTimestamp)) {}
					else {
						val tool = readInvocationTool(payload)
						val text = readToolCallEndText(payload)
						if (tool != null && text != null) {
							events.add(ToolCallEndRow(callId, tool, text, i + 1, referencedAt))
						}
					}
				}
			}
		}

		val results = mutableListOf<NormalizedToolResult>()
		val emitted = mutableSetOf<String>()

		// PRIMARY: function_call + function_call_output pairs
		for ((callId, out) in outputs) {
			val call = calls[callId] ?: continue
			val binding = CodexBinding.fromFunctionCall(call.namespace, call.name) ?: continue
			val business = parseFunctionCallOutput(out.output) ?: continue
			val adapter = adapterFor(binding.id) ?: continue
			results.add(NormalizedToolResult(
				adapter = adapter,
				toolName = binding.canonicalToolName,
				payload = binding.normalize(business),
				lineNumber = out.lineNumber,
				referencedAt = out.referencedAt,
			))
			emitted.add(callId)
		}

		// PRIMARY (CLI): shell_command + function_call_output pairs
		for ((callId, shell) in shellCalls) {
			val out = outputs[callId] ?: continue
			if (readExitCode(out.output) != 0) continue
			val business = parseFunctionCallOutput(out.output) ?: continue
			val adapter = adapterFor(shell.binding.id) ?: continue
			results.add(NormalizedToolResult(
				adapter = adapter,
				toolName = shell.binding.canonicalToolName,
				payload = shell.binding.normalize(business),
				lineNumber = out.lineNumber,
				referencedAt = out.referencedAt,
			))
		}

		// FALLBACK: mcp_tool_call_end events for call_ids without paired output
		for (ev in events) {
			if (ev.callId != null && ev.callId in emitted) continue
			val binding = CodexBinding.fromInvocationTool(ev.tool) ?: continue
			var business: JsonElement? = tryParse(ev.text) ?: continue
			// Recovery for malformed output
			if (ev.callId != null) {
				val rawOutput = outputs[ev.callId]?.output
				if (rawOutput != null) {
					val stitched = binding.recover(business, rawOutput)
					if (stitched != null) business = stitched
				}
			}
			val adapter = adapterFor(binding.id) ?: continue
			results.add(NormalizedToolResult(
				adapter = adapter,
				toolName = binding.canonicalToolName,
				payload = binding.normalize(business),
				lineNumber = ev.lineNumber,
				referencedAt = ev.referencedAt,
			))
		}

		// Sort by line number for stable dedupe ordering
		results.sortBy { it.lineNumber }

		// Cursor-hold: pull back before any in-flight request
		var safeCursor = lastConsumed
		for ((callId, call) in calls) {
			if (callId in resultSeen) continue
			if (CodexBinding.fromFunctionCall(call.namespace, call.name) == null) continue
			if (call.lineIndex < safeCursor) safeCursor = call.lineIndex
		}
		for ((callId, shell) in shellCalls) {
			if (callId in resultSeen) continue
			if (shell.lineIndex < safeCursor) safeCursor = shell.lineIndex
		}

		return EnvelopeParseResult(results, safeCursor)
	}

	// --- Internal types ---

	private data class FunctionCallRow(val namespace: String, val name: String, val lineIndex: Int)
	private data class FunctionOutputRow(val output: String, val lineNumber: Int, val referencedAt: String)
	private data class ToolCallEndRow(val callId: String?, val tool: String, val text: String, val lineNumber: Int, val referencedAt: String)
	private data class ShellCallRow(val binding: CliBinding.Binding, val lineIndex: Int)

	// --- Helpers ---

	private fun afterCutoff(referencedAt: String, cutoff: String?): Boolean =
		cutoff != null && referencedAt.isNotEmpty() && referencedAt > cutoff

	private fun parseFunctionCallOutput(output: String): JsonElement? {
		var text = output
		if (text.startsWith("Wall time:") || text.startsWith("Exit code:")) {
			val idx = text.indexOf(OUTPUT_MARKER)
			if (idx >= 0) text = text.substring(idx + OUTPUT_MARKER.length)
		}
		val parsed = tryParse(text) ?: return null
		return unwrapTextArray(parsed)
	}

	private fun readShellCommand(args: String?): String? {
		if (args == null) return null
		val parsed = tryParse(args)
		if (parsed == null || !parsed.isJsonObject) return null
		return parsed.asJsonObject.stringOrNull("command")
	}

	private fun readExitCode(output: String): Int? {
		val m = EXIT_CODE_RE.find(output) ?: return null
		return m.groupValues[1].toIntOrNull()
	}

	private fun tryParse(s: String): JsonElement? =
		runCatching { JsonParser.parseString(s) }.getOrNull()

	private fun unwrapTextArray(value: JsonElement): JsonElement {
		if (!value.isJsonArray) return value
		val arr = value.asJsonArray
		if (arr.size() == 0) return value
		val first = arr[0]
		if (!first.isJsonObject) return value
		val obj = first.asJsonObject
		if (obj.stringOrNull("type") == "text") {
			val text = obj.stringOrNull("text") ?: return value
			return tryParse(text) ?: value
		}
		return value
	}

	private fun readInvocationTool(payload: com.google.gson.JsonObject): String? {
		val invocation = payload.objectOrNull("invocation") ?: return null
		return invocation.stringOrNull("tool")
	}

	private fun readToolCallEndText(payload: com.google.gson.JsonObject): String? {
		val result = payload.objectOrNull("result") ?: return null
		val ok = result.objectOrNull("Ok") ?: return null
		val content = ok.arrayOrNull("content") ?: return null
		if (content.size() == 0) return null
		val first = content[0]
		if (!first.isJsonObject) return null
		val obj = first.asJsonObject
		return if (obj.stringOrNull("type") == "text") obj.stringOrNull("text") else null
	}
}

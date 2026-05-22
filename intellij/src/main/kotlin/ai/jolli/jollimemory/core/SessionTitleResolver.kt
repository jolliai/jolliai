package ai.jolli.jollimemory.core

import com.google.gson.JsonParser
import java.io.File

/**
 * SessionTitleResolver — Kotlin port of SessionTitleResolver.ts
 *
 * Resolves the display title for a single session.
 *
 * Priority:
 *   1. SessionInfo.title (pre-populated by discoverers for opencode/cursor/copilot)
 *   2. Source-specific native reader (Claude's ai-title)
 *   3. First user message truncated to 60 code points
 *   4. "(untitled session)"
 */
object SessionTitleResolver {

	private val log = JmLogger.create("SessionTitleResolver")

	/**
	 * Resolves a display title for the given session.
	 *
	 * @param session the session metadata
	 * @param mergedEntries optional pre-loaded transcript entries; when provided,
	 *   skips the disk read for the first-user-message fallback
	 */
	fun resolveSessionTitle(
		session: SessionInfo,
		mergedEntries: List<TranscriptEntry>? = null,
	): String {
		// 1. Pre-populated native title (cheap path for opencode/cursor/copilot)
		val nativeTitle = session.title?.trim()
		if (!nativeTitle.isNullOrEmpty()) {
			return FallbackTitle.truncateToCodePoints(nativeTitle, FallbackTitle.TITLE_MAX_CODE_POINTS)
		}

		val source = session.source ?: TranscriptSource.claude

		// 2. Claude-specific ai-title from JSONL
		if (source == TranscriptSource.claude) {
			try {
				val aiTitle = readClaudeAiTitle(session.transcriptPath)
				if (!aiTitle.isNullOrEmpty()) {
					return FallbackTitle.truncateToCodePoints(aiTitle, FallbackTitle.TITLE_MAX_CODE_POINTS)
				}
			} catch (e: Exception) {
				log.debug("readClaudeAiTitle threw for %s: %s", session.transcriptPath, e.message)
			}
		}

		// 3. First user message from pre-loaded entries or streamed from disk
		if (mergedEntries != null) {
			return firstUserMessageTitleFromEntries(mergedEntries)
		}
		return try {
			FallbackTitle.readFirstUserMessageTitle(
				session.transcriptPath,
				getParseLineForSource(source),
			)
		} catch (e: Exception) {
			log.debug("readFirstUserMessageTitle threw for %s/%s: %s", source, session.transcriptPath, e.message)
			FallbackTitle.UNTITLED_SESSION
		}
	}

	/**
	 * Extracts the title from an already-materialized entry array.
	 * Returns the first human turn's content truncated, or UNTITLED_SESSION.
	 */
	fun firstUserMessageTitleFromEntries(entries: List<TranscriptEntry>): String {
		for (entry in entries) {
			if (entry.role != "human") continue
			if (entry.content.trim().isEmpty()) continue
			return FallbackTitle.truncateToCodePoints(entry.content, FallbackTitle.TITLE_MAX_CODE_POINTS)
		}
		return FallbackTitle.UNTITLED_SESSION
	}

	// ── Claude ai-title reader ──────────────────────────────────────────────

	private const val AI_TITLE_FRAGMENT = "\"type\":\"ai-title\""

	/**
	 * Reads Claude Code's native session title from a transcript JSONL.
	 * Streams the file once, remembering the most recent `aiTitle` value.
	 */
	private fun readClaudeAiTitle(transcriptPath: String): String? {
		val file = File(transcriptPath)
		if (!file.exists()) return null
		var latest: String? = null
		try {
			file.bufferedReader(Charsets.UTF_8).useLines { lines ->
				for (line in lines) {
					if (!line.contains(AI_TITLE_FRAGMENT)) continue
					try {
						val obj = JsonParser.parseString(line).asJsonObject
						val aiTitle = obj.get("aiTitle")?.asString
						if (!aiTitle.isNullOrEmpty()) {
							latest = aiTitle
						}
					} catch (_: Exception) {
						// Skip malformed ai-title row
					}
				}
			}
		} catch (e: Exception) {
			log.debug("readClaudeAiTitle stream failed for %s: %s", transcriptPath, e.message)
			return null
		}
		return latest
	}

	// ── Per-source line parsers ─────────────────────────────────────────────

	private fun getParseLineForSource(source: TranscriptSource): (String) -> String? = when (source) {
		TranscriptSource.claude -> ::parseClaudeUserLine
		TranscriptSource.codex -> ::parseCodexUserLine
		TranscriptSource.gemini -> ::parseGeminiUserLine
		TranscriptSource.opencode -> { _ -> null } // OpenCode carries native title
		TranscriptSource.cursor -> { _ -> null } // Cursor carries native title
		TranscriptSource.copilot -> { _ -> null }
		TranscriptSource.`copilot-chat` -> { _ -> null }
	}

	private fun parseClaudeUserLine(line: String): String? {
		val obj = safeParse(line) ?: return null
		if (obj.get("type")?.asString != "user") return null
		val message = obj.getAsJsonObject("message")
		val content = message?.get("content") ?: obj.get("content")
		return stringifyContent(content)
	}

	private fun parseCodexUserLine(line: String): String? {
		val obj = safeParse(line) ?: return null
		if (obj.get("role")?.asString != "user") return null
		return stringifyContent(obj.get("content"))
	}

	private fun parseGeminiUserLine(line: String): String? {
		val obj = safeParse(line) ?: return null
		if (obj.get("type")?.asString != "user") return null
		val direct = stringifyContent(obj.get("content"))
		if (direct != null) return direct
		val text = obj.get("text")?.asString
		if (text != null) return text
		return null
	}

	private fun safeParse(line: String): com.google.gson.JsonObject? = try {
		val elem = JsonParser.parseString(line)
		if (elem.isJsonObject) elem.asJsonObject else null
	} catch (_: Exception) {
		null
	}

	private fun stringifyContent(content: com.google.gson.JsonElement?): String? {
		if (content == null) return null
		if (content.isJsonPrimitive && content.asJsonPrimitive.isString) return content.asString
		if (content.isJsonArray) {
			val parts = mutableListOf<String>()
			for (block in content.asJsonArray) {
				if (block.isJsonPrimitive && block.asJsonPrimitive.isString) {
					parts.add(block.asString)
				} else if (block.isJsonObject) {
					val text = block.asJsonObject.get("text")?.asString
					if (text != null) parts.add(text)
				}
			}
			return parts.takeIf { it.isNotEmpty() }?.joinToString(" ")
		}
		return null
	}
}

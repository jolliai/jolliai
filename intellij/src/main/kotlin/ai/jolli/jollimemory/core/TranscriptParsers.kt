package ai.jolli.jollimemory.core

import com.google.gson.JsonParser

/**
 * TranscriptParsers — Kotlin port of TranscriptParser.ts
 *
 * Strategy pattern for multi-agent JSONL parsing.
 */

/** Claude Code transcript parser — delegates to TranscriptReader. */
class ClaudeTranscriptParser : TranscriptParser {
    override fun parseLine(line: String, lineNum: Int): TranscriptEntry? {
        return TranscriptReader.parseTranscriptLine(line, lineNum)
    }
}

/** OpenAI Codex CLI transcript parser. */
class CodexTranscriptParser : TranscriptParser {
    private val log = JmLogger.create("TranscriptParser")

    override fun parseLine(line: String, lineNum: Int): TranscriptEntry? {
        return try {
            val data = JsonParser.parseString(line).asJsonObject
            val timestamp = data.get("timestamp")?.asString
            val type = data.get("type")?.asString
            if (type != "event_msg") return null

            val payload = data.getAsJsonObject("payload") ?: return null
            val payloadType = payload.get("type")?.asString

            when (payloadType) {
                "user_message" -> {
                    val message = payload.get("message")?.asString?.trim()
                    if (message.isNullOrEmpty()) null
                    else TranscriptEntry("human", message, timestamp)
                }
                "agent_message" -> {
                    val message = payload.get("message")?.asString?.trim()
                    if (message.isNullOrEmpty()) null
                    else TranscriptEntry("assistant", message, timestamp)
                }
                else -> null
            }
        } catch (e: Exception) {
            log.debug("Failed to parse Codex transcript line %d: %s", lineNum, e.message)
            null
        }
    }
}

/** Factory function returning the appropriate parser for a transcript source. */
fun getParserForSource(source: TranscriptSource): TranscriptParser {
    return when (source) {
        TranscriptSource.codex -> CodexTranscriptParser()
        TranscriptSource.claude -> ClaudeTranscriptParser()
        TranscriptSource.gemini -> ClaudeTranscriptParser() // Gemini uses dedicated reader
    }
}

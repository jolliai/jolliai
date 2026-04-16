package ai.jolli.jollimemory.core

import com.google.gson.JsonParser
import java.io.File

/**
 * GeminiSupport — Kotlin port of GeminiSessionDetector.ts + GeminiTranscriptReader.ts
 */
object GeminiSupport {

    private val log = JmLogger.create("GeminiSupport")

    /** Check if Gemini CLI is installed (~/.gemini/ exists). */
    fun isGeminiInstalled(): Boolean {
        val home = System.getProperty("user.home")
        return File("$home/.gemini").isDirectory
    }

    /** Reads a Gemini session transcript JSON file into TranscriptEntry list. */
    fun readGeminiTranscript(sessionPath: String): List<TranscriptEntry> {
        return try {
            val content = File(sessionPath).readText(Charsets.UTF_8)
            val json = JsonParser.parseString(content)
            val entries = mutableListOf<TranscriptEntry>()

            if (json.isJsonObject) {
                val messages = json.asJsonObject.getAsJsonArray("messages") ?: return emptyList()
                for (msg in messages) {
                    if (!msg.isJsonObject) continue
                    val obj = msg.asJsonObject
                    val role = obj.get("role")?.asString ?: continue
                    val text = obj.get("content")?.asString ?: continue
                    val mappedRole = when (role) {
                        "user" -> "human"
                        "model", "assistant" -> "assistant"
                        else -> continue
                    }
                    entries.add(TranscriptEntry(mappedRole, text))
                }
            }

            log.info("Read %d entries from Gemini transcript", entries.size)
            entries
        } catch (e: Exception) {
            log.error("Failed to read Gemini transcript: %s", e.message)
            emptyList()
        }
    }
}

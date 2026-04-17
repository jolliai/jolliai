package ai.jolli.jollimemory.core

import com.google.gson.JsonParser
import java.io.File

/**
 * TranscriptReader — Kotlin port of TranscriptReader.ts
 *
 * Parses Claude Code JSONL transcript files with cursor-based resumption.
 */
object TranscriptReader {

    private val log = JmLogger.create("TranscriptReader")
    private const val DEFAULT_MAX_CHARS = 50000
    /** Skip transcript files larger than 50 MB to avoid OOM */
    private const val MAX_FILE_SIZE_BYTES = 50L * 1024 * 1024

    /** Prefixes of user messages to skip (system-generated noise) */
    private val SKIP_USER_PREFIXES = listOf(
        "Base directory for this skill:",
        "[Request interrupted by user",
    )

    /** IDE context tags to strip from user messages */
    private val IDE_TAG_PATTERN = Regex(
        "<(?:system-reminder|ide_opened_file|ide_selection|local-command-caveat|command-name|command-message|command-args|local-command-stdout)>[\\s\\S]*?</(?:system-reminder|ide_opened_file|ide_selection|local-command-caveat|command-name|command-message|command-args|local-command-stdout)>"
    )

    /** Reads a transcript file and returns parsed entries since the cursor position. */
    fun readTranscript(
        transcriptPath: String,
        cursor: TranscriptCursor? = null,
        parser: TranscriptParser? = null,
    ): TranscriptReadResult {
        val startLine = cursor?.lineNumber ?: 0
        val parseFn: (String, Int) -> TranscriptEntry? = parser?.let { p -> { line, num -> p.parseLine(line, num) } }
            ?: { line, num -> parseTranscriptLine(line, num) }

        val file = File(transcriptPath)
        if (!file.exists()) {
            throw RuntimeException("Cannot read transcript: $transcriptPath")
        }

        // Guard against OOM: skip files larger than 50 MB
        val fileSize = file.length()
        if (fileSize > MAX_FILE_SIZE_BYTES) {
            log.warn("Transcript file too large (%d MB), skipping: %s", fileSize / (1024 * 1024), transcriptPath)
            val emptyCursor = TranscriptCursor(transcriptPath, startLine, java.time.Instant.now().toString())
            return TranscriptReadResult(emptyList(), emptyCursor, 0)
        }

        // Read line-by-line to avoid loading entire file into memory
        val rawEntries = mutableListOf<TranscriptEntry>()
        var totalLines = 0
        var newLinesRead = 0

        try {
            file.bufferedReader(Charsets.UTF_8).useLines { lineSequence ->
                for (line in lineSequence) {
                    if (line.isBlank()) continue
                    totalLines++
                    if (totalLines <= startLine) continue
                    newLinesRead++
                    val entry = parseFn(line, totalLines - 1)
                    if (entry != null) rawEntries.add(entry)
                }
            }
        } catch (e: Exception) {
            log.error("Failed to read transcript file: %s", e.message)
            throw RuntimeException("Cannot read transcript: $transcriptPath")
        }

        val entries = mergeConsecutiveEntries(rawEntries)

        val newCursor = TranscriptCursor(
            transcriptPath = transcriptPath,
            lineNumber = totalLines,
            updatedAt = java.time.Instant.now().toString(),
        )

        return TranscriptReadResult(entries, newCursor, newLinesRead)
    }

    /** Parses a single JSONL line into a TranscriptEntry. */
    fun parseTranscriptLine(line: String, lineNum: Int): TranscriptEntry? {
        return try {
            val data = JsonParser.parseString(line).asJsonObject

            // Skip compaction summaries
            if (data.get("isCompactSummary")?.asBoolean == true) return null

            val msg = data.getAsJsonObject("message") ?: return null
            val role = msg.get("role")?.asString ?: return null
            val timestamp = data.get("timestamp")?.asString

            when (role) {
                "user" -> parseUserMessage(msg, timestamp, lineNum)
                "assistant" -> {
                    val content = extractContent(msg.get("content"))?.trim()
                    if (content.isNullOrEmpty()) null
                    else TranscriptEntry("assistant", content, timestamp)
                }
                else -> null
            }
        } catch (e: Exception) {
            log.debug("Failed to parse transcript line %d: %s", lineNum, e.message)
            null
        }
    }

    private fun parseUserMessage(msg: com.google.gson.JsonObject, timestamp: String?, lineNum: Int): TranscriptEntry? {
        val rawContent = extractContent(msg.get("content")) ?: return null
        val content = stripIdeTags(rawContent)
        if (content.isEmpty()) return null

        if (SKIP_USER_PREFIXES.any { content.startsWith(it) }) {
            log.debug("Skipping filtered user message at line %d", lineNum)
            return null
        }

        return TranscriptEntry("human", content, timestamp)
    }

    private fun stripIdeTags(text: String): String {
        return text.replace(IDE_TAG_PATTERN, "").trim()
    }

    /** Extracts text content from a message content field (string or array of blocks). */
    private fun extractContent(content: com.google.gson.JsonElement?): String? {
        if (content == null) return null
        if (content.isJsonPrimitive) {
            val s = content.asString
            return if (s.isNotEmpty()) s else null
        }
        if (content.isJsonArray) {
            val parts = mutableListOf<String>()
            for (block in content.asJsonArray) {
                if (block.isJsonObject) {
                    val b = block.asJsonObject
                    if (b.get("type")?.asString == "text") {
                        val text = b.get("text")?.asString
                        if (text != null) parts.add(text)
                    }
                }
            }
            return if (parts.isNotEmpty()) parts.joinToString("\n") else null
        }
        return null
    }

    /** Builds conversation context string from entries, truncated to maxChars. */
    fun buildConversationContext(entries: List<TranscriptEntry>, maxChars: Int = DEFAULT_MAX_CHARS): String {
        val formatted = entries.map { formatEntry(it) }
        var totalChars = 0
        val selected = mutableListOf<String>()

        for (i in formatted.indices.reversed()) {
            val entryLen = formatted[i].length + 2
            if (totalChars + entryLen > maxChars) break
            selected.add(0, formatted[i])
            totalChars += entryLen
        }

        return selected.joinToString("\n\n")
    }

    /** Builds multi-session conversation context with <session> XML tags. */
    fun buildMultiSessionContext(sessions: List<SessionTranscript>, maxChars: Int = DEFAULT_MAX_CHARS): String {
        val totalEntries = sessions.sumOf { it.entries.size }
        if (totalEntries == 0) return ""

        // Flatten, sort by timestamp descending, greedy select
        data class Tagged(val sessionId: String, val entry: TranscriptEntry)

        val pool = sessions.flatMap { s -> s.entries.map { Tagged(s.sessionId, it) } }
            .sortedWith(compareByDescending<Tagged> { it.entry.timestamp ?: "" }
                .thenBy { it.entry.timestamp == null })

        val selected = mutableListOf<Tagged>()
        var totalChars = 0
        for (tagged in pool) {
            val entryLen = formatEntry(tagged.entry).length + 2
            if (totalChars + entryLen > maxChars) break
            selected.add(tagged)
            totalChars += entryLen
        }

        if (selected.isEmpty()) return ""

        // Group by session, format blocks
        val pathMap = sessions.associate { it.sessionId to it.transcriptPath }
        val groups = selected.groupBy { it.sessionId }

        val sessionOrder = groups.map { (sid, entries) ->
            val newest = entries.maxOfOrNull { it.entry.timestamp ?: "" } ?: ""
            sid to newest
        }.sortedByDescending { it.second }

        val blocks = sessionOrder.mapNotNull { (sid, _) ->
            val entries = (groups[sid] ?: return@mapNotNull null).sortedBy { it.entry.timestamp ?: "" }
            val formatted = entries.joinToString("\n\n") { formatEntry(it.entry) }
            val path = pathMap[sid] ?: "unknown"
            "<session id=\"$sid\" transcript=\"$path\">\n$formatted\n</session>"
        }

        return "<transcript>\n${blocks.joinToString("\n\n")}\n</transcript>"
    }

    /** Merges consecutive entries with the same role into a single entry. */
    fun mergeConsecutiveEntries(entries: List<TranscriptEntry>): List<TranscriptEntry> {
        if (entries.size <= 1) return entries.toList()
        val merged = mutableListOf<TranscriptEntry>()
        var current = entries[0]

        for (i in 1 until entries.size) {
            if (entries[i].role == current.role) {
                current = TranscriptEntry(
                    role = current.role,
                    content = "${current.content}\n\n${entries[i].content}",
                    timestamp = current.timestamp ?: entries[i].timestamp,
                )
            } else {
                merged.add(current)
                current = entries[i]
            }
        }
        merged.add(current)
        return merged
    }

    private fun formatEntry(entry: TranscriptEntry): String {
        return when (entry.role) {
            "human" -> "[Human]: ${entry.content}"
            "assistant" -> "[Assistant]: ${entry.content}"
            else -> "[${entry.role}]: ${entry.content}"
        }
    }

    /** A session's transcript entries with metadata */
    data class SessionTranscript(
        val sessionId: String,
        val transcriptPath: String,
        val entries: List<TranscriptEntry>,
    )
}

/** Strategy interface for parsing transcript lines */
interface TranscriptParser {
    fun parseLine(line: String, lineNum: Int): TranscriptEntry?
}

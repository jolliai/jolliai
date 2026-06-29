package ai.jolli.jollimemory.core

import com.google.gson.JsonParser
import java.io.File
import java.time.LocalDate
import java.time.format.DateTimeFormatter

/**
 * CodexSessionDiscoverer — Kotlin port of CodexSessionDiscoverer.ts
 *
 * Discovers OpenAI Codex CLI sessions from ~/.codex/sessions/
 */
object CodexSessionDiscoverer {

    private val log = JmLogger.create("CodexSessionDiscoverer")

    /** Check if Codex CLI sessions directory exists. */
    fun isCodexInstalled(): Boolean {
        val home = System.getProperty("user.home")
        return File("$home/.codex/sessions").isDirectory
    }

    /** Discovers recent Codex sessions (last 2 days). */
    fun discoverSessions(): List<SessionInfo> {
        val home = System.getProperty("user.home")
        val sessionsDir = File("$home/.codex/sessions")
        if (!sessionsDir.isDirectory) return emptyList()

        val sessions = mutableListOf<SessionInfo>()
        val today = LocalDate.now()
        val fmt = DateTimeFormatter.ofPattern("yyyy/MM/dd")

        for (dayOffset in 0..1) {
            val date = today.minusDays(dayOffset.toLong())
            val dayDir = File(sessionsDir, fmt.format(date))
            if (!dayDir.isDirectory) continue

            val files = dayDir.listFiles { f -> f.extension == "jsonl" } ?: continue
            for (file in files) {
                // The resumable session id is `payload.id` (a UUID) from the file's
                // first `session_meta` line — NOT the rollout filename. `codex resume
                // <id>` rejects the filename form. Fall back to the filename only when
                // the meta line can't be parsed, so the conversation still appears.
                val sessionId = readSessionId(file) ?: file.nameWithoutExtension
                sessions.add(SessionInfo(
                    sessionId = sessionId,
                    transcriptPath = file.absolutePath,
                    updatedAt = java.time.Instant.ofEpochMilli(file.lastModified()).toString(),
                    source = TranscriptSource.codex,
                ))
            }
        }

        log.info("Discovered %d Codex session(s)", sessions.size)
        return sessions
    }

    /**
     * Reads the resumable session id from a Codex rollout file's first line
     * (`session_meta`): `payload.id`, falling back to `payload.session_id`.
     * Returns null when the line isn't valid session_meta — this is the UUID
     * `codex resume` expects, distinct from the rollout filename.
     */
    private fun readSessionId(file: File): String? {
        return try {
            val firstLine = file.bufferedReader().use { it.readLine() } ?: return null
            val obj = JsonParser.parseString(firstLine).asJsonObject
            if (obj.get("type")?.asString != "session_meta") return null
            val payload = obj.getAsJsonObject("payload") ?: return null
            val id = payload.get("id")?.takeIf { !it.isJsonNull }?.asString
                ?: payload.get("session_id")?.takeIf { !it.isJsonNull }?.asString
            id?.takeIf { it.isNotBlank() }
        } catch (e: Exception) {
            log.debug("Failed to read Codex session_id from %s: %s", file.name, e.message)
            null
        }
    }
}

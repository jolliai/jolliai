package ai.jolli.jollimemory.core

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
                val sessionId = file.nameWithoutExtension
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
}

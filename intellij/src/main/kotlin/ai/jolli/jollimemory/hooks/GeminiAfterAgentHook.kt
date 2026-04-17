package ai.jolli.jollimemory.hooks

import ai.jolli.jollimemory.core.ClaudeHookInput
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SessionInfo
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.TranscriptSource
import com.google.gson.Gson
import java.time.Instant

/**
 * GeminiAfterAgentHook — Kotlin port of GeminiAfterAgentHook.ts
 *
 * Invoked by Gemini CLI after each agent turn. Same as StopHook but
 * with source="gemini" and must write {} to stdout.
 */
object GeminiAfterAgentHook {

    private val log = JmLogger.create("GeminiAfterAgentHook")
    private val gson = Gson()

    fun run() {
        // Gemini hooks MUST write JSON to stdout
        try {
            runInternal()
        } finally {
            println("{}")
        }
    }

    private fun runInternal() {
        val envProjectDir = System.getenv("GEMINI_PROJECT_DIR") ?: System.getenv("CLAUDE_PROJECT_DIR")
        if (envProjectDir != null) JmLogger.setLogDir(envProjectDir)

        val input = try { readStdin() } catch (_: Exception) { return }
        if (input.isBlank()) return

        val hookInput = try {
            gson.fromJson(input, ClaudeHookInput::class.java)
        } catch (_: Exception) { return }

        val cwd = hookInput.cwd.ifBlank { envProjectDir ?: return }
        JmLogger.setLogDir(cwd)

        val sessionInfo = SessionInfo(
            sessionId = hookInput.session_id,
            transcriptPath = hookInput.transcript_path,
            updatedAt = Instant.now().toString(),
            source = TranscriptSource.gemini,
        )

        SessionTracker.saveSession(sessionInfo, cwd)
        log.info("Gemini session saved: %s", hookInput.session_id)
    }
}

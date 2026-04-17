package ai.jolli.jollimemory.hooks

import ai.jolli.jollimemory.core.ClaudeHookInput
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SessionInfo
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.TranscriptSource
import com.google.gson.Gson
import java.time.Instant

/**
 * StopHook — Kotlin port of StopHook.ts
 *
 * Invoked by Claude Code when the agent completes a response turn.
 * Receives JSON via stdin, saves session info to sessions.json.
 */
object StopHook {

    private val log = JmLogger.create("StopHook")
    private val gson = Gson()

    fun run() {
        val envProjectDir = System.getenv("CLAUDE_PROJECT_DIR")
        if (envProjectDir != null) JmLogger.setLogDir(envProjectDir)

        val input = try {
            readStdin()
        } catch (e: Exception) {
            log.error("Failed to read stdin: %s", e.message)
            return
        }

        if (input.isBlank()) {
            log.warn("Empty stdin — nothing to process")
            return
        }

        val hookInput = try {
            gson.fromJson(input, ClaudeHookInput::class.java)
        } catch (e: Exception) {
            log.error("Failed to parse stdin JSON: %s", e.message)
            return
        }

        val cwd = hookInput.cwd.ifBlank { envProjectDir ?: return }
        JmLogger.setLogDir(cwd)

        val sessionInfo = SessionInfo(
            sessionId = hookInput.session_id,
            transcriptPath = hookInput.transcript_path,
            updatedAt = Instant.now().toString(),
            source = TranscriptSource.claude,
        )

        SessionTracker.saveSession(sessionInfo, cwd)
        log.info("Session saved: %s", hookInput.session_id)
    }
}

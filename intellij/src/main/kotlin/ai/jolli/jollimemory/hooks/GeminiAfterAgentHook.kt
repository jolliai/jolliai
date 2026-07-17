package ai.jolli.jollimemory.hooks

import ai.jolli.jollimemory.core.ClaudeHookInput
import ai.jolli.jollimemory.core.HookEnv
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
 *
 * JVM-global dependencies (stdin, stdout, env vars) arrive via [HookEnv] and
 * the session sink via [run]'s `saveSession` parameter, so tests inject fakes
 * instead of mutating process-wide state. Defaults are the real
 * implementations — production callers pass a shared env or nothing.
 */
object GeminiAfterAgentHook {

    private val log = JmLogger.create("GeminiAfterAgentHook")
    private val gson = Gson()

    fun run(
        env: HookEnv = HookEnv(),
        saveSession: (SessionInfo, String) -> Unit = SessionTracker::saveSession,
    ) {
        // Gemini hooks MUST write JSON to stdout
        try {
            runInternal(env, saveSession)
        } finally {
            env.stdout.println("{}")
        }
    }

    private fun runInternal(env: HookEnv, saveSession: (SessionInfo, String) -> Unit) {
        val envProjectDir = env.getenv("GEMINI_PROJECT_DIR") ?: env.getenv("CLAUDE_PROJECT_DIR")
        if (envProjectDir != null) JmLogger.setLogDir(envProjectDir)

        val input = try { env.readStdin() } catch (_: Exception) { return }
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

        saveSession(sessionInfo, cwd)
        log.info("Gemini session saved: %s", hookInput.session_id)

        // JOLLI-1954: flush the shared telemetry buffer on every agent turn end
        // (mirrors the Claude Stop hook). flushNow re-gates consent, never throws.
        ai.jolli.jollimemory.core.telemetry.TelemetryActivation.flushNow(cwd)
    }
}

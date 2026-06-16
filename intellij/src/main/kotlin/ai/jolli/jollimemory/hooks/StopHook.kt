package ai.jolli.jollimemory.hooks

import ai.jolli.jollimemory.core.ClaudeHookInput
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.LogLevel
import ai.jolli.jollimemory.core.SessionInfo
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.TranscriptCursor
import ai.jolli.jollimemory.core.TranscriptSource
import ai.jolli.jollimemory.core.references.TranscriptReferenceDiscovery
import com.google.gson.Gson
import java.io.File
import java.time.Instant

/**
 * StopHook — Kotlin port of StopHook.ts
 *
 * Invoked by Claude Code when the agent completes a response turn.
 * Receives JSON via stdin, saves session info to sessions.json,
 * then incrementally scans the transcript for references.
 */
object StopHook {

    private val log = JmLogger.create("StopHook")
    private val gson = Gson()

    fun run() {
        JmLogger.setLogLevel(LogLevel.debug)
        val envProjectDir = System.getenv("CLAUDE_PROJECT_DIR")
        if (envProjectDir != null) JmLogger.setLogDir(envProjectDir)
        log.info("StopHook.run() started (JAR v3 with reference discovery)")

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

        try {
            discoverFromTranscript(sessionInfo, cwd)
        } catch (t: Throwable) {
            log.error("discoverFromTranscript crashed: %s: %s", t.javaClass.name, t.message)
        }
    }

    /**
     * Incremental reference discovery for one transcript. Loads discovery cursor,
     * scans for references, advances cursor on success.
     */
    private fun discoverFromTranscript(sessionInfo: SessionInfo, cwd: String) {
        val transcriptPath = sessionInfo.transcriptPath
        if (!File(transcriptPath).exists()) {
            log.debug("discoverFromTranscript: transcript does not exist: %s", transcriptPath)
            return
        }

        val fromLine = SessionTracker.loadDiscoveryCursor(transcriptPath, cwd)?.lineNumber ?: 0
        log.debug("discoverFromTranscript: scanning %s from line %d", transcriptPath, fromLine)

        var referenceLine = fromLine
        try {
            referenceLine = TranscriptReferenceDiscovery.scanReferencesFrom(
                transcriptPath, fromLine, cwd, TranscriptSource.claude,
            )
        } catch (e: Exception) {
            log.error("Reference discovery failed: %s", e.message)
        }

        log.debug("discoverFromTranscript: scanned to line %d (was %d)", referenceLine, fromLine)

        if (referenceLine > fromLine) {
            SessionTracker.saveDiscoveryCursor(
                TranscriptCursor(
                    transcriptPath = transcriptPath,
                    lineNumber = referenceLine,
                    updatedAt = Instant.now().toString(),
                ),
                cwd,
            )
        }
    }
}

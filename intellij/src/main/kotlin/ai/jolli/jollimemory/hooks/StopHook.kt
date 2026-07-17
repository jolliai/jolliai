package ai.jolli.jollimemory.hooks

import ai.jolli.jollimemory.core.ClaudeHookInput
import ai.jolli.jollimemory.core.HookEnv
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.LogLevel
import ai.jolli.jollimemory.core.SessionInfo
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.TranscriptCursor
import ai.jolli.jollimemory.core.TranscriptSource
import ai.jolli.jollimemory.core.plans.TranscriptPlanDiscovery
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
 *
 * JVM-global dependencies (stdin, env vars) arrive via [HookEnv] and the
 * session sink via [run]'s `saveSession` parameter, so tests inject fakes
 * instead of mutating process-wide state. Defaults are the real
 * implementations — production callers pass a shared env or nothing.
 */
object StopHook {

    private val log = JmLogger.create("StopHook")
    private val gson = Gson()

    fun run(
        env: HookEnv = HookEnv(),
        saveSession: (SessionInfo, String) -> Unit = SessionTracker::saveSession,
    ) {
        JmLogger.setLogLevel(LogLevel.debug)
        val envProjectDir = env.getenv("CLAUDE_PROJECT_DIR")
        if (envProjectDir != null) JmLogger.setLogDir(envProjectDir)
        log.info("StopHook.run() started (JAR v3 with reference discovery)")

        val input = try {
            env.readStdin()
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

        saveSession(sessionInfo, cwd)
        log.info("Session saved: %s", hookInput.session_id)

        try {
            discoverFromTranscript(sessionInfo, cwd)
        } catch (t: Throwable) {
            log.error("discoverFromTranscript crashed: %s: %s", t.javaClass.name, t.message)
        }

        // JOLLI-1954: the Stop hook fires on every agent turn end — far more often
        // than commits — so drain the shared telemetry buffer here too. Covers the
        // "using the agent but not committing" case. flushNow re-gates consent and
        // never throws. Mirrors cli/src/hooks/StopHook.ts.
        ai.jolli.jollimemory.core.telemetry.TelemetryActivation.flushNow(cwd)
    }

    /**
     * Incremental discovery for one transcript. Loads the discovery cursor, scans
     * for both references AND plans from the same line, then advances the cursor to
     * the furthest line either scan reached.
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

        var planLine = fromLine
        try {
            planLine = TranscriptPlanDiscovery.scanPlansFrom(
                transcriptPath, fromLine, cwd, TranscriptSource.claude,
            )
        } catch (e: Exception) {
            log.error("Plan discovery failed: %s", e.message)
        }

        // Persist the furthest line either scan reached — both read from the same
        // fromLine to EOF, so the merged cursor advances past everything scanned.
        val scannedLine = maxOf(referenceLine, planLine)
        log.debug("discoverFromTranscript: scanned to line %d (was %d)", scannedLine, fromLine)

        if (scannedLine > fromLine) {
            SessionTracker.saveDiscoveryCursor(
                TranscriptCursor(
                    transcriptPath = transcriptPath,
                    lineNumber = scannedLine,
                    updatedAt = Instant.now().toString(),
                ),
                cwd,
            )
        }
    }
}

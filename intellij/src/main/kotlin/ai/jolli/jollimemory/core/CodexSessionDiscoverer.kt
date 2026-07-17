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
    fun isCodexInstalled(env: HookEnv = HookEnv()): Boolean {
        return File(env.userHome, ".codex/sessions").isDirectory
    }

    /**
     * Discovers recent Codex sessions (last 2 days) that belong to [projectDir].
     *
     * Codex has no lifecycle hook, so we scan `~/.codex/sessions/` — which holds
     * rollout files for EVERY repo on the machine — and must scope the result to
     * the current repo ourselves. Each session's own working directory is recorded
     * as `payload.cwd` in the first `session_meta` line; we keep only sessions whose
     * cwd matches [projectDir] (path-normalized, case-insensitive on macOS/Windows).
     * A session with no recorded cwd can't be attributed, so it is skipped. Mirrors
     * the CLI/VS Code `discoverCodexSessions(projectDir)` filter.
     */
    fun discoverSessions(projectDir: String, env: HookEnv = HookEnv()): List<SessionInfo> {
        val sessionsDir = File(env.userHome, ".codex/sessions")
        if (!sessionsDir.isDirectory) return emptyList()

        val target = normalizePathForMatch(projectDir, env)
        val sessions = mutableListOf<SessionInfo>()
        val today = LocalDate.now()
        val fmt = DateTimeFormatter.ofPattern("yyyy/MM/dd")

        for (dayOffset in 0..1) {
            val date = today.minusDays(dayOffset.toLong())
            val dayDir = File(sessionsDir, fmt.format(date))
            if (!dayDir.isDirectory) continue

            val files = dayDir.listFiles { f -> f.extension == "jsonl" } ?: continue
            for (file in files) {
                val meta = readSessionMeta(file) ?: continue
                // Scope to the current repo. A session whose cwd is absent or points
                // at another repo must not leak into this project's conversation list.
                val cwd = meta.cwd ?: continue
                if (normalizePathForMatch(cwd, env) != target) continue
                sessions.add(SessionInfo(
                    sessionId = meta.id,
                    transcriptPath = file.absolutePath,
                    updatedAt = java.time.Instant.ofEpochMilli(file.lastModified()).toString(),
                    source = TranscriptSource.codex,
                ))
            }
        }

        log.info("Discovered %d Codex session(s) for %s", sessions.size, projectDir)
        return sessions
    }

    /** The bits of a Codex `session_meta` line we need: the resumable id + the session's cwd. */
    private data class CodexMeta(val id: String, val cwd: String?)

    /**
     * Reads the first `session_meta` line of a Codex rollout file. The resumable id is
     * `payload.id` (a UUID `codex resume <id>` expects — NOT the rollout filename),
     * falling back to `payload.session_id`; the session's working directory is
     * `payload.cwd`. Returns null when the line isn't valid session_meta or has no id.
     */
    private fun readSessionMeta(file: File): CodexMeta? {
        return try {
            val firstLine = file.bufferedReader().use { it.readLine() } ?: return null
            val obj = JsonParser.parseString(firstLine).asJsonObject
            if (obj.get("type")?.asString != "session_meta") return null
            val payload = obj.getAsJsonObject("payload") ?: return null
            val id = payload.get("id")?.takeIf { !it.isJsonNull }?.asString
                ?: payload.get("session_id")?.takeIf { !it.isJsonNull }?.asString
            val cwd = payload.get("cwd")?.takeIf { !it.isJsonNull }?.asString?.takeIf { it.isNotBlank() }
            id?.takeIf { it.isNotBlank() }?.let { CodexMeta(it, cwd) }
        } catch (e: Exception) {
            log.debug("Failed to read Codex session_meta from %s: %s", file.name, e.message)
            null
        }
    }
}

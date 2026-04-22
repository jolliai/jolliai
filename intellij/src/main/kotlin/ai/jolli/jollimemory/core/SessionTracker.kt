package ai.jolli.jollimemory.core

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import java.io.File
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Session Tracker — Kotlin port of SessionTracker.ts
 *
 * Manages .jolli/jollimemory/ state files:
 *   - sessions.json: Registry of active AI coding sessions
 *   - cursors.json: Per-transcript cursor positions
 *   - config.json: Configuration (API key, model, etc.)
 *   - lock: Concurrency lock file
 *   - squash-pending.json, amend-pending.json: Temporary state
 *   - plans.json: Plan files registry
 */
object SessionTracker {

    private val log = JmLogger.create("SessionTracker")
    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()

    private const val SESSIONS_FILE = "sessions.json"
    private const val CURSORS_FILE = "cursors.json"
    private const val CONFIG_FILE = "config.json"
    private const val LOCK_FILE = "lock"
    private const val PLANS_FILE = "plans.json"
    private const val SQUASH_PENDING_FILE = "squash-pending.json"
    private const val AMEND_PENDING_FILE = "amend-pending.json"
    private const val PLUGIN_SOURCE_FILE = "plugin-source"

    /** Sessions older than 48 hours are stale */
    private const val SESSION_STALE_MS = 48L * 60 * 60 * 1000
    /** Lock timeout: stale after 5 minutes */
    private const val LOCK_TIMEOUT_MS = 5L * 60 * 1000
    private const val PENDING_STALE_MS = 48L * 60 * 60 * 1000

    /** Ensures the .jolli/jollimemory/ directory exists. */
    fun ensureDir(cwd: String? = null): String {
        val dir = JmLogger.getJolliMemoryDir(cwd)
        File(dir).mkdirs()
        return dir
    }

    // ── Sessions ────────────────────────────────────────────────────────────

    fun saveSession(sessionInfo: SessionInfo, cwd: String? = null) {
        val dir = ensureDir(cwd)
        val registry = loadSessionsRegistry(dir)
        val sessions = registry.sessions.toMutableMap()
        sessions[sessionInfo.sessionId] = sessionInfo

        val (active, stalePaths) = pruneStale(sessions)
        val newRegistry = SessionsRegistry(version = 1, sessions = active)
        atomicWrite(File(dir, SESSIONS_FILE), gson.toJson(newRegistry))

        if (stalePaths.isNotEmpty()) {
            pruneOrphanedCursors(dir, stalePaths)
        }
    }

    fun loadAllSessions(cwd: String? = null): List<SessionInfo> {
        val dir = JmLogger.getJolliMemoryDir(cwd)
        val registry = loadSessionsRegistry(dir)
        val (active, _) = pruneStale(registry.sessions)
        return active.values.toList()
    }

    fun loadMostRecentSession(cwd: String? = null): SessionInfo? {
        return loadAllSessions(cwd).maxByOrNull { it.updatedAt }
    }

    private fun loadSessionsRegistry(dir: String): SessionsRegistry {
        return try {
            val content = File(dir, SESSIONS_FILE).readText(Charsets.UTF_8)
            gson.fromJson(content, SessionsRegistry::class.java)
        } catch (_: Exception) {
            SessionsRegistry()
        }
    }

    private fun pruneStale(sessions: Map<String, SessionInfo>): Pair<Map<String, SessionInfo>, List<String>> {
        val now = System.currentTimeMillis()
        val active = mutableMapOf<String, SessionInfo>()
        val stalePaths = mutableListOf<String>()

        for ((id, session) in sessions) {
            val age = now - java.time.Instant.parse(session.updatedAt).toEpochMilli()
            if (age > SESSION_STALE_MS) {
                log.info("Pruning stale session %s (age: %dh)", id, age / 3600000)
                stalePaths.add(session.transcriptPath)
            } else {
                active[id] = session
            }
        }
        return active to stalePaths
    }

    // ── Cursors ─────────────────────────────────────────────────────────────

    fun saveCursor(cursor: TranscriptCursor, cwd: String? = null) {
        val dir = ensureDir(cwd)
        val registry = loadCursorsRegistry(dir)
        val cursors = registry.cursors.toMutableMap()
        cursors[cursor.transcriptPath] = cursor
        atomicWrite(File(dir, CURSORS_FILE), gson.toJson(CursorsRegistry(version = 1, cursors = cursors)))
    }

    fun loadCursorForTranscript(transcriptPath: String, cwd: String? = null): TranscriptCursor? {
        val dir = JmLogger.getJolliMemoryDir(cwd)
        return loadCursorsRegistry(dir).cursors[transcriptPath]
    }

    private fun loadCursorsRegistry(dir: String): CursorsRegistry {
        return try {
            gson.fromJson(File(dir, CURSORS_FILE).readText(Charsets.UTF_8), CursorsRegistry::class.java)
        } catch (_: Exception) {
            CursorsRegistry()
        }
    }

    private fun pruneOrphanedCursors(dir: String, stalePaths: List<String>) {
        val registry = loadCursorsRegistry(dir)
        val cursors = registry.cursors.toMutableMap()
        val staleSet = stalePaths.toSet()
        var pruned = 0

        for (key in cursors.keys.toList()) {
            val rawPath = if (key.startsWith("plan:")) key.substring(5) else key
            if (rawPath in staleSet) {
                cursors.remove(key)
                pruned++
            }
        }

        if (pruned > 0) {
            atomicWrite(File(dir, CURSORS_FILE), gson.toJson(CursorsRegistry(version = 1, cursors = cursors)))
        }
    }

    // ── Config ──────────────────────────────────────────────────────────────

    /** Returns the global config directory: ~/.jolli/jollimemory/ */
    fun getGlobalConfigDir(): String {
        val home = System.getProperty("user.home")
        return "$home/${JmLogger.JOLLI_DIR}/${JmLogger.JOLLIMEMORY_DIR}"
    }

    /** Loads config from the global config directory. */
    fun loadConfig(cwd: String? = null): JolliMemoryConfig {
        return loadConfigFromDir(getGlobalConfigDir())
    }

    /** Reads config.json from a specific directory. Returns empty config on error. */
    fun loadConfigFromDir(dir: String): JolliMemoryConfig {
        return try {
            gson.fromJson(File(dir, CONFIG_FILE).readText(Charsets.UTF_8), JolliMemoryConfig::class.java)
        } catch (_: Exception) {
            JolliMemoryConfig()
        }
    }

    fun saveConfig(update: JolliMemoryConfig, cwd: String? = null) {
        val dir = ensureDir(cwd)
        // Merge with existing config from the same directory we write to
        val existing = loadConfigFromDir(dir)
        val merged = JolliMemoryConfig(
            apiKey = update.apiKey ?: existing.apiKey,
            model = update.model ?: existing.model,
            maxTokens = update.maxTokens ?: existing.maxTokens,
            excludePatterns = update.excludePatterns ?: existing.excludePatterns,
            jolliApiKey = update.jolliApiKey ?: existing.jolliApiKey,
            authToken = update.authToken ?: existing.authToken,
            claudeEnabled = update.claudeEnabled ?: existing.claudeEnabled,
            codexEnabled = update.codexEnabled ?: existing.codexEnabled,
            geminiEnabled = update.geminiEnabled ?: existing.geminiEnabled,
            logLevel = update.logLevel ?: existing.logLevel,
            logLevelOverrides = update.logLevelOverrides ?: existing.logLevelOverrides,
        )
        atomicWrite(File(dir, CONFIG_FILE), gson.toJson(merged))
        log.info("Config saved")
    }

    /**
     * Writes a complete config to a specific directory (no merge).
     * Used by the Settings dialog to save scoped config directly.
     */
    fun saveConfigToDir(config: JolliMemoryConfig, dir: String) {
        File(dir).mkdirs()
        atomicWrite(File(dir, CONFIG_FILE), gson.toJson(config))
        log.info("Config saved to %s", dir)
    }

    // ── Lock ────────────────────────────────────────────────────────────────

    fun acquireLock(cwd: String? = null): Boolean {
        val dir = ensureDir(cwd)
        val lockFile = File(dir, LOCK_FILE)

        // Check for stale lock before attempting atomic creation
        if (lockFile.exists()) {
            val age = System.currentTimeMillis() - lockFile.lastModified()
            if (age < LOCK_TIMEOUT_MS) {
                log.warn("Lock file exists (age: %dms), another process may be running", age)
                return false
            }
            log.warn("Removing stale lock file (age: %dms)", age)
            lockFile.delete()
        }

        // Atomic lock creation: Files.createFile() throws FileAlreadyExistsException
        // if another process creates the file between our exists() check and here.
        return try {
            Files.createFile(lockFile.toPath())
            lockFile.writeText(ProcessHandle.current().pid().toString())
            true
        } catch (_: FileAlreadyExistsException) {
            log.warn("Failed to acquire lock (another process grabbed it atomically)")
            false
        } catch (_: Exception) {
            false
        }
    }

    fun releaseLock(cwd: String? = null) {
        val dir = JmLogger.getJolliMemoryDir(cwd)
        try {
            File(dir, LOCK_FILE).delete()
        } catch (e: Exception) {
            log.error("Failed to release lock: %s", e.message)
        }
    }

    /**
     * Checks if the post-commit worker is currently running.
     * Returns true if the lock file exists and is younger than [LOCK_TIMEOUT_MS].
     * Matches VS Code's isWorkerBusy() in LockUtils.ts.
     */
    fun isWorkerBusy(cwd: String? = null): Boolean {
        val dir = JmLogger.getJolliMemoryDir(cwd)
        val lockFile = File(dir, LOCK_FILE)
        if (!lockFile.exists()) return false
        val age = System.currentTimeMillis() - lockFile.lastModified()
        return age < LOCK_TIMEOUT_MS
    }

    // ── Squash Pending ──────────────────────────────────────────────────────

    fun loadSquashPending(cwd: String? = null): SquashPendingState? {
        val dir = JmLogger.getJolliMemoryDir(cwd)
        val state = try {
            gson.fromJson(File(dir, SQUASH_PENDING_FILE).readText(Charsets.UTF_8), SquashPendingState::class.java)
        } catch (_: Exception) {
            return null
        }

        val age = System.currentTimeMillis() - java.time.Instant.parse(state.createdAt).toEpochMilli()
        if (age > PENDING_STALE_MS) {
            log.info("squash-pending.json is stale (%dh old), deleting", age / 3600000)
            deleteSquashPending(cwd)
            return null
        }
        return state
    }

    fun saveSquashPending(sourceHashes: List<String>, expectedParentHash: String, cwd: String? = null) {
        val dir = ensureDir(cwd)
        val state = SquashPendingState(sourceHashes, expectedParentHash, java.time.Instant.now().toString())
        atomicWrite(File(dir, SQUASH_PENDING_FILE), gson.toJson(state))
        log.info("Saved squash-pending.json: %d source hashes", sourceHashes.size)
    }

    fun deleteSquashPending(cwd: String? = null) {
        val dir = JmLogger.getJolliMemoryDir(cwd)
        File(dir, SQUASH_PENDING_FILE).delete()
    }

    // ── Amend Pending ───────────────────────────────────────────────────────

    fun loadAmendPending(cwd: String? = null): AmendPendingState? {
        val dir = JmLogger.getJolliMemoryDir(cwd)
        val state = try {
            gson.fromJson(File(dir, AMEND_PENDING_FILE).readText(Charsets.UTF_8), AmendPendingState::class.java)
        } catch (_: Exception) {
            return null
        }

        val age = System.currentTimeMillis() - java.time.Instant.parse(state.createdAt).toEpochMilli()
        if (age > PENDING_STALE_MS) {
            deleteAmendPending(cwd)
            return null
        }
        return state
    }

    fun saveAmendPending(oldHash: String, cwd: String? = null) {
        val dir = ensureDir(cwd)
        val state = AmendPendingState(oldHash, java.time.Instant.now().toString())
        atomicWrite(File(dir, AMEND_PENDING_FILE), gson.toJson(state))
        log.info("Saved amend-pending.json: %s", oldHash.take(8))
    }

    fun deleteAmendPending(cwd: String? = null) {
        val dir = JmLogger.getJolliMemoryDir(cwd)
        File(dir, AMEND_PENDING_FILE).delete()
    }

    // ── Plugin Source ────────────────────────────────────────────────────────

    fun savePluginSource(cwd: String? = null) {
        val dir = ensureDir(cwd)
        File(dir, PLUGIN_SOURCE_FILE).writeText(java.time.Instant.now().toString())
    }

    fun loadPluginSource(cwd: String? = null): Boolean {
        val dir = JmLogger.getJolliMemoryDir(cwd)
        return File(dir, PLUGIN_SOURCE_FILE).exists()
    }

    fun deletePluginSource(cwd: String? = null) {
        val dir = JmLogger.getJolliMemoryDir(cwd)
        File(dir, PLUGIN_SOURCE_FILE).delete()
    }

    // ── Plans Registry ──────────────────────────────────────────────────────

    fun loadPlansRegistry(cwd: String? = null): PlansRegistry {
        val dir = JmLogger.getJolliMemoryDir(cwd)
        return try {
            gson.fromJson(File(dir, PLANS_FILE).readText(Charsets.UTF_8), PlansRegistry::class.java)
        } catch (_: Exception) {
            PlansRegistry()
        }
    }

    fun savePlansRegistry(registry: PlansRegistry, cwd: String? = null) {
        val dir = ensureDir(cwd)
        atomicWrite(File(dir, PLANS_FILE), gson.toJson(registry))
    }

    fun associatePlanWithCommit(slug: String, commitHash: String, cwd: String? = null) {
        val registry = loadPlansRegistry(cwd)
        val entry = registry.plans[slug] ?: return
        val updated = registry.copy(
            plans = registry.plans + (slug to entry.copy(
                commitHash = commitHash,
                updatedAt = java.time.Instant.now().toString(),
            ))
        )
        savePlansRegistry(updated, cwd)
        log.info("associatePlanWithCommit: %s → %s", slug, commitHash.take(8))
    }

    fun loadPlanEntry(slug: String, cwd: String? = null): PlanEntry? {
        return loadPlansRegistry(cwd).plans[slug]
    }

    fun loadNoteEntry(id: String, cwd: String? = null): NoteEntry? {
        return loadPlansRegistry(cwd).notes?.get(id)
    }

    /** Returns the notes directory path (.jolli/jollimemory/notes/) */
    fun getNotesDir(cwd: String? = null): String {
        val dir = JmLogger.getJolliMemoryDir(cwd)
        return "$dir/notes"
    }

    // ── Atomic Write ────────────────────────────────────────────────────────

    private fun atomicWrite(file: File, content: String) {
        val tmp = File("${file.absolutePath}.tmp")
        tmp.writeText(content, Charsets.UTF_8)
        try {
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (_: Exception) {
            // Fallback: non-atomic direct write (e.g., cross-filesystem or unsupported OS)
            try {
                file.writeText(content, Charsets.UTF_8)
            } finally {
                tmp.delete()
            }
        }
    }
}

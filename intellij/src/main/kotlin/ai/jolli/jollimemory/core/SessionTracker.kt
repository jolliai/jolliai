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
    private const val CONFIG_FILE = "config-intellij.json"
    private const val LEGACY_CONFIG_FILE = "config.json"
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

    // ── Discovery Cursors ────────────────────────────────────────────────────

    private const val DISCOVERY_CURSORS_FILE = "discovery-cursors.json"

    fun saveDiscoveryCursor(cursor: TranscriptCursor, cwd: String? = null) {
        val dir = ensureDir(cwd)
        val registry = loadDiscoveryCursorsRegistry(dir)
        val cursors = registry.cursors.toMutableMap()
        cursors[cursor.transcriptPath] = cursor
        atomicWrite(File(dir, DISCOVERY_CURSORS_FILE), gson.toJson(CursorsRegistry(version = 1, cursors = cursors)))
    }

    fun loadDiscoveryCursor(transcriptPath: String, cwd: String? = null): TranscriptCursor? {
        val dir = JmLogger.getJolliMemoryDir(cwd)
        return loadDiscoveryCursorsRegistry(dir).cursors[transcriptPath]
    }

    private fun loadDiscoveryCursorsRegistry(dir: String): CursorsRegistry {
        return try {
            gson.fromJson(File(dir, DISCOVERY_CURSORS_FILE).readText(Charsets.UTF_8), CursorsRegistry::class.java)
        } catch (_: Exception) {
            CursorsRegistry()
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

    /**
     * Reads config-intellij.json from a specific directory. Returns empty config on error.
     *
     * One-time migration: if config-intellij.json is absent but the legacy shared
     * config.json exists, copy the legacy file forward so existing IntelliJ users
     * keep their settings on first run after the namespacing change.
     */
    fun loadConfigFromDir(dir: String): JolliMemoryConfig {
        val target = File(dir, CONFIG_FILE)
        if (!target.exists()) {
            val legacy = File(dir, LEGACY_CONFIG_FILE)
            if (legacy.exists()) {
                try {
                    File(dir).mkdirs()
                    legacy.copyTo(target, overwrite = false)
                    log.info("Migrated legacy config.json to config-intellij.json")
                } catch (_: Exception) {
                    // Migration is best-effort; fall through to empty config below.
                }
            }
        }
        val base = try {
            gson.fromJson(target.readText(Charsets.UTF_8), JolliMemoryConfig::class.java)
        } catch (_: Exception) {
            null
        } ?: JolliMemoryConfig()

        // Credentials (jolliApiKey / authToken) are account-level and shared across all
        // surfaces (CLI / VS Code / IntelliJ) via the legacy config.json — the source of
        // truth. IntelliJ keeps its own settings in config-intellij.json but overlays the
        // shared credentials on read so a re-login on any surface is picked up here (no
        // stale-key drift). Falls back to this file's own values when config.json is absent.
        val (sharedKey, sharedAuth) = readSharedCredentials(dir)
        // The global-instructions consent is also account-level and cross-surface — the
        // CLI/VS Code read + write it in the shared config.json. Overlay it the same way
        // so a decision made on any surface (or by the CLI shell-out) is honored here.
        val sharedGi = readSharedGlobalInstructions(dir)
        return base.copy(
            jolliApiKey = sharedKey ?: base.jolliApiKey,
            authToken = sharedAuth ?: base.authToken,
            globalInstructions = sharedGi ?: base.globalInstructions,
        )
    }

    /** Reads globalInstructions from the shared config.json (or null if absent/unset). */
    private fun readSharedGlobalInstructions(dir: String): String? {
        val shared = File(dir, LEGACY_CONFIG_FILE)
        if (!shared.exists()) return null
        return try {
            val obj = com.google.gson.JsonParser.parseString(shared.readText(Charsets.UTF_8)).asJsonObject
            obj.get("globalInstructions")?.takeIf { !it.isJsonNull }?.asString?.takeIf { it.isNotBlank() }
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Merges the global-instructions consent ("enabled" / "disabled") into the shared
     * config.json at the JSON level — preserving every other field, mirroring
     * [writeSharedCredentials] — so a decision made in IntelliJ propagates to the CLI
     * and VS Code. A null value clears the key (back to undecided).
     */
    fun saveGlobalInstructions(value: String?) {
        val dir = getGlobalConfigDir()
        val shared = File(dir, LEGACY_CONFIG_FILE)
        val obj = try {
            if (shared.exists()) {
                com.google.gson.JsonParser.parseString(shared.readText(Charsets.UTF_8)).asJsonObject
            } else {
                com.google.gson.JsonObject()
            }
        } catch (_: Exception) {
            com.google.gson.JsonObject()
        }
        if (value != null) obj.addProperty("globalInstructions", value) else obj.remove("globalInstructions")
        File(dir).mkdirs()
        atomicWrite(shared, gson.toJson(obj))
    }

    /** Reads jolliApiKey/authToken from the shared config.json (or null/null if absent). */
    private fun readSharedCredentials(dir: String): Pair<String?, String?> {
        val shared = File(dir, LEGACY_CONFIG_FILE)
        if (!shared.exists()) return null to null
        return try {
            val obj = com.google.gson.JsonParser.parseString(shared.readText(Charsets.UTF_8)).asJsonObject
            fun str(k: String) = obj.get(k)?.takeIf { !it.isJsonNull }?.asString?.takeIf { it.isNotBlank() }
            str("jolliApiKey") to str("authToken")
        } catch (_: Exception) {
            null to null
        }
    }

    /**
     * Merges jolliApiKey/authToken into the shared config.json at the JSON level so a
     * login/refresh on IntelliJ propagates to CLI / VS Code — preserving every other
     * field (we never deserialize-then-overwrite, which would drop fields this surface
     * doesn't model and clobber the other surfaces' settings). A null value clears the
     * field (sign-out), which all save paths only produce intentionally because they
     * load-first (carrying the shared credential forward).
     */
    private fun writeSharedCredentials(dir: String, jolliApiKey: String?, authToken: String?) {
        val shared = File(dir, LEGACY_CONFIG_FILE)
        val obj = try {
            if (shared.exists()) {
                com.google.gson.JsonParser.parseString(shared.readText(Charsets.UTF_8)).asJsonObject
            } else {
                com.google.gson.JsonObject()
            }
        } catch (_: Exception) {
            com.google.gson.JsonObject()
        }
        if (jolliApiKey != null) obj.addProperty("jolliApiKey", jolliApiKey) else obj.remove("jolliApiKey")
        if (authToken != null) obj.addProperty("authToken", authToken) else obj.remove("authToken")
        File(dir).mkdirs()
        atomicWrite(shared, gson.toJson(obj))
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
            aiProvider = update.aiProvider ?: existing.aiProvider,
            logLevel = update.logLevel ?: existing.logLevel,
            logLevelOverrides = update.logLevelOverrides ?: existing.logLevelOverrides,
            knowledgeBasePath = update.knowledgeBasePath ?: existing.knowledgeBasePath,
            knowledgeBaseSort = update.knowledgeBaseSort ?: existing.knowledgeBaseSort,
            storageMode = update.storageMode ?: existing.storageMode,
            slack = update.slack ?: existing.slack,
        )
        atomicWrite(File(dir, CONFIG_FILE), gson.toJson(merged))
        writeSharedCredentials(dir, merged.jolliApiKey, merged.authToken)
        log.info("Config saved")
    }

    /**
     * Writes a complete config to a specific directory (no merge).
     * Used by the Settings dialog to save scoped config directly.
     */
    fun saveConfigToDir(config: JolliMemoryConfig, dir: String) {
        File(dir).mkdirs()
        atomicWrite(File(dir, CONFIG_FILE), gson.toJson(config))
        writeSharedCredentials(dir, config.jolliApiKey, config.authToken)
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
     * Bumps the lock file's mtime to now, keeping it fresh while a drain worker runs.
     * Without this, a drain that spends >[LOCK_TIMEOUT_MS] in LLM calls would look
     * stale to a concurrent commit's worker, which could then reclaim it and race.
     */
    fun refreshLock(cwd: String? = null) {
        val dir = JmLogger.getJolliMemoryDir(cwd)
        val lockFile = File(dir, LOCK_FILE)
        if (lockFile.exists()) lockFile.setLastModified(System.currentTimeMillis())
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

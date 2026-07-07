package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.bridge.CommitSummaryBrief
import ai.jolli.jollimemory.bridge.ConversationBrief
import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.bridge.HookInstaller
import ai.jolli.jollimemory.bridge.SummaryReader
import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.KBPathResolver
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.StatusInfo
import ai.jolli.jollimemory.core.StorageFactory
import ai.jolli.jollimemory.sync.SyncEngine
import ai.jolli.jollimemory.sync.SyncOrchestrator
import ai.jolli.jollimemory.sync.STATUS_AUTO_CLEAR_DELAY_MS
import ai.jolli.jollimemory.sync.SyncOrchestratorOpts
import ai.jolli.jollimemory.sync.SyncState
import ai.jolli.jollimemory.sync.SyncStatusBarWidget
import ai.jolli.jollimemory.sync.SyncStatusDetail
import ai.jolli.jollimemory.sync.autoClearableSyncState
import ai.jolli.jollimemory.toolwindow.PanelRegistry
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.WindowManager
import com.intellij.util.concurrency.AppExecutorUtil
import git4idea.repo.GitRepository
import git4idea.repo.GitRepositoryChangeListener
import java.io.File
import java.nio.file.FileSystems
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardWatchEventKinds
import java.nio.file.WatchService
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import javax.swing.Timer

/**
 * Project-level service managing JolliMemory state.
 *
 * Uses native Kotlin bridge — no Node.js needed.
 */
@Service(Service.Level.PROJECT)
class JolliMemoryService(private val project: Project) : Disposable {

    private val log = Logger.getInstance(JolliMemoryService::class.java)
    private var git: GitOps? = null
    private var installer: HookInstaller? = null
    private var reader: SummaryReader? = null
    @Volatile
    private var cachedStatus: StatusInfo? = null
    /** Timestamp until which refreshStatus() should not downgrade enabled→disabled.
     *  Set after install() to prevent GIT_REPO_CHANGE from flapping the status. */
    @Volatile
    private var installProtectionUntil: Long = 0L
    /** The resolved main repo root (handles worktrees). */
    var mainRepoRoot: String? = null
        private set
    var lastError: String? = null
        private set
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private var orphanRefDebounceTimer: Timer? = null
    private var nioWatchService: WatchService? = null
    private var nioWatchThread: Thread? = null

    // ── Sync orchestrator ────────────────────────────────────────────────
    private var orchestrator: SyncOrchestrator? = null
    private val lastSyncSuccessAtMs = AtomicLong(0)
    @Volatile
    private var syncState: SyncState? = null
    @Volatile
    private var syncDetail: SyncStatusDetail? = null
    /** Bumped on every sync-state change so a pending auto-clear can detect that
     *  a newer state arrived and skip clobbering it. */
    private val syncStateGen = AtomicLong(0)
    /** Listeners notified (on the EDT) whenever the sync state changes. Lets the
     *  KB explorer toolbar mirror the status-bar widget's progress/error feedback. */
    private val syncListeners = CopyOnWriteArrayList<(SyncState, SyncStatusDetail?) -> Unit>()

    /** Registry of panel references for action lookup (set by JolliMemoryToolWindowFactory). */
    var panelRegistry: PanelRegistry? = null

    /**
     * Adds a status listener. If the service is already initialized (has cached status),
     * the listener is immediately invoked so late-registering panels receive the current state.
     */
    fun addStatusListener(listener: () -> Unit) {
        listeners.add(listener)
        if (cachedStatus != null) {
            listener()
        }
    }
    fun removeStatusListener(listener: () -> Unit) { listeners.remove(listener) }
    private fun notifyListeners() { listeners.forEach { it() } }

    /**
     * Listeners notified whenever a commit-selection toggle changes — a conversation
     * or context checkbox ([CommitSelectionStore]) or an in-memory file selection in
     * [ChangesPanel]. Kept separate from the status listeners so toggling a checkbox
     * can refresh the open Working Memory review without forcing the sidebar panels to
     * rebuild (which would, for files, reset their in-memory selection).
     */
    private val selectionListeners = CopyOnWriteArrayList<() -> Unit>()
    fun addSelectionListener(listener: () -> Unit) { selectionListeners.add(listener) }
    fun removeSelectionListener(listener: () -> Unit) { selectionListeners.remove(listener) }
    fun notifySelectionChanged() { selectionListeners.forEach { it() } }

    /**
     * Listeners notified when a commit memory's PR or Jolli-share state changes — a PR
     * created/updated for the branch, or a memory shared to the Jolli site. All surfaces
     * that show those two states (the Commits list, an open memory summary, the Create PR
     * view) subscribe so they re-read the shared truth — the branch PR
     * ([ai.jolli.jollimemory.services.PrService.findPrForBranch]) and each summary's
     * `jolliDocUrl`/`jolliDocId` — and never disagree. Since GitHub has one PR per branch,
     * creating it from any surface must update them all.
     */
    private val memoryStateListeners = CopyOnWriteArrayList<() -> Unit>()
    fun addMemoryStateListener(listener: () -> Unit) { memoryStateListeners.add(listener) }
    fun removeMemoryStateListener(listener: () -> Unit) { memoryStateListeners.remove(listener) }
    fun notifyMemoryStateChanged() { memoryStateListeners.forEach { it() } }

    /**
     * Adds a sync-state listener. If a sync state has already been observed,
     * the listener is invoked immediately with it so late-registering panels
     * reflect the current state.
     */
    fun addSyncStateListener(listener: (SyncState, SyncStatusDetail?) -> Unit) {
        syncListeners.add(listener)
        val s = syncState
        if (s != null) listener(s, syncDetail)
    }
    fun removeSyncStateListener(listener: (SyncState, SyncStatusDetail?) -> Unit) { syncListeners.remove(listener) }

    /** Debug log of initialization steps. */
    var initLog: String = ""
        private set

    @Volatile
    var isInitialized: Boolean = false
        private set

    /**
     * Set to `true` when a previously available `.git` directory is no longer found.
     * The tool window factory observes this via status listeners to switch back
     * to the "no Git" placeholder.
     */
    @Volatile
    var gitRemoved: Boolean = false
        private set

    /**
     * Resets initialization state so [initialize] can run again.
     * Called when `.git` reappears after being removed (e.g., user ran `git init`
     * after previously deleting the repo).
     */
    fun resetForReinitialization() {
        gitRemoved = false
        isInitialized = false
    }

    fun initialize() {
        if (isInitialized) return
val sb = StringBuilder()
        val basePath = project.basePath
        sb.appendLine("basePath=$basePath")

        if (basePath == null) {
            lastError = "Project has no base path"
            initLog = sb.toString()
            return
        }

        // Check .git entry
        val gitEntry = java.io.File(basePath, ".git")
        sb.appendLine(".git exists=${gitEntry.exists()}, isFile=${gitEntry.isFile}, isDir=${gitEntry.isDirectory}")
        if (gitEntry.isFile) {
            sb.appendLine(".git content=${gitEntry.readText().trim()}")
        }

        val gitOps = GitOps(basePath)
        val resolvedRoot = gitOps.resolveMainWorktreeRoot() ?: basePath
        mainRepoRoot = resolvedRoot
        JmLogger.setLogDir(resolvedRoot)
        sb.appendLine("resolvedRoot=$resolvedRoot")

        // Check key files in resolved root
        val claudeFile = java.io.File(resolvedRoot, ".claude/settings.local.json")
        sb.appendLine("claudeSettings=${claudeFile.absolutePath} exists=${claudeFile.exists()}")
        val sessionsFile = java.io.File(resolvedRoot, ".jolli/jollimemory/sessions.json")
        sb.appendLine("sessions=${sessionsFile.absolutePath} exists=${sessionsFile.exists()}")
        val configFile = java.io.File(resolvedRoot, ".jolli/jollimemory/config.json")
        sb.appendLine("config=${configFile.absolutePath} exists=${configFile.exists()}")

        git = gitOps
        installer = HookInstaller(basePath, resolvedRoot)
        reader = SummaryReader(resolvedRoot, gitOps)

        sb.appendLine("installerDebug=${installer!!.getDebugInfo()}")

        try {
            refreshStatus()
            sb.appendLine("status=${cachedStatus}")
        } catch (e: Exception) {
            sb.appendLine("refreshStatus error: ${e.message}")
            lastError = "Status check failed: ${e.message}"
        }

        // Ensure Claude Code skill file is up to date
        try {
            ai.jolli.jollimemory.bridge.SkillInstaller(resolvedRoot).updateSkillIfNeeded()
            sb.appendLine("Skill file checked/updated")
        } catch (e: Exception) {
            sb.appendLine("Skill update failed: ${e.message}")
        }

        // Auto-initialize KB folder with repo identity + auto-migrate
        try {
            val repoName = KBPathResolver.extractRepoName(resolvedRoot)
            val remoteUrl = KBPathResolver.getRemoteUrl(resolvedRoot)
            val config = SessionTracker.loadConfig()
            val kbRoot = KBPathResolver.resolve(repoName, remoteUrl, config.knowledgeBasePath)
            KBPathResolver.initializeKBFolder(kbRoot, repoName, remoteUrl)
            sb.appendLine("KB folder initialized: $kbRoot")

            // Auto-migrate: if orphan branch has data but migration not completed yet
            val orphan = ai.jolli.jollimemory.core.OrphanBranchStorage(gitOps)
            if (orphan.exists()) {
                val mm = ai.jolli.jollimemory.core.MetadataManager(kbRoot.resolve(".jolli"))
                val migrationState = mm.readMigrationState()
                if (migrationState == null || migrationState.status != "completed") {
                    val folder = ai.jolli.jollimemory.core.FolderStorage(kbRoot, mm)
                    val engine = ai.jolli.jollimemory.core.MigrationEngine(orphan, folder, mm)
                    val result = engine.runMigration()
                    sb.appendLine("Auto-migration: ${result.status} (${result.migratedEntries}/${result.totalEntries})")
                } else {
                    sb.appendLine("Migration already completed")
                }
            }
        } catch (e: Exception) {
            sb.appendLine("KB folder init/migration failed: ${e.message}")
        }

        // Auto-install hooks if configured and not paused (eliminates the separate "Enable" step)
        val config = SessionTracker.loadConfigFromDir(SessionTracker.getGlobalConfigDir())
        val hasCredentials = !config.apiKey.isNullOrBlank() ||
            !System.getenv("ANTHROPIC_API_KEY").isNullOrBlank() ||
            !config.jolliApiKey.isNullOrBlank()
        val isPaused = config.paused == true
        if (hasCredentials && !isPaused && cachedStatus?.enabled != true) {
            sb.appendLine("Auto-installing hooks (configured + not paused + not yet enabled)")
            install()
            refreshStatus()
            sb.appendLine("status after auto-install=${cachedStatus}")
        } else if (hasCredentials && !isPaused && cachedStatus?.enabled == true) {
            // Plugin-upgrade catch-up: hooks are already installed (so the block above is
            // skipped), but the node integrations (MCP + skills + bundled Cli.js) may be
            // absent or built for an older plugin version. Refresh them off the EDT so a
            // plugin update activates MCP/skills without a manual re-enable. Version-gated,
            // so this is a no-op once current.
            com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
                try {
                    val issue = installer?.ensureIntegrations()
                    if (issue != null) {
                        refreshStatus() // so the StatusPanel row reflects the new integration state
                        notifyIntegrationsIssue(issue)
                    }
                } catch (e: Exception) {
                    log.warn("Integrations catch-up failed (non-fatal): ${e.message}")
                }
            }
        }

        isInitialized = true
        initLog = sb.toString()
        log.info("Initialize complete:\n$initLog")

        // Subscribe to Git repository changes (new commits, branch switches, etc.)
        // This mirrors VS Code's .git/HEAD file watcher for auto-refresh.
        val connection = project.messageBus.connect(this)
        connection.subscribe(
            GitRepository.GIT_REPO_CHANGE,
            GitRepositoryChangeListener { refreshStatus() },
        )

        // ── Orphan branch ref + lock file watcher (NIO WatchService) ──────
        // The post-commit hook worker runs in the background and writes summaries
        // to the orphan branch via `git update-ref`. IntelliJ's GIT_REPO_CHANGE
        // does NOT fire for orphan branch ref updates (only working-tree changes).
        // IntelliJ's VFS BulkFileListener also misses .git/ internal changes because
        // those directories are excluded from VFS scanning.
        //
        // We use Java NIO WatchService for OS-level file monitoring (like VS Code's
        // FileSystemWatcher), watching:
        //   .git/refs/heads/jollimemory/summaries/ (orphan ref parent dir)
        //   .jolli/jollimemory/ (lock file dir — worker completion fallback)
        startNioFileWatchers(resolvedRoot)

        // Write debug log to a temp file for easy access
        try {
            val logFile = java.io.File(System.getProperty("user.home") + "/.jolli/logs", "jollimemory-intellij-debug.log").also { it.parentFile.mkdirs() }
            logFile.writeText("=== JolliMemory IntelliJ Init Log ===\n${java.time.Instant.now()}\n\n$initLog")
            log.info("Debug log written to: ${logFile.absolutePath}")
        } catch (_: Exception) { }
    }

    /**
     * Starts OS-level file watchers using Java NIO WatchService.
     *
     * Watches the parent directories of the orphan branch ref file and the lock file.
     * Unlike IntelliJ's VFS BulkFileListener (which excludes .git/ internals),
     * NIO WatchService monitors at the OS level (FSEvents on macOS, inotify on Linux),
     * matching VS Code's FileSystemWatcher behavior.
     */
    private fun startNioFileWatchers(repoRoot: String) {
        val orphanBranch = JmLogger.ORPHAN_BRANCH
        // Watch the parent dir of the orphan ref: .git/refs/heads/jollimemory/summaries/
        val orphanRefDir = Path.of(repoRoot, ".git", "refs", "heads", orphanBranch).parent
        // Watch .jolli/jollimemory/ for lock file changes
        val lockDir = Path.of(repoRoot, ".jolli", "jollimemory")

        // The ref file name we're looking for (e.g., "v3")
        val orphanRefFileName = Path.of(orphanBranch).fileName.toString()
        val lockFileName = "lock"

        try {
            val watchService = FileSystems.getDefault().newWatchService()
            nioWatchService = watchService

            // Ensure directories exist before watching
            if (Files.isDirectory(orphanRefDir)) {
                orphanRefDir.register(watchService,
                    StandardWatchEventKinds.ENTRY_CREATE,
                    StandardWatchEventKinds.ENTRY_MODIFY)
                log.info("NIO watcher registered on: $orphanRefDir")
            } else {
                log.info("Orphan ref dir does not exist yet, skipping NIO watch: $orphanRefDir")
            }

            if (Files.isDirectory(lockDir)) {
                lockDir.register(watchService,
                    StandardWatchEventKinds.ENTRY_CREATE,
                    StandardWatchEventKinds.ENTRY_DELETE,
                    // ENTRY_MODIFY so a live plans.json write (StopHook reference/plan
                    // discovery) refreshes the panel. The lock-file create/delete signal
                    // is too brief for the macOS polling WatchService to catch reliably,
                    // and plans.json persists — so watching the data file itself is the
                    // reliable trigger for CONTEXT updates during a session.
                    StandardWatchEventKinds.ENTRY_MODIFY)
                log.info("NIO watcher registered on: $lockDir")
            } else {
                log.info("Lock dir does not exist yet, skipping NIO watch: $lockDir")
            }

            // Background thread to poll watch events
            val thread = Thread({
                try {
                    while (!Thread.currentThread().isInterrupted) {
                        val key = watchService.take() // Blocks until event
                        var shouldRefresh = false
                        for (event in key.pollEvents()) {
                            val fileName = (event.context() as? Path)?.toString() ?: continue
                            // Refresh on: orphan-ref updates (summary written), lock file
                            // create/delete (worker start/finish), and plans.json writes
                            // (StopHook reference/plan discovery during a live session —
                            // this is what surfaces a newly created plan in CONTEXT without
                            // waiting for the next commit). Other files in the dir
                            // (debug.log, sessions.json, cursors.json) are ignored here so
                            // their churn doesn't spam refreshes.
                            if (fileName == orphanRefFileName || fileName == lockFileName || fileName == "plans.json") {
                                shouldRefresh = true
                            }
                        }
                        key.reset()
                        if (shouldRefresh) {
                            scheduleDebouncedOrphanRefresh()
                        }
                    }
                } catch (_: InterruptedException) {
                    // Normal shutdown
                } catch (_: java.nio.file.ClosedWatchServiceException) {
                    // Normal shutdown
                } catch (ex: Exception) {
                    log.warn("NIO watch thread error: ${ex.message}")
                }
            }, "JolliMemory-NIO-Watcher")
            thread.isDaemon = true
            thread.start()
            nioWatchThread = thread
        } catch (ex: Exception) {
            log.warn("Failed to start NIO file watchers: ${ex.message}")
        }
    }

    /**
     * Debounced refresh for orphan branch ref changes.
     * The worker writes multiple git objects in sequence (blob → tree → commit → update-ref),
     * which may trigger multiple events. A 500ms debounce collapses them into one refresh.
     */
    private fun scheduleDebouncedOrphanRefresh() {
        orphanRefDebounceTimer?.stop()
        orphanRefDebounceTimer = Timer(500) {
            ApplicationManager.getApplication().executeOnPooledThread { refreshStatus() }
        }.apply {
            isRepeats = false
            start()
        }
    }

    fun getStatus(): StatusInfo? = cachedStatus

    @Synchronized
    fun refreshStatus(): StatusInfo? {
        lastError = null

        // Check if .git was removed since initialization
        val basePath = project.basePath
        if (basePath != null && !java.io.File(basePath, ".git").exists()) {
            gitRemoved = true
            lastError = "Git repository removed"
            cachedStatus = null
            log.info("JolliMemory: .git directory no longer exists at $basePath")
            notifyListeners()
            return null
        }

        val i = installer
        val r = reader
        if (i == null || r == null) {
            lastError = "Service not initialized"
            return null
        }

        return try {
            val newStatus = r.getStatus(i)
            // During install protection period, don't downgrade from enabled to disabled.
            // GIT_REPO_CHANGE events fire when .git/hooks/ is modified and can momentarily
            // read stale hook state, causing status to flap enabled→disabled→enabled.
            val wasEnabled = cachedStatus?.enabled == true
            val isProtected = System.currentTimeMillis() < installProtectionUntil
            if (isProtected && wasEnabled && !newStatus.enabled) {
                log.info("refreshStatus: suppressed enabled→disabled flap (install protection active)")
                return cachedStatus
            }
            cachedStatus = newStatus
            notifyListeners()
            cachedStatus
        } catch (e: Exception) {
            // Check if the error is because .git was removed
            if (basePath != null && !java.io.File(basePath, ".git").exists()) {
                gitRemoved = true
                lastError = "Git repository removed"
                cachedStatus = null
                log.info("JolliMemory: .git removed (detected via error): ${e.message}")
                notifyListeners()
                return null
            }
            lastError = "Status check failed: ${e.message}"
            log.warn(lastError!!)
            notifyListeners()
            null
        }
    }

    fun install(): Boolean {
        val result = installer?.install()
        if (result != null && result.success) {
            // Protect against GIT_REPO_CHANGE flapping: for 3 seconds after install,
            // refreshStatus() will not downgrade enabled:true → enabled:false.
            installProtectionUntil = System.currentTimeMillis() + 3000
            result.integrationsIssue?.let { notifyIntegrationsIssue(it) }
            refreshStatus()
            return true
        }
        lastError = result?.message ?: "Installer not available"
        return false
    }

    /**
     * Non-blocking heads-up when MCP + skills could not be set up (Node missing, bundle
     * missing, or the bundled CLI failed): memory generation works (Java hooks), but the
     * Node-powered features are unavailable. Never an error — just guidance. The durable
     * surface is the StatusPanel "MCP & Skills" row; this balloon is the first-time nudge.
     */
    private fun notifyIntegrationsIssue(message: String) {
        try {
            com.intellij.notification.NotificationGroupManager.getInstance()
                .getNotificationGroup("JolliMemory")
                .createNotification(
                    "Jolli Memory: MCP & skills unavailable",
                    message,
                    com.intellij.notification.NotificationType.WARNING,
                )
                .notify(project)
        } catch (t: Throwable) {
            // Notification is best-effort; never fail install over it — but no longer silent.
            log.warn("Failed to show integrations notification: ${t.message}")
        }
    }

    fun uninstall(): Boolean {
        val result = installer?.uninstall()
        if (result != null && result.success) {
            // Clear protection so disable takes effect immediately
            installProtectionUntil = 0L
            refreshStatus()
            return true
        }
        lastError = result?.message ?: "Installer not available"
        return false
    }

    fun listSummaries(): List<CommitSummaryBrief> = reader?.listSummaries() ?: emptyList()

    /**
     * Lists memory entries from the orphan branch index for the Memories panel.
     * Returns root entries (parentCommitHash == null), sorted by commitDate descending,
     * with optional case-insensitive filtering on commitMessage and branch.
     *
     * @param count Max number of entries to return
     * @param filter Optional search text (filters by commitMessage or branch)
     * @return Pair of (matched entries, total count before pagination)
     */
    /**
     * Lists memory entries for the Memories panel.
     *
     * @param count Max number of entries to return
     * @param filter Optional search text (filters by commitMessage or branch)
     * @param scope "branch" = current branch only, "repo" = all branches, "all" = all repos in memory bank
     * @return Pair of (matched entries, total count before pagination)
     */
    fun listMemoryEntries(count: Int, filter: String? = null, scope: String = "branch"): Pair<List<ai.jolli.jollimemory.core.SummaryIndexEntry>, Int> {
        val g = git ?: return emptyList<ai.jolli.jollimemory.core.SummaryIndexEntry>() to 0
        val projectPath = mainRepoRoot ?: ""
        val store = ai.jolli.jollimemory.core.SummaryStore(projectPath, g, StorageFactory.create(g, projectPath))
        val index = store.loadIndex()
            ?: return emptyList<ai.jolli.jollimemory.core.SummaryIndexEntry>() to 0

        // Filter to root entries only (no child/incremental summaries)
        var entries = index.entries
            .filter { it.parentCommitHash == null }
            .sortedByDescending { it.commitDate }

        // Apply scope filter
        if (scope == "branch") {
            val currentBranch = g.getCurrentBranch()?.trim()
            if (!currentBranch.isNullOrBlank()) {
                entries = entries.filter { it.branch == currentBranch }
            }
        }
        // scope == "repo" → no branch filter (all branches in this repo)
        // scope == "all" → same as repo for now (memory bank browsing is in KB panel)

        // Apply search filter
        if (!filter.isNullOrBlank()) {
            val lowerFilter = filter.lowercase()
            entries = entries.filter { entry ->
                entry.commitMessage.lowercase().contains(lowerFilter) ||
                    entry.branch.lowercase().contains(lowerFilter)
            }
        }

        val totalCount = entries.size
        return entries.take(count) to totalCount
    }

    fun getSummary(commitHash: String): CommitSummary? {
        // Try direct lookup first, then resolve through tree-hash aliases
        val direct = reader?.getSummary(commitHash)
        if (direct != null) return direct

        val g = git ?: return null
        val projectPath = mainRepoRoot ?: ""
            val store = ai.jolli.jollimemory.core.SummaryStore(projectPath, g, StorageFactory.create(g, projectPath))
        val resolvedHash = store.resolveAlias(commitHash)
        if (resolvedHash != commitHash) {
            // Find the root summary for the alias target
            val rootHash = store.findRootHash(resolvedHash) ?: resolvedHash
            return reader?.getSummary(rootHash)
        }
        return null
    }

    fun getSummaryJson(commitHash: String): String? = reader?.getSummaryJson(commitHash)

    /** Archived plan body (`plans/<slug>.md`) from committed-memory storage, or null. */
    fun readArchivedPlan(slug: String): String? = reader?.readPlanBody(slug)

    /** Archived markdown-note body (`notes/<id>.md`) from committed-memory storage, or null. */
    fun readArchivedNote(id: String): String? = reader?.readNoteBody(id)

    /** Stored committed conversation (by session) rendered as read-only markdown, or null. */
    fun readCommittedConversationMarkdown(commitHash: String, sessionId: String): String? =
        reader?.renderCommittedConversationMarkdown(commitHash, sessionId)

    fun getChangedFiles(): List<FileChange> {
        val output = git?.getStatus() ?: return emptyList()
        // Parse the NUL-separated `git status -z` stream (mirrors VS Code's listFiles):
        //   normal entry: <XY><space><path>; rename/copy adds the old path as the next segment.
        val segments = output.split("\u0000")
        val files = mutableListOf<FileChange>()
        var i = 0
        while (i < segments.size) {
            val segment = segments[i]
            if (segment.length < 3) { i++; continue }
            val stagedCode = segment[0]
            val unstagedCode = segment[1]
            val resolvedPath = segment.substring(3)
            // Rename/copy carries the original path in the next NUL segment — consume it.
            if (stagedCode == 'R' || stagedCode == 'C') i++
            // Belt-and-suspenders: skip any directory-shaped row (files-only list).
            if (resolvedPath.endsWith("/")) { i++; continue }
            // Single display code: the index column when staged, else the worktree column.
            val code = if (stagedCode != ' ' && stagedCode != '?') stagedCode else unstagedCode
            files.add(FileChange(relativePath = resolvedPath, statusCode = code.toString()))
            i++
        }
        return files
    }

    fun getBranchCommits(): List<CommitSummaryBrief> {
        val g = git ?: run {
            log.warn("getBranchCommits: git is null")
            return emptyList()
        }

        // Resolve base ref: prefer origin/main over main (matches VS Code resolveHistoryBaseRef)
        val baseRef = listOf("origin/main", "upstream/main", "main").firstOrNull { ref ->
            g.exec("rev-parse", "--verify", ref) != null
        } ?: "main"

        val headHash = g.getHeadHash()

        // Find merge-base (val so the else arm below smart-casts it to non-null).
        val mergeBaseRaw = g.exec("merge-base", "HEAD", baseRef)?.trim()
        val mergeBase = mergeBaseRaw?.takeIf { it.isNotBlank() }

        // If merge-base equals HEAD, we're on main or the branch is fully merged.
        // - With a remote (baseRef = origin/*): show commits not on the remote
        //   (origin/main..HEAD) — empty when fully synced.
        // - Without a remote (baseRef = main / upstream/*): enter merged mode and
        //   list the user's own commits from the reflog creation point, filtered by
        //   author. This mirrors VS Code listBranchCommits, which shows committed
        //   memories on main even in a repo with no remote (previously IntelliJ
        //   returned an empty panel here).
        var authorFilter: String? = null
        val range: String? = when {
            mergeBase == null -> null // No common ancestor
            mergeBase == headHash && baseRef.startsWith("origin/") -> "$baseRef..HEAD"
            mergeBase == headHash -> {
                val branch = g.getCurrentBranch()?.trim()
                val merged = if (branch.isNullOrBlank()) null else g.resolveMergedHistory(branch)
                // A branch/main that never authored anything of its own (only
                // creation + rebase/reset) has no commits to show — clear the panel.
                if (merged == null || !merged.hasOwnCommit) return emptyList()
                // Merged mode is author-scoped; without a user.name the filter can't
                // be applied, so degrade to the empty panel rather than over-listing.
                authorFilter = g.getCurrentUserName() ?: return emptyList()
                "${merged.base}..HEAD"
            }
            else -> {
                // Narrow the fork point to the branch's true reflog creation point,
                // so a branch cut from a feature/release branch — including a
                // brand-new branch that still shares its parent's tip — does not
                // inherit the base branch's commits as its own. When the refined
                // base equals HEAD the branch has no own commits yet, so the panel
                // clears. Mirrors VS Code listBranchCommits -> resolveOwnCommitsBase.
                val branch = g.getCurrentBranch()?.trim()
                val ownBase = if (branch.isNullOrBlank()) mergeBase else g.resolveOwnCommitsBase(branch, mergeBase)
                if (ownBase == headHash) return emptyList()
                "$ownBase..HEAD"
            }
        }

        // Get commits with full metadata. In merged mode an --author filter scopes
        // the range to the current user's own commits (matching VS Code).
        val logArgs = if (range != null) {
            val base = arrayOf("log", range, "--format=%H%x00%s%x00%an%x00%ae%x00%aI%x00%x00", "--no-merges")
            if (authorFilter != null) base + "--author=$authorFilter" else base
        } else {
            arrayOf("log", "--format=%H%x00%s%x00%an%x00%ae%x00%aI%x00%x00", "--no-merges", "-20")
        }
        val output = g.exec(*logArgs) ?: return emptyList()
        if (output.isBlank()) return emptyList()

        // Parse entries (split on double-NUL separator)
        val rawEntries = output.split("\u0000\u0000\n").filter { it.isNotBlank() }
        val parsedEntries = rawEntries.map { it.split("\u0000") }.filter { it.size >= 5 }
        val commitHashes = parsedEntries.map { it[0] }

        // Batch check which commits have summaries (including tree-hash aliases)
        val projectPath = mainRepoRoot ?: ""
            val store = ai.jolli.jollimemory.core.SummaryStore(projectPath, g, StorageFactory.create(g, projectPath))
        var summaryHashSet = store.filterCommitsWithSummary(commitHashes)

        // Scan unmatched commits for tree-hash aliases (cross-branch matching)
        val unmatchedHashes = commitHashes.filter { it !in summaryHashSet }
        if (unmatchedHashes.isNotEmpty()) {
            val aliasesFound = store.scanTreeHashAliases(unmatchedHashes)
            if (aliasesFound) {
                // Re-check with new aliases
                summaryHashSet = store.filterCommitsWithSummary(commitHashes)
            }
        }

        // Detect pushed commits — matches VS Code resolvePushBaseRef() fallback chain:
        // 1) @{upstream}  2) origin/<branch>  3) no base (branch not published)
        val unpushedHashes = mutableSetOf<String>()
        val pushBaseRef = resolvePushBaseRef(g)
        val unpushedOutput = if (pushBaseRef != null) g.exec("rev-list", "$pushBaseRef..HEAD") else null
        if (unpushedOutput != null) {
            unpushedOutput.lines().filter { it.isNotBlank() }.forEach { unpushedHashes.add(it) }
        }

        return parsedEntries.map { parts ->
            val hash = parts[0]
            val message = parts[1]
            val author = parts[2]
            val email = parts[3]
            val isoDate = parts[4]

            // Get diff stats per commit
            val diffStatRaw = g.exec("diff", "--shortstat", "$hash^", hash) ?: ""
            val (files, ins, del) = parseDiffStatLine(diffStatRaw)

            // Get topic count, commit type, and memory-detail enrichment from the
            // summary (resolving aliases). The enrichment fields feed the panel's
            // token meter, status chips, and collapsed sub-line without a second
            // read per row at expand time.
            var topicCount = 0
            var commitType: String? = null
            // Canonical (TS-identical) display fields: prefer the shared summary's
            // top-level breakdown/cost; fall back to a legacy IntelliJ `tokenUsage`
            // object (mapping cached = cache_creation, dropping cache_read to match TS).
            var tokenBreakdown: ai.jolli.jollimemory.core.ConversationTokenBreakdown? = null
            var estimatedCostUsd: Double? = null
            var e2eScenarioCount = 0
            var isSyncedToJolli = false
            var jolliDocUrl: String? = null
            var conversationTurns: Int? = null
            var contextCount = 0
            if (hash in summaryHashSet) {
                val resolvedHash = store.resolveAlias(hash)
                val rootHash = store.findRootHash(resolvedHash) ?: resolvedHash
                val summary = reader?.getSummary(rootHash)
                if (summary != null) {
                    topicCount = ai.jolli.jollimemory.core.SummaryTree.countTopics(summary)
                    if (summary.commitType != null && summary.commitType.name != "commit") {
                        commitType = summary.commitType.name
                    }
                    tokenBreakdown = summary.conversationTokenBreakdown
                        ?: summary.tokenUsage?.let {
                            ai.jolli.jollimemory.core.ConversationTokenBreakdown(
                                it.inputTokens,
                                it.outputTokens,
                                it.cacheWriteTokens,
                            )
                        }
                    estimatedCostUsd = summary.estimatedCostUsd
                        ?: summary.conversationModels?.let {
                            ai.jolli.jollimemory.core.ModelPricing.estimateCostUsd(it).takeIf { c -> c > 0.0 }
                        }
                    e2eScenarioCount = summary.e2eTestGuide?.size ?: 0
                    isSyncedToJolli = summary.jolliDocId != null || summary.jolliDocUrl != null
                    jolliDocUrl = summary.jolliDocUrl
                    conversationTurns = summary.conversationTurns
                    contextCount = (summary.plans?.size ?: 0) +
                        (summary.notes?.size ?: 0) +
                        (summary.references?.size ?: 0)
                }
            }

            // Short date: MM-DD
            val shortDate = try {
                val instant = java.time.Instant.parse(isoDate)
                val ld = instant.atZone(java.time.ZoneId.systemDefault()).toLocalDate()
                "${ld.monthValue.toString().padStart(2, '0')}-${ld.dayOfMonth.toString().padStart(2, '0')}"
            } catch (_: Exception) { isoDate.take(10) }

            CommitSummaryBrief(
                hash = hash,
                shortHash = hash.take(7),
                message = message,
                author = author,
                authorEmail = email,
                date = isoDate,
                shortDate = shortDate,
                topicCount = topicCount,
                insertions = ins,
                deletions = del,
                filesChanged = files,
                isPushed = pushBaseRef != null && hash !in unpushedHashes,
                hasSummary = hash in summaryHashSet,
                commitType = commitType,
                conversationTokenBreakdown = tokenBreakdown,
                estimatedCostUsd = estimatedCostUsd,
                e2eScenarioCount = e2eScenarioCount,
                isSyncedToJolli = isSyncedToJolli,
                jolliDocUrl = jolliDocUrl,
                conversationTurns = conversationTurns,
                contextCount = contextCount,
            )
        }
    }

    /** Reads the committed AI conversations for a commit (CONVERSATIONS group). */
    fun getCommittedConversations(hash: String, summary: CommitSummary? = null): List<ConversationBrief> =
        reader?.getCommittedConversations(hash, summary) ?: emptyList()

    /**
     * Lists files changed in a specific commit — matches VS Code listCommitFiles().
     * Uses `git diff-tree` with rename detection, first-parent merge handling, and root commit support.
     */
    fun listCommitFiles(hash: String): List<CommitFileInfo> {
        val g = git ?: return emptyList()
        val raw = g.exec(
            "-c", "core.quotepath=false",
            "diff-tree", "-m", "--first-parent", "-M", "-r", "--name-status", "--root", hash,
        ) ?: return emptyList()

        val files = mutableListOf<CommitFileInfo>()
        var seenFiles = false

        for (rawLine in raw.split("\n")) {
            val entry = rawLine.trimEnd('\r')
            // Hash header or empty line — stop after first parent's diff block
            if (entry.isBlank() || !entry.contains("\t")) {
                if (seenFiles) break
                continue
            }
            seenFiles = true

            val parts = entry.split("\t")
            val rawStatus = parts[0]
            // Normalize: strip similarity percentage from rename codes (e.g. "R100" → "R")
            val statusCode = if (rawStatus.startsWith("R")) "R" else rawStatus

            if (statusCode == "R" && parts.size >= 3) {
                files.add(CommitFileInfo(relativePath = parts[2], statusCode = statusCode, oldPath = parts[1]))
            } else if (parts.size >= 2) {
                files.add(CommitFileInfo(relativePath = parts[1], statusCode = statusCode))
            }
        }
        return files
    }

    /**
     * Resolves the push comparison base for "isPushed" status.
     * Matches VS Code's resolvePushBaseRef() fallback chain:
     *   1) @{upstream}
     *   2) origin/<currentBranch>
     *   3) null (branch not published yet — all commits treated as not pushed)
     */
    private fun resolvePushBaseRef(g: GitOps): String? {
        // Try upstream tracking ref first
        val upstream = g.exec("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")?.trim()
        if (!upstream.isNullOrBlank()) {
            // Verify the ref actually exists
            val resolved = g.exec("rev-parse", "--verify", "--quiet", upstream)?.trim()
            if (!resolved.isNullOrBlank()) return upstream
        }
        // Fallback: origin/<currentBranch>
        val branch = g.getCurrentBranch()?.trim()
        if (!branch.isNullOrBlank()) {
            val originRef = "origin/$branch"
            val resolved = g.exec("rev-parse", "--verify", "--quiet", originRef)?.trim()
            if (!resolved.isNullOrBlank()) return originRef
        }
        // Branch not published — no push base
        return null
    }

    /** Parses "N files changed, N insertions(+), N deletions(-)" */
    private fun parseDiffStatLine(line: String): Triple<Int, Int, Int> {
        var files = 0; var ins = 0; var del = 0
        val filesMatch = Regex("(\\d+) files? changed").find(line)
        val insMatch = Regex("(\\d+) insertions?").find(line)
        val delMatch = Regex("(\\d+) deletions?").find(line)
        if (filesMatch != null) files = filesMatch.groupValues[1].toInt()
        if (insMatch != null) ins = insMatch.groupValues[1].toInt()
        if (delMatch != null) del = delMatch.groupValues[1].toInt()
        return Triple(files, ins, del)
    }

    /**
     * Checks whether the current branch is fully merged into main.
     * A branch is merged when merge-base(HEAD, main) equals HEAD itself,
     * meaning all branch commits are already reachable from main.
     */
    fun isBranchMerged(): Boolean {
        val g = git ?: return false
        val headHash = g.getHeadHash() ?: return false
        val baseRef = listOf("origin/main", "upstream/main", "main").firstOrNull { ref ->
            g.exec("rev-parse", "--verify", ref) != null
        } ?: return false
        val mergeBase = g.exec("merge-base", "HEAD", baseRef)?.trim()
        return !mergeBase.isNullOrBlank() && mergeBase == headHash
    }

    fun getGitOps(): GitOps? = git
    fun getInstallerDebug(): String = installer?.getDebugInfo() ?: "installer is null"

    // ── Sync orchestrator lifecycle ──────────────────────────────────────

    /**
     * Start the sync orchestrator with the given engine and poll interval.
     * Wires the orchestrator's state changes to the status bar widget.
     */
    fun startSync(engine: SyncEngine, cwd: String, pollIntervalSec: Int? = null) {
        stopSync()
        val widget = findSyncWidget()
        val orch = SyncOrchestrator(SyncOrchestratorOpts(
            engine = engine,
            cwd = cwd,
            pollIntervalSec = pollIntervalSec,
            lastSuccessAtMs = lastSyncSuccessAtMs,
            onStateChange = { state, detail ->
                val gen = syncStateGen.incrementAndGet()
                syncState = state
                syncDetail = detail
                ApplicationManager.getApplication().invokeLater {
                    widget?.setSyncState(state, detail)
                    syncListeners.forEach { it(state, detail) }
                }
                scheduleStatusAutoClear(state, gen)
            },
        ))
        orchestrator = orch
        orch.start()
    }

    /** Stop the sync polling loop (orchestrator remains usable for manual sync). */
    fun stopSync() {
        orchestrator?.stop()
        // A terminal failure from the last round is sticky: the status bar only
        // leaves OFFLINE on a subsequent *successful* round, which never comes
        // once polling has stopped (sign-out, auto-sync disabled, restart). Reset
        // it so a stale "✗ Sync failed" badge doesn't linger while no sync runs.
        // Gated on "was actually a failure" so a healthy ✓ state is preserved
        // across the stop()/start() restart dance. Widget + cached state +
        // listeners are reset together, mirroring the onStateChange path.
        if (syncState == SyncState.OFFLINE && syncDetail?.failed == true) {
            syncStateGen.incrementAndGet()
            syncState = SyncState.OFFLINE
            syncDetail = null
            val widget = findSyncWidget()
            ApplicationManager.getApplication().invokeLater {
                widget?.clearFailureStatus()
                syncListeners.forEach { it(SyncState.OFFLINE, null) }
            }
        }
    }

    /**
     * Auto-dismiss a finished sync status after [STATUS_AUTO_CLEAR_DELAY_MS] so
     * the status bar and KB toolbar return to a neutral resting state instead of
     * holding a stale badge. A failure is the worst offender — it otherwise
     * lingers until the next round (up to 90 min away, or never once polling
     * stops). SYNCING is skipped: it's an in-progress indicator that its own
     * result replaces.
     *
     * The [gen] guard ensures a newer state (a fresh round starting inside the
     * window, a sign-out clear, etc.) is never clobbered by a stale timer: if
     * [syncStateGen] has moved on, the scheduled clear is a no-op. Widget +
     * cached state + listeners are reset together, mirroring the onStateChange
     * path so getSyncState() and late-registering panels stay consistent.
     */
    private fun scheduleStatusAutoClear(state: SyncState, gen: Long) {
        if (!autoClearableSyncState(state)) return
        AppExecutorUtil.getAppScheduledExecutorService().schedule({
            if (syncStateGen.get() != gen) return@schedule
            syncState = SyncState.OFFLINE
            syncDetail = null
            val widget = findSyncWidget()
            ApplicationManager.getApplication().invokeLater {
                if (syncStateGen.get() != gen) return@invokeLater
                widget?.setSyncState(SyncState.OFFLINE, null)
                syncListeners.forEach { it(SyncState.OFFLINE, null) }
            }
        }, STATUS_AUTO_CLEAR_DELAY_MS, TimeUnit.MILLISECONDS)
    }

    /** Trigger a manual sync round, coalescing with any in-flight round. */
    fun requestManualSync() {
        orchestrator?.requestManualSync()
    }

    /**
     * Whether the sync orchestrator has been built yet. Mirrors the
     * `runtime.ensureBuilt()` gate in `vscode/src/sync/SyncCommands.ts`: a
     * manual-sync entry point should lazy-build the orchestrator (via
     * [ai.jolli.jollimemory.sync.SyncActivation.reconcileSync]) when this
     * returns `false` before calling [requestManualSync].
     */
    fun isSyncBuilt(): Boolean = orchestrator != null

    /** Current sync state, or null if sync has never run. */
    fun getSyncState(): SyncState? = syncState

    private fun findSyncWidget(): SyncStatusBarWidget? {
        val statusBar = WindowManager.getInstance().getStatusBar(project) ?: return null
        return statusBar.getWidget(SyncStatusBarWidget.ID) as? SyncStatusBarWidget
    }

    override fun dispose() {
        orchestrator?.dispose()
        orchestrator = null
        orphanRefDebounceTimer?.stop()
        nioWatchThread?.interrupt()
        try { nioWatchService?.close() } catch (_: Exception) { }
        listeners.clear()
        syncListeners.clear()
    }
}

data class FileChange(
    val relativePath: String,
    val statusCode: String,
    var isSelected: Boolean = true,
)

/** A file changed in a specific commit — matches VS Code CommitFileInfo. */
data class CommitFileInfo(
    /** Path relative to workspace root (for renames, this is the new/destination path) */
    val relativePath: String,
    /** Git status letter: M=modified, A=added, D=deleted, R=renamed */
    val statusCode: String,
    /** Original path before rename (only set when statusCode is "R") */
    val oldPath: String? = null,
)

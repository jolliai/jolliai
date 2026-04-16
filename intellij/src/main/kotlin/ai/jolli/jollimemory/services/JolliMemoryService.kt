package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.bridge.CommitSummaryBrief
import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.bridge.HookInstaller
import ai.jolli.jollimemory.bridge.SummaryReader
import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.StatusInfo
import ai.jolli.jollimemory.toolwindow.PanelRegistry
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import git4idea.repo.GitRepository
import git4idea.repo.GitRepositoryChangeListener
import java.io.File
import java.nio.file.FileSystems
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardWatchEventKinds
import java.nio.file.WatchService
import java.util.concurrent.CopyOnWriteArrayList
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
    private var cachedStatus: StatusInfo? = null
    /** The resolved main repo root (handles worktrees). */
    var mainRepoRoot: String? = null
        private set
    var lastError: String? = null
        private set
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private var orphanRefDebounceTimer: Timer? = null
    private var nioWatchService: WatchService? = null
    private var nioWatchThread: Thread? = null

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
                    StandardWatchEventKinds.ENTRY_DELETE)
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
                            if (fileName == orphanRefFileName || fileName == lockFileName) {
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
            cachedStatus = r.getStatus(i)
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
            refreshStatus()
            return true
        }
        lastError = result?.message ?: "Installer not available"
        return false
    }

    fun uninstall(): Boolean {
        val result = installer?.uninstall()
        if (result != null && result.success) {
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
    fun listMemoryEntries(count: Int, filter: String? = null): Pair<List<ai.jolli.jollimemory.core.SummaryIndexEntry>, Int> {
        val g = git ?: return emptyList<ai.jolli.jollimemory.core.SummaryIndexEntry>() to 0
        val store = ai.jolli.jollimemory.core.SummaryStore(mainRepoRoot ?: "", g)
        val index = store.loadIndex() ?: return emptyList<ai.jolli.jollimemory.core.SummaryIndexEntry>() to 0

        // Filter to root entries only (no child/incremental summaries)
        var entries = index.entries
            .filter { it.parentCommitHash == null }
            .sortedByDescending { it.commitDate }

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
        val store = ai.jolli.jollimemory.core.SummaryStore(mainRepoRoot ?: "", g)
        val resolvedHash = store.resolveAlias(commitHash)
        if (resolvedHash != commitHash) {
            // Find the root summary for the alias target
            val rootHash = store.findRootHash(resolvedHash) ?: resolvedHash
            return reader?.getSummary(rootHash)
        }
        return null
    }

    fun getSummaryJson(commitHash: String): String? = reader?.getSummaryJson(commitHash)

    fun getChangedFiles(): List<FileChange> {
        val output = git?.getStatus() ?: return emptyList()
        return output.lines()
            .filter { it.isNotBlank() && it.length > 3 }
            .map { line ->
                FileChange(
                    relativePath = line.substring(3),
                    statusCode = line.substring(0, 2).trim(),
                )
            }
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

        // Find merge-base
        var mergeBase = g.exec("merge-base", "HEAD", baseRef)?.trim()
        if (mergeBase.isNullOrBlank()) {
            mergeBase = null
        }

        // If merge-base equals HEAD, we're on main or branch is fully merged
        // Use origin/main..HEAD to show unpushed commits (matches VS Code behavior)
        val range = when {
            mergeBase == null -> null // No common ancestor
            mergeBase == headHash && baseRef.startsWith("origin/") -> "$baseRef..HEAD"
            mergeBase == headHash -> null // On main with no remote — fall back to recent
            else -> "$mergeBase..HEAD"
        }

        // Get commits with full metadata
        val logArgs = if (range != null) {
            arrayOf("log", range, "--format=%H%x00%s%x00%an%x00%ae%x00%aI%x00%x00", "--no-merges")
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
        val store = ai.jolli.jollimemory.core.SummaryStore(mainRepoRoot ?: "", g)
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

            // Get topic count and commit type from summary (resolving aliases)
            var topicCount = 0
            var commitType: String? = null
            if (hash in summaryHashSet) {
                val resolvedHash = store.resolveAlias(hash)
                val rootHash = store.findRootHash(resolvedHash) ?: resolvedHash
                val summary = reader?.getSummary(rootHash)
                if (summary != null) {
                    topicCount = ai.jolli.jollimemory.core.SummaryTree.countTopics(summary)
                    if (summary.commitType != null && summary.commitType.name != "commit") {
                        commitType = summary.commitType.name
                    }
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
            )
        }
    }

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

    override fun dispose() {
        orphanRefDebounceTimer?.stop()
        nioWatchThread?.interrupt()
        try { nioWatchService?.close() } catch (_: Exception) { }
        listeners.clear()
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

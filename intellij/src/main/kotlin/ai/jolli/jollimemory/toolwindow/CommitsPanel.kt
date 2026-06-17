package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.bridge.CommitSummaryBrief
import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.KBDataCache
import com.google.gson.Gson
import ai.jolli.jollimemory.services.CommitFileInfo
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.icons.AllIcons
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.messages.MessageBusConnection
import com.intellij.util.ui.JBUI
import git4idea.repo.GitRepository
import git4idea.repo.GitRepositoryChangeListener
import java.awt.BorderLayout
import java.awt.Toolkit
import java.awt.datatransfer.StringSelection
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.awt.Color
import java.awt.Component
import java.awt.Cursor
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.io.File
import java.time.Duration
import java.time.Instant
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JCheckBox
import javax.swing.JLabel
import javax.swing.JOptionPane
import javax.swing.JPanel
import javax.swing.SwingConstants
import javax.swing.SwingUtilities
import javax.swing.JSeparator
import javax.swing.JWindow
import javax.swing.Timer
import javax.swing.UIManager

/**
 * Commits panel — matches VS Code HistoryTreeProvider exactly.
 *
 * Each commit is a collapsible row that expands to show changed files:
 *   [▶/▼] [checkbox] <message> [☁] <MM-DD>  [👁]
 *     ├─ [file-icon] filename  relativePath  [M]
 *     └─ [file-icon] filename  relativePath  [A]
 *
 * Uses independent JPanel instances per row (like ChangesPanel) instead of a
 * JTree cell renderer, which eliminates hover-shift artifacts caused by the
 * rubber-stamp rendering pattern.
 *
 * Features:
 * - Collapsible commit → file children (matching VS Code CommitFileItem)
 * - ☁ pushed badge on commit label (matching VS Code buildLabel)
 * - Checkboxes with range-based squash selection
 * - Eye icon for commits with memories
 * - File status decoration (M/A/D colors and icons)
 * - Click file to open git diff
 * - Merged branch detection (read-only mode, no checkboxes)
 */
class CommitsPanel(
    private val project: Project,
    private val service: JolliMemoryService,
) : JPanel(BorderLayout()), Disposable {

    private val listPanel = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
    }
    private val emptyLabel = JBLabel(
        "<html><center>Start coding — your commit memories will appear here.<br/>" +
            "Every commit on this branch will be automatically summarized.</center></html>",
        SwingConstants.CENTER,
    )
    private val checkedHashes = mutableSetOf<String>()
    private var commits: List<CommitSummaryBrief> = emptyList()
    /** Cache of files per commit hash — avoids re-running git for expanded commits.
     *  Stores a CompletableFuture so that concurrent expands share the same in-flight request. */
    private val fileCache = ConcurrentHashMap<String, CompletableFuture<List<CommitFileInfo>>>()
    /** Per-commit UI state for expand/collapse and checkbox management. */
    private val commitRowStates = mutableMapOf<String, CommitRowState>()
    /** True when the branch is fully merged into main (read-only history view). */
    private var isMerged = false

    // ─── Foreign mode state ──────────────────────────────────────────────────
    /** When non-null, the panel shows read-only memories from a foreign repo/branch. */
    private var foreignRepo: String? = null
    private var foreignBranch: String? = null
    private var foreignEntries: List<KBDataCache.KBEntry> = emptyList()

    private val statusListener: () -> Unit = { SwingUtilities.invokeLater { refresh() } }
    private val messageBusConnection: MessageBusConnection = project.messageBus.connect()
    private var gitChangeDebounceTimer: Timer? = null

    // ─── Sticky hover popup (matching VS Code hover-card UX) ────────────────
    private var hoverPopup: JWindow? = null
    private var hoverRow: JPanel? = null
    private var hoverShowTimer: Timer? = null
    private val hoverDismissTimer = Timer(HOVER_HIDE_GRACE_MS) { dismissHoverPopup() }.apply { isRepeats = false }
    private companion object {
        val LOG: com.intellij.openapi.diagnostic.Logger = com.intellij.openapi.diagnostic.Logger.getInstance(CommitsPanel::class.java)
        const val ARROW_RIGHT = "\u25B6" // ▶
        const val ARROW_DOWN = "\u25BC"  // ▼
        const val HOVER_SHOW_DELAY_MS = 1000
        const val HOVER_HIDE_GRACE_MS = 200
    }

    /**
     * Monotonically increasing version counter to prevent stale renders.
     * Each call to [refresh] increments this counter. When [refreshFromGit]
     * completes, it checks whether its version is still current — if a newer
     * refresh was started (e.g., status listener firing after install while
     * the initial slow refresh is still running), the stale result is discarded.
     */
    @Volatile
    private var refreshVersion = 0L

    init {
        border = JBUI.Borders.empty(8)

        service.addStatusListener(statusListener)

        // Subscribe directly to git repository changes (new commits, branch switches).
        // The service's status listener alone may not reliably trigger panel refresh
        // for IntelliJ UI commits — this dedicated listener ensures we catch all changes.
        // A 500ms debounce avoids redundant refreshes from rapid successive events.
        messageBusConnection.subscribe(
            GitRepository.GIT_REPO_CHANGE,
            GitRepositoryChangeListener { scheduleDebouncedGitRefresh() },
        )

        // Also subscribe to VCS config changes (catches terminal branch operations)
        messageBusConnection.subscribe(
            com.intellij.openapi.vcs.ProjectLevelVcsManager.VCS_CONFIGURATION_CHANGED,
            com.intellij.openapi.vcs.VcsListener { scheduleDebouncedGitRefresh() },
        )

        ApplicationManager.getApplication().executeOnPooledThread { refreshFromGit() }
    }

    private fun scheduleDebouncedGitRefresh() {
        gitChangeDebounceTimer?.stop()
        gitChangeDebounceTimer = Timer(500) { refresh() }.apply {
            isRepeats = false
            start()
        }
    }

    fun refresh() {
        if (isForeignMode) {
            // Re-filter from cache in case KBDataCache was reloaded
            setForeignMode(foreignRepo!!, foreignBranch!!)
            return
        }
        refreshVersion++
        ApplicationManager.getApplication().executeOnPooledThread { refreshFromGit() }
    }

    /**
     * Force refresh that bypasses the refreshVersion stale-discard mechanism.
     * Guarantees the UI updates regardless of concurrent refresh races.
     */
    fun forceRefresh() {
        ApplicationManager.getApplication().executeOnPooledThread {
            val status = service.getStatus()
            if (status == null) {
                SwingUtilities.invokeLater { showInitializing() }
                return@executeOnPooledThread
            }
            if (!status.enabled) {
                SwingUtilities.invokeLater { showInitializing() }
                return@executeOnPooledThread
            }
            try {
                val newCommits = service.getBranchCommits()
                isMerged = newCommits.isNotEmpty() && service.isBranchMerged()
                commits = newCommits
                SwingUtilities.invokeLater { updateCommitList() }
            } catch (_: Exception) {
                commits = emptyList()
                SwingUtilities.invokeLater { updateCommitList() }
            }
        }
    }

    /** Range-based checkbox toggle matching VS Code behavior. */
    private fun toggleCheckbox(commit: CommitSummaryBrief) {
        val idx = commits.indexOfFirst { it.hash == commit.hash }
        if (idx < 0) return
        val isChecked = commit.hash in checkedHashes

        if (isChecked) {
            // Uncheck this and everything older (idx to end)
            for (i in idx until commits.size) {
                checkedHashes.remove(commits[i].hash)
            }
        } else {
            // Check this and everything newer (0 to idx)
            for (i in 0..idx) {
                checkedHashes.add(commits[i].hash)
            }
        }
        syncAllCheckboxes()
    }

    fun getSelectedCommits(): List<CommitSummaryBrief> {
        return commits.filter { it.hash in checkedHashes }
    }

    /** Toggles all checkboxes — if all are checked, deselect all; otherwise select all. */
    fun toggleSelectAll() {
        if (commits.size <= 1) return
        val allChecked = commits.all { it.hash in checkedHashes }
        if (allChecked) {
            checkedHashes.clear()
        } else {
            commits.forEach { checkedHashes.add(it.hash) }
        }
        syncAllCheckboxes()
    }

    /** Updates all checkbox UI states to match [checkedHashes]. */
    private fun syncAllCheckboxes() {
        for ((hash, state) in commitRowStates) {
            state.checkbox?.isSelected = hash in checkedHashes
        }
        listPanel.repaint()
    }

    private fun refreshFromGit() {
        // Capture the current version at the start of this refresh.
        // If a newer refresh is triggered while this one is running (e.g., status
        // listener fires after install while the initial slow git log is still in progress),
        // this stale result will be discarded to prevent overwriting the newer UI state.
        val myVersion = refreshVersion

        val status = service.getStatus()
        if (status == null) {
            SwingUtilities.invokeLater { if (refreshVersion == myVersion) showInitializing() }
            return
        }
        if (!status.enabled) {
            SwingUtilities.invokeLater { if (refreshVersion == myVersion) showInitializing() }
            return
        }

        try {
            val newCommits = service.getBranchCommits()

            // Discard if a newer refresh was started while we were fetching
            if (refreshVersion != myVersion) return

            // Clear selection if commit sequence changed
            val newHashes = newCommits.map { it.hash }
            val oldHashes = commits.map { it.hash }
            if (newHashes != oldHashes) {
                if (checkedHashes.isNotEmpty()) checkedHashes.clear()
                // Clear file cache when commit sequence changes
                fileCache.clear()
            }

            // Detect merged state: branch HEAD is reachable from main
            isMerged = newCommits.isNotEmpty() && service.isBranchMerged()

            commits = newCommits
            SwingUtilities.invokeLater { if (refreshVersion == myVersion) updateCommitList() }
        } catch (_: Exception) {
            if (refreshVersion != myVersion) return
            commits = emptyList()
            SwingUtilities.invokeLater { if (refreshVersion == myVersion) updateCommitList() }
        }
    }

    private fun showInitializing() {
        removeAll()
        emptyLabel.text = "<html><center>Initializing Jolli Memory...</center></html>"
        add(emptyLabel, BorderLayout.CENTER)
        revalidate(); repaint()
    }

    private fun updateCommitList() {
        removeAll()
        listPanel.removeAll()
        commitRowStates.clear()

        if (commits.isEmpty()) {
            emptyLabel.text = "<html><center>Start coding — your commit memories will appear here.<br/>" +
                "Every commit on this branch will be automatically summarized.</center></html>"
            add(emptyLabel, BorderLayout.CENTER)
        } else {
            for (commit in commits) {
                val state = createCommitRow(commit)
                commitRowStates[commit.hash] = state
                listPanel.add(state.row)
                listPanel.add(state.fileContainer)
            }
            // Push rows to the top when the list is shorter than the viewport
            listPanel.add(Box.createVerticalGlue())

            add(JBScrollPane(listPanel).apply {
                horizontalScrollBarPolicy = JBScrollPane.HORIZONTAL_SCROLLBAR_NEVER
            }, BorderLayout.CENTER)
        }
        revalidate(); repaint()
    }

    // ─── Row creation ─────────────────────────────────────────────────────────

    /**
     * Creates a commit row and its associated (initially hidden) file container:
     *   [▶/▼] [☐/☑] <message> [☁] [type] MM-DD  [👁]
     *
     * Layout: BorderLayout
     *   WEST   = arrow + checkbox (GridBagLayout)
     *   CENTER = message label (fills space, truncates with "...")
     *   EAST   = eye icon (FlowLayout.RIGHT)
     */
    private fun createCommitRow(commit: CommitSummaryBrief): CommitRowState {
        val singleMode = commits.size <= 1
        val hideCheckboxes = singleMode || isMerged

        // Expand/collapse arrow
        val arrowLabel = JLabel(ARROW_RIGHT).apply {
            font = font.deriveFont(10f)
            foreground = Color.GRAY
            border = JBUI.Borders.emptyRight(4)
        }

        // Checkbox (hidden in single-commit or merged mode)
        val checkbox: JCheckBox? = if (!hideCheckboxes) {
            JCheckBox("", commit.hash in checkedHashes).apply {
                isOpaque = false
                border = JBUI.Borders.empty()
                addActionListener { toggleCheckbox(commit) }
            }
        } else {
            null
        }

        // Left side: arrow + optional checkbox
        val leftPanel = JPanel(FlowLayout(FlowLayout.LEFT, 0, 0)).apply {
            isOpaque = false
            add(arrowLabel)
            if (checkbox != null) add(checkbox)
        }

        // Message label
        val displayMessage = commit.message.ifBlank { commit.shortHash }
        val pushedBadge = if (commit.isPushed) " \u2601" else ""
        val typeBadge = if (commit.commitType != null) " [${commit.commitType}]" else ""
        val datePart = if (commit.shortDate.isNotEmpty()) "  ${commit.shortDate}" else ""
        val messageLabel = JLabel("$displayMessage$pushedBadge$typeBadge$datePart").apply {
            minimumSize = Dimension(0, preferredSize.height)
        }

        // Eye icon (only for commits with summaries)
        val eyeLabel = JLabel(JolliMemoryIcons.Eye).apply {
            isVisible = commit.hasSummary
            toolTipText = "View Commit Memory"
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            border = JBUI.Borders.emptyLeft(4)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    viewSummary(commit.hash)
                }
            })
        }

        // Three-dots "more actions" button (only for commits with a summary).
        // Replaces the old right-click context menu as the sole menu trigger.
        val moreLabel = JLabel(JolliMemoryIcons.MoreVertical).apply {
            isVisible = commit.hasSummary
            toolTipText = "More actions"
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            border = JBUI.Borders.emptyLeft(4)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    if (SwingUtilities.isLeftMouseButton(e)) showCommitRowMenu(commit, e.component, e.x, e.y)
                }
            })
        }

        // Right side: eye icon + three-dots menu
        val rightPanel = JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply {
            isOpaque = false
            add(eyeLabel)
            add(moreLabel)
        }

        val row = JPanel(BorderLayout(2, 0)).apply {
            isOpaque = true
            border = JBUI.Borders.empty(2, 4)
            alignmentX = Component.LEFT_ALIGNMENT
            add(leftPanel, BorderLayout.WEST)
            add(messageLabel, BorderLayout.CENTER)
            add(rightPanel, BorderLayout.EAST)
        }
        // Sticky hover popup — matches VS Code: 1s show delay, 200ms hide grace.
        val hoverListener = object : MouseAdapter() {
            override fun mouseEntered(e: MouseEvent) { scheduleShowHoverPopup(row, commit) }
            override fun mouseExited(e: MouseEvent) { scheduleHoverDismiss() }
        }
        for (child in listOf(arrowLabel, messageLabel, leftPanel, rightPanel, row)) {
            child.addMouseListener(hoverListener)
        }

        // File container — initially hidden, shown on expand
        val fileContainer = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isVisible = false
            alignmentX = Component.LEFT_ALIGNMENT
        }

        val state = CommitRowState(
            row = row,
            fileContainer = fileContainer,
            arrowLabel = arrowLabel,
            checkbox = checkbox,
            isExpanded = false,
            filesLoaded = false,
        )

        // Chevron click toggles expand/collapse only
        val chevronClickListener = object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (!SwingUtilities.isLeftMouseButton(e)) return
                e.consume()
                toggleExpand(commit.hash)
            }
        }
        arrowLabel.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        arrowLabel.addMouseListener(chevronClickListener)

        // Click anywhere else on the row opens the summary (matching VS Code behavior)
        val rowClickListener = object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (!SwingUtilities.isLeftMouseButton(e)) return
                if (commit.hasSummary) {
                    viewSummary(commit.hash)
                }
            }
        }
        for (child in listOf(messageLabel, leftPanel, row)) {
            child.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            child.addMouseListener(rowClickListener)
        }

        row.maximumSize = Dimension(Int.MAX_VALUE, row.preferredSize.height)
        return state
    }

    /**
     * Shows the per-row "more actions" menu, triggered by the three-dots button.
     * Built via IntelliJ's ActionPopupMenu so it picks up IDE theming (hover
     * highlight, keyboard nav, Darcula colors). Mirrors VS Code's MemoryItem menu
     * plus a "Create PR" entry that deep-links into the summary's Create PR flow.
     */
    private fun showCommitRowMenu(commit: CommitSummaryBrief, component: java.awt.Component, x: Int, y: Int) {
        val group = DefaultActionGroup().apply {
            add(object : AnAction("Create PR") {
                override fun actionPerformed(ev: AnActionEvent) = viewSummary(commit.hash)
            })
            add(object : AnAction("Copy Recall Prompt") {
                override fun actionPerformed(ev: AnActionEvent) = copyRecallPrompt(commit.hash)
            })

        }
        val menu = ActionManager.getInstance().createActionPopupMenu("JolliMemory.CommitRowMenu", group)
        menu.component.show(component, x, y)
    }

    /** Toggles the expand/collapse state of a commit's file list. */
    private fun toggleExpand(hash: String) {
        val state = commitRowStates[hash] ?: return
        state.isExpanded = !state.isExpanded
        state.arrowLabel.text = if (state.isExpanded) ARROW_DOWN else ARROW_RIGHT
        state.fileContainer.isVisible = state.isExpanded

        if (state.isExpanded && !state.filesLoaded) {
            loadCommitFiles(hash)
        }

        listPanel.revalidate()
        listPanel.repaint()
    }

    /** Lazily loads commit files on first expansion, deduplicating in-flight git queries. */
    private fun loadCommitFiles(hash: String) {
        val state = commitRowStates[hash] ?: return

        // Show loading indicator
        state.fileContainer.removeAll()
        state.fileContainer.add(JLabel("Loading...").apply {
            foreground = Color.GRAY
            border = JBUI.Borders.empty(2, 28)
            alignmentX = Component.LEFT_ALIGNMENT
        })
        state.fileContainer.revalidate()

        // If a future already exists for this hash, reuse it (dedup in-flight requests).
        // computeIfAbsent is atomic on ConcurrentHashMap, so only one thread creates the future.
        val future = fileCache.computeIfAbsent(hash) {
            CompletableFuture.supplyAsync(
                { service.listCommitFiles(hash) },
                { cmd -> ApplicationManager.getApplication().executeOnPooledThread(cmd) },
            )
        }

        future.whenComplete { files, error ->
            if (error != null) {
                fileCache.remove(hash)
            }
            SwingUtilities.invokeLater {
                val currentState = commitRowStates[hash] ?: return@invokeLater
                currentState.fileContainer.removeAll()

                val result = files ?: emptyList()
                if (result.isEmpty()) {
                    currentState.fileContainer.add(JLabel(if (error != null) "(failed to load)" else "(no files)").apply {
                        foreground = Color.GRAY
                        border = JBUI.Borders.empty(2, 28)
                        alignmentX = Component.LEFT_ALIGNMENT
                    })
                } else {
                    for (file in result) {
                        currentState.fileContainer.add(createFileRow(hash, file))
                    }
                }
                currentState.filesLoaded = error == null
                currentState.fileContainer.revalidate()
                currentState.fileContainer.repaint()
            }
        }
    }

    /**
     * Creates a file row (indented under its commit):
     *   [file-icon] filename  relativePath  [M]
     *
     * Layout: BorderLayout
     *   CENTER = icon + filename + path (GridBagLayout, path fills remaining space)
     *   EAST   = status badge (FlowLayout.RIGHT)
     */
    private fun createFileRow(commitHash: String, file: CommitFileInfo): JPanel {
        val fileName = File(file.relativePath).name
        val fileIcon = FileTypeManager.getInstance().getFileTypeByFileName(fileName).icon

        val iconLabel = JLabel(fileIcon).apply {
            border = JBUI.Borders.emptyRight(4)
        }

        val nameLabel = JLabel(fileName).apply {
            foreground = statusColor(file.statusCode)
        }

        val pathLabel = JLabel(file.relativePath).apply {
            foreground = Color.GRAY
            minimumSize = Dimension(0, preferredSize.height)
        }

        // Left side: icon + filename + path
        val leftPanel = JPanel(GridBagLayout()).apply {
            isOpaque = false
            val gbc = GridBagConstraints().apply {
                gridy = 0
                anchor = GridBagConstraints.WEST
                fill = GridBagConstraints.NONE
                weighty = 1.0
            }

            gbc.gridx = 0; gbc.weightx = 0.0; gbc.insets = JBUI.insetsRight(4)
            add(iconLabel, gbc)

            gbc.gridx = 1; gbc.insets = JBUI.emptyInsets()
            add(nameLabel, gbc)

            gbc.gridx = 2; gbc.weightx = 1.0; gbc.fill = GridBagConstraints.HORIZONTAL
            gbc.insets = JBUI.insetsLeft(6)
            add(pathLabel, gbc)
        }

        // Right side: status badge
        val statusLabel = JLabel(file.statusCode).apply {
            foreground = statusColor(file.statusCode)
            border = JBUI.Borders.emptyRight(4)
        }
        val rightPanel = JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply {
            isOpaque = false
            add(statusLabel)
        }

        val row = JPanel(BorderLayout()).apply {
            isOpaque = false
            // Indent file rows under their parent commit
            border = JBUI.Borders.empty(1, 24, 1, 4)
            alignmentX = Component.LEFT_ALIGNMENT
            add(leftPanel, BorderLayout.CENTER)
            add(rightPanel, BorderLayout.EAST)
            toolTipText = file.relativePath
        }

        // Click opens diff
        val diffClickListener = object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 1) openCommitFileDiff(commitHash, file)
            }
        }
        for (child in listOf(iconLabel, nameLabel, pathLabel, statusLabel, row)) {
            child.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            child.addMouseListener(diffClickListener)
        }

        row.maximumSize = Dimension(Int.MAX_VALUE, row.preferredSize.height)
        return row
    }

    // ─── Actions ──────────────────────────────────────────────────────────────

    /**
     * Opens IntelliJ's built-in diff viewer comparing the file before and after
     * the given commit (parent..commit), like VS Code's inline change view.
     * - Added files (A): empty -> commit content
     * - Deleted files (D): parent content -> empty
     * - Modified/Renamed files: parent content -> commit content
     */
    private fun openCommitFileDiff(commitHash: String, file: CommitFileInfo) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val gitOps = service.getGitOps() ?: return@executeOnPooledThread

            // Content before the commit (from parent)
            val beforePath = file.oldPath ?: file.relativePath
            val beforeContent = when (file.statusCode) {
                "A" -> ""
                else -> gitOps.exec("show", "$commitHash~1:$beforePath") ?: ""
            }

            // Content after the commit
            val afterContent = when (file.statusCode) {
                "D" -> ""
                else -> gitOps.exec("show", "$commitHash:${file.relativePath}") ?: ""
            }

            val fileName = File(file.relativePath).name
            val fileType = FileTypeManager.getInstance().getFileTypeByFileName(fileName)
            val shortHash = commitHash.take(8)

            SwingUtilities.invokeLater {
                val contentFactory = DiffContentFactory.getInstance()
                val leftContent = contentFactory.create(project, beforeContent, fileType)
                val rightContent = contentFactory.create(project, afterContent, fileType)

                val request = SimpleDiffRequest(
                    "${file.relativePath} ($shortHash)",
                    leftContent,
                    rightContent,
                    "$shortHash~1",
                    shortHash,
                )
                DiffManager.getInstance().showDiff(project, request)
            }
        }
    }

    private fun viewSummary(commitHash: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val summary = service.getSummary(commitHash)
            SwingUtilities.invokeLater {
                if (summary != null) {
                    val vFile = SummaryVirtualFile(summary)
                    com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(vFile, true)
                } else {
                    JOptionPane.showMessageDialog(
                        this, "No summary found for ${commitHash.take(8)}",
                        "Commit Memory", JOptionPane.INFORMATION_MESSAGE,
                    )
                }
            }
        }
    }



    // ─── Foreign mode ──────────────────────────────────────────────────────

    /** Whether the panel is currently in foreign (read-only) mode. */
    val isForeignMode: Boolean get() = foreignRepo != null

    /**
     * Switches to foreign read-only mode, showing memories from a different repo/branch.
     * Data comes from [KBDataCache] rather than git.
     */
    fun setForeignMode(repo: String, branch: String) {
        refreshVersion++
        foreignRepo = repo
        foreignBranch = branch
        foreignEntries = KBDataCache.all()
            .filter { it.repo == repo && it.branch == branch && it.type == "commit" }
            .sortedByDescending { it.date ?: "" }
        SwingUtilities.invokeLater { updateForeignList() }
    }

    /** Exits foreign mode and restores normal commit view. */
    fun clearForeignMode() {
        if (foreignRepo == null) return
        foreignRepo = null
        foreignBranch = null
        foreignEntries = emptyList()
        refresh()
    }

    private fun updateForeignList() {
        removeAll()
        listPanel.removeAll()
        commitRowStates.clear()

        if (foreignEntries.isEmpty()) {
            emptyLabel.text = "<html><center>No memories found for " +
                "${escHtml(foreignRepo ?: "")} / ${escHtml(foreignBranch ?: "")}.</center></html>"
            add(emptyLabel, BorderLayout.CENTER)
        } else {
            // Banner
            val banner = JBLabel(
                "Viewing memories from ${foreignRepo} / ${foreignBranch} (read-only)",
            ).apply {
                foreground = Color.GRAY
                border = JBUI.Borders.empty(2, 4, 6, 4)
            }
            banner.alignmentX = Component.LEFT_ALIGNMENT
            listPanel.add(banner)

            for (entry in foreignEntries) {
                listPanel.add(createForeignMemoryRow(entry))
            }
            listPanel.add(Box.createVerticalGlue())

            add(JBScrollPane(listPanel).apply {
                horizontalScrollBarPolicy = JBScrollPane.HORIZONTAL_SCROLLBAR_NEVER
            }, BorderLayout.CENTER)
        }
        revalidate(); repaint()
    }

    /**
     * Creates a read-only row for a foreign memory entry:
     *   [eye-icon] <title>         <relative date> [copy-icon]
     */
    private fun createForeignMemoryRow(entry: KBDataCache.KBEntry): JPanel {
        val iconLabel = JLabel(JolliMemoryIcons.Eye)

        val messageLabel = JLabel(entry.title ?: "(untitled)").apply {
            minimumSize = Dimension(0, preferredSize.height)
        }

        val dateLabel = JLabel(formatShortRelativeDate(entry.date ?: "")).apply {
            foreground = Color.GRAY
        }

        val copyLabel = JLabel(AllIcons.Actions.Copy).apply {
            toolTipText = "Copy recall prompt"
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    copyRecallPromptForBranch(entry.branch ?: "")
                }
            })
        }

        val leftPanel = JPanel(GridBagLayout()).apply {
            isOpaque = false
            val gbc = GridBagConstraints().apply {
                gridy = 0; anchor = GridBagConstraints.WEST
                fill = GridBagConstraints.NONE; weighty = 1.0
            }
            gbc.gridx = 0; gbc.weightx = 0.0; gbc.insets = JBUI.insetsRight(6)
            add(iconLabel, gbc)
            gbc.gridx = 1; gbc.weightx = 1.0; gbc.fill = GridBagConstraints.HORIZONTAL
            gbc.insets = JBUI.emptyInsets()
            add(messageLabel, gbc)
        }

        val rightPanel = JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply {
            isOpaque = false
            add(dateLabel)
            add(Box.createHorizontalStrut(JBUI.scale(8)))
            add(copyLabel)
        }

        val row = JPanel(BorderLayout()).apply {
            isOpaque = true
            border = JBUI.Borders.empty(4, 8)
            alignmentX = Component.LEFT_ALIGNMENT
            add(leftPanel, BorderLayout.CENTER)
            add(rightPanel, BorderLayout.EAST)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        }

        // Click opens summary (reads from KB folder)
        val clickListener = object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 1) viewForeignSummary(entry)
            }
        }
        for (child in listOf(iconLabel, messageLabel, dateLabel, leftPanel, row)) {
            child.addMouseListener(clickListener)
        }

        row.maximumSize = Dimension(Int.MAX_VALUE, row.preferredSize.height)
        return row
    }

    /** Opens a foreign memory's summary by reading from the KB folder JSON. */
    private fun viewForeignSummary(entry: KBDataCache.KBEntry) {
        ApplicationManager.getApplication().executeOnPooledThread {
            // Try to extract commit hash from the file path (format: <slug>-<hash8>.md or summaries/<hash>.json)
            val jsonPath = entry.kbRoot.resolve(".jolli").resolve("summaries")
            val fileName = entry.fullPath.fileName.toString()
            // Hash is the last 8 chars before .md extension
            val hash8 = fileName.removeSuffix(".md").takeLast(8)
            // Look for a matching JSON file in summaries/
            val matchingJson = try {
                java.nio.file.Files.list(jsonPath).use { stream ->
                    stream.filter { it.fileName.toString().startsWith(hash8) || it.fileName.toString().contains(hash8) }
                        .findFirst().orElse(null)
                }
            } catch (_: Exception) { null }

            if (matchingJson != null) {
                try {
                    val json = java.nio.file.Files.readString(matchingJson, java.nio.charset.StandardCharsets.UTF_8)
                    val summary = Gson().fromJson(json, CommitSummary::class.java)
                    SwingUtilities.invokeLater {
                        if (summary != null) {
                            val vFile = SummaryVirtualFile(summary, readOnly = true)
                            com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(vFile, true)
                        }
                    }
                } catch (e: Exception) {
                    LOG.warn("Failed to read foreign summary from $matchingJson", e)
                }
            }
        }
    }

    // ─── Copy recall prompt ──────────────────────────────────────────────────

    /**
     * Copies the recall prompt to clipboard for a commit hash.
     * Fetches the full summary to get the branch name.
     */
    fun copyRecallPrompt(commitHash: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val summary = service.getSummary(commitHash)
            SwingUtilities.invokeLater {
                if (summary == null) {
                    JOptionPane.showMessageDialog(
                        this, "No summary found for this commit.",
                        "Copy Recall Prompt", JOptionPane.WARNING_MESSAGE,
                    )
                    return@invokeLater
                }
                copyRecallPromptForBranch(summary.branch)
            }
        }
    }

    /** Copies the recall prompt for a given branch name. */
    private fun copyRecallPromptForBranch(branch: String) {
        val prompt = "Invoke the \"jolli-recall\" skill with args \"$branch\"."
        val clipboard = Toolkit.getDefaultToolkit().systemClipboard
        clipboard.setContents(StringSelection(prompt), null)
        com.intellij.openapi.ui.Messages.showInfoMessage(
            project,
            "Recall prompt copied \u2014 paste it into Claude Code.",
            "Copy Recall Prompt",
        )
    }

    private fun formatShortRelativeDate(isoDate: String): String {
        return try {
            val then = Instant.parse(isoDate)
            val now = Instant.now()
            val duration = Duration.between(then, now)
            val minutes = duration.toMinutes()
            val hours = duration.toHours()
            val days = duration.toDays()
            when {
                minutes < 1 -> "now"
                minutes < 60 -> "${minutes}m ago"
                hours < 24 -> "${hours}h ago"
                days < 30 -> "${days}d ago"
                days < 365 -> "${days / 30}mo ago"
                else -> "${days / 365}y ago"
            }
        } catch (_: Exception) {
            isoDate.take(10)
        }
    }

    private fun escHtml(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    override fun dispose() {
        dismissHoverPopup()
        service.removeStatusListener(statusListener)
        gitChangeDebounceTimer?.stop()
        messageBusConnection.disconnect()
    }

    // ─── State and utility ────────────────────────────────────────────────────

    /** Tracks per-commit row UI state for expand/collapse and checkbox management. */
    private data class CommitRowState(
        val row: JPanel,
        val fileContainer: JPanel,
        val arrowLabel: JLabel,
        val checkbox: JCheckBox?,
        var isExpanded: Boolean,
        var filesLoaded: Boolean,
    )

    // ─── Sticky hover popup (VS Code hover-card pattern, native Swing) ────

    private fun scheduleShowHoverPopup(row: JPanel, commit: CommitSummaryBrief) {
        hoverDismissTimer.stop()
        if (hoverRow == row && hoverPopup?.isVisible == true) return
        hoverShowTimer?.stop()
        hoverShowTimer = Timer(HOVER_SHOW_DELAY_MS) { showHoverPopup(row, commit) }.apply {
            isRepeats = false
            start()
        }
    }

    private fun showHoverPopup(row: JPanel, c: CommitSummaryBrief) {
        hoverShowTimer?.stop()
        dismissHoverPopup()

        val window = SwingUtilities.getWindowAncestor(row) ?: return
        val popup = JWindow(window)

        val bg = UIManager.getColor("ToolTip.background") ?: background
        val fg = UIManager.getColor("ToolTip.foreground") ?: foreground
        val dimFg = UIManager.getColor("Component.infoForeground") ?: Color.GRAY
        val borderColor = UIManager.getColor("ToolTip.borderColor") ?: Color.GRAY

        val relDate = formatRelativeDate(c.date)
        val msg = c.message.ifBlank { c.shortHash }

        val content = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            background = bg
            border = JBUI.Borders.empty(8, 10)

            // Title (bold)
            add(JBLabel(msg).apply {
                foreground = fg
                font = font.deriveFont(java.awt.Font.BOLD)
                alignmentX = Component.LEFT_ALIGNMENT
            })
            add(Box.createVerticalStrut(JBUI.scale(4)))

            // Clock + relative date
            add(JBLabel(relDate, AllIcons.Vcs.History, SwingConstants.LEFT).apply {
                foreground = fg
                iconTextGap = JBUI.scale(6)
                alignmentX = Component.LEFT_ALIGNMENT
            })

            // Commit type badge
            if (c.commitType != null) {
                add(Box.createVerticalStrut(JBUI.scale(2)))
                add(JBLabel(c.commitType, AllIcons.Nodes.Tag, SwingConstants.LEFT).apply {
                    foreground = fg
                    iconTextGap = JBUI.scale(6)
                    alignmentX = Component.LEFT_ALIGNMENT
                })
            }

            // Separator + stats
            add(Box.createVerticalStrut(JBUI.scale(4)))
            add(JSeparator().apply { alignmentX = Component.LEFT_ALIGNMENT; maximumSize = Dimension(Int.MAX_VALUE, 1) })
            add(Box.createVerticalStrut(JBUI.scale(4)))

            val stats = mutableListOf("${c.filesChanged} file${if (c.filesChanged != 1) "s" else ""} changed")
            if (c.insertions > 0) stats.add("${c.insertions} insertion${if (c.insertions != 1) "s" else ""}(+)")
            if (c.deletions > 0) stats.add("${c.deletions} deletion${if (c.deletions != 1) "s" else ""}(-)")
            add(JBLabel(stats.joinToString(", ")).apply {
                foreground = dimFg
                font = font.deriveFont(font.size2D - 1f)
                alignmentX = Component.LEFT_ALIGNMENT
            })

            // Separator + hash / View Memory
            add(Box.createVerticalStrut(JBUI.scale(4)))
            add(JSeparator().apply { alignmentX = Component.LEFT_ALIGNMENT; maximumSize = Dimension(Int.MAX_VALUE, 1) })
            add(Box.createVerticalStrut(JBUI.scale(4)))

            add(JBLabel(c.shortHash, AllIcons.Vcs.CommitNode, SwingConstants.LEFT).apply {
                foreground = fg
                iconTextGap = JBUI.scale(6)
                font = java.awt.Font(java.awt.Font.MONOSPACED, java.awt.Font.PLAIN, font.size)
                alignmentX = Component.LEFT_ALIGNMENT
            })

            if (c.hasSummary) {
                add(Box.createVerticalStrut(JBUI.scale(4)))
                val linkColor = JBUI.CurrentTheme.Link.Foreground.ENABLED
                add(JBLabel("View Memory").apply {
                    foreground = linkColor
                    cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                    alignmentX = Component.LEFT_ALIGNMENT
                    addMouseListener(object : MouseAdapter() {
                        override fun mouseClicked(e: MouseEvent) {
                            dismissHoverPopup()
                            viewSummary(c.hash)
                        }
                        override fun mouseEntered(e: MouseEvent) { hoverDismissTimer.stop() }
                        override fun mouseExited(e: MouseEvent) { scheduleHoverDismiss() }
                    })
                })
            }
        }

        popup.contentPane = JPanel(BorderLayout()).apply {
            background = bg
            border = javax.swing.BorderFactory.createLineBorder(borderColor)
            add(content, BorderLayout.CENTER)
        }
        popup.pack()

        val rowLoc = row.locationOnScreen
        popup.setLocation(rowLoc.x, rowLoc.y + row.height + 2)

        val popupHoverListener = object : MouseAdapter() {
            override fun mouseEntered(e: MouseEvent) { hoverDismissTimer.stop() }
            override fun mouseExited(e: MouseEvent) { scheduleHoverDismiss() }
        }
        popup.addMouseListener(popupHoverListener)
        content.addMouseListener(popupHoverListener)

        hoverPopup = popup
        hoverRow = row
        popup.isVisible = true
    }

    private fun scheduleHoverDismiss() {
        hoverShowTimer?.stop()
        hoverDismissTimer.restart()
    }

    private fun dismissHoverPopup() {
        hoverShowTimer?.stop()
        hoverDismissTimer.stop()
        hoverPopup?.dispose()
        hoverPopup = null
        hoverRow = null
    }

    private fun statusColor(code: String): Color {
        return when (code) {
            "M" -> Color(0xC08020)   // Yellow — modified
            "A" -> Color(0x20A040)   // Green — added
            "D" -> Color(0xC02020)   // Red — deleted
            "R" -> Color(0x6A9FD6)   // Blue — renamed
            else -> Color.GRAY
        }
    }

    private fun formatRelativeDate(isoDate: String): String {
        return try {
            val then = Instant.parse(isoDate)
            val now = Instant.now()
            val duration = Duration.between(then, now)
            val minutes = duration.toMinutes()
            val hours = duration.toHours()
            val days = duration.toDays()
            when {
                minutes < 1 -> "just now"
                minutes < 60 -> "$minutes minute${if (minutes != 1L) "s" else ""} ago"
                hours < 24 -> "$hours hour${if (hours != 1L) "s" else ""} ago"
                days < 30 -> "$days day${if (days != 1L) "s" else ""} ago"
                days < 365 -> "${days / 30} month${if (days / 30 != 1L) "s" else ""} ago"
                else -> "${days / 365} year${if (days / 365 != 1L) "s" else ""} ago"
            }
        } catch (_: Exception) {
            isoDate.take(10)
        }
    }

}

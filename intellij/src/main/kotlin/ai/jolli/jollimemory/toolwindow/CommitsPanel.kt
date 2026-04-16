package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.bridge.CommitSummaryBrief
import ai.jolli.jollimemory.services.CommitFileInfo
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.openapi.Disposable
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
    /** Cache of files per commit hash — avoids re-running git for expanded commits. */
    private val fileCache = mutableMapOf<String, List<CommitFileInfo>>()
    /** Per-commit UI state for expand/collapse and checkbox management. */
    private val commitRowStates = mutableMapOf<String, CommitRowState>()
    /** True when the branch is fully merged into main (read-only history view). */
    private var isMerged = false
    private val statusListener: () -> Unit = { SwingUtilities.invokeLater { refresh() } }
    private val messageBusConnection: MessageBusConnection = project.messageBus.connect()
    private var gitChangeDebounceTimer: Timer? = null

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
        refreshVersion++
        ApplicationManager.getApplication().executeOnPooledThread { refreshFromGit() }
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
            SwingUtilities.invokeLater { if (refreshVersion == myVersion) showDisabled() }
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
        emptyLabel.text = "<html><center>Initializing JolliMemory...</center></html>"
        add(emptyLabel, BorderLayout.CENTER)
        revalidate(); repaint()
    }

    private fun showDisabled() {
        removeAll()
        emptyLabel.text = "Jolli Memory is disabled."
        add(emptyLabel, BorderLayout.CENTER)
        revalidate(); repaint()
    }

    private fun updateCommitList() {
        removeAll()
        listPanel.removeAll()
        commitRowStates.clear()

        if (commits.isEmpty()) {
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

        // Right side: eye icon
        val rightPanel = JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply {
            isOpaque = false
            add(eyeLabel)
        }

        val row = JPanel(BorderLayout(2, 0)).apply {
            isOpaque = true
            border = JBUI.Borders.empty(2, 4)
            alignmentX = Component.LEFT_ALIGNMENT
            add(leftPanel, BorderLayout.WEST)
            add(messageLabel, BorderLayout.CENTER)
            add(rightPanel, BorderLayout.EAST)
            toolTipText = buildTooltipHtml(commit)
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

        // Click anywhere on the commit row (except checkbox/eye) toggles expand/collapse
        val expandClickListener = object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 2 && commit.hasSummary) {
                    viewSummary(commit.hash)
                } else if (e.clickCount == 1) {
                    toggleExpand(commit.hash)
                }
            }
        }
        for (child in listOf(arrowLabel, messageLabel, leftPanel, row)) {
            child.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            child.addMouseListener(expandClickListener)
        }

        row.maximumSize = Dimension(Int.MAX_VALUE, row.preferredSize.height)
        return state
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

    /** Lazily loads commit files on first expansion. */
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

        ApplicationManager.getApplication().executeOnPooledThread {
            val files = fileCache.getOrPut(hash) { service.listCommitFiles(hash) }
            SwingUtilities.invokeLater {
                val currentState = commitRowStates[hash] ?: return@invokeLater
                currentState.fileContainer.removeAll()

                if (files.isEmpty()) {
                    currentState.fileContainer.add(JLabel("(no files)").apply {
                        foreground = Color.GRAY
                        border = JBUI.Borders.empty(2, 28)
                        alignmentX = Component.LEFT_ALIGNMENT
                    })
                } else {
                    for (file in files) {
                        currentState.fileContainer.add(createFileRow(hash, file))
                    }
                }
                currentState.filesLoaded = true
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

    override fun dispose() {
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

    /** Builds HTML tooltip matching VS Code's MarkdownString tooltip layout. */
    private fun buildTooltipHtml(c: CommitSummaryBrief): String {
        val relDate = formatRelativeDate(c.date)
        val sb = StringBuilder("<html>")

        // Row 1: author + relative date
        sb.append("<b>${esc(c.author)}</b> &nbsp; \uD83D\uDD52 $relDate<br/>")

        // Commit type badge
        if (c.commitType != null) {
            sb.append("\uD83C\uDFF7\uFE0F ${esc(c.commitType)}<br/>")
        }

        // Row 2: message
        val tooltipMessage = c.message.ifBlank { c.shortHash }
        sb.append("<br/>${esc(tooltipMessage)}<br/>")

        // Stats
        sb.append("<hr/>")
        val stats = mutableListOf("${c.filesChanged} file${if (c.filesChanged != 1) "s" else ""} changed")
        if (c.insertions > 0) stats.add("${c.insertions} insertion${if (c.insertions != 1) "s" else ""}(+)")
        if (c.deletions > 0) stats.add("${c.deletions} deletion${if (c.deletions != 1) "s" else ""}(-)")
        sb.append("${stats.joinToString(", ")}<br/>")

        // Hash
        sb.append("<hr/>")
        sb.append("<code>${c.shortHash}</code>")
        if (c.hasSummary) sb.append(" &nbsp;|&nbsp; \uD83D\uDC41 View Commit Memory")

        sb.append("</html>")
        return sb.toString()
    }

    private fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

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

    companion object {
        private const val ARROW_RIGHT = "\u25B6" // ▶
        private const val ARROW_DOWN = "\u25BC"  // ▼
    }
}

package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.services.FileChange
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
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
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.io.File
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.actionSystem.Presentation
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JCheckBox
import javax.swing.JLabel
import javax.swing.JMenuItem
import javax.swing.JPanel
import javax.swing.JPopupMenu
import javax.swing.SwingUtilities
import javax.swing.Timer

/**
 * Changes panel — shows git working tree changes with checkboxes.
 * Matches VS Code Source Control panel layout:
 *   - [checkbox] [icon] filename parentDir/  M  [discard on hover]
 *   - git status --porcelain=v1
 *   - Auto-refreshes on file system changes (VFS listener)
 *   - Checkboxes for selecting files to commit
 *   - Color-coded status letters matching VS Code (M=yellow, A=green, U=green, D=red, R=blue)
 *   - Untracked files (?? in porcelain) display as "U" to match VS Code convention
 *   - Discard icon appears on hover to revert individual file changes
 */
class ChangesPanel(
    private val project: Project,
    private val service: JolliMemoryService,
) : JPanel(BorderLayout()), Disposable {

    private val emptyLabel = JBLabel("No changes detected.", javax.swing.SwingConstants.CENTER)
    private val checkboxes = mutableListOf<JCheckBox>()
    private val fileListPanel = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
    }
    private var changes: List<FileChange> = emptyList()
    private var commitBtn: JButton? = null
    private var debounceTimer: Timer? = null
    private var gitChangeDebounceTimer: Timer? = null
    /** Project-level bus for GIT_REPO_CHANGE events. */
    private val projectBusConnection: MessageBusConnection = project.messageBus.connect()
    /** Application-level bus for VFS_CHANGES (application-level topic). */
    private val appBusConnection: MessageBusConnection = ApplicationManager.getApplication().messageBus.connect()
    private val statusListener: () -> Unit = { SwingUtilities.invokeLater { refresh() } }

    /** Version counter to prevent stale renders from racing background threads. */
    @Volatile
    private var refreshVersion = 0L

    /** Tracks which row panel is currently hovered (for showing discard icon). */
    private var hoveredRow: JPanel? = null

    init {
        border = JBUI.Borders.empty(8)

        // Listen for status changes (enable/disable)
        service.addStatusListener(statusListener)

        // Auto-refresh on file system changes (like VS Code's file watcher).
        // VFS_CHANGES is an application-level topic — must use application bus.
        appBusConnection.subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
            override fun after(events: List<VFileEvent>) {
                val hasRelevantChange = events.any { e ->
                    val path = e.path ?: ""
                    !path.contains("/.git/") && !path.contains("\\.git\\")
                }
                if (hasRelevantChange) scheduleDebouncedRefresh()
            }
        })

        // Subscribe to git repository changes (commits, branch switches, index updates).
        // The VFS listener above only catches workspace file changes and explicitly
        // excludes .git/ paths, so IntelliJ UI commits (which move files from staged
        // to committed without touching workspace files) are missed. This listener
        // reliably fires after IntelliJ's own commit dialog completes.
        // Uses a separate 500ms debounce to allow the git index to fully settle.
        projectBusConnection.subscribe(
            GitRepository.GIT_REPO_CHANGE,
            GitRepositoryChangeListener { scheduleGitChangeRefresh() },
        )
        projectBusConnection.subscribe(
            com.intellij.openapi.vcs.ProjectLevelVcsManager.VCS_CONFIGURATION_CHANGED,
            com.intellij.openapi.vcs.VcsListener { scheduleGitChangeRefresh() },
        )

        // Initial load
        ApplicationManager.getApplication().executeOnPooledThread { refreshFromGit() }
    }

    private fun scheduleDebouncedRefresh() {
        debounceTimer?.stop()
        debounceTimer = Timer(300) { refresh() }.apply {
            isRepeats = false
            start()
        }
    }

    /**
     * Debounced refresh for git repository changes (commits, branch switches).
     * Uses a longer delay (500ms) than VFS debounce to ensure the git index
     * is fully updated after IntelliJ's commit operation completes.
     */
    private fun scheduleGitChangeRefresh() {
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

    private fun refreshFromGit() {
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
            changes = service.getChangedFiles()
        } catch (_: Exception) {
            changes = emptyList()
        }
        SwingUtilities.invokeLater { if (refreshVersion == myVersion) updateFileList() }
    }

    private fun showInitializing() {
        removeAll()
        emptyLabel.text = "<html><center>Initializing Jolli Memory...</center></html>"
        add(emptyLabel, BorderLayout.CENTER)
        revalidate(); repaint()
    }

    private fun updateFileList() {
        removeAll()
        checkboxes.clear()
        fileListPanel.removeAll()
        hoveredRow = null

        if (changes.isEmpty()) {
            emptyLabel.text = "Working tree clean — no changes."
            add(emptyLabel, BorderLayout.CENTER)
        } else {
            for (change in changes) {
                val row = createFileRow(change)
                fileListPanel.add(row)
            }
            // Push file rows to the top when the list is shorter than the viewport
            fileListPanel.add(Box.createVerticalGlue())

            add(JBScrollPane(fileListPanel).apply {
                horizontalScrollBarPolicy = JBScrollPane.HORIZONTAL_SCROLLBAR_NEVER
            }, BorderLayout.CENTER)

            // AI Commit button at the bottom (matches VS Code "Commit Memory" button)
            commitBtn = JButton("Commit Memory", JolliMemoryIcons.Sparkle).apply {
                toolTipText = "Generate AI commit message and commit selected files"
                cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                isEnabled = checkboxes.any { it.isSelected }
                foreground = Color.WHITE
                isOpaque = false
                isFocusPainted = false
                isContentAreaFilled = false
                isBorderPainted = false
                border = JBUI.Borders.empty(6, 14)
                ui = object : javax.swing.plaf.basic.BasicButtonUI() {
                    override fun paint(g: java.awt.Graphics, c: javax.swing.JComponent) {
                        val g2 = g.create() as java.awt.Graphics2D
                        g2.setRenderingHint(java.awt.RenderingHints.KEY_ANTIALIASING, java.awt.RenderingHints.VALUE_ANTIALIAS_ON)
                        val btn = c as JButton
                        g2.color = if (btn.isEnabled) Color(0x0078D4) else Color(0x0078D4).darker().darker()
                        g2.fillRoundRect(0, 0, c.width, c.height, 8, 8)
                        g2.dispose()
                        btn.foreground = Color.WHITE
                        super.paint(g, c)
                    }
                }
                addActionListener {
                    val action = ActionManager.getInstance().getAction("JolliMemory.CommitAI") ?: return@addActionListener
                    ActionManager.getInstance().tryToExecute(action, null, this, "JolliMemoryChangesPanel", true)
                }
            }
            val btnPanel = JPanel(FlowLayout(FlowLayout.RIGHT, 4, 4))
            btnPanel.add(commitBtn)
            add(btnPanel, BorderLayout.SOUTH)
        }

        revalidate(); repaint()
    }

    fun getSelectedFiles(): List<FileChange> {
        return changes.filterIndexed { i, _ -> checkboxes.getOrNull(i)?.isSelected ?: false }
    }

    /** Returns all files in the changes list (selected and unselected). */
    fun getFiles(): List<FileChange> = changes.toList()

    /** Toggles all checkboxes — if any are unchecked, select all; otherwise deselect all. */
    fun toggleSelectAll() {
        val anyUnchecked = checkboxes.any { !it.isSelected }
        checkboxes.forEach { it.isSelected = anyUnchecked }
        commitBtn?.isEnabled = checkboxes.any { it.isSelected }
        repaint()
    }

    /** Discards changes for all selected files after confirmation. */
    fun discardSelected() {
        val selected = getSelectedFiles()
        if (selected.isEmpty()) return

        val willDelete = selected.filter { it.statusCode in listOf("??", "A", "AM", "AD") }
        val fileList = selected.take(10).joinToString("\n") { "  • ${it.relativePath}" }
        val overflow = if (selected.size > 10) "\n  ...and ${selected.size - 10} more" else ""
        val deleteWarning = if (willDelete.isNotEmpty()) {
            "\n\n⚠ ${willDelete.size} file(s) will be permanently deleted (untracked/added)."
        } else ""

        val result = Messages.showYesNoDialog(
            project,
            "Discard changes to ${selected.size} file(s)?\n\n$fileList$overflow$deleteWarning\n\nThis action cannot be undone.",
            "Discard Selected Changes",
            "Discard All",
            "Cancel",
            Messages.getWarningIcon(),
        )
        if (result != Messages.YES) return

        ApplicationManager.getApplication().executeOnPooledThread {
            val gitOps = service.getGitOps() ?: return@executeOnPooledThread
            val repoRoot = service.mainRepoRoot ?: project.basePath ?: return@executeOnPooledThread
            discardFiles(selected, gitOps, repoRoot)
            refreshFromGit()
        }
    }

    /** Performs the git operations to discard a list of file changes. */
    private fun discardFiles(files: List<FileChange>, gitOps: ai.jolli.jollimemory.bridge.GitOps, repoRoot: String) {
        for (change in files) {
            when (change.statusCode) {
                "??" -> {
                    try {
                        val f = File(repoRoot, change.relativePath)
                        if (f.isDirectory) f.deleteRecursively() else f.delete()
                    } catch (_: Exception) { }
                }
                "A", "AM", "AD" -> {
                    gitOps.exec("reset", "HEAD", "--", change.relativePath)
                    try { File(repoRoot, change.relativePath).delete() } catch (_: Exception) { }
                }
                else -> {
                    gitOps.exec("checkout", "HEAD", "--", change.relativePath)
                }
            }
        }
    }

    /**
     * Creates a VS Code-style file row:
     *   [checkbox] [icon] filename parentDir/   M  [⤺ discard on hover]
     *
     * Layout: BorderLayout
     *   CENTER = checkbox + icon + filename + parentDir (FlowLayout, left-aligned, fills space)
     *   EAST   = statusBadge + discardButton (FlowLayout, right-aligned)
     *
     * The discard button is only visible when the mouse hovers over this row.
     */
    private fun createFileRow(change: FileChange): JPanel {
        val cb = JCheckBox("", change.isSelected).apply {
            isOpaque = false
            border = JBUI.Borders.empty()
            addActionListener { commitBtn?.isEnabled = checkboxes.any { cb -> cb.isSelected } }
        }
        checkboxes.add(cb)

        val fileName = File(change.relativePath).name
        val fileIcon = FileTypeManager.getInstance().getFileTypeByFileName(fileName).icon

        val iconLabel = JLabel(fileIcon).apply {
            border = JBUI.Borders.emptyRight(4)
        }

        val displayStatus = displayStatusCode(change.statusCode)

        val nameLabel = JLabel(fileName).apply {
            foreground = statusColor(change.statusCode)
        }

        // Parent directory (gray, smaller font — follows directly after filename)
        val parentDir = File(change.relativePath).parent?.let { "$it/" } ?: ""
        val pathLabel = JLabel(parentDir).apply {
            foreground = Color.GRAY
            font = font.deriveFont(font.size2D - 1f)
            // Allow the label to shrink so it truncates instead of forcing wider rows
            minimumSize = Dimension(0, preferredSize.height)
        }

        // Left side: GridBagLayout ensures checkbox + icon + filename get their preferred
        // widths and the path label fills remaining space without clipping.
        val leftPanel = JPanel(java.awt.GridBagLayout()).apply {
            isOpaque = false
            val gbc = java.awt.GridBagConstraints()
            gbc.gridy = 0
            gbc.anchor = java.awt.GridBagConstraints.WEST
            gbc.fill = java.awt.GridBagConstraints.NONE
            gbc.weightx = 0.0

            gbc.gridx = 0
            add(cb, gbc)

            gbc.gridx = 1
            add(iconLabel, gbc)

            gbc.gridx = 2
            add(nameLabel, gbc)

            gbc.gridx = 3
            gbc.weightx = 1.0
            gbc.fill = java.awt.GridBagConstraints.HORIZONTAL
            gbc.insets = JBUI.insetsLeft(4)
            add(pathLabel, gbc)
        }

        // Status badge (colored letter matching VS Code: M, A, D, U, R)
        val statusLabel = JLabel(displayStatus).apply {
            foreground = statusColor(change.statusCode)
            border = JBUI.Borders.emptyRight(4)
            toolTipText = statusTooltip(change.statusCode)
        }

        // Discard button — hidden by default, shown on hover
        val discardLabel = JLabel(JolliMemoryIcons.Discard).apply {
            isVisible = false
            toolTipText = "Discard Changes"
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            border = JBUI.Borders.emptyLeft(2)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    if (SwingUtilities.isLeftMouseButton(e)) {
                        discardFile(change)
                    }
                }
            })
        }

        // Right side: status badge + discard icon
        val rightPanel = JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply {
            isOpaque = false
            add(statusLabel)
            add(discardLabel)
        }

        val row = JPanel(BorderLayout()).apply {
            isOpaque = false
            border = JBUI.Borders.empty(2, 4)
            alignmentX = Component.LEFT_ALIGNMENT
            add(leftPanel, BorderLayout.CENTER)
            add(rightPanel, BorderLayout.EAST)
        }

        // Show/hide discard icon on hover
        val hoverListener = object : MouseAdapter() {
            override fun mouseEntered(e: MouseEvent) {
                hoveredRow = row
                discardLabel.isVisible = true
                row.repaint()
            }
            override fun mouseExited(e: MouseEvent) {
                // Only hide if the mouse truly left the row (not just entering a child)
                val point = SwingUtilities.convertPoint(e.component, e.point, row)
                if (!row.contains(point)) {
                    hoveredRow = null
                    discardLabel.isVisible = false
                    row.repaint()
                }
            }
        }

        // Click anywhere on the row (except checkbox/discard) opens a diff
        val diffClickListener = object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 1 && SwingUtilities.isLeftMouseButton(e)) {
                    openFileDiff(change)
                }
            }
        }
        for (child in listOf(iconLabel, nameLabel, pathLabel, statusLabel)) {
            child.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            child.addMouseListener(diffClickListener)
        }

        // Right-click context menu
        val contextMenuListener = object : MouseAdapter() {
            override fun mousePressed(e: MouseEvent) { maybeShowPopup(e) }
            override fun mouseReleased(e: MouseEvent) { maybeShowPopup(e) }
            private fun maybeShowPopup(e: MouseEvent) {
                if (!e.isPopupTrigger) return
                val menu = JPopupMenu()
                menu.add(JMenuItem("Discard Changes").apply {
                    addActionListener { discardFile(change) }
                })
                menu.show(e.component, e.x, e.y)
            }
        }

        // Attach hover listener to the row and all child components
        row.addMouseListener(hoverListener)
        row.addMouseListener(contextMenuListener)
        for (child in listOf(leftPanel, rightPanel, cb, iconLabel, nameLabel, pathLabel, statusLabel, discardLabel)) {
            child.addMouseListener(hoverListener)
            child.addMouseListener(contextMenuListener)
        }

        // Constrain row height so BoxLayout doesn't stretch rows apart
        row.maximumSize = Dimension(Int.MAX_VALUE, row.preferredSize.height)
        return row
    }

    /**
     * Discards changes for a single file after confirmation.
     * - Modified (M) / Deleted (D): git checkout -- <file>
     * - Untracked (??): deletes the file
     * - Added (A): git reset HEAD <file>, then deletes the file
     */
    private fun discardFile(change: FileChange) {
        val action = when (change.statusCode) {
            "??" -> "delete"
            else -> "discard changes to"
        }
        val result = Messages.showYesNoDialog(
            project,
            "Are you sure you want to $action \"${change.relativePath}\"?\n\nThis action cannot be undone.",
            "Discard Changes",
            Messages.getWarningIcon(),
        )
        if (result != Messages.YES) return

        ApplicationManager.getApplication().executeOnPooledThread {
            val gitOps = service.getGitOps() ?: return@executeOnPooledThread
            val repoRoot = service.mainRepoRoot ?: project.basePath ?: return@executeOnPooledThread
            discardFiles(listOf(change), gitOps, repoRoot)
            refreshFromGit()
        }
    }

    /**
     * Opens a diff or file view based on status, matching VS Code's jollimemory.openFileChange:
     * - Modified/Renamed (M, R): diff HEAD ↔ Working Tree
     * - Added/Untracked (A, ??): open file directly (no HEAD version to compare)
     * - Deleted (D): show HEAD version read-only (file no longer exists on disk)
     */
    private fun openFileDiff(change: FileChange) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val repoRoot = service.mainRepoRoot ?: project.basePath ?: return@executeOnPooledThread

            when (change.statusCode) {
                "A", "??" -> {
                    // New/untracked — open the file directly (no HEAD version to diff against)
                    val vFile = LocalFileSystem.getInstance()
                        .refreshAndFindFileByIoFile(File(repoRoot, change.relativePath))
                    if (vFile != null) {
                        SwingUtilities.invokeLater {
                            com.intellij.openapi.fileEditor.FileEditorManager
                                .getInstance(project).openFile(vFile, true)
                        }
                    }
                }
                "D" -> {
                    // Deleted — show HEAD version read-only
                    val gitOps = service.getGitOps() ?: return@executeOnPooledThread
                    val headContent = gitOps.exec("show", "HEAD:${change.relativePath}") ?: ""
                    val fileName = File(change.relativePath).name
                    val fileType = FileTypeManager.getInstance().getFileTypeByFileName(fileName)

                    SwingUtilities.invokeLater {
                        val contentFactory = DiffContentFactory.getInstance()
                        val left = contentFactory.create(project, headContent, fileType)
                        val right = contentFactory.create(project, "", fileType)

                        val request = SimpleDiffRequest(
                            "${change.relativePath} (Deleted)",
                            left,
                            right,
                            "HEAD",
                            "Deleted",
                        )
                        DiffManager.getInstance().showDiff(project, request)
                    }
                }
                else -> {
                    // Modified/Renamed — diff HEAD ↔ Working Tree
                    val gitOps = service.getGitOps() ?: return@executeOnPooledThread
                    val headContent = gitOps.exec("show", "HEAD:${change.relativePath}") ?: ""
                    val fileName = File(change.relativePath).name
                    val fileType = FileTypeManager.getInstance().getFileTypeByFileName(fileName)
                    // Use VFS-backed content for working tree side so the diff viewer
                    // uses IntelliJ's document model (encoding, line separators, unsaved edits)
                    val vFile = LocalFileSystem.getInstance()
                        .refreshAndFindFileByIoFile(File(repoRoot, change.relativePath))

                    SwingUtilities.invokeLater {
                        val contentFactory = DiffContentFactory.getInstance()
                        val left = contentFactory.create(project, headContent, fileType)
                        val right = if (vFile != null) {
                            contentFactory.create(project, vFile)
                        } else {
                            contentFactory.create(project, "", fileType)
                        }

                        val request = SimpleDiffRequest(
                            "${change.relativePath} (HEAD \u2194 Working Tree)",
                            left,
                            right,
                            "HEAD",
                            "Working Tree",
                        )
                        DiffManager.getInstance().showDiff(project, request)
                    }
                }
            }
        }
    }

    /**
     * Maps git porcelain status codes to VS Code-style single-letter display codes.
     * Git uses "??" for untracked files, but VS Code displays "U".
     */
    private fun displayStatusCode(code: String): String {
        return when (code) {
            "??" -> "U"
            else -> code
        }
    }

    /** Returns a color for the status code matching VS Code's git decoration colors. */
    private fun statusColor(code: String): Color {
        return when (code) {
            "M" -> Color(0xC08020)    // Modified — yellow/orange
            "A" -> Color(0x20A040)    // Added — green
            "??" -> Color(0x20A040)   // Untracked — green (displayed as U)
            "D" -> Color(0xC02020)    // Deleted — red
            "R" -> Color(0x6A9FD6)    // Renamed — blue
            "C" -> Color(0x6A9FD6)    // Copied — blue
            "U" -> Color(0xC02020)    // Unmerged/conflict — red
            else -> Color.GRAY
        }
    }

    /** Returns a human-readable tooltip for the status code. */
    private fun statusTooltip(code: String): String {
        return when (code) {
            "M" -> "Modified"
            "A" -> "Index Added"
            "??" -> "Untracked"
            "D" -> "Deleted"
            "R" -> "Renamed"
            "C" -> "Copied"
            "U" -> "Unmerged"
            else -> code
        }
    }

    override fun dispose() {
        service.removeStatusListener(statusListener)
        debounceTimer?.stop()
        gitChangeDebounceTimer?.stop()
        projectBusConnection.disconnect()
        appBusConnection.disconnect()
    }
}

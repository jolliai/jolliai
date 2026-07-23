package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.services.FileChange
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationActivationListener
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vcs.changes.Change
import com.intellij.openapi.vcs.changes.ChangeListListener
import com.intellij.openapi.vcs.changes.ChangeListManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.openapi.wm.IdeFrame
import com.intellij.util.messages.MessageBusConnection
import com.intellij.icons.AllIcons
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
import java.awt.font.TextAttribute
import java.awt.event.MouseEvent
import java.io.File
import java.nio.file.Path
import java.nio.file.Paths
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.actionSystem.Presentation
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import com.intellij.ui.JBColor
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
 *   - Reads working-tree changes from IntelliJ's ChangeListManager (same source as the
 *     IDE Commit tool window; reflects unsaved in-editor edits), falling back to
 *     `git status --porcelain=v1` when the VCS layer isn't ready
 *   - Auto-refreshes on ChangeListManager updates and file-system changes (VFS listener)
 *   - Checkboxes for selecting files to commit
 *   - Color-coded status letters matching VS Code (M=yellow, A=green, U=green, D=red, R=blue)
 *   - Untracked files (?? in porcelain) display as "U" to match VS Code convention
 *   - Discard icon appears on hover to revert individual file changes
 */
class ChangesPanel(
    private val project: Project,
    private val service: JolliMemoryService,
) : JPanel(BorderLayout()), Disposable, RowCountSource {

    override var onRowCountChanged: ((Int) -> Unit)? = null
    override fun currentRowCount(): Int = changes.size

    private val emptyLabel = JBLabel("No changes detected.", javax.swing.SwingConstants.CENTER)
    /**
     * Per-file selection (parallel to [changes]); deselected files are struck through.
     *
     * `CopyOnWriteArrayList` because [getSelectedFiles] is invoked from
     * [ai.jolli.jollimemory.actions.CommitAIAction.update] on the background
     * ActionUpdateThread (BGT), while all mutations here fire from EDT event
     * handlers (mouse toggle, refreshFromGit). An `ArrayList` would let the
     * concurrent `clear() + add()` cycle slice through a BGT read and throw
     * CME; COW gives the reader an implicit snapshot with no explicit locking.
     * Writes are O(n) but n is capped at the working-tree change count, so the
     * copy cost is negligible against the safety win.
     */
    private val selectedStates: MutableList<Boolean> = java.util.concurrent.CopyOnWriteArrayList()
    private val fileListPanel = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
    }
    private var changes: List<FileChange> = emptyList()
    /** Whether the user expanded past the 6-row cap (via "Show N more"). */
    private var changesExpanded = false
    private var debounceTimer: Timer? = null
    private var gitChangeDebounceTimer: Timer? = null
    /**
     * Repeating safety-net poll for file changes made OUTSIDE the IDE (e.g. Claude
     * Code editing files from a terminal). In-editor edits refresh instantly via the
     * ChangeListListener subscription; external writes surface once IntelliJ refreshes
     * its VFS (native watcher, or window focus-gain), which also updates the
     * ChangeListManager that refreshFromGit reads from. This tick is the backstop for
     * the rare case neither has fired yet. Runs only while the panel is showing;
     * dedupes so an unchanged tree is a cheap no-op.
     */
    private var pollTimer: Timer? = null
    /**
     * Signature of the changed-file set currently rendered. Refreshes short-circuit
     * when the new set matches this, so the 2s poll (and unrelated in-IDE saves)
     * neither flicker the list nor wipe the user's manual selections — the reset
     * happens only when the set genuinely changes. Null forces the next render
     * (initial load, and after an initializing/disabled state).
     */
    private var lastRenderedSignature: String? = null
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
        // Match PINNED's container insets (empty(2,4)) so all sections share the same
        // first-row/last-row edge gaps. Each row adds empty(2,4) → 4px edge, 8px sides.
        border = JBUI.Borders.empty(2, 4)

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

        // ChangeListManager is the IDE's own working-tree change tracker — the same
        // source the built-in Commit tool window reads. Its "update done" signal fires
        // once in-editor edits are reflected in the change list, INCLUDING files that
        // are modified but not yet saved to disk. Subscribing here is what makes the
        // panel update as the user types, instead of only after the file is flushed to
        // disk and picked up by a disk-level `git status`.
        projectBusConnection.subscribe(
            ChangeListListener.TOPIC,
            object : ChangeListListener {
                override fun changeListUpdateDone() = scheduleDebouncedRefresh()
            },
        )

        // Focus-gain: when the IDE window is re-activated (e.g. the user alt-tabs
        // back after Claude Code edited files in a terminal), refresh immediately
        // so the panel is current the moment they look at it.
        appBusConnection.subscribe(
            ApplicationActivationListener.TOPIC,
            object : ApplicationActivationListener {
                override fun applicationActivated(ideFrame: IdeFrame) = scheduleDebouncedRefresh()
            },
        )

        // Live poll for external changes while the panel is on screen (see pollTimer).
        // The Swing Timer fires on the EDT, so the isShowing check is thread-safe;
        // refresh() is deduped, making an unchanged tree a cheap no-op.
        pollTimer = Timer(2000) { if (isShowing) { flushUnsavedGitignore(); refresh() } }.apply {
            isRepeats = true
            start()
        }

        // Initial load
        ApplicationManager.getApplication().executeOnPooledThread { refreshFromGit() }
    }

    private fun scheduleDebouncedRefresh() {
        debounceTimer?.stop()
        debounceTimer = Timer(300) { flushUnsavedGitignore(); refresh() }.apply {
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
        gitChangeDebounceTimer = Timer(500) { flushUnsavedGitignore(); refresh() }.apply {
            isRepeats = false
            start()
        }
    }

    /**
     * Flushes unsaved git ignore-rule edits to disk — ONLY `.gitignore` documents and
     * the repo-local `.git/info/exclude` (never any other unsaved file).
     *
     * Ignore semantics are disk-based: both git and IntelliJ's VCS ignore engine read
     * the saved file. So an edited-but-unsaved .gitignore shows its own M row instantly
     * (ChangeListManager sees in-editor edits), while the files it un-ignores stay
     * hidden until the document lands on disk — with IntelliJ's lazy autosave that can
     * be many seconds. Saving the ignore-rule document early closes that gap and
     * matches the VS Code (autosave) experience. Must run on the EDT — all callers
     * are Swing timer callbacks.
     */
    private fun flushUnsavedGitignore() {
        try {
            val fdm = FileDocumentManager.getInstance()
            val unsaved = fdm.unsavedDocuments.filter { doc ->
                val f = fdm.getFile(doc) ?: return@filter false
                // .git/info/exclude — the parent+path guard also matches the per-worktree
                // variant at .git/worktrees/<n>/info/exclude, so linked worktrees behave
                // identically to the main working tree.
                f.name == ".gitignore" ||
                    (f.name == "exclude" && f.parent?.name == "info" && f.path.contains("/.git/"))
            }
            unsaved.forEach { fdm.saveDocument(it) }
        } catch (_: Exception) {
            // best-effort flush; a failure just means the disk-based ignore check
            // will lag until IntelliJ's own autosave catches up.
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
            SwingUtilities.invokeLater { if (refreshVersion == myVersion) showDisabled() }
            return
        }

        // Prefer IntelliJ's ChangeListManager: it reflects in-editor edits that are not
        // yet saved to disk (the IDE's own Commit panel reads the same source), so the
        // list updates as the user types. Fall back to the on-disk `git status` path
        // only when the VCS layer can't produce a list (readChangesFromClm returns null).
        val repoRoot = service.mainRepoRoot ?: project.basePath
        val clmChanges = repoRoot?.let { readChangesFromClm(it) }
        val newChanges = try {
            clmChanges ?: service.getChangedFiles()
        } catch (_: Exception) {
            emptyList()
        }
        // Dedupe: if the changed-file SET is identical to what's already rendered,
        // do nothing — no re-render (no flicker) and, crucially, no selection reset.
        // This is what makes the 2s poll and unrelated in-IDE saves cheap and
        // non-destructive; the reset below runs only on a genuine change.
        val signature = changesSignature(newChanges)
        if (signature == lastRenderedSignature) return
        changes = newChanges
        // Reset selection to each file's default whenever the working tree changes.
        selectedStates.clear()
        changes.forEach { selectedStates.add(it.isSelected) }
        SwingUtilities.invokeLater {
            if (refreshVersion == myVersion) {
                lastRenderedSignature = signature
                updateFileList()
            }
        }
    }

    /**
     * Reads working-tree changes from IntelliJ's [ChangeListManager] — the same data
     * source the IDE's built-in Commit tool window uses. Unlike the disk-level `git
     * status` in [JolliMemoryService.getChangedFiles], this reflects in-editor edits
     * not yet saved to disk, so the panel updates as the user types. Returns null on
     * failure (VCS layer not ready / read error) so the caller can fall back to git.
     *
     * Status codes are the single-letter git codes [JolliMemoryService.getChangedFiles]
     * emits (untracked = "?"), so downstream consumers — commit staging in
     * CommitAIAction, discard, status badges — behave identically to the git path.
     * Sorted by path so the dedupe signature in [refreshFromGit] is stable across
     * ChangeListManager's unordered collection.
     */
    private fun readChangesFromClm(repoRoot: String): List<FileChange>? {
        return try {
            ReadAction.compute<List<FileChange>?, RuntimeException> {
                val clm = ChangeListManager.getInstance(project)
                val root = Paths.get(repoRoot)
                val out = mutableListOf<FileChange>()
                for (change in clm.allChanges) {
                    val fp = change.afterRevision?.file ?: change.beforeRevision?.file ?: continue
                    val rel = relativizeToRoot(root, fp.path) ?: continue
                    out.add(FileChange(relativePath = rel, statusCode = clmStatusCode(change)))
                }
                for (fp in clm.unversionedFilesPaths) {
                    val rel = relativizeToRoot(root, fp.path) ?: continue
                    out.add(FileChange(relativePath = rel, statusCode = "?"))
                }
                // Distinguish "CLM says clean" from "CLM has not populated yet". At
                // startup — and briefly after a VCS refresh — the manager returns
                // empty collections before its first update finishes, so returning
                // `emptyList()` here would let the caller's `clmChanges ?: gitFallback`
                // skip the git path and flash "no changes" over a dirty tree. When
                // the CLM view is empty, we defer to git — a clean tree makes that
                // an extra 5 ms `git status` per 2 s poll (cheap and self-correcting),
                // while a dirty tree correctly shows its files instead of nothing.
                if (out.isEmpty()) null else out.sortedBy { it.relativePath }
            }
        } catch (_: Exception) {
            null
        }
    }

    /** Maps a ChangeListManager change type to the single-letter git code getChangedFiles emits. */
    private fun clmStatusCode(change: Change): String = when (change.type) {
        Change.Type.NEW -> "A"
        Change.Type.DELETED -> "D"
        Change.Type.MODIFICATION -> "M"
        Change.Type.MOVED -> "R"
    }

    /** Repo-root-relative, forward-slash path; null when [absPath] falls outside [root]. */
    private fun relativizeToRoot(root: Path, absPath: String): String? {
        return try {
            val rel = root.relativize(Paths.get(absPath))
            if (rel.startsWith("..")) null else FileUtil.toSystemIndependentName(rel.toString())
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Order-sensitive signature of the changed-file set (status code + path per
     * file). Two refreshes with the same signature render identically, so the
     * dedupe in [refreshFromGit] can skip the second one.
     */
    private fun changesSignature(list: List<FileChange>): String =
        list.joinToString("\n") { "${it.statusCode} ${it.relativePath}" }

    private fun showInitializing() {
        // Force the next data refresh to render even if the file set matches what
        // was shown before this initializing/disabled state (dedupe would else skip it).
        lastRenderedSignature = null
        removeAll()
        emptyLabel.text = "<html><center>Initializing Jolli Memory...</center></html>"
        add(emptyLabel, BorderLayout.CENTER)
        revalidate(); repaint()
    }

    // Shown when the service is initialized but hooks are not installed (or were
    // uninstalled). Distinct from showInitializing so users are not misled into
    // thinking a background task is still running — nothing is, until they enable.
    private fun showDisabled() {
        lastRenderedSignature = null
        removeAll()
        emptyLabel.text = "<html><center>Jolli Memory is not enabled for this repository.<br/>" +
            "Open the Status panel to install hooks and enable it.</center></html>"
        add(emptyLabel, BorderLayout.CENTER)
        revalidate(); repaint()
    }

    private fun updateFileList() {
        onRowCountChanged?.invoke(changes.size)
        removeAll()
        // Defensive: keep selection state parallel to the current file list.
        if (selectedStates.size != changes.size) {
            selectedStates.clear()
            changes.forEach { selectedStates.add(it.isSelected) }
        }
        fileListPanel.removeAll()
        hoveredRow = null

        if (changes.isEmpty()) {
            emptyLabel.text = "Working tree clean — no changes."
            add(emptyLabel, BorderLayout.NORTH)
        } else {
            // Build all rows (so every checkbox exists for getSelectedFiles), but show
            // at most 6 — the rest collapse behind "Show N more". No inner scrollbar;
            // Current Memory provides a single scrollbar across all three sections.
            // The Commit action lives in the bottom action bar, not per-section.
            val rows = changes.mapIndexed { i, c -> createFileRow(c, i) }
            CappedRows.render(fileListPanel, rows, changesExpanded) {
                changesExpanded = true
                updateFileList()
            }
            add(fileListPanel, BorderLayout.NORTH)
        }

        revalidate(); repaint()
    }

    override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)

    fun getSelectedFiles(): List<FileChange> {
        return changes.filterIndexed { i, _ -> selectedStates.getOrNull(i) ?: false }
    }

    /** Returns all files in the changes list (selected and unselected). */
    fun getFiles(): List<FileChange> = changes.toList()

    /** Toggles all files — if any are deselected, select all; otherwise deselect all. */
    fun toggleSelectAll() {
        val anyUnselected = selectedStates.any { !it }
        for (i in selectedStates.indices) selectedStates[i] = anyUnselected
        updateFileList()
        service.notifySelectionChanged()
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
    private fun createFileRow(change: FileChange, index: Int): JPanel {
        val fileName = File(change.relativePath).name
        val fileIcon = FileTypeManager.getInstance().getFileTypeByFileName(fileName).icon

        val iconLabel = JLabel(fileIcon).apply {
            border = JBUI.Borders.emptyRight(4)
        }

        val displayStatus = displayStatusCode(change.statusCode)

        // Filename (line 1) + parent directory (line 2). Always two lines so the row
        // has room for the hover icons and the full name/path are readable; each line
        // ellipsizes when too narrow.
        val parentDir = File(change.relativePath).parent?.let { "$it/" } ?: ""

        val nameLabel = JLabel(fileName).apply {
            minimumSize = Dimension(0, preferredSize.height)
            alignmentX = Component.LEFT_ALIGNMENT
        }
        val baseNameFont = nameLabel.font
        val strikeNameFont = baseNameFont.deriveFont(mapOf(TextAttribute.STRIKETHROUGH to TextAttribute.STRIKETHROUGH_ON))
        val pathLabel = JLabel(parentDir).apply {
            foreground = Color.GRAY
            font = font.deriveFont(font.size2D - 1f)
            minimumSize = Dimension(0, preferredSize.height)
            alignmentX = Component.LEFT_ALIGNMENT
            isVisible = parentDir.isNotBlank()
        }
        val centerPanel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
            add(nameLabel)
            add(pathLabel)
        }

        // Icon, vertically centered next to the two-line text.
        val iconWrap = JPanel(java.awt.GridBagLayout()).apply {
            isOpaque = false
            add(iconLabel, java.awt.GridBagConstraints())
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

        // Select toggle (✕ exclude / ＋ include) — hidden until hover; flips selection.
        val toggleLabel = JLabel().apply {
            isVisible = false
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            border = JBUI.Borders.emptyLeft(2)
        }

        // Right side: status badge + discard + select toggle, vertically centered with a
        // reserved width measured with the hover actions visible (and the toggle icon set,
        // so its width is counted) — otherwise the last icon is clipped.
        val rightInner = JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply {
            isOpaque = false
            add(statusLabel)
            add(discardLabel)
            add(toggleLabel)
        }
        toggleLabel.icon = AllIcons.Actions.Close
        discardLabel.isVisible = true; toggleLabel.isVisible = true
        val reservedRightW = rightInner.preferredSize.width
        discardLabel.isVisible = false; toggleLabel.isVisible = false
        val rightWrap = JPanel(java.awt.GridBagLayout()).apply {
            isOpaque = false
            add(rightInner, java.awt.GridBagConstraints())
            preferredSize = Dimension(reservedRightW, JBUI.scale(16))
            minimumSize = Dimension(reservedRightW, 0)
        }

        val row = JPanel(BorderLayout()).apply {
            isOpaque = false
            border = JBUI.Borders.empty(2, 4)
            alignmentX = Component.LEFT_ALIGNMENT
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            add(iconWrap, BorderLayout.WEST)
            add(centerPanel, BorderLayout.CENTER)
            add(rightWrap, BorderLayout.EAST)
        }

        // Strike + dim the filename when deselected; flip the toggle icon (✕/＋).
        fun applySelection() {
            val sel = selectedStates.getOrNull(index) ?: true
            nameLabel.font = if (sel) baseNameFont else strikeNameFont
            nameLabel.foreground = if (sel) statusColor(change.statusCode) else JBColor.GRAY
            toggleLabel.icon = if (sel) AllIcons.Actions.Close else AllIcons.General.Add
            toggleLabel.toolTipText = if (sel) "Exclude from commit" else "Include in commit"
            row.repaint()
        }
        applySelection()
        toggleLabel.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (!SwingUtilities.isLeftMouseButton(e)) return
                e.consume()
                if (index in selectedStates.indices) {
                    selectedStates[index] = !(selectedStates.getOrNull(index) ?: true)
                }
                applySelection()
                service.notifySelectionChanged()
            }
        })

        // Show/hide hover actions (discard + select toggle) on hover
        val hoverListener = object : MouseAdapter() {
            override fun mouseEntered(e: MouseEvent) {
                hoveredRow = row
                row.isOpaque = true
                row.background = RowStyle.HOVER_BG
                discardLabel.isVisible = true
                toggleLabel.isVisible = true
                row.repaint()
            }
            override fun mouseExited(e: MouseEvent) {
                // Only hide if the mouse truly left the row (not just entering a child)
                val point = SwingUtilities.convertPoint(e.component, e.point, row)
                if (!row.contains(point)) {
                    hoveredRow = null
                    row.isOpaque = false
                    row.background = null
                    discardLabel.isVisible = false
                    toggleLabel.isVisible = false
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
        for (child in listOf(iconWrap, rightWrap, rightInner, centerPanel, iconLabel, nameLabel, pathLabel, statusLabel, discardLabel, toggleLabel)) {
            child.addMouseListener(hoverListener)
            child.addMouseListener(contextMenuListener)
        }

        // Constrain row height so BoxLayout doesn't stretch rows apart.
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
        pollTimer?.stop()
        projectBusConnection.disconnect()
        appBusConnection.disconnect()
    }
}

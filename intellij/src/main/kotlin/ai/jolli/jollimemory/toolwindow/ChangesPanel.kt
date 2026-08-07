package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.core.FileDiscarder
import ai.jolli.jollimemory.core.GitStatusCodes
import ai.jolli.jollimemory.core.UnsavedEdits
import ai.jolli.jollimemory.core.WorktreeRoot
import ai.jolli.jollimemory.services.FileChange
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationActivationListener
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.runReadAction
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
        val repoRoot = WorktreeRoot.of(project)
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
            runReadAction<List<FileChange>?> {
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
        list.joinToString("\n") { "${it.statusCode}\u0000${it.relativePath}" }

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

    /**
     * Creates a VS Code-style file row:
     *   filename / parentDir      [⤺ discard] [✕ leave out]  M
     *
     * Layout: BorderLayout
     *   CENTER = filename + parentDir (two stacked lines, fills the width)
     *   EAST   = discard + exclude toggle (hover-only) then the status letter
     *
     * Deliberately NO leading file-type icon: VS Code's Files rows drop it too
     * (see renderChangeRow — "NO leading file-type codicon"), letting the tinted
     * filename plus the trailing status letter carry the git state on their own.
     *
     * The trailing order is [discard] [✕] [letter], matching VS Code where the
     * hover-action cluster sits left of the always-visible `.gs-letter` at the
     * row's right edge. The two hover actions are the row's ONLY actions — there
     * is no per-row menu beyond the right-click Discard Changes entry below.
     */
    private fun createFileRow(change: FileChange, index: Int): JPanel {
        val fileName = File(change.relativePath).name

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

        // Status badge (colored letter matching VS Code: M, A, D, U, R). Sits at the
        // row's right edge, after the hover actions — VS Code's `.gs-letter` order.
        val statusLabel = JLabel(displayStatus).apply {
            foreground = statusColor(change.statusCode)
            border = JBUI.Borders.emptyLeft(4)
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

        // Hover actions [⤺ discard] [✕ leave out], in a FIXED-width slot: the width is
        // measured with both visible (and the toggle icon assigned, so its width
        // counts), then they are hidden again. Reserving the space is what keeps the
        // status letter still as they appear and disappear — VS Code gets the same
        // effect by absolutely positioning its .inline-actions overlay.
        val actionsInner = JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply {
            isOpaque = false
            add(discardLabel)
            add(toggleLabel)
        }
        toggleLabel.icon = AllIcons.Actions.Close
        discardLabel.isVisible = true; toggleLabel.isVisible = true
        val reservedActionsW = actionsInner.preferredSize.width
        discardLabel.isVisible = false; toggleLabel.isVisible = false
        val actionsWrap = JPanel(java.awt.GridBagLayout()).apply {
            isOpaque = false
            add(actionsInner, java.awt.GridBagConstraints())
            preferredSize = Dimension(reservedActionsW, JBUI.scale(16))
            minimumSize = Dimension(reservedActionsW, 0)
        }
        // Status letter pinned to the row's right edge, past the action slot — the
        // [discard] [✕] then .gs-letter order VS Code's change rows use. Both halves
        // are GridBag-wrapped purely to centre them against the two-line filename.
        val statusWrap = JPanel(java.awt.GridBagLayout()).apply {
            isOpaque = false
            add(statusLabel, java.awt.GridBagConstraints())
        }
        val rightWrap = JPanel(BorderLayout()).apply {
            isOpaque = false
            add(actionsWrap, BorderLayout.CENTER)
            add(statusWrap, BorderLayout.EAST)
        }

        val row = JPanel(BorderLayout()).apply {
            isOpaque = false
            border = JBUI.Borders.empty(2, 4)
            alignmentX = Component.LEFT_ALIGNMENT
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            add(centerPanel, BorderLayout.CENTER)
            add(rightWrap, BorderLayout.EAST)
        }

        // Strike + dim the filename when deselected; flip the toggle icon (✕/＋).
        fun applySelection() {
            val sel = selectedStates.getOrNull(index) ?: true
            nameLabel.font = if (sel) baseNameFont else strikeNameFont
            nameLabel.foreground = if (sel) statusColor(change.statusCode) else JBColor.GRAY
            toggleLabel.icon = if (sel) AllIcons.Actions.Close else AllIcons.General.Add
            // Same wording VS Code's excludeToggle uses — the row is included by
            // default and this leaves it out of the NEXT memory (reversible), which
            // "Exclude from commit" read as a staging operation it is not.
            toggleLabel.toolTipText = if (sel) "Leave out of this memory" else "Add back to this memory"
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
        for (child in listOf(nameLabel, pathLabel, statusLabel)) {
            child.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            child.addMouseListener(diffClickListener)
        }

        // Right-click context menu — ONE entry, matching VS Code's 'file' /
        // 'fileChange' menu exactly. Leaving the row out of the memory is the hover
        // ✕ toggle's job there and here; do not add it as a second menu entry.
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
        for (child in listOf(rightWrap, actionsWrap, actionsInner, statusWrap, centerPanel, nameLabel, pathLabel, statusLabel, discardLabel, toggleLabel)) {
            child.addMouseListener(hoverListener)
            child.addMouseListener(contextMenuListener)
        }

        // Constrain row height so BoxLayout doesn't stretch rows apart.
        row.maximumSize = Dimension(Int.MAX_VALUE, row.preferredSize.height)
        return row
    }

    /**
     * Discards changes for a single file after confirmation.
     *
     * WHICH git command each status needs is deliberately not documented here, and
     * must not be: that rule lives in the CLI's `FileDiscardService`, this only
     * sends a path. The list that used to sit in this comment ("checkout for M/D,
     * reset for A") outlived the code by two rewrites and described neither the
     * commands actually run nor the rename and copy cases at all — a restatement
     * of a CLI rule rots the same way in a comment as it does in Kotlin.
     */
    private fun discardFile(change: FileChange) {
        // The prompt's verb is a CLI answer, so the dialog waits on a pooled-thread
        // round trip (~5-20 ms against the bound daemon) instead of opening on the
        // EDT immediately. [FileChange.statusCode] cannot be trusted for it: it is
        // one collapsed letter, and the collapse is lossy in exactly the cases that
        // decide the wording — see [FileDiscarder.preview].
        ApplicationManager.getApplication().executeOnPooledThread {
            val previewRoot = WorktreeRoot.of(project)
            val deletes = try {
                previewRoot != null && change.relativePath in FileDiscarder.preview(previewRoot, listOf(change.relativePath))
            } catch (_: Exception) {
                // Bridge down, CLI missing, unreadable body: fall back to the letter
                // heuristic this host used before the query existed. Wrong for a
                // conflicted row, right for every other one — and strictly better
                // than refusing to open the dialog over a wording detail.
                GitStatusCodes.discardDeletesFile(change.statusCode)
            }
            SwingUtilities.invokeLater { confirmAndDiscard(change, deletes) }
        }
    }

    /**
     * Shows the confirmation for [change] and, if accepted, runs the discard.
     *
     * [deletesFile] decides the verb only. Split out of [discardFile] so the
     * dialog runs on the EDT after the preview round trip that produced it.
     */
    private fun confirmAndDiscard(change: FileChange, deletesFile: Boolean) {
        // Say "delete" only when the file really is going away — an untracked file,
        // a staged addition, a rename or copy revert, and a conflicted path with no
        // HEAD version all have nothing to restore, so "discard changes to" would
        // understate what the button does.
        val action = if (deletesFile) "delete" else "discard changes to"
        val result = Messages.showYesNoDialog(
            project,
            "Are you sure you want to $action \"${change.relativePath}\"?\n\nThis action cannot be undone.",
            "Discard Changes",
            Messages.getWarningIcon(),
        )
        if (result != Messages.YES) return

        // Still on the EDT, and before any git runs: this list comes from
        // ChangeListManager, which shows a file as changed while its edits live
        // only in the editor's document — but the CLI resolves every path against
        // `git status`, which cannot see those. Flushing first is what stops the
        // discard reporting `not-found` + ok:true on a row the user can plainly
        // see. [WorktreeRoot] is a plain field read, not a git call, so this costs
        // the EDT nothing. See [UnsavedEdits].
        WorktreeRoot.of(project)?.let { editorRoot ->
            UnsavedEdits.flush(editorRoot, listOf(change.relativePath))
        }

        ApplicationManager.getApplication().executeOnPooledThread {
            // No repo root is a failure like any other, not a quiet return: the user
            // already confirmed a destructive action, so nothing happening without a
            // word is the exact symptom this whole path exists to remove.
            val repoRoot = WorktreeRoot.of(project)
            if (repoRoot == null) {
                SwingUtilities.invokeLater {
                    Messages.showErrorDialog(
                        project,
                        "Could not discard \"${change.relativePath}\".\n\nNo repository root is available for this project.",
                        "Discard Changes Failed",
                    )
                }
                return@executeOnPooledThread
            }
            // Branch on the OUTCOME, not on its message. `error` is nullable on the
            // wire, so testing the string for emptiness silently drops any failure
            // that arrives without one — the same silent success in a new costume.
            var touched = listOf(change.relativePath)
            val failure: String? = try {
                val outcomes = FileDiscarder.discard(repoRoot, listOf(change.relativePath))
                touched = outcomes.flatMap { it.touchedPaths }.distinct()
                outcomes.firstOrNull { !it.ok }?.let { it.error ?: "unknown error" }
            } catch (e: Exception) {
                e.message ?: e.javaClass.simpleName
            }
            // A discard that did not happen must SAY so. Swallowing this is what
            // made the old bug indistinguishable from a working button: the
            // confirmation dialog appeared, the user clicked through, and the file
            // was still there with nothing logged anywhere.
            if (failure != null) {
                SwingUtilities.invokeLater {
                    Messages.showErrorDialog(
                        project,
                        "Could not discard \"${change.relativePath}\".\n\n$failure",
                        "Discard Changes Failed",
                    )
                }
            }
            // Refresh either way: a partial failure still changed something, and the
            // panel must show what is actually on disk now.
            refreshDiscardedPaths(touched)
        }
    }

    /**
     * Re-reads the working tree after a discard, refreshing the VFS first.
     *
     * The CLI deleted or rewrote these files behind IntelliJ's back, so its virtual
     * file system still holds the old state — and [readChangesFromClm] reads
     * ChangeListManager, which is built from the VFS. Without this the row survives
     * its own successful discard until some unrelated event refreshes the VFS,
     * which reads as "the button did nothing". The 2 s poll cannot rescue it: it
     * short-circuits on an unchanged signature, and the signature is computed from
     * that same stale ChangeListManager.
     *
     * Pass every path the discard TOUCHED, not just the one the user clicked. A
     * rename revert also writes the original path back, and that file is invisible
     * to the IDE until it is refreshed here.
     */
    private fun refreshDiscardedPaths(relativePaths: List<String>) {
        val repoRoot = WorktreeRoot.of(project)
        if (repoRoot != null) {
            val files = relativePaths.map { File(repoRoot, it) }
            LocalFileSystem.getInstance().refreshIoFiles(files, false, true, null)
        }
        refreshFromGit()
    }

    /**
     * Opens a diff or file view based on status, matching VS Code's jollimemory.openFileChange:
     * - Modified (M): diff HEAD ↔ Working Tree
     * - Added/Untracked/Renamed/Copied: open file directly (HEAD has no version of THIS path)
     * - Deleted (D): show HEAD version read-only (file no longer exists on disk)
     *
     * The untracked test goes through [GitStatusCodes] for the same reason discard
     * does: a literal `"??"` never matches our collapsed `"?"`, which sent untracked
     * files down the Modified branch and diffed them against an empty `git show`.
     *
     * Renames and copies join the open-directly branch for the same reason, one step
     * removed: HEAD stores their content under the ORIGINAL path, and [FileChange]
     * does not carry it (`getChangedFiles` discards it while parsing). So
     * `git show HEAD:<thisPath>` resolves to nothing and the "diff" was the whole
     * file rendered as an addition against a blank left pane. Opening the file is
     * the honest degradation — the same one VS Code falls back to when its own
     * `originalPath` is absent. Restoring a real rename diff means carrying the
     * original path on the row first.
     */
    private fun openFileDiff(change: FileChange) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val repoRoot = WorktreeRoot.of(project) ?: return@executeOnPooledThread

            when {
                change.statusCode == "A" ||
                    GitStatusCodes.isUntracked(change.statusCode) ||
                    GitStatusCodes.isRenamedOrCopied(change.statusCode) -> {
                    // New/untracked/renamed/copied — open directly: HEAD has no
                    // version of THIS path to diff against (see the KDoc above).
                    val vFile = LocalFileSystem.getInstance()
                        .refreshAndFindFileByIoFile(File(repoRoot, change.relativePath))
                    if (vFile != null) {
                        SwingUtilities.invokeLater {
                            com.intellij.openapi.fileEditor.FileEditorManager
                                .getInstance(project).openFile(vFile, true)
                        }
                    }
                }
                change.statusCode == "D" -> {
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
                    // Modified — diff HEAD ↔ Working Tree. Renames and copies are
                    // handled above; they have no HEAD blob at this path.
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
     * Maps a git status code to the VS Code-style single display letter. Git calls an
     * untracked file `??` and VS Code shows it as `U`; our producers collapse that to
     * `?`, so the untracked test goes through [GitStatusCodes] — matching `"??"` alone
     * left the raw `?` on screen as an unexplained grey glyph.
     */
    private fun displayStatusCode(code: String): String {
        return when {
            GitStatusCodes.isUntracked(code) -> "U"
            else -> code
        }
    }

    /** Returns a color for the status code matching VS Code's git decoration colors. */
    private fun statusColor(code: String): Color {
        return when {
            GitStatusCodes.isUntracked(code) -> Color(0x20A040) // Untracked — green (shown as U)
            code == "M" -> Color(0xC08020)    // Modified — yellow/orange
            code == "A" -> Color(0x20A040)    // Added — green
            code == "D" -> Color(0xC02020)    // Deleted — red
            code == "R" -> Color(0x6A9FD6)    // Renamed — blue
            code == "C" -> Color(0x6A9FD6)    // Copied — blue
            code == "U" -> Color(0xC02020)    // Unmerged/conflict — red
            else -> Color.GRAY
        }
    }

    /** Returns a human-readable tooltip for the status code. */
    private fun statusTooltip(code: String): String {
        return when {
            GitStatusCodes.isUntracked(code) -> "Untracked"
            code == "M" -> "Modified"
            code == "A" -> "Index Added"
            code == "D" -> "Deleted"
            code == "R" -> "Renamed"
            code == "C" -> "Copied"
            code == "U" -> "Unmerged"
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

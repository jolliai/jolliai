package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.core.NoteEntry
import ai.jolli.jollimemory.core.NoteFormat
import ai.jolli.jollimemory.core.PlanEntry
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.io.File
import javax.swing.DefaultListModel
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JMenuItem
import javax.swing.JOptionPane
import javax.swing.JPanel
import javax.swing.JPopupMenu
import javax.swing.KeyStroke
import javax.swing.ListCellRenderer
import javax.swing.ListSelectionModel
import javax.swing.SwingConstants
import javax.swing.SwingUtilities

/**
 * Plans & Notes panel — shows Claude Code plan files and user-created notes.
 * Matches VS Code PlansTreeProvider: merges plans and notes into a single
 * list sorted by lastModified (newest first).
 *
 * Plans are tracked in .jolli/jollimemory/plans.json by the StopHook.
 * Notes are stored in .jolli/jollimemory/notes/ directory.
 * Each item shows title, icon (plan/note type), edit count or format, and commit association.
 * Double-click to open in editor.
 */
class PlansPanel(
    private val project: Project,
    private val service: JolliMemoryService,
) : JPanel(BorderLayout()), Disposable {

    /** Unified item wrapper for the merged plans+notes list */
    private sealed class ListItem(val title: String, val lastModified: String) {
        class PlanItem(val plan: PlanEntry) : ListItem(
            plan.title.ifBlank { plan.slug },
            plan.updatedAt,
        )
        class NoteItem(val note: NoteEntry) : ListItem(
            note.title,
            note.updatedAt,
        )
    }

    private val listModel = DefaultListModel<ListItem>()
    private val itemList = JBList(listModel).apply {
        cellRenderer = PlansAndNotesCellRenderer()
        selectionMode = ListSelectionModel.SINGLE_SELECTION
    }
    private val emptyLabel = JBLabel("No plans or notes yet.", SwingConstants.CENTER)
    private val statusListener: () -> Unit = { SwingUtilities.invokeLater { refresh() } }

    init {
        border = JBUI.Borders.empty(8)

        // Single click on trash icon to remove; double-click elsewhere to open in editor
        itemList.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                val index = itemList.locationToIndex(e.point)
                if (index < 0) return
                val cellBounds = itemList.getCellBounds(index, index) ?: return

                // Check if click landed on the trash icon (right edge of the row)
                val renderer = itemList.cellRenderer as? PlansAndNotesCellRenderer
                val trashWidth = renderer?.getTrashIconWidth() ?: 30
                val trashStart = cellBounds.x + cellBounds.width - trashWidth
                if (e.x >= trashStart && e.clickCount == 1) {
                    itemList.selectedIndex = index
                    removeSelectedItem()
                    return
                }

                if (e.clickCount == 2) {
                    val selected = itemList.selectedValue ?: return
                    when (selected) {
                        is ListItem.PlanItem -> openPlan(selected.plan)
                        is ListItem.NoteItem -> openNote(selected.note)
                    }
                }
            }
        })

        // Show hand cursor when hovering over the trash icon zone
        itemList.addMouseMotionListener(object : MouseAdapter() {
            override fun mouseMoved(e: MouseEvent) {
                val index = itemList.locationToIndex(e.point)
                if (index >= 0) {
                    val cellBounds = itemList.getCellBounds(index, index)
                    if (cellBounds != null && cellBounds.contains(e.point)) {
                        val renderer = itemList.cellRenderer as? PlansAndNotesCellRenderer
                        val trashWidth = renderer?.getTrashIconWidth() ?: 30
                        val trashStart = cellBounds.x + cellBounds.width - trashWidth
                        if (e.x >= trashStart) {
                            itemList.cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
                            return
                        }
                    }
                }
                itemList.cursor = java.awt.Cursor.getDefaultCursor()
            }
        })

        // Right-click context menu with "Remove" option
        itemList.addMouseListener(object : MouseAdapter() {
            override fun mousePressed(e: MouseEvent) { maybeShowPopup(e) }
            override fun mouseReleased(e: MouseEvent) { maybeShowPopup(e) }

            private fun maybeShowPopup(e: MouseEvent) {
                if (!e.isPopupTrigger) return
                val index = itemList.locationToIndex(e.point)
                if (index < 0) return
                itemList.selectedIndex = index
                val popup = JPopupMenu()
                val removeItem = JMenuItem("Remove", JolliMemoryIcons.Trash)
                removeItem.addActionListener { removeSelectedItem() }
                popup.add(removeItem)
                popup.show(itemList, e.x, e.y)
            }
        })

        // Delete / Backspace key to remove selected item
        itemList.registerKeyboardAction(
            { removeSelectedItem() },
            KeyStroke.getKeyStroke(KeyEvent.VK_DELETE, 0),
            JComponent.WHEN_FOCUSED,
        )
        itemList.registerKeyboardAction(
            { removeSelectedItem() },
            KeyStroke.getKeyStroke(KeyEvent.VK_BACK_SPACE, 0),
            JComponent.WHEN_FOCUSED,
        )

        service.addStatusListener(statusListener)
        ApplicationManager.getApplication().executeOnPooledThread { refreshFromDisk() }
    }

    fun refresh() {
        ApplicationManager.getApplication().executeOnPooledThread { refreshFromDisk() }
    }

    /**
     * Prompts the user to confirm removal of the selected plan or note.
     * Plans are soft-deleted (ignored: true); notes are fully removed from
     * the registry (matching VS Code semantics).
     */
    private fun removeSelectedItem() {
        val selected = itemList.selectedValue ?: return
        val (itemType, itemName) = when (selected) {
            is ListItem.PlanItem -> "plan" to (selected.plan.title.ifBlank { selected.plan.slug })
            is ListItem.NoteItem -> "note" to selected.note.title
        }

        val result = Messages.showYesNoDialog(
            project,
            "Remove $itemType \"$itemName\" from the list?",
            "Remove ${itemType.replaceFirstChar { it.uppercase() }}",
            Messages.getQuestionIcon(),
        )
        if (result != Messages.YES) return

        ApplicationManager.getApplication().executeOnPooledThread {
            val cwd = service.mainRepoRoot ?: project.basePath ?: return@executeOnPooledThread
            when (selected) {
                is ListItem.PlanItem -> doRemovePlan(selected.plan.slug, cwd)
                is ListItem.NoteItem -> doRemoveNote(selected.note, cwd)
            }
            service.refreshStatus()
        }
    }

    /** Marks a plan as ignored in plans.json (soft delete — plan file untouched). */
    private fun doRemovePlan(slug: String, cwd: String) {
        val registry = SessionTracker.loadPlansRegistry(cwd)
        val entry = registry.plans[slug] ?: return
        val updatedPlans = registry.plans.toMutableMap()
        updatedPlans[slug] = entry.copy(ignored = true)
        SessionTracker.savePlansRegistry(registry.copy(plans = updatedPlans), cwd)
    }

    /** Removes a note from the registry entirely. Deletes snippet source file if uncommitted. */
    private fun doRemoveNote(note: NoteEntry, cwd: String) {
        val registry = SessionTracker.loadPlansRegistry(cwd)
        val notes = (registry.notes ?: emptyMap()).toMutableMap()
        if (!notes.containsKey(note.id)) return

        // Delete source file only for uncommitted snippet notes (matching VS Code).
        // Markdown note files are NOT deleted — they may reference user content.
        val entry = notes[note.id]!!
        if (entry.commitHash == null && entry.format == NoteFormat.snippet && entry.sourcePath != null) {
            try {
                val file = File(entry.sourcePath)
                if (file.exists()) file.delete()
            } catch (_: Exception) { /* best effort */ }
        }

        notes.remove(note.id)
        SessionTracker.savePlansRegistry(registry.copy(notes = notes), cwd)
    }

    private fun refreshFromDisk() {
        val status = service.getStatus()
        if (status == null) {
            SwingUtilities.invokeLater { showInitializing() }
            return
        }
        if (!status.enabled) {
            SwingUtilities.invokeLater { showDisabled() }
            return
        }

        val items = try {
            val cwd = service.mainRepoRoot ?: project.basePath ?: ""
            val gitOps = service.getGitOps()
            val currentBranch = gitOps?.getCurrentBranch()
            val registry = SessionTracker.loadPlansRegistry(cwd)

            val planItems = filterPlans(registry.plans, gitOps, currentBranch)
                .map { ListItem.PlanItem(it) }
            val noteItems = filterNotes(registry.notes ?: emptyMap(), gitOps, currentBranch)
                .map { ListItem.NoteItem(it) }

            // Merge and sort by lastModified descending (newest first), matching VS Code
            (planItems + noteItems).sortedByDescending { it.lastModified }
        } catch (_: Exception) {
            emptyList()
        }

        SwingUtilities.invokeLater { updateList(items) }
    }

    /** Filter plans using the same visibility rules as VS Code PlanService.toPlanInfo */
    private fun filterPlans(
        plans: Map<String, PlanEntry>,
        gitOps: ai.jolli.jollimemory.bridge.GitOps?,
        currentBranch: String?,
    ): List<PlanEntry> {
        val plansDir = File(System.getProperty("user.home"), ".claude/plans")
        return plans.values.filter { entry ->
            if (entry.ignored == true) return@filter false
            // Skip committed snapshot copies (slug-<shortHash> entries created by archivePlanForCommit).
            // These exist only for orphan branch storage / Summary WebView, not for the sidebar panel.
            if (entry.commitHash != null && entry.contentHashAtCommit == null) return@filter false
            // Skip archive guards (committed plans whose source file is unchanged)
            if (entry.contentHashAtCommit != null) {
                val planFile = File(plansDir, "${entry.slug}.md")
                if (!planFile.exists()) return@filter false
                val hash = try {
                    java.security.MessageDigest.getInstance("SHA-256")
                        .digest(planFile.readBytes())
                        .joinToString("") { "%02x".format(it) }
                } catch (_: Exception) { null }
                if (hash == entry.contentHashAtCommit) return@filter false
            }
            // Skip committed plans not on current branch
            if (entry.commitHash != null && currentBranch != null) {
                val onBranch = gitOps?.exec("merge-base", "--is-ancestor", entry.commitHash, "HEAD")
                if (onBranch == null) return@filter false
            }
            // Skip uncommitted plans whose source file was deleted
            if (entry.commitHash == null && !File(entry.sourcePath).exists()) return@filter false
            true
        }
    }

    /** Filter notes using the same visibility rules as VS Code NoteService */
    private fun filterNotes(
        notes: Map<String, NoteEntry>,
        gitOps: ai.jolli.jollimemory.bridge.GitOps?,
        currentBranch: String?,
    ): List<NoteEntry> {
        return notes.values.filter { entry ->
            if (entry.ignored == true) return@filter false
            // Skip committed snapshot copies (created by archiveNoteForCommit).
            // These exist only for orphan branch storage / Summary WebView, not for the sidebar panel.
            if (entry.commitHash != null && entry.contentHashAtCommit == null) return@filter false
            // Skip archive guards (committed notes whose content is unchanged)
            if (entry.contentHashAtCommit != null && entry.sourcePath != null) {
                val noteFile = File(entry.sourcePath)
                if (!noteFile.exists()) return@filter false
                val hash = try {
                    java.security.MessageDigest.getInstance("SHA-256")
                        .digest(noteFile.readBytes())
                        .joinToString("") { "%02x".format(it) }
                } catch (_: Exception) { null }
                if (hash == entry.contentHashAtCommit) return@filter false
            }
            // Skip committed notes not on current branch
            if (entry.commitHash != null && currentBranch != null) {
                val onBranch = gitOps?.exec("merge-base", "--is-ancestor", entry.commitHash, "HEAD")
                if (onBranch == null) return@filter false
            }
            // Skip uncommitted notes whose source file was deleted
            if (entry.commitHash == null && entry.sourcePath != null && !File(entry.sourcePath).exists()) {
                return@filter false
            }
            true
        }
    }

    private fun showInitializing() {
        removeAll()
        emptyLabel.text = "<html><center>Initializing Jolli Memory...</center></html>"
        add(emptyLabel, BorderLayout.CENTER)
        revalidate(); repaint()
    }

    private fun showDisabled() {
        removeAll()
        emptyLabel.text = "Jolli Memory is disabled."
        add(emptyLabel, BorderLayout.CENTER)
        revalidate(); repaint()
    }

    private fun updateList(items: List<ListItem>) {
        removeAll()

        if (items.isEmpty()) {
            emptyLabel.text = "<html><center>No plans or notes yet.<br/><br/>Plans appear when Claude Code creates plan files.<br/>Notes can be added with the + button.</center></html>"
            add(emptyLabel, BorderLayout.CENTER)
        } else {
            listModel.clear()
            items.forEach { listModel.addElement(it) }
            add(JBScrollPane(itemList), BorderLayout.CENTER)
        }

        revalidate(); repaint()
    }

    override fun dispose() {
        service.removeStatusListener(statusListener)
    }

    private fun openPlan(plan: PlanEntry) {
        val candidates = listOf(
            File(plan.sourcePath),
            File(System.getProperty("user.home"), ".claude/plans/${plan.slug}.md"),
            File(service.mainRepoRoot ?: "", ".jolli/jollimemory/plans/${plan.slug}.md"),
        )
        val file = candidates.firstOrNull { it.exists() }
        if (file != null) {
            val vf = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(file)
            if (vf != null) {
                FileEditorManager.getInstance(project).openFile(vf, true)
                return
            }
        }
        JOptionPane.showMessageDialog(this, "Plan file not found: ${plan.slug}.md", "Plan", JOptionPane.WARNING_MESSAGE)
    }

    private fun openNote(note: NoteEntry) {
        // Notes are stored in .jolli/jollimemory/notes/<id>.md
        val cwd = service.mainRepoRoot ?: project.basePath ?: ""
        val candidates = listOfNotNull(
            note.sourcePath?.let { File(it) },
            File(SessionTracker.getNotesDir(cwd), "${note.id}.md"),
        )
        val file = candidates.firstOrNull { it.exists() }
        if (file != null) {
            val vf = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(file)
            if (vf != null) {
                FileEditorManager.getInstance(project).openFile(vf, true)
                return
            }
        }
        JOptionPane.showMessageDialog(this, "Note file not found: ${note.id}", "Note", JOptionPane.WARNING_MESSAGE)
    }

    /**
     * Unified cell renderer for both plans and notes.
     * Icons match VS Code:
     * - Plan (uncommitted): file-text icon
     * - Plan (committed): lock (green) icon
     * - Note markdown (uncommitted): note icon
     * - Note snippet (uncommitted): comment icon
     * - Note (committed): lock (green) icon
     */
    private class PlansAndNotesCellRenderer : ListCellRenderer<ListItem> {
        private val panel = JPanel(BorderLayout()).apply { border = JBUI.Borders.empty(4, 8) }
        private val iconLabel = JLabel()
        private val titleLabel = JLabel()
        private val metaLabel = JLabel()
        private val trashLabel = JLabel(JolliMemoryIcons.Trash).apply {
            toolTipText = "Remove"
            border = JBUI.Borders.emptyLeft(6)
            cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
        }

        /** Returns the width of the trash icon click zone (icon 16px + left border 6px + panel right padding 8px). */
        fun getTrashIconWidth(): Int = 30

        override fun getListCellRendererComponent(
            list: JList<out ListItem>, value: ListItem, index: Int,
            isSelected: Boolean, cellHasFocus: Boolean,
        ): Component {
            when (value) {
                is ListItem.PlanItem -> renderPlan(value.plan, list, isSelected)
                is ListItem.NoteItem -> renderNote(value.note, list, isSelected)
            }

            panel.removeAll()
            panel.add(iconLabel, BorderLayout.WEST)
            val center = JPanel(BorderLayout()).apply {
                isOpaque = false
                add(titleLabel, BorderLayout.WEST)
                add(metaLabel, BorderLayout.CENTER)
            }
            panel.add(center, BorderLayout.CENTER)
            panel.add(trashLabel, BorderLayout.EAST)
            panel.background = if (isSelected) list.selectionBackground else list.background

            return panel
        }

        private fun renderPlan(plan: PlanEntry, list: JList<*>, isSelected: Boolean) {
            iconLabel.icon = if (plan.commitHash != null) JolliMemoryIcons.Lock else JolliMemoryIcons.FileText

            // Match VS Code: "shortHash · title" for committed, plain title for uncommitted
            val displayTitle = if (plan.commitHash != null) {
                "${plan.commitHash.take(8)} \u00b7 ${plan.title.ifBlank { plan.slug }}"
            } else {
                plan.title.ifBlank { plan.slug }
            }
            titleLabel.text = displayTitle
            titleLabel.font = list.font
            titleLabel.foreground = if (isSelected) list.selectionForeground else list.foreground

            val editStr = "${plan.editCount} edit${if (plan.editCount != 1) "s" else ""}"
            metaLabel.text = " $editStr"
            metaLabel.font = list.font
            metaLabel.foreground = Color.GRAY

            panel.toolTipText = "${plan.slug}.md\nBranch: ${plan.branch}\nUpdated: ${plan.updatedAt}"
        }

        private fun renderNote(note: NoteEntry, list: JList<*>, isSelected: Boolean) {
            // Match VS Code: lock for committed, comment for snippet, note for markdown
            iconLabel.icon = when {
                note.commitHash != null -> JolliMemoryIcons.Lock
                note.format == NoteFormat.snippet -> JolliMemoryIcons.Comment
                else -> JolliMemoryIcons.Note
            }

            // Match VS Code: "shortHash · title" for committed, plain title for uncommitted
            val displayTitle = if (note.commitHash != null) {
                "${note.commitHash.take(8)} \u00b7 ${note.title}"
            } else {
                note.title
            }
            titleLabel.text = displayTitle
            titleLabel.font = list.font
            titleLabel.foreground = if (isSelected) list.selectionForeground else list.foreground

            val formatStr = if (note.format == NoteFormat.snippet) "snippet" else "markdown"
            metaLabel.text = " $formatStr"
            metaLabel.font = list.font
            metaLabel.foreground = Color.GRAY

            panel.toolTipText = "${note.id}\nFormat: $formatStr\nBranch: ${note.branch}\nUpdated: ${note.updatedAt}"
        }
    }
}

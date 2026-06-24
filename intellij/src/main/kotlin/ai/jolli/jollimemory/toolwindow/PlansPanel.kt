package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.core.NoteEntry
import ai.jolli.jollimemory.core.NoteFormat
import ai.jolli.jollimemory.core.PlanEntry
import ai.jolli.jollimemory.core.CommitSelectionStore
import ai.jolli.jollimemory.core.PinStore
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.references.ReferenceEntry
import ai.jolli.jollimemory.core.references.ReferenceStore
import ai.jolli.jollimemory.core.references.SourceId
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.icons.AllIcons
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.Cursor
import java.awt.Desktop
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.io.File
import java.net.URI
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultListModel
import javax.swing.JCheckBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JMenuItem
import javax.swing.JOptionPane
import javax.swing.JPanel
import javax.swing.JPopupMenu
import javax.swing.JSeparator
import javax.swing.JWindow
import javax.swing.KeyStroke
import javax.swing.ListCellRenderer
import javax.swing.ListSelectionModel
import javax.swing.SwingConstants
import javax.swing.SwingUtilities
import javax.swing.Timer
import javax.swing.UIManager

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
        class ReferenceItem(val ref: ReferenceEntry, val mapKey: String) : ListItem(
            ref.title,
            ref.updatedAt,
        )
    }

    private val listModel = DefaultListModel<ListItem>()
    private val cellRenderer = PlansAndNotesCellRenderer()
    private val itemList = JBList(listModel).apply {
        cellRenderer = this@PlansPanel.cellRenderer
        selectionMode = ListSelectionModel.SINGLE_SELECTION
    }

    // ─── Sticky hover popup (JWindow, same pattern as CommitsPanel) ──────
    private var hoverPopup: JWindow? = null
    private var hoverIndex: Int = -1
    private var hoverShowTimer: Timer? = null
    private val hoverDismissTimer = Timer(HOVER_HIDE_GRACE_MS) { dismissHoverPopup() }.apply { isRepeats = false }

    private companion object {
        const val HOVER_SHOW_DELAY_MS = 1000
        const val HOVER_HIDE_GRACE_MS = 200

        // Context type-tag accent colors (mockup `kb-tag` parity).
        val TAG_PLAN = JBColor(0x4C82F7, 0x4C82F7)
        val TAG_NOTE = JBColor(0x3FA45B, 0x3FA45B)
        val TAG_SNIPPET = JBColor(0xC9851E, 0xD18616)
        val TAG_LINEAR = JBColor(0x7A6FF0, 0x8A7FF5)
        val TAG_GITHUB = JBColor(0x6E7681, 0x8B949E)
        val TAG_JIRA = JBColor(0x2A78C8, 0x3B82D6)
        val TAG_NOTION = JBColor(0x6B6B6B, 0x9B9B9B)
    }
    private val emptyLabel = JBLabel("No plans or notes yet.", SwingConstants.CENTER)
    private var excludedReferences: Set<String> = emptySet()
    private var excludedPlans: Set<String> = emptySet()
    private var excludedNotes: Set<String> = emptySet()

    /** Row index whose hover actions (pin/edit/delete) are currently shown. */
    private var actionHoverIndex: Int = -1

    private val statusListener: () -> Unit = { SwingUtilities.invokeLater { refresh() } }

    init {
        border = JBUI.Borders.empty(8)

        // Row interaction. Left→right zones: [checkbox] [tag] [title] … [pin][edit][delete].
        // The pin/edit/delete actions render only on the hovered row.
        itemList.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                val index = itemList.locationToIndex(e.point)
                if (index < 0) return
                val cellBounds = itemList.getCellBounds(index, index) ?: return
                val item = listModel.getElementAt(index)

                // Checkbox zone (left edge) — toggles include/exclude for any kind.
                if (e.clickCount == 1 && e.x - cellBounds.x < cellRenderer.getCheckboxWidth()) {
                    toggleExclusion(item)
                    return
                }

                // Action zone (right edge): pin | edit | delete (left→right).
                val offsetFromRight = (cellBounds.x + cellBounds.width) - e.x
                if (e.clickCount == 1 && offsetFromRight in 0..cellRenderer.getActionsWidth()) {
                    val slot = cellRenderer.getActionSlotWidth()
                    when {
                        offsetFromRight <= slot -> { itemList.selectedIndex = index; removeSelectedItem() } // delete
                        offsetFromRight <= slot * 2 -> openItem(item) // edit
                        else -> pinItem(item) // pin
                    }
                    return
                }

                if (e.clickCount == 2) openItem(item)
            }
        })

        // Hover: reveal the action icons on the hovered row + hand cursor over click zones.
        itemList.addMouseMotionListener(object : MouseAdapter() {
            override fun mouseMoved(e: MouseEvent) {
                val index = itemList.locationToIndex(e.point)
                val cellBounds = if (index >= 0) itemList.getCellBounds(index, index) else null
                if (cellBounds != null && cellBounds.contains(e.point)) {
                    if (index != actionHoverIndex) {
                        val old = actionHoverIndex
                        actionHoverIndex = index
                        repaintRow(old)
                        repaintRow(index)
                    }
                    val offsetFromRight = (cellBounds.x + cellBounds.width) - e.x
                    val overActions = offsetFromRight in 0..cellRenderer.getActionsWidth()
                    val overCheckbox = e.x - cellBounds.x < cellRenderer.getCheckboxWidth()
                    itemList.cursor = if (overActions || overCheckbox) {
                        Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                    } else {
                        Cursor.getDefaultCursor()
                    }
                    if (index != hoverIndex || hoverPopup?.isVisible != true) {
                        scheduleShowHoverPopup(index)
                    }
                    return
                }
                itemList.cursor = Cursor.getDefaultCursor()
                clearActionHover()
                scheduleHoverDismiss()
            }
        })

        // Dismiss hover popup + action icons when mouse leaves the list
        itemList.addMouseListener(object : MouseAdapter() {
            override fun mouseExited(e: MouseEvent) {
                clearActionHover()
                scheduleHoverDismiss()
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
                val selected = itemList.selectedValue ?: return
                val popup = JPopupMenu()

                if (selected is ListItem.ReferenceItem) {
                    val previewItem = JMenuItem("Preview", JolliMemoryIcons.Eye)
                    previewItem.addActionListener { openReference(selected.ref) }
                    popup.add(previewItem)

                    if (selected.ref.url.isNotBlank()) {
                        val openItem = JMenuItem("Open in Browser", JolliMemoryIcons.Globe)
                        openItem.addActionListener { openReferenceInBrowser(selected.ref.url) }
                        popup.add(openItem)
                    }

                    popup.add(JSeparator())
                }

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
            is ListItem.ReferenceItem -> "reference" to selected.ref.title
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
                is ListItem.ReferenceItem -> doRemoveReference(selected.mapKey, selected.ref.sourcePath, cwd)
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

    /** Removes a reference from plans.json and deletes the backing markdown file. */
    private fun doRemoveReference(mapKey: String, sourcePath: String?, cwd: String) {
        val registry = SessionTracker.loadPlansRegistry(cwd)
        val refs = (registry.references ?: emptyMap()).toMutableMap()
        if (!refs.containsKey(mapKey)) return
        refs.remove(mapKey)
        SessionTracker.savePlansRegistry(registry.copy(references = refs.takeIf { it.isNotEmpty() }), cwd)

        // Best-effort delete the backing markdown file
        if (sourcePath != null) {
            try {
                val file = File(sourcePath)
                if (file.exists()) file.delete()
            } catch (_: Exception) { /* best effort */ }
        }
    }

    private fun openReference(ref: ReferenceEntry) {
        val sourcePath = ref.sourcePath ?: return
        val file = File(sourcePath)
        if (!file.exists()) {
            JOptionPane.showMessageDialog(this, "Reference file not found: $sourcePath", "Reference", JOptionPane.WARNING_MESSAGE)
            return
        }
        val vf = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(file)
        if (vf != null) {
            FileEditorManager.getInstance(project).openFile(vf, true)
        }
    }

    /** (kind, key) used by CommitSelectionStore / PinStore for a given list item. */
    private fun kindKeyOf(item: ListItem): Pair<String, String> = when (item) {
        is ListItem.PlanItem -> "plans" to item.plan.slug
        is ListItem.NoteItem -> "notes" to item.note.id
        is ListItem.ReferenceItem -> "references" to item.mapKey
    }

    private fun isExcluded(item: ListItem): Boolean {
        val (kind, key) = kindKeyOf(item)
        return when (kind) {
            "plans" -> key in excludedPlans
            "notes" -> key in excludedNotes
            else -> key in excludedReferences
        }
    }

    /** Toggles include/exclude for any item kind (checkbox click). */
    private fun toggleExclusion(item: ListItem) {
        val (kind, key) = kindKeyOf(item)
        val nowExcluded = !isExcluded(item)
        val cwd = service.mainRepoRoot ?: project.basePath ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            CommitSelectionStore.setExcluded(cwd, kind, key, nowExcluded)
            val ex = CommitSelectionStore.readExclusions(cwd)
            excludedReferences = ex.references
            excludedPlans = ex.plans
            excludedNotes = ex.notes
            SwingUtilities.invokeLater { itemList.repaint() }
        }
    }

    /** Pins an item so it appears in the Pinned section (pin hover action). */
    private fun pinItem(item: ListItem) {
        val (kind, key) = kindKeyOf(item)
        val title = when (item) {
            is ListItem.PlanItem -> item.plan.title.ifBlank { item.plan.slug }
            is ListItem.NoteItem -> item.note.title
            is ListItem.ReferenceItem -> when (item.ref.source) {
                SourceId.notion -> item.ref.title
                else -> "${item.ref.nativeId} — ${item.ref.title}"
            }
        }
        // Same letter tag the Context row shows, so the Pinned row mirrors the icon.
        val badge = when (item) {
            is ListItem.PlanItem -> "P"
            is ListItem.NoteItem -> if (item.note.format == NoteFormat.snippet) "S" else "N"
            is ListItem.ReferenceItem -> when (item.ref.source) {
                SourceId.linear -> "L"
                SourceId.github -> "GH"
                SourceId.jira -> "J"
                SourceId.notion -> "No"
            }
        }
        val cwd = service.mainRepoRoot ?: project.basePath ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            PinStore.pin(cwd, kind, key, title, badge)
            SwingUtilities.invokeLater { service.panelRegistry?.pinnedPanel?.refresh() }
        }
    }

    /** Opens an item in its editor / detail view (edit hover action, double-click). */
    private fun openItem(item: ListItem) {
        when (item) {
            is ListItem.PlanItem -> openPlan(item.plan)
            is ListItem.NoteItem -> openNote(item.note)
            is ListItem.ReferenceItem -> openReference(item.ref)
        }
    }

    private fun repaintRow(index: Int) {
        if (index < 0) return
        itemList.getCellBounds(index, index)?.let { itemList.repaint(it) }
    }

    private fun clearActionHover() {
        if (actionHoverIndex != -1) {
            val old = actionHoverIndex
            actionHoverIndex = -1
            repaintRow(old)
        }
    }

    private fun openReferenceInBrowser(url: String) {
        try {
            val uri = URI(url)
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") {
                JOptionPane.showMessageDialog(this, "Only http(s) URLs can be opened.", "Invalid URL", JOptionPane.WARNING_MESSAGE)
                return
            }
            Desktop.getDesktop().browse(uri)
        } catch (ex: Exception) {
            JOptionPane.showMessageDialog(this, "Could not open URL: ${ex.message}", "Error", JOptionPane.ERROR_MESSAGE)
        }
    }

    private fun refreshFromDisk() {
        val status = service.getStatus()
        if (status == null) {
            SwingUtilities.invokeLater { showInitializing() }
            return
        }
        if (!status.enabled) {
            SwingUtilities.invokeLater { showInitializing() }
            return
        }

        val items = try {
            val cwd = service.mainRepoRoot ?: project.basePath ?: ""
            val gitOps = service.getGitOps()
            val currentBranch = gitOps?.getCurrentBranch()
            val registry = SessionTracker.loadPlansRegistry(cwd)

            val ex = CommitSelectionStore.readExclusions(cwd)
            excludedReferences = ex.references
            excludedPlans = ex.plans
            excludedNotes = ex.notes

            val planItems = filterPlans(registry.plans, gitOps, currentBranch)
                .map { ListItem.PlanItem(it) }
            val noteItems = filterNotes(registry.notes ?: emptyMap(), gitOps, currentBranch)
                .map { ListItem.NoteItem(it) }
            val refItems = (registry.references ?: emptyMap()).map { (mapKey, entry) ->
                ListItem.ReferenceItem(entry, mapKey)
            }

            // Merge and sort by lastModified descending (newest first), matching VS Code
            (planItems + noteItems + refItems).sortedByDescending { it.lastModified }
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
            // Skip entries from other branches
            if (currentBranch != null && entry.branch != null && entry.branch != currentBranch) return@filter false
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
            // Skip entries from other branches
            if (currentBranch != null && entry.branch != null && entry.branch != currentBranch) return@filter false
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


    private fun updateList(items: List<ListItem>) {
        removeAll()

        if (items.isEmpty()) {
            emptyLabel.text = "<html><center>No plans or notes yet.<br/><br/>Plans appear when Claude Code creates plan files.<br/>Notes can be added with the + button.</center></html>"
            add(emptyLabel, BorderLayout.CENTER)
        } else {
            listModel.clear()
            items.forEach { listModel.addElement(it) }
            val scrollPane = JBScrollPane(itemList).apply {
                horizontalScrollBarPolicy = JBScrollPane.HORIZONTAL_SCROLLBAR_NEVER
            }
            add(scrollPane, BorderLayout.CENTER)
        }

        revalidate(); repaint()
    }

    /** Toggles all reference checkboxes: if any excluded → select all, otherwise → deselect all. */
    fun toggleSelectAll() {
        val refItems = (0 until listModel.size())
            .map { listModel.getElementAt(it) }
            .filterIsInstance<ListItem.ReferenceItem>()
        if (refItems.isEmpty()) return

        val anyExcluded = refItems.any { it.mapKey in excludedReferences }
        val select = anyExcluded // if any excluded, select all; otherwise deselect all

        val cwd = service.mainRepoRoot ?: project.basePath ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            for (item in refItems) {
                CommitSelectionStore.setExcluded(cwd, "references", item.mapKey, !select)
            }
            excludedReferences = CommitSelectionStore.readExclusions(cwd).references
            SwingUtilities.invokeLater { itemList.repaint() }
        }
    }

    // ─── Hover popup logic (mirrors CommitsPanel) ─────────────────────────

    private fun scheduleShowHoverPopup(index: Int) {
        hoverDismissTimer.stop()
        if (hoverIndex == index && hoverPopup?.isVisible == true) return
        hoverShowTimer?.stop()
        hoverShowTimer = Timer(HOVER_SHOW_DELAY_MS) { showHoverPopup(index) }.apply {
            isRepeats = false
            start()
        }
    }

    private fun showHoverPopup(index: Int) {
        hoverShowTimer?.stop()
        dismissHoverPopup()

        if (index < 0 || index >= listModel.size()) return
        val item = listModel.getElementAt(index)
        val window = SwingUtilities.getWindowAncestor(itemList) ?: return
        val popup = JWindow(window)

        val bg = UIManager.getColor("ToolTip.background") ?: background
        val fg = UIManager.getColor("ToolTip.foreground") ?: foreground
        val dimFg = UIManager.getColor("Component.infoForeground") ?: Color.GRAY
        val borderColor = UIManager.getColor("ToolTip.borderColor") ?: Color.GRAY

        val content = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            background = bg
            border = JBUI.Borders.empty(8, 10)
        }

        when (item) {
            is ListItem.PlanItem -> buildPlanPopupContent(content, item.plan, fg, dimFg)
            is ListItem.NoteItem -> buildNotePopupContent(content, item.note, fg, dimFg)
            is ListItem.ReferenceItem -> buildReferencePopupContent(content, item.ref, fg, dimFg)
        }

        popup.contentPane = JPanel(BorderLayout()).apply {
            background = bg
            border = javax.swing.BorderFactory.createLineBorder(borderColor)
            add(content, BorderLayout.CENTER)
        }
        popup.pack()

        // Position below the hovered cell
        val cellBounds = itemList.getCellBounds(index, index)
        if (cellBounds != null) {
            val listLoc = itemList.locationOnScreen
            popup.setLocation(listLoc.x + cellBounds.x, listLoc.y + cellBounds.y + cellBounds.height + 2)
        }

        val popupHoverListener = object : MouseAdapter() {
            override fun mouseEntered(e: MouseEvent) { hoverDismissTimer.stop() }
            override fun mouseExited(e: MouseEvent) { scheduleHoverDismiss() }
        }
        popup.addMouseListener(popupHoverListener)
        content.addMouseListener(popupHoverListener)

        hoverPopup = popup
        hoverIndex = index
        popup.isVisible = true
    }

    private fun buildPlanPopupContent(content: JPanel, plan: PlanEntry, fg: Color, dimFg: Color) {
        content.add(JBLabel(plan.title.ifBlank { plan.slug }).apply {
            foreground = fg; font = font.deriveFont(java.awt.Font.BOLD); alignmentX = Component.LEFT_ALIGNMENT
        })
        content.add(Box.createVerticalStrut(JBUI.scale(4)))
        content.add(JBLabel("${plan.slug}.md").apply {
            foreground = dimFg; alignmentX = Component.LEFT_ALIGNMENT
        })
        if (plan.branch != null) {
            content.add(Box.createVerticalStrut(JBUI.scale(2)))
            content.add(JBLabel("Branch: ${plan.branch}").apply {
                foreground = dimFg; alignmentX = Component.LEFT_ALIGNMENT
            })
        }
        content.add(Box.createVerticalStrut(JBUI.scale(2)))
        content.add(JBLabel("${plan.editCount} edit${if (plan.editCount != 1) "s" else ""}").apply {
            foreground = dimFg; alignmentX = Component.LEFT_ALIGNMENT
        })
    }

    private fun buildNotePopupContent(content: JPanel, note: NoteEntry, fg: Color, dimFg: Color) {
        content.add(JBLabel(note.title).apply {
            foreground = fg; font = font.deriveFont(java.awt.Font.BOLD); alignmentX = Component.LEFT_ALIGNMENT
        })
        content.add(Box.createVerticalStrut(JBUI.scale(4)))
        val formatStr = if (note.format == NoteFormat.snippet) "snippet" else "markdown"
        content.add(JBLabel("Format: $formatStr").apply {
            foreground = dimFg; alignmentX = Component.LEFT_ALIGNMENT
        })
        if (note.branch != null) {
            content.add(Box.createVerticalStrut(JBUI.scale(2)))
            content.add(JBLabel("Branch: ${note.branch}").apply {
                foreground = dimFg; alignmentX = Component.LEFT_ALIGNMENT
            })
        }
    }

    private fun buildReferencePopupContent(content: JPanel, ref: ReferenceEntry, fg: Color, dimFg: Color) {
        val sourceLabel = when (ref.source) {
            SourceId.linear -> "Linear"
            SourceId.jira -> "Jira"
            SourceId.github -> "GitHub"
            SourceId.notion -> "Notion"
        }

        // Title
        content.add(JBLabel("${ref.nativeId} \u2014 ${ref.title}").apply {
            foreground = fg; font = font.deriveFont(java.awt.Font.BOLD); alignmentX = Component.LEFT_ALIGNMENT
        })

        // Fields from the backing markdown file
        if (ref.sourcePath != null) {
            val parsed = ReferenceStore.readReferenceMarkdown(ref.sourcePath)
            if (parsed?.fields != null && parsed.fields.isNotEmpty()) {
                content.add(Box.createVerticalStrut(JBUI.scale(4)))
                content.add(JSeparator().apply { alignmentX = Component.LEFT_ALIGNMENT; maximumSize = Dimension(Int.MAX_VALUE, 1) })
                content.add(Box.createVerticalStrut(JBUI.scale(4)))
                for (f in parsed.fields) {
                    content.add(JBLabel("${f.label}: ${f.value}").apply {
                        foreground = fg; alignmentX = Component.LEFT_ALIGNMENT
                    })
                    content.add(Box.createVerticalStrut(JBUI.scale(2)))
                }
            }
        }

        // "Open in <Source>" link
        if (ref.url.isNotBlank()) {
            content.add(Box.createVerticalStrut(JBUI.scale(4)))
            content.add(JSeparator().apply { alignmentX = Component.LEFT_ALIGNMENT; maximumSize = Dimension(Int.MAX_VALUE, 1) })
            content.add(Box.createVerticalStrut(JBUI.scale(4)))
            val linkColor = JBUI.CurrentTheme.Link.Foreground.ENABLED
            val url = ref.url
            content.add(JBLabel("Open in $sourceLabel").apply {
                foreground = linkColor
                cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                alignmentX = Component.LEFT_ALIGNMENT
                addMouseListener(object : MouseAdapter() {
                    override fun mouseClicked(e: MouseEvent) {
                        dismissHoverPopup()
                        openReferenceInBrowser(url)
                    }
                    override fun mouseEntered(e: MouseEvent) { hoverDismissTimer.stop() }
                    override fun mouseExited(e: MouseEvent) { scheduleHoverDismiss() }
                })
            })
        }
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
        hoverIndex = -1
    }

    override fun dispose() {
        dismissHoverPopup()
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
    private inner class PlansAndNotesCellRenderer : ListCellRenderer<ListItem> {
        private val panel = JPanel(BorderLayout()).apply { border = JBUI.Borders.empty(3, 8) }
        private val checkBox = JCheckBox().apply { isOpaque = false }
        private val tagLabel = TagLabel()
        private val titleLabel = JLabel()
        private val pinLabel = actionIcon(AllIcons.Nodes.Favorite, "Pin")
        private val editLabel = actionIcon(AllIcons.Actions.Edit, "Edit")
        private val trashLabel = actionIcon(JolliMemoryIcons.Trash, "Delete")

        /** Checkbox click zone (checkbox ~20px + left padding 8px). */
        fun getCheckboxWidth(): Int = JBUI.scale(28)

        /** Width of one hover-action slot (icon + gap). */
        fun getActionSlotWidth(): Int = JBUI.scale(24)

        /** Total width of the pin/edit/delete action strip on the right. */
        fun getActionsWidth(): Int = getActionSlotWidth() * 3

        private fun actionIcon(icon: javax.swing.Icon, tip: String): JLabel = JLabel(icon).apply {
            toolTipText = tip
            border = JBUI.Borders.empty(0, 3)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        }

        override fun getListCellRendererComponent(
            list: JList<out ListItem>, value: ListItem, index: Int,
            isSelected: Boolean, cellHasFocus: Boolean,
        ): Component {
            // Column layout (mockup parity): [checkbox] [type tag] [title] …hover[pin][edit][delete]
            val (letter, color) = tagFor(value)
            checkBox.isSelected = !isExcluded(value)
            tagLabel.setBadge(letter, color)
            titleLabel.text = titleFor(value)
            titleLabel.font = list.font
            titleLabel.foreground = if (isSelected) list.selectionForeground else list.foreground

            panel.removeAll()

            val left = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(2), 0)).apply {
                isOpaque = false
                add(checkBox)
                add(tagLabel)
            }
            panel.add(left, BorderLayout.WEST)
            // Min size 0 so BorderLayout.CENTER can shrink the title and it ellipsizes ("…").
            titleLabel.minimumSize = Dimension(0, 0)
            panel.add(titleLabel, BorderLayout.CENTER)

            // Action icons appear only on the hovered row, anchored to the right edge.
            if (index == actionHoverIndex) {
                val actions = JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply {
                    isOpaque = false
                    add(pinLabel)
                    add(editLabel)
                    add(trashLabel)
                }
                panel.add(actions, BorderLayout.EAST)
            }

            panel.background = if (isSelected) list.selectionBackground else list.background

            // Pin the cell to the list's visible width so a long title truncates with "…"
            // instead of widening the cell and pushing the hover icons past the window edge.
            panel.preferredSize = null
            val listWidth = list.width
            if (listWidth > 0) {
                panel.preferredSize = Dimension(listWidth, panel.preferredSize.height)
            }
            return panel
        }

        /** Single/double-letter type tag + accent color (mockup `kb-tag` parity). */
        private fun tagFor(item: ListItem): Pair<String, Color> = when (item) {
            is ListItem.PlanItem -> "P" to TAG_PLAN
            is ListItem.NoteItem ->
                if (item.note.format == NoteFormat.snippet) "S" to TAG_SNIPPET else "N" to TAG_NOTE
            is ListItem.ReferenceItem -> when (item.ref.source) {
                SourceId.linear -> "L" to TAG_LINEAR
                SourceId.github -> "GH" to TAG_GITHUB
                SourceId.jira -> "J" to TAG_JIRA
                SourceId.notion -> "No" to TAG_NOTION
            }
        }

        private fun titleFor(item: ListItem): String = when (item) {
            is ListItem.PlanItem -> {
                val t = item.plan.title.ifBlank { item.plan.slug }
                if (item.plan.commitHash != null) "${item.plan.commitHash.take(8)} · $t" else t
            }
            is ListItem.NoteItem ->
                if (item.note.commitHash != null) {
                    "${item.note.commitHash.take(8)} · ${item.note.title}"
                } else {
                    item.note.title
                }
            is ListItem.ReferenceItem -> when (item.ref.source) {
                SourceId.notion -> item.ref.title
                else -> "${item.ref.nativeId} — ${item.ref.title}"
            }
        }
    }

    /** A small rounded badge painting a 1–2 letter context-type tag (mockup `kb-tag`). */
    private inner class TagLabel : JLabel("", SwingConstants.CENTER) {
        private var badgeColor: Color = JBColor.GRAY

        init {
            isOpaque = false
            foreground = Color.WHITE
            font = JBUI.Fonts.label(9f).deriveFont(Font.BOLD)
        }

        fun setBadge(text: String, color: Color) {
            this.text = text
            this.badgeColor = color
        }

        override fun getPreferredSize(): Dimension =
            Dimension(JBUI.scale(if (text.length > 1) 24 else 18), JBUI.scale(16))

        override fun paintComponent(g: Graphics) {
            val g2 = g.create() as Graphics2D
            try {
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                g2.color = badgeColor
                val arc = JBUI.scale(6)
                g2.fillRoundRect(0, 0, width - 1, height - 1, arc, arc)
            } finally {
                g2.dispose()
            }
            super.paintComponent(g)
        }
    }
}

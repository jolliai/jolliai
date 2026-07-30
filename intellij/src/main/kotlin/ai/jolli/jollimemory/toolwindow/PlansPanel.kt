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
import ai.jolli.jollimemory.core.references.SourceDisplay
import ai.jolli.jollimemory.core.references.SourceId
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.icons.AllIcons
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
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
import java.awt.Rectangle
import java.awt.RenderingHints
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.awt.font.TextAttribute
import java.io.File
import java.net.URI
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JTextArea
import javax.swing.JMenuItem
import javax.swing.JOptionPane
import javax.swing.JPanel
import javax.swing.JPopupMenu
import javax.swing.JSeparator
import javax.swing.JWindow
import javax.swing.SwingConstants
import javax.swing.SwingUtilities
import javax.swing.Timer
import javax.swing.UIManager

/**
 * Plans & Notes panel ("CONTEXT") — shows Claude Code plan files, user notes and
 * references. Merges them into a single list sorted by lastModified (newest first).
 *
 * Rows are individual [JPanel]s (one per item), mirroring [ConversationRowComponent]
 * and the Files panel: each row word-wraps its title and grows taller as the window
 * narrows, with a hover highlight bar, hand cursor and per-row hover actions. (This
 * replaced an earlier JBList, whose cached cell heights made wrapping/auto-height
 * unreliable on resize.)
 */
class PlansPanel(
    private val project: Project,
    private val service: JolliMemoryService,
) : JPanel(BorderLayout()), Disposable, RowCountSource {

    override var onRowCountChanged: ((Int) -> Unit)? = null
    override fun currentRowCount(): Int = allContextItems.size

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

    // ─── Sticky hover popup (JWindow, same pattern as CommitsPanel) ──────
    private var hoverPopup: JWindow? = null
    private var hoverAnchor: Component? = null
    private var hoverShowTimer: Timer? = null
    private val hoverDismissTimer = Timer(HOVER_HIDE_GRACE_MS) { dismissHoverPopup() }.apply { isRepeats = false }

    private companion object {
        const val HOVER_SHOW_DELAY_MS = 1000
        const val HOVER_HIDE_GRACE_MS = 200

        // Context type-tag accent colors for the three kinds authored *here*
        // (plans, notes, snippets); reference colors come from SourceDisplay so
        // there is one table for all sources.
        val TAG_PLAN = JBColor(0x4C82F7, 0x4C82F7)
        val TAG_NOTE = JBColor(0x3FA45B, 0x3FA45B)
        val TAG_SNIPPET = JBColor(0xC9851E, 0xD18616)
    }
    private val emptyLabel = JBLabel("No plans or notes yet.", SwingConstants.CENTER)
    private var excludedReferences: Set<String> = emptySet()
    private var excludedPlans: Set<String> = emptySet()
    private var excludedNotes: Set<String> = emptySet()

    /** Full item list + expand state for the 6-row cap ("Show N more"). */
    private var allContextItems: List<ListItem> = emptyList()
    private var contextExpanded = false
    private val rowsPanel = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
        isOpaque = false
    }

    private val statusListener: () -> Unit = { SwingUtilities.invokeLater { refresh() } }

    init {
        // Match PINNED's container insets (empty(2,4)) so all sections share the same
        // first-row/last-row edge gaps. Each row adds empty(2,4) → 4px edge, 8px sides.
        border = JBUI.Borders.empty(2, 4)
        service.addStatusListener(statusListener)
        ApplicationManager.getApplication().executeOnPooledThread { refreshFromDisk() }
    }

    fun refresh() {
        ApplicationManager.getApplication().executeOnPooledThread { refreshFromDisk() }
    }

    /**
     * Prompts the user to confirm removal of a plan / note / reference.
     * Plans are soft-deleted (ignored: true); notes/references are removed from
     * the registry (matching VS Code semantics).
     */
    private fun removeItem(selected: ListItem) {
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
        // Prepend a synthesised Markdown table of the frontmatter fields
        // (source / nativeId / title / url / referencedAt / sourceToolName /
        // adapter fields) — VSCode's `markdown.showPreview` renders YAML
        // frontmatter as a table automatically; IntelliJ's Markdown preview
        // treats it as metadata and hides it, so the user sees only the body
        // and loses the "when / what tool" context. The synthetic table gives
        // both surfaces the same top-of-preview info block.
        val decorated = try {
            buildReferencePreviewMarkdown(file.readText(Charsets.UTF_8))
        } catch (_: Exception) { null }
        val safeName = if (file.name.endsWith(".md")) file.name else "${file.name}.md"
        val vf = if (decorated != null) {
            com.intellij.testFramework.LightVirtualFile(safeName, decorated).apply { isWritable = false }
        } else {
            LocalFileSystem.getInstance().refreshAndFindFileByIoFile(file)
        }
        if (vf != null) {
            MarkdownPreview.open(project, vf)
        }
    }

    /**
     * Converts a reference `.md` file's YAML frontmatter into a leading Markdown
     * table, keeps the body intact underneath. Pipes and newlines inside cells
     * are escaped so the table remains well-formed even when a field value
     * contains one. Returns the original text unchanged when no closed
     * frontmatter block is present (defensive — should never happen for files
     * `ReferenceStore.writeReferenceMarkdown` produces).
     *
     * NOTE: this parser only handles the flat key-value + `fields:` list subset
     * that `ReferenceStore.writeReferenceMarkdown` emits — it does NOT parse
     * arbitrary YAML (no multi-line values, no nested maps, no hyphenated keys).
     * The input is always machine-generated by this plugin, so this is safe.
     */
    private fun buildReferencePreviewMarkdown(raw: String): String {
        val lines = raw.split("\n")
        if (lines.firstOrNull()?.trim() != "---") return raw
        var closingIdx = -1
        for (i in 1 until lines.size) {
            if (lines[i].trim() == "---") { closingIdx = i; break }
        }
        if (closingIdx == -1) return raw
        val frontmatter = lines.subList(1, closingIdx)
        val body = lines.subList(closingIdx + 1, lines.size).joinToString("\n")

        val rows = mutableListOf<Pair<String, String>>()
        var inFieldsList = false
        for (line in frontmatter) {
            if (inFieldsList) {
                // Each entry looks like `  - {"key":"status","label":"Status","value":"Open"}`.
                val m = Regex("^\\s+- (.+)$").find(line)
                if (m != null) {
                    try {
                        val obj = com.google.gson.JsonParser.parseString(m.groupValues[1])
                        if (obj.isJsonObject) {
                            val o = obj.asJsonObject
                            val label = o.get("label")?.takeIf { it.isJsonPrimitive }?.asString
                            val value = o.get("value")?.takeIf { it.isJsonPrimitive }?.asString
                            if (label != null && value != null) rows.add(label to value)
                        }
                    } catch (_: Exception) { /* skip malformed */ }
                    continue
                }
                inFieldsList = false
            }
            if (line.trim() == "fields:") { inFieldsList = true; continue }
            val kv = Regex("^([a-zA-Z]+):\\s*(.+)$").find(line) ?: continue
            val key = kv.groupValues[1]
            val rawValue = kv.groupValues[2]
            // Frontmatter values are JSON-encoded strings; decode when possible so
            // the table shows the plain value (Recall) rather than the quoted
            // literal ("Recall").
            val value = try {
                val v = com.google.gson.JsonParser.parseString(rawValue)
                if (v.isJsonPrimitive && v.asJsonPrimitive.isString) v.asString else rawValue
            } catch (_: Exception) { rawValue }
            rows.add(key to value)
        }
        if (rows.isEmpty()) return raw

        fun escapeCell(s: String): String =
            s.replace("\\", "\\\\").replace("|", "\\|").replace("\n", " ").replace("\r", "")

        val sb = StringBuilder()
        sb.append("| Field | Value |\n")
        sb.append("|---|---|\n")
        for ((k, v) in rows) sb.append("| ").append(escapeCell(k)).append(" | ").append(escapeCell(v)).append(" |\n")
        sb.append("\n")
        sb.append(body.trimStart('\n'))
        return sb.toString()
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

    /** Toggles include/exclude for any item kind (select toggle click). */
    private fun toggleExclusion(item: ListItem) {
        val (kind, key) = kindKeyOf(item)
        val nowExcluded = !isExcluded(item)
        val cwd = service.mainRepoRoot ?: project.basePath ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            CommitSelectionStore.setExcluded(cwd, kind, key, nowExcluded)
            service.notifySelectionChanged()
            val ex = CommitSelectionStore.readExclusions(cwd)
            excludedReferences = ex.references
            excludedPlans = ex.plans
            excludedNotes = ex.notes
            SwingUtilities.invokeLater { renderList() }
        }
    }

    /** Pins an item so it appears in the Pinned section (pin hover action). */
    private fun pinItem(item: ListItem) {
        val (kind, key) = kindKeyOf(item)
        val title = when (item) {
            is ListItem.PlanItem -> item.plan.title.ifBlank { item.plan.slug }
            is ListItem.NoteItem -> item.note.title
            // Same title-composition rule the CONTEXT row uses.
            is ListItem.ReferenceItem -> SourceDisplay.displayTitle(
                item.ref.source, item.ref.nativeId, item.ref.title,
            )
        }
        // Same letter tag the Context row shows, so the Pinned row mirrors the icon.
        // Reference letter comes from the shared SourceDisplay table so PlansPanel
        // and PinnedPanel don't drift when a new source lands.
        val badge = when (item) {
            is ListItem.PlanItem -> "P"
            is ListItem.NoteItem -> if (item.note.format == NoteFormat.snippet) "S" else "N"
            is ListItem.ReferenceItem -> SourceDisplay.of(item.ref.source).tag
        }
        val cwd = service.mainRepoRoot ?: project.basePath ?: return
        ai.jolli.jollimemory.core.telemetry.Telemetry.track("memory_pinned", mapOf("kind" to kind))
        ApplicationManager.getApplication().executeOnPooledThread {
            PinStore.pin(cwd, kind, key, title, badge)
            SwingUtilities.invokeLater { service.panelRegistry?.pinnedPanel?.refresh() }
        }
    }

    /** Opens an item in its editor / detail view (edit hover action, row click). */
    private fun openItem(item: ListItem) {
        when (item) {
            is ListItem.PlanItem -> openPlan(item.plan)
            is ListItem.NoteItem -> openNote(item.note)
            is ListItem.ReferenceItem -> openReference(item.ref)
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
            SwingUtilities.invokeLater { showDisabled() }
            return
        }

        val items = try {
            val cwd = service.mainRepoRoot ?: project.basePath ?: ""
            val gitOps = service.getGitOps()
            val currentBranch = gitOps?.getCurrentBranch()
            // Plans enter the registry via the CLI's transcript discovery
            // pipeline, mirroring VS Code — so a plan appears in CONTEXT only when
            // the user actually created/edited it in a session, and is consumed on
            // commit. We no longer directory-scan ~/.claude/plans/.
            val registry = SessionTracker.loadPlansRegistry(cwd)

            val ex = CommitSelectionStore.readExclusions(cwd)
            excludedReferences = ex.references
            excludedPlans = ex.plans
            excludedNotes = ex.notes

            val planItems = filterPlans(registry.plans, gitOps, currentBranch)
                .map { ListItem.PlanItem(it) }
            val noteItems = filterNotes(registry.notes ?: emptyMap(), gitOps, currentBranch)
                .map { ListItem.NoteItem(it) }
            // No branch filter: uncommitted references follow the user across branches
            // (a commit deletes the row; there is no committed/guard state to filter).
            val refItems = (registry.references ?: emptyMap())
                .map { (mapKey, entry) -> ListItem.ReferenceItem(entry, mapKey) }

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
            // No branch filter: uncommitted working-area plans follow the user across
            // branches (matches CLI/VS Code). `branch` is stamped but not filtered on.
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
            // No branch filter: uncommitted working-area notes follow the user across
            // branches (matches CLI/VS Code). `branch` is stamped but not filtered on.
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

    /**
     * Shown when the service is initialized but hooks are not installed (or
     * were uninstalled / paused). Distinct from [showInitializing] so users
     * are not misled into thinking a background task is still running —
     * nothing will run until they enable it from the Status panel.
     */
    private fun showDisabled() {
        removeAll()
        emptyLabel.text = "<html><center>Jolli Memory is not enabled for this repository.<br/>" +
            "Open the Status panel to install hooks and enable it.</center></html>"
        add(emptyLabel, BorderLayout.CENTER)
        revalidate(); repaint()
    }

    private fun updateList(items: List<ListItem>) {
        allContextItems = items
        renderList()
    }

    /**
     * Renders the rows without an inner scrollbar, showing at most [CappedRows.CAP]
     * rows; the rest collapse behind a "Show N more" row below. Current Memory
     * provides a single scrollbar across all three sections.
     */
    private fun renderList() {
        onRowCountChanged?.invoke(allContextItems.size)
        removeAll()

        if (allContextItems.isEmpty()) {
            emptyLabel.text = "<html><center>No plans or notes yet.<br/><br/>Plans appear when Claude Code creates plan files.<br/>Notes can be added with the + button.</center></html>"
            add(emptyLabel, BorderLayout.NORTH)
            revalidate(); repaint()
            return
        }

        val collapsed = !contextExpanded && allContextItems.size > CappedRows.CAP
        val shown = if (collapsed) allContextItems.take(CappedRows.CAP) else allContextItems

        rowsPanel.removeAll()
        shown.forEach { rowsPanel.add(contextRow(it)) }
        if (collapsed) rowsPanel.add(showMoreRow(allContextItems.size - CappedRows.CAP))
        add(rowsPanel, BorderLayout.NORTH)

        revalidate(); repaint()
    }

    // ─── Row construction ─────────────────────────────────────────────────

    private fun rowActionIcon(icon: javax.swing.Icon, tip: String, onClick: () -> Unit): JLabel =
        JLabel(icon).apply {
            toolTipText = tip
            isVisible = false
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            border = JBUI.Borders.empty(0, 3)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    if (!SwingUtilities.isLeftMouseButton(e)) return
                    e.consume()
                    onClick()
                }
            })
        }

    /**
     * Builds one Context row: [tag] [wrapping title] …hover[pin][edit][toggle]. The
     * title wraps and the row grows on narrow windows; tag + actions stay vertically
     * centered. The action strip reserves width only while hovered, so short titles
     * stay on a single line by default.
     */
    private fun contextRow(item: ListItem): JPanel {
        val excluded = isExcluded(item)
        val (letter, color) = tagFor(item)
        val baseFont = JBUI.Fonts.label()
        val strikeFont = baseFont.deriveFont(mapOf(TextAttribute.STRIKETHROUGH to TextAttribute.STRIKETHROUGH_ON))

        val tag = TagLabel().apply { setBadge(letter, color) }
        val tagInner = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(2), 0)).apply {
            isOpaque = false
            add(tag)
        }
        val tagWrap = RowStyle.vCenter(tagInner)

        val title = JTextArea(titleFor(item)).apply {
            isEditable = false
            isFocusable = false
            isOpaque = false
            background = Color(0, 0, 0, 0)
            lineWrap = true
            wrapStyleWord = true
            margin = JBUI.insets(0)
            border = JBUI.Borders.empty()
            font = if (excluded) strikeFont else baseFont
            foreground = if (excluded) JBColor.GRAY else (UIManager.getColor("Label.foreground") ?: foreground)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        }

        val pin = rowActionIcon(AllIcons.General.Pin_tab, "Pin") { pinItem(item) }
        val edit = rowActionIcon(AllIcons.Actions.Edit, "Open") { openItem(item) }
        val toggle = rowActionIcon(
            if (excluded) AllIcons.General.Add else AllIcons.Actions.Close,
            if (excluded) "Include in next memory" else "Exclude from next memory",
        ) { toggleExclusion(item) }
        val icons = listOf(pin, edit, toggle)
        val iconsRow = JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply {
            isOpaque = false
            icons.forEach { add(it) }
        }
        // Measure the icons' width (while visible) to reserve on hover; hide by default.
        icons.forEach { it.isVisible = true }
        val reservedW = iconsRow.preferredSize.width
        icons.forEach { it.isVisible = false }
        // Reserve width only while hovered → short titles stay single-line by default.
        val rightWrap = RowStyle.vCenter(iconsRow).apply {
            preferredSize = Dimension(0, JBUI.scale(16))
        }

        val row = object : JPanel(BorderLayout(JBUI.scale(4), 0)) {
            override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)
            override fun getPreferredSize(): Dimension {
                val base = super.getPreferredSize()
                val w = width
                if (w <= 0) return base
                val ins = insets
                val titleW = (w - ins.left - ins.right - tagWrap.preferredSize.width - rightWrap.preferredSize.width)
                    .coerceAtLeast(JBUI.scale(20))
                title.setSize(titleW, Short.MAX_VALUE.toInt())
                val contentH = maxOf(title.preferredSize.height, tagWrap.preferredSize.height, JBUI.scale(18))
                return Dimension(w, contentH + ins.top + ins.bottom)
            }
            // Translucent hover tint: keep isOpaque=false so RepaintManager paints the
            // ancestor first, then overlay the tint on top (same pattern as CommitsPanel).
            override fun paintComponent(g: Graphics) {
                super.paintComponent(g)
                val bg = background ?: return
                val g2 = g.create() as Graphics2D
                try {
                    g2.color = bg
                    g2.fillRect(0, 0, width, height)
                } finally {
                    g2.dispose()
                }
            }
        }.apply {
            isOpaque = false
            border = JBUI.Borders.empty(2, 4)
            alignmentX = Component.LEFT_ALIGNMENT
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            add(tagWrap, BorderLayout.WEST)
            add(title, BorderLayout.CENTER)
            add(rightWrap, BorderLayout.EAST)
        }
        // Re-wrap (recompute height) when the row width changes (tool-window resize).
        row.addComponentListener(object : java.awt.event.ComponentAdapter() {
            override fun componentResized(e: java.awt.event.ComponentEvent) { row.revalidate() }
        })

        var rowHovered = false
        fun setHovered(hovered: Boolean) {
            if (rowHovered == hovered) return
            rowHovered = hovered
            row.background = if (hovered) RowStyle.HOVER_BG else null
            icons.forEach { it.isVisible = hovered }
            rightWrap.preferredSize = Dimension(if (hovered) reservedW else 0, JBUI.scale(16))
            row.revalidate()
            row.repaint()
            this@PlansPanel.revalidate()
        }

        val hover = object : MouseAdapter() {
            override fun mouseEntered(e: MouseEvent) {
                setHovered(true)
                scheduleShowHoverPopup(item, row)
            }
            override fun mouseExited(e: MouseEvent) {
                val src = e.source as? Component ?: return
                if (!src.isShowing || !row.isShowing) {
                    setHovered(false); scheduleHoverDismiss(); return
                }
                val screen = src.locationOnScreen.apply { translate(e.x, e.y) }
                val loc = row.locationOnScreen
                if (!Rectangle(loc.x, loc.y, row.width, row.height).contains(screen)) {
                    setHovered(false)
                    scheduleHoverDismiss()
                }
            }
        }
        val click = object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (SwingUtilities.isLeftMouseButton(e)) openItem(item)
            }
        }
        val contextMenu = object : MouseAdapter() {
            override fun mousePressed(e: MouseEvent) { maybeShowPopup(e) }
            override fun mouseReleased(e: MouseEvent) { maybeShowPopup(e) }
            private fun maybeShowPopup(e: MouseEvent) {
                if (e.isPopupTrigger) showRowContextMenu(item, e)
            }
        }
        for (c in listOf(row, tagWrap, tagInner, tag, title)) {
            c.addMouseListener(hover)
            c.addMouseListener(click)
            c.addMouseListener(contextMenu)
        }
        icons.forEach { it.addMouseListener(hover) }

        row.maximumSize = Dimension(Int.MAX_VALUE, row.preferredSize.height)
        return row
    }

    private fun showRowContextMenu(item: ListItem, e: MouseEvent) {
        val popup = JPopupMenu()
        if (item is ListItem.ReferenceItem) {
            popup.add(JMenuItem("Preview", JolliMemoryIcons.Eye).apply { addActionListener { openReference(item.ref) } })
            val refUrl = item.ref.url
            if (!refUrl.isNullOrBlank()) {
                popup.add(JMenuItem("Open in Browser", JolliMemoryIcons.Globe).apply {
                    addActionListener { openReferenceInBrowser(refUrl) }
                })
            }
            popup.add(JSeparator())
        }
        popup.add(JMenuItem("Remove", JolliMemoryIcons.Trash).apply { addActionListener { removeItem(item) } })
        popup.show(e.component, e.x, e.y)
    }

    /** Single/double-letter type tag + accent color (mockup `kb-tag` parity). */
    private fun tagFor(item: ListItem): Pair<String, Color> = when (item) {
        is ListItem.PlanItem -> "P" to TAG_PLAN
        is ListItem.NoteItem ->
            if (item.note.format == NoteFormat.snippet) "S" to TAG_SNIPPET else "N" to TAG_NOTE
        // Every source (known + unknown) resolves through the central SourceDisplay
        // table; a source the enum hasn't caught up with yet gets the neutral
        // Reference placeholder instead of crashing the row renderer.
        is ListItem.ReferenceItem -> SourceDisplay.of(item.ref.source).let { it.tag to it.color }
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
        // Only Linear/Jira/GitHub prepend the nativeId (issue keys users recognise);
        // every other source, jollimemory included, shows just the title — mirrors
        // VSCode's `referenceDisplayTitle` in `cli/src/core/references/ReferenceDisplay.ts`.
        is ListItem.ReferenceItem -> SourceDisplay.displayTitle(
            item.ref.source, item.ref.nativeId, item.ref.title,
        )
    }

    private fun showMoreRow(remaining: Int): JPanel {
        val link = JBLabel("Show $remaining more").apply {
            foreground = com.intellij.ui.JBColor.namedColor("Link.activeForeground", com.intellij.ui.JBColor.BLUE)
            cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
        }
        return JPanel(java.awt.FlowLayout(java.awt.FlowLayout.LEFT, JBUI.scale(2), 0)).apply {
            isOpaque = false
            alignmentX = Component.LEFT_ALIGNMENT
            border = JBUI.Borders.empty(2, 26, 2, 0)
            maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(22))
            add(link)
            cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
            val expand = object : java.awt.event.MouseAdapter() {
                override fun mouseClicked(e: java.awt.event.MouseEvent) {
                    contextExpanded = true
                    renderList()
                }
            }
            addMouseListener(expand)
            link.addMouseListener(expand)
        }
    }

    override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)

    /** Toggles all reference checkboxes: if any excluded → select all, otherwise → deselect all. */
    fun toggleSelectAll() {
        val refItems = allContextItems.filterIsInstance<ListItem.ReferenceItem>()
        if (refItems.isEmpty()) return

        val anyExcluded = refItems.any { it.mapKey in excludedReferences }
        val select = anyExcluded // if any excluded, select all; otherwise deselect all

        val cwd = service.mainRepoRoot ?: project.basePath ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            for (item in refItems) {
                CommitSelectionStore.setExcluded(cwd, "references", item.mapKey, !select)
            }
            service.notifySelectionChanged()
            excludedReferences = CommitSelectionStore.readExclusions(cwd).references
            SwingUtilities.invokeLater { renderList() }
        }
    }

    // ─── Hover popup logic (mirrors CommitsPanel) ─────────────────────────

    private fun scheduleShowHoverPopup(item: ListItem, anchor: Component) {
        hoverDismissTimer.stop()
        if (hoverAnchor === anchor && hoverPopup?.isVisible == true) return
        hoverShowTimer?.stop()
        hoverShowTimer = Timer(HOVER_SHOW_DELAY_MS) { showHoverPopup(item, anchor) }.apply {
            isRepeats = false
            start()
        }
    }

    private fun showHoverPopup(item: ListItem, anchor: Component) {
        hoverShowTimer?.stop()
        dismissHoverPopup()

        if (!anchor.isShowing) return
        val window = SwingUtilities.getWindowAncestor(anchor) ?: return
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

        // Position below the hovered row.
        val loc = anchor.locationOnScreen
        popup.setLocation(loc.x, loc.y + anchor.height + 2)

        val popupHoverListener = object : MouseAdapter() {
            override fun mouseEntered(e: MouseEvent) { hoverDismissTimer.stop() }
            override fun mouseExited(e: MouseEvent) { scheduleHoverDismiss() }
        }
        popup.addMouseListener(popupHoverListener)
        content.addMouseListener(popupHoverListener)

        hoverPopup = popup
        hoverAnchor = anchor
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
        val sourceLabel = SourceDisplay.of(ref.source).label

        // Title — plain title only. The row already shows `nativeId — title`, so
        // repeating that here would just duplicate the row (the popup would read
        // as "recall — Recall" both places). Popup adds metadata below.
        content.add(JBLabel(ref.title).apply {
            foreground = fg; font = font.deriveFont(java.awt.Font.BOLD); alignmentX = Component.LEFT_ALIGNMENT
        })
        content.add(Box.createVerticalStrut(JBUI.scale(4)))
        content.add(JBLabel("Source: $sourceLabel").apply {
            foreground = dimFg; alignmentX = Component.LEFT_ALIGNMENT
        })
        content.add(Box.createVerticalStrut(JBUI.scale(2)))
        content.add(JBLabel("Tool: ${ref.sourceToolName}").apply {
            foreground = dimFg; alignmentX = Component.LEFT_ALIGNMENT
        })
        if (ref.updatedAt.isNotBlank()) {
            content.add(Box.createVerticalStrut(JBUI.scale(2)))
            content.add(JBLabel("Updated: ${ref.updatedAt}").apply {
                foreground = dimFg; alignmentX = Component.LEFT_ALIGNMENT
            })
        }

        // Fields from the backing markdown file — separator + list. Skipped when
        // the file is missing (readReferenceMarkdown returns null) or the source
        // has no `fields` block (track-only sources like jollimemory).
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
        val refUrl = ref.url
        if (!refUrl.isNullOrBlank()) {
            content.add(Box.createVerticalStrut(JBUI.scale(4)))
            content.add(JSeparator().apply { alignmentX = Component.LEFT_ALIGNMENT; maximumSize = Dimension(Int.MAX_VALUE, 1) })
            content.add(Box.createVerticalStrut(JBUI.scale(4)))
            val linkColor = JBUI.CurrentTheme.Link.Foreground.ENABLED
            val url = refUrl
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
        hoverAnchor = null
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
                MarkdownPreview.open(project, vf)
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
                MarkdownPreview.open(project, vf)
                return
            }
        }
        JOptionPane.showMessageDialog(this, "Note file not found: ${note.id}", "Note", JOptionPane.WARNING_MESSAGE)
    }

}

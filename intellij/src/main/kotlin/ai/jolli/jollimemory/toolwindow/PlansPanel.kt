package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.core.NoteFormat
import ai.jolli.jollimemory.core.CommitSelectionStore
import ai.jolli.jollimemory.core.PinStore
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.SkillsProjection
import ai.jolli.jollimemory.core.WorkingContext
import ai.jolli.jollimemory.core.references.ReferenceEntry
import ai.jolli.jollimemory.core.references.ReferenceStore
import ai.jolli.jollimemory.core.references.SourceDisplay
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
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
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.awt.font.TextAttribute
import java.io.File
import java.net.URI
import java.util.Locale
import javax.swing.Box
import javax.swing.BoxLayout
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

    /**
     * Unified item wrapper for the merged plans+notes+references list.
     *
     * Plans and notes carry the CLI's display projections rather than raw
     * registry rows: which rows are visible at all is decided by
     * `PlanService.detectPlans` / `NoteService.detectNotes`, so this panel never
     * sees a hidden row and has no filter of its own.
     */
    private sealed class ListItem(val title: String, val lastModified: String) {
        class PlanItem(val plan: WorkingContext.PlanInfo) : ListItem(
            plan.title.ifBlank { plan.slug },
            plan.lastModified,
        )
        class NoteItem(val note: WorkingContext.NoteInfo) : ListItem(
            note.title,
            note.lastModified,
        )
        class ReferenceItem(val ref: ReferenceEntry, val mapKey: String) : ListItem(
            ref.title,
            ref.updatedAt,
        )

        /**
         * The aggregate row standing for EVERY skill captured this session — one row,
         * not one per skill, because a session routinely enters a dozen and this list
         * caps at six before collapsing. The per-skill figures are one click away in
         * the table the CLI renders.
         *
         * It carries no artifact id, which is what makes it different from the three
         * above: there is nothing to pin, edit or remove, and its checkbox writes
         * every captured skill's key at once. Sorted by the newest skill's timestamp
         * so it interleaves with the other kinds rather than pinning to an end.
         */
        class SkillsItem(val skills: SkillsProjection.ActiveSkills) : ListItem(
            "Skills used",
            skills.skills.maxOfOrNull { it.lastModified } ?: "",
        )
    }

    // ─── Sticky hover popup (JWindow, same pattern as CommitsPanel) ──────
    private var hoverPopup: JWindow? = null
    private var hoverAnchor: Component? = null
    private var hoverShowTimer: Timer? = null
    private val hoverDismissTimer = Timer(HOVER_HIDE_GRACE_MS) { dismissHoverPopup() }.apply { isRepeats = false }

    private companion object {
        val LOG: Logger = Logger.getInstance(PlansPanel::class.java)

        const val HOVER_SHOW_DELAY_MS = 1000
        const val HOVER_HIDE_GRACE_MS = 200

        /**
         * Skills named in the aggregate row's hover card before it collapses to "+N more".
         * Matches VS Code's `SKILLS_HOVER_ROW_CAP` so the same session does not show a
         * different number of rows in the two IDEs.
         */
        const val SKILLS_POPUP_CAP = 8

        // Context type-tag accent colors for the three kinds authored *here*
        // (plans, notes, snippets); reference colors come from SourceDisplay so
        // there is one table for all sources.
        val TAG_PLAN = JBColor(0x4C82F7, 0x4C82F7)
        val TAG_NOTE = JBColor(0x3FA45B, 0x3FA45B)
        val TAG_SNIPPET = JBColor(0xC9851E, 0xD18616)
        // Skill accent is NOT declared here: CommitsPanel paints the same badge for a
        // committed memory, so it lives in TagLabel.SKILL where both can reach it.
    }
    private val emptyLabel = JBLabel("No plans or notes yet.", SwingConstants.CENTER)
    private var excludedReferences: Set<String> = emptySet()
    private var excludedPlans: Set<String> = emptySet()
    private var excludedNotes: Set<String> = emptySet()
    private var excludedSkills: Set<String> = emptySet()

    /** Full item list + expand state for the 6-row cap ("Show N more"). */
    private var allContextItems: List<ListItem> = emptyList()
    private var contextExpanded = false
    private val rowsPanel = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
        isOpaque = false
    }

    private val statusListener: () -> Unit = { SwingUtilities.invokeLater { refresh() } }

    /**
     * Subscribed on BOTH channels on purpose: the status one because
     * [refreshFromDisk] gates on `status.enabled`, the working-context one because
     * a plan/note/reference moving does not go through a status recompute. The two
     * are fired by different service methods, so an event never arrives twice.
     */
    private val workingContextListener: () -> Unit = { SwingUtilities.invokeLater { refresh() } }

    init {
        // Match PINNED's container insets (empty(2,4)) so all sections share the same
        // first-row/last-row edge gaps. Each row adds empty(2,4) → 4px edge, 8px sides.
        border = JBUI.Borders.empty(2, 4)
        service.addStatusListener(statusListener)
        service.addWorkingContextListener(workingContextListener)
        ApplicationManager.getApplication().executeOnPooledThread { refreshFromDisk() }
    }

    fun refresh() {
        ApplicationManager.getApplication().executeOnPooledThread { refreshFromDisk() }
    }

    /**
     * Prompts the user to confirm removal of a plan / note / reference, then
     * hands the removal to the CLI.
     *
     * All three kinds are hard removals — the registry row is deleted, leaving no
     * tombstone, so re-adding the same plan/note or re-referencing the same
     * entity revives it. Whether the backing file is unlinked is the CLI's
     * decision (it deletes only files inside `.jolli/jollimemory/`, never the
     * user's own markdown), which is why nothing here touches the filesystem.
     */
    private fun removeItem(selected: ListItem) {
        val (itemType, itemName) = when (selected) {
            is ListItem.PlanItem -> "plan" to (selected.plan.title.ifBlank { selected.plan.slug })
            is ListItem.NoteItem -> "note" to selected.note.title
            is ListItem.ReferenceItem -> "reference" to selected.ref.title
            // Skills are a record of what ran, not a document the user curates — there
            // is nothing to delete. Excluding them from the next memory is the checkbox.
            is ListItem.SkillsItem -> return
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
            try {
                when (selected) {
                    is ListItem.PlanItem -> WorkingContext.removePlan(cwd, selected.plan.slug)
                    is ListItem.NoteItem -> WorkingContext.removeNote(cwd, selected.note.id)
                    is ListItem.ReferenceItem -> WorkingContext.removeReference(cwd, selected.mapKey)
                    // Unreachable: the guard above returns before the confirm dialog.
                    is ListItem.SkillsItem -> Unit
                }
            } catch (e: Exception) {
                LOG.warn("Remove $itemType failed: ${e.message}")
                SwingUtilities.invokeLater {
                    Messages.showErrorDialog(project, "Could not remove $itemType: ${e.message}", "Remove Failed")
                }
                return@executeOnPooledThread
            }
            // Working-context refresh, not the full status round-trip: removing a row
            // moves working-area state only. This panel is on both lists, so it still
            // repaints; nothing on the status list can have a different answer.
            service.refreshWorkingContext()
        }
    }

    private fun openReference(ref: ReferenceEntry) {
        val sourcePath = ref.sourcePath
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

    /**
     * (kind, key) used by CommitSelectionStore / PinStore for a given list item, or
     * null for a row that addresses no single artifact.
     *
     * Only the aggregate skills row returns null, and it has to: its checkbox stands
     * for every captured skill, so there is no one key to carry.
     */
    private fun kindKeyOf(item: ListItem): Pair<String, String>? = when (item) {
        is ListItem.PlanItem -> "plans" to item.plan.slug
        is ListItem.NoteItem -> "notes" to item.note.id
        is ListItem.ReferenceItem -> "references" to item.mapKey
        is ListItem.SkillsItem -> null
    }

    /**
     * Exhaustive over the item type rather than over the kind STRING.
     *
     * The string form ended in `else -> key in excludedReferences`, so a kind added
     * later was silently treated as a reference: the row rendered from the wrong
     * exclude set, and its toggle wrote into it. VS Code shipped exactly that bug
     * twice — once defaulting to `plan`, once to `reference` — which is why its
     * per-kind decisions now live in one table instead of a ternary chain. Here the
     * compiler enforces it: a new [ListItem] subclass fails to build until this
     * `when` accounts for it.
     */
    private fun isExcluded(item: ListItem): Boolean = when (item) {
        is ListItem.PlanItem -> item.plan.slug in excludedPlans
        is ListItem.NoteItem -> item.note.id in excludedNotes
        is ListItem.ReferenceItem -> item.mapKey in excludedReferences
        // One checkbox for all captured skills, so it reads as excluded only when every
        // one of them is. A partially-excluded set therefore shows as included, and the
        // next click excludes the remainder instead of re-including what was already out.
        is ListItem.SkillsItem ->
            item.skills.exclusionKeys.isNotEmpty() && item.skills.exclusionKeys.all { it in excludedSkills }
    }

    /** Toggles include/exclude for any item kind (select toggle click). */
    private fun toggleExclusion(item: ListItem) {
        val nowExcluded = !isExcluded(item)
        val cwd = service.mainRepoRoot ?: project.basePath ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            // Explicit handling because this is a bridge round-trip now, not the local
            // file write it used to be: a dead daemon, a Node binary missing from PATH
            // or a cold-spawn timeout all throw here. Unhandled, the pool swallows it,
            // `renderList()` never runs, and the user's click on ✕ does nothing at all
            // with no indication why — the row even keeps its old state, so it reads as
            // a dead control. Same dialog as `removeItem`'s failure path.
            try {
                when (item) {
                    // Every captured skill in one write: the aggregate row has no per-skill
                    // affordance, so leaving any key untouched would strand it in a state the
                    // user has no way to see or change.
                    is ListItem.SkillsItem ->
                        CommitSelectionStore.setAllExcluded(cwd, "skills", item.skills.exclusionKeys, nowExcluded)
                    else -> {
                        val (kind, key) = kindKeyOf(item) ?: return@executeOnPooledThread
                        CommitSelectionStore.setExcluded(cwd, kind, key, nowExcluded)
                    }
                }
            } catch (e: Exception) {
                LOG.warn("Toggle exclude failed: ${e.message}")
                SwingUtilities.invokeLater {
                    Messages.showErrorDialog(
                        project,
                        "Could not update whether this item is left out of the next memory: ${e.message}",
                        "Update Failed",
                    )
                }
                return@executeOnPooledThread
            }
            service.notifySelectionChanged()
            // Re-read is best-effort: the write above already landed, so a failure here
            // costs a stale checkbox until the next refresh, not a lost change.
            val ex = try {
                CommitSelectionStore.readExclusions(cwd)
            } catch (e: Exception) {
                LOG.warn("Re-reading exclusions after a toggle failed: ${e.message}")
                return@executeOnPooledThread
            }
            excludedReferences = ex.references
            excludedPlans = ex.plans
            excludedNotes = ex.notes
            excludedSkills = ex.skills
            SwingUtilities.invokeLater { renderList() }
        }
    }

    /**
     * Pins an item so it appears in the Pinned section (pin hover action).
     *
     * Unreachable for the aggregate skills row — [contextRow] gives it no pin icon,
     * because Pinned addresses one artifact by key and this row has none. Its `when`
     * branches below are still required: narrowing on the null key does not narrow the
     * item type, so the compiler wants every subclass accounted for.
     */
    private fun pinItem(item: ListItem) {
        val (kind, key) = kindKeyOf(item) ?: return
        val title = when (item) {
            is ListItem.PlanItem -> item.plan.title.ifBlank { item.plan.slug }
            is ListItem.NoteItem -> item.note.title
            // Same title-composition rule the CONTEXT row uses.
            is ListItem.ReferenceItem -> SourceDisplay.displayTitle(
                item.ref.source, item.ref.nativeId, item.ref.title,
            )
            is ListItem.SkillsItem -> return
        }
        // Same letter tag the Context row shows, so the Pinned row mirrors the icon.
        // Reference letter comes from the shared SourceDisplay table so PlansPanel
        // and PinnedPanel don't drift when a new source lands.
        val badge = when (item) {
            is ListItem.PlanItem -> "P"
            is ListItem.NoteItem -> if (item.note.format == NoteFormat.snippet) "S" else "N"
            is ListItem.ReferenceItem -> SourceDisplay.of(item.ref.source).tag
            is ListItem.SkillsItem -> return
        }
        val cwd = service.mainRepoRoot ?: project.basePath ?: return
        ai.jolli.jollimemory.core.telemetry.Telemetry.track("memory_pinned", mapOf("kind" to kind))
        ApplicationManager.getApplication().executeOnPooledThread {
            PinStore.pin(cwd, kind, key, title, badge)
            SwingUtilities.invokeLater { service.panelRegistry?.pinnedPanel?.refresh() }
        }
    }

    /**
     * Row click → rendered **preview**, never the editor.
     *
     * Same split VS Code draws: a plain click posts `branch:openPlan` /
     * `branch:openNote` / `branch:openReferencePreview`, all of which land on a
     * read-only rendered preview, and editing is reached only through the row's
     * ✎ button ([editItem]).
     */
    private fun openItem(item: ListItem) {
        when (item) {
            is ListItem.PlanItem -> openPlan(item.plan)
            is ListItem.NoteItem -> openNote(item.note)
            is ListItem.ReferenceItem -> openReference(item.ref)
            is ListItem.SkillsItem -> openSkillsAggregate()
        }
    }

    /**
     * Opens the table of every skill captured but not yet committed.
     *
     * There is no file to open: on disk each skill is its own
     * `skills/<source>/<stem>.md`, and the aggregate only becomes a real file
     * (`skills--<hash8>.md`) once the work is committed. So this renders the same
     * table through the CLI and shows it read-only, which is also what keeps the
     * before-commit and after-commit views identical.
     */
    private fun openSkillsAggregate() {
        val cwd = service.mainRepoRoot ?: project.basePath ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            // Separated from the empty case below: a bridge that cannot answer is not
            // evidence about what was captured, and saying so would point the user at
            // the wrong problem.
            val markdown = try {
                SkillsProjection.liveMarkdown(cwd)
            } catch (ex: Exception) {
                SwingUtilities.invokeLater { showSkillsMessage("Could not render the skills table: ${ex.message}") }
                return@executeOnPooledThread
            }
            SwingUtilities.invokeLater {
                if (markdown == null) {
                    // Normal right after a commit: archival empties the working registry.
                    // Worded as where they WENT, not as their absence — the row was on
                    // screen a moment ago, so "none captured" would read as a loss.
                    showSkillsMessage(
                        "These skills are now archived on your latest memory — " +
                            "nothing new has been captured for the current working session.",
                    )
                    return@invokeLater
                }
                MarkdownPreview.open(
                    project,
                    // Matches VS Code's tab for the same document, and the table's own
                    // H1 — the committed counterpart in CommitsPanel is named the same
                    // way, so the before-commit and after-commit tabs read as one pair.
                    com.intellij.testFramework.LightVirtualFile("Skills used — uncommitted.md", markdown)
                        .apply { isWritable = false },
                )
            }
        }
    }

    private fun showSkillsMessage(message: String) {
        JOptionPane.showMessageDialog(this, message, "Skills", JOptionPane.INFORMATION_MESSAGE)
    }

    /** Per-kind ✎ tooltip — VS Code's `CONTEXT_ROW_KINDS[kind].editLabel`. */
    private fun editLabelFor(item: ListItem): String = when (item) {
        is ListItem.PlanItem -> "Edit Plan"
        is ListItem.NoteItem -> "Edit Note"
        is ListItem.ReferenceItem -> "Edit Markdown"
        // Never shown: the aggregate skills row's hover cluster is the checkbox alone.
        // The label is still built for every row, so this needs a value, not a throw.
        is ListItem.SkillsItem -> "Edit"
    }

    /**
     * ✎ hover action → the file's **source**, in an editable editor.
     *
     * The counterpart to [openItem]: VS Code's `jollimemory.editPlan` /
     * `editNote` open the backing file with `showTextDocument`, and
     * `openReferenceMarkdown` opens the archived `.md` raw so its YAML
     * frontmatter stays visible. A reference edits the file on disk, not the
     * frontmatter-table preview [openReference] synthesises.
     */
    private fun editItem(item: ListItem) {
        val file = when (item) {
            is ListItem.PlanItem -> resolvePlanFile(item.plan)
            is ListItem.NoteItem -> resolveNoteFile(item.note)
            is ListItem.ReferenceItem -> File(item.ref.sourcePath).takeIf { it.exists() }
            // No single document behind the aggregate row, so there is nothing to edit —
            // and no ✎ on it either. Preview (the row click) renders the table instead.
            is ListItem.SkillsItem -> return
        }
        if (file == null) {
            missingFileMessage(item)
            return
        }
        val vf = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(file)
        if (vf == null) {
            missingFileMessage(item)
            return
        }
        MarkdownPreview.openSource(project, vf)
    }

    private fun missingFileMessage(item: ListItem) {
        val (kind, what) = when (item) {
            is ListItem.PlanItem -> "Plan" to "${item.plan.slug}.md"
            is ListItem.NoteItem -> "Note" to item.note.id
            is ListItem.ReferenceItem -> "Reference" to item.ref.sourcePath
            // Unreachable: [editItem] returns before it can get here for a skills row.
            is ListItem.SkillsItem -> return
        }
        JOptionPane.showMessageDialog(this, "$kind file not found: $what", kind, JOptionPane.WARNING_MESSAGE)
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

            // TWO bridge round-trips for the whole repaint: one for plans / notes /
            // references / exclusions, one for the skills projection (`contextList` does
            // not carry skills). This used to be five — exclusions + plans + notes +
            // registry + skills — over three separate reads of plans.json, affordable
            // when the panel only refreshed on a status recompute, not now that a plan
            // file saved anywhere on the machine repaints it through the working-context
            // channel.
            //
            // Visibility is decided CLI-side: `detectPlans` / `detectNotes` behind
            // this call already drop archive guards, committed snapshot copies and
            // orphaned rows, and deliberately apply NO branch filter — working-area
            // context belongs to the worktree and binds to a branch only at commit.
            // Do not re-filter here; a second predicate in Kotlin is exactly the
            // drift the sink of these services removed. References carry no
            // committed/guard state (a commit deletes the row), so every row in the
            // map is active.
            val context = WorkingContext.contextList(cwd)
            excludedReferences = context.exclusions.references
            excludedPlans = context.exclusions.plans
            excludedNotes = context.exclusions.notes
            excludedSkills = context.exclusions.skills

            val planItems = context.plans.map { ListItem.PlanItem(it) }
            val noteItems = context.notes.map { ListItem.NoteItem(it) }
            val refItems = context.references.map { (mapKey, entry) -> ListItem.ReferenceItem(entry, mapKey) }
            // Its own call, and deliberately not a raw `registry.skills` read: a skill row
            // survives archival (it is guarded, not deleted, so a later re-entry is
            // detectable), so the raw map would list every skill ever used as if it were
            // fresh working state. The CLI decides which rows are still uncommitted, and
            // reports the delta rather than each row's lifetime total. `readActive`
            // degrades to empty rather than throwing, so a skills hiccup costs one row,
            // not the whole repaint.
            val skillItems = SkillsProjection.readActive(cwd)
                .takeIf { !it.isEmpty }
                ?.let { listOf(ListItem.SkillsItem(it)) }
                ?: emptyList()

            // Merge and sort by lastModified descending (newest first), matching VS Code
            (planItems + noteItems + refItems + skillItems).sortedByDescending { it.lastModified }
        } catch (e: Exception) {
            // Re-render what we already hold instead of repainting an empty list.
            // This used to read plans.json directly, where a failure meant the file
            // was genuinely unreadable; it is now one bridge round-trip, which a
            // dead daemon, a Node binary missing from PATH, or a cold one-shot spawn
            // timing out will all fail — and the working-context channel repaints
            // this panel whenever a plan file is saved anywhere on the machine, so
            // that low-frequency path is now a high-frequency one. One hiccup must
            // not read as "the user has no context". Same reasoning as
            // [ActiveConversationsPanel]'s lastKnownExclusions fallback, and the
            // rows stay consistent with the exclude state because `excludedPlans` /
            // `excludedNotes` / `excludedReferences` / `excludedSkills` are only
            // reassigned on success.
            //
            // [renderList], NOT a bare return: it repaints from [allContextItems],
            // which is `emptyList()` until the first success — so a first-refresh
            // failure still lands on the real "No plans or notes yet." empty state
            // instead of leaving the panel stuck on "Initializing Jolli Memory…".
            // That is not a hypothetical ordering: the panel shows Initializing while
            // status is null, and the first enabled refresh is exactly when the
            // daemon is least likely to be bound yet.
            LOG.warn("CONTEXT refresh failed, keeping the last loaded rows: ${e.message}")
            SwingUtilities.invokeLater { renderList() }
            return
        }

        SwingUtilities.invokeLater { updateList(items) }
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

        // Hover cluster, in VS Code's order and with its labels: Pin → Edit →
        // Remove → the ✕/+ leave-out toggle (`renderPlanRow` in
        // SidebarScriptBuilder.ts). Remove and the toggle are NOT the same action:
        // the toggle just leaves the item out of the next memory (reversible),
        // Remove deletes the plan / note / reference row.
        val pin = rowActionIcon(JolliMemoryIcons.Pin, "Pin") { pinItem(item) }
        val edit = rowActionIcon(JolliMemoryIcons.Edit, editLabelFor(item)) { editItem(item) }
        val remove = rowActionIcon(JolliMemoryIcons.Trash, "Remove") { removeItem(item) }
        val toggle = rowActionIcon(
            if (excluded) JolliMemoryIcons.Add else JolliMemoryIcons.Close,
            if (excluded) "Add back to this memory" else "Leave out of this memory",
        ) { toggleExclusion(item) }
        // The aggregate skills row gets the checkbox and nothing else — matching VS
        // Code, where its kind declares no inline actions. There is no single document
        // to pin, edit or remove, and Pin addresses one artifact by key, which this row
        // lacks.
        val icons = if (item is ListItem.SkillsItem) listOf(toggle) else listOf(pin, edit, remove, toggle)
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

    /**
     * Right-click menu, mirroring VS Code's `ctx === 'plan' | 'note' |
     * 'reference'` branches: Preview → Edit → (Open in Browser, references with
     * a url only) → separator → Remove. Pin is deliberately absent from both
     * surfaces — it lives on the row's hover cluster.
     */
    private fun showRowContextMenu(item: ListItem, e: MouseEvent) {
        val popup = JPopupMenu()
        // The aggregate skills row offers Preview only: it is a record of what ran, so
        // there is nothing to edit or remove, and menu items that silently did nothing
        // would be worse than their absence.
        if (item is ListItem.SkillsItem) {
            popup.add(JMenuItem("Preview", JolliMemoryIcons.Eye).apply {
                addActionListener { openSkillsAggregate() }
            })
            popup.show(e.component, e.x, e.y)
            return
        }
        popup.add(JMenuItem("Preview", JolliMemoryIcons.Eye).apply { addActionListener { openItem(item) } })
        popup.add(JMenuItem(editLabelFor(item), JolliMemoryIcons.Edit).apply { addActionListener { editItem(item) } })
        if (item is ListItem.ReferenceItem) {
            val refUrl = item.ref.url
            if (!refUrl.isNullOrBlank()) {
                popup.add(JMenuItem("Open in Browser", JolliMemoryIcons.Globe).apply {
                    addActionListener { openReferenceInBrowser(refUrl) }
                })
            }
        }
        popup.add(JSeparator())
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
        is ListItem.SkillsItem -> "S" to TagLabel.SKILL
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
        // The CLI's own label ("3 skills · 93.8k tokens"), not a Kotlin restatement of
        // it: this row must read the same here, in VS Code, and in the committed
        // `skills--<hash8>.md`. The "some inferred" suffix is appended per-surface
        // because the table spells the same caveat as a `†` footnote instead.
        is ListItem.SkillsItem -> {
            val label = item.skills.summaryLabel.ifBlank { "Skills used" }
            if (item.skills.anyInferred) "$label · some inferred" else label
        }
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
            // One bridge round-trip for the whole set, not one per row: `setExcluded`
            // in a loop is N round-trips, N `withCommitSelectionLock` acquisitions and
            // N rewrites of commit-selection.json — and N chances to be interrupted
            // half-applied. `setAllExcluded` is the CLI operation that exists for this;
            // ActiveConversationsPanel's select-all already uses it.
            // Handled for the same reason as the single-row toggle above: one bridge
            // round-trip, and a silent failure would leave every row unchanged with no
            // feedback. Worth a dialog rather than a warn — the user just asked to flip
            // the whole set, so doing nothing quietly is the most misleading outcome.
            try {
                CommitSelectionStore.setAllExcluded(cwd, "references", refItems.map { it.mapKey }, !select)
            } catch (e: Exception) {
                LOG.warn("Select-all exclude failed: ${e.message}")
                SwingUtilities.invokeLater {
                    Messages.showErrorDialog(
                        project,
                        "Could not update which references are left out of the next memory: ${e.message}",
                        "Update Failed",
                    )
                }
                return@executeOnPooledThread
            }
            service.notifySelectionChanged()
            excludedReferences = try {
                CommitSelectionStore.readExclusions(cwd).references
            } catch (e: Exception) {
                LOG.warn("Re-reading exclusions after select-all failed: ${e.message}")
                return@executeOnPooledThread
            }
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
            is ListItem.SkillsItem -> buildSkillsPopupContent(content, item.skills, fg, dimFg)
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

    // No "Branch: …" row in either popup. An uncommitted plan/note belongs to the
    // worktree, not to a branch — it follows the user across a checkout and gains
    // a branch only when a commit claims it (recorded on `CommitSummary.branch`).
    // Labelling it with the branch that happened to be current when it was created
    // states something the model does not guarantee. See JOLLI-2058.
    private fun buildPlanPopupContent(content: JPanel, plan: WorkingContext.PlanInfo, fg: Color, dimFg: Color) {
        content.add(JBLabel(plan.title.ifBlank { plan.slug }).apply {
            foreground = fg; font = font.deriveFont(java.awt.Font.BOLD); alignmentX = Component.LEFT_ALIGNMENT
        })
        content.add(Box.createVerticalStrut(JBUI.scale(4)))
        content.add(JBLabel(plan.filename).apply {
            foreground = dimFg; alignmentX = Component.LEFT_ALIGNMENT
        })
    }

    /**
     * Names the skills behind the aggregate row, heaviest first.
     *
     * The row itself can only show a count and a token total, so without this the user
     * has to open the table to learn WHICH skills ran. Capped at [SKILLS_POPUP_CAP]
     * with an overflow line — a session can enter a dozen, and a popup taller than the
     * panel is worse than a truncated one. Ordering matches the table's (by tokens,
     * then name) so the two do not disagree about what dominated the work.
     */
    private fun buildSkillsPopupContent(
        content: JPanel,
        skills: SkillsProjection.ActiveSkills,
        fg: Color,
        dimFg: Color,
    ) {
        content.add(JBLabel(skills.summaryLabel.ifBlank { "Skills used" }).apply {
            foreground = fg; font = font.deriveFont(Font.BOLD); alignmentX = Component.LEFT_ALIGNMENT
        })
        content.add(Box.createVerticalStrut(JBUI.scale(4)))

        // Heaviest first, then by name — the aggregate table's own ordering, so the card
        // and the table agree about what dominated the work. Deliberately not a
        // locale-aware compare: the ambient locale would reorder rows for a colleague.
        val ordered = skills.skills.sortedWith(
            compareByDescending<SkillsProjection.ActiveSkill> { totalTokensOf(it) }.thenBy { it.skill },
        )
        for (skill in ordered.take(SKILLS_POPUP_CAP)) {
            // Count AND tokens, the table's two columns. An unattributed skill shows an
            // em dash for tokens, never a zero — Codex and Cursor heuristics measure
            // nothing, and a rendered 0 reads as a measurement rather than its absence.
            val tokens = skill.usage
                ?.let { u -> formatTokens(totalTokensOf(skill), u.confidence != "attributed") }
                ?: "—"
            val inferred = if (skill.detection == "heuristic") " †" else ""
            content.add(JBLabel("${skill.skill}$inferred — ${skill.invocationCount}× · $tokens").apply {
                foreground = dimFg; alignmentX = Component.LEFT_ALIGNMENT
            })
        }
        val hidden = ordered.size - SKILLS_POPUP_CAP
        if (hidden > 0) {
            content.add(JBLabel("+$hidden more — click to open the table").apply {
                foreground = dimFg; alignmentX = Component.LEFT_ALIGNMENT
            })
        }
        if (skills.anyInferred) {
            content.add(Box.createVerticalStrut(JBUI.scale(2)))
            content.add(JBLabel("† inferred from a file read, not an observed call").apply {
                foreground = dimFg; alignmentX = Component.LEFT_ALIGNMENT
            })
        }
    }

    private fun totalTokensOf(skill: SkillsProjection.ActiveSkill): Int =
        skill.usage?.let { it.input + it.cached + it.output } ?: 0

    /**
     * `93.8k` / `~12.3k` — the CLI table's compact form.
     *
     * Restated in Kotlin only because this is a PER-SKILL figure and the bridge exposes
     * the aggregate label, not per-row text. VS Code's own hover card does the same for
     * the same reason. Keep the formula identical to `formatCompact` in
     * `SkillsAggregateMarkdown.ts` — the card sits one click from that table, and two
     * roundings of the same number is a bug report.
     */
    private fun formatTokens(total: Int, estimated: Boolean): String {
        val marker = if (estimated) "~" else ""
        // Locale.ROOT, not the bare `String.format` extension: that one takes the
        // ambient locale, so a comma-decimal IDE would render `93,8k` here while the
        // table one click away — rendered by the CLI's `toFixed(1)`, which has no
        // locale — still says `93.8k`. Same reason the sort above avoids a
        // locale-aware compare.
        return if (total < 1000) "$marker$total" else marker + String.format(Locale.ROOT, "%.1fk", total / 1000.0)
    }

    private fun buildNotePopupContent(content: JPanel, note: WorkingContext.NoteInfo, fg: Color, dimFg: Color) {
        content.add(JBLabel(note.title).apply {
            foreground = fg; font = font.deriveFont(java.awt.Font.BOLD); alignmentX = Component.LEFT_ALIGNMENT
        })
        content.add(Box.createVerticalStrut(JBUI.scale(4)))
        val formatStr = if (note.format == NoteFormat.snippet) "snippet" else "markdown"
        content.add(JBLabel("Format: $formatStr").apply {
            foreground = dimFg; alignmentX = Component.LEFT_ALIGNMENT
        })
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
        service.removeWorkingContextListener(workingContextListener)
    }

    /**
     * Resolves a plan row to an on-disk file for the open / preview actions.
     *
     * KNOWN restatement, pre-existing and deliberately left here — not a review
     * finding. The two fallbacks spell out the CLI's own plan locations
     * (uncommitted → `~/.claude/plans/<slug>.md`, committed →
     * `.jolli/jollimemory/plans/<slug>.md`, exactly as `PlanEntry.filePath`
     * documents), so a layout change CLI-side would leave them pointing at the old
     * paths. It degrades gracefully rather than silently: `plan.filePath` — the
     * authoritative value the CLI just handed us — is tried FIRST, so the fallbacks
     * only run when that file is already gone, and the whole thing returns null
     * instead of guessing wrong. Contrast [resolveNoteFile], which asks the bridge
     * for the notes directory; that is the shape to converge on if this is ever
     * revisited, and it needs a path-resolving bridge operation rather than a
     * change here.
     */
    private fun resolvePlanFile(plan: WorkingContext.PlanInfo): File? = listOf(
        File(plan.filePath),
        File(System.getProperty("user.home"), ".claude/plans/${plan.slug}.md"),
        File(service.mainRepoRoot ?: "", ".jolli/jollimemory/plans/${plan.slug}.md"),
    ).firstOrNull { it.exists() }

    /** Notes are stored in `.jolli/jollimemory/notes/<id>.md`. */
    private fun resolveNoteFile(note: WorkingContext.NoteInfo): File? {
        val cwd = service.mainRepoRoot ?: project.basePath ?: ""
        return listOfNotNull(
            note.filePath?.let { File(it) },
            File(SessionTracker.getNotesDir(cwd), "${note.id}.md"),
        ).firstOrNull { it.exists() }
    }

    private fun openPlan(plan: WorkingContext.PlanInfo) {
        val vf = resolvePlanFile(plan)?.let { LocalFileSystem.getInstance().refreshAndFindFileByIoFile(it) }
        if (vf == null) {
            JOptionPane.showMessageDialog(
                this, "Plan file not found: ${plan.slug}.md", "Plan", JOptionPane.WARNING_MESSAGE,
            )
            return
        }
        MarkdownPreview.open(project, vf)
    }

    private fun openNote(note: WorkingContext.NoteInfo) {
        val vf = resolveNoteFile(note)?.let { LocalFileSystem.getInstance().refreshAndFindFileByIoFile(it) }
        if (vf == null) {
            JOptionPane.showMessageDialog(this, "Note file not found: ${note.id}", "Note", JOptionPane.WARNING_MESSAGE)
            return
        }
        MarkdownPreview.open(project, vf)
    }
}

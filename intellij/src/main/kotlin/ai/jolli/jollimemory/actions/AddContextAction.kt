package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.core.NoteFormat
import ai.jolli.jollimemory.core.WorkingContext
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopup
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
import java.io.File
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * The CONTEXT section's single "+" toolbar button.
 *
 * One button, three entries — the same dropdown VS Code's sidebar opens under
 * its ➕ (`plans-add-menu` in `SidebarScriptBuilder`), with the same labels in
 * the same order:
 *   1. Add Plan — picker over the `~/.claude/plans/` files not already tracked
 *   2. Add Markdown Note — file picker; the CLI references the file in place
 *   3. Add Text Snippet — inline title + body dialog
 *
 * This replaced a two-button toolbar (a "+" that was Add Plan only, plus a
 * second note-glyph button that opened its own two-entry popup): the same three
 * destinations, but reached through a different shape than the other surface.
 *
 * Every write goes through [WorkingContext] — one `working-context` bridge
 * round-trip into `cli/src/core/{PlanService,NoteService}`. Nothing here decides
 * what a plan or a note *is*; it collects input and hands it over.
 *
 * [DumbAware] because nothing here reads the PSI or an index — it talks to git,
 * the CLI bridge and Swing. Without the marker the platform force-disables the
 * button for the whole of indexing no matter what [update] returns, which on a
 * large project is minutes of a dead ➕ on a freshly opened IDE. Every action in
 * this package is dumb-aware for the same reason; keep new ones that way.
 */
class AddContextAction : AnAction(), DumbAware {

    private companion object {
        const val ADD_PLAN = "Add Plan"
        const val ADD_MARKDOWN_NOTE = "Add Markdown Note"
        const val ADD_TEXT_SNIPPET = "Add Text Snippet"
        val LOG: Logger = Logger.getInstance(AddContextAction::class.java)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = project.getService(JolliMemoryService::class.java)
        val anchor = clickedButton(e)

        val options = listOf(ADD_PLAN, ADD_MARKDOWN_NOTE, ADD_TEXT_SNIPPET)
        val step = object : BaseListPopupStep<String>(null, options) {
            override fun onChosen(selectedValue: String, finalChoice: Boolean): PopupStep<*>? {
                if (!finalChoice) return PopupStep.FINAL_CHOICE
                // The chosen flow opens a modal (file chooser / dialog / second
                // popup), so run it after this popup has closed rather than
                // stacking a modal on top of a closing one.
                ApplicationManager.getApplication().invokeLater {
                    when (selectedValue) {
                        ADD_PLAN -> addPlan(project, service, anchor)
                        ADD_MARKDOWN_NOTE -> addMarkdownNote(project, service)
                        ADD_TEXT_SNIPPET -> addSnippetNote(project, service)
                    }
                }
                return PopupStep.FINAL_CHOICE
            }
        }

        showUnder(JBPopupFactory.getInstance().createListPopup(step), anchor, e)
    }

    /**
     * The toolbar button that was clicked, for anchoring the dropdown.
     *
     * NOT `showInBestPositionFor(dataContext)`: a toolbar action's
     * `CONTEXT_COMPONENT` is the toolbar's **targetComponent**, which
     * `CurrentMemoryPanel.sectionHeader` sets to the CONTEXT rows panel — so
     * "best position" resolved against the row list and the menu opened well
     * away from the ➕, floating over the rows. The input event carries the
     * `ActionButton` itself, which is the thing the user actually clicked.
     */
    private fun clickedButton(e: AnActionEvent): JComponent? = e.inputEvent?.component as? JComponent

    /** Opens [popup] directly beneath [anchor], falling back when there is none. */
    private fun showUnder(popup: JBPopup, anchor: JComponent?, e: AnActionEvent?) {
        // Keyboard invocation (Find Action, a keymap binding) has no button to
        // anchor to, and a hidden anchor would throw inside showUnderneathOf.
        if (anchor != null && anchor.isShowing) {
            popup.showUnderneathOf(anchor)
        } else if (e != null) {
            popup.showInBestPositionFor(e.dataContext)
        } else {
            popup.showInFocusCenter()
        }
    }

    override fun update(e: AnActionEvent) {
        val status = e.project?.getService(JolliMemoryService::class.java)?.getStatus()
        e.presentation.isEnabled = status != null && status.enabled
    }

    // getStatus() is a cached-field read, so the enablement check needs no EDT.
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    /**
     * Plan picker. The CLI enumerates `~/.claude/plans/` and applies the exclude
     * set, so the picker and the registry agree on what "already tracked" means.
     *
     * Both reads are ide-bridge round-trips, so they run on a pooled thread and
     * only the popup comes back to the EDT — a cold-spawn fallback (no daemon
     * bound yet) would otherwise freeze the UI for a second or more.
     */
    private fun addPlan(project: Project, service: JolliMemoryService, anchor: JComponent?) {
        val cwd = service.mainRepoRoot ?: project.basePath ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            val available = try {
                val existingSlugs = WorkingContext.detectPlans(cwd).map { it.slug }.toSet()
                WorkingContext.listAvailablePlans(cwd, existingSlugs)
            } catch (e: Exception) {
                ApplicationManager.getApplication().invokeLater {
                    if (!project.isDisposed) {
                        Messages.showErrorDialog(project, "Could not list plans: ${e.message}", ADD_PLAN)
                    }
                }
                return@executeOnPooledThread
            }
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                showPlanPicker(project, service, cwd, available, anchor)
            }
        }
    }

    private fun showPlanPicker(
        project: Project,
        service: JolliMemoryService,
        cwd: String,
        available: List<WorkingContext.AvailablePlan>,
        anchor: JComponent?,
    ) {
        if (available.isEmpty()) {
            Messages.showInfoMessage(
                project,
                "No new plans found in ~/.claude/plans/.\nPlans are created by Claude Code during coding sessions.",
                ADD_PLAN,
            )
            return
        }

        val step = object : BaseListPopupStep<WorkingContext.AvailablePlan>("Select a plan to add", available) {
            override fun getTextFor(value: WorkingContext.AvailablePlan): String = value.title

            override fun onChosen(selectedValue: WorkingContext.AvailablePlan, finalChoice: Boolean): PopupStep<*>? {
                if (finalChoice) {
                    ApplicationManager.getApplication().executeOnPooledThread {
                        try {
                            WorkingContext.addPlan(cwd, selectedValue.slug)
                        } catch (e: Exception) {
                            reportFailure(project, ADD_PLAN, e)
                            return@executeOnPooledThread
                        }
                        // Working-context refresh, not the full status round-trip:
                        // adding a plan cannot change installation state, and the two
                        // panels that show it are both on the narrow listener list.
                        service.refreshWorkingContext()
                    }
                }
                return PopupStep.FINAL_CHOICE
            }
        }
        // Under the same ➕, so the picker reads as a continuation of the menu
        // rather than a new dialog somewhere else on screen.
        showUnder(JBPopupFactory.getInstance().createListPopup(step), anchor, null)
    }

    private fun addMarkdownNote(project: Project, service: JolliMemoryService) {
        val descriptor = FileChooserDescriptorFactory.createSingleFileDescriptor("md")
            .withTitle("Select Markdown File")
        val chosen = FileChooser.chooseFile(descriptor, project, null) ?: return

        val sourceFile = File(chosen.path)
        if (!sourceFile.exists()) return

        ApplicationManager.getApplication().executeOnPooledThread {
            val cwd = service.mainRepoRoot ?: project.basePath ?: return@executeOnPooledThread
            // A markdown note references the user's own file in place — the CLI
            // takes `content` as that path and never copies it, so an edit in the
            // editor stays the note's content. `title` is left blank so the CLI
            // derives it from the file's first heading (one title rule, not two).
            val note = try {
                WorkingContext.saveNote(cwd, null, "", sourceFile.absolutePath, NoteFormat.markdown)
            } catch (e: Exception) {
                reportFailure(project, ADD_MARKDOWN_NOTE, e)
                return@executeOnPooledThread
            }
            service.refreshWorkingContext()
            // Open it, matching VS Code's addMarkdownNote (`showTextDocument` on the
            // returned filePath) — the note IS the user's file, so landing in it is
            // the confirmation that the pick took effect.
            openNoteSource(project, note)
        }
    }

    private fun addSnippetNote(project: Project, service: JolliMemoryService) {
        val dialog = SnippetDialog(project)
        if (!dialog.showAndGet()) return

        val title = dialog.snippetTitle.trim()
        val content = dialog.snippetContent.trim()
        if (title.isBlank() || content.isBlank()) return

        ApplicationManager.getApplication().executeOnPooledThread {
            val cwd = service.mainRepoRoot ?: project.basePath ?: return@executeOnPooledThread
            // The CLI owns id generation, the notes directory and the file write;
            // passing the snippet text as `content` is the whole contract.
            try {
                WorkingContext.saveNote(cwd, null, title, content, NoteFormat.snippet)
            } catch (e: Exception) {
                reportFailure(project, ADD_TEXT_SNIPPET, e)
                return@executeOnPooledThread
            }
            service.refreshWorkingContext()
        }
    }

    /**
     * Surfaces a failed bridge write instead of losing it.
     *
     * Each write here is an ide-bridge round-trip that can fail for reasons the user
     * can act on (no Node on PATH, a daemon that died, a locked registry). Left
     * unhandled the exception escapes into the pooled thread, the refresh never runs,
     * and the user — who just picked a file or filled in a dialog — sees nothing
     * happen at all. The read path above already reports its failures this way.
     */
    private fun reportFailure(project: Project, what: String, e: Exception) {
        LOG.warn("$what failed: ${e.message}")
        ApplicationManager.getApplication().invokeLater {
            if (!project.isDisposed) Messages.showErrorDialog(project, "Could not $what: ${e.message}", what)
        }
    }

    /** Opens a freshly created note's backing file, best-effort. */
    private fun openNoteSource(project: Project, note: WorkingContext.NoteInfo?) {
        val path = note?.filePath ?: return
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            val vf = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(File(path)) ?: return@invokeLater
            FileEditorManager.getInstance(project).openFile(vf, true)
        }
    }

    /** Title + content fields for a text snippet note. */
    private class SnippetDialog(project: Project) : DialogWrapper(project) {

        private val titleField = JBTextField()
        private val contentArea = JBTextArea(8, 40)

        val snippetTitle: String get() = titleField.text
        val snippetContent: String get() = contentArea.text

        init {
            title = "Add Text Snippet"
            init()
        }

        override fun createCenterPanel(): JComponent {
            val panel = JPanel(BorderLayout(0, JBUI.scale(8)))
            panel.border = JBUI.Borders.empty(8)

            val titlePanel = JPanel(BorderLayout(JBUI.scale(8), 0)).apply {
                add(JBLabel("Title:"), BorderLayout.WEST)
                add(titleField, BorderLayout.CENTER)
            }
            panel.add(titlePanel, BorderLayout.NORTH)

            val contentPanel = JPanel(BorderLayout(0, JBUI.scale(4))).apply {
                add(JBLabel("Content:"), BorderLayout.NORTH)
                contentArea.lineWrap = true
                contentArea.wrapStyleWord = true
                add(JBScrollPane(contentArea), BorderLayout.CENTER)
            }
            panel.add(contentPanel, BorderLayout.CENTER)

            panel.preferredSize = Dimension(JBUI.scale(450), JBUI.scale(300))
            return panel
        }
    }
}

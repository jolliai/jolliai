package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.core.NoteEntry
import ai.jolli.jollimemory.core.NoteFormat
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.services.PlanService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
import java.io.File
import java.time.Instant
import java.util.UUID
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Adds a note to the plans.json registry.
 * Shows a popup with two options:
 *   1. Add Markdown File — file picker for .md files
 *   2. Add Text Snippet — inline dialog with title + content
 *
 * Matches VS Code's "+ Add" dropdown in the Plans & Notes section.
 */
class AddNoteAction : AnAction() {

    init {
        templatePresentation.icon = JolliMemoryIcons.NoteAdd
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = project.getService(JolliMemoryService::class.java)

        val options = listOf("Add Markdown File", "Add Text Snippet")
        val step = object : BaseListPopupStep<String>("Add Note", options) {
            override fun onChosen(selectedValue: String, finalChoice: Boolean): PopupStep<*>? {
                if (!finalChoice) return PopupStep.FINAL_CHOICE
                ApplicationManager.getApplication().invokeLater {
                    when (selectedValue) {
                        "Add Markdown File" -> addMarkdownNote(project, service)
                        "Add Text Snippet" -> addSnippetNote(project, service)
                    }
                }
                return PopupStep.FINAL_CHOICE
            }
        }

        JBPopupFactory.getInstance().createListPopup(step).showInBestPositionFor(e.dataContext)
    }

    private fun addMarkdownNote(project: com.intellij.openapi.project.Project, service: JolliMemoryService) {
        val descriptor = FileChooserDescriptorFactory.createSingleFileDescriptor("md")
            .withTitle("Select Markdown File")
        val chosen = FileChooser.chooseFile(descriptor, project, null) ?: return

        val sourceFile = File(chosen.path)
        if (!sourceFile.exists()) return

        ApplicationManager.getApplication().executeOnPooledThread {
            val cwd = service.mainRepoRoot ?: project.basePath ?: return@executeOnPooledThread
            val noteId = UUID.randomUUID().toString().take(8)
            val title = PlanService.extractPlanTitle(sourceFile.readText(Charsets.UTF_8))
            val notesDir = File(SessionTracker.getNotesDir(cwd))
            notesDir.mkdirs()

            // Copy the file into notes directory
            val destFile = File(notesDir, "$noteId.md")
            sourceFile.copyTo(destFile, overwrite = true)

            saveNoteEntry(noteId, title, NoteFormat.markdown, destFile.absolutePath, cwd, service)
        }
    }

    private fun addSnippetNote(project: com.intellij.openapi.project.Project, service: JolliMemoryService) {
        val dialog = SnippetDialog(project)
        if (!dialog.showAndGet()) return

        val title = dialog.snippetTitle.trim()
        val content = dialog.snippetContent.trim()
        if (title.isBlank() || content.isBlank()) return

        ApplicationManager.getApplication().executeOnPooledThread {
            val cwd = service.mainRepoRoot ?: project.basePath ?: return@executeOnPooledThread
            val noteId = UUID.randomUUID().toString().take(8)
            val notesDir = File(SessionTracker.getNotesDir(cwd))
            notesDir.mkdirs()

            // Write snippet content as a markdown file
            val destFile = File(notesDir, "$noteId.md")
            destFile.writeText("# $title\n\n$content", Charsets.UTF_8)

            saveNoteEntry(noteId, title, NoteFormat.snippet, destFile.absolutePath, cwd, service)
        }
    }

    private fun saveNoteEntry(
        noteId: String,
        title: String,
        format: NoteFormat,
        sourcePath: String,
        cwd: String,
        service: JolliMemoryService,
    ) {
        val registry = SessionTracker.loadPlansRegistry(cwd)
        val now = Instant.now().toString()
        val git = service.getGitOps()
        val branch = git?.getCurrentBranch() ?: "unknown"

        val entry = NoteEntry(
            id = noteId,
            title = title,
            format = format,
            addedAt = now,
            updatedAt = now,
            branch = branch,
            commitHash = null,
            sourcePath = sourcePath,
        )

        val updatedNotes = (registry.notes ?: emptyMap()).toMutableMap()
        updatedNotes[noteId] = entry

        SessionTracker.savePlansRegistry(
            registry.copy(notes = updatedNotes),
            cwd,
        )

        // Trigger UI refresh
        service.refreshStatus()
    }

    override fun update(e: AnActionEvent) {
        val status = e.project?.getService(JolliMemoryService::class.java)?.getStatus()
        e.presentation.isEnabled = status != null && status.enabled
    }

    /**
     * Simple dialog for creating a text snippet note with title and content fields.
     */
    private class SnippetDialog(
        project: com.intellij.openapi.project.Project,
    ) : DialogWrapper(project) {

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

            // Title row
            val titlePanel = JPanel(BorderLayout(JBUI.scale(8), 0)).apply {
                add(JBLabel("Title:"), BorderLayout.WEST)
                add(titleField, BorderLayout.CENTER)
            }
            panel.add(titlePanel, BorderLayout.NORTH)

            // Content area
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

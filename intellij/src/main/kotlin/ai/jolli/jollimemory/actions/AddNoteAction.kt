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
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import java.io.File
import java.time.Instant
import java.util.UUID

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
        // Opens as a dedicated editor tab (NoteEditorFileEditor) rather than a
        // blocking modal — matches VS Code's webview panel UX. The editor owns
        // its own save flow; we just open the tab here.
        val virtualFile = ai.jolli.jollimemory.toolwindow.NoteEditorVirtualFile()
        com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(virtualFile, true)
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

    companion object {
        /**
         * Direct entry into the markdown-file sub-flow without showing the
         * "Add Markdown / Add Text Snippet" picker popup. Used by the JCEF
         * sidebar, which already presents that choice in its own `+` menu.
         */
        fun openMarkdownPicker(project: com.intellij.openapi.project.Project) {
            val service = project.getService(JolliMemoryService::class.java) ?: return
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
                val destFile = File(notesDir, "$noteId.md")
                sourceFile.copyTo(destFile, overwrite = true)
                val registry = SessionTracker.loadPlansRegistry(cwd)
                val now = Instant.now().toString()
                val branch = service.getGitOps()?.getCurrentBranch() ?: "unknown"
                val entry = NoteEntry(
                    id = noteId,
                    title = title,
                    format = NoteFormat.markdown,
                    addedAt = now,
                    updatedAt = now,
                    branch = branch,
                    commitHash = null,
                    sourcePath = destFile.absolutePath,
                )
                val updatedNotes = (registry.notes ?: emptyMap()).toMutableMap()
                updatedNotes[noteId] = entry
                SessionTracker.savePlansRegistry(registry.copy(notes = updatedNotes), cwd)
                service.refreshStatus()
            }
        }

        /**
         * Direct entry into the snippet sub-flow without showing the picker
         * popup. Opens the dedicated note editor tab.
         */
        fun openSnippetEditor(project: com.intellij.openapi.project.Project) {
            val virtualFile = ai.jolli.jollimemory.toolwindow.NoteEditorVirtualFile()
            com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(virtualFile, true)
        }
    }
}

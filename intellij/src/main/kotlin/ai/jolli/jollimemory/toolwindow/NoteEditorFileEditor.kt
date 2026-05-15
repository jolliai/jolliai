package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.NoteEntry
import ai.jolli.jollimemory.core.NoteFormat
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.FlowLayout
import java.beans.PropertyChangeListener
import java.io.File
import java.time.Instant
import java.util.UUID
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Dedicated editor tab for creating a text-snippet note. Replaces the legacy
 * modal `SnippetDialog` so the UX matches VS Code's webview panel — the form
 * sits alongside the user's other editor tabs instead of blocking the IDE.
 */
class NoteEditorFileEditor(
    private val project: Project,
    private val virtualFile: NoteEditorVirtualFile,
) : UserDataHolderBase(), FileEditor {

    private val titleField = JBTextField().apply {
        emptyText.text = "Title"
    }

    private val contentArea = JBTextArea().apply {
        lineWrap = true
        wrapStyleWord = true
        rows = 12
    }

    private val saveButton = JButton("Save").apply {
        addActionListener { save() }
    }

    private val cancelButton = JButton("Cancel").apply {
        addActionListener { closeTab() }
    }

    private val panel: JPanel = JPanel(BorderLayout(0, 12)).apply {
        border = JBUI.Borders.empty(16)

        val titleRow = JPanel(BorderLayout(0, 4)).apply {
            add(JBLabel("Title"), BorderLayout.NORTH)
            add(titleField, BorderLayout.CENTER)
        }

        val contentRow = JPanel(BorderLayout(0, 4)).apply {
            add(JBLabel("Content"), BorderLayout.NORTH)
            add(JBScrollPane(contentArea), BorderLayout.CENTER)
        }

        val form = JPanel(BorderLayout(0, 12)).apply {
            add(titleRow, BorderLayout.NORTH)
            add(contentRow, BorderLayout.CENTER)
        }

        val buttons = JPanel(FlowLayout(FlowLayout.RIGHT, 8, 0)).apply {
            add(cancelButton)
            add(saveButton)
        }

        add(form, BorderLayout.CENTER)
        add(buttons, BorderLayout.SOUTH)
    }

    private fun save() {
        val title = titleField.text.trim()
        val content = contentArea.text.trim()
        if (title.isBlank() || content.isBlank()) {
            Messages.showWarningDialog(
                project,
                "Both Title and Content are required.",
                "Jolli Memory",
            )
            return
        }
        saveButton.isEnabled = false
        val service = project.getService(JolliMemoryService::class.java)
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                persistSnippet(service, title, content)
                ApplicationManager.getApplication().invokeLater { closeTab() }
            } catch (ex: Exception) {
                LOG.warn("Failed to save snippet note", ex)
                ApplicationManager.getApplication().invokeLater {
                    saveButton.isEnabled = true
                    Messages.showErrorDialog(
                        project,
                        "Could not save snippet: ${ex.message}",
                        "Jolli Memory",
                    )
                }
            }
        }
    }

    private fun persistSnippet(service: JolliMemoryService, title: String, content: String) {
        val cwd = service.mainRepoRoot ?: project.basePath ?: return
        val noteId = UUID.randomUUID().toString().take(8)
        val notesDir = File(SessionTracker.getNotesDir(cwd))
        notesDir.mkdirs()

        val destFile = File(notesDir, "$noteId.md")
        destFile.writeText("# $title\n\n$content", Charsets.UTF_8)

        val registry = SessionTracker.loadPlansRegistry(cwd)
        val now = Instant.now().toString()
        val branch = service.getGitOps()?.getCurrentBranch() ?: "unknown"
        val entry = NoteEntry(
            id = noteId,
            title = title,
            format = NoteFormat.snippet,
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

    private fun closeTab() {
        FileEditorManager.getInstance(project).closeFile(virtualFile)
    }

    override fun getComponent(): JComponent = panel
    override fun getPreferredFocusedComponent(): JComponent = titleField
    override fun getName(): String = "New Note"
    override fun setState(state: FileEditorState) {}
    override fun isModified(): Boolean = false
    override fun isValid(): Boolean = true
    override fun addPropertyChangeListener(listener: PropertyChangeListener) {}
    override fun removePropertyChangeListener(listener: PropertyChangeListener) {}
    override fun getFile() = virtualFile
    override fun dispose() {}

    companion object {
        private val LOG = Logger.getInstance(NoteEditorFileEditor::class.java)
    }
}

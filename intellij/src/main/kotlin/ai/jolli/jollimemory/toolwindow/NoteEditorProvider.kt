package ai.jolli.jollimemory.toolwindow

import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile

/**
 * Routes [NoteEditorVirtualFile] instances to [NoteEditorFileEditor] so the
 * "Add Text Snippet" flow opens as an editor tab (matching VS Code's webview
 * panel UX), not a modal dialog.
 */
class NoteEditorProvider : FileEditorProvider, DumbAware {

    override fun accept(project: Project, file: VirtualFile): Boolean = file is NoteEditorVirtualFile

    override fun createEditor(project: Project, file: VirtualFile): FileEditor =
        NoteEditorFileEditor(project, file as NoteEditorVirtualFile)

    override fun getEditorTypeId(): String = "jollimemory-note-editor"

    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.HIDE_DEFAULT_EDITOR
}

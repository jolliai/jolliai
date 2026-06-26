package ai.jolli.jollimemory.toolwindow

import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile

/** Opens [WorkingMemoryVirtualFile] as a JCEF web view editor tab. */
class WorkingMemoryEditorProvider : FileEditorProvider, DumbAware {

    override fun accept(project: Project, file: VirtualFile): Boolean = file is WorkingMemoryVirtualFile

    override fun createEditor(project: Project, file: VirtualFile): FileEditor =
        WorkingMemoryFileEditor(project, file as WorkingMemoryVirtualFile)

    override fun getEditorTypeId(): String = "jollimemory-working-memory"

    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.HIDE_DEFAULT_EDITOR
}

package ai.jolli.jollimemory.toolwindow

import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile

/** Provides the custom editor for [CreatePrVirtualFile] instances. */
class CreatePrEditorProvider : FileEditorProvider, DumbAware {

    override fun accept(project: Project, file: VirtualFile): Boolean = file is CreatePrVirtualFile

    override fun createEditor(project: Project, file: VirtualFile): FileEditor =
        CreatePrFileEditor(project, file as CreatePrVirtualFile)

    override fun getEditorTypeId(): String = "jollimemory-create-pr"

    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.HIDE_DEFAULT_EDITOR
}

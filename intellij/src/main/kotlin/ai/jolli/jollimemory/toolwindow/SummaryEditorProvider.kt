package ai.jolli.jollimemory.toolwindow

import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile

/**
 * Provides a custom editor for SummaryVirtualFile instances.
 * This allows commit memories to open as tabs in the main editor area,
 * matching how VS Code embeds its webview panels.
 */
class SummaryEditorProvider : FileEditorProvider, DumbAware {

    override fun accept(project: Project, file: VirtualFile): Boolean {
        return file is SummaryVirtualFile
    }

    override fun createEditor(project: Project, file: VirtualFile): FileEditor {
        val summaryFile = file as SummaryVirtualFile
        return SummaryFileEditor(project, summaryFile)
    }

    override fun getEditorTypeId(): String = "jollimemory-summary"

    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.HIDE_DEFAULT_EDITOR
}

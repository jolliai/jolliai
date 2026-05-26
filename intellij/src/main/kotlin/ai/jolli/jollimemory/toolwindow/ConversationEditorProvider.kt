package ai.jolli.jollimemory.toolwindow

import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile

/**
 * Provides a custom editor for [ConversationVirtualFile] instances.
 * This allows conversation transcripts to open as tabs in the main editor
 * area, matching how VS Code embeds its webview panels.
 */
class ConversationEditorProvider : FileEditorProvider, DumbAware {

	override fun accept(project: Project, file: VirtualFile): Boolean {
		return file is ConversationVirtualFile
	}

	override fun createEditor(project: Project, file: VirtualFile): FileEditor {
		val convFile = file as ConversationVirtualFile
		return ConversationFileEditor(project, convFile)
	}

	override fun getEditorTypeId(): String = "jollimemory-conversation"

	override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.HIDE_DEFAULT_EDITOR
}

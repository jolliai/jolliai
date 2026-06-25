package ai.jolli.jollimemory.toolwindow

import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.TextEditorWithPreview
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile

/**
 * Opens a (markdown) file and switches it to **preview** mode, matching the
 * mockup's rendered plan/note/reference panes.
 *
 * The bundled Markdown plugin registers a [TextEditorWithPreview] for `.md` files;
 * we flip its layout to preview-only. If no preview editor is available (plain
 * text fallback), the file just opens normally.
 */
object MarkdownPreview {
	fun open(project: Project, vf: VirtualFile) {
		val editors = FileEditorManager.getInstance(project).openFile(vf, true)
		for (editor in editors) {
			if (editor is TextEditorWithPreview) {
				editor.setLayout(TextEditorWithPreview.Layout.SHOW_PREVIEW)
			}
		}
	}
}

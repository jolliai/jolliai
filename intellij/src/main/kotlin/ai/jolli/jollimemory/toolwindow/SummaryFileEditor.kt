package ai.jolli.jollimemory.toolwindow

import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.UserDataHolderBase
import java.beans.PropertyChangeListener
import javax.swing.JComponent

/**
 * FileEditor implementation that embeds a SummaryPanel as an editor tab.
 * This allows commit memories to open in the main editor area,
 * matching how VS Code embeds its webview panels.
 */
class SummaryFileEditor(
    project: Project,
    private val file: SummaryVirtualFile,
) : UserDataHolderBase(), FileEditor {

    private val panel = SummaryPanel(project, file.summary)

    override fun getComponent(): JComponent = panel

    override fun getPreferredFocusedComponent(): JComponent = panel

    override fun getName(): String = "Commit Memory"

    override fun setState(state: FileEditorState) {}

    override fun isModified(): Boolean = false

    override fun isValid(): Boolean = true

    override fun addPropertyChangeListener(listener: PropertyChangeListener) {}

    override fun removePropertyChangeListener(listener: PropertyChangeListener) {}

    override fun getFile() = file

    override fun dispose() {
        panel.dispose()
    }
}

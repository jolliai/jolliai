package ai.jolli.jollimemory.toolwindow

import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.UserDataHolderBase
import java.beans.PropertyChangeListener
import javax.swing.JComponent

/** FileEditor that embeds a [CreatePrPanel] as an editor tab. */
class CreatePrFileEditor(
    project: Project,
    private val file: CreatePrVirtualFile,
) : UserDataHolderBase(), FileEditor {

    private val panel = CreatePrPanel(project, file.vm)

    override fun getComponent(): JComponent = panel
    override fun getPreferredFocusedComponent(): JComponent = panel
    override fun getName(): String = "Create PR"
    override fun setState(state: FileEditorState) {}
    override fun isModified(): Boolean = false
    override fun isValid(): Boolean = true
    override fun addPropertyChangeListener(listener: PropertyChangeListener) {}
    override fun removePropertyChangeListener(listener: PropertyChangeListener) {}
    override fun getFile() = file
    override fun dispose() { panel.dispose() }
}

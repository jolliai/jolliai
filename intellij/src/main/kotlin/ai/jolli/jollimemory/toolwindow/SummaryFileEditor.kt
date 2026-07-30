package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.CommitSummary
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
 *
 * REUSE: a single instance is kept alive across memory switches by
 * [MemoryTabOpener]. Instead of disposing this editor and opening a new tab
 * per memory (which would trigger a fresh NSView attach on macOS), the same
 * SummaryFileEditor is re-used and its content is swapped via
 * [updateSummary]. See [SummaryPanel.setSummary] for the swap details.
 */
class SummaryFileEditor(
    project: Project,
    private val file: SummaryVirtualFile,
) : UserDataHolderBase(), FileEditor {

    private val panel = SummaryPanel(project, file.summary, file.readOnly)

    /**
     * Swap the displayed memory in place. Called by [MemoryTabOpener] when the
     * user clicks another memory in a list while this tab is already open.
     */
    fun updateSummary(newSummary: CommitSummary, newReadOnly: Boolean) {
        panel.setSummary(newSummary, newReadOnly)
    }

    /** Opens the inline share overlay in the embedded webview (Commits-list / sidebar Share). */
    fun requestOpenShare(branchShare: Boolean = false) = panel.openShare(branchShare)

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

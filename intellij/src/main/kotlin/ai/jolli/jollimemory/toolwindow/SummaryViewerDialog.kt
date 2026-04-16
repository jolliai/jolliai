package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.CommitSummary
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import java.awt.Dimension
import javax.swing.JComponent

/**
 * Legacy dialog wrapper around SummaryPanel.
 * Kept as a fallback — the primary way to view summaries is now via editor tabs
 * (see SummaryFileEditor / SummaryEditorProvider).
 */
class SummaryViewerDialog(
    private val project: Project,
    private val summary: CommitSummary,
) : DialogWrapper(project, true) {

    private var panel: SummaryPanel? = null

    init {
        title = "Commit Memory: ${summary.commitHash.take(8)}"
        isModal = false
        init()
    }

    override fun createCenterPanel(): JComponent {
        val p = SummaryPanel(project, summary)
        panel = p
        p.preferredSize = Dimension(900, 700)
        return p
    }

    override fun createActions(): Array<javax.swing.Action> = emptyArray()

    override fun dispose() {
        panel?.dispose()
        super.dispose()
    }
}

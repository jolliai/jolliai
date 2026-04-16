package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.toolwindow.SummaryVirtualFile
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.ui.Messages

/**
 * View the JolliMemory summary for the most recent commit in an editor tab.
 * Opens the summary as an embedded webview panel (like VS Code).
 */
class ViewSummaryAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = project.getService(JolliMemoryService::class.java)

        ApplicationManager.getApplication().executeOnPooledThread {
            val commits = service.getBranchCommits()
            val target = commits.firstOrNull { it.hasSummary }

            if (target == null) {
                ApplicationManager.getApplication().invokeLater {
                    Messages.showInfoMessage(project, "No commit memories found on this branch.", "Jolli Memory")
                }
                return@executeOnPooledThread
            }

            val summary = service.getSummary(target.hash)
            ApplicationManager.getApplication().invokeLater {
                if (summary != null) {
                    val vFile = SummaryVirtualFile(summary)
                    FileEditorManager.getInstance(project).openFile(vFile, true)
                } else {
                    Messages.showInfoMessage(project, "No summary found for ${target.hash.take(8)}.", "Jolli Memory")
                }
            }
        }
    }

    override fun update(e: AnActionEvent) {
        val status = e.project?.getService(JolliMemoryService::class.java)?.getStatus()
        e.presentation.isEnabled = status != null && status.enabled
    }
}

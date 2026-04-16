package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.ui.Messages

/**
 * Push current branch to remote with upstream tracking.
 * Matches VS Code PushCommand.ts.
 */
class PushAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = project.getService(JolliMemoryService::class.java)
        val cwd = service.mainRepoRoot ?: project.basePath ?: return
        val git = service.getGitOps() ?: return

        if (SessionTracker.isWorkerBusy(cwd)) {
            Messages.showWarningDialog(project,
                "AI summary is being generated. Please wait a moment.",
                "Jolli Memory")
            return
        }

        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Jolli Memory: Pushing...", false) {
            override fun run(indicator: ProgressIndicator) {
                val branch = git.getCurrentBranch()
                if (branch.isNullOrBlank()) {
                    ApplicationManager.getApplication().invokeLater {
                        Messages.showErrorDialog(project, "Cannot determine current branch.", "Push Failed")
                    }
                    return
                }

                indicator.text = "Pushing $branch to origin..."
                val result = git.exec("push", "-u", "origin", branch, timeoutSeconds = 60)

                ApplicationManager.getApplication().invokeLater {
                    if (result != null) {
                        Messages.showInfoMessage(project, "Pushed $branch to origin.", "Jolli Memory")
                    } else {
                        Messages.showErrorDialog(
                            project,
                            "Push may have failed for $branch. Check git output for details.",
                            "Push Warning"
                        )
                    }
                    service.refreshStatus()
                }
            }
        })
    }

    override fun update(e: AnActionEvent) {
        val service = e.project?.getService(JolliMemoryService::class.java)
        val status = service?.getStatus()
        val cwd = service?.mainRepoRoot ?: e.project?.basePath
        val workerBusy = cwd != null && SessionTracker.isWorkerBusy(cwd)
        e.presentation.isEnabled = status != null && status.enabled && !workerBusy
    }
}

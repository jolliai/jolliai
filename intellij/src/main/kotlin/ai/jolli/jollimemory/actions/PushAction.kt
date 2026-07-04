package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.util.ForcePushUtil
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.ui.Messages

/**
 * Push current branch to remote with upstream tracking.
 * On non-fast-forward rejection, offers a force-push confirmation via
 * [ForcePushUtil.gateForcePush] with divergence inspection.
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
                val result = git.execWithResult("push", "-u", "origin", branch, timeoutSeconds = 60)

                if (result.exitCode == 0) {
                    ApplicationManager.getApplication().invokeLater {
                        Messages.showInfoMessage(project, "Pushed $branch to origin.", "Jolli Memory")
                        service.refreshStatus()
                    }
                    return
                }

                if (!ForcePushUtil.isNonFastForwardError(result.stderr)) {
                    ApplicationManager.getApplication().invokeLater {
                        Messages.showErrorDialog(project, "Push failed for $branch:\n\n${result.stderr}", "Push Failed")
                        service.refreshStatus()
                    }
                    return
                }

                // NFF rejection — inspect divergence off the EDT (git fetch), then
                // show the gate dialog on the EDT, then force-push off the EDT again.
                val safety = ForcePushUtil.inspectForcePushSafety(git, branch)
                var outcome = ForcePushUtil.ForcePushOutcome.DECLINED
                ApplicationManager.getApplication().invokeAndWait {
                    outcome = ForcePushUtil.gateForcePush(
                        project, branch, safety,
                        reason = "Remote branch has diverged. Force push will overwrite remote history.",
                    )
                }

                if (outcome == ForcePushUtil.ForcePushOutcome.CONFIRMED) {
                    val forceResult = ForcePushUtil.forcePushBranch(git, branch)
                    ApplicationManager.getApplication().invokeLater {
                        if (forceResult.exitCode == 0) {
                            Messages.showInfoMessage(project, "Force-pushed $branch to origin.", "Jolli Memory")
                        } else {
                            Messages.showErrorDialog(project, "Force push failed:\n\n${forceResult.stderr}", "Push Failed")
                        }
                        service.refreshStatus()
                    }
                } else {
                    ApplicationManager.getApplication().invokeLater {
                        service.refreshStatus()
                    }
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

package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager

/** Installs JolliMemory hooks (Claude Code Stop, Git post-commit, post-rewrite, prepare-commit-msg). */
class EnableAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = project.getService(JolliMemoryService::class.java)

        ApplicationManager.getApplication().executeOnPooledThread {
            // Initialize service if not yet done
            val status = service.getStatus()
            if (status == null) {
                service.initialize()
            }

            service.install()
        }
    }

    override fun update(e: AnActionEvent) {
        val project = e.project
        val status = project?.getService(JolliMemoryService::class.java)?.getStatus()
        e.presentation.isEnabledAndVisible = status != null && !status.enabled
    }
}

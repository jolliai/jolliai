package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager

/** Removes JolliMemory hooks. */
class DisableAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = project.getService(JolliMemoryService::class.java)
        ApplicationManager.getApplication().executeOnPooledThread {
            service.uninstall()
        }
    }

    override fun update(e: AnActionEvent) {
        val project = e.project
        val status = project?.getService(JolliMemoryService::class.java)?.getStatus()
        e.presentation.isEnabledAndVisible = status != null && status.enabled
    }
}

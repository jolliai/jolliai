package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager

/** Refreshes the Memories panel by re-reading the orphan branch index. */
class RefreshMemoriesAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = project.getService(JolliMemoryService::class.java)
        ApplicationManager.getApplication().executeOnPooledThread {
            service.refreshStatus()
        }
    }
}

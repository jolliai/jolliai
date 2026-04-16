package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

/** Clears the active search filter on the Memories panel. */
class ClearMemoryFilterAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = project.getService(JolliMemoryService::class.java)
        service.panelRegistry?.memoriesPanel?.setFilter("")
    }

    override fun update(e: AnActionEvent) {
        val project = e.project
        val panel = project?.getService(JolliMemoryService::class.java)?.panelRegistry?.memoriesPanel
        // Only show when a filter is active
        e.presentation.isEnabledAndVisible = panel != null && panel.getFilter().isNotEmpty()
    }
}

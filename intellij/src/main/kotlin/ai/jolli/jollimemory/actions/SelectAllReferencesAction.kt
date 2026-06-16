package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

/** Toggles selection of all references in the Plans & Notes panel. */
class SelectAllReferencesAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val registry = project.getService(JolliMemoryService::class.java).panelRegistry
        registry?.plansPanel?.toggleSelectAll()
    }

    override fun update(e: AnActionEvent) {
        val status = e.project?.getService(JolliMemoryService::class.java)?.getStatus()
        e.presentation.isEnabled = status != null && status.enabled
    }
}

package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

/** Toggles selection of all files in the Changes panel. */
class SelectAllFilesAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val registry = project.getService(JolliMemoryService::class.java).panelRegistry
        registry?.changesPanel?.toggleSelectAll()
    }

    override fun update(e: AnActionEvent) {
        val status = e.project?.getService(JolliMemoryService::class.java)?.getStatus()
        e.presentation.isEnabled = status != null && status.enabled
    }
}

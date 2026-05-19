package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

/** Discards changes for all selected files in the Changes panel. */
class DiscardSelectedAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val registry = project.getService(JolliMemoryService::class.java).panelRegistry
        registry?.changesPanel?.discardSelected()
    }

    override fun update(e: AnActionEvent) {
        val service = e.project?.getService(JolliMemoryService::class.java)
        val status = service?.getStatus()
        val selectedFiles = service?.panelRegistry?.changesPanel?.getSelectedFiles()
        e.presentation.isEnabled = status != null && status.enabled && !selectedFiles.isNullOrEmpty()
    }
}

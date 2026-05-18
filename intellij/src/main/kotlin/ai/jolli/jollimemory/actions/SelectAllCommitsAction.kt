package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.toolwindow.CommitsPanel
import ai.jolli.jollimemory.toolwindow.PanelRegistry
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

/** Toggles selection of all commits in the Commits panel. */
class SelectAllCommitsAction : AnAction() {
	override fun actionPerformed(e: AnActionEvent) {
		val project = e.project ?: return
		val registry = project.getService(JolliMemoryService::class.java).panelRegistry
		val panel = registry?.commitsPanel ?: return
		if (panel.isForeignMode) return
		panel.toggleSelectAll()
	}

	override fun update(e: AnActionEvent) {
		val service = e.project?.getService(JolliMemoryService::class.java)
		val status = service?.getStatus()
		val isForeign = service?.panelRegistry?.commitsPanel?.isForeignMode == true
		e.presentation.isEnabled = status != null && status.enabled && !isForeign
	}
}

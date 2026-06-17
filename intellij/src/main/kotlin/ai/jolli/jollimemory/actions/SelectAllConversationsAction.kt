package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

/** Toggles selection of all conversations in the Conversations panel. */
class SelectAllConversationsAction : AnAction() {
	override fun actionPerformed(e: AnActionEvent) {
		val project = e.project ?: return
		val registry = project.getService(JolliMemoryService::class.java).panelRegistry
		registry?.activeConversationsPanel?.toggleSelectAll()
	}

	override fun update(e: AnActionEvent) {
		val status = e.project?.getService(JolliMemoryService::class.java)?.getStatus()
		e.presentation.isEnabled = status != null && status.enabled
	}
}

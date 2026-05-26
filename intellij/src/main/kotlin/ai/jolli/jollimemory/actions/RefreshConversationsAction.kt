package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

/** Refreshes the Conversations panel by re-querying all session sources. */
class RefreshConversationsAction : AnAction() {
	override fun actionPerformed(e: AnActionEvent) {
		val project = e.project ?: return
		val service = project.getService(JolliMemoryService::class.java)
		service.panelRegistry?.activeConversationsPanel?.refresh()
	}
}

package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ui.Messages

/** Opens an input dialog to search/filter memories by commit message or branch name. */
class SearchMemoriesAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = project.getService(JolliMemoryService::class.java)
        val panel = service.panelRegistry?.memoriesPanel ?: return

        val currentFilter = panel.getFilter()
        val result = Messages.showInputDialog(
            project,
            "Search memories by commit message or branch name:",
            "Search Memories",
            null,
            currentFilter,
            null,
        )

        // null means the user cancelled; empty string means clear filter
        if (result != null) {
            panel.setFilter(result)
        }
    }
}

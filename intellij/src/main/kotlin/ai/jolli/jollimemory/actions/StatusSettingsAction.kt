package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.toolwindow.SettingsDialog
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

/**
 * Opens the Jolli Memory Settings dialog from the MEMORIES panel toolbar.
 * Matches the VS Code Settings webview with Scope, AI Configuration,
 * Integrations, and Files sections.
 */
class StatusSettingsAction : AnAction(
    "Settings",
    "Jolli Memory settings",
    AllIcons.General.GearPlain,
) {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = project.getService(JolliMemoryService::class.java)
        val dialog = SettingsDialog(project, service)
        dialog.show()
    }
}

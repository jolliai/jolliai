package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.toolwindow.CollapsiblePanel
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.ToggleAction

/**
 * Toggle action for showing/hiding a collapsible panel in the tool window gear menu.
 * When checked, the panel is visible; when unchecked, the entire panel (header + content) is hidden.
 *
 * This mirrors VS Code's "..." menu on view containers where each section can be toggled.
 */
class TogglePanelAction(
    private val panel: CollapsiblePanel,
) : ToggleAction(panel.getTitle(), "Show or hide the ${panel.getTitle()} panel", null) {

    override fun isSelected(e: AnActionEvent): Boolean = panel.isPanelVisible()

    override fun setSelected(e: AnActionEvent, state: Boolean) {
        panel.setPanelVisible(state)
    }
}

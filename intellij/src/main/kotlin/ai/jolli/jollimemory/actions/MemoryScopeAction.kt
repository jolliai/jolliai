package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.Dimension
import javax.swing.BoxLayout
import javax.swing.DefaultComboBoxModel
import javax.swing.JComboBox
import javax.swing.JPanel

/**
 * Toolbar action that shows a popup with a scope dropdown for the Memories panel.
 * Scope options: Current Branch (default), Current Repository, Memory Bank.
 */
class MemoryScopeAction : AnAction(
	"Filter Scope",
	"Filter memories by scope",
	AllIcons.General.Filter,
) {
	override fun actionPerformed(e: AnActionEvent) {
		val project = e.project ?: return
		val service = project.getService(JolliMemoryService::class.java)
		val memoriesPanel = service.panelRegistry?.memoriesPanel ?: return
		val component = e.inputEvent?.component ?: return

		val currentScope = memoriesPanel.scope

		val scopeLabels = arrayOf(
			"Current Branch",
			"Current Repository",
		)
		val scopeValues = arrayOf("branch", "repo")
		val currentIndex = scopeValues.indexOf(currentScope).coerceAtLeast(0)

		val combo = JComboBox(DefaultComboBoxModel(scopeLabels)).apply {
			selectedIndex = currentIndex
			maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
		}

		val panel = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.Y_AXIS)
			border = JBUI.Borders.empty(10, 12)
			add(JBLabel("Show memories from:").apply {
				border = JBUI.Borders.emptyBottom(6)
			})
			add(combo)
		}

		val popup = JBPopupFactory.getInstance()
			.createComponentPopupBuilder(panel, combo)
			.setRequestFocus(true)
			.createPopup()

		combo.addActionListener {
			val selectedIndex = combo.selectedIndex
			if (selectedIndex in scopeValues.indices) {
				memoriesPanel.setScope(scopeValues[selectedIndex])
			}
			popup.cancel()
		}

		popup.showUnderneathOf(component)
	}
}

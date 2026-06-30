package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliColors
import com.intellij.util.ui.JBUI
import java.awt.Color
import java.awt.Cursor
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import java.awt.Graphics
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.SwingConstants
import javax.swing.UIManager

/**
 * Persistent three-segment view switch shown at the very top of the sidebar
 * content, mirroring the redesign mockup's `.view-switch`:
 *
 *   Current Branch  |  Memory Bank  |  Knowledge
 *
 * The active segment is emphasized (bold) and underlined with the Jolli accent;
 * inactive segments use the muted description foreground and highlight on hover.
 * Selecting a segment fires [onViewSelected]; the factory swaps content cards and
 * adjusts the breadcrumb / bottom action bar in response.
 */
class ViewSwitchPanel(
	private val onViewSelected: (View) -> Unit,
) : JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(2), 0)) {

	enum class View { CURRENT, BANK, KNOWLEDGE }

	private val tabs = linkedMapOf(
		View.CURRENT to "Current Branch",
		View.BANK to "Memory Bank",
	).apply {
		// Knowledge (wiki + decision graph) is still a placeholder — hide the tab
		// until it's built. The View.KNOWLEDGE enum + handler stay so re-enabling
		// is a one-line flag flip.
		if (FeatureFlags.SHOW_UNFINISHED) put(View.KNOWLEDGE, "Knowledge")
	}

	private val labels = mutableMapOf<View, TabLabel>()
	private var selected: View = View.CURRENT

	init {
		border = JBUI.Borders.empty(2, 6)
		isOpaque = false
		for ((view, text) in tabs) {
			val label = TabLabel(text, view)
			labels[view] = label
			add(label)
		}
		updateStyles()
	}

	/** Programmatically select a view without firing [onViewSelected]. */
	fun setSelected(view: View) {
		if (selected == view) return
		selected = view
		updateStyles()
	}

	fun getSelected(): View = selected

	private fun select(view: View) {
		if (selected == view) return
		selected = view
		updateStyles()
		onViewSelected(view)
	}

	private fun updateStyles() {
		for ((view, label) in labels) {
			label.active = view == selected
			label.repaint()
		}
	}

	private val mutedFg: Color
		get() = UIManager.getColor("Label.disabledForeground")
			?: UIManager.getColor("Component.infoForeground")
			?: JBUI.CurrentTheme.Label.disabledForeground()

	private val activeFg: Color
		get() = UIManager.getColor("Label.foreground") ?: foreground

	private val hoverBg: Color
		get() = UIManager.getColor("ActionButton.hoverBackground")
			?: JBUI.CurrentTheme.ActionButton.hoverBackground()

	/** A single clickable tab that paints its own accent underline when active. */
	private inner class TabLabel(text: String, val view: View) : JLabel(text, SwingConstants.CENTER) {
		var active: Boolean = false
		private var hovered: Boolean = false

		init {
			cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
			border = JBUI.Borders.empty(4, 8, 6, 8)
			isOpaque = false
			addMouseListener(object : MouseAdapter() {
				override fun mouseClicked(e: MouseEvent) = select(view)
				override fun mouseEntered(e: MouseEvent) { hovered = true; repaint() }
				override fun mouseExited(e: MouseEvent) { hovered = false; repaint() }
			})
		}

		override fun getPreferredSize(): Dimension {
			// Reserve width for the bold variant so the layout doesn't jump on selection.
			val boldMetrics = getFontMetrics(font.deriveFont(Font.BOLD))
			val w = boldMetrics.stringWidth(text) + JBUI.scale(16)
			val h = super.getPreferredSize().height
			return Dimension(w, h)
		}

		override fun paintComponent(g: Graphics) {
			font = if (active) font.deriveFont(Font.BOLD) else font.deriveFont(Font.PLAIN)
			foreground = if (active) activeFg else mutedFg

			if (hovered && !active) {
				g.color = hoverBg
				g.fillRoundRect(0, 0, width, height, JBUI.scale(6), JBUI.scale(6))
			}
			super.paintComponent(g)

			if (active) {
				g.color = JolliColors.Accent
				val thickness = JBUI.scale(2)
				g.fillRect(JBUI.scale(6), height - thickness, width - JBUI.scale(12), thickness)
			}
		}
	}
}

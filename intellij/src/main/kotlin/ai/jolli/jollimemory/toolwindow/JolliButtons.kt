package ai.jolli.jollimemory.toolwindow

import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import java.awt.Color
import java.awt.Cursor
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import javax.swing.Icon
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.SwingConstants
import javax.swing.plaf.basic.BasicButtonUI

/**
 * Shared primary-button styling for the redesigned sidebar (Commit, Create PR, …).
 *
 * Dark theme: dark-blue fill + white text. Light theme: the reverse — white fill +
 * dark-blue text. A 1px dark-blue outline keeps the light-theme variant visible.
 * The colors flip automatically via [JBColor] (regular = light, dark = dark theme).
 */
object JolliButtons {
	private val DARK_BLUE = Color(0x0E4A86)
	// Primary (Commit): dark-blue fill / white text in dark theme; reversed in light.
	private val PRIMARY_BG = JBColor(Color.WHITE, DARK_BLUE)
	private val PRIMARY_FG = JBColor(DARK_BLUE, Color.WHITE)
	private val PRIMARY_OUTLINE = JBColor(DARK_BLUE, DARK_BLUE)
	private val PRIMARY_DISABLED = JBColor(Color(0xE5E5E5), Color(0x2B3B52))

	// Secondary (Create PR, …): dark-grey fill in dark theme; light-grey in light theme.
	private val SECONDARY_BG = JBColor(Color(0xDADBDE), Color(0x3A3D41))
	private val SECONDARY_FG = JBColor(Color(0x1F1F1F), Color(0xDFDFDF))
	private val SECONDARY_OUTLINE = JBColor(Color(0xC2C4C8), Color(0x55585B))
	private val SECONDARY_DISABLED = JBColor(Color(0xEDEDED), Color(0x2C2E30))

	fun primary(text: String, icon: Icon? = null): JButton =
		styled(text, icon, PRIMARY_BG, PRIMARY_FG, PRIMARY_OUTLINE, PRIMARY_DISABLED)

	fun secondary(text: String, icon: Icon? = null): JButton =
		styled(text, icon, SECONDARY_BG, SECONDARY_FG, SECONDARY_OUTLINE, SECONDARY_DISABLED)

	private fun styled(
		text: String,
		icon: Icon?,
		bg: JBColor,
		fg: JBColor,
		outline: JBColor,
		disabledBg: JBColor,
	): JButton = JButton(text, icon).apply {
		cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
		isFocusPainted = false
		isContentAreaFilled = false
		isBorderPainted = false
		isOpaque = false
		horizontalAlignment = SwingConstants.CENTER
		border = JBUI.Borders.empty(7, 14)
		foreground = fg
		ui = object : BasicButtonUI() {
			override fun paint(g: Graphics, c: JComponent) {
				val g2 = g.create() as Graphics2D
				g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
				val arc = JBUI.scale(8)
				val btn = c as JButton
				g2.color = if (btn.isEnabled) bg else disabledBg
				g2.fillRoundRect(0, 0, c.width, c.height, arc, arc)
				g2.color = outline
				g2.drawRoundRect(0, 0, c.width - 1, c.height - 1, arc, arc)
				g2.dispose()
				btn.foreground = fg
				super.paint(g, c)
			}
		}
	}
}

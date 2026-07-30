package ai.jolli.jollimemory.toolwindow

import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import java.awt.Color
import java.awt.Dimension
import java.awt.Font
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import javax.swing.JLabel
import javax.swing.SwingConstants

/**
 * Small rounded, filled badge painting a 1–2 letter context tag (mockup `kb-tag`).
 *
 * White letter on a solid coloured pill — matches VSCode's `.kb-tag t-ref
 * src-<source>` styling (see `SidebarCssBuilder.buildKbTagCss`), so plan / note /
 * reference badges read identically between the two IDEs.
 *
 * Shared by PlansPanel (CONTEXT rows / hover popups) and CommitsPanel
 * (COMMITTED MEMORIES → CONTEXT sub-group) so the badge look doesn't drift.
 * Pin colors are provided by [ai.jolli.jollimemory.core.references.SourceDisplay]
 * (mirroring VSCode's `SOURCE_META`) — do not hard-code hex values at call sites.
 */
class TagLabel : JLabel("", SwingConstants.CENTER) {
	private var badgeColor: Color = JBColor.GRAY

	init {
		isOpaque = false
		foreground = Color.WHITE
		font = JBUI.Fonts.label(9f).deriveFont(Font.BOLD)
	}

	fun setBadge(text: String, color: Color) {
		this.text = text
		this.badgeColor = color
	}

	override fun getPreferredSize(): Dimension =
		Dimension(JBUI.scale(if (text.length > 1) 24 else 18), JBUI.scale(16))

	override fun paintComponent(g: Graphics) {
		val g2 = g.create() as Graphics2D
		try {
			g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
			g2.color = badgeColor
			val arc = JBUI.scale(6)
			g2.fillRoundRect(0, 0, width - 1, height - 1, arc, arc)
		} finally {
			g2.dispose()
		}
		super.paintComponent(g)
	}
}

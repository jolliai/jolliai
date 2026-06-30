package ai.jolli.jollimemory.toolwindow

import com.intellij.ui.JBColor
import java.awt.Color
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Shared row-styling primitives for the sidebar panels (Pinned, Current Memory,
 * Committed Memories, Changes). These were copy-pasted into each panel; keeping
 * one definition stops the hover tint and the vertical-centering wrapper from
 * drifting apart across panels.
 */
object RowStyle {
	/** Subtle row-hover tint — faint dark overlay on light themes, faint light overlay on dark. */
	val HOVER_BG = JBColor(Color(0, 0, 0, 20), Color(255, 255, 255, 20))

	/** Wraps [c] in a single-cell GridBag panel that vertically centers it within the row. */
	fun vCenter(c: JComponent): JPanel = JPanel(GridBagLayout()).apply {
		isOpaque = false
		add(c, GridBagConstraints())
	}
}

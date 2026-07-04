package ai.jolli.jollimemory.toolwindow

import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.Component
import java.awt.Cursor
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Shared "show up to N rows, then collapse the rest behind a *Show N more* row"
 * behavior for the row-list sub-sections inside [CurrentMemoryPanel]
 * (Conversations / Context / Files).
 *
 * The sections render directly (no inner scrollbar) so that Current Memory shows a
 * single outer scrollbar covering all three once the combined content overflows.
 */
object CappedRows {
	/** Maximum rows shown before collapsing behind "Show N more". */
	const val CAP = 6

	/**
	 * Renders [rows] into [container] (a `BoxLayout.Y_AXIS` panel). Shows at most
	 * [CAP] rows unless [expanded]; when collapsed with more than [CAP] rows, appends
	 * a clickable "Show N more" row that invokes [onShowMore].
	 */
	fun render(container: JPanel, rows: List<JComponent>, expanded: Boolean, onShowMore: () -> Unit) {
		container.removeAll()
		val visible = if (expanded) rows else rows.take(CAP)
		for (r in visible) {
			r.alignmentX = Component.LEFT_ALIGNMENT
			container.add(r)
		}
		if (!expanded && rows.size > CAP) {
			container.add(showMoreRow(rows.size - CAP, onShowMore))
		}
		container.revalidate()
		container.repaint()
	}

	/**
	 * A clickable "Show N more" row (down-chevron-free, link-styled). Exposed so
	 * lists that page incrementally rather than toggling all-at-once (e.g. the
	 * commit list in [CommitsPanel]) can reuse the exact styling.
	 */
	fun showMoreRow(remaining: Int, onClick: () -> Unit): JComponent {
		val link = JBLabel("Show $remaining more").apply {
			foreground = com.intellij.ui.JBColor.namedColor("Link.activeForeground", com.intellij.ui.JBColor.BLUE)
			font = font.deriveFont(font.size2D - 1f).deriveFont(Font.PLAIN)
			cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
		}
		return JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(2), 0)).apply {
			isOpaque = false
			alignmentX = Component.LEFT_ALIGNMENT
			border = JBUI.Borders.empty(2, 26, 2, 0)
			maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(22))
			add(link)
			cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
			addMouseListener(object : MouseAdapter() {
				override fun mouseClicked(e: MouseEvent) = onClick()
			})
			link.addMouseListener(object : MouseAdapter() {
				override fun mouseClicked(e: MouseEvent) = onClick()
			})
		}
	}
}

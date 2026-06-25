package ai.jolli.jollimemory.toolwindow

import com.intellij.util.ui.JBUI
import java.awt.Dimension
import java.awt.Rectangle
import javax.swing.JPanel
import javax.swing.JViewport
import javax.swing.Scrollable

/**
 * Vertical scroll content panel that tracks the viewport **width** (so long rows
 * never trigger a horizontal scrollbar) and:
 * - fills the viewport **height** when its content is shorter (no scrollbar, the
 *   trailing glue absorbs the slack), and
 * - keeps its natural (preferred) height when taller, so a single vertical
 *   scrollbar covers the whole stack.
 *
 * Used for the sidebar's top-level accordion stack (Pinned → Current Memory →
 * Committed Memories) so one scrollbar spans all three sections.
 */
class WidthTrackingPanel : JPanel(), Scrollable {
	override fun getPreferredScrollableViewportSize(): Dimension = preferredSize
	override fun getScrollableUnitIncrement(visibleRect: Rectangle, orientation: Int, direction: Int): Int = JBUI.scale(16)
	override fun getScrollableBlockIncrement(visibleRect: Rectangle, orientation: Int, direction: Int): Int = visibleRect.height
	override fun getScrollableTracksViewportWidth(): Boolean = true
	override fun getScrollableTracksViewportHeight(): Boolean {
		val vp = parent
		return vp is JViewport && preferredSize.height <= vp.height
	}
}

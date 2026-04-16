package ai.jolli.jollimemory.toolwindow

import com.intellij.util.ui.JBUI
import java.awt.Cursor
import java.awt.Dimension
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.JPanel
import javax.swing.UIManager

/**
 * A thin horizontal divider bar that can be dragged to resize the panels above and below it.
 * When dragged, it notifies the parent [AccordionLayout] to redistribute space between
 * the adjacent expanded panels.
 */
class ResizeDivider : JPanel() {

    private var dragStartY = 0
    private var dragging = false

    init {
        cursor = Cursor.getPredefinedCursor(Cursor.N_RESIZE_CURSOR)
        isOpaque = true
        background = UIManager.getColor("Separator.separatorColor") ?: java.awt.Color.GRAY
        preferredSize = Dimension(0, JBUI.scale(4))
        minimumSize = Dimension(0, JBUI.scale(4))
        maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(4))

        val mouseHandler = object : MouseAdapter() {
            override fun mousePressed(e: MouseEvent) {
                dragStartY = e.yOnScreen
                dragging = true
                e.consume()
            }

            override fun mouseReleased(e: MouseEvent) {
                dragging = false
                e.consume()
            }

            override fun mouseDragged(e: MouseEvent) {
                if (!dragging) return
                val deltaY = e.yOnScreen - dragStartY
                dragStartY = e.yOnScreen

                val parentPanel = parent ?: return
                val layout = parentPanel.layout as? AccordionLayout ?: return
                layout.handleDividerDrag(parentPanel, this@ResizeDivider, deltaY)
                e.consume()
            }
        }
        addMouseListener(mouseHandler)
        addMouseMotionListener(mouseHandler)
    }
}

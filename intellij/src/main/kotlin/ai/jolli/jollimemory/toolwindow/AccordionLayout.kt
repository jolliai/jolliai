package ai.jolli.jollimemory.toolwindow

import java.awt.Component
import java.awt.Container
import java.awt.Dimension
import java.awt.LayoutManager

/**
 * A vertical accordion layout manager that distributes space among child components.
 *
 * - [ResizeDivider] components receive their fixed preferred height (drag handle).
 * - Collapsed [CollapsiblePanel]s receive only their preferred (header) height.
 * - Expanded panels share the remaining vertical space proportionally based on
 *   user-assigned weights (default weight = 1.0, adjusted by dragging dividers).
 * - Each expanded panel is guaranteed at least its [Component.getMinimumSize] height.
 *   When available space is insufficient, panels receive their minimum heights and
 *   the container overflows (a wrapping JScrollPane should be used to handle this).
 */
class AccordionLayout : LayoutManager {

    /** Per-component weight for expanded panels. Default is 1.0 (equal share). */
    private val weights = mutableMapOf<Component, Double>()

    override fun addLayoutComponent(name: String?, comp: Component?) {}
    override fun removeLayoutComponent(comp: Component?) {
        if (comp != null) weights.remove(comp)
    }

    override fun preferredLayoutSize(parent: Container): Dimension {
        val insets = parent.insets
        var totalHeight = insets.top + insets.bottom
        var maxWidth = 0
        for (i in 0 until parent.componentCount) {
            val comp = parent.getComponent(i)
            if (!comp.isVisible) continue
            val pref = comp.preferredSize
            totalHeight += pref.height
            maxWidth = maxOf(maxWidth, pref.width)
        }
        return Dimension(maxWidth + insets.left + insets.right, totalHeight)
    }

    override fun minimumLayoutSize(parent: Container): Dimension {
        val insets = parent.insets
        var totalHeight = insets.top + insets.bottom
        var maxWidth = 0
        for (i in 0 until parent.componentCount) {
            val comp = parent.getComponent(i)
            if (!comp.isVisible) continue
            val min = comp.minimumSize
            totalHeight += min.height
            maxWidth = maxOf(maxWidth, min.width)
        }
        return Dimension(maxWidth + insets.left + insets.right, totalHeight)
    }

    override fun layoutContainer(parent: Container) {
        val insets = parent.insets
        val availableWidth = parent.width - insets.left - insets.right
        val availableHeight = parent.height - insets.top - insets.bottom

        // Collect visible components
        val visibleComponents = mutableListOf<Component>()
        for (i in 0 until parent.componentCount) {
            val comp = parent.getComponent(i)
            if (comp.isVisible) visibleComponents.add(comp)
        }

        // Calculate fixed height for collapsed panels and dividers
        var fixedHeight = 0
        val expandedPanels = mutableListOf<Component>()
        for (comp in visibleComponents) {
            when {
                comp is ResizeDivider -> fixedHeight += comp.preferredSize.height
                comp is CollapsiblePanel && !comp.isExpanded() -> fixedHeight += comp.preferredSize.height
                else -> expandedPanels.add(comp)
            }
        }

        // Calculate total weight of expanded panels
        var totalWeight = 0.0
        for (panel in expandedPanels) {
            totalWeight += weights.getOrDefault(panel, 1.0)
        }
        if (totalWeight <= 0.0) totalWeight = 1.0

        // Reserve minimum height for each expanded panel first, then distribute surplus.
        val totalMinExpandedHeight = expandedPanels.sumOf { it.minimumSize.height }
        val remainingHeight = maxOf(0, availableHeight - fixedHeight)
        val surplus = maxOf(0, remainingHeight - totalMinExpandedHeight)

        // Lay out components top-to-bottom
        var y = insets.top
        for (comp in visibleComponents) {
            val height = when {
                comp is ResizeDivider -> comp.preferredSize.height
                comp is CollapsiblePanel && !comp.isExpanded() -> comp.preferredSize.height
                else -> {
                    val minH = comp.minimumSize.height
                    val weight = weights.getOrDefault(comp, 1.0)
                    minH + (surplus * weight / totalWeight).toInt()
                }
            }
            comp.setBounds(insets.left, y, availableWidth, height)
            y += height
        }
    }

    /**
     * Called by [ResizeDivider] when the user drags a divider.
     * Finds the expanded panels immediately above and below the divider
     * and transfers height weight between them.
     */
    fun handleDividerDrag(parent: Container, divider: ResizeDivider, deltaY: Int) {
        if (deltaY == 0) return

        // Find the divider's index among visible components
        val visibleComponents = mutableListOf<Component>()
        for (i in 0 until parent.componentCount) {
            val comp = parent.getComponent(i)
            if (comp.isVisible) visibleComponents.add(comp)
        }

        val dividerIdx = visibleComponents.indexOf(divider)
        if (dividerIdx < 0) return

        // Find nearest expanded panel above the divider
        var abovePanel: Component? = null
        for (i in (dividerIdx - 1) downTo 0) {
            val comp = visibleComponents[i]
            if (comp is CollapsiblePanel && comp.isExpanded()) {
                abovePanel = comp
                break
            }
        }

        // Find nearest expanded panel below the divider
        var belowPanel: Component? = null
        for (i in (dividerIdx + 1) until visibleComponents.size) {
            val comp = visibleComponents[i]
            if (comp is CollapsiblePanel && comp.isExpanded()) {
                belowPanel = comp
                break
            }
        }

        if (abovePanel == null || belowPanel == null) return

        // Current heights and per-panel minimums
        val aboveHeight = abovePanel.height
        val belowHeight = belowPanel.height
        val totalHeight = aboveHeight + belowHeight
        if (totalHeight <= 0) return

        val aboveMin = abovePanel.minimumSize.height
        val belowMin = belowPanel.minimumSize.height

        // Compute new heights (clamp each panel to its own minimum)
        val newAboveHeight = (aboveHeight + deltaY).coerceIn(aboveMin, totalHeight - belowMin)
        val newBelowHeight = totalHeight - newAboveHeight

        // Convert surplus heights to weights. layoutContainer distributes only the
        // surplus (total - minimums) by weight, so we must base weights on the surplus
        // portion, not total heights. Using total heights causes the divider to drift
        // from the mouse because the minimum-height portion is not weight-proportional.
        val aboveWeight = weights.getOrDefault(abovePanel, 1.0)
        val belowWeight = weights.getOrDefault(belowPanel, 1.0)
        val combinedWeight = aboveWeight + belowWeight

        val aboveSurplus = (newAboveHeight - aboveMin).toDouble()
        val belowSurplus = (newBelowHeight - belowMin).toDouble()
        val totalSurplus = aboveSurplus + belowSurplus

        if (totalSurplus > 0) {
            weights[abovePanel] = combinedWeight * aboveSurplus / totalSurplus
            weights[belowPanel] = combinedWeight * belowSurplus / totalSurplus
        }

        // Use doLayout() instead of revalidate() for immediate, synchronous relayout
        // during drag. revalidate() is asynchronous and goes through the scroll pane's
        // viewport machinery, which may delay or fight the weight changes.
        parent.doLayout()
        parent.repaint()
    }
}

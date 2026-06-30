package ai.jolli.jollimemory.toolwindow

import com.intellij.icons.AllIcons
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionToolbar
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.ui.ColorUtil
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Cursor
import java.awt.Dimension
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.Box
import javax.swing.Icon
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.UIManager

/**
 * Key prefix for persisting panel visibility state (show/hide via gear menu).
 */
private const val VISIBILITY_KEY_PREFIX = "JolliMemory.CollapsiblePanel.visible."

/**
 * A collapsible panel with a clickable header containing a title and action toolbar.
 * Matches the VS Code sidebar tree-view layout where each section has a title bar
 * with collapse/expand arrow and inline action buttons.
 *
 * @param title The section title displayed in the header
 * @param actionGroupId The ID of the registered ActionGroup to show in the header toolbar
 * @param contentPanel The panel to show/hide when toggling
 * @param initiallyExpanded Whether the section starts expanded (default: true)
 * @param headerExtra Optional component placed between title and toolbar (e.g., status icon)
 */
class CollapsiblePanel(
    private val title: String,
    actionGroupId: String,
    private val contentPanel: JComponent,
    private val initiallyExpanded: Boolean = true,
    private val headerExtra: JComponent? = null,
    /** When true, the accordion sizes this panel to its content height (preferred)
     *  instead of giving it a share of the surplus space. Used for the Pinned panel
     *  so its height tracks the number of pinned items. */
    private val fitContent: Boolean = false,
    /** Optional accent icon shown between the expand arrow and the title text,
     *  e.g. the pin badge on the PINNED section (matches the mockup, which gives
     *  only that section a leading icon). */
    private val titleIcon: Icon? = null,
) : JPanel(BorderLayout()) {

    private val persistenceKey = "JolliMemory.CollapsiblePanel.expanded.$title"
    private var expanded: Boolean = PropertiesComponent.getInstance().getBoolean(persistenceKey, initiallyExpanded)
    private val arrowLabel = JBLabel()
    private val titleLabel = JBLabel(title)
    private val headerPanel = JPanel(BorderLayout())

    init {
        // Build header
        val separatorColor = UIManager.getColor("Separator.separatorColor")
            ?: UIManager.getColor("Component.borderColor")
            ?: java.awt.Color.GRAY
        headerPanel.apply {
            // Grey divider along the top edge + padding, so every section title reads
            // as a banded header even when collapsed (matches the mockup's
            // section-header border-top).
            // Line is the OUTER border (drawn at the very top edge); the empty padding
            // is INNER so it sits between the divider line and the title text. The top
            // value is the gap below the line — bump it to give the title more room
            // (also offsets the bold font's descent, which reads top-heavy).
            border = javax.swing.BorderFactory.createCompoundBorder(
                JBUI.Borders.customLineTop(separatorColor),
                JBUI.Borders.empty(8, 4, 5, 0),
            )
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            isOpaque = true
            // A header band that stands apart from the panel body: lighter in dark
            // themes, a touch darker in light themes — mirroring VS Code's
            // sideBarSectionHeader background.
            background = JBColor.lazy {
                val panel = UIManager.getColor("Panel.background") ?: JBColor.background()
                if (ColorUtil.isDark(panel)) ColorUtil.brighter(panel, 2) else ColorUtil.darker(panel, 1)
            }
        }

        titleLabel.apply {
            // Mockup section headers are 11px (base − 2) — smaller than the row titles
            // below them. Keeping them at the full label size inverted that hierarchy
            // and made the sidebar read crowded.
            font = font.deriveFont(java.awt.Font.BOLD, font.size2D - 2f)
            border = JBUI.Borders.emptyLeft(4)
        }

        updateArrowIcon()

        // Left side: arrow + title + optional extra component
        // Use FlowLayout so headerExtra sits immediately after the title text
        // rather than being pushed to the far right by BorderLayout.EAST.
        val leftPanel = JPanel(java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 0, 0)).apply {
            isOpaque = false
            add(arrowLabel)
            if (titleIcon != null) {
                add(Box.createHorizontalStrut(JBUI.scale(2)))
                add(JBLabel(titleIcon))
            }
            add(titleLabel)
            if (headerExtra != null) {
                headerExtra.isOpaque = false
                add(headerExtra)
            }
        }
        // BorderLayout.CENTER stretches leftPanel to the full header height, but a
        // FlowLayout pins its row to the top of that space — leaving the title looking
        // top-aligned whenever the toolbar/arrow make the header taller than the text.
        // Wrap it in a GridBag cell so the row keeps its preferred height and is
        // vertically centered (WEST anchor + horizontal fill keeps it left-aligned and
        // full-width).
        val centerWrap = JPanel(GridBagLayout()).apply {
            isOpaque = false
            add(
                leftPanel,
                GridBagConstraints().apply {
                    anchor = GridBagConstraints.WEST
                    fill = GridBagConstraints.HORIZONTAL
                    weightx = 1.0
                },
            )
        }
        headerPanel.add(centerWrap, BorderLayout.CENTER)

        // Right side: action toolbar
        val actionGroup = ActionManager.getInstance().getAction(actionGroupId)
        if (actionGroup is DefaultActionGroup) {
            val toolbar: ActionToolbar = ActionManager.getInstance()
                .createActionToolbar("JolliMemory.$title", actionGroup, true)
            toolbar.targetComponent = contentPanel
            toolbar.setReservePlaceAutoPopupIcon(false)
            toolbar.component.apply {
                isOpaque = false
                border = JBUI.Borders.empty()
            }
            headerPanel.add(toolbar.component, BorderLayout.EAST)
        }

        // Click to toggle
        headerPanel.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                toggle()
            }
        })

        add(headerPanel, BorderLayout.NORTH)

        // Content: add a thin top border for visual separation
        val separatorBorder = JBUI.Borders.customLineTop(UIManager.getColor("Separator.separatorColor") ?: java.awt.Color.GRAY)
        val existingBorder = contentPanel.border
        contentPanel.border = if (existingBorder != null) {
            JBUI.Borders.merge(separatorBorder, existingBorder, true)
        } else {
            separatorBorder
        }

        if (expanded) {
            add(contentPanel, BorderLayout.CENTER)
        }

        // Restore persisted visibility state (hidden panels stay hidden across sessions)
        isVisible = isPanelVisible()
    }

    private fun toggle() {
        expanded = !expanded
        PropertiesComponent.getInstance().setValue(persistenceKey, expanded, initiallyExpanded)
        updateArrowIcon()

        if (expanded) {
            add(contentPanel, BorderLayout.CENTER)
        } else {
            remove(contentPanel)
        }

        revalidate()
        repaint()

        // Notify the parent container to relayout so sibling panels
        // can reclaim the space freed by collapsing (or yield space for expanding).
        parent?.revalidate()
        parent?.repaint()
    }

    private fun updateArrowIcon() {
        arrowLabel.icon = if (expanded) {
            AllIcons.General.ArrowDown
        } else {
            AllIcons.General.ArrowRight
        }
    }

    /** Allows external code to expand/collapse this section. */
    fun setExpanded(value: Boolean) {
        if (value != expanded) {
            toggle()
        }
    }

    fun isExpanded(): Boolean = expanded

    /** Whether the accordion should size this panel to its content (see [fitContent]). */
    fun isFitContent(): Boolean = fitContent

    /** Appends a live row count to the header title, e.g. "PINNED (3)". */
    fun setCount(n: Int) {
        titleLabel.text = "$title ($n)"
    }

    /**
     * Controls whether this panel is visible in the tool window.
     * When hidden via the gear menu, the entire panel (header + content) is removed.
     * State is persisted across sessions.
     */
    fun setPanelVisible(visible: Boolean) {
        val key = "$VISIBILITY_KEY_PREFIX$title"
        PropertiesComponent.getInstance().setValue(key, visible, true)
        isVisible = visible
        parent?.revalidate()
        parent?.repaint()
    }

    /** Returns whether this panel is currently shown in the tool window. */
    fun isPanelVisible(): Boolean {
        val key = "$VISIBILITY_KEY_PREFIX$title"
        return PropertiesComponent.getInstance().getBoolean(key, true)
    }

    /** Returns the section title for this panel. */
    fun getTitle(): String = title

    override fun getPreferredSize(): Dimension {
        // When collapsed, only show header height
        return if (!expanded) {
            val headerSize = headerPanel.preferredSize
            Dimension(headerSize.width, headerSize.height)
        } else {
            super.getPreferredSize()
        }
    }

    override fun getMaximumSize(): Dimension {
        // Full width, but height pinned to the preferred (content) height so the panel
        // doesn't stretch in the vertically-stacked, single-scrollbar sidebar layout.
        return Dimension(Int.MAX_VALUE, preferredSize.height)
    }

    override fun getMinimumSize(): Dimension {
        // When collapsed, only the header needs space; when expanded, allow shrinking
        val headerHeight = headerPanel.preferredSize.height
        return Dimension(0, if (expanded) headerHeight + JBUI.scale(30) else headerHeight)
    }
}

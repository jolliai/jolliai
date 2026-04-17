package ai.jolli.jollimemory.toolwindow

import com.intellij.icons.AllIcons
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionToolbar
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Cursor
import java.awt.Dimension
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
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
) : JPanel(BorderLayout()) {

    private val persistenceKey = "JolliMemory.CollapsiblePanel.expanded.$title"
    private var expanded: Boolean = PropertiesComponent.getInstance().getBoolean(persistenceKey, initiallyExpanded)
    private val arrowLabel = JBLabel()
    private val titleLabel = JBLabel(title)
    private val headerPanel = JPanel(BorderLayout())

    init {
        // Build header
        headerPanel.apply {
            border = JBUI.Borders.empty(4, 4, 4, 0)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            isOpaque = true
            background = UIManager.getColor("ToolWindow.HeaderTab.selectedInactiveBackground")
                ?: UIManager.getColor("Panel.background")
        }

        titleLabel.apply {
            font = font.deriveFont(java.awt.Font.BOLD)
            border = JBUI.Borders.emptyLeft(4)
        }

        updateArrowIcon()

        // Left side: arrow + title + optional extra component
        // Use FlowLayout so headerExtra sits immediately after the title text
        // rather than being pushed to the far right by BorderLayout.EAST.
        val leftPanel = JPanel(java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 0, 0)).apply {
            isOpaque = false
            add(arrowLabel)
            add(titleLabel)
            if (headerExtra != null) {
                headerExtra.isOpaque = false
                add(headerExtra)
            }
        }
        headerPanel.add(leftPanel, BorderLayout.CENTER)

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
        contentPanel.border = JBUI.Borders.merge(
            JBUI.Borders.customLineTop(UIManager.getColor("Separator.separatorColor") ?: java.awt.Color.GRAY),
            contentPanel.border,
            true,
        )

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
        // Allow full width; height follows content so items stay top-aligned
        return Dimension(Int.MAX_VALUE, super.getMaximumSize().height)
    }

    override fun getMinimumSize(): Dimension {
        // When collapsed, only the header needs space; when expanded, allow shrinking
        val headerHeight = headerPanel.preferredSize.height
        return Dimension(0, if (expanded) headerHeight + JBUI.scale(30) else headerHeight)
    }
}

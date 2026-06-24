package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.core.ActiveConversationItem
import ai.jolli.jollimemory.core.TranscriptSource
import com.intellij.icons.AllIcons
import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import java.awt.*
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.JCheckBox
import javax.swing.JLabel
import javax.swing.JPanel

/**
 * A single row in the [ActiveConversationsPanel]. Displays a color-coded
 * source badge, the conversation title, an unread message count, and a
 * hide button that appears on hover.
 */
class ConversationRowComponent(
	val item: ActiveConversationItem,
	private val onRowClicked: (ActiveConversationItem) -> Unit,
	private val onHide: (ActiveConversationItem) -> Unit,
	private val onPin: (ActiveConversationItem) -> Unit,
	private val onSelectionChanged: (ActiveConversationItem, Boolean) -> Unit,
) : JPanel(BorderLayout()) {

	private val checkbox = JCheckBox().apply {
		isSelected = item.isSelected
		isOpaque = false
		toolTipText = "Include in next memory"
		cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
	}

	private val pinLabel = JLabel(AllIcons.Nodes.Favorite).apply {
		cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
		toolTipText = "Pin"
		isVisible = false
		border = JBUI.Borders.empty(0, 3)
	}

	private val hideLabel = JLabel(JolliMemoryIcons.Trash).apply {
		cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
		toolTipText = "Delete"
		isVisible = false
		border = JBUI.Borders.empty(0, 3)
	}

	private val countLabel = JLabel(if (item.messageCount > 0) "${item.messageCount}" else "").apply {
		foreground = JBColor.GRAY
		font = font.deriveFont(font.size2D - 1f)
	}

	/** Toggles the right side between the message count and the hover actions. */
	private fun setHovered(hovered: Boolean) {
		background = if (hovered) JBColor(Color(0, 0, 0, 20), Color(255, 255, 255, 20)) else null
		countLabel.isVisible = !hovered
		pinLabel.isVisible = hovered
		hideLabel.isVisible = hovered
	}

	init {
		border = JBUI.Borders.empty(4, 8)
		isOpaque = true
		cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)

		// Left side: checkbox + source badge
		val leftPanel = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(2), 0)).apply {
			isOpaque = false
		}
		leftPanel.add(checkbox)
		val badge = SourceBadge(item.source)
		leftPanel.add(badge)
		add(leftPanel, BorderLayout.WEST)

		// Title (center, truncates)
		val titleLabel = JLabel(item.title).apply {
			border = JBUI.Borders.emptyLeft(8)
		}
		add(titleLabel, BorderLayout.CENTER)

		// Right side: message count (default) swaps to Pin · Delete on hover (matches Context).
		val rightPanel = JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply {
			isOpaque = false
		}
		rightPanel.add(countLabel)
		rightPanel.add(pinLabel)
		rightPanel.add(hideLabel)
		add(rightPanel, BorderLayout.EAST)

		// Checkbox toggle
		checkbox.addActionListener {
			onSelectionChanged(item, checkbox.isSelected)
		}

		// Click handlers
		pinLabel.addMouseListener(object : MouseAdapter() {
			override fun mouseClicked(e: MouseEvent) {
				e.consume()
				onPin(item)
			}
		})
		hideLabel.addMouseListener(object : MouseAdapter() {
			override fun mouseClicked(e: MouseEvent) {
				e.consume()
				onHide(item)
			}
		})

		val hoverListener = object : MouseAdapter() {
			override fun mouseEntered(e: MouseEvent) {
				setHovered(true)
			}

			override fun mouseExited(e: MouseEvent) {
				// Only un-hover if the mouse actually left the row bounds (not when
				// moving onto a child component within the row).
				val p = e.point
				val src = e.source as Component
				val screenPoint = src.locationOnScreen.apply { translate(p.x, p.y) }
				val rowLoc = this@ConversationRowComponent.locationOnScreen
				val rowBounds = Rectangle(rowLoc.x, rowLoc.y, width, height)
				if (!rowBounds.contains(screenPoint)) {
					setHovered(false)
				}
			}
		}
		val clickListener = object : MouseAdapter() {
			override fun mouseClicked(e: MouseEvent) {
				onRowClicked(item)
			}
		}
		addMouseListener(hoverListener)
		addMouseListener(clickListener)
		// Forward events from all children (checkbox handles its own clicks)
		for (c in listOf(leftPanel, badge, titleLabel, rightPanel, countLabel, pinLabel, hideLabel)) {
			c.addMouseListener(hoverListener)
			if (c !== hideLabel && c !== pinLabel && c !== checkbox) c.addMouseListener(clickListener)
		}
	}

	override fun getMaximumSize(): Dimension =
		Dimension(Int.MAX_VALUE, preferredSize.height)
}

/** Small color-coded label showing the AI source name. */
private class SourceBadge(source: TranscriptSource) : JLabel(source.name) {
	private val badgeColor = SOURCE_COLORS[source] ?: JBColor.GRAY
	private val arcSize = JBUI.scale(8)

	init {
		foreground = Color.WHITE
		font = font.deriveFont(Font.BOLD, font.size2D - 2f)
		isOpaque = false
		border = JBUI.Borders.empty(1, 6, 1, 6)
	}

	override fun paintComponent(g: Graphics) {
		val g2 = g.create() as Graphics2D
		g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
		g2.color = badgeColor
		g2.fillRoundRect(0, 0, width, height, arcSize, arcSize)
		g2.dispose()
		super.paintComponent(g)
	}

	companion object {
		private val SOURCE_COLORS = mapOf(
			TranscriptSource.claude to JBColor(Color(217, 119, 6), Color(217, 119, 6)),
			TranscriptSource.gemini to JBColor(Color(5, 150, 105), Color(5, 150, 105)),
			TranscriptSource.codex to JBColor(Color(124, 58, 237), Color(124, 58, 237)),
			TranscriptSource.opencode to JBColor(Color(37, 99, 235), Color(37, 99, 235)),
			TranscriptSource.cursor to JBColor(Color(220, 38, 38), Color(220, 38, 38)),
		)
	}
}

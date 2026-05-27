package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.core.ActiveConversationItem
import ai.jolli.jollimemory.core.BranchTagsStore
import ai.jolli.jollimemory.core.TranscriptSource
import com.intellij.icons.AllIcons
import com.intellij.openapi.application.ApplicationManager
import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import java.awt.*
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.*

/**
 * A single row in the [ActiveConversationsPanel]. Displays a color-coded
 * source badge, the conversation title, branch tag chips, an unread message
 * count, and a hide button that appears on hover. Right-click opens a
 * branch tagging context menu.
 */
class ConversationRowComponent(
	val item: ActiveConversationItem,
	private val cwd: String,
	private val existingBranches: Set<String>,
	private val onRowClicked: (ActiveConversationItem) -> Unit,
	private val onHide: (ActiveConversationItem) -> Unit,
	private val onTagsChanged: () -> Unit,
) : JPanel(BorderLayout()) {

	private val hideLabel = JLabel(AllIcons.Actions.GC).apply {
		cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
		toolTipText = "Hide conversation"
		isVisible = false
		border = JBUI.Borders.emptyRight(4)
	}

	init {
		border = JBUI.Borders.empty(4, 8)
		isOpaque = true
		cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)

		// Source badge
		val badge = SourceBadge(item.source)
		add(badge, BorderLayout.WEST)

		// Center: title + optional branch tag chips
		val centerPanel = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.X_AXIS)
			isOpaque = false
			add(JLabel(item.title).apply {
				border = JBUI.Borders.emptyLeft(8)
			})
			// Branch tag chips
			if (item.branchTags.isNotEmpty()) {
				add(Box.createHorizontalStrut(6))
				for (branch in item.branchTags) {
					val branchExists = branch in existingBranches
					add(BranchTagChip(branch, branchExists))
					add(Box.createHorizontalStrut(2))
				}
			}
		}
		add(centerPanel, BorderLayout.CENTER)

		// Right side: message count + hide button
		val rightPanel = JPanel(FlowLayout(FlowLayout.RIGHT, JBUI.scale(4), 0)).apply {
			isOpaque = false
		}
		if (item.messageCount > 0) {
			rightPanel.add(JLabel("${item.messageCount}").apply {
				foreground = JBColor.GRAY
				font = font.deriveFont(font.size2D - 1f)
			})
		}
		rightPanel.add(hideLabel)
		add(rightPanel, BorderLayout.EAST)

		// Click handlers
		hideLabel.addMouseListener(object : MouseAdapter() {
			override fun mouseClicked(e: MouseEvent) {
				e.consume()
				onHide(item)
			}
		})

		val hoverListener = object : MouseAdapter() {
			override fun mouseEntered(e: MouseEvent) {
				background = JBColor(Color(0, 0, 0, 20), Color(255, 255, 255, 20))
				hideLabel.isVisible = true
			}

			override fun mouseExited(e: MouseEvent) {
				// Only hide if mouse actually left the row bounds
				val p = e.point
				val src = e.source as Component
				val screenPoint = src.locationOnScreen.apply { translate(p.x, p.y) }
				val rowLoc = this@ConversationRowComponent.locationOnScreen
				val rowBounds = Rectangle(rowLoc.x, rowLoc.y, width, height)
				if (!rowBounds.contains(screenPoint)) {
					background = null
					hideLabel.isVisible = false
				}
			}
		}
		val clickListener = object : MouseAdapter() {
			override fun mouseClicked(e: MouseEvent) {
				onRowClicked(item)
			}
		}

		// Right-click context menu for branch tagging
		val popupListener = object : MouseAdapter() {
			override fun mousePressed(e: MouseEvent) { if (e.isPopupTrigger) showBranchMenu(e) }
			override fun mouseReleased(e: MouseEvent) { if (e.isPopupTrigger) showBranchMenu(e) }
		}

		addMouseListener(hoverListener)
		addMouseListener(clickListener)
		addMouseListener(popupListener)
		// Forward events from all children
		for (c in listOf(badge, centerPanel, rightPanel, hideLabel)) {
			c.addMouseListener(hoverListener)
			c.addMouseListener(popupListener)
			if (c !== hideLabel) c.addMouseListener(clickListener)
		}
	}

	override fun getMaximumSize(): Dimension =
		Dimension(Int.MAX_VALUE, preferredSize.height)

	// ── Branch tagging context menu ─────────────────────────────────────

	private fun showBranchMenu(e: MouseEvent) {
		val branches = try { GitOps(cwd).listBranches() } catch (_: Exception) { emptyList() }
		if (branches.isEmpty()) return

		val currentTags = item.branchTags.toMutableSet()
		val menu = JPopupMenu("Tag to branch")

		for (branch in branches) {
			val checkItem = JCheckBoxMenuItem(branch, branch in currentTags)
			checkItem.addActionListener {
				if (checkItem.isSelected) currentTags.add(branch) else currentTags.remove(branch)
				ApplicationManager.getApplication().executeOnPooledThread {
					BranchTagsStore.setTagsForSession(cwd, item.source, item.sessionId, currentTags.toList())
					SwingUtilities.invokeLater { onTagsChanged() }
				}
			}
			menu.add(checkItem)
		}

		menu.show(e.component, e.x, e.y)
	}
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

/** Small chip showing a branch tag name. Amber warning if branch no longer exists. */
private class BranchTagChip(branch: String, branchExists: Boolean) : JLabel(truncateBranch(branch)) {
	private val chipColor = if (branchExists) {
		JBColor(Color(59, 130, 246), Color(96, 165, 250))
	} else {
		JBColor(Color(217, 119, 6), Color(245, 158, 11))
	}
	private val arcSize = JBUI.scale(6)

	init {
		foreground = Color.WHITE
		font = font.deriveFont(font.size2D - 3f)
		isOpaque = false
		border = JBUI.Borders.empty(0, 4, 0, 4)
		toolTipText = if (branchExists) branch else "$branch (deleted)"
	}

	override fun paintComponent(g: Graphics) {
		val g2 = g.create() as Graphics2D
		g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
		g2.color = chipColor
		g2.fillRoundRect(0, 0, width, height, arcSize, arcSize)
		g2.dispose()
		super.paintComponent(g)
	}

	companion object {
		private fun truncateBranch(name: String): String =
			if (name.length > 20) name.take(18) + ".." else name
	}
}

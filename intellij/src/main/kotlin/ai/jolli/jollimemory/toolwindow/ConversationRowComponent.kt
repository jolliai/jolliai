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
import java.awt.font.TextAttribute
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel

/**
 * A single row in the [ActiveConversationsPanel]. Shows a color-coded source
 * badge and the conversation title, with an unread message count that swaps to
 * hover actions: Pin · Open (eye) · Continue · and a select toggle.
 *
 * Selection replaces the old checkbox: a selected row reads normally and shows a
 * ✕ (exclude) on hover; clicking it strikes the title through and the icon flips
 * to ＋ (include). The toggle persists through [onSelectionChanged] (the same
 * CommitSelectionStore exclusion the checkbox wrote), so Commit Memory includes
 * exactly the non-struck rows.
 */
class ConversationRowComponent(
	val item: ActiveConversationItem,
	private val onRowClicked: (ActiveConversationItem) -> Unit,
	private val onContinue: (ActiveConversationItem) -> Unit,
	private val onPin: (ActiveConversationItem) -> Unit,
	private val onSelectionChanged: (ActiveConversationItem, Boolean) -> Unit,
) : JPanel(BorderLayout()) {

	/** Live selection state; strikethrough + the ✕/＋ toggle mirror this. */
	private var selected = item.isSelected

	private val titleLabel = JLabel(item.title).apply { border = JBUI.Borders.emptyLeft(8) }
	private val baseFont = titleLabel.font
	private val strikeFont = baseFont.deriveFont(mapOf(TextAttribute.STRIKETHROUGH to TextAttribute.STRIKETHROUGH_ON))
	private val baseFg = titleLabel.foreground

	private val pinLabel = actionIcon(AllIcons.General.Pin_tab, "Pin") { onPin(item) }
	private val eyeLabel = actionIcon(JolliMemoryIcons.Eye, "Open conversation") { onRowClicked(item) }
	private val continueLabel = actionIcon(AllIcons.Actions.Execute, "Continue — reopen this session in your AI tool") { onContinue(item) }
	private val toggleLabel = JLabel().apply {
		cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
		isVisible = false
		border = JBUI.Borders.empty(0, 3)
		addMouseListener(object : MouseAdapter() {
			override fun mouseClicked(e: MouseEvent) {
				e.consume()
				selected = !selected
				applySelectionState()
				onSelectionChanged(item, selected)
			}
		})
	}

	private val countLabel = JLabel(if (item.messageCount > 0) "${item.messageCount}" else "").apply {
		foreground = JBColor.GRAY
		font = font.deriveFont(font.size2D - 1f)
	}

	private fun actionIcon(icon: javax.swing.Icon, tip: String, onClick: () -> Unit): JLabel =
		JLabel(icon).apply {
			cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
			toolTipText = tip
			isVisible = false
			border = JBUI.Borders.empty(0, 3)
			addMouseListener(object : MouseAdapter() {
				override fun mouseClicked(e: MouseEvent) { e.consume(); onClick() }
			})
		}

	/** Strike + dim the title when deselected; flip the toggle between ✕ (exclude) and ＋ (include). */
	private fun applySelectionState() {
		titleLabel.font = if (selected) baseFont else strikeFont
		titleLabel.foreground = if (selected) baseFg else JBColor.GRAY
		toggleLabel.icon = if (selected) AllIcons.Actions.Close else AllIcons.General.Add
		toggleLabel.toolTipText = if (selected) "Exclude from next memory" else "Include in next memory"
	}

	/** Swaps the right side between the message count and the hover actions. */
	private fun setHovered(hovered: Boolean) {
		background = if (hovered) JBColor(Color(0, 0, 0, 20), Color(255, 255, 255, 20)) else null
		countLabel.isVisible = !hovered
		pinLabel.isVisible = hovered
		eyeLabel.isVisible = hovered
		continueLabel.isVisible = hovered
		toggleLabel.isVisible = hovered
	}

	init {
		border = JBUI.Borders.empty(4, 8)
		isOpaque = true
		cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)

		// Left side: source badge / logo (no more checkbox)
		val badge = SourceBadge.leadFor(item.source.name)
		val leftPanel = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(2), 0)).apply {
			isOpaque = false
			add(badge)
		}
		add(leftPanel, BorderLayout.WEST)
		add(titleLabel, BorderLayout.CENTER)

		// Right side: count (default) swaps to Pin · Open · Continue · toggle on hover.
		val rightPanel = JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply { isOpaque = false }
		rightPanel.add(countLabel)
		rightPanel.add(pinLabel)
		rightPanel.add(eyeLabel)
		rightPanel.add(continueLabel)
		rightPanel.add(toggleLabel)
		add(rightPanel, BorderLayout.EAST)

		applySelectionState()

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
				if (!Rectangle(rowLoc.x, rowLoc.y, width, height).contains(screenPoint)) {
					setHovered(false)
				}
			}
		}
		val clickListener = object : MouseAdapter() {
			override fun mouseClicked(e: MouseEvent) { onRowClicked(item) }
		}
		addMouseListener(hoverListener)
		addMouseListener(clickListener)
		// Icons handle their own clicks; the row body (badge/title/count) opens the conversation.
		for (c in listOf(leftPanel, badge, titleLabel, rightPanel, countLabel, pinLabel, eyeLabel, continueLabel, toggleLabel)) {
			c.addMouseListener(hoverListener)
			if (c === leftPanel || c === badge || c === titleLabel || c === rightPanel || c === countLabel) {
				c.addMouseListener(clickListener)
			}
		}
	}

	override fun getMaximumSize(): Dimension =
		Dimension(Int.MAX_VALUE, preferredSize.height)
}

/**
 * Small color-coded label showing the AI source (Claude, Codex, Gemini, Cursor,
 * OpenCode, GitHub Copilot, …). Shared by the live Active Conversations panel and
 * the Committed Memories CONVERSATIONS group so a conversation's tool is
 * recognizable in both. Construct via [of].
 */
internal class SourceBadge private constructor(label: String, private val badgeColor: JBColor) : JLabel(label) {
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
		/**
		 * Lead component for a source: the tool's real logo when one exists,
		 * otherwise the color-coded text badge. Shared by every surface that shows
		 * a conversation's tool (live Active Conversations, Committed Memories,
		 * Pinned) so they stay consistent.
		 */
		fun leadFor(sourceName: String): JComponent {
			val logo = JolliMemoryIcons.sourceLogo(sourceName)
			return if (logo != null) JLabel(logo).apply { toolTipText = displayName(sourceName) } else of(sourceName)
		}

		/** Badge for a known transcript source. */
		fun of(source: TranscriptSource): SourceBadge =
			SourceBadge(displayName(source.name), SOURCE_COLORS[source] ?: JBColor.GRAY)

		/**
		 * Badge for a source given by name (e.g. parsed from a stored transcript).
		 * Unknown names fall back to a neutral gray badge with the raw name.
		 */
		fun of(sourceName: String): SourceBadge {
			val source = TranscriptSource.entries.firstOrNull { it.name == sourceName }
			val color = source?.let { SOURCE_COLORS[it] } ?: JBColor.GRAY
			return SourceBadge(displayName(sourceName), color)
		}

		private fun displayName(name: String): String = when (name) {
			"copilot" -> "Copilot"
			"copilot-chat" -> "Copilot Chat"
			"opencode" -> "OpenCode"
			else -> name.replaceFirstChar { it.uppercase() }
		}

		private val SOURCE_COLORS = mapOf(
			TranscriptSource.claude to JBColor(Color(217, 119, 6), Color(217, 119, 6)),
			TranscriptSource.gemini to JBColor(Color(5, 150, 105), Color(5, 150, 105)),
			TranscriptSource.codex to JBColor(Color(124, 58, 237), Color(124, 58, 237)),
			TranscriptSource.opencode to JBColor(Color(37, 99, 235), Color(37, 99, 235)),
			TranscriptSource.cursor to JBColor(Color(220, 38, 38), Color(220, 38, 38)),
			TranscriptSource.copilot to JBColor(Color(45, 164, 78), Color(45, 164, 78)),
			TranscriptSource.`copilot-chat` to JBColor(Color(45, 164, 78), Color(45, 164, 78)),
		)
	}
}

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
import javax.swing.JTextArea

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
	private val onPin: (ActiveConversationItem) -> Unit,
	private val onResume: (ActiveConversationItem) -> Unit,
	private val onSelectionChanged: (ActiveConversationItem, Boolean) -> Unit,
) : JPanel(BorderLayout()) {

	/** Live selection state; strikethrough + the ✕/＋ toggle mirror this. */
	private var selected = item.isSelected

	// Wrapping title: long conversation names wrap and grow the row taller instead of
	// clipping to one line. JTextArea (styled like a label) gives word-wrap.
	private val titleLabel = JTextArea(item.title).apply {
		border = JBUI.Borders.emptyLeft(8)
		isEditable = false
		isFocusable = false
		isOpaque = false
		lineWrap = true
		wrapStyleWord = true
		margin = JBUI.insets(0)
		// Match the mockup's 12px row title (base − 1) for a denser, less cluttered list.
		font = JBUI.Fonts.label().let { it.deriveFont(it.size2D - 1f) }
	}
	private val baseFont = titleLabel.font
	private val strikeFont = baseFont.deriveFont(mapOf(TextAttribute.STRIKETHROUGH to TextAttribute.STRIKETHROUGH_ON))
	private val baseFg = titleLabel.foreground

	// vCenter wrappers around the badge / right-side controls so they stay vertically
	// centered as the title wraps and the row grows taller.
	private var leftWrap: JComponent? = null
	private var rightWrap: JComponent? = null

	private val pinLabel = actionIcon(AllIcons.General.Pin_tab, "Pin") { onPin(item) }
	private val eyeLabel = actionIcon(JolliMemoryIcons.Eye, "Open conversation") { onRowClicked(item) }
	private val resumeLabel = actionIcon(AllIcons.Actions.Execute, "Resume session in terminal") { onResume(item) }

	// Resume runs `claude --resume <id>`, which only works for Claude sessions. For
	// other sources (Codex, etc.) the icon was shown but the handler silently no-op'd,
	// so hide it entirely for non-Claude rows (matches the Committed/Pinned panels).
	private val canResume = item.source == TranscriptSource.claude
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
		font = font.deriveFont(font.size2D - 2f)
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
		background = if (hovered) RowStyle.HOVER_BG else null
		countLabel.isVisible = !hovered
		pinLabel.isVisible = hovered
		eyeLabel.isVisible = hovered
		resumeLabel.isVisible = hovered && canResume
		toggleLabel.isVisible = hovered
	}

	init {
		// Match PINNED's row insets (empty(2,4)); the rowsPanel adds the other 4px of
		// side padding so the edge gaps line up across all sections.
		border = JBUI.Borders.empty(2, 4)
		isOpaque = true
		cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)

		// Left side: source badge / logo (no more checkbox), vertically centered.
		val badge = SourceBadge.leadFor(item.source.name)
		val leftPanel = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(2), 0)).apply {
			isOpaque = false
			add(badge)
		}
		val left = RowStyle.vCenter(leftPanel)
		leftWrap = left
		add(left, BorderLayout.WEST)
		add(titleLabel, BorderLayout.CENTER)

		// Right side: count (default) swaps to Pin · Open · Continue · toggle on hover.
		val rightPanel = JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply { isOpaque = false }
		rightPanel.add(countLabel)
		rightPanel.add(pinLabel)
		rightPanel.add(eyeLabel)
		if (canResume) rightPanel.add(resumeLabel)
		rightPanel.add(toggleLabel)
		// Reserve the widest state's width (hover actions) so the title's wrap width is
		// stable whether or not the row is hovered. The toggle icon is set in
		// applySelectionState() — give it one here first so its width is counted (else
		// the 4th icon is clipped).
		toggleLabel.icon = AllIcons.Actions.Close
		countLabel.isVisible = false
		pinLabel.isVisible = true; eyeLabel.isVisible = true; resumeLabel.isVisible = canResume; toggleLabel.isVisible = true
		val reservedRightW = rightPanel.preferredSize.width
		countLabel.isVisible = true
		pinLabel.isVisible = false; eyeLabel.isVisible = false; resumeLabel.isVisible = false; toggleLabel.isVisible = false
		val right = RowStyle.vCenter(rightPanel).apply {
			preferredSize = Dimension(reservedRightW, JBUI.scale(16))
			minimumSize = Dimension(reservedRightW, 0)
		}
		rightWrap = right
		add(right, BorderLayout.EAST)

		applySelectionState()

		val hoverListener = object : MouseAdapter() {
			override fun mouseEntered(e: MouseEvent) {
				setHovered(true)
			}

			override fun mouseExited(e: MouseEvent) {
				// Only un-hover if the mouse actually left the row bounds (not when
				// moving onto a child component within the row).
				val src = e.source as Component
				if (!src.isShowing || !this@ConversationRowComponent.isShowing) {
					setHovered(false)
					return
				}
				val p = e.point
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
		for (c in listOf(left, leftPanel, badge, titleLabel, right, rightPanel, countLabel, pinLabel, eyeLabel, resumeLabel, toggleLabel)) {
			c.addMouseListener(hoverListener)
			if (c === left || c === leftPanel || c === badge || c === titleLabel || c === rightPanel || c === countLabel) {
				c.addMouseListener(clickListener)
			}
		}

		// Recompute the wrapped height when the row width changes (tool-window resize).
		addComponentListener(object : java.awt.event.ComponentAdapter() {
			override fun componentResized(e: java.awt.event.ComponentEvent) { revalidate() }
		})
	}

	override fun getPreferredSize(): Dimension {
		val base = super.getPreferredSize()
		val lw = leftWrap
		val rw = rightWrap
		val w = width
		if (w <= 0 || lw == null || rw == null) return base
		val ins = insets
		val titleW = (w - ins.left - ins.right - lw.preferredSize.width - rw.preferredSize.width)
			.coerceAtLeast(JBUI.scale(20))
		// Sizing the text area to the available width makes its preferred height reflect
		// the wrapped line count.
		titleLabel.setSize(titleW, Short.MAX_VALUE.toInt())
		val contentH = maxOf(titleLabel.preferredSize.height, lw.preferredSize.height, JBUI.scale(16))
		return Dimension(base.width, contentH + ins.top + ins.bottom)
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

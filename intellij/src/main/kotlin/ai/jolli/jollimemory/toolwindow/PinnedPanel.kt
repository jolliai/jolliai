package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.core.ActiveSessionAggregator
import ai.jolli.jollimemory.core.CommitSelectionStore
import ai.jolli.jollimemory.core.PinStore
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.icons.AllIcons
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.Cursor
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.RenderingHints
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.io.File
import javax.swing.BoxLayout
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JTextArea
import javax.swing.SwingConstants
import javax.swing.SwingUtilities

/**
 * "Pinned" section — items the user pinned (via the pin hover action in the
 * Context / Conversations rows) so they survive across sessions. Backed by
 * [PinStore] under `<projectDir>/.jolli/jollimemory/pins.json` (worktree-scoped).
 *
 * Each row mirrors its source row: the same badge (source name for conversations,
 * letter tag for context) + the title, with an unpin (×) on hover. Clicking a row
 * opens the underlying content (transcript / plan / note / reference / memory).
 */
class PinnedPanel(
	private val project: Project,
	private val service: JolliMemoryService,
) : JPanel(BorderLayout()), Disposable, RowCountSource {

	override var onRowCountChanged: ((Int) -> Unit)? = null
	private var rowCount = 0
	override fun currentRowCount(): Int = rowCount

	private val rowsPanel = JPanel().apply {
		layout = BoxLayout(this, BoxLayout.Y_AXIS)
		border = JBUI.Borders.empty(2, 4)
	}
	private val emptyLabel = JBLabel("Nothing pinned.").apply {
		foreground = JBColor.GRAY
		border = JBUI.Borders.empty(6, 8)
	}

	init {
		add(rowsPanel, BorderLayout.NORTH)
		renderEmpty()
	}

	private fun cwd(): String? = service.mainRepoRoot ?: project.basePath

	fun refresh() {
		val dir = cwd() ?: return
		ApplicationManager.getApplication().executeOnPooledThread {
			val pins = PinStore.readPins(dir)
			SwingUtilities.invokeLater { render(pins) }
		}
	}

	private fun renderEmpty() {
		rowsPanel.removeAll()
		rowsPanel.add(emptyLabel)
		rowsPanel.revalidate()
		rowsPanel.repaint()
	}

	private fun render(pins: List<PinStore.PinnedEntry>) {
		rowCount = pins.size
		onRowCountChanged?.invoke(rowCount)
		rowsPanel.removeAll()
		if (pins.isEmpty()) {
			rowsPanel.add(emptyLabel)
		} else {
			pins.forEach { rowsPanel.add(pinRow(it)) }
		}
		// Revalidate the whole panel so the accordion re-lays out to the new
		// content height (the Pinned section is sized to fit its items).
		revalidate()
		repaint()
	}

	override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)

	private fun pinRow(entry: PinStore.PinnedEntry): JPanel {
		val hgap = JBUI.scale(4)

		// Title wraps to the available width so long pins grow the row taller instead
		// of clipping. JTextArea (not JBLabel) gives us word-wrapping; styled to read
		// like a label.
		val title = JTextArea(entry.title).apply {
			isEditable = false
			isFocusable = false
			isOpaque = false
			lineWrap = true
			wrapStyleWord = true
			border = JBUI.Borders.empty()
			margin = JBUI.insets(0)
			font = JBUI.Fonts.label()
			foreground = JBColor.foreground()
			cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
		}

		// Conversation pins lead with the AI tool's real logo (badge = source name);
		// other kinds keep their letter/tag pill. Wrapped in a GridBag cell so the
		// badge keeps its natural size and stays vertically centered as the row grows.
		val sourceLogo = if (entry.kind == "conversations") JolliMemoryIcons.sourceLogo(entry.badge.lowercase()) else null
		val badge: JComponent = if (sourceLogo != null) {
			JLabel(sourceLogo).apply { toolTipText = entry.badge }
		} else {
			BadgePill(entry.badge, badgeColor(entry))
		}
		val west = JPanel(GridBagLayout()).apply {
			isOpaque = false
			add(badge, GridBagConstraints())
		}

		// Hover actions, right edge: Open (eye) · Resume (play, Claude/Codex only) · Unpin.
		val openBtn = actionIcon(JolliMemoryIcons.Eye, "Open") { openPinned(entry) }
		val unpinBtn = actionIcon(AllIcons.Actions.Close, "Unpin") {
			val dir = cwd() ?: return@actionIcon
			ai.jolli.jollimemory.core.telemetry.Telemetry.track("memory_unpinned", mapOf("kind" to entry.kind))
			ApplicationManager.getApplication().executeOnPooledThread {
				PinStore.unpin(dir, entry.kind, entry.key)
				refresh()
			}
		}
		val canResume = entry.kind == "conversations" && TerminalUtils.canResumeSource(entry.badge)
		val actions = if (canResume) {
			val resumeBtn = actionIcon(AllIcons.Actions.Execute, "Resume session in terminal") { resumeInTerminal(entry) }
			listOf(openBtn, resumeBtn, unpinBtn)
		} else {
			listOf(openBtn, unpinBtn)
		}
		val iconsRow = JPanel(FlowLayout(FlowLayout.RIGHT, JBUI.scale(2), 0)).apply {
			isOpaque = false
			actions.forEach { add(it) }
		}
		// Reserve the icons' full width up-front (measured while visible) so the title
		// wrap width stays constant whether or not the row is hovered — no reflow when
		// the icons appear. GridBag keeps the icons vertically centered as the row grows.
		actions.forEach { it.isVisible = true }
		val reservedIconsW = iconsRow.preferredSize.width
		actions.forEach { it.isVisible = false }
		val east = JPanel(GridBagLayout()).apply {
			isOpaque = false
			add(iconsRow, GridBagConstraints())
			preferredSize = Dimension(reservedIconsW, JBUI.scale(16))
			minimumSize = Dimension(reservedIconsW, 0)
		}

		// Row height follows the wrapped title at the row's actual width; the badge and
		// icons stay vertically centered (BorderLayout WEST/EAST + GridBag).
		val row = object : JPanel(BorderLayout(hgap, 0)) {
			override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)

			override fun getPreferredSize(): Dimension {
				val base = super.getPreferredSize()
				val w = width
				if (w <= 0) return base
				val ins = insets
				val titleW = (w - ins.left - ins.right - west.preferredSize.width - east.preferredSize.width - hgap * 2)
					.coerceAtLeast(JBUI.scale(20))
				// Sizing the text area to the available width makes its preferred height
				// reflect the wrapped line count.
				title.setSize(titleW, Short.MAX_VALUE.toInt())
				val contentH = maxOf(title.preferredSize.height, west.preferredSize.height, JBUI.scale(16))
				return Dimension(base.width, contentH + ins.top + ins.bottom)
			}
		}.apply {
			border = JBUI.Borders.empty(2, 4)
			alignmentX = Component.LEFT_ALIGNMENT
			isOpaque = false
			cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
			add(west, BorderLayout.WEST)
			add(title, BorderLayout.CENTER)
			add(east, BorderLayout.EAST)
		}
		// Recompute the wrapped height when the row's width changes (tool-window resize).
		row.addComponentListener(object : java.awt.event.ComponentAdapter() {
			override fun componentResized(e: java.awt.event.ComponentEvent) {
				row.revalidate()
			}
		})

		// Hover: reveal the action icons and paint a subtle highlight bar across the
		// row (mirrors the Active Conversations rows). The row is transparent until
		// hovered, then opaque with a translucent overlay.
		fun setRowHovered(hovered: Boolean) {
			row.isOpaque = hovered
			row.background = if (hovered) RowStyle.HOVER_BG else null
			actions.forEach { it.isVisible = hovered }
			row.repaint()
		}
		val hover = object : MouseAdapter() {
			override fun mouseEntered(e: MouseEvent) { setRowHovered(true) }
			override fun mouseExited(e: MouseEvent) {
				val src = e.source as Component
				if (!src.isShowing || !row.isShowing) {
					setRowHovered(false)
					return
				}
				val p = e.point
				val screen = src.locationOnScreen.apply { translate(p.x, p.y) }
				val loc = row.locationOnScreen
				if (!java.awt.Rectangle(loc.x, loc.y, row.width, row.height).contains(screen)) {
					setRowHovered(false)
				}
			}
		}
		val click = object : MouseAdapter() {
			override fun mouseClicked(e: MouseEvent) { openPinned(entry) }
		}
		for (c in listOf(row, west, badge, title)) {
			c.addMouseListener(hover)
			c.addMouseListener(click)
		}
		actions.forEach { it.addMouseListener(hover) }
		return row
	}

	private fun actionIcon(icon: javax.swing.Icon, tip: String, onClick: () -> Unit): JBLabel = JBLabel(icon).apply {
		toolTipText = tip
		cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
		isVisible = false
		border = JBUI.Borders.empty(0, 2)
		addMouseListener(object : MouseAdapter() {
			override fun mouseClicked(e: MouseEvent) {
				e.consume()
				onClick()
			}
		})
	}

	/** Resume a pinned conversation directly in terminal (Claude or Codex). */
	private fun resumeInTerminal(entry: PinStore.PinnedEntry) {
		val cwd = cwd() ?: return
		val sessionId = entry.key.substringAfter(":")
		if (sessionId.isNotBlank()) {
			ai.jolli.jollimemory.core.telemetry.Telemetry.track("session_resumed", mapOf("source" to entry.badge.lowercase()))
			TerminalUtils.resumeSession(project, entry.badge, sessionId, cwd, entry.title)
		}
	}

	private fun badgeColor(entry: PinStore.PinnedEntry): Color = when (entry.kind) {
		"conversations" -> SOURCE_COLORS[entry.badge.lowercase()] ?: JBColor.GRAY
		else -> TAG_COLORS[entry.badge] ?: JBColor.GRAY
	}

	// ── Open content on click ───────────────────────────────────────────────

	private fun openPinned(entry: PinStore.PinnedEntry) {
		val cwd = cwd() ?: return
		when (entry.kind) {
			"conversations" -> openConversation(entry.key, cwd)
			"plans" -> openPath(SessionTracker.loadPlansRegistry(cwd).plans[entry.key]?.sourcePath)
			"notes" -> openPath((SessionTracker.loadPlansRegistry(cwd).notes ?: emptyMap())[entry.key]?.sourcePath)
			"references" -> openPath((SessionTracker.loadPlansRegistry(cwd).references ?: emptyMap())[entry.key]?.sourcePath)
			"memories" -> openMemory(entry.key)
		}
	}

	private fun openPath(path: String?) {
		if (path.isNullOrBlank()) return
		val vf = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(File(path)) ?: return
		// Plans / notes / references are markdown — open rendered (preview), like the mockup.
		MarkdownPreview.open(project, vf)
	}

	private fun openConversation(key: String, cwd: String) {
		ApplicationManager.getApplication().executeOnPooledThread {
			val item = try {
				ActiveSessionAggregator.listActiveConversationsWithDiagnostics(cwd).items.firstOrNull {
					CommitSelectionStore.conversationKey(it.source, it.sessionId) == key
				}
			} catch (e: Exception) {
				// The click silently no-ops if the bridge is down. At least log so a
				// user report can be traced back to a transport failure rather than
				// a missing pinned session.
				ai.jolli.jollimemory.core.JmLogger.create("PinnedPanel")
					.warn("openConversation: listActiveConversations failed for key=%s: %s", key, e.message)
				null
			}
			SwingUtilities.invokeLater {
				if (item != null) {
					FileEditorManager.getInstance(project).openFile(ConversationVirtualFile(item, cwd), true)
				}
			}
		}
	}

	private fun openMemory(hash: String) {
		ApplicationManager.getApplication().executeOnPooledThread {
			val summary = service.getSummary(hash)
			SwingUtilities.invokeLater {
				if (summary != null) {
					// Full memory UI (Create PR etc.), same as the Committed Memories view.
					FileEditorManager.getInstance(project).openFile(SummaryVirtualFile(summary), true)
				}
			}
		}
	}

	override fun dispose() {}

	/** Small rounded pill mirroring the source row's badge (letter tag or source name). */
	private class BadgePill(text: String, private val color: Color) : JLabel(text, SwingConstants.CENTER) {
		init {
			foreground = Color.WHITE
			font = JBUI.Fonts.label(9f).deriveFont(Font.BOLD)
			isOpaque = false
			border = JBUI.Borders.empty(1, 6)
		}

		override fun getPreferredSize(): Dimension {
			val base = super.getPreferredSize()
			return Dimension(base.width.coerceAtLeast(JBUI.scale(18)), JBUI.scale(16))
		}

		override fun paintComponent(g: Graphics) {
			val g2 = g.create() as Graphics2D
			try {
				g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
				g2.color = color
				val arc = JBUI.scale(8)
				g2.fillRoundRect(0, 0, width, height, arc, arc)
			} finally {
				g2.dispose()
			}
			super.paintComponent(g)
		}
	}

	private companion object {

		// Mirrors ConversationRowComponent.SourceBadge colors.
		val SOURCE_COLORS = mapOf(
			"claude" to JBColor(Color(217, 119, 6), Color(217, 119, 6)),
			"gemini" to JBColor(Color(5, 150, 105), Color(5, 150, 105)),
			"codex" to JBColor(Color(124, 58, 237), Color(124, 58, 237)),
			"opencode" to JBColor(Color(37, 99, 235), Color(37, 99, 235)),
			"cursor" to JBColor(Color(220, 38, 38), Color(220, 38, 38)),
		)
		// Mirrors PlansPanel tag colors (P/N/S/L/GH/J/No).
		val TAG_COLORS = mapOf(
			"P" to JBColor(0x4C82F7, 0x4C82F7),
			"N" to JBColor(0x3FA45B, 0x3FA45B),
			"S" to JBColor(0xC9851E, 0xD18616),
			"L" to JBColor(0x7A6FF0, 0x8A7FF5),
			"GH" to JBColor(0x6E7681, 0x8B949E),
			"J" to JBColor(0x2A78C8, 0x3B82D6),
			"No" to JBColor(0x6B6B6B, 0x9B9B9B),
		)
	}
}

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
import com.intellij.openapi.ui.Messages
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
import java.awt.RenderingHints
import java.awt.Toolkit
import java.awt.datatransfer.StringSelection
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.io.File
import javax.swing.BoxLayout
import javax.swing.JLabel
import javax.swing.JPanel
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
		val row = JPanel(BorderLayout()).apply {
			border = JBUI.Borders.empty(2, 4)
			maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(26))
			alignmentX = Component.LEFT_ALIGNMENT
			isOpaque = false
			cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
		}

		val left = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(4), 0)).apply { isOpaque = false }
		// Conversation pins lead with the AI tool's real logo (badge = source name);
		// other kinds keep their letter/tag pill.
		val sourceLogo = if (entry.kind == "conversations") JolliMemoryIcons.sourceLogo(entry.badge.lowercase()) else null
		if (sourceLogo != null) {
			left.add(JLabel(sourceLogo).apply { toolTipText = entry.badge })
		} else {
			left.add(BadgePill(entry.badge, badgeColor(entry)))
		}
		val title = JBLabel(entry.title).apply { minimumSize = Dimension(0, 0) }
		left.add(title)
		row.add(left, BorderLayout.CENTER)

		// Hover actions, right edge: Open (eye) · Recall (play) · Unpin.
		val openBtn = actionIcon(JolliMemoryIcons.Eye, "Open") { openPinned(entry) }
		val recallBtn = actionIcon(AllIcons.Actions.Execute, "Recall") { recallPinned(entry) }
		val unpinBtn = actionIcon(AllIcons.Actions.Close, "Unpin") {
			val dir = cwd() ?: return@actionIcon
			ApplicationManager.getApplication().executeOnPooledThread {
				PinStore.unpin(dir, entry.kind, entry.key)
				refresh()
			}
		}
		val actions = listOf(openBtn, recallBtn, unpinBtn)
		val east = JPanel(FlowLayout(FlowLayout.RIGHT, JBUI.scale(2), 0)).apply {
			isOpaque = false
			actions.forEach { add(it) }
		}
		row.add(east, BorderLayout.EAST)

		val hover = object : MouseAdapter() {
			override fun mouseEntered(e: MouseEvent) { actions.forEach { it.isVisible = true } }
			override fun mouseExited(e: MouseEvent) {
				val p = e.point
				val src = e.source as Component
				val screen = src.locationOnScreen.apply { translate(p.x, p.y) }
				val loc = row.locationOnScreen
				if (!java.awt.Rectangle(loc.x, loc.y, row.width, row.height).contains(screen)) {
					actions.forEach { it.isVisible = false }
				}
			}
		}
		val click = object : MouseAdapter() {
			override fun mouseClicked(e: MouseEvent) { openPinned(entry) }
		}
		for (c in listOf(row, left, title)) {
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

	/** Recall action (play): copies the recall prompt for the current branch. */
	private fun recallPinned(entry: PinStore.PinnedEntry) {
		val branch = service.getGitOps()?.getCurrentBranch()
		if (branch.isNullOrBlank()) {
			Messages.showWarningDialog(project, "Could not determine the current branch.", "Recall")
			return
		}
		val prompt = "Invoke the \"jolli-recall\" skill with args \"$branch\"."
		Toolkit.getDefaultToolkit().systemClipboard.setContents(StringSelection(prompt), null)
		Messages.showInfoMessage(project, "Recall prompt copied — paste it into your AI coding tool.", "Recall")
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
			} catch (_: Exception) { null }
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

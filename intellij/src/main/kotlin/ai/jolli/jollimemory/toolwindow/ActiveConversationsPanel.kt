package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.ActiveConversationItem
import ai.jolli.jollimemory.core.ActiveConversationsResult
import ai.jolli.jollimemory.core.ActiveSessionAggregator
import ai.jolli.jollimemory.core.CommitSelectionStore
import ai.jolli.jollimemory.core.TranscriptSource
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Component
import java.awt.Dimension
import javax.swing.*

/**
 * CONVERSATIONS accordion panel — lists active AI conversations from all
 * sources, with 60-second background polling. Clicking a row opens the
 * transcript as an editor tab for inline editing.
 */
class ActiveConversationsPanel(
	private val project: Project,
	private val service: JolliMemoryService,
) : JPanel(BorderLayout()), Disposable, RowCountSource {

	override var onRowCountChanged: ((Int) -> Unit)? = null
	private var rowCount = 0
	override fun currentRowCount(): Int = rowCount

	private val rowsPanel = JPanel().apply {
		layout = BoxLayout(this, BoxLayout.Y_AXIS)
		// Match PINNED's container insets so the first/last row edge gaps line up.
		border = JBUI.Borders.empty(2, 4)
	}
	private val emptyLabel = JBLabel("No active conversations").apply {
		horizontalAlignment = SwingConstants.CENTER
		foreground = JBColor.GRAY
		border = JBUI.Borders.empty(16)
	}
	private val warningBanner = JPanel(BorderLayout()).apply {
		isVisible = false
		border = JBUI.Borders.empty(4, 8)
		background = JBColor(java.awt.Color(255, 243, 205), java.awt.Color(66, 56, 20))
		add(JBLabel("Some sources failed to load").apply {
			foreground = JBColor(java.awt.Color(133, 100, 4), java.awt.Color(250, 204, 21))
		}, BorderLayout.CENTER)
	}

	private var conversations: List<ActiveConversationItem> = emptyList()
	private var failedSources: List<TranscriptSource> = emptyList()

	/** Whether the user expanded past the 6-row cap (via "Show N more"). */
	private var expanded = false

	private val statusListener: () -> Unit = { refresh() }

	private val pollTimer = Timer(60_000) {
		if (isShowing) {
			refresh()
			// JOLLI-1785: piggyback the 60s tick to flush buffered telemetry — on a
			// pooled thread, NOT the EDT. The Swing Timer fires on the EDT and
			// flushNow does a blocking HTTP send (kept synchronous for the hook path),
			// so a slow DNS lookup / network would otherwise freeze the UI.
			// Best-effort; the helper swallows errors and no-ops on an empty buffer.
			project.basePath?.let { base ->
				ApplicationManager.getApplication().executeOnPooledThread {
					ai.jolli.jollimemory.core.telemetry.TelemetryActivation.flushNow(base)
				}
			}
		}
	}.apply { isRepeats = true }

	init {
		// No inner scrollbar — Current Memory provides a single scrollbar across all
		// three sections. Rows are placed in NORTH so the panel reports its natural
		// height (capped at 6 rows unless expanded).
		warningBanner.alignmentX = Component.LEFT_ALIGNMENT
		rowsPanel.alignmentX = Component.LEFT_ALIGNMENT
		val content = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.Y_AXIS)
			isOpaque = false
			add(warningBanner)
			add(rowsPanel)
		}
		add(content, BorderLayout.NORTH)

		service.addStatusListener(statusListener)
		pollTimer.start()

		// Initial load
		ApplicationManager.getApplication().executeOnPooledThread { loadData() }
	}

	fun refresh() {
		ApplicationManager.getApplication().executeOnPooledThread { loadData() }
	}

	override fun dispose() {
		pollTimer.stop()
		service.removeStatusListener(statusListener)
	}

	// ── Data loading ────────────────────────────────────────────────────

	private fun loadData() {
		val cwd = service.mainRepoRoot ?: project.basePath ?: return
		// A bridge / transport failure means we don't know which sources are OK,
		// so mark ALL of them as failed. Without this, an empty `failedSources`
		// hides the warning banner and the user sees a "no active conversations"
		// row that is really "sidebar can't reach the CLI daemon".
		val result: ActiveConversationsResult = try {
			ActiveSessionAggregator.listActiveConversationsWithDiagnostics(cwd)
		} catch (e: Exception) {
			ActiveConversationsResult(emptyList(), TranscriptSource.entries.toList())
		}
		val exclusions = CommitSelectionStore.readExclusions(cwd)
		val itemsWithSelection = result.items.map { item ->
			val key = CommitSelectionStore.conversationKey(item.source, item.sessionId)
			item.copy(isSelected = key !in exclusions.conversations)
		}
		val adjusted = ActiveConversationsResult(itemsWithSelection, result.failedSources)
		SwingUtilities.invokeLater { updateUI(adjusted) }
	}

	private fun updateUI(result: ActiveConversationsResult) {
		conversations = result.items
		failedSources = result.failedSources
		warningBanner.isVisible = failedSources.isNotEmpty()
		renderRows()
	}

	private fun renderRows() {
		rowCount = conversations.size
		onRowCountChanged?.invoke(rowCount)
		if (conversations.isEmpty()) {
			rowsPanel.removeAll()
			rowsPanel.add(emptyLabel)
			rowsPanel.revalidate()
			rowsPanel.repaint()
			return
		}
		val comps = conversations.map { item ->
			ConversationRowComponent(
				item = item,
				onRowClicked = ::onRowClicked,
				onPin = ::onPin,
				onResume = ::onResume,
				onSelectionChanged = ::onSelectionChanged,
			)
		}
		CappedRows.render(rowsPanel, comps, expanded) {
			expanded = true
			renderRows()
		}
	}

	override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)

	// ── Row actions ─────────────────────────────────────────────────────

	private fun onRowClicked(item: ActiveConversationItem) {
		val cwd = service.mainRepoRoot ?: project.basePath ?: return
		val vf = ConversationVirtualFile(item, cwd)
		val editors = FileEditorManager.getInstance(project).openFile(vf, true)
		// Wire the save callback so the list refreshes after edits
		for (editor in editors) {
			if (editor is ConversationFileEditor) {
				editor.onSaved = { refresh() }
			}
		}
	}

	private fun onResume(item: ActiveConversationItem) {
		if (!TerminalUtils.canResumeSource(item.source.name)) return
		val cwd = service.mainRepoRoot ?: project.basePath ?: return
		TerminalUtils.resumeSession(project, item.source.name, item.sessionId, cwd, item.title)
	}

	private fun onSelectionChanged(item: ActiveConversationItem, selected: Boolean) {
		val cwd = service.mainRepoRoot ?: project.basePath ?: return
		val key = CommitSelectionStore.conversationKey(item.source, item.sessionId)
		ApplicationManager.getApplication().executeOnPooledThread {
			CommitSelectionStore.setExcluded(cwd, "conversations", key, !selected)
			service.notifySelectionChanged()
		}
	}

	fun toggleSelectAll() {
		val anyUnchecked = conversations.any { !it.isSelected }
		val cwd = service.mainRepoRoot ?: project.basePath ?: return
		val keys = conversations.map { CommitSelectionStore.conversationKey(it.source, it.sessionId) }
		ApplicationManager.getApplication().executeOnPooledThread {
			CommitSelectionStore.setAllExcluded(cwd, "conversations", keys, !anyUnchecked)
			service.notifySelectionChanged()
			SwingUtilities.invokeLater { refresh() }
		}
	}

	private fun onPin(item: ActiveConversationItem) {
		val cwd = service.mainRepoRoot ?: project.basePath ?: return
		val key = CommitSelectionStore.conversationKey(item.source, item.sessionId)
		val title = item.title.ifBlank { "${item.source.name} conversation" }
		// Pinning a conversation mirrors PlansPanel/CommitsPanel pins (memory_pinned);
		// without this, conversation pins were the one pin path with no telemetry
		// (unpin was already tracked in PinnedPanel — this restores the symmetry).
		ai.jolli.jollimemory.core.telemetry.Telemetry.track("memory_pinned", mapOf("kind" to "conversations"))
		ApplicationManager.getApplication().executeOnPooledThread {
			ai.jolli.jollimemory.core.PinStore.pin(cwd, "conversations", key, title, item.source.name)
			SwingUtilities.invokeLater { service.panelRegistry?.pinnedPanel?.refresh() }
		}
	}
}

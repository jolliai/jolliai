package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.ActiveConversationItem
import ai.jolli.jollimemory.core.ActiveConversationsResult
import ai.jolli.jollimemory.core.ActiveSessionAggregator
import ai.jolli.jollimemory.core.CommitSelectionStore
import ai.jolli.jollimemory.core.HiddenConversationsStore
import ai.jolli.jollimemory.core.TranscriptSource
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import javax.swing.*

/**
 * CONVERSATIONS accordion panel — lists active AI conversations from all
 * sources, with 60-second background polling. Clicking a row opens the
 * transcript as an editor tab for inline editing.
 */
class ActiveConversationsPanel(
	private val project: Project,
	private val service: JolliMemoryService,
) : JPanel(BorderLayout()), Disposable {

	private val rowsPanel = JPanel().apply {
		layout = BoxLayout(this, BoxLayout.Y_AXIS)
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

	private val statusListener: () -> Unit = { refresh() }

	private val pollTimer = Timer(60_000) {
		if (isShowing) {
			refresh()
			// JOLLI-1785: piggyback the 60s tick to flush buffered telemetry.
			// Best-effort; the helper swallows errors and no-ops on an empty buffer.
			project.basePath?.let { ai.jolli.jollimemory.core.telemetry.TelemetryActivation.flushNow(it) }
		}
	}.apply { isRepeats = true }

	init {
		val scrollPane = JBScrollPane(rowsPanel).apply {
			border = JBUI.Borders.empty()
			verticalScrollBarPolicy = ScrollPaneConstants.VERTICAL_SCROLLBAR_AS_NEEDED
		}
		add(warningBanner, BorderLayout.NORTH)
		add(scrollPane, BorderLayout.CENTER)

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
		val result: ActiveConversationsResult = try {
			ActiveSessionAggregator.listActiveConversationsWithDiagnostics(cwd)
		} catch (e: Exception) {
			ActiveConversationsResult(emptyList(), emptyList())
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

		rowsPanel.removeAll()
		if (conversations.isEmpty()) {
			rowsPanel.add(emptyLabel)
		} else {
			for (item in conversations) {
				rowsPanel.add(ConversationRowComponent(
					item = item,
					onRowClicked = ::onRowClicked,
					onHide = ::onHide,
					onPin = ::onPin,
					onSelectionChanged = ::onSelectionChanged,
				))
			}
		}
		rowsPanel.add(Box.createVerticalGlue())
		rowsPanel.revalidate()
		rowsPanel.repaint()
	}

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

	private fun onSelectionChanged(item: ActiveConversationItem, selected: Boolean) {
		val cwd = service.mainRepoRoot ?: project.basePath ?: return
		val key = CommitSelectionStore.conversationKey(item.source, item.sessionId)
		ApplicationManager.getApplication().executeOnPooledThread {
			CommitSelectionStore.setExcluded(cwd, "conversations", key, !selected)
		}
	}

	fun toggleSelectAll() {
		val anyUnchecked = conversations.any { !it.isSelected }
		val cwd = service.mainRepoRoot ?: project.basePath ?: return
		val keys = conversations.map { CommitSelectionStore.conversationKey(it.source, it.sessionId) }
		ApplicationManager.getApplication().executeOnPooledThread {
			CommitSelectionStore.setAllExcluded(cwd, "conversations", keys, !anyUnchecked)
			SwingUtilities.invokeLater { refresh() }
		}
	}

	private fun onHide(item: ActiveConversationItem) {
		val cwd = service.mainRepoRoot ?: project.basePath ?: return
		ApplicationManager.getApplication().executeOnPooledThread {
			HiddenConversationsStore.hideConversation(cwd, item.source, item.sessionId)
			SwingUtilities.invokeLater { refresh() }
		}
	}

	private fun onPin(item: ActiveConversationItem) {
		val cwd = service.mainRepoRoot ?: project.basePath ?: return
		val key = CommitSelectionStore.conversationKey(item.source, item.sessionId)
		val title = item.title.ifBlank { "${item.source.name} conversation" }
		ApplicationManager.getApplication().executeOnPooledThread {
			ai.jolli.jollimemory.core.PinStore.pin(cwd, "conversations", key, title, item.source.name)
			SwingUtilities.invokeLater { service.panelRegistry?.pinnedPanel?.refresh() }
		}
	}
}

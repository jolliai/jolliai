package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.core.ActiveConversationItem
import ai.jolli.jollimemory.core.ActiveConversationsResult
import ai.jolli.jollimemory.core.ActiveSessionAggregator
import ai.jolli.jollimemory.core.ConversationViewMode
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
import java.awt.FlowLayout
import javax.swing.*

/**
 * CONVERSATIONS accordion panel — lists AI conversations from all sources,
 * with 60-second background polling. Supports three views: Active, All, Branch.
 * Clicking a row opens the transcript as an editor tab for inline editing.
 */
class ActiveConversationsPanel(
	private val project: Project,
	private val service: JolliMemoryService,
) : JPanel(BorderLayout()), Disposable {

	private var viewMode = ConversationViewMode.ACTIVE

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
	/** Cached set of local branches for tag chip rendering. */
	private var existingBranches: Set<String> = emptySet()

	private val statusListener: () -> Unit = { refresh() }

	private val pollTimer = Timer(60_000) {
		if (isShowing) refresh()
	}.apply { isRepeats = true }

	// ── View toggle ────────────────────────────────────────────────────

	private val activeButton = JToggleButton("Active").apply { isSelected = true }
	private val allButton = JToggleButton("All")
	private val branchButton = JToggleButton("Branch")
	private val viewToggleGroup = ButtonGroup().apply {
		add(activeButton)
		add(allButton)
		add(branchButton)
	}
	private val viewTogglePanel = JPanel(FlowLayout(FlowLayout.LEFT, 0, 0)).apply {
		border = JBUI.Borders.empty(4, 8)
		isOpaque = false
		add(activeButton)
		add(allButton)
		add(branchButton)
	}

	init {
		// View toggle listeners
		activeButton.addActionListener { if (viewMode != ConversationViewMode.ACTIVE) { viewMode = ConversationViewMode.ACTIVE; refresh() } }
		allButton.addActionListener { if (viewMode != ConversationViewMode.ALL) { viewMode = ConversationViewMode.ALL; refresh() } }
		branchButton.addActionListener { if (viewMode != ConversationViewMode.BRANCH) { viewMode = ConversationViewMode.BRANCH; refresh() } }

		val topPanel = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.Y_AXIS)
			add(viewTogglePanel)
			add(warningBanner)
		}

		val scrollPane = JBScrollPane(rowsPanel).apply {
			border = JBUI.Borders.empty()
			verticalScrollBarPolicy = ScrollPaneConstants.VERTICAL_SCROLLBAR_AS_NEEDED
		}
		add(topPanel, BorderLayout.NORTH)
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

	companion object {
		private const val WINDOW_48H = 2L * 24 * 60 * 60 * 1000
		private const val WINDOW_7D = 7L * 24 * 60 * 60 * 1000
	}

	private fun loadData() {
		val cwd = service.mainRepoRoot ?: project.basePath ?: return
		val windowMs = when (viewMode) {
			ConversationViewMode.ACTIVE -> WINDOW_48H
			ConversationViewMode.ALL -> WINDOW_7D
			ConversationViewMode.BRANCH -> WINDOW_7D
		}
		val requireUnread = viewMode == ConversationViewMode.ACTIVE
		val result: ActiveConversationsResult = try {
			ActiveSessionAggregator.listActiveConversationsWithDiagnostics(cwd, windowMs, requireUnread)
		} catch (e: Exception) {
			ActiveConversationsResult(emptyList(), emptyList())
		}

		// For BRANCH mode, filter to sessions tagged to current branch
		val filtered = if (viewMode == ConversationViewMode.BRANCH) {
			val currentBranch = try { GitOps(cwd).getCurrentBranch() } catch (_: Exception) { null }
			if (currentBranch != null) {
				val filteredItems = result.items.filter { currentBranch in it.branchTags }
				ActiveConversationsResult(filteredItems, result.failedSources)
			} else result
		} else result

		// Precompute existing branches for tag chip rendering
		val branches = try { GitOps(cwd).listBranches().toSet() } catch (_: Exception) { emptySet() }

		SwingUtilities.invokeLater { updateUI(filtered, branches) }
	}

	private fun updateUI(result: ActiveConversationsResult, branches: Set<String> = emptySet()) {
		conversations = result.items
		failedSources = result.failedSources
		existingBranches = branches

		warningBanner.isVisible = failedSources.isNotEmpty()

		rowsPanel.removeAll()
		if (conversations.isEmpty()) {
			emptyLabel.text = when (viewMode) {
				ConversationViewMode.ACTIVE -> "No active conversations"
				ConversationViewMode.ALL -> "No conversations in the past week"
				ConversationViewMode.BRANCH -> "No conversations tagged to this branch"
			}
			rowsPanel.add(emptyLabel)
		} else {
			val cwd = service.mainRepoRoot ?: project.basePath ?: ""
			for (item in conversations) {
				rowsPanel.add(ConversationRowComponent(
					item = item,
					cwd = cwd,
					existingBranches = existingBranches,
					onRowClicked = ::onRowClicked,
					onHide = ::onHide,
					onTagsChanged = { refresh() },
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

	private fun onHide(item: ActiveConversationItem) {
		val cwd = service.mainRepoRoot ?: project.basePath ?: return
		ApplicationManager.getApplication().executeOnPooledThread {
			HiddenConversationsStore.hideConversation(cwd, item.source, item.sessionId)
			SwingUtilities.invokeLater { refresh() }
		}
	}
}

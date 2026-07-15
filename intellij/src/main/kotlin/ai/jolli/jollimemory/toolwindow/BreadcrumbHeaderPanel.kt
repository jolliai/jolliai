package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.KBDataCache
import ai.jolli.jollimemory.core.KBPathResolver
import ai.jolli.jollimemory.core.KBRepoDiscoverer
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.icons.AllIcons
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Cursor
import java.awt.Dimension
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultListCellRenderer
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.SwingConstants
import javax.swing.SwingUtilities

/**
 * Breadcrumb header below the view switch: Repo / Branch selectors.
 *
 * Two modes (set by the factory in response to the [ViewSwitchPanel]):
 * - [Mode.BRANCH] — Current Branch view: shows `repo / branch` selectors.
 * - [Mode.REPO_FILTER] — Memory Bank / Knowledge views: shows a single
 *   "Showing: <repo>" filter (branch part hidden).
 *
 * The Memory Bank toggle and the Agents / Settings / Status icons that used to
 * live here moved to the view switch and the tool window title bar respectively;
 * this row is now just the repo/branch selectors. Selecting a foreign repo/branch
 * fires [onSelectionChanged] so the factory can toggle read-only mode.
 *
 * The pickers are flat label + chevron "crumbs" (mockup `.crumb` styling) backed by
 * a popup list rather than `JComboBox`: the LaF combo paints its own (lighter) field
 * + arrow-button background that can't be flattened to the header, so a label that
 * inherits the header background is the only way to make them blend in.
 */
class BreadcrumbHeaderPanel(
	private val service: JolliMemoryService,
	private val onSelectionChanged: (repo: String?, branch: String?, isForeign: Boolean) -> Unit,
) : JPanel(BorderLayout()) {

	enum class Mode { BRANCH, REPO_FILTER }

	private val showingLabel = JBLabel("Showing:")
	private val slashLabel = JBLabel("/")

	private val repoPicker = CrumbPicker(
		isWorkspaceItem = { _, index -> index == 0 && repos.any { it.isCurrentRepo } },
		onPick = { onRepoSelected() },
	)
	private val branchPicker = CrumbPicker(
		isWorkspaceItem = { value, _ ->
			val isCurrentRepo = repos.find { it.repoName == repoPicker.selected }?.isCurrentRepo == true
			isCurrentRepo && value == currentBranch
		},
		onPick = { onBranchSelected() },
	)

	private var mode = Mode.BRANCH

	private var currentRepoName: String? = null
	private var currentBranch: String? = null
	private var repos: List<KBRepoDiscoverer.DiscoveredRepo> = emptyList()

	init {
		border = JBUI.Borders.empty(4, 8)

		// Breadcrumb text is 12px in the mockup (base − 1).
		for (c in listOf<JLabel>(slashLabel, showingLabel)) {
			c.font = c.font.deriveFont(c.font.size2D - 1f)
		}

		showingLabel.isVisible = false
		// Mockup breadcrumb is text label + chevron only (no leading repo/branch icons).
		val selectorPanel = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.X_AXIS)
			isOpaque = false
			add(showingLabel)
			add(Box.createHorizontalStrut(JBUI.scale(4)))
			add(repoPicker)
			add(Box.createHorizontalStrut(JBUI.scale(4)))
			add(slashLabel)
			add(Box.createHorizontalStrut(JBUI.scale(4)))
			add(branchPicker)
		}
		add(selectorPanel, BorderLayout.CENTER)
	}

	/** Switches between branch selectors and the repo-filter ("Showing:") display. */
	fun setMode(newMode: Mode) {
		if (mode == newMode) return
		mode = newMode
		val branchVisible = newMode == Mode.BRANCH
		slashLabel.isVisible = branchVisible
		branchPicker.isVisible = branchVisible
		showingLabel.isVisible = !branchVisible
		revalidate()
		repaint()
	}

	/** Populate pickers. Call from a background thread after KB data is loaded. */
	fun refresh() {
		val gitOps = service.getGitOps() ?: return
		currentRepoName = service.mainRepoRoot?.let { KBPathResolver.extractRepoName(it) }
		currentBranch = gitOps.getCurrentBranch()
		val currentRemoteUrl = service.mainRepoRoot?.let { KBPathResolver.getRemoteUrl(it) }

		val config = ai.jolli.jollimemory.core.SessionTracker.loadConfig()
		val discoveredRepos = KBRepoDiscoverer.discover(
			currentRepoName = currentRepoName,
			currentRemoteUrl = currentRemoteUrl,
			customParent = config.knowledgeBasePath,
		)
		repos = discoveredRepos

		val repoNames = discoveredRepos.map { it.repoName }

		SwingUtilities.invokeLater {
			repoPicker.setItems(repoNames)
			// Current repo is first.
			repoPicker.setSelectedSilently(repoNames.firstOrNull())
			refreshBranches()
		}
	}

	private fun onRepoSelected() {
		// User picked a repo in the breadcrumb (setSelectedSilently doesn't fire onPick,
		// so this is genuinely user-driven). is_foreign = not the workspace's own repo.
		val isForeign = repos.find { it.repoName == repoPicker.selected }?.isCurrentRepo != true
		ai.jolli.jollimemory.core.telemetry.Telemetry.track("repo_switched", mapOf("is_foreign" to isForeign))
		refreshBranches()
	}

	private fun refreshBranches() {
		val selectedRepo = repoPicker.selected ?: return
		val isCurrentRepo = repos.find { it.repoName == selectedRepo }?.isCurrentRepo == true

		ApplicationManager.getApplication().executeOnPooledThread {
			val branches = if (isCurrentRepo) {
				service.getGitOps()?.listBranches() ?: emptyList()
			} else {
				// Foreign repo: get branches from KB data
				KBDataCache.all()
					.filter { it.repo == selectedRepo && !it.branch.isNullOrBlank() }
					.map { it.branch!! }
					.distinct()
					.sorted()
			}

			SwingUtilities.invokeLater {
				branchPicker.setItems(branches)
				if (isCurrentRepo && currentBranch != null) {
					branchPicker.setSelectedSilently(currentBranch)
				} else {
					branchPicker.setSelectedSilently(branches.firstOrNull())
				}
				// Cascade from a repo switch — repo_switched already fired, so don't
				// also emit branch_switched (would double-count one user action).
				onBranchSelected(trackSwitch = false)
			}
		}
	}

	private fun onBranchSelected(trackSwitch: Boolean = true) {
		val selectedRepo = repoPicker.selected ?: return
		val selectedBranch = branchPicker.selected ?: return
		val isCurrentRepo = repos.find { it.repoName == selectedRepo }?.isCurrentRepo == true
		val isForeign = !isCurrentRepo || selectedBranch != currentBranch

		// Only a genuine branch pick emits branch_switched; the repo-cascade path
		// passes trackSwitch=false (see refreshBranches).
		if (trackSwitch) {
			ai.jolli.jollimemory.core.telemetry.Telemetry.track("branch_switched", mapOf("is_foreign" to isForeign))
		}
		onSelectionChanged(
			if (isForeign) selectedRepo else null,
			if (isForeign) selectedBranch else null,
			isForeign,
		)
	}

	/** Update the current branch display without full refresh (e.g., on branch switch). */
	fun updateCurrentBranch(branch: String) {
		currentBranch = branch
		SwingUtilities.invokeLater {
			val isCurrentRepo = repos.find { it.repoName == repoPicker.selected }?.isCurrentRepo == true
			if (!isCurrentRepo) return@invokeLater
			// A freshly created branch isn't in the picker's list yet, so simply
			// selecting it by name is a no-op. Re-list branches from git in that case
			// so the new branch appears and gets selected.
			if (branchPicker.hasItem(branch)) {
				branchPicker.setSelectedSilently(branch)
			} else {
				refreshBranches()
			}
		}
	}

	/**
	 * A flat breadcrumb "crumb": current value as label text + a trailing chevron,
	 * opening a popup list on click. Inherits the header background (no boxed combo
	 * field), matching the mockup's `.crumb` styling.
	 */
	private inner class CrumbPicker(
		private val isWorkspaceItem: (value: String, index: Int) -> Boolean,
		private val onPick: (String) -> Unit,
	) : JBLabel() {

		private var items: List<String> = emptyList()
		var selected: String? = null
			private set

		init {
			icon = AllIcons.General.ArrowDown
			horizontalTextPosition = SwingConstants.LEFT // chevron sits to the right of the text
			iconTextGap = JBUI.scale(2)
			font = font.deriveFont(font.size2D - 1f)
			cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
			border = JBUI.Borders.empty(1, 2)
			// Allow the elastic branch crumb to shrink (and clip to "…") on narrow windows.
			minimumSize = Dimension(JBUI.scale(30), preferredSize.height)
			addMouseListener(object : MouseAdapter() {
				override fun mouseClicked(e: MouseEvent) {
					if (SwingUtilities.isLeftMouseButton(e)) showPopup()
				}
			})
		}

		fun setItems(newItems: List<String>) {
			items = newItems
		}

		fun hasItem(value: String): Boolean = items.contains(value)

		/** Set the displayed selection without firing [onPick] (programmatic update). */
		fun setSelectedSilently(value: String?) {
			selected = value
			text = value ?: ""
		}

		private fun showPopup() {
			if (items.isEmpty()) return
			JBPopupFactory.getInstance()
				.createPopupChooserBuilder(items)
				.setRenderer(WorkspaceAwareCellRenderer(isWorkspaceItem))
				.setItemChosenCallback { chosen ->
					setSelectedSilently(chosen)
					onPick(chosen)
				}
				.createPopup()
				.showUnderneathOf(this)
		}
	}

	/**
	 * Cell renderer that bolds the workspace item, appends a muted "(current)"
	 * suffix, and draws a 1px separator below it — matching VS Code's breadcrumb
	 * dropdown styling.
	 */
	private inner class WorkspaceAwareCellRenderer(
		private val isWorkspaceItem: (String, Int) -> Boolean,
	) : DefaultListCellRenderer() {
		override fun getListCellRendererComponent(
			list: JList<*>, value: Any?, index: Int, isSelected: Boolean, cellHasFocus: Boolean,
		): java.awt.Component {
			val label = super.getListCellRendererComponent(list, value, index, isSelected, cellHasFocus) as JLabel
			val strValue = value as? String ?: return label
			val isWorkspace = isWorkspaceItem(strValue, index)

			if (isWorkspace) {
				label.text = "<html><b>$strValue</b> <span style='color:gray'>(current)</span></html>"
				// Separator line below the workspace item.
				if (index >= 0) {
					label.border = BorderFactory.createCompoundBorder(
						BorderFactory.createMatteBorder(0, 0, 1, 0, com.intellij.ui.JBColor.border()),
						JBUI.Borders.empty(1, 2),
					)
				}
			} else {
				label.text = strValue
				if (index >= 0) {
					label.border = JBUI.Borders.empty(1, 2)
				}
			}
			return label
		}
	}
}

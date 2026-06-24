package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.KBDataCache
import ai.jolli.jollimemory.core.KBPathResolver
import ai.jolli.jollimemory.core.KBRepoDiscoverer
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.icons.AllIcons
import com.intellij.openapi.application.ApplicationManager
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultComboBoxModel
import javax.swing.DefaultListCellRenderer
import javax.swing.JComboBox
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JPanel
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
 */
class BreadcrumbHeaderPanel(
	private val service: JolliMemoryService,
	private val onSelectionChanged: (repo: String?, branch: String?, isForeign: Boolean) -> Unit,
) : JPanel(BorderLayout()) {

	enum class Mode { BRANCH, REPO_FILTER }

	private val repoCombo = JComboBox<String>()
	private val branchCombo = JComboBox<String>()
	private val showingLabel = JBLabel("Showing:")
	private val slashLabel = JBLabel("/")
	private val branchIcon = JBLabel(AllIcons.Vcs.Branch)

	private var mode = Mode.BRANCH

	private var currentRepoName: String? = null
	private var currentBranch: String? = null
	private var repos: List<KBRepoDiscoverer.DiscoveredRepo> = emptyList()

	private var suppressEvents = false

	init {
		border = JBUI.Borders.empty(4, 8)

		// Custom renderers: bold + "(current)" + separator for workspace items
		repoCombo.renderer = WorkspaceAwareCellRenderer { _, index -> index == 0 && repos.any { it.isCurrentRepo } }
		branchCombo.renderer = WorkspaceAwareCellRenderer { value, _ ->
			val selectedRepo = repoCombo.selectedItem as? String
			val isCurrentRepo = repos.find { it.repoName == selectedRepo }?.isCurrentRepo == true
			isCurrentRepo && value == currentBranch
		}

		// Left: repo / branch selectors — BoxLayout so they shrink when the tool window is narrow
		repoCombo.minimumSize = Dimension(JBUI.scale(30), repoCombo.preferredSize.height)
		branchCombo.minimumSize = Dimension(JBUI.scale(30), branchCombo.preferredSize.height)
		showingLabel.isVisible = false
		val selectorPanel = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.X_AXIS)
			add(showingLabel)
			add(Box.createHorizontalStrut(JBUI.scale(4)))
			add(JBLabel(AllIcons.Nodes.Module))
			add(Box.createHorizontalStrut(JBUI.scale(4)))
			add(repoCombo)
			add(Box.createHorizontalStrut(JBUI.scale(4)))
			add(slashLabel)
			add(Box.createHorizontalStrut(JBUI.scale(4)))
			add(branchIcon)
			add(Box.createHorizontalStrut(JBUI.scale(4)))
			add(branchCombo)
		}
		add(selectorPanel, BorderLayout.CENTER)

		// Selection listeners
		repoCombo.addActionListener {
			if (suppressEvents) return@addActionListener
			onRepoSelected()
		}
		branchCombo.addActionListener {
			if (suppressEvents) return@addActionListener
			onBranchSelected()
		}
	}

	/** Switches between branch selectors and the repo-filter ("Showing:") display. */
	fun setMode(newMode: Mode) {
		if (mode == newMode) return
		mode = newMode
		val branchVisible = newMode == Mode.BRANCH
		slashLabel.isVisible = branchVisible
		branchIcon.isVisible = branchVisible
		branchCombo.isVisible = branchVisible
		showingLabel.isVisible = !branchVisible
		revalidate()
		repaint()
	}

	/** Populate combos. Call from a background thread after KB data is loaded. */
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
			suppressEvents = true
			repoCombo.model = DefaultComboBoxModel(repoNames.toTypedArray())
			if (repoNames.isNotEmpty()) {
				repoCombo.selectedIndex = 0 // current repo is first
			}
			suppressEvents = false
			refreshBranches()
		}
	}

	private fun onRepoSelected() {
		refreshBranches()
	}

	private fun refreshBranches() {
		val selectedRepo = repoCombo.selectedItem as? String ?: return
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
				suppressEvents = true
				branchCombo.model = DefaultComboBoxModel(branches.toTypedArray())
				if (isCurrentRepo && currentBranch != null) {
					branchCombo.selectedItem = currentBranch
				} else if (branches.isNotEmpty()) {
					branchCombo.selectedIndex = 0
				}
				suppressEvents = false
				onBranchSelected()
			}
		}
	}

	private fun onBranchSelected() {
		val selectedRepo = repoCombo.selectedItem as? String ?: return
		val selectedBranch = branchCombo.selectedItem as? String ?: return
		val isCurrentRepo = repos.find { it.repoName == selectedRepo }?.isCurrentRepo == true
		val isForeign = !isCurrentRepo || selectedBranch != currentBranch

		onSelectionChanged(
			if (isForeign) selectedRepo else null,
			if (isForeign) selectedBranch else null,
			isForeign,
		)
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
				// Separator line below the workspace item (only in dropdown, not in the collapsed combo)
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

	/** Update the current branch display without full refresh (e.g., on branch switch). */
	fun updateCurrentBranch(branch: String) {
		currentBranch = branch
		SwingUtilities.invokeLater {
			val selectedRepo = repoCombo.selectedItem as? String
			val isCurrentRepo = repos.find { it.repoName == selectedRepo }?.isCurrentRepo == true
			if (isCurrentRepo) {
				suppressEvents = true
				branchCombo.selectedItem = branch
				suppressEvents = false
			}
		}
	}
}

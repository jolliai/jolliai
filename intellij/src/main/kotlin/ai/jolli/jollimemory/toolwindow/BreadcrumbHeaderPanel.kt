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
	/**
	 * Fires whenever the "Showing: <repo>" picker selection changes in
	 * REPO_FILTER mode. Argument is the picked repo name, or `null` when the
	 * user picks the synthetic "All repos" entry. Independent of
	 * [onSelectionChanged] because "All repos" is not a real repo — it can't
	 * be routed through the branch / foreign-mode logic that callback owns.
	 * KBExplorerPanel consumes this to scope its tree/timeline render.
	 */
	private val onRepoFilterChanged: (repoName: String?) -> Unit = {},
) : JPanel(BorderLayout()) {

	enum class Mode { BRANCH, REPO_FILTER }

	companion object {
		/** Synthetic entry prepended to the repo picker in REPO_FILTER mode.
		 *  Selecting it broadens the KBExplorer tree back to every discovered
		 *  repo. VS Code uses the same literal in its sidebar dropdown so the
		 *  two IDE surfaces read identically. Localization: currently intentionally
		 *  English-only across CLI/VS Code/IntelliJ — keep in lockstep. */
		const val ALL_REPOS_LABEL = "All repos"

		/**
		 * Restore-selection rule when [setMode] repopulates the repo picker.
		 * Preserve [previous] ONLY if it's a member of [newItems]; otherwise
		 * fall back to the first non-[ALL_REPOS_LABEL] entry (the workspace
		 * repo — present in both modes' lists).
		 *
		 * Written this way because the unrestrained restore used to leak
		 * `ALL_REPOS_LABEL` from the Memory Bank picker into the Branch view's
		 * item list, where that label is not present. `onBranchSelected` would
		 * then hand `"All repos"` downstream as a repo name, blowing up KB
		 * lookups with no matching repo AND losing the workspace `(current)`
		 * bold in the popup renderer (index-0 check misfires).
		 *
		 * Exposed for unit tests — the Swing surface is otherwise heavy to
		 * instantiate in isolation.
		 */
		internal fun resolveRestoredRepoSelection(previous: String?, newItems: List<String>): String? {
			if (previous != null && previous in newItems) return previous
			return newItems.firstOrNull { it != ALL_REPOS_LABEL }
		}
	}

	private val showingLabel = JBLabel("Showing:")
	private val slashLabel = JBLabel("/")

	private val repoPicker = CrumbPicker(
		// In REPO_FILTER mode the picker prepends "All repos" at index 0, so the
		// current-repo entry is now at index 1 (VS Code parity — that's where
		// the sidebar puts "<repo> (current)" too). In BRANCH mode there's no
		// "All repos" prefix, so index 0 stays the workspace entry.
		isWorkspaceItem = { _, index ->
			val allReposIdx = if (mode == Mode.REPO_FILTER) 1 else 0
			index == allReposIdx && repos.any { it.isCurrentRepo }
		},
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
		// The picker's item list depends on mode ("All repos" is prepended only
		// in REPO_FILTER). Repopulate without a full refresh() so we don't lose
		// the current selection or refire a git branch enumeration.
		val previousSelection = repoPicker.selected
		val newItems = itemsForCurrentMode()
		repoPicker.setItems(newItems)
		val restored = resolveRestoredRepoSelection(previousSelection, newItems)
		repoPicker.setSelectedSilently(restored)
		// Newly entering REPO_FILTER (Memory Bank / Knowledge views): broadcast
		// the current selection so the KBExplorer tree scopes to it — otherwise
		// the tree stays "All repos" until the user pokes the picker.
		// Guard on repos.isNotEmpty(): setMode can be called during panel
		// construction before the first refresh() populates repos — firing
		// onRepoFilterChanged at that point triggers a tree rebuild against
		// an empty cachedRepos (harmless but wasteful flash of "No memories").
		if (newMode == Mode.REPO_FILTER && restored != null && restored != ALL_REPOS_LABEL && repos.isNotEmpty()) {
			onRepoFilterChanged(restored)
		}
		revalidate()
		repaint()
	}

	/**
	 * Items the repo picker should show for the current [mode]. In REPO_FILTER
	 * mode a synthetic "All repos" entry is prepended at index 0 so the user
	 * can broaden the Memory Bank / Knowledge view back out; in BRANCH mode the
	 * view is scoped to one repo/branch by design so the prefix is omitted.
	 */
	private fun itemsForCurrentMode(): List<String> {
		val repoNames = repos.map { it.repoName }
		return if (mode == Mode.REPO_FILTER) listOf(ALL_REPOS_LABEL) + repoNames else repoNames
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
			customParent = config.localFolder,
		)
		repos = discoveredRepos

		val repoNames = discoveredRepos.map { it.repoName }

		SwingUtilities.invokeLater {
			repoPicker.setItems(itemsForCurrentMode())
			// Default selection is the current repo (bolded "(current)" entry)
			// so the initial Memory Bank / Current Branch view is scoped like
			// VS Code's sidebar. Users pick "All repos" to broaden — never the
			// implicit default, because an unfiltered tree on 10+ repos is a
			// wall of text on cold start.
			repoPicker.setSelectedSilently(repoNames.firstOrNull())
			// Broadcast the initial filter so KBExplorer scopes its tree at
			// startup — setSelectedSilently deliberately skips onPick, and the
			// first user click would otherwise flip the tree from "all" to
			// "current repo" for no visible reason.
			if (mode == Mode.REPO_FILTER) onRepoFilterChanged(repoPicker.selected)
			refreshBranches()
		}
	}

	private fun onRepoSelected() {
		val selected = repoPicker.selected
		// In REPO_FILTER mode the picker may return the synthetic "All repos"
		// entry; fire onRepoFilterChanged with null and stop before the branch
		// refresh — there is no repo to look up branches for, and the existing
		// onSelectionChanged path expects a concrete repo name. In BRANCH mode
		// "All repos" is never in the item list, so this branch is a no-op there.
		if (selected == ALL_REPOS_LABEL) {
			ai.jolli.jollimemory.core.telemetry.Telemetry.track("repo_switched", mapOf("is_foreign" to false, "all_repos" to true))
			onRepoFilterChanged(null)
			return
		}
		// User picked a repo in the breadcrumb (setSelectedSilently doesn't fire onPick,
		// so this is genuinely user-driven). is_foreign = not the workspace's own repo.
		val isForeign = repos.find { it.repoName == selected }?.isCurrentRepo != true
		ai.jolli.jollimemory.core.telemetry.Telemetry.track("repo_switched", mapOf("is_foreign" to isForeign))
		// In REPO_FILTER mode the tree also needs to know which specific repo to
		// scope to; fire before refreshBranches so KBExplorer starts rebuilding
		// its filtered view in parallel with the branch lookup.
		if (mode == Mode.REPO_FILTER) onRepoFilterChanged(selected)
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
			// The renderer needs to know the currently-selected value so it can
			// draw a checkmark next to that row (VS Code parity). Passing it via
			// a getter — not a snapshot at popup-open time — is defensive: the
			// popup could outlive one paint pass, though in practice the
			// selection can't change until the callback fires.
			JBPopupFactory.getInstance()
				.createPopupChooserBuilder(items)
				.setRenderer(WorkspaceAwareCellRenderer(isWorkspaceItem) { selected })
				.setItemChosenCallback { chosen ->
					setSelectedSilently(chosen)
					onPick(chosen)
				}
				.createPopup()
				.showUnderneathOf(this)
		}
	}

	/**
	 * Cell renderer that:
	 *   - bolds the workspace repo and appends a muted "(current)" suffix,
	 *   - draws a 1px separator below the workspace row so the "All repos"
	 *     header + workspace pair reads as a group above the alphabetical tail,
	 *   - stamps a ✓ prefix on whichever row is currently selected in the
	 *     picker (VS Code parity — its Memory Bank dropdown checkmarks the
	 *     active repo).
	 *
	 * `getSelected` is a getter (not a snapshot) so the renderer stays correct
	 * across repaints — see [CrumbPicker.showPopup] for the wiring rationale.
	 */
	private inner class WorkspaceAwareCellRenderer(
		private val isWorkspaceItem: (String, Int) -> Boolean,
		private val getSelected: () -> String?,
	) : DefaultListCellRenderer() {
		override fun getListCellRendererComponent(
			list: JList<*>, value: Any?, index: Int, isSelected: Boolean, cellHasFocus: Boolean,
		): java.awt.Component {
			val label = super.getListCellRendererComponent(list, value, index, isSelected, cellHasFocus) as JLabel
			val strValue = value as? String ?: return label
			val isWorkspace = isWorkspaceItem(strValue, index)
			val isPicked = strValue == getSelected()
			// Fixed-width check gutter so the picked row lines up with the rest,
			// otherwise the label shifts left/right depending on which row is picked.
			val checkPrefix = if (isPicked) "✓ " else "  "

			if (isWorkspace) {
				label.text = "<html>$checkPrefix<b>$strValue</b> <span style='color:gray'>(current)</span></html>"
				// Separator line below the workspace item.
				if (index >= 0) {
					label.border = BorderFactory.createCompoundBorder(
						BorderFactory.createMatteBorder(0, 0, 1, 0, com.intellij.ui.JBColor.border()),
						JBUI.Borders.empty(3, 12, 3, 12),
					)
				}
			} else {
				label.text = "$checkPrefix$strValue"
				if (index >= 0) {
					label.border = JBUI.Borders.empty(3, 12, 3, 12)
				}
			}
			return label
		}
	}
}

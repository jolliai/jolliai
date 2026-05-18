package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.core.KBDataCache
import ai.jolli.jollimemory.core.KBPathResolver
import ai.jolli.jollimemory.core.KBRepoDiscoverer
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.icons.AllIcons
import com.intellij.openapi.application.ApplicationManager
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.BoxLayout
import javax.swing.DefaultComboBoxModel
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JPanel
import javax.swing.SwingUtilities
import javax.swing.UIManager

/**
 * Breadcrumb header above the accordion: Repo / Branch selectors + icon buttons.
 *
 * When the user selects a foreign repo or branch, [onSelectionChanged] fires
 * so the factory can toggle foreign mode on the panels.
 */
class BreadcrumbHeaderPanel(
	private val service: JolliMemoryService,
	private val onSelectionChanged: (repo: String?, branch: String?, isForeign: Boolean) -> Unit,
	private val onShowAccordion: () -> Unit,
	private val onShowKB: () -> Unit,
	private val onShowStatus: () -> Unit,
	private val onSettingsClicked: () -> Unit,
) : JPanel(BorderLayout()) {

	private val repoCombo = JComboBox<String>()
	private val branchCombo = JComboBox<String>()

	private var currentRepoName: String? = null
	private var currentBranch: String? = null
	private var repos: List<KBRepoDiscoverer.DiscoveredRepo> = emptyList()

	private var suppressEvents = false

	private var kbActive = false
	private var statusActive = false

	private val memoryBankBtn: JButton
	private val statusBtn: JButton

	private val toggleBg: Color
		get() = UIManager.getColor("ActionButton.pressedBackground")
			?: JBUI.CurrentTheme.ActionButton.pressedBackground()

	private val hoverBg: Color
		get() = UIManager.getColor("ActionButton.hoverBackground")
			?: JBUI.CurrentTheme.ActionButton.hoverBackground()

	/** Adds hover highlight to a breadcrumb icon button, respecting active toggle state. */
	private fun installHover(btn: JButton, isActive: () -> Boolean) {
		btn.addMouseListener(object : MouseAdapter() {
			override fun mouseEntered(e: MouseEvent) {
				if (!isActive()) {
					btn.background = hoverBg
					btn.isContentAreaFilled = true
				}
			}
			override fun mouseExited(e: MouseEvent) {
				if (!isActive()) {
					btn.background = UIManager.getColor("Panel.background") ?: background
					btn.isContentAreaFilled = false
				}
			}
		})
	}

	init {
		border = JBUI.Borders.empty(4, 8)

		// Left: repo / branch selectors — BoxLayout so they shrink when the tool window is narrow
		repoCombo.minimumSize = Dimension(JBUI.scale(30), repoCombo.preferredSize.height)
		branchCombo.minimumSize = Dimension(JBUI.scale(30), branchCombo.preferredSize.height)
		val selectorPanel = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.X_AXIS)
			add(JBLabel(AllIcons.Nodes.Module))
			add(javax.swing.Box.createHorizontalStrut(JBUI.scale(4)))
			add(repoCombo)
			add(javax.swing.Box.createHorizontalStrut(JBUI.scale(4)))
			add(JBLabel("/"))
			add(javax.swing.Box.createHorizontalStrut(JBUI.scale(4)))
			add(JBLabel(AllIcons.Vcs.Branch))
			add(javax.swing.Box.createHorizontalStrut(JBUI.scale(4)))
			add(branchCombo)
		}
		add(selectorPanel, BorderLayout.CENTER)

		// Right: icon buttons (tightly grouped, BoxLayout for vertical alignment with combos)
		val buttonsPanel = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.X_AXIS)
		}

		val btnSize = Dimension(JBUI.scale(22), JBUI.scale(22))

		memoryBankBtn = JButton(JolliMemoryIcons.Book).apply {
			toolTipText = "Memory Bank"
			isBorderPainted = false
			isFocusPainted = false
			isContentAreaFilled = false
			isOpaque = true
			margin = JBUI.emptyInsets()
			preferredSize = btnSize
			maximumSize = btnSize
			minimumSize = btnSize
			background = parent?.background ?: UIManager.getColor("Panel.background")
			addActionListener { toggleKB() }
		}
		val settingsBtn = JButton(AllIcons.General.GearPlain).apply {
			toolTipText = "Settings"
			isBorderPainted = false
			isFocusPainted = false
			isContentAreaFilled = false
			isOpaque = true
			margin = JBUI.emptyInsets()
			background = parent?.background ?: UIManager.getColor("Panel.background")
			preferredSize = btnSize
			maximumSize = btnSize
			minimumSize = btnSize
			addActionListener { onSettingsClicked() }
		}
		statusBtn = JButton(JolliMemoryIcons.CircleGreen).apply {
			toolTipText = "Toggle Status"
			isBorderPainted = false
			isFocusPainted = false
			isContentAreaFilled = false
			isOpaque = true
			margin = JBUI.emptyInsets()
			preferredSize = btnSize
			maximumSize = btnSize
			minimumSize = btnSize
			background = parent?.background ?: UIManager.getColor("Panel.background")
			addActionListener { toggleStatus() }
		}
		buttonsPanel.add(memoryBankBtn)
		buttonsPanel.add(settingsBtn)
		buttonsPanel.add(statusBtn)
		add(buttonsPanel, BorderLayout.EAST)

		// Hover highlights for icon buttons
		installHover(memoryBankBtn) { kbActive }
		installHover(settingsBtn) { false }
		installHover(statusBtn) { statusActive }

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

	private fun toggleKB() {
		if (kbActive) {
			// KB is showing → switch back to accordion
			kbActive = false
			onShowAccordion()
		} else {
			// Show KB; deactivate status so the views stay mutually exclusive
			kbActive = true
			statusActive = false
			onShowKB()
		}
		updateButtonHighlights()
	}

	private fun toggleStatus() {
		if (statusActive) {
			// Status card is showing → switch back to accordion
			statusActive = false
			onShowAccordion()
		} else {
			// Show status full-card; deactivate KB to stay mutually exclusive
			statusActive = true
			kbActive = false
			onShowStatus()
		}
		updateButtonHighlights()
	}

	/**
	 * External control — used by the factory to force the status card on/off in
	 * response to service state (e.g., auto-show when Jolli Memory is disabled,
	 * auto-hide when the user enables it from the status panel itself).
	 */
	fun setStatusActive(active: Boolean) {
		if (statusActive == active) return
		statusActive = active
		if (active) {
			kbActive = false
			onShowStatus()
		} else {
			onShowAccordion()
		}
		updateButtonHighlights()
	}

	private fun updateButtonHighlights() {
		val defaultBg = UIManager.getColor("Panel.background") ?: background
		memoryBankBtn.isContentAreaFilled = kbActive
		memoryBankBtn.background = if (kbActive) toggleBg else defaultBg

		statusBtn.isContentAreaFilled = statusActive
		statusBtn.background = if (statusActive) toggleBg else defaultBg
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

		// Changing repo/branch always returns to accordion view
		if (kbActive || statusActive) {
			kbActive = false
			statusActive = false
			onShowAccordion()
			updateButtonHighlights()
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

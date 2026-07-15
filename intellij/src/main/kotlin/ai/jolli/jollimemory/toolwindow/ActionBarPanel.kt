package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.Toolkit
import java.awt.datatransfer.StringSelection
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.SwingUtilities

/**
 * Fixed bottom action bar for the redesigned "Current Branch" view, mirroring the
 * mockup's bottom command group: **Commit · Create PR · ⋯ More**.
 *
 * Recall layout **V1**: only Commit is a primary button; Create PR is a secondary
 * button; Recall (and Sync / Refresh) live in the `⋯` overflow menu.
 *
 * Existing logic is reused rather than duplicated:
 * - Commit fires the registered `JolliMemory.CommitAI` action.
 * - Create PR uses [PrService] (gh availability/auth check → push → `gh pr create`).
 * - Recall reuses the "Invoke the jolli-recall skill" clipboard prompt.
 * - Sync calls [JolliMemoryService.requestManualSync].
 *
 * On a foreign (read-only) repo/branch selection, Commit and Create PR are hidden
 * (mirrors the mockup's `hide-foreign`); only Refresh stays useful.
 */
class ActionBarPanel(
	private val project: Project,
	private val service: JolliMemoryService,
) : JPanel(BorderLayout(JBUI.scale(4), 0)) {

	private val prBtn: JButton
	private val shareBtn: JButton
	private val moreBtn: JButton

	private var foreign = false

	init {
		border = JBUI.Borders.empty(4, 6)

		// Bottom bar, single row: "Create pull request (PR)" fills the width, with
		// "Share" and the "..." overflow button beside it on the right.
		prBtn = JolliButtons.secondary("Create pull request (PR)", JolliMemoryIcons.PullRequest).apply {
			toolTipText = "Create a pull request for this branch (drafted from its memories)."
			addActionListener { handleCreatePr() }
		}
		shareBtn = JolliButtons.secondary("Share", JolliMemoryIcons.Share).apply {
			toolTipText = "Share this branch's memories."
			addActionListener { handleShare() }
		}
		moreBtn = JolliButtons.secondary("...").apply {
			toolTipText = "More actions"
			addActionListener { showMoreMenu() }
		}

		add(prBtn, BorderLayout.CENTER)
		val east = JPanel(java.awt.FlowLayout(java.awt.FlowLayout.RIGHT, JBUI.scale(4), 0)).apply {
			isOpaque = false
			// "Share" creates a read-only share link for this branch's memories (see handleShare).
			add(shareBtn)
			add(moreBtn)
		}
		add(east, BorderLayout.EAST)
	}

	/** Hide Create PR + Share when viewing a foreign (read-only) repo/branch. */
	fun setForeign(isForeign: Boolean) {
		foreign = isForeign
		prBtn.isVisible = !isForeign
		shareBtn.isVisible = !isForeign
		revalidate()
		repaint()
	}

	// ── Recall ──────────────────────────────────────────────────────────────

	private fun copyRecallPrompt() {
		val branch = service.getGitOps()?.getCurrentBranch()
		if (branch.isNullOrBlank()) {
			Messages.showWarningDialog(project, "Could not determine the current branch.", "Recall")
			return
		}
		val prompt = "Invoke the \"jolli-recall\" skill with args \"$branch\"."
		Toolkit.getDefaultToolkit().systemClipboard.setContents(StringSelection(prompt), null)
		ai.jolli.jollimemory.core.telemetry.Telemetry.track("recall_prompt_copied")
		Messages.showInfoMessage(
			project,
			"Recall prompt copied — paste it into your AI coding tool.",
			"Recall",
		)
	}

	// ── Sync / Refresh ──────────────────────────────────────────────────────

	private fun syncToMemoryBank() {
		ApplicationManager.getApplication().executeOnPooledThread {
			try {
				service.requestManualSync()
				SwingUtilities.invokeLater {
					Messages.showInfoMessage(project, "Sync to Memory Bank requested.", "Jolli Memory")
				}
			} catch (ex: Exception) {
				SwingUtilities.invokeLater {
					Messages.showErrorDialog(project, "Sync failed: ${ex.message}", "Jolli Memory")
				}
			}
		}
	}

	private fun refreshAll() {
		val registry = service.panelRegistry ?: return
		registry.changesPanel?.refresh()
		registry.commitsPanel?.refresh()
		registry.plansPanel?.refresh()
		registry.activeConversationsPanel?.refresh()
		service.refreshStatus()
	}

	// ── ⋯ More menu ─────────────────────────────────────────────────────────

	private fun showMoreMenu() {
		val menu = javax.swing.JPopupMenu()
		if (!foreign) {
			menu.add(javax.swing.JMenuItem("Recall in Claude Code").apply {
				addActionListener { copyRecallPrompt() }
			})
			menu.add(javax.swing.JMenuItem("Copy recall prompt for other tools").apply {
				addActionListener { copyRecallPrompt() }
			})
			// "Sync to Memory Bank" silently no-ops unless the sync orchestrator is built
			// (sign-in + binding); hide it until that lazy-build path is wired here.
			if (FeatureFlags.SHOW_UNFINISHED) {
				menu.addSeparator()
				menu.add(javax.swing.JMenuItem("Sync to Memory Bank", JolliMemoryIcons.CloudUpload).apply {
					addActionListener { syncToMemoryBank() }
				})
			}
		}
		menu.add(javax.swing.JMenuItem("Refresh", JolliMemoryIcons.Refresh).apply {
			addActionListener { refreshAll() }
		})
		menu.show(moreBtn, 0, -menu.preferredSize.height)
	}

	// ── Create PR ─────────────────────────────────────────────────────────────

	/**
	 * Opens the dedicated branch-level Create PR webview (the mockup design). It
	 * aggregates the branch's committed memories and, when signed in, also shares
	 * them to Jolli on submit. Shows the "commit first" hint when there are none.
	 */
	private fun handleCreatePr() {
		val panel = service.panelRegistry?.commitsPanel
		if (panel == null) {
			Messages.showInfoMessage(
				project,
				"Create PR is unavailable right now — open the Jolli Memory tool window and try again.",
				"Create PR",
			)
			return
		}
		panel.openCreatePrView()
	}

	/**
	 * Shares the whole branch. Mirrors VS Code: open (or focus) the newest memory's detail webview
	 * and reveal its inline share overlay in branch mode — no separate window. When the branch has
	 * no committed memories there is nothing to open, so we say so.
	 */
	private fun handleShare() {
		ApplicationManager.getApplication().executeOnPooledThread {
			val newest = service.getBranchCommits()
				.firstOrNull { it.hasSummary }
				?.let { service.getSummary(it.hash) }
			SwingUtilities.invokeLater {
				if (newest == null) {
					Messages.showInfoMessage(
						project,
						"No committed memories on this branch to share yet.",
						"Share",
					)
					return@invokeLater
				}
				ai.jolli.jollimemory.core.telemetry.Telemetry.track("memory_shared")
				val vFile = SummaryVirtualFile(newest)
				val editors = com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project)
					.openFile(vFile, true)
				editors.filterIsInstance<SummaryFileEditor>().firstOrNull()?.requestOpenShare(branchShare = true)
			}
		}
	}

	override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)
}

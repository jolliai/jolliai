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
			menu.addSeparator()
			menu.add(javax.swing.JMenuItem("Sync to Memory Bank", JolliMemoryIcons.CloudUpload).apply {
				addActionListener { syncToMemoryBank() }
			})
		}
		menu.add(javax.swing.JMenuItem("Refresh", JolliMemoryIcons.Refresh).apply {
			addActionListener { refreshAll() }
		})
		menu.show(moreBtn, 0, -menu.preferredSize.height)
	}

	// ── Create PR ─────────────────────────────────────────────────────────────

	/**
	 * Opens the branch's most recent committed memory in its detail webview, where
	 * the Create PR flow lives — identical to the memory row's "⋯ → Create PR".
	 */
	private fun handleCreatePr() {
		val opened = service.panelRegistry?.commitsPanel?.openMostRecentMemory() ?: false
		if (!opened) {
			Messages.showInfoMessage(
				project,
				"No committed memory on this branch yet. Commit first, then create a PR from the memory view.",
				"Create PR",
			)
		}
	}

	private fun handleShare() {
		Messages.showInfoMessage(
			project,
			"Share — share this branch's memories to your Jolli Space (action to be wired).",
			"Share",
		)
	}

	override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)
}

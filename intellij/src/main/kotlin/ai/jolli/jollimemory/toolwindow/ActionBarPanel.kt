package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.services.PrService
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.util.ui.JBUI
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Toolkit
import java.awt.datatransfer.StringSelection
import java.awt.event.ComponentAdapter
import java.awt.event.ComponentEvent
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
) : JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(6), JBUI.scale(4))) {

	private val commitBtn: JButton
	private val prBtn: JButton
	private val moreBtn: JButton

	private var foreign = false
	private var compact = false

	init {
		border = JBUI.Borders.empty(2, 6)

		commitBtn = JButton("Commit", JolliMemoryIcons.Sparkle).apply {
			toolTipText = "Commit the checked files with an AI-written message and save a memory."
			addActionListener { invokeRegisteredAction("JolliMemory.CommitAI") }
		}
		prBtn = JButton("Create PR", AllIcons.Vcs.Vendors.Github).apply {
			toolTipText = "Create a pull request for this branch (drafted from its memories)."
			addActionListener { handleCreatePr() }
		}
		moreBtn = JButton(AllIcons.Actions.More).apply {
			toolTipText = "More actions"
			addActionListener { showMoreMenu() }
		}

		add(commitBtn)
		add(prBtn)
		add(moreBtn)

		// Collapse button labels to icon-only when the tool window is narrow (~240px),
		// matching the mockup's responsive action strip.
		addComponentListener(object : ComponentAdapter() {
			override fun componentResized(e: ComponentEvent) {
				val shouldCompact = width in 1 until JBUI.scale(240)
				if (shouldCompact != compact) {
					compact = shouldCompact
					applyCompact()
				}
			}
		})
	}

	/** Hide Commit / Create PR when viewing a foreign (read-only) repo/branch. */
	fun setForeign(isForeign: Boolean) {
		foreign = isForeign
		commitBtn.isVisible = !isForeign
		prBtn.isVisible = !isForeign
		revalidate()
		repaint()
	}

	private fun applyCompact() {
		commitBtn.text = if (compact) "" else "Commit"
		prBtn.text = if (compact) "" else "Create PR"
		revalidate()
		repaint()
	}

	// ── Commit ────────────────────────────────────────────────────────────────

	private fun invokeRegisteredAction(actionId: String) {
		val action = ActionManager.getInstance().getAction(actionId) ?: return
		val ctx = SimpleDataContext.getProjectContext(project)
		val event = AnActionEvent.createFromAnAction(action, null, "JolliMemoryActionBar", ctx)
		action.actionPerformed(event)
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

	private fun handleCreatePr() {
		val cwd = service.mainRepoRoot ?: project.basePath ?: return
		ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Jolli Memory: Preparing PR…", true) {
			override fun run(indicator: ProgressIndicator) {
				if (!PrService.isGhAvailable(cwd)) {
					ApplicationManager.getApplication().invokeLater {
						Messages.showErrorDialog(
							project,
							"GitHub CLI (gh) is not installed or not on PATH. Install it from https://cli.github.com to create PRs.",
							"Create PR",
						)
					}
					return
				}
				if (!PrService.isGhAuthenticated(cwd)) {
					ApplicationManager.getApplication().invokeLater {
						Messages.showErrorDialog(
							project,
							"GitHub CLI is not authenticated. Run `gh auth login` first.",
							"Create PR",
						)
					}
					return
				}

				val branch = PrService.getCurrentBranch(cwd) ?: "this branch"
				val defaultTitle = branch.substringAfterLast('/').replace('-', ' ').replace('_', ' ')
				val defaultBody = "Drafted from this branch's Jolli memories.\n\n_Review and edit before creating._"

				ApplicationManager.getApplication().invokeLater {
					val title = Messages.showInputDialog(
						project, "PR title:", "Create PR", null, defaultTitle, null,
					) ?: return@invokeLater

					ApplicationManager.getApplication().executeOnPooledThread {
						try {
							PrService.pushBranch(cwd)
							val url = PrService.createPr(title.ifBlank { defaultTitle }, defaultBody, cwd)
							ApplicationManager.getApplication().invokeLater {
								Messages.showInfoMessage(project, "Pull request created:\n$url", "Create PR")
							}
						} catch (ex: Exception) {
							ApplicationManager.getApplication().invokeLater {
								Messages.showErrorDialog(project, "Create PR failed: ${ex.message}", "Create PR")
							}
						}
					}
				}
			}
		})
	}

	override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)
}

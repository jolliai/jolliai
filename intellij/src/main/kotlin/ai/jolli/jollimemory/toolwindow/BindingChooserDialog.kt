package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.services.JolliApiClient
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Component
import java.awt.Dimension
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultListModel
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.ListSelectionModel

/**
 * A JolliMemory space returned by the list-spaces endpoint.
 */
data class JmSpaceSummary(
	val id: Int,
	val name: String,
	val slug: String,
)

/**
 * Result returned after a successful binding creation or race-winner acceptance.
 */
data class BindingChooserResult(
	val id: Int,
	val jmSpaceId: Int,
	val jmSpaceName: String,
	val repoName: String,
)

/**
 * Discriminated outcome of the binding chooser dialog.
 *
 * The caller (push flow) uses a `when` block on this to decide whether to
 * retry the push ([Selected]), show a cancellation message ([Cancelled]),
 * or inform the user a chooser is already open ([AnotherOpen]).
 */
sealed class BindingChooserOutcome {
	data class Selected(val result: BindingChooserResult) : BindingChooserOutcome()
	object Cancelled : BindingChooserOutcome()
	object AnotherOpen : BindingChooserOutcome()
}

/**
 * Thrown when binding creation fails with 409 because another user
 * already bound the same repo. Carries the winning binding's details.
 */
class BindingAlreadyExistsException(
	val winner: BindingChooserResult,
	message: String = "Another binding already exists for this repo.",
) : RuntimeException(message)

/**
 * Modal dialog that lets the user pick a JolliMemory space to bind a repo to.
 *
 * Shown when the server returns 412 `binding_required` during a push. At most
 * one dialog is open per `repoUrl`; callers should check [isAlreadyOpen] first.
 *
 * When the user clicks "Bind and Push", the dialog calls
 * [JolliApiClient.createBinding] on a background thread and stays open
 * until the call completes. On a 409 race collision it shows a banner; on
 * success it closes and the caller reads the result via [getOutcome].
 *
 * The dialog does NOT create spaces — only lists existing ones. Space
 * management happens on the jolli.ai web frontend.
 */
class BindingChooserDialog private constructor(
	project: Project,
	private val repoUrl: String,
	private val suggestedRepoName: String,
	private val spaces: List<JmSpaceSummary>,
	private val defaultSpaceId: Int?,
	private val baseUrl: String,
	private val apiKey: String,
) : DialogWrapper(project, true) {

	private val listModel = DefaultListModel<JmSpaceSummary>()
	private val spacesList = JBList(listModel)
	private var bannerPanel: JPanel? = null
	private var spacesPanel: JComponent? = null
	private var emptyLabel: JBLabel? = null
	private var errorLabel: JBLabel? = null
	private var outcome: BindingChooserOutcome = BindingChooserOutcome.Cancelled

	init {
		title = "Choose a Memory Space"
		setOKButtonText("Bind and Push")
		setCancelButtonText("Cancel")
		isOKActionEnabled = false
		init()

		for (space in spaces) {
			listModel.addElement(space)
		}
		if (spaces.isEmpty()) {
			emptyLabel?.isVisible = true
			spacesList.isVisible = false
		}

		// Pre-select only the server-designated default space. If the server
		// did not nominate one, leave every row unselected so the user must
		// explicitly pick — auto-selecting the first row would silently bind
		// the repo to whichever space happened to be returned first.
		if (defaultSpaceId != null) {
			for (i in 0 until listModel.size) {
				if (listModel.getElementAt(i).id == defaultSpaceId) {
					spacesList.selectedIndex = i
					isOKActionEnabled = true
					break
				}
			}
		}
	}

	override fun createCenterPanel(): JComponent {
		val root = JPanel(BorderLayout())
		root.preferredSize = Dimension(480, 400)

		// ── Header ──
		val header = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.Y_AXIS)
			border = JBUI.Borders.emptyBottom(12)
			add(JBLabel("Choose a Memory space").apply {
				font = JBUI.Fonts.label(14f).asBold()
				alignmentX = Component.LEFT_ALIGNMENT
			})
			add(Box.createVerticalStrut(4))
			add(JBLabel("<html><span style='color:gray'>Bind this repo to an existing space. Create or manage spaces on jolli.ai.</span></html>").apply {
				alignmentX = Component.LEFT_ALIGNMENT
			})
			add(Box.createVerticalStrut(8))
			add(JBLabel("<html><b>Repo:</b> ${escHtml(repoUrl)}</html>").apply {
				alignmentX = Component.LEFT_ALIGNMENT
			})
		}
		root.add(header, BorderLayout.NORTH)

		// ── Race-winner banner (initially hidden) ──
		bannerPanel = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.Y_AXIS)
			border = BorderFactory.createCompoundBorder(
				BorderFactory.createLineBorder(java.awt.Color(0xE0, 0xA0, 0x20), 1, true),
				JBUI.Borders.empty(10),
			)
			isVisible = false
		}

		// ── Spaces list ──
		spacesList.selectionMode = ListSelectionModel.SINGLE_SELECTION
		spacesList.cellRenderer = SpaceCellRenderer()
		spacesList.addListSelectionListener {
			if (!it.valueIsAdjusting) {
				isOKActionEnabled = spacesList.selectedValue != null
			}
		}

		val emptyLbl = JBLabel("<html><span style='color:gray'>No Memory spaces available. Create one on jolli.ai, then try Push again.</span></html>").apply {
			border = JBUI.Borders.empty(20)
			isVisible = false
			alignmentX = Component.LEFT_ALIGNMENT
		}
		emptyLabel = emptyLbl

		val errLbl = JBLabel().apply {
			border = JBUI.Borders.emptyTop(8)
			isVisible = false
			alignmentX = Component.LEFT_ALIGNMENT
		}
		errorLabel = errLbl

		val listPanel = JPanel(BorderLayout()).apply {
			add(JBScrollPane(spacesList), BorderLayout.CENTER)
			add(emptyLbl, BorderLayout.SOUTH)
		}
		spacesPanel = listPanel

		val center = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.Y_AXIS)
			add(bannerPanel!!)
			add(listPanel)
			add(errLbl)
		}
		root.add(center, BorderLayout.CENTER)

		return root
	}

	/**
	 * Intercepts the OK action so the dialog stays open while the binding
	 * API call runs on a background thread. Closes only on success or
	 * after the user accepts a race-winner via the banner.
	 */
	override fun doOKAction() {
		LOG.info("doOKAction entered (repoUrl=$repoUrl, outcome=$outcome, isOKActionEnabled=$isOKActionEnabled)")
		// Race-winner path: user clicked "OK, Push Now" after banner was shown.
		// outcome is already set by showRaceWinner(), just close.
		if (outcome is BindingChooserOutcome.Selected) {
			LOG.info("doOKAction: race-winner path, delegating to super.doOKAction()")
			super.doOKAction()
			return
		}

		val selected = spacesList.selectedValue
		if (selected == null) {
			LOG.info("doOKAction: no selection, returning without action")
			return
		}
		LOG.info("doOKAction: selected space id=${selected.id} name=${selected.name}; calling setBusy(true)")
		setBusy(true)
		errorLabel?.isVisible = false

		ApplicationManager.getApplication().executeOnPooledThread {
			LOG.info("createBinding: pooled-thread start (jmSpaceId=${selected.id})")
			try {
				val result = JolliApiClient.createBinding(baseUrl, apiKey, repoUrl, suggestedRepoName, selected.id)
				LOG.info("createBinding: returned id=${result.id} jmSpaceId=${result.jmSpaceId} name=${result.jmSpaceName}; scheduling invokeLater to close dialog")
				ApplicationManager.getApplication().invokeLater(
					{
						LOG.info("createBinding-invokeLater: setting outcome and calling close(OK_EXIT_CODE) (isOKActionEnabled=$isOKActionEnabled)")
						outcome = BindingChooserOutcome.Selected(result)
						close(OK_EXIT_CODE)
						LOG.info("createBinding-invokeLater: close(OK_EXIT_CODE) returned (isShowing=$isShowing)")
					},
					ModalityState.any(),
				)
			} catch (e: BindingAlreadyExistsException) {
				LOG.info("createBinding: 409 race-winner — winner=${e.winner.jmSpaceName}")
				ApplicationManager.getApplication().invokeLater(
					{
						showRaceWinner(e.winner)
						setBusy(false)
					},
					ModalityState.any(),
				)
			} catch (e: Exception) {
				LOG.warn("createBinding failed: ${e.message}", e)
				ApplicationManager.getApplication().invokeLater(
					{
						showError(e.message ?: "Failed to register binding.")
						setBusy(false)
					},
					ModalityState.any(),
				)
			}
		}
	}

	override fun doCancelAction() {
		LOG.info("doCancelAction entered (repoUrl=$repoUrl)")
		outcome = BindingChooserOutcome.Cancelled
		super.doCancelAction()
	}

	/** Returns the outcome after the dialog has been closed. */
	fun getOutcome(): BindingChooserOutcome = outcome

	override fun dispose() {
		LOG.info("dispose called (repoUrl=$repoUrl, outcome=$outcome)")
		openInstances.remove(repoUrl)
		super.dispose()
	}

	// ── Internal helpers ────────────────────────────────────────────────

	/**
	 * Shows the race-winner banner when a 409 collision is detected.
	 * Hides the spaces list and changes the OK button to "OK, Push Now".
	 */
	private fun showRaceWinner(winner: BindingChooserResult) {
		outcome = BindingChooserOutcome.Selected(winner)
		spacesPanel?.isVisible = false
		errorLabel?.isVisible = false
		bannerPanel?.apply {
			removeAll()
			add(JBLabel("<html>Another teammate just bound this repo to <b>${escHtml(winner.jmSpaceName)}</b>. Using that one.</html>").apply {
				alignmentX = Component.LEFT_ALIGNMENT
			})
			isVisible = true
			revalidate()
			repaint()
		}
		setOKButtonText("OK, Push Now")
		isOKActionEnabled = true
	}

	private fun setBusy(busy: Boolean) {
		isOKActionEnabled = !busy
		spacesList.isEnabled = !busy
		setOKButtonText(if (busy) "Binding\u2026" else "Bind and Push")
	}

	private fun showError(message: String) {
		errorLabel?.apply {
			text = "<html><span style='color:#c0392b'>${escHtml(message)}</span></html>"
			isVisible = true
		}
	}

	private fun escHtml(s: String): String =
		s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

	companion object {
		private val LOG = Logger.getInstance(BindingChooserDialog::class.java)
		private val openInstances = mutableMapOf<String, BindingChooserDialog>()

		/**
		 * Opens the chooser dialog for the given repo.
		 *
		 * Call [isAlreadyOpen] first to distinguish the "another chooser is
		 * already showing" case from a fresh open.
		 */
		fun open(
			project: Project,
			repoUrl: String,
			suggestedRepoName: String,
			spaces: List<JmSpaceSummary>,
			defaultSpaceId: Int?,
			baseUrl: String,
			apiKey: String,
		): BindingChooserDialog {
			val dialog = BindingChooserDialog(project, repoUrl, suggestedRepoName, spaces, defaultSpaceId, baseUrl, apiKey)
			openInstances[repoUrl] = dialog
			return dialog
		}

		/** Returns true if a chooser is already open for the given repo URL. */
		fun isAlreadyOpen(repoUrl: String): Boolean {
			val existing = openInstances[repoUrl]
			return existing != null && existing.isShowing
		}
	}

	/**
	 * Cell renderer for the spaces list — shows space name in bold with
	 * the slug in gray, adapting to the current selection colors.
	 */
	private class SpaceCellRenderer : javax.swing.ListCellRenderer<JmSpaceSummary> {
		private val label = JBLabel()

		override fun getListCellRendererComponent(
			list: javax.swing.JList<out JmSpaceSummary>,
			value: JmSpaceSummary?,
			index: Int,
			isSelected: Boolean,
			cellHasFocus: Boolean,
		): Component {
			if (value == null) return label
			label.text = "<html><b>${value.name}</b> <span style='color:gray'>/${value.slug}</span></html>"
			label.border = JBUI.Borders.empty(6, 8)
			if (isSelected) {
				label.background = list.selectionBackground
				label.foreground = list.selectionForeground
				label.isOpaque = true
			} else {
				label.background = list.background
				label.foreground = list.foreground
				label.isOpaque = false
			}
			return label
		}
	}
}

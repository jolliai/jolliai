package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.icons.AllIcons
import com.intellij.openapi.Disposable
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Component
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JPanel
import javax.swing.SwingUtilities

/**
 * "Current Memory" card — the draft the next commit will save (the mockup's
 * `sec-ship` / `.ship-panel`, internally "ship").
 *
 * Content (top → bottom):
 * - **Consequence line** — "Commit Memory will commit N changed file(s)…".
 * - **AI-summary status row** — busy ("Summarizing…") or failed (warning + hint),
 *   sourced from [JolliMemoryService] status / `lastError` and the worker lock.
 * - The three input sub-sections in order: **Conversations → Context → Files**
 *   (passed in as [CollapsiblePanel]s so their toolbars and row logic are reused
 *   verbatim). The Commit action itself lives in the bottom [ActionBarPanel].
 */
class CurrentMemoryPanel(
	private val service: JolliMemoryService,
	private val conversationsSection: CollapsiblePanel,
	private val contextSection: CollapsiblePanel,
	private val filesSection: CollapsiblePanel,
) : JPanel(BorderLayout()), Disposable {

	private val consequenceLabel = JBLabel().apply {
		border = JBUI.Borders.empty(2, 6)
	}
	private val statusLabel = JBLabel().apply {
		border = JBUI.Borders.empty(2, 6)
	}
	private val sectionsContainer = JPanel().apply {
		layout = BoxLayout(this, BoxLayout.Y_AXIS)
		isOpaque = false
	}

	private val statusListener: () -> Unit = {
		SwingUtilities.invokeLater { updateHeader() }
	}

	init {
		val header = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.Y_AXIS)
			isOpaque = false
			border = JBUI.Borders.empty(2, 0)
			consequenceLabel.alignmentX = Component.LEFT_ALIGNMENT
			statusLabel.alignmentX = Component.LEFT_ALIGNMENT
			add(consequenceLabel)
			add(statusLabel)
		}
		add(header, BorderLayout.NORTH)

		// Conversations → Context → Files (the inputs that will be saved).
		sectionsContainer.add(conversationsSection)
		sectionsContainer.add(Box.createVerticalStrut(JBUI.scale(2)))
		sectionsContainer.add(contextSection)
		sectionsContainer.add(Box.createVerticalStrut(JBUI.scale(2)))
		sectionsContainer.add(filesSection)
		add(sectionsContainer, BorderLayout.CENTER)

		updateHeader()
		service.addStatusListener(statusListener)
	}

	/** Refreshes the consequence + status lines from the current service state. */
	fun updateHeader() {
		val files = service.panelRegistry?.changesPanel?.getFiles()?.size
			?: service.getChangedFiles().size
		consequenceLabel.text = if (files > 0) {
			"Commit Memory will commit $files changed file(s) with an AI-written message."
		} else {
			"No changes staged — nothing will be committed yet."
		}

		val cwd = service.mainRepoRoot
		val busy = cwd != null && SessionTracker.isWorkerBusy(cwd)
		val error = service.lastError
		when {
			busy -> {
				statusLabel.icon = AllIcons.Process.Step_1
				statusLabel.text = "Summarizing the last commit…"
				statusLabel.isVisible = true
			}
			error != null -> {
				statusLabel.icon = JolliMemoryIcons.Warning
				statusLabel.text = "Summary failed — open Status for details."
				statusLabel.isVisible = true
			}
			else -> {
				statusLabel.isVisible = false
			}
		}
	}

	override fun dispose() {
		service.removeStatusListener(statusListener)
	}
}

package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.icons.AllIcons
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionToolbar
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Component
import java.awt.Dimension
import java.awt.Font
import javax.swing.BoxLayout
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.SwingUtilities

/**
 * "Current Memory" card — the draft the next commit will save (the mockup's
 * `sec-ship`). Content (top → bottom):
 * - **Consequence line** + **AI-summary status row** (always visible).
 * - Three input sub-sections — **Conversations → Context → Files** — each with a
 *   title + action toolbar header, separated by a light-blue divider. Each section
 *   shows up to 6 rows then collapses the rest behind "Show N more".
 *
 * This card has no scrollbar of its own — it reports its natural height so the
 * sidebar's single top-level scrollbar covers Pinned → Current Memory →
 * Committed Memories together.
 */
class CurrentMemoryPanel(
	private val project: Project,
	private val service: JolliMemoryService,
	private val conversationsPanel: JComponent,
	private val conversationsActions: String,
	private val contextPanel: JComponent,
	private val contextActions: String,
	private val filesPanel: JComponent,
	private val filesActions: String,
) : JPanel(), Disposable {

	private val consequenceLabel = JBLabel().apply { border = JBUI.Borders.empty(2, 6) }
	private val statusLabel = JBLabel().apply { border = JBUI.Borders.empty(2, 6) }

	private val statusListener: () -> Unit = { SwingUtilities.invokeLater { updateHeader() } }

	/** The three section headers, normalized to a uniform height after construction. */
	private val sectionHeaders = mutableListOf<JComponent>()

	init {
		layout = BoxLayout(this, BoxLayout.Y_AXIS)

		consequenceLabel.alignmentX = Component.LEFT_ALIGNMENT
		statusLabel.alignmentX = Component.LEFT_ALIGNMENT
		add(consequenceLabel)
		add(statusLabel)

		addSection(this, "CONVERSATIONS", conversationsActions, conversationsPanel, separatorAfter = true)
		addSection(this, "CONTEXT", contextActions, contextPanel, separatorAfter = true)
		addSection(this, "FILES", filesActions, filesPanel, separatorAfter = false)
		// Headers with an action toolbar are taller than those without; pin all three to
		// the tallest so the CONVERSATIONS / CONTEXT / FILES titles align consistently.
		normalizeSectionHeaderHeights()
		// Commit lives right after the Files list (the bottom bar keeps Create PR).
		add(commitButtonRow())

		updateHeader()
		service.addStatusListener(statusListener)
	}

	override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)

	private fun addSection(stack: JPanel, title: String, actionGroupId: String, body: JComponent, separatorAfter: Boolean) {
		val header = sectionHeader(title, actionGroupId, body)
		sectionHeaders.add(header)
		stack.add(header)
		body.alignmentX = Component.LEFT_ALIGNMENT
		stack.add(body)
		if (separatorAfter) stack.add(sectionSeparator())
	}

	/** Pins every section header to the tallest header's height so the titles align. */
	private fun normalizeSectionHeaderHeights() {
		val maxH = sectionHeaders.maxOfOrNull { it.preferredSize.height } ?: return
		for (h in sectionHeaders) {
			h.preferredSize = Dimension(h.preferredSize.width, maxH)
			h.minimumSize = Dimension(h.minimumSize.width, maxH)
			h.maximumSize = Dimension(Int.MAX_VALUE, maxH)
		}
	}

	private fun sectionHeader(title: String, actionGroupId: String, target: JComponent): JComponent {
		// Match the top-level section headers (mockup: 11px / base − 2) so the folded
		// sub-section titles don't tower over the rows beneath them.
		val titleLabel = JBLabel(title).apply { font = font.deriveFont(Font.BOLD, font.size2D - 2f) }

		// Live row count in the header, e.g. "CONTEXT (4)".
		(target as? RowCountSource)?.let { src ->
			val apply = { n: Int -> titleLabel.text = "$title ($n)" }
			apply(src.currentRowCount())
			src.onRowCountChanged = { n -> SwingUtilities.invokeLater { apply(n) } }
		}
		val header = JPanel(BorderLayout()).apply {
			isOpaque = false
			// Tight header insets: bottom 0 so the title sits right above its first row
			// (the body keeps its 4px PINNED-aligned top), top 2 to pull consecutive
			// sections closer together.
			border = JBUI.Borders.empty(2, 6, 0, 2)
			alignmentX = Component.LEFT_ALIGNMENT
			add(titleLabel, BorderLayout.WEST)
		}
		val group = ActionManager.getInstance().getAction(actionGroupId)
		if (group is DefaultActionGroup) {
			val toolbar: ActionToolbar = ActionManager.getInstance()
				.createActionToolbar("JolliMemory.CurrentMemory.$title", group, true)
			toolbar.targetComponent = target
			toolbar.setReservePlaceAutoPopupIcon(false)
			// Compact buttons so the header (whose height is driven by the toolbar) stays
			// short and consistent with toolbar-less sections.
			toolbar.minimumButtonSize = Dimension(JBUI.scale(18), JBUI.scale(18))
			toolbar.component.isOpaque = false
			header.add(toolbar.component, BorderLayout.EAST)
		}
		// Recompute max height now that children are added.
		header.maximumSize = Dimension(Int.MAX_VALUE, header.preferredSize.height)
		return header
	}

	/** "Commit" (fills the row) + a "Review" button (eye icon) on the right. */
	private fun commitButtonRow(): JComponent {
		val commit = JolliButtons.primary("Commit", JolliMemoryIcons.Sparkle).apply {
			toolTipText = "Commit the checked files with an AI-written message and save a memory."
			addActionListener {
				val reg = service.panelRegistry
				ai.jolli.jollimemory.core.telemetry.Telemetry.track(
					"memory_committed",
					mapOf(
						"files_bucket" to ai.jolli.jollimemory.core.telemetry.Telemetry.bucket(reg?.changesPanel?.currentRowCount() ?: 0),
						"has_conversations" to ((reg?.activeConversationsPanel?.currentRowCount() ?: 0) > 0),
						"context_bucket" to ai.jolli.jollimemory.core.telemetry.Telemetry.bucket(reg?.plansPanel?.currentRowCount() ?: 0),
					),
				)
				val action = ActionManager.getInstance().getAction("JolliMemory.CommitAI") ?: return@addActionListener
				ActionManager.getInstance().tryToExecute(action, null, this, "JolliMemoryCurrentMemory", true)
			}
		}
		val review = JolliButtons.secondary("Review", JolliMemoryIcons.Eye).apply {
			toolTipText = "Review the current memory's included items before committing."
			addActionListener { onReview() }
		}
		// Commit fills the width (text centered); Review sits to its right.
		return JPanel(BorderLayout(JBUI.scale(4), 0)).apply {
			isOpaque = false
			alignmentX = Component.LEFT_ALIGNMENT
			border = JBUI.Borders.empty(6, 6, 4, 6)
			add(commit, BorderLayout.CENTER)
			add(review, BorderLayout.EAST)
			maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
		}
	}

	/** Opens the Working Memory web view — the full memory the next commit will save. */
	private fun onReview() {
		com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project)
			.openFile(WorkingMemoryVirtualFile(), true)
	}

	/** A grey divider between sections (mockup parity) — a stronger, 2px line. */
	private fun sectionSeparator(): JComponent = JPanel().apply {
		isOpaque = true
		val base = javax.swing.UIManager.getColor("Separator.separatorColor")
			?: javax.swing.UIManager.getColor("Component.borderColor")
			?: JBColor.border()
		// More prominent than the faint theme separator: darker in light themes,
		// brighter (so it reads on dark backgrounds) in dark themes.
		background = if (com.intellij.ui.ColorUtil.isDark(base)) {
			com.intellij.ui.ColorUtil.brighter(base, 3)
		} else {
			com.intellij.ui.ColorUtil.darker(base, 3)
		}
		alignmentX = Component.LEFT_ALIGNMENT
		preferredSize = Dimension(0, JBUI.scale(2))
		maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(2))
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
			else -> statusLabel.isVisible = false
		}
	}

	override fun dispose() {
		service.removeStatusListener(statusListener)
	}
}

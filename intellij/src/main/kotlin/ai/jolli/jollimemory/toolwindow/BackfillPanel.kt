package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.backfill.BackfillCli
import ai.jolli.jollimemory.backfill.BackfillRunner
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.CardLayout
import java.awt.Component
import java.awt.Dimension
import java.awt.FlowLayout
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JProgressBar
import javax.swing.SwingConstants

/**
 * BackfillPanel — the tool-window "build memory from your history" card. Native-Swing
 * port of the VS Code sidebar cold-start card (vscode/src/views/SidebarScriptBuilder.ts),
 * with the same four states driven by a [CardLayout]:
 *
 *   OFFER    → note ("N recent commits without a memory yet") + [Build now] / [Dismiss]
 *   LIST     → selectable commits ("subject · N sessions · M turns") + [Generate selected]
 *   PROGRESS → determinate bar with the current commit
 *   DONE     → tally + acted-on rows + [Close]
 *
 * Owns its own visibility lifecycle via [shouldBeVisible]: while the user is engaged
 * (LIST / PROGRESS / DONE) the card stays visible even after cold-start state changes
 * (e.g. a generation clears `coldStartVariant`); it defers to the service only in the
 * OFFER state. [onVisibilityRefresh] asks the host (the collapsible wrapper) to re-read
 * [shouldBeVisible]. Wording is kept in lockstep with vscode BackfillListRenderer.ts.
 */
class BackfillPanel(
	private val project: Project,
	private val service: JolliMemoryService,
	private val onVisibilityRefresh: () -> Unit = {},
) : JPanel(BorderLayout()) {

	private val log = JmLogger.create("BackfillPanel")
	private val cards = CardLayout()
	private val deck = JPanel(cards)
	private var currentCard = OFFER

	private val offerNote = htmlLabel("")
	private val listContainer = JPanel().apply {
		layout = BoxLayout(this, BoxLayout.Y_AXIS)
		isOpaque = false
	}
	private val checkboxes = mutableListOf<Pair<JBCheckBox, BackfillCli.Candidate>>()
	private val generateButton = JButton("Generate selected")
	private val progressBar = JProgressBar(0, 100)
	private val progressLabel = htmlLabel("")
	private val doneSummary = htmlLabel("")
	private val doneRows = JPanel().apply {
		layout = BoxLayout(this, BoxLayout.Y_AXIS)
		isOpaque = false
	}

	init {
		isOpaque = false
		border = JBUI.Borders.empty(8, 10, 10, 10)
		deck.isOpaque = false
		deck.add(offerCard(), OFFER)
		deck.add(listCard(), LIST)
		deck.add(progressCard(), PROGRESS)
		deck.add(doneCard(), DONE)
		add(deck, BorderLayout.CENTER)
		showOffer()
	}

	/**
	 * Whether the host collapsible should be visible. Mid-flow (LIST / PROGRESS / DONE)
	 * always stays visible until the user closes it; in OFFER we defer to the service's
	 * cold-start decision.
	 */
	fun shouldBeVisible(): Boolean = currentCard != OFFER || service.shouldShowBackfillCard()

	/** Refreshes the offer copy from current signals without disturbing a mid-flow view. */
	fun syncOffer() {
		offerNote.text = html(coldStartNote(service.coldStartVariant, service.recentMissingCount, COLD_START_CAP))
	}

	// ── OFFER ────────────────────────────────────────────────────────────
	private fun offerCard(): JPanel {
		val buttons = row(
			JButton("Build now").apply { addActionListener { onBuildNow() } },
			JButton("Dismiss").apply { addActionListener { service.dismissBackfillCard() } },
		)
		return column(offerNote, buttons)
	}

	private fun showOffer() {
		syncOffer()
		currentCard = OFFER
		cards.show(deck, OFFER)
	}

	private fun onBuildNow() {
		val cwd = service.mainRepoRoot ?: project.basePath ?: return
		offerNote.text = html("Scanning your recent commits…")
		ApplicationManager.getApplication().executeOnPooledThread {
			val listed = BackfillCli.listCandidates(cwd, sinceDays = 30, limit = COLD_START_CAP)
			val enriched = if (listed is BackfillCli.Outcome.Ok) {
				when (val p = BackfillCli.preview(cwd, listed.value.candidates)) {
					is BackfillCli.Outcome.Ok -> p.value
					else -> listed.value.candidates
				}
			} else {
				log.info("Build-now candidate scan unavailable")
				emptyList()
			}
			ApplicationManager.getApplication().invokeLater {
				if (enriched.isEmpty()) showOffer() else showList(enriched)
			}
		}
	}

	// ── LIST ─────────────────────────────────────────────────────────────
	private fun listCard(): JPanel {
		generateButton.addActionListener { onGenerate() }
		val scroll = JBScrollPane(listContainer).apply {
			border = JBUI.Borders.empty()
			preferredSize = Dimension(0, JBUI.scale(160))
			isOpaque = false
			viewport.isOpaque = false
		}
		val buttons = row(
			generateButton,
			JButton("Cancel").apply { addActionListener { showOffer() } },
		)
		return column(htmlLabel(html("Select the commits to build memory for:")), scroll, buttons)
	}

	private fun showList(candidates: List<BackfillCli.Candidate>) {
		listContainer.removeAll()
		checkboxes.clear()
		for (c in candidates) {
			val cb = JBCheckBox("${trim(c.subject)}  —  ${backfillMeta(c.sessions, c.conversationTurns)}", true)
			cb.isOpaque = false
			cb.alignmentX = Component.LEFT_ALIGNMENT
			cb.addActionListener { updateGenerateEnabled() }
			checkboxes.add(cb to c)
			listContainer.add(cb)
		}
		listContainer.revalidate()
		listContainer.repaint()
		updateGenerateEnabled()
		currentCard = LIST
		cards.show(deck, LIST)
	}

	private fun updateGenerateEnabled() {
		generateButton.isEnabled = checkboxes.any { it.first.isSelected }
	}

	private fun onGenerate() {
		val selected = checkboxes.filter { it.first.isSelected }.map { it.second.commitHash }
		if (selected.isEmpty()) return
		progressBar.value = 0
		progressLabel.text = html("Starting…")
		currentCard = PROGRESS
		cards.show(deck, PROGRESS)
		BackfillRunner.run(
			project = project,
			service = service,
			hashes = selected,
			onProgress = { p ->
				if (p.total > 0) progressBar.value = p.done * 100 / p.total
				progressLabel.text = html("${p.done}/${p.total} — ${trim(p.subject)}")
			},
			onComplete = { report -> showDone(report) },
		)
	}

	// ── PROGRESS ───────────────────────────────────────────────────────────
	private fun progressCard(): JPanel {
		progressBar.isStringPainted = false
		return column(htmlLabel(html("Building memory…")), progressBar, progressLabel)
	}

	// ── DONE ─────────────────────────────────────────────────────────────
	private fun doneCard(): JPanel {
		val close = row(JButton("Close").apply { addActionListener { closeToOffer() } })
		return column(doneSummary, doneRows, close)
	}

	private fun showDone(report: BackfillCli.Report?) {
		doneRows.removeAll()
		if (report == null) {
			// Engine could not run (Node/bundle missing, cancelled, or failure) — the
			// balloon already explained why. Fall back to the offer so the user can retry.
			showOffer()
			return
		}
		doneSummary.text = html(
			"Done — ${report.generated} generated, ${report.skipped} skipped, ${report.errors} error(s).",
		)
		for (r in report.rows) {
			val meta = if (r.status == "error") "failed" else backfillResult(r.sessions, r.topics)
			doneRows.add(htmlLabel(html("• ${trim(r.subject)} — $meta")))
		}
		doneRows.revalidate()
		doneRows.repaint()
		currentCard = DONE
		cards.show(deck, DONE)
		onVisibilityRefresh()
	}

	private fun closeToOffer() {
		showOffer()
		onVisibilityRefresh()
	}

	// ── layout + label helpers ─────────────────────────────────────────────
	private fun row(vararg comps: JComponent): JPanel =
		JPanel(FlowLayout(FlowLayout.LEFT, 6, 0)).apply {
			isOpaque = false
			alignmentX = Component.LEFT_ALIGNMENT
			for (c in comps) add(c)
		}

	private fun column(vararg comps: JComponent): JPanel =
		JPanel().apply {
			layout = BoxLayout(this, BoxLayout.Y_AXIS)
			isOpaque = false
			for (c in comps) {
				c.alignmentX = Component.LEFT_ALIGNMENT
				add(c)
				add(Box.createVerticalStrut(JBUI.scale(6)))
			}
		}

	private fun htmlLabel(text: String): JBLabel =
		JBLabel(text).apply {
			horizontalAlignment = SwingConstants.LEFT
			verticalAlignment = SwingConstants.TOP
		}

	/** Wrap text in width-constrained HTML so long copy wraps inside the narrow sidebar. */
	private fun html(text: String): String =
		"<html><body style='width:220px'>${escape(text)}</body></html>"

	private fun escape(s: String): String =
		s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

	private fun trim(subject: String): String =
		if (subject.length > 60) "${subject.take(57)}…" else subject

	companion object {
		const val COLD_START_CAP = 10

		private const val OFFER = "offer"
		private const val LIST = "list"
		private const val PROGRESS = "progress"
		private const val DONE = "done"

		private fun plural(n: Int): String = if (n == 1) "" else "s"

		/** Mirror of BackfillListRenderer.formatBackfillMeta. */
		fun backfillMeta(sessions: Int, conversationTurns: Int): String =
			if (sessions <= 0) "Code change only"
			else "$sessions session${plural(sessions)} · $conversationTurns turn${plural(conversationTurns)}"

		/** Mirror of BackfillListRenderer.formatBackfillResult. */
		fun backfillResult(sessions: Int, topics: Int): String =
			if (sessions <= 0) "$topics topic${plural(topics)}"
			else "$sessions session${plural(sessions)} · $topics topic${plural(topics)}"

		/** Mirror of BackfillListRenderer.formatColdStartNote. */
		fun coldStartNote(variant: String?, recentMissingCount: Int, cap: Int): String {
			if (variant == "gaps") {
				val n = recentMissingCount
				return if (n >= cap) {
					"You are set up. The $cap most recent commits from the last month without a memory yet — " +
						"build now, or manage all in Settings (new commits capture automatically)."
				} else {
					"You are set up. $n recent commit${plural(n)} from the last month (up to $cap) without a memory yet — " +
						"build now, or keep coding (new commits capture automatically)."
				}
			}
			return "You are set up — this repo has no memories yet. Build them from your recent commits, " +
				"or just keep coding and they capture automatically."
		}
	}
}

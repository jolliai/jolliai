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
import java.awt.Cursor
import java.awt.Dimension
import java.awt.Font
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JProgressBar
import javax.swing.SwingConstants

/**
 * BackfillPanel — the tool-window "build memory from your history" card. Native-Swing
 * port of the VS Code sidebar cold-start card (vscode/src/views/SidebarScriptBuilder.ts).
 * Titles, subtitles, button labels, benefit lines, and footer copy are kept as close to
 * the VS Code wording as Swing allows so the two editors read identically. State machine
 * driven by a [CardLayout]:
 *
 *   OFFER    → pitch (title/subtitle/benefits) + ✓ note + "Build memories from commits"
 *   LOADING  → "Scanning your recent commits…"
 *   LIST     → selectable commits + "Build N memories" + "N more … manage all in Settings"
 *   PROGRESS → "N / total built" + bar
 *   DONE     → "N memories built from your history" + rows, or the "Couldn't build" retry view
 *
 * Every state carries a header ✕ that dismisses the card (writes the repo-wide marker).
 * Owns its own visibility via [shouldBeVisible] so mid-flow states aren't clobbered when
 * cold-start signals change. Row/note wording lives in the shared companion helpers, kept
 * 1:1 with vscode BackfillListRenderer.ts.
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

	// Rebuilt per state (native Swing has no virtual DOM), so each render replaces the
	// single card panel's contents. We keep references only to the widgets we mutate live.
	private val offerHolder = holder()
	private val loadingHolder = holder()
	private val listHolder = holder()
	private val progressHolder = holder()
	private val doneHolder = holder()

	private val checkboxes = mutableListOf<Pair<JBCheckBox, BackfillCli.Candidate>>()
	private val generateButton = JButton()
	private val progressBar = JProgressBar(0, 100)
	private val progressLabel = htmlLabel("")

	init {
		isOpaque = false
		border = JBUI.Borders.empty(8, 10, 12, 10)
		deck.isOpaque = false
		deck.add(offerHolder, OFFER)
		deck.add(loadingHolder, LOADING)
		deck.add(listHolder, LIST)
		deck.add(progressHolder, PROGRESS)
		deck.add(doneHolder, DONE)
		add(deck, BorderLayout.CENTER)
		showOffer()
	}

	/** Mid-flow (LOADING/LIST/PROGRESS/DONE) stays visible; OFFER defers to the service. */
	fun shouldBeVisible(): Boolean = currentCard != OFFER || service.shouldShowBackfillCard()

	/** Refreshes the offer copy from current signals without disturbing a mid-flow view. */
	fun syncOffer() {
		if (currentCard == OFFER) renderInto(offerHolder, offerChildren())
	}

	// ── OFFER ────────────────────────────────────────────────────────────
	private fun showOffer() {
		currentCard = OFFER
		renderInto(offerHolder, offerChildren())
		cards.show(deck, OFFER)
	}

	private fun offerChildren(): List<JComponent> {
		val benefits = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.Y_AXIS)
			isOpaque = false
			alignmentX = LEFT
			for (b in BENEFITS) add(bodyLabel("<b>${b.first}</b> ${b.second}"))
		}
		val cta = primaryButton("Build memories from commits") { onBuildNow() }
		return listOf(
			header("Never re-explain a decision again"),
			subtitle("The conversations, plans and the why behind every commit, replayed into your next session — in any AI tool."),
			benefits,
			noteLabel("✓ ${coldStartNote(service.coldStartVariant, service.recentMissingCount, COLD_START_CAP)}"),
			cta,
			footer("🔒 Runs locally on your machine: nothing leaves unless you Share or Sync."),
		)
	}

	private fun onBuildNow() {
		val cwd = service.mainRepoRoot ?: project.basePath ?: return
		currentCard = LOADING
		renderInto(
			loadingHolder,
			listOf(
				header("Scanning your recent commits…"),
				bodyLabel("Looking for the conversations behind each commit. This stays on your machine."),
			),
		)
		cards.show(deck, LOADING)
		ApplicationManager.getApplication().executeOnPooledThread {
			var totalMissing = 0
			val enriched: List<BackfillCli.Candidate> = when (val listed = BackfillCli.listCandidates(cwd, sinceDays = 30, limit = COLD_START_CAP)) {
				is BackfillCli.Outcome.Ok -> {
					totalMissing = listed.value.missing
					when (val p = BackfillCli.preview(cwd, listed.value.candidates)) {
						is BackfillCli.Outcome.Ok -> p.value
						else -> listed.value.candidates
					}
				}
				else -> {
					log.info("Build-now candidate scan unavailable")
					emptyList()
				}
			}
			ApplicationManager.getApplication().invokeLater { showList(enriched, totalMissing) }
		}
	}

	// ── LIST ─────────────────────────────────────────────────────────────
	private fun showList(candidates: List<BackfillCli.Candidate>, totalMissing: Int) {
		currentCard = LIST
		if (candidates.isEmpty()) {
			renderInto(
				listHolder,
				listOf(
					header("No commits to build from"),
					noteLabel("No commits from the last month need a memory. Keep coding — new commits capture automatically."),
				),
			)
			cards.show(deck, LIST)
			return
		}

		checkboxes.clear()
		val list = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.Y_AXIS)
			isOpaque = false
			alignmentX = LEFT
			for (c in candidates) {
				val cb = JBCheckBox(rowText(c), true)
				cb.isOpaque = false
				cb.alignmentX = LEFT
				cb.toolTipText = c.subject
				cb.addActionListener { updateGenerateButton() }
				checkboxes.add(cb to c)
				add(cb)
			}
		}
		val scroll = JBScrollPane(list).apply {
			border = JBUI.Borders.empty()
			preferredSize = Dimension(0, JBUI.scale(150))
			maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(150))
			alignmentX = LEFT
			isOpaque = false
			viewport.isOpaque = false
		}

		generateButton.addActionListenerOnce { onGenerate() }
		updateGenerateButton()

		val children = mutableListOf(
			header("Build memories from your recent commits"),
			subtitle("Pick the commits to reconstruct. We attach the AI conversation behind each one when we can find it."),
			scroll as JComponent,
		)
		val more = totalMissing - candidates.size
		if (more > 0) {
			children.add(linkLabel("$more more commit${plural(more)} without a memory — manage all in Settings") { openSettings() })
		}
		children.add(wrap(generateButton))
		children.add(footer("Runs one AI call per commit, locally. Nothing leaves unless you Share or Sync."))
		renderInto(listHolder, children)
		cards.show(deck, LIST)
	}

	private fun rowText(c: BackfillCli.Candidate): String =
		"${trim(c.subject)}   ${backfillMeta(c.sessions, c.conversationTurns)}"

	private fun selectedHashes(): List<String> =
		checkboxes.filter { it.first.isSelected }.map { it.second.commitHash }

	private fun updateGenerateButton() {
		val n = selectedHashes().size
		generateButton.isEnabled = n > 0
		generateButton.text = if (n == 0) "Select commits to build" else "Build $n memor${if (n == 1) "y" else "ies"}"
	}

	private fun onGenerate() {
		val selected = selectedHashes()
		if (selected.isEmpty()) return
		startProgress(selected.size)
		BackfillRunner.run(
			project = project,
			service = service,
			hashes = selected,
			onProgress = { p -> updateProgress(p.done, p.total) },
			onComplete = { report -> showDone(report) },
		)
	}

	// ── PROGRESS ───────────────────────────────────────────────────────────
	private fun startProgress(total: Int) {
		currentCard = PROGRESS
		progressBar.value = 0
		progressLabel.text = html("<b>0</b> / $total built")
		renderInto(
			progressHolder,
			listOf(
				header("Building memories from your commits…"),
				progressLabel,
				progressBar.also { it.isStringPainted = false; it.alignmentX = LEFT },
				footer("Reading each commit's message + diff. This stays on your machine."),
			),
		)
		cards.show(deck, PROGRESS)
	}

	private fun updateProgress(done: Int, total: Int) {
		if (total > 0) progressBar.value = done * 100 / total
		progressLabel.text = html("<b>$done</b> / $total built")
	}

	// ── DONE ─────────────────────────────────────────────────────────────
	private fun showDone(report: BackfillCli.Report?) {
		currentCard = DONE
		if (report == null) {
			// Engine could not run (Node/bundle missing, cancelled) — the balloon explained
			// why; fall back to the offer so the user can retry.
			showOffer()
			return
		}

		if (report.generated == 0) {
			val nErr = report.errors
			val children = mutableListOf<JComponent>(
				header("Couldn't build memories"),
				noteLabel("⚠ $nErr commit${plural(nErr)} couldn't be built. Check your AI credentials, then try again."),
			)
			for (r in report.rows) children.add(bodyLabel("⚠ ${trim(r.subject)} — failed"))
			children.add(primaryButton("Try again") { onBuildNow() })
			renderInto(doneHolder, children)
			cards.show(deck, DONE)
			onVisibilityRefresh()
			return
		}

		val errNote = if (report.errors > 0) " · ${report.errors} could not be built" else ""
		val children = mutableListOf<JComponent>(
			header("${report.generated} memor${if (report.generated == 1) "y" else "ies"} built from your history"),
			noteLabel("Reconstructed from each commit + diff$errNote. Live AI sessions will add richer memories as you work."),
		)
		for (r in report.rows) {
			val meta = if (r.status == "error") "failed" else backfillResult(r.sessions, r.topics)
			children.add(bodyLabel("${if (r.status == "error") "⚠" else "✦"} ${trim(r.subject)} — $meta"))
		}
		children.add(primaryButton("Open your Memory Bank") { closeToOffer() })
		renderInto(doneHolder, children)
		cards.show(deck, DONE)
		onVisibilityRefresh()
	}

	private fun closeToOffer() {
		showOffer()
		onVisibilityRefresh()
	}

	private fun openSettings() {
		SettingsDialog(project, service).show()
	}

	// ── layout + label helpers ─────────────────────────────────────────────
	private fun holder(): JPanel =
		JPanel().apply {
			layout = BoxLayout(this, BoxLayout.Y_AXIS)
			isOpaque = false
		}

	/** Replaces a card holder's contents with [comps], each left-aligned + spaced. */
	private fun renderInto(target: JPanel, comps: List<JComponent>) {
		target.removeAll()
		for (c in comps) {
			c.alignmentX = LEFT
			target.add(c)
			target.add(Box.createVerticalStrut(JBUI.scale(6)))
		}
		target.revalidate()
		target.repaint()
	}

	/** Header row: bold title on the left, a ✕ dismiss button on the right. */
	private fun header(title: String): JComponent {
		val titleLabel = JBLabel(title).apply {
			font = font.deriveFont(Font.BOLD, font.size2D + 1f)
		}
		val dismiss = JButton("✕").apply {
			toolTipText = "Dismiss"
			isContentAreaFilled = false
			isBorderPainted = false
			isFocusPainted = false
			margin = JBUI.emptyInsets()
			cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
			addActionListener { service.dismissBackfillCard() }
		}
		return JPanel(BorderLayout()).apply {
			isOpaque = false
			alignmentX = LEFT
			add(titleLabel, BorderLayout.CENTER)
			add(dismiss, BorderLayout.EAST)
			maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
		}
	}

	private fun subtitle(text: String): JComponent = grayLabel(text)
	private fun noteLabel(text: String): JComponent = bodyLabel(text)
	private fun footer(text: String): JComponent = grayLabel(text)

	private fun primaryButton(text: String, onClick: () -> Unit): JComponent =
		wrap(JButton(text).apply { addActionListener { onClick() } })

	private fun linkLabel(text: String, onClick: () -> Unit): JComponent =
		JBLabel("<html><a href=''>${escape(text)}</a></html>").apply {
			alignmentX = LEFT
			cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
			addMouseListener(object : java.awt.event.MouseAdapter() {
				override fun mouseClicked(e: java.awt.event.MouseEvent) = onClick()
			})
		}

	/** Wrap a button in a left-aligned flow row so it keeps its natural width. */
	private fun wrap(c: JComponent): JComponent =
		JPanel(java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 0, 0)).apply {
			isOpaque = false
			alignmentX = LEFT
			add(c)
		}

	private fun bodyLabel(htmlBody: String): JBLabel =
		JBLabel(html(htmlBody)).apply {
			horizontalAlignment = SwingConstants.LEFT
			verticalAlignment = SwingConstants.TOP
			alignmentX = LEFT
		}

	private fun grayLabel(text: String): JBLabel =
		JBLabel(html("<span style='color:gray'>${escape(text)}</span>")).apply {
			horizontalAlignment = SwingConstants.LEFT
			verticalAlignment = SwingConstants.TOP
			alignmentX = LEFT
		}

	private fun htmlLabel(text: String): JBLabel =
		JBLabel(text).apply {
			horizontalAlignment = SwingConstants.LEFT
			verticalAlignment = SwingConstants.TOP
			alignmentX = LEFT
		}

	/** Width-constrained HTML so long copy wraps in the narrow tool window. */
	private fun html(body: String): String = "<html><body style='width:230px'>$body</body></html>"

	private fun escape(s: String): String =
		s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

	private fun trim(subject: String): String =
		if (subject.length > 52) "${subject.take(49)}…" else subject

	/** Adds [action] as the sole listener (clears prior ones so re-render doesn't stack them). */
	private fun JButton.addActionListenerOnce(action: () -> Unit) {
		actionListeners.forEach { removeActionListener(it) }
		addActionListener { action() }
	}

	companion object {
		const val COLD_START_CAP = 10
		private val LEFT: Float = Component.LEFT_ALIGNMENT

		private const val OFFER = "offer"
		private const val LOADING = "loading"
		private const val LIST = "list"
		private const val PROGRESS = "progress"
		private const val DONE = "done"

		/** The three offer benefits, mirroring the VS Code card (icon dropped in Swing). */
		private val BENEFITS = listOf(
			"Pick up where you left off." to "Sessions and plans replay next time.",
			"Recall in any tool." to "Claude, Cursor, Codex via MCP. No copy-paste.",
			"Knowledge builds itself." to "A wiki + graph from your commits.",
		)

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

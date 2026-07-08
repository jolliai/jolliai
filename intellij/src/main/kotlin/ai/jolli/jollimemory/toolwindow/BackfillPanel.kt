package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.backfill.BackfillCli
import com.intellij.icons.AllIcons
import ai.jolli.jollimemory.backfill.BackfillRunner
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import com.intellij.ui.RoundedLineBorder
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.AlphaComposite
import java.awt.BorderLayout
import java.awt.CardLayout
import java.awt.Color
import java.awt.Component
import java.awt.Cursor
import java.awt.Dimension
import java.awt.Font
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.image.BufferedImage
import java.awt.event.ComponentAdapter
import java.awt.event.ComponentEvent
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.Icon
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JProgressBar
import javax.swing.SwingConstants

/**
 * BackfillPanel — the tool-window "build memory from your history" card. Native-Swing
 * port of the VS Code sidebar cold-start card (vscode/src/views/SidebarScriptBuilder.ts).
 * Styling mirrors the plugin's own onboarding card (OnboardingPanel): a blue accent CTA,
 * a title/benefit icon column, and copy that reads the same as VS Code.
 *
 * States (CardLayout): OFFER → LOADING → LIST → PROGRESS → DONE. Every state has a header
 * ✕ that dismisses (writes the repo-wide marker). Text blocks reflow to the current tool-
 * window width via [reflow] (registered [wrapEntries] re-set their HTML width on resize),
 * so content tracks the sidebar rather than a fixed column. Row/note wording lives in the
 * companion helpers, kept 1:1 with vscode BackfillListRenderer.ts.
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

	private val offerHolder = holder()
	private val loadingHolder = holder()
	private val listHolder = holder()
	private val progressHolder = holder()
	private val doneHolder = holder()

	private val checkboxes = mutableListOf<Pair<JBCheckBox, BackfillCli.Candidate>>()
	private val generateButton = blueButton("", white(DATABASE_ICON)) { onGenerate() }
	private val progressBar = JProgressBar(0, 100)

	/** Width-tracking text blocks for the currently mounted card: (label, leftIndentPx, htmlBody). */
	private val wrapEntries = mutableListOf<WrapEntry>()
	private class WrapEntry(val label: JBLabel, val indent: Int, val body: String)

	init {
		isOpaque = false
		// A bare bordered card (matching VS Code's `.backfill-panel` div), NOT a titled
		// accordion section — an outer margin, a rounded outline, then inner padding.
		border = JBUI.Borders.compound(
			JBUI.Borders.empty(6),
			JBUI.Borders.compound(RoundedLineBorder(JBColor.border(), JBUI.scale(10), 1), JBUI.Borders.empty(8, 10, 12, 10)),
		)
		deck.isOpaque = false
		deck.add(offerHolder, OFFER)
		deck.add(loadingHolder, LOADING)
		deck.add(listHolder, LIST)
		deck.add(progressHolder, PROGRESS)
		deck.add(doneHolder, DONE)
		add(deck, BorderLayout.CENTER)
		// Reflow wrapped copy whenever the tool window is resized so it fills the sidebar.
		addComponentListener(object : ComponentAdapter() {
			override fun componentResized(e: ComponentEvent) = reflow()
		})
		showOffer()
	}

	/** Fit its own height in the accordion's vertical BoxLayout (never stretch vertically). */
	override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)

	/**
	 * A ✕ dismiss always hides the card (matching VS Code, whose visibility is purely
	 * `!dismissed && …`). Otherwise mid-flow (LOADING/LIST/PROGRESS/DONE) stays visible so a
	 * signal change can't yank it away, and OFFER defers to the service's cold-start decision.
	 */
	fun shouldBeVisible(): Boolean {
		if (service.backfillDismissed) return false
		return currentCard != OFFER || service.shouldShowBackfillCard()
	}

	/** Refreshes the offer copy from current signals without disturbing a mid-flow view. */
	fun syncOffer() {
		if (currentCard == OFFER) mount(offerHolder, OFFER, offerChildren())
	}

	// ── OFFER ────────────────────────────────────────────────────────────
	private fun showOffer() = mount(offerHolder, OFFER, offerChildren())

	private fun offerChildren(): List<JComponent> {
		val benefits = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.Y_AXIS)
			isOpaque = false
			alignmentX = LEFT
			for ((i, b) in BENEFITS.withIndex()) {
				add(iconRow(blue(BENEFIT_ICONS[i]), "<b>${b.first}</b> ${b.second}"))
				if (i < BENEFITS.lastIndex) add(Box.createVerticalStrut(JBUI.scale(4)))
			}
		}
		return listOf(
			header("Never re-explain a decision again", blue(JolliMemoryIcons.Sparkle, TITLE_ICON_PX)),
			grayWrap("The conversations, plans and the why behind every commit, replayed into your next session — in any AI tool.", 0),
			benefits,
			iconRow(sized(JolliMemoryIcons.Check), coldStartNote(service.coldStartVariant, service.recentMissingCount, COLD_START_CAP)),
			blueButton("Build memories from commits", white(DATABASE_ICON)) { onBuildNow() },
			grayWrap("🔒 Runs locally on your machine: nothing leaves unless you Share or Sync.", 0),
		)
	}

	private fun onBuildNow() {
		val cwd = service.mainRepoRoot ?: project.basePath ?: return
		mount(loadingHolder, LOADING, listOf(
			header("Scanning your recent commits…", null),
			grayWrap("Looking for the conversations behind each commit. This stays on your machine.", 0),
		))
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
		if (candidates.isEmpty()) {
			mount(listHolder, LIST, listOf(
				header("No commits to build from", null),
				grayWrap("No commits from the last month need a memory. Keep coding — new commits capture automatically.", 0),
			))
			return
		}

		checkboxes.clear()
		val list = JPanel().apply {
			layout = BoxLayout(this, BoxLayout.Y_AXIS)
			isOpaque = false
			alignmentX = LEFT
			for (c in candidates) {
				val cb = JBCheckBox(rowText(c), true).apply {
					isOpaque = false
					alignmentX = LEFT
					toolTipText = c.subject
					addActionListener { updateGenerateButton() }
				}
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
		updateGenerateButton()

		val children = mutableListOf<JComponent>(
			header("Build memories from your recent commits", null),
			grayWrap("Pick the commits to reconstruct. We attach the AI conversation behind each one when we can find it.", 0),
			scroll,
		)
		val more = totalMissing - candidates.size
		if (more > 0) children.add(linkLabel("$more more commit${plural(more)} without a memory — manage all in Settings") { openSettings() })
		children.add(generateButton)
		children.add(grayWrap("Runs one AI call per commit, locally. Nothing leaves unless you Share or Sync.", 0))
		mount(listHolder, LIST, children)
	}

	private fun rowText(c: BackfillCli.Candidate): String =
		"${trim(c.subject)}   —   ${backfillMeta(c.sessions, c.conversationTurns)}"

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
	private val progressText = wrapLabelFor(0)

	private fun startProgress(total: Int) {
		progressBar.value = 0
		progressBar.isStringPainted = false
		progressBar.alignmentX = LEFT
		setWrap(progressText, "<b>0</b> / $total built", 0)
		mount(progressHolder, PROGRESS, listOf(
			header("Building memories from your commits…", null),
			progressText,
			progressBar,
			grayWrap("Reading each commit's message + diff. This stays on your machine.", 0),
		))
	}

	private fun updateProgress(done: Int, total: Int) {
		if (total > 0) progressBar.value = done * 100 / total
		setWrap(progressText, "<b>$done</b> / $total built", 0)
		reflow()
	}

	// ── DONE ─────────────────────────────────────────────────────────────
	private fun showDone(report: BackfillCli.Report?) {
		if (report == null) {
			showOffer()
			return
		}
		if (report.generated == 0) {
			val nErr = report.errors
			val children = mutableListOf<JComponent>(
				header("Couldn't build memories", null),
				iconRow(JolliMemoryIcons.Warning, "$nErr commit${plural(nErr)} couldn't be built. Check your AI credentials, then try again."),
			)
			for (r in report.rows) children.add(iconRow(sized(JolliMemoryIcons.Warning), "${escape(trim(r.subject))} — failed"))
			children.add(blueButton("Try again", white(JolliMemoryIcons.Refresh)) { onBuildNow() })
			mount(doneHolder, DONE, children)
			onVisibilityRefresh()
			return
		}
		val errNote = if (report.errors > 0) " · ${report.errors} could not be built" else ""
		val children = mutableListOf<JComponent>(
			header("${report.generated} memor${if (report.generated == 1) "y" else "ies"} built from your history", null),
			grayWrap("Reconstructed from each commit + diff$errNote. Live AI sessions will add richer memories as you work.", 0),
		)
		for (r in report.rows) {
			val icon = if (r.status == "error") JolliMemoryIcons.Warning else JolliMemoryIcons.Sparkle
			val meta = if (r.status == "error") "failed" else backfillResult(r.sessions, r.topics)
			children.add(iconRow(sized(icon), "${escape(trim(r.subject))} — $meta"))
		}
		children.add(blueButton("Open your Memory Bank", white(JolliMemoryIcons.Book)) { closeToOffer() })
		mount(doneHolder, DONE, children)
		onVisibilityRefresh()
	}

	private fun closeToOffer() {
		showOffer()
		onVisibilityRefresh()
	}

	/**
	 * ✕ handler for every state: reset to OFFER (so a later re-show starts clean) and mark the
	 * card dismissed — which flips [shouldBeVisible] to false and hides it. Works from any state,
	 * including the LIST/"No commits" view reached by clicking Build.
	 */
	private fun onDismiss() {
		showOffer()
		service.dismissBackfillCard()
	}

	private fun openSettings() = SettingsDialog(project, service).show()

	// ── mount + reflow ─────────────────────────────────────────────────────
	/** Replaces [holder]'s contents, switches to it, and reflows wrapped copy to the width. */
	private fun mount(holder: JPanel, card: String, comps: List<JComponent>) {
		currentCard = card
		holder.removeAll()
		for (c in comps) {
			c.alignmentX = LEFT
			holder.add(c)
			holder.add(Box.createVerticalStrut(JBUI.scale(6)))
		}
		// Drop wrap-labels detached by this holder's removeAll (labels still mounted in
		// other holders keep their parent and stay registered).
		wrapEntries.removeAll { it.label.parent == null }
		holder.revalidate()
		holder.repaint()
		cards.show(deck, card)
		ApplicationManager.getApplication().invokeLater { reflow() }
	}

	/** Content width available to text (panel width minus horizontal insets). */
	private fun contentWidth(): Int {
		val ins = insets
		return (width - ins.left - ins.right).coerceAtLeast(JBUI.scale(140))
	}

	/** Re-sets each registered wrap label's HTML width so long copy wraps to the sidebar. */
	private fun reflow() {
		val w = contentWidth()
		for (e in wrapEntries) {
			e.label.text = "<html><body style='width:${(w - e.indent).coerceAtLeast(JBUI.scale(60))}px'>${e.body}</body></html>"
		}
		revalidate()
		repaint()
	}

	// ── widget helpers ─────────────────────────────────────────────────────
	private fun holder(): JPanel = JPanel().apply {
		layout = BoxLayout(this, BoxLayout.Y_AXIS)
		isOpaque = false
	}

	/**
	 * Header row: an optional leading icon, a bold **wrapping** title beside it (so the icon
	 * and title stay on the same line while long titles wrap to the right of the icon), and a
	 * ✕ dismiss on the right.
	 */
	private fun header(title: String, icon: Icon?): JComponent {
		val titleLabel = wrapLabelFor(0).apply { font = font.deriveFont(Font.BOLD, font.size2D + 1f) }
		// Reserve room for the trailing ✕ (and the leading icon, when present) so the wrapped
		// title width matches the space actually allocated to the CENTER cell.
		val indent = JBUI.scale(30) + (if (icon != null) JBUI.scale(24) else 0)
		setWrap(titleLabel, escape(title), indent)
		val dismiss = JButton("✕").apply {
			toolTipText = "Dismiss"
			isContentAreaFilled = false
			isBorderPainted = false
			isFocusPainted = false
			margin = JBUI.emptyInsets()
			cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
			addActionListener { onDismiss() }
		}
		return JPanel(BorderLayout(JBUI.scale(8), 0)).apply {
			isOpaque = false
			alignmentX = LEFT
			if (icon != null) add(JBLabel(icon).apply { verticalAlignment = SwingConstants.TOP; border = JBUI.Borders.emptyTop(2) }, BorderLayout.WEST)
			add(titleLabel, BorderLayout.CENTER)
			add(dismiss, BorderLayout.EAST)
		}
	}

	/** A leading icon (top-aligned) beside a width-tracking HTML body. */
	private fun iconRow(icon: Icon, body: String): JComponent {
		val label = wrapLabelFor(0)
		val indent = icon.iconWidth + JBUI.scale(8)
		setWrap(label, body, indent)
		return JPanel(BorderLayout(JBUI.scale(8), 0)).apply {
			isOpaque = false
			alignmentX = LEFT
			add(JBLabel(icon).apply { verticalAlignment = SwingConstants.TOP; border = JBUI.Borders.emptyTop(1) }, BorderLayout.WEST)
			add(label, BorderLayout.CENTER)
		}
	}

	private fun grayWrap(text: String, indent: Int): JComponent {
		val label = wrapLabelFor(indent)
		setWrap(label, "<span style='color:gray'>${escape(text)}</span>", indent)
		return label
	}

	private fun wrapLabelFor(indent: Int): JBLabel = JBLabel().apply {
		horizontalAlignment = SwingConstants.LEFT
		verticalAlignment = SwingConstants.TOP
		alignmentX = LEFT
	}

	/** Registers [label] for width-tracking with the given HTML [body] and left [indent]. */
	private fun setWrap(label: JBLabel, body: String, indent: Int) {
		wrapEntries.removeAll { it.label === label }
		wrapEntries.add(WrapEntry(label, indent, body))
		label.text = "<html><body style='width:${(contentWidth() - indent).coerceAtLeast(JBUI.scale(60))}px'>$body</body></html>"
	}

	private fun linkLabel(text: String, onClick: () -> Unit): JComponent =
		JBLabel("<html><a href=''>${escape(text)}</a></html>").apply {
			alignmentX = LEFT
			cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
			addMouseListener(object : java.awt.event.MouseAdapter() {
				override fun mouseClicked(e: java.awt.event.MouseEvent) = onClick()
			})
		}

	/** Full-width blue accent button (matches OnboardingPanel.createBlueButton), with an icon. */
	private fun blueButton(text: String, icon: Icon?, onClick: () -> Unit): JButton = object : JButton(text) {
		init {
			this.icon = icon
			iconTextGap = JBUI.scale(6)
			horizontalAlignment = SwingConstants.CENTER
			alignmentX = Component.LEFT_ALIGNMENT
			foreground = Color.WHITE
			isOpaque = false
			isContentAreaFilled = false
			isFocusPainted = false
			isBorderPainted = false
			border = BorderFactory.createEmptyBorder(JBUI.scale(7), JBUI.scale(12), JBUI.scale(7), JBUI.scale(12))
			cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
			maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
			addActionListener { onClick() }
		}
		override fun paintComponent(g: Graphics) {
			val g2 = g.create() as Graphics2D
			g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
			g2.color = when {
				!isEnabled -> Color(0x3C, 0x52, 0x7A)
				model.isRollover -> Color(0x2D, 0x65, 0xD8)
				else -> Color(0x35, 0x74, 0xF0)
			}
			g2.fillRoundRect(0, 0, width, height, JBUI.scale(8), JBUI.scale(8))
			g2.dispose()
			super.paintComponent(g)
		}
	}

	private fun escape(s: String): String =
		s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

	private fun trim(subject: String): String =
		if (subject.length > 48) "${subject.take(45)}…" else subject

	companion object {
		const val COLD_START_CAP = 10
		private val LEFT: Float = Component.LEFT_ALIGNMENT

		private const val OFFER = "offer"
		private const val LOADING = "loading"
		private const val LIST = "list"
		private const val PROGRESS = "progress"
		private const val DONE = "done"

		/** Offer benefits, mirroring the VS Code card (bold lead + normal continuation). */
		private val BENEFITS = listOf(
			"Pick up where you left off." to "Sessions and plans replay next time.",
			"Recall in any tool." to "Claude, Cursor, Codex via MCP. No copy-paste.",
			"Knowledge builds itself." to "A wiki + graph from your commits.",
		)
		// Blue-tinted per request: run (pick up) / recall / knowledge. `AllIcons.Gutter.Run`
		// isn't in the plugin's build SDK (2024.3), so use the equivalent run/play glyph that
		// exists across versions; tinted blue it reads the same.
		private val BENEFIT_ICONS = listOf(AllIcons.Actions.Execute, JolliMemoryIcons.Eye, JolliMemoryIcons.Book)

		/** Leading icons are sized to the adjacent text's font height so they don't tower over it. */
		private val BODY_ICON_PX: Int = UIUtil.getLabelFont().size
		private val TITLE_ICON_PX: Int = BODY_ICON_PX + 1

		/** Blue accent, sized to text (title + benefit icons; the tick keeps its own green). */
		private fun blue(icon: Icon, size: Int = BODY_ICON_PX): Icon = CardIcon(icon, Color(0x35, 0x74, 0xF0), size)

		/** White, sized to text — reads on the blue accent button. */
		private fun white(icon: Icon, size: Int = BODY_ICON_PX): Icon = CardIcon(icon, Color.WHITE, size)

		/** Untinted but sized to text (e.g. the green tick, the done-row status icons). */
		private fun sized(icon: Icon, size: Int = BODY_ICON_PX): Icon = CardIcon(icon, null, size)

		/** Database cylinder for the "build memories" action (mirrors VS Code's codicon-database). */
		private val DATABASE_ICON: Icon = JolliMemoryIcons.Database

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

/**
 * Renders [base] optionally recolored to [tint] (keeping its alpha/shape) and scaled to a
 * [size]×[size] logical box — so a leading icon can match the height of the text beside it.
 * Uses only core AWT so it is stable across IntelliJ platform versions; this replaces
 * `IconUtil.colorize`, whose signature drifts between SDKs (a NoSuchMethodError from that
 * call once crashed the whole tool window when the build SDK and runtime IDE differed).
 */
private class CardIcon(private val base: Icon, private val tint: Color?, private val size: Int) : Icon {
	override fun getIconWidth(): Int = size
	override fun getIconHeight(): Int = size
	override fun paintIcon(c: Component?, g: Graphics, x: Int, y: Int) {
		val bw = base.iconWidth.coerceAtLeast(1)
		val bh = base.iconHeight.coerceAtLeast(1)
		// Render (and tint) the base at its natural size into a HiDPI-aware buffer …
		val buf = UIUtil.createImage(c, bw, bh, BufferedImage.TYPE_INT_ARGB)
		val bg = buf.createGraphics()
		bg.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
		base.paintIcon(c, bg, 0, 0)
		if (tint != null) {
			// Paint the tint only where the icon has pixels (SrcAtop preserves alpha).
			bg.composite = AlphaComposite.SrcAtop
			bg.color = tint
			bg.fillRect(0, 0, bw, bh)
		}
		bg.dispose()
		// … then blit it scaled to the target square, centered if the source isn't square.
		val g2 = g.create() as Graphics2D
		g2.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR)
		g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
		g2.drawImage(buf, x, y, size, size, null)
		g2.dispose()
	}
}

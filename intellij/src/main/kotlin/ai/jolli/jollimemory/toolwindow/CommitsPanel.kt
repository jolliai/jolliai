package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.bridge.CommitSummaryBrief
import ai.jolli.jollimemory.bridge.ConversationBrief
import ai.jolli.jollimemory.core.ActiveConversationItem
import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.NoteFormat
import ai.jolli.jollimemory.core.TranscriptSource
import ai.jolli.jollimemory.core.KBDataCache
import com.google.gson.Gson
import ai.jolli.jollimemory.services.CommitFileInfo
import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.services.PrService
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.ide.BrowserUtil
import com.intellij.icons.AllIcons
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import com.intellij.ui.RoundedLineBorder
import com.intellij.ui.components.JBLabel
import com.intellij.util.messages.MessageBusConnection
import com.intellij.util.ui.JBUI
import git4idea.repo.GitRepository
import git4idea.repo.GitRepositoryChangeListener
import java.awt.BorderLayout
import java.awt.Toolkit
import java.awt.datatransfer.StringSelection
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.awt.Color
import java.awt.Component
import java.awt.Cursor
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Graphics
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.io.File
import java.time.Duration
import java.time.Instant
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JCheckBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JTextArea
import javax.swing.JOptionPane
import javax.swing.JPanel
import javax.swing.SwingConstants
import javax.swing.SwingUtilities
import javax.swing.JSeparator
import javax.swing.JWindow
import javax.swing.Timer
import javax.swing.UIManager

/**
 * Commits panel — matches VS Code HistoryTreeProvider exactly.
 *
 * Each commit is a collapsible row that expands to show changed files:
 *   [▶/▼] [checkbox] <message> [☁] <MM-DD>  [👁]
 *     ├─ [file-icon] filename  relativePath  [M]
 *     └─ [file-icon] filename  relativePath  [A]
 *
 * Uses independent JPanel instances per row (like ChangesPanel) instead of a
 * JTree cell renderer, which eliminates hover-shift artifacts caused by the
 * rubber-stamp rendering pattern.
 *
 * Features:
 * - Collapsible commit → file children (matching VS Code CommitFileItem)
 * - ☁ pushed badge on commit label (matching VS Code buildLabel)
 * - Checkboxes with range-based squash selection
 * - Eye icon for commits with memories
 * - File status decoration (M/A/D colors and icons)
 * - Click file to open git diff
 * - Merged branch detection (read-only mode, no checkboxes)
 */
class CommitsPanel(
    private val project: Project,
    private val service: JolliMemoryService,
) : JPanel(BorderLayout()), Disposable, RowCountSource {

    override var onRowCountChanged: ((Int) -> Unit)? = null
    private var rowCount = 0
    override fun currentRowCount(): Int = rowCount

    private val listPanel = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
    }
    private val emptyLabel = JBLabel(
        "<html><center>Start coding — your commit memories will appear here.<br/>" +
            "Every commit on this branch will be automatically summarized.</center></html>",
        SwingConstants.CENTER,
    )
    private val checkedHashes = mutableSetOf<String>()
    private var commits: List<CommitSummaryBrief> = emptyList()
    /**
     * How many commits are currently shown. Starts at [CappedRows.CAP] and grows
     * by that page size each time the user clicks "Show N more". Reset to the cap
     * whenever the commit sequence changes (new branch / new commit), but preserved
     * across content-identical refreshes (e.g. a background summary tick) so the
     * list doesn't snap shut while the user is reading.
     */
    private var visibleCommits: Int = CappedRows.CAP
    /** Per-commit UI state for expand/collapse and checkbox management. */
    private val commitRowStates = mutableMapOf<String, CommitRowState>()
    /**
     * Cache of the expanded memory detail (summary + conversations + files) per
     * commit hash. Stores a CompletableFuture so concurrent expands share one
     * in-flight read.
     */
    private val detailCache = ConcurrentHashMap<String, CompletableFuture<ExpansionDetail>>()
    /** True when the branch is fully merged into main (read-only history view). */
    private var isMerged = false
    /**
     * Branch-level PR status, fetched once per refresh (shared by every row's PR
     * chip + SHIPPED row). Null when gh is unavailable / the branch is unpublished.
     */
    private var prLookup: PrService.PrLookup? = null

    // ─── Foreign mode state ──────────────────────────────────────────────────
    /** When non-null, the panel shows read-only memories from a foreign repo/branch. */
    private var foreignRepo: String? = null
    private var foreignBranch: String? = null
    private var foreignEntries: List<KBDataCache.KBEntry> = emptyList()

    private val statusListener: () -> Unit = { SwingUtilities.invokeLater { refresh() } }
    private val memoryStateListener: () -> Unit = { SwingUtilities.invokeLater { refresh() } }
    private val messageBusConnection: MessageBusConnection = project.messageBus.connect()
    private var gitChangeDebounceTimer: Timer? = null

    // ─── Sticky hover popup (matching VS Code hover-card UX) ────────────────
    private var hoverPopup: JWindow? = null
    private var hoverRow: JPanel? = null
    private var hoverShowTimer: Timer? = null
    private val hoverDismissTimer = Timer(HOVER_HIDE_GRACE_MS) { dismissHoverPopup() }.apply { isRepeats = false }
    private companion object {
        val LOG: com.intellij.openapi.diagnostic.Logger = com.intellij.openapi.diagnostic.Logger.getInstance(CommitsPanel::class.java)
        val log = ai.jolli.jollimemory.core.JmLogger.create("CommitsPanel")
        const val ARROW_RIGHT = "\u25B6" // ▶
        const val ARROW_DOWN = "\u25BC"  // ▼
        const val HOVER_SHOW_DELAY_MS = 1000
        const val HOVER_HIDE_GRACE_MS = 200
        // Token-meter segment colors, dark/light theme aware. Input = green, output =
        // grey, cache = blue — matching the webview meters (--stat-add / grey / --link-fg).
        val TOK_INPUT_COLOR = JBColor(0x267F3F, 0x4ECE8D)
        val TOK_OUTPUT_COLOR = JBColor(0x808080, 0x808080)
        val TOK_CACHE_COLOR = JBColor(0x0066BF, 0x3794FF)
        val CHIP_OK_COLOR = JBColor(0x3C8C4E, 0x5BB06E)
        val CHIP_DIM_COLOR = JBColor(0x808080, 0x8C8C8C)
    }

    /**
     * Monotonically increasing version counter to prevent stale renders.
     * Each call to [refresh] increments this counter. When [refreshFromGit]
     * completes, it checks whether its version is still current — if a newer
     * refresh was started (e.g., status listener firing after install while
     * the initial slow refresh is still running), the stale result is discarded.
     */
    @Volatile
    private var refreshVersion = 0L

    init {
        border = JBUI.Borders.empty(8)

        service.addStatusListener(statusListener)
        // Refresh when a PR is created/updated or a memory is shared elsewhere (memory
        // summary or Create PR view), so the per-commit PR / Jolli-shared badges stay in
        // sync — all read the same branch PR + summary jolliDocUrl.
        service.addMemoryStateListener(memoryStateListener)

        // Subscribe directly to git repository changes (new commits, branch switches).
        // The service's status listener alone may not reliably trigger panel refresh
        // for IntelliJ UI commits — this dedicated listener ensures we catch all changes.
        // A 500ms debounce avoids redundant refreshes from rapid successive events.
        messageBusConnection.subscribe(
            GitRepository.GIT_REPO_CHANGE,
            GitRepositoryChangeListener { scheduleDebouncedGitRefresh() },
        )

        // Also subscribe to VCS config changes (catches terminal branch operations)
        messageBusConnection.subscribe(
            com.intellij.openapi.vcs.ProjectLevelVcsManager.VCS_CONFIGURATION_CHANGED,
            com.intellij.openapi.vcs.VcsListener { scheduleDebouncedGitRefresh() },
        )

        ApplicationManager.getApplication().executeOnPooledThread { refreshFromGit() }
    }

    private fun scheduleDebouncedGitRefresh() {
        gitChangeDebounceTimer?.stop()
        gitChangeDebounceTimer = Timer(500) { refresh() }.apply {
            isRepeats = false
            start()
        }
    }

    fun refresh() {
        if (isForeignMode) {
            // Re-filter from cache in case KBDataCache was reloaded
            setForeignMode(foreignRepo!!, foreignBranch!!)
            return
        }
        refreshVersion++
        ApplicationManager.getApplication().executeOnPooledThread { refreshFromGit() }
    }

    /**
     * Force refresh that bypasses the refreshVersion stale-discard mechanism.
     * Guarantees the UI updates regardless of concurrent refresh races.
     */
    fun forceRefresh() {
        ApplicationManager.getApplication().executeOnPooledThread {
            val status = service.getStatus()
            if (status == null) {
                SwingUtilities.invokeLater { showInitializing() }
                return@executeOnPooledThread
            }
            if (!status.enabled) {
                SwingUtilities.invokeLater { showDisabled() }
                return@executeOnPooledThread
            }
            try {
                val newCommits = service.getBranchCommits()
                isMerged = newCommits.isNotEmpty() && service.isBranchMerged()
                commits = newCommits
                prLookup = lookupBranchPr()
                SwingUtilities.invokeLater { updateCommitList() }
            } catch (_: Exception) {
                commits = emptyList()
                SwingUtilities.invokeLater { updateCommitList() }
            }
        }
    }

    /** Range-based checkbox toggle matching VS Code behavior. */
    private fun toggleCheckbox(commit: CommitSummaryBrief) {
        val idx = commits.indexOfFirst { it.hash == commit.hash }
        if (idx < 0) return
        val isChecked = commit.hash in checkedHashes

        if (isChecked) {
            // Uncheck this and everything older (idx to end)
            for (i in idx until commits.size) {
                checkedHashes.remove(commits[i].hash)
            }
        } else {
            // Check this and everything newer (0 to idx)
            for (i in 0..idx) {
                checkedHashes.add(commits[i].hash)
            }
        }
        syncAllCheckboxes()
    }

    fun getSelectedCommits(): List<CommitSummaryBrief> {
        return commits.filter { it.hash in checkedHashes }
    }

    /** Toggles all checkboxes — if all are checked, deselect all; otherwise select all. */
    fun toggleSelectAll() {
        if (commits.size <= 1) return
        val allChecked = commits.all { it.hash in checkedHashes }
        if (allChecked) {
            checkedHashes.clear()
        } else {
            commits.forEach { checkedHashes.add(it.hash) }
        }
        syncAllCheckboxes()
    }

    /** Updates all checkbox UI states to match [checkedHashes]. */
    private fun syncAllCheckboxes() {
        for ((hash, state) in commitRowStates) {
            state.checkbox?.isSelected = hash in checkedHashes
        }
        listPanel.repaint()
    }

    private fun refreshFromGit() {
        // Capture the current version at the start of this refresh.
        // If a newer refresh is triggered while this one is running (e.g., status
        // listener fires after install while the initial slow git log is still in progress),
        // this stale result will be discarded to prevent overwriting the newer UI state.
        val myVersion = refreshVersion

        val status = service.getStatus()
        if (status == null) {
            SwingUtilities.invokeLater { if (refreshVersion == myVersion) showInitializing() }
            return
        }
        if (!status.enabled) {
            SwingUtilities.invokeLater { if (refreshVersion == myVersion) showDisabled() }
            return
        }

        try {
            val newCommits = service.getBranchCommits()

            // Discard if a newer refresh was started while we were fetching
            if (refreshVersion != myVersion) return

            // Clear selection if commit sequence changed
            val newHashes = newCommits.map { it.hash }
            val oldHashes = commits.map { it.hash }
            if (newHashes != oldHashes) {
                if (checkedHashes.isNotEmpty()) checkedHashes.clear()
                // Clear detail cache when commit sequence changes
                detailCache.clear()
                // Collapse the list back to the first page on a new branch / new
                // commit; a content-identical refresh leaves the count untouched.
                visibleCommits = CappedRows.CAP
            }

            // Detect merged state: branch HEAD is reachable from main
            isMerged = newCommits.isNotEmpty() && service.isBranchMerged()

            commits = newCommits
            prLookup = lookupBranchPr()
            SwingUtilities.invokeLater { if (refreshVersion == myVersion) updateCommitList() }
        } catch (_: Exception) {
            if (refreshVersion != myVersion) return
            commits = emptyList()
            SwingUtilities.invokeLater { if (refreshVersion == myVersion) updateCommitList() }
        }
    }

    /**
     * Resolves the branch-level PR once per refresh (runs on the caller's pooled
     * thread). Skips the `gh` round-trip entirely when the branch is unpublished
     * (no pushed commits) or `gh` isn't installed / authenticated, so local-only
     * branches never pay for a process spawn. Returns null on any miss.
     */
    private fun lookupBranchPr(): PrService.PrLookup? {
        val cwd = service.mainRepoRoot ?: return null
        val gitOps = service.getGitOps() ?: return null
        val branch = gitOps.getCurrentBranch() ?: return null
        // The branch's PR lives on the remote and stays open regardless of whether
        // the local tip is pushed — e.g. right after a squash (which leaves the
        // squashed commit unpushed) or an amend. Gate on the branch being published
        // (has an upstream or an origin/<branch> ref), NOT on local commits being
        // pushed; otherwise SHIPPED wrongly reads "not created" until the next push.
        val published = gitOps.exec("rev-parse", "--verify", "--quiet", "@{upstream}") != null ||
            gitOps.exec("rev-parse", "--verify", "--quiet", "refs/remotes/origin/$branch") != null
        if (!published) return null
        return try {
            if (!PrService.isGhAvailable(cwd) || !PrService.isGhAuthenticated(cwd)) return null
            PrService.findPrForBranch(cwd, branch)
        } catch (_: Exception) {
            null
        }
    }

    /** The open PR for the branch, or null when there isn't one / lookup failed. */
    private fun openPr(): PrService.PrInfo? = (prLookup as? PrService.PrLookup.Found)?.pr

    private fun showInitializing() {
        removeAll()
        emptyLabel.text = "<html><center>Initializing Jolli Memory...</center></html>"
        add(emptyLabel, BorderLayout.CENTER)
        revalidate(); repaint()
    }

    // Shown when the service is initialized but hooks are not installed (or were
    // uninstalled). Distinct from showInitializing so users are not misled into
    // thinking a background task is still running — nothing is, until they enable.
    private fun showDisabled() {
        removeAll()
        emptyLabel.text = "<html><center>Jolli Memory is not enabled for this repository.<br/>" +
            "Open the Status panel to install hooks and enable it.</center></html>"
        add(emptyLabel, BorderLayout.CENTER)
        revalidate(); repaint()
    }

    private fun updateCommitList() {
        rowCount = commits.size
        onRowCountChanged?.invoke(rowCount)
        removeAll()
        listPanel.removeAll()
        commitRowStates.clear()

        if (commits.isEmpty()) {
            emptyLabel.text = "<html><center>Start coding — your commit memories will appear here.<br/>" +
                "Every commit on this branch will be automatically summarized.</center></html>"
            add(emptyLabel, BorderLayout.CENTER)
        } else {
            // Show at most [visibleCommits] rows; the rest hide behind a
            // "Show N more" row that reveals the next page on click.
            val shown = commits.take(visibleCommits)
            for (commit in shown) {
                val state = createCommitRow(commit)
                commitRowStates[commit.hash] = state
                listPanel.add(state.row)
                listPanel.add(state.fileContainer)
            }
            if (commits.size > visibleCommits) {
                val remaining = commits.size - visibleCommits
                listPanel.add(
                    CappedRows.showMoreRow(remaining) {
                        visibleCommits += CappedRows.CAP
                        updateCommitList()
                    },
                )
            }
            // Token-usage meter sits above the list; both share the sidebar's
            // single top-level scrollbar (no inner scrollbar here). Rendered at
            // natural height. Always shown — it reads "N/A" when no usage was
            // reported, so the panel's structure is consistent across projects.
            val totals = CommitMemoryFormat.aggregateTokens(commits)
            val north = JPanel().apply {
                layout = BoxLayout(this, BoxLayout.Y_AXIS)
                isOpaque = false
            }
            north.add(buildTokenMeter(totals))
            north.add(listPanel)
            add(north, BorderLayout.NORTH)
        }
        revalidate(); repaint()
    }

    override fun getMaximumSize(): java.awt.Dimension =
        java.awt.Dimension(Int.MAX_VALUE, preferredSize.height)

    // ─── Token meter ──────────────────────────────────────────────────────────

    /**
     * Branch token-usage meter: a bold total + a circled "?" that explains what's
     * counted, a 2-segment input/output bar, and a legend. Degraded by design —
     * the stored summaries carry only input/output totals (no cache split, no
     * per-conversation breakdown), and unreported sources are skipped — so the
     * "?" popover frames the number as a lower bound.
     */
    private fun buildTokenMeter(totals: BranchTokenTotals): JComponent {
        val dimFg = UIManager.getColor("Component.infoForeground") ?: Color.GRAY

        val totalLabel = JBLabel(if (totals.hasData) "${CommitMemoryFormat.formatTokens(totals.total)} tokens" else "N/A tokens").apply {
            font = font.deriveFont(java.awt.Font.BOLD)
        }
        val helpLabel = JLabel("?").apply {
            font = font.deriveFont(java.awt.Font.BOLD, font.size2D - 1f)
            foreground = dimFg
            border = javax.swing.BorderFactory.createCompoundBorder(
                RoundedLineBorder(dimFg, JBUI.scale(10)),
                JBUI.Borders.empty(0, 4),
            )
            toolTipText = "How this total is counted"
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) { showTokenInfoPopup(this@apply) }
            })
        }
        // Estimated USD cost next to the token total, priced per model at write
        // time (null when no contributing memory carried a priced estimate — then
        // the meter shows tokens only, never a misleading "≈$0.00").
        val costLabel: JComponent? = totals.estimatedCostUsd?.takeIf { totals.hasData }?.let { usd ->
            JBLabel("· ${CommitMemoryFormat.formatCost(usd)}").apply { foreground = dimFg }
        }
        val headerLine = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(6), 0)).apply {
            isOpaque = false
            alignmentX = Component.LEFT_ALIGNMENT
            add(totalLabel)
            if (costLabel != null) add(costLabel)
            if (totals.partial) {
                add(JBLabel("· partial").apply {
                    foreground = dimFg
                    font = font.deriveFont(font.size2D - 1f)
                })
            }
            add(helpLabel)
        }

        val inTok = totals.input
        val outTok = totals.output
        val cacheTok = totals.cached
        val bar = object : JPanel() {
            override fun paintComponent(g: Graphics) {
                super.paintComponent(g)
                val sum = (inTok + outTok + cacheTok).coerceAtLeast(1)
                val inW = ((width.toLong() * inTok) / sum).toInt()
                val outW = ((width.toLong() * outTok) / sum).toInt()
                g.color = TOK_INPUT_COLOR; g.fillRect(0, 0, inW, height)
                g.color = TOK_OUTPUT_COLOR; g.fillRect(inW, 0, outW, height)
                g.color = TOK_CACHE_COLOR; g.fillRect(inW + outW, 0, width - inW - outW, height)
            }
        }.apply {
            isOpaque = false
            alignmentX = Component.LEFT_ALIGNMENT
            preferredSize = Dimension(0, JBUI.scale(6))
            maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(6))
        }

        val legend = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(10), 0)).apply {
            isOpaque = false
            alignmentX = Component.LEFT_ALIGNMENT
            add(legendEntry(TOK_INPUT_COLOR, "${CommitMemoryFormat.formatTokens(totals.input)} input"))
            add(legendEntry(TOK_OUTPUT_COLOR, "${CommitMemoryFormat.formatTokens(totals.output)} output"))
            add(legendEntry(TOK_CACHE_COLOR, "${CommitMemoryFormat.formatTokens(totals.cached)} cached"))
        }

        return JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
            alignmentX = Component.LEFT_ALIGNMENT
            border = JBUI.Borders.empty(2, 4, 8, 4)
            add(headerLine)
            // Bar + legend only make sense with real numbers; the "N/A" header
            // stands alone when nothing was reported.
            if (totals.hasData) {
                add(Box.createVerticalStrut(JBUI.scale(3)))
                add(bar)
                add(Box.createVerticalStrut(JBUI.scale(2)))
                add(legend)
            }
            maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
        }
    }

    private fun legendEntry(color: Color, text: String): JComponent {
        val dot = object : JPanel() {
            override fun paintComponent(g: Graphics) {
                g.color = color
                g.fillOval(0, 0, width - 1, height - 1)
            }
        }.apply {
            isOpaque = false
            preferredSize = Dimension(JBUI.scale(8), JBUI.scale(8))
            maximumSize = Dimension(JBUI.scale(8), JBUI.scale(8))
        }
        val label = JBLabel(text).apply {
            font = font.deriveFont(font.size2D - 1f)
            foreground = UIManager.getColor("Component.infoForeground") ?: Color.GRAY
        }
        return JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(4), 0)).apply {
            isOpaque = false
            add(dot)
            add(label)
        }
    }

    private fun showTokenInfoPopup(anchor: JComponent) {
        val html = "<html><div style='width:240px'>Summed across memories whose source " +
            "reports token usage. Sources that don't report it (e.g. Cursor) aren't counted, " +
            "and cache tokens aren't tracked — so the real total is higher.</div></html>"
        com.intellij.openapi.ui.popup.JBPopupFactory.getInstance()
            .createHtmlTextBalloonBuilder(
                html,
                null,
                UIManager.getColor("ToolTip.background") ?: background,
                null,
            )
            .setHideOnClickOutside(true)
            .setHideOnKeyOutside(true)
            .createBalloon()
            .show(
                com.intellij.ui.awt.RelativePoint.getSouthOf(anchor),
                com.intellij.openapi.ui.popup.Balloon.Position.below,
            )
    }

    /** Small rounded status chip (PR / SYNCED / E2E) used on the collapsed row. */
    private fun chip(text: String, color: Color): JComponent = JLabel(text).apply {
        font = font.deriveFont(font.size2D - 2f)
        foreground = color
        border = javax.swing.BorderFactory.createCompoundBorder(
            RoundedLineBorder(color, JBUI.scale(8)),
            JBUI.Borders.empty(0, 4),
        )
    }

    /** "<relative time> · <shortHash> · <token spend>" for the collapsed row. */
    private fun buildSubLine(commit: CommitSummaryBrief): String {
        // Always present, so the row reads consistently even with no usage data.
        // Append the per-model cost estimate when this memory carries one.
        val tokenText = commit.conversationTokenBreakdown?.let { bd ->
            val total = bd.input + bd.output + bd.cached
            val base = "${CommitMemoryFormat.formatTokens(total)} tokens"
            commit.estimatedCostUsd?.let { "$base · ${CommitMemoryFormat.formatCost(it)}" } ?: base
        } ?: "N/A tokens"
        return listOf(formatShortRelativeDate(commit.date), commit.shortHash, tokenText).joinToString(" · ")
    }

    /**
     * Status chips (PR / SYNCED|LOCAL / E2E). PR is branch-level (same chip on
     * every memory row); SYNCED + E2E are per-commit. Built only for memory-bearing
     * rows. The expand toggle lives on its own line, not here.
     */
    private fun buildChipsRow(commit: CommitSummaryBrief): JComponent {
        // hgap 0 (+ explicit struts between chips) so there's no trailing gap after
        // the last chip — that lets the right edge land flush with the SHIPPED rows'
        // chips (NO PR / LOCAL), which use hgap 0 too. A FlowLayout hgap would add a
        // trailing gap and leave the chips a few px short of that edge.
        val row = JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply {
            isOpaque = false
            alignmentX = Component.LEFT_ALIGNMENT
            border = JBUI.Borders.empty()
        }
        val chips = mutableListOf<JComponent>()
        openPr()?.let { chips.add(chip("PR #${it.number}", CHIP_OK_COLOR)) }
        chips.add(
            if (commit.isSyncedToJolli) chip("SYNCED", CHIP_OK_COLOR) else chip("LOCAL", CHIP_DIM_COLOR),
        )
        if (commit.hasE2eGuide) chips.add(chip("E2E", CHIP_OK_COLOR))
        chips.forEachIndexed { i, c ->
            if (i > 0) row.add(Box.createHorizontalStrut(JBUI.scale(4)))
            row.add(c)
        }
        row.maximumSize = Dimension(Int.MAX_VALUE, row.preferredSize.height)
        return row
    }

    // ─── Row creation ─────────────────────────────────────────────────────────

    /**
     * Creates a commit row and its associated (initially hidden) file container:
     *   [▶/▼] [☐/☑] <message> [☁] [type] MM-DD  [👁]
     *
     * Layout: BorderLayout
     *   WEST   = arrow + checkbox (GridBagLayout)
     *   CENTER = message label (fills space, truncates with "...")
     *   EAST   = eye icon (FlowLayout.RIGHT)
     */
    private fun createCommitRow(commit: CommitSummaryBrief): CommitRowState {
        val singleMode = commits.size <= 1
        val hideCheckboxes = singleMode || isMerged

        // Expand/collapse arrow
        val arrowLabel = JLabel(ARROW_RIGHT).apply {
            font = font.deriveFont(10f)
            foreground = Color.GRAY
            border = JBUI.Borders.emptyRight(4)
        }

        // Checkbox (hidden in single-commit or merged mode)
        val checkbox: JCheckBox? = if (!hideCheckboxes) {
            JCheckBox("", commit.hash in checkedHashes).apply {
                isOpaque = false
                border = JBUI.Borders.empty()
                addActionListener { toggleCheckbox(commit) }
            }
        } else {
            null
        }

        // Left side: arrow + optional checkbox
        val leftPanel = JPanel(FlowLayout(FlowLayout.LEFT, 0, 0)).apply {
            isOpaque = false
            add(arrowLabel)
            if (checkbox != null) add(checkbox)
        }

        // Title line: commit message (+ pushed/type badges). Date/hash/tokens move
        // to the sub-line below so the title stays scannable.
        val displayMessage = commit.message.ifBlank { commit.shortHash }
        val pushedBadge = if (commit.isPushed) " \u2601" else ""
        val typeBadge = if (commit.commitType != null) " [${commit.commitType}]" else ""
        val titleLabel = JTextArea("$displayMessage$pushedBadge$typeBadge").apply {
            // Wrapping title so long commit messages wrap and grow the row instead of
            // clipping. Styled like a label at the mockup's 12px (base − 1).
            isEditable = false
            isFocusable = false
            isOpaque = false
            lineWrap = true
            wrapStyleWord = true
            margin = JBUI.insets(0)
            border = JBUI.Borders.empty()
            font = JBUI.Fonts.label().let { it.deriveFont(it.size2D - 1f) }
            alignmentX = Component.LEFT_ALIGNMENT
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        }

        // Sub-line: "<relative time> \u00b7 <shortHash> \u00b7 <token spend>".
        val dimFg = UIManager.getColor("Component.infoForeground") ?: Color.GRAY
        val subLabel = JLabel(buildSubLine(commit)).apply {
            foreground = dimFg
            // Mockup sub-line is ~10.5px (base − 2.5); base − 2 keeps it clearly
            // smaller than the title while still legible at the IDE's font scale.
            font = font.deriveFont(font.size2D - 2f)
            alignmentX = Component.LEFT_ALIGNMENT
        }

        // Status chips \u2014 always shown so the row structure is consistent across
        // projects (a code-only commit still reads NO PR / LOCAL). The expand
        // toggle is NOT here; it sits on its own last line below.
        val chipsRow: JComponent = buildChipsRow(commit)

        // "Show memory details \u25be" \u2014 always present, on its own right-aligned last
        // line of the collapsed row, mirroring the "Hide memory details \u25b4" link at
        // the bottom of the expanded section. Hidden while expanded.
        val detailsToggle: JComponent = run {
            val link = JLabel("Show memory details \u25be").apply {
                foreground = JBUI.CurrentTheme.Link.Foreground.ENABLED
                font = font.deriveFont(font.size2D - 1f)
                cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                addMouseListener(object : MouseAdapter() {
                    override fun mouseClicked(e: MouseEvent) {
                        if (SwingUtilities.isLeftMouseButton(e)) { e.consume(); toggleExpand(commit.hash) }
                    }
                })
            }
            JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply {
                isOpaque = false
                alignmentX = Component.LEFT_ALIGNMENT
                border = JBUI.Borders.empty(2, 4, 0, 0)
                add(link)
                maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
            }
        }

        val centerPanel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
            alignmentX = Component.LEFT_ALIGNMENT
            add(titleLabel)
            add(subLabel)
        }

        // Hover actions (memory rows only): Pin · Copy recall prompt · Share.
        // Hidden until the row is hovered; the row body still opens the memory on click.
        val rowActions: List<JLabel> = if (commit.hasSummary) {
            listOf(
                convoActionIcon(AllIcons.General.Pin_tab, "Pin to top of this branch") { pinMemory(commit) },
                convoActionIcon(AllIcons.Actions.Copy, "Copy recall prompt") { copyRecallPrompt(commit.hash) },
                convoActionIcon(JolliMemoryIcons.Share, "Share to your Jolli Space") { shareMemory(commit) },
            )
        } else {
            emptyList()
        }

        val rightPanel = JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply {
            isOpaque = false
            rowActions.forEach { add(it) }
        }

        // Title line: arrow/checkbox · title+sub · eye/more. Height tracks the wrapped
        // title at the current width (the title + sub stack in CENTER).
        val topLine = object : JPanel(BorderLayout(2, 0)) {
            override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)
            override fun getPreferredSize(): Dimension {
                val base = super.getPreferredSize()
                val w = width
                if (w <= 0) return base
                val ins = insets
                val cW = (w - ins.left - ins.right - leftPanel.preferredSize.width - rightPanel.preferredSize.width - 2 * 2)
                    .coerceAtLeast(JBUI.scale(20))
                titleLabel.setSize(cW, Short.MAX_VALUE.toInt())
                val centerH = titleLabel.preferredSize.height + subLabel.preferredSize.height
                val h = maxOf(centerH, leftPanel.preferredSize.height, rightPanel.preferredSize.height)
                return Dimension(base.width, h + ins.top + ins.bottom)
            }
        }.apply {
            isOpaque = false
            alignmentX = Component.LEFT_ALIGNMENT
            add(leftPanel, BorderLayout.WEST)
            add(centerPanel, BorderLayout.CENTER)
            add(rightPanel, BorderLayout.EAST)
        }

        // The row is a vertical stack so the chips + "Show memory details" rows
        // span the full width and right-align to the window edge (matching the
        // "Hide memory details" link at the bottom of the expanded section),
        // rather than being boxed inside the title's CENTER region.
        val row = object : JPanel() {
            // Height tracks content (the title wraps and grows topLine), so the max must
            // follow the current preferred height rather than a value fixed at build time.
            override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)
        }.apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = true
            border = JBUI.Borders.empty(2, 4)
            alignmentX = Component.LEFT_ALIGNMENT
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            add(topLine)
            add(chipsRow)
            add(detailsToggle)
        }
        // Re-wrap the title (recompute height) when the row width changes on resize.
        row.addComponentListener(object : java.awt.event.ComponentAdapter() {
            override fun componentResized(e: java.awt.event.ComponentEvent) { row.revalidate() }
        })
        // Hover: reveal the Pin/Copy/Share actions + the sticky hover popup
        // (1s show delay, 200ms hide grace). Hiding is bounds-checked so moving
        // between the row's children doesn't flicker the icons away.
        val hoverListener = object : MouseAdapter() {
            override fun mouseEntered(e: MouseEvent) {
                row.background = RowStyle.HOVER_BG
                row.repaint()
                rowActions.forEach { it.isVisible = true }
                scheduleShowHoverPopup(row, commit)
            }
            override fun mouseExited(e: MouseEvent) {
                val src = e.source as? Component ?: return
                val screen = src.locationOnScreen.apply { translate(e.x, e.y) }
                val loc = row.locationOnScreen
                if (!java.awt.Rectangle(loc.x, loc.y, row.width, row.height).contains(screen)) {
                    row.background = null
                    row.repaint()
                    rowActions.forEach { it.isVisible = false }
                }
                scheduleHoverDismiss()
            }
        }
        for (child in listOf(arrowLabel, titleLabel, subLabel, leftPanel, rightPanel, topLine, row)) {
            child.addMouseListener(hoverListener)
        }
        rowActions.forEach { it.addMouseListener(hoverListener) }

        // File container — initially hidden, shown on expand
        val fileContainer = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isVisible = false
            alignmentX = Component.LEFT_ALIGNMENT
        }

        val state = CommitRowState(
            row = row,
            fileContainer = fileContainer,
            arrowLabel = arrowLabel,
            checkbox = checkbox,
            isExpanded = false,
            detailsLoaded = false,
            detailsToggle = detailsToggle,
        )

        // Chevron click toggles expand/collapse only
        val chevronClickListener = object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (!SwingUtilities.isLeftMouseButton(e)) return
                e.consume()
                toggleExpand(commit.hash)
            }
        }
        arrowLabel.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        arrowLabel.addMouseListener(chevronClickListener)

        // Click anywhere else on the row opens the summary (matching VS Code behavior)
        val rowClickListener = object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (!SwingUtilities.isLeftMouseButton(e)) return
                if (commit.hasSummary) {
                    viewSummary(commit.hash)
                }
            }
        }
        for (child in listOf(titleLabel, subLabel, leftPanel, topLine, row)) {
            child.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            child.addMouseListener(rowClickListener)
        }

        row.maximumSize = Dimension(Int.MAX_VALUE, row.preferredSize.height)
        return state
    }

    /** Pins a committed memory to the Pinned section (row hover action). */
    private fun pinMemory(commit: CommitSummaryBrief) {
        val cwd = service.mainRepoRoot ?: project.basePath ?: return
        val title = commit.message.ifBlank { commit.shortHash }
        ai.jolli.jollimemory.core.telemetry.Telemetry.track("memory_pinned", mapOf("kind" to "memories"))
        ApplicationManager.getApplication().executeOnPooledThread {
            ai.jolli.jollimemory.core.PinStore.pin(cwd, "memories", commit.hash, title, "M")
            SwingUtilities.invokeLater { service.panelRegistry?.pinnedPanel?.refresh() }
        }
    }

    /**
     * Share this memory (row hover action). Mirrors VS Code's `shareMemory`: open (or focus)
     * the commit's detail webview, then reveal that view's inline share overlay — rather than a
     * separate dialog window. The overlay + its state machine live in the summary webview
     * ([SummaryPanel.openShare]).
     */
    private fun shareMemory(commit: CommitSummaryBrief) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val summary = service.getSummary(commit.hash)
            SwingUtilities.invokeLater {
                if (summary != null) {
                    val vFile = SummaryVirtualFile(summary)
                    val editors = com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project)
                        .openFile(vFile, true)
                    editors.filterIsInstance<SummaryFileEditor>().firstOrNull()?.requestOpenShare()
                } else {
                    com.intellij.openapi.ui.Messages.showInfoMessage(
                        project,
                        "No summary found for ${commit.hash.take(8)}",
                        "Share",
                    )
                }
            }
        }
    }

    /** Toggles the expand/collapse state of a commit's memory detail. */
    private fun toggleExpand(hash: String) {
        val state = commitRowStates[hash] ?: return
        state.isExpanded = !state.isExpanded
        ai.jolli.jollimemory.core.telemetry.Telemetry.track("memory_expanded", mapOf("expanded" to state.isExpanded))
        state.arrowLabel.text = if (state.isExpanded) ARROW_DOWN else ARROW_RIGHT
        state.fileContainer.isVisible = state.isExpanded
        // The "Show memory details" line only makes sense while collapsed; once
        // expanded, the "Hide memory details" link at the bottom takes over.
        state.detailsToggle?.isVisible = !state.isExpanded

        if (state.isExpanded && !state.detailsLoaded) {
            loadExpandedDetail(hash)
        }

        listPanel.revalidate()
        listPanel.repaint()
    }

    /**
     * Lazily loads a commit's memory detail on first expansion, deduplicating
     * in-flight reads. Fetches the full summary, its committed conversations, and
     * its changed files in one bundle (off-EDT), then renders the four grouped
     * sections — SHIPPED, CONVERSATIONS, CONTEXT, FILES — on the EDT.
     */
    private fun loadExpandedDetail(hash: String) {
        val state = commitRowStates[hash] ?: return

        state.fileContainer.removeAll()
        state.fileContainer.add(JLabel("Loading...").apply {
            foreground = Color.GRAY
            border = JBUI.Borders.empty(2, 28)
            alignmentX = Component.LEFT_ALIGNMENT
        })
        state.fileContainer.revalidate()

        // computeIfAbsent is atomic on ConcurrentHashMap, so concurrent expands
        // share a single in-flight bundle per hash.
        val future = detailCache.computeIfAbsent(hash) {
            CompletableFuture.supplyAsync(
                {
                    val summary = service.getSummary(hash)
                    ExpansionDetail(
                        summary = summary,
                        conversations = gatherConversations(hash, summary),
                        files = service.listCommitFiles(hash),
                    )
                },
                { cmd -> ApplicationManager.getApplication().executeOnPooledThread(cmd) },
            )
        }

        future.whenComplete { detail, error ->
            if (error != null) detailCache.remove(hash)
            SwingUtilities.invokeLater {
                val currentState = commitRowStates[hash] ?: return@invokeLater
                val commit = commits.firstOrNull { it.hash == hash } ?: return@invokeLater
                currentState.fileContainer.removeAll()
                if (error != null || detail == null) {
                    currentState.fileContainer.add(JLabel("(failed to load)").apply {
                        foreground = Color.GRAY
                        border = JBUI.Borders.empty(2, 28)
                        alignmentX = Component.LEFT_ALIGNMENT
                    })
                } else {
                    renderExpandedGroups(currentState.fileContainer, commit, detail)
                }
                currentState.detailsLoaded = error == null
                currentState.fileContainer.revalidate()
                currentState.fileContainer.repaint()
            }
        }
    }

    /**
     * Conversations for a committed memory, with a squash fallback: if the commit
     * has no transcript of its own (older squashed memories whose transcripts were
     * never merged onto the new hash), aggregate the transcripts of its child
     * commits instead. Dedupes by session, summing per-commit message counts.
     */
    private fun gatherConversations(hash: String, summary: CommitSummary?): List<ConversationBrief> {
        val own = service.getCommittedConversations(hash, summary)
        if (own.isNotEmpty() || summary?.children.isNullOrEmpty()) return own

        val merged = LinkedHashMap<String, ConversationBrief>()
        fun collect(s: CommitSummary?) {
            s?.children?.forEach { child ->
                for (c in service.getCommittedConversations(child.commitHash, child)) {
                    // Remember which child commit owns this transcript so the stored-markdown
                    // fallback in openCommittedConversation reads from the right hash, not the
                    // squashed parent (which has no transcript of its own).
                    val cc = if (c.sourceCommitHash == null) c.copy(sourceCommitHash = child.commitHash) else c
                    val key = cc.sessionId.ifBlank { "${cc.source}|${cc.title}" }
                    val existing = merged[key]
                    merged[key] = existing?.copy(messageCount = existing.messageCount + cc.messageCount) ?: cc
                }
                collect(child) // nested squashes
            }
        }
        collect(summary)
        return merged.values.toList()
    }

    /**
     * Builds the SHIPPED / CONVERSATIONS / CONTEXT / FILES groups into [container].
     * All four sections always render (with a count in the header and an empty-state
     * row when there's nothing) so the structure is identical across projects —
     * a memory-less commit just shows every section in its not-available state.
     */
    private fun renderExpandedGroups(container: JPanel, commit: CommitSummaryBrief, detail: ExpansionDetail) {
        val summary = detail.summary

        // ── SHIPPED ──────────────────────────────────────────────────────────
        // Always three shipping signals (PR, E2E test guide, Synced to Jolli).
        // Done items are actionable (green icon, link out); not-yet-done items
        // render dim with a "todo" chip so the gaps are visible.
        val shippedRows = mutableListOf<JComponent>()
        val pr = openPr()
        if (pr != null) {
            shippedRows.add(detailRow(stateIcon(JolliMemoryIcons.PullRequest, true), "Pull request #${pr.number} — open", chip("OPEN", CHIP_OK_COLOR)) {
                BrowserUtil.browse(pr.url)
            })
        } else {
            shippedRows.add(detailRow(stateIcon(JolliMemoryIcons.PullRequest, false), "Pull request — not created yet", chip("NO PR", CHIP_DIM_COLOR), dim = true) {
                if (commit.hasSummary) viewSummary(commit.hash)
            })
        }
        if (commit.hasE2eGuide) {
            val n = commit.e2eScenarioCount
            shippedRows.add(detailRow(stateIcon(AllIcons.RunConfigurations.TestState.Green2, true), "E2E test guide — $n scenario${if (n != 1) "s" else ""}", null) {
                viewSummary(commit.hash)
            })
        } else {
            shippedRows.add(detailRow(stateIcon(AllIcons.RunConfigurations.TestState.Green2, false), "E2E test guide — not generated yet", null, dim = true) {
                if (commit.hasSummary) viewSummary(commit.hash)
            })
        }
        if (commit.isSyncedToJolli) {
            val url = commit.jolliDocUrl ?: summary?.jolliDocUrl
            shippedRows.add(detailRow(stateIcon(AllIcons.Actions.Refresh, true), "Synced to Jolli — open article", chip("SYNCED", CHIP_OK_COLOR)) {
                if (url != null) BrowserUtil.browse(url)
            })
        } else {
            shippedRows.add(detailRow(stateIcon(AllIcons.Actions.Refresh, false), "Not synced to Jolli yet", chip("LOCAL", CHIP_DIM_COLOR), dim = true) {
                if (commit.hasSummary) viewSummary(commit.hash)
            })
        }
        addGroup(container, "SHIPPED", shippedRows.size, shippedRows)

        // ── CONVERSATIONS ──────────────────────────────────────────────────────
        val convoRows = mutableListOf<JComponent>()
        for (c in detail.conversations) convoRows.add(conversationRow(commit, c))
        if (convoRows.isEmpty()) {
            val turns = commit.conversationTurns ?: summary?.conversationTurns
            convoRows.add(
                if (turns != null && turns > 0) plainDetailRow("$turns conversation turn${if (turns != 1) "s" else ""} (details not stored)")
                else plainDetailRow("No conversations"),
            )
        }
        addGroup(container, "CONVERSATIONS", detail.conversations.size, convoRows)

        // ── CONTEXT (plans / notes / references) ───────────────────────────────
        val contextRows = mutableListOf<JComponent>()
        summary?.plans?.forEach { p ->
            contextRows.add(contextRow("P", p.title, isLink = false) {
                trackItemOpened("plan")
                openArchivedMarkdown(commit, p.title) { service.readArchivedPlan(p.slug) }
            })
        }
        summary?.notes?.forEach { n ->
            val tag = if (n.format == NoteFormat.snippet) "S" else "N"
            contextRows.add(contextRow(tag, n.title, isLink = false) {
                trackItemOpened("note")
                if (n.format == NoteFormat.snippet && n.content != null) {
                    openMarkdownContent(n.content, n.title)
                } else {
                    openArchivedMarkdown(commit, n.title) { service.readArchivedNote(n.id) }
                }
            })
        }
        summary?.references?.forEach { ref ->
            val url = ref.url?.ifBlank { null }
            contextRows.add(contextRow(referenceTag(ref.source), ref.title, isLink = url != null) {
                trackItemOpened("reference")
                if (url != null) BrowserUtil.browse(url) else if (commit.hasSummary) viewSummary(commit.hash)
            })
        }
        val contextCount = contextRows.size
        if (contextRows.isEmpty()) contextRows.add(plainDetailRow("No linked context"))
        addGroup(container, "CONTEXT", contextCount, contextRows)

        // ── FILES ──────────────────────────────────────────────────────────────
        val fileRows = detail.files.map { createFileRow(commit.hash, it) }
        addGroup(container, "FILES", detail.files.size, fileRows.ifEmpty { listOf(plainDetailRow("No files")) })

        // "Hide memory details ▴" — always the last line of the expanded section.
        val hideLink = JLabel("Hide memory details ▴").apply {
            foreground = JBUI.CurrentTheme.Link.Foreground.ENABLED
            font = font.deriveFont(font.size2D - 1f)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    if (SwingUtilities.isLeftMouseButton(e)) toggleExpand(commit.hash)
                }
            })
        }
        container.add(JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply {
            isOpaque = false
            alignmentX = Component.LEFT_ALIGNMENT
            border = JBUI.Borders.empty(2, 4, 2, 4)
            add(hideLink)
            maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
        })
    }

    /** A bold, dim group header ("SHIPPED (3)") + its rows, indented under the commit. */
    private fun addGroup(container: JPanel, title: String, count: Int, rows: List<JComponent>) {
        if (container.componentCount > 0) {
            container.add(JSeparator().apply {
                alignmentX = Component.LEFT_ALIGNMENT
                maximumSize = Dimension(Int.MAX_VALUE, 1)
            })
        }
        container.add(JBLabel("$title ($count)").apply {
            foreground = UIManager.getColor("Component.infoForeground") ?: Color.GRAY
            font = font.deriveFont(java.awt.Font.BOLD, font.size2D - 1f)
            border = JBUI.Borders.empty(4, 24, 1, 4)
            alignmentX = Component.LEFT_ALIGNMENT
        })
        for (r in rows) {
            r.alignmentX = Component.LEFT_ALIGNMENT
            container.add(r)
        }
    }

    /**
     * A SHIPPED-style row: status dot + label + optional trailing chip. Dim text
     * marks a not-yet-done item; a non-null [onClick] makes the row clickable
     * (hand cursor), so "todo" rows with nothing to open stay inert.
     */
    private fun detailRow(
        icon: javax.swing.Icon,
        text: String,
        trailing: JComponent?,
        dim: Boolean = false,
        onClick: (() -> Unit)? = null,
    ): JComponent {
        val iconWrap = RowStyle.vCenter(JLabel(icon))
        val textArea = wrappingTitleArea(text).apply {
            if (dim) foreground = CHIP_DIM_COLOR
            if (onClick == null) cursor = Cursor.getDefaultCursor()
        }
        val east = trailing?.let { RowStyle.vCenter(JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply { isOpaque = false; add(it) }) }
        val row = wrappingRow(iconWrap, textArea, east, leftIndent = 24)
        if (onClick != null) {
            val click = object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    if (e.clickCount == 1) { trackItemOpened("shipped"); onClick() }
                }
            }
            textArea.addMouseListener(click); row.addMouseListener(click)
        }
        attachRowHoverBar(row, listOfNotNull(textArea, iconWrap, east))
        return row
    }

    /** Records that an item inside a memory was opened (conversation/file/context/shipped). */
    private fun trackItemOpened(itemType: String) {
        ai.jolli.jollimemory.core.telemetry.Telemetry.track("memory_item_opened", mapOf("item_type" to itemType))
    }

    /** A label-styled, word-wrapping title for sub-section rows. */
    private fun wrappingTitleArea(text: String): JTextArea = JTextArea(text).apply {
        isEditable = false
        isFocusable = false
        isOpaque = false
        lineWrap = true
        wrapStyleWord = true
        margin = JBUI.insets(0)
        border = JBUI.Borders.empty()
        font = JBUI.Fonts.label()
        foreground = UIManager.getColor("Label.foreground") ?: foreground
        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
    }

    /**
     * A BorderLayout sub-section row whose height tracks the wrapped [title] at the
     * current width. [west]/[east] (badge/tag/actions) stay vertically centered; their
     * widths are reserved so the title's wrap width — and the row height — are stable.
     */
    private fun wrappingRow(west: JComponent?, title: JTextArea, east: JComponent?, leftIndent: Int): JPanel {
        val gap = JBUI.scale(4)
        val row = object : JPanel(BorderLayout(gap, 0)) {
            override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)
            override fun getPreferredSize(): Dimension {
                val base = super.getPreferredSize()
                val w = width
                if (w <= 0) return base
                val ins = insets
                val wW = west?.preferredSize?.width ?: 0
                val eW = east?.preferredSize?.width ?: 0
                val gaps = gap * listOfNotNull(west, east).size
                val tW = (w - ins.left - ins.right - wW - eW - gaps).coerceAtLeast(JBUI.scale(20))
                title.setSize(tW, Short.MAX_VALUE.toInt())
                val cH = maxOf(
                    title.preferredSize.height,
                    west?.preferredSize?.height ?: 0,
                    east?.preferredSize?.height ?: 0,
                    JBUI.scale(16),
                )
                return Dimension(w, cH + ins.top + ins.bottom)
            }
        }.apply {
            isOpaque = false
            border = JBUI.Borders.empty(1, leftIndent, 1, 4)
            alignmentX = Component.LEFT_ALIGNMENT
            if (west != null) add(west, BorderLayout.WEST)
            add(title, BorderLayout.CENTER)
            if (east != null) add(east, BorderLayout.EAST)
        }
        row.addComponentListener(object : java.awt.event.ComponentAdapter() {
            override fun componentResized(e: java.awt.event.ComponentEvent) { row.revalidate() }
        })
        return row
    }

    /**
     * Adds the shared translucent hover bar to an expanded sub-section row (the row is
     * transparent until hovered). Attached to the row + its children so the bar shows
     * regardless of which child the pointer enters; the exit is bounds-checked against
     * the row so moving between children doesn't flicker it.
     */
    private fun attachRowHoverBar(row: JPanel, children: List<Component>) {
        val hover = object : MouseAdapter() {
            override fun mouseEntered(e: MouseEvent) {
                row.isOpaque = true
                row.background = RowStyle.HOVER_BG
                row.repaint()
            }
            override fun mouseExited(e: MouseEvent) {
                val src = e.source as? Component ?: return
                if (src.isShowing && row.isShowing) {
                    val screen = src.locationOnScreen.apply { translate(e.x, e.y) }
                    val loc = row.locationOnScreen
                    if (java.awt.Rectangle(loc.x, loc.y, row.width, row.height).contains(screen)) return
                }
                row.isOpaque = false
                row.background = null
                row.repaint()
            }
        }
        row.addMouseListener(hover)
        children.forEach { it.addMouseListener(hover) }
    }

    /**
     * SHIPPED-row leading icon: the type icon (PR / sync / E2E tick) at full
     * strength when the step is done, or its greyed-out (disabled) variant when
     * it's still a todo — so the icon itself reads done vs not-done.
     */
    private fun stateIcon(base: javax.swing.Icon, done: Boolean): javax.swing.Icon =
        if (done) base else com.intellij.openapi.util.IconLoader.getDisabledIcon(base)

    /**
     * A CONVERSATIONS row: per-source logo (badge fallback) + derived title, with
     * the message count on the right that swaps to Open (eye) + Continue (play)
     * action icons on hover. Clicking the row opens the conversation content.
     */
    private fun conversationRow(commit: CommitSummaryBrief, c: ConversationBrief): JComponent {
        val badge = SourceBadge.leadFor(c.source)
        val title = wrappingTitleArea(c.title)
        val count = JLabel("${c.messageCount} msg${if (c.messageCount != 1) "s" else ""}").apply {
            foreground = UIManager.getColor("Component.infoForeground") ?: Color.GRAY
            font = font.deriveFont(font.size2D - 1f)
        }

        // Hover actions (hidden until hover): Open conversation · Resume (only if local session exists).
        val openBtn = convoActionIcon(JolliMemoryIcons.Eye, "Open conversation") { _ -> openCommittedConversation(commit, c) }
        val fileExists = !c.transcriptPath.isNullOrBlank() && File(c.transcriptPath).exists()
        val canResume = TerminalUtils.canResumeSource(c.source) && fileExists
        log.info("conversationRow: source=${c.source}, sessionId=${c.sessionId}, transcriptPath=${c.transcriptPath}, fileExists=$fileExists, canResume=$canResume")
        val actions = if (canResume) {
            val continueBtn = convoActionIcon(AllIcons.Actions.Execute, "Resume session in terminal") { _ ->
                log.info("continueBtn clicked: sessionId=${c.sessionId}, commitHash=${commit.hash}")
                resumeInTerminal(c.source, c.sessionId)
            }
            listOf(openBtn, continueBtn)
        } else {
            listOf(openBtn)
        }
        val eastInner = JPanel(FlowLayout(FlowLayout.RIGHT, JBUI.scale(2), 0)).apply {
            isOpaque = false
            add(count)
            actions.forEach { add(it) }
        }
        // Reserve the wider of the count vs hover-actions widths so the title's wrap
        // width (and the row height) stay stable when they swap on hover.
        count.isVisible = false; actions.forEach { it.isVisible = true }
        val actionsW = eastInner.preferredSize.width
        count.isVisible = true; actions.forEach { it.isVisible = false }
        val reservedEastW = maxOf(actionsW, eastInner.preferredSize.width)
        val west = RowStyle.vCenter(badge)
        val east = RowStyle.vCenter(eastInner).apply {
            preferredSize = Dimension(reservedEastW, JBUI.scale(16))
            minimumSize = Dimension(reservedEastW, 0)
        }
        val row = wrappingRow(west, title, east, leftIndent = 24)

        // Swap count ↔ actions on hover; bounds-check on exit so moving onto the
        // action icons (still inside the row) doesn't flicker them away.
        val hover = object : MouseAdapter() {
            override fun mouseEntered(e: MouseEvent) {
                row.isOpaque = true
                row.background = RowStyle.HOVER_BG
                row.repaint()
                count.isVisible = false
                actions.forEach { it.isVisible = true }
            }
            override fun mouseExited(e: MouseEvent) {
                val src = e.source as Component
                fun clear() {
                    row.isOpaque = false
                    row.background = null
                    row.repaint()
                    count.isVisible = true
                    actions.forEach { it.isVisible = false }
                }
                if (!src.isShowing || !row.isShowing) {
                    clear()
                    return
                }
                val screen = src.locationOnScreen.apply { translate(e.x, e.y) }
                val loc = row.locationOnScreen
                if (!java.awt.Rectangle(loc.x, loc.y, row.width, row.height).contains(screen)) {
                    clear()
                }
            }
        }
        val click = object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (SwingUtilities.isLeftMouseButton(e)) openCommittedConversation(commit, c)
            }
        }
        for (cc in listOf(row, west, badge, title)) {
            cc.addMouseListener(hover)
            cc.addMouseListener(click)
        }
        for (cc in listOf(eastInner, count)) cc.addMouseListener(hover)
        actions.forEach { it.addMouseListener(hover) }
        return row
    }

    /** A hover-revealed action icon for conversation rows. */
    private fun convoActionIcon(icon: javax.swing.Icon, tip: String, onClick: (Component) -> Unit): JLabel =
        JLabel(icon).apply {
            toolTipText = tip
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            border = JBUI.Borders.empty(0, 2)
            isVisible = false
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    if (SwingUtilities.isLeftMouseButton(e)) { e.consume(); onClick(e.component) }
                }
            })
        }

    /**
     * Opens a committed conversation's content by reusing the live conversation
     * viewer ([ConversationVirtualFile]). Needs the stored session's source +
     * transcript path; degrades to a message when the original file isn't
     * recorded / resolvable.
     */
    private fun openCommittedConversation(commit: CommitSummaryBrief, c: ConversationBrief) {
        val cwd = service.mainRepoRoot ?: project.basePath ?: return
        val source = TranscriptSource.entries.firstOrNull { it.name == c.source }
        val path = c.transcriptPath
        // The live transcript file may be gone (deleted / never recorded). When it can't
        // be opened, render the conversation stored in the memory itself (read-only),
        // falling back to the commit memory only if even that isn't available.
        if (source == null || path.isNullOrBlank() || !File(path).exists()) {
            ai.jolli.jollimemory.core.telemetry.Telemetry.track(
                "memory_item_opened",
                mapOf("item_type" to "conversation", "render" to "stored", "source" to c.source),
            )
            ApplicationManager.getApplication().executeOnPooledThread {
                // For squashed memories the transcript lives on the child commit, not the
                // displayed parent — read from sourceCommitHash when present.
                val md = service.readCommittedConversationMarkdown(c.sourceCommitHash ?: commit.hash, c.sessionId)
                SwingUtilities.invokeLater {
                    when {
                        md != null -> openMarkdownContent(md, c.title)
                        commit.hasSummary -> viewSummary(commit.hash)
                        else -> com.intellij.openapi.ui.Messages.showInfoMessage(
                            project,
                            "The conversation for this memory isn't available to open.",
                            "Open Conversation",
                        )
                    }
                }
            }
            return
        }
        ai.jolli.jollimemory.core.telemetry.Telemetry.track(
            "memory_item_opened",
            mapOf("item_type" to "conversation", "render" to "live", "source" to c.source),
        )
        val item = ActiveConversationItem(
            sessionId = c.sessionId,
            source = source,
            title = c.title,
            messageCount = c.messageCount,
            updatedAt = "",
            transcriptPath = path,
            isSelected = true,
        )
        com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project)
            .openFile(ConversationVirtualFile(item, cwd), true)
    }

    /**
     * A CONTEXT row: a small kind tag (P / N / L / GH …) + wrapping title. Clicking runs
     * [onClick] (open the plan/note body or the reference link). [isLink] styles the
     * title as a link.
     */
    private fun contextRow(tag: String, title: String, isLink: Boolean, onClick: () -> Unit): JComponent {
        val tagLabel = chip(tag, CHIP_DIM_COLOR)
        val titleArea = wrappingTitleArea(title).apply {
            if (isLink) foreground = JBUI.CurrentTheme.Link.Foreground.ENABLED
        }
        val west = RowStyle.vCenter(JPanel(FlowLayout(FlowLayout.LEFT, 0, 0)).apply { isOpaque = false; add(tagLabel) })
        val row = wrappingRow(west, titleArea, east = null, leftIndent = 24)
        val click = object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 1 && SwingUtilities.isLeftMouseButton(e)) onClick()
            }
        }
        titleArea.addMouseListener(click); row.addMouseListener(click)
        attachRowHoverBar(row, listOf(tagLabel, titleArea, west))
        return row
    }

    /** Opens markdown [content] read-only in a preview editor (in-memory, no disk file). */
    private fun openMarkdownContent(content: String, name: String) {
        val safeName = if (name.endsWith(".md")) name else "$name.md"
        val vf = com.intellij.testFramework.LightVirtualFile(safeName, content).apply { isWritable = false }
        MarkdownPreview.open(project, vf)
    }

    /**
     * Reads an archived plan/note body from committed-memory storage (off the EDT) and
     * opens it read-only; falls back to the commit memory if the body isn't found.
     */
    private fun openArchivedMarkdown(commit: CommitSummaryBrief, title: String, read: () -> String?) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val body = read()
            SwingUtilities.invokeLater {
                if (body != null) {
                    openMarkdownContent(body, title)
                } else if (commit.hasSummary) {
                    viewSummary(commit.hash)
                }
            }
        }
    }

    /** A plain indented detail row (fallbacks / placeholders). */
    private fun plainDetailRow(text: String): JComponent = JLabel(text).apply {
        foreground = UIManager.getColor("Component.infoForeground") ?: Color.GRAY
        border = JBUI.Borders.empty(1, 28, 1, 4)
        alignmentX = Component.LEFT_ALIGNMENT
    }

    /** Single-letter context tag for an external reference source. */
    private fun referenceTag(source: ai.jolli.jollimemory.core.references.SourceId): String = when (source) {
        ai.jolli.jollimemory.core.references.SourceId.linear -> "L"
        ai.jolli.jollimemory.core.references.SourceId.jira -> "J"
        ai.jolli.jollimemory.core.references.SourceId.github -> "GH"
        ai.jolli.jollimemory.core.references.SourceId.notion -> "No"
        ai.jolli.jollimemory.core.references.SourceId.slack -> "S"
    }

    /**
     * Creates a file row (indented under its commit):
     *   [file-icon] filename  relativePath  [M]
     *
     * Layout: BorderLayout
     *   CENTER = icon + filename + path (GridBagLayout, path fills remaining space)
     *   EAST   = status badge (FlowLayout.RIGHT)
     */
    private fun createFileRow(commitHash: String, file: CommitFileInfo): JPanel {
        val fileName = File(file.relativePath).name
        val fileIcon = FileTypeManager.getInstance().getFileTypeByFileName(fileName).icon

        val iconLabel = JLabel(fileIcon).apply {
            border = JBUI.Borders.emptyRight(4)
        }

        // Filename (line 1, status-colored) + relative path (line 2, grey) — always two
        // lines so long paths are readable; each ellipsizes when too narrow. Matches the
        // WORKING MEMORY Files rows.
        val nameLabel = JLabel(fileName).apply {
            foreground = statusColor(file.statusCode)
            minimumSize = Dimension(0, preferredSize.height)
            alignmentX = Component.LEFT_ALIGNMENT
        }
        val pathLabel = JLabel(file.relativePath).apply {
            foreground = Color.GRAY
            font = font.deriveFont(font.size2D - 1f)
            minimumSize = Dimension(0, preferredSize.height)
            alignmentX = Component.LEFT_ALIGNMENT
        }
        val centerPanel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
            add(nameLabel)
            add(pathLabel)
        }
        val iconWrap = RowStyle.vCenter(iconLabel)

        // Right side: status badge, vertically centered.
        val statusLabel = JLabel(file.statusCode).apply {
            foreground = statusColor(file.statusCode)
            border = JBUI.Borders.emptyRight(4)
        }
        val rightWrap = RowStyle.vCenter(JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply { isOpaque = false; add(statusLabel) })

        val row = JPanel(BorderLayout(JBUI.scale(4), 0)).apply {
            isOpaque = false
            // Indent file rows under their parent commit
            border = JBUI.Borders.empty(1, 24, 1, 4)
            alignmentX = Component.LEFT_ALIGNMENT
            add(iconWrap, BorderLayout.WEST)
            add(centerPanel, BorderLayout.CENTER)
            add(rightWrap, BorderLayout.EAST)
            toolTipText = file.relativePath
        }

        // Click opens diff
        val diffClickListener = object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 1) openCommitFileDiff(commitHash, file)
            }
        }
        for (child in listOf(iconLabel, nameLabel, pathLabel, statusLabel, row)) {
            child.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            child.addMouseListener(diffClickListener)
        }
        attachRowHoverBar(row, listOf(iconLabel, nameLabel, pathLabel, statusLabel, centerPanel, iconWrap, rightWrap))

        row.maximumSize = Dimension(Int.MAX_VALUE, row.preferredSize.height)
        return row
    }

    // ─── Actions ──────────────────────────────────────────────────────────────

    /**
     * Opens IntelliJ's built-in diff viewer comparing the file before and after
     * the given commit (parent..commit), like VS Code's inline change view.
     * - Added files (A): empty -> commit content
     * - Deleted files (D): parent content -> empty
     * - Modified/Renamed files: parent content -> commit content
     */
    private fun openCommitFileDiff(commitHash: String, file: CommitFileInfo) {
        ai.jolli.jollimemory.core.telemetry.Telemetry.track(
            "memory_item_opened",
            mapOf("item_type" to "file", "status" to file.statusCode),
        )
        ApplicationManager.getApplication().executeOnPooledThread {
            val gitOps = service.getGitOps() ?: return@executeOnPooledThread

            // Content before the commit (from parent)
            val beforePath = file.oldPath ?: file.relativePath
            val beforeContent = when (file.statusCode) {
                "A" -> ""
                else -> gitOps.exec("show", "$commitHash~1:$beforePath") ?: ""
            }

            // Content after the commit
            val afterContent = when (file.statusCode) {
                "D" -> ""
                else -> gitOps.exec("show", "$commitHash:${file.relativePath}") ?: ""
            }

            val fileName = File(file.relativePath).name
            val fileType = FileTypeManager.getInstance().getFileTypeByFileName(fileName)
            val shortHash = commitHash.take(8)

            SwingUtilities.invokeLater {
                val contentFactory = DiffContentFactory.getInstance()
                val leftContent = contentFactory.create(project, beforeContent, fileType)
                val rightContent = contentFactory.create(project, afterContent, fileType)

                val request = SimpleDiffRequest(
                    "${file.relativePath} ($shortHash)",
                    leftContent,
                    rightContent,
                    "$shortHash~1",
                    shortHash,
                )
                DiffManager.getInstance().showDiff(project, request)
            }
        }
    }

    /**
     * Opens the most recent committed memory's detail view (the webview that hosts
     * the Create PR flow). Mirrors the row's "⋯ → Create PR" menu item, but for the
     * branch's latest memory — used by the bottom action bar's Create PR button.
     * Returns false if there is no committed memory on the branch yet.
     */
    fun openMostRecentMemory(): Boolean {
        val target = commits.firstOrNull { it.hasSummary } ?: return false
        viewSummary(target.hash)
        return true
    }

    /**
     * Opens the dedicated branch-level Create PR webview (matches the design mockup).
     * Builds the view model off the EDT (git/gh), then opens the editor tab — or shows
     * the "commit first" hint when the branch has no committed memories.
     */
    fun openCreatePrView() {
        ApplicationManager.getApplication().executeOnPooledThread {
            val vm = ai.jolli.jollimemory.toolwindow.views.CreatePrData.build(project)
            SwingUtilities.invokeLater {
                if (vm == null) {
                    com.intellij.openapi.ui.Messages.showInfoMessage(
                        project,
                        "No committed memory on this branch yet. Commit first, then create a PR.",
                        "Create PR",
                    )
                } else {
                    com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project)
                        .openFile(CreatePrVirtualFile(vm), true)
                }
            }
        }
    }

    private fun viewSummary(commitHash: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val summary = service.getSummary(commitHash)
            SwingUtilities.invokeLater {
                if (summary != null) {
                    val vFile = SummaryVirtualFile(summary)
                    com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(vFile, true)
                } else {
                    JOptionPane.showMessageDialog(
                        this, "No summary found for ${commitHash.take(8)}",
                        "Commit Memory", JOptionPane.INFORMATION_MESSAGE,
                    )
                }
            }
        }
    }



    // ─── Foreign mode ──────────────────────────────────────────────────────

    /** Whether the panel is currently in foreign (read-only) mode. */
    val isForeignMode: Boolean get() = foreignRepo != null

    /**
     * Switches to foreign read-only mode, showing memories from a different repo/branch.
     * Data comes from [KBDataCache] rather than git.
     */
    fun setForeignMode(repo: String, branch: String) {
        refreshVersion++
        foreignRepo = repo
        foreignBranch = branch
        foreignEntries = KBDataCache.all()
            .filter { it.repo == repo && it.branch == branch && it.type == "commit" }
            .sortedByDescending { it.date ?: "" }
        SwingUtilities.invokeLater { updateForeignList() }
    }

    /** Exits foreign mode and restores normal commit view. */
    fun clearForeignMode() {
        if (foreignRepo == null) return
        foreignRepo = null
        foreignBranch = null
        foreignEntries = emptyList()
        refresh()
    }

    private fun updateForeignList() {
        rowCount = foreignEntries.size
        onRowCountChanged?.invoke(rowCount)
        removeAll()
        listPanel.removeAll()
        commitRowStates.clear()

        if (foreignEntries.isEmpty()) {
            emptyLabel.text = "<html><center>No memories found for " +
                "${escHtml(foreignRepo ?: "")} / ${escHtml(foreignBranch ?: "")}.</center></html>"
            add(emptyLabel, BorderLayout.CENTER)
        } else {
            // Banner
            val banner = JBLabel(
                "Viewing memories from ${foreignRepo} / ${foreignBranch} (read-only)",
            ).apply {
                foreground = Color.GRAY
                border = JBUI.Borders.empty(2, 4, 6, 4)
            }
            banner.alignmentX = Component.LEFT_ALIGNMENT
            listPanel.add(banner)

            for (entry in foreignEntries) {
                listPanel.add(createForeignMemoryRow(entry))
            }
            add(listPanel, BorderLayout.NORTH)
        }
        revalidate(); repaint()
    }

    /**
     * Creates a read-only row for a foreign memory entry:
     *   [eye-icon] <title>         <relative date> [copy-icon]
     */
    private fun createForeignMemoryRow(entry: KBDataCache.KBEntry): JPanel {
        val iconLabel = JLabel(JolliMemoryIcons.Eye)

        val messageLabel = JLabel(entry.title ?: "(untitled)").apply {
            minimumSize = Dimension(0, preferredSize.height)
        }

        val dateLabel = JLabel(formatShortRelativeDate(entry.date ?: "")).apply {
            foreground = Color.GRAY
        }

        val copyLabel = JLabel(AllIcons.Actions.Copy).apply {
            toolTipText = "Copy recall prompt"
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    copyRecallPromptForBranch(entry.branch ?: "")
                }
            })
        }

        val leftPanel = JPanel(GridBagLayout()).apply {
            isOpaque = false
            val gbc = GridBagConstraints().apply {
                gridy = 0; anchor = GridBagConstraints.WEST
                fill = GridBagConstraints.NONE; weighty = 1.0
            }
            gbc.gridx = 0; gbc.weightx = 0.0; gbc.insets = JBUI.insetsRight(6)
            add(iconLabel, gbc)
            gbc.gridx = 1; gbc.weightx = 1.0; gbc.fill = GridBagConstraints.HORIZONTAL
            gbc.insets = JBUI.emptyInsets()
            add(messageLabel, gbc)
        }

        val rightPanel = JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply {
            isOpaque = false
            add(dateLabel)
            add(Box.createHorizontalStrut(JBUI.scale(8)))
            add(copyLabel)
        }

        val row = JPanel(BorderLayout()).apply {
            isOpaque = true
            border = JBUI.Borders.empty(4, 8)
            alignmentX = Component.LEFT_ALIGNMENT
            add(leftPanel, BorderLayout.CENTER)
            add(rightPanel, BorderLayout.EAST)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        }

        // Click opens summary (reads from KB folder)
        val clickListener = object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 1) viewForeignSummary(entry)
            }
        }
        for (child in listOf(iconLabel, messageLabel, dateLabel, leftPanel, row)) {
            child.addMouseListener(clickListener)
        }

        row.maximumSize = Dimension(Int.MAX_VALUE, row.preferredSize.height)
        return row
    }

    /** Opens a foreign memory's summary by reading from the KB folder JSON. */
    private fun viewForeignSummary(entry: KBDataCache.KBEntry) {
        ApplicationManager.getApplication().executeOnPooledThread {
            // Try to extract commit hash from the file path (format: <slug>-<hash8>.md or summaries/<hash>.json)
            val jsonPath = entry.kbRoot.resolve(".jolli").resolve("summaries")
            val fileName = entry.fullPath.fileName.toString()
            // Hash is the last 8 chars before .md extension
            val hash8 = fileName.removeSuffix(".md").takeLast(8)
            // Look for a matching JSON file in summaries/
            val matchingJson = try {
                java.nio.file.Files.list(jsonPath).use { stream ->
                    stream.filter { it.fileName.toString().startsWith(hash8) || it.fileName.toString().contains(hash8) }
                        .findFirst().orElse(null)
                }
            } catch (_: Exception) { null }

            if (matchingJson != null) {
                try {
                    val json = java.nio.file.Files.readString(matchingJson, java.nio.charset.StandardCharsets.UTF_8)
                    val summary = Gson().fromJson(json, CommitSummary::class.java)
                    SwingUtilities.invokeLater {
                        if (summary != null) {
                            val vFile = SummaryVirtualFile(summary, readOnly = true)
                            com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(vFile, true)
                        }
                    }
                } catch (e: Exception) {
                    LOG.warn("Failed to read foreign summary from $matchingJson", e)
                }
            }
        }
    }

    // ─── Resume session ──────────────────────────────────────────────────────

    /** Opens a new terminal tab and runs the source-appropriate resume command. */
    private fun resumeInTerminal(source: String, sessionId: String) {
        val cwd = service.mainRepoRoot ?: project.basePath
        log.info("resumeInTerminal: source=$source, sessionId=$sessionId, cwd=$cwd")
        if (cwd == null) return
        ai.jolli.jollimemory.core.telemetry.Telemetry.track("session_resumed", mapOf("source" to source.lowercase()))
        TerminalUtils.resumeSession(project, source, sessionId, cwd)
    }

    // ─── Copy recall prompt ──────────────────────────────────────────────────

    /**
     * Copies the recall prompt to clipboard for a commit hash.
     * Fetches the full summary to get the branch name.
     */
    fun copyRecallPrompt(commitHash: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val summary = service.getSummary(commitHash)
            SwingUtilities.invokeLater {
                if (summary == null) {
                    JOptionPane.showMessageDialog(
                        this, "No summary found for this commit.",
                        "Copy Recall Prompt", JOptionPane.WARNING_MESSAGE,
                    )
                    return@invokeLater
                }
                copyRecallPromptForBranch(summary.branch)
            }
        }
    }

    /** Copies the recall prompt for a given branch name. */
    private fun copyRecallPromptForBranch(branch: String) {
        val prompt = "Invoke the \"jolli-recall\" skill with args \"$branch\"."
        val clipboard = Toolkit.getDefaultToolkit().systemClipboard
        clipboard.setContents(StringSelection(prompt), null)
        ai.jolli.jollimemory.core.telemetry.Telemetry.track("recall_prompt_copied")
        com.intellij.openapi.ui.Messages.showInfoMessage(
            project,
            "Recall prompt copied \u2014 paste it into Claude Code.",
            "Copy Recall Prompt",
        )
    }

    private fun formatShortRelativeDate(isoDate: String): String {
        return try {
            val then = Instant.parse(isoDate)
            val now = Instant.now()
            val duration = Duration.between(then, now)
            val minutes = duration.toMinutes()
            val hours = duration.toHours()
            val days = duration.toDays()
            when {
                minutes < 1 -> "now"
                minutes < 60 -> "${minutes}m ago"
                hours < 24 -> "${hours}h ago"
                days < 30 -> "${days}d ago"
                days < 365 -> "${days / 30}mo ago"
                else -> "${days / 365}y ago"
            }
        } catch (_: Exception) {
            isoDate.take(10)
        }
    }

    private fun escHtml(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    override fun dispose() {
        dismissHoverPopup()
        service.removeStatusListener(statusListener)
        service.removeMemoryStateListener(memoryStateListener)
        gitChangeDebounceTimer?.stop()
        messageBusConnection.disconnect()
    }

    // ─── State and utility ────────────────────────────────────────────────────

    /** Tracks per-commit row UI state for expand/collapse and checkbox management. */
    private data class CommitRowState(
        val row: JPanel,
        val fileContainer: JPanel,
        val arrowLabel: JLabel,
        val checkbox: JCheckBox?,
        var isExpanded: Boolean,
        var detailsLoaded: Boolean,
        /** Right-aligned "Show memory details" row, hidden while expanded. */
        val detailsToggle: JComponent? = null,
    )

    /** Bundle of everything the expanded memory detail renders, fetched off-EDT. */
    private data class ExpansionDetail(
        val summary: CommitSummary?,
        val conversations: List<ConversationBrief>,
        val files: List<CommitFileInfo>,
    )

    // ─── Sticky hover popup (VS Code hover-card pattern, native Swing) ────

    private fun scheduleShowHoverPopup(row: JPanel, commit: CommitSummaryBrief) {
        hoverDismissTimer.stop()
        if (hoverRow == row && hoverPopup?.isVisible == true) return
        hoverShowTimer?.stop()
        hoverShowTimer = Timer(HOVER_SHOW_DELAY_MS) { showHoverPopup(row, commit) }.apply {
            isRepeats = false
            start()
        }
    }

    private fun showHoverPopup(row: JPanel, c: CommitSummaryBrief) {
        hoverShowTimer?.stop()
        dismissHoverPopup()

        val window = SwingUtilities.getWindowAncestor(row) ?: return
        val popup = JWindow(window)

        val bg = UIManager.getColor("ToolTip.background") ?: background
        val fg = UIManager.getColor("ToolTip.foreground") ?: foreground
        val dimFg = UIManager.getColor("Component.infoForeground") ?: Color.GRAY
        val borderColor = UIManager.getColor("ToolTip.borderColor") ?: Color.GRAY

        val relDate = formatRelativeDate(c.date)
        val msg = c.message.ifBlank { c.shortHash }

        val content = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            background = bg
            border = JBUI.Borders.empty(8, 10)

            // Title (bold)
            add(JBLabel(msg).apply {
                foreground = fg
                font = font.deriveFont(java.awt.Font.BOLD)
                alignmentX = Component.LEFT_ALIGNMENT
            })
            add(Box.createVerticalStrut(JBUI.scale(4)))

            // Clock + relative date
            add(JBLabel(relDate, AllIcons.Vcs.History, SwingConstants.LEFT).apply {
                foreground = fg
                iconTextGap = JBUI.scale(6)
                alignmentX = Component.LEFT_ALIGNMENT
            })

            // Commit type badge
            if (c.commitType != null) {
                add(Box.createVerticalStrut(JBUI.scale(2)))
                add(JBLabel(c.commitType, AllIcons.Nodes.Tag, SwingConstants.LEFT).apply {
                    foreground = fg
                    iconTextGap = JBUI.scale(6)
                    alignmentX = Component.LEFT_ALIGNMENT
                })
            }

            // Separator + stats
            add(Box.createVerticalStrut(JBUI.scale(4)))
            add(JSeparator().apply { alignmentX = Component.LEFT_ALIGNMENT; maximumSize = Dimension(Int.MAX_VALUE, 1) })
            add(Box.createVerticalStrut(JBUI.scale(4)))

            val stats = mutableListOf("${c.filesChanged} file${if (c.filesChanged != 1) "s" else ""} changed")
            if (c.insertions > 0) stats.add("${c.insertions} insertion${if (c.insertions != 1) "s" else ""}(+)")
            if (c.deletions > 0) stats.add("${c.deletions} deletion${if (c.deletions != 1) "s" else ""}(-)")
            add(JBLabel(stats.joinToString(", ")).apply {
                foreground = dimFg
                font = font.deriveFont(font.size2D - 1f)
                alignmentX = Component.LEFT_ALIGNMENT
            })

            // Separator + hash / View Memory
            add(Box.createVerticalStrut(JBUI.scale(4)))
            add(JSeparator().apply { alignmentX = Component.LEFT_ALIGNMENT; maximumSize = Dimension(Int.MAX_VALUE, 1) })
            add(Box.createVerticalStrut(JBUI.scale(4)))

            add(JBLabel(c.shortHash, AllIcons.Vcs.CommitNode, SwingConstants.LEFT).apply {
                foreground = fg
                iconTextGap = JBUI.scale(6)
                font = java.awt.Font(java.awt.Font.MONOSPACED, java.awt.Font.PLAIN, font.size)
                alignmentX = Component.LEFT_ALIGNMENT
            })

            if (c.hasSummary) {
                add(Box.createVerticalStrut(JBUI.scale(4)))
                val linkColor = JBUI.CurrentTheme.Link.Foreground.ENABLED
                add(JBLabel("View Memory").apply {
                    foreground = linkColor
                    cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                    alignmentX = Component.LEFT_ALIGNMENT
                    addMouseListener(object : MouseAdapter() {
                        override fun mouseClicked(e: MouseEvent) {
                            dismissHoverPopup()
                            viewSummary(c.hash)
                        }
                        override fun mouseEntered(e: MouseEvent) { hoverDismissTimer.stop() }
                        override fun mouseExited(e: MouseEvent) { scheduleHoverDismiss() }
                    })
                })
            }
        }

        popup.contentPane = JPanel(BorderLayout()).apply {
            background = bg
            border = javax.swing.BorderFactory.createLineBorder(borderColor)
            add(content, BorderLayout.CENTER)
        }
        popup.pack()

        val rowLoc = row.locationOnScreen
        popup.setLocation(rowLoc.x, rowLoc.y + row.height + 2)

        val popupHoverListener = object : MouseAdapter() {
            override fun mouseEntered(e: MouseEvent) { hoverDismissTimer.stop() }
            override fun mouseExited(e: MouseEvent) { scheduleHoverDismiss() }
        }
        popup.addMouseListener(popupHoverListener)
        content.addMouseListener(popupHoverListener)

        hoverPopup = popup
        hoverRow = row
        popup.isVisible = true
    }

    private fun scheduleHoverDismiss() {
        hoverShowTimer?.stop()
        hoverDismissTimer.restart()
    }

    private fun dismissHoverPopup() {
        hoverShowTimer?.stop()
        hoverDismissTimer.stop()
        hoverPopup?.dispose()
        hoverPopup = null
        hoverRow = null
    }

    private fun statusColor(code: String): Color {
        return when (code) {
            "M" -> Color(0xC08020)   // Yellow — modified
            "A" -> Color(0x20A040)   // Green — added
            "D" -> Color(0xC02020)   // Red — deleted
            "R" -> Color(0x6A9FD6)   // Blue — renamed
            else -> Color.GRAY
        }
    }

    private fun formatRelativeDate(isoDate: String): String {
        return try {
            val then = Instant.parse(isoDate)
            val now = Instant.now()
            val duration = Duration.between(then, now)
            val minutes = duration.toMinutes()
            val hours = duration.toHours()
            val days = duration.toDays()
            when {
                minutes < 1 -> "just now"
                minutes < 60 -> "$minutes minute${if (minutes != 1L) "s" else ""} ago"
                hours < 24 -> "$hours hour${if (hours != 1L) "s" else ""} ago"
                days < 30 -> "$days day${if (days != 1L) "s" else ""} ago"
                days < 365 -> "${days / 30} month${if (days / 30 != 1L) "s" else ""} ago"
                else -> "${days / 365} year${if (days / 365 != 1L) "s" else ""} ago"
            }
        } catch (_: Exception) {
            isoDate.take(10)
        }
    }

}

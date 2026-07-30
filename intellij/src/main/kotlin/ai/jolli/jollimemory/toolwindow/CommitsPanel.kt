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
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils
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
import java.awt.Graphics2D
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
    /**
     * True while the panel is in "squash mode" — the transient state entered by
     * clicking the section-header Squash button. Only in this mode do row
     * checkboxes appear and the squash bar (count + Squash + Cancel) sits above
     * the list. Mirrors the design's `body.squash-mode` class.
     */
    private var isSquashMode: Boolean = false
    /** Squash bar's count label — updated on every selection change. */
    private var squashCountLabel: JLabel? = null
    /** Squash bar's Squash button — enabled once 2+ commits are checked. */
    private var squashConfirmBtn: javax.swing.JButton? = null
    // Written on the pooled refresh thread (refreshFromGit / forceRefresh),
    // read on the EDT via [commitCount] from [SquashAction.actionPerformed]
    // (the two-step gate that decides "enter squash mode" vs "run full squash
    // pipeline"). Without @Volatile the EDT could observe a stale non-zero
    // value (e.g. 1 while the just-written list has 2 entries), which would
    // slip past the `>= 2` gate, skip squash mode, and fall straight into the
    // AI consolidation squash with no per-commit selection UI and no
    // force-push warning on unpushed branches.
    @Volatile
    private var commits: List<CommitSummaryBrief> = emptyList()

    /**
     * In-memory count of branch commits already loaded into the panel. Cheap
     * accessor for callers (e.g. [ai.jolli.jollimemory.actions.SquashAction])
     * that just need "does this branch have ≥2 commits to squash?" and would
     * otherwise re-run `service.getBranchCommits()` on the EDT — a full round
     * of git rev-parse + merge-base + log + per-commit orphan-branch summary
     * reads. Refreshed on every [refreshFromGit], stale by at most one poll
     * interval, but that's exactly the window the action itself would race
     * anyway. [commits] is @Volatile so the EDT sees the pool-thread write.
     */
    fun commitCount(): Int = commits.size
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
    /**
     * True when the branch is fully merged into main (read-only history view).
     *
     * Written on the pooled refresh thread (refreshFromGit / forceRefresh), read
     * on the EDT via [branchIsMerged] from SquashAction.update() and, indirectly,
     * from [enterSquashMode]'s guard. Same cross-thread visibility contract as
     * the [commits] field above — without @Volatile the EDT could observe a stale
     * `false` and leave the Squash button enabled on an already-merged branch,
     * letting the user force-push a rewrite over history that is already in main.
     */
    @Volatile
    private var isMerged = false
    /** Read-only view of [isMerged] for external callers (SquashAction disables when true). */
    val branchIsMerged: Boolean get() = isMerged
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

    /**
     * The commit row currently displaying the hover tint. Enforces the "only one row
     * highlighted at a time" invariant: whenever a new row enters hover, the previous
     * one is cleared here, so a lost mouseExited (e.g. thrown IllegalComponentStateException
     * when a just-hidden action icon dispatches its own exit) can't leave two rows tinted.
     */
    private var currentHoveredCommitRow: JPanel? = null
    private var currentHoveredCommitRowClear: (() -> Unit)? = null
    private companion object {
        val LOG: com.intellij.openapi.diagnostic.Logger = com.intellij.openapi.diagnostic.Logger.getInstance(CommitsPanel::class.java)
        val log = ai.jolli.jollimemory.core.JmLogger.create("CommitsPanel")
        const val ARROW_RIGHT = "\u25B6" // ▶
        const val ARROW_DOWN = "\u25BC"  // ▼
        // Token-meter segment colors, dark/light theme aware. Input = green, output =
        // blue, cache = grey — matching the design's --vscode-charts-green /
        // --vscode-charts-blue / rgba(128,128,128,0.55) tokens.
        val TOK_INPUT_COLOR = JBColor(0x267F3F, 0x4ECE8D)
        val TOK_OUTPUT_COLOR = JBColor(0x0066BF, 0x3794FF)
        val TOK_CACHE_COLOR = JBColor(0x808080, 0x808080)
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

        // Paint a visible placeholder immediately on the EDT so users don't stare at
        // a blank panel while the initial refresh runs on a pooled thread. Replaced
        // by updateCommitList / showDisabled when refreshFromGit completes.
        showInitializing()

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

        // addStatusListener already fires an immediate callback when cachedStatus
        // is non-null (i.e. JolliMemoryService.initialize has completed), which
        // schedules the first refresh via statusListener. Only launch a fallback
        // refresh when the service has not initialized yet — otherwise we would
        // race a redundant refresh against the listener's one, wasting a full
        // getBranchCommits round trip on a v=0 result the panel then discards.
        if (service.getStatus() == null) {
            ApplicationManager.getApplication().executeOnPooledThread { refreshFromGit() }
        }
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
                // Paint immediately with the previous PR lookup; PR chip catches up
                // asynchronously (same reasoning as refreshFromGit — see comment there).
                SwingUtilities.invokeLater { updateCommitList() }
                refreshPrLookupAsync(refreshVersion)
            } catch (_: Exception) {
                commits = emptyList()
                SwingUtilities.invokeLater { updateCommitList() }
            }
        }
    }

    /**
     * Fetches the branch PR off the caller's pool thread, then re-paints the
     * commit list on the EDT with the fresh [prLookup]. Skips the paint when a
     * newer refresh has bumped [refreshVersion] past [myVersion] — the newer
     * refresh will schedule its own PR lookup, so overwriting with our stale
     * result would flip the PR chip back-and-forth.
     *
     * `gh pr list` typically takes 1-3s (a network round-trip), so this runs
     * OUTSIDE the critical path that renders the commit list; the list is
     * already visible by the time this returns.
     */
    private fun refreshPrLookupAsync(myVersion: Long) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val result = try {
                lookupBranchPr()
            } catch (_: Exception) {
                null
            }
            SwingUtilities.invokeLater {
                if (refreshVersion != myVersion) return@invokeLater
                prLookup = result
                updateCommitList()
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

    /**
     * Toggles all checkboxes — if all are checked, deselect all; otherwise
     * select all. Outside squash mode the checkboxes are hidden, so mutating
     * [checkedHashes] would build an invisible selection the user can't see;
     * enter squash mode first (which reveals checkboxes AND clears the
     * selection) and let the user re-run the action with visible controls.
     * This also keeps the header "Select/Deselect All" action from feeding
     * hidden state into the irreversible whole-branch Squash path.
     */
    fun toggleSelectAll() {
        if (commits.size <= 1 || isMerged) return
        if (!isSquashMode) {
            enterSquashMode()
            return
        }
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
        syncSquashBar()
        listPanel.repaint()
    }

    /** True while the section-header Squash button has opted into selection mode. */
    fun isInSquashMode(): Boolean = isSquashMode

    /**
     * Enters squash mode: reveals row checkboxes and shows the squash bar
     * (count + Squash + Cancel) at the top of the list. Starts from a clean
     * selection so the user isn't handed 8 pre-checked memories they never
     * opted into.
     */
    fun enterSquashMode() {
        if (isSquashMode || isMerged || commits.size < 2) return
        isSquashMode = true
        checkedHashes.clear()
        SwingUtilities.invokeLater { updateCommitList() }
    }

    /** Leaves squash mode: hides checkboxes + the squash bar, drops any selection. */
    fun exitSquashMode() {
        if (!isSquashMode) return
        isSquashMode = false
        checkedHashes.clear()
        SwingUtilities.invokeLater { updateCommitList() }
    }

    /**
     * The squash bar: transient control strip that appears in squash mode
     * between the token meter and the row list. Mirrors the design's
     * `.squash-bar` — a live count label, a Squash button that stays disabled
     * until 2+ memories are checked, and a Cancel button that exits the mode.
     * The Squash button re-triggers [SquashAction], which reads
     * [getSelectedCommits] and drives the AI-consolidation pipeline.
     */
    private fun buildSquashBar(): JComponent {
        val countLabel = JLabel(squashCountText()).apply {
            font = font.deriveFont(font.size2D - 1f)
            border = JBUI.Borders.emptyRight(8)
        }
        val confirmBtn = javax.swing.JButton("Squash").apply {
            isEnabled = checkedHashes.size >= 2
            addActionListener { runSquashFromBar(this) }
        }
        val cancelBtn = javax.swing.JButton("Cancel").apply {
            addActionListener { exitSquashMode() }
        }
        squashCountLabel = countLabel
        squashConfirmBtn = confirmBtn
        return JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(6), 0)).apply {
            isOpaque = false
            border = JBUI.Borders.empty(2, 4, 6, 4)
            alignmentX = Component.LEFT_ALIGNMENT
            add(countLabel)
            add(confirmBtn)
            add(cancelBtn)
            maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
        }
    }

    private fun squashCountText(): String {
        val n = checkedHashes.size
        return if (n >= 2) "$n memories selected" else "Select 2+ memories to squash ($n selected)"
    }

    /**
     * Fire [SquashAction] from the squash bar. SquashAction reads the selection
     * back out of this panel via [getSelectedCommits], so we only need to route
     * through ActionManager — the platform-blessed way to dispatch a registered
     * action programmatically, without touching the deprecated AnActionEvent
     * constructors. Passing [source] as the context component lets the platform
     * resolve project/data keys from the enclosing tool window.
     */
    private fun runSquashFromBar(source: JComponent) {
        val am = com.intellij.openapi.actionSystem.ActionManager.getInstance()
        val action = am.getAction("JolliMemory.Squash") ?: return
        am.tryToExecute(action, null, source, "JolliMemory.SquashBar", true)
    }

    /** Keeps the squash bar's count label + Squash-button enabled state honest. */
    private fun syncSquashBar() {
        squashCountLabel?.text = squashCountText()
        squashConfirmBtn?.isEnabled = checkedHashes.size >= 2
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
            // Paint the list NOW using the previous refresh's prLookup (may be null
            // on first refresh); the PR chip / SHIPPED badge fills in a moment later
            // once refreshPrLookupAsync finishes. lookupBranchPr talks to `gh` on
            // the network — synchronously waiting for it here would delay list
            // rendering by seconds for every refresh.
            SwingUtilities.invokeLater { if (refreshVersion == myVersion) updateCommitList() }
            refreshPrLookupAsync(myVersion)
        } catch (e: Exception) {
            log.warn("refreshFromGit threw: %s", e.message ?: "<no message>")
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
            // Route through the project-scoped TTL cache so this call site
            // and SummaryPanel.handleCheckPrStatus share one set of gh
            // subprocess results — same query, one process spawn.
            val prCache = ai.jolli.jollimemory.services.PrStatusCache.getInstance(project)
            if (!prCache.isGhAvailable(cwd) || !prCache.isGhAuthenticated(cwd)) return null
            prCache.getLookup(cwd, branch)
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
        // Snapshot which rows were expanded before we tear commitRowStates down.
        // A refresh that rebuilds every row — most commonly the async PR-lookup
        // re-paint that arrives 1–3s after the first paint — must not silently
        // collapse rows the user opened in the meantime.
        val previouslyExpanded = commitRowStates.entries
            .asSequence()
            .filter { it.value.isExpanded }
            .map { it.key }
            .toSet()

        rowCount = commits.size
        onRowCountChanged?.invoke(rowCount)
        removeAll()
        listPanel.removeAll()
        commitRowStates.clear()
        // The previously highlighted row (if any) is about to be discarded from the
        // component tree. Drop the reference so a subsequent mouseEntered can't try
        // to clear a stale row belonging to a different render.
        currentHoveredCommitRow = null
        currentHoveredCommitRowClear = null

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
            // Squash bar sits between the token meter and the list — only in
            // squash mode. Rebuilding on every mode change keeps its count
            // label and Squash-button-enabled state honest.
            if (isSquashMode && !isMerged && commits.size >= 2) {
                north.add(buildSquashBar())
            } else {
                squashCountLabel = null
                squashConfirmBtn = null
            }
            north.add(listPanel)
            add(north, BorderLayout.NORTH)

            if (previouslyExpanded.isNotEmpty()) {
                restoreExpandedRows(previouslyExpanded)
            }
        }
        revalidate(); repaint()
    }

    /**
     * Re-applies the isExpanded UI toggles onto the freshly built row states so a
     * rebuild driven by e.g. [refreshPrLookupAsync] doesn't collapse rows the user
     * had already opened. When [detailCache] already holds a resolved bundle we
     * render synchronously to avoid the "Loading..." flash a fresh
     * [loadExpandedDetail] would show; otherwise we fall back to the async loader.
     */
    private fun restoreExpandedRows(previouslyExpanded: Set<String>) {
        for (hash in previouslyExpanded) {
            val state = commitRowStates[hash] ?: continue
            state.isExpanded = true
            state.arrowLabel.text = ARROW_DOWN
            state.fileContainer.isVisible = true
            state.detailsToggle?.isVisible = false

            val cached = detailCache[hash]
            val commit = commits.firstOrNull { it.hash == hash }
            val cachedDetail: ExpansionDetail? = if (commit != null && cached != null && cached.isDone) {
                try { cached.get() } catch (_: Exception) { null }
            } else {
                null
            }
            if (commit != null && cachedDetail != null) {
                state.fileContainer.removeAll()
                renderExpandedGroups(state.fileContainer, commit, cachedDetail)
                state.detailsLoaded = true
                state.fileContainer.revalidate()
                state.fileContainer.repaint()
            } else {
                // Cache miss or a prior failure — take the async path. It briefly
                // shows the "Loading..." placeholder, still better than silently
                // collapsing the row.
                loadExpandedDetail(hash)
            }
        }
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
        // Native Swing tooltip mirrors the design's hover-popover on ".tok-pop" —
        // the same explanation text shows on hover, without a separate custom window.
        val helpPopupText = "<html><div style='width:240px'>Summed across memories whose source " +
            "reports token usage. Sources that don't report it (e.g. Cursor) aren't counted, " +
            "and cache tokens aren't tracked — so the real total is higher.</div></html>"
        val helpLabel = JLabel("?").apply {
            font = font.deriveFont(java.awt.Font.BOLD, font.size2D - 1f)
            foreground = dimFg
            border = javax.swing.BorderFactory.createCompoundBorder(
                RoundedLineBorder(dimFg, JBUI.scale(10)),
                JBUI.Borders.empty(0, 4),
            )
            toolTipText = helpPopupText
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            // Click still opens a stickier balloon (the design's ".pinned" state).
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
        // Scope label ("this branch") mirrors the design's tmeter head. Hidden when
        // there's no data (the N/A header stands alone) so it doesn't read as a claim.
        val scopeLabel: JComponent? = if (totals.hasData) {
            JBLabel("· this branch").apply { foreground = dimFg }
        } else {
            null
        }
        // BoxLayout with a horizontal glue right-aligns the "?" affordance —
        // matches the design's `.tok-help-wrap { margin-left: auto; }`.
        val headerLine = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            isOpaque = false
            alignmentX = Component.LEFT_ALIGNMENT
            add(totalLabel)
            if (costLabel != null) {
                add(Box.createHorizontalStrut(JBUI.scale(6)))
                add(costLabel)
            }
            if (scopeLabel != null) {
                add(Box.createHorizontalStrut(JBUI.scale(6)))
                add(scopeLabel)
            }
            if (totals.partial) {
                add(Box.createHorizontalStrut(JBUI.scale(6)))
                add(JBLabel("· partial").apply {
                    foreground = dimFg
                    font = font.deriveFont(font.size2D - 1f)
                })
            }
            add(Box.createHorizontalGlue())
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
                val g2 = g.create() as Graphics2D
                try {
                    g2.setRenderingHint(java.awt.RenderingHints.KEY_ANTIALIASING, java.awt.RenderingHints.VALUE_ANTIALIAS_ON)
                    g2.color = color
                    // Rounded square (~2px radius) — matches `.lg-dot { border-radius: 2px }`.
                    g2.fillRoundRect(0, 0, width, height, JBUI.scale(3), JBUI.scale(3))
                } finally {
                    g2.dispose()
                }
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
     * Collapsed-state affordance row: the SYNCED/LOCAL cloud chip on the left,
     * a `+N` overflow chip that reveals the other status chips on demand, plus
     * a right-aligned "Show memory details ⌄" link. Mirrors the design's
     * `#sec-memories .mem-chips` — the extra chips (PR / E2E) stay hidden until
     * the user clicks `+N`, keeping the collapsed row calm at rest.
     *
     * The whole panel is what the expand/collapse toggle hides — the design uses
     * `#sec-memories .mem-row.expanded .mem-chips { display: none; }`, and once
     * this row is gone the "Hide memory details ▴" link at the bottom of the
     * expanded section takes over.
     */
    private fun buildChipsRow(commit: CommitSummaryBrief, onToggleDetails: () -> Unit): JComponent {
        val cloudChip = if (commit.isSyncedToJolli) chip("SYNCED", CHIP_OK_COLOR) else chip("LOCAL", CHIP_DIM_COLOR)

        // Extras beyond the cloud chip — PR and E2E when they apply. Hidden by
        // default; the +N overflow chip flips them on.
        val extras = mutableListOf<JComponent>()
        openPr()?.let { extras.add(chip("PR #${it.number}", CHIP_OK_COLOR)) }
        if (commit.hasE2eGuide) extras.add(chip("E2E", CHIP_OK_COLOR))
        extras.forEach { it.isVisible = false }

        // "+N" overflow chip — only when there's something to reveal.
        val overflowChip: JComponent? = if (extras.isNotEmpty()) {
            JLabel("+${extras.size}").apply {
                foreground = CHIP_DIM_COLOR
                font = font.deriveFont(font.size2D - 2f)
                border = javax.swing.BorderFactory.createCompoundBorder(
                    RoundedLineBorder(CHIP_DIM_COLOR, JBUI.scale(8)),
                    JBUI.Borders.empty(0, 4),
                )
                cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                toolTipText = "Show all status chips"
                addMouseListener(object : MouseAdapter() {
                    override fun mouseClicked(e: MouseEvent) {
                        if (!SwingUtilities.isLeftMouseButton(e)) return
                        e.consume()
                        extras.forEach { it.isVisible = true }
                        this@apply.isVisible = false
                    }
                })
            }
        } else {
            null
        }

        val detailsLink = JLabel("Show memory details ▾").apply {
            foreground = JBUI.CurrentTheme.Link.Foreground.ENABLED
            font = font.deriveFont(font.size2D - 1f)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    if (SwingUtilities.isLeftMouseButton(e)) { e.consume(); onToggleDetails() }
                }
            })
        }

        // BoxLayout X_AXIS + a horizontal glue right-aligns the details link and
        // pushes the cloud chip to the left edge — the flexbox analogue of
        // `.mem-chips { display:flex; align-items:center; width:100% }`.
        val row = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            isOpaque = false
            alignmentX = Component.LEFT_ALIGNMENT
            border = JBUI.Borders.empty()
            add(cloudChip)
            if (overflowChip != null) {
                add(Box.createHorizontalStrut(JBUI.scale(4)))
                add(overflowChip)
            }
            for (extra in extras) {
                add(Box.createHorizontalStrut(JBUI.scale(4)))
                add(extra)
            }
            add(Box.createHorizontalGlue())
            add(detailsLink)
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
        // Checkboxes only appear once the user opts into squash mode via the
        // section-header Squash button (design's `body.squash-mode` gating).
        // Single-commit and merged-branch views still can't squash at all,
        // so those keep their permanent hidden state.
        val hideCheckboxes = singleMode || isMerged || !isSquashMode

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

        // Small link-colored ▤ glyph marking this as a memory row — mirrors the
        // design's `.mem-ico` sitting between the twirl/checkbox and the title.
        // Only rendered for rows that actually carry a memory, so the presence
        // of the glyph reads as "this commit has a summary" at a glance.
        val memIco: JLabel? = if (commit.hasSummary) {
            JLabel("▤").apply {
                foreground = JBUI.CurrentTheme.Link.Foreground.ENABLED
                font = font.deriveFont(font.size2D + 1f)
                border = JBUI.Borders.emptyRight(4)
            }
        } else {
            null
        }

        // Left side: arrow + optional checkbox + optional mem-ico
        val leftPanel = JPanel(FlowLayout(FlowLayout.LEFT, 0, 0)).apply {
            isOpaque = false
            add(arrowLabel)
            if (checkbox != null) add(checkbox)
            if (memIco != null) add(memIco)
        }

        // Title line: commit message (+ pushed/type badges). Date/hash/tokens move
        // to the sub-line below so the title stays scannable.
        val displayMessage = commit.message.ifBlank { commit.shortHash }
        val pushedBadge = if (commit.isPushed) " \u2601" else ""
        val typeBadge = if (commit.commitType != null) " [${commit.commitType}]" else ""
        // Memory rows carry a `JM-<docId>` reference prefix ONLY once the memory is synced
        // to a Jolli Space (no short-hash fallback) \u2014 matching the VS Code sidebar/history
        // tree, which sets memoryRefId = formatMemoryRefId(jolliDocId). Unsynced memories and
        // code-only commits get no prefix. (The detail panel still shows the hash fallback.)
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

        // Memory reference id (JM-<docId>) chip — synced-only, mirroring VS Code's `.mem-ref`:
        // a muted monospace, clickable "JM-142:" prefix that copies the id (and does NOT open
        // the row). Only memory rows synced to a Jolli Space carry a docId; unsynced and
        // code-only commits get no chip. Placed at the top-left of the wrapping title so
        // continuation lines hang-indent under the first title char, like VS Code's flex row.
        val refId = if (commit.hasSummary) SummaryUtils.formatMemoryRefId(commit.jolliDocId) else null
        val refChip: JLabel? = refId?.let { id ->
            JLabel("$id:").apply {
                font = java.awt.Font(java.awt.Font.MONOSPACED, java.awt.Font.PLAIN, (JBUI.Fonts.label().size2D - 1f).toInt())
                val dim = UIManager.getColor("Component.infoForeground") ?: Color.GRAY
                foreground = dim
                verticalAlignment = SwingConstants.TOP
                toolTipText = "Memory ID — click to copy"
                cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                border = JBUI.Borders.emptyRight(4)
                addMouseListener(object : MouseAdapter() {
                    override fun mouseClicked(e: MouseEvent) {
                        // The chip is never registered with `rowClickListener` (see below), so a
                        // click here can't open the row anyway — just copy the id.
                        if (SwingUtilities.isLeftMouseButton(e)) {
                            copyMemoryId(id, this@apply)
                        }
                    }
                    override fun mouseEntered(e: MouseEvent) {
                        foreground = UIManager.getColor("Component.foreground") ?: dim
                    }
                    override fun mouseExited(e: MouseEvent) {
                        foreground = dim
                    }
                })
            }
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

        // Chips row: a single cloud chip (SYNCED/LOCAL) on the left plus a
        // right-aligned "Show memory details \u2304" link. The row itself is the
        // "expand toggle" \u2014 the design hides the whole row when expanded, and
        // the "Hide memory details \u25b4" link at the bottom of the expanded
        // section takes over.
        val chipsRow: JComponent = buildChipsRow(commit) { toggleExpand(commit.hash) }

        // Ref chip (when present) sits WEST, top-aligned, with the wrapping title in CENTER so
        // continuation lines hang-indent under the first title char. Without a chip the title
        // spans the full width directly.
        val titleRow: JComponent = if (refChip != null) {
            JPanel(BorderLayout(0, 0)).apply {
                isOpaque = false
                alignmentX = Component.LEFT_ALIGNMENT
                add(refChip, BorderLayout.WEST)
                add(titleLabel, BorderLayout.CENTER)
            }
        } else {
            titleLabel
        }

        val centerPanel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
            alignmentX = Component.LEFT_ALIGNMENT
            add(titleRow)
            add(subLabel)
        }

        // Hover actions (memory rows only): Pin · Copy recall prompt · View memory.
        // Hidden until the row is hovered; the row body still opens the memory on click.
        // Sharing moved into the summary detail view's inline overlay (opened by the
        // eye icon → SummaryFileEditor.requestOpenShare) — matching the design's
        // Pin/Copy/View trio and the "share inline, not modal" team decision.
        val rowActions: List<JLabel> = if (commit.hasSummary) {
            listOf(
                convoActionIcon(AllIcons.General.Pin_tab, "Pin to top of this branch") { pinMemory(commit) },
                convoActionIcon(AllIcons.Actions.Copy, "Copy recall prompt") { copyRecallPrompt(commit.hash) },
                convoActionIcon(AllIcons.Actions.Show, "View memory") { viewSummary(commit.hash) },
            )
        } else {
            emptyList()
        }

        val rightPanel = JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply {
            isOpaque = false
            rowActions.forEach { add(it) }
        }
        // Reserve horizontal space for the hover-action icons even while they
        // start hidden (isVisible = false). FlowLayout skips invisible children
        // when computing its preferred size, so without this the title's
        // available width in topLine expands → the title fits on one line →
        // on hover, icons flip visible → rightPanel grows → title wraps to
        // a second line → the row's height jumps. Locking rightPanel's
        // preferredSize to the "all icons visible" size keeps title width
        // stable across the hover state.
        if (rowActions.isNotEmpty()) {
            // JLabel.preferredSize is computed from icon+insets regardless of
            // isVisible, so this reads the correct width while they're hidden.
            val reservedW = rowActions.sumOf { it.preferredSize.width }
            val reservedH = rowActions.maxOf { it.preferredSize.height }
            val ins = rightPanel.insets
            val fixed = Dimension(reservedW + ins.left + ins.right, reservedH + ins.top + ins.bottom)
            rightPanel.preferredSize = fixed
            rightPanel.minimumSize = fixed
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
                // The ref chip (if any) occupies WEST of the title row, so the wrapping title
                // measures against the remaining width — otherwise the last line would clip.
                val refW = refChip?.preferredSize?.width ?: 0
                titleLabel.setSize((cW - refW).coerceAtLeast(JBUI.scale(20)), Short.MAX_VALUE.toInt())
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

        // The row is a vertical stack so the single chips row spans the full
        // width and its "Show memory details ⌄" link right-aligns to the window
        // edge (rather than being boxed inside the title's CENTER region).
        val row = object : JPanel() {
            // Height tracks content (the title wraps and grows topLine), so the max must
            // follow the current preferred height rather than a value fixed at build time.
            override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)

            // Hover tint is a translucent JBColor (see RowStyle.HOVER_BG). Swing's opaque
            // contract fills the bounds with an alpha<255 colour once but doesn't repaint
            // the ancestor first, so pixels not covered by children (the chips row's right
            // padding, "Show memory details" gutter, and the row's own vertical border)
            // read as the previous frame plus tint — visually the row's left half tints
            // while the right half stays flat. Paint the overlay ourselves after the
            // ancestor has drawn, and keep isOpaque=false so the base background is fresh.
            override fun paintComponent(g: Graphics) {
                super.paintComponent(g)
                val bg = background ?: return
                val g2 = g.create() as Graphics2D
                try {
                    g2.color = bg
                    g2.fillRect(0, 0, width, height)
                } finally {
                    g2.dispose()
                }
            }
        }.apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
            border = JBUI.Borders.empty(2, 4)
            alignmentX = Component.LEFT_ALIGNMENT
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            add(topLine)
            add(chipsRow)
        }
        // Re-wrap the title (recompute height) when the row width changes on resize.
        row.addComponentListener(object : java.awt.event.ComponentAdapter() {
            override fun componentResized(e: java.awt.event.ComponentEvent) { row.revalidate() }
        })
        // Hover: reveal the Pin/Copy/Share actions. Hiding is bounds-checked so
        // moving between the row's children doesn't flicker the icons away.
        // NOTE: the JWindow-based hover popup (commit detail card) was removed in
        // the squash-mode restructure; re-adding it is tracked as a follow-up.
        //
        // Two invariants matter here:
        //   1. isShowing check before locationOnScreen — action icons are toggled visible
        //      only on hover, and a just-hidden icon can still dispatch a mouseExited whose
        //      locationOnScreen throws IllegalComponentStateException. Missing this check
        //      caused row.background to leak the HOVER_BG (two rows tinted at once).
        //   2. currentHoveredCommitRow bookkeeping — on every enter, clear the previous
        //      row's tint even if its own mouseExited was lost, so at most one row is tinted.
        val clearHoverTint: () -> Unit = {
            row.background = null
            row.repaint()
            rowActions.forEach { it.isVisible = false }
        }
        val hoverListener = object : MouseAdapter() {
            override fun mouseEntered(e: MouseEvent) {
                val prev = currentHoveredCommitRow
                if (prev != null && prev !== row) {
                    currentHoveredCommitRowClear?.invoke()
                }
                row.background = RowStyle.HOVER_BG
                row.repaint()
                rowActions.forEach { it.isVisible = true }
                currentHoveredCommitRow = row
                currentHoveredCommitRowClear = clearHoverTint
            }
            override fun mouseExited(e: MouseEvent) {
                val src = e.source as? Component ?: return
                if (!src.isShowing || !row.isShowing) {
                    clearHoverTint()
                    if (currentHoveredCommitRow === row) {
                        currentHoveredCommitRow = null
                        currentHoveredCommitRowClear = null
                    }
                    return
                }
                val screen = src.locationOnScreen.apply { translate(e.x, e.y) }
                val loc = row.locationOnScreen
                val stillInside = java.awt.Rectangle(loc.x, loc.y, row.width, row.height).contains(screen)
                if (!stillInside) {
                    clearHoverTint()
                    if (currentHoveredCommitRow === row) {
                        currentHoveredCommitRow = null
                        currentHoveredCommitRowClear = null
                    }
                }
            }
        }
        for (child in listOfNotNull(arrowLabel, titleLabel, subLabel, leftPanel, rightPanel, topLine, row, refChip)) {
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
            // The whole chips row is what expansion toggles now — the design
            // hides `.mem-chips` entirely on `.mem-row.expanded` and lets the
            // "Hide memory details" link at the bottom take over.
            detailsToggle = chipsRow,
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

    /**
     * A dim, uppercase group header ("SHIPPED (3)") + its rows, indented under
     * the commit. Mirrors the design's `.mem-group` — no divider lines between
     * groups, just top padding on each header, so the section reads as a calm
     * block rather than a bordered card.
     */
    private fun addGroup(container: JPanel, title: String, count: Int, rows: List<JComponent>) {
        // First-group vs subsequent-group top padding: subsequent groups get a
        // touch more breathing room so the eye finds the header without needing
        // a JSeparator line (`.mem-files .mem-group { padding: 6px 0 0 }` in the
        // design, vs `padding-top: 1px` on the first group).
        val topPad = if (container.componentCount > 0) 6 else 1
        container.add(JBLabel("$title ($count)").apply {
            foreground = UIManager.getColor("Component.infoForeground") ?: Color.GRAY
            font = font.deriveFont(java.awt.Font.BOLD, font.size2D - 2f)
            border = JBUI.Borders.empty(topPad, 24, 1, 4)
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
        // Two-stage open: skeleton first (fast, only briefs + shortstat — no gh,
        // no per-summary storage reads), then hydrate with the full vm from
        // build() once the network + heavy reads finish. This turns "click →
        // 3-5 s frozen → tab" into "click → 100 ms → tab with skeleton loaders
        // → 1-3 s later content fills in". Even during hydration the tab is
        // fully interactive: title/body editing works against the skeleton vm
        // and hydrate() bails when the user has dirtied the form (preserving
        // in-progress edits).
        //
        // Re-click on an already-open Create PR tab: activate + focus that tab
        // (the previous code paid a skeleton build for nothing here, then
        // relied on CreatePrVirtualFile's equals-by-branch to make openFile a
        // no-op — which does happen, but it does not guarantee focus lands on
        // the existing tab when another tab is currently active) and let Stage
        // 2 rehydrate it with fresh vm. hydrate() skips when webviewDirty=true,
        // so any in-progress title/body edits are preserved across re-clicks.
        ApplicationManager.getApplication().executeOnPooledThread {
            val skeleton = ai.jolli.jollimemory.toolwindow.views.CreatePrData.buildSkeleton(project)

            // Stage 1: focus the existing Create PR tab if one is open for the
            // SAME branch; otherwise open a new tab with the skeleton. Runs on
            // the EDT so both branches can hit FileEditorManager safely.
            SwingUtilities.invokeLater {
                val fm = com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project)
                // Branch-filtered match, identical to Stage 2's hydrate lookup
                // below. With two Create PR tabs open (branch A and B), a bare
                // `.firstOrNull()` could pick the wrong tab and fall through
                // to `openFile(CreatePrVirtualFile(skeleton))` — which then
                // dedupes by equals, but empirically loses focus. Filter by
                // the skeleton's branch here so the multi-tab case lands on
                // the tab the user actually meant.
                val existingFile = if (skeleton != null) {
                    fm.allEditors.filterIsInstance<CreatePrFileEditor>()
                        .mapNotNull { it.file as? CreatePrVirtualFile }
                        .firstOrNull { it.vm.branch == skeleton.branch }
                } else null
                if (existingFile != null) {
                    // Same-branch re-click. openFile on the EXISTING VirtualFile
                    // reference (not a new equals-equivalent one) activates its
                    // tab and, with focusEditor=true, moves keyboard focus to
                    // the editor — the fix for "re-click loses focus"
                    // (openFile on a fresh CreatePrVirtualFile only dedupes via
                    // equality, and empirically does not always land focus on
                    // the already-open tab). Skeleton is discarded — Stage 2's
                    // hydrate covers the refresh (and skips when webviewDirty).
                    fm.openFile(existingFile, true)
                    return@invokeLater
                }
                if (skeleton == null) {
                    com.intellij.openapi.ui.Messages.showInfoMessage(
                        project,
                        "No committed memory on this branch yet. Commit first, then create a PR.",
                        "Create PR",
                    )
                    return@invokeLater
                }
                // No matching tab (never opened, or existing tab is for a
                // different branch that the user has since switched away from).
                // Open a new tab; the existing stale tab stays open until the
                // user closes it — matches previous behavior.
                fm.openFile(CreatePrVirtualFile(skeleton), true)
            }

            // Stage 2: build the full vm (per-summary reads + gh via PrStatusCache)
            // and swap it in. Failure ≠ silent stall — CreatePrHtmlBuilder disables
            // the primary button while [skeleton] is true, so leaving the tab in
            // that state after the async build blows up would present a permanent
            // "Loading…" with no error surface. Instead, hydrate with the skeleton
            // fields but skeleton=false + loadError=<message> so the button
            // re-enables, the shimmer stops, and the banner explains the failure.
            // Re-clicking Create PR from the sidebar retries the whole pipeline.
            //
            // Two failure modes we must both funnel into loadError, not just the
            // exception one: [CreatePrData.build] can also RETURN null — every
            // brief with hasSummary=true had its getSummary read fail, or the
            // branch changed between Stage 1 and Stage 2. Falling through with
            // a null fullOrError would strand the tab in "Loading…" identically
            // to a thrown exception, so map null the same way.
            val fullOrError: ai.jolli.jollimemory.toolwindow.views.CreatePrData.ViewModel? = try {
                ai.jolli.jollimemory.toolwindow.views.CreatePrData.build(project)
                    ?: skeleton?.copy(
                        skeleton = false,
                        loadError = "Could not load PR details for this branch. Re-click Create PR to retry.",
                    )
            } catch (e: Exception) {
                log.warn("openCreatePrView: full build failed: %s", e.message ?: "<no message>")
                skeleton?.copy(
                    skeleton = false,
                    loadError = e.message?.takeIf { it.isNotBlank() } ?: "The details couldn't be loaded.",
                )
            }
            val full = fullOrError ?: return@executeOnPooledThread

            SwingUtilities.invokeLater {
                val fm = com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project)
                // Hydrate only the editor whose CreatePrVirtualFile branch
                // matches the vm we just built. If the user checked out
                // another branch and re-clicked Create PR during the ~1-3 s
                // hydration window, a second openCreatePrView will have
                // opened a fresh tab for the new branch — hydrating "the
                // first CreatePrFileEditor we find" would leak branch A's
                // memories/body/files into branch B's tab. Match by branch
                // instead so a stale in-flight hydrate lands on the correct
                // tab (or on nothing, if that tab was already closed).
                val editor = fm.allEditors
                    .filterIsInstance<CreatePrFileEditor>()
                    .firstOrNull { (it.file as? CreatePrVirtualFile)?.vm?.branch == full.branch }
                if (editor != null) {
                    editor.hydrate(full)
                } else {
                    // Tab was closed between skeleton open and hydrate, or
                    // the branch changed and a different tab is now active —
                    // nothing to do; the current tab (if any) will get its
                    // own hydrate from a later openCreatePrView call.
                    log.info("openCreatePrView: hydrate skipped, no matching CreatePrFileEditor for branch=%s", full.branch)
                }
            }
        }
    }

    private fun viewSummary(commitHash: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val summary = service.getSummary(commitHash)
            SwingUtilities.invokeLater {
                if (summary != null) {
                    MemoryTabOpener.openOrReuse(project, summary)
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
        currentHoveredCommitRow = null
        currentHoveredCommitRowClear = null

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
                            MemoryTabOpener.openOrReuse(project, summary, readOnly = true)
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
     * Copies a memory reference id (e.g. "JM-142") to the system clipboard and flashes a
     * short confirmation balloon under the clicked chip. Mirrors the VS Code sidebar's
     * click-to-copy affordance on the JM- prefix.
     */
    private fun copyMemoryId(refId: String, anchor: JComponent) {
        Toolkit.getDefaultToolkit().systemClipboard.setContents(StringSelection(refId), null)
        ai.jolli.jollimemory.core.telemetry.Telemetry.track(
            "memory_ref_id_copied",
            mapOf("surface_area" to "list"),
        )
        com.intellij.openapi.ui.popup.JBPopupFactory.getInstance()
            .createHtmlTextBalloonBuilder(
                "Copied <b>${com.intellij.openapi.util.text.StringUtil.escapeXmlEntities(refId)}</b>",
                com.intellij.openapi.ui.MessageType.INFO,
                null,
            )
            .setFadeoutTime(1500)
            .createBalloon()
            .show(
                com.intellij.ui.awt.RelativePoint.getSouthOf(anchor),
                com.intellij.openapi.ui.popup.Balloon.Position.below,
            )
    }

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
        /**
         * The cloud-chip + "Show memory details" affordance row, hidden while
         * expanded — the expanded section's "Hide memory details" link takes over.
         */
        val detailsToggle: JComponent? = null,
    )

    /** Bundle of everything the expanded memory detail renders, fetched off-EDT. */
    private data class ExpansionDetail(
        val summary: CommitSummary?,
        val conversations: List<ConversationBrief>,
        val files: List<CommitFileInfo>,
    )

    private fun statusColor(code: String): Color {
        return when (code) {
            "M" -> Color(0xC08020)   // Yellow — modified
            "A" -> Color(0x20A040)   // Green — added
            "D" -> Color(0xC02020)   // Red — deleted
            "R" -> Color(0x6A9FD6)   // Blue — renamed
            else -> Color.GRAY
        }
    }

}

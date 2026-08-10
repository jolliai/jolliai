package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.actions.TogglePanelAction
import ai.jolli.jollimemory.bridge.CliIntegrations
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliApiClient
import ai.jolli.jollimemory.services.JolliAuthService
import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.util.escapeHtml
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vcs.ProjectLevelVcsManager
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.vcs.VcsListener
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import git4idea.repo.GitRepository
import git4idea.repo.GitRepositoryChangeListener
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.ContentFactory
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.CardLayout
import java.awt.Component
import java.awt.Cursor
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.Popup
import javax.swing.PopupFactory
import javax.swing.ScrollPaneConstants
import javax.swing.SwingUtilities

/**
 * Creates the JolliMemory tool window with five collapsible panels matching
 * the VS Code sidebar layout:
 *   1. STATUS — installation state, session info, settings
 *   2. MEMORIES — all commit summaries across branches (searchable, paginated)
 *   3. PLANS & NOTES — Claude Code plans and user-created notes
 *   4. CHANGES — git-tracked file changes (select files for AI commit)
 *   5. COMMITS — branch commit history with summary indicators
 *
 * Each panel has a clickable header with collapse/expand arrow and
 * an inline action toolbar with section-specific buttons.
 *
 * Panels use an accordion layout: collapsed panels shrink to header-only height,
 * and expanded panels share the remaining vertical space equally.
 *
 * After successful enablement, the STATUS panel is auto-hidden and its
 * information is surfaced via a status indicator icon in the MEMORIES header.
 */
class JolliMemoryToolWindowFactory : ToolWindowFactory, DumbAware {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        // Display name shown in the tool window header / stripe. The registered id
        // stays "JOLLI" to preserve layout state.
        (toolWindow as? com.intellij.openapi.wm.ex.ToolWindowEx)?.stripeTitle = "JOLLI MEMORY"

        // ── No Git repository — show a placeholder and listen for VCS changes ──
        val basePath = project.basePath
        val hasGit = basePath != null && java.io.File(basePath, ".git").exists()
        if (!hasGit) {
            showNoGitContent(project, toolWindow)
            return
        }

        createGatedContent(project, toolWindow)
    }

    /**
     * Node.js gate in front of the full UI. When a verified Node runtime is already
     * known (in-process cache, non-blocking check — safe on the EDT) the full content
     * is built; otherwise the blocking "Node.js required" panel is shown, which probes
     * in the background and swaps in the full UI only once Node is found.
     */
    private fun createGatedContent(project: Project, toolWindow: ToolWindow) {
        if (ai.jolli.jollimemory.bridge.NodeRuntime.cached() != null) {
            createFullContent(project, toolWindow)
        } else {
            showNodeMissingContent(project, toolWindow)
        }
    }

    /**
     * Blocking panel shown while no verified Node.js runtime is known. Nothing else of
     * the plugin UI is reachable behind it (and JolliMemoryService.initialize() is
     * gated on the same check, so no plugin logic runs either).
     *
     * On construction it immediately re-probes in the background WITHOUT forcing, so a
     * detection already running in the startup activity is shared, and a tool window
     * that opened before that first probe finished self-heals into the full UI. The
     * Retry button forces a fresh probe and, via
     * [ai.jolli.jollimemory.services.JolliMemoryStartupActivity.retryNodeDetection],
     * completes the startup sequence the gate skipped.
     */
    private fun showNodeMissingContent(project: Project, toolWindow: ToolWindow) {
        // Every version this panel quotes comes from the detector's own floor — see
        // NodeRuntime.MIN_SUPPORTED_DISPLAY for why it is never typed out by hand.
        val minNode = ai.jolli.jollimemory.bridge.NodeRuntime.MIN_SUPPORTED_DISPLAY
        val statusLabel = JBLabel("Checking for Node.js...")
        val retryButton = javax.swing.JButton("Retry detection").apply { isEnabled = false }
        val chooseButton = javax.swing.JButton("Choose manually...").apply { isEnabled = false }
        val downloadButton = javax.swing.JButton("Download Node.js")

        val messagePanel = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(12)
            val box = Box.createVerticalBox()
            box.add(JBLabel(
                "<html>" +
                    "<b>Node.js is required</b><br/><br/>" +
                    "Jolli Memory needs a Node.js runtime and is blocked until one is found.<br/>" +
                    "Install Node.js $minNode or newer (LTS recommended), then click <b>Retry detection</b> — " +
                    "or point Jolli Memory at an existing binary with <b>Choose manually</b>." +
                    "</html>",
            ).apply { alignmentX = Component.LEFT_ALIGNMENT })
            box.add(Box.createVerticalStrut(12))
            box.add(statusLabel.apply { alignmentX = Component.LEFT_ALIGNMENT })
            box.add(Box.createVerticalStrut(12))
            box.add(JPanel(java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 8, 0)).apply {
                alignmentX = Component.LEFT_ALIGNMENT
                isOpaque = false
                add(retryButton)
                add(chooseButton)
                add(downloadButton)
            })
            add(box, BorderLayout.NORTH)
        }
        val content = ContentFactory.getInstance().createContent(messagePanel, "", false)
        toolWindow.contentManager.addContent(content)

        downloadButton.addActionListener {
            com.intellij.ide.BrowserUtil.browse("https://nodejs.org/en/download")
        }

        fun setBusy(text: String) {
            statusLabel.text = text
            retryButton.isEnabled = false
            chooseButton.isEnabled = false
        }

        fun setIdle(text: String) {
            statusLabel.text = text
            retryButton.isEnabled = true
            chooseButton.isEnabled = true
        }

        val unblock = {
            SwingUtilities.invokeLater {
                toolWindow.contentManager.removeAllContents(true)
                createFullContent(project, toolWindow)
            }
        }

        val onProbeDone = { found: Boolean ->
            if (found) {
                unblock()
            } else {
                // If detection ran candidates and rejected every one only because they were too
                // old, tell the user exactly that — with concrete versions and paths — instead
                // of a bare "not found" which reads as a bug on a machine that clearly has Node.
                val rejected = ai.jolli.jollimemory.bridge.NodeRuntime.rejectedFromLastDetection()
                val msg = if (rejected.isEmpty()) {
                    "No usable Node.js ($minNode or newer) was found on this machine."
                } else {
                    val items = rejected.joinToString("<br/>") { r ->
                        "• <b>${escapeHtml(r.version)}</b> at ${escapeHtml(r.path)} — too old"
                    }
                    "<html>Node.js is installed but too old (need v$minNode or newer):<br/>$items</html>"
                }
                SwingUtilities.invokeLater { setIdle(msg) }
            }
        }

        // Initial background probe (non-forced — shares a probe already running in the
        // startup activity instead of repeating it).
        com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
            onProbeDone(ai.jolli.jollimemory.bridge.NodeRuntime.detect() != null)
        }

        retryButton.addActionListener {
            setBusy("Checking for Node.js...")
            com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
                onProbeDone(
                    ai.jolli.jollimemory.services.JolliMemoryStartupActivity.retryNodeDetection(project),
                )
            }
        }

        // Manual fallback for installs the automatic channels can't see (fully custom
        // locations, exotic shells). The chooser only lets an actual node binary be
        // picked, and the pick still goes through the same --version + minimum-version
        // proof as automatic detection — a wrong file can never unblock the plugin.
        chooseButton.addActionListener {
            val descriptor = FileChooserDescriptor(true, false, false, false, false, false)
                .withTitle("Select Node.js Executable")
                .withDescription("Pick the node binary itself (node / node.exe), not a folder")
                .withShowHiddenFiles(true) // node usually lives in dot-dirs (~/.nvm, ~/.volta)
                .withFileFilter { ai.jolli.jollimemory.bridge.NodeRuntime.isNodeExecutableName(it.name) }
            FileChooser.chooseFile(descriptor, project, null) { picked ->
                setBusy("Verifying ${picked.name}...")
                com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
                    val result = ai.jolli.jollimemory.bridge.NodeRuntime.adoptManualSelection(picked.path)
                    if (result is ai.jolli.jollimemory.bridge.NodeRuntime.ManualSelectionResult.Accepted) {
                        // Same pooled thread: complete the startup sequence the gate
                        // skipped, then swap in the full UI.
                        ai.jolli.jollimemory.services.JolliMemoryStartupActivity.runPostNodeStartup(project)
                        unblock()
                    } else {
                        val message = when (result) {
                            is ai.jolli.jollimemory.bridge.NodeRuntime.ManualSelectionResult.TooOld ->
                                "That Node.js is ${result.version} — version $minNode or newer is required."
                            is ai.jolli.jollimemory.bridge.NodeRuntime.ManualSelectionResult.NotNode ->
                                "The selected file did not answer node --version — pick the actual Node.js binary."
                            else ->
                                "The selected file is not an executable."
                        }
                        SwingUtilities.invokeLater { setIdle(message) }
                    }
                }
            }
        }
    }

    /**
     * Shows a placeholder message when no `.git` directory is found.
     * Subscribes to [ProjectLevelVcsManager.VCS_CONFIGURATION_CHANGED] so that
     * when the user runs `git init` or enables VCS integration, the tool window
     * automatically rebuilds with the full panel UI.
     */
    private fun showNoGitContent(project: Project, toolWindow: ToolWindow) {
        val basePath = project.basePath
        val messagePanel = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(12)
            add(JBLabel(
                "<html>" +
                    "No Git repository detected.<br/><br/>" +
                    "Run <b>git init</b> in your project directory or use " +
                    "<b>VCS \u2192 Enable Version Control Integration</b> " +
                    "to start using Jolli Memory." +
                    "</html>",
            ), BorderLayout.NORTH)
        }
        val content = ContentFactory.getInstance().createContent(messagePanel, "", false)
        toolWindow.contentManager.addContent(content)

        // Listen for VCS changes — when .git appears, rebuild (behind the Node gate)
        val connection = project.messageBus.connect()
        connection.subscribe(
            ProjectLevelVcsManager.VCS_CONFIGURATION_CHANGED,
            VcsListener {
                if (basePath != null && java.io.File(basePath, ".git").exists()) {
                    connection.disconnect()
                    SwingUtilities.invokeLater {
                        toolWindow.contentManager.removeAllContents(true)
                        createGatedContent(project, toolWindow)
                    }
                }
            },
        )
    }

    /**
     * Creates the full tool window content with all five collapsible panels.
     * Initializes the service if needed.
     *
     * Subscribes to [ProjectLevelVcsManager.VCS_CONFIGURATION_CHANGED] and
     * service status changes so that if `.git` is removed while the plugin
     * is running, the tool window automatically switches back to the
     * "no Git" placeholder.
     */
    private fun createFullContent(project: Project, toolWindow: ToolWindow) {
        val service = project.getService(JolliMemoryService::class.java)

        // Reset if recovering from .git removal, then ensure initialized
        if (service.gitRemoved) {
            service.resetForReinitialization()
        }
        if (!service.isInitialized) {
            service.initialize()
        }
        ai.jolli.jollimemory.core.telemetry.Telemetry.track("toolwindow_opened", mapOf("view" to "current"))

        // Listen for .git removal — switch back to placeholder when detected.
        // Two detection paths: VCS config change (rm -rf .git) and service error (git command failure).
        val basePath = project.basePath
        val vcsConnection = project.messageBus.connect()
        var gitCheckActive = true
        val switchToNoGit: () -> Unit = {
            if (gitCheckActive) {
                gitCheckActive = false
                vcsConnection.disconnect()
                toolWindow.contentManager.removeAllContents(true)
                showNoGitContent(project, toolWindow)
            }
        }
        vcsConnection.subscribe(
            ProjectLevelVcsManager.VCS_CONFIGURATION_CHANGED,
            VcsListener {
                if (basePath != null && !java.io.File(basePath, ".git").exists()) {
                    SwingUtilities.invokeLater(switchToNoGit)
                }
            },
        )
        service.addStatusListener {
            if (service.gitRemoved) {
                SwingUtilities.invokeLater(switchToNoGit)
            }
        }

        // Create the panels
        val statusPanel = StatusPanel(project, service)
        val conversationsPanel = ActiveConversationsPanel(project, service)
        val plansPanel = PlansPanel(project, service)
        val changesPanel = ChangesPanel(project, service)
        val commitsPanel = CommitsPanel(project, service)
        val pinnedPanel = PinnedPanel(project, service)

        // ── Review-Memory sub-sections (folded inside Current Memory) ──
        // Conversations / Changes / Context keep their existing action toolbars and
        // row logic; they are no longer top-level sections (minimal-density redesign).
        // Inputs folded into Current Memory, in order: Conversations → Context → Files.
        // Each renders capped at 6 rows (then "Show N more"), separated by a light-blue
        // divider, with a single shared scrollbar across all three.
        val currentMemoryPanel = CurrentMemoryPanel(
            project,
            service,
            conversationsPanel, "JolliMemory.ConversationsActions",
            plansPanel, "JolliMemory.PlansActions",
            changesPanel, "JolliMemory.ChangesActions",
        )

        // Register panels for action lookup
        val registry = PanelRegistry().apply {
            this.statusPanel = statusPanel
            this.activeConversationsPanel = conversationsPanel
            this.plansPanel = plansPanel
            this.changesPanel = changesPanel
            this.commitsPanel = commitsPanel
            this.pinnedPanel = pinnedPanel
            this.currentMemoryPanel = currentMemoryPanel
        }
        service.panelRegistry = registry

        // ── Top-level accordion: Pinned → Current Memory → Committed Memories ──
        // (the redesign's three collapsible panels). CommitsPanel still shows
        // workspace commits, or foreign memories in read-only mode.
        // Pinned sizes to its content (height tracks the number of pinned items)
        // rather than taking an equal share of the accordion's surplus space.
        val pinnedCollapsible = CollapsiblePanel(
            "PINNED", "JolliMemory.PinnedActions", pinnedPanel, fitContent = true,
            titleIcon = AllIcons.General.Pin_tab,
        )
        val currentMemoryCollapsible = CollapsiblePanel(
            "WORKING MEMORY", "JolliMemory.CurrentMemoryActions", currentMemoryPanel,
        )
        val memoriesCollapsible = CollapsiblePanel(
            "COMMITTED MEMORIES", "JolliMemory.CommitsActions", commitsPanel,
        )
        // Accordion-header toolbars re-run their actions' `update()` when the
        // service's status changes. Those actions (Squash, Select-All …) gate
        // `isEnabled` on a status that is null until the first async refresh, and
        // a toolbar only updates when shown or when asked — 2025.1 dropped the
        // platform's periodic re-poll — so without this they stay greyed out from
        // first paint. CurrentMemoryPanel does the same for its own three section
        // toolbars, which is where the CONTEXT ➕ lives.
        listOfNotNull(
            pinnedCollapsible.headerToolbar,
            currentMemoryCollapsible.headerToolbar,
            memoriesCollapsible.headerToolbar,
        ).let { headerToolbars ->
            if (headerToolbars.isNotEmpty()) {
                service.addStatusListener {
                    SwingUtilities.invokeLater { headerToolbars.forEach { it.updateActionsAsync() } }
                }
            }
        }
        // Cold-start "build memory from your history" card. Rendered as a BARE bordered card
        // at the top of the stack (matching VS Code's `.backfill-panel` div) — deliberately NOT
        // a titled accordion section, so there is no persistent "BUILD MEMORY" header: the card
        // simply appears during cold start and hides on dismiss / once memory exists. The panel
        // owns its visibility via shouldBeVisible() (it stays up mid-flow).
        // Built defensively: a failure constructing this card (e.g. an SDK API drift between the
        // plugin's build target and the running IDE) must NEVER blank the whole tool window — so
        // on any throwable we log and simply omit the card. `null` = unavailable.
        // Assigned once the view switcher exists (below): navigates the tool window to the
        // Memory Bank view. The card's "Open your Memory Bank" button invokes it via this var.
        var openMemoryBank: () -> Unit = {}
        var backfillCard: BackfillPanel? = null
        try {
            lateinit var bfPanel: BackfillPanel
            val syncBackfillVisibility = {
                bfPanel.isVisible = bfPanel.shouldBeVisible()
                bfPanel.syncOffer()
                // Relayout the accordion so hiding the card collapses its space immediately.
                val stack = bfPanel.parent
                if (stack != null) {
                    stack.revalidate()
                    stack.repaint()
                }
            }
            bfPanel = BackfillPanel(
                project,
                service,
                onVisibilityRefresh = { SwingUtilities.invokeLater { syncBackfillVisibility() } },
                onOpenMemoryBank = { openMemoryBank() },
            )
            // Immediate-invoke on add (service fires once when initialized) sets the initial
            // visibility; later cold-start recomputes / dismissals re-run it on the EDT.
            service.addBackfillListener { SwingUtilities.invokeLater(syncBackfillVisibility) }
            backfillCard = bfPanel
        } catch (e: Throwable) {
            Logger.getInstance(JolliMemoryToolWindowFactory::class.java)
                .warn("Back-fill cold-start card unavailable (rest of the tool window unaffected): ${e.message}", e)
        }

        // Live row-count suffix in the section headers, e.g. "PINNED (3)".
        pinnedCollapsible.setCount(pinnedPanel.currentRowCount())
        pinnedPanel.onRowCountChanged = { n -> SwingUtilities.invokeLater { pinnedCollapsible.setCount(n) } }
        memoriesCollapsible.setCount(commitsPanel.currentRowCount())
        commitsPanel.onRowCountChanged = { n -> SwingUtilities.invokeLater { memoriesCollapsible.setCount(n) } }

        // Single vertical stack with ONE scrollbar spanning all three sections
        // (Pinned → Current Memory → Committed Memories). Each panel sizes to its
        // content; the trailing glue fills the viewport when the content is short.
        val accordionStack = WidthTrackingPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
            backfillCard?.alignmentX = Component.LEFT_ALIGNMENT
            pinnedCollapsible.alignmentX = Component.LEFT_ALIGNMENT
            currentMemoryCollapsible.alignmentX = Component.LEFT_ALIGNMENT
            memoriesCollapsible.alignmentX = Component.LEFT_ALIGNMENT
            backfillCard?.let { add(it) }
            add(pinnedCollapsible)
            add(currentMemoryCollapsible)
            add(memoriesCollapsible)
            add(Box.createVerticalGlue())
        }
        val accordionPanel = JBScrollPane(accordionStack).apply {
            border = JBUI.Borders.empty()
            verticalScrollBarPolicy = ScrollPaneConstants.VERTICAL_SCROLLBAR_AS_NEEDED
            horizontalScrollBarPolicy = ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER
        }

        // Gear menu: show/hide the three top-level panels.
        val gearActions = DefaultActionGroup().apply {
            add(TogglePanelAction(pinnedCollapsible))
            add(TogglePanelAction(currentMemoryCollapsible))
            add(TogglePanelAction(memoriesCollapsible))
        }
        toolWindow.setAdditionalGearActions(gearActions)

        // ── Content cards: current accordion / KB / Knowledge ──
        // (Status is NOT one of these — it lives above the whole normal sidebar
        // layout as its own card, so it hides view switch + breadcrumb +
        // accordion + action bar together; see [statusOverlayPanel] below.)
        val contentCardLayout = CardLayout()
        val contentCards = JPanel(contentCardLayout)
        contentCards.add(accordionPanel, CARD_ACCORDION)

        val kbPanel = KBExplorerPanel(project, service)
        contentCards.add(kbPanel, CARD_KB)

        val knowledgePanel = buildKnowledgePlaceholder()
        contentCards.add(knowledgePanel, CARD_KNOWLEDGE)

        // Fixed bottom action bar (Current Branch view only): Commit · Create PR · ⋯ More
        val actionBar = ActionBarPanel(project, service)

        // Status full-pane controller — implemented as a var so the title-bar
        // ToggleAction below (built before the widgets that Status hides) can
        // capture it and pick up the real implementation once [mainCardLayout]
        // exists. The placeholder still tracks [statusShown] so a very-early
        // toggle keeps the ToggleAction's isSelected() coherent.
        var statusShown = false
        var setStatusShown: (Boolean) -> Unit = { statusShown = it }

        // Repo-scoped opt-out (`manuallyDisabled` in `.jolli/profile.json`, spec 306).
        // Seeded from the service's cache — refreshed on the same fan-out as the
        // rest of the status (startup, VFS `profile.json`, GIT_REPO_CHANGE, daemon
        // `refresh` pushes), so a `jolli disable` from a terminal or a sibling
        // VS Code window flips the DisabledPanel without a tool-window rebuild.
        // Also updated in-memory by the DisabledPanel's Enable click (optimistic UI
        // flip — see below) and by [runStatusDisable]'s onDisabled callback after
        // the CLI transaction returns success, so the card switches locally before
        // the VFS-driven refresh from the CLI write catches up.
        var manuallyDisabled = service.isManuallyDisabled()

        // syncView() forward-reference — same pattern as [setStatusShown]. The
        // STATUS header's Disable icon fires long after syncView is defined, but
        // Kotlin resolves closures lexically; a placeholder here lets that
        // closure capture the name now, and the real impl overwrites it below.
        var syncView: () -> Unit = { }

        // ── Title-bar actions: Settings · Status ──
        // These live in the tool window header (the "Jolli Memory" title bar),
        // matching the mockup's view-title icon group. Sign In / Sign Out /
        // Sync Now live INSIDE the Status card (see [StatusPanel]) so the
        // header stays a two-icon strip.
        val settingsAction = object : AnAction(
            "Settings", "Open Jolli Memory settings", AllIcons.General.GearPlain,
        ), DumbAware {
            override fun actionPerformed(e: com.intellij.openapi.actionSystem.AnActionEvent) {
                SettingsDialog(project, service).show()
            }
        }
        val statusAction = object : com.intellij.openapi.actionSystem.ToggleAction(
            "Status", "Toggle the Jolli Memory status panel", JolliMemoryIcons.PulseStatusGreen,
        ), DumbAware {
            override fun isSelected(e: com.intellij.openapi.actionSystem.AnActionEvent): Boolean = statusShown
            override fun setSelected(e: com.intellij.openapi.actionSystem.AnActionEvent, state: Boolean) {
                setStatusShown(state)
            }

            // The title-bar status glyph reflects health: green / yellow / red — matching
            // the STATUS panel and the MCP & Skills row (yellow when Node is missing).
            override fun update(e: com.intellij.openapi.actionSystem.AnActionEvent) {
                super.update(e)
                e.presentation.icon = statusCircleIcon(service)
            }

            override fun getActionUpdateThread() = com.intellij.openapi.actionSystem.ActionUpdateThread.BGT
        }
        toolWindow.setTitleActions(listOf(settingsAction, statusAction))

        // Breadcrumb header: repo/branch selectors (icon buttons now live in the title bar)
        val breadcrumb = BreadcrumbHeaderPanel(
            service = service,
            onSelectionChanged = { repo, branch, isForeign ->
                if (isForeign && repo != null && branch != null) {
                    currentMemoryCollapsible.isVisible = false
                    actionBar.setForeign(true)
                    commitsPanel.setForeignMode(repo, branch)
                } else {
                    currentMemoryCollapsible.isVisible = currentMemoryCollapsible.isPanelVisible()
                    actionBar.setForeign(false)
                    commitsPanel.clearForeignMode()
                }
            },
            // Memory Bank view: scope the KBExplorer tree to the picked repo.
            // Null = the user picked "All repos" (broaden back out). This runs
            // in parallel with onSelectionChanged; the two callbacks own
            // independent slices of the UI (foreign-mode routing vs tree filter).
            onRepoFilterChanged = { repoName ->
                kbPanel.setRepoFilter(repoName)
            },
        )

        // View switch (Current Branch / Memory Bank / Knowledge) above the breadcrumb.
        // The switch logic is a named function so the back-fill card's "Open your Memory Bank"
        // button can drive it too (via `openMemoryBank`), keeping the switcher UI in sync.
        fun applyView(view: ViewSwitchPanel.View) {
            // Switching views hides the STATUS overlay. Uses setStatusShown() (not a
            // raw statusShown assign) because STATUS now lives one layer up in
            // mainCardLayout — a raw flag flip would leave the overlay visible while
            // the toggle button reports "off", making the view switch appear inert.
            setStatusShown(false)
            ai.jolli.jollimemory.core.telemetry.Telemetry.track(
                "view_switched",
                mapOf("view" to view.name.lowercase()),
            )
            when (view) {
                ViewSwitchPanel.View.CURRENT -> {
                    contentCardLayout.show(contentCards, CARD_ACCORDION)
                    breadcrumb.setMode(BreadcrumbHeaderPanel.Mode.BRANCH)
                    actionBar.isVisible = true
                }
                ViewSwitchPanel.View.BANK -> {
                    contentCardLayout.show(contentCards, CARD_KB)
                    breadcrumb.setMode(BreadcrumbHeaderPanel.Mode.REPO_FILTER)
                    actionBar.isVisible = false
                    ApplicationManager.getApplication().executeOnPooledThread { kbPanel.load() }
                }
                ViewSwitchPanel.View.KNOWLEDGE -> {
                    contentCardLayout.show(contentCards, CARD_KNOWLEDGE)
                    breadcrumb.setMode(BreadcrumbHeaderPanel.Mode.REPO_FILTER)
                    actionBar.isVisible = false
                }
            }
        }
        val viewSwitch = ViewSwitchPanel { view -> applyView(view) }
        // Wire the back-fill card's "Open your Memory Bank" button: select the Bank tab in the
        // switcher (updates its highlight) and apply the view (switches the content card).
        openMemoryBank = {
            viewSwitch.setSelected(ViewSwitchPanel.View.BANK)
            applyView(ViewSwitchPanel.View.BANK)
        }

        // Auto-switch to the STATUS card when Jolli Memory is degraded (preserves
        // the install/setup discoverability), and auto-return once it recovers.
        // The manually-disabled state has its own [DisabledPanel] one level up at
        // the rootPanel, so the degraded/recovered arms are a no-op then —
        // otherwise the STATUS overlay would fight the DisabledPanel and the
        // mainCardLayout would flip pointlessly on every status refresh.
        //
        // It is NOT a plain early return though: the overlay must be COLLAPSED on
        // the way into the disabled state. [mainCardLayout] survives underneath
        // CARD_DISABLED, so a still-shown overlay is exactly what the user lands
        // on when they click Enable (syncView shows CARD_MAIN, whose card layout
        // is still on CARD_MAIN_STATUS) — the STATUS page instead of the sidebar.
        // This arm covers the paths that route through the status listener (a
        // cross-window / terminal `jolli disable`, the Settings credential-removal
        // auto-disable); the STATUS header's own Disable icon collapses it inline
        // so it doesn't wait on the async refresh.
        fun syncStatusCard() {
            if (manuallyDisabled) {
                if (statusShown) setStatusShown(false)
                return
            }
            val enabled = service.getStatus()?.enabled == true
            if (!enabled) {
                setStatusShown(true)
            } else if (statusShown) {
                setStatusShown(false)
            }
        }
        syncStatusCard()
        // On every status refresh, pull the service's current manuallyDisabled and
        // re-route via [syncView] iff it changed — that's what carries a cross-window
        // `jolli disable` (or terminal `jolli disable`) into this IDE's UI. The
        // syncStatusCard() call after handles the enabled/degraded overlay as before.
        val statusSyncListener: () -> Unit = {
            SwingUtilities.invokeLater {
                val svcDisabled = service.isManuallyDisabled()
                if (svcDisabled != manuallyDisabled) {
                    manuallyDisabled = svcDisabled
                    syncView()
                }
                syncStatusCard()
            }
        }
        service.addStatusListener(statusSyncListener)
        val statusListenerDisposable = com.intellij.openapi.Disposable {
            service.removeStatusListener(statusSyncListener)
        }

        // Refresh breadcrumb + pinned data on background thread
        ApplicationManager.getApplication().executeOnPooledThread {
            breadcrumb.refresh()
            pinnedPanel.refresh()
        }

        val northWrapper = JPanel(BorderLayout()).apply {
            add(viewSwitch, BorderLayout.NORTH)
            add(breadcrumb, BorderLayout.SOUTH)
        }
        // Normal sidebar surface — everything below IntelliJ's own title bar
        // *except* the Status overlay: view switch + breadcrumb, accordion /
        // Memory Bank / Knowledge content, and the bottom action bar.
        val mainNormalPanel = JPanel(BorderLayout()).apply {
            add(northWrapper, BorderLayout.NORTH)
            add(contentCards, BorderLayout.CENTER)
            add(actionBar, BorderLayout.SOUTH)
        }

        // Status overlay: wraps [statusPanel] with a "STATUS" header that carries
        // three icon actions (Sign In/Out toggle · Disable · Close). Mirrors the
        // design's `#ov-status` `.sb-overlay` — a full-sidebar overlay, not a
        // card inside the normal layout — so it visually replaces every other
        // widget when the Status toggle is on. The returned Disposable owns the
        // header's auth listener; it's tied to [contentDisposable] below.
        val (statusOverlayPanel, statusOverlayDisposable) = buildStatusOverlay(
            statusPanel = statusPanel,
            onSignInOrOut = { runStatusSignInOrOut(project) },
            onDisable = {
                runStatusDisable(project, service) {
                    // Uninstall succeeded (flag persisted AND hooks removed via the
                    // CLI's fail-atomic transaction) → flip UI to DisabledPanel.
                    SwingUtilities.invokeLater {
                        manuallyDisabled = true
                        // Collapse this overlay before routing away. The Disable icon
                        // only exists in the STATUS header, so reaching here means the
                        // overlay is open and [mainCardLayout] is parked on
                        // CARD_MAIN_STATUS; leaving it there would make the
                        // DisabledPanel's Enable click land on the STATUS page rather
                        // than the sidebar, and syncStatusCard's disabled arm would not
                        // undo it until the async refreshStatus lands 0.5-2 s later.
                        setStatusShown(false)
                        syncView()
                    }
                }
            },
            onClose = { setStatusShown(false) },
        )

        // Two-card CardLayout at the mainPanel level: switching to "status"
        // hides EVERYTHING in the normal panel (view switch, breadcrumb,
        // accordion, action bar) in one flip.
        val mainCardLayout = CardLayout()
        val mainPanel = JPanel(mainCardLayout).apply {
            add(mainNormalPanel, CARD_MAIN_NORMAL)
            add(statusOverlayPanel, CARD_MAIN_STATUS)
        }

        // Now that mainCardLayout exists, replace the setStatusShown
        // placeholder with the real implementation. The title-bar
        // ToggleAction, applyView, and syncStatusCard all captured
        // this var, so they pick up the swap automatically.
        setStatusShown = { shown ->
            statusShown = shown
            mainCardLayout.show(mainPanel, if (shown) CARD_MAIN_STATUS else CARD_MAIN_NORMAL)
        }
        // Push the initial [statusShown] through the real impl — syncStatusCard
        // ran earlier against the placeholder, so the flag may already be true
        // (Jolli disabled) but the card layout is still on "normal".
        setStatusShown(statusShown)

        // ── Onboarding / Main card layout ──────────────────────
        val rootCardLayout = CardLayout()
        val rootPanel = JPanel(rootCardLayout)

        fun isConfigured(): Boolean {
            val config = SessionTracker.loadConfigFromDir(SessionTracker.getGlobalConfigDir())
            // A local agent drives its own subscription login — no jollimemory-held key
            // — so choosing it in onboarding is a complete setup. Mirrors the CLI's
            // resolveLlmCredentialSource, which returns "local-agent" whenever the
            // provider is selected, with no presence/key check. Without this the
            // onboarding "Use Local Agent Tool" button saved config but never flipped
            // to the main view.
            // Note: the "user turned it off" state is handled one level up via
            // manuallyDisabled → CARD_DISABLED, so isConfigured() only decides
            // between onboarding and (main | disabled).
            if (config.aiProvider == "local-agent") return true
            if (!config.apiKey.isNullOrBlank()) return true
            if (!System.getenv("ANTHROPIC_API_KEY").isNullOrBlank()) return true
            if (!config.jolliApiKey.isNullOrBlank()) return true
            return false
        }

        syncView = {
            val card = when {
                // Manual opt-out wins over configured/enabled: the user explicitly
                // chose to turn Jolli off, so keep showing the DisabledPanel until
                // they click Enable, even if creds are still on disk.
                manuallyDisabled && isConfigured() -> CARD_DISABLED
                isConfigured() -> CARD_MAIN
                else -> CARD_ONBOARDING
            }
            rootCardLayout.show(rootPanel, card)
        }

        val onboardingPanel = OnboardingPanel(
            service = service,
            onApiKeySaved = { SwingUtilities.invokeLater { syncView() } },
            onSignInError = { msg ->
                com.intellij.notification.Notifications.Bus.notify(
                    com.intellij.notification.Notification(
                        "JolliMemory",
                        "Sign In Failed",
                        msg,
                        com.intellij.notification.NotificationType.ERROR,
                    )
                )
            },
        )

        // "Get started with Jolli Memory" — VS Code `.disabled-panel` parity.
        //
        // OPTIMISTIC UI: flip to CARD_MAIN immediately on the EDT so the user
        // sees a response in ~10 ms, then run the ~500 ms-2 s CLI install
        // transaction (dist extract + bridge install + …) on a pooled thread.
        // If install fails, roll the card back to CARD_DISABLED and let the
        // notification fired by [runStatusEnable] explain why.
        //
        // Why this is safe: enable is a "convert to success or stay disabled"
        // operation — a failed install leaves the repo genuinely disabled
        // (no hooks written), and the CLI's install action clears the
        // on-disk `manuallyDisabled` flag ONLY on success, so the roll-back
        // in-memory flip lands on the same truth as disk. VS Code's flow is
        // synchronous end-to-end because its total wall time is 50-300 ms;
        // IntelliJ's out-of-process cost is ~5-10× higher, so optimistic is
        // the equalizer.
        val disabledPanel = DisabledPanel(onEnable = {
            // Flip UI now, on whichever thread the click fires from (safely
            // marshalled via invokeLater so the swing state changes are
            // ordered even if the button already dispatches on the EDT).
            SwingUtilities.invokeLater {
                manuallyDisabled = false
                syncView()
            }
            ApplicationManager.getApplication().executeOnPooledThread {
                runStatusEnable(project, service, onFailure = {
                    SwingUtilities.invokeLater {
                        manuallyDisabled = true
                        syncView()
                    }
                })
            }
        })

        rootPanel.add(onboardingPanel, CARD_ONBOARDING)
        rootPanel.add(mainPanel, CARD_MAIN)
        rootPanel.add(disabledPanel, CARD_DISABLED)
        // The initial manuallyDisabled read moved into [service.refreshStatus] —
        // seeded by the sync initialize() at the top of createFullContent, and
        // kept live by the status listener + `profile.json` VFS watcher.

        // Auth listener on the factory: handles sign-in → main, sign-out → onboarding
        //
        // VS Code parity: sign-out is JUST sign-out — it clears credentials via
        // the shared `clearAuthCredentials` (through the ide-bridge) and lets
        // syncView() re-route based on the fresh config. It does NOT chain an
        // auto-uninstall that writes `manuallyDisabled=true`, because:
        //   • The `.jolli` sign-in path already clears `aiProvider="jolli"` on
        //     the CLI side, so `isConfigured()` naturally flips to false and
        //     syncView() lands on CARD_ONBOARDING.
        //   • For a `local-agent` user who signed in to Jolli, sign-out only
        //     removes their Jolli Space access; `aiProvider` stays "local-agent"
        //     and Jolli Memory is still fully functional — the correct next
        //     surface is CARD_MAIN, not the DisabledPanel.
        // A prior version fired `service.uninstall()` here when a stale
        // `hasCredentials` check missed the local-agent case, wrongly writing
        // `manuallyDisabled=true` and trapping the user on the DisabledPanel
        // even though they still had a working provider. See VS Code's
        // `jollimemory.signOut` command in Extension.ts for the equivalent —
        // it only calls statusStore.refresh() plus panel notifications.
        val factoryAuthDisposable = JolliAuthService.addAuthListener {
            SwingUtilities.invokeLater { syncView() }
        }

        syncView()

        val syncViewListener: () -> Unit = { SwingUtilities.invokeLater { syncView() } }
        service.addStatusListener(syncViewListener)
        val syncViewDisposable = com.intellij.openapi.Disposable {
            service.removeStatusListener(syncViewListener)
        }

        // Single content — breadcrumb stays visible across accordion/KB views
        // Hoisted so the breadcrumb message-bus connection below can also be tied to
        // it — a project.messageBus.connect() with no parent Disposable would keep its
        // plugin-class handler subscribed after a dynamic unload and pin the classloader.
        val contentDisposable = Disposer.newDisposable("JolliMemoryContent")
        Disposer.register(contentDisposable, onboardingPanel)
        Disposer.register(contentDisposable, factoryAuthDisposable)
        Disposer.register(contentDisposable, statusListenerDisposable)
        Disposer.register(contentDisposable, statusOverlayDisposable)
        Disposer.register(contentDisposable, syncViewDisposable)
        Disposer.register(contentDisposable, statusPanel)
        Disposer.register(contentDisposable, plansPanel)
        Disposer.register(contentDisposable, changesPanel)
        Disposer.register(contentDisposable, commitsPanel)
        Disposer.register(contentDisposable, conversationsPanel)
        Disposer.register(contentDisposable, pinnedPanel)
        Disposer.register(contentDisposable, currentMemoryPanel)
        Disposer.register(contentDisposable, kbPanel)
        val content = ContentFactory.getInstance().createContent(rootPanel, "", false).apply {
            isCloseable = false
            setDisposer(contentDisposable)
        }

        // Update breadcrumb on branch switch — multiple detection paths
        val updateBreadcrumbBranch: () -> Unit = {
            val newBranch = service.getGitOps()?.getCurrentBranch()
            if (newBranch != null) breadcrumb.updateCurrentBranch(newBranch)
        }

        // Path 1: IntelliJ git repository change event
        val branchUpdateConnection = project.messageBus.connect(contentDisposable)
        branchUpdateConnection.subscribe(
            GitRepository.GIT_REPO_CHANGE,
            GitRepositoryChangeListener { updateBreadcrumbBranch() },
        )

        // Path 2: VCS configuration change (catches terminal branch operations)
        branchUpdateConnection.subscribe(
            ProjectLevelVcsManager.VCS_CONFIGURATION_CHANGED,
            VcsListener { updateBreadcrumbBranch() },
        )

        // Path 3: Service status change
        service.addStatusListener { updateBreadcrumbBranch() }

        toolWindow.contentManager.addContent(content)

        // Load KB tree on background thread
        ApplicationManager.getApplication().executeOnPooledThread { kbPanel.load() }
    }

    override fun shouldBeAvailable(project: Project): Boolean {
        return project.basePath != null
    }

    /**
     * Placeholder card for the Knowledge view. The wiki + graph rendering is a
     * follow-up; this keeps the third view-switch tab navigable and discoverable.
     */
    private fun buildKnowledgePlaceholder(): JPanel {
        return JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(16)
            val message = JBLabel(
                "<html><b>Knowledge</b><br/><br/>" +
                    "Your memories, compiled into a browsable wiki + decision graph.<br/>" +
                    "Coming soon.</html>",
            )
            add(message, BorderLayout.NORTH)
        }
    }

    companion object {
        private const val CARD_ONBOARDING = "onboarding"
        private const val CARD_MAIN = "main"
        // Shown when the user has explicitly disabled Jolli Memory via the
        // STATUS header Disable icon (spec 306's `manuallyDisabled` opt-out).
        // Mirrors VS Code's `.disabled-panel` — a distinct card from the
        // onboarding flow so a re-enable is one click, not three-choice re-setup.
        private const val CARD_DISABLED = "disabled"
        private const val CARD_ACCORDION = "accordion"
        private const val CARD_KB = "kb"
        private const val CARD_KNOWLEDGE = "knowledge"
        // Inside mainPanel: swaps the whole normal sidebar surface for the
        // Status overlay (view switch, breadcrumb, accordion, action bar are
        // ALL hidden while Status is up).
        private const val CARD_MAIN_NORMAL = "mainNormal"
        private const val CARD_MAIN_STATUS = "mainStatus"
    }
}

/**
 * Wraps [statusPanel] with a "STATUS" header carrying three icon actions
 * (Sign In/Out · Disable · Close) plus the composite body panel. Matches the
 * design's `#ov-status` `.sb-overlay > .ov-header` — a distinct, labeled page
 * inside the sidebar, not a card inside the normal layout.
 *
 * The Sign In/Sign Out icon flips based on [JolliAuthService.isSignedIn]; the
 * returned [Disposable] owns the auth listener that drives the swap, and the
 * caller MUST register it against the tool window's content disposable.
 *
 * [onClose] is invoked when the user clicks the X. The title-bar Status
 * ToggleAction stays the primary close affordance; the X is a secondary one.
 */
private fun buildStatusOverlay(
    statusPanel: JPanel,
    onSignInOrOut: () -> Unit,
    onDisable: () -> Unit,
    onClose: () -> Unit,
): Pair<JPanel, com.intellij.openapi.Disposable> {
    val separatorColor = javax.swing.UIManager.getColor("Separator.separatorColor")
        ?: javax.swing.UIManager.getColor("Component.borderColor")
        ?: java.awt.Color.GRAY

    val title = JBLabel("STATUS").apply {
        font = font.deriveFont(java.awt.Font.BOLD, font.size2D - 2f)
        border = JBUI.Borders.emptyLeft(4)
    }

    // Sign In / Sign Out toggle. Icon + tooltip driven by [JolliAuthService];
    // the auth listener below re-runs [refreshSignInOut] on every state flip so
    // this stays coherent without polling.
    val signInOutButton = JBLabel().apply {
        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        border = JBUI.Borders.empty(0, 4)
        addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                e.consume()
                onSignInOrOut()
            }
        })
    }
    val refreshSignInOut = {
        val signedIn = JolliAuthService.isSignedIn()
        signInOutButton.icon = if (signedIn) AllIcons.Actions.Exit else AllIcons.General.User
        signInOutButton.toolTipText = if (signedIn) "Sign out of Jolli" else "Sign in to Jolli"
    }
    refreshSignInOut()
    val authListenerDisposable = JolliAuthService.addAuthListener {
        SwingUtilities.invokeLater(refreshSignInOut)
    }

    val disableButton = JBLabel(AllIcons.Actions.Suspend).apply {
        toolTipText = "Disable Jolli Memory (removes hooks — the sidebar shows a card to turn it back on)"
        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        border = JBUI.Borders.empty(0, 4)
        addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                e.consume()
                onDisable()
            }
        })
    }

    val closeButton = JBLabel(AllIcons.Actions.Close).apply {
        toolTipText = "Close"
        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        border = JBUI.Borders.empty(0, 4)
        addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                e.consume()
                onClose()
            }
        })
    }

    val actions = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.X_AXIS)
        isOpaque = false
        add(signInOutButton)
        add(Box.createHorizontalStrut(2))
        add(disableButton)
        add(Box.createHorizontalStrut(2))
        add(closeButton)
    }

    val header = JPanel(BorderLayout()).apply {
        border = javax.swing.BorderFactory.createCompoundBorder(
            JBUI.Borders.customLineBottom(separatorColor),
            JBUI.Borders.empty(6, 8, 6, 4),
        )
        // Sit visually a shade off the sidebar background so the header reads
        // as a chrome band — mirrors the accordion section header treatment.
        background = com.intellij.ui.JBColor.lazy {
            val panel = javax.swing.UIManager.getColor("Panel.background")
                ?: com.intellij.ui.JBColor.background()
            if (com.intellij.ui.ColorUtil.isDark(panel)) {
                com.intellij.ui.ColorUtil.brighter(panel, 2)
            } else {
                com.intellij.ui.ColorUtil.darker(panel, 1)
            }
        }
        isOpaque = true
        add(title, BorderLayout.WEST)
        add(actions, BorderLayout.EAST)
    }
    val overlay = JPanel(BorderLayout()).apply {
        add(header, BorderLayout.NORTH)
        add(statusPanel, BorderLayout.CENTER)
    }
    return overlay to authListenerDisposable
}

/**
 * Fire-and-forget: if signed out, opens the browser-based sign-in flow (surfacing
 * failures as a balloon). If signed in, signs out immediately — matching VS Code's
 * `jollimemory.signOut` command semantics. Callable from the STATUS header icon.
 *
 * The success path retries pending pushes (JOLLI-1900). This is the surviving copy of
 * what the retired Preferences panel's login handler did: commits whose push was
 * refused for lack of credentials sit in `push-pending.json`, and signing in is the
 * event that makes them sendable. Without it a mid-session sign-in left them queued
 * until the next IDE start, since the only other caller is the startup catch-up in
 * [JolliMemoryService.initialize]. Mirrors VS Code's post-login retry in
 * `Extension.ts`.
 */
private fun runStatusSignInOrOut(project: Project) {
    if (JolliAuthService.isSignedIn()) {
        JolliAuthService.signOut()
        return
    }
    JolliAuthService.login(
        forceFreshApiKey = true,
        onSuccess = {
            // Off-EDT: retryPendingPushes spawns the CLI. Fire-and-forget — it no-ops when
            // nothing is pending. The header icon is refreshed by the auth listener,
            // independently of this.
            //
            // Everything, including the service lookup, sits inside the pooled block's
            // try: sign-in completes on a browser-callback thread an arbitrary time after
            // the click, so the user may have closed the project by then, and
            // `getService` on a disposed project throws. This callback is invoked from
            // JolliAuthService's own success path, so letting an exception escape here
            // would surface as a failed sign-in for a login that actually worked.
            ApplicationManager.getApplication().executeOnPooledThread {
                try {
                    if (project.isDisposed) return@executeOnPooledThread
                    val cwd = project.getService(JolliMemoryService::class.java).mainRepoRoot
                        ?: project.basePath
                        ?: return@executeOnPooledThread
                    CliIntegrations.retryPendingPushes(cwd)
                } catch (e: Exception) {
                    Logger.getInstance(JolliMemoryToolWindowFactory::class.java)
                        .warn("Post-login pending-push retry failed (non-fatal): ${e.message}")
                }
            }
        },
        onError = { msg ->
            SwingUtilities.invokeLater {
                com.intellij.notification.Notifications.Bus.notify(
                    com.intellij.notification.Notification(
                        "JolliMemory",
                        "Sign In Failed",
                        msg,
                        com.intellij.notification.NotificationType.ERROR,
                    ),
                    project,
                )
            }
        },
    )
}

/**
 * Disables Jolli Memory in this project — parity with VS Code's
 * `jollimemory.disableJolliMemory`. Runs off-EDT because `service.uninstall()`
 * does file I/O.
 *
 * Delegates the fail-atomic guarantee to `service.uninstall()`, which through
 * [ai.jolli.jollimemory.bridge.HookInstaller.uninstall] calls the CLI's
 * `uninstall` bridge action with `persistManualDisable=true`. The CLI writes
 * `manuallyDisabled=true` FIRST (see `cli/src/install/Installer.ts` line
 * ~993), then removes hooks — a write failure aborts the whole transaction
 * before any hook is touched, so no separate Kotlin-side write is needed.
 *
 * The UI flip therefore fires only when the whole transaction returned
 * success — a small latency (500 ms–2 s) trade for eliminating the double
 * write (bridge round trip + profile.json write) the two-step design carried.
 *
 * The `surface_disabled` telemetry `trigger` distinguishes this entry point
 * (`status_button`) from `settings` so funnels can tell them apart.
 */
private fun runStatusDisable(
    project: Project,
    service: JolliMemoryService,
    onDisabled: () -> Unit,
) {
    ApplicationManager.getApplication().executeOnPooledThread {
        // Guard: service.uninstall() below needs a resolvable repo root; the CLI's
        // uninstall action resolves it itself, but if both service.mainRepoRoot and
        // project.basePath are null, the whole surface is unhealthy — bail loudly
        // instead of letting the bridge fail with a less actionable error.
        if (service.mainRepoRoot == null && project.basePath == null) {
            Logger.getInstance(JolliMemoryToolWindowFactory::class.java)
                .warn("runStatusDisable: no cwd (mainRepoRoot & basePath both null) — aborting")
            SwingUtilities.invokeLater {
                com.intellij.notification.Notifications.Bus.notify(
                    com.intellij.notification.Notification(
                        "JolliMemory",
                        "Disable Failed",
                        "Could not disable Jolli Memory: no repository root available.",
                        com.intellij.notification.NotificationType.ERROR,
                    ),
                    project,
                )
            }
            return@executeOnPooledThread
        }
        if (!service.uninstall()) {
            Logger.getInstance(JolliMemoryToolWindowFactory::class.java)
                .warn("Disable failed — service.uninstall() returned false: ${service.lastError}")
            SwingUtilities.invokeLater {
                com.intellij.notification.Notifications.Bus.notify(
                    com.intellij.notification.Notification(
                        "JolliMemory",
                        "Disable Failed",
                        service.lastError
                            ?.let { "Could not disable Jolli Memory ($it). Nothing was changed." }
                            ?: "Could not disable Jolli Memory. See the logs for details.",
                        com.intellij.notification.NotificationType.ERROR,
                    ),
                    project,
                )
            }
            return@executeOnPooledThread
        }
        onDisabled()
        ai.jolli.jollimemory.core.telemetry.Telemetry.track(
            "surface_disabled",
            mapOf("trigger" to "status_button"),
        )
    }
}

/**
 * Re-enables Jolli Memory from the DisabledPanel — parity with VS Code's
 * `jollimemory.enableJolliMemory`. MUST be called on a pooled thread; all
 * work below is synchronous file / process I/O.
 *
 * The caller is expected to do an OPTIMISTIC UI flip *before* calling this
 * (see [createFullContent]'s DisabledPanel wiring). We keep the CLI work on
 * the critical path so hooks are actually installed by the time the flow
 * finishes, but the user sees CARD_MAIN in ~10 ms regardless — 500 ms-2 s
 * faster than waiting for the full install to return.
 *
 * The `install` bridge action clears `manuallyDisabled` internally when
 * `clearManualDisableOnSuccess: true` is set — no separate RepoProfile write
 * is issued, saving one bridge round-trip.
 *
 * @param onFailure fires on the CALLER'S thread (this function is already on
 *   a pooled thread) when the install fails; the DisabledPanel path uses it
 *   to roll the optimistic flip back to CARD_DISABLED. A user notification
 *   is fired before [onFailure] so the caller doesn't need to.
 */
private fun runStatusEnable(
    project: Project,
    service: JolliMemoryService,
    onFailure: () -> Unit = {},
) {
    val cwd = service.mainRepoRoot ?: project.basePath
    if (cwd == null) {
        Logger.getInstance(JolliMemoryToolWindowFactory::class.java)
            .warn("runStatusEnable: no cwd (mainRepoRoot & basePath both null) — aborting")
        onFailure()
        return
    }
    if (!service.isInitialized) service.initialize()
    val installed = service.install()
    if (!installed) {
        SwingUtilities.invokeLater {
            com.intellij.notification.Notifications.Bus.notify(
                com.intellij.notification.Notification(
                    "JolliMemory",
                    "Enable Failed",
                    "Could not enable Jolli Memory. See the logs for details.",
                    com.intellij.notification.NotificationType.ERROR,
                ),
                project,
            )
        }
        onFailure()
        return
    }
    ai.jolli.jollimemory.core.telemetry.Telemetry.track(
        "surface_enabled",
        mapOf("trigger" to "disabled_panel"),
    )
}

/**
 * Picks the Status glyph — a pulse (heartbeat) body plus a small colored health
 * dot at the bottom-right, matching the design mockup's `#btn-status` composite
 * (see `intellij-interactive.html`). Only the dot color changes with state; the
 * pulse body stays theme-adaptive gray. Shared by the title-bar Status action
 * and the hover status indicator so both always agree:
 *   - red    → not enabled / no status
 *   - yellow → enabled but degraded (missing creds/hooks, scan errors, Node/MCP unavailable)
 *   - green  → all good
 */
private fun statusCircleIcon(service: JolliMemoryService): javax.swing.Icon {
    val status = service.getStatus()
    return when {
        status == null || !status.enabled -> JolliMemoryIcons.PulseStatusRed
        statusHasWarnings(service, status) -> JolliMemoryIcons.PulseStatusYellow
        else -> JolliMemoryIcons.PulseStatusGreen
    }
}

/**
 * Whether the current status is degraded but still functional (→ yellow):
 * - No LLM credentials configured (selected provider can't work)
 * - Service has a lastError
 * - Git hooks not fully installed
 * - Claude/Gemini hooks not installed when that host is detected
 * - OpenCode/Cursor scan errors
 * - Node missing, or present but MCP + skills integrations not set up (non-blocking)
 */
private fun statusHasWarnings(
    service: JolliMemoryService,
    status: ai.jolli.jollimemory.core.StatusInfo,
): Boolean {
    val config = SessionTracker.loadConfigFromDir(SessionTracker.getGlobalConfigDir())
    when (config.aiProvider) {
        "anthropic" ->
            if (config.apiKey.isNullOrBlank() && System.getenv("ANTHROPIC_API_KEY").isNullOrBlank()) return true
        "jolli" ->
            if (config.jolliApiKey.isNullOrBlank()) return true
        else -> {
            val hasAny = !config.apiKey.isNullOrBlank() ||
                !System.getenv("ANTHROPIC_API_KEY").isNullOrBlank() ||
                !config.jolliApiKey.isNullOrBlank()
            if (!hasAny) return true
        }
    }

    if (service.lastError != null) return true
    if (!status.gitHookInstalled) return true
    if (status.claudeDetected == true && !status.claudeHookInstalled) return true
    if (status.geminiDetected == true && !status.geminiHookInstalled) return true
    if (status.openCodeScanError != null) return true
    if (status.cursorScanError != null) return true
    // MCP + skills degraded — Node missing, or present but integrations not set up.
    // Non-blocking (memory generation uses native hooks), so it's a warning, not an
    // error. Mirrors the "MCP & Skills" WARN row in StatusPanel.mcpStatusRow().
    if (!status.nodeAvailable || !status.integrationsActive) return true
    return false
}

/**
 * A small status indicator label that shows a colored circle icon
 * (green/yellow/red) based on the JolliMemory service state.
 *
 * - Green: enabled without errors
 * - Yellow: enabled but with warnings (e.g., missing hooks, missing API key)
 * - Red: not enabled or failed to enable
 *
 * On mouse hover, a popup appears showing a summary of the status information
 * (same data as the STATUS panel, rendered as HTML).
 */
private class StatusIndicatorLabel(
    private val service: JolliMemoryService,
) : JLabel() {

    private var activePopup: Popup? = null

    init {
        border = JBUI.Borders.emptyLeft(6)
        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        updateIcon()

        // Listen for status changes to update the icon color
        service.addStatusListener { SwingUtilities.invokeLater { updateIcon() } }

        addMouseListener(object : MouseAdapter() {
            override fun mouseEntered(e: MouseEvent) {
                showStatusPopup(e)
            }

            override fun mouseExited(e: MouseEvent) {
                hideStatusPopup()
            }
        })
    }

    private fun updateIcon() {
        icon = statusCircleIcon(service)
    }

    private fun showStatusPopup(e: MouseEvent) {
        hideStatusPopup()

        val html = buildStatusHtml()
        val label = com.intellij.ui.components.JBLabel(html).apply {
            border = JBUI.Borders.empty(8)
        }
        val wrapper = JPanel(java.awt.BorderLayout()).apply {
            add(label, java.awt.BorderLayout.CENTER)
            border = JBUI.Borders.customLine(
                javax.swing.UIManager.getColor("Separator.separatorColor") ?: java.awt.Color.GRAY,
            )
            background = javax.swing.UIManager.getColor("ToolTip.background")
                ?: javax.swing.UIManager.getColor("Panel.background")
        }

        val location = e.component.locationOnScreen
        val x = location.x
        val y = location.y + e.component.height + 2

        activePopup = PopupFactory.getSharedInstance().getPopup(e.component, wrapper, x, y)
        activePopup?.show()
    }

    private fun hideStatusPopup() {
        activePopup?.hide()
        activePopup = null
    }

    /** Builds an HTML summary of the current status, mirroring the STATUS panel content. */
    private fun buildStatusHtml(): String {
        val status = service.getStatus()
        val sb = StringBuilder("<html><div style='padding:2px'>")

        if (status == null || !status.enabled) {
            sb.append("<b>Jolli Memory is not enabled.</b>")
            val err = service.lastError
            if (err != null) {
                sb.append("<br/><span style='color:#F85149'>$err</span>")
            }
            sb.append("</div></html>")
            return sb.toString()
        }

        // Credential warning for selected provider
        val credConfig = SessionTracker.loadConfigFromDir(SessionTracker.getGlobalConfigDir())
        val providerMissing = when (credConfig.aiProvider) {
            "anthropic" -> credConfig.apiKey.isNullOrBlank() && System.getenv("ANTHROPIC_API_KEY").isNullOrBlank()
            "jolli" -> credConfig.jolliApiKey.isNullOrBlank()
            else -> credConfig.apiKey.isNullOrBlank() &&
                System.getenv("ANTHROPIC_API_KEY").isNullOrBlank() &&
                credConfig.jolliApiKey.isNullOrBlank()
        }
        if (providerMissing) {
            val providerName = if (credConfig.aiProvider == "jolli") "Jolli" else "Anthropic"
            sb.append("<p><span style='color:#D29922'>\u25CF</span> <b>$providerName API key missing</b> — open Settings to add one</p>")
        }

        // Hooks — CLI-installed via full `enable`: five git hooks incl.
        // post-merge and pre-push, running the Node run-hook dispatcher.
        val hookParts = mutableListOf<String>()
        if (status.gitHookInstalled) hookParts.add("5 Git")
        if (status.claudeHookInstalled) hookParts.add("2 Claude")
        if (status.geminiHookInstalled) hookParts.add("1 Gemini")
        val hooksDesc = if (hookParts.isNotEmpty()) hookParts.joinToString(" + ") else "none installed"
        val hookColor = if (status.gitHookInstalled) "#3FB950" else "#F85149"
        sb.append("<p><span style='color:$hookColor'>\u25CF</span> <b>Hooks:</b> $hooksDesc</p>")

        // Sessions
        sb.append("<p><span style='color:#3FB950'>\u25CF</span> <b>Sessions (Claude/Gemini):</b> ${status.activeSessions}</p>")

        // Stored Memories
        sb.append("<p><span style='color:#3FB950'>\u25CF</span> <b>Stored Memories:</b> ${status.summaryCount} total</p>")

        // Jolli Site
        val cwd = service.mainRepoRoot
        val config = SessionTracker.loadConfig(cwd)
        if (!config.jolliApiKey.isNullOrBlank()) {
            val meta = JolliApiClient.parseJolliApiKey(config.jolliApiKey!!)
            val siteUrl = meta?.u
            if (siteUrl != null) {
                val display = siteUrl.removePrefix("https://").removePrefix("http://")
                sb.append("<p><span style='color:#3FB950'>\u25CF</span> <b>Jolli Site:</b> $display</p>")
            }
        } else {
            sb.append("<p><span style='color:#D29922'>\u25CF</span> <b>Jolli API Key:</b> not configured</p>")
        }

        // Integrations
        if (status.claudeDetected == true) {
            val color = if (status.claudeHookInstalled) "#3FB950" else "#D29922"
            val desc = if (status.claudeHookInstalled) "hook installed" else "hook not installed"
            sb.append("<p><span style='color:$color'>\u25CF</span> <b>Claude:</b> $desc</p>")
        }
        if (status.codexDetected == true) {
            sb.append("<p><span style='color:#3FB950'>\u25CF</span> <b>Codex:</b> detected</p>")
        }
        if (status.geminiDetected == true) {
            val color = if (status.geminiHookInstalled) "#3FB950" else "#D29922"
            val desc = if (status.geminiHookInstalled) "hook installed" else "hook not installed"
            sb.append("<p><span style='color:$color'>\u25CF</span> <b>Gemini:</b> $desc</p>")
        }
        if (status.openCodeDetected == true) {
            val scanError = status.openCodeScanError
            if (scanError != null) {
                val detail = if (scanError.message != null) "${scanError.kind}: ${scanError.message}" else scanError.kind
                sb.append("<p><span style='color:#F85149'>\u25CF</span> <b>OpenCode:</b> unavailable \u2014 $detail</p>")
            } else if (status.openCodeEnabled == false) {
                sb.append("<p><span style='color:#D29922'>\u25CF</span> <b>OpenCode:</b> detected but disabled</p>")
            } else {
                sb.append("<p><span style='color:#3FB950'>\u25CF</span> <b>OpenCode:</b> detected</p>")
            }
        }
        if (status.cursorDetected == true) {
            val scanError = status.cursorScanError
            if (scanError != null) {
                val detail = if (scanError.message != null) "${scanError.kind}: ${scanError.message}" else scanError.kind
                sb.append("<p><span style='color:#F85149'>\u25CF</span> <b>Cursor:</b> unavailable \u2014 $detail</p>")
            } else if (status.cursorEnabled == false) {
                sb.append("<p><span style='color:#D29922'>\u25CF</span> <b>Cursor:</b> detected but disabled</p>")
            } else {
                sb.append("<p><span style='color:#3FB950'>\u25CF</span> <b>Cursor:</b> detected</p>")
            }
        }
        if (status.devinDetected == true) {
            val scanError = status.devinScanError
            if (scanError != null) {
                val detail = if (scanError.message != null) "${scanError.kind}: ${scanError.message}" else scanError.kind
                sb.append("<p><span style='color:#F85149'>\u25CF</span> <b>Devin:</b> unavailable \u2014 $detail</p>")
            } else if (status.devinEnabled == false) {
                sb.append("<p><span style='color:#D29922'>\u25CF</span> <b>Devin:</b> detected but disabled</p>")
            } else {
                sb.append("<p><span style='color:#3FB950'>\u25CF</span> <b>Devin:</b> detected</p>")
            }
        }
        if (status.copilotDetected == true) {
            val scanError = status.copilotScanError
            if (scanError != null) {
                val msg = scanError.message.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                sb.append("<p><span style='color:#F85149'>\u25CF</span> <b>Copilot CLI:</b> unavailable \u2014 ${scanError.kind}<br/><span style='color:gray'>$msg</span></p>")
            } else if (status.copilotEnabled == false) {
                sb.append("<p><span style='color:#D29922'>\u25CF</span> <b>Copilot CLI:</b> detected but disabled</p>")
            } else {
                sb.append("<p><span style='color:#3FB950'>\u25CF</span> <b>Copilot CLI:</b> detected</p>")
            }
        }
        if (status.copilotChatDetected == true) {
            val scanError = status.copilotChatScanError
            if (scanError != null) {
                val msg = scanError.message.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                sb.append("<p><span style='color:#F85149'>\u25CF</span> <b>Copilot Chat:</b> unavailable \u2014 ${scanError.kind}<br/><span style='color:gray'>$msg</span></p>")
            } else if (status.copilotEnabled == false) {
                sb.append("<p><span style='color:#D29922'>\u25CF</span> <b>Copilot Chat:</b> detected but disabled</p>")
            } else {
                sb.append("<p><span style='color:#3FB950'>\u25CF</span> <b>Copilot Chat:</b> detected</p>")
            }
        }
        if (status.clineVscodeDetected == true || status.clineCliDetected == true) {
            val vscodeErr = status.clineVscodeScanError
            val cliErr = status.clineCliScanError
            if (vscodeErr != null || cliErr != null) {
                val parts = mutableListOf<String>()
                if (vscodeErr != null) parts.add("VS Code: ${vscodeErr.kind}")
                if (cliErr != null) parts.add("CLI: ${cliErr.kind}")
                sb.append("<p><span style='color:#F85149'>\u25CF</span> <b>Cline:</b> unavailable \u2014 ${parts.joinToString(", ")}</p>")
            } else if (status.clineEnabled == false) {
                sb.append("<p><span style='color:#D29922'>\u25CF</span> <b>Cline:</b> detected but disabled</p>")
            } else {
                sb.append("<p><span style='color:#3FB950'>\u25CF</span> <b>Cline:</b> detected</p>")
            }
        }
        if (status.antigravityDetected == true) {
            val scanError = status.antigravityScanError
            if (scanError != null) {
                val detail = if (scanError.message != null) "${scanError.kind}: ${scanError.message}" else scanError.kind
                sb.append("<p><span style='color:#F85149'>\u25CF</span> <b>Antigravity:</b> unavailable \u2014 $detail</p>")
            } else if (status.antigravityEnabled == false) {
                sb.append("<p><span style='color:#D29922'>\u25CF</span> <b>Antigravity:</b> detected but disabled</p>")
            } else {
                sb.append("<p><span style='color:#3FB950'>\u25CF</span> <b>Antigravity:</b> detected</p>")
            }
        }
        if (status.kimiDetected == true) {
            if (status.kimiEnabled == false) {
                sb.append("<p><span style='color:#D29922'>\u25CF</span> <b>Kimi Code:</b> detected but disabled</p>")
            } else {
                sb.append("<p><span style='color:#3FB950'>\u25CF</span> <b>Kimi Code:</b> detected</p>")
            }
        }

        // Error
        val err = service.lastError
        if (err != null) {
            sb.append("<p><span style='color:#F85149'>\u25CF</span> <b>Error:</b> $err</p>")
        }

        sb.append("</div></html>")
        return sb.toString()
    }
}

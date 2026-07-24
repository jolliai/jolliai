package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.actions.CloudSyncAction
import ai.jolli.jollimemory.actions.TogglePanelAction
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
                    "Install Node.js 18 or newer (LTS recommended), then click <b>Retry detection</b> — " +
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
                    "No usable Node.js (18 or newer) was found on this machine."
                } else {
                    val items = rejected.joinToString("<br/>") { r ->
                        "• <b>${escapeHtml(r.version)}</b> at ${escapeHtml(r.path)} — too old"
                    }
                    "<html>Node.js is installed but too old (need v18 or newer):<br/>$items</html>"
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
                                "That Node.js is ${result.version} — version 18 or newer is required."
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

        // ── Content cards: current accordion / KB / Knowledge / status full-pane ──
        val contentCardLayout = CardLayout()
        val contentCards = JPanel(contentCardLayout)
        contentCards.add(accordionPanel, CARD_ACCORDION)

        val kbPanel = KBExplorerPanel(project, service)
        contentCards.add(kbPanel, CARD_KB)

        val knowledgePanel = buildKnowledgePlaceholder()
        contentCards.add(knowledgePanel, CARD_KNOWLEDGE)

        // StatusPanel lives directly as a card so the status button can swap it in
        // to occupy the full content area (matches VS Code's full-pane status view).
        contentCards.add(statusPanel, CARD_STATUS)

        // Fixed bottom action bar (Current Branch view only): Commit · Create PR · ⋯ More
        val actionBar = ActionBarPanel(project, service)

        // Status full-pane controller: shows the STATUS card over the accordion.
        // Driven by the title-bar Status toggle and auto-shown when Jolli is disabled.
        var statusShown = false
        fun setStatusShown(shown: Boolean) {
            statusShown = shown
            contentCardLayout.show(contentCards, if (shown) CARD_STATUS else CARD_ACCORDION)
        }

        // ── Title-bar actions: Agents · Settings · Status · Cloud sync ──
        // These live in the tool window header (the "Jolli Memory" title bar),
        // matching the mockup's view-title icon group.
        val agentsAction = object : AnAction(
            "Agent Access", "Agent access — what your AI tools can reach", AllIcons.Nodes.Plugin,
        ), DumbAware {
            override fun actionPerformed(e: com.intellij.openapi.actionSystem.AnActionEvent) {
                com.intellij.openapi.ui.Messages.showInfoMessage(
                    project, "Agent access settings are coming soon.", "Agent Access",
                )
            }
        }
        val settingsAction = object : AnAction(
            "Settings", "Open Jolli Memory settings", AllIcons.General.GearPlain,
        ), DumbAware {
            override fun actionPerformed(e: com.intellij.openapi.actionSystem.AnActionEvent) {
                SettingsDialog(project, service).show()
            }
        }
        val statusAction = object : com.intellij.openapi.actionSystem.ToggleAction(
            "Status", "Toggle the Jolli Memory status panel", JolliMemoryIcons.CircleGreen,
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
        // "Agent Access" is a coming-soon stub — keep it out of the title bar until
        // it does something (the action object stays defined so re-enabling is a flag flip).
        val titleActions = buildList {
            if (FeatureFlags.SHOW_UNFINISHED) add(agentsAction)
            add(settingsAction)
            add(statusAction)
            add(CloudSyncAction())
        }
        toolWindow.setTitleActions(titleActions)

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
        )

        // View switch (Current Branch / Memory Bank / Knowledge) above the breadcrumb.
        // The switch logic is a named function so the back-fill card's "Open your Memory Bank"
        // button can drive it too (via `openMemoryBank`), keeping the switcher UI in sync.
        fun applyView(view: ViewSwitchPanel.View) {
            // Switching views replaces the status card with a real view card.
            statusShown = false
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

        // Auto-switch to the STATUS card when Jolli Memory is disabled (preserves
        // the install/setup discoverability), and auto-return once it's enabled.
        // When enabled, only dismiss the status card if it was being shown — don't
        // disturb the Memory Bank / Knowledge views.
        fun syncStatusCard() {
            val enabled = service.getStatus()?.enabled == true
            if (!enabled) {
                setStatusShown(true)
            } else if (statusShown) {
                setStatusShown(false)
            }
        }
        syncStatusCard()
        val statusSyncListener: () -> Unit = { SwingUtilities.invokeLater { syncStatusCard() } }
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
        val mainPanel = JPanel(BorderLayout()).apply {
            add(northWrapper, BorderLayout.NORTH)
            add(contentCards, BorderLayout.CENTER)
            add(actionBar, BorderLayout.SOUTH)
        }

        // ── Onboarding / Main card layout ──────────────────────
        val rootCardLayout = CardLayout()
        val rootPanel = JPanel(rootCardLayout)

        fun isConfigured(): Boolean {
            val config = SessionTracker.loadConfigFromDir(SessionTracker.getGlobalConfigDir())
            if (config.paused == true) return true
            if (!config.apiKey.isNullOrBlank()) return true
            if (!System.getenv("ANTHROPIC_API_KEY").isNullOrBlank()) return true
            if (!config.jolliApiKey.isNullOrBlank()) return true
            return false
        }

        fun syncView() {
            rootCardLayout.show(rootPanel, if (isConfigured()) CARD_MAIN else CARD_ONBOARDING)
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

        rootPanel.add(onboardingPanel, CARD_ONBOARDING)
        rootPanel.add(mainPanel, CARD_MAIN)

        // Auth listener on the factory: handles sign-in → main, sign-out → onboarding
        val factoryAuthDisposable = JolliAuthService.addAuthListener {
            if (!JolliAuthService.isSignedIn()) {
                val config = SessionTracker.loadConfigFromDir(SessionTracker.getGlobalConfigDir())
                val hasCredentials = !config.apiKey.isNullOrBlank() ||
                    !System.getenv("ANTHROPIC_API_KEY").isNullOrBlank() ||
                    !config.jolliApiKey.isNullOrBlank()
                if (!hasCredentials) {
                    ApplicationManager.getApplication().executeOnPooledThread {
                        service.uninstall()
                        ai.jolli.jollimemory.core.telemetry.Telemetry.track("surface_disabled", mapOf("trigger" to "auto_signout"))
                        service.refreshStatus()
                    }
                }
            }
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
        private const val CARD_ACCORDION = "accordion"
        private const val CARD_KB = "kb"
        private const val CARD_KNOWLEDGE = "knowledge"
        private const val CARD_STATUS = "status"
    }
}

/**
 * Picks the status-circle icon (green / yellow / red) for the current service state.
 * Shared by the title-bar Status action and the hover status indicator so both always agree:
 *   - red    → not enabled / no status
 *   - yellow → enabled but degraded (missing creds/hooks, scan errors, Node/MCP unavailable)
 *   - green  → all good
 */
private fun statusCircleIcon(service: JolliMemoryService): javax.swing.Icon {
    val status = service.getStatus()
    return when {
        status == null || !status.enabled -> JolliMemoryIcons.CircleRed
        statusHasWarnings(service, status) -> JolliMemoryIcons.CircleYellow
        else -> JolliMemoryIcons.CircleGreen
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

        // Error
        val err = service.lastError
        if (err != null) {
            sb.append("<p><span style='color:#F85149'>\u25CF</span> <b>Error:</b> $err</p>")
        }

        sb.append("</div></html>")
        return sb.toString()
    }
}

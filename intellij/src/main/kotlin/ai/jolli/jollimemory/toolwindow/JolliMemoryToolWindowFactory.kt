package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.actions.CloudSyncAction
import ai.jolli.jollimemory.actions.TogglePanelAction
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliApiClient
import ai.jolli.jollimemory.services.JolliAuthService
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vcs.ProjectLevelVcsManager
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

        createFullContent(project, toolWindow)
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

        // Listen for VCS changes — when .git appears, rebuild with full UI
        val connection = project.messageBus.connect()
        connection.subscribe(
            ProjectLevelVcsManager.VCS_CONFIGURATION_CHANGED,
            VcsListener {
                if (basePath != null && java.io.File(basePath, ".git").exists()) {
                    connection.disconnect()
                    SwingUtilities.invokeLater {
                        toolWindow.contentManager.removeAllContents(true)
                        createFullContent(project, toolWindow)
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
        )
        val currentMemoryCollapsible = CollapsiblePanel(
            "CURRENT MEMORY", "JolliMemory.CurrentMemoryActions", currentMemoryPanel,
        )
        val memoriesCollapsible = CollapsiblePanel(
            "COMMITTED MEMORIES", "JolliMemory.CommitsActions", commitsPanel,
        )

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
            pinnedCollapsible.alignmentX = Component.LEFT_ALIGNMENT
            currentMemoryCollapsible.alignmentX = Component.LEFT_ALIGNMENT
            memoriesCollapsible.alignmentX = Component.LEFT_ALIGNMENT
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
            "Status", "Toggle the Jolli Memory status panel", JolliMemoryIcons.Pulse,
        ), DumbAware {
            override fun isSelected(e: com.intellij.openapi.actionSystem.AnActionEvent): Boolean = statusShown
            override fun setSelected(e: com.intellij.openapi.actionSystem.AnActionEvent, state: Boolean) {
                setStatusShown(state)
            }
        }
        toolWindow.setTitleActions(listOf(agentsAction, settingsAction, statusAction, CloudSyncAction()))

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
        val viewSwitch = ViewSwitchPanel { view ->
            // Switching views replaces the status card with a real view card.
            statusShown = false
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
        val content = ContentFactory.getInstance().createContent(rootPanel, "", false).apply {
            isCloseable = false
            setDisposer(Disposer.newDisposable("JolliMemoryContent").also { parentDisposable ->
                Disposer.register(parentDisposable, onboardingPanel)
                Disposer.register(parentDisposable, factoryAuthDisposable)
                Disposer.register(parentDisposable, statusListenerDisposable)
                Disposer.register(parentDisposable, syncViewDisposable)
                Disposer.register(parentDisposable, statusPanel)
                Disposer.register(parentDisposable, plansPanel)
                Disposer.register(parentDisposable, changesPanel)
                Disposer.register(parentDisposable, commitsPanel)
                Disposer.register(parentDisposable, conversationsPanel)
                Disposer.register(parentDisposable, pinnedPanel)
                Disposer.register(parentDisposable, currentMemoryPanel)
                Disposer.register(parentDisposable, kbPanel)
            })
        }

        // Update breadcrumb on branch switch — multiple detection paths
        val updateBreadcrumbBranch: () -> Unit = {
            val newBranch = service.getGitOps()?.getCurrentBranch()
            if (newBranch != null) breadcrumb.updateCurrentBranch(newBranch)
        }

        // Path 1: IntelliJ git repository change event
        val branchUpdateConnection = project.messageBus.connect()
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
        val status = service.getStatus()
        icon = when {
            // Not enabled or no status — red
            status == null || !status.enabled -> JolliMemoryIcons.CircleRed

            // Enabled but has warnings (missing hooks, lastError set)
            hasWarnings(status) -> JolliMemoryIcons.CircleYellow

            // All good — green
            else -> JolliMemoryIcons.CircleGreen
        }
    }

    /**
     * Checks whether the current status has any warnings:
     * - No LLM credentials configured (selected provider can't work)
     * - Service has a lastError
     * - Git hooks not fully installed
     * - Claude hooks not installed when Claude is detected
     * - Gemini hooks not installed when Gemini is detected
     */
    private fun hasWarnings(status: ai.jolli.jollimemory.core.StatusInfo): Boolean {
        // Check if the selected provider's credential is missing
        val config = SessionTracker.loadConfigFromDir(SessionTracker.getGlobalConfigDir())
        when (config.aiProvider) {
            "anthropic" -> {
                if (config.apiKey.isNullOrBlank() && System.getenv("ANTHROPIC_API_KEY").isNullOrBlank()) return true
            }
            "jolli" -> {
                if (config.jolliApiKey.isNullOrBlank()) return true
            }
            else -> {
                // No provider set — warn if nothing at all
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
        return false
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

        // Hooks
        val hookParts = mutableListOf<String>()
        if (status.gitHookInstalled) hookParts.add("3 Git")
        if (status.claudeHookInstalled) hookParts.add("2 Claude")
        if (status.geminiHookInstalled) hookParts.add("1 Gemini CLI")
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

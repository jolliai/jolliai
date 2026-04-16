package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.JolliMemoryIcons
import ai.jolli.jollimemory.actions.TogglePanelAction
 import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliApiClient
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vcs.ProjectLevelVcsManager
import com.intellij.openapi.vcs.VcsListener
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBLabel
import com.intellij.ui.content.ContentFactory
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Cursor
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.Popup
import javax.swing.PopupFactory
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

        // Create the five panels
        val statusPanel = StatusPanel(project, service)
        val plansPanel = PlansPanel(project, service)
        val changesPanel = ChangesPanel(project, service)
        val commitsPanel = CommitsPanel(project, service)
        val memoriesPanel = MemoriesPanel(project, service)

        // Register panels for action lookup
        val registry = PanelRegistry().apply {
            this.statusPanel = statusPanel
            this.plansPanel = plansPanel
            this.changesPanel = changesPanel
            this.commitsPanel = commitsPanel
            this.memoriesPanel = memoriesPanel
        }
        service.panelRegistry = registry

        // Status indicator icon for the MEMORIES header — shows health as green/yellow/red circle.
        // Hover triggers a popup with the full status details (same content as the STATUS panel).
        val statusIndicator = StatusIndicatorLabel(service)

        // Build collapsible sections (uppercase titles)
        val statusCollapsible = CollapsiblePanel("STATUS", "JolliMemory.StatusActions", statusPanel)
        val plansCollapsible = CollapsiblePanel("PLANS & NOTES", "JolliMemory.PlansActions", plansPanel)
        val changesCollapsible = CollapsiblePanel("CHANGES", "JolliMemory.ChangesActions", changesPanel)
        val commitsCollapsible = CollapsiblePanel("COMMITS", "JolliMemory.CommitsActions", commitsPanel)
        val memoriesCollapsible = CollapsiblePanel(
            "MEMORIES", "JolliMemory.MemoriesActions", memoriesPanel,
            headerExtra = statusIndicator,
        )

        // Auto-hide STATUS panel when enabled, show when disabled
        fun syncStatusVisibility() {
            val status = service.getStatus()
            val enabled = status?.enabled == true
            statusCollapsible.setPanelVisible(!enabled)
        }
        syncStatusVisibility()
        service.addStatusListener { SwingUtilities.invokeLater { syncStatusVisibility() } }

        // Use an accordion layout so collapsed panels shrink to header-only height
        // and expanded panels share the remaining vertical space proportionally.
        // Resize dividers between panels allow users to drag and adjust panel heights.
        val accordionPanel = JPanel(AccordionLayout()).apply {
            add(statusCollapsible)
            add(ResizeDivider())
            add(memoriesCollapsible)
            add(ResizeDivider())
            add(plansCollapsible)
            add(ResizeDivider())
            add(changesCollapsible)
            add(ResizeDivider())
            add(commitsCollapsible)
        }

        // Add gear menu toggle actions to the tool window title bar,
        // allowing users to show/hide individual panels — like VS Code's "..." menu.
        val gearActions = DefaultActionGroup().apply {
            add(TogglePanelAction(statusCollapsible))
            add(TogglePanelAction(memoriesCollapsible))
            add(TogglePanelAction(plansCollapsible))
            add(TogglePanelAction(changesCollapsible))
            add(TogglePanelAction(commitsCollapsible))
        }
        toolWindow.setAdditionalGearActions(gearActions)

        val content = ContentFactory.getInstance().createContent(accordionPanel, "", false).apply {
            setDisposer(Disposer.newDisposable("JolliMemoryToolWindowContent").also { parentDisposable ->
                Disposer.register(parentDisposable, statusPanel)
                Disposer.register(parentDisposable, plansPanel)
                Disposer.register(parentDisposable, changesPanel)
                Disposer.register(parentDisposable, commitsPanel)
                Disposer.register(parentDisposable, memoriesPanel)
            })
        }
        toolWindow.contentManager.addContent(content)
    }

    override fun shouldBeAvailable(project: Project): Boolean {
        // Always available — the tool window shows a "no Git" message when
        // .git is absent, and the full panel UI when Git is present.
        return project.basePath != null
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
     * - Service has a lastError
     * - Git hooks not fully installed
     * - Claude hooks not installed when Claude is detected
     * - Gemini hooks not installed when Gemini is detected
     */
    private fun hasWarnings(status: ai.jolli.jollimemory.core.StatusInfo): Boolean {
        if (service.lastError != null) return true
        if (!status.gitHookInstalled) return true
        if (status.claudeDetected == true && !status.claudeHookInstalled) return true
        if (status.geminiDetected == true && !status.geminiHookInstalled) return true
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

        // Hooks
        val hookParts = mutableListOf<String>()
        if (status.gitHookInstalled) hookParts.add("3 Git")
        if (status.claudeHookInstalled) hookParts.add("2 Claude")
        if (status.geminiHookInstalled) hookParts.add("1 Gemini CLI")
        val hooksDesc = if (hookParts.isNotEmpty()) hookParts.joinToString(" + ") else "none installed"
        val hookColor = if (status.gitHookInstalled) "#3FB950" else "#F85149"
        sb.append("<p><span style='color:$hookColor'>\u25CF</span> <b>Hooks:</b> $hooksDesc</p>")

        // Sessions
        sb.append("<p><span style='color:#3FB950'>\u25CF</span> <b>Sessions:</b> ${status.activeSessions}</p>")

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

        // Error
        val err = service.lastError
        if (err != null) {
            sb.append("<p><span style='color:#F85149'>\u25CF</span> <b>Error:</b> $err</p>")
        }

        sb.append("</div></html>")
        return sb.toString()
    }
}

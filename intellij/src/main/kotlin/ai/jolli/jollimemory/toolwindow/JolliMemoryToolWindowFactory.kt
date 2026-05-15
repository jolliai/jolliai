package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliAuthService
import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.toolwindow.sidebar.JCEFFallbackPanel
import ai.jolli.jollimemory.toolwindow.sidebar.JCEFSidebarPanel
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vcs.ProjectLevelVcsManager
import com.intellij.openapi.vcs.VcsListener
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBLabel
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefApp
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.CardLayout
import javax.swing.JPanel
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
     * Creates the full tool window content using the unified JCEF webview sidebar.
     *
     * Falls back to JCEFFallbackPanel when JCEF is unavailable.
     * Uses a CardLayout to switch between onboarding and main views.
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

        // Create the JCEF sidebar or fallback panel
        val contentDisposable = Disposer.newDisposable("JolliMemorySidebarContent")
        val mainPanel: JPanel = if (JBCefApp.isSupported()) {
            JCEFSidebarPanel(project, contentDisposable)
        } else {
            JCEFFallbackPanel()
        }

        rootPanel.add(onboardingPanel, CARD_ONBOARDING)
        rootPanel.add(mainPanel, CARD_MAIN)

        // Auth listener: handles sign-in → main, sign-out → onboarding
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
            SwingUtilities.invokeLater {
                syncView()
                // Notify sidebar that configured state changed
                if (mainPanel is JCEFSidebarPanel) {
                    mainPanel.pushConfiguredChanged(isConfigured())
                }
            }
        }

        syncView()

        // Sync view on status changes
        service.addStatusListener {
            SwingUtilities.invokeLater {
                syncView()
                if (mainPanel is JCEFSidebarPanel) {
                    mainPanel.pushConfiguredChanged(isConfigured())
                }
            }
        }

        val content = ContentFactory.getInstance().createContent(rootPanel, "", false).apply {
            isCloseable = false
            setDisposer(contentDisposable.also { parentDisposable ->
                Disposer.register(parentDisposable, onboardingPanel)
                Disposer.register(parentDisposable, factoryAuthDisposable)
            })
        }

        toolWindow.contentManager.addContent(content)
    }

    override fun shouldBeAvailable(project: Project): Boolean {
        return project.basePath != null
    }

    companion object {
        private const val CARD_ONBOARDING = "onboarding"
        private const val CARD_MAIN = "main"
    }
}

package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.core.JmLogger
import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

/**
 * Runs after project opens — initializes the JolliMemory service
 * and auto-detects whether hooks are already installed.
 *
 * When the project has no Git repository, shows a one-time balloon
 * notification suggesting the user run `git init`.
 */
class JolliMemoryStartupActivity : ProjectActivity {

    private val log = JmLogger.create("StartupActivity")

    override suspend fun execute(project: Project) {
        val basePath = project.basePath ?: return
        // Ensure JmLogger can write before any log calls in this class or downstream.
        JmLogger.setLogDir(basePath)
        JmLogger.setLogLevel(ai.jolli.jollimemory.core.LogLevel.debug)

        // .git is a directory in normal repos, but a file in worktrees
        val gitEntry = java.io.File(basePath, ".git")
        if (!gitEntry.exists()) {
            log.info("JolliMemory: no .git found at $basePath, showing notification")
            NotificationGroupManager.getInstance()
                .getNotificationGroup("JolliMemory")
                .createNotification(
                    "Jolli Memory requires Git",
                    "Run <code>git init</code> in your project directory or use " +
                        "<b>VCS \u2192 Enable Version Control Integration</b> " +
                        "to start using Jolli Memory.",
                    NotificationType.INFORMATION,
                )
                .notify(project)
            return
        }

        log.info("JolliMemory: initializing for project at $basePath")
        val service = project.getService(JolliMemoryService::class.java)
        service.initialize()

        log.info("JolliMemory: activating sync for project at $basePath")
        ai.jolli.jollimemory.sync.SyncActivation.activateSync(project, service)

        // Telemetry (JOLLI-1785): bootstrap anonymous, content-free usage
        // telemetry, fire app_installed once per machine, flush anything buffered
        // by prior sessions/hooks, and show the loud first-run notice once.
        try {
            val showNotice = ai.jolli.jollimemory.core.telemetry.TelemetryActivation.bootstrap(basePath)
            ai.jolli.jollimemory.core.telemetry.TelemetryActivation.flushNow(basePath)
            if (showNotice) {
                ai.jolli.jollimemory.core.telemetry.TelemetrySharedConfig.markNoticeShown()
                NotificationGroupManager.getInstance()
                    .getNotificationGroup("JolliMemory")
                    .createNotification(
                        "Jolli Memory usage telemetry",
                        "Anonymous, content-free usage telemetry (never code, paths, or memory content) is on to " +
                            "improve the product. Turn it off any time with <code>jolli telemetry off</code>, the " +
                            "<code>DO_NOT_TRACK</code> env var, or the IDE's data-sharing setting.",
                        NotificationType.INFORMATION,
                    )
                    .addAction(NotificationAction.createSimple("Learn more") {
                        BrowserUtil.browse("https://www.jolli.ai/telemetry")
                    })
                    .addAction(NotificationAction.createSimple("Turn off") {
                        ai.jolli.jollimemory.core.telemetry.TelemetrySharedConfig.setTelemetry(false)
                        ai.jolli.jollimemory.core.telemetry.Telemetry.shutdown()
                    })
                    .notify(project)
            }
        } catch (e: Exception) {
            log.warn("Telemetry bootstrap failed (ignored): ${e.message}")
        }

        log.info("JolliMemory: startup complete for project at $basePath")
    }
}

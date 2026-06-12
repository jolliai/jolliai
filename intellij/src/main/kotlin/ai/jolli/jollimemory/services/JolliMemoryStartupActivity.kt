package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.core.JmLogger
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
        log.info("JolliMemory: startup complete for project at $basePath")
    }
}

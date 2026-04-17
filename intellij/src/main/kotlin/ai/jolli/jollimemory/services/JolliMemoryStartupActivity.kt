package ai.jolli.jollimemory.services

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.diagnostic.Logger
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

    private val log = Logger.getInstance(JolliMemoryStartupActivity::class.java)

    override suspend fun execute(project: Project) {
        val basePath = project.basePath ?: return
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
    }
}

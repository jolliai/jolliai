package ai.jolli.jollimemory.toolwindow

import com.intellij.notification.Notification
import com.intellij.notification.NotificationType
import com.intellij.notification.Notifications
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import org.jetbrains.plugins.terminal.TerminalToolWindowManager

/** Shared terminal helpers used by sidebar panels for resuming conversations. */
object TerminalUtils {

	private val log = Logger.getInstance(TerminalUtils::class.java)

	/** Opens a new terminal tab in the given [cwd] and runs `claude --resume <sessionId>`. */
	fun resumeClaudeSession(project: Project, sessionId: String, cwd: String, title: String = "Claude – resume") {
		try {
			val widget = TerminalToolWindowManager.getInstance(project)
				.createLocalShellWidget(cwd, title)
			widget.executeCommand("claude --resume $sessionId")
		} catch (e: Exception) {
			log.warn("Failed to open terminal for session resume: ${e.message}", e)
			Notifications.Bus.notify(
				Notification("JolliMemory", "Resume Session", "Could not resume session — terminal unavailable.", NotificationType.WARNING),
				project,
			)
		}
	}
}

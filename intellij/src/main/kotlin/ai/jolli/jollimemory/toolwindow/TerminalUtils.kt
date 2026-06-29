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

	/** Whether [source] supports resuming a session from the terminal. */
	fun canResumeSource(source: String): Boolean = source.lowercase() in setOf("claude", "codex")

	/**
	 * Opens a new terminal tab in the given [cwd] and runs the source-appropriate
	 * resume command: `claude --resume <id>` for Claude, `codex resume <id>` for
	 * Codex. Unsupported sources are a no-op (a warning notification).
	 */
	fun resumeSession(project: Project, source: String, sessionId: String, cwd: String, title: String? = null) {
		val src = source.lowercase()
		val command = when (src) {
			"codex" -> "codex resume $sessionId"
			"claude" -> "claude --resume $sessionId"
			else -> {
				log.warn("Resume requested for unsupported source: $source")
				Notifications.Bus.notify(
					Notification("JolliMemory", "Resume Session", "Resuming isn't supported for this conversation type.", NotificationType.WARNING),
					project,
				)
				return
			}
		}
		val tabTitle = title ?: if (src == "codex") "Codex – resume" else "Claude – resume"
		try {
			val widget = TerminalToolWindowManager.getInstance(project)
				.createLocalShellWidget(cwd, tabTitle)
			widget.executeCommand(command)
		} catch (e: Exception) {
			log.warn("Failed to open terminal for session resume: ${e.message}", e)
			Notifications.Bus.notify(
				Notification("JolliMemory", "Resume Session", "Could not resume session — terminal unavailable.", NotificationType.WARNING),
				project,
			)
		}
	}
}

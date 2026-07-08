package ai.jolli.jollimemory.backfill

import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.services.JolliMemoryService
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project

/**
 * BackfillRunner — the single background entry point for generating summaries over
 * historical commits, shared by BOTH the tool-window cold-start card and the Settings
 * "Generate Missing Summaries" button. Kotlin analog of the VS Code extension's shared
 * `runBackfillJob` (vscode/src/Extension.ts): it drives [BackfillCli.run] inside an
 * IntelliJ [Task.Backgroundable] (cancellable, with a determinate progress bar), then
 * updates cold-start bookkeeping and shows a completion balloon.
 */
object BackfillRunner {

	private val log = JmLogger.create("BackfillRunner")

	/**
	 * Runs a back-fill in the background.
	 *
	 * @param hashes commit subset to generate; EMPTY means full scope (every own commit
	 *   lacking a summary) — the Settings path.
	 * @param onProgress optional per-commit callback on the EDT (the card's inline list).
	 * @param onComplete optional completion callback on the EDT with the final report
	 *   (null when the engine could not run — see the balloon for the reason).
	 */
	fun run(
		project: Project,
		service: JolliMemoryService,
		hashes: List<String>,
		onProgress: ((BackfillCli.Progress) -> Unit)? = null,
		onComplete: ((BackfillCli.Report?) -> Unit)? = null,
	) {
		val cwd = service.mainRepoRoot ?: project.basePath
		if (cwd == null) {
			onComplete?.let { ApplicationManager.getApplication().invokeLater { it(null) } }
			return
		}
		ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Jolli Memory: Back-filling summaries", true) {
			override fun run(indicator: ProgressIndicator) {
				indicator.isIndeterminate = false
				val outcome = BackfillCli.run(
					projectDir = cwd,
					hashes = hashes,
					onProgress = { p ->
						if (p.total > 0) indicator.fraction = p.done.toDouble() / p.total
						indicator.text = "${p.done}/${p.total} — ${label(p.subject)}${if (p.status == "error") " (failed)" else ""}"
						onProgress?.let { cb -> ApplicationManager.getApplication().invokeLater { cb(p) } }
					},
					shouldCancel = { indicator.isCanceled },
				)
				ApplicationManager.getApplication().invokeLater { finish(project, service, outcome, onComplete) }
			}
		})
	}

	private fun finish(
		project: Project,
		service: JolliMemoryService,
		outcome: BackfillCli.Outcome<BackfillCli.Report>,
		onComplete: ((BackfillCli.Report?) -> Unit)?,
	) {
		when (outcome) {
			is BackfillCli.Outcome.Ok -> {
				val r = outcome.value
				service.onBackfillCompleted(r.generated > 0)
				// Refresh the surfaces that render summary state (Committed Memories list, etc.).
				service.notifyMemoryStateChanged()
				if (r.total == 0) {
					// No candidate commits — e.g. a repo where none of the commits are yours.
					notify(
						project,
						"Jolli Memory: nothing to back-fill",
						"No commits authored by you are missing a memory.",
						NotificationType.INFORMATION,
					)
				} else if (r.errors > 0) {
					notify(
						project,
						"Jolli Memory: back-fill finished with errors",
						"${r.generated} generated, ${r.skipped} skipped, ${r.errors} error(s).",
						NotificationType.WARNING,
					)
				} else {
					notify(
						project,
						"Jolli Memory: back-fill complete",
						"${r.generated} summary(ies) generated, ${r.skipped} already had one.",
						NotificationType.INFORMATION,
					)
				}
				onComplete?.invoke(r)
			}
			is BackfillCli.Outcome.NodeMissing -> {
				notify(
					project,
					"Jolli Memory: back-fill unavailable",
					"Node.js was not found on your PATH — historical summaries need it to run. " +
						"Install Node.js and reopen the project.",
					NotificationType.WARNING,
				)
				onComplete?.invoke(null)
			}
			is BackfillCli.Outcome.BundleMissing -> {
				notify(
					project,
					"Jolli Memory: back-fill unavailable",
					"The bundled CLI could not be located — try reinstalling the Jolli Memory plugin.",
					NotificationType.WARNING,
				)
				onComplete?.invoke(null)
			}
			is BackfillCli.Outcome.Failed -> {
				log.warn("back-fill failed: %s", outcome.message)
				if (outcome.message != "cancelled") {
					notify(
						project,
						"Jolli Memory: back-fill failed",
						outcome.message,
						NotificationType.WARNING,
					)
				}
				onComplete?.invoke(null)
			}
		}
	}

	/** Truncates a commit subject for the progress line (matches VS Code's 60-char cap). */
	private fun label(subject: String): String =
		if (subject.length > 60) "${subject.take(57)}…" else subject

	private fun notify(project: Project, title: String, content: String, type: NotificationType) {
		NotificationGroupManager.getInstance()
			.getNotificationGroup("JolliMemory")
			.createNotification(title, content, type)
			.notify(project)
	}
}

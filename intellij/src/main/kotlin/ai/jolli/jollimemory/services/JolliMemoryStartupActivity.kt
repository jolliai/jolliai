package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.bridge.NodeRuntime
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.util.escapeHtml
import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.util.Disposer
import com.intellij.util.concurrency.AppExecutorUtil
import java.util.concurrent.TimeUnit

/**
 * Runs after project opens — initializes the JolliMemory service
 * and auto-detects whether hooks are already installed.
 *
 * When the project has no Git repository, shows a one-time balloon
 * notification suggesting the user run `git init`.
 *
 * When no usable Node.js runtime is found, startup is BLOCKED: an error
 * notification is shown and none of the startup sequence runs. The tool
 * window independently shows a blocking "Node.js required" panel whose
 * Retry button calls [retryNodeDetection] to re-probe and, on success,
 * complete the startup sequence that was skipped here.
 */
class JolliMemoryStartupActivity : ProjectActivity {

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

        // Hard gate: a usable Node.js runtime is required before ANY startup logic
        // runs. Detection is blocking (shell probes) — fine here, this coroutine is
        // off the EDT. When missing, notify and stop; the tool window shows the
        // blocking panel with the Retry entry point.
        if (NodeRuntime.detect() == null) {
            log.warn("JolliMemory: no usable Node.js runtime found — startup blocked")
            // Prefer a specific "installed but too old" message over the generic "not
            // found" when detection actually saw Node — it's much more actionable and
            // matches what the tool window's blocking panel says.
            val rejected = NodeRuntime.rejectedFromLastDetection()
            val leading = if (rejected.isEmpty()) {
                "No usable Node.js runtime was found on this machine, so Jolli Memory is blocked."
            } else {
                val details = rejected.joinToString("; ") { r ->
                    "${escapeHtml(r.version)} at ${escapeHtml(r.path)}"
                }
                "Node.js is installed but too old (need v18 or newer): $details. " +
                    "Jolli Memory is blocked."
            }
            NotificationGroupManager.getInstance()
                .getNotificationGroup("JolliMemory")
                .createNotification(
                    "Jolli Memory requires Node.js",
                    "$leading Install Node.js 18 or newer (LTS recommended) and click " +
                        "<b>Retry detection</b> in the Jolli Memory tool window — or point it at " +
                        "an existing binary there with <b>Choose manually</b>.",
                    NotificationType.ERROR,
                )
                .addAction(NotificationAction.createSimple("Download Node.js") {
                    BrowserUtil.browse("https://nodejs.org/en/download")
                })
                .notify(project)
            return
        }

        runPostNodeStartup(project)
    }

    companion object {

        private val log = JmLogger.create("StartupActivity")

        /**
         * Forces a fresh Node probe and, when a runtime is found, completes the
         * startup sequence that the Node gate skipped. Returns whether Node was
         * found. Blocking (shell probes + full startup) — call from a pooled
         * thread, never the EDT. Used by the tool window's Retry button.
         */
        fun retryNodeDetection(project: Project): Boolean {
            if (NodeRuntime.detect(forceRefresh = true) == null) return false
            runPostNodeStartup(project)
            return true
        }

        /**
         * The startup sequence that runs once the Node gate has passed: service
         * initialization, daemon notification channel start, sync activation,
         * cold-start back-fill signals, and telemetry bootstrap/flush scheduling.
         */
        internal fun runPostNodeStartup(project: Project) {
            val basePath = project.basePath ?: return

            log.info("JolliMemory: initializing for project at $basePath")
            val service = project.getService(JolliMemoryService::class.java)
            service.initialize()

            // Slice-1 daemon channel: replaces the in-process refresh signal the retired
            // Kotlin PostCommitHook used to fire. The client spawns `jolli daemon` and
            // dispatches `refresh` notifications to JolliMemoryService.refreshStatus.
            try {
                project.getService(ai.jolli.jollimemory.bridge.DaemonNotificationClient::class.java).start()
            } catch (e: Exception) {
                log.warn("Daemon notification client start failed (ignored): ${e.message}")
            }

            log.info("JolliMemory: activating sync for project at $basePath")
            ai.jolli.jollimemory.sync.SyncActivation.activateSync(project, service)

            // Cold-start back-fill signals (Kotlin analog of VS Code's computeColdStartSignals):
            // decide whether to offer "build memory from your history" in the tool window. Runs
            // on a pooled thread because it shells out to `jolli backfill --list-candidates`, so
            // it never delays project startup; the tool window updates via a backfill listener.
            com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
                try {
                    service.computeColdStartSignals()
                } catch (e: Exception) {
                    log.warn("Cold-start signal compute failed (ignored): ${e.message}")
                }
            }

            // Telemetry (JOLLI-1785): bootstrap anonymous, content-free usage
            // telemetry, fire app_installed once per machine, flush anything buffered
            // by prior sessions/hooks, and show the loud first-run notice once.
            try {
                val showNotice = ai.jolli.jollimemory.core.telemetry.TelemetryActivation.bootstrap(basePath)
                // JOLLI-1963: count new + upgrade installs. Fires once per project open
                // (a real session), carrying surface_version; first-seen (install_id,
                // surface_version) ≈ new + upgrade installs. Emitted here (not in
                // TelemetryActivation.bootstrap, which the git hooks also call) so hook
                // runs don't flood it. No-op when telemetry is off.
                ai.jolli.jollimemory.core.telemetry.Telemetry.track("client_activated")
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

            // JOLLI-1956: periodic telemetry flush, decoupled from the tool window's
            // visibility. The Active Conversations 60s tick only flushes while that
            // panel is showing, so a user who keeps the tool window closed would never
            // drain the shared buffer. Schedule a background flush tied to the project
            // lifecycle (cancelled on project close). Runs off the EDT — flushNow does
            // blocking HTTP — and is best-effort (flushNow re-gates consent, never throws).
            try {
                val flushFuture =
                    AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(
                        { ai.jolli.jollimemory.core.telemetry.TelemetryActivation.flushNow(basePath) },
                        60L,
                        60L,
                        TimeUnit.SECONDS,
                    )
                Disposer.register(project, Disposable { flushFuture.cancel(false) })
            } catch (e: Exception) {
                log.warn("Telemetry flush scheduling failed (ignored): ${e.message}")
            }

            log.info("JolliMemory: startup complete for project at $basePath")
        }
    }
}

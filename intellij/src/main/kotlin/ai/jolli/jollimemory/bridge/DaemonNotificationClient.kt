package ai.jolli.jollimemory.bridge

import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.services.JolliMemoryService
import com.google.gson.JsonParser
import com.google.gson.JsonSyntaxException
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import java.io.BufferedReader
import java.io.File
import java.io.IOException
import java.io.InputStreamReader
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import javax.swing.Timer
import kotlin.math.min

/**
 * A single refresh notification observed on the stdio channel. `kind` is the coarse
 * category (`queue`, `orphan-ref`, `memory-bank`); `cwd` is the project directory the
 * daemon reported for. Consumers should treat the event as "reload from source of
 * truth" and not attempt any diff logic — the diff wire is a read-path feature.
 */
data class RefreshEvent(val kind: String, val cwd: String)

/**
 * Wire-protocol id this client understands. Mirrors `DAEMON_PROTOCOL` in
 * `cli/src/daemon/DaemonProtocol.ts` — a version bump there signals that the
 * refresh payload shape has changed in a way old clients would misinterpret,
 * and this client must disconnect until it is rebuilt. Keep the two in
 * lockstep.
 */
internal const val DAEMON_PROTOCOL = "jolli-daemon-notify-v1"

/**
 * Structured shape returned by [parseNotification] — a testable seam between the raw
 * JSON wire and the client's stateful dispatch code.
 */
internal sealed class DaemonEvent {
    /**
     * Handshake with the protocol id the daemon advertised. A missing or empty
     * value here is the "old daemon predates the field" shape; the dispatch code
     * treats that identically to a mismatch and disconnects.
     */
    data class Ready(val protocol: String) : DaemonEvent()
    data class Refresh(val kind: String, val cwd: String) : DaemonEvent()
}

/**
 * Parses one daemon notification line into a structured event. Returns null for
 * unrecognized or malformed input — callers should just drop the line rather than
 * killing their read loop. Kept top-level and pure so tests exercise it without the
 * `@Service` bootstrap chain.
 */
internal fun parseNotification(line: String): DaemonEvent? {
    val parsed = try {
        JsonParser.parseString(line).asJsonObject
    } catch (_: JsonSyntaxException) {
        return null
    } catch (_: IllegalStateException) {
        return null
    }
    val method = parsed.get("method")?.asString ?: return null
    return when (method) {
        "ready" -> {
            // A ready without params is an old daemon shape — pass an empty string
            // so the dispatch code's mismatch check catches it and disconnects.
            val protocol = parsed.getAsJsonObject("params")?.get("protocol")?.asString ?: ""
            DaemonEvent.Ready(protocol)
        }
        "refresh" -> {
            val params = parsed.getAsJsonObject("params") ?: return null
            val kind = params.get("kind")?.asString ?: return null
            val cwd = params.get("cwd")?.asString ?: ""
            DaemonEvent.Refresh(kind, cwd)
        }
        else -> null
    }
}

/**
 * Client for the CLI-side `jolli daemon` — a stdio JSON-RPC 2.0 endpoint that emits
 * one-way `refresh` notifications when the project's write outputs settle
 * (QueueWorker drain, orphan-branch ref updates).
 *
 * This is the slice-1 replacement for the in-process refresh signal the retired
 * Kotlin `PostCommitHook` used to fire. The daemon takes NO requests; a
 * request-response channel is deferred to the read-path slice, so this class
 * deliberately carries no inflight bookkeeping.
 *
 * Lifecycle
 *   - `start()` is idempotent — a second call while running is a no-op.
 *   - The read loop parses one JSON object per line on stdout. Malformed lines are
 *     dropped with a debug log rather than killing the loop.
 *   - Refresh events fan out to registered listeners AND drive
 *     `JolliMemoryService.refreshStatus()` on a pooled thread so panels update.
 *   - Crash restart: unexpected exit → exponential backoff (5s / 10s / 20s / 60s cap)
 *     → re-spawn. `stopped` gates the loop for a clean shutdown.
 *   - Shutdown: `dispose()` closes stdin (the daemon's own keepalive), waits 2s for
 *     graceful exit, then destroyForcibly. `dispose()` is called by IntelliJ's
 *     project-scoped Disposable chain.
 */
@Service(Service.Level.PROJECT)
class DaemonNotificationClient(private val project: Project) : Disposable {

    companion object {
        private const val SHUTDOWN_GRACE_MS = 2000L
        private const val REFRESH_DEBOUNCE_MS = 300
        private const val BACKOFF_INITIAL_MS = 5_000L
        private const val BACKOFF_MAX_MS = 60_000L
    }

    private val log = JmLogger.create("DaemonNotificationClient")

    private val listeners = CopyOnWriteArrayList<(RefreshEvent) -> Unit>()
    private val currentProcess = AtomicReference<Process?>(null)
    private val readerThread = AtomicReference<Thread?>(null)
    private val started = AtomicBoolean(false)
    private val stopped = AtomicBoolean(false)

    /**
     * Restart delay, doubled after every unexpected exit up to [BACKOFF_MAX_MS].
     * Reset ONLY after we observe a real refresh (proving the daemon lived long
     * enough to actually watch state) — resetting on `ready` would let a daemon
     * that emits ready and then crashes immediately spin forever at 5 s intervals,
     * with no escalation and no give-up. `@Volatile` because the reader thread
     * writes it and the restart thread reads it.
     */
    @Volatile
    private var backoffMs: Long = BACKOFF_INITIAL_MS
    private var refreshTimer: Timer? = null

    /**
     * Registers a callback fired for every `refresh` notification. Returns a Disposable
     * the caller can `Disposer.dispose()` to unregister.
     */
    fun addRefreshListener(listener: (RefreshEvent) -> Unit): Disposable {
        listeners.add(listener)
        return Disposable { listeners.remove(listener) }
    }

    /** Idempotent start — spawns the daemon subprocess if not already running. */
    fun start() {
        if (stopped.get()) return
        if (!started.compareAndSet(false, true)) return
        spawnDaemon()
    }

    private fun spawnDaemon() {
        if (stopped.get()) {
            started.set(false)
            return
        }
        val cwd = project.basePath
        if (cwd == null) {
            log.info("Project has no basePath; daemon notifications disabled")
            started.set(false)
            return
        }
        val node = CliIntegrations.resolveNode()
        if (node == null) {
            log.info("Node not available; daemon notifications disabled")
            started.set(false)
            return
        }
        val cliJs = File(CliIntegrations.distIntellijDir(), "Cli.js")
        if (!cliJs.exists()) {
            log.info("Cli.js not present at %s; daemon notifications disabled", cliJs.absolutePath)
            started.set(false)
            return
        }
        try {
            val builder = ProcessBuilder(node, cliJs.absolutePath, "daemon", "--cwd", cwd)
                // The daemon may log freely to stderr; if we neither redirect nor
                // drain it, a long session fills the ~64 KB pipe buffer and blocks
                // the child's next stderr write, wedging refresh delivery. DISCARD
                // sends it straight to /dev/null so there is no buffer to fill.
                .redirectError(ProcessBuilder.Redirect.DISCARD)
            val proc = builder.start()
            currentProcess.set(proc)
            // Close the dispose race: if dispose() ran between `stopped.get()`
            // above and now, `getAndSet(null)` there returned null (the process
            // wasn't registered yet), so nobody would ever tear this one down.
            // Re-check and clean up in-line before starting the reader.
            if (stopped.get()) {
                try {
                    proc.outputStream.close()
                } catch (_: IOException) {
                    // Best-effort close before force-kill; ignore.
                }
                proc.destroyForcibly()
                currentProcess.set(null)
                return
            }
            val thread = Thread({ readLoop(proc) }, "jolli-daemon-reader-${project.name}")
            thread.isDaemon = true
            thread.start()
            readerThread.set(thread)
            proc.onExit().thenRun { onProcessExit(proc) }
            log.info("Daemon started (pid=%d, cwd=%s)", proc.pid(), cwd)
        } catch (e: Exception) {
            log.warn("Failed to spawn daemon: %s", e.message)
            scheduleRestart()
        }
    }

    private fun readLoop(proc: Process) {
        val reader = BufferedReader(InputStreamReader(proc.inputStream, Charsets.UTF_8))
        try {
            while (!stopped.get()) {
                val line = reader.readLine() ?: break
                if (line.isBlank()) continue
                dispatchLine(line)
            }
        } catch (e: IOException) {
            if (!stopped.get()) log.debug("Daemon read loop ended: %s", e.message)
        } finally {
            try {
                reader.close()
            } catch (_: IOException) {
                // Best-effort close: the underlying stream may already be dead if the
                // subprocess exited between the last readLine and this cleanup.
            }
        }
    }

    /** Package-private for tests: parse one line and route it. */
    internal fun dispatchLine(line: String) {
        when (val event = parseNotification(line)) {
            null -> log.debug("Dropping unparseable daemon line")
            is DaemonEvent.Ready -> {
                if (event.protocol != DAEMON_PROTOCOL) {
                    // Protocol mismatch means the payload shape may have changed
                    // in a way this client would misinterpret. Per the wire
                    // contract (DaemonProtocol.ts), disconnect and let the
                    // restart backoff decide whether to try again. Do NOT reset
                    // backoff — a mismatched daemon isn't proof of health.
                    log.warn(
                        "Daemon protocol mismatch (got '%s', expected '%s'); disconnecting",
                        event.protocol,
                        DAEMON_PROTOCOL,
                    )
                    disconnectCurrentProcess()
                    return
                }
                log.info("Daemon handshake received (protocol=%s)", event.protocol)
                // Backoff reset is deferred to the first real refresh, which
                // proves the daemon actually lived long enough to arm watchers
                // — a ready-then-crash loop should escalate, not spin at 5 s.
            }
            is DaemonEvent.Refresh -> onRefresh(RefreshEvent(event.kind, event.cwd))
        }
    }

    /**
     * Tears down the currently registered subprocess so the reader thread
     * unblocks and [onProcessExit] schedules a restart via the backoff. Used
     * for protocol mismatches — we cannot trust a daemon whose wire we do not
     * understand, but we still want the standard restart path to run so a
     * plugin reinstall self-heals it.
     */
    private fun disconnectCurrentProcess() {
        val proc = currentProcess.get() ?: return
        try {
            proc.outputStream.close()
        } catch (_: IOException) {
            // Best-effort close before force-kill; ignore.
        }
        proc.destroyForcibly()
    }

    private fun onRefresh(event: RefreshEvent) {
        // A real refresh is proof the daemon lived long enough to arm its
        // watchers and see a write — reset the restart backoff here rather
        // than on `ready`, so a daemon that emits ready and then crashes
        // immediately escalates its restart delay instead of hot-looping.
        backoffMs = BACKOFF_INITIAL_MS
        for (l in listeners) {
            try {
                l(event)
            } catch (e: Exception) {
                log.warn("Refresh listener threw: %s", e.message)
            }
        }
        scheduleServiceRefresh()
    }

    private fun scheduleServiceRefresh() {
        // Coalesce bursts from the three daemon watchers into a single service refresh.
        // Swing Timer runs on the EDT — safe to touch a Timer field, and the actual
        // refresh dispatches back off the EDT via executeOnPooledThread.
        ApplicationManager.getApplication().invokeLater({
            // Guard against a refresh that arrived just before dispose: without
            // this, the runnable would install a fresh Timer after dispose already
            // stopped/cleared refreshTimer, briefly pinning the client past dispose.
            if (stopped.get()) return@invokeLater
            refreshTimer?.stop()
            refreshTimer = Timer(REFRESH_DEBOUNCE_MS) {
                ApplicationManager.getApplication().executeOnPooledThread {
                    try {
                        project.getService(JolliMemoryService::class.java)?.refreshStatus()
                    } catch (e: Exception) {
                        log.warn("refreshStatus failed after daemon notification: %s", e.message)
                    }
                }
            }.apply {
                isRepeats = false
                start()
            }
        }, { project.isDisposed })
    }

    private fun onProcessExit(proc: Process) {
        if (stopped.get()) return
        if (currentProcess.get() !== proc) return
        val code = try {
            proc.exitValue()
        } catch (_: IllegalThreadStateException) {
            -1
        }
        log.warn("Daemon exited unexpectedly (code=%d), scheduling restart", code)
        scheduleRestart()
    }

    private fun scheduleRestart() {
        if (stopped.get()) return
        val delay = backoffMs
        backoffMs = min(backoffMs * 2, BACKOFF_MAX_MS)
        started.set(false)
        Thread({
            try {
                Thread.sleep(delay)
            } catch (_: InterruptedException) {
                return@Thread
            }
            if (stopped.get()) return@Thread
            start()
        }, "jolli-daemon-restart-${project.name}").apply {
            isDaemon = true
            start()
        }
    }

    override fun dispose() {
        stopped.set(true)
        val proc = currentProcess.getAndSet(null)
        if (proc != null && proc.isAlive) {
            try {
                proc.outputStream.close()
            } catch (_: IOException) {
                // Ignore: closing stdin is best-effort, and the subprocess may already
                // be exiting for its own reasons.
            }
            try {
                if (!proc.waitFor(SHUTDOWN_GRACE_MS, java.util.concurrent.TimeUnit.MILLISECONDS)) {
                    proc.destroyForcibly()
                }
            } catch (_: InterruptedException) {
                proc.destroyForcibly()
            }
            // Explicitly close the reader's stdin so a wedged `readLine()`
            // returns via IOException. `Thread.interrupt()` alone does NOT
            // unblock native I/O reads on the JVM — without this a well-behaved
            // waitFor path that skipped destroyForcibly could leave the reader
            // thread hanging if the child kept stdout open past its main task.
            try {
                proc.inputStream.close()
            } catch (_: IOException) {
                // Already closed / stream already dead — best-effort.
            }
        }
        readerThread.getAndSet(null)?.interrupt()
        refreshTimer?.stop()
        refreshTimer = null
        listeners.clear()
    }
}

package ai.jolli.jollimemory.bridge

import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.RefreshEscalator
import ai.jolli.jollimemory.core.WorkingContext
import ai.jolli.jollimemory.services.JolliMemoryService
import com.google.gson.JsonObject
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
 * category (`queue`, `orphan-ref`, `memory-bank`, `working-context`, `claude-plans`);
 * `cwd` is the project directory the daemon reported for. Consumers should treat the
 * event as "reload from source of truth" and not attempt any diff logic — the diff
 * wire is a read-path feature.
 *
 * [names] is the one exception, and only for `claude-plans`: `~/.claude/plans/` is
 * machine-global and holds every project's plans ever, so re-listing it cannot answer
 * "what is new?". The OS create event is the only thing that can, and it dies with the
 * event unless it rides along here. Empty for every other kind, and also empty when
 * the platform reported no filename. Entries are raw directory names (`<slug>.md`) —
 * deriving a slug is a rule and stays CLI-side.
 */
data class RefreshEvent(val kind: String, val cwd: String, val names: List<String> = emptyList())

/**
 * Refresh kinds this client branches on. Mirrors `RefreshKind` in
 * `cli/src/daemon/DaemonProtocol.ts`; an unknown kind is NOT an error — the
 * protocol treats a new kind as a compatible extension, so anything not listed
 * here falls through to the full status refresh, which is always correct if
 * heavier than necessary.
 */
internal object RefreshKinds {
    /** `plans.json` was rewritten — plans / notes / references may have moved. */
    const val WORKING_CONTEXT = "working-context"

    /** A file appeared in the machine-global Claude plans dir. Carries [RefreshEvent.names]. */
    const val CLAUDE_PLANS = "claude-plans"
}

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
    data class Refresh(val kind: String, val cwd: String, val names: List<String> = emptyList()) : DaemonEvent()
}

/**
 * Reads `params.names` off a refresh notification.
 *
 * Absent (every kind but `claude-plans`) and empty (the platform withheld the
 * filenames) both yield an empty list: the distinction matters on the wire, but
 * neither gives this client a name to act on. Non-string entries are dropped
 * rather than failing the line — a malformed element must not cost us the
 * well-formed ones beside it.
 *
 * Shared with [CliDaemonClient], which parses the same notification off the
 * ide-bridge-serve stream; one reader means the two cannot drift.
 */
internal fun parseRefreshNames(params: JsonObject): List<String> {
    val array = params.get("names")?.takeIf { it.isJsonArray }?.asJsonArray ?: return emptyList()
    return array.mapNotNull { element ->
        element.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString?.takeIf { it.isNotBlank() }
    }
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
            DaemonEvent.Refresh(kind, cwd, parseRefreshNames(params))
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
     * Tracks whether the current debounce window has seen a notification needing a
     * full status recompute. See [scheduleDebounced] for why this is sticky rather
     * than last-writer-wins, and [RefreshEscalator] for the rule itself — shared
     * verbatim with `JolliMemoryService.scheduleDebouncedRefresh`, which is the VFS
     * fallback for this same signal and used to carry a hand-written copy.
     *
     * Every access on the SCHEDULING path is EDT-confined inside the runnable that
     * owns [refreshTimer], so this side needs no synchronization of its own;
     * [RefreshEscalator] provides it anyway for the other caller's sake.
     *
     * Teardown is the one access off that path: it clears from whatever thread
     * called [stop] rather than hopping to the EDT — deliberately, since dispose
     * must finish synchronously. Safe because `stopped` is already set by then and
     * the scheduling runnable returns early on it, so no later write can race it;
     * the worst case is a timer callback already queued on the EDT draining a
     * cleared flag and skipping a refresh for a client being torn down. Do not
     * "fix" that by wrapping the teardown clear in `invokeLater` — it would let
     * dispose return before the flag is cleared.
     */
    private val refreshEscalator = RefreshEscalator()

    /**
     * Registers a callback fired for every `refresh` notification. Returns a Disposable
     * the caller can `Disposer.dispose()` to unregister.
     */
    fun addRefreshListener(listener: (RefreshEvent) -> Unit): Disposable {
        listeners.add(listener)
        return Disposable { listeners.remove(listener) }
    }

    /**
     * Idempotent start.
     *
     * In slice 2 (scheme A') a single `jolli ide-bridge-serve` process carries
     * both request/response traffic and `refresh` notifications, and that
     * process is owned by [CliDaemonClient]. This class no longer spawns its
     * own daemon; it stays alive purely as the plugin-wide refresh-listener
     * registry. [CliDaemonClient] calls [injectRefresh] whenever its stdout
     * carries a refresh line, and every previously registered
     * [addRefreshListener] callback keeps working unchanged.
     */
    fun start() {
        if (stopped.get()) return
        started.compareAndSet(false, true)
    }

    /**
     * Fires the given event to every registered listener. Invoked by
     * [CliDaemonClient] when its long-lived ide-bridge-serve stdout emits a
     * `refresh` notification.
     */
    fun injectRefresh(event: RefreshEvent) {
        onRefresh(event)
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
            is DaemonEvent.Refresh -> onRefresh(RefreshEvent(event.kind, event.cwd, event.names))
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
        dispatchByKind(event)
    }

    /**
     * Routes a settled notification to the narrowest refresh that can be correct
     * for it.
     *
     * The commit-time kinds (`queue`, `orphan-ref`, `memory-bank`) really can
     * change installation state, so they keep the full [JolliMemoryService.refreshStatus]
     * — which is a `@Synchronized` method wrapping a whole `ide-bridge status`
     * round-trip, then fans out to every status listener, each of which starts
     * its own reload.
     *
     * The two working-context kinds cannot change any of that: a plan appearing
     * says nothing about whether hooks are installed. Sending them through the
     * status path made the panel wait on a lock and a bridge call it had no use
     * for, so they take [JolliMemoryService.refreshWorkingContext] instead.
     *
     * An unrecognized kind falls through to the status path deliberately: the
     * wire contract says a new kind is a compatible extension, and "heavier than
     * necessary" is the safe way to be wrong about one.
     */
    private fun dispatchByKind(event: RefreshEvent) {
        when (event.kind) {
            RefreshKinds.CLAUDE_PLANS -> registerNewPlansThenRefresh(event)
            RefreshKinds.WORKING_CONTEXT -> scheduleWorkingContextRefresh()
            else -> scheduleServiceRefresh()
        }
    }

    /**
     * Handles a new file in the machine-global Claude plans dir.
     *
     * Every open project's daemon sees every project's plans, so most of these
     * names belong to somebody else. Attribution (and the whole slug / existence
     * / already-tracked decision) is the CLI's `plans-register-new`, not ours —
     * this method contributes only the filenames the OS reported, which is the
     * one thing the JVM host has and the CLI does not.
     *
     * The refresh runs whether or not anything was registered: the CLI may have
     * been given a name it correctly ignored, but a concurrent StopHook write
     * could still have landed in the same window.
     */
    private fun registerNewPlansThenRefresh(event: RefreshEvent) {
        val cwd = event.cwd.ifBlank { project.basePath }
        if (cwd == null || event.names.isEmpty()) {
            scheduleWorkingContextRefresh()
            return
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val accepted = WorkingContext.registerNewPlans(cwd, event.names)
                if (accepted.isNotEmpty()) log.info("Registered %d new plan(s) from the plans dir", accepted.size)
            } catch (e: Exception) {
                // A failed registration is not fatal: the StopHook still writes
                // the same rows at the end of the turn, which is exactly the
                // behaviour this path exists to beat rather than replace.
                log.warn("plans-register-new failed: %s", e.message)
            }
            scheduleWorkingContextRefresh()
        }
    }

    /** Debounced light refresh — repaints the working-context panels, no status recompute. */
    private fun scheduleWorkingContextRefresh() {
        scheduleDebounced(statusRecompute = false)
    }

    private fun scheduleServiceRefresh() {
        scheduleDebounced(statusRecompute = true)
    }

    /**
     * Coalesces a burst of notifications into one service call, ESCALATING rather
     * than overwriting when the burst mixes kinds.
     *
     * One shared [refreshTimer] is right — the two refreshes are not independent
     * work, and running both would re-read the same registry twice. What would be
     * wrong is last-writer-wins on *which* refresh runs. A light refresh reaches
     * only the working-context listeners; the status path additionally
     * recomputes installation state and wakes [JolliMemoryService]'s status list,
     * which is where the commits and memories panels live. So a light refresh
     * arriving on top of a pending heavy one must not demote it.
     *
     * That collision is routine, not hypothetical: an agent that commits at the
     * end of its turn produces an `orphan-ref` notification when the summary
     * lands and a `working-context` one when the StopHook rewrites `plans.json`
     * moments later. Demoting there drops the status refresh, and nothing polls
     * to recover it — the just-created memory would simply be missing from the
     * sidebar until some unrelated event arrived.
     *
     * Hence [refreshEscalator]: sticky for the life of the window, cleared only
     * when the timer actually fires. Escalation is one-way by design, and being
     * heavier than necessary is the safe way to be wrong.
     */
    private fun scheduleDebounced(statusRecompute: Boolean) {
        // Swing Timer runs on the EDT — safe to touch a Timer field, and the actual
        // refresh dispatches back off the EDT via executeOnPooledThread.
        ApplicationManager.getApplication().invokeLater({
            // Guard against a refresh that arrived just before dispose: without
            // this, the runnable would install a fresh Timer after dispose already
            // stopped/cleared refreshTimer, briefly pinning the client past dispose.
            if (stopped.get()) return@invokeLater
            refreshTimer?.stop()
            refreshEscalator.record(statusRecompute)
            refreshTimer = Timer(REFRESH_DEBOUNCE_MS) {
                // Drain on the EDT, before the pooled hop, so a notification
                // arriving mid-dispatch opens a fresh window instead of having its
                // flag consumed by this one.
                val recompute = refreshEscalator.drain()
                ApplicationManager.getApplication().executeOnPooledThread {
                    try {
                        val service = project.getService(JolliMemoryService::class.java)
                        if (recompute) service?.refreshStatus() else service?.refreshWorkingContext()
                    } catch (e: Exception) {
                        log.warn("Refresh failed after daemon notification: %s", e.message)
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
        refreshEscalator.clear()
        listeners.clear()
    }
}

package ai.jolli.jollimemory.bridge

import ai.jolli.jollimemory.core.JmLogger
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import java.io.BufferedReader
import java.io.File
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Long-lived NDJSON connection to `jolli ide-bridge-serve`. Amortises Node's
 * cold-start (~500ms - 2s) across every IntelliJ ide-bridge call by keeping
 * one process alive per project. Idle calls drop to ~5-20ms wall clock, so a
 * button click that previously stalled the EDT past IntelliJ's 300ms slow-EDT
 * threshold now returns fast enough to feel instant.
 *
 * Ownership + lifecycle:
 *   - One instance per Project (@Service(Level.PROJECT)); registered in
 *     META-INF/plugin.xml. Disposable — dispose() destroys the daemon.
 *   - Lazy start: the Node process is spawned on the first successful call().
 *     A subsequent call whose daemon process is dead, or whose bundled CLI
 *     dist has been re-extracted at a new version, respawns transparently.
 *   - Reader thread and stderr-drain thread are daemon threads so they never
 *     block JVM shutdown; every in-flight future is failed on process death
 *     or on dispose so callers unblock instead of hanging on their own
 *     timeout.
 *
 * Wire protocol: see [PROTOCOL] and cli/src/commands/IdeBridgeCommand.ts.
 */
@Service(Service.Level.PROJECT)
class CliDaemonClient(private val project: Project) : Disposable {

	private val log = JmLogger.create("CliDaemonClient")

	private val nextId = AtomicLong(0)
	private val processRef = AtomicReference<DaemonProcess?>()
	private val disposed = AtomicBoolean(false)
	private val startLock = Any()

	/**
	 * A snapshot of one live daemon and its associated request state. `inFlight`
	 * is deliberately per-daemon (not global on the enclosing service) so that
	 * a dying daemon's [onProcessDeath] only fails ITS OWN in-flight futures.
	 * Without this scoping, a late-firing death of a replaced daemon (dist
	 * version bumped, or handshake-timeout destroyForcibly) would trample the
	 * fresh futures owned by the newly-spawned successor and make the caller
	 * retry a non-idempotent request (squash, force-push, …).
	 */
	private data class DaemonProcess(
		val process: Process,
		val writer: OutputStreamWriter,
		val readerThread: Thread,
		val stderrThread: Thread,
		val distVersion: String,
		val readyFuture: CompletableFuture<JsonObject>,
		val inFlight: ConcurrentHashMap<Long, CompletableFuture<JsonElement>>,
	)

	/**
	 * Runs one action against the daemon and returns the `result` element the
	 * caller would receive from a one-shot [CliIntegrations.runIdeBridge]
	 * spawn — same shape, so the rewire in [CliIntegrations] can prefer this
	 * transparently.
	 *
	 * Throws [CliIntegrations.CliBridgeException] when the daemon returns an
	 * `error` envelope. Throws [RuntimeException] on any local failure
	 * (daemon unavailable, timeout, process died mid-request, writer broke).
	 * Never returns null.
	 */
	fun call(action: String, cwd: String, requestJson: String?, timeoutSeconds: Long): JsonElement {
		if (disposed.get()) throw IllegalStateException("CliDaemonClient is disposed")
		// Resolve the daemon FIRST so we can register the future in that
		// daemon's own inFlight map — this is what scopes onProcessDeath.
		val daemon = ensureDaemonStarted()
		val id = nextId.incrementAndGet()
		val future = CompletableFuture<JsonElement>()
		daemon.inFlight[id] = future
		try {
			val payload = buildRequestLine(id, action, cwd, requestJson)
			try {
				synchronized(daemon.writer) {
					daemon.writer.write(payload)
					daemon.writer.write("\n")
					daemon.writer.flush()
				}
			} catch (e: IOException) {
				// Writer broke (usually: daemon died between calls). Force a
				// full reset so the next call spawns a fresh process instead
				// of trying to reuse a dead one, then rethrow. The reset only
				// touches THIS daemon's inFlight, so a concurrent call that
				// already registered against a NEW daemon is unaffected.
				onProcessDeath(daemon.process, daemon.inFlight, "writer broke: ${e.message}")
				throw RuntimeException("Failed to write to CLI daemon: ${e.message}", e)
			}
			val envelope = try {
				future.get(timeoutSeconds, TimeUnit.SECONDS).asJsonObject
			} catch (e: TimeoutException) {
				// Distinct type so [CliIntegrations.runIdeBridge] can propagate
				// instead of retrying via one-shot spawn — the daemon is still
				// running the action, and a retry would double-execute any
				// side-effectful operation (sync push, store-summary write, …).
				throw CliDaemonTimeoutException(
					"CLI daemon action '$action' timed out after ${timeoutSeconds}s",
				)
			} catch (e: ExecutionException) {
				throw e.cause ?: e
			}
			return unwrapResponseEnvelope(envelope)
		} finally {
			daemon.inFlight.remove(id)
		}
	}

	private fun buildRequestLine(id: Long, action: String, cwd: String, requestJson: String?): String =
		serializeRequestLine(id, action, cwd, requestJson)

	private fun ensureDaemonStarted(): DaemonProcess {
		val cur = processRef.get()
		if (cur != null && cur.process.isAlive && cur.distVersion == currentDistVersion()) return cur
		synchronized(startLock) {
			// Re-check disposed under the lock so we cannot race with dispose():
			// a caller that passed the top-level `disposed.get()` gate can still
			// arrive here after dispose() ran, and without this re-check we would
			// spawn a Node process into a disposed service that nothing destroys.
			if (disposed.get()) throw IllegalStateException("CliDaemonClient is disposed")
			val cur2 = processRef.get()
			if (cur2 != null && cur2.process.isAlive && cur2.distVersion == currentDistVersion()) return cur2
			// Kill any stale/mismatched process so we don't leak, then start fresh.
			cur2?.let { destroy(it) }
			processRef.set(null)
			val started = startDaemon()
			// Second disposal check — dispose() could have flipped between our
			// startLock acquisition and the handshake completing. If so, destroy
			// the just-spawned daemon rather than orphaning it.
			if (disposed.get()) {
				destroy(started)
				throw IllegalStateException("CliDaemonClient disposed during startup")
			}
			processRef.set(started)
			return started
		}
	}

	private fun startDaemon(): DaemonProcess {
		val node = CliIntegrations.resolveNode()
			?: throw RuntimeException(
				"Node.js not found — required for Jolli Memory. Install Node.js and reopen the project.",
			)
		val cliJs = CliIntegrations.resolveCliJs()
			?: throw RuntimeException("The bundled CLI was not found. Try reinstalling Jolli Memory.")
		val distVersion = currentDistVersion()
		val basePath = project.basePath?.let { File(it).absolutePath } ?: File(".").absolutePath
		val pb = ProcessBuilder(node, cliJs.absolutePath, "ide-bridge-serve", "--cwd", basePath)
			.directory(File(basePath))
			.redirectErrorStream(false)
		// Marker for diagnostics — `ps -ef | grep JOLLI_IDE_BRIDGE_SERVE`
		// pinpoints our daemon vs any other node process.
		pb.environment()["JOLLI_IDE_BRIDGE_SERVE"] = "1"
		val proc = pb.start()
		val readyFuture = CompletableFuture<JsonObject>()
		// Per-daemon inFlight — created here and captured by the reader thread's
		// closure. The successor daemon's map is a distinct instance, so a
		// late-dying predecessor can only ever fail its own futures.
		val inFlight = ConcurrentHashMap<Long, CompletableFuture<JsonElement>>()
		val writer = OutputStreamWriter(proc.outputStream, StandardCharsets.UTF_8)
		val reader = BufferedReader(InputStreamReader(proc.inputStream, StandardCharsets.UTF_8))
		val readerThread = Thread({ readLoop(reader, proc, inFlight, readyFuture) }, "JolliCliDaemon-reader").apply {
			isDaemon = true
			start()
		}
		val stderrThread = Thread({ drainStderr(proc) }, "JolliCliDaemon-stderr").apply {
			isDaemon = true
			start()
		}
		// Bound handshake wait so a broken daemon fails fast — better than every
		// downstream call paying its own timeout waiting for a process that
		// never speaks. 5 s is generous vs a ~500 ms cold start on Node 22.
		val handshake = try {
			readyFuture.get(5, TimeUnit.SECONDS)
		} catch (e: TimeoutException) {
			proc.destroyForcibly()
			throw RuntimeException("CLI daemon did not send a handshake within 5s — check ~/.jolli/logs")
		} catch (e: ExecutionException) {
			proc.destroyForcibly()
			throw RuntimeException("CLI daemon handshake failed: ${e.cause?.message ?: e.message}", e.cause)
		}
		// JSON-RPC 2.0 notification: fields live inside `params`, not top-level.
		val handshakeParams = handshake.get("params")?.takeIf { it.isJsonObject }?.asJsonObject
			?: JsonObject()
		val protocol = handshakeParams.get("protocol")?.asString
		if (protocol != PROTOCOL) {
			proc.destroyForcibly()
			throw RuntimeException(
				"CLI daemon speaks protocol '$protocol' but this plugin expects '$PROTOCOL'. " +
					"Try reinstalling Jolli Memory.",
			)
		}
		val pid = handshakeParams.get("pid")?.asInt ?: -1
		val ver = handshakeParams.get("pluginVersion")?.asString ?: "?"
		log.info("CLI daemon started: pid=%d pluginVersion=%s distVersion=%s", pid, ver, distVersion)
		return DaemonProcess(proc, writer, readerThread, stderrThread, distVersion, readyFuture, inFlight)
	}

	private fun readLoop(
		reader: BufferedReader,
		proc: Process,
		inFlight: ConcurrentHashMap<Long, CompletableFuture<JsonElement>>,
		readyFuture: CompletableFuture<JsonObject>,
	) {
		try {
			reader.use {
				var line = it.readLine()
				while (line != null) {
					dispatchLine(line, inFlight, readyFuture)
					line = it.readLine()
				}
			}
		} catch (e: IOException) {
			log.warn("Daemon reader IO error: %s", e.message)
		}
		onProcessDeath(proc, inFlight, "stdout EOF")
	}

	private fun dispatchLine(
		line: String,
		inFlight: ConcurrentHashMap<Long, CompletableFuture<JsonElement>>,
		readyFuture: CompletableFuture<JsonObject>,
	) {
		if (line.isBlank()) return
		val obj = try {
			JsonParser.parseString(line).asJsonObject
		} catch (_: Exception) {
			log.warn("Skipping unparseable daemon line: %s", line.take(200))
			return
		}
		val idElem = obj.get("id")
		if (idElem == null || idElem.isJsonNull) {
			// JSON-RPC 2.0 server→client notification (no `id`). The
			// ide-bridge-serve process reuses the same stdout for
			// request/response pairs and for refresh notifications from its
			// internal fs.watch, so we route by the notification's `method`.
			val method = obj.get("method")?.asString
			when (method) {
				"ready" -> if (!readyFuture.isDone) readyFuture.complete(obj)
				"refresh" -> dispatchRefresh(obj)
				else -> log.warn("Received unaddressed line from daemon (method=%s)", method)
			}
			return
		}
		val id = try {
			idElem.asLong
		} catch (_: Exception) {
			log.warn("Received line with non-numeric id: %s", idElem)
			return
		}
		val fut = inFlight.remove(id)
		if (fut == null) {
			// Caller already timed out. Not a bug, just late.
			log.info("Daemon response for id=%d has no waiter (already returned to caller)", id)
			return
		}
		fut.complete(obj)
	}

	/**
	 * Turns one JSON-RPC 2.0 `refresh` notification from ide-bridge-serve into
	 * a fan-out to every plugin listener via [DaemonNotificationClient].
	 * Keeping the fan-out in that service (instead of a per-client listener
	 * list here) means every UI consumer registered before the JSON-RPC
	 * upgrade stays wired without a single import change.
	 *
	 * The fan-out runs on a pooled thread so a heavy listener never blocks
	 * THIS reader thread — which also carries every request/response line for
	 * concurrent bridge calls. Without the pool hop a listener that reads a
	 * file synchronously would stall every in-flight future.
	 *
	 * Wire shape: `{"jsonrpc":"2.0","method":"refresh","params":{"kind":<k>,"cwd":<p>}}`.
	 */
	private fun dispatchRefresh(obj: JsonObject) {
		val params = obj.get("params")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
		val kind = params.get("kind")?.asString ?: return
		val cwd = params.get("cwd")?.asString ?: ""
		ApplicationManager.getApplication().executeOnPooledThread {
			try {
				project.getService(DaemonNotificationClient::class.java)
					?.injectRefresh(RefreshEvent(kind, cwd))
			} catch (e: Exception) {
				log.warn("Failed to inject refresh: %s", e.message)
			}
		}
	}

	private fun drainStderr(proc: Process) {
		try {
			proc.errorStream.bufferedReader(StandardCharsets.UTF_8).use { r ->
				var line = r.readLine()
				while (line != null) {
					// Truncate loud stack traces so a runaway daemon does not
					// flood the plugin log; keep enough head to diagnose.
					log.info("[daemon-stderr] %s", line.take(500))
					line = r.readLine()
				}
			}
		} catch (_: IOException) {
			// Stream closed on process exit — expected.
		}
	}

	private fun onProcessDeath(
		proc: Process,
		inFlight: ConcurrentHashMap<Long, CompletableFuture<JsonElement>>,
		why: String,
	) {
		val exitCode = runCatching { proc.exitValue() }.getOrNull()
		log.warn("CLI daemon process died (why=%s exit=%s)", why, exitCode?.toString() ?: "still running")
		// Fail ONLY this daemon's own in-flight futures — the new successor
		// daemon's futures live in a separate map, so a late-firing death of
		// the predecessor cannot trample them. Snapshot + clear keeps a
		// simultaneous caller's `future.get()` from returning stale.
		val snapshot = HashMap(inFlight)
		inFlight.clear()
		val ex = RuntimeException("CLI daemon process exited (why=$why, exit=$exitCode)")
		for ((_, fut) in snapshot) fut.completeExceptionally(ex)
		// Clear processRef only if this dying daemon is still the current one;
		// on a version-bump respawn processRef already points to the successor
		// and we leave it alone.
		val cur = processRef.get()
		if (cur != null && cur.process === proc) processRef.compareAndSet(cur, null)
	}

	private fun currentDistVersion(): String {
		val stamp = File(CliIntegrations.distIntellijDir(), ".version")
		return runCatching { stamp.readText().trim() }.getOrDefault("")
	}

	override fun dispose() {
		if (!disposed.compareAndSet(false, true)) return
		// Serialize disposal against [ensureDaemonStarted] under the same lock
		// so a caller that raced past the `disposed.get()` gate cannot leak a
		// freshly-spawned Node process into a torn-down service. The inner
		// re-checks in [ensureDaemonStarted] will trip once we return.
		synchronized(startLock) {
			val cur = processRef.getAndSet(null)
			cur?.let { d ->
				val snapshot = HashMap(d.inFlight)
				d.inFlight.clear()
				val ex = RuntimeException("CliDaemonClient disposed")
				for ((_, fut) in snapshot) fut.completeExceptionally(ex)
				destroy(d)
			}
		}
	}

	private fun destroy(daemon: DaemonProcess) {
		// Closing stdin lets the daemon exit cleanly through its readline
		// `close` event — the CLI side then drains outstanding responses in
		// `Promise.all(pending)` before returning from `runIdeBridgeServe`.
		// We deliberately do NOT call `daemon.process.destroy()` as an
		// intermediate step: on Windows the JDK maps that to `TerminateProcess`,
		// an immediate hard kill that would race the stdin-EOF drain and cut
		// off in-flight write handlers (store-summary, sync push) mid-operation.
		// stdin close alone is the graceful signal on all three platforms; the
		// 2 s wait then `destroyForcibly()` covers a stuck daemon.
		runCatching { daemon.writer.close() }
		if (!daemon.process.waitFor(2, TimeUnit.SECONDS)) {
			runCatching { daemon.process.destroyForcibly() }
		}
	}

	/**
	 * A daemon call exceeded its per-call [timeoutSeconds] budget. Distinct
	 * from a plain [RuntimeException] because the daemon is STILL processing
	 * the action — the caller must not retry via the one-shot spawn fallback,
	 * which would double-execute side-effectful operations (sync push,
	 * store-summary write, force-push, …). [CliIntegrations.runIdeBridge]
	 * catches this specifically and rethrows instead of falling through.
	 */
	class CliDaemonTimeoutException(message: String) : RuntimeException(message)

	companion object {
		/**
		 * Wire protocol expected from the CLI. Must match IDE_BRIDGE_PROTOCOL
		 * in cli/src/commands/IdeBridgeCommand.ts. Bump both together when the
		 * envelope shape changes so an old dist paired with a new plugin
		 * (or vice versa) fails loudly at handshake instead of silently
		 * misbehaving.
		 */
		const val PROTOCOL: String = "jolli-ide-bridge-jsonrpc-v1"

		fun getInstance(project: Project): CliDaemonClient =
			project.getService(CliDaemonClient::class.java)

		/**
		 * Formats one request as a JSON-RPC 2.0 request line — one JSON object
		 * with `jsonrpc:"2.0"` / `id` / `method` / `params:{cwd, request}` and
		 * no trailing newline. Exposed so unit tests can assert the wire shape
		 * without spawning a daemon. `requestJson` may be null or blank; both
		 * mean an empty request body.
		 */
		internal fun serializeRequestLine(
			id: Long,
			action: String,
			cwd: String,
			requestJson: String?,
		): String {
			// The server contract is "request is a JSON object" — a top-level
			// array or primitive would silently ship as `"request": [1,2,3]`
			// and only fail on the daemon side, robbing the caller of a
			// stack-local error. Reject at serialisation time instead.
			val body: JsonElement = if (requestJson.isNullOrBlank()) {
				JsonObject()
			} else {
				val parsed = JsonParser.parseString(requestJson)
				require(parsed.isJsonObject) {
					"Request body must be a JSON object (got: ${parsed.javaClass.simpleName})"
				}
				parsed
			}
			val params = JsonObject().apply {
				addProperty("cwd", cwd)
				add("request", body)
			}
			val req = JsonObject().apply {
				addProperty("jsonrpc", "2.0")
				addProperty("id", id)
				addProperty("method", action)
				add("params", params)
			}
			// Gson's default toString serialises without newlines — protocol-safe.
			return req.toString()
		}

		/**
		 * Reads one JSON-RPC 2.0 response envelope (as produced by
		 * IdeBridgeCommand.ts `computeServeResponse`) and returns the `result`
		 * element the caller would receive from a one-shot
		 * [CliIntegrations.runIdeBridge]. A response with a top-level `error`
		 * object is rethrown as [CliIntegrations.CliBridgeException] with the
		 * same fields the one-shot path already surfaces, so callers up the
		 * stack cannot tell which path served them. Exposed so unit tests can
		 * assert the error-mapping without any live process.
		 */
		internal fun unwrapResponseEnvelope(envelope: JsonObject): JsonElement {
			val errorObj = envelope.get("error")?.takeIf { it.isJsonObject }?.asJsonObject
			if (errorObj != null) {
				val data = errorObj.get("data")?.takeIf { it.isJsonObject }?.asJsonObject ?: JsonObject()
				throw CliIntegrations.CliBridgeException(
					data.get("errorName")?.takeUnless { it.isJsonNull }?.asString,
					errorObj.get("message")?.asString ?: "unknown CLI bridge error",
					data,
				)
			}
			return envelope.get("result") ?: JsonNull.INSTANCE
		}
	}
}

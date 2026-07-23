package ai.jolli.jollimemory.sync

import ai.jolli.jollimemory.bridge.CliIntegrations
import ai.jolli.jollimemory.core.JmLogger
import com.google.gson.JsonObject
import com.intellij.openapi.project.Project
import com.intellij.util.concurrency.AppExecutorUtil
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Drives Memory Bank sync from IntelliJ by shelling out to the CLI's
 * `jolli ide-bridge sync` command. The heavy work (git plumbing, vault
 * locking, merges, conflict detection) all lives in the CLI now — this
 * class only owns the poll timer, the manual-sync entry point, and the
 * state-callback fan-out.
 */
class CliSyncOrchestrator(
	private val project: Project,
	private val cwd: String,
	private val pollIntervalSec: Int?,
	private val onStateChange: (SyncState, SyncStatusDetail?) -> Unit,
) {

	private val log = JmLogger.create("CliSyncOrchestrator")

	/**
	 * Dedicated pool so a slow sync round (git plumbing, vault fetch,
	 * potentially tens of seconds) does not tie up a slot in the IDE-shared
	 * scheduled executor that every other plugin is also drawing from.
	 * Sized at 1 because rounds are coalesced by [roundInFlight] anyway.
	 */
	private val executor = AppExecutorUtil.createBoundedScheduledExecutorService("JolliMemorySync", 1)
	private val running = AtomicBoolean(false)
	private val roundInFlight = AtomicBoolean(false)
	private val disposed = AtomicBoolean(false)

	@Volatile
	private var pollTask: ScheduledFuture<*>? = null

	/** Starts the poll loop. Idempotent — calling twice is a no-op. */
	fun start() {
		if (disposed.get()) return
		if (!running.compareAndSet(false, true)) return
		val period = clampPollSec(pollIntervalSec)
		log.info("start: polling every %ds in %s", period, cwd)
		pollTask = executor.scheduleWithFixedDelay(
			{ runRoundSafely("poll") },
			1L,
			period,
			TimeUnit.SECONDS,
		)
	}

	/**
	 * Stops the poll timer. The orchestrator instance remains usable for a
	 * later manual sync; call [dispose] to release all resources.
	 */
	fun stop() {
		if (!running.compareAndSet(true, false)) return
		pollTask?.cancel(false)
		pollTask = null
		log.info("stop: poll loop cancelled in %s", cwd)
	}

	/**
	 * Kicks off an out-of-band sync round. Coalesces with any in-flight round
	 * so a rapid click sequence does not queue duplicates.
	 */
	fun requestManualSync() {
		if (disposed.get()) return
		try {
			executor.submit { runRoundSafely("manual") }
		} catch (e: java.util.concurrent.RejectedExecutionException) {
			// Executor was shut down between the disposed.get() check and
			// submit() — happens if dispose() races with a UI-thread click.
			// Safe to swallow: the click's intent no longer applies.
			log.debug("requestManualSync: executor shut down, ignoring click")
		}
	}

	/**
	 * Releases the poll timer and the dedicated executor permanently. After
	 * this returns, further callbacks to [onStateChange] are suppressed even
	 * if an in-flight round finishes late — so the widget / listeners that
	 * `JolliMemoryService` released together with the orchestrator will not
	 * be touched by a zombie round.
	 */
	fun dispose() {
		if (!disposed.compareAndSet(false, true)) return
		stop()
		// shutdownNow() interrupts an in-flight round so its blocking read
		// on the CLI daemon socket returns promptly. The round's own
		// exception path is guarded by the disposed check in
		// [deliverState], so the interrupt cannot leak a stale state
		// change out to the UI.
		executor.shutdownNow()
		log.info("dispose: shutdown executor for %s", cwd)
	}

	private fun runRoundSafely(reason: String) {
		if (disposed.get()) return
		if (!roundInFlight.compareAndSet(false, true)) {
			log.debug("runRoundSafely(%s): round already in flight, skipping", reason)
			return
		}
		try {
			deliverState(SyncState.SYNCING, null)
			val request = JsonObject().apply { addProperty("reason", reason) }
			val response = try {
				CliIntegrations.runIdeBridge(cwd, "sync", request.toString())
			} catch (e: Exception) {
				log.warn(
					"sync round failed transport-level (reason=%s): %s",
					reason,
					e.stackTraceToString(),
				)
				deliverState(SyncState.OFFLINE, SyncStatusDetail(failed = true, lastError = e.message))
				return
			}

			val obj = response.takeIf { it.isJsonObject }?.asJsonObject
			if (obj == null) {
				deliverState(
					SyncState.OFFLINE,
					SyncStatusDetail(failed = true, lastError = "malformed sync response"),
				)
				return
			}

			val (state, detail) = try {
				parseSyncResponse(obj)
			} catch (e: Exception) {
				log.warn(
					"sync round failed to parse response (reason=%s): %s",
					reason,
					e.stackTraceToString(),
				)
				SyncState.OFFLINE to SyncStatusDetail(failed = true, lastError = "malformed sync response")
			}
			deliverState(state, detail)
		} catch (t: Throwable) {
			// Never let a stray exception escape into the scheduled executor:
			// scheduleWithFixedDelay cancels the loop on throw, and the IDE
			// fatal-error reporter's popup / EDT churn is what the user
			// perceives as "the IDE freezes on click".
			log.warn(
				"sync round threw unexpectedly (reason=%s): %s",
				reason,
				t.stackTraceToString(),
			)
			deliverState(SyncState.OFFLINE, SyncStatusDetail(failed = true, lastError = t.message))
		} finally {
			roundInFlight.set(false)
		}
	}

	/**
	 * Fans out a state change to the caller-supplied callback. Guarded by
	 * [disposed] so a round that finishes after [dispose] does not touch
	 * a widget or listener that the disposer has already released.
	 * Callback exceptions are logged and swallowed so a UI-side bug cannot
	 * take the poll loop down.
	 */
	private fun deliverState(state: SyncState, detail: SyncStatusDetail?) {
		if (disposed.get()) return
		try {
			onStateChange(state, detail)
		} catch (t: Throwable) {
			log.warn(
				"onStateChange callback threw (state=%s): %s",
				state.name,
				t.stackTraceToString(),
			)
		}
	}

	/**
	 * Parses the JSON serialization of the CLI's `SyncRoundResult` into the
	 * status-bar view model. Mirrors the VS Code `buildDetail` mapping so
	 * both surfaces surface the same failure taxonomy for the same round.
	 *
	 * Field mapping (see `cli/src/sync/SyncTypes.ts SyncRoundResult`):
	 *   - `newState` (string, lowercase) → [SyncState]
	 *   - `conflicts` (array) → [SyncStatusDetail.conflictCount] when non-empty
	 *   - `lastError` (object `{ code, message, selfLocked? }`) → maps to
	 *     `lastError` / `failed` / `failedCode` / `selfLocked`; `code === "network"`
	 *     stays a transient offline, everything else is a terminal `failed`.
	 */
	private fun parseSyncResponse(obj: JsonObject): Pair<SyncState, SyncStatusDetail?> {
		val stateName = optString(obj, "newState")?.uppercase()
		val state = SyncState.entries.firstOrNull { it.name == stateName } ?: SyncState.OFFLINE

		val conflictsEl = obj.get("conflicts")?.takeUnless { it.isJsonNull }
		val conflictCount = conflictsEl?.takeIf { it.isJsonArray }?.asJsonArray?.size()?.takeIf { it > 0 }

		val lastErrorObj = obj.get("lastError")?.takeUnless { it.isJsonNull }?.takeIf { it.isJsonObject }?.asJsonObject
		val lastErrorMessage = lastErrorObj?.let { optString(it, "message") }
		val lastErrorCode = lastErrorObj?.let { optString(it, "code") }
		// `failed` marks a terminal error the status bar should surface as a
		// failure badge. Bind it to "there IS a non-network error", not to the
		// enum lookup succeeding — otherwise a new CLI error code, a code
		// rename, or an error object with no `code` at all silently downgrades
		// to a transient OFFLINE and the user sees no failure indicator.
		// `failedCode` stays enum-typed for the callers that switch on it, but
		// its null-ness no longer gates severity.
		val failedCode = lastErrorCode
			?.takeIf { it != "network" }
			?.let { name -> SyncErrorCode.entries.firstOrNull { it.name == name.uppercase() } }
		val failed = lastErrorObj != null && lastErrorCode != "network"
		val selfLocked = lastErrorObj?.let { optBool(it, "selfLocked") } == true

		val hasDetail = conflictCount != null || lastErrorMessage != null || failed || selfLocked
		val detail = if (!hasDetail) {
			null
		} else {
			SyncStatusDetail(
				conflictCount = conflictCount,
				lastError = lastErrorMessage,
				failed = failed,
				failedCode = failedCode,
				selfLocked = selfLocked,
			)
		}
		return state to detail
	}

	private fun optString(obj: JsonObject, key: String): String? {
		val el = obj.get(key) ?: return null
		if (el.isJsonNull || !el.isJsonPrimitive) return null
		return runCatching { el.asString }.getOrNull()
	}

	private fun optBool(obj: JsonObject, key: String): Boolean {
		val el = obj.get(key) ?: return false
		if (el.isJsonNull || !el.isJsonPrimitive) return false
		return runCatching { el.asBoolean }.getOrDefault(false)
	}

	companion object {
		/** Default poll interval when config supplies none: 90 minutes. */
		private const val DEFAULT_POLL_SEC: Long = 90 * 60

		/** Minimum accepted poll interval: 90 minutes. Anything shorter is raised to this. */
		private const val MIN_POLL_SEC: Long = 90 * 60

		/** Maximum accepted poll interval: 24 hours. Anything larger is capped. */
		private const val MAX_POLL_SEC: Long = 24 * 60 * 60

		/**
		 * Clamps a user-supplied poll interval to `[MIN_POLL_SEC, MAX_POLL_SEC]`,
		 * falling back to [DEFAULT_POLL_SEC] for null / non-positive input. Keeps
		 * a stray Settings entry (`0`, negative, or `999999999`) from either
		 * starving the loop or turning it into a "polls once every 32 years" no-op.
		 */
		private fun clampPollSec(value: Int?): Long {
			if (value == null || value <= 0) return DEFAULT_POLL_SEC
			return value.toLong().coerceIn(MIN_POLL_SEC, MAX_POLL_SEC)
		}
	}
}

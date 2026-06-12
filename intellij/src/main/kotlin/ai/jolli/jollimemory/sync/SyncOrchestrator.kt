package ai.jolli.jollimemory.sync

import ai.jolli.jollimemory.core.JmLogger
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Constructor options for [SyncOrchestrator].
 */
data class SyncOrchestratorOpts(
	val engine: SyncEngine,
	val cwd: String,
	val pollIntervalSec: Int? = null,
	val onStateChange: (SyncState, SyncStatusDetail?) -> Unit = { _, _ -> },
	val onRoundFinished: ((SyncState, SyncRoundResult) -> Unit)? = null,
	val readyGate: CompletableFuture<Unit>? = null,
	val lastSuccessAtMs: AtomicLong = AtomicLong(0),
	val eagerTickMinElapsedMs: Long = DEFAULT_EAGER_TICK_MIN_ELAPSED_MS,
	val timer: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
		Thread(r, "JolliMemory-SyncOrchestrator").apply { isDaemon = true }
	},
	val syncTranscripts: () -> Boolean = { false },
)

/**
 * Drives [SyncEngine.runRound] on a timer with coalescing, generation-based
 * cancellation, and eager-tick-on-startup logic.
 *
 * Port of `vscode/src/sync/StatusOrchestrator.ts`.
 */
class SyncOrchestrator(private val opts: SyncOrchestratorOpts) {

	private val log = JmLogger.create("SyncOrchestrator")
	private val pollMs = clampPoll(opts.pollIntervalSec).toLong() * 1000L
	private val lock = ReentrantLock()

	// ── Generation-based cancellation ────────────────────────────────────
	private val pollGeneration = AtomicInteger(0)

	// ── Coalescing ───────────────────────────────────────────────────────
	private var currentRound: CompletableFuture<Unit>? = null
	private val pendingManualFollowup = AtomicBoolean(false)

	// ── Polling handle ───────────────────────────────────────────────────
	private var pollHandle: ScheduledFuture<*>? = null

	// ── State tracking ───────────────────────────────────────────────────
	@Volatile
	private var lastState: SyncState = SyncState.SYNCED
	private val disposed = AtomicBoolean(false)

	/** Whether the polling loop is active. */
	val isPolling: Boolean get() = lock.withLock { pollHandle != null }

	/** Most recent [SyncState] observed after a round. */
	val lastObservedState: SyncState get() = lastState

	// ── Lifecycle ────────────────────────────────────────────────────────

	/**
	 * Start the polling loop.  Idempotent — calling while already polling
	 * is a no-op.
	 */
	fun start() {
		if (disposed.get()) return
		log.info("start: beginning poll loop, interval=${pollMs}ms")
		lock.withLock {
			if (pollHandle != null) return
			val gen = pollGeneration.incrementAndGet()

			if (shouldFireEagerTick()) {
				// Pass the current generation (not null) so a stop() racing in
				// between cancels this queued eager tick — matching the TS source.
				// A null generation would make it an always-proceed manual tick,
				// reintroducing an unwanted round after auto-sync is toggled off.
				opts.timer.submit { tick("poll", gen) }
			}

			pollHandle = opts.timer.scheduleAtFixedRate(
				{ tick("poll", gen) },
				pollMs, pollMs, TimeUnit.MILLISECONDS,
			)
		}
	}

	/**
	 * Stop polling.  Does **not** dispose — [syncNow] still works after
	 * stop.  Bumps [pollGeneration] so any queued poll tick will bail.
	 */
	fun stop() {
		lock.withLock {
			pollHandle?.cancel(false)
			pollHandle = null
			pollGeneration.incrementAndGet()
		}
	}

	/**
	 * Manual sync — fires immediately, bypasses generation check.
	 */
	fun syncNow() {
		if (disposed.get()) {
			log.debug("syncNow: ignored — orchestrator disposed")
			return
		}
		log.info("syncNow: submitting manual tick")
		try {
			opts.timer.submit { tick("manual", null) }
		} catch (_: RejectedExecutionException) {
			// dispose() raced with this call and shut the timer down — manual
			// sync becomes a no-op rather than surfacing an executor error.
		}
	}

	/**
	 * Smart manual sync entry point.  If no round is in flight, fires
	 * immediately.  If a round is running, sets the followup latch so a
	 * manual tick fires as soon as the current round completes.
	 */
	fun requestManualSync(): CompletableFuture<Unit> {
		log.info("requestManualSync: manual sync requested")
		val result = CompletableFuture<Unit>()
		if (disposed.get()) {
			log.debug("requestManualSync: ignored — orchestrator disposed")
			result.complete(Unit)
			return result
		}
		try {
			opts.timer.submit {
				try {
					val existing = lock.withLock { currentRound }
					if (existing == null) {
						log.debug("requestManualSync: no round in flight, firing immediately")
						tick("manual", null)
					} else {
						log.debug("requestManualSync: round in flight, setting followup latch")
						pendingManualFollowup.set(true)
						try { existing.join() } catch (_: Exception) {}
						// If the followup produced a new round, await that too.
						val followup = lock.withLock { currentRound }
						if (followup != null) {
							try { followup.join() } catch (_: Exception) {}
						}
					}
					result.complete(Unit)
				} catch (e: Exception) {
					result.completeExceptionally(e)
				}
			}
		} catch (_: RejectedExecutionException) {
			// dispose() raced with this call — resolve as a no-op.
			result.complete(Unit)
		}
		return result
	}

	/** Whether a round is currently executing. */
	fun isRoundInFlight(): Boolean = lock.withLock { currentRound != null }

	/**
	 * Permanently shut down this orchestrator.  Stops polling and shuts
	 * down the timer executor.
	 */
	fun dispose() {
		if (disposed.getAndSet(true)) return
		stop()
		opts.timer.shutdownNow()
	}

	// ── Core tick ────────────────────────────────────────────────────────

	/**
	 * Execute one sync round.  Handles coalescing, ready-gate, and
	 * generation-based cancellation.
	 */
	private fun tick(reason: String, queuedGeneration: Int?) {
		if (disposed.get()) return
		log.debug("tick($reason) starting, generation=$queuedGeneration")

		// Coalescing: if a round is already running, wait for it.
		val existing = lock.withLock { currentRound }
		if (existing != null) {
			log.debug("tick($reason) coalesced — round already in flight")
			try { existing.join() } catch (_: Exception) {}
			return
		}

		val preTickState = lastState
		setState(SyncState.SYNCING, null)

		val future = CompletableFuture<Unit>()
		lock.withLock { currentRound = future }

		try {
			// Await KB init gate.
			if (opts.readyGate != null) {
				try {
					opts.readyGate.join()
				} catch (e: Exception) {
					log.warn("readyGate failed: ${e.stackTraceToString()}")
				}
			}

			// Generation check: bail if stop() was called since this tick
			// was queued.  Manual ticks pass null and always proceed.
			if (queuedGeneration != null && queuedGeneration != pollGeneration.get()) {
				setState(preTickState, null)
				return
			}

			val result = opts.engine.runRound(
				SyncRoundOptions(
					cwd = opts.cwd,
					reason = reason,
					transcripts = opts.syncTranscripts(),
				),
			)

			val detail = buildDetail(result)
			setState(result.newState, detail)

			if (result.newState == SyncState.SYNCED) {
				opts.lastSuccessAtMs.set(System.currentTimeMillis())
			}

			fireRoundFinished(result.newState, result)
		} catch (e: Exception) {
			log.error("tick($reason) failed: ${e.stackTraceToString()}")
			val syntheticResult = SyncRoundResult(
				fetched = false, pulled = false, pushed = false,
				newState = SyncState.OFFLINE,
				lastError = SyncRoundError(
					code = SyncErrorCode.SYNC_FAILED_AFTER_RETRIES,
					message = e.message ?: "unknown error",
				),
			)
			val detail = buildDetail(syntheticResult)
			setState(SyncState.OFFLINE, detail)
			fireRoundFinished(SyncState.OFFLINE, syntheticResult)
		} finally {
			future.complete(Unit)
			lock.withLock { currentRound = null }
		}

		// P3-A followup: if someone clicked manual sync while the round
		// was running, fire another tick now.
		if (pendingManualFollowup.getAndSet(false) && !disposed.get()) {
			tick("manual", null)
		}
	}

	// ── Helpers ──────────────────────────────────────────────────────────

	private fun shouldFireEagerTick(): Boolean {
		val last = opts.lastSuccessAtMs.get()
		if (last == 0L) return true
		return System.currentTimeMillis() - last >= opts.eagerTickMinElapsedMs
	}

	private fun setState(state: SyncState, detail: SyncStatusDetail?) {
		lastState = state
		try { opts.onStateChange(state, detail) } catch (_: Exception) {}
	}

	private fun fireRoundFinished(state: SyncState, result: SyncRoundResult) {
		try { opts.onRoundFinished?.invoke(state, result) } catch (_: Exception) {}
	}
}

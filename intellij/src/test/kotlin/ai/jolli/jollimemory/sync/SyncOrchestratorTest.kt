package ai.jolli.jollimemory.sync

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

class SyncOrchestratorTest {

	private val orchestrators = mutableListOf<SyncOrchestrator>()

	@AfterEach
	fun tearDown() {
		orchestrators.forEach { it.dispose() }
	}

	private fun track(orch: SyncOrchestrator): SyncOrchestrator {
		orchestrators.add(orch)
		return orch
	}

	// ── clampPoll ────────────────────────────────────────────────────────

	@Test
	fun `clampPoll returns default for null`() {
		assertEquals(DEFAULT_POLL_SEC, clampPoll(null))
	}

	@Test
	fun `clampPoll returns default for zero`() {
		assertEquals(DEFAULT_POLL_SEC, clampPoll(0))
	}

	@Test
	fun `clampPoll returns default for negative`() {
		assertEquals(DEFAULT_POLL_SEC, clampPoll(-10))
	}

	@Test
	fun `clampPoll clamps below minimum`() {
		assertEquals(MIN_POLL_SEC, clampPoll(60))
	}

	@Test
	fun `clampPoll clamps above maximum`() {
		assertEquals(MAX_POLL_SEC, clampPoll(100_000))
	}

	@Test
	fun `clampPoll passes through valid value`() {
		val twoHours = 2 * 60 * 60
		assertEquals(twoHours, clampPoll(twoHours))
	}

	// ── buildDetail ──────────────────────────────────────────────────────

	@Test
	fun `buildDetail returns null for clean synced result`() {
		val result = SyncRoundResult(
			fetched = true, pulled = true, pushed = true,
			newState = SyncState.SYNCED,
		)
		assertEquals(null, buildDetail(result))
	}

	@Test
	fun `buildDetail returns conflict count`() {
		val result = SyncRoundResult(
			fetched = true, pulled = true, pushed = false,
			conflicts = listOf("a.json", "b.json"),
			newState = SyncState.CONFLICTS,
		)
		val detail = buildDetail(result)!!
		assertEquals(2, detail.conflictCount)
	}

	@Test
	fun `buildDetail returns terminal error info`() {
		val result = SyncRoundResult(
			fetched = true, pulled = false, pushed = false,
			newState = SyncState.OFFLINE,
			lastError = SyncRoundError(
				code = SyncErrorCode.VAULT_LOCKED,
				message = "locked by other device",
				selfLocked = true,
			),
		)
		val detail = buildDetail(result)!!
		assertTrue(detail.failed)
		assertEquals(SyncErrorCode.VAULT_LOCKED, detail.failedCode)
		assertTrue(detail.selfLocked)
	}

	@Test
	fun `buildDetail ignores transient network error`() {
		val result = SyncRoundResult(
			fetched = false, pulled = false, pushed = false,
			newState = SyncState.OFFLINE,
			lastError = SyncRoundError(
				code = SyncErrorCode.NETWORK,
				message = "timeout",
			),
		)
		assertEquals(null, buildDetail(result))
	}

	// ── SyncOrchestrator lifecycle ───────────────────────────────────────

	private fun makeShimEngine(
		roundFn: (SyncRoundOptions) -> SyncRoundResult,
	): SyncEngine {
		return ShimSyncEngine(roundFn)
	}

	private fun makeOrch(
		roundFn: (SyncRoundOptions) -> SyncRoundResult = {
			SyncRoundResult(
				fetched = true, pulled = true, pushed = true,
				newState = SyncState.SYNCED,
			)
		},
		lastSuccessAtMs: AtomicLong = AtomicLong(0),
		eagerTickMinElapsedMs: Long = DEFAULT_EAGER_TICK_MIN_ELAPSED_MS,
		readyGate: CompletableFuture<Unit>? = null,
		onStateChange: (SyncState, SyncStatusDetail?) -> Unit = { _, _ -> },
		onRoundFinished: ((SyncState, SyncRoundResult) -> Unit)? = null,
	): SyncOrchestrator {
		return track(SyncOrchestrator(SyncOrchestratorOpts(
			engine = makeShimEngine(roundFn),
			cwd = "/test",
			pollIntervalSec = MIN_POLL_SEC,
			onStateChange = onStateChange,
			onRoundFinished = onRoundFinished,
			readyGate = readyGate,
			lastSuccessAtMs = lastSuccessAtMs,
			eagerTickMinElapsedMs = eagerTickMinElapsedMs,
		)))
	}

	@Test
	fun `start is idempotent`() {
		val orch = makeOrch(lastSuccessAtMs = AtomicLong(System.currentTimeMillis()))
		orch.start()
		assertTrue(orch.isPolling)
		orch.start()
		assertTrue(orch.isPolling)
	}

	@Test
	fun `stop cancels polling`() {
		val orch = makeOrch(lastSuccessAtMs = AtomicLong(System.currentTimeMillis()))
		orch.start()
		assertTrue(orch.isPolling)
		orch.stop()
		assertFalse(orch.isPolling)
	}

	@Test
	fun `syncNow fires a round`() {
		val latch = CountDownLatch(1)
		val roundCount = AtomicInteger(0)
		val orch = makeOrch(
			roundFn = {
				roundCount.incrementAndGet()
				SyncRoundResult(
					fetched = true, pulled = true, pushed = true,
					newState = SyncState.SYNCED,
				)
			},
			onRoundFinished = { _, _ -> latch.countDown() },
		)
		orch.syncNow()
		assertTrue(latch.await(5, TimeUnit.SECONDS))
		assertEquals(1, roundCount.get())
	}

	@Test
	fun `syncNow updates lastObservedState`() {
		val latch = CountDownLatch(1)
		val orch = makeOrch(
			onRoundFinished = { _, _ -> latch.countDown() },
		)
		orch.syncNow()
		assertTrue(latch.await(5, TimeUnit.SECONDS))
		assertEquals(SyncState.SYNCED, orch.lastObservedState)
	}

	@Test
	fun `syncNow records lastSuccessAtMs on success`() {
		val lastSuccess = AtomicLong(0)
		val latch = CountDownLatch(1)
		val orch = makeOrch(
			lastSuccessAtMs = lastSuccess,
			onRoundFinished = { _, _ -> latch.countDown() },
		)
		orch.syncNow()
		assertTrue(latch.await(5, TimeUnit.SECONDS))
		assertTrue(lastSuccess.get() > 0)
	}

	@Test
	fun `engine failure produces OFFLINE state`() {
		val latch = CountDownLatch(1)
		val orch = makeOrch(
			roundFn = { throw RuntimeException("boom") },
			onRoundFinished = { _, _ -> latch.countDown() },
		)
		orch.syncNow()
		assertTrue(latch.await(5, TimeUnit.SECONDS))
		assertEquals(SyncState.OFFLINE, orch.lastObservedState)
	}

	@Test
	fun `onStateChange receives SYNCING then final state`() {
		val states = CopyOnWriteArrayList<SyncState>()
		val latch = CountDownLatch(1)
		val orch = makeOrch(
			onStateChange = { state, _ -> states.add(state) },
			onRoundFinished = { _, _ -> latch.countDown() },
		)
		orch.syncNow()
		assertTrue(latch.await(5, TimeUnit.SECONDS))
		assertTrue(states.size >= 2)
		assertEquals(SyncState.SYNCING, states[0])
		assertEquals(SyncState.SYNCED, states.last())
	}

	@Test
	fun `eager tick fires when lastSuccessAtMs is zero`() {
		val latch = CountDownLatch(1)
		val roundCount = AtomicInteger(0)
		val orch = makeOrch(
			lastSuccessAtMs = AtomicLong(0),
			roundFn = {
				roundCount.incrementAndGet()
				SyncRoundResult(
					fetched = true, pulled = true, pushed = true,
					newState = SyncState.SYNCED,
				)
			},
			onRoundFinished = { _, _ -> latch.countDown() },
		)
		orch.start()
		assertTrue(latch.await(5, TimeUnit.SECONDS))
		assertTrue(roundCount.get() >= 1)
	}

	@Test
	fun `eager tick does not fire when last success is recent`() {
		val roundCount = AtomicInteger(0)
		val orch = makeOrch(
			lastSuccessAtMs = AtomicLong(System.currentTimeMillis()),
			roundFn = {
				roundCount.incrementAndGet()
				SyncRoundResult(
					fetched = true, pulled = true, pushed = true,
					newState = SyncState.SYNCED,
				)
			},
		)
		orch.start()
		Thread.sleep(500)
		assertEquals(0, roundCount.get())
	}

	@Test
	fun `dispose prevents further ticks`() {
		val roundCount = AtomicInteger(0)
		val orch = makeOrch(
			lastSuccessAtMs = AtomicLong(System.currentTimeMillis()),
			roundFn = {
				roundCount.incrementAndGet()
				SyncRoundResult(
					fetched = true, pulled = true, pushed = true,
					newState = SyncState.SYNCED,
				)
			},
		)
		orch.dispose()
		orch.syncNow()
		Thread.sleep(500)
		assertEquals(0, roundCount.get())
	}

	@Test
	fun `generation check cancels stale poll tick`() {
		val blockLatch = CountDownLatch(1)
		val roundCount = AtomicInteger(0)
		val orch = makeOrch(
			lastSuccessAtMs = AtomicLong(System.currentTimeMillis()),
			roundFn = {
				roundCount.incrementAndGet()
				blockLatch.await(5, TimeUnit.SECONDS)
				SyncRoundResult(
					fetched = true, pulled = true, pushed = true,
					newState = SyncState.SYNCED,
				)
			},
		)
		orch.start()
		orch.stop()
		blockLatch.countDown()
		Thread.sleep(500)
		assertEquals(0, roundCount.get())
	}

	@Test
	fun `requestManualSync fires followup after in-flight round`() {
		val blockLatch = CountDownLatch(1)
		val roundCount = AtomicInteger(0)
		val orch = makeOrch(
			lastSuccessAtMs = AtomicLong(System.currentTimeMillis()),
			roundFn = {
				val n = roundCount.incrementAndGet()
				if (n == 1) {
					blockLatch.await(5, TimeUnit.SECONDS)
				}
				SyncRoundResult(
					fetched = true, pulled = true, pushed = true,
					newState = SyncState.SYNCED,
				)
			},
		)
		// Start a manual round that blocks.
		orch.syncNow()
		Thread.sleep(200)

		// Request another manual sync while the first is in flight.
		val followupFuture = orch.requestManualSync()

		// Release the first round.
		blockLatch.countDown()

		// The followup should complete and have triggered a second round.
		followupFuture.get(5, TimeUnit.SECONDS)
		assertEquals(2, roundCount.get())
	}
}

/**
 * Minimal [SyncEngine] subclass for testing.  Overrides [runRound] to
 * delegate to a lambda, avoiding the full dependency tree.
 */
private class ShimSyncEngine(
	private val roundFn: (SyncRoundOptions) -> SyncRoundResult,
) : SyncEngine(SyncEngineOpts(
	backend = SyncBackendClient(),
	resolveContext = { throw UnsupportedOperationException() },
	makeGitClient = GitClientFactory { _, _ -> throw UnsupportedOperationException() },
)) {
	override fun runRound(round: SyncRoundOptions): SyncRoundResult = roundFn(round)
}

package ai.jolli.jollimemory.toolwindow

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

/**
 * Unit tests for [awaitProbeSettlement], the pure poll loop extracted from
 * [SettingsDialog.awaitLocalAgentProbe]. Every side-effecting dependency
 * is injected, so the tests drive time and the in-flight flag directly —
 * no Swing, no IntelliJ progress subsystem, no real sleep.
 *
 * Guards the production contract:
 *   - Returns true as soon as inFlight() flips to false.
 *   - Returns false at deadline.
 *   - Returns false when isCanceled() reads true (short-circuits the wait).
 *   - Never sleeps past the deadline.
 */
class LocalAgentProbePollTest {

	@Test
	fun `returns true when inFlight flips to false before deadline`() {
		val clock = FakeClock(start = 1_000L)
		var callsBeforeSettled = 3
		val sleeps = mutableListOf<Long>()
		val landed = awaitProbeSettlement(
			now = clock::now,
			sleepMillis = { ms -> sleeps.add(ms); clock.advance(ms) },
			inFlight = { --callsBeforeSettled > 0 },
			isCanceled = { false },
			deadlineMillis = 8_000L,
		)
		landed shouldBe true
		// 2 sleeps expected: initial check returns true (in-flight), sleep,
		// second check returns true (in-flight), sleep, third check returns
		// false → landed. Contract: never sleeps once the settlement is
		// observed.
		sleeps shouldBe listOf(50L, 50L)
	}

	@Test
	fun `returns false when deadline elapses`() {
		val clock = FakeClock(start = 0L)
		val sleeps = mutableListOf<Long>()
		val landed = awaitProbeSettlement(
			now = clock::now,
			sleepMillis = { ms -> sleeps.add(ms); clock.advance(ms) },
			inFlight = { true },
			isCanceled = { false },
			deadlineMillis = 200L,
			pollIntervalMillis = 50L,
		)
		landed shouldBe false
		// 200 / 50 = 4 sleeps before the loop's `now() < deadline` check fails.
		sleeps shouldBe listOf(50L, 50L, 50L, 50L)
	}

	@Test
	fun `short-circuits on cancel without sleeping again`() {
		val clock = FakeClock(start = 0L)
		var polls = 0
		val sleeps = mutableListOf<Long>()
		val landed = awaitProbeSettlement(
			now = clock::now,
			sleepMillis = { ms -> sleeps.add(ms); clock.advance(ms) },
			inFlight = { true },
			isCanceled = { polls++ >= 2 },
			deadlineMillis = 10_000L,
		)
		landed shouldBe false
		// Cancel checked at top of each iteration: polls=0 → not cancelled,
		// sleep; polls=1 → not cancelled, sleep; polls=2 → cancelled, exit.
		// Two sleeps expected — never sleeps after the cancel is observed.
		sleeps shouldBe listOf(50L, 50L)
	}

	@Test
	fun `honors a caller-supplied poll interval`() {
		val clock = FakeClock(start = 0L)
		val sleeps = mutableListOf<Long>()
		awaitProbeSettlement(
			now = clock::now,
			sleepMillis = { ms -> sleeps.add(ms); clock.advance(ms) },
			inFlight = { true },
			isCanceled = { false },
			deadlineMillis = 100L,
			pollIntervalMillis = 25L,
		)
		// 100 / 25 = 4 sleeps at the caller's chosen interval.
		sleeps shouldBe listOf(25L, 25L, 25L, 25L)
	}

	@Test
	fun `returns true immediately when inFlight is false on entry`() {
		val clock = FakeClock(start = 5_000L)
		val sleeps = mutableListOf<Long>()
		val landed = awaitProbeSettlement(
			now = clock::now,
			sleepMillis = { ms -> sleeps.add(ms); clock.advance(ms) },
			inFlight = { false },
			isCanceled = { false },
			deadlineMillis = 8_000L,
		)
		landed shouldBe true
		// Fast path: the very first inFlight() check returns false, so the
		// loop exits before any sleep. Guards against a regression where the
		// deadline check gets reordered ahead of the settlement check and
		// forces a wasted sleep even when the reply landed synchronously.
		sleeps shouldBe emptyList()
	}
}

/**
 * Deterministic clock. Volatile field so a reader on the test thread sees
 * writes from a lambda called on the same thread (unlike a plain var, which
 * the JIT could hoist across the sleep-that-isn't-really-a-sleep).
 */
private class FakeClock(start: Long) {
	@Volatile private var t = start
	fun now(): Long = t
	fun advance(ms: Long) { t += ms }
}

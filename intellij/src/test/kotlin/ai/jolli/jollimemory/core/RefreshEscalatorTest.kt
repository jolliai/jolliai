package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Locks down [RefreshEscalator], the sticky "this window owes a status refresh"
 * rule shared by the daemon push channel and the VFS fallback.
 *
 * These cases existed nowhere before the rule became a type: both debouncers held
 * their own `pendingStatusRecompute` field behind a Swing `Timer` and an EDT hop,
 * with no seam a unit test could drive — so the one bug the rule exists to prevent
 * (a light signal demoting a pending status refresh, which drops the just-created
 * memory from the sidebar with nothing polling to recover it) was guarded only by
 * two comments telling each other to stay in step.
 *
 * Pure in-memory state: no Project, no VFS, no JVM globals, so this runs under the
 * default parallel-tests policy.
 */
class RefreshEscalatorTest {

    @Test
    fun `a fresh window owes nothing`() {
        RefreshEscalator().drain() shouldBe false
    }

    @Test
    fun `a lone light signal stays light`() {
        val escalator = RefreshEscalator()
        escalator.record(statusRecompute = false)
        escalator.drain() shouldBe false
    }

    @Test
    fun `a lone status signal owes a status refresh`() {
        val escalator = RefreshEscalator()
        escalator.record(statusRecompute = true)
        escalator.drain() shouldBe true
    }

    @Test
    fun `a light signal after a status signal does NOT demote it`() {
        // THE regression. A committing agent emits orphan-ref (status) when the
        // summary lands and working-context (light) when the StopHook rewrites
        // plans.json moments later — in that order, inside one window.
        val escalator = RefreshEscalator()
        escalator.record(statusRecompute = true)
        escalator.record(statusRecompute = false)
        escalator.drain() shouldBe true
    }

    @Test
    fun `a status signal after a light signal escalates`() {
        val escalator = RefreshEscalator()
        escalator.record(statusRecompute = false)
        escalator.record(statusRecompute = true)
        escalator.drain() shouldBe true
    }

    @Test
    fun `a long mixed burst still owes a status refresh`() {
        val escalator = RefreshEscalator()
        repeat(5) { escalator.record(statusRecompute = false) }
        escalator.record(statusRecompute = true)
        repeat(5) { escalator.record(statusRecompute = false) }
        escalator.drain() shouldBe true
    }

    @Test
    fun `draining opens a clean window`() {
        val escalator = RefreshEscalator()
        escalator.record(statusRecompute = true)
        escalator.drain() shouldBe true
        // The next window starts fresh: a light-only burst must not inherit the
        // previous window's escalation and pay for a full status round-trip.
        escalator.record(statusRecompute = false)
        escalator.drain() shouldBe false
    }

    @Test
    fun `a signal recorded after a drain belongs to the next window`() {
        val escalator = RefreshEscalator()
        escalator.record(statusRecompute = true)
        escalator.drain() shouldBe true
        escalator.record(statusRecompute = true)
        escalator.drain() shouldBe true
    }

    @Test
    fun `clear discards a pending escalation`() {
        // Teardown: dispose must not leave a flag that a timer callback already
        // queued on the EDT would act on for a released client.
        val escalator = RefreshEscalator()
        escalator.record(statusRecompute = true)
        escalator.clear()
        escalator.drain() shouldBe false
    }

    @Test
    fun `concurrent status signals cannot lose the escalation`() {
        // The reason record() is set-only rather than `x = x || flag`: the VFS
        // listener thread is not confined, so a read-modify-write could interleave
        // and drop a `true` in exactly the concurrent case the stickiness exists
        // for. Threads are released together to make the interleaving real rather
        // than sequential-by-scheduling.
        val escalator = RefreshEscalator()
        val threads = 8
        val pool = Executors.newFixedThreadPool(threads)
        try {
            val start = CountDownLatch(1)
            val done = CountDownLatch(threads)
            repeat(threads) { i ->
                pool.submit {
                    start.await()
                    // One thread carries the status signal; the rest are light
                    // traffic that must not clobber it.
                    escalator.record(statusRecompute = i == 0)
                    done.countDown()
                }
            }
            start.countDown()
            done.await(10, TimeUnit.SECONDS) shouldBe true
            escalator.drain() shouldBe true
        } finally {
            pool.shutdownNow()
        }
    }

    @Test
    fun `drain is atomic - two drainers never both see the escalation`() {
        // getAndSet, not read-then-assign. Exactly one caller may observe a given
        // window's escalation; if both saw it, the second would pay for a second
        // full ide-bridge status round-trip for one signal.
        val escalator = RefreshEscalator()
        val pool = Executors.newFixedThreadPool(2)
        try {
            repeat(200) {
                escalator.record(statusRecompute = true)
                val start = CountDownLatch(1)
                val first = pool.submit<Boolean> { start.await(); escalator.drain() }
                val second = pool.submit<Boolean> { start.await(); escalator.drain() }
                start.countDown()
                listOf(first.get(), second.get()).count { it } shouldBe 1
            }
        } finally {
            pool.shutdownNow()
        }
    }
}

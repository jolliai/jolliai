package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.JmLogger
import java.util.concurrent.atomic.AtomicInteger

/**
 * Diagnostic probe for the JCEF warm-up theory. Numbers every JBCefBrowser created in
 * this session and timestamps it against the probe's init (≈ the first browser), so
 * debug.log shows the creation order and spacing between the throwaway warm-up browser
 * and each real memory-tab browser.
 *
 * The data point that matters: if the first real tab (browser #2, created after the
 * warm-up browser) still takes ~800ms to render, V8 / render-pipeline state does NOT
 * carry across browser instances and the warm-up browser must be physically reused
 * (browser pool) instead. If #2 renders in ~170ms, the shared-process warm-up worked.
 */
object JcefSessionProbe {

    private val log = JmLogger.create("JcefProbe")
    private val counter = AtomicInteger(0)
    private val initNanos = System.nanoTime()

    /** Records one browser creation; returns its session-wide sequence number. */
    fun markBrowserCreated(source: String): Int {
        val n = counter.incrementAndGet()
        log.info(
            "JCEF browser #%d created by %s (T+%dms since probe init)",
            n, source, (System.nanoTime() - initNanos) / 1_000_000,
        )
        return n
    }
}

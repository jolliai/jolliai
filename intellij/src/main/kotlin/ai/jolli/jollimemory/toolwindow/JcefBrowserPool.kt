package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.JmLogger
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.handler.CefLoadHandler
import org.cef.handler.CefRequestHandler
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Pool of reusable [JBCefBrowser] instances shared across memory tabs.
 *
 * WHY:
 *   Constructing a JBCefBrowser costs ~700ms of latency the user sees as a
 *   white flash — a new render subprocess, cold V8, and a 70KB script parse.
 *   Reusing an already-warmed browser keeps V8's bytecode cache alive, so a
 *   subsequent loadHTML with the same script is much faster; the previous
 *   page also stays painted in the native window during the transition, so
 *   the "white → content" flash becomes "old content → new content".
 *
 * WARM-UP LADDER (lazy, per project):
 *   T = IDE-ready       — [warmUp] prewarms 1 browser asynchronously (takes
 *                         over what warmJcefRenderPath() used to throw away).
 *   T = first click     — [acquire] hands out the prewarmed browser instantly;
 *                         a background top-up refills the spare slot.
 *   T = Nth click       — while [idle] has spare, [acquire] is O(1); when
 *                         empty we build one on the EDT (the slow path).
 *   T = tab close       — [PooledBrowserLease.release] returns the browser to
 *                         [idle]; if the pool is over [CAPACITY], LRU evicts
 *                         the oldest idle and disposes it.
 *
 * THREADING:
 *   - [JBCefBrowser.createBuilder] `.build()` MUST run on the EDT (JCEF hard
 *     requirement). Every build call here is inside `invokeLater`, and we
 *     never chain two builds in one dispatch tick.
 *   - [acquire] / [release] are expected to be called on the EDT (from the
 *     FileEditor lifecycle); we still guard the internal collections with a
 *     monitor because [warmUp]'s top-up runs on the EDT concurrently with
 *     tab lifecycle callbacks.
 *   - Render-subprocess work (fork, V8 init, HTML parse) happens off-EDT
 *     automatically — `.build()` returns before it finishes.
 */
@Service(Service.Level.PROJECT)
class JcefBrowserPool(private val project: Project) : Disposable {

    private val monitor = Any()

    /** Idle entries ordered LRU: head = oldest (evict first), tail = most recent. */
    private val idle = ArrayDeque<Entry>()

    /** Currently leased entries; disposed when the pool is disposed. */
    private val leased = mutableSetOf<Entry>()

    private val disposed = AtomicBoolean(false)

    /** Async top-up guard so we don't stack multiple `invokeLater` builds. */
    private val topUpScheduled = AtomicBoolean(false)

    /**
     * Prewarm the first browser. Safe to call multiple times — only the first
     * call actually builds. Runs asynchronously on the EDT via `invokeLater`
     * so IDE startup isn't blocked.
     */
    fun warmUp() {
        scheduleTopUp("warmUp")
    }

    /**
     * Return a warm browser wrapped in a [PooledBrowserLease]. If the pool has
     * an idle browser, it is handed out immediately and a background top-up is
     * scheduled so the next acquire is also fast. If the pool is empty, a new
     * browser is built synchronously on the EDT (the slow path).
     *
     * Must be called on the EDT.
     */
    fun acquire(source: String): PooledBrowserLease {
        assertEdt()
        if (disposed.get()) {
            throw IllegalStateException("JcefBrowserPool is disposed")
        }
        val hit: Entry?
        synchronized(monitor) {
            hit = idle.pollLast()
            if (hit != null) {
                leased.add(hit)
            }
        }
        if (hit != null) {
            log.info("acquire [%s]: reused idle browser #%d (idle=%d, leased=%d)", source, hit.id, idle.size, leased.size)
            scheduleTopUp("acquire:$source")
            return PooledBrowserLease(hit, this)
        }
        // Cold path: build synchronously on the EDT.
        val entry = buildEntry("acquire-cold:$source")
        synchronized(monitor) { leased.add(entry) }
        return PooledBrowserLease(entry, this)
    }

    /**
     * Return an entry to the idle deque, or dispose it if we're over capacity.
     * Called from [PooledBrowserLease.release] after handlers/queries are
     * detached. Must be called on the EDT.
     */
    internal fun releaseEntry(entry: Entry) {
        assertEdt()
        val evicted: Entry?
        synchronized(monitor) {
            leased.remove(entry)
            if (disposed.get()) {
                evicted = entry
            } else if (idle.size + leased.size + 1 > CAPACITY) {
                // Prefer evicting the oldest idle (LRU) so we return `entry` to a
                // hot slot; only if there are no other idle entries do we drop
                // the one being returned.
                val oldest = idle.pollFirst()
                if (oldest != null) {
                    idle.addLast(entry)
                    evicted = oldest
                } else {
                    evicted = entry
                }
            } else {
                idle.addLast(entry)
                evicted = null
            }
        }
        if (evicted != null) {
            log.info("release: over capacity, disposing browser #%d", evicted.id)
            evicted.disposeInternal()
        } else {
            log.info("release: browser #%d returned to idle (idle=%d, leased=%d)", entry.id, idle.size, leased.size)
        }
    }

    /**
     * Try to keep [TARGET_SPARE] idle browsers ready. Coalesces concurrent
     * requests: if a top-up is already scheduled, we skip.
     */
    private fun scheduleTopUp(source: String) {
        if (disposed.get() || project.isDisposed) return
        if (!topUpScheduled.compareAndSet(false, true)) return
        ApplicationManager.getApplication().invokeLater {
            topUpScheduled.set(false)
            if (disposed.get() || project.isDisposed) return@invokeLater
            val needsBuild: Boolean
            synchronized(monitor) {
                needsBuild = idle.size < TARGET_SPARE && idle.size + leased.size < CAPACITY
            }
            if (!needsBuild) return@invokeLater
            val entry = try {
                buildEntry("top-up:$source")
            } catch (e: Exception) {
                log.warn("top-up build failed (non-fatal): %s", e.message ?: "")
                return@invokeLater
            }
            var disposeNow = false
            synchronized(monitor) {
                if (disposed.get()) {
                    disposeNow = true
                } else {
                    idle.addLast(entry)
                }
            }
            if (disposeNow) entry.disposeInternal()
        }
    }

    private fun buildEntry(reason: String): Entry {
        assertEdt()
        val t = System.nanoTime()
        val browser = JBCefBrowser.createBuilder().build()
        val id = JcefSessionProbe.markBrowserCreated("pool:$reason")
        val buildMs = (System.nanoTime() - t) / 1_000_000
        // Prime the native window with a theme-coloured blank page. Without this, a
        // brand-new browser's Chromium NSView (macOS) / native surface needs several
        // frames to paint the full component area on its first loadHTML — during
        // those frames the un-painted region falls back to the JCEF wrapper's white
        // background, producing the "L-shaped white gap around content, filling in
        // over 1-2s" the user saw on first open.
        //
        // The prime loads asynchronously (loadHTML never blocks the EDT); by the
        // time acquire() hands this browser to a real tab, the native surface has
        // already gone through one full paint cycle. The dummy has no <script>, so
        // V8 has nothing to compile — the summary page's bytecode cache is not
        // polluted.
        try {
            // Load with an explicit sentinel URL so downstream load-handlers can
            // recognise "this onLoadEnd is the prime, ignore it" (see PRIME_URL).
            browser.loadHTML(themedBlankHtml(), PRIME_URL)
        } catch (e: Exception) {
            log.warn("prime loadHTML failed (non-fatal): %s", e.message ?: "")
        }
        log.info("buildEntry [%s]: browser #%d build took %dms + prime queued (EDT)", reason, id, buildMs)
        return Entry(id = id, browser = browser)
    }

    /**
     * Minimal HTML that paints the whole viewport with the current editor
     * background colour. Deliberately script-free so V8 has nothing to parse.
     */
    private fun themedBlankHtml(): String {
        val c = com.intellij.openapi.editor.colors.EditorColorsManager
            .getInstance().globalScheme.defaultBackground
        val hex = String.format("#%02x%02x%02x", c.red, c.green, c.blue)
        return "<!doctype html><html><head><style>html,body{margin:0;height:100%;background:$hex;}</style></head><body></body></html>"
    }

    private fun assertEdt() {
        if (!ApplicationManager.getApplication().isDispatchThread) {
            throw IllegalStateException("JcefBrowserPool call must run on the EDT")
        }
    }

    override fun dispose() {
        if (!disposed.compareAndSet(false, true)) return
        val toDispose: List<Entry>
        synchronized(monitor) {
            toDispose = idle.toList() + leased.toList()
            idle.clear()
            leased.clear()
        }
        toDispose.forEach { it.disposeInternal() }
    }

    /** Pool entry — pairs a browser with its session-wide sequence id. */
    class Entry internal constructor(
        val id: Int,
        val browser: JBCefBrowser,
    ) {
        internal fun disposeInternal() {
            try {
                browser.dispose()
            } catch (_: Exception) {
                // Best-effort — JCEF sometimes throws during process teardown.
            }
        }
    }

    companion object {
        private val log = JmLogger.create("JcefBrowserPool")

        /** Hard ceiling on total browsers (idle + leased). */
        const val CAPACITY = 5

        /** How many idle browsers we try to keep on standby. */
        const val TARGET_SPARE = 1

        /**
         * Sentinel URL for the theme-coloured prime page. SummaryPanel's load
         * handler ignores onLoadEnd events with this URL so a prime load
         * completing (or being aborted by the real memory loadHTML) never
         * masquerades as "memory rendered".
         */
        const val PRIME_URL = "https://jolli.local/pool-prime"

        fun get(project: Project): JcefBrowserPool =
            project.getService(JcefBrowserPool::class.java)
    }
}

/**
 * Handle to a browser borrowed from [JcefBrowserPool]. Tracks the JS queries and
 * CEF handlers attached during this lease so that [release] can detach them
 * all — nothing must leak onto the browser between tenants.
 *
 * Attach handlers via [createJSQuery] / [addLoadHandler] / [addRequestHandler]
 * instead of hitting the browser directly, or [release] can't clean them up.
 */
class PooledBrowserLease internal constructor(
    private val entry: JcefBrowserPool.Entry,
    private val pool: JcefBrowserPool,
) {
    val browser: JBCefBrowser get() = entry.browser
    val id: Int get() = entry.id

    private val jsQueries = mutableListOf<JBCefJSQuery>()
    private val loadHandlers = mutableListOf<CefLoadHandler>()
    private val requestHandlers = mutableListOf<CefRequestHandler>()

    private var released = false

    /** Create a JS query bound to this browser; auto-disposed on [release]. */
    fun createJSQuery(): JBCefJSQuery {
        check(!released) { "PooledBrowserLease already released" }
        val q = JBCefJSQuery.create(browser as JBCefBrowserBase)
        jsQueries.add(q)
        return q
    }

    /** Attach a load handler; auto-detached on [release]. */
    fun addLoadHandler(handler: CefLoadHandler) {
        check(!released) { "PooledBrowserLease already released" }
        browser.jbCefClient.addLoadHandler(handler, browser.cefBrowser)
        loadHandlers.add(handler)
    }

    /** Attach a request handler; auto-detached on [release]. */
    fun addRequestHandler(handler: CefRequestHandler) {
        check(!released) { "PooledBrowserLease already released" }
        browser.jbCefClient.addRequestHandler(handler, browser.cefBrowser)
        requestHandlers.add(handler)
    }

    /**
     * Detach every handler/query added via this lease, then return the browser
     * to the pool. Must be called on the EDT. Idempotent — a second call is
     * a no-op.
     */
    fun release() {
        if (released) return
        released = true
        jsQueries.forEach {
            try {
                it.dispose()
            } catch (_: Exception) {
                // Best-effort.
            }
        }
        jsQueries.clear()
        loadHandlers.forEach {
            try {
                browser.jbCefClient.removeLoadHandler(it, browser.cefBrowser)
            } catch (_: Exception) {
                // Best-effort.
            }
        }
        loadHandlers.clear()
        requestHandlers.forEach {
            try {
                browser.jbCefClient.removeRequestHandler(it, browser.cefBrowser)
            } catch (_: Exception) {
                // Best-effort.
            }
        }
        requestHandlers.clear()
        pool.releaseEntry(entry)
    }
}

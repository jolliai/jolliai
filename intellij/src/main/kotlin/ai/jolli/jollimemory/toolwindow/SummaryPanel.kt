package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.bridge.GitRemoteUtils
import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.E2eTestScenario
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliAuthService
import ai.jolli.jollimemory.core.StorageFactory
import ai.jolli.jollimemory.core.StoredSession
import ai.jolli.jollimemory.core.StoredTranscript
import ai.jolli.jollimemory.core.Summarizer
import ai.jolli.jollimemory.core.SummaryStore
import ai.jolli.jollimemory.core.SummaryTree
import ai.jolli.jollimemory.core.TopicUpdates
import ai.jolli.jollimemory.core.TraceContext
import ai.jolli.jollimemory.core.TranscriptEntry
import ai.jolli.jollimemory.core.references.SourceId
import ai.jolli.jollimemory.services.JolliApiClient
import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.services.JolliShareService
import ai.jolli.jollimemory.services.PlanService
import ai.jolli.jollimemory.services.PrService
import ai.jolli.jollimemory.toolwindow.views.SummaryHtmlBuilder
import ai.jolli.jollimemory.toolwindow.views.SummaryMarkdownBuilder
import ai.jolli.jollimemory.toolwindow.views.SummaryPrMarkdownBuilder
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils
import ai.jolli.jollimemory.util.ForcePushUtil
import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.ide.BrowserUtil
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.network.CefRequest
import java.awt.Font
import java.awt.Toolkit
import java.awt.datatransfer.StringSelection
import java.io.File
import java.util.concurrent.TimeUnit
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JTextArea
import java.awt.BorderLayout

/**
 * Reusable JCEF-based summary panel with all interactive handlers.
 *
 * Used by both:
 * - SummaryFileEditor (editor tab — embedded in IDE like VS Code webview)
 * - SummaryViewerDialog (standalone dialog — legacy fallback)
 */
class SummaryPanel(
    private val project: Project,
    summary: CommitSummary,
    private val readOnly: Boolean = false,
) : JPanel(BorderLayout()) {

    @Volatile
    var currentSummary: CommitSummary = summary
        private set


    private var browser: JBCefBrowser? = null
    private var jsQuery: JBCefJSQuery? = null
    private var bridgeScript: String = ""

    // Lease from JcefBrowserPool. Non-null once createContent() succeeds; released
    // (not disposed) on dispose() so the browser goes back to the pool for the next
    // memory tab to reuse — keeping V8's bytecode cache alive across tabs.
    private var lease: PooledBrowserLease? = null

    // Session-wide sequence number of this panel's browser (from JcefSessionProbe) —
    // stamped on the render-complete log so the first real tab after the warm-up
    // browser (#1) is identifiable in debug.log.
    private var browserNumber = 0

    // Set on dispose() so loadDeferredSets()'s async continuation never re-renders a
    // torn-down webview (its pooled task can outlive a quick open-then-close).
    @Volatile
    private var disposed = false

    // Share-overlay auto-open (the Commits-list Share icon opens this editor, then asks the
    // webview to reveal its inline share modal — mirroring the VS Code showWithShareModal flow).
    // pageLoaded flips on the first onLoadEnd; a request that arrives before then is deferred.
    @Volatile
    private var pageLoaded = false

    @Volatile
    private var pendingShareOpen = false

    // Kind for a deferred openShare (true = share the whole branch, false = this memory), and the
    // mode of the currently-open modal so follow-up copy/access/invite commands match it.
    @Volatile
    private var pendingShareBranch = false

    @Volatile
    private var shareBranchMode = false

    // PERF DIAGNOSTICS: loadHTML returns instantly — it only queues the load in the JCEF
    // render process. The user-perceived "render complete" is onLoadEnd. Timestamp the
    // load so onLoadEnd can report the true render latency (and which load triggered it).
    @Volatile
    private var loadStartNanos = 0L

    @Volatile
    private var loadOrigin = ""

    private val gson = Gson()
    private val store: SummaryStore
    private val transcriptHashSet = mutableSetOf<String>()
    private val planTranslateSet = mutableSetOf<String>()
    private val cwd: String
    private val service = project.getService(JolliMemoryService::class.java)
    // Refresh when a PR is created/updated or a memory is shared elsewhere (the Create PR
    // view or the Commits list), so this memory's PR section + "Share in Jolli" state stay
    // in sync — they read the same branch PR + this summary's jolliDocUrl.
    private val memoryStateListener: () -> Unit = { onMemoryStateChanged() }

    init {
        // PERF: this constructor runs on the EDT (FileEditorProvider.createEditor is synchronous),
        // so only JCEF construction + HTML build may stay here. The two data loads that used to
        // run inline — transcript hashes and the plan translate set — moved to loadDeferredSets()
        // below: they only drive cosmetic extras (the transcripts drawer and plan translate
        // buttons), yet they put cold daemon calls (100-700ms right after IDE start, 1-30ms warm)
        // on the UI thread for every tab open. The page now opens instantly with both sets empty
        // and re-renders once the data lands.
        //
        // Panel background matches the current editor colour so any sliver the JCEF native
        // window leaves around itself — sub-pixel size mismatch, a first-paint frame where
        // the native surface hasn't taken over, or the brief moment before BorderLayout
        // reaches the JCEF component — blends into the theme instead of showing Swing's
        // default Panel background (near-white on Light themes, mid-grey on Dark). This is
        // what caused the "1-2s white border around the content" the user reported.
        isOpaque = true
        background = editorBackground()
        val t0 = System.nanoTime()
        cwd = service?.mainRepoRoot ?: project.basePath ?: ""
        val gitOps = service?.getGitOps()
        val git = gitOps ?: GitOps(cwd)
        store = SummaryStore(cwd, git, StorageFactory.create(git, cwd))
        val t1 = System.nanoTime()
        add(createContent(), BorderLayout.CENTER)
        val t2 = System.nanoTime()
        jmLog.info(
            "SummaryPanel.<init> (EDT): storeSetup=%dms createContent=%dms total=%dms hash=%s plans=%d (deferred loads run off-EDT)",
            (t1 - t0) / 1_000_000, (t2 - t1) / 1_000_000, (t2 - t0) / 1_000_000,
            summary.commitHash.take(8), summary.plans?.size ?: 0,
        )
        if (!readOnly) service?.addMemoryStateListener(memoryStateListener)
        loadDeferredSets()
    }

    /**
     * Loads the transcript-hash and plan-translate sets OFF the EDT, then re-renders once
     * they land. Both sets start empty (the initial page renders identically without them),
     * so when they come back empty the reload is skipped — the common case never flashes.
     * A reload is also skipped while the webview is dirty, so edits the user started in the
     * gap between page-open and the sets landing are never clobbered; the next full reload
     * picks the sets up anyway.
     */
    private fun loadDeferredSets() {
        ApplicationManager.getApplication().executeOnPooledThread {
            refreshTranscriptHashes()
            refreshPlanTranslateSet()
            ApplicationManager.getApplication().invokeLater {
                if (disposed) return@invokeLater
                if (webviewDirty) return@invokeLater
                if (transcriptHashSet.isEmpty() && planTranslateSet.isEmpty()) return@invokeLater
                refreshHtml()
            }
        }
    }

    /**
     * Reloads this commit's summary from the store (so a share done elsewhere shows its
     * fresh jolliDocUrl) and re-checks the branch PR, then re-renders — keeping this view
     * in sync with the Create PR view and the Commits list.
     */
    // True while the webview holds unsaved edits (topics / E2E / plans / recap /
    // references / transcripts). Set by the 'editState' message, cleared on every full
    // reload. Guards against a cross-panel memory-state event reloading the page and
    // silently dropping in-progress edits.
    @Volatile
    private var webviewDirty = false

    private fun onMemoryStateChanged() {
        // Never clobber unsaved edits — the PR/share badges will re-sync on the next
        // reload (after the user saves). Dropping in-progress edits is the worse failure.
        if (webviewDirty) return
        ApplicationManager.getApplication().executeOnPooledThread {
            val fresh = try {
                service?.getSummary(currentSummary.commitHash)
            } catch (_: Exception) {
                null
            }
            ApplicationManager.getApplication().invokeLater {
                if (webviewDirty) return@invokeLater
                if (fresh != null) currentSummary = fresh
                refreshHtml()
                handleCheckPrStatus()
            }
        }
    }

    /** Live IDE editor background — the single source of truth for both the JCEF component
     *  background and the page's --bg, so the shell matches the current theme exactly and the
     *  load is seamless. Read on the EDT (createContent / refreshHtml). */
    private fun editorBackground(): java.awt.Color =
        com.intellij.openapi.editor.colors.EditorColorsManager.getInstance().globalScheme.defaultBackground

    private fun java.awt.Color.toCssHex(): String =
        String.format("#%02x%02x%02x", red, green, blue)

    /** True when this colour's luma is below mid-grey. Used to pick the dark vs light
     *  text-colour var set from the SAME colour that backs the page (--bg), so the two
     *  can never disagree. JBColor.isBright() tracks the LaF, which is independent of the
     *  editor colour scheme — using it here could pair the wrong text vars with the page
     *  background (e.g. light LaF + dark editor scheme → invisible text). */
    private fun java.awt.Color.isDarkByLuma(): Boolean =
        (0.299 * red + 0.587 * green + 0.114 * blue) < 128

    private fun createContent(): JComponent {
        return try {
            // PERF DIAGNOSTICS: split JCEF acquire / HTML build / loadHTML so the slow stage shows up.
            val tBrowser0 = System.nanoTime()
            // Reuse a browser from the project-scoped pool instead of building one per tab. The
            // pool prewarms a browser at IDE-ready and returns it here in O(1); subsequent tabs
            // hit the same browser instance so V8's bytecode cache stays warm and the native
            // window keeps the previous page painted during the loadHTML transition — which
            // together turn the old "white → content" flash into "old content → new content".
            //
            // Default (windowed) rendering: Chromium paints straight into a native view. OSR was
            // only enabled so a Swing skeleton could overlay the browser; with the skeleton gone
            // there is nothing to overlay, and OSR's CPU blit was the source of the white "top
            // band" (a not-yet-blitted bitmap). Direct rendering is GPU-accelerated and repaints
            // reliably.
            val acquired = JcefBrowserPool.get(project).acquire("summary-tab:${currentSummary.commitHash.take(8)}")
            lease = acquired
            val b = acquired.browser
            browserNumber = acquired.id
            browser = b

            val query = acquired.createJSQuery()
            jsQuery = query
            query.addHandler { request ->
                try {
                    // Decode Base64 → UTF-8 bytes → String to reverse the encoding
                    // applied in jmSend(). This prevents JCEF's JS→Java IPC bridge
                    // from corrupting multi-byte UTF-8 characters (Chinese, emojis, ·, −, etc.).
                    val decoded = String(java.util.Base64.getDecoder().decode(request), Charsets.UTF_8)
                    val json = JsonParser.parseString(decoded).asJsonObject
                    dispatchWebviewMessage(json)
                } catch (e: Exception) {
                    LOG.warn("Failed to parse webview message: ${e.message}", e)
                }
                JBCefJSQuery.Response("ok")
            }

            // Build the bridge script that will be embedded directly in the HTML
            // (before the main script), so __jbQuery is available immediately when
            // the interactive script runs — no onLoadEnd race condition.
            bridgeScript = """
                window.__jbQuery = function(msg) {
                    ${query.inject("msg")}
                };
            """.trimIndent()

            // Intercept link clicks so external URLs open in the system browser
            // instead of navigating inside the JCEF panel (which has no session/cookies).
            acquired.addRequestHandler(object : CefRequestHandlerAdapter() {
                override fun onBeforeBrowse(
                    browser: CefBrowser?,
                    frame: CefFrame?,
                    request: CefRequest?,
                    userGesture: Boolean,
                    isRedirect: Boolean,
                ): Boolean {
                    val url = request?.url ?: return false
                    if (url.startsWith("http://") || url.startsWith("https://")) {
                        BrowserUtil.browse(url)
                        return true // cancel in-panel navigation
                    }
                    return false
                }
            })

            // Note page-load completion so a deferred share-open request (openShare, from the
            // Commits list) can reveal the inline overlay once the webview JS is defined.
            acquired.addLoadHandler(object : CefLoadHandlerAdapter() {
                override fun onLoadEnd(browser: CefBrowser?, frame: CefFrame?, httpStatusCode: Int) {
                    if (frame?.isMain != true) return
                    // Ignore the pool's prime-page load-end (either natural completion or the
                    // abort fired when our real loadHTML supersedes a still-pending prime).
                    // Without this, a prime that finishes AFTER we attached this handler
                    // would flip pageLoaded prematurely and let maybeOpenShare fire against
                    // a page where shareOpen() doesn't exist yet.
                    if (frame.url == ai.jolli.jollimemory.toolwindow.JcefBrowserPool.PRIME_URL) return
                    // PERF DIAGNOSTICS: the real "page visible" moment — everything between
                    // loadHTML and here (HTML parse, 70KB JS eval, CSS layout, paint) is the
                    // latency the user perceives as "slow to render".
                    val start = loadStartNanos
                    if (start != 0L) {
                        jmLog.info(
                            "webview render complete (onLoadEnd): %dms after loadHTML [%s] browser=#%d",
                            (System.nanoTime() - start) / 1_000_000, loadOrigin, browserNumber,
                        )
                        loadStartNanos = 0L
                    }
                    val wasLoaded = pageLoaded
                    pageLoaded = true
                    maybeOpenShare()
                    // Consume any pending refresh that queued itself while init was still in
                    // flight. Only do this on the transition false→true so the refresh's own
                    // onLoadEnd doesn't re-trigger itself into a loop. Deferred to
                    // invokeLater so we don't nest a loadHTML inside a Chromium load callback.
                    if (!wasLoaded && refreshPending) {
                        refreshPending = false
                        ApplicationManager.getApplication().invokeLater {
                            if (!disposed) doRefreshNow()
                        }
                    }
                }
            })

            val tHtml0 = System.nanoTime()
            // Theme background read live from the IDE so the shell + the page --bg equal the
            // current editor colour (not a hard-coded value). The same colour on the component
            // and in the page (--bg) keeps the load seamless — no white flash, no skeleton.
            val pageBg = editorBackground()
            // isDark from the page bg's luma (not JBColor.isBright()) so the text-colour
            // vars always match --bg; the LaF and the editor colour scheme are independent.
            val isDark = pageBg.isDarkByLuma()
            val pageBgHex = pageBg.toCssHex()
            val html = SummaryHtmlBuilder.buildHtml(currentSummary, isDark, transcriptHashSet, planTranslateSet, bridgeScript, readOnly, pageBgHex)
            val tHtml1 = System.nanoTime()
            // Theme-coloured background BEFORE loadHTML: the Swing component background and
            // the page-level background must both be set before the first load so the native
            // Chromium view never shows its default white.
            b.component.isOpaque = true
            b.component.background = pageBg
            // setPageBackgroundColor injects document.body.style.backgroundColor into the
            // browser's initial about:blank page. Chromium keeps the old page visible until
            // the new page's first frame is committed, so a themed about:blank eliminates the
            // white flash during the about:blank → loadHTML navigation. Without this, the
            // native view's default white background is visible for the entire HTML parse +
            // CSS layout + first-paint window (100-500 ms for a full summary page).
            b.setPageBackgroundColor(pageBgHex)
            // Defer the real loadHTML to the next EDT tick. init's caller does
            //   add(createContent(), BorderLayout.CENTER)
            // which only assigns this component its final size AFTER createContent returns.
            // If we loadHTML synchronously here, Chromium starts painting against the
            // component's still-zero size — on macOS the native CEF view then paints to a
            // stale canvas rect and slowly catches up over 1-2s, which is the white "L"
            // gap the user sees around content on first open. By deferring, the enclosing
            // add() + BorderLayout doLayout run first, the native view has real bounds,
            // and Chromium paints the full tab area from the first frame.
            loadOrigin = "init"
            // Defer the real loadHTML until this component has been ATTACHED to a
            // shown parent and has valid bounds. The caller runs
            //   add(createContent(), BorderLayout.CENTER)
            // which only mark-invalidates the parent; and IntelliJ then takes
            // several EDT ticks to actually mount the FileEditor into the tab
            // hierarchy. `invokeLater` was tried as a fallback earlier and turned
            // out to fire ~5ms after createContent — long before the mount ran —
            // leaving Chromium to paint on a 0×0 canvas. That's what produced the
            // 1-2s white "L-shaped gap around content" on first open (confirmed
            // in debug.log: "loadHTML fired via invokeLater fallback (component=0x0)"
            // and a later "[refresh] render complete" fixing it after loadDeferredSets).
            //
            // Robust signals — fire on whichever comes first:
            //   1) componentResized: BorderLayout ran and gave the browser real bounds
            //   2) HierarchyEvent.SHOWING_CHANGED (isShowing==true): the component
            //      is now attached to a shown parent, which happens strictly after
            //      IntelliJ's own mount + layout — this is the case fresh browsers
            //      hit when no size actually changes (0×0 → real size fires (1),
            //      but a pool-reused browser at the same size doesn't).
            //   3) Immediate fire if the browser arrives already sized AND showing
            //      (fast path for stable pool reuse).
            //   4) Absolute timeout (800 ms) — never leave a browser silent even
            //      if none of the above fire (defensive).
            // AtomicBoolean makes all four idempotent.
            val firedInit = java.util.concurrent.atomic.AtomicBoolean(false)
            // Only fire when the component is BOTH attached (showing) AND sized. IntelliJ's
            // FileEditor mount does these in two separate steps — SHOWING_CHANGED first
            // (isShowing flips to true while width/height are still 0), doLayout later
            // (componentResized fires and width/height become real). Firing after the
            // first step alone reproduces the original bug: Chromium gets a 0×0 canvas,
            // paints to it, and the resulting content ends up scrunched into the
            // top-left with the rest of the tab white until Chromium slowly catches up.
            val fireIfReady = Runnable {
                if (firedInit.get()) return@Runnable
                if (!b.component.isShowing) return@Runnable
                if (b.component.width <= 0 || b.component.height <= 0) return@Runnable
                if (!firedInit.compareAndSet(false, true)) return@Runnable
                if (disposed) return@Runnable
                loadStartNanos = System.nanoTime()
                b.loadHTML(html)
                jmLog.info(
                    "loadHTML fired (component=%dx%d, showing=%s)",
                    b.component.width, b.component.height, b.component.isShowing,
                )
            }
            // Componentlistener: re-check on every resize; keep listening until we actually
            // fire (a 0-width intermediate resize shouldn't burn our one shot).
            val componentListener = object : java.awt.event.ComponentAdapter() {
                override fun componentResized(e: java.awt.event.ComponentEvent) {
                    fireIfReady.run()
                    if (firedInit.get()) b.component.removeComponentListener(this)
                }
            }
            b.component.addComponentListener(componentListener)
            // HierarchyListener: same policy — try, but stay wired if we can't fire yet.
            val hierarchyListener = object : java.awt.event.HierarchyListener {
                override fun hierarchyChanged(e: java.awt.event.HierarchyEvent) {
                    if ((e.changeFlags and java.awt.event.HierarchyEvent.SHOWING_CHANGED.toLong()) != 0L) {
                        fireIfReady.run()
                        if (firedInit.get()) b.component.removeHierarchyListener(this)
                    }
                }
            }
            b.component.addHierarchyListener(hierarchyListener)
            fireIfReady.run()
            // Last-resort timeout: fire even if not ready, so a broken mount never leaves
            // a browser silent forever. Chromium picks up the correct size later via its
            // own resize path — degraded, not broken.
            javax.swing.Timer(1500) {
                if (firedInit.compareAndSet(false, true)) {
                    if (!disposed) {
                        jmLog.warn(
                            "loadHTML forcing fire after 1500ms (component=%dx%d, showing=%s)",
                            b.component.width, b.component.height, b.component.isShowing,
                        )
                        loadStartNanos = System.nanoTime()
                        b.loadHTML(html)
                    }
                }
                b.component.removeComponentListener(componentListener)
                b.component.removeHierarchyListener(hierarchyListener)
            }.apply { isRepeats = false; start() }
            jmLog.info(
                "createContent (EDT): browserSetup=%dms buildHtml=%dms (htmlLen=%d) loadHTML=deferred",
                (tHtml0 - tBrowser0) / 1_000_000, (tHtml1 - tHtml0) / 1_000_000, html.length,
            )
            b.component
        } catch (e: Exception) {
            LOG.info("JCEF unavailable: ${e.message}")
            val markdown = SummaryMarkdownBuilder.buildMarkdown(currentSummary)
            val textArea = JTextArea(markdown).apply {
                isEditable = false
                font = Font("Monospaced", Font.PLAIN, 13)
                lineWrap = true
                wrapStyleWord = true
                caretPosition = 0
            }
            JBScrollPane(textArea)
        }
    }

    fun dispose() {
        disposed = true
        service?.removeMemoryStateListener(memoryStateListener)
        // Release detaches the JS query and CEF handlers we attached, then returns the
        // browser to the pool for reuse instead of disposing it. If the pool is over
        // capacity it will LRU-evict internally — we don't decide that here.
        //
        // JcefBrowserPool.releaseEntry asserts EDT; FileEditor.dispose is normally
        // called on the EDT when a tab is closed, but Disposer can tear editors down
        // from any thread when the project itself is closing. Hop to the EDT so a
        // late shutdown doesn't leak the lease into the leased set and starve the pool.
        val leaseSnapshot = lease
        lease = null
        jsQuery = null
        browser = null
        if (leaseSnapshot != null) {
            if (ApplicationManager.getApplication().isDispatchThread) {
                leaseSnapshot.release()
            } else {
                ApplicationManager.getApplication().invokeLater { leaseSnapshot.release() }
            }
        }
    }

    /**
     * Reveals the inline share overlay in this webview — the entry point used by the Commits-list
     * "Share" icon (commit share) and the sidebar Share button (branch share, [branchShare] = true).
     * Runs `shareOpen(kind)`, which shows the overlay and kicks off the single-slot
     * [ai.jolli.jollimemory.services.BranchShareModal]. Deferred until [pageLoaded] when the editor
     * was just opened for this click.
     */
    fun openShare(branchShare: Boolean = false) {
        pendingShareBranch = branchShare
        pendingShareOpen = true
        maybeOpenShare()
    }

    @Synchronized
    private fun maybeOpenShare() {
        if (pageLoaded && pendingShareOpen) {
            pendingShareOpen = false
            val kind = if (pendingShareBranch) "branch" else "commit"
            ApplicationManager.getApplication().invokeLater {
                val b = browser ?: return@invokeLater
                b.cefBrowser.executeJavaScript(
                    "if (typeof shareOpen === 'function') shareOpen('$kind');",
                    b.cefBrowser.url ?: "",
                    0,
                )
            }
        }
    }

    // ── Webview bridge ──────────────────────────────────────────────────────

    // Success acks for local-patch saves (no full reload). Once one arrives, the prior
    // edits are persisted, so the webview is no longer dirty — clear the flag so
    // cross-panel memory-state events refresh again. (Any further typing re-arms it via
    // the 'editState' input listener.) Without this, webviewDirty would stay true forever
    // after the first save, permanently short-circuiting onMemoryStateChanged().
    private val savePersistedAcks = setOf(
        "topicUpdated", "topicDeleted", "planSaved", "planTranslated", "referenceSaved",
        "recapUpdated", "transcriptsSaved", "transcriptsDeleted", "prCreated", "prUpdated",
    )

    private fun postToWebview(command: String, data: Map<String, Any?> = emptyMap()) {
        if (command in savePersistedAcks) webviewDirty = false
        val payload = gson.toJson(data + ("command" to command))
        // Encode as Base64 to avoid any escaping issues with newlines, quotes, backslashes in content.
        // Use TextDecoder on the JS side to correctly decode UTF-8 multi-byte characters
        // (emojis, ·, −, etc.) that atob() alone would mangle into Latin-1 code points.
        val b64 = java.util.Base64.getEncoder().encodeToString(payload.toByteArray(Charsets.UTF_8))
        browser?.cefBrowser?.executeJavaScript(
            "window.dispatchEvent(new CustomEvent('jollimemory', { detail: JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('$b64'), function(c){ return c.charCodeAt(0); }))) }));",
            browser?.cefBrowser?.url ?: "",
            0,
        )
    }

    @Volatile
    private var refreshPending = false

    private fun refreshHtml() {
        // Wait for the init loadHTML to finish before firing a refresh. Otherwise a
        // refresh triggered by loadDeferredSets — which runs a pooled ide-bridge call
        // in parallel with the init page load and typically returns 30-80 ms later —
        // reaches loadHTML while Chromium is still parsing init's DOM (which itself
        // takes 100-300 ms for the 144 KB summary page). Chromium then aborts init
        // and restarts, and the user sees the tab flash (blank → init partial →
        // blank → refresh painted).
        //
        // Instead of spin-retrying with invokeLater ticks (which drain 100+ ticks in
        // milliseconds and give up long before onLoadEnd fires), latch a pending flag;
        // the onLoadEnd handler picks it up as soon as init finishes and fires the
        // refresh once, cleanly, against a fully-parsed page.
        if (!pageLoaded) {
            refreshPending = true
            return
        }
        doRefreshNow()
    }

    private fun doRefreshNow() {
        // A full reload replaces the DOM, so clear the unsaved-edits flag: future
        // memory-state events may refresh again.
        webviewDirty = false
        val pageBg = editorBackground()
        val isDark = pageBg.isDarkByLuma()
        val pageBgHex = pageBg.toCssHex()
        val html = SummaryHtmlBuilder.buildHtml(currentSummary, isDark, transcriptHashSet, planTranslateSet, bridgeScript, readOnly, pageBgHex)
        loadOrigin = "refresh"
        loadStartNanos = System.nanoTime()
        browser?.loadHTML(html)
    }

    private fun refreshTranscriptHashes() {
        transcriptHashSet.clear()
        try {
            // CLI-owned getTranscriptIds: v5 `summary.transcripts` UUIDs (with a
            // v3/v4 commit-hash fallback) intersected with the transcript files
            // actually on the orphan branch — mirroring the VS Code panel.
            val allIds = SummaryTree.getTranscriptIds(currentSummary)
            val onBranch = store.getTranscriptHashes()
            transcriptHashSet.addAll(allIds.toSet().intersect(onBranch))
            LOG.info("refreshTranscriptHashes: tree=${allIds.size}, onBranch=${onBranch.size}, matched=${transcriptHashSet.size}")
        } catch (e: Exception) {
            LOG.warn("refreshTranscriptHashes failed: ${e.message}", e)
        }
    }

    private fun refreshPlanTranslateSet() {
        planTranslateSet.clear()
        // PERF: each readPlanFromBranch below is one ide-bridge call — the per-plan loop makes
        // this O(plans) calls, which is why it runs via loadDeferredSets() off the EDT.
        val t0 = System.nanoTime()
        val cjkPattern = Regex("[\\u4E00-\\u9FFF\\u3400-\\u4DBF\\uF900-\\uFAFF]")
        val plans = SummaryUtils.collectAllPlans(currentSummary)
        var branchReads = 0
        for (plan in plans) {
            if (cjkPattern.containsMatchIn(plan.title)) {
                planTranslateSet.add(plan.slug)
                continue
            }
            try {
                branchReads++
                val content = store.readPlanFromBranch(plan.slug) ?: continue
                if (cjkPattern.containsMatchIn(content)) planTranslateSet.add(plan.slug)
            } catch (_: Exception) { /* skip */ }
        }
        jmLog.info(
            "refreshPlanTranslateSet (deferred): plans=%d branchReads=%d took=%dms",
            plans.size, branchReads, (System.nanoTime() - t0) / 1_000_000,
        )
    }

    // ── Message dispatcher ──────────────────────────────────────────────────

    /** Commands that modify data — blocked in read-only mode. */
    private val writeCommands = setOf(
        "pushToJolli", "editTopic", "deleteTopic", "generateE2eTest", "editE2eTest",
        "deleteE2eTest", "savePlan", "removePlan", "translatePlan", "associatePlan",
        "createPrDirect", "createPrWithE2e", "createPr", "updatePr", "saveAllTranscripts", "deleteAllTranscripts",
        "generateRecap", "editRecap", "saveReferenceEdit", "removeReference",
        "shareCopyLink", "shareSetAccess", "shareSendInvite", "shareRemoveRecipient",
    )

    private fun dispatchWebviewMessage(json: JsonObject) {
        val command = json.get("command")?.asString ?: return
        if (readOnly && command in writeCommands) {
            LOG.info("Blocked write command '$command' in read-only mode")
            return
        }
        try {
            when (command) {
                // Page-side performance probe (SummaryHtmlBuilder PERF_PROBE_SCRIPT): the
                // page's own view of when it became visible — contrasts with the Kotlin
                // onLoadEnd number to expose post-load paint/composite latency.
                "perfProbe" -> {
                    val label = json.get("label")?.asString
                    jmLog.info(
                        "webview perf browser=#%d [%s]: +%dms after navigation",
                        browserNumber, label, json.get("ms")?.asInt,
                    )
                    // Diagnostic only: page-side timing signal for debug.log (the skeleton /
                    // OSR cover is gone, so firstPaint is just a latency data point now).
                }
                "editState" -> webviewDirty = json.get("editing")?.asBoolean == true
                "copyMarkdown" -> handleCopyMarkdown()
                "downloadMarkdown" -> handleDownloadMarkdown()
                "pushToJolli" -> handlePushToJolli()
                "shareBranch" -> {
                    // 'branch' shares the whole branch (commitHash = null); 'commit' (default)
                    // shares this memory. Remembered so the follow-up copy/access/invite commands
                    // build the same context.
                    shareBranchMode = json.get("shareKind")?.asString == "branch"
                    handleShareCommand(opensModal = true) { io, ctx -> ai.jolli.jollimemory.services.BranchShareModal.openShareModal(io, ctx) }
                }
                "shareCopyLink" -> {
                    val v = json.get("visibility")?.asString ?: "public"
                    handleShareCommand { io, ctx -> ai.jolli.jollimemory.services.BranchShareModal.copyShareLinkModal(io, ctx, v) }
                }
                "shareSetAccess" -> {
                    val v = json.get("visibility")?.asString ?: "public"
                    handleShareCommand { io, ctx -> ai.jolli.jollimemory.services.BranchShareModal.setShareAccessModal(io, ctx, v) }
                }
                "shareSendInvite" -> {
                    val recipients = json.getAsJsonArray("recipients")?.mapNotNull { it.asString } ?: emptyList()
                    val note = json.get("message")?.asString?.take(2000)
                    val vis = json.get("visibility")?.asString
                    handleShareCommand { io, ctx -> ai.jolli.jollimemory.services.BranchShareModal.sendInviteModal(io, ctx, recipients, note, vis) }
                }
                "shareRemoveRecipient" -> {
                    val email = json.get("email")?.asString ?: ""
                    handleShareCommand { io, ctx -> ai.jolli.jollimemory.services.BranchShareModal.removeRecipientModal(io, ctx, email) }
                }
                "editTopic" -> handleEditTopic(json.get("topicIndex").asInt, json.getAsJsonObject("updates"))
                "deleteTopic" -> handleDeleteTopic(json.get("topicIndex").asInt, json.get("title")?.asString)
                "generateE2eTest" -> handleGenerateE2eTest()
                "editE2eTest" -> handleEditE2eTest(json.getAsJsonArray("scenarios"))
                "deleteE2eTest" -> handleDeleteE2eTest()
                "loadPlanContent" -> handleLoadPlanContent(json.get("slug").asString)
                "savePlan" -> handleSavePlan(json.get("slug").asString, json.get("content").asString)
                "removePlan" -> handleRemovePlan(json.get("slug").asString, json.get("title")?.asString ?: "")
                "translatePlan" -> handleTranslatePlan(json.get("slug").asString)
                "associatePlan" -> handleAssociatePlan()
                "checkPrStatus" -> handleCheckPrStatus()
                "createPrDirect" -> showCreatePrForm()
                "createPrWithE2e" -> handleCreatePrWithE2e()
                "createPr" -> handleCreatePr(json.get("title").asString, json.get("body").asString)
                "prepareUpdatePr" -> handlePrepareUpdatePr()
                "updatePr" -> handleUpdatePr(json.get("title").asString, json.get("body").asString)
                "loadTranscriptStats" -> handleLoadTranscriptStats()
                "loadAllTranscripts" -> handleLoadAllTranscripts()
                "saveAllTranscripts" -> handleSaveAllTranscripts(json.getAsJsonArray("entries"))
                "deleteAllTranscripts" -> handleDeleteAllTranscripts()
                "generateRecap" -> handleGenerateRecap()
                "editRecap" -> handleEditRecap(json.get("recap").asString)
                "previewReference" -> handlePreviewReference(json.get("archivedKey").asString, json.get("source").asString, json.get("nativeId")?.asString ?: "", json.get("title")?.asString ?: "")
                "openReferenceExternal" -> handleOpenReferenceExternal(json.get("url").asString)
                "loadReferenceContent" -> handleLoadReferenceContent(json.get("archivedKey").asString, json.get("source").asString)
                "saveReferenceEdit" -> handleSaveReferenceEdit(json.get("archivedKey").asString, json.get("source").asString, json.get("content").asString)
                "removeReference" -> handleRemoveReference(json.get("archivedKey").asString, json.get("source").asString, json.get("nativeId")?.asString ?: "", json.get("title")?.asString ?: "")
                else -> LOG.debug("Unknown webview command: $command")
            }
        } catch (e: Exception) {
            LOG.warn("Handler error for '$command': ${e.message}", e)
            postToWebview("error", mapOf("message" to (e.message ?: "Unknown error")))
        }
    }

    // ── Handlers ────────────────────────────────────────────────────────────

    private fun handleCopyMarkdown() {
        val markdown = SummaryMarkdownBuilder.buildMarkdown(currentSummary)
        val clipboard = Toolkit.getDefaultToolkit().systemClipboard
        clipboard.setContents(StringSelection(markdown), null)
    }

    /**
     * "Save as Markdown File" export-menu item. Renders the same Markdown as
     * [handleCopyMarkdown] and writes it to a user-chosen path via the IDE's
     * native save dialog (mirrors the VS Code Export → Save as Markdown File).
     * A read-only export — not gated by [writeCommands] — so it works on stale
     * or foreign memories too.
     */
    private fun handleDownloadMarkdown() {
        val markdown = SummaryMarkdownBuilder.buildMarkdown(currentSummary)
        val safeTitle = currentSummary.commitMessage.substringBefore("\n").trim()
            .replace(Regex("""[<>:"/\\|?*]"""), "-")
            .take(80)
            .ifBlank { "memory" }
        ApplicationManager.getApplication().invokeLater {
            // 2-arg constructor + withExtensionFilter is the non-deprecated form (2025.1+);
            // the vararg-extensions constructor is deprecated and flagged by the Marketplace
            // verifier. withExtensionFilter mutates the descriptor in place and returns the
            // FileChooserDescriptor base, so call it as a statement and keep `descriptor` typed
            // as FileSaverDescriptor for createSaveFileDialog.
            val descriptor = com.intellij.openapi.fileChooser.FileSaverDescriptor(
                "Save Memory As Markdown",
                "Export this memory to a Markdown file.",
            )
            descriptor.withExtensionFilter("Markdown", "md")
            val baseDir = project.basePath
                ?.let { com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath(it) }
            val wrapper = com.intellij.openapi.fileChooser.FileChooserFactory.getInstance()
                .createSaveFileDialog(descriptor, project)
                .save(baseDir, "$safeTitle.md") ?: return@invokeLater
            try {
                wrapper.file.writeText(markdown, Charsets.UTF_8)
                com.intellij.notification.NotificationGroupManager.getInstance()
                    .getNotificationGroup("JolliMemory")
                    .createNotification(
                        "Memory exported",
                        "Saved to ${wrapper.file.absolutePath}",
                        com.intellij.notification.NotificationType.INFORMATION,
                    )
                    .notify(project)
            } catch (e: Exception) {
                Messages.showErrorDialog(project, "Save failed: ${e.message}", "Export Failed")
            }
        }
    }

    // ── In-webview share modal (single-slot, mirrors the VS Code webview modal) ──

    /**
     * Runs a [ai.jolli.jollimemory.services.BranchShareModal] entry point on a pooled thread,
     * driving the webview-backed IO. The context (owner / org directory / git contributors /
     * binding chooser) is assembled off the EDT. [shareBranchMode] selects a branch-wide share
     * (commitHash = null) vs. this single memory — set from the opening `shareBranch` message and
     * reused by the follow-up copy/access/invite commands.
     */
    private fun handleShareCommand(
        opensModal: Boolean = false,
        action: (ai.jolli.jollimemory.services.BranchShareModal.ShareModalIO, ai.jolli.jollimemory.services.BranchShareModal.ShareModalContext) -> Unit,
    ) {
        val summary = currentSummary
        val branchShare = shareBranchMode
        ApplicationManager.getApplication().executeOnPooledThread {
            TraceContext.withTrace {
                try {
                    val ctx = if (branchShare) {
                        ShareContextFactory.build(project, summary.branch, summary.branch, null, null)
                    } else {
                        ShareContextFactory.build(project, summary.branch, summary.commitMessage, summary.commitHash, summary)
                    }
                    action(shareModalIO(), ctx)
                } catch (e: Exception) {
                    LOG.warn("Share action failed: ${e.message}", e)
                    if (opensModal) {
                        postToWebview("shareState", mapOf("state" to mapOf("kind" to "error", "message" to (e.message ?: "Share failed"))))
                    }
                }
            }
        }
    }

    /** Webview-backed [ai.jolli.jollimemory.services.BranchShareModal.ShareModalIO]. */
    private fun shareModalIO() = object : ai.jolli.jollimemory.services.BranchShareModal.ShareModalIO {
        override fun postState(state: ai.jolli.jollimemory.services.BranchShareModal.ShareModalState) {
            ApplicationManager.getApplication().invokeLater {
                postToWebview("shareState", mapOf("state" to shareStateToMap(state)))
            }
        }

        override fun copyToClipboard(text: String): Boolean = try {
            Toolkit.getDefaultToolkit().systemClipboard.setContents(StringSelection(text), null)
            true
        } catch (_: Exception) {
            false
        }

        override fun postCopyResult(result: ai.jolli.jollimemory.services.BranchShareModal.ShareCopyResult) {
            ApplicationManager.getApplication().invokeLater {
                postToWebview("shareCopyResult", mapOf("ok" to result.ok))
            }
        }

        override fun notifyError(message: String) = shareNotify(message, com.intellij.notification.NotificationType.ERROR)
        override fun notifyInfo(message: String) = shareNotify(message, com.intellij.notification.NotificationType.INFORMATION)
    }

    private fun shareNotify(message: String, type: com.intellij.notification.NotificationType) {
        ApplicationManager.getApplication().invokeLater {
            com.intellij.notification.NotificationGroupManager.getInstance()
                .getNotificationGroup("JolliMemory")
                .createNotification("Jolli Share", message, type)
                .notify(project)
        }
    }

    /** Serializes a modal state to the JSON shape the webview's shareRender() expects. */
    private fun shareStateToMap(state: ai.jolli.jollimemory.services.BranchShareModal.ShareModalState): Map<String, Any?> =
        ai.jolli.jollimemory.toolwindow.views.ShareWebview.stateToMap(state)
    private fun handlePushToJolli(retried: Boolean = false) {
        val summary = currentSummary
        val config = SessionTracker.loadConfig(cwd)
        if (config.jolliApiKey.isNullOrBlank()) {
            ApplicationManager.getApplication().invokeLater {
                Messages.showWarningDialog(project, "Please sign in or configure a Jolli API Key in Settings > Tools > Jolli Memory.", "Missing API Key")
            }
            return
        }

        val keyMeta = JolliApiClient.parseJolliApiKey(config.jolliApiKey!!)
        val resolvedBaseUrl = keyMeta?.u
            ?: ai.jolli.jollimemory.auth.JolliUrlConfig.getJolliUrl()
        if (resolvedBaseUrl.isBlank()) {
            ApplicationManager.getApplication().invokeLater {
                Messages.showWarningDialog(project, "Jolli site URL could not be determined. Please regenerate your Jolli API Key.", "Invalid API Key")
            }
            return
        }

        postToWebview("pushStarted")

        ApplicationManager.getApplication().executeOnPooledThread {
            // One trace per push operation (on this pooled thread) so the push
            // logs, the binding-required retry, and every pushToJolli/listSpaces
            // call share one id; ThreadLocal must be set on the worker thread.
            TraceContext.withTrace {
                try {
                    // The push core lives in JolliShareService so the Create-PR view can
                    // reuse the exact same logic; the binding/re-auth/UI handling below
                    // stays panel-side.
                    val res = JolliShareService.shareSummary(store, summary, cwd, config.jolliApiKey!!, resolvedBaseUrl)
                    currentSummary = res.updatedSummary

                    ApplicationManager.getApplication().invokeLater {
                        refreshHtml()
                        val verb = if (summary.jolliDocUrl != null) "Updated" else "Pushed"
                        val planMsg = if (res.planCount > 0) " (with ${res.planCount} plan${if (res.planCount > 1) "s" else ""})" else ""
                        Messages.showInfoMessage(project, "$verb on Jolli Space$planMsg.", "Push Successful")
                        // This memory is now shared — let the Create PR view + Commits list update.
                        service?.notifyMemoryStateChanged()
                    }
                } catch (e: JolliApiClient.BindingRequiredError) {
                    if (retried) {
                        ApplicationManager.getApplication().invokeLater {
                            postToWebview("pushFailed")
                            Messages.showErrorDialog(project, "Push failed: binding still not found after retry. Please try again.", "Push Error")
                        }
                    } else {
                        handleBindingRequired(e.repoUrl, resolvedBaseUrl, config.jolliApiKey!!)
                    }
                } catch (e: JolliApiClient.PluginOutdatedError) {
                    ApplicationManager.getApplication().invokeLater {
                        postToWebview("pushFailed")
                        Messages.showErrorDialog(project, "Push failed -- your JolliMemory plugin is outdated. Please update.", "Plugin Outdated")
                    }
                } catch (e: JolliApiClient.UnauthorizedError) {
                    // Server rejected the key (invalid/disabled). Offer to re-authenticate
                    // and retry once — self-heals a stale/deleted key.
                    ai.jolli.jollimemory.core.telemetry.Telemetry.track("key_rejected", mapOf("retried" to retried, "where" to "push"))
                    ApplicationManager.getApplication().invokeLater {
                        postToWebview("pushFailed")
                        if (retried) {
                            Messages.showErrorDialog(project, "Push failed: ${e.message}", "Push Error")
                            return@invokeLater
                        }
                        val choice = Messages.showYesNoDialog(
                            project,
                            "Your Jolli key was rejected by the server (invalid or disabled).\n\nRe-authenticate and retry the push?",
                            "Re-authenticate",
                            Messages.getQuestionIcon(),
                        )
                        if (choice == Messages.YES) reauthenticateAndRetry()
                    }
                } catch (e: Exception) {
                    ai.jolli.jollimemory.core.telemetry.Telemetry.trackError("push", "push_failed")
                    ApplicationManager.getApplication().invokeLater {
                        postToWebview("pushFailed")
                        Messages.showErrorDialog(project, "Push failed: ${e.message}", "Push Error")
                    }
                }
            }
        }
    }

    /**
     * Clears the stale Jolli key, runs the login flow (which mints a FRESH key — a
     * same-tenant re-login would otherwise keep the existing, now-disabled one), and
     * retries the push once on success.
     */
    private fun reauthenticateAndRetry() {
        ApplicationManager.getApplication().executeOnPooledThread {
            val dir = SessionTracker.getGlobalConfigDir()
            SessionTracker.saveConfigToDir(SessionTracker.loadConfigFromDir(dir).copy(jolliApiKey = null), dir)
            ApplicationManager.getApplication().invokeLater {
                JolliAuthService.login(
                    onSuccess = {
                        ai.jolli.jollimemory.core.telemetry.Telemetry.track("reauth_completed", mapOf("outcome" to "success"))
                        handlePushToJolli(retried = true)
                    },
                    onError = { msg ->
                        ai.jolli.jollimemory.core.telemetry.Telemetry.track("reauth_completed", mapOf("outcome" to "failed"))
                        ApplicationManager.getApplication().invokeLater {
                            Messages.showErrorDialog(project, "Re-authentication failed: $msg", "Push Error")
                        }
                    },
                )
            }
        }
    }

    /**
     * Handles a 412 binding_required error: fetches available spaces on the
     * current background thread, then switches to the UI thread to show the
     * chooser dialog. If the user picks a space, retries the push.
     */
    private fun handleBindingRequired(repoUrl: String, baseUrl: String, apiKey: String) {
        val spacesResult = try {
            JolliApiClient.listSpaces(baseUrl, apiKey)
        } catch (e: Exception) {
            ApplicationManager.getApplication().invokeLater {
                postToWebview("pushFailed")
                Messages.showErrorDialog(project, "Failed to load Memory spaces: ${e.message}", "Push Error")
            }
            return
        }

        val suggestedRepoName = GitRemoteUtils.deriveRepoNameFromUrl(repoUrl).ifEmpty { "repo" }

        ApplicationManager.getApplication().invokeLater {
            if (BindingChooserDialog.isAlreadyOpen(repoUrl)) {
                postToWebview("pushFailed")
                Messages.showInfoMessage(project, "A binding chooser is already open for this repo. Finish there, then push again.", "Chooser Already Open")
                return@invokeLater
            }

            val dialog = BindingChooserDialog.open(
                project, repoUrl, suggestedRepoName,
                spacesResult.spaces, spacesResult.defaultSpaceId,
                baseUrl, apiKey,
            )
            LOG.info("handleBindingRequired: showing chooser dialog (repoUrl=$repoUrl)")
            dialog.show()
            LOG.info("handleBindingRequired: dialog.show() returned; outcome=${dialog.getOutcome()}")

            when (dialog.getOutcome()) {
                is BindingChooserOutcome.Selected -> {
                    handlePushToJolli(retried = true)
                }
                is BindingChooserOutcome.Cancelled -> {
                    postToWebview("pushFailed")
                    Messages.showInfoMessage(project, "Push cancelled — no Memory space was selected.", "Push Cancelled")
                }
                is BindingChooserOutcome.AnotherOpen -> {
                    postToWebview("pushFailed")
                    Messages.showInfoMessage(project, "A binding chooser is already open for this repo. Finish there, then push again.", "Chooser Already Open")
                }
            }
        }
    }

    private fun handleEditTopic(topicIndex: Int, updatesJson: JsonObject) {
        val updates = TopicUpdates(
            title = updatesJson.get("title")?.asString,
            trigger = updatesJson.get("trigger")?.asString,
            response = updatesJson.get("response")?.asString,
            decisions = updatesJson.get("decisions")?.asString,
            todo = updatesJson.get("todo")?.asString,
            filesAffected = updatesJson.getAsJsonArray("filesAffected")?.map { it.asString },
        )

        val result = SummaryTree.updateTopicInTree(currentSummary, topicIndex, updates)
        if (result == null) {
            postToWebview("topicUpdateError", mapOf("message" to "Memory index $topicIndex is out of range"))
            return
        }

        ApplicationManager.getApplication().executeOnPooledThread {
            store.storeSummary(result.result, force = true)
            currentSummary = result.result

            val (allTopics) = SummaryUtils.collectSortedTopics(result.result)
            val displayIndex = allTopics.indexOfFirst { it.topic.treeIndex == topicIndex }
            val topic = if (displayIndex >= 0) allTopics[displayIndex] else null
            val html = if (topic != null) SummaryHtmlBuilder.renderTopic(topic, displayIndex) else ""

            ApplicationManager.getApplication().invokeLater {
                postToWebview("topicUpdated", mapOf("topicIndex" to topicIndex, "html" to html))
            }
        }
    }

    private fun handleDeleteTopic(topicIndex: Int, topicTitle: String?) {
        ApplicationManager.getApplication().invokeLater {
            val detail = if (topicTitle != null) "\"$topicTitle\"\n\nThis cannot be undone." else "This cannot be undone."
            val choice = Messages.showYesNoDialog(project, detail, "Delete Memory?", "Delete", "Cancel", Messages.getWarningIcon())
            if (choice != Messages.YES) return@invokeLater

            ApplicationManager.getApplication().executeOnPooledThread {
                val result = SummaryTree.deleteTopicInTree(currentSummary, topicIndex)
                if (result == null) {
                    ApplicationManager.getApplication().invokeLater {
                        postToWebview("topicDeleteError", mapOf("message" to "Memory index $topicIndex is out of range"))
                    }
                    return@executeOnPooledThread
                }
                store.storeSummary(result.result, force = true)
                currentSummary = result.result
                ApplicationManager.getApplication().invokeLater {
                    refreshHtml()
                    postToWebview("topicDeleted", mapOf("topicIndex" to topicIndex))
                }
            }
        }
    }

    private fun handleGenerateE2eTest() {
        postToWebview("e2eTestGenerating")
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                generateAndStoreE2eTest()
                val html = SummaryHtmlBuilder.buildE2eTestSection(currentSummary)
                ApplicationManager.getApplication().invokeLater { postToWebview("e2eTestUpdated", mapOf("html" to html)) }
            } catch (e: Exception) {
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("e2eTestError", mapOf("message" to (e.message ?: "Generation failed")))
                    Messages.showErrorDialog(project, "E2E test generation failed: ${e.message}", "Error")
                }
            }
        }
    }

    /**
     * Generates an E2E test guide for [currentSummary] via the LLM, persists it,
     * and swaps [currentSummary] to the updated copy. Runs synchronously — call
     * from a pooled thread. Shared by [handleGenerateE2eTest] and the Create PR flow.
     */
    private fun generateAndStoreE2eTest(): List<E2eTestScenario> {
        val summary = currentSummary
        val config = SessionTracker.loadConfig(cwd)
        val (topics) = SummaryUtils.collectSortedTopics(summary)
        val diff = getDiffForCommit(summary.commitHash)
        jmLog.info(
            "generateAndStoreE2eTest: topics=%d, diff len=%d, provider=%s, model=%s, hasApiKey=%s, hasJolliKey=%s",
            topics.size, diff.length, config.aiProvider ?: "<null>", config.model ?: "<null>",
            (!config.apiKey.isNullOrBlank()).toString(), (!config.jolliApiKey.isNullOrBlank()).toString(),
        )

        val scenarios = Summarizer.generateE2eTest(Summarizer.E2eTestParams(
            topics = topics.map { it.topic.topic },
            commitMessage = summary.commitMessage, diff = diff,
            apiKey = config.apiKey, model = config.model, jolliApiKey = config.jolliApiKey,
            aiProvider = config.aiProvider,
        ))
        jmLog.info("generateAndStoreE2eTest: LLM returned %d scenario(s); persisting", scenarios.size)

        val updatedSummary = summary.copy(e2eTestGuide = scenarios)
        store.storeSummary(updatedSummary, force = true)
        currentSummary = updatedSummary
        return scenarios
    }

    private fun handleEditE2eTest(scenariosJson: JsonArray) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val scenarios = scenariosJson.map { el ->
                val obj = el.asJsonObject
                E2eTestScenario(
                    title = obj.get("title").asString,
                    preconditions = obj.get("preconditions")?.asString,
                    steps = obj.getAsJsonArray("steps").map { it.asString },
                    expectedResults = obj.getAsJsonArray("expectedResults").map { it.asString },
                )
            }
            val updatedSummary = currentSummary.copy(e2eTestGuide = scenarios)
            store.storeSummary(updatedSummary, force = true)
            currentSummary = updatedSummary
            val html = SummaryHtmlBuilder.buildE2eTestSection(updatedSummary)
            ApplicationManager.getApplication().invokeLater { postToWebview("e2eTestUpdated", mapOf("html" to html)) }
        }
    }

    private fun handleDeleteE2eTest() {
        ApplicationManager.getApplication().invokeLater {
            val choice = Messages.showYesNoDialog(project, "This will remove all test scenarios. This cannot be undone.", "Delete E2E Test Guide?", "Delete", "Cancel", Messages.getWarningIcon())
            if (choice != Messages.YES) return@invokeLater
            ApplicationManager.getApplication().executeOnPooledThread {
                val updatedSummary = currentSummary.copy(e2eTestGuide = null)
                store.storeSummary(updatedSummary, force = true)
                currentSummary = updatedSummary
                val html = SummaryHtmlBuilder.buildE2eTestSection(updatedSummary)
                ApplicationManager.getApplication().invokeLater { postToWebview("e2eTestUpdated", mapOf("html" to html)) }
            }
        }
    }

    private fun handleGenerateRecap() {
        postToWebview("recapGenerating")
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val summary = currentSummary
                val config = SessionTracker.loadConfig(cwd)
                val (topics) = SummaryUtils.collectSortedTopics(summary)

                val recap = Summarizer.generateRecap(Summarizer.RecapParams(
                    topics = topics.map { it.topic.topic },
                    commitMessage = summary.commitMessage,
                    apiKey = config.apiKey, model = config.model, jolliApiKey = config.jolliApiKey,
                ))

                val trimmed = recap.trim()
                if (trimmed.isEmpty()) {
                    ApplicationManager.getApplication().invokeLater {
                        postToWebview("recapUpdateError")
                        Messages.showInfoMessage(project, "No major topics in this commit, so there's nothing to recap.", "Recap")
                    }
                    return@executeOnPooledThread
                }

                val updatedSummary = summary.copy(recap = trimmed)
                store.storeSummary(updatedSummary, force = true)
                currentSummary = updatedSummary
                val html = SummaryHtmlBuilder.buildRecapSection(updatedSummary)
                ApplicationManager.getApplication().invokeLater { postToWebview("recapUpdated", mapOf("html" to html)) }
            } catch (e: Exception) {
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("recapUpdateError", mapOf("message" to (e.message ?: "Generation failed")))
                    Messages.showErrorDialog(project, "Recap generation failed: ${e.message}", "Error")
                }
            }
        }
    }

    private fun handleEditRecap(recap: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val updatedSummary = currentSummary.copy(recap = recap.ifEmpty { null })
                store.storeSummary(updatedSummary, force = true)
                currentSummary = updatedSummary
                val html = SummaryHtmlBuilder.buildRecapSection(updatedSummary)
                ApplicationManager.getApplication().invokeLater { postToWebview("recapUpdated", mapOf("html" to html)) }
            } catch (e: Exception) {
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("recapUpdateError", mapOf("message" to (e.message ?: "Save failed")))
                    Messages.showErrorDialog(project, "Recap save failed: ${e.message}", "Error")
                }
            }
        }
    }

    private fun handleLoadPlanContent(slug: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val content = store.readPlanFromBranch(slug)
            ApplicationManager.getApplication().invokeLater {
                if (content == null) Messages.showErrorDialog(project, "Could not read plan \"$slug\".", "Load Plan Failed")
                else postToWebview("planContentLoaded", mapOf("slug" to slug, "content" to content))
            }
        }
    }

    private fun handleSavePlan(slug: String, content: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            store.writePlanToBranch(slug, content, "Edit plan $slug")
            syncPlanTitle(slug, content)
            ApplicationManager.getApplication().invokeLater { postToWebview("planSaved", mapOf("slug" to slug)) }
        }
    }

    private fun handleRemovePlan(slug: String, title: String) {
        ApplicationManager.getApplication().invokeLater {
            val choice = Messages.showYesNoDialog(project, "The plan will no longer be associated with this commit.", "Remove plan \"$title\"?", "Remove", "Cancel", Messages.getWarningIcon())
            if (choice != Messages.YES) return@invokeLater
            ApplicationManager.getApplication().executeOnPooledThread {
                val updatedPlans = (currentSummary.plans ?: emptyList()).filter { it.slug != slug }
                val updatedSummary = currentSummary.copy(plans = updatedPlans.takeIf { it.isNotEmpty() })
                store.storeSummary(updatedSummary, force = true)
                currentSummary = updatedSummary
                PlanService.unassociatePlanFromCommit(slug, cwd)
                ApplicationManager.getApplication().invokeLater { refreshHtml() }
            }
        }
    }

    // ── Reference handlers ──────────────────────────────────────────────

    private fun parseSourceId(source: String): SourceId? {
        return try { SourceId.valueOf(source) } catch (_: Exception) { null }
    }

    private fun handlePreviewReference(archivedKey: String, source: String, nativeId: String, title: String) {
        val sourceId = parseSourceId(source) ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            val content = store.readReferenceFromBranch(sourceId, archivedKey)
            if (content == null) {
                ApplicationManager.getApplication().invokeLater {
                    Messages.showErrorDialog(project, "Could not read reference \"$nativeId\" from storage.", "Load Reference Failed")
                }
                return@executeOnPooledThread
            }
            ApplicationManager.getApplication().invokeLater {
                val displayTitle = "$nativeId — $title"
                val tmpFile = java.io.File.createTempFile("jm-ref-", ".md")
                tmpFile.writeText(content)
                tmpFile.deleteOnExit()
                val vf = com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByIoFile(tmpFile)
                if (vf != null) {
                    com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(vf, true)
                }
            }
        }
    }

    private fun handleOpenReferenceExternal(url: String) {
        try {
            val uri = java.net.URI(url)
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") {
                ApplicationManager.getApplication().invokeLater {
                    Messages.showWarningDialog(project, "Only http(s) URLs can be opened.", "Invalid URL")
                }
                return
            }
            BrowserUtil.browse(uri)
        } catch (e: Exception) {
            ApplicationManager.getApplication().invokeLater {
                Messages.showErrorDialog(project, "Could not open URL: ${e.message}", "Error")
            }
        }
    }

    private fun handleLoadReferenceContent(archivedKey: String, source: String) {
        val sourceId = parseSourceId(source) ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            val content = store.readReferenceFromBranch(sourceId, archivedKey)
            ApplicationManager.getApplication().invokeLater {
                if (content == null) {
                    Messages.showErrorDialog(project, "Could not read reference from storage.", "Load Reference Failed")
                } else {
                    postToWebview("referenceContentLoaded", mapOf("archivedKey" to archivedKey, "source" to source, "content" to content))
                }
            }
        }
    }

    private fun handleSaveReferenceEdit(archivedKey: String, source: String, content: String) {
        val sourceId = parseSourceId(source) ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            store.writeReferenceFromBranch(sourceId, archivedKey, content, "Edit reference $archivedKey")
            ApplicationManager.getApplication().invokeLater {
                postToWebview("referenceSaved", mapOf("archivedKey" to archivedKey, "source" to source))
            }
        }
    }

    private fun handleRemoveReference(archivedKey: String, source: String, nativeId: String, title: String) {
        ApplicationManager.getApplication().invokeLater {
            val displayName = if (nativeId.isNotBlank()) "$nativeId — $title" else title
            val choice = Messages.showYesNoDialog(project, "The reference will no longer be associated with this commit.", "Remove reference \"$displayName\"?", "Remove", "Cancel", Messages.getWarningIcon())
            if (choice != Messages.YES) return@invokeLater
            ApplicationManager.getApplication().executeOnPooledThread {
                val updatedRefs = (currentSummary.references ?: emptyList()).filter { it.archivedKey != archivedKey }
                val updatedSummary = currentSummary.copy(references = updatedRefs.takeIf { it.isNotEmpty() })
                store.storeSummary(updatedSummary, force = true)
                currentSummary = updatedSummary
                ApplicationManager.getApplication().invokeLater { refreshHtml() }
            }
        }
    }

    private fun handleTranslatePlan(slug: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val content = store.readPlanFromBranch(slug)
                if (content == null) {
                    ApplicationManager.getApplication().invokeLater {
                        postToWebview("planTranslateError", mapOf("slug" to slug, "message" to "Plan not found"))
                    }
                    return@executeOnPooledThread
                }
                val cjkPattern = Regex("[\\u4E00-\\u9FFF\\u3400-\\u4DBF\\uF900-\\uFAFF]")
                if (!cjkPattern.containsMatchIn(content) && !(currentSummary.plans?.find { it.slug == slug }?.let { cjkPattern.containsMatchIn(it.title) } ?: false)) {
                    ApplicationManager.getApplication().invokeLater { Messages.showInfoMessage(project, "Plan is already in English.", "Translation") }
                    return@executeOnPooledThread
                }
                ApplicationManager.getApplication().invokeLater { postToWebview("planTranslating", mapOf("slug" to slug)) }
                val config = SessionTracker.loadConfig(cwd)
                val translated = Summarizer.translateToEnglish(content, config.apiKey, config.model, config.jolliApiKey, config.aiProvider)
                store.writePlanToBranch(slug, translated, "Translate plan $slug to English")
                syncPlanTitle(slug, translated)
                planTranslateSet.remove(slug)
                ApplicationManager.getApplication().invokeLater {
                    refreshHtml()
                    postToWebview("planTranslated", mapOf("slug" to slug))
                }
            } catch (e: Exception) {
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("planTranslateError", mapOf("slug" to slug, "message" to (e.message ?: "Unknown error")))
                    Messages.showErrorDialog(project, "Translation failed: ${e.message}", "Translation Error")
                }
            }
        }
    }

    private fun handleAssociatePlan() {
        ApplicationManager.getApplication().invokeLater {
            val summary = currentSummary
            val existingSlugs = (summary.plans ?: emptyList()).map { it.slug }.toSet()
            val available = PlanService.listAvailablePlans(existingSlugs)
            if (available.isEmpty()) {
                Messages.showInfoMessage(project, "No plans available to associate.", "Associate Plan")
                return@invokeLater
            }
            val items = available.map { "${it.title} (${it.slug}.md)" }
            JBPopupFactory.getInstance()
                .createPopupChooserBuilder(items)
                .setTitle("Select a plan to associate")
                .setItemChosenCallback { selectedItem ->
                    val index = items.indexOf(selectedItem)
                    if (index < 0) return@setItemChosenCallback
                    val selected = available[index]
                    ApplicationManager.getApplication().executeOnPooledThread {
                        val planRef = PlanService.archivePlanForCommit(selected.slug, summary.commitHash, store, cwd)
                        if (planRef == null) {
                            ApplicationManager.getApplication().invokeLater {
                                Messages.showErrorDialog(project, "Failed to associate plan \"${selected.slug}\".", "Association Failed")
                            }
                            return@executeOnPooledThread
                        }
                        val updatedSummary = summary.copy(plans = (summary.plans ?: emptyList()) + planRef)
                        store.storeSummary(updatedSummary, force = true)
                        currentSummary = updatedSummary
                        ApplicationManager.getApplication().invokeLater { refreshHtml() }
                    }
                }
                .createPopup()
                .showInFocusCenter()
        }
    }

    private fun handleCheckPrStatus() {
        val targetBranch = currentSummary.branch
        jmLog.info("handleCheckPrStatus: start (cwd='%s', branch='%s')", cwd, targetBranch)
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val ghAvailable = PrService.isGhAvailable(cwd)
                jmLog.info("handleCheckPrStatus: isGhAvailable=%s", ghAvailable)
                if (!ghAvailable) {
                    jmLog.warn("handleCheckPrStatus: status=unavailable (gh --version failed — not installed or not on resolved PATH)")
                    ApplicationManager.getApplication().invokeLater {
                        postToWebview("prStatus", mapOf("status" to "unavailable"))
                    }
                    return@executeOnPooledThread
                }
                val ghAuth = PrService.isGhAuthenticated(cwd)
                jmLog.info("handleCheckPrStatus: isGhAuthenticated=%s", ghAuth)
                if (!ghAuth) {
                    jmLog.warn("handleCheckPrStatus: status=unavailable (gh auth status failed — not logged in)")
                    ApplicationManager.getApplication().invokeLater {
                        postToWebview("prStatus", mapOf("status" to "unavailable"))
                    }
                    return@executeOnPooledThread
                }

                val lookup = PrService.findPrForBranch(cwd, targetBranch)
                jmLog.info("handleCheckPrStatus: lookup=%s", lookup::class.simpleName)

                when (lookup) {
                    is PrService.PrLookup.LookupError -> {
                        jmLog.warn("handleCheckPrStatus: status=unavailable (lookupError: %s)", lookup.reason)
                        ApplicationManager.getApplication().invokeLater {
                            postToWebview("prStatus", mapOf("status" to "unavailable", "reason" to lookup.reason))
                        }
                    }
                    is PrService.PrLookup.NoPr -> {
                        jmLog.info("handleCheckPrStatus: status=noPr (branch='%s', history=%d)", targetBranch, lookup.history.size)
                        ApplicationManager.getApplication().invokeLater {
                            postToWebview("prStatus", mapOf(
                                "status" to "noPr",
                                "branch" to targetBranch,
                                "history" to lookup.history.map { mapOf("number" to it.number, "url" to it.url, "state" to it.state) },
                            ))
                        }
                    }
                    is PrService.PrLookup.Found -> {
                        jmLog.info("handleCheckPrStatus: status=ready (pr #%d, history=%d)", lookup.pr.number, lookup.history.size)
                        ApplicationManager.getApplication().invokeLater {
                            postToWebview("prStatus", mapOf(
                                "status" to "ready",
                                "pr" to mapOf("number" to lookup.pr.number, "url" to lookup.pr.url, "title" to lookup.pr.title),
                                "history" to lookup.history.map { mapOf("number" to it.number, "url" to it.url, "state" to it.state) },
                            ))
                        }
                    }
                }
            } catch (e: Exception) {
                jmLog.error("handleCheckPrStatus: status=unavailable (exception: %s)", e.message ?: e.toString())
                LOG.warn("Check PR status failed: ${e.message}")
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("prStatus", mapOf("status" to "unavailable"))
                }
            }
        }
    }


    /**
     * Generates an E2E test summary first, then reveals the prefilled PR form.
     * Called when the user clicks "Create PR with E2E" in the webview.
     */
    private fun handleCreatePrWithE2e() {
        jmLog.info("handleCreatePrWithE2e: starting E2E generation")
        postToWebview("prGeneratingE2e")
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                jmLog.info("handleCreatePrWithE2e: generateAndStoreE2eTest() start")
                val scenarios = generateAndStoreE2eTest()
                jmLog.info("handleCreatePrWithE2e: generateAndStoreE2eTest() done — %d scenario(s)", scenarios.size)
                val e2eHtml = SummaryHtmlBuilder.buildE2eTestSection(currentSummary)
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("e2eTestUpdated", mapOf("html" to e2eHtml))
                    showCreatePrForm()
                }
            } catch (e: Exception) {
                jmLog.error("handleCreatePrWithE2e: E2E generation failed: %s", e.message ?: e.toString())
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("e2eTestError", mapOf("message" to (e.message ?: "Generation failed")))
                    Messages.showErrorDialog(project, "E2E test generation failed: ${e.message}", "Error")
                    handleCheckPrStatus()
                }
            }
        }
    }

    /** Builds the PR title/body from [currentSummary] and reveals the prefilled create form. */
    private fun showCreatePrForm() {
        val title = currentSummary.commitMessage
        val body = PrService.wrapWithMarkers(SummaryPrMarkdownBuilder.buildPrMarkdown(currentSummary))
        jmLog.info("showCreatePrForm: posting prShowCreateForm (title len=%d, body len=%d)", title.length, body.length)
        postToWebview("prShowCreateForm", mapOf("title" to title, "body" to body))
    }

    private fun handleCreatePr(title: String, body: String) {
        postToWebview("prCreating")
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val git = GitOps(cwd)
                val branch = currentSummary.branch

                // Push — detect NFF and offer force-push retry
                val pushResult = PrService.pushBranch(cwd)
                if (!pushResult.success) {
                    if (ForcePushUtil.isNonFastForwardError(pushResult.stderr)) {
                        // Inspect divergence off the EDT (git fetch), then show the gate dialog on the EDT
                        val safety = ForcePushUtil.inspectForcePushSafety(git, branch)
                        var outcome = ForcePushUtil.ForcePushOutcome.DECLINED
                        ApplicationManager.getApplication().invokeAndWait {
                            outcome = ForcePushUtil.gateForcePush(
                                project, branch, safety,
                                reason = "The remote has changes your branch does not include.",
                            )
                        }
                        when (outcome) {
                            ForcePushUtil.ForcePushOutcome.CONFIRMED -> {
                                val forceResult = ForcePushUtil.forcePushBranch(git, branch)
                                if (forceResult.exitCode != 0) {
                                    ApplicationManager.getApplication().invokeLater {
                                        postToWebview("prCreateError", mapOf("message" to "Force push failed: ${forceResult.stderr}"))
                                    }
                                    return@executeOnPooledThread
                                }
                            }
                            ForcePushUtil.ForcePushOutcome.BLOCKED -> {
                                ApplicationManager.getApplication().invokeLater {
                                    postToWebview("prCreateError", mapOf("message" to "Push blocked — your branch is behind the remote. Pull or rebase, then try again."))
                                }
                                return@executeOnPooledThread
                            }
                            ForcePushUtil.ForcePushOutcome.DECLINED -> {
                                ApplicationManager.getApplication().invokeLater {
                                    postToWebview("prCreateError", mapOf("message" to "Push cancelled."))
                                }
                                return@executeOnPooledThread
                            }
                        }
                    } else {
                        // Non-NFF push error — surface it
                        ApplicationManager.getApplication().invokeLater {
                            postToWebview("prCreateError", mapOf("message" to "Push failed: ${pushResult.stderr}"))
                        }
                        return@executeOnPooledThread
                    }
                }

                // Check if PR already exists for this branch — update instead of create
                val lookup = PrService.findPrForBranch(cwd, branch)
                val prUrl: String
                if (lookup is PrService.PrLookup.Found) {
                    PrService.updatePr(lookup.pr.number, title, body, cwd)
                    prUrl = lookup.pr.url
                } else {
                    prUrl = PrService.createPr(title, body, cwd)
                }
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("prCreated", mapOf("url" to prUrl))
                    handleCheckPrStatus()
                    // A PR now exists for the branch — sync the Create PR view + Commits list.
                    service?.notifyMemoryStateChanged()
                }
            } catch (e: Exception) {
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("prCreateError", mapOf("message" to (e.message ?: "Create failed")))
                    Messages.showErrorDialog(project, "Create PR failed: ${e.message}", "PR Error")
                }
            }
        }
    }

    private fun handlePrepareUpdatePr() {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val lookup = PrService.findPrForBranch(cwd, currentSummary.branch)
                if (lookup !is PrService.PrLookup.Found) {
                    ApplicationManager.getApplication().invokeLater { postToWebview("prUpdateError", mapOf("message" to "No PR found")) }
                    return@executeOnPooledThread
                }
                val pr = lookup.pr
                val newMarkdown = SummaryPrMarkdownBuilder.buildPrMarkdown(currentSummary)
                val newBody = PrService.replaceSummaryInBody(pr.body, newMarkdown)
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("prShowUpdateForm", mapOf("title" to pr.title, "body" to newBody))
                }
            } catch (e: Exception) {
                ApplicationManager.getApplication().invokeLater { postToWebview("prUpdateError", mapOf("message" to (e.message ?: "Load PR data failed"))) }
            }
        }
    }

    private fun handleUpdatePr(title: String, body: String) {
        postToWebview("prUpdating")
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val lookup = PrService.findPrForBranch(cwd, currentSummary.branch)
                if (lookup !is PrService.PrLookup.Found) {
                    ApplicationManager.getApplication().invokeLater { postToWebview("prUpdateError", mapOf("message" to "No PR found")) }
                    return@executeOnPooledThread
                }
                val pr = lookup.pr
                PrService.updatePr(pr.number, title, body, cwd)
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("prUpdated", mapOf("url" to pr.url))
                    handleCheckPrStatus()
                    service?.notifyMemoryStateChanged()
                }
            } catch (e: Exception) {
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("prUpdateError", mapOf("message" to (e.message ?: "Update failed")))
                    Messages.showErrorDialog(project, "Update PR failed: ${e.message}", "PR Error")
                }
            }
        }
    }

    private fun handleLoadTranscriptStats() {
        if (transcriptHashSet.isEmpty()) return
        val hashSnapshot = transcriptHashSet.toSet()
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val seen = mutableSetOf<String>()
                var totalEntries = 0
                val sessionsBySource = mutableMapOf<String, Int>()
                for (hash in hashSnapshot) {
                    val transcript = store.readTranscript(hash) ?: continue
                    @Suppress("SENSELESS_COMPARISON")
                    if (transcript.sessions == null) continue
                    for (session in transcript.sessions) {
                        val source = session.source?.name ?: "claude"
                        val key = "$source:${session.sessionId ?: ""}"
                        @Suppress("SENSELESS_COMPARISON")
                        val entries = if (session.entries == null) emptyList() else session.entries
                        totalEntries += entries.size
                        if (seen.contains(key)) continue
                        seen.add(key)
                        sessionsBySource[source] = (sessionsBySource[source] ?: 0) + 1
                    }
                }
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("transcriptStatsLoaded", mapOf("totalEntries" to totalEntries, "sessionsBySource" to sessionsBySource))
                }
            } catch (e: Exception) {
                LOG.warn("Failed to load transcript stats: ${e.message}", e)
            }
        }
    }

    private fun handleLoadAllTranscripts() {
        postToWebview("transcriptsLoading")
        val hashSnapshot = transcriptHashSet.toSet()
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val taggedEntries = mutableListOf<Map<String, Any?>>()
                for (commitHash in hashSnapshot) {
                    val transcript = store.readTranscript(commitHash) ?: continue
                    // Gson can leave Kotlin non-null fields as null at runtime — guard with orEmpty()
                    val sessions = transcript.sessions ?: continue
                    for (session in sessions) {
                        val entries = session.entries ?: continue
                        for (i in entries.indices) {
                            val entry = entries[i]
                            taggedEntries.add(mapOf(
                                "commitHash" to commitHash, "sessionId" to (session.sessionId ?: ""),
                                "source" to (session.source?.name ?: "claude"), "transcriptPath" to (session.transcriptPath ?: ""),
                                "originalIndex" to i, "role" to (entry.role ?: "assistant"), "content" to (entry.content ?: ""), "timestamp" to (entry.timestamp ?: ""),
                            ))
                        }
                    }
                }
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("allTranscriptsLoaded", mapOf("entries" to taggedEntries, "totalCommits" to hashSnapshot.size))
                }
            } catch (e: Exception) {
                LOG.warn("Failed to load transcripts: ${e.message}", e)
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("allTranscriptsLoaded", mapOf("entries" to emptyList<Any>(), "totalCommits" to 0))
                }
            }
        }
    }

    private fun handleSaveAllTranscripts(entriesJson: JsonArray) {
        val hashSnapshot = transcriptHashSet.toSet()
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val byCommit = mutableMapOf<String, MutableList<JsonObject>>()
                for (el in entriesJson) {
                    val obj = el.asJsonObject
                    byCommit.getOrPut(obj.get("commitHash").asString) { mutableListOf() }.add(obj)
                }
                val originalTranscripts = mutableMapOf<String, StoredTranscript>()
                for (hash in hashSnapshot) { store.readTranscript(hash)?.let { originalTranscripts[hash] = it } }
                val writes = mutableMapOf<String, StoredTranscript>()
                val deletes = mutableSetOf<String>()

                for (commitHash in hashSnapshot) {
                    val commitEntries = byCommit[commitHash]
                    if (commitEntries.isNullOrEmpty()) { deletes.add(commitHash); continue }
                    val originalTranscript = originalTranscripts[commitHash]
                    val sessionMap = linkedMapOf<String, RebuildSession>()
                    for (e in commitEntries) {
                        val source = e.get("source")?.asString ?: "claude"
                        val sessionId = e.get("sessionId")?.asString ?: ""
                        val key = "$source:$sessionId"
                        var session = sessionMap[key]
                        if (session == null) {
                            val origSessions = originalTranscript?.sessions ?: emptyList()
                            val origSession = origSessions.find { "${it.source?.name ?: "claude"}:${it.sessionId ?: ""}" == key }
                            session = RebuildSession(sessionId, source, origSession?.transcriptPath)
                            sessionMap[key] = session
                        }
                        session.entries.add(TranscriptEntry(role = e.get("role")?.asString ?: "assistant", content = e.get("content")?.asString ?: "", timestamp = e.get("timestamp")?.asString?.takeIf { it.isNotEmpty() }))
                    }
                    writes[commitHash] = StoredTranscript(sessions = sessionMap.values.map { s ->
                        StoredSession(sessionId = s.sessionId, source = try { ai.jolli.jollimemory.core.TranscriptSource.valueOf(s.source) } catch (_: Exception) { ai.jolli.jollimemory.core.TranscriptSource.claude }, transcriptPath = s.transcriptPath, entries = s.entries)
                    })
                }

                if (writes.isNotEmpty() || deletes.isNotEmpty()) store.writeTranscriptBatch(writes, deletes)
                refreshTranscriptHashes()
                ApplicationManager.getApplication().invokeLater { refreshHtml(); postToWebview("transcriptsSaved") }
            } catch (e: Exception) {
                LOG.warn("Failed to save transcripts: ${e.message}", e)
                ApplicationManager.getApplication().invokeLater { postToWebview("transcriptsSaved") }
            }
        }
    }

    private fun handleDeleteAllTranscripts() {
        val hashes = transcriptHashSet.toSet()
        if (hashes.isEmpty()) return
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                store.writeTranscriptBatch(emptyMap(), hashes)
                refreshTranscriptHashes()
                ApplicationManager.getApplication().invokeLater { refreshHtml(); postToWebview("transcriptsDeleted") }
            } catch (e: Exception) {
                LOG.warn("Failed to delete transcripts: ${e.message}", e)
                ApplicationManager.getApplication().invokeLater { postToWebview("transcriptsDeleted") }
            }
        }
    }

    // ── Internal helpers ────────────────────────────────────────────────────

    private fun syncPlanTitle(slug: String, content: String) {
        val titleMatch = Regex("^#\\s+(.+)", RegexOption.MULTILINE).find(content)
        val newTitle = titleMatch?.groupValues?.get(1)?.trim() ?: return
        val plans = currentSummary.plans ?: return
        val updatedPlans = plans.map { p -> if (p.slug == slug) p.copy(title = newTitle) else p }
        val updatedSummary = currentSummary.copy(plans = updatedPlans)
        store.storeSummary(updatedSummary, force = true)
        currentSummary = updatedSummary
        val registry = SessionTracker.loadPlansRegistry(cwd)
        val entry = registry.plans[slug]
        if (entry != null) {
            SessionTracker.savePlansRegistry(registry.copy(plans = registry.plans + (slug to entry.copy(title = newTitle))), cwd)
        }
    }

    private fun getDiffForCommit(commitHash: String): String {
        return try {
            val process = ProcessBuilder("git", "diff", "$commitHash~1", commitHash, "--", ".", ":(exclude)*.lock")
                .directory(File(cwd)).redirectErrorStream(false).start()
            // Read stdout concurrently to avoid pipe buffer deadlock (same fix as GitOps.exec)
            val stdoutFuture = java.util.concurrent.CompletableFuture.supplyAsync {
                process.inputStream.bufferedReader().use { it.readText() }
            }
            val completed = process.waitFor(30, TimeUnit.SECONDS)
            if (!completed) { process.destroyForcibly(); return "" }
            stdoutFuture.get(5, TimeUnit.SECONDS).take(30000)
        } catch (_: Exception) { "" }
    }

    private data class RebuildSession(val sessionId: String, val source: String, val transcriptPath: String?, val entries: MutableList<TranscriptEntry> = mutableListOf())

    companion object {
        private val LOG = Logger.getInstance(SummaryPanel::class.java)

        /** Writes to <projectDir>/.jolli/jollimemory/debug.log (same sink as PrService). */
        private val jmLog = ai.jolli.jollimemory.core.JmLogger.create("SummaryPanel")
    }
}

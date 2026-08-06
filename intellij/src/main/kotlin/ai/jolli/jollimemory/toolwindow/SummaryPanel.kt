package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.bridge.CliIntegrations
import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.bridge.GitRemoteUtils
import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.E2eTestScenario
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliAuthService
import ai.jolli.jollimemory.core.StorageFactory
import ai.jolli.jollimemory.core.StoredSession
import ai.jolli.jollimemory.core.StoredTranscript
import ai.jolli.jollimemory.core.SummaryStore
import ai.jolli.jollimemory.core.SummaryTree
import ai.jolli.jollimemory.core.TopicUpdates
import ai.jolli.jollimemory.core.TraceContext
import ai.jolli.jollimemory.core.TranscriptEntry
import ai.jolli.jollimemory.core.WorkingContext
import ai.jolli.jollimemory.core.references.SourceId
import ai.jolli.jollimemory.services.JolliApiClient
import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.services.JolliShareService
import ai.jolli.jollimemory.services.PrService
import ai.jolli.jollimemory.toolwindow.views.SummaryHtmlBuilder
import ai.jolli.jollimemory.toolwindow.views.SummaryMarkdownBuilder
import ai.jolli.jollimemory.toolwindow.views.SummaryPrMarkdownBuilder
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils
import ai.jolli.jollimemory.toolwindow.views.ThemeUtils
import ai.jolli.jollimemory.toolwindow.views.ThemeUtils.isDarkByLuma
import ai.jolli.jollimemory.toolwindow.views.ThemeUtils.toCssHex
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
    initialReadOnly: Boolean = false,
) : JPanel(BorderLayout()) {

    // readOnly used to be a val — now a var so [setSummary] can flip it when the
    // same tab is reused to view a different commit (e.g. own → foreign). Writes
    // and reads both happen on the EDT (setSummary is EDT-only; doRefreshNow
    // snapshots the field on the EDT before handing it to a pool thread), so
    // @Volatile is defensive only — it costs nothing and documents that the
    // field mutates after construction.
    @Volatile
    private var readOnly: Boolean = initialReadOnly

    @Volatile
    var currentSummary: CommitSummary = summary
        private set

    // Fires after Chromium's compositor produces its first frame (double rAF).
    // The message is picked up in dispatchWebviewMessage → scheduleSwingSizeShake,
    // which forces AppKit to reconcile the child NSView's frame — without this,
    // the tab's top can stay blank until an external resize/drag wakes AppKit.
    private val firstFrameTriggerJs = """
        (function(){
          if (!window.jmSend) return;
          requestAnimationFrame(function(){
            requestAnimationFrame(function(){ window.jmSend({command: 'firstFramePainted'}); });
          });
        })();
    """.trimIndent()

    // Every field cleared in dispose() is @Volatile so an EDT reader (refreshHtml,
    // triggerNativeRepaint, postToWebview) sees the cleared value promptly when
    // dispose was raced onto a non-EDT thread by Disposer during project close —
    // the disposeLock guards the write-side ordering, but the read side is
    // lock-free (hot path) and needs the volatile happens-before edge.
    @Volatile
    private var browser: JBCefBrowser? = null
    @Volatile
    private var jsQuery: JBCefJSQuery? = null
    private var bridgeScript: String = ""

    // Lease from JcefBrowserPool. Non-null once createContent() succeeds; released
    // (not disposed) on dispose() so the browser goes back to the pool for the next
    // memory tab to reuse — keeping V8's bytecode cache alive across tabs.
    @Volatile
    private var lease: PooledBrowserLease? = null

    // Session-wide sequence number of this panel's browser (from JcefSessionProbe) —
    // stamped on the render-complete log so the first real tab after the warm-up
    // browser (#1) is identifiable in debug.log.
    private var browserNumber = 0

    // Set on dispose() so loadDeferredSets()'s async continuation never re-renders a
    // torn-down webview (its pooled task can outlive a quick open-then-close).
    @Volatile
    private var disposed = false

    // 1500ms fallback Timer scheduled from createContent (see the comment there).
    // Held so dispose() can explicitly stop it — otherwise the Timer keeps a strong
    // reference to this panel via its closure and delays GC.
    @Volatile
    private var loadFallbackTimer: javax.swing.Timer? = null

    // Swing/AWT listeners registered on the pooled browser's UI component during
    // createContent(). They are attached to `b.component`, which comes from the
    // shared JcefBrowserPool and OUTLIVES this panel — the pool returns the same
    // JBCefBrowser to the next tab. If dispose() didn't remove them, every
    // open/close cycle would leave up to three stale listeners on that shared
    // component (their disposed-check self-clean only fires on the next resize
    // event, and componentListener / hierarchyListener don't check `disposed` at
    // all), keeping the old panel and its HTML string strongly reachable until a
    // later resize happens to sweep them.
    @Volatile
    private var postFireResizeListenerRef: java.awt.event.ComponentAdapter? = null
    // Companion to postFireResizeListener that handles SHOWING_CHANGED events —
    // installed by the 0×0-timeout branch of loadFallbackTimer so a tab that first
    // becomes visible without changing size (background tab already had bounds set)
    // still gets a wasResized() nudge to Chromium. Detached in dispose alongside
    // the resize listener.
    @Volatile
    private var postFireHierarchyListenerRef: java.awt.event.HierarchyListener? = null
    @Volatile
    private var preFireComponentListenerRef: java.awt.event.ComponentAdapter? = null
    @Volatile
    private var preFireHierarchyListenerRef: java.awt.event.HierarchyListener? = null

    // One-shot latch guarding the post-fire paint-recovery path (see the
    // postFireResizeListener comment). When the initial loadHTML was forced at
    // 0×0/hidden, Chromium's onLoadEnd sometimes never fires — pageLoaded
    // stays false, refreshPending piled up by every setSummary since is never
    // drained, and the tab ends up permanently blank. The first post-fire
    // event that observes a valid surface flips this latch and calls
    // doRefreshNow() directly, rebuilding html from currentSummary and
    // loading it onto the now-real surface. AtomicBoolean so a burst of
    // resize/hierarchy events fires the recovery exactly once.
    private val postFirePaintRecovery = java.util.concurrent.atomic.AtomicBoolean(false)

    // Set to true right after the 1500ms fallback Timer fires the initial
    // loadHTML. Distinguishes "we haven't tried yet" (fast path pending) from
    // "we've tried but Chromium hasn't reported success" (pageLoaded still
    // false after fire). Read by setSummary's fast path so a re-click of the
    // SAME memory forces a re-render when the initial render never landed.
    @Volatile
    private var initialLoadFired = false

    // Visibility poll started by the 1500ms Timer when it fires with
    // isShowing=false. SHOWING_CHANGED is not reliable in every IntelliJ
    // editor-group state (an editor group that just lost its last tab, or a
    // background split, can leave the newly-added tab with isShowing=false
    // and never emit the transition-to-true event when the user brings it
    // into view). The poll checks component.isShowing every 500ms and, once
    // it sees the tab actually mounted-and-visible with a real size, drives
    // wasResized + doRefreshNow — the same paint-recovery path the SHOWING_
    // CHANGED listener would have taken.
    @Volatile
    private var visibilityPollTimer: javax.swing.Timer? = null

    // Snapshot of the pooled browser component the listeners above were attached
    // to. Held separately from `browser` because we still need it AFTER the
    // synchronized dispose block has cleared `browser` — that's the point in
    // dispose() where we detach the listeners, and we must not read `b.component`
    // through the JBCefBrowser after the lease was handed back to the pool.
    @Volatile
    private var browserComponentRef: java.awt.Component? = null

    // Guards the dispose transition. dispose() may run on either the EDT (normal tab
    // close) or a pooled thread (Disposer during project close); concurrent EDT calls
    // like refreshHtml would otherwise observe a half-null state (browser cleared but
    // lease still pending). One lock over the whole snapshot-and-null sequence keeps
    // observers seeing the panel either fully alive or fully disposed.
    private val disposeLock = Any()

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

    private val gson = Gson()
    private val store: SummaryStore
    // Concurrent-safe: mutated from multiple pool threads (loadDeferredSets scan,
    // handleSaveAllTranscripts, handleDeleteAllTranscripts, handleTranslatePlan)
    // as well as the EDT clear() in setSummary. A plain LinkedHashSet would
    // ConcurrentModificationException under rapid memory-tab switches.
    private val transcriptHashSet = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val planTranslateSet = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
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
        cwd = service?.mainRepoRoot ?: project.basePath ?: ""
        val gitOps = service?.getGitOps()
        val git = gitOps ?: GitOps(cwd)
        store = SummaryStore(cwd, git, StorageFactory.create(git, cwd))
        add(createContent(), BorderLayout.CENTER)
        // Only editable panels care about memory-state events; read-only /
        // foreign-mode tabs would waste a pooled `getSummary` + full HTML
        // refresh on every event. [setSummary] re-runs this decision when it
        // flips [readOnly] on the fly (Flavor A tab reuse own → foreign or
        // foreign → own).
        if (!readOnly) service?.addMemoryStateListener(memoryStateListener)
        loadDeferredSets()
    }

    /**
     * Loads the transcript-hash and plan-translate sets OFF the EDT, then HYDRATES the
     * existing webview in place instead of doing a second `loadHTML`.
     *
     * Why: on macOS a fresh JCEF (JBCefBrowser) does not always fill the whole component
     * area on its first paint — the underlying NSView's visible rect can lag the Swing
     * component's real size, so the top of the tab shows the wrapper's fallback background
     * until some later resize/layout event forces the native surface to repaint. The
     * previous "second loadHTML on deferred data" implicitly served as that repaint
     * trigger, at the cost of a 300–400 ms visible flash. Since the HTML builder now
     * ships both the empty and populated branches at once (with `hidden` toggling), the
     * deferred data can be applied via a message — no second navigation, no flash.
     *
     * A separate one-shot call in [triggerNativeRepaint] (invoked after onLoadEnd) covers
     * the "first-paint doesn't fill NSView" problem the old second-loadHTML used to mask.
     *
     * If [pageLoaded] hasn't flipped yet when we arrive here, the hydrate is parked in
     * [deferredHydratePending] and drained from the onLoadEnd handler on the same tick
     * as [refreshPending].
     */
    private fun loadDeferredSets() {
        // Snapshot the current identity so a rapid setSummary→setSummary sequence
        // doesn't let this scan's transcript / plan-translate results land on
        // the newer memory's DOM. Refresh helpers below also honour the gen so
        // stale mutations don't overwrite the incoming memory's fresh clear().
        val myGen = summaryGeneration
        ApplicationManager.getApplication().executeOnPooledThread {
            if (myGen != summaryGeneration) return@executeOnPooledThread
            refreshTranscriptHashes(myGen)
            if (myGen != summaryGeneration) return@executeOnPooledThread
            refreshPlanTranslateSet(myGen)
            ApplicationManager.getApplication().invokeLater {
                if (disposed) return@invokeLater
                if (myGen != summaryGeneration) return@invokeLater
                if (transcriptHashSet.isEmpty() && planTranslateSet.isEmpty()) return@invokeLater
                // Arm the pending flag even when the webview is currently dirty.
                // [maybeSendDeferredHydrate] holds it back while dirty and
                // [postToWebview] re-fires it once a persisted-save ack clears the
                // dirty flag, so a user who starts editing before the background
                // scan returns still gets transcript/plan-translate controls
                // revealed as soon as their next save lands.
                deferredHydratePending = true
                maybeSendDeferredHydrate()
            }
        }
    }

    // Armed by [loadDeferredSets] when new data is ready but the init page load may not
    // have finished yet. Drained by [maybeSendDeferredHydrate] either immediately (if the
    // page is already loaded) or from the false→true transition in onLoadEnd.
    @Volatile
    private var deferredHydratePending = false

    /**
     * Flush the deferred hydration if the page is loaded and the webview is
     * clean. Idempotent — a call with nothing pending is a no-op. When the
     * webview is dirty the pending flag is deliberately kept alive so a later
     * save (which clears dirty and re-fires this from [postToWebview]) can still
     * reveal the transcript / plan-translate controls that the initial HTML
     * ships hidden.
     */
    private fun maybeSendDeferredHydrate() {
        if (!deferredHydratePending) return
        if (!pageLoaded) return
        if (disposed) { deferredHydratePending = false; return }
        // Dirty webview: keep the pending flag so the next dirty→clean transition
        // (a persisted-save ack in postToWebview) can drain it.
        if (webviewDirty) return
        deferredHydratePending = false
        if (transcriptHashSet.isNotEmpty()) {
            postToWebview("transcriptsAvailable", mapOf("count" to transcriptHashSet.size))
        }
        if (planTranslateSet.isNotEmpty()) {
            postToWebview("planTranslateAvailable", mapOf("slugs" to planTranslateSet.toList()))
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

    // Monotonic counter that lets a pool-thread `buildHtml` cheaply detect it
    // was superseded by a newer refresh before its result reaches the EDT.
    // Written on the EDT (in `doRefreshNow` entry), snapshotted on the pool
    // thread, read on the EDT again after loadHTML. All accesses are EDT-only
    // today, so the ++ is trivially atomic; @Volatile is defensive against a
    // future off-EDT reader (mirrors CreatePrPanel.renderGeneration's shape
    // and documents that this field is designed for cross-thread visibility).
    @Volatile
    private var renderGeneration: Long = 0

    // Bumps every time [setSummary] installs a different memory into this reused
    // tab. Async callbacks launched from that setSummary — handleCheckPrStatus,
    // loadDeferredSets, refreshTranscript/PlanTranslate helpers — snapshot the
    // value at dispatch and short-circuit on invokeLater if the user has since
    // switched to another memory. Without this, memory A's cold gh lookup or
    // transcript scan can land on memory B's DOM (postToWebview "prStatus"
    // payload for A's branch → wrong PR badge on B; A's transcript chips mis-
    // attributed to B). The prStatus:"ready" payload doesn't carry a branch
    // field, so the JS side can't filter after the fact.
    @Volatile
    private var summaryGeneration: Long = 0

    private fun onMemoryStateChanged() {
        // Never clobber unsaved edits — the PR/share badges will re-sync on the next
        // reload (after the user saves). Dropping in-progress edits is the worse failure.
        if (webviewDirty) return
        // The pool fetch below runs ~100-200 ms of git plumbing. If the user
        // switches this reused tab to a different memory in that window (setSummary
        // bumps summaryGeneration), the invokeLater write `currentSummary = fresh`
        // would overwrite the incoming memory's identity with the outgoing memory's
        // fetched summary. Guard the whole chain on the snapshotted gen.
        val myGen = summaryGeneration
        ApplicationManager.getApplication().executeOnPooledThread {
            if (myGen != summaryGeneration) return@executeOnPooledThread
            val fresh = try {
                service?.getSummary(currentSummary.commitHash)
            } catch (_: Exception) {
                null
            }
            ApplicationManager.getApplication().invokeLater {
                if (webviewDirty) return@invokeLater
                if (myGen != summaryGeneration) return@invokeLater
                if (fresh != null) currentSummary = fresh
                refreshHtml()
                handleCheckPrStatus()
            }
        }
    }

    /** Shorthand for [ThemeUtils.editorBackground] — the read must stay on the EDT. */
    private fun editorBackground(): java.awt.Color = ThemeUtils.editorBackground()

    private fun createContent(): JComponent {
        return try {
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
                    // Pool no longer primes the browser with a blank page, so there is no
                    // sentinel URL to filter out here — the very first onLoadEnd is the
                    // real memory page's.
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
                    // Drain the parked hydrate from loadDeferredSets on the same false→true
                    // transition (same shape as refreshPending, just no loadHTML).
                    if (!wasLoaded && deferredHydratePending) {
                        ApplicationManager.getApplication().invokeLater {
                            if (!disposed) maybeSendDeferredHydrate()
                        }
                    }
                    // macOS JCEF quirk: the first paint of a freshly-primed browser doesn't
                    // reliably fill the whole component area — the NSView's visible rect
                    // lags the Swing component's real size, so the top strip of the tab
                    // shows the wrapper's fallback background until some later resize/
                    // layout event pushes the true bounds down to the native surface.
                    // The old code masked this by doing a second `loadHTML` from
                    // loadDeferredSets, which triggered a full compositor repaint at the
                    // cost of a 300–400 ms visible flash. Now we hand-fire that repaint
                    // via CEF's own `wasResized()` (the same signal a real resize would
                    // send) plus a Swing-side revalidate/repaint as a belt-and-braces
                    // fallback for any layer above CEF. Runs once per init load-end on
                    // the false→true transition so subsequent same-tab reloads don't
                    // pay for it. Never fires for the prime-page load (filtered above).
                    if (!wasLoaded) {
                        ApplicationManager.getApplication().invokeLater {
                            if (!disposed) triggerNativeRepaint()
                        }
                        // Post the firstFramePainted ping after Chromium's compositor
                        // produces its first frame — routed to scheduleSwingSizeShake
                        // to force AppKit to reconcile the child NSView's frame.
                        browser?.executeJavaScript(firstFrameTriggerJs, browser.url ?: "", 0)
                    }
                }
            })

            // Theme background read live from the IDE so the shell + the page --bg equal the
            // current editor colour (not a hard-coded value). The same colour on the component
            // and in the page (--bg) keeps the load seamless — no white flash, no skeleton.
            val pageBg = editorBackground()
            // isDark from the page bg's luma (not JBColor.isBright()) so the text-colour
            // vars always match --bg; the LaF and the editor colour scheme are independent.
            val pageBgHex = pageBg.toCssHex()
            // NOTE: no more synchronous `SummaryHtmlBuilder.buildHtml(...)` here —
            // that call is 100–400 KB of Kotlin string concatenation and freezes the
            // EDT for 100–300 ms on every new memory tab. Both fire paths below
            // now go through `doRefreshNow()`, which snapshots panel state on the
            // EDT and does the actual build off-EDT on a pool thread, then hops
            // back to loadHTML. `renderGeneration` inside `doRefreshNow` supersedes
            // any concurrent refreshes so we never load a stale intermediate.
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
            //
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
                initialLoadFired = true
                // buildHtml runs on a pool thread inside doRefreshNow. The
                // sync b.loadHTML call this used to do (100-300ms EDT freeze
                // for the 100-400KB summary HTML) is gone.
                doRefreshNow()
            }
            // Post-fire size watcher: once the initial loadHTML has gone through,
            // any later size change on the component is pushed down to CEF via
            // wasResized(w, h). This is what rescues a background tab that was
            // fired at 0×0 by the Timer fallback below — as soon as IntelliJ
            // mounts the tab and the layout kicks in, Chromium learns its true
            // viewport and repaints. Without this the tab stays permanently blank.
            //
            // Paint-recovery safety net: when the initial loadHTML was forced
            // onto a 0×0/hidden surface, Chromium sometimes never fires
            // onLoadEnd. pageLoaded stays false, every setSummary since has
            // piled `refreshPending = true` (which the missing onLoadEnd would
            // have drained), and the tab is stuck with no rendered DOM. The
            // first post-fire event that observes a valid surface fires
            // doRefreshNow() through the postFirePaintRecovery latch, which
            // rebuilds html from currentSummary (so we render the *latest*
            // summary the user clicked, not the stale one captured at
            // createContent) and loadHTMLs onto the now-real surface. The
            // eventual onLoadEnd from this second load flips pageLoaded=true
            // and puts the panel back on the happy path.
            val postFireResizeListener = object : java.awt.event.ComponentAdapter() {
                override fun componentResized(e: java.awt.event.ComponentEvent) {
                    if (disposed) { b.component.removeComponentListener(this); return }
                    if (!firedInit.get()) return
                    val w = b.component.width
                    val h = b.component.height
                    if (w <= 0 || h <= 0) return
                    try {
                        b.cefBrowser?.wasResized(w, h)
                    } catch (_: Throwable) { /* best-effort */ }
                    if (!pageLoaded && postFirePaintRecovery.compareAndSet(false, true)) {
                        jmLog.warn("post-fire paint recovery: pageLoaded=false at first valid resize, forcing doRefreshNow for hash=%s", currentSummary.commitHash.take(8))
                        doRefreshNow()
                    }
                }
            }
            postFireResizeListenerRef = postFireResizeListener
            // Sibling listener for the "SHOWING_CHANGED without a matching resize"
            // case: an IntelliJ tab that had bounds set while hidden can flip to
            // visible without firing componentResized, so postFireResizeListener
            // above wouldn't catch it. Same wasResized(w,h) push, keyed on the
            // SHOWING event. Chromium ignores a wasResized to the current size,
            // so this is safe to fire even when postFireResizeListener also fires.
            val postFireHierarchyListener = java.awt.event.HierarchyListener { e ->
                if ((e.changeFlags and java.awt.event.HierarchyEvent.SHOWING_CHANGED.toLong()) == 0L) return@HierarchyListener
                if (disposed) { b.component.removeHierarchyListener(postFireHierarchyListenerRef ?: return@HierarchyListener); return@HierarchyListener }
                if (!firedInit.get()) return@HierarchyListener
                if (!b.component.isShowing) return@HierarchyListener
                val w = b.component.width
                val h = b.component.height
                if (w <= 0 || h <= 0) return@HierarchyListener
                try {
                    b.cefBrowser?.wasResized(w, h)
                } catch (_: Throwable) { /* best-effort */ }
                if (!pageLoaded && postFirePaintRecovery.compareAndSet(false, true)) {
                    jmLog.warn("post-fire paint recovery: pageLoaded=false at first valid SHOWING_CHANGED, forcing doRefreshNow for hash=%s", currentSummary.commitHash.take(8))
                    doRefreshNow()
                }
            }
            postFireHierarchyListenerRef = postFireHierarchyListener
            // Componentlistener: re-check on every resize; keep listening until we actually
            // fire, then hand the seat over to postFireResizeListener.
            val componentListener = object : java.awt.event.ComponentAdapter() {
                override fun componentResized(e: java.awt.event.ComponentEvent) {
                    fireIfReady.run()
                    if (firedInit.get()) {
                        b.component.removeComponentListener(this)
                        b.component.addComponentListener(postFireResizeListener)
                    }
                }
            }
            preFireComponentListenerRef = componentListener
            b.component.addComponentListener(componentListener)
            // HierarchyListener: same policy — try, but stay wired if we can't fire yet.
            // On success hand off to postFireResizeListener so later resizes still notify CEF.
            val hierarchyListener = object : java.awt.event.HierarchyListener {
                override fun hierarchyChanged(e: java.awt.event.HierarchyEvent) {
                    if ((e.changeFlags and java.awt.event.HierarchyEvent.SHOWING_CHANGED.toLong()) != 0L) {
                        fireIfReady.run()
                        if (firedInit.get()) {
                            b.component.removeHierarchyListener(this)
                            // No duplicate add: componentListener's own success branch
                            // already installed postFireResizeListener when the size
                            // arrived. If SHOWING_CHANGED fired first without a matching
                            // componentResized (rare), install it here instead.
                            if (b.component.componentListeners.none { it === postFireResizeListener }) {
                                b.component.addComponentListener(postFireResizeListener)
                            }
                        }
                    }
                }
            }
            preFireHierarchyListenerRef = hierarchyListener
            b.component.addHierarchyListener(hierarchyListener)
            // Snapshot the component reference for dispose(): the listeners above
            // live on this specific pooled component and must be detached from it
            // by name, not via `browser?.component` (browser is cleared in dispose
            // BEFORE the detach step to keep other observers seeing a consistent
            // torn-down state).
            browserComponentRef = b.component
            // Fast path: pool-reused browser that already arrives sized + showing.
            // If this fires, the two listeners above still exist but will short-circuit;
            // they never install postFireResizeListener because their branches run only
            // when the event fires. Attach it here directly so future resizes still
            // notify CEF via wasResized (belt-and-braces for a resized tool window).
            fireIfReady.run()
            if (firedInit.get()) {
                b.component.removeComponentListener(componentListener)
                b.component.removeHierarchyListener(hierarchyListener)
                b.component.addComponentListener(postFireResizeListener)
            }
            // Last-resort timeout: if 1500 ms goes by without either componentResized
            // or SHOWING_CHANGED, IntelliJ hasn't fully mounted the tab yet. Previously
            // we refused to loadHTML while 0×0 and hoped a later mount event would run
            // fireIfReady — but for the FIRST tab of a fresh IDE session on macOS,
            // those events sometimes never arrive (or arrive minutes later when the
            // user finally clicks the tab), leaving the tab permanently blank.
            //
            // We now ALWAYS fire loadHTML at the deadline. Two cases:
            //   • w>0 && h>0: Chromium renders to the real canvas immediately — the
            //     "background tab already sized" path.
            //   • 0×0: Chromium renders to a 0×0 surface (invisibly) → [postFireResizeListener]
            //     catches the eventual componentResized and calls wasResized(w,h), which
            //     tells CEF the surface changed size and triggers a repaint. As a safety
            //     net for the "SHOWING_CHANGED fires without a matching componentResized"
            //     path, [postFireHierarchyListener] does the same on hierarchy events.
            //     Both are installed BEFORE the loadHTML so no resize event can be lost.
            loadFallbackTimer = javax.swing.Timer(1500) {
                if (disposed) {
                    b.component.removeComponentListener(componentListener)
                    b.component.removeHierarchyListener(hierarchyListener)
                    return@Timer
                }
                if (firedInit.get()) return@Timer
                val w = b.component.width
                val h = b.component.height
                val showing = b.component.isShowing
                if (!firedInit.compareAndSet(false, true)) return@Timer
                if (w > 0 && h > 0) {
                    jmLog.warn(
                        "loadHTML forcing fire after 1500ms (component=%dx%d, showing=%s)",
                        w, h, showing,
                    )
                } else {
                    // Fire anyway. The pre-fire listeners get retired because they'd
                    // race with postFireResizeListener now that firedInit is true; the
                    // post-fire ones take over full responsibility for pushing size
                    // changes down to CEF.
                    jmLog.warn(
                        "loadHTML forcing fire at 1500ms deadline despite 0×0 (showing=%s) — postFireResizeListener will drive wasResized on the eventual mount",
                        showing,
                    )
                }
                b.component.removeComponentListener(componentListener)
                b.component.removeHierarchyListener(hierarchyListener)
                b.component.addComponentListener(postFireResizeListener)
                b.component.addHierarchyListener(postFireHierarchyListener)
                initialLoadFired = true
                // doRefreshNow snapshots the CURRENT panel state on the EDT
                // and builds HTML on a pool thread — no more EDT freeze from
                // a sync SummaryHtmlBuilder.buildHtml(...) here, and if
                // setSummary swapped currentSummary between createContent and
                // this Timer tick, doRefreshNow naturally picks up the latest.
                doRefreshNow()
                // If we fired to a surface that isn't showing yet, start a
                // visibility poll — SHOWING_CHANGED events aren't reliable when
                // the editor group was empty (last tab just closed) or the tab
                // opened into a background split, so postFireHierarchyListener
                // may never observe the transition. The poll drives the paint
                // recovery once isShowing actually flips, up to a 30s ceiling
                // after which we give up (nothing more we can do — the tab is
                // probably permanently hidden by user layout choices).
                if (!showing || w <= 0 || h <= 0) {
                    startVisibilityPoll()
                }
            }.apply { isRepeats = false; start() }
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
        // Snapshot every field-to-clear inside a single synchronized section so a
        // concurrent EDT call (refreshHtml / postToWebview) either sees the panel
        // fully alive or fully torn down — never a half-null intermediate state.
        val leaseSnapshot: PooledBrowserLease?
        val timerSnapshot: javax.swing.Timer?
        val visibilityPollSnapshot: javax.swing.Timer?
        val browserComponentSnapshot: java.awt.Component?
        val postFireSnapshot: java.awt.event.ComponentAdapter?
        val postFireHierarchySnapshot: java.awt.event.HierarchyListener?
        val preFireCompSnapshot: java.awt.event.ComponentAdapter?
        val preFireHierarchySnapshot: java.awt.event.HierarchyListener?
        synchronized(disposeLock) {
            if (disposed) return
            disposed = true
            leaseSnapshot = lease
            timerSnapshot = loadFallbackTimer
            visibilityPollSnapshot = visibilityPollTimer
            browserComponentSnapshot = browserComponentRef
            postFireSnapshot = postFireResizeListenerRef
            postFireHierarchySnapshot = postFireHierarchyListenerRef
            preFireCompSnapshot = preFireComponentListenerRef
            preFireHierarchySnapshot = preFireHierarchyListenerRef
            lease = null
            loadFallbackTimer = null
            visibilityPollTimer = null
            jsQuery = null
            browser = null
            browserComponentRef = null
            postFireResizeListenerRef = null
            postFireHierarchyListenerRef = null
            preFireComponentListenerRef = null
            preFireHierarchyListenerRef = null
        }
        service?.removeMemoryStateListener(memoryStateListener)
        // Stop the fallback loadHTML Timer explicitly. isRepeats=false only guarantees
        // it fires at most once — the closure still pins this panel until then.
        timerSnapshot?.stop()
        // Same reason for the visibility poll: it's a repeating Timer, so its
        // closure keeps this panel and the pooled browser reachable until stop().
        visibilityPollSnapshot?.stop()
        // Detach the Swing/AWT listeners we attached to the pooled browser's component.
        // PooledBrowserLease.release() only unhooks JCEF-layer stuff (JS queries, load /
        // request handlers); the ComponentListener / HierarchyListener sit on the shared
        // AWT component and would otherwise stack up across open/close cycles, keeping
        // stale SummaryPanel closures (and the associated HTML string) reachable.
        // Runs BEFORE the lease is returned to the pool so no other tenant can attach
        // to the component in between.
        val comp = browserComponentSnapshot
        if (comp != null) {
            val detach = Runnable {
                try { postFireSnapshot?.let { comp.removeComponentListener(it) } } catch (_: Throwable) { /* best-effort */ }
                try { postFireHierarchySnapshot?.let { comp.removeHierarchyListener(it) } } catch (_: Throwable) { /* best-effort */ }
                try { preFireCompSnapshot?.let { comp.removeComponentListener(it) } } catch (_: Throwable) { /* best-effort */ }
                try { preFireHierarchySnapshot?.let { comp.removeHierarchyListener(it) } } catch (_: Throwable) { /* best-effort */ }
            }
            if (ApplicationManager.getApplication().isDispatchThread) {
                detach.run()
            } else {
                ApplicationManager.getApplication().invokeLater(detach)
            }
        }
        // Release detaches the JS query and CEF handlers we attached, then returns the
        // browser to the pool for reuse instead of disposing it. If the pool is over
        // capacity it will LRU-evict internally — we don't decide that here.
        //
        // JcefBrowserPool.releaseEntry asserts EDT; FileEditor.dispose is normally
        // called on the EDT when a tab is closed, but Disposer can tear editors down
        // from any thread when the project itself is closing. Hop to the EDT so a
        // late shutdown doesn't leak the lease into the leased set and starve the pool.
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
        val clearedDirty = command in savePersistedAcks
        if (clearedDirty) webviewDirty = false
        val payload = gson.toJson(data + ("command" to command))
        val b64 = java.util.Base64.getEncoder().encodeToString(payload.toByteArray(Charsets.UTF_8))
        val currentUrl = browser?.cefBrowser?.url ?: ""
        browser?.cefBrowser?.executeJavaScript(
            "window.dispatchEvent(new CustomEvent('jollimemory', { detail: JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('$b64'), function(c){ return c.charCodeAt(0); }))) }));",
            currentUrl,
            0,
        )
        // If this ack cleared the dirty flag, drain any hydrate the background
        // scan parked while the user was mid-edit. maybeSendDeferredHydrate is a
        // no-op unless deferredHydratePending is set, so the call is cheap.
        if (clearedDirty) maybeSendDeferredHydrate()
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
        // Whatever queued this reload (a direct refreshHtml, an onLoadEnd
        // drain, the visibility-poll rescue) is now being served — clear
        // refreshPending so a later onLoadEnd doesn't fire ANOTHER redundant
        // doRefreshNow on top of the one about to complete.
        refreshPending = false

        // ── Snapshot every input on the EDT ────────────────────────────────
        // buildHtml is pure w.r.t. its arguments, so we can freeze them once
        // and hand them to a pool thread. The two mutable sets get copied
        // (`.toSet()`) since production code can still mutate them on the EDT
        // between here and the pool-side read.
        val summarySnapshot = currentSummary
        val transcriptSnapshot = transcriptHashSet.toSet()
        val planTranslateSnapshot = planTranslateSet.toSet()
        val bridgeScriptSnapshot = bridgeScript
        val readOnlySnapshot = readOnly
        val pageBg = editorBackground()
        val isDark = pageBg.isDarkByLuma()
        val pageBgHex = pageBg.toCssHex()
        val myGen = ++renderGeneration

        // ── Build the HTML off the EDT, only bounce back to load it ────────
        // buildHtml is 100–400 KB of string concatenation (topics, timeline,
        // e2e, attachments, footer …). Doing that on the EDT freezes the
        // whole UI for 100–300 ms. CSS/JS are cached (see SummaryCssBuilder /
        // SummaryScriptBuilder Stage-1.2 changes), so the pool-side work is
        // dominated by summary-specific rendering.
        ApplicationManager.getApplication().executeOnPooledThread {
            val html = try {
                SummaryHtmlBuilder.buildHtml(
                    summarySnapshot,
                    isDark,
                    transcriptSnapshot,
                    planTranslateSnapshot,
                    bridgeScriptSnapshot,
                    readOnlySnapshot,
                    pageBgHex,
                )
            } catch (e: Exception) {
                jmLog.warn("doRefreshNow: buildHtml failed: %s", e.message ?: e.toString())
                return@executeOnPooledThread
            }
            javax.swing.SwingUtilities.invokeLater {
                if (disposed) return@invokeLater
                // A newer refresh was scheduled while we were building. Drop
                // ours — the newer one either already ran or is about to.
                if (myGen != renderGeneration) return@invokeLater
                // Chromium is about to swap the DOM. Any pending post-load hook
                // (openShare, deferred hydrate) must wait for the NEW page's
                // onLoadEnd before firing — otherwise executeJavaScript targets
                // the outgoing DOM. Concretely: setSummary → refreshHtml lands
                // here while pageLoaded is still true from the prior page, and
                // a same-tick openShare would see pageLoaded && fire shareOpen()
                // against a DOM that loadHTML replaces microseconds later.
                // Reset here (not in refreshHtml) so a request queued behind
                // the "not loaded yet" branch of refreshHtml still sees false
                // after we take over the browser.
                pageLoaded = false
                browser?.loadHTML(html)
            }
        }
    }

    /**
     * Swap this panel's summary in place — the tab-reuse path from
     * [MemoryTabOpener]. Preserves the JCEF browser (and its attached native
     * peer), so the macOS "NSView first-attach half-renders" trauma is NOT
     * re-triggered — only Chromium's DOM changes.
     *
     * Must be called on the EDT.
     */
    fun setSummary(newSummary: CommitSummary, newReadOnly: Boolean) {
        if (disposed) return
        // ── FAST PATH ─────────────────────────────────────────────────────
        // Same content → the tab is already showing exactly what the user
        // wants. Rebuilding + reloading the 100–400 KB HTML through JCEF
        // (300–800 ms on macOS) accomplishes nothing here. This is the
        // IntelliJ analogue of VS Code's `existing.panel.reveal()` short-
        // circuit — CommitSummary is a `data class`, so `==` is a structural
        // deep-equals across every field (topics, plans, refs, e2e). Any real
        // change flows through the slow path below.
        //
        // Exception: the initial loadHTML has already fired (initialLoadFired)
        // but Chromium's onLoadEnd never came through (pageLoaded still false).
        // The tab is showing blank and the user is re-clicking the same memory
        // to unstick it — normally that's a no-op, but here we force a fresh
        // doRefreshNow so the user's click actually accomplishes something.
        if (newSummary == currentSummary && newReadOnly == readOnly) {
            if (initialLoadFired && !pageLoaded) {
                jmLog.warn("setSummary same-hash rescue: initialLoadFired=true but pageLoaded=false, forcing doRefreshNow for hash=%s", currentSummary.commitHash.take(8))
                doRefreshNow()
            }
            return
        }
        // Bump identity gen BEFORE we start mutating memory-specific state.
        // Every async task that touches memory-scoped state — loadDeferredSets,
        // handleCheckPrStatus, all the handle* topic/plan/reference/e2e/recap
        // edit paths, onMemoryStateChanged, handlePushToJolli, syncPlanTitle,
        // generateAndStoreE2eTest — snapshots summaryGeneration at dispatch and
        // bails on mismatch. Any outstanding callback from the OUTGOING memory
        // now sees the wrong gen and no-ops rather than overwriting the incoming
        // memory's currentSummary or landing PR / transcript chips on its DOM.
        ++summaryGeneration
        // Sets are memory-specific — clear before re-hydrating so we don't leak
        // the previous memory's transcript / plan-translate UI into the new page.
        transcriptHashSet.clear()
        planTranslateSet.clear()
        currentSummary = newSummary
        // If the read-only mode flipped, re-run the memory-state listener
        // decision (registered only when editable) so a read-only tab reused
        // for an editable memory picks up events, and vice versa.
        if (newReadOnly != readOnly) {
            if (newReadOnly) service?.removeMemoryStateListener(memoryStateListener)
            else service?.addMemoryStateListener(memoryStateListener)
        }
        readOnly = newReadOnly
        // loadHTML replaces the DOM in the SAME browser instance. NSView doesn't
        // detach/re-attach — that's the whole point of Flavor A.
        refreshHtml()
        // Mark the page as no-longer-loaded SYNCHRONOUSLY on the EDT so any code
        // that lands in the same tick (ActionBarPanel's [requestOpenShare] right
        // after [MemoryTabOpener.openOrReuse], or [loadDeferredSets]' invokeLater
        // continuation calling [maybeSendDeferredHydrate]) sees `pageLoaded=false`
        // and parks its intent in [pendingShareOpen] / [deferredHydratePending]
        // instead of executing JS against the OUTGOING DOM (which loadHTML is about
        // to replace microseconds later). The parked intent is drained by the new
        // page's [onLoadEnd]. Without this, the branch-share overlay silently no-
        // ops on tab reuse and the transcript / plan-translate chips fail to
        // hydrate. Must come AFTER refreshHtml() — refreshHtml short-circuits when
        // pageLoaded is already false and would otherwise park the whole render.
        pageLoaded = false
        // Same-reason clear for pending-share intent left over from the OUTGOING
        // memory: e.g. user requested share on A while A was still loading, then
        // switched to B via a non-share entry point (CommitsPanel / MemoriesPanel).
        // Without this, B's onLoadEnd drains the pending flags and fires a share
        // overlay on B the user never asked for. [shareBranchMode] is the same
        // "outgoing memory's modal state" leaking into follow-up copy/access/
        // invite commands on B if the JS bridge sends one before a fresh
        // 'shareBranch' message updates the flag.
        pendingShareOpen = false
        pendingShareBranch = false
        shareBranchMode = false
        // Re-run the deferred-set scan for the new memory (transcripts on branch,
        // plan translate targets). Same code path init uses.
        loadDeferredSets()
        // Refresh the PR badge for the new memory's branch.
        handleCheckPrStatus()
    }

    /**
     * Workaround for the macOS "NSView first-attach half-renders" issue: the
     * JCEF peer sometimes doesn't fill the tab until an external resize hits
     * AppKit. Detaching the JCEF component from the panel and re-adding on the
     * next EDT tick sends `[NSView removeFromSuperview]` + `[NSView addSubview:]`
     * to AppKit, forcing it to reconcile the child view's frame against the
     * parent's coordinate system. Softer signals (CEF-only wasResized,
     * setBounds tweaks) were tried and did not wake AppKit. Cost: one-tick
     * flash as the component briefly detaches (~16 ms).
     */
    private fun scheduleSwingSizeShake() {
        val doShake = Runnable {
            javax.swing.Timer(100) { evt ->
                (evt.source as javax.swing.Timer).stop()
                if (disposed) return@Timer
                val b = browser ?: return@Timer
                val c = b.component
                val panel = this@SummaryPanel
                if (c.parent !== panel) return@Timer
                try {
                    panel.remove(c)
                    panel.revalidate()
                    javax.swing.SwingUtilities.invokeLater {
                        if (disposed) return@invokeLater
                        val b2 = browser ?: return@invokeLater
                        val c2 = b2.component
                        try {
                            panel.add(c2, java.awt.BorderLayout.CENTER)
                            panel.revalidate()
                            panel.repaint()
                            b2.cefBrowser?.wasResized(c2.width, c2.height)
                        } catch (e: Throwable) {
                            jmLog.warn("shakeReAttach re-add failed: %s", e.message ?: "")
                        }
                    }
                } catch (e: Throwable) {
                    jmLog.warn("shakeReAttach detach failed: %s", e.message ?: "")
                }
            }.apply { isRepeats = false; start() }
        }
        if (ApplicationManager.getApplication().isDispatchThread) {
            doShake.run()
        } else {
            ApplicationManager.getApplication().invokeLater(doShake)
        }
    }

    /**
     * Fires CEF's `wasResized` after the first init loadHTML — the same signal
     * a real drag-resize would send. Chromium then reconciles its rendered
     * bitmap with the NSView's visible rect on macOS. `revalidate`/`repaint`
     * follow as a belt-and-braces Swing-side kick.
     */
    private fun triggerNativeRepaint() {
        val b = browser ?: return
        val c = b.component
        val w = c.width
        val h = c.height
        if (w <= 0 || h <= 0) return
        try {
            b.cefBrowser?.wasResized(w, h)
        } catch (e: Throwable) {
            jmLog.warn("triggerNativeRepaint: wasResized failed: %s", e.message ?: "")
        }
        try {
            c.revalidate()
            c.repaint()
        } catch (e: Throwable) {
            jmLog.warn("triggerNativeRepaint: swing revalidate/repaint failed: %s", e.message ?: "")
        }
    }

    /**
     * Started by the 1500ms fallback Timer when it fires while the component is
     * not showing (or is 0×0). Polls `isShowing` + component bounds every 500ms
     * for up to 30s. As soon as both are valid, it drives the same paint-
     * recovery path the SHOWING_CHANGED listener would have — `wasResized(w,h)`
     * to inform CEF of the surface size, plus a forced `doRefreshNow()` to
     * re-fire loadHTML on the now-real surface (Chromium's initial fire to a
     * hidden/0×0 surface can silently drop onLoadEnd, leaving `pageLoaded=false`
     * and every subsequent `setSummary` piling up into a permanent
     * `refreshPending` latch that nothing drains).
     *
     * Guarded by [postFirePaintRecovery] so it can't double-fire alongside the
     * SHOWING_CHANGED listener; the 30s ceiling stops the timer even if the tab
     * is permanently hidden by user layout choices.
     */
    private fun startVisibilityPoll() {
        if (visibilityPollTimer != null) return
        val started = System.currentTimeMillis()
        val timer = javax.swing.Timer(500) { evt ->
            val self = evt.source as javax.swing.Timer
            if (disposed) { self.stop(); visibilityPollTimer = null; return@Timer }
            // If SHOWING_CHANGED / componentResized already drove the recovery,
            // stop polling — the paint has been kicked, there's nothing left to do.
            if (postFirePaintRecovery.get()) { self.stop(); visibilityPollTimer = null; return@Timer }
            if (System.currentTimeMillis() - started > 30_000) {
                jmLog.warn("visibilityPoll: giving up after 30s (isShowing=%s, w=%d, h=%d, pageLoaded=%s)",
                    browser?.component?.isShowing ?: false,
                    browser?.component?.width ?: 0,
                    browser?.component?.height ?: 0,
                    pageLoaded)
                self.stop(); visibilityPollTimer = null
                return@Timer
            }
            val b = browser ?: run { self.stop(); visibilityPollTimer = null; return@Timer }
            val c = b.component
            if (!c.isShowing) return@Timer
            val w = c.width
            val h = c.height
            if (w <= 0 || h <= 0) return@Timer
            // Fire once: same-shape recovery as postFireHierarchyListener.
            if (!postFirePaintRecovery.compareAndSet(false, true)) {
                self.stop(); visibilityPollTimer = null; return@Timer
            }
            self.stop()
            visibilityPollTimer = null
            try { b.cefBrowser?.wasResized(w, h) } catch (_: Throwable) { /* best-effort */ }
            jmLog.warn(
                "visibilityPoll paint recovery: isShowing=true at %dms after Timer fire, forcing doRefreshNow for hash=%s",
                System.currentTimeMillis() - started,
                currentSummary.commitHash.take(8),
            )
            doRefreshNow()
        }
        timer.isRepeats = true
        visibilityPollTimer = timer
        timer.start()
    }

    /**
     * Refreshes [transcriptHashSet] from the orphan branch. When called from
     * [loadDeferredSets] the caller passes its snapshotted [guardedGen]; every
     * mutation checks against the current [summaryGeneration] and bails when a
     * newer [setSummary] has fired, so the outgoing memory's transcripts can't
     * overwrite the incoming memory's freshly-cleared set. Save/delete callers
     * pass null (no guard) — they operate on the same memory the user is
     * actively editing, so there is no identity race.
     */
    private fun refreshTranscriptHashes(guardedGen: Long? = null) {
        if (guardedGen != null && guardedGen != summaryGeneration) return
        transcriptHashSet.clear()
        try {
            // CLI-owned getTranscriptIds: v5 `summary.transcripts` UUIDs (with a
            // v3/v4 commit-hash fallback) intersected with the transcript files
            // actually on the orphan branch — mirroring the VS Code panel.
            val allIds = SummaryTree.getTranscriptIds(currentSummary)
            val onBranch = store.getTranscriptHashes()
            if (guardedGen != null && guardedGen != summaryGeneration) return
            transcriptHashSet.addAll(allIds.toSet().intersect(onBranch))
            LOG.info("refreshTranscriptHashes: tree=${allIds.size}, onBranch=${onBranch.size}, matched=${transcriptHashSet.size}")
        } catch (e: Exception) {
            LOG.warn("refreshTranscriptHashes failed: ${e.message}", e)
        }
    }

    /**
     * Refreshes [planTranslateSet] via a bounded fan-out of ide-bridge plan-body
     * reads. [guardedGen] mirrors [refreshTranscriptHashes] — when non-null, every
     * mutation checks the current [summaryGeneration] so a stale scan can't leak
     * the outgoing memory's plans onto the incoming memory's set.
     */
    private fun refreshPlanTranslateSet(guardedGen: Long? = null) {
        if (guardedGen != null && guardedGen != summaryGeneration) return
        planTranslateSet.clear()
        // Each readPlanFromBranch is one ide-bridge call (5-20 ms hot, 500+ ms
        // cold). Fanning out the body reads across a bounded pool turns the
        // wall-clock from O(plans × RTT) into O(RTT × ceil(plans/8)) — a plan-
        // heavy memory used to spend most of its "opening…" time here.
        val cjkPattern = Regex("[\\u4E00-\\u9FFF\\u3400-\\u4DBF\\uF900-\\uFAFF]")
        val plans = SummaryUtils.collectAllPlans(currentSummary)
        if (plans.isEmpty()) return

        // Fast pre-filter: any plan whose title already contains CJK never
        // needs a body read to be added to the translate set.
        val quickHits = mutableListOf<String>()
        val bodyLookups = mutableListOf<ai.jolli.jollimemory.core.PlanReference>()
        for (plan in plans) {
            if (cjkPattern.containsMatchIn(plan.title)) quickHits.add(plan.slug)
            else bodyLookups.add(plan)
        }
        if (guardedGen != null && guardedGen != summaryGeneration) return
        planTranslateSet.addAll(quickHits)

        if (bodyLookups.isEmpty()) return

        // Fan out each ide-bridge readPlanFromBranch onto IntelliJ's shared
        // pooled-thread executor. Previously this method built a throwaway
        // `Executors.newFixedThreadPool(8)` per invocation — 1 thread-pool
        // create + shutdown per panel init AND per setSummary, which the
        // reuse path can hit several times per second when the user clicks
        // through the memory list. Application's pooled thread reuses long-
        // lived workers and is the same executor CLI-integration helpers
        // already use, so we're not competing for a distinct resource here.
        //
        // Concurrency bound: the IDE pool is shared with unrelated background
        // work (git status ticks, VFS refreshes, other tool windows). A memory
        // that references 50+ plans would submit 50 blocking ide-bridge calls
        // at once and starve those consumers.
        //
        // The gate is acquired on the CALLER thread (already a pool worker
        // — [loadDeferredSets] submitted us) before we submit each sub-task.
        // Only PLAN_READ_CONCURRENCY sub-tasks ever occupy pool threads at
        // once. Doing gate.acquire() inside the sub-task instead — the shape
        // this code used to have — parked the other N-8 tasks ON pool threads
        // waiting for permits, which is the pool-starvation regression the
        // comment above warns against. Individual futures still carry a 30 s
        // ceiling so a stuck ide-bridge request can't wedge this method.
        // tryAcquire (not acquire) so a stuck ide-bridge call holding a permit
        // for the full 30 s future-timeout can't block THIS caller thread for
        // 30 s × ⌈N/8⌉ — on timeout we skip the remaining plans rather than
        // queueing up behind a wedged permit.
        val gate = java.util.concurrent.Semaphore(PLAN_READ_CONCURRENCY)
        val futures = mutableListOf<java.util.concurrent.Future<String?>>()
        for (plan in bodyLookups) {
            if (!gate.tryAcquire(30, java.util.concurrent.TimeUnit.SECONDS)) break
            futures.add(ApplicationManager.getApplication().executeOnPooledThread<String?> {
                try {
                    val content = store.readPlanFromBranch(plan.slug) ?: return@executeOnPooledThread null
                    if (cjkPattern.containsMatchIn(content)) plan.slug else null
                } catch (_: Exception) {
                    null
                } finally {
                    gate.release()
                }
            })
        }
        for (f in futures) {
            try {
                val slug = f.get(30, java.util.concurrent.TimeUnit.SECONDS)
                if (guardedGen != null && guardedGen != summaryGeneration) return
                if (slug != null) planTranslateSet.add(slug)
            } catch (_: Exception) { /* individual read failure — skip */ }
        }
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
                "editState" -> webviewDirty = json.get("editing")?.asBoolean == true
                // Telemetry only — the webview already wrote the id to the clipboard
                // itself and showed its own toast; there is nothing else to do here.
                "trackMemoryRefIdCopied" ->
                    ai.jolli.jollimemory.core.telemetry.Telemetry.track(
                        "memory_ref_id_copied",
                        mapOf("surface_area" to "detail"),
                    )
                // Chromium's compositor produced its first frame — trigger the
                // AWT-level NSView shake so AppKit reconciles the visible rect.
                "firstFramePainted" -> scheduleSwingSizeShake()
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
        // Push is a multi-second network chain; capture the identity so a mid-push
        // memory switch can't overwrite the incoming memory's currentSummary with
        // the outgoing one's updatedSummary.
        val myGen = summaryGeneration
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
            if (myGen != summaryGeneration) return@executeOnPooledThread
            // One trace per push operation (on this pooled thread) so the push
            // logs, the binding-required retry, and every pushToJolli/listSpaces
            // call share one id; ThreadLocal must be set on the worker thread.
            TraceContext.withTrace {
                try {
                    // The push core lives in JolliShareService so the Create-PR view can
                    // reuse the exact same logic; the binding/re-auth/UI handling below
                    // stays panel-side.
                    val res = JolliShareService.shareSummary(store, summary, cwd, config.jolliApiKey!!, resolvedBaseUrl)
                    if (myGen != summaryGeneration) return@withTrace
                    currentSummary = res.updatedSummary

                    ApplicationManager.getApplication().invokeLater {
                        if (myGen != summaryGeneration) return@invokeLater
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
                } catch (e: JolliApiClient.PermissionDeniedError) {
                    // Credential is fine but the server refused the push (e.g. the
                    // repo isn't allowlisted for the Space). Show the server's
                    // actionable sentence — do NOT offer re-auth (that would send the
                    // user to re-login instead of to an admin) and do NOT open the
                    // binding chooser (that path is only for BindingRequiredError).
                    ApplicationManager.getApplication().invokeLater {
                        postToWebview("pushFailed")
                        Messages.showErrorDialog(project, "Push failed: ${e.message}", "Push Not Allowed")
                    }
                } catch (e: JolliShareService.PushDisabledError) {
                    // The user opted this repo out of outbound push (spec 306). Not a
                    // failure — memory is still recorded locally; tell them how to re-enable.
                    ApplicationManager.getApplication().invokeLater {
                        postToWebview("pushFailed")
                        Messages.showInfoMessage(project, e.message, "Outbound Push Disabled")
                    }
                } catch (e: JolliShareService.PushGateUnavailableError) {
                    // The gate could not be EVALUATED, so nothing was sent (fail-closed).
                    // Kept out of the generic arm on purpose: that arm reports
                    // `trackError("push", "push_failed")`, and a gate we couldn't read is
                    // not a push failure — counting it would pollute the error metric with
                    // a condition the user can simply retry. Mirrors CreatePrPanel.
                    ApplicationManager.getApplication().invokeLater {
                        postToWebview("pushFailed")
                        Messages.showWarningDialog(project, e.message, "Couldn't Verify Push Setting")
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

        val myGen = summaryGeneration
        val result = SummaryTree.updateTopicInTree(currentSummary, topicIndex, updates)
        if (result == null) {
            postToWebview("topicUpdateError", mapOf("message" to "Memory index $topicIndex is out of range"))
            return
        }

        ApplicationManager.getApplication().executeOnPooledThread {
            if (myGen != summaryGeneration) return@executeOnPooledThread
            store.storeSummary(result.result, force = true)
            // Drop the service-wide summary LRU so a subsequent cross-surface
            // reopen (CommitsPanel/MemoriesPanel/PinnedPanel/ActionBarPanel/
            // ViewSummaryAction/CreatePrData.build) reads the fresh topic
            // list instead of the pre-edit snapshot. Local panel state stays
            // via the patch ack below — this only unpoisons the service cache.
            service?.invalidateSummaryCache()
            if (myGen != summaryGeneration) return@executeOnPooledThread
            currentSummary = result.result

            val (allTopics) = SummaryUtils.collectSortedTopics(result.result)
            val displayIndex = allTopics.indexOfFirst { it.topic.treeIndex == topicIndex }
            val topic = if (displayIndex >= 0) allTopics[displayIndex] else null
            val html = if (topic != null) SummaryHtmlBuilder.renderTopic(topic, displayIndex) else ""

            ApplicationManager.getApplication().invokeLater {
                if (myGen != summaryGeneration) return@invokeLater
                postToWebview("topicUpdated", mapOf("topicIndex" to topicIndex, "html" to html))
            }
        }
    }

    private fun handleDeleteTopic(topicIndex: Int, topicTitle: String?) {
        ApplicationManager.getApplication().invokeLater {
            val detail = if (topicTitle != null) "\"$topicTitle\"\n\nThis cannot be undone." else "This cannot be undone."
            val choice = Messages.showYesNoDialog(project, detail, "Delete Memory?", "Delete", "Cancel", Messages.getWarningIcon())
            if (choice != Messages.YES) return@invokeLater

            // Snapshot gen inside the confirm-continuation so a memory switch that
            // happens BEFORE the user hits Delete bumps the gen appropriately.
            val myGen = summaryGeneration
            ApplicationManager.getApplication().executeOnPooledThread {
                if (myGen != summaryGeneration) return@executeOnPooledThread
                val result = SummaryTree.deleteTopicInTree(currentSummary, topicIndex)
                if (result == null) {
                    ApplicationManager.getApplication().invokeLater {
                        if (myGen != summaryGeneration) return@invokeLater
                        postToWebview("topicDeleteError", mapOf("message" to "Memory index $topicIndex is out of range"))
                    }
                    return@executeOnPooledThread
                }
                store.storeSummary(result.result, force = true)
                // See handleUpdateTopic: unpoison the service LRU so
                // reopens elsewhere reflect the deletion.
                service?.invalidateSummaryCache()
                if (myGen != summaryGeneration) return@executeOnPooledThread
                currentSummary = result.result
                ApplicationManager.getApplication().invokeLater {
                    if (myGen != summaryGeneration) return@invokeLater
                    refreshHtml()
                    postToWebview("topicDeleted", mapOf("topicIndex" to topicIndex))
                }
            }
        }
    }

    private fun handleGenerateE2eTest() {
        postToWebview("e2eTestGenerating")
        val myGen = summaryGeneration
        ApplicationManager.getApplication().executeOnPooledThread {
            if (myGen != summaryGeneration) return@executeOnPooledThread
            try {
                generateAndStoreE2eTest(myGen)
                if (myGen != summaryGeneration) return@executeOnPooledThread
                val html = SummaryHtmlBuilder.buildE2eTestSection(currentSummary)
                ApplicationManager.getApplication().invokeLater {
                    if (myGen != summaryGeneration) return@invokeLater
                    postToWebview("e2eTestUpdated", mapOf("html" to html))
                }
            } catch (e: Exception) {
                ApplicationManager.getApplication().invokeLater {
                    if (myGen != summaryGeneration) return@invokeLater
                    postToWebview("e2eTestError", mapOf("message" to (e.message ?: "Generation failed")))
                    Messages.showErrorDialog(project, "E2E test generation failed: ${e.message}", "Error")
                }
            }
        }
    }

    /**
     * Generates an E2E test guide for [currentSummary] via the CLI, persists it,
     * and swaps [currentSummary] to the updated copy. Runs synchronously — call
     * from a pooled thread. Shared by [handleGenerateE2eTest] and the Create PR flow.
     *
     * Delegates to `jolli generate e2e-test` via [CliIntegrations.generate] so
     * provider routing, prompt assembly, and HTTP live in the CLI — the plugin
     * only serializes the topic list, commit message, and diff.
     */
    /**
     * Runs `jolli generate e2e-test` and persists the result. Callers on a pool
     * thread pass their captured [guardedGen] so the `currentSummary` write at
     * the end doesn't clobber a memory the user has since switched to (see the
     * comment on [summaryGeneration]). A null [guardedGen] disables the guard
     * for callers that don't need identity protection (there are none today —
     * every caller runs off setSummary-reachable dispatches).
     */
    private fun generateAndStoreE2eTest(guardedGen: Long? = null): List<E2eTestScenario> {
        val summary = currentSummary
        val (topics) = SummaryUtils.collectSortedTopics(summary)
        val diff = getDiffForCommit(summary.commitHash)
        jmLog.info("generateAndStoreE2eTest: topics=%d, diff len=%d", topics.size, diff.length)

        val request = Gson().toJson(mapOf(
            "topics" to topics.map { it.topic.topic },
            "commitMessage" to summary.commitMessage,
            "diff" to diff,
        ))
        val response = CliIntegrations.generate(cwd, "e2e-test", request)
        val scenariosJson = response.getAsJsonArray("scenarios")
            ?: throw RuntimeException("Empty response from the CLI")
        val scenarios = parseE2eScenariosFromJson(scenariosJson)
        jmLog.info("generateAndStoreE2eTest: CLI returned %d scenario(s); persisting", scenarios.size)

        val updatedSummary = summary.copy(e2eTestGuide = scenarios)
        store.storeSummary(updatedSummary, force = true)
        // Both callers (handleGenerateE2eTest, handleCreatePrWithE2e) rely on
        // the service LRU being fresh for downstream reads — Create PR builds
        // its E2E section from service.getSummary. Invalidate here rather
        // than in each caller so any future caller inherits the guarantee.
        service?.invalidateSummaryCache()
        // The write to currentSummary is the point of no return — every guarded
        // caller must skip it on gen mismatch. The store.storeSummary above is
        // idempotent so an over-write from a stale gen isn't destructive.
        if (guardedGen == null || guardedGen == summaryGeneration) {
            currentSummary = updatedSummary
        }
        return scenarios
    }

    /**
     * Parses the E2E scenario array shape shared by CLI responses and webview edits.
     * Fails loud with a clear message on any missing / mistyped field so a malformed
     * payload surfaces as a caller-visible RuntimeException instead of an NPE deep in
     * gson's `.asString` chain.
     */
    private fun parseE2eScenariosFromJson(scenariosJson: JsonArray): List<E2eTestScenario> {
        return scenariosJson.mapIndexed { i, el ->
            val obj = el.takeIf { it.isJsonObject }?.asJsonObject
                ?: throw RuntimeException("E2E scenario #$i is not a JSON object")
            E2eTestScenario(
                title = requiredString(obj, "title", i),
                preconditions = obj.get("preconditions")?.takeUnless { it.isJsonNull }?.asString,
                steps = requiredStringArray(obj, "steps", i),
                expectedResults = requiredStringArray(obj, "expectedResults", i),
            )
        }
    }

    private fun requiredString(obj: JsonObject, field: String, i: Int): String {
        val el = obj.get(field)?.takeUnless { it.isJsonNull }
            ?: throw RuntimeException("E2E scenario #$i is missing field \"$field\"")
        return runCatching { el.asString }.getOrElse {
            throw RuntimeException("E2E scenario #$i field \"$field\" is not a string")
        }
    }

    private fun requiredStringArray(obj: JsonObject, field: String, i: Int): List<String> {
        val arr = obj.get(field)?.takeIf { it.isJsonArray }?.asJsonArray
            ?: throw RuntimeException("E2E scenario #$i field \"$field\" is missing or not an array")
        return arr.mapIndexed { j, item ->
            runCatching { item.asString }.getOrElse {
                throw RuntimeException("E2E scenario #$i field \"$field\"[$j] is not a string")
            }
        }
    }

    private fun handleEditE2eTest(scenariosJson: JsonArray) {
        val myGen = summaryGeneration
        ApplicationManager.getApplication().executeOnPooledThread {
            if (myGen != summaryGeneration) return@executeOnPooledThread
            val scenarios = parseE2eScenariosFromJson(scenariosJson)
            val updatedSummary = currentSummary.copy(e2eTestGuide = scenarios)
            store.storeSummary(updatedSummary, force = true)
            service?.invalidateSummaryCache()
            if (myGen != summaryGeneration) return@executeOnPooledThread
            currentSummary = updatedSummary
            val html = SummaryHtmlBuilder.buildE2eTestSection(updatedSummary)
            ApplicationManager.getApplication().invokeLater {
                if (myGen != summaryGeneration) return@invokeLater
                postToWebview("e2eTestUpdated", mapOf("html" to html))
            }
        }
    }

    private fun handleDeleteE2eTest() {
        ApplicationManager.getApplication().invokeLater {
            val choice = Messages.showYesNoDialog(project, "This will remove all test scenarios. This cannot be undone.", "Delete E2E Test Guide?", "Delete", "Cancel", Messages.getWarningIcon())
            if (choice != Messages.YES) return@invokeLater
            val myGen = summaryGeneration
            ApplicationManager.getApplication().executeOnPooledThread {
                if (myGen != summaryGeneration) return@executeOnPooledThread
                val updatedSummary = currentSummary.copy(e2eTestGuide = null)
                store.storeSummary(updatedSummary, force = true)
                service?.invalidateSummaryCache()
                if (myGen != summaryGeneration) return@executeOnPooledThread
                currentSummary = updatedSummary
                val html = SummaryHtmlBuilder.buildE2eTestSection(updatedSummary)
                ApplicationManager.getApplication().invokeLater {
                    if (myGen != summaryGeneration) return@invokeLater
                    postToWebview("e2eTestUpdated", mapOf("html" to html))
                }
            }
        }
    }

    private fun handleGenerateRecap() {
        postToWebview("recapGenerating")
        // LLM call — the widest identity-race window in the file (seconds).
        val myGen = summaryGeneration
        ApplicationManager.getApplication().executeOnPooledThread {
            if (myGen != summaryGeneration) return@executeOnPooledThread
            try {
                val summary = currentSummary
                val (topics) = SummaryUtils.collectSortedTopics(summary)

                val request = Gson().toJson(mapOf(
                    "topics" to topics.map { it.topic.topic },
                    "commitMessage" to summary.commitMessage,
                ))
                val response = CliIntegrations.generate(cwd, "recap", request)
                val recap = response.get("recap")?.asString ?: ""

                val trimmed = recap.trim()
                if (trimmed.isEmpty()) {
                    ApplicationManager.getApplication().invokeLater {
                        if (myGen != summaryGeneration) return@invokeLater
                        postToWebview("recapUpdateError")
                        Messages.showInfoMessage(project, "No major topics in this commit, so there's nothing to recap.", "Recap")
                    }
                    return@executeOnPooledThread
                }

                val updatedSummary = summary.copy(recap = trimmed)
                store.storeSummary(updatedSummary, force = true)
                service?.invalidateSummaryCache()
                if (myGen != summaryGeneration) return@executeOnPooledThread
                currentSummary = updatedSummary
                val html = SummaryHtmlBuilder.buildRecapSection(updatedSummary)
                ApplicationManager.getApplication().invokeLater {
                    if (myGen != summaryGeneration) return@invokeLater
                    postToWebview("recapUpdated", mapOf("html" to html))
                }
            } catch (e: Exception) {
                ApplicationManager.getApplication().invokeLater {
                    if (myGen != summaryGeneration) return@invokeLater
                    postToWebview("recapUpdateError", mapOf("message" to (e.message ?: "Generation failed")))
                    Messages.showErrorDialog(project, "Recap generation failed: ${e.message}", "Error")
                }
            }
        }
    }

    private fun handleEditRecap(recap: String) {
        val myGen = summaryGeneration
        ApplicationManager.getApplication().executeOnPooledThread {
            if (myGen != summaryGeneration) return@executeOnPooledThread
            try {
                val updatedSummary = currentSummary.copy(recap = recap.ifEmpty { null })
                store.storeSummary(updatedSummary, force = true)
                service?.invalidateSummaryCache()
                if (myGen != summaryGeneration) return@executeOnPooledThread
                currentSummary = updatedSummary
                val html = SummaryHtmlBuilder.buildRecapSection(updatedSummary)
                ApplicationManager.getApplication().invokeLater {
                    if (myGen != summaryGeneration) return@invokeLater
                    postToWebview("recapUpdated", mapOf("html" to html))
                }
            } catch (e: Exception) {
                ApplicationManager.getApplication().invokeLater {
                    if (myGen != summaryGeneration) return@invokeLater
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
        val myGen = summaryGeneration
        ApplicationManager.getApplication().executeOnPooledThread {
            if (myGen != summaryGeneration) return@executeOnPooledThread
            store.writePlanToBranch(slug, content, "Edit plan $slug")
            // syncPlanTitle writes currentSummary too — thread the gen through so it
            // no-ops when the user has switched memories.
            syncPlanTitle(slug, content, myGen)
            ApplicationManager.getApplication().invokeLater {
                if (myGen != summaryGeneration) return@invokeLater
                postToWebview("planSaved", mapOf("slug" to slug))
            }
        }
    }

    private fun handleRemovePlan(slug: String, title: String) {
        ApplicationManager.getApplication().invokeLater {
            val choice = Messages.showYesNoDialog(project, "The plan will no longer be associated with this commit.", "Remove plan \"$title\"?", "Remove", "Cancel", Messages.getWarningIcon())
            if (choice != Messages.YES) return@invokeLater
            val myGen = summaryGeneration
            ApplicationManager.getApplication().executeOnPooledThread {
                if (myGen != summaryGeneration) return@executeOnPooledThread
                val updatedPlans = (currentSummary.plans ?: emptyList()).filter { it.slug != slug }
                val updatedSummary = currentSummary.copy(plans = updatedPlans.takeIf { it.isNotEmpty() })
                store.storeSummary(updatedSummary, force = true)
                service?.invalidateSummaryCache()
                if (myGen != summaryGeneration) return@executeOnPooledThread
                currentSummary = updatedSummary
                // Dissociate from THIS commit: the CLI resolves the archive base
                // and gates the delete on the row still belonging to `commitHash`,
                // so dissociating an old summary can't wipe a row that has since
                // been revived under the same slug. Read the hash off the local
                // `updatedSummary`, not the `currentSummary` field — the field is
                // mutable and the assignment above is generation-guarded, so on a
                // late generation it still points at a DIFFERENT memory and the
                // gate would be checked against the wrong commit.
                WorkingContext.removePlan(cwd, slug, updatedSummary.commitHash)
                // Then drop the visible `<branch>/plan--<slug>.md` from the Memory
                // Bank folder, or it lingers as a ghost the memory no longer
                // references. Registry removal does not imply it — the visible layer
                // is generated, so nothing else prunes it. Branch comes off the same
                // `updatedSummary` as the hash above, for the same reason.
                WorkingContext.cleanupVisiblePlanArtifact(cwd, slug, updatedSummary.branch)
                ApplicationManager.getApplication().invokeLater {
                    if (myGen != summaryGeneration) return@invokeLater
                    refreshHtml()
                }
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
            // Confirm-dialog label matches the sidebar row (VSCode's
            // `referenceDisplayTitle`): Linear/Jira/GitHub prepend the nativeId,
            // everyone else shows just the title.
            val sourceId = ai.jolli.jollimemory.core.references.SourceIds.parse(source)
            val displayName = ai.jolli.jollimemory.core.references.SourceDisplay.displayTitle(
                sourceId, nativeId, title,
            )
            val choice = Messages.showYesNoDialog(project, "The reference will no longer be associated with this commit.", "Remove reference \"$displayName\"?", "Remove", "Cancel", Messages.getWarningIcon())
            if (choice != Messages.YES) return@invokeLater
            val myGen = summaryGeneration
            ApplicationManager.getApplication().executeOnPooledThread {
                if (myGen != summaryGeneration) return@executeOnPooledThread
                val updatedRefs = (currentSummary.references ?: emptyList()).filter { it.archivedKey != archivedKey }
                val updatedSummary = currentSummary.copy(references = updatedRefs.takeIf { it.isNotEmpty() })
                store.storeSummary(updatedSummary, force = true)
                service?.invalidateSummaryCache()
                if (myGen != summaryGeneration) return@executeOnPooledThread
                currentSummary = updatedSummary
                ApplicationManager.getApplication().invokeLater {
                    if (myGen != summaryGeneration) return@invokeLater
                    refreshHtml()
                }
            }
        }
    }

    private fun handleTranslatePlan(slug: String) {
        val myGen = summaryGeneration
        ApplicationManager.getApplication().executeOnPooledThread {
            if (myGen != summaryGeneration) return@executeOnPooledThread
            try {
                val content = store.readPlanFromBranch(slug)
                if (content == null) {
                    ApplicationManager.getApplication().invokeLater {
                        if (myGen != summaryGeneration) return@invokeLater
                        postToWebview("planTranslateError", mapOf("slug" to slug, "message" to "Plan not found"))
                    }
                    return@executeOnPooledThread
                }
                val cjkPattern = Regex("[\\u4E00-\\u9FFF\\u3400-\\u4DBF\\uF900-\\uFAFF]")
                if (!cjkPattern.containsMatchIn(content) && !(currentSummary.plans?.find { it.slug == slug }?.let { cjkPattern.containsMatchIn(it.title) } ?: false)) {
                    ApplicationManager.getApplication().invokeLater {
                        if (myGen != summaryGeneration) return@invokeLater
                        Messages.showInfoMessage(project, "Plan is already in English.", "Translation")
                    }
                    return@executeOnPooledThread
                }
                ApplicationManager.getApplication().invokeLater {
                    if (myGen != summaryGeneration) return@invokeLater
                    postToWebview("planTranslating", mapOf("slug" to slug))
                }
                val request = Gson().toJson(mapOf("content" to content))
                val response = CliIntegrations.generate(cwd, "translate", request)
                val translated = response.get("text")?.asString
                    ?: throw RuntimeException("Empty response from the CLI")
                if (myGen != summaryGeneration) return@executeOnPooledThread
                store.writePlanToBranch(slug, translated, "Translate plan $slug to English")
                syncPlanTitle(slug, translated, myGen)
                planTranslateSet.remove(slug)
                ApplicationManager.getApplication().invokeLater {
                    if (myGen != summaryGeneration) return@invokeLater
                    refreshHtml()
                    postToWebview("planTranslated", mapOf("slug" to slug))
                }
            } catch (e: Exception) {
                ApplicationManager.getApplication().invokeLater {
                    if (myGen != summaryGeneration) return@invokeLater
                    postToWebview("planTranslateError", mapOf("slug" to slug, "message" to (e.message ?: "Unknown error")))
                    Messages.showErrorDialog(project, "Translation failed: ${e.message}", "Translation Error")
                }
            }
        }
    }

    /**
     * "+ Associate Plan" — enumerate `~/.claude/plans/`, then archive the pick
     * onto this commit.
     *
     * The enumeration runs on a pooled thread and only the picker returns to the
     * EDT. It is an ide-bridge round-trip, not the local `File.listFiles` it used
     * to be: ~5-20 ms against a bound daemon, but 500 ms-2 s on the cold one-shot
     * fallback, which on the EDT is a visible freeze and trips the platform's
     * slow-operation assertion. `AddContextAction.addPlan` runs the same call the
     * same way; keep the two in step.
     */
    private fun handleAssociatePlan() {
        val summary = currentSummary
        val existingSlugs = (summary.plans ?: emptyList()).map { it.slug }.toSet()
        ApplicationManager.getApplication().executeOnPooledThread {
            val available = try {
                WorkingContext.listAvailablePlans(cwd, existingSlugs)
            } catch (e: Exception) {
                LOG.warn("listAvailablePlans failed: ${e.message}")
                ApplicationManager.getApplication().invokeLater {
                    if (!project.isDisposed) {
                        Messages.showErrorDialog(project, "Could not list plans: ${e.message}", "Associate Plan")
                    }
                }
                return@executeOnPooledThread
            }
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                showAssociatePlanPicker(summary, available)
            }
        }
    }

    /** EDT half of [handleAssociatePlan] — `summary` is the memory the picker was launched from. */
    private fun showAssociatePlanPicker(
        summary: CommitSummary,
        available: List<WorkingContext.AvailablePlan>,
    ) {
        if (available.isEmpty()) {
            Messages.showInfoMessage(project, "No plans available to associate.", "Associate Plan")
            return
        }
        val items = available.map { "${it.title} (${it.slug}.md)" }
        JBPopupFactory.getInstance()
            .createPopupChooserBuilder(items)
            .setTitle("Select a plan to associate")
            .setItemChosenCallback { selectedItem ->
                val index = items.indexOf(selectedItem)
                if (index < 0) return@setItemChosenCallback
                val selected = available[index]
                // Snapshot AFTER the user picks — the popup itself may sit open
                // long enough for the identity to shift, and the write must
                // reflect the memory the picker was launched from (captured
                // in `summary` above).
                val myGen = summaryGeneration
                ApplicationManager.getApplication().executeOnPooledThread {
                    if (myGen != summaryGeneration) return@executeOnPooledThread
                    val planRef = try {
                        WorkingContext.archivePlanForCommit(cwd, selected.slug, summary.commitHash)
                    } catch (e: Exception) {
                        LOG.warn("archivePlanForCommit failed: ${e.message}")
                        null
                    }
                    if (planRef == null) {
                        ApplicationManager.getApplication().invokeLater {
                            if (myGen != summaryGeneration) return@invokeLater
                            Messages.showErrorDialog(project, "Failed to associate plan \"${selected.slug}\".", "Association Failed")
                        }
                        return@executeOnPooledThread
                    }
                    val updatedSummary = summary.copy(plans = (summary.plans ?: emptyList()) + planRef)
                    store.storeSummary(updatedSummary, force = true)
                    service?.invalidateSummaryCache()
                    if (myGen != summaryGeneration) return@executeOnPooledThread
                    currentSummary = updatedSummary
                    ApplicationManager.getApplication().invokeLater {
                        if (myGen != summaryGeneration) return@invokeLater
                        refreshHtml()
                    }
                }
            }
            .createPopup()
            .showInFocusCenter()
    }

    private fun handleCheckPrStatus() {
        // Snapshot the memory identity for the whole gh chain. A cold `gh pr
        // list` takes 1-3 s; if the user clicks a different memory in that
        // window (tab-reuse setSummary), a naïve postToWebview("prStatus",
        // {status:"ready", pr:{...}}) would land on the new memory's DOM. The
        // "ready" payload doesn't include the branch, so the webview cannot
        // filter after the fact — guard here or the wrong PR badge sticks.
        val myGen = summaryGeneration
        val targetBranch = currentSummary.branch
        jmLog.info("handleCheckPrStatus: start (cwd='%s', branch='%s')", cwd, targetBranch)
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                if (myGen != summaryGeneration) return@executeOnPooledThread
                // All three underlying gh calls are TTL-cached on the project
                // service so opening or switching memory tabs on the same
                // branch does not re-fork gh. See PrStatusCache for TTLs.
                val prCache = ai.jolli.jollimemory.services.PrStatusCache.getInstance(project)

                val ghAvailable = prCache.isGhAvailable(cwd)
                jmLog.info("handleCheckPrStatus: isGhAvailable=%s", ghAvailable)
                if (!ghAvailable) {
                    jmLog.warn("handleCheckPrStatus: status=unavailable (gh --version failed — not installed or not on resolved PATH)")
                    ApplicationManager.getApplication().invokeLater {
                        if (myGen != summaryGeneration) return@invokeLater
                        postToWebview("prStatus", mapOf("status" to "unavailable"))
                    }
                    return@executeOnPooledThread
                }
                val ghAuth = prCache.isGhAuthenticated(cwd)
                jmLog.info("handleCheckPrStatus: isGhAuthenticated=%s", ghAuth)
                if (!ghAuth) {
                    jmLog.warn("handleCheckPrStatus: status=unavailable (gh auth status failed — not logged in)")
                    ApplicationManager.getApplication().invokeLater {
                        if (myGen != summaryGeneration) return@invokeLater
                        postToWebview("prStatus", mapOf("status" to "unavailable"))
                    }
                    return@executeOnPooledThread
                }

                // getLookup returns null only when the underlying PrService call
                // threw; a real cache miss is transparently repopulated inside
                // getLookup, so the label here reflects the actual failure mode.
                val lookup = prCache.getLookup(cwd, targetBranch)
                    ?: PrService.PrLookup.LookupError("gh lookup failed")
                jmLog.info("handleCheckPrStatus: lookup=%s", lookup::class.simpleName)

                when (lookup) {
                    is PrService.PrLookup.LookupError -> {
                        jmLog.warn("handleCheckPrStatus: status=unavailable (lookupError: %s)", lookup.reason)
                        ApplicationManager.getApplication().invokeLater {
                            if (myGen != summaryGeneration) return@invokeLater
                            postToWebview("prStatus", mapOf("status" to "unavailable", "reason" to lookup.reason))
                        }
                    }
                    is PrService.PrLookup.NoPr -> {
                        jmLog.info("handleCheckPrStatus: status=noPr (branch='%s', history=%d)", targetBranch, lookup.history.size)
                        ApplicationManager.getApplication().invokeLater {
                            if (myGen != summaryGeneration) return@invokeLater
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
                            if (myGen != summaryGeneration) return@invokeLater
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
                    if (myGen != summaryGeneration) return@invokeLater
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
        val myGen = summaryGeneration
        ApplicationManager.getApplication().executeOnPooledThread {
            if (myGen != summaryGeneration) return@executeOnPooledThread
            try {
                jmLog.info("handleCreatePrWithE2e: generateAndStoreE2eTest() start")
                val scenarios = generateAndStoreE2eTest(myGen)
                jmLog.info("handleCreatePrWithE2e: generateAndStoreE2eTest() done — %d scenario(s)", scenarios.size)
                if (myGen != summaryGeneration) return@executeOnPooledThread
                val e2eHtml = SummaryHtmlBuilder.buildE2eTestSection(currentSummary)
                ApplicationManager.getApplication().invokeLater {
                    if (myGen != summaryGeneration) return@invokeLater
                    postToWebview("e2eTestUpdated", mapOf("html" to e2eHtml))
                    showCreatePrForm()
                }
            } catch (e: Exception) {
                jmLog.error("handleCreatePrWithE2e: E2E generation failed: %s", e.message ?: e.toString())
                ApplicationManager.getApplication().invokeLater {
                    if (myGen != summaryGeneration) return@invokeLater
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
                    // Drop the 60s TTL cache entry for this branch BEFORE
                    // handleCheckPrStatus reads it — a `NoPr` cached moments
                    // ago (when the tab opened) would otherwise be served
                    // back and the badge would show "no PR" for up to 60s
                    // even though we just created one. See PrStatusCache
                    // header ("invalidateBranch should be called after any
                    // surface creates or updates a PR").
                    ai.jolli.jollimemory.services.PrStatusCache
                        .getInstance(project)
                        .invalidateBranch(cwd, currentSummary.branch)
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
                    // Same reasoning as handleCreatePr: the branch may have a
                    // 60s-cached lookup from when the tab opened; drop it so
                    // handleCheckPrStatus reflects the just-updated PR title
                    // instead of the pre-update snapshot.
                    ai.jolli.jollimemory.services.PrStatusCache
                        .getInstance(project)
                        .invalidateBranch(cwd, currentSummary.branch)
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

    /**
     * Re-derives the plan's title from its H1 and mirrors it into [currentSummary]
     * + the on-disk plans registry. Called from pool contexts (handleSavePlan,
     * handleTranslatePlan) — the [guardedGen] param mirrors the pattern used by
     * [refreshTranscriptHashes] and short-circuits the currentSummary write when
     * the user has switched memories. The store.storeSummary write above the
     * currentSummary assignment is idempotent, so writing to the (now-outgoing)
     * hash's summary on disk is fine — only the in-memory identity is protected.
     */
    private fun syncPlanTitle(slug: String, content: String, guardedGen: Long? = null) {
        val titleMatch = Regex("^#\\s+(.+)", RegexOption.MULTILINE).find(content)
        val newTitle = titleMatch?.groupValues?.get(1)?.trim() ?: return
        val plans = currentSummary.plans ?: return
        val updatedPlans = plans.map { p -> if (p.slug == slug) p.copy(title = newTitle) else p }
        val updatedSummary = currentSummary.copy(plans = updatedPlans)
        store.storeSummary(updatedSummary, force = true)
        // Both callers (handleSavePlan, handleTranslatePlan) rely on the
        // service LRU being fresh for cross-surface reads of the plan title.
        service?.invalidateSummaryCache()
        if (guardedGen == null || guardedGen == summaryGeneration) {
            currentSummary = updatedSummary
        }
        // Registry-side sync is CLI-owned (it takes plans.lock and merges onto a
        // fresh read) so this path runs the same write VS Code does.
        WorkingContext.renamePlanTitle(cwd, slug, newTitle)
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

        /**
         * Cap on concurrent ide-bridge readPlanFromBranch calls fanned out from
         * [refreshPlanTranslateSet]. Matches the previous fixed-thread-pool sizing
         * so a plan-heavy memory doesn't monopolize IntelliJ's shared pooled-thread
         * executor and starve git status / VFS refresh work.
         */
        private const val PLAN_READ_CONCURRENCY = 8
    }
}

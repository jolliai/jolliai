package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.bridge.GitRemoteUtils
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.StorageFactory
import ai.jolli.jollimemory.core.SummaryStore
import ai.jolli.jollimemory.core.TraceContext
import ai.jolli.jollimemory.services.JolliApiClient
import ai.jolli.jollimemory.services.JolliAuthService
import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.services.JolliShareService
import ai.jolli.jollimemory.services.PrService
import ai.jolli.jollimemory.toolwindow.views.CreatePrBodyMarkdown
import ai.jolli.jollimemory.toolwindow.views.CreatePrData
import ai.jolli.jollimemory.toolwindow.views.CreatePrHtmlBuilder
import ai.jolli.jollimemory.toolwindow.views.ThemeUtils
import ai.jolli.jollimemory.toolwindow.views.ThemeUtils.toCssHex
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.network.CefRequest
import java.awt.BorderLayout
import java.awt.Font
import java.awt.Toolkit
import java.awt.datatransfer.StringSelection
import java.io.File
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JTextArea

/**
 * Dedicated "Create PR" JCEF webview — the branch-level Create-PR surface matching
 * the design mockup's `#pane-pr`. Mirrors [SummaryPanel]'s JCEF bridge.
 *
 * On submit it creates (or updates) the PR via [PrService] and, when a Jolli site
 * key is configured, ALSO shares the included memories to Jolli via
 * [JolliShareService] — the one-click "create the PR and share" flow. Binding-
 * required (412) is resolved once via [BindingChooserDialog], then sharing resumes.
 */
class CreatePrPanel(
    private val project: Project,
    initialVm: CreatePrData.ViewModel,
) : JPanel(BorderLayout()) {

    @Volatile
    private var vm: CreatePrData.ViewModel = initialVm

    // Browser + JS query come from [JcefBrowserPool] so this tab reuses a warm
    // instance across the whole IDE session (shared with the memory-detail tab).
    // See createContent() for the acquisition + lifecycle notes that mirror
    // SummaryPanel; dispose() returns the lease instead of disposing the browser.
    @Volatile
    private var browser: JBCefBrowser? = null
    @Volatile
    private var jsQuery: JBCefJSQuery? = null
    @Volatile
    private var lease: PooledBrowserLease? = null
    private var bridgeScript: String = ""

    @Volatile
    private var disposed = false

    // Monotonic supersession counter for [loadHtmlAsync]. Every pool build
    // stamps its start-time value and drops on the EDT hop if a newer render
    // has been queued in the meantime — same shape as [SummaryPanel.renderGeneration].
    // Written on the EDT (in loadHtmlAsync entry), snapshotted on the pool
    // thread, compared on the EDT again after the build finishes. All accesses
    // are EDT-only today; @Volatile is defensive against a future off-EDT
    // reader and mirrors SummaryPanel.renderGeneration.
    @Volatile
    private var renderGeneration: Long = 0
    private val gson = Gson()
    private val store: SummaryStore
    private val cwd: String
    private val service = project.getService(JolliMemoryService::class.java)
    // Refresh when a PR is created/updated or a memory is shared elsewhere (a memory
    // summary or the Commits list) so this branch-level view's PR mode + per-memory
    // "shared" badges stay in sync with the single branch PR + each summary's jolliDocUrl.
    private val memoryStateListener: () -> Unit = { onMemoryStateChanged() }

    init {
        cwd = service?.mainRepoRoot ?: project.basePath ?: ""
        val git = service?.getGitOps() ?: GitOps(cwd)
        store = SummaryStore(cwd, git, StorageFactory.create(git, cwd))
        add(createContent(), BorderLayout.CENTER)
        service?.addMemoryStateListener(memoryStateListener)
    }

    // True while the webview holds unsaved title/body edits (set by the 'editState'
    // message, cleared on every full reload). Guards against a cross-panel memory-state
    // event reloading the page and silently dropping those edits.
    @Volatile
    private var webviewDirty = false

    /** Rebuilds the view model from fresh data (PR lookup + summaries) and re-renders. */
    private fun onMemoryStateChanged() {
        // Never clobber unsaved edits. The status will re-sync on the next reload (after
        // the user submits/refreshes) — losing in-progress typing is the worse failure.
        if (webviewDirty) return
        ApplicationManager.getApplication().executeOnPooledThread {
            val refreshed = try {
                CreatePrData.build(project)
            } catch (_: Exception) {
                null
            }
            if (refreshed != null) {
                ApplicationManager.getApplication().invokeLater {
                    if (webviewDirty) return@invokeLater
                    vm = refreshed
                    refreshHtml()
                }
            }
        }
    }

    private fun createContent(): JComponent {
        return try {
            // Reuse a browser from the project-scoped pool so this tab shares
            // its warm JCEF renderer with the memory-detail tab — V8's bytecode
            // cache stays alive, and the "old content → new content" transition
            // replaces the old "white → content" flash. Mirrors SummaryPanel's
            // pool wiring; the source tag helps identify us in pool logs.
            val acquired = JcefBrowserPool.get(project).acquire("create-pr:${vm.branch.take(24)}")
            lease = acquired
            val b = acquired.browser
            browser = b

            val query = acquired.createJSQuery()
            jsQuery = query
            query.addHandler { request ->
                try {
                    val decoded = String(java.util.Base64.getDecoder().decode(request), Charsets.UTF_8)
                    dispatchWebviewMessage(JsonParser.parseString(decoded).asJsonObject)
                } catch (e: Exception) {
                    LOG.warn("Failed to parse webview message: ${e.message}", e)
                }
                JBCefJSQuery.Response("ok")
            }
            bridgeScript = """
                window.__jbQuery = function(msg) {
                    ${query.inject("msg")}
                };
            """.trimIndent()
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
                        return true
                    }
                    return false
                }
            })
            // Theme the native Chromium view before the first load so the initial
            // about:blank → content navigation never flashes white. When the browser
            // came from the pool it may still show the previous tab's page until
            // this loadHTML replaces it — that's the desired "old → new" transition,
            // not a bug.
            val prBg = ThemeUtils.editorBackground()
            b.component.isOpaque = true
            b.component.background = prBg
            b.setPageBackgroundColor(prBg.toCssHex())
            // Fire the initial load through [loadHtmlAsync] — CreatePrHtmlBuilder.buildHtml
            // is 50–150ms of Kotlin string concatenation and was previously running on
            // the EDT here, freezing the whole UI for the duration of the initial paint.
            // Async build + invokeLater loadHTML keeps the EDT free while Chromium and
            // the tab layout mount in parallel.
            loadHtmlAsync()
            b.component
        } catch (e: Exception) {
            LOG.info("JCEF unavailable: ${e.message}")
            JBScrollPane(
                JTextArea(vm.bodyMarkdown).apply {
                    isEditable = false
                    font = Font("Monospaced", Font.PLAIN, 13)
                    lineWrap = true
                    wrapStyleWord = true
                    caretPosition = 0
                },
            )
        }
    }

    fun dispose() {
        if (disposed) return
        disposed = true
        service?.removeMemoryStateListener(memoryStateListener)
        // Release the lease instead of disposing the browser: the pool returns it
        // to idle so the next Create PR / memory tab hits a warm instance instead
        // of paying the ~700 ms JCEF build cost again. PooledBrowserLease.release()
        // auto-detaches the JS query + CEF request handler we attached. The pool
        // asserts EDT on release; tab-close is normally EDT already but Disposer
        // can tear editors down from any thread during project close — hop first.
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

    // Success acks that indicate any prior in-webview edits (title/body) have been
    // persisted server-side. Once one arrives, clearing webviewDirty lets future
    // cross-panel memory-state events refresh this tab again. Without this, the
    // `handleCreatePr` fallback branch where CreatePrData.build returns null
    // (which does NOT run refreshHtml — the only other place that clears the flag)
    // would strand webviewDirty=true for the tab's lifetime, permanently short-
    // circuiting onMemoryStateChanged(). Mirrors [SummaryPanel.savePersistedAcks].
    private val savePersistedAcks = setOf("prCreated")

    private fun postToWebview(command: String, data: Map<String, Any?> = emptyMap()) {
        if (command in savePersistedAcks) webviewDirty = false
        val payload = gson.toJson(data + ("command" to command))
        val b64 = java.util.Base64.getEncoder().encodeToString(payload.toByteArray(Charsets.UTF_8))
        browser?.cefBrowser?.executeJavaScript(
            "window.dispatchEvent(new CustomEvent('jollimemory', { detail: JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('$b64'), function(c){ return c.charCodeAt(0); }))) }));",
            browser?.cefBrowser?.url ?: "",
            0,
        )
    }

    private fun refreshHtml() {
        // A full reload replaces the DOM, so any prior unsaved edits are gone either way;
        // clear the flag so future memory-state events can refresh again.
        webviewDirty = false
        loadHtmlAsync()
    }

    /**
     * Build the HTML off the EDT (CreatePrHtmlBuilder.buildHtml is 50–150 ms of
     * Kotlin string concatenation) and only bounce back to loadHTML on the EDT.
     * Mirrors [SummaryPanel.doRefreshNow]. Called by [createContent] for the
     * first paint and by [refreshHtml] for every subsequent rebuild (hydrate,
     * memory-state event, PR create/update ack).
     *
     * Supersession: every call bumps [renderGeneration]. A slower build whose
     * newer sibling has already rendered is silently dropped in the EDT hop,
     * so rapid rebuild bursts (e.g. hydrate landing right after an editState)
     * never let a stale HTML overwrite a fresher one.
     *
     * Must be called on the EDT (reads mutable fields — vm, browser, etc.).
     */
    private fun loadHtmlAsync() {
        val vmSnapshot = vm
        val isDark = !JBColor.isBright()
        val bridgeScriptSnapshot = bridgeScript
        val myGen = ++renderGeneration
        ApplicationManager.getApplication().executeOnPooledThread {
            val html = try {
                CreatePrHtmlBuilder.buildHtml(vmSnapshot, isDark, bridgeScriptSnapshot)
            } catch (e: Exception) {
                LOG.warn("loadHtmlAsync: buildHtml failed: ${e.message}", e)
                return@executeOnPooledThread
            }
            ApplicationManager.getApplication().invokeLater {
                if (disposed) return@invokeLater
                if (myGen != renderGeneration) return@invokeLater
                browser?.loadHTML(html)
            }
        }
    }

    /**
     * Hydrates a skeleton tab with the full view model. Called from
     * [CommitsPanel.openCreatePrView] after the background `build()` finishes:
     *
     *   click → CreatePrData.buildSkeleton (fast) → open tab with skeleton
     *         → CreatePrData.build (slow)         → hydrate(fullVm)
     *
     * Skips when the user has already dirtied the title/body — a full reload
     * would clobber those edits and the fast fields we filled in the skeleton
     * (title/branch/counts) are already correct. Must be called on the EDT.
     */
    fun hydrate(newVm: CreatePrData.ViewModel) {
        if (webviewDirty) return
        vm = newVm
        refreshHtml()
    }

    private fun dispatchWebviewMessage(json: JsonObject) {
        when (json.get("command")?.asString) {
            "createPr" -> handleCreatePr(json.get("title")?.asString, json.get("body")?.asString)
            "copyBody" -> handleCopyBody(json.get("body")?.asString)
            "openMemory" -> handleOpenMemory(json.get("hash")?.asString ?: return)
            "openDiff" -> handleOpenDiff(json.get("path")?.asString ?: return)
            "openPr" -> json.get("url")?.asString?.let { BrowserUtil.browse(it) }
            "signIn" -> handleSignIn()
            "editState" -> webviewDirty = json.get("editing")?.asBoolean == true
            "renderBody" -> handleRenderBody(json.get("body")?.asString.orEmpty())
        }
    }

    /**
     * Renders the current textarea body via [CreatePrBodyMarkdown.renderPrBodyMarkdown]
     * — the same renderer used for the initial paint — and posts the HTML back so the
     * webview can swap it into `#prBody`. Runs on a pooled thread because the renderer
     * is a pure Kotlin string transform that can spend a few ms on a large body, and
     * the JCEF query dispatch is on a JCEF pool thread we don't want to hog.
     */
    private fun handleRenderBody(raw: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val html = try {
                CreatePrBodyMarkdown.renderPrBodyMarkdown(raw)
            } catch (e: Exception) {
                LOG.warn("renderPrBodyMarkdown failed: ${e.message}", e)
                return@executeOnPooledThread
            }
            ApplicationManager.getApplication().invokeLater {
                if (disposed) return@invokeLater
                postToWebview("bodyRendered", mapOf("html" to html))
            }
        }
    }

    private fun handleCopyBody(bodyArg: String?) {
        // Use the live (possibly edited) body from the textarea, matching what Create/Update
        // submits; fall back to the view-model body when the webview sends nothing.
        val raw = bodyArg?.takeIf { it.isNotBlank() } ?: vm.bodyMarkdown
        val body = PrService.wrapWithMarkers(raw)
        Toolkit.getDefaultToolkit().systemClipboard.setContents(StringSelection(body), null)
        postToWebview("bodyCopied", mapOf("text" to "Copied PR body markdown to clipboard"))
    }

    private fun handleOpenMemory(hash: String) {
        val summary = vm.includedSummaries.firstOrNull { it.commitHash == hash } ?: return
        MemoryTabOpener.openOrReuse(project, summary)
    }

    private fun handleOpenDiff(path: String) {
        // Repo-relative path only — reject traversal/absolute paths.
        if (path.startsWith("/") || path.contains("..")) return
        val file = File(cwd, path)
        val vfile = com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByIoFile(file) ?: return
        FileEditorManager.getInstance(project).openFile(vfile, true)
    }

    private fun handleSignIn() {
        JolliAuthService.login(
            onSuccess = {
                ApplicationManager.getApplication().invokeLater {
                    vm = vm.copy(signedIn = true)
                    refreshHtml()
                }
            },
            onError = { msg ->
                ApplicationManager.getApplication().invokeLater {
                    Messages.showErrorDialog(project, "Sign-in failed: $msg", "Jolli Memory")
                }
            },
        )
    }

    private fun handleCreatePr(titleArg: String?, bodyArg: String?) {
        val title = titleArg?.takeIf { it.isNotBlank() } ?: vm.title
        val rawBody = bodyArg?.takeIf { it.isNotBlank() } ?: vm.bodyMarkdown

        postToWebview("prCreating", mapOf("text" to "Pushing branch…"))
        ApplicationManager.getApplication().executeOnPooledThread {
            TraceContext.withTrace {
                try {
                    PrService.pushBranch(cwd)
                    val lookup = PrService.findPrForBranch(cwd, vm.branch)
                    val prUrl = if (lookup is PrService.PrLookup.Found) {
                        // Update: merge our summary into the EXISTING PR body's marker region so
                        // any user-authored text OUTSIDE the markers is preserved. Overwriting with
                        // wrapWithMarkers would delete that custom text (mirrors SummaryPanel.handleUpdatePr).
                        val mergedBody = PrService.replaceSummaryInBody(lookup.pr.body, rawBody)
                        PrService.updatePr(lookup.pr.number, title, mergedBody, cwd)
                        ai.jolli.jollimemory.core.telemetry.Telemetry.track("pr_created", mapOf("action" to "updated"))
                        lookup.pr.url
                    } else {
                        // Create: no existing body to preserve — wrap the summary in markers.
                        val created = PrService.createPr(title, PrService.wrapWithMarkers(rawBody), cwd)
                        ai.jolli.jollimemory.core.telemetry.Telemetry.track("pr_created", mapOf("action" to "created"))
                        created
                    }

                    // One-click share: when signed in, push the included memories to Jolli.
                    val shareMsg = shareIncludedMemoriesIfSignedIn()

                    // Snapshot the branch we just created/updated the PR for BEFORE any
                    // rebuild swaps `vm`. If the user runs `git checkout other` during the
                    // 1-3 s create window, `refreshed.branch` becomes the new branch, and
                    // invalidating `vm.branch` after the swap would clear the wrong cache
                    // key — leaving the original branch's stale `NoPr` entry alive for its
                    // full 60 s TTL, so CommitsPanel / open-memory PR badges keep showing
                    // "no PR" for the branch we just published on.
                    val originalBranch = vm.branch
                    // Invalidate the PR-status TTL cache BEFORE the rebuild reads it. The
                    // initial hydrate cached `NoPr` for this branch; without invalidating
                    // first, `CreatePrData.build` hits the stale entry, `refreshed.existingPr`
                    // is null, and the panel renders "Create PR" (should be "Update PR" +
                    // #prOpenLink) after we just created the PR. `notifyMemoryStateChanged`
                    // usually self-corrects, but only if the user hasn't started typing —
                    // once `webviewDirty=true`, `onMemoryStateChanged` short-circuits and
                    // the wrong label sticks for the full 60 s TTL.
                    ai.jolli.jollimemory.services.PrStatusCache
                        .getInstance(project)
                        .invalidateBranch(cwd, originalBranch)

                    // Re-detect the PR so the panel flips to Update mode ("Update PR"
                    // button + a link to the PR) now that one exists. A later submit then
                    // updates that PR instead of erroring on a duplicate create.
                    val refreshed = try {
                        CreatePrData.build(project)
                    } catch (_: Exception) {
                        null
                    }

                    ApplicationManager.getApplication().invokeLater {
                        Messages.showInfoMessage(project, "Pull request ready.\n$prUrl$shareMsg", "Create PR")
                        if (refreshed != null) {
                            vm = refreshed
                            refreshHtml()
                        } else {
                            postToWebview("prCreated", mapOf("text" to "Pull request ready.$shareMsg"))
                        }
                        // Tell the other surfaces (Commits list, open memory summaries) a PR
                        // now exists and memories were shared, so they re-read and match.
                        service?.notifyMemoryStateChanged()
                    }
                } catch (e: Exception) {
                    ApplicationManager.getApplication().invokeLater {
                        postToWebview("prCreateError", mapOf("text" to (e.message ?: "Create failed")))
                        Messages.showErrorDialog(project, "Create PR failed: ${e.message}", "PR Error")
                    }
                }
            }
        }
    }

    /**
     * Shares the included memories to Jolli when a site key is configured. Returns a
     * human-readable suffix for the success toast (empty when not signed in). Runs on
     * the calling pooled thread; best-effort per memory. Resolves a binding-required
     * (412) once via the chooser dialog, then continues.
     */
    /**
     * Maps a share failure to a whole-loop stop reason, or null when it is a
     * per-memory failure worth counting and moving past.
     *
     * Every included memory belongs to the SAME repo, so a sign-in / permission /
     * opt-out / gate verdict applies to all of them: continuing would fire N doomed
     * requests and report one repo-wide condition as N per-memory failures.
     *
     * This is a FUNCTION, not a chain of `catch` arms, because the share loop has two
     * failure sites — the first attempt and the post-binding retry — and each new
     * repo-wide error type would otherwise have to be added to both. It only ever
     * got added to one, which is exactly how a repo-wide refusal from the retry ended
     * up counted as a single per-memory failure. Add new repo-wide types HERE.
     *
     * `BindingRequiredError` is deliberately absent: it is recoverable (the chooser
     * runs, then the memory is retried), so it is handled by its own arm rather than
     * being classified as a stop.
     */
    private fun repoWideStopReason(e: Throwable): String? = when (e) {
        is JolliApiClient.UnauthorizedError -> "sign-in rejected"
        // Credential is valid but the server refused the push (e.g. the repo isn't
        // allowlisted for the Space) — an admin problem, not a sign-in one.
        is JolliApiClient.PermissionDeniedError -> "not allowed — ask an administrator"
        is JolliApiClient.PluginOutdatedError -> "plugin outdated"
        // The user opted this repo out of outbound push (spec 306) — not a failure.
        is JolliShareService.PushDisabledError -> "outbound push disabled"
        // The gate could not be evaluated (spec 306 fail-closed): nothing was sent.
        is JolliShareService.PushGateUnavailableError -> "couldn't verify the push setting"
        else -> null
    }

    private fun shareIncludedMemoriesIfSignedIn(): String {
        val config = SessionTracker.loadConfig(cwd)
        val apiKey = config.jolliApiKey?.takeIf { it.isNotBlank() } ?: return ""
        val resolvedBaseUrl = JolliApiClient.parseJolliApiKey(apiKey)?.u
            ?: ai.jolli.jollimemory.auth.JolliUrlConfig.getJolliUrl()
        if (resolvedBaseUrl.isBlank()) return ""

        postToWebview("prProgress", mapOf("text" to "PR ready — sharing memories to Jolli…"))
        val attempted = vm.includedSummaries.size
        var shared = 0
        var failed = 0
        var stopReason: String? = null
        var bindingResolved = false
        loop@ for (summary in vm.includedSummaries) {
            try {
                JolliShareService.shareSummary(store, summary, cwd, apiKey, resolvedBaseUrl)
                shared++
            } catch (e: JolliApiClient.BindingRequiredError) {
                if (bindingResolved || !resolveBinding(e.repoUrl, resolvedBaseUrl, apiKey)) {
                    LOG.info("Share aborted: binding not resolved")
                    stopReason = "space not bound"
                    break@loop
                }
                bindingResolved = true
                // Retry this memory now that the repo is bound. The retry is a SECOND
                // failure site, so it must classify through the same helper: catching
                // bare Exception here is what let a repo-wide refusal raised by the
                // retry be counted as one per-memory failure and keep the loop running.
                try {
                    JolliShareService.shareSummary(store, summary, cwd, apiKey, resolvedBaseUrl)
                    shared++
                } catch (e2: Exception) {
                    val reason = repoWideStopReason(e2)
                    if (reason != null) {
                        LOG.warn("Share stopped after binding retry — $reason: ${e2.message}")
                        stopReason = reason
                        break@loop
                    }
                    LOG.warn("Share retry failed for ${summary.commitHash.take(8)}: ${e2.message}")
                    failed++
                }
            } catch (e: Exception) {
                val reason = repoWideStopReason(e)
                if (reason != null) {
                    LOG.warn("Share stopped — $reason: ${e.message}")
                    stopReason = reason
                    break@loop
                }
                LOG.warn("Share failed for ${summary.commitHash.take(8)}: ${e.message}")
                failed++
            }
        }
        // Report honestly: don't imply every memory shared when some (or all) failed or
        // sharing stopped early. Diagnosable stops (auth / plugin outdated / binding) are
        // named; per-memory failures are counted; everything points at the log for detail.
        return when {
            stopReason != null -> " Sharing stopped ($stopReason) — shared $shared of $attempted to Jolli. See log."
            failed > 0 -> " Shared $shared of $attempted to Jolli — $failed failed. See log."
            shared > 0 -> " Shared $shared ${if (shared == 1) "memory" else "memories"} to Jolli."
            else -> " Sharing failed — 0 of $attempted shared to Jolli. See log."
        }
    }

    /**
     * Shows the space-binding chooser (412 handling) synchronously and returns true
     * when the user selected a space. Blocks the calling pooled thread via
     * invokeAndWait since the dialog is modal on the EDT.
     */
    private fun resolveBinding(repoUrl: String, baseUrl: String, apiKey: String): Boolean {
        val spaces = try {
            JolliApiClient.listSpaces(baseUrl, apiKey)
        } catch (e: Exception) {
            LOG.warn("resolveBinding: listSpaces failed: ${e.message}")
            return false
        }
        val suggestedRepoName = GitRemoteUtils.deriveRepoNameFromUrl(repoUrl).ifEmpty { "repo" }
        var selected = false
        ApplicationManager.getApplication().invokeAndWait {
            if (BindingChooserDialog.isAlreadyOpen(repoUrl)) return@invokeAndWait
            val dialog = BindingChooserDialog.open(
                project, repoUrl, suggestedRepoName,
                spaces.spaces, spaces.defaultSpaceId, baseUrl, apiKey,
            )
            dialog.show()
            selected = dialog.getOutcome() is BindingChooserOutcome.Selected
        }
        return selected
    }

    companion object {
        private val LOG = Logger.getInstance(CreatePrPanel::class.java)
    }
}

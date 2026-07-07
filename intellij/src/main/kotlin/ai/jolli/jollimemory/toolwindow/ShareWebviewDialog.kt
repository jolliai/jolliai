package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.TraceContext
import ai.jolli.jollimemory.services.BranchShareModal
import ai.jolli.jollimemory.toolwindow.views.ShareWebview
import ai.jolli.jollimemory.toolwindow.views.SummaryCssBuilder
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.network.CefRequest
import com.intellij.openapi.application.ModalityState
import java.awt.Dimension
import java.awt.Point
import java.util.Base64
import javax.swing.Action
import javax.swing.JComponent
import javax.swing.SwingUtilities

/**
 * Renders the share modal as a JCEF **webview** inside a dialog — the same [ShareWebview] HTML/CSS/JS
 * the inline summary-view modal uses. Launched from the Swing sidebar Share button (branch share) and
 * the Commits-panel row Share icon (commit share), so those Swing triggers open the identical webview
 * the committed-memory view shows. Drives the single-slot [BranchShareModal] state machine.
 */
class ShareWebviewDialog(
    private val project: Project,
    private val ctx: BranchShareModal.ShareModalContext,
) : DialogWrapper(project, false) {

    private val log = JmLogger.create("ShareWebviewDialog")
    private val gson = Gson()
    private var browser: JBCefBrowser? = null
    private var jsQuery: JBCefJSQuery? = null

    init {
        title = if (ctx.commitHash != null) "Share memory" else "Share branch"
        setModal(true)
        init()
    }

    override fun createCenterPanel(): JComponent {
        return try {
            val b = JBCefBrowser()
            browser = b
            val query = JBCefJSQuery.create(b as JBCefBrowserBase)
            jsQuery = query
            query.addHandler { request ->
                try {
                    val decoded = String(Base64.getDecoder().decode(request), Charsets.UTF_8)
                    dispatch(JsonParser.parseString(decoded).asJsonObject)
                } catch (e: Exception) {
                    log.warn("Failed to parse share webview message: ${e.message}")
                }
                JBCefJSQuery.Response("ok")
            }
            val bridgeScript = "window.__jbQuery = function(msg) { ${query.inject("msg")} };"

            b.jbCefClient.addRequestHandler(object : CefRequestHandlerAdapter() {
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
            }, b.cefBrowser)

            val css = SummaryCssBuilder.buildCss(!JBColor.isBright())
            b.loadHTML(ShareWebview.standaloneDocument(css, bridgeScript))
            // Initial size — the webview reports its real content size right after DOM renders and
            // handleResize() re-packs the dialog to fit exactly. Kept small so pack() only grows.
            b.component.apply { preferredSize = Dimension(460, 260) }
        } catch (e: Exception) {
            log.info("JCEF unavailable for share dialog: ${e.message}")
            JBLabel("Share is unavailable — the JCEF runtime could not start.")
        }
    }

    override fun createActions(): Array<Action> = arrayOf(cancelAction.also { it.putValue(Action.NAME, "Close") })

    // ── Webview → host ─────────────────────────────────────────────────────────

    private fun dispatch(json: JsonObject) {
        val command = json.get("command")?.asString ?: return
        log.info("dispatch: received command='$command'")
        if (command == "shareCloseDialog") {
            ApplicationManager.getApplication().invokeLater({ close(OK_EXIT_CODE) }, ModalityState.any())
            return
        }
        if (command == "shareResize") {
            val w = json.get("width")?.asInt ?: return
            val h = json.get("height")?.asInt ?: return
            handleResize(w, h)
            return
        }
        if (command == "shareDebug") {
            val msg = json.get("message")?.asString ?: return
            log.info("[webview] $msg")
            return
        }
        val io = webviewIO()
        ApplicationManager.getApplication().executeOnPooledThread {
            TraceContext.withTrace {
                try {
                    when (command) {
                        "shareBranch" -> BranchShareModal.openShareModal(io, ctx)
                        "shareCopyLink" -> BranchShareModal.copyShareLinkModal(io, ctx, json.get("visibility")?.asString ?: "public")
                        "shareSetAccess" -> BranchShareModal.setShareAccessModal(io, ctx, json.get("visibility")?.asString ?: "public")
                        "shareSendInvite" -> {
                            val recipients = json.getAsJsonArray("recipients")?.mapNotNull { it.asString } ?: emptyList()
                            val note = json.get("message")?.asString?.take(2000)
                            BranchShareModal.sendInviteModal(io, ctx, recipients, note, json.get("visibility")?.asString)
                        }
                        "shareRemoveRecipient" -> BranchShareModal.removeRecipientModal(io, ctx, json.get("email")?.asString ?: "")
                    }
                    log.info("dispatch: command='$command' completed")
                } catch (e: Exception) {
                    log.warn("Share action '$command' failed: ${e.message}", e)
                }
            }
        }
    }

    private fun webviewIO() = object : BranchShareModal.ShareModalIO {
        override fun postState(state: BranchShareModal.ShareModalState) {
            postToWebview("shareState", mapOf("state" to ShareWebview.stateToMap(state)))
        }

        override fun copyToClipboard(text: String): Boolean = try {
            java.awt.Toolkit.getDefaultToolkit().systemClipboard
                .setContents(java.awt.datatransfer.StringSelection(text), null)
            true
        } catch (_: Exception) {
            false
        }

        override fun postCopyResult(result: BranchShareModal.ShareCopyResult) {
            postToWebview("shareCopyResult", mapOf("ok" to result.ok))
        }

        override fun notifyError(message: String) = notify(message, NotificationType.ERROR)
        override fun notifyInfo(message: String) = notify(message, NotificationType.INFORMATION)
    }

    private fun postToWebview(command: String, data: Map<String, Any?>) {
        log.info("postToWebview: command='$command', browserAlive=${browser != null}")
        val payload = gson.toJson(data + ("command" to command))
        val b64 = Base64.getEncoder().encodeToString(payload.toByteArray(Charsets.UTF_8))
        ApplicationManager.getApplication().invokeLater({
            val b = browser
            if (b == null) {
                log.warn("postToWebview: browser is null, dropping command='$command'")
                return@invokeLater
            }
            log.info("postToWebview: executing JS for command='$command'")
            b.cefBrowser.executeJavaScript(
                "window.dispatchEvent(new CustomEvent('jollimemory', { detail: JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('$b64'), function(c){ return c.charCodeAt(0); }))) }));",
                b.cefBrowser.url ?: "",
                0,
            )
        }, ModalityState.any())
    }

    /**
     * Grows/shrinks the dialog so the webview's real content sits inside without inner scrollbars.
     * Called for each `shareResize` message (JS ResizeObserver + explicit pane-swap reports).
     *
     * Bypasses `pack()` (which was unreliable inside DialogWrapper's layout) by computing the
     * dialog chrome overhead (`window.size - browser.component.size`) after the initial layout,
     * then adding the reported content size to it.
     *
     * IMPORTANT: The dialog's top-left corner is kept fixed and never re-centered. Reason: a
     * user's mouse-down opens a dropdown → body grows → this method fires → if we recenter, the
     * dialog jumps up between mouse-down and mouse-up, so the mouse-up "click" lands on empty
     * body (not the input) and bubbles to `document`, closing the dropdown they just opened.
     * Only when the new bottom would fall off-screen do we shift the whole dialog upward.
     */
    private fun handleResize(contentWidth: Int, contentHeight: Int) {
        ApplicationManager.getApplication().invokeLater({
            val b = browser ?: return@invokeLater
            val comp = b.component
            val window = SwingUtilities.getWindowAncestor(comp) ?: return@invokeLater
            val chromeW = window.width - comp.width
            val chromeH = window.height - comp.height
            if (comp.width <= 0 || comp.height <= 0) {
                log.info("handleResize: dialog not laid out yet (comp=${comp.width}x${comp.height}); skipping")
                return@invokeLater
            }
            val screen = comp.graphicsConfiguration?.bounds
            val screenX = screen?.x ?: 0
            val screenY = screen?.y ?: 0
            val screenW = screen?.width ?: 1600
            val screenH = screen?.height ?: 1000
            val maxW = (screenW * 0.9).toInt() - chromeW
            val maxH = (screenH * 0.9).toInt() - chromeH
            val w = contentWidth.coerceIn(360, maxW.coerceAtLeast(360))
            val h = contentHeight.coerceIn(180, maxH.coerceAtLeast(180))
            val targetW = w + chromeW
            val targetH = h + chromeH
            if (window.width == targetW && window.height == targetH) return@invokeLater
            log.info(
                "handleResize: content=${contentWidth}x${contentHeight} chrome=${chromeW}x${chromeH} " +
                    "window=${window.width}x${window.height} -> ${targetW}x${targetH}"
            )
            comp.preferredSize = Dimension(w, h)
            window.setSize(targetW, targetH)
            // Keep the top-left corner where it was (see doc above). Only shift the dialog up
            // when the new bottom would fall off the screen.
            val currentX = window.x
            val currentY = window.y
            val screenBottom = screenY + screenH
            val margin = 20
            val overflow = (currentY + targetH) - (screenBottom - margin)
            if (overflow > 0) {
                val newY = (currentY - overflow).coerceAtLeast(screenY + margin)
                window.location = Point(currentX, newY)
            }
        }, ModalityState.any())
    }

    private fun notify(message: String, type: NotificationType) {
        ApplicationManager.getApplication().invokeLater({
            NotificationGroupManager.getInstance().getNotificationGroup("JolliMemory")
                .createNotification("Jolli Share", message, type).notify(project)
        }, ModalityState.any())
    }

    override fun dispose() {
        jsQuery?.dispose()
        browser?.dispose()
        super.dispose()
    }
}

/**
 * Builds a single-slot share context via [ShareContextFactory] (off the EDT) and shows the
 * webview [ShareWebviewDialog]. Sidebar Share → branch; Commits row Share → commit.
 */
object ShareLauncher {

    fun openForCommit(project: Project, summary: CommitSummary) =
        open(project, summary.branch, summary.commitMessage, summary.commitHash, summary)

    fun openForBranch(project: Project, branch: String) =
        open(project, branch, branch, null, null)

    private fun open(
        project: Project,
        branch: String,
        subjectTitle: String,
        commitHash: String?,
        commitSummary: CommitSummary?,
    ) {
        ApplicationManager.getApplication().executeOnPooledThread {
            TraceContext.withTrace {
                val ctx = ShareContextFactory.build(project, branch, subjectTitle, commitHash, commitSummary)
                ApplicationManager.getApplication().invokeLater { ShareWebviewDialog(project, ctx).show() }
            }
        }
    }
}

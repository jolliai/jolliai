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
import java.awt.Dimension
import java.util.Base64
import javax.swing.Action
import javax.swing.JComponent

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
            b.component.apply { preferredSize = Dimension(460, 470) }
        } catch (e: Exception) {
            log.info("JCEF unavailable for share dialog: ${e.message}")
            JBLabel("Share is unavailable — the JCEF runtime could not start.")
        }
    }

    override fun createActions(): Array<Action> = arrayOf(cancelAction.also { it.putValue(Action.NAME, "Close") })

    // ── Webview → host ─────────────────────────────────────────────────────────

    private fun dispatch(json: JsonObject) {
        val command = json.get("command")?.asString ?: return
        if (command == "shareCloseDialog") {
            ApplicationManager.getApplication().invokeLater { close(OK_EXIT_CODE) }
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
        val payload = gson.toJson(data + ("command" to command))
        val b64 = Base64.getEncoder().encodeToString(payload.toByteArray(Charsets.UTF_8))
        ApplicationManager.getApplication().invokeLater {
            val b = browser ?: return@invokeLater
            b.cefBrowser.executeJavaScript(
                "window.dispatchEvent(new CustomEvent('jollimemory', { detail: JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('$b64'), function(c){ return c.charCodeAt(0); }))) }));",
                b.cefBrowser.url ?: "",
                0,
            )
        }
    }

    private fun notify(message: String, type: NotificationType) {
        ApplicationManager.getApplication().invokeLater {
            NotificationGroupManager.getInstance().getNotificationGroup("JolliMemory")
                .createNotification("Jolli Share", message, type).notify(project)
        }
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

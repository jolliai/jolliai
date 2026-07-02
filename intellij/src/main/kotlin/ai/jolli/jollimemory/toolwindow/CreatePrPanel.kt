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
import ai.jolli.jollimemory.toolwindow.views.CreatePrData
import ai.jolli.jollimemory.toolwindow.views.CreatePrHtmlBuilder
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
import com.intellij.ui.jcef.JBCefBrowserBase
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

    private var browser: JBCefBrowser? = null
    private var jsQuery: JBCefJSQuery? = null
    private var bridgeScript: String = ""
    private val gson = Gson()
    private val store: SummaryStore
    private val cwd: String

    init {
        val service = project.getService(JolliMemoryService::class.java)
        cwd = service?.mainRepoRoot ?: project.basePath ?: ""
        val git = service?.getGitOps() ?: GitOps(cwd)
        store = SummaryStore(cwd, git, StorageFactory.create(git, cwd))
        add(createContent(), BorderLayout.CENTER)
    }

    private fun createContent(): JComponent {
        return try {
            val b = JBCefBrowser()
            browser = b
            val query = JBCefJSQuery.create(b as JBCefBrowserBase)
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
            b.loadHTML(CreatePrHtmlBuilder.buildHtml(vm, !JBColor.isBright(), bridgeScript))
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
        jsQuery?.dispose()
        browser?.dispose()
    }

    private fun postToWebview(command: String, data: Map<String, Any?> = emptyMap()) {
        val payload = gson.toJson(data + ("command" to command))
        val b64 = java.util.Base64.getEncoder().encodeToString(payload.toByteArray(Charsets.UTF_8))
        browser?.cefBrowser?.executeJavaScript(
            "window.dispatchEvent(new CustomEvent('jollimemory', { detail: JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('$b64'), function(c){ return c.charCodeAt(0); }))) }));",
            browser?.cefBrowser?.url ?: "",
            0,
        )
    }

    private fun refreshHtml() {
        browser?.loadHTML(CreatePrHtmlBuilder.buildHtml(vm, !JBColor.isBright(), bridgeScript))
    }

    private fun dispatchWebviewMessage(json: JsonObject) {
        when (json.get("command")?.asString) {
            "createPr" -> handleCreatePr(json.get("title")?.asString, json.get("body")?.asString)
            "copyBody" -> handleCopyBody()
            "openMemory" -> handleOpenMemory(json.get("hash")?.asString ?: return)
            "openDiff" -> handleOpenDiff(json.get("path")?.asString ?: return)
            "openPr" -> json.get("url")?.asString?.let { BrowserUtil.browse(it) }
            "signIn" -> handleSignIn()
        }
    }

    private fun handleCopyBody() {
        val body = PrService.wrapWithMarkers(vm.bodyMarkdown)
        Toolkit.getDefaultToolkit().systemClipboard.setContents(StringSelection(body), null)
    }

    private fun handleOpenMemory(hash: String) {
        val summary = vm.includedSummaries.firstOrNull { it.commitHash == hash } ?: return
        FileEditorManager.getInstance(project).openFile(SummaryVirtualFile(summary), true)
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
        val body = PrService.wrapWithMarkers(rawBody)

        postToWebview("prCreating", mapOf("text" to "Pushing branch…"))
        ApplicationManager.getApplication().executeOnPooledThread {
            TraceContext.withTrace {
                try {
                    PrService.pushBranch(cwd)
                    val lookup = PrService.findPrForBranch(cwd, vm.branch)
                    val prUrl = if (lookup is PrService.PrLookup.Found) {
                        PrService.updatePr(lookup.pr.number, title, body, cwd)
                        lookup.pr.url
                    } else {
                        PrService.createPr(title, body, cwd)
                    }

                    // One-click share: when signed in, push the included memories to Jolli.
                    val shareMsg = shareIncludedMemoriesIfSignedIn()

                    ApplicationManager.getApplication().invokeLater {
                        postToWebview("prCreated", mapOf("text" to "Pull request ready.$shareMsg"))
                        Messages.showInfoMessage(project, "Pull request ready.\n$prUrl$shareMsg", "Create PR")
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
    private fun shareIncludedMemoriesIfSignedIn(): String {
        val config = SessionTracker.loadConfig(cwd)
        val apiKey = config.jolliApiKey?.takeIf { it.isNotBlank() } ?: return ""
        val resolvedBaseUrl = JolliApiClient.parseJolliApiKey(apiKey)?.u
            ?: ai.jolli.jollimemory.auth.JolliUrlConfig.getJolliUrl()
        if (resolvedBaseUrl.isBlank()) return ""

        postToWebview("prProgress", mapOf("text" to "PR ready — sharing memories to Jolli…"))
        var shared = 0
        var bindingResolved = false
        for (summary in vm.includedSummaries) {
            try {
                JolliShareService.shareSummary(store, summary, cwd, apiKey, resolvedBaseUrl)
                shared++
            } catch (e: JolliApiClient.BindingRequiredError) {
                if (bindingResolved || !resolveBinding(e.repoUrl, resolvedBaseUrl, apiKey)) {
                    LOG.info("Share aborted: binding not resolved")
                    break
                }
                bindingResolved = true
                // Retry this memory now that the repo is bound.
                try {
                    JolliShareService.shareSummary(store, summary, cwd, apiKey, resolvedBaseUrl)
                    shared++
                } catch (e2: Exception) {
                    LOG.warn("Share retry failed for ${summary.commitHash.take(8)}: ${e2.message}")
                }
            } catch (e: JolliApiClient.UnauthorizedError) {
                LOG.warn("Share stopped — key rejected: ${e.message}")
                break
            } catch (e: JolliApiClient.PluginOutdatedError) {
                LOG.warn("Share stopped — plugin outdated: ${e.message}")
                break
            } catch (e: Exception) {
                LOG.warn("Share failed for ${summary.commitHash.take(8)}: ${e.message}")
            }
        }
        return if (shared > 0) " Shared $shared ${if (shared == 1) "memory" else "memories"} to Jolli." else ""
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

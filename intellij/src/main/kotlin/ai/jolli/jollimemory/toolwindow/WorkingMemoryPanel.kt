package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.ActiveSessionAggregator
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.references.SourceId
import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.toolwindow.views.WorkingMemoryHtmlBuilder
import ai.jolli.jollimemory.toolwindow.views.WorkingMemoryHtmlBuilder.WmContext
import ai.jolli.jollimemory.toolwindow.views.WorkingMemoryHtmlBuilder.WmConversation
import ai.jolli.jollimemory.toolwindow.views.WorkingMemoryHtmlBuilder.WmFile
import ai.jolli.jollimemory.toolwindow.views.WorkingMemoryHtmlBuilder.WorkingMemoryView
import com.google.gson.JsonParser
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
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
import java.io.File
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JTextArea
import javax.swing.SwingUtilities

/**
 * JCEF web view presenting the "Working Memory" — the full memory the next commit
 * will save (branch, change stats, proposed title, tokens, conversations, context,
 * files), with a Commit Memory button that bridges back to run the AI commit.
 * Mirrors [SummaryPanel]'s JCEF + JS↔Java bridge pattern.
 */
class WorkingMemoryPanel(private val project: Project) : JPanel(BorderLayout()) {

    private val service = project.getService(JolliMemoryService::class.java)
    private val cwd: String = service?.mainRepoRoot ?: project.basePath ?: ""
    private var browser: JBCefBrowser? = null
    private var jsQuery: JBCefJSQuery? = null
    private val statusListener: () -> Unit = { reload() }

    init {
        add(createContent(), BorderLayout.CENTER)
        service?.addStatusListener(statusListener)
    }

    private fun createContent(): JComponent {
        return try {
            val b = JBCefBrowser()
            browser = b

            val query = JBCefJSQuery.create(b as JBCefBrowserBase)
            jsQuery = query
            query.addHandler { request ->
                try {
                    val json = JsonParser.parseString(request).asJsonObject
                    if (json.get("command")?.asString == "commitMemory") {
                        SwingUtilities.invokeLater { runCommit() }
                    }
                } catch (e: Exception) {
                    LOG.warn("Failed to parse working-memory message: ${e.message}")
                }
                JBCefJSQuery.Response("ok")
            }

            // External links open in the system browser, not inside the panel.
            b.jbCefClient.addRequestHandler(object : CefRequestHandlerAdapter() {
                override fun onBeforeBrowse(
                    browser: CefBrowser?, frame: CefFrame?, request: CefRequest?,
                    userGesture: Boolean, isRedirect: Boolean,
                ): Boolean {
                    val url = request?.url ?: return false
                    if (url.startsWith("http://") || url.startsWith("https://")) {
                        BrowserUtil.browse(url)
                        return true
                    }
                    return false
                }
            }, b.cefBrowser)

            b.loadHTML(buildHtml())
            b.component
        } catch (e: Exception) {
            LOG.info("JCEF unavailable for Working Memory: ${e.message}")
            JBScrollPane(JTextArea("Working Memory preview requires the embedded browser.").apply {
                isEditable = false
                font = Font("Monospaced", Font.PLAIN, 13)
            })
        }
    }

    private val bridgeScript: String
        get() = "window.__jbQuery = function(msg) { ${jsQuery?.inject("msg") ?: ""} };"

    private fun buildHtml(): String {
        val isDark = !JBColor.isBright()
        return WorkingMemoryHtmlBuilder.buildHtml(gatherView(), isDark, bridgeScript)
    }

    private fun reload() {
        val b = browser ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            val html = buildHtml()
            SwingUtilities.invokeLater { b.loadHTML(html) }
        }
    }

    /**
     * Runs the exact same action as the sidebar's Commit button
     * ([JolliMemory.CommitAI], which operates on the project's staged files +
     * panel selections). We build an event with an explicit project DataContext so
     * `e.project` resolves the same way it does from the tool window — invoking via
     * the JCEF panel's own component context would otherwise risk a null project.
     */
    private fun runCommit() {
        val action = ActionManager.getInstance().getAction("JolliMemory.CommitAI") ?: return
        val dataContext = com.intellij.openapi.actionSystem.impl.SimpleDataContext.getProjectContext(project)
        val event = com.intellij.openapi.actionSystem.AnActionEvent.createFromAnAction(
            action, null, "JolliMemoryWorkingMemory", dataContext,
        )
        action.actionPerformed(event)
    }

    // ── Data gathering ────────────────────────────────────────────────────────

    private fun gatherView(): WorkingMemoryView {
        val gitOps = service?.getGitOps()
        val branch = gitOps?.getCurrentBranch() ?: "unknown"

        val (files, ins, del) = diffStats(branch)

        val conversations = try {
            ActiveSessionAggregator.listActiveConversations(cwd).map {
                WmConversation(it.source.name, it.title.ifBlank { "${it.source.name} conversation" }, it.messageCount)
            }
        } catch (_: Exception) {
            emptyList()
        }

        val context = gatherContext(branch)
        val detectedTicket = context.firstOrNull { it.tag == "L" || it.tag == "J" }
            ?.let { Regex("[A-Z]+-\\d+").find(it.title)?.value }
            ?: Regex("[A-Z]+-\\d+").find(branch)?.value

        return WorkingMemoryView(
            branch = branch,
            filesChanged = files,
            insertions = ins,
            deletions = del,
            detectedTicket = detectedTicket,
            // Live sessions don't carry token usage in the plugin; usage is captured
            // when the memory is generated at commit time.
            tokenLabel = "N/A tokens",
            conversations = conversations,
            context = context,
            files = changedFiles(),
        )
    }

    /** +insertions / −deletions / files changed vs HEAD (staged + unstaged). */
    private fun diffStats(@Suppress("UNUSED_PARAMETER") branch: String): Triple<Int, Int, Int> {
        val raw = service?.getGitOps()?.exec("diff", "HEAD", "--shortstat") ?: ""
        val files = Regex("(\\d+) files? changed").find(raw)?.groupValues?.get(1)?.toIntOrNull() ?: 0
        val ins = Regex("(\\d+) insertions?").find(raw)?.groupValues?.get(1)?.toIntOrNull() ?: 0
        val del = Regex("(\\d+) deletions?").find(raw)?.groupValues?.get(1)?.toIntOrNull() ?: 0
        // Fall back to the changed-files count when shortstat is empty (e.g. only untracked).
        val fileCount = if (files > 0) files else changedFiles().size
        return Triple(fileCount, ins, del)
    }

    private fun changedFiles(): List<WmFile> = try {
        service?.getChangedFiles()?.map { fc ->
            val slash = fc.relativePath.lastIndexOf('/')
            val name = if (slash >= 0) fc.relativePath.substring(slash + 1) else fc.relativePath
            val dir = if (slash > 0) fc.relativePath.substring(0, slash) else ""
            WmFile(name, dir, fc.statusCode.take(1).ifBlank { "M" })
        } ?: emptyList()
    } catch (_: Exception) {
        emptyList()
    }

    /** Uncommitted plans + notes on the current branch, plus all references. */
    private fun gatherContext(branch: String): List<WmContext> {
        val out = mutableListOf<WmContext>()
        try {
            val registry = SessionTracker.loadPlansRegistry(cwd)
            registry.plans.values.forEach { p ->
                if (p.ignored == true || p.commitHash != null) return@forEach
                if (!p.branch.isNullOrBlank() && p.branch != branch) return@forEach
                if (!File(p.sourcePath).exists()) return@forEach
                out.add(WmContext("P", p.title))
            }
            registry.notes?.values?.forEach { n ->
                if (n.ignored == true || n.commitHash != null) return@forEach
                if (n.branch.isNotBlank() && n.branch != branch) return@forEach
                out.add(WmContext("N", n.title))
            }
            registry.references?.values?.forEach { r ->
                out.add(WmContext(referenceTag(r.source), r.title))
            }
        } catch (_: Exception) {
            // best-effort
        }
        return out
    }

    private fun referenceTag(source: SourceId): String = when (source) {
        SourceId.linear -> "L"
        SourceId.jira -> "J"
        SourceId.github -> "GH"
        SourceId.notion -> "No"
    }

    fun dispose() {
        service?.removeStatusListener(statusListener)
        jsQuery?.dispose()
        browser?.dispose()
    }

    private companion object {
        val LOG: Logger = Logger.getInstance(WorkingMemoryPanel::class.java)
    }
}

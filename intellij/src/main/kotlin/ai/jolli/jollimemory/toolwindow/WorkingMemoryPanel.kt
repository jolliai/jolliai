package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.ActiveConversationItem
import ai.jolli.jollimemory.core.ActiveSessionAggregator
import ai.jolli.jollimemory.core.CommitSelectionStore
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.SkillsProjection
import ai.jolli.jollimemory.core.StoredSession
import ai.jolli.jollimemory.core.ConversationUsage
import ai.jolli.jollimemory.core.TranscriptMessageCounter
import ai.jolli.jollimemory.core.TranscriptSource
import ai.jolli.jollimemory.core.references.SourceDisplay
import ai.jolli.jollimemory.core.references.SourceId
import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.toolwindow.views.ThemeUtils
import ai.jolli.jollimemory.toolwindow.views.ThemeUtils.toCssHex
import ai.jolli.jollimemory.toolwindow.views.WorkingMemoryHtmlBuilder
import ai.jolli.jollimemory.toolwindow.views.WorkingMemoryHtmlBuilder.WmContext
import ai.jolli.jollimemory.toolwindow.views.WorkingMemoryHtmlBuilder.WmConversation
import ai.jolli.jollimemory.toolwindow.views.WorkingMemoryHtmlBuilder.WmFile
import ai.jolli.jollimemory.toolwindow.views.WorkingMemoryHtmlBuilder.WmTokens
import ai.jolli.jollimemory.toolwindow.views.WorkingMemoryHtmlBuilder.WorkingMemoryView
import com.google.gson.JsonParser
import com.intellij.ide.BrowserUtil
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
        // Live-refresh when the user toggles a conversation / context / file selection
        // in the sidebar while this review is open.
        service?.addSelectionListener(statusListener)
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
                    when (json.get("command")?.asString) {
                        "commitMemory" -> SwingUtilities.invokeLater { runCommit() }
                        "toggleExclude" -> {
                            val kind = json.get("kind")?.asString
                            val key = json.get("key")?.asString
                            val excluded = json.get("excluded")?.asBoolean ?: false
                            if (kind != null && key != null) {
                                // Pooled, NOT the EDT: the store this writes is now reached
                                // over the ide-bridge, so a click costs a daemon round trip
                                // (and a cold spawn's couple of seconds when none is warm).
                                // `handleToggleExclude` touches no Swing directly — every
                                // refresh it triggers re-pools and hops back via
                                // invokeLater itself. Same reasoning as the first load in
                                // createContent(); `commitMemory` stays on the EDT because
                                // it opens dialogs.
                                ApplicationManager.getApplication().executeOnPooledThread {
                                    handleToggleExclude(kind, key, excluded)
                                }
                            }
                        }
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

            // Theme the native Chromium view before the first load so the initial
            // about:blank → content navigation never flashes white.
            val wmBg = ThemeUtils.editorBackground()
            b.component.isOpaque = true
            b.component.background = wmBg
            b.setPageBackgroundColor(wmBg.toCssHex())
            // First load goes through the same pooled thread as reload(): createContent()
            // runs from init on the EDT, and buildHtml → gatherView makes several
            // ide-bridge round trips (active conversations, exclusions, active skills).
            // Doing them inline froze the EDT for as long as the daemon took to answer —
            // up to a cold spawn's couple of seconds. The themed background above is what
            // makes the brief pre-content moment invisible rather than a white flash.
            ApplicationManager.getApplication().executeOnPooledThread {
                val html = buildHtml()
                SwingUtilities.invokeLater { b.loadHTML(html) }
            }
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
        ai.jolli.jollimemory.core.JmLogger.create("WorkingMemoryPanel")
            .info("runCommit: webview Commit Memory clicked")
        // Call the commit logic directly with our explicit project — the JCEF panel's
        // own data context doesn't reliably carry the project, and the action-invocation
        // API (ActionUtil.invokeAction) is deprecated inconsistently across IDE versions.
        // Re-entrancy is handled inside performCommit (shared commitInProgress guard).
        ai.jolli.jollimemory.actions.CommitAIAction().performCommit(project)
    }

    // ── Data gathering ────────────────────────────────────────────────────────

    private fun gatherView(): WorkingMemoryView {
        val gitOps = service?.getGitOps()
        val branch = gitOps?.getCurrentBranch() ?: "unknown"

        // Insertions/deletions reflect the whole working-tree change; the file *count*
        // tracks the selected files below so it agrees with the Files section.
        val (_, ins, del) = diffStats(branch)
        val selectedFiles = changedFiles()

        // The review must show exactly what the next commit will save, so honor the
        // same sidebar exclusions the PostCommitHook applies (conversations unchecked
        // in the CONVERSATIONS list, plans/notes/references unchecked in CONTEXT).
        val exclusions = try {
            CommitSelectionStore.readExclusions(cwd)
        } catch (_: Exception) {
            CommitSelectionStore.CommitExclusions()
        }

        // Show ALL active conversations, not just the included ones: excluded rows stay
        // visible (struck through) with a + to add them back — the mockup's inline
        // "leave out / add back" editing. `excluded` drives the ✕/+ toggle state.
        val rawConversations = try {
            ActiveSessionAggregator.listActiveConversations(cwd)
        } catch (e: Exception) {
            // No warning banner in this panel — at least record the transport
            // failure so a silent empty list can be traced when users report it.
            LOG.warn("listActiveConversations failed, panel will show empty: ${e.message}")
            emptyList()
        }
        val conversations = rawConversations.map {
            val key = CommitSelectionStore.conversationKey(it.source, it.sessionId)
            WmConversation(
                source = it.source.name,
                title = it.title.ifBlank { "${it.source.name} conversation" },
                messageCount = it.messageCount,
                key = key,
                excluded = key in exclusions.conversations,
            )
        }

        val context = gatherContext(exclusions)
        val detectedTicket = context.firstOrNull { it.tag == "L" || it.tag == "J" }
            ?.let { Regex("[A-Z]+-\\d+").find(it.title)?.value }
            ?: Regex("[A-Z]+-\\d+").find(branch)?.value

        // Token usage is aggregated from the INCLUDED conversations' transcripts (the
        // ones that will actually enter the memory), so unchecking a conversation drops
        // its tokens from the meter too.
        val includedConversations = rawConversations.filter {
            CommitSelectionStore.conversationKey(it.source, it.sessionId) !in exclusions.conversations
        }

        return WorkingMemoryView(
            branch = branch,
            filesChanged = selectedFiles.size,
            insertions = ins,
            deletions = del,
            detectedTicket = detectedTicket,
            proposedTitle = buildProposedTitle(branch, detectedTicket),
            token = computeTokens(includedConversations),
            conversations = conversations,
            context = context,
            files = selectedFiles,
        )
    }

    /**
     * Aggregates AI coding-session token usage from the included conversations'
     * transcripts. Only JSONL sources that emit per-message `usage` (Claude, Codex,
     * Gemini) are read; others count toward the session total but not the reported
     * count, so [TokenUsage.partial] flags an understated meter. Returns null when no
     * included source reported usage — the meter then shows its "recorded at commit"
     * state instead of a misleading zero. Runs on the caller's pooled thread.
     */
    private fun computeTokens(included: List<ActiveConversationItem>): WmTokens? {
        if (included.isEmpty()) return null
        val usageSources = setOf(TranscriptSource.claude, TranscriptSource.codex, TranscriptSource.gemini)
        val sessions = included.map { c ->
            val entries = if (c.source in usageSources) {
                try {
                    TranscriptMessageCounter.loadTranscript(c.source, c.transcriptPath, cwd)
                } catch (_: Exception) {
                    emptyList()
                }
            } else {
                emptyList()
            }
            StoredSession(c.sessionId, c.source, c.transcriptPath, entries)
        }
        val usage = ConversationUsage.aggregate(sessions) ?: return null
        // Partial when an included conversation contributed no usage (a source that
        // doesn't report it, or a read that yielded none) — the total understates reality.
        val reported = sessions.count { s -> s.entries.any { it.usage != null } }
        return WmTokens(
            total = usage.conversationTokens.toLong(),
            input = usage.breakdown.input,
            output = usage.breakdown.output,
            cached = usage.breakdown.cached,
            partial = reported < included.size,
            estimatedCostUsd = usage.estimatedCostUsd,
        )
    }

    /**
     * Flips a working-memory item's commit-selection exclusion, then refreshes.
     *
     * Must be called OFF the EDT — every branch below makes at least one ide-bridge
     * round trip. It touches no Swing itself, so that is safe: `reload()` and both
     * panel `refresh()`es re-pool and hop back through `invokeLater` on their own.
     */
    private fun handleToggleExclude(kind: String, key: String, excluded: Boolean) {
        try {
            if (kind == "skills") {
                // The aggregate row carries no key, so the keys come from the registry.
                // All of them in one write: the row has no per-skill affordance, so
                // leaving any behind would strand it in a state the user cannot see.
                val keys = SkillsProjection.readActive(cwd).exclusionKeys
                // Empty is never a legitimate "nothing to do" here — this row is only
                // drawn when skills were captured. It means either the read failed
                // (`readActive` degrades to empty instead of throwing, so the catch
                // below cannot see it) or a commit in another window archived them
                // between render and click. Either way `setAllExcluded` would rewrite
                // the file unchanged and report ok, so the click would disappear with
                // nothing in the log to explain it. Skip the pointless write but still
                // fall through to the refresh, which resyncs the checkbox or drops the
                // stale row.
                if (keys.isEmpty()) {
                    LOG.warn("toggleExclude skills: no active skills resolved; leaving selection unchanged")
                } else {
                    CommitSelectionStore.setAllExcluded(cwd, kind, keys, excluded)
                }
            } else {
                CommitSelectionStore.setExcluded(cwd, kind, key, excluded)
            }
        } catch (e: Exception) {
            LOG.warn("toggleExclude failed: ${e.message}")
            return
        }
        val svc = service
        if (svc == null) {
            reload()
            return
        }
        // notifySelectionChanged wakes this review (our selectionListener → reload) and
        // any other open review. The sidebar panels listen on the *status* channel, not
        // selection, so refresh the ones that mirror this state directly — otherwise a
        // remove/add here wouldn't update the sidebar's checkboxes (and both must agree,
        // since the commit reads the same CommitSelectionStore they all write to).
        svc.notifySelectionChanged()
        svc.panelRegistry?.let { reg ->
            when (kind) {
                "conversations" -> reg.activeConversationsPanel?.refresh()
                // plans / notes / references / skills all live in the CONTEXT (Plans) panel
                else -> reg.plansPanel?.refresh()
            }
        }
    }

    /**
     * Heuristic preview of the next commit's title, shown before the AI writes the
     * real one at commit time. Combines any detected ticket with a humanized branch
     * name (drop the `feature/`-style prefix and a leading ticket token, turn
     * separators into spaces). Returns null when there's no useful signal (e.g. an
     * unknown/empty branch), so the view falls back to its explanatory placeholder.
     */
    private fun buildProposedTitle(branch: String, ticket: String?): String? {
        if (branch.isBlank() || branch == "unknown") return ticket
        val humanized = branch.substringAfterLast('/')
            .replace(Regex("^[A-Za-z]+-\\d+[-_]?"), "") // strip a leading ticket token (jolli-1785-…)
            .replace(Regex("[-_]+"), " ")
            .trim()
        return when {
            ticket != null && humanized.isNotBlank() -> "$ticket — $humanized"
            ticket != null -> ticket
            humanized.isNotBlank() -> humanized.replaceFirstChar { it.uppercase() }
            else -> null
        }
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

    /**
     * Files the next commit will include. Prefers the Changes panel's live selection
     * (the same set [JolliMemory.CommitAI] commits) so unchecking a file in the sidebar
     * removes it here too; falls back to all changed files when the panel isn't mounted.
     */
    private fun changedFiles(): List<WmFile> = try {
        val source = service?.panelRegistry?.changesPanel?.getSelectedFiles()
            ?: service?.getChangedFiles()
            ?: emptyList()
        source.map { fc ->
            val slash = fc.relativePath.lastIndexOf('/')
            val name = if (slash >= 0) fc.relativePath.substring(slash + 1) else fc.relativePath
            val dir = if (slash > 0) fc.relativePath.substring(0, slash) else ""
            WmFile(name, dir, fc.statusCode.take(1).ifBlank { "M" })
        }
    } catch (_: Exception) {
        emptyList()
    }

    /**
     * Uncommitted plans + notes on the current branch, plus all references —
     * minus anything the user unchecked in the CONTEXT list (same exclusion keys
     * the CONTEXT panel and PostCommitHook use: plan slug, note id, reference map key).
     */
    private fun gatherContext(exclusions: CommitSelectionStore.CommitExclusions): List<WmContext> {
        val out = mutableListOf<WmContext>()
        try {
            val registry = SessionTracker.loadPlansRegistry(cwd)
            // No branch filter on any kind: uncommitted working-area items follow the
            // user across branches (matches CLI/VS Code). `branch` is stamped but not
            // filtered on; only committed memory is branch-tagged.
            // Excluded items stay listed (struck through, with a + to add back), so
            // only committed/ignored ones are dropped. `excluded` drives the toggle.
            registry.plans.values.forEach { p ->
                if (p.ignored == true || p.commitHash != null) return@forEach
                if (!File(p.sourcePath).exists()) return@forEach
                out.add(WmContext("P", p.title, "plans", p.slug, p.slug in exclusions.plans))
            }
            registry.notes?.values?.forEach { n ->
                if (n.ignored == true || n.commitHash != null) return@forEach
                out.add(WmContext("N", n.title, "notes", n.id, n.id in exclusions.notes))
            }
            registry.references?.forEach { (mapKey, r) ->
                out.add(WmContext(referenceTag(r.source), r.title, "references", mapKey, mapKey in exclusions.references))
            }
            // ONE aggregate row for every captured skill, matching the sidebar CONTEXT
            // list and VS Code. Not read off `registry.skills`: a skill row survives
            // archival (guarded, not deleted, so a re-entry is still detectable), so the
            // raw map would list every skill ever used as if it were pending. The CLI
            // decides which are still uncommitted and reports the delta.
            //
            // The key is empty — see [WmContext]. It reads as excluded only when EVERY
            // captured skill is, so a partial set shows as included and the next click
            // excludes the remainder.
            val skills = SkillsProjection.readActive(cwd)
            if (!skills.isEmpty) {
                val allExcluded = skills.exclusionKeys.all { it in exclusions.skills }
                out.add(WmContext("S", skills.summaryLabel, "skills", "", allExcluded))
            }
        } catch (_: Exception) {
            // best-effort
        }
        return out
    }

    private fun referenceTag(source: SourceId?): String = SourceDisplay.of(source).tag

    fun dispose() {
        service?.removeStatusListener(statusListener)
        service?.removeSelectionListener(statusListener)
        jsQuery?.dispose()
        browser?.dispose()
    }

    private companion object {
        val LOG: Logger = Logger.getInstance(WorkingMemoryPanel::class.java)
    }
}

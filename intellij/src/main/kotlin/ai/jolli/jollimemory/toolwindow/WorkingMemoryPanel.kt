package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.ActiveConversationItem
import ai.jolli.jollimemory.core.ActiveSessionAggregator
import ai.jolli.jollimemory.core.CommitSelectionStore
import ai.jolli.jollimemory.core.FileDiscarder
import ai.jolli.jollimemory.core.GitStatusCodes
import ai.jolli.jollimemory.core.SkillsProjection
import ai.jolli.jollimemory.core.StoredSession
import ai.jolli.jollimemory.core.UnsavedEdits
import ai.jolli.jollimemory.core.ConversationUsage
import ai.jolli.jollimemory.core.TranscriptMessageCounter
import ai.jolli.jollimemory.core.TranscriptSource
import ai.jolli.jollimemory.core.WorkingContext
import ai.jolli.jollimemory.core.WorktreeRoot
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
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
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
        // …and when the context itself moves. `gatherContext` reads `activeForCommit`,
        // so a plan or reference landing mid-session changes what this review claims
        // the next commit will archive — without touching status.
        service?.addWorkingContextListener(statusListener)
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
                        "discardFile" -> {
                            val relativePath = json.get("relativePath")?.asString
                            val statusCode = json.get("statusCode")?.asString ?: ""
                            // EDT like `commitMemory`, and for the same reason: the
                            // first thing this does is raise a confirmation dialog.
                            // The git work behind it pools itself.
                            if (!relativePath.isNullOrBlank()) {
                                SwingUtilities.invokeLater { handleDiscardFile(relativePath, statusCode) }
                            }
                        }
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

        // ONE bridge round-trip for the whole review: what the next commit would
        // claim AND the exclude set that decides which of it is struck through.
        // This used to be three (`active-for-commit`, `selection-read`, and a raw
        // `plans-load` purely to label the reference rows) — affordable when the
        // panel only reloaded on demand, not now that it repaints whenever a plan
        // file is saved anywhere on the machine.
        //
        // The review must show exactly what the next commit will save, so it honors
        // the same sidebar exclusions the PostCommitHook applies (conversations
        // unchecked in the CONVERSATIONS list, plans/notes/references in CONTEXT).
        // KNOWN GAP, deliberately not addressed in this change — not a review finding.
        //
        // An empty fallback makes a transport hiccup read as "this memory will capture
        // nothing", and this is now one bridge round-trip where it used to be local
        // file reads, so the failure is likelier than it was. [PlansPanel] solves its
        // version of this by keeping the last rendered rows, but that answer is WRONG
        // here: this is a pre-commit review, so stale rows would tell the user a plan
        // is included moments before they commit without it. Neither empty nor stale is
        // honest — the panel needs a third, explicit "context unavailable" state, the
        // way [ActiveConversationsPanel] marks failed sources rather than hiding them.
        //
        // That is new user-facing copy and a new render branch, i.e. a UI decision
        // rather than a bug fix, so it is scoped out of this change on purpose. Until
        // it lands, empty-and-logged is the lesser evil: it under-claims what the
        // memory will hold instead of over-claiming it.
        val active = try {
            WorkingContext.activeForCommit(cwd)
        } catch (e: Exception) {
            LOG.warn("activeForCommit failed, review will show no context: ${e.message}")
            WorkingContext.ActiveForCommit()
        }
        val exclusions = active.exclusions

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
            val sourceName = it.source?.name ?: "unknown"
            WmConversation(
                source = sourceName,
                title = it.title.ifBlank { "$sourceName conversation" },
                messageCount = it.messageCount,
                key = key,
                excluded = key in exclusions.conversations,
            )
        }

        val context = gatherContext(active)
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
            val source = c.source
            val entries = if (source != null && source in usageSources) {
                try {
                    TranscriptMessageCounter.loadTranscript(source, c.transcriptPath, cwd)
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
     * round trip (the CLI owns commit-selection.json and its lock), so even the
     * daemon's ~5-20 ms would stall the EDT and a cold one-shot spawn far worse. The
     * caller pools; this touches no Swing itself and hands the refresh back to the EDT
     * through [afterToggleExclude].
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
        SwingUtilities.invokeLater { afterToggleExclude(kind) }
    }

    /**
     * Reverts one file's working-tree changes from the review's Files row — the same
     * action the sidebar's FILES row offers, and the same pairing VS Code's Next
     * Memory panel shows. Confirms first (this is not undoable), then hands the git
     * work to [FileDiscarder] on a pooled thread and refreshes both surfaces.
     *
     * Must be called ON the EDT: it opens a modal dialog.
     *
     * The verb is a CLI answer, so the dialog opens from a pooled-thread callback
     * rather than immediately. [statusCode] is one collapsed letter and cannot
     * separate a staged deletion (restored) from a conflict with no HEAD version
     * (removed) — see [FileDiscarder.preview]. It survives only as the fallback.
     */
    private fun handleDiscardFile(relativePath: String, statusCode: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val previewRoot = WorktreeRoot.of(project)
            val deletes = try {
                previewRoot != null && relativePath in FileDiscarder.preview(previewRoot, listOf(relativePath))
            } catch (e: Exception) {
                LOG.warn("discard preview failed, wording from status code: ${e.message}")
                GitStatusCodes.discardDeletesFile(statusCode)
            }
            SwingUtilities.invokeLater { confirmAndDiscardFile(relativePath, deletes) }
        }
    }

    /**
     * Shows the confirmation for [relativePath] and, if accepted, runs the discard.
     * [deletesFile] decides the verb only. Must be called ON the EDT.
     */
    private fun confirmAndDiscardFile(relativePath: String, deletesFile: Boolean) {
        val verb = if (deletesFile) "delete" else "discard changes to"
        val confirmed = Messages.showYesNoDialog(
            project,
            "Are you sure you want to $verb \"$relativePath\"?\n\nThis action cannot be undone.",
            "Discard Changes",
            Messages.getWarningIcon(),
        )
        if (confirmed != Messages.YES) return

        // Still on the EDT, and before any git runs — same reason as the sidebar's
        // FILES row: this list can show a file whose edits exist only in the
        // editor's document, which `git status` cannot see, so without the flush
        // the discard comes back `not-found` + ok:true and nothing happens. See
        // [UnsavedEdits].
        WorktreeRoot.of(project)?.let { editorRoot ->
            UnsavedEdits.flush(editorRoot, listOf(relativePath))
        }

        ApplicationManager.getApplication().executeOnPooledThread {
            // No repo root is a failure like any other, not a quiet return: the user
            // already confirmed a destructive action, so nothing happening without a
            // word is the exact symptom this whole path exists to remove.
            val repoRoot = WorktreeRoot.of(project)
            if (repoRoot == null) {
                SwingUtilities.invokeLater {
                    Messages.showErrorDialog(
                        project,
                        "Could not discard \"$relativePath\".\n\nNo repository root is available for this project.",
                        "Discard Changes Failed",
                    )
                }
                return@executeOnPooledThread
            }
            // Branch on the OUTCOME, not on its message: `error` is nullable on the
            // wire, so an empty-string test drops any failure that arrives without
            // one and puts the silent success straight back.
            var touched = listOf(relativePath)
            val failure: String? = try {
                val outcomes = FileDiscarder.discard(repoRoot, listOf(relativePath))
                touched = outcomes.flatMap { it.touchedPaths }.distinct()
                outcomes.firstOrNull { !it.ok }?.let { it.error ?: "unknown error" }
            } catch (e: Exception) {
                LOG.warn("discardFile failed: ${e.message}")
                e.message ?: e.javaClass.simpleName
            }
            // The CLI touched these files behind IntelliJ's back, so the VFS still
            // holds the old state; refresh before anything re-reads the working tree.
            // A rename revert also restores its original path — refreshing only the
            // clicked path leaves that file invisible to the IDE.
            LocalFileSystem.getInstance()
                .refreshIoFiles(touched.map { File(repoRoot, it) }, false, true, null)
            SwingUtilities.invokeLater {
                // Never silent: a discard that did not happen has to say why, or it
                // is indistinguishable from one that worked.
                if (failure != null) {
                    Messages.showErrorDialog(
                        project,
                        "Could not discard \"$relativePath\".\n\n$failure",
                        "Discard Changes Failed",
                    )
                }
                // The sidebar's FILES list reads git directly, so it needs its own
                // nudge; this review reloads off the same refresh.
                service?.panelRegistry?.changesPanel?.refresh()
                reload()
            }
        }
    }

    private fun afterToggleExclude(kind: String) {
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
            // Untracked shows as "U" (VS Code's convention and the sidebar's), not as
            // the raw "?" our producers emit — otherwise the row carries an
            // unexplained glyph with no matching .wm-gs colour rule. The row's Discard
            // still needs the untranslated code to pick the right git path, so both
            // travel — see WmFile.
            val display = if (GitStatusCodes.isUntracked(fc.statusCode)) {
                "U"
            } else {
                fc.statusCode.take(1).ifBlank { "M" }
            }
            WmFile(name, dir, display, fc.relativePath, fc.statusCode)
        }
    } catch (_: Exception) {
        emptyList()
    }

    /**
     * Rows for the CONTEXT section of the review, built from the already-fetched
     * [WorkingContext.ActiveForCommit] — minus nothing: anything the user unchecked
     * stays listed and struck through (same exclusion keys the CONTEXT panel and
     * PostCommitHook use: plan slug, note id, reference map key).
     *
     * Takes the payload rather than fetching it so the whole review is one
     * round-trip; see [gatherView].
     */
    private fun gatherContext(active: WorkingContext.ActiveForCommit): List<WmContext> {
        val exclusions = active.exclusions
        val out = mutableListOf<WmContext>()
        try {
            // The CLI decides what the next commit would claim — this is the
            // archive-selection set, deliberately narrower than the CONTEXT panel's
            // browsable list, and it already drops plans and notes whose source file
            // is gone (the archive loops cannot read content they do not have). Do
            // NOT re-filter here: this list used to carry its own
            // `File(sourcePath).exists()` check, which is a CLI rule restated in
            // Kotlin and would go stale the moment the worker's skip condition
            // changed. It applies no branch filter either — uncommitted working-area
            // items follow the user across a checkout and bind to a branch only at
            // commit. Excluded items stay listed (struck through, with a + to add
            // back), so `excluded` drives the toggle rather than dropping the row.
            active.plans.forEach { p ->
                out.add(WmContext("P", p.title, "plans", p.slug, p.slug in exclusions.plans))
            }
            active.notes.forEach { n ->
                out.add(WmContext("N", n.title, "notes", n.id, n.id in exclusions.notes))
            }
            // Title comes from the payload — the CLI reads it off the same registry
            // row it derived the mapKey from. This used to be a second `plans-load`
            // here purely to label these rows, i.e. a host-side title rule.
            active.references.forEach { r ->
                val title = r.title ?: r.mapKey
                out.add(WmContext(referenceTag(r.source), title, "references", r.mapKey, r.mapKey in exclusions.references))
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
        service?.removeWorkingContextListener(statusListener)
        jsQuery?.dispose()
        browser?.dispose()
    }

    private companion object {
        val LOG: Logger = Logger.getInstance(WorkingMemoryPanel::class.java)
    }
}

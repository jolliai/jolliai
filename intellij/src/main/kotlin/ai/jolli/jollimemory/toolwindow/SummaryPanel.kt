package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.E2eTestScenario
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.StoredSession
import ai.jolli.jollimemory.core.StoredTranscript
import ai.jolli.jollimemory.core.Summarizer
import ai.jolli.jollimemory.core.SummaryStore
import ai.jolli.jollimemory.core.SummaryTree
import ai.jolli.jollimemory.core.TopicUpdates
import ai.jolli.jollimemory.core.TranscriptEntry
import ai.jolli.jollimemory.services.JolliApiClient
import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.services.PlanService
import ai.jolli.jollimemory.services.PrService
import ai.jolli.jollimemory.toolwindow.views.SummaryHtmlBuilder
import ai.jolli.jollimemory.toolwindow.views.SummaryMarkdownBuilder
import ai.jolli.jollimemory.toolwindow.views.SummaryPrMarkdownBuilder
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils
import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.ide.BrowserUtil
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.network.CefRequest
import java.awt.Dimension
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
) : JPanel(BorderLayout()) {

    @Volatile
    var currentSummary: CommitSummary = summary
        private set

    private var browser: JBCefBrowser? = null
    private var jsQuery: JBCefJSQuery? = null
    private var bridgeScript: String = ""
    private val gson = Gson()
    private val store: SummaryStore
    private val transcriptHashSet = mutableSetOf<String>()
    private val planTranslateSet = mutableSetOf<String>()
    private val cwd: String

    init {
        val service = project.getService(JolliMemoryService::class.java)
        cwd = service?.mainRepoRoot ?: project.basePath ?: ""
        val gitOps = service?.getGitOps()
        store = if (gitOps != null) SummaryStore(cwd, gitOps) else SummaryStore(cwd, GitOps(cwd))
        refreshTranscriptHashes()
        refreshPlanTranslateSet()
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
                        return true // cancel in-panel navigation
                    }
                    return false
                }
            }, b.cefBrowser)

            val isDark = !JBColor.isBright()
            val html = SummaryHtmlBuilder.buildHtml(currentSummary, isDark, transcriptHashSet, planTranslateSet, bridgeScript)
            b.loadHTML(html)
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
        jsQuery?.dispose()
        browser?.dispose()
    }

    // ── Webview bridge ──────────────────────────────────────────────────────

    private fun postToWebview(command: String, data: Map<String, Any?> = emptyMap()) {
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

    private fun refreshHtml() {
        val isDark = !JBColor.isBright()
        val html = SummaryHtmlBuilder.buildHtml(currentSummary, isDark, transcriptHashSet, planTranslateSet, bridgeScript)
        browser?.loadHTML(html)
    }

    private fun refreshTranscriptHashes() {
        transcriptHashSet.clear()
        try {
            val allHashes = collectTreeHashes(currentSummary)
            val onBranch = store.getTranscriptHashes()
            transcriptHashSet.addAll(allHashes.intersect(onBranch))
            LOG.info("refreshTranscriptHashes: tree=${allHashes.size}, onBranch=${onBranch.size}, matched=${transcriptHashSet.size}")
        } catch (e: Exception) {
            LOG.warn("refreshTranscriptHashes failed: ${e.message}", e)
        }
    }

    private fun refreshPlanTranslateSet() {
        planTranslateSet.clear()
        val cjkPattern = Regex("[\\u4E00-\\u9FFF\\u3400-\\u4DBF\\uF900-\\uFAFF]")
        val plans = SummaryUtils.collectAllPlans(currentSummary)
        for (plan in plans) {
            if (cjkPattern.containsMatchIn(plan.title)) {
                planTranslateSet.add(plan.slug)
                continue
            }
            try {
                val content = store.readPlanFromBranch(plan.slug) ?: continue
                if (cjkPattern.containsMatchIn(content)) planTranslateSet.add(plan.slug)
            } catch (_: Exception) { /* skip */ }
        }
    }

    // ── Message dispatcher ──────────────────────────────────────────────────

    private fun dispatchWebviewMessage(json: JsonObject) {
        val command = json.get("command")?.asString ?: return
        try {
            when (command) {
                "copyMarkdown" -> handleCopyMarkdown()
                "pushToJolli" -> handlePushToJolli()
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
                "createPr" -> handleCreatePr(json.get("title").asString, json.get("body").asString)
                "prepareUpdatePr" -> handlePrepareUpdatePr()
                "updatePr" -> handleUpdatePr(json.get("title").asString, json.get("body").asString)
                "loadTranscriptStats" -> handleLoadTranscriptStats()
                "loadAllTranscripts" -> handleLoadAllTranscripts()
                "saveAllTranscripts" -> handleSaveAllTranscripts(json.getAsJsonArray("entries"))
                "deleteAllTranscripts" -> handleDeleteAllTranscripts()
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

    private fun handlePushToJolli() {
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
        val baseUrl = resolvedBaseUrl.trimEnd('/')

        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val planUrls = mutableListOf<PlanPushResult>()

                for (plan in summary.plans ?: emptyList()) {
                    val planContent = store.readPlanFromBranch(plan.slug) ?: continue
                    if (planContent.isBlank()) continue

                    val planResult = JolliApiClient.pushToJolli(resolvedBaseUrl, config.jolliApiKey!!, JolliApiClient.JolliPushPayload(
                        title = SummaryUtils.buildPlanPushTitle(summary, plan.title),
                        content = planContent,
                        commitHash = summary.commitHash,
                        branch = summary.branch,
                        subFolder = "Plans",
                        docId = plan.jolliPlanDocId,
                    ))
                    planUrls.add(PlanPushResult(plan.slug, plan.title, "$baseUrl/articles?doc=${planResult.docId}", planResult.docId))
                }

                var plansWithUrls = summary.plans
                if (planUrls.isNotEmpty() && plansWithUrls != null) {
                    val urlMap = planUrls.associateBy { it.slug }
                    plansWithUrls = plansWithUrls.map { p ->
                        val pushed = urlMap[p.slug]
                        if (pushed != null) p.copy(jolliPlanDocUrl = pushed.url, jolliPlanDocId = pushed.docId) else p
                    }
                }

                val summaryForMarkdown = if (plansWithUrls !== summary.plans) summary.copy(plans = plansWithUrls) else summary
                val markdown = SummaryMarkdownBuilder.buildMarkdown(summaryForMarkdown)
                val pushTitle = SummaryUtils.buildPushTitle(summary)

                val result = JolliApiClient.pushToJolli(resolvedBaseUrl, config.jolliApiKey!!, JolliApiClient.JolliPushPayload(
                    title = pushTitle, content = markdown, commitHash = summary.commitHash,
                    branch = summary.branch, docId = summary.jolliDocId,
                ))

                val fullUrl = "$baseUrl/articles?doc=${result.docId}"
                var updatedPlans = summary.plans
                if (updatedPlans != null && planUrls.isNotEmpty()) {
                    val planResultMap = planUrls.associateBy { it.slug }
                    updatedPlans = updatedPlans.map { p ->
                        val pushResult = planResultMap[p.slug]
                        if (pushResult != null) p.copy(jolliPlanDocUrl = pushResult.url, jolliPlanDocId = pushResult.docId) else p
                    }
                }

                val updatedSummary = summary.copy(jolliDocUrl = fullUrl, jolliDocId = result.docId, plans = updatedPlans)
                store.storeSummary(updatedSummary, force = true)
                currentSummary = updatedSummary

                val cleanedSummary = cleanupOrphanedDocs(summary, updatedSummary, baseUrl, config.jolliApiKey!!)
                if (cleanedSummary != null) currentSummary = cleanedSummary

                ApplicationManager.getApplication().invokeLater {
                    refreshHtml()
                    val verb = if (summary.jolliDocUrl != null) "Updated" else "Pushed"
                    val planMsg = if (planUrls.isNotEmpty()) " (with ${planUrls.size} plan${if (planUrls.size > 1) "s" else ""})" else ""
                    Messages.showInfoMessage(project, "$verb on Jolli Space$planMsg.", "Push Successful")
                }
            } catch (e: JolliApiClient.PluginOutdatedError) {
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("pushFailed")
                    Messages.showErrorDialog(project, "Push failed -- your JolliMemory plugin is outdated. Please update.", "Plugin Outdated")
                }
            } catch (e: Exception) {
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("pushFailed")
                    Messages.showErrorDialog(project, "Push failed: ${e.message}", "Push Error")
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
                val summary = currentSummary
                val config = SessionTracker.loadConfig(cwd)
                val (topics) = SummaryUtils.collectSortedTopics(summary)
                val diff = getDiffForCommit(summary.commitHash)

                val scenarios = Summarizer.generateE2eTest(Summarizer.E2eTestParams(
                    topics = topics.map { it.topic.topic },
                    commitMessage = summary.commitMessage, diff = diff,
                    apiKey = config.apiKey, model = config.model, jolliApiKey = config.jolliApiKey,
                    aiProvider = config.aiProvider,
                ))

                val updatedSummary = summary.copy(e2eTestGuide = scenarios)
                store.storeSummary(updatedSummary, force = true)
                currentSummary = updatedSummary
                val html = SummaryHtmlBuilder.buildE2eTestSection(updatedSummary)
                ApplicationManager.getApplication().invokeLater { postToWebview("e2eTestUpdated", mapOf("html" to html)) }
            } catch (e: Exception) {
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("e2eTestError", mapOf("message" to (e.message ?: "Generation failed")))
                    Messages.showErrorDialog(project, "E2E test generation failed: ${e.message}", "Error")
                }
            }
        }
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
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val commitCount = PrService.getCommitCount(cwd)
                if (commitCount > 1) {
                    ApplicationManager.getApplication().invokeLater {
                        postToWebview("prStatus", mapOf("status" to "multipleCommits", "count" to commitCount))
                    }
                    return@executeOnPooledThread
                }

                val ghAvailable = PrService.isGhAvailable(cwd)
                if (!ghAvailable) {
                    ApplicationManager.getApplication().invokeLater {
                        postToWebview("prStatus", mapOf("status" to "unavailable"))
                    }
                    return@executeOnPooledThread
                }
                val ghAuth = PrService.isGhAuthenticated(cwd)
                if (!ghAuth) {
                    ApplicationManager.getApplication().invokeLater {
                        postToWebview("prStatus", mapOf("status" to "unavailable"))
                    }
                    return@executeOnPooledThread
                }

                val branch = PrService.getCurrentBranch(cwd) ?: "unknown"
                val pr = PrService.findPrForBranch(cwd)

                if (pr == null) {
                    ApplicationManager.getApplication().invokeLater {
                        postToWebview("prStatus", mapOf("status" to "noPr", "branch" to branch))
                    }
                } else {
                    ApplicationManager.getApplication().invokeLater {
                        postToWebview("prStatus", mapOf(
                            "status" to "ready",
                            "pr" to mapOf("number" to pr.number, "url" to pr.url, "title" to pr.title),
                        ))
                    }
                }
            } catch (e: Exception) {
                LOG.warn("Check PR status failed: ${e.message}")
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("prStatus", mapOf("status" to "unavailable"))
                }
            }
        }
    }

    private fun handleCreatePr(title: String, body: String) {
        postToWebview("prCreating")
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                PrService.pushBranch(cwd)
                val prUrl = PrService.createPr(title, body, cwd)
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("prCreated", mapOf("url" to prUrl))
                    handleCheckPrStatus()
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
                val pr = PrService.findPrForBranch(cwd)
                if (pr == null) {
                    ApplicationManager.getApplication().invokeLater { postToWebview("prUpdateError", mapOf("message" to "No PR found")) }
                    return@executeOnPooledThread
                }
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
                val pr = PrService.findPrForBranch(cwd)
                if (pr == null) {
                    ApplicationManager.getApplication().invokeLater { postToWebview("prUpdateError", mapOf("message" to "No PR found")) }
                    return@executeOnPooledThread
                }
                PrService.updatePr(pr.number, title, body, cwd)
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("prUpdated", mapOf("url" to pr.url))
                    handleCheckPrStatus()
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
                var totalEntries = 0; var claudeSessions = 0; var codexSessions = 0
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
                        if (source == "codex") codexSessions++ else claudeSessions++
                    }
                }
                ApplicationManager.getApplication().invokeLater {
                    postToWebview("transcriptStatsLoaded", mapOf("totalEntries" to totalEntries, "claudeSessions" to claudeSessions, "codexSessions" to codexSessions))
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

    private fun cleanupOrphanedDocs(originalSummary: CommitSummary, updatedSummary: CommitSummary, baseUrl: String, apiKey: String): CommitSummary? {
        val orphanedIds = originalSummary.orphanedDocIds ?: return null
        if (orphanedIds.isEmpty()) return null
        val deleted = mutableSetOf<Int>()
        for (id in orphanedIds) { try { JolliApiClient.deleteFromJolli(baseUrl, apiKey, id); deleted.add(id) } catch (e: Exception) { LOG.warn("Failed to delete orphaned doc $id: ${e.message}") } }
        val remaining = orphanedIds.filter { it !in deleted }
        val cleanedSummary = updatedSummary.copy(orphanedDocIds = remaining.takeIf { it.isNotEmpty() })
        store.storeSummary(cleanedSummary, force = true)
        return cleanedSummary
    }

    private data class RebuildSession(val sessionId: String, val source: String, val transcriptPath: String?, val entries: MutableList<TranscriptEntry> = mutableListOf())
    private data class PlanPushResult(val slug: String, val title: String, val url: String, val docId: Int)

    companion object {
        private val LOG = Logger.getInstance(SummaryPanel::class.java)

        fun collectTreeHashes(summary: CommitSummary): Set<String> {
            val hashes = mutableSetOf(summary.commitHash)
            summary.children?.forEach { hashes.addAll(collectTreeHashes(it)) }
            return hashes
        }
    }
}

package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.bridge.GitRemoteUtils
import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SummaryStore
import ai.jolli.jollimemory.core.telemetry.Telemetry
import ai.jolli.jollimemory.toolwindow.views.SummaryMarkdownBuilder
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils

/**
 * JolliShareService — the reusable core of the "Share in Jolli" push.
 *
 * Extracted verbatim from `SummaryPanel.handlePushToJolli` so the same push
 * logic backs both the single-memory Share button AND the Create-PR view's
 * one-click "create the PR and share the included memories" flow.
 *
 * [shareSummary] runs SYNCHRONOUSLY — call it from a pooled thread. It pushes a
 * summary's plans, then the summary itself, stores the updated summary back
 * (with `jolliDocUrl`/`jolliDocId`), and best-effort deletes orphaned docs. It
 * does NOT touch the UI: typed failures (`BindingRequiredError`,
 * `PluginOutdatedError`, `UnauthorizedError`) propagate to the caller, which
 * owns the binding dialog / re-auth / toast decisions.
 */
object JolliShareService {

    private val log = JmLogger.create("JolliShareService")

    /** Outcome of a successful [shareSummary] call. */
    data class ShareResult(
        val updatedSummary: CommitSummary,
        val created: Boolean,
        val planCount: Int,
    )

    private data class PlanPushResult(val slug: String, val url: String, val docId: Int)

    /**
     * Pushes [summary] (and its plans) to the Jolli site, persists the updated
     * summary, and cleans up orphaned docs. Returns the stored summary.
     *
     * @param resolvedBaseUrl the Jolli site base URL already resolved from the API key.
     * @throws JolliApiClient.BindingRequiredError when the repo has no space binding yet.
     * @throws JolliApiClient.PluginOutdatedError / UnauthorizedError on server rejection.
     */
    fun shareSummary(
        store: SummaryStore,
        summary: CommitSummary,
        cwd: String,
        apiKey: String,
        resolvedBaseUrl: String,
    ): ShareResult {
        val baseUrl = resolvedBaseUrl.trimEnd('/')
        val repoUrl = GitRemoteUtils.getCanonicalRepoUrl(cwd)
        val relativePath = GitRemoteUtils.sanitizeBranchSlug(summary.branch)

        val planUrls = mutableListOf<PlanPushResult>()
        for (plan in summary.plans ?: emptyList()) {
            val planContent = store.readPlanFromBranch(plan.slug) ?: continue
            if (planContent.isBlank()) continue
            val planResult = JolliApiClient.pushToJolli(
                resolvedBaseUrl, apiKey,
                JolliApiClient.JolliPushPayload(
                    title = SummaryUtils.buildPlanPushTitle(summary, plan.title),
                    content = planContent,
                    commitHash = summary.commitHash,
                    docType = "plan",
                    branch = summary.branch,
                    docId = plan.jolliPlanDocId,
                    repoUrl = repoUrl,
                    relativePath = relativePath,
                ),
            )
            planUrls.add(PlanPushResult(plan.slug, "$baseUrl/articles?doc=${planResult.docId}", planResult.docId))
        }

        // Fold pushed plan URLs back into the summary so the pushed markdown links
        // to the freshly-created plan docs (mirrors the original inline logic).
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

        val result = JolliApiClient.pushToJolli(
            resolvedBaseUrl, apiKey,
            JolliApiClient.JolliPushPayload(
                title = SummaryUtils.buildPushTitle(summary),
                content = markdown,
                commitHash = summary.commitHash,
                docType = "summary",
                branch = summary.branch,
                docId = summary.jolliDocId,
                repoUrl = repoUrl,
                relativePath = relativePath,
            ),
        )

        val fullUrl = "$baseUrl/articles?doc=${result.docId}"
        val updatedSummary = summary.copy(jolliDocUrl = fullUrl, jolliDocId = result.docId, plans = plansWithUrls)
        store.storeSummary(updatedSummary, force = true)

        val cleanedSummary = cleanupOrphanedDocs(store, summary, updatedSummary, baseUrl, apiKey) ?: updatedSummary

        Telemetry.track(
            "memory_pushed",
            mapOf(
                "kind" to "summary",
                "created" to result.created,
                "plans_bucket" to Telemetry.bucket(planUrls.size),
            ),
        )

        return ShareResult(cleanedSummary, result.created, planUrls.size)
    }

    /**
     * Best-effort deletes docs left orphaned by a prior push (e.g. a plan that was
     * removed), then persists the summary with the survivors. Returns the cleaned
     * summary, or null when there was nothing to clean.
     */
    private fun cleanupOrphanedDocs(
        store: SummaryStore,
        originalSummary: CommitSummary,
        updatedSummary: CommitSummary,
        baseUrl: String,
        apiKey: String,
    ): CommitSummary? {
        val orphanedIds = originalSummary.orphanedDocIds ?: return null
        if (orphanedIds.isEmpty()) return null
        val deleted = mutableSetOf<Int>()
        for (id in orphanedIds) {
            try {
                JolliApiClient.deleteFromJolli(baseUrl, apiKey, id)
                deleted.add(id)
            } catch (e: Exception) {
                log.warn("Failed to delete orphaned doc %d: %s", id, e.message ?: e.toString())
            }
        }
        val remaining = orphanedIds.filter { it !in deleted }
        val cleaned = updatedSummary.copy(orphanedDocIds = remaining.takeIf { it.isNotEmpty() })
        store.storeSummary(cleaned, force = true)
        return cleaned
    }
}

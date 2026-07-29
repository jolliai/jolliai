package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.NoteFormat
import ai.jolli.jollimemory.core.NoteReference
import ai.jolli.jollimemory.core.PlanGrouping
import ai.jolli.jollimemory.core.PlanReference
import ai.jolli.jollimemory.core.PushPendingReader
import ai.jolli.jollimemory.core.telemetry.Telemetry
import ai.jolli.jollimemory.toolwindow.views.SummaryMarkdownBuilder
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils

/**
 * JolliPushOrchestrator — Kotlin port of vscode/src/services/JolliPushOrchestrator.ts
 *
 * UI-agnostic push of ONE summary plus its plans/notes to a Jolli Memory Space.
 * It does NO IntelliJ UI: it RETURNS the data the caller needs (the pushed doc
 * ids, the updated summary, the partial-attachment failures, whether it was an
 * update vs a first push). The binding chooser is injected as [PushContext.resolveBinding]
 * so the chooser UI stays in the tool-window layer.
 *
 * Attachment selection is the CALLER's choice ([AttachmentSelection]): the live-share
 * controller dedupes plans/notes branch-wide to their latest revision and hands each
 * summary only the attachments it should push (with `jolliPlanDocId` / `jolliNoteDocId`
 * already resolved from its branch-wide map, so the push updates the one Space doc in
 * place instead of creating a duplicate). When `attachments` is null, the summary's own
 * `latestPlanPerName(plans)` + `notes` are pushed.
 */
object JolliPushOrchestrator {

    private val log = JmLogger.create("PushOrchestrator")

    /**
     * Errors that must ABORT the whole push instead of being collected as a
     * per-attachment failure.
     *
     * [JolliApiClient.BindingRequiredError] / [JolliApiClient.PluginOutdatedError]
     * drive the caller's binding chooser and update prompt.
     * [JolliApiClient.PermissionDeniedError] and [JolliShareService.PushDisabledError]
     * are **repo-wide refusals**: the server's allowlist/ownership verdict and the
     * per-repo outbound-push opt-out (spec 306) apply to every doc in this repo, so
     * the summary and every remaining attachment would be refused identically.
     * Collecting them would mislabel a repo-wide condition as `plan "X" failed`,
     * fire N doomed requests on the way, and rob the panels of the admin-oriented
     * ("contact an admin") / quiet ("re-enable to push") handling they have for
     * exactly these two.
     *
     * Mirrors vscode's `FATAL_PUSH_ERROR_NAMES`; shared by BOTH attachment loops so
     * the fatal set cannot drift between them.
     *
     * Membership must stay in step with `CreatePrPanel.repoWideStopReason`, the other
     * place this project decides "repo-wide or per-item". The two differ in exactly
     * one entry, on purpose: `BindingRequiredError` is FATAL here (the orchestrator
     * cannot run a chooser) but RECOVERABLE there (the panel resolves the binding and
     * retries). Every other repo-wide type belongs in both — a type added to only one
     * is the bug shape that let a repo-wide refusal be counted as a single per-item
     * failure. When adding one, update both.
     *
     * `internal` so the set is unit-testable: both loops reach it only through a
     * static [JolliApiClient.pushToJolli] call, which cannot be faked without the
     * mockk object-stubbing that `scripts/check-global-state.sh` bans in new tests.
     */
    internal fun isFatalPushError(e: Throwable): Boolean =
        e is JolliApiClient.BindingRequiredError ||
            e is JolliApiClient.PluginOutdatedError ||
            e is JolliApiClient.PermissionDeniedError ||
            e is JolliShareService.PushDisabledError ||
            // Not reachable from inside the attachment loops today (the gate that raises
            // it runs at the entry points), but it is unambiguously repo-wide: if the
            // opt-out could not be evaluated for this repo, it cannot be evaluated for
            // the next attachment either. Listed so a future gate call inside a loop
            // cannot silently degrade to a per-attachment failure.
            e is JolliShareService.PushGateUnavailableError

    /** Outcome of the injected binding-chooser callback. */
    enum class BindingOutcome { BOUND, ANOTHER_OPEN, CANCELLED, FAILED }

    /**
     * Raised when the push can't proceed because a Space binding wasn't established.
     * [outcome] lets the caller decide messaging.
     */
    class ShareBindingError(val outcome: BindingOutcome) : RuntimeException("Space binding $outcome")

    /** A per-plan/per-note push failure, collected (not thrown) so one bad attachment doesn't abort. */
    data class PushAttachmentFailure(val label: String, val message: String)

    data class PushedPlan(val slug: String, val title: String, val docId: Int, val url: String)
    data class PushedNote(val id: String, val title: String, val docId: Int, val url: String)

    /** The doc ids one summary push produced — feeds the live share's `covered` allowlist. */
    data class PushedDoc(
        val commitHash: String,
        val summaryDocId: Int,
        val summaryUrl: String,
        val plans: List<PushedPlan>,
        val notes: List<PushedNote>,
    )

    /** Result of pushing one summary; renderable data only. */
    data class PushSummaryResult(
        val pushedDoc: PushedDoc,
        val updatedSummary: CommitSummary,
        val attachmentFailures: List<PushAttachmentFailure>,
        val isUpdate: Boolean,
        val attachmentCount: Int,
    )

    /** The plans/notes to push for a summary — caller-chosen, or the summary's own when null. */
    data class AttachmentSelection(val plans: List<PlanReference>, val notes: List<NoteReference>)

    /** Everything the orchestrator needs that isn't on the summary itself. */
    data class PushContext(
        /** Resolved site base URL (the API key's `u`), passed verbatim to pushToJolli. */
        val baseUrl: String,
        val apiKey: String,
        val repoUrl: String,
        val workspaceRoot: String,
        /** Persists the summary (and its rewritten doc ids) locally. */
        val storeSummary: (CommitSummary, Boolean) -> Unit,
        /** Reads a plan body from the orphan branch. */
        val readPlanFromBranch: (String) -> String?,
        /** Reads a note body from the orphan branch. */
        val readNoteBody: (String) -> String?,
        /** Reads a summary by its original commit hash for delayed orphan cleanup. */
        val readSummary: (String) -> CommitSummary? = { null },
        /** Opens the binding chooser and reports the outcome. */
        val resolveBinding: (String) -> BindingOutcome,
    )

    /**
     * Pushes one summary + a chosen attachment set; persists `jolliDocId`/url, cleans
     * orphans, and returns the doc ids + renderable result.
     */
    fun pushSummaryWithAttachments(
        summary: CommitSummary,
        ctx: PushContext,
        attachments: AttachmentSelection? = null,
        strictAttachments: Boolean = false,
        retried: Boolean = false,
    ): PushSummaryResult {
        val displayBase = ctx.baseUrl.trimEnd('/')
        val plansToPush = attachments?.plans ?: PlanGrouping.latestPlanPerName(summary.plans ?: emptyList())
        val notesToPush = attachments?.notes ?: (summary.notes ?: emptyList())

        try {
            // Step 1: upload plans + notes. Per-attachment failures are collected, not thrown.
            val (planUrls, planFailures) = pushPlanList(plansToPush, summary, ctx, displayBase, strictAttachments)
            val (noteUrls, noteFailures) = pushNoteList(notesToPush, summary, ctx, displayBase, strictAttachments)
            val attachmentFailures = planFailures + noteFailures

            // Step 2: weave the published URLs into the summary markdown.
            val dedupedPlans = PlanGrouping.latestPlanPerName(summary.plans ?: emptyList())
            val plansWithUrls = applyPlanUrls(dedupedPlans, planUrls) ?: dedupedPlans
            val notesWithUrls = summary.notes?.let { applyNoteUrls(it, noteUrls) }
            val summaryForMarkdown = summary.copy(
                plans = plansWithUrls,
                notes = notesWithUrls ?: summary.notes,
            )
            val markdown = SummaryMarkdownBuilder.buildMarkdown(summaryForMarkdown)

            val result = JolliApiClient.pushToJolli(
                ctx.workspaceRoot, ctx.baseUrl, ctx.apiKey,
                JolliApiClient.JolliPushPayload(
                    title = SummaryUtils.buildPushTitle(summary),
                    content = markdown,
                    commitHash = summary.commitHash,
                    docType = "summary",
                    branch = summary.branch,
                    docId = summary.jolliDocId,
                    repoUrl = ctx.repoUrl,
                    relativePath = SummaryUtils.buildBranchRelativePath(summary.branch),
                    summaryJson = JolliApiClient.serializeSummaryJson(summaryForMarkdown),
                ),
            )

            Telemetry.track("memory_pushed", mapOf("kind" to "summary"))

            val summaryUrl = "$displayBase/articles?doc=${result.docId}"
            val isUpdate = summary.jolliDocUrl != null

            val updatedSummary = summary.copy(
                jolliDocUrl = summaryUrl,
                jolliDocId = result.docId,
                plans = if (planUrls.isNotEmpty()) applyPlanUrls(summary.plans, planUrls) else summary.plans,
                notes = if (noteUrls.isNotEmpty() && summary.notes != null) applyNoteUrls(summary.notes, noteUrls) else summary.notes,
            )
            ctx.storeSummary(updatedSummary, true)

            var summaryForCleanup = updatedSummary
            val unresolvedHashes = summary.unresolvedOrphanHashes ?: emptyList()
            if (unresolvedHashes.isNotEmpty()) {
                // Conservative retention: mirrors the TS port. Any hash that
                // cannot be positively resolved to a docId is retained so a
                // worker that crashed post-network-push does not leave an
                // orphan Space article un-referenced. The push-pending file is
                // consulted only for the in-flight log counter.
                val pendingHashes = PushPendingReader.loadHashes(ctx.workspaceRoot)
                val resolvedDocIds = ArrayList<Int>()
                val remainingHashes = ArrayList<String>()
                var stillInFlight = 0
                for (hash in unresolvedHashes) {
                    val fresh = ctx.readSummary(hash)
                    if (fresh?.commitHash == hash && fresh.jolliDocId != null) {
                        resolvedDocIds.add(fresh.jolliDocId)
                    } else {
                        remainingHashes.add(hash)
                        if (pendingHashes != null && hash in pendingHashes) stillInFlight++
                    }
                }
                if (resolvedDocIds.isNotEmpty() || remainingHashes.size != unresolvedHashes.size) {
                    if (resolvedDocIds.isNotEmpty()) {
                        log.info(
                            "Resolved ${resolvedDocIds.size} orphan hashes → docIds for cleanup " +
                                "(${remainingHashes.size} retained, $stillInFlight still in-flight)",
                        )
                    }
                    summaryForCleanup = updatedSummary.copy(
                        orphanedDocIds = ((updatedSummary.orphanedDocIds ?: emptyList()) + resolvedDocIds)
                            .distinct().ifEmpty { null },
                        unresolvedOrphanHashes = remainingHashes.distinct().ifEmpty { null },
                    )
                    ctx.storeSummary(summaryForCleanup, true)
                }
            }

            // Clean up orphaned articles (best-effort — never surfaces as a failed push).
            val cleanedSummary = try {
                cleanupOrphanedDocs(summaryForCleanup, summaryForCleanup, displayBase, ctx)
            } catch (e: Exception) {
                log.warn("Orphan cleanup failed after a successful push: ${e.message}")
                null
            }

            return PushSummaryResult(
                pushedDoc = PushedDoc(
                    commitHash = summary.commitHash,
                    summaryDocId = result.docId,
                    summaryUrl = summaryUrl,
                    plans = planUrls,
                    notes = noteUrls,
                ),
                updatedSummary = cleanedSummary ?: summaryForCleanup,
                attachmentFailures = attachmentFailures,
                isUpdate = isUpdate,
                attachmentCount = planUrls.size + noteUrls.size,
            )
        } catch (e: JolliApiClient.BindingRequiredError) {
            if (!retried) {
                val outcome = ctx.resolveBinding(ctx.repoUrl)
                if (outcome == BindingOutcome.BOUND) {
                    return pushSummaryWithAttachments(summary, ctx, attachments, strictAttachments, retried = true)
                }
                throw ShareBindingError(outcome)
            }
            throw e
        }
    }

    private fun pushPlanList(
        plans: List<PlanReference>,
        summary: CommitSummary,
        ctx: PushContext,
        displayBase: String,
        strictAttachments: Boolean,
    ): Pair<List<PushedPlan>, List<PushAttachmentFailure>> {
        val failures = ArrayList<PushAttachmentFailure>()
        val results = ArrayList<PushedPlan>()
        for (plan in plans) {
            val planContent = ctx.readPlanFromBranch(plan.slug).orEmpty()
            if (planContent.isEmpty()) {
                if (strictAttachments) {
                    failures.add(PushAttachmentFailure("plan \"${plan.title}\"", "Plan content for ${plan.slug} could not be read."))
                }
                log.info("Plan ${plan.slug}: no content found, skipping")
                continue
            }
            val planResult = try {
                JolliApiClient.pushToJolli(
                    ctx.workspaceRoot, ctx.baseUrl, ctx.apiKey,
                    JolliApiClient.JolliPushPayload(
                        title = SummaryUtils.buildPlanPushTitle(summary, plan.title),
                        content = planContent,
                        commitHash = summary.commitHash,
                        docType = "plan",
                        branch = summary.branch,
                        docId = plan.jolliPlanDocId,
                        repoUrl = ctx.repoUrl,
                        relativePath = SummaryUtils.buildBranchRelativePath(summary.branch),
                    ),
                )
            } catch (e: Exception) {
                if (isFatalPushError(e)) throw e
                val msg = e.message ?: e.toString()
                log.error("Plan ${plan.slug} push FAILED: $msg")
                failures.add(PushAttachmentFailure("plan \"${plan.title}\"", msg))
                continue
            }
            results.add(PushedPlan(plan.slug, plan.title, planResult.docId, "$displayBase/articles?doc=${planResult.docId}"))
        }
        return results to failures
    }

    private fun pushNoteList(
        notes: List<NoteReference>,
        summary: CommitSummary,
        ctx: PushContext,
        displayBase: String,
        strictAttachments: Boolean,
    ): Pair<List<PushedNote>, List<PushAttachmentFailure>> {
        val failures = ArrayList<PushAttachmentFailure>()
        val results = ArrayList<PushedNote>()
        for (note in notes) {
            val noteContent: String
            if (note.format == NoteFormat.snippet) {
                if (note.content.isNullOrEmpty()) {
                    if (strictAttachments) {
                        failures.add(PushAttachmentFailure("note \"${note.title}\"", "Snippet note content for ${note.id} is empty."))
                    }
                    log.warn("Snippet note ${note.id} has no content — skipping push")
                    continue
                }
                noteContent = note.content
            } else {
                val body = ctx.readNoteBody(note.id).orEmpty()
                if (body.isEmpty()) {
                    if (strictAttachments) {
                        failures.add(PushAttachmentFailure("note \"${note.title}\"", "Note content for ${note.id} could not be read."))
                    }
                    log.info("Note ${note.id}: no content found, skipping")
                    continue
                }
                noteContent = body
            }
            val noteResult = try {
                JolliApiClient.pushToJolli(
                    ctx.workspaceRoot, ctx.baseUrl, ctx.apiKey,
                    JolliApiClient.JolliPushPayload(
                        title = SummaryUtils.buildNotePushTitle(summary, note.title),
                        content = noteContent,
                        commitHash = summary.commitHash,
                        docType = "note",
                        branch = summary.branch,
                        docId = note.jolliNoteDocId,
                        repoUrl = ctx.repoUrl,
                        relativePath = SummaryUtils.buildBranchRelativePath(summary.branch),
                    ),
                )
            } catch (e: Exception) {
                if (isFatalPushError(e)) throw e
                val msg = e.message ?: e.toString()
                log.error("Note ${note.id} push FAILED: $msg")
                failures.add(PushAttachmentFailure("note \"${note.title}\"", msg))
                continue
            }
            results.add(PushedNote(note.id, note.title, noteResult.docId, "$displayBase/articles?doc=${noteResult.docId}"))
        }
        return results to failures
    }

    /** Merges published plan URLs/docIds into plan references (matched by exact slug). */
    fun applyPlanUrls(plans: List<PlanReference>?, planUrls: List<PushedPlan>): List<PlanReference>? {
        if (plans == null || planUrls.isEmpty()) return plans
        val urlMap = planUrls.associateBy { it.slug }
        return plans.map { p ->
            val pushed = urlMap[p.slug]
            if (pushed != null) p.copy(jolliPlanDocUrl = pushed.url, jolliPlanDocId = pushed.docId) else p
        }
    }

    /** Merges published note URLs/docIds into note references (matched by id). */
    fun applyNoteUrls(notes: List<NoteReference>, noteUrls: List<PushedNote>): List<NoteReference> {
        val urlMap = noteUrls.associateBy { it.id }
        return notes.map { n ->
            val pushed = urlMap[n.id]
            if (pushed != null) n.copy(jolliNoteDocUrl = pushed.url, jolliNoteDocId = pushed.docId) else n
        }
    }

    /**
     * Deletes orphaned articles from the Space, then persists the result: only ids that
     * were successfully deleted are cleared from `orphanedDocIds`; failed ids are kept so
     * the next push retries them. Returns the persisted summary, or null when no orphans.
     */
    private fun cleanupOrphanedDocs(
        originalSummary: CommitSummary,
        updatedSummary: CommitSummary,
        displayBase: String,
        ctx: PushContext,
    ): CommitSummary? {
        val orphanedIds = originalSummary.orphanedDocIds ?: return null
        if (orphanedIds.isEmpty()) return null
        val deleted = HashSet<Int>()
        for (id in orphanedIds) {
            try {
                JolliApiClient.deleteFromJolli(ctx.workspaceRoot, displayBase, ctx.apiKey, id)
                deleted.add(id)
            } catch (e: Exception) {
                log.warn("Failed to delete orphaned doc $id: ${e.message}")
            }
        }
        val remaining = orphanedIds.filter { it !in deleted }
        if (deleted.isNotEmpty()) log.info("Deleted ${deleted.size} orphaned article(s)")
        if (remaining.isNotEmpty()) log.warn("Failed to delete ${remaining.size} orphaned article(s), will retry on next push")
        val cleaned = updatedSummary.copy(orphanedDocIds = remaining.ifEmpty { null })
        ctx.storeSummary(cleaned, true)
        return cleaned
    }
}

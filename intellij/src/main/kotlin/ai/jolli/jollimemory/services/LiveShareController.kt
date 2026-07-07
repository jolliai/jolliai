package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.bridge.GitRemoteUtils
import ai.jolli.jollimemory.core.BranchShareStore
import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.KBPathResolver
import ai.jolli.jollimemory.core.NoteReference
import ai.jolli.jollimemory.core.PlanGrouping
import ai.jolli.jollimemory.core.PlanReference
import ai.jolli.jollimemory.services.JolliPushOrchestrator.AttachmentSelection
import ai.jolli.jollimemory.services.JolliPushOrchestrator.PushContext
import ai.jolli.jollimemory.toolwindow.views.SummaryUtils
import java.security.MessageDigest
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * LiveShareController — Kotlin port of vscode/src/services/LiveShareController.ts (single-slot).
 *
 * Orchestrates a live, Space-backed share for a branch (or a single commit):
 *   1. push every summary on `base..HEAD` (and its plans/notes) to the bound Space, and
 *   2. create/refresh a live share that REFERENCES the resulting doc ids (a `covered`
 *      allowlist) — never a frozen content blob.
 *
 * UI-agnostic: the binding chooser is injected as [Deps.resolveBinding]; loading and
 * persisting summaries are injected too, so this is fully unit-testable.
 *
 * A per-(workspaceRoot, branch) in-flight lock prevents overlapping generate/reconcile
 * passes from lost-updating `covered` (PATCH replaces it wholesale).
 */
object LiveShareController {

    private val log = JmLogger.create("LiveShare")

    /** Raised when the share subject has no generated summaries to push. */
    class NothingToShareError(branch: String) : RuntimeException(
        "No memories on \"$branch\" yet — make a commit so Jolli can summarize it, then share."
    )

    /** Raised when one or more plan/note Space docs failed to upload. */
    class AttachmentPushError(val failures: List<JolliPushOrchestrator.PushAttachmentFailure>) : RuntimeException(
        "Could not sync shared plans/notes: " + failures.joinToString("; ") { "${it.label}: ${it.message}" }
    )

    /** Dependencies the controller needs that aren't on the params. */
    data class Deps(
        val workspaceRoot: String,
        val apiKey: String,
        /** Loads the current branch's `base..HEAD` summaries, chronological oldest-first. */
        val loadBranchSummaries: () -> List<CommitSummary>,
        val storeSummary: (CommitSummary, Boolean) -> Unit,
        val readPlanFromBranch: (String) -> String?,
        val readNoteBody: (String) -> String?,
        val resolveBinding: (String) -> JolliPushOrchestrator.BindingOutcome,
    )

    data class GenerateParams(
        val deps: Deps,
        val branch: String,
        /** Set for a single-commit share; omit for a whole-branch share. */
        val commitHash: String? = null,
        val commitSummary: CommitSummary? = null,
        /** "public" | "org" | "people" */
        val visibility: String,
        /** `people` allowlist (lowercased emails) sent to the server; omit for public/org. */
        val recipients: List<String>? = null,
    )

    private val locks = ConcurrentHashMap<String, ReentrantLock>()

    private fun <T> withSubjectLock(workspaceRoot: String, branch: String, work: () -> T): T =
        locks.computeIfAbsent("$workspaceRoot $branch") { ReentrantLock() }.withLock(work)

    private fun resolveBaseUrl(apiKey: String): String {
        return JolliApiClient.parseJolliApiKey(apiKey)?.u
            ?: throw RuntimeException(
                "Jolli site URL could not be determined. " +
                    "Please regenerate your Jolli API Key and set it again (STATUS panel)."
            )
    }

    private fun loadSubjectSummaries(
        deps: Deps,
        commitHash: String?,
        commitSummary: CommitSummary?,
    ): List<CommitSummary> {
        if (commitHash != null && commitSummary?.commitHash == commitHash) return listOf(commitSummary)
        val all = deps.loadBranchSummaries()
        return if (commitHash != null) all.filter { it.commitHash == commitHash } else all
    }

    private fun ts(iso: String): Long = try {
        Instant.parse(iso).toEpochMilli()
    } catch (_: Exception) {
        Long.MIN_VALUE
    }

    private data class Winner<T>(val ref: T, val ownerCommit: String, val seedDocId: Int?)

    private fun pushSubjectAndBuildRef(
        subjectSummaries: List<CommitSummary>,
        kind: String,
        branch: String,
        ctx: PushContext,
    ): BranchShareStore.LiveRef {
        val planWinners = LinkedHashMap<String, Winner<PlanReference>>()
        val noteWinners = LinkedHashMap<String, Winner<NoteReference>>()
        for (summary in subjectSummaries) {
            for (plan in summary.plans ?: emptyList()) {
                val key = PlanGrouping.planBaseKey(plan.slug)
                val prev = planWinners[key]
                val seedDocId = plan.jolliPlanDocId ?: prev?.seedDocId
                if (prev == null || ts(plan.updatedAt) >= ts(prev.ref.updatedAt)) {
                    planWinners[key] = Winner(plan, summary.commitHash, seedDocId)
                } else if (seedDocId != prev.seedDocId) {
                    planWinners[key] = prev.copy(seedDocId = seedDocId)
                }
            }
            for (note in summary.notes ?: emptyList()) {
                val prev = noteWinners[note.id]
                val seedDocId = note.jolliNoteDocId ?: prev?.seedDocId
                if (prev == null || ts(note.updatedAt) >= ts(prev.ref.updatedAt)) {
                    noteWinners[note.id] = Winner(note, summary.commitHash, seedDocId)
                } else if (seedDocId != prev.seedDocId) {
                    noteWinners[note.id] = prev.copy(seedDocId = seedDocId)
                }
            }
        }

        val ownedPlans = HashMap<String, MutableList<PlanReference>>()
        val ownedNotes = HashMap<String, MutableList<NoteReference>>()
        for (w in planWinners.values) {
            val item = if (w.seedDocId != null) w.ref.copy(jolliPlanDocId = w.seedDocId) else w.ref
            ownedPlans.getOrPut(w.ownerCommit) { ArrayList() }.add(item)
        }
        for (w in noteWinners.values) {
            val item = if (w.seedDocId != null) w.ref.copy(jolliNoteDocId = w.seedDocId) else w.ref
            ownedNotes.getOrPut(w.ownerCommit) { ArrayList() }.add(item)
        }

        val planDocIdByBase = HashMap<String, Int>()
        val noteDocIdById = HashMap<String, Int>()
        for (w in planWinners.values) if (w.seedDocId != null) planDocIdByBase[PlanGrouping.planBaseKey(w.ref.slug)] = w.seedDocId
        for ((id, w) in noteWinners) if (w.seedDocId != null) noteDocIdById[id] = w.seedDocId

        val summaryDocIds = ArrayList<Int>()
        for (summary in subjectSummaries) {
            val result = JolliPushOrchestrator.pushSummaryWithAttachments(
                summary,
                ctx,
                AttachmentSelection(
                    plans = ownedPlans[summary.commitHash] ?: emptyList(),
                    notes = ownedNotes[summary.commitHash] ?: emptyList(),
                ),
                strictAttachments = true,
            )
            if (result.attachmentFailures.isNotEmpty()) throw AttachmentPushError(result.attachmentFailures)
            summaryDocIds.add(result.pushedDoc.summaryDocId)
            for (p in result.pushedDoc.plans) planDocIdByBase[PlanGrouping.planBaseKey(p.slug)] = p.docId
            for (n in result.pushedDoc.notes) noteDocIdById[n.id] = n.docId
        }

        fun coveredFor(summary: CommitSummary): List<Int> {
            val ids = LinkedHashSet<Int>()
            for (plan in summary.plans ?: emptyList()) planDocIdByBase[PlanGrouping.planBaseKey(plan.slug)]?.let { ids.add(it) }
            for (note in summary.notes ?: emptyList()) noteDocIdById[note.id]?.let { ids.add(it) }
            return ids.toList()
        }

        return if (kind == "commit") {
            BranchShareStore.LiveRef.commitDocs(
                summaryDocIds = summaryDocIds,
                attachmentDocIds = coveredFor(subjectSummaries[0]),
            )
        } else {
            BranchShareStore.LiveRef.branchCollection(
                relativePath = SummaryUtils.buildBranchRelativePath(branch),
                covered = subjectSummaries.mapIndexed { i, s ->
                    BranchShareStore.CoveredEntry(
                        commitHash = s.commitHash,
                        summaryDocId = summaryDocIds[i],
                        attachmentDocIds = coveredFor(s),
                    )
                },
            )
        }
    }

    private fun decisionCount(summaries: List<CommitSummary>): Int = summaries.sumOf { (it.topics ?: emptyList()).size }

    /**
     * Fingerprints the shared content — topics + recap + plan/note `updatedAt` — so reconcile
     * can skip a re-push when nothing meaningful changed (doc ids are deliberately excluded).
     */
    private fun computeContentHash(summaries: List<CommitSummary>): String {
        val sb = StringBuilder()
        for (s in summaries) {
            sb.append(s.commitHash).append('')
            for (t in s.topics ?: emptyList()) {
                sb.append(t.title).append('').append(t.trigger).append('')
                    .append(t.response).append('').append(t.decisions).append('')
                    .append(t.todo ?: "").append('')
            }
            sb.append(s.recap ?: "").append('')
            for (p in s.plans ?: emptyList()) sb.append(p.slug).append('=').append(p.updatedAt).append('')
            for (n in s.notes ?: emptyList()) sb.append(n.id).append('=').append(n.updatedAt).append('')
            sb.append('\n')
        }
        val digest = MessageDigest.getInstance("SHA-256").digest(sb.toString().toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    private fun buildPushContext(deps: Deps, baseUrl: String, repoUrl: String): PushContext =
        PushContext(
            baseUrl = baseUrl,
            apiKey = deps.apiKey,
            repoUrl = repoUrl,
            workspaceRoot = deps.workspaceRoot,
            storeSummary = deps.storeSummary,
            readPlanFromBranch = deps.readPlanFromBranch,
            readNoteBody = deps.readNoteBody,
            resolveBinding = deps.resolveBinding,
        )

    /**
     * Creates a live share: pushes the subject's content to the Space and records a share
     * referencing the live docs. This is the lazy-create moment (called by copy / set-access /
     * send-invite when no link yet exists).
     */
    fun generateLiveShare(params: GenerateParams): JolliApiClient.LiveShareResult {
        val deps = params.deps
        return withSubjectLock(deps.workspaceRoot, params.branch) {
            val baseUrl = resolveBaseUrl(deps.apiKey)
            val repoUrl = GitRemoteUtils.getCanonicalRepoUrl(deps.workspaceRoot)
            val repoName = KBPathResolver.extractRepoName(deps.workspaceRoot)
            val kind = if (params.commitHash != null) "commit" else "branch"

            val subjectSummaries = loadSubjectSummaries(deps, params.commitHash, params.commitSummary)
            if (subjectSummaries.isEmpty()) throw NothingToShareError(params.branch)

            val ctx = buildPushContext(deps, baseUrl, repoUrl)
            val ref = pushSubjectAndBuildRef(subjectSummaries, kind, params.branch, ctx)

            val decisions = decisionCount(subjectSummaries)
            val headCommitHash = subjectSummaries.last().commitHash
            val commitHashes = subjectSummaries.map { it.commitHash }

            val result = JolliApiClient.createLiveShare(
                baseUrl, deps.apiKey,
                JolliApiClient.LiveSharePayload(
                    repoUrl = repoUrl,
                    repoName = repoName,
                    branch = params.branch,
                    kind = kind,
                    visibility = params.visibility,
                    decisionCount = decisions,
                    headCommitHash = headCommitHash,
                    commitHashes = commitHashes,
                    branchSlug = GitRemoteUtils.sanitizeBranchSlug(params.branch),
                    ref = ref,
                    recipients = params.recipients,
                ),
            )

            BranchShareStore.putBranchShare(
                deps.workspaceRoot,
                params.branch,
                BranchShareStore.BranchShareRecord(
                    shareId = result.shareId,
                    shareUrl = result.shareUrl,
                    visibility = result.visibility,
                    recipients = result.recipients ?: params.recipients,
                    ref = ref,
                    headCommitHash = headCommitHash,
                    contentHash = computeContentHash(subjectSummaries),
                    expiresAt = result.expiresAt,
                    decisionCount = decisions,
                ),
                params.commitHash,
            )

            result
        }
    }

    /**
     * Reconciles the live branch share (only if one exists): re-pushes the current
     * `base..HEAD` set and PATCHes the `covered` ref — but SKIPS the re-push when the content
     * fingerprint is unchanged since the last sync. No-op when there's no live branch share.
     */
    fun reconcileLiveShare(deps: Deps, branch: String) {
        withSubjectLock(deps.workspaceRoot, branch) {
            val existing = BranchShareStore.getShare(deps.workspaceRoot, branch)
            if (existing?.shareId.isNullOrEmpty() || existing?.ref?.kind != BranchShareStore.LiveRef.KIND_BRANCH_COLLECTION) {
                return@withSubjectLock
            }

            val subjectSummaries = loadSubjectSummaries(deps, null, null)
            if (subjectSummaries.isEmpty()) {
                log.info("reconcile: $branch has no summaries; leaving share untouched")
                return@withSubjectLock
            }

            val newContentHash = computeContentHash(subjectSummaries)
            if (existing.contentHash != null && existing.contentHash == newContentHash) {
                log.info("reconcile: $branch content unchanged; skipping re-push")
                return@withSubjectLock
            }

            val baseUrl = resolveBaseUrl(deps.apiKey)
            val repoUrl = GitRemoteUtils.getCanonicalRepoUrl(deps.workspaceRoot)
            val ctx = buildPushContext(deps, baseUrl, repoUrl)
            val ref = pushSubjectAndBuildRef(subjectSummaries, "branch", branch, ctx)
            val result = JolliApiClient.updateLiveShare(
                baseUrl, deps.apiKey, existing.shareId,
                JolliApiClient.LiveSharePatch(ref = ref),
            )

            BranchShareStore.putBranchShare(
                deps.workspaceRoot,
                branch,
                existing.copy(
                    shareId = result.shareId ?: existing.shareId,
                    shareUrl = result.shareUrl?.ifEmpty { null } ?: existing.shareUrl,
                    visibility = result.visibility?.ifEmpty { null } ?: existing.visibility,
                    recipients = result.recipients ?: existing.recipients,
                    ref = ref,
                    headCommitHash = subjectSummaries.last().commitHash,
                    contentHash = newContentHash,
                    expiresAt = result.expiresAt?.ifEmpty { null } ?: existing.expiresAt,
                    decisionCount = decisionCount(subjectSummaries),
                ),
            )
        }
    }
}

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
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * LiveShareController — Kotlin port of vscode/src/services/LiveShareController.ts
 *
 * Orchestrates a live, Space-backed share for a branch (or a single commit):
 *   1. push every summary on `base..HEAD` (and its plans/notes) to the bound Space
 *      via [JolliPushOrchestrator], and
 *   2. create/refresh a live share that REFERENCES the resulting doc ids (a `covered`
 *      allowlist) — never a frozen content blob.
 *
 * UI-agnostic: the binding chooser is injected as [Deps.resolveBinding]; loading and
 * persisting summaries are injected too, so this is fully unit-testable.
 *
 * Cross-summary doc-id identity is the crux. A plan/note's docId is persisted onto
 * whichever summary's push first minted it, and the SAME plan (by base slug) / note (by
 * id) recurs across many commits, each mapping to ONE Space doc. So this controller owns
 * a branch-wide map: pushes each unique plan/note exactly once (oldest→newest, newest
 * content wins, reusing the known docId) and builds each commit's `covered` from that map.
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
        /**
         * The already-open summary for a single-commit share. When present, commit shares
         * are sourced from this exact memory instead of filtering the current checkout's
         * `base..HEAD` set, so sharing an open memory is stable across branch switches.
         */
        val commitSummary: CommitSummary? = null,
        /** "public" | "org" | "people" */
        val visibility: String,
        /** `people` allowlist (lowercased emails) sent to the server; omit for public/org. */
        val recipients: List<String>? = null,
    )

    // One in-flight pass per (workspaceRoot, branch) — generate/reconcile for the same
    // subject must not overlap, or a slower pass computed from an older base..HEAD could
    // PATCH a stale `covered` over a newer one (PATCH replaces it wholesale).
    private val locks = ConcurrentHashMap<String, ReentrantLock>()

    private fun <T> withSubjectLock(workspaceRoot: String, branch: String, work: () -> T): T =
        locks.computeIfAbsent("$workspaceRoot $branch") { ReentrantLock() }.withLock(work)

    /** Resolves the site base URL from the API key, or throws if it can't be derived. */
    private fun resolveBaseUrl(apiKey: String): String {
        return JolliApiClient.parseJolliApiKey(apiKey)?.u
            ?: throw RuntimeException(
                "Jolli site URL could not be determined. " +
                    "Please regenerate your Jolli API Key and set it again (STATUS panel)."
            )
    }

    /** Loads the subject's summaries (chronological oldest→newest); a commit share filters to one. */
    private fun loadSubjectSummaries(
        deps: Deps,
        commitHash: String?,
        commitSummary: CommitSummary?,
    ): List<CommitSummary> {
        if (commitHash != null && commitSummary?.commitHash == commitHash) return listOf(commitSummary)
        val all = deps.loadBranchSummaries()
        return if (commitHash != null) all.filter { it.commitHash == commitHash } else all
    }

    /** Epoch millis for a plan/note `updatedAt`; unparseable → MIN so it sorts oldest. */
    private fun ts(iso: String): Long = try {
        Instant.parse(iso).toEpochMilli()
    } catch (_: Exception) {
        Long.MIN_VALUE
    }

    /** The winner revision of a recurring plan/note + which commit owns its push. */
    private data class Winner<T>(val ref: T, val ownerCommit: String, val seedDocId: Int?)

    /**
     * Pushes the subject's summaries + deduped attachments and builds the live `ref`.
     * Shared by generate + reconcile so create-time and reconcile produce identical refs.
     */
    private fun pushSubjectAndBuildRef(
        subjectSummaries: List<CommitSummary>,
        kind: String,
        branch: String,
        ctx: PushContext,
    ): BranchShareStore.LiveRef {
        // 1. Pick the winner revision per plan base-slug / note id (latest updatedAt),
        //    remembering the owner commit and any known docId to reuse.
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

        // 2. Assign each winner (with its known docId injected) to its owner commit.
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

        // 3. Push each summary oldest→newest with only its owned attachments. Capture the
        //    pushed summary docId per commit and accumulate the branch-wide attachment map.
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

        // 4. Build covered: each commit references its OWN plans/notes' docids (resolved via
        //    the shared map, so a doc pushed under a different commit is still linked).
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

    private data class Decisions(val decisionCount: Int, val titles: List<String>)

    /**
     * Aggregates the subject's decisions for the share headline/teaser: total topic count
     * and the first 5 distinct topic titles. Shared by generate + reconcile.
     */
    private fun summarizeDecisions(summaries: List<CommitSummary>): Decisions {
        val topicsByCommit = summaries.map { it.topics ?: emptyList() }
        val decisionCount = topicsByCommit.sumOf { it.size }
        val titles = topicsByCommit
            .flatMap { topics -> topics.map { it.title.trim() } }
            .filter { it.isNotEmpty() }
            .distinct()
            .take(5)
        return Decisions(decisionCount, titles)
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
     * Creates (or refreshes, idempotent per repo+branch) a live share: pushes the subject's
     * content to the Space and records a share referencing the live docs.
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

            val (decisionCount, titles) = summarizeDecisions(subjectSummaries)
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
                    decisionCount = decisionCount,
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
                    ref = ref,
                    token8 = result.token?.take(8),
                    recipients = result.recipients,
                    headCommitHash = headCommitHash,
                    expiresAt = result.expiresAt,
                    decisionCount = decisionCount,
                    titles = titles,
                    commitHash = params.commitHash,
                ),
                params.commitHash,
            )

            result
        }
    }

    /**
     * Reconciles the live share for the CURRENT branch (only if one exists): re-pushes the
     * current `base..HEAD` set and rebuilds `covered` from scratch (so dropped commits /
     * removed attachments fall out), then PATCHes the server. No-op when there's no live
     * branch-share record. Current-branch-only is a hard constraint — loadBranchSummaries
     * reads HEAD's `base..HEAD`.
     */
    fun reconcileLiveShare(deps: Deps, branch: String) {
        withSubjectLock(deps.workspaceRoot, branch) {
            val existing = BranchShareStore.getBranchShare(deps.workspaceRoot, branch)
            // Only branch shares reconcile here; commit shares are a fixed doc list, and a
            // blank confirmed-public placeholder has no shareId.
            if (existing?.shareId.isNullOrEmpty() || existing?.ref?.kind != BranchShareStore.LiveRef.KIND_BRANCH_COLLECTION) {
                return@withSubjectLock
            }

            val baseUrl = resolveBaseUrl(deps.apiKey)
            val repoUrl = GitRemoteUtils.getCanonicalRepoUrl(deps.workspaceRoot)
            val subjectSummaries = loadSubjectSummaries(deps, null, null)
            if (subjectSummaries.isEmpty()) {
                log.info("reconcile: $branch has no summaries; leaving share untouched")
                return@withSubjectLock
            }

            val ctx = buildPushContext(deps, baseUrl, repoUrl)
            val ref = pushSubjectAndBuildRef(subjectSummaries, "branch", branch, ctx)
            val result = JolliApiClient.updateLiveShare(
                baseUrl, deps.apiKey, existing.shareId,
                JolliApiClient.LiveSharePatch(ref = ref),
            )

            // A ref-only PATCH legitimately omits unchanged fields; preserve the existing
            // values so the cached record stays reopen-able and people-share allowlists aren't
            // dropped; only `ref` and anything the server actually returned change.
            val token8 = result.token?.take(8) ?: existing.token8
            val recipients = result.recipients ?: existing.recipients
            val (decisionCount, titles) = summarizeDecisions(subjectSummaries)
            BranchShareStore.putBranchShare(
                deps.workspaceRoot,
                branch,
                BranchShareStore.BranchShareRecord(
                    shareId = result.shareId ?: existing.shareId,
                    shareUrl = result.shareUrl?.ifEmpty { null } ?: existing.shareUrl,
                    visibility = result.visibility?.ifEmpty { null } ?: existing.visibility,
                    ref = ref,
                    token8 = token8,
                    recipients = recipients,
                    headCommitHash = subjectSummaries.last().commitHash,
                    expiresAt = result.expiresAt?.ifEmpty { null } ?: existing.expiresAt,
                    decisionCount = decisionCount,
                    titles = titles,
                ),
            )
        }
    }
}

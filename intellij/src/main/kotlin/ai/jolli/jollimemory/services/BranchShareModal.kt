package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.auth.JolliAuthUtils
import ai.jolli.jollimemory.core.BranchShareStore
import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.JmLogger
import java.net.URI

/**
 * BranchShareModal — Kotlin port of vscode/src/services/BranchShareModal.ts (single-slot).
 *
 * State machine behind the "Share" modal. Each UI event (open / copy-link / set-access /
 * send-invite / remove-recipient) maps to one entry point that computes the next modal state
 * and pushes it through the injected [ShareModalIO]. UI-agnostic so it is fully unit-testable;
 * the JCEF webview (and the Swing dialog) supply IntelliJ-backed IOs.
 *
 * **Single-slot, lazy-create model:** a subject holds at most ONE live link. Opening the modal
 * never mints. The link is created lazily on the first Copy (public/org) or Send-invite; the
 * access tier is flipped in place via PATCH; and a `people` link with its last recipient
 * removed is revoked. All entry points run synchronously — invoke from a pooled thread.
 */
object BranchShareModal {

    private val log = JmLogger.create("BranchShareModal")

    /** A directory entry (org member or git contributor) offered as an add-people suggestion / owner row. */
    data class ShareMember(val name: String, val email: String)

    /** The single link as rendered in the modal. */
    data class ShareLinkState(
        val shareUrl: String,
        /** "public" | "org" | "people" */
        val visibility: String,
        /** `people` allowlist (lowercased emails); never the owner. */
        val recipients: List<String>,
    )

    /** Result of a copy action, echoed to the client for the "Link copied" toast. */
    data class ShareCopyResult(val ok: Boolean)

    /** The render states the modal can be in. */
    sealed interface ShareModalState {
        object NeedsApiKey : ShareModalState
        data class Loading(val label: String) : ShareModalState
        data class Ready(
            val branch: String,
            val subject: String,
            val subjectTitle: String,
            val decisionCount: Int,
            val canOrg: Boolean,
            /** The minted link, when present; null before lazy-create. */
            val share: ShareLinkState?,
            val accountMembers: List<ShareMember>,
            val gitCollaborators: List<ShareMember>,
            val owner: ShareMember,
        ) : ShareModalState
        data class Error(val message: String) : ShareModalState
    }

    interface ShareModalIO {
        fun postState(state: ShareModalState)
        /** Copies text to the clipboard; returns whether it succeeded. */
        fun copyToClipboard(text: String): Boolean
        fun postCopyResult(result: ShareCopyResult)
        fun notifyError(message: String)
        fun notifyInfo(message: String)
    }

    data class ShareModalContext(
        val workspaceRoot: String,
        val branch: String,
        val apiKey: String?,
        /** Set for a single-commit share; omit for a whole-branch share. */
        val commitHash: String? = null,
        val commitSummary: CommitSummary? = null,
        /** Human title for the subtitle: commit message (commit) or branch name (branch). */
        val subjectTitle: String,
        /** Whether the `org` tier is offered (API key carries an org). */
        val canOrg: Boolean,
        /** The current user (owner row); never on the allowlist. */
        val owner: ShareMember,
        /** Org members suggestion group. */
        val accountMembers: List<ShareMember>,
        /** Repo contributors not already in the account group. */
        val gitCollaborators: List<ShareMember>,
        // ── LiveShareController plumbing (injected so this stays UI-free) ──
        val loadBranchSummaries: () -> List<CommitSummary>,
        val storeSummary: (CommitSummary, Boolean) -> Unit,
        val readPlanFromBranch: (String) -> String?,
        val readNoteBody: (String) -> String?,
        val resolveBinding: (String) -> JolliPushOrchestrator.BindingOutcome,
        val nowMs: Long? = null,
    )

    private fun buildDeps(ctx: ShareModalContext, apiKey: String): LiveShareController.Deps =
        LiveShareController.Deps(
            workspaceRoot = ctx.workspaceRoot,
            apiKey = apiKey,
            loadBranchSummaries = ctx.loadBranchSummaries,
            storeSummary = ctx.storeSummary,
            readPlanFromBranch = ctx.readPlanFromBranch,
            readNoteBody = ctx.readNoteBody,
            resolveBinding = ctx.resolveBinding,
        )

    /** Display label for the share subject: branch name, or "branch · commit <hash8>". */
    private fun shareSubject(ctx: ShareModalContext): String =
        if (ctx.commitHash != null) "${ctx.branch} · commit ${ctx.commitHash.take(8)}" else ctx.branch

    /**
     * Opens the modal. Never mints a link. For a live branch share it first reconciles the
     * `covered` allowlist against the current `base..HEAD` (best-effort), then renders.
     */
    fun openShareModal(io: ShareModalIO, ctx: ShareModalContext) {
        log.info("openShareModal: branch=${ctx.branch}, commitHash=${ctx.commitHash}")
        val apiKey = ctx.apiKey
        if (apiKey == null) {
            log.info("openShareModal: no apiKey, posting NeedsApiKey")
            io.postState(ShareModalState.NeedsApiKey)
            return
        }
        val existing = BranchShareStore.getShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash)
        log.info("openShareModal: existing share=${existing?.shareId}, ref.kind=${existing?.ref?.kind}")
        if (ctx.commitHash == null && isLive(existing, ctx.nowMs) && existing?.ref?.kind == BranchShareStore.LiveRef.KIND_BRANCH_COLLECTION) {
            log.info("openShareModal: posting Loading state, starting reconcile")
            io.postState(ShareModalState.Loading("Syncing to Jolli…"))
            try {
                LiveShareController.reconcileLiveShare(buildDeps(ctx, apiKey), ctx.branch)
                log.info("openShareModal: reconcile completed successfully")
            } catch (e: Exception) {
                log.warn("openShareModal: reconcile failed: ${e.message}", e)
                io.notifyError("Couldn't refresh the shared content: ${errMessage(e)}")
            }
        }
        log.info("openShareModal: calling postReady")
        postReady(io, ctx)
    }

    /**
     * Copies the link for [visibility], minting it first when needed. Public/org mint silently;
     * `people` with no invitees is rejected (nothing to link to yet).
     */
    fun copyShareLinkModal(io: ShareModalIO, ctx: ShareModalContext, visibility: String) {
        val apiKey = ctx.apiKey ?: run {
            io.postState(ShareModalState.NeedsApiKey); io.postCopyResult(ShareCopyResult(false)); return
        }
        var minted = false
        var patched = false
        try {
            var existing = BranchShareStore.getShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash)
            if (!isLive(existing, ctx.nowMs)) {
                if (visibility == "people") {
                    io.notifyError("No one is invited yet — pick a teammate above first, or switch who can open the link.")
                    io.postCopyResult(ShareCopyResult(false))
                    return
                }
                generate(ctx, apiKey, visibility, null)
                minted = true
                existing = BranchShareStore.getShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash)
            } else if (existing!!.visibility != visibility) {
                if (visibility == "people" && (existing.recipients ?: emptyList()).isEmpty()) {
                    io.notifyError("No one is invited yet — pick a teammate above first, or switch who can open the link.")
                    io.postCopyResult(ShareCopyResult(false))
                    return
                }
                BranchShareController.patchShareAudience(
                    ctx.workspaceRoot, ctx.branch, apiKey,
                    BranchShareController.ShareAudiencePatch(visibility = visibility), ctx.commitHash,
                )
                patched = true
                existing = BranchShareStore.getShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash)
            }
            val url = existing?.shareUrl
            if (url.isNullOrEmpty()) {
                io.notifyError("Share link could not be created — please try again.")
                io.postCopyResult(ShareCopyResult(false))
            } else {
                assertSafeShareUrl(url)
                io.postCopyResult(ShareCopyResult(io.copyToClipboard(url)))
            }
        } catch (e: Exception) {
            io.notifyError("Couldn't copy the share link: ${errMessage(e)}")
            io.postCopyResult(ShareCopyResult(false))
        }
        if (minted || patched) postReady(io, ctx)
    }

    /** Sets the access tier, flipping the single link in place (or minting/revoking per the model). */
    fun setShareAccessModal(io: ShareModalIO, ctx: ShareModalContext, visibility: String) {
        val apiKey = ctx.apiKey ?: run { io.postState(ShareModalState.NeedsApiKey); return }
        val existing = BranchShareStore.getShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash)
        if (!isLive(existing, ctx.nowMs)) {
            if (visibility != "people") {
                try {
                    generate(ctx, apiKey, visibility, null)
                } catch (e: Exception) {
                    io.postState(ShareModalState.Error(generateErrorMessage(e)))
                    return
                }
            }
            postReady(io, ctx)
            return
        }
        try {
            if (visibility == "people" && (existing!!.recipients.isNullOrEmpty())) {
                BranchShareController.revokeShare(ctx.workspaceRoot, ctx.branch, apiKey, ctx.commitHash)
                io.notifyInfo("Link stopped — no one was invited.")
            } else if (existing!!.visibility != visibility) {
                BranchShareController.patchShareAudience(
                    ctx.workspaceRoot, ctx.branch, apiKey,
                    BranchShareController.ShareAudiencePatch(visibility = visibility), ctx.commitHash,
                )
            }
        } catch (e: Exception) {
            io.notifyError("Couldn't update who can open this link: ${errMessage(e)}")
        }
        postReady(io, ctx)
    }

    /**
     * Sends invite emails and grants access. Lazily mints the link at [visibility] (default
     * `people`) when none exists; flips the tier first if it differs. On a fresh-mint failure
     * the new link is revoked so the action is all-or-nothing.
     */
    fun sendInviteModal(
        io: ShareModalIO,
        ctx: ShareModalContext,
        recipients: List<String>,
        message: String? = null,
        visibility: String? = null,
    ) {
        val apiKey = ctx.apiKey ?: run { io.postState(ShareModalState.NeedsApiKey); return }
        val clean = normalizeRecipients(recipients, ctx.owner.email)
        if (clean.isEmpty()) {
            io.notifyError("Add at least one person to invite.")
            postReady(io, ctx)
            return
        }
        val targetTier = if (visibility == "org") "org" else "people"
        var mintedForInvite = false
        var reTieredFrom: String? = null
        try {
            var existing = BranchShareStore.getShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash)
            if (!isLive(existing, ctx.nowMs)) {
                generate(ctx, apiKey, targetTier, if (targetTier == "people") clean else null)
                mintedForInvite = true
                existing = BranchShareStore.getShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash)
            } else if (existing!!.visibility != targetTier) {
                val from = existing.visibility
                try {
                    BranchShareController.patchShareAudience(
                        ctx.workspaceRoot, ctx.branch, apiKey,
                        BranchShareController.ShareAudiencePatch(visibility = targetTier), ctx.commitHash,
                    )
                } catch (e: Exception) {
                    io.notifyError("Couldn't update the link's access before inviting: ${errMessage(e)}")
                    postReady(io, ctx)
                    return
                }
                reTieredFrom = from
                existing = BranchShareStore.getShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash)
            }
            val shareId = existing?.shareId
            if (shareId.isNullOrEmpty()) {
                io.notifyError("The link could not be created — please try again.")
                return
            }
            val result = JolliApiClient.sendShareInviteAndGrantAccess(null, apiKey, shareId, clean, message)
            val merged = normalizeRecipients((existing.recipients ?: emptyList()) + clean, ctx.owner.email)
            BranchShareStore.putBranchShare(
                ctx.workspaceRoot, ctx.branch,
                existing.copy(recipients = merged), ctx.commitHash,
            )
            if (result.failed.isNotEmpty()) {
                io.notifyError("Access granted, but the email couldn't be sent to: ${result.failed.joinToString(", ")}")
            } else {
                io.notifyInfo("Invite sent to ${clean.size} ${if (clean.size == 1) "person" else "people"}.")
            }
        } catch (e: Exception) {
            io.notifyError("Couldn't send the invite: ${errMessage(e)}")
            try {
                if (mintedForInvite) {
                    BranchShareController.revokeShare(ctx.workspaceRoot, ctx.branch, apiKey, ctx.commitHash)
                } else if (reTieredFrom != null) {
                    BranchShareController.patchShareAudience(
                        ctx.workspaceRoot, ctx.branch, apiKey,
                        BranchShareController.ShareAudiencePatch(visibility = reTieredFrom), ctx.commitHash,
                    )
                }
            } catch (rollbackErr: Exception) {
                io.notifyError("Couldn't restore the previous link access: ${errMessage(rollbackErr)}")
            }
        }
        postReady(io, ctx)
    }

    /** Removes one invited person; revokes the link when the last person leaves a `people` share. */
    fun removeRecipientModal(io: ShareModalIO, ctx: ShareModalContext, email: String) {
        val apiKey = ctx.apiKey ?: run { io.postState(ShareModalState.NeedsApiKey); return }
        try {
            val existing = BranchShareStore.getShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash)
            if (existing?.shareId.isNullOrEmpty()) {
                postReady(io, ctx)
                return
            }
            val target = email.trim().lowercase()
            val remaining = (existing!!.recipients ?: emptyList()).filter { it.trim().lowercase() != target }
            if (existing.visibility == "people" && remaining.isEmpty()) {
                BranchShareController.revokeShare(ctx.workspaceRoot, ctx.branch, apiKey, ctx.commitHash)
                io.notifyInfo("Link stopped — no one is invited anymore.")
            } else {
                BranchShareController.patchShareAudience(
                    ctx.workspaceRoot, ctx.branch, apiKey,
                    BranchShareController.ShareAudiencePatch(recipients = remaining), ctx.commitHash,
                )
            }
        } catch (e: Exception) {
            io.notifyError("Couldn't remove $email: ${errMessage(e)}")
        }
        postReady(io, ctx)
    }

    /** Mints a link via the live controller (the lazy-create moment). */
    private fun generate(ctx: ShareModalContext, apiKey: String, visibility: String, recipients: List<String>?) {
        LiveShareController.generateLiveShare(
            LiveShareController.GenerateParams(
                deps = buildDeps(ctx, apiKey),
                branch = ctx.branch,
                commitHash = ctx.commitHash,
                commitSummary = ctx.commitSummary,
                visibility = visibility,
                recipients = recipients,
            ),
        )
    }

    /** Renders the current ready state from the stored record (or an absent link). */
    private fun postReady(io: ShareModalIO, ctx: ShareModalContext) {
        val record = presentable(BranchShareStore.getShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash), ctx.nowMs)
        log.info("postReady: record shareId=${record?.shareId}, shareUrl=${record?.shareUrl?.take(40)}")
        val share: ShareLinkState? = record?.let {
            ShareLinkState(it.shareUrl, it.visibility, it.recipients ?: emptyList())
        }
        val decisionCount = record?.decisionCount ?: subjectDecisionCount(ctx)
        log.info("postReady: posting Ready state, hasShare=${share != null}, branch=${ctx.branch}")
        io.postState(
            ShareModalState.Ready(
                branch = ctx.branch,
                subject = shareSubject(ctx),
                subjectTitle = ctx.subjectTitle,
                decisionCount = decisionCount,
                canOrg = ctx.canOrg,
                share = share,
                accountMembers = ctx.accountMembers,
                gitCollaborators = ctx.gitCollaborators,
                owner = ctx.owner,
            )
        )
        log.info("postReady: Ready state posted to IO")
    }

    /** Topic count for the subtitle when no link record caches it yet. Best-effort (0 on failure). */
    private fun subjectDecisionCount(ctx: ShareModalContext): Int {
        return try {
            if (ctx.commitHash != null) {
                (ctx.commitSummary?.topics ?: ctx.loadBranchSummaries().firstOrNull { it.commitHash == ctx.commitHash }?.topics)
                    ?.size ?: 0
            } else {
                ctx.loadBranchSummaries().sumOf { (it.topics ?: emptyList()).size }
            }
        } catch (_: Exception) {
            0
        }
    }

    /** De-dupes lowercased emails, drops blanks and the owner. */
    private fun normalizeRecipients(recipients: List<String>, ownerEmail: String): List<String> {
        val owner = ownerEmail.trim().lowercase()
        val out = LinkedHashSet<String>()
        for (r in recipients) {
            val e = r.trim().lowercase()
            if (e.isNotEmpty() && e != owner) out.add(e)
        }
        return out.toList()
    }

    private fun generateErrorMessage(e: Throwable): String {
        if (e is JolliPushOrchestrator.ShareBindingError) {
            return when (e.outcome) {
                JolliPushOrchestrator.BindingOutcome.ANOTHER_OPEN ->
                    "A Memory space chooser is already open for this repo. Finish there, then share again."
                JolliPushOrchestrator.BindingOutcome.CANCELLED ->
                    "Sharing needs a Memory space — none was chosen. Reopen Share to pick one."
                else -> "Sharing needs a Memory space, but one couldn't be set up. Try again."
            }
        }
        if (e is LiveShareController.NothingToShareError) return e.message ?: errMessage(e)
        return "Could not create share link: ${errMessage(e)}"
    }

    private fun assertSafeShareUrl(url: String) {
        val uri = URI(url)
        JolliAuthUtils.assertJolliOriginAllowed("${uri.scheme}://${uri.authority}")
    }

    private fun isExpired(expiresAt: String?, nowMs: Long?): Boolean {
        if (expiresAt.isNullOrEmpty() || nowMs == null) return false
        return try {
            val t = java.time.Instant.parse(expiresAt).toEpochMilli()
            t <= nowMs
        } catch (_: Exception) {
            false
        }
    }

    private fun isLive(rec: BranchShareStore.BranchShareRecord?, nowMs: Long?): Boolean =
        rec != null && rec.shareId.isNotEmpty() && rec.shareUrl.isNotEmpty() && !isExpired(rec.expiresAt, nowMs)

    private fun presentable(rec: BranchShareStore.BranchShareRecord?, nowMs: Long?): BranchShareStore.BranchShareRecord? {
        if (!isLive(rec, nowMs)) return null
        return try {
            assertSafeShareUrl(rec!!.shareUrl)
            rec
        } catch (_: Exception) {
            null
        }
    }

    private fun errMessage(e: Throwable): String = e.message ?: e.toString()
}

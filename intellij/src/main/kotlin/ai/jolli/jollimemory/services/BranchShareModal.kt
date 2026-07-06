package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.auth.JolliAuthUtils
import ai.jolli.jollimemory.core.BranchShareStore
import ai.jolli.jollimemory.core.CommitSummary
import java.net.URI
import java.time.Instant
import kotlin.math.max
import kotlin.math.roundToLong

/**
 * BranchShareModal — Kotlin port of vscode/src/services/BranchShareModal.ts
 *
 * State machine behind the "Share" modal. Each UI event (open / create / revoke /
 * set-expiry / set-audience / open-target) maps to one entry point that computes the next
 * modal state and pushes it back through the injected [ShareModalIO]. UI-agnostic so it is
 * fully unit-testable; the Swing / JCEF layer supplies an IntelliJ-backed IO.
 *
 * Shares are **live** (Space-backed): [createShareModal] pushes the subject's content to
 * the bound Space and records a share that references the live docs (via
 * [LiveShareController]). Access is `public` (anyone with the link), `org` (anyone in the
 * org), or `people` (server-gated allowlist). A live share is never "stale" (it renders
 * current membership), so there is no refresh affordance. All entry points run
 * synchronously — invoke from a pooled thread.
 */
object BranchShareModal {

    /** A row in the popover's Collaborators list. The current git user is flagged [isOwner]. */
    data class ShareCollaborator(val name: String, val email: String, val isOwner: Boolean)

    /** A directory entry (org member or git contributor) offered as an add-people suggestion. */
    data class ShareMember(val name: String, val email: String)

    /** The render states the modal can be in. Mirrored by the JCEF/Swing client. */
    sealed interface ShareModalState {
        object NeedsApiKey : ShareModalState

        data class NeedsCreate(
            val branch: String,
            val subject: String,
            val subjectTitle: String,
            val visibility: String,
            val canOrg: Boolean,
            val recipients: List<String>,
            val orgMembers: List<ShareMember>,
            val collaborators: List<ShareCollaborator>,
        ) : ShareModalState

        data class Loading(val label: String) : ShareModalState

        data class Ready(
            val branch: String,
            val subject: String,
            val subjectTitle: String,
            val shareUrl: String,
            val expiresLabel: String,
            val expiryDays: Int,
            val decisionCount: Int,
            val visibility: String,
            val canOrg: Boolean,
            val recipients: List<String>,
            val orgMembers: List<ShareMember>,
            val collaborators: List<ShareCollaborator>,
        ) : ShareModalState

        data class Error(val message: String) : ShareModalState

        /** Terminal: the share was stopped — the client dismisses the modal. */
        object Revoked : ShareModalState
    }

    /** Where a share target action points. */
    sealed interface ShareTarget {
        object Page : ShareTarget
        object Email : ShareTarget
        object Copy : ShareTarget
        data class Social(val platform: ShareMessage.SocialPlatform) : ShareTarget
    }

    interface ShareModalIO {
        fun postState(state: ShareModalState)
        fun openUrl(url: String)
        /** Opens the user's mail client (mailto:) with the chosen recipients prefilled in To:. */
        fun composeEmail(branch: String, url: String, decisionCount: Int, titles: List<String>, recipients: List<String>)
        /** Copies an attractive, content-teasing message (for Slack/IM) to the clipboard. */
        fun copyMessage(branch: String, url: String, decisionCount: Int, titles: List<String>)
        /** Opens a social platform's pre-filled compose screen. */
        fun openSocial(platform: ShareMessage.SocialPlatform, branch: String, url: String, decisionCount: Int, titles: List<String>)
        /** Formats an ISO expiry into a short human label (e.g. "expires Sep 1, 2026"). */
        fun formatExpiry(iso: String): String
        /** Surfaces a non-fatal error without tearing down the modal. */
        fun notifyError(message: String)
        /** Surfaces a confirmation — e.g. after the share is stopped. */
        fun notifyInfo(message: String)
    }

    data class ShareModalContext(
        val workspaceRoot: String,
        val branch: String,
        val apiKey: String?,
        /** Set for a single-commit share; omit for a whole-branch share. */
        val commitHash: String? = null,
        /** The exact open memory for a single-commit share; branch shares omit it. */
        val commitSummary: CommitSummary? = null,
        /** Human title for the popover subtitle: commit message (commit) or branch name (branch). */
        val subjectTitle: String,
        /** Access level chosen in the modal. Defaults to `public`. */
        val visibility: String,
        /** Recipients for the Email action, chosen at click time (local-only mailto: prefill). */
        val recipients: List<String>,
        /** Link lifetime in days, chosen in step 1; applied at create time. Null for server default. */
        val expiryDays: Int? = null,
        /** Whether the `org` access option is offered (API key carries an org). */
        val canOrg: Boolean,
        /** The current user (share owner) — always the first, fixed Collaborators row. */
        val owner: ShareMember,
        /** Directory (org members + git contributors) for add-people search + name resolution. */
        val directory: List<ShareMember>,
        // ── LiveShareController plumbing (injected so this stays UI-free) ──
        val loadBranchSummaries: () -> List<CommitSummary>,
        val storeSummary: (CommitSummary, Boolean) -> Unit,
        val readPlanFromBranch: (String) -> String?,
        val readNoteBody: (String) -> String?,
        val resolveBinding: (String) -> JolliPushOrchestrator.BindingOutcome,
        /** Host clock for the expiry check — injected for testability. */
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

    /**
     * Builds the Collaborators rows: the owner first (fixed, [ShareCollaborator.isOwner]),
     * then one row per `recipients` email. Names are resolved from [directory]; unknown
     * emails render as the bare address. The owner is de-duped out of the recipients rows.
     */
    fun deriveShareCollaborators(
        owner: ShareMember,
        recipients: List<String>,
        directory: List<ShareMember>,
    ): List<ShareCollaborator> {
        val nameByEmail = directory.associate { it.email.trim().lowercase() to it.name }
        val ownerLower = owner.email.trim().lowercase()
        val rows = ArrayList<ShareCollaborator>()
        rows.add(ShareCollaborator(name = owner.name.ifEmpty { owner.email }, email = owner.email, isOwner = true))
        val seen = HashSet<String>().apply { add(ownerLower) }
        for (raw in recipients) {
            val email = raw.trim()
            val lower = email.lowercase()
            if (email.isEmpty() || !seen.add(lower)) continue
            rows.add(ShareCollaborator(name = nameByEmail[lower] ?: email, email = email, isOwner = false))
        }
        return rows
    }

    /** Display label for the share subject: branch name, or "branch · commit <hash8>". */
    private fun shareSubject(ctx: ShareModalContext): String =
        if (ctx.commitHash != null) "${ctx.branch} · commit ${ctx.commitHash.take(8)}" else ctx.branch

    /**
     * Opens the modal. Existing, unexpired links re-show immediately; otherwise the user
     * lands on a confirmation pane and must explicitly create the share link.
     */
    fun openShareModal(io: ShareModalIO, ctx: ShareModalContext) {
        val apiKey = ctx.apiKey
        if (apiKey == null) {
            io.postState(ShareModalState.NeedsApiKey)
            return
        }
        val existing = BranchShareStore.getBranchShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash)
        // An expired link is a dead link — don't re-serve it; re-sync a fresh one below.
        if (!existing?.shareId.isNullOrEmpty() && !existing!!.shareUrl.isEmpty() && !isExpired(existing.expiresAt, ctx.nowMs)) {
            // A live BRANCH share renders the CURRENT base..HEAD, so reconcile the `covered`
            // allowlist before showing. Commit shares are a fixed doc list and don't reconcile.
            if (ctx.commitHash == null && existing.ref?.kind == BranchShareStore.LiveRef.KIND_BRANCH_COLLECTION) {
                io.postState(ShareModalState.Loading("Syncing to Jolli…"))
                try {
                    LiveShareController.reconcileLiveShare(buildDeps(ctx, apiKey), ctx.branch)
                } catch (e: Exception) {
                    io.notifyError("Couldn't refresh the shared content: ${errMessage(e)}")
                }
            }
            val fresh = BranchShareStore.getBranchShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash) ?: existing
            postReadyState(io, ctx, fresh)
            return
        }
        io.postState(needsCreateState(ctx))
    }

    /** Explicitly creates a share after the user confirms the audience/what-travels pane. */
    fun createShareModal(io: ShareModalIO, ctx: ShareModalContext) {
        if (ctx.apiKey == null) {
            io.postState(ShareModalState.NeedsApiKey)
            return
        }
        generate(io, ctx, ctx.visibility)
    }

    /**
     * Adjusts the current share's expiry (absolute ISO `expiresAt`) via PATCH — does NOT
     * re-push content. Re-renders the ready pane with the new expiry label.
     */
    fun setShareExpiryModal(io: ShareModalIO, ctx: ShareModalContext, expiresAt: String) {
        val apiKey = ctx.apiKey ?: run {
            io.postState(ShareModalState.NeedsApiKey)
            return
        }
        io.postState(ShareModalState.Loading("Updating expiry…"))
        try {
            BranchShareController.setBranchShareExpiry(ctx.workspaceRoot, ctx.branch, apiKey, expiresAt, ctx.commitHash)
        } catch (e: Exception) {
            io.notifyError("Couldn't update the link's expiry: ${errMessage(e)}")
        }
        val existing = BranchShareStore.getBranchShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash)
        if (!existing?.shareId.isNullOrEmpty() && !existing!!.shareUrl.isEmpty()) {
            postReadyState(io, ctx, existing)
        } else {
            io.postState(ShareModalState.Error("This share is no longer available — create a new link."))
        }
    }

    /**
     * Changes an existing link's audience — access level and, for `people`, the recipients
     * allowlist — via PATCH. Does NOT re-push content. Re-renders with the server-confirmed
     * URL/visibility/recipients.
     */
    fun setShareVisibilityModal(
        io: ShareModalIO,
        ctx: ShareModalContext,
        visibility: String,
        recipients: List<String>? = null,
    ) {
        val apiKey = ctx.apiKey ?: run {
            io.postState(ShareModalState.NeedsApiKey)
            return
        }
        // No `loading` pane: the client already reflected the change optimistically (SYNCING
        // badge). Switching to `public` opens a forwardable link — record the one-time ack.
        if (visibility == "public") BranchShareStore.markPublicConfirmed(ctx.workspaceRoot, ctx.branch)
        try {
            BranchShareController.setBranchShareVisibility(ctx.workspaceRoot, ctx.branch, apiKey, visibility, ctx.commitHash, recipients)
        } catch (e: Exception) {
            io.notifyError("Couldn't update who can open this link: ${errMessage(e)}")
        }
        val existing = BranchShareStore.getBranchShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash)
        if (!existing?.shareId.isNullOrEmpty() && !existing!!.shareUrl.isEmpty()) {
            postReadyState(io, ctx, existing)
        } else {
            io.postState(ShareModalState.Error("This share is no longer available — create a new link."))
        }
    }

    /**
     * Stops sharing in one action: revoke the link, confirm via a toast, and signal the
     * client to dismiss the modal. (Revoke removes the grant only — the Space docs stay.)
     */
    fun revokeShareModal(io: ShareModalIO, ctx: ShareModalContext) {
        val apiKey = ctx.apiKey ?: run {
            io.postState(ShareModalState.NeedsApiKey)
            return
        }
        io.postState(ShareModalState.Loading("Stopping share…"))
        BranchShareController.revokeBranchShareForBranch(ctx.workspaceRoot, ctx.branch, apiKey, ctx.commitHash)
        io.notifyInfo("Sharing stopped — the link no longer works.")
        io.postState(ShareModalState.Revoked)
    }

    /** Opens the page, an email draft, a copy, or a social compose for the current share. */
    fun shareModalTarget(io: ShareModalIO, ctx: ShareModalContext, target: ShareTarget) {
        val existing = BranchShareStore.getBranchShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash)
        if (existing == null || existing.shareUrl.isEmpty()) return
        try {
            assertSafeShareUrl(existing.shareUrl)
        } catch (e: Exception) {
            io.postState(ShareModalState.Error("This share link is not trusted: ${errMessage(e)}"))
            return
        }
        if (isExpired(existing.expiresAt, ctx.nowMs)) {
            io.postState(ShareModalState.Error("This link has expired — reopen Share to create a new one."))
            return
        }
        val decisions = existing.decisionCount
        val titles = existing.titles ?: emptyList()
        when (target) {
            is ShareTarget.Page -> io.openUrl(existing.shareUrl)
            is ShareTarget.Copy -> io.copyMessage(ctx.branch, existing.shareUrl, decisions, titles)
            is ShareTarget.Email -> io.composeEmail(ctx.branch, existing.shareUrl, decisions, titles, ctx.recipients)
            is ShareTarget.Social -> io.openSocial(target.platform, ctx.branch, existing.shareUrl, decisions, titles)
        }
    }

    private fun assertSafeShareUrl(url: String) {
        val uri = URI(url)
        val origin = "${uri.scheme}://${uri.authority}"
        JolliAuthUtils.assertJolliOriginAllowed(origin)
    }

    /** Creates/syncs the subject and reveals the SYNCED pane. A `public` create records the ack. */
    private fun generate(io: ShareModalIO, ctx: ShareModalContext, visibility: String) {
        val apiKey = ctx.apiKey!!
        io.postState(ShareModalState.Loading("Syncing to Jolli…"))
        if (visibility == "public") BranchShareStore.markPublicConfirmed(ctx.workspaceRoot, ctx.branch)
        try {
            LiveShareController.generateLiveShare(
                LiveShareController.GenerateParams(
                    deps = buildDeps(ctx, apiKey),
                    branch = ctx.branch,
                    commitHash = ctx.commitHash,
                    commitSummary = ctx.commitSummary,
                    visibility = visibility,
                ),
            )
        } catch (e: Exception) {
            io.postState(ShareModalState.Error(generateErrorMessage(e)))
            return
        }
        // Apply the step-1 expiry choice before revealing the link (create uses the server
        // default; a non-default lifetime is set via the same PATCH the ready pane uses).
        val expiryDays = ctx.expiryDays
        if (expiryDays != null && expiryDays > 0) {
            try {
                val end = (ctx.nowMs ?: System.currentTimeMillis()) + expiryDays.toLong() * 24L * 60L * 60L * 1000L
                val expiresAt = Instant.ofEpochMilli(end).toString()
                BranchShareController.setBranchShareExpiry(ctx.workspaceRoot, ctx.branch, apiKey, expiresAt, ctx.commitHash)
            } catch (e: Exception) {
                io.notifyError("Link created, but its expiry couldn't be set: ${errMessage(e)}")
            }
        }
        val rec = BranchShareStore.getBranchShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash)
        if (rec == null || rec.shareUrl.isEmpty()) {
            io.postState(ShareModalState.Error("Share link could not be created — please try again."))
            return
        }
        postReadyState(io, ctx, rec)
    }

    /** Maps a generate failure to a user-facing message (binding vs nothing-to-share vs generic). */
    private fun generateErrorMessage(err: Throwable): String {
        if (err is JolliPushOrchestrator.ShareBindingError) {
            return when (err.outcome) {
                JolliPushOrchestrator.BindingOutcome.ANOTHER_OPEN ->
                    "A Memory space chooser is already open for this repo. Finish there, then share again."
                JolliPushOrchestrator.BindingOutcome.CANCELLED ->
                    "Sharing needs a Memory space — none was chosen. Reopen Share to pick one."
                else -> "Sharing needs a Memory space, but one couldn't be set up. Try again."
            }
        }
        if (err is LiveShareController.NothingToShareError) return err.message ?: "Nothing to share."
        return "Could not create share link: ${errMessage(err)}"
    }

    private fun readyStateFromRecord(io: ShareModalIO, ctx: ShareModalContext, rec: BranchShareStore.BranchShareRecord): ShareModalState {
        assertSafeShareUrl(rec.shareUrl)
        val recipients = rec.recipients ?: emptyList()
        return ShareModalState.Ready(
            branch = ctx.branch,
            subject = shareSubject(ctx),
            subjectTitle = ctx.subjectTitle,
            shareUrl = rec.shareUrl,
            expiresLabel = io.formatExpiry(rec.expiresAt),
            expiryDays = remainingDays(rec.expiresAt, ctx.nowMs),
            decisionCount = rec.decisionCount,
            visibility = rec.visibility,
            canOrg = ctx.canOrg,
            recipients = recipients,
            orgMembers = ctx.directory,
            collaborators = deriveShareCollaborators(ctx.owner, recipients, ctx.directory),
        )
    }

    private fun postReadyState(io: ShareModalIO, ctx: ShareModalContext, rec: BranchShareStore.BranchShareRecord) {
        try {
            io.postState(readyStateFromRecord(io, ctx, rec))
        } catch (e: Exception) {
            io.postState(ShareModalState.Error("This share link is not trusted: ${errMessage(e)}"))
        }
    }

    private fun needsCreateState(ctx: ShareModalContext): ShareModalState {
        val visibility = if (ctx.visibility == "public" && ctx.canOrg) "org" else ctx.visibility
        val recipients = if (visibility == "people") ctx.recipients else emptyList()
        return ShareModalState.NeedsCreate(
            branch = ctx.branch,
            subject = shareSubject(ctx),
            subjectTitle = ctx.subjectTitle,
            visibility = visibility,
            canOrg = ctx.canOrg,
            recipients = recipients,
            orgMembers = ctx.directory,
            collaborators = deriveShareCollaborators(ctx.owner, recipients, ctx.directory),
        )
    }

    private fun errMessage(e: Throwable): String = e.message ?: e.toString()

    private fun parseIsoMs(iso: String?): Long? {
        if (iso.isNullOrEmpty()) return null
        return try {
            Instant.parse(iso).toEpochMilli()
        } catch (_: Exception) {
            null
        }
    }

    /** Whole days from now until `expiresAt` (≥0), so the picker preselects the link's lifetime. */
    private fun remainingDays(expiresAt: String?, nowMs: Long?): Int {
        val end = parseIsoMs(expiresAt) ?: return 0
        val now = nowMs ?: System.currentTimeMillis()
        return max(0L, ((end - now).toDouble() / (24.0 * 60.0 * 60.0 * 1000.0)).roundToLong()).toInt()
    }

    /** Whether a stored share's expiry has passed. Unknown clock / unparseable → treat as live. */
    private fun isExpired(expiresAt: String?, nowMs: Long?): Boolean {
        if (expiresAt.isNullOrEmpty() || nowMs == null) return false
        val t = parseIsoMs(expiresAt) ?: return false
        return t <= nowMs
    }
}

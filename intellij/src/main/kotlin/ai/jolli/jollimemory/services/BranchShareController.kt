package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.core.BranchShareStore

/**
 * BranchShareController — Kotlin port of vscode/src/services/BranchShareController.ts
 *
 * Share lifecycle helpers shared by the modal: revoke a share, adjust its expiry, and
 * change its audience. Pure orchestration — no IntelliJ/UI dependency — so it is
 * unit-testable. Creation lives in [LiveShareController]. All calls run synchronously;
 * invoke from a pooled thread.
 */
object BranchShareController {

    /** Revokes a subject's share (if any) and clears the local record. Idempotent. */
    fun revokeBranchShareForBranch(
        workspaceRoot: String,
        branch: String,
        apiKey: String,
        commitHash: String? = null,
    ) {
        val existing = BranchShareStore.getBranchShare(workspaceRoot, branch, commitHash)
        if (!existing?.shareId.isNullOrEmpty()) {
            JolliApiClient.revokeShare(null, apiKey, existing!!.shareId)
        }
        BranchShareStore.removeBranchShare(workspaceRoot, branch, commitHash)
    }

    /**
     * Adjusts an existing share's expiry (absolute ISO `expiresAt`) via PATCH and mirrors
     * the server-confirmed value into the local record, **preserving** the live reference
     * (`ref`), visibility, and local recipient list. Returns the new `expiresAt`, or null
     * when there is no share to patch.
     */
    fun setBranchShareExpiry(
        workspaceRoot: String,
        branch: String,
        apiKey: String,
        expiresAt: String,
        commitHash: String? = null,
    ): String? {
        val existing = BranchShareStore.getBranchShare(workspaceRoot, branch, commitHash)
        if (existing?.shareId.isNullOrEmpty()) return null
        val result = JolliApiClient.updateShareExpiry(null, apiKey, existing!!.shareId, expiresAt)
        BranchShareStore.putBranchShare(
            workspaceRoot,
            branch,
            existing.copy(expiresAt = result.expiresAt),
            commitHash,
        )
        return result.expiresAt
    }

    /**
     * Changes an existing share's audience — access level (`public` / `org` / `people`)
     * and, for `people`, the `recipients` allowlist — via PATCH, mirroring the
     * server-confirmed values into the local record. Switching to/from `public` re-mints
     * (or drops) the bearer link, so the returned `shareUrl`/`token` can change — all are
     * persisted. Returns the new visibility, or null when there is no share.
     */
    fun setBranchShareVisibility(
        workspaceRoot: String,
        branch: String,
        apiKey: String,
        visibility: String,
        commitHash: String? = null,
        recipients: List<String>? = null,
    ): String? {
        val existing = BranchShareStore.getBranchShare(workspaceRoot, branch, commitHash)
        if (existing?.shareId.isNullOrEmpty()) return null
        val result = JolliApiClient.updateLiveShare(
            null, apiKey, existing!!.shareId,
            JolliApiClient.LiveSharePatch(visibility = visibility, recipients = recipients),
        )
        val nextVisibility = result.visibility ?: visibility
        val token8 = result.token?.take(8)
            ?: if (nextVisibility == "public") existing.token8 else null
        val nextRecipients = result.recipients
            ?: if (nextVisibility == "people") (recipients ?: existing.recipients) else null
        BranchShareStore.putBranchShare(
            workspaceRoot,
            branch,
            existing.copy(
                shareId = result.shareId ?: existing.shareId,
                // A recipients-only PATCH doesn't re-mint the link, so the server may omit
                // `shareUrl` — keep the existing one in that case.
                shareUrl = result.shareUrl?.ifEmpty { null } ?: existing.shareUrl,
                visibility = nextVisibility,
                token8 = token8,
                recipients = nextRecipients,
                expiresAt = result.expiresAt?.ifEmpty { null } ?: existing.expiresAt,
            ),
            commitHash,
        )
        return nextVisibility
    }
}

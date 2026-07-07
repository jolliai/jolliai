package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.core.BranchShareStore

/**
 * BranchShareController — Kotlin port of vscode/src/services/BranchShareController.ts
 * (single-slot). Share lifecycle helpers shared by the modal: revoke a share and PATCH its
 * audience (access tier + recipients). Pure orchestration — no UI dependency. All calls run
 * synchronously; invoke from a pooled thread. Creation lives in [LiveShareController].
 */
object BranchShareController {

    /** Patch for a share's audience: access tier and/or the `people` allowlist. */
    data class ShareAudiencePatch(
        val visibility: String? = null,
        val recipients: List<String>? = null,
    )

    /** Revokes a subject's share (if any) and clears the local record. Idempotent. */
    fun revokeShare(
        workspaceRoot: String,
        branch: String,
        apiKey: String,
        commitHash: String? = null,
    ) {
        val existing = BranchShareStore.getShare(workspaceRoot, branch, commitHash)
        if (!existing?.shareId.isNullOrEmpty()) {
            JolliApiClient.revokeShare(null, apiKey, existing!!.shareId)
        }
        BranchShareStore.removeShare(workspaceRoot, branch, commitHash)
    }

    /**
     * Changes an existing share's audience — access tier (`public` / `org` / `people`) and,
     * for `people`, the `recipients` allowlist — via PATCH, mirroring the server-confirmed
     * values into the local record. Flipping to/from `public` re-mints (or drops) the bearer
     * link, so the returned `shareUrl` can change. Returns the updated record, or null when
     * there is no share to patch.
     */
    fun patchShareAudience(
        workspaceRoot: String,
        branch: String,
        apiKey: String,
        patch: ShareAudiencePatch,
        commitHash: String? = null,
    ): BranchShareStore.BranchShareRecord? {
        val existing = BranchShareStore.getShare(workspaceRoot, branch, commitHash)
        if (existing?.shareId.isNullOrEmpty()) return null
        val result = JolliApiClient.updateLiveShare(
            null, apiKey, existing!!.shareId,
            JolliApiClient.LiveSharePatch(visibility = patch.visibility, recipients = patch.recipients),
        )
        // Prefer what we asked for; fall back to the server echo, then existing.
        val nextVisibility = patch.visibility ?: result.visibility ?: existing.visibility
        // Public bearer links carry no allowlist.
        val nextRecipients = if (nextVisibility == "public") {
            null
        } else {
            patch.recipients ?: result.recipients ?: existing.recipients
        }
        val updated = existing.copy(
            shareId = result.shareId ?: existing.shareId,
            shareUrl = result.shareUrl?.ifEmpty { null } ?: existing.shareUrl,
            visibility = nextVisibility,
            recipients = nextRecipients,
            expiresAt = result.expiresAt?.ifEmpty { null } ?: existing.expiresAt,
        )
        BranchShareStore.putBranchShare(workspaceRoot, branch, updated, commitHash)
        return updated
    }
}

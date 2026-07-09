/**
 * BranchShareController
 *
 * Share lifecycle helpers shared by the modal: revoke a subject's link and PATCH
 * its audience (visibility + recipients). Pure orchestration — no VS Code/webview
 * dependency — so it is unit-testable. Creation lives in `LiveShareController`
 * (live, Space-backed).
 *
 * Single-slot model: a subject carries at most ONE link. Changing access flips
 * that one record's visibility in place — `public` (bearer), `org` (auth-gated:
 * any signed-in member ∪ recipients), or `people` (recipients only) — so the old
 * link dies when access is tightened; there is never a coexisting second link.
 */

import {
	type BranchShareRecord,
	getShare,
	getShareWithBranchLatest,
	putBranchShare,
	removeShare,
} from "../../../cli/src/core/BranchShareStore.js";
import { deriveJolliBackendKeyFromApiKey } from "../../../cli/src/core/JolliApiUtils.js";
import { revokeBranchShare, updateLiveShare } from "./JolliShareService.js";

/** A subject's access change: the visibility tier and/or the invited-people allowlist. */
export interface ShareAudiencePatch {
	/** `public` bearer, `org` (any signed-in member ∪ recipients), or `people` (recipients only). */
	readonly visibility?: "public" | "org" | "people";
	/** Replacement allowlist (lowercased emails, never the owner). */
	readonly recipients?: ReadonlyArray<string>;
}

/**
 * Revokes a subject's link (if present) and clears its record. Idempotent.
 *
 * Only touches the local record when it belongs to the CURRENT backend (the env-scoped
 * `getShare` resolves it). A record minted against a DIFFERENT backend reads as absent
 * here and is left on disk rather than deleted, so its still-live link stays revocable
 * after switching the API key back — deleting it would orphan the link server-side.
 */
export async function revokeShare(
	workspaceRoot: string,
	branch: string,
	apiKey: string,
	commitHash?: string,
): Promise<void> {
	const existing = await getShare(workspaceRoot, branch, deriveJolliBackendKeyFromApiKey(apiKey), commitHash);
	if (existing?.shareId) {
		await revokeBranchShare(undefined, apiKey, existing.shareId);
	}
	// Clear the local record whenever it belongs to the CURRENT backend (getShare
	// only returns current-backend records) — including a partial record that never
	// got a shareId — so a stale entry never lingers. A foreign-backend record reads
	// as absent (existing === undefined) and is deliberately left on disk.
	if (existing) {
		await removeShare(workspaceRoot, branch, commitHash);
	}
}

/**
 * Changes the subject's audience — the visibility tier (`public`↔`org`↔`people`)
 * and/or the invited-people allowlist — via PATCH, mirroring the server-confirmed
 * values into the single record. The link flips in place (same `shareId`); the URL
 * is re-issued for the new tier. Flipping to `public` drops the recipients
 * allowlist (the server does too). Returns the updated record, or `undefined` when
 * there is no link.
 */
export async function patchShareAudience(
	workspaceRoot: string,
	branch: string,
	apiKey: string,
	patch: ShareAudiencePatch,
	commitHash?: string,
): Promise<BranchShareRecord | undefined> {
	const existing = await getShare(workspaceRoot, branch, deriveJolliBackendKeyFromApiKey(apiKey), commitHash);
	if (!existing?.shareId) return undefined;
	const result = await updateLiveShare(undefined, apiKey, existing.shareId, {
		...(patch.visibility && { visibility: patch.visibility }),
		...(patch.recipients && { recipients: patch.recipients }),
	});
	// Prefer the visibility we ASKED for: the PATCH didn't throw, so the flip took.
	// Trusting the server echo instead let a stale/omitted echo silently revert the
	// tier (e.g. flip to public rendered back as org). Fall back to the echo, then
	// the existing value, for a recipients-only patch that carries no visibility.
	const nextVisibility = patch.visibility ?? result.visibility ?? existing.visibility;
	// Public bearer links never carry an allowlist — drop recipients on a flip to public.
	const nextRecipients =
		nextVisibility === "public" ? undefined : (result.recipients ?? patch.recipients ?? existing.recipients);
	const { recipients: _drop, ...base } = existing;
	const updated: BranchShareRecord = {
		...base,
		shareId: String(result.shareId ?? existing.shareId),
		// An audience-only PATCH doesn't re-mint the link, so the server may omit
		// `shareUrl` — keep the existing one in that case.
		shareUrl: result.shareUrl || existing.shareUrl,
		visibility: nextVisibility,
		expiresAt: result.expiresAt ?? existing.expiresAt,
		...(nextRecipients && nextRecipients.length > 0 ? { recipients: nextRecipients } : {}),
	};
	await putBranchShare(workspaceRoot, branch, updated, commitHash);
	return updated;
}

/** Re-exports the persistence reads the panel/modal need when (re)opening the modal. */
export { getShare, getShareWithBranchLatest, putBranchShare };

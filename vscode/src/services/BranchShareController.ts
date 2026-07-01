/**
 * BranchShareController
 *
 * Share lifecycle helpers shared by the modal: revoke a share and adjust its
 * expiry. Pure orchestration — no VS Code/webview dependency — so it is
 * unit-testable. Creation lives in `LiveShareController` (live, Space-backed);
 * the old snapshot create path has been removed.
 */

import {
	getBranchShare,
	isPublicConfirmed,
	markPublicConfirmed,
	putBranchShare,
	removeBranchShare,
} from "../../../cli/src/core/BranchShareStore.js";
import { revokeBranchShare, updateBranchShareExpiry, updateLiveShare } from "./JolliShareService.js";

/** Access level for a live share. */
type ShareVisibility = "public" | "org" | "people";

/** Revokes a subject's share (if any) and clears the local record. Idempotent. */
export async function revokeBranchShareForBranch(
	workspaceRoot: string,
	branch: string,
	apiKey: string,
	commitHash?: string,
): Promise<void> {
	const existing = await getBranchShare(workspaceRoot, branch, commitHash);
	if (existing?.shareId) {
		await revokeBranchShare(undefined, apiKey, existing.shareId);
	}
	await removeBranchShare(workspaceRoot, branch, commitHash);
}

/**
 * Adjusts an existing share's expiry (absolute ISO `expiresAt`) via PATCH and
 * mirrors the server-confirmed value into the local record, **preserving** the
 * live reference (`ref`), visibility, and local recipient list. Returns the new
 * `expiresAt`, or `undefined` when there is no share to patch.
 */
export async function setBranchShareExpiry(
	workspaceRoot: string,
	branch: string,
	apiKey: string,
	expiresAt: string,
	commitHash?: string,
): Promise<string | undefined> {
	const existing = await getBranchShare(workspaceRoot, branch, commitHash);
	if (!existing?.shareId) return undefined;
	const result = await updateBranchShareExpiry(undefined, apiKey, existing.shareId, expiresAt);
	await putBranchShare(
		workspaceRoot,
		branch,
		{
			shareId: existing.shareId,
			shareUrl: existing.shareUrl,
			visibility: existing.visibility,
			ref: existing.ref,
			token8: existing.token8,
			recipients: existing.recipients,
			headCommitHash: existing.headCommitHash,
			expiresAt: result.expiresAt,
			decisionCount: existing.decisionCount,
			titles: existing.titles,
			commitHash: existing.commitHash,
		},
		commitHash,
	);
	return result.expiresAt;
}

/**
 * Changes an existing share's audience — access level (`public` / `org` / `people`) and,
 * for `people`, the `recipients` allowlist — via PATCH, mirroring the server-confirmed
 * values into the local record. Switching to/from `public` re-mints (or drops) the bearer
 * link, so the returned `shareUrl`/`token` can change — all are persisted. Returns the new
 * visibility, or `undefined` when there is no share.
 */
export async function setBranchShareVisibility(
	workspaceRoot: string,
	branch: string,
	apiKey: string,
	visibility: ShareVisibility,
	commitHash?: string,
	recipients?: ReadonlyArray<string>,
): Promise<ShareVisibility | undefined> {
	const existing = await getBranchShare(workspaceRoot, branch, commitHash);
	if (!existing?.shareId) return undefined;
	const result = await updateLiveShare(undefined, apiKey, existing.shareId, {
		visibility,
		...(recipients && { recipients }),
	});
	const nextVisibility = result.visibility ?? visibility;
	const token8 = result.token ? result.token.slice(0, 8) : nextVisibility === "public" ? existing.token8 : undefined;
	const nextRecipients = result.recipients ?? (nextVisibility === "people" ? recipients ?? existing.recipients : undefined);
	await putBranchShare(
		workspaceRoot,
		branch,
		{
			shareId: String(result.shareId ?? existing.shareId),
			// A recipients-only PATCH doesn't re-mint the link, so the server may omit
			// `shareUrl` — keep the existing one in that case.
			shareUrl: result.shareUrl || existing.shareUrl,
			visibility: nextVisibility,
			ref: existing.ref,
			...(token8 ? { token8 } : {}),
			...(nextRecipients ? { recipients: nextRecipients } : {}),
			headCommitHash: existing.headCommitHash,
			expiresAt: result.expiresAt ?? existing.expiresAt,
			decisionCount: existing.decisionCount,
			titles: existing.titles,
			commitHash: existing.commitHash,
		},
		commitHash,
	);
	return nextVisibility;
}

/** Re-exports the persistence reads the panel/modal need when (re)opening the modal. */
export { getBranchShare, isPublicConfirmed, markPublicConfirmed };

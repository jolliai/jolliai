/**
 * BranchShareModal
 *
 * State machine behind the in-panel "Share" modal. Each webview message (open /
 * copy-link / set-access / send-invite / remove-recipient / stop-link /
 * open-target) maps to one entry point that computes the next modal state and
 * pushes it back through the injected `ShareModalIO`. UI-agnostic so it is fully
 * unit-testable; the panel supplies a VS Code-backed IO.
 *
 * Shares are **live** (Space-backed) and **single-slot**: a subject has at most
 * ONE link, whose access level is one of:
 *  - **public** — bearer-token URL, anyone with the link, no login.
 *  - **org** — auth-gated `/view`, any signed-in member (∪ any invited recipients).
 *  - **people** — auth-gated `/view`, invited recipients only.
 *
 * Changing access flips that one link in place (the server re-issues the URL for
 * the new tier and the old one dies). Links are LAZY: opening the modal never
 * creates anything — the first Copy, access change, or Send invite mints the link
 * (pushing content via `LiveShareController`). A `people` link with nobody invited
 * would be a dead owner-only link, so it is revoked rather than kept.
 */

import { getShare, patchShareAudience, putBranchShare, revokeShare } from "./BranchShareController.js";
import { assertJolliOriginAllowed } from "../../../cli/src/core/JolliApiUtils.js";
import type { BindingOutcome } from "./JolliPushOrchestrator.js";
import type { BranchShareRecord } from "../../../cli/src/core/BranchShareStore.js";
import { countSubjectDecisions, generateLiveShare, NothingToShareError, reconcileLiveShare } from "./LiveShareController.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import { sendShareInviteAndGrantAccess } from "./JolliShareService.js";
import { ShareBindingError } from "./JolliPushOrchestrator.js";
import type { CommitSummary } from "../../../cli/src/Types.js";

/** Whether a share covers a whole branch or a single commit. */
export type ShareKind = "branch" | "commit";

/** The single link's access level. */
export type ShareVisibility = "public" | "org" | "people";

/** A directory entry (org member or git contributor) offered as an add-people suggestion. */
export interface ShareMember {
	readonly name: string;
	readonly email: string;
}

/** The subject's single link as rendered: URL + access tier + invited people. */
export interface ShareLinkState {
	readonly shareUrl: string;
	/** Access tier: `public` bearer, `org` (any signed-in member ∪ recipients), or `people`. */
	readonly visibility: ShareVisibility;
	/** Invited people (lowercased emails, never the owner). Empty for `public`. */
	readonly recipients: ReadonlyArray<string>;
}

/** The render states the modal can be in. Mirrored by the webview client. */
export type ShareModalState =
	| { readonly kind: "needsApiKey" }
	| { readonly kind: "loading"; readonly label: string }
	| {
			readonly kind: "ready";
			readonly branch: string;
			/** Display label for the share subject (branch name, or "branch · commit <hash8>"). */
			readonly subject: string;
			/** Human title for the popover subtitle: commit message (commit) or branch name (branch). */
			readonly subjectTitle: string;
			readonly decisionCount: number;
			/** Whether the org tier is offered (the API key carries an org). */
			readonly canOrg: boolean;
			/** The subject's single link, when minted. */
			readonly share?: ShareLinkState;
			/** "From your jolli account" suggestion group (org members). */
			readonly accountMembers: ReadonlyArray<ShareMember>;
			/** "Git collaborators" suggestion group (repo contributors not in the account group). */
			readonly gitCollaborators: ReadonlyArray<ShareMember>;
			/** The current user — rendered as the fixed Owner row. */
			readonly owner: ShareMember;
	  }
	| { readonly kind: "error"; readonly message: string };

/** Non-state feedback for a Copy action (the webview flashes the button). */
export interface ShareCopyResult {
	readonly ok: boolean;
}

export interface ShareModalIO {
	postState(state: ShareModalState): void;
	/** Writes the link to the OS clipboard host-side; resolves false on failure. */
	copyToClipboard(text: string): Promise<boolean>;
	/** Tells the webview a Copy finished (button flashes "Copied!" on ok). */
	postCopyResult(result: ShareCopyResult): void;
	/** Surfaces a non-fatal error to the user (host toast) without tearing down the modal. */
	notifyError(message: string): void;
	/** Surfaces a confirmation (host info toast) — e.g. after a link is stopped. */
	notifyInfo(message: string): void;
}

export interface ShareModalContext {
	readonly workspaceRoot: string;
	readonly branch: string;
	readonly apiKey: string | undefined;
	/** Set for a single-commit share; omit for a whole-branch share. Drives keying + subject. */
	readonly commitHash?: string;
	/** The exact open memory for a single-commit share; branch shares omit it. */
	readonly commitSummary?: CommitSummary;
	/** Human title for the popover subtitle: commit message (commit share) or branch name (branch share). */
	readonly subjectTitle: string;
	/** Whether the org tier is offered (API key carries an org). */
	readonly canOrg: boolean;
	/** The current user (share owner) — the fixed Owner row; never on the allowlist. */
	readonly owner: ShareMember;
	/** "From your jolli account" suggestion group (org members, capped upstream). */
	readonly accountMembers: ReadonlyArray<ShareMember>;
	/** "Git collaborators" suggestion group (contributors not already in the account group). */
	readonly gitCollaborators: ReadonlyArray<ShareMember>;
	/** Loads/persists summaries for the live push (LiveShareController needs it). */
	readonly bridge: JolliMemoryBridge;
	/** Opens the binding chooser; injected so chooser UI stays in the panel. */
	readonly resolveBinding: (repoUrl: string) => Promise<BindingOutcome>;
	/** Host clock (Date.now()) for the expiry check — injected for testability. */
	readonly nowMs?: number;
}

/** Display label for the share subject: branch name, or "branch · commit <hash8>". */
function shareSubject(ctx: ShareModalContext): string {
	return ctx.commitHash ? `${ctx.branch} · commit ${ctx.commitHash.slice(0, 8)}` : ctx.branch;
}

/**
 * Opens the modal. NEVER creates a link (lazy model) — it renders whatever link
 * already exists. A live branch share renders the CURRENT base..HEAD, so an
 * existing branch link reconciles before showing; commit shares are a fixed doc
 * list and don't reconcile.
 */
export async function openShareModal(io: ShareModalIO, ctx: ShareModalContext): Promise<void> {
	if (!ctx.apiKey) {
		io.postState({ kind: "needsApiKey" });
		return;
	}
	const existing = await getShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash);
	// Only reconcile a LIVE (unexpired) branch share — reconciling an expired one
	// would re-push all content + PATCH a dead link (and could resurrect it), only
	// for postReadyState to then render it as absent.
	if (!ctx.commitHash && isLive(existing, ctx.nowMs) && existing.ref?.kind === "branchCollection") {
		io.postState({ kind: "loading", label: "Syncing to Jolli…" });
		try {
			await reconcileLiveShare(
				{
					bridge: ctx.bridge,
					workspaceRoot: ctx.workspaceRoot,
					apiKey: ctx.apiKey,
					resolveBinding: ctx.resolveBinding,
				},
				ctx.branch,
			);
		} catch (err) {
			// Best-effort: on failure fall back to the cached record.
			io.notifyError(`Couldn't refresh the shared content: ${errMessage(err)}`);
		}
	}
	await postReadyState(io, ctx);
}

/**
 * Copies the subject's link, minting it first when needed (the lazy-create
 * moment). Mints at the requested `visibility` — except `people`, which needs at
 * least one invitee, so a missing/empty `people` link is reported (Send invite
 * mints it), never minted here.
 */
export async function copyShareLinkModal(io: ShareModalIO, ctx: ShareModalContext, visibility: ShareVisibility): Promise<void> {
	if (!ctx.apiKey) {
		io.postState({ kind: "needsApiKey" });
		// The webview disabled the Copy button on click; re-enable it, or it stays
		// stuck disabled until the whole panel is rebuilt.
		io.postCopyResult({ ok: false });
		return;
	}
	let record = await getShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash);
	// Copying an EXISTING link must not repaint the pane (mockup: copy + flash only);
	// only a lazy mint swaps to loading and needs the ready re-render afterwards.
	let minted = false;
	let patched = false;
	if (!isLive(record, ctx.nowMs)) {
		if (visibility === "people") {
			io.notifyError("No one is invited yet — pick a teammate above first, or switch who can open the link.");
			io.postCopyResult({ ok: false });
			return;
		}
		// Silent mint: the pane must NOT swap to a spinner (mockup keeps the card
		// still); the webview disables the button until the copy-result ack lands.
		const generated = await generate(io, ctx, visibility, null);
		if (!generated) {
			io.postCopyResult({ ok: false });
			return;
		}
		minted = true;
		record = await getShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash);
	} else if (record.visibility !== visibility) {
		if (visibility === "people" && (record.recipients ?? []).length === 0) {
			io.notifyError("No one is invited yet — pick a teammate above first, or switch who can open the link.");
			io.postCopyResult({ ok: false });
			return;
		}
		try {
			record = (await patchShareAudience(ctx.workspaceRoot, ctx.branch, ctx.apiKey, { visibility }, ctx.commitHash)) ?? record;
			patched = true;
		} catch (err) {
			io.notifyError(`Couldn't update who can open this link: ${errMessage(err)}`);
			io.postCopyResult({ ok: false });
			return;
		}
	}
	const ok = Boolean(record?.shareUrl) && (await safeCopy(io, record?.shareUrl ?? ""));
	io.postCopyResult({ ok });
	if (minted || patched) await postReadyState(io, ctx);
}

/**
 * Sets the subject link's access tier (the "General access" dropdown). Flips an
 * existing link in place (the server re-issues the URL and the old one dies), or
 * mints one when none exists. `people` with nobody invited is a dead owner-only
 * link, so: flipping an existing link to empty `people` stops it, and selecting
 * `people` with no link yet mints nothing (Send invite will).
 */
export async function setShareAccessModal(io: ShareModalIO, ctx: ShareModalContext, visibility: ShareVisibility): Promise<void> {
	if (!ctx.apiKey) {
		io.postState({ kind: "needsApiKey" });
		return;
	}
	const existing = await getShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash);
	if (!existing?.shareId) {
		// No link yet: `people` needs an invitee first (mint on Send invite); `public`
		// and `org` mint immediately so the dropdown choice yields a copyable link.
		// Silent mint (null label): the card must NOT swap to the spinner pane — the
		// dropdown keeps the user's selection and the SYNCING badge shows progress
		// (mirrors copyShareLinkModal). Switching panes here reset the dropdown.
		if (visibility !== "people") {
			const generated = await generate(io, ctx, visibility, null);
			// On failure generate() already posted the error pane — don't overwrite it
			// with a ready render (which would silently hide the failure).
			if (!generated) return;
		}
		await postReadyState(io, ctx);
		return;
	}
	try {
		if (visibility === "people" && (existing.recipients ?? []).length === 0) {
			// "Only people you add" with nobody invited = a link only the owner could open — stop it.
			await revokeShare(ctx.workspaceRoot, ctx.branch, ctx.apiKey, ctx.commitHash);
			io.notifyInfo("Link stopped — no one was invited.");
		} else if (existing.visibility !== visibility) {
			await patchShareAudience(ctx.workspaceRoot, ctx.branch, ctx.apiKey, { visibility }, ctx.commitHash);
		}
	} catch (err) {
		io.notifyError(`Couldn't update who can open this link: ${errMessage(err)}`);
	}
	await postReadyState(io, ctx);
}

/**
 * Sends email invites: ensures the link exists as a member link (minting `people`
 * when none, or flipping a `public` link to `people` — inviting specific people
 * tightens a public link), then calls the server's invite endpoint, which grants
 * access (merges the emails into the allowlist) AND emails each recipient in one
 * step. Mail failures don't revoke access; they are reported. An `org` link keeps
 * its tier — invited people are added on top of site-wide access (grants union).
 */
export async function sendInviteModal(
	io: ShareModalIO,
	ctx: ShareModalContext,
	recipients: ReadonlyArray<string>,
	message?: string,
	visibility?: ShareVisibility,
): Promise<void> {
	if (!ctx.apiKey) {
		io.postState({ kind: "needsApiKey" });
		return;
	}
	const ownerLower = ctx.owner.email.trim().toLowerCase();
	const emails = [...new Set(recipients.map((e) => e.trim().toLowerCase()).filter((e) => e && e !== ownerLower))];
	if (emails.length === 0) {
		io.notifyError("Add at least one person to invite.");
		await postReadyState(io, ctx);
		return;
	}
	// Honor the tier the user had selected: `org` keeps site-wide access with the
	// invitees layered on (grants union); anything else (people, or public — which
	// can't carry an allowlist) resolves to a `people` link.
	const targetTier: ShareVisibility = visibility === "org" ? "org" : "people";
	let record = await getShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash);
	let mintedForInvite = false;
	let reTieredFrom: ShareVisibility | undefined;
	if (!isLive(record, ctx.nowMs)) {
		const generated = await generate(io, ctx, targetTier, "Creating link…");
		if (!generated) {
			// The webview optimistically closed the popover before this ran, so an
			// error posted into the hidden overlay is invisible — report via a toast.
			io.notifyError("Couldn't create the share link — there may be nothing to share, or it couldn't be bound to your Jolli account.");
			return;
		}
		mintedForInvite = true;
		record = await getShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash);
	} else if (record.visibility !== targetTier) {
		// The live link's tier differs from the one the invite targets — flip it in
		// place FIRST so access matches the selection, not just the recipient list.
		// Covers a public link (can't hold an allowlist) AND an `org` link the user
		// meant to tighten to `people` (otherwise the invite would silently leave it
		// open to the whole workspace). Remember the prior tier for rollback on failure.
		const from = record.visibility;
		try {
			await patchShareAudience(ctx.workspaceRoot, ctx.branch, ctx.apiKey, { visibility: targetTier }, ctx.commitHash);
		} catch (err) {
			io.notifyError(`Couldn't update the link's access before inviting: ${errMessage(err)}`);
			await postReadyState(io, ctx);
			return;
		}
		reTieredFrom = from;
		record = await getShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash);
	}
	if (!record?.shareId) {
		// Popover already closed (see above) — a toast is the only visible channel.
		io.notifyError("The link could not be created — please try again.");
		return;
	}
	// No loading pane here: the webview already returned to the main view optimistically
	// (mockup behavior) and shows the SYNCING badge; toasts report the outcome below.
	try {
		const result = await sendShareInviteAndGrantAccess(undefined, ctx.apiKey, record.shareId, {
			recipients: emails,
			...(message?.trim() ? { message: message.trim() } : {}),
		});
		// Access was granted server-side for every requested email (mail failures
		// don't revoke it) — mirror the merged allowlist locally.
		const merged = [...new Set([...(record.recipients ?? []), ...emails])];
		await putBranchShare(ctx.workspaceRoot, ctx.branch, { ...record, recipients: merged }, ctx.commitHash);
		if (result.sent.length > 0) {
			io.notifyInfo(`Invite sent to ${result.sent.length} ${result.sent.length === 1 ? "person" : "people"}.`);
		}
		if (result.failed.length > 0) {
			io.notifyError(`Access granted, but the email couldn't be sent to: ${result.failed.join(", ")}`);
		}
	} catch (err) {
		io.notifyError(`Couldn't send the invite: ${errMessage(err)}`);
		try {
			if (mintedForInvite) {
				await revokeShare(ctx.workspaceRoot, ctx.branch, ctx.apiKey, ctx.commitHash);
			} else if (reTieredFrom) {
				await patchShareAudience(ctx.workspaceRoot, ctx.branch, ctx.apiKey, { visibility: reTieredFrom }, ctx.commitHash);
			}
		} catch (rollbackErr) {
			io.notifyError(`Couldn't restore the previous link access: ${errMessage(rollbackErr)}`);
		}
	}
	await postReadyState(io, ctx);
}

/**
 * Removes one invited person from the link (no email involved). Removing the LAST
 * person while the tier is `people` stops the link entirely (a `people` link with
 * nobody invited is a dead owner-only link); an `org` link keeps its site-wide
 * access even with an empty allowlist.
 */
export async function removeRecipientModal(io: ShareModalIO, ctx: ShareModalContext, email: string): Promise<void> {
	if (!ctx.apiKey) {
		io.postState({ kind: "needsApiKey" });
		return;
	}
	const record = await getShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash);
	if (record?.shareId) {
		const lower = email.trim().toLowerCase();
		const next = (record.recipients ?? []).filter((r) => r.toLowerCase() !== lower);
		try {
			if (next.length === 0 && record.visibility === "people") {
				await revokeShare(ctx.workspaceRoot, ctx.branch, ctx.apiKey, ctx.commitHash);
				io.notifyInfo("Link stopped — no one is invited anymore.");
			} else {
				await patchShareAudience(ctx.workspaceRoot, ctx.branch, ctx.apiKey, { recipients: next }, ctx.commitHash);
			}
		} catch (err) {
			io.notifyError(`Couldn't remove ${email}: ${errMessage(err)}`);
		}
	}
	await postReadyState(io, ctx);
}

function assertSafeShareUrl(url: string): void {
	const parsed = new URL(url);
	assertJolliOriginAllowed(parsed.origin);
}

/** Copies via the IO, mapping a thrown/false clipboard failure to `false`. */
async function safeCopy(io: ShareModalIO, url: string): Promise<boolean> {
	try {
		assertSafeShareUrl(url);
		return await io.copyToClipboard(url);
	} catch (err) {
		io.notifyError(`Couldn't copy the link: ${errMessage(err)}`);
		return false;
	}
}

/**
 * Creates/refreshes the subject's link (pushing the subject's content). Returns
 * false (after posting `error`) when generation failed. A null `label` mints
 * silently — no loading pane (the card stays put).
 */
async function generate(
	io: ShareModalIO,
	ctx: ShareModalContext,
	visibility: ShareVisibility,
	label: string | null,
): Promise<boolean> {
	if (label !== null) io.postState({ kind: "loading", label });
	try {
		// apiKey is guaranteed non-null by the callers' guards.
		await generateLiveShare({
			bridge: ctx.bridge,
			workspaceRoot: ctx.workspaceRoot,
			apiKey: ctx.apiKey as string,
			resolveBinding: ctx.resolveBinding,
			branch: ctx.branch,
			commitHash: ctx.commitHash,
			commitSummary: ctx.commitSummary,
			visibility,
		});
		return true;
	} catch (err) {
		io.postState({ kind: "error", message: generateErrorMessage(err) });
		return false;
	}
}

/** Maps a generate failure to a user-facing message (binding vs nothing-to-share vs generic). */
function generateErrorMessage(err: unknown): string {
	if (err instanceof ShareBindingError) {
		if (err.outcome === "anotherOpen") {
			return "A Memory space chooser is already open for this repo. Finish there, then share again.";
		}
		if (err.outcome === "cancelled") {
			return "Sharing needs a Memory space — none was chosen. Reopen Share to pick one.";
		}
		return "Sharing needs a Memory space, but one couldn't be set up. Try again.";
	}
	if (err instanceof NothingToShareError) return err.message;
	return `Could not create share link: ${errMessage(err)}`;
}

/** Reads the subject's link and posts the `ready` state (expired/untrusted links render as absent). */
async function postReadyState(io: ShareModalIO, ctx: ShareModalContext): Promise<void> {
	const record = presentable(await getShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash), ctx.nowMs);
	// A shared subject's count is cached on the record; before the first share there is
	// no record, so compute the current subject's count (commit: free from the open
	// summary; branch: one base..HEAD load) rather than showing a misleading "0".
	const decisionCount =
		record?.decisionCount ?? (await countSubjectDecisions(ctx.bridge, ctx.workspaceRoot, ctx.commitHash, ctx.commitSummary));
	io.postState({
		kind: "ready",
		branch: ctx.branch,
		subject: shareSubject(ctx),
		subjectTitle: ctx.subjectTitle,
		decisionCount,
		canOrg: ctx.canOrg,
		...(record
			? {
					share: {
						shareUrl: record.shareUrl,
						visibility: record.visibility,
						recipients: record.recipients ?? [],
					},
				}
			: {}),
		accountMembers: ctx.accountMembers,
		gitCollaborators: ctx.gitCollaborators,
		owner: ctx.owner,
	});
}

/** A record that is live (unexpired) — expired links are dead links and render as absent. */
function isLive(rec: BranchShareRecord | undefined, nowMs: number | undefined): rec is BranchShareRecord {
	return Boolean(rec?.shareId && rec?.shareUrl) && !isExpired(rec?.expiresAt, nowMs);
}

/** A live record whose URL passes the origin allowlist; anything else renders as absent. */
function presentable(rec: BranchShareRecord | undefined, nowMs: number | undefined): BranchShareRecord | undefined {
	if (!isLive(rec, nowMs)) return undefined;
	try {
		assertSafeShareUrl(rec.shareUrl);
		return rec;
	} catch {
		return undefined;
	}
}

function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Whether a stored share's expiry has passed. Unknown clock / unparseable → treat as live. */
function isExpired(expiresAt: string | undefined, nowMs: number | undefined): boolean {
	if (!expiresAt || nowMs === undefined) return false;
	const t = Date.parse(expiresAt);
	return !Number.isNaN(t) && t <= nowMs;
}

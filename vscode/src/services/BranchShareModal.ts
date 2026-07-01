/**
 * BranchShareModal
 *
 * State machine behind the in-panel "Share" modal. Each webview message (open /
 * confirm / revoke / set-expiry / open-target) maps to one entry point that
 * computes the next modal state and pushes it back through the injected
 * `ShareModalIO`. UI-agnostic so it is fully unit-testable; the panel supplies a
 * VS Code-backed IO.
 *
 * Shares are **live** (Space-backed): `generate` pushes the subject's content to
 * the bound Space and records a share that references the live docs (via
 * `LiveShareController`). Access is `public` (anyone with the link), `org`
 * (anyone in the org), or `people` (server-gated allowlist). The Email action
 * still uses the current picker as a local `mailto:` delivery convenience. A live
 * share is never "stale" (it renders current membership), so there is no refresh
 * affordance.
 */

import {
	getBranchShare,
	markPublicConfirmed,
	revokeBranchShareForBranch,
	setBranchShareExpiry,
	setBranchShareVisibility,
} from "./BranchShareController.js";
import { assertJolliOriginAllowed } from "../../../cli/src/core/JolliApiUtils.js";
import type { BindingOutcome } from "./JolliPushOrchestrator.js";
import { generateLiveShare, NothingToShareError, reconcileLiveShare } from "./LiveShareController.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import { ShareBindingError } from "./JolliPushOrchestrator.js";
import type { SocialPlatform } from "./ShareMessage.js";
import type { CommitSummary } from "../../../cli/src/Types.js";

/** Whether a share covers a whole branch or a single commit. */
export type ShareKind = "branch" | "commit";

/** Access level for a live share. */
export type ShareVisibility = "public" | "org" | "people";

/**
 * A row in the redesigned popover's Collaborators list. Populated from the repo's
 * git contributors — this is a **visual mock** (no add/remove/role backend); the
 * current git user is flagged `isOwner`.
 */
export interface ShareCollaborator {
	readonly name: string;
	readonly email: string;
	readonly isOwner: boolean;
}

/** A directory entry (org member or git contributor) offered as an add-people suggestion. */
export interface ShareMember {
	readonly name: string;
	readonly email: string;
}

/**
 * Builds the Collaborators rows for the popover: the owner first (fixed, `isOwner`), then
 * one row per `recipients` email (the added people). Names are resolved from the `directory`
 * (org members + git contributors); unknown emails render as the bare address. The owner is
 * de-duped out of the recipients rows. Exported for unit testing.
 */
export function deriveShareCollaborators(
	owner: ShareMember,
	recipients: ReadonlyArray<string>,
	directory: ReadonlyArray<ShareMember>,
): ShareCollaborator[] {
	const nameByEmail = new Map(directory.map((m) => [m.email.trim().toLowerCase(), m.name]));
	const ownerLower = owner.email.trim().toLowerCase();
	const rows: ShareCollaborator[] = [{ name: owner.name || owner.email, email: owner.email, isOwner: true }];
	const seen = new Set<string>([ownerLower]);
	for (const raw of recipients) {
		const email = raw.trim();
		const lower = email.toLowerCase();
		if (!email || seen.has(lower)) continue;
		seen.add(lower);
		rows.push({ name: nameByEmail.get(lower) || email, email, isOwner: false });
	}
	return rows;
}

/** The render states the modal can be in. Mirrored by the webview client. */
export type ShareModalState =
	| { readonly kind: "needsApiKey" }
	| {
			readonly kind: "needsCreate";
			readonly branch: string;
			readonly subject: string;
			readonly subjectTitle: string;
			readonly visibility: ShareVisibility;
			readonly canOrg: boolean;
			readonly recipients: ReadonlyArray<string>;
			readonly orgMembers: ReadonlyArray<ShareMember>;
			readonly collaborators: ReadonlyArray<ShareCollaborator>;
	  }
	| { readonly kind: "loading"; readonly label: string }
	| {
			readonly kind: "ready";
			readonly branch: string;
			/** Display label for the share subject (branch name, or "branch · commit <hash8>"). */
			readonly subject: string;
			/** Human title for the popover subtitle: commit message (commit) or branch name (branch). */
			readonly subjectTitle: string;
			readonly shareUrl: string;
			readonly expiresLabel: string;
			/** Whole days until expiry (from `expiresAt`), so the picker can preselect the link's lifetime. */
			readonly expiryDays: number;
			readonly decisionCount: number;
			/** Access level — drives copy + which buttons show. */
			readonly visibility: ShareVisibility;
			/** Whether the `org` access option is available (the API key carries an org). */
			readonly canOrg: boolean;
			/** `people` allowlist (lowercased emails) — the added people who can open. */
			readonly recipients: ReadonlyArray<string>;
			/** Search-suggestion directory (org members + git contributors) for adding people. */
			readonly orgMembers: ReadonlyArray<ShareMember>;
			/** Rendered Collaborators rows = owner + one per recipient (names resolved from the directory). */
			readonly collaborators: ReadonlyArray<ShareCollaborator>;
	  }
	| { readonly kind: "error"; readonly message: string }
	/** Terminal: the share was stopped — the client dismisses the modal. */
	| { readonly kind: "revoked" };

export type ShareTarget = "page" | "email" | "copy" | SocialPlatform;

export interface ShareModalIO {
	postState(state: ShareModalState): void;
	openUrl(url: string): Promise<void>;
	/** Opens the user's mail client (mailto:) with the chosen recipients prefilled in `To:`. */
	composeEmail(
		branch: string,
		url: string,
		decisionCount: number,
		titles: ReadonlyArray<string>,
		recipients: ReadonlyArray<string>,
	): Promise<void>;
	/** Copies an attractive, content-teasing message (for Slack/IM) to the clipboard. */
	copyMessage(branch: string, url: string, decisionCount: number, titles: ReadonlyArray<string>): Promise<void>;
	/** Opens a social platform's pre-filled compose screen (copy tailored per platform host-side). */
	openSocial(
		platform: SocialPlatform,
		branch: string,
		url: string,
		decisionCount: number,
		titles: ReadonlyArray<string>,
	): Promise<void>;
	/** Formats an ISO expiry into a short human label (e.g. "expires Sep 1, 2026"). */
	formatExpiry(iso: string): string;
	/** Surfaces a non-fatal error to the user (host toast) without tearing down the modal. */
	notifyError(message: string): void;
	/** Surfaces a confirmation (host info toast) — e.g. after the share is stopped. */
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
	/** Access level chosen in the modal. Defaults to `public`. */
	readonly visibility: ShareVisibility;
	/**
	 * Recipients for the Email action, chosen in the pane at click time (local-only
	 * `mailto:` prefill — never sent to the server, and **not persisted**: a reopened
	 * share starts with an empty picker).
	 */
	readonly recipients: ReadonlyArray<string>;
	/** Link lifetime in days, chosen in step 1; applied at create time. Omit for the server default. */
	readonly expiryDays?: number;
	/** Whether the `org` access option is offered (API key carries an org). */
	readonly canOrg: boolean;
	/** The current user (share owner) — always the first, fixed Collaborators row. */
	readonly owner: ShareMember;
	/** Directory (org members + git contributors) for add-people search + name resolution. */
	readonly directory: ReadonlyArray<ShareMember>;
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
 * Opens the modal. Existing, unexpired links re-show immediately; otherwise the
 * user lands on a confirmation pane and must explicitly create the share link.
 */
export async function openShareModal(io: ShareModalIO, ctx: ShareModalContext): Promise<void> {
	if (!ctx.apiKey) {
		io.postState({ kind: "needsApiKey" });
		return;
	}
	const existing = await getBranchShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash);
	// An expired link is a dead link — don't re-serve it; re-sync a fresh one below.
	if (existing?.shareId && existing.shareUrl && !isExpired(existing.expiresAt, ctx.nowMs)) {
		// A live BRANCH share renders the CURRENT base..HEAD, so reconcile the `covered`
		// allowlist before showing — otherwise a share created before later commits keeps
		// serving the stale commit set. Commit shares are a fixed doc list and don't reconcile.
		// Best-effort: on failure fall back to the cached record.
		if (!ctx.commitHash && existing.ref?.kind === "branchCollection") {
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
				io.notifyError(`Couldn't refresh the shared content: ${errMessage(err)}`);
			}
		}
		const fresh = (await getBranchShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash)) ?? existing;
		postReadyState(io, ctx, fresh);
		return;
	}
	io.postState(needsCreateState(ctx));
}

/** Explicitly creates a share after the user confirms the audience/what-travels pane. */
export async function createShareModal(io: ShareModalIO, ctx: ShareModalContext): Promise<void> {
	if (!ctx.apiKey) {
		io.postState({ kind: "needsApiKey" });
		return;
	}
	await generate(io, ctx, ctx.visibility);
}

/**
 * Adjusts the current share's expiry (absolute ISO `expiresAt`) via PATCH — does
 * NOT re-push content. Re-renders the ready pane with the new expiry label.
 */
export async function setShareExpiryModal(io: ShareModalIO, ctx: ShareModalContext, expiresAt: string): Promise<void> {
	if (!ctx.apiKey) {
		io.postState({ kind: "needsApiKey" });
		return;
	}
	io.postState({ kind: "loading", label: "Updating expiry…" });
	try {
		await setBranchShareExpiry(ctx.workspaceRoot, ctx.branch, ctx.apiKey, expiresAt, ctx.commitHash);
	} catch (err) {
		io.notifyError(`Couldn't update the link's expiry: ${errMessage(err)}`);
	}
	const existing = await getBranchShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash);
	if (existing?.shareId && existing.shareUrl) {
		postReadyState(io, ctx, existing);
	} else {
		io.postState({ kind: "error", message: "This share is no longer available — create a new link." });
	}
}

/**
 * Changes an existing link's audience — access level (`public` / `org` / `people`) and,
 * for `people`, the `recipients` allowlist — via PATCH. Does NOT re-push content.
 * Re-renders the pane with the server-confirmed URL/visibility/recipients.
 */
export async function setShareVisibilityModal(
	io: ShareModalIO,
	ctx: ShareModalContext,
	visibility: ShareVisibility,
	recipients?: ReadonlyArray<string>,
): Promise<void> {
	if (!ctx.apiKey) {
		io.postState({ kind: "needsApiKey" });
		return;
	}
	// No `loading` pane here: the webview already reflected the audience change optimistically
	// (add/remove/switch) and shows a SYNCING badge; flipping to the loading pane would hide the
	// list. We post the authoritative `ready` (or `error`) once the PATCH resolves.
	// Switching to `public` opens a forwardable "anyone with the link" link — record
	// the one-time ack per branch (the redesigned popover has no separate confirm pane).
	if (visibility === "public") await markPublicConfirmed(ctx.workspaceRoot, ctx.branch);
	try {
		await setBranchShareVisibility(ctx.workspaceRoot, ctx.branch, ctx.apiKey, visibility, ctx.commitHash, recipients);
	} catch (err) {
		io.notifyError(`Couldn't update who can open this link: ${errMessage(err)}`);
	}
	const existing = await getBranchShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash);
	if (existing?.shareId && existing.shareUrl) {
		postReadyState(io, ctx, existing);
	} else {
		io.postState({ kind: "error", message: "This share is no longer available — create a new link." });
	}
}

/**
 * Stops sharing in one action: revoke the link, confirm via a toast, and signal
 * the client to dismiss the modal. (Revoke removes the grant only — the Space docs
 * are NOT deleted.)
 */
export async function revokeShareModal(io: ShareModalIO, ctx: ShareModalContext): Promise<void> {
	if (!ctx.apiKey) {
		io.postState({ kind: "needsApiKey" });
		return;
	}
	io.postState({ kind: "loading", label: "Stopping share…" });
	await revokeBranchShareForBranch(ctx.workspaceRoot, ctx.branch, ctx.apiKey, ctx.commitHash);
	io.notifyInfo("Sharing stopped — the link no longer works.");
	io.postState({ kind: "revoked" });
}

/** Opens the page, an email draft (with recipients), a copy, or a social compose for the current share. */
export async function shareModalTarget(io: ShareModalIO, ctx: ShareModalContext, target: ShareTarget): Promise<void> {
	const existing = await getBranchShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash);
	if (!existing?.shareUrl) return;
	try {
		assertSafeShareUrl(existing.shareUrl);
	} catch (err) {
		io.postState({ kind: "error", message: `This share link is not trusted: ${errMessage(err)}` });
		return;
	}
	if (isExpired(existing.expiresAt, ctx.nowMs)) {
		io.postState({ kind: "error", message: "This link has expired — reopen Share to create a new one." });
		return;
	}
	const decisions = existing.decisionCount ?? 0;
	const titles = existing.titles ?? [];
	if (target === "page") await io.openUrl(existing.shareUrl);
	else if (target === "copy") await io.copyMessage(ctx.branch, existing.shareUrl, decisions, titles);
	else if (target === "email") {
		// Recipients are the live picker selection (session-only; not persisted).
		await io.composeEmail(ctx.branch, existing.shareUrl, decisions, titles, ctx.recipients);
	} else {
		await io.openSocial(target, ctx.branch, existing.shareUrl, decisions, titles);
	}
}

function assertSafeShareUrl(url: string): void {
	const parsed = new URL(url);
	assertJolliOriginAllowed(parsed.origin);
}

/** Creates/syncs the subject and reveals the SYNCED pane. A `public` create records the one-time forwardable-link ack. */
async function generate(io: ShareModalIO, ctx: ShareModalContext, visibility: ShareVisibility): Promise<void> {
	io.postState({ kind: "loading", label: "Syncing to Jolli…" });
	if (visibility === "public") await markPublicConfirmed(ctx.workspaceRoot, ctx.branch);
	try {
		// apiKey is guaranteed non-null by the callers' guards. Recipients are chosen
		// post-create, so none are sent here.
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
	} catch (err) {
		io.postState({ kind: "error", message: generateErrorMessage(err) });
		return;
	}
	// Apply the step-1 expiry choice before revealing the link (create uses the server
	// default; a non-default lifetime is set via the same PATCH the ready pane uses).
	if (ctx.expiryDays && ctx.expiryDays > 0) {
		try {
			const expiresAt = new Date((ctx.nowMs ?? Date.now()) + ctx.expiryDays * 24 * 60 * 60 * 1000).toISOString();
			await setBranchShareExpiry(ctx.workspaceRoot, ctx.branch, ctx.apiKey as string, expiresAt, ctx.commitHash);
		} catch (err) {
			io.notifyError(`Link created, but its expiry couldn't be set: ${errMessage(err)}`);
		}
	}
	// Read the freshly-stored record so the ready pane reflects what was persisted.
	const rec = await getBranchShare(ctx.workspaceRoot, ctx.branch, ctx.commitHash);
	if (!rec?.shareUrl) {
		io.postState({ kind: "error", message: "Share link could not be created — please try again." });
		return;
	}
	postReadyState(io, ctx, rec);
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

interface StoredShareLike {
	readonly shareUrl: string;
	readonly expiresAt: string;
	readonly decisionCount: number;
	readonly visibility: ShareVisibility;
	readonly recipients?: ReadonlyArray<string>;
}

function readyStateFromRecord(io: ShareModalIO, ctx: ShareModalContext, rec: StoredShareLike): ShareModalState {
	assertSafeShareUrl(rec.shareUrl);
	const recipients = rec.recipients ?? [];
	return {
		kind: "ready",
		branch: ctx.branch,
		subject: shareSubject(ctx),
		subjectTitle: ctx.subjectTitle,
		shareUrl: rec.shareUrl,
		expiresLabel: io.formatExpiry(rec.expiresAt),
		expiryDays: remainingDays(rec.expiresAt, ctx.nowMs),
		decisionCount: rec.decisionCount,
		visibility: rec.visibility,
		canOrg: ctx.canOrg,
		recipients,
		orgMembers: ctx.directory,
		collaborators: deriveShareCollaborators(ctx.owner, recipients, ctx.directory),
	};
}

function postReadyState(io: ShareModalIO, ctx: ShareModalContext, rec: StoredShareLike): void {
	try {
		io.postState(readyStateFromRecord(io, ctx, rec));
	} catch (err) {
		io.postState({ kind: "error", message: `This share link is not trusted: ${errMessage(err)}` });
	}
}

function needsCreateState(ctx: ShareModalContext): ShareModalState {
	const visibility = ctx.visibility === "public" && ctx.canOrg ? "org" : ctx.visibility;
	const recipients = visibility === "people" ? ctx.recipients : [];
	return {
		kind: "needsCreate",
		branch: ctx.branch,
		subject: shareSubject(ctx),
		subjectTitle: ctx.subjectTitle,
		visibility,
		canOrg: ctx.canOrg,
		recipients,
		orgMembers: ctx.directory,
		collaborators: deriveShareCollaborators(ctx.owner, recipients, ctx.directory),
	};
}

function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Whole days from now until `expiresAt` (≥0), so the picker preselects the link's lifetime. */
function remainingDays(expiresAt: string | undefined, nowMs: number | undefined): number {
	const end = expiresAt ? Date.parse(expiresAt) : Number.NaN;
	if (Number.isNaN(end)) return 0;
	return Math.max(0, Math.round((end - (nowMs ?? Date.now())) / (24 * 60 * 60 * 1000)));
}

/** Whether a stored share's expiry has passed. Unknown clock / unparseable → treat as live. */
function isExpired(expiresAt: string | undefined, nowMs: number | undefined): boolean {
	if (!expiresAt || nowMs === undefined) return false;
	const t = Date.parse(expiresAt);
	return !Number.isNaN(t) && t <= nowMs;
}

/**
 * LiveShareController
 *
 * Orchestrates a live, Space-backed share for a branch (or a single commit):
 *   1. push every summary on `base..HEAD` (and its plans/notes) to the bound Space
 *      via the shared push orchestrator, and
 *   2. create/refresh a live share that REFERENCES the resulting doc ids (a
 *      `covered` allowlist) — never a frozen content blob.
 *
 * UI-agnostic: the binding chooser is injected as `resolveBinding`. The webview
 * layer (SummaryWebviewPanel) wires that callback and renders the result.
 *
 * Cross-summary doc-id identity is the crux. A plan/note's `jolliPlanDocId` /
 * `jolliNoteDocId` is persisted onto whichever summary's push first minted it, and
 * the SAME plan (by base slug) / note (by id) recurs across many commits, each
 * mapping to ONE Space doc. So this controller owns a branch-wide map and:
 *   - pushes each unique plan/note exactly once, by the summary carrying its latest
 *     revision (oldest→newest, so the newest content wins), reusing the known docId
 *     so the one Space doc updates in place (never a duplicate);
 *   - builds each commit's `covered` attachment ids from that shared map, so a
 *     commit that references a plan pushed "under" another commit still points at
 *     the same live doc.
 *
 * A per-(workspaceRoot, branch) in-flight guard prevents overlapping generate /
 * reconcile passes from lost-updating `covered` (PATCH replaces it wholesale).
 */

import { createHash } from "node:crypto";
import type { CommitSummary } from "../../../cli/src/Types.js";
import { type LiveRef, getShare, putBranchShare } from "../../../cli/src/core/BranchShareStore.js";
import { getDefaultBranch } from "../../../cli/src/core/GitOps.js";
import { deriveJolliBackendKeyFromApiKey, parseJolliApiKey } from "../../../cli/src/core/JolliApiUtils.js";
import { extractRepoName } from "../../../cli/src/core/KBPathResolver.js";
import { slugify } from "../../../cli/src/core/SummaryExporter.js";
import { resolveEffectiveRecap, resolveEffectiveTopics } from "../../../cli/src/core/SummaryStore.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import { baseKeyOfItem, getContextKinds, selectItems } from "../../../cli/src/core/push/ContextKindRegistry.js";
import { assignOwnedContext, selectionForCommit } from "../../../cli/src/core/push/ContextPush.js";
import { deriveOwnerRepoFromUrl, getCanonicalRepoUrl } from "../util/GitRemoteUtils.js";
import { log } from "../util/Logger.js";
import { loadBranchSummaries } from "../views/BranchSummaryLoader.js";
import { buildBranchRelativePath } from "../views/SummaryUtils.js";
import type {
	BindingOutcome,
	PushAttachmentFailure,
	PushContext,
	PushedDoc,
} from "./JolliPushOrchestrator.js";
import { pushSummaryWithAttachments, ShareBindingError } from "./JolliPushOrchestrator.js";
import { PushDisabledError } from "./JolliPushService.js";
import { isRepoWideRefusal } from "../../../cli/src/core/PushRefusal.js";
import { createLiveShare, type LiveShareResult, updateLiveShare } from "./JolliShareService.js";

/** Raised when the share subject has no generated summaries to push. */
export class NothingToShareError extends Error {
	constructor(branch: string) {
		super(`No memories on "${branch}" yet — make a commit so Jolli can summarize it, then share.`);
		this.name = "NothingToShareError";
	}
}

/**
 * Raised when a branch push is asked to publish a branch that is no longer the
 * checked-out one. Every branch-collection path here loads the CURRENT HEAD's
 * `base..HEAD` (see {@link reconcileLiveShare}); `branch` only names the lock
 * and the share record. A push runs asynchronously after PR creation, so a
 * mid-flight `git checkout` would otherwise silently publish another branch's
 * memories under this branch's identity. Abort loudly instead.
 */
export class BranchMismatchError extends Error {
	constructor(requested: string, current: string) {
		super(
			`Branch changed from "${requested}" to "${current}" before sharing could run — skipped so the wrong branch's memories aren't published. Try sharing again from "${requested}".`,
		);
		this.name = "BranchMismatchError";
	}
}

/** Raised when one or more plan/note Space docs failed to upload. */
export class AttachmentPushError extends Error {
	constructor(readonly failures: ReadonlyArray<PushAttachmentFailure>) {
		super(`Could not sync shared plans/notes: ${formatAttachmentFailures(failures)}`);
		this.name = "AttachmentPushError";
	}
}

function formatAttachmentFailures(failures: ReadonlyArray<PushAttachmentFailure>): string {
	return failures.map((f) => `${f.label}: ${f.message}`).join("; ");
}

/** Dependencies the controller needs that aren't on the params. */
export interface LiveShareDeps {
	readonly bridge: JolliMemoryBridge;
	readonly workspaceRoot: string;
	readonly apiKey: string;
	readonly resolveBinding: (repoUrl: string) => Promise<BindingOutcome>;
}

export interface GenerateLiveShareParams extends LiveShareDeps {
	readonly branch: string;
	/** Set for a single-commit share; omit for a whole-branch share. */
	readonly commitHash?: string;
	/**
	 * The already-open summary for a single-commit share. When present, commit
	 * shares are sourced from this exact memory instead of filtering the current
	 * checkout's `base..HEAD` set, so sharing an open memory is stable across
	 * branch switches.
	 */
	readonly commitSummary?: CommitSummary;
	readonly visibility: "public" | "org" | "people";
	/** `people` allowlist (lowercased emails) sent to the server; omit for public/org. */
	readonly recipients?: ReadonlyArray<string>;
}

// One in-flight pass per (workspaceRoot, branch) — generate/reconcile for the same
// subject must not overlap, or a slower pass computed from an older base..HEAD
// could PATCH a stale `covered` over a newer one (PATCH replaces it wholesale).
const inFlight = new Map<string, Promise<unknown>>();

function withSubjectLock<T>(workspaceRoot: string, branch: string, work: () => Promise<T>): Promise<T> {
	const key = `${workspaceRoot}\u0000${branch}`;
	const prior = inFlight.get(key) ?? Promise.resolve();
	const next = prior.then(work, work);
	inFlight.set(
		key,
		next.then(
			() => undefined,
			() => undefined,
		),
	);
	return next;
}

/** Resolves the site base URL from the API key, or throws if it can't be derived. */
function resolveBaseUrl(apiKey: string): string {
	const baseUrl = parseJolliApiKey(apiKey)?.u;
	if (!baseUrl) {
		throw new Error(
			"Jolli site URL could not be determined. Please regenerate your Jolli API Key and set it again (STATUS panel → ...).",
		);
	}
	return baseUrl;
}

/** Loads the subject's summaries (chronological oldest→newest); a commit share filters to one. */
async function loadSubjectSummaries(
	bridge: JolliMemoryBridge,
	workspaceRoot: string,
	commitHash: string | undefined,
	commitSummary?: CommitSummary,
): Promise<ReadonlyArray<CommitSummary>> {
	if (commitHash && commitSummary?.commitHash === commitHash) return [commitSummary];
	const base = await getDefaultBranch(workspaceRoot);
	const { summaries } = await loadBranchSummaries(bridge, base);
	return commitHash ? summaries.filter((s) => s.commitHash === commitHash) : summaries;
}

/**
 * The published attachments of one push result, flattened out of the kind-agnostic
 * `pushedDoc.attachments` map.
 *
 * Reads ONLY that map — deliberately, even though `PushedDoc` still carries the
 * legacy `plans`/`notes`/`references` views for other consumers. An earlier version
 * fell back to those when `attachments` was absent, which is unreachable
 * (`pushSummaryWithAttachments` always sets it) and cost more than the dead branch:
 * the one caller that omitted the field was this file's own test double, so every
 * `covered`-allowlist assertion in the suite was exercising the fallback rather than
 * the path production takes. The double now builds the map.
 */
function publishedAttachmentsOf(doc: PushedDoc): ReadonlyArray<{ docType: string; baseKey: string; docId: number }> {
	const out: Array<{ docType: string; baseKey: string; docId: number }> = [];
	for (const [docType, docs] of doc.attachments) {
		for (const d of docs) out.push({ docType, baseKey: d.baseKey, docId: d.docId });
	}
	return out;
}

/**
 * Pushes the subject's summaries + deduped attachments and builds the live `ref`.
 * Shared by generate + reconcile so create-time and reconcile produce identical refs.
 *
 * Attachment dedup and the `covered` resolution are generic over the registered
 * context kinds ({@link assignOwnedContext} / {@link getContextKinds}) — a new
 * kind rides the share with no change here.
 */
async function pushSubjectAndBuildRef(
	subjectSummaries: ReadonlyArray<CommitSummary>,
	kind: "branch" | "commit",
	branch: string,
	ctx: PushContext,
): Promise<LiveRef> {
	// 1–2. Cross-commit dedup: winners + owned attachments + seed docId maps.
	const owned = assignOwnedContext(subjectSummaries);

	// 3. Push each summary oldest→newest with only its owned attachments. Capture the
	//    pushed summary docId per commit and accumulate the branch-wide per-kind
	//    docId maps, pre-seeded with any known docIds so a doc pushed under another
	//    commit still links.
	const docIdByKindBase = new Map<string, Map<string, number>>();
	for (const [docType, forKind] of owned) docIdByKindBase.set(docType, new Map(forKind.seeds));

	const summaryDocIds: number[] = [];
	// Best-effort kinds the server would not take. NOT surfaced to the user here, and
	// that is a deliberate split from the branch-push path: reconcile re-enters this
	// function on every modal open as a background pass, so a notification would fire
	// unprompted and repeatedly, and `LiveShareResult` — the only channel out of the
	// interactive caller — is the server's own response shape, not a place for
	// client-side diagnostics. One aggregated line so the share path has a single
	// searchable record instead of only the per-summary logs.
	const skippedLabels: string[] = [];
	for (const summary of subjectSummaries) {
		const result = await pushSummaryWithAttachments(summary, ctx, selectionForCommit(owned, summary.commitHash), {
			strictAttachments: true,
		});
		if (result.attachmentFailures.length > 0) {
			throw new AttachmentPushError(result.attachmentFailures);
		}
		skippedLabels.push(...result.skippedAttachments.map((f) => f.label));
		summaryDocIds.push(result.pushedDoc.summaryDocId);
		for (const a of publishedAttachmentsOf(result.pushedDoc)) {
			const byBase = docIdByKindBase.get(a.docType);
			if (byBase) byBase.set(a.baseKey, a.docId);
			else docIdByKindBase.set(a.docType, new Map([[a.baseKey, a.docId]]));
		}
	}

	if (skippedLabels.length > 0) {
		log.warn(
			"LiveShare",
			`share of ${branch}: skipped ${skippedLabels.length} attachment(s): ${skippedLabels.join(", ")}`,
		);
	}

	// 4. Build covered: each commit references its OWN attachments' docids, resolved
	//    via the shared per-kind maps (so a doc pushed under a different commit is
	//    still linked — each item keys on its kind's cross-commit baseKey).
	const coveredFor = (summary: CommitSummary): number[] => {
		const ids = new Set<number>();
		for (const contextKind of getContextKinds()) {
			const byBase = docIdByKindBase.get(contextKind.docType);
			if (byBase === undefined) continue;
			for (const item of selectItems(contextKind, summary)) {
				const docId = byBase.get(baseKeyOfItem(contextKind, item));
				if (docId) ids.add(docId);
			}
		}
		return [...ids];
	};

	if (kind === "commit") {
		return {
			kind: "commitDocs",
			summaryDocIds,
			attachmentDocIds: coveredFor(subjectSummaries[0]),
		};
	}
	return {
		kind: "branchCollection",
		relativePath: buildBranchRelativePath(branch),
		covered: subjectSummaries.map((s, i) => ({
			commitHash: s.commitHash,
			summaryDocId: summaryDocIds[i],
			attachmentDocIds: coveredFor(s),
		})),
	};
}

/**
 * Total decision (topic) count across the subject's summaries — sent to the server
 * (NOT-NULL column) and cached on the record so the modal subtitle needn't reload
 * summaries to show "N decisions".
 */
function countDecisions(summaries: ReadonlyArray<CommitSummary>): number {
	return summaries.reduce((total, s) => total + resolveEffectiveTopics(s).length, 0);
}

/**
 * Decision (topic) count for a subject from the live summaries — the modal uses this
 * ONLY as a fallback for a subject with no cached share record yet, so the subtitle
 * shows the real count BEFORE the first share. A commit share is free (the open
 * summary); a branch share loads base..HEAD once (only when unshared).
 */
export async function countSubjectDecisions(
	bridge: JolliMemoryBridge,
	workspaceRoot: string,
	commitHash?: string,
	commitSummary?: CommitSummary,
): Promise<number> {
	return countDecisions(await loadSubjectSummaries(bridge, workspaceRoot, commitHash, commitSummary));
}

/**
 * Content fingerprint of the subject's summaries — everything a push sends that a
 * memory edit can change WITHOUT a new git commit: per-commit topics + recap (the
 * recap is the share card's fallback when a summary has no topics) and the
 * plan/note revisions (`updatedAt` bumps on edit). `reconcileLiveShare` compares it
 * to skip the re-push only when the content is genuinely unchanged, so topic edits /
 * regenerated summaries / plan+note changes still republish even though HEAD didn't
 * move. Excludes push-assigned doc ids (they'd make the hash change on every push).
 */
export function subjectFingerprint(summaries: ReadonlyArray<CommitSummary>): string {
	const projection = summaries.map((s) => ({
		c: s.commitHash,
		t: resolveEffectiveTopics(s),
		// A topics-less summary renders its recap as the share card (server-side
		// fallback in BranchShareRouter.decisionsFromStructuredSummary), so a
		// recap-only edit must still move the hash and trigger a re-push.
		r: resolveEffectiveRecap(s) ?? null,
		p: (s.plans ?? []).map((pl) => [pl.slug, pl.updatedAt]),
		n: (s.notes ?? []).map((nt) => [nt.id, nt.updatedAt]),
		// References ride the share as first-class docs, so a new/updated reference
		// (its `referencedAt` bumps) must move the hash and trigger a re-push.
		f: (s.references ?? []).map((r) => [r.archivedKey, r.referencedAt]),
	}));
	return createHash("sha1").update(JSON.stringify(projection)).digest("hex").slice(0, 16);
}

/** Server accepts up to 500; 200 keeps the email card / share page line to a true one-liner. */
const SHARE_DESCRIPTION_MAX = 200;

/**
 * One-line blurb sent as the share's `description` (share page description line +
 * invite email card): the head commit's recap, falling back to its commit-message
 * subject. Whitespace-collapsed and capped at {@link SHARE_DESCRIPTION_MAX} chars.
 * Undefined when the head summary yields no text — the server keeps `null` and the
 * email simply omits the blurb block.
 */
export function deriveShareDescription(summaries: ReadonlyArray<CommitSummary>): string | undefined {
	const head = summaries[summaries.length - 1];
	if (!head) return undefined;
	// Truthy fallback, not `??`: a unified-hoist summary can carry `recap: ""`, and `??`
	// would keep the empty string instead of falling back to the commit subject.
	const raw = resolveEffectiveRecap(head) || head.commitMessage.split("\n")[0] || "";
	const oneLine = raw.replace(/\s+/g, " ").trim();
	if (oneLine.length === 0) return undefined;
	if (oneLine.length <= SHARE_DESCRIPTION_MAX) return oneLine;
	return `${oneLine.slice(0, SHARE_DESCRIPTION_MAX - 1).trimEnd()}…`;
}

/** Builds the push context (binding chooser injected) for a subject push. */
function buildPushContext(deps: LiveShareDeps, baseUrl: string, repoUrl: string): PushContext {
	return {
		baseUrl,
		apiKey: deps.apiKey,
		repoUrl,
		workspaceRoot: deps.workspaceRoot,
		storeSummary: (s, sync) => deps.bridge.storeSummary(s, sync),
		resolveBinding: deps.resolveBinding,
	};
}

/**
 * Creates (or refreshes, idempotent per repo+branch) a live share: pushes the
 * subject's content to the Space and records a share referencing the live docs.
 */
export function generateLiveShare(params: GenerateLiveShareParams): Promise<LiveShareResult> {
	return withSubjectLock(params.workspaceRoot, params.branch, async () => {
		const baseUrl = resolveBaseUrl(params.apiKey);
		const repoUrl = await getCanonicalRepoUrl(params.workspaceRoot);
		// Prefer the "owner/repo" full name (from the remote) so the share page shows
		// the two-segment "owner / repo" form; fall back to the bare name for a
		// local/remoteless repo where no owner segment exists.
		const repoName = deriveOwnerRepoFromUrl(repoUrl) || extractRepoName(params.workspaceRoot);
		const kind = params.commitHash ? "commit" : "branch";

		const subjectSummaries = await loadSubjectSummaries(
			params.bridge,
			params.workspaceRoot,
			params.commitHash,
			params.commitSummary,
		);
		if (subjectSummaries.length === 0) throw new NothingToShareError(params.branch);

		const ctx = buildPushContext(params, baseUrl, repoUrl);
		const ref = await pushSubjectAndBuildRef(subjectSummaries, kind, params.branch, ctx);

		const headCommitHash = subjectSummaries[subjectSummaries.length - 1].commitHash;
		const commitHashes = subjectSummaries.map((s) => s.commitHash);
		// Computed once from the just-loaded summaries: sent to the server AND cached
		// on the record so the modal subtitle needn't reload summaries to count.
		const decisionCount = countDecisions(subjectSummaries);
		const contentHash = subjectFingerprint(subjectSummaries);
		const description = deriveShareDescription(subjectSummaries);

		const result = await createLiveShare(baseUrl, params.apiKey, {
			repoUrl,
			repoName,
			branch: params.branch,
			kind,
			visibility: params.visibility,
			decisionCount,
			headCommitHash,
			commitHashes,
			branchSlug: slugify(params.branch),
			...(description && { description }),
			ref,
			...(params.recipients && { recipients: params.recipients }),
		});

		await putBranchShare(
			params.workspaceRoot,
			params.branch,
			{
				shareId: String(result.shareId),
				shareUrl: result.shareUrl,
				visibility: result.visibility,
				ref,
				...(result.recipients && { recipients: result.recipients }),
				headCommitHash,
				contentHash,
				expiresAt: result.expiresAt,
				decisionCount,
			},
			params.commitHash,
		);

		return result;
	});
}

/**
 * Reconciles the live share for the CURRENT branch (only if one exists): re-pushes
 * the current `base..HEAD` set and rebuilds `covered` from scratch (so dropped
 * commits / removed attachments fall out), then PATCHes the server. No-op when
 * there's no live branch-share record. Current-branch-only is a hard constraint —
 * `loadBranchSummaries` reads HEAD's `base..HEAD`.
 */
export function reconcileLiveShare(deps: LiveShareDeps, branch: string): Promise<void> {
	return withSubjectLock(deps.workspaceRoot, branch, async () => {
		const backendKey = deriveJolliBackendKeyFromApiKey(deps.apiKey);
		const existing = await getShare(deps.workspaceRoot, branch, backendKey);
		// Only a branch (branchCollection) share reconciles here; commit shares are a fixed doc list.
		if (!existing?.shareId || existing.ref?.kind !== "branchCollection") return;

		const subjectSummaries = await loadSubjectSummaries(deps.bridge, deps.workspaceRoot, undefined);
		if (subjectSummaries.length === 0) {
			log.info("LiveShare", `reconcile: ${branch} has no summaries; leaving share untouched`);
			return;
		}
		const headCommitHash = subjectSummaries[subjectSummaries.length - 1].commitHash;
		const contentHash = subjectFingerprint(subjectSummaries);
		// Content-staleness short-circuit: `contentHash` fingerprints what the last push
		// sent (topics + recap + plan/note revisions), so it moves on a NEW commit AND on a
		// memory edit that doesn't advance HEAD (topic edit, regenerated summary, plan/note
		// change). Skip the per-commit re-push + PATCH only when the content is genuinely
		// unchanged. A record missing the field (older cache) reads as stale and reconciles.
		if (existing.contentHash === contentHash) {
			log.info("LiveShare", `reconcile: ${branch} content unchanged (${contentHash}); skipping re-push`);
			return;
		}

		const baseUrl = resolveBaseUrl(deps.apiKey);
		const repoUrl = await getCanonicalRepoUrl(deps.workspaceRoot);
		const ctx = buildPushContext(deps, baseUrl, repoUrl);
		// Reconcile is a best-effort background pass (the share modal opens it on every
		// view), so a push-disabled repo just means "nothing to sync outbound" — skip
		// quietly and leave the cached record intact. Letting it escape would surface
		// the user's own opt-out as the modal's red "Couldn't refresh the shared
		// content" toast. Mirrors IntelliJ's LiveShareController reconcile branch.
		let ref: LiveRef;
		try {
			ref = await pushSubjectAndBuildRef(subjectSummaries, "branch", branch, ctx);
		} catch (err) {
			if (err instanceof PushDisabledError) {
				log.info("LiveShare", `reconcile: outbound push disabled for this repo; skipping re-push of ${branch}`);
				return;
			}
			throw err;
		}

		// Recap edits move `contentHash` (see subjectFingerprint), so the blurb refreshes
		// on the same reconcile that republishes the content.
		const description = deriveShareDescription(subjectSummaries);
		const result = await updateLiveShare(baseUrl, deps.apiKey, existing.shareId, {
			ref,
			...(description && { description }),
		});
		// A ref-only PATCH legitimately omits unchanged fields (shareUrl/recipients/…).
		// Preserve the existing values so the cached record stays reopen-able and the
		// allowlist isn't dropped; only `ref` and anything the server actually returned change.
		const recipients = result.recipients ?? existing.recipients;
		await putBranchShare(deps.workspaceRoot, branch, {
			shareId: String(result.shareId ?? existing.shareId),
			shareUrl: result.shareUrl || existing.shareUrl,
			visibility: result.visibility || existing.visibility,
			ref,
			...(recipients ? { recipients } : {}),
			headCommitHash,
			contentHash,
			expiresAt: result.expiresAt || existing.expiresAt,
			// Refreshed from the current base..HEAD (the covered set just changed).
			decisionCount: countDecisions(subjectSummaries),
		});
	});
}

/** Aggregate outcome of a branch content-push (no share link). */
export interface PushBranchMemoriesResult {
	readonly pushedCount: number;
	readonly attachmentCount: number;
	readonly attachmentFailures: ReadonlyArray<PushAttachmentFailure>;
	/**
	 * Summaries whose own article push failed with a non-fatal error (transient
	 * network / HTTP 5xx). Collected instead of aborting the batch so an early
	 * success is not lost when a later summary fails. Repo-wide conditions —
	 * binding, outdated plugin, push opt-out, permission refusal — never land
	 * here; they propagate and abort. `pushedCount` counts only successes.
	 */
	readonly summaryFailures: ReadonlyArray<PushAttachmentFailure>;
	/**
	 * Best-effort attachments (reference / skill) the server would not take, already
	 * aggregated one entry per kind per summary by the orchestrator.
	 *
	 * Reported rather than dropped for the same reason the summary panel reports them:
	 * this is a button the user pressed, and returning plain success while publishing
	 * fewer articles than the branch has context for misstates what happened. Kept out
	 * of `attachmentFailures` because these must never turn the push into a failure.
	 */
	readonly skippedAttachments: ReadonlyArray<PushAttachmentFailure>;
}

/**
 * Pushes all of a branch's memories (base..HEAD) to the bound Space as articles,
 * WITHOUT creating a share link. Reuses the same cross-commit plan/note dedup as
 * {@link generateLiveShare}. Best-effort on attachments (non-strict): a single
 * unreadable plan/note is collected into `attachmentFailures`, not thrown. Fatal
 * binding / plugin errors propagate (BindingRequiredError → ShareBindingError via
 * the injected `resolveBinding`), as do the repo-wide refusals
 * {@link PushDisabledError} and {@link PermissionDeniedError}. Throws
 * {@link NothingToShareError} when the branch has no summaries.
 */
export function pushBranchMemoriesToSpace(deps: LiveShareDeps, branch: string): Promise<PushBranchMemoriesResult> {
	return withSubjectLock(deps.workspaceRoot, branch, async () => {
		// `loadSubjectSummaries` reads the CURRENT HEAD's base..HEAD, so if HEAD
		// has moved off `branch` since the caller captured it, we'd push the wrong
		// branch's memories. Verify just before the load to keep the window minimal.
		const current = await deps.bridge.getCurrentBranch();
		if (current !== branch) throw new BranchMismatchError(branch, current);
		const baseUrl = resolveBaseUrl(deps.apiKey);
		const repoUrl = await getCanonicalRepoUrl(deps.workspaceRoot);
		const subjectSummaries = await loadSubjectSummaries(deps.bridge, deps.workspaceRoot, undefined);
		if (subjectSummaries.length === 0) throw new NothingToShareError(branch);

		const ctx = buildPushContext(deps, baseUrl, repoUrl);
		const owned = assignOwnedContext(subjectSummaries);

		let pushedCount = 0;
		let attachmentCount = 0;
		const attachmentFailures: PushAttachmentFailure[] = [];
		const skippedAttachments: PushAttachmentFailure[] = [];
		const summaryFailures: PushAttachmentFailure[] = [];
		for (const summary of subjectSummaries) {
			try {
				const result = await pushSummaryWithAttachments(summary, ctx, selectionForCommit(owned, summary.commitHash));
				pushedCount += 1;
				attachmentCount += result.attachmentCount;
				attachmentFailures.push(...result.attachmentFailures);
				skippedAttachments.push(...result.skippedAttachments);
			} catch (err) {
				// Fatal for the whole batch: every summary here belongs to the SAME repo,
				// so a repo-wide refusal (outdated plugin, this repo's push opt-out,
				// the server's allowlist/ownership verdict) fails all of them —
				// collecting them would report one condition as "Shared 0 memories, but
				// N failed" AND keep firing doomed requests for every remaining commit.
				// `ShareBindingError` is added on top: the chooser already ran and did
				// not produce a binding, so retrying the rest is equally pointless.
				//
				// Membership comes from `cli/src/core/PushRefusal.ts` rather than a local `instanceof`
				// chain, so a new repo-wide type is added once and every classifier picks
				// it up — and it is imported from a module no test stubs, so a partial
				// mock can't turn the predicate into `undefined`.
				if (isRepoWideRefusal(err) || err instanceof ShareBindingError) {
					throw err;
				}
				// Transient (network / HTTP 5xx): record and keep going so earlier
				// successes are not discarded by a later failure.
				summaryFailures.push({
					label: `memory "${summary.commitMessage.split("\n")[0]}"`,
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}
		return { pushedCount, attachmentCount, attachmentFailures, skippedAttachments, summaryFailures };
	});
}

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
import type { CommitSummary, PlanReference, NoteReference } from "../../../cli/src/Types.js";
import { type LiveRef, getShare, putBranchShare } from "../../../cli/src/core/BranchShareStore.js";
import { getDefaultBranch } from "../../../cli/src/core/GitOps.js";
import { parseJolliApiKey } from "../../../cli/src/core/JolliApiUtils.js";
import { extractRepoName } from "../../../cli/src/core/KBPathResolver.js";
import { slugify } from "../../../cli/src/core/SummaryExporter.js";
import { resolveEffectiveRecap, resolveEffectiveTopics } from "../../../cli/src/core/SummaryStore.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import { deriveOwnerRepoFromUrl, getCanonicalRepoUrl } from "../util/GitRemoteUtils.js";
import { log } from "../util/Logger.js";
import { planBaseKey } from "../util/PlanGrouping.js";
import { loadBranchSummaries } from "../views/BranchSummaryLoader.js";
import { buildBranchRelativePath } from "../views/SummaryUtils.js";
import type { BindingOutcome, PushAttachmentFailure, PushContext } from "./JolliPushOrchestrator.js";
import { pushSummaryWithAttachments } from "./JolliPushOrchestrator.js";
import { createLiveShare, type LiveShareResult, updateLiveShare } from "./JolliShareService.js";

/** Raised when the share subject has no generated summaries to push. */
export class NothingToShareError extends Error {
	constructor(branch: string) {
		super(`No memories on "${branch}" yet — make a commit so Jolli can summarize it, then share.`);
		this.name = "NothingToShareError";
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

/** The winner revision of a recurring plan/note + which commit owns its push. */
interface Winner<T> {
	readonly ref: T;
	readonly ownerCommit: string;
	/** A known docId for this plan/note (from any commit's prior push) so the push updates in place. */
	readonly seedDocId?: number;
}

/**
 * Pushes the subject's summaries + deduped attachments and builds the live `ref`.
 * Shared by generate + reconcile so create-time and reconcile produce identical refs.
 */
async function pushSubjectAndBuildRef(
	subjectSummaries: ReadonlyArray<CommitSummary>,
	kind: "branch" | "commit",
	branch: string,
	ctx: PushContext,
): Promise<LiveRef> {
	// 1. Pick the winner revision per plan base-slug / note id (latest updatedAt),
	//    remembering the owner commit and any known docId to reuse.
	const planWinners = new Map<string, Winner<PlanReference>>();
	const noteWinners = new Map<string, Winner<NoteReference>>();
	for (const summary of subjectSummaries) {
		for (const plan of summary.plans ?? []) {
			const key = planBaseKey(plan.slug);
			const prev = planWinners.get(key);
			const seedDocId = plan.jolliPlanDocId ?? prev?.seedDocId;
			if (!prev || Date.parse(plan.updatedAt) >= Date.parse(prev.ref.updatedAt)) {
				planWinners.set(key, { ref: plan, ownerCommit: summary.commitHash, seedDocId });
			} else if (seedDocId !== prev.seedDocId) {
				planWinners.set(key, { ...prev, seedDocId });
			}
		}
		for (const note of summary.notes ?? []) {
			const prev = noteWinners.get(note.id);
			const seedDocId = note.jolliNoteDocId ?? prev?.seedDocId;
			if (!prev || Date.parse(note.updatedAt) >= Date.parse(prev.ref.updatedAt)) {
				noteWinners.set(note.id, { ref: note, ownerCommit: summary.commitHash, seedDocId });
			} else if (seedDocId !== prev.seedDocId) {
				noteWinners.set(note.id, { ...prev, seedDocId });
			}
		}
	}

	// 2. Assign each winner (with its known docId injected) to its owner commit.
	const ownedPlans = new Map<string, PlanReference[]>();
	const ownedNotes = new Map<string, NoteReference[]>();
	const pushInto = <T>(map: Map<string, T[]>, commit: string, item: T): void => {
		const arr = map.get(commit);
		if (arr) arr.push(item);
		else map.set(commit, [item]);
	};
	for (const w of planWinners.values()) {
		pushInto(ownedPlans, w.ownerCommit, w.seedDocId ? { ...w.ref, jolliPlanDocId: w.seedDocId } : w.ref);
	}
	for (const w of noteWinners.values()) {
		pushInto(ownedNotes, w.ownerCommit, w.seedDocId ? { ...w.ref, jolliNoteDocId: w.seedDocId } : w.ref);
	}

	// 3. Push each summary oldest→newest with only its owned attachments. Capture the
	//    pushed summary docId per commit and accumulate the branch-wide attachment map.
	const planDocIdByBase = new Map<string, number>();
	const noteDocIdById = new Map<string, number>();
	for (const w of planWinners.values()) if (w.seedDocId) planDocIdByBase.set(planBaseKey(w.ref.slug), w.seedDocId);
	for (const [id, w] of noteWinners) if (w.seedDocId) noteDocIdById.set(id, w.seedDocId);

	const summaryDocIds: number[] = [];
	for (const summary of subjectSummaries) {
		const result = await pushSummaryWithAttachments(summary, ctx, {
			plans: ownedPlans.get(summary.commitHash) ?? [],
			notes: ownedNotes.get(summary.commitHash) ?? [],
		}, {
			strictAttachments: true,
		});
		if (result.attachmentFailures.length > 0) {
			throw new AttachmentPushError(result.attachmentFailures);
		}
		summaryDocIds.push(result.pushedDoc.summaryDocId);
		for (const p of result.pushedDoc.plans) planDocIdByBase.set(planBaseKey(p.slug), p.docId);
		for (const n of result.pushedDoc.notes) noteDocIdById.set(n.id, n.docId);
	}

	// 4. Build covered: each commit references its OWN plans/notes' docids (resolved
	//    via the shared map, so a doc pushed under a different commit is still linked).
	const coveredFor = (summary: CommitSummary): number[] => {
		const ids = new Set<number>();
		for (const plan of summary.plans ?? []) {
			const docId = planDocIdByBase.get(planBaseKey(plan.slug));
			if (docId) ids.add(docId);
		}
		for (const note of summary.notes ?? []) {
			const docId = noteDocIdById.get(note.id);
			if (docId) ids.add(docId);
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
	}));
	return createHash("sha1").update(JSON.stringify(projection)).digest("hex").slice(0, 16);
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
		const existing = await getShare(deps.workspaceRoot, branch);
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
		const ref = await pushSubjectAndBuildRef(subjectSummaries, "branch", branch, ctx);

		const result = await updateLiveShare(baseUrl, deps.apiKey, existing.shareId, { ref });
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

/**
 * JolliMemoryPushOrchestrator
 *
 * Pure push-content helpers used by the CLI's push-to-Jolli-Space path. Ported
 * verbatim from the VS Code extension (`JolliPushOrchestrator.ts`,
 * `SummaryMarkdownBuilder.ts`, `PlanGrouping.ts`, `LiveShareController.ts`) so
 * both surfaces build identical push payloads and dedupe attachments the same
 * way. This file holds only pure functions — no network I/O, no VS Code UI, no
 * git plumbing. The orchestrator push loop itself is a separate unit.
 */

import { createLogger } from "../Logger.js";
import type { CommitSummary, NoteReference, PlanReference, ReferenceCommitRef } from "../Types.js";
import { getDefaultBranch } from "./GitOps.js";
import { buildBranchRelativePath, deriveRepoNameFromUrl, getCanonicalRepoUrl } from "./GitRemoteUtils.js";
import { deriveJolliEnvKey, resolveArticleUrl } from "./JolliApiUtils.js";
import {
	BindingAlreadyExistsError,
	BindingRequiredError,
	ClientOutdatedError,
	JolliMemoryPushClient,
	type JolliMemorySpace,
	NotAuthenticatedError,
} from "./JolliMemoryPushClient.js";
import { loadBranchSummaries } from "./PrDescription.js";
import { loadPushPending } from "./PushPendingStore.js";
import { readReferenceMarkdownFromString } from "./references/ReferenceStore.js";
import type { StorageProvider } from "./StorageProvider.js";
import {
	buildNotePushTitle,
	buildPlanPushTitle,
	buildPushTitle,
	buildReferencePushTitle,
	collectSortedTopics,
} from "./SummaryFormat.js";
import {
	buildReferencePushMarkdown,
	pushE2eTestSection,
	pushFooter,
	pushPlansAndNotesSection,
	pushPropertiesSection,
	pushRecapSection,
	pushSourceCommitsSection,
	pushTopicBody,
	pushTopicsSection,
} from "./SummaryMarkdownBuilder.js";
import {
	getActiveStorage,
	getIndexEntryMap,
	getSummary,
	readNoteFromBranch,
	readPlanFromBranch,
	readReferenceFromBranch,
	storeSummary,
} from "./SummaryStore.js";

const log = createLogger("JolliMemoryPushOrchestrator");

/**
 * Byte cap for the serialized summary JSON riding on a summary push. The server
 * rejects `summaryJson` above 2MB; staying well under leaves headroom for the
 * markdown `content` sharing the same request body. Oversized JSON is simply
 * omitted — the markdown push must never fail on account of the sidecar.
 */
const MAX_SUMMARY_JSON_BYTES = 1_572_864;

/**
 * Serializes a summary for the `summaryJson` push field: the enriched
 * `summaryForMarkdown` copy (plan/note URLs woven in) minus the client push-state
 * fields — `jolliDocId`/`jolliDocUrl` churn per push, while `orphanedDocIds`
 * and `unresolvedOrphanHashes` are cleanup bookkeeping. None of them are
 * commit content the share page should see
 * (stripping them also keeps the top-level fields of a re-push byte-identical for
 * unchanged content, so the server upsert can no-op — per-plan/note `jolliPlan*`/
 * `jolliNote*` ids nested inside `plans[]`/`notes[]` are untouched and can still
 * churn). Returns undefined above {@link MAX_SUMMARY_JSON_BYTES}.
 */
export function serializeSummaryJson(summary: CommitSummary): string | undefined {
	const {
		jolliDocId: _docId,
		jolliDocUrl: _docUrl,
		orphanedDocIds: _orphaned,
		unresolvedOrphanHashes: _unresolved,
		...content
	} = summary;
	const json = JSON.stringify(content);
	if (Buffer.byteLength(json, "utf-8") > MAX_SUMMARY_JSON_BYTES) {
		log.warn(
			`Summary JSON for ${summary.commitHash.substring(0, 8)} exceeds ${MAX_SUMMARY_JSON_BYTES} bytes — pushing markdown only`,
		);
		return;
	}
	return json;
}

/**
 * A stored `jolliDocId` may be reused as an update target only when the article
 * URL it was minted with points at the current push env. The env is NOT stored
 * separately — the doc URL's origin already IS it, so `deriveJolliEnvKey(storedUrl)`
 * recovers the backend the id belongs to. A URL from a different origin means the
 * id lives on another backend, so we drop it and let the server create a fresh doc.
 *
 * A missing URL is legacy / never-pushed data (nothing to conflict with) →
 * reuse allowed, preserving the pre-tagging always-reuse behavior. An unparseable
 * URL is likewise treated as env-agnostic rather than throwing.
 */
export function canReuseDocId(storedDocUrl: string | undefined, currentEnv: string): boolean {
	if (!storedDocUrl) return true;
	try {
		return deriveJolliEnvKey(storedDocUrl) === currentEnv;
	} catch {
		return true;
	}
}

/** Merges published plan URLs/docIds into plan references (matched by exact slug). The URL's origin is the minting env — see {@link canReuseDocId}. */
export function applyPlanUrls(
	plans: ReadonlyArray<PlanReference> | undefined,
	planUrls: ReadonlyArray<{ slug: string; url: string; docId: number }>,
): ReadonlyArray<PlanReference> | undefined {
	if (!plans || planUrls.length === 0) return plans;
	const urlMap = new Map(planUrls.map((p) => [p.slug, p]));
	return plans.map((p) => {
		const pushed = urlMap.get(p.slug);
		return pushed ? { ...p, jolliPlanDocUrl: pushed.url, jolliPlanDocId: pushed.docId } : p;
	});
}

/** Merges published note URLs/docIds into note references (matched by id). The URL's origin is the minting env — see {@link canReuseDocId}. */
export function applyNoteUrls(
	notes: ReadonlyArray<NoteReference>,
	noteUrls: ReadonlyArray<{ id: string; url: string; docId: number }>,
): ReadonlyArray<NoteReference> {
	const urlMap = new Map(noteUrls.map((n) => [n.id, n]));
	return notes.map((n) => {
		const pushed = urlMap.get(n.id);
		return pushed ? { ...n, jolliNoteDocUrl: pushed.url, jolliNoteDocId: pushed.docId } : n;
	});
}

/**
 * Merges published reference URLs/docIds into commit references, matched by
 * `archivedKey` — the exact per-commit array entry pointer
 * (`<source>:<nativeId>-<shortHash>`), so a reference recurring across commits
 * only weaves the URL into the entry that actually pushed. The URL's origin is
 * the minting env — see {@link canReuseDocId}.
 */
export function applyReferenceUrls(
	references: ReadonlyArray<ReferenceCommitRef>,
	referenceUrls: ReadonlyArray<{ archivedKey: string; url: string; docId: number }>,
): ReadonlyArray<ReferenceCommitRef> {
	if (referenceUrls.length === 0) return references;
	const urlMap = new Map(referenceUrls.map((r) => [r.archivedKey, r]));
	return references.map((r) => {
		const pushed = urlMap.get(r.archivedKey);
		return pushed ? { ...r, jolliReferenceDocUrl: pushed.url, jolliReferenceDocId: pushed.docId } : r;
	});
}

/**
 * Strips a trailing archived commit-hash suffix (`-<8 hex>`) to get the base
 * name. Committed snapshots (`refactor-auth-a1b2c3d4`) and an uncommitted base
 * (`refactor-auth`) collapse to the same key.
 */
export function planBaseKey(slug: string): string {
	return slug.replace(/-[0-9a-f]{8}$/, "");
}

/**
 * Compares two plans newest-first by `updatedAt`, tiebroken by `slug` so the
 * order is deterministic across repeated calls.
 */
function byUpdatedAtDesc(a: PlanReference, b: PlanReference): number {
	if (a.updatedAt !== b.updatedAt) {
		return a.updatedAt < b.updatedAt ? 1 : -1;
	}
	return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/**
 * Returns exactly one plan per base name — the latest snapshot — preserving the
 * newest-first order. Used to avoid pushing duplicate same-named documents to
 * Jolli.
 *
 * Same-named plans share an identical server push identity (same title, branch,
 * relativePath, commit — the slug is NOT sent), so `jolliPlanDocId` is the only
 * thing that tells the server to UPDATE rather than CREATE. When a previously
 * pushed older snapshot carries the docId but the latest snapshot does not, the
 * latest inherits that docId/url so the push updates the existing article
 * instead of creating a duplicate (which the server rejects → push failure).
 */
export function latestPlanPerName(plans: ReadonlyArray<PlanReference>): ReadonlyArray<PlanReference> {
	const sorted = [...plans].sort(byUpdatedAtDesc);
	// Newest already-pushed docId/url per base name (first hit wins = newest). The
	// URL rides with the docId so the reuse gate downstream (`canReuseDocId`, which
	// reads the URL's origin) can tell which backend the inherited id belongs to.
	const pushedDoc = new Map<string, { docId: number; url: string | undefined }>();
	for (const plan of sorted) {
		const key = planBaseKey(plan.slug);
		if (plan.jolliPlanDocId !== undefined && !pushedDoc.has(key)) {
			pushedDoc.set(key, { docId: plan.jolliPlanDocId, url: plan.jolliPlanDocUrl });
		}
	}
	const seen = new Set<string>();
	const result: PlanReference[] = [];
	for (const plan of sorted) {
		const key = planBaseKey(plan.slug);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		if (plan.jolliPlanDocId === undefined) {
			const inherited = pushedDoc.get(key);
			if (inherited) {
				result.push({
					...plan,
					jolliPlanDocId: inherited.docId,
					jolliPlanDocUrl: inherited.url,
				});
				continue;
			}
		}
		result.push(plan);
	}
	return result;
}

/** The winner revision of a recurring plan/note + which commit owns its push. */
interface Winner<T> {
	readonly ref: T;
	readonly ownerCommit: string;
	/** A known docId for this plan/note (from any commit's prior push) so the push updates in place. */
	readonly seedDocId?: number;
	/** Article URL the `seedDocId` was minted with — rides with the id so the reuse gate (`canReuseDocId`, keyed on the URL's origin) can tell which backend it belongs to, and so the woven URL matches the id. */
	readonly seedDocUrl?: string;
}

/**
 * Cross-commit dedup: pick the winner revision per plan base-slug / note id
 * (latest updatedAt), remember the owner commit + any known docId to reuse, and
 * assign each winner (docId injected) to its owner commit. Shared by the
 * live-share push and the push-branch-to-Jolli path so both dedup identically.
 *
 * Also returns the seed docId maps (winners that already have a known docId) so
 * the caller can pre-seed its attachment-map resolution — a plan/note recurring
 * across commits pushes to ONE Space doc instead of a duplicate per commit.
 */
export function assignOwnedAttachments(subjectSummaries: ReadonlyArray<CommitSummary>): {
	ownedPlans: Map<string, PlanReference[]>;
	ownedNotes: Map<string, NoteReference[]>;
	ownedReferences: Map<string, ReferenceCommitRef[]>;
	seedPlanDocIds: Map<string, number>;
	seedNoteDocIds: Map<string, number>;
	seedReferenceDocIds: Map<string, number>;
} {
	const planWinners = new Map<string, Winner<PlanReference>>();
	const noteWinners = new Map<string, Winner<NoteReference>>();
	const referenceWinners = new Map<string, Winner<ReferenceCommitRef>>();
	for (const summary of subjectSummaries) {
		for (const plan of summary.plans ?? []) {
			const key = planBaseKey(plan.slug);
			const prev = planWinners.get(key);
			// Use the SAME comparator as latestPlanPerName (updatedAt desc, slug
			// tiebreak) so the two dedup paths never disagree on which snapshot is
			// "latest" — a disagreement would push one slug but weave the URL against
			// the other, dropping the plan's markdown link. String compare (via
			// byUpdatedAtDesc) also avoids Date.parse's NaN-on-malformed-date pitfall.
			if (!prev || byUpdatedAtDesc(plan, prev.ref) < 0) {
				// This revision wins (or is the first seen). Its own docId is
				// authoritative for the latest article; fall back to a docId a prior
				// revision surfaced only when this one carries none. The URL tracks
				// whichever revision actually supplied the docId.
				const seedDocId = plan.jolliPlanDocId ?? prev?.seedDocId;
				const seedDocUrl = plan.jolliPlanDocId !== undefined ? plan.jolliPlanDocUrl : prev?.seedDocUrl;
				planWinners.set(key, { ref: plan, ownerCommit: summary.commitHash, seedDocId, seedDocUrl });
			} else if (prev.seedDocId === undefined && plan.jolliPlanDocId !== undefined) {
				// A losing (older) revision only fills in a docId the winner didn't
				// already have. It must NEVER overwrite the winner's own docId —
				// doing so would push the latest content to an older article and
				// orphan (leak) the winner's real one.
				planWinners.set(key, { ...prev, seedDocId: plan.jolliPlanDocId, seedDocUrl: plan.jolliPlanDocUrl });
			}
		}
		for (const note of summary.notes ?? []) {
			const prev = noteWinners.get(note.id);
			// Notes are keyed by exact id, so no slug tiebreak is needed. Compare
			// updatedAt as strings (newest wins, first-seen kept on a tie) to stay
			// deterministic and NaN-free for a malformed/missing updatedAt.
			if (!prev || note.updatedAt > prev.ref.updatedAt) {
				const seedDocId = note.jolliNoteDocId ?? prev?.seedDocId;
				const seedDocUrl = note.jolliNoteDocId !== undefined ? note.jolliNoteDocUrl : prev?.seedDocUrl;
				noteWinners.set(note.id, { ref: note, ownerCommit: summary.commitHash, seedDocId, seedDocUrl });
			} else if (prev.seedDocId === undefined && note.jolliNoteDocId !== undefined) {
				noteWinners.set(note.id, { ...prev, seedDocId: note.jolliNoteDocId, seedDocUrl: note.jolliNoteDocUrl });
			}
		}
		for (const ref of summary.references ?? []) {
			// A reference is identified across commits by its stable `<source>:<nativeId>`
			// (Reference.mapKey), NOT its per-commit `archivedKey` — the same ticket
			// referenced on two commits pushes to ONE Space article. Recency by
			// `referencedAt` (string compare, newest wins, first-seen kept on a tie).
			const key = referenceBaseKey(ref);
			const prev = referenceWinners.get(key);
			if (!prev || ref.referencedAt > prev.ref.referencedAt) {
				const seedDocId = ref.jolliReferenceDocId ?? prev?.seedDocId;
				const seedDocUrl = ref.jolliReferenceDocId !== undefined ? ref.jolliReferenceDocUrl : prev?.seedDocUrl;
				referenceWinners.set(key, { ref, ownerCommit: summary.commitHash, seedDocId, seedDocUrl });
			} else if (prev.seedDocId === undefined && ref.jolliReferenceDocId !== undefined) {
				referenceWinners.set(key, {
					...prev,
					seedDocId: ref.jolliReferenceDocId,
					seedDocUrl: ref.jolliReferenceDocUrl,
				});
			}
		}
	}

	const ownedPlans = new Map<string, PlanReference[]>();
	const ownedNotes = new Map<string, NoteReference[]>();
	const ownedReferences = new Map<string, ReferenceCommitRef[]>();
	const pushInto = <T>(map: Map<string, T[]>, commit: string, item: T): void => {
		const arr = map.get(commit);
		if (arr) arr.push(item);
		else map.set(commit, [item]);
	};
	for (const w of planWinners.values()) {
		pushInto(
			ownedPlans,
			w.ownerCommit,
			w.seedDocId ? { ...w.ref, jolliPlanDocId: w.seedDocId, jolliPlanDocUrl: w.seedDocUrl } : w.ref,
		);
	}
	for (const w of noteWinners.values()) {
		pushInto(
			ownedNotes,
			w.ownerCommit,
			w.seedDocId ? { ...w.ref, jolliNoteDocId: w.seedDocId, jolliNoteDocUrl: w.seedDocUrl } : w.ref,
		);
	}
	for (const w of referenceWinners.values()) {
		pushInto(
			ownedReferences,
			w.ownerCommit,
			w.seedDocId ? { ...w.ref, jolliReferenceDocId: w.seedDocId, jolliReferenceDocUrl: w.seedDocUrl } : w.ref,
		);
	}

	const seedPlanDocIds = new Map<string, number>();
	const seedNoteDocIds = new Map<string, number>();
	const seedReferenceDocIds = new Map<string, number>();
	for (const w of planWinners.values()) if (w.seedDocId) seedPlanDocIds.set(planBaseKey(w.ref.slug), w.seedDocId);
	for (const [id, w] of noteWinners) if (w.seedDocId) seedNoteDocIds.set(id, w.seedDocId);
	for (const [key, w] of referenceWinners) if (w.seedDocId) seedReferenceDocIds.set(key, w.seedDocId);

	return { ownedPlans, ownedNotes, ownedReferences, seedPlanDocIds, seedNoteDocIds, seedReferenceDocIds };
}

/** Cross-commit dedup key for a reference: its stable `<source>:<nativeId>` (Reference.mapKey). */
export function referenceBaseKey(ref: ReferenceCommitRef): string {
	return `${ref.source}:${ref.nativeId}`;
}

// ── Push markdown ────────────────────────────────────────────────────────────

/**
 * Builds a Markdown string from a CommitSummary for the Jolli Space push.
 * Ported from the VS Code `buildMarkdown` (`SummaryMarkdownBuilder.ts:44-57`)
 * and renamed to avoid colliding with the CLI's own `buildMarkdown` (used by
 * the clipboard/folder export path, which omits references from the Context
 * section). The push variant opts into `includeReferences` so pushed
 * docs also surface Linear/Jira/GitHub/Notion references, and uses the
 * "Topic(s)" heading label rather than the export path's "Summary/Summaries".
 * All section builders are reused from `SummaryMarkdownBuilder.js` — this
 * function only differs from the export `buildMarkdown` in those two arguments.
 *
 * Structure mirrors the webview layout:
 * - H1: commit message
 * - Properties table: Commit, Branch, Author, Date, Changes
 * - Context: plans & notes (with references)
 * - Quick recap
 * - E2E Test Guide
 * - Source Commits list (only for squash/multi-record summaries)
 * - Topics: numbered, each field rendered as a blockquote callout
 * - Footer: "Generated by Jolli Memory"
 */
export function buildPushMarkdown(summary: CommitSummary): string {
	const { topics: allTopics, sourceNodes } = collectSortedTopics(summary);
	const lines: Array<string> = [];

	pushPropertiesSection(lines, summary);
	pushPlansAndNotesSection(lines, summary, { includeReferences: true });
	pushRecapSection(lines, summary);
	pushE2eTestSection(lines, summary.e2eTestGuide);
	pushSourceCommitsSection(lines, sourceNodes);
	pushTopicsSection(lines, allTopics, pushTopicBody, { singular: "Topic", plural: "Topics" });
	pushFooter(lines, summary);

	return lines.join("\n");
}

// ── Push orchestration (network I/O) ─────────────────────────────────────────

/**
 * Everything `pushSummary` needs that isn't on the summary itself. CLI analogue
 * of the VS Code `PushContext` (`JolliPushOrchestrator.ts:87-98`) — the binding
 * chooser callback is dropped (the CLI surfaces `BindingRequiredError` to its
 * caller instead of resolving it inline), and `storeSummary`/plan/note reads go
 * through the CLI's `SummaryStore` functions (with `storage`) rather than a
 * vscode bridge.
 */
export interface PushContext {
	/** Worktree root — plan/note bodies and the summary write-back are scoped to this. */
	readonly cwd: string;
	/** Resolved site base URL (the API key's `u`); article links are `${baseUrl}/articles?doc=<id>`. */
	readonly baseUrl: string;
	/** Kept for interface parity with the VS Code `PushContext`; unused — `client` carries its own auth. */
	readonly apiKey?: string;
	readonly repoUrl: string;
	readonly client: JolliMemoryPushClient;
	readonly storage?: StorageProvider;
}

/** The plans/notes/references to push for a summary — caller-chosen, or the summary's own when omitted. */
export interface AttachmentSelection {
	readonly plans: ReadonlyArray<PlanReference>;
	readonly notes: ReadonlyArray<NoteReference>;
	/** Deduped (owner-commit) references; omit to push none for this summary (the branch path passes them explicitly). */
	readonly references?: ReadonlyArray<ReferenceCommitRef>;
}

/** Result of pushing one summary: the persisted (write-back applied) summary, plus its article URL. */
export interface PushSummaryResult {
	readonly summary: CommitSummary;
	readonly summaryUrl: string;
}

/**
 * Pushes one summary's plans → notes → summary(+summaryJson) to a Jolli Space,
 * then writes the returned `docId`/`docUrl` back into the stored summary. Port
 * of the VS Code `pushSummaryWithAttachments` (`JolliPushOrchestrator.ts:154-263`).
 *
 * Best-effort on attachments: a plan/note whose content can't be read, or whose
 * individual push fails with a transient error, is skipped (logged) rather than
 * aborting the whole push. The two fatal errors — `BindingRequiredError` and
 * `ClientOutdatedError` (426; the CLI analogue of vscode's `PluginOutdatedError`)
 * — propagate from any push (summary, plan, or note); the caller
 * (`pushBranchToJolli`) surfaces `BindingRequiredError` as
 * `{ type: "binding_required" }` and `ClientOutdatedError` as `{ type: "error" }`,
 * rather than retrying inline (unlike the VS Code version, which resolves the
 * binding case via an injected chooser).
 */
export async function pushSummary(
	summary: CommitSummary,
	ctx: PushContext,
	attachments?: AttachmentSelection,
): Promise<PushSummaryResult> {
	const displayBase = ctx.baseUrl.replace(/\/+$/, "");
	// Env key of the tenant this push targets — every docId minted below is tagged
	// with it, and an existing docId is reused as an update target only when its
	// tag matches (see `canReuseDocId`). No network I/O.
	const envKey = await ctx.client.resolveEnvKey();
	const plansToPush = attachments ? attachments.plans : latestPlanPerName(summary.plans ?? []);
	const notesToPush = attachments ? attachments.notes : (summary.notes ?? []);
	const referencesToPush = attachments ? (attachments.references ?? []) : (summary.references ?? []);

	const planUrls = await pushPlanList(plansToPush, summary, ctx, displayBase, envKey);
	const noteUrls = await pushNoteList(notesToPush, summary, ctx, displayBase, envKey);
	const referenceUrls = await pushReferenceList(referencesToPush, summary, ctx, displayBase, envKey);

	// Weave the published URLs into the summary markdown (so the article's Plans
	// & Notes list links to the published docs). Dedupe same-named plan
	// snapshots — only the latest was uploaded.
	const dedupedPlans = latestPlanPerName(summary.plans ?? []);
	// `applyPlanUrls` only returns undefined when its `plans` argument is undefined;
	// `dedupedPlans` is always a (possibly empty) array, so the `?? dedupedPlans`
	// fallback can never actually trigger — kept for parity with the VS Code source.
	const plansWithUrls =
		applyPlanUrls(dedupedPlans, planUrls) ?? /* v8 ignore start -- unreachable: see comment above */ dedupedPlans;
	/* v8 ignore stop */
	const notesWithUrls = summary.notes ? applyNoteUrls(summary.notes, noteUrls) : summary.notes;
	const referencesWithUrls = summary.references
		? applyReferenceUrls(summary.references, referenceUrls)
		: summary.references;
	const summaryForMarkdown: CommitSummary = {
		...summary,
		plans: plansWithUrls,
		...(notesWithUrls !== summary.notes && { notes: notesWithUrls }),
		...(referencesWithUrls !== summary.references && { references: referencesWithUrls }),
	};
	const markdown = buildPushMarkdown(summaryForMarkdown);
	// The structured twin of the markdown article, from the same enriched copy —
	// the share page renders it directly instead of regex-parsing the markdown.
	const summaryJson = serializeSummaryJson(summaryForMarkdown);

	const result = await ctx.client.push({
		title: buildPushTitle(summary),
		content: markdown,
		commitHash: summary.commitHash,
		docType: "summary",
		branch: summary.branch,
		...(summary.jolliDocId !== undefined &&
			canReuseDocId(summary.jolliDocUrl, envKey) && { docId: summary.jolliDocId }),
		repoUrl: ctx.repoUrl,
		relativePath: buildBranchRelativePath(summary.branch),
		...(summaryJson && { summaryJson }),
	});

	const summaryUrl = resolveArticleUrl(displayBase, result.url, result.docId);

	// Post-push race check: `processPushPending` already skipped hashes that
	// were children at claim time, but the user could have amend/squashed this
	// commit while we were on the network. Force-writing a child back as a root
	// (storeSummary force=true below) would create a zombie index entry that
	// duplicates the merged root's content. Instead, best-effort delete the
	// freshly-published article and return — the merged root remains the sole
	// authority for this commit's memory.
	const postPushIndex = await getIndexEntryMap(ctx.cwd, ctx.storage).catch(() => new Map<string, unknown>());
	const currentIndexEntry = postPushIndex.get(summary.commitHash) as
		| { readonly parentCommitHash?: string | null }
		| undefined;
	if (currentIndexEntry?.parentCommitHash != null) {
		log.warn(
			"Commit %s became a child mid-push (parent=%s); deleting freshly-pushed article %d and skipping force-store",
			summary.commitHash.substring(0, 8),
			currentIndexEntry.parentCommitHash.substring(0, 8),
			result.docId,
		);
		try {
			await ctx.client.deleteDoc(result.docId);
		} catch (err) {
			log.warn(
				"Best-effort delete of newly-orphaned article %d failed: %s",
				result.docId,
				err instanceof Error ? err.message : String(err),
			);
		}
		return { summary, summaryUrl };
	}

	const updatedSummary: CommitSummary = {
		...summary,
		jolliDocUrl: summaryUrl,
		jolliDocId: result.docId,
		...(planUrls.length > 0 ? { plans: applyPlanUrls(summary.plans, planUrls) } : {}),
		...(noteUrls.length > 0 && summary.notes ? { notes: applyNoteUrls(summary.notes, noteUrls) } : {}),
		...(referenceUrls.length > 0 && summary.references
			? { references: applyReferenceUrls(summary.references, referenceUrls) }
			: {}),
	};
	await storeSummary(updatedSummary, ctx.cwd, true, undefined, ctx.storage);

	// Resolve unresolvedOrphanHashes: re-read each hash's summary from the
	// orphan branch. If PrePushWorker has since written back a jolliDocId,
	// promote it into orphanedDocIds for cleanup.
	//
	// Retention is gated by the shared push-pending queue:
	//   * hash present in pending → retain (a worker is still in flight and
	//     may yet resolve it)
	//   * hash absent from pending → discard (it was never pushed, or the
	//     worker already finished without producing a docId — either way the
	//     hash has no Space article to clean up)
	//
	// When `loadPushPending` itself fails (lock unavailable, transient IO
	// error) we fall back to conservative retention: keep every unresolved
	// hash so a crashed worker's article can still be cleaned up on the next
	// push.
	let summaryForCleanup = updatedSummary;
	if (summary.unresolvedOrphanHashes && summary.unresolvedOrphanHashes.length > 0) {
		const pending = await loadPushPending(ctx.cwd).catch((err: unknown) => {
			log.warn(
				"Could not read push-pending state while resolving orphan hashes: %s",
				err instanceof Error ? err.message : String(err),
			);
			return undefined;
		});
		const resolvedDocIds: number[] = [];
		const remainingHashes: string[] = [];
		let stillInFlight = 0;
		for (const hash of summary.unresolvedOrphanHashes) {
			const fresh = await getSummary(hash, ctx.cwd, ctx.storage);
			// Guard against tree-hash fallback: if the child's own summary
			// file was cleaned, getSummary may resolve to the merged summary
			// (same tree) — whose jolliDocId is the article we just pushed.
			// Without this check we'd delete our own freshly-published article.
			if (fresh?.jolliDocId && fresh.commitHash === hash) {
				resolvedDocIds.push(fresh.jolliDocId);
			} else if (pending === undefined) {
				remainingHashes.push(hash);
			} else if (pending.entries[hash]) {
				remainingHashes.push(hash);
				stillInFlight++;
			}
		}
		if (resolvedDocIds.length > 0 || remainingHashes.length !== summary.unresolvedOrphanHashes.length) {
			if (resolvedDocIds.length > 0)
				log.info(
					"Resolved %d orphan hashes → docIds for cleanup (%d retained, %d still in-flight)",
					resolvedDocIds.length,
					remainingHashes.length,
					stillInFlight,
				);
			const mergedOrphanIds = [...new Set([...(updatedSummary.orphanedDocIds ?? []), ...resolvedDocIds])];
			summaryForCleanup = {
				...updatedSummary,
				orphanedDocIds: mergedOrphanIds.length > 0 ? mergedOrphanIds : undefined,
				unresolvedOrphanHashes: remainingHashes.length > 0 ? [...new Set(remainingHashes)] : undefined,
			};
			await storeSummary(summaryForCleanup, ctx.cwd, true, undefined, ctx.storage);
		}
	}

	// Clean up orphaned articles, then persist which ones were actually deleted.
	// Best-effort: the summary + jolliDocId are already pushed and stored above, so a
	// cleanup/bookkeeping failure must not surface to the caller as a failed push.
	let finalSummary = summaryForCleanup;
	try {
		const cleaned = await cleanupOrphanedDocs(summaryForCleanup, summaryForCleanup, ctx);
		if (cleaned) finalSummary = cleaned;
	} catch (err) {
		log.warn("Orphan cleanup failed after a successful push: %s", err instanceof Error ? err.message : String(err));
	}

	return { summary: finalSummary, summaryUrl };
}

/**
 * Uploads the given plans, returning their published URLs. A single plan's
 * unreadable content or transient push failure is logged and skipped;
 * `BindingRequiredError` and `ClientOutdatedError` are fatal and propagate so
 * the caller can surface the binding / upgrade flow.
 */
async function pushPlanList(
	plans: ReadonlyArray<PlanReference>,
	summary: CommitSummary,
	ctx: PushContext,
	displayBase: string,
	envKey: string,
): Promise<Array<{ slug: string; url: string; docId: number }>> {
	const results: Array<{ slug: string; url: string; docId: number }> = [];
	for (const plan of plans) {
		const planContent = (await readPlanFromBranch(plan.slug, ctx.cwd, ctx.storage)) ?? "";
		if (!planContent) {
			log.info("Plan %s: no content found, skipping", plan.slug);
			continue;
		}
		let planResult: Awaited<ReturnType<JolliMemoryPushClient["push"]>>;
		try {
			planResult = await ctx.client.push({
				title: buildPlanPushTitle(summary, plan.title),
				content: planContent,
				commitHash: summary.commitHash,
				docType: "plan",
				branch: summary.branch,
				...(plan.jolliPlanDocId !== undefined &&
					canReuseDocId(plan.jolliPlanDocUrl, envKey) && { docId: plan.jolliPlanDocId }),
				repoUrl: ctx.repoUrl,
				relativePath: buildBranchRelativePath(summary.branch),
			});
		} catch (err) {
			if (err instanceof BindingRequiredError || err instanceof ClientOutdatedError) throw err;
			log.error("Plan %s push FAILED: %s", plan.slug, err instanceof Error ? err.message : String(err));
			continue;
		}
		results.push({
			slug: plan.slug,
			url: resolveArticleUrl(displayBase, planResult.url, planResult.docId),
			docId: planResult.docId,
		});
	}
	return results;
}

/** Uploads the given notes; like {@link pushPlanList}, transient single-note failures are logged and skipped while `BindingRequiredError` / `ClientOutdatedError` propagate. */
async function pushNoteList(
	notes: ReadonlyArray<NoteReference>,
	summary: CommitSummary,
	ctx: PushContext,
	displayBase: string,
	envKey: string,
): Promise<Array<{ id: string; url: string; docId: number }>> {
	const results: Array<{ id: string; url: string; docId: number }> = [];
	for (const note of notes) {
		const noteContent = note.content ?? (await readNoteFromBranch(note.id, ctx.cwd, ctx.storage)) ?? "";
		if (!noteContent) {
			log.info("Note %s: no content found, skipping", note.id);
			continue;
		}
		let noteResult: Awaited<ReturnType<JolliMemoryPushClient["push"]>>;
		try {
			noteResult = await ctx.client.push({
				title: buildNotePushTitle(summary, note.title),
				content: noteContent,
				commitHash: summary.commitHash,
				docType: "note",
				branch: summary.branch,
				...(note.jolliNoteDocId !== undefined &&
					canReuseDocId(note.jolliNoteDocUrl, envKey) && { docId: note.jolliNoteDocId }),
				repoUrl: ctx.repoUrl,
				relativePath: buildBranchRelativePath(summary.branch),
			});
		} catch (err) {
			if (err instanceof BindingRequiredError || err instanceof ClientOutdatedError) throw err;
			log.error("Note %s push FAILED: %s", note.id, err instanceof Error ? err.message : String(err));
			continue;
		}
		results.push({
			id: note.id,
			url: resolveArticleUrl(displayBase, noteResult.url, noteResult.docId),
			docId: noteResult.docId,
		});
	}
	return results;
}

/**
 * Uploads the given archived references as standalone `reference` articles,
 * returning their published URLs keyed by `archivedKey`. The body is synthesized
 * from the value snapshot ({@link buildReferencePushMarkdown}) since a reference
 * has no on-disk file. Like {@link pushPlanList}, a single transient failure is
 * logged and skipped while `BindingRequiredError` / `ClientOutdatedError` propagate.
 */
async function pushReferenceList(
	references: ReadonlyArray<ReferenceCommitRef>,
	summary: CommitSummary,
	ctx: PushContext,
	displayBase: string,
	envKey: string,
): Promise<Array<{ archivedKey: string; url: string; docId: number }>> {
	const results: Array<{ archivedKey: string; url: string; docId: number }> = [];
	for (const ref of references) {
		// Read the archived body from the orphan-branch snapshot so the pushed article
		// carries the SAME content VS Code shows locally (the local `.md` is deleted at
		// commit time; the orphan-branch snapshot is the system of record). Missing/
		// unparseable → header-only, never a failed push.
		const storedMd = await readReferenceFromBranch(ref.source, ref.archivedKey, ctx.cwd, ctx.storage);
		const description = storedMd
			? (readReferenceMarkdownFromString(storedMd)?.description ?? undefined)
			: undefined;
		let refResult: Awaited<ReturnType<JolliMemoryPushClient["push"]>>;
		try {
			refResult = await ctx.client.push({
				title: buildReferencePushTitle(ref),
				content: buildReferencePushMarkdown(ref, description),
				commitHash: summary.commitHash,
				docType: "reference",
				branch: summary.branch,
				...(ref.jolliReferenceDocId !== undefined &&
					canReuseDocId(ref.jolliReferenceDocUrl, envKey) && { docId: ref.jolliReferenceDocId }),
				repoUrl: ctx.repoUrl,
				relativePath: buildBranchRelativePath(summary.branch),
			});
		} catch (err) {
			if (err instanceof BindingRequiredError || err instanceof ClientOutdatedError) throw err;
			log.error(
				"Reference %s push FAILED: %s",
				ref.archivedKey,
				err instanceof Error ? err.message : String(err),
			);
			continue;
		}
		results.push({
			archivedKey: ref.archivedKey,
			url: resolveArticleUrl(displayBase, refResult.url, refResult.docId),
			docId: refResult.docId,
		});
	}
	return results;
}

/**
 * Deletes orphaned articles from the Space, then persists the result: only ids
 * that were successfully deleted are cleared from `orphanedDocIds`; failed ids are
 * kept so the next push retries them. Returns the persisted summary, or null when
 * there were no orphans. Port of the VS Code `cleanupOrphanedDocs`
 * (`JolliPushOrchestrator.ts:417-445`).
 */
async function cleanupOrphanedDocs(
	originalSummary: CommitSummary,
	updatedSummary: CommitSummary,
	ctx: PushContext,
): Promise<CommitSummary | null> {
	const orphanedIds = originalSummary.orphanedDocIds ? [...originalSummary.orphanedDocIds] : [];
	if (orphanedIds.length === 0) return null;

	const results = await Promise.allSettled(orphanedIds.map((id) => ctx.client.deleteDoc(id).then(() => id)));
	const deleted = new Set<number>();
	for (const r of results) {
		if (r.status === "fulfilled") deleted.add(r.value);
	}
	const remaining = orphanedIds.filter((id) => !deleted.has(id));
	if (deleted.size > 0) log.info("Deleted %d orphaned article(s)", deleted.size);
	if (remaining.length > 0) {
		log.warn("Failed to delete %d orphaned article(s), will retry on next push", remaining.length);
	}

	const cleaned: CommitSummary = {
		...updatedSummary,
		...(remaining.length > 0 ? { orphanedDocIds: remaining } : { orphanedDocIds: undefined }),
	};
	await storeSummary(cleaned, ctx.cwd, true, undefined, ctx.storage);
	return cleaned;
}

// ── Branch push (network I/O) ─────────────────────────────────────────────────

/** Options for {@link pushBranchToJolli}. */
export interface PushBranchOpts {
	readonly cwd: string;
	/** Defaults to the repo's default branch (`getDefaultBranch`) when omitted. */
	readonly baseBranch?: string;
	/** A Jolli Space id (numeric string), slug, or name to proactively bind the repo to before pushing. */
	readonly space?: string;
	/** Test seam — defaults to a real `JolliMemoryPushClient`. */
	readonly client?: JolliMemoryPushClient;
}

/** Outcome of {@link pushBranchToJolli}. */
export type PushBranchResult =
	| { readonly type: "pushed"; readonly pushed: number; readonly skipped: number; readonly urls: string[] }
	| {
			readonly type: "binding_required";
			readonly repoUrl: string;
			readonly spaces: ReadonlyArray<JolliMemorySpace>;
			readonly defaultSpaceId: number | null;
	  }
	| { readonly type: "error"; readonly message: string };

/**
 * Pushes every commit summary on `base..HEAD` (current branch) to the bound
 * Jolli Space as articles. Port of the VS Code `LiveShareController.pushBranchMemoriesToSpace`
 * push loop (`LiveShareController.ts:425-462`), minus the share-link/subject-lock
 * machinery (this is the CLI's plain "push my branch" path, not live share).
 *
 * Cross-commit plan/note dedup via {@link assignOwnedAttachments} — a plan/note
 * recurring across commits pushes to ONE Space doc, owned by whichever commit
 * carries its latest revision.
 *
 * When `opts.space` is given and the repo isn't yet bound, a binding is created
 * up front (swallowing a race-lost `BindingAlreadyExistsError`) before any push
 * is attempted. Without `opts.space`, an unbound repo surfaces as
 * `{ type: "binding_required" }` with the space list so the caller can prompt
 * and retry with `opts.space` set.
 */
export async function pushBranchToJolli(opts: PushBranchOpts): Promise<PushBranchResult> {
	const client = opts.client ?? new JolliMemoryPushClient();
	const cwd = opts.cwd;
	try {
		const repoUrl = await getCanonicalRepoUrl(cwd);
		if (opts.space) {
			const jmSpaceId = await resolveSpaceId(client, opts.space);
			try {
				await client.createBinding({ repoUrl, repoName: deriveRepoNameFromUrl(repoUrl), jmSpaceId });
			} catch (err) {
				if (!(err instanceof BindingAlreadyExistsError)) throw err;
				// The repo is already bound. The push payload carries no space field —
				// the server routes by the existing binding — so a binding to a space
				// OTHER than the one the user asked for would silently land memories in
				// the wrong place. Fail closed: only proceed when we can CONFIRM the
				// existing binding matches the requested space. When the server's 409
				// omits the existing binding (`existingSpaceId` undefined, a rare race
				// with no observable winner) we can't confirm, so we surface an error
				// for the explicit `--space` rather than risk writing to the wrong Space.
				if (err.existingSpaceId !== jmSpaceId) {
					const boundTo =
						err.existingSpaceId !== undefined
							? `a different Jolli Space (id ${err.existingSpaceId})`
							: "another Jolli Space";
					return {
						type: "error",
						message: `This repo is already bound to ${boundTo}, so it cannot be confirmed for a push to "${opts.space}". Unbind the repo first, or push without --space to use the existing binding.`,
					};
				}
			}
		}

		const base = opts.baseBranch ?? (await getDefaultBranch(cwd));
		const { summaries, missingCount } = await loadBranchSummaries(cwd, base);
		const storage = getActiveStorage();
		const ctx: PushContext = { cwd, baseUrl: await client.resolveBaseUrl(), repoUrl, client, storage };

		// Mirror LiveShareController.pushBranchMemoriesToSpace: cross-commit dedup,
		// then push oldest→newest passing each summary its OWNED (deduped) attachments.
		// seedPlanDocIds/seedNoteDocIds are also returned (kept for vscode parity) but
		// unused here — seeds are already applied to the owned plan/note refs.
		const { ownedPlans, ownedNotes, ownedReferences } = assignOwnedAttachments(summaries);
		const urls: string[] = [];
		for (const s of summaries) {
			const attachments: AttachmentSelection = {
				plans: ownedPlans.get(s.commitHash) ?? [],
				notes: ownedNotes.get(s.commitHash) ?? [],
				references: ownedReferences.get(s.commitHash) ?? [],
			};
			// BindingRequiredError propagates — fatal for the whole batch.
			const { summaryUrl } = await pushSummary(s, ctx, attachments);
			urls.push(summaryUrl);
		}
		return { type: "pushed", pushed: summaries.length, skipped: missingCount, urls };
	} catch (err) {
		if (err instanceof BindingRequiredError) {
			// Enrich with the space list for the binding prompt, but never let a
			// failing listSpaces() downgrade the outcome to a generic error — the
			// caller still needs the `binding_required` affordance (re-run with
			// --space) even if we couldn't fetch the choices.
			let spaces: ReadonlyArray<JolliMemorySpace> = [];
			let defaultSpaceId: number | null = null;
			try {
				({ spaces, defaultSpaceId } = await client.listSpaces());
			} catch (listErr) {
				log.warn(
					"Could not list spaces for the binding prompt: %s",
					listErr instanceof Error ? listErr.message : String(listErr),
				);
			}
			return { type: "binding_required", repoUrl: err.repoUrl, spaces, defaultSpaceId };
		}
		if (err instanceof NotAuthenticatedError) return { type: "error", message: err.message };
		return { type: "error", message: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Resolves a `--space` CLI option (numeric id, slug, or exact name) to a Space
 * id. Exported so `jolli bind` (JolliCloudCommands.ts) resolves `--space` the
 * same way `jolli push --space` does — one place decides what a "space" string
 * means instead of two implementations drifting apart.
 */
export async function resolveSpaceId(client: JolliMemoryPushClient, space: string): Promise<number> {
	const trimmed = space.trim();
	// Match by name/slug first so a Space *named* with digits (e.g. "2026") resolves
	// to itself rather than being read as a raw id. A numeric string that matches no
	// name/slug falls back to a raw id, preserving direct bind-by-id.
	const { spaces } = await client.listSpaces();
	const match = spaces.find((s) => s.slug === trimmed || s.name === trimmed);
	if (match) {
		return match.id;
	}
	if (/^\d+$/.test(trimmed)) {
		return Number(trimmed);
	}
	throw new Error(`No Jolli Space matches "${space}"`);
}

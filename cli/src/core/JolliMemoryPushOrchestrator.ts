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
import { parseBaseUrl, resolveArticleUrl } from "./JolliApiUtils.js";
import {
	BindingAlreadyExistsError,
	BindingRequiredError,
	JolliMemoryPushClient,
	type JolliMemorySpace,
	NotAuthenticatedError,
} from "./JolliMemoryPushClient.js";
import { loadBranchSummaries } from "./PrDescription.js";
import { isOutboundPushAllowed, PushDisabledError } from "./PushControl.js";
import { loadPushPending } from "./PushPendingStore.js";
import {
	applyPublishedUrls,
	assertOutboundStillAllowed,
	assignOwnedContext,
	type BatchAttachmentKey,
	type ContextSelection,
	legacyNamedSelection,
	type OwnedContext,
	type PushContext,
	pushContextAttachments,
	reduceOwnItems,
	selectionForCommit,
} from "./push/ContextPush.js";
import { canReuseDocId } from "./push/DocIdReuse.js";
import { referenceBaseKey } from "./push/kinds/index.js";
import { adoptLegacySkillDocIds } from "./push/LegacySkillDocIds.js";
import { latestPlanPerName, planBaseKey } from "./push/PlanGrouping.js";
import { clearSpaceBindingCache, saveSpaceBindingCache } from "./SpaceBindingCache.js";
import { buildPushTitle, collectSortedTopics } from "./SummaryFormat.js";
import {
	pushE2eTestSection,
	pushFooter,
	pushPlansAndNotesSection,
	pushPropertiesSection,
	pushRecapSection,
	pushSourceCommitsSection,
	pushTopicBody,
	pushTopicsSection,
} from "./SummaryMarkdownBuilder.js";
import { getActiveStorage, getIndexEntryMap, getSummary, storeSummary } from "./SummaryStore.js";

/**
 * Re-exported so every existing importer (the ide-bridge, `PushExecutor`, the
 * MCP tools, and the test suite) keeps resolving these from here after the push
 * path became table-driven. Their implementations moved into `core/push/` because
 * the kind definitions need them and this module imports the registry — leaving
 * them here would close an import cycle.
 */
export { canReuseDocId, latestPlanPerName, planBaseKey, referenceBaseKey, assertOutboundStillAllowed };
export type { BatchAttachmentKey, PushContext };

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
 * fields — `jolliDocId`/`jolliDocUrl` and their skill-article siblings
 * `jolliSkillsDocId`/`jolliSkillsDocUrl` churn per push, while `orphanedDocIds`
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
		// The skill aggregate is pushed BEFORE the summary in the same run, so
		// `applyPublishedUrls` has already woven the freshly minted id/URL onto the
		// summary by the time we serialize — leaving them in would put this push's
		// own publish state into the sidecar (and make the same commit's JSON differ
		// per environment, since the ids are per-backend).
		jolliSkillsDocId: _skillsDocId,
		jolliSkillsDocUrl: _skillsDocUrl,
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
 * Legacy per-kind URL weavers, kept as one-line delegates over the generic
 * {@link applyPublishedUrls}.
 *
 * They have no remaining production caller — the push path is generic — but they
 * are what the existing test suite asserts against, and those assertions are the
 * evidence that the generic engine reproduces the old per-kind behaviour exactly.
 * Deliberately NOT extended for a new context kind: a new kind is a definition in
 * `core/push/kinds/`, nothing here.
 */
export function applyPlanUrls(
	plans: ReadonlyArray<PlanReference> | undefined,
	planUrls: ReadonlyArray<{ slug: string; url: string; docId: number }>,
): ReadonlyArray<PlanReference> | undefined {
	if (!plans || planUrls.length === 0) return plans;
	return weaveLegacy(
		"plans",
		plans,
		planUrls.map((p) => ({ entryKey: p.slug, url: p.url, docId: p.docId })),
	);
}

/** Legacy delegate — see {@link applyPlanUrls}. Matched by note id. */
export function applyNoteUrls(
	notes: ReadonlyArray<NoteReference>,
	noteUrls: ReadonlyArray<{ id: string; url: string; docId: number }>,
): ReadonlyArray<NoteReference> {
	return weaveLegacy(
		"notes",
		notes,
		noteUrls.map((n) => ({ entryKey: n.id, url: n.url, docId: n.docId })),
	);
}

/** Legacy delegate — see {@link applyPlanUrls}. Matched by the per-commit `archivedKey`. */
export function applyReferenceUrls(
	references: ReadonlyArray<ReferenceCommitRef>,
	referenceUrls: ReadonlyArray<{ archivedKey: string; url: string; docId: number }>,
): ReadonlyArray<ReferenceCommitRef> {
	if (referenceUrls.length === 0) return references;
	return weaveLegacy(
		"references",
		references,
		referenceUrls.map((r) => ({ entryKey: r.archivedKey, url: r.url, docId: r.docId })),
	);
}

/**
 * Runs one field's items through {@link applyPublishedUrls} by wrapping them in a
 * throwaway summary. Only the named field is read back, so the rest of the shape
 * is irrelevant.
 */
function weaveLegacy<T>(
	field: "plans" | "notes" | "references",
	items: ReadonlyArray<T>,
	docs: ReadonlyArray<{ entryKey: string; url: string; docId: number }>,
): ReadonlyArray<T> {
	const docType = field === "plans" ? "plan" : field === "notes" ? "note" : "reference";
	const carrier = { [field]: items } as unknown as CommitSummary;
	const woven = applyPublishedUrls(carrier, new Map([[docType, docs]]));
	return (woven as unknown as Record<string, ReadonlyArray<T>>)[field];
}

/**
 * Legacy named-shape view of {@link assignOwnedContext}, kept so the existing
 * assertions (15 destructuring sites) still pin the winner and seed rules.
 *
 * Deliberately NOT extended for a new context kind — read the generic
 * {@link assignOwnedContext} output instead, which covers every registered kind
 * without naming any of them.
 */
export function assignOwnedAttachments(subjectSummaries: ReadonlyArray<CommitSummary>): {
	ownedPlans: Map<string, PlanReference[]>;
	ownedNotes: Map<string, NoteReference[]>;
	ownedReferences: Map<string, ReferenceCommitRef[]>;
	seedPlanDocIds: Map<string, number>;
	seedNoteDocIds: Map<string, number>;
	seedReferenceDocIds: Map<string, number>;
} {
	const owned = assignOwnedContext(subjectSummaries);
	return {
		ownedPlans: ownedMapOf<PlanReference>(owned, "plan"),
		ownedNotes: ownedMapOf<NoteReference>(owned, "note"),
		ownedReferences: ownedMapOf<ReferenceCommitRef>(owned, "reference"),
		seedPlanDocIds: seedMapOf(owned, "plan"),
		seedNoteDocIds: seedMapOf(owned, "note"),
		seedReferenceDocIds: seedMapOf(owned, "reference"),
	};
}

function ownedMapOf<T>(owned: OwnedContext, docType: string): Map<string, T[]> {
	const out = new Map<string, T[]>();
	/* v8 ignore next -- the `?? []` is unreachable: assignOwnedContext seeds an entry for
	   EVERY registered kind, and plan/note/reference are registered, so the lookup always
	   hits. Kept so a future de-registration degrades to an empty map rather than throwing.
	   Suppressed on this line ALONE, not around both functions: the wrapping form also
	   excluded the loop and both function declarations, which the legacy-adapter tests do
	   cover — the whole point of keeping those adapters. */
	const forKind = owned.get(docType)?.owned ?? [];
	for (const [hash, items] of forKind) out.set(hash, [...(items as ReadonlyArray<T>)]);
	return out;
}

function seedMapOf(owned: OwnedContext, docType: string): Map<string, number> {
	const forKind = owned.get(docType);
	/* v8 ignore next -- unreachable `?? []`, see ownedMapOf. */
	return new Map(forKind?.seeds ?? []);
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
	// withRelevance: the pushed Jolli Space article shows the same relevance
	// picture as every other summary surface (webview, clipboard, Memory Bank
	// .md) — only PR bodies stay relevance-free. Without it the cli and vscode
	// push paths would also diverge from each other.
	pushPlansAndNotesSection(lines, summary, { includeReferences: true, withRelevance: true });
	pushRecapSection(lines, summary);
	pushE2eTestSection(lines, summary.e2eTestGuide);
	pushSourceCommitsSection(lines, sourceNodes);
	pushTopicsSection(lines, allTopics, pushTopicBody, { singular: "Topic", plural: "Topics" });
	pushFooter(lines, summary);

	return lines.join("\n");
}

// ── Batch push helpers ───────────────────────────────────────────────────────

/**
 * Builds the article-URL placeholder embedded in batch summary content where an
 * attachment's final URL will go. The server substitutes the real URLs after
 * minting the doc ids — in a single-request protocol the client cannot know
 * them up front.
 *
 * MUST stay byte-for-byte in lockstep with the server's `docUrlPlaceholder`
 * (`backend/src/router/PushRouter.ts`) — same spirit as the `parseJolliApiKey`
 * lockstep rule.
 */
export function docUrlPlaceholder(clientKey: string): string {
	return `{{jolli:doc:${clientKey}}}`;
}

// ── Push orchestration (network I/O) ─────────────────────────────────────────

/**
 * The attachments to push for a summary — caller-chosen, or the summary's own when
 * omitted.
 *
 * **Legacy named-field shape, deliberately frozen.** A new context kind does NOT
 * add a field here: `pushSummary` accepts either this or the kind-agnostic
 * {@link ContextSelection} map, and every in-repo caller now passes the map. This
 * form only survives so the 48 existing `{ plans: [p], notes: [] }` test literals
 * keep compiling — which is what makes them evidence that the generic engine
 * reproduces the old behaviour.
 */
export interface AttachmentSelection {
	readonly plans: ReadonlyArray<PlanReference>;
	readonly notes: ReadonlyArray<NoteReference>;
	/** Deduped (owner-commit) references; omit to push none for this summary. */
	readonly references?: ReadonlyArray<ReferenceCommitRef>;
}

/**
 * Normalizes either selection form into a {@link ContextSelection}.
 *
 * The tri-state is load-bearing and easy to invert: **no selection at all** means
 * "push the summary's own items", while a selection **present but missing a kind's
 * key** means "push none of that kind". The legacy shape spelled the second case
 * as `attachments.references ?? []`, so a `Map` must carry an explicit empty array
 * for every registered kind the caller did not name — which is what
 * {@link legacyNamedSelection} does by walking the registry.
 */
function toContextSelection(
	attachments: AttachmentSelection | ContextSelection | undefined,
): ContextSelection | undefined {
	if (attachments === undefined) return undefined;
	// Discriminate on a named field rather than `instanceof Map`: `ContextSelection`
	// is a ReadonlyMap *interface*, which TS cannot narrow with instanceof.
	if (!("plans" in attachments)) return attachments;
	return legacyNamedSelection(attachments);
}

/** Result of pushing one summary: the persisted (write-back applied) summary, plus its article URL. */
export interface PushSummaryResult {
	readonly summary: CommitSummary;
	readonly summaryUrl: string;
	/** Article id minted (or updated) by this push — pairs with {@link summaryUrl}. */
	readonly docId: number;
	/**
	 * The server's Space echo from the summary push (newer servers,
	 * repoUrl-routed pushes only) — callers persist it as the local binding
	 * cache. Absent on older servers.
	 */
	readonly jmSpace?: { readonly id: number; readonly name: string };
	/**
	 * The article was published but its docId never reached local storage. The
	 * push itself SUCCEEDED — the caller must keep the pending entry and record
	 * {@link docId} / {@link summaryUrl} on it (`pushedDocId` / `pushedUrl`) so
	 * the next drain UPDATEs that article instead of CREATEing a duplicate, and
	 * must NOT burn a retry: nothing about the push needs retrying, only the
	 * local bookkeeping.
	 */
	readonly writeBackFailed?: boolean;
	/**
	 * Orphaned articles are still awaiting deletion — either because
	 * {@link PushSummaryOptions.skipOrphanCleanup} deferred it, or because a
	 * cleanup pass could not delete every id. The caller must keep the pending
	 * entry (patch, not delete) so a later confirmed drain finishes the job;
	 * dropping it would strand those articles with nothing pointing at them.
	 */
	readonly cleanupPending?: boolean;
}

export interface PushSummaryOptions {
	/**
	 * Skips orphan resolution and deletion, reporting
	 * {@link PushSummaryResult.cleanupPending} instead.
	 *
	 * The pre-push worker sets this. Orphan cleanup issues real `deleteDoc`
	 * calls, and pre-push runs BEFORE git has transferred objects: if the push is
	 * then rejected, the remote history still contains those commits while their
	 * articles are gone, and the pending entry that could have restored them was
	 * deleted on success. Unrecoverable.
	 *
	 * The compensation drains leave this off — they confirm the push against the
	 * remote first, so deleting is safe there. Only the unconfirmed pre-push flow
	 * sets it.
	 */
	readonly skipOrphanCleanup?: boolean;
}

/**
 * Pushes one summary's context attachments (in registry order) and then the
 * summary itself (+summaryJson) to a Jolli Space, writing the returned
 * `docId`/`docUrl` back into the stored summary. Port of the VS Code
 * `pushSummaryWithAttachments` (`JolliPushOrchestrator.ts:154-263`).
 *
 * Best-effort on attachments: an item whose content can't be read, or whose
 * individual push fails with a transient error, is skipped (logged) rather than
 * aborting the whole push. `DocTypeNotAllowedError` short-circuits just that KIND
 * (see `pushContextAttachments`). Two errors are fatal and propagate from any push
 * — `BindingRequiredError` and `ClientOutdatedError` (426; the CLI analogue of
 * vscode's `PluginOutdatedError`); the caller (`pushBranchToJolli`) surfaces them
 * as `{ type: "binding_required" }` / `{ type: "error" }` rather than retrying
 * inline (unlike the VS Code version, which resolves the binding case via an
 * injected chooser).
 */
export async function pushSummary(
	original: CommitSummary,
	ctx: PushContext,
	attachments?: AttachmentSelection | ContextSelection,
	opts?: PushSummaryOptions,
): Promise<PushSummaryResult> {
	// Convert any per-skill article ids published by an older version into the
	// commit-level one before anything reads them — see `adoptLegacySkillDocIds`.
	// Persisted by this function's own write-back, like every other field it updates.
	const summary = adoptLegacySkillDocIds(original);
	const displayBase = ctx.baseUrl.replace(/\/+$/, "");
	// Env key of the tenant this push targets — every docId minted below is tagged
	// with it, and an existing docId is reused as an update target only when its
	// tag matches (see `canReuseDocId`). No network I/O.
	const envKey = await ctx.client.resolveEnvKey();
	const selection = toContextSelection(attachments);

	const published = await pushContextAttachments(summary, ctx, envKey, selection);

	// Weave the published URLs into the copy the markdown is rendered from, so the
	// article's Context list links to the published docs. `reduceOwnItems` first:
	// only the reduced set was uploaded (same-named plan snapshots collapse), so the
	// rendered body must list the same set.
	const summaryForMarkdown = applyPublishedUrls(reduceOwnItems(summary), published);
	const markdown = buildPushMarkdown(summaryForMarkdown);
	// The structured twin of the markdown article, from the same enriched copy —
	// the share page renders it directly instead of regex-parsing the markdown.
	const summaryJson = serializeSummaryJson(summaryForMarkdown);

	// Live re-read of the opt-out before the summary send too: the attachment loops
	// above may have taken seconds, and this is the last outbound call of the group.
	await assertOutboundStillAllowed(ctx.cwd);
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
		return {
			summary,
			summaryUrl,
			docId: result.docId,
			...(result.jmSpace !== undefined ? { jmSpace: result.jmSpace } : {}),
		};
	}

	// Write-back weaves onto the summary's OWN items (not the reduced copy above), so
	// an unpushed same-named plan snapshot keeps its place in stored history.
	const updatedSummary: CommitSummary = {
		...applyPublishedUrls(summary, published),
		jolliDocUrl: summaryUrl,
		jolliDocId: result.docId,
	};
	// The article exists server-side from here on, so a write-back failure must
	// NOT surface as a failed push. Report it instead: the caller records the
	// minted docId/url on the pending entry so the retry UPDATEs that article
	// rather than CREATEing a second one. Without this the id is lost exactly
	// like an aborted request loses it.
	let writeBackFailed = false;
	try {
		await storeSummary(updatedSummary, ctx.cwd, true, undefined, ctx.storage);
	} catch (err) {
		writeBackFailed = true;
		// `docId` rather than `summaryUrl`: the id is the server's own response
		// field, so it identifies the stranded article without dragging the
		// API-key-derived base URL into a log sink (see the `writeBackFailed`
		// branch in `pushBranchToJolli` for why that matters). It is also what a
		// caller needs to reconcile by hand — the user-facing message points here.
		log.warn(
			"Local write-back after a successful push failed for %s (article id %d): %s",
			summary.commitHash.substring(0, 8),
			result.docId,
			err instanceof Error ? err.message : String(err),
		);
	}

	const common = {
		summaryUrl,
		docId: result.docId,
		...(writeBackFailed ? { writeBackFailed: true } : {}),
		...(result.jmSpace !== undefined ? { jmSpace: result.jmSpace } : {}),
	};

	// Orphan cleanup issues real deleteDoc calls, so it only runs where the push
	// is already known to have reached the remote. See PushSummaryOptions.
	if (opts?.skipOrphanCleanup) {
		const cleanupPending = hasPendingOrphanCleanup(updatedSummary);
		if (cleanupPending) {
			log.info(
				"Deferring orphan cleanup for %s — this push is not confirmed on the remote yet",
				summary.commitHash.substring(0, 8),
			);
		}
		return { ...common, summary: updatedSummary, ...(cleanupPending ? { cleanupPending: true } : {}) };
	}

	const summaryForCleanup = await resolveUnresolvedOrphanHashes(updatedSummary, ctx);

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

	// Reported from the FINAL state rather than from "did we skip cleanup":
	// cleanupOrphanedDocs leaves ids it could not delete in orphanedDocIds for the
	// next push, and the caller has to keep the pending entry for those too.
	return {
		...common,
		summary: finalSummary,
		...(hasPendingOrphanCleanup(finalSummary) ? { cleanupPending: true } : {}),
	};
}

function hasPendingOrphanCleanup(summary: CommitSummary): boolean {
	return (summary.orphanedDocIds?.length ?? 0) > 0 || (summary.unresolvedOrphanHashes?.length ?? 0) > 0;
}

/**
 * Resolves hashes recorded during a squash/push race into article ids that can
 * be deleted. Shared by single and batch push paths so batch-first compensation
 * preserves the same cleanup behavior as `pushSummary`.
 */
async function resolveUnresolvedOrphanHashes(summary: CommitSummary, ctx: PushContext): Promise<CommitSummary> {
	const unresolved = summary.unresolvedOrphanHashes;
	if (!unresolved || unresolved.length === 0) return summary;

	// Retain hashes still present in push-pending because another worker may yet
	// write back their docId. If the pending file cannot be read, retain every
	// unresolved hash conservatively instead of risking an orphan leak.
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
	for (const hash of unresolved) {
		const fresh = await getSummary(hash, ctx.cwd, ctx.storage);
		// Guard against tree-hash fallback resolving to the merged summary itself.
		if (fresh?.jolliDocId && fresh.commitHash === hash) {
			resolvedDocIds.push(fresh.jolliDocId);
		} else if (pending === undefined) {
			remainingHashes.push(hash);
		} else if (pending.entries[hash]) {
			remainingHashes.push(hash);
			stillInFlight++;
		}
	}

	if (resolvedDocIds.length === 0 && remainingHashes.length === unresolved.length) return summary;
	if (resolvedDocIds.length > 0) {
		log.info(
			"Resolved %d orphan hashes → docIds for cleanup (%d retained, %d still in-flight)",
			resolvedDocIds.length,
			remainingHashes.length,
			stillInFlight,
		);
	}
	const mergedOrphanIds = [...new Set([...(summary.orphanedDocIds ?? []), ...resolvedDocIds])];
	const resolvedSummary: CommitSummary = {
		...summary,
		orphanedDocIds: mergedOrphanIds.length > 0 ? mergedOrphanIds : undefined,
		unresolvedOrphanHashes: remainingHashes.length > 0 ? [...new Set(remainingHashes)] : undefined,
	};
	await storeSummary(resolvedSummary, ctx.cwd, true, undefined, ctx.storage);
	return resolvedSummary;
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
	| { readonly type: "push_disabled"; readonly message: string }
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
 *
 * A published summary whose local write-back failed
 * ({@link PushSummaryResult.writeBackFailed}) stops the loop with
 * `{ type: "error" }`. This path has no per-commit retry state to carry the
 * minted docId forward, so a "pushed" verdict there would hide a lost id behind
 * a success and duplicate the article on the next push.
 */
export async function pushBranchToJolli(opts: PushBranchOpts): Promise<PushBranchResult> {
	const client = opts.client ?? new JolliMemoryPushClient();
	const cwd = opts.cwd;
	try {
		// Per-repo outbound-push opt-out (Story 2). Fail closed before any network
		// call so a manual `jolli push` / MCP `push_memory` can never leak from a
		// repo the user push-disabled. Memory stays recorded locally.
		if (!(await isOutboundPushAllowed(cwd))) {
			// Same wording as the thrown form — taken FROM it rather than re-typed, so
			// the CLI's two refusal shapes (a tagged result here, an error on the bridge)
			// can never drift into two different sentences for one condition.
			return { type: "push_disabled", message: new PushDisabledError().message };
		}
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
			// This bind site only knows the id/slug the user typed — drop the
			// local cache and let the push echo below (or the next probe)
			// rebuild it with the authoritative Space details.
			await clearSpaceBindingCache(cwd);
		}

		const base = opts.baseBranch ?? (await getDefaultBranch(cwd));
		const { summaries, missingCount } = await loadBranchSummaries(cwd, base);
		const storage = getActiveStorage();
		const ctx: PushContext = { cwd, baseUrl: await client.resolveBaseUrl(), repoUrl, client, storage };

		// Mirror LiveShareController.pushBranchMemoriesToSpace: cross-commit dedup,
		// then push oldest→newest passing each summary its OWNED (deduped) attachments.
		//
		// `selectionForCommit`, NOT the legacy named shape: a selection that names only
		// plan/note/reference means "push ZERO of every other kind" (see
		// `toContextSelection`), so building one by hand would silently skip skill —
		// and every future kind — on this path while the drains still pushed them.
		const owned = assignOwnedContext(summaries);
		const urls: string[] = [];
		let confirmedSpace: { id: number; name: string } | undefined;
		for (const s of summaries) {
			const attachments = selectionForCommit(owned, s.commitHash);
			// BindingRequiredError propagates — fatal for the whole batch.
			const { summaryUrl, jmSpace, writeBackFailed } = await pushSummary(s, ctx, attachments);
			if (jmSpace) {
				confirmedSpace = jmSpace;
			}
			if (writeBackFailed) {
				// The article IS published, but its docId never reached local storage.
				// Unlike the drains (see PushExecutor's `writeBackFailed` branch) this
				// path owns no push-pending entry to record the minted id on, so nothing
				// points at that article any more: reporting "pushed" would send the user
				// into a re-push that CREATEs a second article for this commit. Report the
				// loud failure this was before `pushSummary` started swallowing the
				// write-back error, and leave the remaining summaries unsent — they all
				// need the very write that just failed.
				//
				// Deliberately WITHOUT `summaryUrl`. That URL is built from
				// `ctx.baseUrl`, which `resolveAuth` derives by base64-decoding the
				// API key's embedded `.u` claim — so CodeQL's `js/clear-text-logging`
				// taint tracker treats it as secret-derived and flags every console
				// call this message reaches (four of them, via `emitError` and the
				// `--format json` branch in `JolliCloudCommands`). Re-adding the URL
				// here re-opens all four alerts: every reported flow path for them
				// entered `JolliCloudCommands` through this object's `message` field,
				// and this template was the only step that put a key-derived value
				// into it.
				//
				// THE ALERTS ARE FALSE POSITIVES, AND THIS IS NOT A SANITIZER.
				// Nothing secret is disclosed: `.u` is the tenant's public site URL
				// (the address the user types into a browser), and the key itself
				// only ever travels in an Authorization header. The URL is dropped
				// here because it carries nothing the reader needs — the commit hash
				// identifies the summary, and `pushSummary` logs the stranded
				// article's id to `debug.log`, which this message points at.
				//
				// So this is a value judgement about ONE message, not a rule that
				// key-derived URLs must not be printed. `jolli push` deliberately
				// keeps printing the very same URLs on its SUCCESS path — they are
				// the point of the command — and that asymmetry is intended, not an
				// oversight left behind by this change. If a future CodeQL release
				// starts tracking taint through the `urls` array and flags the
				// success path too, the answer is to dismiss those alerts as
				// false positives (or model `parseJolliApiKey` as a sanitizer), NOT
				// to strip the links a user asked for.
				return {
					type: "error",
					message: `Pushed ${s.commitHash.substring(0, 8)}, but recording its article id locally failed, so a re-push would create a second article for that commit. Remaining summaries were not pushed — see .jolli/jollimemory/debug.log.`,
				};
			}
			urls.push(summaryUrl);
		}
		// A successful push proves both the binding and push rights — persist
		// the server's Space echo so status/front-door render with zero network
		// I/O. Best-effort: a cache hiccup must not fail a completed push.
		if (confirmedSpace) {
			try {
				await saveSpaceBindingCache(cwd, {
					repoUrl,
					origin: parseBaseUrl(ctx.baseUrl).origin,
					jmSpaceId: confirmedSpace.id,
					spaceName: confirmedSpace.name,
					canPush: true,
				});
			} catch (err) {
				log.debug(
					"binding cache update after push failed: %s",
					err instanceof Error ? err.message : String(err),
				);
			}
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
		if (err instanceof PushDisabledError) {
			// The opt-out was flipped mid-run (the entry gate above passed). Report the
			// SAME tagged result the entry gate returns rather than `type:"error"` —
			// `jolli push` prints it and exits 0, and MCP `push_memory` must not mark a
			// deliberate user setting as a failure. Summaries already pushed in this run
			// stay pushed; the rest simply were not sent.
			return { type: "push_disabled", message: err.message };
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

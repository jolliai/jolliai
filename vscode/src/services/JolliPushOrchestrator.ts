/**
 * JolliPushOrchestrator
 *
 * UI-agnostic push of ONE summary plus its plans/notes to a Jolli Memory Space.
 * Extracted from SummaryWebviewPanel so both the per-summary "Share in Jolli"
 * button and the subject-level live share (LiveShareController) drive the *same*
 * push path — pushing twice would mint duplicate articles and desync jolliDocId.
 *
 * It does NO VS Code UI: no `vscode.window`, no `postMessage`, no panel re-render.
 * Instead it RETURNS the data the caller needs to render (the pushed doc ids, the
 * updated summary, the partial-attachment failures, whether it was an update vs a
 * first push). The binding chooser is injected as `ctx.resolveBinding` so the
 * chooser webview stays in the panel layer.
 *
 * Attachment selection is the CALLER's choice (`attachments`): the live-share
 * controller dedupes plans/notes branch-wide to their latest revision and hands
 * each summary only the attachments it should push (with `jolliPlanDocId` /
 * `jolliNoteDocId` already resolved from its branch-wide map, so the push updates
 * the one Space doc in place instead of creating a duplicate). When `attachments`
 * is omitted, the summary's own `latestPlanPerName(plans)` + `notes` are pushed —
 * the standalone button's existing behavior.
 */

import type { CommitSummary, NoteReference, PlanReference, ReferenceCommitRef } from "../../../cli/src/Types.js";
import { deriveJolliEnvKey, resolveArticleUrl } from "../../../cli/src/core/JolliApiUtils.js";
import { buildReferencePushMarkdown } from "../../../cli/src/core/SummaryMarkdownBuilder.js";
import { readReferenceMarkdownFromString } from "../../../cli/src/core/references/ReferenceStore.js";
import { readNoteFromBranch, readPlanFromBranch, readReferenceFromBranch } from "../../../cli/src/core/SummaryStore.js";
import { track } from "../../../cli/src/core/Telemetry.js";
import { log } from "../util/Logger.js";
import { latestPlanPerName } from "../util/PlanGrouping.js";
import {
	buildBranchRelativePath,
	buildNotePushTitle,
	buildPlanPushTitle,
	buildPushTitle,
	buildReferencePushTitle,
} from "../views/SummaryUtils.js";
import { buildMarkdown } from "../views/SummaryMarkdownBuilder.js";
import { BindingRequiredError, deleteFromJolli, PluginOutdatedError, pushToJolli } from "./JolliPushService.js";

/** Outcome of the injected binding-chooser callback. */
export type BindingOutcome = { status: "bound" | "anotherOpen" | "cancelled" | "failed" };

/** A per-plan/per-note push failure, collected (not thrown) so one bad attachment doesn't abort the push. */
export interface PushAttachmentFailure {
	/** Human-readable identifier, e.g. `plan "Fix P1/P2 review findings"`. */
	readonly label: string;
	/** Error message (includes the HTTP status from JolliPushService). */
	readonly message: string;
}

/**
 * Raised when the push can't proceed because a Space binding wasn't established.
 * `outcome` lets the caller decide messaging: `anotherOpen` (a chooser is already
 * open elsewhere) vs `cancelled` (the user dismissed it) vs `failed`.
 */
export class ShareBindingError extends Error {
	constructor(readonly outcome: "anotherOpen" | "cancelled" | "failed") {
		super(`Space binding ${outcome}`);
		this.name = "ShareBindingError";
	}
}

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
 * fields — `jolliDocId`/`jolliDocUrl` churn per push and `orphanedDocIds` is
 * cleanup bookkeeping, none of which is commit content the share page should see
 * (stripping them also keeps a re-push of unchanged content byte-identical, so
 * the server upsert can no-op). Returns undefined (with a warning) above
 * {@link MAX_SUMMARY_JSON_BYTES}.
 */
export function serializeSummaryJson(summary: CommitSummary): string | undefined {
	const { jolliDocId: _docId, jolliDocUrl: _docUrl, orphanedDocIds: _orphaned, ...content } = summary;
	const json = JSON.stringify(content);
	if (Buffer.byteLength(json, "utf-8") > MAX_SUMMARY_JSON_BYTES) {
		log.warn(
			"PushOrchestrator",
			`Summary JSON for ${summary.commitHash.substring(0, 8)} exceeds ${MAX_SUMMARY_JSON_BYTES} bytes — pushing markdown only`,
		);
		return;
	}
	return json;
}

/** Everything the orchestrator needs that isn't on the summary itself. */
export interface PushContext {
	/** Resolved site base URL (the API key's `u`), passed verbatim to `pushToJolli`. */
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly repoUrl: string;
	/** Worktree root — plan/note bodies are read from the orphan branch relative to it. */
	readonly workspaceRoot: string;
	/** Persists the summary (and its rewritten doc ids) locally; `bridge.storeSummary`. */
	readonly storeSummary: (summary: CommitSummary, syncToCloud: boolean) => Promise<void>;
	/** Opens the binding chooser and reports the outcome. Injected so chooser UI stays in the panel. */
	readonly resolveBinding: (repoUrl: string) => Promise<BindingOutcome>;
}

/** A pushed plan/note: keyed by slug/id so the caller can map it back across commits. */
export interface PushedPlan {
	readonly slug: string;
	readonly title: string;
	readonly docId: number;
	readonly url: string;
}
export interface PushedNote {
	readonly id: string;
	readonly title: string;
	readonly docId: number;
	readonly url: string;
}
export interface PushedReference {
	readonly archivedKey: string;
	/** Stable cross-commit identity `<source>:<nativeId>` so `covered` resolves the shared article. */
	readonly baseKey: string;
	readonly title: string;
	readonly docId: number;
	readonly url: string;
}

/** The doc ids one summary push produced — feeds the live share's `covered` allowlist. */
export interface PushedDoc {
	readonly commitHash: string;
	readonly summaryDocId: number;
	readonly summaryUrl: string;
	readonly plans: ReadonlyArray<PushedPlan>;
	readonly notes: ReadonlyArray<PushedNote>;
	readonly references: ReadonlyArray<PushedReference>;
}

/** Result of pushing one summary; UI-renderable data only. */
export interface PushSummaryResult {
	readonly pushedDoc: PushedDoc;
	/** Summary after URL rewrite + storeSummary + orphan cleanup — the caller adopts this as current. */
	readonly updatedSummary: CommitSummary;
	readonly attachmentFailures: ReadonlyArray<PushAttachmentFailure>;
	/** True when the summary already had a `jolliDocUrl` (an update), false for a first push. */
	readonly isUpdate: boolean;
	/** Number of attachments (plans + notes) successfully pushed. */
	readonly attachmentCount: number;
}

/** The plans/notes/references to push for a summary — caller-chosen, or the summary's own when omitted. */
export interface AttachmentSelection {
	readonly plans: ReadonlyArray<PlanReference>;
	readonly notes: ReadonlyArray<NoteReference>;
	/** Deduped (owner-commit) references; omit to push none for this summary (the branch path passes them explicitly). */
	readonly references?: ReadonlyArray<ReferenceCommitRef>;
}

export interface PushSummaryOptions {
	/**
	 * Treat unreadable local attachment bodies as upload failures. Regular manual
	 * Push keeps the historic best-effort behavior; live share enables this so the
	 * share page cannot point at stale seeded docIds when the current body is missing.
	 */
	readonly strictAttachments?: boolean;
}

/**
 * Pushes one summary + a chosen attachment set; persists `jolliDocId`/url, cleans
 * orphans, and returns the doc ids + renderable result. UI-free — see file header.
 */
export async function pushSummaryWithAttachments(
	summary: CommitSummary,
	ctx: PushContext,
	attachments?: AttachmentSelection,
	options: PushSummaryOptions = {},
	retried = false,
): Promise<PushSummaryResult> {
	const displayBase = ctx.baseUrl.replace(/\/+$/, "");
	// Env key of the tenant this push targets — every docId minted below is tagged
	// with it, and an existing docId is reused as an update target only when its
	// tag matches (see `canReuseDocId`).
	const envKey = deriveJolliEnvKey(ctx.baseUrl) ?? "";
	const plansToPush = attachments ? attachments.plans : latestPlanPerName(summary.plans ?? []);
	const notesToPush = attachments ? attachments.notes : (summary.notes ?? []);
	const referencesToPush = attachments ? (attachments.references ?? []) : (summary.references ?? []);

	try {
		// Step 1: upload plans + notes. Per-attachment failures are collected, not
		// thrown, so one bad plan/note doesn't abort the summary push. Fatal
		// binding/plugin errors still propagate to drive the chooser below.
		const { results: planUrls, failures: planFailures } = await pushPlanList(
			plansToPush,
			summary,
			ctx,
			displayBase,
			envKey,
			Boolean(options.strictAttachments),
		);
		const { results: noteUrls, failures: noteFailures } = await pushNoteList(
			notesToPush,
			summary,
			ctx,
			displayBase,
			envKey,
			Boolean(options.strictAttachments),
		);
		const { results: referenceUrls, failures: referenceFailures } = await pushReferenceList(
			referencesToPush,
			summary,
			ctx,
			displayBase,
			envKey,
		);
		// References are auto-extracted context, not user-attached content, so their
		// push is BEST-EFFORT: a failure is logged (in pushReferenceList) but must NOT
		// join `attachmentFailures`, which the strict branch-share path turns into a
		// fatal AttachmentPushError. Otherwise one reference the server rejects (e.g. a
		// backend that doesn't yet accept docType:"reference") would abort the whole
		// share — the CLI path already just logs+skips, so this keeps the two in step.
		if (referenceFailures.length > 0) {
			log.warn(
				"PushOrchestrator",
				`${referenceFailures.length} reference push(es) failed (non-fatal, skipped): ${referenceFailures.map((f) => f.label).join(", ")}`,
			);
		}
		const attachmentFailures = [...planFailures, ...noteFailures];

		// Step 2: weave the published URLs into the summary markdown (so the
		// article's Plans & Notes list links to the published docs). Dedupe
		// same-named plan snapshots — only the latest was uploaded.
		const dedupedPlans = latestPlanPerName(summary.plans ?? []);
		/* v8 ignore start -- unreachable defensive fallback: applyPlanUrls returns its first arg unchanged when there are no URLs to weave in, and dedupedPlans is always a (possibly empty) array — so `?? dedupedPlans` never fires; it only satisfies applyPlanUrls's `| undefined` return type */
		const plansWithUrls = applyPlanUrls(dedupedPlans, planUrls) ?? dedupedPlans;
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
		const markdown = buildMarkdown(summaryForMarkdown);
		// The structured twin of the markdown article, from the same enriched copy —
		// the share page renders it directly instead of regex-parsing the markdown.
		const summaryJson = serializeSummaryJson(summaryForMarkdown);

		const result = await pushToJolli(ctx.baseUrl, ctx.apiKey, {
			title: buildPushTitle(summary),
			content: markdown,
			commitHash: summary.commitHash,
			docType: "summary",
			branch: summary.branch,
			...(summary.jolliDocId && canReuseDocId(summary.jolliDocUrl, envKey) && { docId: summary.jolliDocId }),
			repoUrl: ctx.repoUrl,
			relativePath: buildBranchRelativePath(summary.branch),
			...(summaryJson && { summaryJson }),
		});

		track("memory_pushed", { kind: "summary" });

		const summaryUrl = resolveArticleUrl(displayBase, result.url, result.docId);
		const isUpdate = Boolean(summary.jolliDocUrl);

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
		await ctx.storeSummary(updatedSummary, true);

		// Clean up orphaned articles, then persist which ones were actually deleted.
		// Best-effort: the summary + jolliDocId are already pushed and stored above, so a
		// cleanup/bookkeeping failure must not surface to the caller as a failed push.
		let cleanedSummary: CommitSummary | null = null;
		try {
			cleanedSummary = await cleanupOrphanedDocs(summary, updatedSummary, displayBase, ctx);
		} catch (err) {
			log.warn(
				"PushOrchestrator",
				`Orphan cleanup failed after a successful push: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		return {
			pushedDoc: {
				commitHash: summary.commitHash,
				summaryDocId: result.docId,
				summaryUrl,
				plans: planUrls,
				notes: noteUrls,
				references: referenceUrls,
			},
			updatedSummary: cleanedSummary ?? updatedSummary,
			attachmentFailures,
			isUpdate,
			attachmentCount: planUrls.length + noteUrls.length + referenceUrls.length,
		};
	} catch (err: unknown) {
		if (err instanceof BindingRequiredError && !retried) {
			const outcome = await ctx.resolveBinding(ctx.repoUrl);
			if (outcome.status === "bound") {
				return pushSummaryWithAttachments(summary, ctx, attachments, options, true);
			}
			throw new ShareBindingError(outcome.status);
		}
		throw err;
	}
}

/**
 * Uploads the given plans, returning their published URLs + per-plan failures.
 * A single plan failure is collected (not thrown); fatal binding/plugin errors
 * propagate so the caller can drive the chooser.
 */
async function pushPlanList(
	plans: ReadonlyArray<PlanReference>,
	summary: CommitSummary,
	ctx: PushContext,
	displayBase: string,
	envKey: string,
	strictAttachments: boolean,
): Promise<{ results: PushedPlan[]; failures: PushAttachmentFailure[] }> {
	const failures: PushAttachmentFailure[] = [];
	const results: PushedPlan[] = [];
	for (const plan of plans) {
		const planContent = (await readPlanFromBranch(plan.slug, ctx.workspaceRoot)) ?? "";
		if (!planContent) {
			if (strictAttachments) {
				failures.push({
					label: `plan "${plan.title}"`,
					message: `Plan content for ${plan.slug} could not be read.`,
				});
			}
			log.info("PushOrchestrator", `Plan ${plan.slug}: no content found, skipping`);
			continue;
		}
		let planResult: Awaited<ReturnType<typeof pushToJolli>>;
		try {
			planResult = await pushToJolli(ctx.baseUrl, ctx.apiKey, {
				title: buildPlanPushTitle(summary, plan.title),
				content: planContent,
				commitHash: summary.commitHash,
				docType: "plan",
				branch: summary.branch,
				...(plan.jolliPlanDocId && canReuseDocId(plan.jolliPlanDocUrl, envKey) && { docId: plan.jolliPlanDocId }),
				repoUrl: ctx.repoUrl,
				relativePath: buildBranchRelativePath(summary.branch),
			});
		} catch (err) {
			if (err instanceof BindingRequiredError || err instanceof PluginOutdatedError) throw err;
			const msg = err instanceof Error ? err.message : String(err);
			log.error("PushOrchestrator", `Plan ${plan.slug} push FAILED: ${msg}`);
			failures.push({ label: `plan "${plan.title}"`, message: msg });
			continue;
		}
		results.push({
			slug: plan.slug,
			title: plan.title,
			url: resolveArticleUrl(displayBase, planResult.url, planResult.docId),
			docId: planResult.docId,
		});
	}
	return { results, failures };
}

/** Uploads the given notes; like {@link pushPlanList}, single-note failures are collected. */
async function pushNoteList(
	notes: ReadonlyArray<NoteReference>,
	summary: CommitSummary,
	ctx: PushContext,
	displayBase: string,
	envKey: string,
	strictAttachments: boolean,
): Promise<{ results: PushedNote[]; failures: PushAttachmentFailure[] }> {
	const failures: PushAttachmentFailure[] = [];
	const results: PushedNote[] = [];
	for (const note of notes) {
		let noteContent: string;
		if (note.format === "snippet") {
			if (note.content === undefined || note.content === "") {
				if (strictAttachments) {
					failures.push({
						label: `note "${note.title}"`,
						message: `Snippet note content for ${note.id} is empty.`,
					});
				}
				log.warn("PushOrchestrator", `Snippet note ${note.id} has no content — skipping push`);
				continue;
			}
			noteContent = note.content;
		} else {
			noteContent = (await readNoteFromBranch(note.id, ctx.workspaceRoot)) ?? "";
			if (!noteContent) {
				if (strictAttachments) {
					failures.push({
						label: `note "${note.title}"`,
						message: `Note content for ${note.id} could not be read.`,
					});
				}
				log.info("PushOrchestrator", `Note ${note.id}: no content found, skipping`);
				continue;
			}
		}
		let noteResult: Awaited<ReturnType<typeof pushToJolli>>;
		try {
			noteResult = await pushToJolli(ctx.baseUrl, ctx.apiKey, {
				title: buildNotePushTitle(summary, note.title),
				content: noteContent,
				commitHash: summary.commitHash,
				docType: "note",
				branch: summary.branch,
				...(note.jolliNoteDocId && canReuseDocId(note.jolliNoteDocUrl, envKey) && { docId: note.jolliNoteDocId }),
				repoUrl: ctx.repoUrl,
				relativePath: buildBranchRelativePath(summary.branch),
			});
		} catch (err) {
			if (err instanceof BindingRequiredError || err instanceof PluginOutdatedError) throw err;
			const msg = err instanceof Error ? err.message : String(err);
			log.error("PushOrchestrator", `Note ${note.id} push FAILED: ${msg}`);
			failures.push({ label: `note "${note.title}"`, message: msg });
			continue;
		}
		results.push({
			id: note.id,
			title: note.title,
			url: resolveArticleUrl(displayBase, noteResult.url, noteResult.docId),
			docId: noteResult.docId,
		});
	}
	return { results, failures };
}

/**
 * Uploads the given archived references as standalone `reference` articles. The
 * body is synthesized from the value snapshot ({@link buildReferencePushMarkdown})
 * since a reference has no on-disk file. Like {@link pushPlanList}, a single
 * transient failure is collected; fatal binding/plugin errors propagate.
 */
async function pushReferenceList(
	references: ReadonlyArray<ReferenceCommitRef>,
	summary: CommitSummary,
	ctx: PushContext,
	displayBase: string,
	envKey: string,
): Promise<{ results: PushedReference[]; failures: PushAttachmentFailure[] }> {
	const failures: PushAttachmentFailure[] = [];
	const results: PushedReference[] = [];
	for (const ref of references) {
		const title = buildReferencePushTitle(ref);
		// Read the archived body from the orphan-branch snapshot so the pushed article
		// carries the SAME content shown locally (the local `.md` is deleted at commit
		// time). Missing/unparseable → header-only, never a failed push.
		const storedMd = await readReferenceFromBranch(ref.source, ref.archivedKey, ctx.workspaceRoot);
		const description = storedMd ? (readReferenceMarkdownFromString(storedMd)?.description ?? undefined) : undefined;
		let refResult: Awaited<ReturnType<typeof pushToJolli>>;
		try {
			refResult = await pushToJolli(ctx.baseUrl, ctx.apiKey, {
				title,
				content: buildReferencePushMarkdown(ref, description),
				commitHash: summary.commitHash,
				docType: "reference",
				branch: summary.branch,
				...(ref.jolliReferenceDocId &&
					canReuseDocId(ref.jolliReferenceDocUrl, envKey) && { docId: ref.jolliReferenceDocId }),
				repoUrl: ctx.repoUrl,
				relativePath: buildBranchRelativePath(summary.branch),
			});
		} catch (err) {
			if (err instanceof BindingRequiredError || err instanceof PluginOutdatedError) throw err;
			const msg = err instanceof Error ? err.message : String(err);
			log.error("PushOrchestrator", `Reference ${ref.archivedKey} push FAILED: ${msg}`);
			failures.push({ label: `reference "${title}"`, message: msg });
			continue;
		}
		results.push({
			archivedKey: ref.archivedKey,
			baseKey: `${ref.source}:${ref.nativeId}`,
			title,
			url: resolveArticleUrl(displayBase, refResult.url, refResult.docId),
			docId: refResult.docId,
		});
	}
	return { results, failures };
}

/**
 * A stored `jolliDocId` may be reused as an update target only when the article
 * URL it was minted with points at the current push env — the URL's origin IS the
 * env, so `deriveJolliEnvKey(storedDocUrl)` recovers the backend the id belongs to
 * (no separate env tag is stored). A URL from a different origin means the id lives
 * on another backend → drop it and let the server create a fresh doc. A missing URL
 * is legacy / never-pushed (reuse allowed); an unparseable one is treated as
 * env-agnostic rather than throwing. Mirror of the CLI `canReuseDocId`.
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
 * `archivedKey` (the exact per-commit entry). The URL's origin is the minting env —
 * see {@link canReuseDocId}. Mirror of the CLI `applyReferenceUrls`.
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
 * Deletes orphaned articles from the Space, then persists the result: only ids
 * that were successfully deleted are cleared from `orphanedDocIds`; failed ids are
 * kept so the next push retries them. Returns the persisted summary, or null when
 * there were no orphans.
 */
async function cleanupOrphanedDocs(
	originalSummary: CommitSummary,
	updatedSummary: CommitSummary,
	displayBase: string,
	ctx: PushContext,
): Promise<CommitSummary | null> {
	const orphanedIds = originalSummary.orphanedDocIds ? [...originalSummary.orphanedDocIds] : [];
	if (orphanedIds.length === 0) return null;

	const results = await Promise.allSettled(
		orphanedIds.map((id) => deleteFromJolli(displayBase, ctx.apiKey, id).then(() => id)),
	);
	const deleted = new Set<number>();
	for (const r of results) {
		if (r.status === "fulfilled") deleted.add(r.value);
	}
	const remaining = orphanedIds.filter((id) => !deleted.has(id));
	if (deleted.size > 0) log.info("PushOrchestrator", `Deleted ${deleted.size} orphaned article(s)`);
	if (remaining.length > 0) {
		log.warn("PushOrchestrator", `Failed to delete ${remaining.length} orphaned article(s), will retry on next push`);
	}

	const cleaned: CommitSummary = {
		...updatedSummary,
		...(remaining.length > 0 ? { orphanedDocIds: remaining } : { orphanedDocIds: undefined }),
	};
	await ctx.storeSummary(cleaned, true);
	return cleaned;
}

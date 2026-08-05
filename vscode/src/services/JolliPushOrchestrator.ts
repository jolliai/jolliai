/**
 * JolliPushOrchestrator
 *
 * UI-agnostic push of ONE summary plus its context attachments to a Jolli Memory
 * Space. Extracted from SummaryWebviewPanel so both the per-summary "Share in
 * Jolli" button and the subject-level live share (LiveShareController) drive the
 * *same* push path — pushing twice would mint duplicate articles and desync
 * jolliDocId.
 *
 * It does NO VS Code UI: no `vscode.window`, no `postMessage`, no panel re-render.
 * Instead it RETURNS the data the caller needs to render (the pushed doc ids, the
 * updated summary, the partial-attachment failures, whether it was an update vs a
 * first push). The binding chooser is injected as `ctx.resolveBinding` so the
 * chooser webview stays in the panel layer.
 *
 * **Table-driven attachments.** Which kinds of attachment exist — and their
 * identity, dedup and doc-state fields — comes from the shared context-kind
 * registry (`cli/src/core/push/`). This file no longer names plan/note/reference
 * anywhere in its push loop: a kind registered in `kinds/index.ts` is pushed here
 * automatically, using this extension's own HTTP stack (`pushToJolli`) and its
 * own failure semantics (see `pushAttachmentKinds`).
 *
 * Attachment selection is the CALLER's choice (`attachments`): the live-share
 * controller dedupes attachments branch-wide to their latest revision and hands
 * each summary only the ones it should push (with doc ids already resolved from
 * its branch-wide map, so the push updates the one Space doc in place instead of
 * creating a duplicate). When `attachments` is omitted, the summary's own items
 * (per-kind reduced) are pushed — the standalone button's existing behavior.
 */

import type { CommitSummary, NoteReference, PlanReference, ReferenceCommitRef } from "../../../cli/src/Types.js";
import { deriveJolliEnvKey, resolveArticleUrl } from "../../../cli/src/core/JolliApiUtils.js";
import { DocTypeNotAllowedError } from "../../../cli/src/core/JolliMemoryPushClient.js";
import { isOutboundPushAllowed } from "../../../cli/src/core/PushControl.js";
import { isRepoWideRefusal } from "../../../cli/src/core/PushRefusal.js";
import {
	baseKeyOfItem,
	docIdOf,
	docUrlOf,
	entryKeyOf,
	getContextKinds,
} from "../../../cli/src/core/push/ContextKindRegistry.js";
import {
	applyPublishedUrls,
	type ContextSelection,
	itemsToPush,
	legacyNamedSelection,
	reduceOwnItems,
} from "../../../cli/src/core/push/ContextPush.js";
import { canReuseDocId } from "../../../cli/src/core/push/DocIdReuse.js";
import { track } from "../../../cli/src/core/Telemetry.js";
import { log } from "../util/Logger.js";
import { buildBranchRelativePath, buildPushTitle } from "../views/SummaryUtils.js";
import { buildMarkdown } from "../views/SummaryMarkdownBuilder.js";
import { BindingRequiredError, deleteFromJolli, PushDisabledError, pushToJolli } from "./JolliPushService.js";

/**
 * Errors that must ABORT this summary's push instead of being collected as a
 * per-attachment failure: every {@link isRepoWideRefusal} (see `cli/src/core/PushRefusal.ts`
 * for why that lives in its own module), plus `BindingRequiredError` — fatal
 * *here* because the orchestrator cannot run the chooser itself, so it propagates
 * to the caller that can. Shared by the whole attachment loop so the set cannot
 * drift between kinds.
 */
function isFatalPushError(err: unknown): boolean {
	return isRepoWideRefusal(err) || (err instanceof Error && err.name === "BindingRequiredError");
}

/** Outcome of the injected binding-chooser callback. */
export type BindingOutcome = { status: "bound" | "anotherOpen" | "cancelled" | "failed" };

/** A per-attachment push failure, collected (not thrown) so one bad attachment doesn't abort the push. */
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

/** One published attachment article, in kind-agnostic form. */
export interface PushedAttachment {
	/** The item's per-commit entry identity (its kind's `entryKey`). */
	readonly entryKey: string;
	/** Its cross-commit identity, for callers that resolve a shared article across commits. */
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
	/** Published attachments per docType — the kind-agnostic record new consumers should read. */
	readonly attachments: ReadonlyMap<string, ReadonlyArray<PushedAttachment>>;
	/** Legacy named views of `attachments` — kept for existing consumers; not extended for new kinds. */
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
	/**
	 * Attachments that failed but were SKIPPED rather than treated as a failure
	 * (kinds declaring `bestEffortPush`). Separate from `attachmentFailures` because
	 * the strict branch-share path turns that list into a fatal error, while these
	 * must never abort a push — but callers should still tell the user, or a manual
	 * push reports plain success having silently published fewer articles.
	 */
	readonly skippedAttachments: ReadonlyArray<PushAttachmentFailure>;
	/** True when the summary already had a `jolliDocUrl` (an update), false for a first push. */
	readonly isUpdate: boolean;
	/** Number of attachments successfully pushed, across every kind. */
	readonly attachmentCount: number;
}

/**
 * The attachments to push for a summary — caller-chosen, or the summary's own when
 * omitted.
 *
 * **Legacy named-field shape, deliberately frozen** (see the CLI orchestrator's
 * twin for the full rationale): a new context kind does NOT add a field here —
 * callers pass the kind-agnostic `ContextSelection` map instead.
 */
export interface AttachmentSelection {
	readonly plans: ReadonlyArray<PlanReference>;
	readonly notes: ReadonlyArray<NoteReference>;
	/** Deduped (owner-commit) references; omit to push none for this summary. */
	readonly references?: ReadonlyArray<ReferenceCommitRef>;
}

/**
 * Normalizes either selection form into a `ContextSelection`. Missing-key
 * semantics are load-bearing — see the CLI twin: a selection PRESENT but missing
 * a kind means "push none of that kind", never "fall back to the summary's own".
 *
 * The expansion itself is `legacyNamedSelection`, shared with the CLI: this surface
 * must not carry its own hard-coded `["plan","note","reference"]` list, because a
 * per-surface list is what let the branch-share path silently skip `skill`.
 */
function toContextSelection(
	attachments: AttachmentSelection | ContextSelection | undefined,
): ContextSelection | undefined {
	if (attachments === undefined) return undefined;
	if (!("plans" in attachments)) return attachments;
	return legacyNamedSelection(attachments);
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
	attachments?: AttachmentSelection | ContextSelection,
	options: PushSummaryOptions = {},
	retried = false,
): Promise<PushSummaryResult> {
	// Story 2: fail fast for a push-disabled repo before uploading anything.
	// Checking here (not only inside each HTTP call) avoids issuing a doomed
	// per-attachment push that would be mislabeled as an attachment failure. The
	// HTTP client still re-checks per call — both as defense-in-depth for any
	// non-orchestrator caller and because spec 306 requires the flag be read LIVE
	// (no cached decision), so a mid-push opt-out takes effect immediately. That
	// makes the gate 1 + N reads for N attachments, each resolving the repo
	// identity again; deliberate — correctness over saving a few `git config` spawns.
	if (!(await isOutboundPushAllowed(ctx.workspaceRoot))) {
		throw new PushDisabledError();
	}
	const displayBase = ctx.baseUrl.replace(/\/+$/, "");
	// Env key of the tenant this push targets — every docId minted below is tagged
	// with it, and an existing docId is reused as an update target only when its
	// tag matches (see `canReuseDocId`).
	const envKey = deriveJolliEnvKey(ctx.baseUrl) ?? "";
	const selection = toContextSelection(attachments);

	try {
		// Step 1: upload every kind's attachments. User-attached kinds collect their
		// failures (strict branch-share turns them fatal); best-effort kinds only log.
		const { published, failures: attachmentFailures, skipped: skippedAttachments } = await pushAttachmentKinds(
			summary,
			ctx,
			displayBase,
			envKey,
			selection,
			Boolean(options.strictAttachments),
		);

		// Step 2: weave the published URLs into the summary markdown (so the
		// article's Context list links to the published docs). `reduceOwnItems`
		// first — only the reduced set was uploaded (same-named plan snapshots
		// collapse), so the rendered body must list the same set.
		const summaryForMarkdown = applyPublishedUrls(reduceOwnItems(summary), published);
		const markdown = buildMarkdown(summaryForMarkdown);
		// The structured twin of the markdown article, from the same enriched copy —
		// the share page renders it directly instead of regex-parsing the markdown.
		const summaryJson = serializeSummaryJson(summaryForMarkdown);

		const result = await pushToJolli(
			ctx.baseUrl,
			ctx.apiKey,
			{
				title: buildPushTitle(summary),
				content: markdown,
				commitHash: summary.commitHash,
				docType: "summary",
				branch: summary.branch,
				...(summary.jolliDocId && canReuseDocId(summary.jolliDocUrl, envKey) && { docId: summary.jolliDocId }),
				repoUrl: ctx.repoUrl,
				relativePath: buildBranchRelativePath(summary.branch),
				...(summaryJson && { summaryJson }),
			},
			ctx.workspaceRoot,
		);

		track("memory_pushed", { kind: "summary" });

		const summaryUrl = resolveArticleUrl(displayBase, result.url, result.docId);
		const isUpdate = Boolean(summary.jolliDocUrl);

		// Write-back weaves onto the summary's OWN items (not the reduced copy), so an
		// unpushed same-named plan snapshot keeps its place in stored history.
		const updatedSummary: CommitSummary = {
			...applyPublishedUrls(summary, published),
			jolliDocUrl: summaryUrl,
			jolliDocId: result.docId,
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

		let attachmentCount = 0;
		for (const docs of published.values()) attachmentCount += docs.length;
		return {
			pushedDoc: {
				commitHash: summary.commitHash,
				summaryDocId: result.docId,
				summaryUrl,
				attachments: published,
				plans: (published.get("plan") ?? []).map((a) => ({
					slug: a.entryKey,
					title: a.title,
					docId: a.docId,
					url: a.url,
				})),
				notes: (published.get("note") ?? []).map((a) => ({
					id: a.entryKey,
					title: a.title,
					docId: a.docId,
					url: a.url,
				})),
				references: (published.get("reference") ?? []).map((a) => ({
					archivedKey: a.entryKey,
					baseKey: a.baseKey,
					title: a.title,
					docId: a.docId,
					url: a.url,
				})),
			},
			updatedSummary: cleanedSummary ?? updatedSummary,
			attachmentFailures,
			skippedAttachments,
			isUpdate,
			attachmentCount,
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
 * Uploads every registered kind's attachments for one summary — the extension's
 * counterpart of the CLI's `pushContextAttachments`, using this extension's own
 * HTTP stack (`pushToJolli`, which re-checks the outbound opt-out per call).
 *
 * Failure semantics differ per kind and come from the definition:
 *
 *  - **User-attached kinds** (plan, note): a failed item is COLLECTED into
 *    `failures`; the strict branch-share path turns those into a fatal
 *    `AttachmentPushError`. In strict mode an unreadable body is a failure too —
 *    the share page must not point at stale seeded docIds when the current body
 *    is missing.
 *  - **Best-effort kinds** (`bestEffortPush`, e.g. references): auto-extracted
 *    context, so a failure is logged and skipped but must NOT join `failures` —
 *    one item the server rejects (e.g. a backend that doesn't yet accept its
 *    docType) would otherwise abort a whole share the user never attached it to.
 *  - A `DocTypeNotAllowedError` short-circuits the KIND: the server has no config
 *    row for that docType, so every remaining item of the same kind would fail
 *    identically — one actionable log line instead of a dozen.
 *  - {@link isFatalPushError} ones propagate so the caller can drive the chooser
 *    / surface the repo-wide refusal.
 *
 * **`skipped` is reported per KIND, not per item.** Both routes into it are
 * kind-wide conditions — a docType the server has not enabled, or N items of one
 * auto-extracted kind failing for the same reason — and the caller renders every
 * label verbatim in a notification. One entry per item made the clean
 * (`doctype_not_allowed`) path silent while the degraded path produced a
 * notification a dozen titles long; both now collapse to a single line.
 */
async function pushAttachmentKinds(
	summary: CommitSummary,
	ctx: PushContext,
	displayBase: string,
	envKey: string,
	selection: ContextSelection | undefined,
	strictAttachments: boolean,
): Promise<{
	published: Map<string, PushedAttachment[]>;
	failures: PushAttachmentFailure[];
	skipped: PushAttachmentFailure[];
}> {
	const published = new Map<string, PushedAttachment[]>();
	const failures: PushAttachmentFailure[] = [];
	// Best-effort failures. Kept OUT of `failures` (which the strict branch-share
	// path turns fatal) but still reported to the caller: "best effort" must mean
	// "does not abort the push", NOT "is hidden from the user" — a manual push that
	// silently dropped an article while reporting success is a lie.
	const skipped: PushAttachmentFailure[] = [];
	const bodyCtx = { cwd: ctx.workspaceRoot };
	for (const kind of getContextKinds()) {
		const results: PushedAttachment[] = [];
		// Per-item best-effort failures, collapsed into one reported entry below.
		const bestEffort: PushAttachmentFailure[] = [];
		let kindRefusal: string | undefined;
		for (const item of itemsToPush(kind, summary, selection)) {
			const entryKey = entryKeyOf(kind, item);
			const title = kind.title(item, summary);
			const label = `${kind.docType} "${title}"`;
			const content = await kind.body(item, bodyCtx);
			if (content === undefined || content === "") {
				if (kind.bestEffortPush === true) {
					// Auto-extracted context with no body is unremarkable — it was never
					// something the user attached.
					log.info("PushOrchestrator", `${kind.docType} ${entryKey}: no content found, skipping`);
				} else {
					// User-attached content the push cannot read is notable: the article
					// silently will not exist. That covers ordinary absence (an unarchived
					// plan body) and schema drift alike — e.g. a snippet note, which is
					// supposed to carry its content inline, arriving without any.
					log.warn("PushOrchestrator", `${kind.docType} ${entryKey}: no content found, skipping push`);
					if (strictAttachments) {
						const kindLabel = kind.docType.charAt(0).toUpperCase() + kind.docType.slice(1);
						failures.push({ label, message: `${kindLabel} content for ${entryKey} could not be read.` });
					}
				}
				continue;
			}
			const storedDocId = docIdOf(kind, item);
			let pushResult: Awaited<ReturnType<typeof pushToJolli>>;
			try {
				pushResult = await pushToJolli(
					ctx.baseUrl,
					ctx.apiKey,
					{
						title,
						content,
						commitHash: summary.commitHash,
						docType: kind.docType,
						branch: summary.branch,
						...(storedDocId !== undefined &&
							canReuseDocId(docUrlOf(kind, item), envKey) && { docId: storedDocId }),
						repoUrl: ctx.repoUrl,
						relativePath: buildBranchRelativePath(summary.branch),
					},
					ctx.workspaceRoot,
				);
			} catch (err) {
				if (isFatalPushError(err)) throw err;
				const msg = err instanceof Error ? err.message : String(err);
				if (err instanceof DocTypeNotAllowedError) {
					// Reported to the caller as well as logged: this is the CLEAN refusal —
					// the server told us in machine-readable form that it publishes nothing
					// of this kind. Logging only would make the well-behaved server the
					// silent case and a generic-500 server the loud one.
					kindRefusal = `The server does not have article type "${kind.docType}" enabled.`;
					log.warn(
						"PushOrchestrator",
						`${kindRefusal} None of this commit's ${kind.docType} articles were pushed. Enable it in the server's supported-docType configuration. (${msg})`,
					);
					break;
				}
				log.error("PushOrchestrator", `${kind.docType} ${entryKey} push FAILED: ${msg}`);
				if (kind.bestEffortPush === true) {
					bestEffort.push({ label, message: msg });
				} else {
					failures.push({ label, message: msg });
				}
				continue;
			}
			results.push({
				entryKey,
				baseKey: baseKeyOfItem(kind, item),
				title,
				url: resolveArticleUrl(displayBase, pushResult.url, pushResult.docId),
				docId: pushResult.docId,
			});
		}
		if (kindRefusal !== undefined) {
			skipped.push({ label: `${kind.docType} article(s)`, message: kindRefusal });
		}
		if (bestEffort.length > 0) {
			// The log keeps every title (it is where you go to find out WHICH ones); the
			// reported entry carries only the count and the first reason, because the
			// caller renders it into a notification and a dozen titles there is unreadable.
			log.warn(
				"PushOrchestrator",
				`${bestEffort.length} ${kind.docType} push(es) failed (non-fatal, skipped): ${bestEffort.map((f) => f.label).join(", ")}`,
			);
			skipped.push({ label: `${bestEffort.length} ${kind.docType} article(s)`, message: bestEffort[0].message });
		}
		published.set(kind.docType, results);
	}
	return { published, failures, skipped };
}

/**
 * Re-exported from the shared push layer — the same reuse gate the CLI uses; see
 * `cli/src/core/push/DocIdReuse.ts` for the env-key rationale.
 */
export { canReuseDocId };

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
		orphanedIds.map((id) => deleteFromJolli(displayBase, ctx.apiKey, id, ctx.workspaceRoot).then(() => id)),
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

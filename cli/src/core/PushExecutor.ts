/**
 * PushExecutor — the shared "drain push-pending.json to Jolli Space" core.
 *
 * Two drain flavors share the triage/claim/accounting machinery:
 *   - `processPushPending`   — compensation drain, called by QueueWorker
 *     post-drain (source="post-queue", hashFilter set) and plugin/CLI
 *     activation (source="activation"). Publishes only after the remote ref
 *     confirms the git push landed. Batch-first (chunks of BATCH_MAX_ITEMS
 *     through `pushBatch`, orphan cleanup included); falls back to the legacy
 *     per-commit `pushSummary` loop when the server predates the endpoint.
 *   - `processPrePushInline` — called synchronously INSIDE the pre-push hook,
 *     before git transfers objects. Pushes every with-memory candidate in ONE
 *     `pushBatch` HTTP request under a hard wall-clock budget, deliberately
 *     WITHOUT push confirmation (waiting for the remote ref inside the hook
 *     would deadlock — git waits for the hook to exit before transferring).
 *
 * Both reuse the existing push_memory building blocks — `pushSummary` /
 * `buildBatchItems` + `applyBatchResult` for uploads and
 * `assignOwnedAttachments` for cross-commit plan/note dedup — so nothing about
 * the Jolli Space contract is re-implemented here (JOLLI-1900 requirement 3).
 * `pushBranchToJolli` is intentionally NOT used: it pushes the whole branch as
 * one unit with no per-commit retry state, which is what the pending-file
 * model provides.
 *
 * Cross-commit dedup requires the full branch context. The current branch uses
 * `base..HEAD`; off-current branches are reconstructed from root summaries in
 * the summary index. Every pending commit therefore gets the plans/notes it
 * owns even when the user checked out another branch before the drain runs.
 */

import { createLogger, errMsg } from "../Logger.js";
import type { CommitSummary } from "../Types.js";
import { mapWithConcurrency } from "./Concurrency.js";
import { execGit, getCurrentBranch, getDefaultBranch } from "./GitOps.js";
import { getCanonicalRepoUrl } from "./GitRemoteUtils.js";
import { resolveArticleUrl } from "./JolliApiUtils.js";
import {
	BATCH_MAX_ITEMS,
	BATCH_MAX_TOTAL_CONTENT_CHARS,
	type BatchPushResult,
	BatchUnsupportedError,
	BindingRequiredError,
	ClientOutdatedError,
	JolliMemoryPushClient,
	NotAuthenticatedError,
	PermissionDeniedError,
} from "./JolliMemoryPushClient.js";
import {
	type AttachmentSelection,
	applyBatchResult,
	assignOwnedAttachments,
	type BatchWriteBackFailure,
	type BuiltBatchItem,
	buildBatchItems,
	type PushContext,
	pushSummary,
} from "./JolliMemoryPushOrchestrator.js";
import { loadBranchSummaries } from "./PrDescription.js";
import {
	type BatchUpdate,
	claimForPush,
	loadPushPending,
	MAX_RETRY_COUNT,
	PUSH_CONCURRENCY,
	type PushPendingEntry,
	type PushTarget,
	updateBatch,
} from "./PushPendingStore.js";
import { loadConfig } from "./SessionTracker.js";
import { createStorage } from "./StorageFactory.js";
import type { StorageProvider } from "./StorageProvider.js";
import { getActiveStorage, getIndexEntryMap, getSummary, setActiveStorage } from "./SummaryStore.js";

const log = createLogger("PushExecutor");

/**
 * Minimum wall-clock budget worth spending on the inline batch HTTP request.
 * Below this, `processPrePushInline` releases its claims instead of firing a
 * request that would almost certainly be aborted mid-flight.
 */
export const INLINE_MIN_HTTP_BUDGET_MS = 500;

/** Where a `processPushPending` call originated — used only for logging. */
export type PushSource = "post-queue" | "activation";

export interface ProcessPushPendingOptions {
	readonly source: PushSource;
	/** When set, only these hashes are considered (QueueWorker post-drain path). */
	readonly hashFilter?: ReadonlySet<string>;
	/** Test seam — defaults to a real client. */
	readonly client?: JolliMemoryPushClient;
}

export interface ProcessPushPendingResult {
	readonly attempted: number;
	readonly pushed: number;
	readonly failed: number;
	readonly skippedNoMemory: number;
	readonly skippedRetryExhausted: number;
	/**
	 * Count of pending entries dropped this run because the commit is now a
	 * child in the summary index (squash/amend after the entry was enqueued).
	 * Reported separately from `pushed`/`failed` — no network was attempted.
	 */
	readonly deletedChildren: number;
	/** Set when the whole run short-circuited (no work / not signed in). */
	readonly note?: string;
}

/**
 * Classifies a push failure into whether it should count against the retry
 * budget. Configuration / environment failures (not signed in, no binding,
 * client too old) require an explicit user action to fix, so retrying every
 * push forever would burn the retry budget for nothing — they record the error
 * but do NOT increment `retryCount`. Everything else (network, 5xx, 4xx,
 * unknown) is operational and increments so it eventually gives up.
 */
export function classifyError(err: unknown): { readonly increment: boolean; readonly message: string } {
	if (err instanceof NotAuthenticatedError) return { increment: false, message: "not-authenticated" };
	if (err instanceof PermissionDeniedError) return { increment: false, message: "permission-denied" };
	if (err instanceof BindingRequiredError) return { increment: false, message: "binding-required" };
	if (err instanceof ClientOutdatedError) return { increment: false, message: "client-outdated" };
	return { increment: true, message: errMsg(err) };
}

/**
 * Ensures a StorageProvider is active for this process. The pre-push hook
 * process starts fresh (no active storage) and must create one; the QueueWorker
 * post-drain path already has storage set by the drain, so we reuse it.
 */
async function ensureStorage(cwd: string): Promise<StorageProvider> {
	const active = getActiveStorage();
	if (active) return active;
	const storage = await createStorage(cwd, cwd);
	setActiveStorage(storage);
	return storage;
}

function pushTargetKey(target: PushTarget): string {
	return `${target.remote}\0${target.remoteRef}\0${target.localSha}`;
}

async function resolvePushRemote(cwd: string, remote: string): Promise<string> {
	const result = await execGit(["remote", "get-url", "--push", remote], cwd);
	return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim().split("\n")[0] : remote;
}

async function isPushTargetConfirmed(cwd: string, target: PushTarget, remote: string): Promise<boolean> {
	const result = await execGit(["ls-remote", "--refs", remote, target.remoteRef], cwd);
	if (result.exitCode !== 0) return false;
	const remoteSha = result.stdout
		.split("\n")
		.map((line) => line.trim().split(/\s+/, 2))
		.find((parts) => parts[1] === target.remoteRef)?.[0];
	if (!remoteSha) return false;
	if (remoteSha === target.localSha) return true;

	// A later push may already have advanced the remote ref. When the newer tip
	// exists locally, ancestry still proves that this push reached the remote.
	const ancestor = await execGit(["merge-base", "--is-ancestor", target.localSha, remoteSha], cwd);
	return ancestor.exitCode === 0;
}

async function waitForConfirmedPushes(
	cwd: string,
	hashes: ReadonlyArray<string>,
	entries: Readonly<Record<string, PushPendingEntry>>,
): Promise<string[]> {
	const targets = new Map<string, PushTarget>();
	for (const hash of hashes) {
		for (const target of entries[hash].pushTargets ?? []) targets.set(pushTargetKey(target), target);
	}
	if (targets.size === 0) return [...hashes]; // Backward compatibility for legacy pending files.

	const confirmedTargets = new Set<string>();
	const pushRemotes = new Map<string, string>();
	for (const target of targets.values()) {
		if (!pushRemotes.has(target.remote))
			pushRemotes.set(target.remote, await resolvePushRemote(cwd, target.remote));
	}
	// Single pass: both remaining callers (post-queue, activation) run after any
	// git push has already finished, so there is nothing to poll for — the old
	// 60x1s pre-push polling went away with the detached PrePushWorker.
	await Promise.all(
		[...targets].map(async ([key, target]) => {
			if (await isPushTargetConfirmed(cwd, target, pushRemotes.get(target.remote) ?? target.remote))
				confirmedTargets.add(key);
		}),
	);
	return hashes.filter((hash) => {
		const entryTargets = entries[hash].pushTargets;
		return !entryTargets?.length || entryTargets.some((target) => confirmedTargets.has(pushTargetKey(target)));
	});
}

async function buildAttachmentOwnership(
	cwd: string,
	storage: StorageProvider,
	pendingEntries: Readonly<Record<string, PushPendingEntry>>,
	hashes: ReadonlyArray<string>,
	candidates: ReadonlyMap<string, CommitSummary>,
): Promise<{
	ownedPlans: Map<string, NonNullable<CommitSummary["plans"]>>;
	ownedNotes: Map<string, NonNullable<CommitSummary["notes"]>>;
	ownedReferences: Map<string, NonNullable<CommitSummary["references"]>>;
}> {
	const branches = new Set(hashes.map((hash) => pendingEntries[hash].branch));
	const contexts = new Map<string, Map<string, CommitSummary>>();
	for (const branch of branches) contexts.set(branch, new Map());

	const currentBranch = await getCurrentBranch(cwd);
	if (branches.has(currentBranch)) {
		const base = await getDefaultBranch(cwd);
		const { summaries } = await loadBranchSummaries(cwd, base);
		const context = contexts.get(currentBranch);
		for (const summary of summaries) context?.set(summary.commitHash, summary);
	}

	const offCurrentBranches = new Set([...branches].filter((branch) => branch !== currentBranch));
	if (offCurrentBranches.size > 0) {
		const indexEntries = await getIndexEntryMap(cwd, storage);
		const rootHashes = new Set<string>();
		for (const entry of indexEntries.values()) {
			if (entry.parentCommitHash == null && offCurrentBranches.has(entry.branch))
				rootHashes.add(entry.commitHash);
		}
		for (const hash of rootHashes) {
			const summary = candidates.get(hash) ?? (await getSummary(hash, cwd, storage));
			if (summary?.commitHash === hash) contexts.get(summary.branch)?.set(hash, summary);
		}
	}

	for (const hash of hashes) {
		const summary = candidates.get(hash);
		if (summary) contexts.get(pendingEntries[hash].branch)?.set(hash, summary);
	}

	const ownedPlans = new Map<string, NonNullable<CommitSummary["plans"]>>();
	const ownedNotes = new Map<string, NonNullable<CommitSummary["notes"]>>();
	const ownedReferences = new Map<string, NonNullable<CommitSummary["references"]>>();
	for (const context of contexts.values()) {
		const summaries = [...context.values()].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
		const owned = assignOwnedAttachments(summaries);
		for (const [hash, plans] of owned.ownedPlans) ownedPlans.set(hash, plans);
		for (const [hash, notes] of owned.ownedNotes) ownedNotes.set(hash, notes);
		for (const [hash, references] of owned.ownedReferences) ownedReferences.set(hash, references);
	}
	return { ownedPlans, ownedNotes, ownedReferences };
}

/** Partitions batch-eligible items by both item count and total content size. */
function partitionBatchItems(items: ReadonlyArray<BuiltBatchItem>): BuiltBatchItem[][] {
	const batches: BuiltBatchItem[][] = [];
	let current: BuiltBatchItem[] = [];
	let currentChars = 0;
	for (const item of items) {
		if (
			current.length > 0 &&
			(current.length >= BATCH_MAX_ITEMS || currentChars + item.batchContentChars > BATCH_MAX_TOTAL_CONTENT_CHARS)
		) {
			batches.push(current);
			current = [];
			currentChars = 0;
		}
		current.push(item);
		currentChars += item.batchContentChars;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

/** Keeps successful entries queued when their orphan cleanup is not finished. */
function preserveCleanupPending(
	updates: Map<string, BatchUpdate>,
	cleanupPendingHashes: ReadonlyArray<string> | undefined,
): void {
	for (const hash of cleanupPendingHashes ?? []) {
		if (updates.get(hash)?.kind === "delete") updates.set(hash, { kind: "patch", patch: {} });
	}
}

/**
 * Keeps entries whose article was pushed but whose local docId write-back
 * failed: the patch records the minted docId/url so the next drain retries as
 * an UPDATE of the same article (never a duplicate CREATE) and the write-back
 * gets another chance. `retryCount` is deliberately untouched — the push
 * itself succeeded, so the operational retry budget must not shrink.
 */
function preserveWriteBackFailures(
	updates: Map<string, BatchUpdate>,
	failures: ReadonlyArray<BatchWriteBackFailure> | undefined,
	attemptedAtIso: string,
): void {
	for (const failure of failures ?? []) {
		if (updates.get(failure.commitHash)?.kind !== "delete") continue;
		updates.set(failure.commitHash, {
			kind: "patch",
			patch: {
				lastAttemptAt: attemptedAtIso,
				lastError: "pushed, but persisting the article id locally failed — will retry the write-back",
				pushedDocId: failure.docId,
				pushedUrl: failure.url,
			},
		});
	}
}

/**
 * Grafts the docId/url a previous push minted — but failed to persist locally
 * (see `PushPendingEntry.pushedDocId`) — onto a summary that lacks one, so the
 * retry UPDATEs the existing article instead of CREATEing a duplicate. The
 * tenant gate stays where it always was: `buildBatchItems`/`pushSummary` only
 * reuse the id when `canReuseDocId` accepts the grafted url.
 */
function withRecoveredDocId(summary: CommitSummary, entry: PushPendingEntry | undefined): CommitSummary {
	if (summary.jolliDocId !== undefined) return summary;
	if (entry?.pushedDocId === undefined || entry.pushedUrl === undefined) return summary;
	return { ...summary, jolliDocId: entry.pushedDocId, jolliDocUrl: entry.pushedUrl };
}

/**
 * Drains eligible entries from `push-pending.json` to the bound Jolli Space.
 * Idempotent and safe to call concurrently across processes — every state
 * mutation goes through `updateBatch` (locked + re-read).
 */
export async function processPushPending(
	cwd: string,
	options: ProcessPushPendingOptions,
): Promise<ProcessPushPendingResult> {
	const empty: ProcessPushPendingResult = {
		attempted: 0,
		pushed: 0,
		failed: 0,
		skippedNoMemory: 0,
		skippedRetryExhausted: 0,
		deletedChildren: 0,
	};

	// Unlocked pre-flight read: cheap scan for eligible candidates. The actual
	// commitment to process specific hashes happens via `claimForPush` below,
	// which atomically stamps `claimedAt` under the file lock so concurrent
	// processes never double-push the same entry.
	const pending = await loadPushPending(cwd);
	const allHashes = Object.keys(pending.entries);
	if (allHashes.length === 0) {
		log.debug("processPushPending(%s): no pending entries", options.source);
		return { ...empty, note: "no pending entries" };
	}
	log.info(
		"processPushPending(%s): %d pending entr(ies)%s",
		options.source,
		allHashes.length,
		options.hashFilter ? ` (filtered to ${options.hashFilter.size} hash(es))` : "",
	);

	const config = await loadConfig();

	// Opt-out gate: syncOnPush=false means the user explicitly disabled
	// push-to-Space sync. Keep the entries (re-enabling should catch up)
	// but do not upload anything — applies to ALL callers (activation,
	// post-queue, pre-push), not just the pre-push hook.
	if (config.syncOnPush === false) {
		log.info("processPushPending(%s): syncOnPush disabled — skipping %d entries", options.source, allHashes.length);
		return { ...empty, note: "syncOnPush disabled" };
	}

	// Auth gate: without a jolliApiKey there is nothing to push to. Keep the
	// entries (the user may sign in later) and return without marking failures.
	if (!config.jolliApiKey) {
		log.info(
			"processPushPending(%s): not signed in — keeping %d entries for later",
			options.source,
			allHashes.length,
		);
		return { ...empty, note: "not signed in" };
	}

	// Eligible = under the retry ceiling, and (when a filter is set) in the filter.
	let skippedRetryExhausted = 0;
	const eligible: string[] = [];
	for (const hash of allHashes) {
		if (options.hashFilter && !options.hashFilter.has(hash)) continue;
		const entry = pending.entries[hash];
		if (entry.retryCount >= MAX_RETRY_COUNT) {
			skippedRetryExhausted++;
			continue;
		}
		eligible.push(hash);
	}
	if (eligible.length === 0) return { ...empty, skippedRetryExhausted, note: "no eligible entries" };

	// Do not publish until the remote ref proves that the push succeeded.
	// Failed/rejected pushes remain pending for a retry.
	const confirmed = await waitForConfirmedPushes(cwd, eligible, pending.entries);
	if (confirmed.length === 0) {
		log.info(
			"processPushPending(%s): no candidate confirmed on the remote yet — keeping %d entr(ies)",
			options.source,
			eligible.length,
		);
		return { ...empty, skippedRetryExhausted, note: "push not confirmed" };
	}
	log.debug(
		"processPushPending(%s): %d/%d candidate(s) confirmed on the remote",
		options.source,
		confirmed.length,
		eligible.length,
	);

	// Atomic claim: stamp `claimedAt` on every confirmed hash under the file
	// lock. A concurrent `processPushPending` that races us will see a fresh
	// `claimedAt` and skip the entry, preventing duplicate Space articles.
	const { claimed, entries: claimedEntries } = await claimForPush(cwd, confirmed);
	if (claimed.size === 0) {
		log.info("processPushPending(%s): all candidates already claimed by another process", options.source);
		return { ...empty, skippedRetryExhausted, note: "all entries claimed by another process" };
	}
	const claimedHashes = confirmed.filter((h) => claimed.has(h));
	log.info(
		"processPushPending(%s): claimed %d/%d candidate(s)",
		options.source,
		claimedHashes.length,
		confirmed.length,
	);

	const storage = await ensureStorage(cwd);

	// Only push commits whose memory has actually been generated. Entries whose
	// summary isn't in storage yet stay pending (QueueWorker's post-drain trigger
	// picks them up once the summary lands).
	//
	// Also skip hashes that are now children in the index (squashed/merged into
	// another root). Pushing a child standalone would call storeSummary(force=true)
	// which re-creates its index entry as a root — a zombie that duplicates the
	// merged root's content and whose Space article gets orphaned on the next
	// cleanup pass.
	const indexEntries = await getIndexEntryMap(cwd, storage);
	const withMemory: string[] = [];
	const candidateSummaries = new Map<string, CommitSummary>();
	let skippedNoMemory = 0;
	let deletedChildren = 0;
	// Pre-flight updates cover hashes we decided NOT to push in this pass:
	//   - Merged children               → { kind: "delete" }
	//   - Missing / mismatched summary  → { kind: "patch", patch: {} }
	// The empty patch is load-bearing: `updateBatch` writes
	// `claimedAt: undefined` on every patch, which releases the claim
	// stamped by `claimForPush` above. Without this release, QueueWorker's
	// post-drain `triggerPushForNewSummaries` would hit the still-fresh
	// `claimedAt` and skip the push, defeating the "push arrived before
	// memory" compensation path this feature was built for.
	const preFlightUpdates = new Map<string, BatchUpdate>();
	for (const hash of claimedHashes) {
		const indexEntry = indexEntries.get(hash);
		if (indexEntry && indexEntry.parentCommitHash != null) {
			preFlightUpdates.set(hash, { kind: "delete" });
			deletedChildren++;
			log.info(
				"Skipping child entry %s (parent=%s) — already merged",
				hash.substring(0, 8),
				indexEntry.parentCommitHash.substring(0, 8),
			);
			continue;
		}
		const summary = await getSummary(hash, cwd, storage);
		// Reject tree-hash-resolved summaries (commitHash mismatch): the real
		// summary for this commit hasn't been generated yet — leave the entry
		// pending so QueueWorker's triggerPushForNewSummaries picks it up once
		// the proper summary lands. Without this, a squash+push races the
		// merge worker and pushes a stale pre-squash summary via tree fallback.
		if (summary && summary.commitHash === hash) {
			withMemory.push(hash);
			candidateSummaries.set(hash, withRecoveredDocId(summary, claimedEntries[hash]));
		} else {
			preFlightUpdates.set(hash, { kind: "patch", patch: {} });
			skippedNoMemory++;
		}
	}
	if (preFlightUpdates.size > 0) {
		await updateBatch(cwd, preFlightUpdates);
	}
	log.info(
		"processPushPending(%s): triage — withMemory=%d noMemory=%d mergedChildren=%d",
		options.source,
		withMemory.length,
		skippedNoMemory,
		deletedChildren,
	);
	if (withMemory.length === 0) {
		const note =
			deletedChildren > 0 && skippedNoMemory === 0
				? "all candidates were merged children"
				: "no candidates with memory";
		return { ...empty, skippedNoMemory, skippedRetryExhausted, deletedChildren, note };
	}

	const ownership = await buildAttachmentOwnership(cwd, storage, claimedEntries, withMemory, candidateSummaries);

	const client = options.client ?? new JolliMemoryPushClient();
	const repoUrl = await getCanonicalRepoUrl(cwd);
	const baseUrl = await client.resolveBaseUrl();
	const ctx: PushContext = { cwd, baseUrl, repoUrl, client, storage };

	log.info("processPushPending(%s): pushing %d commit(s)", options.source, withMemory.length);

	const updates = new Map<string, BatchUpdate>();
	const counters = { pushed: 0, failed: 0 };

	// Batch-first: candidate windows are capped by item count, then split again
	// by the server's total-content limit. Items that cannot pass the batch schema
	// use the legacy per-commit path so one oversized memory cannot reject every
	// otherwise-valid item in its batch.
	let index = 0;
	batchLoop: while (index < withMemory.length) {
		const chunkHashes = withMemory.slice(index, index + BATCH_MAX_ITEMS);
		index += chunkHashes.length;
		const chunkSummaries: CommitSummary[] = [];
		for (const hash of chunkHashes) {
			const summary = candidateSummaries.get(hash);
			if (summary) chunkSummaries.push(summary);
		}
		const built = await buildBatchItems(chunkSummaries, ownership, ctx);
		const individualFallbackHashes = built
			.filter((item) => item.batchIneligibleReason !== undefined)
			.map((item) => item.item.commitHash);
		for (const item of built) {
			if (item.batchIneligibleReason) {
				log.info(
					"Commit %s requires individual push: %s",
					item.item.commitHash.substring(0, 8),
					item.batchIneligibleReason,
				);
			}
		}
		const batchGroups = partitionBatchItems(built.filter((item) => item.batchIneligibleReason === undefined));

		for (let groupIndex = 0; groupIndex < batchGroups.length; groupIndex++) {
			const batchBuilt = batchGroups[groupIndex];
			const batchHashes = batchBuilt.map((item) => item.item.commitHash);
			let batchResult: BatchPushResult;
			try {
				batchResult = await client.pushBatch({ repoUrl, items: batchBuilt.map((item) => item.item) });
			} catch (err) {
				if (err instanceof BatchUnsupportedError) {
					log.info(
						"processPushPending(%s): server lacks batch support — falling back to per-commit pushes",
						options.source,
					);
					const fallbackHashes = [
						...batchGroups.slice(groupIndex).flatMap((group) => group.map((item) => item.item.commitHash)),
						...individualFallbackHashes,
						...withMemory.slice(index),
					];
					await pushCandidatesIndividually({
						cwd,
						storage,
						hashes: fallbackHashes,
						ownership,
						claimedEntries,
						ctx,
						updates,
						counters,
					});
					break batchLoop;
				}
				const { increment, message } = classifyError(err);
				const failedAtIso = new Date().toISOString();
				// Config failures affect every unsent item identically, so release all
				// remaining claims without wasting more network requests.
				const affected = increment
					? batchHashes
					: [
							...batchHashes,
							...batchGroups
								.slice(groupIndex + 1)
								.flatMap((group) => group.map((item) => item.item.commitHash)),
							...individualFallbackHashes,
							...withMemory.slice(index),
						];
				for (const hash of affected) {
					updates.set(hash, {
						kind: "patch",
						patch: {
							lastAttemptAt: failedAtIso,
							lastError: message,
							...(increment ? { retryCount: claimedEntries[hash].retryCount + 1 } : {}),
						},
					});
				}
				counters.failed += affected.length;
				log.warn(
					"processPushPending(%s): batch request failed for %d commit(s): %s (retry %s)",
					options.source,
					affected.length,
					message,
					increment ? "counted" : "held",
				);
				if (!increment) break batchLoop;
				continue;
			}

			const resultByHash = new Map(batchResult.results.map((result) => [result.commitHash, result]));
			const nowIso = new Date().toISOString();
			for (const hash of batchHashes) {
				const result = resultByHash.get(hash);
				if (result?.ok) {
					updates.set(hash, { kind: "delete" });
					counters.pushed++;
					continue;
				}
				counters.failed++;
				const message = result?.error ?? result?.errorCode ?? "missing batch result";
				updates.set(hash, {
					kind: "patch",
					patch: {
						lastAttemptAt: nowIso,
						lastError: message,
						retryCount: claimedEntries[hash].retryCount + 1,
					},
				});
				log.warn("Batch push failed for %s: %s", hash.substring(0, 8), message);
			}

			// Compensation has no wall-clock budget, so it resolves delayed orphan
			// hashes and deletes known orphaned articles after each successful batch.
			try {
				const writeBack = await applyBatchResult(batchBuilt, batchResult.results, ctx, {
					cleanupOrphans: true,
				});
				preserveCleanupPending(updates, writeBack.cleanupPendingHashes);
				preserveWriteBackFailures(updates, writeBack.writeBackFailures, nowIso);
				log.info(
					"processPushPending(%s): write-back — writtenBack=%d childSkipped=%d cleanupPending=%d writeBackFailed=%d",
					options.source,
					writeBack.writtenBack,
					writeBack.childSkipped,
					writeBack.cleanupPendingHashes?.length ?? 0,
					writeBack.writeBackFailures?.length ?? 0,
				);
			} catch (err) {
				log.warn("processPushPending(%s): write-back failed: %s", options.source, errMsg(err));
			}
		}

		if (individualFallbackHashes.length > 0) {
			await pushCandidatesIndividually({
				cwd,
				storage,
				hashes: individualFallbackHashes,
				ownership,
				claimedEntries,
				ctx,
				updates,
				counters,
			});
		}
	}

	await updateBatch(cwd, updates);
	log.info("processPushPending(%s): pushed=%d failed=%d", options.source, counters.pushed, counters.failed);

	return {
		attempted: withMemory.length,
		pushed: counters.pushed,
		failed: counters.failed,
		skippedNoMemory,
		skippedRetryExhausted,
		deletedChildren,
	};
}

/**
 * Legacy per-commit push loop — retained as the fallback for servers that
 * predate the batch endpoint. Identical semantics to the pre-batch drain:
 * re-reads each summary right before the network call (stale-summary race
 * guard), pushes via `pushSummary` (orphan cleanup included), and fills
 * `updates`/`counters` in place.
 */
async function pushCandidatesIndividually(args: {
	readonly cwd: string;
	readonly storage: StorageProvider;
	readonly hashes: ReadonlyArray<string>;
	readonly ownership: {
		readonly ownedPlans: ReadonlyMap<string, NonNullable<CommitSummary["plans"]>>;
		readonly ownedNotes: ReadonlyMap<string, NonNullable<CommitSummary["notes"]>>;
		readonly ownedReferences: ReadonlyMap<string, NonNullable<CommitSummary["references"]>>;
	};
	readonly claimedEntries: Readonly<Record<string, PushPendingEntry>>;
	readonly ctx: PushContext;
	readonly updates: Map<string, BatchUpdate>;
	readonly counters: { pushed: number; failed: number };
}): Promise<void> {
	const { cwd, storage, hashes, ownership, claimedEntries, ctx, updates, counters } = args;
	const nowIso = new Date().toISOString();
	const results = await mapWithConcurrency(hashes, PUSH_CONCURRENCY, async (hash): Promise<"pushed" | "failed"> => {
		// Re-read immediately before the network call so a concurrent rewrite or
		// cleanup cannot make us publish a stale summary captured earlier.
		const freshSummary = await getSummary(hash, cwd, storage);
		if (!freshSummary || freshSummary.commitHash !== hash) {
			// Raced away (deleted between the memory check and here), or
			// tree-hash fallback resolved to another commit's summary. Drop it.
			updates.set(hash, { kind: "delete" });
			return "failed";
		}
		const summary = withRecoveredDocId(freshSummary, claimedEntries[hash]);
		const attachments: AttachmentSelection = {
			plans: ownership.ownedPlans.get(hash) ?? [],
			notes: ownership.ownedNotes.get(hash) ?? [],
			references: ownership.ownedReferences.get(hash) ?? [],
		};
		try {
			await pushSummary(summary, ctx, attachments);
			updates.set(hash, { kind: "delete" });
			return "pushed";
		} catch (err) {
			const { increment, message } = classifyError(err);
			const entry = claimedEntries[hash];
			updates.set(hash, {
				kind: "patch",
				patch: {
					lastAttemptAt: nowIso,
					lastError: message,
					...(increment ? { retryCount: entry.retryCount + 1 } : {}),
				},
			});
			log.warn(
				"Push failed for %s: %s (retry %s)",
				hash.substring(0, 8),
				message,
				increment ? "counted" : "held",
			);
			return "failed";
		}
	});
	for (const result of results) {
		if (result === "pushed") counters.pushed++;
		else counters.failed++;
	}
}

// ─── Inline pre-push drain (synchronous, budget-bound, single batch request) ─

export interface ProcessPrePushInlineOptions {
	/** Commits of the current push — the ONLY entries this drain considers, in push order. */
	readonly priorityHashes: ReadonlyArray<string>;
	/** Absolute epoch-ms deadline for the WHOLE inline phase (local reads + HTTP). */
	readonly deadlineAt: number;
	/** Test seam — defaults to a real client whose timeout is the remaining budget. */
	readonly client?: JolliMemoryPushClient;
}

/** Display status of one commit in the inline pre-push sync result list. */
export type InlineCommitStatus = "pushed" | "generating" | "failed" | "deferred" | "merged";

/** Per-commit outcome, in push order — feeds the hook's `git push` result list. */
export interface InlineCommitOutcome {
	readonly hash: string;
	readonly status: InlineCommitStatus;
	/** Absolute article URL — set only for "pushed". */
	readonly url?: string;
	/** Short human-readable reason — set for every non-"pushed" status. */
	readonly reason?: string;
}

export interface ProcessPrePushInlineResult {
	readonly attempted: number;
	readonly pushed: number;
	readonly failed: number;
	readonly skippedNoMemory: number;
	readonly skippedRetryExhausted: number;
	readonly deletedChildren: number;
	/** Claimed candidates released untouched — budget/limit deferral, deadline abort, or no batch support. */
	readonly notAttempted: number;
	/** Per-commit outcomes of THIS push's commits, in push order. */
	readonly commits: ReadonlyArray<InlineCommitOutcome>;
	/** Set when the run short-circuited or the batch request failed as a whole. */
	readonly note?: string;
}

const EMPTY_INLINE_RESULT: ProcessPrePushInlineResult = {
	attempted: 0,
	pushed: 0,
	failed: 0,
	skippedNoMemory: 0,
	skippedRetryExhausted: 0,
	deletedChildren: 0,
	notAttempted: 0,
	commits: [],
};

/** Orders the collected outcomes by the push's own commit order. */
function commitsInPushOrder(
	priorityHashes: ReadonlyArray<string>,
	outcomes: ReadonlyMap<string, InlineCommitOutcome>,
): InlineCommitOutcome[] {
	const commits: InlineCommitOutcome[] = [];
	for (const hash of priorityHashes) {
		const outcome = outcomes.get(hash);
		if (outcome) commits.push(outcome);
	}
	return commits;
}

/** Short, user-facing reason for a failed push — printed verbatim in the hook's result list. */
function friendlyPushFailure(message: string): string {
	if (message === "not-authenticated") return "not signed in to Jolli";
	if (message === "permission-denied") return "no permission to write to the bound Jolli Space";
	if (message === "binding-required") return "repo is not bound to a Jolli Space";
	if (message === "client-outdated") return "Jolli client is outdated — please update";
	const compact = message.trim().replace(/\s+/g, " ");
	return compact.length > 60 ? `${compact.substring(0, 59)}…` : compact;
}

/** True for a fetch aborted by the client's own deadline timer — not a server failure. */
function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

/**
 * Releases claims without recording an attempt: an empty patch clears
 * `claimedAt` only, so any later drain (post-queue, activation, next push)
 * can pick the entry up immediately instead of waiting out the claim TTL.
 */
async function releaseClaims(cwd: string, hashes: ReadonlyArray<string>): Promise<void> {
	if (hashes.length === 0) return;
	const updates = new Map<string, BatchUpdate>();
	for (const hash of hashes) updates.set(hash, { kind: "patch", patch: {} });
	await updateBatch(cwd, updates);
}

/**
 * Synchronous pre-push drain, called INSIDE the git pre-push hook while git is
 * waiting for the hook to exit. Key differences from {@link processPushPending}:
 *
 * - **No push confirmation.** The hook runs before git transfers objects, so
 *   waiting for the remote ref would deadlock (git waits for the hook; the
 *   hook would wait for the push). Publishing is optimistic by design — a
 *   rejected push can briefly leave Space articles for commits that never
 *   reached the remote; the user's retry converges them via docId reuse.
 * - **At most one HTTP request.** Batch-eligible memories that fit the server's
 *   total-content limit go out in one `pushBatch` call. Oversized or overflow
 *   items stay pending for the compensation path.
 * - **Hard wall-clock budget.** Every phase checks `deadlineAt`; when the
 *   budget runs out, unprocessed candidates release their claims and stay
 *   pending. The HTTP call's own timeout is the remaining budget, so a hung
 *   connection cannot keep the hook process (and therefore `git push`) alive.
 * - **This push only.** Only the commits of the current push are considered;
 *   leftover entries from earlier pushes stay for the compensation channels
 *   (QueueWorker post-drain, activation retry) so the blocking window stays
 *   proportional to the push at hand. Every considered commit gets a per-hash
 *   entry in `commits` for the hook's result list.
 */
export async function processPrePushInline(
	cwd: string,
	options: ProcessPrePushInlineOptions,
): Promise<ProcessPrePushInlineResult> {
	const remainingMs = (): number => options.deadlineAt - Date.now();

	const pending = await loadPushPending(cwd);
	const allHashes = Object.keys(pending.entries);
	log.info(
		"processPrePushInline: %d commit(s) in this push, %d pending entr(ies) on disk",
		options.priorityHashes.length,
		allHashes.length,
	);
	if (allHashes.length === 0) return { ...EMPTY_INLINE_RESULT, note: "no pending entries" };

	// Same gates as processPushPending — the hook checks these before calling,
	// but the gates stay here so any future caller inherits them.
	const config = await loadConfig();
	if (config.syncOnPush === false) {
		log.info("processPrePushInline: syncOnPush disabled — skipping %d entries", allHashes.length);
		return { ...EMPTY_INLINE_RESULT, note: "syncOnPush disabled" };
	}
	if (!config.jolliApiKey) {
		log.info("processPrePushInline: not signed in — keeping %d entries for later", allHashes.length);
		return { ...EMPTY_INLINE_RESULT, note: "not signed in" };
	}

	// Scope: ONLY this push's commits, in push order, capped to the server's
	// batch limit. Leftover entries from earlier pushes are deliberately left
	// for the compensation channels.
	const outcomes = new Map<string, InlineCommitOutcome>();
	let skippedRetryExhausted = 0;
	const candidates: string[] = [];
	for (const hash of options.priorityHashes) {
		const entry = pending.entries[hash];
		if (!entry) continue; // not recorded (pruned/raced away) — nothing to report
		if (entry.retryCount >= MAX_RETRY_COUNT) {
			skippedRetryExhausted++;
			outcomes.set(hash, { hash, status: "failed", reason: "failed repeatedly — giving up" });
			continue;
		}
		if (candidates.length < BATCH_MAX_ITEMS) {
			candidates.push(hash);
		} else {
			outcomes.set(hash, { hash, status: "deferred", reason: "over the batch limit — will sync later" });
		}
	}
	if (candidates.length === 0) {
		log.info("processPrePushInline: no eligible candidates (%d retry-exhausted)", skippedRetryExhausted);
		return {
			...EMPTY_INLINE_RESULT,
			skippedRetryExhausted,
			commits: commitsInPushOrder(options.priorityHashes, outcomes),
			note: "no eligible entries",
		};
	}

	// Atomic claim — identical race protection to processPushPending.
	const { claimed, entries: claimedEntries } = await claimForPush(cwd, candidates);
	const claimedHashes: string[] = [];
	for (const hash of candidates) {
		if (claimed.has(hash)) {
			claimedHashes.push(hash);
		} else {
			outcomes.set(hash, { hash, status: "deferred", reason: "another sync is already handling this commit" });
		}
	}
	log.info("processPrePushInline: claimed %d/%d candidate(s)", claimedHashes.length, candidates.length);
	if (claimedHashes.length === 0) {
		return {
			...EMPTY_INLINE_RESULT,
			skippedRetryExhausted,
			commits: commitsInPushOrder(options.priorityHashes, outcomes),
			note: "all entries claimed by another process",
		};
	}

	const deferAll = (hashes: ReadonlyArray<string>, reason: string): void => {
		for (const hash of hashes) outcomes.set(hash, { hash, status: "deferred", reason });
	};

	if (remainingMs() <= 0) {
		log.warn("processPrePushInline: budget exhausted before triage — deferring %d commit(s)", claimedHashes.length);
		await releaseClaims(cwd, claimedHashes);
		deferAll(claimedHashes, "timed out — will sync later");
		return {
			...EMPTY_INLINE_RESULT,
			skippedRetryExhausted,
			notAttempted: claimedHashes.length,
			commits: commitsInPushOrder(options.priorityHashes, outcomes),
			note: "budget exhausted",
		};
	}

	const storage = await ensureStorage(cwd);

	// Triage — same rules as processPushPending: merged children drop out, and
	// only commits whose own summary exists go into the batch.
	const indexEntries = await getIndexEntryMap(cwd, storage);
	const withMemory: string[] = [];
	const candidateSummaries = new Map<string, CommitSummary>();
	let skippedNoMemory = 0;
	let deletedChildren = 0;
	const preFlightUpdates = new Map<string, BatchUpdate>();
	for (const hash of claimedHashes) {
		const indexEntry = indexEntries.get(hash);
		if (indexEntry && indexEntry.parentCommitHash != null) {
			preFlightUpdates.set(hash, { kind: "delete" });
			deletedChildren++;
			outcomes.set(hash, { hash, status: "merged", reason: "merged into another commit's memory" });
			log.info(
				"Skipping child entry %s (parent=%s) — already merged",
				hash.substring(0, 8),
				indexEntry.parentCommitHash.substring(0, 8),
			);
			continue;
		}
		const summary = await getSummary(hash, cwd, storage);
		if (summary && summary.commitHash === hash) {
			withMemory.push(hash);
			candidateSummaries.set(hash, withRecoveredDocId(summary, claimedEntries[hash]));
		} else {
			// The empty patch releases the claim so QueueWorker's post-drain
			// trigger can push the commit the moment its summary lands.
			preFlightUpdates.set(hash, { kind: "patch", patch: {} });
			skippedNoMemory++;
			outcomes.set(hash, { hash, status: "generating", reason: "memory still generating — will sync later" });
		}
	}
	if (preFlightUpdates.size > 0) {
		await updateBatch(cwd, preFlightUpdates);
	}
	log.info(
		"processPrePushInline: triage — withMemory=%d generating=%d mergedChildren=%d",
		withMemory.length,
		skippedNoMemory,
		deletedChildren,
	);
	const baseResult: ProcessPrePushInlineResult = {
		...EMPTY_INLINE_RESULT,
		skippedNoMemory,
		skippedRetryExhausted,
		deletedChildren,
	};
	if (withMemory.length === 0) {
		const note =
			deletedChildren > 0 && skippedNoMemory === 0
				? "all candidates were merged children"
				: "no candidates with memory";
		return { ...baseResult, commits: commitsInPushOrder(options.priorityHashes, outcomes), note };
	}

	if (remainingMs() <= INLINE_MIN_HTTP_BUDGET_MS) {
		log.warn(
			"processPrePushInline: budget exhausted before the batch request — deferring %d commit(s)",
			withMemory.length,
		);
		await releaseClaims(cwd, withMemory);
		deferAll(withMemory, "timed out — will sync later");
		return {
			...baseResult,
			notAttempted: withMemory.length,
			commits: commitsInPushOrder(options.priorityHashes, outcomes),
			note: "budget exhausted",
		};
	}

	// Payload preparation needs auth/env helpers but performs no network request.
	// A fresh deadline-bound client is created immediately before pushBatch below,
	// after git reads and attachment loading have consumed their share of the budget.
	const preparationClient = options.client ?? new JolliMemoryPushClient();
	const repoUrl = await getCanonicalRepoUrl(cwd);
	const baseUrl = await preparationClient.resolveBaseUrl();
	const displayBase = baseUrl.replace(/\/+$/, "");
	const preparationCtx: PushContext = { cwd, baseUrl, repoUrl, client: preparationClient, storage };

	const summaries: CommitSummary[] = [];
	for (const hash of withMemory) {
		const summary = candidateSummaries.get(hash);
		if (summary) summaries.push(summary);
	}
	const ownership = await buildAttachmentOwnership(cwd, storage, claimedEntries, withMemory, candidateSummaries);
	const built = await buildBatchItems(summaries, ownership, preparationCtx);

	if (remainingMs() <= INLINE_MIN_HTTP_BUDGET_MS) {
		log.warn(
			"processPrePushInline: budget exhausted after payload build — deferring %d commit(s)",
			withMemory.length,
		);
		await releaseClaims(cwd, withMemory);
		deferAll(withMemory, "timed out — will sync later");
		return {
			...baseResult,
			notAttempted: withMemory.length,
			commits: commitsInPushOrder(options.priorityHashes, outcomes),
			note: "budget exhausted",
		};
	}

	// Inline mode is intentionally one request. Fill it greedily within the
	// server's total-content cap; invalid/overflow items release their claims and
	// stay pending for the confirmed compensation path, which can split batches or
	// fall back to individual pushes without blocking git.
	const batchBuilt: BuiltBatchItem[] = [];
	const deferredByBatchLimit: string[] = [];
	let batchContentChars = 0;
	for (const item of built) {
		const hash = item.item.commitHash;
		if (item.batchIneligibleReason) {
			deferredByBatchLimit.push(hash);
			outcomes.set(hash, {
				hash,
				status: "deferred",
				reason: `${item.batchIneligibleReason} — will sync separately`,
			});
			continue;
		}
		if (batchContentChars + item.batchContentChars > BATCH_MAX_TOTAL_CONTENT_CHARS) {
			deferredByBatchLimit.push(hash);
			outcomes.set(hash, {
				hash,
				status: "deferred",
				reason: "batch content limit reached — will sync later",
			});
			continue;
		}
		batchBuilt.push(item);
		batchContentChars += item.batchContentChars;
	}
	if (deferredByBatchLimit.length > 0) {
		await releaseClaims(cwd, deferredByBatchLimit);
		log.info(
			"processPrePushInline: deferred %d commit(s) that exceed inline batch limits",
			deferredByBatchLimit.length,
		);
	}
	if (batchBuilt.length === 0) {
		return {
			...baseResult,
			notAttempted: deferredByBatchLimit.length,
			commits: commitsInPushOrder(options.priorityHashes, outcomes),
			note: "batch limits require compensation",
		};
	}

	const batchHashes = batchBuilt.map((item) => item.item.commitHash);
	if (remainingMs() <= INLINE_MIN_HTTP_BUDGET_MS) {
		log.warn(
			"processPrePushInline: budget exhausted before the batch request — deferring %d commit(s)",
			batchHashes.length,
		);
		await releaseClaims(cwd, batchHashes);
		deferAll(batchHashes, "timed out — will sync later");
		return {
			...baseResult,
			notAttempted: deferredByBatchLimit.length + batchHashes.length,
			commits: commitsInPushOrder(options.priorityHashes, outcomes),
			note: "budget exhausted",
		};
	}

	// Capture the latest remaining budget immediately before the network call.
	const requestClient = options.client ?? new JolliMemoryPushClient({ timeoutMs: remainingMs() });
	const requestCtx: PushContext = { ...preparationCtx, client: requestClient };
	log.info("processPrePushInline: pushing %d commit(s) in one batch request", batchBuilt.length);
	let batchResult: BatchPushResult;
	try {
		batchResult = await requestClient.pushBatch({ repoUrl, items: batchBuilt.map((item) => item.item) });
	} catch (err) {
		if (err instanceof BatchUnsupportedError) {
			// Server predates the endpoint — leave everything pending without
			// burning retries; a later server deploy (or the pushSummary-based
			// compensation paths) picks the entries up.
			log.warn("processPrePushInline: %s", err.message);
			await releaseClaims(cwd, batchHashes);
			deferAll(batchHashes, "server does not support batch push yet");
			return {
				...baseResult,
				notAttempted: deferredByBatchLimit.length + batchHashes.length,
				commits: commitsInPushOrder(options.priorityHashes, outcomes),
				note: "server lacks batch support",
			};
		}
		if (isAbortError(err)) {
			// Our own deadline abort — not a server failure, so no retry burn.
			log.warn("processPrePushInline: batch request aborted at the deadline");
			await releaseClaims(cwd, batchHashes);
			deferAll(batchHashes, "timed out — will sync later");
			return {
				...baseResult,
				notAttempted: deferredByBatchLimit.length + batchHashes.length,
				commits: commitsInPushOrder(options.priorityHashes, outcomes),
				note: "deadline exceeded",
			};
		}
		const { increment, message } = classifyError(err);
		const failureUpdates = new Map<string, BatchUpdate>();
		const failedAtIso = new Date().toISOString();
		const reason = friendlyPushFailure(message);
		for (const hash of batchHashes) {
			failureUpdates.set(hash, {
				kind: "patch",
				patch: {
					lastAttemptAt: failedAtIso,
					lastError: message,
					...(increment ? { retryCount: claimedEntries[hash].retryCount + 1 } : {}),
				},
			});
			outcomes.set(hash, { hash, status: "failed", reason });
		}
		await updateBatch(cwd, failureUpdates);
		log.warn(
			"processPrePushInline: batch request failed for %d commit(s): %s (retry %s)",
			batchHashes.length,
			message,
			increment ? "counted" : "held",
		);
		return {
			...baseResult,
			attempted: batchHashes.length,
			failed: batchHashes.length,
			notAttempted: deferredByBatchLimit.length,
			commits: commitsInPushOrder(options.priorityHashes, outcomes),
			note: message,
		};
	}

	// Per-item accounting: ok → entry gone; failed → error + retry counted.
	const updates = new Map<string, BatchUpdate>();
	const nowIso = new Date().toISOString();
	const resultByHash = new Map(batchResult.results.map((r) => [r.commitHash, r]));
	let pushed = 0;
	let failed = 0;
	for (const hash of batchHashes) {
		const result = resultByHash.get(hash);
		if (result?.ok) {
			updates.set(hash, { kind: "delete" });
			pushed++;
			const url = result.summary
				? resolveArticleUrl(displayBase, result.summary.url, result.summary.docId)
				: undefined;
			outcomes.set(hash, { hash, status: "pushed", ...(url !== undefined && { url }) });
			continue;
		}
		failed++;
		const message = result?.error ?? result?.errorCode ?? "missing batch result";
		updates.set(hash, {
			kind: "patch",
			patch: {
				lastAttemptAt: nowIso,
				lastError: message,
				retryCount: claimedEntries[hash].retryCount + 1,
			},
		});
		outcomes.set(hash, { hash, status: "failed", reason: friendlyPushFailure(message) });
		log.warn("Batch push failed for %s: %s", hash.substring(0, 8), message);
	}

	// Local write-back (docId/url → stored summary) so the next push updates
	// instead of creating. Keep successful entries pending when confirmed orphan
	// cleanup still remains; the inline hook cannot safely delete old articles
	// before git confirms that the push itself succeeded.
	try {
		const writeBack = await applyBatchResult(batchBuilt, batchResult.results, requestCtx);
		preserveCleanupPending(updates, writeBack.cleanupPendingHashes);
		preserveWriteBackFailures(updates, writeBack.writeBackFailures, nowIso);
		log.debug(
			"processPrePushInline: write-back — writtenBack=%d childSkipped=%d cleanupPending=%d writeBackFailed=%d",
			writeBack.writtenBack,
			writeBack.childSkipped,
			writeBack.cleanupPendingHashes?.length ?? 0,
			writeBack.writeBackFailures?.length ?? 0,
		);
	} catch (err) {
		log.warn("processPrePushInline: write-back failed: %s", errMsg(err));
	}
	await updateBatch(cwd, updates);

	log.info("processPrePushInline: pushed=%d failed=%d", pushed, failed);
	return {
		...baseResult,
		attempted: batchHashes.length,
		pushed,
		failed,
		notAttempted: deferredByBatchLimit.length,
		commits: commitsInPushOrder(options.priorityHashes, outcomes),
	};
}

/**
 * Fire-and-forget trigger for the QueueWorker post-drain path. Runs on the next
 * tick so the caller (the worker's drain loop) never awaits a network round-trip
 * — a slow or offline push must not extend the worker's lock hold or delay the
 * ingest phase. Failures are swallowed to debug: the entries survive in
 * push-pending.json and the next push / activation retries them.
 */
export function triggerPushForNewSummaries(cwd: string, hashes: ReadonlyArray<string>): void {
	if (hashes.length === 0) return;
	const filter = new Set(hashes);
	log.info("Post-queue push trigger: scheduling drain for %d newly generated summar(ies)", filter.size);
	setImmediate(() => {
		processPushPending(cwd, { source: "post-queue", hashFilter: filter }).catch((err) => {
			log.debug("post-queue push trigger failed (will retry later): %s", errMsg(err));
		});
	});
}

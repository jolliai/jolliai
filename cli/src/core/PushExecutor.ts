/**
 * PushExecutor — the shared "drain push-pending.json to Jolli Space" core.
 *
 * One function, `processPushPending`, serves all three callers; they differ only
 * in the options they pass:
 *   - post-queue  — QueueWorker's post-drain trigger (hashFilter set to the
 *     summaries it just generated). Confirmation gate and orphan cleanup on.
 *   - activation  — plugin / CLI activation and sign-in. No filter: drains the
 *     whole backlog. Confirmation gate and orphan cleanup on.
 *   - pre-push    — the detached worker the pre-push hook spawns. Scoped to one
 *     push's commits, and the only caller that sets `skipPushConfirmation` +
 *     `skipOrphanCleanup`: it runs BEFORE git transfers objects, so no ref has
 *     moved yet (`ls-remote` would refuse everything) and deleting orphaned
 *     articles could strip memories from history that is still on the remote.
 *
 * Uploads go through `pushSummary` at commit granularity, `PUSH_CONCURRENCY` in
 * flight. The batch endpoint this file used to prefer was removed: its 8 MB
 * payload cap sat above a typical gateway's body limit, and the resulting 413
 * was indistinguishable from a transient failure — it burned every retry and
 * then aged out silently. Cross-commit context dedup still runs through
 * `assignOwnedContext`, so concurrent commits never touch the same remote
 * document. `pushBranchToJolli` is intentionally NOT used: it pushes a whole
 * branch as one unit with no per-commit retry state.
 *
 * Cross-commit dedup requires the full branch context. The current branch uses
 * `base..HEAD`; off-current branches are reconstructed from root summaries in
 * the summary index. Every pending commit therefore gets the plans/notes it
 * owns even when the user checked out another branch before the drain runs.
 *
 * Binding-cache maintenance rides along: a successful push persists the
 * server's `jmSpace` echo via SpaceBindingCache (a push proves the binding and
 * push rights — and the server auto-binds single-Space tenants during the push
 * itself), while a 412/401/403 rejection clears the cache. Older servers echo
 * nothing and the cache is left as-is. The push chain never adds extra requests
 * for this.
 */

import { createLogger, errMsg } from "../Logger.js";
import type { CommitSummary } from "../Types.js";
import { mapWithConcurrency } from "./Concurrency.js";
import { execGit, getCurrentBranch, getDefaultBranch } from "./GitOps.js";
import { getCanonicalRepoUrl } from "./GitRemoteUtils.js";
import { parseBaseUrl } from "./JolliApiUtils.js";
import {
	BindingRequiredError,
	ClientOutdatedError,
	JolliMemoryPushClient,
	NotAuthenticatedError,
	PermissionDeniedError,
} from "./JolliMemoryPushClient.js";
import { type PushContext, pushSummary } from "./JolliMemoryPushOrchestrator.js";
import { loadBranchSummaries } from "./PrDescription.js";
import { isOutboundPushAllowed, PushDisabledError } from "./PushControl.js";
import {
	type BatchUpdate,
	CLAIM_RENEW_INTERVAL_MS,
	claimForPush,
	loadPushPending,
	MAX_RETRY_COUNT,
	PUSH_CONCURRENCY,
	type PushPendingEntry,
	type PushTarget,
	renewClaims,
	updateBatch,
} from "./PushPendingStore.js";
import { assignOwnedContext, type OwnedContext, selectionForCommit } from "./push/ContextPush.js";
import { loadConfig } from "./SessionTracker.js";
import { clearSpaceBindingCache, saveSpaceBindingCache } from "./SpaceBindingCache.js";
import { createStorage } from "./StorageFactory.js";
import type { StorageProvider } from "./StorageProvider.js";
import { getActiveStorage, getIndexEntryMap, getSummary, setActiveStorage } from "./SummaryStore.js";

const log = createLogger("PushExecutor");

/**
 * Where a `processPushPending` call originated — used only for logging, but that
 * logging matters: all three paths share one function and the pre-push one runs
 * in a detached process with no stdout, so `debug.log` is the only way to tell
 * which drain produced a line.
 */
export type PushSource = "pre-push" | "post-queue" | "activation";

export interface ProcessPushPendingOptions {
	readonly source: PushSource;
	/** When set, only these hashes are considered (QueueWorker post-drain path). */
	readonly hashFilter?: ReadonlySet<string>;
	/**
	 * Overrides the push client. A test seam, and also how the pre-push worker
	 * raises its HTTP timeout above the client default — an aborted request
	 * discards a docId the server already minted, which is the failure this whole
	 * per-commit path exists to avoid.
	 */
	readonly client?: JolliMemoryPushClient;
	/**
	 * Skips the remote-ref confirmation gate.
	 *
	 * Only the pre-push worker sets this. Git calls the hook BEFORE transferring
	 * objects, so while the hook is still alive the remote ref points at the old
	 * sha and `ls-remote` would refuse every entry. The compensation drains keep
	 * the gate.
	 */
	readonly skipPushConfirmation?: boolean;
	/**
	 * Suppresses orphan-article deletion; entries with pending cleanup are kept
	 * (patched, not deleted) for a later confirmed drain.
	 *
	 * Set together with `skipPushConfirmation` and for the same reason: deleting
	 * remote articles before git confirms the push can leave the remote history
	 * intact while its memories are gone, with nothing left to restore them.
	 */
	readonly skipOrphanCleanup?: boolean;
	/**
	 * Epoch-ms after which no NEW commit push is started. Commits already in
	 * flight run to completion; the rest are reported as deferred and left
	 * pending for the compensation channels.
	 *
	 * Deliberately a start-gate rather than a cancellation: aborting a request
	 * mid-flight discards a docId the server may already have minted, and the
	 * retry would then CREATE a duplicate article — the exact failure the
	 * per-commit path exists to avoid. Bounding *starts* caps the run without
	 * ever reintroducing it.
	 *
	 * Omit for an unbounded drain (the compensation channels, which are already
	 * bounded by how much backlog exists).
	 */
	readonly stopStartingAt?: number;
	/**
	 * Invoked as each commit reaches a terminal state, so a detached worker can
	 * publish partial results while the rest is still in flight. Called from
	 * concurrent tasks — keep the implementation synchronous and cheap.
	 */
	readonly onCommitSettled?: (outcome: CommitPushOutcome) => void;
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
	/**
	 * Per-commit outcomes, populated whenever `onCommitSettled` is supplied — on
	 * EVERY return path, including the early ones.
	 */
	readonly commits?: ReadonlyArray<CommitPushOutcome>;
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
	// The repo's own outbound opt-out (spec 306), tripped mid-drain by the live
	// re-check inside the orchestrator. Never burn a retry on it: retrying cannot
	// succeed until the user changes the setting, and the entry must survive intact
	// so the re-enable drain picks it up.
	if (err instanceof PushDisabledError) return { increment: false, message: "push-disabled" };
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
): Promise<OwnedContext> {
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

	// Merge each branch's ownership into one kind-agnostic map. Generic over the
	// registered context kinds, so a new kind needs no change here.
	const merged = new Map<string, { owned: Map<string, ReadonlyArray<unknown>>; seeds: Map<string, number> }>();
	for (const context of contexts.values()) {
		const summaries = [...context.values()].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
		for (const [docType, forKind] of assignOwnedContext(summaries)) {
			const target = merged.get(docType) ?? { owned: new Map(), seeds: new Map() };
			for (const [hash, items] of forKind.owned) target.owned.set(hash, items);
			for (const [key, docId] of forKind.seeds) target.seeds.set(key, docId);
			merged.set(docType, target);
		}
	}
	return merged;
}

/**
 * Grafts the docId/url a previous push minted — but failed to persist locally
 * (see `PushPendingEntry.pushedDocId`) — onto a summary that lacks one, so the
 * retry UPDATEs the existing article instead of CREATEing a duplicate. The
 * tenant gate stays where it always was: `pushSummary` only reuses the id when
 * `canReuseDocId` accepts the grafted url.
 */
function withRecoveredDocId(summary: CommitSummary, entry: PushPendingEntry | undefined): CommitSummary {
	if (summary.jolliDocId !== undefined) return summary;
	if (entry?.pushedDocId === undefined || entry.pushedUrl === undefined) return summary;
	return { ...summary, jolliDocId: entry.pushedDocId, jolliDocUrl: entry.pushedUrl };
}

/**
 * Persists the server's Space echo as the local binding cache — an accepted
 * push proves both the binding and push rights (`canPush: true`), so
 * `jolli status` / bare `jolli` can render the bound row with zero network
 * I/O. No-op when the server echoed nothing (older server, legacy
 * default-space push): the cache is left as-is. Best-effort: a cache hiccup
 * must not fail a completed sync run.
 */
async function persistConfirmedSpace(
	ctx: PushContext,
	confirmedSpace: { readonly id: number; readonly name: string } | undefined,
): Promise<void> {
	if (!confirmedSpace) return;
	try {
		await saveSpaceBindingCache(ctx.cwd, {
			repoUrl: ctx.repoUrl,
			origin: parseBaseUrl(ctx.baseUrl).origin,
			jmSpaceId: confirmedSpace.id,
			spaceName: confirmedSpace.name,
			canPush: true,
		});
	} catch (err) {
		log.debug("binding cache update after push failed: %s", errMsg(err));
	}
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

	// Mirror every settled outcome into the result as well, so callers can choose
	// between a live stream (the pre-push worker) and a plain list.
	const settled: CommitPushOutcome[] = [];
	const onCommitSettled = options.onCommitSettled
		? (outcome: CommitPushOutcome): void => {
				settled.push(outcome);
				options.onCommitSettled?.(outcome);
			}
		: undefined;
	// Every `return` goes through this so an early exit still reports whatever was
	// settled. Without it the contract on `commits` would only hold on the happy path.
	const withCommits = (result: ProcessPushPendingResult): ProcessPushPendingResult =>
		onCommitSettled ? { ...result, commits: [...settled] } : result;

	// Unlocked pre-flight read: cheap scan for eligible candidates. The actual
	// commitment to process specific hashes happens via `claimForPush` below,
	// which atomically stamps `claimedAt` under the file lock so concurrent
	// processes never double-push the same entry.
	const pending = await loadPushPending(cwd);
	const allHashes = Object.keys(pending.entries);
	if (allHashes.length === 0) {
		log.debug("processPushPending(%s): no pending entries", options.source);
		return withCommits({ ...empty, note: "no pending entries" });
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
		return withCommits({ ...empty, note: "syncOnPush disabled" });
	}

	// Per-repo opt-out gate (Story 2): the user disabled OUTBOUND push for this
	// repo. Keep the entries (re-enabling drains them) but upload nothing. Applies
	// to every caller (activation, post-queue, pre-push) exactly like syncOnPush.
	if (!(await isOutboundPushAllowed(cwd))) {
		log.info(
			"processPushPending(%s): push disabled for this repo — skipping %d entries",
			options.source,
			allHashes.length,
		);
		return withCommits({ ...empty, note: "push disabled for this repo" });
	}

	// Auth gate: without a jolliApiKey there is nothing to push to. Keep the
	// entries (the user may sign in later) and return without marking failures.
	if (!config.jolliApiKey) {
		log.info(
			"processPushPending(%s): not signed in — keeping %d entries for later",
			options.source,
			allHashes.length,
		);
		return withCommits({ ...empty, note: "not signed in" });
	}

	// Eligible = under the retry ceiling, and (when a filter is set) in the filter.
	let skippedRetryExhausted = 0;
	const eligible: string[] = [];
	for (const hash of allHashes) {
		if (options.hashFilter && !options.hashFilter.has(hash)) continue;
		const entry = pending.entries[hash];
		if (entry.retryCount >= MAX_RETRY_COUNT) {
			skippedRetryExhausted++;
			onCommitSettled?.({ hash, status: "failed", reason: "failed repeatedly — giving up" });
			continue;
		}
		eligible.push(hash);
	}
	if (eligible.length === 0) return withCommits({ ...empty, skippedRetryExhausted, note: "no eligible entries" });

	// Do not publish until the remote ref proves that the push succeeded.
	// Failed/rejected pushes remain pending for a retry.
	//
	// The pre-push worker is the one caller that must skip this: it runs while git
	// is still waiting for the hook to exit, so no ref has moved yet and every
	// candidate would be refused.
	const confirmed = options.skipPushConfirmation
		? eligible
		: await waitForConfirmedPushes(cwd, eligible, pending.entries);
	if (confirmed.length === 0) {
		log.info(
			"processPushPending(%s): no candidate confirmed on the remote yet — keeping %d entr(ies)",
			options.source,
			eligible.length,
		);
		return withCommits({ ...empty, skippedRetryExhausted, note: "push not confirmed" });
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
	const { claimed, entries: claimedEntries, claimedAt: claimToken } = await claimForPush(cwd, confirmed);
	if (claimed.size === 0) {
		log.info("processPushPending(%s): all candidates already claimed by another process", options.source);
		return withCommits({ ...empty, skippedRetryExhausted, note: "all entries claimed by another process" });
	}
	const claimedHashes = confirmed.filter((h) => claimed.has(h));
	// A hash we did not win is NOT silently dropped: the pre-push hook lists every
	// commit of the push, and an unreported one would be rendered as "still
	// running" long after this drain has exited.
	for (const hash of confirmed) {
		if (!claimed.has(hash)) {
			onCommitSettled?.({ hash, status: "deferred", reason: "another sync is already handling this commit" });
		}
	}
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
			onCommitSettled?.({ hash, status: "merged", reason: "merged into another commit's memory" });
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
			onCommitSettled?.({ hash, status: "generating", reason: "memory still generating — will sync later" });
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
		return withCommits({ ...empty, skippedNoMemory, skippedRetryExhausted, deletedChildren, note });
	}

	const ownership = await buildAttachmentOwnership(cwd, storage, claimedEntries, withMemory, candidateSummaries);

	const client = options.client ?? new JolliMemoryPushClient();
	const repoUrl = await getCanonicalRepoUrl(cwd);
	const baseUrl = await client.resolveBaseUrl();
	const ctx: PushContext = { cwd, baseUrl, repoUrl, client, storage };

	log.info("processPushPending(%s): pushing %d commit(s)", options.source, withMemory.length);

	const counters = { pushed: 0, failed: 0 };

	// Single push path: one request group per commit, concurrency-limited.
	//
	// The batch endpoint was removed on purpose. Its payload cap
	// (8 MB of combined content) sits well above a typical gateway's
	// client_max_body_size, and the resulting 413 was indistinguishable from an
	// ordinary transient failure: it burned all three retries and then aged out
	// silently, so the user just saw memories never arrive. A per-commit request
	// keeps the body proportional to one commit, and lets a settled commit be
	// reported the moment it lands instead of all-or-nothing per batch.
	await pushCandidatesIndividually({
		cwd,
		storage,
		hashes: withMemory,
		ownership,
		claimedEntries,
		claimToken,
		ctx,
		counters,
		skipOrphanCleanup: options.skipOrphanCleanup === true,
		...(options.stopStartingAt !== undefined && { stopStartingAt: options.stopStartingAt }),
		onCommitSettled,
	});

	log.info("processPushPending(%s): pushed=%d failed=%d", options.source, counters.pushed, counters.failed);

	return withCommits({
		attempted: withMemory.length,
		pushed: counters.pushed,
		failed: counters.failed,
		skippedNoMemory,
		skippedRetryExhausted,
		deletedChildren,
	});
}

/**
 * Per-commit outcome of the push loop. `held` means the push was skipped by
 * the per-repo outbound opt-out (spec 306) — no attempt is recorded, so it is
 * deliberately counted as neither a success nor a failure; only the claim is
 * released.
 */
type PushOutcome = "pushed" | "failed" | "held";

/**
 * The push loop: one request group per commit, `PUSH_CONCURRENCY` of them in
 * flight at a time. Re-reads each summary right before the network call
 * (stale-summary race guard), pushes via `pushSummary` (attachments first, then
 * the summary itself), and commits each entry's accounting AS IT SETTLES rather
 * than in one batch at the end.
 *
 * Per-commit persistence is load-bearing, not a style choice. At commit
 * granularity a drain routinely runs for minutes — longer than the claim TTL —
 * so buffering the whole ledger in memory would mean a mid-run crash replays
 * commits that already published, creating duplicate articles. The claim
 * heartbeat covers the other half of that race: it keeps this drain's own claims
 * alive so no other channel can take them over while a push is still in flight.
 *
 * Concurrency is safe at commit granularity because context ownership is decided
 * up front by `assignOwnedContext`: an item of any registered kind shared by
 * several commits is pushed by exactly one of them, so concurrent commits never
 * touch the same remote document. Local write-back is serialised by
 * `storeSummary`'s orphan-write lock.
 */
async function pushCandidatesIndividually(args: {
	readonly cwd: string;
	readonly storage: StorageProvider;
	readonly hashes: ReadonlyArray<string>;
	readonly ownership: OwnedContext;
	readonly claimedEntries: Readonly<Record<string, PushPendingEntry>>;
	/** The `claimedAt` stamp this drain owns — the heartbeat's compare-and-swap token. */
	readonly claimToken: string;
	readonly ctx: PushContext;
	readonly counters: { pushed: number; failed: number };
	/** Defer orphan deletion and keep the entry — see ProcessPushPendingOptions. */
	readonly skipOrphanCleanup: boolean;
	/** Start-gate for new pushes — see ProcessPushPendingOptions.stopStartingAt. */
	readonly stopStartingAt?: number;
	readonly onCommitSettled?: (outcome: CommitPushOutcome) => void;
}): Promise<void> {
	const { cwd, storage, hashes, ownership, claimedEntries, ctx, skipOrphanCleanup, onCommitSettled } = args;
	const { stopStartingAt } = args;
	// The server's Space echo from any successful push this run (concurrent
	// writers all observe the same binding, so last-write-wins is fine).
	let confirmedSpace: { readonly id: number; readonly name: string } | undefined;

	// Commit one entry's accounting immediately. Single-entry writes take the same
	// file lock as a batch, so ordering across concurrent tasks stays safe.
	const commitEntry = async (hash: string, update: BatchUpdate): Promise<void> => {
		try {
			await updateBatch(cwd, new Map([[hash, update]]));
		} catch (err) {
			// The push already happened; a bookkeeping failure must not fail it.
			// The entry stays claimed and a later drain re-reads the stored docId,
			// so the retry UPDATEs rather than duplicates. The one case that loses the
			// id is a `writeBackFailed` patch failing here — that patch IS the backup
			// copy of an id the local summary never received. Two consecutive local
			// write failures, so a duplicate article there is the accepted floor.
			log.warn("Could not persist push accounting for %s: %s", hash.substring(0, 8), errMsg(err));
		}
	};

	const inFlight = new Set(hashes);
	let claimToken = args.claimToken;
	// Heartbeat: keep this drain's claims from going stale mid-flight. unref() so
	// a stuck timer can never keep the worker process alive past its work.
	const heartbeat = setInterval(() => {
		if (inFlight.size === 0) return;
		void renewClaims(cwd, [...inFlight], claimToken)
			.then((renewed) => {
				// undefined means nothing matched our token any more — every entry is
				// either finished or now held by someone else. Keep the old token so a
				// later beat cannot resurrect a claim we no longer own.
				if (renewed) claimToken = renewed;
			})
			.catch((err: unknown) => {
				log.debug("Claim renewal failed (will retry next beat): %s", errMsg(err));
			});
	}, CLAIM_RENEW_INTERVAL_MS);
	heartbeat.unref();

	const pushOne = async (hash: string): Promise<PushOutcome> => {
		// Runtime ceiling. Checked before anything else so a commit that never
		// started leaves no trace: the claim is released, no attempt is recorded,
		// and no retry is burned — indistinguishable from one this drain never
		// reached. Commits already in flight are untouched (see stopStartingAt).
		if (stopStartingAt !== undefined && Date.now() >= stopStartingAt) {
			await commitEntry(hash, { kind: "patch", patch: {} });
			onCommitSettled?.({ hash, status: "deferred", reason: "run time limit reached — will sync later" });
			return "held";
		}
		// Story 2 / spec 306: the drain's entry gate ran once, before this loop.
		// Re-read the opt-out per commit so a user who disables push mid-drain stops
		// the REMAINING sends. "held" is deliberately neither pushed nor failed: no
		// attempt is recorded and no retry is burned. The claim IS released, because
		// the re-enable drain runs immediately on toggle-on and would otherwise skip
		// a claim this young for the full TTL.
		if (!(await isOutboundPushAllowed(cwd))) {
			await commitEntry(hash, { kind: "patch", patch: {} });
			onCommitSettled?.({ hash, status: "deferred", reason: "outbound push disabled for this repo" });
			return "held";
		}
		// Re-read immediately before the network call so a concurrent rewrite or
		// cleanup cannot make us publish a stale summary captured earlier.
		const freshSummary = await getSummary(hash, cwd, storage);
		if (!freshSummary || freshSummary.commitHash !== hash) {
			// Raced away (deleted between the memory check and here), or tree-hash
			// fallback resolved to another commit's summary. Drop it.
			await commitEntry(hash, { kind: "delete" });
			onCommitSettled?.({ hash, status: "failed", reason: "summary changed mid-push" });
			return "failed";
		}
		const summary = withRecoveredDocId(freshSummary, claimedEntries[hash]);
		// Kind-agnostic: whatever kinds are registered, this commit pushes exactly the
		// items it owns for each of them. Never hand-build the legacy
		// `{plans, notes, references}` shape here — naming only those three means
		// "push ZERO of every other kind", which would silently skip skill and every
		// future kind on this path.
		const attachments = selectionForCommit(ownership, hash);
		try {
			const pushed = await pushSummary(summary, ctx, attachments, { skipOrphanCleanup });
			if (pushed.jmSpace) confirmedSpace = pushed.jmSpace;
			if (pushed.writeBackFailed) {
				// The article exists server-side but its id never reached local
				// storage. Record the minted ids so the next drain UPDATEs the same
				// article instead of CREATEing a duplicate, and leave retryCount alone:
				// the push itself succeeded, only the bookkeeping needs another go.
				await commitEntry(hash, {
					kind: "patch",
					patch: {
						lastAttemptAt: new Date().toISOString(),
						lastError: "pushed, but persisting the article id locally failed — will retry the write-back",
						pushedDocId: pushed.docId,
						pushedUrl: pushed.summaryUrl,
					},
				});
			} else {
				// An entry whose orphan cleanup is still outstanding must SURVIVE as a
				// patch: deleting it would strand those articles with nothing left
				// pointing at them.
				await commitEntry(hash, pushed.cleanupPending ? { kind: "patch", patch: {} } : { kind: "delete" });
			}
			onCommitSettled?.({ hash, status: "pushed", ...(pushed.summaryUrl ? { url: pushed.summaryUrl } : {}) });
			return "pushed";
		} catch (err) {
			// The orchestrator's live re-check tripped between attachments (the
			// per-commit check above passed). Record no attempt — no lastError, no
			// retry — so the entry is indistinguishable from one this drain never
			// reached, and report it as held rather than failed.
			if (err instanceof PushDisabledError) {
				await commitEntry(hash, { kind: "patch", patch: {} });
				onCommitSettled?.({ hash, status: "deferred", reason: "outbound push disabled for this repo" });
				return "held";
			}
			const { increment, message } = classifyError(err);
			if (
				err instanceof BindingRequiredError ||
				err instanceof NotAuthenticatedError ||
				err instanceof PermissionDeniedError
			) {
				// The server just contradicted any cached binding (unbound elsewhere,
				// or auth/permission revoked) — drop the cache so `jolli status` / bare
				// `jolli` stop rendering a stale bound row.
				await clearSpaceBindingCache(cwd);
			}
			const entry = claimedEntries[hash];
			// Stamped per failure rather than once per drain: at commit granularity a
			// drain runs for minutes, so a shared timestamp would misdate late
			// failures by the whole run length.
			await commitEntry(hash, {
				kind: "patch",
				patch: {
					lastAttemptAt: new Date().toISOString(),
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
			onCommitSettled?.({ hash, status: "failed", reason: friendlyPushFailure(message) });
			return "failed";
		}
	};

	try {
		const results = await mapWithConcurrency(hashes, PUSH_CONCURRENCY, async (hash): Promise<PushOutcome> => {
			try {
				return await pushOne(hash);
			} finally {
				inFlight.delete(hash);
			}
		});
		for (const result of results) {
			if (result === "pushed") args.counters.pushed++;
			else if (result === "failed") args.counters.failed++;
			// "held" (opt-out) is counted as neither: nothing was sent and nothing
			// failed, and the entry stays pending for the re-enable drain.
		}
	} finally {
		clearInterval(heartbeat);
	}
	await persistConfirmedSpace(ctx, confirmedSpace);
}

/** Display status of one commit in a push result list. */
export type CommitPushStatus = "pushed" | "generating" | "failed" | "deferred" | "merged";

/** Per-commit outcome — feeds the pre-push hook's `git push` result list. */
export interface CommitPushOutcome {
	readonly hash: string;
	readonly status: CommitPushStatus;
	/** Absolute article URL — set only for "pushed". */
	readonly url?: string;
	/** Short human-readable reason — set for every non-"pushed" status. */
	readonly reason?: string;
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

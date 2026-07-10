/**
 * PushExecutor — the shared "drain push-pending.json to Jolli Space" core.
 *
 * Called by all three consumers of the pre-push sync flow:
 *   - PrePushWorker            (detached, source="pre-push")
 *   - QueueWorker post-drain   (in-process, source="post-queue", hashFilter set)
 *   - plugin/CLI activation    (source="activation")
 *
 * Reuses the existing push_memory path verbatim — `pushSummary` for the
 * per-commit upload and `assignOwnedAttachments` for cross-commit plan/note
 * dedup — so nothing about the Jolli Space contract is re-implemented here
 * (JOLLI-1900 requirement 3). `pushBranchToJolli` is intentionally NOT used:
 * it pushes the whole branch as one unit with no per-commit retry state, which
 * is what the pending-file model provides.
 *
 * Cross-commit dedup requires the full branch context. The current branch uses
 * `base..HEAD`; off-current branches are reconstructed from root summaries in
 * the summary index. Every pending commit therefore gets the plans/notes it
 * owns even when the user checked out another branch before the worker ran.
 */

import { createLogger, errMsg } from "../Logger.js";
import type { CommitSummary } from "../Types.js";
import { mapWithConcurrency } from "./Concurrency.js";
import { execGit, getCurrentBranch, getDefaultBranch } from "./GitOps.js";
import { getCanonicalRepoUrl } from "./GitRemoteUtils.js";
import {
	BindingRequiredError,
	ClientOutdatedError,
	JolliMemoryPushClient,
	NotAuthenticatedError,
} from "./JolliMemoryPushClient.js";
import {
	type AttachmentSelection,
	assignOwnedAttachments,
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

const PUSH_CONFIRM_POLL_ATTEMPTS = 60;
const PUSH_CONFIRM_POLL_INTERVAL_MS = 1_000;

/** Where a `processPushPending` call originated — used only for logging. */
export type PushSource = "pre-push" | "post-queue" | "activation";

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
	if (err instanceof BindingRequiredError) return { increment: false, message: "binding-required" };
	if (err instanceof ClientOutdatedError) return { increment: false, message: "client-outdated" };
	return { increment: true, message: errMsg(err) };
}

/**
 * Ensures a StorageProvider is active for this process. PrePushWorker starts
 * fresh (no active storage) and must create one; the QueueWorker post-drain
 * path already has storage set by the drain, so we reuse it.
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
	source: PushSource,
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
	const attempts = source === "pre-push" ? PUSH_CONFIRM_POLL_ATTEMPTS : 1;
	for (let attempt = 0; attempt < attempts; attempt++) {
		await Promise.all(
			[...targets].map(async ([key, target]) => {
				if (
					!confirmedTargets.has(key) &&
					(await isPushTargetConfirmed(cwd, target, pushRemotes.get(target.remote) ?? target.remote))
				)
					confirmedTargets.add(key);
			}),
		);
		const confirmedHashes = hashes.filter((hash) => {
			const entryTargets = entries[hash].pushTargets;
			return !entryTargets?.length || entryTargets.some((target) => confirmedTargets.has(pushTargetKey(target)));
		});
		if (confirmedHashes.length === hashes.length || attempt === attempts - 1) return confirmedHashes;
		await new Promise<void>((resolve) => setTimeout(resolve, PUSH_CONFIRM_POLL_INTERVAL_MS));
	}
	return [];
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
	for (const context of contexts.values()) {
		const summaries = [...context.values()].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
		const owned = assignOwnedAttachments(summaries);
		for (const [hash, plans] of owned.ownedPlans) ownedPlans.set(hash, plans);
		for (const [hash, notes] of owned.ownedNotes) ownedNotes.set(hash, notes);
	}
	return { ownedPlans, ownedNotes };
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
	if (allHashes.length === 0) return { ...empty, note: "no pending entries" };

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

	// The hook runs before Git transfers objects, so the detached worker can start
	// while the push is still in flight. Do not publish until the remote ref proves
	// that the push succeeded. Failed/rejected pushes remain pending for a retry.
	const confirmed = await waitForConfirmedPushes(cwd, eligible, pending.entries, options.source);
	if (confirmed.length === 0) return { ...empty, skippedRetryExhausted, note: "push not confirmed" };

	// Atomic claim: stamp `claimedAt` on every confirmed hash under the file
	// lock. A concurrent `processPushPending` that races us will see a fresh
	// `claimedAt` and skip the entry, preventing duplicate Space articles.
	const { claimed, entries: claimedEntries } = await claimForPush(cwd, confirmed);
	if (claimed.size === 0) return { ...empty, skippedRetryExhausted, note: "all entries claimed by another process" };
	const claimedHashes = confirmed.filter((h) => claimed.has(h));

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
			candidateSummaries.set(hash, summary);
		} else {
			preFlightUpdates.set(hash, { kind: "patch", patch: {} });
			skippedNoMemory++;
		}
	}
	if (preFlightUpdates.size > 0) {
		await updateBatch(cwd, preFlightUpdates);
	}
	if (withMemory.length === 0) {
		const note =
			deletedChildren > 0 && skippedNoMemory === 0
				? "all candidates were merged children"
				: "no candidates with memory";
		return { ...empty, skippedNoMemory, skippedRetryExhausted, deletedChildren, note };
	}

	const { ownedPlans, ownedNotes } = await buildAttachmentOwnership(
		cwd,
		storage,
		claimedEntries,
		withMemory,
		candidateSummaries,
	);

	const client = options.client ?? new JolliMemoryPushClient();
	const repoUrl = await getCanonicalRepoUrl(cwd);
	const baseUrl = await client.resolveBaseUrl();
	const ctx: PushContext = { cwd, baseUrl, repoUrl, client, storage };

	log.info("processPushPending(%s): pushing %d commit(s)", options.source, withMemory.length);

	const updates = new Map<string, BatchUpdate>();
	const nowIso = new Date().toISOString();

	const results = await mapWithConcurrency(
		withMemory,
		PUSH_CONCURRENCY,
		async (hash): Promise<"pushed" | "failed"> => {
			// Re-read immediately before the network call so a concurrent rewrite or
			// cleanup cannot make us publish a stale summary captured above.
			const summary = await getSummary(hash, cwd, storage);
			if (!summary || summary.commitHash !== hash) {
				// Raced away (deleted between the memory check and here), or
				// tree-hash fallback resolved to another commit's summary. Drop it.
				updates.set(hash, { kind: "delete" });
				return "failed";
			}
			const attachments: AttachmentSelection = {
				plans: ownedPlans.get(hash) ?? [],
				notes: ownedNotes.get(hash) ?? [],
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
		},
	);

	await updateBatch(cwd, updates);

	const pushed = results.filter((r) => r === "pushed").length;
	const failed = results.filter((r) => r === "failed").length;
	log.info("processPushPending(%s): pushed=%d failed=%d", options.source, pushed, failed);

	return {
		attempted: withMemory.length,
		pushed,
		failed,
		skippedNoMemory,
		skippedRetryExhausted,
		deletedChildren,
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
	setImmediate(() => {
		processPushPending(cwd, { source: "post-queue", hashFilter: filter }).catch((err) => {
			log.debug("post-queue push trigger failed (will retry later): %s", errMsg(err));
		});
	});
}

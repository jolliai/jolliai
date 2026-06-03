#!/usr/bin/env node
/**
 * QueueWorker — Git Operation Queue Processor
 *
 * This script is spawned as a detached background process by PostCommitHook or PostRewriteHook.
 * It acquires a lock, drains the git operation queue, and processes each entry:
 *
 * - commit / cherry-pick / revert / amend: runs the per-commit summarize LLM pipeline
 * - squash: runs the LLM-driven `generateSquashConsolidation` pipeline (mechanical merge as fallback)
 * - rebase-pick: migrates summary 1:1 (no LLM — pure metadata + ref re-association)
 * - rebase-squash: same LLM consolidation pipeline as squash (mechanical merge as fallback)
 *
 * Transcript attribution uses each queue entry's `createdAt` timestamp as a time cutoff,
 * ensuring each commit gets only the transcript entries from its own time window.
 *
 * Entry point: can be run directly with `--worker --cwd <path>` or spawned by `launchWorker()`.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverCodexSessions, isCodexInstalled } from "../core/CodexSessionDiscoverer.js";
import { conversationKey, readExclusions } from "../core/CommitSelectionStore.js";
import { applyOverlaysToSessions, pruneConsumedOverlayRules } from "../core/ConversationOverlayStore.js";
import { isCopilotChatInstalled } from "../core/CopilotChatDetector.js";
import { discoverCopilotChatSessions } from "../core/CopilotChatSessionDiscoverer.js";
import { readCopilotChatTranscript } from "../core/CopilotChatTranscriptReader.js";
import { isCopilotInstalled } from "../core/CopilotDetector.js";
import { discoverCopilotSessions } from "../core/CopilotSessionDiscoverer.js";
import { readCopilotTranscript } from "../core/CopilotTranscriptReader.js";
import { isCursorInstalled } from "../core/CursorDetector.js";
import { discoverCursorSessions } from "../core/CursorSessionDiscoverer.js";
import { readCursorTranscript } from "../core/CursorTranscriptReader.js";
import { readGeminiTranscript } from "../core/GeminiTranscriptReader.js";
import { getCommitInfo, getCurrentBranch, getDiffContent, getDiffStats } from "../core/GitOps.js";
import { acquireWorkerLock, refreshWorkerLockMtime, releaseWorkerLock } from "../core/Locks.js";
import { formatNotesBlock } from "../core/NotePromptFormatter.js";
import { discoverOpenCodeSessions, isOpenCodeInstalled } from "../core/OpenCodeSessionDiscoverer.js";
import { readOpenCodeTranscript } from "../core/OpenCodeTranscriptReader.js";
import { evaluatePlanProgress } from "../core/PlanProgressEvaluator.js";
import { formatPlansBlock } from "../core/PlanPromptFormatter.js";
import { deleteReferenceMarkdown, readReferenceMarkdown } from "../core/references/ReferenceStore.js";
import { ALL_ADAPTERS } from "../core/references/sources/index.js";
import {
	associateNoteWithCommit,
	associatePlanWithCommit,
	deleteQueueEntry,
	dequeueAllGitOperations,
	detectActiveNotesForBranch,
	detectActivePlansForBranch,
	detectUncommittedReferenceIds,
	filterSessionsByEnabledIntegrations,
	getReferenceEntriesForBranch,
	loadAllSessions,
	loadConfig,
	loadCursorForTranscript,
	loadPlansRegistry,
	saveCursor,
	savePlansRegistry,
} from "../core/SessionTracker.js";
import { cleanupBranchStaleChildMarkdown } from "../core/StaleChildMarkdownCleanup.js";
import { createStorage } from "../core/StorageFactory.js";
import type { StorageProvider } from "../core/StorageProvider.js";
import {
	extractTicketIdFromMessage,
	generateSquashConsolidation,
	generateSummary,
	mechanicalConsolidate,
	type SquashConsolidationSource,
} from "../core/Summarizer.js";
import { isSummaryError, LLM_FAILED } from "../core/SummaryErrorMarker.js";
import {
	type ConsolidatedTopics,
	expandSourcesForConsolidation,
	getSummary,
	getTranscriptHashes,
	mergeManyToOne,
	migrateOneToOne,
	resolveEffectiveTopics,
	setActiveStorage,
	storeNotes,
	storePlans,
	storeReferences,
	storeSummary,
	stripFunctionalMetadata,
} from "../core/SummaryStore.js";
import { resolveTranscriptIdsFiltered } from "../core/SummaryTree.js";
import { generateTranscriptId } from "../core/TranscriptId.js";
import { getParserForSource } from "../core/TranscriptParser.js";
import type { SessionTranscript } from "../core/TranscriptReader.js";
import { buildMultiSessionContext, readTranscript } from "../core/TranscriptReader.js";
import { createLogger, errMsg, setLogDir, setLogLevel } from "../Logger.js";
import { consumePendingWorkers, recordPendingWorker } from "../sync/PendingWorkers.js";
import { deriveMemoryBankRoot } from "../sync/SyncBootstrap.js";
import { acquireVaultWriteLock, DEFAULT_VAULT_WRITE_WAIT_MS } from "../sync/VaultWriteLock.js";
import type {
	CommitInfo,
	CommitSource,
	CommitSummary,
	CommitType,
	DiffStats,
	GitOperation,
	JolliMemoryConfig,
	LogLevel,
	NoteReference,
	PlanProgressArtifact,
	PlanReference,
	PlansRegistry,
	Reference,
	ReferenceCommitRef,
	ReferenceEntry,
	SourceId,
	StoredTranscript,
	TopicSummary,
	TranscriptReadResult,
	TranscriptSource,
} from "../Types.js";
import { CURRENT_SCHEMA_VERSION } from "../Types.js";
import { spawnHidden } from "../util/Subprocess.js";

const log = createLogger("QueueWorker");

/** Delay before retry on API failure (ms) */
const RETRY_DELAY_MS = 2000;

/**
 * How often to bump the worker.lock's mtime while the worker is running.
 * Comfortably below `LOCK_TIMEOUT_MS` (5 min) so even a missed tick keeps
 * the lock alive against the stale-lock reclaimer.
 */
const WORKER_LOCK_REFRESH_INTERVAL_MS = 60_000;

// ─── Shared helpers for plans & notes re-association ─────────────────────────

/**
 * Re-associates plans, notes, and external-source references (Linear / Jira /
 * GitHub / Notion) from old summaries with a new commit hash. Called after
 * squash, rebase-pick, rebase-squash, and amend to update the registry.
 *
 * Single function so all four attachment kinds stay in lock-step. Previously
 * these were separate inline loops, which led to notes being forgotten in
 * some paths (squash, amend) while plans were correctly handled.
 *
 * Reference source resolution per old summary: `oldSummary.references` is the
 * canonical and only multi-source list.
 */
async function reassociateMetadata(
	oldSummaries: ReadonlyArray<CommitSummary>,
	newHash: string,
	cwd: string,
): Promise<void> {
	for (const oldSummary of oldSummaries) {
		if (oldSummary.plans) {
			for (const planRef of oldSummary.plans) {
				await associatePlanWithCommit(planRef.slug, newHash, cwd);
			}
		}
		if (oldSummary.notes) {
			for (const noteRef of oldSummary.notes) {
				await associateNoteWithCommit(noteRef.id, newHash, cwd);
			}
		}
		// References have no plans.json guard row (commit deletes the entry),
		// so there's nothing to re-anchor on squash/rebase — the CommitSummary's
		// ReferenceCommitRef travels with the orphan-branch storeReferences flow.
	}
}

/**
 * Extracts hoisted metadata fields from an old summary for inclusion in a new
 * summary root node. The full hoist set is: jolliDocId, jolliDocUrl,
 * orphanedDocIds, plans, notes, references, e2eTestGuide. Keep this list
 * synced with the spread block below — drift is the bug we're avoiding by
 * enumerating it here.
 *
 * Used when building amend/squash summary containers that wrap the old summary
 * as a child. Returns a partial object suitable for spreading into a
 * CommitSummary.
 */
function hoistMetadataFromOldSummary(oldSummary: CommitSummary | null | undefined): Partial<CommitSummary> {
	if (!oldSummary) return {};
	return {
		...(oldSummary.jolliDocId != null && { jolliDocId: oldSummary.jolliDocId }),
		...(oldSummary.jolliDocUrl && { jolliDocUrl: oldSummary.jolliDocUrl }),
		...(oldSummary.orphanedDocIds && { orphanedDocIds: oldSummary.orphanedDocIds }),
		...(oldSummary.plans && { plans: oldSummary.plans }),
		...(oldSummary.notes && { notes: oldSummary.notes }),
		...(oldSummary.references && { references: oldSummary.references }),
		...(oldSummary.e2eTestGuide && { e2eTestGuide: oldSummary.e2eTestGuide }),
	};
}

/**
 * Spawns the Worker as a detached background process.
 * This is a pure spawn utility — no operation detection logic.
 * Called by postCommitEntry() and PostRewriteHook.
 */
/* v8 ignore start - launchWorker spawns a child process */
export function launchWorker(cwd: string): void {
	log.info("Launching background worker");

	// Explicitly resolve QueueWorker.js by directory + filename, NOT import.meta.url.
	// When this function is imported and inlined by esbuild into another bundle (e.g.,
	// PostRewriteHook.js), import.meta.url would resolve to the caller's bundle path,
	// spawning the wrong script. Using dirname + basename ensures we always spawn
	// QueueWorker.js regardless of which bundle calls this function.
	const dir = dirname(fileURLToPath(import.meta.url));
	const scriptPath = join(dir, "QueueWorker.js");

	const child = spawnHidden(
		process.execPath,
		// --disable-warning silences node:sqlite's ExperimentalWarning during OpenCode
		// scans; it also suppresses any other experimental warnings in this subprocess.
		["--disable-warning=ExperimentalWarning", scriptPath, "--worker", "--cwd", cwd],
		{
			detached: true,
			stdio: "ignore",
			cwd,
		},
	);
	child.unref();

	log.info("Background worker spawned (PID: %d)", child.pid ?? -1);
}
/* v8 ignore stop */

/**
 * Worker: acquires lock, drains the git operation queue, and processes each entry.
 *
 * This function is called by the detached background process spawned by postCommitEntry()
 * or PostRewriteHook. It processes ALL queued entries (not just "its own"), ensuring that
 * operations queued during a previous Worker's LLM call are eventually processed.
 *
 * @param cwd   - Working directory (git repo root)
 * @param force - When true, overwrites existing summaries (used by CLI `summarize` command)
 */
export async function runWorker(cwd: string, force = false): Promise<void> {
	setLogDir(cwd);

	log.info("=== Queue worker started ===");

	// Acquire `vault-write.lock` BEFORE constructing storage. Reason:
	// `createStorage` → `createFolderStorage` → `resolveKBPath` has side
	// effects (creates `<localFolder>/<repoFolder>/.jolli/` and writes a
	// stub `config.json`) — two workers entering that path concurrently
	// would race on KB-path identity and produce phantom `<repo>-N` folders
	// (the same bug `SyncBootstrap` already documents at line 175 for the
	// pre-clone case). The lock keys off `localFolder` (read directly from
	// config — no storage instance yet), so this is safe to do before
	// touching the vault at all.
	//
	// Wait-mode with the standard 60 s budget: when sync is running, the
	// hook-spawned worker waits for sync to finish rather than dropping its
	// queue entry. Matches the chain-spawn-on-release decision in
	// sync-allowlist-staging.md (Option (a) — wait-mode, not registry).
	const vaultLockConfig = await loadConfig();
	const memoryBankRoot = deriveMemoryBankRoot(vaultLockConfig.localFolder);
	const vaultLock = await acquireVaultWriteLock(memoryBankRoot, {
		wait: DEFAULT_VAULT_WRITE_WAIT_MS,
	});
	if (vaultLock === null) {
		// Cross-repo wakeup (P2). Record this cwd in the per-vault pending
		// registry so whoever next releases `vault-write.lock` (sync round
		// complete, or another worker's drain finishing) re-spawns us.
		// Without this, our queue entry would sit on disk until this repo's
		// NEXT post-commit hook — potentially hours, since the previous
		// chain-spawn comments ("chain-spawn from sync release or next
		// post-commit hook will retry") were aspirational: sync only chained
		// for its own cwd, and the worker chain only re-checked the same
		// cwd. The registry closes the cross-repo gap.
		// Use `memoryBankRoot` (already `deriveMemoryBankRoot`-resolved
		// from `vaultLockConfig.localFolder`) so default-config users —
		// the majority — also get the cross-repo wakeup. Passing raw
		// `vaultLockConfig.localFolder` would no-op when it's undefined.
		await recordPendingWorker(memoryBankRoot, cwd);
		log.warn(
			"Could not acquire vault-write.lock within %d ms; another writer is busy. Exiting — recorded pending-worker entry so the next lock release re-spawns us.",
			DEFAULT_VAULT_WRITE_WAIT_MS,
		);
		return;
	}

	// Periodically bump vault-write.lock's mtime so a long-running LLM call
	// (rare, but possible when an upstream is slow) cannot be reaped by the
	// stale-lock reclaimer at LOCK_TIMEOUT_MS. Same refresh cadence as
	// worker.lock's timer further below.
	/* v8 ignore start -- setInterval's lambda only fires on a real timer tick; unit tests finish in milliseconds and never observe the callback. */
	const vaultRefreshTimer = setInterval(() => {
		void vaultLock.refresh();
	}, WORKER_LOCK_REFRESH_INTERVAL_MS);
	/* v8 ignore stop */

	try {
		// Create storage provider based on config (orphan/dual-write/folder).
		// Now safe — we hold `vault-write.lock` so no concurrent writer can race
		// on `resolveKBPath`'s side effects.
		const storage = await createStorage(cwd, cwd);
		setActiveStorage(storage);

		// Acquire worker.lock — the per-source-repo lock that serialises two
		// workers for the SAME source repo (queue entry ordering). It's
		// narrower than vault-write.lock, which serialises across ALL repos in
		// the vault. Both locks are needed: vault-write.lock prevents
		// cross-repo torn writes inside one vault; worker.lock prevents
		// same-repo concurrent queue drains.
		const lockAcquired = await acquireWorkerLock(cwd);
		if (!lockAcquired) {
			log.warn("Could not acquire worker lock, another worker may be running. Exiting.");
			return;
		}

		// Periodically bump the worker.lock mtime — same rationale as
		// vault-write.lock above.
		/* v8 ignore start -- setInterval's lambda only fires on a real timer tick; unit tests finish in milliseconds and never observe the callback. */
		const refreshTimer = setInterval(() => {
			void refreshWorkerLockMtime(cwd);
		}, WORKER_LOCK_REFRESH_INTERVAL_MS);
		/* v8 ignore stop */

		try {
			// Drain the queue: process all entries, then check for new ones (added during processing)
			let processedCount = 0;
			const MAX_ENTRIES_PER_RUN = 20; // Safety limit to prevent infinite loops

			while (processedCount < MAX_ENTRIES_PER_RUN) {
				const entries = await dequeueAllGitOperations(cwd);
				if (entries.length === 0) break;

				for (const { op, filePath } of entries) {
					// Hard cap: if a single dequeue batch returns more than MAX_ENTRIES_PER_RUN,
					// stop inside the inner loop so the outer while condition can re-check and
					// exit cleanly. The subsequent chain-spawn (line below) picks up leftovers.
					if (processedCount >= MAX_ENTRIES_PER_RUN) break;
					try {
						await processQueueEntry(op, cwd, storage, force);
					} catch (error: unknown) {
						// Queue entries are deleted regardless of success or failure (fire-and-forget).
						// Retry is intentionally not implemented: pipeline steps (transcript cursor
						// advancement, summary writes) are not idempotent, so naive retry could cause
						// duplicate summaries or corrupted metadata.
						// TODO: Support re-summarize for specific commits (e.g., after LLM quota
						// replenishment). Requires persisting transcripts to the orphan branch BEFORE
						// the LLM call so re-summarize can read them back without cursor dependency.
						log.error(
							"Failed to process queue entry type=%s hash=%s: %s",
							op.type,
							op.commitHash.substring(0, 8),
							(error as Error).message,
						);
					}
					await deleteQueueEntry(filePath);
					processedCount++;
				}
			}

			if (processedCount > 0) {
				log.info("Processed %d queue entries", processedCount);
			}
			/* v8 ignore start -- catch block only reached if dequeueAllGitOperations throws unexpectedly */
		} catch (error: unknown) {
			log.error("Worker failed: %s", (error as Error).message);
		} finally {
			/* v8 ignore stop */
			clearInterval(refreshTimer);
			await releaseWorkerLock(cwd);
			log.info("=== Queue worker finished ===");
		}

		// Chain spawn: if new entries appeared while we were processing, spawn another Worker
		const remaining = await dequeueAllGitOperations(cwd);
		/* v8 ignore start -- chain spawn only occurs when new entries arrive during worker processing */
		if (remaining.length > 0) {
			log.info("Queue has %d remaining entries — spawning chain worker", remaining.length);
			launchWorker(cwd);
		}
		/* v8 ignore stop */
	} finally {
		// Outer finally — vault-write.lock release. Runs AFTER worker.lock
		// release and AFTER the chain-spawn check, so a chain-spawned successor
		// can re-acquire vault-write.lock immediately on its own spawn.
		clearInterval(vaultRefreshTimer);
		await vaultLock.release();
		// Cross-repo wakeup (P2). Any worker that timed out waiting for
		// vault-write.lock while WE held it recorded its cwd; spawn a
		// successor for each so the queue entry isn't stranded until that
		// repo's next post-commit hook. Idempotent: `launchWorker` against
		// an empty queue is a cheap no-op.
		try {
			const pending = await consumePendingWorkers(memoryBankRoot);
			for (const pendingCwd of pending) {
				if (pendingCwd !== cwd) {
					log.info("Waking pending worker for cwd=%s", pendingCwd);
					launchWorker(pendingCwd);
				}
			}
		} catch (e) {
			log.warn("consumePendingWorkers on release failed (non-fatal): %s", (e as Error).message);
		}
	}
}

/**
 * Processes a single queue entry based on its type.
 * Called by runWorker() for each entry in the queue.
 */
async function processQueueEntry(
	op: GitOperation,
	cwd: string,
	storage: StorageProvider,
	force: boolean,
): Promise<void> {
	log.info("Processing queue entry: type=%s hash=%s", op.type, op.commitHash.substring(0, 8));

	switch (op.type) {
		case "commit":
		case "cherry-pick":
		case "revert":
		case "amend":
			// These all go through the LLM pipeline
			await executePipeline(cwd, op, force);
			break;

		case "squash":
			await handleSquashFromQueue(op, cwd);
			break;

		case "rebase-pick":
			await handleRebasePickFromQueue(op, cwd);
			break;

		case "rebase-squash":
			await handleRebaseSquashFromQueue(op, cwd);
			break;

		default:
			log.warn("Unknown queue entry type: %s", (op as GitOperation).type);
	}

	// Tail step: prune visible .md files for hoisted older versions
	// (`parentCommitHash != null`) on the branch the op landed on. Reading
	// the live branch would point at the wrong tree if the user has `git
	// checkout`'d away between enqueue and drain, so we use op.branch (set
	// by every hook in this version). Pre-0.99.x queue entries that lack
	// op.branch are skipped — guessing the live branch is exactly the bug
	// the captured field is meant to prevent. Failures MUST NOT roll back
	// the op.
	if (!op.branch) {
		log.warn(
			"Stale-child cleanup skipped for %s: queue entry has no branch field (pre-0.99.x format)",
			op.commitHash.substring(0, 8),
		);
		return;
	}
	try {
		const { deleted, failed } = await cleanupBranchStaleChildMarkdown(cwd, op.branch, storage);
		/* v8 ignore start -- conditional log: cleanup ran but had nothing to do is the common case; non-zero counts fire under real worker churn covered by the cleanup function's own tests. */
		if (deleted > 0 || failed > 0) {
			log.info("Stale-child cleanup on %s: deleted=%d failed=%d", op.branch, deleted, failed);
		}
		/* v8 ignore stop */
	} catch (err) {
		log.warn("Stale-child cleanup tail step failed for %s: %s", op.commitHash.substring(0, 8), errMsg(err));
	}
}

/**
 * Returns current time in milliseconds (high-resolution monotonic clock).
 */
function now(): number {
	return performance.now();
}

/**
 * Formats elapsed time in milliseconds to a human-readable string.
 */
function formatElapsed(startMs: number): string {
	const elapsed = performance.now() - startMs;
	return elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${Math.round(elapsed)}ms`;
}

/**
 * Reads the live source file at `path` and returns its sha256 hex digest.
 * Returns null when the file is missing or unreadable — callers treat that
 * as "no comparison data available" rather than a re-archive trigger.
 */
function safeHashFileSync(path: string): string | null {
	if (!existsSync(path)) return null;
	try {
		const body = readFileSync(path, "utf-8");
		return createHash("sha256").update(body).digest("hex");
	} catch {
		/* v8 ignore next -- defensive catch: existsSync gates above, so readFileSync only throws on fs-level races (permission flip / file unlinked between exists and read). Not deterministically reproducible in unit tests. */
		return null;
	}
}

/**
 * Reads uncommitted plan slugs from plans.json registry.
 * Plans are discovered by the StopHook at transcript scan time, so the
 * registry is already up-to-date when the post-commit hook runs.
 *
 * Surfaces two distinct categories:
 *   1. Fresh — never archived (`commitHash === null`, no `contentHashAtCommit`).
 *   2. Revived guard — previously archived, but the source file has been edited
 *      since archive (`contentHashAtCommit` exists and no longer matches the
 *      file's live hash). Without this, a user iterating on the same plan
 *      across commits would see the panel "stuck" on a stale commit hash —
 *      see PLANS & NOTES guard-revival bug.
 */
async function detectPlanSlugsFromRegistry(cwd: string, branch: string): Promise<Set<string>> {
	const registry = await loadPlansRegistry(cwd);
	const slugs = new Set<string>();
	for (const [slug, entry] of Object.entries(registry.plans)) {
		// No branch filter — uncommitted plans bind to the current worktree
		// (its own plans.json) and commit associates all of them. Cross-worktree
		// leakage is impossible because each worktree has a separate plans.json.
		if (entry.commitHash === null && !entry.contentHashAtCommit) {
			slugs.add(slug);
			continue;
		}
		if (entry.commitHash !== null && entry.contentHashAtCommit && entry.sourcePath) {
			const liveHash = safeHashFileSync(entry.sourcePath);
			if (liveHash && liveHash !== entry.contentHashAtCommit) {
				slugs.add(slug);
			}
		}
	}
	log.info("Plan registry scan: found %d uncommitted slug(s) on %s: [%s]", slugs.size, branch, [...slugs].join(", "));
	return slugs;
}

/** Result from associatePlansWithCommit: plan references + raw markdown for progress evaluation */
export interface PlanAssociationResult {
	readonly refs: ReadonlyArray<PlanReference>;
	/** Map of archived slug (newSlug) to raw plan markdown content */
	readonly markdownBySlug: ReadonlyMap<string, string>;
	/** Map of archived slug (newSlug) to original slug (pre-archive) */
	readonly originalSlugBySlug: ReadonlyMap<string, string>;
}

/**
 * Associates detected plan slugs with a commit: updates plans.json,
 * adds PlanReference entries to the summary, and backs up plan files
 * to the orphan branch.
 *
 * Also returns the raw markdown content for each plan so callers can
 * evaluate plan progress without re-reading the files.
 */
async function associatePlansWithCommit(
	slugs: Set<string>,
	commitHash: string,
	cwd: string,
	branch?: string,
): Promise<PlanAssociationResult> {
	log.info("Plan association: detected %d slug(s) from transcripts: [%s]", slugs.size, [...slugs].join(", "));
	const emptyResult: PlanAssociationResult = {
		refs: [],
		markdownBySlug: new Map(),
		originalSlugBySlug: new Map(),
	};
	if (slugs.size === 0) return emptyResult;

	const { createHash } = await import("node:crypto");
	const registry = await loadPlansRegistry(cwd);
	log.info(
		"Plan association: registry has %d entries: [%s]",
		Object.keys(registry.plans).length,
		Object.entries(registry.plans)
			.map(([s, e]) => `${s}(commitHash=${e.commitHash})`)
			.join(", "),
	);
	const planRefs: PlanReference[] = [];
	const planFiles: Array<{ slug: string; content: string }> = [];
	const markdownBySlug = new Map<string, string>();
	const originalSlugBySlug = new Map<string, string>();
	const shortHash = commitHash.substring(0, 8);

	for (const slug of slugs) {
		const entry = registry.plans[slug];
		if (!entry) {
			log.info("Plan association: slug %s not in registry — skipping", slug);
			continue;
		}
		// Skip per-commit archive snapshots (commitHash set but no
		// contentHashAtCommit — the `slug-<shortHash>` artifacts, not user-facing
		// working-area rows). Guard entries (commitHash + contentHashAtCommit) are
		// deliberately NOT skipped here: detectPlanSlugsFromRegistry only forwards
		// them when their source file diverged from the guard hash, which means the
		// user iterated on the plan and we need to re-archive the new content.
		if (entry.commitHash !== null && !entry.contentHashAtCommit) {
			log.info(
				"Plan association: slug %s is an archive snapshot for %s — skipping",
				slug,
				entry.commitHash.substring(0, 8),
			);
			continue;
		}

		// Read the source file from the registry rather than rebuilding the
		// path from slug — entries can point at arbitrary external `.md` files
		// (see the symmetric explanation in vscode/src/core/PlanService.ts
		// archivePlanForCommit).
		const planFile = entry.sourcePath;
		if (!existsSync(planFile)) {
			log.warn("Plan association: slug %s sourcePath %s missing on disk — skipping archive", slug, planFile);
			continue;
		}

		// Read plan file content for orphan branch backup + content hash
		const content = readFileSync(planFile, "utf-8");
		const contentHash = createHash("sha256").update(content).digest("hex");

		// Extract title from markdown
		const titleMatch = /^#\s+(.+)/m.exec(content);
		const title = titleMatch?.[1]?.trim() ?? slug;

		const nowStr = new Date().toISOString();
		const newSlug = `${slug}-${shortHash}`;

		// Build PlanReference for CommitSummary (slug is renamed to include commit hash)
		planRefs.push({
			slug: newSlug,
			title,
			addedAt: entry.addedAt,
			updatedAt: nowStr,
		});

		// Store under new slug in orphan branch
		planFiles.push({ slug: newSlug, content });

		// Retain markdown + original slug for progress evaluation
		markdownBySlug.set(newSlug, content);
		originalSlugBySlug.set(newSlug, slug);

		// Archive in plans.json: the original slug entry becomes the guard
		// (contentHashAtCommit detects later file overwrites → revival).
		// No per-commit `<slug>-<shortHash>` archive row is written — the
		// orphan-branch snapshot (stored under newSlug below) + the CommitSummary
		// PlanReference are the system of record; the archive row was a redundant
		// plans.json copy the sidebar never showed.
		const updatedRegistry = await loadPlansRegistry(cwd);
		const guardEntry = {
			...entry,
			commitHash: commitHash,
			contentHashAtCommit: contentHash,
			updatedAt: nowStr,
		};
		await savePlansRegistry(
			{
				...updatedRegistry,
				plans: {
					...updatedRegistry.plans,
					[slug]: guardEntry,
				},
			},
			cwd,
		);
		log.info("Plan archived: %s → %s (hash=%s)", slug, newSlug, contentHash.substring(0, 12));
	}

	// Store plan files in orphan branch
	if (planFiles.length > 0) {
		await storePlans(planFiles, `Archive ${planFiles.length} plan(s) for commit ${shortHash}`, cwd, branch);
		log.info("Associated %d plan(s) with commit %s", planFiles.length, shortHash);
	}

	return { refs: planRefs, markdownBySlug, originalSlugBySlug };
}

// ─── Note association ────────────────────────────────────────────────────────

/**
 * Reads uncommitted note IDs from plans.json registry.
 *
 * Surfaces two distinct categories — the same fresh / revived-guard split that
 * detectPlanSlugsFromRegistry uses. See that function's doc-comment for the
 * iterative-commit revival rationale.
 */
async function detectUncommittedNoteIds(cwd: string, branch: string): Promise<Set<string>> {
	const registry = await loadPlansRegistry(cwd);
	const ids = new Set<string>();
	for (const [id, entry] of Object.entries(registry.notes ?? {})) {
		// No branch filter — notes bind to the current worktree; commit
		// associates all uncommitted ones (per-worktree plans.json isolates).
		if (entry.commitHash === null && !entry.contentHashAtCommit) {
			ids.add(id);
			continue;
		}
		if (entry.commitHash !== null && entry.contentHashAtCommit && entry.sourcePath) {
			const liveHash = safeHashFileSync(entry.sourcePath);
			if (liveHash && liveHash !== entry.contentHashAtCommit) {
				ids.add(id);
			}
		}
	}
	log.info("Note registry scan: found %d uncommitted note(s) on %s: [%s]", ids.size, branch, [...ids].join(", "));
	return ids;
}

/**
 * Associates detected notes with a commit: updates plans.json,
 * adds NoteReference entries to the summary, and backs up note files
 * to the orphan branch.
 */
async function associateNotesWithCommit(
	ids: Set<string>,
	commitHash: string,
	cwd: string,
	branch?: string,
): Promise<NoteReference[]> {
	log.info("Note association: detected %d note(s): [%s]", ids.size, [...ids].join(", "));
	if (ids.size === 0) return [];

	const { createHash } = await import("node:crypto");
	const shortHash = commitHash.substring(0, 8);
	const noteRefs: NoteReference[] = [];
	const noteFiles: Array<{ id: string; content: string }> = [];

	// Load registry once before the loop and accumulate all mutations
	let registry = await loadPlansRegistry(cwd);
	/* v8 ignore start -- defensive: notes field may be absent in legacy registries */
	const updatedNotes = { ...(registry.notes ?? {}) };
	/* v8 ignore stop */

	for (const id of ids) {
		const entry = updatedNotes[id];
		if (!entry) {
			log.info("Note association: id %s not in registry — skipping", id);
			continue;
		}

		// Read note content from source file
		if (!entry.sourcePath || !existsSync(entry.sourcePath)) {
			log.info("Note association: id %s has no readable source file — skipping", id);
			continue;
		}
		const content = readFileSync(entry.sourcePath, "utf-8");
		const contentHash = createHash("sha256").update(content).digest("hex");

		const now2 = new Date().toISOString();
		const newId = `${id}-${shortHash}`;

		// Build NoteReference for CommitSummary
		noteRefs.push({
			id: newId,
			title: entry.title,
			format: entry.format,
			content: entry.format === "snippet" ? content : undefined,
			addedAt: entry.addedAt,
			updatedAt: now2,
		});

		// Store under new id in orphan branch
		noteFiles.push({ id: newId, content });

		// Archive: the original id entry becomes the guard (contentHashAtCommit
		// detects later overwrites → revival). No `<id>-<shortHash>` archive
		// row — the orphan-branch snapshot (stored under newId below) + the
		// CommitSummary NoteReference are the system of record.
		updatedNotes[id] = {
			...entry,
			commitHash,
			updatedAt: now2,
			contentHashAtCommit: contentHash,
		};
		log.info("Note archived: %s → %s (hash=%s)", id, newId, contentHash.substring(0, 12));
	}

	// Write accumulated changes in a single registry save
	if (noteRefs.length > 0) {
		registry = await loadPlansRegistry(cwd);
		await savePlansRegistry({ ...registry, notes: updatedNotes }, cwd);
	}

	// Store note files in orphan branch
	if (noteFiles.length > 0) {
		await storeNotes(noteFiles, `Archive ${noteFiles.length} note(s) for commit ${shortHash}`, cwd, branch);
		log.info("Associated %d note(s) with commit %s", noteFiles.length, shortHash);
	}

	return noteRefs;
}

// ─── Reference / Linear issue association (parallel to Plans / Notes) ───────

/**
 * Return shape for {@link associateReferencesWithCommit}.
 *
 * `refs` are the post-archive snapshots stored on `CommitSummary.references`.
 * `filesToStore` are the RAW markdown bytes read from the active path — the
 * caller passes them straight to `SummaryStore.storeReferences` so the
 * orphan-branch snapshot is the system of record (no local archived
 * copy). Mirrors the historical Linear-only filesToStore handoff pattern.
 */
export interface AssociateReferencesResult {
	readonly refs: ReadonlyArray<ReferenceCommitRef>;
	readonly filesToStore: ReadonlyArray<{ archivedKey: string; source: SourceId; content: string }>;
	/**
	 * Local state to delete ONLY AFTER the orphan-branch snapshot
	 * (`filesToStore`) has been durably written by `storeReferences`. Each item
	 * is a committed reference whose registry row + local markdown must be
	 * removed via {@link finalizeReferenceArchive}. Deferring the deletion is
	 * what makes a `storeReferences` failure recoverable: the active row stays in
	 * plans.json and is re-archived on the next commit instead of being lost.
	 *
	 * `updatedAt` is the captured row fingerprint: finalize deletes only if the
	 * fresh registry row still carries the SAME `updatedAt`. If a StopHook
	 * re-upserted the same mapKey (user re-referenced the issue) between
	 * `storeReferences` and finalize, the fresh row's `updatedAt` differs and the
	 * deletion is skipped — preserving the new active row + its markdown.
	 */
	readonly committed: ReadonlyArray<{ mapKey: string; sourcePath: string; updatedAt: string }>;
}

/**
 * Multi-source generalisation of `associateLinearIssuesWithCommit`. Routes
 * Linear / Jira / GitHub / Notion entries through a single archive pipeline:
 *
 *   1. For each `{mapKey, source, sourcePath}` triple, read the raw markdown
 *      bytes so the orphan-branch snapshot does not depend on the local file.
 *   2. Build the per-commit snapshot: a `ReferenceCommitRef` (value snapshot)
 *      for the CommitSummary and a `filesToStore` entry (raw bytes keyed by
 *      `archivedKey = "<mapKey>-<shortHash>"`) for the orphan branch. Under the
 *      commit-deletes-entry model (§13) the reference row does NOT survive in
 *      plans.json — but its deletion is DEFERRED, not done here.
 *
 * This function performs NO deletes and NO `savePlansRegistry` write: it only
 * COMPUTES the snapshot. The `committed` list it returns names the local state
 * (registry row + markdown) that must be torn down — but only AFTER the caller
 * has durably written `filesToStore` via `storeReferences`. The caller then
 * calls {@link finalizeReferenceArchive}. This write-ahead ordering is what
 * makes a `storeReferences` failure recoverable: with the active row still in
 * plans.json, the reference is simply re-archived on the next commit instead of
 * being lost (queue entries are fire-and-forget with no retry). The caller owns
 * `storeReferences` because the orphan-branch commit message differs per flow.
 */
async function associateReferencesWithCommit(
	ids: ReadonlyArray<{ mapKey: string; source: SourceId; sourcePath: string }>,
	commitHash: string,
	cwd: string,
	branch: string,
): Promise<AssociateReferencesResult> {
	log.info("Reference association: detected %d ref(s) for branch %s", ids.length, branch);
	if (ids.length === 0) return { refs: [], filesToStore: [], committed: [] };

	const shortHash = commitHash.substring(0, 8);
	const refs: ReferenceCommitRef[] = [];
	const filesToStore: Array<{ archivedKey: string; source: SourceId; content: string }> = [];

	const registry = await loadPlansRegistry(cwd);
	const updatedReferences: Record<string, NonNullable<PlansRegistry["references"]>[string]> = {
		/* v8 ignore next -- `?? {}` fallback unreachable: `ids` is sourced from detectUncommittedReferenceIds, which derives from plans.json.references; if references were undefined ids would be empty and the early-return would have already fired. */
		...(registry.references ?? {}),
	};
	// References whose snapshot was captured this run. Their local state (registry
	// row + markdown) is torn down by the caller via finalizeReferenceArchive,
	// but ONLY after storeReferences durably writes the orphan-branch snapshot.
	const committed: Array<{ mapKey: string; sourcePath: string; updatedAt: string }> = [];
	const droppedMapKeys: string[] = [];

	for (const { mapKey, source } of ids) {
		const entry = updatedReferences[mapKey];
		if (!entry) {
			log.info("Reference association: mapKey %s not in registry — skipping", mapKey);
			droppedMapKeys.push(mapKey);
			continue;
		}

		// CRITICAL: read raw markdown bytes BEFORE rename. The orphan-branch
		// snapshot uses rawContent — independent of whether the local rename
		// succeeds. The previous Linear-only path also did this via
		// readMarkdownFileContent; we keep the same ordering.
		let rawContent: string;
		try {
			rawContent = await readMarkdownFileContent(entry.sourcePath);
			/* v8 ignore start -- IO failure to read the active markdown; the StopHook upsert that originally wrote it would have rejected first, so practically unreachable except under fs corruption. */
		} catch (err) {
			log.warn(
				"Reference association: cannot read markdown for %s at %s: %s — skipping",
				mapKey,
				entry.sourcePath,
				(err as Error).message,
			);
			droppedMapKeys.push(mapKey);
			continue;
		}
		/* v8 ignore stop */

		const fullRef = await readReferenceMarkdown(entry.sourcePath);
		if (!fullRef) {
			log.info(
				"Reference association: mapKey %s sourcePath %s unparseable as Reference — skipping",
				mapKey,
				entry.sourcePath,
			);
			droppedMapKeys.push(mapKey);
			continue;
		}

		const archivedKey = `${mapKey}-${shortHash}`;

		// Reference commit DELETES the entry (no guard row): reference has no
		// revival (read-only MCP snapshot), so nothing needs to survive in
		// plans.json — the orphan-branch snapshot (filesToStore) + the
		// CommitSummary ReferenceCommitRef are the system of record. The registry
		// row + local markdown are NOT torn down here; the caller does that via
		// finalizeReferenceArchive AFTER storeReferences confirms the snapshot is
		// durably written (write-ahead → a storeReferences failure is recoverable).
		committed.push({ mapKey, sourcePath: entry.sourcePath, updatedAt: entry.updatedAt });

		refs.push({
			archivedKey,
			source,
			nativeId: entry.nativeId,
			title: entry.title,
			url: entry.url,
			...(fullRef.fields !== undefined && fullRef.fields.length > 0 ? { fields: fullRef.fields } : {}),
			referencedAt: fullRef.referencedAt,
			sourceToolName: entry.sourceToolName,
		});
		filesToStore.push({ archivedKey, source, content: rawContent });

		log.info("Reference snapshot captured (deletion deferred): %s → %s", mapKey, archivedKey);
	}

	if (droppedMapKeys.length > 0) {
		log.warn(
			"Reference association: dropped %d of %d ref(s) [%s] for commit %s — see prior log lines for per-ref reason (registry miss / sourcePath unreadable)",
			droppedMapKeys.length,
			ids.length,
			droppedMapKeys.join(", "),
			shortHash,
		);
	}

	return { refs, filesToStore, committed };
}

/**
 * Tears down the local state of references whose orphan-branch snapshot has now
 * been durably written (the `committed` list from {@link associateReferencesWithCommit}).
 * MUST be called only AFTER a successful `storeReferences` — calling it before
 * (or skipping `storeReferences` on failure) is what would lose data.
 *
 * Per committed reference: delete the registry row + local markdown — BUT only
 * if the fresh row still matches the captured `updatedAt` fingerprint. A
 * StopHook may have re-upserted the same mapKey (user re-referenced the issue)
 * between `storeReferences` and this call; the re-upsert bumps `updatedAt`, so a
 * mismatch means we leave the fresh active row + its markdown intact (deleting
 * them would lose the re-reference). A near-write reread + per-key merge also
 * preserves any unrelated keys a concurrent writer touched.
 */
async function finalizeReferenceArchive(
	committed: ReadonlyArray<{ mapKey: string; sourcePath: string; updatedAt: string }>,
	cwd: string,
): Promise<void> {
	if (committed.length === 0) return;

	const freshRegistry = await loadPlansRegistry(cwd);
	const mergedReferences = { ...(freshRegistry.references ?? {}) };
	const toDeleteMarkdown: Array<{ mapKey: string; sourcePath: string }> = [];
	for (const { mapKey, sourcePath, updatedAt } of committed) {
		const fresh = mergedReferences[mapKey];
		// `updatedAt` is a sufficient fingerprint here: the captured value was
		// written by a PRIOR upsert (at discovery / an earlier commit), while a
		// racing re-upsert stamps `new Date()` during this post-commit window — so
		// a mismatch reliably means "re-upserted since capture". A same-millisecond
		// collision is unreachable (the two writes are separated by ≥ the time
		// since discovery), so no revision/nonce is needed.
		if (fresh !== undefined && fresh.updatedAt !== updatedAt) {
			log.info("Reference finalize: %s re-upserted since capture — keeping active row", mapKey);
			continue;
		}
		delete mergedReferences[mapKey];
		toDeleteMarkdown.push({ mapKey, sourcePath });
	}
	// Nothing actually deleted (every key was re-upserted) → skip the write
	// entirely. Re-saving an unchanged registry would only widen the lost-update
	// window against a concurrent StopHook for zero benefit.
	if (toDeleteMarkdown.length === 0) return;

	const out: PlansRegistry = {
		version: 1,
		plans: freshRegistry.plans,
		...(freshRegistry.notes !== undefined ? { notes: freshRegistry.notes } : {}),
		references: mergedReferences,
	};
	await savePlansRegistry(out, cwd);

	for (const { mapKey, sourcePath } of toDeleteMarkdown) {
		try {
			await deleteReferenceMarkdown(sourcePath);
		} catch (err) {
			log.warn("Reference finalize: failed to delete local markdown for %s: %s", mapKey, (err as Error).message);
		}
		log.info("Reference entry removed (post-storeReferences): %s", mapKey);
	}
}

/** Reads the raw markdown file bytes (for orphan-branch storage). */
async function readMarkdownFileContent(absPath: string): Promise<string> {
	const { readFile } = await import("node:fs/promises");
	return await readFile(absPath, "utf-8");
}

/**
 * Bucket active reference entries by SourceId, parse each markdown back into a
 * Reference, and render one XML block per registered adapter in `ALL_ADAPTERS`
 * order. Empty source buckets are skipped (adapter.renderPromptBlock returns
 * "" for empty input, and we filter empty strings before joining).
 *
 * Iteration order = ALL_ADAPTERS registration order, so the prompt's
 * `<linear-issues>` / `<jira-issues>` / `<github-issues>` / `<notion-pages>`
 * sections appear in a stable order across runs — important for the LLM's
 * caching to hit on the prompt prefix.
 *
 * Shared between executePipeline and the amend delta-step path so
 * both flows render the reference context identically.
 */
async function assembleReferenceBlocks(activeReferenceEntries: ReadonlyArray<ReferenceEntry>): Promise<string> {
	const refsBySource = new Map<SourceId, Reference[]>();
	for (const entry of activeReferenceEntries) {
		const ref = await readReferenceMarkdown(entry.sourcePath);
		/* v8 ignore start -- null-ref branch fires only when the markdown file vanishes between StopHook write and this read (rare race); prompt assembly gracefully skips those entries. */
		if (!ref) continue;
		/* v8 ignore stop */
		const arr = refsBySource.get(ref.source) ?? [];
		arr.push(ref);
		refsBySource.set(ref.source, arr);
	}
	const parts: string[] = [];
	for (const adapter of ALL_ADAPTERS) {
		const refs = refsBySource.get(adapter.id) ?? [];
		const block = adapter.renderPromptBlock(refs);
		if (block.length > 0) parts.push(block);
	}
	return parts.join("\n");
}

/**
 * The core LLM summarization pipeline. Now driven by a GitOperation from the queue.
 *
 * Handles: commit, cherry-pick, revert (full LLM pipeline), and amend (LLM + merge with old summary).
 * Squash and rebase operations are handled by dedicated functions, not this pipeline.
 */
async function executePipeline(cwd: string, op: GitOperation, force = false): Promise<void> {
	const pipelineStart = now();

	// commitSource and commitType come from the queue entry (set at enqueue time)
	const commitSource: CommitSource = op.commitSource ?? "cli";
	const commitType: CommitType = op.type === "amend" ? "amend" : (op.type as CommitType);

	// Load config and initialize log level before any pipeline logging
	const config = await loadConfig();
	setLogLevel(config.logLevel ?? "info", config.logLevelOverrides as Record<string, LogLevel> | undefined);

	// Step 1: Get commit info from the queue entry's hash (not HEAD — HEAD may have moved)
	let stepStart = now();
	const commitInfo = await getCommitInfo(op.commitHash, cwd);
	log.info("Commit: %s - %s (%s)", commitInfo.hash.substring(0, 8), commitInfo.message, formatElapsed(stepStart));

	// For amend operations: load old summary, run LLM with amend delta diff, merge
	if (op.type === "amend" && op.sourceHashes?.[0]) {
		const oldHash = op.sourceHashes[0];
		log.info("Amend pipeline: %s → %s", oldHash.substring(0, 8), op.commitHash.substring(0, 8));
		try {
			await handleAmendPipeline(
				commitInfo,
				oldHash,
				cwd,
				pipelineStart,
				{ fromRef: oldHash, toRef: op.commitHash },
				{ commitType: "amend", commitSource },
				op.createdAt,
			);
		} catch (err: unknown) {
			log.error("Amend pipeline failed: %s", (err as Error).message);
		}
		return;
	}

	// Step 3+4: Load sessions and read transcripts with time cutoff for queue-driven attribution.
	// Excluded conversations are filtered inside `loadSessionTranscripts` BEFORE any cursor
	// advance — keep the plans/notes exclusion read here, but no `sessionTranscripts.filter`
	// step is needed.
	const exclusions = await readExclusions(cwd);
	const { sessionTranscripts, totalEntries, humanEntries } = await loadSessionTranscripts(cwd, config, op.createdAt);

	// Step 5: Get git diff and stats (moved before guard to enable diff-only summaries)
	stepStart = now();
	const branch = await getCurrentBranch(cwd);
	let diff: string;
	let diffStats: DiffStats;

	// Use op.commitHash instead of HEAD — HEAD may have moved since this entry was enqueued
	try {
		diff = await getDiffContent(`${op.commitHash}~1`, op.commitHash, cwd);
		diffStats = await getDiffStats(`${op.commitHash}~1`, op.commitHash, cwd);
	} catch {
		// First commit in repo — no parent
		log.warn("Could not diff against %s~1 (first commit?), using empty diff", op.commitHash.substring(0, 8));
		diff = "(First commit — no previous commit to diff against)";
		diffStats = { filesChanged: 0, insertions: 0, deletions: 0 };
	}

	log.info(
		"Git diff: %d files changed, +%d -%d (%s)",
		diffStats.filesChanged,
		diffStats.insertions,
		diffStats.deletions,
		formatElapsed(stepStart),
	);

	// Guard: skip only if BOTH transcript is empty AND diff has no file changes
	// (Summarizer Rule 5 can infer topics from diff alone when transcript is empty)
	if (totalEntries === 0 && diffStats.filesChanged === 0) {
		log.info("No new transcript entries and no file changes. Skipping summary generation.");
		return;
	}

	// Step 6: Build multi-session conversation context
	const conversation = buildMultiSessionContext(sessionTranscripts);
	log.debug("Conversation context built: %d chars, %d sessions", conversation.length, sessionTranscripts.length);

	// Assemble the structured prompt blocks (plans / notes / references).
	// Pure registry-driven: no transcript re-scan. User's Ignore on the panel
	// takes effect immediately on the next commit. References are bucketed by
	// SourceId and rendered through `adapter.renderPromptBlock` per registered
	// SourceAdapter — adding a new source = registering an adapter, no code
	// change here.
	const [rawActivePlanEntries, rawActiveNoteEntries, rawActiveReferenceEntries] = await Promise.all([
		detectActivePlansForBranch(cwd, branch),
		detectActiveNotesForBranch(cwd, branch),
		getReferenceEntriesForBranch(cwd, branch),
	]);
	const activePlanEntries = rawActivePlanEntries.filter((p) => !exclusions.plans.has(p.slug));
	const activeNoteEntries = rawActiveNoteEntries.filter((n) => !exclusions.notes.has(n.id));
	// Reference exclusion key is `<source>:<nativeId>` — same shape as the
	// `plans.json.references` map key, mirroring how plans / notes are keyed.
	const activeReferenceEntries = rawActiveReferenceEntries.filter(
		(e) => !exclusions.references.has(`${e.source}:${e.nativeId}`),
	);
	const plansBlock = await formatPlansBlock(activePlanEntries);
	const notesBlock = await formatNotesBlock(activeNoteEntries);
	const referenceBlocks = await assembleReferenceBlocks(activeReferenceEntries);
	log.info(
		"Prompt blocks: plans=%d notes=%d references=%d",
		activePlanEntries.length,
		activeNoteEntries.length,
		activeReferenceEntries.length,
	);

	// Step 7: Call AI to generate summary
	stepStart = now();
	const summaryParams = {
		conversation,
		diff,
		commitInfo,
		diffStats,
		transcriptEntries: totalEntries,
		conversationTurns: humanEntries,
		referenceBlocks,
		plans: plansBlock,
		notes: notesBlock,
		config,
	};

	let summaryResult: Awaited<ReturnType<typeof generateSummary>>;

	try {
		summaryResult = await generateSummary(summaryParams);
	} catch (error: unknown) {
		// All LLM failures (network, 5xx, credential, quota) flow through the
		// same retry-then-placeholder path. The webview banner driven by
		// `summaryError: "llm-failed"` is the loud-failure signal — visible on
		// every affected commit until the user fixes the underlying issue and
		// clicks Regenerate. See cli/DEVELOPMENT.md for the unified contract.
		log.warn("First API attempt failed: %s. Retrying in %dms...", (error as Error).message, RETRY_DELAY_MS);
		await delay(RETRY_DELAY_MS);

		try {
			summaryResult = await generateSummary(summaryParams);
		} catch (retryError: unknown) {
			// LLM completely unavailable — save a summary with empty topics so the commit
			// still has a record (metadata, diff stats, transcript). This prevents missing
			// source summaries during squash/rebase merges. Topics can be back-filled later
			// via Regenerate.
			//
			// Marker fields to distinguish LLM failure from genuinely empty LLM response:
			//   - `summaryError: "llm-failed"` written onto the root by the assembler below
			//   - `llm.stopReason: "error"` kept for backward compat with pre-summaryError readers
			//   - model: config.model → the model we tried to call (not "none")
			// A genuine empty response would have stopReason: "end_turn" and a real model ID.
			log.error("API call failed after retry: %s", (retryError as Error).message);
			log.warn(
				"Saving summary with empty topics + summaryError marker for commit %s",
				commitInfo.hash.substring(0, 8),
			);
			summaryResult = {
				transcriptEntries: totalEntries,
				conversationTurns: humanEntries,
				llm: {
					model: config.model ?? "unknown",
					inputTokens: 0,
					outputTokens: 0,
					apiLatencyMs: 0,
					stopReason: "error",
				},
				stats: diffStats,
				topics: [],
			};
		}
	}
	log.info("API summary generated (%s)", formatElapsed(stepStart));

	// Read uncommitted plan slugs from plans.json registry.
	// Apply per-item exclusions BEFORE associate* — these helpers have side effects
	// (savePlansRegistry archive entry + storePlans to the orphan branch), so a
	// post-filter on `planAssociation.refs` would still leave the excluded plan
	// archived on disk. The prompt-block filter only governs LLM input;
	// the archive path is a separate registry scan and must be filtered here.
	const planSlugs = await detectPlanSlugsFromRegistry(cwd, branch);
	for (const excludedSlug of exclusions.plans) planSlugs.delete(excludedSlug);
	const planAssociation = await associatePlansWithCommit(planSlugs, commitInfo.hash, cwd, branch);
	const planRefs = planAssociation.refs;

	// Read uncommitted note IDs from plans.json registry.
	// Same archive-side exclusion as the plan slugs — see comment above.
	const noteIds = await detectUncommittedNoteIds(cwd, branch);
	for (const excludedId of exclusions.notes) noteIds.delete(excludedId);
	const noteRefs = await associateNotesWithCommit(noteIds, commitInfo.hash, cwd, branch);

	// Read uncommitted reference mapKeys from plans.json.references and
	// archive them across every source (linear / jira / github / notion). The
	// returned filesToStore is forwarded directly to storeReferences — captured
	// BEFORE the local rename so the orphan-branch snapshot is independent of
	// rename success. Mirrors the plans / notes archive-side filter — excluded
	// references are dropped here too, so the row reappears on the
	// next commit (skip-don't-archive semantics).
	const rawReferenceIds = await detectUncommittedReferenceIds(cwd, branch);
	const referenceIds = rawReferenceIds.filter((e) => !exclusions.references.has(e.mapKey));
	const {
		refs: referenceRefs,
		filesToStore: referenceFiles,
		committed: referenceCommitted,
	} = await associateReferencesWithCommit(referenceIds, commitInfo.hash, cwd, branch);
	if (referenceFiles.length > 0) {
		// Write-ahead: persist the orphan-branch snapshot FIRST, then tear down
		// local state. If storeReferences throws, the active rows stay in
		// plans.json and re-archive on the next commit (no permanent loss).
		await storeReferences(
			referenceFiles,
			`Archive ${referenceFiles.length} reference ref(s) for commit ${commitInfo.hash.substring(0, 8)}`,
			cwd,
			branch,
		);
		await finalizeReferenceArchive(referenceCommitted, cwd);
	}
	// Step 8b: Evaluate plan progress for each linked plan (Haiku calls parallelized)
	const planProgressArtifacts: PlanProgressArtifact[] = [];
	if (planRefs.length > 0) {
		/* v8 ignore start -- defensive: SummaryResult.topics is always set by generateSummary, but retain the nullish guard in case the type relaxes */
		const topics: ReadonlyArray<TopicSummary> = summaryResult.topics ?? [];
		/* v8 ignore stop */
		const commitDate = new Date(commitInfo.date).toISOString();

		const evalPromises = planRefs.map(async (planRef) => {
			const planMarkdown = planAssociation.markdownBySlug.get(planRef.slug);
			/* v8 ignore start -- defensive: associatePlansWithCommit populates markdownBySlug for every ref it returns, but retain the guard for invariant violations */
			if (planMarkdown === undefined) return null;
			/* v8 ignore stop */
			/* v8 ignore start -- defensive: originalSlugBySlug is populated alongside markdownBySlug in associatePlansWithCommit */
			const originalSlug = planAssociation.originalSlugBySlug.get(planRef.slug) ?? planRef.slug;
			/* v8 ignore stop */
			const result = await evaluatePlanProgress(planMarkdown, diff, topics, conversation, config);
			if (!result) return null;
			return {
				version: 1 as const,
				commitHash: commitInfo.hash,
				commitMessage: commitInfo.message,
				commitDate,
				planSlug: planRef.slug,
				originalSlug,
				...result,
			};
		});

		const results = await Promise.all(evalPromises);
		for (const artifact of results) {
			if (artifact) planProgressArtifacts.push(artifact);
		}
		log.info("Plan progress: evaluated %d/%d plan(s)", planProgressArtifacts.length, planRefs.length);
	}

	// Build the StoredTranscript (early) so we can allocate a v5
	// transcript ID for it and stamp it onto the summary in one go. Overlays
	// are already applied inside loadSessionTranscripts so the summary input,
	// the empty-transcript guard, and the stored snapshot all see the same view.
	const storedTranscript = buildStoredTranscript(sessionTranscripts);
	const hasTranscriptContent = storedTranscript.sessions.length > 0;
	const transcriptId = hasTranscriptContent ? generateTranscriptId() : undefined;

	// Build the CommitSummary leaf node with top-level fields from the API result.
	// For a leaf, diffStats === stats (both are `git diff {hash}^..{hash}`).
	// Schema v5: unified Hoist + stable transcript IDs. Topics + recap are
	// part of the Hoist family so root is always authoritative. Leaves are
	// the source-of-truth for v5 children; later squash/amend operations strip
	// the Hoist fields off this node when it becomes a child of a v5 root.
	// `transcripts: [transcriptId]` (when set below) is the v5 stable-ID
	// reference into `transcripts/{transcriptId}.json` on the orphan branch.
	//
	// LLM failure marker: if generateSummary fell through to the retry-fail
	// catch block above, `summaryResult.llm.stopReason === "error"` is the
	// trip-wire — surface it explicitly on the root via summaryError so
	// isSummaryError catches it without relying on the legacy stopReason
	// fallback alone.
	const llmFailed = summaryResult.llm?.stopReason === "error";

	const summary: CommitSummary = {
		version: CURRENT_SCHEMA_VERSION,
		commitHash: commitInfo.hash,
		commitMessage: commitInfo.message,
		commitAuthor: commitInfo.author,
		commitDate: new Date(commitInfo.date).toISOString(),
		branch,
		generatedAt: new Date().toISOString(),
		commitType,
		commitSource,
		...summaryResult,
		diffStats,
		...(llmFailed ? { summaryError: LLM_FAILED } : {}),
		...(planRefs.length > 0 ? { plans: planRefs } : {}),
		...(noteRefs.length > 0 ? { notes: noteRefs } : {}),
		...(referenceRefs.length > 0 ? { references: referenceRefs } : {}),
		// v5 contract: `transcripts` is always present on a v5 root (empty array
		// when no AI sessions were captured). Omitting the field would route the
		// `getTranscriptIds` fast-path back through `collectAllTranscriptHashes`,
		// which both costs an extra git read and confuses the "v5 means field
		// populated" invariant for future maintainers.
		transcripts: transcriptId !== undefined ? [transcriptId] : [],
	};

	/* v8 ignore start -- log formatting ternaries (recap/topics/plans/notes presence) — each is a display variant, not a logical branch. */
	log.info(
		"Summary built for %s: recap=%s, topics=%d, plans=%s, notes=%s, references=%s",
		commitInfo.hash.substring(0, 8),
		summary.recap ? "yes" : "no",
		summary.topics?.length ?? 0,
		summary.plans ? `${summary.plans.length} ref(s): [${summary.plans.map((p) => p.slug).join(", ")}]` : "absent",
		summary.notes ? `${summary.notes.length} ref(s): [${summary.notes.map((n) => n.id).join(", ")}]` : "absent",
		summary.references
			? `${summary.references.length} ref(s): [${summary.references.map((e) => e.archivedKey).join(", ")}]`
			: "absent",
	);
	/* v8 ignore stop */

	// Step 8d: Store summary (+ transcript + plan progress) in orphan branch
	// Pass `force` so manual re-summarize can overwrite a previously failed entry.
	// `storedTranscript` and `transcriptId` were built earlier so the ID could be
	// stamped onto `summary.transcripts`.
	stepStart = now();
	await storeSummary(summary, cwd, force, {
		...(transcriptId !== undefined && hasTranscriptContent
			? { transcript: { id: transcriptId, data: storedTranscript } }
			: {}),
		...(planProgressArtifacts.length > 0 ? { planProgress: planProgressArtifacts } : {}),
	});
	log.info(
		"Summary stored successfully for commit %s (%s, %d plans, %d notes, %d references)",
		commitInfo.hash.substring(0, 8),
		formatElapsed(stepStart),
		planRefs.length,
		noteRefs.length,
		referenceRefs.length,
	);

	// Note: Old Step 10 (amend-pending Scenario 1) has been removed.
	// Amend operations are now handled through the unified git operation queue.
	// If an amend happens while this Worker is running, post-rewrite(amend) enqueues it,
	// and this Worker will process it in the next queue drain iteration.

	// Final: log summary content
	log.info("=== Pipeline completed in %s ===", formatElapsed(pipelineStart));
	log.info("=== Summary content (%d topics) ===", summaryResult.topics.length);
	for (const topic of summaryResult.topics) {
		log.info("Topic: %s", topic.title);
		log.info("  Trigger:   %s", topic.trigger);
		log.info("  Response:  %s", topic.response);
		log.info("  Decisions: %s", topic.decisions);
		if (topic.todo) {
			log.info("  Todo:      %s", topic.todo);
		}
	}
}

/**
 * Shared squash consolidation pipeline. Used by BOTH:
 *   - handleSquashFromQueue (op.type = "squash"): VSCode plugin Squash button
 *     (writes squash-pending.json + git reset --soft + git commit), or `git
 *     merge --squash` (writes SQUASH_MSG).
 *   - handleRebaseSquashFromQueue (op.type = "rebase-squash"): `git rebase -i`
 *     with squash/fixup in the todo list.
 *
 * Steps:
 *   1. Build SquashConsolidationSource[] via expandSourcesForConsolidation.
 *      This preserves commit-level grouping for nested squash roots (rule 4
 *      supersede evidence relies on per-commit chronology).
 *   2. Extract the outer ticketId from the squash commit message (highest
 *      priority hint per ticketId resolution chain in generateSquashConsolidation).
 *   3. Call generateSquashConsolidation -- returns null on no-content / repeated
 *      LLM failure, in which case mechanicalConsolidate concatenates source
 *      content as a graceful fallback (Hoist invariant always completes).
 *   4. mergeManyToOne writes the v4 root with consolidated topics+recap and
 *     stripped children.
 *
 * Renamed from `handleSquashMerge` because "merge" misleadingly suggested a
 * git merge --squash specific path (it actually serves both routes), and
 * because the function now drives an LLM pipeline rather than just merging.
 */
async function runSquashPipeline(
	oldSummaries: ReadonlyArray<CommitSummary>,
	commitInfo: CommitInfo,
	cwd: string,
	metadata: { readonly commitType: CommitType; readonly commitSource: CommitSource },
): Promise<void> {
	// Expand each source via expandSourcesForConsolidation: preserves per-commit
	// grouping for nested squash roots (so the LLM can apply rule 4 evidence).
	const sources: ReadonlyArray<SquashConsolidationSource> = oldSummaries.flatMap(expandSourcesForConsolidation);

	// Outer ticketId: the squash commit message often carries the explicit ticket
	// ("PROJ-123: ..."), which beats per-source ticketIds. extractTicketIdFromMessage
	// returns undefined when none is present, leaving the inner resolution chain
	// (earliest source -> LLM-extracted) to fill in.
	const outerTicketId = extractTicketIdFromMessage(commitInfo.message);

	// Source-state inheritance: if any source summary is already in a degraded
	// state, the squash result is "merged from compromised inputs" — consolidate
	// only mergers existing topic structures, it does NOT re-derive from raw
	// diff + transcript like Regenerator does. expandSourcesForConsolidation
	// drops summaryError from the source contract (only carries topics/recap/
	// ticketId/commitMessage), so the LLM never sees the failure history; we
	// have to OR it in at the caller level.
	const anySourceFailed = oldSummaries.some(isSummaryError);

	let consolidated: ConsolidatedTopics & { status: "llm" | "mechanical" };

	try {
		const config = await loadConfig();
		const outcome = await generateSquashConsolidation({
			squashCommitMessage: commitInfo.message,
			/* v8 ignore next */
			...(outerTicketId !== undefined && { ticketId: outerTicketId }),
			sources,
			config,
		});
		/* v8 ignore start -- mechanical fallback arms: "no-content" and "llm-error" both re-route to mechanicalConsolidate; covered at integration level by Summarizer's own tests. */
		if (outcome.status === "ok") {
			consolidated = {
				topics: outcome.topics,
				...(outcome.recap !== undefined && { recap: outcome.recap }),
				...(outcome.ticketId !== undefined && { ticketId: outcome.ticketId }),
				llm: outcome.llm,
				status: "llm",
				...(anySourceFailed && { summaryError: LLM_FAILED }),
			};
		} else if (outcome.status === "llm-error") {
			// Real LLM failure (both attempts threw). Mechanical fallback preserves
			// source content; mark the root with summaryError so the webview
			// banner fires.
			consolidated = {
				...mechanicalConsolidate(sources, outerTicketId),
				status: "mechanical",
				summaryError: LLM_FAILED,
			};
		} else {
			// "no-content": no sources / all-empty sources / LLM self-reported
			// nothing to merge. Healthy case — mechanical fallback. Marker only
			// if a source was already degraded (input-contamination inheritance).
			consolidated = {
				...mechanicalConsolidate(sources, outerTicketId),
				status: "mechanical",
				...(anySourceFailed && { summaryError: LLM_FAILED }),
			};
		}
	} catch (err) {
		// Defensive: unexpected runtime error outside generateSquashConsolidation
		// (e.g. loadConfig throws). Treat as llm-error so the user sees a banner.
		log.warn("Squash consolidation failed (runtime), using mechanical merge: %s", errMsg(err));
		consolidated = {
			...mechanicalConsolidate(sources, outerTicketId),
			status: "mechanical",
			summaryError: LLM_FAILED,
		};
	}
	/* v8 ignore stop */

	/* v8 ignore start -- log formatting (recap presence ternary). */
	log.info(
		"Squash consolidation for %s: sources=%d, topics %d → %d, recap=%s, status=%s",
		commitInfo.hash.substring(0, 8),
		sources.length,
		sources.reduce((n, s) => n + s.topics.length, 0),
		consolidated.topics.length,
		consolidated.recap ? "yes" : "no",
		consolidated.status,
	);
	/* v8 ignore stop */

	// mergeManyToOne writes the v4 root with these consolidated topics + recap +
	// stripped children. Hoist invariant always completes (consolidated is never
	// undefined here, even on LLM failure thanks to mechanicalConsolidate).
	await mergeManyToOne(oldSummaries, commitInfo, cwd, metadata, consolidated);

	// Re-associate plans and notes with the new squash commit hash.
	await reassociateMetadata(oldSummaries, commitInfo.hash, cwd);
}

/**
 * Loads source summaries by hash, logging warnings for missing entries.
 * Shared by both squash queue handlers (commit-squash and rebase-squash).
 */
async function loadSourceSummaries(
	sourceHashes: ReadonlyArray<string>,
	cwd: string,
	context: string,
): Promise<CommitSummary[]> {
	const oldSummaries: CommitSummary[] = [];
	const missingHashes: string[] = [];
	for (const hash of sourceHashes) {
		const summary = await getSummary(hash, cwd);
		if (summary) {
			oldSummaries.push(summary);
		} else {
			missingHashes.push(hash);
		}
	}
	if (missingHashes.length > 0) {
		log.warn(
			"%s: %d of %d source summaries missing -- merging available ones. Missing: [%s]",
			context,
			missingHashes.length,
			sourceHashes.length,
			missingHashes.map((h) => h.substring(0, 8)).join(", "),
		);
	}
	return oldSummaries;
}

// ── Queue-driven handler functions ──────────────────────────────────────────

/**
 * Handles a squash queue entry (op.type = "squash"): VSCode plugin Squash
 * button or `git merge --squash`. Both routes write a marker file
 * (squash-pending.json or SQUASH_MSG) that prepare-msg-hook -> queue translates
 * into this op.type.
 *
 * Delegates to runSquashPipeline so behaviour is identical to rebase-squash --
 * both routes go through the same LLM consolidation + mechanical fallback.
 */
async function handleSquashFromQueue(op: GitOperation, cwd: string): Promise<void> {
	if (!op.sourceHashes || op.sourceHashes.length === 0) {
		log.warn("Squash queue entry has no sourceHashes — skipping");
		return;
	}

	const oldSummaries = await loadSourceSummaries(op.sourceHashes, cwd, "Squash");
	if (oldSummaries.length === 0) {
		log.warn("Squash: no source summaries found for %s -- skipping", op.commitHash.substring(0, 8));
		return;
	}

	const commitInfo = await getCommitInfo(op.commitHash, cwd);
	/* v8 ignore start -- commitSource is always set by the enqueue path; fallback is defensive */
	await runSquashPipeline(oldSummaries, commitInfo, cwd, {
		commitType: "squash",
		commitSource: op.commitSource ?? "cli",
	});
	/* v8 ignore stop */
}

/**
 * Handles a rebase pick (1:1 migration) queue entry.
 * No LLM call needed — just migrates the summary to the new hash.
 */
async function handleRebasePickFromQueue(op: GitOperation, cwd: string): Promise<void> {
	if (!op.sourceHashes?.[0]) {
		log.warn("Rebase-pick queue entry has no sourceHash — skipping");
		return;
	}

	const oldHash = op.sourceHashes[0];
	const oldSummary = await getSummary(oldHash, cwd);
	if (!oldSummary) {
		log.warn("Rebase-pick: no summary found for old hash %s — skipping", oldHash.substring(0, 8));
		return;
	}

	const newCommitInfo = await getCommitInfo(op.commitHash, cwd);
	// Carry commitSource forward so the migrated summary records whether the
	// original action came from the VSCode plugin or the CLI. squash and amend
	// already do this; rebase-pick was the odd one out.
	await migrateOneToOne(oldSummary, newCommitInfo, cwd, {
		commitType: "rebase",
		...(op.commitSource && { commitSource: op.commitSource }),
	});

	// Re-associate plans and notes with the new hash
	await reassociateMetadata([oldSummary], op.commitHash, cwd);

	log.info("Rebase-pick: migrated %s → %s", oldHash.substring(0, 8), op.commitHash.substring(0, 8));
}

/**
 * Handles a rebase squash (N:1 merge) queue entry, triggered by `git rebase -i`
 * with squash/fixup in the todo list.
 *
 * Delegates to runSquashPipeline (same path as handleSquashFromQueue) so both
 * routes share the LLM consolidation + mechanical fallback. The user-visible
 * result is identical regardless of which path triggered the squash.
 */
async function handleRebaseSquashFromQueue(op: GitOperation, cwd: string): Promise<void> {
	if (!op.sourceHashes || op.sourceHashes.length === 0) {
		log.warn("Rebase-squash queue entry has no sourceHashes — skipping");
		return;
	}

	const oldSummaries = await loadSourceSummaries(op.sourceHashes, cwd, "Rebase-squash");
	if (oldSummaries.length === 0) {
		log.warn("Rebase-squash: no source summaries found for %s — skipping", op.commitHash.substring(0, 8));
		return;
	}

	const newCommitInfo = await getCommitInfo(op.commitHash, cwd);
	await runSquashPipeline(oldSummaries, newCommitInfo, cwd, {
		commitType: "squash",
		commitSource: (op.commitSource ?? "cli") as CommitSource,
	});
}

/**
 * Threshold for the pre-LLM amend short-circuit (line count of the delta diff,
 * insertions + deletions).
 *
 * 50 is calibrated to cover most "polish" amends — rename a variable across
 * call sites, fix a typo in several files, add a guard clause, apply a
 * formatter pass, refactor a small helper. Truly substantive method rewrites
 * or new features generally exceed 50 lines and still hit the LLM.
 *
 * The transcript artifact is preserved either way, so even when the
 * short-circuit fires during an active AI chat session, the conversation is
 * aggregated in the "All Conversations" view via recursive child walking —
 * no information is lost. Topics/recap stay frozen to the parent commit's
 * values until the next non-amend commit naturally refreshes them.
 */
const TRIVIAL_AMEND_DELTA_LINES = 50;

/**
 * Detects "mechanical-only delta" amends so we can skip the LLM entirely.
 * Examples that should match:
 *   - `git commit --amend --no-edit`
 *   - bumping a version number
 *   - re-signing with GPG
 *   - applying formatter output
 *
 * Transcript entries no longer block the short-circuit: even if the user
 * was chatting with an AI assistant during the amend, the transcript artifact
 * is persisted by the short-circuit path, so the conversation is not lost.
 * Topics/recap on the new root are Copy-Hoisted from the old summary —
 * acceptable because the diff itself is the source of truth for tiny changes.
 */
function isTrivialAmendDelta(deltaStats: DiffStats): boolean {
	const totalLines = deltaStats.insertions + deltaStats.deletions;
	return totalLines <= TRIVIAL_AMEND_DELTA_LINES;
}

/**
 * Hoisted-fields bundle for buildHoistedAmendRoot. The v4 amend root carries
 * topics + recap + ticketId either Copy-Hoisted from the old summary (pre-LLM
 * or post-LLM short-circuit) or LLM-consolidated from [old, delta] (full path).
 *
 * `llm` is only set when the topics/recap actually came from this call (i.e.
 * the consolidate step ran). Both short-circuit paths leave it undefined so
 * the field's "produced this node's data" semantics stay accurate.
 *
 * `transcripts` is the v5 transcript-ID array for the new amend root. Each
 * call site computes it as `[...getTranscriptIds(oldSummary), ...maybeDelta]`
 * — inherited IDs plus the newly written delta's ID if amend captured new
 * sessions. Short-circuit paths that don't write a delta pass only inherited.
 */
interface AmendHoistedFields {
	readonly topics: ReadonlyArray<TopicSummary>;
	readonly recap?: string;
	readonly ticketId?: string;
	readonly llm?: import("../Types.js").LlmCallMetadata;
	/**
	 * Set when the amend pipeline took a degraded path (step 1 LLM failure
	 * → Copy-Hoist with marker, or step 2 consolidate llm-error → mechanical
	 * with marker). Surfaces the webview banner on the new amend root.
	 */
	readonly summaryError?: import("../Types.js").SummaryErrorKind;
	readonly transcripts: ReadonlyArray<string>;
}

/**
 * Builds the v4 amend root with all 8 Hoist fields populated and the old
 * summary attached as a stripped child. Used by all three amend paths
 * (pre-LLM short-circuit, post-LLM short-circuit, full path); the only
 * differences are which `hoisted` values the caller passes in and whether
 * they pass a transcript artifact to storeSummary.
 *
 * `oldSummary` is undefined when there's no recorded prior summary (rare:
 * the user amended a commit that was never summarised). In that case the
 * new root is effectively a fresh leaf -- still v4, no children, no Hoist
 * source -- and `hoisted` is whatever the caller derived from delta alone.
 */
function buildHoistedAmendRoot(
	// All three call sites are gated on `if (oldSummary)` so a non-undefined
	// summary is invariant here. Tightening the parameter removes a layer
	// of dead defensive branches.
	oldSummary: CommitSummary,
	newInfo: CommitInfo,
	hoisted: AmendHoistedFields,
	metadata: { readonly commitType?: CommitType; readonly commitSource?: CommitSource },
	fullDiffStats: DiffStats,
	stats?: { readonly transcriptEntries?: number; readonly conversationTurns?: number },
): CommitSummary {
	return {
		version: CURRENT_SCHEMA_VERSION,
		commitHash: newInfo.hash,
		commitMessage: newInfo.message,
		commitAuthor: newInfo.author,
		commitDate: new Date(newInfo.date).toISOString(),
		branch: oldSummary.branch,
		generatedAt: new Date().toISOString(),
		/* v8 ignore start -- optional-field spreads: each `... && {...}` is
		 * a 2-arm branch (include / omit). Both arms are valid serialization
		 * outcomes covered by spec, not a logical conditional. Marking dead
		 * keeps the coverage signal focused on real bugs. */
		...(metadata.commitType && { commitType: metadata.commitType }),
		...(metadata.commitSource && { commitSource: metadata.commitSource }),
		...(hoisted.ticketId && { ticketId: hoisted.ticketId }),
		...(hoisted.llm && { llm: hoisted.llm }),
		...(stats?.transcriptEntries !== undefined && { transcriptEntries: stats.transcriptEntries }),
		...(stats?.conversationTurns !== undefined && { conversationTurns: stats.conversationTurns }),
		...(hoisted.summaryError && { summaryError: hoisted.summaryError }),
		/* v8 ignore stop */
		...hoistMetadataFromOldSummary(oldSummary),
		topics: hoisted.topics,
		/* v8 ignore next */
		...(hoisted.recap && { recap: hoisted.recap }),
		// v5 contract: always present, even if empty (see executePipeline note).
		transcripts: hoisted.transcripts,
		diffStats: fullDiffStats,
		children: [stripFunctionalMetadata(oldSummary)],
	};
}

/**
 * Short-circuit writer: Copy-Hoists topics/recap/ticketId from oldSummary to a
 * new amend root, and persists the transcript artifact if any sessions exist.
 * Shared by both short-circuit callers in handleAmendPipeline:
 *   - **Pre-LLM**: delta ≤ TRIVIAL_AMEND_DELTA_LINES (no LLM ran)
 *   - **Post-LLM**: step 1 summarize(delta) returned empty topics (step 2 skipped)
 *
 * `label` is only used for logging — it distinguishes the two call sites in the
 * debug.log so a triage can tell which short-circuit fired.
 *
 * The transcript artifact is written unconditionally when sessions are present:
 * "All Conversations" view walks children recursively, so even though topics/recap
 * are Copy-Hoisted (frozen at the old commit's state), the per-commit transcript
 * file ensures the actual conversation is still aggregated into the view.
 */
async function applyAmendShortCircuit(
	oldSummary: CommitSummary,
	commitInfo: CommitInfo,
	metadata: { readonly commitType?: CommitType; readonly commitSource?: CommitSource } | undefined,
	amendFullDiffStats: DiffStats,
	// v5: the caller hoists transcript-artifact construction so the same delta
	// ID can be stamped on both the stored artifact and the new root's
	// `transcripts` field. `amendTranscripts` already contains the inherited
	// IDs plus the new delta's ID when one exists — see the call sites where
	// they're computed once and shared across the short-circuit + full path.
	transcriptArtifact: { readonly id: string; readonly data: StoredTranscript } | undefined,
	amendTranscripts: ReadonlyArray<string>,
	totalEntries: number,
	humanEntries: number,
	cwd: string,
	pipelineStart: number,
	oldHash: string,
	label: string,
	markError: boolean,
): Promise<void> {
	const root = buildHoistedAmendRoot(
		oldSummary,
		commitInfo,
		{
			topics: resolveEffectiveTopics(oldSummary),
			/* v8 ignore start -- optional-field spreads (see buildHoistedAmendRoot) */
			...(oldSummary.recap !== undefined && { recap: oldSummary.recap }),
			...(oldSummary.ticketId !== undefined && { ticketId: oldSummary.ticketId }),
			/* v8 ignore stop */
			// llm: undefined -- topics/recap came from old, not from delta
			...(markError && { summaryError: LLM_FAILED }),
			transcripts: amendTranscripts,
		},
		metadata ?? {},
		amendFullDiffStats,
		{ transcriptEntries: totalEntries, conversationTurns: humanEntries },
	);

	await storeSummary(root, cwd, false, transcriptArtifact ? { transcript: transcriptArtifact } : undefined);
	await reassociateMetadata([oldSummary], commitInfo.hash, cwd);
	log.info(
		"Amend short-circuit (%s) complete: %s -> %s (%s)",
		label,
		oldHash.substring(0, 8),
		commitInfo.hash.substring(0, 8),
		formatElapsed(pipelineStart),
	);
}

/**
 * Handles amend queue entries via two-tier dispatch:
 *
 *   - **Short-circuit** (0 or 1 LLM): either delta ≤ TRIVIAL_AMEND_DELTA_LINES
 *     (skip both LLM calls) OR step 1 returned empty topics (skip step 2).
 *     Topics/recap/ticketId are Copy-Hoisted from oldSummary; the transcript
 *     artifact is written if any sessions exist. Implemented by
 *     applyAmendShortCircuit.
 *   - **Full path** (2 LLM): summarize(delta) + consolidate([old, delta]) ->
 *     LLM-produced topics/recap (or mechanicalConsolidate fallback), with
 *     transcript artifact.
 *
 * Both paths converge on buildHoistedAmendRoot + storeSummary, so the
 * Hoist invariant always completes regardless of which dispatch tier ran.
 *
 * Called by both scenarios:
 *   - Scenario 2: lock was free; commitInfo is the amended commit (HEAD)
 *   - Scenario 1: lock was held; commitInfo is the new commit (derived from
 *     HEAD after Worker finishes)
 */
async function handleAmendPipeline(
	commitInfo: CommitInfo,
	oldHash: string,
	cwd: string,
	pipelineStart: number,
	diffOverride?: { readonly fromRef: string; readonly toRef: string },
	metadata?: { readonly commitType?: CommitType; readonly commitSource?: CommitSource },
	beforeTimestamp?: string,
): Promise<void> {
	// Load old summary (may not exist if the original commit had no LLM summary).
	const oldSummary = await getSummary(oldHash, cwd);
	if (oldSummary) {
		log.info("Loaded old summary for %s", oldHash.substring(0, 8));
	} else {
		log.info("No old summary found for %s — will create fresh summary for amended commit", oldHash.substring(0, 8));
	}

	// Load sessions and read transcripts with time cutoff. Excluded conversations are
	// filtered inside `loadSessionTranscripts` BEFORE any cursor advance — keep the
	// plans/notes exclusion read here, but no `sessionTranscripts.filter` step is needed.
	const amendConfig = await loadConfig();
	const amendExclusions = await readExclusions(cwd);
	const { sessionTranscripts, totalEntries, humanEntries } = await loadSessionTranscripts(
		cwd,
		amendConfig,
		beforeTimestamp,
	);

	// Get git diff and stats. diffOverride (Scenario 1) provides oldHash->newHash
	// (the actual amend delta); default HEAD~1..HEAD is the full amended diff.
	let stepStart = now();
	let deltaDiff: string;
	let deltaDiffStats: DiffStats;
	let diffFetchFailed = false;
	const fromRef = diffOverride?.fromRef ?? "HEAD~1";
	const toRef = diffOverride?.toRef ?? "HEAD";
	try {
		deltaDiff = await getDiffContent(fromRef, toRef, cwd);
		deltaDiffStats = await getDiffStats(fromRef, toRef, cwd);
	} catch {
		log.warn("Could not diff %s..%s, using empty diff", fromRef, toRef);
		deltaDiff = "(Could not compute diff)";
		deltaDiffStats = { filesChanged: 0, insertions: 0, deletions: 0 };
		diffFetchFailed = true;
	}
	log.info(
		"Amend delta diff (%s..%s): %d files changed, +%d -%d (%s)",
		fromRef.substring(0, 8),
		toRef.substring(0, 8),
		deltaDiffStats.filesChanged,
		deltaDiffStats.insertions,
		deltaDiffStats.deletions,
		formatElapsed(stepStart),
	);

	// Compute the amend commit's FULL diff (git diff {newHash}^..{newHash}) for
	// persisted `diffStats`. In Scenario 1 (diffOverride = oldHash..newHash) the
	// delta diff is NOT the full commit diff. In Scenario 2 (default HEAD~1..HEAD)
	// they're equal so we skip the extra git call.
	const amendFullDiffStats: DiffStats = diffOverride
		? await getDiffStats(`${commitInfo.hash}^`, commitInfo.hash, cwd).catch(
				(): DiffStats => ({ filesChanged: 0, insertions: 0, deletions: 0 }),
			)
		: deltaDiffStats;

	// Persist the conversation regardless of which path we take from here.
	// Overlays are applied inside loadSessionTranscripts so this just packages
	// them for storage. Allocate a v5 transcript ID for the delta upfront so
	// every short-circuit can stamp it onto `summary.transcripts` consistently.
	const amendStoredTranscript = buildStoredTranscript(sessionTranscripts);
	const amendDeltaTranscriptId = amendStoredTranscript.sessions.length > 0 ? generateTranscriptId() : undefined;
	const transcriptArtifact =
		amendDeltaTranscriptId !== undefined ? { id: amendDeltaTranscriptId, data: amendStoredTranscript } : undefined;
	// IDs that survive into the new amend root: inherited from old + new delta
	// when one exists. For legacy (v3/v4) `oldSummary`, derive via the
	// children-tree walk but FILTER to IDs that actually have a transcript file
	// — mirrors migrateOneToOne/mergeManyToOne (and the v5 migration) so a
	// session-less child commit doesn't bake a dangling ID into the new v5
	// root's authoritative `transcripts` array. v5 input passes through. Empty
	// when oldSummary is undefined (fresh-leaf branch below).
	// v5 `oldSummary` carries an authoritative `transcripts` array — pass it
	// through without a file listing. Only legacy (v3/v4) input needs the
	// children-tree walk filtered against on-disk transcript files, so we fetch
	// `getTranscriptHashes` lazily in that branch alone.
	let inheritedAmendIds: ReadonlyArray<string> = [];
	if (oldSummary) {
		inheritedAmendIds =
			oldSummary.transcripts !== undefined
				? oldSummary.transcripts
				: resolveTranscriptIdsFiltered(oldSummary, await getTranscriptHashes(cwd));
	}
	const amendTranscripts: ReadonlyArray<string> =
		amendDeltaTranscriptId !== undefined ? [...inheritedAmendIds, amendDeltaTranscriptId] : inheritedAmendIds;

	// ── Pre-LLM short-circuit: delta ≤ TRIVIAL_AMEND_DELTA_LINES (0 LLM) ──────
	// When diff fetch failed, the fallback `deltaDiffStats = {0, 0, 0}` would
	// otherwise spuriously trigger the short-circuit and silently drop the
	// LLM-via-conversation fallback. Require a successful diff fetch.
	if (oldSummary && !diffFetchFailed && isTrivialAmendDelta(deltaDiffStats)) {
		log.info(
			"Amend short-circuit (pre-LLM): trivial delta ≤ %d -- skipping both LLM calls",
			TRIVIAL_AMEND_DELTA_LINES,
		);
		// Inherit oldSummary's marker so a trivial amend on top of a previously-
		// failed commit doesn't silently heal the banner: this short-circuit
		// didn't run the LLM at all, so any prior failure is still unresolved.
		// A successful Regenerate is the only legitimate way to clear the marker.
		await applyAmendShortCircuit(
			oldSummary,
			commitInfo,
			metadata,
			amendFullDiffStats,
			transcriptArtifact,
			amendTranscripts,
			totalEntries,
			humanEntries,
			cwd,
			pipelineStart,
			oldHash,
			"pre-LLM trivial delta",
			isSummaryError(oldSummary),
		);
		return;
	}

	// No old summary AND trivial delta AND no conversation -- nothing useful to record.
	// The `totalEntries === 0` guard is critical: without it, an amend that has a small
	// diff but recorded an AI conversation would silently drop the transcript, because
	// applyAmendShortCircuit requires an oldSummary for Copy-Hoist and isn't reachable
	// here. When transcript entries exist we fall through to step1 LLM and the
	// "no old summary -> fresh leaf" branch below, which persists the transcript artifact.
	if (!oldSummary && !diffFetchFailed && totalEntries === 0 && isTrivialAmendDelta(deltaDiffStats)) {
		log.info("Amend with no old summary AND no sessions AND trivial delta -- skipping");
		return;
	}

	// No old summary AND diff fetch failed -- feeding "(Could not compute diff)" to
	// the LLM produces low-quality topics, and the fresh leaf's diffStats may also
	// have fallen back to {0,0,0}. No parent context, no real diff: nothing useful
	// to summarise. Skip rather than persist a misleading summary.
	if (!oldSummary && diffFetchFailed) {
		log.info("Amend with no old summary AND diff fetch failed -- skipping (no meaningful summary possible)");
		return;
	}

	// ── Step 1 LLM: summarize the delta ───────────────────────────────────────
	const conversation = buildMultiSessionContext(sessionTranscripts);
	stepStart = now();

	// Same registry-driven prompt assembly as executePipeline (see Stage 2 wiring).
	/* v8 ignore start -- amend-pipeline prompt-block assembly mirrors executePipeline's Stage 2 path. The amend path is exercised via PostCommitHook.helpers tests but not the prompt-block content specifically; the helpers and shapes are covered by their own dedicated tests. */
	const branchForBlocks = await getCurrentBranch(cwd);
	const [rawAmendPlanEntries, rawAmendNoteEntries, rawAmendReferenceEntries] = await Promise.all([
		detectActivePlansForBranch(cwd, branchForBlocks),
		detectActiveNotesForBranch(cwd, branchForBlocks),
		getReferenceEntriesForBranch(cwd, branchForBlocks),
	]);
	const amendPlanEntries = rawAmendPlanEntries.filter((p) => !amendExclusions.plans.has(p.slug));
	const amendNoteEntries = rawAmendNoteEntries.filter((n) => !amendExclusions.notes.has(n.id));
	// Mirror plans/notes: drop user-deselected references from the amend prompt so
	// the LLM regenerates the recap without referring to references the user
	// removed via the sidebar checkboxes. Without this filter the amend path
	// re-introduces the reference into the summary even after the user unchecked it.
	const amendReferenceEntries = rawAmendReferenceEntries.filter(
		(e) => !amendExclusions.references.has(`${e.source}:${e.nativeId}`),
	);
	const amendPlansBlock = await formatPlansBlock(amendPlanEntries);
	const amendNotesBlock = await formatNotesBlock(amendNoteEntries);
	const amendReferenceBlocks = await assembleReferenceBlocks(amendReferenceEntries);
	/* v8 ignore stop */

	const summaryParams = {
		conversation,
		diff: deltaDiff,
		commitInfo,
		diffStats: deltaDiffStats,
		transcriptEntries: totalEntries,
		conversationTurns: humanEntries,
		referenceBlocks: amendReferenceBlocks,
		plans: amendPlansBlock,
		notes: amendNotesBlock,
		config: amendConfig,
	};

	let delta: Awaited<ReturnType<typeof generateSummary>>;
	// `deltaLlmFailed` flips to true when both step-1 attempts threw. The pipeline
	// continues with an empty-delta placeholder so the commit gets a summary on
	// the orphan branch (Copy-Hoist via short-circuit when an old summary exists,
	// fresh leaf otherwise); the marker drives the webview banner.
	let deltaLlmFailed = false;
	try {
		delta = await generateSummary(summaryParams);
	} catch (error: unknown) {
		log.warn("First API attempt failed: %s. Retrying in %dms...", (error as Error).message, RETRY_DELAY_MS);
		await delay(RETRY_DELAY_MS);
		try {
			delta = await generateSummary(summaryParams);
		} catch (retryError: unknown) {
			log.error("API call failed after retry: %s", (retryError as Error).message);
			log.warn(
				"Persisting amend summary for %s with summaryError marker so the commit is not silently dropped",
				commitInfo.hash.substring(0, 8),
			);
			deltaLlmFailed = true;
			delta = {
				transcriptEntries: totalEntries,
				conversationTurns: humanEntries,
				llm: {
					model: amendConfig.model ?? "unknown",
					inputTokens: 0,
					outputTokens: 0,
					apiLatencyMs: 0,
					stopReason: "error",
				},
				stats: deltaDiffStats,
				topics: [],
			};
		}
	}
	log.info("Amend step 1 (delta summary) generated (%s)", formatElapsed(stepStart));

	// ── Post-LLM short-circuit: step1 returned empty topics → skip step2 ──────
	// delta.recap is discarded even if present: a recap without topics is just a
	// restatement of the diff, and the diff is the source of truth.
	// Also taken when step-1 LLM failed (deltaLlmFailed=true) so the failure
	// surfaces with Copy-Hoisted topics + marker, never as a missing summary.
	/* v8 ignore next -- defensive `?? 0` fallback: generateSummary always returns topics: ReadonlyArray<TopicSummary> per its return type, so `delta.topics === undefined` is unreachable; the optional-chain + ?? guard is total-function discipline. */
	if (oldSummary && (delta.topics?.length ?? 0) === 0) {
		log.info(
			"Amend short-circuit (post-LLM): step1 %s -- skipping step2 consolidate",
			deltaLlmFailed ? "LLM failed" : "returned empty topics",
		);
		// Inherit oldSummary's marker when step-1 succeeded but produced no topics:
		// we Copy-Hoist the old root and step-2 never ran, so a previously-
		// unresolved failure is still unresolved. `deltaLlmFailed` covers the
		// other case (step-1 itself failed) explicitly.
		await applyAmendShortCircuit(
			oldSummary,
			commitInfo,
			metadata,
			amendFullDiffStats,
			transcriptArtifact,
			amendTranscripts,
			totalEntries,
			humanEntries,
			cwd,
			pipelineStart,
			oldHash,
			deltaLlmFailed ? "post-LLM error fallback" : "post-LLM empty topics",
			deltaLlmFailed || isSummaryError(oldSummary),
		);
		return;
	}

	// ── Full path: oldSummary exists with non-empty delta -> step 2 consolidate ──
	if (oldSummary) {
		const deltaSource: SquashConsolidationSource = {
			commitHash: commitInfo.hash,
			commitDate: new Date(commitInfo.date).toISOString(),
			// commitMessage gets rendered as the "Message:" line in sourceCommitsBlock.
			// Use a label that signals "this is the amend delta in context" rather
			// than the bare squash commit message.
			commitMessage: `(amend delta of ${oldSummary.commitMessage})`,
			/* v8 ignore next */
			...(delta.ticketId !== undefined && { ticketId: delta.ticketId }),
			topics: delta.topics,
			/* v8 ignore next */
			...(delta.recap !== undefined && { recap: delta.recap }),
		};
		const sources: ReadonlyArray<SquashConsolidationSource> = [
			...expandSourcesForConsolidation(oldSummary),
			deltaSource,
		];
		const outerTicketId = oldSummary.ticketId ?? delta.ticketId;

		stepStart = now();
		let consolidated: ConsolidatedTopics | null;
		let consolidateLlmFailed = false;
		try {
			const outcome = await generateSquashConsolidation({
				squashCommitMessage: commitInfo.message,
				/* v8 ignore next */
				...(outerTicketId !== undefined && { ticketId: outerTicketId }),
				sources,
				config: amendConfig,
			});
			if (outcome.status === "ok") {
				consolidated = {
					topics: outcome.topics,
					/* v8 ignore start -- optional-field spreads */
					...(outcome.recap !== undefined && { recap: outcome.recap }),
					...(outcome.ticketId !== undefined && { ticketId: outcome.ticketId }),
					/* v8 ignore stop */
					llm: outcome.llm,
				};
			} else {
				consolidated = null;
				/* v8 ignore start -- "no-content" leaves marker unset; "llm-error" trips it. */
				if (outcome.status === "llm-error") consolidateLlmFailed = true;
				/* v8 ignore stop */
			}
			/* v8 ignore start -- defensive: generateSquashConsolidation handles its own LLM throws internally, so this catch only fires on unexpected runtime errors (e.g. loadConfig threw before the call). Treat as llm-error so banner surfaces. */
		} catch (err) {
			log.warn(
				"Amend step 2 (consolidate) failed (runtime): %s -- falling back to mechanical merge",
				errMsg(err),
			);
			consolidated = null;
			consolidateLlmFailed = true;
		}
		/* v8 ignore stop */
		const finalConsolidated: ConsolidatedTopics = consolidated ?? mechanicalConsolidate(sources, outerTicketId);
		/* v8 ignore start -- log formatting (succeeded vs fell-back ternary); both arms are covered by Summarizer's own tests, not the QueueWorker dispatch. */
		log.info(
			"Amend step 2 (consolidate) %s (%s)",
			consolidated ? "succeeded" : "fell back to mechanical",
			formatElapsed(stepStart),
		);
		/* v8 ignore stop */

		const root = buildHoistedAmendRoot(
			oldSummary,
			commitInfo,
			{
				topics: finalConsolidated.topics,
				/* v8 ignore start -- optional-field spreads (see buildHoistedAmendRoot) */
				...(finalConsolidated.recap !== undefined && { recap: finalConsolidated.recap }),
				...(finalConsolidated.ticketId !== undefined && { ticketId: finalConsolidated.ticketId }),
				// Only include llm metadata when consolidation actually called the LLM.
				...(consolidated?.llm && { llm: consolidated.llm }),
				// Inherit oldSummary's degraded state even when step-2 consolidate
				// succeeded: consolidate merges existing topic structures, it does
				// NOT re-derive from raw diff + transcript like Regenerator does.
				// If oldSummary was a placeholder / Copy-Hoist / mechanical merge
				// from a prior failure, the consolidated output is "delta + degraded
				// old", not "regenerated". Only a true Regenerate clears the marker.
				...((consolidateLlmFailed || isSummaryError(oldSummary)) && { summaryError: LLM_FAILED }),
				/* v8 ignore stop */
				transcripts: amendTranscripts,
			},
			metadata ?? {},
			amendFullDiffStats,
			{ transcriptEntries: totalEntries, conversationTurns: humanEntries },
		);
		await storeSummary(
			root,
			cwd,
			false,
			/* v8 ignore next -- defensive: transcriptArtifact is set when sessions exist; falsy arm only fires when there are no sessions, which the empty-transcript guard upstream already short-circuits. */ transcriptArtifact
				? { transcript: transcriptArtifact }
				: undefined,
		);
		await reassociateMetadata([oldSummary], commitInfo.hash, cwd);
		log.info("=== Amend full path completed in %s ===", formatElapsed(pipelineStart));
		log.info("=== Summary content (%d topics) ===", finalConsolidated.topics.length);
		for (const topic of finalConsolidated.topics) {
			log.info("Topic: %s", topic.title);
		}
		return;
	}

	// ── No old summary AND non-trivial delta -> store delta as a fresh leaf ────
	const branch = await getCurrentBranch(cwd);

	// Associate plans/notes/references on the branch with this amend commit,
	// mirroring executePipeline. Without this the fresh leaf silently drops
	// references for plans/notes authored before the previous (un-summarised)
	// commit — the user wouldn't see them in plan-progress aggregation or
	// reverse-lookups. The oldSummary path handles this via reassociateMetadata;
	// fresh leaves have no oldSummary to migrate from, so we associate fresh.
	const freshLeafPlanSlugs = await detectPlanSlugsFromRegistry(cwd, branch);
	for (const excludedSlug of amendExclusions.plans) freshLeafPlanSlugs.delete(excludedSlug);
	const freshLeafPlanAssoc = await associatePlansWithCommit(freshLeafPlanSlugs, commitInfo.hash, cwd, branch);
	const freshLeafPlanRefs = freshLeafPlanAssoc.refs;

	const freshLeafNoteIds = await detectUncommittedNoteIds(cwd, branch);
	for (const excludedId of amendExclusions.notes) freshLeafNoteIds.delete(excludedId);
	const freshLeafNoteRefs = await associateNotesWithCommit(freshLeafNoteIds, commitInfo.hash, cwd, branch);

	const rawFreshLeafReferenceIds = await detectUncommittedReferenceIds(cwd, branch);
	// Mirror plans/notes: honour user deselections from the sidebar so the
	// amend fresh-leaf doesn't silently re-archive references the user removed.
	const freshLeafReferenceIds = rawFreshLeafReferenceIds.filter((e) => !amendExclusions.references.has(e.mapKey));
	const {
		refs: freshLeafReferenceRefs,
		filesToStore: freshLeafReferenceFiles,
		committed: freshLeafReferenceCommitted,
	} = await associateReferencesWithCommit(freshLeafReferenceIds, commitInfo.hash, cwd, branch);
	// CRITICAL: the generic associateReferencesWithCommit does NOT call
	// storeReferences itself (unlike the legacy Linear-only path which was
	// self-contained). The amend fresh-leaf path MUST explicitly drive the
	// orphan-branch write — otherwise Regenerator can't read back the
	// archived markdown at recall time. Write-ahead: store first, then finalize
	// the local-state teardown (so a store failure leaves the rows recoverable).
	/* v8 ignore start -- amend fresh-leaf reference-files write path: only hit when a `git commit --amend` lands without an existing summary AND active references exist on the branch. Both arms (files-present vs files-absent) are tested mechanically through the StopHook → PostCommit happy path; this defensive branch in the amend-only fresh-leaf code path is reachable only via a race (StopHook upserted between detect and commit), and that race resolves the same way either way. */
	if (freshLeafReferenceFiles.length > 0) {
		await storeReferences(
			freshLeafReferenceFiles,
			`Archive ${freshLeafReferenceFiles.length} reference ref(s) for amend ${commitInfo.hash.substring(0, 8)}`,
			cwd,
			branch,
		);
		await finalizeReferenceArchive(freshLeafReferenceCommitted, cwd);
	}
	/* v8 ignore stop */

	const freshLeaf: CommitSummary = {
		version: CURRENT_SCHEMA_VERSION,
		commitHash: commitInfo.hash,
		commitMessage: commitInfo.message,
		commitAuthor: commitInfo.author,
		commitDate: new Date(commitInfo.date).toISOString(),
		branch,
		generatedAt: new Date().toISOString(),
		...(metadata?.commitType && { commitType: metadata.commitType }),
		...(metadata?.commitSource && { commitSource: metadata.commitSource }),
		...delta,
		diffStats: amendFullDiffStats,
		...(deltaLlmFailed && { summaryError: LLM_FAILED }),
		...(freshLeafPlanRefs.length > 0 ? { plans: freshLeafPlanRefs } : {}),
		...(freshLeafNoteRefs.length > 0 ? { notes: freshLeafNoteRefs } : {}),
		/* v8 ignore start -- amend fresh-leaf references spread: same race-only path as the reference-files write above; truthy arm only fires when active references are present on the branch at amend time, which the StopHook → PostCommit happy path exercises elsewhere. */
		...(freshLeafReferenceRefs.length > 0 ? { references: freshLeafReferenceRefs } : {}),
		/* v8 ignore stop */
		// v5 contract: always present, even if empty. Fresh leaf has no
		// inherited IDs; only the new delta (if any).
		transcripts: amendDeltaTranscriptId !== undefined ? [amendDeltaTranscriptId] : [],
	};
	await storeSummary(
		freshLeaf,
		cwd,
		false,
		/* v8 ignore next -- defensive: transcriptArtifact is set when sessions exist; falsy arm only fires when there are no sessions, which the empty-transcript guard upstream already short-circuits. */ transcriptArtifact
			? { transcript: transcriptArtifact }
			: undefined,
	);
	log.info(
		"Amend with no old summary -> stored as fresh leaf for %s (%s)",
		commitInfo.hash.substring(0, 8),
		formatElapsed(pipelineStart),
	);
}

/**
 * Loads all active sessions (Claude + Codex + Gemini) and reads their transcripts
 * with an optional time cutoff for queue-driven attribution.
 *
 * This is the shared entry point for transcript loading used by both the normal
 * commit pipeline and the amend pipeline. Extracting it avoids duplicating the
 * session discovery + Codex scan + transcript reading logic.
 *
 * @param cwd - Working directory
 * @param config - Loaded Jolli Memory config (for integration filters and Codex toggle)
 * @param beforeTimestamp - Optional ISO 8601 cutoff for transcript time-based attribution
 */
async function loadSessionTranscripts(
	cwd: string,
	config: JolliMemoryConfig,
	beforeTimestamp?: string,
): Promise<{
	allSessions: ReadonlyArray<{ sessionId: string; transcriptPath: string; source?: TranscriptSource }>;
	sessionTranscripts: SessionTranscript[];
	totalEntries: number;
	humanEntries: number;
}> {
	const trackedSessions = filterSessionsByEnabledIntegrations(await loadAllSessions(cwd), config);

	let allSessions = trackedSessions;
	if (config.codexEnabled !== false && (await isCodexInstalled())) {
		const codexSessions = await discoverCodexSessions(cwd);
		if (codexSessions.length > 0) {
			allSessions = [...allSessions, ...codexSessions];
			log.info("Discovered %d Codex session(s)", codexSessions.length);
		}
	}

	// Discover OpenCode sessions (on-demand SQLite scan)
	// OpenCode uses a global DB at ~/.local/share/opencode/opencode.db, scoped by project directory
	if (config.openCodeEnabled !== false && (await isOpenCodeInstalled())) {
		const openCodeSessions = await discoverOpenCodeSessions(cwd);
		if (openCodeSessions.length > 0) {
			allSessions = [...allSessions, ...openCodeSessions];
			log.info("Discovered %d OpenCode session(s)", openCodeSessions.length);
		}
	}

	// Discover Cursor Composer sessions (on-demand SQLite scan from globalStorage)
	if (config.cursorEnabled !== false && (await isCursorInstalled())) {
		const cursorSessions = await discoverCursorSessions(cwd);
		if (cursorSessions.length > 0) {
			allSessions = [...allSessions, ...cursorSessions];
			log.info("Discovered %d Cursor session(s)", cursorSessions.length);
		}
	}

	// Discover Copilot CLI sessions (on-demand SQLite scan).
	if (config.copilotEnabled !== false && (await isCopilotInstalled())) {
		const copilotSessions = await discoverCopilotSessions(cwd);
		if (copilotSessions.length > 0) {
			allSessions = [...allSessions, ...copilotSessions];
			log.info("Discovered %d Copilot session(s)", copilotSessions.length);
		}
	}

	// Discover Copilot Chat sessions (on-demand JSONL scan in vscode workspaceStorage).
	// Shares copilotEnabled with the CLI source (one user-facing toggle for "GitHub Copilot").
	if (config.copilotEnabled !== false && (await isCopilotChatInstalled())) {
		const chatSessions = await discoverCopilotChatSessions(cwd);
		/* v8 ignore start -- chatSessions discovery is mocked to [] in the test fixture so the >0 path isn't reachable here; the discoverer's own tests cover the populated case. */
		if (chatSessions.length > 0) {
			allSessions = [...allSessions, ...chatSessions];
			log.info("Discovered %d Copilot Chat session(s)", chatSessions.length);
		}
		/* v8 ignore stop */
	}

	if (allSessions.length === 0) {
		log.info("No active sessions found — will infer topics from diff if available");
	}

	// Drop sessions the user unchecked in the sidebar BEFORE reading transcripts.
	// Reading advances per-transcript cursors via `saveCursor`, and the sidebar's
	// active-conversations list uses `messageCount > 0` (unread = cursor → EOF)
	// to decide whether to render a row — so any cursor advance silently removes
	// the row on the next 60-second refresh. That regression made *unchecked*
	// conversations disappear alongside the committed ones after every commit;
	// excluding here keeps them visible with the unchecked box, as the per-item
	// selection design spec requires ("excluded items stay visible so the user
	// knows the item exists and can put it back in").
	const conversationExclusions = (await readExclusions(cwd)).conversations;
	const includedSessions = allSessions.filter(
		(s) => !conversationExclusions.has(conversationKey(s.source ?? "claude", s.sessionId)),
	);

	const raw = await readAllTranscripts(includedSessions, cwd, beforeTimestamp);

	// Apply per-session conversation-edit overlays (panel-authored deletes/edits
	// from ConversationDetailsPanel) BEFORE the values flow into either the
	// summary input or the empty-transcript guard. Without this, the summary
	// would still see content the user removed in the panel and the orphan-
	// branch stored transcript would diverge from the recap that referenced
	// it. Recount totalEntries / humanEntries so the "skip when nothing to
	// summarize" guard also respects overlay-driven removals.
	//
	// Apply does NOT mutate `raw.sessionTranscripts`: it returns a new array
	// with `entries: applyOverlay(s.entries, overlay)` (see
	// ConversationOverlayStore.applyOverlaysToSessions). That means the next
	// step's identity-based GC can keep using `raw.sessionTranscripts` for
	// comparison — original content + original role + original timestamp.
	const sessionTranscripts = (await applyOverlaysToSessions(raw.sessionTranscripts, cwd)) as SessionTranscript[];

	// Cursor-aware overlay GC. Runs AFTER apply so the slice's overlay rules
	// have already taken effect in `sessionTranscripts`; pruning here only
	// drops rules that were just consumed (their `(role, content, timestamp)`
	// identity matches an entry in `raw.sessionTranscripts`, the cursor-
	// trimmed pre-apply slice). Cursor advance already happened inside
	// readAllTranscripts and is decoupled from any downstream success — so
	// the rules dropped here will never apply again no matter what the
	// pipeline does next. GC is fire-and-forget; per-session errors only
	// warn-log.
	await pruneConsumedOverlayRules(raw.sessionTranscripts, cwd);
	let totalEntries = 0;
	let humanEntries = 0;
	for (const s of sessionTranscripts) {
		totalEntries += s.entries.length;
		for (const e of s.entries) {
			if (e.role === "human") humanEntries++;
		}
	}

	return { allSessions, sessionTranscripts, totalEntries, humanEntries };
}

/**
 * Reads transcripts from all active sessions, using per-transcript cursors.
 * Saves updated cursors immediately after reading each transcript.
 *
 * @param beforeTimestamp - Optional ISO 8601 cutoff: only read entries with timestamp <= this value.
 *   Used by the queue-driven Worker to attribute transcript entries to the correct commit.
 *   Each commit's queue entry has a createdAt that acts as the time boundary.
 * @returns Session transcripts with entries and total entry count
 */
async function readAllTranscripts(
	sessions: ReadonlyArray<{ sessionId: string; transcriptPath: string; source?: TranscriptSource }>,
	cwd: string,
	beforeTimestamp?: string,
): Promise<{ sessionTranscripts: SessionTranscript[]; totalEntries: number; humanEntries: number }> {
	const sessionTranscripts: SessionTranscript[] = [];
	let totalEntries = 0;
	let humanEntries = 0;

	for (const session of sessions) {
		const cursor = await loadCursorForTranscript(session.transcriptPath, cwd);
		const startLine = cursor?.lineNumber ?? 0;
		const source = session.source ?? "claude";

		// Gemini, OpenCode, Cursor, and Copilot use dedicated readers (not JSONL line-based parsing).
		// SQLite-backed readers (opencode/cursor/copilot) share the same failure modes —
		// transient lock, corruption, schema drift, DB disappearing between scan and read.
		// Wrap each in try/catch + `continue` so one bad session never abandons the rest of
		// the batch. JSONL readers (gemini/claude) handle their per-line failures internally.
		let result: TranscriptReadResult;
		if (source === "gemini") {
			result = await readGeminiTranscript(session.transcriptPath, cursor, beforeTimestamp);
		} else if (source === "opencode") {
			try {
				result = await readOpenCodeTranscript(session.transcriptPath, cursor, beforeTimestamp);
			} catch (error: unknown) {
				log.error("Skipping OpenCode session %s: %s", session.sessionId, (error as Error).message);
				continue;
			}
		} else if (source === "cursor") {
			try {
				result = await readCursorTranscript(session.transcriptPath, cursor, beforeTimestamp);
			} catch (error: unknown) {
				log.error("Skipping Cursor session %s: %s", session.sessionId, (error as Error).message);
				continue;
			}
		} else if (source === "copilot") {
			try {
				result = await readCopilotTranscript(session.transcriptPath, cursor, beforeTimestamp);
			} catch (error: unknown) {
				log.error("Skipping Copilot session %s: %s", session.sessionId, (error as Error).message);
				continue;
			}
		} else if (source === "copilot-chat") {
			try {
				result = await readCopilotChatTranscript(session.transcriptPath, cursor ?? undefined, beforeTimestamp);
			} catch (error: unknown) {
				log.error("Skipping Copilot Chat session %s: %s", session.sessionId, (error as Error).message);
				continue;
			}
		} else {
			result = await readTranscript(session.transcriptPath, cursor, getParserForSource(source), beforeTimestamp);
		}
		const endLine = result.newCursor.lineNumber;

		if (result.entries.length > 0) {
			sessionTranscripts.push({
				sessionId: session.sessionId,
				transcriptPath: session.transcriptPath,
				source: session.source,
				entries: result.entries,
			});
			totalEntries += result.entries.length;
			humanEntries += result.entries.filter((e) => e.role === "human").length;

			log.info(
				"Transcript source: session=%s, lines=%d→%d, entries=%d",
				session.sessionId,
				startLine,
				endLine,
				result.entries.length,
			);
		}

		// Save cursor immediately for this transcript
		await saveCursor(result.newCursor, cwd);
	}

	return { sessionTranscripts, totalEntries, humanEntries };
}

/**
 * Converts pipeline session transcripts into the StoredTranscript format for
 * orphan-branch persistence.
 *
 * Source / transcriptPath are threaded directly off each `SessionTranscript`
 * rather than looked up in a `Map<sessionId, ...>` against `allSessions` —
 * the earlier Map-based approach would collapse two sessions from different
 * integrations that happened to share an `sessionId`, silently rewriting
 * the later session's metadata onto the earlier one on serialize.
 */
function buildStoredTranscript(sessionTranscripts: ReadonlyArray<SessionTranscript>): StoredTranscript {
	return {
		sessions: sessionTranscripts.map((st) => ({
			sessionId: st.sessionId,
			source: st.source,
			transcriptPath: st.transcriptPath,
			entries: [...st.entries],
		})),
	};
}

/** Exposed for unit tests. */
export const __test__ = {
	detectPlanSlugsFromRegistry,
	detectUncommittedNoteIds,
	hoistMetadataFromOldSummary,
	associatePlansWithCommit,
	finalizeReferenceArchive,
	executePipeline,
	handleAmendPipeline,
	handleSquashFromQueue,
	loadSessionTranscripts,
	buildStoredTranscript,
	processQueueEntry,
	reassociateMetadata,
};

/**
 * Simple promise-based delay.
 */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Script entry point (only when run directly, not when imported) ---
/* v8 ignore start */
function isMainScript(): boolean {
	const scriptPath = fileURLToPath(import.meta.url);
	const argv1 = process.argv[1];
	if (process.env.VITEST || !argv1) return false;

	const resolvedArgv = resolve(argv1);
	const resolvedScript = resolve(scriptPath);
	if (resolvedArgv !== resolvedScript) return false;

	// Only auto-run when the entrypoint itself is QueueWorker.
	const entryName = basename(resolvedArgv).toLowerCase();
	return entryName === "queueworker.js" || entryName === "queueworker.ts";
}

if (isMainScript()) {
	const args = process.argv.slice(2);

	if (args.includes("--worker")) {
		// Worker mode: drain the git operation queue
		const cwdIndex = args.indexOf("--cwd");
		const cwd = cwdIndex >= 0 && args[cwdIndex + 1] ? args[cwdIndex + 1] : process.cwd();

		runWorker(cwd).catch((error: unknown) => {
			console.error("[QueueWorker] Fatal error:", error);
			process.exit(1);
		});
	}
}
/* v8 ignore stop */

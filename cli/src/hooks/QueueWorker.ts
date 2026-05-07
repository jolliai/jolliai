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

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverCodexSessions, isCodexInstalled } from "../core/CodexSessionDiscoverer.js";
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
import { discoverOpenCodeSessions, isOpenCodeInstalled } from "../core/OpenCodeSessionDiscoverer.js";
import { readOpenCodeTranscript } from "../core/OpenCodeTranscriptReader.js";
import { evaluatePlanProgress } from "../core/PlanProgressEvaluator.js";
import {
	acquireLock,
	associateNoteWithCommit,
	associatePlanWithCommit,
	deleteQueueEntry,
	dequeueAllGitOperations,
	filterSessionsByEnabledIntegrations,
	loadAllSessions,
	loadConfig,
	loadCursorForTranscript,
	loadPlansRegistry,
	releaseLock,
	saveCursor,
	savePlansRegistry,
} from "../core/SessionTracker.js";
import { createStorage } from "../core/StorageFactory.js";
import {
	extractTicketIdFromMessage,
	generateSquashConsolidation,
	generateSummary,
	mechanicalConsolidate,
	type SquashConsolidationSource,
} from "../core/Summarizer.js";
import {
	type ConsolidatedTopics,
	expandSourcesForConsolidation,
	getSummary,
	mergeManyToOne,
	migrateOneToOne,
	resolveEffectiveTopics,
	setActiveStorage,
	storeNotes,
	storePlans,
	storeSummary,
	stripFunctionalMetadata,
} from "../core/SummaryStore.js";
import { getParserForSource } from "../core/TranscriptParser.js";
import type { SessionTranscript } from "../core/TranscriptReader.js";
import { buildMultiSessionContext, readTranscript } from "../core/TranscriptReader.js";
import { createLogger, setLogDir, setLogLevel } from "../Logger.js";
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
	StoredTranscript,
	TopicSummary,
	TranscriptReadResult,
	TranscriptSource,
} from "../Types.js";

const log = createLogger("QueueWorker");

/** Delay before retry on API failure (ms) */
const RETRY_DELAY_MS = 2000;

// ─── Shared helpers for plans & notes re-association ─────────────────────────

/**
 * Re-associates plans and notes from old summaries with a new commit hash.
 * Called after squash, rebase-pick, and rebase-squash to update the registry.
 *
 * This is a single function to ensure plans and notes are always handled together.
 * Previously these were separate inline loops, which led to notes being forgotten
 * in some paths (squash, amend) while plans were correctly handled.
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
	}
}

/**
 * Extracts hoisted metadata fields (plans, notes, jolliDoc, orphanedDocIds, e2eTestGuide)
 * from an old summary for inclusion in a new summary root node.
 *
 * Used when building amend/squash summary containers that wrap the old summary as a child.
 * Returns a partial object suitable for spreading into a CommitSummary.
 */
function hoistMetadataFromOldSummary(oldSummary: CommitSummary | null | undefined): Partial<CommitSummary> {
	if (!oldSummary) return {};
	return {
		...(oldSummary.jolliDocId != null && { jolliDocId: oldSummary.jolliDocId }),
		...(oldSummary.jolliDocUrl && { jolliDocUrl: oldSummary.jolliDocUrl }),
		...(oldSummary.orphanedDocIds && { orphanedDocIds: oldSummary.orphanedDocIds }),
		...(oldSummary.plans && { plans: oldSummary.plans }),
		...(oldSummary.notes && { notes: oldSummary.notes }),
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

	const child = spawn(
		process.execPath,
		// --disable-warning silences node:sqlite's ExperimentalWarning during OpenCode
		// scans; it also suppresses any other experimental warnings in this subprocess.
		["--disable-warning=ExperimentalWarning", scriptPath, "--worker", "--cwd", cwd],
		{
			detached: true,
			stdio: "ignore",
			cwd,
			windowsHide: true,
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

	// Create storage provider based on config (orphan/dual-write/folder)
	// Sets module-level override in SummaryStore so all write operations use this provider.
	const storage = await createStorage(cwd, cwd);
	setActiveStorage(storage);

	// Acquire lock to prevent concurrent runs
	const lockAcquired = await acquireLock(cwd);
	if (!lockAcquired) {
		log.warn("Could not acquire lock, another worker may be running. Exiting.");
		return;
	}

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
					await processQueueEntry(op, cwd, force);
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
		await releaseLock(cwd);
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
}

/**
 * Processes a single queue entry based on its type.
 * Called by runWorker() for each entry in the queue.
 */
async function processQueueEntry(op: GitOperation, cwd: string, force: boolean): Promise<void> {
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
 * Reads uncommitted plan slugs from plans.json registry.
 * Plans are discovered by the StopHook at transcript scan time, so the
 * registry is already up-to-date when the post-commit hook runs.
 */
async function detectPlanSlugsFromRegistry(cwd: string): Promise<Set<string>> {
	const registry = await loadPlansRegistry(cwd);
	const slugs = new Set<string>();
	for (const [slug, entry] of Object.entries(registry.plans)) {
		if (entry.commitHash === null && !entry.ignored && !entry.contentHashAtCommit) {
			slugs.add(slug);
		}
	}
	log.info("Plan registry scan: found %d uncommitted slug(s): [%s]", slugs.size, [...slugs].join(", "));
	return slugs;
}

/** Result from associatePlansWithCommit: plan references + raw markdown for progress evaluation */
interface PlanAssociationResult {
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
	const plansDir = join(homedir(), ".claude", "plans");
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
		// Skip if ignored (user removed from list), archived, or already associated
		if (entry.ignored) {
			log.info("Plan association: slug %s is ignored — skipping", slug);
			continue;
		}
		if (entry.contentHashAtCommit) {
			log.info("Plan association: slug %s is a guard entry (already archived) — skipping", slug);
			continue;
		}
		if (entry.commitHash !== null) {
			log.info(
				"Plan association: slug %s already associated with %s — skipping",
				slug,
				entry.commitHash.substring(0, 8),
			);
			continue;
		}

		const planFile = join(plansDir, `${slug}.md`);
		if (!existsSync(planFile)) continue;

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
			editCount: entry.editCount,
			addedAt: entry.addedAt,
			updatedAt: nowStr,
		});

		// Store under new slug in orphan branch
		planFiles.push({ slug: newSlug, content });

		// Retain markdown + original slug for progress evaluation
		markdownBySlug.set(newSlug, content);
		originalSlugBySlug.set(newSlug, slug);

		// Archive in plans.json:
		// 1. Original slug entry becomes guard (contentHashAtCommit for detecting file overwrites)
		// 2. New entry keyed by newSlug (the committed plan)
		const updatedRegistry = await loadPlansRegistry(cwd);
		const guardEntry = {
			...entry,
			commitHash: commitHash,
			contentHashAtCommit: contentHash,
			updatedAt: nowStr,
		};
		const archivedEntry = {
			slug: newSlug,
			title,
			sourcePath: entry.sourcePath,
			addedAt: entry.addedAt,
			updatedAt: nowStr,
			branch: entry.branch,
			commitHash: commitHash,
			editCount: entry.editCount,
		};
		await savePlansRegistry(
			{
				...updatedRegistry,
				plans: {
					...updatedRegistry.plans,
					[slug]: guardEntry,
					[newSlug]: archivedEntry,
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
 * Notes with `commitHash === null` and no `contentHashAtCommit` (not yet archived)
 * are candidates for association with the current commit.
 */
async function detectUncommittedNoteIds(cwd: string): Promise<Set<string>> {
	const registry = await loadPlansRegistry(cwd);
	const ids = new Set<string>();
	for (const [id, entry] of Object.entries(registry.notes ?? {})) {
		if (entry.commitHash === null && !entry.ignored && !entry.contentHashAtCommit) {
			ids.add(id);
		}
	}
	log.info("Note registry scan: found %d uncommitted note(s): [%s]", ids.size, [...ids].join(", "));
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

		// Archive in accumulated notes:
		// 1. Original id entry becomes guard (contentHashAtCommit for detecting file overwrites)
		// 2. New entry keyed by newId (the committed note)
		updatedNotes[id] = {
			...entry,
			commitHash,
			updatedAt: now2,
			contentHashAtCommit: contentHash,
			ignored: undefined,
		};
		updatedNotes[newId] = {
			id: newId,
			title: entry.title,
			format: entry.format,
			sourcePath: entry.sourcePath,
			addedAt: entry.addedAt,
			updatedAt: now2,
			branch: entry.branch,
			commitHash,
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

	// Step 3+4: Load sessions and read transcripts with time cutoff for queue-driven attribution
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

	// Step 7: Call AI to generate summary
	stepStart = now();
	const summaryParams = {
		conversation,
		diff,
		commitInfo,
		diffStats,
		transcriptEntries: totalEntries,
		conversationTurns: humanEntries,
		config,
	};

	let summaryResult: Awaited<ReturnType<typeof generateSummary>>;

	try {
		summaryResult = await generateSummary(summaryParams);
	} catch (error: unknown) {
		log.warn("First API attempt failed: %s. Retrying in %dms...", (error as Error).message, RETRY_DELAY_MS);
		await delay(RETRY_DELAY_MS);

		try {
			summaryResult = await generateSummary(summaryParams);
		} catch (retryError: unknown) {
			// LLM completely unavailable — save a summary with empty topics so the commit
			// still has a record (metadata, diff stats, transcript). This prevents missing
			// source summaries during squash/rebase merges. Topics can be back-filled later
			// via a re-summarize command.
			//
			// Marker fields to distinguish LLM failure from genuinely empty LLM response:
			//   - model: config.model → the model we tried to call (not "none")
			//   - stopReason: "error" → topics are empty due to API failure, not because
			//                           the LLM returned no topics
			// A genuine empty response would have stopReason: "end_turn" and a real model ID.
			log.error("API call failed after retry: %s", (retryError as Error).message);
			log.warn("Saving summary with empty topics for commit %s", commitInfo.hash.substring(0, 8));
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

	// Step 8a: Read uncommitted plan slugs from plans.json registry
	const planSlugs = await detectPlanSlugsFromRegistry(cwd);
	const planAssociation = await associatePlansWithCommit(planSlugs, commitInfo.hash, cwd, branch);
	const planRefs = planAssociation.refs;

	// Step 8a2: Read uncommitted note IDs from plans.json registry
	const noteIds = await detectUncommittedNoteIds(cwd);
	const noteRefs = await associateNotesWithCommit(noteIds, commitInfo.hash, cwd, branch);

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

	// Build the CommitSummary leaf node with top-level fields from the API result.
	// For a leaf, diffStats === stats (both are `git diff {hash}^..{hash}`).
	// Schema v4: unified Hoist -- topics + recap are part of the Hoist family
	// so root is always authoritative. Leaves are the source-of-truth for v4
	// children; later squash/amend operations strip the Hoist fields off this
	// node when it becomes a child of a v4 root.
	const summary: CommitSummary = {
		version: 4,
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
		...(planRefs.length > 0 ? { plans: planRefs } : {}),
		...(noteRefs.length > 0 ? { notes: noteRefs } : {}),
	};

	log.info(
		"Summary built for %s: recap=%s, topics=%d, plans=%s, notes=%s",
		commitInfo.hash.substring(0, 8),
		summary.recap ? "yes" : "no",
		summary.topics?.length ?? 0,
		summary.plans ? `${summary.plans.length} ref(s): [${summary.plans.map((p) => p.slug).join(", ")}]` : "absent",
		summary.notes ? `${summary.notes.length} ref(s): [${summary.notes.map((n) => n.id).join(", ")}]` : "absent",
	);

	// Step 8c: Build StoredTranscript from session transcripts for persistence
	const storedTranscript = buildStoredTranscript(sessionTranscripts);

	// Step 8d: Store summary (+ transcript + plan progress) in orphan branch
	// Pass `force` so manual re-summarize can overwrite a previously failed entry.
	stepStart = now();
	await storeSummary(summary, cwd, force, {
		transcript: storedTranscript,
		...(planProgressArtifacts.length > 0 ? { planProgress: planProgressArtifacts } : {}),
	});
	log.info(
		"Summary stored successfully for commit %s (%s, %d plans, %d notes)",
		commitInfo.hash.substring(0, 8),
		formatElapsed(stepStart),
		planRefs.length,
		noteRefs.length,
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

	let consolidated: ConsolidatedTopics & { status: "llm" | "mechanical" };

	try {
		const config = await loadConfig();
		const result = await generateSquashConsolidation({
			squashCommitMessage: commitInfo.message,
			...(outerTicketId !== undefined && { ticketId: outerTicketId }),
			sources,
			config,
		});
		if (result) {
			consolidated = { ...result, status: "llm" };
		} else {
			// No content / repeated LLM failure: mechanical fallback preserves source
			// content so the Hoist root is never hollow.
			consolidated = { ...mechanicalConsolidate(sources, outerTicketId), status: "mechanical" };
		}
	} catch (err) {
		log.warn("Squash consolidation LLM failed, using mechanical merge: %s", (err as Error).message);
		consolidated = { ...mechanicalConsolidate(sources, outerTicketId), status: "mechanical" };
	}

	log.info(
		"Squash consolidation for %s: sources=%d, topics %d → %d, recap=%s, status=%s",
		commitInfo.hash.substring(0, 8),
		sources.length,
		sources.reduce((n, s) => n + s.topics.length, 0),
		consolidated.topics.length,
		consolidated.recap ? "yes" : "no",
		consolidated.status,
	);

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
 * Threshold for the trivial-amend short-circuit A (line count of the delta diff).
 * 10 is intentionally conservative -- prefer running the LLM (false negative)
 * over silently skipping a substantive change (false positive).
 */
const TRIVIAL_AMEND_DELTA_LINES = 10;

/**
 * Detects "no real conversation, mechanical-only delta" amends so we can skip
 * the LLM entirely. Examples that should match:
 *   - `git commit --amend --no-edit`
 *   - bumping a version number
 *   - re-signing with GPG
 *   - applying formatter output
 *
 * Conservative by design: any captured conversation, OR any delta beyond the
 * line threshold (regardless of whitespace), forces the full pipeline. False
 * positives here would silently drop new amend information.
 */
function isTrivialAmendDelta(deltaStats: DiffStats, transcriptEntries: number): boolean {
	if (transcriptEntries > 0) return false;
	const totalLines = deltaStats.insertions + deltaStats.deletions;
	return totalLines <= TRIVIAL_AMEND_DELTA_LINES;
}

/**
 * Hoisted-fields bundle for buildHoistedAmendRoot. The v4 amend root carries
 * topics + recap + ticketId either Copy-Hoisted from the old summary (short
 * circuit A/B) or LLM-consolidated from [old, delta] (full path).
 *
 * `llm` is only set when the topics/recap actually came from this call (i.e.
 * the consolidate step ran). Short-circuit A/B leave it undefined so the
 * field's "produced this node's data" semantics stay accurate.
 */
interface AmendHoistedFields {
	readonly topics: ReadonlyArray<TopicSummary>;
	readonly recap?: string;
	readonly ticketId?: string;
	readonly llm?: import("../Types.js").LlmCallMetadata;
}

/**
 * Builds the v4 amend root with all 8 Hoist fields populated and the old
 * summary attached as a stripped child. Used by all three amend paths
 * (short-circuit A, short-circuit B, full path); the only differences are
 * which `hoisted` values the caller passes in and whether they pass a
 * transcript artifact to storeSummary.
 *
 * `oldSummary` is undefined when there's no recorded prior summary (rare:
 * the user amended a commit that was never summarised). In that case the
 * new root is effectively a fresh leaf -- still v4, no children, no Hoist
 * source -- and `hoisted` is whatever the caller derived from delta alone.
 */
function buildHoistedAmendRoot(
	oldSummary: CommitSummary | undefined,
	newInfo: CommitInfo,
	hoisted: AmendHoistedFields,
	metadata: { readonly commitType?: CommitType; readonly commitSource?: CommitSource },
	fullDiffStats: DiffStats,
	stats?: { readonly transcriptEntries?: number; readonly conversationTurns?: number },
): CommitSummary {
	const branch = oldSummary?.branch ?? "";
	const strippedOld = oldSummary ? stripFunctionalMetadata(oldSummary) : undefined;
	const carriedFromOld = oldSummary ? hoistMetadataFromOldSummary(oldSummary) : {};
	return {
		version: 4,
		commitHash: newInfo.hash,
		commitMessage: newInfo.message,
		commitAuthor: newInfo.author,
		commitDate: new Date(newInfo.date).toISOString(),
		branch,
		generatedAt: new Date().toISOString(),
		...(metadata.commitType && { commitType: metadata.commitType }),
		...(metadata.commitSource && { commitSource: metadata.commitSource }),
		...(hoisted.ticketId && { ticketId: hoisted.ticketId }),
		...(hoisted.llm && { llm: hoisted.llm }),
		...(stats?.transcriptEntries !== undefined && { transcriptEntries: stats.transcriptEntries }),
		...(stats?.conversationTurns !== undefined && { conversationTurns: stats.conversationTurns }),
		...carriedFromOld,
		topics: hoisted.topics,
		...(hoisted.recap && { recap: hoisted.recap }),
		diffStats: fullDiffStats,
		...(strippedOld && { children: [strippedOld] }),
	};
}

/**
 * Handles amend queue entries via three-tier dispatch:
 *
 *   - **Short-circuit A** (0 LLM): trivial delta (empty transcript + small or
 *     mechanical diff) -> Copy-Hoist topics/recap from old, no transcript artifact.
 *   - **Short-circuit B** (1 LLM): summarize(delta) returned no topics + no
 *     recap -> Copy-Hoist topics/recap from old, BUT write the transcript
 *     artifact (the LLM read the conversation -- those bytes are valuable for
 *     audit even though the topics/recap weren't substantive).
 *   - **Full path** (2 LLM): summarize(delta) + consolidate([old, delta]) ->
 *     LLM-produced topics/recap (or mechanicalConsolidate fallback), with
 *     transcript artifact.
 *
 * All three paths converge on buildHoistedAmendRoot + storeSummary, so the
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

	// Load sessions and read transcripts with time cutoff.
	const amendConfig = await loadConfig();
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
	const fromRef = diffOverride?.fromRef ?? "HEAD~1";
	const toRef = diffOverride?.toRef ?? "HEAD";
	try {
		deltaDiff = await getDiffContent(fromRef, toRef, cwd);
		deltaDiffStats = await getDiffStats(fromRef, toRef, cwd);
	} catch {
		log.warn("Could not diff %s..%s, using empty diff", fromRef, toRef);
		deltaDiff = "(Could not compute diff)";
		deltaDiffStats = { filesChanged: 0, insertions: 0, deletions: 0 };
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

	// ── Short-circuit A: trivial delta (0 LLM) ────────────────────────────────
	if (oldSummary && isTrivialAmendDelta(deltaDiffStats, totalEntries)) {
		log.info("Amend short-circuit A: trivial delta -- 0 LLM, Copy-Hoist topics/recap from old");
		const root = buildHoistedAmendRoot(
			oldSummary,
			commitInfo,
			{
				topics: resolveEffectiveTopics(oldSummary),
				...(oldSummary.recap !== undefined && { recap: oldSummary.recap }),
				...(oldSummary.ticketId !== undefined && { ticketId: oldSummary.ticketId }),
			},
			metadata ?? {},
			amendFullDiffStats,
		);
		await storeSummary(root, cwd);
		await reassociateMetadata([oldSummary], commitInfo.hash, cwd);
		log.info(
			"Amend short-circuit A complete: %s -> %s (%s)",
			oldHash.substring(0, 8),
			commitInfo.hash.substring(0, 8),
			formatElapsed(pipelineStart),
		);
		return;
	}

	// No old summary AND trivial delta -- nothing useful to record.
	/* v8 ignore start -- defensive: covered indirectly when both inputs are absent */
	if (!oldSummary && isTrivialAmendDelta(deltaDiffStats, totalEntries)) {
		log.info("Amend with no old summary AND trivial delta -- skipping");
		return;
	}
	/* v8 ignore stop */

	// ── Step 1 LLM: summarize the delta ───────────────────────────────────────
	const conversation = buildMultiSessionContext(sessionTranscripts);
	stepStart = now();
	const summaryParams = {
		conversation,
		diff: deltaDiff,
		commitInfo,
		diffStats: deltaDiffStats,
		transcriptEntries: totalEntries,
		conversationTurns: humanEntries,
		config: amendConfig,
	};

	let delta: Awaited<ReturnType<typeof generateSummary>>;
	try {
		delta = await generateSummary(summaryParams);
	} catch (error: unknown) {
		log.warn("First API attempt failed: %s. Retrying in %dms...", (error as Error).message, RETRY_DELAY_MS);
		await delay(RETRY_DELAY_MS);
		try {
			delta = await generateSummary(summaryParams);
		} catch (retryError: unknown) {
			log.error("API call failed after retry: %s", (retryError as Error).message);
			log.error(
				"Amend summary generation skipped for commit %s. A new commit will trigger summary generation automatically.",
				commitInfo.hash.substring(0, 8),
				commitInfo.hash,
			);
			return;
		}
	}
	log.info("Amend step 1 (delta summary) generated (%s)", formatElapsed(stepStart));

	// Persist the conversation regardless of which path we take from here.
	const amendStoredTranscript = buildStoredTranscript(sessionTranscripts);
	const transcriptArtifact = amendStoredTranscript.sessions.length > 0 ? amendStoredTranscript : undefined;

	// ── Short-circuit B: 1 LLM, delta produced no substantive content ─────────
	if (oldSummary && (delta.topics?.length ?? 0) === 0 && !delta.recap) {
		log.info("Amend short-circuit B: 1 LLM, delta empty -- Copy-Hoist topics/recap from old, write transcript");
		const root = buildHoistedAmendRoot(
			oldSummary,
			commitInfo,
			{
				topics: resolveEffectiveTopics(oldSummary),
				...(oldSummary.recap !== undefined && { recap: oldSummary.recap }),
				...(oldSummary.ticketId !== undefined && { ticketId: oldSummary.ticketId }),
				// llm: undefined -- topics/recap came from old, not from delta
			},
			metadata ?? {},
			amendFullDiffStats,
			{ transcriptEntries: totalEntries, conversationTurns: humanEntries },
		);
		await storeSummary(root, cwd, false, transcriptArtifact ? { transcript: transcriptArtifact } : undefined);
		await reassociateMetadata([oldSummary], commitInfo.hash, cwd);
		log.info(
			"Amend short-circuit B complete: %s -> %s (%s)",
			oldHash.substring(0, 8),
			commitInfo.hash.substring(0, 8),
			formatElapsed(pipelineStart),
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
			...(delta.ticketId !== undefined && { ticketId: delta.ticketId }),
			topics: delta.topics,
			...(delta.recap !== undefined && { recap: delta.recap }),
		};
		const sources: ReadonlyArray<SquashConsolidationSource> = [
			...expandSourcesForConsolidation(oldSummary),
			deltaSource,
		];
		const outerTicketId = oldSummary.ticketId ?? delta.ticketId;

		stepStart = now();
		let consolidated: ConsolidatedTopics | null;
		try {
			consolidated = await generateSquashConsolidation({
				squashCommitMessage: commitInfo.message,
				...(outerTicketId !== undefined && { ticketId: outerTicketId }),
				sources,
				config: amendConfig,
			});
		} catch (err) {
			log.warn(
				"Amend step 2 (consolidate) LLM failed: %s -- falling back to mechanical merge",
				(err as Error).message,
			);
			consolidated = null;
		}
		const finalConsolidated: ConsolidatedTopics = consolidated ?? mechanicalConsolidate(sources, outerTicketId);
		log.info(
			"Amend step 2 (consolidate) %s (%s)",
			consolidated ? "succeeded" : "fell back to mechanical",
			formatElapsed(stepStart),
		);

		const root = buildHoistedAmendRoot(
			oldSummary,
			commitInfo,
			{
				topics: finalConsolidated.topics,
				...(finalConsolidated.recap !== undefined && { recap: finalConsolidated.recap }),
				...(finalConsolidated.ticketId !== undefined && { ticketId: finalConsolidated.ticketId }),
				// Only include llm metadata when consolidation actually called the LLM.
				...(consolidated?.llm && { llm: consolidated.llm }),
			},
			metadata ?? {},
			amendFullDiffStats,
			{ transcriptEntries: totalEntries, conversationTurns: humanEntries },
		);
		await storeSummary(root, cwd, false, transcriptArtifact ? { transcript: transcriptArtifact } : undefined);
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
	const freshLeaf: CommitSummary = {
		version: 4,
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
	};
	await storeSummary(freshLeaf, cwd, false, transcriptArtifact ? { transcript: transcriptArtifact } : undefined);
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
		if (chatSessions.length > 0) {
			allSessions = [...allSessions, ...chatSessions];
			log.info("Discovered %d Copilot Chat session(s)", chatSessions.length);
		}
	}

	if (allSessions.length === 0) {
		log.info("No active sessions found — will infer topics from diff if available");
	}

	const { sessionTranscripts, totalEntries, humanEntries } = await readAllTranscripts(
		allSessions,
		cwd,
		beforeTimestamp,
	);

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
	executePipeline,
	handleAmendPipeline,
	handleSquashFromQueue,
	loadSessionTranscripts,
	buildStoredTranscript,
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

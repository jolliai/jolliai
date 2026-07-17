/**
 * CommitSummarizer — one entry point for "given (cwd, commitHash,
 * transcript), produce a CommitSummary and store it."
 *
 * Exists so hosts that want to generate commit memories WITHOUT spawning the
 * full `QueueWorker` subprocess (the desktop cockpit's manual checkpoint,
 * tests, embedded flows) can do so in-process. This is a thin composition
 * over primitives that already exist:
 *   - `generateSummary` (Summarizer) — the LLM call
 *   - `storeSummary`    (SummaryStore) — the persistence
 *   - GitOps helpers    — diff, stats, commit info, tree hash
 *
 * NOT a replacement for `QueueWorker.runWorker` — that additionally handles
 * queue draining, plan/note association, reference archiving, transcript
 * reader/detector fan-out, hoisted metadata, and the operations queue. Use
 * this only when the caller already has a live transcript in hand.
 */

import { COMMIT_CAPTURE_LOCK_WAIT_MS, withCommitCaptureLock } from "../hooks/CommitCaptureLock.js";
import { createLogger } from "../Logger.js";
import type { CommitSummary, JolliMemoryConfig, StoredTranscript } from "../Types.js";
import { CURRENT_SCHEMA_VERSION } from "../Types.js";
import { archiveSupersededCheckpoints, commitSecondUpperBound } from "./CheckpointStore.js";
import { execGit, getCommitInfo, getDiffContent, getDiffStats } from "./GitOps.js";
import { hasLlmCredentials } from "./LlmClient.js";
import { createStorage } from "./StorageFactory.js";
import type { StorageProvider } from "./StorageProvider.js";
import { generateSummary } from "./Summarizer.js";
import { getSummary, storeSummary } from "./SummaryStore.js";
import { generateTranscriptId } from "./TranscriptId.js";
import { buildMultiSessionContext } from "./TranscriptReader.js";
import { countConversationTurns, countTranscriptEntries, firstBranch } from "./TranscriptStats.js";

const log = createLogger("CommitSummarizer");

/**
 * Thrown by {@link generateCommitSummary} when the per-commit capture lock could
 * not be acquired within {@link COMMIT_CAPTURE_LOCK_WAIT_MS} — another live
 * capture or `jolli backfill` of the same hash held it for the whole window.
 * A distinct type so a host (the desktop cockpit's `Result<T>` boundary) can
 * report "capture already in progress" rather than a generation failure.
 */
export class CommitCaptureInProgressError extends Error {}

export interface GenerateCommitSummaryOptions {
	/**
	 * The active branch the commit was made on. When absent, falls back to
	 * `"unknown"` — the caller should pass the branch that the transcript was
	 * captured on, since post-hoc `git symbolic-ref HEAD` isn't reliable for a
	 * historical commit.
	 */
	readonly branch?: string;
	/**
	 * Optional pre-constructed storage. When omitted, `createStorage(cwd, cwd)`
	 * builds the default dual-write layout the CLI uses.
	 */
	readonly storage?: StorageProvider;
	/**
	 * When true, allow overwriting an existing summary for this commit hash.
	 * Mirrors the `force` argument on `runWorker`. Defaults false — the safe
	 * choice for a per-commit capture button.
	 */
	readonly force?: boolean;
	/**
	 * When false, run the LLM and assemble the `CommitSummary` but DO NOT persist
	 * it — a dry-run "draft" for a review-then-save UI. The caller keeps the
	 * returned `summary` + `transcriptId` (and the `transcript` it passed in) and
	 * commits them later via {@link persistCommitSummary}. Defaults true (the
	 * original generate-and-store behaviour).
	 */
	readonly persist?: boolean;
}

export interface GenerateCommitSummaryResult {
	readonly summary: CommitSummary;
	readonly topics: number;
	readonly transcriptId?: string;
}

/**
 * Produce and persist a summary for `commitHash` using the provided
 * transcript. Throws on LLM or storage failure — callers wrap in try/catch
 * at their surface boundary (the desktop IPC handler does this via
 * `Result<T>`). Never mutates the operations queue.
 */
export async function generateCommitSummary(
	cwd: string,
	commitHash: string,
	transcript: StoredTranscript,
	config: JolliMemoryConfig,
	opts?: GenerateCommitSummaryOptions,
): Promise<GenerateCommitSummaryResult> {
	if (!hasLlmCredentials(config)) {
		throw new Error("no LLM credentials configured");
	}

	const storage = opts?.storage ?? (await createStorage(cwd, cwd));
	const persist = opts?.persist !== false;
	const force = opts?.force === true;
	// Storage is threaded explicitly through every persistence call below
	// (`storeSummary(..., storage)`, `getSummary(..., storage)`,
	// `retireSupersededCheckpoints(storage, ...)`), so this capture never reads or
	// mutates the process-global `setActiveStorage` override. That is deliberate:
	// it makes concurrent captures of DIFFERENT hashes + DIFFERENT storages in one
	// long-lived host (the desktop cockpit fanning across repos) race-free — there
	// is no shared global save/restore to interleave. Do NOT reintroduce a
	// setActiveStorage swap here; thread `storage` into any new inner read instead.

	// The generate → build → (store) body. It runs the LLM, so a persist run
	// executes it UNDER the per-commit capture lock (below) — a concurrent live
	// capture / `jolli backfill` of the same hash must not both pay for it.
	const produce = async (): Promise<GenerateCommitSummaryResult> => {
		const commitInfo = await getCommitInfo(commitHash, cwd);
		const diff = await getDiffContent(`${commitHash}~1`, commitHash, cwd);
		const diffStats = await getDiffStats(`${commitHash}~1`, commitHash, cwd);
		// buildMultiSessionContext wants a required `transcriptPath` per session —
		// StoredTranscript keeps it optional (a live in-memory transcript may not
		// yet have been written to disk). Fill in "" so the context builder gets a
		// shape it accepts; the value is only used for logging.
		const conversation = buildMultiSessionContext(
			transcript.sessions.map((s) => ({
				sessionId: s.sessionId,
				transcriptPath: s.transcriptPath ?? "",
				source: s.source,
				entries: s.entries,
			})),
		);
		// Tree hash gives cross-branch matching parity with the live pipeline —
		// the same tree on a different branch resolves to this summary.
		const treeRes = await execGit(["rev-parse", `${commitHash}^{tree}`], cwd);
		const treeHash = treeRes.exitCode === 0 ? treeRes.stdout.trim() : undefined;

		const transcriptEntries = countTranscriptEntries(transcript);
		const conversationTurns = countConversationTurns(transcript);

		const result = await generateSummary({
			conversation,
			diff,
			commitInfo,
			diffStats,
			transcriptEntries,
			conversationTurns,
			config: {
				apiKey: config.apiKey,
				model: config.model,
				jolliApiKey: config.jolliApiKey,
				aiProvider: config.aiProvider,
			},
		});

		const branch = opts?.branch ?? firstBranch(transcript) ?? "unknown";
		const transcriptId = generateTranscriptId();
		const summary: CommitSummary = {
			version: CURRENT_SCHEMA_VERSION,
			commitHash,
			commitMessage: commitInfo.message,
			commitAuthor: commitInfo.author,
			commitDate: commitInfo.date,
			branch,
			generatedAt: new Date().toISOString(),
			commitType: "commit",
			commitSource: "cli",
			transcriptEntries: result.transcriptEntries,
			conversationTurns: result.conversationTurns,
			llm: result.llm,
			stats: result.stats,
			diffStats: result.stats,
			topics: result.topics,
			transcripts: [transcriptId],
			...(treeHash ? { treeHash } : {}),
			...(result.ticketId ? { ticketId: result.ticketId } : {}),
			...(result.recap ? { recap: result.recap } : {}),
		};

		if (persist) {
			await storeSummary(summary, cwd, force, { transcript: { id: transcriptId, data: transcript } }, storage);
			log.info(
				"Generated + stored commit summary %s via CommitSummarizer (%d topic(s))",
				commitHash.substring(0, 8),
				result.topics.length,
			);
			await retireSupersededCheckpoints(storage, summary);
		} else {
			log.info(
				"Generated DRAFT commit summary %s via CommitSummarizer (%d topic(s)) — not persisted",
				commitHash.substring(0, 8),
				result.topics.length,
			);
		}
		return { summary, topics: result.topics.length, transcriptId };
	};

	// A draft (persist:false) never stores, so it can't duplicate or clobber a
	// stored summary — run it lock-free. Only the persisting path contends.
	if (!persist) return await produce();

	const captured = await withCommitCaptureLock(cwd, commitHash, { wait: COMMIT_CAPTURE_LOCK_WAIT_MS }, async () => {
		// Re-check under the lock: a detached QueueWorker or `jolli backfill`
		// may have won this hash while we waited. Return the stored summary
		// and skip the (expensive) LLM — the same re-check-under-lock guard
		// QueueWorker and BackfillEngine use. `force` intentionally regenerates.
		//
		// A BACKFILLED summary does NOT short-circuit: back-fill is a
		// lower-fidelity placeholder (no live transcript), so this live capture
		// supersedes it. `produce()` → storeSummary's `promotesBackfill` replaces
		// it (kept in lock-step with QueueWorker's own skip guard).
		if (!force) {
			const existing = await getSummary(commitHash, cwd, storage);
			if (existing && existing.backfilled !== true) {
				log.info(
					"Commit %s already summarized — returning existing under capture lock",
					commitHash.substring(0, 8),
				);
				return {
					summary: existing,
					topics: existing.topics?.length ?? 0,
					transcriptId: existing.transcripts?.[0],
				};
			}
		}
		return produce();
	});
	if (!captured.ran) {
		throw new CommitCaptureInProgressError(
			`commit capture for ${commitHash.substring(0, 8)} is already in progress`,
		);
	}
	return captured.value;
}

/**
 * Persist a previously-generated (draft) summary — the "save" half of the
 * generate-then-review-then-save flow a `persist: false` call starts. Threads
 * `storage` explicitly into the persistence calls, so a save in a long-lived
 * host never touches the process-global storage override. `transcriptId` must be
 * the id returned by the matching {@link generateCommitSummary} call so the
 * summary and its stored transcript stay linked.
 *
 * Deliberately does NOT take the per-commit capture lock (unlike
 * {@link generateCommitSummary}): it runs no LLM, so there is nothing expensive
 * to guard against duplicating, and `storeSummary` already serializes writes
 * under the orphan write-lock and drops a same-hash write when a summary exists
 * (unless `force`) — so a concurrent live capture can neither corrupt nor
 * double-write this hash. Blocking a save for up to the capture-lock window to
 * spare a background worker one wasted LLM call would be a worse trade.
 */
export async function persistCommitSummary(
	cwd: string,
	summary: CommitSummary,
	transcript: StoredTranscript,
	transcriptId: string,
	opts?: { readonly storage?: StorageProvider; readonly force?: boolean },
): Promise<void> {
	const storage = opts?.storage ?? (await createStorage(cwd, cwd));
	// Storage is threaded explicitly into storeSummary / retireSupersededCheckpoints,
	// so this never touches the process-global override — no save/restore to race
	// with a concurrent capture (same rationale as generateCommitSummary).
	await storeSummary(
		summary,
		cwd,
		opts?.force === true,
		{ transcript: { id: transcriptId, data: transcript } },
		storage,
	);
	log.info("Persisted commit summary %s via persistCommitSummary", summary.commitHash.substring(0, 8));
	await retireSupersededCheckpoints(storage, summary);
}

/**
 * Retire the branch's pre-commit checkpoints now that a durable summary for this
 * commit exists (concept §03). `before: summary.commitDate` scopes archival to
 * checkpoints captured at or before this commit, so summarizing an *older* commit
 * (back-fill) never wipes checkpoints for work done since. Fail-safe: a folder
 * without checkpoints is a no-op, and any error is swallowed — retiring a
 * volatile checkpoint must never fail a persisted commit summary. Skipped when
 * storage is not folder-backed (no `kbRoot` → no checkpoints) or the branch/date
 * is unusable.
 */
async function retireSupersededCheckpoints(storage: StorageProvider, summary: CommitSummary): Promise<void> {
	if (!storage.kbRoot || !summary.branch || summary.branch === "unknown") return;
	const before = commitSecondUpperBound(summary.commitDate);
	if (before === null) return;
	try {
		await archiveSupersededCheckpoints(storage.kbRoot, summary.branch, {
			before,
			supersededBy: summary.commitHash,
		});
	} catch (err) {
		log.warn(
			"Checkpoint archive after commit-summary %s failed (non-fatal): %s",
			summary.commitHash.substring(0, 8),
			(err as Error).message,
		);
	}
}

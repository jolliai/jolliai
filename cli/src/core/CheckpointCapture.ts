/**
 * CheckpointCapture — one entry point for "given (cwd, transcript), capture a
 * checkpoint from the current working-tree state" — the pre-commit sibling of
 * {@link ../core/CommitSummarizer}.
 *
 * A checkpoint answers the problem the CLI can't: reasoning evaporates when the
 * user hasn't committed yet. It runs the SAME LLM primitive a commit summary uses
 * (`generateSummary`) but over the *working-tree* diff instead of a commit diff,
 * and stores the result as a volatile {@link CheckpointRecord} under
 * `.jolli/checkpoints/` — never as a `CommitSummary`, never on the orphan branch.
 *
 * This is a thin composition over primitives that already exist:
 *   - `getWorkingTreeDiff` (GitOps)       — staged + unstaged + untracked → diff
 *   - `generateSummary`    (Summarizer)   — the LLM call (topics/recap)
 *   - `writeCheckpoint`    (CheckpointStore) — folder-only persistence
 *
 * NOT part of `QueueWorker`'s per-commit pipeline: it does not touch the git
 * operation queue, plan/note/reference association, or hoisted metadata — those
 * belong to a durable commit, and a volatile checkpoint deliberately skips them
 * (associating working-area context to a throwaway capture would consume it
 * before the real commit lands). It supersedes nothing on its own; a later
 * commit-summary on the branch retires it via `archiveSupersededCheckpoints`.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "../Logger.js";
import type { JolliMemoryConfig, StoredTranscript } from "../Types.js";
import { CHECKPOINT_SCHEMA_VERSION, type CheckpointRecord, writeCheckpoint } from "./CheckpointStore.js";
import { getCurrentBranch, getWorkingTreeDiff } from "./GitOps.js";
import { extractRepoName, getRemoteUrl, resolveKBPath } from "./KBPathResolver.js";
import { hasLlmCredentials } from "./LlmClient.js";
import { generateSummary } from "./Summarizer.js";
import { buildMultiSessionContext } from "./TranscriptReader.js";
import { countConversationTurns, countTranscriptEntries, firstBranch } from "./TranscriptStats.js";

const log = createLogger("CheckpointCapture");

export interface GenerateCheckpointOptions {
	/**
	 * Explicit Memory Bank root for this repo. When omitted, it is resolved from
	 * `cwd` via the same `extractRepoName` → `getRemoteUrl` → `resolveKBPath`
	 * chain `createStorage` uses, so a checkpoint lands in the SAME folder as the
	 * repo's commit summaries.
	 */
	readonly kbRoot?: string;
	/** Branch the working tree is on. Falls back to the transcript's branch, then the live branch. */
	readonly branch?: string;
	/**
	 * When false, run the LLM and assemble the record but DO NOT persist it — a
	 * draft for a review-then-save UI. The caller keeps the returned `record` +
	 * `kbRoot` and commits it later via {@link persistCheckpoint}. Defaults true.
	 */
	readonly persist?: boolean;
	/** Pre-minted id (the on-disk filename stem). When omitted, one is generated. */
	readonly id?: string;
	/**
	 * Optional abort signal, forwarded to the LLM call so a caller (e.g. a desktop
	 * UI) can cancel the capture mid-flight. On abort the LLM call rejects and
	 * this function throws; nothing is persisted. Additive.
	 */
	readonly signal?: AbortSignal;
}

export interface GenerateCheckpointResult {
	readonly record: CheckpointRecord;
	/** The resolved Memory Bank root — pass it to {@link persistCheckpoint} for a draft save. */
	readonly kbRoot: string;
}

/**
 * Capture a checkpoint for the current working-tree state using the provided
 * transcript. Throws on missing credentials, an empty capture (no conversation
 * AND no working-tree change), or LLM failure — callers wrap at their surface
 * boundary (the desktop IPC handler does this via `Result<T>`).
 */
export async function generateCheckpoint(
	cwd: string,
	transcript: StoredTranscript,
	config: JolliMemoryConfig,
	opts?: GenerateCheckpointOptions,
): Promise<GenerateCheckpointResult> {
	if (!hasLlmCredentials(config)) {
		throw new Error("no LLM credentials configured");
	}

	const branch = opts?.branch ?? firstBranch(transcript) ?? (await getCurrentBranch(cwd));
	// `localFolder` is the user-configured KB parent; the same key createStorage
	// reads. Cast because it is not on the narrow JolliMemoryConfig surface.
	const customPath = (config as { localFolder?: string }).localFolder;
	const kbRoot = opts?.kbRoot ?? resolveKBPath(extractRepoName(cwd), getRemoteUrl(cwd), customPath);

	const { content: diff, stats: diffStats } = await getWorkingTreeDiff(cwd);
	const transcriptEntries = countTranscriptEntries(transcript);
	const conversationTurns = countConversationTurns(transcript);

	// Mirror the live pipeline's guard: nothing to summarize when there is neither
	// a conversation nor a working-tree change (Summarizer can infer topics from a
	// diff alone, so a diff with no transcript is still valid).
	if (transcriptEntries === 0 && diffStats.filesChanged === 0) {
		throw new Error("nothing to checkpoint — no conversation and no working-tree changes");
	}

	const conversation = buildMultiSessionContext(
		transcript.sessions.map((s) => ({
			sessionId: s.sessionId,
			transcriptPath: s.transcriptPath ?? "",
			source: s.source,
			entries: s.entries,
		})),
	);

	const result = await generateSummary({
		conversation,
		diff,
		// Synthetic commit info: a checkpoint has no commit. Message gives the LLM
		// honest context; hash/date are placeholders used only for prompt + logs.
		commitInfo: {
			hash: "WORKING",
			message: `(uncommitted working-tree changes on ${branch})`,
			author: "",
			date: new Date().toISOString(),
		},
		diffStats,
		transcriptEntries,
		conversationTurns,
		config: {
			apiKey: config.apiKey,
			model: config.model,
			jolliApiKey: config.jolliApiKey,
			aiProvider: config.aiProvider,
		},
		...(opts?.signal ? { signal: opts.signal } : {}),
	});

	const nowIso = new Date().toISOString();
	const record: CheckpointRecord = {
		version: CHECKPOINT_SCHEMA_VERSION,
		kind: "checkpoint",
		id: opts?.id ?? mintCheckpointId(),
		branch,
		createdAt: nowIso,
		generatedAt: nowIso,
		topics: result.topics,
		diffStats: result.stats,
		...(result.recap ? { recap: result.recap } : {}),
		...(typeof result.transcriptEntries === "number" ? { transcriptEntries: result.transcriptEntries } : {}),
		...(typeof result.conversationTurns === "number" ? { conversationTurns: result.conversationTurns } : {}),
		...(result.llm ? { llm: result.llm } : {}),
		...(transcript.sessions[0]?.source ? { source: transcript.sessions[0].source } : {}),
		...(transcript.sessions.length > 0 ? { sessionIds: transcript.sessions.map((s) => s.sessionId) } : {}),
	};

	if (opts?.persist !== false) {
		await writeCheckpoint(kbRoot, record);
		log.info("Captured + stored checkpoint %s on %s (%d topic(s))", record.id, branch, record.topics.length);
	} else {
		log.info(
			"Captured DRAFT checkpoint %s on %s (%d topic(s)) — not persisted",
			record.id,
			branch,
			record.topics.length,
		);
	}
	return { record, kbRoot };
}

/**
 * Persist a previously-generated (draft) checkpoint — the "save" half of the
 * generate-then-review-then-save flow a `persist: false` call starts.
 * `kbRoot` must be the value returned alongside the draft.
 */
export async function persistCheckpoint(kbRoot: string, record: CheckpointRecord): Promise<void> {
	await writeCheckpoint(kbRoot, record);
	log.info("Persisted checkpoint %s on %s", record.id, record.branch);
}

/** A sortable, filesystem-safe checkpoint id: `ckpt-<base36 ms>-<8 hex>`. */
function mintCheckpointId(): string {
	return `ckpt-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

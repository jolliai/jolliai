/**
 * Jolli Memory Type Definitions
 *
 * Central type definitions for all modules in the Jolli Memory tool.
 */

import type { CopilotChatScanError } from "./core/CopilotChatTranscriptReader.js";
import type { SqliteScanError } from "./core/SqliteHelpers.js";

/**
 * Closed enumeration of every known TranscriptSource. Single source of truth
 * for both the runtime allowlist (used at trust boundaries: webview → host,
 * overlay file load, etc.) and the static union below. Removing or renaming
 * an entry here breaks every consumer at compile time — no dual-maintenance
 * drift between the runtime array and the TS union.
 */
export const TRANSCRIPT_SOURCES = [
	"claude",
	"codex",
	"gemini",
	"opencode",
	"cursor",
	"copilot",
	"copilot-chat",
] as const;

/** Which AI coding agent produced the transcript. Derived from the runtime allowlist. */
export type TranscriptSource = (typeof TRANSCRIPT_SOURCES)[number];

/** Runtime type-guard for TranscriptSource. */
export function isTranscriptSource(value: unknown): value is TranscriptSource {
	return typeof value === "string" && (TRANSCRIPT_SOURCES as readonly string[]).includes(value);
}

/** Metadata about an AI coding session, saved by the Stop hook (Claude) or discovered on-demand (Codex) */
export interface SessionInfo {
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly updatedAt: string; // ISO 8601
	/** Which agent produced this session. Defaults to "claude" for backward compatibility. */
	readonly source?: TranscriptSource;
	/**
	 * Native title from the source's own session metadata, if present.
	 * Populated by discoverers that have cheap access to this field (e.g. sqlite columns).
	 * Empty string and missing both mean "no native title" — caller falls back to truncation.
	 */
	readonly title?: string;
}

/** Cursor tracking position in a transcript file */
export interface TranscriptCursor {
	readonly transcriptPath: string;
	readonly lineNumber: number;
	readonly updatedAt: string; // ISO 8601
}

/** A single parsed transcript entry from the JSONL file */
export interface TranscriptEntry {
	readonly role: "human" | "assistant";
	readonly content: string;
	readonly timestamp?: string;
}

/**
 * Per-turn conversation token usage, split into the three segments the VS Code
 * branch token-usage bar renders (input / output / cached).
 *
 * `cached` is `cache_creation_input_tokens` only. `cache_read_input_tokens` is
 * deliberately EXCLUDED because real Claude transcripts emit it as a *cumulative*
 * running total per turn — summing it across a slice re-counts the cached prefix
 * on every turn and inflates the figure by an order of magnitude (see
 * `ClaudeTranscriptParser.parseUsageTokens`). So `input + output + cached` equals
 * the scalar total historically stored as `conversationTokens`. */
export interface ConversationTokenBreakdown {
	readonly input: number;
	readonly output: number;
	readonly cached: number;
}

/** Result from reading a transcript file */
export interface TranscriptReadResult {
	readonly entries: ReadonlyArray<TranscriptEntry>;
	readonly newCursor: TranscriptCursor;
	readonly totalLinesRead: number;
	/** Sum of per-turn token usage (input + cache_creation + output) over the
	 *  slice read; cache_read is excluded (see {@link ConversationTokenBreakdown}).
	 *  0 for sources whose parser does not expose usage. */
	readonly usageTokens?: number;
	/** Per-segment split of {@link usageTokens}. Absent for sources whose parser
	 *  does not expose usage. `input + output + cached === usageTokens`. */
	readonly usageBreakdown?: ConversationTokenBreakdown;
}

// ─── Stored transcript types (orphan branch persistence) ─────────────────────

/** A session's transcript data as stored in the orphan branch (`transcripts/{commitHash}.json`) */
export interface StoredSession {
	readonly sessionId: string;
	readonly source?: TranscriptSource;
	/** Original JSONL file path, preserved for re-summarize (future) */
	readonly transcriptPath?: string;
	readonly entries: ReadonlyArray<TranscriptEntry>;
}

/** Structured transcript data for a commit, stored as `transcripts/{commitHash}.json` in the orphan branch */
export interface StoredTranscript {
	readonly sessions: ReadonlyArray<StoredSession>;
}

// ─── Topic-level classification types ────────────────────────────────────────

export type TopicCategory =
	| "feature"
	| "bugfix"
	| "refactor"
	| "tech-debt"
	| "performance"
	| "security"
	| "test"
	| "docs"
	| "ux"
	| "devops";

export type TopicImportance = "major" | "minor";

/** A single-topic summary within a commit — one per independent problem/goal */
export interface TopicSummary {
	readonly title: string;
	readonly trigger: string;
	readonly response: string;
	readonly decisions: string;
	readonly todo?: string;
	/** 2-5 key file paths changed in this topic (relative to repo root) */
	readonly filesAffected?: ReadonlyArray<string>;
	/** Work category classification */
	readonly category?: TopicCategory;
	/** Major = features, user-facing fixes, architectural decisions; Minor = cleanup, config, docs */
	readonly importance?: TopicImportance;
}

/** Temporary state written by PrepareMsgHook for git merge --squash operations */
export interface SquashPendingState {
	readonly sourceHashes: ReadonlyArray<string>;
	/**
	 * HEAD hash at prepare-commit-msg time — the parent the squash commit must have.
	 * Used to detect stale squash-pending files that survived a lock-contention race.
	 */
	readonly expectedParentHash: string;
	readonly createdAt: string; // ISO 8601
}

/**
 * A queued operation waiting to be processed by the Worker. Written to
 * `.jolli/jollimemory/git-op-queue/{timestamp}-{tag}.json`.
 *
 * Two flavors share the queue:
 *  - {@link CommitGitOperation} — commit / amend / squash / rebase-pick /
 *    rebase-squash / cherry-pick / revert. Worker runs the LLM summarize
 *    pipeline (or mechanical merge for rebase-pick).
 *  - {@link IngestOperation} — topic-KB ingest (SP3). Worker drains all
 *    pending sources via `drainIngest` and re-renders the wiki.
 */
export type GitOperation = CommitGitOperation | IngestOperation;

export interface CommitGitOperation {
	/** Operation type — determines how the Worker processes this entry */
	readonly type: "commit" | "amend" | "squash" | "rebase-pick" | "rebase-squash" | "cherry-pick" | "revert";
	/** Target commit hash */
	readonly commitHash: string;
	/**
	 * Branch the operation landed on, captured at enqueue time.
	 *
	 * Required so the worker's tail cleanup (cleanupBranchStaleChildMarkdown)
	 * targets the right `<branch>/` directory even if the user has `git
	 * checkout`'d away between enqueue and drain. Reading the live branch
	 * from the worker would clean the wrong tree.
	 *
	 * Optional in the type only to tolerate stale on-disk queue entries
	 * written by pre-0.99.x code; the worker skips cleanup when missing
	 * rather than guessing the live branch.
	 */
	readonly branch?: string;
	/** Source hashes: amend's oldHash, squash/rebase's source commit hashes */
	readonly sourceHashes?: ReadonlyArray<string>;
	/** Whether the operation was triggered from the VSCode plugin or CLI */
	readonly commitSource?: CommitSource;
	/** Creation time — used for queue ordering and transcript time-based attribution */
	readonly createdAt: string; // ISO 8601
	/**
	 * W3C trace id (32 lowercase hex) generated by the enqueuer.
	 * The worker adopts it via `runWithTrace` when draining this entry, so the
	 * post-commit hook, the detached worker, and the outbound LLM/push calls
	 * for this commit all share one id across process boundaries. Optional to
	 * tolerate stale pre-trace-id queue entries — the worker generates a fresh
	 * id when absent.
	 */
	readonly traceId?: string;
}

/**
 * Topic-KB ingest request (SP3). Repo-wide — no branch field, because the
 * topic KB is not organized by branch. One queued entry drains all pending
 * sources via `drainIngest`. `triggeredBy` is telemetry only.
 */
export interface IngestOperation {
	readonly type: "ingest";
	readonly triggeredBy: "post-commit" | "post-merge" | "recall-miss" | "manual";
	readonly createdAt: string; // ISO 8601
}

/** Narrows a {@link GitOperation} to an {@link IngestOperation}. */
export function isIngestOperation(op: GitOperation): op is IngestOperation {
	return op.type === "ingest";
}

/**
 * Which credential source was used to make an LLM call.
 *
 * Lives at the Types layer (and not next to `callLlm` in `core/LlmClient.ts`)
 * because `LlmCallMetadata` below references it, and `LlmClient` already
 * imports from this module via `Summarizer` — keeping the type here avoids
 * a Types → LlmClient → Summarizer → Types layer cycle.
 *
 * Values match `resolveLlmCredentialSource` in `core/LlmClient.ts`:
 *   - "anthropic-config": apiKey set in ~/.jolli/jollimemory/config.json (direct mode)
 *   - "anthropic-env":    ANTHROPIC_API_KEY environment variable (direct mode)
 *   - "jolli-proxy":      jolliApiKey (sk-jol-…) routed through the Jolli backend
 */
export type LlmCredentialSource = "anthropic-config" | "anthropic-env" | "jolli-proxy";

/** Metadata from the LLM API call that generated this summary */
export interface LlmCallMetadata {
	/** Actual model used (from response, may differ from requested model due to aliasing) */
	readonly model: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	/**
	 * Prompt-cache tokens (cache_read + cache_creation). Optional because
	 * summaries written before this field existed lack it — readers must
	 * default to 0 when absent (e.g. the VS Code branch token-usage bar).
	 */
	readonly cachedTokens?: number;
	/** Wall-clock time for the API call in milliseconds */
	readonly apiLatencyMs: number;
	/** API stop reason — "max_tokens" indicates the summary may have been truncated */
	readonly stopReason: string | null;
	/**
	 * Which provider produced this summary. Optional because pre-existing
	 * summaries on the orphan branch were written before this field existed
	 * — readers must default to "unknown provider" when absent and not crash.
	 * Populated for every new call by `callLlm` in `core/LlmClient.ts`.
	 */
	readonly source?: LlmCredentialSource;
}

/**
 * @deprecated Retained only for v1→v3 migration code. Use CommitSummary tree structure instead.
 *
 * One session's contribution to a git commit (legacy v1 format).
 */
export interface SummaryRecord {
	readonly commitHash: string;
	readonly commitMessage: string;
	readonly commitDate: string;
	readonly transcriptEntries: number;
	readonly conversationTurns?: number;
	readonly conversationTokens?: number;
	readonly llm?: LlmCallMetadata;
	readonly stats: DiffStats;
	readonly topics: ReadonlyArray<TopicSummary>;
}

/**
 * @deprecated Retained only for v1→v3 migration code. Use CommitSummary tree structure instead.
 *
 * Legacy CommitSummary format with flat records array (v1 orphan branch).
 */
export interface LegacyCommitSummary {
	readonly version: number;
	readonly commitHash: string;
	readonly commitMessage: string;
	readonly commitAuthor: string;
	readonly commitDate: string;
	readonly branch: string;
	readonly generatedAt: string;
	readonly commitType?: CommitType;
	readonly commitSource?: CommitSource;
	readonly records: ReadonlyArray<SummaryRecord>;
	readonly jolliArticleUrl?: string;
}

// ─── Commit-level classification types ───────────────────────────────────────

/** How the commit was created — the hook-participation classification. */
export type CommitType = "commit" | "amend" | "squash" | "rebase" | "cherry-pick" | "revert";

/** Whether the operation was triggered from the VSCode plugin or CLI/other git client */
export type CommitSource = "cli" | "plugin";

/**
 * Closed enumeration of summary-error markers. Extend by adding a new
 * literal here and updating `isSummaryError` in `core/SummaryErrorMarker.ts`.
 *
 * Values:
 *   - "llm-failed": the SUMMARIZE / CONSOLIDATE LLM call failed after one
 *     retry (network error, 5xx, credential failure, quota, etc.). The
 *     summary still landed (with empty topics for fresh commits,
 *     Copy-Hoisted topics for amend short-circuit, or mechanically-merged
 *     topics for amend step-2 / squash fallback) so downstream pipelines
 *     never face missing source summaries, but the user is prompted to
 *     regenerate via the webview banner.
 */
export type SummaryErrorKind = "llm-failed";

/**
 * Schema version stamped on newly written CommitSummary roots.
 *
 * Bumped when the schema introduces a breaking change that requires a
 * migration step (v3→v4 introduced unified-Hoist root topics; v4→v5 introduced
 * the stable `transcripts: string[]` ID array). Future v6 etc. follow the
 * same pattern: define a new migration module under `core/SchemaV{N}Migration`,
 * then bump this constant — every write path automatically stamps the new
 * version.
 *
 * Use this constant when WRITING a new summary root (executePipeline,
 * buildHoistedAmendRoot, migrateOneToOne, mergeManyToOne, ...).
 *
 * Do NOT use this constant for:
 *   - Migration target versions — e.g. `SchemaV5Migration` always targets 5,
 *     not "whatever the latest is". The number is part of the migration's
 *     identity, not a moving target.
 *   - Read-time format thresholds — e.g. `isUnifiedHoistFormat` returns
 *     `version >= 4` (the version that introduced unified Hoist), and that
 *     "4" stays 4 regardless of how high `CURRENT_SCHEMA_VERSION` climbs.
 *   - Test fixtures — they deliberately pin specific versions to exercise
 *     v3/v4/v5 read paths.
 */
export const CURRENT_SCHEMA_VERSION = 5;

/**
 * Complete summary for a single git commit (v3 tree format).
 *
 * Tree structure: each node may have its own topics/stats/llm data, plus optional
 * `children` referencing sub-summaries. Leaf nodes are normal commits; amend nodes
 * have their delta data at top level with the original as a child; squash nodes are
 * pure containers (no own topics) with all source summaries as children.
 */
export interface CommitSummary {
	readonly version: number;
	/** The git commit hash this summary is indexed under */
	readonly commitHash: string;
	/** The git commit message (for squash: the squash commit's own message) */
	readonly commitMessage: string;
	readonly commitAuthor: string;
	/** The git commit date (ISO 8601, UTC) */
	readonly commitDate: string;
	readonly branch: string;
	readonly generatedAt: string;
	/** Ticket/issue identifier extracted by LLM (e.g. "PROJ-123", "FEAT-456", "#789") */
	readonly ticketId?: string;
	/** How this commit was created (normal, amend, squash, cherry-pick, revert) */
	readonly commitType?: CommitType;
	/** Whether this commit was made via the VSCode plugin or CLI */
	readonly commitSource?: CommitSource;
	/** Number of transcript entries (JSONL lines) read during this session */
	readonly transcriptEntries?: number;
	/** Actual conversation turns (count of human-role entries in transcript) */
	readonly conversationTurns?: number;
	/** Total conversation token consumption (input + cache_creation + output across
	 *  assistant turns; cache_read excluded — see {@link ConversationTokenBreakdown})
	 *  for the turns consumed into this commit.
	 *  Forward-only: absent on memories generated before this field existed, and on
	 *  sources whose transcript carries no usage. Consolidated roots aggregate children. */
	readonly conversationTokens?: number;
	/** Per-segment (input / output / cached) split of {@link conversationTokens},
	 *  powering the branch token-usage bar's coloured segments and cost estimate.
	 *  Forward-only and co-written with `conversationTokens` (both present or both
	 *  absent going forward); older memories may carry the scalar total only. */
	readonly conversationTokenBreakdown?: ConversationTokenBreakdown;
	/** LLM call metadata; absent for squash/merge containers (no API call made) */
	readonly llm?: LlmCallMetadata;
	/**
	 * Legacy field: "this node's own LLM-processed diff".
	 *
	 * Semantics vary by node type — this is WHY display code cannot read it directly:
	 *   - Leaf commits            → git diff {hash}^..{hash} (correct)
	 *   - amend roots             → may be delta (oldHash..newHash) when diffOverride used,
	 *                               or the full amended diff (HEAD~1..HEAD) otherwise
	 *   - squash / rebase-pick roots → absent (containers have no own stats)
	 *
	 * Kept for:
	 *   (a) backward compat with older plugin versions that only know this field
	 *   (b) historical amend delta info (not user-facing but retained for completeness)
	 *   (c) v3 fallback when `diffStats` is absent on legacy data
	 *
	 * New code should prefer `diffStats`. Display code MUST use resolveDiffStats(node)
	 * — never read this field directly as display data.
	 */
	readonly stats?: DiffStats;
	/**
	 * Real `git diff {commitHash}^..{commitHash} --shortstat` result.
	 *
	 * Semantics: "this commit's actual diff against its parent". Identical meaning for
	 * every node type (leaf / amend root / squash root / rebase-pick root / nested
	 * container). Written at construction time by:
	 *   - executePipeline         (leaf)
	 *   - handleAmendPipeline     (both the LLM branch and the message-only branch)
	 *   - mergeManyToOne          (squash / merge-squash root)
	 *   - migrateOneToOne         (rebase-pick root)
	 *
	 * Display code reads via resolveDiffStats(), which falls back to `stats` /
	 * aggregateStats() for v3 legacy data that predates this field.
	 */
	readonly diffStats?: DiffStats;
	/** AI-generated topics for this node's own changes */
	readonly topics?: ReadonlyArray<TopicSummary>;
	/**
	 * One-paragraph, human-readable "Quick recap" of the commit's main work,
	 * generated by the LLM call that produces topics. Rendered above the
	 * topic grid in PR markdown and webview. Legacy summaries may not have
	 * this field; renderers fall through to empty-recap handling.
	 *
	 * HOIST: This is a Consolidate-Hoist field paired with `topics`. Children
	 * of a Hoisted root MUST have this stripped (only the root carries the
	 * authoritative consolidated value).
	 */
	readonly recap?: string;
	/**
	 * Marker indicating the summary was produced under a degraded LLM path.
	 * Set by all four LLM-call sites in QueueWorker (normal commit, amend
	 * step-1, amend step-2 consolidate, squash consolidate) when the LLM
	 * call fails after one retry. Absent on healthy summaries. Cleared
	 * explicitly by Regenerator on a successful re-run.
	 *
	 * Legacy summaries written before this field existed signal the same
	 * condition via `llm?.stopReason === "error"`; readers MUST consult both
	 * fields via the shared `isSummaryError` helper in
	 * `core/SummaryErrorMarker.ts`.
	 */
	readonly summaryError?: SummaryErrorKind;
	/**
	 * Child summaries forming a tree. Ordered by commitDate descending (newest first).
	 * - Amend: children = [original summary before amend]
	 * - Squash: children = [all source summaries, newest first]
	 * - Normal commit: absent (leaf node)
	 */
	readonly children?: ReadonlyArray<CommitSummary>;
	/** Full URL of the memory article on Jolli Space after pushing */
	readonly jolliDocUrl?: string;
	/** Server-side article ID for direct update on subsequent pushes (set after first push) */
	readonly jolliDocId?: number;
	/**
	 * Memory summary article IDs (NOT plan article IDs) superseded during squash/rebase merge.
	 * Deleted from Jolli Space after a successful push. Accumulated across re-squashes.
	 * Plan articles are never orphaned — plan slugs include commit hashes and are all kept.
	 */
	readonly orphanedDocIds?: ReadonlyArray<number>;
	/** Git tree hash for this commit; used for cross-branch summary matching */
	readonly treeHash?: string;
	/** On-demand E2E test scenarios for PR reviewers (generated via SummaryWebviewPanel) */
	readonly e2eTestGuide?: ReadonlyArray<E2eTestScenario>;
	/** Claude Code plan files associated with this commit */
	readonly plans?: ReadonlyArray<PlanReference>;
	/** User-created notes associated with this commit */
	readonly notes?: ReadonlyArray<NoteReference>;
	/**
	 * External references (Linear / Jira / GitHub / Notion / …) associated with
	 * this commit. Single field across every {@link SourceId} — readers walk
	 * the array and dispatch on `source`.
	 */
	readonly references?: ReadonlyArray<ReferenceCommitRef>;
	/**
	 * v5 schema: stable transcript IDs referenced by this summary. Each ID
	 * corresponds to a file at `transcripts/{id}.json` on the orphan branch.
	 *
	 * Decoupled from commit hash so history rewrites (rebase / amend / squash /
	 * cherry-pick) move references around without touching transcript files.
	 *
	 * For freshly written v5 data: each ID is a UUID v4 (from `generateTranscriptId`).
	 * For data migrated from v3/v4: legacy IDs reuse the original commit hash
	 * string verbatim (no file rename during migration) — both ID formats are
	 * opaque to readers.
	 *
	 * Absent on pre-v5 data (the read path falls back to `collectAllTranscriptHashes`
	 * via the `getTranscriptIds` compatibility helper). Optional in the type so
	 * Release N keeps reading legacy data; Release N+M will make it required.
	 */
	readonly transcripts?: ReadonlyArray<string>;
	/**
	 * Marks a summary produced by the historical back-fill flow (`jolli backfill`
	 * / enable-time catch-up) rather than the live post-commit pipeline. The
	 * back-fill flow is fully isolated from QueueWorker: it reconstructs the
	 * conversation by attributing on-disk Claude transcripts to historical
	 * commits offline. Absent on summaries written by the live pipeline.
	 */
	readonly backfilled?: boolean;
	/**
	 * Confidence of the back-fill conversation attribution — the *weakest* tier of
	 * the turns actually included (so a badge never overclaims). "high" = a turn's
	 * segment edited a file in this commit's diff (file-orthogonality anchor);
	 * "medium" = matched by effective branch only; "low" = pure time-window (e.g.
	 * planning on main). Absent when no conversation was attributed (`diff-only`).
	 * Only meaningful when `backfilled`.
	 */
	readonly backfillConfidence?: "high" | "medium" | "low";
	/**
	 * Which back-fill signal produced this summary. `file-overlap` (HIGH) /
	 * `branch-match` (MEDIUM) / `time-window` (LOW) mean a conversation was
	 * attributed; `diff-only` means no conversation was confidently found, so the
	 * summary was generated from the git diff alone (mirrors the live pipeline's
	 * no-session path). Only meaningful when `backfilled`.
	 */
	readonly backfillMethod?: "file-overlap" | "branch-match" | "time-window" | "diff-only";
}

/** A single E2E test scenario for one feature or bug fix */
export interface E2eTestScenario {
	/** Short label, e.g. "Article reordering" or "Login timeout fix" */
	readonly title: string;
	/** Prerequisites before testing, e.g. "Have a Space with 3+ articles" */
	readonly preconditions?: string;
	/** Numbered step-by-step instructions, plain language, no code */
	readonly steps: ReadonlyArray<string>;
	/** What the reviewer should see if it works correctly */
	readonly expectedResults: ReadonlyArray<string>;
}

/** Reference to a Claude Code plan file associated with a commit */
export interface PlanReference {
	/** Plan slug — after archival this becomes "slug-commitHash" (e.g. "abstract-jumping-church-06d0f729") */
	readonly slug: string;
	/** First # heading from the markdown file */
	readonly title: string;
	/** ISO 8601 — when this plan was first discovered */
	readonly addedAt: string;
	/** ISO 8601 — when this plan was last modified */
	readonly updatedAt: string;
	/** Full URL of the plan article on Jolli Space after pushing */
	readonly jolliPlanDocUrl?: string;
	/** Server-side article ID for direct plan update on subsequent pushes */
	readonly jolliPlanDocId?: number;
}

/** Persisted plan entry in plans.json registry */
export interface PlanEntry {
	readonly slug: string;
	readonly title: string;
	readonly sourcePath: string;
	readonly addedAt: string;
	readonly updatedAt: string;
	readonly commitHash: string | null;
	/** SHA-256 hash of the plan file content when associated with a commit. Used as a guard to detect if the file was overwritten with new content. */
	readonly contentHashAtCommit?: string;
	/**
	 * Branch the plan was created/last touched on. Optional: legacy rows and rows
	 * written before branch-scoping omit it (treated as visible on every branch).
	 * The CLI does not filter on it, but persists it so the IntelliJ plugin — which
	 * shares this plans.json — can branch-scope its CONTEXT view.
	 */
	readonly branch?: string;
}

/**
 * plans.json registry structure.
 *
 * Multi-source: holds plans / notes / references (keyed by `<source>:<nativeId>`
 * pre-archive and `<source>:<nativeId>-<shortHash>` post-archive). The
 * `version` field is vestigial — nothing branches on it. Old and new code
 * separate by field name (`linearIssues` vs `references`), so no version-gated
 * migration is needed; it stays at `1` (the pre-references schema) as a plain
 * future-migration anchor.
 */
export interface PlansRegistry {
	readonly version: 1;
	readonly plans: Readonly<Record<string, PlanEntry>>;
	readonly notes?: Readonly<Record<string, NoteEntry>>;
	readonly references?: Readonly<Record<string, ReferenceEntry>>;
}

// ─── Note types ─────────────────────────────────────────────────────────────

/** Storage format for notes */
export type NoteFormat = "markdown" | "snippet";

/** Persisted note entry in plans.json registry */
export interface NoteEntry {
	readonly id: string;
	readonly title: string;
	readonly format: NoteFormat;
	readonly addedAt: string;
	readonly updatedAt: string;
	readonly commitHash: string | null;
	/** SHA-256 hash of note content when associated with a commit (archive guard) */
	readonly contentHashAtCommit?: string;
	/** File path in .jolli/jollimemory/notes/<id>.md (all notes are file-backed) */
	readonly sourcePath?: string;
	/**
	 * Branch the note was created on. Optional for the same reason as
	 * {@link PlanEntry.branch}: persisted by the CLI (not filtered on) so the
	 * IntelliJ plugin can branch-scope its shared CONTEXT view.
	 */
	readonly branch?: string;
}

// ─── Plan progress types ────────────────────────────────────────────────────

/** Status of a plan step after evaluating progress from a commit */
export type PlanStepStatus = "completed" | "in_progress" | "not_started";

/** A single step in a plan progress evaluation */
export interface PlanStep {
	/** Step identifier (e.g. "1", "2a") discovered from the plan markdown */
	readonly id: string;
	/** Step description text from the plan */
	readonly description: string;
	/** Progress status based on the commit's diff */
	readonly status: PlanStepStatus;
	/** Rationale-rich note citing decisions, topics, or human-flagged signals; null if no progress */
	readonly note: string | null;
}

/** Result from PlanProgressEvaluator — LLM-derived fields only, no commit metadata */
export interface PlanProgressEvalResult {
	/** 1-2 sentence summary of what the developer was working on in this session */
	readonly summary: string;
	/** Per-step progress evaluation */
	readonly steps: ReadonlyArray<PlanStep>;
	/** LLM call metadata for the evaluation */
	readonly llm: LlmCallMetadata;
}

/** Plan progress artifact stored per (commit, plan) pair on the orphan branch */
export interface PlanProgressArtifact extends PlanProgressEvalResult {
	readonly version: 1;
	readonly commitHash: string;
	readonly commitMessage: string;
	readonly commitDate: string;
	/** Archived plan slug including commit hash suffix (e.g. "indexed-growing-pascal-0f8bdc9d") */
	readonly planSlug: string;
	/** Original plan slug before archival (e.g. "indexed-growing-pascal") */
	readonly originalSlug: string;
}

/** Reference to a note associated with a commit (stored in CommitSummary.notes) */
export interface NoteReference {
	readonly id: string;
	readonly title: string;
	readonly format: NoteFormat;
	/** Snippet: content snapshot at archive time */
	readonly content?: string;
	readonly addedAt: string;
	readonly updatedAt: string;
	/** Full URL of the note article on Jolli Space after pushing */
	readonly jolliNoteDocUrl?: string;
	/** Server-side article ID for direct update on subsequent pushes */
	readonly jolliNoteDocId?: number;
}

// ─── Generic external-reference types (multi-source) ────────────────────────

/**
 * SourceId — stable id naming each external-reference provider.
 *
 * Add a new id only by registering a corresponding `SourceAdapter` in
 * `cli/src/core/references/sources/index.ts`. Persistence layers (the
 * `plans.json` `references` map, orphan-branch `references/<source>/…`) key off
 * this string directly.
 */
export type SourceId = "linear" | "jira" | "github" | "notion";

/**
 * ReferenceField — one displayable field produced by a `SourceAdapter`.
 *
 * The opaque carrier for everything source-specific. The common layer
 * (persistence, commit snapshot, panel, tooltip) only **passes it through** —
 * it NEVER interprets `key`. Each adapter owns which fields exist, their
 * display labels, icons, and order. Adding Slack/Zoom means adding an adapter
 * that builds these; no common-layer type or code changes.
 */
export interface ReferenceField {
	/** Stable key — doubles as the frontmatter key and the prompt XML attribute name (e.g. "status", "channel"). */
	readonly key: string;
	/** Human-readable label for the tooltip (e.g. "Status", "Channel"). */
	readonly label: string;
	/** Pre-formatted display value; array-valued fields are joined with ", " by the adapter. */
	readonly value: string;
	/** Optional codicon name for the tooltip. Opaque to the common layer — passed straight to the renderer; a neutral default is used when absent. */
	readonly icon?: string;
}

/**
 * Reference — ephemeral, in-memory shape produced by a `SourceAdapter.extractRef`
 * call. Carries the cross-source core fields + an opaque `fields` bag for every
 * source-specific attribute. Persisted as markdown frontmatter by
 * `ReferenceStore.writeReferenceMarkdown`; metadata is split into `ReferenceEntry`
 * (registry) and the markdown body (description).
 */
export interface Reference {
	/** `<source>:<nativeId>` — registry map key in plans.json.references. Does NOT include a short-hash suffix. */
	readonly mapKey: string;
	readonly source: SourceId;
	/** Stable id native to the source (Linear ticket id, Jira key, `owner/repo#number`, 32-hex Notion page id). */
	readonly nativeId: string;
	readonly title: string;
	readonly url: string;
	readonly description?: string;
	/** Opaque, source-specific display fields. Built and consumed only by the adapter. */
	readonly fields?: ReadonlyArray<ReferenceField>;
	readonly toolName: string;
	readonly referencedAt: string;
}

/**
 * ReferenceEntry — persisted registry row in the `plans.json.references` map.
 *
 * Holds one row per external reference across every {@link SourceId}, keyed
 * `<source>:<nativeId>`. Unlike Plan / Note rows, a reference is DELETED from
 * the registry when its commit lands — its value-snapshot lives on in the
 * orphan branch's `CommitSummary.references`. So there is no archive row,
 * `contentHashAtCommit` guard, or ignored flag: every row here is an active,
 * uncommitted reference. The optional `branch` is persisted (not filtered on by
 * the CLI) so the IntelliJ plugin can branch-scope its shared CONTEXT view.
 */
export interface ReferenceEntry {
	readonly source: SourceId;
	readonly nativeId: string;
	readonly title: string;
	readonly url: string;
	/** Absolute path to `<jolliMemoryDir>/references/<source>/<sanitized-key>.md`. */
	readonly sourcePath: string;
	readonly addedAt: string;
	readonly updatedAt: string;
	/** MCP tool name that originally surfaced this reference. */
	readonly sourceToolName: string;
	/** Branch the reference was last captured on; see {@link PlanEntry.branch}. */
	readonly branch?: string;
}

/**
 * ReferenceCommitRef — multi-source reference snapshot stored in
 * `CommitSummary.references`. `archivedKey` is the POST-archive
 * `plans.json.references` map key (`<source>:<nativeId>-<shortHash>`); other
 * fields are a value-snapshot at archive time.
 */
export interface ReferenceCommitRef {
	/** Exact pointer into plans.json.references: `<source>:<nativeId>-<shortHash>`. */
	readonly archivedKey: string;
	readonly source: SourceId;
	readonly nativeId: string;
	readonly title: string;
	readonly url: string;
	/** Opaque, source-specific display fields — snapshot of the Reference's `fields` at archive time. */
	readonly fields?: ReadonlyArray<ReferenceField>;
	readonly referencedAt: string;
	readonly sourceToolName: string;
}

// ─── Knowledge Compilation types ────────────────────────────────────────────

/** A single compiled topic within a branch's knowledge page */
export interface CompiledTopic {
	readonly title: string;
	/**
	 * spec 110 — stable, lowercase-kebab slug supplied by the LLM that
	 * encodes the topic's *concept*, not its title. Same topic across
	 * future re-compiles / re-merges must reuse this slug so the
	 * derived wiki page (`<kbRoot>/_wiki/topic--<stableSlug>.md`)
	 * persists across runs and Obsidian backlinks don't break.
	 *
	 * Pre-spec110 artifacts may lack this field; `parseCompileResponse`
	 * falls back to `slugify(title)` and logs a WARN — the field is
	 * still `readonly string` in the live type so all new code can
	 * rely on it.
	 */
	readonly stableSlug: string;
	/** Markdown content: ## Background, ## Design Decisions, ## Pitfalls, etc. */
	readonly content: string;
	/** Branches that relate to this topic (LLM-inferred) */
	readonly relatedBranches?: ReadonlyArray<string>;
	/** Key design decisions distilled from source summaries */
	readonly keyDecisions?: ReadonlyArray<string>;
	/** Source commit hashes that contributed to this topic */
	readonly sourceCommits: ReadonlyArray<string>;
}

/** Git diff statistics */
export interface DiffStats {
	readonly filesChanged: number;
	readonly insertions: number;
	readonly deletions: number;
}

/** Git commit information */
export interface CommitInfo {
	readonly hash: string;
	readonly message: string;
	readonly author: string;
	readonly date: string;
}

/** Result of a git command execution */
export interface GitCommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

/** Lightweight index entry for the summary index file (v3 flat structure) */
export interface SummaryIndexEntry {
	readonly commitHash: string;
	/**
	 * Direct parent commit hash in the summary tree.
	 * - `null`      → top-level root (stored as `summaries/{commitHash}.json`)
	 * - `string`    → child node; follow chain to reach the root summary file
	 * - `undefined` → legacy v1 entry (treated as root for backward compat)
	 */
	readonly parentCommitHash: string | null | undefined;
	/** Git tree hash (from `git cat-file -p <commit>`); enables cross-branch matching */
	readonly treeHash?: string;
	/** How this commit was created — stored for quick display without loading full summary */
	readonly commitType?: CommitType;
	readonly commitMessage: string;
	readonly commitDate: string;
	readonly branch: string;
	readonly generatedAt: string;
	/** Topic count across the entire summary tree (for list badge display) */
	readonly topicCount?: number;
	/** Actual diff stats from `git diff --shortstat` — reflects the final commit result */
	readonly diffStats?: DiffStats;
	/**
	 * Runtime-only annotation: the repo this entry was loaded from when the
	 * caller aggregates entries across multiple repos (Memory Bank multi-repo
	 * view). Never written to `index.json` — orphan branches are per-repo, so
	 * persisting this would be redundant. `JSON.stringify` drops undefined
	 * fields, so an aggregator can safely assign this without leaking into
	 * any storage layer.
	 */
	readonly repoName?: string;
}

/** Index file stored in the orphan branch */
export interface SummaryIndex {
	readonly version: 1 | 3;
	readonly entries: ReadonlyArray<SummaryIndexEntry>;
	/**
	 * Cached commit hash aliases: `A → B` where A is an unknown commit hash that was
	 * matched to B via identical tree hash. Written once when found; read forever.
	 * Avoids repeated `git cat-file` calls for the same unrecognized commit hashes.
	 */
	readonly commitAliases?: Readonly<Record<string, string>>;
}

// ─── Catalog types (search/recall warm path) ─────────────────────────────────

/**
 * Single topic entry within a CatalogEntry — a denormalized projection of
 * `summary.topics[i]` (collected via `collectDisplayTopics` to handle v3/v4
 * differences) optimized for catalog scanning.
 *
 * Decisions are stored in full (no length cap) — catalog.json is cold path
 * and only loaded when /jolli-search or recall-catalog operations run.
 */
export interface CatalogTopic {
	readonly title: string;
	readonly decisions?: string;
	readonly category?: TopicCategory;
	readonly importance?: TopicImportance;
	readonly filesAffected?: ReadonlyArray<string>;
}

/**
 * Catalog entry — one per **root** commit (matches index entries with
 * `parentCommitHash === null`). Carries the high-signal denormalized fields
 * search needs to give an LLM enough context to pick relevant commits without
 * loading individual summary files.
 *
 * Foreign-key relationship to `SummaryIndexEntry.commitHash` — branch / date
 * metadata stays in index.json (hot path), rich content lives here (warm path).
 */
export interface CatalogEntry {
	readonly commitHash: string;
	readonly recap?: string;
	/**
	 * Ticket/issue identifier from the source summary.
	 * Note: `SummaryIndexEntry` does NOT carry `ticketId`; catalog.json is the
	 * authoritative source for this field.
	 */
	readonly ticketId?: string;
	readonly topics?: ReadonlyArray<CatalogTopic>;
}

/**
 * `catalog.json` file contents — sibling to `index.json` on the orphan branch.
 *
 * Lifecycle:
 * - **Write**: maintained alongside `index.json` by the same write path that
 *   stores summaries (storeSummary / migrateOneToOne / mergeManyToOne).
 * - **Lazy build**: when CLI reads catalog and finds it missing entries that
 *   exist as roots in index (e.g. IntelliJ wrote a commit but does not know
 *   about catalog.json), the missing entries are reconstructed from
 *   `summaries/<hash>.json` files and written back under the shared lock.
 * - **Bootstrap**: when catalog.json is absent entirely (legacy install or
 *   first-run on existing data), the same lazy-build path scans all root
 *   summaries and creates the file.
 *
 * Reconcile invariant: lazy build also REMOVES catalog entries whose hashes
 * are no longer roots in index (e.g. amend turned an old root into a child).
 * This prevents stale entries from leaking into search results.
 */
export interface CommitCatalog {
	readonly version: 1;
	readonly entries: ReadonlyArray<CatalogEntry>;
}

/**
 * Subset of {@link JolliMemoryConfig} containing only the fields needed for LLM calls.
 * Callers load the full config and pass this subset to Summarizer functions,
 * so those functions don't need to know *how* config was loaded.
 */
export type LlmConfig = Pick<JolliMemoryConfig, "apiKey" | "model" | "jolliApiKey" | "aiProvider">;

/** Configuration stored in .jolli/jollimemory/config.json */
export interface JolliMemoryConfig {
	readonly apiKey?: string;
	readonly model?: string;
	readonly maxTokens?: number;
	/** Glob patterns for excluding files from the VSCode Files panel */
	readonly excludePatterns?: ReadonlyArray<string>;
	/** Folder names (under localFolder) to skip during multi-repo `jolli compile`. Exact name or `*` glob. Default: none. */
	readonly compileExcludeFolders?: ReadonlyArray<string>;
	/** Jolli Space API key for pushing summaries and proxy LLM calls (sk-jol-...) */
	readonly jolliApiKey?: string;
	/** Enable Codex CLI session discovery at post-commit time (default: auto-detect) */
	readonly codexEnabled?: boolean;
	/** Enable Gemini CLI session tracking via AfterAgent hook (default: auto-detect) */
	readonly geminiEnabled?: boolean;
	/** Enable Claude Code session tracking via Stop hook (default: true) */
	readonly claudeEnabled?: boolean;
	/** Enable OpenCode session discovery at post-commit time (default: auto-detect) */
	readonly openCodeEnabled?: boolean;
	/** Enable Cursor Composer session discovery at post-commit time (default: auto-detect) */
	readonly cursorEnabled?: boolean;
	/** Enable GitHub Copilot CLI session discovery at post-commit time (default: auto-detect) */
	readonly copilotEnabled?: boolean;
	/** Global minimum log level written to debug.log (default: "info") */
	readonly logLevel?: LogLevel;
	/** Per-module log level overrides (e.g. { "GitOps": "debug" }) */
	readonly logLevelOverrides?: Readonly<Record<string, LogLevel>>;
	/** Absolute path to the user-chosen Memory Bank folder (mirrors orphan-branch
	 *  artifacts to disk when storageMode is "folder" or "dual-write"). */
	readonly localFolder?: string;
	/** OAuth auth token from browser login (stored by `jolli auth login`) */
	readonly authToken?: string;
	/**
	 * The Jolli server origin the user logged into via `jolli auth login`,
	 * persisted so space-cli can recover the tenant URL when `jolliApiKey` is
	 * missing or stale. Pure URL — no secret material. Trailing slash stripped
	 * on write to match `getJolliUrl`.
	 *
	 * Surface-local: written only by the CLI / VS Code login paths and read
	 * only by consumers running in the CLI process. IntelliJ keeps its own
	 * auth state in `config-intellij.json` and is intentionally not covered
	 * here — if a closed-source IntelliJ consumer ever needs the same
	 * fallback, mirror this persistence in the Kotlin auth flow.
	 */
	readonly jolliUrl?: string;
	/**
	 * Which AI summarization provider to use.
	 *  - "anthropic": call Anthropic directly using `apiKey`.
	 *  - "jolli":     call Jolli's proxy using `jolliApiKey`.
	 *
	 * Optional — when missing, surfaces derive a default (Jolli when signed in,
	 * Anthropic otherwise) so existing configs keep working.
	 */
	readonly aiProvider?: "anthropic" | "jolli";
	/**
	 * When true, plugin-initiated `git commit` / `--amend` / squash invocations
	 * pass `-s` to add a DCO `Signed-off-by:` trailer. Off by default. Read at
	 * each commit site; not cached. The `-s` flag is idempotent — git skips
	 * the trailer if an identical line already exists in the message.
	 */
	readonly dcoSignoff?: boolean;
	/**
	 * Whether to **auto-sync** Memory Bank to the user's private Personal
	 * Space vault on a recurring schedule. Plan §0.7 made manual sync the
	 * always-available default (the "Sync to Personal Space Now" button +
	 * `jolli sync-memory-bank`), so this flag scopes purely to the
	 * background polling tick — undefined / false means the plugin's poll
	 * loop never schedules itself, but a manual one-shot sync still works
	 * as long as `jolliApiKey` is configured.
	 *
	 * Off by default in v1; opt-in via the Settings UI "Auto-sync to
	 * Personal Space" toggle. The CLI explicitly rejects setting this via
	 * `jolli configure --set autoSyncEnabled=…` (auto-sync requires a
	 * polling tick that only the IDE plugin runs — the CLI is not a
	 * daemon), so this flag is plugin-only on the write side. See
	 * `ConfigureCommand`'s rejection branch and its test
	 * "rejects autoSyncEnabled — auto-sync is plugin-only".
	 *
	 * Renamed from `syncEnabled` (kept readable for back-compat — see
	 * `loadConfigFromDir`). New writes use this name only.
	 */
	readonly autoSyncEnabled?: boolean;
	/**
	 * @deprecated Legacy name for `autoSyncEnabled`. Still read by
	 * `loadConfigFromDir` for back-compat so users who toggled auto-sync
	 * on under the old name keep their setting after upgrading; the
	 * loader coalesces it into `autoSyncEnabled` and never writes this
	 * field again. Will be removed once existing installs roll over.
	 */
	readonly syncEnabled?: boolean;
	/**
	 * Include raw AI conversation transcripts (`.transcripts/<id>.txt`) when
	 * syncing. Off by default — transcripts can contain pasted credentials,
	 * proprietary code, or sensitive snippets, so the user must opt in.
	 */
	readonly syncTranscripts?: boolean;
	/**
	 * Plugin polling cadence for background sync rounds (seconds). Default
	 * 5400 (90 min) when unset; clamp to [60, 86400] in the consumer. Slow
	 * by design — the "Sync now" button covers urgency, and the post-commit
	 * auto-trigger was dropped in Phase 4 to keep `git commit` UX clean.
	 */
	readonly syncPollIntervalSec?: number;
	/**
	 * What the sync engine should do when conflict resolution exhausts
	 * Tier 1.5 (deterministic aggregate merge), Tier 2 (LLM merge), and
	 * Tier 2.7 (safe heuristics — empty-side / identical-after-normalize /
	 * base-aware delete-vs-modify / Memory Bank summary union).
	 *
	 * The upper tiers absorb the overwhelming majority of real conflicts
	 * losslessly; this field controls only the residual tail.
	 *
	 *   - `"prompt"` *(default)*: ask the UI's `promptBinaryPick` and
	 *     block on the user. Safe — never silently picks. In CLI / hook
	 *     contexts where no TTY is attached, `CliConflictUi` returns
	 *     `"skip"` and the conflict surfaces on the next round.
	 *   - `"mine"`: always keep the local side. Use when the source repo
	 *     is the canonical place to author memories and the personal-space
	 *     vault is purely a backup of THIS device.
	 *   - `"theirs"`: always accept the peer side. Use when another device
	 *     is the canonical author (e.g. the laptop is just a viewer).
	 *
	 * Earlier drafts shipped a `"newest"` policy that compared committer
	 * timestamps of `ORIG_HEAD` vs `HEAD`. It was removed because the
	 * engine's pre-pull-rebase reconcile commit always makes the local
	 * timestamp ≈ `Date.now()`, so `"newest"` degenerated to "mine
	 * always wins" while sounding semantically different to users.
	 */
	readonly syncConflictPolicy?: "prompt" | "mine" | "theirs";
	/**
	 * Random per-machine UUID minted on first run (JOLLI-1785). The anonymous
	 * telemetry identity — the conversion funnel's denominator. Stored
	 * machine-global in `~/.jolli/jollimemory/config.json` so it is ONE
	 * identity per machine across surfaces (the `surface` field distinguishes
	 * cli / vscode / intellij). Contains no PII; never derived from anything
	 * user-controlled. Mint via `getOrCreateInstallId` in `SessionTracker`.
	 */
	readonly installId?: string;
	/**
	 * Usage-telemetry opt state (JOLLI-1785). Opt-out model: telemetry is on
	 * unless this is explicitly `"off"`, the platform `DO_NOT_TRACK` signal is
	 * set, or (VS Code) `telemetry.telemetryLevel` is `"off"`. See
	 * `TelemetryConsent`.
	 */
	readonly telemetry?: "on" | "off";
	/**
	 * Set once the loud first-run telemetry notice has been shown on this
	 * machine, so it is not repeated every run. See `TelemetryConsent`.
	 */
	readonly telemetryNoticeShown?: boolean;
	/**
	 * AI sources already reported via the `ai_source_detected` telemetry event
	 * (JOLLI-1785). Machine-global first-seen ledger so the event fires once per
	 * source per machine rather than on every run — otherwise it would over-count
	 * and skew the AI-source-mix view. Source names only (e.g. "codex"), no PII.
	 */
	readonly telemetrySeenSources?: ReadonlyArray<string>;
}

/** Result of enable/disable operations */
export interface InstallResult {
	readonly success: boolean;
	readonly message: string;
	readonly warnings: ReadonlyArray<string>;
	/** Absolute path to the Claude Code settings file (set on successful install) */
	readonly claudeSettingsPath?: string;
	/** Absolute path to the git post-commit hook file (set on successful install) */
	readonly gitHookPath?: string;
	/** Absolute path to the git post-rewrite hook file (set on successful install) */
	readonly postRewriteHookPath?: string;
	/** Absolute path to the git prepare-commit-msg hook file (set on successful install) */
	readonly prepareMsgHookPath?: string;
	/** Absolute path to the git post-merge hook file (set on successful install) */
	readonly postMergeHookPath?: string;
	/** Absolute path to the Gemini CLI settings file (set on successful install when Gemini detected) */
	readonly geminiSettingsPath?: string;
}

/** Registry of all active sessions, keyed by session ID */
export interface SessionsRegistry {
	readonly version: 1;
	readonly sessions: Readonly<Record<string, SessionInfo>>;
}

/** Registry of transcript cursors, keyed by transcript path */
export interface CursorsRegistry {
	readonly version: 1;
	readonly cursors: Readonly<Record<string, TranscriptCursor>>;
}

/** Status information for `jollimemory status` */
export interface StatusInfo {
	readonly enabled: boolean;
	readonly claudeHookInstalled: boolean;
	readonly gitHookInstalled: boolean;
	/** Whether the Gemini AfterAgent hook is installed in .gemini/settings.json */
	readonly geminiHookInstalled: boolean;
	/**
	 * Whether the current worktree has all required per-worktree hooks installed
	 * for the integrations enabled in config.
	 */
	readonly worktreeHooksInstalled?: boolean;
	readonly activeSessions: number;
	readonly mostRecentSession: SessionInfo | null;
	readonly summaryCount: number;
	readonly orphanBranch: string;
	/** Whether Claude Code directory (~/.claude/) was detected */
	readonly claudeDetected?: boolean;
	/** Whether Codex CLI directory (~/.codex/) was detected */
	readonly codexDetected?: boolean;
	/** Whether Codex session discovery is enabled in config (undefined = auto-detect) */
	readonly codexEnabled?: boolean;
	/** Whether Gemini CLI directory (~/.gemini/) was detected */
	readonly geminiDetected?: boolean;
	/** Whether Gemini CLI session tracking is enabled in config (undefined = auto-detect) */
	readonly geminiEnabled?: boolean;
	/** Whether the global OpenCode database (~/.local/share/opencode/opencode.db) was detected */
	readonly openCodeDetected?: boolean;
	/** Whether OpenCode session discovery is enabled in config (undefined = auto-detect) */
	readonly openCodeEnabled?: boolean;
	/** Whether Cursor data dir was detected (Cursor.app + state.vscdb + node:sqlite) */
	readonly cursorDetected?: boolean;
	/** Whether Cursor session discovery is enabled in config (undefined = auto-detect) */
	readonly cursorEnabled?: boolean;
	/**
	 * Cursor DB scan failed with a real (non-ENOENT) error — corrupt, locked,
	 * schema drift, or permission denied. UI surfaces this adjacent to the Cursor
	 * row instead of silently rendering "0 sessions".
	 */
	readonly cursorScanError?: SqliteScanError;
	/** Whether Copilot CLI's session DB (~/.copilot/session-store.db) was detected */
	readonly copilotDetected?: boolean;
	/** Whether Copilot CLI session discovery is enabled in config (undefined = auto-detect) */
	readonly copilotEnabled?: boolean;
	/** Directory path for global config (~/.jolli/jollimemory) */
	readonly globalConfigDir?: string;
	/** Path to the worktree state directory */
	readonly worktreeStatePath?: string;
	/**
	 * Number of worktrees whose required per-worktree hooks are installed for the
	 * current integration configuration.
	 */
	readonly enabledWorktrees?: number;
	/**
	 * Hook installation source — semantically "the source currently selected by
	 * `run-hook`" (the highest-version source whose dist directory exists).
	 * In single-source setups this is just the only source; in multi-source setups
	 * it's the runtime that hooks will actually invoke.
	 */
	readonly hookSource?: string;
	/** Jolli Memory core version of the source currently selected by `run-hook`. */
	readonly hookVersion?: string;
	/**
	 * All registered installation sources from `~/.jolli/jollimemory/dist-paths/*`.
	 * Each entry shows source tag, version, dist path, and whether the path is
	 * still valid. Used by `jolli doctor` and (optionally) UI to show the full
	 * multi-source picture.
	 */
	readonly allSources?: ReadonlyArray<DistPathInfo>;
	/** Per-source session count breakdown, keyed by TranscriptSource */
	readonly sessionsBySource?: Partial<Record<TranscriptSource, number>>;
	/**
	 * OpenCode DB scan failed with a real (non-ENOENT) error — e.g. the DB is
	 * corrupt, locked, or the schema has drifted. When present, UI should show
	 * a warning adjacent to the OpenCode integration row rather than rendering
	 * "0 sessions" (which is indistinguishable from "no OpenCode activity").
	 */
	readonly openCodeScanError?: SqliteScanError;
	/** Copilot DB scan failed with a real (non-ENOENT) error. Same UI semantics as openCodeScanError. */
	readonly copilotScanError?: SqliteScanError;
	/** Whether vscode's Copilot Chat globalStorage dir was detected */
	readonly copilotChatDetected?: boolean;
	/** Copilot Chat scan failed with a real (non-ENOENT) error: parse / fs / schema. */
	readonly copilotChatScanError?: CopilotChatScanError;
	/**
	 * v5 schema migration state — surfaced in `jolli status` and the VSCode
	 * Hooks tooltip so users can see whether their on-disk data has been
	 * migrated. Absent state is the implicit "pending" — the migration will
	 * run on next opportunity (worker startup or explicit `jolli migrate`).
	 */
	readonly schemaV5?: "in-progress" | "completed" | "failed";
}

/**
 * Parsed contents of one `dist-paths/<source>` file.
 * Used by `getStatus()` and `jolli doctor` to enumerate registered runtime sources.
 */
export interface DistPathInfo {
	/** Source tag (e.g. "cli", "vscode", "cursor"). Filename of the dist-paths/ entry. */
	readonly source: string;
	/** Core version (`@jolli.ai/cli` semver) embedded in the file. */
	readonly version: string;
	/** Absolute path to the dist directory this source points to. */
	readonly distDir: string;
	/** True if `distDir` currently exists on disk. False entries are stale. */
	readonly available: boolean;
}

/** Hook data received via stdin from Claude Code */
export interface ClaudeHookInput {
	readonly session_id: string;
	readonly transcript_path: string;
	readonly cwd: string;
}

/** Represents a file operation in a single atomic commit to an orphan branch */
export interface FileWrite {
	readonly path: string;
	/** File content (ignored when `delete` is true) */
	readonly content: string;
	/** When true, removes this file from the branch instead of writing it */
	readonly delete?: boolean;
	/** Git branch this file belongs to. Used by FolderStorage to place visible copies in the correct branch directory. */
	readonly branch?: string;
}

/** Log levels for the Logger module */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Parameters for generating a commit message before committing.
 *
 * Only the staged diff and branch name are sent to the LLM — conversation
 * transcripts are intentionally excluded to keep the call fast and cheap.
 * The full transcript context is reserved for the post-commit summary.
 */
export interface CommitMessageParams {
	/** Output of `git diff --cached` — what is staged */
	readonly stagedDiff: string;
	/** Current branch name (used to extract ticket number) */
	readonly branch: string;
	/** List of staged file paths */
	readonly stagedFiles: ReadonlyArray<string>;
	/** LLM credentials and model selection loaded by the caller */
	readonly config: LlmConfig;
}

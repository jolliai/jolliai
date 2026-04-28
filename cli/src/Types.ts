/**
 * Jolli Memory Type Definitions
 *
 * Central type definitions for all modules in the Jolli Memory tool.
 */

/** Which AI coding agent produced the transcript */
export type TranscriptSource = "claude" | "codex" | "gemini" | "opencode";

/** Metadata about an AI coding session, saved by the Stop hook (Claude) or discovered on-demand (Codex) */
export interface SessionInfo {
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly updatedAt: string; // ISO 8601
	/** Which agent produced this session. Defaults to "claude" for backward compatibility. */
	readonly source?: TranscriptSource;
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

/** Result from reading a transcript file */
export interface TranscriptReadResult {
	readonly entries: ReadonlyArray<TranscriptEntry>;
	readonly newCursor: TranscriptCursor;
	readonly totalLinesRead: number;
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
 * A queued git operation waiting to be processed by the Worker.
 * Written to `.jolli/jollimemory/git-op-queue/{timestamp}-{hash}.json`.
 *
 * Each git operation (commit, amend, squash, rebase) writes one entry to the queue.
 * The Worker processes entries in timestamp order, ensuring dependency chains are correct
 * (e.g., a rebase-pick entry is always processed after the commit it references).
 */
export interface GitOperation {
	/** Operation type — determines how the Worker processes this entry */
	readonly type: "commit" | "amend" | "squash" | "rebase-pick" | "rebase-squash" | "cherry-pick" | "revert";
	/** Target commit hash */
	readonly commitHash: string;
	/** Source hashes: amend's oldHash, squash/rebase's source commit hashes */
	readonly sourceHashes?: ReadonlyArray<string>;
	/** Whether the operation was triggered from the VSCode plugin or CLI */
	readonly commitSource?: CommitSource;
	/** Creation time — used for queue ordering and transcript time-based attribution */
	readonly createdAt: string; // ISO 8601
}

/** Metadata from the LLM API call that generated this summary */
export interface LlmCallMetadata {
	/** Actual model used (from response, may differ from requested model due to aliasing) */
	readonly model: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	/** Wall-clock time for the API call in milliseconds */
	readonly apiLatencyMs: number;
	/** API stop reason — "max_tokens" indicates the summary may have been truncated */
	readonly stopReason: string | null;
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

/** How the commit was created (based on doc 34 §4.1 Hook participation matrix) */
export type CommitType = "commit" | "amend" | "squash" | "rebase" | "cherry-pick" | "revert";

/** Whether the operation was triggered from the VSCode plugin or CLI/other git client */
export type CommitSource = "cli" | "plugin";

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
	/** Number of Write/Edit tool operations on this plan in transcripts */
	readonly editCount: number;
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
	readonly branch: string;
	readonly commitHash: string | null;
	readonly editCount: number;
	/** SHA-256 hash of the plan file content when associated with a commit. Used as a guard to detect if the file was overwritten with new content. */
	readonly contentHashAtCommit?: string;
	/** When true, plan is hidden from PLANS panel (user removed it). Cleared if source file content changes. */
	readonly ignored?: boolean;
}

/** plans.json registry structure */
export interface PlansRegistry {
	readonly version: 1;
	readonly plans: Readonly<Record<string, PlanEntry>>;
	readonly notes?: Readonly<Record<string, NoteEntry>>;
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
	readonly branch: string;
	readonly commitHash: string | null;
	/** SHA-256 hash of note content when associated with a commit (archive guard) */
	readonly contentHashAtCommit?: string;
	/** When true, note is hidden from the panel */
	readonly ignored?: boolean;
	/** File path in .jolli/jollimemory/notes/<id>.md (all notes are file-backed) */
	readonly sourcePath?: string;
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

/**
 * Subset of {@link JolliMemoryConfig} containing only the fields needed for LLM calls.
 * Callers load the full config and pass this subset to Summarizer functions,
 * so those functions don't need to know *how* config was loaded.
 */
export type LlmConfig = Pick<JolliMemoryConfig, "apiKey" | "model" | "jolliApiKey">;

/** Configuration stored in .jolli/jollimemory/config.json */
export interface JolliMemoryConfig {
	readonly apiKey?: string;
	readonly model?: string;
	readonly maxTokens?: number;
	/** Glob patterns for excluding files from the VSCode Files panel */
	readonly excludePatterns?: ReadonlyArray<string>;
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
	/** Global minimum log level written to debug.log (default: "info") */
	readonly logLevel?: LogLevel;
	/** Per-module log level overrides (e.g. { "GitOps": "debug" }) */
	readonly logLevelOverrides?: Readonly<Record<string, LogLevel>>;
	/** Absolute path to the user-chosen folder for Push-to-Local output. */
	readonly localFolder?: string;
	/** Default push action for the summary details view.
	 *  "jolli" = Jolli Cloud only (default). "both" = Jolli Cloud + local folder. */
	readonly pushAction?: "jolli" | "both";
	/** OAuth auth token from browser login (stored by `jolli auth login`) */
	readonly authToken?: string;
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
	readonly openCodeScanError?: {
		readonly kind: "corrupt" | "locked" | "permission" | "schema" | "unknown";
		readonly message: string;
	};
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

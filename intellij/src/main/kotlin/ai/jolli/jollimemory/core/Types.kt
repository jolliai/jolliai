package ai.jolli.jollimemory.core

/**
 * JolliMemory Type Definitions — Kotlin port of Types.ts
 *
 * All data classes for the JolliMemory system. Uses Gson for JSON serialization.
 */

/** Which AI coding agent produced the transcript */
enum class TranscriptSource { claude, codex, gemini }

/** Metadata about an AI coding session */
data class SessionInfo(
    val sessionId: String,
    val transcriptPath: String,
    val updatedAt: String,
    val source: TranscriptSource? = null,
)

/** Cursor tracking position in a transcript file */
data class TranscriptCursor(
    val transcriptPath: String,
    val lineNumber: Int,
    val updatedAt: String,
)

/** A single parsed transcript entry from the JSONL file */
data class TranscriptEntry(
    val role: String, // "human" or "assistant"
    val content: String,
    val timestamp: String? = null,
)

/** Result from reading a transcript file */
data class TranscriptReadResult(
    val entries: List<TranscriptEntry>,
    val newCursor: TranscriptCursor,
    val totalLinesRead: Int,
)

/** A session's transcript data as stored in the orphan branch */
data class StoredSession(
    val sessionId: String,
    val source: TranscriptSource? = null,
    val transcriptPath: String? = null,
    val entries: List<TranscriptEntry>,
)

/** Structured transcript data for a commit */
data class StoredTranscript(
    val sessions: List<StoredSession>,
)

enum class TopicCategory { feature, bugfix, refactor, `tech-debt`, performance, security, test, docs, ux, devops }
enum class TopicImportance { major, minor }

/** Partial updates for a topic (used by the edit topic feature). */
data class TopicUpdates(
    val title: String? = null,
    val trigger: String? = null,
    val response: String? = null,
    val decisions: String? = null,
    val todo: String? = null,
    val filesAffected: List<String>? = null,
)

/** A single-topic summary within a commit */
data class TopicSummary(
    val title: String,
    val trigger: String,
    val response: String,
    val decisions: String,
    val todo: String? = null,
    val filesAffected: List<String>? = null,
    val category: TopicCategory? = null,
    val importance: TopicImportance? = null,
)

/** Temporary state for git merge --squash operations */
data class SquashPendingState(
    val sourceHashes: List<String>,
    val expectedParentHash: String,
    val createdAt: String,
)

/** Temporary state for git commit --amend */
data class AmendPendingState(
    val oldHash: String,
    val createdAt: String,
)

/** Metadata from the LLM API call */
data class LlmCallMetadata(
    val model: String,
    val inputTokens: Int,
    val outputTokens: Int,
    val apiLatencyMs: Long,
    val stopReason: String?,
)

/** How the commit was created */
enum class CommitType { commit, amend, squash, rebase, `cherry-pick`, revert }

/** Whether the operation was triggered from the plugin or CLI */
enum class CommitSource { cli, plugin }

/** Git diff statistics */
data class DiffStats(
    val filesChanged: Int = 0,
    val insertions: Int = 0,
    val deletions: Int = 0,
)

/** Git commit information */
data class CommitInfo(
    val hash: String,
    val message: String,
    val author: String,
    val date: String,
)

/** Complete summary for a single git commit (v3 tree format) */
data class CommitSummary(
    val version: Int = 3,
    val commitHash: String,
    val commitMessage: String,
    val commitAuthor: String,
    val commitDate: String,
    val branch: String,
    val generatedAt: String,
    val ticketId: String? = null,
    val commitType: CommitType? = null,
    val commitSource: CommitSource? = null,
    val transcriptEntries: Int? = null,
    val conversationTurns: Int? = null,
    val llm: LlmCallMetadata? = null,
    val stats: DiffStats? = null,
    val topics: List<TopicSummary>? = null,
    val children: List<CommitSummary>? = null,
    val jolliDocUrl: String? = null,
    val jolliDocId: Int? = null,
    val orphanedDocIds: List<Int>? = null,
    val treeHash: String? = null,
    val e2eTestGuide: List<E2eTestScenario>? = null,
    val plans: List<PlanReference>? = null,
    val notes: List<NoteReference>? = null,
)

/** A single E2E test scenario */
data class E2eTestScenario(
    val title: String,
    val preconditions: String? = null,
    val steps: List<String>,
    val expectedResults: List<String>,
)

/** Reference to a Claude Code plan file */
data class PlanReference(
    val slug: String,
    val title: String,
    val editCount: Int,
    val addedAt: String,
    val updatedAt: String,
    val jolliPlanDocUrl: String? = null,
    val jolliPlanDocId: Int? = null,
)

/** Persisted plan entry in plans.json registry */
data class PlanEntry(
    val slug: String,
    val title: String,
    val sourcePath: String,
    val addedAt: String,
    val updatedAt: String,
    val branch: String,
    val commitHash: String?,
    val editCount: Int,
    val contentHashAtCommit: String? = null,
    val ignored: Boolean? = null,
)

/** plans.json registry structure (contains both plans and notes) */
data class PlansRegistry(
    val version: Int = 1,
    val plans: Map<String, PlanEntry> = emptyMap(),
    val notes: Map<String, NoteEntry>? = null,
)

// ── Note types ─────────────────────────────────────────────────────────────

/** Storage format for notes */
enum class NoteFormat { markdown, snippet }

/** Persisted note entry in plans.json registry */
data class NoteEntry(
    val id: String,
    val title: String,
    val format: NoteFormat,
    val addedAt: String,
    val updatedAt: String,
    val branch: String,
    val commitHash: String?,
    /** SHA-256 hash of note content when associated with a commit (archive guard) */
    val contentHashAtCommit: String? = null,
    /** When true, note is hidden from the panel */
    val ignored: Boolean? = null,
    /** File path in .jolli/jollimemory/notes/<id>.md (all notes are file-backed) */
    val sourcePath: String? = null,
)

/** Reference to a note associated with a commit (stored in CommitSummary.notes) */
data class NoteReference(
    val id: String,
    val title: String,
    val format: NoteFormat,
    /** Snippet: content snapshot at archive time */
    val content: String? = null,
    val addedAt: String,
    val updatedAt: String,
    /** Full URL of the note article on Jolli Space after pushing */
    val jolliNoteDocUrl: String? = null,
    /** Server-side article ID for direct update on subsequent pushes */
    val jolliNoteDocId: Int? = null,
)

// ── Plan Progress types ────────────────────────────────────────────────────

/** Status of a single step in a plan */
enum class PlanStepStatus { completed, in_progress, not_started }

/** A single step within a plan progress evaluation */
data class PlanStep(
    val id: String,
    val description: String,
    val status: PlanStepStatus,
    val note: String? = null,
)

/** Intermediate result from the LLM evaluation (no commit metadata) */
data class PlanProgressEvalResult(
    val summary: String,
    val steps: List<PlanStep>,
    val llm: LlmCallMetadata,
)

/** Full artifact stored on the orphan branch (eval result + commit metadata) */
data class PlanProgressArtifact(
    val version: Int = 1,
    val commitHash: String,
    val commitMessage: String,
    val commitDate: String,
    val planSlug: String,
    val originalSlug: String,
    val summary: String,
    val steps: List<PlanStep>,
    val llm: LlmCallMetadata,
)

/** Lightweight index entry for the summary index file */
data class SummaryIndexEntry(
    val commitHash: String,
    val parentCommitHash: String? = null,
    val treeHash: String? = null,
    val commitType: CommitType? = null,
    val commitMessage: String,
    val commitDate: String,
    val branch: String,
    val generatedAt: String,
    val topicCount: Int? = null,
    val diffStats: DiffStats? = null,
)

/** Index file stored in the orphan branch */
data class SummaryIndex(
    val version: Int = 3,
    val entries: List<SummaryIndexEntry> = emptyList(),
    val commitAliases: Map<String, String>? = null,
)

/** Configuration stored in .jolli/jollimemory/config.json */
data class JolliMemoryConfig(
    val apiKey: String? = null,
    val model: String? = null,
    val maxTokens: Int? = null,
    val excludePatterns: List<String>? = null,
    val jolliApiKey: String? = null,
    val claudeEnabled: Boolean? = null,
    val codexEnabled: Boolean? = null,
    val geminiEnabled: Boolean? = null,
    val logLevel: String? = null,
    val logLevelOverrides: Map<String, String>? = null,
)

/** Registry of all active sessions */
data class SessionsRegistry(
    val version: Int = 1,
    val sessions: Map<String, SessionInfo> = emptyMap(),
)

/** Registry of transcript cursors */
data class CursorsRegistry(
    val version: Int = 1,
    val cursors: Map<String, TranscriptCursor> = emptyMap(),
)

/** Hook data received via stdin from Claude Code */
data class ClaudeHookInput(
    val session_id: String,
    val transcript_path: String,
    val cwd: String,
)

/** Represents a file operation in a single atomic commit to an orphan branch */
data class FileWrite(
    val path: String,
    val content: String,
    val delete: Boolean = false,
)

/** Parameters for generating a commit message */
data class CommitMessageParams(
    val stagedDiff: String,
    val branch: String,
    val stagedFiles: List<String>,
    val apiKey: String? = null,
    val model: String? = null,
)

/** Result of enable/disable operations */
data class InstallResult(
    val success: Boolean,
    val message: String,
    val warnings: List<String> = emptyList(),
    val claudeSettingsPath: String? = null,
    val gitHookPath: String? = null,
    val postRewriteHookPath: String? = null,
    val prepareMsgHookPath: String? = null,
    val geminiSettingsPath: String? = null,
)

/** Status information */
data class StatusInfo(
    val enabled: Boolean,
    val claudeHookInstalled: Boolean,
    val gitHookInstalled: Boolean,
    val geminiHookInstalled: Boolean = false,
    val activeSessions: Int,
    val mostRecentSession: SessionInfo? = null,
    val summaryCount: Int,
    val orphanBranch: String,
    val claudeDetected: Boolean? = null,
    val codexDetected: Boolean? = null,
    val codexEnabled: Boolean? = null,
    val geminiDetected: Boolean? = null,
    val geminiEnabled: Boolean? = null,
)

/** Log levels */
enum class LogLevel(val priority: Int) {
    debug(0), info(1), warn(2), error(3)
}

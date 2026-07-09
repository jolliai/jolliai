package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.core.references.ReferenceCommitRef
import ai.jolli.jollimemory.core.references.ReferenceEntry

/**
 * JolliMemory Type Definitions — Kotlin port of Types.ts
 *
 * All data classes for the JolliMemory system. Uses Gson for JSON serialization.
 */

/** Which AI coding agent produced the transcript */
enum class TranscriptSource { claude, codex, gemini, opencode, cursor, copilot, `copilot-chat` }

/** Metadata about an AI coding session */
data class SessionInfo(
    val sessionId: String,
    val transcriptPath: String,
    val updatedAt: String,
    val source: TranscriptSource? = null,
    /** Native title from the source (e.g. OpenCode DB title, Cursor composer name). */
    val title: String? = null,
)

/** Cursor tracking position in a transcript file */
data class TranscriptCursor(
    val transcriptPath: String,
    val lineNumber: Int,
    val updatedAt: String,
)

/**
 * Per-message AI token usage, parsed from the source transcript (e.g. Claude's
 * `message.usage`). Field names are the cross-implementation contract shared with
 * the cli/vscode (TS) side — keep them identical on both. Source mapping:
 *   input_tokens → inputTokens, output_tokens → outputTokens,
 *   cache_read_input_tokens → cacheReadTokens, cache_creation_input_tokens → cacheWriteTokens.
 */
data class MessageUsage(
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cacheReadTokens: Long = 0,
    val cacheWriteTokens: Long = 0,
    /**
     * The model that produced this turn (`message.model`), or "" when the source
     * didn't record it. Used to price the tokens per model; an empty/unknown id
     * is treated as unpriced. Last field with a default so positional
     * constructions elsewhere keep compiling.
     */
    val model: String = "",
)

/** A single parsed transcript entry from the JSONL file */
data class TranscriptEntry(
    val role: String, // "human" or "assistant"
    val content: String,
    val timestamp: String? = null,
    /** AI token usage for this (assistant) message, when the source reports it. */
    val usage: MessageUsage? = null,
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

/**
 * LEGACY aggregate token usage — retained only to deserialize summaries written
 * by older IntelliJ plugin versions (which stored a `tokenUsage` object). New
 * code writes and reads the cross-implementation canonical fields on
 * [CommitSummary] instead ([CommitSummary.conversationTokenBreakdown] /
 * [CommitSummary.conversationModels] / [CommitSummary.estimatedCostUsd]), which
 * are byte-for-byte identical to the CLI/VS Code (TS) schema. Do not write this.
 */
data class TokenUsage(
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cacheReadTokens: Long = 0,
    val cacheWriteTokens: Long = 0,
    val reportedSessions: Int = 0,
    val totalSessions: Int = 0,
)

/**
 * Per-segment conversation-token breakdown. **Cross-implementation contract —
 * identical to the TS `ConversationTokenBreakdown`; field names are the on-disk
 * JSON keys and MUST match.** `cached` is `cache_creation` tokens only;
 * `cache_read` is deliberately excluded (it's a cumulative per-turn running total
 * that inflates sums), so `input + output + cached` equals [CommitSummary.conversationTokens].
 */
data class ConversationTokenBreakdown(
    val input: Long = 0,
    val output: Long = 0,
    val cached: Long = 0,
)

/**
 * One conversation model's usage, normalised to the three segments the cost
 * formula prices. **Cross-implementation contract — identical to the TS
 * `ModelTokenUsage`.** `cached` is cache_creation (priced at the cache-write
 * rate); cache_read is excluded. `provider` comes from the price table.
 */
data class ModelTokenUsage(
    val model: String,
    val provider: String,
    val input: Long = 0,
    val output: Long = 0,
    val cached: Long = 0,
)

/**
 * Canonical conversation usage written to the shared summary — the tokens the
 * developer's AI tool spent on the work (distinct from [LlmCallMetadata], the
 * summarizer's own call). Mirrors the CLI/VS Code (TS) fields exactly so a Claude
 * commit is written, read, and priced identically across all three tools.
 * cache_read is excluded everywhere (see [ConversationTokenBreakdown]).
 */
data class ConversationUsage(
    /** Scalar total = input + output + cached. */
    val conversationTokens: Int,
    val breakdown: ConversationTokenBreakdown,
    /** Per-model split (one bucket per model; sessions can switch models mid-stream). */
    val models: List<ModelTokenUsage>,
    /**
     * Estimated USD cost of [models] via [ModelPricing] (list prices as of
     * [ModelPricing.PRICES_AS_OF]); null when nothing priced. A lower bound when
     * some models are absent from the table.
     */
    val estimatedCostUsd: Double?,
) {
    companion object {
        /**
         * Sums per-message usage across the given stored sessions into the
         * canonical shape, EXCLUDING cache_read, and prices it per model. Returns
         * null when no session reported any usage (so callers render "N/A" rather
         * than a misleading zero).
         */
        fun aggregate(sessions: List<StoredSession>): ConversationUsage? {
            if (sessions.isEmpty()) return null
            var input = 0L
            var output = 0L
            var cached = 0L // cache_creation only; cache_read excluded
            var reported = 0
            val byModel = LinkedHashMap<String, ModelTokenUsage>()
            for (session in sessions) {
                var sessionReported = false
                for (entry in session.entries) {
                    val u = entry.usage ?: continue
                    input += u.inputTokens
                    output += u.outputTokens
                    cached += u.cacheWriteTokens
                    val prev = byModel[u.model]
                    byModel[u.model] = if (prev != null) {
                        prev.copy(
                            input = prev.input + u.inputTokens,
                            output = prev.output + u.outputTokens,
                            cached = prev.cached + u.cacheWriteTokens,
                        )
                    } else {
                        ModelTokenUsage(
                            u.model,
                            ModelPricing.providerOf(u.model),
                            u.inputTokens,
                            u.outputTokens,
                            u.cacheWriteTokens,
                        )
                    }
                    sessionReported = true
                }
                if (sessionReported) reported++
            }
            if (reported == 0) return null
            val models = byModel.values.toList()
            val cost = ModelPricing.estimateCostUsd(models).takeIf { it > 0.0 }
            return ConversationUsage(
                conversationTokens = (input + output + cached).toInt(),
                breakdown = ConversationTokenBreakdown(input, output, cached),
                models = models,
                estimatedCostUsd = cost,
            )
        }
    }
}

/** Metadata from the LLM API call */
data class LlmCallMetadata(
    val model: String,
    val inputTokens: Int,
    val outputTokens: Int,
    val apiLatencyMs: Long,
    val stopReason: String?,
    /** Which credential source produced this summary (e.g. "anthropic-config", "jolli-proxy"). */
    val source: String? = null,
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
    val conversationTokens: Int? = null,
    /** Per-segment split of [conversationTokens]. Cross-impl canonical (TS-identical). */
    val conversationTokenBreakdown: ConversationTokenBreakdown? = null,
    /** Per-model split of the conversation tokens; feeds [estimatedCostUsd]. Cross-impl canonical. */
    val conversationModels: List<ModelTokenUsage>? = null,
    /** Estimated USD cost of [conversationModels] at list prices as of [pricesAsOf]. Cross-impl canonical. */
    val estimatedCostUsd: Double? = null,
    /** Date of the price table used for [estimatedCostUsd] (ModelPricing.PRICES_AS_OF). */
    val pricesAsOf: String? = null,
    val llm: LlmCallMetadata? = null,
    /** LEGACY: token usage written by older IntelliJ versions. Read-only fallback; not written. */
    val tokenUsage: TokenUsage? = null,
    val stats: DiffStats? = null,
    val topics: List<TopicSummary>? = null,
    val children: List<CommitSummary>? = null,
    val jolliDocUrl: String? = null,
    val jolliDocId: Int? = null,
    val orphanedDocIds: List<Int>? = null,
    val unresolvedOrphanHashes: List<String>? = null,
    val treeHash: String? = null,
    val recap: String? = null,
    val e2eTestGuide: List<E2eTestScenario>? = null,
    val plans: List<PlanReference>? = null,
    val notes: List<NoteReference>? = null,
    val references: List<ReferenceCommitRef>? = null,
    val summaryError: String? = null,
    val transcripts: List<String>? = null,
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
    val branch: String? = null,
    val commitHash: String?,
    val editCount: Int = 0,
    val contentHashAtCommit: String? = null,
    val ignored: Boolean? = null,
)

/** plans.json registry structure (contains both plans and notes) */
data class PlansRegistry(
    val version: Int = 1,
    val plans: Map<String, PlanEntry> = emptyMap(),
    val notes: Map<String, NoteEntry>? = null,
    val references: Map<String, ReferenceEntry>? = null,
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

/** Configuration stored in .jolli/jollimemory/config-intellij.json */
data class JolliMemoryConfig(
    val apiKey: String? = null,
    val model: String? = null,
    val maxTokens: Int? = null,
    val excludePatterns: List<String>? = null,
    val jolliApiKey: String? = null,
    val authToken: String? = null,
    val claudeEnabled: Boolean? = null,
    val codexEnabled: Boolean? = null,
    val geminiEnabled: Boolean? = null,
    val openCodeEnabled: Boolean? = null,
    val cursorEnabled: Boolean? = null,
    val copilotEnabled: Boolean? = null,
    /**
     * Tri-state consent for the machine-global skill-preference block written into
     * ~/.claude/CLAUDE.md, ~/.gemini/GEMINI.md, ~/.codex/AGENTS.md: "enabled" /
     * "disabled" / null (undecided). Cross-surface: persisted in the shared
     * config.json so CLI / VS Code / IntelliJ agree. See GlobalInstructionsInstaller.
     */
    val globalInstructions: String? = null,
    /** AI summarization provider: "jolli" (proxy) or "anthropic" (direct). null defers to legacy "Anthropic wins" routing. */
    val aiProvider: String? = null,
    val logLevel: String? = null,
    val logLevelOverrides: Map<String, String>? = null,
    val knowledgeBasePath: String? = null,
    val knowledgeBaseSort: String? = null,  // "date" | "name"
    val storageMode: String? = null,        // "orphan" | "dual-write" | "folder"
    /** When true, hooks are uninstalled and the plugin is paused without losing config. */
    val paused: Boolean? = null,
    /** Whether auto-sync polling is enabled (default true). */
    val autoSyncEnabled: Boolean? = null,
    /** Poll interval in seconds for sync orchestrator. */
    val syncPollIntervalSec: Int? = null,
    /** Whether to sync transcripts to the vault. */
    val syncTranscripts: Boolean? = null,
    /** Custom local folder path for the memory bank root. */
    val localFolder: String? = null,
    /** Folder names (or `*`-glob patterns) under the Memory Bank root to skip when building the wiki. */
    val compileExcludeFolders: List<String>? = null,
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
    val branch: String? = null,
)

/** Parameters for generating a commit message */
data class CommitMessageParams(
    val stagedDiff: String,
    val branch: String,
    val stagedFiles: List<String>,
    val apiKey: String? = null,
    val model: String? = null,
    val jolliApiKey: String? = null,
    val aiProvider: String? = null,
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
    val openCodeDetected: Boolean? = null,
    val openCodeEnabled: Boolean? = null,
    val openCodeScanError: SqliteScanError? = null,
    val cursorDetected: Boolean? = null,
    val cursorEnabled: Boolean? = null,
    val cursorScanError: SqliteScanError? = null,
    val copilotDetected: Boolean? = null,
    val copilotEnabled: Boolean? = null,
    val copilotScanError: SqliteScanError? = null,
    val copilotChatDetected: Boolean? = null,
    val copilotChatScanError: CopilotChatScanError? = null,
    /** Node.js resolvable on PATH — required for the MCP server + full skill set. */
    val nodeAvailable: Boolean = true,
    /** MCP + full skills are set up (bundled CLI extracted and version-matched). */
    val integrationsActive: Boolean = false,
)

/** Log levels */
enum class LogLevel(val priority: Int) {
    debug(0), info(1), warn(2), error(3)
}

// ── Active Conversations types ─────────────────────────────────────────────

/** A session enriched with display data for the active conversations panel. */
data class ActiveConversationItem(
    val sessionId: String,
    val source: TranscriptSource,
    val title: String,
    val messageCount: Int,
    val updatedAt: String,
    val transcriptPath: String,
    /**
     * Per-commit-selection signal. `false` = user has unchecked this row;
     * the QueueWorker will skip its transcript when generating the next
     * summary. Default `true` for any row absent from commit-selection state.
     */
    val isSelected: Boolean = true,
)

/** Result envelope from the active session aggregator. */
data class ActiveConversationsResult(
    val items: List<ActiveConversationItem>,
    val failedSources: List<TranscriptSource>,
)

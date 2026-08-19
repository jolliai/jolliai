/**
 * Jolli Memory Type Definitions
 *
 * Central type definitions for all modules in the Jolli Memory tool.
 */

import type { ClineScanError } from "./core/ClineTranscriptShared.js";
import type { CopilotChatScanError } from "./core/CopilotChatTranscriptReader.js";
import type { MemoryBankState } from "./core/KBTypes.js";
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
	"cursor-cli",
	"copilot",
	"copilot-chat",
	"cline",
	"cline-cli",
	"devin",
	"antigravity",
	"kimi",
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
/**
 * Independently-resumable transcript extractors sharing `discovery-cursors.json`.
 *
 * Each advances its own high-water mark, so adding one never strands data behind
 * a mark advanced by a dist that did not know it existed.
 */
export type DiscoveryExtractor = "plans" | "references" | "skills" | "owners";

export interface TranscriptCursor {
	readonly transcriptPath: string;
	readonly lineNumber: number;
	readonly updatedAt: string; // ISO 8601
	/**
	 * Opaque, source-defined resume anchor for transcripts whose ordering is
	 * NOT a stable append-only stream — e.g. Devin's `message_nodes` forest,
	 * where a regeneration re-points the accepted chain and invalidates a raw
	 * positional `lineNumber`. When set, the reader resolves the resume point
	 * by locating this anchor in the freshly-rebuilt sequence and falls back to
	 * a full re-read if it has been regenerated away, rather than silently
	 * skipping content. Linear sources leave this undefined and rely on
	 * `lineNumber`.
	 */
	readonly anchorId?: string;
	/**
	 * Per-extractor high-water marks for `discovery-cursors.json`.
	 *
	 * `lineNumber` alone is a single shared mark, which strands data across version
	 * skew: a dist that knows nothing of a newer extractor still advances the shared
	 * mark, and the newer dist resuming from it never re-reads those lines. Since
	 * old dists are already in the field, the mark could not be added after the
	 * extractor that needs it.
	 *
	 * A missing key means "this extractor has never run here" and reads as 0 — a
	 * full rewind for that extractor ONLY, leaving its siblings' progress alone.
	 * Legacy records carrying a bare `lineNumber` credit it to the extractors that
	 * predate this field ({@link LEGACY_COVERED_EXTRACTORS}), never to newer ones.
	 */
	readonly extractors?: Readonly<Partial<Record<DiscoveryExtractor, number>>>;
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

/**
 * One transcript line's usage, plus an optional identity for de-duplicating the
 * SAME model response reported on more than one line.
 *
 * Claude Code writes one JSONL line per content block of an assistant response
 * (a `thinking` block, a `text` block, and one line per parallel `tool_use`),
 * and EVERY one of those lines carries a verbatim copy of that response's single
 * `message.usage` object — not a per-block share of it. Summing per line
 * therefore counts one API call's tokens once per block: measured against real
 * transcripts the inflation runs 2.2×–10×, the high end being agentic turns that
 * fire six or seven tool calls from one response.
 *
 * `dedupKey` is that response's identity (`message.id` for Claude). The reader
 * keeps a per-read set of keys it has already counted and skips repeats, so a
 * response contributes exactly once no matter how many lines carry it. Omitted
 * when a source cannot identify the response, in which case every line counts
 * (the pre-existing behaviour, correct for sources that report usage once).
 */
export interface ParsedTurnUsage extends ConversationTokenBreakdown {
	readonly dedupKey?: string;
	/**
	 * Transcript model id for THIS response, when the line carries it.
	 *
	 * Present so the reader can emit one {@link SessionUsageEvent} per response
	 * without a second pass: a per-model split derived from whole-slice
	 * aggregation cannot say WHEN each model was used, and "when" is the whole
	 * point of the per-call record.
	 */
	readonly model?: string;
}

/**
 * One counted model response: what it cost and **when it happened**.
 *
 * The unit every usage and billing system records, and the reason this shape
 * exists: a session is a grouping, not a quantity. Storing one cumulative total
 * per session with a single timestamp cannot answer "how many tokens did I use
 * on the 1st" for any conversation that spans days — the whole session lands on
 * whichever day it was last touched. Recording the call keeps the question
 * answerable by a plain `GROUP BY`.
 *
 * `respondedAtMs` is the response's own instant, taken from the transcript line that
 * carried it. Absent when the source's parser cannot date a line; such an event
 * is dropped rather than dated by guesswork, because a wrong day is worse than a
 * missing one here.
 */
export interface SessionUsageEvent extends ConversationTokenBreakdown {
	readonly respondedAtMs: number;
	/** Empty string when the transcript recorded usage without naming a model. */
	readonly model: string;
	/** The response's identity, when the source can name it. See {@link ParsedTurnUsage}. */
	readonly dedupKey?: string;
	/**
	 * USD at the price table in force when this was recorded. Absent for an
	 * unpriced model — absent rather than 0, because 0 reads as "free" in every
	 * sum while the truth is "unknown". Filled by the collector, not the reader:
	 * pricing is not the transcript's business.
	 */
	readonly estCostUsd?: number;
}

/** Billing provider for a conversation model — selects the pricing formula. */
export type TokenProvider = "anthropic" | "openai" | "unknown";

/**
 * One conversation model's token usage, normalised into the three disjoint
 * segments the cost formula prices (`input·inRate + cached·cachedRate +
 * output·outRate`). See `core/Pricing.ts` for the segment contract — in short:
 * `input` is uncached input only, `cached` is whatever is billed at the model's
 * cached rate, `output` includes reasoning tokens. Sessions can switch models
 * mid-stream, so a commit may carry several of these (one per model seen).
 */
export interface ModelTokenUsage {
	/** Exact transcript model id (`message.model` / `turn_context.payload.model`). */
	readonly model: string;
	readonly provider: TokenProvider;
	readonly input: number;
	readonly output: number;
	readonly cached: number;
}

/** Result from reading a transcript file */
/** How a tool call is attributed on the dashboard. */
export type ToolCallKind = "builtin" | "mcp" | "skill";

/** One tool, with how many times a slice called it. */
export interface ToolCallCount {
	/** Display name: `Bash`, `linear.list_issues`, `code-review`. */
	readonly name: string;
	readonly kind: ToolCallKind;
	/** MCP server the tool belongs to. Present only when `kind` is `"mcp"`. */
	readonly server?: string;
	/**
	 * Plugin that provides the skill. Present only when `kind` is `"skill"`.
	 *
	 * A separate field from {@link server} rather than a reuse of it, even though both
	 * name "where the tool came from": they are indexed and queried differently (the
	 * MCP card rolls up by `server`), so a plugin label stored there would join those
	 * roll-ups as a phantom server.
	 *
	 * Absent means the skill has no namespace, which is the common case — not that its
	 * namespace is unknown. A name two plugins both claim is also absent rather than
	 * attributed to whichever was seen first; see `observeSkillEntry`.
	 */
	readonly plugin?: string;
	readonly calls: number;
	/**
	 * When the LAST call in this bucket was made, from the transcript line that
	 * recorded it — NOT the session's own clock and NOT any commit's.
	 *
	 * A tool call is an event with its own instant, and the two times it used to
	 * be approximated by are both wrong in a way that shows: a session's
	 * `updatedAt` moves every time the conversation is touched afterwards (so a
	 * call made three weeks ago reads as today's), and a commit date has no
	 * relationship to it at all — an agent turn may precede its commit by hours
	 * or produce no commit ever. The dashboard windows recall activity by this
	 * field for exactly that reason.
	 *
	 * LAST, not first, and one instant for the whole bucket: a bucket counts N
	 * calls of the same tool in one session, so a bucket that straddles a window
	 * boundary is counted wholly inside the window its last call fell in. Splitting
	 * it would need a row per call, which is a different table; being off by the
	 * span of one session's repeated calls is a far smaller error than being off
	 * by however long ago that session was last touched.
	 *
	 * Absent when the source's parser has no timestamp to offer (see
	 * {@link ToolUseTally} for which do) — readers of this field must fall back
	 * rather than treat absence as "never called".
	 */
	readonly lastCallAtMs?: number;
	/**
	 * Tokens spent under this bucket, when the source can attribute them.
	 *
	 * Only ever set on `kind: "skill"` buckets: a skill owns a bounded stretch of
	 * the conversation that attribution can delimit, while a builtin or MCP call is
	 * one step inside a turn whose spend belongs to the turn, not to the tool. So an
	 * absent value here is the normal case, not a gap to be filled later.
	 *
	 * Absent, NEVER a zeroed {@link SkillUsage}: the sources divide into ones that
	 * attribute (Claude), ones that estimate (OpenCode) and ones that report nothing
	 * at all (Codex, Kimi, Cursor), and a stored zero would claim the third group's
	 * skills were free. `confidence` carries which of the first two produced a value.
	 */
	readonly usage?: SkillUsage;
	/**
	 * The individual entries behind {@link calls}, for the per-invocation record.
	 *
	 * Only ever set on `kind: "skill"` buckets, for the same reason {@link usage} is:
	 * a skill entry is an event with its own timestamp, outcome and injected body,
	 * while a builtin or MCP call is one step inside a turn that carries none of
	 * those separately.
	 *
	 * `calls` is NOT derivable from this array's length and must stay independent.
	 * Two reasons, both real: a Codex CLI bucket deliberately reports one invocation
	 * per session no matter how many paged reads produced it (see
	 * `scanCodexSkillLines`), and a bucket recovered from an already-archived commit
	 * carries a count with no invocations at all.
	 *
	 * Absent means "this bucket has no per-invocation record", which is the normal
	 * state for a count merged in from a `SkillCommitRef` — never "it ran zero times".
	 */
	readonly invocations?: ReadonlyArray<SkillInvocation>;
	/**
	 * Whether the invocations in this bucket were OBSERVED or inferred.
	 *
	 * Skill-level rather than per-invocation, matching {@link SkillUse.detection},
	 * and copying it down to each invocation is lossless: one scan pass emits a
	 * single nature per skill (`scanCodexSkillLines` drops its inferred entry
	 * outright when an observed one claimed the same name), so a bucket never mixes
	 * the two.
	 *
	 * Absent means observed. Present means the entry was inferred from a shell read
	 * of a `SKILL.md`, which cannot distinguish an agent using a skill from a human
	 * reading it and cannot count entries — see `CodexSkillScanner`.
	 */
	readonly detection?: "heuristic";
}

/**
 * One recall call's outcome, as the code that SERVED it saw it.
 *
 * Derived from the `RecallResult` union `resolveRecall` returned (see
 * `recallOutcomeOf`) at the moment of the call, by whichever surface answered
 * it — the MCP `recall` tool or the `jolli recall` CLI. `hit` is false for both
 * `catalog` (branch had no exact match) and `error` (nothing recorded at all):
 * either way the caller got no commit content to work with.
 *
 * This used to be recovered afterwards by parsing Claude's transcript for the
 * `tool_result` answering each `mcp__jollimemory__recall` block, which made
 * three whole classes of recall invisible — every CLI run, every non-Claude
 * agent, and anything older than the 48 h `sessions.json` retention window
 * that no live hook happened to catch. Observing the call where it is answered
 * covers all three and lands the row immediately instead of at the end of the
 * agent's turn.
 */
export interface RecallOutcome {
	readonly hit: boolean;
	readonly commitCount: number;
	/** Hash + date of each commit served. Empty for a miss. */
	readonly commits: ReadonlyArray<{ readonly hash: string; readonly date: string }>;
	/** Epoch ms of the call itself. */
	readonly atMs?: number;
}

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
	/** Per-model split of the usage read over the slice, one bucket per model the
	 *  transcript attributed tokens to (sessions can switch models mid-stream).
	 *  Powers the USD cost estimate. Absent for sources whose parser exposes no
	 *  usage; the summed segments equal {@link usageBreakdown}. */
	readonly usageByModel?: ReadonlyArray<ModelTokenUsage>;
	/** One entry per counted response, each carrying its own instant — the record
	 *  a per-day figure can actually be built from (see {@link SessionUsageEvent}).
	 *  {@link usageByModel} is the same numbers with the time thrown away, kept
	 *  because the summary stores the aggregate. Present-but-empty (never
	 *  omitted) for a source whose parser can report usage at all, so a re-read
	 *  that sees nothing datable can clear rows a better read left behind;
	 *  absent only for sources whose parser exposes no usage. Entries the parser
	 *  cannot date are omitted. */
	readonly usageEvents?: ReadonlyArray<SessionUsageEvent>;
	/** Tool calls over the slice, one bucket per distinct tool. ABSENT means the
	 *  source's transcripts carry no tool records this runtime can read — see
	 *  `TOOL_RECORDING_SOURCES` for which sources those are and why the list is
	 *  evidence-gated; an EMPTY array means the slice genuinely called no tools. Consumers
	 *  must keep the two apart — reporting an uncovered agent as "used no tools"
	 *  is the failure mode this distinction exists to prevent. */
	readonly toolUse?: ReadonlyArray<ToolCallCount>;
	/** Count of consumed rows whose conversation schema the parser did not
	 *  recognize — the format-drift canary (JOLLI-2240). Computed independently of
	 *  {@link entries}/{@link toolUse}, so a slice can carry usage and tool calls
	 *  yet still report drift. Omitted (not 0) when the slice was fully recognized,
	 *  so presence is itself the signal. The cursor gate withholds a zero-entry
	 *  slice with a non-zero count so a fixed build re-reads it. */
	readonly unrecognizedRows?: number;
}

// ─── Stored transcript types (orphan branch persistence) ─────────────────────

/** A session's transcript data as stored in the orphan branch (`transcripts/{commitHash}.json`) */
export interface StoredSession {
	readonly sessionId: string;
	readonly source?: TranscriptSource;
	/** Original JSONL file path, preserved for re-summarize (future) */
	readonly transcriptPath?: string;
	/**
	 * The session's display title as of this commit, resolved by
	 * `resolveArchivedTitle` when the memory was written.
	 *
	 * The answer, deliberately, rather than leaving every reader to re-derive it
	 * from {@link transcriptPath}. That path is machine-local and the file behind
	 * it is pruned on the agent's own schedule, so re-derivation fails exactly
	 * where it matters most: an old memory, and every memory on a machine that
	 * did not write it. This archive is the only artifact that travels.
	 *
	 * Forward-only, like {@link usage} and {@link toolUse}: absent on memories
	 * written before this field existed, and absent when no title could be
	 * resolved at all. Readers must treat absence as "not recorded" and fall back
	 * to whatever they used before, never as "this session has no title".
	 */
	readonly title?: string;
	readonly entries: ReadonlyArray<TranscriptEntry>;
	/**
	 * This session's own share of the commit's conversation tokens — the
	 * per-session attribution the queue worker already computes in memory while
	 * reading slices, now persisted so it survives the write.
	 *
	 * Without it, detaching one conversation from a committed memory cannot
	 * update that memory's token total: the summary stores only the post-merge
	 * aggregate, so there is no way to know how much of it belonged to the
	 * session being removed. Forward-only — absent on memories written before
	 * this field existed, and on sources whose transcript carries no usage; a
	 * detach that finds no `usage` leaves the token total untouched rather than
	 * guessing at a subtrahend.
	 */
	readonly usage?: ConversationTokenBreakdown;
	/** Per-model split of {@link usage}, so a detach can also correct the cost
	 *  estimate (which is priced per model, not from the aggregate). */
	readonly usageByModel?: ReadonlyArray<ModelTokenUsage>;
	/**
	 * Tool / MCP / skill calls this session made in the slices this commit owns.
	 *
	 * Persisted because the raw transcript is the ONLY other place this exists,
	 * and it outlives the commit by weeks at most: `sessions.json` is pruned to
	 * what is live, and the agent clears its own JSONL on its own retention
	 * schedule. Measured before this field existed — a machine with a month of
	 * transcripts on disk had tool records for the last 3 days and nothing
	 * before, because whatever slice first recorded a session was all any later
	 * pass ever saw.
	 *
	 * Forward-only, exactly like {@link usageByModel}: absent on every memory
	 * written before this field, and absent for sources whose parser cannot see
	 * tool calls at all (`TOOL_RECORDING_SOURCES`). Consumers must treat absence
	 * as "not recorded" and leave what they already have alone — never as "this
	 * session called no tools", which is the positive fact an empty array
	 * carries.
	 */
	readonly toolUse?: ReadonlyArray<ToolCallCount>;
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
	/**
	 * The agent session (`CLAUDE_CODE_SESSION_ID`) whose process executed this
	 * git operation, captured at enqueue time from the hook's inherited env.
	 *
	 * This is authorship evidence the ledger cannot supply on its own: a session
	 * running in worktree A that commits into worktree B leaves no cwd trace in
	 * B, so B's drain would attribute the commit to nothing. The worker uses this
	 * to add that session as a candidate and, when the forward ledger has not yet
	 * recorded a B-ownership edge (the edit and the commit happened in one turn,
	 * before the Stop hook ran), to synthesize the owner lower bound from the
	 * session's own transcript. Absent for a plain-terminal / GUI commit and for
	 * hosts that advertise no session id — see [AgentSessionEnv.ts](./core/AgentSessionEnv.js).
	 */
	readonly executingSessionId?: string;
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
export type LlmCredentialSource = "anthropic-config" | "anthropic-env" | "jolli-proxy" | "local-agent";

/** Which local-agent CLI tool drives generation when aiProvider === "local-agent". */
export type LocalAgentToolId = "claude-code" | "codex" | "cursor-agent" | "opencode" | "kimi";

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
	/** For source === "local-agent": which tool produced it, for footer attribution. Absent on older summaries. */
	readonly localAgentTool?: LocalAgentToolId;
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
 *   - "local-agent-auth": a more specific "llm-failed" — the local-agent
 *     provider's `claude` login expired / is not signed in (a
 *     LocalAgentAuthError). Behaves exactly like "llm-failed" for storage and
 *     the regenerate affordance, but lets surfaces (the SessionStart reminder,
 *     the post-commit output) show sign-in guidance instead of a generic
 *     failure. Written only on the fresh-commit path; amend/squash keep
 *     "llm-failed" (their LLM error is reduced to a status inside the
 *     Summarizer before it can be classified).
 */
export type SummaryErrorKind = "llm-failed" | "local-agent-auth";

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
	/** Per-model split of the conversation tokens consumed into this commit, one
	 *  bucket per model seen (sessions can switch models mid-stream). Distinct
	 *  from {@link llm} (which is Jolli's OWN summarization call, not the user's
	 *  conversation). Feeds {@link estimatedCostUsd}. Forward-only; consolidated
	 *  roots aggregate children. */
	readonly conversationModels?: ReadonlyArray<ModelTokenUsage>;
	/** Estimated USD cost of {@link conversationModels} at list prices as of
	 *  {@link pricesAsOf}. A lower bound when the conversation used a model absent
	 *  from the price table (those tokens are excluded, never guessed). Excludes
	 *  promotional/batch/volume discounts. Forward-only; roots aggregate children. */
	readonly estimatedCostUsd?: number;
	/** Date of the price table used to compute {@link estimatedCostUsd} (from
	 *  `core/Pricing.ts` PRICES_AS_OF), so a reader can judge staleness. */
	readonly pricesAsOf?: string;
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
	/**
	 * Full URL of the memory article on Jolli Space after pushing. Its origin also
	 * IS the env the `jolliDocId` was minted against: `jolliDocId` is reused as an
	 * update target only when `deriveJolliEnvKey(jolliDocUrl)` matches the current
	 * push env (see `canReuseDocId`), so an id from another backend is never reused.
	 */
	readonly jolliDocUrl?: string;
	/** Server-side article ID for direct update on subsequent pushes (set after first push) */
	readonly jolliDocId?: number;
	/**
	 * Full URL / id of the pushed SKILL-USAGE article (docType `skill`) — the commit's
	 * whole skill aggregate, one document per commit.
	 *
	 * **On the summary, not on a `SkillCommitRef`, and that is the point.** The article
	 * covers the commit, exactly like the Memory Bank's `skills--<hash8>.md` and the
	 * single "Skills used" Context row; there is no one skill it belongs to. Holding the
	 * id on a representative ref instead — as this briefly did — put a commit-level
	 * identity inside `mergeSkillRef`'s per-ref inheritance rules, which fold refs by
	 * `<source>:<skill>`: a squash whose root and child had each been pushed left TWO
	 * refs carrying an id from two different aggregate articles, the push reused
	 * whichever sorted first (silently retitling another commit's article) and the other
	 * became an orphan no cleanup path could see, because `supersededDocIds` only fires
	 * when both sides of ONE fold carry an id.
	 *
	 * Squash/rebase treat it exactly like `jolliDocId`: 1:1 migration copies it (same
	 * refs, same article), and a many-to-one merge adopts the NEWEST child's id and
	 * routes the rest into `orphanedDocIds` for deletion. The merged root's skill table
	 * is the fold of every child's, so no child's article is still the same document —
	 * but updating one in place beats minting a new one, because `cleanupOrphanedDocs`
	 * is best-effort and a failed delete then strands N stale articles instead of N-1
	 * (see `collectChildSkillsDocMeta`, which is where the rule lives).
	 *
	 * The name is NOT the registry's uniform `jolliDocId` default: on a `CommitSummary`
	 * that name is already taken by the memory article itself, so the `skill` kind
	 * overrides both field names (see `core/push/ContextKindDefinition.ts`).
	 */
	readonly jolliSkillsDocUrl?: string;
	/** See {@link CommitSummary.jolliSkillsDocUrl}. */
	readonly jolliSkillsDocId?: number;
	/**
	 * Memory summary article IDs (NOT plan article IDs) superseded during squash/rebase merge.
	 * Deleted from Jolli Space after a successful push. Accumulated across re-squashes.
	 * Plan articles are never orphaned — plan slugs include commit hashes and are all kept.
	 */
	readonly orphanedDocIds?: ReadonlyArray<number>;
	/**
	 * Commit hashes whose summaries had no `jolliDocId` at squash/merge time
	 * (race: the pre-push sync hadn't written back the ID yet). Consumed at push
	 * time: re-read each hash, promote any now-present docId into
	 * `orphanedDocIds` for cleanup, retain hashes still present in the shared
	 * push-pending queue, and discard only hashes known not to be in flight.
	 */
	readonly unresolvedOrphanHashes?: ReadonlyArray<string>;
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
	 * Agent Skills that ran during the work leading to this commit.
	 *
	 * Metadata about HOW the work happened, not substance of it: this array is
	 * archived and displayed but never fed to the summarizer, the same `trackOnly`
	 * contract references use. Letting it steer the memory's content would be a
	 * category error.
	 *
	 * Purely additive — no schema-version bump and no migration, matching how
	 * `excludedContext` / `contextRelevance` shipped. (`transcripts` is the
	 * counter-example: it needed a migration because it changed structural
	 * semantics, not because it was new.)
	 */
	readonly skills?: ReadonlyArray<SkillCommitRef>;
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
	 * Set by `jolli doctor --repair-transcripts --fix` when this summary's empty
	 * `transcripts` was refilled from local transcript history. Purely additive —
	 * no schema bump, matching how `skills` / `excludedContext` shipped.
	 *
	 * Two jobs. It is the repair's idempotency key: a summary carrying it is never
	 * a candidate again, so a repeated run cannot create a second artifact for the
	 * same evidence window (spec §8.2). And it is what lets the memory-detail UI
	 * say "repaired from local transcript history" rather than implying the
	 * conversation was captured live.
	 */
	readonly transcriptsRepairedAt?: string;
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
	/**
	 * CONTEXT items the AI relevance ranker judged unrelated to this commit and
	 * soft-excluded — kept OUT of the summary prompt but recorded here for
	 * traceability (CLI / sidebar can show "AI excluded N items + why"). Distinct
	 * from user manual excludes, which are skipped from association but never
	 * recorded on the summary.
	 */
	readonly excludedContext?: ReadonlyArray<ExcludedContextItem>;
	/**
	 * AI relevance tier + one-line reason for every KEPT context item, keyed by
	 * (kind, key) onto `plans` / `notes` / `references`. Complements
	 * `excludedContext` (the soft-excluded items): together they preserve the
	 * full relevance picture the pre-commit panel showed. Absent on summaries
	 * generated without a relevance ranking (no context, fail-open, or a
	 * fingerprint-reuse from a selection file that predates this field) — the
	 * display layers then fall back to plain title rows. Per-node like
	 * `excludedContext` (each commit states its own judgment; NOT a
	 * Consolidate-Hoist field).
	 */
	readonly contextRelevance?: ReadonlyArray<ContextRelevanceRef>;
}

/**
 * AI relevance verdict for one KEPT context item on a commit summary. `key`
 * matches the working-area identity: plan slug / note id / reference
 * `<source>:<nativeId>` mapKey (NOT the shortHash-suffixed archivedKey —
 * renderers match references via `${source}:${nativeId}`).
 */
export interface ContextRelevanceRef {
	readonly kind: "plan" | "note" | "reference";
	readonly key: string;
	readonly tier: "high" | "mid" | "low";
	/** One-line AI note on how the item relates to this change. */
	readonly reason: string;
}

/**
 * One CONTEXT item the AI relevance ranker soft-excluded from a commit summary,
 * with the reason it was judged unrelated. Stored on CommitSummary.excludedContext.
 */
export interface ExcludedContextItem {
	readonly kind: "plan" | "note" | "reference" | "skill";
	/** slug (plan) / note id / reference mapKey / skill `<source>:<skill>` mapKey. */
	readonly key: string;
	readonly title: string;
	/** One-line AI reason it was judged unrelated to this change. */
	readonly reason: string;
	/** Relevance tier; soft-excluded items are always the lowest ("low"). */
	readonly tier?: "low";
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
	/** Full URL of the plan article on Jolli Space after pushing; its origin keys the reuse gate (see `CommitSummary.jolliDocUrl`). */
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
}

/**
 * Display projection of a {@link PlanEntry} for an IDE panel.
 *
 * Produced by `PlanService.detectPlans`; consumed in-process by the VS Code
 * extension and over `jolli ide-bridge` by IntelliJ, so the shape is part of
 * the bridge wire contract rather than a host-local view model.
 */
export interface PlanInfo {
	/** Plan slug (e.g. "abstract-jumping-church") — primary key */
	readonly slug: string;
	/** Plan filename (e.g. "abstract-jumping-church.md") */
	readonly filename: string;
	/** Editable file path: uncommitted → ~/.claude/plans/<slug>.md; committed → .jolli/jollimemory/plans/<slug>.md */
	readonly filePath: string;
	/** First # heading from the markdown file */
	readonly title: string;
	/** ISO 8601 — file mtime (uncommitted) or commit date (committed) */
	readonly lastModified: string;
	/** ISO 8601 — when this plan was first discovered */
	readonly addedAt: string;
	/** ISO 8601 — when this plan was last modified */
	readonly updatedAt: string;
	/** Commit hash if plan is associated with a commit, null if unassociated */
	readonly commitHash: string | null;
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
	/**
	 * Skill usage rows, keyed `<source>:<skill>`.
	 *
	 * **Adding a FIFTH artifact map: update `ARTIFACT_MAPS` in
	 * `core/PlansRegistryWriters.test.ts` and let it tell you which writers to fix.**
	 * Every map here is optional, so a writer that rebuilds this object field-by-field
	 * and forgets one erases it on the next write with nothing failing to compile.
	 * That test scans for such rebuilds across `cli/src` and `vscode/src`; it exists
	 * because the comment that used to sit here enumerated the writers by name, went
	 * stale as writers were added, and two of them dropped `skills` — which made every
	 * reference-bearing commit archive zero skills, a symptom that pointed at the skill
	 * subsystem rather than at a reference write.
	 *
	 * Prefer `{ ...registry, oneMap: … }` over a field-by-field rebuild; spreads carry
	 * maps they never name and are exempt from that test for exactly that reason.
	 */
	readonly skills?: Readonly<Record<string, SkillEntry>>;
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
}

/**
 * Display projection of a {@link NoteEntry} for an IDE panel.
 *
 * Same contract as {@link PlanInfo}: produced by `NoteService.detectNotes` and
 * consumed by both IDE hosts, so it travels the `jolli ide-bridge` wire.
 */
export interface NoteInfo {
	readonly id: string;
	readonly title: string;
	readonly format: NoteFormat;
	/** ISO 8601 — file mtime (markdown) or updatedAt (snippet) */
	readonly lastModified: string;
	readonly addedAt: string;
	readonly updatedAt: string;
	readonly commitHash: string | null;
	/** Filename (e.g. "my-note.md") */
	readonly filename?: string;
	/** Absolute file path */
	readonly filePath?: string;
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
	/** Full URL of the note article on Jolli Space after pushing; its origin keys the reuse gate (see `CommitSummary.jolliDocUrl`). */
	readonly jolliNoteDocUrl?: string;
	/** Server-side article ID for direct update on subsequent pushes */
	readonly jolliNoteDocId?: number;
}

// ─── Generic external-reference types (multi-source) ────────────────────────

/**
 * SourceId — stable id naming each external-reference provider.
 *
 * Ids are registered via `BUILTIN_DEFINITIONS`
 * (`cli/src/core/references/sources/definitions/index.ts`) and resolved
 * through `SourceDefinitionRegistry`, not a closed string union — phase-2
 * config can register additional sources at runtime. Persistence layers (the
 * `plans.json` `references` map, orphan-branch `references/<source>/…`) key off
 * this string directly.
 */
export type SourceId = string;

/** The source ids that ship as built-in `SourceDefinition`s. Docs/reference only — not an exhaustive runtime set. */
export type KnownSourceId =
	| "linear"
	| "confluence"
	| "jira"
	| "github"
	| "notion"
	| "slack"
	| "zoom-meeting"
	| "zoom-doc"
	| "asana"
	| "monday"
	| "context7"
	| "jollimemory"
	| "vercel"
	| "figma"
	| "sentry";

/**
 * ReferenceField — one displayable field produced by a `SourceDefinition`'s `fields` pipes.
 *
 * The opaque carrier for everything source-specific. The common layer
 * (persistence, commit snapshot, panel, tooltip) only **passes it through** —
 * it NEVER interprets `key`. Each `SourceDefinition`'s `fields` pipes decide
 * which fields exist, their display labels, icons, and order. Adding
 * Slack/Zoom means adding a `SourceDefinition`; no common-layer type or code
 * changes.
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
 * Reference — ephemeral, in-memory shape produced by a `SourceEngine.extractRef`
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
	/**
	 * Absent in two distinct ways, both live today:
	 *   - the definition declares NO `reference.url` spec at all, because the source has
	 *     no external destination (`jollimemory` records a local memory lookup);
	 *   - the definition declares one and it did not resolve (Slack with no permalink) —
	 *     there the link exists and we failed to find it, which voids the reference.
	 * Every other shipping source marks `url` required in its FieldSpec, so its extracted
	 * references always carry one.
	 */
	readonly url?: string;
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
	/** Absent when the source `Reference.url` was — a url-less source (`jollimemory`) or an unresolved one (Slack with no permalink). See `Reference.url`. */
	readonly url?: string;
	/** Absolute path to `<jolliMemoryDir>/references/<source>/<sanitized-key>.md`. */
	readonly sourcePath: string;
	readonly addedAt: string;
	readonly updatedAt: string;
	/** MCP tool name that originally surfaced this reference. */
	readonly sourceToolName: string;
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
	/** Absent when the source `Reference.url` was — a url-less source (`jollimemory`) or an unresolved one (Slack with no permalink). See `Reference.url`. */
	readonly url?: string;
	/** Opaque, source-specific display fields — snapshot of the Reference's `fields` at archive time. */
	readonly fields?: ReadonlyArray<ReferenceField>;
	/**
	 * Newest query text of an `accumulateBody` source, snapshotted at archive time via
	 * `accumulatedQueryOf`. Absent for every entity-shaped source.
	 *
	 * Needed because an accumulating source's title is its TOOL label (`Search`) —
	 * identical on every row of every commit — while the part that carries information
	 * lives in the markdown BODY, which is archived to the orphan branch and never
	 * copied onto this snapshot. Without this field the committed row can only render a
	 * date. Only the newest entry is carried, not the body: the full list stays on the
	 * orphan branch, one click away via Preview.
	 */
	readonly latestQuery?: string;
	readonly referencedAt: string;
	readonly sourceToolName: string;
	/** Full URL of the reference article on Jolli Space after pushing (docType `reference`); its origin keys the reuse gate (see `CommitSummary.jolliDocUrl`). */
	readonly jolliReferenceDocUrl?: string;
	/** Server-side article ID for direct update on subsequent pushes of this reference. */
	readonly jolliReferenceDocId?: number;
}

// ─── Skill usage types ──────────────────────────────────────────────────────

/**
 * Hosts whose on-disk transcript makes a skill invocation machine-identifiable.
 *
 * Deliberately NOT {@link SourceId}: that union is the *reference* source
 * namespace (external systems reached through MCP), while this is the set of
 * AI hosts we can read skill usage out of. Gemini, Antigravity, Cline and Devin
 * are absent because they have no skill concept on disk at all — there is
 * nothing to capture, as opposed to something we have not got round to.
 */
export type SkillSource = "claude" | "opencode" | "codex" | "cursor" | "kimi";

/**
 * How the agent entered the skill.
 *
 * `tool` — a `Skill` tool_use block (the agent decided to invoke it).
 * `command` — a user-typed `/plugin:skill` slash command, which bypasses the
 * `Skill` tool entirely and is only identifiable from the `<command-name>` tag
 * block plus a following body record. There is no `SlashCommand` tool anywhere
 * in the corpus, so an extractor keyed only on the tool misses this path.
 */
export type SkillEntryPath = "tool" | "command";

/** One measured entry into a skill. */
export interface SkillInvocation {
	/** ISO 8601 — timestamp of the record that entered the skill. */
	readonly at: string;
	/** `Skill` tool `input.args` or `<command-args>`; frequently absent (the tag is optional AND can be present-but-empty). */
	readonly args?: string;
	/**
	 * Length of the injected skill body, measured from the transcript's own body
	 * record — NEVER re-derived from the `SKILL.md` on disk. Repeat invocations
	 * inject a short "already loaded above" stub rather than the full text, and
	 * bundled skills live under a temp path that no longer exists by the time a
	 * post-commit hook runs, so disk is not a valid source for this number.
	 */
	readonly bodyChars?: number;
	/** False for a failed invocation (the `is_error` tool results). */
	readonly ok: boolean;
	/**
	 * Whether this invocation's result was actually present in the scanned window.
	 *
	 * `false` is the important value: Claude and Kimi both emit a real invocation
	 * before its paired result arrives, with an optimistic `ok: true`. Optional for
	 * histories written before this evidence existed; readers then fall back to the
	 * source/entry-path capability table.
	 */
	readonly outcomeObserved?: boolean;
	/**
	 * Which mechanism entered the skill on THIS invocation.
	 *
	 * Distinct from {@link SkillUse.entryPaths}, which is the SET of mechanisms a
	 * skill has ever been entered by and therefore cannot answer for one
	 * invocation: a skill reached both ways carries `["command","tool"]`, and
	 * nothing in that array says which of its invocations was which.
	 *
	 * Load-bearing for {@link ok}, not decoration. Whether a source can report an
	 * outcome at all depends on the mechanism, not only on the host — Claude's
	 * `Skill` tool has a `tool_result` to read a failure from while its slash
	 * command has no result record at all, so both arrive as a hard-coded
	 * `ok: true`. `skillOutcomeConfidence` needs this field to tell the two apart.
	 *
	 * Optional because a stored history predates it: `parseInvocationLine` reads
	 * fields by name, so an older `skills/<source>/<skill>.md` deserializes with
	 * this absent. Readers must treat absence as "unknown mechanism", never as a
	 * default one.
	 */
	readonly entryPath?: SkillEntryPath;
}

/**
 * Tokens spent under a skill.
 *
 * `confidence` is user-visible, not an internal note: `attributed` means the
 * host itself tagged each response with the owning skill, `estimated` means we
 * inferred it from an interval between entry events. Sources that can do
 * neither carry no `usage` at all — an absent field is honest, a zero is a lie.
 */
export interface SkillUsage {
	readonly input: number;
	readonly output: number;
	readonly cached: number;
	readonly confidence: "attributed" | "estimated";
}

/**
 * SkillEntry — persisted registry row in the `plans.json.skills` map, keyed
 * `<source>:<skill>`.
 *
 * Follows the Plan / Note lifecycle, not the Reference one: the row is GUARDED
 * on commit (`commitHash` + `contentHashAtCommit` set) rather than deleted, so
 * `detectActiveSkillsForBranch` can filter uncommitted rows by the same rule
 * plans and notes already use.
 *
 * A skill entered five times is ONE row with `invocationCount: 5`, mirroring
 * the accumulate-body precedent proven for the context7 and jollimemory
 * reference sources.
 */
export interface SkillEntry {
	readonly source: SkillSource;
	/** Fully-qualified skill id as the host reports it, e.g. `superpowers:brainstorming`. */
	readonly skill: string;
	/** From `attributionPlugin` when the host supplies it, else the `<plugin>:` prefix of the id. Absent for unprefixed skills. */
	readonly plugin?: string;
	/** Distinct entry paths observed for this skill — a skill can be both agent-invoked and user-invoked. */
	readonly entryPaths: ReadonlyArray<SkillEntryPath>;
	/** Newest-first, capped at {@link SKILL_INVOCATION_CAP}. `invocationCount` stays exact when this is truncated. */
	readonly invocations: ReadonlyArray<SkillInvocation>;
	/** Total entries ever observed; may exceed `invocations.length`. */
	readonly invocationCount: number;
	readonly firstUsedAt: string;
	readonly lastUsedAt: string;
	/**
	 * Total spend under this skill — the sum over {@link usageBySession}, computed at
	 * write time so consumers do not each re-derive it.
	 *
	 * Absent when the source cannot attribute tokens at all (Codex / Cursor
	 * heuristics). An absent field is honest; a zero would claim the skill was free.
	 */
	readonly usage?: SkillUsage;
	/**
	 * Per-session spend, keyed `<source>:<sessionId>`.
	 *
	 * This is the authoritative record, not a cache, for two reasons that a single
	 * aggregate cannot serve:
	 *
	 *   - **Correct folding.** Capture runs once per transcript, so a skill used in
	 *     several sessions is folded several times. Attribution recomputes a whole
	 *     session from line 0 on every pass, so a session's contribution must
	 *     REPLACE its prior entry — while a different session's must be added. One
	 *     aggregate cannot distinguish those, and picking either rule alone gives an
	 *     under-count or a double-count.
	 *   - **Detach.** Committed conversation figures are corrected when a user
	 *     detaches a conversation, using the per-session usage persisted at write
	 *     time (see DetachedUsageSubtraction). Without the same split here, a skill's
	 *     number goes stale the moment anything is detached.
	 */
	readonly usageBySession?: Readonly<Record<string, SkillUsage>>;
	/**
	 * Present only when the invocation was inferred rather than observed.
	 *
	 * Claude and OpenCode expose a real skill tool, so a capture from them IS the
	 * act — nothing is inferred and this stays absent. Codex has no such tool: its
	 * only signal is a shell command reading a `SKILL.md`, which cannot distinguish
	 * an agent using a skill from a human reading the file, and cannot count entries
	 * (one use is often several paged reads).
	 *
	 * Deliberately NOT folded into `SkillUsage.confidence`: that field qualifies a
	 * token figure, and a heuristic source reports no tokens at all — there would be
	 * nothing to hang it on. Detection quality and token quality are independent.
	 */
	readonly detection?: "heuristic";
	/** Absolute path to `<jolliMemoryDir>/skills/<source>/<stem>.md`. */
	readonly sourcePath: string;
	/** Null until archived onto a commit — same guard shape as {@link PlanEntry}. */
	readonly commitHash: string | null;
	/** SHA-256 of the file at `sourcePath` when archived (archive guard). */
	readonly contentHashAtCommit?: string;
	/**
	 * Counters as of the last archive. A skill is unlike a plan or a note: it can be
	 * entered again after being frozen onto a commit, and the row keeps ACCUMULATING
	 * (see {@link SkillEntry.invocationCount}). So the guard alone cannot answer
	 * "what is uncommitted" — subtracting this snapshot can.
	 *
	 * Every consumer of "since the last commit" derives it as `current - archivedTotals`:
	 * the ref written onto the next commit, and the sidebar's active-skill predicate.
	 * That keeps the PR-wide aggregate a plain SUM across commits — each commit holds
	 * its own increment, never a running total that would re-count earlier commits.
	 *
	 * Deliberately NOT solved by zeroing the row (or deleting the working file) at
	 * archive time: the file at `sourcePath` is the ONLY dedup ledger. Main transcripts
	 * ride the `skills` extractor's own monotonic mark, but subagent files are re-scanned
	 * in full on every pass by design (see TranscriptSkillDiscovery), so invocations are
	 * re-emitted and deduped by `at` against what is already on disk. Clearing it would
	 * make a re-scan of an already-archived transcript read as fresh usage.
	 *
	 * Absent on rows written before this existed; treated as an all-zero baseline,
	 * which makes the first archive after an upgrade carry the full history exactly
	 * once.
	 */
	readonly archivedTotals?: SkillArchivedTotals;
}

/** Snapshot of a {@link SkillEntry}'s counters at its last archive. */
export interface SkillArchivedTotals {
	readonly invocationCount: number;
	readonly usage?: SkillUsage;
	readonly usageBySession?: Readonly<Record<string, SkillUsage>>;
}

/**
 * SkillUse — ephemeral, in-memory shape a scanner produces for one skill within
 * one scan pass. Already aggregated across repeat entries *inside* that pass;
 * folding it against what is already on disk is `upsertSkillEntry`'s job.
 *
 * Stands to {@link SkillEntry} as {@link Reference} stands to {@link ReferenceEntry}.
 */
export interface SkillUse {
	readonly source: SkillSource;
	readonly skill: string;
	readonly plugin?: string;
	readonly entryPaths: ReadonlyArray<SkillEntryPath>;
	/** Newest-first within this scan pass. */
	readonly invocations: ReadonlyArray<SkillInvocation>;
	readonly usage?: SkillUsage;
	/** See {@link SkillEntry.detection}. */
	readonly detection?: "heuristic";
	/**
	 * Which conversation this pass read, keyed `<source>:<sessionId>`.
	 *
	 * Required to fold `usage` correctly: the store replaces this session's prior
	 * contribution and adds it to other sessions'. Absent only when the scanner
	 * produced no usage at all, where there is nothing to attribute to a session.
	 */
	readonly sessionKey?: string;
}

/**
 * SkillCommitRef — snapshot stored in `CommitSummary.skills`. Every field other
 * than `archivedKey` is a value-snapshot at archive time, holding this commit's
 * INCREMENT rather than the row's running total (see `SkillEntry.archivedTotals`).
 */
export interface SkillCommitRef {
	/**
	 * `<mapKey>-<shortHash>`: the `plans.json.skills` key plus the archiving commit's
	 * short hash. NOT itself a key into that map — the registry row keeps the bare
	 * `<source>:<skill>` mapKey, so consumers `splitArchivedKey` this to recover it
	 * (that is how `associateSkillWithCommit` migrates a guard after squash/rebase).
	 * It does name the orphan-branch file, via `skillOrphanPath`.
	 */
	readonly archivedKey: string;
	readonly source: SkillSource;
	readonly skill: string;
	readonly plugin?: string;
	readonly entryPaths: ReadonlyArray<SkillEntryPath>;
	readonly invocationCount: number;
	readonly firstUsedAt: string;
	readonly lastUsedAt: string;
	/** Total across every contributing session — the sum over {@link usageBySession}. */
	readonly usage?: SkillUsage;
	/**
	 * Per-session spend keyed `<source>:<sessionId>`, snapshotted at archive time.
	 *
	 * Carried onto the commit, not left behind in the working registry, because
	 * detach happens AFTER the commit: correcting a committed skill's figures needs
	 * the split to still be reachable from the summary. Without it the only options
	 * would be to leave a stale number or to invent a subtrahend, and the
	 * commit-level path already rejected both.
	 */
	readonly usageBySession?: Readonly<Record<string, SkillUsage>>;
	/** See {@link SkillEntry.detection}. */
	readonly detection?: "heuristic";
	/**
	 * Full URL of the skill article on Jolli Space after pushing (docType `skill`);
	 * its origin keys the doc-id reuse gate (see `CommitSummary.jolliDocUrl`).
	 *
	 * The UNIFORM name, not a `jolliSkillDocUrl` in the style of `jolliPlanDocUrl` /
	 * `jolliNoteDocUrl` / `jolliReferenceDocUrl` — see
	 * `core/push/ContextKindDefinition.ts` for why a new context kind takes the push
	 * registry's defaults while those three override them.
	 */
	readonly jolliDocUrl?: string;
	/** Jolli Space document id of the pushed skill article — the update-in-place target on a re-push. */
	readonly jolliDocId?: number;
	/**
	 * Skill article ids this ref's fold SUPERSEDED — pending cleanup, the skill
	 * counterpart of `CommitSummary.orphanedDocIds`.
	 *
	 * Exists because a skill article is one document per (skill, COMMIT) — see the
	 * `skill` definition's `baseKey`. So when a squash folds three commits' refs for
	 * one skill into a single row, three already-published articles collapse to one:
	 * `mergeSkillRef` keeps the first docId it sees and the rest would simply vanish,
	 * leaving articles on the Space titled with a `hash8` that no longer exists on
	 * the branch. Under the previous cross-commit `baseKey` this could not happen —
	 * only one ref per skill was ever pushed, so only one docId existed.
	 *
	 * Accumulated (unioned) through every fold rather than resolved at one site, and
	 * for a specific reason: skills are folded at THREE levels on the way to a squash
	 * root (`collectChildSkills`, QueueWorker's `extraSkills` pre-merge, and
	 * `mergeManyToOneLocked`'s own union). Reporting drops as a fold RETURN value would
	 * lose whatever the inner folds discarded; riding on the ref means the outermost
	 * fold sees everything.
	 *
	 * Drained into the root's `orphanedDocIds` and stripped from the persisted ref (via
	 * `stripSupersededDocIds`) so it never accumulates across re-squashes. Every consumer
	 * of the fold owes that drain; today they are `mergeManyToOneLocked` (squash) and
	 * `normalizeToV4`.
	 *
	 * **The amend root is deliberately NOT one of them** — it does not fold at all, so it
	 * never mints this marker. `buildHoistedAmendRoot` unions on the mapKey with new
	 * winning, carries `jolliDocId`/`jolliDocUrl` across by hand, and queues a displaced
	 * id straight into `orphanedDocIds`. See that function for why folding there is
	 * WRONG: the amended child is retained in the tree, so a row that absorbed another
	 * `archivedKey`'s increment gets it counted a second time when a later squash walks
	 * the tree.
	 */
	readonly supersededDocIds?: ReadonlyArray<number>;
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
	/**
	 * Author email (`%ae`), absent when git reported none. Optional because
	 * `getHeadCommitInfo` does not ask for it — only the dashboard's live
	 * producer needs it, to match the author filter's email clause against
	 * commits made since the last backfill sweep.
	 */
	readonly authorEmail?: string;
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
export type LlmConfig = Pick<
	JolliMemoryConfig,
	"apiKey" | "model" | "jolliApiKey" | "aiProvider" | "localAgentTool" | "localAgentPath" | "localAgentModel"
>;

/** Configuration stored in .jolli/jollimemory/config.json */
export interface JolliMemoryConfig {
	readonly apiKey?: string;
	readonly model?: string;
	readonly maxTokens?: number;
	/** Glob patterns for excluding files from the VSCode Files panel */
	readonly excludePatterns?: ReadonlyArray<string>;
	/** Folder names (under localFolder) to skip during multi-repo `jolli compile`. Exact name or `*` glob. Default: none. */
	readonly compileExcludeFolders?: ReadonlyArray<string>;
	/**
	 * Where database snapshots go. Default `~/jolli_back` — deliberately OUTSIDE
	 * `~/.jolli` (a backup must not share fate with the disaster) and independent
	 * of `localFolder` (no Memory Bank must not mean no backup). Validated at
	 * SAVE time; the snapshot engine never falls back to another folder when the
	 * configured one is unreachable — a removable drive being unplugged is a
	 * legitimate state, and scattering snapshots across fallbacks would corrupt
	 * the recovery candidate list.
	 */
	readonly backupFolder?: string;
	/**
	 * Snapshot retention in days (default 20, integer >= 1 — zero is refused
	 * rather than given a "no backups" meaning). The size cap follows this value
	 * (`max(2 GiB, days x current db size)`), so the two never veto each other.
	 */
	readonly backupRetentionDays?: number;
	/** Jolli Space API key for pushing summaries and proxy LLM calls (sk-jol-...) */
	readonly jolliApiKey?: string;
	/**
	 * Opt-in gate for the manifest-driven Jolli-platform MCP tools. When `true`,
	 * the `jolli mcp` server also registers the backend-defined platform tools
	 * (fetched from the tenant's tool manifest at startup) alongside the built-in
	 * git-memory tools. Off by default — when absent or `false`, the server stays
	 * git-memory-only and never contacts the backend for a manifest. Opt-in
	 * polarity, unlike the `*Enabled` source-discovery flags below which default
	 * to on. The `JOLLI_MCP_PLATFORM_TOOLS=1` env var overrides it at read time.
	 */
	readonly mcpPlatformToolsEnabled?: boolean;
	/**
	 * Opt-in extra origins that `jolli open-url` may auto-launch, on top of its
	 * built-in jolli-origin and known-git-host allowlist tiers. A **local-development
	 * affordance** for tunnel/dev deployments whose deep-links come from a public base
	 * host (e.g. an ngrok host) that is neither a jolli origin nor a known git host.
	 * Each entry is a bare host (`x.ngrok-free.dev`) or a full `https://…` origin,
	 * normalized to a host and matched with the same suffix-boundary rule as the other
	 * tiers. Empty/absent by default ⇒ the gate is identical to the two-tier default
	 * (production/normal users unaffected). The `JOLLI_OPEN_URL_ALLOWED_ORIGINS` env var
	 * (comma-separated) is **merged with** these — env adds to config, it does not
	 * replace it. The URL opened is still `https`-only regardless of this list.
	 */
	readonly openUrlAllowedOrigins?: ReadonlyArray<string>;
	/** Enable Codex session discovery at post-commit time (default: auto-detect) */
	readonly codexEnabled?: boolean;
	/** Enable Gemini session tracking via AfterAgent hook (default: auto-detect) */
	readonly geminiEnabled?: boolean;
	/** Enable Claude Code session tracking via Stop hook (default: true) */
	readonly claudeEnabled?: boolean;
	/**
	 * Whether Jolli may write its skill-preference block into the machine-global
	 * AI instruction files (~/.claude/CLAUDE.md, ~/.gemini/GEMINI.md,
	 * ~/.codex/AGENTS.md). `undefined` = not yet decided (default: skip until the
	 * user confirms via the CLI prompt or the VS Code notification).
	 */
	readonly globalInstructions?: "enabled" | "disabled";
	/** Enable OpenCode session discovery at post-commit time (default: auto-detect) */
	readonly openCodeEnabled?: boolean;
	/**
	 * Enable Cursor session discovery at post-commit time (default: auto-detect).
	 * Shared by both Cursor forms — the Composer IDE and the cursor-agent CLI —
	 * so there is one user-facing "Cursor" toggle (mirrors the shared
	 * copilotEnabled flag for Copilot CLI + Chat).
	 */
	readonly cursorEnabled?: boolean;
	/** Enable GitHub Copilot CLI session discovery at post-commit time (default: auto-detect) */
	readonly copilotEnabled?: boolean;
	/** Enable Cline (VS Code extension + CLI) session discovery at post-commit time (default: auto-detect) */
	readonly clineEnabled?: boolean;
	/** Enable Devin CLI session discovery. Defaults to on when Devin is detected. */
	readonly devinEnabled?: boolean;
	/** Enable Antigravity (Gemini agentic IDE/CLI) session discovery at post-commit time (default: auto-detect) */
	readonly antigravityEnabled?: boolean;
	/** Enable Kimi Code CLI (~/.kimi-code) session discovery at post-commit time (default: auto-detect) */
	readonly kimiEnabled?: boolean;
	/** Global minimum log level written to debug.log (default: "info") */
	readonly logLevel?: LogLevel;
	/** Per-module log level overrides (e.g. { "GitOps": "debug" }) */
	readonly logLevelOverrides?: Readonly<Record<string, LogLevel>>;
	/** Absolute path to the user-chosen Memory Bank folder (mirrors orphan-branch
	 *  artifacts to disk when storageMode is "folder" or "dual-write"). */
	readonly localFolder?: string;
	/**
	 * Which `StorageProvider` the factories build (default: `"dual-write"`).
	 * Any other value degrades to orphan-only — both `StorageFactory` and
	 * `ReadStorageResolver` fall through to `OrphanBranchStorage` on an
	 * unrecognized mode, so `resolveMemoryBankState` reports it as such.
	 *
	 * Declared here (rather than read as an untyped extra) because it is now
	 * surfaced to users through the `Memory Bank:` status row.
	 */
	readonly storageMode?: "orphan" | "dual-write" | "folder";
	/** OAuth auth token from browser login (stored by `jolli auth login`) */
	readonly authToken?: string;
	/**
	 * The Jolli server origin the user logged into via `jolli auth login`,
	 * persisted so space-cli can recover the tenant URL when `jolliApiKey` is
	 * missing or stale. Pure URL — no secret material. Trailing slash stripped
	 * on write to match `getJolliUrl`.
	 *
	 * Written by every login path (CLI, VS Code, and IntelliJ via the CLI's
	 * `handle-auth-callback` ide-bridge action). Consumed only by CLI-process
	 * code today — the Kotlin `JolliMemoryConfig` data class deliberately omits
	 * this field, since the IntelliJ side resolves its origin via JolliUrlConfig.
	 * Add it to the Kotlin type if IntelliJ ever needs the same fallback.
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
	readonly aiProvider?: "anthropic" | "jolli" | "local-agent";
	/**
	 * Which local Agent CLI tool to drive when `aiProvider` is "local-agent".
	 * Ignored unless `aiProvider === "local-agent"`.
	 */
	readonly localAgentTool?: LocalAgentToolId;
	/** Optional explicit path to the local agent binary, overriding PATH discovery. */
	readonly localAgentPath?: string;
	/**
	 * Which model the local agent tool is told to run, for the tools jollimemory
	 * pins one for (`LOCAL_AGENT_TOOLS[…].models`, claude-code today). An id from
	 * that tool's own list; `"inherit"` means "send no model flag and run whatever
	 * the tool is configured with", and an ABSENT value means the default
	 * (`DEFAULT_LOCAL_AGENT_MODEL`). Both Settings panels store the default as
	 * absent — they always submit the effective value, so writing it would inflate
	 * config.json on any unrelated save — while `configure --set` keeps an explicit
	 * default verbatim, since a value someone typed should be visible in the file
	 * they typed it into. `resolveLocalAgentModel` reads the two identically TODAY,
	 * and the divergence is deliberate rather than incidental: if
	 * `DEFAULT_LOCAL_AGENT_MODEL` ever changes, an absent value follows the new
	 * default while a literal one stays pinned — which is the right reading of
	 * "I selected the default option" versus "I typed this model's name". The CLI
	 * way back to following the default is `configure --remove localAgentModel`,
	 * not `--set …=""`: every enum key rejects an empty value.
	 *
	 * Deliberately NOT the same field as `model`. That one names an Anthropic API
	 * model id for the direct/proxy providers; this one names an alias in a local
	 * CLI's own namespace. Merging them would make the field mean two different
	 * things depending on `aiProvider`, and would have nothing to say at all for
	 * the four tools that are not pinned.
	 *
	 * Ignored unless `aiProvider === "local-agent"`, and ignored for a tool that
	 * declares no models.
	 */
	readonly localAgentModel?: string;
	/**
	 * When the wiki/graph (topic KB) is rebuilt from newly-summarized commits.
	 *  - "manual" (DEFAULT — an absent value means manual): no git operation
	 *    (commit / rebase / amend / squash / merge) auto-triggers a wiki/graph
	 *    rebuild. The user rebuilds on demand from the dashboard or the VS Code
	 *    sidebar. recall and commit-search stay fresh regardless (they read the
	 *    per-commit summaries, not the topic KB).
	 *  - "auto": the legacy behaviour — every commit / merge / backfill enqueues an
	 *    ingest pass that folds new summaries into the wiki and rebuilds the graph.
	 *
	 * Read via `wikiRebuildIsAuto(config)`; the polarity is deliberately
	 * `=== "auto"` so an absent key (every existing install) means manual.
	 */
	readonly wikiRebuild?: "manual" | "auto";
	/**
	 * Whether `jolli dashboard`'s sidebar shows the **Knowledge** menu row (the
	 * Memory Bank `_wiki` browser). Absent means HIDDEN — the polarity is
	 * deliberately `=== true`, so every existing install upgrades into the
	 * default-off state with no migration.
	 *
	 * Scoped to the sidebar row ALONE. `/knowledge`, `/wiki-viewer` and
	 * `/api/wiki/*` stay routed and `jolli compile` still builds the wiki, so a
	 * bookmark, the Knowledge → Graph jump and the iframe preview keep working
	 * while the row is hidden. Anything about whether the wiki is BUILT lives in
	 * `wikiRebuild` above, not here.
	 */
	readonly dashboardKnowledgeMenuEnabled?: boolean;
	/**
	 * Whether `jolli dashboard`'s sidebar shows the **Graph** menu row (the
	 * per-repo knowledge graph). Same polarity and the same row-only scope as
	 * {@link dashboardKnowledgeMenuEnabled} — `/graph` and `/graph-viewer` stay
	 * routed either way.
	 */
	readonly dashboardGraphMenuEnabled?: boolean;
	/**
	 * Whether the post-commit hook prints live memory-capture progress to stdout
	 * (so a `git commit` driven from a terminal or AI-agent session shows the
	 * capture lifecycle inline, and blocks until it drains).
	 *  - "auto" (default): show only in an interactive place — a TTY, or an
	 *    AI-agent session (Claude Code etc.). GUI git clients stay silent + fast.
	 *  - "on":  always show (and block) — any commit surface.
	 *  - "off": never show; keep the fast, silent, non-blocking behavior.
	 * The `JOLLI_COMMIT_FEEDBACK` env var overrides this per-invocation.
	 */
	readonly commitFeedback?: "auto" | "on" | "off";
	/**
	 * When true, plugin-initiated `git commit` / `--amend` / squash invocations
	 * pass `-s` to add a DCO `Signed-off-by:` trailer. Off by default. Read at
	 * each commit site; not cached. The `-s` flag is idempotent — git skips
	 * the trailer if an identical line already exists in the message.
	 */
	readonly dcoSignoff?: boolean;
	/**
	 * Auto-push memory to Jolli Space on every `git push`. `undefined` = enabled
	 * (default when logged in); `false` = disabled. The pre-push hook records
	 * pushed commits into `.jolli/jollimemory/push-pending.json` and syncs the
	 * ones with generated memory to the bound Space synchronously (budget-bound
	 * batch request); the rest follow via the compensation channels.
	 * Complementary to the PR-level `push_memory` flow — same idempotent server
	 * path, no duplicates.
	 */
	readonly syncOnPush?: boolean;
	/**
	 * Whether SESSION STATISTICS are synced to the server. `undefined` = on.
	 *
	 * ⚠ Its own switch on purpose, and the reason is the largest privacy change
	 * this product has made. Until this channel, data left a machine only for a
	 * repo the user had explicitly bound to a Space. Session statistics go up for
	 * EVERY repo on the machine — private projects, client work, repos the user
	 * never intended to connect to anything — because the API key alone says where
	 * they belong. Sessions carry a `title`, which several agents populate with the
	 * user's own first message, and tool names include MCP server names.
	 *
	 * Do NOT fold this into {@link syncOnPush} or a per-repo push toggle. Those
	 * mean "push this repo's memories", and the decision here is precisely that
	 * statistics do not follow that rule — sharing the switch would make the
	 * setting lie about what it controls.
	 */
	readonly syncSessions?: boolean;
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
	/**
	 * Slack integration config. `workspaceUrl` (e.g. "https://my-team.slack.com")
	 * lets the reference extractor reconstruct a thread permalink when the user
	 * never pasted one into the transcript — the `slack_read_thread` MCP result
	 * carries neither a url nor the workspace subdomain.
	 */
	readonly slack?: {
		readonly workspaceUrl?: string;
	};
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
	/** Absolute path to the git pre-push hook file (set on successful install) */
	readonly prePushHookPath?: string;
	/** Absolute path to the Gemini settings file (set on successful install when Gemini detected) */
	readonly geminiSettingsPath?: string;
	/**
	 * Set when `respectManualDisable` short-circuited the run: the repo carries the
	 * manual opt-out, so NOTHING was installed even though `success` is `true`.
	 *
	 * The success is deliberate — refusing to touch a repo the user turned off IS the
	 * correct outcome, not an error. But it means `success` alone cannot be read as
	 * "the install happened". Any caller whose success path has a side effect —
	 * stamping "enabled for this version", clearing a cached opt-out, holding a UI
	 * state — MUST check this flag first, or it will record an install that never
	 * occurred. Absent (undefined) on every other path, including a real install of a
	 * repo that simply has no opt-out set.
	 */
	readonly manuallyDisabled?: boolean;
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
	/** Whether the pre-push hook section is installed (additive, not required for `enabled`) */
	readonly prePushHookInstalled?: boolean;
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
	/**
	 * Whether OUTBOUND push to a Jolli Space is disabled for this repo (spec 306,
	 * per-repo push control). Memory is still captured locally; only sync is off.
	 */
	readonly pushDisabled?: boolean;
	/**
	 * Why {@link pushDisabled} is true, when it is NOT the user's recorded choice —
	 * i.e. the push-control store could not be read and the gate failed closed.
	 * Carries the store's absolute path.
	 *
	 * Present so a status surface can tell the two apart: without it, one corrupt
	 * file makes every repo on the machine report "you turned this off", which is
	 * wrong twice over (the user chose nothing, and it isn't per-repo) and points
	 * away from the single file that needs fixing.
	 */
	readonly pushDisabledError?: string;
	/** Whether Claude Code directory (~/.claude/) was detected */
	readonly claudeDetected?: boolean;
	/** Whether Codex directory (~/.codex/) was detected */
	readonly codexDetected?: boolean;
	/** Whether Codex session discovery is enabled in config (undefined = auto-detect) */
	readonly codexEnabled?: boolean;
	/** Whether Gemini directory (~/.gemini/) was detected */
	readonly geminiDetected?: boolean;
	/** Whether Gemini session tracking is enabled in config (undefined = auto-detect) */
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
	/** Whether Devin CLI's session DB (~/.local/share/devin/cli/sessions.db) was detected */
	readonly devinDetected?: boolean;
	/** Whether Devin CLI session discovery is enabled in config (undefined = auto-detect) */
	readonly devinEnabled?: boolean;
	/** Devin DB scan failed with a real (non-ENOENT) error. Same UI semantics as cursorScanError. */
	readonly devinScanError?: SqliteScanError;
	/** Whether Cursor CLI's session store (~/.cursor/chats or cursor-agent equivalent) was detected */
	readonly cursorCliDetected?: boolean;
	/** Cursor CLI scan failed with a real (non-ENOENT) error. Same UI semantics as cursorScanError. */
	readonly cursorCliScanError?: { readonly kind: "fs" | "parse"; readonly message: string };
	/** Whether any Antigravity variant's conversations dir (under ~/.gemini) was detected */
	readonly antigravityDetected?: boolean;
	/** Whether Antigravity session discovery is enabled in config (undefined = auto-detect) */
	readonly antigravityEnabled?: boolean;
	/**
	 * Antigravity conversation-db scan failed with a real (non-ENOENT) error —
	 * corrupt, locked, schema drift, or permission denied. UI surfaces this
	 * adjacent to the Antigravity row instead of silently rendering "0 sessions".
	 */
	readonly antigravityScanError?: SqliteScanError;
	/** Whether the Kimi Code CLI data directory (~/.kimi-code) was detected */
	readonly kimiDetected?: boolean;
	/** Whether Kimi session discovery is enabled in config (undefined = auto-detect) */
	readonly kimiEnabled?: boolean;
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
	/** Whether any Cline surface (VS Code extension globalStorage or ~/.cline CLI) was detected */
	readonly clineDetected?: boolean;
	/** Whether the Cline CLI (~/.cline/data/sessions) was detected */
	readonly clineCliDetected?: boolean;
	/** Whether the Cline VS Code extension globalStorage was detected */
	readonly clineVscodeDetected?: boolean;
	/** Whether Cline session discovery is enabled in config (undefined = auto-detect) */
	readonly clineEnabled?: boolean;
	/**
	 * Cline VS Code extension scan failed with a real error (non-ENOENT): parse /
	 * fs / schema. Split from the CLI channel (was a single collapsed
	 * `clineScanError`) so one broken channel never masks a healthy sibling on the
	 * merged Cline row — see `buildIntegrationRows` in StatusCommand.ts.
	 */
	readonly clineVscodeScanError?: ClineScanError;
	/** Cline CLI (~/.cline/data/sessions) scan failed with a real error. Same UI semantics as clineVscodeScanError. */
	readonly clineCliScanError?: ClineScanError;
	/**
	 * v5 schema migration state — surfaced in `jolli status` and the VSCode
	 * Hooks tooltip so users can see whether their on-disk data has been
	 * migrated. Absent state is the implicit "pending" — the migration will
	 * run on next opportunity (worker startup or explicit `jolli migrate`).
	 */
	readonly schemaV5?: "in-progress" | "completed" | "failed";
	/**
	 * Where folder-layer writes land — the `Memory Bank:` row in `jolli status`,
	 * the MCP `status` tool, and the VS Code Settings → Memory Bank tab.
	 *
	 * Always present (unlike `schemaV5`): the whole point is that a degraded
	 * folder layer used to be invisible, so "no field" must not be a state.
	 */
	readonly memoryBank: MemoryBankState;
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

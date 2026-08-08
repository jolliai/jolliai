/**
 * DashboardModel — the wire contract between `DashboardQuery` (server) and the
 * dashboard assets (browser), plus the event shapes `StatsWriter` accepts.
 *
 * Two directions, deliberately in one file because they are two halves of the
 * same contract and drift between them is the failure mode worth preventing:
 *
 *   - `StatsEvent`   — what producers write (CLI hooks, extension tick, bootstrap).
 *   - `DashboardModel` — what the page reads.
 *
 * Both are versioned. `STATS_EVENT_SCHEMA_VERSION` travels with every event row
 * so an older reader can recognise (and safely park) an event a newer producer
 * wrote, and `DashboardModel.schemaVersion` lets the page detect that it is
 * talking to a server newer than its own assets.
 */

import type { KnowledgeGraph } from "../graph/GraphSchema.js";
import type { LocalAgentToolId, RecallOutcome, ToolCallCount, ToolCallKind, TranscriptSource } from "../Types.js";

/**
 * Version stamped on every event written to `events_raw`. Bump when an event's
 * payload shape changes incompatibly. Unknown versions are never dropped —
 * `StatsWriter` parks them as `pending` so a later build can project them.
 */
export const STATS_EVENT_SCHEMA_VERSION = 1;

/** How complete a token figure is — mirrors the mockups' coverage footnote. */
export type TokenCoverage = "full" | "sessions-only";

/** Which producer wrote an event. Recorded for audit, never for behaviour. */
export type ProducerKind = "cli" | "queue-worker" | "stop-hook" | "vscode" | "bootstrap" | "recovery";

/** Per-model token usage as stored against a session. */
export interface StatsModelUsage {
	readonly model: string;
	readonly provider?: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cachedTokens: number;
	readonly estCostUsd?: number;
}

/** A session observed for a repo. Idempotent on `(repo, source, sessionId)`. */
export interface SessionUpsertedEvent {
	readonly type: "session.upserted";
	readonly repoIdentity: string;
	readonly source: TranscriptSource;
	readonly sessionId: string;
	readonly title?: string;
	readonly startedAtMs?: number;
	readonly updatedAtMs: number;
	readonly messageCount?: number;
	readonly durationMs?: number;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cachedTokens?: number;
	readonly estCostUsd?: number;
	readonly tokenCoverage?: TokenCoverage;
	readonly pricesAsOf?: string;
	readonly models?: ReadonlyArray<StatsModelUsage>;
	/**
	 * Tool calls observed in the session's transcript. REPLACES the stored set
	 * when present; `undefined` means "this producer could not see tools" and
	 * leaves the rows alone — which is what keeps a live re-upsert from a source
	 * without tool parsing from erasing what a full read collected.
	 */
	readonly tools?: ReadonlyArray<ToolCallCount>;
}

/**
 * One recall call, observed by the surface that served it.
 *
 * The odd one out among these events: every other one restates a fact that
 * still exists somewhere else (a commit, a session file, a summary), so losing
 * it costs a rescan. A recall call exists only while it is being answered.
 * That is why it is emitted from the answering edges — `runRecall` (MCP) and
 * the `jolli recall` command — instead of being recovered later from a
 * transcript, which is what the Recall card used to do and what made every CLI
 * run, every non-Claude agent and everything past the 48 h session-retention
 * window invisible to it.
 *
 * `sessionId` is the agent's own session id when the host exposes one in the
 * environment, absent otherwise (a recall typed into a plain terminal).
 */
export interface RecallObservedEvent {
	readonly type: "recall.observed";
	readonly repoIdentity: string;
	readonly surface: RecallSurface;
	readonly atMs: number;
	readonly sessionId?: string;
	readonly outcome: RecallOutcome;
}

/** Which surface answered a recall call. */
export type RecallSurface = "mcp" | "cli";

/** One file touched by a commit, as `git --numstat` reports it. */
export interface CommitFileChange {
	/** Repo-relative, forward-slashed — git's own path form. */
	readonly path: string;
	/**
	 * Absent for a binary file: `--numstat` prints `-` there rather than a count,
	 * and recording 0 would make binary churn look like no churn at all.
	 */
	readonly insertions?: number;
	readonly deletions?: number;
}

/** A commit observed for a repo. Idempotent on `(repo, hash)`. */
export interface CommitCreatedEvent {
	readonly type: "commit.created";
	readonly repoIdentity: string;
	readonly hash: string;
	readonly branch?: string;
	/**
	 * Every branch this commit is currently reachable from. Replaces the whole
	 * `commit_branches` set for the commit — an empty array is meaningful (the
	 * commit is unreachable from any tracked ref) and prunes the old rows.
	 */
	readonly branches?: ReadonlyArray<string>;
	readonly message?: string;
	readonly authorName?: string;
	readonly authorEmail?: string;
	readonly committedAtMs: number;
	readonly filesChanged?: number;
	readonly insertions?: number;
	readonly deletions?: number;
	/**
	 * The per-file breakdown behind those totals. REPLACES the stored set, on the
	 * same terms as `branches`: `undefined` means "not observed this time" and
	 * leaves the rows alone, so a producer that cannot afford the extra `git log
	 * --numstat` pass (the live post-commit path) never erases what bootstrap
	 * collected. An empty array is still meaningful — a merge commit shows no
	 * diff, and that is a fact worth storing rather than a gap.
	 */
	readonly files?: ReadonlyArray<CommitFileChange>;
}

/** Workspace dirty-state for one repo+branch. Latest write wins. */
export interface WorktreeStatusEvent {
	readonly type: "worktree.status";
	readonly repoIdentity: string;
	readonly branch?: string;
	readonly filesChanged: number;
	readonly insertions: number;
	readonly deletions: number;
	readonly observedAtMs: number;
}

/** Insight kinds mined from a commit's memory (the standup board's buckets). */
export type CommitInsightKind = "decision" | "blocker" | "question" | "todo" | "gotcha";

export interface CommitInsightItem {
	readonly kind: CommitInsightKind;
	readonly text: string;
	/** Who a question is addressed to (G-8) — absent for self-directed items. */
	readonly addressedTo?: string;
}

/** One external reference (Linear/Jira/GitHub/…) archived on a commit. */
export interface CommitReferenceItem {
	readonly source: string;
	readonly nativeId: string;
	readonly title?: string;
	readonly url?: string;
}

/** An exact session↔commit attribution recovered from the memory pipeline. */
export interface SessionLinkItem {
	readonly source: TranscriptSource;
	readonly sessionId: string;
	readonly confidence: "exact" | "heuristic";
	/**
	 * Message count of the stored transcript. Lets the projection seed a
	 * minimal session row when the session predates live discovery — the
	 * stored transcript is the ONLY record of sessions older than the agents'
	 * own retention, so dropping the link for lack of a row would erase
	 * exactly the history the memory pipeline preserved.
	 */
	readonly messageCount?: number;
	/**
	 * This session's own per-model token/cost attribution, when the stored
	 * transcript captured it (`StoredSession.usageByModel`). Same shape
	 * `session.upserted` carries for a live read, so a row seeded from this
	 * link can honestly mark `token_coverage: "full"` instead of a permanent
	 * zero — the queue worker already computed this share while writing the
	 * transcript, it just was never projected until now.
	 */
	readonly models?: ReadonlyArray<StatsModelUsage>;
	/**
	 * This session's tool / MCP / skill calls, when the stored transcript
	 * captured them (`StoredSession.toolUse`). Same replace-when-observed
	 * contract `session.upserted` uses: absent means the memory recorded none —
	 * either it predates the field or the source cannot report tool calls — and
	 * the projection must leave existing rows alone rather than clearing them.
	 */
	readonly tools?: ReadonlyArray<ToolCallCount>;
}

/**
 * Memory-tier enrichment of a commit (JOLLI-2069 phase 2): what the summary
 * pipeline learned about it. Idempotent on `(repo, hash)`; the provided
 * `insights` / `references` / `sessionLinks` arrays each REPLACE the stored
 * set (undefined = leave as is).
 */
export interface CommitSummaryEvent {
	readonly type: "commit.summary";
	readonly repoIdentity: string;
	readonly hash: string;
	/** Lets the projection create the commit row when the summary arrives first. */
	readonly committedAtMs: number;
	readonly branch?: string;
	readonly message?: string;
	/** Conversation turns consumed into this commit. */
	readonly turns?: number;
	/** Conversation tokens (input + output + cached) consumed into this commit. */
	readonly tokens?: number;
	readonly estCostUsd?: number;
	readonly ticketId?: string;
	/*
	 * No workCategory here. Category belongs to a TOPIC and the topics are
	 * projected into `memory_topics`; the "Work category" axis reads that table
	 * with the commit's tokens shared across its topics, so the axis still sums
	 * to the real total — which is what the old "dominant category" mode was
	 * for, at the cost of erasing every category that never won a commit's vote.
	 */
	readonly insights?: ReadonlyArray<CommitInsightItem>;
	readonly references?: ReadonlyArray<CommitReferenceItem>;
	readonly sessionLinks?: ReadonlyArray<SessionLinkItem>;
}

/** Registry projection: a repo was enabled (or its metadata changed). */
export interface RepoEnabledEvent {
	readonly type: "repo.enabled";
	readonly repoIdentity: string;
	readonly repoName: string;
	readonly worktreeRoot: string;
	readonly remoteUrl?: string;
	readonly enabledAt: string;
}

/** Registry projection: a repo was disabled. Rows are kept, not deleted. */
export interface RepoDisabledEvent {
	readonly type: "repo.disabled";
	readonly repoIdentity: string;
	readonly disabledAt: string;
}

export type StatsEvent =
	| SessionUpsertedEvent
	| CommitCreatedEvent
	| CommitSummaryEvent
	| WorktreeStatusEvent
	| RepoEnabledEvent
	| RepoDisabledEvent
	| RecallObservedEvent;

/** Envelope written to `events_raw`, carrying provenance alongside the payload. */
export interface StatsEventEnvelope {
	readonly event: StatsEvent;
	readonly producerKind: ProducerKind;
	readonly producerVersion?: string;
	readonly occurredAtMs?: number;
}

/**
 * Deterministic primary key for an event's projected row.
 *
 * Determinism is the whole idempotency story: bootstrap, gap recovery and a
 * live hook can all emit the same logical fact, and they must collide on one
 * row rather than accumulate duplicates. Repo identity is part of the key
 * because neither a session id nor a commit hash is unique across repos.
 */
export function statsEventId(event: StatsEvent): string {
	switch (event.type) {
		case "session.upserted":
			return `session:${event.repoIdentity}:${event.source}:${event.sessionId}`;
		case "commit.created":
			return `commit:${event.repoIdentity}:${event.hash}`;
		case "commit.summary":
			// Distinct from commit.created's id: events_raw keeps both provenance
			// trails, while the projection converges on the same commits row.
			return `commit-summary:${event.repoIdentity}:${event.hash}`;
		case "worktree.status":
			return `worktree:${event.repoIdentity}:${event.branch ?? ""}`;
		case "recall.observed":
			// A call is identified by WHEN it happened, because that is the only
			// thing that distinguishes two of them: same repo, same surface, same
			// session, possibly the same result. Two calls in the same millisecond
			// would collide into one row — accepted, since the alternative (a
			// random id) would make a re-drained event duplicate instead.
			return `recall:${event.repoIdentity}:${event.surface}:${event.atMs}`;
		case "repo.enabled":
		case "repo.disabled":
			return `repo:${event.repoIdentity}`;
	}
}

// ── Read model ──────────────────────────────────────────────────────────────

/** Which adoption tier the data supports — drives the locked-card rendering. */
export type AdoptionTier = "installed" | "memory" | "space";

/**
 * Which page a model was built for.
 *
 * `stats`/`standup` predate the six-destination nav (JOLLI local web server
 * redesign) and keep their historical tokens, but each renders at exactly one
 * path — `stats` at `/dashboard`, `standup` at `/dashboard/standup`. Their
 * original `/stats`/`/standup` paths were removed rather than kept as aliases:
 * one page, one URL. `decisions` is retired entirely — its content folded
 * into Memories' per-topic Decisions callout — and `/decisions` now 302s to
 * `/memories`, so this union no longer carries that token.
 */
export type DashboardView = "stats" | "standup" | "repositories" | "memories";

/**
 * The Repositories page payload — also first-run setup once it grows a write
 * surface. Minimal today: which repos are enabled. `RepositoriesQuery` (a
 * later phase) adds bootstrap state, memory/session counts and the enable
 * flow; this shape is deliberately small so it cannot drift ahead of what is
 * actually queried.
 */
export interface RepositoryRow {
	readonly repoIdentity: string;
	readonly repoName: string;
	readonly worktreeRoot: string;
	/** Canonical remote URL. Absent for local-only repos (their identity is a path hash, not a URL). */
	readonly remoteUrl?: string;
	/** `false` means disabled/paused — the row is kept (RepoRegistry never deletes), not dropped. */
	readonly enabled: boolean;
	readonly memories: number;
	readonly sessions: number;
}

/**
 * The Repositories page carries no job/progress shape: backfill has no entry
 * point in this server (see `DashboardServer.ts`'s header), so there is no
 * long-running work for a page to rejoin. Generation progress belongs to the
 * CLI that started it.
 */
export interface RepositoriesModel {
	readonly repos: ReadonlyArray<RepositoryRow>;
	readonly hooksManifest: ReadonlyArray<{ readonly title: string; readonly detail: string }>;
}

/**
 * The Knowledge nav destination's honest placeholder counts.
 *
 * The CLI already compiles a knowledge wiki (`jolli compile`) into
 * `topic_pages`/`topic_source_refs`, but no endpoint serves it to this app
 * yet — the page states that rather than rendering a finished view. The count
 * is real (a plain `topic_pages` tally) so the placeholder says how much is
 * waiting rather than just that something is.
 */
export interface KnowledgeModel {
	readonly topicPages: number;
}

// ── Settings page ───────────────────────────────────────────────────────────

/**
 * The Settings/Repositories provider choice, reshaped from `aiProvider` by
 * `EnvFacts.ts`'s `readEnvironmentFacts`. `"none"` covers both an unset
 * config and a value this reader does not recognise — both mean "nothing
 * chosen yet" to the page.
 */
export type SummarizerProvider = "local" | "apikey" | "account" | "none";

export interface SettingsSummarizerState {
	readonly provider: SummarizerProvider;
	readonly localAgentTool?: LocalAgentToolId;
	/** Local agent tools present on this machine, in display order. */
	readonly agentsPresent: ReadonlyArray<{ readonly id: LocalAgentToolId; readonly label: string }>;
	/** Whether an Anthropic API key is on file — never the key itself. */
	readonly keyConfigured: boolean;
	/** Whether a Jolli Space account is on file — never the key itself. */
	readonly signedIn: boolean;
	/** No provider is configured yet — the page must ask rather than assume one. */
	readonly mustAsk: boolean;
}

export interface SettingsPrivacyState {
	/** The server's actual bound port — never a literal, so Settings cannot drift from what is really listening. */
	readonly port: number;
	readonly transcriptsLocal: true;
	/** Whether the configured summarizer sends commit context to a remote API. */
	readonly summarizerLeaves: boolean;
}

/**
 * One repo's real installed-hook status — a filesystem/JSON-file probe, not
 * `Installer.getStatus()`'s much heavier machine-wide sweep. No orphan-branch
 * check: that needs a git subprocess, which this cheap-by-design probe does
 * not spend.
 */
export interface RepoHookStatus {
	readonly repoIdentity: string;
	readonly repoName: string;
	readonly gitHookInstalled: boolean;
	readonly claudeHookInstalled: boolean;
	readonly geminiHookInstalled: boolean;
	readonly mcpRegistered: boolean;
}

/** The Settings page payload. */
export interface SettingsModel {
	readonly summarizer: SettingsSummarizerState;
	readonly hooks: ReadonlyArray<RepoHookStatus>;
	readonly privacy: SettingsPrivacyState;
}

// ── Memories page ───────────────────────────────────────────────────────────

/**
 * Most rows one Memories list payload carries — same reasoning as
 * {@link DECISIONS_LIMIT}: the model is inlined into the HTML, so this is a
 * page budget, not a data-retention statement.
 */
export const MEMORIES_LIST_LIMIT = 200;

/** One row in the Memories tree — a repo>branch>memory browser groups these client-side. */
export interface MemoryListItem {
	readonly repoIdentity: string;
	readonly repoName: string;
	readonly commitHash: string;
	/** First 7 hex chars — the handle used everywhere a memory is referenced. */
	readonly shortHash: string;
	/** Human-facing Jolli Memory id, present only after a successful Space push. */
	readonly memoryRefId?: string;
	/** Commit subject — the tree row's label. */
	readonly title: string;
	readonly branch?: string;
	readonly committedAtMs: number;
	readonly ticketId?: string;
	/** Mode of the commit's topic categories (same query-time label as {@link StandupCommit.workCategory}). */
	readonly category?: string;
	/** Whether this memory has been pushed to a Jolli Space (`summary.jolliDocId` set). */
	readonly synced: boolean;
}

/** One conversation that fed a memory — {@link MemoryDetail.conversations}. */
export interface MemoryConversationRow {
	readonly title: string;
	readonly source: string;
	readonly messageCount: number;
}

/** One external reference (Linear/GitHub/…) archived on a memory. */
export interface MemoryReferenceRow {
	readonly source: string;
	readonly nativeId: string;
	readonly title: string;
	readonly url?: string;
}

/** One plan or note associated with a memory. */
export interface MemoryContextRow {
	readonly kind: "plan" | "note";
	readonly title: string;
	/**
	 * `context.context_key` — the plan's slug or the note's id, i.e. what
	 * `/api/context` needs to fetch the body. Carried on the row rather than
	 * re-derived in the client because the archived slug is not the title and
	 * cannot be recovered from it.
	 */
	readonly contextKey: string;
}

/**
 * A plan/note body, served by `/api/context` for the Context viewer.
 *
 * No `url`: the `context` table CHECK-constrains that column to `reference`
 * rows, so a plan or note can never have one — a field here would be dead by
 * construction.
 */
export interface ContextDoc {
	readonly kind: "plan" | "note";
	readonly title: string;
	readonly bodyMd: string;
}

/** One context item the relevance ranker judged unrelated and soft-excluded. */
export interface MemoryExcludedRow {
	readonly title: string;
	readonly reason: string;
}

/**
 * One tool (or MCP server) called by the sessions behind a memory — the
 * mockup's "Read ×22" style row. `label` is the server name for an MCP call,
 * else the tool name; no call arguments are stored, so the row is a count,
 * never a description of what was read.
 */
export interface MemoryActivityRow {
	readonly label: string;
	readonly kind: ToolCallKind;
	readonly calls: number;
}

/** One topic within a memory — {@link TopicSummary} reshaped for display. */
export interface MemoryTopic {
	readonly title: string;
	readonly category?: string;
	readonly trigger: string;
	/**
	 * `TopicSummary.decisions` is one prose field (markdown bullets or a plain
	 * sentence), not an array — split here so the UI's Decisions callout and
	 * the feed card's one-liner ({@link DashboardModel} `decisions` page,
	 * `firstDecisionLine`) can never disagree about what the bullets are.
	 */
	readonly decisions: ReadonlyArray<string>;
	readonly response: string;
	readonly todo?: string;
	readonly files: ReadonlyArray<string>;
}

/** One file touched by a memory's commit. No A/M/D status is stored — see {@link MemoryDetail.files}. */
export interface MemoryFileRow {
	readonly path: string;
	readonly insertions?: number;
	readonly deletions?: number;
}

/** One E2E verification scenario recorded on a memory. */
export interface MemoryE2eScenario {
	readonly title: string;
	readonly preconditions?: string;
	readonly steps: ReadonlyArray<string>;
	readonly expectedResults: ReadonlyArray<string>;
}

/**
 * Full detail for one memory — the reading pane's payload. Built only for the
 * `?hash=` the request named (same discipline as the graph page: one memory
 * per request, never the whole corpus).
 *
 * Several mockup fields have no counterpart in this schema and are
 * deliberately absent rather than invented — see the field comments below and
 * `MemoriesQuery.ts`'s header for the full list (conversation `kind`, an
 * "Immutable" flag, minted `JM-###` ids, per-file A/M/D status).
 */
export interface MemoryDetail {
	readonly repoIdentity: string;
	readonly repoName: string;
	readonly commitHash: string;
	readonly shortHash: string;
	readonly title: string;
	readonly branch?: string;
	readonly author?: string;
	readonly committedAtMs: number;
	readonly ticketId?: string;
	readonly category?: string;
	readonly synced: boolean;
	readonly filesChanged?: number;
	readonly insertions?: number;
	readonly deletions?: number;
	/** The CONVERSATION's tokens (what was said to produce this commit) — not Jolli's own summarization call. */
	readonly tokens?: {
		readonly input: number;
		readonly output: number;
		readonly cached: number;
		readonly costUsd?: number;
		readonly pricesAsOf?: string;
	};
	/** Jolli's own summarization call — the model that WROTE this memory, distinct from {@link tokens}. */
	readonly summarizedBy?: { readonly model: string; readonly tokens: number };
	readonly recap?: string;
	readonly conversations: ReadonlyArray<MemoryConversationRow>;
	readonly references: ReadonlyArray<MemoryReferenceRow>;
	readonly context: ReadonlyArray<MemoryContextRow>;
	readonly excluded: ReadonlyArray<MemoryExcludedRow>;
	readonly activity: ReadonlyArray<MemoryActivityRow>;
	/** Sources among this memory's linked sessions whose transcripts cannot record tool calls — see {@link ToolUsage.uncoveredSources}. */
	readonly activityUncoveredSources: ReadonlyArray<string>;
	readonly topics: ReadonlyArray<MemoryTopic>;
	readonly files: ReadonlyArray<MemoryFileRow>;
	readonly e2e: ReadonlyArray<MemoryE2eScenario>;
}

/** The Memories page payload. */
export interface MemoriesModel {
	/** Newest first, across every repo in scope. */
	readonly items: ReadonlyArray<MemoryListItem>;
	readonly totalCount: number;
	/** True when `items` hit {@link MEMORIES_LIST_LIMIT} and more were dropped. */
	readonly truncated: boolean;
	readonly vitals: { readonly memories: number; readonly topics: number; readonly repos: number };
	/** Present only when the request named a `?hash=` this scope can resolve. */
	readonly selected?: MemoryDetail;
}

/** Repo scope of a model: one repo or every enabled repo. */
export interface DashboardScope {
	readonly kind: "all" | "repo";
	readonly repoIdentity?: string;
}

export interface RepoOption {
	readonly repoIdentity: string;
	readonly repoName: string;
	readonly worktreeRoot: string;
	/** Sessions in the last 7 local days — the sidebar's per-repo meta figure. */
	readonly sessionsThisWeek: number;
}

/**
 * Time window the page is scoped to. Drives the KPI row, the series and the
 * session feed together, so every number on the page answers the same
 * question. The heatmap and the records row stay at their own 12-week span by
 * design (they ARE the long view), which is why `range` does not collapse them.
 *
 * `custom` carries its bounds out-of-band (`QueryOptions.customFrom` / `To`);
 * every other member is a fixed number of days ending today. Whichever was
 * asked for, the resolved bounds come back as `StatsModel.rangeFrom` / `To`.
 */
/** `today` and `2w` remain accepted for older deep links; the dashboard picker
 * intentionally presents the clearer 7d / 30d / 90d choices. */
export type DashboardRange = "today" | "week" | "2w" | "month" | "3m" | "custom";

/** One KPI card on the Stats page. */
export interface KpiCard {
	readonly key: string;
	readonly label: string;
	readonly value: string;
	readonly hint?: string;
}

/** One local calendar day in the cost/token series. `date` is `YYYY-MM-DD` local. */
export interface DaySeriesPoint {
	readonly date: string;
	readonly tokens: number;
	readonly estCostUsd: number;
	/** Split along the currently requested dimension (model, agent, …). */
	readonly bySeries: Readonly<Record<string, number>>;
}

/** One cell of the 12-week heatmap. */
export interface HeatmapCell {
	readonly date: string;
	readonly sessions: number;
	/** Commits carry the long tail — history older than the live-log window. */
	readonly commits: number;
	readonly tokens: number;
}

export interface HourBucket {
	readonly hour: number;
	readonly sessions: number;
}

export interface FunStats {
	readonly legendarySessionMinutes: number;
	readonly legendarySessionTitle?: string;
	/** Conversation turns of the longest session (memory tier); absent below it. */
	readonly legendarySessionTurns?: number;
	readonly biggestDayDate?: string;
	readonly biggestDayTokens: number;
	readonly nightOwlSharePct: number;
}

/** A row in "What my agents did". */
export interface RecentSession {
	readonly sessionId: string;
	readonly source: string;
	readonly title: string;
	readonly messageCount: number;
	readonly updatedAtMs: number;
	readonly repoName: string;
	/** Derived from `updatedAtMs` recency at query time — never stored. */
	readonly isLive: boolean;
}

/**
 * One "What my agents did" memory card — the mockup's tier-1 feed row: a commit
 * with the session summary that produced it.
 *
 * Read from the SOT tables (`memories`/`memory_topics`), not from the
 * read-model `commits` table: the fields below only exist on a summarized
 * commit, and the summary payload is where the decision text and the working
 * models live.
 *
 * Two of the mockup's fields are deliberately absent rather than invented:
 *   - `reuse` ("recalled by N teammates") needs recall receipts, which nothing
 *     records yet; the stylesheet only reveals that chip at the Space tier.
 *   - severity ("major"/"minor") has no stored counterpart, so {@link severity}
 *     is derived from the diff magnitude and labelled as such.
 */
export interface MemoryCard {
	/** Stable repo token used to open this memory from a cross-repository dashboard. */
	readonly repoIdentity: string;
	readonly commitHash: string;
	/** Commit subject — the card title. */
	readonly title: string;
	/** Dominant topic category (`feature`, `bugfix`, …); absent when untagged. */
	readonly category?: string;
	/** Diff-magnitude bucket, NOT a stored judgement. See {@link MEMORY_CARD_MAJOR_LINES}. */
	readonly severity: "major" | "minor";
	readonly committedAtMs: number;
	/** First recorded decision, else the recap. Absent when the summary has neither. */
	readonly decision?: string;
	readonly estCostUsd?: number;
	readonly turns?: number;
	readonly insertions?: number;
	readonly deletions?: number;
	readonly branch?: string;
	/** The model that did the work (dominant by output tokens) — not the summarizer. */
	readonly model?: string;
	readonly repoName: string;
}

/**
 * Changed lines at or above which a memory card reads as "major".
 *
 * The mockup carries a `major`/`minor` badge that has no counterpart in stored
 * data, so it is derived from diff size — the one signal that is always present
 * and needs no interpretation. Kept as a named constant so the UI's wording and
 * this threshold cannot drift apart.
 */
export const MEMORY_CARD_MAJOR_LINES = 200;

/**
 * Rows in the memory-card feed. The mockup caps nothing (its fixture holds
 * nine), but a real repo has thousands of summarized commits, so the feed takes
 * the same 20 the session feed does — enough to scan, bounded for the payload.
 */
export const MEMORY_CARDS_LIMIT = 20;

/**
 * Which axis the series is split along, mirroring the mockup's "group by" chips.
 *
 * `model`, `agent` and `project` come from session/repo data and work at any
 * tier; `branch`, `ticket` and `category` read the memory-enriched commit
 * columns, so they stay locked until the memory tier. (The mockup also locks
 * `project`; here it is genuinely available without memory, so it is not.)
 */
export type SeriesDimension = "model" | "agent" | "project" | "branch" | "ticket" | "category";

/**
 * Token volume by type, over the range — the "Where your tokens went" card.
 *
 * `cached` is one combined figure, not split into cache-write/cache-read: the
 * database only ever stores one `cached_tokens` column per session, so a
 * write/read split would have to be assumed rather than measured. Showing one
 * honest number beats inventing a ratio for it.
 */
export interface TokenBreakdown {
	readonly input: number;
	readonly output: number;
	readonly cached: number;
	/** One point per local day in the window, oldest first — the card's chart. */
	readonly perDay: ReadonlyArray<{
		readonly date: string;
		readonly input: number;
		readonly output: number;
		readonly cached: number;
	}>;
}

/** One decision mined from a commit memory — the Decisions card's "Latest" line. */
export interface DecisionRecord {
	readonly text: string;
	readonly commitHash: string;
	readonly repoName: string;
	readonly committedAtMs: number;
	/** One-sentence compression of `text`, generated on demand at display time — see DecisionGist.ts. Absent when not yet computed or the LLM call failed; callers fall back to `text`. */
	readonly gist?: string;
}

/**
 * Memory-tier "Decisions" card — a standalone widget distinct from the KPI
 * sub-line and from the per-commit `MemoryCard.decision` line in the feed.
 *
 * Deliberately carries no "recalled" figure: that needs recall receipts, which
 * (like {@link MemoryCard}'s `reuse` field) nothing records yet. Inventing one
 * here would make the same unmeasured claim twice.
 */
export interface DecisionsCard {
	/** Decisions mined from commit memories in the window. */
	readonly keptCount: number;
	readonly repoCount: number;
	/** Most recent decision by commit date, absent when the window has none. */
	readonly latest?: DecisionRecord;
	/** One point per local day in the window, oldest first — the card's step chart. */
	readonly perDay: ReadonlyArray<{ readonly date: string; readonly count: number }>;
}

/** The Stats page payload. */
export interface StatsModel {
	readonly kpis: ReadonlyArray<KpiCard>;
	readonly series: ReadonlyArray<DaySeriesPoint>;
	/** Series keys present in `series[].bySeries`, in render order. */
	readonly seriesKeys: ReadonlyArray<string>;
	/** The dimension `series`/`seriesKeys` were built along. */
	readonly seriesDimension: SeriesDimension;
	readonly heatmap: ReadonlyArray<HeatmapCell>;
	readonly hours: ReadonlyArray<HourBucket>;
	/** Token volume by type, over the range — available at every tier, like `kpis`. */
	readonly tokenBreakdown: TokenBreakdown;
	/**
	 * Est. cost vs the immediately preceding window of equal length — Cost &
	 * tokens' own self-trend. Absent when the previous window has no priced
	 * sessions to compare against.
	 */
	readonly costTrendPct?: number;
	readonly fun: FunStats;
	/**
	 * The tier-0 feed: raw sessions from local agent logs. The renderer shows
	 * these only when memory is off — with memory on, {@link memoryCards} is the
	 * feed and these sessions are what produced those commits.
	 */
	readonly recentSessions: ReadonlyArray<RecentSession>;
	/** The tier-1+ feed. Empty at the local tier (no summaries to draw from). */
	readonly memoryCards: ReadonlyArray<MemoryCard>;
	/**
	 * Commits in the window, memory tier or not — the denominator behind Memory
	 * Activity's "X of Y captured" line and the source of its gap count
	 * (`totalCommits - memoriesCreated`). Unlike {@link memoriesCreated} this
	 * needs no memory data, so it is never undefined.
	 */
	readonly totalCommits: number;
	/** The window these figures cover, echoed back for the range control. */
	readonly range: DashboardRange;
	/**
	 * Inclusive local `YYYY-MM-DD` bounds of that window — always present, for a
	 * preset as much as for `custom`.
	 *
	 * Echoed back rather than recomputed in the page for two reasons: the browser
	 * would have to redo the server's zone arithmetic to agree with it, and a
	 * custom request can be *clamped* (a future `to`, a `from` past the scan cap,
	 * or a reversed pair falling back to the default). A control that kept
	 * displaying the rejected input would misreport which window the numbers
	 * cover, which is the one thing a range picker must never do.
	 */
	readonly rangeFrom: string;
	readonly rangeTo: string;
	/**
	 * Price-table date behind every cost figure, so a reader can judge staleness
	 * (the mockup prints it in the cost card's subtitle). Absent when no priced
	 * session exists yet.
	 */
	readonly pricesAsOf?: string;
	/**
	 * Commit memories written in the window, and decisions mined from them —
	 * the mockup's two KPI sub-lines. `undefined` (not 0) below the memory tier,
	 * so the card can render the mockup's "—" rather than claim a real zero.
	 */
	readonly memoriesCreated?: number;
	readonly decisionsCaptured?: number;
	/** The standalone Decisions card. Mirrors {@link decisionsCaptured} in `keptCount`. */
	readonly decisions?: DecisionsCard;
	/** Skills, MCP servers and the tool mix — Claude-only coverage, stated. */
	readonly toolUsage: ToolUsage;
	/** How often recall actually served usable context — Claude-only coverage, stated. */
	readonly recallUsage: RecallUsage;
}

/** A commit row on the Standup page. */
export interface StandupCommit {
	readonly hash: string;
	readonly message: string;
	readonly branch?: string;
	readonly committedAtMs: number;
	readonly repoName: string;
	readonly filesChanged?: number;
	readonly insertions?: number;
	readonly deletions?: number;
	/**
	 * Memory-tier columns, feeding the board's outcome rows (the mockup's
	 * `$2.29 est · 3 turns · +58 −11`) and its ticket grouping. Each is absent
	 * rather than zero when the summary pipeline has not enriched the commit —
	 * "$0.00 est" is a claim, "not shown" is the truth.
	 */
	readonly turns?: number;
	readonly estCostUsd?: number;
	readonly ticketId?: string;
	/**
	 * Commit-level LABEL for the board's `TICKET · category` group header —
	 * the mode of the commit's topic categories, derived at query time from
	 * `memory_topics` (ties break toward the first-appearing topic). A label,
	 * not an aggregation axis: sums over categories read `memory_topics`.
	 */
	readonly workCategory?: string;
}

/** Uncommitted work in one worktree. */
export interface StandupWorkspace {
	readonly repoName: string;
	readonly branch?: string;
	readonly filesChanged: number;
	readonly insertions: number;
	readonly deletions: number;
}

/** One memory-mined insight rendered on the standup board (memory tier). */
export interface StandupInsight {
	readonly kind: CommitInsightKind;
	readonly text: string;
	readonly commitHash: string;
	readonly repoName: string;
	readonly addressedTo?: string;
	/**
	 * When the commit that raised it landed — the board's age tag ("2 days",
	 * critical past three). It is the only date on record for an insight, and it is
	 * the right one: an unanswered question is as old as the commit that asked it.
	 */
	readonly committedAtMs: number;
}

/** The Standup page payload. */
export interface StandupModel {
	/** Local `YYYY-MM-DD` the board was built for. */
	readonly today: string;
	readonly yesterday: string;
	readonly yesterdaySessions: ReadonlyArray<RecentSession>;
	readonly yesterdayCommits: ReadonlyArray<StandupCommit>;
	readonly todaySessions: ReadonlyArray<RecentSession>;
	readonly todayCommits: ReadonlyArray<StandupCommit>;
	readonly workspaces: ReadonlyArray<StandupWorkspace>;
	/**
	 * Risks/blockers/questions/TODOs mined from the window's commit memories.
	 * Present (possibly empty) from the memory tier onwards; absent renders the
	 * locked card.
	 */
	readonly insights?: ReadonlyArray<StandupInsight>;
}

/** One tool, skill or MCP server, aggregated over the window. */
export interface ToolUsageRow {
	/** `Bash`, `linear.list_issues`, `code-review`. */
	readonly name: string;
	readonly kind: ToolCallKind;
	/** Sessions that called it — the adoption figure, not the volume figure. */
	readonly sessions: number;
	readonly calls: number;
}

/** One MCP server, rolled up across all of its tools. */
export interface McpServerRow {
	readonly server: string;
	/** Distinct sessions that called ANY of its tools — exact, not a bound. */
	readonly sessions: number;
	readonly calls: number;
	/** Distinct tools of that server actually called. */
	readonly tools: number;
}

/** How many rows the skill and server lists carry. */
export const TOOL_ROWS_LIMIT = 8;

/**
 * `server.tool` name recorded for the recall feature's own MCP tool — the
 * `session_tool_use.tool_name` value the tool-usage card keys off for its
 * "recall calls" line. The Recall card counts `recall_receipts` — which also
 * sees CLI runs and non-Claude agents — and reads this table only for the
 * pre-receipt history (`RecallUsage.callsWithoutReceipt`).
 */
export const RECALL_MCP_TOOL_NAME = "jollimemory.recall";

/**
 * The `context` row identity of a recall bookmark — `jollimemory`'s own,
 * self-referential reference source (`cli/src/core/references/sources/
 * definitions/jollimemory.ts`), whose `nativeId` is the TOOL because its
 * identity is an act rather than an entity.
 *
 * The Recall card reads it as the second pre-receipt channel: its body carries
 * one timestamped entry per call, which is what the tool-usage rows lack.
 */
export const RECALL_REFERENCE_SOURCE = "jollimemory";
export const RECALL_REFERENCE_NATIVE_ID = "recall";

/**
 * Suffix that recognises the recall tool under a NAMESPACED server name.
 *
 * `parseToolUse` stores `<server>.<tool>` taken from the wire name, and the
 * server segment is not guaranteed to be the bare `jollimemory`: a host that
 * registers the same stdio server through a plugin manifest prefixes it, which
 * would store e.g. `plugin_jolli_jollimemory.recall`. An equality test against
 * the bare name is then the silent kind of wrong — 0 forever, indistinguishable
 * from "nobody recalled".
 *
 * A suffix rather than an enumerated alias list because the prefix format is
 * the HOST's, not ours: no such row exists in any database or transcript on
 * this machine (checked 2026-08-08 — every stored row is the bare form), so
 * hard-coding a guessed spelling would be a second silent miss if the guess is
 * wrong, while the suffix holds for any prefix. The `_` boundary is what keeps
 * it from matching an unrelated server whose name merely ends in the same
 * letters.
 */
export const RECALL_MCP_TOOL_SUFFIX = "_jollimemory.recall";

/** True for the recall MCP tool under the bare server name or any namespaced one. */
export function isRecallMcpToolName(toolName: string): boolean {
	return toolName === RECALL_MCP_TOOL_NAME || toolName.endsWith(RECALL_MCP_TOOL_SUFFIX);
}

/**
 * `session_tool_use` name of the recall SKILL, as `parseToolUse` records it
 * (a `Skill` call is attributed to `input.skill`, so this is the skill's
 * directory name, and its `kind` is `skill` — never `mcp`).
 */
export const RECALL_SKILL_NAME = "jolli-recall";

/**
 * Every `input.skill` spelling of the recall skill.
 *
 * The installed skill is a directory under `.agents/skills/`, so it records
 * bare (`jolli-recall`). A skill that arrives from a PLUGIN records
 * `<plugin>:<skill>` instead — measured: real transcripts on this machine
 * carry `j:rebase` beside the bare names — and the Jolli plugin re-heads its
 * copies to `jolli:<name>` (see AGENTS.md on `CODEX_PLUGIN_SKILLS`). So a
 * plugin install spells this `jolli:recall`, which matches neither the bare
 * name nor any prefix of it.
 *
 * This matters more than a missing count: `skillInvocations` exists to expose
 * the gap "the skill ran but never actually recalled", so a name that never
 * matches makes the gap detector itself blind.
 */
export const RECALL_SKILL_NAMES: ReadonlyArray<string> = [RECALL_SKILL_NAME, "jolli:recall"];

/**
 * Tool, skill and MCP-server usage over the window.
 *
 * Coverage is the load-bearing part of this shape. Only Claude transcripts
 * record tool calls today, so `sessionsWithTools` / `sessionsInWindow` and the
 * explicit `uncoveredSources` list travel with every payload: without them a
 * machine that runs one Claude session and forty Codex ones would present
 * Claude's tool mix as the whole team's, and an unused MCP server would be
 * indistinguishable from one used only from an unreadable agent.
 *
 * There is deliberately no "unused servers" figure. Knowing a server was never
 * called requires knowing which servers are REGISTERED, which lives in each
 * host's own config file, not here — and an "unused" claim computed from an
 * agent-blind sample would be wrong in the expensive direction (telling someone
 * to disable a server they use daily from Codex).
 *
 * A KNOWN gap `uncoveredSources` does not catch: a session seeded by
 * `projectCommitSummary`'s `sessionLinks` path (older than the source agent's
 * own retention — see that function's doc comment) never gets a
 * `session_tool_use` row at all, because nothing re-parses its transcript.
 * Its source is still "claude" (in `TOOL_RECORDING_SOURCES`), so today it
 * reads identically to a real zero. There is no per-session flag recording
 * "seeded, never scanned" to fix this precisely without a schema change; the
 * dashboard states the limitation in the card's footnote instead.
 */
export interface ToolUsage {
	/** Skills, most-adopted first. */
	readonly skills: ReadonlyArray<ToolUsageRow>;
	/** MCP servers, most-adopted first. */
	readonly servers: ReadonlyArray<McpServerRow>;
	/** Individual MCP tools (name already `server.tool`), most-adopted first — the "by tool" split of `servers`. */
	readonly mcpTools: ReadonlyArray<ToolUsageRow>;
	/**
	 * The recall feature's own row (`jollimemory.recall`), pulled out of `mcpTools`
	 * before that array is truncated to TOOL_ROWS_LIMIT — recall can rank outside
	 * the top 8 MCP tools by adoption even when it has real volume, so this must
	 * not be derived from `mcpTools` client-side. `undefined` when the window has
	 * no matching row (misses bare `jolli recall` CLI runs and the skill's
	 * non-MCP fallback too — those never produce an `mcp`-kind row at all).
	 */
	readonly recallCalls?: ToolUsageRow;
	/** Sessions with at least one recorded tool call. */
	readonly sessionsWithTools: number;
	/** Sessions in the window, regardless of whether tools could be read. */
	readonly sessionsInWindow: number;
	/**
	 * Sources present in the window whose transcripts **cannot** record tool
	 * calls — a parser capability, not "happened to record none". A source that
	 * can be read but used no tools is deliberately absent: it is covered, and
	 * its zero is a real zero.
	 */
	readonly uncoveredSources: ReadonlyArray<string>;
}

/** One day's recall calls, split by outcome — the Recall card's bar chart. */
export interface RecallDayPoint {
	/** `YYYY-MM-DD`, local to the dashboard's resolved time zone. */
	readonly date: string;
	readonly used: number;
	readonly setAside: number;
}

/**
 * The Recall card: how often the model actually got prior commit context back
 * versus called recall and got nothing to work with. Derived from parsed
 * `tool_result` content, not from a live write at call time — see
 * `RecallOutcome` — so its coverage is the same Claude-only, transcript-only
 * shape as {@link ToolUsage}, and a bare `jolli recall` CLI run or the skill's
 * non-MCP fallback is invisible to it for the same reason. It also inherits
 * `ToolUsage`'s seeded-session gap: a session known only through
 * `projectCommitSummary`'s `sessionLinks` (older than the source agent's own
 * retention) never gets a `session_tool_use` row for recall at all — sessionLinks
 * carries no tool/payload data — so its zero recall calls cannot be told apart
 * from "never scanned". Recent activity is exact; older activity is
 * reconstructed and silently undercounts.
 */
export interface RecallUsage {
	/** Calls whose result carried at least one commit — the model had something to use. */
	readonly usedCalls: number;
	/** Calls that came back empty (no exact branch match, or nothing recorded). */
	readonly setAsideCalls: number;
	/** `usedCalls / (usedCalls + setAsideCalls) * 100`, rounded; `0` when both are 0. */
	readonly contextServedPct: number;
	/** Distinct commit hashes served by a used call, across the window. */
	readonly distinctMemoriesUsed: number;
	/** Of those, how many commits are more than 30 days old as of the window end. */
	readonly staleMemoriesUsed: number;
	/**
	 * Sessions with at least one used (not merely called) recall — counted over
	 * the receipts that carry a session id. A recall run outside any agent
	 * session (a plain terminal) still counts in {@link usedCalls} but belongs
	 * to no session and is deliberately not invented one here.
	 */
	readonly sessionsWithContext: number;
	/** Sessions in the window, whether or not they called recall. */
	readonly sessionsInWindow: number;
	/**
	 * Calls per answering surface, for the whole window. No `uncoveredSources`
	 * sits beside it any more: a receipt is written by the code that serves the
	 * call, so coverage no longer depends on whether the caller's agent writes
	 * parseable transcripts — every source is covered.
	 */
	readonly bySurface: ReadonlyArray<{ readonly surface: RecallSurface; readonly calls: number }>;
	/**
	 * How many times the `jolli-recall` SKILL was invoked in the window, from
	 * the transcripts that record skill calls.
	 *
	 * Deliberately its own figure rather than part of {@link usedCalls} /
	 * {@link setAsideCalls}: a skill invocation that goes on to recall (whether
	 * through the MCP tool or the CLI) already wrote its own receipt, so adding
	 * it would count that call twice and move the hit rate. What it adds is the
	 * gap — a skill that was invoked and never actually recalled, which is
	 * exactly what no other figure on this card can show.
	 *
	 * Windowed by the SESSION's `updated_at_ms`, since a per-tool row records
	 * no time of its own. A long session straddling the window edge therefore
	 * contributes all or none of its skill calls.
	 */
	readonly skillInvocations: number;
	/**
	 * Recall calls visible in the transcripts but with NO receipt behind them —
	 * the backfilled history.
	 *
	 * `recall_receipts` is written at the edge, by the surface that serves the
	 * call, so it starts the day that code shipped and nothing can reconstruct
	 * it: {@link usedCalls} / {@link setAsideCalls} / {@link distinctMemoriesUsed}
	 * all describe the call's RESULT, which no durable record keeps. The call
	 * ITSELF is durable though, in two independent places, so this figure says
	 * "recall was used N more times, outcome unknown" instead of leaving the
	 * card empty and implying it was never used at all:
	 *
	 *   - `session_tool_use` — `jollimemory.recall` per session, imported from
	 *     transcripts. Blind to a source that records no tool calls (the gap
	 *     {@link ToolUsage.uncoveredSources} names), and carries no per-call
	 *     time, so it is windowed by its session's `updated_at_ms`.
	 *   - the `jollimemory` context REFERENCE — one timestamped entry per call,
	 *     so it windows exactly, and it exists for any source the reference
	 *     extractor covers. Under-reports differently: a repeated query text
	 *     collapses to one entry and only the newest 20 survive.
	 *
	 * Each is a lower bound with a hole the other does not have, and they share
	 * no key that would let them be joined (a reference has no session id, a
	 * tool row has no timestamp) — so the larger of the two is taken. Summing
	 * would double-count the ordinary case where both saw the same call.
	 *
	 * Receipted MCP calls are then subtracted, so a window fully covered by
	 * receipts reports 0 here rather than showing the same calls twice. At a
	 * window edge the subtraction can be off by one straddling session's calls
	 * (the receipt and the tool row disagree about which window they are in);
	 * it is clamped at 0.
	 */
	readonly callsWithoutReceipt: number;
	/** Daily series for the bar chart, oldest first. */
	readonly daily: ReadonlyArray<RecallDayPoint>;
}

// ── Graph page ──────────────────────────────────────────────────────────────

/**
 * The knowledge graph for one repo, exactly as `jolli graph` produced it.
 *
 * `graph` is the canonical {@link KnowledgeGraph} from `cli/src/graph/GraphSchema`
 * — the SAME artifact the VS Code Memory Bank panel renders. It is carried
 * whole rather than reshaped: there is one knowledge-graph model in this
 * product, and a second dashboard-flavoured one is exactly the drift that makes
 * two surfaces disagree about what a node is.
 *
 * The artifact is per-repo, so this payload names the repo it belongs to. When
 * the page is scoped to "all repos", the server picks the single repo that has
 * a graph, or reports the candidates so the reader can choose.
 */
export interface RepoGraphModel {
	/** Absent when no repo in scope has run `jolli graph` yet. */
	readonly graph?: KnowledgeGraph;
	/** Which repo `graph` came from. */
	readonly repoIdentity?: string;
	readonly repoName?: string;
	/** When `jolli graph` produced it — the staleness signal. */
	readonly generatedAt?: string;
	/**
	 * Repos in scope that have a graph, when there is more than one. The page
	 * renders a chooser instead of silently picking; "silently picking" is how a
	 * reader ends up studying the wrong repo's architecture.
	 */
	readonly candidates: ReadonlyArray<{ readonly repoIdentity: string; readonly repoName: string }>;
}

/**
 * The cheap staleness stamp for a repo's knowledge graph.
 *
 * Exists so the page can poll for "has the graph changed" without pulling the
 * graph. The full payload is the whole distilled artifact — a couple of hundred
 * KB, of which the view reads a fraction — and it only changes when `jolli
 * graph` runs, so re-fetching it on the dashboard's 30-second tick would ship
 * megabytes an hour to answer "no" every time.
 */
export interface GraphVersion {
	/** Build stamp of the graph currently in scope, or null when there is none. */
	readonly generatedAt: string | null;
	/**
	 * How many repos in scope have a graph. Polled alongside `generatedAt`
	 * because it is the OTHER thing that changes what the page shows: going from
	 * one graph to two switches it from a graph to a repo chooser.
	 */
	readonly candidates: number;
}

/**
 * Data honesty flags surfaced in the UI footer. Session-level activity older
 * than the live-log window comes only from stored summaries, so an empty
 * stretch of heatmap can mean "not recorded" rather than "not working" — the
 * page says so instead of letting the reader assume.
 */
export interface CoverageNote {
	readonly kind: "sessions-window" | "no-data";
	readonly message: string;
}

/** Everything one page render needs. Injected inline, then refreshed over HTTP. */
export interface DashboardModel {
	readonly schemaVersion: number;
	readonly view: DashboardView;
	readonly tier: AdoptionTier;
	readonly generatedAtMs: number;
	/** IANA zone every date/hour bucket in this payload was computed in. */
	readonly timeZone: string;
	readonly scope: DashboardScope;
	readonly repos: ReadonlyArray<RepoOption>;
	readonly coverage: ReadonlyArray<CoverageNote>;
	readonly stats?: StatsModel;
	readonly standup?: StandupModel;
	/** Present on the repositories view only. */
	readonly repositories?: RepositoriesModel;
	/** Present on the memories view only. */
	readonly memories?: MemoriesModel;
}

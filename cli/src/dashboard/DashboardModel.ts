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

import type { TranscriptRepairState } from "../core/TranscriptRepair.js";
import type { KnowledgeGraph } from "../graph/GraphSchema.js";
import type {
	LocalAgentToolId,
	RecallOutcome,
	SessionUsageEvent,
	SkillEntryPath,
	ToolCallCount,
	ToolCallKind,
	TranscriptSource,
} from "../Types.js";
import type { JourneyShape } from "./JourneyMetrics.js";

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
	/**
	 * The live host named a completed session but supplied no transcript path.
	 *
	 * Such an event may create or refresh a bare row, but must not advance the
	 * high-water mark of an existing transcript-derived row: doing that would make
	 * the later disk discovery look older and strand the content it came to add.
	 */
	readonly metadataOnly?: true;
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
	 * One entry per counted model response, each carrying its own instant.
	 *
	 * REPLACES the stored set when present, on the same terms as {@link models}:
	 * a re-read attributing usage to fewer responses must not leave the extras
	 * behind. `undefined` means this producer could not see per-response usage
	 * (only the Claude parser can today) and leaves existing rows alone; an
	 * empty array means it saw usage but nothing datable, which REPLACES the
	 * stored set with nothing so a transcript rewrite cannot leave stale rows.
	 *
	 * {@link models} is the same numbers with the time thrown away. Both are
	 * carried because the summary stores the aggregate, but only this one can be
	 * placed on a calendar — see `SESSION_USAGE_EVENTS_DDL`.
	 */
	readonly usageEvents?: ReadonlyArray<SessionUsageEvent>;
	/**
	 * Tool calls observed in the session's transcript. REPLACES the stored set
	 * when present; `undefined` means "this producer could not see tools" and
	 * leaves the rows alone — which is what keeps a live re-upsert from a source
	 * without tool parsing from erasing what a full read collected.
	 */
	readonly tools?: ReadonlyArray<ToolCallCount>;
	/**
	 * Quarter-hour buckets in which this session produced a message. REPLACES
	 * the stored set when present; `undefined` means "this producer could not
	 * see per-message timestamps" and leaves the rows alone — which is what
	 * keeps a re-upsert from a source without timestamps from erasing what a
	 * full read collected.
	 *
	 * Producers must send `undefined`, never `[]`, when nothing was timestamped:
	 * a source whose reader emits no timestamps computes an empty array on every
	 * read, and emitting it would assert "measured, no activity" about a source
	 * that was never measurable.
	 */
	readonly activityBuckets?: ReadonlyArray<number>;
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
	 * The branch this commit was COMMITTED ON, as a one-element list — the same
	 * fact as `branch`, in the shape `commit_branches` stores.
	 *
	 * **Not a reachability set.** It was one (the union of a per-ref `git rev-list`
	 * over the newest branches) and that was the churn bug: the window reshuffled on
	 * every commit while `unchangedCommitEvent` compares this field for exact set
	 * equality, so nothing ever converged. See `collectCommitEvents` and the
	 * `commit_branches` note in `SotSchema` for the measurements and for why the two
	 * tables are kept.
	 *
	 * Still REPLACES the whole stored set, so the absent/empty distinction is
	 * load-bearing in both directions:
	 * - `[]` — the summary index was read and records no branch for this commit;
	 *   PRUNES its rows. The common case (a commit with no memory), and `[]` is
	 *   truthy, which is what makes the projection's `if (event.branches)` run its
	 *   DELETE.
	 * - `undefined` — could not tell, because no summary index was loaded at all;
	 *   LEAVES the stored rows alone. A read failure and a repo that has no index
	 *   yet arrive as the same `null` from `getIndex` and are deliberately treated
	 *   alike — see the collector for why that asymmetry is the safe one.
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

/**
 * Insight kinds mined from a commit's memory (the standup board's buckets).
 *
 * Only `decision` and `todo` are PRODUCIBLE: `TOPIC_INSIGHTS_CTE` in
 * `DashboardQuery.ts` derives insights from each memory topic's own
 * `decisions`/`todo` text and emits those two literals, so nothing can carry the
 * other three. They stay in the union because they are what a summarizer taught
 * to record risks would emit, and because `StandupAsset.test.ts` builds them to
 * assert the UI renders nothing for them — the standup board's Risks column was
 * removed for exactly this reason. Anything reading a `blocker`/`question`/
 * `gotcha` off a live model is reading a value the pipeline cannot produce yet.
 */
export type CommitInsightKind = "decision" | "blocker" | "question" | "todo" | "gotcha";

export interface CommitInsightItem {
	readonly kind: CommitInsightKind;
	readonly text: string;
	/**
	 * Who a question is addressed to (G-8) — absent for self-directed items, and
	 * absent in practice for every row: the CTE selects `NULL AS addressed_to`,
	 * so no live model has ever carried this.
	 */
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
 * Memory-tier enrichment of a commit: what the summary
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
 * The `session.upserted` idempotency key, spelled ONCE.
 *
 * {@link statsEventId} builds it from a whole event, which is all any producer needs.
 * A consumer that holds only the three parts — the session re-scan's emission gate,
 * which asks "have I already emitted for this session?" without an event in hand —
 * goes through here rather than re-spelling the format. Two spellings of one key are
 * two things nothing type-checks, and the day either moves they stop matching in
 * silence: the gate simply never fires again and the duplicate it exists to stop
 * comes back.
 */
export function sessionEventId(repoIdentity: string, source: string, sessionId: string): string {
	return `session:${repoIdentity}:${source}:${sessionId}`;
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
			return sessionEventId(event.repoIdentity, event.source, event.sessionId);
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
 *
 * `repositories` is retired too, and unlike `decisions` it 404s rather than
 * redirecting: it had no content to fold anywhere. Its list is now the topbar
 * repository picker, and its Pause / Resume actions were removed outright
 * (`jolli disable` still pauses a repository — the dashboard just no longer
 * offers a control for it).
 */
export type DashboardView =
	| "stats"
	| "standup"
	| "skills"
	| "mcps"
	| "journeys"
	| "memories"
	| "knowledge"
	| "graph"
	| "settings";

/** One browsable `_wiki` markdown file (a topic page or the `_index.md`). */
export interface KnowledgeFile {
	/** File name under `<kbRoot>/_wiki/` — `_index.md` or `topic--<slug>.md`. Also the `/wiki-viewer?file=` key. */
	readonly file: string;
	/** Display title — manifest `title`, else the file's first H1, else the file name. */
	readonly title: string;
}

/** One Memory Bank repo's `_wiki` contents, for the Knowledge page. */
export interface KnowledgeRepo {
	/**
	 * The Memory Bank folder's directory basename (`DiscoveredRepo.dirName`) — the
	 * stable key the `/wiki-viewer` and `/graph-viewer` routes resolve back to a
	 * `kbRoot` via `discoverRepos`. Deliberately NOT the dashboard registry's
	 * `repoIdentity` (a different identity space); see the Knowledge/Graph docstrings.
	 */
	readonly kb: string;
	readonly repoName: string;
	/**
	 * The scope token a source-commit wiki jump sends as `/memories?detailRepo=`,
	 * chosen like `JD.repoToken`: the readable display name when it is unique (so the
	 * URL reads `?detailRepo=jolliai`, like every other dashboard link), and only the
	 * dashboard `repoIdentity` (derived from the remote URL) when two repos share a
	 * name and the ambiguous name must be disambiguated. Falls back to the name (then
	 * page scope) when no usable identity exists. NOT shown in the UI — `repoName` is
	 * the visible label; this is only the memory-jump scope token. See
	 * `detailRepoToken` in `KnowledgeQuery.ts`.
	 */
	readonly detailRepo: string;
	/** Whether `<kbRoot>/.jolli/graph/graph.json` exists — gates the row's Graph link. */
	readonly graphAvailable: boolean;
	readonly files: ReadonlyArray<KnowledgeFile>;
}

/**
 * The Knowledge page payload — the `_wiki` markdown files of every Memory Bank
 * repo, read straight off disk (NOT the dashboard SQLite). The bodies are not
 * carried here: each is fetched on click through the `/wiki-viewer` iframe, so
 * the model stays a small per-repo file list.
 */
export interface KnowledgeModel {
	readonly repos: ReadonlyArray<KnowledgeRepo>;
}

/** One Memory Bank repo, for the Graph page's repo picker. */
export interface GraphRepo {
	/** Same `DiscoveredRepo.dirName` key as {@link KnowledgeRepo.kb}. */
	readonly kb: string;
	readonly repoName: string;
	/** Whether the repo has a compiled `graph.json` — a repo without one is not selectable. */
	readonly graphAvailable: boolean;
}

/**
 * The Graph page payload — the Memory Bank repos and whether each has a compiled
 * graph. The graph itself is not carried: the page frames `/graph-viewer?kb=…`,
 * which reuses `GraphExport.buildStandaloneHtml` to inline that repo's graph.json.
 */
export interface GraphModel {
	readonly repos: ReadonlyArray<GraphRepo>;
}

// ── Settings page ───────────────────────────────────────────────────────────

/**
 * The Settings provider choice, reshaped from `aiProvider` by
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

/**
 * The mockup-era Settings payload (Summarizer / Hooks / Privacy sections). Kept
 * because `SettingsQuery.buildSettings` / `EnvFacts` / `HookStatus` still build
 * it, but it is NOT what the shipped Settings page reads — that is
 * {@link SettingsPageModel}, which mirrors the VS Code settings panel's five
 * tabs. This one has no route and no consumer today.
 */
export interface SettingsModel {
	readonly summarizer: SettingsSummarizerState;
	readonly hooks: ReadonlyArray<RepoHookStatus>;
	readonly privacy: SettingsPrivacyState;
}

/**
 * The five agent toggles-plus-one that the AI Agents tab controls, each a
 * config boolean (default ON — `xEnabled !== false`). `globalInstructions` is
 * the one tri-state: `"default"` means "never decided" and MUST round-trip as
 * "leave the field unset" on save, never as `"disabled"` (writing `"disabled"`
 * would tell `syncGlobalInstructions` to remove a block that was never written).
 */
export interface SettingsAgents {
	readonly claudeEnabled: boolean;
	readonly codexEnabled: boolean;
	readonly geminiEnabled: boolean;
	readonly openCodeEnabled: boolean;
	readonly cursorEnabled: boolean;
	readonly devinEnabled: boolean;
	readonly copilotEnabled: boolean;
	readonly clineEnabled: boolean;
	readonly antigravityEnabled: boolean;
	readonly kimiEnabled: boolean;
	readonly globalInstructions: "enabled" | "disabled" | "default";
}

/**
 * The AI Summary tab. `apiKeyMasked` / `jolliApiKeyMasked` are the ONLY key
 * material that ever reaches the page — the full key stays server-side and is
 * re-read from config on save (see `SettingsMutations.applySettings`). An empty
 * string means no key on file. `hasJolliKey` is given explicitly so the page
 * need not infer the Jolli card's three states from a mask length.
 */
export interface SettingsSummary {
	readonly aiProvider: "anthropic" | "jolli" | "local-agent";
	readonly model?: string;
	readonly maxTokens?: number;
	readonly apiKeyMasked: string;
	readonly jolliApiKeyMasked: string;
	readonly signedIn: boolean;
	readonly hasJolliKey: boolean;
	readonly jolliSiteLabel?: string;
	readonly localAgentTool: LocalAgentToolId;
	/** Local-agent tools this build knows about, for the picker. */
	readonly localAgentTools: ReadonlyArray<{ readonly id: LocalAgentToolId; readonly label: string }>;
	/**
	 * The RAW stored model id, `""` when nothing is stored — deliberately NOT
	 * resolved server-side. The page resolves it for DISPLAY against
	 * `localAgentModels[tool]` and its `isDefault` marker, and submits it back
	 * untouched unless the user picks something. Sending a resolved value made the
	 * round trip destructive: a stored id the shown tool does not offer came back
	 * as that tool's default and was then written to disk, so merely visiting
	 * another tool in the picker erased a pin the user never edited.
	 */
	readonly localAgentModel: string;
	/**
	 * Model choices per tool id, for the model picker. Keyed by tool rather than
	 * flattened to the currently-selected one because switching the Agent tool is a
	 * client-side state change that does not refetch this payload — a list scoped to
	 * the tool that happened to be stored would leave the picker empty after a
	 * switch. A tool jollimemory does not pin a model for is absent from the map,
	 * which is what hides the row.
	 */
	readonly localAgentModels: Readonly<
		Record<string, ReadonlyArray<{ readonly id: string; readonly label: string; readonly isDefault?: boolean }>>
	>;
}

/** The Memory Bank tab's own fields. `missingSummaries` is fetched lazily (slow). */
export interface SettingsMemoryBank {
	readonly localFolder?: string;
	readonly compileExcludeFolders: string;
	readonly syncTranscripts: boolean;
	/** Hidden in the UI today, but round-tripped so an already-configured value is preserved. */
	readonly autoSyncEnabled?: boolean;
	readonly syncPollIntervalSec?: number;
	/**
	 * Effective folder-layer state for the server's launch repo (see
	 * `SettingsPageQuery`). `off`/`warn` render a line; `ok` renders nothing, as
	 * the VS Code panel does. `undefined` when the launch cwd is not a project.
	 */
	readonly state?: { readonly severity: "ok" | "warn" | "off"; readonly text: string };
	/** Name of the repo the state line / missing-count reflect (the server's launch repo). */
	readonly repoLabel?: string;
}

/**
 * The Sync to Jolli tab's own fields. Sign-in state is NOT here (it comes from
 * `summary.signedIn`, which the AI Summary tab needs too) and neither is the
 * per-repo push list, which loads from its own endpoint.
 */
export interface SettingsSync {
	/**
	 * Session statistics sync — see `JolliMemoryConfig.syncSessions`. Seeds the
	 * switch's initial position only: the page writes this one through
	 * `/api/settings/set-sync-sessions` on change and never submits it with the
	 * batched save, so that every switch on the tab applies immediately (the
	 * per-repo ones beside it always did).
	 */
	readonly syncSessions: boolean;
}

/** The Others tab. */
export interface SettingsOthers {
	readonly dcoSignoff: boolean;
	readonly excludePatterns: string;
}

/**
 * The shipped Settings page payload — one section per VS Code settings tab. The
 * per-repo push list and the (slow) missing-summaries count are NOT here: they
 * load from their own endpoints so the page's first paint is a cheap config read.
 */
export interface SettingsPageModel {
	readonly agents: SettingsAgents;
	readonly summary: SettingsSummary;
	readonly sync: SettingsSync;
	readonly memoryBank: SettingsMemoryBank;
	readonly others: SettingsOthers;
}

// ── Memories page ───────────────────────────────────────────────────────────

/**
 * Rows per Memories list page — the size of the inlined first page, and of
 * every `/api/memories` page the browser pulls after it.
 *
 * A page budget, not a cap: the whole model is inlined into a `<script>` block,
 * so the full set cannot ride the HTML (an all-repos scope is the sum of every
 * enabled repo's entire history), but the tree's search box filters the loaded
 * array client-side, so dropping the tail outright would turn "search my
 * memories" into "search my recent memories". Paging satisfies both — and the
 * later pages are fetched on a "Load more" click, never prefetched, so a reader
 * who never asks pays for exactly one page.
 */
export const MEMORIES_PAGE_SIZE = 250;

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

/**
 * One conversation that fed a memory — {@link MemoryDetail.conversations}.
 *
 * Exactly the four fields the page renders, and no server-side ones. The whole
 * model is `JSON.stringify`d into the served HTML, so a field here is a field in
 * the payload; the rule is that nothing lands in this type which the client does
 * not use. `transcriptPath` and a `nativeTitle` flag were briefly on it to drive
 * a server-side `ai-title` read, defended by a strip on the way out — a
 * convention the type system could not enforce, shipping an absolute path under
 * the user's home for nothing. The title is now resolved once at archive time
 * (`StoredSession.title`), so there is no private data to carry and nothing to
 * strip.
 */
export interface MemoryConversationRow {
	readonly title: string;
	readonly source: string;
	readonly messageCount: number;
	/**
	 * Rendered as the row's tooltip (`conversationsSection` in `memories.js`) —
	 * which is the only reason it is allowed here, by the rule above. It earns
	 * that: the other three fields do not distinguish two conversations from the
	 * same source, and a title that fell back to the first user message can make
	 * two rows near-identical, so a memory fed by three Claude sessions was
	 * unreadable and could not be matched against `sessions.json` or a log line.
	 *
	 * Safe to serve for the reason `transcriptPath` was not: it is an opaque id
	 * the agent chose, not a fact about this machine's filesystem. It is also the
	 * editor's own row identity — `SummaryScriptBuilder` keys its conversation
	 * rows on `(source, sessionId)` — so the two surfaces name a row the same way.
	 */
	readonly sessionId: string;
}

/**
 * The four kinds of context a memory carries, in the order the editor's Context
 * panel renders them (`buildPlansAndNotesSection` in
 * `vscode/src/views/SummaryHtmlBuilder.ts`). `skills` is plural because it is the
 * ONE aggregate row standing for every skill entered this session — the same
 * choice every other Context surface makes, so a session that entered a dozen
 * skills does not bury its plans.
 */
export type MemoryContextKind = "plan" | "note" | "reference" | "skills";

/** {@link MemoryContextKind} as a value, for `/api/context`'s param check. Render order. */
export const CONTEXT_DOC_KINDS: ReadonlyArray<MemoryContextKind> = ["plan", "note", "reference", "skills"];

/**
 * One context item associated with a memory — a plan, a note, an archived
 * external reference, or the skills aggregate.
 *
 * Kept as ONE list rather than a list per kind so the page cannot render them in
 * a different order than the editor does. The list is already ordered.
 */
export interface MemoryContextRow {
	readonly kind: MemoryContextKind;
	/**
	 * Display title, resolved server-side by the same rules the editor uses —
	 * `referenceDisplayTitle` for a reference (so a tracker row leads with its
	 * issue key), the archived title otherwise.
	 */
	readonly title: string;
	/**
	 * `context.context_key` — what `/api/context` needs to fetch the body: the
	 * plan's slug, the note's id, `<source>/<sanitized-key>` for a reference, and
	 * the commit hash for the skills row (whose table is rendered from the
	 * summary, not stored as a document).
	 *
	 * Carried on the row rather than re-derived in the client because none of the
	 * four is recoverable from the title. Absent when the key cannot be derived —
	 * a reference whose source has since left the registry — which renders the row
	 * as a plain, unopenable label rather than a button that always 404s.
	 */
	readonly contextKey?: string;
	/** Secondary line under the title: `<nativeId> (Linear)`, `<slug>.md`, the skills totals. */
	readonly meta?: string;
	/** Upstream URL, for a reference whose source has a navigable page. */
	readonly url?: string;
	/**
	 * The reference's source id (`linear`, `jira`, `sentry`, …) — present ONLY on
	 * `kind: "reference"` rows, where it selects the badge's letter and brand
	 * colour from `SOURCE_META`.
	 *
	 * It earns its place by the rule above (nothing lands here the client does not
	 * use): without it every reference rendered as one identical amber `R`,
	 * because the row's kind is all the client had to key on, while the editor
	 * showed a distinct badge per source for the same memory. Not recoverable
	 * from the other fields — `contextKey` carries the source as a prefix but is
	 * absent exactly when a source has left the registry, and `meta` names the
	 * source only for the three trackers `labelLeadsWithNativeId` covers.
	 */
	readonly source?: string;
}

/**
 * One context body, served by `/api/context` for the Context viewer.
 *
 * No `url`: the row the reader clicked already carries it, so repeating it here
 * would be a second place for the same fact.
 */
export interface ContextDoc {
	readonly kind: MemoryContextKind;
	readonly title: string;
	readonly bodyMd: string;
}

/** One turn of an archived conversation, as served by `/api/conversation`. */
export interface ConversationEntry {
	readonly role: "human" | "assistant";
	readonly content: string;
	/** ISO timestamp when the transcript recorded one; absent for sources that do not. */
	readonly timestamp?: string;
}

/**
 * One archived conversation's turns, served by `/api/conversation` for the
 * Conversations viewer — the browser counterpart of the editor's read-only
 * `ConversationDetailsPanel`.
 *
 * Read-only, like that panel is when opened from a memory: an archived slice has
 * no live cursor to edit against, so there is no overlay to write back to and
 * nothing here carries an index or an identity for one.
 */
export interface ConversationDoc {
	readonly title: string;
	readonly source: string;
	readonly sessionId: string;
	/** Turns in the archive, BEFORE any cap — so the viewer can say what it is not showing. */
	readonly messageCount: number;
	readonly entries: ReadonlyArray<ConversationEntry>;
	/**
	 * True when the cap dropped turns, or clipped a turn's content.
	 *
	 * A deliberate divergence from the editor, which reads the same archive
	 * in-process and shows all of it: this crosses HTTP, and one agent session can
	 * carry thousands of turns of unbounded text. Surfacing the fact is the point
	 * — a viewer that silently showed a prefix would read as the whole
	 * conversation.
	 *
	 * The viewer's GATE, not its wording: this says something was withheld, and
	 * {@link ConversationDoc.clippedEntries} plus the entries/count gap say which.
	 */
	readonly truncated: boolean;
	/**
	 * How many of the SERVED turns had their body cut at
	 * `CONVERSATION_CONTENT_LIMIT`.
	 *
	 * The two ways this endpoint withholds text are independent, and a viewer that
	 * only knew `truncated` had to guess: it phrased everything as dropped turns,
	 * so a 12-turn conversation carrying one enormous turn was announced as
	 * "showing the first 12 of 12 turns" — a sentence whose own numbers say
	 * nothing is missing — while the cut characters went unmentioned. Dropped
	 * turns need no field (`messageCount` minus `entries.length` is the count);
	 * clipping leaves no trace in either number, so it needs this one.
	 */
	readonly clippedEntries: number;
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
	/**
	 * Always present here, unlike {@link MemoryListItem.memoryRefId}: an unsynced
	 * memory falls back to `JM-<hash8>`, matching the editor's page title, which
	 * labels every memory whether or not it has reached a Space.
	 */
	readonly memoryRefId: string;
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
		/**
		 * The headline figure: `aggregateConversationTokens` over the tree, the
		 * same number the editor's meter prints. Deliberately NOT the sum of the
		 * three segments below — a folded session that reports only a scalar count
		 * with no breakdown lands in this total and in no segment, which is also
		 * why the bar's widths use the segments' own sum as their denominator.
		 */
		readonly total: number;
		readonly input: number;
		readonly output: number;
		readonly cached: number;
		/** Whole-tree estimate from `estimateSummaryCostUsd` — see {@link MemoryDetail} usage. */
		readonly costUsd?: number;
		readonly pricesAsOf?: string;
	};
	/** Jolli's own summarization call — the model that WROTE this memory, distinct from {@link tokens}. */
	readonly summarizedBy?: { readonly model: string; readonly tokens: number };
	/**
	 * Who generated this memory, as `formatProviderLabel` renders it ("Anthropic",
	 * "Local agent - Cursor", `mixed: …`). The footer's `· via <provider>` segment,
	 * matching the editor panel's and the Markdown export's.
	 *
	 * Separate from {@link summarizedBy} rather than a third field on it, because
	 * the two are read off different populations: `summarizedBy` is the ROOT's own
	 * `llm` node, while this walks the whole tree — a squash whose root carries no
	 * `llm` but whose folded children do has a provider and no `summarizedBy`.
	 * Absent for summaries written before `llm.source` existed; the footer then
	 * omits the segment rather than printing "via unknown".
	 */
	readonly provider?: string;
	/**
	 * When Jolli wrote THIS memory (`summary.generatedAt`), which is what the
	 * footer stamps. Not {@link DashboardModel.generatedAtMs} beside it — that one
	 * is when the PAGE's payload was built, so a footer reading it would print the
	 * current time under every memory ever recorded and change on each refresh
	 * tick with nothing under it changing.
	 *
	 * Falls back to the commit date for a summary whose `generatedAt` is absent or
	 * unparseable — it is persisted as an empty string on some paths (see
	 * `getDisplayDate` in core/SummaryFormat.ts). The substitute is this query's
	 * COALESCEd COMMITTER date, the same value {@link committedAtMs} carries — NOT
	 * the AUTHOR date `getDisplayDate` picks off `summary.commitDate` (`%aI`, which
	 * is also what `memories.commit_date_ms` stores raw). A rebased memory must not
	 * stamp one instant here and another in the tree row beside it, which is what
	 * the COALESCE in `buildMemoryDetail`'s query exists for.
	 */
	readonly generatedAtMs: number;
	readonly recap?: string;
	/**
	 * The conversations this memory was built from. Also what the footer's privacy
	 * note counts: it briefly carried a separate transcript-FILE count instead,
	 * which is a unit this page never shows — one memory storing six sessions in
	 * two files rendered "Conversations · 6" directly above "(2)". A field a
	 * client cannot reconcile with what it already prints does not belong on this
	 * type, so there is no second count here to pick the wrong one from.
	 */
	readonly conversations: ReadonlyArray<MemoryConversationRow>;
	/**
	 * Which of the three sentences spec §9 allows an EMPTY {@link conversations}
	 * list to print — `transcriptRepairState` in
	 * `cli/src/core/TranscriptRepair.ts`, the same predicate VS Code calls
	 * in-process and IntelliJ reaches over the `transcript-repair-state` bridge
	 * action, so one memory is never worded three different ways.
	 *
	 * OPTIONAL because it costs a filesystem read (the machine-global Claude
	 * owners ledger, plus a stat per transcript it names) that only the DETAIL
	 * view pays for, and because a page rendered before this shipped carries no
	 * such field. `memories.js` treats an absent or unrecognised value as
	 * `unrepairable`, the plainest wording — never as the optimistic one.
	 *
	 * It does NOT decide whether the empty block renders; `conversations` being
	 * empty still does. `present` is not proof of renderable conversations: a
	 * pre-v5 summary reads as `present` unconditionally.
	 */
	readonly transcriptRepairState?: TranscriptRepairState;
	/** Plans, notes, references and the skills row — one ordered list, see {@link MemoryContextRow}. */
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
	/**
	 * Newest first, across every repo in scope — the first {@link MEMORIES_PAGE_SIZE}
	 * rows. `items.length < totalCount` is the client's "another page exists" test:
	 * it is what puts the tree's "Load more" button on screen, and each click pulls
	 * one more page from `/api/memories`.
	 */
	readonly items: ReadonlyArray<MemoryListItem>;
	readonly totalCount: number;
	readonly vitals: { readonly memories: number; readonly topics: number; readonly repos: number };
	/** Present only when the request named a `?hash=` this scope can resolve. */
	readonly selected?: MemoryDetail;
}

/**
 * Repo scope of a model: a named set of repos, or every enabled one.
 *
 * ONE field carries the selection, even though the set is usually a single repo.
 * A `repoIdentity` alongside a `repoIdentities` would be two spellings of one
 * fact, and the reader of a scope has no way to know which one a given producer
 * filled in — the sort of drift a `?repo=` link would carry silently.
 *
 * A `repo` kind with an EMPTY list reads as every repo, matching a `?repo=` the
 * browser omitted entirely; it is not a way to select nothing.
 */
export type DashboardScope =
	| { readonly kind: "all"; readonly repoIdentities?: undefined }
	| { readonly kind: "repo"; readonly repoIdentities: readonly string[] };

export interface RepoOption {
	readonly repoIdentity: string;
	readonly repoName: string;
	readonly worktreeRoot: string;
	/** Sessions in the last 7 local days — the repo picker's per-repo meta figure. */
	readonly sessionsThisWeek: number;
	/**
	 * Present and `true` only for a PAUSED repo (`repos.disabled_at` set). The list
	 * carries paused repos rather than dropping them: pausing is an UPDATE that
	 * stamps `disabled_at`, never a delete, and they keep counting in the
	 * aggregate figures, so hiding them made an
	 * all-paused dashboard read as "No repositories yet". Absent on an active repo,
	 * so an active row's shape is unchanged.
	 */
	readonly disabled?: boolean;
	/**
	 * Present and `true` when `worktreeRoot` no longer exists on disk.
	 *
	 * MARKED, never filtered — the same decision as `disabled`, for a different
	 * reason. A repo the user deleted keeps its memories, and those are worth
	 * reaching; what must not happen is the row presenting itself as a working
	 * checkout, since every action on it (resume, scope, open) names a directory
	 * that is not there. It is also what gates the row's remove control: the page
	 * offers to forget an entry only once it can say the entry is dead.
	 */
	readonly missing?: boolean;
	/**
	 * Present and `true` when nothing could be found because the VOLUME is absent —
	 * an unplugged drive or an unmounted share — rather than because a folder was
	 * deleted. Implies {@link missing}; never set on its own.
	 *
	 * Two states, not one, because `existsSync` cannot tell them apart and the row
	 * used to assert the wrong one: it said "folder missing" and offered a ✕ over a
	 * repository that was merely unplugged. Splitting them is what lets the page say
	 * something true and ask for a stronger confirmation, instead of either lying or
	 * withholding the control from a user who knows their own drive.
	 *
	 * The volume walk this needs (`volumeReachable`, one `existsSync` per ancestor)
	 * runs ONLY for a row already found missing — the case that is rare by
	 * construction — so the render path still asks the filesystem nothing extra
	 * about a working repo.
	 */
	readonly volumeUnavailable?: boolean;
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

/** One quarter-hour and how many distinct agent sessions were active in it. */
export interface ConcurrencyBucket {
	readonly bucketMs: number;
	readonly sessions: number;
}

/**
 * How many agents ran at the same time — machine-global and self-only.
 *
 * Deliberately NOT filtered by the page's repo scope: concurrency means "how
 * many things was this person doing at once", which is a property of the person
 * and not of a repository. A per-repo figure truncates the number into
 * something with no actionable meaning.
 */
export interface ConcurrencyModel {
	/** Only buckets with at least one session; ascending. */
	readonly buckets: ReadonlyArray<ConcurrencyBucket>;
	/** Bucket width, carried on the wire so a renderer never hardcodes it. */
	readonly bucketMinutes: number;
	/**
	 * Highest session count in any one bucket — an UPPER BOUND on instantaneous
	 * concurrency, not the thing itself: two sessions active in the same quarter
	 * hour need not overlap at any instant. Any label must say "agents active
	 * within the same 15 minutes", never "running simultaneously".
	 */
	readonly peak: number;
	/**
	 * Mean session count over ACTIVE buckets. The denominator is deliberately
	 * the buckets with activity, not the buckets in the window: a 7-day window
	 * holds 672 buckets and dividing by all of them yields ~0.2, a figure with
	 * no meaning. Any label must state the denominator.
	 */
	readonly meanActive: number;
	/** Sources that contributed at least one bucket in the window. */
	readonly measuredSources: ReadonlyArray<string>;
	/**
	 * Sources whose in-window sessions produced NO activity bucket at all —
	 * uncovered, not idle.
	 *
	 * Deliberately not the complement of {@link measuredSources}: that one is
	 * scoped to buckets inside the window and answers "did this source draw a
	 * bar", which a session admitted by `updatedAt` while all its turns predate
	 * the window fails despite being perfectly measurable. This asks whether the
	 * source's own sessions ever produced a bucket at all. The two lists can
	 * therefore overlap, and the overlap is honest.
	 */
	readonly uncoveredSources: ReadonlyArray<string>;
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
	/**
	 * How many decisions this commit recorded — one per topic that recorded any,
	 * the same rule behind {@link StatsModel.decisionsCaptured} and
	 * {@link DecisionsCard.keptCount}. Those two are rendered as "N decisions" in
	 * the same card as these rows, so a per-BULLET count here would put two
	 * numbers that disagree side by side.
	 *
	 * Absent rather than `0` when the commit recorded none, like every other
	 * optional figure on this card.
	 */
	readonly decisionCount?: number;
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
 * Token volume by type, over the range — the "Tokens" card.
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

/**
 * One decision mined from a commit memory — the Decisions card's "Latest" line.
 *
 * Carries the owning topic's TITLE, not the decision prose. The card renders
 * that one line and nothing else, so the block itself (1 sentence to a
 * multi-bullet paragraph, measured at ~1,900 characters on a real memory) is
 * deliberately not on the wire — it had no reader and one display-time LLM call
 * per render existed only to compress it (retired with JOLLI-2209).
 */
export interface DecisionRecord {
	/**
	 * The owning topic's title. `""` when the payload carries neither a title nor
	 * a decision line short enough to stand in for one; the card then renders no
	 * quote at all, which is the point — this line is one line wide.
	 */
	readonly title: string;
	/**
	 * The MEMORY's commit hash — what `/memories?hash=` resolves against, since
	 * that route reads `memories.commit_hash`.
	 *
	 * Deliberately not the live `commits.hash`: a commit rewritten after it was
	 * summarized keeps its memory under the pre-rewrite hash, so for exactly
	 * those rows the two disagree and the live hash addresses nothing.
	 */
	readonly commitHash: string;
	readonly repoName: string;
	/**
	 * Stable repo token, so the card's title can address this memory's row —
	 * {@link repoName} is a display label two registered repos can share, and
	 * their commit hashes overlap by construction (a fork, a vendored tree).
	 */
	readonly repoIdentity: string;
	readonly committedAtMs: number;
}

/**
 * Memory-tier "Decisions" card — a standalone widget distinct from the KPI
 * sub-line and from the per-commit `MemoryCard.decision` line in the feed.
 *
 * Deliberately carries no "recalled" figure. `recall_receipts` does record one
 * call per recall — that part is written and still is — but nothing ties a
 * receipt back to the DECISION it served, so "this decision came back" would be
 * inferred, not measured. The card's subtitle used to promise it and was
 * corrected with JOLLI-2193; {@link MemoryCard}'s `reuse` field is the same
 * unmeasured claim and is likewise never emitted.
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
	readonly series: ReadonlyArray<DaySeriesPoint>;
	/** Series keys present in `series[].bySeries`, in render order. */
	readonly seriesKeys: ReadonlyArray<string>;
	/** The dimension `series`/`seriesKeys` were built along. */
	readonly seriesDimension: SeriesDimension;
	readonly heatmap: ReadonlyArray<HeatmapCell>;
	readonly hours: ReadonlyArray<HourBucket>;
	/** Token volume by type, over the range — available at every tier. */
	readonly tokenBreakdown: TokenBreakdown;
	/**
	 * Est. cost vs the immediately preceding window of equal length — the Spend
	 * card's own self-trend.
	 *
	 * Both ends are summed over {@link series}, along the SAME dimension, by the
	 * same rule the card's headline uses — so the arrow trends the number it is
	 * printed beside. Absent when the previous window drew no cost to compare
	 * against.
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
	 * {@link memoryCards} hit {@link MEMORY_CARDS_LIMIT} — i.e. the window holds
	 * more memories than the feed is showing.
	 *
	 * The card's subtitle is the whole reason this travels: `memoryCards.length`
	 * alone cannot tell "20 memories in this window" from "the 20 most recent of
	 * 300", and the page has no other way to know the cap. Absent (not `false`)
	 * when the feed is complete, matching the other optional fields here.
	 */
	readonly memoryCardsCapped?: boolean;
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
	/** Absent when no bucket falls in the window — a consumer shows "no data",
	 *  never a zero. Under forward-only collection this is the normal state for
	 *  the first days after deployment. */
	readonly concurrency?: ConcurrencyModel;
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

/** One day column on the Standup board — a local day and the commits that landed on it. */
export interface StandupDay {
	/** Local `YYYY-MM-DD`. */
	readonly day: string;
	/** Commits completed on {@link day}, oldest-first within the day. Empty for a quiet day. */
	readonly commits: ReadonlyArray<StandupCommit>;
}

/**
 * The Standup page payload — a seven-day window of commit activity.
 *
 * The board is a rolling 7-day window ending on an anchor day, paged a whole
 * week at a time (the `offset` request param: 0 = window ending today). The
 * columns are COMMITS ONLY (JOLLI-2200 / 2201): a column states what was
 * COMPLETED that day, matching the rows the stats page's Memory Activity card
 * lists for the same day, and a session or an uncommitted worktree is work in
 * flight rather than a completed row.
 */
export interface StandupModel {
	/** The real local `YYYY-MM-DD` today, for the "Today"/"Yesterday" column titles. */
	readonly today: string;
	readonly yesterday: string;
	/** Oldest and newest local `YYYY-MM-DD` of the shown window (newest = the anchor). */
	readonly windowFrom: string;
	readonly windowTo: string;
	/**
	 * The resolved whole-week paging offset this window is at (0 = ending today).
	 * Echoed so the client can preserve it across a repo-scope change or a poll
	 * without re-reading the URL — see `JD.query` in `shell.js`.
	 */
	readonly offset: number;
	/**
	 * The seven day columns, NEWEST FIRST — the anchor day leftmost, going back a
	 * week. Every day in the window is present, including quiet ones (empty
	 * `commits`), so the grid has a stable seven columns.
	 */
	readonly days: ReadonlyArray<StandupDay>;
	/**
	 * A newer window exists to page forward to (i.e. the anchor is before today).
	 * Drives the `‹` arrow, which moves toward more recent days — see the standup
	 * pager in `shell.js`. False on the current window: there is no future to show.
	 */
	readonly hasNewer: boolean;
	/**
	 * An author-filtered commit exists strictly before this window, so paging back
	 * lands on data rather than empty weeks. Drives the `›` arrow (older days).
	 */
	readonly hasOlder: boolean;
	/**
	 * Uncommitted work across the registered repos. NOT RENDERED in a day column —
	 * it is work in flight, not a completed row — but carried for a future
	 * in-progress surface and because it is window-independent (current state).
	 */
	readonly workspaces: ReadonlyArray<StandupWorkspace>;
	/**
	 * The git identity the commit columns were filtered to (an email, or a name
	 * when only that is configured). ABSENT means the filter did not
	 * run and the board is showing every author's work — the page states which
	 * of the two it is, because an unfiltered standup is a draft the user would
	 * otherwise post as their own. See `authorFilter` in `DashboardQuery.ts`.
	 */
	readonly authoredBy?: string;
	/**
	 * The memory-tier flag, carried by PRESENCE alone: an EMPTY array from the
	 * memory tier onwards, absent below it. `renderStandup` reads only
	 * `!!standup.insights` — how many fields a commit row may show — never the
	 * contents.
	 *
	 * It is typed as an insight array, and stays so, for one reason: the standup
	 * board once rendered a Risks/Blockers/Questions column from it. That column was
	 * removed (JOLLI-2200/2201 — nothing produces those kinds, see
	 * {@link CommitInsightKind}), and with it the server stopped populating this: the
	 * per-window query re-sent ~40 KB the client discarded on every 30 s poll. The
	 * shape is kept so a real insight column can return here without a wire change.
	 */
	readonly insights?: ReadonlyArray<StandupInsight>;
}

/**
 * One agent's share of a single skill / tool / server row — which of Claude
 * Code, Codex, … actually made those calls.
 *
 * CALLS ONLY, deliberately. A session belongs to exactly one source, so calls
 * and session counts both partition cleanly by agent at the grouping they were
 * counted at — but a session count does not survive being RE-SUMMED at a
 * coarser level, and this shape appears at three of them. A session that called
 * two of a server's tools is one session for the server and two rows in the
 * per-tool grouping, which is the same trap {@link ToolUsage.servers}' own
 * query exists to avoid (see `buildToolUsage`). Carrying a number that is exact
 * on the skill rows and a double count on the server rows would be worse than
 * carrying none. The per-kind totals in {@link ToolUsage.skillAgents} /
 * {@link ToolUsage.mcpAgents} do carry sessions, because they come from their
 * own `COUNT(DISTINCT …)` grouping rather than from a re-sum.
 */
export interface ToolUsageAgentShare {
	/** `sessions.source` — the raw `claude` / `codex` tag every other axis shows. */
	readonly source: string;
	readonly calls: number;
}

/** One agent's whole-window footprint for a tool kind, counted by its own grouping. */
export interface ToolUsageAgentTotal extends ToolUsageAgentShare {
	/** Distinct sessions of this agent with at least one call of that kind. */
	readonly sessions: number;
}

/**
 * One skill's token spend over the window, summed across the sessions that could
 * be attributed.
 *
 * `sessions` is the load-bearing field and the reason this is not just a
 * {@link SkillUsage}: the sum covers only the rows that carry figures, which on a
 * real machine is a MINORITY (measured: 12 of 112 skill calls came from a source
 * that attributes anything). Without it a reader cannot tell a skill that genuinely
 * cost this much from one where nine sessions in ten went unmeasured — and the
 * second reading is the common one. Compare it against {@link ToolUsageRow.sessions}
 * to state the coverage.
 *
 * Absent on the row entirely when NO session could be attributed, never a zeroed
 * object: the same rule the markdown table states by printing an em dash.
 */
export interface ToolUsageTokens {
	readonly input: number;
	readonly output: number;
	readonly cached: number;
	/**
	 * `estimated` when ANY contributing session was, matching
	 * `buildSkillsSummaryLabel`: a sum containing one estimate is an estimate, so
	 * the whole figure carries the weaker claim rather than averaging the two.
	 */
	readonly confidence: "attributed" | "estimated";
	/** Sessions whose figures are in the sum, out of {@link ToolUsageRow.sessions}. */
	readonly sessions: number;
}

/**
 * One local calendar day of skill adoption — the shape `JD.stackedBars` consumes.
 *
 * Buckets are LOCAL days, through this file's one time-zone engine, and the whole
 * window is emitted whether or not a day has rows — the same treatment the token
 * and spend series get.
 *
 * This replaced epoch-week buckets (`at / 604800000`), whose divisor was chosen to
 * keep the series identical for two readers in different zones. That symmetry cost
 * more than it bought. The boundary landed on Thursday, so a bar labelled `Aug 6`
 * covered Aug 6-12 while the heatmap cell labelled `Aug 6` on the same page covered
 * one local day — two meanings of "day" in one product, and the axis prints a bare
 * day key either way. It also made the bar WIDTH mislead: `JD.stackedBars` divides
 * the plot by the number of points, so a fortnight of data drew two bars each 29% of
 * the chart wide, which reads as a range rather than as a bucket.
 *
 * The cost of the switch is stated on {@link ToolUsage.skillDays}: a bucket is
 * resolved from ONE timestamp per (session, skill), so a session that ran past local
 * midnight lands wholly in the later day.
 */
export interface SkillDayPoint {
	/** The local calendar day, `YYYY-MM-DD`. */
	readonly date: string;
	/** Skill name → sessions that reached for it inside the day. Absent keys are zero. */
	readonly bySeries: Readonly<Record<string, number>>;
}

/** One tool, skill or MCP server, aggregated over the window. */
export interface ToolUsageRow {
	/** `Bash`, `linear.list_issues`, `code-review`. */
	readonly name: string;
	readonly kind: ToolCallKind;
	/** Sessions that called it — the adoption figure, not the volume figure. */
	readonly sessions: number;
	readonly calls: number;
	/** Which agents made those calls, most calls first — see {@link ToolUsageAgentShare}. */
	readonly agents: ReadonlyArray<ToolUsageAgentShare>;
	/**
	 * Tokens spent under it. Only ever present on `kind: "skill"` rows, and only
	 * when at least one session could be attributed — see {@link ToolUsageTokens}.
	 */
	readonly usage?: ToolUsageTokens;
	/**
	 * Providing plugin, on `kind: "skill"` rows alone.
	 *
	 * Absent for an unprefixed skill, which is the common case — never "unknown".
	 * Carried on the list row and not only on {@link SkillDetail} so a reader can
	 * see which entries came from a plugin without opening each one.
	 */
	readonly plugin?: string;
	/**
	 * `"heuristic"` when ANY entry behind this row was INFERRED from a file read
	 * rather than observed; absent otherwise. `kind: "skill"` rows alone.
	 *
	 * Any-one-taints, the same rule {@link ToolUsageTokens.confidence} takes for
	 * `estimated` and `SkillStore.mergeSkillRef` takes across scan windows — a row
	 * that mixes an observed entry with an inferred one cannot be presented as
	 * measured. The three had better agree: the same skill is rendered from this
	 * field here, from `SkillCommitRef.detection` on a committed memory, and from
	 * `SkillEntry.detection` in the Memory Bank markdown.
	 *
	 * ABSENT IS NOT A CLAIM THAT THE ENTRIES WERE OBSERVED. A row's `calls` can
	 * outlive every entry row behind it — a count merged in from an archived commit,
	 * or a transcript the agent pruned (see {@link SkillDetail.invocations}) — and
	 * such a row has nothing left to read a detection off. Absent therefore means
	 * "no entry on record says inferred", which covers both the genuinely observed
	 * row and the unreadable one. Spelling that third state out here was considered
	 * and dropped: the detail view already says "no per-entry record survives" where
	 * it applies, and a list row has no room to say it a second way.
	 */
	readonly detection?: "heuristic";
}

/** One MCP server, rolled up across all of its tools. */
export interface McpServerRow {
	readonly server: string;
	/** Distinct sessions that called ANY of its tools — exact, not a bound. */
	readonly sessions: number;
	readonly calls: number;
	/** Distinct tools of that server actually called. */
	readonly tools: number;
	/** Which agents called it, most calls first — see {@link ToolUsageAgentShare}. */
	readonly agents: ReadonlyArray<ToolUsageAgentShare>;
}

/** One agent's share of a single skill, for the detail view's per-agent table. */
export interface SkillDetailAgent {
	/** `sessions.source` — the raw `claude` / `codex` tag every other axis shows. */
	readonly source: string;
	readonly sessions: number;
	readonly calls: number;
	/** Absent for an agent that attributes nothing — see {@link ToolUsageTokens}. */
	readonly usage?: ToolUsageTokens;
}

/**
 * One commit a skill's work reached, with what that commit changed.
 *
 * This is the half no other tool can show: not "the skill ran N times" but "this
 * is what came out of it". The diff figures and categories are the COMMIT's, not
 * the skill's — a commit usually carries other work too — so a caller must not
 * present them as the skill's own output.
 */
export interface SkillDetailCommit {
	readonly hash: string;
	readonly repoName: string;
	readonly branch?: string;
	readonly message?: string;
	readonly committedAtMs: number;
	readonly filesChanged?: number;
	readonly insertions?: number;
	readonly deletions?: number;
	/** Topic categories of that memory, deduped — `bugfix`, `feature`, … */
	readonly categories: ReadonlyArray<string>;
}

/** One session that ran the skill, plus how much of it was this skill's. */
export interface SkillDetailSession {
	readonly sessionId: string;
	readonly source: string;
	readonly title?: string;
	readonly startedAtMs?: number;
	readonly updatedAtMs: number;
	readonly durationMs?: number;
	readonly messageCount?: number;
	readonly model?: string;
	/** Calls of THIS skill in this session. */
	readonly calls: number;
	/**
	 * The WHOLE session's spend, which is not this skill's — a session normally
	 * runs several skills and plenty of unattributed work besides. Carried as the
	 * denominator a reader needs to judge {@link usage} against, and a surface
	 * showing it must say which of the two it is printing.
	 *
	 * Absent when the source reports no session usage either (today: every agent
	 * except Claude, whose parser is the only one implementing `parseUsageTokens`).
	 */
	readonly sessionTokens?: number;
	/** This skill's own spend inside this session. Absent when unattributable. */
	readonly usage?: ToolUsageTokens;
}

/**
 * Run outcomes over this skill's recorded entries, SPLIT by whether the result was
 * actually read.
 *
 * Three of the six entry mechanisms have no result record at all, so their `ok` was
 * defaulted rather than observed (see `skillOutcomeConfidence`): nothing said the run
 * failed, which is not the same as something saying it succeeded. The two classes are
 * therefore counted separately and must stay separate:
 *
 *   - {@link measured} / {@link failed} — entries whose `ok` came from a result
 *     record. `measured` is the only honest denominator for a failure rate; averaging
 *     over every entry would price an unknowable run as a success.
 *   - {@link assumed} — entries that definitely RAN but whose result the transcript
 *     never stated. Reported as its own number, in words that say what is missing.
 *
 * Either count may be 0 on its own. The object is absent only when the skill has no
 * entry row at all — a count merged in from an archived commit, or a transcript the
 * agent has since pruned — which is the same distinction {@link SkillDetail.invocations}
 * draws, and it is the surface's cue to say "no per-entry record", never "it never ran".
 *
 * It used to be absent whenever `measured` was 0, so on the common machine — where
 * nearly every Claude skill is entered by slash command — the whole section vanished
 * and the reader was told nothing about runs that were fully on record. Surfacing
 * them as "ran, outcome not recorded" says exactly as much as the record supports,
 * and no more.
 */
export interface SkillDetailOutcomes {
	/** Entries whose `ok` came from a result record. 0 when no mechanism could report one. */
	readonly measured: number;
	/** Failures among {@link measured} alone — never among {@link assumed}. */
	readonly failed: number;
	/**
	 * Entries whose `ok` was defaulted, so the run is known to have happened and its
	 * result is not knowable. Never added to {@link measured}.
	 */
	readonly assumed: number;
}

/**
 * One recorded entry into the skill, for the outcome strip and its tooltips.
 *
 * Ordered oldest-first by the query, which is what makes "it started failing on
 * Tuesday" readable left to right.
 */
export interface SkillDetailInvocation {
	readonly atMs: number;
	readonly ok: boolean;
	/**
	 * Whether {@link ok} was read from the transcript or defaulted.
	 *
	 * Carried so a surface can decide what it is entitled to SAY: a defaulted outcome
	 * has no failure to report, so the dashboard draws it as an ordinary tick (the run
	 * happened, and skipping it reported less than the record holds) and qualifies it
	 * in words — per-tick hover text, plus the {@link SkillDetailOutcomes.assumed}
	 * sentence under the strip. What the flag must keep preventing is the other
	 * reading: {@link ok} being `true` here is the absence of a failure report, so such
	 * an entry may be counted beside a measured one but never averaged in with it.
	 */
	readonly outcomeKnown: boolean;
	readonly args?: string;
	readonly bodyChars?: number;
}

/**
 * Everything the skill detail view shows — the answer to `/api/skill-detail`.
 *
 * Scoped to the same window and repo selection as the card it was opened from, so
 * the totals here agree with the row that was clicked. That is also why it is a
 * fetch rather than a slice of the page model: the model carries ONE PAGE of
 * skills and none of this per-skill breakdown.
 */
export interface SkillDetail {
	readonly name: string;
	/** Distinct sessions that ran it, over the window. */
	readonly sessions: number;
	readonly calls: number;
	readonly lastCallAtMs?: number;
	/** Summed over every attributable session — see {@link ToolUsageTokens.sessions}. */
	readonly usage?: ToolUsageTokens;
	readonly agents: ReadonlyArray<SkillDetailAgent>;
	/**
	 * Commits this skill's usage was archived onto, newest first.
	 *
	 * Routinely EMPTY, and that is the normal state rather than a failure: measured
	 * on one machine, 27 of 111 skill rows linked to a commit at all — the rest is
	 * work still in the tree. A surface must render the empty case as "not committed
	 * yet", never as "no data".
	 */
	readonly commits: ReadonlyArray<SkillDetailCommit>;
	readonly linkedSessions: ReadonlyArray<SkillDetailSession>;
	/** Category mix across {@link commits}, most commits first. */
	readonly categories: ReadonlyArray<{ readonly category: string; readonly commits: number }>;
	/** Providing plugin, absent for an unprefixed skill (the common case). */
	readonly plugin?: string;
	/**
	 * Repositories the skill ran in, by name, alphabetically.
	 *
	 * From the SESSIONS rather than from {@link commits}: most skill usage is never
	 * archived onto a commit (measured: 27 of 111 rows), so deriving this from the
	 * commit list would report "ran in nothing" for the majority.
	 */
	readonly repos: ReadonlyArray<string>;
	/**
	 * First entry in the window, from the per-entry record rather than the session's
	 * clock. Absent when no entry row survives — see {@link invocations}.
	 */
	readonly firstCallAtMs?: number;
	/**
	 * Mechanisms this skill was entered by, deduped. `tool` is the agent choosing to
	 * invoke it, `command` is a person asking for it by name; both together is normal.
	 *
	 * Empty when no entry row carries one, which is not the same as "entered by
	 * neither" — a stored history predating the field reads as empty.
	 */
	readonly entryPaths: ReadonlyArray<SkillEntryPath>;
	/**
	 * `"heuristic"` when any entry in the window was inferred from a file read rather
	 * than observed — see {@link ToolUsageRow.detection}, which carries the identical
	 * field for the list row so a reader sees the same mark before and after opening.
	 *
	 * Sits beside {@link entryPaths} and {@link outcomes} because all three are
	 * qualifiers read off the per-entry table, and all three go quiet together when
	 * no entry row survives.
	 */
	readonly detection?: "heuristic";
	/** Absent only when no entry row survives — see {@link SkillDetailOutcomes}. */
	readonly outcomes?: SkillDetailOutcomes;
	/**
	 * The entry rows themselves, oldest first.
	 *
	 * Routinely EMPTY while {@link calls} is not, and that is a normal state rather
	 * than a gap: a count merged in from an already-archived commit has no per-entry
	 * record, and an agent that pruned its own transcript can never have one again.
	 * A surface must render the empty case as "no per-entry record", never as "it
	 * never ran".
	 */
	readonly invocations: ReadonlyArray<SkillDetailInvocation>;
	/**
	 * One point per session that ran the skill, oldest first — the grain both of the
	 * detail view's time charts read at.
	 *
	 * Separate from {@link linkedSessions}, which is capped for a table a reader
	 * scrolls: a chart drawn from 20 of 51 sessions is a chart of the wrong shape, so
	 * this carries the whole window at two numbers per point.
	 *
	 * `tokens` is absent where the source attributed none — the charts skip those
	 * points rather than plotting them at zero.
	 */
	readonly sessionSeries: ReadonlyArray<{ readonly atMs: number; readonly tokens?: number }>;
	/**
	 * Characters this skill injects on a full entry — the LARGEST body recorded, not
	 * an average.
	 *
	 * A repeat entry within one conversation injects an "already loaded above" stub
	 * instead of the body (measured: 3,619 characters then 69 for the same skill), so
	 * an average answers "what did entries cost on average here" while the question
	 * this figure is read for is "what does this skill cost to load".
	 */
	readonly bodyChars?: number;
}

/** One tool of a server, over the window — a row of the detail view's tool list. */
export interface McpServerToolRow {
	/**
	 * The tool's own name, with the server segment ALREADY STRIPPED — `execute_sql`,
	 * not `dbhub.execute_sql`.
	 *
	 * Stripped here rather than in the client because the split is a property of how
	 * `parseToolUse` wrote the row (`<server>.<tool>`, and the server half may itself
	 * carry a host's `plugin_…` registration prefix), which is this layer's knowledge.
	 * A client slicing at the first `.` would be doing schema archaeology, and would be
	 * wrong for a server whose own name contains one.
	 */
	readonly name: string;
	/** Calls of this tool in the window. */
	readonly calls: number;
	/**
	 * Distinct sessions that called it — EXACT for this row, and deliberately not
	 * summable across rows. A session that called three of a server's tools counts in
	 * all three, so these do not add up to {@link McpServerDetail.sessions}; a surface
	 * printing them must not total the column.
	 */
	readonly sessions: number;
}

/** One local calendar day of a server's detail charts. */
export interface McpServerDayPoint {
	/** The local calendar day, `YYYY-MM-DD`. */
	readonly date: string;
	/** Distinct sessions whose last recorded call to this server falls on this day. */
	readonly sessions: number;
	/** Calls made by those sessions, summed over the server's tools. */
	readonly calls: number;
}

/** One session's whole traffic to a server, oldest first. */
export interface McpServerSessionPoint {
	/** Epoch-ms of the session's LAST recorded call to this server (a floor for its first). */
	readonly atMs: number;
	/** Sum of calls that session made across this server's tools. */
	readonly calls: number;
}

/**
 * Everything the MCP detail view shows — the answer to `/api/mcp-detail`.
 *
 * Scoped to the same window and repo selection as the row it was opened from, so the
 * figures here agree with the list beside it. Modelled on {@link SkillDetail}, and the
 * differences are the record's rather than the page's:
 *
 *   - **No outcomes, no entry paths, no arguments and no token figures.** `skill_invocations`
 *     gives a skill a per-invocation record; MCP has no such table, so a call's result,
 *     its arguments and its cost are not merely unrendered here — they were never
 *     written. The page says so in words rather than drawing an empty section.
 *   - **No commit list.** A skill's usage is archived onto a commit as `SkillCommitRef`;
 *     an MCP call is not archived anywhere, so there is nothing to join.
 *   - **{@link tools} exists instead**, which a skill has no counterpart for: a server is
 *     a namespace of tools, and which of them the reader actually reaches for is the
 *     question this page is opened to answer.
 *
 * Absent when the window holds no call to that server, which the route turns into a 404.
 */
export interface McpServerDetail {
	/** The folded server name, as {@link McpServerRow.server} spells it. */
	readonly server: string;
	/** Distinct sessions that called ANY of its tools — exact, not a bound. */
	readonly sessions: number;
	readonly calls: number;
	/** Distinct tools of this server actually called — the length {@link tools} would have uncapped. */
	readonly toolCount: number;
	/**
	 * Its tools, busiest first, capped at {@link MCP_DETAIL_TOOL_LIMIT}.
	 *
	 * {@link toolCount} is the honest total and travels beside it, so a capped list can
	 * say what it is not showing. Ranked by calls, matching the row the reader clicked
	 * (`TOOL_LIST_ORDER.server`), so "busiest" means the same thing in both columns.
	 */
	readonly tools: ReadonlyArray<McpServerToolRow>;
	/** Which agents called it, most calls first — same shape and rule as {@link McpServerRow.agents}. */
	readonly agents: ReadonlyArray<ToolUsageAgentShare>;
	/**
	 * One point per LOCAL DAY in the window, oldest first — what BOTH charts read.
	 *
	 * Empty days are present with zeroes, so neither chart compresses a quiet gap. The
	 * window itself is capped at 366 days, which bounds this payload without dropping
	 * older sessions and silently changing the shape of a busy server's trend.
	 *
	 * A session is filed under the local day of its LAST recorded call to this server,
	 * matching {@link ToolUsage.serverDays}; `session_tool_use` has no per-call MCP table
	 * from which a finer split could be reconstructed.
	 */
	readonly daySeries: ReadonlyArray<McpServerDayPoint>;
	/**
	 * One point per SESSION that called this server in the window, oldest first within
	 * the retained recent set — what the "Calls per session" chart draws.
	 *
	 * The X axis is session index in arrival order, not a time axis: the record holds one
	 * instant per (session, tool) and it is the last call, so an even-time-spacing chart
	 * would misrepresent the record. `atMs` rides along so tooltips and the two axis
	 * endpoints can name the sessions by date. `calls` is the sum over this server's
	 * tools within one session, matching how {@link daySeries} sums a day. This series
	 * is capped at 400 points; {@link sessions} and {@link daySeries} remain exact.
	 */
	readonly sessionSeries: ReadonlyArray<McpServerSessionPoint>;
	/**
	 * Earliest call recorded in the window — a FLOOR, not the first call.
	 *
	 * `session_tool_use` stores one instant per (session, tool) and it is the LAST call,
	 * so the earliest such instant is "the last call of the earliest session", which is
	 * at or after the true first call. Measured on a real database, the two agree at day
	 * resolution for 140 of 141 (session, server) pairs — the spread inside one pair
	 * averages 8.7 minutes — so a date is a fair thing to print while a time would not
	 * be. Nothing can be backfilled to improve it: adding a `first_call_at_ms` column
	 * would only sharpen rows written after it shipped.
	 */
	readonly firstCallAtMs?: number;
	/** Latest call recorded in the window. Exact, unlike {@link firstCallAtMs}. */
	readonly lastCallAtMs?: number;
	/**
	 * Repositories it was called in, by name, alphabetically.
	 *
	 * From the SESSIONS, the only place it could come from — an MCP call is never
	 * archived onto a commit, so there is no second answer to reconcile with.
	 */
	readonly repos: ReadonlyArray<string>;
}

/**
 * Tools listed in one server's detail view.
 *
 * A HEIGHT BUDGET, not a paging decision — this list is the MCP pane's one section
 * whose length is a property of the SERVER rather than of the record's own ceilings, so
 * it is what decides whether the pane fits its fixed frame (`main.css`'s browser-page
 * block owns that frame and the 579px the pane gets at 1440x900).
 *
 * MEASURED, at that viewport: a tool row is 14.5px plus a 6px gap, the rest of the pane
 * comes to 343px, and the truncation note below the list costs another 20px. So 10 rows
 * plus the note is 569px and clears the budget, while the 12 rows a real
 * `chrome-devtools` registration produced came to 589px and summoned the pane's fallback
 * scrollbar — which `.sk-pane` documents as a fallback rather than the design.
 *
 * Re-derive it the same way if the pane grows a section: stub the widest server, then
 * raise this until `.sk-pane`'s `scrollHeight` exceeds its `clientHeight`, and step back
 * one. Raising it without measuring trades a section the reader can see for a scrollbar
 * they have to discover.
 */
export const MCP_DETAIL_TOOL_LIMIT = 10;

/**
 * How many rows ONE PAGE of a skill / server / MCP-tool list carries.
 *
 * Not a cap any more: it is the page size, applied as `LIMIT` in SQL (see
 * `buildToolUsage`), and the card's "Show more" button asks
 * `/api/tool-usage` for the next page of the same size. It stayed 8 because
 * that is the height the card is laid out for — past the first page the list
 * scrolls inside the card rather than growing it, so the page size is also the
 * number of rows visible without scrolling.
 *
 * The client has a copy of this number (`TOOL_PAGE_SIZE` in `assets/js/stats.js`)
 * and it must stay equal to this one. The paging itself is still driven by the
 * `*Total` counts below rather than by the client re-deriving the page size — but
 * the copy is no longer cosmetic: past its scroll cap, the 30 s poll's
 * carry-forward slices a list it decided to COLLAPSE back to that width, claiming
 * it is what a freshly opened card shows. A freshly opened card shows this many.
 */
export const TOOL_ROWS_LIMIT = 8;

/** Which of the three tool-usage lists a page request is for. */
export type ToolUsageList = "skill" | "server" | "tool";

/**
 * One page of a tool-usage list — the `/api/tool-usage` answer.
 *
 * `totalCount` is re-read per page rather than remembered from the first
 * render: the window keeps gaining rows while the dashboard is open, so the
 * client's "is there more" test must be against a total as fresh as the rows
 * it just received.
 */
export type ToolUsagePage =
	| {
			readonly list: "skill" | "tool";
			/** Row index the page starts at — what the caller asked for, echoed back. */
			readonly offset: number;
			readonly rows: ReadonlyArray<ToolUsageRow>;
			readonly totalCount: number;
	  }
	| {
			readonly list: "server";
			readonly offset: number;
			readonly rows: ReadonlyArray<McpServerRow>;
			readonly totalCount: number;
	  };

/**
 * `server.tool` name recorded for the recall feature's own MCP tool — the
 * `session_tool_use.tool_name` value the tool-usage card keys off for its
 * "recall calls" line, which is the only surface left that reads it. The
 * standalone Recall card, which counted `recall_receipts` instead, was removed
 * (JOLLI-2193) along with its query; the receipts themselves are still written.
 */
export const RECALL_MCP_TOOL_NAME = "jollimemory.recall";

/*
 * Removed with the Recall card (JOLLI-2193), because that card was their only
 * reader and a constant nothing consumes is a contract that drifts unnoticed:
 *
 *   - `RECALL_REFERENCE_SOURCE` / `RECALL_REFERENCE_NATIVE_ID` — the `context`
 *     row identity of a recall bookmark, which the card read as its second
 *     pre-receipt channel (one timestamped entry per call, which the tool-usage
 *     rows lack). The reference source itself is untouched; it is declared in
 *     `cli/src/core/references/sources/definitions/jollimemory.ts` and named
 *     there, not here.
 *   - `RECALL_SKILL_NAME` / `RECALL_SKILL_NAMES` — every `input.skill` spelling
 *     of the recall skill (bare `jolli-recall` from a directory install, and
 *     `jolli:recall` from a plugin one), which fed the card's `skillInvocations`
 *     gap detector: "the skill ran but never actually recalled".
 *
 * Both would have to come back to rebuild that card. `recall_receipts` and
 * `session_tool_use` still hold the evidence — nothing about the DATA changed.
 */

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
 * Tool, skill and MCP-server usage over the window.
 *
 * Coverage is the load-bearing part of this shape. Not every source's
 * transcripts can be read for tool calls (`TOOL_RECORDING_SOURCES` is the
 * authority, and it is deliberately evidence-gated rather than aspirational), so
 * `sessionsWithTools` / `sessionsInWindow` and the explicit `uncoveredSources`
 * list travel with every payload: without them a machine that runs one covered
 * session and forty uncovered ones would present the covered agent's tool mix as
 * the whole team's, and an unused MCP server would be indistinguishable from one
 * used only from an unreadable agent.
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
	/**
	 * Skills, most-adopted first — ranked by {@link ToolUsageRow.sessions}, not by
	 * volume, so one session that ran `/simplify` 200 times does not outrank a
	 * skill three separate sessions reached for.
	 *
	 * This is the ONE list that ranks by a figure its rows do not print (they
	 * print runs). That mismatch is why `rankedList` must size its bars against
	 * the list's true maximum rather than its first row — and why an appended
	 * page cannot be spliced into the rendered list in place: a later page can
	 * carry MORE runs than the top row, which moves the bar denominator.
	 *
	 * ONE PAGE — the first {@link TOOL_ROWS_LIMIT} rows. The rest are fetched
	 * per click from `/api/tool-usage?list=skill`, so anything derived from the
	 * whole set must come off a `*Total` field or its own grouping, never off
	 * this array.
	 */
	readonly skills: ReadonlyArray<ToolUsageRow>;
	/** Distinct skills in the window — the paging total behind `skills`, and the "N skills" the card prints. */
	readonly skillsTotal: number;
	/** Every skill run in the window, including rows past the first page. */
	readonly skillCallsTotal: number;
	/**
	 * Day-by-day adoption for the Skills page's stacked band, oldest first.
	 *
	 * ONE POINT PER LOCAL DAY IN THE WINDOW, including days with no skill use. The
	 * chart lays bars out by index, so a dropped day would silently compress the axis
	 * and make a week-long gap look like a busy stretch. No cap is needed on top of
	 * that: the window itself is bounded (a custom range is clamped to `MAX_CUSTOM_DAYS`),
	 * which is what the retired week-bucket cap existed to do.
	 *
	 * Covers EVERY skill in the window, not only {@link skills}' first page — the band
	 * is a whole-window view and a chart drawn from one page would change shape as the
	 * list below it grew.
	 *
	 * **The unit is a skill-session, and it does not sum to sessions.** A session that
	 * reached for three skills counts once in each of their series, so a bar's total is
	 * skill-sessions rather than distinct sessions. Adoption is the honest question here
	 * because usage is recorded per session; a per-RUN daily count does not exist to
	 * draw, since only the capped entry list carries run timestamps.
	 *
	 * **A session is filed under ONE day — the day of its last recorded call for that
	 * skill.** `session_tool_use` keeps a single timestamp per (session, skill), so a
	 * session that ran past local midnight contributes entirely to the later day rather
	 * than to both. Measured on a real database: 5 of 68 (session, skill) pairs spanned
	 * more than one local day. `skill_invocations` does carry per-call timestamps and
	 * would resolve those exactly, but it is deliberately NOT the source — it had detail
	 * for 68 pairs against the aggregate's 116, so 41% of the rows the list below shows
	 * would be missing from the chart above it.
	 */
	readonly skillDays: ReadonlyArray<SkillDayPoint>;
	/**
	 * MCP servers, busiest first — ranked by {@link McpServerRow.calls}, with
	 * sessions as the tiebreak.
	 *
	 * Volume rather than adoption because this is the figure the card prints and
	 * bars: ranking by sessions put 149 calls below 68 and made the two cards
	 * disagree about what "first" meant, for no reading the numbers on screen
	 * could explain. A server's adoption is still on the row (`sessions` rides in
	 * the "by tool" split's meta slot) — it just does not order the list.
	 *
	 * ONE PAGE, like {@link skills} — see {@link serversTotal}.
	 */
	readonly servers: ReadonlyArray<McpServerRow>;
	/** Distinct MCP servers called in the window — the paging total behind `servers`. */
	readonly serversTotal: number;
	/** Every MCP call in the window that carries a server, including rows past the first page. */
	readonly serverCallsTotal: number;
	/**
	 * Day-by-day adoption for the MCPs page's stacked band, oldest first — the
	 * server-side twin of {@link skillDays}, and the same shape for the same reason.
	 *
	 * Every rule stated on `skillDays` holds here unchanged: one point per LOCAL day of
	 * the window including days nothing ran (the chart lays bars out by index, so a
	 * dropped day compresses the axis), every server in the window rather than
	 * {@link servers}' first page, and the unit is a SERVER-SESSION — a session that
	 * called two servers counts once in each series, so a bar's total is not distinct
	 * sessions.
	 *
	 * **The series key is the FOLDED server name**, the same one {@link McpServerRow.server}
	 * carries, so a server reached under both a bare and a plugin-prefixed registration is
	 * one series here and one row there. Keyed any other way the band would draw two
	 * series the list below it presents as one.
	 *
	 * A session is filed under ONE day — the day of its last recorded call to that server,
	 * since `session_tool_use` keeps a single timestamp per (session, tool). Measured on a
	 * real database: 1 of 141 (session, server) pairs spanned more than one local day, so
	 * the cost here is smaller than the 5-of-68 `skillDays` records. There is no per-call
	 * table for MCP the way `skill_invocations` is one for skills, so this is not a choice
	 * between two grains — it is the only grain the record holds.
	 */
	readonly serverDays: ReadonlyArray<SkillDayPoint>;
	/**
	 * Individual MCP tools (name already `server.tool`), busiest first — the "by
	 * tool" split of `servers`, same rule, and ONE PAGE like the other two.
	 */
	readonly mcpTools: ReadonlyArray<ToolUsageRow>;
	/** Distinct MCP tools called in the window — the paging total behind `mcpTools`. */
	readonly mcpToolsTotal: number;
	/**
	 * Distinct MCP tools that belong to a named server — the whole-window total shown
	 * on the MCPs page beside {@link serversTotal}.
	 *
	 * Kept separate from {@link mcpToolsTotal}: the general "by tool" list also admits
	 * legacy MCP rows whose `server` is null, while the MCPs page's server chooser and
	 * its headline deliberately do not.
	 */
	readonly serverToolsTotal: number;
	/**
	 * The recall feature's own row (`jollimemory.recall`), from its OWN query
	 * rather than out of `mcpTools` — recall can rank outside the first page of
	 * MCP tools on a busy machine even when its own volume is worth reporting, so
	 * this must not be derived from `mcpTools` client-side (that held under the
	 * old adoption ranking, holds under volume, and holds harder now that the
	 * array is one page of a paged list: the reader may never click far enough to
	 * load the row). `undefined` when the window has no matching row (misses bare
	 * `jolli recall` CLI runs and the skill's non-MCP fallback too — those never
	 * produce an `mcp`-kind row at all).
	 */
	readonly recallCalls?: ToolUsageRow;
	/**
	 * Agents that ran a skill in the window, most calls first.
	 *
	 * Its own grouping over EVERY row in the window, not a roll-up of
	 * {@link skills} — that array is one page of {@link TOOL_ROWS_LIMIT}, so
	 * deriving this client-side would under-report every agent whose skills all
	 * rank outside the loaded pages, and would have to re-sum session counts (see
	 * {@link ToolUsageAgentShare}).
	 *
	 * NO READER TODAY. It fed the Skills card's `by agent · 12 claude` header line,
	 * which was removed for restating at card level what every row already names
	 * through its own `agents` — so the whole-window per-agent split with volume is
	 * currently computed and shipped and stated nowhere. Kept because that makes
	 * restoring the line a render change and nothing else (see the note where
	 * `agentLine` was, in `assets/js/stats.js`); recorded here because a payload
	 * field with no reader is otherwise a contract that drifts unnoticed.
	 */
	readonly skillAgents: ReadonlyArray<ToolUsageAgentTotal>;
	/** Agents that called an MCP tool in the window, most calls first — same rule as {@link skillAgents}, and unread for the same reason. */
	readonly mcpAgents: ReadonlyArray<ToolUsageAgentTotal>;
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
 * Data honesty flags surfaced in the UI footer.
 *
 * One kind left, and the one that went is worth knowing about. `sessions-window`
 * said "older activity is reconstructed from commits and stored summaries;
 * recent sessions are exact" — a caveat about how the timeline is BUILT, printed
 * under every stats and standup render whether or not the reader was near the
 * boundary it describes. It was removed as permanent furniture: a line that is
 * always there is read once and then not at all, so it bought no honesty while
 * costing a footer on every page. The reconstruction it warned about has not
 * changed; if that distinction needs stating again, state it where a reader can
 * act on it (on the affected buckets) rather than under the whole page.
 *
 * `no-data` survives because it is not furniture — it appears only on an empty
 * database, says what will fill it, and disappears for good after the first
 * session.
 */
export interface CoverageNote {
	readonly kind: "no-data";
	readonly message: string;
}

/**
 * Which OPTIONAL sidebar menu rows this machine shows — Settings → Advanced.
 *
 * Lives at the top of {@link DashboardModel}, not inside {@link SettingsPageModel},
 * for two reasons that pull the same way. The sidebar is part of the SHELL, so it
 * is rendered on every view and needs these booleans in every payload; and the
 * Settings modal fetches a whole `DashboardModel` (`/api/model?view=settings`), so
 * it reads them here too. One fact, one place — a copy under `settings` would be a
 * second owner with no tie-breaker.
 *
 * `false` hides the ROW only. Both views stay routed (see `VIEW_PATHS` in
 * `DashboardServer`), so a bookmark and the Knowledge → Graph jump keep working.
 */
export interface DashboardMenus {
	readonly knowledge: boolean;
	readonly graph: boolean;
}

/**
 * How a journey's commits were grouped. Rendered as a distinct badge on every
 * rung: a branch journey must never present itself as a ticket journey. Same
 * rule as "unmeasured is not zero", one level up — an INFERRED grouping must
 * not render as a STATED one.
 */
export type JourneyGroupedBy = "ticket" | "branch" | "commit";

/** Whether a signal was measured for this journey. Ported from the cloud. */
export type FieldAvailability = "measured" | "partial" | "unavailable";

/**
 * Which signals this journey could be measured on.
 *
 * `frictionSignals`, `waitTiming` and `reviewTiming` are pinned `"unavailable"`
 * locally and are NOT dropped: keeping the field means a future signal is a
 * population rather than a redesign, and every mark is gated on this object —
 * an unmeasured signal draws nothing rather than drawing a zero.
 */
export interface JourneyAvailability {
	readonly duration: FieldAvailability;
	readonly turns: FieldAvailability;
	readonly cost: FieldAvailability;
	readonly frictionSignals: FieldAvailability;
	readonly waitTiming: FieldAvailability;
	readonly reviewTiming: FieldAvailability;
}

export interface JourneyDecision {
	readonly text: string;
	readonly commitHash: string;
}

export interface LocalJourneyCommit {
	readonly commitHash: string;
	readonly message: string;
	readonly committedAtMs: number;
	readonly repoIdentity: string;
	readonly repoName: string;
}

/** One stretch where the agent finished and waited for the human. */
export interface WaitPeriod {
	/** The agent's last turn — when it stopped and waited. */
	readonly startedAtMs: number;
	/** The human's next turn — when the wait ended. */
	readonly endedAtMs: number;
	readonly durationMinutes: number;
}

/** The journey's recorded turns, split by speaker. */
export interface TurnAttribution {
	readonly humanTurns: number;
	readonly agentTurns: number;
}

/**
 * One journey. Mirrors the cloud's `CoachingJourney` except for the delta the
 * spec's §2.3 fixes: `subjectId` and `waitingOn` are gone (single-subject), and
 * `groupedBy` plus `turns` are added.
 *
 * `turns` is an ADDITION, not a repurposing of `durationMinutes`: they are
 * different quantities, and writing turns into a field named for minutes is the
 * lie the whole availability model exists to prevent.
 *
 * `landed` does NOT appear here. It was carried as "this commit survived the
 * reachability filter" — which every commit that reaches the accumulator does
 * by construction, since unreachable rows are dropped before folding starts —
 * so it was a boolean that could only ever be `true` (see I1(b) of the review
 * that removed it). Rendering a constant as a fact is the same class of bug
 * this model exists to prevent one level down (an unmeasured signal must never
 * render as a zero); a structurally-always-true field is the same lie in the
 * other direction. A future `landed` distinguishing "reached the default
 * branch" from "reachable from some branch" needs a second git walk this repo
 * does not do today — see the review note in `JourneysQuery.ts`'s history
 * before reintroducing it.
 */
export interface LocalJourney {
	readonly id: string;
	readonly groupedBy: JourneyGroupedBy;
	readonly ticket: string | null;
	readonly branch: string | null;
	readonly title: string;
	readonly repoIdentity: string;
	readonly repoName: string;
	readonly startedAtMs: number;
	readonly endedAtMs: number;
	readonly commitCount: number;
	readonly sessionCount: number;
	readonly turns: number | null;
	readonly durationMinutes: number | null;
	readonly costUsd: number | null;
	readonly planFirst: boolean;
	readonly shape: JourneyShape;
	/** Capped for the feed — `decisionCount` is the true total. Never a silent cut. */
	readonly decisions: ReadonlyArray<JourneyDecision>;
	readonly decisionCount: number;
	readonly availability: JourneyAvailability;
	/**
	 * Per-journey turn-abort friction, absent unless the producer opted in
	 * (`buildJourneys(..., { withFriction: true })`). Not the roster's
	 * window-aggregate cell — this is one journey's own abort count, gating the
	 * feed's `flagged` chip. Absent means "not requested", never "no friction".
	 */
	readonly friction?: RosterCell;
	/**
	 * Per-journey test-first verdict, absent unless the producer opted in
	 * (`buildJourneys(..., { withTests: true })`). A test run before the
	 * journey's first commit is the §5 step-5 signal the test-first pattern
	 * counts. Absent means "not requested", never "no tests".
	 */
	readonly tested?: JourneyTested;
	/**
	 * Longest single "waiting on you" stretch in minutes, absent unless the
	 * producer opted in (`buildJourneys(..., { withWaits: true })`). Derived from
	 * turn timestamps (no DB column), so it rides the same transcript walk as
	 * `friction`/`tested`. Absent means "not requested", never "no wait".
	 */
	readonly longestWaitMinutes?: number;
}

/**
 * Whether a journey ran a test before its first commit, availability-gated.
 *
 * `testRuns` is forward-only and source-gated, so a journey with no reporting
 * session is `unavailable` (no verdict) rather than "not test-first". A
 * `partial` journey's `testFirst: true` is still positive evidence — a
 * pre-commit run was seen — while `false` means only "no positive evidence".
 */
export interface JourneyTested {
	readonly availability: RosterAvailability;
	/** Present unless `availability === "unavailable"`. */
	readonly testFirst?: boolean;
}

export interface JourneysModel {
	readonly journeys: ReadonlyArray<LocalJourney>;
	/** Memories that fell in the window, before grouping — the feed's denominator. */
	readonly indexedCommits: number;
	readonly smoothestId: string | null;
	readonly hardestId: string | null;
	/**
	 * The exact bounds this payload's grouping was computed under — the same
	 * `fromMs`/`toMs` `buildJourneys` was called with, echoed back rather than
	 * left for a caller to re-derive.
	 *
	 * A journey id is only meaningful within the window that grouped it: two
	 * independent `resolveWindow` calls (one for the feed, a later one for a
	 * clicked row) can straddle a local-midnight boundary and disagree about
	 * what "30d" means, so a journey the feed just rendered can 404 from the
	 * detail route. Opening a journey must send THESE bounds back
	 * (`/api/journey?...&fromMs=&toMs=`) rather than letting the route resolve
	 * a fresh window from a second clock read.
	 */
	readonly windowStartMs: number;
	readonly windowEndMs: number;
}

/**
 * How much of a roster cell's underlying signal the window actually measured.
 *
 * `partial` is the load-bearing one: a window that opens before a signal began
 * being captured produces a real but unrepresentative number, and rendering it
 * as a plain value is indistinguishable from "this person does not do that".
 * Tool-use capture began part-way through this database's history, so every
 * cell reading `session_tool_use` can be in this state for a wide-enough window.
 */
export type RosterAvailability = "measured" | "partial" | "unavailable";

/** One roster cell: a number, how well it was measured, and its own trend. */
export interface RosterCell {
	readonly availability: RosterAvailability;
	/** Absent unless `availability === "measured"`. */
	readonly value?: number;
	/**
	 * Percent change against the immediately preceding window of equal length.
	 * Absent when the prior window has nothing to divide by — never rendered as
	 * `+0%`, which claims a measurement that was not made.
	 */
	readonly trendPct?: number;
}

/** The skills cell additionally names the top skill, which has no numeric form. */
export interface RosterSkillsCell extends RosterCell {
	readonly topName?: string;
	readonly distinctCount?: number;
}

export interface CoachingRoster {
	/** Label for the single subject — this machine's user. */
	readonly label: string;
	/** Share of the window's journeys that began with a plan, 0-100. */
	readonly planFirst: RosterCell;
	readonly skills: RosterSkillsCell;
	/** Cost over the window, in USD, trended against the same population. */
	readonly cost: RosterCell;
	/** Recall tool calls over the window, across every server-name spelling. */
	readonly recall: RosterCell;
	/**
	 * Median activity minutes per journey — how quickly work turns around. Thin
	 * until duration coverage is raised (§4.3): the cell is `unavailable` when no
	 * journey in the window has measured duration, and the median only ever
	 * divides by the measured set.
	 */
	readonly turnaround: RosterCell;
	/**
	 * The red-zone chip (§3.3): turn-abort friction events across the window's
	 * sessions. Codex-only (`turn_aborted`), so `unavailable` when no session
	 * could report it and `partial` when some Codex sessions predate the capture
	 * field — never a `0` for an unmeasured signal.
	 */
	readonly friction: RosterCell;
}

/** One practice the ADOPT NEXT card recommends, with how far along it already is. */
export interface AdoptItem {
	readonly key: string;
	readonly title: string;
	/** Template-assembled sentence — never an LLM pass (§3.5). */
	readonly detail: string;
	/** Journeys of the last `window` that already do it. */
	readonly adopted: number;
	/** Denominator — the last N journeys the share is measured over. */
	readonly window: number;
}

/** One self-directed action item, drawn from a specific journey (the evidence link). */
export interface QueueItem {
	readonly key: string;
	readonly title: string;
	readonly detail: string;
	readonly journeyId: string;
	readonly journeyTitle: string;
	/** The originating journey's ticket, shown as the evidence label. Null when the
	 *  journey is branch/commit-grouped (no ticket) — the surface falls back to the
	 *  journey title then. */
	readonly journeyTicket: string | null;
	readonly repoIdentity: string;
}

/** One behaviour pattern across the window's journeys. */
export interface Pattern {
	readonly key: string;
	readonly label: string;
	readonly count: number;
	/** Distinct ISO weeks the matching journeys span. */
	readonly weeks: number;
	/** Below the evidence bar (≥4 journeys over ≥3 weeks). */
	readonly emerging: boolean;
}

export interface PatternsModel {
	readonly established: ReadonlyArray<Pattern>;
	readonly emerging: ReadonlyArray<Pattern>;
}

/**
 * The journeys view's inline payload.
 *
 * `JourneysModel` deliberately does NOT ride here any more: the feed is behind a
 * modal, so inlining its rows would pay ~107 KB on every page load for content
 * most loads never open. The featured pair are whole journeys rather than ids
 * because they render on load, inside the roster's open expansion.
 */
export interface CoachingModel {
	readonly roster: CoachingRoster;
	/** The ADOPT NEXT card's recommendations, in display order. */
	readonly adoptNext: ReadonlyArray<AdoptItem>;
	/** Self-directed action items, each linked to the journey it came from. */
	readonly queue: ReadonlyArray<QueueItem>;
	readonly patterns: PatternsModel;
	/** Per-day cost/turn points for the expansion's hero trend. */
	readonly hero: ReadonlyArray<{ readonly date: string; readonly costUsd: number; readonly turns: number }>;
	readonly featured: {
		readonly smoothest: LocalJourney | null;
		readonly hardest: LocalJourney | null;
	};
	/** How many journeys the feed modal will show — the button's own count. */
	readonly journeyCount: number;
	/** Journeys in the window carrying a measured turn-abort. Absent when no
	 *  journey's friction is measurable (e.g. an all-Claude window). */
	readonly flaggedCount?: number;
	/** Journeys that stalled waiting on the human (longest wait ≥ the stall
	 *  threshold). Absent when no journey's wait was measured — in practice
	 *  today that means an empty window (zero journeys), since `buildCoaching`
	 *  always requests waits, so every journey in a non-empty window carries a
	 *  (possibly zero) `longestWaitMinutes`. Not a per-journey availability
	 *  gate the way `flaggedCount`'s friction denominator is. */
	readonly awaitingCount?: number;
	readonly indexedCommits: number;
	readonly windowStartMs: number;
	readonly windowEndMs: number;
	/** The window echoed back for the topbar range control (mirrors StatsModel).
	 *  Filled at the payload layer from the resolved window, not by `buildCoaching`
	 *  itself, so the query and its direct tests stay unaware of the preset name. */
	readonly range?: DashboardRange;
	readonly rangeFrom?: string;
	readonly rangeTo?: string;
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
	/** Optional sidebar rows the user has switched on. Present on every view. */
	readonly menus: DashboardMenus;
	readonly stats?: StatsModel;
	readonly standup?: StandupModel;
	/** Present on the memories view only. */
	readonly memories?: MemoriesModel;
	/** Present on the knowledge view only. */
	readonly knowledge?: KnowledgeModel;
	/** Present on the graph view only. */
	readonly graph?: GraphModel;
	/** Present on the settings view only. */
	readonly settings?: SettingsPageModel;
	/** Present on the journeys view only. The feed itself arrives over `/api/journeys`. */
	readonly coaching?: CoachingModel;
}

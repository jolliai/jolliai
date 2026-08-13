/**
 * DashboardCollector — turns a repo's on-disk reality into `StatsEvent`s.
 *
 * The dashboard's own collection layer, used by bootstrap and gap recovery. It
 * deliberately does NOT reuse `listActiveConversations`: that function is shaped
 * for the sidebar — it drops sessions the user hid, counts only unread turns,
 * and filters to a 48 h activity window — all of which would silently understate
 * a stats dashboard. Here every discoverable session counts, with its full
 * message count, regardless of read-cursor or hidden state.
 *
 * Everything returned is an event for `StatsWriter.apply`, so collection has no
 * write ordering of its own: collect, hand over, done. The same fact collected
 * twice produces the same `event_id` and lands on the same row.
 */

import { UNTITLED_SESSION } from "../core/FallbackTitle.js";
import { execGit, getCurrentBranch } from "../core/GitOps.js";
import { JOLLI_REFS_EXCLUDE_GLOB } from "../core/JolliRefs.js";
import { extractRepoName, getRemoteUrl, resolveKBPath } from "../core/KBPathResolver.js";
import { estimateModelCostUsd, PRICES_AS_OF } from "../core/Pricing.js";
import { resolveSessionTitle } from "../core/SessionTitleResolver.js";
import { loadConfig } from "../core/SessionTracker.js";
import type { StorageProvider } from "../core/StorageProvider.js";
import { getIndex, getSummary, readTranscriptsForCommits } from "../core/SummaryStore.js";
import { collectDisplayTopics, getTranscriptIds } from "../core/SummaryTree.js";
import { readTranscript } from "../core/TranscriptReader.js";
import { readGraph } from "../graph/GraphArtifactStore.js";
import type { KnowledgeGraph } from "../graph/GraphSchema.js";
import { createLogger, errMsg } from "../Logger.js";
import type {
	CommitSummary,
	ModelTokenUsage,
	SessionInfo,
	SkillCommitRef,
	ToolCallCount,
	TranscriptSource,
} from "../Types.js";
import type {
	CommitCreatedEvent,
	CommitFileChange,
	CommitInsightItem,
	CommitSummaryEvent,
	SessionLinkItem,
	SessionUpsertedEvent,
	StatsModelUsage,
	WorktreeStatusEvent,
} from "./DashboardModel.js";
import { observeWorktree } from "./StatsWriter.js";

const log = createLogger("DashboardCollector");

/**
 * Normalises a transcript's per-model usage into the dashboard's own shape,
 * pricing each model as it goes. Shared by the live read path
 * ({@link sessionEventFromInfo}) and the stored-transcript path
 * ({@link summaryEventFromCommitSummary}) so a model's tokens cost the same
 * regardless of which one observed them.
 *
 * The zero-token drop is here rather than only in `TranscriptParser`, and both
 * are needed: the parser guards what is captured from here on, while the stored
 * path replays `usageByModel` recorded by whatever reader ran at commit time.
 * Transcripts captured before the parser learned about `"<synthetic>"` — the
 * placeholder Claude Code stamps on a turn that never reached a model — carry
 * that all-zero bucket forever, so without this a rebuilt database re-imports
 * it and the spend card's legend gets it back.
 */
function toStatsModelUsage(models: ReadonlyArray<ModelTokenUsage>): StatsModelUsage[] {
	// Unpriced models keep estCostUsd absent rather than 0 — a zero would read
	// as "free" in every cost sum, when the truth is "unknown".
	return models
		.filter((m) => m.input + m.output + m.cached > 0)
		.map((m) => {
			const cost = estimateModelCostUsd(m);
			return {
				model: m.model,
				provider: m.provider,
				inputTokens: m.input,
				outputTokens: m.output,
				cachedTokens: m.cached,
				...(cost !== null ? { estCostUsd: cost } : {}),
			};
		});
}

/**
 * Loads raw `SessionInfo`s from every source, without the sidebar's filters.
 *
 * Injectable so tests (and any embedder) can supply a fixed session list; the
 * default fans out to the same per-source discoverers the sidebar uses — the
 * discoverers themselves are shape-neutral, it is only the aggregator above
 * them that applies sidebar policy.
 */
export type SessionLoader = (cwd: string) => Promise<ReadonlyArray<SessionInfo>>;

/** Default loader: every per-source discoverer, failures logged and skipped. */
export async function loadAllSessions(cwd: string): Promise<ReadonlyArray<SessionInfo>> {
	// Lazy imports, same rationale as ActiveSessionAggregator: several
	// discoverers reach for node:sqlite, and loading them eagerly would emit
	// the ExperimentalWarning in processes that never scan sessions.
	const loaders: ReadonlyArray<() => Promise<ReadonlyArray<SessionInfo>>> = [
		async () => (await import("../core/SessionTracker.js")).loadAllSessions(cwd),
		async () =>
			(await import("../core/CursorSessionDiscoverer.js")).scanCursorSessions(cwd).then((r) => r.sessions),
		async () => (await import("../core/CodexSessionDiscoverer.js")).discoverCodexSessions(cwd),
		async () =>
			(await import("../core/OpenCodeSessionDiscoverer.js")).scanOpenCodeSessions(cwd).then((r) => r.sessions),
		async () =>
			(await import("../core/CopilotSessionDiscoverer.js")).scanCopilotSessions(cwd).then((r) => r.sessions),
		async () =>
			(await import("../core/CopilotChatSessionDiscoverer.js"))
				.scanCopilotChatSessions(cwd)
				.then((r) => r.sessions),
		async () => (await import("../core/ClineSessionDiscoverer.js")).scanClineSessions(cwd).then((r) => r.sessions),
		async () =>
			(await import("../core/ClineCliSessionDiscoverer.js")).scanClineCliSessions(cwd).then((r) => r.sessions),
		async () => (await import("../core/DevinSessionDiscoverer.js")).scanDevinSessions(cwd).then((r) => r.sessions),
		async () =>
			(await import("../core/CursorCliSessionDiscoverer.js")).scanCursorCliSessions(cwd).then((r) => r.sessions),
		async () =>
			(await import("../core/AntigravitySessionDiscoverer.js"))
				.scanAntigravitySessions(cwd)
				.then((r) => r.sessions),
	];
	const settled = await Promise.allSettled(loaders.map((load) => load()));
	const sessions: SessionInfo[] = [];
	for (const result of settled) {
		if (result.status === "fulfilled") sessions.push(...result.value);
		else log.warn("session discoverer failed during dashboard collection: %s", errMsg(result.reason));
	}
	return sessions;
}

export interface CollectSessionsOptions {
	readonly repoIdentity: string;
	readonly cwd: string;
	/** Injected for tests. Defaults to {@link loadAllSessions}. */
	readonly loadSessions?: SessionLoader;
	/**
	 * Reads a transcript's usage. Injected for tests; the default reads real
	 * Claude JSONL via `readTranscript`.
	 */
	readonly readUsage?: typeof readTranscript;
}

/**
 * The session's display title, or undefined when there genuinely is none.
 *
 * `SessionInfo.title` alone is NOT the answer: only the discoverers with a
 * native title column populate it (opencode, cursor, devin, cline, copilot,
 * antigravity), so Claude — the most common source by far — always arrived
 * here titleless and every one of its conversations rendered `(untitled)` on
 * the Memories detail page. `resolveSessionTitle` is the CLI's existing answer
 * to exactly this (native title → Claude's `ai-title` stream → first user
 * message, truncated), already used by the Active Conversations sidebar; this
 * just stops the dashboard from being the one surface that skips it.
 *
 * The `UNTITLED_SESSION` sentinel is deliberately mapped back to undefined so
 * the column stays NULL: "no title" is a fact each surface renders its own way
 * (`${source} session` in Standup, `(untitled)` in Memories), not a string to
 * bake into the database.
 */
async function resolveTitle(s: SessionInfo): Promise<string | undefined> {
	try {
		const title = await resolveSessionTitle(s);
		return title && title !== UNTITLED_SESSION ? title : undefined;
	} catch {
		// A title is never worth failing a session write for.
		return s.title || undefined;
	}
}

/**
 * Builds one `session.upserted` event from one discovered session.
 *
 * The shared building block behind bulk collection (bootstrap/recovery) and
 * the live producers (StopHook, the VS Code tick) — one code path means a
 * session recorded live and the same session re-collected later land on the
 * identical row with identical semantics.
 *
 * Token figures come from the transcript itself and only Claude transcripts
 * carry per-turn usage — every other source is honestly labelled
 * `sessions-only`, which the UI renders as a session count instead of a token
 * figure (the mockups' G-3 coverage split).
 *
 * Returns null when the discoverer's timestamp is unparseable — an event
 * without a valid `updatedAtMs` cannot be bucketed anywhere.
 */
export async function sessionEventFromInfo(
	repoIdentity: string,
	s: SessionInfo,
	readUsage: typeof readTranscript = readTranscript,
): Promise<SessionUpsertedEvent | null> {
	const source: TranscriptSource = s.source ?? "claude";
	const updatedAtMs = Date.parse(s.updatedAt);
	if (!Number.isFinite(updatedAtMs)) return null;
	const title = await resolveTitle(s);
	const base = {
		type: "session.upserted" as const,
		repoIdentity,
		source,
		sessionId: s.sessionId,
		...(title ? { title } : {}),
		updatedAtMs,
	};
	if (source !== "claude") return base;
	try {
		const read = await readUsage(s.transcriptPath);
		const models: StatsModelUsage[] = toStatsModelUsage(read.usageByModel ?? []);
		const first = read.entries[0]?.timestamp;
		const last = read.entries[read.entries.length - 1]?.timestamp;
		const startedAtMs = first ? Date.parse(first) : Number.NaN;
		const endedAtMs = last ? Date.parse(last) : Number.NaN;
		return {
			...base,
			messageCount: read.entries.length,
			...(Number.isFinite(startedAtMs) ? { startedAtMs } : {}),
			...(Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs) && endedAtMs > startedAtMs
				? { durationMs: endedAtMs - startedAtMs }
				: {}),
			...(models.length > 0
				? { models, tokenCoverage: "full" as const, pricesAsOf: PRICES_AS_OF }
				: { tokenCoverage: "sessions-only" as const }),
			// Forwarded only when the reader actually produced it. An empty array
			// means "called no tools" and is worth storing; absence means "this
			// source records none", and the two must not collapse.
			...(read.toolUse ? { tools: read.toolUse } : {}),
		};
	} catch (err) {
		// A moved or deleted transcript still counts as a session — record it
		// with what the discoverer knew rather than dropping the row.
		log.warn("transcript unreadable for %s/%s: %s", source, s.sessionId, errMsg(err));
		return base;
	}
}

/** Collects one `session.upserted` per discoverable session (see {@link sessionEventFromInfo}). */
export async function collectSessionEvents(opts: CollectSessionsOptions): Promise<ReadonlyArray<SessionUpsertedEvent>> {
	const load = opts.loadSessions ?? loadAllSessions;
	const readUsage = opts.readUsage ?? readTranscript;
	const sessions = await load(opts.cwd);

	// Dedupe on (source, id), newest wins — two discoverers can surface the same
	// session (e.g. a registry entry and a rescan of the same store).
	const bySourceAndId = new Map<string, SessionInfo>();
	for (const s of sessions) {
		const key = `${s.source ?? "claude"}:${s.sessionId}`;
		const existing = bySourceAndId.get(key);
		if (!existing || Date.parse(s.updatedAt) > Date.parse(existing.updatedAt)) bySourceAndId.set(key, s);
	}

	const events: SessionUpsertedEvent[] = [];
	for (const s of bySourceAndId.values()) {
		const event = await sessionEventFromInfo(opts.repoIdentity, s, readUsage);
		if (event) events.push(event);
	}
	return events;
}

/**
 * Loads a repo's `jolli graph` artifact from its Memory Bank folder.
 *
 * The dashboard does not build the graph — `jolli graph` does, through the LLM
 * distillation pipeline, and writes it to `<kbRoot>/.jolli/graph/graph.json`.
 * This only imports what is already there, so the dashboard and the VS Code
 * panel are two readers of ONE artifact rather than two producers of two.
 *
 * Returns null for every "not there" case (never enabled, never distilled,
 * folder moved, unreadable JSON): the graph is optional and regenerable, so its
 * absence is a normal state to report, not a failure to propagate.
 */
export async function collectRepoGraph(cwd: string): Promise<KnowledgeGraph | null> {
	try {
		const config = await loadConfig();
		const kbRoot = resolveKBPath(extractRepoName(cwd), getRemoteUrl(cwd), config.localFolder);
		return await readGraph(kbRoot);
	} catch (err) {
		log.debug("knowledge graph unreadable for %s: %s", cwd, errMsg(err));
		return null;
	}
}

export interface CollectCommitsOptions {
	readonly repoIdentity: string;
	readonly cwd: string;
	/** Only commits at or after this epoch-ms. Bootstrap passes nothing (all). */
	readonly sinceMs?: number;
	/** Storage for the summary-index enrichment read. See {@link CollectSummariesOptions.storage}. */
	readonly storage?: StorageProvider;
	/**
	 * Commit hashes whose FILE ROWS are already stored — their `--numstat` is
	 * skipped. Not "hashes already in `commits`": a commit whose numstat failed is
	 * stored without file rows, and treating it as known made that gap permanent.
	 * See {@link INCREMENTAL_NUMSTAT_LIMIT} for the whole rationale; omit it
	 * (bootstrap) to scan every commit.
	 */
	readonly knownHashes?: ReadonlySet<string>;
}

/**
 * Above this many NEW commits, the incremental `--no-walk` pass is abandoned for
 * the whole-history one.
 *
 * Two reasons, and the first is a hard limit rather than a tuning choice: the
 * incremental form passes every hash as an argv entry (40 bytes each), and
 * Windows caps a command line at ~32 KB — so a large enough set does not run
 * slower, it fails to spawn. The second is that past a few hundred commits the
 * two forms cost about the same anyway, and one `git log` beats a long argv.
 */
const INCREMENTAL_NUMSTAT_LIMIT = 400;

/** Field separator for the git log format string (US, U+001F) — cannot appear in a commit subject. */
const SEP = "\u001f";

/**
 * Per-commit ceiling on recorded file paths.
 *
 * A vendored-dependency drop or a repo-wide reformat can touch thousands of
 * files in one commit; storing all of them would let a single mechanical change
 * dominate every "which files do agents keep touching" answer, at a cost of
 * thousands of rows. The cap is generous enough that no hand-written commit
 * reaches it.
 */
const MAX_FILES_PER_COMMIT = 200;

/** Start-of-record marker for the numstat pass (SOH) — cannot appear in a path. */
const REC = "\u0001";

/**
 * Per-commit file lists over the same window {@link collectCommitEvents} logs.
 *
 * A SEPARATE `git log` pass, deliberately, rather than adding `--numstat` to the
 * existing one: numstat multiplies that command's output by the number of files
 * in history, and `execGit` caps stdout at 10 MB. Folded into one call, a large
 * repo would blow the buffer and lose EVERY commit event — trading the whole
 * dashboard for a nice-to-have. Split, the same failure costs only file detail
 * and the commits still land.
 *
 * `core.quotePath=false` keeps non-ASCII paths as raw UTF-8; git otherwise
 * escapes them into `\NNN` octal, which would store mangled paths for any repo
 * with CJK or accented filenames. `--no-renames` reports a rename as a delete
 * plus an add rather than git's `{old => new}` brace syntax — that syntax cannot
 * be parsed back into a path unambiguously, and for a churn ranking a rename
 * genuinely is two touched paths.
 */
/**
 * Parses `git log --numstat --format=<REC>%H` output into per-commit file lists.
 *
 * Split from the two callers so the live post-commit path and the bootstrap
 * sweep cannot disagree about what a numstat line means — they differ only in
 * which commits they ask git for.
 */
export function parseNumstatLog(stdout: string): Map<string, CommitFileChange[]> {
	const byHash = new Map<string, CommitFileChange[]>();
	let current: CommitFileChange[] | undefined;
	for (const line of stdout.split("\n")) {
		if (line.startsWith(REC)) {
			current = [];
			byHash.set(line.slice(REC.length), current);
			continue;
		}
		// A merge commit emits no numstat lines at all, so `current` stays the
		// empty array seeded above — the honest record for "showed no diff".
		if (!line || !current || current.length >= MAX_FILES_PER_COMMIT) continue;
		const [added, removed, path] = line.split("\t");
		// A path containing a tab or newline is still quoted by git even with
		// quotePath off, and would not split into exactly three fields. Skipping it
		// loses one path rather than storing a corrupted one.
		if (!path) continue;
		current.push({
			path,
			// "-" marks a binary file, where a line count does not exist.
			...(added === "-" ? {} : { insertions: Number.parseInt(added, 10) }),
			...(removed === "-" ? {} : { deletions: Number.parseInt(removed, 10) }),
		});
	}
	return byHash;
}

/** The flags both numstat passes share. See {@link collectCommitFiles}. */
const NUMSTAT_ARGS = ["-c", "core.quotePath=false", "log", "--numstat", "--no-renames", `--format=${REC}%H`] as const;

/**
 * The history this machine owns: every local branch EXCEPT Jolli's own storage
 * refs (see `isJolliInternalRef` in `core/JolliRefs`), plus HEAD so a detached checkout
 * (mid-rebase, bisect) is not invisible. Deliberately NOT `--all` — see
 * {@link collectCommitEvents} for why remote-tracking refs and tags are out of
 * scope. Shared by the commit pass and the file-stats pass so the two can never
 * disagree about which commits exist.
 *
 * The orphan branch is an ordinary local branch holding one commit PER MEMORY,
 * so without the exclusion `--branches` imported all of them as the user's own
 * work: measured on this repo, 1800 of the 2468 stored commits were `Add
 * summary for …` about the other 668, and `jollimemory/summaries/v3` outranked
 * `main` in the branch attribution — every commit-derived number on the
 * dashboard reading ~73 % noise.
 *
 * `--exclude` is positional: it applies to the `--branches` that FOLLOWS it and
 * is consumed by it, so the order of these three entries is load-bearing. It
 * deliberately does not touch the explicit `HEAD`, which cannot be an orphan
 * ref — that branch is written by plumbing and never checked out.
 */
const LOCAL_HISTORY_ARGS = [JOLLI_REFS_EXCLUDE_GLOB, "--branches", "HEAD"] as const;

/**
 * Per-commit file lists over the same window {@link collectCommitEvents} logs.
 *
 * A SEPARATE `git log` pass, deliberately, rather than adding `--numstat` to the
 * existing one: numstat multiplies that command's output by the number of files
 * in history, and `execGit` caps stdout at 10 MB. Folded into one call, a large
 * repo would blow the buffer and lose EVERY commit event — trading the whole
 * dashboard for a nice-to-have. Split, the same failure costs only file detail
 * and the commits still land.
 *
 * `core.quotePath=false` keeps non-ASCII paths as raw UTF-8; git otherwise
 * escapes them into `\NNN` octal, which would store mangled paths for any repo
 * with CJK or accented filenames. `--no-renames` reports a rename as a delete
 * plus an add rather than git's `{old => new}` brace syntax — that syntax cannot
 * be parsed back into a path unambiguously, and for a churn ranking a rename
 * genuinely is two touched paths.
 */
async function collectCommitFiles(
	cwd: string,
	sinceArgs: ReadonlyArray<string>,
): Promise<Map<string, CommitFileChange[]>> {
	const result = await execGit([...NUMSTAT_ARGS, ...LOCAL_HISTORY_ARGS, ...sinceArgs], cwd);
	if (result.exitCode !== 0) {
		log.warn("git log --numstat failed for %s: %s", cwd, result.stderr.trim());
		return new Map();
	}
	return parseNumstatLog(result.stdout);
}

/** One `--no-walk` numstat call. `ok: false` means the batch produced nothing. */
async function numstatBatch(
	hashes: ReadonlyArray<string>,
	cwd: string,
): Promise<{ readonly ok: boolean; readonly files: Map<string, CommitFileChange[]> }> {
	const result = await execGit([...NUMSTAT_ARGS, "--no-walk", ...hashes], cwd);
	if (result.exitCode !== 0) {
		log.debug("numstat batch of %d failed for %s: %s", hashes.length, cwd, result.stderr.trim());
		return { ok: false, files: new Map() };
	}
	return { ok: true, files: parseNumstatLog(result.stdout) };
}

/**
 * How many extra numstat calls the bisect below may spend isolating a failing
 * commit. Bounded because the same failure shape covers both "one commit in this
 * batch is unreadable" and "git is broken in this repo": breadth-first at this
 * budget still salvages ~15/16 of a full {@link INCREMENTAL_NUMSTAT_LIMIT}
 * batch, while a repo that fails every call costs a flat 25 subprocesses instead
 * of the ~800 an unbounded bisect would spend on every sweep, forever.
 */
const NUMSTAT_BISECT_CALL_BUDGET = 24;

/** Splits a chunk in half; only ever called with `length > 1`. */
function halves(hashes: ReadonlyArray<string>): ReadonlyArray<string>[] {
	const mid = Math.ceil(hashes.length / 2);
	return [hashes.slice(0, mid), hashes.slice(mid)];
}

/**
 * File lists for an explicit set of hashes — the live post-commit path.
 *
 * `--no-walk` makes git report exactly the listed commits instead of their
 * ancestry, so this is one subprocess for the whole drained batch rather than
 * one per commit. A commit with no result gets no `files` key at all from the
 * caller (rather than an empty array), so a transient git failure cannot delete
 * rows a previous pass collected.
 *
 * **A failed batch is bisected, because the batch is the blast radius.** One
 * commit can fail the whole call on its own — a diff larger than `execGit`'s
 * 10 MB `maxBuffer` is the concrete case, and it is a property of that commit,
 * so it fails identically on every retry. Returning empty for the batch then
 * denies file rows to every OTHER commit in it, and since the next sweep asks
 * which commits have file rows, all of them come back — the same doomed batch,
 * plus whatever new commits joined it, on every sweep for the life of the
 * repository. Splitting isolates the poison into ever smaller chunks so the rest
 * of the batch is stored and stops being re-asked; the unresolvable commits
 * remain permanently retried, which is the honest cost of not being able to read
 * their diff, and is now a handful of hashes rather than the batch.
 *
 * Logged at WARN, not debug: the commits of a failed batch still land, so this
 * line is the only trace that their file detail did not.
 */
export async function collectFilesForCommits(
	hashes: ReadonlyArray<string>,
	cwd: string,
): Promise<Map<string, CommitFileChange[]>> {
	if (hashes.length === 0) return new Map();
	const first = await numstatBatch(hashes, cwd);
	if (first.ok) return first.files;
	log.warn("git log --numstat --no-walk failed for %s (%d commits) — bisecting", cwd, hashes.length);
	if (hashes.length === 1) return new Map();

	const files = new Map<string, CommitFileChange[]>();
	const queue: ReadonlyArray<string>[] = halves(hashes);
	let budget = NUMSTAT_BISECT_CALL_BUDGET;
	// Breadth-first: a shallow pass over the whole batch salvages more per call
	// than following one branch to a single hash, and it keeps the budget from
	// being spent entirely on the half that happens to be searched first.
	while (queue.length > 0 && budget > 0) {
		const chunk = queue.shift() as ReadonlyArray<string>;
		budget--;
		const batch = await numstatBatch(chunk, cwd);
		if (batch.ok) {
			for (const [hash, changes] of batch.files) files.set(hash, changes);
		} else if (chunk.length > 1) {
			queue.push(...halves(chunk));
		}
	}
	if (queue.length > 0) {
		const unresolved = queue.reduce((n, chunk) => n + chunk.length, 0);
		log.warn("numstat bisect budget spent for %s; %d commits keep no file rows this sweep", cwd, unresolved);
	}
	return files;
}

/**
 * Collects one `commit.created` per commit reachable from any local branch, with
 * the branch it was COMMITTED ON attached.
 *
 * **Attribution is a single recorded value, not a reachability set, and that is a
 * deliberate reversal.** This used to union a per-ref `git rev-list` over the 50
 * newest-committed branches. Two things were wrong with it. The window
 * (`--sort=-committerdate` + a cap) reshuffles whenever any branch gains a
 * commit, and `unchangedCommitEvent` compares `branches` for exact set equality —
 * so on a repo past the cap every commit the window reached was re-projected on
 * every pass and never converged (measured on a 350-branch repo: 11,953 commits
 * re-enqueued per shift, 24.6 MB of duplicate `events_raw` rows). And because the
 * field is replace-when-present, a branch falling out of the window DELETED its
 * rows, making stored attribution a moving target — under the one query that
 * reads it, per-branch token/cost. The recorded branch is a historical fact about
 * one commit, so it cannot reshuffle, and it is also the better answer for that
 * query: reachability counted every commit on `main` under every feature branch
 * based off it, which is why the reader needed an apportioning division at all.
 *
 * The cost is that "which branches can see this commit NOW" is no longer
 * answerable. That was checked against the question the dashboard actually asks
 * (cost per PR, cost per commit) and is not needed for either. `commit_branches`
 * and `branches` are retained, still written (one row per commit) and still read
 * by released clients — see the note on those tables in `SotSchema`.
 *
 * Both `git log` passes are scoped to {@link LOCAL_HISTORY_ARGS}. `--all` was
 * wrong here: it adds remote-tracking refs and tags, so a commit living only on a
 * colleague's fetched branch or an old tag was counted as this machine's work AND
 * displayed with no branch at all, because `refs/heads` could never explain where
 * it came from. Scoping to local branches keeps "in the dashboard" and
 * "attributable to a local branch" one statement.
 *
 * Summary-index metadata (recorded branch, diff stats) enriches commits the
 * memory pipeline saw; plain `git log` fields cover the rest.
 */
export class CommitCollectionFailedError extends Error {
	constructor(cwd: string, stderr: string) {
		super(`git log failed for ${cwd}: ${stderr}`);
		this.name = "CommitCollectionFailedError";
	}
}

export async function collectCommitEvents(opts: CollectCommitsOptions): Promise<ReadonlyArray<CommitCreatedEvent>> {
	const sinceArgs = opts.sinceMs ? [`--since=${new Date(opts.sinceMs).toISOString()}`] : [];
	const logResult = await execGit(
		// `%cI`, not `%aI`. The field this feeds is `committedAtMs`, and every
		// window this collector works in is a COMMITTER-date window: `--since` here
		// filters committer date, and the cursor is derived from the same. (It also
		// used to hold for the per-branch `rev-list` that computed reachability;
		// that pass is gone, but the rule is unchanged for the two that remain.)
		// Reading the author date instead
		// put every rebased or cherry-picked commit in a day bucket the filter had
		// already excluded — collected, then invisible in standup, and counted
		// under whichever day it was originally written rather than the day the
		// work actually landed here.
		// `%P` (parent hashes) rides LAST, after the subject: a subject cannot
		// contain SEP (it is a control character), so appending a field keeps every
		// earlier position stable. It exists only to recognise a merge commit — see
		// the numstat skip below.
		["log", ...LOCAL_HISTORY_ARGS, `--pretty=format:%H${SEP}%cI${SEP}%an${SEP}%ae${SEP}%s${SEP}%P`, ...sinceArgs],
		opts.cwd,
	);
	if (logResult.exitCode !== 0) {
		// THROW, do not return []. The caller prunes every stored commit this
		// collection did not list, so an empty array is a claim that the repo has no
		// commits — and `execGit` caps stdout at 10 MB and reports the overflow as
		// exit 1, which a large history reaches. Returning [] there wiped the whole
		// commit layer (with its CASCADEs) and then advanced the cursor, so the next
		// pass saw nothing to do and the blank stayed until an unrelated ref moved.
		throw new CommitCollectionFailedError(opts.cwd, logResult.stderr.trim());
	}

	// Summary-index enrichment, keyed by commit hash. Also the source of branch
	// attribution — see the emit below.
	//
	// The emit below keys ABSENT-vs-EMPTY on whether this LOADED — `index !== null`
	// — and not on whether the call threw. A throw is the rare shape: `getIndex`
	// resolves `null` for every genuine read failure it meets (`FolderStorage`
	// classifies EACCES/EIO to a warn + `null`, `readFileFromBranch` does the same
	// for a non-absence `git show` failure, and a malformed `index.json` is caught
	// at the `JSON.parse`), which is why its own contract says callers must read
	// null as "nothing to read", NOT as "nothing went wrong". Treating only the
	// throw as "could not tell" therefore left the failures it names on the
	// clear-the-rows path: one unreadable index emitted `branches: []` for every
	// commit and DELETED the repo's whole attribution in a single pass — and
	// because that pass is otherwise complete, the cursor advances and the next
	// sweep skips collection, so the blank outlives the failure.
	//
	// Folding "absent index" in with "unreadable index" is the safe direction, and
	// the reason is that the two cases the old comment separated are not
	// symmetrical. A repo with no index yet keeps whatever an older client's
	// reachability pass stored, which sounds like the stale-rows bug this change
	// exists to escape — but the ONE query that reads `commit_branches` inner-joins
	// `memories` (see `buildSeries`'s branch axis), so rows belonging to a repo with
	// no summaries are invisible, and they are replaced the moment an index appears:
	// a commit the index does not mention still gets `[]` below. Wiping live
	// attribution is visible immediately; keeping unreadable rows is not visible at
	// all.
	const index = await getIndex(opts.cwd, opts.storage).catch(() => null);
	const summaryByHash = new Map(index?.entries.map((e) => [e.commitHash, e]) ?? []);

	const logLines = logResult.stdout.split("\n").filter(Boolean);
	// **The one expensive step, and the only one made incremental.**
	//
	// `git log --numstat` over the whole history is where this collection's wall
	// clock goes (6-12 s per checkout, measured), and it is pure waste for a commit
	// whose file rows are already stored: a commit's diff is immutable, so a hash
	// already in the database can never need a re-scan. The commit LIST stays
	// whole-history on purpose, and now for exactly one reason: it is what the prune
	// is computed against, so narrowing it to the new arrivals would read as "every
	// older commit is gone". (It used to have a second reason — branch reachability
	// changed for OLD commits whenever any branch moved. Attribution is the
	// summary's recorded branch now, which never changes for a given hash, so that
	// half is void; the prune keeps the requirement alive by itself.)
	//
	// Omitting `files` for a known commit is not a downgrade: absent means "keep
	// what is stored" in the projection (the same contract a failed numstat pass
	// relies on), while an empty array would mean "this commit touches nothing".
	//
	// `knownHashes` is the set of commits whose file rows ARE STORED, not the set
	// of stored commits (see `commitsWithStoredFiles` in DbBackfill). A commit whose
	// numstat failed once therefore comes back on the NEXT sweep instead of never:
	// keying the skip off row existence made a single transient git failure a
	// permanent blank, since the only path that re-scanned everything was a
	// bootstrap and `bootstrap_state` never returns to that.
	//
	// Merge commits are excluded from the retry for the same reason they are not
	// evidence of a failure: `git log --numstat` shows no diff for a merge, so it
	// has no file rows to find and would otherwise be re-asked on every sweep
	// forever — and in a merge-heavy history enough of them to push past
	// INCREMENTAL_NUMSTAT_LIMIT and drag the whole-history scan back in. A
	// non-merge commit with genuinely zero files (`--allow-empty`) does get
	// re-asked, which is one hash in an argv list nobody notices.
	const newHashes = opts.knownHashes
		? logLines
				.map((line) => line.split(SEP))
				.filter((parts) => {
					const hash = parts[0];
					if (!hash || opts.knownHashes?.has(hash)) return false;
					// `%P` is the last field; more than one parent means a merge.
					return (parts[5] ?? "").trim().split(" ").filter(Boolean).length <= 1;
				})
				.map((parts) => parts[0] ?? "")
		: null;
	const filesByHash =
		newHashes !== null && newHashes.length <= INCREMENTAL_NUMSTAT_LIMIT
			? await collectFilesForCommits(newHashes, opts.cwd)
			: await collectCommitFiles(opts.cwd, sinceArgs);

	const events: CommitCreatedEvent[] = [];
	for (const line of logLines) {
		if (!line) continue;
		const [hash, dateIso, authorName, authorEmail, subject] = line.split(SEP);
		const committedAtMs = Date.parse(dateIso ?? "");
		if (!hash || !Number.isFinite(committedAtMs)) continue;
		const summary = summaryByHash.get(hash);
		events.push({
			type: "commit.created",
			repoIdentity: opts.repoIdentity,
			hash,
			committedAtMs,
			message: subject ?? "",
			...(authorName ? { authorName } : {}),
			...(authorEmail ? { authorEmail } : {}),
			// The summary's recorded branch is where the commit was actually made;
			// reachability can only say where it is visible NOW.
			...(summary?.branch ? { branch: summary.branch } : {}),
			// `branches` carries the SAME single fact, as a one-element list — not a
			// reachability union. It used to be the union of a per-branch `rev-list`
			// over the 50 newest-committed branches, and that window was the bug: it
			// reshuffles whenever any branch gains a commit, while
			// `unchangedCommitEvent` compares this field for exact set equality, so
			// every commit the window reached was re-projected on every pass, forever.
			// Measured on a 350-branch repo: 11,953 commits re-enqueued per shift and
			// 24.6 MB of duplicate `events_raw` rows, plus branch attribution that was
			// a moving target because the field is replace-when-present. The recorded
			// branch cannot reshuffle — it is a historical fact about one commit — so
			// the comparison converges after one projection.
			//
			// ABSENT vs EMPTY is load-bearing, and `[]` is the common case:
			//   - no index loaded   → absent → projection keeps whatever is stored
			//     (the "could not tell" answer — unreadable and not-present alike;
			//     see the `getIndex` call above for why those cannot be told apart)
			//   - index loaded, no recorded branch → `[]` → CLEARS the stored rows
			// Writing absent for the second would leave every such commit carrying its
			// old N-row reachability set forever, permanently mixed in with the 1-row
			// commits. Note `[]` is truthy, which is what makes `projectCommit`'s
			// `if (event.branches)` run its DELETE — do not "simplify" that to a
			// `.length` test, in either place.
			...(index ? { branches: summary?.branch ? [summary.branch] : [] } : {}),
			// Absent (not empty) when the numstat pass failed, so a transient git
			// failure leaves previously collected file rows in place.
			...(filesByHash.has(hash) ? { files: filesByHash.get(hash) } : {}),
			...(summary?.diffStats
				? {
						filesChanged: summary.diffStats.filesChanged,
						insertions: summary.diffStats.insertions,
						deletions: summary.diffStats.deletions,
					}
				: {}),
		});
	}
	return events;
}

/**
 * Builds one `commit.summary` event from a stored commit summary (memory tier).
 *
 * The shared building block behind the bootstrap sweep and the live
 * QueueWorker path — the same summary imported later or written live must land
 * identically. `transcripts` maps transcript-file id → its stored sessions and
 * is what turns the summary's transcript ids into exact session↔commit links;
 * pass an empty map to skip link derivation.
 *
 * Insights honesty: today's summary schema records `decisions` and `todo` per
 * topic, so those are the only kinds emitted — blockers/questions/gotchas stay
 * absent until the summarizer records them, rather than being guessed from
 * prose.
 */
export function summaryEventFromCommitSummary(
	repoIdentity: string,
	summary: CommitSummary,
	transcripts: ReadonlyMap<string, { readonly sessions: ReadonlyArray<StoredSessionLike> }>,
): CommitSummaryEvent | null {
	// PROVISIONAL. `summary.commitDate` is the AUTHOR date (`GitOps` reads it
	// with `%aI`), and this feeds a committer-date column. It is the best this
	// event can do — a stored summary carries no committer date — and it is
	// self-correcting: `projectCommit` overwrites `committed_at_ms` from the
	// `%cI` collection, and only a commit that never gets a `commit.created`
	// event (outside the `--since` window, or pruned from `git log`) keeps the
	// approximation. Queries that window memories therefore prefer the `commits`
	// row and fall back to this — see `buildMemoryCards`.
	const committedAtMs = Date.parse(summary.commitDate);
	if (!Number.isFinite(committedAtMs)) return null;

	const insights: CommitInsightItem[] = [];
	// No work category here: category belongs to a TOPIC, and the topics are
	// projected into `memory_topics` by the orphan import. Pages that aggregate
	// by category read that table; pages that want a commit-level label derive
	// the mode at query time, so nothing stored can fall behind a regeneration.
	for (const topic of collectDisplayTopics(summary)) {
		const decisions = topic.decisions?.trim();
		if (decisions) insights.push({ kind: "decision", text: decisions });
		const todo = topic.todo?.trim();
		if (todo) insights.push({ kind: "todo", text: todo });
	}

	const links: SessionLinkItem[] = [];
	const seen = new Set<string>();
	for (const id of getTranscriptIds(summary)) {
		const stored = transcripts.get(id);
		if (!stored) continue;
		for (const session of stored.sessions) {
			const source: TranscriptSource = session.source ?? "claude";
			const key = `${source}:${session.sessionId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const models = toStatsModelUsage(session.usageByModel ?? []);
			links.push({
				source,
				sessionId: session.sessionId,
				confidence: "exact",
				...(session.entries ? { messageCount: session.entries.length } : {}),
				...(models.length > 0 ? { models } : {}),
				// Presence-gated, not length-gated (unlike `models`): a stored `[]`
				// is the recorded fact "called no tools", and forwarding it lets the
				// projection replace a stale row instead of leaving it standing.
				...(session.toolUse ? { tools: session.toolUse } : {}),
			});
		}
	}
	mergeArchivedSkills(links, summary.skills ?? []);

	return {
		type: "commit.summary",
		repoIdentity,
		hash: summary.commitHash,
		committedAtMs,
		...(summary.branch ? { branch: summary.branch } : {}),
		message: summary.commitMessage.split("\n")[0],
		...(summary.conversationTurns != null ? { turns: summary.conversationTurns } : {}),
		...(summary.conversationTokens != null ? { tokens: summary.conversationTokens } : {}),
		...(summary.estimatedCostUsd != null ? { estCostUsd: summary.estimatedCostUsd } : {}),
		...(summary.ticketId ? { ticketId: summary.ticketId } : {}),
		insights,
		references: (summary.references ?? []).map((ref) => ({
			source: ref.source,
			nativeId: ref.nativeId,
			...(ref.title ? { title: ref.title } : {}),
			...(ref.url ? { url: ref.url } : {}),
		})),
		sessionLinks: links,
	};
}

/**
 * Folds `CommitSummary.skills` into the session links' `tools`, so a skill the
 * memory archived is visible in the dashboard's tool card.
 *
 * This is the ONE tool figure that can be recovered from summaries written
 * before `StoredSession.toolUse` existed: `SkillCommitRef` has carried
 * `invocationCount` (and, for sources that report usage, a `usageBySession`
 * split) all along, and nothing ever read it — grep `SotImport` for `skills`
 * and there is no projection. MCP and builtin calls have no such field and
 * cannot be recovered this way at all.
 *
 * ## Attribution: only when the owning session is unambiguous
 *
 * `invocationCount` is the ref's total for the COMMIT, while `session_tool_use`
 * is keyed per session. A ref is therefore attributed only when exactly one
 * session can own it — the single key of `usageBySession`, or failing that the
 * memory's single link of the ref's own source. Anything wider would have to
 * split a call count no recorded number supports: dividing it evenly invents a
 * share, and giving every candidate the full count multiplies one call into
 * several. Skipping is the honest option and costs nothing on real data (every
 * `usageBySession` observed has exactly one key).
 *
 * ## A transcript-derived count always wins
 *
 * A `toolUse` record was counted off the transcript's own `tool_use` blocks and
 * already carries `kind: "skill"` rows (`parseToolUse` re-attributes a `Skill`
 * call to `input.skill`). So this only FILLS GAPS: a `skill:<name>` already
 * present on the link is left exactly as it is, and archived refs cannot
 * double-count against it. Mutates `links` in place.
 */
export function mergeArchivedSkills(links: SessionLinkItem[], skills: ReadonlyArray<SkillCommitRef>): void {
	if (skills.length === 0 || links.length === 0) return;
	for (const ref of skills) {
		if (ref.invocationCount <= 0) continue;
		const owner = resolveSkillOwner(links, ref);
		if (!owner) continue;
		const index = links.indexOf(owner);
		const existing = owner.tools ?? [];
		// Identity is (kind, name) — the same key `session_tool_use` is keyed on.
		if (existing.some((t) => t.kind === "skill" && t.name === ref.skill)) continue;
		links[index] = {
			...owner,
			tools: [...existing, { name: ref.skill, kind: "skill", calls: ref.invocationCount }],
		};
	}
}

/** The one link that can own `ref`, or null when that is ambiguous (see {@link mergeArchivedSkills}). */
function resolveSkillOwner(links: ReadonlyArray<SessionLinkItem>, ref: SkillCommitRef): SessionLinkItem | null {
	const split = ref.usageBySession ? Object.keys(ref.usageBySession) : [];
	if (split.length > 0) {
		if (split.length > 1) {
			log.debug("skill %s spans %d sessions — no per-session call count to split", ref.skill, split.length);
			return null;
		}
		// `<source>:<sessionId>`; sessionId may itself contain colons, so split once.
		const separator = split[0].indexOf(":");
		if (separator < 0) return null;
		const source = split[0].slice(0, separator);
		const sessionId = split[0].slice(separator + 1);
		return links.find((l) => l.source === source && l.sessionId === sessionId) ?? null;
	}
	// No usage split (a source that reports none, e.g. codex): fall back to the
	// memory's own links, and only when the ref's source names exactly one.
	const candidates = links.filter((l) => l.source === ref.source);
	if (candidates.length !== 1) {
		log.debug("skill %s has %d candidate sessions and no usage split", ref.skill, candidates.length);
		return null;
	}
	return candidates[0];
}

/** The slice of `StoredSession` the link derivation needs (structural, for tests). */
export interface StoredSessionLike {
	readonly sessionId: string;
	readonly source?: TranscriptSource;
	readonly entries?: ReadonlyArray<unknown>;
	readonly usageByModel?: ReadonlyArray<ModelTokenUsage>;
	readonly toolUse?: ReadonlyArray<ToolCallCount>;
}

export interface CollectSummariesOptions {
	readonly repoIdentity: string;
	readonly cwd: string;
	/**
	 * Storage to read summaries from. Threading it is what keeps `resolveStorage`
	 * from falling back per read — that fallback warns every time, so a repo with
	 * 700 summaries printed 700 warnings on `jolli dashboard`. Omitted, the
	 * fallback still applies (the orphan branch), just noisily.
	 */
	readonly storage?: StorageProvider;
}

/** {@link collectSummaryEvents}' result: the events, plus whether the sweep saw everything. */
export interface SummaryCollection {
	readonly events: ReadonlyArray<CommitSummaryEvent>;
	/**
	 * False when the index was unreadable, or any single summary failed to read.
	 *
	 * The caller's cursor is the whole index's content hash, so advancing it
	 * after a partial sweep makes every LATER pass skip collection entirely —
	 * one transient `git show` failure would hide that memory from the dashboard
	 * permanently, until `index.json` itself happened to change. The commit tier
	 * has carried this guard (`collectionComplete`) from the start.
	 */
	readonly complete: boolean;
}

/**
 * Collects one `commit.summary` per ROOT summary in the store.
 *
 * Roots only: children of an amend/squash tree are superseded history whose
 * turns/tokens the root already aggregates — projecting them too would double
 * count every consolidated commit.
 */
export async function collectSummaryEvents(opts: CollectSummariesOptions): Promise<SummaryCollection> {
	const storage = opts.storage;
	const index = await getIndex(opts.cwd, storage).catch(() => null);
	if (!index) return { events: [], complete: false };
	const rootHashes = index.entries
		.filter((e) => e.parentCommitHash === null || e.parentCommitHash === undefined)
		.map((e) => e.commitHash);

	const events: CommitSummaryEvent[] = [];
	let complete = true;
	for (const hash of rootHashes) {
		try {
			const summary = await getSummary(hash, opts.cwd, storage);
			// A null read is "not there" per the StorageProvider contract, not a
			// failure — the index can name a summary a prune has since removed.
			if (!summary) continue;
			const transcriptIds = getTranscriptIds(summary);
			const transcripts =
				transcriptIds.length > 0
					? await readTranscriptsForCommits(transcriptIds, opts.cwd, storage)
					: new Map<string, { sessions: ReadonlyArray<StoredSessionLike> }>();
			const event = summaryEventFromCommitSummary(opts.repoIdentity, summary, transcripts);
			if (event) events.push(event);
		} catch (err) {
			complete = false;
			log.warn("summary %s unreadable for dashboard: %s", hash.slice(0, 8), errMsg(err));
		}
	}
	return { events, complete };
}

/** Collects the current worktree dirty-state, or null when unreadable. */
export async function collectWorktreeEvent(
	repoIdentity: string,
	cwd: string,
	now: () => number = Date.now,
): Promise<WorktreeStatusEvent | null> {
	let branch: string | undefined;
	try {
		const name = await getCurrentBranch(cwd);
		// `rev-parse --abbrev-ref HEAD` reports the literal string "HEAD" for a
		// detached HEAD; the schema's '' sentinel is how that is stored.
		branch = name === "HEAD" ? undefined : name;
	} catch (err) {
		log.debug("current branch unavailable for %s: %s", cwd, errMsg(err));
	}
	return observeWorktree(repoIdentity, cwd, branch, now);
}

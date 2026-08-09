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
 * Ceiling on per-ref `rev-list` fan-out. Reachability refresh unions rev-list
 * output per branch; a repo with hundreds of stale branches would turn that
 * into hundreds of subprocesses for data nobody scopes a dashboard to. The most
 * recently committed branches win.
 */
const MAX_BRANCHES = 50;

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
	 * Commit hashes whose file rows are already stored — their `--numstat` is
	 * skipped. See {@link INCREMENTAL_NUMSTAT_LIMIT} for the whole rationale;
	 * omit it (bootstrap) to scan every commit.
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
 * The history this machine owns: every local branch, plus HEAD so a detached
 * checkout (mid-rebase, bisect) is not invisible. Deliberately NOT `--all` —
 * see {@link collectCommitEvents} for why remote-tracking refs and tags are out
 * of scope. Shared by the commit pass and the file-stats pass so the two can
 * never disagree about which commits exist.
 */
const LOCAL_HISTORY_ARGS = ["--branches", "HEAD"] as const;

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

/**
 * File lists for an explicit set of hashes — the live post-commit path.
 *
 * `--no-walk` makes git report exactly the listed commits instead of their
 * ancestry, so this is one subprocess for the whole drained batch rather than
 * one per commit. Failure returns an empty map, and the caller then omits
 * `files` entirely rather than sending an empty array, so a transient git
 * failure cannot delete rows a previous pass collected.
 */
export async function collectFilesForCommits(
	hashes: ReadonlyArray<string>,
	cwd: string,
): Promise<Map<string, CommitFileChange[]>> {
	if (hashes.length === 0) return new Map();
	const result = await execGit([...NUMSTAT_ARGS, "--no-walk", ...hashes], cwd);
	if (result.exitCode !== 0) {
		log.debug("git log --numstat --no-walk failed for %s: %s", cwd, result.stderr.trim());
		return new Map();
	}
	return parseNumstatLog(result.stdout);
}

/**
 * Collects one `commit.created` per commit reachable from any local branch,
 * with the branch-reachability set attached.
 *
 * Reachability is computed by unioning per-ref `git rev-list` (bounded by
 * {@link MAX_BRANCHES}) — never `git branch --contains` per commit, which is
 * O(commits × branches) subprocess calls.
 *
 * Both passes are scoped to {@link LOCAL_HISTORY_ARGS}, the same ref set the
 * attribution loop below walks. `--all` was wrong on both ends of that: it adds
 * remote-tracking refs and tags, so a commit living only on a colleague's fetched
 * branch or an old tag was counted as this machine's work AND displayed with no
 * branch at all, because `refs/heads` could never explain where it came from.
 * Aligning them means "in the dashboard" and "attributable to a local branch"
 * are one statement. The one gap left is {@link MAX_BRANCHES}: a commit reachable
 * only from a branch past the cap is collected but unattributed — left absent, not
 * emitted as `branches: []`, so the replace-when-present projection keeps whatever
 * a fuller earlier pass stored instead of erasing it.
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
		// window this collector works in is a COMMITTER-date window: `--since`
		// here and on the per-branch `rev-list` below both filter committer date,
		// and the cursor is derived from the same. Reading the author date instead
		// put every rebased or cherry-picked commit in a day bucket the filter had
		// already excluded — collected, then invisible in standup, and counted
		// under whichever day it was originally written rather than the day the
		// work actually landed here.
		["log", ...LOCAL_HISTORY_ARGS, `--pretty=format:%H${SEP}%cI${SEP}%an${SEP}%ae${SEP}%s`, ...sinceArgs],
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

	// Branch reachability: newest-committed branches first, capped.
	const refsResult = await execGit(
		// One past the cap, so truncation is DETECTABLE rather than inferred from a
		// full page: `--count=${MAX_BRANCHES}` returning exactly that many is
		// indistinguishable from a repo with exactly that many branches.
		[
			"for-each-ref",
			"refs/heads",
			"--sort=-committerdate",
			"--format=%(refname:short)",
			`--count=${MAX_BRANCHES + 1}`,
		],
		opts.cwd,
	);
	// Tracked for the same reason `files` is (see below): `branches` is
	// REPLACE-when-present in the projection, so emitting a partial union is a
	// claim that the missing branches no longer reach the commit. A failed
	// `for-each-ref` would have emitted `[]` for every commit and wiped the
	// repo's whole branch attribution in one pass; a single branch that was
	// deleted or repacked between the ref list and its own `rev-list` (an
	// ordinary concurrent rebase) would silently have stripped just that one.
	// Incomplete means: emit nothing, keep what is stored.
	let branchScanComplete = refsResult.exitCode === 0;
	const listed = refsResult.exitCode === 0 ? refsResult.stdout.split("\n").filter(Boolean) : [];
	// A repo past {@link MAX_BRANCHES} is the documented reachability gap, but it
	// must not be expressed as the CLAIM `branches: []`. The union is
	// replace-when-present, so emitting an empty array for a commit that only the
	// branches past the cap reach would delete a correct stored attribution on
	// every pass. Truncated therefore behaves like a partially failed scan for the
	// commits nothing listed reaches — see the emit below — while the commits the
	// listed branches DO reach keep getting their (capped) attribution refreshed.
	const branchesTruncated = listed.length > MAX_BRANCHES;
	const branches = branchesTruncated ? listed.slice(0, MAX_BRANCHES) : listed;
	const branchesByHash = new Map<string, string[]>();
	for (const branch of branches) {
		const revs = await execGit(["rev-list", branch, ...sinceArgs], opts.cwd);
		if (revs.exitCode !== 0) {
			branchScanComplete = false;
			continue;
		}
		for (const hash of revs.stdout.split("\n")) {
			if (!hash) continue;
			const list = branchesByHash.get(hash);
			if (list) list.push(branch);
			else branchesByHash.set(hash, [branch]);
		}
	}

	if (!branchScanComplete) {
		log.warn("branch scan incomplete for %s -- leaving stored branch attribution untouched", opts.cwd);
	} else if (branchesTruncated) {
		log.warn(
			"branch list truncated at %d for %s -- commits reached only by older branches keep their stored attribution",
			MAX_BRANCHES,
			opts.cwd,
		);
	}

	// Summary-index enrichment, keyed by commit hash.
	const index = await getIndex(opts.cwd, opts.storage).catch(() => null);
	const summaryByHash = new Map(index?.entries.map((e) => [e.commitHash, e]) ?? []);

	const logLines = logResult.stdout.split("\n").filter(Boolean);
	// **The one expensive step, and the only one made incremental.**
	//
	// `git log --numstat` over the whole history is where this collection's wall
	// clock goes (6-12 s per checkout, measured), and it is pure waste for a commit
	// whose file rows are already stored: a commit's diff is immutable, so a hash
	// already in the database can never need a re-scan. Everything ELSE here stays
	// whole-history on purpose — the commit list is what the prune is computed
	// against, and branch reachability changes for OLD commits every time a branch
	// moves, so neither can be narrowed to the new arrivals.
	//
	// Omitting `files` for a known commit is not a downgrade: absent means "keep
	// what is stored" in the projection (the same contract a failed numstat pass
	// relies on), while an empty array would mean "this commit touches nothing".
	//
	// The one thing it gives up: a commit whose file rows were never stored (its
	// numstat failed once) is never revisited while it stays known. That is a
	// bounded, self-correcting gap — a bootstrap re-scan restores it — and paying
	// a full-history numstat on every launch to close it is the cost this exists
	// to remove.
	const newHashes = opts.knownHashes
		? logLines.map((line) => line.split(SEP)[0] ?? "").filter((hash) => hash && !opts.knownHashes?.has(hash))
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
			// Absent (not empty) when the scan above was incomplete — an empty
			// array here is the meaningful claim "no branch reaches this commit",
			// and it is only true when every local branch was actually walked. Under
			// truncation the same reasoning applies per commit: a hit is still a hit,
			// but "nothing reached it" may just mean the branch that does sits past
			// the cap, so that case falls back to leaving the stored value alone.
			...(branchScanComplete && (!branchesTruncated || branchesByHash.has(hash))
				? { branches: branchesByHash.get(hash) ?? [] }
				: {}),
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

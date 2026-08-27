/**
 * ProducerHooks — the live write side of the dashboard.
 *
 * Thin, failure-proof wrappers the hot-path producers call:
 *
 *   - StopHook (async: true)          → {@link recordSessionFromHook}
 *   - QueueWorker (detached)          → {@link recordCommitsFromWorker}
 *   - VS Code 60 s tick (in host)     → {@link recordSessionsFromTick}
 *
 * Every function here obeys the same three rules, because these run inside
 * git hooks and the editor:
 *
 *   1. **Never throw.** A dashboard write failure is a log line, not a broken
 *      commit or a dead agent hook. The data still lives in the git/summary
 *      sources of truth and the next `jolli dashboard` recovery imports it.
 *   2. **Degrade below the runtime floor.** On a Node without flag-free
 *      `node:sqlite` ({@link canUseDashboardDb}), skip the write silently —
 *      same reason, same safety net.
 *   3. **Stay off the blocking path.** These are called from the already
 *      detached QueueWorker, the `async: true` StopHook, and a timer tick —
 *      never from `postCommitEntry` or anything a user waits on.
 *
 * Repo identity resolution (two git subprocesses) is memoized per worktree for
 * the process lifetime — hooks are short-lived processes anyway, and the
 * extension host tick reuses one entry per workspace.
 */

import { dirname } from "node:path";
import { currentAgentSessionId } from "../core/AgentSessionEnv.js";
import { getCommitInfo, getCurrentBranch, getProjectRootDir } from "../core/GitOps.js";
import { getSummary, readTranscriptsForCommits } from "../core/SummaryStore.js";
import { getTranscriptIds } from "../core/SummaryTree.js";
import { createLogger, errMsg, isManuallyDisabled } from "../Logger.js";
import type { RecallOutcome, SessionInfo } from "../Types.js";
import {
	collectFilesForCommits,
	type SessionEventInfo,
	sessionEventFromInfo,
	summaryEventFromCommitSummary,
} from "./DashboardCollector.js";
import { canUseDashboardDb } from "./DashboardDb.js";
import type {
	CommitCreatedEvent,
	LookupObservedEvent,
	LookupSurface,
	ProducerKind,
	StatsEvent,
} from "./DashboardModel.js";
import { clampLookupQuery, normalizeLookupQuery } from "./LookupQuery.js";
import { ensureWorktreeListed, readRepoRegistry, registerRepo, resolveRepoIdentity } from "./RepoRegistry.js";
import { applyStatsEvents, observeWorktree } from "./StatsWriter.js";

const log = createLogger("DashboardProducer");

/** Per-process memo of cwd → repo identity (worktree-root anchored). */
const identityCache = new Map<string, string>();

/**
 * Resolves the repo identity and, on the first resolution in this process,
 * makes sure the repo is in the machine-level registry.
 *
 * The self-registration is what makes the dashboard see repos that were
 * enabled BEFORE the registry existed. Without it the registry only ever grows
 * on a fresh `jolli enable` or an explicit `jolli dashboard --cwd`, so every
 * already-enabled repo — i.e. every repo of every existing install — stays
 * invisible even while its hooks are actively writing sessions and commits to
 * this same database. Registering from the write path closes that gap with no
 * user action: work in a repo and it appears.
 *
 * Guarded on "not already known" rather than calling `registerRepo`
 * unconditionally: that helper REBUILDS the row, so a stray hook would restate the
 * display name and move `worktreeRoot` to whichever checkout happened to commit.
 * Only a genuinely missing entry is filled in. A known identity whose `worktrees`
 * list lacks THIS checkout (a second clone of the same remote) goes through the
 * union-only `ensureWorktreeListed` instead.
 *
 * Neither path can re-enable anything any more: the registry records membership
 * only, and the disable switch lives in each clone's `profile.json` (see
 * `listActiveRepos`). It used to be able to — `registerRepo` cleared a `disabledAt`
 * that a disable had stamped — which is the guard's original reason for existing.
 */
async function repoIdentityFor(cwd: string, configDir?: string): Promise<string> {
	const cached = identityCache.get(cwd);
	if (cached) return cached;
	const worktreeRoot = await getProjectRootDir(cwd);
	const { identity } = await resolveRepoIdentity(worktreeRoot);
	// Memoized only AFTER registration is attempted. Caching the identity first
	// short-circuits every later call in this process, so a registry write that
	// failed (locked file, transient IO) was never retried — permanently, in a
	// long-lived host like the VS Code extension. The identity resolution itself is
	// the cheap half; the registration is the part worth another attempt.
	let registrationSettled = false;
	try {
		const known = (await readRepoRegistry(configDir)).repos.find((r) => r.repoIdentity === identity);
		// Never resurrect a repo the user explicitly disabled — only fill a gap.
		if (!known) {
			await registerRepo({ cwd, ...(configDir ? { configDir } : {}) });
		} else {
			// The identity being known says nothing about THIS checkout: clones
			// share one identity, and a worktree the list never learns is invisible
			// to the cutover's source enumeration (never imported, never fenced).
			// Union-only, so it cannot undo a disable the way registerRepo would.
			const listed = known.worktrees && known.worktrees.length > 0 ? known.worktrees : [known.worktreeRoot];
			if (!listed.includes(worktreeRoot)) {
				await ensureWorktreeListed({ cwd, ...(configDir ? { configDir } : {}) });
			}
		}
		registrationSettled = true;
	} catch (err) {
		// The write below still works: StatsWriter seeds a placeholder repos row
		// from the identity alone, so data is never lost for want of a registry
		// entry. Only the multi-repo rebuild story degrades — and the next call
		// retries, because the memo below is skipped.
		log.debug("dashboard repo self-registration skipped for %s: %s", cwd, errMsg(err));
	}
	if (registrationSettled) identityCache.set(cwd, identity);
	return identity;
}

/**
 * Test seam: the config directory that holds the registry, derived from an
 * overridden `dbPath`.
 *
 * In production the dashboard DB and `dashboard-repos.json` are siblings in
 * `~/.jolli/jollimemory/`, so "the registry lives beside the DB" is the real
 * invariant — not a coincidence worth a second parameter. Deriving it means a
 * caller that redirects `dbPath` into a temp dir redirects ALL dashboard state
 * with it. That matters beyond tidiness: without it, a unit test exercising
 * these producers writes a junk entry into the developer's actual machine-level
 * registry (observed: a `/repo` row from a fixture cwd).
 */
function configDirFor(dbPath?: string): string | undefined {
	return dbPath ? dirname(dbPath) : undefined;
}

/** Shared guard + apply. Returns true when the write happened. */
async function safeApply(
	cwd: string,
	producerKind: ProducerKind,
	buildEvents: (repoIdentity: string) => Promise<ReadonlyArray<StatsEvent>>,
	dbPath?: string,
): Promise<boolean> {
	if (!canUseDashboardDb()) {
		log.debug("dashboard write skipped — Node %s lacks flag-free node:sqlite", process.versions.node);
		return false;
	}
	try {
		const repoIdentity = await repoIdentityFor(cwd, configDirFor(dbPath));
		const events = await buildEvents(repoIdentity);
		if (events.length === 0) return false;
		await applyStatsEvents(
			events.map((event) => ({ event, producerKind })),
			{ producerKind, ...(dbPath ? { dbPath } : {}) },
		);
		return true;
	} catch (err) {
		// Rule 1: a stats write must never take a producer down with it.
		log.warn("dashboard write failed (non-fatal): %s", errMsg(err));
		return false;
	}
}

/**
 * Records one just-ended agent session. Called by StopHook after it gathered the
 * host's session metadata; reads the transcript once for token usage when a path
 * is available (the hook already scans the same file for plan/reference discovery).
 */
export async function recordSessionFromHook(cwd: string, session: SessionEventInfo, dbPath?: string): Promise<boolean> {
	return safeApply(
		cwd,
		"stop-hook",
		async (repoIdentity) => {
			const event = await sessionEventFromInfo(repoIdentity, session);
			return event ? [event] : [];
		},
		dbPath,
	);
}

/**
 * Records one recall call, from the surface that served it.
 *
 * Called by the MCP `recall` tool and the `jolli recall` command right after
 * the answer is produced — the only moment the call exists. Everything else in
 * this module restates something durable (a commit, a session file, a summary)
 * and can be re-collected later; a recall cannot, which is why it is observed
 * at the edge rather than recovered from a transcript afterwards.
 *
 * It keeps the same three rules regardless: a failed write is a log line, a
 * Node below the `node:sqlite` floor skips silently, and neither can touch the
 * answer the user is waiting for. Which is also why the caller must not await
 * this on the response path — the receipt is worth strictly less than the
 * latency of the recall it describes.
 */
export async function recordRecallReceipt(
	cwd: string,
	outcome: RecallOutcome,
	surface: LookupSurface,
	options: { branch?: string; dbPath?: string } = {},
): Promise<boolean> {
	return recordLookupReceipt(
		cwd,
		{
			kind: "recall",
			surface,
			hit: outcome.hit,
			resultCount: outcome.commitCount,
			...(outcome.atMs !== undefined ? { atMs: outcome.atMs } : {}),
			...(options.branch ? { target: options.branch } : {}),
		},
		options.dbPath,
	);
}

/**
 * What a caller knows about the lookup it just answered.
 *
 * The `kind`-discriminated shape of {@link LookupObservedEvent} minus the three
 * fields this module fills in itself — the repo identity (resolved from `cwd`), the
 * session id (read from the environment) and the normalised query key (derived).
 * `atMs` is optional so a caller that has no clock of its own does not have to
 * invent one.
 */
export type LookupObservation = { readonly surface: LookupSurface; readonly atMs?: number } & (
	| { readonly kind: "search"; readonly query: string; readonly resultCount: number }
	| { readonly kind: "recall"; readonly target?: string; readonly hit: boolean; readonly resultCount: number }
);

/**
 * A search receipt's two query fields, both derived from ONE clamped string.
 *
 * ⚠ They are returned together rather than assigned separately because they must be
 * two spellings of the same query — the card prints `query` and groups on
 * `queryKey`, so a pair derived from different strings makes it list a term whose
 * tally cannot be found. Clamping at each assignment gives the same answer today and
 * is a shape in which they CAN disagree; this one is a shape in which they cannot.
 *
 * See {@link LOOKUP_QUERY_MAX} for why the bound exists at all — nothing else stands
 * between a pasted stack trace and a row this table's sync channel cannot send.
 */
function searchQueryFields(rawQuery: string): { readonly query: string; readonly queryKey: string } {
	const query = clampLookupQuery(rawQuery);
	return { query, queryKey: normalizeLookupQuery(query) };
}

/**
 * Records one lookup against this repo's memory, from the surface that served it.
 *
 * Called by the MCP `search`/`recall` tools and the `jolli search`/`jolli recall`
 * commands right after the answer is produced — the only moment the call exists.
 * Everything else in this module restates something durable (a commit, a session
 * file, a summary) and can be re-collected later; a lookup cannot, which is why it
 * is observed at the edge rather than recovered from a transcript afterwards.
 *
 * It keeps the same three rules regardless: a failed write is a log line, a Node
 * below the `node:sqlite` floor skips silently, and neither can touch the answer the
 * user is waiting for. Which is also why the caller must not await this on the
 * response path — the receipt is worth strictly less than the latency of the lookup
 * it describes.
 */
export async function recordLookupReceipt(
	cwd: string,
	observation: LookupObservation,
	dbPath?: string,
): Promise<boolean> {
	const atMs = observation.atMs ?? Date.now();
	const sessionId = currentAgentSessionId();
	return safeApply(
		cwd,
		// Every surface here IS the CLI binary — `jolli mcp` is one of its commands —
		// so they share the producer kind (and its write-lock budget). Which of them
		// answered is a fact about the lookup, and rides on the row's own `surface`
		// column.
		"cli",
		async (repoIdentity) => [
			{
				type: "lookup.observed",
				repoIdentity,
				atMs,
				...(sessionId ? { sessionId } : {}),
				...(observation.kind === "search"
					? {
							kind: "search" as const,
							surface: observation.surface,
							...searchQueryFields(observation.query),
							resultCount: observation.resultCount,
						}
					: {
							kind: "recall" as const,
							surface: observation.surface,
							hit: observation.hit,
							resultCount: observation.resultCount,
							...(observation.target ? { target: observation.target } : {}),
						}),
			} satisfies LookupObservedEvent,
		],
		dbPath,
	);
}

/**
 * Records the commits a QueueWorker drain just summarized, plus the current
 * worktree dirty-state.
 *
 * `branches` carries only the current branch: for a commit that was just
 * created that IS its reachability, and the next recovery pass replaces the
 * set with the full per-ref union anyway. Awaited by the worker after its
 * drain loop — a few git reads plus one short SQLite transaction, well inside
 * the worker's lock budget.
 */
export async function recordCommitsFromWorker(
	cwd: string,
	hashes: Iterable<string>,
	dbPath?: string,
): Promise<boolean> {
	const hashList = [...hashes];
	const applied = await safeApply(
		cwd,
		"queue-worker",
		async (repoIdentity) => {
			const branch = await getCurrentBranch(cwd).catch(() => undefined);
			const onBranch = branch && branch !== "HEAD" ? branch : undefined;
			// One numstat pass for the whole batch. Without it the file breakdown
			// would only ever exist for history a backfill happened to sweep, so
			// the very commits a user just made — the ones they are looking at —
			// would be the ones missing from "files agents keep touching".
			const filesByHash = await collectFilesForCommits(hashList, cwd);
			const events: StatsEvent[] = [];
			for (const hash of hashList) {
				try {
					const info = await getCommitInfo(hash, cwd);
					const committedAtMs = Date.parse(info.date);
					if (!Number.isFinite(committedAtMs)) continue;
					const event: CommitCreatedEvent = {
						type: "commit.created",
						repoIdentity,
						hash,
						committedAtMs,
						message: info.message.split("\n")[0],
						authorName: info.author,
						// Both identity fields, not just the name: the standup board's
						// "mine only" filter matches on EITHER, and a machine with
						// `user.name` unset (git still commits under the OS ident) would
						// otherwise have every commit made since the last backfill sweep
						// silently dropped from the board — with the chip still claiming
						// the rows are filtered to the user.
						...(info.authorEmail ? { authorEmail: info.authorEmail } : {}),
						...(onBranch ? { branch: onBranch, branches: [onBranch] } : {}),
						// Absent (not empty) when the numstat pass failed, so a
						// transient git error cannot delete rows an earlier pass
						// already collected.
						...(filesByHash.has(hash) ? { files: filesByHash.get(hash) } : {}),
					};
					events.push(event);
				} catch (err) {
					// A hash that vanished mid-drain (rebase raced us) is recovery's
					// problem, not a reason to drop the batch.
					log.debug("commit %s unreadable for dashboard: %s", hash.slice(0, 8), errMsg(err));
				}
				// Memory enrichment: the QueueWorker calls this right after storing
				// the commit's summary, so a store read here picks up the fresh
				// turns/tokens/cost/ticket/insights. Absent summary (LLM failed,
				// memory disabled) just means no commit.summary event — the plain
				// commit.created above already recorded the commit.
				try {
					const summary = await getSummary(hash, cwd);
					if (summary) {
						const ids = getTranscriptIds(summary);
						const transcripts = ids.length > 0 ? await readTranscriptsForCommits(ids, cwd) : new Map();
						const enriched = summaryEventFromCommitSummary(repoIdentity, summary, transcripts);
						if (enriched) events.push(enriched);
					}
				} catch (err) {
					log.debug("summary for %s unreadable for dashboard: %s", hash.slice(0, 8), errMsg(err));
				}
			}
			const worktree = await observeWorktree(repoIdentity, cwd, onBranch);
			if (worktree) events.push(worktree);
			return events;
		},
		dbPath,
	);
	// Memories go live at the same moment as the enrichment columns. This is
	// what unblocks A3b: the four commits projections (turns/tokens/cost/
	// ticket) and the insight/reference/link child tables exist because
	// `memories` used to refresh only at backfill — once THIS refresh runs on
	// every commit.summary, the memory tables are at least as fresh as the
	// copies and the dashboard reads can move over. For an un-cutover repo the
	// rows are a projection CACHE of the orphan (losable — hence the same
	// never-throw discipline as every producer); for a cut-over repo the real
	// write already landed through SqliteStorage and this converges on it.
	await refreshMemoryRows(cwd, hashList, dbPath);
	return applied;
}

/**
 * Re-projects a memory an IDE host just EDITED — detaching a conversation,
 * removing a plan/note/reference, deleting a topic, regenerating.
 *
 * Those edits rewrite `summaries/<hash>.json` (and delete `transcripts/<id>.json`)
 * through the StorageProvider, which on the default un-cutover route is the
 * orphan branch + Memory Bank folder and touches no SQLite at all. Nothing else
 * notices: `refreshMemoryRows` runs only behind {@link recordCommitsFromWorker},
 * i.e. at post-commit — so a memory edited from the webview kept serving its
 * pre-edit conversations and plans on the dashboard until the next commit for
 * that same hash (in practice: never) or a `jolli dashboard` recovery import.
 *
 * Deliberately called from the HOST edges (VS Code's `JolliMemoryBridge`, the
 * `store-summary` ide-bridge action) rather than from `storeSummary` itself:
 * this creates the dashboard DB and the repo registry on first use, which is
 * right for a user action but not for every unit test and every hook path that
 * happens to store a summary.
 */
export async function recordMemoryEdit(cwd: string, hashes: ReadonlyArray<string>, dbPath?: string): Promise<void> {
	await refreshMemoryRows(cwd, hashes, dbPath);
}

/** Upserts the just-stored summaries (and their transcripts) into the memory tables. */
async function refreshMemoryRows(cwd: string, hashes: ReadonlyArray<string>, dbPath?: string): Promise<void> {
	// The same opt-out gate `SqliteStorage.writeFiles` opens with. Not redundant:
	// this path calls `applyMemoryWrites` directly, so that check never runs —
	// and `recordMemoryEdit`'s two callers invoke it unconditionally after a
	// `storeSummary` that itself no-ops when disabled. What lands is the
	// unchanged stored summary, so nothing is corrupted, but a repo the user
	// turned off would still get its database created and its rows rewritten.
	if (isManuallyDisabled() || !canUseDashboardDb() || hashes.length === 0) return;
	try {
		const { createStorage } = await import("../core/StorageFactory.js");
		const { getTranscriptIds } = await import("../core/SummaryTree.js");
		const { applyMemoryWrites } = await import("./SotWrite.js");
		const { withDashboardDb } = await import("./DashboardDb.js");
		const storage = await createStorage(cwd, cwd);
		const identity = await repoIdentityFor(cwd, configDirFor(dbPath));
		const files: Array<{ path: string; content: string }> = [];
		for (const hash of hashes) {
			const content = await storage.readFile(`summaries/${hash}.json`);
			if (!content) continue; // no memory for this commit (LLM failed / disabled)
			files.push({ path: `summaries/${hash}.json`, content });
			// Ship the linked transcripts along so the link replacement inside
			// applyMemoryWrites does not drop them as dangling.
			for (const id of getTranscriptIds(JSON.parse(content))) {
				const transcript = await storage.readFile(`transcripts/${id}.json`);
				if (transcript) files.push({ path: `transcripts/${id}.json`, content: transcript });
			}
		}
		if (files.length === 0) return;
		await withDashboardDb(
			(db) => {
				const row = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(identity) as
					| { id: number }
					| undefined;
				// safeApply above ensured the repos row via commit.created; its
				// absence means the stats write itself failed — same non-fatal path.
				if (!row) return;
				applyMemoryWrites(db, row.id, files, Date.now());
			},
			dbPath ? { dbPath } : {},
		);
	} catch (err) {
		log.warn("memories refresh failed (non-fatal): %s", errMsg(err));
	}
}

/**
 * Records sessions surfaced by the editor's periodic conversations tick.
 *
 * The caller (VS Code's 60 s sidebar tick) hands over whatever the aggregator
 * saw; this function writes only the sessions whose `updatedAt` moved since
 * the last tick write — reading a transcript is the expensive part, and an idle
 * session's row is already correct. Worktree state is refreshed on every
 * effective write (it is one cheap git call).
 *
 * That gate is what keeps the tick affordable now that `sessionEventFromInfo` reads a
 * transcript for EVERY source rather than only Claude (it used to return early for the
 * other twelve, so this loop was near-free for them). Two things follow, and both are
 * accepted rather than pending — see that function's header for the full note:
 * the aggregator has already parsed the same files this tick to count messages, so the
 * read here is a second parse rather than a first; and `lastTickWrite` lives in this
 * process, so the first tick after a window reload has a watermark of 0 and pays for
 * every in-window session once. Do not "fix" either by reintroducing a source check —
 * the tool and skill signals for the non-Claude agents are exactly what that check hid.
 *
 * The watermark advances only **after** `safeApply` reports the write landed.
 * Moving it while building the batch would make a swallowed failure (the DB
 * busy — `vscode` has the tightest `busy_timeout` of any producer — a transient
 * git error) permanent: the sessions in the dropped batch are no longer "newer
 * than the last tick write", so no later tick retries them and the rows stay
 * missing until the session is touched again or a `jolli dashboard` recovery
 * pass reimports.
 */
const lastTickWrite = new Map<string, number>();

export async function recordSessionsFromTick(
	cwd: string,
	sessions: ReadonlyArray<SessionInfo>,
	dbPath?: string,
): Promise<boolean> {
	let candidateWatermark: number | undefined;
	const wrote = await safeApply(
		cwd,
		"vscode",
		async (repoIdentity) => {
			const events: StatsEvent[] = [];
			const since = lastTickWrite.get(cwd) ?? 0;
			let newestSeen = since;
			for (const s of sessions) {
				const updatedAtMs = Date.parse(s.updatedAt);
				if (!Number.isFinite(updatedAtMs) || updatedAtMs <= since) continue;
				const event = await sessionEventFromInfo(repoIdentity, s);
				// `sessionEventFromInfo` returns null ONLY when `s.updatedAt` fails the
				// same `Number.isFinite(Date.parse(...))` check this loop already made
				// two lines up (its only `return null`), so `event` is never falsy here
				// — unlike `recordSessionFromHook`, which has no such pre-filter.
				/* v8 ignore start */
				if (event) {
					/* v8 ignore stop */
					events.push(event);
					if (updatedAtMs > newestSeen) newestSeen = updatedAtMs;
				}
			}
			if (events.length === 0) return [];
			candidateWatermark = newestSeen;
			const branch = await getCurrentBranch(cwd).catch(() => undefined);
			const worktree = await observeWorktree(repoIdentity, cwd, branch === "HEAD" ? undefined : branch);
			if (worktree) events.push(worktree);
			return events;
		},
		dbPath,
	);
	if (wrote && candidateWatermark !== undefined) lastTickWrite.set(cwd, candidateWatermark);
	return wrote;
}

/** Test seam: clears the per-process memo state. */
export function resetProducerCaches(): void {
	identityCache.clear();
	lastTickWrite.clear();
}

/**
 * DbBackfill — one-time bootstrap and post-restart gap recovery for the
 * dashboard database.
 *
 * Both run in a command process (`jolli dashboard`, `jolli enable`) — never in
 * the read-only HTTP service — and both feed the same `StatsWriter`, so an
 * imported fact and a live-written fact are indistinguishable in the DB.
 *
 * The `db` prefix on every export is load-bearing, not decoration: `src/backfill/`
 * is an unrelated feature with the same name — the `jolli backfill` command, which
 * spends LLM budget generating summaries for historical commits. Nothing here
 * calls a model. The two used to collide outright (both declared a
 * `BackfillOptions`), and the ambiguity reached users: `jolli cutover` and
 * `jolli dashboard` print progress from THIS module, which reads as the LLM one.
 *
 * ## Correctness model (why cursors are not the mechanism)
 *
 * A high-water cursor only works for append-only, monotonically increasing
 * data. Git history is not that: rebase/squash rewrite it, branches get
 * deleted, and sessions update out of order. So the backbone is:
 *
 *   - adds/changes  → idempotent UPSERT (deterministic event ids)
 *   - deletes       → set reconciliation: prune rows not in the currently
 *                     reachable set (FK CASCADE removes children)
 *   - cursors       → a fast path ONLY: "HEAD unchanged → skip collection".
 *
 * A conservative cursor that re-scans too much is harmless (idempotent); a
 * cursor that skips too much is impossible because it is only consulted for
 * the skip decision, never as the sole selector of what to import.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { inflateSync } from "node:zlib";
import type { AlreadyCurrent } from "../core/DiskSessionScan.js";
import { execGit, getHeadHash, resolveWorktreeRoots } from "../core/GitOps.js";
import { GitRefStorage, resolveCommittish } from "../core/GitRefStorage.js";
import { isJolliInternalRef } from "../core/JolliRefs.js";
import { isSourceEnabled, loadConfig } from "../core/SessionTracker.js";
import { BACKFILL_SESSION_WINDOW_MS } from "../core/SessionWindow.js";
import type { StorageProvider } from "../core/StorageProvider.js";
import { getIndex, resolveReadStorage } from "../core/SummaryStore.js";
import type { SessionSourceDefinition } from "../core/sessions/SessionSourceDefinition.js";
import { DAEMON_RESCAN_SOURCES, SESSION_SOURCES } from "../core/sessions/SessionSources.js";
import { skillOutcomeConfidence } from "../core/skills/SkillOutcomeConfidence.js";
import { createLogger, errMsg, ORPHAN_BRANCH } from "../Logger.js";
import type { StoredTranscript, ToolCallCount, TranscriptSource } from "../Types.js";
import { bucketsFrom } from "./ActivityBuckets.js";
import {
	collectCommitEvents,
	// collectRepoGraph,  // parked with `repo_graphs` — see SotSchema
	collectSessionEvents,
	collectSummaryEvents,
	collectWorktreeEvent,
	type PreScannedSessions,
	type SessionLoader,
	type SessionPassCounts,
	type SessionPassKey,
	type SessionSourceCounts,
	sessionPassKey,
} from "./DashboardCollector.js";
import type { DashboardDbHandle } from "./DashboardDb.js";
import { getDashboardDbPath, inTransaction, withDashboardDb, withReadonlyDashboardDb } from "./DashboardDb.js";
import type {
	CommitCreatedEvent,
	CommitSummaryEvent,
	ProducerKind,
	SessionUpsertedEvent,
	StatsEvent,
	StatsEventEnvelope,
	StatsModelUsage,
} from "./DashboardModel.js";
import { sessionEventId } from "./DashboardModel.js";
import {
	existingWorktrees,
	hasLiveWorktree,
	isRepoDisabled,
	type RegisteredRepo,
	readRepoCutoverFence,
} from "./RepoRegistry.js";
import {
	countMemoriesAbsentFromListing,
	EMPTY_IMPORT_RESULT,
	hasCutoverRecord,
	importRepoMemory,
	resolveProtectNewerThanMs,
	type SotImportResult,
} from "./SotImport.js";
import { buildRollupQuietly, forgetRollupDays } from "./StatsRollup.js";
import { MEMORY_LANDED_AT_SQL } from "./StatsSeries.js";
import { applyToDb, countStuckEvents, pruneProjectedEvents } from "./StatsWriter.js"; // recordRepoGraph parked — see SotSchema

const log = createLogger("DbBackfill");

/**
 * Events per write transaction. Small on purpose: every batch takes SQLite's
 * single writer lock, and a hook or the extension tick may be waiting on it —
 * a whole-import transaction would starve them for the length of the import.
 */
const BATCH_SIZE = 200;

/** `ingest_cursors.source` keys. */
const CURSOR_GIT = "git-commits";
const CURSOR_SESSIONS = "sessions";
const CURSOR_SESSIONS_GENERATION = "sessions-read-generation";
const CURSOR_SUMMARIES = "summaries";
const CURSOR_SOT = "sot-import";

/**
 * What a full transcript read currently produces, as an opaque generation tag.
 *
 * This is HALF the receipt the per-session skip needs, and it is the half about builds:
 * a row's instant proves when a session last spoke, never that THIS build's reader
 * produced what the row holds. When transcript parsing learns something new — a tool
 * shape, a skill call, a token field — every session that has not spoken since keeps
 * whatever the old parser stored, forever, because its instant has not moved.
 *
 * So the skip is gated on this tag: a repo whose recorded tag differs from this value
 * gets ONE pass with no skipping at all, which re-reads every in-window transcript and
 * overwrites what the older reader stored (`projectSessionUpserted` assigns
 * `updated_at_ms` unconditionally, while the summary seed never updates it — so once a
 * real read lands it cannot be walked back). From the next pass on, the skip is
 * comparing values a full read produced, which is the only thing it was ever safe to
 * compare.
 *
 * The OTHER half is per row and is not this tag's job, because a per-repo tag cannot
 * express it: a commit summary seeds a session row stamped with the COMMIT's time,
 * which is necessarily later than the conversation's last turn, and a seed can land at
 * any moment — the summaries tier runs before the sessions tier in the same pass, and
 * the QueueWorker seeds straight from post-commit, long before any back-fill sees the
 * session. Such a row would read as "already current" forever. That case is answered
 * where it belongs, by {@link readKnownSessions} refusing to treat a commit-seeded row
 * as a receipt at all.
 *
 * BUMP THIS whenever a change alters what a full read yields. It costs one un-skipped
 * pass per repo and is the only way an existing database picks the improvement up.
 * Kept in `ingest_cursors`, which takes a free-form `source` key, precisely so this
 * needs no column and therefore no schema version bump — see DashboardDb's header for
 * why that matters across the three surfaces sharing this file.
 *
 * `2` — a full read now runs every registered extractor rather than only Claude's
 * tool tally (see `SessionSignals`). Two things it yields that `1` did not: skill
 * invocations entered by slash command, which no tool-call reader can see at any
 * source, and tool/MCP calls from the eight non-Claude sources that were returning
 * before their transcript was ever opened. Every session already in a database was
 * stored by the narrower read, and none of their instants will move on their own.
 *
 * `3` — Claude's tool reader now names a skill the way the skill scanner already did
 * (`toolUseResult.commandName`, the id the host launched) instead of the model's
 * requested `input.skill`. Under `2` a plugin-provided skill therefore landed as TWO
 * `session_tool_use` rows with the calls split between them, one of them named
 * something the user never typed. Re-reading is what removes the stale row: the
 * upsert deletes a session's tool rows before rewriting them, so nothing else can.
 *
 * `4` — Codex skill capture now reads the `<skill>` block Codex Desktop injects when a
 * skill is actually entered, not only the shell reads of a `SKILL.md` that the CLI
 * produces (see `CodexSkillScanner`). Measured on one real session that entered three
 * skills: the old read recorded NONE of them while storing its MCP and builtin calls
 * normally — so the gap is invisible in the row's own shape, and the mtime-based
 * instant cannot move on its own once the conversation has stopped. This is the case
 * the BUMP THIS paragraph above calls "improvement", and the bump is the only thing
 * that makes an existing database pick it up. A separate number from `3` deliberately:
 * that value has already shipped, so a database carrying it would otherwise never
 * re-read for this.
 *
 * A bump heals THIS store and only this store. `SkillUse` also reaches the
 * `plans.json` skill registry, whose high-water mark carries no generation and so
 * cannot be invalidated — an already-scanned Codex Desktop session therefore reads as
 * three skills here and zero in the SKILLS panel. That asymmetry is understood and
 * accepted; `scanSkillsWithCursor` carries the decision and is where to argue with it.
 *
 * `5` — a full read now yields `activityBuckets`, the quarter-hour presence rows behind
 * `session_activity`. That table arrived as its own schema entry, so an existing database
 * HAS it and simply holds nothing for any session read under `4`; measured on a real
 * machine, 1826 stored sessions produced 6 rows across 3 conversations — only the ones
 * that happened to speak after the new build landed. Nothing else can reach the rest:
 * the table is insert-only and deliberately ships no repair path (see
 * `SESSION_ACTIVITY_DDL`), and the live producers only touch a session whose instant
 * moved, which a finished conversation's never does.
 *
 * What this bump does NOT recover is accepted rather than deferred. Discovery is a
 * 7-day window (`BACKFILL_SESSION_WINDOW_MS`), so anything older is never re-opened and
 * stays without buckets for good — a permanent edge on the concurrency figure, which
 * reads recent rhythm and does not claim to answer for last month.
 *
 * `5` also covers the SCOPE change made in the same release: the session tier now asks
 * every linked worktree, not just the registered checkout (`sessionWorktreeRoots`). A
 * sibling worktree's sessions already had rows — the StopHook runs inside them and
 * resolves the identity from the remote — so they carry a read receipt and would be
 * skipped by `isAlreadyCurrent` forever, having never once been reached by a sweep.
 * One un-skipped pass is what lets the widened scope see them.
 *
 * `6` — a full read now attributes TOKENS to each skill bucket, not just calls
 * (`skillExtractor` runs `attributeSkillUsage` over the session plus its subagent
 * files, and `session_tool_use` gained the four columns to hold the result). This is
 * exactly the "a token field" case the paragraph above names: every session already
 * stored carries call counts with NULL tokens, and its instant cannot move on its own
 * once the conversation has stopped — so without this bump the columns would fill only
 * for conversations that happen to speak again, and every historical skill would read
 * as unattributable forever. Measured before the bump: a full recovery pass over a real
 * database left 0 of 113 skill rows with tokens, because every session was skipped as
 * already-current.
 *
 * `7` — a full read now records each skill entry INDIVIDUALLY into `skill_invocations`
 * (its outcome, entry mechanism, arguments and injected body size), alongside the
 * per-session aggregate that was already there. Structurally the same case as `6` one
 * step further: every session already stored carries a call COUNT with no rows behind
 * it, and a conversation that has stopped never moves its own instant again — so
 * without this bump the detail table would fill only for sessions that happen to speak
 * again, and every historical skill would have no per-entry record forever.
 *
 * Note this heals the DASHBOARD path only. The 30-second daemon re-scan tests this
 * cursor for PRESENCE rather than equality (see `dbRescanSessions` phase 1), so a bump
 * does not make it re-read history — deliberately, since an equality test there turned
 * every bump into a machine-wide off switch for that pass. Historical detail therefore
 * arrives on the next `jolli dashboard` run, not on the next tick.
 *
 * `8` — the per-entry rows of the one path that can report an OUTCOME now survive the
 * merge. `mergeToolCalls` folds the tool extractor's bucket and the skill extractor's
 * into one, and it did not carry `invocations` across: `parseToolUse` re-attributes a
 * `Skill` call to `input.skill`, so both produce a bucket for such a skill, and the
 * tool side — which runs first and has no per-entry list — won. Measured before the
 * fix: 72 detail rows on a real database and NOT ONE with `ok_confidence = 'observed'`,
 * because every observed entry arrives by the `Skill` tool. A generation-7 database has
 * those sessions logged as current, so only a bump re-reads them.
 *
 * `9` — Cursor. Three separate things a full read now yields that `8` did not, all
 * measured against 10 real transcripts. (a) MCP calls are classified as `mcp` with a
 * server: Cursor routes every one through a generic `CallMcpTool` whose `input`
 * carries `{server, toolName}`, and the old `mcp__`-prefix test filed all of them as
 * `builtin:CallMcpTool` with the server discarded — so no Cursor session in any
 * existing database has a single `mcp` row. (b) IDE conversations are read from the
 * `agent-transcripts` JSONL instead of the composer store, which is where their
 * `tool_use` blocks live at all; those sessions currently hold ZERO tool rows and a
 * message count short by roughly half. (c) skills are extracted for both Cursor
 * sources for the first time. None of those instants move on their own, so the
 * un-skipped pass this bump buys is the only way an existing database picks any of
 * it up.
 */
const SESSION_READ_GENERATION = "9";

/**
 * Content fingerprint of the summary index — the summaries cursor value.
 *
 * The orphan-branch index is small and rewritten wholesale on every store, so
 * "did anything change" is exactly "did its JSON change". A hash rather than a
 * tip commit because FolderStorage-backed repos have no orphan tip to point at.
 * Returns null when there is no index (nothing to sweep).
 */
async function summaryIndexFingerprint(cwd: string, storage: StorageProvider): Promise<string | null> {
	const index = await getIndex(cwd, storage).catch(() => null);
	if (!index) return null;
	return createHash("sha256").update(JSON.stringify(index)).digest("hex");
}

/**
 * Change signal for one checkout — its HEAD plus every local branch tip.
 *
 * HEAD alone is not enough, and the difference is not academic: deleting a
 * branch, rebasing it, or committing to it from another worktree moves no HEAD
 * that this pass can see. A HEAD-only cursor calls that "unchanged" and skips
 * the sweep entirely, so commits that are no longer reachable stay in the DB
 * (prune never runs) and branch reachability keeps whatever it was told last —
 * both indefinitely, until the checked-out branch happens to move for an
 * unrelated reason. Branch tips cover all three cases for one extra
 * `for-each-ref` per checkout.
 *
 * The tips are hashed rather than listed: a repo with hundreds of branches would
 * otherwise write a cursor value of unbounded length. HEAD stays in the clear as
 * the readable part of the value.
 *
 * A `for-each-ref` failure degrades to HEAD alone — a cursor that is too
 * conservative only costs an extra sweep, which is idempotent (see the module
 * header), whereas one that is too eager loses data.
 *
 * Jolli's own storage refs are excluded, by the same rule the collector applies
 * (see {@link isJolliInternalRef}) — and it is this signal, not the collector,
 * that made their inclusion visible. The orphan branch gains a commit on every
 * memory write, so hashing its tip meant the fingerprint moved whenever a
 * summary, a regenerate, a plan edit or a squash consolidation landed. It could
 * therefore never converge in a repo that is actually being used, and every
 * `jolli dashboard` launch re-swept git history — the sweep this cursor exists
 * to skip. Excluding them costs nothing in the direction that matters: those
 * commits are not collected either, so a tip this no longer watches cannot
 * change any row the sweep would have written.
 */
async function checkoutFingerprint(path: string): Promise<string | null> {
	const head = await getHeadHash(path).catch((err) => {
		log.warn("HEAD unreadable for %s: %s", path, errMsg(err));
		return null;
	});
	if (!head) return null;
	const refs = await execGit(["for-each-ref", "refs/heads", "--format=%(refname) %(objectname)"], path);
	if (refs.exitCode !== 0) {
		log.debug("branch tips unreadable for %s: %s", path, refs.stderr.trim());
		return head;
	}
	// Hashed over the FILTERED lines, joined back with the separator git used, so
	// the value stays a hash of the same shape of text — one `<ref> <oid>` per
	// line — as before.
	const tips = refs.stdout
		.split("\n")
		/* v8 ignore start -- `line` is a non-empty string here and `String.split` returns at least one element, so `line.split(" ")[0]` is always defined and the `?? ""` fallback is dead */
		.filter((line) => line && !isJolliInternalRef(line.split(" ")[0] ?? ""))
		/* v8 ignore stop */
		.join("\n");
	return `${head}+${createHash("sha256").update(tips).digest("hex")}`;
}

export interface DbBackfillOptions {
	readonly repo: RegisteredRepo;
	/** Test seam: path override for the dashboard DB. */
	readonly dbPath?: string;
	readonly producerKind?: ProducerKind;
	readonly now?: () => number;
	/** Test seams, forwarded to the collector. */
	readonly loadSessions?: SessionLoader;
	/**
	 * The RUN-wide machine-global scans, forwarded to the collector.
	 *
	 * Threaded down rather than scanned here because every one of these stores is
	 * machine-global: scanning them per repo re-reads the same records once per
	 * registered repo, which is the shape {@link dbBackfillRepos} exists to collapse.
	 * A source being absent here is a valid state — the collector then falls back to
	 * scanning that one per repo, exactly as before.
	 */
	readonly preScanned?: PreScannedSessions;
	/**
	 * The AI-agent toggles, forwarded to the collector — see
	 * {@link CollectSessionsOptions.isSourceAllowed}.
	 *
	 * Resolved once by {@link dbBackfillRepos} and threaded down, for the same reason
	 * {@link preScanned} is: the config is machine-global, so reading it per repo is
	 * re-reading one answer inside the loop this function's caller exists to hoist work
	 * out of. Absent means "every source", which is what a direct caller gets.
	 */
	readonly isSourceAllowed?: (source: TranscriptSource) => boolean;
	/** Test seam: read source for the SOT import; defaults to the orphan branch. */
	readonly storage?: StorageProvider;
	/**
	 * Progress for one repo. `memories` events come from the SOT import and are
	 * fired one per memory, inside its batch transaction — see
	 * {@link SotImportOptions.onProgress} for why the callback must not touch
	 * the database.
	 */
	readonly onProgress?: (progress: RepoProgress) => void;
}

/**
 * What a DB backfill is working through right now, for one repo.
 *
 * `done: 0` is a **phase-start marker**, emitted BEFORE the work begins. That
 * is the only kind of event the slow phases can offer: measured on a two-repo
 * machine, collecting git history took 22 s and 11 s while the memory
 * migration it precedes took about a second each. An event that fires when a
 * phase finishes cannot break the silence during it.
 */
export interface RepoProgress {
	readonly repoName: string;
	readonly kind: "commits" | "summaries" | "memories" | "sessions";
	readonly done: number;
	/** Absent on phase-start markers, and on a `memories` pass with no readable `index.json`. */
	readonly total?: number;
	/**
	 * Qualifier for a phase-start marker, e.g. which checkout is being scanned.
	 * A repo with two checkouts spends the git scan twice, and without this the
	 * two are one motionless line.
	 */
	readonly detail?: string;
	/**
	 * Set on the `sessions` phase-END marker, and only there: what each agent
	 * contributed to THIS repo.
	 *
	 * A phase-end marker exists for this tier alone because it is the only one whose
	 * interesting output is a breakdown rather than a count. Consumers that only render
	 * counts ignore the field; the one that renders it keys off its presence rather
	 * than off `done`, since a repo can legitimately end the tier having processed 0.
	 */
	readonly sessionBreakdown?: Readonly<Record<string, SessionSourceTotals>>;
	/**
	 * Set on a `commits` phase-start marker when this repo has never completed a
	 * bootstrap — i.e. when the sweep really will read the whole history.
	 *
	 * The caller's "this can take a few minutes" warning is gated on it. Since the
	 * sweep skips `--numstat` for commits already stored, a steady-state pass over
	 * a 2.5k-commit history is well under a second (measured 6.3 s → 0.44 s), and
	 * warning about minutes there is simply false.
	 */
	readonly firstRun?: boolean;
}

/** {@link RepoProgress} plus the repo's place in a multi-repo run. */
export interface DbBackfillProgress extends RepoProgress {
	/** 1-based. */
	readonly repoIndex: number;
	readonly repoTotal: number;
}

/**
 * One repo's session-tier outcome.
 *
 * `processed` and `skipped` do not have to add up to `discovered`, and the report
 * must not assume they do: a session with an unparseable instant is neither — it is
 * never skipped (being undateable is a reason to look at it) but it also produces no
 * event. So all three are carried rather than two plus arithmetic.
 */
export interface SessionTierSummary {
	/** Sessions the window turned up, after dedupe and before any skipping. */
	readonly discovered: number;
	/** Sessions actually read and projected this pass. */
	readonly processed: number;
	/** Sessions the database already held at or past their instant. */
	readonly skipped: number;
	/**
	 * All three totals split by agent, so the report can say which tool each number
	 * came from rather than only naming the tools that happened to be read.
	 *
	 * It carries the same three fields as the totals, and for the same reason they are
	 * carried rather than derived: an agent's `processed + skipped` need not equal its
	 * `discovered`. The split is keyed by every source the window turned up, including
	 * one whose sessions were all skipped — reporting "codex 51 found, 0 read" is the
	 * point of the breakdown, and dropping the key would spell it as "codex absent".
	 */
	readonly bySource: Readonly<Record<string, SessionSourceTotals>>;
	/**
	 * The same three populations IDENTIFIED rather than tallied, so a reader merging
	 * several repos can count conversations instead of counting claims.
	 *
	 * The counts above are per-repo facts and stay correct as such: this repo really
	 * did discover, read and skip that many. They are simply NOT ADDABLE across repos.
	 * One conversation is routinely claimed by more than one — Cursor's attribution is
	 * coarse by construction (its global store records no workspace for a composer, so
	 * every in-window composer belongs to every repo Cursor has a workspace for), and
	 * two clones of one project claim an identical set — so summing N repos' counts
	 * reports one conversation N times, and the inflation grows with how many repos are
	 * registered. Only the machine's owner sees it, which is what kept it invisible.
	 *
	 * Keys are {@link SessionPassKey}s, stable across repos, so a cross-repo reader
	 * unions them into a set first — see `printSessionSummary`.
	 */
	readonly keys: SessionTierKeys;
}

/** {@link SessionTierSummary}'s three populations, by {@link SessionPassKey}. */
export interface SessionTierKeys {
	readonly discovered: ReadonlyArray<SessionPassKey>;
	readonly processed: ReadonlyArray<SessionPassKey>;
	readonly skipped: ReadonlyArray<SessionPassKey>;
}

/** One agent's row in {@link SessionTierSummary.bySource}. */
export interface SessionSourceTotals extends SessionSourceCounts {
	/** Of this agent's discovered sessions, the ones read and projected this pass. */
	readonly processed: number;
}

export interface DbBackfillResult {
	/**
	 * 'bootstrapped' = full import ran; 'recovered' = incremental pass;
	 * 'skipped' = the repo errored out; 'unavailable' = no registered checkout
	 * exists on disk, so nothing was attempted; 'disabled' = the user has Jolli
	 * switched off for it, so only its paused state was projected (both in
	 * {@link dbBackfillRepos}).
	 *
	 * The last three are deliberately different words for different facts: a
	 * 'skipped' repo is a failure to report against the repo, an 'unavailable' one
	 * is a repo that is not here right now, and a 'disabled' one is the user's own
	 * decision. A caller that prints them the same way turns an unmounted network
	 * share into "migration failed" — and a caller that counts any of the three as
	 * WORKED reports imports that never happened.
	 */
	readonly mode: "bootstrapped" | "recovered" | "skipped" | "unavailable" | "disabled";
	readonly eventsApplied: number;
	/**
	 * What the session tier saw and did, for the caller's one-line report. Absent on
	 * a repo that never reached that tier.
	 *
	 * It exists because this tier had no user-visible output at all: the progress
	 * block's reveal rule deliberately excludes `sessions` (that tier used to
	 * re-project everything on every pass, so its progress lines said nothing), which
	 * left the whole 7-day back-fill invisible — a run that pulled in 18 previously
	 * unreachable conversations printed exactly what a run that did nothing printed.
	 * Reported here rather than through `onProgress` because it is a summary, known
	 * only once the tier is done.
	 */
	readonly sessions?: SessionTierSummary;
	/** Row counts from the v7 SOT import; absent when the repo was skipped. */
	readonly sotImport?: SotImportResult;
	/** Present on every result, so a caller can name the repo in its output. */
	readonly repoName: string;
	/**
	 * Why this repo was skipped. Set only on `mode: "skipped"` — the failure
	 * used to reach `log.error` and nothing else, which made a repo that failed
	 * to import indistinguishable, on screen, from one that had nothing to do.
	 */
	readonly error?: string;
}

/** Reads one repo's bootstrap state, defaulting to 'pending' for an unknown repo. */
function readBootstrapState(db: DashboardDbHandle, repoIdentity: string): string {
	const row = db.prepare("SELECT bootstrap_state FROM repos WHERE repo_identity = ?").get(repoIdentity) as
		| { bootstrap_state?: string }
		| undefined;
	/* v8 ignore start -- the only caller (dbBackfillRepo) reads this AFTER projecting repoEnabledEvent, so the row always exists, and bootstrap_state is `NOT NULL DEFAULT 'pending'`; both the missing-row and the `?? "pending"` fallbacks are unreachable */
	return row?.bootstrap_state ?? "pending";
	/* v8 ignore stop */
}

function readCursor(db: DashboardDbHandle, repoIdentity: string, source: string): string | undefined {
	const row = db
		.prepare(
			`SELECT c.cursor FROM ingest_cursors c JOIN repos r ON r.id = c.repo_id
			  WHERE r.repo_identity = ? AND c.source = ?`,
		)
		.get(repoIdentity, source) as { cursor?: string } | undefined;
	return row?.cursor;
}

function writeCursor(db: DashboardDbHandle, repoIdentity: string, source: string, cursor: string, nowMs: number): void {
	db.prepare(
		`INSERT INTO ingest_cursors (repo_id, source, cursor, updated_at_ms)
		 VALUES ((SELECT id FROM repos WHERE repo_identity = ?), ?, ?, ?)
		 ON CONFLICT(repo_id, source) DO UPDATE SET cursor = excluded.cursor, updated_at_ms = excluded.updated_at_ms`,
	).run(repoIdentity, source, cursor, nowMs);
}

/**
 * Every session this repo has a row for **that a transcript read produced**, keyed
 * `<source>:<sessionId>` and valued with the stored `updated_at_ms`.
 *
 * This is the whole mechanism behind the collector's `isAlreadyCurrent`, and it needs
 * no schema of its own: a `sessions` row written by a full read IS the receipt that
 * the session was processed, and it already records how far the processing got. The
 * three tables that look like better answers are not: `events_raw` deliberately has no
 * unique constraint and no index on `event_id` and is pruned once projected, so an
 * absent row does not mean "never processed"; `ingest_cursors` holds one high-water
 * value per repo, which an out-of-order update slips past; and `token_coverage` /
 * `message_count` are written with overlapping value ranges by both the live read and
 * the commit-seeded path, so neither can tell them apart. A column of its own would
 * work — appending a migration is legal and no build is refused over a version it does
 * not know (see DashboardDb's header) — but it would be a permanent, frozen schema
 * entry restating something the existing columns already answer exactly.
 *
 * ## The seeded-row exclusion, which is load-bearing rather than defensive
 *
 * Not every `sessions` row came from reading a transcript. `projectSummary` SEEDS one
 * from a commit summary's session links (the retention case: the agent's own store has
 * aged the conversation out and the memory pipeline is the only record left), stamped
 * with the COMMIT's time — necessarily later than the conversation's last turn. Taken
 * as a receipt, such a row skips the session's transcript on every pass from then on,
 * and PERMANENTLY: the seed's `ON CONFLICT` never rewrites `updated_at_ms`, so nothing
 * walks the claim back and the session keeps a row with no title, no start, no
 * duration, no tools and no skills while the sweep reports it as up to date.
 * {@link SESSION_READ_GENERATION} cannot cover this — a seed lands at any moment (the
 * QueueWorker writes one straight from post-commit, and the summaries tier writes one
 * earlier in this very pass), so there is no point at which one un-skipped pass makes
 * the remaining rows trustworthy.
 *
 * What separates the two writers is which COLUMNS they can fill. A commit summary
 * knows a session's identity, an instant and its token totals; `started_at_ms` and
 * `duration_ms` are derived from the transcript's own first and last entry, and the
 * seed writes neither on insert or on conflict. So either of them being present is
 * proof a read happened — which is why {@link projectSummary}'s seed must never start
 * writing one. The converse is a deliberate false negative: a read that yielded
 * neither (an empty or unreadable transcript) is re-read every pass, which costs one
 * open of a file with nothing in it and keeps the safe answer safe.
 *
 * ## `title` is NOT on that list, and must not be added to it
 *
 * It looks like a third receipt — the seed never writes one either — but it is the one
 * transcript-shaped column that survives a FAILED read.
 * `sessionEventFromInfo` resolves the title BEFORE it opens the transcript and, when
 * the read then throws, still returns that base event; `resolveSessionTitle` answers
 * from `SessionInfo.title` alone for every source whose discoverer carries a native
 * one (opencode, cursor, devin, cline, copilot, antigravity). So a store that was
 * momentarily locked (`SQLITE_BUSY` while the user's agent is running) writes a row
 * with a title and nothing else — and counting that as a receipt would strand the
 * session at exactly that half-built state: no message count, no duration, no tokens,
 * no tools, no skills, never re-read until the conversation gains a new turn.
 *
 * One indexed read: `repos.repo_identity` is UNIQUE and `ix_sessions_repo_time` leads
 * with `repo_id`.
 */
function readKnownSessions(db: DashboardDbHandle, repoIdentity: string): Map<string, number> {
	const rows = db
		.prepare(
			`SELECT s.source, s.session_id, s.updated_at_ms FROM sessions s
			   JOIN repos r ON r.id = s.repo_id
			  WHERE r.repo_identity = ?
			    AND (s.started_at_ms IS NOT NULL OR s.duration_ms IS NOT NULL)`,
		)
		.all(repoIdentity) as ReadonlyArray<{ source: string; session_id: string; updated_at_ms: number }>;
	const known = new Map<string, number>();
	for (const row of rows) known.set(`${row.source}:${row.session_id}`, row.updated_at_ms);
	return known;
}

/**
 * Turns one repo's stored instants into the collector's skip predicate.
 *
 * Extracted so the two callers cannot drift: `jolli dashboard` (via
 * {@link dbBackfillRepo}) and the global daemon (via {@link dbRescanSessions}) must
 * answer "have I already processed this session?" the same way, or a session the
 * timer considers current would be re-read by the next dashboard run and vice versa.
 * It is also the one place the comparison's direction is stated.
 */
function alreadyCurrentFrom(known: ReadonlyMap<string, number>): AlreadyCurrent {
	return (source: TranscriptSource, sessionId: string, updatedAtMs: number) => {
		const stored = known.get(`${source}:${sessionId}`);
		// `>=`, not `>`: an equal instant means a re-read would write back the row
		// already there, which is not worth the transcript parse.
		return stored !== undefined && stored >= updatedAtMs;
	};
}

/**
 * Latest OBSERVED mtime per session event, as epoch ms.
 *
 * The SEED for {@link SessionRescanOptions.emitted}, read ONCE per daemon process
 * rather than once per tick, which is the whole reason it is affordable:
 * `events_raw` carries no index on `event_id` — one existed and was removed for
 * costing a write per enqueue on the blocking commit path — so this is a full scan of
 * the largest table in the database. Once at startup is fine; every 30 s would not be.
 *
 * ## Why the mtime out of `data_json`, and never `received_at`
 *
 * The gate compares against MTIMES, so the seed has to be one. `received_at` is the
 * instant the row was WRITTEN, and every producer samples a session's mtime tens of
 * seconds before it inserts (a dashboard collect is a whole-repo git walk first), so a
 * write instant always sits at or AFTER the version it stands for. Seeding one stamps
 * anything appended inside that window as already-seen — and PERMANENTLY, which is the
 * part that makes it data loss rather than a delay: the gate then suppresses the very
 * read that would correct the entry, so no tick can overwrite it, and the next process
 * re-seeds the same row to the same wrong value. A conversation that grew during an
 * import and then stopped is invisible to this pass for as long as it stays in the
 * window, with no log line and no counter moving.
 *
 * `data_json` carries the producer's own observed value — the same fact the live path
 * records after each emit — so both halves of the map now hold one kind of thing, and
 * an eviction plus re-seed can no longer change what the gate means.
 *
 * ## Why the JSON is read in JS, and never by SQLite
 *
 * `json_type` / `json_extract` abort the WHOLE STATEMENT on the first document that is
 * not valid JSON — measured: `ERR_SQLITE_ERROR: malformed JSON`, no rows for any group,
 * not merely a NULL for the offending one. `events_raw.data_json` is the one column in
 * this schema with nothing validating it: `TEXT NOT NULL`, no CHECK and no STORED
 * generated column, deliberately, because it is the raw log written on the blocking
 * commit path. Every other `json_extract` consumer here reads a column that was
 * validated at INSERT; this one cannot be.
 *
 * And an unparseable row is a state the system deliberately PRODUCES and then keeps:
 * `drainPending` catches `JSON.parse` and parks the row `failed`, and the prune deletes
 * only `projected` rows. So a SQL-side parse would be a permanent, machine-wide off
 * switch for this whole feature — the seed throws, phase 1 rejects, the tick reports
 * `failed` at DEBUG, `seeded` never flips because it is set from a successful result,
 * and every later tick re-runs the same throwing statement. Guarding with
 * `json_valid(data_json)` does fix that, and costs 283 ms where this costs 31 ms
 * (80,000 rows / 4,000 sessions; the plain `MAX(received_at)` column read it replaced
 * was 21 ms). Parsing in JS is both the cheaper and the only per-row-recoverable form.
 *
 * ## Why the NEWEST row rather than the largest instant
 *
 * Step 1 asks a question SQLite can answer without opening a document — the highest
 * `seq` per `event_id`, `seq` being the insert order — and step 2 parses only those.
 * That is one document per session instead of one per row, which is where the 31 ms
 * comes from.
 *
 * The value it yields is a MEMBER of the group, so it is always at or below the largest
 * instant any producer recorded: the gate can never come out WIDER than the aggregate
 * would have made it, and the error direction is one redundant read. It is also exactly
 * what the live path records after an emit — the most recent emission's observed mtime —
 * so seed and live agree by construction rather than by coincidence.
 *
 * A row this cannot read is ABSENT from the result, never defaulted: no entry means no
 * gate, which costs one redundant read and cannot lose anything, whereas falling back
 * to `received_at` would keep the seeding defect alive on exactly the rows least likely
 * to be looked at. So an unparseable NEWEST row costs that one session its entry even
 * when an older row of its own is readable — the safe direction, and the reason nothing
 * tries to fall back to one.
 *
 * Every producer's rows count, not just the re-scan's. That is deliberate: a row the
 * VS Code tick or `jolli dashboard` wrote really did read this session's transcript at
 * that version, so honouring it saves a redundant read. There is no way to tell the
 * re-scan's rows apart anyway (it shares the `bootstrap` producer tag with the
 * back-fill, deliberately), so filtering would be a half-measure rather than a fix.
 *
 * ## `limit` bounds the ROWS RETURNED, newest first
 *
 * The caller holds the result in memory for the life of the process, so it owns a budget
 * and this has to honour it. Newest first, because a session whose row was written most
 * recently is the one most likely to be discovered again — and because an arbitrary
 * subset would make the gate's contents depend on SQLite's scan order. The `GROUP BY`
 * still touches every row (there is no `event_id` index, on purpose); what the limit
 * removes is the JSON parse per group and the unbounded map.
 */
function readEmittedFromLog(db: DashboardDbHandle, limit?: number): Map<string, number> {
	const rows = db
		.prepare(
			`SELECT e.event_id AS event_id, e.data_json AS data_json
			   FROM events_raw e
			   JOIN (SELECT event_id, MAX(seq) AS seq
			           FROM events_raw
			          WHERE type = 'session.upserted' AND event_id IS NOT NULL
			          GROUP BY event_id) newest
			     ON newest.seq = e.seq
			  ORDER BY newest.seq DESC${limit === undefined ? "" : " LIMIT ?"}`,
		)
		.all(...(limit === undefined ? [] : [limit])) as ReadonlyArray<{ event_id: string; data_json: string }>;
	const out = new Map<string, number>();
	for (const row of rows) {
		let updatedAtMs: unknown;
		try {
			updatedAtMs = (JSON.parse(row.data_json) as { updatedAtMs?: unknown } | null)?.updatedAtMs;
		} catch {
			// Per row, which is the entire point of parsing here: one document this cannot
			// read costs its own session a gate entry and leaves every other session's
			// intact. A throw out of this function kills re-scanning for the process.
			continue;
		}
		if (typeof updatedAtMs === "number" && Number.isFinite(updatedAtMs)) out.set(row.event_id, updatedAtMs);
	}
	return out;
}

/**
 * Commit hashes already stored for this repo — the set the prune reconciles
 * against.
 *
 * Deliberately NOT the set the `--numstat` skip is computed from: see
 * {@link commitsWithStoredFiles} for why "the row exists" and "its file rows
 * were collected" have to be two different questions.
 */
function storedCommitHashes(db: DashboardDbHandle, repoIdentity: string): Set<string> {
	const rows = db
		.prepare("SELECT c.hash FROM commits c JOIN repos r ON r.id = c.repo_id WHERE r.repo_identity = ?")
		.all(repoIdentity) as ReadonlyArray<{ hash: string }>;
	return new Set(rows.map((r) => r.hash));
}

/**
 * Commits whose FILE ROWS are stored — what `CollectCommitsOptions.knownHashes`
 * means, and the only sound basis for skipping a commit's `--numstat`.
 *
 * Keyed off `commit_files` rather than off `commits`, because the two diverge
 * exactly where it matters: `collectFilesForCommits` returns an empty map when
 * its `git log --numstat --no-walk` fails, and the commits of that batch are
 * inserted anyway (deliberately — the commit list is what the prune runs
 * against). Asking `commits` would then mark them known and skip their numstat
 * forever: the retry only ever came back on a bootstrap, and `bootstrap_state`
 * is `done` after the first sweep, so those file rows were gone until someone
 * rebuilt the database. Asking `commit_files` retries them on the next sweep,
 * which is the self-correction the whole-history scan used to provide for free.
 *
 * `EXISTS` rather than a `DISTINCT` join: one PK probe per commit against
 * `commit_files(commit_id, path)` instead of materializing every file row.
 */
function commitsWithStoredFiles(db: DashboardDbHandle, repoIdentity: string): Set<string> {
	const rows = db
		.prepare(
			`SELECT c.hash FROM commits c JOIN repos r ON r.id = c.repo_id
			  WHERE r.repo_identity = ? AND EXISTS (SELECT 1 FROM commit_files f WHERE f.commit_id = c.id)`,
		)
		.all(repoIdentity) as ReadonlyArray<{ hash: string }>;
	return new Set(rows.map((r) => r.hash));
}

/**
 * Prunes commit rows that are no longer reachable from any tracked ref — the
 * delete half of set reconciliation, run whenever a full commit collection has
 * the complete reachable set in hand. FK CASCADE removes branch links and
 * session links with the row.
 */
export function pruneUnreachableCommits(
	db: DashboardDbHandle,
	repoIdentity: string,
	reachable: ReadonlySet<string>,
): number {
	const stale = [...storedCommitHashes(db, repoIdentity)]
		.filter((hash) => !reachable.has(hash))
		.map((hash) => ({ hash }));
	if (stale.length === 0) return 0;
	// Read before deleting: the cached day a commit contributed to is derived
	// from its own timestamp, and once the row is gone there is nothing left to
	// ask. Staleness is otherwise detected from write stamps, which a deletion
	// leaves none of — so this is the one direction the cache has to be told
	// about rather than being able to work out.
	const staleDays = db
		.prepare(
			`SELECT committed_at_ms FROM commits
			  WHERE repo_id = (SELECT id FROM repos WHERE repo_identity = ?)
			    AND hash IN (${stale.map(() => "?").join(", ")})`,
		)
		.all(repoIdentity, ...stale.map((row) => row.hash)) as ReadonlyArray<{ committed_at_ms: number }>;
	// The commit rows are gone, but their memories survive (a rewritten commit's
	// row is a DUPLICATE of the surviving one, kept by design), so each of those
	// memories MOVES to another calendar day and the day it moves TO must be
	// forgotten as well — otherwise it keeps serving a number that omits the
	// memory, for ever, since an old day gets no further writes to rebuild it.
	//
	// ⚠ Asked through `MEMORY_LANDED_AT_SQL`, AFTER the delete, and never by
	// restating the rule here. It was restated — as `commit_date_ms`, on the
	// reasoning that the landing expression "falls back to `commit_date_ms`" once
	// the commit row is gone — and that drops the middle term: the real rule is
	// `COALESCE(cm.committed_at_ms, al.at_ms, m.commit_date_ms)`, and a PRUNE IS
	// THE ALIAS CASE. A rebased commit's memory lands on the aliasing commit's
	// `committed_at_ms`, while `commit_date_ms` is the AUTHOR date — up to 400 days
	// away in this repo's own rebase fixture. So the wrong day was forgotten and
	// the day that actually changed was not. Running the query after the delete is
	// what makes it answer the post-delete landing without this code having to know
	// which of the three terms wins.
	const repoRow = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(repoIdentity) as
		| { id?: number }
		| undefined;
	const repoId = repoRow?.id;
	const remove = db.prepare(
		"DELETE FROM commits WHERE repo_id = (SELECT id FROM repos WHERE repo_identity = ?) AND hash = ?",
	);
	inTransaction(db, () => {
		for (const row of stale) remove.run(repoIdentity, row.hash);
		const landedDays: number[] = [];
		/* v8 ignore start -- reaching this line requires `stale.length > 0`, and `storedCommitHashes` joins `commits` to `repos`, so the repo row exists and `repoId` is never undefined here */
		if (repoId !== undefined) {
			/* v8 ignore stop */
			const landedAt = db.prepare(MEMORY_LANDED_AT_SQL);
			for (const { hash } of stale) {
				const landed = landedAt.get(repoId, hash) as { at_ms: number | null } | undefined;
				if (landed?.at_ms != null) landedDays.push(landed.at_ms);
			}
		}
		// Both directions in one call: the day each memory STOPPED being counted on
		// is the pruned commit's own day, already in `staleDays`.
		forgetRollupDays(db, [...staleDays.map((row) => row.committed_at_ms), ...landedDays]);
	});
	log.info("pruned %d unreachable commits for %s", stale.length, repoIdentity);
	return stale.length;
}

/**
 * Materialise git-reachability onto `memories.reachable` for one repo, so the
 * coaching / memories feeds can filter in SQL instead of running
 * `git rev-list --branches` on every read (see {@link MEMORY_REACHABLE_DDL}).
 *
 * The counterpart to {@link pruneUnreachableCommits}: that one DELETES the
 * derived `commits` rows, but a memory's own row is kept by design (a rewritten
 * commit's memory is a duplicate of the surviving one, retained as content), so
 * the memory needs its own visibility flag. Both are fed the SAME reachable set
 * — the union across the repo's worktrees — so the two tiers can never disagree
 * about what a branch still carries.
 *
 * Only rows whose flag actually changes are written, so a settled repo is a pure
 * read and re-running the sweep touches nothing (the idempotence
 * {@link dbBackfillRepos} depends on). Returns how many rows flipped. Memories
 * are few per repo, so the reachable set — which can hold tens of thousands of
 * hashes — is consulted in JS rather than shipped into SQL as a giant `IN`.
 */
export function markMemoriesReachability(
	db: DashboardDbHandle,
	repoIdentity: string,
	reachable: ReadonlySet<string>,
): number {
	const repoRow = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(repoIdentity) as
		| { id?: number }
		| undefined;
	const repoId = repoRow?.id;
	// A repo with no row has no memories to mark; nothing to do.
	if (repoId === undefined) return 0;
	const rows = db
		.prepare("SELECT commit_hash, reachable FROM memories WHERE repo_id = ?")
		.all(repoId) as ReadonlyArray<{ commit_hash: string; reachable: number }>;
	const flips: Array<{ hash: string; want: number }> = [];
	for (const row of rows) {
		const want = reachable.has(row.commit_hash) ? 1 : 0;
		if (row.reachable !== want) flips.push({ hash: row.commit_hash, want });
	}
	if (flips.length === 0) return 0;
	const update = db.prepare("UPDATE memories SET reachable = ? WHERE repo_id = ? AND commit_hash = ?");
	inTransaction(db, () => {
		for (const flip of flips) update.run(flip.want, repoId, flip.hash);
	});
	log.info("marked %d memory reachability flips for %s", flips.length, repoIdentity);
	return flips.length;
}

/**
 * The commit-tier twin of {@link markMemoriesReachability}, feeding the stats and
 * standup feeds (see {@link COMMIT_REACHABLE_DDL}). Same shape — flip only the
 * rows that change, idempotent — over `commits` instead of `memories`.
 *
 * In a full sweep this runs AFTER {@link pruneUnreachableCommits} has already
 * DELETED the unreachable rows, so it only heals any stale `0` left on a now-
 * reachable commit; the reconcile daemon, which does not prune, is what actually
 * marks a commit orphaned since the last sweep. A commit is one row per
 * `(repo_id, hash)`, so the update targets exactly one.
 */
export function markCommitsReachability(
	db: DashboardDbHandle,
	repoIdentity: string,
	reachable: ReadonlySet<string>,
): number {
	const repoRow = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(repoIdentity) as
		| { id?: number }
		| undefined;
	const repoId = repoRow?.id;
	if (repoId === undefined) return 0;
	const rows = db.prepare("SELECT hash, reachable FROM commits WHERE repo_id = ?").all(repoId) as ReadonlyArray<{
		hash: string;
		reachable: number;
	}>;
	const flips: Array<{ hash: string; want: number }> = [];
	for (const row of rows) {
		const want = reachable.has(row.hash) ? 1 : 0;
		if (row.reachable !== want) flips.push({ hash: row.hash, want });
	}
	if (flips.length === 0) return 0;
	const update = db.prepare("UPDATE commits SET reachable = ? WHERE repo_id = ? AND hash = ?");
	inTransaction(db, () => {
		for (const flip of flips) update.run(flip.want, repoId, flip.hash);
	});
	log.info("marked %d commit reachability flips for %s", flips.length, repoIdentity);
	return flips.length;
}

/**
 * The commit rows this repo already has, in the shape {@link unchangedCommitEvent}
 * compares against — one query for the columns, one for the branch sets.
 */
function storedCommitRows(
	db: DashboardDbHandle,
	repoIdentity: string,
): Map<string, { row: Record<string, unknown>; branches: Set<string> }> {
	const rows = db
		.prepare(
			`SELECT c.id, c.hash, c.branch, c.message, c.author_name, c.author_email, c.committed_at_ms,
			        c.files_changed, c.insertions, c.deletions
			   FROM commits c JOIN repos r ON r.id = c.repo_id
			  WHERE r.repo_identity = ?`,
		)
		.all(repoIdentity) as ReadonlyArray<Record<string, unknown> & { id: number; hash: string }>;
	const byId = new Map<number, { row: Record<string, unknown>; branches: Set<string> }>();
	const byHash = new Map<string, { row: Record<string, unknown>; branches: Set<string> }>();
	for (const row of rows) {
		const entry = { row, branches: new Set<string>() };
		byId.set(row.id, entry);
		byHash.set(row.hash, entry);
	}
	const links = db
		.prepare(
			`SELECT cb.commit_id, b.name
			   FROM commit_branches cb
			   JOIN branches b ON b.id = cb.branch_id
			   JOIN repos r    ON r.id = b.repo_id
			  WHERE r.repo_identity = ?`,
		)
		.all(repoIdentity) as ReadonlyArray<{ commit_id: number; name: string }>;
	for (const link of links) byId.get(link.commit_id)?.branches.add(link.name);
	return byHash;
}

/**
 * True when projecting `event` would write nothing new.
 *
 * **This is what makes a routine sweep cheap.** The collection has to produce an
 * event for EVERY reachable commit — that list is what the prune is computed
 * against, and branch reachability changes for old commits whenever a branch
 * moves — but on a normal day only the handful of commits on the branch being
 * worked on have actually changed. Projecting the other 2,450 re-ran an UPSERT,
 * a DELETE and a re-INSERT per commit to arrive at the bytes already there.
 *
 * The comparison MIRRORS {@link projectCommit}'s write, and has to stay in step
 * with it — a column added there without a case here would silently stop being
 * updated on any commit that matched on the others:
 *
 *  - The nullable columns are written with `COALESCE(excluded.x, commits.x)`, so
 *    an ABSENT value on the event cannot change anything and is not a difference.
 *    A present one must equal what is stored.
 *  - `committed_at_ms` is written unconditionally, so it is compared even when
 *    every other field matches.
 *  - `branches` is replace-when-present, so a present set must match exactly;
 *    absent (no summary index was loaded, whether unreadable or not yet written)
 *    means "leave the rows alone".
 *  - `files` present is never skipped. It is replace-when-present too, and the
 *    stored file rows are not read here — a commit whose files this pass actually
 *    scanned is by construction a new one, so this costs nothing in practice.
 *
 * **Why this function converges, and why it did not used to.** Nothing here was
 * changed to fix the churn — the fix was making its INPUT stable. Every field
 * compared above is immutable for a given hash, and `branches` now carries only
 * the commit's recorded branch, which is a historical fact and equally immutable.
 * So a commit is projected once and then judged unchanged forever. Previously
 * `branches` was a reachability union over the 50 newest-committed branches, and
 * that window reshuffled whenever ANY branch gained a commit: exact set equality
 * then failed on every pass, re-enqueueing every commit the window reached
 * (measured: 11,953 per shift on a 350-branch repo). The lesson generalises — if
 * a `slice(0, N)` result feeds an idempotency comparison, ask whether the window
 * is stable. `files` was always the right shape here for the same reason: its skip
 * is keyed on whether `commit_files` rows EXIST (monotonic state), not on
 * comparing content.
 */
function unchangedCommitEvent(
	event: CommitCreatedEvent,
	stored: { row: Record<string, unknown>; branches: Set<string> } | undefined,
): boolean {
	if (!stored) return false;
	if (event.files) return false;
	const { row, branches } = stored;
	if (row.committed_at_ms !== event.committedAtMs) return false;
	const sameNullable = (column: string, value: string | number | undefined): boolean =>
		value === undefined || row[column] === value;
	if (!sameNullable("branch", event.branch)) return false;
	if (!sameNullable("message", event.message)) return false;
	if (!sameNullable("author_name", event.authorName)) return false;
	if (!sameNullable("author_email", event.authorEmail)) return false;
	if (!sameNullable("files_changed", event.filesChanged)) return false;
	if (!sameNullable("insertions", event.insertions)) return false;
	if (!sameNullable("deletions", event.deletions)) return false;
	if (event.branches) {
		if (event.branches.length !== branches.size) return false;
		for (const branch of event.branches) if (!branches.has(branch)) return false;
	}
	return true;
}

/**
 * Session rows this repo already has, keyed `<source>\0<sessionId>` → the row's
 * `token_coverage`.
 *
 * The one thing {@link unchangedSummaryEvent} cannot answer from the commits
 * side: a summary's session links SEED rows, and whether that seed is a no-op
 * depends on state in `sessions`, not on the summary.
 */
function storedSessionCoverage(db: DashboardDbHandle, repoIdentity: string): Map<string, string> {
	const rows = db
		.prepare(
			`SELECT s.source, s.session_id, s.token_coverage
			   FROM sessions s JOIN repos r ON r.id = s.repo_id
			  WHERE r.repo_identity = ?`,
		)
		.all(repoIdentity) as ReadonlyArray<{ source: string; session_id: string; token_coverage: string }>;
	return new Map(rows.map((r) => [`${r.source}\0${r.session_id}`, r.token_coverage]));
}

/**
 * True when projecting `event` would write nothing new.
 *
 * The memory tier's counterpart to {@link unchangedCommitEvent}, and it exists
 * for the same reason — with the asymmetry that made it necessary. The commit
 * tier's gate is per-checkout (HEAD plus the ref list), so an ordinary pass
 * usually skips collection outright; the summary gate is the index's CONTENT
 * HASH, which moves the moment any one memory is written, and then re-collects
 * the WHOLE set. So on a repo being actively developed the gate is open on
 * essentially every pass and every stored summary was re-logged and re-projected
 * — measured at 219 events per `jolli dashboard` run, every copy byte-identical
 * (JOLLI-2224). The redo is idempotent in SQL and free in nothing else: it
 * appends a write-ahead row per event and re-runs the projection's writes.
 *
 * The index hash cannot be narrowed to fix this (consolidation folds children
 * into new roots, so per-entry cursors genuinely cannot work) — which is exactly
 * why the answer is the same one the commit tier uses: collect everything,
 * compare before projecting.
 *
 * MIRRORS {@link projectCommitSummary}, which writes THREE things and nothing
 * else — the memory rows belong to the orphan import, not to this projection:
 *
 *  - The `commits` row. Its nullable columns are written `COALESCE(excluded.x,
 *    commits.x)`, so an ABSENT value cannot change anything; a present one must
 *    equal what is stored. `committed_at_ms` is deliberately NOT compared: the
 *    conflict clause does not update it, so it is set on insert and never again.
 *  - `commit_branches`, replace-when-present with exactly ONE branch — so a
 *    present `branch` must already be the whole stored set. Absent leaves the
 *    rows alone and is therefore not a difference (see `projectCommitSummary`
 *    for why only `commit.created` may claim "no branch").
 *  - The `sessions` seed. This is the half a commits-only comparison would get
 *    wrong: a session older than the agents' own retention exists nowhere but in
 *    these links, so skipping an event whose link has no row loses it silently.
 *    The seed is a no-op only when the row already exists AND this link cannot
 *    upgrade it — i.e. the link carries no models, or the row is already past
 *    `sessions-only`.
 *
 * `commitPruned` is what stops the two tiers from ping-ponging. This projection
 * CREATES the `commits` row when none exists, and `pruneUnreachableCommits`
 * deletes it again on the next pass whenever git can no longer reach the hash —
 * a rebased or squashed-away commit whose memory legitimately survives. Neither
 * tier is wrong on its own, so the loop never converged: 74 events per run,
 * forever. When the caller KNOWS the hash is unreachable, the row this event
 * would create is one the prune has already removed in that same pass, so only
 * the session seeding is left to decide the answer — which is why a missing row
 * stops being an automatic "must project" and the commits comparisons are
 * skipped rather than failed.
 *
 * The caller may only claim that from a COMPLETE collection: it runs before this
 * tier and would have collected the commit if git still had it, so within such a
 * pass "no row" and "no commit" are the same statement. With no reachable set —
 * a failed read, or a cursor-skipped commit tier, in BOTH of which nothing was
 * pruned either — a missing row is read the old way, because a summary really
 * can arrive before its commit is swept.
 */
function unchangedSummaryEvent(
	event: CommitSummaryEvent,
	stored: { row: Record<string, unknown>; branches: Set<string> } | undefined,
	sessionCoverage: ReadonlyMap<string, string>,
	commitPruned: boolean,
): boolean {
	if (!stored && !commitPruned) return false;
	if (stored) {
		const { row, branches } = stored;
		if (event.branch !== undefined && row.branch !== event.branch) return false;
		if (event.message !== undefined && row.message !== event.message) return false;
		if (event.branch !== undefined && (branches.size !== 1 || !branches.has(event.branch))) return false;
	}
	for (const link of event.sessionLinks ?? []) {
		const coverage = sessionCoverage.get(`${link.source}\0${link.sessionId}`);
		if (coverage === undefined) return false;
		if (coverage === "sessions-only" && (link.models ?? []).length > 0) return false;
	}
	return true;
}

/**
 * The `sessions` columns `projectSession` writes with `COALESCE(excluded.x,
 * sessions.x)`, paired with the event field each is written from — one table
 * rather than six near-identical comparisons, so adding a column to that
 * conflict clause is one line here and cannot be half-done.
 */
const SESSION_COALESCED_COLUMNS: ReadonlyArray<
	readonly [string, (event: SessionUpsertedEvent) => string | number | undefined]
> = [
	["title", (e) => e.title],
	["started_at_ms", (e) => e.startedAtMs],
	["message_count", (e) => e.messageCount],
	["duration_ms", (e) => e.durationMs],
	["prices_as_of", (e) => e.pricesAsOf],
];

/** A `session_model_usage` row, in the shape {@link sameModelSplit} compares. */
interface StoredModelRow {
	readonly input: number;
	readonly output: number;
	readonly cached: number;
	readonly cost: number | null;
}

/**
 * A `session_tool_use` row, in the shape {@link sameToolSet} compares.
 *
 * The token fields are here because a re-read that differs ONLY in them is a real
 * write — and one that this comparison silently threw away. Measured: after skill
 * token attribution landed, a full recovery pass over a real database left 0 of 113
 * skill rows with tokens, because every session's call counts were unchanged and the
 * event was reported identical. A column the writer persists but this shape omits is
 * a column that can never be back-filled.
 */
interface StoredToolRow {
	readonly server: string | null;
	readonly calls: number;
	readonly lastCallAtMs: number | null;
	readonly inputTokens: number | null;
	readonly outputTokens: number | null;
	readonly cachedTokens: number | null;
	readonly usageConfidence: string | null;
	readonly plugin: string | null;
}

/**
 * A `skill_invocations` row, in the shape {@link sameSkillInvocations} compares.
 *
 * Here for exactly the reason the token fields are on {@link StoredToolRow}: this is
 * a third child table the projection writes, so a re-read that differs only in it is
 * a real write — and one this comparison would otherwise report as identical.
 * Measured when the table shipped: a full pass over a real database left 0 rows in
 * it, because every session's call counts were unchanged and the event was called
 * identical. Same failure, one table further along.
 */
interface StoredInvocationRow {
	readonly ok: number;
	readonly okConfidence: string;
	readonly detection: string | null;
	readonly entryPath: string | null;
	readonly args: string | null;
	readonly bodyChars: number | null;
}

/**
 * One session as it is currently stored: its own row plus ALL FOUR child tables.
 *
 * The child maps are keyed the way their table is keyed — `session_model_usage`
 * by `model`, `session_tool_use` by `(tool_name, kind)`, `skill_invocations` by
 * `(skill_name, at_ms)` — so a comparison that walks them cannot accidentally merge
 * two rows the schema keeps apart (a skill and a builtin may share a name; see that
 * table's DDL).
 *
 * `buckets` is a bare set because `session_activity` has no payload beyond its own
 * key: a `(session, bucket)` pair either exists or does not.
 */
interface StoredSession {
	readonly row: Record<string, unknown>;
	readonly models: ReadonlyMap<string, StoredModelRow>;
	readonly tools: ReadonlyMap<string, StoredToolRow>;
	readonly buckets: ReadonlySet<number>;
	readonly invocations: ReadonlyMap<string, StoredInvocationRow>;
}

/** `(tool_name, kind)` — the `session_tool_use` primary key, minus the session. */
function toolKey(name: string, kind: string): string {
	return `${name}\0${kind}`;
}

/** `(skill_name, at_ms)` — the `skill_invocations` primary key, minus the session. */
function invocationKey(skill: string, atMs: number): string {
	return `${skill}\0${atMs}`;
}

/** The session rows this repo already has, in the shape {@link unchangedSessionEvent} compares against. */
function storedSessionRows(db: DashboardDbHandle, repoIdentity: string): Map<string, StoredSession> {
	const rows = db
		.prepare(
			`SELECT s.source, s.session_id, s.title, s.started_at_ms, s.updated_at_ms, s.message_count,
			        s.duration_ms, s.model, s.input_tokens, s.output_tokens, s.cached_tokens, s.est_cost_usd,
			        s.token_coverage, s.prices_as_of
			   FROM sessions s JOIN repos r ON r.id = s.repo_id
			  WHERE r.repo_identity = ?`,
		)
		.all(repoIdentity) as ReadonlyArray<Record<string, unknown> & { source: string; session_id: string }>;
	const sessions = new Map<string, StoredSession>(
		rows.map((r) => [
			`${r.source}\0${r.session_id}`,
			{ row: r, models: new Map(), tools: new Map(), buckets: new Set<number>(), invocations: new Map() },
		]),
	);

	// Joined back through `sessions` rather than read by `session_event_id`: the
	// id's shape is `statsEventId`'s business, and this way the child rows arrive
	// keyed by the same `(source, sessionId)` pair the caller looks up with.
	const modelRows = db
		.prepare(
			`SELECT s.source, s.session_id, u.model, u.input_tokens, u.output_tokens, u.cached_tokens, u.est_cost_usd
			   FROM session_model_usage u
			   JOIN sessions s ON s.event_id = u.session_event_id
			   JOIN repos r    ON r.id = s.repo_id
			  WHERE r.repo_identity = ?`,
		)
		.all(repoIdentity) as ReadonlyArray<{
		source: string;
		session_id: string;
		model: string;
		input_tokens: number;
		output_tokens: number;
		cached_tokens: number;
		est_cost_usd: number | null;
	}>;
	for (const r of modelRows) {
		const target = sessions.get(`${r.source}\0${r.session_id}`);
		(target?.models as Map<string, StoredModelRow>)?.set(r.model, {
			input: r.input_tokens,
			output: r.output_tokens,
			cached: r.cached_tokens,
			cost: r.est_cost_usd,
		});
	}

	const toolRows = db
		.prepare(
			`SELECT s.source, s.session_id, t.tool_name, t.kind, t.server, t.calls, t.last_call_at_ms,
			        t.input_tokens, t.output_tokens, t.cached_tokens, t.usage_confidence, t.plugin
			   FROM session_tool_use t
			   JOIN sessions s ON s.event_id = t.session_event_id
			   JOIN repos r    ON r.id = s.repo_id
			  WHERE r.repo_identity = ?`,
		)
		.all(repoIdentity) as ReadonlyArray<{
		source: string;
		session_id: string;
		tool_name: string;
		kind: string;
		server: string | null;
		calls: number;
		last_call_at_ms: number | null;
		plugin: string | null;
		input_tokens: number | null;
		output_tokens: number | null;
		cached_tokens: number | null;
		usage_confidence: string | null;
	}>;
	for (const r of toolRows) {
		const target = sessions.get(`${r.source}\0${r.session_id}`);
		(target?.tools as Map<string, StoredToolRow>)?.set(toolKey(r.tool_name, r.kind), {
			server: r.server,
			calls: r.calls,
			lastCallAtMs: r.last_call_at_ms,
			inputTokens: r.input_tokens,
			outputTokens: r.output_tokens,
			cachedTokens: r.cached_tokens,
			usageConfidence: r.usage_confidence,
			plugin: r.plugin,
		});
	}

	const invocationRows = db
		.prepare(
			`SELECT s.source, s.session_id, i.skill_name, i.at_ms, i.ok, i.ok_confidence,
			        i.detection, i.entry_path, i.args, i.body_chars
			   FROM skill_invocations i
			   JOIN sessions s ON s.event_id = i.session_event_id
			   JOIN repos r    ON r.id = s.repo_id
			  WHERE r.repo_identity = ?`,
		)
		.all(repoIdentity) as ReadonlyArray<{
		source: string;
		session_id: string;
		skill_name: string;
		at_ms: number;
		ok: number;
		ok_confidence: string;
		detection: string | null;
		entry_path: string | null;
		args: string | null;
		body_chars: number | null;
	}>;
	for (const r of invocationRows) {
		const target = sessions.get(`${r.source}\0${r.session_id}`);
		(target?.invocations as Map<string, StoredInvocationRow>)?.set(invocationKey(r.skill_name, r.at_ms), {
			ok: r.ok,
			okConfidence: r.ok_confidence,
			detection: r.detection,
			entryPath: r.entry_path,
			args: r.args,
			bodyChars: r.body_chars,
		});
	}

	const bucketRows = db
		.prepare(
			`SELECT s.source, s.session_id, a.bucket_ms
			   FROM session_activity a
			   JOIN sessions s ON s.event_id = a.session_event_id
			   JOIN repos r    ON r.id = s.repo_id
			  WHERE r.repo_identity = ?`,
		)
		.all(repoIdentity) as ReadonlyArray<{ source: string; session_id: string; bucket_ms: number }>;
	for (const r of bucketRows) {
		const target = sessions.get(`${r.source}\0${r.session_id}`);
		(target?.buckets as Set<number>)?.add(r.bucket_ms);
	}
	return sessions;
}

/**
 * `models` folded the way `MODEL_USAGE_UPSERT` would store it — the shape
 * {@link sameModelSplit} must compare against.
 *
 * `model` is that table's key, and two entries in ONE event may name the same model
 * (two segments of one model's usage, which sum). The write path handles that with
 * `ON CONFLICT(session_event_id, model) DO UPDATE … + excluded`, so the row that lands
 * is the SUM and the stored map has one entry where the event had two.
 *
 * This mirror exists because the comparison used to skip it, on the strength of a
 * docblock claiming a duplicate "would violate the primary key on the plain INSERT —
 * the projection would throw, not merge". That was true before the conflict clause and
 * false after it, and the consequence was permanent: `models.length !== stored.size`
 * made such an event report CHANGED on every pass, so every dashboard run and every
 * 30-second tick re-projected the session and appended another byte-identical
 * `events_raw` row — the exact churn `unchangedSessionEvent` exists to remove.
 *
 * The cost arm reproduces the upsert's `CASE`, not a `COALESCE` pair: NULL means
 * "unpriced", so two unpriced segments stay NULL rather than summing to a priced 0.00,
 * which every downstream reader would take for a real answer.
 *
 * `||`, matching that `CASE`'s `IS NULL OR IS NULL`, so a MIXED pair is NULL here too. This
 * said `&&` while claiming to reproduce the `CASE`, which made the claim false in the one
 * case the two spellings differ in: the mirror folded a priced and an unpriced segment into a
 * confident total where SQL stores NULL, so a comparison meant to answer "would re-writing
 * change anything" would have answered no to a difference it had itself invented — the
 * permanent-churn bug, in the other direction. Unreachable today (both rows come from one
 * event's `models` array and one `Pricing.ts` lookup, so same-model segments are priced alike
 * or not at all), and written to agree anyway, because a mirror whose docblock overstates it
 * is how the last divergence survived review.
 */
function foldModelSplit(models: ReadonlyArray<StatsModelUsage>): Map<string, StoredModelRow> {
	const folded = new Map<string, StoredModelRow>();
	for (const m of models) {
		const prior = folded.get(m.model);
		const cost = m.estCostUsd ?? null;
		if (prior === undefined) {
			folded.set(m.model, { input: m.inputTokens, output: m.outputTokens, cached: m.cachedTokens, cost });
			continue;
		}
		folded.set(m.model, {
			input: prior.input + m.inputTokens,
			output: prior.output + m.outputTokens,
			cached: prior.cached + m.cachedTokens,
			cost: prior.cost === null || cost === null ? null : prior.cost + cost,
		});
	}
	return folded;
}

/**
 * True when re-writing `models` would leave `session_model_usage` as it stands.
 *
 * The split is replaced WHOLESALE, so this is set equality and not containment:
 * a shrinking set leaves a stale row behind, which is the whole reason
 * `projectSession` deletes before inserting.
 *
 * Compared against {@link foldModelSplit}'s output rather than against the raw array,
 * because the write path merges same-model entries — see there.
 */
function sameModelSplit(models: ReadonlyArray<StatsModelUsage>, stored: ReadonlyMap<string, StoredModelRow>): boolean {
	const folded = foldModelSplit(models);
	if (folded.size !== stored.size) return false;
	for (const [model, m] of folded) {
		const row = stored.get(model);
		if (!row) return false;
		if (row.input !== m.input || row.output !== m.output || row.cached !== m.cached) return false;
		if (row.cost !== m.cost) return false;
	}
	return true;
}

/**
 * True when re-writing `tools` would leave `session_tool_use` as it stands.
 *
 * Set equality against `stored`, keyed by {@link toolKey} — same shape as
 * {@link sameModelSplit}, and same reason (the set is replaced wholesale, so a
 * dropped tool is a real write). Three facts about the write path make this one
 * harder than the model split, and all three are load-bearing:
 *
 *  1. The insert carries `ON CONFLICT(session_event_id, tool_name, kind)`, so
 *     two entries in ONE event that share a name and kind do not both land —
 *     they merge, with `calls` taking the later entry's value, `last_call_at_ms`
 *     taking the MAX, and `server` keeping the FIRST entry's value because the
 *     conflict clause does not update it.
 *  2. The writer snapshots the old rows before replacing the set. It keeps the
 *     greatest `last_call_at_ms`, and carries token attribution and plugin through
 *     a sparse re-read that cannot recover them.
 *  3. `server` is nullable on both sides, and `undefined` on the event becomes
 *     NULL in the row.
 *
 * The first is handled by refusing to fold here: a repeated key is reported
 * CHANGED, so the event projects and the merge stays where it is written. The
 * second requires asymmetric comparisons below: missing or older evidence is
 * already equal when the writer would preserve the stored value.
 *
 * Counting entries against stored rows does NOT subsume that refusal, though it
 * looks like it should: a repeat collapses, so `[Bash, Bash]` is two entries and
 * one row, and it meets a stored pair of `Bash` + `Read` at equal size. Skipping
 * there would strand `Read` forever — the row the projection was about to drop.
 */
function sameToolSet(tools: ReadonlyArray<ToolCallCount>, stored: ReadonlyMap<string, StoredToolRow>): boolean {
	const keys = new Set(tools.map((t) => toolKey(t.name, t.kind)));
	if (keys.size !== tools.length) return false;
	if (tools.length !== stored.size) return false;
	for (const tool of tools) {
		const row = stored.get(toolKey(tool.name, tool.kind));
		if (!row) return false;
		if (row.calls !== tool.calls) return false;
		if (row.server !== (tool.server ?? null)) return false;
		if (tool.lastCallAtMs !== undefined && (row.lastCallAtMs === null || tool.lastCallAtMs > row.lastCallAtMs))
			return false;
		// Tokens too — see StoredToolRow for what omitting them cost. A stored NULL
		// against a freshly attributed figure is exactly the case a generation bump
		// exists to re-read, and reporting it unchanged here would discard the re-read
		// after paying for it. An absent figure is no difference, though: the writer
		// preserves the stored attribution instead of replacing it with NULL.
		const usage = tool.usage;
		if (usage?.input !== undefined && row.inputTokens !== usage.input) return false;
		if (usage?.output !== undefined && row.outputTokens !== usage.output) return false;
		if (usage?.cached !== undefined && row.cachedTokens !== usage.cached) return false;
		if (usage?.confidence !== undefined && row.usageConfidence !== usage.confidence) return false;
		// `plugin` is COALESCE'd by the writer, so only a PRESENT value can move the
		// stored one — the same rule `SESSION_COALESCED_COLUMNS` applies to the session
		// row. Comparing an absent one against a stored label would report a change the
		// projection cannot make and re-project the session on every pass forever.
		if (tool.plugin !== undefined && row.plugin !== tool.plugin) return false;
	}
	return true;
}

/**
 * True when every entry row this event would write is already stored as it would
 * write it.
 *
 * ONE-SIDED on purpose, unlike {@link sameToolSet}: `skill_invocations` is written
 * add-or-update with no preceding DELETE (see its DDL), so a stored row the event no
 * longer mentions — a conversation the agent compacted — is not a difference this
 * projection would resolve. Comparing sizes would report it as changed on every pass
 * and re-project that session forever without ever removing the row.
 *
 * Which fields are compared mirrors the writer's conflict clause rather than the
 * table's columns: `ok` / `ok_confidence` / `detection` / `entry_path` are overwritten,
 * so a difference in any of them is a real write, while `args` and `body_chars` are
 * COALESCE'd and therefore only movable by a present value.
 */
function sameSkillInvocations(
	tools: ReadonlyArray<ToolCallCount>,
	source: string,
	stored: ReadonlyMap<string, StoredInvocationRow>,
): boolean {
	for (const tool of tools) {
		if (tool.kind !== "skill") continue;
		for (const invocation of tool.invocations ?? []) {
			const atMs = Date.parse(invocation.at);
			// Skipped by the writer too — an unparseable instant cannot key a row.
			if (!Number.isFinite(atMs)) continue;
			const row = stored.get(invocationKey(tool.name, atMs));
			if (!row) return false;
			const incomingConfidence = skillOutcomeConfidence(source, invocation.entryPath, invocation.outcomeObserved);
			// The writer keeps an observed result when a later scan only has an
			// unresolved fragment. Mirror that one-way merge here or backfill would
			// re-enqueue the same no-op on every pass.
			if (row.okConfidence !== "observed" || incomingConfidence === "observed") {
				if (row.ok !== (invocation.ok ? 1 : 0)) return false;
				if (row.okConfidence !== incomingConfidence) return false;
			}
			if (row.detection !== (tool.detection ?? null)) return false;
			if (row.entryPath !== (invocation.entryPath ?? null)) return false;
			if (invocation.args !== undefined && row.args !== invocation.args) return false;
			if (invocation.bodyChars !== undefined && row.bodyChars !== invocation.bodyChars) return false;
		}
	}
	return true;
}

/**
 * True when projecting `event` would write nothing new.
 *
 * The session tier has NO gate whatever — its cursor is recorded for
 * observability and never consulted, deliberately, because a global
 * max-updatedAt would miss a session updated out of order. So every
 * discoverable session was re-logged and re-projected on every pass; measured,
 * half of them carry no usage at all and are byte-identical repeats
 * (JOLLI-2224).
 *
 * The child tables are covered for a measured reason, not for symmetry. A first
 * version skipped any event carrying a split or a tool list, on the grounds that
 * their merge rules were the risky half to mirror. Two back-to-back `jolli
 * dashboard` runs then still re-projected 17 sessions each, byte-identical, and
 * 14 of the 17 had not been touched for a day — the carve-out WAS the remaining
 * churn, because a real session almost always carries both.
 *
 * MIRRORS `projectSession`, including both child tables. It compares against the
 * ROWS THOSE WRITES WOULD PRODUCE, never against the merge rules that produce
 * them — the rules (the `hasUsage` gate `models: []` once fell through, the
 * MAX/NULLIF on the tool timestamp) are exactly what a restatement would drift
 * from, and a drifted gate fails by silently dropping data. The one rule that IS
 * restated is `hasUsage` itself, because it decides whether a write happens at
 * all rather than what it writes:
 *
 *  - `updated_at_ms` is written unconditionally, so it is always compared.
 *  - The `COALESCE`d columns cannot be changed by an ABSENT value; a present one
 *    must already match.
 *  - The token scalars and `token_coverage` are written unconditionally, but the
 *    value written comes from the model split WHEN THERE IS ONE — so the
 *    comparison derives them the same way rather than reading the event's own
 *    scalar fields, which a split makes advisory. When the event observed no
 *    usage at all the stored values carried forward, so nothing can move.
 *  - `model` and `est_cost_usd` are `COALESCE`d, but their written value is
 *    DERIVED from the split (primary model, summed cost), so they cannot ride in
 *    {@link SESSION_COALESCED_COLUMNS} with the fields that are copied verbatim.
 *    And `est_cost_usd` is the one derived column that does NOT ride on
 *    `hasUsage`: it falls back to the event's own `estCostUsd` before the stored
 *    value, so a token-less event carrying a price still writes it, and its
 *    comparison has to happen ahead of the carry-forward return.
 *  - Both child tables are replace-when-observed, under the same predicate
 *    `projectSession` uses to decide it wrote at all.
 *  - `session_activity` is the THIRD child and the one exception to that shape: it
 *    is insert-only, so it is compared by containment rather than equality. Adding
 *    a derived output to `projectSession` without adding it here is silent — the
 *    event is judged unchanged and dropped before the projection ever runs, so the
 *    new table simply stays empty for every session that was already stored. That
 *    is exactly how the buckets went missing (52 rows against 1826 sessions), and
 *    bumping {@link SESSION_READ_GENERATION} did not fix it: re-reading a
 *    transcript only rebuilds the EVENT, and this is the gate the event dies at.
 */
function unchangedSessionEvent(event: SessionUpsertedEvent, stored: StoredSession | undefined): boolean {
	if (!stored) return false;
	const { row } = stored;
	if (row.updated_at_ms !== event.updatedAtMs) return false;
	for (const [column, read] of SESSION_COALESCED_COLUMNS) {
		const value = read(event);
		if (value !== undefined && row[column] !== value) return false;
	}

	const models = event.models ?? [];
	// The SAME predicate `projectSession` computes, `models.length > 0` term and
	// all. Dropping that term is not a near-miss: it routes a split-carrying event
	// into the carry-forward branch below, which compares no tokens at all.
	const hasUsage =
		models.length > 0 || event.inputTokens != null || event.outputTokens != null || event.cachedTokens != null;

	// Replace-when-observed, both of them. The model split's guard is `hasUsage`
	// AND presence — an event that carries `models: []` with no scalar tokens is
	// "unobserved", and the projection leaves the stored split alone.
	if (hasUsage && event.models !== undefined && !sameModelSplit(models, stored.models)) return false;
	if (event.tools !== undefined && !sameToolSet(event.tools, stored.tools)) return false;
	// CONTAINMENT, not set equality — the one comparison here that does not mirror a
	// replace. `session_activity` is insert-only (see `SESSION_ACTIVITY_DDL`), so the
	// question is only "would the INSERT OR IGNORE add a row", and a stored bucket the
	// event no longer produces is a fact the projection would keep anyway. Set equality
	// would call such a session changed on every pass forever, re-projecting it to write
	// nothing — which is the churn this whole comparator exists to remove.
	//
	// Compared BEFORE the carry-forward return below, for the same reason `est_cost_usd`
	// is: buckets do not ride on `hasUsage`. A source with no per-turn usage — every
	// agent but Claude — reaches that return, so gating this behind it would mean their
	// presence never reached the table.
	if (event.activityBuckets?.some((bucket) => !stored.buckets.has(bucket))) return false;
	// The fourth child table, under the same replace-when-observed guard. Omitting it
	// left the table permanently empty when it shipped — the projection re-read every
	// transcript and this function threw the result away, which is the same trap the
	// token fields on `StoredToolRow` document.
	if (event.tools !== undefined && !sameSkillInvocations(event.tools, event.source, stored.invocations)) return false;

	const sum = (read: (m: StatsModelUsage) => number): number => models.reduce((total, m) => total + read(m), 0);
	// `COALESCE`d, so only a non-null derived value can move it — but compared
	// BEFORE the carry-forward return below, because cost does not ride on
	// `hasUsage`. Its fallback chain is the event's own scalar first, so an event
	// that observed no tokens at all can still carry a price, and that price is
	// written on both branches. Gating this on `hasUsage` skipped such an event
	// forever: the cost it brought would never reach the row, silently.
	const cost = models.some((m) => m.estCostUsd != null) ? sum((m) => m.estCostUsd ?? 0) : event.estCostUsd;
	if (cost != null && row.est_cost_usd !== cost) return false;

	if (!hasUsage) return event.tokenCoverage === undefined || row.token_coverage === event.tokenCoverage;

	const split = models.length > 0;
	// `COALESCE`d, so only a non-null derived value can move it. Unlike cost this
	// one cannot outlive `hasUsage` — it is derived from the split alone, which is
	// empty on the carry-forward branch, so it is always absent there.
	const primaryModel = [...models].sort(
		(a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
	)[0]?.model;
	if (primaryModel !== undefined && row.model !== primaryModel) return false;

	return (
		row.input_tokens === (split ? sum((m) => m.inputTokens) : (event.inputTokens ?? 0)) &&
		row.output_tokens === (split ? sum((m) => m.outputTokens) : (event.outputTokens ?? 0)) &&
		row.cached_tokens === (split ? sum((m) => m.cachedTokens) : (event.cachedTokens ?? 0)) &&
		row.token_coverage === (event.tokenCoverage ?? "sessions-only")
	);
}

/**
 * Wraps events in envelopes and applies them in small batches.
 *
 * ⚠ Every batch opts out of the rollup settle (`skipRollup`). A backfill calls
 * this a dozen times over hundreds of batches, and each batch's writes mark the
 * days it just touched stale — so left on, the pass rebuilds the same newest
 * days once per batch (measured at ~945 ms for a 14-day settle) and keeps only
 * the last one. `dbBackfillRepo` settles once at the end instead; the other two
 * callers here write only registry rows, which no spend axis reads.
 */
function applyBatches(
	db: DashboardDbHandle,
	events: ReadonlyArray<StatsEvent>,
	producerKind: ProducerKind,
	now: () => number,
	onChunk?: (done: number, total: number) => void,
): { applied: number; pending: number } {
	let applied = 0;
	let pending = 0;
	for (let start = 0; start < events.length; start += BATCH_SIZE) {
		const batch: StatsEventEnvelope[] = events
			.slice(start, start + BATCH_SIZE)
			.map((event) => ({ event, producerKind }));
		const result = applyToDb(db, batch, { producerKind, now, skipRollup: true });
		applied += result.projected;
		// Reported, not just discarded: an event that stayed pending did NOT
		// reach the projection tables, so a caller whose cursor would skip the
		// next sweep has to treat it the same as a failed read.
		//
		// OVERWRITTEN, never accumulated: `drainPending` counts the rows still
		// unprojected for these repos at the end of each call — an absolute
		// backlog, not this batch's delta. Summing it makes a backlog that batch
		// 1 reported and batch 2 drained keep a non-zero total forever, so the
		// summaries cursor never advances and every later pass re-collects the
		// whole index. The last batch's count is the state that survives the loop.
		pending = result.pending;
		onChunk?.(Math.min(start + BATCH_SIZE, events.length), events.length);
	}
	return { applied, pending };
}

/** The `repo.enabled` projection for a registry entry. */
function repoEnabledEvent(repo: RegisteredRepo): StatsEvent {
	return {
		type: "repo.enabled",
		repoIdentity: repo.repoIdentity,
		repoName: repo.repoName,
		worktreeRoot: repo.worktreeRoot,
		...(repo.remoteUrl ? { remoteUrl: repo.remoteUrl } : {}),
		enabledAt: repo.enabledAt,
	};
}

/**
 * Projects ONE repo's state — enabled or disabled — and nothing else.
 *
 * The switch itself lives in each clone's `profile.json` (the registry stores no
 * disable state; see `listActiveRepos`), and the `repos` table is a projection of
 * it. Only this function makes the second agree with the first. Every read surface
 * filters on `repos.disabled_at IS NULL`, so an unprojected state is invisible in
 * both directions: an enabled repo with no row has no memories, no KPIs and no
 * page (every gated route redirects), while a disabled repo whose `disabled_at` is
 * still NULL keeps counting in every KPI and picker. That second half is why a
 * disabled repo must still be projected even though nothing will be imported for
 * it — dropping it from the sweep entirely would leave the row saying "enabled"
 * forever.
 *
 * **The timestamp is preserved, never refreshed.** A boolean cannot say when the
 * user flipped it, so the stamp is minted on the NULL → set transition and left
 * alone afterwards. Re-minting it would be invisible today (only nullness is read
 * — `DashboardQuery`'s paused sort and badge) and wrong the moment anything shows
 * "paused since", since every `jolli dashboard` re-projects and the date would
 * track the last launch instead of the decision.
 *
 * Cheap by construction — one lookup, two rows, no git, no import — so it is safe
 * to await inside a request handler before answering. The heavier memory import
 * stays `dbBackfillRepo`'s job.
 */
export function projectRepoRegistryState(
	db: DashboardDbHandle,
	repo: RegisteredRepo,
	opts: { readonly now?: () => number } = {},
): void {
	const now = opts.now ?? Date.now;
	const event: StatsEvent = isRepoDisabled(repo)
		? {
				type: "repo.disabled",
				repoIdentity: repo.repoIdentity,
				disabledAt: storedDisabledAt(db, repo.repoIdentity) ?? new Date(now()).toISOString(),
			}
		: repoEnabledEvent(repo);
	applyBatches(db, [event], "bootstrap", now);
}

/** The `disabled_at` already recorded for this identity, or null when enabled/absent. */
function storedDisabledAt(db: DashboardDbHandle, repoIdentity: string): string | null {
	const row = db.prepare("SELECT disabled_at FROM repos WHERE repo_identity = ?").get(repoIdentity) as
		| { disabled_at?: string | null }
		| undefined;
	return row?.disabled_at ?? null;
}

/**
 * Ensures one repo's data is present and current: a full bootstrap when it has
 * never completed, an incremental recovery otherwise. Idempotent and resumable
 * — a crash mid-import leaves `bootstrap_state = 'in-progress'`, and the next
 * run simply collects and applies again (UPSERTs make the redo harmless).
 */
export async function dbBackfillRepo(opts: DbBackfillOptions): Promise<DbBackfillResult> {
	const now = opts.now ?? Date.now;
	const producerKind = opts.producerKind ?? "bootstrap";
	const repo = opts.repo;
	// Every checkout of this project that still exists, newest first. Identity is
	// the normalized remote, so two clones share one entry — sweeping only
	// `worktreeRoot` would silently ignore the other one's commits and branches.
	const worktrees = existingWorktrees(repo);
	// The newest checkout is "the" repo for anything that must pick one: HEAD-based
	// cursors, the summary index (dual-written per repo, so identical in each
	// clone) and the knowledge graph.
	//
	// Sessions are NOT one of those, and used to be listed here as "recorded per
	// project, not per checkout". They are recorded per DIRECTORY: an agent writes its
	// transcript under the cwd the conversation ran in, and the hook registry is a file
	// inside that worktree. So the session tier below scopes itself to every linked
	// worktree of every registered checkout instead — see `sessionWorktreeRoots`.
	const cwd = worktrees[0];
	// Resolved once per repo, ahead of the sweep: one `git worktree list` per
	// REGISTERED checkout (two clones of one remote each enumerate their own linked
	// worktrees), deduped because two entries can enumerate the same set. Failure
	// degrades to the checkout itself, so a repo whose git is unavailable keeps the
	// behaviour it had before this existed rather than losing its session tier.
	const sessionWorktreeRoots = [
		...new Set((await Promise.all(worktrees.map((root) => resolveWorktreeRoots(root)))).flat()),
	];

	// Filled by the session tier inside the callback below and read by the same
	// callback's `return`. It sits out here so the tier that PRODUCES it and the result
	// assembly that consumes it do not have to be adjacent — the callback runs a tier
	// per phase between them, and several of those can return early.
	let sessionSummary: SessionTierSummary | undefined;

	// Read before opening the DB: `withDashboardDb` closes its handle in a
	// `finally`, which for an async callback runs before the awaits inside it
	// resolve — so an async read placed inside the callback would come back to an
	// already-closed handle.
	// PARKED with `repo_graphs` (see SotSchema): nothing reads the artifact since
	// the graph page was removed, and collecting it reads graph.json off disk.
	// const knowledgeGraph = await collectRepoGraph(cwd);

	// One provider shared by the summary sweep and the SOT import, PINNED to the
	// orphan tip resolved right here. Reading by branch name instead is a race:
	// a writer advancing the branch mid-import makes the run see a mixture of
	// two versions, and a seed-mode reconciliation would then prune rows for
	// paths that merely do not exist at the older tip it listed. One provider
	// (rather than per-read fallback inside SummaryStore) also keeps a repo with
	// hundreds of summaries from burying the output in identical warnings.
	// `--storage` (tests) overrides it.
	const orphanTip = opts.storage ? null : await resolveCommittish(ORPHAN_BRANCH, cwd);
	const orphanStorage = opts.storage ?? (orphanTip ? new GitRefStorage(orphanTip, cwd) : null);

	// The commit tier's read side, threaded explicitly into `collectCommitEvents`
	// — which reads `index.json` for branch attribution and, given nothing, falls
	// back to the ambient system of record inside `getIndex`. That fallback
	// re-resolved the backend once per CHECKOUT and silently ignored the
	// `--storage` seam, so a test could feed the importer an index the commit tier
	// never saw.
	//
	// One provider for every checkout, resolved at `cwd`, because the index is
	// per-REPO: it is dual-written identically into each clone, which is the same
	// reason the summaries cursor and `orphanStorage` are taken from `cwd` alone.
	// That makes the `branches` union in the merge loop below degenerate — every
	// checkout now reports the same recorded branch for a hash — without making it
	// removable; see the ABSENT note there.
	//
	// **NOT `orphanStorage`, and that is why it is a second provider.** The pinned
	// one is the ORPHAN TIP, which a fenced repo has frozen: every commit made
	// after the fence is absent from that index, and an index that loads without
	// the entry is the "no recorded branch" answer — `[]`, which the projection
	// honours by DELETING the commit's rows. Pinning here would wipe attribution
	// for exactly the commits a cut-over repo still creates. The routed system of
	// record is right in both states: the orphan branch before cutover,
	// `SqliteStorage` after (its `synthIndex` rebuilds `index.json` from the
	// `memories` rows, `branch` included).
	//
	// Resolved out here for the same reason `readRepoCutoverFence` is: after
	// cutover this opens the database, and that must not sit inside the writable
	// handle's lifetime.
	const indexStorage = await resolveReadStorage(opts.storage, cwd);

	// Once this repo is fenced for cutover, new memories land in SQLite only —
	// the orphan branch stops moving. Read before opening the DB, so the async
	// call cannot sit inside the handle's lifetime.
	//
	// Asked of EVERY checkout rather than of `cwd`, which is only the newest —
	// see `readRepoCutoverFence`. The `sotMode` decision below has database-side
	// witnesses to fall back on, but `protectNewerThanMs` has none: a fence
	// missed here silently turns the import into an unprotected one, and
	// catch-up does not skip a stale body, it writes it over the fresh one.
	const fence = await readRepoCutoverFence(repo);

	return withDashboardDb(
		async (db) => {
			// Project the registry entry first so FK targets exist with real names.
			let applied = applyBatches(db, [repoEnabledEvent(repo)], producerKind, now).applied;

			// After the repo row (FK target), and idempotent on the artifact's own
			// build stamp — so every recovery pass can offer it unconditionally and
			// an unchanged graph.json costs one comparison.
			// if (knowledgeGraph) recordRepoGraph(db, repo.repoIdentity, knowledgeGraph);

			const state = readBootstrapState(db, repo.repoIdentity);
			const isBootstrap = state !== "done";

			// Fast path: nothing moved since the last pass. Sessions and worktree
			// state are cheap enough to always re-project, so only the expensive git
			// sweep is gated.
			// The cursor must cover EVERY checkout, not just the primary one: commits
			// landing in the second clone move only its HEAD, and a cursor built from
			// the primary alone would report "unchanged" and skip them entirely.
			// No phase marker here: the fingerprint sweep below is sub-second, and
			// the per-checkout markers inside the collection loop are the ones that
			// matter. Emitting one here too printed the same label twice.
			const fingerprints: string[] = [];
			for (const path of worktrees) {
				const fingerprint = await checkoutFingerprint(path);
				if (fingerprint) fingerprints.push(`${path}@${fingerprint}`);
			}
			const gitCursor = fingerprints.length > 0 ? fingerprints.sort().join(" ") : null;
			const commitCursor = readCursor(db, repo.repoIdentity, CURSOR_GIT);
			const commitsUnchanged = !isBootstrap && gitCursor !== null && commitCursor === gitCursor;
			// Set only by a COMPLETE collection below — the same condition that
			// licenses the prune, and for the same reason. The summary tier reads it
			// to tell "this commit is gone" from "its sweep has not run yet"; null
			// means it may not distinguish them. See `unchangedSummaryEvent`.
			let reachableHashes: Set<string> | null = null;

			if (isBootstrap) {
				db.prepare("UPDATE repos SET bootstrap_state = 'in-progress' WHERE repo_identity = ?").run(
					repo.repoIdentity,
				);
			}

			if (!commitsUnchanged) {
				// Collect from EVERY checkout, then MERGE before writing. Merging is not
				// an optimisation: `commit.created` treats `branches` as authoritative
				// and replaces the stored set (that is how a deleted branch is pruned),
				// so applying each checkout's events in turn would leave the last sweep's
				// branch set as the only one — silently wiping branch names that only the
				// other clone knows. Observed on a two-clone repo: 7 of 26 branches
				// unique to the second checkout vanished that way.
				const merged = new Map<string, CommitCreatedEvent>();
				// Read ONCE for the whole checkout loop, before any of them writes: a
				// per-checkout read would let the first checkout's upserts mark the
				// second one's commits "known" and skip their file scan.
				const knownHashes = commitsWithStoredFiles(db, repo.repoIdentity);
				// A checkout whose `git log` failed contributes nothing, which is
				// indistinguishable from "this checkout reaches no commits" once the events
				// are merged. Prune and the cursor advance are therefore both gated on a
				// COMPLETE union; an incomplete one may only ADD rows.
				let collectionComplete = true;
				for (const [i, worktree] of worktrees.entries()) {
					// Per checkout, because each one pays its own `git log --numstat`
					// — measured 6-12 s apiece, and it is a single opaque subprocess
					// with nothing to report from inside it.
					opts.onProgress?.({
						repoName: repo.repoName,
						kind: "commits",
						done: 0,
						...(isBootstrap ? { firstRun: true } : {}),
						...(worktrees.length > 1 ? { detail: `checkout ${i + 1} of ${worktrees.length}` } : {}),
					});
					let events: ReadonlyArray<CommitCreatedEvent>;
					try {
						events = await collectCommitEvents({
							repoIdentity: repo.repoIdentity,
							cwd: worktree,
							// Skips the whole-history `--numstat` for commits already stored —
							// the step this sweep's wall clock is made of. A bootstrap has an
							// empty set and so still scans everything.
							knownHashes,
							// The branch-attribution read. Explicit, and not this checkout's
							// own ambient fallback — see `indexStorage`.
							storage: indexStorage,
						});
					} catch (err) {
						// Not fatal for the repo: sessions and memories still import, and the
						// commits already stored stay stored. Only this pass's destructive half
						// is forfeited.
						collectionComplete = false;
						log.warn("commit collection failed for %s: %s", worktree, errMsg(err));
						continue;
					}
					for (const event of events) {
						const seen = merged.get(event.hash);
						if (!seen) {
							merged.set(event.hash, event);
							continue;
						}
						// Union the attribution; keep the first checkout's metadata, which
						// is identical for a given hash apart from `branches`.
						//
						// The union is FULLY degenerate now and kept for its ABSENT
						// handling alone: every checkout reads its attribution from the one
						// `indexStorage` this pass resolved, so each contributes the same
						// single recorded branch for a hash. (It used to be argued as
						// earning its place across two CLONES holding different indexes;
						// that stopped being true when the provider stopped being
						// per-checkout, and the index was already treated as per-repo by
						// the summaries cursor either way.)
						//
						// ABSENT ON EITHER SIDE POISONS THE UNION, and that half is NOT
						// degenerate — one shared provider means the index either loads for
						// every checkout or for none, but the "for none" case still has to
						// come out absent. `branches` is omitted when the index could not
						// be loaded at all (unreadable, or none written yet), and absent
						// means "keep what is stored".
						// Coercing that to `[]` and unioning turns two omissions into the
						// CLAIM "no branch reaches this commit" — which the projection
						// honours by deleting every `commit_branches` row for the commit —
						// and turns one omission into a partial claim that drops the
						// branches only the unreadable checkout knew. Either way the merged
						// event must stay silent, exactly like the single-checkout case.
						const { branches: seenBranches, ...seenRest } = seen;
						merged.set(event.hash, {
							...seenRest,
							...(seenBranches && event.branches
								? { branches: [...new Set([...seenBranches, ...event.branches])] }
								: {}),
						});
					}
				}
				const commitEvents = [...merged.values()];
				// Only the events that would actually change a row are projected. The
				// prune below still uses the COMPLETE set — see `unchangedCommitEvent`
				// for why the collection cannot be narrowed but the projection can.
				const storedRows = storedCommitRows(db, repo.repoIdentity);
				const changed = commitEvents.filter(
					(event) => !unchangedCommitEvent(event, storedRows.get(event.hash)),
				);
				if (changed.length !== commitEvents.length) {
					log.info(
						"%s: %d of %d commit events unchanged, skipping their projection",
						repo.repoName,
						commitEvents.length - changed.length,
						commitEvents.length,
					);
				}
				applied += applyBatches(db, changed, producerKind, now, (done, total) =>
					opts.onProgress?.({ repoName: repo.repoName, kind: "commits", done, total }),
				).applied;
				if (collectionComplete) {
					const reachable = new Set(commitEvents.map((e) => e.hash));
					reachableHashes = reachable;
					// Prune against the UNION: pruning per worktree would delete commits that
					// only the other checkout can reach, and the next pass would re-add them —
					// a delete/insert cycle on every run.
					pruneUnreachableCommits(db, repo.repoIdentity, reachable);
					// The memory tier keeps its rows (a rewritten commit's memory is content,
					// not a duplicate to drop), so it carries its own reachability flag the
					// feeds filter on — fed the SAME union set the prune used.
					markMemoriesReachability(db, repo.repoIdentity, reachable);
					// The commit tier's flag heals any stale 0 the prune-then-mark leaves;
					// the daemon reconcile is what marks rows orphaned since the last sweep.
					markCommitsReachability(db, repo.repoIdentity, reachable);
					// The cursor rides with the prune, not with the upserts: it is derived from
					// HEAD plus the ref list, which can resolve fine while `git log` fails, and
					// advancing it on an incomplete pass makes the NEXT pass skip collection
					// altogether — turning a transient read failure into a permanent blank.
					if (gitCursor) writeCursor(db, repo.repoIdentity, CURSOR_GIT, gitCursor, now());
				} else {
					log.warn(
						"skipping commit prune and cursor advance for %s -- at least one checkout could not be read",
						repo.repoName,
					);
				}
			}

			// Summaries (memory tier): the index is small and rewritten wholesale,
			// so its content hash is the whole change signal — unchanged means no
			// summary was added, merged or migrated since the last pass. On change,
			// the sweep is a full re-read: summaries are consolidated (squash/amend
			// fold children into new roots), so per-entry cursors cannot work, and
			// idempotent UPSERTs make the redo harmless.
			const indexFingerprint = orphanStorage ? await summaryIndexFingerprint(cwd, orphanStorage) : null;
			const summariesCursor = readCursor(db, repo.repoIdentity, CURSOR_SUMMARIES);
			if (orphanStorage && indexFingerprint && (isBootstrap || summariesCursor !== indexFingerprint)) {
				// INSIDE the gate. The marker used to fire unconditionally, which made
				// "Indexing stored memories…" appear on every launch for a phase that
				// then did nothing — and a phase marker is the caller's evidence that
				// there is work worth narrating.
				opts.onProgress?.({ repoName: repo.repoName, kind: "summaries", done: 0 });
				const summaries = await collectSummaryEvents({
					repoIdentity: repo.repoIdentity,
					cwd,
					storage: orphanStorage,
				});
				// Same two-step as the commit tier: the COLLECTION stays whole (the
				// cursor below is the index's content hash, and `summaries.complete`
				// is a claim about that whole read), only the PROJECTION is narrowed.
				const summaryRows = storedCommitRows(db, repo.repoIdentity);
				const sessionCoverage = storedSessionCoverage(db, repo.repoIdentity);
				const pruned = (hash: string): boolean => reachableHashes !== null && !reachableHashes.has(hash);
				const changedSummaries = summaries.events.filter(
					(event) =>
						!unchangedSummaryEvent(event, summaryRows.get(event.hash), sessionCoverage, pruned(event.hash)),
				);
				if (changedSummaries.length !== summaries.events.length) {
					log.info(
						"%s: %d of %d summary events unchanged, skipping their projection",
						repo.repoName,
						summaries.events.length - changedSummaries.length,
						summaries.events.length,
					);
				}
				const summaryApply = applyBatches(db, changedSummaries, producerKind, now);
				applied += summaryApply.applied;
				// Same rule as the commit tier's `collectionComplete` above, and for
				// the same reason: this cursor is the index's content hash, so
				// advancing it after a partial sweep makes every later pass skip
				// collection outright. A summary that failed to read (or to project)
				// would then be missing from the dashboard forever, since a re-read
				// is only ever triggered by index.json itself changing.
				if (summaries.complete && summaryApply.pending === 0) {
					writeCursor(db, repo.repoIdentity, CURSOR_SUMMARIES, indexFingerprint, now());
				} else {
					// Hoisted out of the log.warn args on purpose: as a ternary buried in a
					// multi-line call argument, v8 samples this branch non-deterministically
					// (the uncovered branch drifts between full-suite runs even though both
					// arms are exercised); as a standalone conditional it is instrumented
					// deterministically.
					const unreadableCount = summaries.complete ? 0 : 1;
					log.warn(
						"skipping summaries cursor advance for %s -- %d unreadable, %d unprojected",
						repo.repoName,
						unreadableCount,
						summaryApply.pending,
					);
				}
			}

			// Sessions: always re-COLLECT the currently discoverable set. A global
			// max-updatedAt cursor would miss an old session updated out of order, so
			// `CURSOR_SESSIONS` below only records progress for observability — it is
			// never used to skip.
			//
			// Skipping happens at two narrower layers instead, neither of them repo-wide.
			// On the READ side it is per-session and exact: `readKnownSessions` answers
			// "how far did I get with THIS session", so resuming a three-day-old
			// conversation still re-reads it (its stored instant is older than the turn
			// just added) — the failure mode a repo-wide high-water mark has and this
			// does not. On the PROJECTION side it is per event, exactly as in the two
			// tiers above; see `unchangedSessionEvent`.
			opts.onProgress?.({ repoName: repo.repoName, kind: "sessions", done: 0 });
			// The receipt check, and it has two halves. Only a repo whose recorded
			// generation matches what a full read produces TODAY may have transcripts
			// skipped — anything else, including a database predating this gate, gets one
			// un-skipped pass ({@link SESSION_READ_GENERATION}) — and only rows a real read
			// wrote count as evidence, which is what stops the summaries tier just above
			// from seeding a commit-time instant this comparison would trust
			// ({@link readKnownSessions}).
			const readGeneration = readCursor(db, repo.repoIdentity, CURSOR_SESSIONS_GENERATION);
			const maySkip = readGeneration === SESSION_READ_GENERATION;
			const known = maySkip ? readKnownSessions(db, repo.repoIdentity) : new Map<string, number>();
			let counts: SessionPassCounts = {
				discovered: 0,
				skipped: 0,
				bySource: {},
				discoveredKeys: [],
				skippedKeys: [],
			};
			const sessionEvents = await collectSessionEvents({
				onCounts: (seen) => {
					counts = seen;
				},
				repoIdentity: repo.repoIdentity,
				cwd,
				worktreeRoots: sessionWorktreeRoots,
				// The registered checkouts themselves, NOT their linked worktrees: this is
				// the granularity a worktree-spanning source is asked at, and one call
				// answers for one clone's `.git` only. Handing over just `cwd` would drop a
				// second clone's sessions for that source alone.
				checkoutRoots: worktrees,
				// The one caller that widens the horizon past every source's 48 h default.
				windowMs: BACKFILL_SESSION_WINDOW_MS,
				...(opts.isSourceAllowed ? { isSourceAllowed: opts.isSourceAllowed } : {}),
				...(opts.preScanned ? { preScanned: opts.preScanned } : {}),
				...(maySkip ? { isAlreadyCurrent: alreadyCurrentFrom(known) } : {}),
				...(opts.loadSessions ? { loadSessions: opts.loadSessions } : {}),
			});
			const storedSessions = storedSessionRows(db, repo.repoIdentity);
			const changedSessions = sessionEvents.filter(
				(event) => !unchangedSessionEvent(event, storedSessions.get(`${event.source}\0${event.sessionId}`)),
			);
			if (changedSessions.length !== sessionEvents.length) {
				log.info(
					"%s: %d of %d session events unchanged, skipping their projection",
					repo.repoName,
					sessionEvents.length - changedSessions.length,
					sessionEvents.length,
				);
			}
			applied += applyBatches(db, changedSessions, producerKind, now, (done, total) =>
				opts.onProgress?.({ repoName: repo.repoName, kind: "sessions", done, total }),
			).applied;
			const maxUpdated = sessionEvents.reduce((max, e) => Math.max(max, e.updatedAtMs), 0);
			if (maxUpdated > 0) writeCursor(db, repo.repoIdentity, CURSOR_SESSIONS, String(maxUpdated), now());
			// Recorded unconditionally, including after a pass where a discoverer failed.
			// A partial pass cannot mislead the next one: a session that was never
			// discovered has no row a read wrote, so the skip has nothing to match it
			// against and it is read in full whenever it does turn up. A commit summary may
			// have seeded a row for it in the meantime, which is exactly why
			// `readKnownSessions` does not count one.
			writeCursor(db, repo.repoIdentity, CURSOR_SESSIONS_GENERATION, SESSION_READ_GENERATION, now());
			// Merged from two sides, and it has to be: the collector knows what it SAW
			// (discovered / skipped, including for a source it read nothing from), the
			// event list knows what SURVIVED. Seeding from the collector's keys rather
			// than from the events is what keeps a fully-skipped agent in the report.
			const processedBySource: Record<string, number> = {};
			for (const event of sessionEvents)
				processedBySource[event.source] = (processedBySource[event.source] ?? 0) + 1;
			const bySource: Record<string, SessionSourceTotals> = {};
			for (const [source, seen] of Object.entries(counts.bySource)) {
				bySource[source] = { ...seen, processed: processedBySource[source] ?? 0 };
			}
			// The processed population is spelled from the EVENTS, matching how
			// `processed` itself is counted — a discovered session that produced no event
			// belongs to neither the processed nor the skipped set, and the keys have to
			// keep that gap open the same way the three numbers do.
			const processedKeys: SessionPassKey[] = sessionEvents.map((event) =>
				sessionPassKey(event.source, event.sessionId),
			);
			sessionSummary = {
				discovered: counts.discovered,
				skipped: counts.skipped,
				processed: sessionEvents.length,
				bySource,
				keys: {
					discovered: counts.discoveredKeys,
					processed: processedKeys,
					skipped: counts.skippedKeys,
				},
			};
			// The per-repo breakdown, emitted as its own phase-END marker. The tier's
			// phase-START marker above cannot carry it — the numbers do not exist until
			// the reads are done — and the run-wide summary at the very end cannot
			// either, because it is merged across repos by design. `done` is the
			// processed count purely so the event is not mistaken for a start marker.
			opts.onProgress?.({
				repoName: repo.repoName,
				kind: "sessions",
				done: sessionEvents.length,
				sessionBreakdown: bySource,
			});

			// Worktree: transient, recomputed every pass — from the PRIMARY checkout
			// only. `worktree_status` is keyed `(repo_id, branch_key)`, so two
			// checkouts sitting on the same branch would silently overwrite each
			// other's dirty state, last writer winning. Reporting one checkout
			// truthfully beats reporting an arbitrary one of two. Per-checkout dirty
			// state needs the worktree path in that primary key — a schema change, and
			// deliberately not smuggled into a defect fix.
			const worktree = await collectWorktreeEvent(repo.repoIdentity, cwd, now);
			if (worktree) applied += applyBatches(db, [worktree], producerKind, now).applied;

			// SOT tables (v7): the orphan branch imported verbatim into
			// memory_nodes/revisions, transcripts, docs, plan_progress and the topic
			// KB. Independent of the event pipeline above — the importer writes base
			// tables directly (a bulk load is not a producer event) and is keyed on
			// business identity, so it converges on every re-run.
			//
			// Gated on the ORPHAN TIP, not on the summary index. The index fingerprint
			// cannot serve here — docs and topics change without `index.json` moving —
			// but the tip commit is a hash of the whole tree this importer reads
			// (summaries, transcripts, plans, notes, references, skills, topics AND the
			// index), so an unchanged tip means every input byte is unchanged. Cheap
			// too: it was already resolved above to pin the provider.
			//
			// Convergence is not a reason to re-run it. A converged seed pass still
			// rewrites the whole repo: phase 1 shifts every child_pos, the settle
			// re-upserts every row, and `writeTopics`/`writeLinks` DELETE and re-INSERT
			// unconditionally — measured on this repo, 2967 topic rows and 2908 link
			// rows rewritten by a pass that reported `updated: 0`, for 4.6 s of every
			// `jolli dashboard`. Catch-up costs less (it returns early on identical
			// content) but still re-reads every summary body off the branch.
			// `seed` while the orphan branch is still the source of truth, so a file
			// gone from the branch means the memory is gone and the row must follow.
			// Once fenced, new memories exist ONLY in SQLite — indistinguishable from
			// "deleted" to a reconciliation pass reading the (now-frozen) branch — so
			// this flips to `catch-up`, which never deletes.
			// No orphan tip means nothing to import FROM — and, deliberately, nothing
			// to prune either. A missing branch is either a repo that never had
			// memories (nothing to do) or a branch deletion, and destroying the
			// database's rows because a branch vanished would make an accident
			// permanent. Skipping is the recoverable choice.
			// A fenced repo's tip is frozen at the fence time, so everything the
			// database stamped after it outranks this source.
			//
			// The CAS's own `committedAt` is the fallback, exactly as in
			// `CutoverEngine`'s drift import: a fence that is absent OR carries an
			// unparsable stamp would otherwise leave `protectNewerThanMs` off, and an
			// unprotected catch-up does not skip a stale body — it writes it over the
			// fresh one. The mode decision below has its own witnesses; this one had
			// none.
			const protectMs = resolveProtectNewerThanMs(db, repo.repoIdentity, fence?.atMs);
			// `seed` reconciles: a memory the READ SOURCE no longer lists is deleted. That
			// source is ONE checkout's orphan branch (`cwd` = the newest surviving one),
			// while `repo_id` is shared by every clone of the identity — so with two clones
			// whose branches differ, a seed pass deletes the memories only the OTHER clone
			// has. The commit tier avoids this by merging every checkout before pruning;
			// the importer reads a single pinned provider and cannot, so multi-checkout
			// repos drop to the never-deleting mode instead. A genuinely removed memory
			// then lingers until a single-checkout pass, which is the same trade the
			// missing-branch case below already makes: a stale row beats a permanent
			// deletion nobody asked for.
			const multiCheckout = worktrees.length > 1;
			if (multiCheckout && !fence) {
				log.info(
					"%s has %d checkouts -- importing memories in catch-up mode (no reconciliation)",
					repo.repoName,
					worktrees.length,
				);
			}
			// The fence is NOT sufficient evidence on its own, and this sweep runs on
			// every `jolli dashboard` — so it is the path where losing that evidence
			// hurts. `readCutoverFence` fails open, and `profile.json` is per-project
			// gitignored state that `git clean -xdf` removes. On a cut-over repo that
			// alone flips this decision back to `seed`, whose reconciliation then
			// deletes every memory written since the fence — permanently, because the
			// branch it reconciles against is frozen and will never list them.
			//
			// So ask the database too, exactly as the cutover CAS does before it
			// picks the same mode. Two witnesses, both cheap, both able only to
			// REFUSE the prune: the recorded cutover (which survives the deletion of
			// `.jolli/`, since it lives in the machine-global DB), and a count of
			// stored memories the pinned tip does not list (which also covers a
			// pre-cutover writer that landed rows the branch never saw).
			let seedLegal = !fence && !multiCheckout;
			if (seedLegal && orphanStorage) {
				if (hasCutoverRecord(db, repo.repoIdentity)) {
					log.warn(
						"%s has a recorded cutover but no fence on disk (profile.json wiped?) -- importing in catch-up mode; seeding would delete every memory written since the cutover",
						repo.repoName,
					);
					seedLegal = false;
				} else {
					const listed = new Set(
						(await orphanStorage.listFiles("summaries/"))
							.filter((p) => p.endsWith(".json"))
							.map((p) => p.slice("summaries/".length, -".json".length)),
					);
					// No try/catch: a throw here aborts this repo's pass, which is the
					// fail-closed outcome — the alternative is treating an unreadable
					// listing as "the branch lists nothing", i.e. prune everything.
					const unlisted = countMemoriesAbsentFromListing(db, repo.repoIdentity, listed);
					if (unlisted > 0) {
						log.warn(
							"%d of %s's stored memor%s absent from the orphan tip -- importing in catch-up mode; seeding would delete %s",
							unlisted,
							repo.repoName,
							unlisted === 1 ? "y is" : "ies are",
							unlisted === 1 ? "it" : "them",
						);
						seedLegal = false;
					}
				}
			}
			const sotMode = seedLegal ? "seed" : "catch-up";
			// The mode rides in the cursor: a repo that gains a second checkout (or a
			// fence) switches to catch-up with the tip standing still, and the two
			// modes do not write the same rows — catch-up never deletes. A tip-only
			// cursor would skip that first differing pass.
			// `--storage` (tests) has no tip and is deliberately ungated: the seam
			// exists to feed the importer arbitrary content, which by definition does
			// not move a commit hash.
			const sotCursor = orphanTip ? `${orphanTip}#${sotMode}` : null;
			// `!isBootstrap` for the same reason the commit tier carries it: a repo
			// whose bootstrap never completed may hold a cursor from a previous
			// database generation, and re-importing costs a pass while trusting it
			// costs the repo's memories.
			const sotUnchanged =
				!isBootstrap && sotCursor !== null && readCursor(db, repo.repoIdentity, CURSOR_SOT) === sotCursor;
			const sotImport = orphanStorage
				? sotUnchanged
					? // Nothing to do, and nothing worth printing — but the caller still
						// reports a memory count, so answer it from the database rather
						// than with the zero an absent result would produce ("Migrated 0
						// memories" on a healthy repo reads as data loss).
						{
							...EMPTY_IMPORT_RESULT,
							nodes: (
								db
									.prepare(
										`SELECT COUNT(*) AS n FROM memories
										  WHERE repo_id = (SELECT id FROM repos WHERE repo_identity = ?)`,
									)
									.get(repo.repoIdentity) as { n: number }
							).n,
						}
					: await importRepoMemory(db, {
							repo,
							nowMs: now(),
							storage: orphanStorage,
							mode: sotMode,
							...(protectMs !== undefined ? { protectNewerThanMs: protectMs } : {}),
							...(opts.onProgress
								? {
										onProgress: (p) =>
											opts.onProgress?.({
												repoName: repo.repoName,
												kind: "memories",
												done: p.done,
												...(p.total !== undefined ? { total: p.total } : {}),
											}),
									}
								: {}),
						})
				: undefined;
			// AFTER the import returned, never before: `importRepoMemory` resumes from
			// its own per-batch cursor, and a run killed halfway leaves rows the next
			// pass must still write. Advancing on entry would call that partial state
			// "current" and freeze it until the branch happened to move again.
			if (sotCursor && sotImport && !sotUnchanged) {
				writeCursor(db, repo.repoIdentity, CURSOR_SOT, sotCursor, now());
			}

			db.prepare("UPDATE repos SET bootstrap_state = 'done', last_ingested_at = ? WHERE repo_identity = ?").run(
				new Date(now()).toISOString(),
				repo.repoIdentity,
			);

			// The write-ahead log's retention pass. It normally rides `applyStatsEvents`,
			// which this path does NOT use — `applyBatches` calls `applyToDb` directly to
			// stay inside the one handle this whole pass holds. `events_raw.event_id` is
			// deliberately not unique (see SotSchema: the same event may be written
			// repeatedly, and idempotency lives in the projection tables), so without a
			// prune here a machine that only ever runs `jolli dashboard` / `jolli enable`
			// grows the log without bound. Bounded per pass and inside the lock we already
			// hold, exactly as on the writer path.
			const pruned = pruneProjectedEvents(db, now);
			if (pruned > 0) log.debug("pruned %d projected event rows for %s", pruned, repo.repoName);

			// The rollup settle every `applyToDb` normally does, hoisted out of the
			// batch loop to here — once for the whole pass, against its final state.
			// See `applyBatches` for why per batch is quadratic. Quiet and derived, so
			// a failure here costs a slower page and never the backfill.
			buildRollupQuietly(db, { now });

			const mode = isBootstrap ? "bootstrapped" : "recovered";
			log.info("%s %s: %d events applied", mode, repo.repoName, applied);
			return {
				mode,
				eventsApplied: applied,
				sotImport,
				repoName: repo.repoName,
				/* v8 ignore start -- the session tier assigns `sessionSummary` unconditionally and no path returns between it and here, so the empty-object arm is unreachable */
				...(sessionSummary ? { sessions: sessionSummary } : {}),
				/* v8 ignore stop */
			} as DbBackfillResult;
		},
		{ dbPath: opts.dbPath },
	);
}

/**
 * Reads every machine-global session store once, for the whole run.
 *
 * Dynamic imports throughout, matching `loadAllSessions`: several of these reach for
 * `node:sqlite`, and importing them eagerly would emit the ExperimentalWarning in
 * every process that loads this module without ever backfilling.
 *
 * Each scan is independent and all of them run concurrently — they touch different
 * stores, and one source failing must not delay or fail another. Every source is
 * given the back-fill's wider window, which is the whole reason the back-fill has its
 * own scan path rather than reusing the 48 h defaults.
 *
 * A partial result is kept rather than discarded: a scan that returns sessions AND an
 * error (Cline, whose flavours are scanned independently; Copilot Chat, whose
 * workspaces are) has genuinely found those sessions. Dropping them because a sibling
 * directory was unreadable would lose data the old per-repo path also kept — its
 * callers read `.sessions` and ignored `.error` for exactly this reason.
 *
 * `sources` narrows the fan-out and defaults to the whole registry, which is what the
 * back-fill wants. The one caller that narrows it is {@link dbRescanSessions}, whose
 * whole point is to touch a subset on a timer — and narrowing HERE rather than
 * filtering the RESULT matters: an unasked-for source must not be opened at all, not
 * merely have its sessions discarded afterwards.
 */
interface ScanAllStoresOptions {
	readonly alreadyRecorded?: AlreadyCurrent;
	readonly sources?: ReadonlyArray<SessionSourceDefinition>;
	/**
	 * Discovery horizon handed to every scanner, defaulting to the back-fill's.
	 *
	 * Threaded rather than hard-coded because the caller's own `windowMs` narrows the
	 * collector: with the scan pinned to one width and the collector to another, a caller
	 * asking for a wider window silently got nothing extra (nothing older than the pinned
	 * width was ever scanned) and one asking for a narrower one still paid for the wider
	 * scan. That is the "purely decorative parameter — no error, no warning, and a
	 * plausible-looking empty result" failure this file's own history documents.
	 */
	readonly windowMs?: number;
}

/** One source's scan failure, for the caller to report in its own words. */
interface ScanFailure {
	readonly source: TranscriptSource;
	readonly error: string;
}

/**
 * What {@link scanAllStores} found, and what it could not read.
 *
 * The failures are RETURNED rather than logged here, and that is the fix for a real
 * flood: this function is called once per `dbRescanSessions` tick, so one standing
 * condition (`~/.codex` permissions, an unmounted volume) was one WARN every 30
 * seconds — 2,880 a day, tick 1 and tick 2,880 indistinguishable — which is precisely
 * what `SessionRescanTask`'s once-per-situation reporting exists to prevent. It also
 * carried the `DbBackfill` module tag, so `grep AgentScan …/debug.log` did not return
 * it, contradicting that file's header promise.
 *
 * Reporting belongs to the caller for a second reason: the two callers' consequences
 * are OPPOSITE. The back-fill genuinely falls back to a per-repo scan; the re-scan
 * hands the collector an empty loader precisely so that fallback cannot run. That used
 * to be threaded back IN as an English sentence (`onFailure`) purely to interpolate
 * into the warn line here — the data layer carrying prose so it could describe a
 * decision it does not make.
 */
interface ScanAllStoresResult {
	readonly scanned: PreScannedSessions;
	readonly failures: ReadonlyArray<ScanFailure>;
}

/**
 * The AI-agent toggles, resolved ONCE for a whole pass and returned as a predicate.
 *
 * Every other surface honours these — the sidebar's Active Conversations, `jolli
 * status`, the post-commit summary, each hook-driven discovery pass — and this tier did
 * not. A user who switched Cursor off in Settings saw it vanish from the sidebar and
 * from their commit summaries while `jolli dashboard` kept scanning its store and
 * writing its sessions, tool calls and skills into the database on every run, forever.
 * The switch is one fact; it cannot mean "off" on four surfaces and "on" here.
 *
 * ONCE per pass, not once per repo: the config is machine-global
 * (`~/.jolli/jollimemory/config.json`), so asking per repo is the same answer re-read N
 * times inside a loop whose whole purpose is to hoist shared work out of it.
 *
 * A config that cannot be read answers ENABLED for everything — `loadConfig` already
 * returns `{}` for an absent or unparseable file, and `isSourceEnabled` treats every
 * value but an explicit `false` as on. Erring towards scanning is right here and is the
 * opposite of the repo-level disable switch's rule: a missing toggle has never meant
 * "off", so reading it as "off" would silently stop importing on a machine whose config
 * merely failed to load.
 *
 * Note this does NOT retroactively remove anything: rows a source wrote before it was
 * switched off stay in the database and stay on the page. "Off" means stop collecting,
 * not erase the history — deleting on a toggle would make an accidental click
 * unrecoverable, and the transcripts behind those rows are routinely gone.
 */
async function readSourceGate(): Promise<(source: TranscriptSource) => boolean> {
	const config = await loadConfig();
	return (source: TranscriptSource) => isSourceEnabled(source, config);
}

async function scanAllStores(opts: ScanAllStoresOptions): Promise<ScanAllStoresResult> {
	const { alreadyRecorded, sources = SESSION_SOURCES, windowMs } = opts;
	const scanned = new Map<TranscriptSource, ReadonlyArray<unknown>>();
	const failures: ScanFailure[] = [];
	// Concurrent, and the results are collected by source tag rather than positionally:
	// a positional destructure is a second ordering to keep in step with the registry,
	// and getting it wrong would file one agent's sessions under another's name.
	await Promise.all(
		sources.map(async (def) => {
			// `alreadyRecorded` reaches only the definitions that declare they use it —
			// the two whose per-session read is expensive enough to be worth skipping.
			// Passing it to the rest would be harmless but misleading: it would read as a
			// promise that every scanner honours it.
			const opts = {
				windowMs: windowMs ?? BACKFILL_SESSION_WINDOW_MS,
				...(alreadyRecorded && def.usesAlreadyRecorded ? { alreadyRecorded } : {}),
			};
			try {
				const result = await def.scan(opts);
				// A source is recorded ONLY on success. Absence is what tells the collector
				// to fall back to that source's per-repo scan; recording `[]` for a failed
				// scan would claim the store was read and found empty, and the fallback that
				// exists precisely for this case would never run.
				scanned.set(def.source, result as ReadonlyArray<unknown>);
			} catch (err) {
				// The FACT is this function's; the CONSEQUENCE belongs to the caller. See
				// {@link ScanAllStoresResult} for why nothing is logged here.
				failures.push({ source: def.source, error: errMsg(err) });
			}
		}),
	);
	return { scanned: Object.fromEntries(scanned) as PreScannedSessions, failures };
}

/**
 * {@link scanAllStores} for the callers that want one WARN per failing source, now.
 *
 * The back-fill's shape: it runs when a user asked for it, so a line per failing source
 * per run is proportionate, and `consequence` is that caller's own sentence about what
 * happens to those sessions. `dbRescanSessions` deliberately does NOT use this — at
 * 30-second cadence the same line is 2,880 a day, so it carries the failures out to
 * `SessionRescanTask`, which says them once per situation under the `AgentScan` tag.
 */
async function scanAllStoresLoggingFailures(
	opts: ScanAllStoresOptions,
	consequence: string,
): Promise<PreScannedSessions> {
	const { scanned, failures } = await scanAllStores(opts);
	for (const failure of failures) {
		log.warn("%s scan failed -- %s: %s", failure.source, consequence, failure.error);
	}
	return scanned;
}

/**
 * One machine-wide answer to "is this session already recorded, everywhere it
 * matters?", for the SCANNERS to consult before they pay for an expensive read.
 *
 * ## Why this exists at all, given the per-repo skip already does
 *
 * The per-repo `isAlreadyCurrent` runs after the scan, so it saves the second read
 * of a transcript and not the first. Claude's scan already reads and parses every
 * in-window transcript in full (to collect the working directories a `cd` scattered
 * through the file), and Antigravity's already opens one SQLite per conversation. On
 * a converged re-run — nothing to update, which is the normal case — all of that was
 * still paid, so a repeat `jolli dashboard` cost roughly half of a first one for no
 * result. This moves the decision to where the scanner can act on it.
 *
 * ## The rule, and the two ways of getting it wrong
 *
 * A session is "already recorded" when EVERY repo holding a row for it is at or past
 * `updatedAtMs`. Two tempting variants are both wrong:
 *
 *  - **"every registered repo has a current row"** — a Claude session belongs to one
 *    repo, so on a machine with three registered repos the other two never have a
 *    row and the condition never holds. The optimisation would silently do nothing
 *    the moment a second repo was registered.
 *  - **"some repo has a current row"** — right for the steady state, wrong the first
 *    time a NEW repo is registered: that repo's rows do not exist yet, and skipping
 *    on another repo's evidence would leave it permanently without them.
 *
 * The MINIMUM over the repos that do have a row answers the first, and the
 * generation gate below answers the second: a repo that has never completed a
 * session pass turns scan-level skipping OFF for the whole run, so it gets one full
 * scan and every later run gets the fast path.
 *
 * Returns `undefined` when nothing may be skipped — no repo, a repo still on an
 * older read generation, or a database that could not be read. Absence is the safe
 * answer: it costs one full scan.
 */
async function readRecordedSessions(
	live: ReadonlyArray<RegisteredRepo>,
	dbPath?: string,
): Promise<AlreadyCurrent | undefined> {
	/* v8 ignore start -- the only caller (dbBackfillRepos, ~line 2628) is guarded by `live.length === 0 || … ? {} : readRecordedSessions(live, …)`, so this is never reached with an empty list */
	if (live.length === 0) return undefined;
	/* v8 ignore stop */
	try {
		return await withDashboardDb(
			(db) => {
				// Every live repo must be past the gate. One that is not gets a pass with no
				// skipping at all — see this function's header for the new-repo case.
				for (const repo of live) {
					if (readCursor(db, repo.repoIdentity, CURSOR_SESSIONS_GENERATION) !== SESSION_READ_GENERATION) {
						return undefined;
					}
				}
				// The minimum stored instant per session, across the repos that hold a row.
				const floor = new Map<string, number>();
				for (const repo of live) {
					for (const [key, instant] of readKnownSessions(db, repo.repoIdentity)) {
						const seen = floor.get(key);
						if (seen === undefined || instant < seen) floor.set(key, instant);
					}
				}
				if (floor.size === 0) return undefined;
				return (source: TranscriptSource, sessionId: string, updatedAtMs: number) => {
					const stored = floor.get(`${source}:${sessionId}`);
					return stored !== undefined && stored >= updatedAtMs;
				};
			},
			dbPath ? { dbPath } : {},
		);
	} catch (err) {
		// A database that cannot be read is not a failure worth reporting here: the
		// per-repo passes will hit the same problem and report it properly. All that is
		// lost is the fast path.
		log.debug("cannot pre-read recorded sessions -- scans will not skip: %s", errMsg(err));
		return undefined;
	}
}

/**
 * Backfills every repo into the dashboard database, independently — one broken repo (deleted
 * worktree, git failure) must not stop the others from importing.
 */
export async function dbBackfillRepos(
	repos: ReadonlyArray<RegisteredRepo>,
	opts: Omit<DbBackfillOptions, "repo" | "onProgress"> & {
		/** Same events as the per-repo callback, plus where this repo sits in the run. */
		readonly onProgress?: (progress: DbBackfillProgress) => void;
	},
): Promise<ReadonlyArray<DbBackfillResult>> {
	// Pulled out of the spread: the two callbacks have different shapes, and
	// letting the wide one ride along on `...rest` would hand `dbBackfillRepo` a
	// function expecting fields it never supplies.
	const { onProgress: forward, ...rest } = opts;
	// A repo whose every recorded checkout is gone is dropped BEFORE the sweep,
	// not swept and warned about. `existingWorktrees` deliberately falls back to
	// the recorded path rather than returning nothing, so sweeping such an entry
	// runs `git` against a directory that does not exist: three warnings per repo
	// per pass (HEAD unreadable → collection failed → prune skipped), on every
	// `jolli dashboard` launch, forever — nothing prunes the registry, and no
	// mutation removes an entry. It is also not a failure worth a `mode: "skipped"`
	// result, which the caller prints as "migration failed": there is no repo left
	// to migrate.
	//
	// Deliberately NOT deregistration: the same predicate answers "temporarily
	// unmounted" (network share, external drive, a worktree being recreated), and
	// forgetting a repo on that evidence would throw away its registration for a
	// directory that comes back. Skipping costs one converged pass; the entry is
	// picked up again the moment a path exists.
	//
	// It IS reported, as `mode: "unavailable"`, and that is the half the log line
	// alone cannot do. `log.debug` (and `log.info`) are suppressed from the
	// terminal in CLI mode by design, so a repo that quietly stopped being
	// imported — the unmounted-share case, where the user still expects their
	// memories to keep arriving — had no signal anywhere the user looks. A result
	// row lets the caller say it once per run, in the terminal it owns, without
	// resurrecting the three warnings per repo per pass this replaced.
	const unavailable: DbBackfillResult[] = [];
	// A repo the user switched off is dropped from the sweep for the same reason it
	// keeps a result row: nothing may be imported for it, but its PAUSED STATE still
	// has to reach the database. Filtering it out further upstream (in
	// `listActiveRepos`, where the same predicate lives) would leave
	// `repos.disabled_at` NULL forever, so a repo disabled from the VS Code sidebar
	// would keep counting in every KPI and reading as enabled on the page — the
	// second half of the bug this change closes, and the half that has no other
	// caller to fix it.
	//
	// Deliberately UNREPORTED to the terminal, unlike `unavailable`. That one is
	// printed because "no checkout on disk" is also what an unmounted share looks
	// like, and the user is still expecting those memories; this one is the user's
	// own decision, already visible as the paused row on the page they are opening.
	// Announcing it on every launch would be noise about a state they chose.
	const disabled: DbBackfillResult[] = [];
	const pausedRepos: RegisteredRepo[] = [];
	const live = repos.filter((repo) => {
		if (!hasLiveWorktree(repo)) {
			log.debug("skipping %s -- no registered worktree exists on disk (%s)", repo.repoName, repo.worktreeRoot);
			unavailable.push({ mode: "unavailable", eventsApplied: 0, repoName: repo.repoName });
			return false;
		}
		if (isRepoDisabled(repo)) {
			log.debug("skipping %s -- Jolli is switched off in every checkout", repo.repoName);
			disabled.push({ mode: "disabled", eventsApplied: 0, repoName: repo.repoName });
			pausedRepos.push(repo);
			return false;
		}
		return true;
	});
	// ONE open for the whole paused set, and none at all when it is empty —
	// `dbBackfillRepos([])` must stay a no-op that cannot bring a database into
	// existence.
	let paused: ReadonlyArray<DbBackfillResult> = disabled;
	if (pausedRepos.length > 0) {
		try {
			await withDashboardDb(
				(db) => {
					for (const repo of pausedRepos) {
						projectRepoRegistryState(db, repo, rest.now ? { now: rest.now } : {});
					}
				},
				rest.dbPath ? { dbPath: rest.dbPath } : {},
			);
		} catch (err) {
			// Reported, not swallowed: an unprojected pause is the exact state this
			// block exists to remove, and the row keeps reading as enabled until some
			// later run manages it. Downgraded to `skipped` because that is the mode the
			// caller already prints per repo — `disabled` is deliberately silent, which
			// is right for success and wrong for this.
			const error = errMsg(err);
			log.warn("cannot project paused repos: %s", error);
			paused = disabled.map((row) => ({ ...row, mode: "skipped" as const, error }));
		}
	}
	// ONE read of each machine-global store for the whole run, hoisted out of the loop
	// below. Not one of these stores is keyed by repo — Claude by a lossily encoded
	// path, Codex by DATE, OpenCode / Copilot CLI / Devin / Cursor by nothing at all
	// (one database for every project), Cline by editor flavour, Copilot Chat and
	// Cursor by a VS Code workspace hash — so "which sessions are this repo's" can only
	// be answered after opening the records. Scanning per repo therefore re-opens the
	// same records once per registered repo. Measured on a three-repo machine: Claude
	// 64 transcripts (36 ms of head/tail reads, 464 ms of full parse), Codex 68 ms per
	// repo against 201 ms across three, all of it repetition.
	//
	// The nine below were previously left per-repo on the strength of that same
	// profile, where they cost under a millisecond between them. That was the wrong
	// conclusion from a correct measurement: those sources were not INSTALLED on the
	// profiling machine, so each returned on its first `readdir`. On a machine that
	// actually runs Cursor, Copilot and Cline, each per-repo pass is a real SQLite open
	// plus a full-table scan, or a JSON parse of the user's entire task history.
	//
	// They all run concurrently because they touch different stores and no one's
	// failure should delay another's.
	//
	// A caller may supply its own scans (tests, and any embedder that already has
	// them); a supplied value wins and no scan happens here for that source.
	//
	// Failure is NOT fatal and must not be: every source scans its own store
	// independently, so one failed scan costs that source its pre-48 h reach and
	// nothing else. Claude degrades furthest but not to zero — the `sessions.json` half
	// of the collector still carries it.
	//
	// Read BEFORE the scans and not inside them: the answer is one query per repo
	// against a database the scanners know nothing about, and asking per transcript
	// would put a database round trip inside the fan-out it is meant to shorten.
	// There is no consumer for a run-wide scan when every registered checkout is
	// unavailable. Apart from wasting startup time, scanning here used to open the
	// user's real agent stores even though the loop below had no repo to attribute a
	// single result to.
	//
	// A custom loader is an ownership boundary too: callers inject it specifically to
	// define the session set (tests are one caller, embedders are another). Adding real
	// home-directory scans on top makes that seam non-deterministic and can project
	// sessions the injected loader never returned. An explicitly supplied `preScanned`
	// value still wins, so callers that own both halves can opt into the combination.
	//
	// COST: this binding is RESIDENT for the whole multi-repo run — it cannot be freed per
	// repo, because which repo claims a session is only known after `forRepo` runs and any
	// of them may claim any of it. What it holds is now bounded per session: identity, an
	// instant, and the directories the session recorded.
	//
	// It used to hold each Claude session's whole parse as well (the entries plus the
	// transcript's own lines), so a 7-day window kept every transcript in memory at once —
	// over 100 MB on this repo's own 64-file corpus, growing linearly with the window and
	// with nothing capping the total. `withIoBudget` does not help: that budget caps bytes
	// IN FLIGHT, released the moment a read returns, and says nothing about what a caller
	// then keeps. So the parse is no longer carried, and the collector reads each
	// transcript itself (see `acceptFacts` for what that costs instead).
	//
	// Do not reintroduce a carried parse here without a byte cap on the total.
	// Resolved before the scan and threaded into BOTH halves — the machine-wide scan
	// here and each repo's collect below. Two call sites for one fact because they
	// consume it in different shapes (a narrowed definition list vs. a predicate), and
	// narrowing only the scan would be worse than not narrowing at all: absence from
	// `preScanned` is precisely what makes the collector fall back to that source's
	// PER-REPO scan, so a store skipped once here would be opened once per repo instead.
	const allowSource = await readSourceGate();
	const enabledSources = SESSION_SOURCES.filter((def) => allowSource(def.source));
	if (enabledSources.length < SESSION_SOURCES.length) {
		const off = SESSION_SOURCES.filter((def) => !allowSource(def.source)).map((def) => def.source);
		log.info("skipping %d switched-off source(s): %s", off.length, off.join(", "));
	}
	const preScanned =
		rest.preScanned ??
		(live.length === 0 || rest.loadSessions
			? {}
			: await scanAllStoresLoggingFailures(
					{
						alreadyRecorded: await readRecordedSessions(live, rest.dbPath),
						sources: enabledSources,
					},
					// The back-fill's own consequence, which is NOT the re-scan's: absence from
					// `preScanned` is what makes the collector fall back to this source's per-repo
					// scan, so the sessions may still be picked up. Once per run, because a
					// back-fill is something a user asked for — unlike the 30-second tick, whose
					// caller says this once per situation instead.
					"back-fill falls back to per-repo scans for it",
				));

	const results: DbBackfillResult[] = [];
	for (const [i, repo] of live.entries()) {
		// The index is injected here rather than passed down, so `dbBackfillRepo`
		// stays ignorant of the list it happens to be in.
		const perRepo = forward
			? { onProgress: (p: RepoProgress) => forward({ ...p, repoIndex: i + 1, repoTotal: live.length }) }
			: {};
		try {
			results.push(
				await dbBackfillRepo({
					...rest,
					...perRepo,
					preScanned,
					isSourceAllowed: allowSource,
					repo,
				}),
			);
		} catch (err) {
			log.error("db backfill failed for %s: %s", repo.repoName, errMsg(err));
			// Carried on the result, not just logged: the caller is the only thing
			// with a terminal, and a repo that failed to import must not look
			// identical to one that had nothing to do.
			results.push({ mode: "skipped", eventsApplied: 0, repoName: repo.repoName, error: errMsg(err) });
		}
	}
	// Route A: backfill `session_activity` from the persisted transcripts, whole
	// DB once — after every repo has been imported, so the rows reference sessions
	// the loop above just wrote. Idempotent (0 once converged); a failure is a
	// warning, never a failed import.
	try {
		const covered = await withDashboardDb((db) => backfillStoredActivity(db), {
			...(rest.dbPath ? { dbPath: rest.dbPath } : {}),
		});
		if (covered > 0) log.info("backfilled activity for %d stored sessions", covered);
	} catch (err) {
		log.warn("activity backfill failed: %s", errMsg(err));
	}
	// Appended, not prepended: a caller reading the list in order should see the
	// repos that were worked on first, and these carry no per-repo detail to
	// interleave with them.
	return [...results, ...paused, ...unavailable];
}

/** Options for {@link dbRescanSessions}. */
export interface SessionRescanOptions {
	/** Registry entries to consider. Ones with no checkout left on disk are dropped. */
	readonly repos: ReadonlyArray<RegisteredRepo>;
	/**
	 * Which sources to re-scan, defaulting to the registry entries that opted in.
	 *
	 * An empty list is a valid answer and means "do nothing" — see
	 * {@link DAEMON_RESCAN_SOURCES} and `SessionSourceSpec.daemonRescan` for the one
	 * property a source must have before a timer over it can find anything.
	 */
	readonly sources?: ReadonlyArray<SessionSourceDefinition>;
	/** Discovery horizon. Defaults to the back-fill's, so both passes see one set. */
	readonly windowMs?: number;
	/** Test seam: path override for the dashboard DB. */
	readonly dbPath?: string;
	readonly now?: () => number;
	readonly producerKind?: ProducerKind;
	/** Test seam: use these scan results instead of reading the real stores. */
	readonly preScanned?: PreScannedSessions;
	/**
	 * The gate that stops a session whose file has NOT changed from being emitted again.
	 *
	 * Maps a {@link sessionEventId} to the mtime this pass last emitted an event for.
	 * OWNED BY THE CALLER and mutated here, because it has to outlive one tick — the
	 * task holds it, which also keeps each task instance clean and lets a test drive
	 * several ticks against one map.
	 *
	 * ## What it is for, and why the two existing gates cannot do it
	 *
	 * Both of those read the projection's OUTPUT: `readKnownSessions` queries the
	 * `sessions` table and `unchangedSessionEvent` compares against the stored row. A
	 * session whose event FAILED to project has no row for either of them to see, so
	 * both answer "never processed" — the transcript is re-read and an identical event
	 * is appended to `events_raw` on every single tick, forever, and those rows are
	 * never pruned (the prune only deletes `projected` ones). This map is the only
	 * thing that can answer "I already emitted for this version", because it records
	 * what this pass DID rather than what the projection achieved.
	 *
	 * ## Why the recorded value is the OBSERVED mtime and never a write instant
	 *
	 * The mtime is sampled BEFORE the transcript is read, so the value stored here is
	 * always at or before the content actually read. The next tick's mtime is therefore
	 * greater whenever anything was appended, and the worst this gate can do is cause
	 * one redundant re-read. Recording the WRITE instant instead reverses the direction
	 * of that error: everything appended between the read and the insert would be
	 * stamped already-seen and become permanently invisible if the session then stopped.
	 *
	 * Deliberately NOT persisted. A restart re-seeds it from the log — see
	 * {@link seedEmitted} — which is what keeps a restart from re-emitting for every
	 * already-parked session.
	 *
	 * ## REQUIRED, and that is the whole guarantee
	 *
	 * It used to default to a fresh `new Map()`. That reads as a harmless convenience and
	 * is the bug back: a caller that omits it gets a gate scoped to ONE invocation, so
	 * every discovered session looks un-emitted and one identical `events_raw` row is
	 * written per session per call — the ~2,880-rows-a-day growth this map exists to stop,
	 * reachable again by leaving out one argument, with no type error and no failing test.
	 * A future caller (a VS Code tick, an ide-bridge action, a `jolli doctor --fix`, a
	 * second daemon task) must therefore decide where the state lives before it can call
	 * this at all. Nothing may reintroduce a default here.
	 */
	readonly emitted: Map<string, number>;
	/**
	 * Seed {@link emitted} from the write-ahead log during this pass.
	 *
	 * Set on a process's FIRST tick only. Seeding is a full table scan, and repeating
	 * it would put that scan on the 30-second path — which is exactly what holding the
	 * map in memory exists to avoid.
	 */
	readonly seedEmitted?: boolean;
	/**
	 * Cap on {@link emitted}, which is the caller's memory budget for it.
	 *
	 * Enforced by REFUSING NEW KEYS once reached — never by clearing the map. That is the
	 * opposite of the whole-map policy the two `CodexSessionDiscoverer` memos use, and the
	 * asymmetry is the point: their refill is one `readdir` or one first-line read, while
	 * this map's refill is a full scan of the largest table in the database PLUS
	 * re-emitting an event for every already-parked session. Clearing it therefore cannot
	 * converge — the seed is drawn from the same population that just overflowed, so the
	 * next tick refills past the limit and clears again, every 30 s for the machine's whole
	 * uptime, with the gate empty the entire time. Refusing new keys degrades instead: the
	 * newest `emittedLimit` sessions stay gated and anything beyond them is re-read as it
	 * was before the gate existed.
	 *
	 * Refreshing a key the map already holds is always allowed — that is the freshness
	 * update the gate runs on, and it cannot grow the map.
	 *
	 * ## The seed alone can consume the whole budget
	 *
	 * `readEmittedFromLog` is given this same number as its `LIMIT`, so on a database with at
	 * least this many distinct session events the FIRST tick fills the map before phase 2 has
	 * scanned anything — and from then on no session discovered this process's whole life can
	 * enter it. That is the degradation above rather than a separate fault (the seed IS the
	 * newest `emittedLimit` sessions), and it is left as is deliberately: with the cap at
	 * 50,000 and `projected` rows pruned at `PROJECTED_RETENTION_DAYS`, reaching it needs a
	 * population no real machine produces. Worth stating because the arithmetic is invisible
	 * at the call site, and because the reason it is tolerable is the SIZE of the cap — halve
	 * it and the honest fix is to seed to a fraction of the budget rather than all of it, so
	 * the sessions this tick discovers still have somewhere to go.
	 */
	readonly emittedLimit?: number;
	/**
	 * Called once, the moment the seed has been merged into {@link emitted}.
	 *
	 * A CALLBACK rather than a field on the result, because the caller's use for it is a
	 * once-per-process flag and a result cannot be observed when the call REJECTS. Two
	 * failure sites live after the seed — phase 3's `withDashboardDb` (write contention
	 * with a git hook is enough) and anything `applyBatches` throws — so keying the flag
	 * off the resolved value meant a standing fault put the full-table scan back on the
	 * 30-second path while the merge it produced was already in memory and paid for.
	 */
	readonly onSeeded?: () => void;
}

/**
 * What one {@link dbRescanSessions} pass did — enough for a single log line, with
 * nothing the caller would have to reopen the database to learn.
 */
export interface SessionRescanResult {
	/** Repos actually worked on: a live checkout AND a session baseline. */
	readonly reposScanned: number;
	/** Live repos passed over for want of a baseline. See {@link dbRescanSessions}. */
	readonly reposWithoutBaseline: number;
	/**
	 * Sessions seen across those repos, counted per repo — two checkouts of one
	 * project each claiming the same conversation count it twice, on the same basis
	 * the back-fill's own per-source totals are counted.
	 */
	readonly discovered: number;
	/** Sessions that were not skipped, i.e. re-read in full and re-projected. */
	readonly processed: number;
	readonly eventsApplied: number;
	/** Sources whose machine-wide scan failed this pass. */
	readonly failedSources: ReadonlyArray<TranscriptSource>;
	/**
	 * Events parked unprojected across the WHOLE database, not just this pass's repos.
	 *
	 * Machine-wide on purpose: it is a health number, and the daemon is the one process
	 * that can report it without a user asking.
	 *
	 * Counts only the parked events this build cannot revive by itself — see
	 * {@link countStuckEvents}. The `unknown-type` rows a later build un-parks on its next
	 * writable open are excluded, because warning about those tells the user to look at
	 * something that is already fixing itself.
	 */
	readonly failedEvents: number;
	/**
	 * Why the pass did nothing, when it did nothing for a reason that is not "no repo
	 * has a baseline yet".
	 *
	 * Three separate situations used to arrive at the caller as one all-zero result,
	 * and it rendered them all as "no baseline yet for 0 repo(s) -- run 'jolli
	 * dashboard' once": a suggestion that would change nothing, for a count of zero,
	 * about repos that may not exist. `no-sources` is the documented one-line off
	 * switch (`DAEMON_RESCAN_SOURCES` empty), which is supposed to read as "nothing to
	 * do"; `no-live-repos` is every registered checkout having been deleted; and
	 * `no-database` is a machine that has never opened the dashboard, which this pass
	 * answers rather than fixes — see the docblock on why a background timer must not
	 * create the database.
	 *
	 * `database-unusable` is the fourth, and it is deliberately NOT folded into
	 * `no-database`: the file is there and cannot be read. `existsSync` answers only the
	 * first of those questions — a zero-byte or truncated `jollimemory.db` (a crashed
	 * create, an interrupted copy, a disk that filled) opens READ-ONLY without error and
	 * throws on the first statement instead. Left as a rejection it became one warn for the
	 * daemon's entire lifetime followed by permanent silence, because the once-only dedup
	 * keys on the message; as an idle reason it is reported like any other outcome and
	 * `jolli doctor` can say so too.
	 *
	 * Reported rather than derived by the caller. The derivation is available today —
	 * all-zero plus a non-empty source list can only mean no live checkout — but it is
	 * an inference across a module boundary that a fifth early return would silently
	 * invalidate.
	 */
	readonly idleReason?: "no-sources" | "sources-disabled" | "no-live-repos" | "no-database" | "database-unusable";
}

/**
 * Re-projects a FEW sources' sessions across every registered repo — the global
 * daemon's timer tick.
 *
 * ## Why this is not `dbBackfillRepos`
 *
 * The two answer different questions. `jolli dashboard` rebuilds everything a repo
 * has (git history, summaries, the SOT import, worktree state), which on a two-repo
 * machine measured 22 s and 11 s in the git tier alone — fine for something a user
 * asked for, impossible on a timer. This pass touches ONE tier and only the sources
 * that opted in, so a converged tick parses no transcript and writes no session row.
 * It is not free: the scan still stats every rollout on disk and reads the first line
 * of every rollout inside the window, and phase 1 below still opens the database. See
 * `SessionRescanTask`'s header for what the interval is actually a budget against.
 *
 * It also deliberately shares the parts where drift would be invisible:
 * {@link alreadyCurrentFrom} is the same predicate, `collectSessionEvents` is the
 * same collector, `unchangedSessionEvent` is the same no-op filter, and `applyBatches`
 * is the same idempotent writer. A session re-read here produces exactly the row a
 * dashboard run would have produced — and, because the filter is shared too, it
 * produces exactly the same `events_raw` rows as well, which at this cadence is the
 * half that matters (see phase 3).
 *
 * ## Why a repo needs a baseline first — and why ANY generation is one
 *
 * A repo that has never completed a full session pass has no trustworthy set of stored
 * instants to compare against: `readKnownSessions` would answer with an empty or partial
 * map, every discovered session would look new, and the timer would re-parse the repo's
 * whole 7-day history on its first tick. `CURSOR_SESSIONS_GENERATION`'s PRESENCE is what
 * rules that out, so a repo with no cursor at all is passed over and one
 * `jolli dashboard` run establishes it.
 *
 * The presence, NOT the value — and that distinction is the whole point of this
 * paragraph. Requiring an exact match against {@link SESSION_READ_GENERATION} was the
 * original spelling and it made every generation bump switch this feature OFF for every
 * installed machine: on upgrade each repo still carries the previous number, so `ready`
 * is empty everywhere, the pass warns once about a missing baseline, and the timer does
 * nothing until the user opens the dashboard. That is exactly the user this task exists
 * for — "a user who never opens the dashboard … had that usage recorded nowhere". The
 * value has no work to do here either: what a generation bump buys is a full RE-READ so
 * an improved scanner reaches already-stored sessions, and that is the back-fill's job
 * (`readRecordedSessions` still demands an exact match, deliberately — do not loosen
 * that one). A repo on an older generation has real read receipts; they are simply the
 * old scanner's, which is the same state the timer leaves an unchanged session in
 * anyway.
 *
 * Note the seed case is NOT what this gate protects against, despite being the obvious
 * reading: `readKnownSessions` already excludes a commit-summary seed per row, by
 * requiring `started_at_ms`/`duration_ms`. `projectSession` carries the same predicate
 * for the same reason — see the monotonic guard there.
 *
 * ## What this must never write
 *
 * `CURSOR_SESSIONS_GENERATION` — it is the claim "a FULL session pass completed for
 * this repo", and this pass reads a subset of sources by design. Writing it would
 * turn on scan-level skipping for the eleven sources this tick never looked at, whose
 * rows may not exist yet. `CURSOR_SESSIONS` is left alone too: it is observability
 * for the back-fill's own progress, and a timer advancing it would describe work the
 * back-fill did not do.
 *
 * ## What runs concurrently, and the one barrier that remains
 *
 * The expensive half — reading and parsing the conversations that moved — is a SHARED
 * QUEUE, not a per-source batch. `collectSessionEvents` merges every source's
 * sessions into one list before it fans out, and `mapWithConcurrency` hands its 8
 * workers the next item off that list as each finishes. So a source with fifty
 * changed conversations and one with two do not get a worker each: they share all
 * eight, and no worker idles while another source still has work. That property is
 * what makes adding sources safe, and it is the collector's, not this function's.
 *
 * The barrier is EARLIER, in `scanAllStores`: its `Promise.all` means every source's
 * store must be read before the first conversation is parsed. Today that costs
 * nothing measurable — a scan is one `stat` per file (~10 ms across 460 Codex
 * rollouts) against tens of milliseconds of parsing — and with one opted-in source
 * there is nothing to wait for at all. It becomes worth removing only if some future
 * source's SCAN approaches its parse cost (a scan that opens a SQLite per
 * conversation, say), and the fix then is to stream each source's result into the
 * shared queue as it lands rather than to widen anything.
 *
 * Repos are walked one at a time; see the comment on that loop for why concurrency
 * there would add contention rather than throughput.
 *
 * ## The emission gate, and why it is half in memory and half in the log
 *
 * `emitted` is what stops a session whose projection FAILED from being re-read and
 * re-emitted on every tick. Neither existing gate can: both read the projection's
 * OUTPUT, and a failed projection has none, so both answer "never processed" forever.
 * Left alone that is one identical `events_raw` row every 30 s — 2,880 a day, never
 * pruned, because the prune only deletes `projected` rows — plus five projection
 * attempts and their log lines for each. It records what this pass DID, not what the
 * projection achieved, which is the one question that distinguishes the two states.
 *
 * The value recorded is the OBSERVED mtime, sampled before the transcript is read, so
 * it can only ever cause a redundant re-read and never a missed append. A write
 * instant would reverse that; see `SessionRescanOptions.emitted`.
 *
 * It lives in the CALLER's memory and is SEEDED from the log at startup, and both
 * halves are load-bearing. Memory keeps the per-tick cost at a hash lookup instead of
 * a full scan of the largest table — `events_raw` has no `event_id` index, on purpose.
 * The seed is what stops a restart re-emitting once for every already-parked session.
 * The residue of that choice is that a restart no longer RETRIES a parked session
 * either, so a session whose projection a later build could handle is healed by
 * `jolli dashboard` rather than by the next restart — accepted, and the reason the
 * back-fill deliberately does not share this gate.
 *
 * ## Why the database is opened twice rather than held
 *
 * The scan and the per-session reads are disk I/O measured in hundreds of
 * milliseconds, and every dashboard write takes SQLite's single writer lock. Holding
 * the handle across the scan would put a background timer between a user's git hook
 * and the lock it needs, every 30 s. So: read baselines, close, scan and collect with
 * nothing held, reopen only to apply. (The handle would in fact survive an async
 * callback — `withDashboardDb` awaits inside its `try` — so this is about lock
 * duration, not correctness.)
 *
 * Phase 1 is the READ-ONLY handle and phase 3 the writable one, which is the boundary
 * `DashboardDb`'s header calls hard. Phase 1 only reads two cursors, a session map and
 * a count, so the writable handle bought it nothing and cost it three things at
 * 30-second cadence: the migration pass and the ownership chmod ran 2,880 times a day,
 * the open contended with git hooks and the extension tick for SQLite's single writer,
 * and on a machine that had never opened the dashboard a background timer CREATED the
 * database. The last of those is why the swap needed more than a handle change — a
 * read-only open throws where the writable one creates — so an absent database is now
 * an explicit idle answer (`idleReason: "no-database"`) rather than a reason to make
 * one. Phase 3 stays writable because it writes.
 */
export async function dbRescanSessions(opts: SessionRescanOptions): Promise<SessionRescanResult> {
	// Narrowed by the AI-agent toggles, exactly like the back-fill and for the same
	// reason — see {@link readSourceGate}. A timer is the surface where ignoring the
	// switch is least defensible: a user who turned Codex off would have had its rollout
	// tree stat-ed and its moved conversations re-read every 30 seconds for the machine's
	// whole uptime, with nothing on any screen to show it was still happening.
	//
	// Only the source list needs it here, unlike the back-fill: this pass hands the
	// collector an EMPTY loader, so the hook registry — the route that carries a
	// switched-off source's rows past a narrowed registry — is never read at all.
	const requested = opts.sources ?? DAEMON_RESCAN_SOURCES;
	const allowSource = await readSourceGate();
	const sources = requested.filter((def) => allowSource(def.source));
	const now = opts.now ?? Date.now;
	// `bootstrap`, like the back-fill: this reconstructs state from records already on
	// disk, which is what that producer means. Deliberately not a new `ProducerKind` —
	// the tag is stored on every event row, and adding a value for a pass whose output
	// is byte-identical to the back-fill's would split one fact across two names.
	const producerKind = opts.producerKind ?? "bootstrap";
	const windowMs = opts.windowMs ?? BACKFILL_SESSION_WINDOW_MS;
	const dbOpts = opts.dbPath ? { dbPath: opts.dbPath } : {};
	const emitted = opts.emitted;
	const emittedLimit = opts.emittedLimit;
	/**
	 * Records one emission, honouring the caller's cap.
	 *
	 * Refusing a NEW key when full, never clearing — see
	 * {@link SessionRescanOptions.emittedLimit} for why the whole-map policy the memos use
	 * cannot converge here. Refreshing a key already present is always allowed: it is the
	 * freshness update the gate runs on and it cannot grow the map.
	 */
	const rememberEmitted = (key: string, mtimeMs: number): void => {
		if (emittedLimit !== undefined && emitted.size >= emittedLimit && !emitted.has(key)) return;
		emitted.set(key, mtimeMs);
	};
	/** The all-zero answer, for every path that returns before phase 1 measured anything. */
	const idleWith = (idleReason: SessionRescanResult["idleReason"]): SessionRescanResult => ({
		reposScanned: 0,
		reposWithoutBaseline: 0,
		discovered: 0,
		processed: 0,
		eventsApplied: 0,
		failedSources: [],
		// Every path that uses this returns BEFORE phase 1 reads the database, so this is
		// genuinely unknown rather than zero. Reported as 0 because the caller's only use
		// is "warn once when it is non-zero", and a guess would be worse than a pass that
		// stays quiet.
		failedEvents: 0,
		idleReason,
	});

	// Two different situations, two different answers, and collapsing them would print a
	// sentence that is false: `no-sources` is the documented one-line off switch (no
	// definition declares `daemonRescan`), while `sources-disabled` means one DID and the
	// user switched that agent off. Telling them "no source has opted in" describes the
	// build rather than their own decision.
	if (sources.length === 0) return idleWith(requested.length === 0 ? "no-sources" : "sources-disabled");
	// Same predicate the back-fill uses, and for the same reason: `existingWorktrees`
	// falls back to the recorded path, so a repo whose checkout is gone would have this
	// pass narrowing sessions against a directory that does not exist.
	const live = opts.repos.filter(hasLiveWorktree);
	if (live.length === 0) return idleWith("no-live-repos");

	// A read-only open THROWS on an absent file where the writable one creates it, and a
	// background timer has no business creating a machine-global database — so absence is
	// answered here rather than discovered inside phase 1. Checked on the same path the
	// handle would use, `dbPath` seam included, so a test cannot land on a different file
	// than the one this decision was made about.
	if (!existsSync(opts.dbPath ?? getDashboardDbPath())) return idleWith("no-database");

	// Phase 1 — baselines, the emission-gate seed, and the health count. One short
	// READ-ONLY open with no I/O inside it; see the docblock on why the handle matters
	// here even though every statement below is a SELECT.
	let phase1: {
		readonly baselines: Map<string, ReadonlyMap<string, number>>;
		readonly seed: Map<string, number> | undefined;
		readonly failedEvents: number;
	};
	try {
		phase1 = await withReadonlyDashboardDb((db) => {
			const baselines = new Map<string, ReadonlyMap<string, number>>();
			for (const repo of live) {
				// PRESENCE, not equality — see "why ANY generation is one" in the docblock. An
				// exact match against this build's number turned every generation bump into a
				// silent, machine-wide off switch for this whole feature. Empty counts as
				// absent: the cursor column is a free-form string, and "" is not a generation
				// any pass ever claimed to have completed.
				if (!readCursor(db, repo.repoIdentity, CURSOR_SESSIONS_GENERATION)) continue;
				baselines.set(repo.repoIdentity, readKnownSessions(db, repo.repoIdentity));
			}
			return {
				baselines,
				seed: opts.seedEmitted ? readEmittedFromLog(db, emittedLimit) : undefined,
				failedEvents: countStuckEvents(db),
			};
		}, dbOpts);
	} catch (err) {
		// The file exists and cannot be used — a state `existsSync` above cannot see and
		// this pass cannot repair (it deliberately never migrates). Left as a rejection it
		// became ONE warn for the daemon's whole lifetime, because the caller's dedup keys
		// on the message; as an idle reason it is reported like every other outcome. DEBUG
		// here rather than WARN: at 30-second ticks a standing fault is 2,880 lines a day,
		// and the caller is the one that knows how to say a thing once.
		log.debug("AgentScan: dashboard database unusable: %s", errMsg(err));
		return idleWith("database-unusable");
	}
	const { baselines, failedEvents } = phase1;
	// Seeded, never merged OVER. Both sides are observed mtimes now, so this can no longer
	// be the downgrade it once guarded against — but NEITHER ORDERING IS GUARANTEED, so
	// the choice still has to be made deliberately rather than derived. The seed is the
	// newest ROW's instant, and this process can hold an entry with no row of its own
	// behind it: the map is recorded from `entry.events` rather than from `changed` (see
	// there), so a session the unchanged-filter dropped is entered here while nothing is
	// written; and a row it did write can later be pruned, the prune deleting only
	// `projected` rows while an older producer's `failed` one survives untouched.
	//
	// So what this keeps is not "the narrower of the two" — it is the observation THIS
	// process made and verified on this tick, which is the one it can account for.
	if (phase1.seed !== undefined) {
		for (const [key, ms] of phase1.seed) if (!emitted.has(key)) rememberEmitted(key, ms);
		// Announced HERE, before anything that can throw, rather than on the result — see
		// `onSeeded`. The merge is done and paid for at this point, so the caller's
		// once-per-process flag is entitled to flip even if a later phase fails.
		opts.onSeeded?.();
	}

	const ready = live.filter((repo) => baselines.has(repo.repoIdentity));
	if (ready.length === 0) {
		// Spelled out rather than spread over `idleWith`'s zeros: phase 1 DID run, so
		// `failedEvents` is measured here and this is a real answer rather than an idle one.
		// Borrowing the idle shape for it is what made three fields look like copy-paste
		// omissions.
		return {
			reposScanned: 0,
			reposWithoutBaseline: live.length,
			discovered: 0,
			processed: 0,
			eventsApplied: 0,
			failedSources: [],
			failedEvents,
		};
	}

	// Phase 2 — one machine-wide scan for the whole tick, then per-repo narrowing.
	// Nothing is held open here.
	//
	// `alreadyRecorded` is deliberately not passed: it only reaches sources that
	// declare `usesAlreadyRecorded`, and none of the opted-in ones does — their scans
	// are a `stat` per session, where the check would cost about what it saves. A
	// future opt-in whose scan is expensive (a whole-transcript parse, a SQLite open
	// per conversation) should pass one, built from `baselines` rather than from a
	// third database read.
	// No fallback here, deliberately — the empty loader below is what confines the
	// tick to `sources`, so a failed scan means this tick sees none of that source's
	// sessions and the next one retries from scratch.
	//
	// NOT `scanAllStoresLoggingFailures`: at 30-second cadence one WARN per failing source
	// per tick is 2,880 a day for a standing condition. The names go out on the result and
	// `SessionRescanTask` says them once per situation; the REASON is kept here at DEBUG,
	// under the `AgentScan` prefix so one grep still returns it when debug is on.
	const scan = opts.preScanned ? undefined : await scanAllStores({ sources, windowMs });
	const preScanned = opts.preScanned ?? (scan?.scanned as PreScannedSessions);
	for (const failure of scan?.failures ?? []) {
		log.debug("AgentScan: %s scan failed -- its sessions are skipped this tick: %s", failure.source, failure.error);
	}
	// Derived from ABSENCE rather than from `scan.failures`, and that is deliberate: it is
	// the collector's own empty-versus-absent rule, and it stays right for the
	// `opts.preScanned` test seam, which has no failure list to read.
	const failedSources = sources.filter((def) => preScanned[def.source] === undefined).map((def) => def.source);

	let discovered = 0;
	let processed = 0;
	const pending: Array<{ repo: RegisteredRepo; events: ReadonlyArray<SessionUpsertedEvent> }> = [];
	// Repos are walked one at a time, and that costs nothing worth reclaiming: the
	// expensive half is inside `collectSessionEvents`, which already fans out its
	// per-session reads against the process-wide I/O budget (8 slots, 64 MB). Running
	// repos concurrently would have them competing for those same slots rather than
	// adding any, while making a failure harder to attribute and the log order
	// non-deterministic. The sources above ARE concurrent, because those are different
	// stores.
	for (const repo of ready) {
		/* v8 ignore start -- `ready` is `live.filter(r => baselines.has(r.repoIdentity))`, so `baselines.get` is always defined here and the `?? new Map` fallback is unreachable */
		const known = baselines.get(repo.repoIdentity) ?? new Map<string, number>();
		/* v8 ignore stop */
		// The registered checkouts of this repo, and its `cwd` the newest of them —
		// exactly as `dbBackfillRepo` picks it.
		//
		// Not null-checked, and that is not an oversight: `existingWorktrees` is documented
		// to never return empty while the repo is registered (it falls back to the recorded
		// path), and `live` has already been filtered by `hasLiveWorktree`, so this repo has
		// a checkout on disk. A guard here would be an unreachable branch spending the
		// suite's branch-coverage floor and reading to the next maintainer as a real case.
		const worktrees = existingWorktrees(repo);
		const cwd = worktrees[0] as string;
		// The SAME sibling coverage `dbBackfillRepo` passes, and for the same reason:
		// `collectSessionEvents` narrows `preScanned` by running each source's own
		// path-containment rule against these roots, and a session that ran in a sibling
		// checkout fails that rule against `cwd` alone "by construction" (see
		// `collectSessionEvents`). Omitting them made the 30 s tick blind to every
		// sibling-worktree session until the next full back-fill — measured at 65 of 94
		// in-window sessions on a repo with six live worktrees. `worktreeRoots` is every
		// linked worktree of every registered checkout; `checkoutRoots` is the checkouts
		// themselves (the granularity a worktree-spanning source is asked at).
		const sessionWorktreeRoots = [
			...new Set((await Promise.all(worktrees.map((root) => resolveWorktreeRoots(root)))).flat()),
		];
		// Two questions, ORed. The shared predicate answers "the database already holds
		// this version"; the emission gate answers "I already emitted for this version",
		// which is the state the shared one structurally cannot see (see `emitted`).
		//
		// Composed HERE rather than folded into `alreadyCurrentFrom`, and that is a
		// decision rather than a style: that helper is shared with `dbBackfillRepo`,
		// where re-emitting is CORRECT. A dashboard run is the user asking for a rebuild,
		// and re-trying a session whose projection failed is how a fixed parser heals it
		// — a durable gate there would judge such a session permanently.
		const dbCurrent = alreadyCurrentFrom(known);
		const isAlreadyCurrent: AlreadyCurrent = (source, sessionId, updatedAtMs) => {
			if (dbCurrent(source, sessionId, updatedAtMs)) return true;
			const last = emitted.get(sessionEventId(repo.repoIdentity, source, sessionId));
			// `>=`, matching `alreadyCurrentFrom`: both sides are mtimes, so an equal
			// instant is the same version and a re-read would only write it back.
			return last !== undefined && last >= updatedAtMs;
		};
		try {
			const events = await collectSessionEvents({
				repoIdentity: repo.repoIdentity,
				cwd,
				worktreeRoots: sessionWorktreeRoots,
				checkoutRoots: worktrees,
				windowMs,
				preScanned,
				// Every session in this pass comes from `preScanned`, which the collector
				// narrows itself. The empty loader is what CONFINES the tick to `sources`:
				// the default `loadAllSessions` would run the per-repo discoverer of every
				// source that was not pre-scanned — eleven agents' stores, once per repo,
				// every 30 s — and would also pull in `sessions.json`, whose Claude and
				// Gemini rows this pass has no baseline reasoning for.
				loadSessions: async () => [],
				isAlreadyCurrent,
				onCounts: (seen) => {
					discovered += seen.discovered;
				},
			});
			processed += events.length;
			if (events.length > 0) pending.push({ repo, events });
		} catch (err) {
			// One repo's failure must not cost the others their tick. No result row and no
			// terminal to print to — this is a daemon — so a warn in the log is the signal.
			// `AgentScan` prefix on purpose: this line comes from a different module than
			// the task's own output, and one grep has to return both.
			log.warn("AgentScan: session re-scan failed for %s: %s", repo.repoName, errMsg(err));
		}
	}

	const totals = {
		reposScanned: ready.length,
		reposWithoutBaseline: live.length - ready.length,
		discovered,
		processed,
		failedSources,
		failedEvents,
	};

	// Phase 3 — apply. Second short open, no I/O inside.
	//
	// Skipped entirely on the converged tick, which is the one that runs 99 ticks out of
	// 100: nothing changed, so there is nothing to write. Phase 1's open has already
	// happened either way — see the docblock. Guarding the OPEN rather than returning early
	// keeps one exit and one `eventsApplied`.
	//
	// `unchangedSessionEvent` is the SAME filter `dbBackfillRepo` runs ahead of its own
	// `applyBatches`, and sharing it is not tidiness — it is what makes this pass's claim
	// to be idempotent true of the events table and not only of the projection. Every
	// event still reaches Tx1 of `applyToDb` as an `events_raw` row whether or not it
	// changes anything, and a session with no read receipt (`readKnownSessions` counts
	// only `started_at_ms`/`duration_ms`, so a rollout that parsed to zero entries has
	// none) is re-read on EVERY tick, forever, while it stays inside the window —
	// measured: 1 of 16 in-window Codex rollouts on one real machine. Unfiltered that is
	// one identical row every 30 s, 2,880 a day, kept for `PROJECTED_RETENTION_DAYS`.
	// The back-fill never paid it because a dashboard run is rare; a timer is not.
	let eventsApplied = 0;
	if (pending.length > 0)
		await withDashboardDb((db) => {
			for (const entry of pending) {
				const stored = storedSessionRows(db, entry.repo.repoIdentity);
				// Empty is a no-op inside `applyBatches`, exactly as in the back-fill — so a
				// repo whose every event was unchanged also skips its pending drain there.
				const changed = entry.events.filter(
					(event) => !unchangedSessionEvent(event, stored.get(`${event.source}\0${event.sessionId}`)),
				);
				if (changed.length !== entry.events.length) {
					// DEBUG, not the back-fill's INFO: at this cadence the unchanged case is the
					// normal one, and an INFO here would be the per-tick line this feature's
					// logging exists to avoid.
					log.debug(
						"AgentScan: %s: %d of %d session event(s) unchanged, skipping their projection",
						entry.repo.repoName,
						entry.events.length - changed.length,
						entry.events.length,
					);
				}
				eventsApplied += applyBatches(db, changed, producerKind, now).applied;
				// Recorded from `entry.events`, NOT from `changed`. A session filtered out by
				// `unchangedSessionEvent` was still READ this tick, and the whole point of the
				// gate is to stop the NEXT tick reading it again — that filter only ever
				// prevented the write. Recorded AFTER the apply so a throw here leaves the
				// session un-gated and the next tick retries it.
				for (const event of entry.events) {
					rememberEmitted(
						sessionEventId(entry.repo.repoIdentity, event.source, event.sessionId),
						event.updatedAtMs,
					);
				}
			}
			// The same housekeeping the other two apply paths run (`applyStatsEvents` and
			// `dbBackfillRepo`), and this is the path that most needs it: on the machine this
			// feature exists for — a user who never opens the dashboard — the timer is the ONLY
			// writer of `session.upserted` rows, so without a prune here nothing ever deletes a
			// `projected` row past `PROJECTED_RETENTION_DAYS` and the table only grows. That
			// feeds straight back into the emission gate, whose startup seed is a full scan of
			// exactly this table. Bounded per pass, inside the lock this write already holds,
			// and it never touches a `failed` row.
			//
			// Tagged, like every other line this pass can emit — see `pruneProjectedEvents`. The
			// prune is shared with two user-triggered paths that want no prefix, so the caller
			// supplies it rather than the helper assuming one.
			pruneProjectedEvents(db, now, "AgentScan: ");
		}, dbOpts);

	return { ...totals, eventsApplied };
}

/**
 * Backfills `session_activity` for sessions that have a stored transcript but
 * no activity buckets — Route A from the coverage measurement. This reads the
 * SUMMARY PIPELINE's persisted `transcripts.sessions_blob`, NOT the live 7-day
 * discovery window, so it reaches the historical sessions the concurrency
 * feature's "no repair path" note deliberately left untouched (§4.3 duration).
 *
 * Idempotent: `session_activity` is insert-only and the writer projects it
 * with `INSERT OR IGNORE`, so re-running converges and a session the live
 * writer later touches is never double-written. `bucketsFrom` is the SOLE
 * definition of a bucket — no private copy — so backfilled rows cannot drift
 * from the live writer's. A session whose entries carry no timestamp gets NO
 * rows (the same presence-gate as the live writer's absent `activityBuckets`).
 *
 * @returns how many sessions this run wrote buckets for (0 once converged).
 */
export function backfillStoredActivity(db: DashboardDbHandle, now: () => number = Date.now): number {
	const uncovered = new Set<string>(
		(
			db
				.prepare(
					`SELECT s.event_id AS event_id
					   FROM sessions s
					  WHERE NOT EXISTS (SELECT 1 FROM session_activity a WHERE a.session_event_id = s.event_id)`,
				)
				.all() as ReadonlyArray<{ event_id: string }>
		).map((row) => row.event_id),
	);
	if (uncovered.size === 0) return 0;

	const blobs = db
		.prepare(
			`SELECT DISTINCT r.repo_identity AS repo_identity, t.sessions_blob AS sessions_blob
			   FROM transcripts t
			   JOIN repos r ON r.id = t.repo_id
			   JOIN transcript_sessions ts ON ts.repo_id = t.repo_id AND ts.transcript_id = t.transcript_id
			   JOIN sessions s ON s.repo_id = ts.repo_id AND s.source = ts.source AND s.session_id = ts.session_id
			  WHERE NOT EXISTS (SELECT 1 FROM session_activity a WHERE a.session_event_id = s.event_id)`,
		)
		.all() as ReadonlyArray<{ repo_identity: string; sessions_blob: Uint8Array }>;

	let written = 0;
	// Parse and bucket OUTSIDE the write lock: inflate + JSON.parse over every
	// stored transcript is pure CPU, and holding SQLite's single writer while it
	// runs would stall every hook and the extension host (see `withDashboardDb`).
	// The `recorded_at_ms` stamp is deliberately NOT captured here — see the
	// transaction below for why it must be read inside the lock.
	const pending: Array<{ eventId: string; bucket: number }> = [];
	for (const row of blobs) {
		let stored: StoredTranscript;
		try {
			stored = JSON.parse(inflateSync(Buffer.from(row.sessions_blob)).toString("utf8")) as StoredTranscript;
		} catch {
			// One unreadable blob is one unbackfilled session, never a failed run.
			log.warn("activity backfill: unreadable transcript for repo %s", row.repo_identity);
			continue;
		}
		for (const session of stored.sessions ?? []) {
			if (!session.source) continue;
			const eventId = sessionEventId(row.repo_identity, session.source, session.sessionId);
			if (!uncovered.has(eventId)) continue;
			const buckets = bucketsFrom(session.entries);
			if (buckets.length === 0) continue;
			for (const bucket of buckets) pending.push({ eventId, bucket });
			written += 1;
		}
	}
	if (pending.length === 0) return 0;
	// ONE transaction, so this whole cohort — every row sharing the single stamp
	// computed below — becomes visible to a concurrent cross-process session sync
	// atomically. The sync cursor is the keyset `(recorded_at_ms, session_event_id,
	// bucket_ms)` resumed with `>=`, so a reader that paged past a higher-key row at
	// this stamp would never revisit a lower-key one committed after it — the row
	// would sit below the cursor for good. The live writer gets this for free (one
	// session, one transaction, in `projectSession`); the backfill stamps many
	// sessions with one instant, so it must make the batch atomic explicitly.
	const insertBucket = db.prepare(
		"INSERT OR IGNORE INTO session_activity (session_event_id, bucket_ms, recorded_at_ms) VALUES (?, ?, ?)",
	);
	inTransaction(db, () => {
		// Stamp read INSIDE the `BEGIN IMMEDIATE` lock and floored STRICTLY ABOVE the
		// table's current max — never `now()` alone. `now()` was captured stale (the
		// CPU-heavy parse above can outlast a concurrent live write + sync that
		// advances the cursor) or can even step backwards (NTP), and a cohort stamped
		// at or below an already-advanced cursor is paged straight over by the `>=`
		// resume and never syncs. `session_activity` is INSERT-ONLY, so the cursor can
		// only ever have reached a stamp that a row still carries: clearing the current
		// max clears the cursor. The read is race-free only because `inTransaction`
		// holds `BEGIN IMMEDIATE`, blocking any writer between this MAX and the inserts.
		const maxRow = db.prepare("SELECT MAX(recorded_at_ms) AS m FROM session_activity").get() as {
			m: number | null;
		};
		const recordedAtMs = Math.max(now(), (maxRow.m ?? 0) + 1);
		for (const { eventId, bucket } of pending) insertBucket.run(eventId, bucket, recordedAtMs);
	});
	return written;
}

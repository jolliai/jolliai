/**
 * Codex Session Discoverer
 *
 * On-demand scanner for OpenAI Codex sessions. Since Codex has no
 * lifecycle hook we can use (the Stop hook needs per-user manual trust and is
 * broken under git worktrees), sessions are discovered by scanning the
 * filesystem. This runs both at post-commit time (for summaries) and on the
 * VS Code sidebar's 60s Active Conversations tick — the latter also drives
 * Codex reference extraction (Linear/Jira/GitHub/Notion) via
 * `CodexDiscovery.discoverCodexConversations`, which reuses the shared
 * `discovery-cursors.json` incremental cursor.
 *
 * Algorithm:
 *   1. Walk every ~/.codex/sessions/YYYY/MM/DD/ directory, stat each JSONL file
 *   2. Keep the ones whose mtime is inside the window; read only line 1 of those
 *      (session_meta) to extract cwd
 *   3. Match cwd against the project dir via sessionDirBelongsToRepo (prefix/
 *      containment + nested-repo exclusion, shared with Devin/OpenCode/Copilot)
 *   4. Also scan ~/.codex/archived_sessions/ for recently archived sessions
 *   5. Return matching sessions as SessionInfo[] with source="codex"
 *
 * ## Why `updatedAt` is the file's mtime and NOT `session_meta.timestamp`
 *
 * The first line's `timestamp` is when the rollout was CREATED, and Codex never
 * rewrites it — a conversation resumed for another three hours still reports the
 * instant it began. That made it unusable as the "has this changed" signal the
 * dashboard back-fill needs: `DbBackfill` skips a session whose stored instant is
 * at or past the discovered one, so a rollout that was imported once and then
 * continued reported the same creation time forever and was skipped for good. Every
 * skill and MCP call added after that first import stayed invisible, with the
 * back-fill reporting success.
 *
 * mtime answers the question the skip actually asks. It is also a SAFE answer in one
 * direction only, which is what makes it the right one here: it can only ever be at
 * or after the last appended line, so it never wrongly excludes a session — at worst
 * something touches the file without changing it (a sync client, a backup tool) and
 * one extra read happens. Re-reading is whole-conversation and overwrites, so the
 * cost of being wrong that way is one file read, while the cost of being wrong the
 * other way was permanent data loss.
 *
 * This is not transferable to every source: Claude Code keeps appending
 * non-conversational lines (`ai-title`, `queue-operation`) after a conversation
 * stops, so its mtime runs ahead of the last real turn by a median of 0.8 h and by
 * as much as 42.8 h — see `ClaudeSessionDiscoverer`. Codex has no such trailer;
 * every line it appends is conversation.
 *
 * Performance: every date directory is walked, because a resumed session's file
 * stays in the directory named for the day it was CREATED — so filtering by
 * directory name (what this used to do) drops exactly the sessions this scan exists
 * to catch, and a wider window cannot fix it. What bounds the cost instead is that
 * the mtime check runs BEFORE the first-line read: measured on a real machine, 38
 * active rollouts across 33 date directories plus 422 archived ones stat in ~10 ms,
 * and only the handful inside the window are opened. Each of those is opened at most
 * ONCE per process, because the two facts the open yields cannot change — see
 * {@link SESSION_META_MEMO}, which is what makes a 30-second re-scan affordable.
 *
 * The `stat` per rollout is NOT memoized and cannot be: it is the question. So this
 * scan is O(every rollout the user has ever recorded), which grows without bound
 * because Codex never prunes `sessions/` or `archived_sessions/`. It is ~10 ms today
 * and is the remaining cost worth watching.
 *
 * There is no cheap lever left, and the two that look available are both closed. Pruning
 * the WALK by date is the defect this scan was rewritten to remove — a resumed session's
 * file stays under the day it was created, so a date filter drops exactly the sessions the
 * mtime window exists to catch. And the memos only pay off from a process's SECOND scan, so
 * they do nothing for four of the five callers: `QueueWorker`'s post-commit summary (inside
 * the interactive watch budget, i.e. charged to a user's `git commit`), `jolli status`,
 * `CodexDiscovery`, and `ActiveSessionAggregator` when it runs through a one-shot
 * ide-bridge. Only the resident daemon amortises them. Treat the per-rollout `stat` as the
 * floor; a real reduction needs the store to be indexed by something other than date, which
 * is Codex's layout and not ours.
 */

import { createReadStream, type Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { setBounded } from "../util/BoundedMemo.js";
import { mapWithConcurrency, withIoBudget } from "../util/Concurrency.js";
import { toForwardSlash } from "./PathUtils.js";
import { sessionDirBelongsToRepo } from "./SessionDirMatch.js";

const log = createLogger("CodexDiscoverer");

/** Sessions older than 48 hours are considered stale (matches Claude session staleness) */
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

/** Base directory for Codex data */
const CODEX_DIR_NAME = ".codex";

/**
 * Discovers Codex sessions relevant to the given project directory.
 * Scans ~/.codex/sessions/ for JSONL files whose session_meta.cwd matches
 * the project directory. Only returns sessions updated within the staleness
 * window (48 hours by default).
 *
 * @param projectDir - The git repository root to match sessions against
 * @param windowMs - Staleness window; defaults to {@link SESSION_STALE_MS}.
 *   The dashboard's history back-fill passes a wider one (7 days). Every caller
 *   that must keep the 48 h horizon simply omits it — the sidebar's Active
 *   Conversations, `jolli status`, and (the one that matters) `QueueWorker`'s
 *   post-commit summary, which decides which conversations belong to the commit
 *   being summarised. Widening THAT would write week-old unrelated conversations
 *   into a commit's stored memory, persistently and with no error anywhere, which
 *   is why the constant above stays a default and never becomes the knob.
 * @returns Array of matching sessions with source="codex"
 */
export async function discoverCodexSessions(
	projectDir: string,
	windowMs?: number,
): Promise<ReadonlyArray<SessionInfo>> {
	return codexSessionsForRepo(await scanCodexSessionsOnDisk(windowMs), projectDir);
}

/** One Codex rollout, as the machine-wide scan understands it. */
export interface CodexDiskSession {
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly updatedAt: string;
	/**
	 * The working directory `session_meta` recorded. An array for symmetry with the
	 * other disk scans (Claude collects several per transcript, Devin has a primary
	 * plus an attached list); Codex records exactly one, so it always holds one entry.
	 */
	readonly dirs: ReadonlyArray<string>;
}

/**
 * Scans every Codex rollout on this machine and returns those inside the window,
 * each carrying the working directory it recorded.
 *
 * MACHINE-WIDE and repo-agnostic on purpose. `~/.codex/sessions/` is one global tree
 * keyed by DATE, not by project, so a repo-scoped scan re-reads the first line of
 * every rollout once per registered repo — measured on this machine, 68 ms per repo
 * and 201 ms across three, all of it pure repetition. Callers scan once and narrow
 * with {@link codexSessionsForRepo}.
 */
export async function scanCodexSessionsOnDisk(windowMs?: number): Promise<ReadonlyArray<CodexDiskSession>> {
	const codexBase = join(homedir(), CODEX_DIR_NAME);
	const staleMs = windowMs ?? SESSION_STALE_MS;
	const sessions: CodexDiskSession[] = [];

	// Scan active sessions in date-organized directories
	const sessionsDir = join(codexBase, "sessions");
	sessions.push(...(await scanSessionsDirectory(sessionsDir, staleMs)));

	// Scan archived sessions (flat directory). Same per-file mtime gate as the active
	// half above; this one simply has no date partitioning to walk.
	const archivedDir = join(codexBase, "archived_sessions");
	sessions.push(...(await scanFlatDirectory(archivedDir, staleMs)));

	log.debug("Codex disk scan: %d rollout(s) inside the window", sessions.length);
	return sessions;
}

/**
 * Narrows a machine-wide Codex scan to one repo.
 *
 * Attribution is `sessionDirBelongsToRepo`, unchanged from when it ran inside the
 * scan: prefix/containment with case folding plus the nested-repo exclusion, so a
 * rollout started in a SUBDIRECTORY still counts (the exact-equality match this
 * replaced silently dropped every one of those — JOLLI-2015).
 *
 * FILTERS rather than partitions: nested-repo exclusion aside, the same rollout may
 * legitimately be claimed by two registered repos that are two checkouts of one
 * project.
 */
export function codexSessionsForRepo(
	scanned: ReadonlyArray<CodexDiskSession>,
	projectDir: string,
): ReadonlyArray<SessionInfo> {
	const resolvedProject = resolve(projectDir);
	const mine: SessionInfo[] = [];
	for (const session of scanned) {
		if (!session.dirs.some((dir) => sessionDirBelongsToRepo(resolve(dir), resolvedProject))) continue;
		mine.push({
			sessionId: session.sessionId,
			transcriptPath: session.transcriptPath,
			updatedAt: session.updatedAt,
			source: "codex",
		});
	}
	log.debug("Discovered %d Codex session(s) for %s", mine.length, projectDir);
	return mine;
}

/**
 * Checks whether the Codex data directory exists.
 * Used by the Installer to detect Codex presence.
 */
export async function isCodexInstalled(): Promise<boolean> {
	const sessionsDir = join(homedir(), CODEX_DIR_NAME);
	try {
		const dirStat = await stat(sessionsDir);
		return dirStat.isDirectory();
	} catch {
		return false;
	}
}

/**
 * Walks the date-organized ~/.codex/sessions/YYYY/MM/DD/ tree.
 *
 * EVERY date directory, not just the recent ones. Codex names a directory for the
 * day the rollout was created and never moves the file, so a conversation started
 * three weeks ago and resumed this morning still lives under the old date — the
 * directory-name filter this replaced could not see it at any window width, which
 * made the resumed-session case (the whole point of an mtime-based scan) unreachable.
 *
 * A directory's own mtime is no help either and would be a tempting mistake:
 * appending to a file inside a directory does not touch the directory, so a "skip
 * directories that look old" pass drops the same sessions for a subtler reason.
 *
 * What keeps this cheap is the per-file order in {@link tryParseSessionMeta}: one
 * `stat` decides, and only a rollout inside the window is opened.
 *
 * ## FLATTENED, not nested — the walk is four bounded rounds
 *
 * Enumerate the years, then every year's months at once, then every month's days at
 * once, then scan every rollout across every day in ONE pool. Walking day directories
 * one at a time (which is what removing the date filter left behind) is a serial
 * round-trip per calendar day the user has ever used Codex — around 730 of them after
 * two years — and it restarts the fan-out pool at each one, so the pool is never full
 * for a directory holding two files.
 *
 * That matters beyond the daemon's own timer: the same scan backs `discoverCodexSessions`,
 * which runs on the post-commit summary path (inside `QueueWorker`'s watch budget),
 * `jolli status`, and the sidebar's 60-second Active Conversations tick.
 *
 * **Flattened rather than nested is the whole point, and nesting is the tempting
 * mistake.** Fanning out the day directories while each one fans out its own files
 * multiplies the two widths. Both halves take a slot from the shared process-wide budget
 * (the per-file `stat` as well as the first-line read — see {@link statMtimeProbe}), so
 * the aggregate cannot exceed the process total however the walk is shaped; what
 * flattening buys is that ONE pool runs at the width a single directory used to have,
 * rather than N nested pools queueing behind each other for the same slots. The `stat`
 * was outside the budget once, and this paragraph used that as the argument for
 * flattening — which left the one scan that touches every rollout the user has ever
 * recorded unbounded in aggregate while running alongside eleven other stores' budgeted
 * reads.
 *
 * Order is preserved end to end, and deterministically: every listing is sorted (a bare
 * `readdir` returns the filesystem's own order, which on ext4 with `dir_index` is hash
 * order — `traverseDistPaths` sorts for exactly this reason and says so), and
 * `mapWithConcurrency` writes results back by index, so flattening year → month → day →
 * file yields one stable sequence on every filesystem. That is not cosmetic — the
 * collector's event order decides which sessions share an `applyBatches` batch, so an
 * unsorted walk reshuffles batch membership run to run.
 *
 * ## What is left, and the one part of it that IS cacheable
 *
 * The `stat` per rollout cannot be cached — it is the question this scan asks — so the
 * per-file cost stays O(every rollout the user has ever recorded), and Codex prunes
 * neither `sessions/` nor `archived_sessions/`. The DIRECTORY LISTINGS are a different
 * matter: a day directory is named for a calendar date and Codex only ever creates a
 * rollout under TODAY'S date, so a past day's directory can GAIN no entry. It can still
 * LOSE one — archiving moves a rollout into `archived_sessions/` — so an entry is
 * dropped as soon as one of its members is found to be gone; see
 * {@link forgetDayListing}. {@link listRolloutsCached} is where this is exploited, and
 * it is what removes the ~730 `readdir` round trips a two-year user otherwise pays on
 * every scan.
 */
async function scanSessionsDirectory(sessionsDir: string, staleMs: number): Promise<CodexDiskSession[]> {
	// Through `listDir` rather than a bare `readdir`, so the top level gets the same
	// sort every deeper level gets. A second spelling here is how the years came back
	// unsorted while months, days and files were ordered.
	const listing = await listDir(sessionsDir);
	if (!("entries" in listing)) {
		logUnlistedDir("Codex sessions directory", sessionsDir, listing.errno);
		return [];
	}

	const monthPaths = await expandLevel(listing.entries.map((year) => join(sessionsDir, year)));
	const dayPaths = await expandLevel(monthPaths);
	const rollouts = await mapWithConcurrency(dayPaths, listRolloutsCached);
	return scanRollouts(rollouts.flat(), staleMs);
}

/**
 * Per-process memo of a PAST day directory's rollout listing, keyed by directory path.
 *
 * ## Why only past days
 *
 * Codex writes a new rollout into the directory named for the day it is created, so the
 * only directory that can GAIN an entry is today's. Every earlier one is closed for
 * additions: its files are still appended to (which is the whole reason the walk cannot
 * skip it), but the set of files in it does not grow.
 *
 * It can still SHRINK — archiving moves a rollout into `archived_sessions/` — so an
 * entry is dropped as soon as one of its members is found to be gone; see
 * {@link forgetDayListing}. Without that, a memoized listing keeps naming the
 * pre-archive path for the life of the process: harmless for the output (the archived
 * copy is discovered independently) and 2,880 wasted `stat` calls a day per archived
 * rollout in the resident daemon.
 *
 * ## Only a SUCCESSFUL listing is cached
 *
 * {@link listDir} answers "cannot read this directory" and "this directory is empty"
 * with different values for one reason: a failure must not be memoized. Collapsing both
 * to `[]` and caching it means one transient `EACCES`/`EMFILE`/`EIO` — or a cloud-synced
 * home that blinked — makes every rollout under that date invisible for the life of the
 * process, silently, and in the daemon "the life of the process" is machine uptime. The
 * uncached walk retried on the next scan, and that property has to survive caching.
 *
 * ## The boundary is TWO days wide, and that is not padding
 *
 * The date comes from the PATH, not from a `stat`: the last three segments are Codex's
 * own `YYYY/MM/DD`. WHICH CLOCK stamps them is *inferred, not proven*. A real capture has
 * `sessions/2026/08/11/` holding `rollout-2026-08-11T10-52-15-…jsonl` whose
 * `session_meta.timestamp` is `2026-08-11T02:53:24.548Z` — 10:53 in that machine's UTC+8,
 * which reads as local stamping. But every rollout in that corpus was created between
 * 09:00 and 15:00 local, i.e. at an hour where the local and UTC dates AGREE, so the
 * capture is equally consistent with UTC stamping and no sample discriminates. Settling
 * it needs one rollout created before 08:00 local on a UTC+8 machine.
 *
 * Under caching that ambiguity stops being harmless, so the cutoff is
 * {@link oldestVolatileDayKey} — the earlier of YESTERDAY's local and UTC keys — rather
 * than today's local key. Two reachable failures need the margin:
 *
 *   - If the directories are UTC-stamped, a machine at UTC+8 spends 00:00-08:00 local
 *     writing into a directory whose name is already "yesterday" by the local clock.
 *     Caching it freezes the listing of the directory Codex is actively filling, and
 *     every conversation started in that window is invisible for the rest of the
 *     process's life.
 *   - V8 caches the process's timezone and re-reads it only when `process.env.TZ` is
 *     assigned, so a resident daemon that started at UTC+8 and is now physically at
 *     UTC-5 computes a LOCAL key up to a day ahead of reality — while the UTC key,
 *     derived from the epoch, stays correct. Taking the earlier of the two readings is
 *     what makes a stale timezone cache cost nothing.
 *
 * The price is one extra `readdir` per day directory inside the margin, i.e. two or three
 * per scan against the ~730 the memo removes. A path that does not parse as a date is not
 * cached at all, so the archived half and any future layout change degrade to the
 * uncached behaviour rather than to a wrong answer.
 *
 * Bounded the same way as the session_meta memo, and with the same reasoning: a
 * whole-map clear past {@link DAY_LISTING_MEMO_LIMIT}, because the cost of being wrong
 * is one extra `readdir` — the behaviour that was already there — and an LRU would buy
 * nothing for that.
 */
const DAY_LISTING_MEMO = new Map<string, ReadonlyArray<string>>();

/** Entry count past which the day-listing memo is dropped whole. */
const DAY_LISTING_MEMO_LIMIT = 5_000;

/** One day in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `…/sessions/2026/08/11` → `20260811`, or null when the tail is not a date.
 *
 * Compared as a lexicographic string rather than parsed into a `Date`: the only question
 * is "is this directory's date strictly before the cutoff", both sides are zero-padded
 * `YYYYMMDD`, and building a `Date` would invite exactly the timezone conversion the
 * memo's docstring says cannot be pinned down.
 */
function dayDirKey(dirPath: string): string | null {
	const parts = toForwardSlash(dirPath).split("/");
	const [year, month, day] = parts.slice(-3);
	if (year === undefined || month === undefined || day === undefined) return null;
	if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) return null;
	return `${year}${month}${day}`;
}

/** One instant as the zero-padded `YYYYMMDD` key {@link dayDirKey} yields, in one clock. */
function dayKeyOf(at: Date, zone: "local" | "utc"): string {
	const year = zone === "local" ? at.getFullYear() : at.getUTCFullYear();
	const month = (zone === "local" ? at.getMonth() : at.getUTCMonth()) + 1;
	const day = zone === "local" ? at.getDate() : at.getUTCDate();
	return `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

/**
 * The newest day key that must NOT be cached — a listing is memoized only when its key
 * is strictly earlier. See {@link DAY_LISTING_MEMO} for why the margin is two days and
 * why the two clocks are both consulted.
 */
function oldestVolatileDayKey(now: Date = new Date()): string {
	const yesterday = new Date(now.getTime() - DAY_MS);
	const local = dayKeyOf(yesterday, "local");
	const utc = dayKeyOf(yesterday, "utc");
	return local < utc ? local : utc;
}

/** {@link listRollouts}, memoized for past day directories. See {@link DAY_LISTING_MEMO}. */
async function listRolloutsCached(dirPath: string): Promise<ReadonlyArray<string>> {
	const key = dayDirKey(dirPath);
	// Inside the volatile margin, or a path whose tail is not a date at all: ask the
	// filesystem and remember nothing.
	if (key === null || key >= oldestVolatileDayKey()) return entriesOf(await listRollouts(dirPath)) ?? [];

	const cached = DAY_LISTING_MEMO.get(dirPath);
	if (cached !== undefined) return cached;

	const listed = entriesOf(await listRollouts(dirPath));
	// A failed listing degrades to "no rollouts here, this scan" — never to "no rollouts
	// here, forever".
	if (listed === null) return [];
	setBounded(DAY_LISTING_MEMO, DAY_LISTING_MEMO_LIMIT, dirPath, listed, (size) =>
		log.debug("Codex day-listing memo hit %d entries — clearing", size),
	);
	return listed;
}

/**
 * Forgets the memoized listing that named `filePath`, if any.
 *
 * Called when a rollout a listing named turns out not to exist — the one way a past day
 * directory's file set changes (archiving is a `rename` out of it). Cheap and idempotent:
 * the next scan re-lists that one directory.
 */
function forgetDayListing(filePath: string): void {
	const slash = toForwardSlash(filePath).lastIndexOf("/");
	if (slash <= 0) return;
	DAY_LISTING_MEMO.delete(filePath.slice(0, slash));
}

/**
 * Every child of every given directory, as full paths, in input order.
 *
 * An unreadable directory contributes nothing rather than failing the level — the same
 * `continue` the serial walk did, and the reason a partially-permissioned tree still
 * yields the rest of its sessions.
 */
async function expandLevel(dirPaths: ReadonlyArray<string>): Promise<string[]> {
	// Wrapped rather than passed by reference: `mapWithConcurrency` calls its task as
	// `fn(item, index)`, so a bare `listDir` would be handed the index as a second argument
	// the day one is added.
	const children = await mapWithConcurrency(dirPaths, async (dirPath) => entriesOf(await listDir(dirPath)));
	return dirPaths.flatMap((dirPath, i) => (children[i] ?? []).map((child) => join(dirPath, child)));
}

/**
 * A directory's entries, or the errno that explains why there are none.
 *
 * A union rather than `string[] | null` for two reasons. Failure stays distinct from an
 * empty directory, because the two have opposite consequences once a caller memoizes (see
 * {@link DAY_LISTING_MEMO}) — that much `null` already carried. What it did not carry is the
 * REASON, and two of the callers below exist to report it: without the code, a directory
 * that is merely absent and one that cannot be opened print the same bytes.
 */
type DirListing = { readonly entries: string[] } | { readonly errno: string };

/**
 * One directory's entries in ascending order, or the errno behind a failed read.
 *
 * Sorted because `readdir` returns the filesystem's own order.
 */
async function listDir(dirPath: string): Promise<DirListing> {
	try {
		return { entries: (await readdir(dirPath)).sort() };
	} catch (err) {
		// The code, not just the fact. A bare `catch` here discarded it, which left the two
		// log sites below unable to say which of the two things happened — see
		// {@link logUnlistedDir}.
		return { errno: (err as NodeJS.ErrnoException).code ?? "unknown" };
	}
}

/** Convenience for the callers with nothing to say about WHY a listing failed. */
function entriesOf(listing: DirListing): string[] | null {
	return "entries" in listing ? listing.entries : null;
}

/**
 * Reports a listing that produced nothing, at DEBUG, saying WHICH of the two it was.
 *
 * `ENOENT` is the ordinary state rather than a fault — most machines have never archived a
 * Codex conversation, so `archived_sessions/` simply does not exist — and calling that "not
 * readable" was both wrong and, at the resident daemon's 30-second cadence, wrong on every
 * tick. Anything else is a real failure and carries its errno, which is the only thing that
 * separates a transient `EMFILE` from a permission change after the fact. Both were one
 * indistinguishable line while {@link listDir}'s `catch` threw the code away.
 *
 * Still DEBUG for both: absence is normal, and a scan that saw zero sessions must leave a
 * trace without turning an unremarkable machine into a warning every half minute.
 */
function logUnlistedDir(what: string, dirPath: string, errno: string): void {
	if (errno === "ENOENT") log.debug("%s not found: %s", what, dirPath);
	else log.debug("%s not readable (%s): %s", what, errno, dirPath);
}

/** One directory's rollout files as full paths, or the errno that explains their absence. */
async function listRollouts(dirPath: string): Promise<DirListing> {
	const listing = await listDir(dirPath);
	if (!("entries" in listing)) return listing;
	return { entries: listing.entries.filter((file) => file.endsWith(".jsonl")).map((file) => join(dirPath, file)) };
}

/**
 * Stats (and where needed opens) every rollout, bounded.
 *
 * One rollout per file, so the cost of this scan is the number of rollouts a user has —
 * which on a heavy Codex machine is thousands. Fanned out rather than looped because
 * each file is independent. BOTH per-file operations take a slot from the shared budget —
 * the `stat` in {@link statMtimeProbe} and the first-line read in {@link readFirstLine} —
 * so this running alongside eleven other scans cannot exceed the process-wide total.
 */
async function scanRollouts(filePaths: ReadonlyArray<string>, staleMs: number): Promise<CodexDiskSession[]> {
	const scanned = await mapWithConcurrency(filePaths, (filePath) => tryParseSessionMeta(filePath, staleMs));
	return scanned.filter((session): session is CodexDiskSession => session !== null);
}

/**
 * Scans a flat directory of rollouts — the archived half, which has no date tree.
 *
 * Keeps a failed listing distinct from an empty one, the same way {@link scanSessionsDirectory}
 * does. Both answers contribute nothing to THIS scan — nothing is memoized here, so the next
 * one retries either way — but only one of them is worth a line, and a bare `?? []` threw away
 * the distinction {@link DirListing} exists to carry: without it, a `post-commit` scan that
 * silently saw zero archived sessions left no trace anywhere, having decided which sessions
 * belong to that commit.
 *
 * WHICH failure it was comes from the errno, not from this call site. Saying "not readable"
 * for every one of them was a claim the code could not back — `archived_sessions/` is absent
 * on most machines, so the overwhelmingly common `ENOENT` was reported as a fault, and the
 * genuinely interesting `EMFILE`/`EACCES` printed the identical bytes. See
 * {@link logUnlistedDir}.
 */
async function scanFlatDirectory(dirPath: string, staleMs: number): Promise<CodexDiskSession[]> {
	const listing = await listRollouts(dirPath);
	if (!("entries" in listing)) {
		logUnlistedDir("Codex archived sessions directory", dirPath, listing.errno);
		return [];
	}
	return scanRollouts(listing.entries, staleMs);
}

/** The two facts a rollout's first line yields, plus the mtime it was read at. */
interface MemoizedSessionMeta {
	readonly sessionId: string;
	readonly cwd: string;
	/** Detects a REPLACED file — see {@link SESSION_META_MEMO}. */
	readonly mtimeMsAtRead: number;
}

/**
 * Per-process memo of `session_meta`, keyed by rollout path.
 *
 * ## Why this exists
 *
 * The `stat` gate above answers "is this rollout inside the window" without opening
 * anything, which is what lets the walk cover every date directory. It does NOT
 * answer "which repo is this" — that needs `session_meta.cwd`, which needs the open.
 * So an ACTIVE conversation is opened, read and JSON-parsed on every single scan,
 * including the overwhelming majority of scans where nothing about it changed. In a
 * one-shot process that is one read; in the global daemon it is one read per
 * in-window rollout every 30 s, 2,880 times a day, for the whole life of the daemon.
 *
 * ## Why memoizing is safe rather than merely cheap
 *
 * A rollout's first line is `session_meta`, written once when the conversation is
 * created and never rewritten — Codex only ever APPENDS. So `sessionId` and `cwd` are
 * immutable for the life of the file, and reusing them is not a staleness trade at
 * all: a memo hit returns exactly what a re-read would have returned.
 *
 * Crucially the memo does NOT cover `updatedAt`. That still comes from the `stat`
 * this scan just performed, so a conversation that grew still reports its new instant
 * and is still re-read downstream. Caching the mutable half is the version of this
 * that would lose data; caching only the immutable half cannot.
 *
 * `mtimeMsAtRead` is a PARTIAL guard against the one way a path's first line can
 * change — the file being replaced by a different one at the same path — and it is
 * worth being exact about which half it covers, because the obvious reading is too
 * generous. Any append moves mtime forward, so a new mtime at or after the recorded one
 * is indistinguishable from an append and keeps the entry; only mtime moving BACKWARDS
 * is something appending cannot produce, so only that drops the entry. A replacement
 * written LATER than the memoized read therefore passes as an append, and the stale
 * `sessionId`/`cwd` are served for the life of the process. (`mtimeMsAtRead` is also not
 * refreshed on a hit, so the comparison stays anchored to the first read.)
 *
 * That residue is accepted rather than closed, and the reason is the key space: a Codex
 * rollout filename embeds the conversation's own UUID, so two different conversations
 * cannot collide on a path, and a replacement can only be the same conversation
 * restored from a copy — where the first line is the same anyway. Closing it properly
 * would mean re-reading the line to check, which is the cost the memo exists to remove.
 *
 * ## Bounding
 *
 * Entries are only created for rollouts inside the window, so the live set is small
 * and the map grows at the rate the user starts NEW conversations. A whole-map clear
 * past {@link SESSION_META_MEMO_LIMIT} is the entire eviction policy, and it is
 * deliberately not an LRU or a prune-to-this-scan's-paths: pruning to the last scan's
 * result would thrash in any process that scans with two different windows (the
 * 48 h live path and the 7-day back-fill path both exist), and the cost of a clear is
 * one extra read per file — the behaviour that was already there.
 */
const SESSION_META_MEMO = new Map<string, MemoizedSessionMeta>();

/** Entry count past which the memo is dropped whole. See {@link SESSION_META_MEMO}. */
const SESSION_META_MEMO_LIMIT = 20_000;

function rememberSessionMeta(filePath: string, facts: MemoizedSessionMeta): void {
	setBounded(SESSION_META_MEMO, SESSION_META_MEMO_LIMIT, filePath, facts, (size) =>
		log.debug("Codex session_meta memo hit %d entries — clearing", size),
	);
}

/**
 * Test-only: forgets every memoized `session_meta` AND every memoized day listing.
 *
 * Production never needs this — both memos are correct for the life of the process (see
 * above). Tests need it because a case that rewrites a fixture at a path an earlier
 * case already read would otherwise be served the earlier case's answer.
 *
 * Both are cleared by this ONE function on purpose. A test that writes a new rollout
 * into a past day directory a previous case already listed needs the listing forgotten
 * too, and a second reset export is one more thing a new test can forget to call —
 * which would present as an unrelated case mysteriously seeing no sessions.
 */
export function resetCodexSessionMetaMemo(): void {
	SESSION_META_MEMO.clear();
	DAY_LISTING_MEMO.clear();
}

/**
 * Reads a rollout's mtime and, when it is inside the window, its session_meta.
 * Returns the rollout's facts, or null.
 *
 * ## Why the mtime is taken FIRST
 *
 * Two reasons, and the second is a correctness one.
 *
 * It is the cheap half. A rollout outside the window is answered by one `stat` and
 * is never opened, which is what lets the caller walk every date directory instead
 * of guessing which ones could hold a recent session.
 *
 * And the instant recorded here is the one written to the database as this session's
 * `updated_at_ms`, while the transcript itself is read LATER (by the collector, once
 * this session survives repo attribution). Taking the mtime before that read means a
 * line appended in between makes the stored instant OLDER than the file — so the
 * next scan sees a newer mtime and re-reads. Taking it after would stamp the row as
 * current for content this pass never saw, which is the one way this scheme can lose
 * data rather than merely repeat work.
 *
 * Repo attribution is deliberately NOT done here: it belongs to
 * {@link codexSessionsForRepo}, so one scan of this global tree can serve every
 * registered repo instead of being re-run per repo.
 */
async function tryParseSessionMeta(filePath: string, staleMs: number): Promise<CodexDiskSession | null> {
	const probe = await statMtimeProbe(filePath);
	if (probe.kind !== "ok") {
		if (probe.kind === "missing") {
			// A memoized listing named a rollout that is gone — archiving is a `rename` out
			// of the day directory. Drop the listing (and this path's own memo entry) so the
			// next scan re-lists that one directory, instead of paying this `stat` and
			// printing this line every 30 s for the rest of the process's life.
			forgetDayListing(filePath);
			SESSION_META_MEMO.delete(filePath);
		}
		log.debug("Cannot stat Codex session file: %s", filePath);
		return null;
	}
	const mtimeMs = probe.mtimeMs;

	// Before the open, so an out-of-window rollout costs one `stat`. The staleness
	// log names the PATH rather than the session id, which is only knowable after
	// the read this branch exists to avoid.
	const age = Date.now() - mtimeMs;
	if (age > staleMs) {
		log.debug("Stale Codex rollout %s (age: %dh)", filePath, Math.round(age / 3600000));
		return null;
	}

	// After the window check, so the memo only ever holds rollouts a scan would have
	// opened anyway. `updatedAt` still comes from the `stat` above — only the two
	// immutable facts are reused.
	const memoized = SESSION_META_MEMO.get(filePath);
	if (memoized !== undefined && mtimeMs >= memoized.mtimeMsAtRead) {
		return {
			sessionId: memoized.sessionId,
			transcriptPath: filePath,
			updatedAt: new Date(mtimeMs).toISOString(),
			dirs: [memoized.cwd],
		};
	}

	let firstLine: string;
	try {
		firstLine = await readFirstLine(filePath);
	} catch {
		log.debug("Cannot read Codex session file: %s", filePath);
		return null;
	}

	if (!firstLine) {
		return null;
	}

	try {
		const data = JSON.parse(firstLine) as Record<string, unknown>;

		if (data.type !== "session_meta") {
			log.debug("First line is not session_meta in %s", filePath);
			return null;
		}

		const payload = data.payload as Record<string, unknown> | undefined;
		if (!payload || typeof payload !== "object") {
			return null;
		}

		const cwd = payload.cwd;
		const id = payload.id;

		if (typeof cwd !== "string" || typeof id !== "string") {
			return null;
		}

		// `data.timestamp` is deliberately unread: it is the creation instant, and
		// using it here is the defect this module's header describes.
		//
		// The cwd is carried, not matched. `codexSessionsForRepo` does the matching
		// through `sessionDirBelongsToRepo` (shared with Devin/OpenCode/Copilot):
		// prefix/containment with separator + case folding (handling the Windows
		// "e:\foo" vs "E:\foo" drive-letter drift) plus the nested-repo exclusion. That
		// replaced an exact `resolvedCwd === resolvedProject` match, which silently
		// dropped every session run from a subdirectory of the repo (JOLLI-2015).
		rememberSessionMeta(filePath, { sessionId: id, cwd, mtimeMsAtRead: mtimeMs });
		return {
			sessionId: id,
			transcriptPath: filePath,
			updatedAt: new Date(mtimeMs).toISOString(),
			dirs: [cwd],
		};
	} catch (error: unknown) {
		log.debug("Failed to parse session_meta from %s: %s", filePath, (error as Error).message);
		return null;
	}
}

/**
 * Reads only the first line of a file using a stream (efficient for large files).
 * Closes the stream immediately after reading one line.
 */
function readFirstLine(filePath: string): Promise<string> {
	// Zero bytes claimed: this reads one line, not the file, so it needs a slot (to
	// bound how many rollouts are open at once) and none of the byte allowance.
	return withIoBudget(0, () => readFirstLineUnbudgeted(filePath));
}

function readFirstLineUnbudgeted(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const stream = createReadStream(filePath, { encoding: "utf-8" });
		const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
		let resolved = false;

		rl.on("line", (line: string) => {
			resolved = true;
			rl.close();
			stream.destroy();
			resolve(line);
		});

		rl.on("close", () => {
			if (!resolved) {
				resolve("");
			}
		});

		/* v8 ignore start - stream read errors are rare filesystem issues */
		stream.on("error", (err: Error) => {
			if (!resolved) {
				reject(err);
			}
		});
		/* v8 ignore stop */
	});
}

/** What one `stat` of a rollout can tell this scan. */
type MtimeProbe =
	/** Usable modification time, in epoch milliseconds. */
	| { readonly kind: "ok"; readonly mtimeMs: number }
	/** The path is gone, so any memoized listing that named it is stale. */
	| { readonly kind: "missing" }
	/** It may well be there; this pass cannot use it. */
	| { readonly kind: "unreadable" };

/**
 * Stats a rollout for the modification time that becomes its `updatedAt` — see the module
 * header for why that replaced `session_meta.timestamp` rather than merely backing it up.
 *
 * Distinguishes "gone" from "unreadable" because only the first says something about the
 * cache: an archived rollout is a `rename` out of its day directory, and that is the one
 * way a memoized listing can be wrong.
 */
async function statMtimeProbe(filePath: string): Promise<MtimeProbe> {
	let ms: number;
	try {
		// Zero bytes claimed: a `stat` reads no content, so it needs a slot (to bound how
		// many the walk has outstanding) and none of the byte allowance. Skipping the
		// budget here is what left the one scan that touches EVERY rollout the user has
		// ever recorded unbounded in aggregate, whatever `mapWithConcurrency`'s limit said,
		// while eleven other stores' reads shared the budget it ignored.
		const fileStat: Stats = await withIoBudget(0, () => stat(filePath));
		// `mtime.getTime()` rather than `mtimeMs`, and that is the safer of the two rather
		// than the longer: `mtime` is derived from `mtimeMs`, so an out-of-`Date`-range value
		// yields NaN here and is rejected, whereas the raw float is finite and would reach
		// `new Date(ms).toISOString()` below as a `RangeError` — thrown inside the fan-out,
		// taking the whole scan with it. Either way an unparseable mtime would otherwise
		// produce a session with an undateable `updatedAt`: discovered, counted, and
		// impossible to project into any bucket.
		//
		// INSIDE the try, which is the point of reading it here rather than after: the whole
		// reason this line is spelled the long way is that a degenerate `mtime` must not throw
		// out of the fan-out, and leaving the dereference outside the guard left the one shape
		// that still could — a `Stats` whose `mtime` is absent, which is unreachable through
		// real `node:fs` but is exactly what a hand-built `stat` stub in a test produces. A
		// `TypeError` there is a failure to READ the file's time, which is what `unreadable`
		// means, so it belongs in the same answer as a failed `stat`.
		ms = fileStat.mtime.getTime();
	} catch (error: unknown) {
		const code = (error as { readonly code?: unknown } | null)?.code;
		return { kind: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable" };
	}
	return Number.isFinite(ms) ? { kind: "ok", mtimeMs: ms } : { kind: "unreadable" };
}

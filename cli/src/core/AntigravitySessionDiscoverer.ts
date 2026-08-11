/**
 * Antigravity Session Discoverer
 *
 * On-demand scanner for Antigravity conversations. Each conversation is a
 * per-conversation SQLite db under `~/.gemini/<variant>/conversations/<id>.db`
 * whose `trajectory_metadata_blob(id='main')` protobuf records the workspace
 * `file://` URI (used to scope the conversation to a repo). The readable
 * transcript is a sibling plaintext JSONL at
 * `~/.gemini/<variant>/brain/<id>/.system_generated/logs/transcript_full.jsonl`.
 *
 * Unlike Cursor (which needs a VS Code workspace-hash lookup), Antigravity
 * records the workspace path inside each conversation db, so attribution is a
 * direct per-db comparison against projectDir.
 *
 * The db is WAL-mode; reads go through `withSqliteDb` (node:sqlite, WAL-aware).
 *
 * ## Every filesystem call here is async, and that is a hard rule
 *
 * This scanner used `readdirSync` / `statSync` / `existsSync`, two of them inside
 * the per-conversation loop. A synchronous call blocks the whole event loop, so it
 * does not merely make THIS scan serial — it freezes every other scan running
 * concurrently, including the Claude transcript fan-out. On a machine with a long
 * Antigravity history that turned the entire concurrent discovery phase back into
 * a serial one, from the outside indistinguishable from "the disk is slow".
 *
 * Antigravity was the only discoverer doing this. Do not reintroduce a `*Sync`
 * filesystem call in any of them.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createLogger, errMsg, isEnoent } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { mapWithConcurrency, withIoBudget } from "../util/Concurrency.js";
import { getAntigravityVariants } from "./AntigravityDetector.js";
import { unwrapUserRequest } from "./AntigravityTranscriptReader.js";
import { type AlreadyCurrent, type DiskSession, sessionsForRepo } from "./DiskSessionScan.js";
import { resolveWorktreeRoots } from "./GitOps.js";
import { sessionDirBelongsToRepo } from "./SessionDirMatch.js";
import { classifyScanError, hasNodeSqliteSupport, type SqliteScanError, withSqliteDb } from "./SqliteHelpers.js";

const log = createLogger("AntigravityDiscoverer");

/** Default window: conversations older than 48 hours are considered stale (matches other sources). */
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

const TRANSCRIPT_RELPATH = [".system_generated", "logs", "transcript_full.jsonl"] as const;
const FILE_URI_PREFIX = "file://";

export interface AntigravityScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	/** Present only on a genuine (non-ENOENT) scan failure. */
	readonly error?: SqliteScanError;
}

/**
 * Recovers the workspace path from a `trajectory_metadata_blob`. The blob is
 * protobuf; rather than decode the full schema we locate the first `file://`
 * string-field *value* and read it using its length prefix.
 *
 * A protobuf `string` field is encoded as `<tag> <varint length> <bytes>`, so
 * the byte immediately before the value is the terminal byte of a length
 * varint. Reading that length gives the exact field bytes — robust even when
 * the following field's tag byte is itself printable (e.g. `0x3a` = ':'), which
 * a "scan until control byte" heuristic would run straight past.
 */
export function extractWorkspacePath(blob: Uint8Array): string | undefined {
	const buf = Buffer.from(blob);
	const idx = buf.toString("latin1").indexOf(FILE_URI_PREFIX);
	if (idx <= 0) return undefined;

	// Walk back over the length varint (its non-terminal bytes have MSB set).
	let start = idx - 1;
	while (start > 0 && (buf[start - 1] & 0x80) !== 0) start--;
	let len = 0;
	let shift = 0;
	for (let p = start; p <= idx - 1; p++) {
		len |= (buf[p] & 0x7f) << shift;
		shift += 7;
	}
	if (len < FILE_URI_PREFIX.length || idx + len > buf.length) return undefined;

	const value = buf.toString("utf8", idx, idx + len);
	/* v8 ignore next -- unreachable: `idx` is a latin1 (byte-for-byte) match on the ASCII prefix and the guard above proves the slice is at least that long, so the utf8 re-decode always starts with it. Kept as a belt-and-braces guard in case the offset search above is ever changed to something lossier. */
	if (!value.startsWith(FILE_URI_PREFIX)) return undefined;
	// Antigravity is VS Code-based; the recorded URI is percent-encoded
	// (`Uri.toString()`), so spaces / non-ASCII segments arrive as %XX and must
	// be decoded before the on-disk path comparison. Fall back to the raw slice
	// if the value carries a malformed %-escape.
	let path = value.slice(FILE_URI_PREFIX.length);
	try {
		path = decodeURIComponent(path);
	} catch {
		// malformed %-escape: keep the raw slice
	}
	// On Windows the drive is encoded as `file:///C:/…`, so the slice leaves a
	// spurious leading slash before the drive letter (`/C:/…`). Strip it so the
	// result matches a native `C:\…` path once normalized — otherwise
	// `normalizePathForCompare` keeps the leading `/` and the workspace never
	// matches projectDir. POSIX paths (`/Users/…`) have no drive letter and are
	// left untouched.
	if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
	return path;
}

/**
 * Streams the transcript line-by-line and returns the first USER_INPUT's
 * unwrapped request text as a title (undefined if none / unreadable). Streaming
 * with early-exit avoids loading a multi-MB transcript into memory just to read
 * a title, and the underlying fd is always destroyed.
 */
async function readTitle(transcriptPath: string): Promise<string | undefined> {
	try {
		const stream = createReadStream(transcriptPath, { encoding: "utf8" });
		const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
		try {
			for await (const line of rl) {
				if (!line.trim()) continue;
				let obj: Record<string, unknown>;
				try {
					obj = JSON.parse(line);
				} catch {
					continue;
				}
				if (obj.type !== "USER_INPUT" || typeof obj.content !== "string") continue;
				const text = unwrapUserRequest(obj.content);
				if (text) return text.length > 120 ? `${text.slice(0, 120)}…` : text;
			}
		} finally {
			rl.close();
			stream.destroy();
		}
	} catch (err) {
		// ENOENT: transcript vanished between the caller's existence `stat`
		// and this open — a race that's fundamentally untestable without
		// invasive fs mocking. Narrowed from the previous `v8 ignore next`
		// covering the whole `if (!isEnoent(err)) log.debug(...)` line
		// (which also excused the non-ENOENT log-debug call) to the silent-
		// return statement alone, so a test that throws any other error
		// still counts against the debug-log line's coverage.
		if (isEnoent(err)) {
			/* v8 ignore next -- untestable ENOENT race, see comment above */
			return undefined;
		}
		log.debug("readTitle stream failed for %s: %s", transcriptPath, errMsg(err));
	}
	return undefined;
}

/**
 * Discovers Antigravity conversations relevant to the given project directory.
 *
 * @param windowMs Optional staleness window, in milliseconds. Defaults to
 * `SESSION_STALE_MS` (48h), the window shared by every discovery-based source.
 * The dashboard's history back-fill passes a wider one (7 days) so it can reach
 * further into the past. Callers that must NOT widen simply omit it: the VS Code
 * / IntelliJ "Active Conversations" sidebar, `jolli status`, and above all the
 * post-commit summary generation in `hooks/QueueWorker.ts`, which uses this
 * session set to decide which conversations belong to the commit being
 * summarised. Widening it there folds week-old unrelated conversations into that
 * commit's stored memory, which is written to the git orphan branch and is
 * persistent — and it fails invisibly, with no error, just wrong content.
 */
export async function scanAntigravitySessions(
	projectDir: string,
	home?: string,
	windowMs?: number,
): Promise<AntigravityScanResult> {
	const { sessions, error } = await scanAntigravitySessionsOnDisk(home, windowMs);
	const mine = await antigravitySessionsForRepo(sessions, projectDir);
	log.debug("Discovered %d Antigravity session(s) for %s", mine.length, projectDir);
	return error ? { sessions: mine, error } : { sessions: mine };
}

/** A machine-wide Antigravity scan: every in-window conversation, plus the first failure. */
export interface AntigravityDiskScanResult {
	readonly sessions: ReadonlyArray<DiskSession>;
	readonly error?: SqliteScanError;
}

export interface ScanAntigravityOptions {
	/**
	 * Lets the scan skip the two expensive steps — the SQLite open and the streaming
	 * title read — for a conversation the database already holds at or past its
	 * recorded instant.
	 *
	 * Applicable here for the same reason it is applicable to Claude, and only
	 * because of an ordering accident worth stating: this scanner learns the
	 * conversation's id from the FILENAME and its instant from the staleness `stat`,
	 * both of which happen before anything expensive. So the skip has everything it
	 * needs at exactly the point where acting on it saves the most.
	 *
	 * What it gives up is the workspace path, which lives in the protobuf blob inside
	 * the database — so a skipped conversation cannot be attributed to a repo and is
	 * dropped from this scan's result. That is not the loss it looks like: the skip
	 * only fires when every repo holding a row for the conversation is already
	 * current, so no repo had anything to write. The visible effect is that such a
	 * conversation is not counted among the run's discovered ones. Claude takes the
	 * other branch — it keeps the session using the directories the tail already gave
	 * it — because there the cheap read happens to carry a usable answer; here there
	 * is no cheap way to learn the workspace at all.
	 *
	 * Omitted means "read everything properly", which is what every non-back-fill
	 * caller wants.
	 */
	readonly alreadyRecorded?: AlreadyCurrent;
}

/**
 * Scans every Antigravity conversation database on this machine once and returns the
 * in-window ones, each carrying the workspace path its metadata blob recorded.
 *
 * MACHINE-WIDE and repo-agnostic on purpose. `~/.gemini/<variant>/conversations/`
 * holds one SQLite file per conversation with no repo in its name, so attributing any
 * of them means opening the database and decoding a protobuf blob — work a
 * repo-scoped scan repeated for every registered repo. Callers scan once and narrow
 * with {@link antigravitySessionsForRepo}.
 *
 * ## One cost moved, one deliberately not
 *
 * The repo-scoped version checked for the transcript file and read its title only
 * AFTER the workspace matched. The TITLE read has moved back behind the match — it now
 * happens in {@link antigravitySessionsForRepo}, which is free for the back-fill and
 * restores the single-repo callers' old cost; see that function for why it is sound
 * here and would not be for Claude.
 *
 * The transcript `stat` stays, and cannot move: a conversation with no
 * `transcript_full.jsonl` yet is DROPPED, so the check decides what the scan returns
 * rather than decorating it. It is one `stat` on a conversation that already passed
 * the staleness gate and already cost a database open.
 *
 * That database open is the cost nobody can amortise away, and it is structural rather
 * than accepted-out-of-laziness: unlike Cursor's workspace lookup there is no cheap
 * test for "this repo claims nothing here", because the workspace path lives inside
 * the protobuf blob — so the database has to be opened before attribution can be
 * decided at all, by a machine-wide scan and a repo-scoped one alike.
 */
export async function scanAntigravitySessionsOnDisk(
	home?: string,
	windowMs?: number,
	opts: ScanAntigravityOptions = {},
): Promise<AntigravityDiskScanResult> {
	// A runtime below the Node floor cannot load node:sqlite. Gate up front (like
	// the detector) so the aggregator's 60s tick on such a VS Code host degrades
	// silently instead of logging a scan failure for every conversation db. The
	// QueueWorker path already gates via isAntigravityInstalled(); this covers
	// direct-scan callers.
	/* v8 ignore start -- only reachable below the Node floor; the discoverer suite is describe.skip there */
	if (!hasNodeSqliteSupport()) return { sessions: [] };
	/* v8 ignore stop */

	const staleMs = windowMs ?? SESSION_STALE_MS;
	const cutoffMs = Date.now() - staleMs;

	// ## Phase 1 — list and stat, then RANK each conversation's variant copies
	//
	// The variant dedupe is why this is a phase of its own rather than a check inside
	// the expensive loop. The same convId can exist under several variants (a user who
	// migrated between `antigravity` / `antigravity-ide` / `-cli` keeps the id), and the
	// newest copy is tried first. That used to be decided by consulting a map WHILE filling it,
	// which is only correct while the loop is sequential: run the same test concurrently
	// and the answer depends on which `stat` happened to land first, so a run could open
	// the older copy's database, or both. Deciding it up front from the complete stat
	// set makes the result independent of scheduling — which is the precondition for
	// fanning out phase 2 at all.
	const listed = await mapWithConcurrency(getAntigravityVariants(home), async (variant) => {
		try {
			return (await withIoBudget(0, () => readdir(variant.conversationsDir)))
				.filter((f) => f.endsWith(".db"))
				.map((dbFile) => ({ variant, dbFile }));
		} catch (err) {
			log.debug("Cannot list %s: %s", variant.conversationsDir, errMsg(err));
			return [];
		}
	});

	const statted = await mapWithConcurrency(listed.flat(), async ({ variant, dbFile }) => {
		// Cheap staleness gate first — a `stat` avoids opening SQLite for conversations
		// last touched outside the window (the common case for users with a long
		// Antigravity history).
		const dbPath = join(variant.conversationsDir, dbFile);
		try {
			const mtimeMs = (await withIoBudget(0, () => stat(dbPath))).mtimeMs;
			if (mtimeMs < cutoffMs) return null;
			return { convId: dbFile.slice(0, -3), variant, dbPath, mtimeMs };
		} catch {
			return null;
		}
	});
	const stats = statted.filter((entry): entry is NonNullable<typeof entry> => entry !== null);

	// Every copy of each conversation, NEWEST FIRST. Not just the newest one: a copy can
	// still fail to yield a session — an unreadable database, a blob with no workspace in
	// it, a `brain/` directory whose transcript has not been written yet — and the
	// sequential version this replaced fell through to an older variant's copy when that
	// happened, because it only recorded a winner once one had actually produced a
	// session. Keeping the runners-up restores that: phase 2 walks the list in order and
	// takes the first copy that answers, so a broken newest copy costs the conversation
	// nothing instead of dropping it.
	//
	// The ORDER is fixed here rather than discovered during the scan, which is what makes
	// the outcome independent of scheduling — the precondition for fanning out phase 2 at
	// all. `stats` is in `getAntigravityVariants` order and the sort is stable, so a tie
	// keeps the first variant, exactly as the sequential version reported it.
	const byConvId = new Map<string, Array<(typeof stats)[number]>>();
	for (const entry of stats) {
		const copies = byConvId.get(entry.convId);
		if (copies) copies.push(entry);
		else byConvId.set(entry.convId, [entry]);
	}
	for (const copies of byConvId.values()) copies.sort((a, b) => b.mtimeMs - a.mtimeMs);

	/** Reads ONE copy of a conversation into a session, or explains why it could not. */
	const readCopy = async ({
		convId,
		variant,
		dbPath,
		mtimeMs,
	}: (typeof stats)[number]): Promise<{ session: DiskSession | null; error?: SqliteScanError }> => {
		let workspacePath: string | undefined;
		try {
			workspacePath = await withIoBudget(0, () =>
				withSqliteDb(dbPath, (db) => {
					const row = db
						.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1")
						.get() as { data?: Uint8Array } | undefined;
					return row?.data ? extractWorkspacePath(row.data) : undefined;
				}),
			);
		} catch (err) {
			const scanError = classifyScanError(err);
			if (scanError) {
				log.warn("Antigravity db scan failed (%s) at %s: %s", scanError.kind, dbPath, scanError.message);
				return { session: null, error: scanError };
			}
			// `classifyScanError` returns null for a benign cause (ENOENT — the user
			// deleted the conversation mid-scan), which is a skip, not a failure.
			return { session: null };
		}

		// The workspace is CARRIED, not matched — `antigravitySessionsForRepo` does
		// that. A conversation whose blob yields no workspace can never be
		// attributed, so it is still dropped here.
		if (!workspacePath) return { session: null };

		// A conversation with no transcript yet is DROPPED, not merely left
		// titleless, so the check is load-bearing and cannot be folded into
		// `readTitle`'s own ENOENT handling. `stat` rather than `existsSync` for the
		// event-loop reason in this module's header.
		const transcriptPath = join(variant.brainDir, convId, ...TRANSCRIPT_RELPATH);
		try {
			await withIoBudget(0, () => stat(transcriptPath));
		} catch {
			log.debug("Antigravity convo %s has no transcript_full.jsonl yet", convId);
			return { session: null };
		}

		// No `title`: it is read by {@link antigravitySessionsForRepo}, for the
		// conversations a repo actually claims. See that function for why.
		return {
			session: {
				session: {
					sessionId: convId,
					transcriptPath,
					updatedAt: new Date(mtimeMs).toISOString(),
					source: "antigravity",
				},
				dirs: [workspacePath],
			},
		};
	};

	// ## Phase 2 — the expensive half, one unit per surviving conversation
	//
	// A SQLite open plus a protobuf decode plus a streaming title read, each
	// independent. This is the part whose cost scales with how much Antigravity history
	// a user has, and it was entirely serial.
	//
	// The copies of ONE conversation are tried in order INSIDE the unit rather than
	// fanned out: only the first one that answers is wanted, so trying them concurrently
	// would open databases whose result is thrown away — and duplicates are the rare case
	// anyway (a single-copy conversation is one attempt, exactly as before).
	//
	// Each unit reports its own failure rather than assigning to a shared
	// `firstError`: `mapWithConcurrency` preserves INPUT order in its result but not in
	// its completion order, so an assignment made inside the callback would record
	// whichever database happened to fail first in wall-clock time. "The first failure"
	// has to mean the first in conversation order, which is only decidable once every
	// unit has answered — so it is picked out of the ordered result below. A copy that
	// failed still reports its error even when a fallback copy then succeeded: the
	// unreadable database is a real fact about this machine, and the sequential version
	// surfaced it the same way.
	const scanned = await mapWithConcurrency(
		[...byConvId.values()],
		async (copies): Promise<{ session: DiskSession | null; error?: SqliteScanError }> => {
			// A conversation the database already holds — see
			// {@link ScanAntigravityOptions.alreadyRecorded}. Placed after the staleness
			// gate so the two cheap tests come first, and before everything expensive, and
			// asked ONCE for the whole group: the answer is about the conversation, so a
			// fallback copy of a skipped conversation must not be opened either.
			const newest = copies[0];
			if (opts.alreadyRecorded?.("antigravity", newest.convId, newest.mtimeMs)) {
				log.debug("Antigravity convo %s already recorded -- skipping the db open", newest.convId);
				return { session: null };
			}

			let firstError: SqliteScanError | undefined;
			for (const copy of copies) {
				const attempt = await readCopy(copy);
				firstError ??= attempt.error;
				if (attempt.session)
					return firstError ? { session: attempt.session, error: firstError } : { session: attempt.session };
			}
			return firstError ? { session: null, error: firstError } : { session: null };
		},
	);
	const out = scanned.map((r) => r.session).filter((session): session is DiskSession => session !== null);
	const firstError = scanned.find((r) => r.error !== undefined)?.error;

	log.debug("Antigravity disk scan: %d conversation(s) inside the window", out.length);
	return firstError ? { sessions: out, error: firstError } : { sessions: out };
}

/**
 * Narrows a machine-wide Antigravity scan to one repo.
 *
 * ASYNC, unlike every other source's narrowing, and that is inherent rather than
 * incidental: Antigravity records the checkout the IDE was opened in, which is
 * frequently a DIFFERENT worktree than the one committing, so the match runs against
 * every worktree root of the repo — and enumerating those needs a `git worktree list`
 * that no machine-wide scan can do on the repo's behalf. Resolving the roots is
 * per-repo work by definition, so it belongs on this side.
 *
 * Prefix/containment match (shared `sessionDirBelongsToRepo`, like the other hookless
 * sources): a workspace recorded in a *subdirectory* of a worktree still belongs to
 * the repo (JOLLI-2015), while a nested git repo / submodule inside it is excluded
 * via the helper's `.git` walk.
 *
 * ## The title is read HERE, which is the one place it costs nobody anything extra
 *
 * `readTitle` streams a transcript until the first user turn. Reading it during the
 * machine-wide scan meant doing that for every in-window conversation on the machine,
 * and the callers that lose by it are the ones with nothing to amortise across: the
 * 60 s sidebar tick, `jolli status` and the post-commit summary all ask about ONE
 * repo, so they paid a title read per conversation where the repo-scoped version they
 * replaced paid one per conversation it claimed.
 *
 * Reading it after the match restores that for them and costs the multi-repo back-fill
 * almost nothing, because an Antigravity conversation records exactly ONE workspace —
 * so unlike Claude (27 of 64 real transcripts carry several directories), one
 * conversation cannot fan out across a machine's repos by having touched them all.
 *
 * "Almost" rather than "nothing", because the match is against every WORKTREE of the
 * repo: two registered entries that are two worktrees, or two clones, of one project
 * resolve to overlapping root sets and both claim the same conversation, so its title
 * is read once per such entry. That is bounded by how many checkouts of one project a
 * user has registered, against a machine-wide read for every repo in the old shape.
 *
 * A title that cannot be read leaves the field ABSENT rather than empty, which is what
 * lets `resolveSessionTitle` fall through to its own ladder instead of rendering a
 * blank row.
 */
export async function antigravitySessionsForRepo(
	scanned: ReadonlyArray<DiskSession>,
	projectDir: string,
): Promise<ReadonlyArray<SessionInfo>> {
	const worktreeRoots = await resolveWorktreeRoots(projectDir);
	const mine = sessionsForRepo(scanned, (dir) => worktreeRoots.some((root) => sessionDirBelongsToRepo(dir, root)));
	return mapWithConcurrency(mine, async (session) => {
		// Streams with an early exit on the first user turn, so it claims a slot and
		// none of the byte allowance.
		const title = await withIoBudget(0, () => readTitle(session.transcriptPath));
		return title === undefined ? session : { ...session, title };
	});
}

/**
 * Backwards-compatible wrapper that returns only the session array. Callers that
 * need to surface scan failures should call `scanAntigravitySessions` directly.
 *
 * `windowMs` is forwarded verbatim. QueueWorker itself must keep omitting it —
 * see `scanAntigravitySessions` for why widening the post-commit window corrupts
 * stored memory.
 */
export async function discoverAntigravitySessions(
	projectDir: string,
	home?: string,
	windowMs?: number,
): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions } = await scanAntigravitySessions(projectDir, home, windowMs);
	return sessions;
}

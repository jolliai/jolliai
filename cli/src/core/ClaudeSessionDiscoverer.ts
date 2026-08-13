/**
 * Claude Session Discoverer — the on-disk scan for Claude Code conversations.
 *
 * Every other transcript source has a discoverer that reads its own store; Claude
 * was the exception, reachable only through the per-project `sessions.json`
 * registry the Stop hook writes. That registry is pruned at 48 h by
 * `SessionTracker.pruneStale`, and the prune is a PHYSICAL delete — `saveSession`
 * writes back only the live rows, and every Claude or Gemini turn triggers one. So
 * an older conversation stopped existing as far as the dashboard was concerned even
 * though its transcript sits under `~/.claude/projects/` indefinitely. Measured on
 * a real machine: 3 sessions in `sessions.json` against 64 transcripts / 56 MB on
 * disk, a 21x gap, and every one of those 61 invisible conversations carried skill
 * and MCP call data the dashboard could not see.
 *
 * This module reads those files directly, so back-fill coverage is bounded by what
 * is on disk rather than by what a hook happened to record in the last two days.
 *
 * ## Deliberately NOT wired into `ActiveSessionAggregator`
 *
 * The sidebar answers "what am I talking to right now", which the hook registry
 * already answers from one small per-project file and with the right 48 h horizon.
 * Wiring this in would make every 60 s sidebar tick walk the whole machine-global
 * tree for an answer it already has. This scan exists for back-fill, where reading
 * a 7-day window off disk is the entire point.
 *
 * It also does not REPLACE the `sessions.json` route: that route stays as this
 * one's fallback (and as Gemini's only route at all). Keeping both costs nothing —
 * the collector's existing dedupe merges the two views of one session — while
 * dropping it would mean a failed disk scan leaves Claude completely invisible,
 * where today it would still have 48 h of coverage.
 *
 * ## Why the time comes from the transcript, not from mtime
 *
 * `updatedAt` is the timestamp of the last real conversation turn. Measured over 64
 * real transcripts, the file's mtime runs AHEAD of that by a median of 0.8 h and by
 * as much as 42.8 h (26 of them by more than an hour), because Claude Code keeps
 * appending non-conversational lines — `ai-title`, `queue-operation`, a trailing
 * `lastPrompt`/`leafUuid` record — after the conversation itself has stopped. A
 * window computed from mtime files a two-day-old session under today and stores an
 * instant the session never had: at 48 h it admitted 44 transcripts where the true
 * count was 33.
 *
 * mtime remains a SOUND coarse filter (it can only ever be at or after the last
 * turn, so it never wrongly excludes) and is deliberately unused anyway: the
 * precise value has to be read to be stored, and reading it costs 36 ms for the
 * whole tree, so a separate coarse pass would buy nothing.
 *
 * This argument is about mtime ONLY. It does not transfer to the Stop hook's
 * timestamp, which is the same instant plus the few seconds the hook took to fire
 * (measured +3.9 s / +2.7 s / +2.5 s) — harmless for every bucket the dashboard
 * draws.
 *
 * ## Why the read has two phases
 *
 * The two facts a scan needs have different cost models, and treating them as one is
 * how an earlier version of this module got attribution wrong.
 *
 * The last turn's instant IS answerable from the tail — any later turn would also be
 * in the tail — which is the same shape, for the same reason, as
 * `ClaudeAiTitleReader`. Reading from byte 0 to find it re-parses thousands of
 * tool-call lines: measured 464 ms against 36 ms over the same 64 files.
 *
 * The set of directories a session touched is NOT. A `cwd` recorded only in the
 * middle of the file is invisible to a head+tail read, and the session then goes
 * unattributed for that repo — measured, head+tail disagreed with a full read on 24
 * of 64 transcripts. So the tail read is a GATE (is this file worth opening
 * properly?) and the full read produces the facts, for in-window files only. Total
 * cost therefore scales with recent activity rather than with total history.
 *
 * Neither phase re-states `parseTranscriptLine`'s notion of a conversation turn;
 * both call it. See {@link scanSlice} for what a hand-rolled equivalent got wrong.
 */

import type { FileHandle } from "node:fs/promises";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createLogger, errMsg, isEnoent } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { mapWithConcurrency, withIoBudget } from "../util/Concurrency.js";
import type { AlreadyCurrent } from "./DiskSessionScan.js";
import { sessionDirBelongsToRepo } from "./SessionDirMatch.js";
import { BACKFILL_SESSION_WINDOW_MS } from "./SessionWindow.js";
import { parseTranscriptLine } from "./TranscriptReader.js";

const log = createLogger("ClaudeSessionDiscoverer");

/**
 * This scanner's default window, and deliberately NOT the other discoverers' 48 h
 * `SESSION_STALE_MS`: its only caller is the history back-fill, so the back-fill's
 * window IS its default. See {@link BACKFILL_SESSION_WINDOW_MS} for why the two
 * horizons must stay separate constants.
 */
export const CLAUDE_DISK_SCAN_WINDOW_MS = BACKFILL_SESSION_WINDOW_MS;

/** First tail slice scanned for the last conversation turn (phase 1, the gate). */
const TAIL_SCAN_BYTES = 64 * 1024;
/** Multiplier applied when a tail slice held no conversation line. */
const TAIL_ESCALATION = 8;
/** At or below this size the whole file is read — cheaper than two positioned reads. */
const WHOLE_FILE_BYTES = 96 * 1024;

/** One Claude transcript, as the scan understands it. */
export interface ClaudeDiskSession {
	readonly sessionId: string;
	readonly transcriptPath: string;
	/** ISO timestamp of the last real conversation turn. */
	readonly updatedAt: string;
	/**
	 * Every distinct working directory the transcript recorded, in first-seen order.
	 * COMPLETE: it comes from a full read, not from a slice — see
	 * {@link readTranscriptFacts} for why a sampled set silently loses repos.
	 *
	 * Plural because a session follows the user across `cd`: measured, 27 of 64
	 * transcripts carry more than one, 26 of those only subdirectories of the same
	 * repo and one genuinely spanning unrelated trees.
	 *
	 * This field is why the scan has its own type instead of returning `SessionInfo`
	 * directly. `SessionInfo` carries no working directory and has a hand-kept Kotlin
	 * mirror, so adding one there would be a cross-language change for a value that
	 * is consumed and discarded inside {@link claudeSessionsForRepo}.
	 */
	readonly dirs: ReadonlyArray<string>;
	/**
	 * False when {@link dirs} came from the tail alone because the database already
	 * held this session — see {@link ScanClaudeSessionsOptions.alreadyRecorded}.
	 *
	 * Carried rather than kept private because it is the honest label on a
	 * possibly-incomplete field: a consumer that cares whether attribution could have
	 * missed a directory has no other way to ask.
	 *
	 * Nothing reads it in production today — the whole-file facts it used to gate
	 * (tokens, tool calls, the transcript's own lines) are no longer carried out of the
	 * scan at all; see {@link acceptFacts}. It stays because the caveat on `dirs` is
	 * true whether or not anyone is currently acting on it.
	 */
	readonly complete: boolean;
}

export interface ScanClaudeSessionsOptions {
	/** Override for `~/.claude/projects` (tests inject a temp dir). */
	readonly projectsRoot?: string;
	/** Defaults to {@link CLAUDE_DISK_SCAN_WINDOW_MS}. */
	readonly windowMs?: number;
	/** Injected clock, for window-boundary tests. */
	readonly now?: () => number;
	/** Bounded fan-out width; defaults to {@link mapWithConcurrency}'s. */
	readonly concurrency?: number;
	/**
	 * Lets the scan skip PHASE 2 — the whole-file read — for a session the database
	 * already holds at or past the instant phase 1 found.
	 *
	 * This is the difference between a converged re-run costing a 64 KB tail read per
	 * transcript and costing a full read plus a full parse of each one, which is what
	 * it cost when the only skip lived downstream of the scan. See
	 * {@link AlreadyCurrent}, and {@link readTranscriptFacts} for what the cheap path
	 * gives up.
	 *
	 * Omitted means "read everything properly", which is always correct and is what
	 * every non-back-fill caller wants.
	 */
	readonly alreadyRecorded?: AlreadyCurrent;
}

/** Default root of Claude Code's per-project transcript tree. */
export function claudeProjectsRoot(): string {
	return join(homedir(), ".claude", "projects");
}

/** Reads `length` bytes at `position` as UTF-8. */
async function readRange(handle: FileHandle, position: number, length: number): Promise<string> {
	const buf = Buffer.allocUnsafe(length);
	const { bytesRead } = await handle.read(buf, 0, length, position);
	// A slice boundary can split a multi-byte character. That corrupts at most the
	// one line it lands in, and a corrupted line fails `JSON.parse` and is dropped by
	// `scanSlice` — which is why the boundary needs no special handling here.
	return buf.subarray(0, bytesRead).toString("utf-8");
}

/**
 * {@link readRange} under the shared I/O budget, claiming the bytes it will actually
 * materialise.
 *
 * Per READ rather than per file, and that placement is the whole reason the claim is
 * honest. A 64 KB tail read of a 50 MB transcript must claim 64 KB: claiming the file
 * size instead would make the cheap path — the one a converged re-run takes for every
 * transcript — hold the allowance a genuinely large read needs, which is the opposite
 * of the intent. The cost of putting it here is that the file HANDLE is held across
 * the gaps between reads without a slot, so the number of simultaneously open
 * transcripts is bounded by the fan-out width rather than by the budget. That is the
 * accepted half of the trade: an open descriptor costs almost nothing, whereas the
 * bytes are what can take the process down.
 *
 * Never nest this inside another budget call — see {@link withIoBudget}.
 */
function budgetedRead(handle: FileHandle, position: number, length: number): Promise<string> {
	return withIoBudget(length, () => readRange(handle, position, length));
}

/** What one slice of a transcript yielded. */
interface SliceFacts {
	/** Timestamp of the LAST conversation turn in the slice, if it held one. */
	readonly lastTurnAt?: string;
	readonly dirs: ReadonlyArray<string>;
}

/**
 * Extracts the conversation facts from a slice of JSONL.
 *
 * The turn predicate is `parseTranscriptLine` ITSELF, not a restatement of it. That
 * distinction is the whole point: a hand-rolled "has `message.role` and a timestamp"
 * check looks equivalent and is not, because the real parser also drops compaction
 * summaries (`isCompactSummary`), roles other than user/assistant, assistant messages
 * whose content extracts to nothing, and user messages that are only tool results or
 * an IDE/skill injection. Measured over 64 real transcripts, the loose check picked a
 * different last line in 8 of them — and in all 8 the line it picked was one the real
 * parser discards. Since that timestamp drives the window edge, the date bucket and
 * the skip comparison, "close enough" is not a category that exists here.
 *
 * `cwd` is read off the RAW object instead, and must be: it rides on lines that are
 * not conversation turns at all (`attachment`, `queue-operation`), so gating it on the
 * parser would throw away most of the directories a session ever touched.
 *
 * Lines that fail to parse are dropped silently — they are either a partial line at a
 * slice boundary or a record shape this build does not know, and neither is worth
 * failing a scan for.
 */
function scanSlice(text: string, firstLineNo = 0): SliceFacts {
	let lastTurnAt: string | undefined;
	const dirs: string[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line.startsWith("{")) continue;
		let raw: { message?: unknown; cwd?: unknown; type?: unknown };
		try {
			raw = JSON.parse(line) as typeof raw;
		} catch {
			continue;
		}
		if (typeof raw.cwd === "string" && raw.cwd.length > 0 && !dirs.includes(raw.cwd)) {
			dirs.push(raw.cwd);
		}
		// Gate before re-parsing: `parseTranscriptLine` requires a `message` object as
		// its own first real check, so a line without one cannot qualify and the second
		// parse would be pure waste. The gate is a strict subset of the parser's
		// condition, so it cannot change which line wins.
		if (!raw.message || typeof raw.message !== "object") continue;
		const entry = parseTranscriptLine(line, firstLineNo + i);
		// A qualifying turn with no timestamp cannot date anything, so it is not a
		// candidate — but it does not disqualify an earlier one either.
		if (entry?.timestamp) lastTurnAt = entry.timestamp;
	}
	return {
		...(lastTurnAt !== undefined ? { lastTurnAt } : {}),
		dirs,
	};
}

/** A transcript's scanned facts, or null when the file holds no conversation at all. */
interface TranscriptFacts {
	readonly lastTurnAt: string;
	readonly dirs: ReadonlyArray<string>;
	/**
	 * True when `dirs` came from a whole-file read and is therefore the COMPLETE set.
	 * False when the cheap path produced it from the tail alone — see
	 * {@link readTranscriptFacts}.
	 */
	readonly complete: boolean;
}

/** True when `lastTurnAt` is a parseable instant inside the window. */
function inWindow(lastTurnAt: string, windowMs: number, now: number): boolean {
	const ms = Date.parse(lastTurnAt);
	return Number.isFinite(ms) && now - ms <= windowMs;
}

/**
 * Promotes a slice to a transcript's facts, or rejects it as undateable / too old.
 *
 * Only ever called on a WHOLE-FILE slice, which is what makes `complete` sound: the
 * directory set really is every directory the session recorded.
 *
 * ## What this deliberately does NOT keep
 *
 * The bytes. An earlier version parsed them here and carried the result out — the
 * entries, the token tallies and the transcript's own lines — so that the collector
 * could write a session row without opening the file a second time. It was faster and
 * it was unbounded: every in-window transcript stayed resident for the whole run,
 * measured at over 100 MB against a 56 MB corpus, growing linearly with the window and
 * with nothing to cap it. Recovering the memory means paying for the read again where
 * it is needed, per session, which is what `sessionContentFor` now does.
 *
 * Do not reintroduce a carried payload here without a byte cap on the total. The scan
 * has no idea how many transcripts are in the window, so "one file's parse" and "every
 * file's parse at once" look identical from inside this function.
 */
function acceptFacts(facts: SliceFacts, windowMs: number, now: number): TranscriptFacts | null {
	if (!facts.lastTurnAt || !inWindow(facts.lastTurnAt, windowMs, now)) return null;
	return { lastTurnAt: facts.lastTurnAt, dirs: facts.dirs, complete: true };
}

/**
 * Reads one transcript's facts, in two phases with different cost models.
 *
 * The two phases exist because the two facts are NOT equally cheap, and pretending
 * they were is how this module got it wrong the first time. "When did this session
 * last speak" is answerable from the tail, because any later turn would also be in the
 * tail. "Which directories did this session touch" is not answerable from any slice: a
 * `cwd` that appears only in the middle of the file is invisible to a head+tail read,
 * and the session then goes unattributed for that repo. Measured over 64 real
 * transcripts, head+tail produced a different directory set than a full read for 24 of
 * them.
 *
 * So:
 *
 *  - **Phase 1, the gate.** Tail-read for the last turn, widening until one appears.
 *    Rejects a file that holds no conversation at all (entirely `queue-operation` /
 *    `ai-title` records — a normal outcome, not a failure) and one whose last turn is
 *    outside the window. Cheap, and it is what keeps a long history off the phase-2
 *    bill: a machine with years of transcripts pays a 64 KB read for each old one.
 *  - **Phase 2, the facts.** Only for a file that survived the gate, read the whole
 *    thing for the complete directory set. This is the expensive half, and it is now
 *    bounded by recent activity rather than by total history.
 *
 * Phase 2 re-derives `lastTurnAt` and that value — not phase 1's — is the one
 * returned. They agree by construction, and having exactly one authoritative producer
 * is worth more than saving the re-scan.
 */
async function readTranscriptFacts(
	path: string,
	windowMs: number,
	now: number,
	sessionId: string,
	alreadyRecorded?: AlreadyCurrent,
): Promise<TranscriptFacts | null> {
	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		if (size === 0) return null;

		// Below the threshold the two phases collapse: one read is cheaper than a tail
		// read plus a full read of nearly the same bytes. No point consulting
		// `alreadyRecorded` either — the read it would avoid has already happened.
		if (size <= WHOLE_FILE_BYTES) {
			const text = await budgetedRead(handle, 0, size);
			return acceptFacts(scanSlice(text), windowMs, now);
		}

		// Phase 1 — the gate.
		let gate: SliceFacts | undefined;
		let window = TAIL_SCAN_BYTES;
		for (;;) {
			const start = Math.max(0, size - window);
			const tail = scanSlice(await budgetedRead(handle, start, size - start));
			if (tail.lastTurnAt) {
				gate = tail;
				break;
			}
			if (start === 0) return null; // whole file read, no conversation in it
			window *= TAIL_ESCALATION;
		}
		const gateTurnAt = gate.lastTurnAt as string;
		if (!inWindow(gateTurnAt, windowMs, now)) return null;

		// The cheap path. Phase 1 has already established the session's identity and
		// its instant, which is everything the database needs to say "I have this
		// one" — so the whole-file read below buys nothing except a more complete
		// directory set for a session nobody is going to write.
		//
		// The tail's OWN directories are used instead, and they may be incomplete —
		// that is the trade, stated plainly. Claude stamps `cwd` on most lines, so the
		// tail almost always carries the directory the session was last working in,
		// and the one it MIGHT miss is a directory the session left earlier. The
		// consequence of missing one is bounded to cosmetics: this path is only taken
		// when every repo holding a row for this session is already current, so a repo
		// that fails to recognise it had nothing to write anyway — its count of
		// discovered conversations is one lower for the run and no row changes. The
		// moment the session actually has a new turn, its instant moves past the
		// stored one, this branch is not taken, and the full read produces the
		// complete set again.
		const gateMs = Date.parse(gateTurnAt);
		if (alreadyRecorded?.("claude", sessionId, gateMs)) {
			log.debug("claude %s already recorded at its last turn -- skipping the full read", sessionId);
			return { lastTurnAt: gateTurnAt, dirs: gate.dirs, complete: false };
		}

		// Phase 2 — the facts.
		const text = await budgetedRead(handle, 0, size);
		return acceptFacts(scanSlice(text), windowMs, now);
	} finally {
		await handle.close();
	}
}

/** Every `*.jsonl` under `<projectsRoot>/<dir>/`. */
async function listTranscripts(projectsRoot: string): Promise<string[]> {
	let dirs: string[];
	try {
		dirs = await readdir(projectsRoot);
	} catch (err) {
		// A machine with no Claude install has no tree; that is not a fault to report.
		if (!isEnoent(err)) log.info("cannot list %s: %s", projectsRoot, errMsg(err));
		return [];
	}
	const files: string[] = [];
	for (const dir of dirs) {
		try {
			for (const entry of await readdir(join(projectsRoot, dir))) {
				if (entry.endsWith(".jsonl")) files.push(join(projectsRoot, dir, entry));
			}
		} catch {
			// not a directory, or unreadable — skip
		}
	}
	return files;
}

/**
 * Scans every Claude transcript on this machine and returns those whose last
 * conversation turn falls inside the window.
 *
 * MACHINE-WIDE and repo-agnostic on purpose. `~/.claude/projects` is one global
 * tree, so a repo-scoped scan run inside `dbBackfillRepos`' per-repo loop would walk
 * the same files once per registered repo. Callers scan once and narrow with
 * {@link claudeSessionsForRepo}.
 *
 * The encoded directory names under that root are deliberately not parsed. The
 * encoding replaces path separators with `-` without escaping the `-` characters
 * (and the `.` characters) already in the path, so it is lossy — `/Users/zf/.jolli`
 * and `/Users/zf/-jolli` produce the same name — and one repo owns several of those
 * directories anyway (measured: 11 directories holding 43 distinct working
 * directories). The `cwd` recorded inside each file is the exact absolute path, so
 * that is what attribution uses.
 */
export async function scanClaudeSessionsOnDisk(
	opts: ScanClaudeSessionsOptions = {},
): Promise<ReadonlyArray<ClaudeDiskSession>> {
	const projectsRoot = opts.projectsRoot ?? claudeProjectsRoot();
	const windowMs = opts.windowMs ?? CLAUDE_DISK_SCAN_WINDOW_MS;
	const now = opts.now?.() ?? Date.now();
	const files = await listTranscripts(projectsRoot);
	if (files.length === 0) return [];

	const scanned = await mapWithConcurrency(
		files,
		async (path): Promise<ClaudeDiskSession | null> => {
			// The filename IS the session id, which is what lets the skip below decide
			// whether the database already holds this session before the file is opened.
			const sessionId = basename(path).replace(/\.jsonl$/, "");
			try {
				const facts = await readTranscriptFacts(path, windowMs, now, sessionId, opts.alreadyRecorded);
				if (!facts) return null;
				return {
					sessionId,
					transcriptPath: path,
					updatedAt: facts.lastTurnAt,
					dirs: facts.dirs,
					complete: facts.complete,
				};
			} catch (err) {
				// One unreadable transcript must not lose the other sixty.
				log.debug("skipping unreadable transcript %s: %s", path, errMsg(err));
				return null;
			}
		},
		opts.concurrency,
	);

	const sessions = scanned.filter((s): s is ClaudeDiskSession => s !== null);
	log.info("claude disk scan: %d of %d transcript(s) inside the window", sessions.length, files.length);
	return sessions;
}

/**
 * Narrows a machine-wide scan to one repo, as `SessionInfo`s the existing collector
 * consumes unchanged.
 *
 * Attribution is `sessionDirBelongsToRepo` — shared with the codex / opencode /
 * devin discoverers — so a session started in a SUBDIRECTORY still counts while a
 * nested repo's own sessions do not, and Windows/macOS case folding is handled once.
 *
 * This FILTERS, it does not partition: a session is claimed whenever ANY of its
 * directories matches, and the same scanned session may legitimately be claimed by
 * two different repos. Assigning each session to exactly one repo would drop it from
 * the other — measured, 27 of 64 transcripts carry more than one working directory,
 * so that is a live case rather than a hypothetical one.
 */
export function claudeSessionsForRepo(
	scanned: ReadonlyArray<ClaudeDiskSession>,
	projectDir: string,
): ReadonlyArray<SessionInfo> {
	const mine: SessionInfo[] = [];
	for (const session of scanned) {
		if (!session.dirs.some((dir) => sessionDirBelongsToRepo(dir, projectDir))) continue;
		mine.push({
			sessionId: session.sessionId,
			transcriptPath: session.transcriptPath,
			updatedAt: session.updatedAt,
			source: "claude",
		});
	}
	return mine;
}

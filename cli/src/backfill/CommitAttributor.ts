/**
 * CommitAttributor — maps on-disk Claude transcript slices to historical commits.
 *
 * Isolated from the live cursor/queue flow. Operates on the offline indexes built
 * by {@link RawTranscriptScanner} and {@link CommitTargetIndex}.
 *
 * Model (per target commit C, see the recall study doc for why this replaced the
 * earlier "first-committer" anchoring):
 *   - Window = (L, T]  where T = C's commit time (② upper bound: a commit's
 *     conversation can only precede the commit) and L = the previous time any of
 *     C's files was committed (① commit-boundary lower bound: consecutive commits
 *     touching overlapping files don't bleed into each other). L is capped to a
 *     max lookback so a long-dormant file doesn't open a huge window.
 *   - HIGH (file-overlap): a session segment that *edited one of C's files inside
 *     the window* contributes its in-window slice — independent of which commit
 *     "first committed" the file. This is what recovers the conversation even for
 *     commits that are not the first committer of their files.
 *   - MEDIUM (time-window, opt-in via includeMedium / ③): when no session edited
 *     C's files in the window, fall back to in-window segments that end right
 *     before C on a branch-compatible session.
 *   - none → the engine falls back to a diff-only summary.
 */

import { normalizePathForCompare } from "../core/PathUtils.js";
import type { SessionTranscript } from "../core/TranscriptReader.js";
import { createLogger } from "../Logger.js";
import type { TranscriptEntry } from "../Types.js";
import { attributionLowerBound, type CommitTargetIndex } from "./CommitTargetIndex.js";
import type { RawEntry } from "./RawTranscriptScanner.js";

const log = createLogger("CommitAttributor");

const SEGMENT_GAP_MS = 2 * 60 * 60 * 1000; // 2h idle splits a work segment
/** Max window lookback when a commit's files have no earlier commit (e.g. new files). */
const WINDOW_CAP_MS = 7 * 24 * 60 * 60 * 1000;

export interface AttributedCommit {
	readonly commitHash: string;
	readonly confidence: "high" | "medium";
	readonly method: "file-overlap" | "time-window";
	readonly branch: string;
	readonly sessions: ReadonlyArray<SessionTranscript>;
	readonly transcriptEntries: number;
	readonly conversationTurns: number;
}

export interface AttributionResult {
	/** Target commits that earned a confident attribution. */
	readonly attributed: ReadonlyMap<string, AttributedCommit>;
	/** Target commits with no confident attribution (engine → diff-only). */
	readonly skipped: ReadonlyArray<string>;
}

interface Segment {
	readonly start: number;
	readonly end: number; // exclusive
}

interface SessionSegments {
	readonly entries: ReadonlyArray<RawEntry>;
	readonly segs: ReadonlyArray<Segment>;
}

/** Splits a session's time-ordered entries into work segments (branch change / >2h gap). */
function segmentSession(entries: ReadonlyArray<RawEntry>): Segment[] {
	const segs: Segment[] = [];
	let start = 0;
	for (let i = 1; i <= entries.length; i++) {
		let brk = i === entries.length;
		if (!brk) {
			const prev = entries[i - 1];
			const cur = entries[i];
			// Split on a branch change only when BOTH sides have a known branch and
			// they differ. Early Claude transcripts omit `gitBranch` on some lines;
			// treating undefined as a new branch would shred a continuous work run.
			if (cur.gitBranch && prev.gitBranch && cur.gitBranch !== prev.gitBranch) brk = true;
			else if (!Number.isNaN(cur.tsMs) && !Number.isNaN(prev.tsMs) && cur.tsMs - prev.tsMs > SEGMENT_GAP_MS)
				brk = true;
		}
		if (brk) {
			segs.push({ start, end: i });
			start = i;
		}
	}
	return segs;
}

/**
 * True when entry `e` edited one of the commit's files (by repo-relative path or
 * basename). Both sides are folded through {@link normalizePathForCompare} so a
 * transcript path whose case differs from git's (common on case-insensitive
 * Windows/macOS filesystems, where `Src/Foo.ts` and `src/foo.ts` are the same
 * file) still matches. On case-sensitive Linux the fold is a no-op, so genuinely
 * distinct `Foo.ts`/`foo.ts` are NOT merged. `relSet`/`baseSet` are pre-folded.
 */
function touchesFiles(e: RawEntry, relSet: ReadonlySet<string>, baseSet: ReadonlySet<string>): boolean {
	for (const r of e.editedRel) if (relSet.has(normalizePathForCompare(r))) return true;
	for (const b of e.editedBase) if (baseSet.has(normalizePathForCompare(b))) return true;
	return false;
}

function inWindow(e: RawEntry, lo: number, hi: number): boolean {
	return !Number.isNaN(e.tsMs) && e.tsMs > lo && e.tsMs <= hi;
}

function basename(p: string): string {
	const i = p.lastIndexOf("/");
	return i >= 0 ? p.slice(i + 1) : p;
}

/** Appends `e` to the per-commit collection map (dedup by lineNo+session within a commit). */
function collect(map: Map<string, RawEntry[]>, commit: string, e: RawEntry): void {
	const list = map.get(commit);
	if (list) list.push(e);
	else map.set(commit, [e]);
}

/** Picks the most frequent gitBranch among entries (fallback: ""). */
function modalBranch(entries: ReadonlyArray<RawEntry>): string {
	const counts = new Map<string, number>();
	let best = "";
	let bestCount = 0;
	for (const e of entries) {
		if (!e.gitBranch) continue;
		const c = (counts.get(e.gitBranch) ?? 0) + 1;
		counts.set(e.gitBranch, c);
		if (c > bestCount) {
			bestCount = c;
			best = e.gitBranch;
		}
	}
	return best;
}

/** Groups attributed entries into per-session SessionTranscripts for the summarizer. */
function buildSessions(entries: ReadonlyArray<RawEntry>): SessionTranscript[] {
	const bySid = new Map<string, RawEntry[]>();
	for (const e of entries) {
		if (!e.content || !e.role) continue; // only conversational turns reach the LLM
		const list = bySid.get(e.sessionId);
		if (list) list.push(e);
		else bySid.set(e.sessionId, [e]);
	}
	const sessions: SessionTranscript[] = [];
	for (const [sessionId, list] of bySid) {
		// Disjoint segments mean each entry is collected at most once; just order it.
		list.sort((a, b) => a.lineNo - b.lineNo);
		const tEntries: TranscriptEntry[] = list.map((e) => ({
			role: e.role as "human" | "assistant",
			content: e.content as string,
			...(e.ts ? { timestamp: e.ts } : {}),
		}));
		sessions.push({ sessionId, transcriptPath: list[0].transcriptPath, source: "claude", entries: tEntries });
	}
	return sessions;
}

/**
 * HIGH (file-overlap) collection for commit C over one pre-segmented session:
 * any segment that edited one of C's files inside the window contributes its
 * in-window slice.
 */
function collectFileOverlap(
	session: SessionSegments,
	relSet: ReadonlySet<string>,
	baseSet: ReadonlySet<string>,
	lo: number,
	hi: number,
	commit: string,
	into: Map<string, RawEntry[]>,
): boolean {
	const { entries, segs } = session;
	let got = false;
	for (const seg of segs) {
		let touched = false;
		for (let i = seg.start; i < seg.end; i++) {
			if (inWindow(entries[i], lo, hi) && touchesFiles(entries[i], relSet, baseSet)) {
				touched = true;
				break;
			}
		}
		if (!touched) continue;
		got = true;
		for (let i = seg.start; i < seg.end; i++) {
			if (inWindow(entries[i], lo, hi)) collect(into, commit, entries[i]);
		}
	}
	return got;
}

/**
 * MEDIUM (time-window, ③) collection for commit C: in-window segments that end
 * within SEGMENT_GAP before C and are branch-compatible, with no file overlap.
 */
function collectTimeWindow(
	session: SessionSegments,
	lo: number,
	hi: number,
	commitBranch: string | undefined,
	commit: string,
	into: Map<string, RawEntry[]>,
): void {
	const { entries, segs } = session;
	for (const seg of segs) {
		const slice: RawEntry[] = [];
		let segEnd = Number.NEGATIVE_INFINITY;
		for (let i = seg.start; i < seg.end; i++) {
			if (!inWindow(entries[i], lo, hi)) continue;
			slice.push(entries[i]);
			if (entries[i].tsMs > segEnd) segEnd = entries[i].tsMs;
		}
		if (slice.length === 0) continue;
		if (hi - segEnd > SEGMENT_GAP_MS) continue; // work didn't lead straight into the commit
		const sb = modalBranch(slice);
		if (commitBranch && sb && commitBranch !== sb) continue; // branch gate
		for (const e of slice) collect(into, commit, e);
	}
}

/**
 * Attributes transcript slices to the given target commits.
 *
 * @param targets   commit hashes (lacking summaries) to attribute
 * @param bySession scanner output (sessionId → time-ordered RawEntry[])
 * @param index     real-commit target index
 * @param opts.includeMedium  also emit time-window (MEDIUM) attributions (③)
 */
export function attributeCommits(
	targets: ReadonlyArray<string>,
	bySession: ReadonlyMap<string, RawEntry[]>,
	index: CommitTargetIndex,
	opts: { includeMedium?: boolean } = {},
): AttributionResult {
	// Pre-segment every session once (reused across all targets).
	const sessions: SessionSegments[] = [];
	for (const entries of bySession.values()) sessions.push({ entries, segs: segmentSession(entries) });

	const attributed = new Map<string, AttributedCommit>();
	const skipped: string[] = [];

	for (const hash of targets) {
		const meta = index.commitMeta.get(hash);
		const files = index.commitFiles.get(hash);
		if (!meta || !files || files.length === 0) {
			skipped.push(hash); // not a real code commit / no files → diff-only by engine
			continue;
		}
		const hi = meta.ts; // ② commit-time upper bound
		const lo = attributionLowerBound(index, hash, hi, WINDOW_CAP_MS); // ① commit-boundary lower bound
		const relSet = new Set(files.map(normalizePathForCompare));
		const baseSet = new Set(files.map((f) => normalizePathForCompare(basename(f))));

		const high = new Map<string, RawEntry[]>();
		let gotFileOverlap = false;
		for (const s of sessions) {
			if (collectFileOverlap(s, relSet, baseSet, lo, hi, hash, high)) gotFileOverlap = true;
		}

		let method: "file-overlap" | "time-window" = "file-overlap";
		let entries = high.get(hash);
		if (!gotFileOverlap && opts.includeMedium) {
			const med = new Map<string, RawEntry[]>();
			for (const s of sessions) collectTimeWindow(s, lo, hi, meta.branch, hash, med);
			entries = med.get(hash);
			method = "time-window";
		}

		if (!entries || entries.length === 0) {
			skipped.push(hash);
			continue;
		}
		const sessionsOut = buildSessions(entries);
		if (sessionsOut.length === 0) {
			skipped.push(hash); // attributed entries were all non-conversational tool calls
			continue;
		}
		const conversationTurns = sessionsOut.reduce(
			(sum, s) => sum + s.entries.filter((e) => e.role === "human").length,
			0,
		);
		const transcriptEntries = sessionsOut.reduce((sum, s) => sum + s.entries.length, 0);
		attributed.set(hash, {
			commitHash: hash,
			confidence: method === "file-overlap" ? "high" : "medium",
			method,
			branch: modalBranch(entries),
			sessions: sessionsOut,
			transcriptEntries,
			conversationTurns,
		});
	}

	log.info("Attribution: %d high/med, %d skipped (of %d targets)", attributed.size, skipped.length, targets.length);
	return { attributed, skipped };
}

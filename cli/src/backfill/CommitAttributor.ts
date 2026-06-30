/**
 * CommitAttributor — maps on-disk Claude transcript slices to historical commits.
 *
 * Isolated from the live cursor/queue flow. Operates on the offline indexes built
 * by {@link RawTranscriptScanner} and {@link CommitTargetIndex}. The algorithm and
 * its confidence tiers were validated against real local data (see the plan):
 * locality holds — a commit's edits form a single contiguous run in a session, so
 * attribution propagates safely from a file-overlap anchor to its neighbours.
 *
 * Per target commit C the result is one of:
 *   - HIGH (file-overlap): at least one edited file in the attributed run matches
 *     C's diff (C is the first commit to touch that file after the edit). The run
 *     = the anchor edits + the conversational turns the propagation reaches.
 *   - MEDIUM (time-window, opt-in): no file overlap, but a single anchor-less work
 *     segment ends immediately before C with no competing commit in the gap.
 *   - skipped: contested / no signal — nothing is generated (宁缺毋滥).
 */

import type { SessionTranscript } from "../core/TranscriptReader.js";
import { createLogger } from "../Logger.js";
import type { TranscriptEntry } from "../Types.js";
import { anchorCommitForEdit, type CommitTargetIndex } from "./CommitTargetIndex.js";
import type { RawEntry } from "./RawTranscriptScanner.js";

const log = createLogger("CommitAttributor");

const SEGMENT_GAP_MS = 2 * 60 * 60 * 1000; // 2h idle splits a work segment
const ONE_SIDED_MS = 30 * 60 * 1000; // one-sided propagation reach

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
	/** Target commits with no confident attribution (skipped under 宁缺毋滥). */
	readonly skipped: ReadonlyArray<string>;
}

interface Segment {
	readonly start: number;
	readonly end: number; // exclusive
}

/** Splits a session's time-ordered entries into work segments. */
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
			// treating undefined as a new branch would shred a continuous work run
			// into spurious segments. Undefined inherits the surrounding branch.
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

/** Modal commit hash among an entry's edited files (first file wins on ties). */
function anchorForEntry(index: CommitTargetIndex, e: RawEntry): string | null {
	if (e.editedRel.length === 0 || Number.isNaN(e.tsMs)) return null;
	const counts = new Map<string, number>();
	let bestHash: string | null = null;
	let bestCount = 0;
	for (let k = 0; k < e.editedRel.length; k++) {
		const hash = anchorCommitForEdit(index, e.editedRel[k], e.editedBase[k] ?? "", e.tsMs);
		if (!hash) continue;
		const c = (counts.get(hash) ?? 0) + 1;
		counts.set(hash, c);
		if (c > bestCount) {
			bestCount = c;
			bestHash = hash;
		}
	}
	return bestHash;
}

/** Appends `e` to the per-commit collection map. */
function collect(map: Map<string, RawEntry[]>, commit: string, e: RawEntry): void {
	const list = map.get(commit);
	if (list) list.push(e);
	else map.set(commit, [e]);
}

/**
 * File-overlap (HIGH) attribution within one session: anchor edits, then
 * propagate to no-signal neighbours bounded by the segment and by competing
 * anchors. Only commits in `targetSet` are collected. Anchors pointing at
 * non-target commits still act as propagation boundaries.
 */
function attributeSessionHigh(
	entries: ReadonlyArray<RawEntry>,
	index: CommitTargetIndex,
	targetSet: ReadonlySet<string>,
	into: Map<string, RawEntry[]>,
	anchorlessSegments: { entries: RawEntry[] }[],
): void {
	const anchors = entries.map((e) => anchorForEntry(index, e));
	for (const seg of segmentSession(entries)) {
		const anchored: { idx: number; commit: string }[] = [];
		for (let i = seg.start; i < seg.end; i++) {
			const a = anchors[i];
			if (a) anchored.push({ idx: i, commit: a });
		}
		if (anchored.length === 0) {
			anchorlessSegments.push({ entries: entries.slice(seg.start, seg.end) });
			continue;
		}
		for (let i = seg.start; i < seg.end; i++) {
			let commit: string | null = anchors[i];
			if (!commit) {
				const before = lastBefore(anchored, i);
				const after = firstAfter(anchored, i);
				if (before && after && before.commit === after.commit) {
					commit = before.commit; // enclosed by same commit → inherit
				} else if (before && after) {
					commit = null; // contested boundary → skip
				} else {
					const one = before ?? after;
					if (one && withinReach(entries[i], entries[one.idx])) commit = one.commit;
				}
			}
			if (commit && targetSet.has(commit)) collect(into, commit, entries[i]);
		}
	}
}

function lastBefore(anchored: ReadonlyArray<{ idx: number; commit: string }>, i: number) {
	let res: { idx: number; commit: string } | undefined;
	for (const a of anchored) {
		if (a.idx < i) res = a;
		else break;
	}
	return res;
}

function firstAfter(anchored: ReadonlyArray<{ idx: number; commit: string }>, i: number) {
	for (const a of anchored) if (a.idx > i) return a;
	return undefined;
}

function withinReach(a: RawEntry, b: RawEntry): boolean {
	if (Number.isNaN(a.tsMs) || Number.isNaN(b.tsMs)) return false;
	return Math.abs(a.tsMs - b.tsMs) <= ONE_SIDED_MS;
}

/**
 * Time-window (MEDIUM) attribution: for an anchor-less work segment, attribute it
 * to a target commit iff exactly one *uncovered* target was committed within
 * `SEGMENT_GAP_MS` after the segment ended (the work led straight into it).
 *
 * Branch gate: a candidate on a *different* branch than the segment is dropped —
 * a branch-A discussion must not be attributed to a branch-B commit that merely
 * happened to land next. The gate only fires when BOTH branches are known
 * (commit branch from `%S`, segment branch from its entries' modal `gitBranch`);
 * when either is unknown it does not constrain (mirrors the undefined-inherit
 * rule in segmentation).
 */
function attributeMedium(
	anchorlessSegments: ReadonlyArray<{ entries: RawEntry[] }>,
	index: CommitTargetIndex,
	targets: ReadonlyArray<string>,
	covered: ReadonlySet<string>,
	into: Map<string, RawEntry[]>,
): void {
	const uncovered = targets.filter((t) => !covered.has(t) && index.commitMeta.has(t));
	for (const seg of anchorlessSegments) {
		const times = seg.entries.map((e) => e.tsMs).filter((t) => !Number.isNaN(t));
		if (times.length === 0) continue;
		// reduce (not Math.max(...spread)) — a session segment can hold tens of
		// thousands of entries, and spreading that many args overflows the call stack.
		const segEnd = times.reduce((m, t) => (t > m ? t : m), Number.NEGATIVE_INFINITY);
		const segBranch = modalBranch(seg.entries);
		const cands = uncovered.filter((t) => {
			const meta = index.commitMeta.get(t);
			const ts = meta?.ts ?? Number.NaN;
			if (ts < segEnd || ts - segEnd > SEGMENT_GAP_MS) return false;
			// Branch gate: reject only when both branches are known and differ.
			if (meta?.branch && segBranch && meta.branch !== segBranch) return false;
			return true;
		});
		if (cands.length === 1) {
			for (const e of seg.entries) collect(into, cands[0], e);
		}
	}
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
 * Attributes transcript slices to the given target commits.
 *
 * @param targets   commit hashes (lacking summaries) to attribute
 * @param bySession scanner output (sessionId → time-ordered RawEntry[])
 * @param index     real-commit target index
 * @param opts.includeMedium  also emit time-window (MEDIUM) attributions
 */
export function attributeCommits(
	targets: ReadonlyArray<string>,
	bySession: ReadonlyMap<string, RawEntry[]>,
	index: CommitTargetIndex,
	opts: { includeMedium?: boolean } = {},
): AttributionResult {
	const targetSet = new Set(targets);
	const highEntries = new Map<string, RawEntry[]>();
	const anchorlessSegments: { entries: RawEntry[] }[] = [];

	for (const entries of bySession.values()) {
		attributeSessionHigh(entries, index, targetSet, highEntries, anchorlessSegments);
	}

	const medEntries = new Map<string, RawEntry[]>();
	if (opts.includeMedium) {
		attributeMedium(anchorlessSegments, index, targets, new Set(highEntries.keys()), medEntries);
	}

	const attributed = new Map<string, AttributedCommit>();
	const skipped: string[] = [];
	for (const hash of targets) {
		const high = highEntries.get(hash);
		const med = high ? undefined : medEntries.get(hash);
		const entries = high ?? med;
		const confidence: "high" | "medium" = high ? "high" : "medium";
		const method: "file-overlap" | "time-window" = high ? "file-overlap" : "time-window";
		if (!entries || entries.length === 0) {
			skipped.push(hash);
			continue;
		}
		const sessions = buildSessions(entries);
		if (sessions.length === 0) {
			// All attributed entries were non-conversational (pure tool calls) — no
			// text to summarize, so there is nothing useful to generate.
			skipped.push(hash);
			continue;
		}
		const conversationTurns = sessions.reduce(
			(sum, s) => sum + s.entries.filter((e) => e.role === "human").length,
			0,
		);
		const transcriptEntries = sessions.reduce((sum, s) => sum + s.entries.length, 0);
		attributed.set(hash, {
			commitHash: hash,
			confidence,
			method,
			branch: modalBranch(entries),
			sessions,
			transcriptEntries,
			conversationTurns,
		});
	}

	log.info("Attribution: %d high/med, %d skipped (of %d targets)", attributed.size, skipped.length, targets.length);
	return { attributed, skipped };
}

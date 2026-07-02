/**
 * CommitAttributor — maps on-disk Claude transcript slices to historical commits.
 *
 * Isolated from the live cursor/queue flow. Operates on the offline indexes built
 * by {@link RawTranscriptScanner} and {@link CommitTargetIndex}.
 *
 * Model (v6 — "effective worktree + time window + cursor slicing", which replaced
 * the earlier HIGH-only / opt-in-MEDIUM model). Per target commit C:
 *   - Window = (L, T]  where T = C's author time (② upper bound: a commit's
 *     conversation can only precede the commit) and L = the previous time any of
 *     C's files was committed (① commit-boundary lower bound, capped to a max
 *     lookback so a long-dormant file doesn't open a huge window).
 *   - Anchor = an in-window entry that edited one of C's files. The set of
 *     worktrees (cwd, normalized to a repo worktree root) that hold C's anchors is
 *     C's **effective worktree** `effWt`; the modal `gitBranch` of the anchors is
 *     C's **effective branch** `effBranch`. A commit with no anchor is not
 *     attributed (→ engine diff-only).
 *   - Cursor: within one worktree, target commits are ordered by author time and
 *     an in-window entry is owned by the *earliest* commit at/after it — so a long
 *     session spanning two commits is sliced into contiguous per-commit blocks and
 *     an already-summarized / out-of-range neighbor truncates the window.
 *   - Tiers of the collected in-window turns (within effWt + owning cursor):
 *       HIGH   (file-overlap)  — the turn's segment contains an anchor;
 *       MEDIUM (branch-match)  — the turn is on `effBranch`;
 *       LOW    (time-window)   — pure window (catches "planning on main").
 *     `minTier` drops turns below the threshold. The commit-level confidence is
 *     the *weakest* tier actually kept (so a badge never overclaims).
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

/** Confidence tiers, weakest → strongest. */
export type ConfidenceTier = "low" | "medium" | "high";
const TIER_RANK: Record<ConfidenceTier, number> = { low: 0, medium: 1, high: 2 };
const TIER_METHOD: Record<ConfidenceTier, AttributedCommit["method"]> = {
	high: "file-overlap",
	medium: "branch-match",
	low: "time-window",
};

export interface AttributedCommit {
	readonly commitHash: string;
	readonly confidence: ConfidenceTier;
	readonly method: "file-overlap" | "branch-match" | "time-window";
	readonly branch: string;
	readonly sessions: ReadonlyArray<SessionTranscript>;
	readonly transcriptEntries: number;
	readonly conversationTurns: number;
}

export interface AttributionResult {
	/** Target commits that earned a confident attribution. */
	readonly attributed: ReadonlyMap<string, AttributedCommit>;
	/** `emitOnly` commits with no confident attribution (engine → diff-only). */
	readonly skipped: ReadonlyArray<string>;
}

export interface AttributeOptions {
	/** Lowest tier to emit (default "high"). "low" = window-collect-all. */
	readonly minTier?: ConfidenceTier;
	/** Only produce attributions for these hashes. Others in `candidates` act as
	 *  cursor boundaries only. Default: every candidate is emitted. */
	readonly emitOnly?: ReadonlySet<string>;
	/** Repo worktree roots; each entry's `cwd` is normalized to its longest-matching
	 *  root as its worktree identity (NOT the transcript dir — subdir launches would
	 *  split one worktree into several). Default: cwd is its own identity. */
	readonly worktreeRoots?: ReadonlyArray<string>;
}

interface Segment {
	readonly start: number;
	readonly end: number; // exclusive
}

interface PreparedSession {
	readonly entries: ReadonlyArray<RawEntry>;
	readonly segs: ReadonlyArray<Segment>;
	/** worktreeKey per entry (parallel to `entries`). */
	readonly wkeys: ReadonlyArray<string>;
}

interface CommitCtx {
	readonly hash: string;
	readonly lo: number;
	readonly hi: number;
	readonly relSet: ReadonlySet<string>;
	readonly baseSet: ReadonlySet<string>;
	readonly effWt: Set<string>;
	effBranch: string;
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

/**
 * Resolves the worktree identity of a transcript entry's `cwd`: the longest
 * normalized worktree root that `cwd` equals or is nested under. Falls back to the
 * normalized `cwd` itself when it matches no root (isolated repo / test), or ""
 * when `cwd` is absent. Longest-match handles nested roots / submodules.
 */
function resolveWorktreeKey(cwd: string | undefined, normRoots: ReadonlyArray<string>): string {
	if (!cwd) return "";
	const c = normalizePathForCompare(cwd);
	let best = "";
	for (const r of normRoots) {
		if ((c === r || c.startsWith(`${r}/`)) && r.length > best.length) best = r;
	}
	return best || c;
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
 * Attributes transcript slices to the given target commits (v6 model).
 *
 * @param candidates  every candidate commit hash — used to build cursor
 *   boundaries (⊇ `emitOnly`; already-summarized / out-of-range neighbors matter).
 * @param bySession   scanner output (sessionId → time-ordered RawEntry[]).
 * @param index       real-commit target index.
 * @param opts        see {@link AttributeOptions}.
 */
export function attributeCommits(
	candidates: ReadonlyArray<string>,
	bySession: ReadonlyMap<string, RawEntry[]>,
	index: CommitTargetIndex,
	opts: AttributeOptions = {},
): AttributionResult {
	// Default "low" (window-collect-all) — the same unified tier every product entry
	// point uses; the per-commit confidence rollup still labels weaker turns honestly.
	const minTier: ConfidenceTier = opts.minTier ?? "low";
	const emitOnly = opts.emitOnly ?? new Set(candidates);
	const normRoots = (opts.worktreeRoots ?? []).map((r) => normalizePathForCompare(r));

	// Pre-segment every session once and resolve each entry's worktree identity.
	const sessions: PreparedSession[] = [];
	for (const entries of bySession.values()) {
		sessions.push({
			entries,
			segs: segmentSession(entries),
			wkeys: entries.map((e) => resolveWorktreeKey(e.cwd, normRoots)),
		});
	}

	// Per-candidate window + file signature (only commits that are real code targets).
	const ctxByHash = new Map<string, CommitCtx>();
	for (const hash of candidates) {
		const meta = index.commitMeta.get(hash);
		const files = index.commitFiles.get(hash);
		if (!meta || !files || files.length === 0) continue;
		const hi = meta.ts; // ② commit-time upper bound
		const lo = attributionLowerBound(index, hash, hi, WINDOW_CAP_MS); // ① commit-boundary lower bound
		ctxByHash.set(hash, {
			hash,
			lo,
			hi,
			relSet: new Set(files.map(normalizePathForCompare)),
			baseSet: new Set(files.map((f) => normalizePathForCompare(basename(f)))),
			effWt: new Set<string>(),
			effBranch: "",
		});
	}

	// Phase 1 — derive effective worktree + branch for EVERY candidate (anchors =
	// in-window file edits). `effBranch` is the modal branch of the anchor turns,
	// NOT the whole window (main chatter must not out-vote the real feature work).
	for (const ctx of ctxByHash.values()) {
		const anchors: RawEntry[] = [];
		for (const s of sessions) {
			for (let i = 0; i < s.entries.length; i++) {
				const e = s.entries[i];
				if (inWindow(e, ctx.lo, ctx.hi) && touchesFiles(e, ctx.relSet, ctx.baseSet)) {
					anchors.push(e);
					ctx.effWt.add(s.wkeys[i]);
				}
			}
		}
		if (ctx.effWt.size === 0) continue;
		let eb = modalBranch(anchors);
		if (!eb) {
			// Anchors carried no branch — fall back to the modal branch across the
			// whole in-window slice within the effective worktree.
			const inWt: RawEntry[] = [];
			for (const s of sessions) {
				for (let i = 0; i < s.entries.length; i++) {
					if (ctx.effWt.has(s.wkeys[i]) && inWindow(s.entries[i], ctx.lo, ctx.hi)) inWt.push(s.entries[i]);
				}
			}
			eb = modalBranch(inWt);
		}
		ctx.effBranch = eb;
	}

	// Phase 2 — cursor: order each worktree's candidate commits by author time; an
	// entry is owned by the earliest commit at/after it (contiguous slicing).
	const wt2commits = new Map<string, { hash: string; ts: number }[]>();
	for (const ctx of ctxByHash.values()) {
		for (const wt of ctx.effWt) {
			const rec = { hash: ctx.hash, ts: ctx.hi };
			const list = wt2commits.get(wt);
			if (list) list.push(rec);
			else wt2commits.set(wt, [rec]);
		}
	}
	for (const list of wt2commits.values()) list.sort((a, b) => a.ts - b.ts);
	// The owner is the earliest commit at/after `tms`. Callers only pass a `wt` that
	// is in some commit's effWt (so `list` is present) and an in-window entry (so the
	// owning commit C, with ts = C.hi >= tms, is in `list`) — the guards below are
	// unreachable defensive fall-throughs, hence the coverage ignores.
	const cursorOwner = (wt: string, tms: number): string => {
		const list = wt2commits.get(wt);
		/* v8 ignore next -- list always present: caller filters on effWt membership */
		if (!list) return "";
		for (const rec of list) if (rec.ts >= tms) return rec.hash;
		/* v8 ignore next -- unreachable: the owning commit C has ts = C.hi >= tms */
		return "";
	};

	// Phase 3 — collect + tier for each emitted commit.
	const attributed = new Map<string, AttributedCommit>();
	const skipped: string[] = [];

	for (const hash of candidates) {
		if (!emitOnly.has(hash)) continue;
		const ctx = ctxByHash.get(hash);
		if (!ctx || ctx.effWt.size === 0) {
			skipped.push(hash); // no anchor / not a code commit → engine diff-only
			continue;
		}

		const collected: RawEntry[] = [];
		let sawMed = false;
		let sawLow = false;

		for (const s of sessions) {
			for (const seg of s.segs) {
				// HIGH applies to a turn whose segment holds a file edit that THIS commit
				// actually owns — an anchor that is in-window, touches C's files, and whose
				// worktree slice the cursor assigns to C. Scope it per worktree key: a turn
				// is HIGH only if its own worktree has such an anchor in this segment (so a
				// neighbor-owned edit, or an edit in a different worktree the segment spans,
				// never inflates it).
				const anchorWks = new Set<string>();
				for (let i = seg.start; i < seg.end; i++) {
					const e = s.entries[i];
					const wk = s.wkeys[i];
					if (
						ctx.effWt.has(wk) &&
						inWindow(e, ctx.lo, ctx.hi) &&
						touchesFiles(e, ctx.relSet, ctx.baseSet) &&
						cursorOwner(wk, e.tsMs) === hash
					) {
						anchorWks.add(wk);
					}
				}
				for (let i = seg.start; i < seg.end; i++) {
					const e = s.entries[i];
					const wk = s.wkeys[i];
					if (!ctx.effWt.has(wk)) continue;
					if (!inWindow(e, ctx.lo, ctx.hi)) continue;
					if (cursorOwner(wk, e.tsMs) !== hash) continue; // owned by a neighbor commit
					const tier: ConfidenceTier = anchorWks.has(wk)
						? "high"
						: e.gitBranch && ctx.effBranch && e.gitBranch === ctx.effBranch
							? "medium"
							: "low";
					if (TIER_RANK[tier] < TIER_RANK[minTier]) continue;
					collected.push(e);
					// Roll up confidence over CONVERSATIONAL turns only (pure tool calls
					// are dropped by buildSessions and must not inflate the tier). HIGH is
					// the implicit default when neither weaker tier appears.
					if (e.role && e.content) {
						if (tier === "medium") sawMed = true;
						else if (tier === "low") sawLow = true;
					}
				}
			}
		}

		if (collected.length === 0) {
			skipped.push(hash);
			continue;
		}
		const sessionsOut = buildSessions(collected);
		if (sessionsOut.length === 0) {
			skipped.push(hash); // collected entries were all non-conversational tool calls
			continue;
		}
		// Weakest tier actually kept → honest commit-level confidence.
		const tier: ConfidenceTier = sawLow ? "low" : sawMed ? "medium" : "high";
		const conversationTurns = sessionsOut.reduce(
			(sum, s) => sum + s.entries.filter((e) => e.role === "human").length,
			0,
		);
		const transcriptEntries = sessionsOut.reduce((sum, s) => sum + s.entries.length, 0);
		attributed.set(hash, {
			commitHash: hash,
			confidence: tier,
			method: TIER_METHOD[tier],
			branch: ctx.effBranch,
			sessions: sessionsOut,
			transcriptEntries,
			conversationTurns,
		});
	}

	log.info("Attribution: %d attributed, %d skipped (of %d emitted)", attributed.size, skipped.length, emitOnly.size);
	return { attributed, skipped };
}

/**
 * Repair for summaries written with `transcripts: []`.
 *
 * Deliberately conservative (spec §8.3): every uncertainty resolves to "do not
 * repair". A false negative leaves a memory looking exactly as it does today; a
 * false positive staples someone else's conversation onto a commit, which is
 * worse than the gap it would be papering over.
 */

import { existsSync } from "node:fs";
import { createLogger, errMsg } from "../Logger.js";
import type { CommitSummary, StoredSession, TranscriptEntry, TranscriptReadResult } from "../Types.js";
import { claudeSessionsOwnedBy } from "./ClaudeOwnership.js";
import { resolveStateRoot } from "./GitOps.js";
import { resolveArchivedTitle } from "./SessionTitleResolver.js";
import type { StorageProvider } from "./StorageProvider.js";
import { getDisplayDate } from "./SummaryFormat.js";
import { getSummary, readTranscriptsBatch, storeSummary } from "./SummaryStore.js";
import { getTranscriptIds } from "./SummaryTree.js";
import { generateTranscriptId } from "./TranscriptId.js";
import { getParserForSource } from "./TranscriptParser.js";
import { readTranscript } from "./TranscriptReader.js";

const log = createLogger("TranscriptRepair");

/**
 * What the memory-detail UI is allowed to claim about a summary's conversations:
 *
 * - `present`      — captured live; render the conversations.
 * - `repaired`     — refilled from local transcript history after the fact.
 * - `repairable`   — empty, but the evidence to rebuild it is still on this machine.
 * - `unrepairable` — empty, and nothing local can fix it.
 *
 * The last two are the distinction spec §9 exists for: "No conversations linked
 * yet" reads as "not yet", which is misleading for a capture that already failed
 * and will never complete on its own.
 */
export type TranscriptRepairState = "present" | "repaired" | "repairable" | "unrepairable";

/**
 * True when `summary` is an empty, not-yet-repaired memory — the set a
 * `doctor --repair-transcripts` run and the UI's per-memory state both operate
 * over. Shared so the runner and the display cannot disagree about scope.
 */
export function isTranscriptRepairCandidate(summary: CommitSummary): boolean {
	return summary.transcriptsRepairedAt === undefined && getTranscriptIds(summary).length === 0;
}

/**
 * The ONE canonical processing order for a multi-memory repair: oldest upper
 * bound first, compared NUMERICALLY (epoch ms). ISO timestamps do not order
 * lexicographically across formats (git `%aI` offset form vs Claude's `Z`), and
 * the dedup floor is numeric, so a string sort could sequence a
 * later-chronological memory as an earlier one's floor and drop its turns. A
 * candidate whose bound is missing or unparseable sorts LAST (folded to
 * `+Infinity` here). Only an EMPTY bound is then skipped with `no-upper-bound`:
 * `planRepair` refuses on `!before`, so a truthy-but-unparseable string still
 * proceeds (its NaN cutoff reads to EOF) — unreachable in practice, since bounds
 * come from git `%aI` and `toISOString()`, but do not read "sorts last" as "is
 * skipped". Both the CLI runner and {@link transcriptRepairState}'s floor replay
 * walk this order, so they cannot drift — but only because the sort is a TOTAL
 * order: `commitHash` breaks a bound tie. `getDisplayDate` falls back to git
 * `%aI`, which is second-resolution, so two empty memories committed in the same
 * second share a bound; without the tie-break the two callers (the runner
 * concatenates `[...candidates, ...repairedSiblings]`, the floor replay filters
 * the sibling list in place) feed differently-ordered inputs, and JS's stable
 * sort would then sequence the tie oppositely on each path — the exact run/UI
 * drift this shared helper exists to close. The hash compare is `<`/`>`, NOT
 * `localeCompare`: a locale-sensitive compare would re-open the drift ACROSS
 * machines (its result depends on the process locale), which is strictly worse.
 * The bound is decorated once per memory rather than re-parsed inside the
 * comparator (O(N) parses instead of O(N·log N)); this runs per empty-candidate
 * detail open on the dashboard.
 */
export function orderTranscriptRepairCandidates(candidates: readonly CommitSummary[]): CommitSummary[] {
	const boundMsOf = (s: CommitSummary): number => {
		const iso = getDisplayDate(s);
		const t = iso ? new Date(iso).getTime() : Number.NaN;
		return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
	};
	return candidates
		.map((summary) => ({ summary, ms: boundMsOf(summary) }))
		.sort((a, b) => {
			if (a.ms !== b.ms) return a.ms - b.ms;
			// Locale-independent total order on the (hex) commit hash, so the tie
			// resolves identically on every path and every machine.
			if (a.summary.commitHash < b.summary.commitHash) return -1;
			if (a.summary.commitHash > b.summary.commitHash) return 1;
			return 0;
		})
		.map((decorated) => decorated.summary);
}

/** The newest entry timestamp (epoch ms) in a session slice, or `undefined` when
 *  every entry is missing/unparseable. Shared by the floor computed from a stored
 *  transcript and the one a fresh repair reports, so the two are the same number. */
function maxEntryTimestamp(entries: ReadonlyArray<TranscriptEntry>): number | undefined {
	let max = Number.NEGATIVE_INFINITY;
	for (const e of entries) {
		if (e.timestamp === undefined) continue;
		const ms = new Date(e.timestamp).getTime();
		if (!Number.isNaN(ms) && ms > max) max = ms;
	}
	return max > Number.NEGATIVE_INFINITY ? max : undefined;
}

/**
 * Advances a per-session dedup floor (sessionId → epoch ms) IN PLACE, keeping the
 * LATER instant per session. This is the shape of the whole cross-memory dedup:
 * each session dedups against only what earlier memories archived FROM THAT
 * SESSION, never a single worktree-wide bound — which is what let a repaired
 * memory suppress a session it never touched.
 */
export function mergeSessionFloor(floor: Map<string, number>, incoming: ReadonlyMap<string, number>): void {
	for (const [sessionId, ms] of incoming) {
		const prev = floor.get(sessionId);
		if (prev === undefined || ms > prev) floor.set(sessionId, ms);
	}
}

/**
 * The per-session dedup floor an ALREADY-REPAIRED summary contributes, derived
 * from what it PROVABLY archived — the newest entry timestamp per session in its
 * STORED transcripts — not from its bound. Using the bound was the P1 data-loss
 * bug: a session whose ownership edge appeared AFTER this memory was repaired was
 * never in its window, yet a bound floor suppressed that session's earlier turns
 * in every later memory, archiving them nowhere.
 *
 * `readable` is false when none of the transcript artifacts could be read
 * (pruned, absent, or unparseable). The caller then contributes NOTHING from
 * this sibling to the floor (§8.3's "prefer a gap" does NOT apply here): an
 * unreadable stored transcript is invisible to the user, so its turns are not a
 * duplicate the user could ever see twice — suppressing a later memory's copy of
 * them by this sibling's bound would hide them from BOTH places, which is the P1
 * data-loss shape one step along, not a conservative default.
 *
 * `storage` is threaded explicitly because the dashboard serves every registered
 * repo from ONE machine-global process: {@link readTranscriptsBatch} resolves an
 * absent argument through the process-global active storage, which — after a
 * guided-front-door run set it to the launching repo — is the WRONG repository
 * for every detail row but one, and would read every sibling's transcript back as
 * unreadable. The caller passes storage built from the memory's own worktree root.
 */
export async function archivedSessionFloor(
	summary: CommitSummary,
	cwd: string,
	storage?: StorageProvider,
): Promise<{ readable: boolean; bySession: Map<string, number> }> {
	const bySession = new Map<string, number>();
	const ids = getTranscriptIds(summary);
	if (ids.length === 0) return { readable: false, bySession };
	const transcripts = await readTranscriptsBatch(ids, cwd, storage);
	let readable = false;
	for (const transcript of transcripts.values()) {
		if (!transcript) continue;
		readable = true;
		for (const session of transcript.sessions) {
			const max = maxEntryTimestamp(session.entries);
			if (max === undefined) continue;
			const prev = bySession.get(session.sessionId);
			if (prev === undefined || max > prev) bySession.set(session.sessionId, max);
		}
	}
	return { readable, bySession };
}

export interface TranscriptRepairStateOptions {
	readonly globalDir?: string;
	/**
	 * The repo's empty-or-repaired memories, as a LAZY provider (the target may be
	 * among them). Supplied by the caller because only it knows the storage-correct
	 * source — the CLI/VS Code list local storage, the dashboard reads its own DB
	 * (its process must NOT touch the post-cutover frozen orphan branch). When
	 * present, the state reflects the dedup floor a real `doctor
	 * --repair-transcripts` run would hand this memory, so the UI's "repairable"
	 * cannot claim a memory the batch run would dedup to empty. Absent = the
	 * single-memory verdict (no dedup), correct for a lone repair.
	 *
	 * It is a THUNK, not a resolved array, for two reasons that are one decision.
	 * (1) Cost: computing it is O(all memories) — the CLI/VS Code list every
	 * summary from storage (a `git show` per memory pre-cutover), the dashboard
	 * runs a repo-wide query — and {@link transcriptRepairState} short-circuits
	 * for the present/repaired majority BEFORE it needs any of this, so an eager
	 * array made every memory-detail open pay a full enumeration the verdict then
	 * threw away. The thunk is invoked only past that short-circuit, i.e. only for
	 * an actual repair candidate (rare). (2) Scope: the set must be empty-AND-
	 * already-repaired memories, not just the empties — see {@link dedupFloorForTarget}
	 * for why a repaired sibling still bounds the floor. Callers pass the raw list;
	 * the engine filters, so the "which siblings count" rule stays in one place.
	 */
	readonly siblingSummaries?: () => Promise<readonly CommitSummary[]>;
	/**
	 * Storage to read the siblings' stored transcripts from, threaded through to
	 * {@link archivedSessionFloor}. Supply it whenever `cwd` may not match the
	 * process-global active storage — the machine-global dashboard is the case
	 * that forces it (see `archivedSessionFloor`). Absent = the active storage,
	 * correct for a single-repo CLI/VS Code process whose override already names
	 * this `cwd`.
	 *
	 * A LAZY provider, like {@link siblingSummaries}: it is resolved only past the
	 * present/repaired short-circuit, so the present/repaired majority never pays
	 * to build (and open) storage they will not read.
	 */
	readonly storage?: () => Promise<StorageProvider>;
}

export async function transcriptRepairState(
	summary: CommitSummary,
	cwd: string,
	opts: TranscriptRepairStateOptions = {},
): Promise<TranscriptRepairState> {
	if (summary.transcriptsRepairedAt !== undefined) return "repaired";
	if (getTranscriptIds(summary).length > 0) return "present";
	// Ask the repair engine itself, dry-run: "repairable" must mean exactly
	// "a real run would repair this", or the UI promises a repair the engine
	// then refuses. A looser predicate here (any owned transcript file exists)
	// over-promises the two cases the engine still rejects — no upper bound to
	// bound the window, or an owner window that holds no turns — which is the
	// optimism spec §9's repairable/unrepairable split exists to remove. One
	// code path with `repairSummaryTranscripts`, so the sentence and the
	// behaviour cannot drift apart.
	//
	// The ONLY repair path a user can trigger is the multi-memory batch run,
	// which threads a dedup floor: without replaying that floor here, this
	// dry run sees the memory's full window and can report "repairable" for a
	// memory the batch dedups to empty (its shared turns belong to an earlier
	// memory). So when the caller supplies the repo's empty siblings, compute
	// the same floor the batch would hand this memory and bound the dry run by it.
	// The thunk runs only here — past the present/repaired short-circuit above —
	// so the O(all memories) sibling enumeration is paid only for an actual
	// candidate, never for the present/repaired majority whose verdict never needs it.
	const floor = opts.siblingSummaries
		? await dedupFloorForTarget(
				summary,
				await opts.siblingSummaries(),
				cwd,
				opts.globalDir,
				opts.storage ? await opts.storage() : undefined,
			)
		: undefined;
	const outcome = await planRepair(summary, cwd, {
		apply: false,
		globalDir: opts.globalDir,
		afterExclusiveBySession: floor?.afterExclusiveBySession,
	});
	return outcome.repaired ? "repairable" : "unrepairable";
}

/** The dedup floor a repair run hands a memory: a PER-SESSION exclusive bound
 *  (`afterExclusiveBySession`, epoch ms per sessionId). A repaired sibling whose
 *  stored transcript cannot be read contributes nothing (see
 *  {@link archivedSessionFloor}), so there is no worktree-wide fallback here. */
export interface DedupFloor {
	readonly afterExclusiveBySession: ReadonlyMap<string, number>;
}

/**
 * The dedup floor a full `doctor --repair-transcripts` run would hand `target`.
 * Replays the run's prefix through the ONE shared ordering
 * ({@link orderTranscriptRepairCandidates}) and the same floor-advance rule the
 * CLI runner uses, so the per-memory UI state matches the batch outcome. Only
 * predecessors are simulated, so the cost scales with how many empty-or-repaired
 * memories are bounded earlier than the target — a rare capture failure, so
 * typically zero.
 *
 * The floor is PER SESSION, not one worktree-wide bound (the P1 fix): each
 * session dedups against only what earlier memories archived from THAT session.
 * Two kinds of predecessor advance it, and BOTH must — the cross-run half of
 * "no turn is archived to two memories":
 *   - a not-yet-repaired CANDIDATE, if a dry run says it would repair: it merges
 *     the per-session floor that run reports ({@link RepairOutcome.archivedBySession}); and
 *   - an ALREADY-REPAIRED sibling (`transcriptsRepairedAt` set), whose window was
 *     archived from `firstSeenLine` in a PRIOR run. Filtering to candidates alone
 *     (an earlier bug) dropped it, so a later empty memory repaired in a SECOND
 *     run re-archived every turn it already holds. It needs no dry run — its floor
 *     is read from what it PROVABLY archived ({@link archivedSessionFloor}), which
 *     is what stops it suppressing a session it never touched. When its transcript
 *     is unreadable it contributes NOTHING (see `archivedSessionFloor`) — an
 *     invisible copy is not a duplicate worth a gap.
 *
 * A PRESENT (live-captured) memory is deliberately NOT folded in: its turns were
 * read incrementally (cursor-trimmed), not from `firstSeenLine`, so its window
 * does not nest inside a candidate's and its bound is not a valid floor. That
 * broader live/repair overlap is out of scope here (see the runner's note).
 */
async function dedupFloorForTarget(
	target: CommitSummary,
	siblings: readonly CommitSummary[],
	cwd: string,
	globalDir?: string,
	storage?: StorageProvider,
): Promise<DedupFloor> {
	const relevant = siblings.filter((s) => isTranscriptRepairCandidate(s) || s.transcriptsRepairedAt !== undefined);
	const ordered = orderTranscriptRepairCandidates(relevant);
	const afterExclusiveBySession = new Map<string, number>();
	// The floor is every sibling ordered BEFORE the target. Every caller supplies a
	// list that includes the target (listSummaries returns all; the dashboard
	// sibling query matches empty candidates), so this is a real precondition, not a
	// fallback. Make it explicit rather than trusting a `break` to fire: if a
	// tree/row inconsistency ever dropped the target from its own siblings, walking
	// the whole list would fold LATER-bounded siblings into the floor and
	// over-suppress the target's turns — data loss, the dangerous direction. When
	// the target is absent we fold NOTHING instead (no dedup floor), and log it.
	const targetIndex = ordered.findIndex((s) => s.commitHash === target.commitHash);
	if (targetIndex === -1) {
		log.debug("dedupFloorForTarget: target %s not among its siblings — folding no floor", target.commitHash);
	}
	const predecessors = targetIndex === -1 ? [] : ordered.slice(0, targetIndex);
	for (const sibling of predecessors) {
		// An already-repaired sibling archived its window in a prior run. Fold in
		// what it PROVABLY archived, per session; when its stored transcript cannot
		// be read, contribute nothing — an invisible copy is not a duplicate worth
		// suppressing a later memory's turns for (§8.3 does not apply, see
		// `archivedSessionFloor`). Identical to the CLI runner in
		// DoctorCommand.runRepairTranscripts — keep the two in lockstep via the
		// shared helpers, a divergent rule here silently re-opens the UI/run drift.
		if (sibling.transcriptsRepairedAt !== undefined) {
			const archived = await archivedSessionFloor(sibling, cwd, storage);
			if (archived.readable) mergeSessionFloor(afterExclusiveBySession, archived.bySession);
			continue;
		}
		const outcome = await planRepair(sibling, cwd, {
			apply: false,
			globalDir,
			afterExclusiveBySession,
		});
		// Advance only on a repair, and only for the sessions it actually archived.
		if (outcome.repaired && outcome.archivedBySession) {
			mergeSessionFloor(afterExclusiveBySession, outcome.archivedBySession);
		}
	}
	return { afterExclusiveBySession };
}

export interface RepairOutcome {
	readonly commitHash: string;
	/** True when a repair happened, or WOULD have happened under `apply: false`. */
	readonly repaired: boolean;
	readonly reason:
		| "repaired"
		| "already-present"
		| "no-owner-proof"
		| "transcript-missing"
		| "no-entries-in-window"
		| "no-upper-bound";
	readonly entries?: number;
	/**
	 * The newest entry timestamp (epoch ms) this repair archived, per sessionId —
	 * the per-session dedup floor a LATER memory must apply to each session. Set on
	 * dry runs too (there is one code path), so the UI replay and the batch run
	 * advance the floor identically. Present only when `repaired` is true.
	 */
	readonly archivedBySession?: ReadonlyMap<string, number>;
}

/**
 * Rebuilds one summary's transcript slice from local history (spec §8.2).
 *
 * Bounds, both mandatory:
 *   - LOWER — the owner edge's `firstSeenLine`, exactly as the live read path
 *     seeds a first read (Task 5). Never 0-by-default: a summary whose owner
 *     cannot be proven is refused outright, not silently read from the top of
 *     a transcript that may hold turns belonging to a DIFFERENT worktree that
 *     happened to share the same Claude session.
 *   - UPPER — `generatedAt` (the instant capture actually ran), falling back
 *     to `commitDate` only when absent. `generatedAt` is preferred because
 *     capture can run well after the commit (queued, retried, or backfilled
 *     later), so the commit's own timestamp can PRECEDE — and would then
 *     wrongly truncate — the turns that actually produced it.
 *
 * `apply: false` performs every step except the final write, so the outcome a
 * dry run reports is the outcome a real run would produce: there is exactly
 * one code path, so the two cannot drift apart.
 *
 * Refusal is the default (spec §8.3): a missing summary, an unbounded window,
 * no owner edge, a vanished transcript, or a bounded window with nothing in it
 * all return without touching storage. A false negative leaves today's memory
 * exactly as it is; a false positive would staple the wrong conversation onto
 * a commit, which is strictly worse than the gap it would be papering over.
 */
export async function repairSummaryTranscripts(
	commitHash: string,
	cwd: string,
	opts: RepairOptions = {},
): Promise<RepairOutcome> {
	const summary = await getSummary(commitHash, cwd);
	if (!summary) return { commitHash, repaired: false, reason: "no-owner-proof" };
	return planRepair(summary, cwd, opts);
}

interface RepairOptions {
	readonly apply?: boolean;
	readonly globalDir?: string;
	/**
	 * Exclusive lower time bound (ISO 8601) for DE-DUPLICATION across a multi-memory
	 * repair run. The per-owner lower bound stays `firstSeenLine` (unchanged), so a
	 * later commit's read window still NESTS inside an earlier one's; this drops the
	 * turns that window overlaps — those the caller already archived to an
	 * earlier-bounded commit in the same run — so no turn is written to two memories.
	 * A turn with no timestamp of its own is kept (it cannot be shown to be a
	 * duplicate), matching the reader's own conservative treatment. Absent = no
	 * dedup (the first memory in a run, and every single-memory caller).
	 *
	 * Worktree-WIDE: it drops matching turns from every owned session alike. It is
	 * a general single-bound affordance (and is exercised as one by the tests);
	 * production always prefers {@link afterExclusiveBySession}. In particular, do
	 * NOT wire it as the fallback bound for a repaired sibling whose stored
	 * transcript is unreadable — that path deliberately contributes NOTHING (see
	 * `archivedSessionFloor` / `dedupFloorForTarget`), because a worktree-wide
	 * bound guessed from an invisible copy would suppress a later memory's turns,
	 * the P1 data-loss shape this module is built to avoid.
	 */
	readonly afterExclusive?: string;
	/**
	 * PER-SESSION exclusive dedup floor (epoch ms, keyed by sessionId). The floor a
	 * multi-memory run carries: each session drops only turns an earlier memory
	 * archived FROM THAT SESSION, so a repaired memory can no longer suppress a
	 * session it never touched (the P1 data-loss fix). Combined with
	 * {@link afterExclusive} by taking the LATER of the two per owner. Absent = no
	 * per-session dedup.
	 */
	readonly afterExclusiveBySession?: ReadonlyMap<string, number>;
}

/**
 * The engine's decision on ONE already-fetched summary — the single code path
 * shared by {@link repairSummaryTranscripts} (which fetches then writes) and
 * {@link transcriptRepairState} (which asks dry-run whether a repair is
 * possible). Keeping both on this one function is what stops the UI's
 * "repairable" sentence from drifting away from what a real run does.
 */
async function planRepair(summary: CommitSummary, cwd: string, opts: RepairOptions): Promise<RepairOutcome> {
	const commitHash = summary.commitHash;
	if (summary.transcriptsRepairedAt !== undefined || getTranscriptIds(summary).length > 0) {
		return { commitHash, repaired: false, reason: "already-present" };
	}

	// `generatedAt || commitDate`, via the one helper every other display-date
	// consumer shares (SummaryFormat.getDisplayDate). Reusing it — rather than
	// re-spelling the precedence inline — is also what keeps this bound and the
	// dedup floor below on the SAME numeric comparison the reader uses, instead
	// of the lexicographic string compare a hand-rolled expression invited.
	const before = getDisplayDate(summary);
	if (!before) return { commitHash, repaired: false, reason: "no-upper-bound" };

	// Worktree-wide exclusive lower bound for cross-memory dedup, parsed to epoch
	// ms ONCE. ISO timestamps do NOT order lexicographically across formats (a git
	// `%aI` offset form `…+08:00` vs Claude's `…Z`, with/without millis), so a raw
	// string `>` silently dropped or duplicated turns whose format differed from
	// the bound — the exact loss dedup exists to prevent. An absent/empty/
	// unparseable bound means "no dedup" (NaN folds to undefined here), matching
	// the first-memory-in-a-run and single-memory callers.
	const parsedAfter = opts.afterExclusive ? new Date(opts.afterExclusive).getTime() : Number.NaN;
	const afterTime = Number.isNaN(parsedAfter) ? undefined : parsedAfter;

	const owned = await claudeSessionsOwnedBy(resolveStateRoot(cwd), opts.globalDir);
	if (owned.length === 0) return { commitHash, repaired: false, reason: "no-owner-proof" };
	const live = owned.filter((o) => existsSync(o.transcriptPath));
	if (live.length === 0) return { commitHash, repaired: false, reason: "transcript-missing" };

	const sessions: StoredSession[] = [];
	for (const owner of live) {
		let read: TranscriptReadResult;
		try {
			read = await readTranscript(
				owner.transcriptPath,
				{
					transcriptPath: owner.transcriptPath,
					lineNumber: owner.edge.firstSeenLine,
					updatedAt: owner.edge.firstSeenAt,
				},
				getParserForSource("claude"),
				before,
			);
		} catch (err) {
			log.debug("repair: cannot read %s: %s", owner.transcriptPath, errMsg(err));
			continue;
		}
		// Drop turns already archived to an earlier-bounded commit in this run (see
		// RepairOptions.afterExclusive / afterExclusiveBySession). The lower bound
		// above stays firstSeenLine; this only removes the overlap so no turn lands
		// on two memories. The effective floor is the LATER of the worktree-wide
		// bound and THIS session's own per-session floor — so a repaired sibling's
		// bound no longer suppresses a session it never archived. A turn with no
		// timestamp — or one that cannot be parsed — is KEPT: it cannot be shown to
		// be a duplicate, matching the reader's conservative treatment of unbounded
		// lines.
		const sessionFloor = opts.afterExclusiveBySession?.get(owner.sessionId);
		const floor =
			afterTime === undefined
				? sessionFloor
				: sessionFloor === undefined
					? afterTime
					: Math.max(afterTime, sessionFloor);
		const entries =
			floor === undefined
				? read.entries
				: read.entries.filter((e) => {
						if (e.timestamp === undefined) return true;
						const t = new Date(e.timestamp).getTime();
						return Number.isNaN(t) || t > floor;
					});
		if (entries.length === 0) continue;
		// Resolved here, not left off, per the archived-title contract every
		// other stored-session writer follows (BackfillEngine.toStoredTranscript
		// is the precedent for a writer outside QueueWorker's hot commit path):
		// the transcript file this reads from is machine-local and pruned on the
		// agent's own schedule, so a future reader re-deriving a title from
		// `transcriptPath` is the one thing this repair cannot promise to work.
		const title = await resolveArchivedTitle({
			sessionId: owner.sessionId,
			source: "claude",
			transcriptPath: owner.transcriptPath,
			entries,
		});
		sessions.push({
			sessionId: owner.sessionId,
			transcriptPath: owner.transcriptPath,
			source: "claude",
			entries,
			...(title ? { title } : {}),
		});
	}
	if (sessions.length === 0) return { commitHash, repaired: false, reason: "no-entries-in-window" };

	const entries = sessions.reduce((n, s) => n + s.entries.length, 0);
	// The per-session floor a LATER memory must apply: the newest instant this
	// repair archived FROM EACH session. Computed on the dry path too, so the UI
	// replay and the batch run advance the floor from the same numbers.
	const archivedBySession = new Map<string, number>();
	for (const session of sessions) {
		const max = maxEntryTimestamp(session.entries);
		if (max !== undefined) archivedBySession.set(session.sessionId, max);
	}
	if (opts.apply !== true) return { commitHash, repaired: true, reason: "repaired", entries, archivedBySession };

	const id = generateTranscriptId();
	await storeSummary({ ...summary, transcripts: [id], transcriptsRepairedAt: new Date().toISOString() }, cwd, true, {
		transcript: { id, data: { sessions } },
	});
	return { commitHash, repaired: true, reason: "repaired", entries, archivedBySession };
}

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
import type { CommitSummary, StoredSession, TranscriptReadResult } from "../Types.js";
import { claudeSessionsOwnedBy } from "./ClaudeOwnership.js";
import { resolveStateRoot } from "./GitOps.js";
import { resolveArchivedTitle } from "./SessionTitleResolver.js";
import { getSummary, storeSummary } from "./SummaryStore.js";
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

export async function transcriptRepairState(
	summary: CommitSummary,
	cwd: string,
	globalDir?: string,
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
	const outcome = await planRepair(summary, cwd, { apply: false, globalDir });
	return outcome.repaired ? "repairable" : "unrepairable";
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
	opts: { readonly apply?: boolean; readonly globalDir?: string } = {},
): Promise<RepairOutcome> {
	const summary = await getSummary(commitHash, cwd);
	if (!summary) return { commitHash, repaired: false, reason: "no-owner-proof" };
	return planRepair(summary, cwd, opts);
}

/**
 * The engine's decision on ONE already-fetched summary — the single code path
 * shared by {@link repairSummaryTranscripts} (which fetches then writes) and
 * {@link transcriptRepairState} (which asks dry-run whether a repair is
 * possible). Keeping both on this one function is what stops the UI's
 * "repairable" sentence from drifting away from what a real run does.
 */
async function planRepair(
	summary: CommitSummary,
	cwd: string,
	opts: { readonly apply?: boolean; readonly globalDir?: string },
): Promise<RepairOutcome> {
	const commitHash = summary.commitHash;
	if (summary.transcriptsRepairedAt !== undefined || getTranscriptIds(summary).length > 0) {
		return { commitHash, repaired: false, reason: "already-present" };
	}

	const before = summary.generatedAt || summary.commitDate;
	if (!before) return { commitHash, repaired: false, reason: "no-upper-bound" };

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
		if (read.entries.length === 0) continue;
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
			entries: read.entries,
		});
		sessions.push({
			sessionId: owner.sessionId,
			transcriptPath: owner.transcriptPath,
			source: "claude",
			entries: read.entries,
			...(title ? { title } : {}),
		});
	}
	if (sessions.length === 0) return { commitHash, repaired: false, reason: "no-entries-in-window" };

	const entries = sessions.reduce((n, s) => n + s.entries.length, 0);
	if (opts.apply !== true) return { commitHash, repaired: true, reason: "repaired", entries };

	const id = generateTranscriptId();
	await storeSummary({ ...summary, transcripts: [id], transcriptsRepairedAt: new Date().toISOString() }, cwd, true, {
		transcript: { id, data: { sessions } },
	});
	return { commitHash, repaired: true, reason: "repaired", entries };
}

/**
 * Per-conversation metadata for the pushed summary sidecar.
 *
 * A PUSH-TIME enrichment, never stored: the rows are derived from the transcript
 * artifacts a summary tree already references, so every memory already on disk
 * gains its time axis on its next push. Deliberately absent from
 * `CommitSummary` — see `EnrichedPushSummary` in `JolliMemoryPushOrchestrator.ts`
 * for the type boundary that keeps the storage path unable to name this field.
 *
 * Timestamps only, no conversation content, so the `BranchShareScope.transcripts
 * = false` contract is untouched.
 */

import { createLogger, errMsg } from "../Logger.js";
import type { CommitSummary, StoredSession, StoredTranscript, TranscriptEntry } from "../Types.js";
import type { StorageProvider } from "./StorageProvider.js";
import { readTranscriptsBatch } from "./SummaryStore.js";
import { resolveTranscriptIdsForUsage } from "./SummaryTree.js";

const log = createLogger("TranscriptSessionMeta");

/** Back-compat convention shared with the server: a source-less session is a Claude one. */
const DEFAULT_SOURCE = "claude";

/**
 * One conversation's bounds and size. `startedAt`/`endedAt` are omitted together
 * when the session carries no parseable timestamp — a journey of unknown length
 * must render as unmeasured, never as an instant one, so an epoch or an empty
 * string here would be worse than the gap.
 */
export interface TranscriptSessionMeta {
	readonly sessionId: string;
	readonly source: string;
	readonly messageCount: number;
	readonly startedAt?: string;
	readonly endedAt?: string;
}

/** Running total for one `<source>:<sessionId>` key. The `*Ms` fields never leave this module. */
interface SessionAccumulator {
	readonly sessionId: string;
	readonly source: string;
	messageCount: number;
	startedAt?: string;
	startedMs?: number;
	endedAt?: string;
	endedMs?: number;
}

/** The original string when it parses as a date, else undefined. Never coerced. */
function usableTimestamp(value: string | undefined): { readonly at: string; readonly ms: number } | undefined {
	if (!value) return undefined;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? undefined : { at: value, ms };
}

/**
 * Widens the accumulator's span to cover `entries`. Compares parsed epoch millis
 * rather than the ISO strings: two timestamps can be the same instant in
 * different offsets, where a lexicographic comparison picks the wrong one.
 */
function foldEntryTimes(acc: SessionAccumulator, entries: ReadonlyArray<TranscriptEntry>): void {
	for (const entry of entries) {
		const parsed = usableTimestamp(entry.timestamp);
		if (!parsed) continue;
		if (acc.startedMs === undefined || parsed.ms < acc.startedMs) {
			acc.startedAt = parsed.at;
			acc.startedMs = parsed.ms;
		}
		if (acc.endedMs === undefined || parsed.ms > acc.endedMs) {
			acc.endedAt = parsed.at;
			acc.endedMs = parsed.ms;
		}
	}
}

function toMeta(acc: SessionAccumulator): TranscriptSessionMeta {
	return {
		sessionId: acc.sessionId,
		source: acc.source,
		messageCount: acc.messageCount,
		...(acc.startedAt !== undefined && { startedAt: acc.startedAt }),
		...(acc.endedAt !== undefined && { endedAt: acc.endedAt }),
	};
}

/** Folds one archived session's slice into the running per-session map. */
function foldSession(byKey: Map<string, SessionAccumulator>, session: StoredSession): void {
	// A row with no id has no join key server-side, so it would be dropped there anyway.
	if (!session.sessionId) return;
	const source = session.source ?? DEFAULT_SOURCE;
	const key = `${source}:${session.sessionId}`;
	const acc = byKey.get(key) ?? { sessionId: session.sessionId, source, messageCount: 0 };
	// `readTranscript` casts JSON.parse output, so `entries` can be absent in older data.
	const entries = session.entries ?? [];
	acc.messageCount += entries.length;
	foldEntryTimes(acc, entries);
	byKey.set(key, acc);
}

/**
 * Derives the tree-wide per-session rows for one summary — the root's artifacts
 * and every child's, aggregated by `<source>:<sessionId>`.
 *
 * Aggregated rather than keep-first because one session legitimately spans
 * several artifacts (an amend delta plus its base): `messageCount` sums and the
 * bounds span min→max, matching the field's "across all of the session's
 * transcript slices" contract. The result is stamped on the ROOT only — the
 * server merges duplicate rows keep-first, so a copy on a squash child would
 * have it silently truncate both the count and the span.
 *
 * Returns `[]` when nothing is derivable; the caller omits the field entirely
 * rather than sending an empty array, which would read as a measurement of zero
 * conversations and disable the server's bare-transcript-id fallback.
 *
 * `storage` is injected rather than resolved so this stays off git — which is
 * also what keeps its tests in the fast tier.
 *
 * Reads every referenced artifact in ONE batch (`readTranscriptsBatch`)
 * instead of one `git show` subprocess per id: a squash root that re-lists
 * every descendant transcript can reference ~100 artifacts, and at ~22 ms per
 * subprocess that serial form eats most of the pre-push hook's 3 s inline
 * budget by itself. `readTranscriptsBatch` already degrades to a per-path
 * `readFile` loop when the backend has no batch primitive (FolderStorage), so
 * this stays correct there too.
 *
 * The whole body is guarded, not just the batch read: id resolution and the
 * fold loop can fail too (a malformed summary tree, a corrupt artifact), and
 * this is an optional extra — see the module docstring. Any failure degrades
 * to "no sessions derivable" rather than throwing, so a caller can always
 * `await` this without a try/catch of its own.
 */
export async function collectTranscriptSessionMeta(
	summary: CommitSummary,
	cwd?: string,
	storage?: StorageProvider,
): Promise<ReadonlyArray<TranscriptSessionMeta>> {
	try {
		const byKey = new Map<string, SessionAccumulator>();
		// De-duped, not just an optimisation: the pre-v5 fallback path can list one
		// id twice, which would double-count messageCount if folded twice.
		const ids = [...new Set(resolveTranscriptIdsForUsage(summary))];
		const transcripts: Map<string, StoredTranscript | null> = await readTranscriptsBatch(ids, cwd, storage);
		for (const id of ids) {
			const transcript = transcripts.get(id);
			if (!transcript) continue;
			for (const session of transcript.sessions ?? []) foldSession(byKey, session);
		}
		return [...byKey.values()].map(toMeta);
	} catch (err) {
		// A detached/pruned repo state, a malformed summary tree, or the batch
		// read itself erroring must not block the push — this degrades to "no
		// sessions derivable" rather than throwing.
		log.debug("Transcript session enrichment failed, skipping: %s", errMsg(err));
		return [];
	}
}

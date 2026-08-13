/**
 * SessionSignals — the registry of things the back-fill mines out of a
 * conversation, and the one function that runs them.
 *
 * Adding a signal is adding an entry here. Nothing in `DashboardCollector` or
 * `DbBackfill` names an extractor or an agent; they call {@link extractSessionSignals}
 * and merge what comes back. See {@link SessionSignalExtractor} for why the list
 * is split the way it is (per record shape, not per output column).
 */

import { createLogger, errMsg } from "../../Logger.js";
import type { ToolCallCount } from "../../Types.js";
import { mergeToolCalls, type SessionSignalExtractor, type SessionSignalInput } from "./SessionSignalExtractor.js";
import { skillExtractor } from "./SkillExtractor.js";
import { toolCallExtractor } from "./ToolCallExtractor.js";

const log = createLogger("SessionSignals");

/**
 * Every extractor, in the order their results are merged.
 *
 * Order does not affect the merge: {@link mergeToolCalls} folds on `(kind, name)`
 * and takes the LARGER `calls` count rather than adding them — two extractors
 * reporting one bucket are two views of one set of records, and summing them would
 * double every tool-entered skill call. So this is only the order the reads are
 * ISSUED in — and they share one memoised {@link SessionContent}, so the second
 * extractor's read is free.
 */
export const SESSION_SIGNAL_EXTRACTORS: ReadonlyArray<SessionSignalExtractor> = [toolCallExtractor, skillExtractor];

/** What one session's extractors found, already merged. */
export interface ExtractedSignals {
	/** Absent when no extractor could answer for this source — never `[]`. */
	readonly tools?: ReadonlyArray<ToolCallCount>;
}

/**
 * Runs every extractor that supports this session's source and merges the result.
 *
 * **One failing extractor must not cost the others their findings**, so each is
 * caught independently. That is not defensive padding: these read real files
 * belonging to other applications, which can be locked, half-written or removed
 * between the scan and this call. A source whose skill scan throws should still
 * contribute its tool calls.
 *
 * Absence is preserved through the merge. When no extractor supported the source,
 * or every one of them declined to answer, `tools` is omitted rather than set to
 * `[]` — the caller writes that distinction into the database, where `[]` reads as
 * "this agent called no tools" and absence reads as "this agent cannot report
 * them".
 *
 * Sequential rather than concurrent, deliberately: the extractors share one
 * memoised content object, so running them in parallel would race two reads of
 * the same transcript rather than reusing one. The outer fan-out over SESSIONS is
 * where the concurrency belongs, and it is already there.
 */
export async function extractSessionSignals(input: SessionSignalInput): Promise<ExtractedSignals> {
	const groups: ToolCallCount[][] = [];
	let answered = false;
	for (const extractor of SESSION_SIGNAL_EXTRACTORS) {
		if (!extractor.supports(input.source)) continue;
		try {
			const signals = await extractor.extract(input);
			if (signals.tools) {
				answered = true;
				groups.push([...signals.tools]);
			}
		} catch (err) {
			log.warn("%s extractor failed: %s", extractor.id, errMsg(err));
		}
	}
	return answered ? { tools: mergeToolCalls(groups) } : {};
}

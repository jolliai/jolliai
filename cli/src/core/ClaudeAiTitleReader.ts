/**
 * Read Claude Code's native session title from a transcript JSONL.
 *
 * Claude Code re-evaluates the session title continuously and appends a
 * new line of `{ type: "ai-title", aiTitle: "...", sessionId: "..." }`
 * every time. The last such line is the current title.
 *
 * Strategy: stream once, remember the most recent `aiTitle` — over the whole
 * file when it is small, over its last {@link TAIL_SCAN_BYTES} when it is not.
 * See {@link TAIL_SCAN_BYTES} for why the tail is the right slice and what it
 * gives up.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createLogger, errMsg, isEnoent } from "../Logger.js";

const log = createLogger("ClaudeAiTitleReader");

const AI_TITLE_FRAGMENT = '"type":"ai-title"';

/**
 * Above this size the scan starts here-many bytes from the end instead of at
 * byte 0.
 *
 * The read is on a request path — the dashboard resolves a memory's
 * conversation titles while building `/api/model`, which a browsing user
 * re-polls every 30 s — and a transcript that is being appended to right now
 * invalidates its own `(mtimeMs, size)` cache entry on every one of those ticks.
 * So the common case is not "scan a big file once", it is "re-scan the same
 * growing multi-MB file twice a minute for as long as the tab is open", which is
 * exactly the session a user browses right after committing.
 *
 * The tail is sound because of what the title IS: Claude re-emits `ai-title` as
 * the conversation continues, and only the LAST one is wanted — so the answer
 * lives at the end of the file, and everything before it is read to be thrown
 * away. What this gives up is the pathological case of a transcript that grew
 * past the budget with all of its `ai-title` lines before the cut; that session
 * falls back to the caller's own title source (the archived first user message)
 * rather than showing a wrong title. 4 MiB is far more than the span between two
 * consecutive re-titlings in any capture we have.
 */
export const TAIL_SCAN_BYTES = 4 * 1024 * 1024;

export async function readClaudeAiTitle(transcriptPath: string): Promise<string | undefined> {
	let latest: string | undefined;
	let parseSkipped = 0;
	// A failed stat falls through to a whole-file scan: it is the behaviour that
	// was always correct, and the size is an optimisation input, not a
	// precondition. `createReadStream` reports the real error a moment later.
	const size = await stat(transcriptPath).then(
		(s) => s.size,
		() => 0,
	);
	const start = size > TAIL_SCAN_BYTES ? size - TAIL_SCAN_BYTES : 0;
	try {
		const stream = createReadStream(transcriptPath, { encoding: "utf8", start });
		const rl = createInterface({ input: stream, crlfDelay: Infinity });
		try {
			// Byte `start` lands mid-line (and possibly mid-codepoint) in the general
			// case, so the first line of a tail read is a fragment: it cannot be
			// parsed and, worse, a fragment of a NON-title line can carry a title
			// line's fragment shape. Dropping it costs one line and is the only way
			// to keep every line this loop sees a whole one.
			let dropPartial = start > 0;
			for await (const line of rl) {
				if (dropPartial) {
					dropPartial = false;
					continue;
				}
				// Pre-filter: skip lines that can't possibly be ai-title rows.
				// The literal substring `"type":"ai-title"` (including the
				// trailing closing quote) is exactly what Claude Code writes,
				// and any line that passes this check also satisfies
				// `obj.type === "ai-title"` once parsed — so an explicit
				// `obj.type !== "ai-title"` check post-parse is redundant.
				if (!line.includes(AI_TITLE_FRAGMENT)) continue;
				try {
					const obj = JSON.parse(line) as { aiTitle?: unknown };
					if (typeof obj.aiTitle === "string" && obj.aiTitle.length > 0) {
						latest = obj.aiTitle;
					}
				} catch {
					// Skip malformed ai-title row but keep scanning so a
					// later valid row still produces a title. Aggregate count
					// logged at debug below — title resolution is cosmetic so
					// per-line warnings would be noise.
					parseSkipped++;
				}
			}
		} finally {
			rl.close();
			stream.destroy();
		}
	} catch (err) {
		if (!isEnoent(err)) {
			log.debug("readClaudeAiTitle stream failed for %s: %s", transcriptPath, errMsg(err));
		}
		return undefined;
	}
	if (parseSkipped > 0) {
		log.debug("readClaudeAiTitle skipped %d malformed ai-title line(s) for %s", parseSkipped, transcriptPath);
	}
	return latest;
}

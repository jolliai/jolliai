/**
 * Read Claude Code's native session title from a transcript JSONL.
 *
 * Claude Code re-evaluates the session title continuously and appends a
 * new line of `{ type: "ai-title", aiTitle: "...", sessionId: "..." }`
 * every time. The last such line is the current title.
 *
 * Strategy: forward stream once, remember the most recent `aiTitle`.
 * For multi-MB transcripts this remains acceptable in practice; if
 * profiling later shows it's a bottleneck, reverse-chunk reads are an
 * obvious optimization (out of scope for MVP).
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createLogger, errMsg, isEnoent } from "../Logger.js";

const log = createLogger("ClaudeAiTitleReader");

const AI_TITLE_FRAGMENT = '"type":"ai-title"';

export async function readClaudeAiTitle(transcriptPath: string): Promise<string | undefined> {
	let latest: string | undefined;
	let parseSkipped = 0;
	try {
		const stream = createReadStream(transcriptPath, { encoding: "utf8" });
		const rl = createInterface({ input: stream, crlfDelay: Infinity });
		try {
			for await (const line of rl) {
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

/**
 * Fallback title computation for sessions whose source has no native title.
 *
 * Reads the transcript via a caller-supplied `parseLine` hook so each source
 * can apply its own schema (Codex / Gemini / Copilot Chat have different
 * line shapes — we stream once and stop at the first user message).
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createLogger, errMsg, isEnoent } from "../Logger.js";

const log = createLogger("FallbackTitle");

export const UNTITLED_SESSION = "(untitled session)";
export const TITLE_MAX_CODE_POINTS = 60;

/**
 * Truncate a string to at most `maxCodePoints` Unicode code points.
 * Preserves surrogate pairs. Collapses internal whitespace and trims.
 */
export function truncateToCodePoints(input: string, maxCodePoints: number): string {
	const normalized = input.replace(/\s+/g, " ").trim();
	const codePoints = Array.from(normalized); // iterates by code point
	if (codePoints.length <= maxCodePoints) return normalized;
	return codePoints.slice(0, maxCodePoints).join("");
}

export interface ReadFirstUserMessageOptions {
	readonly transcriptPath: string;
	/** Returns the user message body, or undefined if this line is not a user message. */
	readonly parseLine: (line: string) => string | undefined;
}

/**
 * Stream the transcript line-by-line, returning the first user message body
 * truncated to TITLE_MAX_CODE_POINTS. Returns UNTITLED_SESSION on any failure
 * or absence (file missing, no user line, parse error).
 */
export async function readFirstUserMessageTitle(opts: ReadFirstUserMessageOptions): Promise<string> {
	try {
		const stream = createReadStream(opts.transcriptPath, { encoding: "utf8" });
		const rl = createInterface({ input: stream, crlfDelay: Infinity });
		try {
			for await (const line of rl) {
				if (!line) continue;
				let body: string | undefined;
				try {
					body = opts.parseLine(line);
				} catch {
					continue;
				}
				if (body !== undefined && body.trim().length > 0) {
					// body has at least one non-whitespace code point, and
					// truncateToCodePoints preserves up to TITLE_MAX_CODE_POINTS
					// of those — its output cannot be empty here.
					return truncateToCodePoints(body, TITLE_MAX_CODE_POINTS);
				}
			}
		} finally {
			rl.close();
			stream.destroy();
		}
		return UNTITLED_SESSION;
	} catch (err) {
		// File-not-found is a routine case (transcript was deleted /
		// rotated between discovery and this read). Anything else is a real
		// problem the operator should hear about: permission denied,
		// directory in place of file, transient IO failure.
		if (!isEnoent(err)) {
			log.debug("readFirstUserMessageTitle stream failed for %s: %s", opts.transcriptPath, errMsg(err));
		}
		return UNTITLED_SESSION;
	}
}

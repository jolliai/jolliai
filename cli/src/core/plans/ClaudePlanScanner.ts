/**
 * ClaudePlanScanner — reads a Claude Code transcript (JSONL) for plan signals.
 *
 * Two signal classes (verbatim from the original inline StopHook scan):
 *   1. Plan mode: a `"slug":"xxx"` field → canonical `~/.claude/plans/<slug>`.
 *   2. Write/Edit tool_use targeting a `.md` path → `~/.claude/plans/` paths key
 *      by slug; every other `.md` is collected as an UNFILTERED external path
 *      (the `isExternalPlanCandidate` policy now lives in the driver, so Codex
 *      shares it).
 *
 * `cwd` is unused for Claude (file_path is already absolute) — the parameter
 * exists only to satisfy the PlanTranscriptScanner interface.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { PlanScanResult, PlanTranscriptScanner } from "./PlanTranscriptScanner.js";

/** Regex to extract slug from plan-mode transcript lines: "slug":"xxx" */
const SLUG_REGEX = /"slug":"([^"]+)"/;

/** Regex to detect Write/Edit tool calls */
const WRITE_EDIT_REGEX = /"name":"(?:Write|Edit)"/;

/**
 * Regex to extract slug from file_path values targeting ~/.claude/plans/.
 * Uses [/\\]{1,2} to handle both raw paths (/) and JSON-escaped Windows paths (\\).
 */
const PLANS_PATH_SLUG_REGEX = /[/\\]{1,2}\.claude[/\\]{1,2}plans[/\\]{1,2}([^/\\.]+)\.md/;

/**
 * Fallback regex: matches any Write/Edit tool_use file_path ending in .md.
 * Runs only when PLANS_PATH_SLUG_REGEX misses, so ~/.claude/plans/ stays
 * handled by the original slug-keyed code path.
 */
const ANY_MD_PATH_REGEX = /"file_path":"([^"]+\.md)"/;

class ClaudePlanScanner implements PlanTranscriptScanner {
	scan(
		transcriptPath: string,
		fromLine: number,
		_cwd: string,
		toLine: number = Number.POSITIVE_INFINITY,
	): Promise<PlanScanResult> {
		return new Promise((resolve) => {
			const slugs = new Set<string>();
			const externalPlans = new Set<string>();
			let lineNumber = 0;

			const stream = createReadStream(transcriptPath, { encoding: "utf-8" });
			const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

			rl.on("line", (line) => {
				lineNumber++;
				if (lineNumber <= fromLine || lineNumber > toLine) {
					return;
				}

				// Detect plan-mode slug: "slug":"xxx"
				if (line.includes('"slug":"')) {
					const match = SLUG_REGEX.exec(line);
					if (match?.[1]) {
						slugs.add(match[1]);
					}
				}

				// Detect Write/Edit tool calls. First try the slug-keyed
				// ~/.claude/plans/ path; only fall back to the generic .md regex
				// when that misses, so existing behavior is preserved.
				if (line.includes('"type":"tool_use"') && WRITE_EDIT_REGEX.test(line)) {
					const pathMatch = PLANS_PATH_SLUG_REGEX.exec(line);
					if (pathMatch?.[1]) {
						slugs.add(pathMatch[1]);
					} else {
						const extMatch = ANY_MD_PATH_REGEX.exec(line);
						if (extMatch?.[1]) {
							// Transcripts are JSONL: the captured substring lives inside a JSON
							// string literal, so all of `\\`, `\"`, `\n`, `\uXXXX` etc. are
							// possible. Decode via JSON.parse to handle every escape uniformly
							// — a simple `replace(/\\\\/g, "\\")` misses unicode-escaped
							// non-ASCII filenames and any other valid JSON escape.
							let absPath: string | null = null;
							try {
								absPath = JSON.parse(`"${extMatch[1]}"`) as string;
							} catch {
								// Malformed escape sequence — treat as non-candidate.
							}
							// No isExternalPlanCandidate filter here: the driver applies the
							// shared exclusion policy so Codex inherits it too.
							if (absPath) {
								externalPlans.add(absPath);
							}
						}
					}
				}
			});

			rl.on("close", () => resolve({ slugs, externalPlans, totalLines: lineNumber }));
			/* v8 ignore start - defensive: readline error handler for rare stream failures */
			rl.on("error", () => resolve({ slugs, externalPlans, totalLines: lineNumber }));
			/* v8 ignore stop */
		});
	}
}

export const claudePlanScanner: PlanTranscriptScanner = new ClaudePlanScanner();

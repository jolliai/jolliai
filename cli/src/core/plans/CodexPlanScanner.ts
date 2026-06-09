/**
 * CodexPlanScanner — reads a Codex rollout transcript (JSONL) for plan signals.
 *
 * Codex's only plan signal is an `apply_patch` that writes a `.md` file. Verified
 * across 182 real sessions / 1254 apply_patch calls: every apply_patch arrives as
 * `payload.type === "custom_tool_call"` + `payload.name === "apply_patch"`, with
 * the patch text in `payload.input` (already real newlines / UTF-8 after the line
 * JSON.parse). There is NO `function_call:apply_patch` and NO shell-heredoc form.
 *
 * The patch text declares file ops with header lines between `*** Begin Patch`
 * and `*** End Patch`:
 *   - `*** Add File: <path>`     → target written
 *   - `*** Update File: <path>`  → target written
 *   - `*** Move to: <path>`      → rename/move TARGET (inside an Update block)
 *   - `*** Delete File: <path>`  → ignored (the file no longer exists on disk;
 *                                  the driver's existsSync guard would drop it anyway)
 * Paths are relative to the session cwd (forward slashes, may contain spaces), so
 * the whole segment after the colon is the path — we do NOT split on whitespace.
 * Header lines are matched at COLUMN 0 on the raw line (apply_patch headers are
 * never indented) so a space-prefixed hunk CONTEXT line that merely *reads* like a
 * header is not mistaken for one.
 *
 * This reads only the apply_patch REQUEST, never its result — so a failed/undone
 * patch is not distinguished here. The driver's existsSync gate is the deliberate
 * success contract (see TranscriptPlanDiscovery); matches the Claude path.
 *
 * Codex has no `~/.claude/plans/` and no plan-mode slug, so `slugs` is always
 * empty; every `.md` target is an UNFILTERED external path (the driver applies
 * the shared isExternalPlanCandidate policy + existsSync).
 *
 * `*** Move to:` is a defensive add: it is the documented apply_patch token for a
 * move target but was NOT observed in the local 182-session corpus (only
 * Add/Update/Delete File appeared). Implemented to spec, guarded by tests; the
 * existsSync guard in the driver makes a stale source path harmless.
 */

import { createReadStream } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { createInterface } from "node:readline";
import type { PlanScanResult, PlanTranscriptScanner } from "./PlanTranscriptScanner.js";

/** Header-line prefixes whose colon-suffix is a target path we may want. */
const TARGET_HEADER_PREFIXES = ["*** Add File:", "*** Update File:", "*** Move to:"];

class CodexPlanScanner implements PlanTranscriptScanner {
	scan(
		transcriptPath: string,
		fromLine: number,
		cwd: string,
		toLine: number = Number.POSITIVE_INFINITY,
	): Promise<PlanScanResult> {
		return new Promise((resolve) => {
			const slugs = new Set<string>();
			const externalPlans = new Set<string>();
			let lineNumber = 0;

			const stream = createReadStream(transcriptPath, { encoding: "utf-8" });
			const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

			const finish = (): void => resolve({ slugs, externalPlans, totalLines: lineNumber });

			rl.on("line", (line) => {
				lineNumber++;
				if (lineNumber <= fromLine) {
					return;
				}
				if (lineNumber > toLine) {
					// Past the upper bound — stop reading to save I/O. totalLines is the
					// first out-of-range line number; it is not used as the Codex cursor
					// (CodexDiscovery advances on the reference safe cursor, not this).
					rl.close();
					stream.destroy();
					return;
				}

				// Cheap substring pre-filter: skip lines that cannot be an apply_patch.
				if (!line.includes("apply_patch")) return;

				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					return; // malformed line — skip, never throw
				}
				if (!isObject(parsed)) return;
				const payload = parsed.payload;
				if (!isObject(payload)) return;
				if (payload.type !== "custom_tool_call" || payload.name !== "apply_patch") return;
				const input = payload.input;
				if (typeof input !== "string") return;

				// One apply_patch can carry multiple file ops — walk EVERY header line.
				// Match the `*** …` header at COLUMN 0 on the RAW line — apply_patch
				// headers are never indented. Trimming the line first would let a hunk
				// CONTEXT line (space-prefixed) whose text happens to read
				// `*** Add File: x.md` masquerade as a real header — and our own plan
				// docs contain exactly those literals. (`+`/`-` body prefixes survive a
				// trim and already fail startsWith; only the leading-space context case
				// is the one a pre-trim would wrongly admit.) The PATH alone is trimmed,
				// inside extractTargetPath.
				for (const rawPatchLine of input.split("\n")) {
					const target = extractTargetPath(rawPatchLine);
					if (target === null) continue;
					if (!target.toLowerCase().endsWith(".md")) continue;
					externalPlans.add(pathResolve(cwd, target));
				}
			});

			rl.on("close", finish);
			/* v8 ignore start - defensive: readline error handler for rare stream failures */
			rl.on("error", finish);
			/* v8 ignore stop */
		});
	}
}

/**
 * If `patchLine` (a RAW, un-trimmed patch line) is a target-producing apply_patch
 * header (`Add File:`, `Update File:`, `Move to:`) at column 0, return the path —
 * the WHOLE segment after the colon, trimmed (paths may contain spaces; a CRLF
 * `\r` or extra spaces after the colon are stripped here). Otherwise null.
 * `Delete File:`, indented look-alikes, and non-header lines return null.
 */
function extractTargetPath(patchLine: string): string | null {
	for (const prefix of TARGET_HEADER_PREFIXES) {
		if (patchLine.startsWith(prefix)) {
			const path = patchLine.slice(prefix.length).trim();
			return path.length > 0 ? path : null;
		}
	}
	return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export const codexPlanScanner: PlanTranscriptScanner = new CodexPlanScanner();

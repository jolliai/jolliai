/**
 * TranscriptReferenceDiscovery — source-aware reference scan + persist.
 *
 * Extracted from StopHook so both the Claude Stop path and the Codex polling
 * path drive the same logic. `scanReferencesFrom` is a pure scan + upsert: it
 * runs the shared `extractReferencesFromTranscript` (which picks the envelope
 * parser by `source`), then routes each discovered ref through
 * `upsertReferenceEntry` (plans.json.references + per-reference markdown). It
 * does NOT own the discovery cursor — the caller persists `lastLineNumberScanned`.
 */

import { createLogger } from "../../Logger.js";
import type { TranscriptSource } from "../../Types.js";
import { getCurrentBranchSafe } from "../GitBranch.js";
import { upsertReferenceEntry } from "../SessionTracker.js";
import { extractReferencesFromTranscript } from "./ReferenceExtractor.js";
import { getAdaptersForSource } from "./sources/index.js";

const log = createLogger("ReferenceDiscovery");

/**
 * Scans the transcript for ALL adapters applicable to `source` from `fromLine`
 * and persists discovered references. Pure scan + upsert — the caller owns the
 * discovery cursor. Returns the furthest line scanned (EOF).
 */
export async function scanReferencesFrom(
	transcriptPath: string,
	fromLine: number,
	cwd: string,
	source: TranscriptSource,
): Promise<number> {
	const { references, lastLineNumberScanned } = await extractReferencesFromTranscript(
		transcriptPath,
		getAdaptersForSource(source),
		{ fromLineNumber: fromLine, source },
	);

	if (references.length === 0) {
		return lastLineNumberScanned;
	}

	const branch = getCurrentBranchSafe(cwd);
	const upserted: string[] = [];
	const failed: string[] = [];
	for (const ref of references) {
		// Per-iteration try/catch: a single bad ref (e.g. permission error
		// writing markdown, or a transient plans.json write contention) must
		// not abort the batch — otherwise subsequent refs are lost AND the
		// cursor save in the caller is skipped, so the next pass re-processes the
		// same refs and hits the same failure in a loop.
		try {
			await upsertReferenceEntry(ref, cwd, branch);
			upserted.push(ref.mapKey);
		} catch (err) {
			log.warn(
				"Reference discovery: failed to persist %s: %s — continuing with rest of batch",
				ref.mapKey,
				(err as Error).message,
			);
			failed.push(ref.mapKey);
		}
	}
	log.info(
		"Reference discovery: upserted %d of %d ref(s)%s",
		upserted.length,
		references.length,
		failed.length > 0 ? ` (failed: [${failed.join(", ")}])` : "",
	);

	return lastLineNumberScanned;
}

/**
 * ProcessedSourceStore — the topic KB high-water mark, stored as the set of
 * already-ingested source IDs (NOT a timestamp). Decouples "has this source
 * been processed" from "what is its logical time" so out-of-order sources are
 * never skipped. Path: `topics/processed.json`, written via the active
 * StorageProvider (dual-write), mirroring CompiledStore.
 */

import { createLogger } from "../Logger.js";
import type { FileWrite } from "../Types.js";
import type { StorageProvider } from "./StorageProvider.js";
import { resolveStorage } from "./SummaryStore.js";
import type { ProcessedSet, SourceRef, SourceType } from "./TopicKBTypes.js";

const log = createLogger("ProcessedSourceStore");
const PROCESSED_PATH = "topics/processed.json";

/** A fresh set with all four buckets present. */
export function emptyProcessedSet(): ProcessedSet {
	return { schemaVersion: 1, processed: { summary: [], plan: [], note: [], userfile: [] } };
}

/** Reads `topics/processed.json`; missing or unparseable → empty set (never throws). */
export async function readProcessedSet(cwd?: string, storage?: StorageProvider): Promise<ProcessedSet> {
	const resolved = resolveStorage(storage, cwd);
	const raw = await resolved.readFile(PROCESSED_PATH);
	if (!raw) return emptyProcessedSet();
	try {
		const parsed = JSON.parse(raw) as Partial<ProcessedSet>;
		const p: Partial<Record<SourceType, string[]>> = parsed.processed ?? {};
		return {
			schemaVersion: 1,
			processed: {
				summary: p.summary ?? [],
				plan: p.plan ?? [],
				note: p.note ?? [],
				userfile: p.userfile ?? [],
			},
		};
	} catch {
		log.warn("Failed to parse %s — treating as empty", PROCESSED_PATH);
		return emptyProcessedSet();
	}
}

/**
 * True when `ref` (by type+id) is already in the set.
 *
 * Membership is a linear `Array.includes` per bucket — fine at current scale
 * (bounded by source count). If buckets grow large enough that batch
 * `addProcessed` becomes a hotspot, switch the in-memory representation to a
 * per-bucket `Set` (the on-disk JSON stays an array for readability; see the
 * parent spec's deferred compaction note).
 */
export function hasProcessed(set: ProcessedSet, ref: SourceRef): boolean {
	return set.processed[ref.type].includes(ref.id);
}

/** Returns a new set with `refs` added (idempotent, does not mutate `set`). */
export function addProcessed(set: ProcessedSet, refs: ReadonlyArray<SourceRef>): ProcessedSet {
	const next: Record<SourceType, string[]> = {
		summary: [...set.processed.summary],
		plan: [...set.processed.plan],
		note: [...set.processed.note],
		userfile: [...set.processed.userfile],
	};
	for (const ref of refs) {
		if (!next[ref.type].includes(ref.id)) next[ref.type].push(ref.id);
	}
	return { schemaVersion: 1, processed: next };
}

/** Persists the set via the active StorageProvider. */
export async function saveProcessedSet(set: ProcessedSet, cwd?: string, storage?: StorageProvider): Promise<void> {
	const resolved = resolveStorage(storage, cwd);
	const files: FileWrite[] = [{ path: PROCESSED_PATH, content: JSON.stringify(set, null, "\t") }];
	await resolved.writeFiles(files, "Update topic KB processed-source set");
}

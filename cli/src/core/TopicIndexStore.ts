/**
 * TopicIndexStore — read/write `topics/index.json`, the routing index for the
 * topic KB. Persisted via the active StorageProvider (dual-write).
 */

import { createLogger } from "../Logger.js";
import type { FileWrite } from "../Types.js";
import type { StorageProvider } from "./StorageProvider.js";
import { resolveStorage } from "./SummaryStore.js";
import type { TopicIndex } from "./TopicKBTypes.js";

const log = createLogger("TopicIndexStore");
const INDEX_PATH = "topics/index.json";

/** A fresh, empty index. */
export function emptyTopicIndex(): TopicIndex {
	return { schemaVersion: 1, topics: [] };
}

/** Reads `topics/index.json`; missing or unparseable → empty index (never throws). */
export async function readTopicIndex(cwd?: string, storage?: StorageProvider): Promise<TopicIndex> {
	const resolved = resolveStorage(storage, cwd);
	const raw = await resolved.readFile(INDEX_PATH);
	if (!raw) return emptyTopicIndex();
	try {
		const parsed = JSON.parse(raw) as TopicIndex;
		return { schemaVersion: 1, topics: parsed.topics ?? [] };
	} catch {
		log.warn("Failed to parse %s — treating as empty", INDEX_PATH);
		return emptyTopicIndex();
	}
}

/** Persists the index via the active StorageProvider. */
export async function saveTopicIndex(index: TopicIndex, cwd?: string, storage?: StorageProvider): Promise<void> {
	const resolved = resolveStorage(storage, cwd);
	const files: FileWrite[] = [{ path: INDEX_PATH, content: JSON.stringify(index, null, "\t") }];
	await resolved.writeFiles(files, `Update topic KB index (${index.topics.length} topics)`);
}

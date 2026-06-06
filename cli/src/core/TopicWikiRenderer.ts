/**
 * TopicWikiRenderer — reads all topic pages and asks the active StorageProvider
 * to render the visible `_wiki/`. No-op on orphan-only storage (no
 * renderTopicWiki). Called after drainIngest (queue worker + `jolli compile`).
 */

import { createLogger } from "../Logger.js";
import type { StorageProvider } from "./StorageProvider.js";
import { readTopicIndex } from "./TopicIndexStore.js";
import type { TopicPage } from "./TopicKBTypes.js";
import { readTopicPage } from "./TopicPageStore.js";

const log = createLogger("TopicWikiRenderer");

/**
 * Renders the visible wiki from the topic pages named by the authoritative
 * index (NOT a directory scan), so orphaned `topics/<slug>.json` files left by
 * a slug change or `--rebuild` are excluded. No-op on orphan-only storage.
 */
export async function renderTopicKBWiki(cwd: string, storage: StorageProvider): Promise<void> {
	if (!storage.renderTopicWiki) {
		log.debug("Active storage has no renderTopicWiki — skipping visible wiki render");
		return;
	}
	const index = await readTopicIndex(cwd, storage);
	const pages: TopicPage[] = [];
	for (const entry of index.topics) {
		const page = await readTopicPage(entry.stableSlug, cwd, storage);
		if (page) pages.push(page);
	}
	await storage.renderTopicWiki(pages);
}

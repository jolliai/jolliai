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
export async function renderTopicKBWiki(
	cwd: string,
	storage: StorageProvider,
	writeGuard: (fn: () => Promise<void>) => Promise<void> = (fn) => fn(),
): Promise<void> {
	if (!storage.renderTopicWiki) {
		log.debug("Active storage has no renderTopicWiki — skipping visible wiki render");
		return;
	}
	// The index/page reads AND the bulk render run INSIDE the guard so they form one
	// atomic snapshot-then-render under the per-vault lock. Reading the snapshot
	// lock-free would re-open a TOCTOU: a concurrent ingest/compile could update the
	// canonical JSON between the read and the render, and since `renderTopicWiki`
	// wipes `_wiki/` and rewrites it wholesale from the snapshot, this pass would
	// republish a stale wiki (dropping a page the concurrent writer just added).
	// Defaults to identity — the `jolli compile` paths already hold the lock for
	// their whole drain.
	const render = storage.renderTopicWiki.bind(storage);
	await writeGuard(async () => {
		const index = await readTopicIndex(cwd, storage);
		const pages: TopicPage[] = [];
		for (const entry of index.topics) {
			const page = await readTopicPage(entry.stableSlug, cwd, storage);
			if (page) pages.push(page);
		}
		await render(pages);
	});
}

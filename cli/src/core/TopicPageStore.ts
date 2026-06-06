/**
 * TopicPageStore — read/write/list canonical topic pages at
 * `topics/<stableSlug>.json`. Content is produced by sub-project 2; this module
 * only provides typed persistence. The rendered `_wiki/<slug>.md` layer is a
 * separate concern (FolderStorage / WikiMarkdownBuilder).
 */

import { createLogger } from "../Logger.js";
import type { FileWrite } from "../Types.js";
import type { StorageProvider } from "./StorageProvider.js";
import { resolveStorage } from "./SummaryStore.js";
import type { TopicPage } from "./TopicKBTypes.js";

const log = createLogger("TopicPageStore");

/** Reserved file names under `topics/` that are NOT topic pages. */
const RESERVED = new Set(["index", "processed"]);

/**
 * Guards a slug before it is interpolated into a `topics/<slug>.json` path.
 * Slugs are LLM-generated upstream (sub-project 2), so the store's public
 * surface must reject path-traversal / nesting itself rather than trusting the
 * caller. A safe slug is non-empty, contains no `/`, and contains no `..`.
 */
function isSafeSlug(slug: string): boolean {
	return slug.length > 0 && !slug.includes("/") && !slug.includes("..");
}

/** Reads a canonical topic page; missing, unparseable, or unsafe slug → null. */
export async function readTopicPage(slug: string, cwd?: string, storage?: StorageProvider): Promise<TopicPage | null> {
	if (!isSafeSlug(slug)) {
		log.warn("Refusing to read topic page with unsafe slug %s", slug);
		return null;
	}
	const resolved = resolveStorage(storage, cwd);
	const raw = await resolved.readFile(`topics/${slug}.json`);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as TopicPage;
	} catch {
		log.warn("Failed to parse topic page %s", slug);
		return null;
	}
}

/** Persists a canonical topic page via the active StorageProvider. Throws on an unsafe slug. */
export async function saveTopicPage(page: TopicPage, cwd?: string, storage?: StorageProvider): Promise<void> {
	if (!isSafeSlug(page.stableSlug)) {
		throw new Error(`Refusing to write topic page with unsafe slug: ${page.stableSlug}`);
	}
	const resolved = resolveStorage(storage, cwd);
	const files: FileWrite[] = [{ path: `topics/${page.stableSlug}.json`, content: JSON.stringify(page, null, "\t") }];
	await resolved.writeFiles(files, `Update topic page ${page.stableSlug}`);
}

/** Lists all topic page slugs under `topics/`, excluding index.json / processed.json. */
export async function listTopicPageSlugs(cwd?: string, storage?: StorageProvider): Promise<ReadonlyArray<string>> {
	const resolved = resolveStorage(storage, cwd);
	const files = await resolved.listFiles("topics/");
	return files
		.filter((f) => f.startsWith("topics/") && f.endsWith(".json"))
		.map((f) => f.slice("topics/".length, -".json".length))
		.filter((slug) => slug.length > 0 && !slug.includes("/") && !RESERVED.has(slug));
}

/**
 * Deletes topic page files whose slug is not in `keepSlugs`, returning the slugs
 * purged. `--rebuild` empties the index and replays from scratch, but the old
 * `topics/<slug>.json` files would otherwise linger as orphans — stale (even
 * parser-poisoned) data, unreferenced by the index and never rendered into the
 * wiki. Running this after ingest converges the canonical layer to the index,
 * mirroring the "index is the source of truth" model the wiki render already
 * follows (it wipes + rewrites `_wiki/` each time). No-op in steady state: a page
 * is always written alongside its index entry, so nothing diverges until a
 * rebuild drops topics. The delete propagates to both storage layers (orphan
 * branch via the fast-import `D` directive, folder via hidden-file unlink).
 */
export async function purgeTopicPagesExcept(
	keepSlugs: Iterable<string>,
	cwd?: string,
	storage?: StorageProvider,
): Promise<string[]> {
	const keep = new Set(keepSlugs);
	const resolved = resolveStorage(storage, cwd);
	const slugs = await listTopicPageSlugs(cwd, resolved);
	const orphans = slugs.filter((slug) => !keep.has(slug));
	if (orphans.length > 0) {
		await resolved.writeFiles(
			orphans.map((slug) => ({ path: `topics/${slug}.json`, content: "", delete: true })),
			`Purge ${orphans.length} orphaned topic page(s)`,
		);
		log.info("Purged %d orphaned topic page(s): %s", orphans.length, orphans.join(", "));
	}
	return orphans;
}

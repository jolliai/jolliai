/**
 * SearchIndex — thin Orama wrapper for JolliMemory's local full-text search
 * (JOLLI-1226 P0). Builds an in-memory BM25 index from SearchIndexSource,
 * persists it to .jolli/jollimemory/search-index.json, and rebuilds whenever
 * the source signature changes (or the persisted file is missing/corrupt).
 * The index is a disposable cache — source data (orphan branch / folder) is
 * always authoritative.
 *
 * Orama 3.1.18 API notes (verified against the installed package):
 * - `create({ schema })` is SYNCHRONOUS — returns the db object directly, no Promise.
 * - `insertMultiple` and `search` are async — both awaited here.
 * - `where: { … }` on a plain `"string"` field filters by TOKEN match: Orama
 *   tokenizes the filter value and UNIONs the per-token matches. Safe for the
 *   `type` filter (`topic`/`commit` are single, exact tokens) but WRONG for a
 *   branch name — `where.branch === "feature/auth"` tokenizes to `feature`+`auth`
 *   and would also match `feature/billing` (shared `feature` token). So `branch`
 *   is an `enum[]` field (one element per related branch), filtered by exact set
 *   membership: `where.branch === { containsAll: [want] }`. This runs in the index
 *   alongside the BM25 term query, so the returned `limit` is already filtered —
 *   no over-fetch-then-post-filter window that a rare-branch hit could fall out of.
 * - `persist(db, "json")` returns a `string` (async); `restore("json", data)`
 *   is async with format-first arg order.
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { create, insertMultiple, type Orama, search } from "@orama/orama";
import { persist, restore } from "@orama/plugin-data-persistence";
import { createLogger, getJolliMemoryDir } from "../Logger.js";
import { atomicWriteFile } from "./AtomicWrite.js";
import { collectSearchDocs, computeSourceSignature } from "./SearchIndexSource.js";
import { type IndexManifest, SEARCH_SCHEMA, SEARCH_SCHEMA_VERSION, type SearchDoc } from "./SearchIndexTypes.js";
import { createSearchTokenizer } from "./SearchTokenizer.js";
import type { StorageProvider } from "./StorageProvider.js";

const log = createLogger("SearchIndex");

const INDEX_FILE = "search-index.json";
const MANIFEST_FILE = "search-index.manifest.json";

/**
 * Whether persisting the freshly built index to disk is required or best-effort.
 *
 * `required` — an EXPLICIT reindex (`rebuild`, driven by `jolli compile`'s warm-up).
 * Landing the file IS the point there: it is what lets a later MCP server process
 * skip the rebuild. Swallowing a write failure would report a warm-up that did not
 * actually warm anything.
 *
 * `best-effort` — an IMPLICIT rebuild behind a read (`open` / `openCached`, i.e. a
 * search whose cache went stale). The caller wants results; the cache is an
 * optimization for next time, so a write failure must not fail the search — but
 * only a PERMISSION failure, see {@link isCacheWriteDenied}.
 */
type CachingMode = "required" | "best-effort";

/**
 * Whether a failed cache write is the sandbox's "you may not write here" — the one
 * failure a read is allowed to shrug off.
 *
 * Scoped deliberately narrowly. The condition this exists for is an agent sandbox
 * denying writes to the Memory Bank (which `resolveIndexDir` roots folder-backed
 * storage at, outside the writable workspace): nothing about the request is wrong,
 * so degrading to "no cache this time" is right. A disk-full, a missing parent
 * because the Memory Bank folder was moved, or a corrupt directory is a real
 * misconfiguration; swallowing those would turn every subsequent search into a
 * silent full rebuild with nothing but a debug-log line to show for it. Those
 * propagate so the caller can surface them.
 */
function isCacheWriteDenied(err: unknown): boolean {
	const code = (err as NodeJS.ErrnoException | undefined)?.code;
	return code === "EPERM" || code === "EACCES" || code === "EROFS";
}

/** The concrete Orama db type for our schema — lets `insertMultiple`/`search` stay type-clean. */
type SearchDb = Orama<typeof SEARCH_SCHEMA>;

export interface SearchQuery {
	readonly query: string;
	readonly branch?: string;
	readonly type?: "topic" | "commit";
	readonly limit?: number;
}

export interface SearchHitResult {
	readonly id: string;
	readonly type: "topic" | "commit";
	readonly title: string;
	readonly snippet: string;
	readonly branch: string;
	readonly commitDate: string;
	readonly slug: string;
	readonly hash: string;
	readonly score: number;
}

export class SearchIndex {
	private readonly db: SearchDb;

	/**
	 * Per-index-dir memo for {@link openCached}. Keyed by the resolved index
	 * directory (not raw cwd) so two cwds that resolve to the same folder-backed
	 * `kbRoot` share one entry. Holds the source signature the cached index was
	 * built against so a stale entry is detected on the next call.
	 */
	private static readonly cache = new Map<string, { sig: string; index: SearchIndex }>();

	private constructor(db: SearchDb) {
		this.db = db;
	}

	/** Open the index: restore from disk if fresh, else rebuild and persist. */
	static async open(cwd: string, storage?: StorageProvider): Promise<SearchIndex> {
		const sig = await computeSourceSignature(cwd, storage);
		const restored = await tryRestore(resolveIndexDir(cwd, storage), sig);
		if (restored) return new SearchIndex(restored);

		// Build with the signature we already computed — don't recompute it (each
		// recompute re-reads index + catalog + topic index off disk).
		const { index } = await SearchIndex.build(cwd, storage, sig, "best-effort");
		return index;
	}

	/**
	 * Like {@link open} but memoizes the opened index per cwd — for a long-lived
	 * process (the MCP server) that searches repeatedly. The cheap source
	 * signature is still recomputed on every call so a stale cache is detected;
	 * only the expensive restore/rebuild (re-deserializing the whole Orama db
	 * from disk) is skipped on a hit. A signature change transparently reopens.
	 */
	static async openCached(cwd: string, storage?: StorageProvider): Promise<SearchIndex> {
		const sig = await computeSourceSignature(cwd, storage);
		const dir = resolveIndexDir(cwd, storage);
		const hit = SearchIndex.cache.get(dir);
		if (hit && hit.sig === sig) return hit.index;

		const restored = await tryRestore(dir, sig);
		const index = restored
			? new SearchIndex(restored)
			: (await SearchIndex.build(cwd, storage, sig, "best-effort")).index;
		SearchIndex.cache.set(dir, { sig, index });
		return index;
	}

	/** Clears the {@link openCached} memo. Test seam + safety hatch. */
	static clearCache(): void {
		SearchIndex.cache.clear();
	}

	/** Force a full rebuild from source, persist, and return the index + count.
	 * Use this for explicit reindex / post-compile warm-up — it skips the
	 * restore-if-fresh path of open(), so callers that always want a fresh
	 * index don't pay for a wasted restore-or-build first. */
	static async rebuild(cwd: string, storage?: StorageProvider): Promise<{ index: SearchIndex; docCount: number }> {
		const sig = await computeSourceSignature(cwd, storage);
		return SearchIndex.build(cwd, storage, sig);
	}

	/**
	 * Collect docs, build the Orama db, and persist it against a KNOWN signature.
	 * Private so callers go through {@link open} / {@link rebuild}; both pass the
	 * signature they already computed so it isn't recomputed (and the sources
	 * re-read) inside the build.
	 */
	private static async build(
		cwd: string,
		storage: StorageProvider | undefined,
		sig: string,
		caching: CachingMode = "required",
	): Promise<{ index: SearchIndex; docCount: number }> {
		const docs = await collectSearchDocs(cwd, storage);
		const db: SearchDb = create({ schema: SEARCH_SCHEMA, components: { tokenizer: createSearchTokenizer() } });
		await insertMultiple(db, docs);
		const dir = resolveIndexDir(cwd, storage);
		if (caching === "required") {
			await persistTo(dir, db, sig);
		} else {
			try {
				await persistTo(dir, db, sig);
			} catch (err) {
				// The persisted copy is a CACHE; `db` above is already a complete, usable
				// index. So on a search-triggered rebuild a PERMISSION failure degrades to
				// "no cache this time" rather than failing the read that triggered it.
				//
				// This is what lets `search` work inside a sandboxed agent. Folder-backed
				// storage roots the index at the Memory Bank (see resolveIndexDir), which
				// sits outside the workspace an agent sandbox makes writable, so persisting
				// raises EPERM there. It only surfaces when the cache is STALE — a fresh
				// cache never reaches this path — which is why it looks intermittent: any
				// commit changes the source signature and forces the rebuild.
				//
				// Anything else (disk full, a Memory Bank folder that moved out from under
				// us, a corrupt index dir) is a real fault, not a sandbox: rethrow rather
				// than convert it into a permanently un-cached search whose only trace is
				// a debug-log line.
				if (!isCacheWriteDenied(err)) throw err;
				log.warn(
					"Search index built but not cached to %s: %s — serving from memory; the next search rebuilds it",
					dir,
					(err as Error).message,
				);
			}
		}
		log.info("Built search index: %d docs", docs.length);
		return { index: new SearchIndex(db), docCount: docs.length };
	}

	async search(q: SearchQuery): Promise<SearchHitResult[]> {
		// `limit` is unbounded MCP tool input. The MCP SDK validates the request
		// envelope but NOT per-tool arg types, so a non-conforming client can send a
		// non-numeric `limit` (e.g. "abc"); `Math.trunc("abc")` is NaN and would
		// poison the clamp below (Math.max/min(NaN,…) === NaN), reaching Orama as
		// `Array.from({length: NaN})` → 0 hits silently. So coerce first and fall
		// back to the default when not finite. Orama also preallocates that array,
		// which RangeErrors above 2^32-1 and DoS-allocates huge arrays well before
		// that, so clamp to a sane [1, 100] window (integer-truncated) afterward.
		const requested = q.limit == null ? 20 : Number(q.limit);
		const limit = Math.min(Math.max(1, Math.trunc(Number.isFinite(requested) ? requested : 20)), 100);
		// Both filters run natively inside Orama's index so the returned `limit` is
		// already post-filter — no over-fetch, no truncation. `type` is a tokenized
		// `string` field but its values are single exact tokens, so a plain match is
		// safe; `branch` is an `enum[]` field, matched by exact set membership with
		// `containsAll: [want]` (one-element ⇒ "the branch set contains `want`").
		const where: Record<string, unknown> = {};
		if (q.type) where.type = q.type;
		if (q.branch) where.branch = { containsAll: [q.branch] };
		const result = await search(this.db, {
			term: q.query,
			limit,
			...(Object.keys(where).length ? { where } : {}),
		});
		return result.hits.map((h) => {
			const doc = h.document as unknown as SearchDoc;
			return {
				id: doc.id,
				type: doc.type,
				title: doc.title,
				snippet: doc.content.slice(0, 280),
				// Hand back a SINGLE valid branch name. Commit docs always carry
				// exactly one; topic docs carry their relatedBranches[] — so a
				// space-join ("feature/auth main") is not a real branch and breaks the
				// jolli-search skill, which feeds this straight into `jolli-recall`.
				// Use the first/primary related branch instead.
				branch: doc.branch[0] ?? "",
				commitDate: doc.commitDate,
				slug: doc.slug,
				hash: doc.hash,
				score: h.score,
			};
		});
	}
}

/**
 * Where the disposable index + manifest live. Folder-backed storage roots it at
 * the Memory Bank folder (`<kbRoot>/.jolli/jollimemory/`) so the `jolli compile`
 * warm-up and the MCP server resolve the SAME file; orphan-only / no-storage
 * falls back to the checkout's `.jolli/jollimemory/`. See StorageProvider.kbRoot.
 */
function resolveIndexDir(cwd: string, storage?: StorageProvider): string {
	return getJolliMemoryDir(storage?.kbRoot ?? cwd);
}

async function persistTo(dir: string, db: SearchDb, sig: string): Promise<void> {
	const indexPath = join(dir, INDEX_FILE);
	await mkdir(dirname(indexPath), { recursive: true });
	const serialized = await persist(db, "json");
	// Atomic writes (tmpfile + rename) so a crash mid-write never leaves a
	// half-written file. Index FIRST, then the manifest — the manifest is the
	// "index is ready" marker, so a torn pair (index written, manifest not) just
	// fails the signature check on next restore and triggers a rebuild.
	await atomicWriteFile(indexPath, serialized as string);
	const manifest: IndexManifest = {
		schemaVersion: SEARCH_SCHEMA_VERSION,
		sourceSignature: sig,
		savedAt: new Date().toISOString(),
	};
	await atomicWriteFile(join(dir, MANIFEST_FILE), JSON.stringify(manifest));
}

async function tryRestore(dir: string, currentSig: string): Promise<SearchDb | null> {
	try {
		const manifestRaw = await readFile(join(dir, MANIFEST_FILE), "utf-8");
		const manifest = JSON.parse(manifestRaw) as IndexManifest;
		if (manifest.schemaVersion !== SEARCH_SCHEMA_VERSION) return null;
		if (manifest.sourceSignature !== currentSig) return null;
		const indexRaw = await readFile(join(dir, INDEX_FILE), "utf-8");
		const db = (await restore("json", indexRaw)) as SearchDb;
		// restore() rebuilds the db with DEFAULT components, dropping our CJK-aware
		// tokenizer — search reads `db.tokenizer` at query time, so re-apply it or a
		// CJK query against a restored index tokenizes with the default rule and
		// matches nothing despite the n-grams being present in the loaded index.
		db.tokenizer = createSearchTokenizer();
		return db;
	} catch {
		return null;
	}
}

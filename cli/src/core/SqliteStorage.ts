/**
 * SqliteStorage — the {@link StorageProvider} face of `jollimemory.db`.
 *
 * The adapter exists so the 65 "create a storage" call sites do not change:
 * callers keep thinking in files, and this class maps each path family to the
 * tables that now hold the truth. That mapping has to be BYTE-faithful on read
 * — the acceptance for the whole cutover is comparing what this returns against
 * what the orphan branch serves, path by path — which pins several details:
 *
 * - Summary files are tab-indented (`JSON.stringify(x, null, "\t")`), and the
 *   `children` key is filled IN PLACE: the import emptied its value without
 *   moving the key, so assembly assigns into the parsed object and key order
 *   survives the round trip. A summary stored without the key never gains one.
 * - Assembly fills children with each child's CURRENT row, ordered by
 *   `child_pos`. That is deliberately NOT byte-identical to the parent file:
 *   measured on this repo, 3,025 of 3,025 embedded copies differ from their
 *   child's own file (pushes and migrations update the child file, never the
 *   copy inside the parent), so the parent's embedded variants are stale data
 *   the import rightly discarded. The equivalence criterion is therefore:
 *   childless summaries byte-exact; parents byte-exact OUTSIDE children plus
 *   an identical child set and order — measured 312/312 on real data.
 * - Transcript blobs are the deflated ORIGINAL file bytes, so inflate alone
 *   reproduces them exactly.
 * - `context.body_md` and `plan_progress.artifact_json` store the whole file
 *   verbatim and come back verbatim.
 *
 * - `index.json` / `catalog.json` / `topics/*` / `schema-v5-migration.json`
 *   are SYNTHESIZED — they are the plan's "views and indexes in file clothing",
 *   so they have no stored source and are rebuilt from the tables on read.
 *   Two data dependencies make this possible at all: `memories.tree_hash` is a
 *   real column copied off the index entry at import (313/313 summary files
 *   carry no treeHash — it only ever lived in index.json), and
 *   `topic_pages.summary` likewise exists only in `topics/index.json`.
 *   Allowlisted differences, per the plan's acceptance clause: entry ORDER
 *   (historical append order in the files, write order here — every consumer
 *   parses into a map) and stale copies in the files themselves (measured:
 *   18/37 roots' `topicCount` and 1 entry's `branch` disagreed with the
 *   index's own summary files; the rebuilt values are the fresh ones).
 *
 * Writes go through {@link applyMemoryWrites} (SotWrite): one batch = one
 * transaction, landed in dependency order regardless of caller order — see
 * that module's header for the ordering, link-replacement and remount rules.
 */

import { inflateSync } from "node:zlib";
import { type DashboardDbHandle, withDashboardDb, withReadonlyDashboardDb } from "../dashboard/DashboardDb.js";
import { applyMemoryWrites } from "../dashboard/SotWrite.js";
import { isManuallyDisabled } from "../Logger.js";
import type { CommitSummary, FileWrite } from "../Types.js";
import type { StorageKind, StorageProvider } from "./StorageProvider.js";
import { toCatalogEntry } from "./SummaryStore.js";
import { countTopics } from "./SummaryTree.js";

/** One memories row, as the assembly needs it. */
interface MemoryRow {
	readonly commit_hash: string;
	readonly parent_hash: string | null;
	readonly child_pos: number | null;
	readonly tree_hash: string | null;
	readonly summary_json: string;
	/** Root diff stats a legacy summary carried on the index entry only, or null. */
	readonly index_diff_stats_json: string | null;
}

/** One topic_source_refs row, already ordered by pos. */
interface TopicRefRow {
	readonly ref_type: string;
	readonly ref_id: string;
	readonly ts: string;
	readonly branch: string | null;
}

/** One topic_pages row. */
interface TopicPageRow {
	readonly stable_slug: string;
	readonly title: string;
	readonly summary: string | null;
	readonly content_md: string;
	readonly related_branches_json: string;
	readonly last_updated_at: string;
	readonly payload_version: number;
}

/** Groups rows into a parent→ordered-children map for {@link assembleSummary}. */
function childrenOf(rows: ReadonlyArray<MemoryRow>): Map<string, MemoryRow[]> {
	const map = new Map<string, MemoryRow[]>();
	for (const r of rows) {
		if (r.parent_hash == null) continue;
		const siblings = map.get(r.parent_hash) ?? [];
		siblings.push(r);
		map.set(r.parent_hash, siblings);
	}
	// child_pos is NULL exactly on roots (schema CHECK), so every sibling here
	// carries a real position; Number(NULL→null) keeps tsc happy without a dead
	// ?? branch.
	for (const siblings of map.values()) siblings.sort((a, b) => Number(a.child_pos) - Number(b.child_pos));
	return map;
}

/** Recursively rebuilds a summary object with its nested children arrays. */
function assembleSummary(
	childrenOf: ReadonlyMap<string, ReadonlyArray<MemoryRow>>,
	row: MemoryRow,
): Record<string, unknown> {
	const summary = JSON.parse(row.summary_json) as Record<string, unknown>;
	// Fill in place, never insert: the import preserved the key's position with
	// an emptied value, and a file that never had the key must not grow one —
	// both would move bytes the equivalence check does not allow to move.
	if ("children" in summary) {
		summary.children = (childrenOf.get(row.commit_hash) ?? []).map((child) => assembleSummary(childrenOf, child));
	}
	return summary;
}

/**
 * Rebuilds one memory's summary WITH its children nested, straight from the
 * tables — the object a surface reading `summaries/<hash>.json` would parse.
 *
 * Exported because the dashboard's read model needs the same tree without going
 * through a StorageProvider (it is already inside a database transaction, and
 * `readFile` would re-serialize to a string only for it to parse back). The
 * stored `summary_json` alone is NOT that object: the import empties `children`
 * and files each child as its own row, so anything derived from the tree —
 * conversation-token totals across an amend chain, legacy v3/v4 topic recursion
 * — silently reads as if the memory had no history.
 *
 * Returns undefined when the repo has no row for `hash`.
 */
export function assembleMemoryTree(
	db: DashboardDbHandle,
	repoId: number,
	hash: string,
): Record<string, unknown> | undefined {
	const root = db.prepare("SELECT root_hash FROM memories WHERE repo_id = ? AND commit_hash = ?").get(repoId, hash) as
		| { root_hash: string }
		| undefined;
	if (!root) return undefined;
	const tree = db
		.prepare(
			`SELECT commit_hash, parent_hash, child_pos, tree_hash, summary_json
			   FROM memories WHERE repo_id = ? AND root_hash = ?`,
		)
		.all(repoId, root.root_hash) as MemoryRow[];
	const self = tree.find((r) => r.commit_hash === hash);
	return self ? assembleSummary(childrenOf(tree), self) : undefined;
}

/**
 * Unwraps the database backend from a provider: either the storage itself or
 * the PRIMARY of a dual-write wrapper (the cutover route pairs SqliteStorage
 * with the visible-layer renderer, and the typed hot paths must not lose
 * their one-SELECT shape to the wrapper).
 */
export function asSqliteStorage(storage?: StorageProvider): SqliteStorage | null {
	if (storage instanceof SqliteStorage) return storage;
	const primary = (storage as { primary?: unknown } | undefined)?.primary;
	return primary instanceof SqliteStorage ? primary : null;
}

export class SqliteStorage implements StorageProvider {
	readonly kind: StorageKind = "sqlite";

	constructor(
		private readonly repoIdentity: string,
		private readonly dbPath?: string,
	) {}

	private async withDb<T>(fn: (db: DashboardDbHandle, repoId: number) => T): Promise<T> {
		// A short read-only connection per operation, not a held handle: the plan's
		// rule for long-lived processes is "reopen per operation", because a held
		// connection never learns that another surface migrated the schema.
		return withReadonlyDashboardDb(
			(db) => {
				const row = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(this.repoIdentity) as
					| { id: number }
					| undefined;
				if (!row) throw new Error(`SqliteStorage: no repos row for ${this.repoIdentity}`);
				return fn(db, row.id);
			},
			// An undefined dbPath falls through to the machine default inside
			// DashboardDb (`opts.dbPath ?? getDashboardDbPath()`).
			{ dbPath: this.dbPath },
		);
	}

	/**
	 * `withDb` for READS: a missing `repos` row answers `absent`, never throws.
	 *
	 * The `StorageProvider` contract is that a `null`/empty read means "not
	 * there", not "the read failed" — every other backend honours it, and
	 * `SummaryStore.loadIndex` calls `readFile(INDEX_FILE)` with no try/catch,
	 * so a throw here escapes `getSummary`, `listSummaries` and the QueueWorker
	 * drain instead of degrading to "no data yet". The unregistered-repo state
	 * is reachable, not theoretical: `CutoverRouter` answers `no-row` for
	 * "repo not registered" as well as for "no cutover row", and the
	 * `legacy-fenced` route builds a bare `SqliteStorage` from it.
	 *
	 * WRITES keep the throwing `withDb` on purpose — landing a memory in a
	 * repo the registry does not know about must fail loudly, not silently
	 * succeed against nothing.
	 */
	private async withDbOrAbsent<T>(fn: (db: DashboardDbHandle, repoId: number) => T, absent: T): Promise<T> {
		return withReadonlyDashboardDb(
			(db) => {
				const row = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(this.repoIdentity) as
					| { id: number }
					| undefined;
				if (!row) return absent;
				return fn(db, row.id);
			},
			{ dbPath: this.dbPath },
		);
	}

	async readFile(path: string): Promise<string | null> {
		return this.withDbOrAbsent((db, repoId) => this.readOne(db, repoId, path), null);
	}

	async batchReadFiles(paths: ReadonlyArray<string>): Promise<Map<string, string | null>> {
		// One connection for the whole batch; the per-path work is index lookups.
		// An unregistered repo answers a full map of nulls rather than an empty
		// one: callers index it by path, and a missing key is not the same
		// answer as an explicit "absent".
		return this.withDbOrAbsent(
			(db, repoId) => {
				const out = new Map<string, string | null>();
				for (const path of paths) out.set(path, this.readOne(db, repoId, path));
				return out;
			},
			new Map<string, string | null>(paths.map((p) => [p, null])),
		);
	}

	private readOne(db: DashboardDbHandle, repoId: number, path: string): string | null {
		const summary = path.match(/^summaries\/([0-9a-f]+)\.json$/);
		if (summary) {
			// The whole tree in two indexed queries, then assembly in memory: the
			// tree measures 17 levels deep, and per-level queries would be a
			// recursive chat with the database.
			const assembled = assembleMemoryTree(db, repoId, summary[1]);
			return assembled ? JSON.stringify(assembled, null, "\t") : null;
		}

		if (path === "index.json") return this.synthIndex(db, repoId);
		if (path === "catalog.json") return this.synthCatalog(db, repoId);
		if (path === "topics/index.json") return this.synthTopicIndex(db, repoId);
		if (path === "topics/processed.json") return this.synthProcessed(db, repoId);
		if (path === "schema-v5-migration.json") {
			const row = db
				.prepare("SELECT value FROM repo_state WHERE repo_id = ? AND key = 'v5-migration'")
				.get(repoId) as { value: string } | undefined;
			return row?.value ?? null;
		}
		const topicPage = path.match(/^topics\/([^/]+)\.json$/);
		if (topicPage) return this.synthTopicPage(db, repoId, topicPage[1]);

		const transcript = path.match(/^transcripts\/(.+)\.json$/);
		if (transcript) {
			const row = db
				.prepare("SELECT sessions_blob FROM transcripts WHERE repo_id = ? AND transcript_id = ?")
				.get(repoId, transcript[1]) as { sessions_blob: Uint8Array } | undefined;
			return row ? inflateSync(Buffer.from(row.sessions_blob)).toString("utf8") : null;
		}

		const context = path.match(/^(plans|notes|references|skills)\/(.+)\.md$/);
		if (context) {
			const kind = { plans: "plan", notes: "note", references: "reference", skills: "skill" }[
				context[1]
			] as string;
			const row = db
				.prepare("SELECT body_md FROM context WHERE repo_id = ? AND kind = ? AND context_key = ?")
				.get(repoId, kind, context[2]) as { body_md: string } | undefined;
			return row?.body_md ?? null;
		}

		const progress = path.match(/^plan-progress\/(.+)\.json$/);
		if (progress) {
			const row = db
				.prepare("SELECT artifact_json FROM plan_progress WHERE repo_id = ? AND plan_slug = ?")
				.get(repoId, progress[1]) as { artifact_json: string } | undefined;
			return row?.artifact_json ?? null;
		}

		// A path outside every known family: absent, not an error — mirroring a
		// file that simply is not on the branch.
		return null;
	}

	/** Every memories row for the repo, in import/write (rowid) order. */
	private allMemories(db: DashboardDbHandle, repoId: number): MemoryRow[] {
		return db
			.prepare(
				`SELECT commit_hash, parent_hash, child_pos, tree_hash, summary_json, index_diff_stats_json
				   FROM memories WHERE repo_id = ? ORDER BY rowid`,
			)
			.all(repoId) as MemoryRow[];
	}

	/**
	 * `index.json`, rebuilt from `memories` + `commit_aliases`. Field-for-field
	 * what flattenSummaryTree writes; the DELIBERATE differences from the last
	 * file the orphan carried are entry order (historical append order there,
	 * write order here — every consumer parses entries into a map) and staleness:
	 * measured on this repo, 18 of 37 roots' `topicCount` and 1 entry's `branch`
	 * disagreed with the index's own summary files, because index rebuild paths
	 * copy stale values forward. Deriving from the current rows is the fix, not
	 * a regression — same story as the embedded-children drift in the header.
	 */
	/**
	 * The `diffStats` key for one root entry, or nothing.
	 *
	 * A conditional spread rather than `?? undefined` for the same reason as its
	 * neighbours: `JSON.stringify` drops undefined either way, but the spread
	 * also keeps key presence and order identical to the file the writer would
	 * have produced — which the cutover compare checks.
	 */
	private diffStatsFor(summary: Record<string, unknown>, row: MemoryRow): Record<string, unknown> {
		if (summary.diffStats !== undefined) return { diffStats: summary.diffStats };
		if (row.index_diff_stats_json === null) return {};
		try {
			return { diffStats: JSON.parse(row.index_diff_stats_json) };
		} catch {
			// A row that cannot be parsed is treated as absent: an index entry with
			// no diffStats is a normal shape, so degrading to it costs a badge
			// rather than the whole index read.
			return {};
		}
	}

	private synthIndex(db: DashboardDbHandle, repoId: number): string | null {
		const rows = this.allMemories(db, repoId);
		if (rows.length === 0) return null;
		const kids = childrenOf(rows);
		const entries = rows.map((r) => {
			const s = JSON.parse(r.summary_json) as Record<string, unknown>;
			const isRoot = r.parent_hash === null;
			return {
				commitHash: r.commit_hash,
				parentCommitHash: r.parent_hash,
				// Conditional spreads, not `?? undefined`: JSON.stringify drops an
				// undefined value either way, so key order and presence both match
				// the file the writer would have produced.
				...(r.tree_hash !== null && { treeHash: r.tree_hash }),
				...(s.commitType !== undefined && { commitType: s.commitType }),
				commitMessage: s.commitMessage,
				commitDate: s.commitDate,
				branch: s.branch,
				...(s.generatedAt !== undefined && { generatedAt: s.generatedAt }),
				...(isRoot && {
					topicCount: countTopics(assembleSummary(kids, r) as unknown as CommitSummary),
					// Body first, then the stats the legacy index entry carried.
					// `flattenSummaryTree` resolved these in three steps and only the
					// first is recoverable from a body-only rebuild — so a pre-v4
					// memory silently lost its diff badge everywhere it is rendered
					// (`jolli view`, the sidebar, the SessionStart briefing) and its
					// entry stopped matching the file the branch carried. The third
					// step, a live `git diff`, deliberately does NOT belong here: this
					// is a pure projection of stored rows and must not shell out.
					...this.diffStatsFor(s, r),
				}),
			};
		});
		const aliasRows = db
			.prepare("SELECT old_hash, target_hash FROM commit_aliases WHERE repo_id = ? ORDER BY rowid")
			.all(repoId) as { old_hash: string; target_hash: string }[];
		return JSON.stringify(
			{
				version: 3,
				entries,
				...(aliasRows.length > 0 && {
					commitAliases: Object.fromEntries(aliasRows.map((a) => [a.old_hash, a.target_hash])),
				}),
			},
			null,
			"\t",
		);
	}

	/** `catalog.json`: one toCatalogEntry per root — measured 37/37 byte-equal. */
	private synthCatalog(db: DashboardDbHandle, repoId: number): string | null {
		const rows = this.allMemories(db, repoId);
		if (rows.length === 0) return null;
		const kids = childrenOf(rows);
		const entries = rows
			.filter((r) => r.parent_hash === null)
			.map((r) => toCatalogEntry(assembleSummary(kids, r) as unknown as CommitSummary));
		return JSON.stringify({ version: 1, entries }, null, "\t");
	}

	/** Ordered source refs for one topic page, in stored file shape. */
	private topicRefs(db: DashboardDbHandle, repoId: number, slug: string): Record<string, unknown>[] {
		const refs = db
			.prepare(
				`SELECT ref_type, ref_id, ts, branch FROM topic_source_refs
				  WHERE repo_id = ? AND stable_slug = ? ORDER BY pos`,
			)
			.all(repoId, slug) as TopicRefRow[];
		return refs.map((f) => ({
			type: f.ref_type,
			id: f.ref_id,
			timestamp: f.ts,
			...(f.branch !== null && { branch: f.branch }),
		}));
	}

	/** `topics/<slug>.json`: a TopicPage in its declared field order. */
	private synthTopicPage(db: DashboardDbHandle, repoId: number, slug: string): string | null {
		const page = db
			.prepare(
				`SELECT stable_slug, title, summary, content_md, related_branches_json,
				        last_updated_at, payload_version
				   FROM topic_pages WHERE repo_id = ? AND stable_slug = ?`,
			)
			.get(repoId, slug) as TopicPageRow | undefined;
		if (!page) return null;
		return JSON.stringify(
			{
				schemaVersion: page.payload_version,
				stableSlug: page.stable_slug,
				title: page.title,
				content: page.content_md,
				relatedBranches: JSON.parse(page.related_branches_json),
				sourceRefs: this.topicRefs(db, repoId, slug),
				lastUpdatedAt: page.last_updated_at,
			},
			null,
			"\t",
		);
	}

	/** `topics/index.json`: TopicIndex entries in page write order. */
	private synthTopicIndex(db: DashboardDbHandle, repoId: number): string | null {
		const pages = db
			.prepare(
				`SELECT stable_slug, title, summary, content_md, related_branches_json,
				        last_updated_at, payload_version
				   FROM topic_pages WHERE repo_id = ? ORDER BY rowid`,
			)
			.all(repoId) as TopicPageRow[];
		if (pages.length === 0) return null;
		const topics = pages.map((p) => ({
			stableSlug: p.stable_slug,
			title: p.title,
			// `summary` exists ONLY in topics/index.json (never in the page file),
			// which is exactly why topic_pages carries the column.
			...(p.summary !== null && { summary: p.summary }),
			relatedBranches: JSON.parse(p.related_branches_json),
			sourceRefs: this.topicRefs(db, repoId, p.stable_slug),
			lastUpdatedAt: p.last_updated_at,
		}));
		return JSON.stringify({ schemaVersion: 1, topics }, null, "\t");
	}

	/** `topics/processed.json`: all four source-type keys, ids in write order. */
	private synthProcessed(db: DashboardDbHandle, repoId: number): string | null {
		const rows = db
			.prepare("SELECT source_type, source_id FROM topic_processed_sources WHERE repo_id = ? ORDER BY rowid")
			.all(repoId) as { source_type: string; source_id: string }[];
		if (rows.length === 0) return null;
		// The writer always emits all four keys (measured: empty types carry []),
		// in this fixed order; the schema CHECK pins source_type to these four.
		const processed: Record<string, string[]> = { summary: [], plan: [], note: [], userfile: [] };
		for (const r of rows) processed[r.source_type].push(r.source_id);
		return JSON.stringify({ schemaVersion: 1, processed }, null, "\t");
	}

	async listFiles(prefix: string): Promise<string[]> {
		return this.withDbOrAbsent((db, repoId) => {
			const list = (sql: string, render: (v: string) => string): string[] =>
				(db.prepare(sql).all(repoId) as { v: string }[]).map((r) => render(r.v));
			const all = [
				...list("SELECT commit_hash AS v FROM memories WHERE repo_id = ?", (v) => `summaries/${v}.json`),
				...list("SELECT transcript_id AS v FROM transcripts WHERE repo_id = ?", (v) => `transcripts/${v}.json`),
				...list(
					"SELECT context_key AS v FROM context WHERE repo_id = ? AND kind = 'plan'",
					(v) => `plans/${v}.md`,
				),
				...list(
					"SELECT context_key AS v FROM context WHERE repo_id = ? AND kind = 'note'",
					(v) => `notes/${v}.md`,
				),
				...list(
					"SELECT context_key AS v FROM context WHERE repo_id = ? AND kind = 'reference'",
					(v) => `references/${v}.md`,
				),
				...list(
					"SELECT context_key AS v FROM context WHERE repo_id = ? AND kind = 'skill'",
					(v) => `skills/${v}.md`,
				),
				...list("SELECT plan_slug AS v FROM plan_progress WHERE repo_id = ?", (v) => `plan-progress/${v}.json`),
				...list("SELECT stable_slug AS v FROM topic_pages WHERE repo_id = ?", (v) => `topics/${v}.json`),
				// Synthesized listings mirror what the orphan tree would carry: the
				// summary index/catalog exist once there is a memory, the topic
				// index/processed pair once ingest has run, and the v5 marker when
				// the import copied one over.
				...list("SELECT 'index.json' AS v FROM memories WHERE repo_id = ? LIMIT 1", (v) => v),
				...list("SELECT 'catalog.json' AS v FROM memories WHERE repo_id = ? LIMIT 1", (v) => v),
				...list("SELECT 'topics/index.json' AS v FROM topic_pages WHERE repo_id = ? LIMIT 1", (v) => v),
				...list(
					"SELECT 'topics/processed.json' AS v FROM topic_processed_sources WHERE repo_id = ? LIMIT 1",
					(v) => v,
				),
				...list(
					"SELECT 'schema-v5-migration.json' AS v FROM repo_state WHERE repo_id = ? AND key = 'v5-migration'",
					(v) => v,
				),
			];
			return all.filter((p) => p.startsWith(prefix)).sort();
		}, []);
	}

	async writeFiles(files: FileWrite[], _message: string): Promise<void> {
		// Same opt-out gate the three other providers open with
		// (OrphanBranchStorage, FolderStorage, DualWriteStorage): `userDisabled`
		// stops orphan and SQLite writes ALIKE.
		//
		// It is the cheap IN-PROCESS mirror, nothing more: `isManuallyDisabled()`
		// reads a boolean that only the VS Code extension host ever sets, so in a
		// CLI process — a hook, the worker, `ide-bridge-serve` — it is inert by
		// design (Logger.ts states this). Enforcement for those lives at each
		// entry point, on the disk-backed `readManualDisableFlag`: the hooks gate
		// themselves, and the bridge's write actions go through
		// `refuseWriteIfManuallyDisabled` in IdeBridgeCommand. Do not "fix" this
		// line by reading the disk here — a provider keyed on `repoIdentity` has
		// no single cwd to read it from (one identity spans clones), and it would
		// make this the one provider of four that behaves differently.
		if (isManuallyDisabled()) return;
		// The commit message has no home in the database — there is no commit.
		// A WRITABLE handle through withDashboardDb, which throws on failure:
		// the activity layer's never-throw wrapper is banned on this path,
		// because it is built on "this database is disposable" and the memory
		// tables are the only copy. No file lock either — serialization is the
		// transaction inside applyMemoryWrites (the orphan write lock stays on
		// the ORPHAN path, where it also fences the cutover CAS).
		await withDashboardDb(
			(db) => {
				const row = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(this.repoIdentity) as
					| { id: number }
					| undefined;
				if (!row) throw new Error(`SqliteStorage: cannot write memories for unregistered ${this.repoIdentity}`);
				applyMemoryWrites(db, row.id, files, Date.now());
			},
			{ dbPath: this.dbPath },
		);
	}

	/**
	 * The two-segment search-index signature (phase E): (row count, newest
	 * write watermark) for memories AND for topic_pages. Two segments because
	 * topic_pages has no ms column — its watermark is the ISO last_updated_at,
	 * safe to MAX() lexicographically (one format, one zone) — and a
	 * memories-only signature would never rebuild the index after a topic-page
	 * change, freezing topic search on old content. written_at_ms moves on
	 * every upsert, so in-place edits are covered without a content digest.
	 * Per-repo by construction: this instance is bound to one repo_identity,
	 * so one repo's search never pays another repo's rebuild.
	 */
	async searchSignatureParts(): Promise<{
		memoriesCount: number;
		memoriesNewestMs: number;
		topicCount: number;
		topicNewest: string;
	}> {
		return this.withDbOrAbsent(
			(db, repoId) => {
				const memories = db
					.prepare(
						"SELECT COUNT(*) AS n, COALESCE(MAX(written_at_ms), 0) AS newest FROM memories WHERE repo_id = ?",
					)
					.get(repoId) as { n: number; newest: number };
				const topics = db
					.prepare(
						"SELECT COUNT(*) AS n, COALESCE(MAX(last_updated_at), '') AS newest FROM topic_pages WHERE repo_id = ?",
					)
					.get(repoId) as { n: number; newest: string };
				return {
					memoriesCount: memories.n,
					memoriesNewestMs: memories.newest,
					topicCount: topics.n,
					topicNewest: topics.newest,
				};
			},
			{ memoriesCount: 0, memoriesNewestMs: 0, topicCount: 0, topicNewest: "" },
		);
	}

	// ── Typed hot-path readers (phase H) ────────────────────────────────────
	// The adapter's file synthesis stays for edge callers, but the four hot
	// paths (getSummary fallback, recall's head listing, search collection,
	// dashboard — the last already querying tables directly) must not turn one
	// SELECT into a 137KB synthesized document. Each reader answers exactly the
	// question its call site asks, nothing document-shaped.

	/** commit_aliases lookup — getSummary step 2 without synthesizing index.json. */
	async lookupAlias(oldHash: string): Promise<string | null> {
		return this.withDbOrAbsent((db, repoId) => {
			const row = db
				.prepare("SELECT target_hash FROM commit_aliases WHERE repo_id = ? AND old_hash = ?")
				.get(repoId, oldHash) as { target_hash: string } | undefined;
			return row?.target_hash ?? null;
		}, null);
	}

	/**
	 * Tree-hash match — getSummary step 4 (the cross-tree fallback that resolves
	 * a cherry-pick/rebase copy to the memory of the commit it was copied from).
	 *
	 * Tie-break is the shallowest node, then the most recent date, mirroring the
	 * index-based `findShallowstByTreeHash` — `depth` and `commit_date_ms` are
	 * stored columns, so the whole rule is one ORDER BY rather than a client-side
	 * walk up the parent chain.
	 */
	async findShallowestByTreeHash(treeHash: string): Promise<string | null> {
		return this.withDbOrAbsent((db, repoId) => {
			const row = db
				.prepare(
					`SELECT commit_hash FROM memories WHERE repo_id = ? AND tree_hash = ?
					  ORDER BY depth ASC, commit_date_ms DESC LIMIT 1`,
				)
				.get(repoId, treeHash) as { commit_hash: string } | undefined;
			return row?.commit_hash ?? null;
		}, null);
	}

	/**
	 * Prefix scan over commit hashes — getSummary step 3 (abbreviated input).
	 *
	 * The hex guard is what makes LIKE mean startsWith. `_` and `%` are LIKE
	 * wildcards, and `getSummary` validates its input only for emptiness — so
	 * without this, `a_c` matched `axc…` (measured) and `%` matched every row
	 * in the repo, surfacing as an `AmbiguousHashError` that lists the whole
	 * table. The index backend answers null for both, and agreeing with it is
	 * the cutover's acceptance criterion. Every `commit_hash` is lowercase hex,
	 * so refusing a non-hex prefix outright is exactly the set `startsWith`
	 * would have returned, not an approximation of it.
	 */
	async findHashesByPrefix(prefix: string): Promise<string[]> {
		if (!/^[0-9a-f]+$/.test(prefix)) return [];
		return this.withDbOrAbsent((db, repoId) => {
			const rows = db
				.prepare("SELECT commit_hash FROM memories WHERE repo_id = ? AND commit_hash LIKE ? || '%'")
				.all(repoId, prefix) as Array<{ commit_hash: string }>;
			return rows.map((r) => r.commit_hash);
		}, []);
	}

	/**
	 * Branch-head index entries (roots only — `filterToBranchHeads`'s
	 * parent==null invariant IS the parent_hash IS NULL predicate), optionally
	 * scoped to one branch. Feeds recall's branch catalog and task-context
	 * compilation without flattening every node into an index document.
	 */
	async listHeadEntries(branch?: string): Promise<
		Array<{
			commitHash: string;
			parentCommitHash: null;
			treeHash?: string;
			commitType?: string;
			commitMessage: string;
			commitDate: string;
			branch: string;
			generatedAt: string;
		}>
	> {
		return this.withDbOrAbsent((db, repoId) => {
			const rows = db
				.prepare(
					`SELECT commit_hash, tree_hash, commit_type, commit_message, commit_date, branch, generated_at
					   FROM memories WHERE repo_id = ? AND parent_hash IS NULL${branch !== undefined ? " AND branch = ?" : ""}`,
				)
				.all(...(branch !== undefined ? [repoId, branch] : [repoId])) as Array<{
				commit_hash: string;
				tree_hash: string | null;
				commit_type: string | null;
				commit_message: string | null;
				commit_date: string | null;
				branch: string | null;
				generated_at: string | null;
			}>;
			return rows.map((r) => ({
				commitHash: r.commit_hash,
				parentCommitHash: null as null,
				...(r.tree_hash !== null ? { treeHash: r.tree_hash } : {}),
				...(r.commit_type !== null ? { commitType: r.commit_type } : {}),
				commitMessage: r.commit_message ?? "",
				commitDate: r.commit_date ?? "",
				branch: r.branch ?? "",
				generatedAt: r.generated_at ?? "",
			}));
		}, []);
	}

	/** Topic titles per root hash — the branch catalog's enrichment, one query. */
	async topicTitlesByHash(): Promise<Map<string, string[]>> {
		return this.withDbOrAbsent((db, repoId) => {
			const rows = db
				.prepare("SELECT commit_hash, title FROM memory_topics WHERE repo_id = ? ORDER BY commit_hash, pos")
				.all(repoId) as Array<{ commit_hash: string; title: string }>;
			const map = new Map<string, string[]>();
			for (const r of rows) {
				const list = map.get(r.commit_hash) ?? [];
				list.push(r.title);
				map.set(r.commit_hash, list);
			}
			return map;
		}, new Map<string, string[]>());
	}

	/** Topic-page rows for search-doc collection — no topics/*.json synthesis. */
	async listTopicSearchRows(): Promise<
		Array<{
			stableSlug: string;
			title: string;
			summary: string | null;
			content: string;
			relatedBranches: string[];
			lastUpdatedAt: string;
			refTypes: string[];
		}>
	> {
		return this.withDbOrAbsent((db, repoId) => {
			const pages = db
				.prepare(
					`SELECT stable_slug, title, summary, content_md, related_branches_json, last_updated_at
					   FROM topic_pages WHERE repo_id = ?`,
				)
				.all(repoId) as Array<{
				stable_slug: string;
				title: string;
				summary: string | null;
				content_md: string;
				related_branches_json: string;
				last_updated_at: string;
			}>;
			const refs = db
				.prepare("SELECT stable_slug, ref_type FROM topic_source_refs WHERE repo_id = ? ORDER BY pos")
				.all(repoId) as Array<{ stable_slug: string; ref_type: string }>;
			const refsBySlug = new Map<string, string[]>();
			for (const r of refs) {
				const list = refsBySlug.get(r.stable_slug) ?? [];
				list.push(r.ref_type);
				refsBySlug.set(r.stable_slug, list);
			}
			return pages.map((p) => ({
				stableSlug: p.stable_slug,
				title: p.title,
				summary: p.summary,
				content: p.content_md,
				relatedBranches: JSON.parse(p.related_branches_json) as string[],
				lastUpdatedAt: p.last_updated_at,
				refTypes: refsBySlug.get(p.stable_slug) ?? [],
			}));
		}, []);
	}

	/**
	 * Root summaries as assembled trees — the search collector's commit-doc
	 * input. The tree assembly is the same work the catalog synthesis does,
	 * but nothing here stringifies an index or catalog document around it.
	 */
	async listRootSummaries(): Promise<CommitSummary[]> {
		return this.withDbOrAbsent((db, repoId) => {
			const roots = db
				.prepare("SELECT commit_hash FROM memories WHERE repo_id = ? AND parent_hash IS NULL")
				.all(repoId) as Array<{ commit_hash: string }>;
			return roots
				.map((r) => this.readOne(db, repoId, `summaries/${r.commit_hash}.json`))
				.filter((text): text is string => text !== null)
				.map((text) => JSON.parse(text) as CommitSummary);
		}, []);
	}

	async exists(): Promise<boolean> {
		try {
			return await this.withDb(() => true);
		} catch {
			return false;
		}
	}

	async ensure(): Promise<void> {
		throw new Error("SqliteStorage cannot create its database: opening it runs the migrations already");
	}
}

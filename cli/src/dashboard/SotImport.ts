/**
 * SotImport — re-runnable import of a repo's orphan-branch memory into the
 * memory source-of-truth tables (one orphan path family per table). The DDL and
 * the reasoning behind its shape live in SotSchema.ts.
 *
 * Read side is fully injectable: every source goes through a
 * {@link StorageProvider}, defaulting to a {@link GitRefStorage} PINNED to the
 * orphan tip resolved at entry — deliberately NOT `OrphanBranchStorage` (whose
 * reads follow the movable branch name, so one import could see two versions)
 * and NOT `createStorage`/`createReadStorage` (which could return a
 * folder/dual-write provider or claim a Memory Bank folder as a side effect).
 * With an in-memory fake the importer runs without a single git subprocess;
 * for real use the only unpinned git call is the one `rev-parse`.
 *
 * Idempotency: every table is keyed on business identity, so a re-run
 * converges to the same rows. There is one row per commit and no revision
 * history — the guarded ON CONFLICT rewrites `summary_json` only when it
 * actually differs, so a converged re-run reports 0 updates instead of
 * appending a new revision. In `seed` mode converging also means *shrinking*:
 * the upserts are followed by a prune pass (`pruneTable`) that deletes the rows
 * whose source artifact is no longer on the branch. In `catch-up` mode (the
 * default) nothing is ever deleted — see {@link SotImportOptions.mode} for why
 * that asymmetry is load-bearing.
 *
 * Failure semantics: this runs in the bootstrap path (`jolli dashboard` →
 * backfill), NOT in a hook — errors propagate to the per-repo handler in
 * `dbBackfillRepos`. Individually malformed artifacts are skipped and counted,
 * never silently dropped.
 */

import { deflateSync } from "node:zlib";

import { GitRefStorage, resolveCommittish } from "../core/GitRefStorage.js";
import { readProcessedSetOrNull } from "../core/ProcessedSourceStore.js";
import { readCutoverFence } from "../core/RepoProfile.js";
import { readReferenceMarkdownFromString } from "../core/references/ReferenceStore.js";
import type { StorageProvider } from "../core/StorageProvider.js";
import { getIndex } from "../core/SummaryStore.js";
import { collectAllTranscriptHashes, resolveTranscriptIdsFiltered } from "../core/SummaryTree.js";
import { readTopicIndex } from "../core/TopicIndexStore.js";
import { listTopicPageSlugs, readTopicPage } from "../core/TopicPageStore.js";
import { createLogger, errMsg, ORPHAN_BRANCH } from "../Logger.js";
import type { CommitSummary, StoredTranscript, SummaryIndex } from "../Types.js";
import { type DashboardDbHandle, inTransaction } from "./DashboardDb.js";
import { cursorFingerprint, type ImportCursor, readImportStateRow, writeImportState } from "./ImportState.js";
import { existingWorktrees, type RegisteredRepo } from "./RepoRegistry.js";
import { REORDER_OFFSET } from "./SotSchema.js";

const log = createLogger("SotImport");

/** Rows written per family; `skipped` counts defensively-skipped artifacts (each logged). */
export interface SotImportResult {
	readonly nodes: number;
	/** Memories whose row actually changed; a converged re-run reports 0. */
	readonly updated: number;
	/** Rows in `memory_topics` — the topics INSIDE commits, not the topic KB pages. */
	readonly commitTopics: number;
	readonly aliases: number;
	readonly transcripts: number;
	readonly links: number;
	readonly docs: number;
	readonly planProgress: number;
	readonly topics: number;
	readonly skipped: number;
	/** Rows deleted because their source artifact is gone; excludes FK cascades. */
	readonly pruned: number;
}

export interface SotImportOptions {
	readonly repo: RegisteredRepo;
	/** Injectable read source; defaults to the repo's orphan branch. */
	readonly storage?: StorageProvider;
	/** Clock override for tests. */
	readonly nowMs?: number;
	/**
	 * What "the orphan branch no longer has it" is allowed to mean.
	 *
	 * `seed` — the branch is still the source of truth, so the import ends with
	 * set reconciliation: rows whose source artifact is gone are deleted.
	 *
	 * `catch-up` — pure upsert, NEVER deletes. This is the only legal mode once
	 * a repo is fenced for cutover: from that moment new memories exist ONLY in
	 * SQLite, so to a reconciliation pass they are indistinguishable from
	 * "deleted from the branch" — a re-import meant to fill a gap would silently
	 * destroy every memory written since the fence.
	 *
	 * The default is `catch-up` because the costs of a wrong guess are not
	 * symmetric: a seed that should have been a catch-up deletes data
	 * permanently, a catch-up that should have been a seed leaves stale rows a
	 * later seed removes.
	 */
	readonly mode?: "seed" | "catch-up";
	/**
	 * Rows stamped at or after this time are newer than anything this source can
	 * know, and their content is left untouched (a fenced repo's orphan tip is
	 * frozen, so every post-fence write exists ONLY in the database — without
	 * this, each catch-up pass would roll a regenerated summary, plan or
	 * transcript back to its pre-fence body). Callers importing a fenced repo
	 * pass the fence time; an unfenced import omits it and the source wins, which
	 * is the pre-cutover contract.
	 */
	readonly protectNewerThanMs?: number;
	/**
	 * Fired once per memory written, with a denominator known before the first
	 * body is read (absent only on the index-missing fallback).
	 *
	 * **The callback runs INSIDE the batch transaction and must not touch the
	 * database.** Console output is what it is for. A callback that queried
	 * would re-enter `BEGIN IMMEDIATE` on the same handle — a dirty read at
	 * best, a self-deadlock at worst — and one that throws rolls its whole batch
	 * back.
	 */
	readonly onProgress?: (progress: SotImportProgress) => void;
}

/** One memory migrated, out of however many this source has. */
export interface SotImportProgress {
	readonly done: number;
	/** Absent when `index.json` was unreadable and no denominator exists. */
	readonly total?: number;
}

const BATCH_SIZE = 200;

/** The result of an import that had no orphan branch to read — or that a cursor skipped. */
export const EMPTY_IMPORT_RESULT: SotImportResult = {
	nodes: 0,
	updated: 0,
	commitTopics: 0,
	aliases: 0,
	transcripts: 0,
	links: 0,
	docs: 0,
	planProgress: 0,
	topics: 0,
	skipped: 0,
	pruned: 0,
};

/**
 * The database-side witness that `seed` mode's reconciliation is safe to run:
 * how many of this repo's stored memories the given orphan listing does NOT
 * contain. Zero means the branch still accounts for everything; anything above
 * it means something wrote where that branch could not see, which is exactly
 * the state a prune must not run in.
 *
 * It exists because the OTHER witness — the `cutoverFence` in `profile.json` —
 * can vanish. `readRaw` fails open (a wiped or corrupt file reads as `{}`) and
 * the file is per-project gitignored state, so `git clean -xdf` removes it.
 * Losing the fence re-legalizes `seed`, whose reconciliation would then delete
 * every fence-era SQLite-only memory permanently — the branch it reconciles
 * against is frozen and will never list them again. Both callers that can pick
 * `seed` (the cutover CAS's pre-fence import and `DbBackfill`'s per-repo sweep)
 * must consult this; the sweep runs on every `jolli dashboard`, so it is the
 * one that matters most.
 *
 * Callers pass their own handle so this never opens a second connection, and
 * are expected to fail CLOSED around it: a count that could not be taken (a
 * SQLITE_BUSY from a concurrent hook write is the common one) is not evidence
 * that pruning is safe — and `0` is precisely the answer that says it is.
 */
export function countMemoriesAbsentFromListing(
	db: DashboardDbHandle,
	repoIdentity: string,
	listedHashes: ReadonlySet<string>,
): number {
	const repo = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(repoIdentity) as
		| { id: number }
		| undefined;
	if (!repo) return 0;
	const rows = db.prepare("SELECT commit_hash FROM memories WHERE repo_id = ?").all(repo.id) as Array<{
		commit_hash: string;
	}>;
	return rows.filter((r) => !listedHashes.has(r.commit_hash)).length;
}

/** True when the dashboard DB records a completed cutover for `repoIdentity`. */
export function hasCutoverRecord(db: DashboardDbHandle, repoIdentity: string): boolean {
	const repo = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(repoIdentity) as
		| { id: number }
		| undefined;
	if (!repo) return false;
	return db.prepare("SELECT 1 FROM repo_state WHERE repo_id = ? AND key = 'cutover'").get(repo.id) !== undefined;
}

/**
 * When the CAS recorded this repo's cutover, in epoch ms — the database-side
 * fallback for `protectNewerThanMs` when the fence file is gone or its stamp
 * does not parse.
 *
 * The fence file is the authority on when the freeze happened, but it is
 * per-project gitignored state that `git clean -xdf` removes, and an unparsable
 * `at` degrades the same way a missing one does. Without a fallback the import
 * runs UNPROTECTED, and catch-up does not skip a stale body — it writes it over
 * the fresh one. `committedAt` is a fraction of a second later than the fence,
 * which only ever protects slightly more, i.e. the direction that reverts least.
 *
 * Returns null when there is no record, no repo row, or the stored value does
 * not parse — callers must keep "no evidence" distinct from a timestamp.
 */
export function readCutoverCommittedAtMs(db: DashboardDbHandle, repoIdentity: string): number | null {
	const repo = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(repoIdentity) as
		| { id: number }
		| undefined;
	if (!repo) return null;
	const row = db.prepare("SELECT value FROM repo_state WHERE repo_id = ? AND key = 'cutover'").get(repo.id) as
		| { value: string }
		| undefined;
	const committedAt = tryParse<{ committedAt?: unknown }>(row?.value ?? null)?.committedAt;
	if (typeof committedAt !== "string") return null;
	const ms = Date.parse(committedAt);
	return Number.isFinite(ms) ? ms : null;
}

/**
 * The `protectNewerThanMs` an import should carry, given whatever the fence file
 * could say — `undefined` only when neither witness exists.
 *
 * Every caller that imports a possibly-frozen source has to answer this the same
 * way, and each one that answered it alone got it slightly wrong: the fence file
 * is authoritative when it parses, the CAS record is the fallback when it does
 * not (or when `profile.json` is gone), and NaN must not sneak through a `??`
 * as if it were a timestamp.
 */
export function resolveProtectNewerThanMs(
	db: DashboardDbHandle,
	repoIdentity: string,
	fenceAtMs: number | null | undefined,
): number | undefined {
	if (typeof fenceAtMs === "number" && Number.isFinite(fenceAtMs)) return fenceAtMs;
	return readCutoverCommittedAtMs(db, repoIdentity) ?? undefined;
}

/** Reads many storage paths, using the backend's batch API when it has one. */
async function readAll(storage: StorageProvider, paths: ReadonlyArray<string>): Promise<Map<string, string | null>> {
	if (storage.batchReadFiles) return storage.batchReadFiles(paths);
	const map = new Map<string, string | null>();
	for (const path of paths) map.set(path, await storage.readFile(path));
	return map;
}

/** Parses JSON, returning null (never throwing) on malformed content. */
export function tryParse<T>(content: string | null): T | null {
	if (content == null) return null;
	try {
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

interface Topology {
	readonly parent: string | null;
	readonly pos: number | null;
	readonly root: string;
	readonly depth: number;
}

/**
 * Derives each node's edge + array position. Parent edges come from
 * `index.entries[].parentCommitHash` (authoritative); `child_pos` can only
 * come from the embedded `children[]` array order — historical arrays are not
 * reliably re-sortable by date. A node whose parent has no summary file is
 * grounded as a root rather than dropped (the FK needs an existing parent row).
 *
 * Corrupt data can also describe a **cycle** (A's parent is B and B's parent is
 * A, or a node that is its own parent — a hash rewrite gone wrong, a
 * hand-edited index). Such a loop has one of its edges *cut*: the node the walk
 * closed the loop on keeps no parent at all. Reporting depth 0 for it would not
 * be enough — every edge of the loop would still be written back, so the nodes
 * would carry a `root_hash` unreachable from themselves and a child walk over
 * `parent_hash` would never terminate.
 */
function computeTopology(
	summaries: ReadonlyMap<string, CommitSummary>,
	index: SummaryIndex | null,
): Map<string, Topology> {
	const parentOf = new Map<string, string | null>();
	/**
	 * Keyed by `<listing parent>\x00<child>`, NOT by the child alone.
	 *
	 * A child hash can appear in more than one summary's `children[]` — an amend
	 * or rebase leaves the superseded tree's array listing it too — so a
	 * child-keyed map is last-writer-wins across parents, and the winner is
	 * whichever summary the iteration happened to reach last. Measured on a real
	 * branch: `92be87cb` sits at index 4 of its authoritative parent's array but
	 * index 1 of an unrelated one's, and took the 1 — colliding with the sibling
	 * that legitimately holds slot 1 and failing the whole batch on
	 * UNIQUE(repo_id, parent_hash, child_pos). Reading the position back under
	 * the parent the edge actually resolved to is what makes a stale listing
	 * inert instead of poisonous; a child its authoritative parent never listed
	 * falls through to the completion pass below, exactly as before.
	 */
	const posOf = new Map<string, number>();
	const posKey = (parent: string, child: string): string => `${parent}\x00${child}`;
	for (const entry of index?.entries ?? []) parentOf.set(entry.commitHash, entry.parentCommitHash ?? null);
	for (const [hash, summary] of summaries) {
		if (!parentOf.has(hash)) parentOf.set(hash, null);
		summary.children?.forEach((child, i) => {
			posOf.set(posKey(hash, child.commitHash), i);
			if (parentOf.get(child.commitHash) == null) parentOf.set(child.commitHash, hash);
		});
	}

	/** The recorded parent, or null when it cannot be an edge (no summary file). */
	const parentEdge = (hash: string): string | null => {
		const parent = parentOf.get(hash);
		return parent != null && summaries.has(parent) ? parent : null;
	};

	// Pass 1 — cut cycles. Each walk climbs the parent chain until it runs out of
	// edges or meets a node an earlier walk already settled; meeting a node still
	// on the *current* chain means this chain closed a loop, and that node loses
	// its parent. Iterative, so the walk cannot recurse into the loop it is
	// looking for.
	const cut = new Set<string>();
	const settled = new Set<string>();
	for (const start of summaries.keys()) {
		const chain = new Set<string>();
		let hash: string | null = start;
		while (hash != null && !settled.has(hash) && !chain.has(hash)) {
			chain.add(hash);
			hash = parentEdge(hash);
		}
		if (hash != null && chain.has(hash)) cut.add(hash);
		for (const h of chain) settled.add(h);
	}

	// Pass 2 — root + depth over the now-acyclic edges; recursion terminates
	// because pass 1 removed every loop. depth > 0 exactly when there is a
	// parent, so the two can no longer disagree.
	const resolved = new Map<string, { root: string; depth: number }>();
	const measure = (hash: string): { root: string; depth: number } => {
		const cached = resolved.get(hash);
		if (cached) return cached;
		const parent = cut.has(hash) ? null : parentEdge(hash);
		const up = parent == null ? null : measure(parent);
		const result = up == null ? { root: hash, depth: 0 } : { root: up.root, depth: up.depth + 1 };
		resolved.set(hash, result);
		return result;
	};

	const topo = new Map<string, Topology>();
	for (const hash of summaries.keys()) {
		const { root, depth } = measure(hash);
		const parent = cut.has(hash) ? null : parentEdge(hash);
		topo.set(hash, {
			parent,
			pos: parent == null ? null : (posOf.get(posKey(parent, hash)) ?? null),
			root,
			depth,
		});
	}

	// A child whose parent edge came from the index but which the parent's
	// `children[]` never listed has an edge and no position — and the schema now
	// rejects that combination outright (CHECK ((parent_hash IS NULL) = (child_pos
	// IS NULL))), because "has a parent but sits nowhere among its siblings" is not
	// a tree. The old schema tolerated it only because a NULL is distinct from
	// every other NULL in a UNIQUE index, which is not tolerance so much as an
	// absence of checking.
	//
	// Positions are therefore completed here rather than left to the engine to
	// reject: unpositioned children are appended after the highest position their
	// parent already uses, ordered by hash so a re-import lands them identically.
	// Anything else would make the import non-convergent.
	const byParent = new Map<string, string[]>();
	for (const [hash, t] of topo) {
		if (t.parent != null && t.pos == null) {
			const siblings = byParent.get(t.parent) ?? [];
			siblings.push(hash);
			byParent.set(t.parent, siblings);
		}
	}
	for (const [parent, unpositioned] of byParent) {
		let next = 0;
		for (const [, t] of topo) if (t.parent === parent && t.pos != null) next = Math.max(next, t.pos + 1);
		for (const hash of unpositioned.sort()) {
			const t = topo.get(hash) as Topology;
			topo.set(hash, { ...t, pos: next++ });
		}
	}
	return topo;
}

/** One tree's span in {@link Skeleton.ordered}, as a half-open index range. */
interface TreeSpan {
	readonly start: number;
	readonly end: number;
}

interface Skeleton {
	/** Every listed hash, trees contiguous, depth-ascending within each tree. */
	readonly ordered: ReadonlyArray<string>;
	readonly trees: ReadonlyArray<TreeSpan>;
}

/**
 * Derives the WRITE ORDER (and therefore the denominator) from `index.json`
 * plus the summaries listing alone — without reading a single summary body.
 *
 * That is the whole point: the bodies are thousands of git objects and the
 * longest part of the import, so anything that needs to be known up front —
 * how many memories there are, what order they go in, where a resume cursor
 * points — has to come from somewhere cheaper. Parent edges live in
 * `index.entries[].parentCommitHash`, which is one file.
 *
 * Two properties the rest of the import depends on:
 *
 * - **Trees are contiguous, and depth ascends within a tree.** The
 *   self-referential FK needs parents written before children, and grouping
 *   whole trees is what lets each batch call the unchanged
 *   {@link computeTopology} on just its own summaries: every parent of a node
 *   in the batch is also in the batch, so batch-local topology and global
 *   topology agree. Splitting a tree across batches would silently ground its
 *   lower half.
 * - **The order is a pure function of the listing and the index.** Roots sort
 *   by hash, nodes within a tree by (depth, hash). A re-run over the same
 *   inputs produces the same sequence, which is what makes a cursor into it
 *   meaningful at all.
 *
 * Edges use the LISTING (`liveNodes`), not the parsed set, because parsing has
 * not happened yet. A parent that is listed but whose body turns out to be
 * unreadable therefore appears here as a real edge; `computeTopology` grounds
 * it per-batch exactly as it does today, which is why the two can disagree
 * without consequence — this function decides order, not shape.
 */
export function computeSkeleton(liveNodes: ReadonlySet<string>, index: SummaryIndex | null): Skeleton {
	const parentOf = new Map<string, string | null>();
	for (const hash of liveNodes) parentOf.set(hash, null);
	for (const entry of index?.entries ?? []) {
		if (!liveNodes.has(entry.commitHash)) continue;
		const parent = entry.parentCommitHash ?? null;
		parentOf.set(entry.commitHash, parent != null && liveNodes.has(parent) ? parent : null);
	}

	// Cycle cut, same shape as computeTopology's pass 1: a walk that meets a node
	// still on its own chain has closed a loop, and that node loses its parent.
	// Without it `measure` below would recurse forever on hand-edited data.
	const cut = new Set<string>();
	const settled = new Set<string>();
	for (const start of liveNodes) {
		const chain = new Set<string>();
		let hash: string | null = start;
		while (hash != null && !settled.has(hash) && !chain.has(hash)) {
			chain.add(hash);
			hash = parentOf.get(hash) ?? null;
		}
		if (hash != null && chain.has(hash)) cut.add(hash);
		for (const h of chain) settled.add(h);
	}

	const resolved = new Map<string, { root: string; depth: number }>();
	const measure = (hash: string): { root: string; depth: number } => {
		const cached = resolved.get(hash);
		if (cached) return cached;
		const parent = cut.has(hash) ? null : (parentOf.get(hash) ?? null);
		const up = parent == null ? null : measure(parent);
		const result = up == null ? { root: hash, depth: 0 } : { root: up.root, depth: up.depth + 1 };
		resolved.set(hash, result);
		return result;
	};

	const byRoot = new Map<string, Array<{ hash: string; depth: number }>>();
	for (const hash of liveNodes) {
		const { root, depth } = measure(hash);
		const bucket = byRoot.get(root) ?? [];
		bucket.push({ hash, depth });
		byRoot.set(root, bucket);
	}

	const ordered: string[] = [];
	const trees: TreeSpan[] = [];
	for (const root of [...byRoot.keys()].sort()) {
		const nodes = (byRoot.get(root) as Array<{ hash: string; depth: number }>).sort(
			(a, b) => a.depth - b.depth || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0),
		);
		trees.push({ start: ordered.length, end: ordered.length + nodes.length });
		for (const node of nodes) ordered.push(node.hash);
	}
	return { ordered, trees };
}

/**
 * Groups whole trees into batches of at least {@link BATCH_SIZE} nodes.
 *
 * A batch is the transaction and cursor unit; a tree is never split (see
 * {@link computeSkeleton}). One pathologically large tree simply becomes one
 * oversized batch — correct, and the shape the data does not actually take
 * (a tree is a commit plus its amends).
 */
export function planBatches(trees: ReadonlyArray<TreeSpan>, batchSize: number = BATCH_SIZE): ReadonlyArray<TreeSpan> {
	const batches: TreeSpan[] = [];
	let start: number | null = null;
	let end = 0;
	for (const tree of trees) {
		if (start === null) start = tree.start;
		end = tree.end;
		if (end - start >= batchSize) {
			batches.push({ start, end });
			start = null;
		}
	}
	if (start !== null) batches.push({ start, end });
	return batches;
}

/** `<key>-<hash8>` → `{ branch, original }` via the summary index; nulls when unmatched. */
function branchFromKeySuffix(
	key: string,
	index: SummaryIndex | null,
): { branch: string | null; original: string | null } {
	const match = /-([0-9a-f]{8})$/.exec(key);
	if (!match) return { branch: null, original: null };
	const entry = index?.entries.find((e) => e.commitHash.startsWith(match[1]));
	if (!entry) return { branch: null, original: null };
	return { branch: entry.branch ?? null, original: key.slice(0, -(match[1].length + 1)) };
}

/** First `# heading` of a markdown body, as the display title. */
export function markdownTitle(body: string): string | null {
	const match = /^#\s+(.+)$/m.exec(body);
	return match ? match[1].trim() : null;
}

/** Runs `fn` over `items` in chunks, each chunk inside one IMMEDIATE transaction. */
/**
 * The six numeric projections that pass through a `json_type` gate in the
 * schema, paired with the JSON types the gate accepts.
 *
 * Kept beside the reporter rather than inside it so the list reads as a mirror
 * of the DDL: if a seventh numeric generated column is added there, this is the
 * line that has to grow with it or the degradation goes back to being silent.
 */
const GATED_NUMERICS: ReadonlyArray<{ path: readonly string[]; accepts: "integer" | "number" }> = [
	// `accepts` mirrors the json_type() test in the DDL exactly: the INTEGER
	// columns gate on 'integer', so a whole-valued float (12.0) is gated too —
	// JSON cannot distinguish it and neither can the gate. est_cost_usd is REAL
	// and gates on ('integer','real'), so any number passes.
	{ path: ["conversationTurns"], accepts: "integer" },
	{ path: ["conversationTokens"], accepts: "integer" },
	{ path: ["estimatedCostUsd"], accepts: "number" },
	{ path: ["diffStats", "filesChanged"], accepts: "integer" },
	{ path: ["diffStats", "insertions"], accepts: "integer" },
	{ path: ["diffStats", "deletions"], accepts: "integer" },
];

/**
 * Counts and logs every value the schema's type gate will turn into NULL.
 *
 * The gate exists because a VIRTUAL generated column is NOT type-checked by
 * STRICT: an INTEGER-declared column would otherwise hand back the REAL or TEXT
 * it found in the JSON, and SUM / ORDER BY / the JS side would all see mixed
 * types with nothing reporting it. Degrading to NULL is the right behaviour —
 * the pages already handle a missing field — but a silent degradation is still a
 * silent downgrade, so it is counted here on the same footing as a skipped file.
 *
 * Integers specifically: the gate accepts `json_type = 'integer'`, so a float
 * that happens to be whole (12.0) is also gated. That is deliberate — JSON does
 * not distinguish them and neither can the gate.
 */
export function reportOffTypeNumerics(
	summary: CommitSummary,
	hash: string,
	skip: (what: string, detail: string) => void,
): void {
	for (const { path, accepts } of GATED_NUMERICS) {
		let value: unknown = summary;
		for (const key of path) {
			if (value == null || typeof value !== "object") {
				value = undefined;
				break;
			}
			value = (value as Record<string, unknown>)[key];
		}
		// Absent is not off-type: the column is NULL either way and the pages treat
		// the two identically. Only a present-but-wrong value is worth a line.
		if (value === undefined || value === null) continue;
		const passes = accepts === "integer" ? Number.isInteger(value) : typeof value === "number";
		if (passes) continue;
		skip(
			"off-type numeric",
			`${hash}.${path.join(".")} is ${typeof value} (${JSON.stringify(value)}) — column reads NULL`,
		);
	}
}

/**
 * Resolves `memories.commit_date_ms`, which is NOT NULL yet derived from an
 * optional field.
 *
 * The type gate covers type, not presence: a summary with no `commitDate` does
 * not produce a NULL column, it fails the whole row — and a failed write is a
 * permanently lost summary because the queue entry is deleted fire-and-forget.
 * So the fallback chain is explicit and logged rather than left to `|| 0`, which
 * is what the previous importer did (a 1970 timestamp sorts a memory to the
 * beginning of every by-date view forever, which is worse than being loud).
 *
 * Git commit time — the middle rung the plan specifies — is not available at
 * this layer: the importer reads the orphan branch through a StorageProvider and
 * has no commit object for the hash. Rather than spawn a `git show` per memory
 * on the import path, this falls through to `first_seen_ms` and says so. Wiring
 * the git rung belongs with the importer that already holds commit metadata.
 */
export function commitDateMs(
	summary: CommitSummary,
	hash: string,
	nowMs: number,
	skip: (what: string, detail: string) => void,
): number {
	const parsed = Date.parse(summary.commitDate ?? "");
	if (Number.isFinite(parsed)) return parsed;
	skip("commit date", `${hash} has no parsable commitDate — falling back to first-seen time`);
	return nowMs;
}

function inChunkedTransactions<T>(db: DashboardDbHandle, items: ReadonlyArray<T>, fn: (item: T) => void): void {
	for (let start = 0; start < items.length; start += BATCH_SIZE) {
		const chunk = items.slice(start, start + BATCH_SIZE);
		inTransaction(db, () => {
			db.exec("PRAGMA defer_foreign_keys = ON");
			for (const item of chunk) fn(item);
		});
	}
}

/** Business-key separator: NUL occurs in no hash, slug, doc key or kind. */
const KEY_SEP = "\u0000";

/** Joins a composite business key into one comparable string. */
const keyOf = (...parts: ReadonlyArray<string>): string => parts.join(KEY_SEP);

/**
 * Deletes every row of `table` for this repo whose business key is absent from
 * `live`, returning how many rows it removed directly (FK cascades ride along
 * uncounted). This is the delete half of set reconciliation — the same model
 * `DbBackfill.pruneUnreachableCommits` applies to the derived commit tier.
 *
 * `live` must be built from what the branch *lists*, never from what parsed
 * successfully: a present-but-malformed artifact is skipped by the import, and
 * pruning on the parsed set would turn one bad parse into permanent data loss.
 *
 * `table` / `keyCols` are interpolated into SQL — every call site passes
 * literals from this file, never a value read off the branch.
 */
function pruneTable(
	db: DashboardDbHandle,
	table: string,
	keyCols: ReadonlyArray<string>,
	repoId: number,
	live: ReadonlySet<string>,
): number {
	const rows = db
		.prepare(`SELECT ${keyCols.join(", ")} FROM ${table} WHERE repo_id = ?`)
		.all(repoId) as ReadonlyArray<Record<string, string>>;
	const stale = rows.filter((row) => !live.has(keyOf(...keyCols.map((col) => row[col]))));
	if (stale.length === 0) return 0;
	const remove = db.prepare(
		`DELETE FROM ${table} WHERE repo_id = ? AND ${keyCols.map((col) => `${col} = ?`).join(" AND ")}`,
	);
	inChunkedTransactions(db, stale, (row) => {
		remove.run(repoId, ...keyCols.map((col) => row[col]));
	});
	log.debug("pruned %d stale row(s) from %s", stale.length, table);
	return stale.length;
}

/**
 * Recomputes root_hash/depth for every row of the repo from the stored edges.
 * Shared by the live write path (every batch) and the import (seed's reground
 * leaves flattened rows, catch-up uses it to heal them) — the two must agree on
 * what "settled" means or the rootTopology inspection query flags one of them.
 */
export function remountRepo(db: DashboardDbHandle, repoId: number): void {
	const rows = db
		.prepare("SELECT commit_hash, parent_hash, root_hash, depth FROM memories WHERE repo_id = ?")
		.all(repoId) as Array<{ commit_hash: string; parent_hash: string | null; root_hash: string; depth: number }>;
	const children = new Map<string, string[]>();
	const queue: Array<{ hash: string; root: string; depth: number }> = [];
	for (const r of rows) {
		if (r.parent_hash === null) queue.push({ hash: r.commit_hash, root: r.commit_hash, depth: 0 });
		else {
			const siblings = children.get(r.parent_hash) ?? [];
			siblings.push(r.commit_hash);
			children.set(r.parent_hash, siblings);
		}
	}
	const update = db.prepare("UPDATE memories SET root_hash = ?, depth = ? WHERE repo_id = ? AND commit_hash = ?");
	const byHash = new Map(rows.map((r) => [r.commit_hash, r]));
	let visited = 0;
	while (queue.length > 0) {
		const { hash, root, depth } = queue.shift() as { hash: string; root: string; depth: number };
		visited++;
		const row = byHash.get(hash) as { root_hash: string; depth: number };
		if (row.root_hash !== root || row.depth !== depth) update.run(root, depth, repoId, hash);
		for (const child of children.get(hash) ?? []) queue.push({ hash: child, root, depth: depth + 1 });
	}
	// Anything unreachable from a root is a cycle among the claimed edges —
	// corrupt input, and letting it land would defeat the depth invariant the
	// inspection queries rely on. Throwing rolls back the whole batch.
	if (visited !== rows.length) {
		throw new Error(`remountRepo: ${rows.length - visited} node(s) unreachable from any root — cycle in batch`);
	}
}

/**
 * Imports one repo's orphan-branch memory into the SOT tables. Safe to re-run;
 * writes the `repo_state key='orphan-import'` marker on completion.
 */
export async function importRepoMemory(db: DashboardDbHandle, opts: SotImportOptions): Promise<SotImportResult> {
	// Seed and protect are mutually exclusive by MEANING, and the check belongs
	// here rather than as a guard inside `writeMemorySeed`. Protect exists for a
	// FROZEN source: rows the database stamped after the freeze outrank anything
	// the import can read back. A seed reconciles against the source as the whole
	// truth — pruning rows it does not list — so a seed that is also protecting
	// rows is asking for two contradictory things. Today's callers derive
	// `seedLegal` from the same fence witnesses that leave `protectNewerThanMs`
	// unset, but nothing in the option type says so, and the failure would be
	// silent: `writeMemorySeed` overwrites unconditionally, rolling a post-fence
	// regenerated summary back to its pre-fence body with a frozen branch as the
	// only place to recover it from.
	if (opts.mode === "seed" && opts.protectNewerThanMs !== undefined) {
		throw new Error(
			"importRepoMemory: seed mode implies an unfrozen source — protectNewerThanMs is not applicable",
		);
	}
	try {
		return await runRepoImport(db, opts);
	} catch (err) {
		// Recorded HERE and not in `dbBackfillRepos`' per-repo catch: by the time the
		// error reaches that handler `withDashboardDb` has closed the connection,
		// so the only place a failure can still be written down is inside the
		// import. Rethrown unchanged — this marks, it does not swallow.
		markImportFailed(db, opts.repo.repoIdentity, errMsg(err));
		throw err;
	}
}

/**
 * Best-effort `state: "failed"` stamp, preserving whatever cursor the last
 * committed batch left so the next run still resumes from it.
 *
 * Every step is guarded: the reason this is being called at all is that
 * something went wrong, and a database that is gone or locked must not turn a
 * useful error into a confusing one from the error handler.
 */
function markImportFailed(db: DashboardDbHandle, repoIdentity: string, error: string): void {
	try {
		const row = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(repoIdentity) as
			| { id: number }
			| undefined;
		if (!row) return;
		const prior = readImportStateRow(db, row.id) ?? {};
		inTransaction(db, () => writeImportState(db, row.id, { ...prior, state: "failed", error }));
		/* v8 ignore next 3 -- the handle is already gone or locked; there is nowhere left to record anything */
	} catch (err) {
		log.debug("could not record import failure for %s: %s", repoIdentity, errMsg(err));
	}
}

async function runRepoImport(db: DashboardDbHandle, opts: SotImportOptions): Promise<SotImportResult> {
	const { repo } = opts;
	const cwd = existingWorktrees(repo)[0];
	const nowMs = opts.nowMs ?? Date.now();
	/**
	 * Live clock for the heartbeat ONLY. Every stored timestamp uses the frozen
	 * `nowMs` on purpose (one import, one stamp), but the heartbeat's whole job is
	 * to prove this process is still moving — stamping it with the entry-time
	 * constant meant `heartbeatAt` never advanced, so `ImportState`'s
	 * `IMPORT_STALE_MS` fired on every import that ran longer than 10 minutes and
	 * `jolli status` reported a healthy run as abandoned. An explicit `opts.nowMs`
	 * still pins it, so tests stay deterministic.
	 */
	const heartbeatNow = (): number => opts.nowMs ?? Date.now();
	const mode = opts.mode ?? "catch-up";
	let storage = opts.storage;
	if (!storage) {
		const tip = await resolveCommittish(ORPHAN_BRANCH, cwd);
		if (!tip) {
			// No orphan tip means nothing to import FROM — and nothing to prune:
			// destroying rows because a branch is missing would make an accidental
			// branch deletion permanent. An empty result is the honest answer.
			log.info("orphan import for %s skipped: %s does not resolve", repo.repoIdentity, ORPHAN_BRANCH);
			return EMPTY_IMPORT_RESULT;
		}
		storage = new GitRefStorage(tip, cwd);
	}
	// Skips are counted per kind and reported ONCE at the end. Per-item logging
	// stays at debug: a summary naming a transcript file that no longer exists is
	// an ordinary state of an older repo (that commit had no AI session, or the
	// file was pruned), not a fault — one repo here produces 640 of them, and at
	// warn level they would bury the command's own output.
	const skips = new Map<string, number>();
	const skip = (what: string, detail: string): void => {
		skips.set(what, (skips.get(what) ?? 0) + 1);
		log.debug("import %s: skipping %s (%s)", repo.repoIdentity, what, detail);
	};

	// ── repo row + worktrees ───────────────────────────────────────────────
	db.prepare(
		`INSERT INTO repos (repo_identity, repo_name, worktree_root, remote_url, enabled_at)
		 VALUES (?, ?, ?, ?, ?) ON CONFLICT(repo_identity) DO NOTHING`,
	).run(repo.repoIdentity, repo.repoName, repo.worktreeRoot, repo.remoteUrl ?? null, repo.enabledAt);
	const repoRow = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(repo.repoIdentity) as { id: number };
	const repoId = repoRow.id;
	// No repo_worktrees table: nothing queried it, and the authoritative list of
	// checkouts is the registry FILE, which has to live outside the database
	// because recovery needs to know which checkouts to read when the DB is gone.

	// `running` goes down here, before the first orphan read, which is the
	// earliest moment it can: the FK needs the repo row above, and everything
	// after this point is slow. A previous run's cursor is preserved (the resume
	// below decides whether it still applies), but `startedAt` and `pid` are
	// restamped unconditionally — inheriting a crashed run's dead pid would make
	// this live process report itself as interrupted.
	const runStartedAt = nowMs;
	const carriedCursor = readImportStateRow(db, repoId)?.cursor;
	inTransaction(db, () =>
		writeImportState(db, repoId, {
			state: "running",
			startedAt: runStartedAt,
			heartbeatAt: nowMs,
			pid: process.pid,
			done: 0,
			...(carriedCursor ? { cursor: carriedCursor } : {}),
		}),
	);

	// ── read the orphan branch ─────────────────────────────────────────────
	const index = await getIndex(cwd, storage);
	const summaryPaths = (await storage.listFiles("summaries/")).filter((p) => p.endsWith(".json"));
	// Every prune set below is the FILE listing, not the parsed subset — see
	// `pruneTable`.
	const liveNodes = new Set(summaryPaths.map((p) => p.slice("summaries/".length, -".json".length)));
	// tree_hash rides on the index entry, not the summary file (measured
	// 313/313 absent there) — copy it off or alias scanning loses its match key.
	const treeHashOf = new Map((index?.entries ?? []).map((e) => [e.commitHash, e.treeHash ?? null]));
	// Same story as `treeHash`, for the same reason: legacy (pre-v4) summaries
	// carry their root diff stats ONLY on the index entry, and the rebuilt index
	// reads the summary body — so without copying this off, every legacy root
	// loses its diff badge and stops matching the file the branch carried. Null
	// for v4-and-later entries, whose body is authoritative.
	const indexDiffStatsOf = new Map(
		(index?.entries ?? []).map((e) => [e.commitHash, e.diffStats ? JSON.stringify(e.diffStats) : null]),
	);

	// The order, the denominator and the tree boundaries — all from the index
	// and the listing, before a single body is read. Bodies are read one batch
	// at a time inside the loop below, which is what gives this import a
	// meaningful "N of M" and a cursor to resume from.
	//
	// A null index means no parent edges are knowable, so every node would be
	// its own tree at depth 0 — which is not the shape the seed path's reorder
	// and remount expect, and would silently flatten an existing hierarchy. So
	// a repo whose index.json is missing or unreadable falls back to reading
	// everything at once, exactly as this importer always did: no cursor, no
	// denominator, but no behaviour change either.
	const skeleton = index ? computeSkeleton(liveNodes, index) : null;
	const ordered = skeleton ? skeleton.ordered : [...liveNodes].sort();
	const fingerprint = skeleton ? cursorFingerprint(ordered) : null;

	// ── memories (trees in order, parents before children) ─────────────────
	let nodes = 0;
	let updated = 0;
	let commitTopics = 0;
	const protect = opts.protectNewerThanMs;
	/** Source nodes whose stored row post-dates `protect` — their links stay untouched too. */
	const protectedHashes = new Set<string>();
	/**
	 * What `written_at_ms` records for rows THIS import writes.
	 *
	 * A protected import copies bytes from a source that is, by definition,
	 * older than the fence — so stamping them with the wall clock claims they
	 * are post-fence live writes and makes the guard below protect the
	 * importer's own output. That is not hypothetical: `runCutover` derives the
	 * fence time and every import stamp from ONE `nowMs`, so a retry found every
	 * attempt-0 row at exactly `protect`, `>=` held, catch-up updated nothing,
	 * and the containment compare that the retry exists to satisfy could never
	 * pass — the repo stayed `legacy-fenced` forever. DbBackfill and recovery hit
	 * the same wall one pass later, with the wall clock landing past a fence
	 * parsed off disk.
	 *
	 * Clamping to just before the fence keeps the guard's `>=` semantics intact
	 * (a genuine post-fence write still outranks this source) while making
	 * "this row came from the frozen source" and "this row was written live
	 * after the freeze" distinguishable, which is the only thing the guard
	 * actually needs to decide. `first_seen_ms` is deliberately NOT clamped: it
	 * answers when the row entered the database, not how current its body is.
	 *
	 * EVERY family that has a protect guard must stamp with this, not with
	 * `nowMs` — memories, transcripts, context (both `created_at_ms` and
	 * `updated_at_ms`, since the guard COALESCEs them) and plan_progress. The
	 * clamp originally landed on memories alone, which left the other three
	 * protecting their own output and made drift recovery unable to import a
	 * changed plan, note, reference, skill or transcript for the life of the
	 * repo. A new guarded family is a new call site for `stampMs`.
	 */
	const stampMs = protect !== undefined ? Math.min(nowMs, protect - 1) : nowMs;

	// `children` is emptied IN PLACE, never stripped. Removing the key and
	// appending it back at reassembly time reorders the JSON, and the
	// byte-for-byte equivalence check does not permit that difference — in real
	// files the key sits between `diffStats` and `transcripts`, not last. An
	// object spread overwrites an existing key without moving it, so this
	// preserves key order; a summary that has no `children` key must not gain
	// one, hence the `in` test rather than an unconditional spread.
	const summaryJsonOf = (summary: CommitSummary): string =>
		JSON.stringify("children" in summary ? { ...summary, children: [] } : summary);

	// Topics are projected as a whole group, never patched row by row: `pos` is
	// UNIQUE within the commit, so shifting positions in place would collide the
	// same way sibling reordering does. Replacing the set is also what makes a
	// regenerated summary with FEWER topics converge — an upsert alone would
	// leave the surplus rows behind forever.
	const writeTopics = (hash: string, summary: CommitSummary): void => {
		db.prepare("DELETE FROM memory_topics WHERE repo_id = ? AND commit_hash = ?").run(repoId, hash);
		const insertTopic = db.prepare(
			"INSERT INTO memory_topics (repo_id, commit_hash, pos, category, importance, title) VALUES (?, ?, ?, ?, ?, ?)",
		);
		(summary.topics ?? []).forEach((topic, pos) => {
			// A topic with no title is not displayable and not groupable; the column is
			// NOT NULL rather than storing a blank that every reader has to special-case.
			if (!topic.title) {
				skip("topic", `${hash}[${pos}] has no title`);
				return;
			}
			insertTopic.run(repoId, hash, pos, topic.category ?? null, topic.importance ?? null, topic.title);
			commitTopics++;
		});
	};

	// ── the two per-memory writers ─────────────────────────────────────────
	// Extracted verbatim from the whole-set passes they used to be. The batch
	// driver below calls them one memory at a time; nothing about HOW a row is
	// written changed, only WHEN.
	const seedPhase1 = (): void => {
		// Phase 1 of the two-phase reorder: shift every existing position into the
		// offset region so a re-imported shuffle cannot transiently collide with
		// UNIQUE(repo_id, parent_hash, child_pos) — that constraint is checked row by
		// row, so swapping two siblings in one pass always collides.
		//
		// The offset is what makes this legal; parking the positions at NULL (which is
		// what this did before the shape constraints existed) now violates
		// CHECK ((parent_hash IS NULL) = (child_pos IS NULL)) on the very first
		// re-import, because the parent edge stays put while the position goes away.
		// Negative temporaries fail the `child_pos >= 0` check for the same reason.
		// Shifting up keeps every invariant true for the whole transaction.
		//
		// Rows left in the offset region are what inspection query 2 looks for, so a
		// crash between the phases is detectable rather than silent.
		//
		// Seed-only: the branch is the source of truth here, so re-imposing its
		// arrangement on every stored row is the point. Catch-up must NOT do this —
		// on a fenced repo the stored tree is NEWER than the frozen branch, and a
		// global shift would tear every SQLite-only child out of its tree (the
		// settle pass below can never reach a node the branch has no file for).
		//
		// `child_pos < REORDER_OFFSET` bounds the shift to rows still at ground
		// level, so a row left parked by a crashed run cannot be pushed to 2·OFFSET
		// and trip CHECK (child_pos < 2000000) on the next pass. Same guard the
		// live-write path has carried from the start (SotWrite).
		//
		// NOT idempotent — a second pass reaches 2·OFFSET — which is why the cursor
		// records that it ran (`phase1Done`) in the very same transaction.
		db.prepare(`UPDATE memories SET child_pos = child_pos + ${REORDER_OFFSET}
		            WHERE repo_id = ? AND child_pos IS NOT NULL AND child_pos < ${REORDER_OFFSET}`).run(repoId);
	};

	/** Empties the offset region by grounding whatever the settle pass never reached. */
	const groundOffsetResidue = (): void => {
		db.prepare(
			`UPDATE memories SET parent_hash = NULL, child_pos = NULL
			  WHERE repo_id = ? AND child_pos >= ${REORDER_OFFSET}`,
		).run(repoId);
	};

	/**
	 * Empties the offset region by UNDOING the shift — the catch-up counterpart
	 * of {@link groundOffsetResidue}.
	 *
	 * Both modes have to leave the region empty (the next seed's shift is bounded
	 * by `child_pos < REORDER_OFFSET`, and inspection query 2 reads a non-empty
	 * region as "a run crashed mid-reorder"), but they must empty it differently,
	 * because what the residue MEANS differs:
	 *
	 * - After seed's settle pass, a parked row is one the branch has no readable
	 *   `summaries/<hash>.json` for. Grounding it is right, and the prune removes
	 *   the unlisted ones moments later.
	 * - In catch-up the residue is whatever a CRASHED seed left behind, and this
	 *   runs before any write. Grounding there destroyed the tree: `seedPhase1`
	 *   only ever adds to `child_pos` and never touches `parent_hash`, so the
	 *   parked rows still had perfectly good edges — and catch-up's existing-row
	 *   branch updates only the body columns, so it can never mount them again.
	 *   The `damaged` self-heal then finished the job by remounting them as
	 *   legitimate depth-0 roots. Every amend/squash chain in the repo became a
	 *   set of independent roots, `children[]` came back empty, and on a fenced
	 *   repo nothing could ever put them back (the branch a later seed would
	 *   re-impose is frozen, and post-cutover children were never on it at all).
	 *
	 * The shift is pure addition, so subtracting it restores the exact pre-shift
	 * state. Ordering makes it safe: this runs before the batches, so the mount
	 * path below sees the restored rows and its "slot is taken" branch appends
	 * around them rather than colliding.
	 */
	const unshiftOffsetResidue = (): void => {
		db.prepare(
			`UPDATE memories SET child_pos = child_pos - ${REORDER_OFFSET}
			  WHERE repo_id = ? AND child_pos >= ${REORDER_OFFSET}`,
		).run(repoId);
	};

	const writeMemorySeed = (hash: string, summary: CommitSummary, topo: Topology): void => {
		const summaryJson = summaryJsonOf(summary);
		// Whether the CONTENT changed, decided before the write. It cannot be read
		// off the upsert's `changes` count: phase 1 shifted every position into the
		// offset region, so the settle write always touches the row and `changes`
		// would report a content change on every converged re-run. One PK lookup is
		// the same cost the previous revision-max query paid.
		const prior = db
			.prepare("SELECT summary_json FROM memories WHERE repo_id = ? AND commit_hash = ?")
			.get(repoId, hash) as { summary_json: string } | undefined;
		const contentChanged = prior?.summary_json !== summaryJson;
		db.prepare(
			`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
			                       summary_json, tree_hash, index_diff_stats_json,
			                       first_seen_ms, written_at_ms, commit_date_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(repo_id, commit_hash) DO UPDATE SET
			   parent_hash = excluded.parent_hash, child_pos = excluded.child_pos,
			   root_hash = excluded.root_hash, depth = excluded.depth,
			   summary_json = excluded.summary_json, tree_hash = excluded.tree_hash,
			   -- COALESCE, not overwrite: an index that has since been rewritten
			   -- without the legacy stats must not erase what an earlier import
			   -- captured. The body always wins at read time anyway.
			   index_diff_stats_json = COALESCE(excluded.index_diff_stats_json, memories.index_diff_stats_json),
			   written_at_ms = excluded.written_at_ms,
			   commit_date_ms = excluded.commit_date_ms`,
		).run(
			repoId,
			hash,
			topo.parent,
			topo.pos,
			topo.root,
			topo.depth,
			summaryJson,
			treeHashOf.get(hash) ?? null,
			indexDiffStatsOf.get(hash) ?? null,
			// first_seen_ms is INSERT-only: the ON CONFLICT clause above never
			// touches it. It records when this memory first entered the database,
			// and a re-import overwriting it loses that permanently.
			nowMs,
			stampMs,
			commitDateMs(summary, hash, nowMs, skip),
		);
		nodes++;
		if (contentChanged) updated++;
		reportOffTypeNumerics(summary, hash, skip);
		writeTopics(hash, summary);
	};

	const writeMemoryCatchUp = (hash: string, summary: CommitSummary, topo: Topology): void => {
		const summaryJson = summaryJsonOf(summary);
		const existing = db
			.prepare("SELECT summary_json, written_at_ms FROM memories WHERE repo_id = ? AND commit_hash = ?")
			.get(repoId, hash) as { summary_json: string; written_at_ms: number } | undefined;
		if (existing) {
			// Rows stamped after the fence were written by the post-cutover live
			// path — this source predates them, so even their CONTENT must not be
			// rolled back (a regenerated summary would otherwise revert on every
			// dashboard pass, forever).
			if (protect !== undefined && existing.written_at_ms >= protect) {
				protectedHashes.add(hash);
				// Counted before the early return. `nodes` is what the command reports
				// as "memories migrated", and a protected row IS present and correct in
				// the database — skipping it made a fenced repo of 700 memories report
				// 312, which reads as data loss to the one person checking.
				nodes++;
				return;
			}
			nodes++;
			if (existing.summary_json === summaryJson) return;
			updated++;
			db.prepare(
				`UPDATE memories SET summary_json = ?, tree_hash = COALESCE(?, tree_hash),
				   index_diff_stats_json = COALESCE(?, index_diff_stats_json),
				   written_at_ms = ?, commit_date_ms = ?
				 WHERE repo_id = ? AND commit_hash = ?`,
			).run(
				summaryJson,
				treeHashOf.get(hash) ?? null,
				indexDiffStatsOf.get(hash) ?? null,
				stampMs,
				commitDateMs(summary, hash, nowMs, skip),
				repoId,
				hash,
			);
			reportOffTypeNumerics(summary, hash, skip);
			writeTopics(hash, summary);
			return;
		}
		// A node this source knows and the database lacks (gap fill after a
		// restore, or a fenced repo whose pre-fence import was incomplete). The
		// mount derives from the STORED parent row; `ordered` guarantees a parent
		// that is itself a source node was inserted first.
		const mount = ((): { parent: string | null; pos: number | null; root: string; depth: number } => {
			if (topo.parent === null) return { parent: null, pos: null, root: hash, depth: 0 };
			const parentRow = db
				.prepare("SELECT root_hash, depth FROM memories WHERE repo_id = ? AND commit_hash = ?")
				.get(repoId, topo.parent) as { root_hash: string; depth: number } | undefined;
			if (!parentRow) {
				// Same grounding computeTopology applies to a parent with no summary
				// file: an edge to a row that does not exist cannot be stored (self-FK).
				skip("mount", `${hash} → ${topo.parent} (parent row missing — grounded as root)`);
				return { parent: null, pos: null, root: hash, depth: 0 };
			}
			// The slot this source recorded may since have been taken by a stored
			// rearrangement; appending after the last ground-level sibling keeps
			// both rows without disturbing the stored order.
			let pos = topo.pos as number;
			const taken = db
				.prepare("SELECT 1 AS ok FROM memories WHERE repo_id = ? AND parent_hash = ? AND child_pos = ?")
				.get(repoId, topo.parent, pos) as { ok?: number } | undefined;
			if (taken) {
				const max = db
					.prepare(
						`SELECT MAX(child_pos) AS m FROM memories
						  WHERE repo_id = ? AND parent_hash = ? AND child_pos < ${REORDER_OFFSET}`,
					)
					.get(repoId, topo.parent) as { m: number | null };
				pos = (max.m ?? -1) + 1;
				skip("mount", `${hash} position ${topo.pos} under ${topo.parent} is taken — appended at ${pos}`);
			}
			return { parent: topo.parent, pos, root: parentRow.root_hash, depth: parentRow.depth + 1 };
		})();
		db.prepare(
			`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
			                       summary_json, tree_hash, index_diff_stats_json,
			                       first_seen_ms, written_at_ms, commit_date_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			repoId,
			hash,
			mount.parent,
			mount.pos,
			mount.root,
			mount.depth,
			summaryJson,
			treeHashOf.get(hash) ?? null,
			indexDiffStatsOf.get(hash) ?? null,
			nowMs,
			stampMs,
			commitDateMs(summary, hash, nowMs, skip),
		);
		nodes++;
		updated++;
		reportOffTypeNumerics(summary, hash, skip);
		writeTopics(hash, summary);
	};

	// ── transcripts + links, written inside each memory's slice ────────────
	const transcriptPaths = (await storage.listFiles("transcripts/")).filter((p) => p.endsWith(".json"));
	const liveTranscripts = new Set(transcriptPaths.map((p) => p.slice("transcripts/".length, -".json".length)));
	/**
	 * Transcripts this run has written a row for — and therefore the ONLY legal
	 * link targets.
	 *
	 * Not `liveTranscripts`: the listing says a file exists, which is a weaker
	 * claim than "it parsed". A transcript whose JSON is malformed is skipped and
	 * never gets a row, so a link to it would fail the FK and take the whole
	 * batch down with it. The parsed-only distinction is exactly what the old
	 * whole-set `transcriptIds` encoded; this set is its per-slice equivalent.
	 */
	const writtenTranscripts = new Set<string>();
	/** Every id any summary pointed at, so the tail knows which files nobody claimed. */
	const claimedTranscripts = new Set<string>();
	let transcripts = 0;

	const writeTranscript = (id: string, content: string | null): void => {
		const parsed = tryParse<StoredTranscript>(content);
		if (!parsed || !Array.isArray(parsed.sessions)) {
			skip("transcript", `transcripts/${id}.json`);
			return;
		}
		writtenTranscripts.add(id);
		// An amend on a fenced repo rewrites the transcript blob in SQLite only;
		// the frozen file is the pre-amend version and must not clobber it. Still
		// counted as written above — the row exists, links may point at it.
		if (protect !== undefined) {
			const existing = db
				.prepare("SELECT written_at_ms FROM transcripts WHERE repo_id = ? AND transcript_id = ?")
				.get(repoId, id) as { written_at_ms: number } | undefined;
			if (existing && existing.written_at_ms >= protect) return;
		}
		// Compressed: this blob has no generated columns, is never indexed and is
		// always fetched whole, which makes it the one place in the database where
		// compression costs no query. Everything else (summary_json, body_md,
		// artifact_json) has json_extract or byte-faithful readback depending on it.
		db.prepare(
			`INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, ?, ?, ?)
			 ON CONFLICT(repo_id, transcript_id) DO UPDATE SET sessions_blob = excluded.sessions_blob,
			   written_at_ms = excluded.written_at_ms`,
		).run(repoId, id, deflateSync(Buffer.from(content as string, "utf8")), stampMs);
		db.prepare("DELETE FROM transcript_sessions WHERE repo_id = ? AND transcript_id = ?").run(repoId, id);
		parsed.sessions.forEach((session, idx) => {
			if (!session.sessionId) {
				skip("transcript session", `${id}[${idx}]`);
				return;
			}
			// No array index: the session order lives in the blob, and reassembly
			// reads it from there. This table only answers "which commits is this
			// session tied to", so it carries no fidelity duty. ON CONFLICT because
			// one session may legitimately appear twice in one transcript.
			db.prepare(
				`INSERT INTO transcript_sessions (repo_id, transcript_id, session_id, source) VALUES (?, ?, ?, ?)
				 ON CONFLICT(repo_id, transcript_id, session_id) DO UPDATE SET source = excluded.source`,
			).run(repoId, id, session.sessionId, session.source ?? null);
		});
		transcripts++;
	};

	/** The transcript ids a summary points at, before any existence filtering. */
	const transcriptCandidates = (summary: CommitSummary): ReadonlyArray<string> =>
		summary.transcripts ?? collectAllTranscriptHashes(summary);

	let links = 0;
	const writeLinks = (hash: string, summary: CommitSummary): void => {
		// Links derive from the summary body; a node whose body was protected
		// above keeps the links that body produced when the live path wrote it.
		if (protectedHashes.has(hash)) return;
		// `resolveTranscriptIdsFiltered`, not `getTranscriptIds`: on legacy (pre-v5)
		// data the fallback treats every commit hash in the subtree as a transcript
		// id, and a commit that never had an AI session simply has no file — normal,
		// not an anomaly. It filters those out. A v5 `transcripts` array is
		// authoritative and passes through unchanged, so a missing file there IS
		// worth counting.
		// A v5 array can still name a file that is gone; the FK would reject it, so
		// filter unconditionally and count only the explicit-array misses.
		// Deduped: `transcripts[]` carries no uniqueness guarantee — a squash that
		// concatenated two arrays lists the shared ids twice (measured: 2 summaries
		// on a real branch, each repeating two ids) — while `memory_transcripts`'
		// primary key makes the link a SET. So a repeat is not information, it is a
		// PK violation that aborts the whole batch and, because every later batch
		// re-reads the same file, makes the repo permanently unimportable. Deduped
		// HERE rather than in `resolveTranscriptIdsFiltered`, which other readers
		// call for the array as recorded.
		const ids = [
			...new Set(
				resolveTranscriptIdsFiltered(summary, writtenTranscripts).filter((id) => writtenTranscripts.has(id)),
			),
		];
		for (const id of summary.transcripts ?? []) {
			if (!writtenTranscripts.has(id)) skip("transcript link", `${hash} → ${id} (no transcript file)`);
		}
		// Replace-the-set ONLY in seed mode. `catch-up` is called once per source,
		// and a repo with several checkouts (or a cutover retry followed by a
		// mirror/frozen-orphan recovery pass) runs it several times over the same
		// rows — so a delete here made each source destroy the links the previous
		// one had just written, leaving only the last source's. Seed is the one
		// mode entitled to reconcile against a single listing, and it is the mode
		// that must still converge when a regenerated summary drops a transcript.
		if (mode === "seed") {
			db.prepare("DELETE FROM memory_transcripts WHERE repo_id = ? AND commit_hash = ?").run(repoId, hash);
		}
		for (const id of ids) {
			const res = db
				.prepare(
					`INSERT INTO memory_transcripts (repo_id, commit_hash, transcript_id) VALUES (?, ?, ?)
					 ON CONFLICT(repo_id, commit_hash, transcript_id) DO NOTHING`,
				)
				.run(repoId, hash, id) as { changes: number | bigint };
			// Only rows this call actually created. A second source re-asserting the
			// same link is a no-op, and counting it would report link growth on a
			// converged re-run.
			if (Number(res.changes) > 0) links++;
		}
	};

	// ── the batch driver: whole trees at a time, cursor in the same commit ─
	//
	// A resume is only legal against the SAME ordering: between two runs the
	// branch can gain, lose or rewrite summaries, and a stale `nextIndex` would
	// then point at a different memory. The fingerprint is what makes that
	// decidable; a mismatch simply starts over, which is always safe because
	// every write here is an upsert.
	const priorState = readImportStateRow(db, repoId);
	const resumable =
		fingerprint !== null &&
		priorState?.cursor != null &&
		priorState.cursor.fingerprint === fingerprint &&
		// Mode must match too — see `ImportCursor.mode` for the topology corruption a
		// cross-mode resume produced.
		priorState.cursor.mode === mode
			? priorState.cursor
			: null;
	let doneCount = resumable?.nextIndex ?? 0;
	let phase1Done = resumable?.phase1Done ?? false;
	const total = ordered.length;
	if (resumable) {
		// Transcripts an earlier run already linked count as claimed, or the
		// unclaimed sweep at the end would re-read and re-write the entire
		// transcripts tree on every resume — the exact cost batching exists to
		// avoid. Linked-but-unparsable ones are not in this table and get retried,
		// which is harmless: they are skipped again.
		for (const row of db
			.prepare("SELECT DISTINCT transcript_id FROM memory_transcripts WHERE repo_id = ?")
			.all(repoId) as Array<{ transcript_id: string }>) {
			claimedTranscripts.add(row.transcript_id);
		}
	}
	// Memories an earlier run already committed are still memories this source
	// contributed; counting only what THIS process wrote would make a resumed
	// run report a fraction of the repo. Taken from the cursor's own `nodes`,
	// NOT from `nextIndex` — the position counts summaries that were skipped for
	// an unparsable body, which never became rows.
	nodes += resumable?.nodes ?? 0;
	const report = (): void => opts.onProgress?.({ done: doneCount, total: skeleton ? total : undefined });

	const stamp = (cursor: ImportCursor | undefined): void =>
		writeImportState(db, repoId, {
			state: "running",
			startedAt: runStartedAt,
			heartbeatAt: heartbeatNow(),
			pid: process.pid,
			done: doneCount,
			...(skeleton ? { total } : {}),
			...(cursor ? { cursor } : {}),
		});

	if (mode === "seed") {
		if (!phase1Done) {
			inTransaction(db, () => {
				seedPhase1();
				phase1Done = true;
				stamp(fingerprint ? { fingerprint, mode, nextIndex: doneCount, nodes, phase1Done: true } : undefined);
			});
		}
	} else {
		// A crashed seed run can leave rows parked in the offset region. Catch-up
		// never uses the region, but it must still empty it, or inspection query 2
		// reads a healthy database as "crashed mid-reorder" forever and a later
		// seed's shift would push the parked rows past the CHECK ceiling.
		//
		// UNDO the shift rather than ground the rows — see
		// `unshiftOffsetResidue`. These rows kept their edges through the shift,
		// and catch-up never re-mounts an existing row, so grounding them here was
		// a one-way flattening of the whole repo's tree.
		inTransaction(db, unshiftOffsetResidue);
	}

	// One batch per group of whole trees. Without a skeleton there are no trees
	// to group, so the fallback is the single all-at-once batch this importer
	// always used.
	const batches = skeleton ? planBatches(skeleton.trees) : [{ start: 0, end: ordered.length }];
	for (const batch of batches) {
		// Batch boundaries are a pure function of the fingerprinted ordering, so a
		// cursor always lands exactly on one of them.
		if (batch.end <= doneCount) continue;
		const slice = ordered.slice(batch.start, batch.end);
		const bodies = await readAll(
			storage,
			slice.map((hash) => `summaries/${hash}.json`),
		);
		const batchSummaries = new Map<string, CommitSummary>();
		for (const hash of slice) {
			const parsed = tryParse<CommitSummary>(bodies.get(`summaries/${hash}.json`) ?? null);
			if (parsed?.commitHash) batchSummaries.set(hash, parsed);
			else skip("summary", `summaries/${hash}.json`);
		}
		// The unchanged whole-set topology function, called on one batch. Legal
		// precisely because a batch holds WHOLE trees: every parent of a node here
		// is also here, so batch-local and global topology agree node for node.
		const topology = computeTopology(batchSummaries, index);

		// Pull this batch's transcripts before opening the transaction — one
		// `cat-file --batch` for the lot, like the old whole-set pass.
		const wanted: string[] = [];
		for (const summary of batchSummaries.values()) {
			for (const id of transcriptCandidates(summary)) {
				claimedTranscripts.add(id);
				if (!writtenTranscripts.has(id) && liveTranscripts.has(id) && !wanted.includes(id)) wanted.push(id);
			}
		}
		const transcriptBodies = await readAll(
			storage,
			wanted.map((id) => `transcripts/${id}.json`),
		);

		inTransaction(db, () => {
			db.exec("PRAGMA defer_foreign_keys = ON");
			for (const id of wanted) writeTranscript(id, transcriptBodies.get(`transcripts/${id}.json`) ?? null);
			for (const hash of slice) {
				const summary = batchSummaries.get(hash);
				// Unparsable body: counted as a skip above. Its row is simply not
				// written, which is what grounds any child of it (computeTopology
				// already dropped the edge) and what the prune below cleans up.
				if (summary !== undefined) {
					const topo = topology.get(hash) as Topology;
					if (mode === "seed") writeMemorySeed(hash, summary, topo);
					else writeMemoryCatchUp(hash, summary, topo);
					writeLinks(hash, summary);
				}
				// Counted even when the body was unreadable: `done` measures progress
				// through the ordering, and a skipped memory is one the run will never
				// come back to. Counting only successes would leave the last line short
				// of the total on any repo with one bad file, which reads as a hang.
				doneCount++;
				// Fired inside the transaction, so a callback that touched the database
				// would re-enter BEGIN IMMEDIATE. Console output only — the contract is
				// on SotImportOptions.onProgress.
				report();
			}
			// Cursor and rows commit together — that is the whole guarantee. The
			// heartbeat rides along rather than paying for its own transaction.
			stamp(fingerprint ? { fingerprint, mode, nextIndex: doneCount, nodes, phase1Done } : undefined);
		});
	}
	// A run that resumed past the last batch writes nothing and would otherwise
	// emit no event at all, leaving the renderer with no total to print.
	if (batches.every((batch) => batch.end <= (resumable?.nextIndex ?? 0))) report();

	if (mode === "seed") {
		// Phase 2's counterpart to the shift: anything still parked in the offset
		// region is a stored child the settle pass did not reach, because its
		// `summaries/<hash>.json` was absent or unreadable this run. Ground it as a
		// root — restoring the old position instead would risk colliding with a
		// sibling the settle pass just placed at that exact (parent_hash,
		// child_pos); NULL/NULL satisfies CHECK ((parent_hash IS NULL) = (child_pos
		// IS NULL)) and can collide with nothing. The prune below removes the
		// unlisted ones moments later; a listed-but-unreadable file's row survives,
		// which is why the offset region must be empty when the run ends — that is
		// what keeps the next shift in range and lets inspection query 2 mean "a
		// run crashed mid-reorder" rather than "normal residue".
		inTransaction(db, groundOffsetResidue);

		// Re-grounding breaks edges without recomputing what hung off them: the
		// grounded row (and every descendant it kept) still carries the root_hash
		// and depth of the tree it was torn from, which the rootTopology inspection
		// query reads as a write-module bug and readOne's root_hash tree fetch
		// reassembles wrongly. Settle from the full stored edge set, exactly like
		// the live write path does after ITS reground.
		inTransaction(db, () => remountRepo(db, repoId));
	} else {
		// Self-heal: databases written by the flattening importer this replaced
		// carry rows whose root_hash/depth still point into the tree they were
		// torn from. One cheap count decides; the remount is per-repo and
		// idempotent, so healing costs nothing on the next pass.
		//
		// It no longer has to cover THIS pass's own residue: the unshift above
		// restores parked rows with their edges intact, so they are not grounded
		// and do not match this query. That is the point — a row this heal
		// "fixes" is one whose parent edge is already gone, and catch-up has no
		// way to give it back.
		const damaged = db
			.prepare(
				`SELECT COUNT(*) AS n FROM memories
				  WHERE repo_id = ? AND parent_hash IS NULL AND (root_hash != commit_hash OR depth != 0)`,
			)
			.get(repoId) as { n: number };
		if (damaged.n > 0) {
			log.warn(
				"orphan import for %s: healing %d row(s) with stale root_hash/depth",
				repo.repoIdentity,
				damaged.n,
			);
			inTransaction(db, () => remountRepo(db, repoId));
		}
	}

	// ── transcripts nobody claimed ─────────────────────────────────────────
	// The old importer walked `transcripts/` as its own family, so a file no
	// summary references still got a row. Slicing by memory would drop those
	// silently — a behaviour change disguised as a refactor — so the difference
	// is swept up here.
	const unclaimed = [...liveTranscripts].filter((id) => !claimedTranscripts.has(id)).sort();
	if (unclaimed.length > 0) {
		const orphanBodies = await readAll(
			storage,
			unclaimed.map((id) => `transcripts/${id}.json`),
		);
		inChunkedTransactions(db, unclaimed, (id) =>
			writeTranscript(id, orphanBodies.get(`transcripts/${id}.json`) ?? null),
		);
	}

	// ── commit aliases ─────────────────────────────────────────────────────
	let aliases = 0;
	const aliasEntries = Object.entries(index?.commitAliases ?? {});
	// null, not an empty set: a null index means "unreadable", and index.json is
	// the only source of the alias map, so a corrupt read must not prune it away.
	const liveAliases = index ? new Set(Object.keys(index.commitAliases ?? {})) : null;
	inChunkedTransactions(db, aliasEntries, ([oldHash, targetHash]) => {
		// Asked of the DATABASE, not of a parsed-summary set: `commit_aliases` has
		// a real FK onto `memories`, and after a resume the target's row may have
		// been written by an earlier run whose in-memory state this process never
		// saw. The row's existence is the only predicate the FK actually respects.
		const target = db
			.prepare("SELECT 1 AS ok FROM memories WHERE repo_id = ? AND commit_hash = ?")
			.get(repoId, targetHash) as { ok?: number } | undefined;
		if (!target) {
			skip("alias", `${oldHash} → ${targetHash} (target has no node)`);
			return;
		}
		db.prepare(
			`INSERT INTO commit_aliases (repo_id, old_hash, target_hash, created_ms) VALUES (?, ?, ?, ?)
			 ON CONFLICT(repo_id, old_hash) DO UPDATE SET target_hash = excluded.target_hash`,
		).run(repoId, oldHash, targetHash, nowMs);
		aliases++;
	});

	// ── docs: plans first (plan_progress trigger depends on them) ──────────
	let docs = 0;
	/** `<kind>\0<doc_key>` for every doc file the branch lists, across all kinds. */
	const liveDocs = new Set<string>();
	const upsertDoc = (
		kind: string,
		docKey: string,
		body: string,
		extra: {
			source?: string | null;
			nativeId?: string | null;
			toolName?: string | null;
			referencedAt?: string | null;
			originalSlug?: string | null;
			branch?: string | null;
			title?: string | null;
			url?: string | null;
		},
	): void => {
		// A plan or note updated after the fence lives in SQLite only; the frozen
		// branch's body is older and must not roll it back. `updated_at_ms` is NULL
		// until the first post-insert update, hence the COALESCE onto created_at_ms.
		if (protect !== undefined) {
			const existing = db
				.prepare(
					`SELECT COALESCE(updated_at_ms, created_at_ms) AS stamp FROM context
					  WHERE repo_id = ? AND kind = ? AND context_key = ?`,
				)
				.get(repoId, kind, docKey) as { stamp: number | null } | undefined;
			if (existing && (existing.stamp ?? 0) >= protect) return;
		}
		db.prepare(
			`INSERT INTO context (repo_id, kind, context_key, source, native_id, tool_name, referenced_at,
			                      original_slug, branch, title, url, body_md, created_at_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(repo_id, kind, context_key) DO UPDATE SET
			   source = excluded.source, native_id = excluded.native_id, tool_name = excluded.tool_name,
			   referenced_at = excluded.referenced_at, original_slug = excluded.original_slug,
			   branch = excluded.branch, title = excluded.title, url = excluded.url,
			   body_md = excluded.body_md, updated_at_ms = ?`,
		).run(
			repoId,
			kind,
			docKey,
			extra.source ?? null,
			extra.nativeId ?? null,
			extra.toolName ?? null,
			extra.referencedAt ?? null,
			extra.originalSlug ?? null,
			extra.branch ?? null,
			extra.title ?? null,
			extra.url ?? null,
			body,
			// BOTH stamps are clamped, not just the update one: the guard above
			// reads COALESCE(updated_at_ms, created_at_ms), so a first insert is
			// judged on `created_at_ms` alone and an unclamped one would make this
			// import's own output outrank every later pass.
			stampMs,
			stampMs,
		);
		docs++;
	};

	const planPaths = (await storage.listFiles("plans/")).filter((p) => p.endsWith(".md"));
	for (const path of planPaths) liveDocs.add(keyOf("plan", path.slice("plans/".length, -".md".length)));
	const planContents = await readAll(storage, planPaths);
	inChunkedTransactions(db, [...planContents.entries()], ([path, content]) => {
		if (content == null) return skip("plan", path);
		const slug = path.slice("plans/".length, -".md".length);
		const { branch, original } = branchFromKeySuffix(slug, index);
		upsertDoc("plan", slug, content, { branch, originalSlug: original, title: markdownTitle(content) });
	});

	const notePaths = (await storage.listFiles("notes/")).filter((p) => p.endsWith(".md"));
	for (const path of notePaths) liveDocs.add(keyOf("note", path.slice("notes/".length, -".md".length)));
	const noteContents = await readAll(storage, notePaths);
	inChunkedTransactions(db, [...noteContents.entries()], ([path, content]) => {
		if (content == null) return skip("note", path);
		const id = path.slice("notes/".length, -".md".length);
		const { branch } = branchFromKeySuffix(id, index);
		upsertDoc("note", id, content, { branch, title: markdownTitle(content) });
	});

	const referencePaths = (await storage.listFiles("references/")).filter((p) => p.endsWith(".md"));
	for (const path of referencePaths)
		liveDocs.add(keyOf("reference", path.slice("references/".length, -".md".length)));
	const referenceContents = await readAll(storage, referencePaths);
	inChunkedTransactions(db, [...referenceContents.entries()], ([path, content]) => {
		if (content == null) return skip("reference", path);
		const parsed = readReferenceMarkdownFromString(content);
		if (!parsed) return skip("reference", `${path} (unparsable frontmatter)`);
		const docKey = path.slice("references/".length, -".md".length);
		upsertDoc("reference", docKey, content, {
			source: parsed.source,
			nativeId: parsed.nativeId,
			toolName: parsed.toolName,
			referencedAt: parsed.referencedAt,
			title: parsed.title,
			url: parsed.url ?? null,
		});
	});

	// Archived skills. Same shape as a note — one key, one body, a markdown
	// title — and deliberately NOT given `source` from the key's first segment:
	// `context` CHECKs source to kind='reference', and the segment is recoverable
	// from `context_key` anyway (the reference rows store it twice only because
	// their escaped native id is not).
	const skillPaths = (await storage.listFiles("skills/")).filter((p) => p.endsWith(".md"));
	for (const path of skillPaths) liveDocs.add(keyOf("skill", path.slice("skills/".length, -".md".length)));
	const skillContents = await readAll(storage, skillPaths);
	inChunkedTransactions(db, [...skillContents.entries()], ([path, content]) => {
		if (content == null) return skip("skill", path);
		const key = path.slice("skills/".length, -".md".length);
		upsertDoc("skill", key, content, { title: markdownTitle(content) });
	});

	// ── plan progress (canonical artifact JSON) ────────────────────────────
	let planProgress = 0;
	const progressPaths = (await storage.listFiles("plan-progress/")).filter((p) => p.endsWith(".json"));
	const progressContents = await readAll(storage, progressPaths);
	// Both spellings of an artifact's key count as live: the row it produced last
	// time was keyed on `planSlug`, which an unreadable artifact cannot supply now.
	const liveProgress = new Set(progressPaths.map((p) => p.slice("plan-progress/".length, -".json".length)));
	inChunkedTransactions(db, [...progressContents.entries()], ([path, content]) => {
		const parsed = tryParse<{ planSlug?: string }>(content);
		if (!parsed || content == null) return skip("plan-progress", path);
		const slug = parsed.planSlug ?? path.slice("plan-progress/".length, -".json".length);
		liveProgress.add(slug);
		// Checked BEFORE the insert, not caught after it. The relation used to be
		// policed by a trigger, which raised during the INSERT where a per-artifact
		// catch could skip it; it is a foreign key now, and this transaction runs
		// with `defer_foreign_keys = ON`, so a violation surfaces at COMMIT instead
		// — past the catch below and fatal for the whole batch. An orphaned progress
		// artifact is an ordinary state of an older branch (its plan was pruned),
		// so it has to be a skip, which means asking first.
		const planExists = db
			.prepare("SELECT 1 AS ok FROM context WHERE repo_id = ? AND kind = 'plan' AND context_key = ?")
			.get(repoId, slug) as { ok?: number } | undefined;
		if (!planExists) {
			skip("plan-progress", `${slug} (no plan with that slug)`);
			return;
		}
		// Same fence rule as the plan body it tracks: post-fence progress exists
		// only in SQLite and outranks the frozen artifact.
		if (protect !== undefined) {
			const existing = db
				.prepare("SELECT updated_at_ms FROM plan_progress WHERE repo_id = ? AND plan_slug = ?")
				.get(repoId, slug) as { updated_at_ms: number } | undefined;
			if (existing && existing.updated_at_ms >= protect) return;
		}
		try {
			db.prepare(
				`INSERT INTO plan_progress (repo_id, plan_slug, artifact_json, updated_at_ms) VALUES (?, ?, ?, ?)
				 ON CONFLICT(repo_id, plan_slug) DO UPDATE SET
				   artifact_json = excluded.artifact_json, updated_at_ms = excluded.updated_at_ms`,
			).run(repoId, slug, content, stampMs);
			planProgress++;
		} catch (err) {
			// A real foreign key to context(repo_id, plan_key) rejects progress whose
			// plan is absent — the three triggers that used to police this are gone.
			skip("plan-progress", `${slug} (${errMsg(err)})`);
		}
	});

	// ── topic KB: pages + source refs + processed set ──────────────────────
	let topics = 0;
	const topicIndex = await readTopicIndex(cwd, storage);
	const indexBySlug = new Map(topicIndex.topics.map((t) => [t.stableSlug, t]));
	const slugs = await listTopicPageSlugs(cwd, storage);
	const pages = [];
	for (const slug of slugs) {
		const page = await readTopicPage(slug, cwd, storage);
		if (page) pages.push(page);
		else skip("topic page", slug);
	}
	inChunkedTransactions(db, pages, (page) => {
		// Topic pages carry their generation stamp in the payload itself; a page
		// regenerated after the fence (stored via the live path) outranks the
		// frozen branch's copy. An unparsable stamp falls through to the upsert —
		// converging on the source is the pre-cutover contract.
		if (protect !== undefined) {
			const existing = db
				.prepare("SELECT last_updated_at FROM topic_pages WHERE repo_id = ? AND stable_slug = ?")
				.get(repoId, page.stableSlug) as { last_updated_at: string | null } | undefined;
			const storedAt = Date.parse(existing?.last_updated_at ?? "");
			if (Number.isFinite(storedAt) && storedAt >= protect) return;
		}
		// `summary` is COALESCEd rather than overwritten. It has exactly ONE
		// source, `topics/index.json` — the page file never carries it, which is
		// why this column exists at all (see `SotWrite.landTopics`, which omits it
		// from its own UPDATE for the same reason, and
		// `SqliteStorage.synthTopicIndex`, which rebuilds the FILE from this
		// column after cutover). And `readTopicIndex` answers an empty index for a
		// missing file, an unparsable one and a genuinely empty one alike, so
		// `indexBySlug` being empty is indistinguishable from "no summaries exist".
		//
		// An orphan tip carrying `topics/<slug>.json` with no `topics/index.json`
		// is reachable — the page and the index are two independent writes under
		// two separate lock acquisitions — and used to bind null for every page,
		// wiping the column on every dashboard pass. After cutover that is
		// unrecoverable: the database is the only copy left. The fence guard above
		// does not cover it, since it only protects pages regenerated since the
		// fence, and most topics are not.
		db.prepare(
			`INSERT INTO topic_pages (repo_id, stable_slug, title, summary, content_md,
			                          related_branches_json, last_updated_at, payload_version)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(repo_id, stable_slug) DO UPDATE SET
			   title = excluded.title, content_md = excluded.content_md,
			   -- COALESCE, not overwrite, for the same reason index_diff_stats_json
			   -- above uses one. See the note above this statement.
			   summary = COALESCE(excluded.summary, topic_pages.summary),
			   related_branches_json = excluded.related_branches_json,
			   last_updated_at = excluded.last_updated_at, payload_version = excluded.payload_version`,
		).run(
			repoId,
			page.stableSlug,
			page.title,
			indexBySlug.get(page.stableSlug)?.summary ?? null,
			page.content,
			JSON.stringify(page.relatedBranches ?? []),
			page.lastUpdatedAt,
			page.schemaVersion,
		);
		db.prepare("DELETE FROM topic_source_refs WHERE repo_id = ? AND stable_slug = ?").run(repoId, page.stableSlug);
		page.sourceRefs.forEach((ref, pos) => {
			db.prepare(
				`INSERT INTO topic_source_refs (repo_id, stable_slug, pos, ref_type, ref_id, ts, branch)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(repoId, page.stableSlug, pos, ref.type, ref.id, ref.timestamp, ref.branch ?? null);
		});
		topics++;
	});

	// `null` = the file is there and unparsable. It must NOT reconcile as an
	// empty live-set: seed mode would then delete every `topic_processed_sources`
	// row for the repo, losing the topic KB's high-water mark silently (one
	// log line, `skipped` unaffected) and making every ingested source look
	// unprocessed again. Same treatment the alias index gets a few families up.
	const processed = await readProcessedSetOrNull(cwd, storage);
	if (processed === null) skip("processed sources", `topics/processed.json is unparsable — prune skipped`);
	const processedRows = Object.entries(processed?.processed ?? {}).flatMap(([type, ids]) =>
		ids.map((id) => [type, id] as const),
	);
	inChunkedTransactions(db, processedRows, ([type, id]) => {
		db.prepare(
			`INSERT INTO topic_processed_sources (repo_id, source_type, source_id) VALUES (?, ?, ?)
			 ON CONFLICT(repo_id, source_type, source_id) DO NOTHING`,
		).run(repoId, type, id);
	});

	// ── v5-migration marker: raw bytes into repo_state ──────────────────────
	// A completed-marker, not derivable data: its absence makes the v5 migration
	// believe it never ran. Stored verbatim so the adapter serves it back
	// byte-exactly. Never deleted when absent — a marker that says "done" must
	// not be un-said by one unreadable listing.
	const v5State = await storage.readFile("schema-v5-migration.json");
	if (v5State !== null) {
		inTransaction(db, () => {
			db.prepare(
				`INSERT INTO repo_state (repo_id, key, value) VALUES (?, 'v5-migration', ?)
				 ON CONFLICT(repo_id, key) DO UPDATE SET value = excluded.value`,
			).run(repoId, v5State);
		});
	}

	// ── prune: rows whose source artifact is gone ───────────────────────────
	// Without this the import only ever grows — a deleted summary, doc,
	// transcript or topic page would stay queryable forever and a re-run would
	// not converge on the branch.
	//
	// Runs AFTER every upsert, deliberately: the upsert pass has already
	// re-parented the survivors (`computeTopology` grounds a node whose parent
	// file vanished) and rewritten their transcript links, so nothing that
	// survives still points at a stale row and the CASCADEs below can only take
	// stale rows with them. The order inside the pass matters too — memories
	// first, so their cascade clears links and target-less aliases before the
	// narrower passes look at what is left.
	let pruned = 0;
	// The caller chose `seed` from a fence read taken BEFORE the import started,
	// and the sweeps above can run for minutes. If the repo was fenced in that
	// window, a QueueWorker may already have written post-fence memories that
	// exist only in SQLite — to this prune they look exactly like "deleted from
	// the branch", and the branch is frozen, so deleting them is permanent.
	// Re-check both witnesses (the profile fence and the CAS's repo_state row)
	// at the last moment; rows inserted after each pruneTable's own SELECT are
	// safe regardless, so this closes the window to microseconds. Degrading to
	// no-prune is the catch-up cost model: stale rows a later legitimate seed
	// removes, versus data loss that nothing can undo.
	const fencedMeanwhile =
		mode === "seed" &&
		((cwd !== undefined && (await readCutoverFence(cwd).catch(() => null)) !== null) ||
			db.prepare("SELECT 1 AS ok FROM repo_state WHERE repo_id = ? AND key = 'cutover'").get(repoId) !==
				undefined);
	if (fencedMeanwhile) {
		log.warn("orphan import for %s: repo was fenced mid-import — skipping the seed prune", repo.repoIdentity);
	}
	if (mode === "seed" && !fencedMeanwhile) {
		pruned += pruneTable(db, "memories", ["commit_hash"], repoId, liveNodes);
		if (liveAliases) pruned += pruneTable(db, "commit_aliases", ["old_hash"], repoId, liveAliases);
		// Set reconciliation against the transcript *files*, which subsumes the
		// orphan GC the schema describes (a transcript nothing references any more is
		// removed with its file). The unreferenced-but-present case is deliberately
		// kept: the import re-creates such a file's row on every run, so deleting it
		// here would make the pass churn instead of converge.
		pruned += pruneTable(db, "transcripts", ["transcript_id"], repoId, liveTranscripts);
		// context before plan_progress: dropping a plan cascades its progress row
		// through the foreign key, so the next pass sees fewer rows.
		pruned += pruneTable(db, "context", ["kind", "context_key"], repoId, liveDocs);
		pruned += pruneTable(db, "plan_progress", ["plan_slug"], repoId, liveProgress);
		pruned += pruneTable(db, "topic_pages", ["stable_slug"], repoId, new Set(slugs));
		if (processed !== null) {
			pruned += pruneTable(
				db,
				"topic_processed_sources",
				["source_type", "source_id"],
				repoId,
				new Set(processedRows.map(([type, id]) => keyOf(type, id))),
			);
		}
	}

	// ── completion marker ──────────────────────────────────────────────────
	const skipped = [...skips.values()].reduce((sum, n) => sum + n, 0);
	const result: SotImportResult = {
		nodes,
		updated,
		commitTopics,
		aliases,
		transcripts,
		links,
		docs,
		planProgress,
		topics,
		skipped,
		pruned,
	};
	// Every historical receipt field is preserved verbatim — readers and tests
	// that predate the lifecycle fields keep working. What is added is the
	// `state` discriminator, and what is REMOVED is the cursor: the run finished,
	// so there is nothing to resume from and a leftover cursor would make the
	// next run skip the whole repo.
	inTransaction(db, () =>
		writeImportState(db, repoId, {
			at: nowMs,
			...result,
			skippedByKind: Object.fromEntries(skips),
			state: "done",
			startedAt: runStartedAt,
			heartbeatAt: heartbeatNow(),
			pid: process.pid,
			done: nodes,
			...(skeleton ? { total: ordered.length } : {}),
		}),
	);
	if (skipped > 0) {
		// One line per repo, naming the kinds — enough to notice a real anomaly
		// (e.g. every doc skipped) without printing one line per artifact.
		const breakdown = [...skips.entries()].map(([what, n]) => `${what} ×${n}`).join(", ");
		log.info("orphan import for %s skipped %d artifact(s): %s", repo.repoIdentity, skipped, breakdown);
	}
	log.info("orphan import for %s: %o", repo.repoIdentity, result);
	return result;
}

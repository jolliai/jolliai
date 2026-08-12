/**
 * SotWrite — lands a {@link FileWrite} batch in the SQLite source of truth.
 *
 * One `writeFiles` call = ONE transaction, but one transaction is not enough:
 * callers order their batches for the orphan tree (`summaries/...` before
 * `transcripts/...`), and the link table foreign-keys into both nodes and
 * transcripts, so writing file-by-file in caller order would insert links
 * before the transcript rows they reference. The batch is therefore parsed
 * into classified rows FIRST and landed in fixed dependency order:
 *
 *   nodes → transcripts → links → context → plan_progress → topics → state
 *
 * `defer_foreign_keys = ON` rides along as second insurance — it defers real
 * foreign keys to COMMIT but NOT unique constraints, which is why sibling
 * repositioning still goes through the two-phase REORDER_OFFSET shift.
 *
 * Decisions that are not visible from the code alone:
 *
 * - **`index.json` / `catalog.json` writes are deliberate no-ops, not errors.**
 *   Under the file model every memory write rebuilt them; here they are the
 *   equivalent of views and indexes, synthesized on read — dropping the write
 *   is correct. One exception: the index content is HARVESTED for each entry's
 *   `treeHash` before being dropped, because that value exists nowhere else
 *   (313/313 summary files carry none) and alias scanning matches on it.
 *   `topics/index.json` gets the same treatment for its per-topic `summary`.
 * - **The link set's authority is the summary, not the transcript file** — a
 *   transcript file does not know which commit owns it, and "reference an
 *   existing transcript without writing its file" is the NORMAL squash batch.
 *   Every summary write replaces its nodes' link sets exactly (DELETE +
 *   reinsert), which is also what makes replays converge. References resolve
 *   through `resolveTranscriptIdsFiltered` (pre-v5 memories express them as
 *   tree commit hashes), then filter against the transcripts table: the orphan
 *   tolerates dangling references, and the database must not be stricter than
 *   the file storage it replaces — `defer_foreign_keys` cannot absorb this
 *   (the violation just moves to COMMIT).
 * - **A child file does not know its parent.** Writing `summaries/A.json`
 *   where A is somebody's child must keep A's stored mount point; only the
 *   embedded tree BELOW each written node is authoritative. A stored child
 *   that the new tree no longer claims is re-grounded as a root, never
 *   deleted — its own file still exists, and the seed import converges to
 *   exactly that state.
 * - **root_hash/depth are recomputed for the whole repo after node landing.**
 *   Remount propagation (an amend turning an old root into a child moves an
 *   entire subtree) touches arbitrarily deep descendants; recomputing from
 *   the stored edges in JS is O(repo) with repos measured in the hundreds of
 *   rows, and is convergent by construction. Depth doubles as cycle
 *   detection: an unreachable node throws and rolls the batch back.
 */

import { deflateSync } from "node:zlib";
import { readReferenceMarkdownFromString } from "../core/references/ReferenceStore.js";
import { resolveTranscriptIdsFiltered } from "../core/SummaryTree.js";
import { createLogger } from "../Logger.js";
import type { CommitSummary, FileWrite, StoredTranscript, SummaryIndex } from "../Types.js";
import { type DashboardDbHandle, inTransaction } from "./DashboardDb.js";
import { commitDateMs, markdownTitle, remountRepo, reportOffTypeNumerics, tryParse } from "./SotImport.js";
import { REORDER_OFFSET } from "./SotSchema.js";
import { forgetRollupDays } from "./StatsRollup.js";

const log = createLogger("SotWrite");

/** A summary file write, flattened to one node of its embedded tree. */
interface FlatNode {
	readonly hash: string;
	/** Parent claimed by the written tree; null for the file's own top node. */
	readonly parentInFile: string | null;
	/** Position among siblings in the written tree; null for the top node. */
	readonly pos: number | null;
	readonly summary: CommitSummary;
}

/** Classified batch, ready to land in dependency order. */
interface Classified {
	readonly summaryDeletes: string[];
	/** Per written file, its flattened nodes (top node first, parents-first). */
	readonly summaryTrees: FlatNode[][];
	readonly transcriptWrites: Array<{ id: string; content: string }>;
	readonly transcriptDeletes: string[];
	readonly contextWrites: Array<{ kind: string; key: string; body: string }>;
	readonly contextDeletes: Array<{ kind: string; key: string }>;
	readonly progressWrites: Array<{ pathSlug: string; content: string }>;
	readonly progressDeletes: string[];
	readonly topicPageWrites: Array<{ slug: string; content: string }>;
	readonly topicPageDeletes: string[];
	/** Harvested from index.json before the write is dropped. */
	readonly treeHashes: Map<string, string>;
	/** Harvested from index.json: old sha -> current memory (tree-hash aliases). */
	readonly aliases: Map<string, string>;
	/** Harvested from topics/index.json before the write is dropped. */
	readonly topicSummaries: Map<string, string>;
	processedSet: string | null;
	v5State: string | null;
}

/**
 * Orphan folder name → `context.kind`. `skills` is here for the same reason the
 * other three are: an archived skill is one key plus one complete file body, so
 * it needs no table of its own. Adding a folder here without registering the
 * kind in `context_kinds` (a migration) makes the insert fail its foreign key.
 */
const CONTEXT_KIND: Record<string, string> = {
	plans: "plan",
	notes: "note",
	references: "reference",
	skills: "skill",
};

/** Flattens a written summary tree parents-first, emptying children in place. */
function flattenTree(top: CommitSummary): FlatNode[] {
	const out: FlatNode[] = [];
	const walk = (node: CommitSummary, parentInFile: string | null, pos: number | null): void => {
		out.push({ hash: node.commitHash, parentInFile, pos, summary: node });
		(node.children ?? []).forEach((child, i) => {
			walk(child, node.commitHash, i);
		});
	};
	walk(top, null, null);
	return out;
}

/** Parses and classifies the batch; throws on a path no table backs. */
function classify(files: ReadonlyArray<FileWrite>): Classified {
	const c: Classified = {
		summaryDeletes: [],
		summaryTrees: [],
		transcriptWrites: [],
		transcriptDeletes: [],
		contextWrites: [],
		contextDeletes: [],
		progressWrites: [],
		progressDeletes: [],
		topicPageWrites: [],
		topicPageDeletes: [],
		treeHashes: new Map(),
		aliases: new Map(),
		topicSummaries: new Map(),
		processedSet: null,
		v5State: null,
	};
	for (const file of files) {
		const del = file.delete === true;
		const summary = file.path.match(/^summaries\/([0-9a-f]+)\.json$/);
		if (summary) {
			if (del) {
				c.summaryDeletes.push(summary[1]);
				continue;
			}
			const parsed = tryParse<CommitSummary>(file.content);
			if (!parsed?.commitHash) throw new Error(`SotWrite: unparsable summary at ${file.path}`);
			c.summaryTrees.push(flattenTree(parsed));
			continue;
		}
		if (file.path === "index.json") {
			// No-op by design (the index is synthesized on read) — except that each
			// entry's treeHash AND the commitAliases map are unrecoverable from
			// anywhere else, so both are lifted off before the rest of the file is
			// dropped. Dropping the aliases would silently strand every
			// scanTreeHashAliases result written after the cutover: the scanner
			// persists its expensive tree-hash matches by rewriting index.json.
			if (del) continue;
			const parsed = tryParse<SummaryIndex>(file.content);
			for (const entry of parsed?.entries ?? []) {
				if (entry.treeHash) c.treeHashes.set(entry.commitHash, entry.treeHash);
			}
			for (const [oldHash, target] of Object.entries(parsed?.commitAliases ?? {})) {
				c.aliases.set(oldHash, target);
			}
			continue;
		}
		if (file.path === "catalog.json") continue; // synthesized on read; nothing to keep
		if (file.path === "topics/index.json") {
			if (del) continue;
			const parsed = tryParse<{ topics?: Array<{ stableSlug?: string; summary?: string }> }>(file.content);
			for (const t of parsed?.topics ?? []) {
				if (t.stableSlug && t.summary !== undefined) c.topicSummaries.set(t.stableSlug, t.summary);
			}
			continue;
		}
		if (file.path === "topics/processed.json") {
			c.processedSet = del ? null : file.content;
			continue;
		}
		if (file.path === "schema-v5-migration.json") {
			// A delete is ignored, same as the importer: a completed-marker must
			// not be un-said by one errant batch.
			if (!del) c.v5State = file.content;
			continue;
		}
		const transcript = file.path.match(/^transcripts\/(.+)\.json$/);
		if (transcript) {
			if (del) c.transcriptDeletes.push(transcript[1]);
			else c.transcriptWrites.push({ id: transcript[1], content: file.content });
			continue;
		}
		const context = file.path.match(/^(plans|notes|references|skills)\/(.+)\.md$/);
		if (context) {
			const kind = CONTEXT_KIND[context[1]];
			if (del) c.contextDeletes.push({ kind, key: context[2] });
			else c.contextWrites.push({ kind, key: context[2], body: file.content });
			continue;
		}
		const progress = file.path.match(/^plan-progress\/(.+)\.json$/);
		if (progress) {
			if (del) c.progressDeletes.push(progress[1]);
			else c.progressWrites.push({ pathSlug: progress[1], content: file.content });
			continue;
		}
		const topicPage = file.path.match(/^topics\/([^/]+)\.json$/);
		if (topicPage) {
			if (del) c.topicPageDeletes.push(topicPage[1]);
			else c.topicPageWrites.push({ slug: topicPage[1], content: file.content });
			continue;
		}
		// Loud, not silent: an unknown path written to the orphan would at least
		// be stored; here it would vanish, so the whole batch rolls back.
		throw new Error(`SotWrite: no table backs path ${file.path}`);
	}
	return c;
}

/**
 * Drops one unparsable artifact from the batch, loudly, instead of throwing.
 *
 * The whole `writeFiles` batch is ONE transaction, and a commit's context files
 * ride in it alongside its own `summaries/<hash>.json` — so a throw does not
 * reject the bad file, it rolls back the memory the file was attached to. The
 * orphan backend stored these bytes verbatim and could not fail this way at
 * all, which makes it a cutover regression rather than a stricter check: one
 * odd legacy reference took every reference for that commit with it.
 *
 * This is the rule `landProgress` already reached on its own for an orphaned
 * artifact (see the comment there); the rest of this module now follows it.
 * `SotImport` has always skipped-and-counted the same files, so the importer
 * and the writer finally converge — a repo could otherwise import cleanly and
 * then fail to re-write what it had just imported.
 *
 * Deliberately NOT silent: an unparsable artifact still means a producer bug,
 * and `warn` is what makes it visible without costing the user their memory.
 */
function dropUnparsable(what: string, detail: string): void {
	log.warn("SotWrite: dropping unparsable %s (%s) -- keeping the rest of the batch", what, detail);
}

/** `branch` for a `<key>-<hash8>` context key, from the memories table. */
function branchFromMemories(db: DashboardDbHandle, repoId: number, key: string): string | null {
	const match = /-([0-9a-f]{8})$/.exec(key);
	if (!match) return null;
	const row = db
		.prepare("SELECT branch FROM memories WHERE repo_id = ? AND commit_hash LIKE ? || '%' LIMIT 1")
		.get(repoId, match[1]) as { branch: string | null } | undefined;
	return row?.branch ?? null;
}

/** Lands node deletes, upserts, repositioning, re-grounding and remount. */
function landSummaries(db: DashboardDbHandle, repoId: number, c: Classified, nowMs: number): void {
	// Collected before the deletes, because a deleted row cannot tell anyone
	// which cached day it used to contribute to, and a deletion leaves no write
	// stamp for the rollup's staleness check to find. This is the one direction
	// the cache must be told about; everything else it works out for itself.
	const deletedDays: number[] = [];
	for (const hash of c.summaryDeletes) {
		const row = db
			.prepare(
				`SELECT COALESCE(c.committed_at_ms, m.commit_date_ms) AS at_ms
				   FROM memories m
				   LEFT JOIN commits c ON c.repo_id = m.repo_id AND c.hash = m.commit_hash
				  WHERE m.repo_id = ? AND m.commit_hash = ?`,
			)
			.get(repoId, hash) as { at_ms: number | null } | undefined;
		if (row?.at_ms != null) deletedDays.push(row.at_ms);
		// The self-FK cascades: deleting a node takes its stored subtree with it,
		// which is the plan's "pruning is a whole-tree decision".
		db.prepare("DELETE FROM memories WHERE repo_id = ? AND commit_hash = ?").run(repoId, hash);
	}
	forgetRollupDays(db, deletedDays);
	if (c.summaryTrees.length === 0) return;

	// Phase 1 of the sibling reorder: every parent whose child SET this batch
	// rewrites gets its existing children shifted into the offset region, so the
	// settle below can place a shuffled order without UNIQUE collisions (the
	// constraint is checked row by row; deferral cannot absorb it).
	const rewritten = new Set<string>();
	for (const tree of c.summaryTrees) {
		for (const node of tree) if ("children" in node.summary) rewritten.add(node.hash);
	}
	const shift = db.prepare(
		`UPDATE memories SET child_pos = child_pos + ${REORDER_OFFSET}
		  WHERE repo_id = ? AND parent_hash = ? AND child_pos < ${REORDER_OFFSET}`,
	);
	for (const parent of rewritten) shift.run(repoId, parent);

	// The child positions this batch's trees CLAIM, per parent. A top node that
	// re-anchors itself below needs this to tell three cases apart, and getting
	// it wrong is a lost write rather than a lost position: `applyMemoryWrites`
	// runs the batch in one transaction, so a UNIQUE(repo_id, parent_hash,
	// child_pos) violation rolls back the memory plus every transcript, plan and
	// reference riding along with it.
	const claimed = new Map<string, Map<string, number>>();
	for (const tree of c.summaryTrees) {
		for (const node of tree) {
			if (node.parentInFile === null || node.pos === null) continue;
			const siblings = claimed.get(node.parentInFile) ?? new Map<string, number>();
			siblings.set(node.hash, node.pos);
			claimed.set(node.parentInFile, siblings);
		}
	}

	const upsert = db.prepare(
		`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
		                       summary_json, tree_hash, first_seen_ms, written_at_ms, commit_date_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(repo_id, commit_hash) DO UPDATE SET
		   parent_hash = excluded.parent_hash, child_pos = excluded.child_pos,
		   summary_json = excluded.summary_json,
		   tree_hash = COALESCE(excluded.tree_hash, memories.tree_hash),
		   written_at_ms = excluded.written_at_ms, commit_date_ms = excluded.commit_date_ms`,
	);
	const skip = (what: string, detail: string): void => log.info("write degraded a value: %s %s", what, detail);
	for (const tree of c.summaryTrees) {
		for (const node of tree) {
			// The top node keeps its stored mount point — its own file does not
			// know its parent, and clobbering it would tear a child out of its
			// tree on every child-file refresh.
			let parent = node.parentInFile;
			let pos = node.pos;
			if (node.parentInFile === null) {
				const existing = db
					.prepare("SELECT parent_hash, child_pos FROM memories WHERE repo_id = ? AND commit_hash = ?")
					.get(repoId, node.hash) as { parent_hash: string | null; child_pos: number | null } | undefined;
				if (existing) {
					parent = existing.parent_hash;
					pos = existing.child_pos;
					// The mount point may itself sit in the offset region: its
					// parent's set is being rewritten and settles later in this same
					// batch. What to do with it then depends on whether that new set
					// still claims this node, and stripping unconditionally (as this
					// used to) is wrong when it does -- it drops the row into the live
					// position space while its siblings are still parked, so the walk
					// below hands the same position to a different sibling and the
					// UNIQUE constraint rolls the whole batch back. Correctness then
					// depended on the caller ordering the parent's file ahead of the
					// child's, which this module's header explicitly does not promise
					// (measured: `ProducerHooks.refreshMemoryRows` emits a commit and
					// its later amend child-first).
					//
					// A parked position always means the parent IS being rewritten
					// (only `rewritten` parents get shifted), so "nobody will settle
					// it" is never the case: either the new set claims the node, or the
					// set dropped it and the module's rule applies -- re-ground, never
					// keep an edge the file model no longer claims. Restoring the
					// stored mount here (which this used to do whenever the ground slot
					// happened to be free) left the database carrying an edge
					// `<parent>.json` does not list, so a seed import from the same
					// files converged to a different tree.
					if (pos !== null && pos >= REORDER_OFFSET) {
						const siblings = parent === null ? undefined : claimed.get(parent);
						if (siblings?.has(node.hash)) {
							// The new set still claims this node -- stay parked and let
							// the parent's own walk place it.
						} else {
							// Dropped from the set. Re-ground it, which is what
							// `reground` below would do for the same row had its own
							// file not been in the batch.
							parent = null;
							pos = null;
						}
					}
				}
			}
			const summaryJson = JSON.stringify(
				"children" in node.summary ? { ...node.summary, children: [] } : node.summary,
			);
			// root_hash/depth land as provisional self-values; remount() below
			// settles them from the full stored edge set.
			upsert.run(
				repoId,
				node.hash,
				parent,
				pos,
				node.hash,
				0,
				summaryJson,
				c.treeHashes.get(node.hash) ?? null,
				nowMs,
				nowMs,
				commitDateMs(node.summary, node.hash, nowMs, skip),
			);
			reportOffTypeNumerics(node.summary, node.hash, skip);

			db.prepare("DELETE FROM memory_topics WHERE repo_id = ? AND commit_hash = ?").run(repoId, node.hash);
			const insertTopic = db.prepare(
				"INSERT INTO memory_topics (repo_id, commit_hash, pos, category, importance, title) VALUES (?, ?, ?, ?, ?, ?)",
			);
			(node.summary.topics ?? []).forEach((topic, i) => {
				if (!topic.title) {
					skip("topic", `${node.hash}[${i}] has no title`);
					return;
				}
				insertTopic.run(repoId, node.hash, i, topic.category ?? null, topic.importance ?? null, topic.title);
			});
		}
	}

	// Stored children the new trees no longer claim are still parked in the
	// offset region: re-ground them as roots (their own files still exist — the
	// seed import converges to exactly this), which also clears the region so
	// inspection query 2 stays quiet.
	const reground = db.prepare(
		`UPDATE memories SET parent_hash = NULL, child_pos = NULL
		  WHERE repo_id = ? AND parent_hash = ? AND child_pos >= ${REORDER_OFFSET}`,
	);
	for (const parent of rewritten) reground.run(repoId, parent);

	remountRepo(db, repoId);
}

/**
 * Lands harvested tree-hash aliases. Its own step, AFTER the node landing:
 * the alias scanner's batch is typically index.json ALONE (it persists a
 * match by rewriting the index), so this must not live behind landSummaries'
 * empty-tree early return.
 */
function landAliases(db: DashboardDbHandle, repoId: number, c: Classified, nowMs: number): void {
	for (const [oldHash, target] of c.aliases) {
		// The FK requires the target memory to exist; an alias pointing at a
		// node this database has never seen is dropped with a log line — same
		// tolerance the orphan gave it.
		const exists = db
			.prepare("SELECT 1 AS ok FROM memories WHERE repo_id = ? AND commit_hash = ?")
			.get(repoId, target) as { ok?: number } | undefined;
		if (!exists) {
			log.info("dropping alias %s -> %s (no such memory row)", oldHash, target);
			continue;
		}
		db.prepare(
			`INSERT INTO commit_aliases (repo_id, old_hash, target_hash, created_ms) VALUES (?, ?, ?, ?)
			 ON CONFLICT(repo_id, old_hash) DO UPDATE SET target_hash = excluded.target_hash`,
		).run(repoId, oldHash, target, nowMs);
	}
}

/** Lands transcript rows + their session projection. */
function landTranscripts(db: DashboardDbHandle, repoId: number, c: Classified, nowMs: number): ReadonlySet<string> {
	const landed = new Set<string>();
	for (const id of c.transcriptDeletes) {
		db.prepare("DELETE FROM transcript_sessions WHERE repo_id = ? AND transcript_id = ?").run(repoId, id);
		db.prepare("DELETE FROM memory_transcripts WHERE repo_id = ? AND transcript_id = ?").run(repoId, id);
		db.prepare("DELETE FROM transcripts WHERE repo_id = ? AND transcript_id = ?").run(repoId, id);
	}
	for (const { id, content } of c.transcriptWrites) {
		const parsed = tryParse<StoredTranscript>(content);
		if (!parsed || !Array.isArray(parsed.sessions)) {
			dropUnparsable("transcript", id);
			continue;
		}
		db.prepare(
			`INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, ?, ?, ?)
			 ON CONFLICT(repo_id, transcript_id) DO UPDATE SET sessions_blob = excluded.sessions_blob,
			   written_at_ms = excluded.written_at_ms`,
		).run(repoId, id, deflateSync(Buffer.from(content, "utf8")), nowMs);
		db.prepare("DELETE FROM transcript_sessions WHERE repo_id = ? AND transcript_id = ?").run(repoId, id);
		for (const session of parsed.sessions) {
			if (!session.sessionId) continue;
			db.prepare(
				`INSERT INTO transcript_sessions (repo_id, transcript_id, session_id, source) VALUES (?, ?, ?, ?)
				 ON CONFLICT(repo_id, transcript_id, session_id) DO UPDATE SET source = excluded.source`,
			).run(repoId, id, session.sessionId, session.source ?? null);
		}
		landed.add(id);
	}
	return landed;
}

/**
 * Links a newly stored transcript to memories that ALREADY reference it.
 *
 * `landLinks` below can only link the summaries in its own batch, so it covers
 * exactly one ordering: transcript first, summary second. The other order —
 * `saveTranscriptsBatch` storing a transcript for a commit whose summary landed
 * earlier, reachable from the ide-bridge `transcripts-save` action — dropped the
 * link permanently, because the id was not yet in `transcripts` when the summary
 * was written (logged as "dangling") and nothing ever re-derived it. The file
 * backend had no such dependency: it resolved links from `summary.transcripts`
 * at READ time, so order never mattered there.
 *
 * The `LIKE` is a candidate filter only — cheap narrowing over `summary_json`,
 * with `resolveTranscriptIdsFiltered` making the actual decision, so a pattern
 * metacharacter inside an id can only widen the candidate set, never shrink it.
 */
function backfillLinksForNewTranscripts(
	db: DashboardDbHandle,
	repoId: number,
	c: Classified,
	written: ReadonlySet<string>,
): void {
	// `landTranscripts`' landed set, NOT `c.transcriptWrites`: an unparsable
	// transcript is dropped there and never reaches the `transcripts` table, so
	// linking it here inserts a `memory_transcripts` row whose parent does not
	// exist. `defer_foreign_keys` only moves that violation to COMMIT, which
	// rolls back the WHOLE batch — re-creating exactly the data loss the drop
	// exists to avoid, and doing it to every other memory in the same write.
	// The set is also the filter passed to `resolveTranscriptIdsFiltered`, so a
	// dropped id would otherwise pass its own membership test.
	if (written.size === 0) return;
	// Nodes this batch also wrote already had their link set REPLACED wholesale
	// by landLinks; re-adding here would resurrect a link that write removed.
	const replaced = new Set(c.summaryTrees.flat().map((n) => n.hash));
	// Ids this batch's own summaries claim. `landLinks` has already resolved those
	// links against the `transcripts` rows `landTranscripts` just wrote, so the
	// scan below can only re-derive what it already did — and the `LIKE` is an
	// unindexable full scan of `memories`' JSON blobs, paid once per id on
	// EVERY ordinary commit, where the summary and its transcript always arrive in
	// the same batch. The orderings this function exists for are the ones where a
	// transcript arrives without its summary (the ide-bridge `transcripts-save`
	// action writes transcripts alone, so `summaryTrees` is empty and nothing here
	// is skipped). Residual: a transcript claimed by BOTH a batch summary and an
	// older memory outside the batch keeps only the batch link until that
	// transcript is written again — a bounded, self-healing gap, and far cheaper
	// than a full scan on every commit that by construction finds nothing.
	const claimedByBatch = new Set(
		c.summaryTrees.flat().flatMap((n) => [...resolveTranscriptIdsFiltered(n.summary, written)]),
	);
	const pending = [...written].filter((id) => !claimedByBatch.has(id));
	if (pending.length === 0) return;
	const candidates = db.prepare(
		"SELECT commit_hash, summary_json FROM memories WHERE repo_id = ? AND summary_json LIKE ?",
	);
	const insert = db.prepare(
		`INSERT INTO memory_transcripts (repo_id, commit_hash, transcript_id) VALUES (?, ?, ?)
		 ON CONFLICT(repo_id, commit_hash, transcript_id) DO NOTHING`,
	);
	for (const id of pending) {
		const rows = candidates.all(repoId, `%${id}%`) as Array<{ commit_hash: string; summary_json: string }>;
		for (const row of rows) {
			if (replaced.has(row.commit_hash)) continue;
			const summary = tryParse<CommitSummary>(row.summary_json);
			if (!summary) continue;
			if (!resolveTranscriptIdsFiltered(summary, written).includes(id)) continue;
			insert.run(repoId, row.commit_hash, id);
			log.info("linked stored transcript %s to memory %s written earlier", id, row.commit_hash);
		}
	}
}

/** Replaces the link set of every node this batch wrote. */
function landLinks(db: DashboardDbHandle, repoId: number, c: Classified): void {
	if (c.summaryTrees.length === 0) return;
	const transcriptIds = new Set(
		(
			db.prepare("SELECT transcript_id FROM transcripts WHERE repo_id = ?").all(repoId) as Array<{
				transcript_id: string;
			}>
		).map((r) => r.transcript_id),
	);
	for (const tree of c.summaryTrees) {
		for (const node of tree) {
			// Deduped for the same reason the importer does it: `transcripts[]` has no
			// uniqueness guarantee (a squash can concatenate two arrays and repeat the
			// shared ids), while `memory_transcripts`' primary key makes the link a SET.
			const ids = [
				...new Set(
					resolveTranscriptIdsFiltered(node.summary, transcriptIds).filter((id) => transcriptIds.has(id)),
				),
			];
			for (const id of node.summary.transcripts ?? []) {
				if (!transcriptIds.has(id)) {
					log.info("dropping dangling transcript link %s → %s (no transcript row)", node.hash, id);
				}
			}
			db.prepare("DELETE FROM memory_transcripts WHERE repo_id = ? AND commit_hash = ?").run(repoId, node.hash);
			for (const id of ids) {
				db.prepare("INSERT INTO memory_transcripts (repo_id, commit_hash, transcript_id) VALUES (?, ?, ?)").run(
					repoId,
					node.hash,
					id,
				);
			}
		}
	}
}

/** Lands context docs with their projection columns. */
function landContext(db: DashboardDbHandle, repoId: number, c: Classified, nowMs: number): void {
	for (const { kind, key } of c.contextDeletes) {
		db.prepare("DELETE FROM context WHERE repo_id = ? AND kind = ? AND context_key = ?").run(repoId, kind, key);
	}
	const upsert = db.prepare(
		`INSERT INTO context (repo_id, kind, context_key, source, native_id, tool_name, referenced_at,
		                      original_slug, branch, title, url, body_md, created_at_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(repo_id, kind, context_key) DO UPDATE SET
		   source = excluded.source, native_id = excluded.native_id, tool_name = excluded.tool_name,
		   referenced_at = excluded.referenced_at, original_slug = excluded.original_slug,
		   branch = excluded.branch, title = excluded.title, url = excluded.url,
		   body_md = excluded.body_md, updated_at_ms = ?`,
	);
	for (const { kind, key, body } of c.contextWrites) {
		if (kind === "reference") {
			const parsed = readReferenceMarkdownFromString(body);
			if (!parsed) {
				dropUnparsable("reference frontmatter", `references/${key}.md`);
				continue;
			}
			upsert.run(
				repoId,
				kind,
				key,
				parsed.source,
				parsed.nativeId,
				parsed.toolName,
				parsed.referencedAt,
				null,
				null,
				parsed.title,
				parsed.url ?? null,
				body,
				nowMs,
				nowMs,
			);
			continue;
		}
		// Plans and notes only. A skill key is `<source>/<stem>-<hash8>`, which the
		// `-<hash8>` suffix probe would happily resolve to a branch — and `context`
		// CHECKs branch to those two kinds, so writing it would abort the batch.
		const branch = kind === "plan" || kind === "note" ? branchFromMemories(db, repoId, key) : null;
		const original = kind === "plan" && branch !== null ? key.replace(/-[0-9a-f]{8}$/, "") : null;
		upsert.run(
			repoId,
			kind,
			key,
			null,
			null,
			null,
			null,
			original,
			branch,
			markdownTitle(body),
			null,
			body,
			nowMs,
			nowMs,
		);
	}
}

/** Lands plan-progress artifacts; an orphaned artifact is a loud error here. */
function landProgress(db: DashboardDbHandle, repoId: number, c: Classified, nowMs: number): void {
	for (const slug of c.progressDeletes) {
		db.prepare("DELETE FROM plan_progress WHERE repo_id = ? AND plan_slug = ?").run(repoId, slug);
	}
	for (const { pathSlug, content } of c.progressWrites) {
		const parsed = tryParse<{ planSlug?: string }>(content);
		// Same reasoning as the orphaned-plan skip below — and the same batch.
		if (!parsed) {
			dropUnparsable("plan-progress", `plan-progress/${pathSlug}.json`);
			continue;
		}
		const slug = parsed.planSlug ?? pathSlug;
		// A live write whose plan is missing IS a caller bug — but throwing here is
		// the wrong way to say so. This batch is one transaction, and a commit's
		// `plan-progress/<slug>.json` rides in it alongside its own
		// `summaries/<hash>.json`, so the rollback discards the MEMORY: a broken
		// progress artifact costs the user the summary it was attached to. The
		// artifact is a derived, regenerable view; the memory is not. So this drops
		// to the importer's behaviour — skip the row, say so loudly — and the FK is
		// left as the structural guarantee it already was.
		const planExists = db
			.prepare("SELECT 1 AS ok FROM context WHERE repo_id = ? AND kind = 'plan' AND context_key = ?")
			.get(repoId, slug) as { ok?: number } | undefined;
		if (!planExists) {
			log.warn(
				"plan-progress for %s has no plan row -- skipping the artifact, keeping the rest of the batch",
				slug,
			);
			continue;
		}
		db.prepare(
			`INSERT INTO plan_progress (repo_id, plan_slug, artifact_json, updated_at_ms) VALUES (?, ?, ?, ?)
			 ON CONFLICT(repo_id, plan_slug) DO UPDATE SET
			   artifact_json = excluded.artifact_json, updated_at_ms = excluded.updated_at_ms`,
		).run(repoId, slug, content, nowMs);
	}
}

/** Lands topic pages (+ refs group replacement), index summaries, processed set. */
function landTopics(db: DashboardDbHandle, repoId: number, c: Classified, nowMs: number): void {
	for (const slug of c.topicPageDeletes) {
		// topic_source_refs cascades off the page row.
		db.prepare("DELETE FROM topic_pages WHERE repo_id = ? AND stable_slug = ?").run(repoId, slug);
	}
	interface PageFile {
		schemaVersion?: number;
		stableSlug?: string;
		title?: string;
		content?: string;
		relatedBranches?: string[];
		sourceRefs?: Array<{ type: string; id: string; timestamp: string; branch?: string }>;
		lastUpdatedAt?: string;
	}
	for (const { slug, content } of c.topicPageWrites) {
		const page = tryParse<PageFile>(content);
		if (!page?.stableSlug || page.title === undefined || page.content === undefined || !page.lastUpdatedAt) {
			dropUnparsable("topic page", `topics/${slug}.json`);
			continue;
		}
		db.prepare(
			`INSERT INTO topic_pages (repo_id, stable_slug, title, summary, content_md,
			                          related_branches_json, last_updated_at, payload_version)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(repo_id, stable_slug) DO UPDATE SET
			   title = excluded.title, content_md = excluded.content_md,
			   related_branches_json = excluded.related_branches_json,
			   last_updated_at = excluded.last_updated_at, payload_version = excluded.payload_version`,
		).run(
			repoId,
			page.stableSlug,
			page.title,
			// The page file never carries `summary` — that column belongs to
			// topics/index.json and is set below (or preserved by this upsert's
			// deliberate omission of summary from the UPDATE clause).
			c.topicSummaries.get(page.stableSlug) ?? null,
			page.content,
			JSON.stringify(page.relatedBranches ?? []),
			page.lastUpdatedAt,
			page.schemaVersion ?? 1,
		);
		db.prepare("DELETE FROM topic_source_refs WHERE repo_id = ? AND stable_slug = ?").run(repoId, page.stableSlug);
		(page.sourceRefs ?? []).forEach((ref, pos) => {
			db.prepare(
				`INSERT INTO topic_source_refs (repo_id, stable_slug, pos, ref_type, ref_id, ts, branch)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(repoId, page.stableSlug, pos, ref.type, ref.id, ref.timestamp, ref.branch ?? null);
		});
	}
	for (const [slug, summary] of c.topicSummaries) {
		const changed = db
			.prepare("UPDATE topic_pages SET summary = ? WHERE repo_id = ? AND stable_slug = ?")
			.run(summary, repoId, slug) as { changes: number | bigint };
		if (Number(changed.changes) === 0) {
			log.info("topics/index.json names %s but no page row exists — summary dropped", slug);
		}
	}
	if (c.processedSet !== null) {
		const parsed = tryParse<{ processed?: Record<string, string[]> }>(c.processedSet);
		// Skipping keeps the PREVIOUS high-water set, which is the safe direction:
		// re-processing a source is idempotent, where a rolled-back batch would
		// have cost the memories written alongside it. Not an early return — the
		// v5-state write below is an unrelated part of this same batch.
		if (!parsed?.processed) {
			dropUnparsable("processed set", "topics/processed.json");
		} else {
			// The file is the WHOLE high-water mark, so landing it is set
			// replacement — an upsert-only pass could never shrink it.
			db.prepare("DELETE FROM topic_processed_sources WHERE repo_id = ?").run(repoId);
			const insert = db.prepare(
				`INSERT INTO topic_processed_sources (repo_id, source_type, source_id) VALUES (?, ?, ?)
				 ON CONFLICT(repo_id, source_type, source_id) DO NOTHING`,
			);
			for (const [type, ids] of Object.entries(parsed.processed)) {
				for (const id of ids) insert.run(repoId, type, id);
			}
		}
	}
	if (c.v5State !== null) {
		db.prepare(
			`INSERT INTO repo_state (repo_id, key, value) VALUES (?, 'v5-migration', ?)
			 ON CONFLICT(repo_id, key) DO UPDATE SET value = excluded.value`,
		).run(repoId, c.v5State);
	}
	// nowMs deliberately unused here: topic tables carry their own file-borne
	// timestamps (last_updated_at), and inventing a second clock would desync
	// the byte-faithful readback.
	void nowMs;
}

/**
 * Applies one `writeFiles` batch atomically. The caller supplies an OPEN
 * writable handle; this opens the one transaction the whole batch lands in.
 */
export function applyMemoryWrites(
	db: DashboardDbHandle,
	repoId: number,
	files: ReadonlyArray<FileWrite>,
	nowMs: number,
): void {
	const c = classify(files);
	inTransaction(db, () => {
		db.exec("PRAGMA defer_foreign_keys = ON");
		landSummaries(db, repoId, c, nowMs);
		landAliases(db, repoId, c, nowMs);
		const landedTranscripts = landTranscripts(db, repoId, c, nowMs);
		landLinks(db, repoId, c);
		// AFTER landLinks: it replaces the link set of the summaries in this
		// batch, so the backfill must not run first and have its rows deleted.
		backfillLinksForNewTranscripts(db, repoId, c, landedTranscripts);
		landContext(db, repoId, c, nowMs);
		landProgress(db, repoId, c, nowMs);
		landTopics(db, repoId, c, nowMs);
	});
}

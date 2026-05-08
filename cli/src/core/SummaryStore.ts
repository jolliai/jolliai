/**
 * Summary Store Module
 *
 * Stores and retrieves commit summaries from the orphan branch
 * `jollimemory/summaries/v3`. Uses GitOps for all branch operations
 * so we never need to checkout the branch.
 *
 * Storage layout (v3):
 *   summaries/<root-commit-hash>.json  — full summary tree (root + all descendants)
 *   index.json                         — flat index of ALL nodes (root + children)
 *
 * The flat index (v3) records every node in the tree with a `parentCommitHash`
 * field pointing to the direct parent. This enables:
 *   - O(1) lookup for any commit hash (root or child)
 *   - Cross-branch matching via `treeHash` (git code-snapshot hash)
 *   - Cached aliases (`commitAliases`) so repeated lookups skip git calls
 */

import { createLogger } from "../Logger.js";
import type {
	CatalogEntry,
	CatalogTopic,
	CommitCatalog,
	CommitInfo,
	CommitSource,
	CommitSummary,
	CommitType,
	DiffStats,
	E2eTestScenario,
	FileWrite,
	NoteReference,
	PlanProgressArtifact,
	PlanReference,
	StoredTranscript,
	SummaryIndex,
	SummaryIndexEntry,
	TopicSummary,
} from "../Types.js";
import { getDiffStats, getTreeHash } from "./GitOps.js";
import { OrphanBranchStorage } from "./OrphanBranchStorage.js";
import { acquireLock, releaseLock } from "./SessionTracker.js";
import type { StorageProvider } from "./StorageProvider.js";
import type { SquashConsolidationSource } from "./Summarizer.js";
import { getDisplayDate } from "./SummaryFormat.js";
import { collectAllTopics, collectDisplayTopics, countTopics, isUnifiedHoistFormat } from "./SummaryTree.js";

let activeStorageOverride: StorageProvider | undefined;

export function setActiveStorage(storage: StorageProvider | undefined): void {
	activeStorageOverride = storage;
}

export function resolveStorage(storage?: StorageProvider, cwd?: string): StorageProvider {
	return storage ?? activeStorageOverride ?? new OrphanBranchStorage(cwd);
}

const log = createLogger("SummaryStore");

const INDEX_FILE = "index.json";
const CATALOG_FILE = "catalog.json";

/**
 * Returns true if the entry is a root-level summary (not a child of a
 * squash/amend tree). Covers both v3 roots (`null`) and v1 legacy entries
 * (`undefined`) so both branches share one predicate.
 */
function isRootEntry(e: SummaryIndexEntry): boolean {
	return e.parentCommitHash == null;
}

// ─── Public write API ─────────────────────────────────────────────────────────

/**
 * Stores a commit summary in the orphan branch.
 * Writes both the summary file and the updated index in a single atomic commit.
 *
 * In v3, flattens the entire summary tree into index entries (all nodes get
 * their own entry with `parentCommitHash` linking child → parent). On amend,
 * the old root entry naturally becomes a child entry when the new amended
 * summary is stored — no separate `removeFromIndex` call needed.
 *
 * @param summary   - The commit summary to store (root of the tree)
 * @param cwd       - Optional working directory (git repo root)
 * @param force     - When true, overwrites an existing summary for the same commit hash
 *                    instead of skipping (used by the manual `summarize` CLI command)
 * @param artifacts - Optional artifacts to store atomically alongside the summary
 *                    (e.g., transcript data saved as `transcripts/{commitHash}.json`)
 */
export async function storeSummary(
	summary: CommitSummary,
	cwd?: string,
	force = false,
	artifacts?: {
		readonly transcript?: StoredTranscript;
		readonly planProgress?: ReadonlyArray<PlanProgressArtifact>;
	},
): Promise<void> {
	const existingIndex = await loadIndex(cwd);
	const existingCatalog = await loadCatalog(cwd);
	const existingEntries = existingIndex?.entries ? [...existingIndex.entries] : [];
	const entryMap = new Map(existingEntries.map((e) => [e.commitHash, e]));

	// Duplicate guard: skip if root already indexed and force=false
	if (!force && entryMap.has(summary.commitHash)) {
		log.info(
			"Summary for commit %s already exists — skipping (use force to overwrite)",
			summary.commitHash.substring(0, 8),
		);
		return;
	}

	// Flatten the entire tree into index entries and upsert
	const newEntries = await flattenSummaryTree(summary, null, cwd, entryMap);
	for (const entry of newEntries) {
		entryMap.set(entry.commitHash, entry);
	}

	const newIndex: SummaryIndex = {
		version: 3,
		entries: [...entryMap.values()],
		commitAliases: existingIndex?.commitAliases,
	};

	const verb = force ? "Overwrite" : "Add";
	const files: FileWrite[] = [
		{ path: `summaries/${summary.commitHash}.json`, content: JSON.stringify(summary, null, "\t") },
		{ path: INDEX_FILE, content: JSON.stringify(newIndex, null, "\t") },
		buildCatalogFileWrite(existingCatalog, entryMap, summary),
	];

	// Append transcript file if provided
	if (artifacts?.transcript && artifacts.transcript.sessions.length > 0) {
		files.push({
			path: `transcripts/${summary.commitHash}.json`,
			content: JSON.stringify(artifacts.transcript, null, "\t"),
		});
	}

	// Append plan progress files if provided
	if (artifacts?.planProgress) {
		for (const progress of artifacts.planProgress) {
			files.push({
				path: `plan-progress/${progress.planSlug}.json`,
				content: JSON.stringify(progress, null, "\t"),
			});
		}
	}

	const store = resolveStorage(undefined, cwd);
	await store.writeFiles(
		files,
		`${verb} summary for ${summary.commitHash.substring(0, 8)}: ${summary.commitMessage.substring(0, 50)}`,
	);

	log.info("Summary stored successfully for commit %s", summary.commitHash.substring(0, 8));
}

/**
 * Migrates a summary 1:1 (rebase pick path only). Wraps the original summary
 * as a stripped child of a new v4 root carrying Hoisted metadata.
 *
 * **Scope**: rebase pick ONLY. Amend short-circuits write transcript artifacts,
 * which don't fit this signature; they go through `buildHoistedAmendRoot` +
 * `storeSummary` instead.
 *
 * The optional `metadata` parameter carries `commitType` / `commitSource`
 * forward so the migrated summary records who triggered the rebase
 * (VSCode plugin vs CLI). `handleRebasePickFromQueue` passes
 * `commitType: "rebase"` plus the queue entry's `commitSource`, matching
 * how `runSquashPipeline` propagates these fields on squash / amend.
 */
export async function migrateOneToOne(
	oldSummary: CommitSummary,
	newCommitInfo: CommitInfo,
	cwd?: string,
	metadata?: { readonly commitType?: CommitType; readonly commitSource?: CommitSource },
): Promise<void> {
	log.info(
		"Migrating summary 1:1: %s → %s",
		oldSummary.commitHash.substring(0, 8),
		newCommitInfo.hash.substring(0, 8),
	);

	// Wrap the old summary as a child rather than replacing its hash.
	// stripFunctionalMetadata strips all 8 Hoist fields (Copy-Hoist 6 + the
	// new Consolidate-Hoist topics/recap) so the root is solely authoritative.
	const strippedOld = stripFunctionalMetadata(oldSummary);
	const docUrl = oldSummary.jolliDocUrl;

	// Compute the real `git diff {newHash}^..{newHash}` for the persisted `diffStats`
	// field. Rebase-pick preserves the diff of the commit, but the new hash has a
	// different parent so we recompute to be safe.
	const migratedDiffStats: DiffStats = await getDiffStats(`${newCommitInfo.hash}^`, newCommitInfo.hash, cwd).catch(
		(): DiffStats => ({ filesChanged: 0, insertions: 0, deletions: 0 }),
	);

	// Legacy-aware Copy-Hoist of topics: v4 returns root.topics; v3 (legacy
	// squash / legacy amend) flattens via collectAllTopics so no data drops.
	const hoistedTopics = resolveEffectiveTopics(oldSummary);

	const newSummary: CommitSummary = {
		version: 4,
		commitHash: newCommitInfo.hash,
		commitMessage: newCommitInfo.message,
		commitAuthor: newCommitInfo.author,
		commitDate: newCommitInfo.date,
		branch: oldSummary.branch,
		generatedAt: new Date().toISOString(),
		commitType: metadata?.commitType ?? "rebase",
		...(metadata?.commitSource && { commitSource: metadata.commitSource }),
		...(oldSummary.ticketId && { ticketId: oldSummary.ticketId }),
		...(oldSummary.jolliDocId && { jolliDocId: oldSummary.jolliDocId }),
		...(docUrl && { jolliDocUrl: docUrl }),
		...(oldSummary.orphanedDocIds && { orphanedDocIds: oldSummary.orphanedDocIds }),
		...(oldSummary.plans && { plans: oldSummary.plans }),
		...(oldSummary.notes && { notes: oldSummary.notes }),
		...(oldSummary.e2eTestGuide && { e2eTestGuide: oldSummary.e2eTestGuide }),
		topics: hoistedTopics,
		...(oldSummary.recap && { recap: oldSummary.recap }),
		diffStats: migratedDiffStats,
		children: [strippedOld],
	};

	const existingIndex = await loadIndex(cwd);
	const existingCatalog = await loadCatalog(cwd);
	const existingEntries = existingIndex?.entries ? [...existingIndex.entries] : [];
	const entryMap = new Map(existingEntries.map((e) => [e.commitHash, e]));

	// Skip if new hash already in index (idempotency guard)
	if (entryMap.has(newCommitInfo.hash)) {
		log.info("New hash %s already in index, skipping migration", newCommitInfo.hash.substring(0, 8));
		return;
	}

	// Flatten the new summary tree (newHash root + oldHash as child + all grandchildren)
	const newEntries = await flattenSummaryTree(newSummary, null, cwd, entryMap);
	for (const entry of newEntries) {
		entryMap.set(entry.commitHash, entry);
	}

	const newIndex: SummaryIndex = {
		version: 3,
		entries: [...entryMap.values()],
		commitAliases: existingIndex?.commitAliases,
	};

	const files: FileWrite[] = [
		{ path: `summaries/${newSummary.commitHash}.json`, content: JSON.stringify(newSummary, null, "\t") },
		{ path: INDEX_FILE, content: JSON.stringify(newIndex, null, "\t") },
		buildCatalogFileWrite(existingCatalog, entryMap, newSummary),
	];

	const store = resolveStorage(undefined, cwd);
	await store.writeFiles(
		files,
		`Migrate summary ${oldSummary.commitHash.substring(0, 8)} → ${newCommitInfo.hash.substring(0, 8)}`,
	);
	log.info("Summary migrated: %s → %s", oldSummary.commitHash.substring(0, 8), newCommitInfo.hash.substring(0, 8));
}

/** Recursively collects all E2E test scenarios from a list of summaries. */
function collectChildE2eScenarios(nodes: ReadonlyArray<CommitSummary>): ReadonlyArray<E2eTestScenario> {
	const scenarios: E2eTestScenario[] = [];
	for (const node of nodes) {
		if (node.e2eTestGuide) scenarios.push(...node.e2eTestGuide);
		if (node.children) scenarios.push(...collectChildE2eScenarios(node.children));
	}
	return scenarios;
}

/** Returns a deep copy of the summary tree with e2eTestGuide stripped from all nodes. */
function stripE2eTestGuide(node: CommitSummary): CommitSummary {
	const { e2eTestGuide: _, ...rest } = node;
	if (!rest.children) return rest as CommitSummary;
	return { ...rest, children: rest.children.map(stripE2eTestGuide) } as CommitSummary;
}

/** Recursively collects all PlanReferences from a list of summaries, deduped by slug. */
function collectChildPlans(nodes: ReadonlyArray<CommitSummary>): ReadonlyArray<PlanReference> {
	const planMap = new Map<string, PlanReference>();
	for (const node of nodes) {
		if (node.plans) {
			for (const plan of node.plans) {
				const key = plan.slug;
				const existing = planMap.get(key);
				if (!existing || plan.updatedAt > existing.updatedAt) {
					planMap.set(key, plan);
				}
			}
		}
		if (node.children) {
			for (const child of collectChildPlans(node.children)) {
				const existing = planMap.get(child.slug);
				if (!existing || child.updatedAt > existing.updatedAt) {
					planMap.set(child.slug, child);
				}
			}
		}
	}
	return [...planMap.values()];
}

/** Returns a deep copy of the summary tree with plans stripped from all nodes. */
function stripPlans(node: CommitSummary): CommitSummary {
	const { plans: _, ...rest } = node;
	if (!rest.children) return rest as CommitSummary;
	return { ...rest, children: rest.children.map(stripPlans) } as CommitSummary;
}

/** Recursively collects all NoteReferences from a list of summaries, deduped by id. */
function collectChildNotes(nodes: ReadonlyArray<CommitSummary>): ReadonlyArray<NoteReference> {
	const noteMap = new Map<string, NoteReference>();
	for (const node of nodes) {
		if (node.notes) {
			for (const note of node.notes) {
				const existing = noteMap.get(note.id);
				if (!existing || note.updatedAt > existing.updatedAt) {
					noteMap.set(note.id, note);
				}
			}
		}
		if (node.children) {
			for (const child of collectChildNotes(node.children)) {
				const existing = noteMap.get(child.id);
				if (!existing || child.updatedAt > existing.updatedAt) {
					noteMap.set(child.id, child);
				}
			}
		}
	}
	return [...noteMap.values()];
}

/** Returns a deep copy of the summary tree with notes stripped from all nodes. */
function stripNotes(node: CommitSummary): CommitSummary {
	const { notes: _, ...rest } = node;
	if (!rest.children) return rest as CommitSummary;
	return { ...rest, children: rest.children.map(stripNotes) } as CommitSummary;
}

/** Returns a deep copy of the summary tree with Jolli metadata stripped from all nodes. */
function stripJolliMetadata(node: CommitSummary): CommitSummary {
	const { jolliDocId: _d, jolliDocUrl: _u, orphanedDocIds: _o, ...rest } = node;
	if (!rest.children) return rest as CommitSummary;
	return { ...rest, children: rest.children.map(stripJolliMetadata) } as CommitSummary;
}

/** Hoist result for Jolli memory article metadata from children. */
interface JolliMetaHoistResult {
	/**
	 * The most recent descendant's Jolli metadata (to hoist to merged root), or null if no
	 * candidates were found. Carries the winner's own commitDate/generatedAt so that when a
	 * caller re-enters the winner into a higher-level competition, the dates that drove the
	 * inner victory (e.g. a just-amended grandchild) are the dates compared at the outer level.
	 */
	readonly winner: {
		readonly jolliDocId: number;
		readonly jolliDocUrl: string;
		readonly commitDate: string;
		readonly generatedAt: string;
	} | null;
	/** Memory article docIds from children that were NOT selected as winner (orphaned articles to delete). */
	readonly orphanedDocIds: number[];
}

/** Recursively collects jolliDocId/jolliDocUrl from children, picks newest as winner. */
function collectChildJolliMeta(nodes: ReadonlyArray<CommitSummary>): JolliMetaHoistResult {
	const candidates: Array<{ jolliDocId: number; jolliDocUrl: string; commitDate: string; generatedAt: string }> = [];
	for (const node of nodes) {
		const url = node.jolliDocUrl;
		if (node.jolliDocId && url) {
			candidates.push({
				jolliDocId: node.jolliDocId,
				jolliDocUrl: url,
				commitDate: node.commitDate,
				generatedAt: node.generatedAt,
			});
		}
		if (node.children) {
			const childResult = collectChildJolliMeta(node.children);
			if (childResult.winner) {
				candidates.push({ ...childResult.winner });
			}
			// Child orphans are always orphaned (they lost in a deeper merge)
			// but we don't collect them here — they were already handled by the deeper merge
		}
	}
	if (candidates.length === 0) return { winner: null, orphanedDocIds: [] };

	// Sort by activity date (getDisplayDate) descending so amend/rebase-updated children
	// win over siblings with newer author-dates.
	candidates.sort((a, b) => new Date(getDisplayDate(b)).getTime() - new Date(getDisplayDate(a)).getTime());
	const winner = candidates[0];
	const orphanedDocIds = candidates.slice(1).map((c) => c.jolliDocId);
	return { winner, orphanedDocIds };
}

/** Returns a deep copy of the summary tree with topics stripped from all nodes. */
function stripTopics(node: CommitSummary): CommitSummary {
	const { topics: _, ...rest } = node;
	if (!rest.children) return rest as CommitSummary;
	return { ...rest, children: rest.children.map(stripTopics) } as CommitSummary;
}

/** Returns a deep copy of the summary tree with recap stripped from all nodes. */
function stripRecap(node: CommitSummary): CommitSummary {
	const { recap: _, ...rest } = node;
	if (!rest.children) return rest as CommitSummary;
	return { ...rest, children: rest.children.map(stripRecap) } as CommitSummary;
}

// --- Legacy-aware Hoist input helpers ----------------------------------------

/**
 * Returns the topics array to use as Copy-Hoist source when migrating
 * `oldSummary` to a new hash (rebase pick, amend short-circuits).
 *
 * - v4 root (unified Hoist format): root is authoritative -- return its
 *   topics directly (may legitimately be []).
 * - v3 root (legacy data): topics may be on root, on children, or split
 *   across both (e.g. legacy amend root carries delta topics on root and
 *   pre-amend topics on its child). Use collectAllTopics to gather everything,
 *   then strip the runtime decorations (commitDate / generatedAt) added by it.
 *
 * Discriminator is `version` via isUnifiedHoistFormat -- not topics.length.
 * "topics.length > 0" was the original draft and was rejected because it
 * mishandles legacy amend (would mistreat as v4 and lose pre-amend) and
 * v4 recap-only commits (would mistreat as legacy and recurse into stripped
 * children, losing the recap).
 */
export function resolveEffectiveTopics(oldSummary: CommitSummary): ReadonlyArray<TopicSummary> {
	if (isUnifiedHoistFormat(oldSummary)) return oldSummary.topics ?? [];
	return collectAllTopics(oldSummary).map(({ commitDate: _cd, generatedAt: _ga, treeIndex: _ti, ...topic }) => topic);
}

/**
 * Returns SquashConsolidationSource[] suitable for feeding into
 * generateSquashConsolidation. Unlike resolveEffectiveTopics this preserves
 * commit-level grouping for the LLM (so it can apply rule 4's supersede
 * evidence standard); flat aggregation would lose the chronological signal.
 *
 * - v4 root: returns a single source built from root itself (root is
 *   authoritative; topics may be [] for recap-only commits).
 * - v3 squash root: returns one source per original child commit.
 * - v3 amend root: same as squash root, BUT the root itself ALSO contributed
 *   own topics (delta topics). Append it as its own latest source so the
 *   delta data isn't lost. This is the v3 amend form of issue #1 in the plan.
 *
 * Caller does NOT need to sort the result -- generateSquashConsolidation /
 * mechanicalConsolidate sort sources oldest-first internally.
 */
export function expandSourcesForConsolidation(oldSummary: CommitSummary): ReadonlyArray<SquashConsolidationSource> {
	if (isUnifiedHoistFormat(oldSummary)) {
		return [
			{
				commitHash: oldSummary.commitHash,
				commitMessage: oldSummary.commitMessage,
				commitDate: oldSummary.commitDate,
				...(oldSummary.ticketId && { ticketId: oldSummary.ticketId }),
				topics: oldSummary.topics ?? [],
				...(oldSummary.recap && { recap: oldSummary.recap }),
			},
		];
	}

	const childSources: SquashConsolidationSource[] = (oldSummary.children ?? []).map((child) => ({
		commitHash: child.commitHash,
		commitMessage: child.commitMessage,
		commitDate: child.commitDate,
		...(child.ticketId && { ticketId: child.ticketId }),
		topics: resolveEffectiveTopics(child),
		...(child.recap && { recap: child.recap }),
	}));

	// Legacy amend root carries delta topics/recap on root itself; append it
	// as its own source so the delta isn't lost. (This branch matters for v3
	// data; v4 amend roots would have been caught by the early-return above.)
	const rootHasOwnData = (oldSummary.topics?.length ?? 0) > 0 || !!oldSummary.recap;
	if (rootHasOwnData) {
		childSources.push({
			commitHash: oldSummary.commitHash,
			commitMessage: oldSummary.commitMessage,
			commitDate: oldSummary.commitDate,
			...(oldSummary.ticketId && { ticketId: oldSummary.ticketId }),
			topics: oldSummary.topics ?? [],
			...(oldSummary.recap && { recap: oldSummary.recap }),
		});
	}

	return childSources;
}

/**
 * Strips all 8 Hoist-managed fields from a summary node and its descendants.
 *
 * Hoist family (8 fields):
 *   - Copy-Hoist (6): jolliDocId, jolliDocUrl, orphanedDocIds, plans, notes, e2eTestGuide
 *   - Consolidate-Hoist (2): topics, recap
 *
 * `version` is intentionally NOT stripped -- it's an identity field, like
 * commitHash. A v4 root may legitimately contain a v3 stripped child (legacy
 * data on first migration); helpers always look at the root's own version.
 */
export function stripFunctionalMetadata(node: CommitSummary): CommitSummary {
	return stripJolliMetadata(stripNotes(stripPlans(stripE2eTestGuide(stripTopics(stripRecap(node))))));
}

/**
 * Result of squash consolidation passed into mergeManyToOne. Pure data shape;
 * source is either generateSquashConsolidation (LLM path) or
 * mechanicalConsolidate (fallback). The Hoist invariant requires the root to
 * always carry a topics array (possibly empty) and an optional recap, so
 * mergeManyToOne always receives this object -- there is no "container mode"
 * branch where the root has no topics.
 */
export interface ConsolidatedTopics {
	readonly topics: ReadonlyArray<TopicSummary>;
	readonly recap?: string;
	readonly ticketId?: string;
	readonly llm?: import("../Types.js").LlmCallMetadata;
}

/**
 * Merges multiple summaries into one (for rebase squash/fixup and git merge --squash).
 * Places all source summaries as `children` sorted by commitDate descending (newest first).
 *
 * `consolidated` carries the LLM-consolidated (or mechanically-consolidated)
 * topics + recap + ticketId. The Hoist invariant: the root ALWAYS carries
 * topics (possibly empty), and children are stripped via stripFunctionalMetadata.
 *
 * E2E test guides, plans, notes, jolliDoc metadata are still hoisted from
 * children via the existing collect* helpers; that part of the contract is
 * unchanged. The new piece is topics/recap going in via `consolidated`.
 */
export async function mergeManyToOne(
	oldSummaries: ReadonlyArray<CommitSummary>,
	newCommitInfo: CommitInfo,
	cwd?: string,
	metadata?: { readonly commitType?: CommitType; readonly commitSource?: CommitSource },
	consolidated?: ConsolidatedTopics,
): Promise<{ orphanedDocIds: number[] }> {
	log.info("Merging %d summaries into %s", oldSummaries.length, newCommitInfo.hash.substring(0, 8));

	// Sort children by activity date descending (newest first) via getDisplayDate.
	const children = [...oldSummaries].sort(
		(a, b) => new Date(getDisplayDate(b)).getTime() - new Date(getDisplayDate(a)).getTime(),
	);

	// Hoist functional-level metadata from children into the merged root:
	// - E2E test guides: describe the final merged result's test plan
	// - Plans: describe the feature's implementation strategy
	// - Notes: user-created notes (snippets, markdown) associated with commits
	// - Jolli memory article metadata (docId/URL): stable server ID for direct update
	// - orphanedDocIds: accumulated memory article IDs pending cleanup on next push
	// - topics/recap: from `consolidated` (LLM or mechanical); see ConsolidatedTopics.
	const hoistedE2e = collectChildE2eScenarios(children);
	const hoistedPlans = collectChildPlans(children);
	const hoistedNotes = collectChildNotes(children);
	const jolliMeta = collectChildJolliMeta(children);
	const inheritedOrphanIds = children.flatMap((c) => c.orphanedDocIds ?? []);
	const allOrphanedDocIds = [...jolliMeta.orphanedDocIds, ...inheritedOrphanIds];
	const strippedChildren = children.map(stripFunctionalMetadata);

	// Compute the real `git diff {squashHash}^..{squashHash}` for the persisted
	// `diffStats` field. This is what the display layer reads — eliminates the need
	// for the recursive children aggregation that previously over-counted files
	// modified by multiple source commits.
	const mergedDiffStats: DiffStats = await getDiffStats(`${newCommitInfo.hash}^`, newCommitInfo.hash, cwd).catch(
		(): DiffStats => ({ filesChanged: 0, insertions: 0, deletions: 0 }),
	);

	// Default to empty topics + no recap when caller doesn't pass `consolidated`.
	// Production callers (runSquashPipeline) always pass a value built from
	// generateSquashConsolidation (LLM path) or mechanicalConsolidate (fallback),
	// so the root always carries authoritative consolidated topics + recap.
	const consolidatedTopics = consolidated?.topics ?? [];
	const consolidatedRecap = consolidated?.recap;
	const consolidatedTicketId = consolidated?.ticketId;
	const consolidatedLlm = consolidated?.llm;

	const mergedSummary: CommitSummary = {
		version: 4,
		commitHash: newCommitInfo.hash,
		commitMessage: newCommitInfo.message,
		commitAuthor: newCommitInfo.author,
		commitDate: newCommitInfo.date,
		branch: oldSummaries[0].branch,
		generatedAt: new Date().toISOString(),
		...(metadata?.commitType && { commitType: metadata.commitType }),
		...(metadata?.commitSource && { commitSource: metadata.commitSource }),
		...(consolidatedTicketId && { ticketId: consolidatedTicketId }),
		...(consolidatedLlm && { llm: consolidatedLlm }),
		...(hoistedE2e.length > 0 && { e2eTestGuide: hoistedE2e }),
		...(hoistedPlans.length > 0 && { plans: hoistedPlans }),
		...(hoistedNotes.length > 0 && { notes: hoistedNotes }),
		...(jolliMeta.winner && { jolliDocId: jolliMeta.winner.jolliDocId, jolliDocUrl: jolliMeta.winner.jolliDocUrl }),
		...(allOrphanedDocIds.length > 0 && { orphanedDocIds: allOrphanedDocIds }),
		topics: consolidatedTopics,
		...(consolidatedRecap && { recap: consolidatedRecap }),
		diffStats: mergedDiffStats,
		children: strippedChildren,
	};

	const existingIndex = await loadIndex(cwd);
	const existingCatalog = await loadCatalog(cwd);
	const existingEntries = existingIndex?.entries ? [...existingIndex.entries] : [];
	const entryMap = new Map(existingEntries.map((e) => [e.commitHash, e]));

	// Skip if new hash already in index (idempotency guard)
	if (entryMap.has(newCommitInfo.hash)) {
		log.info("New hash %s already in index, skipping merge", newCommitInfo.hash.substring(0, 8));
		return { orphanedDocIds: [] };
	}

	// Flatten the merged summary tree (all old summaries + their children become entries)
	const newEntries = await flattenSummaryTree(mergedSummary, null, cwd, entryMap);
	for (const entry of newEntries) {
		entryMap.set(entry.commitHash, entry);
	}

	const newIndex: SummaryIndex = {
		version: 3,
		entries: [...entryMap.values()],
		commitAliases: existingIndex?.commitAliases,
	};

	const oldHashesStr = oldSummaries.map((s) => s.commitHash.substring(0, 8)).join(", ");
	const files: FileWrite[] = [
		{ path: `summaries/${mergedSummary.commitHash}.json`, content: JSON.stringify(mergedSummary, null, "\t") },
		{ path: INDEX_FILE, content: JSON.stringify(newIndex, null, "\t") },
		buildCatalogFileWrite(existingCatalog, entryMap, mergedSummary),
	];

	const store = resolveStorage(undefined, cwd);
	await store.writeFiles(files, `Merge summaries [${oldHashesStr}] → ${newCommitInfo.hash.substring(0, 8)}`);
	log.info(
		"Summaries merged: [%s] → %s (%d children, %d orphaned docs)",
		oldHashesStr,
		newCommitInfo.hash.substring(0, 8),
		children.length,
		allOrphanedDocIds.length,
	);
	return { orphanedDocIds: allOrphanedDocIds };
}

/**
 * Removes a commit's entry from the index without deleting its summary file.
 *
 * **WARNING — v3 restriction**: Do NOT call this in amend or rebase/migration flows.
 * In v3, `storeSummary` upsert already reclassifies old entries as children by updating
 * their `parentCommitHash`. Calling this afterward would delete an entry whose children
 * still reference it as their `parentCommitHash`, breaking the chain for `getSummary`.
 *
 * Use only for admin cleanup of truly orphaned root entries.
 */
export async function removeFromIndex(commitHash: string, cwd?: string): Promise<void> {
	// Acquire the shared lock before touching index/catalog: this function
	// performs a multi-file write that races with QueueWorker / scanTreeHashAliases
	// / storeSummary if unsynchronized. Loading the data inside the lock window
	// guarantees we operate on the most recent on-disk state.
	const locked = await acquireLock(cwd);
	if (!locked) {
		log.warn("removeFromIndex: could not acquire lock — skipping removal of %s", commitHash.substring(0, 8));
		return;
	}
	try {
		const existingIndex = await loadIndex(cwd);
		if (!existingIndex) {
			return;
		}

		const filtered = existingIndex.entries.filter((e) => e.commitHash !== commitHash);
		if (filtered.length === existingIndex.entries.length) {
			return;
		}

		const newIndex: SummaryIndex = {
			version: existingIndex.version,
			entries: filtered,
			commitAliases: existingIndex.commitAliases,
		};
		const files: FileWrite[] = [{ path: INDEX_FILE, content: JSON.stringify(newIndex, null, "\t") }];

		// Keep catalog aligned: drop the entry for this hash if catalog tracks it.
		const existingCatalog = await loadCatalog(cwd);
		const catalogWrite = buildCatalogRemoveFileWrite(existingCatalog, commitHash);
		if (catalogWrite) {
			files.push(catalogWrite);
		}

		const store = resolveStorage(undefined, cwd);
		await store.writeFiles(files, `Remove index entry for ${commitHash.substring(0, 8)}`);
		log.info("Removed %s from index", commitHash.substring(0, 8));
	} finally {
		await releaseLock(cwd);
	}
}

// ─── Transcript API ──────────────────────────────────────────────────────────

/**
 * Reads a transcript for a specific commit from the orphan branch.
 * Returns null if no transcript file exists for the given commit hash.
 */
export async function readTranscript(commitHash: string, cwd?: string): Promise<StoredTranscript | null> {
	const store = resolveStorage(undefined, cwd);
	const raw = await store.readFile(`transcripts/${commitHash}.json`);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as StoredTranscript;
	} catch {
		log.warn("Failed to parse transcript for %s", commitHash.substring(0, 8));
		return null;
	}
}

/**
 * Reads transcripts for multiple commits in sequence.
 * Returns a map of commitHash → StoredTranscript (only includes commits that have transcripts).
 */
export async function readTranscriptsForCommits(
	commitHashes: ReadonlyArray<string>,
	cwd?: string,
): Promise<Map<string, StoredTranscript>> {
	const result = new Map<string, StoredTranscript>();
	for (const hash of commitHashes) {
		const transcript = await readTranscript(hash, cwd);
		if (transcript) {
			result.set(hash, transcript);
		}
	}
	return result;
}

/**
 * Batch write and/or delete transcript files in a single atomic git commit.
 *
 * @param writes  - Transcripts to write (commitHash + data pairs)
 * @param deletes - Commit hashes whose transcript files should be removed
 * @param cwd     - Optional working directory
 */
export async function saveTranscriptsBatch(
	writes: ReadonlyArray<{ readonly hash: string; readonly data: StoredTranscript }>,
	deletes: ReadonlyArray<string>,
	cwd?: string,
): Promise<void> {
	const files: FileWrite[] = [];

	for (const { hash, data } of writes) {
		files.push({
			path: `transcripts/${hash}.json`,
			content: JSON.stringify(data, null, "\t"),
		});
	}
	for (const hash of deletes) {
		files.push({
			path: `transcripts/${hash}.json`,
			content: "",
			delete: true,
		});
	}

	if (files.length === 0) return;

	const summary = [
		writes.length > 0 ? `${writes.length} written` : "",
		deletes.length > 0 ? `${deletes.length} deleted` : "",
	]
		.filter(Boolean)
		.join(", ");

	const store = resolveStorage(undefined, cwd);
	await store.writeFiles(files, `Update transcripts: ${summary}`);
	log.info("Transcript batch: %s", summary);
}

/**
 * Deletes a single transcript file from the orphan branch.
 */
export async function deleteTranscript(commitHash: string, cwd?: string): Promise<void> {
	await saveTranscriptsBatch([], [commitHash], cwd);
}

/**
 * Returns the set of commit hashes that have transcript files in the orphan branch.
 * Scans the `transcripts/` prefix via the active storage provider.
 */
export async function getTranscriptHashes(cwd?: string): Promise<Set<string>> {
	const store = resolveStorage(undefined, cwd);
	const files = await store.listFiles("transcripts/");
	const hashes = new Set<string>();
	for (const filePath of files) {
		// filePath = "transcripts/abc123.json" → extract "abc123"
		const match = filePath.match(/^transcripts\/([a-f0-9]+)\.json$/);
		if (match) {
			hashes.add(match[1]);
		}
	}
	return hashes;
}

// ─── Public read API ──────────────────────────────────────────────────────────

/**
 * Retrieves a summary for a specific commit hash.
 *
 * Lookup order:
 * 1. **Direct file read** (`summaries/{commitHash}.json`). Works for any hash
 *    that was ever a root at write time. This is the primary path -- it
 *    bypasses the index entirely and returns the commit's ORIGINAL summary
 *    rather than the (potentially stripped) version embedded in a squash root.
 *    Storage invariant: `mergeManyToOne` / `migrateOneToOne` never delete the
 *    old `summaries/{oldHash}.json` files, so every hash that entered the
 *    system keeps its own file.
 * 2. **Alias / treeHash fallback**: when direct read misses, check the index
 *    for cross-branch aliases (cached + on-the-fly tree-hash matching). Used
 *    when the caller passes a hash that isn't a recorded root, e.g. a commit
 *    on a different branch that shares a tree hash with a recorded one.
 *
 * Direct file read intentionally bypasses the embedded child view: under the
 * unified Hoist strip, embedded children no longer carry topics/recap, so
 * returning them would silently degrade results.
 *
 * Returns null if no summary exists for that commit.
 */
export async function getSummary(
	commitHash: string,
	cwd?: string,
	storage?: StorageProvider,
): Promise<CommitSummary | null> {
	// Step 1: Direct file read -- works for any hash that was ever indexed.
	const direct = await readSummaryFile(commitHash, cwd, storage);
	if (direct) return direct;

	// Step 2: Cross-branch fallback via aliases / tree hash.
	const index = await loadIndex(cwd, storage);
	if (!index) return null;

	const aliasHash = index.commitAliases?.[commitHash];
	if (aliasHash) {
		return readSummaryFile(aliasHash, cwd, storage);
	}

	if (index.version === 3) {
		const treeHash = await getTreeHash(commitHash, cwd);
		/* v8 ignore start -- tree hash fallback: requires real git repo */
		if (treeHash) {
			const entryMap = new Map(index.entries.map((e) => [e.commitHash, e]));
			const matchEntry = findShallowstByTreeHash(treeHash, index.entries, entryMap);
			if (matchEntry) {
				return readSummaryFile(matchEntry.commitHash, cwd, storage);
			}
		}
		/* v8 ignore stop */
	}

	return null;
}

/**
 * Lists recent root-level summaries, ordered by date (newest first).
 * In v3, only top-level entries (parentCommitHash == null) are listed.
 *
 * @param count - Maximum number of summaries to return (default: 10)
 * @param cwd - Optional working directory
 */
export async function listSummaries(
	count = 10,
	cwd?: string,
	storage?: StorageProvider,
): Promise<ReadonlyArray<CommitSummary>> {
	const index = await loadIndex(cwd, storage);
	if (!index || index.entries.length === 0) {
		return [];
	}

	// Only top-level roots (null = v3 root; undefined = v1 legacy entry treated as root)
	const rootEntries = index.entries.filter(isRootEntry);

	// Sort explicitly by getDisplayDate descending (newest activity first).
	// Previously relied on Map insertion order via slice(-count).reverse(), which
	// is fragile — amend/squash/rebase may re-shuffle entries.
	const sortedEntries = [...rootEntries].sort(
		(a, b) => new Date(getDisplayDate(b)).getTime() - new Date(getDisplayDate(a)).getTime(),
	);
	const recentEntries = sortedEntries.slice(0, count);

	// Load full summaries for each root entry
	const summaries: CommitSummary[] = [];
	for (const entry of recentEntries) {
		const summary = await getSummary(entry.commitHash, cwd, storage);
		if (summary) {
			summaries.push(summary);
		}
	}

	return summaries;
}

/**
 * Returns a Set of all commit hashes that have stored summaries.
 * Includes all nodes (roots and children) plus any cached aliases.
 * Lightweight — reads only the index file.
 */
export async function listSummaryHashes(cwd?: string): Promise<ReadonlySet<string>> {
	const index = await loadIndex(cwd);
	if (!index || index.entries.length === 0) {
		return new Set();
	}

	const hashes = new Set(index.entries.map((e) => e.commitHash));

	// Also include alias keys so unrecognized hashes that were previously matched return true
	if (index.commitAliases) {
		for (const aliasKey of Object.keys(index.commitAliases)) {
			hashes.add(aliasKey);
		}
	}

	return hashes;
}

/**
 * Returns a map of commit hash → SummaryIndexEntry for all entries in the index,
 * plus resolved commit aliases. This allows callers to perform O(1) lookups and
 * read cached display-level metadata (topicCount, diffStats, commitType) without
 * loading individual summary files.
 *
 * @param cwd - Optional working directory
 * @returns A Map keyed by commit hash (including aliases), or an empty Map if no index exists
 */
export async function getIndexEntryMap(
	cwd?: string,
	storage?: StorageProvider,
): Promise<ReadonlyMap<string, SummaryIndexEntry>> {
	const index = await loadIndex(cwd, storage);
	if (!index) return new Map();

	const map = new Map<string, SummaryIndexEntry>(index.entries.map((e) => [e.commitHash, e]));

	// Resolve commit aliases so callers can look up by aliased hash too
	if (index.commitAliases) {
		for (const [aliasHash, targetHash] of Object.entries(index.commitAliases)) {
			const entry = map.get(targetHash);
			if (entry && !map.has(aliasHash)) {
				map.set(aliasHash, entry);
			}
		}
	}

	return map;
}

/**
 * Scans a list of commit hashes (expected to lack summaries) for tree hash matches.
 * For each unmatched hash, calls `git cat-file` to get its tree hash and checks whether
 * any existing index entry shares the same tree hash (cross-branch matching).
 *
 * When a match is found:
 * - Persists the `commitHash → matchedHash` alias in `index.commitAliases`
 * - Returns `true` so callers can trigger a panel refresh
 *
 * Tie-break when multiple entries share the same tree hash:
 * - Select the shallowest node (fewest ancestors via parentCommitHash chain)
 * - Same depth → most recent commitDate wins
 *
 * Designed to run as a background fire-and-forget scan from `listBranchCommits`.
 *
 * @returns `true` if any new aliases were written, `false` otherwise
 */
export async function scanTreeHashAliases(
	commitHashes: string[],
	cwd?: string,
	storage?: StorageProvider,
): Promise<boolean> {
	const index = await loadIndex(cwd, storage);
	if (!index || index.version !== 3) return false;

	const existingAliases = { ...(index.commitAliases ?? {}) };
	const entryHashSet = new Set(index.entries.map((e) => e.commitHash));
	const entryMap = new Map(index.entries.map((e) => [e.commitHash, e]));

	const newAliases: Record<string, string> = {};

	for (const hash of commitHashes) {
		// Skip if already known directly or via alias
		if (entryHashSet.has(hash) || existingAliases[hash]) continue;

		const treeHash = await getTreeHash(hash, cwd);
		if (!treeHash) continue;

		/* v8 ignore start -- tree hash match: requires real git repo with matching tree hashes */
		const matchEntry = findShallowstByTreeHash(treeHash, index.entries, entryMap);
		if (matchEntry) {
			newAliases[hash] = matchEntry.commitHash;
			log.info(
				"Tree hash match: %s → %s (treeHash: %s)",
				hash.substring(0, 8),
				matchEntry.commitHash.substring(0, 8),
				treeHash.substring(0, 8),
			);
		}
		/* v8 ignore stop */
	}

	if (Object.keys(newAliases).length === 0) return false;

	// Acquire the shared lock before writing to the orphan branch.
	// The Worker holds the same lock during summarization, and migrations hold
	// it too — skipping the write here is safe since the next UI refresh will retry.
	const locked = await acquireLock(cwd);
	if (!locked) {
		log.warn("scanTreeHashAliases: could not acquire lock — alias write deferred");
		return false;
	}
	try {
		const mergedAliases = { ...existingAliases, ...newAliases };
		const newIndex: SummaryIndex = { ...index, commitAliases: mergedAliases };
		const files: FileWrite[] = [{ path: INDEX_FILE, content: JSON.stringify(newIndex, null, "\t") }];
		const store = resolveStorage(storage, cwd);
		await store.writeFiles(files, `Add ${Object.keys(newAliases).length} tree hash alias(es)`);
	} finally {
		await releaseLock(cwd);
	}

	return true;
}

/**
 * Returns the total number of root-level summaries (excludes child nodes
 * from squash/amend trees). Uses the index for accurate counting so the
 * result matches the Memories panel and CLI `view` list.
 */
export async function getSummaryCount(cwd?: string): Promise<number> {
	const index = await loadIndex(cwd);
	if (!index) {
		return 0;
	}
	return index.entries.filter(isRootEntry).length;
}

/**
 * Returns true if the current index needs migration to v3 flat format.
 * A v1 index (all entries lack `parentCommitHash`) should be migrated.
 */
export async function indexNeedsMigration(cwd?: string): Promise<boolean> {
	const index = await loadIndex(cwd);
	if (!index || index.entries.length === 0) return false;
	return index.version !== 3;
}

/**
 * Migrates a v1 index to v3 flat format.
 * For each top-level summary, loads the full JSON tree and flattens it into index entries.
 * Calls `getTreeHash` for each node to populate `treeHash` fields.
 *
 * All orphan branch writes use the shared lock (callers must hold `acquireLock` before calling).
 */
export async function migrateIndexToV3(cwd?: string): Promise<{ migrated: number; skipped: number }> {
	const existingIndex = await loadIndex(cwd);
	if (!existingIndex) {
		log.info("No index found — nothing to migrate");
		return { migrated: 0, skipped: 0 };
	}

	if (existingIndex.version === 3) {
		log.info("Index already at v3 — skipping migration");
		return { migrated: 0, skipped: 0 };
	}

	let migrated = 0;
	let skipped = 0;

	const newEntryMap = new Map<string, SummaryIndexEntry>();
	// Opportunistically (re)build catalog.json during v1→v3 migration since we're
	// loading every root summary anyway. Avoids a separate bootstrap pass on first
	// /jolli-search after migration.
	const catalogEntries: CatalogEntry[] = [];

	for (const entry of existingIndex.entries) {
		// In v1, all entries are top-level (no parentCommitHash field)
		const summaryContent = await readSummaryFile(entry.commitHash, cwd);
		if (!summaryContent) {
			log.warn("Could not load summary for %s — skipping", entry.commitHash.substring(0, 8));
			skipped++;
			continue;
		}

		try {
			// Flatten the tree: root gets parentCommitHash=null, children get parentCommitHash=parent
			const flatEntries = await flattenSummaryTree(summaryContent, null, cwd);
			for (const flatEntry of flatEntries) {
				newEntryMap.set(flatEntry.commitHash, flatEntry);
			}
			catalogEntries.push(toCatalogEntry(summaryContent));
			migrated++;
		} catch (err) {
			log.warn("Failed to flatten summary for %s: %s", entry.commitHash.substring(0, 8), (err as Error).message);
			skipped++;
		}
	}

	const newIndex: SummaryIndex = {
		version: 3,
		entries: [...newEntryMap.values()],
	};

	const newCatalog: CommitCatalog = { version: 1, entries: catalogEntries };

	const files: FileWrite[] = [
		{ path: INDEX_FILE, content: JSON.stringify(newIndex, null, "\t") },
		{ path: CATALOG_FILE, content: JSON.stringify(newCatalog, null, "\t") },
	];
	const store = resolveStorage(undefined, cwd);
	await store.writeFiles(files, `Migrate index v1 → v3 (${migrated} entries)`);

	log.info("Index migrated to v3: %d migrated, %d skipped", migrated, skipped);
	return { migrated, skipped };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Recursively flattens a CommitSummary tree into a list of SummaryIndexEntry objects.
 * Each node gets its own entry; `parentCommitHash` links child → direct parent.
 *
 * `getTreeHash()` returning null (e.g. commit no longer in object store) is not fatal —
 * the entry is written without a `treeHash` field and processing continues.
 */
async function flattenSummaryTree(
	node: CommitSummary,
	parentCommitHash: string | null,
	cwd?: string,
	existingEntryMap?: ReadonlyMap<string, SummaryIndexEntry>,
): Promise<SummaryIndexEntry[]> {
	const treeHash = (await getTreeHash(node.commitHash, cwd)) ?? undefined;
	const isRoot = parentCommitHash === null;

	// For root entries, compute display-level metadata (topicCount + diffStats).
	// Source of truth for diffStats, in preference order:
	//   1. node.diffStats — persisted by the construction pipeline (executePipeline /
	//      handleAmendPipeline / mergeManyToOne / migrateOneToOne) from a fresh
	//      `git diff`. Reusing it here avoids a redundant git call AND guarantees
	//      that summaries/{hash}.json and index.json carry the same value by construction.
	//   2. existing entry — commit hash unchanged means diff unchanged (e.g. WebView
	//      topic edit via storeSummary(force=true) on a legacy v3 summary that has
	//      no diffStats on the node).
	//   3. fresh `git diff` — legacy v3 path where neither the node nor the index
	//      entry carries diffStats yet. Returns zeros on first-commit (no parent).
	let rootFields: { readonly topicCount: number; readonly diffStats: DiffStats } | undefined;
	if (isRoot) {
		const nodeDiffStats = node.diffStats;
		const existingDiffStats = existingEntryMap?.get(node.commitHash)?.diffStats;
		let diffStats: DiffStats;
		if (nodeDiffStats) {
			diffStats = nodeDiffStats;
		} else if (existingDiffStats) {
			diffStats = existingDiffStats;
		} else {
			diffStats = await getDiffStats(`${node.commitHash}^`, node.commitHash, cwd);
		}
		rootFields = { topicCount: countTopics(node), diffStats };
	}

	const entry: SummaryIndexEntry = {
		commitHash: node.commitHash,
		parentCommitHash,
		treeHash,
		commitType: node.commitType,
		commitMessage: node.commitMessage,
		commitDate: node.commitDate,
		branch: node.branch,
		generatedAt: node.generatedAt,
		...(rootFields && { topicCount: rootFields.topicCount, diffStats: rootFields.diffStats }),
	};

	const entries: SummaryIndexEntry[] = [entry];
	for (const child of node.children ?? []) {
		const childEntries = await flattenSummaryTree(child, node.commitHash, cwd, existingEntryMap);
		entries.push(...childEntries);
	}
	return entries;
}

/**
 * Reads a summary JSON file directly from the orphan branch.
 * Only works for root nodes (files exist at `summaries/{rootHash}.json`).
 */
async function readSummaryFile(
	commitHash: string,
	cwd?: string,
	storage?: StorageProvider,
): Promise<CommitSummary | null> {
	const store = resolveStorage(storage, cwd);
	const content = await store.readFile(`summaries/${commitHash}.json`);
	if (!content) return null;

	try {
		return JSON.parse(content) as CommitSummary;
	} catch (error: unknown) {
		log.error("Failed to parse summary for %s: %s", commitHash.substring(0, 8), (error as Error).message);
		return null;
	}
}

/**
 * Finds the shallowest index entry with the given tree hash.
 *
 * "Shallowest" = fewest ancestors via parentCommitHash chain (depth 0 = root).
 * When depth is equal, the most recent activity date (generatedAt || commitDate)
 * wins — this matches the system-wide ordering semantics used by list/display
 * paths, so amend/rebase-regenerated entries take precedence over stale siblings
 * that merely have a newer author-date.
 *
 * This tie-break ensures we alias to the container node (e.g. a squash root)
 * rather than a buried grandchild, since the container encompasses its children.
 */
function findShallowstByTreeHash(
	treeHash: string,
	entries: ReadonlyArray<SummaryIndexEntry>,
	entryMap: Map<string, SummaryIndexEntry>,
): SummaryIndexEntry | null {
	const matches = entries.filter((e) => e.treeHash === treeHash);
	if (matches.length === 0) return null;
	if (matches.length === 1) return matches[0];

	// Compute depth for each matching entry
	const withDepth = matches.map((entry) => {
		let depth = 0;
		const visited = new Set<string>();
		let current: SummaryIndexEntry | undefined = entry;
		while (current?.parentCommitHash != null) {
			if (visited.has(current.commitHash)) break;
			visited.add(current.commitHash);
			depth++;
			current = entryMap.get(current.parentCommitHash);
		}
		return { entry, depth };
	});

	// Sort: shallowest first, then most recent activity date (generatedAt || commitDate)
	withDepth.sort((a, b) => {
		if (a.depth !== b.depth) return a.depth - b.depth;
		return new Date(getDisplayDate(b.entry)).getTime() - new Date(getDisplayDate(a.entry)).getTime();
	});

	return withDepth[0].entry;
}

/**
 * Loads the index file from the orphan branch.
 * Public wrapper for use by ContextCompiler / LocalSearchProvider / other consumers.
 *
 * Accepts an optional `storage` override so callers can keep index and catalog
 * reads coherent on the same backend (e.g. {@link LocalSearchProvider} passes
 * `this.storage` to both `getIndex` and `getCatalogWithLazyBuild`).
 */
export async function getIndex(cwd?: string, storage?: StorageProvider): Promise<SummaryIndex | null> {
	return loadIndex(cwd, storage);
}

/**
 * Loads the index file from the orphan branch.
 */
async function loadIndex(cwd?: string, storage?: StorageProvider): Promise<SummaryIndex | null> {
	const store = resolveStorage(storage, cwd);
	const content = await store.readFile(INDEX_FILE);
	if (!content) {
		return null;
	}

	try {
		return JSON.parse(content) as SummaryIndex;
	} catch (error: unknown) {
		log.error("Failed to parse index.json: %s", (error as Error).message);
		return null;
	}
}

// ─── Catalog (warm-path, search/recall enrichment) ───────────────────────────

/**
 * Builds a catalog entry from a CommitSummary.
 *
 * **CRITICAL**: must use `collectDisplayTopics(summary)` rather than reading
 * `summary.topics` directly. v3 legacy data and IntelliJ squash output may
 * carry topics inside `children` rather than on the root, so direct field
 * access would yield empty topics for those summaries.
 *
 * `decisions` is preserved at full length — no length cap. catalog.json is
 * cold path, only loaded by /jolli-search and recall catalog enrichment.
 */
export function toCatalogEntry(summary: CommitSummary): CatalogEntry {
	const topics: CatalogTopic[] = collectDisplayTopics(summary).map((t) => ({
		title: t.title,
		...(t.decisions !== undefined && { decisions: t.decisions }),
		...(t.category !== undefined && { category: t.category }),
		...(t.importance !== undefined && { importance: t.importance }),
		...(t.filesAffected && t.filesAffected.length > 0 && { filesAffected: t.filesAffected }),
	}));
	return {
		commitHash: summary.commitHash,
		...(summary.recap !== undefined && { recap: summary.recap }),
		...(summary.ticketId !== undefined && { ticketId: summary.ticketId }),
		...(topics.length > 0 && { topics }),
	};
}

/**
 * Loads the catalog file from the orphan branch.
 * Returns null if `catalog.json` does not exist (e.g. legacy install before
 * the warm-path catalog was introduced); callers should fall back to lazy
 * build / bootstrap (see `getCatalogWithLazyBuild`).
 */
export async function loadCatalog(cwd?: string, storage?: StorageProvider): Promise<CommitCatalog | null> {
	const store = resolveStorage(storage, cwd);
	const content = await store.readFile(CATALOG_FILE);
	if (!content) {
		return null;
	}

	try {
		return JSON.parse(content) as CommitCatalog;
	} catch (error: unknown) {
		log.error("Failed to parse catalog.json: %s", (error as Error).message);
		return null;
	}
}

/**
 * Public wrapper around {@link loadCatalog} for callers outside this module.
 *
 * Note: prefer {@link getCatalogWithLazyBuild} when you need a guaranteed
 * up-to-date catalog (lazy build + reconcile). Use this raw wrapper only when
 * you specifically need the on-disk file as-is (e.g. tests, audit, debug).
 */
export async function getCatalog(cwd?: string, storage?: StorageProvider): Promise<CommitCatalog | null> {
	return loadCatalog(cwd, storage);
}

/**
 * Returns a {@link CommitCatalog} guaranteed to contain entries for every
 * current root commit in `index.json`, performing reconcile + lazy build:
 *
 * 1. **Reconcile**: drop any catalog entry whose hash is no longer a root in
 *    index (e.g. an external writer such as IntelliJ amended a commit, turning
 *    the old root into a child).
 * 2. **Bootstrap / lazy build**: for every root in index that the catalog does
 *    not list, load `summaries/<hash>.json` and append a fresh entry built via
 *    {@link toCatalogEntry}.
 *
 * **Concurrency**: writes to catalog.json are guarded by the same shared lock
 * used by `QueueWorker` and `scanTreeHashAliases`. Without the lock,
 * `writeMultipleFilesToBranch`'s unconditional `update-ref` could race with a
 * concurrent worker write and roll the orphan branch ref back to a stale
 * parent — silently destroying the worker's commit.
 *
 * Lock-contention behavior: when the lock cannot be acquired, the function
 * returns the freshly reconciled catalog **in memory** without writing it
 * back. The caller's read still sees the correct view; the next read will
 * retry the write. This is safe because the reconcile is purely derived from
 * `index.json` + per-hash summary files — no information is lost by skipping
 * the write.
 *
 * Idempotent and safe to call from multiple processes; concurrent successful
 * writes converge to the same content.
 */
export async function getCatalogWithLazyBuild(cwd?: string, storage?: StorageProvider): Promise<CommitCatalog> {
	const store = resolveStorage(storage, cwd);

	// Pre-flight read OUTSIDE the lock to detect the no-op case cheaply.
	const preflightCatalog = (await loadCatalog(cwd, store)) ?? { version: 1, entries: [] };
	const preflightIndex = await loadIndex(cwd, store);

	if (!preflightIndex || preflightIndex.entries.length === 0) {
		return preflightCatalog;
	}

	const preflightRoots = new Set(preflightIndex.entries.filter(isRootEntry).map((e) => e.commitHash));
	const preflightHaveHashes = new Set(preflightCatalog.entries.map((e) => e.commitHash));
	const preflightCleanedCount = preflightCatalog.entries.filter((e) => preflightRoots.has(e.commitHash)).length;
	const preflightMissing: string[] = [];
	for (const hash of preflightRoots) {
		if (!preflightHaveHashes.has(hash)) preflightMissing.push(hash);
	}

	// Fast path: catalog already in sync with index; no write needed.
	if (preflightCleanedCount === preflightCatalog.entries.length && preflightMissing.length === 0) {
		return preflightCatalog;
	}

	// We have work to do. Acquire the shared lock so concurrent worker writes
	// can't race with our update; if the lock is contended, fall back to the
	// preflight in-memory result (a stale-but-coherent view is better than
	// stomping a fresher write).
	const locked = await acquireLock(cwd);
	if (!locked) {
		log.debug("getCatalogWithLazyBuild: lock contention — returning in-memory catalog without writeback");
		// Build the in-memory updated view so caller still sees current roots.
		const cleaned = preflightCatalog.entries.filter((e) => preflightRoots.has(e.commitHash));
		const newEntries: CatalogEntry[] = [];
		for (const hash of preflightMissing) {
			const summary = await readSummaryFile(hash, cwd, store);
			if (summary) newEntries.push(toCatalogEntry(summary));
		}
		return { version: 1, entries: [...cleaned, ...newEntries] };
	}

	try {
		// Re-read inside the lock — the previously-blocking writer may have
		// just finished, making our preflight view obsolete.
		const catalog = (await loadCatalog(cwd, store)) ?? { version: 1, entries: [] };
		const index = await loadIndex(cwd, store);
		if (!index || index.entries.length === 0) {
			return catalog;
		}

		const currentRoots = new Set(index.entries.filter(isRootEntry).map((e) => e.commitHash));
		const cleaned = catalog.entries.filter((e) => currentRoots.has(e.commitHash));
		const haveHashes = new Set(cleaned.map((e) => e.commitHash));
		const missing: string[] = [];
		for (const hash of currentRoots) {
			if (!haveHashes.has(hash)) missing.push(hash);
		}

		// Re-check fast path under the lock — another writer may have already
		// reconciled while we waited.
		if (cleaned.length === catalog.entries.length && missing.length === 0) {
			return catalog;
		}

		const newEntries: CatalogEntry[] = [];
		for (const hash of missing) {
			const summary = await readSummaryFile(hash, cwd, store);
			if (summary) {
				newEntries.push(toCatalogEntry(summary));
			} else {
				log.warn("Catalog lazy build: summary file missing for root %s", hash.substring(0, 8));
			}
		}

		const updated: CommitCatalog = { version: 1, entries: [...cleaned, ...newEntries] };
		const removed = catalog.entries.length - cleaned.length;
		const message = `catalog: reconcile (+${newEntries.length}, -${removed})`;
		await store.writeFiles([{ path: CATALOG_FILE, content: JSON.stringify(updated, null, "\t") }], message);
		return updated;
	} finally {
		await releaseLock(cwd);
	}
}

/**
 * Builds a `FileWrite` describing the new catalog.json contents to be committed
 * atomically alongside summary + index updates.
 *
 * Reconcile-on-write invariant: the resulting catalog contains exactly:
 *   - existing entries whose hash is still a root in `entryMap`
 *     (entries for hashes that became amend/squash children are dropped)
 *   - the new root's entry (replaces any prior entry for the same hash)
 *
 * When `existingCatalog` is null (fresh install or catalog was deleted), the
 * write produces a catalog with only the new root's entry. The read-path
 * `getCatalogWithLazyBuild` reconciliation later fills in any historical
 * roots that pre-date this write.
 */
function buildCatalogFileWrite(
	existingCatalog: CommitCatalog | null,
	entryMap: ReadonlyMap<string, SummaryIndexEntry>,
	newRoot: CommitSummary,
): FileWrite {
	const currentRootHashes = new Set([...entryMap.values()].filter(isRootEntry).map((e) => e.commitHash));
	const priorEntries = existingCatalog?.entries ?? [];
	const filtered = priorEntries.filter(
		(e) => currentRootHashes.has(e.commitHash) && e.commitHash !== newRoot.commitHash,
	);
	const updated: CommitCatalog = {
		version: 1,
		entries: [...filtered, toCatalogEntry(newRoot)],
	};
	return { path: CATALOG_FILE, content: JSON.stringify(updated, null, "\t") };
}

/**
 * Builds a `FileWrite` for catalog.json that drops the entry for `removedHash`.
 * Used by `removeFromIndex` so admin cleanup keeps catalog and index aligned.
 *
 * Returns null when no catalog file exists or no entry references the hash —
 * caller can then skip writing catalog.json.
 */
function buildCatalogRemoveFileWrite(existingCatalog: CommitCatalog | null, removedHash: string): FileWrite | null {
	if (!existingCatalog) return null;
	const filtered = existingCatalog.entries.filter((e) => e.commitHash !== removedHash);
	if (filtered.length === existingCatalog.entries.length) return null;
	const updated: CommitCatalog = { version: 1, entries: filtered };
	return { path: CATALOG_FILE, content: JSON.stringify(updated, null, "\t") };
}

// ─── Plan file storage ────────────────────────────────────────────────────────

/**
 * Stores one or more plan files in the orphan branch under `plans/<slug>.md`.
 * Writes all files in a single atomic commit.
 */
export async function storePlans(
	planFiles: ReadonlyArray<{ slug: string; content: string }>,
	commitMessage: string,
	cwd?: string,
	branch?: string,
): Promise<void> {
	if (planFiles.length === 0) return;

	const files: FileWrite[] = planFiles.map((p) => ({
		path: `plans/${p.slug}.md`,
		content: p.content,
		branch,
	}));

	const store = resolveStorage(undefined, cwd);
	await store.writeFiles(files, commitMessage);
	log.info("Stored %d plan file(s)", planFiles.length);
}

/**
 * Reads a plan file from the orphan branch.
 * Returns the markdown content, or null if the file doesn't exist.
 */
export async function readPlanFromBranch(
	slug: string,
	cwd?: string,
	storage?: StorageProvider,
): Promise<string | null> {
	try {
		const store = resolveStorage(storage, cwd);
		return await store.readFile(`plans/${slug}.md`);
	} catch {
		return null;
	}
}

/**
 * Reads a plan progress artifact from the orphan branch.
 * Returns the parsed artifact, or null if the file doesn't exist or fails to parse.
 */
export async function readPlanProgress(slug: string, cwd?: string): Promise<PlanProgressArtifact | null> {
	try {
		const store = resolveStorage(undefined, cwd);
		const json = await store.readFile(`plan-progress/${slug}.json`);
		if (!json) return null;
		return JSON.parse(json) as PlanProgressArtifact;
	} catch {
		return null;
	}
}

// ─── Note storage (parallel to plans) ───────────────────────────────────────

/**
 * Stores note files in the orphan branch under `notes/<id>.md`.
 * Atomic write — all notes are committed in a single orphan-branch commit.
 */
export async function storeNotes(
	noteFiles: ReadonlyArray<{ id: string; content: string }>,
	commitMessage: string,
	cwd?: string,
	branch?: string,
): Promise<void> {
	if (noteFiles.length === 0) return;

	const files: FileWrite[] = noteFiles.map((n) => ({
		path: `notes/${n.id}.md`,
		content: n.content,
		branch,
	}));

	const store = resolveStorage(undefined, cwd);
	await store.writeFiles(files, commitMessage);
	log.info("Stored %d note file(s)", noteFiles.length);
}

/**
 * Reads a note file from the orphan branch.
 * Returns the markdown content, or null if the file doesn't exist.
 */
export async function readNoteFromBranch(id: string, cwd?: string, storage?: StorageProvider): Promise<string | null> {
	try {
		const store = resolveStorage(storage, cwd);
		return await store.readFile(`notes/${id}.md`);
	} catch {
		return null;
	}
}

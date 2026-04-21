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

import { createLogger, ORPHAN_BRANCH } from "../Logger.js";
import type {
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
} from "../Types.js";
import {
	getDiffStats,
	getTreeHash,
	listFilesInBranch,
	readFileFromBranch,
	writeMultipleFilesToBranch,
} from "./GitOps.js";
import { acquireLock, releaseLock } from "./SessionTracker.js";
import { countTopics } from "./SummaryTree.js";

const log = createLogger("SummaryStore");

const INDEX_FILE = "index.json";

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

	await writeMultipleFilesToBranch(
		ORPHAN_BRANCH,
		files,
		`${verb} summary for ${summary.commitHash.substring(0, 8)}: ${summary.commitMessage.substring(0, 50)}`,
		cwd,
	);

	log.info("Summary stored successfully for commit %s", summary.commitHash.substring(0, 8));
}

/**
 * Migrates a summary 1:1 (for rebase pick): creates a container node with commitType "rebase"
 * that wraps the original summary as a child. This preserves the old commit hash in the tree,
 * upholding the principle that no recorded summary hash is ever lost.
 *
 * In v3, the old entry's `parentCommitHash` is updated to point to the new hash
 * (becomes a child) rather than being deleted from the index.
 */
export async function migrateOneToOne(
	oldSummary: CommitSummary,
	newCommitInfo: CommitInfo,
	cwd?: string,
): Promise<void> {
	log.info(
		"Migrating summary 1:1: %s → %s",
		oldSummary.commitHash.substring(0, 8),
		newCommitInfo.hash.substring(0, 8),
	);

	// Wrap the old summary as a child rather than replacing its hash.
	// Hoist functional-level metadata to the new root so they're accessible at the top level:
	// - plans, notes, e2eTestGuide: feature-level metadata
	// - jolliDocId, jolliDocUrl: stable server IDs for direct article update (docId-based)
	// - orphanedDocIds: memory article IDs pending cleanup on next push
	const strippedOld = stripFunctionalMetadata(oldSummary);
	const docUrl = oldSummary.jolliDocUrl;
	const newSummary: CommitSummary = {
		version: 3,
		commitHash: newCommitInfo.hash,
		commitMessage: newCommitInfo.message,
		commitAuthor: newCommitInfo.author,
		commitDate: newCommitInfo.date,
		branch: oldSummary.branch,
		generatedAt: new Date().toISOString(),
		commitType: "rebase",
		...(oldSummary.jolliDocId && { jolliDocId: oldSummary.jolliDocId }),
		...(docUrl && { jolliDocUrl: docUrl }),
		...(oldSummary.orphanedDocIds && { orphanedDocIds: oldSummary.orphanedDocIds }),
		...(oldSummary.plans && { plans: oldSummary.plans }),
		...(oldSummary.notes && { notes: oldSummary.notes }),
		...(oldSummary.e2eTestGuide && { e2eTestGuide: oldSummary.e2eTestGuide }),
		children: [strippedOld],
	};

	const existingIndex = await loadIndex(cwd);
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
	];

	await writeMultipleFilesToBranch(
		ORPHAN_BRANCH,
		files,
		`Migrate summary ${oldSummary.commitHash.substring(0, 8)} → ${newCommitInfo.hash.substring(0, 8)}`,
		cwd,
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
	/** The most recent child's Jolli metadata (to hoist to merged root), or null if no children were pushed. */
	readonly winner: { readonly jolliDocId: number; readonly jolliDocUrl: string } | null;
	/** Memory article docIds from children that were NOT selected as winner (orphaned articles to delete). */
	readonly orphanedDocIds: number[];
}

/** Recursively collects jolliDocId/jolliDocUrl from children, picks newest as winner. */
function collectChildJolliMeta(nodes: ReadonlyArray<CommitSummary>): JolliMetaHoistResult {
	const candidates: Array<{ jolliDocId: number; jolliDocUrl: string; commitDate: string }> = [];
	for (const node of nodes) {
		const url = node.jolliDocUrl;
		if (node.jolliDocId && url) {
			candidates.push({ jolliDocId: node.jolliDocId, jolliDocUrl: url, commitDate: node.commitDate });
		}
		if (node.children) {
			const childResult = collectChildJolliMeta(node.children);
			if (childResult.winner) {
				candidates.push({ ...childResult.winner, commitDate: node.commitDate });
			}
			// Child orphans are always orphaned (they lost in a deeper merge)
			// but we don't collect them here — they were already handled by the deeper merge
		}
	}
	if (candidates.length === 0) return { winner: null, orphanedDocIds: [] };

	// Sort by commitDate descending, pick newest as winner
	candidates.sort((a, b) => new Date(b.commitDate).getTime() - new Date(a.commitDate).getTime());
	const winner = { jolliDocId: candidates[0].jolliDocId, jolliDocUrl: candidates[0].jolliDocUrl };
	const orphanedDocIds = candidates.slice(1).map((c) => c.jolliDocId);
	return { winner, orphanedDocIds };
}

/** Strips plans, notes, e2eTestGuide, and all Jolli metadata from a summary node. */
export function stripFunctionalMetadata(node: CommitSummary): CommitSummary {
	return stripJolliMetadata(stripNotes(stripPlans(stripE2eTestGuide(node))));
}

/**
 * Merges multiple summaries into one (for rebase squash/fixup and git merge --squash).
 * Places all source summaries as `children` sorted by commitDate descending (newest first).
 * No LLM call is made — this is a pure container node.
 *
 * In v3, the old top-level entries' `parentCommitHash` is updated to point to the new
 * merged hash. Child nodes of old summaries keep their existing parentCommitHash intact.
 *
 * E2E test guides from children are hoisted to the merged root and stripped from the
 * children so the root owns all E2E data directly (no runtime collection needed).
 */
export async function mergeManyToOne(
	oldSummaries: ReadonlyArray<CommitSummary>,
	newCommitInfo: CommitInfo,
	cwd?: string,
	metadata?: { readonly commitType?: CommitType; readonly commitSource?: CommitSource },
): Promise<{ orphanedDocIds: number[] }> {
	log.info("Merging %d summaries into %s", oldSummaries.length, newCommitInfo.hash.substring(0, 8));

	// Sort children by commitDate descending (newest first), matching git log order
	const children = [...oldSummaries].sort(
		(a, b) => new Date(b.commitDate).getTime() - new Date(a.commitDate).getTime(),
	);

	// Hoist functional-level metadata from children into the merged root:
	// - E2E test guides: describe the final merged result's test plan
	// - Plans: describe the feature's implementation strategy
	// - Notes: user-created notes (snippets, markdown) associated with commits
	// - Jolli memory article metadata (docId/URL): stable server ID for direct update
	// - orphanedDocIds: accumulated memory article IDs pending cleanup on next push
	// Topics stay with their original child commits (commit-level granularity).
	const hoistedE2e = collectChildE2eScenarios(children);
	const hoistedPlans = collectChildPlans(children);
	const hoistedNotes = collectChildNotes(children);
	const jolliMeta = collectChildJolliMeta(children);
	const inheritedOrphanIds = children.flatMap((c) => c.orphanedDocIds ?? []);
	const allOrphanedDocIds = [...jolliMeta.orphanedDocIds, ...inheritedOrphanIds];
	const strippedChildren = children.map(stripFunctionalMetadata);

	const mergedSummary: CommitSummary = {
		version: 3,
		commitHash: newCommitInfo.hash,
		commitMessage: newCommitInfo.message,
		commitAuthor: newCommitInfo.author,
		commitDate: newCommitInfo.date,
		branch: oldSummaries[0].branch,
		generatedAt: new Date().toISOString(),
		...(metadata?.commitType && { commitType: metadata.commitType }),
		...(metadata?.commitSource && { commitSource: metadata.commitSource }),
		...(hoistedE2e.length > 0 && { e2eTestGuide: hoistedE2e }),
		...(hoistedPlans.length > 0 && { plans: hoistedPlans }),
		...(hoistedNotes.length > 0 && { notes: hoistedNotes }),
		...(jolliMeta.winner && { jolliDocId: jolliMeta.winner.jolliDocId, jolliDocUrl: jolliMeta.winner.jolliDocUrl }),
		...(allOrphanedDocIds.length > 0 && { orphanedDocIds: allOrphanedDocIds }),
		children: strippedChildren,
	};

	const existingIndex = await loadIndex(cwd);
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
	];

	await writeMultipleFilesToBranch(
		ORPHAN_BRANCH,
		files,
		`Merge summaries [${oldHashesStr}] → ${newCommitInfo.hash.substring(0, 8)}`,
		cwd,
	);
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

	await writeMultipleFilesToBranch(ORPHAN_BRANCH, files, `Remove index entry for ${commitHash.substring(0, 8)}`, cwd);
	log.info("Removed %s from index", commitHash.substring(0, 8));
}

// ─── Transcript API ──────────────────────────────────────────────────────────

/**
 * Reads a transcript for a specific commit from the orphan branch.
 * Returns null if no transcript file exists for the given commit hash.
 */
export async function readTranscript(commitHash: string, cwd?: string): Promise<StoredTranscript | null> {
	const raw = await readFileFromBranch(ORPHAN_BRANCH, `transcripts/${commitHash}.json`, cwd);
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

	await writeMultipleFilesToBranch(ORPHAN_BRANCH, files, `Update transcripts: ${summary}`, cwd);
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
 * Uses `listFilesInBranch()` to scan the `transcripts/` prefix.
 */
export async function getTranscriptHashes(cwd?: string): Promise<Set<string>> {
	const files = await listFilesInBranch(ORPHAN_BRANCH, "transcripts/", cwd);
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
 * Lookup order (v3 flat index):
 * 1. Direct entry lookup by commitHash
 * 2. commitAliases[commitHash] → cached alias hash → entry lookup
 * 3. Tree hash fallback: git cat-file → scan entries by treeHash → write alias → persist
 * 4. Legacy fallback: direct file read (v1 orphan branch, no index)
 *
 * Once the target entry is found, follows the `parentCommitHash` chain to locate
 * the root summary file, then traverses the tree to return the specific node.
 *
 * Returns null if no summary exists for that commit.
 */
export async function getSummary(commitHash: string, cwd?: string): Promise<CommitSummary | null> {
	const index = await loadIndex(cwd);

	if (index) {
		const entryMap = new Map(index.entries.map((e) => [e.commitHash, e]));

		// Step 1: Direct lookup
		let targetEntry = entryMap.get(commitHash);

		// Step 2: Check cached aliases
		if (!targetEntry && index.commitAliases?.[commitHash]) {
			const aliasHash = index.commitAliases[commitHash];
			targetEntry = entryMap.get(aliasHash);
		}

		// Step 3: Tree hash fallback (slow path — only for v3 index with treeHash fields).
		// This is a read-only path: alias caching is intentionally deferred to
		// scanTreeHashAliases() so getSummary() never writes to the orphan branch.
		if (!targetEntry && index.version === 3) {
			const treeHash = await getTreeHash(commitHash, cwd);
			/* v8 ignore start -- tree hash fallback: requires real git repo with matching tree hashes across commit rewrites */
			if (treeHash) {
				const matchEntry = findShallowstByTreeHash(treeHash, index.entries, entryMap);
				if (matchEntry) {
					targetEntry = matchEntry;
				}
				/* v8 ignore stop */
			}
		}

		if (targetEntry) {
			// Follow parentCommitHash chain to find the root
			const rootHash = findRootHash(targetEntry.commitHash, entryMap);
			if (!rootHash) return null;

			// Load the root summary file
			const rootSummary = await readSummaryFile(rootHash, cwd);
			if (!rootSummary) return null;

			// If the target is the root, return directly
			if (rootHash === targetEntry.commitHash) return rootSummary;

			// Otherwise find the specific child node in the tree.
			// Return null rather than silently falling back to the root: a missing child
			// means the index is stale or migration is incomplete, and returning the wrong
			// summary would mask that as a successful lookup.
			const node = findNodeInTree(rootSummary, targetEntry.commitHash);
			if (!node) {
				log.warn(
					"getSummary: index entry %s points to root %s but node not found in tree — stale index?",
					targetEntry.commitHash.substring(0, 8),
					rootHash.substring(0, 8),
				);
				return null;
			}
			return node;
		}
	}

	// Step 4: Legacy fallback — direct file read (v1 orphan branch)
	return readSummaryFile(commitHash, cwd);
}

/**
 * Lists recent root-level summaries, ordered by date (newest first).
 * In v3, only top-level entries (parentCommitHash == null) are listed.
 *
 * @param count - Maximum number of summaries to return (default: 10)
 * @param cwd - Optional working directory
 */
export async function listSummaries(count = 10, cwd?: string): Promise<ReadonlyArray<CommitSummary>> {
	const index = await loadIndex(cwd);
	if (!index || index.entries.length === 0) {
		return [];
	}

	// Only top-level roots (null = v3 root; undefined = v1 legacy entry treated as root)
	const rootEntries = index.entries.filter(isRootEntry);
	const recentEntries = rootEntries.slice(-count).reverse();

	// Load full summaries for each root entry
	const summaries: CommitSummary[] = [];
	for (const entry of recentEntries) {
		const summary = await getSummary(entry.commitHash, cwd);
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
export async function getIndexEntryMap(cwd?: string): Promise<ReadonlyMap<string, SummaryIndexEntry>> {
	const index = await loadIndex(cwd);
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
export async function scanTreeHashAliases(commitHashes: string[], cwd?: string): Promise<boolean> {
	const index = await loadIndex(cwd);
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
		await writeMultipleFilesToBranch(
			ORPHAN_BRANCH,
			files,
			`Add ${Object.keys(newAliases).length} tree hash alias(es)`,
			cwd,
		);
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

	const files: FileWrite[] = [{ path: INDEX_FILE, content: JSON.stringify(newIndex, null, "\t") }];
	await writeMultipleFilesToBranch(ORPHAN_BRANCH, files, `Migrate index v1 → v3 (${migrated} entries)`, cwd);

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
	// diffStats are reused from the existing entry when available (commit hash unchanged
	// means diff unchanged — e.g. WebView topic edits via storeSummary(force=true)).
	let rootFields: { readonly topicCount: number; readonly diffStats: DiffStats } | undefined;
	if (isRoot) {
		const existingDiffStats = existingEntryMap?.get(node.commitHash)?.diffStats;
		let diffStats: DiffStats;
		if (existingDiffStats) {
			diffStats = existingDiffStats;
		} else {
			// getDiffStats returns zeroes when git diff fails (e.g. first commit with no parent),
			// because execGit internally catches all errors and returns empty stdout.
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
 * Follows the `parentCommitHash` chain from the given commit hash upward
 * to find the root entry (the one with `parentCommitHash == null`).
 *
 * Includes cycle detection to prevent infinite loops on corrupt index data.
 * Returns null if the entry is not found in the map.
 */
function findRootHash(commitHash: string, entryMap: Map<string, SummaryIndexEntry>): string | null {
	const visited = new Set<string>();
	let current = entryMap.get(commitHash);
	while (current && current.parentCommitHash != null) {
		if (visited.has(current.commitHash)) break; // cycle guard
		visited.add(current.commitHash);
		current = entryMap.get(current.parentCommitHash);
	}
	return current?.commitHash ?? null;
}

/**
 * Recursively searches a CommitSummary tree for the node with `targetHash`.
 * Returns the matching node, or null if not found.
 */
function findNodeInTree(root: CommitSummary, targetHash: string): CommitSummary | null {
	if (root.commitHash === targetHash) return root;
	for (const child of root.children ?? []) {
		const found = findNodeInTree(child, targetHash);
		/* v8 ignore next -- recursive traversal: found branch is exercised but v8 undercounts in recursion */
		if (found) return found;
	}
	return null;
}

/**
 * Reads a summary JSON file directly from the orphan branch.
 * Only works for root nodes (files exist at `summaries/{rootHash}.json`).
 */
async function readSummaryFile(commitHash: string, cwd?: string): Promise<CommitSummary | null> {
	const content = await readFileFromBranch(ORPHAN_BRANCH, `summaries/${commitHash}.json`, cwd);
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
 * When depth is equal, the most recent commitDate wins.
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

	// Sort: shallowest first, then most recent date
	withDepth.sort((a, b) => {
		if (a.depth !== b.depth) return a.depth - b.depth;
		return new Date(b.entry.commitDate).getTime() - new Date(a.entry.commitDate).getTime();
	});

	return withDepth[0].entry;
}

/**
 * Loads the index file from the orphan branch.
 * Public wrapper for use by ContextCompiler and other consumers.
 */
export async function getIndex(cwd?: string): Promise<SummaryIndex | null> {
	return loadIndex(cwd);
}

/**
 * Loads the index file from the orphan branch.
 */
async function loadIndex(cwd?: string): Promise<SummaryIndex | null> {
	const content = await readFileFromBranch(ORPHAN_BRANCH, INDEX_FILE, cwd);
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

// ─── Plan file storage ────────────────────────────────────────────────────────

/**
 * Stores one or more plan files in the orphan branch under `plans/<slug>.md`.
 * Writes all files in a single atomic commit.
 */
export async function storePlans(
	planFiles: ReadonlyArray<{ slug: string; content: string }>,
	commitMessage: string,
	cwd?: string,
): Promise<void> {
	if (planFiles.length === 0) return;

	const files: FileWrite[] = planFiles.map((p) => ({
		path: `plans/${p.slug}.md`,
		content: p.content,
	}));

	await writeMultipleFilesToBranch(ORPHAN_BRANCH, files, commitMessage, cwd);
	log.info("Stored %d plan file(s) in orphan branch", planFiles.length);
}

/**
 * Reads a plan file from the orphan branch.
 * Returns the markdown content, or null if the file doesn't exist.
 */
export async function readPlanFromBranch(slug: string, cwd?: string): Promise<string | null> {
	try {
		return await readFileFromBranch(ORPHAN_BRANCH, `plans/${slug}.md`, cwd);
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
		const json = await readFileFromBranch(ORPHAN_BRANCH, `plan-progress/${slug}.json`, cwd);
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
): Promise<void> {
	if (noteFiles.length === 0) return;

	const files: FileWrite[] = noteFiles.map((n) => ({
		path: `notes/${n.id}.md`,
		content: n.content,
	}));

	await writeMultipleFilesToBranch(ORPHAN_BRANCH, files, commitMessage, cwd);
	log.info("Stored %d note file(s) in orphan branch", noteFiles.length);
}

/**
 * Reads a note file from the orphan branch.
 * Returns the markdown content, or null if the file doesn't exist.
 */
export async function readNoteFromBranch(id: string, cwd?: string): Promise<string | null> {
	try {
		return await readFileFromBranch(ORPHAN_BRANCH, `notes/${id}.md`, cwd);
	} catch {
		return null;
	}
}

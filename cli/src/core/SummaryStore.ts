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

import { createLogger, isManuallyDisabled } from "../Logger.js";
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
	ReferenceCommitRef,
	SkillCommitRef,
	SourceId,
	StoredTranscript,
	SummaryIndex,
	SummaryIndexEntry,
	TopicSummary,
} from "../Types.js";
import { CURRENT_SCHEMA_VERSION } from "../Types.js";
import { getDiffStats, getTreeHash } from "./GitOps.js";
import { acquireOrphanWriteLock, OrphanWriteBusyError, releaseOrphanWriteLock } from "./Locks.js";
import { OrphanBranchStorage } from "./OrphanBranchStorage.js";
import { holdsOrphanWriteLock, runHoldingOrphanWriteLock } from "./OrphanWriteReentrancy.js";
import { mergeRefsNewWins, snapshotKeyOf } from "./RefMerge.js";
import { isRegisteredSourceId, sanitizeNativeIdForPath } from "./references/ReferenceStore.js";
import { resolveSotBackend } from "./SotStorageResolver.js";
import { asSqliteStorage } from "./SqliteStorage.js";
import type { StorageProvider } from "./StorageProvider.js";
import type { SquashConsolidationSource } from "./Summarizer.js";
import { isSummaryError, LLM_FAILED } from "./SummaryErrorMarker.js";
import { getDisplayDate } from "./SummaryFormat.js";
import {
	collectAllTopics,
	collectDisplayTopics,
	countTopics,
	isUnifiedHoistFormat,
	resolveDiffStats,
	resolveTranscriptIdsFiltered,
} from "./SummaryTree.js";
import { mergeSkillRefs, stripSupersededDocIds } from "./skills/SkillDelta.js";
import { transcriptIdFromPath } from "./TranscriptId.js";

let activeStorageOverride: StorageProvider | undefined;

export function setActiveStorage(storage: StorageProvider | undefined): void {
	activeStorageOverride = storage;
}

/**
 * Reads the current process-global storage override (or undefined). Callers that
 * temporarily swap it (e.g. the multi-repo compile sweep) capture this first and
 * restore it in a finally, so the override never leaks past their own scope into
 * a long-lived host process (VS Code/IntelliJ) where it would silently redirect
 * later reads/writes to the wrong repo.
 */
export function getActiveStorage(): StorageProvider | undefined {
	return activeStorageOverride;
}

/**
 * Fail-safe fallback shared by both resolvers: the repo's SYSTEM OF RECORD.
 *
 * Not `new OrphanBranchStorage(cwd)`, which is what this used to be. That was
 * correct only while the orphan branch was always the truth; past a cutover it
 * hands back a frozen branch, and nothing downstream can tell. `vscode/src`
 * never calls `setActiveStorage` (all 18 call sites are CLI process entry
 * points), so every in-process `cli/src` call from the extension host lands
 * here — the read side had no other line of defence at all.
 *
 * Union shape on purpose: a fallback that throws is not a fallback. A `blocked`
 * repo degrades to the orphan backend with a warning, which is the same bet the
 * old code made unconditionally, now narrowed to the one state where no safe
 * backend exists.
 */
async function sotFallback(cwd?: string): Promise<StorageProvider> {
	const backend = await resolveSotBackend(cwd);
	if (backend.ok) return backend.storage;
	log.warn("system-of-record unavailable (%s) — falling back to the orphan branch. cwd=%s", backend.reason, cwd);
	return new OrphanBranchStorage(cwd);
}

export async function resolveStorage(storage?: StorageProvider, cwd?: string): Promise<StorageProvider> {
	if (storage) return storage;
	if (activeStorageOverride) return activeStorageOverride;
	// A missed storage thread still preserves data, but it bypasses
	// DualWriteStorage, so the Memory Bank side silently loses this write. Warn so
	// the gap shows up in debug.log instead of as a phantom missing file weeks
	// later. VITEST guard mirrors Logger.ts.
	/* v8 ignore start -- warning only fires outside VITEST; coverage runs are always under VITEST. */
	if (!process.env.VITEST) {
		log.warn(
			"resolveStorage fell back to the system of record — caller did not thread storage or call setActiveStorage. The Memory Bank side will miss this write. cwd=%s",
			cwd ?? "(undef)",
		);
	}
	/* v8 ignore stop */
	return sotFallback(cwd);
}

/**
 * The read-side twin of {@link resolveStorage}: identical fallback, no warning.
 *
 * The same fallback means opposite things on the two sides. For a WRITE it is a
 * defect — it bypasses DualWriteStorage and the Memory Bank side silently loses
 * that write, which is exactly what the warning above exists to surface. For a
 * READ it is the documented model: reads come from the system of record.
 *
 * One predicate served both, so every `jolli status` — a command that only ever
 * reads — ended with "Folder-mode users will miss this write" about a write that
 * was never attempted. A warning that fires on healthy behaviour is worse than
 * no warning at all: it is the one people learn to scroll past, and it was
 * sitting directly under the setup output a first-run user reads.
 *
 * Silencing reads cannot hide a write: every write resolves its own storage at
 * its own call site, and still warns there.
 *
 * NOT to be confused with `ReadStorageResolver.createReadStorage`, which asks
 * "which backend should I read from?" and answers `FolderStorage` before a
 * cutover. This one resolves the SYSTEM OF RECORD, and only decides whether to
 * warn — see `SotStorageResolver` for why the two must not be collapsed.
 */
export async function resolveReadStorage(storage?: StorageProvider, cwd?: string): Promise<StorageProvider> {
	return storage ?? activeStorageOverride ?? (await sotFallback(cwd));
}

const log = createLogger("SummaryStore");

const INDEX_FILE = "index.json";
const CATALOG_FILE = "catalog.json";

/**
 * Wait budget for orphan-write lock on the worker path (writes that must land).
 *
 * 30 s is sized for the worst legitimate contention we expect: a fresh-install
 * v1 → v3 migration on a large repository running concurrently with a commit
 * (a few seconds of held lock). Normal background-scan contention is 50–200 ms,
 * so 30 s leaves ~100× headroom.
 *
 * On timeout `withRequiredOrphanWriteLock` throws and the worker's outer
 * `processQueueEntry` catch deletes the queue entry. We deliberately do NOT
 * preserve the entry for retry: the cursor for read transcripts has already
 * advanced past the relevant range by the time `storeSummary` is called
 * (see `saveCursor` in QueueWorker), so a retried run would build a summary
 * over the wrong transcript window — corrupt output is worse than missing
 * output. This matches the system-wide "fire-and-forget, don't retry"
 * philosophy documented at QueueWorker.runWorker's catch block.
 *
 * The probability of timing out at 30 s is far below other inherent failure
 * modes (LLM call, network, user kill), so the practical loss risk is
 * negligible.
 */
export const ORPHAN_WRITE_REQUIRED_TIMEOUT_MS = 30_000;

/**
 * Wait budget for orphan-write lock on best-effort paths (background scans,
 * admin cleanup). 1 s is enough to ride out the typical 50–200 ms held
 * window with margin; deferring on contention is acceptable because the
 * caller will be re-invoked (next UI refresh, next admin run).
 */
const ORPHAN_WRITE_BEST_EFFORT_TIMEOUT_MS = 1000;

/**
 * Acquires `orphan-write.lock` for a critical section that MUST land
 * (worker path). Throws on timeout — see `ORPHAN_WRITE_REQUIRED_TIMEOUT_MS`
 * for why "lose this entry" is the chosen failure mode.
 *
 * Re-entrant within one async call chain, on the same terms as
 * `Locks.withOrphanWriteLock` — see `OrphanWriteReentrancy.ts`. This is the
 * OUTER half of the nesting that matters in production: QueueWorker's ingest
 * `writeGuard` wraps its callback here, and the callback reaches the topic
 * stores, which lock their own writes.
 */
export async function withRequiredOrphanWriteLock<T>(
	cwd: string | undefined,
	label: string,
	fn: () => Promise<T>,
): Promise<T> {
	if (holdsOrphanWriteLock(cwd)) return await fn();
	const acquired = await acquireOrphanWriteLock(cwd, { timeoutMs: ORPHAN_WRITE_REQUIRED_TIMEOUT_MS });
	if (!acquired) {
		throw new OrphanWriteBusyError(label, ORPHAN_WRITE_REQUIRED_TIMEOUT_MS);
	}
	try {
		return await runHoldingOrphanWriteLock(cwd, fn);
	} finally {
		await releaseOrphanWriteLock(cwd);
	}
}

/**
 * The DEFERRABLE sibling of {@link withRequiredOrphanWriteLock}: on contention
 * it answers `onBusy()` instead of throwing, for callers whose write is a
 * background reconciliation that the next pass will redo.
 *
 * It exists so those callers stop hand-rolling `acquireOrphanWriteLock`. A
 * hand-rolled acquire neither consults nor registers the async-context store,
 * which breaks re-entrancy in BOTH directions: nested inside a caller that
 * already holds the lock it polls out its whole budget against its own call
 * chain and then "defers" — a self-block that logs identically to real
 * contention, so it reads as normal in production while the write never lands
 * (measured on `jolli compile`: the search-index rebuild runs inside
 * `MultiRepoCompile`'s `writeGuard`, reaches `getCatalogWithLazyBuild`, and the
 * catalog reconciliation is skipped every time) — and, holding the lock without
 * registering, any wrapper BELOW it self-blocks in turn.
 *
 * `onBusy` may be async: a deferring caller often still has to build the
 * in-memory answer it returns instead of the persisted one.
 */
export async function withDeferrableOrphanWriteLock<T>(
	cwd: string | undefined,
	onBusy: () => T | Promise<T>,
	fn: () => Promise<T>,
): Promise<T> {
	if (holdsOrphanWriteLock(cwd)) return await fn();
	if (!(await acquireOrphanWriteLock(cwd, { timeoutMs: ORPHAN_WRITE_BEST_EFFORT_TIMEOUT_MS }))) {
		return await onBusy();
	}
	try {
		return await runHoldingOrphanWriteLock(cwd, fn);
	} finally {
		await releaseOrphanWriteLock(cwd);
	}
}

/**
 * Returns true if the entry is a root-level summary (not a child of a
 * squash/amend tree). Covers both v3 roots (`null`) and v1 legacy entries
 * (`undefined`) so both branches share one predicate.
 */
function isRootEntry(e: SummaryIndexEntry): boolean {
	return e.parentCommitHash == null;
}

/**
 * Merges two index snapshots into a single base view used by `storeSummary`'s
 * upcoming dual-write. Used when a write path has both a write-side index
 * (e.g. orphan branch primary) and a read-side index (e.g. FolderStorage
 * shadow) that may legitimately diverge — most commonly when peer-synced rows
 * land in the folder before the orphan branch catches up. Write-side wins on
 * collision (orphan is system-of-record) and contributes the `commitAliases`
 * defaults; read-side-only entries and aliases are appended so the rebuilt
 * index that gets persisted to both backends doesn't drop any rows that the
 * user can currently see.
 */
function unionIndexes(writeIndex: SummaryIndex | null, readIndex: SummaryIndex | null): SummaryIndex | null {
	if (!writeIndex && !readIndex) return null;
	if (!readIndex) return writeIndex;
	if (!writeIndex) return readIndex;
	const merged = new Map<string, SummaryIndexEntry>();
	for (const e of readIndex.entries) merged.set(e.commitHash, e);
	for (const e of writeIndex.entries) merged.set(e.commitHash, e);
	const aliases = { ...(readIndex.commitAliases ?? {}), ...(writeIndex.commitAliases ?? {}) };
	return {
		version: writeIndex.version,
		entries: [...merged.values()],
		...(Object.keys(aliases).length > 0 && { commitAliases: aliases }),
	};
}

/** Catalog counterpart of {@link unionIndexes}; same write-wins semantics. */
function unionCatalogs(writeCatalog: CommitCatalog | null, readCatalog: CommitCatalog | null): CommitCatalog | null {
	if (!writeCatalog && !readCatalog) return null;
	if (!readCatalog) return writeCatalog;
	if (!writeCatalog) return readCatalog;
	const merged = new Map<string, CatalogEntry>();
	for (const e of readCatalog.entries) merged.set(e.commitHash, e);
	for (const e of writeCatalog.entries) merged.set(e.commitHash, e);
	return { version: writeCatalog.version, entries: [...merged.values()] };
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
 * @param summary     - The commit summary to store (root of the tree)
 * @param cwd         - Optional working directory (git repo root)
 * @param force       - When true, overwrites an existing summary for the same commit hash
 *                      instead of skipping (used by the manual `summarize` CLI command)
 * @param artifacts   - Optional artifacts to store atomically alongside the summary.
 *                      `transcript.id` is the v5 transcript ID under which the data
 *                      is persisted (`transcripts/{id}.json`). Callers MUST also set
 *                      `summary.transcripts` to include this ID — `storeSummary` does
 *                      not stamp it on automatically. Generate the ID via
 *                      `generateTranscriptId()` for new content; for migration paths
 *                      that reuse a legacy commit-hash filename, pass that hash here.
 * @param storage     - Write storage. Drives the actual writeFiles call.
 * @param readStorage - Optional secondary read storage whose index/catalog rows
 *                      must be preserved in the upcoming dual-write. When passed
 *                      and distinct from `storage`, the existing index/catalog
 *                      base is union'd across both backends (write-side wins on
 *                      collision since orphan is system-of-record) so rows that
 *                      live only on the read side — e.g. peer-synced FolderStorage
 *                      entries the orphan branch hasn't caught up to yet —
 *                      survive the dual-write that follows. Without this, the
 *                      newly built index would replace the shadow's index.json
 *                      with one derived from primary-only rows and silently
 *                      drop the read-only-side entries.
 */
export async function storeSummary(
	summary: CommitSummary,
	cwd?: string,
	force = false,
	artifacts?: {
		readonly transcript?: { readonly id: string; readonly data: StoredTranscript };
		readonly planProgress?: ReadonlyArray<PlanProgressArtifact>;
	},
	storage?: StorageProvider,
	readStorage?: StorageProvider,
): Promise<void> {
	// Checked BEFORE the lock: acquiring orphan-write.lock is itself a disk
	// write (mkdir + lock file), so the storage-level writeFiles gate alone
	// would still leave a lock artifact behind on a manually-disabled project.
	if (isManuallyDisabled()) return;
	await withRequiredOrphanWriteLock(cwd, "storeSummary", () =>
		storeSummaryLocked(summary, cwd, force, artifacts, storage, readStorage),
	);
}

/**
 * The body of {@link storeSummary}, minus the lock.
 *
 * Named so a second writer (`remountStrandedTree`) can run it under its OWN
 * lock acquisition. Calling the public `storeSummary` from inside another
 * locked section would acquire the lock a second time; the lock refuses even
 * its own PID, so that write polls out its budget and then reports
 * contention — a log line identical to real contention, while nothing lands.
 */
async function storeSummaryLocked(
	summary: CommitSummary,
	cwd?: string,
	force = false,
	artifacts?: {
		readonly transcript?: { readonly id: string; readonly data: StoredTranscript };
		readonly planProgress?: ReadonlyArray<PlanProgressArtifact>;
	},
	storage?: StorageProvider,
	readStorage?: StorageProvider,
): Promise<void> {
	const writeIndex = await loadIndex(cwd, storage);
	const writeCatalog = await loadCatalog(cwd, storage);
	// Union the read-side (folder shadow) snapshot into the base so
	// peer-synced rows survive the dual-write rewrite. See
	// `unionIndexes` for merge semantics; the matching payload-lift
	// below uses `folderOnlyHashes` to keep the writeStorage backing
	// files in sync with the rebuilt index.
	const hasDistinctReadStorage = readStorage !== undefined && readStorage !== storage;
	const readIndex = hasDistinctReadStorage ? await loadIndex(cwd, readStorage) : null;
	const readCatalog = hasDistinctReadStorage ? await loadCatalog(cwd, readStorage) : null;
	const existingIndex = hasDistinctReadStorage ? unionIndexes(writeIndex, readIndex) : writeIndex;
	const existingCatalog = hasDistinctReadStorage ? unionCatalogs(writeCatalog, readCatalog) : writeCatalog;
	const existingEntries = existingIndex?.entries ? [...existingIndex.entries] : [];
	const entryMap = new Map(existingEntries.map((e) => [e.commitHash, e]));

	// Hashes whose index row was contributed by readStorage but whose
	// backing `summaries/<hash>.json` payload hasn't reached writeStorage
	// yet. Without lifting these files into the same write batch, the
	// orphan branch ends up with index entries that point at payloads
	// only the folder side actually has — and every orphan-routed
	// reader (`getSummary`/`readSummaryFile` via the active storage,
	// `QueueWorker.loadSourceSummaries`, `SummaryExporter`) returns
	// null on those rows. `DualWriteStorage.readFile` is primary-only,
	// so even in dual-write mode we cannot lean on the folder for
	// payload resolution at read time — orphan must be self-complete.
	const folderOnlyHashes = new Set<string>();
	if (hasDistinctReadStorage && readIndex) {
		const writeHashes = new Set(writeIndex?.entries.map((e) => e.commitHash) ?? []);
		for (const entry of readIndex.entries) {
			if (!writeHashes.has(entry.commitHash)) folderOnlyHashes.add(entry.commitHash);
		}
	}

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

	// Append transcript file if provided. Path is keyed by the v5 transcript
	// ID, not the commit hash — caller is responsible for matching the ID to
	// the IDs listed in `summary.transcripts`.
	if (artifacts?.transcript && artifacts.transcript.data.sessions.length > 0) {
		files.push({
			path: `transcripts/${artifacts.transcript.id}.json`,
			content: JSON.stringify(artifacts.transcript.data, null, "\t"),
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

	// Backfill the payloads behind every folder-only index row so the
	// orphan branch ends this commit with index → file integrity.
	// Missing files (embedded squash children that never had their
	// own `summaries/<hash>.json`) are silently skipped — leaving
	// the index row alone is the right behavior there since the
	// child resolves through its parent root's blob via
	// `flattenSummaryTree` / `getSummary`'s prefix scan. The headline
	// summary's own hash is skipped because its payload is already in
	// the batch above (avoids a duplicate path inside one `writeFiles`).
	if (folderOnlyHashes.size > 0 && readStorage) {
		for (const hash of folderOnlyHashes) {
			if (hash === summary.commitHash) continue;
			const summaryPath = `summaries/${hash}.json`;
			const transcriptPath = `transcripts/${hash}.json`;
			const summaryPayload = await readStorage.readFile(summaryPath);
			if (summaryPayload !== null) {
				files.push({ path: summaryPath, content: summaryPayload });
			}
			const transcriptPayload = await readStorage.readFile(transcriptPath);
			if (transcriptPayload !== null) {
				files.push({ path: transcriptPath, content: transcriptPayload });
			}
		}
	}

	const store = await resolveStorage(storage, cwd);
	await store.writeFiles(
		files,
		`${verb} summary for ${summary.commitHash.substring(0, 8)}: ${summary.commitMessage.substring(0, 50)}`,
	);

	log.info("Summary stored successfully for commit %s", summary.commitHash.substring(0, 8));
}

/**
 * The fields a rewrite copies from the old root onto the new one.
 *
 * Copy, not move: skills are deliberately NOT stripped off the child
 * (`stripFunctionalMetadata` has no stripSkills), so root and child hold the
 * same ref. A later squash's `collectChildSkills` meets each ref from both
 * ends and `mergeSkillRefs` dedupes by `archivedKey`.
 *
 * The skill-usage article id/url are hoisted for the same reason the article's
 * content is unchanged across a rewrite: the new root carries the SAME refs as
 * the old one, so the next push must update that article in place rather than
 * publish a duplicate. Dropping the id would leave the original stranded under
 * a hash the branch no longer has.
 *
 * References get the same Copy-Hoist treatment as plans / notes: without it, a
 * rewrite would silently drop reference refs from the new root even though the
 * registry still points at correctly-archived snapshot files.
 *
 * ONE definition, two callers (`migrateOneToOne` and `remountStrandedTree`).
 * A second hand-maintained list is how the next field gets dropped, and the
 * failure is silent: a memory simply missing its skills, with nothing to say so.
 *
 * It answers WHICH fields travel, never how they combine. The copy semantics
 * here are correct only where the destination has nothing of its own to lose —
 * true of `migrateOneToOne`'s brand-new root, false of `remountStrandedTree`'s
 * target, which therefore unions each field against the target's own on top of
 * this result. Do not fold those unions in here.
 */
export function copyHoistFields(oldSummary: CommitSummary): Partial<CommitSummary> {
	return {
		...(oldSummary.skills && { skills: oldSummary.skills }),
		...(oldSummary.jolliSkillsDocId && { jolliSkillsDocId: oldSummary.jolliSkillsDocId }),
		...(oldSummary.jolliSkillsDocUrl && { jolliSkillsDocUrl: oldSummary.jolliSkillsDocUrl }),
		...(oldSummary.transcripts && { transcripts: oldSummary.transcripts }),
		...(oldSummary.plans && { plans: oldSummary.plans }),
		...(oldSummary.notes && { notes: oldSummary.notes }),
		...(oldSummary.references && { references: oldSummary.references }),
	};
}

/**
 * Attach a stranded tree under a target that ALREADY has its own memory.
 *
 * The counterpart to `migrateOneToOne`, for the case that function cannot
 * serve: its `topics` come from `resolveEffectiveTopics(oldSummary)`, so it
 * would overwrite the target's own topics and recap. Here the target's
 * generated content wins and only the tree and the hoisted refs come across.
 *
 * **Every hoisted array is a UNION with the target's own, not a copy over it.**
 * `copyHoistFields` alone is copy-not-merge, which is safe in `migrateOneToOne`
 * (its target is a brand-new root with nothing to lose) and is data loss here
 * by construction: this path exists precisely because the target ALREADY has
 * its own memory. Under the v5 contract `transcripts` is always present, so a
 * plain copy always replaced the target's own conversation IDs — and since
 * `children` is `[strandedRoot]` alone, those IDs then existed nowhere in the
 * tree, while the command reported the repair as a success. This is the exact
 * "a memory simply missing its skills, with nothing to say so" failure the
 * shared `copyHoistFields` was introduced to prevent, one layer along.
 *
 * The union rules are `mergeManyToOneLocked`'s, reused rather than restated:
 * `mergeRefsNewWins` + `snapshotKeyOf` for plans / notes / references (the
 * target's own refs are the newer side and win a key collision), `mergeSkillRefs`
 * for skills (accumulates per skill, dedupes by `archivedKey`), a `Set` union
 * for transcript IDs, and `collectChildSkillsDocMeta`'s newest-wins for the
 * skill-usage article scalars — whose losing id joins `orphanedDocIds`, or the
 * target's published article is stranded on the Space with nothing pointing at it.
 *
 * `copyHoistFields` stays the single definition of WHICH fields travel; the
 * unions below only change how each one is combined. Do not move them into the
 * helper — `migrateOneToOne` must keep copying.
 *
 * Uses the same lock wrapper as every other orphan write. The caller must NOT
 * hold the lock — a nested acquire self-blocks and reports contention while
 * the write silently never lands.
 */
export async function remountStrandedTree(
	target: CommitSummary,
	strandedRoot: CommitSummary,
	cwd?: string,
	storage?: StorageProvider,
): Promise<void> {
	if ((target.children ?? []).length > 0) {
		throw new Error(`target ${target.commitHash.substring(0, 8)} already has children — refusing to clobber`);
	}
	if (isManuallyDisabled()) return;

	// Stranded refs first, target's second: `mergeRefsNewWins` lets the SECOND
	// argument win a key collision, and the target's memory is the newer one —
	// its refs point at the orphan-branch snapshots written most recently.
	const plans = mergeRefsNewWins(strandedRoot.plans, target.plans, snapshotKeyOf.plan);
	const notes = mergeRefsNewWins(strandedRoot.notes, target.notes, snapshotKeyOf.note);
	const references = mergeRefsNewWins(strandedRoot.references, target.references, snapshotKeyOf.reference);
	const transcripts = [...new Set<string>([...(target.transcripts ?? []), ...(strandedRoot.transcripts ?? [])])];
	const foldedSkills = mergeSkillRefs([...(strandedRoot.skills ?? []), ...(target.skills ?? [])]);
	// Same drain `mergeManyToOneLocked` owes: the fold banks the ids it discards
	// on `supersededDocIds`, and they must reach `orphanedDocIds` and be stripped
	// off the persisted refs so a later merge cannot re-report them.
	const supersededSkillDocIds = foldedSkills.flatMap((s) => s.supersededDocIds ?? []);
	const skillsDocMeta = collectChildSkillsDocMeta([target, strandedRoot]);
	// The stranded root keeps its own pending-cleanup queue (ids/hashes it banked
	// from its own past merges). Push reads these at the ROOT only, and the v5
	// normalize step that would otherwise drain a descendant's queue is a no-op,
	// so anything left on the stranded child leaks forever — the same drain
	// `mergeManyToOneLocked` performs for its children (`inheritedOrphanIds`).
	// `collectDescendant*([strandedRoot])` folds the stranded root's own queue plus
	// every descendant's. Unlike a merge, the stranded root is RESCUED, not
	// superseded, so its own article is NOT orphaned here.
	const orphanedDocIds = [
		...new Set<number>([
			...(target.orphanedDocIds ?? []),
			...skillsDocMeta.orphanedDocIds,
			...supersededSkillDocIds,
			...collectDescendantOrphanedDocIds([strandedRoot]),
		]),
	];
	const unresolvedOrphanHashes = [
		...new Set<string>([
			...(target.unresolvedOrphanHashes ?? []),
			...collectDescendantUnresolvedOrphanHashes([strandedRoot]),
		]),
	];

	const merged: CommitSummary = {
		...target,
		// Keeps `copyHoistFields` the one place the FIELD SET is declared, so a
		// field added there still travels here even before it gets a union rule.
		...copyHoistFields(strandedRoot),
		...(transcripts.length > 0 && { transcripts }),
		...(plans.length > 0 && { plans }),
		...(notes.length > 0 && { notes }),
		...(references.length > 0 && { references }),
		...(foldedSkills.length > 0 && { skills: foldedSkills.map(stripSupersededDocIds) }),
		...(skillsDocMeta.winner && {
			jolliSkillsDocId: skillsDocMeta.winner.jolliSkillsDocId,
			jolliSkillsDocUrl: skillsDocMeta.winner.jolliSkillsDocUrl,
		}),
		...(orphanedDocIds.length > 0 && { orphanedDocIds }),
		...(unresolvedOrphanHashes.length > 0 && { unresolvedOrphanHashes }),
		children: [strandedRoot],
	};
	await withRequiredOrphanWriteLock(cwd, "remountStrandedTree", () =>
		storeSummaryLocked(merged, cwd, true, undefined, storage),
	);
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
	storage?: StorageProvider,
): Promise<void> {
	await withRequiredOrphanWriteLock(cwd, "migrateOneToOne", () =>
		migrateOneToOneLocked(oldSummary, newCommitInfo, cwd, metadata, storage),
	);
}

async function migrateOneToOneLocked(
	oldSummary: CommitSummary,
	newCommitInfo: CommitInfo,
	cwd?: string,
	metadata?: { readonly commitType?: CommitType; readonly commitSource?: CommitSource },
	storage?: StorageProvider,
): Promise<void> {
	log.info(
		"Migrating summary 1:1: %s → %s",
		oldSummary.commitHash.substring(0, 8),
		newCommitInfo.hash.substring(0, 8),
	);

	// Wrap the old summary as a child rather than replacing its hash.
	// stripFunctionalMetadata strips all 10 Hoist fields, including delayed
	// orphan cleanup hashes, so the root is solely authoritative.
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
	// Same legacy-aware Copy-Hoist for recap. A v3 squash root keeps its recap on
	// children (not the root), so reading `oldSummary.recap` directly would drop
	// it on rebase-pick. `resolveEffectiveRecap` picks the root's recap when set,
	// else the newest descendant's — matching normalizeToV4's behavior.
	const hoistedRecap = resolveEffectiveRecap(oldSummary);

	// Carry transcript IDs through 1:1 — rebase-pick doesn't change content,
	// only commit hash. v5 data has them on root; v3/v4 data falls back to the
	// children-tree walk, filtered to commit hashes that actually have a
	// transcript file (mirrors the v5 migration's upgradeOneSummary so we don't
	// bake dangling IDs for session-less commits into the authoritative array).
	const existingTranscriptFileIds = await getTranscriptHashes(cwd, storage);
	const inheritedTranscriptIds = resolveTranscriptIdsFiltered(oldSummary, existingTranscriptFileIds);

	const newSummary: CommitSummary = {
		version: CURRENT_SCHEMA_VERSION,
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
		...(oldSummary.unresolvedOrphanHashes && { unresolvedOrphanHashes: oldSummary.unresolvedOrphanHashes }),
		// Copy-Hoist: skills (+ the skill-usage article id/url), transcripts,
		// plans, notes and references. See `copyHoistFields` for the full
		// rationale — this is the ONE definition shared with
		// `remountStrandedTree`; a second hand-maintained list here is how the
		// next field silently drops. The `transcripts` this contributes is
		// overridden below by `inheritedTranscriptIds`, which is filtered
		// against files that actually exist on disk.
		...copyHoistFields(oldSummary),
		...(oldSummary.e2eTestGuide && { e2eTestGuide: oldSummary.e2eTestGuide }),
		// summaryError marker — rebase-pick doesn't run the LLM, so a degraded
		// old summary stays degraded on the new hash. Use isSummaryError() so
		// legacy summaries (only `llm.stopReason: "error"`, no summaryError
		// field) get upgraded to the new marker on migration. Without this,
		// the rebased commit's webview would lose its Regenerate banner.
		...(isSummaryError(oldSummary) && { summaryError: LLM_FAILED }),
		topics: hoistedTopics,
		...(hoistedRecap !== undefined ? { recap: hoistedRecap } : {}),
		// v5 contract: always present, even if empty. Length-0 is the right
		// signal for "no AI sessions captured for this commit" so the read path
		// hits the fast `summary.transcripts` lookup instead of the v3/v4
		// children-walk fallback.
		transcripts: inheritedTranscriptIds,
		diffStats: migratedDiffStats,
		children: [strippedOld],
	};

	const existingIndex = await loadIndex(cwd, storage);
	const existingCatalog = await loadCatalog(cwd, storage);
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

	const store = await resolveStorage(storage, cwd);
	await store.writeFiles(
		files,
		`Migrate summary ${oldSummary.commitHash.substring(0, 8)} → ${newCommitInfo.hash.substring(0, 8)}`,
	);
	log.info("Summary migrated: %s → %s", oldSummary.commitHash.substring(0, 8), newCommitInfo.hash.substring(0, 8));
}

/** Recursively collects all E2E test scenarios from a list of summaries. */
export function collectChildE2eScenarios(nodes: ReadonlyArray<CommitSummary>): ReadonlyArray<E2eTestScenario> {
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
export function collectChildPlans(nodes: ReadonlyArray<CommitSummary>): ReadonlyArray<PlanReference> {
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
export function collectChildNotes(nodes: ReadonlyArray<CommitSummary>): ReadonlyArray<NoteReference> {
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

/**
 * Returns a deep copy of the summary tree with `references` stripped from every
 * node. Hoist invariant requires the field gone from descendants whenever a
 * higher root carries the consolidated value.
 */
function stripReferences(node: CommitSummary): CommitSummary {
	const { references: _e, ...rest } = node;
	if (!rest.children) return rest as CommitSummary;
	return { ...rest, children: rest.children.map(stripReferences) } as CommitSummary;
}

/**
 * Recursively collects all ReferenceCommitRefs from a list of summaries, deduped
 * by `archivedKey`. Walks `node.references`. Parallel to collectChildPlans /
 * collectChildNotes — on squash / rebase-pick the root must inherit every
 * referenced reference from every source commit, otherwise stripReferences (called
 * below) drops them.
 */
export function collectChildReferences(nodes: ReadonlyArray<CommitSummary>): ReadonlyArray<ReferenceCommitRef> {
	const refMap = new Map<string, ReferenceCommitRef>();
	for (const node of nodes) {
		const own = node.references ?? [];
		for (const ref of own) {
			const existing = refMap.get(ref.archivedKey);
			/* v8 ignore start -- "existing+older" tie-breaker fires only when the same archivedKey appears twice at the same tree depth with diff referencedAt; uncommon in real commit trees. */
			if (!existing || ref.referencedAt > existing.referencedAt) {
				refMap.set(ref.archivedKey, ref);
			}
			/* v8 ignore stop */
		}
		/* v8 ignore start -- recursive child descent + tie-breaker for cross-depth duplicate archivedKey; the merge-hoist test covers shallow dedupe, but cross-depth same-key with diff referencedAt is a rare squash-of-merge case. */
		if (node.children) {
			for (const child of collectChildReferences(node.children)) {
				const existing = refMap.get(child.archivedKey);
				if (!existing || child.referencedAt > existing.referencedAt) {
					refMap.set(child.archivedKey, child);
				}
			}
		}
		/* v8 ignore stop */
	}
	return [...refMap.values()];
}

/**
 * Recursively collects all SkillCommitRefs from a list of summaries, ACCUMULATED per
 * skill rather than deduped. Parallel to collectChildPlans / collectChildNotes /
 * collectChildReferences — without it a squash root inherits none of its sources'
 * skill usage and the record is lost with the children.
 *
 * Accumulation, not dedupe, is the difference from the reference collector: each ref
 * is one commit's INCREMENT (see uncommittedDelta), so collapsing three commits that
 * each entered a skill once must report three entries, not one. `mergeSkillRefs` is
 * the same fold the PR-wide aggregate uses, so the two cannot disagree.
 *
 * The returned refs may carry `supersededDocIds` — every caller that persists them
 * must drain those into the root's `orphanedDocIds` and {@link stripSupersededDocIds}.
 */
export function collectChildSkills(nodes: ReadonlyArray<CommitSummary>): ReadonlyArray<SkillCommitRef> {
	const all: SkillCommitRef[] = [];
	for (const node of nodes) {
		all.push(...(node.skills ?? []));
		if (node.children) all.push(...collectChildSkills(node.children));
	}
	return mergeSkillRefs(all);
}

/**
 * Working-area Context refs a caller just associated with the new commit, to be
 * merged into a hoisted root alongside the refs inherited from its children.
 * Mirrors the `newRefs` parameter of `buildHoistedAmendRoot`.
 */
export interface NewlyAssociatedRefs {
	readonly plans?: ReadonlyArray<PlanReference>;
	readonly notes?: ReadonlyArray<NoteReference>;
	readonly references?: ReadonlyArray<ReferenceCommitRef>;
}

/** Returns a deep copy of the summary tree with Jolli metadata stripped from all nodes. */
function stripJolliMetadata(node: CommitSummary): CommitSummary {
	const {
		jolliDocId: _d,
		jolliDocUrl: _u,
		// Stripped alongside them: the merge above has already adopted one child's
		// skill-usage article and orphaned the rest, so leaving an id on a retained
		// child would make a later squash re-report an article that is gone.
		jolliSkillsDocId: _sd,
		jolliSkillsDocUrl: _su,
		orphanedDocIds: _o,
		unresolvedOrphanHashes: _h,
		...rest
	} = node;
	if (!rest.children) return rest as CommitSummary;
	return { ...rest, children: rest.children.map(stripJolliMetadata) } as CommitSummary;
}

/** Hoist result for Jolli memory article metadata from children. */
export interface JolliMetaHoistResult {
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
export function collectChildJolliMeta(nodes: ReadonlyArray<CommitSummary>): JolliMetaHoistResult {
	const candidates: Array<{
		jolliDocId: number;
		jolliDocUrl: string;
		commitDate: string;
		generatedAt: string;
	}> = [];
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

/**
 * The squash counterpart of {@link collectChildJolliMeta} for the per-commit
 * SKILL-USAGE article (`CommitSummary.jolliSkillsDocId`).
 *
 * **Same rule, deliberately: newest child wins, the rest are orphaned.** A squash
 * root's skill table is the FOLD of its children's, so no child's article is still
 * the same document — but exactly one of them can be updated in place instead of
 * being deleted and replaced, which is both fewer round-trips and one less way to
 * fail: `cleanupOrphanedDocs` is best-effort, and until a failed delete is retried,
 * a mint-a-new-one policy leaves N stale articles beside the new one rather than
 * N-1 beside the live one.
 *
 * Adopting the winner also keeps this identical to how the memory article itself
 * behaves across a squash, which is what makes the two comprehensible together — a
 * reader does not have to learn a second rule for the sibling document. The winner
 * is picked by `getDisplayDate` for the same reason, so in practice both ids come
 * from the same child.
 *
 * Recurses like its sibling, so a grandchild's article is not stranded by a squash
 * of squashes.
 */
export function collectChildSkillsDocMeta(nodes: ReadonlyArray<CommitSummary>): {
	winner: { jolliSkillsDocId: number; jolliSkillsDocUrl: string } | null;
	orphanedDocIds: number[];
} {
	const { winner, orphanedDocIds } = collectDatedChildSkillsDocMeta(nodes);
	// Dates dropped only HERE, at the outermost call: they exist to be compared,
	// and the caller stores none of them.
	return {
		winner: winner && { jolliSkillsDocId: winner.jolliSkillsDocId, jolliSkillsDocUrl: winner.jolliSkillsDocUrl },
		orphanedDocIds,
	};
}

/** One skill-article candidate, carrying the dates the competition is decided on. */
interface DatedSkillsDocMeta {
	readonly jolliSkillsDocId: number;
	readonly jolliSkillsDocUrl: string;
	readonly commitDate: string;
	readonly generatedAt: string;
}

/**
 * The recursion behind {@link collectChildSkillsDocMeta}, kept separate for one
 * reason: a winner must travel with ITS OWN dates.
 *
 * This mirrors `JolliMetaHoistResult.winner`, which carries them for exactly the
 * same purpose, and the mirroring is the point — the two helpers claim to apply
 * one rule, so a difference here is a difference in which document gets updated
 * in place. Re-stamping an inner winner with the parent node's dates (which this
 * used to do, having no dates to pass up) diverges in two ways at once: a
 * grandchild that won on a fresh `generatedAt` re-enters the outer round wearing
 * its parent's older date and loses to a sibling it should beat, and a node that
 * holds an article AND has children produces two candidates with identical dates,
 * where the stable sort silently prefers the shallower one.
 */
function collectDatedChildSkillsDocMeta(nodes: ReadonlyArray<CommitSummary>): {
	winner: DatedSkillsDocMeta | null;
	orphanedDocIds: number[];
} {
	const candidates: DatedSkillsDocMeta[] = [];
	for (const node of nodes) {
		const url = node.jolliSkillsDocUrl;
		if (node.jolliSkillsDocId && url) {
			candidates.push({
				jolliSkillsDocId: node.jolliSkillsDocId,
				jolliSkillsDocUrl: url,
				commitDate: node.commitDate,
				generatedAt: node.generatedAt,
			});
		}
		if (node.children) {
			// The deeper merge already orphaned its own losers; only its winner
			// competes here, with the dates that won it that round.
			const inner = collectDatedChildSkillsDocMeta(node.children);
			if (inner.winner) candidates.push(inner.winner);
		}
	}
	if (candidates.length === 0) return { winner: null, orphanedDocIds: [] };
	candidates.sort((a, b) => new Date(getDisplayDate(b)).getTime() - new Date(getDisplayDate(a)).getTime());
	const [winner, ...losers] = candidates;
	return { winner, orphanedDocIds: losers.map((c) => c.jolliSkillsDocId) };
}

/**
 * Recursively walks descendants and collects every node's orphanedDocIds.
 * Companion to collectChildJolliMeta: that helper only surfaces orphans
 * created by the current merge, but legacy children may already carry their
 * own pending-cleanup queue. Used by normalizeToV4 so a v3 → v4 migration
 * doesn't lose previously-orphaned doc IDs at the strip step.
 */
function collectDescendantOrphanedDocIds(children: ReadonlyArray<CommitSummary> | undefined): number[] {
	const ids: number[] = [];
	for (const child of children ?? []) {
		if (child.orphanedDocIds) ids.push(...child.orphanedDocIds);
		ids.push(...collectDescendantOrphanedDocIds(child.children));
	}
	return ids;
}

/** Recursively collects unresolved article hashes already queued on descendants. */
function collectDescendantUnresolvedOrphanHashes(children: ReadonlyArray<CommitSummary> | undefined): string[] {
	const hashes: string[] = [];
	for (const child of children ?? []) {
		if (child.unresolvedOrphanHashes) hashes.push(...child.unresolvedOrphanHashes);
		hashes.push(...collectDescendantUnresolvedOrphanHashes(child.children));
	}
	return hashes;
}

/**
 * Pure in-memory v3 → v4 (unified Hoist) normalization. No I/O — caller
 * persists the result via storeSummary if it wants the migration to stick.
 *
 * Establishes the same invariant first-run amend / squash already enforce via
 * `buildHoistedAmendRoot` / `mergeManyToOne`:
 *   - version: 4
 *   - root holds the authoritative Copy-Hoist fields (plans / notes /
 *     references / e2eTestGuide / jolliDocId / jolliDocUrl /
 *     orphanedDocIds / unresolvedOrphanHashes), unioned across the whole tree via the same
 *     `collectChild*` helpers
 *   - root holds authoritative `topics` and `recap` collected from the
 *     entire tree via `resolveEffectiveTopics` / `resolveEffectiveRecap`
 *     (added 2026-05-22 so v5 migration and any other lossless caller can
 *     trust the helper without external rescue logic)
 *   - root holds `diffStats` (migrated from legacy `stats` when needed)
 *   - every descendant is stripped of own-hoist fields
 *
 * The earlier draft of this helper left topics/recap on the root untouched
 * because the only caller (Regenerator) was about to overwrite them with a
 * fresh LLM call. That made the helper lossy for v3 squash roots (whose
 * topics live in children, not on root). Now lossless: callers that want
 * fresh topics/recap (Regenerator) overwrite the returned object explicitly;
 * callers that want preservation (v5 migration) just use the result as-is.
 *
 * A no-op for v4 input (returns the same reference). The version gate is
 * `>= 4`, not `=== 4`, so v5+ input is also a no-op — see the test fixture
 * pinning this behavior in normalizeToV4.test.ts.
 *
 * Used by Regenerator, RegenerateContext, and the v5 schema migration to
 * collapse all v3-special-casing — once normalized, downstream code can
 * assume a clean v4 tree (topics/recap/diffStats all populated on root).
 *
 * Only the canonical `references[]` field is hoisted.
 */
export function normalizeToV4(summary: CommitSummary): CommitSummary {
	if (summary.version >= 4) return summary;

	const hoistedE2e = collectChildE2eScenarios([summary]);
	const hoistedPlans = collectChildPlans([summary]);
	const hoistedNotes = collectChildNotes([summary]);
	const hoistedReferences = collectChildReferences([summary]);
	// Folded skills, then the same drain `mergeManyToOneLocked` performs: the fold can
	// collapse several commits' published skill articles into one row, and an id left
	// on `supersededDocIds` here would be persisted as a live field pointing at an
	// article nothing will ever delete. Unreachable in practice (v3 predates skills),
	// but the fold's contract holds wherever it is called.
	const foldedSkills = collectChildSkills([summary]);
	const hoistedSkills = foldedSkills.map(stripSupersededDocIds);
	const jolliMeta = collectChildJolliMeta([summary]);
	// Dedup orphanedDocIds across the tree: jolliMeta surfaces orphans from
	// this normalize step's loser candidates; root + descendants may already
	// have their own pending cleanup queue.
	const allOrphanedDocIds = Array.from(
		new Set<number>([
			...jolliMeta.orphanedDocIds,
			...(summary.orphanedDocIds ?? []),
			...collectDescendantOrphanedDocIds(summary.children),
			...foldedSkills.flatMap((s) => s.supersededDocIds ?? []),
		]),
	);
	const allUnresolvedOrphanHashes = Array.from(
		new Set<string>([
			...(summary.unresolvedOrphanHashes ?? []),
			...collectDescendantUnresolvedOrphanHashes(summary.children),
		]),
	);

	// Hoist topics + recap from anywhere in the tree. Without this, v3 squash
	// roots (whose topics live in children) would normalize into a root with
	// empty topics, and stripFunctionalMetadata would then drop the children
	// topics too — data loss. resolveEffectiveTopics already exists for the
	// same reason in the rebase/squash migration paths; resolveEffectiveRecap
	// is its newly-added recap counterpart.
	const hoistedTopics = resolveEffectiveTopics(summary);
	const hoistedRecap = resolveEffectiveRecap(summary);

	// Migrate v3 `stats` → v4 `diffStats` when only the legacy field is set.
	// Display code's resolveDiffStats does this fallback at read time, but
	// normalizing here means persisted v5 data carries the canonical field and
	// the read-time fallback can eventually go away — which it only can if the
	// migrated record DROPS the legacy `stats`. So strip `stats` from the spread
	// below (destructure it out); the value survives as `diffStats`.
	//
	// Stamp the AGGREGATE (`resolveDiffStats`), NOT the raw `stats`. For a
	// container — e.g. an amend root whose own `stats` is just the delta — the
	// pre-v5 display went through `resolveDiffStats` → `aggregateStats` (delta +
	// children). Once we stamp `diffStats`, the v5 fast-path returns it directly
	// and never re-aggregates, so stamping the raw delta would silently SHRINK
	// the displayed files/insertions/deletions. `resolveDiffStats` returns the
	// aggregate for containers and the node's own stats for leaves, so it stamps
	// exactly what the old read path would have shown. (Called before the
	// destructure so it still sees the original `stats` + children.)
	const migratedDiffStats =
		summary.diffStats === undefined && summary.stats !== undefined ? resolveDiffStats(summary) : undefined;
	const { stats: _, ...summaryWithoutStats } = summary;

	return {
		...summaryWithoutStats,
		version: 4,
		topics: hoistedTopics,
		...(hoistedRecap !== undefined ? { recap: hoistedRecap } : {}),
		...(migratedDiffStats !== undefined ? { diffStats: migratedDiffStats } : {}),
		...(hoistedE2e.length > 0 ? { e2eTestGuide: hoistedE2e } : {}),
		...(hoistedPlans.length > 0 ? { plans: hoistedPlans } : {}),
		...(hoistedNotes.length > 0 ? { notes: hoistedNotes } : {}),
		...(hoistedReferences.length > 0 ? { references: hoistedReferences } : {}),
		...(hoistedSkills.length > 0 ? { skills: hoistedSkills } : {}),
		...(jolliMeta.winner
			? {
					jolliDocId: jolliMeta.winner.jolliDocId,
					jolliDocUrl: jolliMeta.winner.jolliDocUrl,
				}
			: {}),
		...(allOrphanedDocIds.length > 0 ? { orphanedDocIds: allOrphanedDocIds } : {}),
		...(allUnresolvedOrphanHashes.length > 0 ? { unresolvedOrphanHashes: allUnresolvedOrphanHashes } : {}),
		...(summary.children !== undefined ? { children: summary.children.map(stripFunctionalMetadata) } : {}),
	};
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
 * Returns the recap string to use as Copy-Hoist source when normalizing v3
 * legacy data to v4. Companion to `resolveEffectiveTopics`.
 *
 * Priority:
 *   - v4+ (unified Hoist): root.recap is authoritative — return it directly.
 *     May legitimately be undefined for topic-only commits.
 *   - v3 with root.recap set: root wins. Both legacy squash and legacy amend
 *     pipelines historically wrote recap to root, so this is the common case.
 *   - v3 with no root.recap but children carry one: pick the newest child's
 *     recap by display date (commitDate ?? generatedAt). Picks a single
 *     representative rather than concatenating because recap is semantically
 *     singular (one paragraph for this commit's work).
 *
 * Returns undefined when no node in the tree has a non-empty recap.
 */
export function resolveEffectiveRecap(oldSummary: CommitSummary): string | undefined {
	if (isUnifiedHoistFormat(oldSummary)) return oldSummary.recap;
	if (oldSummary.recap) return oldSummary.recap;
	return pickNewestDescendantRecap(oldSummary.children);
}

/**
 * Walks descendants depth-first collecting (recap, displayDate) pairs, then
 * returns the newest one. Stable secondary order falls out of traversal order
 * when display dates tie.
 */
function pickNewestDescendantRecap(children: ReadonlyArray<CommitSummary> | undefined): string | undefined {
	if (!children || children.length === 0) return undefined;
	const candidates: Array<{ readonly recap: string; readonly date: string }> = [];
	collectRecapCandidates(children, candidates);
	if (candidates.length === 0) return undefined;
	candidates.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
	return candidates[0]?.recap;
}

function collectRecapCandidates(
	nodes: ReadonlyArray<CommitSummary>,
	out: Array<{ readonly recap: string; readonly date: string }>,
): void {
	for (const node of nodes) {
		if (node.recap) {
			out.push({ recap: node.recap, date: getDisplayDate(node) });
		}
		if (node.children) {
			collectRecapCandidates(node.children, out);
		}
	}
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
 * Strips all 10 Hoist-managed fields from a summary node and its descendants.
 *
 * Hoist family (10 fields):
 *   - Copy-Hoist (8): jolliDocId, jolliDocUrl, orphanedDocIds,
 *                    unresolvedOrphanHashes, plans, notes, references, e2eTestGuide
 *   - Consolidate-Hoist (2): topics, recap
 *
 * `version` is intentionally NOT stripped -- it's an identity field, like
 * commitHash. A v4 root may legitimately contain a v3 stripped child (legacy
 * data on first migration); helpers always look at the root's own version.
 */
export function stripFunctionalMetadata(node: CommitSummary): CommitSummary {
	return stripJolliMetadata(
		stripReferences(stripNotes(stripPlans(stripE2eTestGuide(stripTopics(stripRecap(node)))))),
	);
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
	/**
	 * Set when the consolidation outcome was `"llm-error"` (real failure
	 * after retry exhaustion) or when a runtime error tripped the caller's
	 * defensive catch. Distinguishes it from `"no-content"` which also
	 * lands in mechanical fallback but is healthy (no marker).
	 * mergeManyToOne mirrors this onto the merged root so isSummaryError
	 * catches it on read.
	 */
	readonly summaryError?: import("../Types.js").SummaryErrorKind;
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
 *
 * `options.extraRefs` are the plans/notes/references the CALLER just associated
 * with the squash commit itself (via consumeWorkspaceContext) — refs that exist
 * in no child, so the collect* helpers cannot see them. They are unioned over
 * the hoisted set by SNAPSHOT key (`snapshotKeyOf`), not base key: see RefMerge's
 * header for why squash and amend need different keys here.
 *
 * The optional tail is one object rather than four positional parameters so a
 * caller that wants only the last one doesn't have to pass `undefined`
 * placeholders (and so adding a fifth doesn't shift anyone's argument list).
 */
export interface MergeManyToOneOptions {
	readonly metadata?: { readonly commitType?: CommitType; readonly commitSource?: CommitSource };
	readonly consolidated?: ConsolidatedTopics;
	readonly storage?: StorageProvider;
	readonly extraRefs?: NewlyAssociatedRefs;
	/**
	 * Skill refs archived for THIS squash, on top of whatever the children carry.
	 * A squash lands new work, so uncommitted skill rows belong on the root exactly
	 * as they would on a plain commit; the children's own refs cannot supply them.
	 */
	readonly extraSkills?: ReadonlyArray<SkillCommitRef>;
}

export async function mergeManyToOne(
	oldSummaries: ReadonlyArray<CommitSummary>,
	newCommitInfo: CommitInfo,
	cwd?: string,
	options?: MergeManyToOneOptions,
): Promise<{ orphanedDocIds: number[] }> {
	return withRequiredOrphanWriteLock(cwd, "mergeManyToOne", () =>
		mergeManyToOneLocked(oldSummaries, newCommitInfo, cwd, options),
	);
}

async function mergeManyToOneLocked(
	oldSummaries: ReadonlyArray<CommitSummary>,
	newCommitInfo: CommitInfo,
	cwd?: string,
	options?: MergeManyToOneOptions,
): Promise<{ orphanedDocIds: number[] }> {
	const { metadata, consolidated, storage, extraRefs, extraSkills } = options ?? {};
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
	// Children's refs ∪ the refs this squash just associated. Without the union
	// the newly archived orphan-branch snapshots would have no pointer from any
	// summary. Keyed by SNAPSHOT key (hash stamp included) — the amend paths' base
	// keys would collapse two children that archived the same logical item at
	// different commits and strand one of their orphan-branch files. See RefMerge.
	const hoistedPlans = mergeRefsNewWins(collectChildPlans(children), extraRefs?.plans, snapshotKeyOf.plan);
	const hoistedNotes = mergeRefsNewWins(collectChildNotes(children), extraRefs?.notes, snapshotKeyOf.note);
	const hoistedReferences = mergeRefsNewWins(
		collectChildReferences(children),
		extraRefs?.references,
		snapshotKeyOf.reference,
	);
	// Newly-archived rows (squash lands new work) merge with the children's own refs
	// through the same fold, so a skill entered both before and during the squash is
	// one row carrying the sum. Skills need no snapshot-key union: mergeSkillRefs
	// ACCUMULATES per skill instead of deduping, so nothing can be stranded.
	const foldedSkills = mergeSkillRefs([...collectChildSkills(children), ...(extraSkills ?? [])]);
	// A skill article is one document per (skill, COMMIT), so the fold above really
	// does supersede published articles: three commits' refs for one skill collapse to
	// one row that can only point at one of the three. `mergeSkillRef` banks the ids it
	// discards on `supersededDocIds`; this is the single place they are drained, into
	// the same `orphanedDocIds` list the superseded memory articles use, and stripped
	// off the persisted refs so a re-squash cannot re-report them.
	const hoistedSkills = foldedSkills.map(stripSupersededDocIds);
	const jolliMeta = collectChildJolliMeta(children);
	// The commit's skill-usage article follows the same newest-wins rule as the memory
	// article — see `collectChildSkillsDocMeta`. Losers join the same orphan list.
	const skillsDocMeta = collectChildSkillsDocMeta(children);
	const inheritedOrphanIds = children.flatMap((c) => c.orphanedDocIds ?? []);
	// LEGACY: ids left on refs from when a skill article was one document per (skill,
	// commit). Nothing writes them any more (the id lives on the summary), but stored
	// summaries still carry them and they must still be cleaned up.
	const supersededSkillDocIds = foldedSkills.flatMap((s) => s.supersededDocIds ?? []);
	const allOrphanedDocIds = [
		...jolliMeta.orphanedDocIds,
		...skillsDocMeta.orphanedDocIds,
		...inheritedOrphanIds,
		...supersededSkillDocIds,
	];

	// Children without jolliDocId may have been pushed to Space by a
	// concurrent pre-push sync that hasn't written back the docId yet (race).
	// Record their hashes so pushSummary can resolve them at push time and
	// clean up the orphaned Space articles.
	const unresolvedOrphanHashes = Array.from(
		new Set<string>([
			...children.filter((child) => !child.jolliDocId).map((child) => child.commitHash),
			...collectDescendantUnresolvedOrphanHashes(children),
		]),
	);

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
	const consolidatedSummaryError = consolidated?.summaryError;

	// Union the transcript IDs from every source commit into the merged root.
	// Squash kills the source commits in git history, so the merged root is
	// the only "live" referrer to their transcript files — listing every ID
	// at root is exactly what `getTranscriptIds(mergedRoot)` needs to find
	// the full conversation set. Legacy children walk the tree, filtered to
	// hashes with a real transcript file (mirrors the v5 migration so no
	// dangling IDs leak in); v5 children's arrays are authoritative. Dedup via
	// Set in case two sources share an ID (legitimate when a project has mixed
	// migrated-from-v3 hashes that happen to collide — rare but cheap to guard).
	const existingTranscriptFileIds = await getTranscriptHashes(cwd, storage);
	const mergedTranscriptIds = Array.from(
		new Set<string>(children.flatMap((child) => resolveTranscriptIdsFiltered(child, existingTranscriptFileIds))),
	);

	const mergedSummary: CommitSummary = {
		version: CURRENT_SCHEMA_VERSION,
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
		...(consolidatedSummaryError && { summaryError: consolidatedSummaryError }),
		...(hoistedE2e.length > 0 && { e2eTestGuide: hoistedE2e }),
		...(hoistedPlans.length > 0 && { plans: hoistedPlans }),
		...(hoistedNotes.length > 0 && { notes: hoistedNotes }),
		...(hoistedReferences.length > 0 && { references: hoistedReferences }),
		...(hoistedSkills.length > 0 && { skills: hoistedSkills }),
		...(jolliMeta.winner && {
			jolliDocId: jolliMeta.winner.jolliDocId,
			jolliDocUrl: jolliMeta.winner.jolliDocUrl,
		}),
		...(skillsDocMeta.winner && skillsDocMeta.winner),
		...(allOrphanedDocIds.length > 0 && { orphanedDocIds: allOrphanedDocIds }),
		...(unresolvedOrphanHashes.length > 0 && { unresolvedOrphanHashes }),
		topics: consolidatedTopics,
		...(consolidatedRecap && { recap: consolidatedRecap }),
		// v5 contract: always present, even if empty (see migrateOneToOne note).
		transcripts: mergedTranscriptIds,
		diffStats: mergedDiffStats,
		children: strippedChildren,
	};

	const existingIndex = await loadIndex(cwd, storage);
	const existingCatalog = await loadCatalog(cwd, storage);
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

	const store = await resolveStorage(storage, cwd);
	await store.writeFiles(files, `Merge summaries [${oldHashesStr}] → ${newCommitInfo.hash.substring(0, 8)}`);
	log.info(
		"Summaries merged: [%s] → %s (%d children, %d orphaned docs, %d unresolved orphan hashes)",
		oldHashesStr,
		newCommitInfo.hash.substring(0, 8),
		children.length,
		allOrphanedDocIds.length,
		unresolvedOrphanHashes.length,
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
export async function removeFromIndex(commitHash: string, cwd?: string, storage?: StorageProvider): Promise<void> {
	// Acquire orphan-write.lock before touching index/catalog: this function
	// performs a multi-file write that races with QueueWorker / scanTreeHashAliases
	// / storeSummary if unsynchronized. Loading the data inside the lock window
	// guarantees we operate on the most recent on-disk state.
	//
	// Best-effort path: defer when the lock is contended. removeFromIndex is an
	// admin cleanup and the caller can retry; deferring beats stomping a fresher
	// concurrent write.
	await withDeferrableOrphanWriteLock(
		cwd,
		() => {
			log.warn(
				"removeFromIndex: could not acquire orphan-write lock within %dms — skipping removal of %s",
				ORPHAN_WRITE_BEST_EFFORT_TIMEOUT_MS,
				commitHash.substring(0, 8),
			);
		},
		async () => {
			const existingIndex = await loadIndex(cwd, storage);
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
			const existingCatalog = await loadCatalog(cwd, storage);
			const catalogWrite = buildCatalogRemoveFileWrite(existingCatalog, commitHash);
			if (catalogWrite) {
				files.push(catalogWrite);
			}

			const store = await resolveStorage(storage, cwd);
			await store.writeFiles(files, `Remove index entry for ${commitHash.substring(0, 8)}`);
			log.info("Removed %s from index", commitHash.substring(0, 8));
		},
	);
}

// ─── Transcript API ──────────────────────────────────────────────────────────

/**
 * Reads a transcript for a specific commit from the orphan branch.
 * Returns null if no transcript file exists for the given commit hash.
 */
export async function readTranscript(
	commitHash: string,
	cwd?: string,
	storage?: StorageProvider,
): Promise<StoredTranscript | null> {
	const store = await resolveStorage(storage, cwd);
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
	storage?: StorageProvider,
): Promise<Map<string, StoredTranscript>> {
	const result = new Map<string, StoredTranscript>();
	for (const hash of commitHashes) {
		const transcript = await readTranscript(hash, cwd, storage);
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
	storage?: StorageProvider,
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
	// Pre-lock gate — see storeSummary for why this sits before the lock.
	if (isManuallyDisabled()) return;

	const summary = [
		writes.length > 0 ? `${writes.length} written` : "",
		deletes.length > 0 ? `${deletes.length} deleted` : "",
	]
		.filter(Boolean)
		.join(", ");

	await withRequiredOrphanWriteLock(cwd, "saveTranscriptsBatch", async () => {
		const store = await resolveStorage(storage, cwd);
		await store.writeFiles(files, `Update transcripts: ${summary}`);
		log.info("Transcript batch: %s", summary);
	});
}

/**
 * Deletes a single transcript file from the orphan branch.
 */
export async function deleteTranscript(commitHash: string, cwd?: string, storage?: StorageProvider): Promise<void> {
	await saveTranscriptsBatch([], [commitHash], cwd, storage);
}

/**
 * Returns the set of transcript IDs whose files exist in the orphan branch.
 * Scans the `transcripts/` prefix via the active storage provider.
 *
 * Filename grammar: `transcripts/{transcriptId}.json` where `transcriptId` is
 * an opaque string. Pre-v5 ("legacy") IDs reuse commit-hash text — all lower-
 * case hex; v5+ IDs are UUID v4 with hyphens (e.g.
 * `01234567-89ab-cdef-0123-456789abcdef`). The match accepts BOTH by extracting
 * everything before `.json` without assuming a format — earlier versions of
 * this helper used `[a-f0-9]+` and silently dropped v5 UUID files from the
 * intersection in `SummaryWebviewPanel.refreshTranscriptHashes`, hiding all
 * conversations for v5-written summaries.
 */
export async function getTranscriptHashes(cwd?: string, storage?: StorageProvider): Promise<Set<string>> {
	const store = await resolveStorage(storage, cwd);
	const files = await store.listFiles("transcripts/");
	const hashes = new Set<string>();
	for (const filePath of files) {
		// filePath = "transcripts/{id}.json" → extract "{id}". Tolerates any
		// non-empty opaque-string ID, including legacy hex-only commit hashes
		// and v5 UUIDs with hyphens. Shared parser keeps this in lockstep with
		// the v5 migration's filename parsing.
		const id = transcriptIdFromPath(filePath);
		if (id) {
			hashes.add(id);
		}
	}
	return hashes;
}

// ─── Public read API ──────────────────────────────────────────────────────────

/**
 * Length of a full SHA-1 git commit hash. Anything shorter is treated as an
 * abbreviated prefix and resolved via index scan rather than direct file /
 * alias lookup, since both of those keys are 40-char in production.
 */
const FULL_HASH_LENGTH = 40;

/**
 * Thrown by {@link getSummary} when an abbreviated hash matches multiple
 * entries in the index. Surfacing this (rather than silently picking one)
 * lets user-facing callers prompt for a longer prefix; internal callers that
 * always supply 40-char SHAs (e.g. iterating index entries) never trigger it.
 */
export class AmbiguousHashError extends Error {
	readonly prefix: string;
	/**
	 * Full 40-char SHAs of every entry that matched the abbreviated prefix.
	 * Carries the full list (not just a count) so user-facing callers can
	 * render the colliding hashes for disambiguation — `jolli view` /
	 * `jolli export` print them via {@link printAmbiguousHash} so the user
	 * can copy-paste a longer prefix.
	 */
	readonly matches: ReadonlyArray<string>;
	constructor(prefix: string, matches: ReadonlyArray<string>) {
		// Invariant guards — these should be unreachable from production
		// callers (`getSummary` only constructs this when ≥2 prefix matches
		// were found, and the prefix it passed was a non-empty user input).
		// Defensive throw makes the bug surface at the construction site
		// rather than as confusing downstream behavior.
		if (matches.length < 2) {
			throw new Error(
				`AmbiguousHashError requires ≥2 matches (got ${matches.length}); use null/undefined for "not found"`,
			);
		}
		if (prefix.length === 0 || prefix.length >= FULL_HASH_LENGTH) {
			throw new Error(
				`AmbiguousHashError prefix must be 1..${FULL_HASH_LENGTH - 1} chars (got length ${prefix.length})`,
			);
		}
		super(
			`abbreviation \`${prefix}\` is ambiguous; please use a longer prefix (matched ${matches.length} commits)`,
		);
		this.name = "AmbiguousHashError";
		this.prefix = prefix;
		this.matches = matches;
	}

	/**
	 * Duck-typed type guard that survives cross-bundle scenarios.
	 *
	 * `instanceof` only works when both sides reference the same class
	 * identity. esbuild inlines `cli/src/**` into the VS Code extension
	 * bundle today, so identity is preserved — but if a future caller
	 * crosses an IPC boundary (worker, child process, serialized error
	 * payload), the prototype chain breaks while name + fields survive.
	 * Catch sites should prefer this over `instanceof` for forward-
	 * compatibility.
	 */
	static is(error: unknown): error is AmbiguousHashError {
		return (
			error instanceof Error &&
			error.name === "AmbiguousHashError" &&
			typeof (error as { prefix?: unknown }).prefix === "string" &&
			Array.isArray((error as { matches?: unknown }).matches)
		);
	}
}

/**
 * Returns all index entries whose commitHash starts with the given prefix.
 *
 * Used by {@link getSummary} to resolve abbreviated hashes (jolli's catalog
 * emits 8-char prefixes) without invoking git — purely in-memory, so it is
 * unaffected by working-tree state (rebase / squash dropping the commit
 * doesn't lose the index record) and by tree-hash collisions (cherry-pick
 * twins that share a tree but live as distinct entries).
 */
function findEntriesByPrefix(
	prefix: string,
	entries: ReadonlyArray<SummaryIndexEntry>,
): ReadonlyArray<SummaryIndexEntry> {
	return entries.filter((e) => e.commitHash.startsWith(prefix));
}

/**
 * Retrieves a summary for a specific commit hash.
 *
 * Lookup steps:
 *   1. Direct file read — `summaries/{hash}.json`. Hits for any hash that ever
 *      owned a summary file (production: 40-char SHAs only); a deterministic
 *      cheap miss otherwise. Returns the commit's ORIGINAL summary even after
 *      a squash/rebase has folded it into a container, since `mergeManyToOne` /
 *      `migrateOneToOne` keep the old files. (Bypassing the embedded child view
 *      is intentional: under the unified Hoist strip, embedded children no
 *      longer carry topics/recap.)
 *
 *   then, branched by input length:
 *
 *   if hash.length === 40 (full SHA):
 *     2. Alias map lookup — `index.commitAliases[hash]` for amend/rebase
 *        chains where an old SHA was rewritten to a new one. Keys are
 *        always 40-char in production.
 *
 *   if hash.length < 40 (abbreviated, e.g. catalog's 8-char output):
 *     3. Index prefix scan — entries whose `commitHash` starts with the input.
 *        - 1 match → return that summary
 *        - ≥ 2 matches → throw {@link AmbiguousHashError}
 *        - 0 matches → fall through to Step 4
 *
 *   finally, if nothing above hit:
 *     4. Cross-tree fallback — `git rev-parse hash^{tree}` then match by
 *        tree hash to an indexed entry. Catches cherry-pick / rebase copies
 *        that share a tree with an indexed commit but aren't themselves in
 *        the index. This is the only step that requires a live git repo.
 *
 * Returns null if no summary exists for that commit.
 */
export async function getSummary(
	commitHash: string,
	cwd?: string,
	storage?: StorageProvider,
): Promise<CommitSummary | null> {
	// Empty input is meaningless — return null rather than letting it fall
	// to the prefix scan, where `"".startsWith()` would match every entry
	// and surface as `AmbiguousHashError("", [all-of-index])`. Callers like
	// `JolliMemoryBridge.getSummary` don't pre-validate length, so the
	// guard belongs here.
	if (commitHash.length === 0) return null;

	// Normalize to lowercase up front. Index entries / file names / alias
	// keys are all written lowercase, so without this a user typing
	// `--commit ABC123…` would miss every step except Step 4's git-mediated
	// fallback (which `git rev-parse` would mask by normalizing). Doing it
	// here protects every caller (CLI, sidebar, URI handler) uniformly.
	const hash = commitHash.toLowerCase();

	// Step 1: Direct file read. Tried for all inputs; storage is the only
	// O(1) lookup that can hit on a full SHA, and a deterministic miss for
	// shorter inputs in production.
	const direct = await readSummaryFile(hash, cwd, storage);
	if (direct) return direct;

	// Typed fallback (phase H): on the database backend, steps 2, 3 and 4 are
	// one SELECT each — loading the index here would synthesize a whole
	// document per miss. Read-side resolver: these are alias/prefix lookups plus
	// `readSummaryFile`, all reads, so no write-miss warning belongs here.
	const typed = asSqliteStorage(await resolveReadStorage(storage, cwd));
	if (typed) {
		if (hash.length === FULL_HASH_LENGTH) {
			const alias = await typed.lookupAlias(hash);
			if (alias) return readSummaryFile(alias, cwd, storage);
		} else {
			const matches = await typed.findHashesByPrefix(hash);
			if (matches.length === 1) return readSummaryFile(matches[0], cwd, storage);
			if (matches.length >= 2) throw new AmbiguousHashError(hash, matches);
		}
		// Step 4 on the typed path too. Returning null here instead (which is
		// what this used to do) silently dropped the cross-tree fallback for
		// every cut-over repo: a cherry-pick or rebase copy that shares a tree
		// with an indexed commit resolved before the cutover and stopped after,
		// until some later `scanTreeHashAliases` pass happened to write the
		// alias row.
		const treeHash = await getTreeHash(hash, cwd);
		if (treeHash) {
			const match = await typed.findShallowestByTreeHash(treeHash);
			if (match) return readSummaryFile(match, cwd, storage);
		}
		return null;
	}

	const index = await loadIndex(cwd, storage);
	if (!index) return null;

	const isFullHash = hash.length === FULL_HASH_LENGTH;

	if (isFullHash) {
		// Step 2: Alias lookup — `commitAliases` is keyed by 40-char OLD SHA.
		// Note: this branch only runs for full SHAs. Abbreviated input that
		// would only resolve via an alias entry (e.g. an old SHA that's been
		// GC'd from the working repo) won't hit here — pass the full 40-char
		// SHA to reach aliased rewrites reliably. The realistic blast radius
		// is small: `scanTreeHashAliases` only writes aliases for hashes git
		// has already resolved at scan time, so they're already 40-char in
		// practice, and abbreviated input is overwhelmingly catalog output
		// (which targets live, indexed entries — not aliased rewrites).
		const aliasHash = index.commitAliases?.[hash];
		if (aliasHash) {
			return readSummaryFile(aliasHash, cwd, storage);
		}
	} else {
		// Step 3: Index prefix scan for abbreviated input. Deterministic, in
		// memory, and immune to tree-hash collisions — we match on the index's
		// own `commitHash` field, not on tree hashes.
		const matches = findEntriesByPrefix(hash, index.entries);
		if (matches.length === 1) {
			return readSummaryFile(matches[0].commitHash, cwd, storage);
		}
		if (matches.length >= 2) {
			throw new AmbiguousHashError(
				hash,
				matches.map((m) => m.commitHash),
			);
		}
		// matches.length === 0 → fall through to Step 4.
	}

	// Step 4: Cross-tree fallback. Requires a live git repo to resolve the
	// hash to a tree, then we look for any indexed entry sharing that tree.
	if (index.version === 3) {
		const treeHash = await getTreeHash(hash, cwd);
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
 * @param storage      — write path. Drives the inside-lock re-read AND the
 *   alias write, so the persisted blob's `entries` matches what's already on
 *   the write storage's primary backend (no clobbering rows the read storage
 *   lacks).
 * @param readStorage  — optional candidate-discovery storage. When the
 *   caller's write storage doesn't see the same rows as its read storage
 *   (e.g. a FolderStorage shadow has rows the orphan-branch primary doesn't,
 *   or vice versa), pass the read side here so preflight candidate
 *   computation reflects what the UI is showing. Defaults to `storage` when
 *   omitted (single-storage callers behave identically to before).
 *
 * @returns `true` if any new aliases were written, `false` otherwise
 */
export async function scanTreeHashAliases(
	commitHashes: string[],
	cwd?: string,
	storage?: StorageProvider,
	readStorage?: StorageProvider,
): Promise<boolean> {
	// Manually-disabled projects must not write: the alias write below would
	// be silently dropped by the storage gate anyway, but the orphan-write
	// lock acquisition is itself a disk write — and because the dropped write
	// never persists, every commits-panel refresh would re-detect the same
	// candidates and re-create the lock file in a loop.
	if (isManuallyDisabled()) return false;
	const effectiveReadStorage = readStorage ?? storage;
	// ── Phase 1: preflight (no lock) ────────────────────────────────────────
	// Compute candidate aliases against the current index. Tree-hash lookup is
	// O(n) git calls — expensive — so we keep it outside the lock to avoid
	// blocking concurrent worker writes. The lookup result is "tentative":
	// Phase 2 re-validates against the freshly-loaded index inside the lock.
	const preflightIndex = await loadIndex(cwd, effectiveReadStorage);
	if (!preflightIndex || preflightIndex.version !== 3) return false;

	const preflightAliases = preflightIndex.commitAliases ?? {};
	const preflightEntryHashSet = new Set(preflightIndex.entries.map((e) => e.commitHash));
	const preflightEntryMap = new Map(preflightIndex.entries.map((e) => [e.commitHash, e]));

	const candidates: Record<string, string> = {};
	for (const hash of commitHashes) {
		if (preflightEntryHashSet.has(hash) || preflightAliases[hash]) continue;

		const treeHash = await getTreeHash(hash, cwd);
		if (!treeHash) continue;

		/* v8 ignore start -- tree hash match: requires real git repo with matching tree hashes */
		const matchEntry = findShallowstByTreeHash(treeHash, preflightIndex.entries, preflightEntryMap);
		if (matchEntry) {
			candidates[hash] = matchEntry.commitHash;
			log.info(
				"Tree hash match: %s → %s (treeHash: %s)",
				hash.substring(0, 8),
				matchEntry.commitHash.substring(0, 8),
				treeHash.substring(0, 8),
			);
		}
		/* v8 ignore stop */
	}

	if (Object.keys(candidates).length === 0) return false;

	// ── Phase 2: critical section (lock) ────────────────────────────────────
	// Acquire orphan-write.lock and re-load the index. The previous
	// implementation reused the preflight `index` object inside the lock, which
	// caused a lost-update: a worker that wrote new entries after preflight but
	// before our lock-acquire would see its `entries` clobbered when we wrote
	// `{ ...preflightIndex, commitAliases }` back. Re-reading the freshly
	// persisted index inside the lock and merging only `commitAliases` keeps
	// the worker's `entries` intact.
	//
	// Background path: deferring is acceptable on contention — the next UI
	// refresh re-enters scanTreeHashAliases. log.debug, not warn, because
	// deferral is the expected outcome under contention.
	return await withDeferrableOrphanWriteLock(
		cwd,
		() => {
			log.debug("scanTreeHashAliases: orphan-write lock contention — alias write deferred");
			return false;
		},
		async () => {
			// Re-anchor the inside-lock re-read on the WRITE storage, not the
			// read side. The `newIndex` blob below carries `freshIndex.entries`
			// verbatim and gets persisted via dual-write to BOTH backends — so
			// the entries array we write must already match what the write
			// storage's primary holds. Using the read side here would let the
			// write payload's entries diverge from the primary (e.g. when the
			// read storage is a FolderStorage shadow that lacks rows the
			// primary still has), and the dual-write would then clobber those
			// rows on the primary. Candidate freshness for `freshAliases` and
			// `freshEntryHashSet` is intentionally a write-storage check.
			const freshIndex = await loadIndex(cwd, storage);
			if (!freshIndex || freshIndex.version !== 3) return false;

			// Symmetric protection: anchoring on writeStorage protects the
			// primary's rows, but the same dual-write that lands the alias
			// also overwrites the shadow's index.json with freshIndex.entries.
			// If the read storage (typically the FolderStorage shadow) holds
			// rows the write storage doesn't (e.g. cross-machine cloud sync
			// landed rows in the folder before the orphan branch caught up),
			// that write deletes them on the shadow. Defer the alias scan in
			// that case — aliases are a cross-branch tree-hash optimization,
			// not load-bearing, and the next refresh retries once both sides
			// reconcile (heal, push/pull of orphan, etc.).
			if (effectiveReadStorage !== storage) {
				const readSideIndex = await loadIndex(cwd, effectiveReadStorage);
				if (readSideIndex && readSideIndex.version === 3) {
					const writeHashes = new Set(freshIndex.entries.map((e) => e.commitHash));
					const readOnlyCount = readSideIndex.entries.reduce(
						(n, e) => (writeHashes.has(e.commitHash) ? n : n + 1),
						0,
					);
					if (readOnlyCount > 0) {
						log.warn(
							"scanTreeHashAliases: read side has %d row(s) write side lacks — deferring alias write to avoid shadow clobber",
							readOnlyCount,
						);
						return false;
					}
				}
			}

			const freshAliases = freshIndex.commitAliases ?? {};
			const freshEntryHashSet = new Set(freshIndex.entries.map((e) => e.commitHash));

			// Drop candidates a concurrent writer has resolved (now in entries) or
			// already aliased; only persist ones still genuinely missing.
			const finalAliases: Record<string, string> = { ...freshAliases };
			let added = 0;
			for (const [aliasHash, targetHash] of Object.entries(candidates)) {
				if (freshEntryHashSet.has(aliasHash)) continue;
				if (finalAliases[aliasHash]) continue;
				finalAliases[aliasHash] = targetHash;
				added++;
			}
			if (added === 0) return false;

			// Build newIndex from freshIndex (not preflightIndex) so any entries the
			// worker added between preflight and lock-acquire are preserved.
			const newIndex: SummaryIndex = { ...freshIndex, commitAliases: finalAliases };
			const files: FileWrite[] = [{ path: INDEX_FILE, content: JSON.stringify(newIndex, null, "\t") }];
			const store = await resolveStorage(storage, cwd);
			await store.writeFiles(files, `Add ${added} tree hash alias(es)`);
			return true;
		},
	);
}

/**
 * Returns the total number of root-level summaries (excludes child nodes
 * from squash/amend trees). Uses the index for accurate counting so the
 * result matches the Memories panel and CLI `view` list.
 */
export async function getSummaryCount(cwd?: string, storage?: StorageProvider): Promise<number> {
	const index = await loadIndex(cwd, storage);
	if (!index) {
		return 0;
	}
	return index.entries.filter(isRootEntry).length;
}

/**
 * Returns true if the current index needs migration to v3 flat format.
 * A v1 index (all entries lack `parentCommitHash`) should be migrated.
 */
export async function indexNeedsMigration(cwd?: string, storage?: StorageProvider): Promise<boolean> {
	const index = await loadIndex(cwd, storage);
	if (!index || index.entries.length === 0) return false;
	return index.version !== 3;
}

/**
 * Migrates a v1 index to v3 flat format.
 * For each top-level summary, loads the full JSON tree and flattens it into index entries.
 * Calls `getTreeHash` for each node to populate `treeHash` fields.
 *
 * Acquires `orphan-write.lock` internally — callers no longer need to wrap.
 */
export async function migrateIndexToV3(
	cwd?: string,
	storage?: StorageProvider,
): Promise<{ migrated: number; skipped: number }> {
	return withRequiredOrphanWriteLock(cwd, "migrateIndexToV3", () => migrateIndexToV3Locked(cwd, storage));
}

async function migrateIndexToV3Locked(
	cwd?: string,
	storage?: StorageProvider,
): Promise<{ migrated: number; skipped: number }> {
	const existingIndex = await loadIndex(cwd, storage);
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
		const summaryContent = await readSummaryFile(entry.commitHash, cwd, storage);
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
	const store = await resolveStorage(storage, cwd);
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
	// Read-side resolution: this function only ever calls `readFile`. A write
	// flow that loads a summary first still resolves its own storage for the
	// write itself, so the write-miss warning is not lost by silencing it here —
	// exactly the argument `loadIndex` already makes. Using the write-side
	// resolver here fired a spurious "Memory Bank side will miss this write" per
	// summary read on read-only paths (e.g. `repair-memory --status`).
	const store = await resolveReadStorage(storage, cwd);
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
	// Read-side resolution: this function only ever calls `readFile`. Write
	// flows that load the index first still resolve their own storage for the
	// write itself, so the write-miss warning is not lost by silencing it here.
	const store = await resolveReadStorage(storage, cwd);
	const content = await store.readFile(INDEX_FILE);
	if (!content) {
		// DEBUG, not WARN. A null here now carries exactly one meaning — the
		// index is absent — and absence is routine: a fresh repo before its
		// first summary, or a cross-repo scan touching a sibling Memory Bank
		// that has none. Warning on it produced hundreds of lines per sidebar
		// refresh and greeted first-run users with a WARN mid-setup, while the
		// failure it was meant to catch stayed invisible inside the noise.
		//
		// Genuine read failures are warned by the backend itself, where the
		// errno / git stderr is still available to name the cause
		// (`FolderStorage.readFile`, `readFileFromBranch`) — see JOLLI-2066.
		//
		// `store.kind`, never `store.constructor.name`: both shipping bundles
		// minify without `keepNames`, so the class name reaches production
		// mangled and bundle-specific (`Xe` / `t`).
		log.debug("loadIndex: no index.json in %s storage", store.kind ?? "unknown");
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
	const store = await resolveStorage(storage, cwd);
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
	const store = await resolveStorage(storage, cwd);

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

	// We have work to do. Acquire orphan-write.lock so concurrent worker writes
	// can't race with our update; if the lock is contended, fall back to the
	// preflight in-memory result (a stale-but-coherent view is better than
	// stomping a fresher write).
	return await withDeferrableOrphanWriteLock(
		cwd,
		async () => {
			log.debug(
				"getCatalogWithLazyBuild: orphan-write lock contention — returning in-memory catalog without writeback",
			);
			// Build the in-memory updated view so caller still sees current roots.
			const cleaned = preflightCatalog.entries.filter((e) => preflightRoots.has(e.commitHash));
			const newEntries: CatalogEntry[] = [];
			for (const hash of preflightMissing) {
				const summary = await readSummaryFile(hash, cwd, store);
				if (summary) newEntries.push(toCatalogEntry(summary));
			}
			return { version: 1, entries: [...cleaned, ...newEntries] };
		},
		async () => {
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
		},
	);
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
	storage?: StorageProvider,
): Promise<void> {
	if (planFiles.length === 0) return;
	// Pre-lock gate — see storeSummary for why this sits before the lock.
	if (isManuallyDisabled()) return;

	const files: FileWrite[] = planFiles.map((p) => ({
		path: `plans/${p.slug}.md`,
		content: p.content,
		branch,
	}));

	await withRequiredOrphanWriteLock(cwd, "storePlans", async () => {
		const store = await resolveStorage(storage, cwd);
		await store.writeFiles(files, commitMessage);
		log.info("Stored %d plan file(s)", planFiles.length);
	});
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
		const store = await resolveStorage(storage, cwd);
		return await store.readFile(`plans/${slug}.md`);
	} catch {
		return null;
	}
}

/**
 * Removes ONLY the user-visible `<branch>/plan--<slug>.md` from the Memory
 * Bank folder layer. Leaves the orphan-branch source (`plans/<slug>.md`),
 * the hidden `.jolli/plans/<slug>.md` mirror, and the local plans registry
 * untouched — callers that want to dissociate a plan from a commit (rather
 * than delete the plan itself) use this to clean up the per-branch visible
 * artifact while the plan remains addressable for future re-association.
 *
 * No-op when the active storage backend has no visible layer (e.g.
 * OrphanBranchStorage in legacy `orphan-only` mode).
 */
export async function deletePlanVisibleArtifact(
	slug: string,
	branch: string,
	cwd?: string,
	storage?: StorageProvider,
): Promise<void> {
	const store = await resolveStorage(storage, cwd);
	if (!store.deletePlanVisible) return;
	await store.deletePlanVisible(slug, branch);
}

/**
 * Reads a plan progress artifact from the orphan branch.
 * Returns the parsed artifact, or null if the file doesn't exist or fails to parse.
 */
export async function readPlanProgress(
	slug: string,
	cwd?: string,
	storage?: StorageProvider,
): Promise<PlanProgressArtifact | null> {
	try {
		const store = await resolveStorage(storage, cwd);
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
	storage?: StorageProvider,
): Promise<void> {
	if (noteFiles.length === 0) return;
	// Pre-lock gate — see storeSummary for why this sits before the lock.
	if (isManuallyDisabled()) return;

	const files: FileWrite[] = noteFiles.map((n) => ({
		path: `notes/${n.id}.md`,
		content: n.content,
		branch,
	}));

	await withRequiredOrphanWriteLock(cwd, "storeNotes", async () => {
		const store = await resolveStorage(storage, cwd);
		await store.writeFiles(files, commitMessage);
		log.info("Stored %d note file(s)", noteFiles.length);
	});
}

/**
 * Removes ONLY the user-visible `<branch>/note--<id>.md` from the Memory
 * Bank folder layer. Symmetric with `deletePlanVisibleArtifact` — the
 * orphan-branch source (`notes/<id>.md`), the hidden `.jolli/notes/<id>.md`
 * mirror, and the local notes registry are left untouched.
 *
 * No-op when the active storage backend has no visible layer.
 */
export async function deleteNoteVisibleArtifact(
	id: string,
	branch: string,
	cwd?: string,
	storage?: StorageProvider,
): Promise<void> {
	const store = await resolveStorage(storage, cwd);
	if (!store.deleteNoteVisible) return;
	await store.deleteNoteVisible(id, branch);
}

/**
 * Reads a note file from the orphan branch.
 * Returns the markdown content, or null if the file doesn't exist.
 */
export async function readNoteFromBranch(id: string, cwd?: string, storage?: StorageProvider): Promise<string | null> {
	try {
		const store = await resolveStorage(storage, cwd);
		return await store.readFile(`notes/${id}.md`);
	} catch {
		return null;
	}
}

// ─── Reference storage (multi-source generalisation of Linear) ──────────────

/**
 * Orphan-branch path for an archived reference markdown:
 * `references/<source>/<sanitized-bareKey>.md`.
 *
 * `archivedKey` is the post-archive plans.json map key (e.g.
 * `"jira:KAN-4-abc12345"`). We strip the leading `<source>:` prefix then run
 * the same {@link sanitizeNativeIdForPath} ReferenceStore uses for on-disk
 * filenames — keeps GitHub's `<owner>/<repo>#<n>` collisions impossible.
 *
 * This guard is strict (registry-membership, via `isRegisteredSourceId`), not
 * lenient (path-safety, via `isPathSafeSourceId`): an archived reference whose
 * `source` was later removed from `SourceDefinitionRegistry` will throw here
 * on write and, on regenerate, fail to resolve — falling into the caller's
 * existing "missing markdown → skip with warn" path rather than being
 * recovered. The "no data loss for a since-removed source" guarantee
 * documented on {@link isPathSafeSourceId} covers only the active-reference
 * parse path (`ReferenceStore.parseMarkdown`), not this archived-regenerate
 * path.
 */
function orphanPathFor(source: SourceId, archivedKey: string): string {
	// Defense-in-depth path-traversal guard. `source` is typed SourceId (now a
	// plain string), but at runtime it can originate from untrusted data (a
	// webview `data-reference-source` attribute, a poisoned orphan branch /
	// synced Memory Bank). Since it is interpolated raw into the filesystem
	// path below, reject anything that isn't a source currently registered in
	// `SourceDefinitionRegistry` so a `../`-laden value can't escape the
	// references/ directory. Read callers catch and return null; write callers
	// surface the error.
	if (!isRegisteredSourceId(source)) {
		throw new Error(`orphanPathFor: refusing unknown reference source ${JSON.stringify(source)}`);
	}
	const prefix = `${source}:`;
	/* v8 ignore next -- defensive: archivedKey is always `${source}:<bareKey>` for entries flowing through storeReferences / ReferenceCommitRef; the bare-key fallback is for hand-passed inputs that don't appear in production data. */
	const bareKey = archivedKey.startsWith(prefix) ? archivedKey.slice(prefix.length) : archivedKey;
	const sanitized = sanitizeNativeIdForPath(source, bareKey);
	return `references/${source}/${sanitized}.md`;
}

/**
 * Stores reference markdown files in the orphan branch under
 * `references/<source>/<sanitized-bareKey>.md`. Atomic write — all files
 * are committed in a single orphan-branch commit.
 *
 * `archivedKey` is `<source>:<nativeId>-<shortHash>` (the post-archive
 * plans.json.references map key, mirrors the slug-rename pattern from
 * storePlans). Generalised across every {@link SourceId}.
 */
export async function storeReferences(
	referenceFiles: ReadonlyArray<{ archivedKey: string; source: SourceId; content: string }>,
	commitMessage: string,
	cwd?: string,
	branch?: string,
	storage?: StorageProvider,
): Promise<void> {
	if (referenceFiles.length === 0) return;
	// Pre-lock gate — see storeSummary for why this sits before the lock.
	if (isManuallyDisabled()) return;

	const files: FileWrite[] = referenceFiles.map((e) => ({
		path: orphanPathFor(e.source, e.archivedKey),
		content: e.content,
		branch,
	}));

	await withRequiredOrphanWriteLock(cwd, "storeReferences", async () => {
		const store = await resolveStorage(storage, cwd);
		await store.writeFiles(files, commitMessage);
		log.info("Stored %d reference file(s) across sources", referenceFiles.length);
	});
}

// ─── Skill usage storage ────────────────────────────────────────────────────

/**
 * Writes archived skill markdown to the orphan branch.
 *
 * Paths are built by `SkillArchive.skillOrphanPath` (which owns the sanitization),
 * so this is a thin pass-through — deliberately, to keep one place responsible for
 * turning an untrusted skill id into a path.
 *
 * The Memory Bank hidden layer comes free: `writeHiddenFile` runs unconditionally
 * before FolderStorage's visible cascade, so `skills/...` lands under
 * `<kbRoot>/.jolli/` with no code here. The visible layer is a per-commit
 * aggregate emitted from the summary arm, not one file per skill — see
 * FolderStorage.
 */
export async function storeSkills(
	skillFiles: ReadonlyArray<{ path: string; content: string }>,
	commitMessage: string,
	cwd?: string,
	branch?: string,
	storage?: StorageProvider,
): Promise<void> {
	if (skillFiles.length === 0) return;
	// Pre-lock gate — see storeSummary for why this sits before the lock.
	if (isManuallyDisabled()) return;

	const files: FileWrite[] = skillFiles.map((s) => ({ path: s.path, content: s.content, branch }));

	await withRequiredOrphanWriteLock(cwd, "storeSkills", async () => {
		const store = await resolveStorage(storage, cwd);
		await store.writeFiles(files, commitMessage);
		log.info("Stored %d skill file(s)", skillFiles.length);
	});
}

/**
 * Reads an archived skill's markdown from the orphan branch.
 * Returns `null` when the file is absent.
 */
export async function readSkillFromBranch(
	orphanPath: string,
	cwd?: string,
	storage?: StorageProvider,
): Promise<string | null> {
	try {
		const store = await resolveStorage(storage, cwd);
		return await store.readFile(orphanPath);
	} catch {
		return null;
	}
}

/**
 * Reads a reference's archived markdown from the orphan branch.
 *
 * Looks up the multi-source path `references/<source>/<sanitized-bareKey>.md`.
 * Returns `null` when the file is absent.
 */
export async function readReferenceFromBranch(
	source: SourceId,
	archivedKey: string,
	cwd?: string,
	storage?: StorageProvider,
): Promise<string | null> {
	const store = await resolveStorage(storage, cwd);
	try {
		return await store.readFile(orphanPathFor(source, archivedKey));
	} catch {
		return null;
	}
}

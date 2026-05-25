/**
 * Schema v5 Migration — unified v3 → v4 → v5 one-shot migration.
 *
 * Reads every summary on the orphan branch, runs the lossless `normalizeToV4`
 * helper to collapse v3 layouts into the v4 unified-Hoist invariant, then
 * stamps `version: 5` + a `transcripts: string[]` array on each root.
 *
 * The v5 transcripts array uses **the existing on-disk filenames as opaque
 * IDs** — legacy `transcripts/{commitHash}.json` files are NOT renamed. This
 * means each `transcripts: [...]` entry on a migrated summary is the same
 * 40-char hex commit-hash string that was already the file name. New writes
 * after migration generate fresh UUIDs (see `TranscriptId.generateTranscriptId`)
 * so the two formats coexist harmlessly; readers treat the IDs as opaque.
 *
 * Atomicity: every write goes into a SINGLE orphan-branch commit, so the
 * migration is all-or-nothing from the storage perspective. State on the
 * orphan branch is `schema-v5-migration.json` — present (with `completedAt`)
 * once the commit lands, absent otherwise. Concurrent post-commit writers
 * are serialized via the same `orphan-write.lock` the v1→v3 migration uses;
 * this means a single very long migration can starve a worker for up to
 * 30s, after which that worker's queue entry is dropped (same fire-and-
 * forget semantics documented in QueueWorker).
 */

import { createLogger, ORPHAN_BRANCH } from "../Logger.js";
import type { CommitSummary, FileWrite } from "../Types.js";
import {
	batchReadFilesFromBranch,
	execGit,
	listFilesInBranch,
	orphanBranchExists,
	readFileFromBranch,
} from "./GitOps.js";
import { acquireOrphanWriteLock, releaseOrphanWriteLock } from "./Locks.js";
import { createStorage } from "./StorageFactory.js";
import type { StorageProvider } from "./StorageProvider.js";
import { normalizeToV4 } from "./SummaryStore.js";
import { collectAllTranscriptHashes } from "./SummaryTree.js";

const log = createLogger("SchemaV5Migration");

const SCHEMA_V5_STATE_FILE = "schema-v5-migration.json";
const MIGRATION_LOCK_TIMEOUT_MS = 30_000;

/**
 * Persisted state for the v5 migration. Present on the orphan branch only
 * after a successful (or in-flight failed) migration attempt. Absent state
 * is the implicit "pending" state — the migration code interprets that as
 * "needs to run on next startup".
 */
export interface SchemaV5MigrationState {
	readonly version: 1;
	readonly status: "in-progress" | "completed" | "failed";
	readonly startedAt: string;
	readonly completedAt?: string;
	readonly migratedCount: number;
	readonly skippedCount: number;
	/** True when no v3/v4 data existed at migration time (fresh install). */
	readonly fresh: boolean;
	readonly errorMessage?: string;
}

/** Public summary of what `migrateSchemaToV5` did, for caller telemetry. */
export interface SchemaV5MigrationResult {
	readonly migrated: number;
	readonly skipped: number;
	readonly fresh: boolean;
	readonly alreadyDone: boolean;
}

/**
 * Read-only state inspector. Returns null when the state file is absent
 * (the implicit "pending" state). Status panel / `jolli status` reads this
 * to decide whether to surface a "migration needed" or "complete" message.
 */
export async function readSchemaV5State(cwd?: string): Promise<SchemaV5MigrationState | null> {
	const content = await readFileFromBranch(ORPHAN_BRANCH, SCHEMA_V5_STATE_FILE, cwd);
	if (!content) return null;
	try {
		return JSON.parse(content) as SchemaV5MigrationState;
	} catch (err) {
		log.warn("Failed to parse v5 migration state — treating as absent: %s", (err as Error).message);
		return null;
	}
}

async function withMigrationLock<T>(cwd: string | undefined, label: string, fn: () => Promise<T>): Promise<T> {
	const acquired = await acquireOrphanWriteLock(cwd, { timeoutMs: MIGRATION_LOCK_TIMEOUT_MS });
	if (!acquired) {
		throw new Error(`${label}: could not acquire orphan-write lock within ${MIGRATION_LOCK_TIMEOUT_MS}ms`);
	}
	try {
		return await fn();
	} finally {
		await releaseOrphanWriteLock(cwd);
	}
}

/**
 * Runs the v5 migration end-to-end. Idempotent — a second call after a
 * successful run is a fast no-op (returns `alreadyDone: true`).
 *
 * Failures throw, and the caller is expected to log + retry on next startup.
 * The state file does NOT get marked "failed" on throw, so the next run
 * sees "still pending" and tries again. (We could write "failed" eagerly
 * but that complicates the happy path — pending is the right starting state
 * after any kind of failure including process crash.)
 *
 * Throws when:
 *   - the orphan-write lock cannot be acquired inside `MIGRATION_LOCK_TIMEOUT_MS`
 *     (30 s). Callers MUST treat this as "defer to next startup" — do NOT
 *     surface it to the user as a hard failure. Both production call sites
 *     (`Installer.install()` and `Extension.ts initializeKB()`) wrap the
 *     call in `try/catch` and log-warn-only; any new caller must do the same.
 *   - `batchReadFilesFromBranch` or `writeMultipleFilesToBranch` throws. The
 *     orphan-write lock release happens via `withMigrationLock`'s `finally`,
 *     so a thrown migration cannot leak the lock.
 */
export async function migrateSchemaToV5(cwd?: string): Promise<SchemaV5MigrationResult> {
	const existing = await readSchemaV5State(cwd);
	if (existing?.status === "completed") {
		log.info("Schema v5 migration already completed at %s — skipping", existing.completedAt);
		return {
			migrated: existing.migratedCount,
			skipped: existing.skippedCount,
			fresh: existing.fresh,
			alreadyDone: true,
		};
	}

	// Skip when no orphan branch exists yet. Calling
	// writeMultipleFilesToBranch on a non-existent branch would CREATE it
	// (with just the state file inside), which is a noisy side effect for
	// fresh projects that have not yet made their first commit. The first
	// post-commit will create the branch with real data, and the next
	// activate() / install will pick the migration up.
	if (!(await orphanBranchExists(ORPHAN_BRANCH, cwd))) {
		log.info("Orphan branch does not exist yet — skipping schema v5 migration (no data to migrate)");
		return { migrated: 0, skipped: 0, fresh: true, alreadyDone: false };
	}

	// Resolve the storage provider BEFORE acquiring the orphan-write lock.
	// `createStorage` calls `loadConfig()` which reads `~/.jolli/jollimemory/
	// config.json`; doing that disk I/O inside the lock would extend the
	// window during which concurrent post-commit writers wait (up to their
	// 30 s timeout). The provider itself is stateless WRT the orphan branch
	// until `writeFiles` is called, so it's safe to construct early.
	const storage = await createStorage(cwd ?? process.cwd(), cwd);

	return withMigrationLock(cwd, "migrateSchemaToV5", () => migrateSchemaToV5Locked(cwd, storage));
}

async function migrateSchemaToV5Locked(
	cwd: string | undefined,
	storage: StorageProvider,
): Promise<SchemaV5MigrationResult> {
	const startedAt = new Date().toISOString();

	// Capture the pre-migration HEAD of the orphan branch BEFORE we touch
	// anything, so recovery (rare) has a concrete SHA to roll back to via
	// `git update-ref refs/heads/<orphan-branch> <preMigrationSHA>`.
	// Surfaced only in debug.log — users don't normally need or want to know
	// this; it's for support / triage when migration produces unexpected output.
	// `git reflog refs/heads/<orphan-branch>` provides the same information
	// (default 90-day retention) but a single logged SHA is much faster to
	// reference from a bug report than walking the reflog.
	const preMigrationSHA = await execGit(["rev-parse", `refs/heads/${ORPHAN_BRANCH}`], cwd)
		.then((r) => r.stdout.trim())
		.catch(() => null);

	// Enumerate every summary file currently on the orphan branch. Empty list
	// = fresh install (or wiped repo); we still write the "completed" state
	// so subsequent startups skip without scanning.
	const summaryPaths = await listFilesInBranch(ORPHAN_BRANCH, "summaries/", cwd);
	log.info("Found %d summary files to inspect", summaryPaths.length);

	// Single scan of transcripts/ so the per-summary "does file exist" check
	// is O(1) lookup, not O(commits) git calls. Fresh-install path returns [].
	const transcriptPaths = await listFilesInBranch(ORPHAN_BRANCH, "transcripts/", cwd);
	const transcriptFileIds = new Set<string>();
	for (const p of transcriptPaths) {
		// p looks like "transcripts/{hash}.json" — strip prefix + extension.
		const match = /^transcripts\/(.+)\.json$/.exec(p);
		if (match?.[1]) transcriptFileIds.add(match[1]);
	}

	// Batch-read every summary in one `git cat-file --batch` subprocess.
	// The naive per-file `readFileFromBranch` was N × ~80 ms spawn overhead
	// on Windows — 336 files took ~27 s of pure subprocess churn during the
	// first observed v5 run, even after the write side switched to fast-
	// import. Streaming all reads through one cat-file process drops that
	// to a couple of seconds.
	log.info("Reading %d summaries via batched cat-file...", summaryPaths.length);
	const readStart = Date.now();
	const contents =
		summaryPaths.length > 0 ? await batchReadFilesFromBranch(ORPHAN_BRANCH, summaryPaths, cwd) : new Map();
	log.info("Read %d summaries in %d ms", contents.size, Date.now() - readStart);

	const filesToWrite: FileWrite[] = [];
	let migrated = 0;
	let skipped = 0;

	// `index.json` is NOT rewritten by this migration. The upgrade is in-place
	// (same commit hashes, same tree shape), so existing index entries already
	// point at the right summaries — leaving the index alone avoids touching
	// fields like `treeHash` that we'd otherwise have to recompute, and keeps
	// the migration's blast radius small (only `summaries/*.json` + the state
	// file change).

	for (const path of summaryPaths) {
		const content = contents.get(path);
		// Distinguish the two "no content" cases — they have very different
		// causes:
		//   - `null`:      cat-file reported `<request> missing`. Legitimate
		//                  race: a concurrent orphan-write deleted the file
		//                  between `listFilesInBranch` and the batch read.
		//                  Skip and move on.
		//   - `undefined`: `batchReadFilesFromBranch` did not emit an entry
		//                  for this path. Contract violation — the helper
		//                  populates the map by request order and must have
		//                  one entry per input. Treat as a bug, not a race.
		if (content === undefined) {
			throw new Error(
				`batchReadFilesFromBranch omitted ${path} — protocol contract violation (expected one entry per request)`,
			);
		}
		if (content === null) {
			skipped++;
			continue;
		}

		let raw: CommitSummary;
		try {
			raw = JSON.parse(content) as CommitSummary;
		} catch (err) {
			log.warn("Skipping unparseable summary %s: %s", path, (err as Error).message);
			skipped++;
			continue;
		}

		const upgraded = upgradeOneSummary(raw, transcriptFileIds);
		if (upgraded === raw) {
			// Already v5 — leave the on-disk file untouched.
			skipped++;
			continue;
		}

		filesToWrite.push({
			path,
			content: JSON.stringify(upgraded, null, "\t"),
		});
		migrated++;
	}

	const fresh = summaryPaths.length === 0;
	const completedAt = new Date().toISOString();
	const finalState: SchemaV5MigrationState = {
		version: 1,
		status: "completed",
		startedAt,
		completedAt,
		migratedCount: migrated,
		skippedCount: skipped,
		fresh,
	};
	filesToWrite.push({
		path: SCHEMA_V5_STATE_FILE,
		content: JSON.stringify(finalState, null, "\t"),
	});

	const commitMessage = fresh
		? "Schema v5 migration: no pre-v5 data found"
		: `Schema v5 migration: ${migrated} upgraded, ${skipped} skipped`;

	log.info("Committing %d file(s) via fast-import...", filesToWrite.length);
	const writeStart = Date.now();
	// `storage` is built upstream of the orphan-write lock (in
	// `migrateSchemaToV5`) so its `loadConfig()` I/O doesn't hold the lock.
	// Routing the write through it (instead of `writeMultipleFilesToBranch`
	// directly) gives dual-write users the shadow folder upgrade in the same
	// pass — pre-fix, the shadow's `.jolli/summaries/<hash>.json` files
	// stayed at the pre-migration version until normal post-commit traffic
	// eventually rewrote them. In orphan-only mode this is equivalent to the
	// old direct call (OrphanBranchStorage.writeFiles → writeMultipleFiles
	// ToBranch). In folder-only mode the orphan branch stays untouched.
	await storage.writeFiles(filesToWrite, commitMessage);
	log.info(
		"Schema v5 migration complete: %d migrated, %d skipped, fresh=%s (commit took %d ms)",
		migrated,
		skipped,
		fresh,
		Date.now() - writeStart,
	);
	if (preMigrationSHA) {
		// Recovery hint for triage — NOT shown to users. Operators / support
		// staff reading debug.log can roll back via:
		//   git update-ref refs/heads/jollimemory/summaries/v3 <preMigrationSHA>
		// (git reflog provides the same fallback if this log entry has rotated.)
		log.info("Pre-migration orphan-branch SHA was %s (debug-only recovery anchor)", preMigrationSHA);
	}

	return { migrated, skipped, fresh, alreadyDone: false };
}

/**
 * Upgrades one summary to v5. Returns the input reference unchanged when the
 * summary is already v5 (idempotent fast-path).
 *
 * v3 → v4: delegated to `normalizeToV4`, now lossless (preserves topics,
 *          recap, plans, notes, linearIssues, e2eTestGuide, jolliDoc fields,
 *          orphanedDocIds, and migrates legacy `stats` to `diffStats`).
 *
 * v4 → v5: stamp `version: 5` and compute the transcripts array. We
 *          enumerate every commit hash in the (already-v4) tree via
 *          `collectAllTranscriptHashes` and keep only those that have a
 *          `transcripts/{hash}.json` file on the orphan branch — those
 *          hashes become the v5 transcript IDs verbatim, no rename.
 *
 * Idempotency guard for "v4 root that already has a v5-shaped `transcripts`
 * array": this happens when a project writes summaries via the v5-aware
 * pipeline BEFORE the migration has run (e.g. a fresh post-commit fires
 * before the next activate() picks the migration up). Those summaries have
 * version: 4 but an authoritative UUID-based transcripts array — we MUST NOT
 * recompute `transcripts` via `collectAllTranscriptHashes`, because that
 * would replace the UUID list with children commit hashes (typically dropping
 * the v5 IDs entirely once the file-existence intersection runs). The guard
 * leaves the array untouched and only bumps version.
 */
function upgradeOneSummary(raw: CommitSummary, transcriptFileIds: ReadonlySet<string>): CommitSummary {
	if (raw.version >= 5) return raw;

	const v4 = normalizeToV4(raw);

	// v5-aware writer already populated transcripts on a v4 root — preserve it
	// verbatim, only bump version. (Distinct from the v3/v4 read-fallback path
	// where `transcripts` is undefined.)
	if (v4.transcripts !== undefined) {
		return { ...v4, version: 5 };
	}

	const candidateIds = collectAllTranscriptHashes(v4);
	const transcripts = candidateIds.filter((id) => transcriptFileIds.has(id));

	// v5 contract: always set the `transcripts` field on a v5 root, even if
	// empty. Omitting it would force the read path back through the v3/v4
	// children-walk fallback even on already-migrated data (defeating the
	// fast-path purity that the v5 schema promises).
	const v5: CommitSummary = {
		...v4,
		version: 5,
		transcripts,
	};
	return v5;
}

export const __test__ = {
	upgradeOneSummary,
	SCHEMA_V5_STATE_FILE,
};

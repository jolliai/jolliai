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
 * Storage-agnostic: both reads and the final write go through the active
 * `StorageProvider`, so the migration works identically in orphan-only,
 * dual-write, AND folder-only mode. `storage.exists()` is the data gate,
 * `storage.listFiles` / `storage.batchReadFiles` enumerate and read the
 * summaries, and `storage.readFile(SCHEMA_V5_STATE_FILE)` reads the persisted
 * state. In orphan-backed modes these resolve to the orphan branch; in
 * folder-only mode they resolve to `<localFolder>/<repo>/.jolli/`. (Earlier
 * versions read the orphan branch directly, which silently skipped folder-only
 * users — their data never migrated and `jolli status` reported "Not migrated"
 * forever.)
 *
 * Write ordering: summary content is written FIRST, then the
 * `schema-v5-migration.json` `completed` marker is written separately — and
 * only when the storage shadow is clean. In dual-write a folder (shadow) write
 * failure is swallowed + flagged dirty, so a successful orphan write alone does
 * NOT mean both backends are current; stamping `completed` then would lie and
 * permanently strand the folder at the old schema. Gating the marker on
 * `storage.isDirty()` keeps the migration PENDING after a shadow failure so the
 * next startup retries; a retry where the source of truth is already all-v5
 * re-pushes every summary (recovery branch) to heal the lagging shadow. The
 * state file is present (with `completedAt`) only once both the content and the
 * marker have landed cleanly, absent otherwise. Concurrent post-commit writers
 * are serialized via the same `orphan-write.lock` the v1→v3 migration uses;
 * this means a single very long migration can starve a worker for up to 30s,
 * after which that worker's queue entry is dropped (same fire-and-forget
 * semantics documented in QueueWorker).
 */

import { createLogger, ORPHAN_BRANCH } from "../Logger.js";
import type { CommitSummary, FileWrite } from "../Types.js";
import { execGit } from "./GitOps.js";
import { acquireOrphanWriteLock, releaseOrphanWriteLock } from "./Locks.js";
import { createStorage } from "./StorageFactory.js";
import type { StorageProvider } from "./StorageProvider.js";
import { normalizeToV4 } from "./SummaryStore.js";
import { collectAllTranscriptHashes } from "./SummaryTree.js";
import { transcriptIdFromPath } from "./TranscriptId.js";

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
 *
 * Reads through the active `StorageProvider` so folder-only repos (whose state
 * lives in `.jolli/schema-v5-migration.json`, not on an orphan branch) report
 * correctly. Callers may pass a pre-built `storage` to avoid the `loadConfig`
 * I/O `createStorage` does; when omitted it's constructed from `cwd`.
 */
export async function readSchemaV5State(
	cwd?: string,
	storage?: StorageProvider,
): Promise<SchemaV5MigrationState | null> {
	const provider = storage ?? (await createStorage(cwd ?? process.cwd(), cwd));
	const content = await provider.readFile(SCHEMA_V5_STATE_FILE);
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
 *   - a `storage` read (`listFiles` / `batchReadFiles` / `readFile`) or the
 *     final `storage.writeFiles` throws. The orphan-write lock release happens
 *     via `withMigrationLock`'s `finally`, so a thrown migration cannot leak
 *     the lock.
 */
export async function migrateSchemaToV5(cwd?: string): Promise<SchemaV5MigrationResult> {
	// Resolve the storage provider BEFORE acquiring the orphan-write lock.
	// `createStorage` calls `loadConfig()` which reads `~/.jolli/jollimemory/
	// config.json`; doing that disk I/O inside the lock would extend the
	// window during which concurrent post-commit writers wait (up to their
	// 30 s timeout). The provider itself is stateless WRT the backend until
	// `writeFiles` is called, so it's safe to construct early. Built up front
	// so the state read, the data gate, and the migration all share it.
	const storage = await createStorage(cwd ?? process.cwd(), cwd);

	const existing = await readSchemaV5State(cwd, storage);
	if (existing?.status === "completed") {
		log.info("Schema v5 migration already completed at %s — skipping", existing.completedAt);
		return {
			migrated: existing.migratedCount,
			skipped: existing.skippedCount,
			fresh: existing.fresh,
			alreadyDone: true,
		};
	}

	// Skip when the storage backend is not initialized yet. For orphan-backed
	// modes this means no orphan branch — calling `writeFiles` would CREATE it
	// (with just the state file inside), a noisy side effect for fresh projects
	// that have not yet made their first commit. For folder-only mode it means
	// the Memory Bank folder does not exist yet. In both cases the first
	// post-commit creates the backend with real data, and the next activate() /
	// install picks the migration up.
	if (!(await storage.exists())) {
		log.info("Storage backend not initialized yet — skipping schema v5 migration (no data to migrate)");
		return { migrated: 0, skipped: 0, fresh: true, alreadyDone: false };
	}

	return withMigrationLock(cwd, "migrateSchemaToV5", () => migrateSchemaToV5Locked(cwd, storage));
}

/**
 * Reads every summary path via the storage's batch primitive when available
 * (orphan-backed: one `git cat-file --batch`), else a per-file `readFile` loop
 * (folder-only: cheap local reads). Returns a Map keyed by path with `null` for
 * missing files — the same shape both branches produce, so the caller's
 * undefined-vs-null contract check downstream stays valid.
 */
async function readSummaries(
	storage: StorageProvider,
	paths: ReadonlyArray<string>,
): Promise<Map<string, string | null>> {
	if (paths.length === 0) return new Map();
	if (storage.batchReadFiles) return storage.batchReadFiles(paths);
	const result = new Map<string, string | null>();
	for (const path of paths) result.set(path, await storage.readFile(path));
	return result;
}

async function migrateSchemaToV5Locked(
	cwd: string | undefined,
	storage: StorageProvider,
): Promise<SchemaV5MigrationResult> {
	// Re-check state now that we hold the lock. The check in `migrateSchemaToV5`
	// is outside the lock, so two processes (e.g. VS Code activate() + a CLI
	// `jolli migrate`) can both pass it and queue on the lock. Without this
	// re-check the second one would rescan every (now-v5) summary, skip them
	// all, and overwrite the state with `migratedCount: 0` — a wasted full scan
	// plus a misleading telemetry count. Re-reading under the lock makes the
	// idempotency the doc comment promises actually hold.
	const alreadyDone = await readSchemaV5State(cwd, storage);
	if (alreadyDone?.status === "completed") {
		log.info("Schema v5 migration completed by a concurrent run at %s — skipping", alreadyDone.completedAt);
		return {
			migrated: alreadyDone.migratedCount,
			skipped: alreadyDone.skippedCount,
			fresh: alreadyDone.fresh,
			alreadyDone: true,
		};
	}

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

	// Enumerate every summary file in the active storage. Empty list = fresh
	// install (or wiped repo); we still write the "completed" state so
	// subsequent startups skip without scanning. `storage.listFiles` resolves
	// to the orphan branch (orphan/dual-write) or `.jolli/summaries/`
	// (folder-only), so this covers all three modes.
	const summaryPaths = await storage.listFiles("summaries/");
	log.info("Found %d summary files to inspect", summaryPaths.length);

	// Single scan of transcripts/ so the per-summary "does file exist" check
	// is O(1) lookup, not O(commits) git calls. Fresh-install path returns [].
	const transcriptPaths = await storage.listFiles("transcripts/");
	const transcriptFileIds = new Set<string>();
	for (const p of transcriptPaths) {
		// p looks like "transcripts/{id}.json". Shared parser keeps this in
		// lockstep with SummaryStore.getTranscriptHashes (same dropped-UUID fix).
		const id = transcriptIdFromPath(p);
		if (id) transcriptFileIds.add(id);
	}

	// Batch-read every summary. Orphan-backed storage implements
	// `batchReadFiles` as one `git cat-file --batch` subprocess: the naive
	// per-file read was N × ~80 ms spawn overhead on Windows — 336 files took
	// ~27 s of pure subprocess churn during the first observed v5 run. Folder
	// storage has no batch method (local `readFile` per path is already cheap),
	// so fall back to a per-file loop there.
	log.info("Reading %d summaries...", summaryPaths.length);
	const readStart = Date.now();
	const contents = await readSummaries(storage, summaryPaths);
	log.info("Read %d summaries in %d ms", contents.size, Date.now() - readStart);

	const filesToWrite: FileWrite[] = [];
	// Every summary's current (post-upgrade) content, used by the recovery path
	// below to re-push the full set when a prior attempt left the shadow behind.
	const allSummaryFiles: FileWrite[] = [];
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
		//   - `null`:      the read reported the file missing. Legitimate race:
		//                  a concurrent write deleted the file between
		//                  `listFiles` and the batch read. Skip and move on.
		//   - `undefined`: `readSummaries` did not emit an entry for this path.
		//                  Contract violation — both the batch and per-file
		//                  branches must produce one map entry per input. Treat
		//                  as a bug, not a race.
		if (content === undefined) {
			throw new Error(
				`readSummaries omitted ${path} — protocol contract violation (expected one entry per request)`,
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
		const serialized = JSON.stringify(upgraded, null, "\t");
		allSummaryFiles.push({ path, content: serialized });
		if (upgraded === raw) {
			// Already v5 — no schema change to write in the normal path.
			skipped++;
			continue;
		}

		filesToWrite.push({ path, content: serialized });
		migrated++;
	}

	const fresh = summaryPaths.length === 0;

	// Recovery re-push: we only reach here when the migration is NOT marked
	// completed, yet every summary is already v5 (`migrated === 0 && !fresh`).
	// That means a prior attempt upgraded the source of truth (orphan) but did
	// NOT finish cleanly — the classic case being a dual-write run whose shadow
	// (folder) write failed and was swallowed + flagged dirty. The skip-unchanged
	// fast-path would write nothing, leaving the folder stranded at the old
	// schema forever (and the completed marker, once written, would lock out any
	// retry). So re-push EVERY summary's current content to give the shadow
	// another chance to catch up. Costs a redundant orphan rewrite on this rare
	// path; the common first-migration writes only the upgraded files.
	const isRecovery = migrated === 0 && skipped > 0;
	const contentFiles = isRecovery ? allSummaryFiles : filesToWrite;

	const commitMessage = fresh
		? "Schema v5 migration: no pre-v5 data found"
		: isRecovery
			? `Schema v5 migration: re-pushing ${skipped} v5 summaries to heal storage shadow`
			: `Schema v5 migration: ${migrated} upgraded, ${skipped} skipped`;

	// `storage` is built upstream of the orphan-write lock (in
	// `migrateSchemaToV5`) so its `loadConfig()` I/O doesn't hold the lock.
	// Routing the write through it gives dual-write users the shadow folder
	// upgrade in the same pass. In orphan-only mode this is equivalent to the
	// old direct call; in folder-only mode the orphan branch stays untouched.
	const writeStart = Date.now();
	if (contentFiles.length > 0) {
		log.info("Writing %d summary file(s) via active storage...", contentFiles.length);
		await storage.writeFiles(contentFiles, commitMessage);
	}

	// Gate the `completed` marker on the shadow actually landing. In dual-write,
	// a folder (shadow) write failure is swallowed + flagged dirty rather than
	// thrown — so a successful primary write does NOT mean both backends are
	// current. If the shadow is dirty we must NOT stamp `completed`: leaving the
	// state absent (pending) lets the next startup re-run and, via the recovery
	// branch above, re-push to heal the folder. Without this gate the completed
	// marker would lie and permanently strand the folder at the old schema.
	// Orphan-only / folder-only have no swallowing shadow (`isDirty` absent, or a
	// real write failure throws), so this resolves to false and we complete.
	const shadowDirty = storage.isDirty?.() ?? false;
	if (shadowDirty) {
		log.warn(
			"Schema v5 migration: storage shadow write failed (folder marked dirty) — leaving state PENDING; next startup will retry and re-push (migrated=%d, skipped=%d, took %d ms)",
			migrated,
			skipped,
			Date.now() - writeStart,
		);
		return { migrated, skipped, fresh, alreadyDone: false };
	}

	// Shadow is clean (or there is no swallowing shadow): persist the completed
	// marker as a separate write so it only lands after the content above did.
	const finalState: SchemaV5MigrationState = {
		version: 1,
		status: "completed",
		startedAt,
		completedAt: new Date().toISOString(),
		migratedCount: migrated,
		skippedCount: skipped,
		fresh,
	};
	await storage.writeFiles(
		[{ path: SCHEMA_V5_STATE_FILE, content: JSON.stringify(finalState, null, "\t") }],
		commitMessage,
	);
	log.info(
		"Schema v5 migration complete: %d migrated, %d skipped, fresh=%s, recovery=%s (took %d ms)",
		migrated,
		skipped,
		fresh,
		isRecovery,
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
 *
 * The "already v5" fast-path also requires `transcripts` to be present: a
 * record stamped `version: 5` but MISSING the `transcripts` field is anomalous
 * (a bug or hand-edit) and must NOT be treated as migrated — left alone it
 * would force `getTranscriptIds` down the v3/v4 children-walk fallback forever.
 * Falling through repairs it by computing the array like any pre-v5 root.
 */
function upgradeOneSummary(raw: CommitSummary, transcriptFileIds: ReadonlySet<string>): CommitSummary {
	if (raw.version >= 5 && raw.transcripts !== undefined) return raw;

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

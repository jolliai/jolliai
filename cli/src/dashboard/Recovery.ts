/**
 * Recovery — `doctor --recover`'s engine: enumerate every candidate source
 * with its identity, classify what happened, and perform the snapshot-restore
 * step. The plan's order is fixed — ① full snapshot restores the database,
 * ② mirrors only fill memory gaps, ③ the frozen orphan is the last resort —
 * because mirrors carry no activity data (sessions, git metadata, USAGE
 * SAMPLES): "rebuild everything from the mirror" would trade usage history
 * for memories. This module implements enumeration and step ①; the mirror
 * merge rides the existing importer and lands with the doctor flow's
 * interactive half.
 *
 * Restore discipline:
 * - NEVER overwrite a healthy database without `force` — recovery is for an
 *   absent or damaged database, and running it twice must be safe.
 * - The snapshot is integrity-checked BEFORE it replaces anything.
 * - Stale `-wal`/`-shm` sidecars are deleted after the restore: they belong
 *   to the DEAD database, and SQLite would replay a leftover WAL over the
 *   freshly restored file.
 * - Same-directory temp + rename, exactly like snapshot creation.
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { peekKBPath } from "../core/KBPathResolver.js";
import { toForwardSlash } from "../core/PathUtils.js";
import { loadConfig } from "../core/SessionTracker.js";
import type { StorageKind, StorageProvider } from "../core/StorageProvider.js";
import { createLogger, errMsg } from "../Logger.js";
import type { JolliMemoryConfig } from "../Types.js";
import {
	defaultBackupFolder,
	isOwnSnapshotName,
	parseUtcStamp,
	readMirrorInstanceId,
	verifySnapshotFile,
} from "./Backup.js";
import { canUseDashboardDb, ensureOwnerOnlyDir, getDashboardDbPath, withDashboardDb } from "./DashboardDb.js";
import { classifyDbFiles, classifyIdentity, type DbFileState, type IdentityVerdict } from "./DbDetection.js";
import { readRegistryInstanceId, readRepoRegistry } from "./RepoRegistry.js";
import { importRepoMemory, resolveProtectNewerThanMs } from "./SotImport.js";

const log = createLogger("Recovery");

export interface RecoveryCandidate {
	readonly path: string;
	readonly premigration: boolean;
	/** From the filename's UTC stamp; 0 when unparsable (sorts last). */
	readonly takenAtMs: number;
	/** id8 from the filename (regex-guaranteed) — matched against the witness. */
	readonly id8: string;
}

export interface RecoverySurvey {
	readonly dbPath: string;
	readonly fileState: DbFileState;
	readonly registryId: string | null;
	readonly mirrorId: string | null;
	/** Only meaningful when the database is absent. */
	readonly identity: IdentityVerdict;
	readonly candidates: ReadonlyArray<RecoveryCandidate>;
	/** Folders that were consulted (default/config/last-used/--from). */
	readonly foldersScanned: ReadonlyArray<string>;
}

/** Snapshot files in one folder, newest first; ignores everything foreign. */
function scanFolder(folder: string): RecoveryCandidate[] {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		return [];
	}
	return names
		.filter(isOwnSnapshotName)
		.map((name) => {
			const premigration = name.startsWith("memory-premigration-");
			// Both captures are guaranteed by isOwnSnapshotName's regexes.
			const stamp = (/(\d{8}T\d{6}Z)/.exec(name) as RegExpExecArray)[1];
			const id8 = (/-([0-9a-f]{8})\.db$/.exec(name) as RegExpExecArray)[1];
			return { path: join(folder, name), premigration, takenAtMs: parseUtcStamp(stamp) ?? 0, id8 };
		})
		.sort((a, b) => b.takenAtMs - a.takenAtMs);
}

/**
 * Enumerates candidates and classifies the situation. `extraFolder` is the
 * `--from <path>` escape hatch — snapshots carry their identity in the name,
 * so one picked up from any drive can still be matched.
 */
export async function surveyRecovery(
	opts: { readonly dbPath?: string; readonly extraFolder?: string; readonly config?: JolliMemoryConfig } = {},
): Promise<RecoverySurvey> {
	const config = opts.config ?? (await loadConfig());
	const dbPath = opts.dbPath ?? getDashboardDbPath();
	const folders = new Set<string>([config.backupFolder ?? defaultBackupFolder()]);
	if (opts.extraFolder) folders.add(opts.extraFolder);
	// The previous folder stays a candidate source after a re-target ("改目录
	// 不搬旧快照") — but it is recorded inside the database, which is exactly
	// what may be gone; reachable only when the database still opens.
	if (canUseDashboardDb() && existsSync(dbPath)) {
		try {
			const { DatabaseSync } = await import("node:sqlite");
			const db = new DatabaseSync(dbPath, { readOnly: true });
			try {
				const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'backup-folder-last-used'").get() as
					| { value: string }
					| undefined;
				if (row) folders.add(row.value);
			} finally {
				db.close();
			}
		} catch (err) {
			log.warn("could not read backup-folder-last-used: %s", errMsg(err));
		}
	}
	const candidates = [...folders].flatMap(scanFolder).sort((a, b) => b.takenAtMs - a.takenAtMs);
	const registryId = await readRegistryInstanceId();
	const mirrorId = await readMirrorInstanceId(config);
	return {
		dbPath,
		fileState: classifyDbFiles(dbPath),
		registryId,
		mirrorId,
		identity: classifyIdentity(registryId, mirrorId),
		candidates,
		foldersScanned: [...folders],
	};
}

/**
 * Read-only view of one repo mirror's hidden layer. The canonical JSON there
 * mirrors the orphan tree path-for-path (`summaries/<hash>.json`, ...), so a
 * StorageProvider over it is a direct join — no FolderStorage instance (and
 * no MetadataManager / claim semantics) needed for a read.
 */
class MirrorReadStorage implements StorageProvider {
	readonly kind: StorageKind = "folder";
	constructor(private readonly hiddenRoot: string) {}
	async readFile(path: string): Promise<string | null> {
		try {
			return readFileSync(join(this.hiddenRoot, path), "utf8");
		} catch {
			return null;
		}
	}
	async batchReadFiles(paths: ReadonlyArray<string>): Promise<Map<string, string | null>> {
		const out = new Map<string, string | null>();
		for (const p of paths) out.set(p, await this.readFile(p));
		return out;
	}
	async listFiles(prefix: string): Promise<string[]> {
		const out: string[] = [];
		const walk = (rel: string): void => {
			let names: string[];
			try {
				names = readdirSync(join(this.hiddenRoot, rel));
			} catch {
				return;
			}
			for (const name of names) {
				const relPath = rel ? `${rel}/${name}` : name;
				// A broken symlink or a file deleted between readdir and stat must
				// cost one entry, not the whole recovery pass.
				try {
					if (statSync(join(this.hiddenRoot, relPath)).isDirectory()) walk(relPath);
					else out.push(toForwardSlash(relPath));
				} catch {
					// skip the entry — the mirror is a best-effort recovery source
				}
			}
		};
		walk("");
		return out.filter((p) => p.startsWith(prefix)).sort();
	}
	async writeFiles(): Promise<void> {
		throw new Error("MirrorReadStorage is read-only");
	}
	async exists(): Promise<boolean> {
		return existsSync(this.hiddenRoot);
	}
	async ensure(): Promise<void> {
		throw new Error("MirrorReadStorage cannot be initialized");
	}
}

/**
 * Recovery step ②: mirrors fill MEMORY gaps only. The plan's temp-db merge
 * exists to protect activity data (usage samples above all) from being
 * overwritten by a memory-only source; `catch-up` mode gives the same
 * guarantee directly — it upserts memory tables, never deletes, and never
 * touches the activity layer — so the indirection is unnecessary.
 */
export async function fillMemoriesFromMirrors(
	opts: { readonly dbPath?: string; readonly config?: JolliMemoryConfig } = {},
): Promise<{ repos: number; nodes: number; skipped: number }> {
	const { readRepoCutoverFence } = await import("./RepoRegistry.js");
	const config = opts.config ?? (await loadConfig());
	const registry = await readRepoRegistry();
	let repos = 0;
	let nodes = 0;
	let skipped = 0;
	for (const repo of registry.repos) {
		const hidden = join(peekKBPath(repo.repoName, repo.remoteUrl ?? null, config.localFolder), ".jolli");
		if (!existsSync(hidden)) continue;
		// Same protection step ③ applies. The mirror keeps being written past the
		// fence (dual-write is invariant across the cutover), but it is still a
		// MIRROR, not the system of record: a row the database regenerated after
		// the folder's last successful write would be reverted by an unprotected
		// import — and recovery is exactly when the user has no other copy to
		// restore from.
		// EVERY checkout, not `roots[0]`: the newest one may be a clone made after
		// the cutover, which carries no fence of its own — see
		// `readRepoCutoverFence`. Missing the fence here does not fail, it reverts.
		//
		// So the CAS's `committedAt` is asked for whenever the fence cannot answer
		// (wiped `profile.json`, unparsable stamp) — the same fallback the drift
		// import and the dashboard sweep use. A record restored by step ① is
		// exactly the witness that survives the deletion of `.jolli/`.
		const fence = await readRepoCutoverFence(repo);
		// Per-repo, not per-pass: one unreadable mirror must not abort recovery
		// for every repo that still has a good one.
		try {
			const result = await withDashboardDb(
				(db) => {
					const protectMs = resolveProtectNewerThanMs(db, repo.repoIdentity, fence?.atMs);
					return importRepoMemory(db, {
						repo,
						storage: new MirrorReadStorage(hidden),
						mode: "catch-up",
						nowMs: Date.now(),
						...(protectMs !== undefined ? { protectNewerThanMs: protectMs } : {}),
					});
				},
				opts.dbPath ? { dbPath: opts.dbPath } : {},
			);
			repos++;
			nodes += result.nodes;
			skipped += result.skipped;
		} catch (err) {
			log.warn("mirror fill for %s failed: %s", repo.repoIdentity, errMsg(err));
			skipped++;
		}
	}
	return { repos, nodes, skipped };
}

export type RestoreResult =
	| { readonly status: "restored"; readonly from: string }
	| { readonly status: "refused"; readonly reason: string }
	| { readonly status: "failed"; readonly reason: string };

/**
 * Step ① of the fixed recovery order: the snapshot becomes the database.
 * Re-runnable by construction — restoring the same snapshot twice converges.
 */
export async function restoreFromSnapshot(
	snapshotPath: string,
	opts: { readonly dbPath?: string; readonly force?: boolean } = {},
): Promise<RestoreResult> {
	const dbPath = opts.dbPath ?? getDashboardDbPath();
	try {
		const state = classifyDbFiles(dbPath);
		if (state.startsWith("healthy") && !opts.force) {
			// Recovery is for an absent or damaged database. A healthy one is
			// only replaced on an explicit, human "yes, overwrite".
			return { status: "refused", reason: `a healthy database exists at ${dbPath} (pass force to overwrite)` };
		}
		if (!statSync(snapshotPath).isFile()) return { status: "failed", reason: "snapshot is not a file" };
		if (!(await verifySnapshotFile(snapshotPath))) {
			return { status: "failed", reason: "snapshot failed integrity_check — refusing to restore from it" };
		}
		// The state this function repairs ("absent") usually means the directory
		// went with the file — a `rm -rf ~/.jolli/jollimemory` is the primary
		// disaster case. Without this the temp copy below dies on ENOENT, i.e.
		// the one path that has to work is the one that cannot. Same helper as
		// `openDb`, so the restored file lands under an owner-only directory.
		ensureOwnerOnlyDir(dbPath);
		const temp = join(dirname(dbPath), `.${basename(dbPath)}.restore-tmp`);
		rmSync(temp, { force: true });
		copyFileSync(snapshotPath, temp);
		// The dead database's WAL must not be replayed over the restored file —
		// and the sidecars have to go BEFORE the rename: a concurrent opener in
		// the gap would otherwise pair the fresh file with the dead WAL. Removing
		// them first also means a removal failure aborts while the old state is
		// still intact, instead of reporting "failed" after the swap already happened.
		for (const suffix of ["-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
		renameSync(temp, dbPath);
		log.info("restored %s from %s", dbPath, snapshotPath);
		return { status: "restored", from: snapshotPath };
	} catch (err) {
		return { status: "failed", reason: errMsg(err) };
	}
}

/**
 * Recovery step ③, the last resort: the frozen orphan branches themselves.
 * Only fenced repos are touched — an un-fenced repo's orphan is still its
 * LIVE source of truth and gets re-imported by the ordinary backfill, while a
 * fenced repo's branch is a frozen snapshot that stops at the fence moment,
 * which is exactly why it ranks below snapshots (full database) and mirrors
 * (fresher memories): it can only recover what existed before the freeze.
 * catch-up only, same reasoning as the mirror step. After this fill the repo
 * routes as legacy-fenced (fence present, no cutover row in the rebuilt
 * database) — re-running 'jolli cutover' finishes the CAS.
 */
export async function fillMemoriesFromFrozenOrphans(
	opts: { readonly dbPath?: string; readonly nowMs?: number } = {},
): Promise<{ repos: number; nodes: number; skipped: number }> {
	const { GitRefStorage, resolveCommittish } = await import("../core/GitRefStorage.js");
	const { ORPHAN_BRANCH } = await import("../Logger.js");
	const { readRepoCutoverFence, readRepoRegistry } = await import("./RepoRegistry.js");
	const { importRepoMemory } = await import("./SotImport.js");
	const { withDashboardDb } = await import("./DashboardDb.js");
	const registry = await readRepoRegistry();
	let repos = 0;
	let nodes = 0;
	let skipped = 0;
	for (const repo of registry.repos) {
		// Both the fence AND the branch have to come from the checkout that was
		// actually cut over. `roots[0]` is merely the newest, and a clone made
		// after the cutover has neither: no fence in its profile.json (so this
		// step used to `continue` past a repo it is the LAST resort for) and no
		// orphan branch to resolve either, since that branch is local-only.
		const fence = await readRepoCutoverFence(repo);
		if (!fence) continue;
		const tip = await resolveCommittish(ORPHAN_BRANCH, fence.root);
		if (!tip) continue;
		// The branch stopped at the fence moment, so anything the database
		// stamped after it (snapshot restore, mirror fill) outranks this source.
		// An unparsable stamp falls back to the CAS record rather than importing
		// unprotected — see `resolveProtectNewerThanMs`.
		// Per-repo, exactly as in fillMemoriesFromMirrors: this is the LAST
		// resort in the recovery order, so one repo whose frozen branch cannot
		// be read (a pruned object, a permission error, a schema-ahead database)
		// must not abandon recovery for every repo that still has a good one.
		try {
			const result = await withDashboardDb(
				(db) => {
					const protectMs = resolveProtectNewerThanMs(db, repo.repoIdentity, fence.atMs);
					return importRepoMemory(db, {
						repo,
						storage: new GitRefStorage(tip, fence.root),
						nowMs: opts.nowMs ?? Date.now(),
						mode: "catch-up",
						...(protectMs !== undefined ? { protectNewerThanMs: protectMs } : {}),
					});
				},
				opts.dbPath ? { dbPath: opts.dbPath } : {},
			);
			repos++;
			nodes += result.nodes;
			skipped += result.skipped;
		} catch (err) {
			log.warn("frozen-orphan fill for %s failed: %s", repo.repoIdentity, errMsg(err));
			skipped++;
		}
	}
	return { repos, nodes, skipped };
}

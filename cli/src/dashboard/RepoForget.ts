/**
 * RepoForget — removing a repo from this machine's dashboard, by IDENTITY.
 *
 * The registry and the `repos` table both used to be append-only in practice,
 * and the reason was not a missing cleanup pass: the only removal entry point,
 * `deregisterRepo`, resolves its target from `cwd`, so a checkout that no longer
 * exists can never be named — and it stamps `disabledAt` rather than removing
 * anything. Entries for deleted directories, renamed local-only repos and
 * fixture checkouts under `%TEMP%` therefore accumulated with no code path able
 * to reach them, kept being shipped to the browser in every page payload, and
 * kept costing every sweep a pass.
 *
 * So this module is the identity-addressed removal, and everything else is a
 * caller: the dashboard's per-row control, the unattended prune of
 * {@link isDisposableRepo} entries, and `jolli doctor --fix`.
 *
 * Two orderings are load-bearing.
 *
 * **Database rows first, registry second.** The other way round, a registry
 * write that lands while the row deletion fails leaves a row the page still
 * renders and that no later sweep can see — the registry no longer lists it, so
 * nothing will ever retry. Failing in this order costs at most one un-swept
 * pass: the entry is still listed, and the next prune tries again.
 *
 * **Unprojected events with the rows.** `StatsWriter.ensureRepoRow` inserts a
 * placeholder `repos` row from an event's identity alone, so a single `pending`
 * (or revivable `failed`) row in `events_raw` resurrects a repo the moment the
 * next drain runs. Deleting the rows without them is a no-op with a delay.
 */

import { copyFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger, errMsg } from "../Logger.js";
import { formatUtcStamp } from "./Backup.js";
import {
	canUseDashboardDb,
	type DashboardDbHandle,
	getDashboardDbPath,
	inTransaction,
	withDashboardDb,
	withReadonlyDashboardDb,
} from "./DashboardDb.js";
import {
	type DisposableRepoOptions,
	getRepoRegistryPath,
	hasLiveWorktree,
	isDisposableRepo,
	type RegisteredRepo,
	readRepoRegistry,
	recordedRepoPaths,
	removeReposFromRegistry,
	tempRoots,
} from "./RepoRegistry.js";

const log = createLogger("RepoForget");

export interface ForgetRepoOptions extends ClassifyRepoOptions {
	readonly configDir?: string;
	/** Override the database path. Tests point this at a temp file. */
	readonly dbPath?: string;
}

/** What the database half removed for one identity. */
export interface ForgetCounts {
	readonly repoRowDeleted: boolean;
	/** Rows deleted from the tables that reference `repos.id` directly. */
	readonly childRowsDeleted: number;
	readonly pendingEventsDeleted: number;
}

export interface ForgetRepoResult extends ForgetCounts {
	readonly identity: string;
	readonly removedFromRegistry: boolean;
	/**
	 * Why nothing was removed for this identity.
	 *
	 * Present only on failure, and its presence is what stops the registry half
	 * running for that identity — a caller must be able to tell "there was
	 * nothing to remove" (every count zero, no error) from "the removal did not
	 * happen", because the two look identical in the counts alone.
	 */
	readonly error?: string;
}

const NOTHING: ForgetCounts = { repoRowDeleted: false, childRowsDeleted: 0, pendingEventsDeleted: 0 };

/** A table that references `repos.id`, and the column that does it. */
interface RepoChildTable {
	readonly table: string;
	readonly column: string;
}

/**
 * The tables that reference `repos.id` directly, derived from the schema rather
 * than listed here.
 *
 * Twelve today (`branches`, `commits`, `context`, `ingest_cursors`, `memories`,
 * `recall_receipts`, `repo_state`, `sessions`, `topic_pages`,
 * `topic_processed_sources`, `transcripts`, `worktree_status`), and the other ten
 * tables that carry a `repo_id` reach `repos` only through one of those with
 * `ON DELETE CASCADE`, so deleting these twelve empties all of them. Every
 * reference is `NO ACTION`, so the row itself cannot go first.
 *
 * Derived because a hand-kept list fails in the direction that is hard to
 * notice: a table added later would make the final `DELETE FROM repos` fail the
 * foreign-key check, and the failure would surface as "forget did not work" long
 * after the schema change that caused it. `SotSchema`'s own test pins the derived
 * set, so a new referencing table shows up as a visible test edit instead.
 *
 * Sorted for determinism — the deletion order is irrelevant (every one of them is
 * a child of `repos`, and their own children cascade), but a stable order keeps
 * the assertion and the log line stable.
 */
export function repoChildTables(db: DashboardDbHandle): ReadonlyArray<RepoChildTable> {
	const names = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'repos'")
		.all() as ReadonlyArray<{ name: string }>;
	const out: RepoChildTable[] = [];
	for (const { name } of names) {
		// PRAGMA takes no bound parameters, and the name came out of this database's
		// own sqlite_master — quoted anyway so a table whose name needs it still works.
		const fks = db.prepare(`PRAGMA foreign_key_list("${name}")`).all() as ReadonlyArray<{
			table: string;
			from: string;
			to: string | null;
		}>;
		// `to` is null when a reference omits the parent column (implicit primary
		// key). Our schema always names `id`; accept both so a later table cannot
		// slip through by using the shorter form.
		const fk = fks.find((entry) => entry.table === "repos" && (entry.to === "id" || entry.to === null));
		if (fk) out.push({ table: name, column: fk.from });
	}
	return out.sort((a, b) => a.table.localeCompare(b.table));
}

/** Deletes one repo's rows. Runs inside the caller's transaction. */
function deleteRepoRows(
	db: DashboardDbHandle,
	identity: string,
	children: ReadonlyArray<RepoChildTable>,
): ForgetCounts {
	const row = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(identity) as { id: number } | undefined;
	let childRowsDeleted = 0;
	if (row) {
		for (const { table, column } of children) {
			childRowsDeleted += changed(db.prepare(`DELETE FROM "${table}" WHERE "${column}" = ?`).run(row.id));
		}
	}
	const repoRowDeleted = row !== undefined && changed(db.prepare("DELETE FROM repos WHERE id = ?").run(row.id)) > 0;
	// Not gated on `row`: an identity whose only trace is an unprojected event has
	// no row yet, and leaving that event behind means the next drain creates one.
	// `<> 'projected'` rather than `= 'pending'` because the drain revives a
	// `failed` row whose reason was `unknown-type`.
	const pendingEventsDeleted = changed(
		db.prepare("DELETE FROM events_raw WHERE repo_identity = ? AND projection_status <> 'projected'").run(identity),
	);
	return { repoRowDeleted, childRowsDeleted, pendingEventsDeleted };
}

/**
 * The row count of a statement `run`. `DashboardStatement.run` is typed `unknown`
 * (the handle is structurally typed against `DatabaseSync` rather than importing
 * it), and `Number` also flattens the bigint form a driver may report — same
 * reading as `SotImport` / `SotWrite` do.
 */
function changed(result: unknown): number {
	return Number((result as { changes: number | bigint }).changes);
}

/**
 * Forgets several repos: their rows, their unprojected events, their registry
 * entries. Never partially reported — an identity whose rows could not be
 * deleted keeps its registry entry and comes back with `error` set.
 *
 * Throws only when the database is unreachable as a whole, because that is the
 * one state in which removing the registry entries would be actively harmful:
 * the rows would stay, and the page would keep rendering repos nothing can
 * reach any more.
 */
export async function forgetRepos(
	identities: ReadonlyArray<string>,
	opts: ForgetRepoOptions = {},
): Promise<ReadonlyArray<ForgetRepoResult>> {
	const unique = [...new Set(identities)];
	if (unique.length === 0) return [];
	if (!canUseDashboardDb()) {
		throw new Error(
			"node:sqlite is unavailable on this runtime — cannot delete a repo's rows, so nothing was removed",
		);
	}

	const counts = new Map<string, ForgetCounts>();
	const failures = new Map<string, string>();
	const dbPath = opts.dbPath ?? getDashboardDbPath();
	if (existsSync(dbPath)) {
		await withDashboardDb(
			(db) => {
				const children = repoChildTables(db);
				for (const identity of unique) {
					// One transaction per identity, and a failure confined to it: a lock
					// lost on the tenth repo must not roll back the nine before it, nor
					// stop the sweep from finishing the rest.
					try {
						counts.set(
							identity,
							inTransaction(db, () => deleteRepoRows(db, identity, children)),
						);
					} catch (err) {
						failures.set(identity, errMsg(err));
						log.warn("could not delete rows for %s: %s", identity, errMsg(err));
					}
				}
			},
			opts.dbPath ? { dbPath: opts.dbPath } : {},
		);
	} else {
		// No database yet: there are no rows to lose, so the registry half is safe
		// to run. Opening it here would CREATE and migrate one, which is a strange
		// side effect for a removal.
		for (const identity of unique) counts.set(identity, NOTHING);
	}

	const removed = new Set(await removeReposFromRegistry([...counts.keys()], opts.configDir));
	return unique.map((identity) => {
		const error = failures.get(identity);
		if (error !== undefined) return { identity, removedFromRegistry: false, ...NOTHING, error };
		/* v8 ignore next -- the two maps partition `unique`: an identity without an
		   error was counted above, so the fallback is unreachable by construction */
		return { identity, removedFromRegistry: removed.has(identity), ...(counts.get(identity) ?? NOTHING) };
	});
}

/** {@link forgetRepos} for one identity. */
export async function forgetRepo(identity: string, opts: ForgetRepoOptions = {}): Promise<ForgetRepoResult> {
	const [result] = await forgetRepos([identity], opts);
	return result;
}

/**
 * What a registry entry is, as far as removal is concerned.
 *
 * `dead` and `unavailable` are the same observation — no recorded path exists —
 * split by whether the VOLUME is there. An unplugged external drive or an
 * unmapped network drive is a repo the user still expects back, and `DbBackfill`
 * already refuses to deregister on that evidence for the same reason.
 *
 * Neither is ever removed unattended; the split changes the ADVICE, and how much
 * of it can be given is platform-dependent. On Windows a missing drive letter or
 * unreachable UNC host makes the distinction exactly, so the report can say
 * "plug it in" instead of offering a removal. On POSIX an unmounted mountpoint
 * usually still exists as an empty directory, so it is indistinguishable from a
 * deleted folder and reads as `dead`. That residual is what makes the removal of
 * a `dead` entry `doctor --fix`-only, listed by path, and backed up first —
 * consent is the guard the filesystem cannot provide.
 */
export type RegistryEntryVerdict = "live" | "disposable" | "dead" | "unavailable";

/**
 * Whether the volume this path is on can be reached at all — i.e. whether it has
 * ANY existing ancestor.
 *
 * Deliberately no `resolve()`: a POSIX-absolute path recorded by a WSL or
 * cross-platform tool is treated as drive-relative on Windows, so resolving would
 * answer about a directory the entry never named. Same reason
 * `normalizePathForCompare` avoids it.
 *
 * `exists` is a seam because the `false` branch is unreachable on POSIX, where
 * every absolute path bottoms out at a live `/` — so the one verdict that must
 * never be confused with a deletion would otherwise be covered on Windows only.
 */
export function volumeReachable(path: string, exists: (probe: string) => boolean = existsSync): boolean {
	let probe = path;
	while (!exists(probe)) {
		const parent = dirname(probe);
		if (parent === probe) return false;
		probe = parent;
	}
	return true;
}

export interface ClassifyRepoOptions extends DisposableRepoOptions {
	/** Existence probe for the volume walk; see {@link volumeReachable}. */
	readonly pathExists?: (path: string) => boolean;
}

export function classifyRegistryEntry(repo: RegisteredRepo, opts: ClassifyRepoOptions = {}): RegistryEntryVerdict {
	if (hasLiveWorktree(repo)) return "live";
	if (isDisposableRepo(repo, opts)) return "disposable";
	const reachable = recordedRepoPaths(repo).some((path) =>
		opts.pathExists ? volumeReachable(path, opts.pathExists) : volumeReachable(path),
	);
	return reachable ? "dead" : "unavailable";
}

export interface RegistrySurvey {
	readonly live: ReadonlyArray<RegisteredRepo>;
	/** Auto-prunable; see {@link isDisposableRepo}. */
	readonly disposable: ReadonlyArray<RegisteredRepo>;
	/** Gone, on a volume that is present — removable, but only on request. */
	readonly dead: ReadonlyArray<RegisteredRepo>;
	/** Gone with its whole volume — reported, never removed. */
	readonly unavailable: ReadonlyArray<RegisteredRepo>;
}

/**
 * `repos` rows whose identity the registry does not list, as registry-shaped
 * entries — the OTHER half of what is on this machine.
 *
 * The two stores are written by different paths (`registerRepo` writes the
 * registry; `StatsWriter.ensureRepoRow` inserts from an event's identity alone),
 * so a row can outlive its entry — a `jolli disable` + registry edit, a fixture
 * that only ever produced events, a registry rebuilt from a different machine.
 * Such a row is the shape that hurts most: the page renders it, and a survey that
 * reads only the registry reports the machine as clean.
 *
 * A row whose `worktree_root` IS its identity is skipped: that is the placeholder
 * an event creates before its repo registers, and it names no directory to judge.
 * Best-effort — an unreadable database means the registry half still answers.
 */
async function unregisteredRepoRows(
	known: ReadonlySet<string>,
	opts: ForgetRepoOptions,
): Promise<ReadonlyArray<RegisteredRepo>> {
	const dbPath = opts.dbPath ?? getDashboardDbPath();
	if (!canUseDashboardDb() || !existsSync(dbPath)) return [];
	try {
		return await withReadonlyDashboardDb(
			(db) =>
				(
					db
						.prepare("SELECT repo_identity, repo_name, worktree_root, enabled_at FROM repos")
						.all() as ReadonlyArray<{
						repo_identity: string;
						repo_name: string;
						worktree_root: string;
						enabled_at: string;
					}>
				)
					.filter((row) => !known.has(row.repo_identity) && row.worktree_root !== row.repo_identity)
					.map((row) => ({
						repoIdentity: row.repo_identity,
						repoName: row.repo_name,
						worktreeRoot: row.worktree_root,
						enabledAt: row.enabled_at,
					})),
			opts.dbPath ? { dbPath: opts.dbPath } : {},
		);
	} catch (err) {
		log.warn("could not list database repos for the registry survey: %s", errMsg(err));
		return [];
	}
}

/**
 * Groups everything this machine claims is a repo — registry entries AND
 * database rows the registry no longer lists — by {@link classifyRegistryEntry}.
 */
export async function surveyRepoRegistry(opts: ForgetRepoOptions = {}): Promise<RegistrySurvey> {
	const survey: Record<RegistryEntryVerdict, RegisteredRepo[]> = {
		live: [],
		disposable: [],
		dead: [],
		unavailable: [],
	};
	// The WHOLE registry, disabled entries included: a disabled entry whose
	// directory is gone is exactly as unreachable as an enabled one, and
	// `listActiveRepos` would filter out the very rows this survey exists to find.
	const entries = (await readRepoRegistry(opts.configDir)).repos;
	const known = new Set(entries.map((repo) => repo.repoIdentity));
	// Resolved once, ahead of the loop: `isDisposableRepo` otherwise falls back to
	// `tempRoots()` per call, which is a `realpathSync` per entry for an answer
	// that cannot change during one survey. `repairRegistryEntries` already hoists
	// it around its own loop; this is the same hoist on the read side.
	const classifyOpts: ClassifyRepoOptions = { ...opts, tempRoots: opts.tempRoots ?? tempRoots() };
	for (const repo of [...entries, ...(await unregisteredRepoRows(known, opts))]) {
		survey[classifyRegistryEntry(repo, classifyOpts)].push(repo);
	}
	return survey;
}

/**
 * Copies the registry beside itself, returning the backup's path — or null when
 * there is no registry yet.
 *
 * For the removals a user asked for, never for the unattended prune. The prune's
 * class is fixture garbage under `%TEMP%` and a backup of it is a copy of the
 * problem; `doctor --fix` reaches entries whose only fault is that a folder is
 * gone, which a remounted drive or a re-clone can make wrong, and there the one
 * irreversible step deserves an undo.
 *
 * Throws rather than degrading: a removal that could not be backed up is not the
 * operation the user consented to. Names itself with the same UTC stamp
 * `Backup.ts` puts on database snapshots, so two artifacts of one incident sort
 * together.
 */
export function backupRepoRegistry(nowMs: number, configDir?: string): string | null {
	const path = getRepoRegistryPath(configDir);
	if (!existsSync(path)) return null;
	const backup = `${path}.${formatUtcStamp(nowMs)}.bak`;
	copyFileSync(path, backup);
	return backup;
}

/**
 * Removes every {@link isDisposableRepo} entry, unattended.
 *
 * Called on the dashboard launch path, so it never throws — a machine that
 * cannot prune must still get its page. It reports what it removed instead of
 * capping or summarising: the caller prints one line, and every identity is in
 * the log.
 */
export async function pruneDisposableRepos(opts: ForgetRepoOptions = {}): Promise<ReadonlyArray<ForgetRepoResult>> {
	try {
		if (!canUseDashboardDb()) {
			log.debug("skipping the disposable-repo prune — node:sqlite is unavailable on this runtime");
			return [];
		}
		const victims = (await surveyRepoRegistry(opts)).disposable;
		if (victims.length === 0) return [];
		for (const repo of victims) log.info("pruning disposable entry %s (%s)", repo.repoIdentity, repo.worktreeRoot);
		const results = await forgetRepos(
			victims.map((repo) => repo.repoIdentity),
			opts,
		);
		for (const result of results) {
			if (result.error !== undefined) continue; // already warned by forgetRepos
			log.info(
				"pruned %s: repo row %s, %d child row(s), %d unprojected event(s)",
				result.identity,
				result.repoRowDeleted ? "deleted" : "absent",
				result.childRowsDeleted,
				result.pendingEventsDeleted,
			);
		}
		return results;
	} catch (err) {
		log.warn("disposable-repo prune failed: %s", errMsg(err));
		return [];
	}
}

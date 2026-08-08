/**
 * Backup — snapshot engine for `jollimemory.db`, the cutover gate the plan
 * calls "备份和恢复必须真做完". After the orphan branch freezes, these files
 * are the ONLY disaster recovery, which fixes several choices:
 *
 * - **`VACUUM INTO` only.** It produces a single consistent file including
 *   committed WAL frames. Copying the `.db`/`-wal`/`-shm` triplet is not one
 *   point in time, and `node:sqlite`'s `backup()` arrived in 22.14 — above the
 *   22.13 floor the hook dispatchers guarantee. The snapshot lands in a temp
 *   file IN THE TARGET DIRECTORY and is renamed into place, so the visible
 *   name is atomic even when the target is another filesystem.
 * - **Verify BEFORE rotate.** `integrity_check` runs on the snapshot file and
 *   a failed snapshot is deleted; old snapshots are only cleaned up after a
 *   NEW one verifiably exists — a machine whose backup drive is unplugged
 *   must never empty itself one expired file at a time.
 * - **Two floors outrank both collectors.** Never delete below
 *   {@link MIN_SNAPSHOTS_KEPT} verified snapshots no matter how old (a user
 *   who committed nothing for a month is exactly who needs the old one), and
 *   age-based cleanup runs only after a successful new snapshot.
 * - **Age comes from the UTC stamp in the FILENAME**, mtime only as fallback:
 *   sync drives rewrite mtime and would make fresh snapshots look expired.
 *   Rotation touches only names this module produces — the folder is visible
 *   in $HOME and users will put their own files next to ours.
 * - **No fallback target, no silent skip.** An unreachable folder logs a
 *   warning with the age of the last success; an ILLEGAL folder (inside
 *   `~/.jolli`, same directory as the live db) is a configuration error that
 *   fails the cutover gate. Neither ever reroutes snapshots elsewhere.
 * - **Never blocks git.** Every entry point catches everything and reports a
 *   status; the opportunistic callers (dashboard start, post-COMMIT worker)
 *   treat a failure as a log line, not an exception.
 *
 * Pre-migration snapshots (`memory-premigration-...`) are exempt from age and
 * size collection — a schema bug can surface long after 20 days — but only
 * the newest {@link PREMIGRATION_KEPT} are kept.
 */

import { randomUUID } from "node:crypto";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execGit } from "../core/GitOps.js";
import { isValidLocalFolder, peekKBPath } from "../core/KBPathResolver.js";
import { loadConfig } from "../core/SessionTracker.js";
import { createLogger, errMsg } from "../Logger.js";
import type { JolliMemoryConfig } from "../Types.js";
import { canUseDashboardDb, type DashboardDbHandle, getDashboardDbPath, withDashboardDb } from "./DashboardDb.js";
import { readRepoRegistry, stampRegistryInstanceId } from "./RepoRegistry.js";

const log = createLogger("Backup");

export const DEFAULT_RETENTION_DAYS = 20;
export const MIN_SNAPSHOTS_KEPT = 2;
export const PREMIGRATION_KEPT = 5;
const SIZE_FLOOR_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const DAY_MS = 24 * 60 * 60 * 1000;

/** `memory-20260804T093000Z-1a2b3c4d.db` (regular) — id ties it to its database. */
const SNAPSHOT_RE = /^memory-(\d{8}T\d{6}Z)-[0-9a-f]{8}\.db$/;
/** `memory-premigration-<utc>-<id8>.db` — retention-exempt, capped separately. */
const PREMIGRATION_RE = /^memory-premigration-(\d{8}T\d{6}Z)-[0-9a-f]{8}\.db$/;

/** Default target: visible in $HOME, outside `~/.jolli`, no user config needed. */
export function defaultBackupFolder(): string {
	return join(homedir(), "jolli_back");
}

export function formatUtcStamp(nowMs: number): string {
	return new Date(nowMs)
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
}

/**
 * Epoch ms from a snapshot filename's UTC stamp; null when unparsable —
 * including digit-shaped nonsense (month 99), because `Date.UTC` would
 * happily roll that over into a wrong-but-finite time instead of failing.
 */
export function parseUtcStamp(stamp: string): number | null {
	const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
	if (!m) return null;
	const [, , mo, d, h, mi, sec] = m.map(Number);
	if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return null;
	return Date.UTC(Number(m[1]), mo - 1, d, h, mi, sec);
}

/**
 * The database's own identity, minted on first ask and stored in schema_meta.
 * It is stamped into every snapshot filename (and rides inside the snapshot's
 * own schema_meta), so a snapshot found on any drive can be matched back to
 * the database it came from — the identity half of the deletion detector.
 */
export function ensureInstanceId(db: DashboardDbHandle): string {
	const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'instance-id'").get() as
		| { value: string }
		| undefined;
	if (row) return row.value;
	const id = randomUUID();
	db.prepare("INSERT INTO schema_meta (key, value) VALUES ('instance-id', ?)").run(id);
	return id;
}

export interface SnapshotOptions {
	/** Path of the live database (for size-cap math and same-dir refusal). */
	readonly dbPath: string;
	readonly nowMs: number;
	readonly config: JolliMemoryConfig;
	/** Marks the snapshot retention-exempt (pre-migration). */
	readonly premigration?: boolean;
	/** Skips the daily gate (explicit `jolli backup now` / pre-migration). */
	readonly force?: boolean;
}

export type SnapshotResult =
	| { readonly status: "created"; readonly path: string }
	| { readonly status: "skipped"; readonly reason: string }
	| { readonly status: "failed"; readonly reason: string };

/**
 * True when `norm` IS `parent` or lives under it. Both separators, because
 * this decides whether snapshots share fate with what they back up and the
 * two callers below disagreed on Windows: `checkFolder` tested `/` and `\`,
 * `validateBackupFolder`'s Memory Bank rule tested only `/`, so a Windows
 * `backupFolder` inside the Memory Bank folder passed save-time validation
 * and was later eligible for mirror pruning. Both paths take `resolve`d
 * input, so no further normalization is needed here.
 */
function isInside(norm: string, parent: string): boolean {
	return norm === parent || norm.startsWith(`${parent}/`) || norm.startsWith(`${parent}\\`);
}

/** Snapshot folder problems split exactly as the plan's table does. */
function checkFolder(folder: string, dbPath: string): { readonly illegal?: string } {
	// `..` segments need no check here: resolve() has already normalized them
	// away (the SAVE-time validator rejects the raw string instead).
	if (!isAbsolute(folder)) return { illegal: "backupFolder must be an absolute path" };
	const norm = resolve(folder);
	const jolliTree = join(homedir(), ".jolli");
	if (isInside(norm, jolliTree)) {
		// Disaster recovery must not share fate with the disaster: rm -rf
		// ~/.jolli/jollimemory takes the database AND these snapshots.
		return { illegal: "backupFolder must not live inside ~/.jolli" };
	}
	if (norm === resolve(join(dbPath, ".."))) {
		return { illegal: "backupFolder must not be the live database's own directory" };
	}
	return {};
}

interface SnapshotFile {
	readonly path: string;
	readonly name: string;
	readonly ageMs: number;
	readonly size: number;
	readonly premigration: boolean;
}

/** Only files THIS module produced, with age from the filename stamp. */
function listOwnSnapshots(folder: string, nowMs: number): SnapshotFile[] {
	const out: SnapshotFile[] = [];
	for (const name of readdirSync(folder)) {
		const pre = PREMIGRATION_RE.exec(name);
		const reg = pre ? null : SNAPSHOT_RE.exec(name);
		if (!pre && !reg) continue;
		const path = join(folder, name);
		let stat: { mtimeMs: number; size: number };
		try {
			stat = statSync(path);
		} catch {
			continue; // raced away — someone else's cleanup
		}
		const stamped = parseUtcStamp((pre ?? (reg as RegExpExecArray))[1]);
		// Filename stamp first: sync drives rewrite mtime, and an mtime-judged
		// fresh snapshot could be deleted as "expired" the day it was written.
		const ageMs = nowMs - (stamped ?? stat.mtimeMs);
		out.push({ path, name, ageMs, size: stat.size, premigration: pre !== null });
	}
	// Oldest first — the deletion order for both collectors.
	return out.sort((a, b) => b.ageMs - a.ageMs);
}

/** Applies both collectors under both floors. Never throws. */
function rotate(folder: string, nowMs: number, retentionDays: number, dbSizeBytes: number): void {
	const all = listOwnSnapshots(folder, nowMs);

	// Pre-migration snapshots: exempt from age and size, capped by count.
	const premigration = all.filter((s) => s.premigration);
	for (const victim of premigration.slice(0, Math.max(0, premigration.length - PREMIGRATION_KEPT))) {
		rmSync(victim.path, { force: true });
		log.info("rotated pre-migration snapshot %s", victim.name);
	}

	let regular = all.filter((s) => !s.premigration);
	const deletable = (): SnapshotFile[] => regular.slice(0, Math.max(0, regular.length - MIN_SNAPSHOTS_KEPT));

	// Collector 1: retention. "Don't accumulate forever", not "burn on expiry" —
	// the floor keeps the last two even when everything is over-age.
	for (const victim of deletable().filter((s) => s.ageMs > retentionDays * DAY_MS)) {
		rmSync(victim.path, { force: true });
		regular = regular.filter((s) => s !== victim);
		log.info("rotated snapshot %s (over %d days)", victim.name, retentionDays);
	}

	// Collector 2: the size cap follows retention (max(2 GiB, days x db size)),
	// so it only catches abnormal growth instead of silently overriding the
	// user-visible retention promise.
	const capBytes = Math.max(SIZE_FLOOR_BYTES, retentionDays * dbSizeBytes);
	let total = regular.reduce((sum, s) => sum + s.size, 0);
	for (const victim of deletable()) {
		if (total <= capBytes) break;
		rmSync(victim.path, { force: true });
		total -= victim.size;
		regular = regular.filter((s) => s !== victim);
		log.info("rotated snapshot %s (size cap)", victim.name);
	}
	if (total > capBytes) {
		log.error(
			"snapshot folder still %d bytes over cap but the 2-snapshot floor forbids deleting more",
			total - capBytes,
		);
	}
}

/**
 * Takes one snapshot if due, verifies it, then (and only then) rotates.
 * Returns a status instead of throwing — every caller is on a path that must
 * not block ("永不阻塞 git，失败只记日志").
 */
export async function maybeSnapshot(db: DashboardDbHandle, opts: SnapshotOptions): Promise<SnapshotResult> {
	try {
		return await snapshotInner(db, opts);
	} catch (err) {
		const reason = errMsg(err);
		log.warn("snapshot failed (old snapshots untouched): %s", reason);
		return { status: "failed", reason };
	}
}

async function snapshotInner(db: DashboardDbHandle, opts: SnapshotOptions): Promise<SnapshotResult> {
	const configured = opts.config.backupFolder;
	const folder = configured ?? defaultBackupFolder();
	const { illegal } = checkFolder(folder, opts.dbPath);
	if (illegal) {
		// A stored illegal value is a red-status configuration error and fails
		// the cutover gate — never "fixed" by falling back to another folder.
		log.error("backupFolder rejected: %s", illegal);
		return { status: "failed", reason: illegal };
	}
	// The DEFAULT folder never went through `validateBackupFolder` — that runs at
	// SAVE time, and nobody saved this one. So its one destructive precondition is
	// checked here: `~/jolli_back` sits inside $HOME, and a developer whose $HOME is
	// a dotfiles git worktree would have every snapshot removed by `git clean -xdf`.
	// Refuse rather than write snapshots into something that deletes them; a folder
	// the user picked explicitly was already checked and is trusted here.
	if (configured === undefined) {
		// Fails OPEN: an inconclusive probe (no git on PATH, a spawn error) must not
		// stop disaster recovery. The guard exists to refuse a known-bad target, and
		// "we could not tell" is not that.
		const inTree = await execGit(["rev-parse", "--is-inside-work-tree"], homedir()).catch((err) => {
			log.debug("default-backup-folder worktree probe skipped: %s", errMsg(err));
			return null;
		});
		if (inTree && inTree.exitCode === 0 && inTree.stdout.trim() === "true") {
			const reason =
				`the default backup folder ${folder} is inside a git worktree ` +
				"(git clean -xdf would delete the snapshots) — set backupFolder to a path outside it";
			log.error("%s", reason);
			return { status: "failed", reason };
		}
	}

	const last = db.prepare("SELECT value FROM schema_meta WHERE key = 'last-snapshot-at'").get() as
		| { value: string }
		| undefined;
	const lastMs = last ? Number(last.value) : Number.NaN;
	if (!opts.force && Number.isFinite(lastMs) && opts.nowMs - lastMs < DAY_MS) {
		return { status: "skipped", reason: "daily snapshot already taken" };
	}

	try {
		mkdirSync(folder, { recursive: true });
	} catch (err) {
		// Legal but unreachable (drive unplugged): warn with staleness, never
		// fall back, never go silent.
		const age = Number.isFinite(lastMs) ? `${Math.round((opts.nowMs - lastMs) / DAY_MS)} day(s)` : "never";
		log.warn("backup folder %s unreachable (%s); last successful snapshot: %s ago", folder, errMsg(err), age);
		return { status: "failed", reason: `backup folder unreachable: ${errMsg(err)}` };
	}

	const id8 = ensureInstanceId(db).replace(/-/g, "").slice(0, 8);
	const stamp = formatUtcStamp(opts.nowMs);
	const name = opts.premigration ? `memory-premigration-${stamp}-${id8}.db` : `memory-${stamp}-${id8}.db`;
	const finalPath = join(folder, name);
	// Temp lives in the TARGET directory so the final rename is atomic even
	// when the target is another filesystem.
	//
	// The pid+nonce suffix is load-bearing. `name` is only a whole-second stamp
	// plus the instance id, and the instance id belongs to the DATABASE — which is
	// machine-global — so two repos committing in the same second produced the
	// identical temp path. Both then `rmSync`'d it (before and after their own
	// VACUUM), so each deleted the file the other was writing and neither snapshot
	// landed: the day's backup silently did not happen. The pid separates
	// processes; the nonce separates two calls inside ONE process, which the
	// post-commit worker and a `jolli backup now` can genuinely overlap on. The
	// FINAL path stays free of both — a same-second collision there is two
	// snapshots of the same database, where last-writer-wins is correct.
	const tempPath = join(folder, `.${name}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`);

	rmSync(tempPath, { force: true });
	try {
		db.prepare("VACUUM INTO ?").run(tempPath);
		if (!(await verifySnapshotFile(tempPath))) {
			// A corrupt live database must not overwrite good snapshots.
			throw new Error("snapshot failed integrity_check");
		}
		renameSync(tempPath, finalPath);
	} catch (err) {
		rmSync(tempPath, { force: true });
		throw err;
	}

	db.prepare(
		`INSERT INTO schema_meta (key, value) VALUES ('last-snapshot-at', ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	).run(String(opts.nowMs));
	db.prepare(
		`INSERT INTO schema_meta (key, value) VALUES ('backup-folder-last-used', ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	).run(folder);
	log.info("snapshot created: %s", finalPath);

	// Rotation strictly AFTER a verified new snapshot exists. The live file is
	// there by construction — the open handle this ran against points at it.
	const dbSize = statSync(opts.dbPath).size;
	const days = opts.config.backupRetentionDays ?? DEFAULT_RETENTION_DAYS;
	rotate(folder, opts.nowMs, days, dbSize);
	return { status: "created", path: finalPath };
}

/**
 * `PRAGMA integrity_check` on the snapshot FILE, not the live database.
 * Also the pre-restore gate in Recovery — a corrupt snapshot must neither
 * enter rotation nor replace anything.
 */
export async function verifySnapshotFile(path: string): Promise<boolean> {
	// Lazy dynamic import mirrors the rest of the dashboard layer: this module
	// is bundled into surfaces that must still LOAD on a runtime without
	// node:sqlite (pure ESM, so no require here either).
	const { DatabaseSync } = await import("node:sqlite");
	try {
		const snap = new DatabaseSync(path, { readOnly: true }) as unknown as DashboardDbHandle;
		try {
			const rows = snap.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
			return rows.length === 1 && Object.values(rows[0])[0] === "ok";
		} finally {
			snap.close();
		}
	} catch {
		// "not a database at all" is the same verdict as a failed check.
		return false;
	}
}

/**
 * The opportunistic entry point — what the dashboard server calls on start
 * and the QueueWorker calls after its post-drain COMMIT. Self-contained:
 * opens its own short-lived handle, loads config itself, obeys the daily
 * gate, degrades below the Node floor, and never throws. There is no
 * daemon; these two call sites ARE the schedule.
 */
export async function opportunisticSnapshot(dbPath?: string): Promise<SnapshotResult> {
	try {
		if (!canUseDashboardDb()) {
			return { status: "skipped", reason: "node:sqlite unavailable on this runtime" };
		}
		const config = await loadConfig();
		const { result, instanceId } = await withDashboardDb(
			async (db) => ({
				result: await maybeSnapshot(db, {
					dbPath: dbPath ?? getDashboardDbPath(),
					nowMs: Date.now(),
					config,
				}),
				instanceId: ensureInstanceId(db),
			}),
			dbPath ? { dbPath } : {},
		);
		// Stamp the identity witness into the registry (idempotent) — the
		// deletion detector's judgment for an ABSENT database is id matching,
		// and the witness must be in place BEFORE any incident. Only on the
		// machine-default database: a test/temp dbPath must not claim the
		// machine-global registry.
		if (!dbPath) {
			await stampRegistryInstanceId(instanceId);
			await stampMirrorInstanceIds(instanceId, config);
		}
		return result;
	} catch (err) {
		// Same rule as maybeSnapshot's own catch, one layer further out: the
		// open itself can fail (locked, downgraded schema) and the caller is
		// on a path that must not break.
		const reason = errMsg(err);
		log.warn("opportunistic snapshot failed: %s", reason);
		return { status: "failed", reason };
	}
}

/**
 * SAVE-time validation for `backupFolder` — the strict superset of the
 * engine's own checkFolder, run by every settings entry point before the
 * value is stored. Returns the rejection reason or null. Beyond the
 * KBPathResolver criteria (absolute, no `..` in the raw string) it refuses:
 * anywhere under `~/.jolli` (shared fate with the disaster), the live
 * database's own directory, anywhere inside a git worktree (`clean -xdf`
 * would take the snapshots), anywhere under the Memory Bank `localFolder`
 * (mirror pruning treats content there as artifacts), and a folder that
 * cannot be created or written.
 *
 * The writability probe CREATES the folder, and does so LAST — deliberately, on
 * both counts. It is the only way to answer "can I write here?" for a target
 * that does not exist yet, and running it after every rejecting rule means a
 * refused value never leaves a directory tree behind. Callers are save-time
 * paths (`configure --set`, the settings UI) that are about to store the value,
 * so creating it is the outcome they want; do not call this to preview or
 * lint a path the user is still typing.
 */
export async function validateBackupFolder(
	raw: string,
	opts: { readonly dbPath?: string; readonly localFolder?: string } = {},
): Promise<string | null> {
	if (!isValidLocalFolder(raw)) return "backupFolder must be an absolute path with no '..' segments";
	const { illegal } = checkFolder(raw, opts.dbPath ?? getDashboardDbPath());
	if (illegal) return illegal;
	const norm = resolve(raw);
	if (opts.localFolder && isInside(norm, resolve(opts.localFolder))) {
		return "backupFolder must not live inside the Memory Bank folder";
	}
	// Nearest existing ancestor decides the worktree question — the folder
	// itself may not exist yet.
	let probe = norm;
	while (!existsSync(probe)) {
		const parent = resolve(probe, "..");
		if (parent === probe) break;
		probe = parent;
	}
	const inTree = await execGit(["rev-parse", "--is-inside-work-tree"], probe);
	if (inTree.exitCode === 0 && inTree.stdout.trim() === "true") {
		return "backupFolder must not live inside a git worktree (git clean -xdf would delete the snapshots)";
	}
	try {
		mkdirSync(norm, { recursive: true });
		accessSync(norm, constants.W_OK);
	} catch (err) {
		return `backupFolder is not writable: ${errMsg(err)}`;
	}
	return null;
}

/** SAVE-time validation for `backupRetentionDays`: integer >= 1, no zero. */
export function validateBackupRetentionDays(value: number): string | null {
	if (!Number.isInteger(value) || value < 1) {
		return "backupRetentionDays must be an integer >= 1 (0 is refused — it reads as 'no backups')";
	}
	return null;
}

/**
 * Stamps the id into each EXISTING repo mirror's hidden layer — the second,
 * possibly-other-disk witness for the deletion detector. `peekKBPath` (never
 * `resolveKBPath`) and an existsSync gate keep this from claiming or creating
 * Memory Bank folders: a mirror that is not there is simply not a witness.
 * The file is CLI-only (the IntelliJ FolderStorageReader does not read it, so
 * no Kotlin lockstep applies). Never throws.
 */
export async function stampMirrorInstanceIds(instanceId: string, config: JolliMemoryConfig): Promise<void> {
	try {
		const registry = await readRepoRegistry();
		for (const repo of registry.repos) {
			const kbRoot = peekKBPath(repo.repoName, repo.remoteUrl ?? null, config.localFolder);
			const hidden = join(kbRoot, ".jolli");
			if (!existsSync(hidden)) continue;
			const path = join(hidden, "instance.json");
			const body = `${JSON.stringify({ instanceId }, null, "	")}
`;
			try {
				if (readFileSync(path, "utf8") === body) continue;
			} catch {
				// absent or unreadable — write it
			}
			writeFileSync(path, body, "utf8");
		}
	} catch (err) {
		log.warn("mirror instance-id stamp failed (non-fatal): %s", errMsg(err));
	}
}

/** The id recorded in any repo mirror, or null when no mirror carries one. */
export async function readMirrorInstanceId(config: JolliMemoryConfig): Promise<string | null> {
	try {
		const registry = await readRepoRegistry();
		for (const repo of registry.repos) {
			const path = join(
				peekKBPath(repo.repoName, repo.remoteUrl ?? null, config.localFolder),
				".jolli",
				"instance.json",
			);
			try {
				const parsed = JSON.parse(readFileSync(path, "utf8")) as { instanceId?: string };
				if (typeof parsed.instanceId === "string") return parsed.instanceId;
			} catch {
				// this mirror carries no witness; try the next
			}
		}
	} catch (err) {
		log.warn("mirror instance-id read failed: %s", errMsg(err));
	}
	return null;
}

/**
 * The doctor/status row for backup health — the plan's reporting table made
 * executable. An ILLEGAL stored folder is red (the cutover gate "1. 备份和恢复"
 * does not hold); a legal-but-unreachable one warns with the age of the last
 * success and escalates to red past seven days; sidecars-without-db is the
 * one file-combination alarm and is red regardless.
 */
export async function backupHealthCheck(
	nowMs: number,
	opts: { readonly dbPath?: string; readonly config?: JolliMemoryConfig } = {},
): Promise<{
	readonly status: "ok" | "warn" | "fail";
	readonly message: string;
	/**
	 * Whether taking a snapshot now would clear this row.
	 *
	 * Staleness is the one failure a command CAN fix by itself, and saying so
	 * here is what lets `doctor --fix` do it: a `fail` with no remedy makes
	 * `doctor` exit 1 on an otherwise healthy install (a week without a commit
	 * is enough) with nothing the user can run to change it. An invalid folder
	 * or an unreachable drive needs a human — a snapshot attempt would just
	 * fail again — so those stay unfixable.
	 */
	readonly fixable?: boolean;
}> {
	const config = opts.config ?? (await loadConfig());
	const dbPath = opts.dbPath ?? getDashboardDbPath();
	const folder = config.backupFolder ?? defaultBackupFolder();
	const { illegal } = checkFolder(folder, dbPath);
	if (illegal) return { status: "fail", message: `backupFolder invalid: ${illegal}` };

	let lastMs = Number.NaN;
	if (canUseDashboardDb() && statSyncSafe(dbPath)) {
		try {
			const { DatabaseSync } = await import("node:sqlite");
			const db = new DatabaseSync(dbPath, { readOnly: true }) as unknown as DashboardDbHandle;
			try {
				const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'last-snapshot-at'").get() as
					| { value: string }
					| undefined;
				if (row) lastMs = Number(row.value);
			} finally {
				db.close();
			}
		} catch (err) {
			log.warn("backup health: could not read last-snapshot-at: %s", errMsg(err));
		}
	}
	const ageDays = (nowMs - lastMs) / DAY_MS;
	// Escalation needs a PAST SUCCESS to measure from: "never snapshotted" is
	// the state every fresh install passes through on its way to the first
	// trigger, so it warns rather than fails.
	const stale = Number.isFinite(lastMs) && ageDays > 7;
	const ageText = Number.isFinite(lastMs) ? `${Math.floor(ageDays)} day(s) ago` : "never";
	if (!statSyncSafe(folder)) {
		// Legal but unreachable is a legitimate state (unplugged drive) — warn,
		// escalating once the staleness passes a week.
		return {
			status: stale ? "fail" : "warn",
			message: `backup folder ${folder} unreachable; last successful snapshot: ${ageText}`,
		};
	}
	if (stale) return { status: "fail", message: `last successful snapshot: ${ageText} (over 7 days)`, fixable: true };
	if (!Number.isFinite(lastMs)) return { status: "warn", message: "no snapshot taken yet" };
	return { status: "ok", message: `last snapshot ${ageText} into ${folder}` };
}

function statSyncSafe(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

/** Name check used by recovery listings — exported for doctor --recover. */
export function isOwnSnapshotName(name: string): boolean {
	return SNAPSHOT_RE.test(name) || PREMIGRATION_RE.test(name);
}

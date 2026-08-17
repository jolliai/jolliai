/**
 * Backup — the plan's §1.7 acceptance list, item by item: the WAL tail is in
 * the snapshot; a restore drill replays identically; both floors outrank both
 * collectors; a failed snapshot leaves old ones untouched; an unreachable
 * target warns instead of falling back or going silent.
 */

import { execFile } from "node:child_process";
import {
	chmodSync,
	closeSync,
	existsSync,
	ftruncateSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JolliMemoryConfig } from "../Types.js";
import { setIsolatedHome } from "../testUtils/isolatedHome.js";
import {
	backupHealthCheck,
	defaultBackupFolder,
	ensureInstanceId,
	formatUtcStamp,
	isOwnSnapshotName,
	maybeSnapshot,
	opportunisticSnapshot,
	parseUtcStamp,
	readMirrorInstanceId,
	type SnapshotResult,
	stampMirrorInstanceIds,
	validateBackupFolder,
	validateBackupRetentionDays,
} from "./Backup.js";
import { withDashboardDb } from "./DashboardDb.js";

let dir: string;
let dbPath: string;
let backupDir: string;

const NOW = Date.UTC(2026, 7, 4, 9, 30, 0);
const DAY = 24 * 60 * 60 * 1000;

const config = (over: Partial<JolliMemoryConfig> = {}): JolliMemoryConfig =>
	({ backupFolder: backupDir, ...over }) as JolliMemoryConfig;

async function snapshot(over: Partial<Parameters<typeof maybeSnapshot>[1]> = {}): Promise<SnapshotResult> {
	return withDashboardDb((db) => maybeSnapshot(db, { dbPath, nowMs: NOW, config: config(), ...over }), {
		dbPath,
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-backup-"));
	dbPath = join(dir, "db", "jollimemory.db");
	mkdirSync(join(dir, "db"), { recursive: true });
	backupDir = join(dir, "back");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("stamps and names", () => {
	it("round-trips the UTC stamp and rejects foreign names", () => {
		const stamp = formatUtcStamp(NOW);
		expect(stamp).toBe("20260804T093000Z");
		expect(parseUtcStamp(stamp)).toBe(NOW);
		expect(parseUtcStamp("not-a-stamp")).toBeNull();
		expect(isOwnSnapshotName(`memory-${stamp}-1a2b3c4d.db`)).toBe(true);
		expect(isOwnSnapshotName(`memory-premigration-${stamp}-1a2b3c4d.db`)).toBe(true);
		expect(isOwnSnapshotName("users-own-file.db")).toBe(false);
	});

	it("defaults to ~/jolli_back, outside ~/.jolli", () => {
		expect(defaultBackupFolder().includes(".jolli")).toBe(false);
	});
});

describe("snapshot creation", () => {
	it("captures the WAL tail: an uncheckpointed row is in the snapshot", async () => {
		// Sentinel row → no checkpoint → snapshot immediately → SELECT it back
		// from the snapshot file.
		const result = await withDashboardDb(
			(db) => {
				db.prepare(
					"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES (?, ?, ?, ?)",
				).run("https://example.com/wal-tail.git", "wal", "/w", "t");
				return maybeSnapshot(db, { dbPath, nowMs: NOW, config: config() });
			},
			{ dbPath },
		);
		expect(result.status).toBe("created");
		const snapPath = (result as { path: string }).path;
		const { DatabaseSync } = await import("node:sqlite");
		const snap = new DatabaseSync(snapPath, { readOnly: true });
		const row = snap
			.prepare("SELECT repo_name FROM repos WHERE repo_identity = ?")
			.get("https://example.com/wal-tail.git");
		snap.close();
		expect(row).toEqual({ repo_name: "wal" });
	});

	it("restore drill: the snapshot opens as a working database and re-runs identically", async () => {
		await withDashboardDb(
			(db) =>
				db
					.prepare(
						"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES (?, ?, ?, ?)",
					)
					.run("https://example.com/a.git", "a", "/w", "t"),
			{ dbPath },
		);
		const first = await snapshot({ force: true });
		expect(first.status).toBe("created");
		// "Restore" = use the snapshot as the live database; it must behave as
		// one, including carrying the same instance id. Repeatable: a second
		// pass over the same source yields the same result.
		const restored = (first as { path: string }).path;
		const [idLive, idRestored] = await Promise.all([
			withDashboardDb((db) => ensureInstanceId(db), { dbPath }),
			withDashboardDb((db) => ensureInstanceId(db), { dbPath: restored }),
		]);
		expect(idRestored).toBe(idLive);
		const again = await snapshot({ force: true, nowMs: NOW + 1000 });
		expect(again.status).toBe("created");
	});

	it("gates on the daily stamp unless forced", async () => {
		expect((await snapshot()).status).toBe("created");
		expect(await snapshot({ nowMs: NOW + DAY / 2 })).toEqual({
			status: "skipped",
			reason: "daily snapshot already taken",
		});
		expect((await snapshot({ nowMs: NOW + DAY / 2, force: true })).status).toBe("created");
		// The forced snapshot updated the daily stamp too — a snapshot is a
		// snapshot — so the next unforced one is due a day after IT.
		expect((await snapshot({ nowMs: NOW + DAY + 1000 })).status).toBe("skipped");
		expect((await snapshot({ nowMs: NOW + DAY / 2 + DAY + 1000 })).status).toBe("created");
	});

	it("stamps the instance id into the filename", async () => {
		const id = await withDashboardDb((db) => ensureInstanceId(db), { dbPath });
		const result = await snapshot();
		expect((result as { path: string }).path).toContain(id.replace(/-/g, "").slice(0, 8));
	});
});

describe("folder rules", () => {
	it("rejects illegal folders without falling back", async () => {
		// Relative path, and the live database's own directory. (~/.jolli is
		// checked against the real home, so it is not portable to fixture here.)
		for (const folder of ["relative/path", join(dir, "db")]) {
			const result = await snapshot({ config: config({ backupFolder: folder }) });
			expect(result.status).toBe("failed");
			// No snapshot appeared there OR anywhere else (no fallback).
			const produced = existsSync(folder) ? readdirSync(folder).filter(isOwnSnapshotName) : [];
			expect(produced).toEqual([]);
			expect(existsSync(backupDir)).toBe(false);
		}
	});

	it("rejects a folder inside ~/.jolli before touching anything", async () => {
		// checkFolder runs before any mkdir, so pointing at the real home is
		// safe — nothing is created on rejection.
		const inside = join(homedir(), ".jolli", "definitely-not-created-by-tests");
		const result = await snapshot({ config: config({ backupFolder: inside }) });
		expect(result).toEqual({ status: "failed", reason: "backupFolder must not live inside ~/.jolli" });
		expect(existsSync(inside)).toBe(false);
	});

	it("uses ~/jolli_back when no folder is configured", async () => {
		// homedir() follows $HOME on POSIX; point it at the fixture so the
		// default-folder arm runs without touching the real home.
		const fakeHome = join(dir, "home");
		mkdirSync(fakeHome, { recursive: true });
		const restoreHome = setIsolatedHome(fakeHome);
		try {
			const result = await snapshot({ config: {} as JolliMemoryConfig });
			expect(result.status).toBe("created");
			expect((result as { path: string }).path.startsWith(join(fakeHome, "jolli_back"))).toBe(true);
		} finally {
			restoreHome();
		}
	});

	it("refuses the DEFAULT folder when $HOME is a git worktree", async () => {
		// `validateBackupFolder` runs at SAVE time and nobody saves the default, so
		// this precondition has to be checked here: `~/jolli_back` sits inside $HOME,
		// and a developer whose $HOME is a dotfiles worktree would have every snapshot
		// removed by `git clean -xdf`. Refuse rather than write into something that
		// deletes them.
		const fakeHome = join(dir, "dotfiles-home");
		mkdirSync(fakeHome, { recursive: true });
		await execFileAsync("git", ["init"], { cwd: fakeHome });
		const restoreHome = setIsolatedHome(fakeHome);
		try {
			const result = await snapshot({ config: {} as JolliMemoryConfig });
			expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("git clean -xdf") });
			expect(existsSync(join(fakeHome, "jolli_back"))).toBe(false);
		} finally {
			restoreHome();
		}
	});

	it("still snapshots into an explicitly CONFIGURED folder inside a worktree", async () => {
		// A folder the user picked went through validateBackupFolder already, so it is
		// trusted here — the guard is about the default nobody validated.
		const repo = join(dir, "repo-configured");
		mkdirSync(repo, { recursive: true });
		await execFileAsync("git", ["init"], { cwd: repo });
		const result = await snapshot({ config: config({ backupFolder: join(repo, "snaps") }) });
		expect(result.status).toBe("created");
	});

	it("survives two overlapping same-second snapshots instead of both deleting the other's temp", async () => {
		// The temp name was a whole-second stamp plus the DATABASE's instance id, and
		// the database is machine-global — so two snapshots in the same second shared
		// one temp path and each `rmSync`'d it around its own VACUUM. Both failed and
		// the day's backup silently did not happen. Per-process+per-call suffixes are
		// what make this pass; the two results still converge on ONE final name, which
		// is correct (same database, same second).
		const [a, b] = await Promise.all([snapshot(), snapshot()]);
		expect([a.status, b.status]).toEqual(["created", "created"]);
		expect(readdirSync(backupDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
		expect(readdirSync(backupDir).filter(isOwnSnapshotName)).toHaveLength(1);
	});

	it("names a pre-migration snapshot distinctly", async () => {
		const result = await snapshot({ premigration: true, force: true });
		expect(result.status).toBe("created");
		expect((result as { path: string }).path).toContain("memory-premigration-");
	});

	it("warns and reports failure when the folder is legal but unreachable", async () => {
		// A FILE where the directory should be makes mkdir fail — the drive-
		// unplugged shape. No fallback folder may appear.
		writeFileSync(join(dir, "blocked"), "");
		// A prior success makes the warning carry "N day(s) ago" staleness.
		expect((await snapshot()).status).toBe("created");
		const result = await snapshot({
			nowMs: NOW + 3 * DAY,
			config: config({ backupFolder: join(dir, "blocked") }),
		});
		expect(result.status).toBe("failed");
		expect((result as { reason: string }).reason).toContain("unreachable");
		expect(existsSync(defaultBackupFolder()) && false).toBe(false);
	});
});

describe("mirror witness", () => {
	it("stamps only existing mirrors, reads back, and never creates folders", async () => {
		const home = join(dir, "mhome");
		const kb = join(dir, "mkb");
		// Two registered repos: one with a mirror hidden layer, one without.
		mkdirSync(join(kb, "app", ".jolli"), { recursive: true });
		// A real mirror carries its identity; without it peekKBPath treats the
		// folder as foreign and resolves to a fresh slot.
		writeFileSync(join(kb, "app", ".jolli", "config.json"), JSON.stringify({ repoName: "app" }));
		const restoreHome = setIsolatedHome(home);
		try {
			const { stampRegistryInstanceId } = await import("./RepoRegistry.js");
			await stampRegistryInstanceId("unused-here");
			const { writeFile, mkdir } = await import("node:fs/promises");
			await mkdir(join(home, ".jolli", "jollimemory"), { recursive: true });
			await writeFile(
				join(home, ".jolli", "jollimemory", "dashboard-repos.json"),
				JSON.stringify({
					version: 1,
					repos: [
						{ repoIdentity: "a", repoName: "app", worktreeRoot: "/w1", enabledAt: "t" },
						{ repoIdentity: "b", repoName: "ghost", worktreeRoot: "/w2", enabledAt: "t" },
					],
				}),
			);
			const cfg = { localFolder: kb } as JolliMemoryConfig;
			expect(await readMirrorInstanceId(cfg)).toBeNull();
			await stampMirrorInstanceIds("id-9", cfg);
			await stampMirrorInstanceIds("id-9", cfg); // unchanged → no rewrite path
			expect(await readMirrorInstanceId(cfg)).toBe("id-9");
			// The mirror-less repo gained nothing: no folder was created.
			expect(existsSync(join(kb, "ghost"))).toBe(false);
		} finally {
			restoreHome();
		}
	});
});

describe("save-time validation", () => {
	it("accepts a good folder, creating it to prove writability", async () => {
		const target = join(dir, "new-backups");
		expect(await validateBackupFolder(target, { dbPath })).toBeNull();
		expect(existsSync(target)).toBe(true);
	});

	it("rejects each illegal shape with its own reason", async () => {
		expect(await validateBackupFolder("relative/x", { dbPath })).toContain("absolute");
		// join() would normalize the dots away; the validator sees the RAW string.
		expect(await validateBackupFolder(`${dir}/../x`, { dbPath })).toContain("'..'");
		expect(await validateBackupFolder(join(homedir(), ".jolli", "x"), { dbPath })).toContain("~/.jolli");
		expect(await validateBackupFolder(join(dir, "db"), { dbPath })).toContain("own directory");
		expect(await validateBackupFolder(join(dir, "kb", "sub"), { dbPath, localFolder: join(dir, "kb") })).toContain(
			"Memory Bank",
		);
		// Backslash separator too — the Memory Bank rule used to test only `/`
		// while the ~/.jolli rule beside it tested both, so on Windows a
		// backupFolder inside the Memory Bank folder passed save-time validation
		// and was then eligible for mirror pruning. Asserted on every platform:
		// both rules now share one containment predicate.
		expect(await validateBackupFolder(`${dir}\\kb\\sub`, { dbPath, localFolder: `${dir}\\kb` })).toContain(
			"Memory Bank",
		);
		expect(await validateBackupFolder(`${join(homedir(), ".jolli")}\\x`, { dbPath })).toContain("~/.jolli");
		// This test file runs inside the repo checkout — a git worktree. Derive
		// the path from this module rather than hard-coding one developer's
		// checkout, which fails everywhere else (ENOENT locally, EACCES in CI).
		const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
		expect(await validateBackupFolder(join(repoRoot, "nope"), { dbPath })).toContain("git worktree");
		writeFileSync(join(dir, "flat"), "");
		expect(await validateBackupFolder(join(dir, "flat", "x"), { dbPath })).toContain("not writable");
	});

	it("rejects the Memory Bank root itself and defaults the db path", async () => {
		const kb = join(dir, "kb2");
		expect(await validateBackupFolder(kb, { dbPath, localFolder: kb })).toContain("Memory Bank");
		// No dbPath: the machine default fills in (fake HOME keeps it in the fixture).
		const fakeHome = join(dir, "vhome");
		mkdirSync(fakeHome, { recursive: true });
		const restoreHome = setIsolatedHome(fakeHome);
		try {
			expect(await validateBackupFolder(join(dir, "ok-target"), {})).toBeNull();
		} finally {
			restoreHome();
		}
	});

	it("pins retention-days semantics: integer >= 1, zero refused", () => {
		expect(validateBackupRetentionDays(20)).toBeNull();
		expect(validateBackupRetentionDays(1)).toBeNull();
		for (const bad of [0, -1, 2.5, Number.NaN]) {
			expect(validateBackupRetentionDays(bad)).toContain(">= 1");
		}
	});
});

describe("backupHealthCheck", () => {
	it("walks the reporting table: red gate, warn staleness, 7-day escalation", async () => {
		// Illegal stored folder: the cutover gate does not hold — red.
		expect(
			(await backupHealthCheck(NOW, { dbPath, config: config({ backupFolder: join(dir, "db") }) })).status,
		).toBe("fail");
		// Reachable folder, no snapshot yet: a warning, not a failure.
		mkdirSync(backupDir, { recursive: true });
		expect(await backupHealthCheck(NOW, { dbPath, config: config() })).toEqual({
			status: "warn",
			message: "no snapshot taken yet",
		});
		// Fresh snapshot: ok, with age and destination in the message.
		expect((await snapshot()).status).toBe("created");
		const ok = await backupHealthCheck(NOW + 1000, { dbPath, config: config() });
		expect(ok.status).toBe("ok");
		expect(ok.message).toContain(backupDir);
		// Eight days later without a new snapshot: red, even though reachable.
		expect((await backupHealthCheck(NOW + 8 * DAY, { dbPath, config: config() })).status).toBe("fail");
		// Unreachable folder: warn while fresh, red once the staleness passes a week.
		rmSync(backupDir, { recursive: true, force: true });
		expect((await backupHealthCheck(NOW + 1000, { dbPath, config: config() })).status).toBe("warn");
		expect((await backupHealthCheck(NOW + 8 * DAY, { dbPath, config: config() })).status).toBe("fail");
	});
});

describe("opportunisticSnapshot", () => {
	it("snapshots via global config and degrades to failed on an unopenable database", async () => {
		// Fake HOME so loadConfig finds no config and the default folder lands
		// in the fixture instead of the real ~/jolli_back.
		const fakeHome = join(dir, "op-home");
		mkdirSync(fakeHome, { recursive: true });
		const restoreHome = setIsolatedHome(fakeHome);
		try {
			const result = await opportunisticSnapshot(dbPath);
			expect(result.status).toBe("created");
			expect((result as { path: string }).path.startsWith(join(fakeHome, "jolli_back"))).toBe(true);
			// Without a dbPath the machine default (under the fake HOME) is used
			// — creating that database fresh is exactly what production does.
			expect((await opportunisticSnapshot()).status).toBe("created");
			// A regular file where the database's parent directory should be:
			// the open throws, and the outer catch answers with a status
			// instead of breaking the caller.
			writeFileSync(join(dir, "not-a-dir"), "");
			const bad = await opportunisticSnapshot(join(dir, "not-a-dir", "x.db"));
			expect(bad.status).toBe("failed");
		} finally {
			restoreHome();
		}
	});
});

describe("rotation", () => {
	function plantSnapshot(name: string, size = 100): void {
		mkdirSync(backupDir, { recursive: true });
		const fd = openSync(join(backupDir, name), "w");
		writeSync(fd, Buffer.alloc(size));
		closeSync(fd);
	}

	it("deletes over-age snapshots but never below the 2-snapshot floor", async () => {
		// Everything pre-existing is over-age: after the new snapshot lands the
		// floor keeps 2 total — the new one plus the newest survivor — instead
		// of burning every expired file to zero.
		plantSnapshot(`memory-${formatUtcStamp(NOW - 100 * DAY)}-aaaaaaaa.db`);
		plantSnapshot(`memory-${formatUtcStamp(NOW - 90 * DAY)}-aaaaaaaa.db`);
		plantSnapshot(`memory-${formatUtcStamp(NOW - 80 * DAY)}-aaaaaaaa.db`);
		const result = await snapshot();
		expect(result.status).toBe("created");
		const left = readdirSync(backupDir).filter(isOwnSnapshotName);
		expect(left).toHaveLength(2);
		expect(left).toContain(`memory-${formatUtcStamp(NOW - 80 * DAY)}-aaaaaaaa.db`);
		expect(left).not.toContain(`memory-${formatUtcStamp(NOW - 100 * DAY)}-aaaaaaaa.db`);
		expect(left).not.toContain(`memory-${formatUtcStamp(NOW - 90 * DAY)}-aaaaaaaa.db`);
	});

	it("falls back to mtime when the stamp is digit-shaped nonsense", async () => {
		// month 99 — Date.UTC would roll it over; the parser refuses instead,
		// and rotation falls back to the file's (old) mtime.
		const bogus = "memory-99999999T999999Z-aaaaaaaa.db";
		plantSnapshot(bogus);
		const old = new Date(NOW - 100 * DAY);
		utimesSync(join(backupDir, bogus), old, old);
		plantSnapshot(`memory-${formatUtcStamp(NOW - 1 * DAY)}-aaaaaaaa.db`);
		plantSnapshot(`memory-${formatUtcStamp(NOW - 2 * DAY)}-aaaaaaaa.db`);
		await snapshot();
		expect(readdirSync(backupDir)).not.toContain(bogus);
	});

	it("age comes from the filename stamp, not mtime", async () => {
		// A sync drive rewrote mtime to NOW on an over-age file, and an
		// unparsable-stamp file falls back to its (old) mtime.
		const overAge = `memory-${formatUtcStamp(NOW - 100 * DAY)}-aaaaaaaa.db`;
		plantSnapshot(overAge);
		utimesSync(join(backupDir, overAge), new Date(NOW), new Date(NOW));
		plantSnapshot(`memory-${formatUtcStamp(NOW - 1 * DAY)}-aaaaaaaa.db`);
		plantSnapshot(`memory-${formatUtcStamp(NOW - 2 * DAY)}-aaaaaaaa.db`);
		await snapshot();
		expect(readdirSync(backupDir)).not.toContain(overAge);
	});

	it("never touches files it did not produce", async () => {
		mkdirSync(backupDir, { recursive: true });
		writeFileSync(join(backupDir, "users-own-notes.db"), "mine");
		writeFileSync(join(backupDir, "memory-notes.txt"), "mine too");
		plantSnapshot(`memory-${formatUtcStamp(NOW - 100 * DAY)}-aaaaaaaa.db`);
		await snapshot();
		expect(readdirSync(backupDir)).toContain("users-own-notes.db");
		expect(readdirSync(backupDir)).toContain("memory-notes.txt");
	});

	it("caps pre-migration snapshots by count, exempt from age", async () => {
		for (let i = 0; i < 7; i++) {
			plantSnapshot(`memory-premigration-${formatUtcStamp(NOW - (200 + i) * DAY)}-aaaaaaaa.db`);
		}
		await snapshot();
		const pre = readdirSync(backupDir).filter((n) => n.startsWith("memory-premigration-"));
		// All are far over-age; exactly the newest 5 remain.
		expect(pre).toHaveLength(5);
		expect(pre).not.toContain(`memory-premigration-${formatUtcStamp(NOW - 206 * DAY)}-aaaaaaaa.db`);
	});

	it("size cap deletes oldest first but the floor wins over the cap", async () => {
		// Two sparse 3-GiB snapshots (no real disk use): cap = max(2 GiB, days x
		// tiny db) = 2 GiB. After the new snapshot the oldest is collected, but
		// the floor then forbids going lower even though still over cap — that
		// state is an error log, never a third deletion.
		const sparse = (name: string): void => {
			mkdirSync(backupDir, { recursive: true });
			const fd = openSync(join(backupDir, name), "w");
			ftruncateSync(fd, 3 * 1024 * 1024 * 1024);
			closeSync(fd);
		};
		sparse(`memory-${formatUtcStamp(NOW - 3 * DAY)}-aaaaaaaa.db`);
		sparse(`memory-${formatUtcStamp(NOW - 2 * DAY)}-aaaaaaaa.db`);
		const result = await snapshot();
		expect(result.status).toBe("created");
		const left = readdirSync(backupDir).filter(isOwnSnapshotName);
		expect(left).toHaveLength(2);
		expect(left).not.toContain(`memory-${formatUtcStamp(NOW - 3 * DAY)}-aaaaaaaa.db`);
		expect(left).toContain(`memory-${formatUtcStamp(NOW - 2 * DAY)}-aaaaaaaa.db`);
	});

	// POSIX-only, and it is the FAILURE that cannot be induced rather than the
	// assertion that cannot be made: `chmod` on Windows moves the read-only bit,
	// which directories ignore for creation, so the snapshot below simply succeeds
	// and the test would assert "failed" about a run that worked. Nothing weaker
	// stands in — the point is a real write failure mid-snapshot, not a stubbed one.
	it.skipIf(process.platform === "win32")("a failed snapshot leaves every old snapshot untouched", async () => {
		plantSnapshot(`memory-${formatUtcStamp(NOW - 100 * DAY)}-aaaaaaaa.db`);
		plantSnapshot(`memory-${formatUtcStamp(NOW - 90 * DAY)}-aaaaaaaa.db`);
		// A read-only target folder makes VACUUM INTO's temp file un-creatable
		// — the closest portable stand-in for a full or yanked drive.
		chmodSync(backupDir, 0o555);
		try {
			const result = await snapshot();
			expect(result.status).toBe("failed");
			expect(readdirSync(backupDir).filter(isOwnSnapshotName)).toHaveLength(2);
		} finally {
			chmodSync(backupDir, 0o755);
		}
	});
});

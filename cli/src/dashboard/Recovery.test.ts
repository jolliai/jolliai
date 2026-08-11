/**
 * Recovery — enumeration finds snapshots wherever they were carried (identity
 * rides in the filename), and step ① restore is refuse-by-default, verified,
 * sidecar-clearing, and re-runnable.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JolliMemoryConfig } from "../Types.js";
import { setIsolatedHome } from "../testUtils/isolatedHome.js";
import { formatUtcStamp, maybeSnapshot } from "./Backup.js";
import { withDashboardDb } from "./DashboardDb.js";
import { fillMemoriesFromMirrors, restoreFromSnapshot, surveyRecovery } from "./Recovery.js";

let dir: string;
let dbPath: string;
let backupDir: string;
const NOW = Date.UTC(2026, 7, 4, 12, 0, 0);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-recover-"));
	dbPath = join(dir, "db", "jollimemory.db");
	mkdirSync(join(dir, "db"), { recursive: true });
	backupDir = join(dir, "back");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A function, not a module-level const: backupDir is assigned in beforeEach,
// and capturing it early would silently fall to the REAL default folder.
const cfg = (): JolliMemoryConfig => ({ backupFolder: backupDir }) as JolliMemoryConfig;

async function makeRealSnapshot(): Promise<string> {
	const result = await withDashboardDb(
		(db) => {
			db.prepare(
				"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES (?, ?, ?, ?)",
			).run("https://example.com/r.git", "r", "/w", "t");
			return maybeSnapshot(db, { dbPath, nowMs: NOW, config: cfg(), force: true });
		},
		{ dbPath },
	);
	if (result.status !== "created") throw new Error(`fixture snapshot ${result.status}`);
	return result.path;
}

describe("surveyRecovery", () => {
	it("lists candidates newest-first from configured and --from folders, with identity columns", async () => {
		await makeRealSnapshot();
		const extra = join(dir, "usb-stick");
		mkdirSync(extra, { recursive: true });
		writeFileSync(join(extra, `memory-${formatUtcStamp(NOW - 1000)}-99999999.db`), "carried");
		writeFileSync(join(extra, "unrelated.db"), "ignored");
		// One with a digit-shaped-nonsense stamp: listed, age unknown, sorted last.
		writeFileSync(join(extra, "memory-99999999T999999Z-bbbbbbbb.db"), "odd");
		const survey = await surveyRecovery({ dbPath, extraFolder: extra, config: cfg() });
		expect(survey.fileState.startsWith("healthy")).toBe(true);
		expect(survey.candidates).toHaveLength(3);
		expect(survey.candidates[0].path).toContain(backupDir);
		expect(survey.candidates[1].id8).toBe("99999999");
		expect(survey.candidates[2]).toMatchObject({ takenAtMs: 0, id8: "bbbbbbbb" });
		expect(survey.foldersScanned).toContain(extra);
		// backup-folder-last-used (stamped by the snapshot) joins the scan set.
		expect(survey.foldersScanned).toContain(backupDir);
	});

	it("survives an unopenable database when reading the last-used folder", async () => {
		writeFileSync(dbPath, "not a database");
		const survey = await surveyRecovery({ dbPath, config: cfg() });
		expect(survey.fileState).toBe("healthy-clean");
		expect(survey.candidates).toEqual([]);
	});

	it("classifies an absent database via the identity table", async () => {
		// Fake HOME: the registry/mirror witnesses must come from the fixture,
		// not whatever the real machine has stamped.
		const fakeHome = join(dir, "home");
		mkdirSync(fakeHome, { recursive: true });
		const restoreHome = setIsolatedHome(fakeHome);
		let survey: Awaited<ReturnType<typeof surveyRecovery>>;
		try {
			// No configured backupFolder first: the default under HOME is scanned.
			const bare = await surveyRecovery({ dbPath, config: {} as JolliMemoryConfig });
			expect(bare.candidates).toEqual([]);
			survey = await surveyRecovery({ dbPath, config: cfg() });
		} finally {
			restoreHome();
		}
		expect(survey.fileState).toBe("absent");
		// No registry/mirror stamps in this fixture: a fresh install.
		expect(survey.identity).toBe("fresh-install");
		expect(survey.candidates).toEqual([]);
	});
});

describe("fillMemoriesFromMirrors", () => {
	it("upserts mirror memories into the database without touching other rows", async () => {
		// A registry with one repo whose mirror hidden layer holds one summary.
		const home = join(dir, "home");
		const kb = join(dir, "kb");
		const hidden = join(kb, "app", ".jolli");
		mkdirSync(join(hidden, "summaries"), { recursive: true });
		writeFileSync(join(hidden, "config.json"), JSON.stringify({ repoName: "app" }));
		const hash = "a".repeat(40);
		writeFileSync(
			join(hidden, "summaries", `${hash}.json`),
			JSON.stringify(
				{
					version: "5",
					commitHash: hash,
					commitMessage: "from mirror",
					commitDate: "2026-07-01T00:00:00.000Z",
					branch: "main",
					commitType: "commit",
					topics: [],
					children: [],
				},
				null,
				"\t",
			),
		);
		const restoreHome = setIsolatedHome(home);
		try {
			const { mkdir, writeFile } = await import("node:fs/promises");
			await mkdir(join(home, ".jolli", "jollimemory"), { recursive: true });
			await writeFile(
				join(home, ".jolli", "jollimemory", "dashboard-repos.json"),
				JSON.stringify({
					version: 1,
					repos: [{ repoIdentity: "https://x/app.git", repoName: "app", worktreeRoot: "/w", enabledAt: "t" }],
				}),
			);
			// Pre-existing unrelated row that a gap-fill must not disturb.
			await withDashboardDb(
				(db) =>
					db
						.prepare(
							"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES (?, ?, ?, ?)",
						)
						.run("https://x/other.git", "other", "/o", "t"),
				{ dbPath },
			);
			// Once without dbPath: the machine default resolves under the fake
			// HOME, covering the default-path arm without touching real state.
			await fillMemoriesFromMirrors({ config: { localFolder: kb } as JolliMemoryConfig });
			const filled = await fillMemoriesFromMirrors({ dbPath, config: { localFolder: kb } as JolliMemoryConfig });
			expect(filled).toMatchObject({ repos: 1, nodes: 1 });
			// Re-run converges (catch-up never deletes, upsert is idempotent).
			const again = await fillMemoriesFromMirrors({ dbPath, config: { localFolder: kb } as JolliMemoryConfig });
			expect(again.nodes).toBe(1);
			const rows = await withDashboardDb(
				(db) => db.prepare("SELECT commit_message FROM memories").all() as { commit_message: string }[],
				{ dbPath },
			);
			expect(rows).toEqual([{ commit_message: "from mirror" }]);
			const repos = await withDashboardDb(
				(db) => (db.prepare("SELECT COUNT(*) AS n FROM repos").get() as { n: number }).n,
				{ dbPath },
			);
			expect(repos).toBe(2);
		} finally {
			restoreHome();
		}
	});
});

describe("fillMemoriesFromFrozenOrphans", () => {
	it("imports only fenced repos' frozen branches, catch-up, re-runnable", async () => {
		const { execSync } = await import("node:child_process");
		const { writeCutoverFence } = await import("../core/RepoProfile.js");
		const { fillMemoriesFromFrozenOrphans } = await import("./Recovery.js");
		const home = join(dir, "fhome");
		mkdirSync(join(home, ".jolli", "jollimemory"), { recursive: true });
		const repoDir = join(dir, "frepo");
		mkdirSync(repoDir, { recursive: true });
		execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: repoDir });
		execSync("git commit -q --allow-empty -m init", { cwd: repoDir });
		const { OrphanBranchStorage } = await import("../core/OrphanBranchStorage.js");
		const storage = new OrphanBranchStorage(repoDir);
		await storage.ensure();
		await storage.writeFiles(
			[
				{
					path: `summaries/${"f".repeat(40)}.json`,
					content: JSON.stringify(
						{
							version: "5",
							commitHash: "f".repeat(40),
							commitMessage: "frozen memory",
							commitDate: "2026-07-01T00:00:00.000Z",
							branch: "main",
							commitType: "commit",
							topics: [],
							children: [],
						},
						null,
						"\t",
					),
				},
			],
			"add",
		);
		const restoreHome = setIsolatedHome(home);
		try {
			const { registerRepo } = await import("./RepoRegistry.js");
			await registerRepo({ cwd: repoDir, now: () => new Date(0) });
			// Not fenced yet: step ③ must not touch a live orphan.
			expect(await fillMemoriesFromFrozenOrphans({ dbPath })).toMatchObject({ repos: 0 });
			// A fenced repo WITHOUT an orphan branch is skipped, not an error.
			const bare = join(dir, "bare-fenced");
			mkdirSync(bare, { recursive: true });
			execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: bare });
			execSync("git commit -q --allow-empty -m init", { cwd: bare });
			await registerRepo({ cwd: bare, now: () => new Date(1) });
			await writeCutoverFence(bare, { reason: "cutover", at: "t" });
			expect(await fillMemoriesFromFrozenOrphans({ dbPath })).toMatchObject({ repos: 0 });
			await writeCutoverFence(repoDir, { reason: "cutover", at: "t" });
			const filled = await fillMemoriesFromFrozenOrphans({ dbPath, nowMs: 5 });
			expect(filled).toMatchObject({ repos: 1, nodes: 1 });
			// Re-run converges.
			expect((await fillMemoriesFromFrozenOrphans({ dbPath, nowMs: 6 })).nodes).toBe(1);
			const rows = await withDashboardDb(
				(db) => db.prepare("SELECT commit_message FROM memories").all() as { commit_message: string }[],
				{ dbPath },
			);
			expect(rows).toEqual([{ commit_message: "frozen memory" }]);
		} finally {
			restoreHome();
		}
	});

	it("counts a repo whose frozen branch cannot be imported as skipped, not as a failed pass", async () => {
		// This is the LAST resort in the recovery order, so one unreadable frozen
		// branch must not abandon recovery for every repo that still has a good
		// one — the same rule fillMemoriesFromMirrors already states.
		const { execSync } = await import("node:child_process");
		const { writeCutoverFence } = await import("../core/RepoProfile.js");
		const home = join(dir, "thome");
		mkdirSync(join(home, ".jolli", "jollimemory"), { recursive: true });
		const repoDir = join(dir, "trepo");
		mkdirSync(repoDir, { recursive: true });
		execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: repoDir });
		execSync("git commit -q --allow-empty -m init", { cwd: repoDir });
		const { OrphanBranchStorage } = await import("../core/OrphanBranchStorage.js");
		await new OrphanBranchStorage(repoDir).ensure();
		const restoreHome = setIsolatedHome(home);
		try {
			const { registerRepo } = await import("./RepoRegistry.js");
			await registerRepo({ cwd: repoDir, now: () => new Date(0) });
			await writeCutoverFence(repoDir, { reason: "cutover", at: "t" });
			vi.resetModules();
			vi.doMock("./SotImport.js", () => ({
				importRepoMemory: () => {
					throw new Error("frozen tree unreadable");
				},
			}));
			const { fillMemoriesFromFrozenOrphans } = await import("./Recovery.js");
			// Returns a tally instead of propagating.
			expect(await fillMemoriesFromFrozenOrphans({ dbPath })).toEqual({ repos: 0, nodes: 0, skipped: 1 });
		} finally {
			vi.doUnmock("./SotImport.js");
			vi.resetModules();
			restoreHome();
		}
	});
});

describe("restoreFromSnapshot", () => {
	it("refuses a healthy database without force, restores with it, and is re-runnable", async () => {
		const snap = await makeRealSnapshot();
		expect(await restoreFromSnapshot(snap, { dbPath })).toEqual({
			status: "refused",
			reason: expect.stringContaining("healthy database exists"),
		});
		expect((await restoreFromSnapshot(snap, { dbPath, force: true })).status).toBe("restored");
		// Absent database: no force needed; a second run converges.
		rmSync(dbPath, { force: true });
		writeFileSync(`${dbPath}-wal`, "stale wal of the dead database");
		expect((await restoreFromSnapshot(snap, { dbPath })).status).toBe("restored");
		expect((await restoreFromSnapshot(snap, { dbPath, force: true })).status).toBe("restored");
		// The dead database's sidecars are gone — nothing to replay over the
		// restored file — and the result opens as a working database.
		expect(existsSync(`${dbPath}-wal`)).toBe(false);
		const repos = await withDashboardDb(
			(db) => db.prepare("SELECT repo_name FROM repos").all() as { repo_name: string }[],
			{ dbPath },
		);
		expect(repos).toEqual([{ repo_name: "r" }]);
	});

	it("sweeps a dead run's restore temp but leaves a live one alone", async () => {
		// The temp name carries a PID + nonce so two overlapping recoveries cannot
		// rename each other's half-copied file over the live database. The cost of
		// that uniqueness is that nothing overwrites the previous run's leftover any
		// more: a restore killed between the copy and the rename (no throw, so no
		// catch) used to leave a database-sized file behind forever.
		const snap = await makeRealSnapshot();
		const folder = dirname(dbPath);
		const dead = join(folder, `.${basename(dbPath)}.restore-999999999-deadbeef.tmp`);
		const live = join(folder, `.${basename(dbPath)}.restore-${process.pid}-cafebabe.tmp`);
		const unrelated = join(folder, "notes.tmp");
		for (const p of [dead, live, unrelated]) writeFileSync(p, "leftover");

		expect((await restoreFromSnapshot(snap, { dbPath, force: true })).status).toBe("restored");

		expect(existsSync(dead)).toBe(false);
		// Another restore in flight — the whole reason the PID is in the name.
		expect(existsSync(live)).toBe(true);
		expect(existsSync(unrelated)).toBe(true);
	});

	it("sweeps an ancient temp even when its PID reads as alive (PID reuse)", async () => {
		// A leftover only exists because its writer DIED, so its PID is free to be
		// reused — and once it is, the PID gate says "alive" about an unrelated
		// process and the file would be skipped forever. Age is the second half of
		// the pair: this one carries THIS process's pid (maximally alive) and an
		// mtime two hours back.
		const snap = await makeRealSnapshot();
		const folder = dirname(dbPath);
		const ancient = join(folder, `.${basename(dbPath)}.restore-${process.pid}-0ldbeef0.tmp`);
		writeFileSync(ancient, "leftover");
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
		utimesSync(ancient, twoHoursAgo, twoHoursAgo);

		expect((await restoreFromSnapshot(snap, { dbPath, force: true })).status).toBe("restored");

		expect(existsSync(ancient)).toBe(false);
	});

	it("never restores from a corrupt snapshot and reports missing files", async () => {
		const fake = join(backupDir, `memory-${formatUtcStamp(NOW)}-aaaaaaaa.db`);
		mkdirSync(backupDir, { recursive: true });
		writeFileSync(fake, "not a database");
		const result = await restoreFromSnapshot(fake, { dbPath });
		expect(result.status).toBe("failed");
		expect((result as { reason: string }).reason).toContain("integrity_check");
		expect((await restoreFromSnapshot(join(dir, "gone.db"), { dbPath })).status).toBe("failed");
		// A directory is not a snapshot either.
		expect(await restoreFromSnapshot(backupDir, { dbPath })).toEqual({
			status: "failed",
			reason: "snapshot is not a file",
		});
	});
});

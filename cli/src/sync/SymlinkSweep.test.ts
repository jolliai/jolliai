/**
 * Tests for the §P2 symlink sweep. Run against a real on-disk fixture
 * because the whole point is to validate `lstat` / `readdir` / `rename`
 * behaviour against the filesystem — mocking those would defeat the
 * exercise.
 *
 * Skips: Windows symlink creation requires admin or Developer Mode. The
 * Windows CI runner deliberately doesn't enable either, so we guard the
 * suite on platform and let CI run it on Linux/macOS only — that
 * coverage still exercises every code path the production engine takes.
 */

import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QUARANTINE_SYMLINKS_DIR, sweepSymlinks } from "./SymlinkSweep.js";

const skipOnWindows = platform() === "win32";

let rootTempDir: string;
let vault: string;

beforeAll(async () => {
	rootTempDir = await mkdtemp(join(tmpdir(), "symlinksweep-"));
});

afterAll(async () => {
	await rm(rootTempDir, { recursive: true, force: true });
});

beforeEach(async () => {
	vault = await mkdtemp(join(rootTempDir, "vault-"));
});

describe.skipIf(skipOnWindows)("sweepSymlinks", () => {
	it("quarantines a symlink at the top of a repo subfolder into the single vault-root quarantine dir", async () => {
		const repo = join(vault, "myrepo");
		await mkdir(repo, { recursive: true });
		await writeFile("/tmp/sym-target.txt", "secret\n");
		await symlink("/tmp/sym-target.txt", join(repo, "leak.md"));

		const report = await sweepSymlinks(vault);
		expect(report.quarantined).toBe(1);
		expect(report.failed).toBe(0);
		expect(report.paths).toEqual([join("myrepo", "leak.md")]);

		// File is gone from where git add --all would have picked it up.
		expect(await readdir(repo)).not.toContain("leak.md");
		// Lands in the SINGLE vault-root quarantine dir (not per-repo).
		// The filename encodes the original path so users can audit.
		const quarantineEntries = await readdir(join(vault, QUARANTINE_SYMLINKS_DIR));
		expect(quarantineEntries).toContain("myrepo-leak.md");
	});

	it("quarantines nested symlinks beneath a repo's content directories", async () => {
		const notesDir = join(vault, "myrepo", "notes");
		await mkdir(notesDir, { recursive: true });
		await writeFile(join(notesDir, "real.md"), "ok\n");
		await symlink("/etc/hostname", join(notesDir, "fake.md"));

		const report = await sweepSymlinks(vault);
		expect(report.quarantined).toBe(1);
		expect(report.paths).toEqual([join("myrepo", "notes", "fake.md")]);

		// Real file untouched.
		expect(await readdir(notesDir)).toEqual(["real.md"]);
		expect(await readFile(join(notesDir, "real.md"), "utf-8")).toBe("ok\n");
	});

	it("does NOT follow a symlinked directory (refuses to descend into the target)", async () => {
		// Threat model: hostile process replaces a sub-folder with a symlink
		// to `/etc`. The sweep must record the symlink itself, NOT walk into
		// `/etc` and start renaming files out of it.
		const repo = join(vault, "myrepo");
		await mkdir(repo, { recursive: true });
		await symlink("/etc", join(repo, "tainted-dir"));

		const report = await sweepSymlinks(vault);
		expect(report.quarantined).toBe(1);
		expect(report.paths).toEqual([join("myrepo", "tainted-dir")]);
		// Critical: no /etc entries appear in the report.
		for (const p of report.paths) {
			expect(p.startsWith("myrepo")).toBe(true);
		}
	});

	it("does NOT traverse a hostile <repo>/.jolli symlink during quarantine (path-traversal defence)", async () => {
		// The pre-revision implementation routed each symlink to
		// `<repo>/.jolli/quarantine-symlinks/` and `mkdir(...recursive)`
		// would FOLLOW a `<repo>/.jolli -> /etc` symlink, creating the
		// quarantine folder inside `/etc/`. This test pins the fix: the
		// engine must NEVER create the quarantine dir outside the vault.
		const repo = join(vault, "myrepo");
		await mkdir(repo, { recursive: true });
		// Point `.jolli` outside the vault. With the old code, the next
		// quarantine attempt would write under this target.
		const outsideDir = await mkdtemp(join(rootTempDir, "outside-"));
		await symlink(outsideDir, join(repo, ".jolli"));
		// Drop a symlink the engine will try to quarantine.
		await symlink("/tmp/leak", join(repo, "leak.md"));

		const report = await sweepSymlinks(vault);
		// Both the hostile `.jolli` symlink AND the loose `leak.md` are
		// detected. Each one is renamed into the vault-root quarantine
		// dir — the `.jolli` link target is never followed for either
		// mkdir or rename.
		expect(report.quarantined).toBe(2);
		const quarantined = await readdir(join(vault, QUARANTINE_SYMLINKS_DIR));
		expect(quarantined).toEqual(expect.arrayContaining(["myrepo-leak.md", "myrepo-.jolli"]));
		// `outsideDir` must have nothing inside it — no quarantine-symlinks
		// folder created, no leak.md moved there.
		expect(await readdir(outsideDir)).toEqual([]);
	});

	it("replaces a hostile pre-placed quarantine-dir symlink with a real directory", async () => {
		// Attacker pre-creates `<vault>/.jolli-quarantine-symlinks` as a
		// symlink to some external target so the engine's later mkdir +
		// rename would land files there. The engine must detect this via
		// lstat and unlink before use.
		const outsideTarget = await mkdtemp(join(rootTempDir, "hostile-"));
		await symlink(outsideTarget, join(vault, QUARANTINE_SYMLINKS_DIR));
		await symlink("/tmp/anything", join(vault, "loose.md"));

		const report = await sweepSymlinks(vault);
		expect(report.quarantined).toBe(1);
		// The hostile symlink got replaced with a real directory.
		const q = await lstat(join(vault, QUARANTINE_SYMLINKS_DIR));
		expect(q.isSymbolicLink()).toBe(false);
		expect(q.isDirectory()).toBe(true);
		// Nothing landed in the outside target.
		expect(await readdir(outsideTarget)).toEqual([]);
	});

	it("refuses to sweep when the quarantine path exists as a regular file (won't clobber)", async () => {
		// Edge case: `.jolli-quarantine-symlinks` already exists as a
		// regular file. We don't know its origin so we refuse rather
		// than delete + replace. The symlinks stay (failed count != 0)
		// and the engine logs the situation.
		await writeFile(join(vault, QUARANTINE_SYMLINKS_DIR), "user data we shouldn't clobber");
		await symlink("/tmp/x", join(vault, "leak.md"));

		const report = await sweepSymlinks(vault);
		expect(report.quarantined).toBe(0);
		expect(report.failed).toBe(1);
		// File still in place untouched.
		expect(await readFile(join(vault, QUARANTINE_SYMLINKS_DIR), "utf-8")).toBe("user data we shouldn't clobber");
	});

	it("skips .git/ entirely (git's own symlinks are not our business)", async () => {
		const gitDir = join(vault, "myrepo", ".git");
		await mkdir(gitDir, { recursive: true });
		await symlink("/tmp/should-be-skipped", join(gitDir, "HEAD"));

		const report = await sweepSymlinks(vault);
		expect(report.quarantined).toBe(0);
		expect(report.paths).toEqual([]);
	});

	it("skips its own quarantine directory on subsequent rounds (idempotent)", async () => {
		const repo = join(vault, "myrepo");
		await mkdir(repo, { recursive: true });
		await symlink("/tmp/round1", join(repo, "first.md"));

		const first = await sweepSymlinks(vault);
		expect(first.quarantined).toBe(1);

		// Second round: the quarantine dir now contains the moved symlink,
		// but the sweep must NOT re-process it (would cause an infinite
		// quarantine-of-quarantine loop and bump file count each round).
		const second = await sweepSymlinks(vault);
		expect(second.quarantined).toBe(0);
		expect(second.paths).toEqual([]);
	});

	it("skips legacy .jolli/quarantine-symlinks and quarantine-summaries dirs too", async () => {
		// Pre-revision sweep used `<repo>/.jolli/quarantine-symlinks/`,
		// and `MemoryBankBootstrap` still uses `.jolli/quarantine-summaries/`.
		// Both must remain untouched by the new sweep so older quarantine
		// output doesn't get re-walked.
		const legacyLinks = join(vault, "myrepo", ".jolli", "quarantine-symlinks");
		const legacySummaries = join(vault, "myrepo", ".jolli", "quarantine-summaries");
		await mkdir(legacyLinks, { recursive: true });
		await mkdir(legacySummaries, { recursive: true });
		await symlink("/tmp/old-link", join(legacyLinks, "old.md"));
		await symlink("/tmp/old-summary", join(legacySummaries, "weird.md"));

		const report = await sweepSymlinks(vault);
		expect(report.quarantined).toBe(0);
	});

	it("returns a zero-count report when there are no symlinks", async () => {
		await mkdir(join(vault, "myrepo", "notes"), { recursive: true });
		await writeFile(join(vault, "myrepo", "notes", "regular.md"), "x\n");

		const report = await sweepSymlinks(vault);
		expect(report.quarantined).toBe(0);
		expect(report.failed).toBe(0);
		expect(report.paths).toEqual([]);
	});

	it("handles a vault root that doesn't exist by returning an empty report", async () => {
		const missing = join(vault, "does-not-exist");
		const report = await sweepSymlinks(missing);
		expect(report.quarantined).toBe(0);
		expect(report.failed).toBe(0);
	});

	it("counts a rename failure as `failed` and keeps going (POSIX cross-type rename collision)", async () => {
		// Force the per-symlink `rename` (line 117) to throw by pre-creating
		// the destination path as a NON-EMPTY DIRECTORY. POSIX rename refuses
		// to overwrite a non-empty directory with a regular link, so the
		// rename throws EEXIST/ENOTEMPTY → the per-symlink catch at line 125
		// fires, `failed` increments, and the sweep proceeds.
		await symlink("/tmp/anything", join(vault, "leak.md"));
		// The sweep targets `<quarantineDir>/leak.md`. Pre-create that path
		// as a non-empty directory so the rename refuses.
		const clashDir = join(vault, QUARANTINE_SYMLINKS_DIR, "leak.md");
		await mkdir(clashDir, { recursive: true });
		await writeFile(join(clashDir, "occupant.txt"), "block the rename\n");

		const report = await sweepSymlinks(vault);
		expect(report.failed).toBeGreaterThanOrEqual(1);
		expect(report.quarantined).toBe(0);
		// The symlink stays in place because the rename never succeeded.
		const stillThere = await lstat(join(vault, "leak.md"));
		expect(stillThere.isSymbolicLink()).toBe(true);
	});

	it("ignores non-file/non-dir/non-symlink Dirent entries (e.g. fifos) via lstat fallback", async () => {
		// `Dirent.isSymbolicLink()` short-circuits the lstat path on tmpfs.
		// To exercise the fallback (lines 217-222), we drop a named pipe
		// (FIFO) into the vault. Its Dirent reports isFile=false, isDir=false,
		// isSymbolicLink=false → we must lstat it. lstat says it's NOT a
		// symlink either, so the sweep ignores it and moves on.
		const { spawnSync } = await import("node:child_process");
		const fifoPath = join(vault, "myrepo", "named.pipe");
		await mkdir(join(vault, "myrepo"), { recursive: true });
		const mkfifo = spawnSync("mkfifo", [fifoPath]);
		// Skip on platforms where mkfifo isn't available (Windows is already
		// skipped by the outer describe.skipIf).
		if (mkfifo.status !== 0) return;

		// Add a legit symlink alongside so the sweep has something to do.
		await symlink("/tmp/legit", join(vault, "myrepo", "leak.md"));

		const report = await sweepSymlinks(vault);
		expect(report.quarantined).toBe(1);
		// The FIFO is left in place — it's not a symlink, just an unusual
		// Dirent type. The sweep doesn't touch it.
		const stillThere = await lstat(fifoPath);
		expect(stillThere.isFIFO()).toBe(true);
	});

	it("routes top-level (no-repo-segment) symlinks into the same vault-root quarantine", async () => {
		// Symlink at the vault root (no repo segment). Lands in the same
		// single quarantine dir as nested links — there's only one in
		// the revised design.
		await symlink("/tmp/top-level", join(vault, "loose.md"));

		const report = await sweepSymlinks(vault);
		expect(report.quarantined).toBe(1);

		const qEntries = await readdir(join(vault, QUARANTINE_SYMLINKS_DIR));
		expect(qEntries).toContain("loose.md");
	});
});

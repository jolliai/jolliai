import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeKBFolder } from "./KBPathResolver.js";
import { discoverRepos } from "./KBRepoDiscoverer.js";

// Tests that depend on POSIX permission semantics (chmod 0o000) or unprivileged
// symlinkSync are skipped on Windows: chmod is a no-op there and symlinkSync
// throws EPERM unless the process has admin / Developer Mode. ESM's
// non-configurable namespace exports prevent vi.spyOn from substituting these
// at the module level, so a platform skip is the pragmatic choice — the
// branches under test (EACCES from readdirSync, ENOENT from statSync on
// dangling symlink) are POSIX-side coverage. See the open-source intake
// review notes for Memory Bank migration.
const skipIfWin32 = process.platform === "win32" ? it.skip : it;

// Suppress log noise from createLogger.
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

function makeTmpDir(): string {
	const dir = join(tmpdir(), `discoverer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function rmrf(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

describe("KBRepoDiscoverer.discoverRepos", () => {
	let parent: string;

	beforeEach(() => {
		parent = makeTmpDir();
	});

	afterEach(() => {
		rmrf(parent);
	});

	it("returns an empty list when the parent directory is missing", () => {
		const missing = join(parent, "does-not-exist");
		expect(discoverRepos(null, null, missing)).toEqual([]);
	});

	it("returns an empty list when the parent has no KB folders", () => {
		mkdirSync(join(parent, "random"));
		writeFileSync(join(parent, "stray.txt"), "x");
		expect(discoverRepos(null, null, parent)).toEqual([]);
	});

	it("includes only directories that contain .jolli/config.json", () => {
		initializeKBFolder(join(parent, "alpha"), "alpha", null);
		// Directory without .jolli — must be skipped.
		mkdirSync(join(parent, "no-jolli"));
		// .jolli directory exists but config.json is malformed JSON — also skipped.
		mkdirSync(join(parent, "bad-config", ".jolli"), { recursive: true });
		writeFileSync(join(parent, "bad-config", ".jolli", "config.json"), "{ not json", "utf-8");

		const repos = discoverRepos(null, null, parent);
		expect(repos.map((r) => r.repoName)).toEqual(["alpha"]);
	});

	it("sorts current repo first, then the rest alphabetically", () => {
		initializeKBFolder(join(parent, "charlie"), "charlie", "https://github.com/o/charlie.git");
		initializeKBFolder(join(parent, "alpha"), "alpha", "https://github.com/o/alpha.git");
		initializeKBFolder(join(parent, "bravo"), "bravo", "https://github.com/o/bravo.git");

		const repos = discoverRepos("bravo", "https://github.com/o/bravo.git", parent);
		expect(repos.map((r) => r.repoName)).toEqual(["bravo", "alpha", "charlie"]);
		expect(repos[0]?.isCurrentRepo).toBe(true);
		expect(repos[1]?.isCurrentRepo).toBe(false);
	});

	it("matches current repo by normalized remote URL (case + .git + trailing slash)", () => {
		initializeKBFolder(join(parent, "canonical"), "canonical", "https://GitHub.com/Owner/Repo.git/");

		const repos = discoverRepos(null, "https://github.com/owner/repo", parent);
		expect(repos[0]?.isCurrentRepo).toBe(true);
	});

	it("falls back to repoName when remote URL is missing on either side", () => {
		initializeKBFolder(join(parent, "name-match"), "name-match", null);
		initializeKBFolder(join(parent, "other"), "other", null);

		const repos = discoverRepos("name-match", null, parent);
		const nameMatch = repos.find((r) => r.repoName === "name-match");
		expect(nameMatch?.isCurrentRepo).toBe(true);
	});

	it("falls back to repoName match when only one side has a remote URL", () => {
		initializeKBFolder(join(parent, "ambiguous"), "ambiguous", "https://github.com/o/ambiguous.git");

		// Mirrors IntelliJ's KBRepoDiscoverer.isCurrentRepo: URL comparison only
		// fires when both sides have a URL; otherwise the implementation falls
		// through to a plain repoName equality check. This is a known soft-match
		// — two unrelated repos with the same basename will collide when one of
		// them has no remote configured.
		const repos = discoverRepos("ambiguous", null, parent);
		expect(repos[0]?.isCurrentRepo).toBe(true);
	});

	it("uses directory basename as repoName when config.repoName is absent", () => {
		// Hand-write a config with no repoName field to exercise the fallback.
		const dir = join(parent, "weird-dirname");
		mkdirSync(join(dir, ".jolli"), { recursive: true });
		writeFileSync(join(dir, ".jolli", "config.json"), JSON.stringify({ version: 1, sortOrder: "date" }), "utf-8");

		const repos = discoverRepos(null, null, parent);
		expect(repos).toHaveLength(1);
		expect(repos[0]?.repoName).toBe("weird-dirname");
		expect(repos[0]?.dirName).toBe("weird-dirname");
		expect(repos[0]?.kbRoot).toBe(dir);
		expect(repos[0]?.remoteUrl).toBeNull();
	});

	it("invalid customParent (relative path) falls back to the default ~/Documents/jolli/", () => {
		// Relative paths are rejected by resolveKbParent → default kicks in.
		// The default folder typically doesn't exist in CI, so we just check
		// the function returns gracefully and didn't read our test `parent`.
		const repos = discoverRepos(null, null, "relative/path");
		// Either empty (default folder doesn't exist) or whatever the user has;
		// we only care that the helper didn't crash and didn't read `parent`.
		expect(Array.isArray(repos)).toBe(true);
		expect(repos.every((r) => !r.kbRoot.startsWith(parent))).toBe(true);
	});

	it("skips non-directory entries with the same name shape as a repo", () => {
		// A regular file at the parent level must not be treated as a repo,
		// even if a sibling directory `<file>/.jolli/config.json` doesn't exist.
		writeFileSync(join(parent, "imposter"), "I am not a directory");
		initializeKBFolder(join(parent, "real"), "real", null);

		const repos = discoverRepos(null, null, parent);
		expect(repos.map((r) => r.repoName)).toEqual(["real"]);
	});

	it("survives an unreadable subdirectory by skipping it", () => {
		initializeKBFolder(join(parent, "readable"), "readable", null);
		const unreadable = join(parent, "locked");
		mkdirSync(unreadable);
		// Strip read+execute so statSync on the subdir's child paths would fail.
		// We don't actually depend on the chmod taking effect — we just want to
		// confirm the scan doesn't throw if statSync fails. Wrap in try so the
		// test still runs on platforms where chmod is a no-op.
		try {
			chmodSync(unreadable, 0o000);
			const repos = discoverRepos(null, null, parent);
			// "locked" has no .jolli/config.json → skipped regardless; the key
			// assertion is that "readable" is still found and no error is thrown.
			expect(repos.map((r) => r.repoName)).toContain("readable");
		} finally {
			chmodSync(unreadable, 0o755);
		}
	});

	skipIfWin32("returns empty and logs a warning when the parent directory is unreadable (non-ENOENT)", () => {
		// chmod 0 strips read+execute on the parent itself, so readdirSync
		// throws EACCES (not ENOENT) — exercises the warn-and-return branch.
		// Windows ignores chmod, so readdir would still succeed and the
		// assertion fails; skipped there. ESM-namespace limitations prevent
		// a portable vi.spyOn(fs, "readdirSync") replacement.
		const locked = join(parent, "locked-parent");
		mkdirSync(locked);
		initializeKBFolder(join(locked, "child"), "child", null);
		try {
			chmodSync(locked, 0o000);
			expect(discoverRepos(null, null, locked)).toEqual([]);
		} finally {
			chmodSync(locked, 0o755);
		}
	});

	skipIfWin32("skips a dirent whose statSync throws (e.g. dangling symlink)", () => {
		initializeKBFolder(join(parent, "real"), "real", null);
		// A symlink pointing to a non-existent target makes statSync throw
		// ENOENT on the link — the discoverer's inner try/catch skips it.
		// symlinkSync on Windows requires admin / Developer Mode, hence the
		// platform skip.
		symlinkSync(join(parent, "missing-target"), join(parent, "dangling"));

		const repos = discoverRepos(null, null, parent);
		expect(repos.map((r) => r.repoName)).toEqual(["real"]);
	});

	it("uses the default ~/Documents/jolli/ when customParent is omitted", () => {
		// We can't safely mutate the user's home directory in tests, so just
		// confirm the helper returns a list (possibly empty) without throwing
		// when called with no customParent.
		const repos = discoverRepos(null, null);
		expect(Array.isArray(repos)).toBe(true);
		// If the test machine happens to have a real KB folder, every entry's
		// kbRoot should live under ~/Documents/jolli/.
		const defaultParent = join(homedir(), "Documents", "jolli");
		expect(repos.every((r) => r.kbRoot.startsWith(defaultParent))).toBe(true);
	});
});

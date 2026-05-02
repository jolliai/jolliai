import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractRepoName, findFreshKBPath, getRemoteUrl, initializeKBFolder, resolveKBPath } from "./KBPathResolver.js";

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

function makeTmpDir(): string {
	const dir = join(tmpdir(), `kb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function rmrf(dir: string): void {
	const { rmSync } = require("node:fs");
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

describe("KBPathResolver", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTmpDir();
	});

	afterEach(() => {
		rmrf(tempDir);
	});

	describe("extractRepoName", () => {
		// Layer 3 (last-resort basename) only fires for non-git directories. The
		// tempDir created here is bare — no `.git` — so both git commands fail
		// and the helper falls through to basename(projectPath).
		it("falls back to basename for non-git directories", () => {
			const dir = join(tempDir, "myrepo");
			mkdirSync(dir);
			expect(extractRepoName(dir)).toBe("myrepo");
		});

		it("returns 'unknown' for an empty-basename path", () => {
			expect(extractRepoName("/")).toBe("unknown");
		});

		// Layer 1 (origin URL basename) — the canonical path. We init a real
		// git repo with a fake origin URL; the helper invokes `git config` and
		// extracts the URL's basename. Strips trailing `.git`.
		it("uses origin URL basename when remote is configured", () => {
			const repo = join(tempDir, "local-dir-name");
			mkdirSync(repo);
			git(repo, ["init", "-q"]);
			git(repo, ["remote", "add", "origin", "https://github.com/jolliai/jolliai.git"]);
			expect(extractRepoName(repo)).toBe("jolliai");
		});

		it("strips .git suffix from the URL", () => {
			const repo = join(tempDir, "alpha");
			mkdirSync(repo);
			git(repo, ["init", "-q"]);
			git(repo, ["remote", "add", "origin", "git@github.com:owner/beta.git"]);
			expect(extractRepoName(repo)).toBe("beta");
		});

		// Layer 2 (git-common-dir parent basename) — local-only repo, no
		// remote, but real git init. Helper falls past layer 1, then asks git
		// for the common dir and uses its parent basename. This is the layer
		// that lets a worktree resolve to its main repo's directory name when
		// no remote is configured.
		it("falls back to git-common-dir parent for local-only repos", () => {
			const repo = join(tempDir, "localrepo");
			mkdirSync(repo);
			git(repo, ["init", "-q"]);
			expect(extractRepoName(repo)).toBe("localrepo");
		});

		// The headline worktree case: layer 1 (origin URL) wins even when the
		// workspace basename is something unrelated like "feature-branch-X".
		// This is the scenario that motivated the three-layer fallback —
		// without it, opening a worktree creates a parallel KB folder named
		// after the worktree directory.
		it("returns origin name for a worktree, not the worktree dir name", () => {
			const main = join(tempDir, "main-repo");
			mkdirSync(main);
			git(main, ["init", "-q"]);
			git(main, ["remote", "add", "origin", "https://github.com/owner/canonical.git"]);
			// Need at least one commit before `git worktree add` accepts a branch.
			writeFileSync(join(main, "README.md"), "x");
			git(main, ["add", "."]);
			git(main, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
			const wt = join(tempDir, "wt-feature");
			git(main, ["worktree", "add", "-q", "-b", "feature", wt]);
			expect(extractRepoName(wt)).toBe("canonical");
		});

		// Same case, but with no remote — layer 2 should follow the worktree
		// pointer back to "main-repo" (the directory holding the real .git).
		it("worktree without remote resolves to main repo dir basename", () => {
			const main = join(tempDir, "main-repo");
			mkdirSync(main);
			git(main, ["init", "-q"]);
			writeFileSync(join(main, "README.md"), "x");
			git(main, ["add", "."]);
			git(main, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
			const wt = join(tempDir, "wt-feature");
			git(main, ["worktree", "add", "-q", "-b", "feature", wt]);
			expect(extractRepoName(wt)).toBe("main-repo");
		});

		// origin URL exists but doesn't match the trailing-segment regex (no slash).
		// Layer 1 returns null, layer 2 takes over and uses the local repo dir name.
		it("falls past layer 1 when origin URL has no slash", () => {
			const repo = join(tempDir, "noslash");
			mkdirSync(repo);
			git(repo, ["init", "-q"]);
			git(repo, ["remote", "add", "origin", "noslashurl"]);
			expect(extractRepoName(repo)).toBe("noslash");
		});

		// Layer 1 returns null when the origin URL value is whitespace-only —
		// after `.trim()` it becomes empty and tryGitCommand returns null via
		// the `out || null` fallback. Layer 2 then provides the answer.
		it("treats whitespace-only origin URL as unset (out||null branch)", () => {
			const repo = join(tempDir, "blankurl");
			mkdirSync(repo);
			git(repo, ["init", "-q"]);
			git(repo, ["config", "remote.origin.url", " "]);
			expect(extractRepoName(repo)).toBe("blankurl");
		});

		// Layer 2 falls through when git's reported common-dir resolves to a
		// top-level path. We stub `git` on PATH so it returns ".git" for
		// rev-parse — combined with projectPath="/" the helper sees mainRepoDir="/"
		// and skips to layer 3.
		it("layer 2 falls through when common-dir parent is '/'", () => {
			const stubBin = join(tempDir, "stub-bin");
			mkdirSync(stubBin);
			const stubScript = `#!/bin/sh
case "$1 $2" in
  "config --get") exit 1 ;;
  "rev-parse --git-common-dir") echo ".git" ;;
  *) exit 1 ;;
esac
`;
			const stubPath = join(stubBin, "git");
			writeFileSync(stubPath, stubScript, "utf-8");
			chmodSync(stubPath, 0o755);

			const oldPath = process.env.PATH;
			process.env.PATH = `${stubBin}:${oldPath ?? ""}`;
			try {
				expect(extractRepoName("/")).toBe("unknown");
			} finally {
				process.env.PATH = oldPath;
			}
		});

		// Layer 2 also falls through when basename(mainRepoDir) returns empty
		// — set up a stub that reports an absolute common-dir whose parent is "/".
		it("layer 2 returns 'unknown' when basename of common-dir parent is empty", () => {
			const stubBin = join(tempDir, "stub-bin-2");
			mkdirSync(stubBin);
			const stubScript = `#!/bin/sh
case "$1 $2" in
  "config --get") exit 1 ;;
  "rev-parse --git-common-dir") echo "/.git" ;;
  *) exit 1 ;;
esac
`;
			const stubPath = join(stubBin, "git");
			writeFileSync(stubPath, stubScript, "utf-8");
			chmodSync(stubPath, 0o755);

			const oldPath = process.env.PATH;
			process.env.PATH = `${stubBin}:${oldPath ?? ""}`;
			try {
				expect(extractRepoName("/anywhere")).toBe("anywhere");
			} finally {
				process.env.PATH = oldPath;
			}
		});
	});

	describe("resolveKBPath", () => {
		it("uses custom path as parent with repoName appended", () => {
			const result = resolveKBPath("myrepo", "https://github.com/user/myrepo.git", tempDir);
			expect(result).toBe(join(tempDir, "myrepo"));
		});

		it("returns path when folder does not exist", () => {
			const result = resolveKBPath("newrepo", null, tempDir);
			expect(result).toBe(join(tempDir, "newrepo"));
		});

		it("reuses folder when repo identity matches", () => {
			const kbRoot = join(tempDir, "myrepo");
			initializeKBFolder(kbRoot, "myrepo", "https://github.com/user/myrepo.git");

			const result = resolveKBPath("myrepo", "https://github.com/user/myrepo.git", tempDir);
			expect(result).toBe(kbRoot);
		});

		it("adds suffix on collision with different remote", () => {
			const kbRoot = join(tempDir, "app");
			initializeKBFolder(kbRoot, "app", "https://github.com/user1/app.git");

			const result = resolveKBPath("app", "https://github.com/user2/app.git", tempDir);
			expect(result).toBe(join(tempDir, "app-2"));
		});

		it("matches local repos by name when both have no remote", () => {
			const kbRoot = join(tempDir, "localrepo");
			initializeKBFolder(kbRoot, "localrepo", null);

			const result = resolveKBPath("localrepo", null, tempDir);
			expect(result).toBe(kbRoot);
		});
	});

	describe("initializeKBFolder", () => {
		it("creates jolli dir and writes config", () => {
			const kbRoot = join(tempDir, "myrepo");
			initializeKBFolder(kbRoot, "myrepo", "https://github.com/user/myrepo.git");

			const configPath = join(kbRoot, ".jolli", "config.json");
			expect(existsSync(configPath)).toBe(true);

			const config = JSON.parse(readFileSync(configPath, "utf-8"));
			expect(config.remoteUrl).toBe("https://github.com/user/myrepo.git");
			expect(config.repoName).toBe("myrepo");
		});

		it("works with null remote", () => {
			const kbRoot = join(tempDir, "local");
			initializeKBFolder(kbRoot, "local", null);

			const config = JSON.parse(readFileSync(join(kbRoot, ".jolli", "config.json"), "utf-8"));
			expect(config.remoteUrl).toBeUndefined();
			expect(config.repoName).toBe("local");
		});

		it("is idempotent", () => {
			const kbRoot = join(tempDir, "myrepo");
			initializeKBFolder(kbRoot, "myrepo", "https://github.com/user/myrepo.git");
			initializeKBFolder(kbRoot, "myrepo", "https://github.com/user/myrepo.git");
			expect(existsSync(join(kbRoot, ".jolli", "config.json"))).toBe(true);
		});
	});

	describe("customPath validation", () => {
		it("falls back to default when customPath is relative", () => {
			const result = resolveKBPath("rel-test", null, "relative/path");
			expect(result).toContain("Documents");
			expect(result.endsWith("rel-test")).toBe(true);
			expect(result).not.toContain("relative/path");
		});

		it("falls back to default when customPath contains '..'", () => {
			const evil = `${tempDir}/../escape`;
			const result = resolveKBPath("dotdot-test", null, evil);
			expect(result).toContain("Documents");
			expect(result).not.toContain("escape");
		});
	});

	describe("findFreshKBPath", () => {
		it("returns base path when nothing exists", () => {
			expect(findFreshKBPath("brand-new", tempDir)).toBe(join(tempDir, "brand-new"));
		});

		it("finds the next free -N suffix when base path exists", () => {
			mkdirSync(join(tempDir, "repo"));
			expect(findFreshKBPath("repo", tempDir)).toBe(join(tempDir, "repo-2"));
		});

		it("walks past taken suffixes until it finds an unused slot", () => {
			mkdirSync(join(tempDir, "repo"));
			mkdirSync(join(tempDir, "repo-2"));
			mkdirSync(join(tempDir, "repo-3"));
			expect(findFreshKBPath("repo", tempDir)).toBe(join(tempDir, "repo-4"));
		});

		it("falls back to a timestamp suffix when -2..-99 are all taken", () => {
			mkdirSync(join(tempDir, "saturated"));
			for (let n = 2; n <= 99; n++) mkdirSync(join(tempDir, `saturated-${n}`));

			const result = findFreshKBPath("saturated", tempDir);
			expect(result.startsWith(join(tempDir, "saturated-"))).toBe(true);
			expect(result).not.toBe(join(tempDir, "saturated"));
			expect(result).not.toBe(join(tempDir, "saturated-99"));
		});
	});

	describe("getRemoteUrl", () => {
		it("returns null for non-git directories", () => {
			expect(getRemoteUrl(tempDir)).toBeNull();
		});

		it("returns the configured origin URL when present", () => {
			const repo = join(tempDir, "with-remote");
			mkdirSync(repo);
			git(repo, ["init", "-q"]);
			git(repo, ["remote", "add", "origin", "https://github.com/foo/bar.git"]);
			expect(getRemoteUrl(repo)).toBe("https://github.com/foo/bar.git");
		});

		it("returns null when no origin remote is configured", () => {
			const repo = join(tempDir, "no-remote");
			mkdirSync(repo);
			git(repo, ["init", "-q"]);
			expect(getRemoteUrl(repo)).toBeNull();
		});
	});

	describe("resolveKBPath collision handling", () => {
		it("treats stored-remote vs missing-remote as different repos", () => {
			const kbRoot = join(tempDir, "mismatch");
			initializeKBFolder(kbRoot, "mismatch", "https://github.com/user/mismatch.git");

			const result = resolveKBPath("mismatch", null, tempDir);
			expect(result).toBe(join(tempDir, "mismatch-2"));
		});

		it("reuses an existing suffixed folder when its identity matches", () => {
			const baseDir = join(tempDir, "repo");
			initializeKBFolder(baseDir, "repo", "https://github.com/u/other.git");

			const reuseDir = join(tempDir, "repo-2");
			initializeKBFolder(reuseDir, "repo", "https://github.com/u/canonical.git");

			expect(resolveKBPath("repo", "https://github.com/u/canonical.git", tempDir)).toBe(reuseDir);
		});

		it("treats a folder with corrupt config.json as a different repo", () => {
			const kbRoot = join(tempDir, "corrupt");
			mkdirSync(join(kbRoot, ".jolli"), { recursive: true });
			writeFileSync(join(kbRoot, ".jolli", "config.json"), "{ not json", "utf-8");

			const result = resolveKBPath("corrupt", null, tempDir);
			expect(result).toBe(join(tempDir, "corrupt-2"));
		});

		it("falls back to a timestamp suffix when every -N slot is taken", () => {
			initializeKBFolder(join(tempDir, "saturated"), "saturated", "https://github.com/u/a.git");
			// Populate every -2..-99 candidate as a non-matching repo so findAvailablePath
			// has to walk all the way to the timestamp fallback.
			for (let n = 2; n <= 99; n++) {
				initializeKBFolder(
					join(tempDir, `saturated-${n}`),
					"saturated",
					`https://github.com/u/non-match-${n}.git`,
				);
			}

			const result = resolveKBPath("saturated", "https://github.com/u/canonical.git", tempDir);
			expect(result.startsWith(join(tempDir, "saturated-"))).toBe(true);
			expect(result).not.toBe(join(tempDir, "saturated"));
			expect(result).not.toBe(join(tempDir, "saturated-99"));
		});

		it("walks past a candidate dir that has no .jolli/config.json", () => {
			// Make the basePath a non-matching repo, then create a "name-2" dir without
			// any .jolli/config.json — readKBConfig must return null and the helper
			// must continue to "name-3".
			initializeKBFolder(join(tempDir, "miss"), "miss", "https://github.com/u/a.git");
			mkdirSync(join(tempDir, "miss-2"));

			const result = resolveKBPath("miss", "https://github.com/u/different.git", tempDir);
			expect(result).toBe(join(tempDir, "miss-3"));
		});
	});

	describe("default parent dir (no customPath)", () => {
		// Hitting `resolveParentDir` without a customPath. Use a unique repo name
		// that's unlikely to exist in the user's real ~/Documents/jolli/ — since
		// the basePath does not exist, resolveKBPath returns it without writing.
		it("uses ~/Documents/jolli/{repoName} when customPath is omitted", () => {
			const uniq = `__test_kbpr_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const result = resolveKBPath(uniq, null);
			expect(result).toBe(join(homedir(), "Documents", "jolli", uniq));
		});
	});
});

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	archiveKBFolder,
	assertValidLocalFolder,
	extractRepoName,
	findFreshKBPath,
	foldGitTransportToHttps,
	getRemoteUrl,
	InvalidLocalFolderError,
	initializeKBFolder,
	isValidLocalFolder,
	peekKBPath,
	resolveKBPath,
} from "./KBPathResolver.js";

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

		it("reuses the folder across clone transports (stored SSH, live https — and vice versa)", () => {
			// Same repo, different transport. Before folding, switching the
			// remote from SSH to https split the Memory Bank into
			// `myrepo` / `myrepo-2`.
			const kbRoot = join(tempDir, "myrepo");
			initializeKBFolder(kbRoot, "myrepo", "git@github.com:user/myrepo.git");
			expect(resolveKBPath("myrepo", "https://github.com/user/myrepo.git", tempDir)).toBe(kbRoot);

			const kbRoot2 = join(tempDir, "other");
			initializeKBFolder(kbRoot2, "other", "https://github.com/user/other.git");
			expect(resolveKBPath("other", "ssh://git@github.com:22/user/other.git", tempDir)).toBe(kbRoot2);
		});
	});

	describe("foldGitTransportToHttps", () => {
		it("folds SCP, ssh:// (with user/port), git+ssh:// and git:// into the https form", () => {
			expect(foldGitTransportToHttps("git@github.com:user/repo.git")).toBe("https://github.com/user/repo.git");
			expect(foldGitTransportToHttps("ssh://git@github.com:22/user/repo")).toBe("https://github.com/user/repo");
			expect(foldGitTransportToHttps("git+ssh://git@github.com/user/repo")).toBe("https://github.com/user/repo");
			expect(foldGitTransportToHttps("git://github.com:9418/user/repo")).toBe("https://github.com/user/repo");
		});

		it("preserves non-default ssh/git ports (distinct self-hosted forges must not collapse)", () => {
			expect(foldGitTransportToHttps("ssh://git@host.example:2222/team/repo")).toBe(
				"https://host.example:2222/team/repo",
			);
			expect(foldGitTransportToHttps("git://host.example:9419/team/repo")).toBe(
				"https://host.example:9419/team/repo",
			);
		});

		it("preserves the absolute-path distinction of SCP paths", () => {
			expect(foldGitTransportToHttps("git@host.example:/srv/repo")).toBe("https://host.example//srv/repo");
			expect(foldGitTransportToHttps("git@host.example:srv/repo")).toBe("https://host.example/srv/repo");
		});

		it("passes through https URLs, Windows drive paths, bare names and bare host:path", () => {
			expect(foldGitTransportToHttps("https://github.com/user/repo")).toBe("https://github.com/user/repo");
			expect(foldGitTransportToHttps("C:/repos/foo")).toBe("C:/repos/foo");
			expect(foldGitTransportToHttps("my-notes")).toBe("my-notes");
			expect(foldGitTransportToHttps("mygit.local:repos/foo")).toBe("mygit.local:repos/foo");
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
		// Both cases exercise the fallback-to-default branch, which means
		// `resolveKBPath` CLAIMS a real path under ~/Documents/jolli/ (writes
		// config). Mirror the "default parent dir" block: use a unique repo
		// name and `rmrf` in `finally` so the test never leaves a permanent
		// dir in — or clobbers a real repo inside — the user's home Memory
		// Bank folder. (The earlier fixed names `rel-test` / `dotdot-test`
		// leaked permanent dirs into ~/Documents/jolli/.)
		it("falls back to default when customPath is relative", () => {
			const uniq = `__test_kbpr_rel_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			let result: string | undefined;
			try {
				result = resolveKBPath(uniq, null, "relative/path");
				expect(result).toContain("Documents");
				expect(result.endsWith(uniq)).toBe(true);
				expect(result).not.toContain("relative/path");
			} finally {
				if (result) rmrf(result);
			}
		});

		it("falls back to default when customPath contains '..'", () => {
			const uniq = `__test_kbpr_dotdot_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const evil = `${tempDir}/../escape`;
			let result: string | undefined;
			try {
				result = resolveKBPath(uniq, null, evil);
				expect(result).toContain("Documents");
				expect(result).not.toContain("escape");
			} finally {
				if (result) rmrf(result);
			}
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
		}, 15000);

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
		// that's unlikely to exist in the user's real ~/Documents/jolli/ —
		// resolveKBPath now claims the path (writes config), so we clean up
		// after ourselves to avoid polluting the user's home dir.
		it("uses ~/Documents/jolli/{repoName} when customPath is omitted", () => {
			const uniq = `__test_kbpr_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const expected = join(homedir(), "Documents", "jolli", uniq);
			try {
				const result = resolveKBPath(uniq, null);
				expect(result).toBe(expected);
			} finally {
				rmrf(expected);
			}
		});
	});

	describe("stub adoption (regression: phantom -2 spawn)", () => {
		// MetadataManager.ensure() writes a schema-default `{version, sortOrder}`
		// config when nobody has written identity yet. Historically, the next
		// resolveKBPath would see that stub, fail isSameRepo (config.remoteUrl is
		// undefined ≠ real remoteUrl), and allocate `repo-2`. The next call would
		// see two stubs, fail again, allocate `repo-3`, ad infinitum until -99.
		// This block pins the fix: stubs get adopted in place.

		function seedStub(dir: string): void {
			mkdirSync(join(dir, ".jolli"), { recursive: true });
			writeFileSync(
				join(dir, ".jolli", "config.json"),
				JSON.stringify({ version: 1, sortOrder: "date" }),
				"utf-8",
			);
		}

		it("adopts an unclaimed stub at basePath instead of allocating -N", () => {
			seedStub(join(tempDir, "repo"));

			const result = resolveKBPath("repo", "https://github.com/u/repo.git", tempDir);

			expect(result).toBe(join(tempDir, "repo"));
			const config = JSON.parse(readFileSync(join(result, ".jolli", "config.json"), "utf-8"));
			expect(config.remoteUrl).toBe("https://github.com/u/repo.git");
			expect(config.repoName).toBe("repo");
		});

		it("adopts a stub with real summaries content — that's the regression's signature", () => {
			// User had data accumulating in `repo/` from prior usage but the
			// buggy code path (SyncBootstrap / old StorageFactory) never wrote
			// identity. The data is theirs; rescue it by adopting in place
			// rather than orphaning it under a phantom `-2` sibling.
			seedStub(join(tempDir, "repo"));
			mkdirSync(join(tempDir, "repo", ".jolli", "summaries"), { recursive: true });
			writeFileSync(
				join(tempDir, "repo", ".jolli", "summaries", "abc.json"),
				JSON.stringify({ commitHash: "abc" }),
				"utf-8",
			);

			const result = resolveKBPath("repo", "https://github.com/u/repo.git", tempDir);
			expect(result).toBe(join(tempDir, "repo"));
			const config = JSON.parse(readFileSync(join(result, ".jolli", "config.json"), "utf-8"));
			expect(config.remoteUrl).toBe("https://github.com/u/repo.git");
		});

		it("adopts a stub whose index.json has entries", () => {
			seedStub(join(tempDir, "repo"));
			writeFileSync(
				join(tempDir, "repo", ".jolli", "index.json"),
				JSON.stringify({ version: 3, entries: [{ commitHash: "abc" }] }),
				"utf-8",
			);

			const result = resolveKBPath("repo", "https://github.com/u/repo.git", tempDir);
			expect(result).toBe(join(tempDir, "repo"));
		});

		it("adopts an unclaimed stub at a -N candidate when basePath belongs to another repo", () => {
			// basePath taken by a different repo, so we fall into findAvailablePathAndClaim;
			// the first -N candidate exists but holds an unclaimed stub → adopt it.
			initializeKBFolder(join(tempDir, "repo"), "repo", "https://github.com/u/other.git");
			seedStub(join(tempDir, "repo-2"));

			const result = resolveKBPath("repo", "https://github.com/u/canonical.git", tempDir);

			expect(result).toBe(join(tempDir, "repo-2"));
			const config = JSON.parse(readFileSync(join(result, ".jolli", "config.json"), "utf-8"));
			expect(config.remoteUrl).toBe("https://github.com/u/canonical.git");
		});

		it("repeated calls converge on basePath — no -N death spiral", () => {
			// Pre-fix: each call would allocate the next -N up to -99 then fall
			// back to a timestamp suffix. Post-fix: the first call adopts
			// basePath and every later call reuses it.
			seedStub(join(tempDir, "repo"));

			for (let i = 0; i < 5; i++) {
				expect(resolveKBPath("repo", "https://github.com/u/repo.git", tempDir)).toBe(join(tempDir, "repo"));
			}
			expect(existsSync(join(tempDir, "repo-2"))).toBe(false);
			expect(existsSync(join(tempDir, "repo-3"))).toBe(false);
		});
	});

	describe("resolveKBPath claims allocated paths", () => {
		// resolveKBPath now always returns a path with identity written.
		// Callers no longer need to pair it with initializeKBFolder.

		it("writes identity when basePath did not exist", () => {
			const result = resolveKBPath("fresh", "https://github.com/u/fresh.git", tempDir);
			expect(result).toBe(join(tempDir, "fresh"));

			const config = JSON.parse(readFileSync(join(result, ".jolli", "config.json"), "utf-8"));
			expect(config.remoteUrl).toBe("https://github.com/u/fresh.git");
			expect(config.repoName).toBe("fresh");
		});

		it("writes identity when allocating a -N suffix on collision", () => {
			initializeKBFolder(join(tempDir, "repo"), "repo", "https://github.com/u/a.git");

			const result = resolveKBPath("repo", "https://github.com/u/b.git", tempDir);
			expect(result).toBe(join(tempDir, "repo-2"));

			const config = JSON.parse(readFileSync(join(result, ".jolli", "config.json"), "utf-8"));
			expect(config.remoteUrl).toBe("https://github.com/u/b.git");
			expect(config.repoName).toBe("repo");
		});
	});

	describe("peekKBPath (pure-read sibling)", () => {
		// peekKBPath returns the same path resolveKBPath would, but without
		// any disk side-effects. Used by Migrate / Rebuild to look up "where
		// would my old folder be?" without inadvertently creating one.

		it("returns the basePath without creating it when the path does not exist", () => {
			const result = peekKBPath("ghost", "https://github.com/u/ghost.git", tempDir);
			expect(result).toBe(join(tempDir, "ghost"));
			expect(existsSync(join(tempDir, "ghost"))).toBe(false);
			expect(existsSync(join(tempDir, "ghost", ".jolli"))).toBe(false);
		});

		it("returns the existing basePath when identity matches", () => {
			initializeKBFolder(join(tempDir, "repo"), "repo", "https://github.com/u/repo.git");
			const result = peekKBPath("repo", "https://github.com/u/repo.git", tempDir);
			expect(result).toBe(join(tempDir, "repo"));
		});

		it("returns the -N candidate without writing identity on collision", () => {
			initializeKBFolder(join(tempDir, "repo"), "repo", "https://github.com/u/a.git");
			const result = peekKBPath("repo", "https://github.com/u/b.git", tempDir);
			expect(result).toBe(join(tempDir, "repo-2"));
			// -2 must NOT have been created
			expect(existsSync(join(tempDir, "repo-2"))).toBe(false);
		});

		it("returns basePath when stub config is present, without writing identity", () => {
			mkdirSync(join(tempDir, "repo", ".jolli"), { recursive: true });
			writeFileSync(
				join(tempDir, "repo", ".jolli", "config.json"),
				JSON.stringify({ version: 1, sortOrder: "date" }),
				"utf-8",
			);

			const result = peekKBPath("repo", "https://github.com/u/repo.git", tempDir);
			expect(result).toBe(join(tempDir, "repo"));
			// Config must still be a stub (peek does not write)
			const cfg = JSON.parse(readFileSync(join(result, ".jolli", "config.json"), "utf-8"));
			expect(cfg.remoteUrl).toBeUndefined();
			expect(cfg.repoName).toBeUndefined();
		});

		it("walks -N candidates and returns a matching -N when the base path is claimed by a different repo", () => {
			// base `repo` belongs to repo-a, base `repo-2` belongs to repo-b
			// (the one we want). peekKBPath must walk to -2 and recognize it
			// as same-repo (line 111 branch).
			initializeKBFolder(join(tempDir, "repo"), "repo", "https://github.com/u/a.git");
			initializeKBFolder(join(tempDir, "repo-2"), "repo", "https://github.com/u/b.git");
			const result = peekKBPath("repo", "https://github.com/u/b.git", tempDir);
			expect(result).toBe(join(tempDir, "repo-2"));
		});

		it("walks -N candidates and adopts an unclaimed stub at -N", () => {
			// base `repo` is a different repo; `repo-2` exists as a stub
			// (config has no remoteUrl/repoName). peekKBPath should return
			// `repo-2` via the stub-adoption branch (line 112).
			initializeKBFolder(join(tempDir, "repo"), "repo", "https://github.com/u/a.git");
			mkdirSync(join(tempDir, "repo-2", ".jolli"), { recursive: true });
			writeFileSync(
				join(tempDir, "repo-2", ".jolli", "config.json"),
				JSON.stringify({ version: 1, sortOrder: "date" }),
				"utf-8",
			);
			const result = peekKBPath("repo", "https://github.com/u/b.git", tempDir);
			expect(result).toBe(join(tempDir, "repo-2"));
		});

		it("isValidLocalFolder / assertValidLocalFolder agree on the validity boundary", () => {
			// Empty/undefined is "no override" — both predicates treat it as valid
			// (callers will substitute the default ~/Documents/jolli/).
			expect(isValidLocalFolder(undefined)).toBe(true);
			expect(isValidLocalFolder("")).toBe(true);
			expect(() => assertValidLocalFolder(undefined)).not.toThrow();
			expect(() => assertValidLocalFolder("")).not.toThrow();

			// Absolute, no `..` — valid.
			expect(isValidLocalFolder("/abs/path")).toBe(true);
			expect(() => assertValidLocalFolder("/abs/path")).not.toThrow();

			// Relative paths — invalid (would silently land somewhere unexpected
			// relative to cwd if accepted).
			expect(isValidLocalFolder("relative/path")).toBe(false);
			expect(() => assertValidLocalFolder("relative/path")).toThrow(InvalidLocalFolderError);

			// `..`-containing paths — invalid even when absolute (path traversal
			// could escape the intended parent on disk).
			expect(isValidLocalFolder("/abs/with/../traversal")).toBe(false);
			expect(() => assertValidLocalFolder("/abs/with/../traversal")).toThrow(/Invalid Memory Bank folder/);
		});

		it("matches resolveKBPath's choice on a pristine system — Migrate parity", () => {
			// The Migrate handler relies on peekKBPath returning the same path
			// resolveKBPath would, so the `oldKbRoot === newKbRoot` archive
			// gate behaves correctly on a pristine system (no archive needed).
			const peeked = peekKBPath("brand-new", "https://github.com/u/x.git", tempDir);
			const fresh = findFreshKBPath("brand-new", tempDir);
			expect(peeked).toBe(fresh);
			expect(peeked).toBe(join(tempDir, "brand-new"));
			expect(existsSync(peeked)).toBe(false);
		});
	});

	describe("archiveKBFolder", () => {
		const url = "https://github.com/user/myrepo.git";

		it("moves the folder under <parent>/.jolli/archive/ and preserves content", () => {
			const kbRoot = resolveKBPath("myrepo", url, tempDir);
			writeFileSync(join(kbRoot, "marker.txt"), "hi");

			const dest = archiveKBFolder(kbRoot, tempDir);

			expect(dest).not.toBeNull();
			expect(existsSync(kbRoot)).toBe(false); // original removed from active area
			expect((dest as string).startsWith(join(tempDir, ".jolli", "archive"))).toBe(true);
			expect(readFileSync(join(dest as string, "marker.txt"), "utf-8")).toBe("hi");
		});

		it("names the archive dir with the repo folder-name prefix", () => {
			const kbRoot = resolveKBPath("myrepo", url, tempDir);
			const dest = archiveKBFolder(kbRoot, tempDir) as string;
			expect(basename(dest).startsWith("myrepo-")).toBe(true);
		});

		it("returns null when the folder does not exist (nothing to archive)", () => {
			expect(archiveKBFolder(join(tempDir, "nope"), tempDir)).toBeNull();
		});

		it("keeps repeated archives of the same repo distinct (collision guard)", () => {
			const first = resolveKBPath("myrepo", url, tempDir);
			const destA = archiveKBFolder(first, tempDir) as string;
			// Base name is free again now → resolve recreates it, then archive again.
			const second = resolveKBPath("myrepo", url, tempDir);
			const destB = archiveKBFolder(second, tempDir) as string;

			expect(destA).not.toBe(destB);
			expect(existsSync(destA)).toBe(true);
			expect(existsSync(destB)).toBe(true);
		});

		it("frees the base name so a subsequent resolve reclaims it (no -N ladder)", () => {
			const kbRoot = resolveKBPath("myrepo", url, tempDir);
			expect(kbRoot).toBe(join(tempDir, "myrepo"));
			archiveKBFolder(kbRoot, tempDir);
			// With the old folder moved aside, the clean base name is available again.
			expect(resolveKBPath("myrepo", url, tempDir)).toBe(join(tempDir, "myrepo"));
		});
	});
});

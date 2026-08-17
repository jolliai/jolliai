import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GitFsLayout, readBranchFromFs, readHeadHashFromFs, resolveGitFsLayout } from "./GitFsLayout.js";

const HASH = "0123456789abcdef0123456789abcdef01234567";
const OTHER_HASH = "89abcdef0123456789abcdef0123456789abcdef";

/** An env with none of the git location vars set — the normal case. */
const CLEAN_ENV: NodeJS.ProcessEnv = {};

let root: string;

beforeEach(() => {
	// realpath because macOS's tmpdir is a symlink into /private and the module
	// deliberately reports real paths (see resolveGitFsLayout) — comparing against
	// the symlinked spelling would fail for a reason that has nothing to do with
	// the behaviour under test.
	root = realpathSync(mkdtempSync(join(tmpdir(), "gitfs-")));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/**
 * Hand-builds a plain (non-worktree) repo layout.
 *
 * `objects/` is here because git's own repository test requires it (alongside
 * `refs/` and HEAD) — a fixture without it is a directory git refuses to call a
 * repository, so leaving it out would make every case below assert about a shape
 * that never reaches production. See `isRepositoryGitDir`.
 */
function seedPlainRepo(dir: string, head: string): string {
	const gitDir = join(dir, ".git");
	mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
	mkdirSync(join(gitDir, "objects"), { recursive: true });
	writeFileSync(join(gitDir, "HEAD"), head);
	return gitDir;
}

/**
 * A layout built directly, for the HEAD contents `resolveGitFsLayout` refuses to
 * hand back at all (missing, or neither a symref nor an object id — those are not
 * repositories). The readers still owe an answer for them: HEAD can be truncated
 * or rewritten AFTER a layout was resolved, and a hook holding one must degrade
 * to null rather than misread it.
 */
function layoutOf(gitDir: string): GitFsLayout {
	return { worktreeRoot: resolve(root), gitDir, commonDir: gitDir };
}

describe("resolveGitFsLayout", () => {
	it("resolves a plain repo whose .git is a directory", () => {
		const gitDir = seedPlainRepo(root, "ref: refs/heads/main\n");

		const layout = resolveGitFsLayout(root, { env: CLEAN_ENV });

		expect(layout).toEqual({ worktreeRoot: resolve(root), gitDir, commonDir: gitDir });
	});

	it("walks up from a subdirectory to the worktree root", () => {
		const gitDir = seedPlainRepo(root, "ref: refs/heads/main\n");
		const nested = join(root, "a", "b", "c");
		mkdirSync(nested, { recursive: true });

		expect(resolveGitFsLayout(nested, { env: CLEAN_ENV })).toEqual({
			worktreeRoot: resolve(root),
			gitDir,
			commonDir: gitDir,
		});
	});

	it("follows a .git pointer file and its commondir to the shared git dir", () => {
		const mainGitDir = seedPlainRepo(join(root, "main"), "ref: refs/heads/main\n");
		const linkedGitDir = join(mainGitDir, "worktrees", "wt1");
		mkdirSync(linkedGitDir, { recursive: true });
		writeFileSync(join(linkedGitDir, "commondir"), "../..\n");
		writeFileSync(join(linkedGitDir, "HEAD"), "ref: refs/heads/wt1\n");
		const worktree = join(root, "wt1");
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktree, ".git"), `gitdir: ${linkedGitDir}\n`);

		expect(resolveGitFsLayout(worktree, { env: CLEAN_ENV })).toEqual({
			worktreeRoot: resolve(worktree),
			gitDir: linkedGitDir,
			commonDir: resolve(mainGitDir),
		});
	});

	it("accepts a linked worktree, whose own git dir carries neither objects nor refs of its own", () => {
		// Guard on WHERE the repository check looks: a real linked worktree's git dir
		// holds HEAD, commondir, gitdir, index and logs — no `objects`, and its `refs`
		// only appears once a per-worktree ref exists (measured against
		// `.git/worktrees/*` in this repo). Checking those in the worktree's own git
		// dir instead of the common one would decline every worktree there is.
		const mainGitDir = join(root, "main", ".git");
		mkdirSync(join(mainGitDir, "refs", "heads"), { recursive: true });
		mkdirSync(join(mainGitDir, "objects"), { recursive: true });
		const linkedGitDir = join(mainGitDir, "worktrees", "wt1");
		mkdirSync(linkedGitDir, { recursive: true });
		writeFileSync(join(linkedGitDir, "commondir"), "../..\n");
		writeFileSync(join(linkedGitDir, "HEAD"), "ref: refs/heads/feature\n");
		const worktree = join(root, "wt1");
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktree, ".git"), `gitdir: ${linkedGitDir}\n`);

		expect(resolveGitFsLayout(worktree, { env: CLEAN_ENV })).toEqual({
			worktreeRoot: resolve(worktree),
			gitDir: linkedGitDir,
			commonDir: resolve(mainGitDir),
		});
	});

	it("accepts a relative gitdir pointer", () => {
		const linkedGitDir = join(seedPlainRepo(join(root, "main"), "ref: refs/heads/main\n"), "worktrees", "wt1");
		mkdirSync(linkedGitDir, { recursive: true });
		writeFileSync(join(linkedGitDir, "commondir"), "../..\n");
		writeFileSync(join(linkedGitDir, "HEAD"), "ref: refs/heads/wt1\n");
		const worktree = join(root, "wt1");
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktree, ".git"), "gitdir: ../main/.git/worktrees/wt1\n");

		expect(resolveGitFsLayout(worktree, { env: CLEAN_ENV })?.gitDir).toBe(resolve(linkedGitDir));
	});

	it("treats a submodule (pointer file, no commondir) as its own common dir", () => {
		const moduleGitDir = join(root, "super", ".git", "modules", "sub");
		mkdirSync(join(moduleGitDir, "refs", "heads"), { recursive: true });
		mkdirSync(join(moduleGitDir, "objects"), { recursive: true });
		writeFileSync(join(moduleGitDir, "HEAD"), "ref: refs/heads/main\n");
		const sub = join(root, "super", "sub");
		mkdirSync(sub, { recursive: true });
		writeFileSync(join(sub, ".git"), `gitdir: ${moduleGitDir}\n`);

		expect(resolveGitFsLayout(sub, { env: CLEAN_ENV })).toEqual({
			worktreeRoot: resolve(sub),
			gitDir: moduleGitDir,
			commonDir: moduleGitDir,
		});
	});

	it("returns null rather than answering for an enclosing repo when a .git pointer is unusable", () => {
		seedPlainRepo(root, "ref: refs/heads/main\n");
		const inner = join(root, "inner");
		mkdirSync(inner, { recursive: true });
		writeFileSync(join(inner, ".git"), "gitdir: /nonexistent/elsewhere\n");

		expect(resolveGitFsLayout(inner, { env: CLEAN_ENV })).toBeNull();
	});

	it("returns null outside any repository", () => {
		expect(resolveGitFsLayout(root, { env: CLEAN_ENV })).toBeNull();
	});

	// A `.git` DIRECTORY is not on its own a repository, and the gap is not
	// theoretical: an interrupted clone, a half-synced tree or a partly-deleted
	// `.git` all leave one behind, and `git rev-parse --git-dir` answers 128 for
	// every shape below (measured; `GitFsLayout.realgit.test.ts` pins it). Since
	// the whole contract of this module is to agree with the `git` call it
	// replaces, each one has to decline so the caller falls back to that call.
	describe("a .git directory git itself would reject", () => {
		it("declines one that is empty", () => {
			mkdirSync(join(root, ".git"), { recursive: true });

			expect(resolveGitFsLayout(root, { env: CLEAN_ENV })).toBeNull();
		});

		it("declines one with no HEAD", () => {
			mkdirSync(join(root, ".git", "refs"), { recursive: true });
			mkdirSync(join(root, ".git", "objects"), { recursive: true });

			expect(resolveGitFsLayout(root, { env: CLEAN_ENV })).toBeNull();
		});

		it("declines one whose HEAD is neither a symref nor an object id", () => {
			seedPlainRepo(root, "garbage\n");

			expect(resolveGitFsLayout(root, { env: CLEAN_ENV })).toBeNull();
		});

		it.each(["objects", "refs"])("declines one with no %s directory", (missing) => {
			seedPlainRepo(root, "ref: refs/heads/main\n");
			rmSync(join(root, ".git", missing), { recursive: true, force: true });

			expect(resolveGitFsLayout(root, { env: CLEAN_ENV })).toBeNull();
		});

		it("accepts a symref to a branch that does not exist yet", () => {
			// A repo between `git init` and its first commit. Git accepts it (measured),
			// so declining would put the SessionStart hook back on the subprocess for
			// every brand-new repository.
			seedPlainRepo(root, "ref: refs/heads/main\n");

			expect(resolveGitFsLayout(root, { env: CLEAN_ENV })).not.toBeNull();
		});
	});

	it.each(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"])("declines when %s redirects git", (name) => {
		seedPlainRepo(root, "ref: refs/heads/main\n");

		expect(resolveGitFsLayout(root, { env: { [name]: "/somewhere/else" } })).toBeNull();
	});

	it("ignores a git location variable that is present but empty", () => {
		seedPlainRepo(root, "ref: refs/heads/main\n");

		expect(resolveGitFsLayout(root, { env: { GIT_DIR: "" } })).not.toBeNull();
	});

	describe("path spelling", () => {
		/**
		 * A link pointing at the repo, standing in for macOS's /tmp → /private/tmp.
		 *
		 * Created as a `"junction"` rather than a `"dir"` symlink so the pair runs
		 * everywhere: a directory symlink on Windows needs Developer Mode or elevation and
		 * throws EPERM in the seed, while a junction needs neither and is resolved by
		 * `realpathSync` the same way. The type argument is ignored on POSIX, where this
		 * stays an ordinary symlink — so one call covers both, and what these assert
		 * (`realpath` on / off) never becomes platform-gated.
		 */
		function seedRepoBehindSymlink(): string {
			const real = join(root, "real");
			mkdirSync(real, { recursive: true });
			seedPlainRepo(real, "ref: refs/heads/main\n");
			const link = join(root, "link");
			symlinkSync(real, link, "junction");
			return link;
		}

		it("keeps the caller's spelling by default, matching resolve(cwd, --git-common-dir)", () => {
			const link = seedRepoBehindSymlink();

			expect(resolveGitFsLayout(link, { env: CLEAN_ENV })?.commonDir).toBe(join(link, ".git"));
		});

		it("resolves symlinks under realpath, matching --show-toplevel", () => {
			const link = seedRepoBehindSymlink();

			expect(resolveGitFsLayout(link, { env: CLEAN_ENV, realpath: true })?.worktreeRoot).toBe(join(root, "real"));
		});
	});
});

describe("readBranchFromFs", () => {
	function layoutFor(head: string) {
		seedPlainRepo(root, head);
		const layout = resolveGitFsLayout(root, { env: CLEAN_ENV });
		if (!layout) throw new Error("fixture did not produce a layout");
		return layout;
	}

	it("reads the checked-out branch", () => {
		expect(readBranchFromFs(layoutFor("ref: refs/heads/main\n"))).toBe("main");
	});

	it("keeps a namespaced branch in the form git prints", () => {
		expect(readBranchFromFs(layoutFor("ref: refs/heads/feature/jolli-2210\n"))).toBe("feature/jolli-2210");
	});

	it("returns null on a detached HEAD", () => {
		expect(readBranchFromFs(layoutFor(`${HASH}\n`))).toBeNull();
	});

	it("returns null for a symref outside refs/heads", () => {
		expect(readBranchFromFs(layoutFor("ref: refs/remotes/origin/main\n"))).toBeNull();
	});

	it("returns null when HEAD is missing", () => {
		const gitDir = join(root, ".git");
		mkdirSync(gitDir, { recursive: true });

		expect(readBranchFromFs(layoutOf(gitDir))).toBeNull();
	});
});

describe("readHeadHashFromFs", () => {
	function layoutFor(head: string) {
		seedPlainRepo(root, head);
		const layout = resolveGitFsLayout(root, { env: CLEAN_ENV });
		if (!layout) throw new Error("fixture did not produce a layout");
		return layout;
	}

	it("returns a detached HEAD's own hash", () => {
		expect(readHeadHashFromFs(layoutFor(`${HASH}\n`))).toBe(HASH);
	});

	it("resolves a loose ref", () => {
		const layout = layoutFor("ref: refs/heads/main\n");
		writeFileSync(join(layout.gitDir, "refs", "heads", "main"), `${HASH}\n`);

		expect(readHeadHashFromFs(layout)).toBe(HASH);
	});

	it("resolves a packed ref, skipping comments and peeled-tag continuation lines", () => {
		const layout = layoutFor("ref: refs/heads/main\n");
		writeFileSync(
			join(layout.gitDir, "packed-refs"),
			`# pack-refs with: peeled fully-peeled sorted \n${OTHER_HASH} refs/tags/v1\n^${HASH}\n${HASH} refs/heads/main\n`,
		);

		expect(readHeadHashFromFs(layout)).toBe(HASH);
	});

	it("prefers a loose ref over a stale packed one", () => {
		const layout = layoutFor("ref: refs/heads/main\n");
		writeFileSync(join(layout.gitDir, "packed-refs"), `${OTHER_HASH} refs/heads/main\n`);
		writeFileSync(join(layout.gitDir, "refs", "heads", "main"), `${HASH}\n`);

		expect(readHeadHashFromFs(layout)).toBe(HASH);
	});

	it("falls back to the common dir for a linked worktree's branch ref", () => {
		const mainGitDir = seedPlainRepo(join(root, "main"), "ref: refs/heads/main\n");
		writeFileSync(join(mainGitDir, "refs", "heads", "feature"), `${HASH}\n`);
		const linkedGitDir = join(mainGitDir, "worktrees", "wt1");
		mkdirSync(linkedGitDir, { recursive: true });
		writeFileSync(join(linkedGitDir, "commondir"), "../..\n");
		writeFileSync(join(linkedGitDir, "HEAD"), "ref: refs/heads/feature\n");
		const worktree = join(root, "wt1");
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktree, ".git"), `gitdir: ${linkedGitDir}\n`);

		const layout = resolveGitFsLayout(worktree, { env: CLEAN_ENV });
		expect(layout).not.toBeNull();
		expect(readHeadHashFromFs(layout as NonNullable<typeof layout>)).toBe(HASH);
	});

	it("returns null for an unresolvable ref rather than guessing", () => {
		expect(readHeadHashFromFs(layoutFor("ref: refs/heads/never-created\n"))).toBeNull();
	});

	it("refuses a HEAD that would traverse out of the git dir", () => {
		// Built directly: `resolveGitFsLayout` already declines this HEAD, so the only
		// way a reader ever sees it is a HEAD rewritten after resolution — which is
		// exactly the case the traversal guard exists for.
		expect(readHeadHashFromFs(layoutOf(seedPlainRepo(root, "ref: ../../../../etc/passwd\n")))).toBeNull();
	});

	it("returns null when HEAD holds something that is neither a hash nor a symref", () => {
		expect(readHeadHashFromFs(layoutOf(seedPlainRepo(root, "garbage\n")))).toBeNull();
	});
});

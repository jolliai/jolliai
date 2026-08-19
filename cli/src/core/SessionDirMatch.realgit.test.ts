/**
 * The fixtures in `SessionDirMatch.test.ts` build `.git` entries by hand, and git
 * itself rejects every one of them — so they exercise the path-shaped FALLBACK.
 * These drive real `git init` / `git worktree add` / `git submodule add`, which is
 * the only way to pin what the module is actually for: a session run in any
 * worktree of a repository belongs to that repository, and a session run in a
 * repository nested inside it does not.
 *
 * Split out from the unit file (and listed in `SLOW_TEST_FILES`) because these
 * cases spawn git — the same load profile as the other real-git files.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionDirBelongsToRepo } from "./SessionDirMatch.js";

let root: string;

beforeEach(() => {
	// `realpathSync`, because on macOS `mkdtemp` hands back `/var/...` while git
	// reports `/private/var/...`. The predicate resolves symlinks on both sides, so
	// it copes either way — but a test that then compares paths itself would not.
	root = realpathSync(mkdtempSync(join(tmpdir(), "sessiondir-real-")));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/** A repository with one commit — `git worktree add` refuses an unborn HEAD. */
function seedRealRepo(dir: string): void {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	writeFileSync(join(dir, "f.txt"), "hello\n");
	git(dir, "add", "f.txt");
	// The identity is passed per-invocation: the monorepo's shared git env
	// (`test/gitEnv.ts`) deliberately injects none.
	git(dir, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "first");
}

describe("sessionDirBelongsToRepo against real git", () => {
	it("attributes a worktree added OUTSIDE the main one to the repository", () => {
		// The standard shape, and the one the whole fix is about: a sibling directory
		// shares no path prefix with the main worktree, so containment says no while
		// git says the two are one repository.
		const main = join(root, "repo");
		seedRealRepo(main);
		const worktree = join(root, "repo-feature");
		git(main, "worktree", "add", "-q", "-b", "feature", worktree);

		expect(sessionDirBelongsToRepo(worktree, main)).toBe(true);
	});

	it("attributes a worktree added INSIDE the main one to the repository", () => {
		// Passes containment but used to be rejected by the intervening-`.git` walk:
		// a linked worktree's root carries a `.git` FILE, which that walk read as a
		// nested repository.
		const main = join(root, "repo");
		seedRealRepo(main);
		const worktree = join(main, ".worktrees", "foo");
		git(main, "worktree", "add", "-q", "-b", "foo", worktree);

		expect(sessionDirBelongsToRepo(worktree, main)).toBe(true);
	});

	it("attributes a SUBDIRECTORY of a linked worktree to the repository", () => {
		// A session started with `cd packages/foo` inside a worktree — the JOLLI-2015
		// shape, one worktree further out.
		const main = join(root, "repo");
		seedRealRepo(main);
		const worktree = join(root, "repo-feature");
		git(main, "worktree", "add", "-q", "-b", "feature", worktree);
		const sub = join(worktree, "packages", "foo");
		mkdirSync(sub, { recursive: true });

		expect(sessionDirBelongsToRepo(sub, main)).toBe(true);
	});

	it("is symmetric: the main worktree belongs to the repository asked from a worktree", () => {
		// Membership is a property of the repository, not of which checkout was
		// registered first — so neither side may be privileged.
		const main = join(root, "repo");
		seedRealRepo(main);
		const worktree = join(root, "repo-feature");
		git(main, "worktree", "add", "-q", "-b", "feature", worktree);

		expect(sessionDirBelongsToRepo(main, worktree)).toBe(true);
	});

	it("attributes one worktree's session when asked about a SIBLING worktree", () => {
		// Both are linked worktrees of one repository, neither is the main one. They
		// share a shared-git directory, so they share a repository.
		const main = join(root, "repo");
		seedRealRepo(main);
		const a = join(root, "repo-a");
		const b = join(root, "repo-b");
		git(main, "worktree", "add", "-q", "-b", "branch-a", a);
		git(main, "worktree", "add", "-q", "-b", "branch-b", b);

		expect(sessionDirBelongsToRepo(a, b)).toBe(true);
	});

	it("excludes a session in a nested but INDEPENDENT clone", () => {
		// The case the intervening-`.git` walk existed for. It must keep working: the
		// inner repository has its own shared git directory, so the keys differ.
		const main = join(root, "repo");
		seedRealRepo(main);
		const nested = join(main, "vendor", "lib");
		seedRealRepo(nested);

		expect(sessionDirBelongsToRepo(nested, main)).toBe(false);
	});

	it("excludes a session deeper inside a nested independent clone", () => {
		const main = join(root, "repo");
		seedRealRepo(main);
		const nested = join(main, "vendor", "lib");
		seedRealRepo(nested);
		const deep = join(nested, "src", "core");
		mkdirSync(deep, { recursive: true });

		expect(sessionDirBelongsToRepo(deep, main)).toBe(false);
	});

	it("excludes a session inside a real submodule", () => {
		// A submodule's shared git directory is `<super>/.git/modules/<name>`, which is
		// not the super-project's — so it is excluded for the same reason a nested
		// clone is, rather than by a special case.
		const superRepo = join(root, "super");
		seedRealRepo(superRepo);
		const donor = join(root, "donor");
		seedRealRepo(donor);
		const sub = join(superRepo, "modules", "sdk");
		git(
			superRepo,
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"--quiet",
			"add",
			donor,
			join("modules", "sdk"),
		);

		expect(sessionDirBelongsToRepo(sub, superRepo)).toBe(false);
	});

	it("keeps a subdirectory session of a plain repository", () => {
		// JOLLI-2015, re-pinned against real git rather than a hand-built `.git`.
		const main = join(root, "repo");
		seedRealRepo(main);
		const sub = join(main, "packages", "foo");
		mkdirSync(sub, { recursive: true });

		expect(sessionDirBelongsToRepo(sub, main)).toBe(true);
	});

	it("excludes an unrelated repository whose path only shares a prefix string", () => {
		// `repo2` starts with the string `repo` — the boundary check in `isPathInside`
		// used to be the only thing standing between them, and now the differing keys
		// are. Both must agree.
		const main = join(root, "repo");
		seedRealRepo(main);
		const other = join(root, "repo2");
		seedRealRepo(other);

		expect(sessionDirBelongsToRepo(other, main)).toBe(false);
	});

	it("excludes a directory that is in no repository at all", () => {
		// No key on the session side, so this one reaches the path-shaped fallback and
		// is refused by containment. Pinned here because the fallback is where such a
		// directory always lands, whichever way the primary path is written.
		const main = join(root, "repo");
		seedRealRepo(main);
		const loose = join(root, "not-a-repo");
		mkdirSync(loose, { recursive: true });

		expect(sessionDirBelongsToRepo(loose, main)).toBe(false);
	});

	it("falls back when the target root is readable but is not a repository", () => {
		// The session side has a definite repository key while the target side has
		// none. That is not evidence of equality, so the legacy containment walk gets
		// the final say and rejects the nested repository boundary.
		const nested = join(root, "nested");
		seedRealRepo(nested);

		expect(sessionDirBelongsToRepo(nested, root)).toBe(false);
	});
});

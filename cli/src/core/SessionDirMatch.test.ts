import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionDirBelongsToRepo } from "./SessionDirMatch.js";

describe("sessionDirBelongsToRepo", () => {
	it("matches a session run at the repo root exactly", () => {
		expect(sessionDirBelongsToRepo("/Users/x/repo", "/Users/x/repo")).toBe(true);
	});

	it("matches a session run in a subdirectory of the repo (the JOLLI-2015 case)", () => {
		expect(sessionDirBelongsToRepo("/Users/x/repo/packages/foo", "/Users/x/repo")).toBe(true);
	});

	it("does not match a session run outside the repo", () => {
		expect(sessionDirBelongsToRepo("/Users/x/other", "/Users/x/repo")).toBe(false);
	});

	it("returns false for a null/empty sessionDir instead of throwing", () => {
		// SQLite-backed sources (Copilot CLI, OpenCode) have a nullable cwd column:
		// a session started outside any project stores cwd = NULL. Such a row must
		// not be attributed to the repo — and crucially must not throw, or a single
		// null row poisons the whole discoverer scan (JOLLI: Copilot capture broke
		// when one null-cwd session tripped `.replace()` on null).
		expect(sessionDirBelongsToRepo(null as unknown as string, "/Users/x/repo")).toBe(false);
		expect(sessionDirBelongsToRepo("" as string, "/Users/x/repo")).toBe(false);
		expect(sessionDirBelongsToRepo(undefined as unknown as string, "/Users/x/repo")).toBe(false);
	});

	it("does not match a sibling whose path only shares a prefix string", () => {
		// /Users/x/repo2 starts with the string "/Users/x/repo" but is not inside it.
		expect(sessionDirBelongsToRepo("/Users/x/repo2", "/Users/x/repo")).toBe(false);
	});

	it("keeps a subdirectory session when the directory no longer exists (best-effort)", () => {
		// Non-existent paths: no `.git` can be found, so the session is attributed
		// to the repo that matched by path.
		expect(sessionDirBelongsToRepo("/nonexistent/repo/sub/dir", "/nonexistent/repo")).toBe(true);
	});

	// Every `.git` in this block is hand-built and git itself would refuse all of
	// them (no HEAD, or a pointer to a directory that does not exist), so
	// `readRepositoryKey` declines and these cases exercise the path-shaped
	// FALLBACK. That is deliberate — the fallback is what an unreadable repository
	// gets, and it must keep behaving as it always did. The primary path, where git
	// answers, is pinned in `SessionDirMatch.realgit.test.ts`.
	describe("nested git repo / submodule exclusion (unreadable-.git fallback)", () => {
		let root: string;

		beforeEach(async () => {
			root = await mkdtemp(join(tmpdir(), "sessiondirmatch-"));
		});

		afterEach(async () => {
			await rm(root, { recursive: true, force: true });
		});

		it("excludes a session inside a nested git repo (.git directory)", async () => {
			const nested = join(root, "vendor", "lib");
			await mkdir(join(nested, ".git"), { recursive: true });
			expect(sessionDirBelongsToRepo(nested, root)).toBe(false);
		});

		it("excludes a session inside a submodule (.git file)", async () => {
			const sub = join(root, "modules", "sdk");
			await mkdir(sub, { recursive: true });
			await writeFile(join(sub, ".git"), "gitdir: ../../.git/modules/sdk\n");
			expect(sessionDirBelongsToRepo(sub, root)).toBe(false);
		});

		it("excludes a session in a deeper directory of a nested repo", async () => {
			const nestedRoot = join(root, "vendor", "lib");
			await mkdir(join(nestedRoot, ".git"), { recursive: true });
			const deep = join(nestedRoot, "src", "core");
			await mkdir(deep, { recursive: true });
			expect(sessionDirBelongsToRepo(deep, root)).toBe(false);
		});

		it("keeps a subdirectory session when only the repo root has a .git (normal repo)", async () => {
			await mkdir(join(root, ".git"), { recursive: true });
			const sub = join(root, "packages", "foo");
			await mkdir(sub, { recursive: true });
			// The repo root's own .git must NOT trigger exclusion.
			expect(sessionDirBelongsToRepo(sub, root)).toBe(true);
		});

		// The next two cases pin the FALLBACK, not the product rule.
		//
		// Every fixture in this describe block builds a `.git` that git itself would
		// reject — an empty directory, or a pointer file naming a directory that does
		// not exist — so `readRepositoryKey` declines for both sides and
		// `sessionDirBelongsToRepo` runs its path-shaped fallback. That is worth
		// pinning (an unreadable repository must behave as it always did), but it is
		// NOT what a real linked worktree does: see `SessionDirMatch.realgit.test.ts`,
		// where a genuine `git worktree add` is attributed to its repository.
		//
		// The previous version of these two cases claimed the exclusion was deliberate,
		// because such a worktree would "capture its sessions via its OWN post-commit"
		// with its own root as `repoRoot`. That premise was false: `registerRepo`
		// resolves every cwd through `getProjectRootDir`, so a linked worktree's path is
		// never recorded and never becomes a `repoRoot`.
		it("falls back to excluding an unreadable nested worktree from a parent's scan", async () => {
			await mkdir(join(root, ".git"), { recursive: true });
			const worktree = join(root, ".worktrees", "foo");
			const worktreeSub = join(worktree, "packages", "bar");
			await mkdir(worktreeSub, { recursive: true });
			// A `.git` FILE whose target does not exist — the layout reader declines.
			await writeFile(join(worktree, ".git"), "gitdir: ../../.git/worktrees/foo\n");
			expect(sessionDirBelongsToRepo(worktreeSub, root)).toBe(false);
		});

		it("falls back to keeping that session when scanned against the worktree's own root", async () => {
			const worktree = join(root, ".worktrees", "foo");
			const worktreeSub = join(worktree, "packages", "bar");
			await mkdir(worktreeSub, { recursive: true });
			await writeFile(join(worktree, ".git"), "gitdir: ../../.git/worktrees/foo\n");
			// repoRoot IS the worktree root, so its own `.git` file is never inspected and
			// the walk to `worktreeSub` finds nothing between them — the session is kept.
			expect(sessionDirBelongsToRepo(worktreeSub, worktree)).toBe(true);
		});
	});
});

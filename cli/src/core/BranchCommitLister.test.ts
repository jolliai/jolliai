import { execFileSync } from "node:child_process";
// Integration-style: build a throwaway git repo in a temp dir.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listBranchCommitHashes } from "./BranchCommitLister.js";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("listBranchCommitHashes", () => {
	it("returns commits on the branch since merge-base with main, newest-first", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bcl-"));
		try {
			git(dir, "init", "-q", "-b", "main");
			git(dir, "config", "user.email", "t@t.t");
			git(dir, "config", "user.name", "T");
			git(dir, "commit", "--allow-empty", "-q", "-m", "base");
			git(dir, "checkout", "-q", "-b", "feature");
			git(dir, "commit", "--allow-empty", "-q", "-m", "first");
			git(dir, "commit", "--allow-empty", "-q", "-m", "second");
			const res = await listBranchCommitHashes(dir, "main");
			expect(res.isMerged).toBe(false);
			expect(res.hashes.length).toBe(2); // first + second, not base
			// newest-first: HEAD ("second") first
			expect(git(dir, "log", "-1", "--pretty=%H")).toBe(res.hashes[0]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns empty for a branch with no commits past main", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bcl-"));
		try {
			git(dir, "init", "-q", "-b", "main");
			git(dir, "config", "user.email", "t@t.t");
			git(dir, "config", "user.name", "T");
			git(dir, "commit", "--allow-empty", "-q", "-m", "base");
			git(dir, "checkout", "-q", "-b", "feature");
			const res = await listBranchCommitHashes(dir, "main");
			expect(res.hashes).toEqual([]);
			expect(res.isMerged).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Exercises the merged-mode path (mergeBase === headHash): branch already
	// fast-forward merged into main, so the lister uses the reflog creation
	// point + author filter to recover the original commits.
	it("returns original commits in merged-mode when branch is already merged into main", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bcl-"));
		try {
			git(dir, "init", "-q", "-b", "main");
			git(dir, "config", "user.email", "t@t.t");
			git(dir, "config", "user.name", "T");
			git(dir, "commit", "--allow-empty", "-q", "-m", "base");
			git(dir, "checkout", "-q", "-b", "feature");
			git(dir, "commit", "--allow-empty", "-q", "-m", "feat-one");
			git(dir, "commit", "--allow-empty", "-q", "-m", "feat-two");
			// fast-forward merge feature into main
			git(dir, "checkout", "-q", "main");
			git(dir, "merge", "--ff-only", "-q", "feature");
			// switch back to feature — HEAD is now ancestor of main (merged mode)
			git(dir, "checkout", "-q", "feature");
			const res = await listBranchCommitHashes(dir, "main");
			expect(res.isMerged).toBe(true);
			expect(res.hashes.length).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Unborn HEAD (repo initialised, zero commits): `rev-parse --abbrev-ref HEAD`
	// fails, so `branch` falls back to the literal "HEAD" (the `|| "HEAD"` arm),
	// and `merge-base` has no object to resolve, so the lister bails empty.
	it("returns empty on an unborn HEAD (no commits)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bcl-"));
		try {
			git(dir, "init", "-q", "-b", "main");
			const res = await listBranchCommitHashes(dir, "main");
			expect(res).toEqual({ hashes: [], isMerged: false });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// No common ancestor: an orphan branch shares no history with main, so
	// `merge-base` returns nothing and the lister bails empty before merged-mode.
	it("returns empty when HEAD shares no merge-base with main", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bcl-"));
		try {
			git(dir, "init", "-q", "-b", "main");
			git(dir, "config", "user.email", "t@t.t");
			git(dir, "config", "user.name", "T");
			git(dir, "commit", "--allow-empty", "-q", "-m", "base");
			git(dir, "checkout", "-q", "--orphan", "feature");
			git(dir, "commit", "--allow-empty", "-q", "-m", "orphan-root");
			const res = await listBranchCommitHashes(dir, "main");
			expect(res).toEqual({ hashes: [], isMerged: false });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// HEAD is on main itself (mainBranch === current branch). merge-base is HEAD,
	// so the lister enters merged-mode and walks main's reflog — whose oldest entry
	// is "commit (initial)", never "branch: Created from", exercising the
	// no-match loop arm + the oldest-entry fallback in findBranchCreationPoint.
	it("recovers commits in merged-mode when HEAD is on the main branch", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bcl-"));
		try {
			git(dir, "init", "-q", "-b", "main");
			git(dir, "config", "user.email", "t@t.t");
			git(dir, "config", "user.name", "T");
			git(dir, "commit", "--allow-empty", "-q", "-m", "base");
			git(dir, "commit", "--allow-empty", "-q", "-m", "two");
			const res = await listBranchCommitHashes(dir, "main");
			expect(res.isMerged).toBe(true);
			// log runs from the reflog's oldest entry (the initial "base" commit)
			// exclusive..HEAD, so only "two" is returned.
			expect(res.hashes.length).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Merged-mode with the branch reflog wiped: `findBranchCreationPoint` sees an
	// empty reflog and returns undefined, so the lister bails empty.
	it("returns empty in merged-mode when the branch reflog is gone", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bcl-"));
		try {
			git(dir, "init", "-q", "-b", "main");
			git(dir, "config", "user.email", "t@t.t");
			git(dir, "config", "user.name", "T");
			git(dir, "commit", "--allow-empty", "-q", "-m", "base");
			git(dir, "checkout", "-q", "-b", "feature");
			git(dir, "commit", "--allow-empty", "-q", "-m", "f1");
			git(dir, "checkout", "-q", "main");
			git(dir, "merge", "--ff-only", "-q", "feature");
			git(dir, "checkout", "-q", "feature");
			git(dir, "reflog", "expire", "--expire=now", "--all");
			const res = await listBranchCommitHashes(dir, "main");
			expect(res).toEqual({ hashes: [], isMerged: false });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Merged-mode with no `user.name` configured: the author filter resolves
	// empty, so the lister bails rather than running an unfiltered log. We set the
	// LOCAL user.name to an empty string rather than `--unset` it — `--unset` only
	// clears the local value, leaving `git config user.name` to fall back to the
	// developer's global identity, which would make this test pass only on machines
	// with no global user.name. An empty local value deterministically shadows it.
	it("returns empty in merged-mode when user.name resolves empty", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bcl-"));
		try {
			git(dir, "init", "-q", "-b", "main");
			git(dir, "config", "user.email", "t@t.t");
			git(dir, "config", "user.name", "T");
			git(dir, "commit", "--allow-empty", "-q", "-m", "base");
			git(dir, "checkout", "-q", "-b", "feature");
			git(dir, "commit", "--allow-empty", "-q", "-m", "f1");
			git(dir, "checkout", "-q", "main");
			git(dir, "merge", "--ff-only", "-q", "feature");
			git(dir, "checkout", "-q", "feature");
			git(dir, "config", "user.name", "");
			const res = await listBranchCommitHashes(dir, "main");
			expect(res).toEqual({ hashes: [], isMerged: false });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Merged-mode with a `user.name` containing regex metacharacters. Without
	// `--fixed-strings`, `--author=J. Doe (Acme)` is a regex whose unbalanced `(`
	// makes `git log` error out (→ empty result) or match the wrong commits. The
	// literal-substring filter must still recover this author's own commits.
	it("recovers commits in merged-mode when user.name has regex metacharacters", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bcl-"));
		const metaName = "J. Doe (Acme) [team]";
		try {
			git(dir, "init", "-q", "-b", "main");
			git(dir, "config", "user.email", "t@t.t");
			git(dir, "config", "user.name", metaName);
			git(dir, "commit", "--allow-empty", "-q", "-m", "base");
			git(dir, "checkout", "-q", "-b", "feature");
			git(dir, "commit", "--allow-empty", "-q", "-m", "feat-one");
			git(dir, "commit", "--allow-empty", "-q", "-m", "feat-two");
			git(dir, "checkout", "-q", "main");
			git(dir, "merge", "--ff-only", "-q", "feature");
			git(dir, "checkout", "-q", "feature");
			const res = await listBranchCommitHashes(dir, "main");
			expect(res.isMerged).toBe(true);
			expect(res.hashes.length).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

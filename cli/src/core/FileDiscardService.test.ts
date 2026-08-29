import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discardFiles, previewDiscard } from "./FileDiscardService.js";

/**
 * Real git throughout — the whole point of this module is which git command each
 * status combination needs, and a mocked `execGit` would only assert that the
 * code calls what the code says it calls. These cases instead check the tree
 * afterwards, which is what actually regressed in both hosts.
 */
describe("FileDiscardService", () => {
	let cwd: string;

	/**
	 * An identity is REQUIRED here, not a nicety: the monorepo's `test/gitEnv.ts`
	 * points `GIT_CONFIG_GLOBAL` at /dev/null, so a fixture repo has no configured
	 * committer at all. Git then falls back to guessing `<user>@<hostname>` and
	 * refuses outright when the hostname has no dot — which is a developer laptop
	 * passing and a CI runner failing the whole file in `beforeEach`. Set per
	 * invocation rather than through `GIT_CONFIG_COUNT`: that channel is
	 * process-wide and shared with the excludes-file neutralization.
	 *
	 * Only the fixture's own commits need this. `git status` / `git restore`, which
	 * is all the code under test runs, never touches an identity.
	 */
	const git = (...args: Array<string>): string =>
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			env: {
				...process.env,
				LC_ALL: "C",
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		});

	const write = (relativePath: string, content: string): void => {
		const absolute = join(cwd, relativePath);
		mkdirSync(join(absolute, ".."), { recursive: true });
		writeFileSync(absolute, content);
	};

	const read = (relativePath: string): string => readFileSync(join(cwd, relativePath), "utf8");
	const exists = (relativePath: string): boolean => existsSync(join(cwd, relativePath));

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "jolli-discard-"));
		git("init", "-q");
		write("tracked.txt", "committed\n");
		git("add", "tracked.txt");
		git("commit", "-qm", "initial");
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("returns nothing for an empty request without touching git", async () => {
		expect(await discardFiles(cwd, [])).toEqual([]);
	});

	it("deletes an untracked file", async () => {
		write("untracked.txt", "scratch\n");

		const [outcome] = await discardFiles(cwd, ["untracked.txt"]);

		expect(outcome).toMatchObject({ relativePath: "untracked.txt", ok: true, action: "deleted" });
		expect(exists("untracked.txt")).toBe(false);
	});

	it("deletes an untracked file inside an untracked directory", async () => {
		// -uall is what makes this reachable: without it git reports the directory
		// as one `?? nested/` row and the file itself has no status entry at all.
		write("nested/deep.txt", "scratch\n");

		const [outcome] = await discardFiles(cwd, ["nested/deep.txt"]);

		expect(outcome).toMatchObject({ ok: true, action: "deleted" });
		expect(exists("nested/deep.txt")).toBe(false);
	});

	// The three modification shapes take three different code paths but land in the
	// same place — back at HEAD, working tree clean. That IS discard: "leave the
	// staged copy alone" would be an unstage, a different operation the UI does not
	// offer. Each is covered separately because the PATH differs (`git restore --`
	// vs `--staged --worktree`), and a mis-routed one fails loudly on other repos
	// even when this end state happens to match.
	it("restores a worktree-only modification ( M)", async () => {
		// Edited, never staged — so the index already matches HEAD and `git restore --`
		// touching only the worktree is not separately observable here. The routing
		// is what this pins; the MM case below is where the two paths would diverge.
		write("tracked.txt", "committed\nedited\n");

		const [outcome] = await discardFiles(cwd, ["tracked.txt"]);

		expect(outcome).toMatchObject({ ok: true, action: "restored" });
		expect(read("tracked.txt")).toBe("committed\n");
		expect(git("status", "--porcelain")).toBe("");
	});

	it("restores a staged modification in both the index and the worktree (M )", async () => {
		write("tracked.txt", "committed\nstaged\n");
		git("add", "tracked.txt");

		const [outcome] = await discardFiles(cwd, ["tracked.txt"]);

		expect(outcome).toMatchObject({ ok: true, action: "restored" });
		expect(read("tracked.txt")).toBe("committed\n");
		expect(git("status", "--porcelain")).toBe("");
	});

	it("restores a file that is both staged and edited since (MM)", async () => {
		// Two pending versions — the staged one and the newer worktree one. Discard
		// drops BOTH: the index column being set routes this to
		// `restore --staged --worktree`, matching VS Code, which groups M /D /MM
		// together. Keeping the staged copy would leave the row still dirty after a
		// click the user read as "throw my changes away".
		write("tracked.txt", "committed\nstaged\n");
		git("add", "tracked.txt");
		write("tracked.txt", "committed\nstaged\nunstaged\n");

		const [outcome] = await discardFiles(cwd, ["tracked.txt"]);

		expect(outcome).toMatchObject({ ok: true, action: "restored" });
		expect(read("tracked.txt")).toBe("committed\n");
		expect(git("status", "--porcelain")).toBe("");
	});

	it("restores a deleted tracked file", async () => {
		rmSync(join(cwd, "tracked.txt"));

		const [outcome] = await discardFiles(cwd, ["tracked.txt"]);

		expect(outcome).toMatchObject({ ok: true, action: "restored" });
		expect(read("tracked.txt")).toBe("committed\n");
	});

	it("unstages and deletes a staged new file", async () => {
		write("added.txt", "new\n");
		git("add", "added.txt");

		const [outcome] = await discardFiles(cwd, ["added.txt"]);

		expect(outcome).toMatchObject({ ok: true, action: "unstaged-and-deleted" });
		expect(exists("added.txt")).toBe(false);
		expect(git("status", "--porcelain")).toBe("");
	});

	it("unstages and deletes a staged new file that was modified afterwards", async () => {
		write("added.txt", "new\n");
		git("add", "added.txt");
		write("added.txt", "new\nmore\n");

		const [outcome] = await discardFiles(cwd, ["added.txt"]);

		expect(outcome).toMatchObject({ ok: true, action: "unstaged-and-deleted" });
		expect(exists("added.txt")).toBe(false);
	});

	// A repo whose first commit has not happened yet. Everything staged in it is an
	// addition, so this is the one state where the whole added-file group hangs on a
	// command that cannot run: `git restore --staged` has no tree to restore FROM and
	// refuses the batch with `fatal: could not resolve HEAD`. Reached by anyone who
	// runs `git init` and opens the panel before committing.
	describe("before the first commit (unborn HEAD)", () => {
		beforeEach(() => {
			// Re-make the fixture without a commit — the outer beforeEach always lands one.
			//
			// Take a FRESH mkdtemp rather than re-creating the outer fixture's path.
			// Re-creating it was observed failing on CI as
			// `EEXIST: file already exists, mkdir '/tmp/jolli-discard-fGOhbR'`, while
			// passing every time this file is run alone. The exact writer that put the
			// path back was not identified, and the two candidates are far apart in
			// likelihood — a sibling worker's mkdtemp re-drawing the same six random
			// characters is ~1-in-62^6, so a straggler (a git subprocess or a logger
			// flush from an earlier test) recreating the tree between the rm and the
			// mkdir is the better bet. Rather than guess, drop the requirement: an
			// unused name cannot be contended. `rmSync` still runs so the committed
			// fixture is cleaned up rather than leaked; reassigning `cwd` keeps the
			// outer afterEach correct, and `git` reads `cwd` per invocation.
			rmSync(cwd, { recursive: true, force: true });
			cwd = mkdtempSync(join(tmpdir(), "jolli-discard-"));
			git("init", "-q");
		});

		it("unstages and deletes a staged new file", async () => {
			write("added.txt", "new\n");
			git("add", "added.txt");

			const [outcome] = await discardFiles(cwd, ["added.txt"]);

			expect(outcome).toMatchObject({ ok: true, action: "unstaged-and-deleted" });
			expect(exists("added.txt")).toBe(false);
			expect(git("status", "--porcelain")).toBe("");
		});

		it("unstages and deletes a staged new file that was modified afterwards", async () => {
			// `AM` — staged content differs from both the worktree and (absent) HEAD,
			// which is what an unforced `git rm --cached` refuses.
			write("added.txt", "new\n");
			git("add", "added.txt");
			write("added.txt", "new\nmore\n");

			const [outcome] = await discardFiles(cwd, ["added.txt"]);

			expect(outcome).toMatchObject({ ok: true, action: "unstaged-and-deleted" });
			expect(exists("added.txt")).toBe(false);
			expect(git("status", "--porcelain")).toBe("");
		});

		it("deletes an untracked file", async () => {
			// The other half of what an uncommitted repo can hold: no index entry, so
			// no HEAD is needed and this path was never affected.
			write("scratch.txt", "scratch\n");

			const [outcome] = await discardFiles(cwd, ["scratch.txt"]);

			expect(outcome).toMatchObject({ ok: true, action: "deleted" });
			expect(exists("scratch.txt")).toBe(false);
		});
	});

	it("reverts a rename: the original comes back and the new path is removed", async () => {
		git("mv", "tracked.txt", "renamed.txt");

		const [outcome] = await discardFiles(cwd, ["renamed.txt"]);

		expect(outcome).toMatchObject({ ok: true, action: "rename-reverted" });
		expect(exists("renamed.txt")).toBe(false);
		expect(read("tracked.txt")).toBe("committed\n");
		expect(git("status", "--porcelain")).toBe("");
	});

	it("reports the restored original of a rename in additionalPaths", async () => {
		// The host mirrors the working tree from its own file cache, so a path the
		// discard WROTE but never named is a row that survives its own revert.
		git("mv", "tracked.txt", "renamed.txt");

		const [outcome] = await discardFiles(cwd, ["renamed.txt"]);

		expect(outcome?.additionalPaths).toEqual(["tracked.txt"]);
	});

	it("reverts a capitalisation-only rename without deleting the file", async () => {
		// On a case-insensitive filesystem (macOS, Windows) `tracked.txt` and
		// `Tracked.txt` are ONE directory entry, so restoring the original wrote the
		// content straight into the file the removal step would then delete. That
		// left NEITHER path on disk and still reported `ok: true` — a confirmed
		// "undo the rename" that deleted the file instead.
		//
		// The assertions below are the invariant on BOTH kinds of filesystem: the
		// original is back with its committed content and the tree is clean. Whether
		// `Tracked.txt` still resolves is not assertable — it is the same file as
		// `tracked.txt` on macOS and a removed one on Linux.
		git("mv", "tracked.txt", "Tracked.txt");
		expect(git("status", "--porcelain")).toContain("R  tracked.txt -> Tracked.txt");

		const [outcome] = await discardFiles(cwd, ["Tracked.txt"]);

		expect(outcome).toMatchObject({ ok: true, action: "rename-reverted" });
		expect(read("tracked.txt")).toBe("committed\n");
		expect(git("status", "--porcelain")).toBe("");
	});

	it("unstages and deletes a staged copy", async () => {
		// C is the one column no default git config produces, so it is also the one
		// a host is most likely to get wrong: HEAD has no version of the NEW path,
		// so routing it to `restore --staged --worktree` (the staged-modification
		// branch) fails on a pathspec git has never seen. Two conditions are needed
		// to make git emit it at all — `status.renames=copies`, AND the SOURCE
		// modified in the same change set, since copy detection only searches files
		// that are themselves modified. The row carries the source as its original
		// path, exactly like a rename, and the parser must consume that segment.
		git("config", "status.renames", "copies");
		write("source.txt", "line1\nline2\nline3\nline4\nline5\n");
		git("add", "source.txt");
		git("commit", "-qm", "add source");

		write("copied.txt", "line1\nline2\nline3\nline4\nline5\n");
		write("source.txt", "line1\nline2\nline3\nline4\nline5\nline6\n");
		git("add", "-A");
		// Asserted in the NON-`-z` shape, which prints `C  ORIG -> NEW`. The `-z`
		// stream the service reads reverses that pair — new path first, original as
		// its own NUL-separated segment — so a `C  copied.txt` expectation here is
		// the -z order leaking into a plain-porcelain assertion and never matches.
		expect(git("status", "--porcelain")).toContain("C  source.txt -> copied.txt");

		const [outcome] = await discardFiles(cwd, ["copied.txt"]);

		expect(outcome).toMatchObject({ ok: true, action: "unstaged-and-deleted" });
		expect(exists("copied.txt")).toBe(false);
		// The copy's SOURCE is a separate row and was not requested — untouched.
		expect(read("source.txt")).toBe("line1\nline2\nline3\nline4\nline5\nline6\n");
	});

	it("does not let a glob-shaped filename revert a different file", async () => {
		// Git matches a bare pathspec as a GLOB: `git restore -- 'a[1].txt'`
		// reverts `a1.txt` and exits 0. Without :(literal) this reports success
		// for a file it never touched while destroying another file's edits.
		write("a1.txt", "original\n");
		write("a[1].txt", "bracket\n");
		// `git add 'a[1].txt'` would glob too and never stage the bracket file.
		git("add", "-A");
		git("commit", "-qm", "add both");

		write("a1.txt", "edited\n");
		write("a[1].txt", "bracket edited\n");

		const [outcome] = await discardFiles(cwd, ["a[1].txt"]);

		expect(outcome).toMatchObject({ ok: true, action: "restored" });
		expect(read("a[1].txt")).toBe("bracket\n");
		// The unrelated file keeps its edit — it was never requested.
		expect(read("a1.txt")).toBe("edited\n");
	});

	// ── Conflicted (unmerged) paths ─────────────────────────────────────
	//
	// A tree mid-merge is the one place the index column lies about what a path
	// needs. `AA` and `AU` both show an `A`, which used to route them into the
	// staged-addition group and DELETE a file HEAD still had while reporting
	// `ok: true`. And `git restore --staged` refuses an unmerged path outright, so
	// the two halves below need different git commands, not one with another flag.

	/** Runs a merge EXPECTED to conflict — the non-zero exit is the fixture. */
	const mergeExpectingConflict = (branch: string): void => {
		try {
			git("merge", branch);
		} catch {
			// A conflicting merge exits non-zero by design; the conflicted index is
			// what the case under test needs.
		}
	};

	/**
	 * Commits `content` at `relativePath` on a new branch, then returns to the
	 * branch that was checked out. The base name is read back rather than assumed:
	 * the monorepo's `test/gitEnv.ts` points `GIT_CONFIG_GLOBAL` at /dev/null, so
	 * `init.defaultBranch` is whatever the git build compiled in.
	 */
	const commitOnSideBranch = (branch: string, relativePath: string, content: string): void => {
		const base = git("rev-parse", "--abbrev-ref", "HEAD").trim();
		git("checkout", "-q", "-b", branch);
		write(relativePath, content);
		git("add", "-A");
		git("commit", "-qm", `${branch}: ${relativePath}`);
		git("checkout", "-q", base);
	};

	it("restores a both-added conflict (AA) instead of deleting a file HEAD has", async () => {
		commitOnSideBranch("theirs", "conflict.txt", "theirs\n");
		write("conflict.txt", "ours\n");
		git("add", "-A");
		git("commit", "-qm", "ours: conflict.txt");
		mergeExpectingConflict("theirs");
		expect(git("status", "--porcelain")).toContain("AA conflict.txt");

		const [outcome] = await discardFiles(cwd, ["conflict.txt"]);

		// Back to HEAD, which also resolves the conflict in favour of ours — the same
		// answer UU has always given here. The bug deleted the file outright and left
		// ` D conflict.txt` while reporting success.
		expect(outcome).toMatchObject({ ok: true, action: "restored" });
		expect(read("conflict.txt")).toBe("ours\n");
		expect(git("status", "--porcelain")).toBe("");
	});

	it("restores a both-modified conflict (UU) to HEAD", async () => {
		// Pinned because it was previously right only by accident: `U` is neither
		// " " nor "?", so it fell through to the staged-worktree group, which happens
		// to be the correct command. The explicit conflicted branch must agree.
		commitOnSideBranch("theirs", "tracked.txt", "theirs\n");
		write("tracked.txt", "ours\n");
		git("commit", "-qam", "ours: tracked.txt");
		mergeExpectingConflict("theirs");
		expect(git("status", "--porcelain")).toContain("UU tracked.txt");

		const [outcome] = await discardFiles(cwd, ["tracked.txt"]);

		expect(outcome).toMatchObject({ ok: true, action: "restored" });
		expect(read("tracked.txt")).toBe("ours\n");
		expect(git("status", "--porcelain")).toBe("");
	});

	it("unstages and deletes a conflicted path HEAD has no version of (DU)", async () => {
		// Deleted by us, modified by them: HEAD has nothing to restore from, so the
		// index entry is dropped and the file the incoming side left in the worktree
		// is removed. Note the index column here is `D` — the shapes HEAD does and
		// does not cover are not separable from the columns alone, which is why the
		// service asks git instead.
		commitOnSideBranch("theirs", "tracked.txt", "theirs\n");
		git("rm", "-q", "tracked.txt");
		git("commit", "-qm", "ours removes tracked.txt");
		mergeExpectingConflict("theirs");
		expect(git("status", "--porcelain")).toContain("DU tracked.txt");

		const [outcome] = await discardFiles(cwd, ["tracked.txt"]);

		expect(outcome).toMatchObject({ ok: true, action: "unstaged-and-deleted" });
		expect(exists("tracked.txt")).toBe(false);
		expect(git("status", "--porcelain")).toBe("");
	});

	// ── Path base ───────────────────────────────────────────────────────

	it("discards correctly when the caller's cwd is a subdirectory of the worktree", async () => {
		// `git status --porcelain` reports repo-root-relative paths wherever it ran,
		// while a pathspec and a `join(cwd, …)` are both cwd-relative. Unnormalised,
		// the two halves failed differently: `git restore` could not resolve
		// `sub/…` from inside `sub/` and failed loudly, while the DELETE landed on
		// `<cwd>/sub/sub/scratch.txt`, whose ENOENT is swallowed as success —
		// `ok: true` for a file still sitting on disk.
		write("sub/scratch.txt", "scratch\n");
		write("tracked.txt", "committed\nedited\n");

		const outcomes = await discardFiles(join(cwd, "sub"), ["sub/scratch.txt", "tracked.txt"]);

		expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true]);
		expect(exists("sub/scratch.txt")).toBe(false);
		expect(read("tracked.txt")).toBe("committed\n");
	});

	it("reports not-found for a path with no pending change", async () => {
		const [outcome] = await discardFiles(cwd, ["tracked.txt"]);

		// Asking for a state that already holds is success, not an error.
		expect(outcome).toMatchObject({ relativePath: "tracked.txt", ok: true, action: "not-found" });
		expect(read("tracked.txt")).toBe("committed\n");
	});

	it("reports not-found for a path that does not exist at all", async () => {
		const [outcome] = await discardFiles(cwd, ["nope.txt"]);

		expect(outcome).toMatchObject({ ok: true, action: "not-found" });
	});

	it("rejects a blank path instead of calling it already clean", async () => {
		// Every webview producer falls back to '' when it cannot resolve the row
		// element, and the host-side shape guard that used to catch that was
		// removed once the porcelain columns stopped being an input. A blank path
		// holds no state, so `not-found` + ok:true would tell the user their
		// confirmed, irreversible click had succeeded when nothing ran at all.
		const outcomes = await discardFiles(cwd, ["", "   "]);

		expect(outcomes).toHaveLength(2);
		for (const outcome of outcomes) {
			expect(outcome.ok).toBe(false);
			expect(outcome.action).toBe("invalid-path");
			expect(outcome.error).toBeDefined();
		}
	});

	it("keeps rejecting a blank path per path without failing its batch", async () => {
		// One bad path must not cost the caller the good ones — the batch is what
		// a multi-select discard sends, and throwing would lose every outcome.
		write("tracked.txt", "changed\n");

		const outcomes = await discardFiles(cwd, ["", "tracked.txt"]);

		expect(outcomes.map((outcome) => outcome.action)).toEqual(["invalid-path", "restored"]);
		expect(read("tracked.txt")).toBe("committed\n");
	});

	it("returns one outcome per requested path, in the order given", async () => {
		write("a.txt", "a\n");
		write("b.txt", "b\n");
		write("tracked.txt", "changed\n");

		const outcomes = await discardFiles(cwd, ["b.txt", "tracked.txt", "a.txt", "missing.txt"]);

		expect(outcomes.map((outcome) => outcome.relativePath)).toEqual([
			"b.txt",
			"tracked.txt",
			"a.txt",
			"missing.txt",
		]);
		expect(outcomes.map((outcome) => outcome.action)).toEqual(["deleted", "restored", "deleted", "not-found"]);
		expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
	});

	it("discards a mixed batch in one call", async () => {
		write("tracked.txt", "changed\n");
		write("added.txt", "new\n");
		git("add", "added.txt");
		write("untracked.txt", "scratch\n");

		const outcomes = await discardFiles(cwd, ["tracked.txt", "added.txt", "untracked.txt"]);

		expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
		expect(read("tracked.txt")).toBe("committed\n");
		expect(exists("added.txt")).toBe(false);
		expect(exists("untracked.txt")).toBe(false);
		expect(git("status", "--porcelain")).toBe("");
	});

	it("reports every path as a failure when git status cannot run", async () => {
		// Outside any repository: `git status` exits non-zero, so nothing is
		// classified and nothing is discarded. Reporting `ok: false` (rather than
		// throwing) keeps a caller's batch intact, but it MUST NOT come back as
		// not-found: both hosts read `ok` alone, so a clean not-found here is the
		// confirmation dialog appearing, the user clicking through, and the file
		// still being there with no error anywhere.
		const bare = mkdtempSync(join(tmpdir(), "jolli-discard-norepo-"));
		writeFileSync(join(bare, "file.txt"), "content\n");
		try {
			const outcomes = await discardFiles(bare, ["file.txt", "other.txt"]);

			expect(outcomes.map((outcome) => outcome.relativePath)).toEqual(["file.txt", "other.txt"]);
			for (const outcome of outcomes) {
				expect(outcome.ok).toBe(false);
				expect(outcome.action).toBe("status-unavailable");
				// git's own reason, carried through so the host can show it.
				expect(outcome.error).toMatch(/fatal/i);
			}
			expect(existsSync(join(bare, "file.txt"))).toBe(true);
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	// ── Failure reporting ───────────────────────────────────────────────
	//
	// The bug this module exists to kill was a SILENT failure: the confirmation
	// dialog appeared, the user clicked through, and the file was still there with
	// nothing logged. Holding `.git/index.lock` is a faithful, reproducible stand-in
	// for that — it is exactly what a concurrent git process does, and it makes every
	// `git restore` in the module fail for real rather than through a mock.

	it("reports a failed restore instead of claiming the file was discarded", async () => {
		write("tracked.txt", "committed\nstaged\n");
		git("add", "tracked.txt");
		writeFileSync(join(cwd, ".git", "index.lock"), "");

		const [outcome] = await discardFiles(cwd, ["tracked.txt"]);

		expect(outcome?.ok).toBe(false);
		expect(outcome?.action).toBe("restored");
		expect(outcome?.error).toMatch(/index\.lock/);
		// Still dirty — the caller must be able to tell the user nothing happened.
		expect(read("tracked.txt")).toBe("committed\nstaged\n");
	});

	it("reports a failed worktree-only restore", async () => {
		write("tracked.txt", "committed\nedited\n");
		writeFileSync(join(cwd, ".git", "index.lock"), "");

		const [outcome] = await discardFiles(cwd, ["tracked.txt"]);

		expect(outcome?.ok).toBe(false);
		expect(outcome?.error).toMatch(/index\.lock/);
		expect(read("tracked.txt")).toBe("committed\nedited\n");
	});

	it("keeps a staged new file on disk when unstaging it fails", async () => {
		// Order matters: unstage first, delete only if it worked. Deleting first would
		// destroy the file and leave the index still holding it — unrecoverable, since
		// an added file has no HEAD version to restore from.
		write("added.txt", "new\n");
		git("add", "added.txt");
		writeFileSync(join(cwd, ".git", "index.lock"), "");

		const [outcome] = await discardFiles(cwd, ["added.txt"]);

		expect(outcome?.ok).toBe(false);
		expect(outcome?.action).toBe("unstaged-and-deleted");
		expect(exists("added.txt")).toBe(true);
	});

	it("reports a failed rename revert", async () => {
		git("mv", "tracked.txt", "moved.txt");
		writeFileSync(join(cwd, ".git", "index.lock"), "");

		const [outcome] = await discardFiles(cwd, ["moved.txt"]);

		expect(outcome?.ok).toBe(false);
		expect(outcome?.action).toBe("rename-reverted");
		expect(outcome?.error).toMatch(/index\.lock/);
		// Neither half applied: the new path survives and the original stays gone.
		expect(exists("moved.txt")).toBe(true);
		expect(exists("tracked.txt")).toBe(false);
	});

	it("reports a failed restore of a conflicted path HEAD has", async () => {
		commitOnSideBranch("theirs", "tracked.txt", "theirs\n");
		write("tracked.txt", "ours\n");
		git("commit", "-qam", "ours: tracked.txt");
		mergeExpectingConflict("theirs");
		// `git ls-tree` takes no index lock, so the HEAD probe still answers and the
		// path routes to the restore half — which is the call that then fails.
		writeFileSync(join(cwd, ".git", "index.lock"), "");

		const [outcome] = await discardFiles(cwd, ["tracked.txt"]);

		expect(outcome?.ok).toBe(false);
		expect(outcome?.action).toBe("restored");
		expect(outcome?.error).toMatch(/index\.lock/);
		// Still conflicted — the caller must be able to say nothing happened.
		expect(git("status", "--porcelain")).toContain("UU tracked.txt");
	});

	it("keeps a conflicted path on disk when dropping its index entry fails", async () => {
		// Same order rule as the staged-addition group: unstage first, remove only if
		// that worked. HEAD has no version of this path, so a removal that ran before
		// a failed unstage would be unrecoverable.
		commitOnSideBranch("theirs", "tracked.txt", "theirs\n");
		git("rm", "-q", "tracked.txt");
		git("commit", "-qm", "ours removes tracked.txt");
		mergeExpectingConflict("theirs");
		writeFileSync(join(cwd, ".git", "index.lock"), "");

		const [outcome] = await discardFiles(cwd, ["tracked.txt"]);

		expect(outcome?.ok).toBe(false);
		expect(outcome?.action).toBe("unstaged-and-deleted");
		expect(exists("tracked.txt")).toBe(true);
	});

	it("treats an already-deleted path as success when the same path is asked for twice", async () => {
		// The second delete hits ENOENT. That is the outcome we wanted, not a failure —
		// the same reasoning covers a real race where something else removes the file
		// between the status read and the unlink.
		write("dupe.txt", "scratch\n");

		const outcomes = await discardFiles(cwd, ["dupe.txt", "dupe.txt"]);

		expect(outcomes).toHaveLength(2);
		expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
		expect(exists("dupe.txt")).toBe(false);
	});

	// ── One path, two porcelain rows ────────────────────────────────────
	//
	// The status stream is not one row per path. `git rm --cached` leaves a staged
	// deletion in the index while the file stays on disk, and the index diff and
	// the untracked scan then report the SAME path independently. Keyed by path,
	// last-write-wins let the `??` row win and the file was deleted off disk with
	// the staged deletion left behind — reported `ok: true`, with the row still on
	// screen because only half of it had been resolved.

	describe("a path git reports twice", () => {
		beforeEach(() => {
			git("rm", "--cached", "-q", "tracked.txt");
		});

		it("emits both a staged-deletion and an untracked row for it", () => {
			// The fixture itself, pinned: if git ever stops emitting the pair, the
			// two cases below stop testing what they claim to.
			expect(git("status", "--porcelain=v1", "-uall").trim().split("\n")).toEqual([
				"D  tracked.txt",
				"?? tracked.txt",
			]);
		});

		it("restores it from the tracked row instead of deleting it as untracked", async () => {
			const [outcome] = await discardFiles(cwd, ["tracked.txt"]);

			// `restore --staged --worktree` puts the index entry and the file back,
			// which is a clean tree. Deleting it instead left `D  tracked.txt` staged
			// and the worktree copy gone.
			expect(outcome).toMatchObject({ ok: true, action: "restored" });
			expect(exists("tracked.txt")).toBe(true);
			expect(read("tracked.txt")).toBe("committed\n");
			expect(git("status", "--porcelain")).toBe("");
		});

		it("keeps the tracked row even when the worktree copy was edited afterwards", async () => {
			// Still two rows, and discarding means what it always means: back to HEAD.
			write("tracked.txt", "edited after rm --cached\n");

			const [outcome] = await discardFiles(cwd, ["tracked.txt"]);

			expect(outcome).toMatchObject({ ok: true, action: "restored" });
			expect(read("tracked.txt")).toBe("committed\n");
			expect(git("status", "--porcelain")).toBe("");
		});
	});

	// ── previewDiscard ──────────────────────────────────────────────────
	//
	// The prompt's wording. It shares `classifyEntry` with the discard itself
	// precisely so the sentence and the behaviour cannot drift — which is how the
	// rename/copy wording shipped wrong in both hosts at once.

	describe("previewDiscard", () => {
		const deletes = async (relativePath: string): Promise<boolean> => {
			const [preview] = await previewDiscard(cwd, [relativePath]);
			expect(preview?.relativePath).toBe(relativePath);
			return preview?.deletesFile === true;
		};

		it("returns nothing for an empty request", async () => {
			expect(await previewDiscard(cwd, [])).toEqual([]);
		});

		it("says an untracked file is deleted", async () => {
			write("scratch.txt", "scratch\n");
			expect(await deletes("scratch.txt")).toBe(true);
		});

		it("says a staged addition is deleted", async () => {
			write("added.txt", "new\n");
			git("add", "added.txt");
			expect(await deletes("added.txt")).toBe(true);
		});

		it("says a staged rename deletes the NEW path", async () => {
			git("mv", "tracked.txt", "renamed.txt");
			expect(await deletes("renamed.txt")).toBe(true);
		});

		it("says a staged copy is deleted", async () => {
			write("copy.txt", "committed\n");
			git("add", "copy.txt");
			write("tracked.txt", "changed so the source shows as modified\n");
			git("add", "tracked.txt");
			// `C` needs status.renames=copies; without it this is a plain `A`, which
			// answers the same. Either way the copy is what gets removed.
			expect(await deletes("copy.txt")).toBe(true);
		});

		it("says a modified file is NOT deleted", async () => {
			write("tracked.txt", "changed\n");
			expect(await deletes("tracked.txt")).toBe(false);
		});

		it("says a staged deletion is NOT deleted — discarding restores the file", async () => {
			// The `D  …` half of the two-row case above. It collapses to the same
			// `"D"` a host sees for the `DU` conflict below, which is exactly why the
			// hosts cannot answer this from a status letter.
			git("rm", "--cached", "-q", "tracked.txt");
			expect(await deletes("tracked.txt")).toBe(false);
		});

		it("says a conflict HEAD has a version of is NOT deleted (UU)", async () => {
			commitOnSideBranch("theirs", "tracked.txt", "theirs\n");
			write("tracked.txt", "ours\n");
			git("commit", "-qam", "ours edits tracked.txt");
			mergeExpectingConflict("theirs");
			expect(git("status", "--porcelain")).toContain("UU tracked.txt");

			expect(await deletes("tracked.txt")).toBe(false);
		});

		it("says a conflict HEAD has no version of IS deleted (DU)", async () => {
			// The case the prompt got wrong: `DU` collapses to `"D"` in both hosts,
			// their letter rule answered "not deleted", and the discard deleted it.
			commitOnSideBranch("theirs", "tracked.txt", "theirs\n");
			git("rm", "-q", "tracked.txt");
			git("commit", "-qm", "ours removes tracked.txt");
			mergeExpectingConflict("theirs");
			expect(git("status", "--porcelain")).toContain("DU tracked.txt");

			expect(await deletes("tracked.txt")).toBe(true);
		});

		it("says a path with nothing pending is NOT deleted", async () => {
			expect(await deletes("tracked.txt")).toBe(false);
		});

		it("says a blank path is NOT deleted", async () => {
			// It names no file, so nothing can be removed; the discard itself is what
			// reports `invalid-path`.
			expect(await deletes("")).toBe(false);
		});

		it("answers for every requested path, in order", async () => {
			write("scratch.txt", "scratch\n");
			write("tracked.txt", "changed\n");

			expect(await previewDiscard(cwd, ["tracked.txt", "scratch.txt", "absent.txt"])).toEqual([
				{ relativePath: "tracked.txt", deletesFile: false },
				{ relativePath: "scratch.txt", deletesFile: true },
				{ relativePath: "absent.txt", deletesFile: false },
			]);
		});

		it("reports nothing as deleted when git status cannot run", async () => {
			// A failed status read means we know nothing. The milder verb is the
			// honest one — nothing has been deleted, and the discard the user is
			// about to confirm answers `status-unavailable` rather than succeeding.
			const notARepo = mkdtempSync(join(tmpdir(), "jolli-discard-norepo-"));
			try {
				expect(await previewDiscard(notARepo, ["anything.txt"])).toEqual([
					{ relativePath: "anything.txt", deletesFile: false },
				]);
			} finally {
				rmSync(notARepo, { recursive: true, force: true });
			}
		});

		it("resolves paths against the worktree root when called from a subdirectory", async () => {
			// Same anchoring rule as the discard: `git status` reports root-relative
			// paths wherever it ran, so a preview run from a subdirectory must still
			// look them up under their root-relative names.
			write("sub/nested.txt", "scratch\n");

			expect(await previewDiscard(join(cwd, "sub"), ["sub/nested.txt"])).toEqual([
				{ relativePath: "sub/nested.txt", deletesFile: true },
			]);
		});
	});
});

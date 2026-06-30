/**
 * Real-git integration tests for JolliMemoryBridge.stageFiles().
 *
 * Unlike JolliMemoryBridge.test.ts, this file does NOT mock
 * node:child_process or node:fs. Each test creates a throwaway git
 * repo in the OS temp dir, exercises the bridge against it, and
 * verifies the resulting index state via `git status --porcelain`.
 *
 * Purpose: end-to-end regression cover for PROJ-1326. The unit tests
 * prove the partition logic in isolation; these tests prove the
 * partition's *design* matches real git's pathspec semantics.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub out the only vscode-runtime dependency transitively pulled in by
// the bridge. Everything else (node:child_process, node:fs, git on PATH)
// is left real so we exercise the actual stageFiles → execFile → git pipeline.
vi.mock("vscode", () => ({}));
vi.mock("./util/Logger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { JolliMemoryBridge } from "./JolliMemoryBridge.js";

let repoDir: string;

beforeEach(() => {
	repoDir = mkdtempSync(join(tmpdir(), "proj-1326-"));
	execSync("git init -q", { cwd: repoDir });
	// Deterministic identity so commits succeed even in sandboxed env.
	execSync('git -c commit.gpgsign=false config user.email "test@example.com"', {
		cwd: repoDir,
	});
	execSync('git config user.name "Test"', { cwd: repoDir });
	execSync('git commit --allow-empty -qm "init"', { cwd: repoDir });
});

afterEach(() => {
	rmSync(repoDir, { recursive: true, force: true });
});

function gitStatus(): string {
	return execSync("git status --short", {
		cwd: repoDir,
		encoding: "utf8",
	}).trim();
}

describe("stageFiles() — real git integration", () => {
	it("allowMissing stages the deletion for the PROJ-1326 bug state", async () => {
		// Bug state: path was tracked, then `git rm --cached` removed it
		// from the index, then the worktree copy was deleted. Running
		// `git add -- foo.ts` in this state produces the exact error
		// reported in the Linear ticket.
		writeFileSync(join(repoDir, "foo.ts"), "v1");
		execSync('git add foo.ts && git commit -qm "track foo"', { cwd: repoDir });
		execSync("git rm --cached -q foo.ts", { cwd: repoDir });
		rmSync(join(repoDir, "foo.ts"));
		expect(gitStatus()).toBe("D  foo.ts");

		// Sanity: raw `git add` would reject this path (locks our bug premise).
		expect(() =>
			execSync("git add -- foo.ts", { cwd: repoDir, stdio: "pipe" }),
		).toThrow(/did not match any files/);

		const bridge = new JolliMemoryBridge(repoDir);
		await bridge.stageFiles(["foo.ts"], { allowMissing: true });

		// Deletion remains staged; no error bubbled up.
		expect(gitStatus()).toBe("D  foo.ts");
	});

	it("default mode rejects the same bug state (preserves restore-path warning)", async () => {
		writeFileSync(join(repoDir, "bar.ts"), "v1");
		execSync('git add bar.ts && git commit -qm "track bar"', { cwd: repoDir });
		execSync("git rm --cached -q bar.ts", { cwd: repoDir });
		rmSync(join(repoDir, "bar.ts"));

		const bridge = new JolliMemoryBridge(repoDir);
		await expect(bridge.stageFiles(["bar.ts"])).rejects.toThrow(
			/did not match any files/,
		);
		// Index unchanged — caller's try/catch takes over.
		expect(gitStatus()).toBe("D  bar.ts");
	});

	it("allowMissing stages a real deletion for a tracked-then-removed file", async () => {
		// Positive control: the common case still works.
		writeFileSync(join(repoDir, "existing.ts"), "v1");
		execSync('git add existing.ts && git commit -qm "track"', { cwd: repoDir });
		rmSync(join(repoDir, "existing.ts"));

		const bridge = new JolliMemoryBridge(repoDir);
		await bridge.stageFiles(["existing.ts"], { allowMissing: true });

		expect(gitStatus()).toBe("D  existing.ts");
	});

	it("allowMissing stages a new file addition", async () => {
		// Positive control: adding a new file via allowMissing still works.
		writeFileSync(join(repoDir, "new.ts"), "content");

		const bridge = new JolliMemoryBridge(repoDir);
		await bridge.stageFiles(["new.ts"], { allowMissing: true });

		expect(gitStatus()).toBe("A  new.ts");
	});

	it("allowMissing partitions a mixed selection correctly", async () => {
		// Setup: `present.ts` on disk; `gone.ts` in the bug state.
		writeFileSync(join(repoDir, "gone.ts"), "v1");
		execSync('git add gone.ts && git commit -qm "track gone"', {
			cwd: repoDir,
		});
		execSync("git rm --cached -q gone.ts", { cwd: repoDir });
		rmSync(join(repoDir, "gone.ts"));
		writeFileSync(join(repoDir, "present.ts"), "new");

		const bridge = new JolliMemoryBridge(repoDir);
		await bridge.stageFiles(["present.ts", "gone.ts"], { allowMissing: true });

		const status = gitStatus().split("\n").sort().join("\n");
		expect(status).toBe("A  present.ts\nD  gone.ts");
	});
});

describe("getStagedFilePaths() — real git integration (NUL-separated, unicode)", () => {
	it("returns unicode paths verbatim without octal quoting", async () => {
		// Regression lock for the bundled 3.1 fix. Without `-z`, git would
		// emit `"fo\303\266.ts"` for this filename.
		writeFileSync(join(repoDir, "foö.ts"), "x");
		execSync("git add foö.ts", { cwd: repoDir });

		const bridge = new JolliMemoryBridge(repoDir);
		const staged = await bridge.getStagedFilePaths();

		expect(staged).toEqual(["foö.ts"]);
	});
});

function git(args: string, cwd: string): string {
	return execSync(`git ${args}`, { cwd, encoding: "utf8" }).trim();
}

describe("getBranchPrStats vs listBranchCommits — sync-only merged branch agreement (E1)", () => {
	it("a created-from-main + rebased branch with NO own commits yields empty stats AND empty memory list", async () => {
		// Build a sync-only merged branch:
		//   1. main has commit A (the `init` commit from beforeEach).
		//   2. branch `sync` is created from main (reflog: "branch: Created from HEAD").
		//   3. main advances to commit B.
		//   4. `sync` is rebased onto main → its HEAD becomes B, with NO `commit`
		//      reflog op of its own (only "Created from" + the rebase/reset move).
		// Now merge-base(sync@B, main@B) === HEAD, so both code paths enter "merged
		// mode". listBranchCommits gates on `hasOwnCommit` (false here) and returns
		// empty. Before the fix, getBranchPrStats skipped that gate and diffed the
		// creation point (A) against HEAD (B) — a NON-empty diff that contradicted
		// the empty memory list. After the fix both must agree on empty.
		const mainBranch = git("branch --show-current", repoDir) || "main";
		git("checkout -b sync", repoDir); // reflog: branch: Created from <main>@A
		git(`checkout ${mainBranch}`, repoDir);
		writeFileSync(join(repoDir, "on-main.ts"), "added on main\n");
		git("add on-main.ts", repoDir);
		git('-c commit.gpgsign=false commit -qm "B: real change on main"', repoDir);
		git("checkout sync", repoDir);
		git(`rebase ${mainBranch}`, repoDir); // sync HEAD now == main HEAD (B), no own commit

		const bridge = new JolliMemoryBridge(repoDir);

		const list = await bridge.listBranchCommits(mainBranch);
		const stats = await bridge.getBranchPrStats(mainBranch);

		// Memory list is empty (the existing hasOwnCommit gate).
		expect(list.commits).toEqual([]);
		// PR-stats must ALSO be empty — same commit range, no contradiction.
		expect(stats).toEqual({
			insertions: 0,
			deletions: 0,
			filesChanged: 0,
			files: [],
		});
	});
});

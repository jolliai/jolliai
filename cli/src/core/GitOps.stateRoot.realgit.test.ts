/**
 * Real-git regression for `resolveStateRoot`.
 *
 * The unit tests in GitOps.test.ts mock `node:child_process`, so they prove the
 * branching but not that the actual `git rev-parse --show-toplevel` invocation is
 * correct. This file spawns REAL git against a throwaway repo to prove the
 * end-to-end behavior the fix exists for: a subdirectory cwd resolves to the
 * repo's worktree root, and a non-git directory falls back to the input verbatim.
 *
 * Deliberately NOT mocking child_process (own file, so the global mock in
 * GitOps.test.ts does not apply). Git isolation (HOME / config) comes from the
 * monorepo-wide test/gitEnv.ts wired into cli/vite.config.ts.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetStateRootCache, resolveStateRoot } from "./GitOps.js";

describe("resolveStateRoot (real git)", () => {
	const created: string[] = [];

	beforeEach(() => {
		resetStateRootCache();
	});

	afterEach(() => {
		for (const dir of created.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "jolli-stateroot-"));
		created.push(dir);
		return dir;
	}

	it("anchors a subdirectory to the git worktree root", () => {
		const repo = makeTempDir();
		execFileSync("git", ["init"], { cwd: repo, stdio: ["ignore", "ignore", "ignore"] });
		const deep = join(repo, "sub", "deeper");
		mkdirSync(deep, { recursive: true });

		// Compare against git's own toplevel for the repo so path form (git emits
		// forward slashes; on macOS the temp dir may be under a /private symlink)
		// matches regardless of platform.
		const expectedRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: repo,
			encoding: "utf-8",
		}).trim();

		expect(resolveStateRoot(deep)).toBe(expectedRoot);
	});

	it("falls back to the input path for a non-git directory", () => {
		const plain = makeTempDir();
		expect(resolveStateRoot(plain)).toBe(plain);
	});

	// Regression for the ownership-ledger defect: a post-commit hook in a linked
	// worktree runs with GIT_DIR exported, the detached worker inherits it, and the
	// resolver's git fallback used to forward it — so `rev-parse` answered for the
	// ambient repo instead of the asked-about directory, breaking the ledger's keys.
	// With GIT_DIR set, the FS fast path declines (gitLocationIsOverridden), so this
	// exercises exactly that fallback; the strip is what keeps it correct.
	it("ignores an inherited GIT_DIR and resolves the asked-about directory's own repo", () => {
		const repoA = makeTempDir();
		execFileSync("git", ["init"], { cwd: repoA, stdio: ["ignore", "ignore", "ignore"] });
		const repoB = makeTempDir();
		execFileSync("git", ["init"], { cwd: repoB, stdio: ["ignore", "ignore", "ignore"] });
		const deepB = join(repoB, "sub", "deeper");
		mkdirSync(deepB, { recursive: true });
		const expectedB = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: repoB,
			encoding: "utf-8",
		}).trim();

		const savedGitDir = process.env.GIT_DIR;
		try {
			process.env.GIT_DIR = join(repoA, ".git"); // as a hook running in repoA would export
			resetStateRootCache();
			// Without the strip, GIT_DIR=repoA would misdirect this to repoA (or to the
			// cwd itself); with it, we get repoB's real toplevel.
			expect(resolveStateRoot(deepB)).toBe(expectedB);
		} finally {
			if (savedGitDir === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = savedGitDir;
			resetStateRootCache();
		}
	});
});

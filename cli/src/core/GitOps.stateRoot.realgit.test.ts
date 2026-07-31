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
});

/**
 * Shape tests for the two release guards both plugin publish libs carry.
 *
 * These are shell scripts driving an irreversible, user-visible publish, and the
 * failures they had were of the "reports success, ships nothing / ships a
 * downgrade" kind — which no build or unit test can see. Pinned as source shape,
 * the same technique `CodexPluginManifest.test.ts` uses for the inventories.
 *
 * 1. The "nothing changed" early exit ran NO staged assertion unless it also had
 *    an unpushed commit. A destination `.gitignore` matching a required file
 *    keeps it out of the index, so `git add -A` stages nothing, the diff is
 *    empty, and the run prints "already up to date" and exits 0 — the assertion
 *    that exists to catch exactly that never runs.
 *
 * 2. The version baseline was `${last_msg#release: <prefix> }`, i.e. the last
 *    commit with the prefix stripped, guarded by `[ "$last_msg" != "$last_version" ]`.
 *    When the destination's last commit is NOT a release commit (a README fix, a
 *    merge), the strip is a no-op, that test is false, the whole `&&` chain short
 *    circuits, and a downgrade publishes unguarded. The baseline has to be looked
 *    UP in history, not read off the tip.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const lib = (tree: string): string => readFileSync(join(repoRoot, tree, "scripts", "_publish-lib.sh"), "utf-8");

/** The `publish_git_repo` body — where both guards live. */
function publishGitRepoBody(tree: string): string {
	return lib(tree).split("publish_git_repo() {")[1]?.split("\n}")[0] ?? "";
}

/**
 * The `if git … diff --cached --quiet; then … fi` branch: the "nothing changed"
 * exit. The two trees end it differently — codex runs inside a subshell and
 * `exit 0`s, claude `return 0`s — so the cut accepts either.
 */
function nothingChangedBranch(tree: string): string {
	const afterCheck = publishGitRepoBody(tree).split("diff --cached --quiet; then")[1] ?? "";
	return afterCheck.split(/\bexit 0\b|\breturn 0\b/u)[0] ?? "";
}

describe.each(["claude-plugin", "codex-plugin"])("%s publish guards", (tree) => {
	it("asserts the staged inventory before the nothing-changed exit", () => {
		const branch = nothingChangedBranch(tree);
		expect(branch).not.toBe("");
		// The two trees name their staged-inventory assertion differently
		// (`publish_assert_staged` vs `publish_assert_dist_staged`).
		const assertion = /publish_assert(?:_dist)?_staged/u;
		expect(branch).toMatch(assertion);
		// Ahead of the unpushed check where there is one (codex), so it runs on EVERY
		// such exit and not only when a local commit happens to need pushing.
		if (branch.includes("publish_has_unpushed")) {
			expect(branch.search(assertion)).toBeLessThan(branch.indexOf("publish_has_unpushed"));
		}
	});

	it("looks the version baseline up in history instead of reading the tip", () => {
		const body = publishGitRepoBody(tree);
		expect(body).toContain("--grep=");
		// The tip-stripping form is what silently disabled the guard.
		expect(body).not.toMatch(/git log -1 --format=%s 2>\/dev\/null/u);
	});
});

/**
 * Shape tests for the release guards all three plugin publish libs carry.
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
 *
 * 3. The Codex prod release committed a Finder `.DS_Store` into the marketplace
 *    repo root. rsync's `--exclude '.DS_Store'` also shields the destination's
 *    own copy from `--delete`, and `add -A` runs with the global ignore switched
 *    off, so any destination without its own `.gitignore` staged it. The libs
 *    now drop it from the index between `add -A` and the nothing-changed check.
 *    That position is load-bearing: after the check, a `.DS_Store`-only change
 *    would skip the "already up to date" exit and reach the commit (and, on prod,
 *    the version guard) with nothing left to commit.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const lib = (tree: string): string => readFileSync(join(repoRoot, tree, "scripts", "_publish-lib.sh"), "utf-8");

/** A top-level shell function's body, cut at its closing `}` in column 0. */
function functionBody(tree: string, name: string): string {
	return lib(tree).split(`${name}() {`)[1]?.split("\n}")[0] ?? "";
}

/** The `publish_git_repo` body — where the guards live. */
function publishGitRepoBody(tree: string): string {
	return functionBody(tree, "publish_git_repo");
}

/**
 * The `if git … diff --cached --quiet; then … fi` branch: the "nothing changed"
 * exit. The trees end it differently — codex and cursor run inside a subshell
 * and `exit 0`, claude does `return 0` — so the cut accepts either.
 */
function nothingChangedBranch(tree: string): string {
	const afterCheck = publishGitRepoBody(tree).split("diff --cached --quiet; then")[1] ?? "";
	return afterCheck.split(/\bexit 0\b|\breturn 0\b/u)[0] ?? "";
}

describe.each(["claude-plugin", "codex-plugin", "cursor-plugin"])("%s publish guards", (tree) => {
	it("asserts the staged inventory before the nothing-changed exit", () => {
		const branch = nothingChangedBranch(tree);
		expect(branch).not.toBe("");
		// The trees name their staged-inventory assertion differently
		// (`publish_assert_staged` vs `publish_assert_dist_staged`).
		const assertion = /publish_assert(?:_dist)?_staged/u;
		expect(branch).toMatch(assertion);
		// Ahead of the unpushed check where there is one (codex, cursor), so it runs on
		// EVERY such exit and not only when a local commit happens to need pushing.
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

	it("drops .DS_Store from the index between add -A and the nothing-changed check", () => {
		const body = publishGitRepoBody(tree);
		const add = body.indexOf("add -A");
		const drop = body.indexOf("publish_unstage_os_cruft");
		const check = body.indexOf("diff --cached --quiet");
		expect(add).toBeGreaterThan(-1);
		expect(drop).toBeGreaterThan(add);
		expect(check).toBeGreaterThan(drop);
		// One staging command only, so nothing can stage around the filter. Comment
		// lines are skipped: the claude body mentions `git add -A` in prose.
		const stagingLines = body.split("\n").filter((line) => /^\s*git\b.*\badd\b/u.test(line));
		expect(stagingLines).toHaveLength(1);
	});

	it("unstages every .DS_Store without failing when there is none", () => {
		const helper = functionBody(tree, "publish_unstage_os_cruft");
		// `**/` also matches zero directories, so the root copy is covered too.
		expect(helper).toContain("':(glob)**/.DS_Store'");
		expect(helper).toContain("--cached");
		// Without it, the usual no-match case exits non-zero and `set -e` aborts
		// every publish.
		expect(helper).toContain("--ignore-unmatch");
	});
});

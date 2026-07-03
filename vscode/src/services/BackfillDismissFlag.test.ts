import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBackfillDismissFlag, writeBackfillDismissFlag } from "./BackfillDismissFlag.js";

describe("BackfillDismissFlag", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "jolli-bf-dismiss-"));
		// The marker lives under the shared git common dir, so the repo must be a
		// git repo for `git rev-parse --git-common-dir` to resolve it.
		execFileSync("git", ["init", "-q"], { cwd });
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("reads false when no marker exists", async () => {
		expect(await readBackfillDismissFlag(cwd)).toBe(false);
	});

	it("writes the marker under the shared .git common dir and reads back true", async () => {
		await writeBackfillDismissFlag(cwd, true);
		expect(await readBackfillDismissFlag(cwd)).toBe(true);
		// Repo-wide location: <git-common-dir>/jollimemory/backfill-card-dismissed.
		const markerPath = join(cwd, ".git", "jollimemory", "backfill-card-dismissed");
		expect(existsSync(markerPath)).toBe(true);
		// Body is an ISO timestamp (human-debug only) — existence is the boolean.
		expect(readFileSync(markerPath, "utf8").trim()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("clears the marker and reads back false", async () => {
		await writeBackfillDismissFlag(cwd, true);
		await writeBackfillDismissFlag(cwd, false);
		expect(await readBackfillDismissFlag(cwd)).toBe(false);
	});

	it("clearing an already-absent marker is a no-op (no throw)", async () => {
		await expect(writeBackfillDismissFlag(cwd, false)).resolves.toBeUndefined();
		expect(await readBackfillDismissFlag(cwd)).toBe(false);
	});

	it("falls back to the per-project .jolli dir when the dir is not a git repo", async () => {
		// A non-git temp dir: `git rev-parse --git-common-dir` fails → markerDir()
		// falls back to <cwd>/.jolli/jollimemory (inert, since the card never shows there).
		const nonGit = mkdtempSync(join(tmpdir(), "jolli-bf-nogit-"));
		try {
			expect(await readBackfillDismissFlag(nonGit)).toBe(false);
			await writeBackfillDismissFlag(nonGit, true);
			expect(await readBackfillDismissFlag(nonGit)).toBe(true);
			expect(existsSync(join(nonGit, ".jolli", "jollimemory", "backfill-card-dismissed"))).toBe(true);
			expect(existsSync(join(nonGit, ".git"))).toBe(false); // never created a bogus .git
		} finally {
			rmSync(nonGit, { recursive: true, force: true });
		}
	});

	it("is shared across worktrees of the same repo (linked worktree resolves to the same marker)", async () => {
		// Dismiss from the main worktree, then add a linked worktree and confirm the
		// marker is visible there too (git-common-dir is shared) — the repo-wide contract.
		execFileSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], {
			cwd,
			env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
		});
		await writeBackfillDismissFlag(cwd, true);
		const wt = mkdtempSync(join(tmpdir(), "jolli-bf-wt-"));
		try {
			execFileSync("git", ["worktree", "add", "-q", wt, "HEAD"], { cwd });
			expect(await readBackfillDismissFlag(wt)).toBe(true);
		} finally {
			rmSync(wt, { recursive: true, force: true });
		}
	});
});

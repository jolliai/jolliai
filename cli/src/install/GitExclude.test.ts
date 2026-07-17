/**
 * GitExclude tests.
 *
 * The helpers shell out to `git rev-parse --git-path info/exclude` to find
 * the right exclude file (linked worktrees and submodules don't have a plain
 * `<projectDir>/.git/info/exclude`). Tests stand up real git repos in temp
 * dirs so the integration with git is exercised end-to-end.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addGitExcludePaths,
	normalizeGitPathOutput,
	removeGitExcludePaths,
	resolveGitExcludePath,
	updateGitExclude,
} from "./GitExclude.js";

const execFileAsync = promisify(execFile);

let tempDir: string;

async function gitInit(dir: string): Promise<void> {
	// `-c init.defaultBranch=main` keeps the test deterministic across the
	// user's local git config (some folks default to `master`).
	await execFileAsync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", dir], { windowsHide: true });
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "jolli-git-exclude-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

// ─── normalizeGitPathOutput ────────────────────────────────────────────────

describe("normalizeGitPathOutput", () => {
	it("returns a win32-style absolute path unchanged", () => {
		// Standard `git rev-parse` output on Windows with native Windows git.
		const out = normalizeGitPathOutput("C:\\Users\\u\\repo\\.git\\info\\exclude", "/tmp/proj");
		expect(out).toBe("C:\\Users\\u\\repo\\.git\\info\\exclude");
	});

	it("returns a POSIX-style absolute path unchanged (Windows + Git Bash case)", () => {
		// Git Bash on Windows can emit `/c/Users/.../info/exclude`. Node's win32
		// `isAbsolute` rejects this form, so the posix.isAbsolute fallback in
		// `normalizeGitPathOutput` is what keeps the path from being wrongly
		// join()'d under projectDir.
		const out = normalizeGitPathOutput("/c/Users/u/repo/.git/info/exclude", "C:\\tmp\\proj");
		expect(out).toBe("/c/Users/u/repo/.git/info/exclude");
	});

	it("joins a relative path under projectDir", () => {
		const out = normalizeGitPathOutput(".git/info/exclude", "/tmp/proj");
		// `join` normalizes the separator per platform; check the suffix in a
		// separator-agnostic way.
		expect(out.replace(/\\/g, "/")).toBe("/tmp/proj/.git/info/exclude");
	});
});

// ─── resolveGitExcludePath ─────────────────────────────────────────────────

describe("resolveGitExcludePath", () => {
	it("returns the absolute path to .git/info/exclude in a regular repo", async () => {
		await gitInit(tempDir);
		const resolved = await resolveGitExcludePath(tempDir);
		expect(resolved).not.toBeNull();
		// On Windows git emits forward slashes; check the suffix in a separator-
		// agnostic way.
		expect(resolved?.replace(/\\/g, "/")).toMatch(/\.git\/info\/exclude$/);
	});

	it("returns null when projectDir is not inside a git repo", async () => {
		// tempDir is freshly created, no `git init`, so `git rev-parse` fails.
		const resolved = await resolveGitExcludePath(tempDir);
		expect(resolved).toBeNull();
	});

	it("returns null when given a path that doesn't exist", async () => {
		const resolved = await resolveGitExcludePath(join(tempDir, "nonexistent-subdir"));
		expect(resolved).toBeNull();
	});
});

// ─── updateGitExclude — fresh writes ───────────────────────────────────────

describe("updateGitExclude — fresh writes", () => {
	it("creates the managed block when info/exclude doesn't exist yet", async () => {
		await gitInit(tempDir);
		// `git init` creates a default exclude with comments. Remove it to
		// simulate the no-file case.
		const fs = await import("node:fs/promises");
		const excludePath = (await resolveGitExcludePath(tempDir)) as string;
		await fs.rm(excludePath, { force: true });

		const ok = await updateGitExclude(tempDir, ["/.agents/skills/jolli-recall/"]);
		expect(ok).toBe(true);

		const written = readFileSync(excludePath, "utf-8");
		expect(written).toContain("# >>> jolli skill exclude >>>");
		expect(written).toContain("/.agents/skills/jolli-recall/");
		expect(written).toContain("# <<< jolli skill exclude <<<");
	});

	it("appends the block when info/exclude exists with user content", async () => {
		await gitInit(tempDir);
		const excludePath = (await resolveGitExcludePath(tempDir)) as string;
		// Plant user content. Note `info/exclude` is a regular file, no special
		// handling needed.
		await writeFile(excludePath, "# user comment\nmy-personal-ignore\n", "utf-8");

		const ok = await updateGitExclude(tempDir, ["/.agents/skills/jolli-recall/"]);
		expect(ok).toBe(true);

		const written = readFileSync(excludePath, "utf-8");
		// User content preserved on top.
		expect(written.startsWith("# user comment\nmy-personal-ignore\n")).toBe(true);
		// Block appended.
		expect(written).toMatch(
			/# >>> jolli skill exclude >>>\n\/\.agents\/skills\/jolli-recall\/\n# <<< jolli skill exclude <<</,
		);
	});

	it("appends the block when info/exclude has no trailing newline", async () => {
		await gitInit(tempDir);
		const excludePath = (await resolveGitExcludePath(tempDir)) as string;
		// Plant content with NO trailing newline.
		await writeFile(excludePath, "user-line", "utf-8");

		const ok = await updateGitExclude(tempDir, ["/.agents/skills/jolli-recall/"]);
		expect(ok).toBe(true);

		const written = readFileSync(excludePath, "utf-8");
		// Separator newline must be inserted before the block so the user's
		// last line and the block-start marker aren't smashed together.
		expect(written.startsWith("user-line\n# >>> jolli skill exclude >>>")).toBe(true);
	});

	it("writes all paths in the order given", async () => {
		await gitInit(tempDir);
		const paths = [
			"/.agents/skills/jolli-recall/",
			"/.agents/skills/jolli-search/",
			"/.claude/skills/jolli-recall/",
			"/.claude/skills/jolli-search/",
		];
		const ok = await updateGitExclude(tempDir, paths);
		expect(ok).toBe(true);

		const excludePath = (await resolveGitExcludePath(tempDir)) as string;
		const written = readFileSync(excludePath, "utf-8");
		// All 4 paths present.
		for (const p of paths) {
			expect(written).toContain(p);
		}
		// And in the same relative order.
		const positions = paths.map((p) => written.indexOf(p));
		const sorted = [...positions].sort((a, b) => a - b);
		expect(positions).toEqual(sorted);
	});
});

// ─── updateGitExclude — idempotency and replacement ────────────────────────

describe("updateGitExclude — idempotency", () => {
	it("running twice with the same paths is a no-op (file content unchanged)", async () => {
		await gitInit(tempDir);
		const paths = ["/.agents/skills/jolli-recall/", "/.claude/skills/jolli-recall/"];
		await updateGitExclude(tempDir, paths);
		const excludePath = (await resolveGitExcludePath(tempDir)) as string;
		const first = readFileSync(excludePath, "utf-8");

		await updateGitExclude(tempDir, paths);
		const second = readFileSync(excludePath, "utf-8");

		expect(second).toBe(first);
	});

	it("rewrites the block when the path list changes (e.g. a skill removed)", async () => {
		await gitInit(tempDir);
		const excludePath = (await resolveGitExcludePath(tempDir)) as string;
		await updateGitExclude(tempDir, [
			"/.agents/skills/jolli-recall/",
			"/.agents/skills/jolli-search/",
			"/.agents/skills/jolli-old-removed/",
		]);

		await updateGitExclude(tempDir, ["/.agents/skills/jolli-recall/", "/.agents/skills/jolli-search/"]);
		const written = readFileSync(excludePath, "utf-8");

		expect(written).toContain("/.agents/skills/jolli-recall/");
		expect(written).toContain("/.agents/skills/jolli-search/");
		// Stale entry got removed during the rewrite.
		expect(written).not.toContain("/.agents/skills/jolli-old-removed/");
		// Exactly one managed block (no duplicates).
		expect(written.match(/# >>> jolli skill exclude >>>/g)?.length).toBe(1);
		expect(written.match(/# <<< jolli skill exclude <<</g)?.length).toBe(1);
	});

	it("preserves user content above and below the managed block during a rewrite", async () => {
		await gitInit(tempDir);
		const excludePath = (await resolveGitExcludePath(tempDir)) as string;
		await writeFile(
			excludePath,
			"# user comment top\n*.user-pattern\n# >>> jolli skill exclude >>>\n/.agents/skills/jolli-old/\n# <<< jolli skill exclude <<<\n# user comment bottom\n",
			"utf-8",
		);

		await updateGitExclude(tempDir, ["/.agents/skills/jolli-recall/"]);
		const written = readFileSync(excludePath, "utf-8");

		expect(written).toContain("# user comment top");
		expect(written).toContain("*.user-pattern");
		expect(written).toContain("# user comment bottom");
		expect(written).toContain("/.agents/skills/jolli-recall/");
		expect(written).not.toContain("/.agents/skills/jolli-old/");
	});
});

// ─── addGitExcludePaths — union / merge semantics ──────────────────────────

describe("addGitExcludePaths", () => {
	it("creates the managed block when none exists", async () => {
		await gitInit(tempDir);
		const ok = await addGitExcludePaths(tempDir, ["/.claude/skills/jolli/"]);
		expect(ok).toBe(true);

		const excludePath = (await resolveGitExcludePath(tempDir)) as string;
		const written = readFileSync(excludePath, "utf-8");
		expect(written).toContain("# >>> jolli skill exclude >>>");
		expect(written).toContain("/.claude/skills/jolli/");
	});

	it("unions new paths in WITHOUT dropping existing managed paths", async () => {
		await gitInit(tempDir);
		// A prior full `jolli enable` populated a larger block.
		const full = ["/.agents/skills/jolli-recall/", "/.agents/skills/jolli-search/", "/.claude/skills/jolli/"];
		await updateGitExclude(tempDir, full);

		// The plugin's git-hooks-only path adds only its umbrella entry.
		await addGitExcludePaths(tempDir, ["/.claude/skills/jolli/"]);

		const excludePath = (await resolveGitExcludePath(tempDir)) as string;
		const written = readFileSync(excludePath, "utf-8");
		// Every prior entry survives — the block was NOT shrunk to the one added.
		for (const p of full) {
			expect(written).toContain(p);
		}
		// Still exactly one managed block.
		expect(written.match(/# >>> jolli skill exclude >>>/g)?.length).toBe(1);
	});

	it("is a no-op when the added path is already present (no churn each SessionStart)", async () => {
		await gitInit(tempDir);
		// Full-install set already contains the plugin umbrella entry.
		await updateGitExclude(tempDir, ["/.agents/skills/jolli-recall/", "/.claude/skills/jolli/"]);
		const excludePath = (await resolveGitExcludePath(tempDir)) as string;
		const before = readFileSync(excludePath, "utf-8");

		const ok = await addGitExcludePaths(tempDir, ["/.claude/skills/jolli/"]);
		expect(ok).toBe(true);
		const after = readFileSync(excludePath, "utf-8");
		// Byte-identical: the M1 regression — the plugin re-running enable on every
		// SessionStart must not rewrite the file.
		expect(after).toBe(before);
	});

	it("appends a genuinely new path after the existing ones", async () => {
		await gitInit(tempDir);
		await addGitExcludePaths(tempDir, ["/.claude/skills/jolli/"]);
		await addGitExcludePaths(tempDir, ["/.agents/skills/jolli/"]);

		const excludePath = (await resolveGitExcludePath(tempDir)) as string;
		const written = readFileSync(excludePath, "utf-8");
		expect(written.indexOf("/.claude/skills/jolli/")).toBeLessThan(written.indexOf("/.agents/skills/jolli/"));
		expect(written.match(/# >>> jolli skill exclude >>>/g)?.length).toBe(1);
	});

	it("returns false (no throw) when projectDir is not a git repo", async () => {
		const ok = await addGitExcludePaths(tempDir, ["/.claude/skills/jolli/"]);
		expect(ok).toBe(false);
	});
});

// ─── updateGitExclude — failure modes ──────────────────────────────────────

describe("updateGitExclude — failure modes", () => {
	it("returns false (no throw) when projectDir is not a git repo", async () => {
		// tempDir has no `.git` — `git rev-parse` will error.
		const ok = await updateGitExclude(tempDir, ["/.agents/skills/jolli-recall/"]);
		expect(ok).toBe(false);
	});

	it("returns false when projectDir doesn't exist at all", async () => {
		const ok = await updateGitExclude(join(tempDir, "nonexistent"), ["/.agents/skills/jolli-recall/"]);
		expect(ok).toBe(false);
	});
});

// ─── updateGitExclude — linked worktree path ───────────────────────────────

describe("updateGitExclude — linked worktree", () => {
	it("writes to the main repo's info/exclude when invoked from a linked worktree", async () => {
		await gitInit(tempDir);
		// Need an initial commit so `git worktree add` succeeds.
		const fs = await import("node:fs/promises");
		await fs.writeFile(join(tempDir, "README.md"), "init\n");
		await execFileAsync("git", ["-C", tempDir, "add", "README.md"], { windowsHide: true });
		await execFileAsync(
			"git",
			["-C", tempDir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
			{ windowsHide: true },
		);

		const wtDir = join(tempDir, "wt");
		await execFileAsync("git", ["-C", tempDir, "worktree", "add", "-b", "branch-x", wtDir], { windowsHide: true });

		const ok = await updateGitExclude(wtDir, ["/.agents/skills/jolli-recall/"]);
		expect(ok).toBe(true);

		// `info/` lives under the COMMON git dir (main repo's .git/info/),
		// not the per-worktree dir. resolveGitExcludePath delegates to
		// `git rev-parse --git-path info/exclude` so this should resolve
		// to the main repo's exclude file.
		const wtExcludePath = (await resolveGitExcludePath(wtDir)) as string;
		expect(wtExcludePath).not.toBeNull();
		expect(existsSync(wtExcludePath)).toBe(true);

		const written = readFileSync(wtExcludePath, "utf-8");
		expect(written).toContain("/.agents/skills/jolli-recall/");
	});
});

// ─── removeGitExcludePaths ─────────────────────────────────────────────────

describe("removeGitExcludePaths", () => {
	it("removes only the named paths, keeping the other managed entries", async () => {
		await gitInit(tempDir);
		await updateGitExclude(tempDir, [
			"/.claude/skills/jolli/",
			"/.agents/skills/jolli/",
			"/.claude/skills/jolli-recall/",
			"/.agents/skills/jolli-recall/",
		]);

		const ok = await removeGitExcludePaths(tempDir, ["/.claude/skills/jolli/", "/.agents/skills/jolli/"]);
		expect(ok).toBe(true);

		const excludePath = (await resolveGitExcludePath(tempDir)) as string;
		const written = readFileSync(excludePath, "utf-8");
		// Umbrella lines gone…
		expect(written).not.toContain("/.claude/skills/jolli/\n");
		expect(written).not.toContain("/.agents/skills/jolli/\n");
		// …siblings and markers preserved.
		expect(written).toContain("/.claude/skills/jolli-recall/");
		expect(written).toContain("/.agents/skills/jolli-recall/");
		expect(written).toContain("# >>> jolli skill exclude >>>");
		expect(written).toContain("# <<< jolli skill exclude <<<");
	});

	it("drops the whole block (markers included) when the last managed path is removed", async () => {
		await gitInit(tempDir);
		const excludePath = (await resolveGitExcludePath(tempDir)) as string;
		await writeFile(excludePath, "my-personal-ignore\n", "utf-8");
		await updateGitExclude(tempDir, ["/.claude/skills/jolli/"]);

		const ok = await removeGitExcludePaths(tempDir, ["/.claude/skills/jolli/", "/.agents/skills/jolli/"]);
		expect(ok).toBe(true);

		const written = readFileSync(excludePath, "utf-8");
		expect(written).not.toContain("# >>> jolli skill exclude >>>");
		expect(written).not.toContain("# <<< jolli skill exclude <<<");
		// Unrelated user content survives.
		expect(written).toContain("my-personal-ignore");
	});

	it("is a no-op when there is no managed block", async () => {
		await gitInit(tempDir);
		const excludePath = (await resolveGitExcludePath(tempDir)) as string;
		await writeFile(excludePath, "just-user-content\n", "utf-8");

		const ok = await removeGitExcludePaths(tempDir, ["/.claude/skills/jolli/"]);
		expect(ok).toBe(true);
		expect(readFileSync(excludePath, "utf-8")).toBe("just-user-content\n");
	});

	it("returns true when the exclude file does not exist", async () => {
		await gitInit(tempDir);
		const fs = await import("node:fs/promises");
		const excludePath = (await resolveGitExcludePath(tempDir)) as string;
		await fs.rm(excludePath, { force: true });

		const ok = await removeGitExcludePaths(tempDir, ["/.claude/skills/jolli/"]);
		expect(ok).toBe(true);
	});

	it("returns false when projectDir is not a git repo", async () => {
		// No gitInit — resolveGitExcludePath returns null.
		const ok = await removeGitExcludePaths(tempDir, ["/.claude/skills/jolli/"]);
		expect(ok).toBe(false);
	});
});

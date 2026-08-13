/**
 * The hand-built fixtures in `GitFsLayout.test.ts` encode our READING of git's
 * on-disk layout. These pin that reading against git itself, which is the only
 * thing that makes the rest of them evidence rather than a self-consistent
 * guess: a parser and a fixture both written from memory agree with each other
 * and with nothing else.
 *
 * Split out from the unit file (and listed in `SLOW_TEST_FILES`) because these
 * three cases drive real `git init` / `worktree add` subprocesses — ~2 s against
 * the unit file's ~100 ms, the same load profile the other real-git files carry.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBranchFromFs, readHeadHashFromFs, resolveGitFsLayout } from "./GitFsLayout.js";

/** An env with none of the git location vars set — the normal case. */
const CLEAN_ENV: NodeJS.ProcessEnv = {};

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "gitfs-real-")));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("against real git", () => {
	function git(cwd: string, ...args: string[]): string {
		return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
	}

	/** Whether git exits non-zero. Swallows stderr, which `execFileSync` inherits. */
	function gitFails(cwd: string, ...args: string[]): boolean {
		try {
			execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
			return false;
		} catch {
			return true;
		}
	}

	function seedRealRepo(dir: string): void {
		mkdirSync(dir, { recursive: true });
		git(dir, "init", "-q", "-b", "main");
		writeFileSync(join(dir, "f.txt"), "hello\n");
		git(dir, "add", "f.txt");
		git(dir, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "first");
	}

	it("agrees with rev-parse and branch --show-current in a plain repo", () => {
		const repo = join(root, "repo");
		seedRealRepo(repo);

		const layout = resolveGitFsLayout(repo, { env: CLEAN_ENV });
		expect(layout).not.toBeNull();
		const resolved = layout as NonNullable<typeof layout>;
		expect(resolved.commonDir).toBe(resolve(repo, git(repo, "rev-parse", "--git-common-dir")));
		expect(readBranchFromFs(resolved)).toBe(git(repo, "branch", "--show-current"));
		expect(readHeadHashFromFs(resolved)).toBe(git(repo, "rev-parse", "HEAD"));
	});

	it("agrees with git inside a linked worktree", () => {
		const repo = join(root, "repo");
		seedRealRepo(repo);
		const wt = join(root, "wt");
		git(repo, "worktree", "add", "-q", "-b", "feature/x", wt);

		const layout = resolveGitFsLayout(wt, { env: CLEAN_ENV, realpath: true });
		expect(layout).not.toBeNull();
		const resolved = layout as NonNullable<typeof layout>;
		expect(resolved.worktreeRoot).toBe(resolve(git(wt, "rev-parse", "--show-toplevel")));
		expect(resolved.commonDir).toBe(resolve(wt, git(wt, "rev-parse", "--git-common-dir")));
		expect(readBranchFromFs(resolved)).toBe("feature/x");
		expect(readHeadHashFromFs(resolved)).toBe(git(wt, "rev-parse", "HEAD"));
	});

	it("declines a skeleton .git git itself rejects, and accepts the same path once initialised", () => {
		// The one case where "a `.git` directory exists" and "git says this is a
		// repository" come apart — an interrupted clone or a half-synced tree. Pinned
		// here rather than in the unit file because the claim being made is about
		// git's behaviour, not ours.
		const dir = join(root, "skeleton");
		mkdirSync(join(dir, ".git"), { recursive: true });

		expect(gitFails(dir, "rev-parse", "--git-dir")).toBe(true);
		expect(resolveGitFsLayout(dir, { env: CLEAN_ENV })).toBeNull();

		git(dir, "init", "-q", "-b", "main");

		expect(git(dir, "rev-parse", "--git-dir")).toBe(".git");
		expect(resolveGitFsLayout(dir, { env: CLEAN_ENV })).not.toBeNull();
	});

	it("agrees with git after the branch ref has been packed", () => {
		const repo = join(root, "repo");
		seedRealRepo(repo);
		git(repo, "pack-refs", "--all");

		const layout = resolveGitFsLayout(repo, { env: CLEAN_ENV });
		expect(readHeadHashFromFs(layout as NonNullable<typeof layout>)).toBe(git(repo, "rev-parse", "HEAD"));
	});
});

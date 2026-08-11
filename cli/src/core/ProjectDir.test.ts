import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncHidden = vi.fn();
vi.mock("../util/Subprocess.js", () => ({
	execFileSyncHidden: (...args: unknown[]) => execFileSyncHidden(...(args as [])),
}));

const { __resetProjectDirCache, resolveProjectDir, resolveProjectDirInfo } = await import("./ProjectDir.js");

beforeEach(() => {
	execFileSyncHidden.mockReset();
	__resetProjectDirCache();
});

afterEach(() => {
	__resetProjectDirCache();
});

describe("resolveProjectDir", () => {
	it("returns the git worktree root, trimmed of its newline", () => {
		execFileSyncHidden.mockReturnValue("/repo/worktree\n");
		expect(resolveProjectDir()).toBe("/repo/worktree");
		expect(execFileSyncHidden).toHaveBeenCalledWith("git", ["rev-parse", "--show-toplevel"], expect.anything());
	});

	it("captures git's stderr so a non-repo cwd cannot leak 'fatal:' to the terminal", () => {
		// A stray git complaint on a CLI's stderr shows up before any of Jolli's own
		// output; on the MCP path it would land in a host's server log.
		execFileSyncHidden.mockReturnValue("/repo\n");
		resolveProjectDir();
		expect(execFileSyncHidden).toHaveBeenCalledWith(
			"git",
			expect.anything(),
			expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
		);
	});

	it("falls back to process.cwd() outside a git repo", () => {
		execFileSyncHidden.mockImplementation(() => {
			throw new Error("fatal: not a git repository");
		});
		expect(resolveProjectDir()).toBe(process.cwd());
	});

	it("caches, so the startup path spawns git once rather than once per caller", () => {
		// ~40 call sites reach this on the startup path; without the cache each
		// would pay its own subprocess.
		execFileSyncHidden.mockReturnValue("/repo\n");
		resolveProjectDir();
		resolveProjectDir();
		resolveProjectDir();
		expect(execFileSyncHidden).toHaveBeenCalledTimes(1);
	});

	it("caches the fallback too, so a non-repo run does not retry git every call", () => {
		execFileSyncHidden.mockImplementation(() => {
			throw new Error("nope");
		});
		resolveProjectDir();
		resolveProjectDir();
		expect(execFileSyncHidden).toHaveBeenCalledTimes(1);
	});

	it("re-resolves after the cache is cleared", () => {
		execFileSyncHidden.mockReturnValue("/first\n");
		expect(resolveProjectDir()).toBe("/first");
		__resetProjectDirCache();
		execFileSyncHidden.mockReturnValue("/second\n");
		expect(resolveProjectDir()).toBe("/second");
	});
});

describe("resolveProjectDirInfo", () => {
	// `resolveProjectDir` collapses two different situations onto one string: a
	// real worktree root, and `process.cwd()` because git said no. Callers that
	// only need a directory cannot tell them apart, and the MCP proxy must —
	// a daemon keyed on a non-repo directory answers for the wrong thing.
	it("reports fromGit when git answered with a worktree root", () => {
		execFileSyncHidden.mockReturnValue("/repo/worktree\n");
		expect(resolveProjectDirInfo()).toEqual({ dir: "/repo/worktree", fromGit: true });
	});

	it("reports fromGit: false when the cwd fallback was used", () => {
		execFileSyncHidden.mockImplementation(() => {
			throw new Error("fatal: not a git repository");
		});
		expect(resolveProjectDirInfo()).toEqual({ dir: process.cwd(), fromGit: false });
	});

	it("shares ONE cache with resolveProjectDir, so git is still spawned once", () => {
		// Two caches would mean two `git rev-parse` subprocesses on the startup
		// path — the exact cost the cache exists to remove.
		execFileSyncHidden.mockReturnValue("/repo\n");
		resolveProjectDir();
		resolveProjectDirInfo();
		expect(execFileSyncHidden).toHaveBeenCalledTimes(1);
	});
});

describe("CliUtils re-export", () => {
	it("exposes the SAME function, so there is one cache and not two", async () => {
		// The function moved here to keep the MCP proxy's import graph leaf-only;
		// `CliUtils` re-exports it for the existing call sites. Two copies would
		// mean two caches and two git spawns per process.
		const cliUtils = await import("../commands/CliUtils.js");
		expect(cliUtils.resolveProjectDir).toBe(resolveProjectDir);
	});
});

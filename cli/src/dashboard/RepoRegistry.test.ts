import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/GitOps.js", () => ({
	getProjectRootDir: vi.fn(),
}));
vi.mock("../core/GitRemoteUtils.js", () => ({
	getCanonicalRepoUrl: vi.fn(),
	deriveRepoNameFromUrl: vi.fn(
		(url: string) =>
			url
				.split("/")
				.pop()
				?.replace(/\.git$/, "") ?? "",
	),
}));

import { getProjectRootDir } from "../core/GitOps.js";
import { getCanonicalRepoUrl } from "../core/GitRemoteUtils.js";
import {
	deregisterRepo,
	deriveRepoName,
	ensureWorktreeListed,
	existingWorktrees,
	getRepoRegistryPath,
	hasLiveWorktree,
	listActiveRepos,
	readRegistryInstanceId,
	readRepoRegistry,
	registerRepo,
	resolveRepoIdentity,
	sameRecordedRoot,
	stampRegistryInstanceId,
} from "./RepoRegistry.js";

let configDir: string;

beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), "jolli-reg-"));
	vi.mocked(getProjectRootDir).mockResolvedValue("/home/dev/jolli");
	vi.mocked(getCanonicalRepoUrl).mockResolvedValue("https://github.com/jolliai/jolliai");
});

afterEach(() => {
	rmSync(configDir, { recursive: true, force: true });
});

describe("resolveRepoIdentity", () => {
	it("uses the canonical remote URL when one exists", async () => {
		const { identity, remoteUrl } = await resolveRepoIdentity("/home/dev/jolli");
		expect(identity).toBe("https://github.com/jolliai/jolliai");
		expect(remoteUrl).toBe("https://github.com/jolliai/jolliai");
	});

	it("hashes the worktree path for a repo with no remote (file:// fallback)", async () => {
		vi.mocked(getCanonicalRepoUrl).mockResolvedValue("file:///home/dev/local-only");
		const { identity, remoteUrl } = await resolveRepoIdentity("/home/dev/local-only");
		expect(identity).toMatch(/^local:[0-9a-f]{32}$/);
		expect(remoteUrl).toBeUndefined();
	});

	it("hashes the path when the remote resolves to an empty string", async () => {
		vi.mocked(getCanonicalRepoUrl).mockResolvedValue("");
		const { identity } = await resolveRepoIdentity("/home/dev/x");
		expect(identity).toMatch(/^local:/);
	});

	it("hashes the path when git itself fails", async () => {
		vi.mocked(getCanonicalRepoUrl).mockRejectedValue(new Error("not a git repo"));
		const { identity } = await resolveRepoIdentity("/tmp/not-a-repo");
		expect(identity).toMatch(/^local:/);
	});

	it("produces the same identity for the same path in either separator style", async () => {
		vi.mocked(getCanonicalRepoUrl).mockRejectedValue(new Error("no remote"));
		const posix = await resolveRepoIdentity("/home/dev/x");
		vi.mocked(getCanonicalRepoUrl).mockRejectedValue(new Error("no remote"));
		const windows = await resolveRepoIdentity("\\home\\dev\\x");
		expect(posix.identity).toBe(windows.identity);
	});
});

describe("deriveRepoName", () => {
	it("prefers the remote's repo name", () => {
		expect(deriveRepoName("/w", "https://github.com/jolliai/jolliai.git")).toBe("jolliai");
	});

	it("falls back to the directory basename", () => {
		expect(deriveRepoName("/home/dev/myrepo")).toBe("myrepo");
		expect(deriveRepoName("/home/dev/myrepo/")).toBe("myrepo");
	});
});

describe("registerRepo / listActiveRepos / deregisterRepo", () => {
	it("registers the repo with mode 0600 and lists it as active", async () => {
		const entry = await registerRepo({ cwd: "/home/dev/jolli/sub", configDir, now: () => new Date(0) });
		expect(entry).toEqual({
			repoIdentity: "https://github.com/jolliai/jolliai",
			repoName: "jolliai",
			worktreeRoot: "/home/dev/jolli",
			// The set of checkouts, so a second clone of the same remote does not
			// silently displace this one.
			worktrees: ["/home/dev/jolli"],
			remoteUrl: "https://github.com/jolliai/jolliai",
			enabledAt: "1970-01-01T00:00:00.000Z",
		});
		const active = await listActiveRepos(configDir);
		expect(active).toEqual([entry]);
	});

	it("re-registering updates in place — no duplicate rows, original enabledAt kept", async () => {
		await registerRepo({ cwd: "/home/dev/jolli", configDir, now: () => new Date(0) });
		await registerRepo({ cwd: "/home/dev/jolli", configDir, now: () => new Date(60_000) });
		const registry = await readRepoRegistry(configDir);
		expect(registry.repos).toHaveLength(1);
		expect(registry.repos[0].enabledAt).toBe("1970-01-01T00:00:00.000Z");
	});

	it("deregister marks disabled without deleting; re-register reactivates", async () => {
		await registerRepo({ cwd: "/home/dev/jolli", configDir, now: () => new Date(0) });
		const identity = await deregisterRepo({ cwd: "/home/dev/jolli", configDir, now: () => new Date(1000) });
		expect(identity).toBe("https://github.com/jolliai/jolliai");
		expect(await listActiveRepos(configDir)).toEqual([]);
		const registry = await readRepoRegistry(configDir);
		expect(registry.repos[0].disabledAt).toBe("1970-01-01T00:00:01.000Z");

		await registerRepo({ cwd: "/home/dev/jolli", configDir });
		expect(await listActiveRepos(configDir)).toHaveLength(1);
	});

	it("deregistering an unknown repo returns null and writes nothing", async () => {
		expect(await deregisterRepo({ cwd: "/home/dev/jolli", configDir })).toBeNull();
	});
});

describe("readRepoRegistry — resilience", () => {
	it("treats a missing file as empty", async () => {
		expect(await readRepoRegistry(configDir)).toEqual({ version: 1, repos: [] });
	});

	it("treats corrupt JSON as empty rather than failing every read path", async () => {
		writeFileSync(getRepoRegistryPath(configDir), "{nope");
		expect(await readRepoRegistry(configDir)).toEqual({ version: 1, repos: [] });
	});

	it("treats a wrong shape (no repos array) as empty", async () => {
		writeFileSync(getRepoRegistryPath(configDir), JSON.stringify({ version: 1, repos: "oops" }));
		expect(await readRepoRegistry(configDir)).toEqual({ version: 1, repos: [] });
	});

	it("round-trips through the file it wrote", async () => {
		await registerRepo({ cwd: "/home/dev/jolli", configDir });
		const raw = JSON.parse(readFileSync(getRepoRegistryPath(configDir), "utf-8"));
		expect(raw.version).toBe(1);
		expect(raw.repos).toHaveLength(1);
	});
});

describe("multiple checkouts of one project (§10.2)", () => {
	it("keeps both worktrees when a second clone of the same remote registers", async () => {
		// Same remote → same identity. Before this fix the second registration
		// overwrote `worktreeRoot` and the first clone became invisible.
		// `getProjectRootDir` is what maps cwd → main worktree, so drive it per call.
		vi.mocked(getProjectRootDir).mockResolvedValueOnce("/home/dev/jolli");
		await registerRepo({ cwd: "/home/dev/jolli", configDir, now: () => new Date(0) });
		vi.mocked(getProjectRootDir).mockResolvedValueOnce("/home/dev/jolli-2");
		const second = await registerRepo({ cwd: "/home/dev/jolli-2", configDir, now: () => new Date(60_000) });

		const registry = await readRepoRegistry(configDir);
		expect(registry.repos).toHaveLength(1);
		expect(second.worktrees).toEqual(["/home/dev/jolli", "/home/dev/jolli-2"]);
		// The newest is still the display path.
		expect(second.worktreeRoot).toBe("/home/dev/jolli-2");
	});

	it("does not duplicate a path when the same checkout re-registers", async () => {
		await registerRepo({ cwd: "/home/dev/jolli", configDir, now: () => new Date(0) });
		const again = await registerRepo({ cwd: "/home/dev/jolli/sub", configDir, now: () => new Date(1) });
		expect(again.worktrees).toEqual(["/home/dev/jolli"]);
	});

	it("replaces a differently-spelled repeat instead of listing it twice", async () => {
		// The spelling is whatever the calling surface passed; a trailing slash
		// folds on every platform, so this asserts the fix without depending on
		// the host's case sensitivity (see `sameRecordedRoot` below for that half).
		vi.mocked(getProjectRootDir).mockResolvedValueOnce("/home/dev/jolli/");
		await registerRepo({ cwd: "/home/dev/jolli/", configDir, now: () => new Date(0) });
		vi.mocked(getProjectRootDir).mockResolvedValueOnce("/home/dev/jolli");
		const again = await registerRepo({ cwd: "/home/dev/jolli", configDir, now: () => new Date(1) });
		// One entry, and the freshest spelling won.
		expect(again.worktrees).toEqual(["/home/dev/jolli"]);
	});

	it("ensureWorktreeListed no-ops on a checkout already listed under another spelling", async () => {
		await registerRepo({ cwd: "/home/dev/jolli", configDir, now: () => new Date(0) });
		vi.mocked(getProjectRootDir).mockResolvedValueOnce("/home/dev/jolli/");
		const entry = await ensureWorktreeListed({ cwd: "/home/dev/jolli/", configDir });
		// Adds nothing AND rewrites nothing — the stored spelling is untouched.
		expect(entry?.worktrees).toEqual(["/home/dev/jolli"]);
	});

	it("sameRecordedRoot folds drive-letter case on win32 but not on linux", () => {
		expect(sameRecordedRoot("C:\\Users\\dev\\repo", "c:\\Users\\dev\\repo", "win32")).toBe(true);
		expect(sameRecordedRoot("C:\\Users\\dev\\repo", "c:\\Users\\dev\\repo", "linux")).toBe(false);
		// Separator and trailing slash fold everywhere; distinct paths never do.
		expect(sameRecordedRoot("/home/dev/repo/", "/home/dev/repo", "linux")).toBe(true);
		expect(sameRecordedRoot("/home/dev/repo", "/home/dev/other", "win32")).toBe(false);
	});

	it("existingWorktrees drops paths that no longer exist, newest first", () => {
		const real = mkdtempSync(join(tmpdir(), "jolli-wt-"));
		try {
			const repo = {
				repoIdentity: "id",
				repoName: "r",
				worktreeRoot: real,
				worktrees: ["/definitely/gone", real],
				enabledAt: "t",
			};
			expect(existingWorktrees(repo)).toEqual([real]);
		} finally {
			rmSync(real, { recursive: true, force: true });
		}
	});

	it("hasLiveWorktree separates a gone repo from one the fallback makes look alive", () => {
		const real = mkdtempSync(join(tmpdir(), "jolli-wt-"));
		try {
			const alive = {
				repoIdentity: "id",
				repoName: "r",
				worktreeRoot: "/gone",
				worktrees: ["/gone", real],
				enabledAt: "t",
			};
			const gone = {
				repoIdentity: "id",
				repoName: "r",
				worktreeRoot: "/gone",
				worktrees: ["/gone", "/also-gone"],
				enabledAt: "t",
			};
			expect(hasLiveWorktree(alive)).toBe(true);
			expect(hasLiveWorktree(gone)).toBe(false);
			// The distinction `existingWorktrees` cannot make: its non-empty fallback
			// answers the same shape for both.
			expect(existingWorktrees(gone)).toEqual(["/gone"]);
			// Legacy entry with no `worktrees` list falls back to the root, here too.
			expect(hasLiveWorktree({ repoIdentity: "id", repoName: "r", worktreeRoot: real, enabledAt: "t" })).toBe(
				true,
			);
		} finally {
			rmSync(real, { recursive: true, force: true });
		}
	});

	it("falls back to worktreeRoot for entries written before `worktrees` existed", () => {
		const repo = { repoIdentity: "id", repoName: "r", worktreeRoot: "/legacy", enabledAt: "t" };
		expect(existingWorktrees(repo)).toEqual(["/legacy"]);
	});

	it("ensureWorktreeListed unions a second clone WITHOUT reactivating a disabled repo", async () => {
		// The hook self-registration path for clone B of a known remote: it must
		// make B visible to the cutover's source enumeration, but a stray hook
		// must not be able to undo a `jolli disable` the way registerRepo would.
		await registerRepo({ cwd: "/home/dev/jolli", configDir, now: () => new Date(0) });
		await deregisterRepo({ cwd: "/home/dev/jolli", configDir, now: () => new Date(1_000) });
		vi.mocked(getProjectRootDir).mockResolvedValueOnce("/home/dev/jolli-2");
		const entry = await ensureWorktreeListed({ cwd: "/home/dev/jolli-2", configDir });
		expect(entry?.worktrees).toEqual(["/home/dev/jolli", "/home/dev/jolli-2"]);
		// Still disabled — union-only.
		expect(entry?.disabledAt).toBe(new Date(1_000).toISOString());
		expect(await listActiveRepos(configDir)).toHaveLength(0);
	});

	it("ensureWorktreeListed no-ops for an already-listed checkout and preserves the entry", async () => {
		const first = await registerRepo({ cwd: "/home/dev/jolli", configDir, now: () => new Date(0) });
		const again = await ensureWorktreeListed({ cwd: "/home/dev/jolli", configDir });
		expect(again).toEqual(first);
		expect((await readRepoRegistry(configDir)).repos).toHaveLength(1);
	});

	it("ensureWorktreeListed leaves the identity-unknown case to registerRepo", async () => {
		expect(await ensureWorktreeListed({ cwd: "/home/dev/jolli", configDir })).toBeNull();
		expect((await readRepoRegistry(configDir)).repos).toHaveLength(0);
	});

	it("ensureWorktreeListed extends a pre-`worktrees` legacy entry from its worktreeRoot", async () => {
		const path = getRepoRegistryPath(configDir);
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				repos: [
					{
						repoIdentity: "https://github.com/jolliai/jolliai",
						repoName: "jolliai",
						worktreeRoot: "/legacy",
						enabledAt: "t",
					},
				],
			}),
		);
		vi.mocked(getProjectRootDir).mockResolvedValueOnce("/home/dev/jolli-2");
		const entry = await ensureWorktreeListed({ cwd: "/home/dev/jolli-2", configDir });
		expect(entry?.worktrees).toEqual(["/legacy", "/home/dev/jolli-2"]);
	});

	it("treats an empty `worktrees` array like an absent one", () => {
		// Distinct from the legacy case above: the key exists but carries nothing,
		// which a truthiness check alone would accept and then sweep zero paths.
		const repo = { repoIdentity: "id", repoName: "r", worktreeRoot: "/only", worktrees: [], enabledAt: "t" };
		expect(existingWorktrees(repo)).toEqual(["/only"]);
	});

	it("never returns empty — a repo whose paths all vanished still reports its root", () => {
		// Returning [] would make backfill silently sweep nothing; returning the
		// recorded path lets git fail loudly instead.
		const repo = {
			repoIdentity: "id",
			repoName: "r",
			worktreeRoot: "/gone-too",
			worktrees: ["/gone-a", "/gone-b"],
			enabledAt: "t",
		};
		expect(existingWorktrees(repo)).toEqual(["/gone-too"]);
	});
});

describe("instance id stamp", () => {
	it("stamps idempotently and survives a repo registration rewrite", async () => {
		expect(await readRegistryInstanceId(configDir)).toBeNull();
		await stampRegistryInstanceId("id-1", configDir);
		await stampRegistryInstanceId("id-1", configDir); // no-op path
		expect(await readRegistryInstanceId(configDir)).toBe("id-1");
		// A later registration must not erase the witness (read preserves it).
		await registerRepo({ cwd: "/home/dev/jolli", configDir, now: () => new Date(0) });
		expect(await readRegistryInstanceId(configDir)).toBe("id-1");
	});
});

describe("a registry the writers could not read", () => {
	it("refuses the write instead of read-modify-writing over an empty one", async () => {
		await registerRepo({ cwd: "/home/dev/jolli", configDir, now: () => new Date(0) });
		await stampRegistryInstanceId("id-1", configDir);
		// A torn write leaves unparsable JSON. Reads still fail open (nothing is
		// lost by showing no repos); a WRITER must not, or it cements the loss.
		writeFileSync(getRepoRegistryPath(configDir), "{ truncated");
		vi.mocked(getProjectRootDir).mockResolvedValue("/home/dev/other");
		await expect(registerRepo({ cwd: "/home/dev/other", configDir })).rejects.toThrow();
		await expect(stampRegistryInstanceId("id-2", configDir)).rejects.toThrow();
		await expect(deregisterRepo({ cwd: "/home/dev/other", configDir })).rejects.toThrow();
		await expect(ensureWorktreeListed({ cwd: "/home/dev/other", configDir })).rejects.toThrow();
		// The damaged file is still there to be repaired, not overwritten.
		expect(readFileSync(getRepoRegistryPath(configDir), "utf-8")).toBe("{ truncated");
		expect((await readRepoRegistry(configDir)).repos).toEqual([]);
	});
});

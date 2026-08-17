import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	isDisposableRepo,
	listActiveRepos,
	type RegisteredRepo,
	readRegistryInstanceId,
	readRepoRegistry,
	registerRepo,
	removeRepoFromRegistry,
	removeReposFromRegistry,
	repairRegistryEntries,
	resolveRepoIdentity,
	sameRecordedRoot,
	stampRegistryInstanceId,
	tempRoots,
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

describe("isDisposableRepo", () => {
	const TEMP = "/tmp/jolli-fixtures";
	const disposable = (over: Partial<RegisteredRepo> = {}): RegisteredRepo => ({
		repoIdentity: "local:abc",
		repoName: "repo",
		worktreeRoot: `${TEMP}/gone/repo`,
		enabledAt: "t",
		...over,
	});
	const opts = { tempRoots: [TEMP], platform: "linux" as const };

	it("accepts a local: identity whose every recorded path is a vanished temp path", () => {
		expect(isDisposableRepo(disposable(), opts)).toBe(true);
	});

	it("refuses a remote-backed identity on an unmarked temp path", () => {
		// The identity is shared between clones — the `repos` row is keyed by it — so
		// forgetting it on this evidence alone could take another clone's history.
		expect(isDisposableRepo(disposable({ repoIdentity: "https://github.com/a/b" }), opts)).toBe(false);
	});

	it("accepts a remote-backed identity when every path names a known throwaway", () => {
		// A vanished `%TEMP%/jolli-cutover-…/repo` is a fixture whichever remote it
		// was cloned from, which is the one inference narrow enough to act on.
		const repo = disposable({
			repoIdentity: "https://github.com/a/b",
			worktreeRoot: `${TEMP}/jolli-cutover-sG1Rx7/repo`,
			worktrees: [`${TEMP}/jolli-cutover-sG1Rx7/repo`],
		});
		expect(isDisposableRepo(repo, opts)).toBe(true);
	});

	it("accepts an agent scratchpad checkout under any remote", () => {
		// The real shape this widening was added for.
		const path = `${TEMP}/claude/c--jolli-project-jolliai/3e49b42d/scratchpad/pr/c2`;
		const repo = disposable({
			repoIdentity: "https://github.com/fake/shared",
			worktreeRoot: path,
			worktrees: [path],
		});
		expect(isDisposableRepo(repo, opts)).toBe(true);
	});

	it("refuses a remote-backed entry that mixes a marked path with an unmarked one", () => {
		// One unmarked temp path is enough to make "no other clone exists" unproven.
		const repo = disposable({
			repoIdentity: "https://github.com/a/b",
			worktreeRoot: `${TEMP}/jolli-cutover-x/repo`,
			worktrees: [`${TEMP}/jolli-cutover-x/repo`, `${TEMP}/plain/repo`],
		});
		expect(isDisposableRepo(repo, opts)).toBe(false);
	});

	it("refuses a remote-backed entry recorded AT the temp root itself", () => {
		// `isUnder` accepts the root, but there is no segment below it to carry a
		// marker — so the identity clause still has nothing to go on.
		const repo = disposable({ repoIdentity: "https://github.com/a/b", worktreeRoot: TEMP, worktrees: [TEMP] });
		expect(isDisposableRepo(repo, opts)).toBe(false);
	});

	it("looks for the marker BELOW the temp root, not in the root's own name", () => {
		// A test that injects its own `jolli-…` mkdtemp dir as the temp root must not
		// see everything inside it marked — that is the distinction being tested.
		const injected = `${TEMP}/jolli-forget-abc`;
		const repo = disposable({
			repoIdentity: "https://github.com/a/b",
			worktreeRoot: `${injected}/gone`,
			worktrees: [`${injected}/gone`],
		});
		expect(isDisposableRepo(repo, { tempRoots: [injected], platform: "linux" })).toBe(false);
		// Measured against the REAL temp root, the same path is a fixture.
		expect(isDisposableRepo(repo, opts)).toBe(true);
	});

	it("refuses an entry that mixes a temp path with a real one", () => {
		const repo = disposable({ worktrees: ["/home/dev/real", `${TEMP}/gone/repo`] });
		expect(isDisposableRepo(repo, opts)).toBe(false);
	});

	it("judges worktreeRoot too, not only the worktrees list", () => {
		// A `worktrees` list that happens to be all-temp says nothing about a
		// `worktreeRoot` pointing somewhere real.
		const repo = disposable({ worktreeRoot: "/home/dev/real", worktrees: [`${TEMP}/gone/repo`] });
		expect(isDisposableRepo(repo, opts)).toBe(false);
	});

	it("refuses a temp checkout that still exists — a session may be using it", () => {
		const live = mkdtempSync(join(tmpdir(), "jolli-live-"));
		try {
			const repo = disposable({ worktreeRoot: live, worktrees: [live] });
			expect(isDisposableRepo(repo, { tempRoots: [tmpdir()], platform: process.platform })).toBe(false);
		} finally {
			rmSync(live, { recursive: true, force: true });
		}
	});

	it("asks the SAME union about liveness that it asked about scope", () => {
		// The scope and identity clauses deliberately re-derive the claim rather than
		// trusting `registerRepo`'s "worktreeRoot is inside worktrees" invariant. The
		// liveness clause must not then rely on it: `hasLiveWorktree` reads
		// `recordedRepoPaths` alone, so an entry whose `worktrees` omits a LIVE
		// `worktreeRoot` would be pruned with its own checkout still on disk.
		const live = mkdtempSync(join(tmpdir(), "jolli-live-root-"));
		try {
			const repo = disposable({
				worktreeRoot: live,
				worktrees: [join(tmpdir(), "jolli-gone-fixture", "repo")],
			});
			expect(isDisposableRepo(repo, { tempRoots: [tmpdir()], platform: process.platform })).toBe(false);
		} finally {
			rmSync(live, { recursive: true, force: true });
		}
	});

	it("refuses a path that merely starts with the temp root's characters", () => {
		// `/tmp/jolli-fixtures-elsewhere` is not inside `/tmp/jolli-fixtures`; a
		// prefix test without the separator boundary would say it is.
		expect(isDisposableRepo(disposable({ worktreeRoot: `${TEMP}-elsewhere/repo` }), opts)).toBe(false);
	});

	it("folds case on win32 and not on linux", () => {
		const repo = disposable({ worktreeRoot: "C:\\Temp\\Fix\\repo", worktrees: ["C:\\Temp\\Fix\\repo"] });
		expect(isDisposableRepo(repo, { tempRoots: ["c:\\temp\\fix"], platform: "win32" })).toBe(true);
		expect(isDisposableRepo(repo, { tempRoots: ["c:\\temp\\fix"], platform: "linux" })).toBe(false);
	});

	it("defaults to the real temp roots and the host platform", () => {
		// The no-options call is what production makes; every case above names both,
		// so without this the defaults were never exercised.
		const gone = join(tmpdir(), "jolli-no-such-fixture-9f3a2c");
		expect(isDisposableRepo(disposable({ worktreeRoot: gone, worktrees: [gone] }))).toBe(true);
		expect(isDisposableRepo(disposable({ worktreeRoot: "/home/dev/real", worktrees: ["/home/dev/real"] }))).toBe(
			false,
		);
	});

	it("names the real temp dir and its resolved twin", () => {
		// Both spellings, so a macOS `/var` vs `/private/var` recording matches.
		const roots = tempRoots();
		expect(roots).toContain(tmpdir());
		expect(roots.length).toBeGreaterThanOrEqual(1);
		expect(new Set(roots).size).toBe(roots.length);
	});
});

describe("removeReposFromRegistry", () => {
	const seed = (identities: ReadonlyArray<string>): void => {
		writeFileSync(
			getRepoRegistryPath(configDir),
			JSON.stringify({
				version: 1,
				instanceId: "id-1",
				repos: identities.map((repoIdentity) => ({
					repoIdentity,
					repoName: "r",
					worktreeRoot: `/gone/${repoIdentity}`,
					enabledAt: "t",
				})),
			}),
		);
	};

	it("removes only the named entries and reports which were present", async () => {
		seed(["a", "b", "c"]);
		const removed = await removeReposFromRegistry(["a", "c", "never"], configDir);
		expect([...removed].sort()).toEqual(["a", "c"]);
		expect((await readRepoRegistry(configDir)).repos.map((r) => r.repoIdentity)).toEqual(["b"]);
	});

	it("preserves the instance-id witness", async () => {
		// A read-modify-write that dropped it would blind the deletion detector.
		seed(["a"]);
		await removeReposFromRegistry(["a"], configDir);
		expect(await readRegistryInstanceId(configDir)).toBe("id-1");
	});

	it("writes nothing when no identity matched", async () => {
		seed(["a"]);
		const before = readFileSync(getRepoRegistryPath(configDir), "utf-8");
		expect(await removeReposFromRegistry(["nope"], configDir)).toEqual([]);
		expect(readFileSync(getRepoRegistryPath(configDir), "utf-8")).toBe(before);
	});

	it("short-circuits an empty request without touching the file", async () => {
		expect(await removeReposFromRegistry([], configDir)).toEqual([]);
		expect(existsSync(getRepoRegistryPath(configDir))).toBe(false);
	});

	it("refuses to rewrite a registry it could not read", async () => {
		// Fail-open here would write back "everything except the ones I wanted",
		// i.e. delete every other repo. See readRepoRegistryStrict.
		writeFileSync(getRepoRegistryPath(configDir), "{ not json");
		await expect(removeReposFromRegistry(["a"], configDir)).rejects.toThrow();
	});

	it("removeRepoFromRegistry answers whether the one entry was there", async () => {
		seed(["a"]);
		expect(await removeRepoFromRegistry("a", configDir)).toBe(true);
		expect(await removeRepoFromRegistry("a", configDir)).toBe(false);
	});
});

describe("repairRegistryEntries", () => {
	let live: string;
	let temp: string;

	beforeEach(() => {
		temp = mkdtempSync(join(tmpdir(), "jolli-repair-"));
		live = join(temp, "live");
		mkdirSync(live, { recursive: true });
	});

	afterEach(() => {
		rmSync(temp, { recursive: true, force: true });
	});

	const seed = (repo: Partial<RegisteredRepo>): void => {
		writeFileSync(
			getRepoRegistryPath(configDir),
			JSON.stringify({
				version: 1,
				repos: [{ repoIdentity: "id", repoName: "r", worktreeRoot: live, enabledAt: "t", ...repo }],
			}),
		);
	};

	it("drops a vanished temp path merged into a real repo's worktrees", async () => {
		// The ticket's corrupted real entry: a genuine checkout with two fixture
		// paths in its list.
		const ghost = join(temp, "jolli-cutover-x", "repo");
		seed({ worktrees: [ghost, live] });

		const repairs = await repairRegistryEntries({ configDir, tempRoots: [temp], platform: process.platform });

		expect(repairs).toHaveLength(1);
		expect(repairs[0].droppedPaths).toEqual([ghost]);
		expect((await readRepoRegistry(configDir)).repos[0].worktrees).toEqual([live]);
	});

	it("keeps a vanished path that is NOT under a temp root", async () => {
		// An unmounted share comes back, and a checkout the list forgot is invisible
		// to the cutover's source enumeration.
		seed({ worktrees: ["/mnt/share/project", live] });
		const repairs = await repairRegistryEntries({ configDir, tempRoots: [temp], platform: process.platform });
		expect(repairs).toEqual([]);
		expect((await readRepoRegistry(configDir)).repos[0].worktrees).toEqual(["/mnt/share/project", live]);
	});

	it("collapses two spellings of one path, newest winning", async () => {
		const shouty = live.toUpperCase();
		seed({ worktrees: [shouty, live] });

		// No temp roots, because the two repair rules would otherwise interact and the
		// outcome would depend on the FILESYSTEM rather than on the `platform` argument.
		// Vanished-under-a-temp-root is checked first by design, and `isUnder` folds case
		// under win32 — so on a case-INSENSITIVE filesystem the shouty spelling exists and
		// reaches the collapse, while on a case-sensitive one it does not exist, matches
		// the temp root under win32 folding, and is dropped as a vanished fixture path
		// before the collapse is ever reached. That is what made this pass on Windows and
		// fail on CI. The temp rule has its own cases above; this one is about the collapse.
		const repairs = await repairRegistryEntries({ configDir, tempRoots: [], platform: "win32" });

		expect(repairs[0].collapsedPaths).toEqual([shouty]);
		expect((await readRepoRegistry(configDir)).repos[0].worktrees).toEqual([live]);
	});

	it("repoints a dead worktreeRoot at the newest live path", async () => {
		const dead = join(temp, "moved-away");
		seed({ worktreeRoot: dead, worktrees: [live, dead] });

		const repairs = await repairRegistryEntries({ configDir, tempRoots: [], platform: process.platform });

		expect(repairs[0].repointedTo).toBe(live);
		expect((await readRepoRegistry(configDir)).repos[0].worktreeRoot).toBe(live);
	});

	it("does not re-append a worktreeRoot it just dropped as a dead temp path", async () => {
		const ghost = join(temp, "jolli-cutover-y", "repo");
		seed({ worktreeRoot: ghost, worktrees: [live, ghost] });

		await repairRegistryEntries({ configDir, tempRoots: [temp], platform: process.platform });

		const entry = (await readRepoRegistry(configDir)).repos[0];
		expect(entry.worktrees).toEqual([live]);
		expect(entry.worktreeRoot).toBe(live);
	});

	it("re-adds a worktreeRoot the list never carried, keeping registerRepo's invariant", async () => {
		// `registerRepo` guarantees `worktreeRoot` is the last entry of `worktrees`;
		// a hand-edited or pre-`worktrees` entry can break that, and a repair must
		// not be the thing that leaves the displayed root out of the collected set.
		const other = join(temp, "other-clone");
		mkdirSync(other, { recursive: true });
		const ghost = join(temp, "jolli-cutover-w", "repo");
		seed({ worktreeRoot: live, worktrees: [ghost, other] });

		const repairs = await repairRegistryEntries({ configDir, tempRoots: [temp], platform: process.platform });

		expect(repairs[0].droppedPaths).toEqual([ghost]);
		expect(repairs[0].repointedTo).toBeUndefined();
		expect((await readRepoRegistry(configDir)).repos[0].worktrees).toEqual([other, live]);
	});

	it("leaves a wholly dead entry to forgetRepos", async () => {
		seed({ worktreeRoot: join(temp, "gone"), worktrees: [join(temp, "gone")] });
		expect(await repairRegistryEntries({ configDir, tempRoots: [], platform: process.platform })).toEqual([]);
	});

	it("takes no write lock for a dry run, and takes it for a real pass", async () => {
		// `jolli doctor` computes this preview on EVERY run, including a plain
		// read-only one — so taking the registry lock for it put a diagnostic into
		// contention with the `registerRepo` a post-commit hook runs concurrently.
		// A preview performs no write, and reads need no lock (writes are atomic).
		const locks = await import("../core/Locks.js");
		const spy = vi.spyOn(locks, "withRepoRegistryLock");
		const ghost = join(temp, "jolli-cutover-lock", "repo");
		seed({ worktrees: [ghost, live] });

		try {
			const preview = await repairRegistryEntries({
				configDir,
				tempRoots: [temp],
				platform: process.platform,
				dryRun: true,
			});
			expect(preview).toHaveLength(1);
			expect(spy).not.toHaveBeenCalled();

			await repairRegistryEntries({ configDir, tempRoots: [temp], platform: process.platform });
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
	});

	it("writes nothing when there is nothing to repair", async () => {
		seed({ worktrees: [live] });
		const before = readFileSync(getRepoRegistryPath(configDir), "utf-8");
		expect(await repairRegistryEntries({ configDir, tempRoots: [temp], platform: process.platform })).toEqual([]);
		expect(readFileSync(getRepoRegistryPath(configDir), "utf-8")).toBe(before);
	});

	it("defaults to the real temp roots and the host platform", async () => {
		// Same reason as the disposable predicate's own default case: production
		// passes neither, so the `??` sides need one call that omits them. The temp
		// dir this fixture lives in IS a real temp root, so the ghost is dropped.
		const ghost = join(temp, "jolli-cutover-default", "repo");
		seed({ worktrees: [ghost, live] });

		const repairs = await repairRegistryEntries({ configDir });

		expect(repairs).toHaveLength(1);
		expect(repairs[0].droppedPaths).toEqual([ghost]);
	});

	it("dryRun computes the same repairs and changes nothing on disk", async () => {
		const ghost = join(temp, "jolli-cutover-z", "repo");
		seed({ worktrees: [ghost, live] });
		const before = readFileSync(getRepoRegistryPath(configDir), "utf-8");

		const repairs = await repairRegistryEntries({
			configDir,
			tempRoots: [temp],
			platform: process.platform,
			dryRun: true,
		});

		expect(repairs).toHaveLength(1);
		expect(readFileSync(getRepoRegistryPath(configDir), "utf-8")).toBe(before);
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

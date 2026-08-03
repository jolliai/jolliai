import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Redirect the machine-global config dir to a temp folder so the push-control
// store (and its lock) never touch the real ~/.jolli during tests.
const { globalDirRef } = vi.hoisted(() => ({ globalDirRef: { path: "" } }));
vi.mock("./SessionTracker.js", async (orig) => {
	const actual = await orig<typeof import("./SessionTracker.js")>();
	return { ...actual, getGlobalConfigDir: () => globalDirRef.path };
});

// Real behaviour by default; wrapped so the identity memo can be observed (call
// counting) and so a resolution failure can be injected.
vi.mock("./GitRemoteUtils.js", async (orig) => {
	const actual = await orig<typeof import("./GitRemoteUtils.js")>();
	return { ...actual, getCanonicalRepoUrl: vi.fn(actual.getCanonicalRepoUrl) };
});

import { getCanonicalRepoUrl } from "./GitRemoteUtils.js";
import {
	__resetGateInputCache,
	applyPushDisabled,
	isOutboundPushAllowed,
	listPushControlRepos,
	PushDisabledError,
	readPushDisabledState,
	setRepoPushDisabledByIdentity,
} from "./PushControl.js";
import { getPushControlPath, setRepoPushDisabled } from "./PushControlStore.js";
import { writeManualDisableFlag } from "./RepoProfile.js";

describe("PushControl", () => {
	let repo: string;
	let globalDir: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "jolli-pushctl-repo-"));
		globalDir = mkdtempSync(join(tmpdir(), "jolli-pushctl-global-"));
		globalDirRef.path = globalDir;
		execFileSync("git", ["init", "-q"], { cwd: repo });
		// The gate memoizes its git-backed inputs per cwd for a few seconds; each test
		// gets a fresh temp repo, but reset anyway so no case can inherit a memo.
		__resetGateInputCache();
	});
	afterEach(() => {
		for (const d of [repo, globalDir]) rmSync(d, { recursive: true, force: true });
	});

	it("readPushDisabledState reflects the machine-global store (keyed by canonical URL)", async () => {
		expect(await readPushDisabledState(repo)).toEqual({ disabled: false });
		await applyPushDisabled(repo, true, "cli");
		// No `error` on a healthy read — that key's presence is what marks a value as
		// fail-closed rather than the user's choice.
		expect(await readPushDisabledState(repo)).toEqual({ disabled: true });
		await applyPushDisabled(repo, false, "cli");
		expect(await readPushDisabledState(repo)).toEqual({ disabled: false });
	});

	it("isOutboundPushAllowed is false once the repo is push-disabled", async () => {
		expect(await isOutboundPushAllowed(repo)).toBe(true);
		await applyPushDisabled(repo, true, "cli");
		expect(await isOutboundPushAllowed(repo)).toBe(false);
	});

	it("isOutboundPushAllowed is false when the repo is manually disabled (even if push-allowed)", async () => {
		await writeManualDisableFlag(repo, true);
		expect(await isOutboundPushAllowed(repo)).toBe(false);
	});

	it("fails CLOSED when the push-control store is corrupt/unreadable (P1)", async () => {
		// A present-but-unparseable store must NOT read as "allowed" — that would
		// silently disable the opt-out for every repo and let the drains leak.
		writeFileSync(join(globalDir, "push-control.json"), "{ not json");
		expect(await isOutboundPushAllowed(repo)).toBe(false);
		expect((await readPushDisabledState(repo)).disabled).toBe(true);
	});

	it("readPushDisabledState keeps the reason (with the store path) on a fail-closed read", async () => {
		// The whole point of the state form: one corrupt file makes EVERY repo read
		// OFF, so the surface must be able to say why and where.
		writeFileSync(join(globalDir, "push-control.json"), "{ not json");
		const state = await readPushDisabledState(repo);
		expect(state.disabled).toBe(true);
		expect(state.error).toContain(join(globalDir, "push-control.json"));
	});

	it("honors a push-control opt-out written by another process between two gate reads", async () => {
		// Only the repo identity is memoized; the store is read LIVE (spec 306), so a
		// toggle that lands mid-push must take effect with no cache reset in between.
		expect(await isOutboundPushAllowed(repo)).toBe(true);
		const identity = await getCanonicalRepoUrl(repo);
		await setRepoPushDisabled(identity, true, { globalDir: globalDir });
		expect(await isOutboundPushAllowed(repo)).toBe(false);
	});

	it("honors a manual disable written by another process IMMEDIATELY (never memoized)", async () => {
		// `manuallyDisabled` is the stop-ALL opt-out and its writers are other
		// processes (`jolli disable`, the VS Code / IntelliJ Disable commands), so an
		// in-process memo could not be invalidated airtight — any TTL would be a window
		// where a repo the user just disabled keeps pushing. Deliberately asserted with
		// NO cache reset: the second read must already see it.
		expect(await isOutboundPushAllowed(repo)).toBe(true);
		await writeManualDisableFlag(repo, true);
		expect(await isOutboundPushAllowed(repo)).toBe(false);
	});

	it("readPushDisabledState carries no error when the store reads cleanly", async () => {
		expect(await readPushDisabledState(repo)).toEqual({ disabled: false });
		await applyPushDisabled(repo, true, "cli");
		expect(await readPushDisabledState(repo)).toEqual({ disabled: true });
	});

	it("readPushDisabledState fails closed and stringifies a non-Error throw", async () => {
		// A thrown non-Error (a bare string from an over-eager `throw`) must still
		// produce a readable `error` alongside the fail-closed `disabled: true`.
		vi.mocked(getCanonicalRepoUrl).mockRejectedValueOnce("git exploded");
		expect(await readPushDisabledState(repo)).toEqual({ disabled: true, error: "git exploded" });
	});

	// The memo is per-cwd and never shrinks on its own, so a long-lived host that
	// walks many roots would grow it without bound. Past the cap, a miss also
	// drops whatever has expired.
	it("sweeps expired identities once the memo reaches its cap", async () => {
		// Mirrors PushControl's IDENTITY_CACHE_SWEEP_AT / GATE_IDENTITY_TTL_MS.
		const SWEEP_AT = 64;
		const TTL_MS = 5_000;
		// Distinct cwds inside ONE git repo: each is its own memo key, but only one
		// `git init` is paid. The clock is pinned so nothing expires mid-fill.
		const t0 = Date.now();
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
		const resolver = vi.mocked(getCanonicalRepoUrl);
		const realResolver = resolver.getMockImplementation();
		// Stub the resolution itself: filling the memo needs 65 distinct cwds, and
		// paying a `git config` spawn for each would add ~15s to the suite for no
		// extra coverage — the memo's behaviour is what's under test.
		resolver.mockImplementation(async (cwd: string) => `file://${cwd}`);
		try {
			for (let i = 0; i <= SWEEP_AT; i++) {
				const sub = join(repo, `sub-${i}`);
				mkdirSync(sub, { recursive: true });
				await readPushDisabledState(sub);
			}
			// The last iteration crossed the cap and swept — but nothing had expired,
			// so every entry survived and a repeat read is still served from the memo.
			const before = vi.mocked(getCanonicalRepoUrl).mock.calls.length;
			await readPushDisabledState(join(repo, "sub-0"));
			expect(vi.mocked(getCanonicalRepoUrl)).toHaveBeenCalledTimes(before);

			// Past the TTL the next miss evicts them, and sub-0 has to be resolved again.
			nowSpy.mockReturnValue(t0 + TTL_MS + 1);
			const sweeper = join(repo, "sweeper");
			mkdirSync(sweeper, { recursive: true });
			await readPushDisabledState(sweeper);
			await readPushDisabledState(join(repo, "sub-0"));
			expect(vi.mocked(getCanonicalRepoUrl).mock.calls.length).toBeGreaterThan(before);
		} finally {
			nowSpy.mockRestore();
			if (realResolver) resolver.mockImplementation(realResolver);
		}
	});

	it("setRepoPushDisabledByIdentity reports a rebuild from an unreadable store", async () => {
		await setRepoPushDisabledByIdentity("https://github.com/acme/other", true, "cli");
		writeFileSync(getPushControlPath(globalDir), "{ not json");
		const result = await setRepoPushDisabledByIdentity("https://github.com/acme/x", false, "vscode");
		expect(result.recoveredFromCorrupt).toBe(true);
	});

	describe("listPushControlRepos", () => {
		let localFolder: string;

		beforeEach(() => {
			localFolder = mkdtempSync(join(tmpdir(), "jolli-mb-"));
			const kbRoot = join(localFolder, "widgets");
			mkdirSync(join(kbRoot, ".jolli"), { recursive: true });
			writeFileSync(
				join(kbRoot, ".jolli", "config.json"),
				JSON.stringify({ repoName: "widgets", remoteUrl: "https://github.com/acme/widgets.git" }),
			);
		});
		afterEach(() => rmSync(localFolder, { recursive: true, force: true }));

		it("lists Memory Bank repos keyed by canonical identity, with live disabled state", async () => {
			const rows = await listPushControlRepos({ localFolder });
			expect(rows).toHaveLength(1);
			expect(rows[0].repoName).toBe("widgets");
			expect(rows[0].repoIdentity).toBe("https://github.com/acme/widgets");
			expect(rows[0].pushDisabled).toBe(false);

			await setRepoPushDisabledByIdentity(rows[0].repoIdentity, true, "vscode");
			const rows2 = await listPushControlRepos({ localFolder });
			expect(rows2[0].pushDisabled).toBe(true);
		});

		it("omits local-only repos (no remoteUrl → cannot key by identity)", async () => {
			const kbRoot = join(localFolder, "local-only");
			mkdirSync(join(kbRoot, ".jolli"), { recursive: true });
			writeFileSync(join(kbRoot, ".jolli", "config.json"), JSON.stringify({ repoName: "local-only" }));
			const rows = await listPushControlRepos({ localFolder });
			expect(rows.map((r) => r.repoName)).toEqual(["widgets"]);
		});

		// The load-bearing invariant of the whole feature: the key this list writes
		// by must be the key the GATE reads by. The list derives it from the Memory
		// Bank's stored `remoteUrl` while the gate derives it from `git config`, so a
		// row that fails to collapse onto the current repo would leave the user
		// toggling a checkbox that changes nothing for the repo they are in.
		it("collapses the current repo onto its Memory Bank row (list key == gate key)", async () => {
			execFileSync("git", ["remote", "add", "origin", "git@github.com:AcMe/Widgets.git"], { cwd: repo });
			// Deliberately a different transport AND casing from the stored
			// `https://github.com/acme/widgets.git`: both must canonicalize to one key.
			expect(await getCanonicalRepoUrl(repo)).toBe("https://github.com/acme/widgets");

			const rows = await listPushControlRepos({ localFolder, currentCwd: repo });
			expect(rows).toHaveLength(1); // collapsed, not duplicated
			expect(rows[0].repoIdentity).toBe("https://github.com/acme/widgets");
			expect(rows[0].isCurrentRepo).toBe(true);

			// And toggling that row is what the gate then reads.
			await setRepoPushDisabledByIdentity(rows[0].repoIdentity, true, "vscode");
			expect(await isOutboundPushAllowed(repo)).toBe(false);
		});

		it("appends the current repo when the Memory Bank has no row for it, sorted first", async () => {
			execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/other.git"], { cwd: repo });
			const rows = await listPushControlRepos({ localFolder, currentCwd: repo });
			expect(rows.map((r) => r.repoName)).toEqual(["other", "widgets"]); // current first
			expect(rows[0].isCurrentRepo).toBe(true);
			expect(rows[0].repoIdentity).toBe("https://github.com/acme/other");
			expect(rows[1].isCurrentRepo).toBe(false);
		});

		// Two non-current rows exercise the name tiebreak; the current repo (added
		// last, so it starts out AFTER them) exercises the other side of the
		// isCurrentRepo comparison.
		it("sorts the current repo first, then the rest by name", async () => {
			for (const name of ["alpha", "zulu"]) {
				const kbRoot = join(localFolder, name);
				mkdirSync(join(kbRoot, ".jolli"), { recursive: true });
				writeFileSync(
					join(kbRoot, ".jolli", "config.json"),
					JSON.stringify({ repoName: name, remoteUrl: `https://github.com/acme/${name}.git` }),
				);
			}
			execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/mine.git"], { cwd: repo });

			const rows = await listPushControlRepos({ localFolder, currentCwd: repo });
			expect(rows.map((r) => r.repoName)).toEqual(["mine", "alpha", "widgets", "zulu"]);
			expect(rows.map((r) => r.isCurrentRepo)).toEqual([true, false, false, false]);
		});

		// Same ordering rule from the other side: when the current repo COLLAPSES
		// onto an existing Memory Bank row it keeps that row's position in the
		// pre-sort list, so the comparator sees it as the second operand.
		it("keeps a collapsed current-repo row first even when it started ahead of the others", async () => {
			const kbRoot = join(localFolder, "alpha");
			mkdirSync(join(kbRoot, ".jolli"), { recursive: true });
			writeFileSync(
				join(kbRoot, ".jolli", "config.json"),
				JSON.stringify({ repoName: "alpha", remoteUrl: "https://github.com/acme/alpha.git" }),
			);
			execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/alpha.git"], { cwd: repo });

			const rows = await listPushControlRepos({ localFolder, currentCwd: repo });
			expect(rows.map((r) => r.repoName)).toEqual(["alpha", "widgets"]);
			expect(rows.map((r) => r.isCurrentRepo)).toEqual([true, false]);
		});

		it("still lists Memory Bank rows when the current repo's identity cannot be resolved", async () => {
			// A cwd that is not a repo (or a git failure) must not sink the whole
			// list — the current-repo row is simply omitted.
			vi.mocked(getCanonicalRepoUrl).mockRejectedValueOnce(new Error("not a git repository"));
			const rows = await listPushControlRepos({ localFolder, currentCwd: repo });
			expect(rows.map((r) => r.repoName)).toEqual(["widgets"]);
			expect(rows[0].isCurrentRepo).toBe(false);
		});

		it("still lists the current repo when it has no remote (file:// identity)", async () => {
			// Such a repo is absent from the Memory Bank rows (no `remoteUrl` to key
			// on) but must remain toggleable from the surface the user is standing in.
			const rows = await listPushControlRepos({ localFolder, currentCwd: repo });
			expect(rows).toHaveLength(2);
			expect(rows[0].isCurrentRepo).toBe(true);
			expect(rows[0].repoIdentity).toBe(await getCanonicalRepoUrl(repo));
			expect(rows[0].repoIdentity.startsWith("file://")).toBe(true);
		});
	});
});

describe("PushDisabledError", () => {
	// `name` is the ide-bridge wire contract: the envelope forwards it as
	// `data.errorName` and IntelliJ's `remapBridgeException` dispatches on this
	// exact string. Renaming the class without keeping this literal silently
	// downgrades every IDE host to its generic-failure path.
	it("carries the stable wire name IDE hosts dispatch on", () => {
		expect(new PushDisabledError().name).toBe("PushDisabledError");
		expect(new PushDisabledError()).toBeInstanceOf(Error);
	});

	it("defaults to a message naming the re-enable command, and accepts an override", () => {
		expect(new PushDisabledError().message).toMatch(/jolli push-control --enable/);
		expect(new PushDisabledError("nope").message).toBe("nope");
	});
});

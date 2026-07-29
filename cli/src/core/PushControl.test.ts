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
import { setRepoPushDisabled } from "./PushControlStore.js";
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

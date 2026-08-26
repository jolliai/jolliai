import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PushControlRepo } from "./PushControl.js";

const {
	mockReadRepoRegistry,
	mockHasLiveWorktree,
	mockExistingWorktrees,
	mockIsRepoDisabled,
	mockReadManualDisableFlagSync,
	mockFetchSpaceBindingStatus,
	mockFetchSpaceBindingStatusForUrl,
} = vi.hoisted(() => ({
	mockReadRepoRegistry: vi.fn(),
	mockHasLiveWorktree: vi.fn(),
	mockExistingWorktrees: vi.fn(),
	mockIsRepoDisabled: vi.fn(),
	mockReadManualDisableFlagSync: vi.fn(),
	mockFetchSpaceBindingStatus: vi.fn(),
	mockFetchSpaceBindingStatusForUrl: vi.fn(),
}));

vi.mock("../dashboard/RepoRegistry.js", () => ({
	readRepoRegistry: mockReadRepoRegistry,
	hasLiveWorktree: mockHasLiveWorktree,
	existingWorktrees: mockExistingWorktrees,
	isRepoDisabled: mockIsRepoDisabled,
}));

vi.mock("./RepoProfile.js", () => ({
	readManualDisableFlagSync: mockReadManualDisableFlagSync,
}));

vi.mock("./SpaceBindingStatus.js", () => ({
	fetchSpaceBindingStatus: mockFetchSpaceBindingStatus,
	fetchSpaceBindingStatusForUrl: mockFetchSpaceBindingStatusForUrl,
}));

// Partial: Concurrency.js and friends reach for other Logger exports, so only
// createLogger is swapped — enough to assert the ONE aggregated failure line.
const { mockLogWarn, mockLogDebug } = vi.hoisted(() => ({ mockLogWarn: vi.fn(), mockLogDebug: vi.fn() }));
vi.mock("../Logger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../Logger.js")>()),
	createLogger: () => ({ warn: mockLogWarn, debug: mockLogDebug, info: vi.fn(), error: vi.fn() }),
}));

import { resolveSpaceBindingsForRepos } from "./PushControlSpaces.js";

/**
 * The probe-options bag the fan-out threads into every probe so the per-repo
 * `warn` becomes one aggregated line (JOLLI-2152 follow-up). Asserted by SHAPE
 * rather than identity — the callers only care that a sink is supplied.
 */
function probeOpts() {
	return expect.objectContaining({ onFailure: expect.any(Function) });
}

function repo(overrides: Partial<PushControlRepo> = {}): PushControlRepo {
	return {
		repoIdentity: "https://github.com/acme/widgets",
		repoName: "widgets",
		pushDisabled: false,
		isCurrentRepo: false,
		...overrides,
	};
}

function registryEntry(identity: string, name: string, worktreeRoot: string, worktrees?: ReadonlyArray<string>) {
	return {
		repoIdentity: identity,
		repoName: name,
		worktreeRoot,
		worktrees: worktrees ?? [worktreeRoot],
		enabledAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("resolveSpaceBindingsForRepos", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockReadRepoRegistry.mockResolvedValue({ version: 1, repos: [] });
		mockIsRepoDisabled.mockReturnValue(false);
		mockReadManualDisableFlagSync.mockReturnValue(false);
		mockFetchSpaceBindingStatus.mockResolvedValue({ kind: "unbound", spaceCount: 1 });
		mockFetchSpaceBindingStatusForUrl.mockResolvedValue({ kind: "unbound", spaceCount: 1 });
	});

	it("returns an empty map and touches nothing when no jolliApiKey is configured", async () => {
		const result = await resolveSpaceBindingsForRepos([repo()], undefined);
		expect(result.size).toBe(0);
		expect(mockReadRepoRegistry).not.toHaveBeenCalled();
		expect(mockFetchSpaceBindingStatus).not.toHaveBeenCalled();
	});

	it("returns an empty map for an empty repo list", async () => {
		const result = await resolveSpaceBindingsForRepos([], "jk-abc");
		expect(result.size).toBe(0);
		expect(mockReadRepoRegistry).not.toHaveBeenCalled();
	});

	it("probes the current repo at the caller's own cwd, never via the registry", async () => {
		const current = repo({ repoIdentity: "https://github.com/acme/current", isCurrentRepo: true });
		mockFetchSpaceBindingStatus.mockResolvedValue({
			kind: "bound",
			spaceName: "Acme Core",
			canPush: true,
			canRebind: false,
		});

		const result = await resolveSpaceBindingsForRepos([current], "jk-abc", { currentCwd: "/workspace/current" });

		expect(mockFetchSpaceBindingStatus).toHaveBeenCalledWith("/workspace/current", "jk-abc", true, probeOpts());
		expect(result.get(current.repoIdentity)).toEqual({
			kind: "bound",
			spaceName: "Acme Core",
			canPush: true,
			canRebind: false,
		});
	});

	// An unbound repo with exactly one bindable Space auto-binds as a side
	// effect of the underlying frontDoor call (JOLLI-2152's original concern
	// about that was resolved by accepting the auto-bind rather than
	// suppressing it) — merely opening this display-only column can bind
	// another repo on the machine, and that's intended.
	it("probes a non-current repo live, at its newest live worktree from the registry", async () => {
		const other = repo({ repoIdentity: "https://github.com/acme/other" });
		mockReadRepoRegistry.mockResolvedValue({
			version: 1,
			repos: [
				registryEntry(other.repoIdentity, "other", "/repos/other-old", [
					"/repos/other-old",
					"/repos/other-new",
				]),
			],
		});
		mockHasLiveWorktree.mockReturnValue(true);
		mockExistingWorktrees.mockReturnValue(["/repos/other-new", "/repos/other-old"]);
		mockFetchSpaceBindingStatus.mockResolvedValue({
			kind: "bound",
			spaceName: "Acme Core",
			canPush: true,
			canRebind: false,
		});

		const result = await resolveSpaceBindingsForRepos([other], "jk-abc");

		expect(mockFetchSpaceBindingStatus).toHaveBeenCalledWith("/repos/other-new", "jk-abc", true, probeOpts());
		expect(result.get(other.repoIdentity)).toEqual({
			kind: "bound",
			spaceName: "Acme Core",
			canPush: true,
			canRebind: false,
		});
	});

	it("passes through whatever fetchSpaceBindingStatus answers for a non-current repo, unreachable included", async () => {
		const other = repo({ repoIdentity: "https://github.com/acme/other" });
		mockReadRepoRegistry.mockResolvedValue({
			version: 1,
			repos: [registryEntry(other.repoIdentity, "other", "/repos/other")],
		});
		mockHasLiveWorktree.mockReturnValue(true);
		mockExistingWorktrees.mockReturnValue(["/repos/other"]);
		mockFetchSpaceBindingStatus.mockResolvedValue({ kind: "unreachable" });

		const result = await resolveSpaceBindingsForRepos([other], "jk-abc");

		expect(result.get(other.repoIdentity)).toEqual({ kind: "unreachable" });
	});

	it("falls back to a URL-only live probe (no local checkout) when the registry has no live worktree for the repo", async () => {
		const other = repo({ repoIdentity: "https://github.com/acme/gone", repoName: "gone" });
		mockReadRepoRegistry.mockResolvedValue({
			version: 1,
			repos: [
				{
					repoIdentity: other.repoIdentity,
					repoName: "gone",
					worktreeRoot: "/repos/gone",
					enabledAt: "2026-01-01T00:00:00.000Z",
				},
			],
		});
		mockHasLiveWorktree.mockReturnValue(false);
		mockFetchSpaceBindingStatusForUrl.mockResolvedValue({ kind: "unbound", spaceCount: 2 });

		const result = await resolveSpaceBindingsForRepos([other], "jk-abc");

		expect(mockFetchSpaceBindingStatus).not.toHaveBeenCalled();
		expect(mockFetchSpaceBindingStatusForUrl).toHaveBeenCalledWith(
			"https://github.com/acme/gone",
			"gone",
			"jk-abc",
			probeOpts(),
		);
		expect(result.get(other.repoIdentity)).toEqual({ kind: "unbound", spaceCount: 2 });
	});

	it("falls back to a URL-only live probe when the repo has no registry entry at all", async () => {
		const stranger = repo({
			repoIdentity: "https://github.com/acme/never-registered",
			repoName: "never-registered",
		});
		mockFetchSpaceBindingStatusForUrl.mockResolvedValue({
			kind: "bound",
			spaceName: "Jolli Memory",
			canPush: true,
			canRebind: false,
		});

		const result = await resolveSpaceBindingsForRepos([stranger], "jk-abc");

		expect(mockFetchSpaceBindingStatus).not.toHaveBeenCalled();
		expect(mockFetchSpaceBindingStatusForUrl).toHaveBeenCalledWith(
			"https://github.com/acme/never-registered",
			"never-registered",
			"jk-abc",
			probeOpts(),
		);
		expect(result.get(stranger.repoIdentity)).toEqual({
			kind: "bound",
			spaceName: "Jolli Memory",
			canPush: true,
			canRebind: false,
		});
	});

	it("still resolves to unreachable when the URL-only probe itself fails (genuinely offline/unreachable)", async () => {
		const stranger = repo({ repoIdentity: "https://github.com/acme/never-registered" });
		mockFetchSpaceBindingStatusForUrl.mockResolvedValue({ kind: "unreachable" });

		const result = await resolveSpaceBindingsForRepos([stranger], "jk-abc");

		expect(result.get(stranger.repoIdentity)).toEqual({ kind: "unreachable" });
	});

	it("probes the current repo via URL when opts.currentCwd is not provided", async () => {
		const current = repo({ repoIdentity: "https://github.com/acme/current", isCurrentRepo: true });
		mockFetchSpaceBindingStatusForUrl.mockResolvedValue({
			kind: "bound",
			spaceName: "Acme Core",
			canPush: true,
			canRebind: false,
		});

		const result = await resolveSpaceBindingsForRepos([current], "jk-abc");

		expect(mockFetchSpaceBindingStatus).not.toHaveBeenCalled();
		expect(mockFetchSpaceBindingStatusForUrl).toHaveBeenCalledWith(
			current.repoIdentity,
			current.repoName,
			"jk-abc",
			probeOpts(),
		);
		expect(result.get(current.repoIdentity)).toEqual({
			kind: "bound",
			spaceName: "Acme Core",
			canPush: true,
			canRebind: false,
		});
	});

	it("a rejecting current-repo probe becomes unreachable without affecting a sibling's result", async () => {
		const current = repo({ repoIdentity: "https://github.com/acme/current", isCurrentRepo: true });
		const other = repo({ repoIdentity: "https://github.com/acme/other" });
		mockReadRepoRegistry.mockResolvedValue({
			version: 1,
			repos: [registryEntry(other.repoIdentity, "other", "/repos/other")],
		});
		mockHasLiveWorktree.mockReturnValue(true);
		mockExistingWorktrees.mockReturnValue(["/repos/other"]);
		mockFetchSpaceBindingStatus.mockImplementation(async (cwd: string) => {
			if (cwd === "/workspace/current") throw new Error("boom");
			return { kind: "bound", spaceName: "Acme Core", canPush: true, canRebind: false };
		});

		const result = await resolveSpaceBindingsForRepos([current, other], "jk-abc", {
			currentCwd: "/workspace/current",
		});

		expect(result.get(current.repoIdentity)).toEqual({ kind: "unreachable" });
		expect(result.get(other.repoIdentity)).toEqual({
			kind: "bound",
			spaceName: "Acme Core",
			canPush: true,
			canRebind: false,
		});
	});

	it("keys and values line up correctly across several repos, current and non-current alike", async () => {
		const a = repo({ repoIdentity: "https://github.com/acme/a", isCurrentRepo: true });
		const b = repo({ repoIdentity: "https://github.com/acme/b" });
		const c = repo({ repoIdentity: "https://github.com/acme/c" });
		mockReadRepoRegistry.mockResolvedValue({
			version: 1,
			repos: [registryEntry(b.repoIdentity, "b", "/repos/b"), registryEntry(c.repoIdentity, "c", "/repos/c")],
		});
		mockHasLiveWorktree.mockReturnValue(true);
		mockExistingWorktrees.mockImplementation((r: { worktreeRoot: string }) => [r.worktreeRoot]);
		mockFetchSpaceBindingStatus.mockImplementation(async (cwd: string) => ({
			kind: "bound",
			spaceName: cwd,
			canPush: true,
			canRebind: false,
		}));

		const result = await resolveSpaceBindingsForRepos([a, b, c], "jk-abc", { currentCwd: "/workspace/a" });

		expect(result.get(a.repoIdentity)).toEqual({
			kind: "bound",
			spaceName: "/workspace/a",
			canPush: true,
			canRebind: false,
		});
		expect(result.get(b.repoIdentity)).toEqual({
			kind: "bound",
			spaceName: "/repos/b",
			canPush: true,
			canRebind: false,
		});
		expect(result.get(c.repoIdentity)).toEqual({
			kind: "bound",
			spaceName: "/repos/c",
			canPush: true,
			canRebind: false,
		});
		expect(mockFetchSpaceBindingStatus).toHaveBeenCalledWith("/workspace/a", "jk-abc", true, probeOpts());
		expect(mockFetchSpaceBindingStatus).toHaveBeenCalledWith("/repos/b", "jk-abc", true, probeOpts());
		expect(mockFetchSpaceBindingStatus).toHaveBeenCalledWith("/repos/c", "jk-abc", true, probeOpts());
	});

	// The per-repo outbound-push toggle is consumed only by the push paths
	// (PrePushHook, isOutboundPushAllowed), so it never reached this fan-out: a
	// user who unchecked every row still had every row probed, and on a
	// single-Space tenant the frontDoor contract BOUND each one, purely because a
	// settings panel was open.
	describe("pushDisabled gate", () => {
		it("skips a push-disabled row entirely and leaves it out of the map", async () => {
			const off = repo({ repoIdentity: "https://github.com/acme/off", pushDisabled: true });

			const result = await resolveSpaceBindingsForRepos([off], "jk-abc");

			expect(mockFetchSpaceBindingStatus).not.toHaveBeenCalled();
			expect(mockFetchSpaceBindingStatusForUrl).not.toHaveBeenCalled();
			expect(result.size).toBe(0);
		});

		it("skips the CURRENT repo too when its push toggle is off", async () => {
			const off = repo({
				repoIdentity: "https://github.com/acme/off",
				pushDisabled: true,
				isCurrentRepo: true,
			});

			const result = await resolveSpaceBindingsForRepos([off], "jk-abc", { currentCwd: "/workspace/off" });

			expect(mockFetchSpaceBindingStatus).not.toHaveBeenCalled();
			expect(result.size).toBe(0);
		});

		it("short-circuits ahead of the profile reads — the toggle is a field already on the row", async () => {
			const off = repo({ repoIdentity: "https://github.com/acme/off", pushDisabled: true, isCurrentRepo: true });

			await resolveSpaceBindingsForRepos([off], "jk-abc", { currentCwd: "/workspace/off" });

			expect(mockReadManualDisableFlagSync).not.toHaveBeenCalled();
			expect(mockIsRepoDisabled).not.toHaveBeenCalled();
		});

		it("never reports a skipped row through the onResolved incremental channel", async () => {
			const off = repo({ repoIdentity: "https://github.com/acme/off", pushDisabled: true });
			const onResolved = vi.fn();

			await resolveSpaceBindingsForRepos([off], "jk-abc", { onResolved });

			expect(onResolved).not.toHaveBeenCalled();
		});

		it("resolves the still-enabled rows normally alongside the skipped ones", async () => {
			const off = repo({ repoIdentity: "https://github.com/acme/off", pushDisabled: true });
			const on = repo({ repoIdentity: "https://github.com/acme/on", repoName: "on" });

			const result = await resolveSpaceBindingsForRepos([off, on], "jk-abc");

			expect(result.has(off.repoIdentity)).toBe(false);
			expect(result.get(on.repoIdentity)).toEqual({ kind: "unbound", spaceCount: 1 });
			expect(mockFetchSpaceBindingStatusForUrl).toHaveBeenCalledTimes(1);
			expect(mockFetchSpaceBindingStatusForUrl).toHaveBeenCalledWith(
				on.repoIdentity,
				"on",
				"jk-abc",
				probeOpts(),
			);
		});

		it("does not count a skipped row against the aggregated failure denominator's warn", async () => {
			// Skipping is not a failure — it must stay off the warn path entirely.
			const off = repo({ repoIdentity: "https://github.com/acme/off", pushDisabled: true });

			await resolveSpaceBindingsForRepos([off], "jk-abc");

			expect(mockLogWarn).not.toHaveBeenCalled();
		});
	});

	// The `manuallyDisabled` switch stops EVERYTHING for a repo. This pass would
	// otherwise make a network call on a switched-off repo's behalf AND write
	// space-binding.json into its .jolli/jollimemory/, purely because someone
	// opened a settings panel.
	describe("manuallyDisabled gate", () => {
		it("skips the current repo entirely, and leaves it out of the map, when its own checkout is disabled", async () => {
			const current = repo({ repoIdentity: "https://github.com/acme/current", isCurrentRepo: true });
			mockReadManualDisableFlagSync.mockReturnValue(true);

			const result = await resolveSpaceBindingsForRepos([current], "jk-abc", {
				currentCwd: "/workspace/current",
			});

			expect(mockReadManualDisableFlagSync).toHaveBeenCalledWith("/workspace/current");
			expect(mockFetchSpaceBindingStatus).not.toHaveBeenCalled();
			expect(mockFetchSpaceBindingStatusForUrl).not.toHaveBeenCalled();
			// No entry at all — every surface renders a missing row as "Not checked".
			expect(result.has(current.repoIdentity)).toBe(false);
			expect(result.size).toBe(0);
		});

		it("skips a non-current repo whose every checkout is disabled, via the shared isRepoDisabled predicate", async () => {
			const other = repo({ repoIdentity: "https://github.com/acme/other" });
			mockReadRepoRegistry.mockResolvedValue({
				version: 1,
				repos: [registryEntry(other.repoIdentity, "other", "/repos/other")],
			});
			mockHasLiveWorktree.mockReturnValue(true);
			mockExistingWorktrees.mockReturnValue(["/repos/other"]);
			mockIsRepoDisabled.mockReturnValue(true);

			const result = await resolveSpaceBindingsForRepos([other], "jk-abc");

			expect(mockIsRepoDisabled).toHaveBeenCalled();
			expect(mockFetchSpaceBindingStatus).not.toHaveBeenCalled();
			expect(mockFetchSpaceBindingStatusForUrl).not.toHaveBeenCalled();
			expect(result.size).toBe(0);
		});

		it("probes an ENABLED sibling checkout rather than a disabled one when the repo itself is still on", async () => {
			const other = repo({ repoIdentity: "https://github.com/acme/other" });
			mockReadRepoRegistry.mockResolvedValue({
				version: 1,
				repos: [registryEntry(other.repoIdentity, "other", "/repos/off", ["/repos/off", "/repos/on"])],
			});
			mockHasLiveWorktree.mockReturnValue(true);
			mockExistingWorktrees.mockReturnValue(["/repos/off", "/repos/on"]);
			// Repo identity is on (a sibling is enabled), but the FIRST listed
			// checkout is switched off — the cache write must not land there.
			mockIsRepoDisabled.mockReturnValue(false);
			mockReadManualDisableFlagSync.mockImplementation((wt: string) => wt === "/repos/off");

			await resolveSpaceBindingsForRepos([other], "jk-abc");

			expect(mockFetchSpaceBindingStatus).toHaveBeenCalledWith("/repos/on", "jk-abc", true, probeOpts());
			expect(mockFetchSpaceBindingStatus).not.toHaveBeenCalledWith(
				"/repos/off",
				expect.anything(),
				expect.anything(),
				expect.anything(),
			);
		});

		it("does not disable a row it cannot decide about — no registry entry means a URL probe, as before", async () => {
			const stranger = repo({ repoIdentity: "https://github.com/acme/stranger", repoName: "stranger" });
			// A repo with no registry entry has no profile.json to consult; the
			// URL probe writes nothing locally, so it stays allowed.
			mockReadManualDisableFlagSync.mockReturnValue(true);

			const result = await resolveSpaceBindingsForRepos([stranger], "jk-abc");

			expect(mockFetchSpaceBindingStatusForUrl).toHaveBeenCalledWith(
				stranger.repoIdentity,
				"stranger",
				"jk-abc",
				probeOpts(),
			);
			expect(result.size).toBe(1);
		});

		it("skips only the disabled rows, resolving the rest of the list normally", async () => {
			const off = repo({ repoIdentity: "https://github.com/acme/off" });
			const on = repo({ repoIdentity: "https://github.com/acme/on" });
			mockReadRepoRegistry.mockResolvedValue({
				version: 1,
				repos: [
					registryEntry(off.repoIdentity, "off", "/repos/off"),
					registryEntry(on.repoIdentity, "on", "/repos/on"),
				],
			});
			mockHasLiveWorktree.mockReturnValue(true);
			mockExistingWorktrees.mockImplementation((r: { worktreeRoot: string }) => [r.worktreeRoot]);
			mockIsRepoDisabled.mockImplementation((r: { worktreeRoot: string }) => r.worktreeRoot === "/repos/off");

			const result = await resolveSpaceBindingsForRepos([off, on], "jk-abc");

			expect(result.has(off.repoIdentity)).toBe(false);
			expect(result.get(on.repoIdentity)).toEqual({ kind: "unbound", spaceCount: 1 });
			expect(mockFetchSpaceBindingStatus).toHaveBeenCalledTimes(1);
		});

		it("never reports a skipped row through the onResolved incremental channel", async () => {
			const off = repo({ repoIdentity: "https://github.com/acme/off", isCurrentRepo: true });
			mockReadManualDisableFlagSync.mockReturnValue(true);
			const onResolved = vi.fn();

			await resolveSpaceBindingsForRepos([off], "jk-abc", { currentCwd: "/repos/off", onResolved });

			expect(onResolved).not.toHaveBeenCalled();
		});
	});

	// The per-probe warn is O(repos) per panel open — an offline machine with
	// forty repos wrote forty identical lines every time the panel was opened.
	describe("aggregated failure logging", () => {
		it("collapses every probe failure in the pass into ONE warn naming the count and the first message", async () => {
			const a = repo({ repoIdentity: "https://github.com/acme/a" });
			const b = repo({ repoIdentity: "https://github.com/acme/b" });
			mockFetchSpaceBindingStatusForUrl.mockImplementation(
				async (_url: string, _name: string, _key: string, opts?: { onFailure?: (m: string) => void }) => {
					opts?.onFailure?.("space binding probe failed: network down");
					return { kind: "unreachable" };
				},
			);

			await resolveSpaceBindingsForRepos([a, b], "jk-abc");

			expect(mockLogWarn).toHaveBeenCalledTimes(1);
			expect(mockLogWarn).toHaveBeenCalledWith(
				"space binding probes failed for 2 of 2 repo(s): space binding probe failed: network down",
			);
		});

		it("logs nothing at warn when every probe succeeds", async () => {
			await resolveSpaceBindingsForRepos([repo()], "jk-abc");
			expect(mockLogWarn).not.toHaveBeenCalled();
		});
	});
});

/**
 * Tests for StatusOrchestrator — engine driver + status bar.
 *
 * `vscode.workspace.getConfiguration` is mocked. Engine and status bar
 * are simple stubs with `vi.fn()` methods.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getConfiguration, loadConfig } = vi.hoisted(() => ({
	getConfiguration: vi.fn(() => ({ get: (_k: string) => false })),
	loadConfig: vi.fn(async () => ({})),
}));

vi.mock("vscode", () => ({
	workspace: { getConfiguration },
}));

// Plan §P2#1 fix — `StatusOrchestrator.tick()` now reads `syncTranscripts`
// from CLI config (not vscode workspace config). The mock returns an
// empty config object by default; individual tests can override via
// `loadConfig.mockResolvedValue({ syncTranscripts: true })`.
vi.mock("../../../cli/src/core/SessionTracker.js", () => ({
	loadConfig,
}));

import type { SyncRoundResult } from "../../../cli/src/sync/SyncTypes.js";
import {
	buildDetail,
	clampPoll,
	StatusOrchestrator,
} from "./StatusOrchestrator.js";

type SyncResult = {
	fetched: boolean;
	pulled: boolean;
	pushed: boolean;
	conflicts: ReadonlyArray<{ path: string; tier: 2 | 3; detectedAt: string }>;
	newState: "synced" | "syncing" | "conflicts" | "offline";
};

function makeStubEngine(result: Partial<SyncResult> = {}) {
	const runRound = vi.fn(
		async (): Promise<SyncResult> => ({
			fetched: true,
			pulled: true,
			pushed: true,
			conflicts: [],
			newState: "synced",
			...result,
		}),
	);
	return {
		runRound,
	} as unknown as import("../../../cli/src/sync/SyncEngine.js").SyncEngine & {
		runRound: typeof runRound;
	};
}

function makeStubStatusBar() {
	return {
		setSyncState: vi.fn(),
		update: vi.fn(),
		dispose: vi.fn(),
	} as unknown as import("../util/StatusBarManager.js").StatusBarManager & {
		setSyncState: ReturnType<typeof vi.fn>;
	};
}

const FAKE_WORKSPACE_FOLDER = {
	uri: { fsPath: "/repo", toString: () => "file:///repo", scheme: "file" },
	name: "repo",
	index: 0,
} as unknown as import("vscode").WorkspaceFolder;

interface FakeTimer {
	setInterval: ReturnType<typeof vi.fn>;
	clearInterval: ReturnType<typeof vi.fn>;
	fire: () => void;
}

function makeTimer(): FakeTimer {
	let registered: (() => void) | null = null;
	return {
		setInterval: vi.fn((h: () => void) => {
			registered = h;
			return Symbol("handle");
		}),
		clearInterval: vi.fn(() => {
			registered = null;
		}),
		fire: () => {
			registered?.();
		},
	} as FakeTimer;
}

beforeEach(() => {
	getConfiguration.mockClear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("clampPoll", () => {
	it("returns the default 90 min when value is undefined", () => {
		expect(clampPoll(undefined)).toBe(90 * 60);
	});

	it("clamps below the floor up to MIN_POLL_SEC (90 min)", () => {
		expect(clampPoll(5)).toBe(90 * 60);
		expect(clampPoll(0)).toBe(90 * 60);
		expect(clampPoll(60)).toBe(90 * 60);
	});

	it("clamps absurdly large values down to the 24h ceiling", () => {
		expect(clampPoll(99_999_999)).toBe(86_400);
	});

	it("passes valid values through (>= 90 min)", () => {
		expect(clampPoll(90 * 60)).toBe(90 * 60);
		expect(clampPoll(2 * 60 * 60)).toBe(2 * 60 * 60);
		expect(clampPoll(86_400)).toBe(86_400);
	});

	it("rejects NaN and falls back to default", () => {
		expect(clampPoll(Number.NaN)).toBe(90 * 60);
	});
});

describe("StatusOrchestrator", () => {
	it("start() kicks off an immediate round and schedules polling", async () => {
		const engine = makeStubEngine();
		const statusBar = makeStubStatusBar();
		const timer = makeTimer();
		const orch = new StatusOrchestrator({
			engine,
			statusBar,
			workspaceFolder: FAKE_WORKSPACE_FOLDER,
			timer,
		});
		orch.start();
		// Drain microtasks until the round completes.
		for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
		expect(engine.runRound).toHaveBeenCalledTimes(1);
		expect(timer.setInterval).toHaveBeenCalledTimes(1);
		expect(statusBar.setSyncState).toHaveBeenCalledWith("syncing", undefined);
		expect(statusBar.setSyncState).toHaveBeenCalledWith("synced", undefined);
		orch.dispose();
	});

	it("a poll tick runs a round (reason=poll)", async () => {
		const engine = makeStubEngine();
		const statusBar = makeStubStatusBar();
		const timer = makeTimer();
		const orch = new StatusOrchestrator({
			engine,
			statusBar,
			workspaceFolder: FAKE_WORKSPACE_FOLDER,
			timer,
		});
		orch.start();
		await Promise.resolve();
		await Promise.resolve();
		engine.runRound.mockClear();

		// Wait for the immediate-round promise to finish so the next tick
		// isn't coalesced.
		await new Promise((r) => setImmediate(r));

		timer.fire();
		await Promise.resolve();
		await Promise.resolve();
		expect(engine.runRound).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "poll" }),
		);
		orch.dispose();
	});

	it("syncNow() runs a round with reason=manual", async () => {
		const engine = makeStubEngine();
		const statusBar = makeStubStatusBar();
		const orch = new StatusOrchestrator({
			engine,
			statusBar,
			workspaceFolder: FAKE_WORKSPACE_FOLDER,
			timer: makeTimer(),
		});
		// Don't `start()`, so the initial poll doesn't race.
		await orch.syncNow();
		await Promise.resolve();
		expect(engine.runRound).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "manual" }),
		);
	});

	it("propagates conflict count to the status bar when the engine reports conflicts", async () => {
		const engine = makeStubEngine({
			newState: "conflicts",
			conflicts: [
				{ path: "a.md", tier: 3, detectedAt: "x" },
				{ path: "b.md", tier: 3, detectedAt: "x" },
			],
		});
		const statusBar = makeStubStatusBar();
		const orch = new StatusOrchestrator({
			engine,
			statusBar,
			workspaceFolder: FAKE_WORKSPACE_FOLDER,
			timer: makeTimer(),
		});
		await orch.syncNow();
		await Promise.resolve();
		expect(statusBar.setSyncState).toHaveBeenCalledWith("conflicts", {
			conflictCount: 2,
		});
		expect(orch.lastObservedState).toBe("conflicts");
	});

	it("marks the status offline when runRound throws", async () => {
		// The catch handler classifies any unexpected throw as the terminal
		// code `sync_failed_after_retries` and threads the message into the
		// status detail via `buildDetail`. The bar receives a full detail
		// object (not undefined) so the "Sync failed" visual fires and the
		// error message surfaces in the tooltip — without this, prod
		// exceptions would be silently indistinguishable from a transient
		// network blip.
		const engine = {
			runRound: vi.fn(async () => {
				throw new Error("boom");
			}),
		} as unknown as import("../../../cli/src/sync/SyncEngine.js").SyncEngine;
		const statusBar = makeStubStatusBar();
		const orch = new StatusOrchestrator({
			engine,
			statusBar,
			workspaceFolder: FAKE_WORKSPACE_FOLDER,
			timer: makeTimer(),
		});
		await orch.syncNow();
		expect(statusBar.setSyncState).toHaveBeenLastCalledWith(
			"offline",
			{
				failed: true,
				failedCode: "sync_failed_after_retries",
				lastError: "boom",
			},
		);
	});

	it("coalesces overlapping rounds (second tick dropped while first is in flight)", async () => {
		let resolveRound: (() => void) | null = null;
		const engine = {
			runRound: vi.fn(
				() =>
					new Promise<SyncResult>((resolve) => {
						resolveRound = () =>
							resolve({
								fetched: true,
								pulled: true,
								pushed: true,
								conflicts: [],
								newState: "synced",
							});
					}),
			),
		} as unknown as import("../../../cli/src/sync/SyncEngine.js").SyncEngine & {
			runRound: ReturnType<typeof vi.fn>;
		};
		const statusBar = makeStubStatusBar();
		const orch = new StatusOrchestrator({
			engine,
			statusBar,
			workspaceFolder: FAKE_WORKSPACE_FOLDER,
			timer: makeTimer(),
		});
		const first = orch.syncNow();
		const second = orch.syncNow();
		// `runRound` is invoked after `tick()` awaits `readyPromise` +
		// `loadConfig()` (P1#2 + P2#1 fixes). Drain microtasks so we
		// observe state AFTER those awaits resolve but BEFORE the round
		// completes (which is gated on our `resolveRound`).
		for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
		expect(engine.runRound).toHaveBeenCalledTimes(1);
		resolveRound?.();
		await first;
		await second;
		expect(engine.runRound).toHaveBeenCalledTimes(1);
	});

	it("dispose() stops polling", () => {
		const engine = makeStubEngine();
		const statusBar = makeStubStatusBar();
		const timer = makeTimer();
		const orch = new StatusOrchestrator({
			engine,
			statusBar,
			workspaceFolder: FAKE_WORKSPACE_FOLDER,
			timer,
		});
		orch.start();
		orch.dispose();
		expect(timer.clearInterval).toHaveBeenCalled();
	});

	it("stop() tears down the interval without disposing — isPolling flips false; start() can resume", () => {
		// P2#2 fix — `reconcileAutoSync` calls `stop()` when the user
		// flips the toggle OFF mid-session. `dispose()` would also work
		// but it permanently disables manual sync, which we don't want.
		const engine = makeStubEngine();
		const statusBar = makeStubStatusBar();
		const timer = makeTimer();
		const orch = new StatusOrchestrator({
			engine,
			statusBar,
			workspaceFolder: FAKE_WORKSPACE_FOLDER,
			timer,
		});
		expect(orch.isPolling).toBe(false);

		orch.start();
		expect(orch.isPolling).toBe(true);
		expect(timer.setInterval).toHaveBeenCalledTimes(1);

		orch.stop();
		expect(orch.isPolling).toBe(false);
		expect(timer.clearInterval).toHaveBeenCalledTimes(1);

		// `stop()` is idempotent — calling it again is a no-op.
		orch.stop();
		expect(timer.clearInterval).toHaveBeenCalledTimes(1);

		// `start()` resumes after stop().
		orch.start();
		expect(orch.isPolling).toBe(true);
		expect(timer.setInterval).toHaveBeenCalledTimes(2);
		orch.dispose();
	});

	it("stop() cancels a poll tick queued during readyPromise wait — no engine round runs (P2#2)", async () => {
		// Reproduce the original bug: `start()` queues an immediate
		// `tick("poll")`. Inside the tick body it awaits `readyPromise`.
		// User toggles auto-sync OFF via `stop()` before ready settles.
		// Pre-fix, the queued tick still ran a round when ready settled.
		let releaseReady!: () => void;
		const readyPromise = new Promise<void>((r) => {
			releaseReady = r;
		});
		const engine = makeStubEngine();
		const statusBar = makeStubStatusBar();
		const timer = makeTimer();
		const orch = new StatusOrchestrator({
			engine,
			statusBar,
			workspaceFolder: FAKE_WORKSPACE_FOLDER,
			timer,
			readyPromise,
		});
		orch.start();
		// At this point a tick is queued inside the orchestrator awaiting
		// readyPromise. Tell it to stop BEFORE ready settles.
		orch.stop();
		releaseReady();
		// Drain microtasks for the queued tick body to reach the
		// generation check and bail.
		for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
		expect(engine.runRound).not.toHaveBeenCalled();
	});

	it("start() is idempotent", () => {
		const engine = makeStubEngine();
		const statusBar = makeStubStatusBar();
		const timer = makeTimer();
		const orch = new StatusOrchestrator({
			engine,
			statusBar,
			workspaceFolder: FAKE_WORKSPACE_FOLDER,
			timer,
		});
		orch.start();
		orch.start();
		expect(timer.setInterval).toHaveBeenCalledTimes(1);
		orch.dispose();
	});

	it("start() is a no-op after dispose()", () => {
		const engine = makeStubEngine();
		const statusBar = makeStubStatusBar();
		const timer = makeTimer();
		const orch = new StatusOrchestrator({
			engine,
			statusBar,
			workspaceFolder: FAKE_WORKSPACE_FOLDER,
			timer,
		});
		orch.dispose();
		orch.start();
		expect(timer.setInterval).not.toHaveBeenCalled();
	});

	it("onRoundFinished fires after a synced round with the result", async () => {
		const engine = makeStubEngine({ newState: "synced" });
		const timer = makeTimer();
		const observed: Array<{ state: string; pushed: boolean }> = [];
		const orch = new StatusOrchestrator({
			engine,
			statusBar: makeStubStatusBar(),
			workspaceFolder: FAKE_WORKSPACE_FOLDER,
			timer,
			onRoundFinished: (state, result) => {
				observed.push({ state, pushed: result.pushed });
			},
		});
		await orch.syncNow();
		expect(observed).toEqual([{ state: "synced", pushed: true }]);
	});

	it("onRoundFinished still fires when the engine throws (state=offline)", async () => {
		const runRound = vi.fn(async () => {
			throw new Error("synthetic engine bomb");
		});
		const engine = {
			runRound,
		} as unknown as import("../../../cli/src/sync/SyncEngine.js").SyncEngine;
		const observed: Array<string> = [];
		const orch = new StatusOrchestrator({
			engine,
			statusBar: makeStubStatusBar(),
			workspaceFolder: FAKE_WORKSPACE_FOLDER,
			timer: makeTimer(),
			onRoundFinished: (state) => {
				observed.push(state);
			},
		});
		await orch.syncNow();
		expect(observed).toEqual(["offline"]);
	});

	it("setOnRoundFinished late-binds the listener for the next round", async () => {
		const engine = makeStubEngine({ newState: "synced" });
		const orch = new StatusOrchestrator({
			engine,
			statusBar: makeStubStatusBar(),
			workspaceFolder: FAKE_WORKSPACE_FOLDER,
			timer: makeTimer(),
		});
		const cb = vi.fn();
		orch.setOnRoundFinished(cb);
		await orch.syncNow();
		expect(cb).toHaveBeenCalledTimes(1);
		expect(cb.mock.calls[0]?.[0]).toBe("synced");
	});

	it("isRoundInFlight is true during the round and false again after", async () => {
		let resolveRound!: () => void;
		const runRound = vi.fn(
			() =>
				new Promise<SyncResult>((resolve) => {
					resolveRound = () =>
						resolve({
							fetched: true,
							pulled: true,
							pushed: true,
							conflicts: [],
							newState: "synced",
						});
				}),
		);
		const engine = {
			runRound,
		} as unknown as import("../../../cli/src/sync/SyncEngine.js").SyncEngine;
		const orch = new StatusOrchestrator({
			engine,
			statusBar: makeStubStatusBar(),
			workspaceFolder: FAKE_WORKSPACE_FOLDER,
			timer: makeTimer(),
		});
		expect(orch.isRoundInFlight()).toBe(false);
		const inFlight = orch.syncNow();
		// Drain enough microtasks for `tick()` to traverse its preamble
		// awaits (readyPromise + loadConfig) and reach `engine.runRound`,
		// which is gated on our `resolveRound`. 6 ticks matches the
		// existing "manual + poll coalesce" test.
		for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
		expect(orch.isRoundInFlight()).toBe(true);
		resolveRound();
		await inFlight;
		expect(orch.isRoundInFlight()).toBe(false);
	});

	it("swallows a throwing listener so the round result still propagates", async () => {
		const engine = makeStubEngine({ newState: "synced" });
		const orch = new StatusOrchestrator({
			engine,
			statusBar: makeStubStatusBar(),
			workspaceFolder: FAKE_WORKSPACE_FOLDER,
			timer: makeTimer(),
			onRoundFinished: () => {
				throw new Error("listener exploded");
			},
		});
		// Must not throw out of syncNow even though the listener did.
		await expect(orch.syncNow()).resolves.toBeUndefined();
	});
});

describe("buildDetail — SyncRoundResult → SyncStatusDetail (§0.6 UI mapping)", () => {
	function baseResult(): SyncRoundResult {
		return {
			fetched: true,
			pulled: true,
			pushed: true,
			conflicts: [],
			newState: "synced",
		};
	}

	it("returns undefined when there are no conflicts and no lastError", () => {
		expect(buildDetail(baseResult())).toBeUndefined();
	});

	it("network lastError does NOT set failed (transient, render plain Offline)", () => {
		const detail = buildDetail({
			...baseResult(),
			newState: "offline",
			lastError: { code: "network", message: "ECONNREFUSED" },
		});
		expect(detail).toEqual({ lastError: "ECONNREFUSED" });
		expect(detail?.failed).toBeUndefined();
	});

	it("sync_failed_after_retries → failed=true + failedCode='sync_failed_after_retries' (render 'Sync failed')", () => {
		const detail = buildDetail({
			...baseResult(),
			newState: "offline",
			lastError: {
				code: "sync_failed_after_retries",
				message: "push exhausted 3 attempts: remote: Repository not found.",
			},
		});
		expect(detail?.failed).toBe(true);
		expect(detail?.failedCode).toBe("sync_failed_after_retries");
		expect(detail?.lastError).toContain("push exhausted");
	});

	it("vault_locked → failed=true + failedCode='vault_locked' (render 'Personal Space busy')", () => {
		const detail = buildDetail({
			...baseResult(),
			newState: "offline",
			lastError: {
				code: "vault_locked",
				message: "Personal Space is being synced by another device",
			},
		});
		expect(detail?.failed).toBe(true);
		expect(detail?.failedCode).toBe("vault_locked");
	});

	it.each([
		"mint_failed",
		"git_missing",
		"clone_failed",
		"fetch_failed",
		"pull_failed",
		"migration_failed",
		"symlink_quarantine_failed",
	] as const)("%s sets failed=true (terminal)", (code) => {
		const detail = buildDetail({
			...baseResult(),
			newState: "offline",
			lastError: { code, message: "x" },
		});
		expect(detail?.failed).toBe(true);
	});

	it("forwards conflictCount alongside other fields", () => {
		const detail = buildDetail({
			...baseResult(),
			newState: "conflicts",
			conflicts: [
				{ path: "a.md", tier: 3, detectedAt: "now" },
				{ path: "b.md", tier: 3, detectedAt: "now" },
			],
		});
		expect(detail?.conflictCount).toBe(2);
	});

	it("propagates lastError.selfLocked=true onto detail.selfLocked (engine evidence path)", () => {
		// `selfLocked` only ever appears on `code === "vault_locked"` per
		// the engine contract; verify it flows verbatim to the detail so
		// the status bar's "your previous sync" relabel fires correctly.
		const detail = buildDetail({
			...baseResult(),
			newState: "offline",
			lastError: { code: "vault_locked", message: "busy", selfLocked: true },
		});
		expect(detail?.selfLocked).toBe(true);
		expect(detail?.failedCode).toBe("vault_locked");
	});

	it("does NOT set detail.selfLocked when lastError.selfLocked is undefined or false", () => {
		// Strict `=== true` guard — `undefined` (most non-vault_locked
		// codes) and explicit `false` (peer-locked) must both leave
		// `detail.selfLocked` absent so the bar's default tooltip renders.
		const noFlag = buildDetail({
			...baseResult(),
			newState: "offline",
			lastError: { code: "vault_locked", message: "busy" },
		});
		expect(noFlag?.selfLocked).toBeUndefined();

		const explicitFalse = buildDetail({
			...baseResult(),
			newState: "offline",
			lastError: { code: "vault_locked", message: "busy", selfLocked: false },
		});
		expect(explicitFalse?.selfLocked).toBeUndefined();
	});
});

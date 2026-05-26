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
	it("start() schedules polling WITHOUT running an immediate round", async () => {
		// Behavioural fix: pre-fix `start()` kicked off an eager tick so the
		// status updated without waiting for the first poll boundary. That
		// made every `Developer: Reload Window` burn a full sync round for
		// no user-initiated reason. Now `start()` only arms the interval;
		// the first round fires on the first poll tick (or when the user
		// clicks `Sync Now`).
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
		// Drain microtasks — any eager work would surface here.
		for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
		expect(engine.runRound).not.toHaveBeenCalled();
		expect(timer.setInterval).toHaveBeenCalledTimes(1);
		expect(orch.isPolling).toBe(true);
		orch.dispose();
	});

	it("start() fires an eager round when `lastSuccessAt` is stale (>30 min old)", async () => {
		// VS Code restart / Reload Window after a long break: lastSuccessAt
		// is older than the freshness window, so we want auto-sync to
		// catch up immediately rather than wait the full poll interval.
		const engine = makeStubEngine();
		const statusBar = makeStubStatusBar();
		const timer = makeTimer();
		const staleTs = Date.now() - 60 * 60_000; // 1 hour ago
		const orch = new StatusOrchestrator({
			engine,
			statusBar,
			workspaceFolder: FAKE_WORKSPACE_FOLDER,
			timer,
			lastSuccessAt: { get: () => staleTs, set: () => {} },
		});
		orch.start();
		for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
		// Eager tick fired with `reason: "poll"` (auto-sync first poll).
		expect(engine.runRound).toHaveBeenCalledWith(expect.objectContaining({ reason: "poll" }));
		orch.dispose();
	});

	it("start() fires an eager round when `lastSuccessAt` is undefined (cold start / never synced)", async () => {
		const engine = makeStubEngine();
		const statusBar = makeStubStatusBar();
		const timer = makeTimer();
		const orch = new StatusOrchestrator({
			engine,
			statusBar,
			workspaceFolder: FAKE_WORKSPACE_FOLDER,
			timer,
			lastSuccessAt: { get: () => undefined, set: () => {} },
		});
		orch.start();
		for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
		expect(engine.runRound).toHaveBeenCalledTimes(1);
		orch.dispose();
	});

	it("start() does NOT fire an eager round when `lastSuccessAt` is fresh (<30 min — Reload Window guard)", async () => {
		// The motivating case: extension dev iteration reloads the host
		// every few seconds. Without this gate, every reload would burn a
		// real sync round.
		const engine = makeStubEngine();
		const statusBar = makeStubStatusBar();
		const timer = makeTimer();
		const freshTs = Date.now() - 5 * 60_000; // 5 min ago
		const orch = new StatusOrchestrator({
			engine,
			statusBar,
			workspaceFolder: FAKE_WORKSPACE_FOLDER,
			timer,
			lastSuccessAt: { get: () => freshTs, set: () => {} },
		});
		orch.start();
		for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
		expect(engine.runRound).not.toHaveBeenCalled();
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
		// First scheduled tick — no eager round any more, so this is the
		// first runRound call.
		timer.fire();
		// Drain microtasks until the tick reaches engine.runRound.
		for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
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
		// Reproduce the original bug shape with the new "no eager tick"
		// behaviour: a poll tick fires, the tick body awaits
		// `readyPromise`, the user toggles auto-sync OFF via `stop()`
		// before ready settles. Pre-fix, the queued tick still ran a
		// round when ready settled. The generation-mismatch guard must
		// still bail.
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
		// Fire the interval to queue a tick whose body is now awaiting
		// `readyPromise`. Tell it to stop BEFORE ready settles.
		timer.fire();
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

	// ── Sidebar sync-phase indicator (setSyncPhase wiring) ─────────────────
	describe("statusStore.setSyncPhase integration", () => {
		function makeStubStatusStore() {
			return { setSyncPhase: vi.fn() } as const;
		}

		it("seeds the indicator with 'Syncing memory bank…' at round start", async () => {
			const engine = makeStubEngine({ newState: "synced" });
			const statusStore = makeStubStatusStore();
			const orch = new StatusOrchestrator({
				engine,
				statusBar: makeStubStatusBar(),
				statusStore: statusStore as never,
				workspaceFolder: FAKE_WORKSPACE_FOLDER,
				timer: makeTimer(),
			});
			await orch.syncNow();
			expect(statusStore.setSyncPhase).toHaveBeenCalledWith({
				label: "Syncing memory bank…",
				severity: "info",
			});
			// Cleared on success.
			expect(statusStore.setSyncPhase).toHaveBeenLastCalledWith(null);
		});

		it("handlePhase pushes the conversational phase label", async () => {
			const engine = makeStubEngine();
			const statusStore = makeStubStatusStore();
			const orch = new StatusOrchestrator({
				engine,
				statusBar: makeStubStatusBar(),
				statusStore: statusStore as never,
				workspaceFolder: FAKE_WORKSPACE_FOLDER,
				timer: makeTimer(),
			});
			const round = orch.syncNow();
			orch.handlePhase("downloading");
			orch.handlePhase("merging");
			orch.handlePhase("uploading");
			await round;
			expect(statusStore.setSyncPhase).toHaveBeenCalledWith({
				label: "Sync: Getting latest memories…",
				severity: "info",
			});
			expect(statusStore.setSyncPhase).toHaveBeenCalledWith({
				label: "Sync: Bringing it together…",
				severity: "info",
			});
			expect(statusStore.setSyncPhase).toHaveBeenCalledWith({
				label: "Sync: Sharing your changes…",
				severity: "info",
			});
		});

		it("raises a VS Code notification naming the failed phase on terminal failure", async () => {
			const engine = makeStubEngine({
				newState: "offline",
				// biome-ignore lint/suspicious/noExplicitAny: stub shape mirrors SyncRoundResult.lastError
				lastError: { code: "pull_failed", message: "merge conflict" } as any,
			});
			const statusStore = makeStubStatusStore();
			const notifyError = vi.fn();
			const orch = new StatusOrchestrator({
				engine,
				statusBar: makeStubStatusBar(),
				statusStore: statusStore as never,
				workspaceFolder: FAKE_WORKSPACE_FOLDER,
				timer: makeTimer(),
				notifyError,
			});
			const round = orch.syncNow();
			orch.handlePhase("merging");
			await round;
			// Failure copy goes to the bottom-right VS Code toast, not the
			// toolbar — the indicator is for transient in-flight progress.
			expect(notifyError).toHaveBeenCalledWith(
				"Sync: Couldn't merge changes",
				"merge conflict",
			);
			// Toolbar clears: round is no longer in flight.
			expect(statusStore.setSyncPhase).toHaveBeenLastCalledWith(null);
			// And no severity=error label was ever pushed to the toolbar.
			expect(statusStore.setSyncPhase).not.toHaveBeenCalledWith(
				expect.objectContaining({ severity: "error" }),
			);
		});

		it("uses FAILURE_LABELS.starting when the round fails before any phase fires", async () => {
			const engine = makeStubEngine({
				newState: "offline",
				// biome-ignore lint/suspicious/noExplicitAny: stub shape
				lastError: { code: "mint_failed", message: "auth" } as any,
			});
			const statusStore = makeStubStatusStore();
			const notifyError = vi.fn();
			const orch = new StatusOrchestrator({
				engine,
				statusBar: makeStubStatusBar(),
				statusStore: statusStore as never,
				workspaceFolder: FAKE_WORKSPACE_FOLDER,
				timer: makeTimer(),
				notifyError,
			});
			await orch.syncNow();
			expect(notifyError).toHaveBeenCalledWith("Sync: Couldn't start", "auth");
			expect(statusStore.setSyncPhase).toHaveBeenLastCalledWith(null);
		});

		it("transient network failures do NOT raise a notification (next poll usually recovers)", async () => {
			const engine = makeStubEngine({
				newState: "offline",
				// biome-ignore lint/suspicious/noExplicitAny: stub shape
				lastError: { code: "network", message: "dns" } as any,
			});
			const notifyError = vi.fn();
			const orch = new StatusOrchestrator({
				engine,
				statusBar: makeStubStatusBar(),
				statusStore: makeStubStatusStore() as never,
				workspaceFolder: FAKE_WORKSPACE_FOLDER,
				timer: makeTimer(),
				notifyError,
			});
			await orch.syncNow();
			expect(notifyError).not.toHaveBeenCalled();
		});

		it("transient network failures clear the indicator (no lingering Syncing… label)", async () => {
			// Leaving "Syncing memory bank…" up on a network blip means the
			// toolbar lies about in-flight work for up to 90 min until the
			// next poll. Clear to idle instead — the next poll re-pushes.
			const engine = makeStubEngine({
				newState: "offline",
				// biome-ignore lint/suspicious/noExplicitAny: stub shape
				lastError: { code: "network", message: "dns" } as any,
			});
			const statusStore = makeStubStatusStore();
			const orch = new StatusOrchestrator({
				engine,
				statusBar: makeStubStatusBar(),
				statusStore: statusStore as never,
				workspaceFolder: FAKE_WORKSPACE_FOLDER,
				timer: makeTimer(),
			});
			await orch.syncNow();
			expect(statusStore.setSyncPhase).toHaveBeenLastCalledWith(null);
		});

		it("clears the indicator when the round is skipped due to sync.lock held by another process", async () => {
			// `runRound` returns `newState: "syncing"` immediately when it
			// can't acquire `sync.lock`. The round didn't actually run, so
			// the "Syncing memory bank…" label seeded at tick start would
			// linger forever — clear to idle instead.
			const engine = makeStubEngine({ newState: "syncing" });
			const statusStore = makeStubStatusStore();
			const orch = new StatusOrchestrator({
				engine,
				statusBar: makeStubStatusBar(),
				statusStore: statusStore as never,
				workspaceFolder: FAKE_WORKSPACE_FOLDER,
				timer: makeTimer(),
			});
			await orch.syncNow();
			expect(statusStore.setSyncPhase).toHaveBeenLastCalledWith(null);
		});

		it("conflict outcomes set a 'needs your attention' info label (not error)", async () => {
			const engine = makeStubEngine({
				newState: "conflicts",
				conflicts: [
					{ path: "a.md", tier: 3, detectedAt: "t" },
					{ path: "b.md", tier: 3, detectedAt: "t" },
				],
			});
			const statusStore = makeStubStatusStore();
			const orch = new StatusOrchestrator({
				engine,
				statusBar: makeStubStatusBar(),
				statusStore: statusStore as never,
				workspaceFolder: FAKE_WORKSPACE_FOLDER,
				timer: makeTimer(),
			});
			await orch.syncNow();
			expect(statusStore.setSyncPhase).toHaveBeenLastCalledWith({
				label: "Sync: 2 conflicts need your attention",
				severity: "info",
			});
		});

		it("singular conflict label is grammatically correct", async () => {
			const engine = makeStubEngine({
				newState: "conflicts",
				conflicts: [{ path: "a.md", tier: 3, detectedAt: "t" }],
			});
			const statusStore = makeStubStatusStore();
			const orch = new StatusOrchestrator({
				engine,
				statusBar: makeStubStatusBar(),
				statusStore: statusStore as never,
				workspaceFolder: FAKE_WORKSPACE_FOLDER,
				timer: makeTimer(),
			});
			await orch.syncNow();
			expect(statusStore.setSyncPhase).toHaveBeenLastCalledWith({
				label: "Sync: 1 conflict needs your attention",
				severity: "info",
			});
		});

		it("handlePhase outside a round still pushes the label (StatusStore is idempotent)", () => {
			const engine = makeStubEngine();
			const statusStore = makeStubStatusStore();
			const orch = new StatusOrchestrator({
				engine,
				statusBar: makeStubStatusBar(),
				statusStore: statusStore as never,
				workspaceFolder: FAKE_WORKSPACE_FOLDER,
				timer: makeTimer(),
			});
			orch.handlePhase("downloading");
			expect(statusStore.setSyncPhase).toHaveBeenCalledWith({
				label: "Sync: Getting latest memories…",
				severity: "info",
			});
		});

		it("a fresh round seeds the neutral start label and ends idle on success", async () => {
			let engineResult: Partial<SyncResult> = {
				newState: "offline",
				// biome-ignore lint/suspicious/noExplicitAny: stub shape
				lastError: { code: "pull_failed", message: "x" } as any,
			};
			const runRound = vi.fn(
				async (): Promise<SyncResult> => ({
					fetched: true,
					pulled: true,
					pushed: true,
					conflicts: [],
					newState: "synced",
					...engineResult,
				}),
			);
			const engine = {
				runRound,
			} as unknown as import("../../../cli/src/sync/SyncEngine.js").SyncEngine;
			const statusStore = makeStubStatusStore();
			const orch = new StatusOrchestrator({
				engine,
				statusBar: makeStubStatusBar(),
				statusStore: statusStore as never,
				workspaceFolder: FAKE_WORKSPACE_FOLDER,
				timer: makeTimer(),
			});
			// Round 1: terminal failure (raises a toast via notifyError;
			// toolbar indicator clears).
			const r1 = orch.syncNow();
			orch.handlePhase("merging");
			await r1;
			// Round 2: succeed. At round start we push the neutral label,
			// then on success we clear to null.
			engineResult = { newState: "synced" };
			statusStore.setSyncPhase.mockClear();
			await orch.syncNow();
			expect(statusStore.setSyncPhase).toHaveBeenCalledWith({
				label: "Syncing memory bank…",
				severity: "info",
			});
			expect(statusStore.setSyncPhase).toHaveBeenLastCalledWith(null);
		});

		it("dispose() clears the sync-phase indicator", async () => {
			const engine = makeStubEngine({
				newState: "offline",
				// biome-ignore lint/suspicious/noExplicitAny: stub shape
				lastError: { code: "pull_failed", message: "x" } as any,
			});
			const statusStore = makeStubStatusStore();
			const orch = new StatusOrchestrator({
				engine,
				statusBar: makeStubStatusBar(),
				statusStore: statusStore as never,
				workspaceFolder: FAKE_WORKSPACE_FOLDER,
				timer: makeTimer(),
			});
			await orch.syncNow();
			statusStore.setSyncPhase.mockClear();
			orch.dispose();
			expect(statusStore.setSyncPhase).toHaveBeenCalledWith(null);
		});
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

	// `symlink_quarantine_failed` was removed from `TerminalSyncErrorCode`
	// in Phase 1 (alongside SymlinkSweep) — symlink defence is now per-write
	// (safeAtomicWriteSync) and per-stage (stageVault's `symlinked` canary),
	// neither of which produces a terminal round result. The cases below
	// are derived from the live `TerminalSyncErrorCode` union via
	// `satisfies` so removing another member from the union here without
	// also removing it from the test will trip a type error rather than
	// silently drift like the pre-fix string-literal list did.
	const TERMINAL_CODES = [
		"mint_failed",
		"git_missing",
		"clone_failed",
		"fetch_failed",
		"pull_failed",
		"migration_failed",
	] as const satisfies ReadonlyArray<
		import("../../../cli/src/sync/SyncTypes.js").TerminalSyncErrorCode
	>;

	it.each(TERMINAL_CODES)("%s sets failed=true (terminal)", (code) => {
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

	it("canary.symlinked surfaces to canarySymlinkedCount + sample (P2 #2 — visible on synced)", () => {
		const detail = buildDetail({
			...baseResult(),
			canary: {
				symlinked: ["myrepo/.jolli/index.json", "myrepo/.jolli/summaries/abc.json"],
				unowned: [],
			},
		});
		expect(detail?.canarySymlinkedCount).toBe(2);
		expect(detail?.canarySymlinkedSample).toEqual([
			"myrepo/.jolli/index.json",
			"myrepo/.jolli/summaries/abc.json",
		]);
		expect(detail?.canaryUnownedCount).toBeUndefined();
	});

	it("canary.unowned surfaces to canaryUnownedCount + sample (tooltip only, no badge)", () => {
		const detail = buildDetail({
			...baseResult(),
			canary: { symlinked: [], unowned: [".memorybank-state.json"] },
		});
		expect(detail?.canaryUnownedCount).toBe(1);
		expect(detail?.canaryUnownedSample).toEqual([".memorybank-state.json"]);
		expect(detail?.canarySymlinkedCount).toBeUndefined();
	});

	it("returns undefined when canary buckets are both empty (no detail noise on a clean round)", () => {
		const detail = buildDetail({
			...baseResult(),
			canary: { symlinked: [], unowned: [] },
		});
		expect(detail).toBeUndefined();
	});
});

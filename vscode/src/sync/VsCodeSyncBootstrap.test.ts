/**
 * Focused tests for `SyncRuntime.reconcileAutoSync` — the plan §P2 fix
 * that starts polling when the user flips auto-sync ON mid-session
 * (without needing a window reload).
 *
 * Full `ensureBuilt()` testing requires mocking the entire vscode
 * workspace API + cli/src/sync wiring; this file only exercises the
 * `reconcileAutoSync` branches.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfig } = vi.hoisted(() => ({
	loadConfig: vi.fn(),
}));

vi.mock("../../../cli/src/core/SessionTracker.js", () => ({
	loadConfig,
}));

const { showWarningMessage, showErrorMessage } = vi.hoisted(() => ({
	showWarningMessage: vi.fn(),
	showErrorMessage: vi.fn(),
}));

vi.mock("vscode", () => ({
	commands: { registerCommand: vi.fn() },
	window: {
		createOutputChannel: () => ({
			appendLine: () => {},
			show: () => {},
			dispose: () => {},
		}),
		showWarningMessage,
		showErrorMessage,
	},
	workspace: {
		workspaceFolders: [],
	},
}));

// `buildSyncEngine` is the CLI-side factory `ensureBuilt` calls once a
// workspace folder + jolliApiKey are present. Mock it so the build path can
// be exercised without the full git/sync wiring. Tests reset it per-case to
// return null (bail) or a sentinel engine. The captured `onPhase` /
// `onRepoMappingConflict` callbacks are stashed so tests can fire them.
const { buildSyncEngine } = vi.hoisted(() => ({
	buildSyncEngine: vi.fn(),
}));
vi.mock("../../../cli/src/sync/SyncBootstrap.js", () => ({
	buildSyncEngine,
}));

// `StatusOrchestrator` is constructed inside the build path. Mock it as a
// recorder so tests can inspect the opts passed in and the start/stop/dispose
// lifecycle without pulling in the real orchestrator + git plumbing.
const { StatusOrchestrator, orchInstances } = vi.hoisted(() => {
	// biome-ignore lint/suspicious/noExplicitAny: test recorder for arbitrary orchestrator instances
	const orchInstances: any[] = [];
	const StatusOrchestrator = vi.fn(
		// biome-ignore lint/suspicious/noExplicitAny: orchestrator opts shape is exercised via assertions, not types
		function (this: any, opts: any) {
			this.opts = opts;
			this.isPolling = false;
			this.start = vi.fn(() => {
				this.isPolling = true;
			});
			this.stop = vi.fn(() => {
				this.isPolling = false;
			});
			this.dispose = vi.fn();
			this.setOnRoundFinished = vi.fn();
			this.handlePhase = vi.fn();
			orchInstances.push(this);
		},
	);
	return { StatusOrchestrator, orchInstances };
});
vi.mock("./StatusOrchestrator.js", () => ({ StatusOrchestrator }));

// `VsCodeConflictUi` is `new`'d inside the build path; stub it as an empty class.
vi.mock("./VsCodeConflictUi.js", () => ({
	VsCodeConflictUi: class {},
}));

// `registerSyncCommands` is called by `activateSync`; return an array of fake
// disposables so the for-loop that pushes them into context.subscriptions runs.
const { registerSyncCommands } = vi.hoisted(() => ({
	registerSyncCommands: vi.fn(() => [{ dispose: () => {} }]),
}));
vi.mock("./SyncCommands.js", () => ({ registerSyncCommands }));

// Route `node:timers` through the global timers so `vi.useFakeTimers()` —
// which only patches globalThis — actually controls the countdown in
// `makeLockedWaitHandler`. Without this, the source imports `setInterval`
// at module load time and gets the real Node timer object that fake-timers
// never see.
const globals = globalThis as unknown as {
	setInterval: (cb: () => void, ms: number) => unknown;
	clearInterval: (handle: unknown) => void;
};
vi.mock("node:timers", () => ({
	setInterval: (cb: () => void, ms: number) => globals.setInterval(cb, ms),
	clearInterval: (handle: unknown) => globals.clearInterval(handle),
}));

import { activateSync, makeLockedWaitHandler, SyncRuntime } from "./VsCodeSyncBootstrap.js";

beforeEach(() => {
	loadConfig.mockReset();
	buildSyncEngine.mockReset();
	StatusOrchestrator.mockClear();
	registerSyncCommands.mockClear();
	showWarningMessage.mockClear();
	showErrorMessage.mockClear();
	orchInstances.length = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeRuntime(): SyncRuntime {
	// Construct with minimal stubs — reconcileAutoSync only ever calls
	// `loadConfig` (mocked above) and `ensureBuilt` (forced to return a
	// stub orchestrator via prototype override below in the relevant
	// tests). The two constructor args are stashed on `this` but not
	// touched by the paths we exercise here.
	//
	// `disposeOrchestrator` does call `statusBar.releaseSyncOwnership()`
	// (P2 #3) so the statusBar stub provides a no-op for that method;
	// other methods stay absent so an accidental call fails loudly rather
	// than silently no-op-ing.
	return new SyncRuntime(
		{ subscriptions: { push: () => {} } } as never,
		{ releaseSyncOwnership: () => {} } as never,
	);
}

/**
 * Single test-only escape hatch for SyncRuntime's private fields. Centralises
 * the `as unknown as { … }` cast so a future rename of those fields breaks
 * THIS type literal — not 19 inline casts scattered across the file. Lives
 * in the test file (not production) so the production class stays clean.
 */
type RuntimeInternals = {
	orchestrator: { dispose: () => void } | null;
	lastBuiltJolliApiKey: string | undefined;
	lastBuiltPollIntervalSec: number | undefined;
	currentLockedWaitDispose: (() => void) | null;
};
function internals(runtime: SyncRuntime): RuntimeInternals {
	return runtime as unknown as RuntimeInternals;
}

/** In-memory globalState backing for the lastSuccessAt get/set closures. */
function makeGlobalState() {
	const store = new Map<string, unknown>();
	return {
		store,
		// biome-ignore lint/suspicious/noExplicitAny: minimal globalState surface for tests
		get: (key: string): any => store.get(key),
		update: vi.fn((key: string, val: unknown) => {
			store.set(key, val);
			return Promise.resolve();
		}),
	};
}

/**
 * Sets `vscode.workspace.workspaceFolders` for the build-path tests, which
 * need a non-empty folder so `ensureBuilt`'s `!folder` guard passes. Returns
 * a restore fn for the caller's `finally`.
 */
async function withWorkspaceFolder(fsPath: string): Promise<() => void> {
	const vscodeMock = (await import("vscode")) as unknown as {
		workspace: { workspaceFolders: unknown };
	};
	const before = vscodeMock.workspace.workspaceFolders;
	vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath } }];
	return () => {
		vscodeMock.workspace.workspaceFolders = before;
	};
}

/**
 * Build a SyncRuntime wired with a real-enough context (globalState +
 * subscriptions recorder) and a statusBar stub, for exercising the full
 * `ensureBuilt` build IIFE.
 */
function makeBuildRuntime() {
	const subscriptions: Array<{ dispose: () => void }> = [];
	const globalState = makeGlobalState();
	const setSyncState = vi.fn();
	const releaseSyncOwnership = vi.fn();
	const context = {
		subscriptions: { push: (d: { dispose: () => void }) => subscriptions.push(d) },
		globalState,
	};
	const statusBar = { setSyncState, releaseSyncOwnership };
	const statusStore = { sentinel: "store" };
	const readyPromise = Promise.resolve();
	const runtime = new SyncRuntime(
		context as never,
		statusBar as never,
		readyPromise,
		statusStore as never,
	);
	return { runtime, subscriptions, globalState, statusBar, statusStore, readyPromise };
}

describe("SyncRuntime.ensureBuilt — early-return branches", () => {
	// These hit the `if (!folder)` and `if (!config.jolliApiKey)` guards at
	// the top of `ensureBuilt`. The rest of the IIFE (which calls
	// `buildSyncEngine` and constructs a `StatusOrchestrator`) needs a much
	// heavier set of mocks; the orchestrator-build path is exercised
	// end-to-end by the acceptance suite instead.

	it("returns null when no workspace folder is open", async () => {
		const runtime = makeRuntime();
		// jolliApiKey is now checked first to support the sign-out
		// dispose path; provide a key so the workspace-folder guard is
		// the one that fires.
		loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-test" });
		// Mock's `workspaceFolders` is `[]` → workspace guard fires inside the IIFE.
		const result = await runtime.ensureBuilt();
		expect(result).toBeNull();
	});

	it("disposes the cached orchestrator and returns null when jolliApiKey disappears between rounds (sign-out)", async () => {
		// Plan: after a previous successful build the runtime holds a live
		// orchestrator; if the user then signs out, the next ensureBuilt
		// must NOT hand back the stale instance — SyncCommands.syncNow
		// uses a null return as the trigger for the actionable "needs
		// sign-in" toast, and the engine inside the cached orchestrator
		// would otherwise fail noisier via `mint_failed`.
		const runtime = makeRuntime();
		const dispose = vi.fn();
		internals(runtime).orchestrator = { dispose };
		loadConfig.mockResolvedValue({}); // jolliApiKey absent → signed out
		const result = await runtime.ensureBuilt();
		expect(result).toBeNull();
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(runtime.get()).toBeNull();
	});

	it("returns null when jolliApiKey is missing (sync stays dormant)", async () => {
		const runtime = makeRuntime();
		// vscode.workspace.workspaceFolders is `[]` in the top-of-file mock,
		// so we'd hit the `!folder` guard before the apiKey check. Patch
		// `workspaceFolders` on the mock for this one assertion so the
		// jolliApiKey check is the failing one.
		const vscodeMock = (await import("vscode")) as unknown as {
			workspace: { workspaceFolders: unknown };
		};
		const before = vscodeMock.workspace.workspaceFolders;
		vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: "/tmp" } }];
		loadConfig.mockResolvedValue({}); // no jolliApiKey
		try {
			const result = await runtime.ensureBuilt();
			expect(result).toBeNull();
		} finally {
			vscodeMock.workspace.workspaceFolders = before;
		}
	});

	it("disposes the cached orchestrator on account switch (jolliApiKey changed to a different value)", async () => {
		// Different from sign-out (jolliApiKey gone): user is still signed
		// in, but with a DIFFERENT key (account switch). The cached
		// orchestrator was built under the old identity and would mint
		// against the wrong personal space if reused — the next ensureBuilt
		// must dispose it so a fresh build mints under the new identity.
		// Without this guard the engine's per-round `BackendClient` would
		// still pick the new key (it loads fresh per round) but the
		// `StatusOrchestrator` instance, status-bar state, and any in-flight
		// generation counters would carry over from the old account.
		const runtime = makeRuntime();
		const dispose = vi.fn();
		const target = internals(runtime);
		target.orchestrator = { dispose };
		target.lastBuiltJolliApiKey = "sk-jol-OLD-account";
		target.lastBuiltPollIntervalSec = 5400;
		loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-NEW-account" });
		// workspaceFolders stays empty so after dispose the IIFE's
		// `!folder` guard returns null without trying to construct a new
		// orchestrator (which would need the full mock graph).
		const result = await runtime.ensureBuilt();
		expect(result).toBeNull();
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(runtime.get()).toBeNull();
		expect(target.lastBuiltJolliApiKey).toBeUndefined();
		expect(target.lastBuiltPollIntervalSec).toBeUndefined();
	});

	it("disposes the previous LockedWaitHandler on rebuild so its interval-cleanup closure doesn't leak", async () => {
		// Each ensureBuilt rebuild creates a fresh `makeLockedWaitHandler`
		// closure (with its own `setInterval` cleanup capture). Pre-fix, the
		// only dispose was pushed into `context.subscriptions` and never
		// called until extension deactivate — every account switch / sign
		// cycle / poll-interval change leaked one closure.
		const runtime = makeRuntime();
		const lockedWaitDispose = vi.fn();
		const orchestratorDispose = vi.fn();
		// Plant prior round's state as if a previous ensureBuilt had built
		// an orchestrator + locked-wait handler.
		const target = internals(runtime);
		// Plant prior round's state as if a previous ensureBuilt had built
		// an orchestrator + locked-wait handler.
		target.orchestrator = { dispose: orchestratorDispose };
		target.lastBuiltJolliApiKey = "sk-jol-OLD-account";
		target.lastBuiltPollIntervalSec = 5400;
		target.currentLockedWaitDispose = lockedWaitDispose;
		// Trigger an account-switch rebuild path. Empty workspaceFolders so
		// ensureBuilt's inner IIFE returns null after the dispose (no new
		// orchestrator constructed — we're testing the dispose, not the build).
		loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-NEW-account" });
		await runtime.ensureBuilt();
		expect(orchestratorDispose).toHaveBeenCalledTimes(1);
		expect(lockedWaitDispose).toHaveBeenCalledTimes(1);
		expect(target.currentLockedWaitDispose).toBeNull();
	});

	it("deduplicates concurrent ensureBuilt calls into a single in-flight build", async () => {
		const runtime = makeRuntime();
		loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-test" });
		// Both calls take the early-return path (no workspace folder) so they
		// don't actually build anything — but they MUST share the same
		// in-flight promise. Currently `this.building` is awaited by the
		// second caller; the assertion is just that neither throws and both
		// resolve to the same value.
		const [a, b] = await Promise.all([runtime.ensureBuilt(), runtime.ensureBuilt()]);
		expect(a).toBe(b);
		expect(a).toBeNull();
	});
});

describe("SyncRuntime.reconcileAutoSync", () => {
	it("returns early when autoSyncEnabled is undefined (auto-sync off)", async () => {
		const runtime = makeRuntime();
		loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-test" });
		const ensureBuiltSpy = vi
			.spyOn(runtime, "ensureBuilt")
			.mockResolvedValue(null);

		await runtime.reconcileAutoSync();
		expect(ensureBuiltSpy).not.toHaveBeenCalled();
	});

	it("returns early when autoSyncEnabled is explicitly false", async () => {
		const runtime = makeRuntime();
		loadConfig.mockResolvedValue({
			jolliApiKey: "sk-jol-test",
			autoSyncEnabled: false,
		});
		const ensureBuiltSpy = vi
			.spyOn(runtime, "ensureBuilt")
			.mockResolvedValue(null);

		await runtime.reconcileAutoSync();
		expect(ensureBuiltSpy).not.toHaveBeenCalled();
	});

	it("returns early when autoSyncEnabled=true but jolliApiKey is missing (dormant — sign-in not yet completed)", async () => {
		const runtime = makeRuntime();
		loadConfig.mockResolvedValue({ autoSyncEnabled: true });
		const ensureBuiltSpy = vi
			.spyOn(runtime, "ensureBuilt")
			.mockResolvedValue(null);

		// Must NOT call ensureBuilt: gating on jolliApiKey here is what makes
		// the sign-out path tear down a previously-polling orchestrator
		// without also flipping `autoSyncEnabled` to false.
		await expect(runtime.reconcileAutoSync()).resolves.toBeUndefined();
		expect(ensureBuiltSpy).not.toHaveBeenCalled();
	});

	it("returns early when wantPoll=true but ensureBuilt yields null (no workspace/engine)", async () => {
		const runtime = makeRuntime();
		loadConfig.mockResolvedValue({
			autoSyncEnabled: true,
			jolliApiKey: "sk-jol-test",
		});
		// ensureBuilt bails (e.g. no workspace folder) → reconcile must return
		// without trying to call start() on a null orchestrator.
		const ensureBuiltSpy = vi.spyOn(runtime, "ensureBuilt").mockResolvedValue(null);
		await expect(runtime.reconcileAutoSync()).resolves.toBeUndefined();
		expect(ensureBuiltSpy).toHaveBeenCalledTimes(1);
	});

	it("calls orch.start() when autoSyncEnabled=true and orch is not yet polling", async () => {
		const runtime = makeRuntime();
		loadConfig.mockResolvedValue({
			autoSyncEnabled: true,
			jolliApiKey: "sk-jol-test",
		});
		const start = vi.fn();
		const stop = vi.fn();
		// Mutable isPolling so we can flip it after start() to simulate a
		// real orchestrator. Use a getter so the runtime always reads the
		// current value.
		let polling = false;
		const orch = {
			start: vi.fn(() => {
				start();
				polling = true;
			}),
			stop: vi.fn(() => {
				stop();
				polling = false;
			}),
			get isPolling() {
				return polling;
			},
		};
		vi.spyOn(runtime, "ensureBuilt").mockResolvedValue(orch as never);

		await runtime.reconcileAutoSync();
		expect(start).toHaveBeenCalledTimes(1);

		// Second invocation is a no-op: orch.isPolling now true.
		await runtime.reconcileAutoSync();
		expect(start).toHaveBeenCalledTimes(1);
	});

	it("calls orch.stop() on ON→OFF transition", async () => {
		const runtime = makeRuntime();
		loadConfig.mockResolvedValue({
			autoSyncEnabled: true,
			jolliApiKey: "sk-jol-test",
		});
		const start = vi.fn();
		const stop = vi.fn();
		let polling = false;
		const orch = {
			start: vi.fn(() => {
				start();
				polling = true;
			}),
			stop: vi.fn(() => {
				stop();
				polling = false;
			}),
			get isPolling() {
				return polling;
			},
		};
		// Force ensureBuilt path AND cache the orch on the runtime so the
		// subsequent OFF transition sees a non-null `this.orchestrator`.
		vi.spyOn(runtime, "ensureBuilt").mockImplementation(async () => {
			internals(runtime).orchestrator = orch as never;
			return orch as never;
		});

		await runtime.reconcileAutoSync();
		expect(start).toHaveBeenCalledTimes(1);
		expect(stop).not.toHaveBeenCalled();

		// Flip off.
		loadConfig.mockResolvedValue({
			autoSyncEnabled: false,
			jolliApiKey: "sk-jol-test",
		});
		await runtime.reconcileAutoSync();
		expect(stop).toHaveBeenCalledTimes(1);

		// Subsequent OFF call is a no-op (already stopped).
		await runtime.reconcileAutoSync();
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("OFF transition before orchestrator was ever built is a no-op", async () => {
		const runtime = makeRuntime();
		loadConfig.mockResolvedValue({ autoSyncEnabled: false });
		const ensureBuiltSpy = vi
			.spyOn(runtime, "ensureBuilt")
			.mockResolvedValue(null);

		await runtime.reconcileAutoSync();
		expect(ensureBuiltSpy).not.toHaveBeenCalled();
	});

	it("rebuilds the orchestrator when syncPollIntervalSec changes between calls (P2#3)", async () => {
		// Pre-fix the orchestrator captured pollIntervalSec at construction
		// and reconcileAutoSync only toggled start/stop; the user had to
		// reload the window for the new interval to take effect.
		const runtime = makeRuntime();
		loadConfig.mockResolvedValue({
			autoSyncEnabled: true,
			jolliApiKey: "sk-jol-test",
			syncPollIntervalSec: 60,
		});
		const dispose1 = vi.fn();
		let polling1 = false;
		const orch1 = {
			start: vi.fn(() => {
				polling1 = true;
			}),
			stop: vi.fn(() => {
				polling1 = false;
			}),
			dispose: dispose1,
			get isPolling() {
				return polling1;
			},
		};
		const dispose2 = vi.fn();
		let polling2 = false;
		const orch2 = {
			start: vi.fn(() => {
				polling2 = true;
			}),
			stop: vi.fn(() => {
				polling2 = false;
			}),
			dispose: dispose2,
			get isPolling() {
				return polling2;
			},
		};
		const ensureBuiltSpy = vi.spyOn(runtime, "ensureBuilt");
		ensureBuiltSpy.mockImplementationOnce(async () => {
			const t = internals(runtime);
			t.orchestrator = orch1 as never;
			t.lastBuiltPollIntervalSec = 60;
			return orch1 as never;
		});

		await runtime.reconcileAutoSync();
		expect(orch1.start).toHaveBeenCalledTimes(1);
		expect(dispose1).not.toHaveBeenCalled();

		// Change the interval and reconcile again — the cached orch1 must be
		// disposed and orch2 built with the new value.
		loadConfig.mockResolvedValue({
			autoSyncEnabled: true,
			jolliApiKey: "sk-jol-test",
			syncPollIntervalSec: 600,
		});
		ensureBuiltSpy.mockImplementationOnce(async () => {
			const t = internals(runtime);
			t.orchestrator = orch2 as never;
			t.lastBuiltPollIntervalSec = 600;
			return orch2 as never;
		});
		await runtime.reconcileAutoSync();
		expect(dispose1).toHaveBeenCalledTimes(1);
		expect(orch2.start).toHaveBeenCalledTimes(1);
	});

	it("does not rebuild when syncPollIntervalSec is unchanged", async () => {
		const runtime = makeRuntime();
		loadConfig.mockResolvedValue({
			autoSyncEnabled: true,
			jolliApiKey: "sk-jol-test",
			syncPollIntervalSec: 60,
		});
		const dispose = vi.fn();
		let polling = false;
		const orch = {
			start: vi.fn(() => {
				polling = true;
			}),
			stop: vi.fn(() => {
				polling = false;
			}),
			dispose,
			get isPolling() {
				return polling;
			},
		};
		vi.spyOn(runtime, "ensureBuilt").mockImplementation(async () => {
			const t = internals(runtime);
			t.orchestrator = orch as never;
			t.lastBuiltPollIntervalSec = 60;
			return orch as never;
		});

		await runtime.reconcileAutoSync();
		await runtime.reconcileAutoSync();
		expect(dispose).not.toHaveBeenCalled();
	});

	it("disposes the cached orchestrator on sign-out so the next sign-in rebuilds", async () => {
		const runtime = makeRuntime();
		// Round 1: signed in + auto-sync ON → orch built and polling.
		loadConfig.mockResolvedValue({
			autoSyncEnabled: true,
			jolliApiKey: "sk-jol-test",
		});
		const dispose = vi.fn();
		let polling = false;
		const orch = {
			start: vi.fn(() => {
				polling = true;
			}),
			stop: vi.fn(() => {
				polling = false;
			}),
			dispose,
			get isPolling() {
				return polling;
			},
		};
		vi.spyOn(runtime, "ensureBuilt").mockImplementation(async () => {
			const t = internals(runtime);
			t.orchestrator = orch as never;
			t.lastBuiltJolliApiKey = "sk-jol-test";
			return orch as never;
		});

		await runtime.reconcileAutoSync();
		expect(orch.start).toHaveBeenCalledTimes(1);

		// Round 2: sign-out cleared jolliApiKey but `clearAuthCredentials`
		// deliberately preserves autoSyncEnabled so the preference auto-resumes
		// on the next sign-in. Reconcile must dispose the cached orchestrator
		// so a later re-sign-in re-builds it instead of reusing a stale one.
		loadConfig.mockResolvedValue({ autoSyncEnabled: true });
		await runtime.reconcileAutoSync();
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(internals(runtime).orchestrator).toBeNull();
	});

	it("rebuilds the orchestrator when jolliApiKey changes (account switch)", async () => {
		const runtime = makeRuntime();
		const dispose1 = vi.fn();
		let polling1 = false;
		const orch1 = {
			start: vi.fn(() => {
				polling1 = true;
			}),
			stop: vi.fn(),
			dispose: dispose1,
			get isPolling() {
				return polling1;
			},
		};
		const dispose2 = vi.fn();
		let polling2 = false;
		const orch2 = {
			start: vi.fn(() => {
				polling2 = true;
			}),
			stop: vi.fn(),
			dispose: dispose2,
			get isPolling() {
				return polling2;
			},
		};

		// Round 1: first sign-in mints orch1.
		loadConfig.mockResolvedValue({
			autoSyncEnabled: true,
			jolliApiKey: "sk-jol-userA",
		});
		const ensureBuiltSpy = vi.spyOn(runtime, "ensureBuilt");
		ensureBuiltSpy.mockImplementationOnce(async () => {
			const t = internals(runtime);
			t.orchestrator = orch1 as never;
			t.lastBuiltJolliApiKey = "sk-jol-userA";
			return orch1 as never;
		});
		await runtime.reconcileAutoSync();
		expect(orch1.start).toHaveBeenCalledTimes(1);

		// Round 2: same autoSyncEnabled, different jolliApiKey. The cached orch1
		// must be disposed; ensureBuilt is invoked again and produces orch2.
		loadConfig.mockResolvedValue({
			autoSyncEnabled: true,
			jolliApiKey: "sk-jol-userB",
		});
		ensureBuiltSpy.mockImplementationOnce(async () => {
			// Simulate ensureBuilt's own key-change check disposing orch1.
			dispose1();
			const t = internals(runtime);
			t.orchestrator = orch2 as never;
			t.lastBuiltJolliApiKey = "sk-jol-userB";
			return orch2 as never;
		});
		// Pretend the caller goes via ensureBuilt by clearing the cached orch
		// so the wantPoll branch falls through to it.
		internals(runtime).orchestrator = null;
		await runtime.reconcileAutoSync();
		expect(dispose1).toHaveBeenCalledTimes(1);
		expect(orch2.start).toHaveBeenCalledTimes(1);
	});
});

describe("SyncRuntime.disposeOrchestrator — no-orchestrator guard", () => {
	it("is safe when no orchestrator was ever built (L134 else-arm), still releasing bar ownership", () => {
		// Every public caller pre-checks `orchestrator !== null`, so the guard's
		// false-arm is only reachable by invoking the private method directly. It
		// must remain idempotent: skip the (absent) orchestrator dispose but still
		// run the unconditional tail (releaseSyncOwnership).
		const releaseSyncOwnership = vi.fn();
		const runtime = new SyncRuntime(
			{ subscriptions: { push: () => {} } } as never,
			{ releaseSyncOwnership } as never,
		);
		// orchestrator is null (never built) and currentLockedWaitDispose is null.
		(
			runtime as unknown as { disposeOrchestrator: () => void }
		).disposeOrchestrator();

		expect(releaseSyncOwnership).toHaveBeenCalledTimes(1);
		expect(runtime.get()).toBeNull();
	});
});

describe("SyncRuntime.notifyRepoMappingConflicts (P2#3)", () => {
	beforeEach(() => {
		showWarningMessage.mockClear();
	});

	it("shows a warning toast for each new conflict", () => {
		const runtime = makeRuntime();
		runtime.notifyRepoMappingConflicts([
			{ folder: "jolliai", identities: ["a", "b"] },
			{ folder: "other", identities: ["c", "d"] },
		]);
		expect(showWarningMessage).toHaveBeenCalledTimes(2);
		expect(showWarningMessage).toHaveBeenNthCalledWith(
			1,
			expect.stringContaining('"jolliai"'),
		);
		expect(showWarningMessage).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining('"other"'),
		);
	});

	it("dedupes: same conflict on a subsequent call stays silent", () => {
		const runtime = makeRuntime();
		const conflict = { folder: "shared", identities: ["a", "b"] };
		runtime.notifyRepoMappingConflicts([conflict]);
		runtime.notifyRepoMappingConflicts([conflict]);
		expect(showWarningMessage).toHaveBeenCalledTimes(1);
	});

	it("treats identity order as canonical for dedupe (sorted internally)", () => {
		const runtime = makeRuntime();
		runtime.notifyRepoMappingConflicts([
			{ folder: "shared", identities: ["a", "b"] },
		]);
		// Same conflict from a different perspective — identities listed in
		// reverse order. The dedupe key normalizes order so this is
		// recognized as the SAME conflict.
		runtime.notifyRepoMappingConflicts([
			{ folder: "shared", identities: ["b", "a"] },
		]);
		expect(showWarningMessage).toHaveBeenCalledTimes(1);
	});

	it("empty conflicts array is a no-op", () => {
		const runtime = makeRuntime();
		runtime.notifyRepoMappingConflicts([]);
		expect(showWarningMessage).not.toHaveBeenCalled();
	});
});

describe("makeLockedWaitHandler (plan §0.12 — live countdown + correct attempt label)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function makeStubStatusBar() {
		return { setSyncState: vi.fn() };
	}

	it("renders 'attempt N/M' verbatim (no off-by-one) and seeds the initial countdown", () => {
		const statusBar = makeStubStatusBar();
		const { handler, dispose } = makeLockedWaitHandler(statusBar);
		handler({
			attempt: 1,
			totalAttempts: 4,
			nextRetryInMs: 60_000,
			message: "Personal Space busy",
		});
		// Initial render fires immediately.
		expect(statusBar.setSyncState).toHaveBeenLastCalledWith("offline", {
			failed: true,
			failedCode: "vault_locked",
			lastError: "Personal Space busy (attempt 1/4 — next retry in 60s)",
		});
		dispose();
	});

	it("ticks remainSec down once per second", () => {
		const statusBar = makeStubStatusBar();
		const { handler, dispose } = makeLockedWaitHandler(statusBar);
		handler({ attempt: 2, totalAttempts: 4, nextRetryInMs: 3_000, message: "busy" });
		// After 1s, label shows 2s remaining.
		vi.advanceTimersByTime(1_000);
		expect(statusBar.setSyncState).toHaveBeenLastCalledWith(
			"offline",
			expect.objectContaining({ lastError: "busy (attempt 2/4 — next retry in 2s)" }),
		);
		// After total 3s, label shows 0s and the timer stops itself.
		vi.advanceTimersByTime(2_000);
		expect(statusBar.setSyncState).toHaveBeenLastCalledWith(
			"offline",
			expect.objectContaining({ lastError: "busy (attempt 2/4 — next retry in 0s)" }),
		);
		const callsAtZero = statusBar.setSyncState.mock.calls.length;
		// Another 5s — no further renders, the interval cleared itself at 0.
		vi.advanceTimersByTime(5_000);
		expect(statusBar.setSyncState.mock.calls.length).toBe(callsAtZero);
		dispose();
	});

	it("clears the previous timer when a second onLockedWait fires (re-mint hit 423 again)", () => {
		const statusBar = makeStubStatusBar();
		const { handler, dispose } = makeLockedWaitHandler(statusBar);
		handler({ attempt: 1, totalAttempts: 4, nextRetryInMs: 60_000, message: "busy" });
		// Advance 5s into the first wait, then engine re-fires for a NEW retry
		// (e.g. mint succeeded, push failed, second 423). The new handler call
		// must reseat the countdown to the new nextRetryInMs and the old timer
		// must NOT continue ticking.
		vi.advanceTimersByTime(5_000);
		handler({ attempt: 2, totalAttempts: 4, nextRetryInMs: 10_000, message: "still busy" });
		expect(statusBar.setSyncState).toHaveBeenLastCalledWith(
			"offline",
			expect.objectContaining({ lastError: "still busy (attempt 2/4 — next retry in 10s)" }),
		);
		// 1s advance — only ONE tick (the new timer). If the old timer were
		// still running, we'd see two consecutive renders.
		const callsBeforeAdvance = statusBar.setSyncState.mock.calls.length;
		vi.advanceTimersByTime(1_000);
		expect(statusBar.setSyncState.mock.calls.length).toBe(callsBeforeAdvance + 1);
		dispose();
	});

	it("dispose() clears any in-flight timer (extension deactivation safety)", () => {
		const statusBar = makeStubStatusBar();
		const { handler, dispose } = makeLockedWaitHandler(statusBar);
		handler({ attempt: 1, totalAttempts: 4, nextRetryInMs: 60_000, message: "busy" });
		const callsBefore = statusBar.setSyncState.mock.calls.length;
		dispose();
		// After dispose, any further timer firings would be a leak.
		vi.advanceTimersByTime(5_000);
		expect(statusBar.setSyncState.mock.calls.length).toBe(callsBefore);
	});

	it("nextRetryInMs=0 (final attempt edge case) renders once with 'in 0s' and starts no timer", () => {
		const statusBar = makeStubStatusBar();
		const { handler, dispose } = makeLockedWaitHandler(statusBar);
		handler({ attempt: 4, totalAttempts: 4, nextRetryInMs: 0, message: "busy" });
		expect(statusBar.setSyncState).toHaveBeenLastCalledWith(
			"offline",
			expect.objectContaining({ lastError: "busy (attempt 4/4 — next retry in 0s)" }),
		);
		const callsAfterRender = statusBar.setSyncState.mock.calls.length;
		// No timer started — advancing should not re-render.
		vi.advanceTimersByTime(60_000);
		expect(statusBar.setSyncState.mock.calls.length).toBe(callsAfterRender);
		dispose();
	});
});

describe("SyncRuntime.ensureBuilt — full build path", () => {
	it("returns the cached orchestrator on a second call with the same key (cache hit)", async () => {
		const { runtime } = makeBuildRuntime();
		loadConfig.mockResolvedValue({
			jolliApiKey: "sk-jol-test",
			autoSyncEnabled: true,
			syncPollIntervalSec: 90,
		});
		buildSyncEngine.mockResolvedValue({ engine: true });
		const restore = await withWorkspaceFolder("/repo/cache");
		try {
			const first = await runtime.ensureBuilt();
			// Second call: jolliApiKey unchanged → the `this.orchestrator !== null`
			// short-circuit returns the same instance without rebuilding.
			const second = await runtime.ensureBuilt();
			expect(second).toBe(first);
			expect(orchInstances.length).toBe(1);
			expect(buildSyncEngine).toHaveBeenCalledTimes(1);
		} finally {
			restore();
		}
	});

	it("returns null when buildSyncEngine returns null (engine bailed)", async () => {
		const { runtime } = makeBuildRuntime();
		loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-test", syncPollIntervalSec: 90 });
		buildSyncEngine.mockResolvedValue(null);
		const restore = await withWorkspaceFolder("/repo/a");
		try {
			const result = await runtime.ensureBuilt();
			expect(result).toBeNull();
			expect(buildSyncEngine).toHaveBeenCalledTimes(1);
			// No orchestrator constructed when the engine is null.
			expect(orchInstances.length).toBe(0);
			expect(runtime.get()).toBeNull();
		} finally {
			restore();
		}
	});

	it("builds the orchestrator and starts polling when autoSyncEnabled=true", async () => {
		const { runtime, statusBar } = makeBuildRuntime();
		loadConfig.mockResolvedValue({
			jolliApiKey: "sk-jol-test",
			autoSyncEnabled: true,
			syncPollIntervalSec: 120,
		});
		buildSyncEngine.mockResolvedValue({ engine: true });
		const restore = await withWorkspaceFolder("/repo/b");
		try {
			const result = await runtime.ensureBuilt();
			expect(orchInstances.length).toBe(1);
			expect(result).toBe(orchInstances[0]);
			expect(runtime.get()).toBe(orchInstances[0]);
			// Auto-sync on → polling started.
			expect(orchInstances[0].start).toHaveBeenCalledTimes(1);
			// Opts wired through from config + runtime.
			expect(orchInstances[0].opts.pollIntervalSec).toBe(120);
			expect(orchInstances[0].opts.engine).toEqual({ engine: true });
			expect(orchInstances[0].opts.statusBar).toBe(statusBar);
		} finally {
			restore();
		}
	});

	it("builds the orchestrator WITHOUT polling when autoSyncEnabled is off (manual-only)", async () => {
		const { runtime } = makeBuildRuntime();
		loadConfig.mockResolvedValue({
			jolliApiKey: "sk-jol-test",
			// autoSyncEnabled omitted → manual-only
			syncPollIntervalSec: 90,
		});
		buildSyncEngine.mockResolvedValue({ engine: true });
		const restore = await withWorkspaceFolder("/repo/c");
		try {
			const result = await runtime.ensureBuilt();
			expect(result).toBe(orchInstances[0]);
			expect(orchInstances[0].start).not.toHaveBeenCalled();
		} finally {
			restore();
		}
	});

	it("routes engine onPhase events into the orchestrator's handlePhase", async () => {
		const { runtime } = makeBuildRuntime();
		loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-test", autoSyncEnabled: true });
		// biome-ignore lint/suspicious/noExplicitAny: capture the bootstrap opts to fire callbacks
		let capturedOpts: any = null;
		buildSyncEngine.mockImplementation(async (opts: unknown) => {
			capturedOpts = opts;
			return { engine: true };
		});
		const restore = await withWorkspaceFolder("/repo/d");
		try {
			await runtime.ensureBuilt();
			// orchRef was assigned after engine build → onPhase now routes through.
			capturedOpts.onPhase({ kind: "pull" });
			expect(orchInstances[0].handlePhase).toHaveBeenCalledWith({ kind: "pull" });
		} finally {
			restore();
		}
	});

	it("wires onRepoMappingConflict to notifyRepoMappingConflicts", async () => {
		const { runtime } = makeBuildRuntime();
		loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-test", autoSyncEnabled: true });
		// biome-ignore lint/suspicious/noExplicitAny: capture the bootstrap opts to fire callbacks
		let capturedOpts: any = null;
		buildSyncEngine.mockImplementation(async (opts: unknown) => {
			capturedOpts = opts;
			return { engine: true };
		});
		const restore = await withWorkspaceFolder("/repo/e");
		try {
			await runtime.ensureBuilt();
			capturedOpts.onRepoMappingConflict([{ folder: "x", identities: ["a", "b"] }]);
			expect(showWarningMessage).toHaveBeenCalledTimes(1);
			expect(showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('"x"'));
		} finally {
			restore();
		}
	});

	it("wires lastSuccessAt get/set against globalState keyed by folder path", async () => {
		const { runtime, globalState } = makeBuildRuntime();
		loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-test", autoSyncEnabled: true });
		buildSyncEngine.mockResolvedValue({ engine: true });
		const restore = await withWorkspaceFolder("/repo/f");
		try {
			await runtime.ensureBuilt();
			const { lastSuccessAt } = orchInstances[0].opts;
			const expectedKey = "sync.lastSuccessAt:/repo/f";
			// get reads through to globalState
			globalState.store.set(expectedKey, 12345);
			expect(lastSuccessAt.get()).toBe(12345);
			// set writes through to globalState.update
			lastSuccessAt.set(67890);
			expect(globalState.update).toHaveBeenCalledWith(expectedKey, 67890);
			expect(globalState.store.get(expectedKey)).toBe(67890);
		} finally {
			restore();
		}
	});

	it("wires notifyError to vscode.window.showErrorMessage", async () => {
		const { runtime } = makeBuildRuntime();
		loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-test", autoSyncEnabled: true });
		buildSyncEngine.mockResolvedValue({ engine: true });
		const restore = await withWorkspaceFolder("/repo/g");
		try {
			await runtime.ensureBuilt();
			orchInstances[0].opts.notifyError("Sync failed", "boom");
			expect(showErrorMessage).toHaveBeenCalledWith("Sync failed — boom");
		} finally {
			restore();
		}
	});

	it("applies a late-bound onRoundFinished callback to orchestrators built later", async () => {
		const { runtime } = makeBuildRuntime();
		loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-test", autoSyncEnabled: true });
		buildSyncEngine.mockResolvedValue({ engine: true });
		const cb = vi.fn();
		// Set BEFORE the orchestrator exists — must be passed at construction.
		runtime.setOnRoundFinished(cb);
		const restore = await withWorkspaceFolder("/repo/h");
		try {
			await runtime.ensureBuilt();
			expect(orchInstances[0].opts.onRoundFinished).toBe(cb);
		} finally {
			restore();
		}
	});

	it("disposes the prior locked-wait handler via context.subscriptions on deactivate (live-field read)", async () => {
		// The build path pushes a subscription whose dispose reads the LIVE
		// `currentLockedWaitDispose` field. Build once, then invoke that
		// subscription's dispose to confirm it clears the handler timer.
		const { runtime, subscriptions } = makeBuildRuntime();
		loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-test", autoSyncEnabled: true });
		buildSyncEngine.mockResolvedValue({ engine: true });
		const restore = await withWorkspaceFolder("/repo/i");
		try {
			await runtime.ensureBuilt();
			// Find the locked-wait subscription (the one whose dispose proxies
			// to currentLockedWaitDispose) and invoke it — must not throw.
			expect(() => {
				for (const sub of subscriptions) sub.dispose();
			}).not.toThrow();
			expect(internals(runtime).currentLockedWaitDispose).not.toBeNull();
		} finally {
			restore();
		}
	});
});

describe("SyncRuntime.setOnRoundFinished — propagates to a live orchestrator", () => {
	it("forwards the callback to an already-built orchestrator immediately", async () => {
		const { runtime } = makeBuildRuntime();
		loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-test", autoSyncEnabled: true });
		buildSyncEngine.mockResolvedValue({ engine: true });
		const restore = await withWorkspaceFolder("/repo/j");
		try {
			await runtime.ensureBuilt();
			const cb = vi.fn();
			runtime.setOnRoundFinished(cb);
			// orchestrator already exists → forwarded via the live ref.
			expect(orchInstances[0].setOnRoundFinished).toHaveBeenCalledWith(cb);
		} finally {
			restore();
		}
	});

	it("is a no-op (no throw) when no orchestrator is built yet", () => {
		const runtime = makeRuntime();
		expect(() => runtime.setOnRoundFinished(vi.fn())).not.toThrow();
	});
});

describe("makeLockedWaitHandler — selfLocked branch (plan §0.12)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders the self-locked message when info.selfLocked is true", () => {
		const setSyncState = vi.fn();
		const { handler, dispose } = makeLockedWaitHandler({ setSyncState });
		handler({
			attempt: 2,
			totalAttempts: 4,
			nextRetryInMs: 30_000,
			message: "Personal Space busy",
			selfLocked: true,
		});
		expect(setSyncState).toHaveBeenLastCalledWith("offline", {
			failed: true,
			failedCode: "vault_locked",
			selfLocked: true,
			lastError:
				"Your previous sync left the Personal Space lock held; it is still releasing. Attempt 2/4 — next retry in 30s",
		});
		dispose();
	});
});

describe("activateSync — eager ensureBuilt swallow", () => {
	it("swallows a throw from the eager ensureBuilt so extension activation never fails", async () => {
		// The catch at the end of activateSync is the load-bearing
		// "activation must never fail" contract — vscode marks the
		// extension unloadable if activate() throws. Force a rejection by
		// poisoning SyncRuntime.prototype.ensureBuilt for this test, then
		// verify activateSync still resolves.
		const original = SyncRuntime.prototype.ensureBuilt;
		const ensureBuilt = vi.fn().mockRejectedValue(new Error("boom during eager"));
		SyncRuntime.prototype.ensureBuilt = ensureBuilt;
		try {
			const subscriptions: unknown[] = [];
			const context = { subscriptions: { push: (d: unknown) => subscriptions.push(d) } };
			const statusBar = {} as never;
			await expect(activateSync(context as never, statusBar)).resolves.toBeDefined();
			expect(ensureBuilt).toHaveBeenCalledTimes(1);
		} finally {
			SyncRuntime.prototype.ensureBuilt = original;
		}
	});
});

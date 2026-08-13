import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	loadConfig: vi.fn(),
	bootstrapTelemetry: vi.fn(),
	flushTelemetryNow: vi.fn(),
	maybeEmitOnboardingProgress: vi.fn(),
}));

vi.mock("../core/SessionTracker.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../core/OnboardingFunnel.js", () => ({ maybeEmitOnboardingProgress: mocks.maybeEmitOnboardingProgress }));
vi.mock("../core/TelemetryStartup.js", () => ({
	BOUNDED_FLUSH_BUDGET_MS: 2_000,
	bootstrapTelemetry: mocks.bootstrapTelemetry,
	flushTelemetryNow: mocks.flushTelemetryNow,
}));

const { capturePluginOnboardingSnapshot } = await import("./PluginBootstrapTelemetry.js");

describe("capturePluginOnboardingSnapshot", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.loadConfig.mockResolvedValue({});
		mocks.bootstrapTelemetry.mockResolvedValue(undefined);
		mocks.flushTelemetryNow.mockResolvedValue(undefined);
		mocks.maybeEmitOnboardingProgress.mockResolvedValue(undefined);
	});

	it("reads the config ONCE and injects the same object into every consumer", async () => {
		const config = { aiProvider: "local-agent" };
		mocks.loadConfig.mockResolvedValue(config);

		await capturePluginOnboardingSnapshot("/repo", "s1").done;

		// One physical read — bootstrapTelemetry and flushTelemetryNow each
		// default to their own uncached readFile+parse of the same file, so the
		// helper hands both its already-loaded copy through their deps seams.
		expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
		const bootstrapArgs = mocks.bootstrapTelemetry.mock.calls[0][0];
		expect(bootstrapArgs).toMatchObject({ cwd: "/repo", sessionId: "s1" });
		await expect(bootstrapArgs.deps.loadConfig()).resolves.toBe(config);
		expect(mocks.maybeEmitOnboardingProgress).toHaveBeenCalledWith({ cwd: "/repo", config });
		const [flushCwd, flushDeps] = mocks.flushTelemetryNow.mock.calls[0];
		expect(flushCwd).toBe("/repo");
		// Both caps carry the shared bounded budget: timeoutMs bounds each POST,
		// deadlineMs the whole flush — these callers block a session start.
		expect(flushDeps.timeoutMs).toBe(2_000);
		expect(flushDeps.deadlineMs).toBe(2_000);
		await expect(flushDeps.loadConfig()).resolves.toBe(config);
	});

	it("returns synchronously with the whole chain deferred, so the caller can overlap it", async () => {
		let releaseConfig: (config: object) => void = () => {};
		mocks.loadConfig.mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseConfig = resolve;
				}),
		);

		const snapshot = capturePluginOnboardingSnapshot("/repo");

		// The handle exists before the chain's first step has even resolved —
		// nothing beyond starting the config read happened yet.
		await Promise.resolve();
		await Promise.resolve();
		expect(mocks.bootstrapTelemetry).not.toHaveBeenCalled();
		expect(mocks.maybeEmitOnboardingProgress).not.toHaveBeenCalled();
		expect(mocks.flushTelemetryNow).not.toHaveBeenCalled();

		// Releasing the read lets the chain run to completion, tracked by `done`.
		releaseConfig({});
		await snapshot.done;
		expect(mocks.bootstrapTelemetry).toHaveBeenCalledTimes(1);
		expect(mocks.maybeEmitOnboardingProgress).toHaveBeenCalledTimes(1);
		expect(mocks.flushTelemetryNow).toHaveBeenCalledTimes(1);
	});

	it("orders the chain by completion: bootstrap, then emit, then flush", async () => {
		const timeline: Array<string> = [];
		const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2));
		mocks.bootstrapTelemetry.mockImplementation(async () => {
			await tick();
			timeline.push("bootstrap:done");
		});
		mocks.maybeEmitOnboardingProgress.mockImplementation(async () => {
			timeline.push("emit:start");
			await tick();
			timeline.push("emit:done");
		});
		mocks.flushTelemetryNow.mockImplementation(async () => {
			timeline.push("flush:start");
		});

		await capturePluginOnboardingSnapshot("/repo").done;

		// Completion order, not invocation order: bootstrap must COMPLETE before
		// the emit can track() through its context, and the emit must COMPLETE
		// before the flush reads the buffer — a Promise.all rewrite fails this.
		expect(timeline).toEqual(["bootstrap:done", "emit:start", "emit:done", "flush:start"]);
	});

	it("never rejects — a config read failure costs the snapshot, not the briefing", async () => {
		mocks.loadConfig.mockRejectedValue(new Error("unreadable config"));

		await expect(capturePluginOnboardingSnapshot("/repo").done).resolves.toBeUndefined();
		expect(mocks.bootstrapTelemetry).not.toHaveBeenCalled();
		expect(mocks.maybeEmitOnboardingProgress).not.toHaveBeenCalled();
		expect(mocks.flushTelemetryNow).not.toHaveBeenCalled();
	});
});

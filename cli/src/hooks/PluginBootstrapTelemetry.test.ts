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
	bootstrapTelemetry: mocks.bootstrapTelemetry,
	flushTelemetryNow: mocks.flushTelemetryNow,
}));

const { capturePluginOnboardingSnapshot, PLUGIN_FUNNEL_FLUSH_BUDGET_MS } = await import(
	"./PluginBootstrapTelemetry.js"
);

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

		await capturePluginOnboardingSnapshot("/repo", "s1");

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
		expect(flushDeps.timeoutMs).toBe(PLUGIN_FUNNEL_FLUSH_BUDGET_MS);
		expect(flushDeps.deadlineMs).toBe(PLUGIN_FUNNEL_FLUSH_BUDGET_MS);
		await expect(flushDeps.loadConfig()).resolves.toBe(config);
	});

	it("starts the flush without awaiting it, so the caller can overlap it with briefing work", async () => {
		let resolveFlush: () => void = () => {};
		mocks.flushTelemetryNow.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolveFlush = resolve;
				}),
		);

		const snapshot = await capturePluginOnboardingSnapshot("/repo");

		// The helper resolved while the flush is still in flight…
		let settled = false;
		void snapshot.flushed.then(() => {
			settled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);
		// …and `flushed` tracks the real flush.
		resolveFlush();
		await snapshot.flushed;
		expect(settled).toBe(true);
	});

	it("never throws — a config read failure costs the snapshot, not the briefing", async () => {
		mocks.loadConfig.mockRejectedValue(new Error("unreadable config"));

		const snapshot = await capturePluginOnboardingSnapshot("/repo");

		await expect(snapshot.flushed).resolves.toBeUndefined();
		expect(mocks.bootstrapTelemetry).not.toHaveBeenCalled();
		expect(mocks.maybeEmitOnboardingProgress).not.toHaveBeenCalled();
		expect(mocks.flushTelemetryNow).not.toHaveBeenCalled();
	});
});

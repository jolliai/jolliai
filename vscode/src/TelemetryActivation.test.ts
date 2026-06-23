import { beforeEach, describe, expect, it, vi } from "vitest";

const bootstrapTelemetry = vi.fn(async () => {});
const flushTelemetryNow = vi.fn(async () => {});
const loadConfig = vi.fn(async () => ({}) as Record<string, unknown>);
const saveConfig = vi.fn(async () => {});
const shouldShowTelemetryNotice = vi.fn(() => false);
const shutdownTelemetry = vi.fn();

vi.mock("../../cli/src/core/TelemetryStartup.js", () => ({
	bootstrapTelemetry: (...args: unknown[]) => bootstrapTelemetry(...(args as [])),
	flushTelemetryNow: (...args: unknown[]) => flushTelemetryNow(...(args as [])),
}));
vi.mock("../../cli/src/core/TelemetryConsent.js", () => ({
	shouldShowTelemetryNotice: (...args: unknown[]) => shouldShowTelemetryNotice(...(args as [])),
}));
vi.mock("../../cli/src/core/Telemetry.js", () => ({
	shutdownTelemetry: (...args: unknown[]) => shutdownTelemetry(...(args as [])),
}));
vi.mock("../../cli/src/core/SessionTracker.js", () => ({
	loadConfig: (...args: unknown[]) => loadConfig(...(args as [])),
	saveConfig: (...args: unknown[]) => saveConfig(...(args as [])),
}));

import {
	activateExtensionTelemetry,
	flushExtensionTelemetry,
	reinitExtensionTelemetry,
	TELEMETRY_DOCS_URL,
	TELEMETRY_NOTICE,
	type TelemetryActivationDeps,
} from "./TelemetryActivation.js";

const makeDeps = (over: Partial<TelemetryActivationDeps> = {}): {
	deps: TelemetryActivationDeps;
	showNotice: ReturnType<typeof vi.fn>;
	openExternal: ReturnType<typeof vi.fn>;
} => {
	const showNotice = vi.fn(async () => undefined as string | undefined);
	const openExternal = vi.fn();
	return {
		deps: { platformDisabled: false, showNotice, openExternal, ...over },
		showNotice,
		openExternal,
	};
};

beforeEach(() => {
	vi.clearAllMocks();
	shouldShowTelemetryNotice.mockReturnValue(false);
	loadConfig.mockResolvedValue({});
});

describe("activateExtensionTelemetry", () => {
	it("bootstraps with the platform opt-out signal", async () => {
		const { deps } = makeDeps({ platformDisabled: true });
		await activateExtensionTelemetry("/repo", deps);
		expect(bootstrapTelemetry).toHaveBeenCalledWith({ cwd: "/repo", platformDisabled: true });
	});

	it("shows the notice once and records it when enabled", async () => {
		shouldShowTelemetryNotice.mockReturnValue(true);
		const { deps, showNotice } = makeDeps();
		await activateExtensionTelemetry("/repo", deps);
		expect(saveConfig).toHaveBeenCalledWith({ telemetryNoticeShown: true });
		expect(showNotice).toHaveBeenCalledWith(TELEMETRY_NOTICE, "Learn more", "Turn off");
	});

	it("opens the docs URL when the user clicks Learn more", async () => {
		shouldShowTelemetryNotice.mockReturnValue(true);
		const { deps, openExternal } = makeDeps();
		deps.showNotice = vi.fn(async () => "Learn more");
		await activateExtensionTelemetry("/repo", deps);
		expect(openExternal).toHaveBeenCalledWith(TELEMETRY_DOCS_URL);
	});

	it("turns telemetry off when the user clicks Turn off", async () => {
		shouldShowTelemetryNotice.mockReturnValue(true);
		const { deps, openExternal } = makeDeps();
		deps.showNotice = vi.fn(async () => "Turn off");
		await activateExtensionTelemetry("/repo", deps);
		expect(saveConfig).toHaveBeenCalledWith({ telemetry: "off" });
		expect(shutdownTelemetry).toHaveBeenCalled();
		expect(openExternal).not.toHaveBeenCalled();
	});

	it("does not open the docs URL when the notice is dismissed", async () => {
		shouldShowTelemetryNotice.mockReturnValue(true);
		const { deps, openExternal } = makeDeps();
		await activateExtensionTelemetry("/repo", deps);
		expect(openExternal).not.toHaveBeenCalled();
	});

	it("shows nothing when the notice is not due", async () => {
		shouldShowTelemetryNotice.mockReturnValue(false);
		const { deps, showNotice } = makeDeps();
		await activateExtensionTelemetry("/repo", deps);
		expect(showNotice).not.toHaveBeenCalled();
		expect(saveConfig).not.toHaveBeenCalled();
	});

	it("never throws when a dependency fails", async () => {
		loadConfig.mockRejectedValue(new Error("boom"));
		const { deps } = makeDeps();
		await expect(activateExtensionTelemetry("/repo", deps)).resolves.toBeUndefined();
	});
});

describe("flushExtensionTelemetry", () => {
	it("delegates to flushTelemetryNow, threading the platform opt-out signal", () => {
		flushExtensionTelemetry("/repo", true);
		expect(flushTelemetryNow).toHaveBeenCalledWith("/repo", { platformDisabled: true });
	});

	it("passes platformDisabled=false when the host telemetry is enabled", () => {
		flushExtensionTelemetry("/repo", false);
		expect(flushTelemetryNow).toHaveBeenCalledWith("/repo", { platformDisabled: false });
	});
});

describe("reinitExtensionTelemetry", () => {
	it("re-bootstraps with the new platform signal (no notice)", async () => {
		await reinitExtensionTelemetry("/repo", true);
		expect(bootstrapTelemetry).toHaveBeenCalledWith({ cwd: "/repo", platformDisabled: true });
	});
});

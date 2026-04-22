import { describe, expect, it, vi } from "vitest";
import type { StatusInfo } from "../../../cli/src/Types.js";

const { loadConfigFromDir, getGlobalConfigDir } = vi.hoisted(() => ({
	loadConfigFromDir: vi.fn(),
	getGlobalConfigDir: vi.fn(() => "/cfg"),
}));

vi.mock("../../../cli/src/core/SessionTracker.js", () => ({
	loadConfigFromDir,
	getGlobalConfigDir,
}));

import { StatusStore } from "./StatusStore.js";

function makeStatus(overrides: Partial<StatusInfo> = {}): StatusInfo {
	return {
		enabled: true,
		activeSessions: 0,
		mostRecentSession: null,
		summaryCount: 0,
		orphanBranch: "jollimemory",
		claudeDetected: false,
		codexDetected: false,
		geminiDetected: false,
		claudeHookInstalled: false,
		geminiHookInstalled: false,
		gitHookInstalled: false,
		...overrides,
	} as StatusInfo;
}

describe("StatusStore", () => {
	it("starts with empty snapshot and init reason", () => {
		const store = new StatusStore({ getStatus: vi.fn() } as never);
		expect(store.getSnapshot().status).toBeNull();
		expect(store.getSnapshot().changeReason).toBe("init");
	});

	it("refresh populates status and config, with signed-in flag from authService", async () => {
		const bridge = { getStatus: vi.fn(async () => makeStatus()) };
		const authService = { refreshContextKey: vi.fn() };
		loadConfigFromDir.mockResolvedValue({ apiKey: "k" });
		const store = new StatusStore(bridge as never, authService as never);
		await store.refresh();
		expect(store.getSnapshot().status?.enabled).toBe(true);
		expect(store.getSnapshot().derived.hasApiKey).toBe(true);
		expect(authService.refreshContextKey).toHaveBeenCalled();
	});

	it("refresh clears config when status.enabled is false", async () => {
		const bridge = {
			getStatus: vi.fn(async () => makeStatus({ enabled: false })),
		};
		loadConfigFromDir.mockResolvedValue({ apiKey: "k" });
		const store = new StatusStore(bridge as never);
		await store.refresh();
		expect(store.getSnapshot().config).toBeNull();
	});

	it("setStatus updates status snapshot with setStatus reason", () => {
		const store = new StatusStore({ getStatus: vi.fn() } as never);
		const listener = vi.fn();
		store.onChange(listener);
		store.setStatus(makeStatus({ activeSessions: 5 }));
		expect(listener).toHaveBeenCalled();
		expect(store.getSnapshot().status?.activeSessions).toBe(5);
		expect(store.getSnapshot().changeReason).toBe("setStatus");
	});

	it("setWorkerBusy is idempotent and broadcasts workerBusy reason on transition", () => {
		const store = new StatusStore({ getStatus: vi.fn() } as never);
		const listener = vi.fn();
		store.onChange(listener);
		store.setWorkerBusy(false); // default
		expect(listener).not.toHaveBeenCalled();
		store.setWorkerBusy(true);
		expect(listener).toHaveBeenCalled();
		expect(store.getSnapshot().changeReason).toBe("workerBusy");
		expect(store.getSnapshot().workerBusy).toBe(true);
	});

	it("setExtensionOutdated and setMigrating emit the correct reasons", () => {
		const store = new StatusStore({ getStatus: vi.fn() } as never);
		store.setExtensionOutdated(true);
		expect(store.getSnapshot().changeReason).toBe("extensionOutdated");
		expect(store.getSnapshot().extensionOutdated).toBe(true);
		store.setMigrating(true);
		expect(store.getSnapshot().changeReason).toBe("migrating");
		expect(store.getSnapshot().migrating).toBe(true);
	});

	it("setExtensionOutdated and setMigrating are idempotent", () => {
		const store = new StatusStore({ getStatus: vi.fn() } as never);
		const listener = vi.fn();
		store.onChange(listener);
		store.setExtensionOutdated(false); // default
		store.setMigrating(false); // default
		expect(listener).not.toHaveBeenCalled();
	});
});

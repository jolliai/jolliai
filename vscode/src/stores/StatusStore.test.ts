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

	it("refresh keeps config (and derived signedIn / hasApiKey) when status.enabled is false", async () => {
		// Disabling Jolli Memory only uninstalls hooks — it does not sign the
		// user out or wipe their Anthropic API key. The Sidebar's onboarding-
		// vs-main-UI gate is `signedIn || hasApiKey` and must continue to
		// reflect on-disk credentials, otherwise the disabled state replaces
		// the toolbar's "Enable" affordance with the onboarding panel and the
		// user can never re-enable from the sidebar.
		const bridge = {
			getStatus: vi.fn(async () => makeStatus({ enabled: false })),
		};
		loadConfigFromDir.mockResolvedValue({ apiKey: "k", authToken: "t" });
		const store = new StatusStore(bridge as never);
		await store.refresh();
		expect(store.getSnapshot().config).toEqual({ apiKey: "k", authToken: "t" });
		expect(store.getSnapshot().derived.hasApiKey).toBe(true);
		expect(store.getSnapshot().derived.signedIn).toBe(true);
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

	// ── setSyncPhase — sidebar Branch toolbar indicator ────────────────────
	describe("setSyncPhase", () => {
		it("sets the phase on the snapshot and emits 'syncPhase'", () => {
			const store = new StatusStore({ getStatus: vi.fn() } as never);
			const listener = vi.fn();
			store.onChange(listener);
			store.setSyncPhase({ label: "Getting latest memories…", severity: "info" });
			expect(listener).toHaveBeenCalledTimes(1);
			expect(store.getSnapshot().changeReason).toBe("syncPhase");
			expect(store.getSnapshot().syncPhase).toEqual({
				label: "Getting latest memories…",
				severity: "info",
			});
		});

		it("clearing with null returns the snapshot to idle", () => {
			const store = new StatusStore({ getStatus: vi.fn() } as never);
			store.setSyncPhase({ label: "Syncing…", severity: "info" });
			store.setSyncPhase(null);
			expect(store.getSnapshot().syncPhase).toBeNull();
		});

		it("setSyncPhase is idempotent (no emit for identical label+severity)", () => {
			const store = new StatusStore({ getStatus: vi.fn() } as never);
			store.setSyncPhase({ label: "Syncing…", severity: "info" });
			const listener = vi.fn();
			store.onChange(listener);
			store.setSyncPhase({ label: "Syncing…", severity: "info" });
			expect(listener).not.toHaveBeenCalled();
		});

		it("severity flip from info→error re-emits (sticky failure transition)", () => {
			const store = new StatusStore({ getStatus: vi.fn() } as never);
			store.setSyncPhase({ label: "Sharing your changes…", severity: "info" });
			const listener = vi.fn();
			store.onChange(listener);
			store.setSyncPhase({
				label: "Couldn't share your changes",
				severity: "error",
			});
			expect(listener).toHaveBeenCalledTimes(1);
		});

		it("setSyncPhase(null) is idempotent when already idle", () => {
			const store = new StatusStore({ getStatus: vi.fn() } as never);
			const listener = vi.fn();
			store.onChange(listener);
			store.setSyncPhase(null);
			expect(listener).not.toHaveBeenCalled();
		});

		it("syncPhase is independent of workerBusy (both can coexist on the snapshot)", () => {
			const store = new StatusStore({ getStatus: vi.fn() } as never);
			store.setWorkerBusy(true);
			store.setSyncPhase({ label: "Syncing…", severity: "info" });
			expect(store.getSnapshot().workerBusy).toBe(true);
			expect(store.getSnapshot().syncPhase).not.toBeNull();
		});
	});

	it("setWorkerPhase updates the snapshot and reason", () => {
		const store = new StatusStore({ getStatus: vi.fn() } as never);
		store.setWorkerBusy(true);
		store.setWorkerPhase("ingest");
		expect(store.getSnapshot().workerPhase).toBe("ingest");
		expect(store.getSnapshot().changeReason).toBe("workerPhase");
	});

	it("setWorkerPhase carries the ingest sub-phases verbatim (wiki / graph)", () => {
		const store = new StatusStore({ getStatus: vi.fn() } as never);
		store.setWorkerBusy(true);
		store.setWorkerPhase("ingest:wiki");
		expect(store.getSnapshot().workerPhase).toBe("ingest:wiki");
		store.setWorkerPhase("ingest:graph");
		expect(store.getSnapshot().workerPhase).toBe("ingest:graph");
	});

	it("setWorkerPhase is a no-op when unchanged", () => {
		const store = new StatusStore({ getStatus: vi.fn() } as never);
		let emits = 0;
		store.onChange(() => {
			emits++;
		});
		store.setWorkerPhase(null);
		expect(emits).toBe(0);
	});

	it("setWorkerBusy(false) clears a set workerPhase (lock-bound lifetime)", () => {
		const store = new StatusStore({ getStatus: vi.fn() } as never);
		store.setWorkerBusy(true);
		store.setWorkerPhase("ingest");
		store.setWorkerBusy(false);
		expect(store.getSnapshot().workerPhase).toBeNull();
		expect(store.getSnapshot().workerBusy).toBe(false);
	});

	it("setWorkerBusy(false) clears a stale workerPhase even when already not busy (crash-residue activation path)", () => {
		// Activation order is unspecified: readWorkerPhase() may read a stale
		// 'ingest' marker (left by a SIGKILL'd worker) BEFORE
		// isWorkerBusy().then(setWorkerBusy) resolves false. Because workerBusy
		// starts false, setWorkerBusy(false) would hit the equality early-return
		// and skip the phase clear — leaving a stale phase that mislabels the
		// next genuine summary run as "Building knowledge wiki…". The busy-bound
		// invariant must hold here too.
		const store = new StatusStore({ getStatus: vi.fn() } as never);
		store.setWorkerPhase("ingest"); // stale marker read while workerBusy is still false
		const listener = vi.fn();
		store.onChange(listener);
		store.setWorkerBusy(false); // isWorkerBusy() resolved false — no busy transition
		expect(store.getSnapshot().workerPhase).toBeNull();
		expect(listener).toHaveBeenCalled(); // snapshot changed (phase cleared), so subscribers must re-render
	});
});

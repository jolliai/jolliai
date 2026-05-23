/**
 * Tests for the sync command registrations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	registerCommand,
	showInformationMessage,
	registeredHandlers,
} = vi.hoisted(() => {
	const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();
	return {
		registerCommand: vi.fn(
			(id: string, handler: (...args: unknown[]) => unknown) => {
				registeredHandlers.set(id, handler);
				return { dispose: vi.fn() };
			},
		),
		showInformationMessage: vi.fn(async () => undefined),
		registeredHandlers,
	};
});

vi.mock("vscode", () => ({
	commands: { registerCommand },
	window: {
		showInformationMessage,
		createOutputChannel: () => ({
			appendLine: () => {},
			show: () => {},
			dispose: () => {},
		}),
	},
}));

import { registerSyncCommands } from "./SyncCommands.js";
import type { SyncRuntime } from "./VsCodeSyncBootstrap.js";

function makeRuntime(
	orch: { syncNow?: () => Promise<void>; isRoundInFlight?: () => boolean } | null,
): SyncRuntime {
	const wrapped = orch
		? {
				...orch,
				isRoundInFlight: orch.isRoundInFlight ?? (() => false),
			}
		: null;
	return {
		get: () => wrapped as never,
		ensureBuilt: async () => wrapped as never,
	} as unknown as SyncRuntime;
}

beforeEach(() => {
	registerCommand.mockClear();
	showInformationMessage.mockClear();
	registeredHandlers.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("registerSyncCommands", () => {
	it("registers one command", () => {
		registerSyncCommands({ runtime: makeRuntime(null) });
		const ids = registerCommand.mock.calls.map((c) => c[0]);
		expect(ids).toEqual(["jollimemory.syncNow"]);
	});

	it("syncNow shows the dormant-state info message when runtime.ensureBuilt yields null", async () => {
		registerSyncCommands({ runtime: makeRuntime(null) });
		await registeredHandlers.get("jollimemory.syncNow")?.();
		// §0.7: dormant message points at "sign in to Jolli", not the
		// retired "Enable Memory Bank cloud sync" master toggle.
		expect(showInformationMessage).toHaveBeenCalledWith(
			expect.stringContaining("Jolli sign-in"),
		);
	});

	it("syncNow delegates to the orchestrator returned by ensureBuilt", async () => {
		const syncNow = vi.fn(async () => undefined);
		registerSyncCommands({ runtime: makeRuntime({ syncNow }) });
		await registeredHandlers.get("jollimemory.syncNow")?.();
		expect(syncNow).toHaveBeenCalled();
		expect(showInformationMessage).not.toHaveBeenCalled();
	});

	it("syncNow silently no-ops when a round is already in flight (no second syncNow, no toast)", async () => {
		const syncNow = vi.fn(async () => undefined);
		const isRoundInFlight = vi.fn(() => true);
		registerSyncCommands({
			runtime: makeRuntime({ syncNow, isRoundInFlight }),
		});
		await registeredHandlers.get("jollimemory.syncNow")?.();
		expect(isRoundInFlight).toHaveBeenCalled();
		// Critical: a second sync MUST NOT be queued — the engine would
		// coalesce via sync.lock anyway, but issuing a redundant call would
		// double the work the next round driver sees.
		expect(syncNow).not.toHaveBeenCalled();
		// Status bar already shows "Syncing…" — no extra toast on repeat
		// clicks (would just be noise).
		expect(showInformationMessage).not.toHaveBeenCalled();
	});

});

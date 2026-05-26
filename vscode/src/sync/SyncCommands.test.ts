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
	orch: {
		syncNow?: () => Promise<void>;
		requestManualSync?: () => Promise<void>;
		isRoundInFlight?: () => boolean;
	} | null,
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

	it("syncNow delegates to requestManualSync on the orchestrator returned by ensureBuilt", async () => {
		const requestManualSync = vi.fn(async () => undefined);
		registerSyncCommands({ runtime: makeRuntime({ requestManualSync }) });
		await registeredHandlers.get("jollimemory.syncNow")?.();
		expect(requestManualSync).toHaveBeenCalled();
		expect(showInformationMessage).not.toHaveBeenCalled();
	});

	it("syncNow ALWAYS calls requestManualSync even when a round is already in flight (P3-A — orchestrator coalesces + queues followup)", async () => {
		// Pre-P3-A behaviour was an early-return in SyncCommands when
		// `isRoundInFlight()` was true. That dropped the manual click on
		// the floor if the in-flight round subsequently bailed at the
		// generation-mismatch check (user toggled auto-sync OFF during
		// a `readyPromise` wait). The orchestrator now owns the
		// in-flight coalescing via `requestManualSync` — which sets
		// `pendingManualFollowup`, awaits the current round, then fires
		// a fresh manual tick. The command layer just delegates.
		const requestManualSync = vi.fn(async () => undefined);
		const isRoundInFlight = vi.fn(() => true);
		registerSyncCommands({
			runtime: makeRuntime({ requestManualSync, isRoundInFlight }),
		});
		await registeredHandlers.get("jollimemory.syncNow")?.();
		expect(requestManualSync).toHaveBeenCalled();
		// Status bar already shows "Syncing…"; no extra toast.
		expect(showInformationMessage).not.toHaveBeenCalled();
	});

});

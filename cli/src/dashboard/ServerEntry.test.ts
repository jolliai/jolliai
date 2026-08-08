import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./DashboardServer.js", () => ({
	startDashboardServer: vi.fn(),
	clearDashboardState: vi.fn(async () => {}),
}));
vi.mock("./DashboardDb.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./DashboardDb.js")>();
	return { ...original, canUseDashboardDb: vi.fn(() => true) };
});

import { canUseDashboardDb } from "./DashboardDb.js";
import { clearDashboardState, startDashboardServer } from "./DashboardServer.js";
import { DASHBOARD_PORT_ENV, runServerEntry } from "./ServerEntry.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-entry-"));
	// clearMocks resets implementations between tests — re-arm the default here.
	vi.mocked(canUseDashboardDb).mockReturnValue(true);
	vi.mocked(startDashboardServer).mockResolvedValue({
		server: { closeAllConnections: vi.fn(), close: vi.fn() } as never,
		port: 1818,
	});
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("runServerEntry", () => {
	it("refuses to start below the flag-free node:sqlite floor", async () => {
		vi.mocked(canUseDashboardDb).mockReturnValue(false);
		await expect(runServerEntry({})).rejects.toThrow(/Node >= 22\.13/);
		expect(startDashboardServer).not.toHaveBeenCalled();
	});

	it("starts with no explicit port by default", async () => {
		await runServerEntry({});
		expect(startDashboardServer).toHaveBeenCalledWith(expect.not.objectContaining({ port: expect.anything() }));
		expect(vi.mocked(startDashboardServer).mock.calls[0][0]).not.toHaveProperty("port");
	});

	it("honours an explicit port from the environment and ignores garbage", async () => {
		await runServerEntry({ [DASHBOARD_PORT_ENV]: "4242" });
		expect(startDashboardServer).toHaveBeenLastCalledWith(expect.objectContaining({ port: 4242 }));
		await runServerEntry({ [DASHBOARD_PORT_ENV]: "nope" });
		expect(vi.mocked(startDashboardServer).mock.calls[1][0]).not.toHaveProperty("port");
	});

	it("shutdown closes the server, clears dashboard.json, then exits 0", async () => {
		const closeAllConnections = vi.fn();
		const close = vi.fn();
		vi.mocked(startDashboardServer).mockResolvedValue({
			server: { closeAllConnections, close } as never,
			port: 1818,
		});
		const exit = vi.fn();
		const { shutdown } = await runServerEntry({}, exit);
		shutdown();
		await new Promise((resolve) => setImmediate(resolve));
		expect(closeAllConnections).toHaveBeenCalled();
		expect(close).toHaveBeenCalled();
		expect(clearDashboardState).toHaveBeenCalled();
		expect(exit).toHaveBeenCalledWith(0);
	});

	it("the idle-shutdown callback clears state and exits 0", async () => {
		const exit = vi.fn();
		await runServerEntry({}, exit);
		const options = vi.mocked(startDashboardServer).mock.calls[0][0] as { onIdleShutdown?: () => void };
		options.onIdleShutdown?.();
		await new Promise((resolve) => setImmediate(resolve));
		expect(clearDashboardState).toHaveBeenCalled();
		expect(exit).toHaveBeenCalledWith(0);
	});
});

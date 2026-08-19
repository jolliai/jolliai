import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runGlobalDaemonMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const ensureGlobalDaemonMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../daemon/GlobalDaemon.js", () => ({
	GLOBAL_DAEMON_COMMAND: "global-daemon",
	runGlobalDaemon: runGlobalDaemonMock,
}));

vi.mock("../daemon/EnsureGlobalDaemon.js", () => ({
	GLOBAL_DAEMON_ENSURE_COMMAND: "global-daemon-ensure",
	ensureGlobalDaemon: ensureGlobalDaemonMock,
}));

import { registerGlobalDaemonCommand } from "./GlobalDaemonCommand.js";

function makeProgram(): Command {
	const program = new Command();
	program.exitOverride();
	registerGlobalDaemonCommand(program);
	return program;
}

beforeEach(() => {
	runGlobalDaemonMock.mockClear();
	ensureGlobalDaemonMock.mockClear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("registerGlobalDaemonCommand", () => {
	it("registers both hidden commands with stable descriptions", () => {
		const program = makeProgram();
		const daemon = program.commands.find((c) => c.name() === "global-daemon");
		const ensure = program.commands.find((c) => c.name() === "global-daemon-ensure");
		expect(daemon?.description()).toMatch(/machine-global resident process/i);
		expect(ensure?.description()).toMatch(/ensures the machine-global daemon exists/i);
	});

	it("runs the daemon with a --socket override", async () => {
		await makeProgram().parseAsync(["global-daemon", "--socket", "/tmp/jolli.sock"], { from: "user" });
		expect(runGlobalDaemonMock).toHaveBeenCalledWith({ socketPath: "/tmp/jolli.sock" });
		expect(ensureGlobalDaemonMock).not.toHaveBeenCalled();
	});

	it("runs the daemon with no --socket (derived path)", async () => {
		await makeProgram().parseAsync(["global-daemon"], { from: "user" });
		expect(runGlobalDaemonMock).toHaveBeenCalledWith({ socketPath: undefined });
	});

	it("runs the ensure helper with a --socket override", async () => {
		await makeProgram().parseAsync(["global-daemon-ensure", "--socket", "/tmp/e.sock"], { from: "user" });
		expect(ensureGlobalDaemonMock).toHaveBeenCalledWith({ socketPath: "/tmp/e.sock" });
		expect(runGlobalDaemonMock).not.toHaveBeenCalled();
	});

	it("runs the ensure helper with no --socket (derived path)", async () => {
		await makeProgram().parseAsync(["global-daemon-ensure"], { from: "user" });
		expect(ensureGlobalDaemonMock).toHaveBeenCalledWith({ socketPath: undefined });
	});
});

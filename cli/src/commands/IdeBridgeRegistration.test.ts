import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeIdeBridgeCommandMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const runIdeBridgeServeMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

// The registration file dynamically imports IdeBridgeCommand.ts inside each
// action so the large dispatcher is only loaded on demand. Mock both so the
// tests exercise the registration + dispatch wiring without pulling in the
// real handler (which touches storage / auth / git).
vi.mock("./IdeBridgeCommand.js", () => ({
	executeIdeBridgeCommand: executeIdeBridgeCommandMock,
	runIdeBridgeServe: runIdeBridgeServeMock,
}));

vi.mock("../util/Subprocess.js", () => ({
	execFileSyncHidden: () => "/mock/repo",
}));

import { registerIdeBridgeCommand } from "./IdeBridgeRegistration.js";

function makeProgram(): Command {
	const program = new Command();
	program.exitOverride();
	registerIdeBridgeCommand(program);
	return program;
}

beforeEach(() => {
	executeIdeBridgeCommandMock.mockClear();
	runIdeBridgeServeMock.mockClear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("registerIdeBridgeCommand", () => {
	it("registers both 'ide-bridge' and 'ide-bridge-serve'", () => {
		const program = makeProgram();
		const names = program.commands.map((c) => c.name());
		expect(names).toContain("ide-bridge");
		expect(names).toContain("ide-bridge-serve");
	});

	it("routes 'ide-bridge <action> --cwd <dir>' to executeIdeBridgeCommand with the parsed args", async () => {
		await makeProgram().parseAsync(["ide-bridge", "status", "--cwd", "/some/repo"], { from: "user" });
		expect(executeIdeBridgeCommandMock).toHaveBeenCalledWith("status", "/some/repo");
		expect(runIdeBridgeServeMock).not.toHaveBeenCalled();
	});

	it("defaults ide-bridge --cwd to the resolved project directory", async () => {
		await makeProgram().parseAsync(["ide-bridge", "status"], { from: "user" });
		expect(executeIdeBridgeCommandMock).toHaveBeenCalledOnce();
		const [action, cwd] = executeIdeBridgeCommandMock.mock.calls[0];
		expect(action).toBe("status");
		expect(typeof cwd).toBe("string");
		expect(cwd.length).toBeGreaterThan(0);
	});

	it("routes 'ide-bridge-serve --cwd <dir>' to runIdeBridgeServe", async () => {
		await makeProgram().parseAsync(["ide-bridge-serve", "--cwd", "/serve/repo"], { from: "user" });
		expect(runIdeBridgeServeMock).toHaveBeenCalledWith("/serve/repo");
		expect(executeIdeBridgeCommandMock).not.toHaveBeenCalled();
	});

	it("defaults ide-bridge-serve --cwd to the resolved project directory", async () => {
		await makeProgram().parseAsync(["ide-bridge-serve"], { from: "user" });
		expect(runIdeBridgeServeMock).toHaveBeenCalledOnce();
		const [cwd] = runIdeBridgeServeMock.mock.calls[0];
		expect(typeof cwd).toBe("string");
		expect(cwd.length).toBeGreaterThan(0);
	});

	it("gives ide-bridge-serve a stable, user-readable description", () => {
		const program = makeProgram();
		const cmd = program.commands.find((c) => c.name() === "ide-bridge-serve");
		expect(cmd?.description()).toMatch(/long-lived ndjson ide-bridge server/i);
	});
});

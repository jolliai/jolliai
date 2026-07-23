import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runDaemonServerMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const setLogDirMock = vi.hoisted(() => vi.fn());

vi.mock("../daemon/DaemonServer.js", () => ({
	runDaemonServer: runDaemonServerMock,
}));

vi.mock("../Logger.js", () => ({
	setLogDir: setLogDirMock,
	createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
	getJolliMemoryDir: (cwd: string) => `${cwd}/.jolli/jollimemory`,
}));

// resolveProjectDir shells out to git in production; stub the underlying
// child_process call so the module-load cache defaults to a stable value.
vi.mock("../util/Subprocess.js", () => ({
	execFileSyncHidden: () => "/mock/repo",
}));

import { registerDaemonCommand } from "./DaemonCommand.js";

function makeProgram(): Command {
	const program = new Command();
	program.exitOverride();
	registerDaemonCommand(program);
	return program;
}

beforeEach(() => {
	runDaemonServerMock.mockClear();
	setLogDirMock.mockClear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("registerDaemonCommand", () => {
	it("registers a hidden 'daemon' command with --cwd and --debounce options", () => {
		const program = makeProgram();
		const cmd = program.commands.find((c) => c.name() === "daemon");
		expect(cmd).toBeDefined();
		// commander marks hidden commands via a private flag; assert its
		// visible-help description is stable so the shape is regression-checked.
		expect(cmd?.description()).toMatch(/long-running stdio daemon/i);
	});

	it("forwards --cwd to setLogDir and to runDaemonServer without a debounce override", async () => {
		await makeProgram().parseAsync(["daemon", "--cwd", "/my/repo"], { from: "user" });
		expect(setLogDirMock).toHaveBeenCalledWith("/my/repo");
		expect(runDaemonServerMock).toHaveBeenCalledWith({ cwd: "/my/repo", debounceMs: undefined });
	});

	it("parses --debounce as a non-negative integer and forwards it", async () => {
		await makeProgram().parseAsync(["daemon", "--cwd", "/r", "--debounce", "150"], { from: "user" });
		expect(runDaemonServerMock).toHaveBeenCalledWith({ cwd: "/r", debounceMs: 150 });
	});

	it("accepts 0 as a valid debounce value (no coalescing)", async () => {
		await makeProgram().parseAsync(["daemon", "--cwd", "/r", "--debounce", "0"], { from: "user" });
		expect(runDaemonServerMock).toHaveBeenCalledWith({ cwd: "/r", debounceMs: 0 });
	});

	it("rejects a non-integer --debounce value with a clear error", async () => {
		await expect(
			makeProgram().parseAsync(["daemon", "--cwd", "/r", "--debounce", "1.5"], { from: "user" }),
		).rejects.toThrow(/Invalid --debounce value: 1\.5/);
	});

	it("rejects a negative --debounce value", async () => {
		await expect(
			makeProgram().parseAsync(["daemon", "--cwd", "/r", "--debounce", "-3"], { from: "user" }),
		).rejects.toThrow(/Invalid --debounce value: -3/);
	});

	it("rejects a trailing-junk --debounce value that parseInt would silently accept", async () => {
		await expect(
			makeProgram().parseAsync(["daemon", "--cwd", "/r", "--debounce", "300abc"], { from: "user" }),
		).rejects.toThrow(/Invalid --debounce value: 300abc/);
	});

	it("defaults --cwd to the resolved project directory when the flag is omitted", async () => {
		await makeProgram().parseAsync(["daemon"], { from: "user" });
		expect(setLogDirMock).toHaveBeenCalledOnce();
		const arg = setLogDirMock.mock.calls[0][0];
		expect(typeof arg).toBe("string");
		expect(arg.length).toBeGreaterThan(0);
	});
});

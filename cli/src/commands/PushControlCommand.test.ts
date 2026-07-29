import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/PushControl.js", () => ({
	readPushDisabledState: vi.fn(),
	applyPushDisabled: vi.fn(),
}));
vi.mock("../Logger.js", () => ({ setLogDir: vi.fn() }));
vi.mock("./CliUtils.js", () => ({ resolveProjectDir: () => "/current/repo" }));

import { applyPushDisabled, readPushDisabledState } from "../core/PushControl.js";
import { registerPushControlCommand } from "./PushControlCommand.js";

const mockState = vi.mocked(readPushDisabledState);
const mockApply = vi.mocked(applyPushDisabled);

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	let stdout = "";
	let stderr = "";
	const origLog = console.log;
	const origErr = console.error;
	console.log = (m: string) => {
		stdout += `${m}\n`;
	};
	console.error = (m: string) => {
		stderr += `${m}\n`;
	};
	process.exitCode = 0;
	try {
		const program = new Command();
		program.exitOverride();
		registerPushControlCommand(program);
		await program.parseAsync(["node", "jolli", "push-control", ...args]);
	} finally {
		console.log = origLog;
		console.error = origErr;
	}
	const exitCode = (process.exitCode as number) ?? 0;
	process.exitCode = 0;
	return { stdout, stderr, exitCode };
}

describe("jolli push-control", () => {
	beforeEach(() => {
		mockState.mockReset().mockResolvedValue({ disabled: false });
		mockApply.mockReset().mockResolvedValue({ disabled: true, recoveredFromCorrupt: false });
	});

	it("shows the current repo's state (ON) with no flags", async () => {
		mockState.mockResolvedValue({ disabled: false });
		const { stdout } = await run([]);
		expect(stdout).toContain("ON");
		expect(stdout).toContain("--disable");
	});

	it("shows the OFF state and the enable hint when push-disabled", async () => {
		mockState.mockResolvedValue({ disabled: true });
		const { stdout } = await run([]);
		expect(stdout).toContain("OFF");
		expect(stdout).toContain("--enable");
	});

	it("emits JSON state under --format json", async () => {
		mockState.mockResolvedValue({ disabled: true });
		const { stdout } = await run(["--format", "json"]);
		expect(JSON.parse(stdout)).toEqual({ type: "state", pushDisabled: true });
	});

	it("explains a fail-closed OFF, naming the unreadable store", async () => {
		// Without this the user sees a bare OFF for every repo on the machine and
		// has nothing pointing at the one corrupt file.
		mockState.mockResolvedValue({ disabled: true, error: "Push-control store at /g/push-control.json is corrupt" });
		const { stdout } = await run([]);
		expect(stdout).toContain("could not be read");
		expect(stdout).toContain("/g/push-control.json");
		// The recovery hint must not hide that --enable rebuilds from an empty set.
		expect(stdout).toContain("drops every repo's opt-out");
	});

	it("carries the read error in the JSON state", async () => {
		mockState.mockResolvedValue({ disabled: true, error: "unreadable" });
		const { stdout } = await run(["--format", "json"]);
		expect(JSON.parse(stdout)).toEqual({ type: "state", pushDisabled: true, error: "unreadable" });
	});

	it("disables the current repo", async () => {
		await run(["--disable"]);
		expect(mockApply).toHaveBeenCalledWith("/current/repo", true, "cli");
	});

	it("enables the current repo", async () => {
		await run(["--enable"]);
		expect(mockApply).toHaveBeenCalledWith("/current/repo", false, "cli");
	});

	it("emits JSON set under --format json", async () => {
		const { stdout } = await run(["--disable", "--format", "json"]);
		expect(JSON.parse(stdout)).toEqual({ type: "set", pushDisabled: true, cwd: "/current/repo" });
	});

	it("rejects --enable and --disable together", async () => {
		const { stderr, exitCode } = await run(["--enable", "--disable"]);
		expect(stderr).toContain("mutually exclusive");
		expect(exitCode).toBe(1);
		expect(mockApply).not.toHaveBeenCalled();
	});

	it("surfaces a thrown error to stderr and exits 1", async () => {
		mockState.mockRejectedValue(new Error("boom"));
		const { stderr, exitCode } = await run([]);
		expect(stderr).toContain("boom");
		expect(exitCode).toBe(1);
	});

	it("emits a JSON error under --format json", async () => {
		mockApply.mockRejectedValue(new Error("nope"));
		const { stdout, exitCode } = await run(["--disable", "--format", "json"]);
		expect(JSON.parse(stdout)).toEqual({ type: "error", message: "nope" });
		expect(exitCode).toBe(1);
	});
});

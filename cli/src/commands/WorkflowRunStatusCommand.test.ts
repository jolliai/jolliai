import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkflowRunStatusCommand } from "./WorkflowRunStatusCommand.js";

const { monitorRunMock, realSleepMock, getRunStatusMock } = vi.hoisted(() => ({
	monitorRunMock: vi.fn(),
	realSleepMock: vi.fn().mockResolvedValue(undefined),
	getRunStatusMock: vi.fn(),
}));

// The command constructs `new JolliMemoryPushClient()` and drives `monitorRun`.
// Mock both leaves so the command's own wiring (deps assembly, JSON print, exit
// codes) runs for real without a live backend or real timers.
vi.mock("../core/WorkflowRunMonitor.js", () => ({ monitorRun: monitorRunMock, realSleep: realSleepMock }));
vi.mock("../core/JolliMemoryPushClient.js", () => ({
	JolliMemoryPushClient: class {
		getRunStatus = getRunStatusMock;
	},
}));

async function run(): Promise<string> {
	const logs: string[] = [];
	vi.spyOn(console, "log").mockImplementation((m?: unknown) => void logs.push(String(m)));
	const program = new Command();
	registerWorkflowRunStatusCommand(program);
	await program.parseAsync(["node", "jolli", "workflow-run-status", "run_42"]);
	return logs.join("\n");
}

beforeEach(() => {
	process.exitCode = 0;
	monitorRunMock.mockReset();
	getRunStatusMock.mockReset();
});
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

describe("workflow-run-status command", () => {
	it("prints the monitor's report as JSON and wires the real client + sleep", async () => {
		const report = {
			status: "succeeded",
			openableUrls: [{ kind: "workflow", url: "https://jolli.ai/w/1" }],
		};
		monitorRunMock.mockResolvedValue(report);

		const out = await run();

		expect(JSON.parse(out)).toEqual(report);
		expect(process.exitCode).toBe(0);
		expect(monitorRunMock).toHaveBeenCalledTimes(1);
		const [deps, runId] = monitorRunMock.mock.calls[0];
		expect(runId).toBe("run_42");
		expect(deps.sleep).toBe(realSleepMock);
		// The injected getRunStatus forwards to the client's method.
		await deps.getRunStatus("run_42");
		expect(getRunStatusMock).toHaveBeenCalledWith("run_42");
	});

	it("prints a type:error result and exits non-zero when the monitor rejects", async () => {
		monitorRunMock.mockRejectedValue(new Error("platform tools off"));

		const out = await run();

		expect(JSON.parse(out)).toEqual({ type: "error", message: "platform tools off" });
		expect(process.exitCode).toBe(1);
	});

	it("stringifies a non-Error rejection", async () => {
		monitorRunMock.mockRejectedValue("boom");

		const out = await run();

		expect(JSON.parse(out)).toEqual({ type: "error", message: "boom" });
		expect(process.exitCode).toBe(1);
	});
});

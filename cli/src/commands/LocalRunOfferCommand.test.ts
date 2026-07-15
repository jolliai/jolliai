import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerLocalRunOfferCommand } from "./LocalRunOfferCommand.js";

const { listWorkflowsMock, execFileMock } = vi.hoisted(() => ({
	listWorkflowsMock: vi.fn(),
	execFileMock: vi.fn(),
}));

// The command constructs `new JolliMemoryPushClient()` and calls `.listWorkflows()`,
// and spawns the clones read through `execFileAsyncHidden`. Mock both leaves so the
// command's own wiring (offer resolve, clones parse, JSON print, exit codes) runs
// for real without a live backend or a real space-cli.
vi.mock("../core/JolliMemoryPushClient.js", () => ({
	JolliMemoryPushClient: class {
		listWorkflows = listWorkflowsMock;
	},
}));
vi.mock("../util/Subprocess.js", () => ({ execFileAsyncHidden: execFileMock }));

const JRN = "jrn:/global:spaces:space/impact-1783452586552";

function wfEntry(id: string | number, syncProtocol: string, autoApply: boolean, jrn: string) {
	return { id, destination: { syncProtocol, autoApply, jrn } };
}

async function run(): Promise<string> {
	const logs: string[] = [];
	vi.spyOn(console, "log").mockImplementation((m?: unknown) => void logs.push(String(m)));
	const program = new Command();
	registerLocalRunOfferCommand(program);
	await program.parseAsync(["node", "jolli", "local-run-workflows"]);
	return logs.join("\n");
}

beforeEach(() => {
	process.exitCode = 0;
	listWorkflowsMock.mockReset();
	execFileMock.mockReset();
});
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

describe("local-run-workflows command", () => {
	it("prints only the runnable workflows (git-backed + cloned) with their autoMerges signal", async () => {
		listWorkflowsMock.mockResolvedValue([
			wfEntry(7, "git", true, JRN),
			wfEntry(9, "git", false, "jrn:/global:spaces:space/uncloned"),
			wfEntry(5, "db", true, JRN),
		]);
		execFileMock.mockResolvedValue({ stdout: JSON.stringify([{ jrn: JRN }]), stderr: "" });

		const out = await run();
		expect(JSON.parse(out)).toEqual({
			type: "workflows",
			workflows: [{ id: 7, autoMerges: true }],
		});
		expect(process.exitCode).toBe(0);
	});

	it("includes each runnable workflow's display name in the printed offer when the backend supplied one", async () => {
		listWorkflowsMock.mockResolvedValue([
			{ id: 7, name: "Impact Analysis", destination: { syncProtocol: "git", autoApply: true, jrn: JRN } },
		]);
		execFileMock.mockResolvedValue({ stdout: JSON.stringify([{ jrn: JRN }]), stderr: "" });

		const out = await run();
		expect(JSON.parse(out)).toEqual({
			type: "workflows",
			workflows: [{ id: 7, name: "Impact Analysis", autoMerges: true }],
		});
		expect(process.exitCode).toBe(0);
	});

	it("spawns the clones read via the run-cli indirection (never a bare `jolli` on PATH)", async () => {
		listWorkflowsMock.mockResolvedValue([wfEntry(7, "git", true, JRN)]);
		execFileMock.mockResolvedValue({ stdout: "[]", stderr: "" });

		await run();
		expect(execFileMock).toHaveBeenCalledTimes(1);
		const [command, args] = execFileMock.mock.calls[0];
		expect(command).not.toBe("jolli");
		expect(command === "node" || String(command).endsWith("run-cli")).toBe(true);
		expect(args).toEqual(["space", "clones", "--json"]);
	});

	it("prints the space_cli_required install prompt when the clones spawn fails (space-cli missing)", async () => {
		listWorkflowsMock.mockResolvedValue([wfEntry(7, "git", true, JRN)]);
		execFileMock.mockRejectedValue(new Error("spawn jolli ENOENT"));

		const out = await run();
		expect(JSON.parse(out)).toEqual({
			type: "space_cli_required",
			message: expect.stringContaining("space-cli"),
			install: "npm i -g @jolli.ai/cli @jolli.ai/space-cli",
		});
		// A needs-input result is NOT a failure.
		expect(process.exitCode).toBe(0);
	});

	it("prints an empty list (without spawning clones) when the workflow list degrades to empty", async () => {
		listWorkflowsMock.mockResolvedValue([]);

		const out = await run();
		expect(JSON.parse(out)).toEqual({ type: "workflows", workflows: [] });
		expect(execFileMock).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(0);
	});

	it("prints a type:error result and exits non-zero on an unexpected failure", async () => {
		listWorkflowsMock.mockRejectedValue(new Error("boom"));

		const out = await run();
		expect(JSON.parse(out)).toEqual({ type: "error", message: "boom" });
		expect(process.exitCode).toBe(1);
	});
});

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunPayload } from "../core/WorkflowRunReport.js";
import { registerWorkflowRunsCommand } from "./WorkflowRunsCommand.js";

const { listWorkflowRunsMock } = vi.hoisted(() => ({ listWorkflowRunsMock: vi.fn() }));

// The command constructs `new JolliMemoryPushClient()` and drives
// `listWorkflowRuns`. Mock the client leaf so the command's own wiring (id
// coercion, per-run projection via the real `shapeRunHistoryEntry`, JSON print,
// degrade-on-throw) runs for real without a live backend.
vi.mock("../core/JolliMemoryPushClient.js", () => ({
	JolliMemoryPushClient: class {
		listWorkflowRuns = listWorkflowRunsMock;
	},
}));

async function run(arg: string): Promise<string> {
	const logs: string[] = [];
	vi.spyOn(console, "log").mockImplementation((m?: unknown) => void logs.push(String(m)));
	const program = new Command();
	registerWorkflowRunsCommand(program);
	await program.parseAsync(["node", "jolli", "workflow-runs", arg]);
	return logs.join("\n");
}

beforeEach(() => {
	process.exitCode = 0;
	listWorkflowRunsMock.mockReset();
});
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

describe("workflow-runs command", () => {
	it("projects a mixed history (git-backed PR, jolli-git withheld, failed, cancelled) into per-run rows", async () => {
		const runs: WorkflowRunPayload[] = [
			{
				id: "r4",
				status: "completed",
				createdAt: "2026-07-17T10:00:00Z",
				workflowUrl: "https://jolli.ai/w/7",
				runUrl: "https://jolli.ai/w/7/r/r4",
				pullRequest: { number: 5, url: "https://gh/pr/5", state: "open" },
			},
			{
				id: "r3",
				status: "completed",
				createdAt: "2026-07-17T09:00:00Z",
				writtenArticles: [{ operation: "edited", path: "a.md", url: "https://jolli.ai/a", active: true }],
			},
			{ id: "r2", status: "failed", createdAt: "2026-07-17T08:00:00Z", error: "code=TIMEOUT: x" },
			{ id: "r1", status: "cancelled", createdAt: "2026-07-17T07:00:00Z", canceledBy: "Dev" },
		];
		listWorkflowRunsMock.mockResolvedValue(runs);

		const out = await run("7");

		expect(JSON.parse(out)).toEqual({
			type: "runs",
			runs: [
				{
					runId: "r4",
					status: "succeeded",
					timestamp: "2026-07-17T10:00:00Z",
					workflowUrl: "https://jolli.ai/w/7",
					runUrl: "https://jolli.ai/w/7/r/r4",
					prUrl: "https://gh/pr/5",
					articleUrls: [],
				},
				{
					runId: "r3",
					status: "succeeded",
					timestamp: "2026-07-17T09:00:00Z",
					articleUrls: ["https://jolli.ai/a"],
				},
				{ runId: "r2", status: "failed", timestamp: "2026-07-17T08:00:00Z", articleUrls: [] },
				{ runId: "r1", status: "cancelled", timestamp: "2026-07-17T07:00:00Z", articleUrls: [] },
			],
		});
		expect(process.exitCode).toBe(0);
	});

	it("coerces a numeric workflow id to a number before calling the client", async () => {
		listWorkflowRunsMock.mockResolvedValue([]);
		await run("42");
		expect(listWorkflowRunsMock).toHaveBeenCalledWith(42);
	});

	it("passes a non-numeric workflow id verbatim (for the backend to reject)", async () => {
		listWorkflowRunsMock.mockResolvedValue([]);
		await run("wf-abc");
		expect(listWorkflowRunsMock).toHaveBeenCalledWith("wf-abc");
	});

	it("prints an empty list for a workflow with no run history", async () => {
		listWorkflowRunsMock.mockResolvedValue([]);
		const out = await run("7");
		expect(JSON.parse(out)).toEqual({ type: "runs", runs: [] });
		expect(process.exitCode).toBe(0);
	});

	it("degrades to an empty list (exit 0) when the history is unavailable (loud-fail from the client)", async () => {
		listWorkflowRunsMock.mockRejectedValue(new Error("platform tools off"));
		const out = await run("7");
		expect(JSON.parse(out)).toEqual({ type: "runs", runs: [] });
		expect(process.exitCode).toBe(0);
	});
});

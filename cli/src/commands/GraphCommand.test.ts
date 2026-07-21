import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { exportGraphHtml } = vi.hoisted(() => ({ exportGraphHtml: vi.fn() }));
vi.mock("../graph/GraphExport.js", () => ({ exportGraphHtml }));

const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("open", () => ({ default: open }));

import { executeGraph, registerGraphCommand } from "./GraphCommand.js";

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	exportGraphHtml.mockReset();
	open.mockReset();
	process.exitCode = 0;
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	process.exitCode = 0;
});

describe("executeGraph", () => {
	it("errors and sets exit code when --export is missing", async () => {
		await executeGraph({});
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("requires --export"));
		expect(exportGraphHtml).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it("exports to the given dir using cwd default and prints the path", async () => {
		exportGraphHtml.mockResolvedValue("/out/repo-graph.html");
		await executeGraph({ export: "/out" });
		expect(exportGraphHtml).toHaveBeenCalledWith({ cwd: process.cwd(), out: "/out" });
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("/out/repo-graph.html"));
		expect(open).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(0);
	});

	it("bare --export (true) exports with out omitted → GraphExport picks the personal dir", async () => {
		exportGraphHtml.mockResolvedValue("/home/u/.jolli/jollimemory/graph/repo-graph.html");
		await executeGraph({ export: true });
		expect(exportGraphHtml).toHaveBeenCalledWith({ cwd: process.cwd(), out: undefined });
		expect(process.exitCode).toBe(0);
	});

	it("passes an explicit --cwd through", async () => {
		exportGraphHtml.mockResolvedValue("/out/x-graph.html");
		await executeGraph({ export: "/out", cwd: "/repo" });
		expect(exportGraphHtml).toHaveBeenCalledWith({ cwd: "/repo", out: "/out" });
	});

	it("opens the browser with --open", async () => {
		exportGraphHtml.mockResolvedValue("/out/repo-graph.html");
		await executeGraph({ export: "/out", open: true });
		expect(open).toHaveBeenCalledWith("/out/repo-graph.html");
	});

	it("tolerates a browser-open failure (non-fatal; non-Error rejection)", async () => {
		exportGraphHtml.mockResolvedValue("/out/repo-graph.html");
		open.mockRejectedValue("no browser"); // non-Error → exercises errMsg's String() branch
		await executeGraph({ export: "/out", open: true });
		expect(process.exitCode).toBe(0); // open failure must not fail the export
	});

	it("reports a clear error and sets exit code when export throws", async () => {
		exportGraphHtml.mockRejectedValue(new Error("No knowledge graph found"));
		await executeGraph({ export: "/out" });
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("No knowledge graph found"));
		expect(process.exitCode).toBe(1);
	});
});

describe("registerGraphCommand", () => {
	it("registers a `graph` command with --export/--cwd/--open", () => {
		const opts: string[] = [];
		const cmd = {
			description: vi.fn().mockReturnThis(),
			option: vi.fn(function (this: unknown, flags: string) {
				opts.push(flags);
				return this;
			}),
			action: vi.fn().mockReturnThis(),
		};
		const program = { command: vi.fn().mockReturnValue(cmd) } as never;
		registerGraphCommand(program);
		expect((program as { command: ReturnType<typeof vi.fn> }).command).toHaveBeenCalledWith("graph");
		expect(opts.some((o) => o.includes("--export"))).toBe(true);
		expect(opts.some((o) => o.includes("--cwd"))).toBe(true);
		expect(opts.some((o) => o.includes("--open"))).toBe(true);
		expect(cmd.action).toHaveBeenCalledWith(executeGraph);
	});
});

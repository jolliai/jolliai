/**
 * CutoverCommand — thin reporting over the engine/router; what's pinned here
 * is the mapping from each outcome to exit code and message, especially that
 * blocked/not-ready/drift set a non-zero exit (scripts gate on it).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../dashboard/CutoverEngine.js", () => ({
	runCutover: vi.fn(),
	probeCutoverDrift: vi.fn(),
}));
vi.mock("../dashboard/CutoverRouter.js", () => ({
	resolveCutoverRoute: vi.fn(),
}));
vi.mock("../Logger.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, setLogDir: vi.fn() };
});

import { Command } from "commander";
import { probeCutoverDrift, runCutover } from "../dashboard/CutoverEngine.js";
import { resolveCutoverRoute } from "../dashboard/CutoverRouter.js";
import { registerCutoverCommand } from "./CutoverCommand.js";

async function run(...args: string[]): Promise<string[]> {
	const lines: string[] = [];
	const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
		lines.push(line);
	});
	try {
		const program = new Command();
		program.exitOverride();
		registerCutoverCommand(program);
		await program.parseAsync(["node", "jolli", "cutover", "--cwd", "/repo", ...args]);
	} finally {
		spy.mockRestore();
	}
	return lines;
}

beforeEach(() => {
	vi.clearAllMocks();
	process.exitCode = undefined;
});

describe("jolli cutover", () => {
	it("reports a committed cutover and asks for restarts", async () => {
		vi.mocked(runCutover).mockResolvedValue({
			status: "committed",
			record: { tips: {}, cutoverVersion: 3, committedAt: "t", schemaVersion: 1 },
		});
		const lines = await run();
		expect(lines.join("\n")).toContain("version 3");
		expect(lines.join("\n")).toContain("Restart IDEs");
		expect(process.exitCode).toBeUndefined();
	});

	it("not-ready and retry-exhausted exit non-zero with the reason", async () => {
		vi.mocked(runCutover).mockResolvedValue({ status: "not-ready", reason: "stale surfaces" });
		expect((await run()).join("\n")).toContain("stale surfaces");
		expect(process.exitCode).toBe(1);
		process.exitCode = undefined;
		vi.mocked(runCutover).mockResolvedValue({ status: "retry-exhausted", reason: "tips kept moving" });
		expect((await run()).join("\n")).toContain("tips kept moving");
		expect(process.exitCode).toBe(1);
		process.exitCode = undefined;
		vi.mocked(runCutover).mockResolvedValue({ status: "already-cutover" });
		expect((await run()).join("\n")).toContain("nothing to do");
		expect(process.exitCode).toBeUndefined();
	});

	it("--status renders each of the four states; blocked exits non-zero", async () => {
		vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "uncutover" });
		expect((await run("--status")).join("\n")).not.toContain("warning");
		vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "uncutover", warning: "db unreadable" });
		let out = (await run("--status")).join("\n");
		expect(out).toContain("uncutover");
		expect(out).toContain("db unreadable");
		vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "legacy-fenced" });
		expect((await run("--status")).join("\n")).toContain("finish the commit");
		vi.mocked(resolveCutoverRoute).mockResolvedValue({
			state: "cutover",
			record: { tips: {}, cutoverVersion: 2, committedAt: "T", schemaVersion: 1 },
		});
		expect((await run("--status")).join("\n")).toContain("version 2");
		expect(process.exitCode).toBeUndefined();
		vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "blocked", reason: "no database" });
		out = (await run("--status")).join("\n");
		expect(out).toContain("BLOCKED");
		expect(process.exitCode).toBe(1);
	});

	it("--probe is quiet when clean and loud (non-zero) on drift", async () => {
		vi.mocked(probeCutoverDrift).mockResolvedValue([]);
		expect((await run("--probe")).join("\n")).toContain("no drift");
		expect(process.exitCode).toBeUndefined();
		vi.mocked(probeCutoverDrift).mockResolvedValue([
			{ root: "/r", recordedTip: "a".repeat(40), currentTip: "b".repeat(40) },
			{ root: "/gone", recordedTip: "a".repeat(40), currentTip: null },
		]);
		const out = (await run("--probe")).join("\n");
		expect(out).toContain("DRIFT in /r");
		expect(out).toContain("(unresolvable)");
		expect(out).toContain("bypassed the fence");
		expect(process.exitCode).toBe(1);
	});
});

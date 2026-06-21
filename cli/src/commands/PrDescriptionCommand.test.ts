import { Readable } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrDescriptionResult } from "../core/PrDescription.js";
import { registerPrDescriptionCommand } from "./PrDescriptionCommand.js";

vi.mock("../core/PrDescription.js", () => ({
	buildPrDescription: vi.fn(),
}));

import { buildPrDescription } from "../core/PrDescription.js";

const mockBuild = vi.mocked(buildPrDescription);

function sampleResult(overrides: Partial<PrDescriptionResult> = {}): PrDescriptionResult {
	return {
		type: "pr_description",
		branch: "feature/x",
		baseBranch: "main",
		title: "feat: add x",
		body: "## Summary\nbody text",
		commitCount: 3,
		summaryCount: 3,
		missingCount: 0,
		...overrides,
	};
}

function makeProgram(): Command {
	const program = new Command();
	program.exitOverride();
	registerPrDescriptionCommand(program);
	return program;
}

async function runCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const origLog = console.log;
	const origErr = console.error;
	console.log = (msg: string) => {
		stdout += `${msg}\n`;
	};
	console.error = (msg: string) => {
		stderr += `${msg}\n`;
	};
	try {
		await makeProgram().parseAsync(["node", "jolli", "pr-description", ...args]);
	} finally {
		console.log = origLog;
		console.error = origErr;
	}
	return { stdout, stderr };
}

async function runWithStdin(args: string[], stdinPayload: string): Promise<{ stdout: string; stderr: string }> {
	const origStdin = process.stdin;
	const stream = Readable.from([stdinPayload]);
	Object.defineProperty(process, "stdin", { value: stream, configurable: true });
	try {
		return await runCommand(args);
	} finally {
		Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
	}
}

describe("pr-description command", () => {
	beforeEach(() => {
		mockBuild.mockReset();
		process.exitCode = 0;
	});

	afterEach(() => {
		process.exitCode = 0;
	});

	it("--format json prints the full PrDescriptionResult verbatim", async () => {
		mockBuild.mockResolvedValue(sampleResult());
		const { stdout } = await runCommand(["--format", "json", "--cwd", "/tmp/x"]);
		const parsed = JSON.parse(stdout.trim());
		expect(parsed).toMatchObject({ type: "pr_description", title: "feat: add x", body: "## Summary\nbody text" });
		// no explicit base → buildPrDescription is asked to resolve the default itself
		expect(mockBuild).toHaveBeenCalledWith("/tmp/x", { baseBranch: undefined, includeMarkers: true });
	});

	it("--base passes the base branch through to buildPrDescription", async () => {
		mockBuild.mockResolvedValue(sampleResult({ baseBranch: "develop" }));
		await runCommand(["--base", "develop", "--format", "json", "--cwd", "/tmp/x"]);
		expect(mockBuild).toHaveBeenCalledWith("/tmp/x", { baseBranch: "develop", includeMarkers: true });
	});

	it("--no-markers disables the idempotent update markers", async () => {
		mockBuild.mockResolvedValue(sampleResult());
		await runCommand(["--no-markers", "--format", "json", "--cwd", "/tmp/x"]);
		expect(mockBuild).toHaveBeenCalledWith("/tmp/x", { baseBranch: undefined, includeMarkers: false });
	});

	it("default (no --format) prints a human summary, not the raw body", async () => {
		mockBuild.mockResolvedValue(sampleResult({ missingCount: 2, commitCount: 5 }));
		const { stdout } = await runCommand(["--cwd", "/tmp/x"]);
		expect(stdout).toContain("feat: add x");
		expect(stdout).toContain("Base:    main");
		expect(stdout).toContain("5 (3 with memory, 2 without)");
		expect(stdout).not.toContain("body text");
	});

	it("human summary omits the 'without' clause when no commits are missing memory", async () => {
		mockBuild.mockResolvedValue(sampleResult({ missingCount: 0, commitCount: 3 }));
		const { stdout } = await runCommand(["--cwd", "/tmp/x"]);
		expect(stdout).toContain("3 (3 with memory)");
		expect(stdout).not.toContain("without");
	});

	it("--arg-stdin reads the base branch from stdin verbatim", async () => {
		mockBuild.mockResolvedValue(sampleResult({ baseBranch: "release/1.x" }));
		await runWithStdin(["--arg-stdin", "--format", "json", "--cwd", "/tmp/x"], "release/1.x\n");
		expect(mockBuild).toHaveBeenCalledWith("/tmp/x", { baseBranch: "release/1.x", includeMarkers: true });
	});

	it("--arg-stdin with empty stdin behaves like no base (default branch resolution)", async () => {
		mockBuild.mockResolvedValue(sampleResult());
		await runWithStdin(["--arg-stdin", "--format", "json", "--cwd", "/tmp/x"], "");
		expect(mockBuild).toHaveBeenCalledWith("/tmp/x", { baseBranch: undefined, includeMarkers: true });
	});

	it("rejects --arg-stdin combined with --base (mutually exclusive)", async () => {
		const { stdout } = await runCommand(["--arg-stdin", "--base", "main", "--format", "json", "--cwd", "/tmp/x"]);
		expect(JSON.parse(stdout.trim())).toMatchObject({ type: "error" });
		expect(stdout).toContain("mutually exclusive");
		expect(mockBuild).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it("rejects a base branch with shell metacharacters (injection probe)", async () => {
		const { stdout } = await runWithStdin(["--arg-stdin", "--format", "json", "--cwd", "/tmp/x"], "$(date)\n");
		expect(stdout).toContain("Invalid characters");
		expect(mockBuild).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it("surfaces the 'no summaries' error as JSON with exit 1", async () => {
		mockBuild.mockRejectedValue(new Error('No JolliMemory summaries found on branch "feature/x" (base "main").'));
		const { stdout } = await runCommand(["--format", "json", "--cwd", "/tmp/x"]);
		expect(JSON.parse(stdout.trim())).toMatchObject({
			type: "error",
			message: expect.stringContaining("No JolliMemory summaries"),
		});
		expect(process.exitCode).toBe(1);
	});

	it("surfaces errors as text on stderr when no --format is given", async () => {
		mockBuild.mockRejectedValue(new Error("boom"));
		const { stderr } = await runCommand(["--cwd", "/tmp/x"]);
		expect(stderr).toContain("Error: boom");
		expect(process.exitCode).toBe(1);
	});

	it("mutual-exclusion error renders to stderr in text mode", async () => {
		const { stderr } = await runCommand(["--arg-stdin", "--base", "main", "--cwd", "/tmp/x"]);
		expect(stderr).toContain("mutually exclusive");
		expect(process.exitCode).toBe(1);
	});

	it("invalid-characters error renders to stderr in text mode", async () => {
		const { stderr } = await runWithStdin(["--arg-stdin", "--cwd", "/tmp/x"], "bad;branch\n");
		expect(stderr).toContain("Invalid characters");
		expect(process.exitCode).toBe(1);
	});

	it("stringifies non-Error throwables", async () => {
		mockBuild.mockRejectedValue("plain string failure");
		const { stdout } = await runCommand(["--format", "json", "--cwd", "/tmp/x"]);
		expect(JSON.parse(stdout.trim())).toMatchObject({ type: "error", message: "plain string failure" });
		expect(process.exitCode).toBe(1);
	});
});

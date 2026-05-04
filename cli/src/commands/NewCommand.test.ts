/**
 * Tests for NewCommand — registers the `jolli new [folder-name]` command.
 *
 * Covers:
 *   - Successful scaffold: prints created path and next-steps message
 *   - Directory already exists: prints error and sets exitCode = 1
 *   - Filesystem error: prints OS error message and sets exitCode = 1
 *   - Missing argument: prompts interactively for folder name
 *   - Empty prompt input: prints error and sets exitCode = 1
 */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoist mocks ─────────────────────────────────────────────────────────────

const { mockScaffoldProject, mockCreateInterface } = vi.hoisted(() => ({
	mockScaffoldProject: vi.fn(),
	mockCreateInterface: vi.fn(),
}));

vi.mock("../site/StarterKit.js", () => ({
	scaffoldProject: mockScaffoldProject,
}));

vi.mock("node:readline", () => ({
	createInterface: mockCreateInterface,
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Creates a fresh Commander program with the new command registered. */
async function makeProgram(): Promise<Command> {
	const { registerNewCommand } = await import("./NewCommand.js");
	const program = new Command();
	program.exitOverride();
	registerNewCommand(program);
	return program;
}

/** Sets up mockCreateInterface to return a given answer. */
function mockPrompt(answer: string): void {
	mockCreateInterface.mockReturnValue({
		question: (_prompt: string, cb: (answer: string) => void) => cb(answer),
		close: vi.fn(),
	});
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("NewCommand", () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let originalExitCode: number | undefined;
	const originalIsTTY = process.stdin.isTTY;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		originalExitCode = process.exitCode as number | undefined;
		process.exitCode = 0;
		process.stdin.isTTY = true;
	});

	afterEach(() => {
		process.exitCode = originalExitCode;
		process.stdin.isTTY = originalIsTTY;
		consoleSpy.mockRestore();
		consoleErrorSpy.mockRestore();
	});

	// ── Success path ─────────────────────────────────────────────────────────

	it("prints the created directory path on success", async () => {
		const targetDir = "/some/path/my-docs";
		mockScaffoldProject.mockResolvedValue({
			success: true,
			targetDir,
			message: `Created ${targetDir}`,
		});

		const program = await makeProgram();
		await program.parseAsync(["new", "my-docs"], { from: "user" });

		const output = consoleSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(output).toContain(targetDir);
	});

	it("prints a next-steps message on success", async () => {
		const targetDir = "/some/path/my-docs";
		mockScaffoldProject.mockResolvedValue({
			success: true,
			targetDir,
			message: `Created ${targetDir}`,
		});

		const program = await makeProgram();
		await program.parseAsync(["new", "my-docs"], { from: "user" });

		const output = consoleSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(output).toContain("jolli dev");
	});

	it("does not set exitCode on success", async () => {
		mockScaffoldProject.mockResolvedValue({
			success: true,
			targetDir: "/some/path/my-docs",
			message: "Created /some/path/my-docs",
		});

		const program = await makeProgram();
		await program.parseAsync(["new", "my-docs"], { from: "user" });

		expect(process.exitCode).toBe(0);
	});

	it("calls scaffoldProject with the resolved target directory", async () => {
		mockScaffoldProject.mockResolvedValue({
			success: true,
			targetDir: "/cwd/my-docs",
			message: "Created /cwd/my-docs",
		});

		const program = await makeProgram();
		await program.parseAsync(["new", "my-docs"], { from: "user" });

		expect(mockScaffoldProject).toHaveBeenCalledOnce();
		const [calledWith] = mockScaffoldProject.mock.calls[0] as [string];
		expect(calledWith).toMatch(/my-docs$/);
	});

	// ── Directory already exists ──────────────────────────────────────────────

	it("prints an error message when the directory already exists", async () => {
		const targetDir = "/some/path/existing-dir";
		mockScaffoldProject.mockResolvedValue({
			success: false,
			targetDir,
			message: `Directory already exists: ${targetDir}`,
		});

		const program = await makeProgram();
		await program.parseAsync(["new", "existing-dir"], { from: "user" });

		const errorOutput = consoleErrorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(errorOutput).toContain("Directory already exists");
	});

	it("sets exitCode to 1 when the directory already exists", async () => {
		mockScaffoldProject.mockResolvedValue({
			success: false,
			targetDir: "/some/path/existing-dir",
			message: "Directory already exists: /some/path/existing-dir",
		});

		const program = await makeProgram();
		await program.parseAsync(["new", "existing-dir"], { from: "user" });

		expect(process.exitCode).toBe(1);
	});

	// ── Filesystem error ──────────────────────────────────────────────────────

	it("prints the OS error message on filesystem failure", async () => {
		mockScaffoldProject.mockResolvedValue({
			success: false,
			targetDir: "/no-permission/my-docs",
			message: "EACCES: permission denied, mkdir '/no-permission/my-docs'",
		});

		const program = await makeProgram();
		await program.parseAsync(["new", "my-docs"], { from: "user" });

		const errorOutput = consoleErrorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(errorOutput).toContain("EACCES");
	});

	it("sets exitCode to 1 on filesystem failure", async () => {
		mockScaffoldProject.mockResolvedValue({
			success: false,
			targetDir: "/no-permission/my-docs",
			message: "EACCES: permission denied, mkdir '/no-permission/my-docs'",
		});

		const program = await makeProgram();
		await program.parseAsync(["new", "my-docs"], { from: "user" });

		expect(process.exitCode).toBe(1);
	});

	// ── Interactive prompt when no argument ───────────────────────────────────

	it("prompts for folder name when argument is missing", async () => {
		mockPrompt("prompted-docs");
		mockScaffoldProject.mockResolvedValue({
			success: true,
			targetDir: "/cwd/prompted-docs",
			message: "Created",
		});

		const program = await makeProgram();
		await program.parseAsync(["new"], { from: "user" });

		expect(mockCreateInterface).toHaveBeenCalledOnce();
		const [calledWith] = mockScaffoldProject.mock.calls[0] as [string];
		expect(calledWith).toMatch(/prompted-docs$/);
	});

	it("sets exitCode = 1 when prompt input is empty", async () => {
		mockPrompt("");

		const program = await makeProgram();
		await program.parseAsync(["new"], { from: "user" });

		expect(process.exitCode).toBe(1);
		expect(mockScaffoldProject).not.toHaveBeenCalled();
	});

	it("sets exitCode = 1 when prompt input is only whitespace", async () => {
		mockPrompt("   ");

		const program = await makeProgram();
		await program.parseAsync(["new"], { from: "user" });

		expect(process.exitCode).toBe(1);
		expect(mockScaffoldProject).not.toHaveBeenCalled();
	});

	it("returns empty string without prompting when stdin is not a TTY", async () => {
		process.stdin.isTTY = undefined as unknown as true;

		const program = await makeProgram();
		await program.parseAsync(["new"], { from: "user" });

		expect(process.exitCode).toBe(1);
	});

	it("trims whitespace from prompted folder name", async () => {
		mockPrompt("  my-docs  ");
		mockScaffoldProject.mockResolvedValue({
			success: true,
			targetDir: "/cwd/my-docs",
			message: "Created",
		});

		const program = await makeProgram();
		await program.parseAsync(["new"], { from: "user" });

		const [calledWith] = mockScaffoldProject.mock.calls[0] as [string];
		expect(calledWith).toMatch(/my-docs$/);
	});
});

/**
 * Tests for WorkflowCommandStubs — the fallback `workflow` commander registered
 * when the `@jolli.ai/workflow-cli` plugin is not installed.
 *
 * Covers:
 *   - registration adds a single `workflow` command to a bare program
 *   - the stub is tagged with the "workflow" help group
 *   - the description carries the `(requires @jolli.ai/workflow-cli)` suffix
 *   - `workflow local-run` emits the `workflow_cli_required` JSON on stdout and
 *     does NOT exit non-zero (the local-run recipe parses this JSON)
 *   - `workflow runs` / `workflow run-status` print the prose install hint on
 *     stderr and exit non-zero
 *   - unknown flags/subcommands forward to the action (no parser error) via
 *     allowUnknownOption + [args...]
 *   - the collision-tolerant guard: a pre-existing `workflow` command (by name
 *     or by alias) is left untouched
 */

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getHelpGroup } from "./HelpGroups.js";
import { registerWorkflowCommandStubs } from "./WorkflowCommandStubs.js";

const INSTALL_COMMAND = "npm i -g @jolli.ai/cli @jolli.ai/workflow-cli";

interface StubRun {
	/** Joined console.log (stdout) output captured during the invocation. */
	stdout: string;
	/** Joined console.error (stderr) output captured during the invocation. */
	stderr: string;
	/** The exit code the stub passed to process.exit, or undefined if it never exited. */
	exitCode: number | undefined;
}

/**
 * Invokes the `workflow` stub via Commander. `process.exit` is stubbed to throw
 * so execution halts at the stub's exit call; the thrown sentinel is swallowed
 * here. Returns the captured stdout/stderr and the requested exit code.
 */
async function runStub(program: Command, extraArgs: string[]): Promise<StubRun> {
	const outLines: string[] = [];
	const errLines: string[] = [];
	let exitCode: number | undefined;
	const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		outLines.push(a.map(String).join(" "));
	});
	const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		errLines.push(a.map(String).join(" "));
	});
	const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		exitCode = code;
		throw new Error("__exit__");
	}) as never);
	try {
		await program.parseAsync(["workflow", ...extraArgs], { from: "user" });
	} catch (err) {
		// Re-throw anything that isn't our exit sentinel (e.g. a parser error,
		// which would indicate the stub failed to swallow unknown options).
		if (!(err instanceof Error) || err.message !== "__exit__") throw err;
	} finally {
		logSpy.mockRestore();
		errSpy.mockRestore();
		exitSpy.mockRestore();
	}
	return { stdout: outLines.join("\n"), stderr: errLines.join("\n"), exitCode };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("registerWorkflowCommandStubs", () => {
	it("registers a single `workflow` command on a bare program", () => {
		const program = new Command();
		registerWorkflowCommandStubs(program);
		expect(program.commands.map((c) => c.name())).toEqual(["workflow"]);
	});

	it("tags the `workflow` stub with the 'workflow' help group", () => {
		const program = new Command();
		registerWorkflowCommandStubs(program);
		expect(getHelpGroup(program.commands[0])).toBe("workflow");
	});

	it("appends the (requires @jolli.ai/workflow-cli) suffix to the description", () => {
		const program = new Command();
		registerWorkflowCommandStubs(program);
		expect(program.commands[0].description()).toMatch(/\(requires @jolli\.ai\/workflow-cli\)$/);
	});

	it("emits the workflow_cli_required JSON on stdout for `local-run` without exiting non-zero", async () => {
		const program = new Command();
		registerWorkflowCommandStubs(program);

		const { stdout, stderr, exitCode } = await runStub(program, ["local-run"]);
		expect(exitCode).toBeUndefined();
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({ type: "workflow_cli_required", installHint: INSTALL_COMMAND });
	});

	it("prints the prose install hint and exits non-zero for `runs`", async () => {
		const program = new Command();
		registerWorkflowCommandStubs(program);

		const { stderr, exitCode } = await runStub(program, ["runs", "7"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("`jolli workflow runs` requires the @jolli.ai/workflow-cli plugin.");
		expect(stderr).toContain(INSTALL_COMMAND);
		expect(stderr).toContain("Then re-run: jolli workflow runs ...");
	});

	it("prints the prose install hint and exits non-zero for `run-status`", async () => {
		const program = new Command();
		registerWorkflowCommandStubs(program);

		const { stderr, exitCode } = await runStub(program, ["run-status", "run_abc"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("`jolli workflow run-status` requires the @jolli.ai/workflow-cli plugin.");
	});

	it("prints the prose install hint and exits non-zero when invoked with no subcommand", async () => {
		const program = new Command();
		registerWorkflowCommandStubs(program);

		const { stderr, exitCode } = await runStub(program, []);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("`jolli workflow` requires the @jolli.ai/workflow-cli plugin.");
	});

	it("forwards `runs --foo` to the action without a parser error", async () => {
		const program = new Command();
		registerWorkflowCommandStubs(program);

		// The subcommand token + the unknown --foo flag must reach the action
		// (install-hint exit), NOT raise Commander's "unknown option" error.
		const { exitCode } = await runStub(program, ["runs", "--foo"]);
		expect(exitCode).toBe(1);
	});

	it("leaves a pre-existing `workflow` command untouched (name collision)", () => {
		const program = new Command();
		program.command("workflow").description("pre-existing workflow command");
		registerWorkflowCommandStubs(program);

		const workflowCommands = program.commands.filter((c) => c.name() === "workflow");
		expect(workflowCommands).toHaveLength(1);
		expect(workflowCommands[0].description()).toBe("pre-existing workflow command");
		expect(getHelpGroup(workflowCommands[0])).toBeUndefined();
	});

	it("skips the stub when `workflow` collides with an existing command's alias", () => {
		const program = new Command();
		program.command("wf").alias("workflow").description("pre-existing wf command");
		registerWorkflowCommandStubs(program);

		// No second command literally named "workflow" should be added.
		expect(program.commands.filter((c) => c.name() === "workflow")).toHaveLength(0);
		expect(program.commands.map((c) => c.name())).toEqual(["wf"]);
	});
});

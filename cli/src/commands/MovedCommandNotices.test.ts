import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMovedCommandNotices } from "./MovedCommandNotices.js";

function buildProgram(): Command {
	const program = new Command();
	program.name("jolli").exitOverride();
	registerMovedCommandNotices(program);
	return program;
}

const originalExitCode = process.exitCode;

afterEach(() => {
	process.exitCode = originalExitCode;
	vi.restoreAllMocks();
});

describe("registerMovedCommandNotices", () => {
	it("registers a hidden notice for each removed flat workflow-run command", () => {
		const program = buildProgram();
		const names = program.commands.map((c) => c.name());
		expect(names).toContain("local-run-workflows");
		expect(names).toContain("workflow-run-status");
		expect(names).toContain("workflow-runs");
		// All are hidden from --help.
		for (const c of program.commands) {
			const internal = c as unknown as { _hidden?: boolean; hidden?: boolean };
			expect(internal._hidden ?? internal.hidden).toBe(true);
		}
	});

	it.each([
		["local-run-workflows", "workflow local-run"],
		["workflow-run-status", "workflow run-status"],
		["workflow-runs", "workflow runs"],
	])("prints a 'moved to %s' notice and exits non-zero", async (from, to) => {
		const errors: string[] = [];
		vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
			errors.push(String(msg ?? ""));
		});
		process.exitCode = 0;
		const program = buildProgram();
		await program.parseAsync(["node", "jolli", from]);
		const joined = errors.join("\n");
		expect(joined).toContain(`\`jolli ${from}\` has moved to \`jolli ${to}\``);
		expect(joined).toContain("refreshed");
		expect(joined).toContain("npm i -g @jolli.ai/cli @jolli.ai/workflow-cli");
		expect(process.exitCode).toBe(1);
	});

	it("ignores forwarded subcommand args without erroring on unknown options", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		process.exitCode = 0;
		const program = buildProgram();
		await expect(
			program.parseAsync(["node", "jolli", "workflow-run-status", "run_123", "--verbose"]),
		).resolves.toBeDefined();
		expect(process.exitCode).toBe(1);
	});

	it("does not shadow a name already registered (real command wins)", () => {
		const program = new Command();
		program.name("jolli");
		program.command("local-run-workflows").action(() => {});
		registerMovedCommandNotices(program);
		// Only the pre-existing command remains under that name — no duplicate.
		const matches = program.commands.filter((c) => c.name() === "local-run-workflows");
		expect(matches).toHaveLength(1);
	});
});

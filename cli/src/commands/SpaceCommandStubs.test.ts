/**
 * Tests for SpaceCommandStubs — fallback stub commanders registered when the
 * `@jolli.ai/space-cli` plugin is not installed.
 *
 * Covers:
 *   - registration adds all Space stub commands (including `docs`) to a bare program
 *   - each stub is tagged with the "space" help group
 *   - invoking a stub (`docs`) prints the install hint and exits non-zero
 *   - `jolli docs pull --branch x` / `jolli docs publish --foo` forward the
 *     subcommand + unknown flags to the action (no parser error) via
 *     allowUnknownOption + [args...]
 *   - the collision-tolerant guard: a stub whose name is already occupied
 *     (by command name or by alias) is skipped rather than throwing
 */

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getHelpGroup } from "./HelpGroups.js";
import { registerSpaceCommandStubs } from "./SpaceCommandStubs.js";

// ─── Constants mirrored from the source under test ───────────────────────────

/** The Space command names the stubs register, in declaration order. */
const SPACE_NAMES = ["init", "space", "source", "impact", "sync", "docs", "agent"];

const INSTALL_COMMAND = "npm install -g @jolli.ai/space-cli";

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface StubRun {
	/** Joined console.error output captured during the invocation. */
	output: string;
	/** The exit code the stub passed to process.exit, or undefined if it never exited. */
	exitCode: number | undefined;
}

/**
 * Invokes the named stub via Commander. `process.exit` is stubbed to throw so
 * execution halts at the stub's exit call; the thrown sentinel is swallowed
 * here. Returns the captured console.error output and the requested exit code.
 */
async function runStub(program: Command, name: string, extraArgs: string[] = []): Promise<StubRun> {
	const errLines: string[] = [];
	let exitCode: number | undefined;
	const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		errLines.push(a.map(String).join(" "));
	});
	const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		exitCode = code;
		throw new Error("__exit__");
	}) as never);
	try {
		await program.parseAsync([name, ...extraArgs], { from: "user" });
	} catch (err) {
		// Re-throw anything that isn't our exit sentinel (e.g. a parser error,
		// which would indicate the stub failed to swallow unknown options).
		if (!(err instanceof Error) || err.message !== "__exit__") throw err;
	} finally {
		errSpy.mockRestore();
		exitSpy.mockRestore();
	}
	return { output: errLines.join("\n"), exitCode };
}

afterEach(() => {
	vi.restoreAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("registerSpaceCommandStubs", () => {
	it("registers all Space stub commands (including docs) on a bare program", () => {
		const program = new Command();
		registerSpaceCommandStubs(program);
		expect(program.commands.map((c) => c.name())).toEqual(SPACE_NAMES);
	});

	it("tags every registered stub with the 'space' help group", () => {
		const program = new Command();
		registerSpaceCommandStubs(program);
		for (const cmd of program.commands) {
			expect(getHelpGroup(cmd)).toBe("space");
		}
	});

	it("appends the (requires @jolli.ai/space-cli) suffix to each description", () => {
		const program = new Command();
		registerSpaceCommandStubs(program);
		for (const cmd of program.commands) {
			expect(cmd.description()).toMatch(/\(requires @jolli\.ai\/space-cli\)$/);
		}
	});

	it("prints the install hint and exits non-zero when the docs stub is invoked", async () => {
		const program = new Command();
		registerSpaceCommandStubs(program);

		const { output, exitCode } = await runStub(program, "docs");
		expect(exitCode).toBe(1);
		expect(output).toContain("Space command `docs` requires the @jolli.ai/space-cli plugin.");
		expect(output).toContain(INSTALL_COMMAND);
		expect(output).toContain("Then re-run: jolli docs ...");
	});

	it("forwards `docs pull --branch x` to the action without a parser error", async () => {
		const program = new Command();
		registerSpaceCommandStubs(program);

		// The subcommand token + the unknown --branch flag must reach the action
		// (install-hint exit), NOT raise Commander's "unknown option" error.
		const { exitCode } = await runStub(program, "docs", ["pull", "--branch", "jolli/run-123"]);
		expect(exitCode).toBe(1);
	});

	it("forwards `docs publish --foo` to the action without a parser error", async () => {
		const program = new Command();
		registerSpaceCommandStubs(program);

		const { exitCode } = await runStub(program, "docs", ["publish", "--foo"]);
		expect(exitCode).toBe(1);
	});

	it("skips a stub whose name is already occupied by an existing command", () => {
		const program = new Command();
		// Pre-register a command named "docs" that the stub must not clobber.
		program.command("docs").description("pre-existing docs command");
		registerSpaceCommandStubs(program);

		const docsCommands = program.commands.filter((c) => c.name() === "docs");
		expect(docsCommands).toHaveLength(1);
		expect(docsCommands[0].description()).toBe("pre-existing docs command");
		expect(getHelpGroup(docsCommands[0])).toBeUndefined();
		// The pre-existing `docs` plus the other six stubs (docs skipped).
		expect(program.commands.map((c) => c.name())).toEqual(["docs", ...SPACE_NAMES.filter((n) => n !== "docs")]);
	});

	it("skips a stub whose name collides with an existing command's alias", () => {
		const program = new Command();
		// An existing command aliased "docs" must block the docs stub.
		program.command("documents").alias("docs").description("pre-existing documents command");
		registerSpaceCommandStubs(program);

		// No second command literally named "docs" should be added.
		expect(program.commands.filter((c) => c.name() === "docs")).toHaveLength(0);
		const stubNames = program.commands.map((c) => c.name()).filter((n) => SPACE_NAMES.includes(n));
		expect(stubNames).toEqual(SPACE_NAMES.filter((n) => n !== "docs"));
	});
});

/**
 * Tests for SpaceCommandStubs — fallback stub commanders registered when the
 * `@jolli.ai/space-cli` plugin is not installed.
 *
 * Covers:
 *   - registration adds the single top-level `space` stub to a bare program
 *   - the stub is tagged with the "space" help group
 *   - invoking the stub (`space`) prints the install hint and exits non-zero
 *   - `jolli space sync up` / `jolli space status --foo` forward the
 *     subcommand + unknown flags to the action (no parser error) via
 *     allowUnknownOption + [args...]
 *   - the collision-tolerant guard: the `space` stub is skipped (not thrown)
 *     when its name is already occupied by a command name or by an alias
 */

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getHelpGroup } from "./HelpGroups.js";
import { registerSpaceCommandStubs } from "./SpaceCommandStubs.js";

// ─── Constants mirrored from the source under test ───────────────────────────

/** The Space command names the stubs register, in declaration order. */
const SPACE_NAMES = ["space"];

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
	it("registers the single top-level `space` stub on a bare program", () => {
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

	it("prints the install hint and exits non-zero when the space stub is invoked", async () => {
		const program = new Command();
		registerSpaceCommandStubs(program);

		const { output, exitCode } = await runStub(program, "space");
		expect(exitCode).toBe(1);
		expect(output).toContain("Space command `space` requires the @jolli.ai/space-cli plugin.");
		expect(output).toContain(INSTALL_COMMAND);
		expect(output).toContain("Then re-run: jolli space ...");
	});

	it("forwards `space sync up` to the action without a parser error", async () => {
		const program = new Command();
		registerSpaceCommandStubs(program);

		// The subcommand tokens must reach the action (install-hint exit), NOT
		// raise Commander's "unknown command" error.
		const { exitCode } = await runStub(program, "space", ["sync", "up"]);
		expect(exitCode).toBe(1);
	});

	it("forwards `space status --foo` to the action without a parser error", async () => {
		const program = new Command();
		registerSpaceCommandStubs(program);

		// The subcommand token + the unknown --foo flag must reach the action
		// (install-hint exit), NOT raise Commander's "unknown option" error.
		const { exitCode } = await runStub(program, "space", ["status", "--foo"]);
		expect(exitCode).toBe(1);
	});

	it("skips the stub whose name is already occupied by an existing command", () => {
		const program = new Command();
		// Pre-register a command named "space" that the stub must not clobber.
		program.command("space").description("pre-existing space command");
		registerSpaceCommandStubs(program);

		const spaceCommands = program.commands.filter((c) => c.name() === "space");
		expect(spaceCommands).toHaveLength(1);
		expect(spaceCommands[0].description()).toBe("pre-existing space command");
		expect(getHelpGroup(spaceCommands[0])).toBeUndefined();
		// Only the pre-existing `space` remains; the stub is skipped, not duplicated.
		expect(program.commands.map((c) => c.name())).toEqual(["space"]);
	});

	it("skips the stub whose name collides with an existing command's alias", () => {
		const program = new Command();
		// An existing command aliased "space" must block the space stub.
		program.command("spaces").alias("space").description("pre-existing spaces command");
		registerSpaceCommandStubs(program);

		// No second command literally named "space" should be added.
		expect(program.commands.filter((c) => c.name() === "space")).toHaveLength(0);
		const stubNames = program.commands.map((c) => c.name()).filter((n) => SPACE_NAMES.includes(n));
		expect(stubNames).toEqual([]);
	});
});

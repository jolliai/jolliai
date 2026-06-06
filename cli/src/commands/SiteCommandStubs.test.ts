/**
 * Tests for SiteCommandStubs — fallback stub commanders registered when the
 * `@jolli.ai/site-cli` plugin is not installed.
 *
 * Covers:
 *   - registration adds all seven Site stub commands to a bare program
 *   - each stub is tagged with the "site" help group
 *   - invoking a stub prints the install hint and exits non-zero
 *   - the collision-tolerant guard: a stub whose name is already occupied
 *     (by command name or by alias) is skipped rather than throwing
 */

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getHelpGroup } from "./HelpGroups.js";
import { registerSiteCommandStubs } from "./SiteCommandStubs.js";

// ─── Constants mirrored from the source under test ───────────────────────────

/** The seven site command names the stubs register, in declaration order. */
const SITE_NAMES = ["new", "convert", "dev", "build", "start", "reverse", "theme"];

const INSTALL_COMMAND = "npm install -g @jolli.ai/site-cli";

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface StubRun {
	/** Joined console.error output captured during the invocation. */
	output: string;
	/** The exit code the stub passed to process.exit, or undefined if it never exited. */
	exitCode: number | undefined;
}

/**
 * Invokes the named stub via Commander. `process.exit` is stubbed to throw so
 * execution halts at the stub's exit call (mirroring how a real exit unwinds);
 * the thrown sentinel is swallowed here. Returns the captured console.error
 * output and the exit code the stub requested.
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

describe("registerSiteCommandStubs", () => {
	it("registers all seven site stub commands on a bare program", () => {
		const program = new Command();
		registerSiteCommandStubs(program);
		const registered = program.commands.map((c) => c.name());
		expect(registered).toEqual(SITE_NAMES);
	});

	it("tags every registered stub with the 'site' help group", () => {
		const program = new Command();
		registerSiteCommandStubs(program);
		for (const cmd of program.commands) {
			expect(getHelpGroup(cmd)).toBe("site");
		}
	});

	it("appends the (requires @jolli.ai/site-cli) suffix to each description", () => {
		const program = new Command();
		registerSiteCommandStubs(program);
		for (const cmd of program.commands) {
			expect(cmd.description()).toMatch(/\(requires @jolli\.ai\/site-cli\)$/);
		}
	});

	it("prints the install hint and exits non-zero when a stub is invoked", async () => {
		const program = new Command();
		registerSiteCommandStubs(program);

		const { output, exitCode } = await runStub(program, "build");
		expect(exitCode).toBe(1);
		expect(output).toContain("Site command `build` requires the @jolli.ai/site-cli plugin.");
		expect(output).toContain(INSTALL_COMMAND);
		expect(output).toContain("Then re-run: jolli build ...");
	});

	it("forwards unknown options without a parser error (allowUnknownOption)", async () => {
		const program = new Command();
		registerSiteCommandStubs(program);

		// A flag the stub doesn't define must NOT raise "unknown option";
		// it must reach the action and trigger the install-hint exit.
		const { exitCode } = await runStub(program, "new", ["my-site", "--some-flag"]);
		expect(exitCode).toBe(1);
	});

	it("skips a stub whose name is already occupied by an existing command", () => {
		const program = new Command();
		// Pre-register a command named "new" that the stub must not clobber.
		program.command("new").description("pre-existing new command");
		registerSiteCommandStubs(program);

		const newCommands = program.commands.filter((c) => c.name() === "new");
		expect(newCommands).toHaveLength(1);
		expect(newCommands[0].description()).toBe("pre-existing new command");
		// The pre-existing command is not tagged with the site group.
		expect(getHelpGroup(newCommands[0])).toBeUndefined();
		// The other six stubs still register.
		expect(program.commands.map((c) => c.name())).toEqual(SITE_NAMES);
	});

	it("skips a stub whose name collides with an existing command's alias", () => {
		const program = new Command();
		// An existing command aliased "build" must block the build stub.
		program.command("compile").alias("build").description("pre-existing compile command");
		registerSiteCommandStubs(program);

		// No second command literally named "build" should be added.
		const buildNamed = program.commands.filter((c) => c.name() === "build");
		expect(buildNamed).toHaveLength(0);
		// The remaining six stubs register (everything except "build").
		const stubNames = program.commands.map((c) => c.name()).filter((n) => SITE_NAMES.includes(n));
		expect(stubNames).toEqual(SITE_NAMES.filter((n) => n !== "build"));
	});
});

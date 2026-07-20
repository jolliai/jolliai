import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { setHelpGroup } from "../../commands/HelpGroups.js";
import { buildCommandCatalog, type CommandCatalogEntry, orderCatalogForContext } from "./CommandCatalog.js";

function fakeProgram(): Command {
	const program = new Command();
	program.command("doctor").description("Diagnose the install");
	program.command("graph").description("Export the knowledge graph");
	// Mirrors the real CLI: search's positional is OPTIONAL in Commander, so
	// only the TUI_REQUIRES_ARGS override can mark it needs-args.
	program.command("search [words...]").description("Search memories");
	program.command("convert <file>").description("Convert a file");
	// Mirrors the real `bind`: no positional, but a mandatory option — a bare run
	// errors on the missing `--space`, so it must count as needs-args.
	program
		.command("bind")
		.description("Bind this repo to a Jolli Space")
		.requiredOption("--space <idOrSlug>", "Space");
	const build = program.command("build").description("Build the static site");
	setHelpGroup(build, "site");
	const spaces = program.command("spaces").description("List Jolli Spaces");
	setHelpGroup(spaces, "space");
	program.command("secret", { hidden: true }).description("internal");
	program.command("mcp").description("Start the MCP server (stdio)");
	program.command("enable").description("Enable Jolli in this repo");
	program.command("disable").description("Disable Jolli in this repo");
	// Destructive: refuse to run non-interactively without --yes → confirm-gated.
	program.command("clean").description("Remove local Jolli state").option("-y, --yes", "Skip confirmation");
	program.command("uninstall").description("Remove Jolli entirely").option("-y, --yes", "Skip confirmation");
	// Subcommand-bearing command → signature should list the subcommands.
	const auth = program.command("auth").description("Sign in to Jolli");
	auth.command("login").description("Sign in");
	auth.command("logout").description("Sign out");
	auth.command("status").description("Show auth status");
	// Optional positional + options (and the ubiquitous --cwd, which must be
	// filtered out of the options hint).
	program
		.command("recall [branch]")
		.description("Recall branch context")
		.option("--format <fmt>", "Output format")
		.option("--cwd <dir>", "Project dir");
	return program;
}

describe("buildCommandCatalog", () => {
	const catalog = buildCommandCatalog(fakeProgram());
	const byName = (name: string) => catalog.find((e) => e.name === name);

	it("includes visible commands with name + description", () => {
		expect(byName("doctor")?.description).toBe("Diagnose the install");
	});

	it("marks commands with a required argument as needsArgs", () => {
		expect(byName("convert")?.needsArgs).toBe(true);
		expect(byName("doctor")?.needsArgs).toBe(false);
	});

	it("marks commands with a mandatory option (requiredOption) as needsArgs", () => {
		// `bind --space` has no positional but errors bare — the palette must gate it.
		expect(byName("bind")?.needsArgs).toBe(true);
	});

	it("derives a usage hint from required positionals and mandatory options", () => {
		expect(byName("convert")?.usage).toBe("<file>"); // required positional
		expect(byName("bind")?.usage).toBe("--space <idOrSlug>"); // mandatory option flags
		expect(byName("doctor")?.usage).toBeUndefined(); // bare run is valid → no hint
	});

	it("uses a hand-authored usage hint for the forced (optional-positional) search", () => {
		expect(byName("search")?.usage).toBe("<words...>");
	});

	it("builds a full signature: subcommands, optional positionals, and an [options] marker", () => {
		// Subcommand-bearing command lists its subs.
		expect(byName("auth")?.signature).toBe("<login|logout|status>");
		expect(byName("auth")?.subcommands).toEqual(["login", "logout", "status"]);
		// Optional positional + optional flag → `[branch] [options]`.
		expect(byName("recall")?.signature).toBe("[branch] [options]");
		// --cwd is filtered out of the options hint; --format is kept.
		expect(byName("recall")?.optionFlags).toEqual(["--format <fmt>"]);
		// Mandatory option shows inline (not just `[options]`).
		expect(byName("bind")?.signature).toBe("--space <idOrSlug>");
		// Bare-runnable, no args/options → empty signature.
		expect(byName("doctor")?.signature).toBeUndefined();
	});

	it("groups by the help-group tag, defaulting to Core", () => {
		expect(byName("doctor")?.group).toBe("Core");
		expect(byName("build")?.group).toBe("Jolli Site");
		expect(byName("spaces")?.group).toBe("Jolli Space");
	});

	it("excludes hidden commands", () => {
		expect(byName("secret")).toBeUndefined();
	});

	it("excludes uninstall from the palette (dangerous + irrelevant to daily use)", () => {
		expect(byName("uninstall")).toBeUndefined();
	});

	it("gives clean a safe --dry-run default so a bare /clean runs (never blocked)", () => {
		// clean is NOT confirm-gated: its bare run defaults to a dry-run report, and
		// `/clean --yes` performs the real deletion.
		expect(byName("clean")?.requiresConfirm).toBeUndefined();
		expect(byName("clean")?.defaultArgs).toEqual(["--dry-run"]);
	});

	it("appends a synthetic `clear` entry so /clear is discoverable", () => {
		const clear = byName("clear");
		expect(clear).toBeDefined();
		expect(clear?.group).toBe("TUI");
		expect(clear?.needsArgs).toBe(false);
	});

	it("attaches TUI default args to graph (bare run exports to the personal dir and opens it)", () => {
		// `--export` with no dir → GraphExport defaults to ~/.jolli/jollimemory/graph/
		// (NOT the repo cwd, which would dirty the working tree).
		expect(byName("graph")?.defaultArgs).toEqual(["--export", "--open"]);
		expect(byName("doctor")?.defaultArgs).toBeUndefined();
	});

	it("bare `auth` defaults to `auth status` (read-only)", () => {
		expect(byName("auth")?.defaultArgs).toEqual(["status"]);
	});

	it("excludes the blocking mcp server from the palette", () => {
		expect(byName("mcp")).toBeUndefined();
	});

	it("excludes enable/disable (interactive + already native Home [a] actions)", () => {
		expect(byName("enable")).toBeUndefined();
		expect(byName("disable")).toBeUndefined();
		// auth stays (defaults to read-only status).
		expect(byName("auth")?.defaultArgs).toEqual(["status"]);
	});

	it("forces needs-args for search despite its optional positional", () => {
		// The real `search` declares `[words...]` (optional) but errors bare.
		expect(byName("search")?.needsArgs).toBe(true);
	});
});

describe("orderCatalogForContext", () => {
	const mk = (name: string): CommandCatalogEntry => ({
		name,
		description: name,
		group: "Core",
		needsArgs: false,
	});
	// A catalog mixing memory, settings, and neutral commands, deliberately out of
	// any priority order so the reorder is observable.
	const catalog = ["status", "recall", "configure", "graph", "doctor", "pr-description", "view"].map(mk);
	const names = (list: CommandCatalogEntry[]) => list.map((e) => e.name);

	it("floats memory commands to the top on the memories tab (curated order)", () => {
		expect(names(orderCatalogForContext(catalog, "memories"))).toEqual([
			"recall",
			"view",
			"graph",
			"pr-description",
			"status",
			"configure",
			"doctor",
		]);
	});

	it("floats settings commands to the top on the settings tab (curated order)", () => {
		expect(names(orderCatalogForContext(catalog, "settings"))).toEqual([
			"configure",
			"doctor",
			"status",
			"recall",
			"graph",
			"pr-description",
			"view",
		]);
	});

	it("leaves the catalog untouched on the home tab", () => {
		expect(names(orderCatalogForContext(catalog, "home"))).toEqual(names(catalog));
	});

	it("keeps non-prioritized commands in their original relative order", () => {
		const only = ["view", "status", "recall"].map(mk);
		// memories prioritizes recall, view (in that order); status is neutral and
		// keeps its slot after the floated ones.
		expect(names(orderCatalogForContext(only, "memories"))).toEqual(["recall", "view", "status"]);
	});
});

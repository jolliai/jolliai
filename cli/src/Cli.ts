#!/usr/bin/env node
/// <reference types="node" />
/**
 * Jolli Memory CLI — Main entry point.
 *
 * Registers all subcommands and dispatches to their modules.
 *
 * Commands:
 *   enable        — Install AI agent + git hooks
 *   disable       — Remove all hooks
 *   status        — Show current installation status
 *   view          — View the latest commit summary (or N with --count)
 *   recall        — Recall development context for a branch (alias: context)
 *   export        — Export summaries as markdown to ~/Documents/jollimemory/
 *   auth          — Authentication commands (login, logout, status)
 *   new           — Scaffold a new documentation project (Content_Folder)
 *   convert       — Convert a documentation folder to Nextra-compatible structure
 *   dev           — Start a dev server with hot reload
 *   build         — Build a static site with search indexing
 *   start         — Build a static site with search indexing, then serve
 *
 * Internal commands (hidden from --help):
 *   migrate       — Migrate orphan branch + index to v3 format
 *   export-prompt — Print prompt templates to stdout
 */

import { Command, Help } from "commander";
import { registerAuthCommands } from "./commands/AuthCommand.js";
import { registerCleanCommand } from "./commands/CleanCommand.js";
import { checkVersionMismatch, VERSION } from "./commands/CliUtils.js";
import { registerConfigureCommand } from "./commands/ConfigureCommand.js";
import { registerConvertCommand } from "./commands/ConvertCommand.js";
import { registerDoctorCommand } from "./commands/DoctorCommand.js";
import { registerDisableCommand, registerEnableCommand } from "./commands/EnableCommand.js";
import { registerExportCommand, registerExportPromptCommand } from "./commands/ExportCommand.js";
import { registerMigrateCommand } from "./commands/MigrateCommand.js";
import { registerNewCommand } from "./commands/NewCommand.js";
import { registerRecallCommand } from "./commands/RecallCommand.js";
import { registerSearchCommand } from "./commands/SearchCommand.js";
import { registerBuildCommand, registerDevCommand, registerStartCommand } from "./commands/StartCommand.js";
import { registerStatusCommand } from "./commands/StatusCommand.js";
import { registerViewCommand } from "./commands/ViewCommand.js";
import { setSilentConsole } from "./Logger.js";

/**
 * Main CLI entry point.
 * Exported for testability — can be called with custom args.
 */
export async function main(args?: ReadonlyArray<string>): Promise<void> {
	// Suppress info/debug log output to stderr in CLI mode — users only need
	// to see command results (via console.log), not internal diagnostics.
	// warn/error still go to stderr; all levels still write to debug.log.
	setSilentConsole(true);

	const program = new Command();
	program
		.name("jolli")
		.description("Auto-document AI development sessions and generate documentation sites")
		.version(VERSION);

	// Hide internal commands (migrate, export-prompt) from --help output.
	// They remain fully functional when invoked directly.
	const HIDDEN_COMMANDS = new Set(["migrate", "export-prompt"]);

	// Group visible commands into two product surfaces in --help output.
	const MEMORY_COMMAND_NAMES = new Set([
		"enable",
		"disable",
		"status",
		"configure",
		"clean",
		"doctor",
		"view",
		"recall",
		"export",
		"auth",
	]);
	const SITE_COMMAND_NAMES = new Set(["new", "convert", "dev", "build", "start"]);

	const MEMORY_DESCRIPTION =
		"Auto-documents your AI-assisted development. Lightweight git and AI-agent\nhooks turn each commit into a structured summary (intent, decisions,\nprogress) stored on a git orphan branch, so you can recall context across\nbranches, machines, and teammates.";

	const SITE_DESCRIPTION =
		"Generates a docs site from a content folder of Markdown/MDX and OpenAPI\nspecs. Scaffold a new project, build a static site with full-text search,\nor run a hot-reload dev server while you write.";

	const formatGroupedHelp = (cmd: Command, helper: Help): string => {
		// Grouping by Memory/Site only makes sense at the root program. For
		// subcommand help (e.g. `jolli auth --help`), defer to Commander's
		// default formatter — visibleCommands is still applied so hidden
		// commands stay filtered.
		if (cmd.parent !== null) {
			return Help.prototype.formatHelp.call(helper, cmd, helper);
		}

		const itemIndent = "  ";
		const visibleCmds = helper.visibleCommands(cmd);
		const visibleOpts = helper.visibleOptions(cmd);

		// Compute a single column width across all rendered terms so options and
		// both command groups line up consistently.
		const allTerms = [
			...visibleOpts.map((o) => helper.optionTerm(o)),
			...visibleCmds.map((c) => helper.subcommandTerm(c)),
		];
		const termWidth = allTerms.reduce((max, t) => Math.max(max, t.length), 0);

		const formatRow = (term: string, description: string): string =>
			helper.formatItem(term, termWidth, description, helper);

		const renderSectionDescription = (text: string): string =>
			text
				.split("\n")
				.map((line) => `${itemIndent}${line}`)
				.join("\n");

		const memoryCmds = visibleCmds.filter((c) => MEMORY_COMMAND_NAMES.has(c.name()));
		const siteCmds = visibleCmds.filter((c) => SITE_COMMAND_NAMES.has(c.name()));
		const otherCmds = visibleCmds.filter(
			(c) => !MEMORY_COMMAND_NAMES.has(c.name()) && !SITE_COMMAND_NAMES.has(c.name()),
		);

		const lines: string[] = [];
		lines.push(`Usage: ${helper.commandUsage(cmd)}`, "");

		const description = helper.commandDescription(cmd);
		if (description) lines.push(description, "");

		if (visibleOpts.length > 0) {
			lines.push("Options:");
			for (const opt of visibleOpts) {
				lines.push(formatRow(helper.optionTerm(opt), helper.optionDescription(opt)));
			}
			lines.push("");
		}

		if (memoryCmds.length > 0) {
			lines.push("Jolli Memory — Auto-document AI development sessions");
			lines.push(renderSectionDescription(MEMORY_DESCRIPTION), "");
			lines.push("Commands:");
			for (const c of memoryCmds) {
				lines.push(formatRow(helper.subcommandTerm(c), helper.subcommandDescription(c)));
			}
			lines.push("");
		}

		if (siteCmds.length > 0) {
			lines.push("Jolli Site — Generate a docs site from your content folder");
			lines.push(renderSectionDescription(SITE_DESCRIPTION), "");
			lines.push("Commands:");
			for (const c of siteCmds) {
				lines.push(formatRow(helper.subcommandTerm(c), helper.subcommandDescription(c)));
			}
			lines.push("");
		}

		if (otherCmds.length > 0) {
			lines.push("Other commands:");
			for (const c of otherCmds) {
				lines.push(formatRow(helper.subcommandTerm(c), helper.subcommandDescription(c)));
			}
			lines.push("");
		}

		lines.push("Run `jolli <command> --help` for command-specific options.");
		return `${lines.join("\n")}\n`;
	};

	program.configureHelp({
		visibleCommands(cmd) {
			return cmd.commands.filter((c) => !HIDDEN_COMMANDS.has(c.name()));
		},
		formatHelp: formatGroupedHelp,
	});

	registerEnableCommand(program);
	registerDisableCommand(program);
	registerStatusCommand(program);
	registerConfigureCommand(program);
	registerCleanCommand(program);
	registerDoctorCommand(program);
	registerViewCommand(program);
	registerRecallCommand(program);
	registerSearchCommand(program);
	registerMigrateCommand(program);
	registerExportPromptCommand(program);
	registerExportCommand(program);
	registerAuthCommands(program);
	registerNewCommand(program);
	registerConvertCommand(program);
	registerDevCommand(program);
	registerBuildCommand(program);
	registerStartCommand(program);

	checkVersionMismatch();

	/* v8 ignore start - process.argv branch only used when running as script, not in tests */
	await program.parseAsync(args ? ["node", "jolli", ...args] : process.argv);
	/* v8 ignore stop */
}

// Auto-execute when run as a script (skip in test environment)
/* v8 ignore start */
if (!process.env.VITEST) {
	main().catch((error: unknown) => {
		console.error("Fatal error:", error);
		process.exit(1);
	});
}
/* v8 ignore stop */

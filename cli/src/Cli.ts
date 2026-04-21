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
 *
 * Internal commands (hidden from --help):
 *   migrate       — Migrate orphan branch + index to v3 format
 *   export-prompt — Print prompt templates to stdout
 */

import { Command } from "commander";
import { registerAuthCommands } from "./commands/AuthCommand.js";
import { registerCleanCommand } from "./commands/CleanCommand.js";
import { checkVersionMismatch, VERSION } from "./commands/CliUtils.js";
import { registerConfigureCommand } from "./commands/ConfigureCommand.js";
import { registerDoctorCommand } from "./commands/DoctorCommand.js";
import { registerDisableCommand, registerEnableCommand } from "./commands/EnableCommand.js";
import { registerExportCommand, registerExportPromptCommand } from "./commands/ExportCommand.js";
import { registerMigrateCommand } from "./commands/MigrateCommand.js";
import { registerRecallCommand } from "./commands/RecallCommand.js";
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
	program.name("jolli").description("AI development process auto-documentation tool").version(VERSION);

	// Hide internal commands (migrate, export-prompt) from --help output.
	// They remain fully functional when invoked directly.
	const HIDDEN_COMMANDS = new Set(["migrate", "export-prompt"]);
	program.configureHelp({
		visibleCommands(cmd) {
			return cmd.commands.filter((c) => !HIDDEN_COMMANDS.has(c.name()));
		},
	});

	registerEnableCommand(program);
	registerDisableCommand(program);
	registerStatusCommand(program);
	registerConfigureCommand(program);
	registerCleanCommand(program);
	registerDoctorCommand(program);
	registerViewCommand(program);
	registerRecallCommand(program);
	registerMigrateCommand(program);
	registerExportPromptCommand(program);
	registerExportCommand(program);
	registerAuthCommands(program);

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

/**
 * GlobalDaemonCommand — `jolli global-daemon`, the machine-global resident
 * process.
 *
 * Hidden from `jolli --help`: nothing asks a user to run this. Every entry
 * point spawns it through `ensureGlobalDaemon`, and it reaps itself when a
 * newer bundle retires it.
 *
 * The name is qualified because `jolli daemon` is already taken by the
 * per-project IDE stdio bridge, and the two run side by side.
 */

import type { Command } from "commander";
import { ensureGlobalDaemon, GLOBAL_DAEMON_ENSURE_COMMAND } from "../daemon/EnsureGlobalDaemon.js";
import { GLOBAL_DAEMON_COMMAND, runGlobalDaemon } from "../daemon/GlobalDaemon.js";

export function registerGlobalDaemonCommand(program: Command): void {
	program
		.command(GLOBAL_DAEMON_COMMAND, { hidden: true })
		.description("Machine-global resident process for scheduled maintenance work")
		.option("--socket <path>", "Override the derived socket path")
		.action(async (options: { socket?: string }) => {
			await runGlobalDaemon({ socketPath: options.socket });
		});

	program
		.command(GLOBAL_DAEMON_ENSURE_COMMAND, { hidden: true })
		.description("Detached helper that ensures the machine-global daemon exists")
		.option("--socket <path>", "Override the derived socket path")
		.action(async (options: { socket?: string }) => {
			await ensureGlobalDaemon({ socketPath: options.socket });
		});
}

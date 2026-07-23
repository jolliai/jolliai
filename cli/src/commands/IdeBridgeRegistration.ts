import type { Command } from "commander";
import { resolveProjectDir } from "./CliUtils.js";

/**
 * Registers the hidden IDE IPC commands without loading the large dispatcher on
 * every CLI invocation.
 *
 * Two subcommands:
 *   - `ide-bridge <action>` — one-shot: reads one JSON request from stdin,
 *     writes one JSON response, exits. Used by hooks and by IDE hosts that
 *     have not yet started the long-lived daemon.
 *   - `ide-bridge-serve` — long-lived NDJSON server. Reads one JSON request
 *     per stdin line, writes one JSON response per stdout line, keeps running
 *     until stdin EOF. Amortises Node startup (~500 ms – 2 s) across every
 *     IntelliJ ide-bridge call so subsequent requests are ~5–20 ms.
 */
export function registerIdeBridgeCommand(program: Command): void {
	program
		.command("ide-bridge", { hidden: true })
		.argument("<action>")
		.option("--cwd <dir>", "Project directory", resolveProjectDir())
		.action(async (action: string, options: { cwd: string }) => {
			const { executeIdeBridgeCommand } = await import("./IdeBridgeCommand.js");
			await executeIdeBridgeCommand(action, options.cwd);
		});

	program
		.command("ide-bridge-serve", { hidden: true })
		.description("Long-lived NDJSON ide-bridge server for IDE plugins")
		.option("--cwd <dir>", "Project directory", resolveProjectDir())
		.action(async (options: { cwd: string }) => {
			const { runIdeBridgeServe } = await import("./IdeBridgeCommand.js");
			await runIdeBridgeServe(options.cwd);
		});
}

/**
 * DaemonCommand — hidden long-running bridge that pushes refresh notifications
 * to IDE clients.
 *
 * `jolli daemon` opens a stdio session: after emitting a single `ready`
 * notification with the protocol id and pid, the process watches the project's
 * write outputs and emits `refresh` notifications on any change. The daemon
 * takes no requests — read-path request/response is intentionally NOT wired up
 * here, so a hosting IDE can bring the daemon up without accidentally
 * depending on features that belong to a later slice.
 *
 * Hidden from `jolli --help`: this is IDE plumbing (a Kotlin bridge or the
 * VS Code extension host is expected to spawn it), not a user-facing workflow.
 */

import type { Command } from "commander";
import { runDaemonServer } from "../daemon/DaemonServer.js";
import { setLogDir } from "../Logger.js";
import { resolveProjectDir } from "./CliUtils.js";

interface DaemonOptions {
	cwd: string;
	debounce?: string;
}

/**
 * Parses the optional `--debounce <ms>` flag. Guards against non-integers so
 * a typo does not silently become 0ms (which would defeat coalescing) — and
 * rejects trailing non-digits like `"300abc"`, which `parseInt` would silently
 * accept as 300.
 */
function parseDebounce(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`Invalid --debounce value: ${raw}`);
	}
	return value;
}

export function registerDaemonCommand(program: Command): void {
	program
		.command("daemon", { hidden: true })
		.description("Long-running stdio daemon that pushes refresh notifications to IDE clients")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.option("--debounce <ms>", "Event coalescing window in milliseconds (default: 300)")
		.action(async (options: DaemonOptions) => {
			setLogDir(options.cwd);
			await runDaemonServer({
				cwd: options.cwd,
				debounceMs: parseDebounce(options.debounce),
			});
		});
}

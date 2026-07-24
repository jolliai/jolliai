/**
 * QueueStatusCommand — report whether memory-summary generation is still
 * in progress for the current worktree, and optionally wait for it to drain.
 *
 * This is the CLI surface a PR-description flow polls before building a PR so
 * freshly-committed summaries are included. Wiki/graph ingest is excluded from
 * the "still generating" verdict (see QueueStatus).
 *
 * Output modes:
 *   - `--format json` — the full status object (skill/agent consumption)
 *   - Default — a one-line human-readable summary
 */

import { type Command, Option } from "commander";
import { getQueueStatus, waitForQueueDrained } from "../core/QueueStatus.js";
import { setLogDir } from "../Logger.js";
import { resolveProjectDir } from "./CliUtils.js";

interface QueueStatusOptions {
	wait?: boolean;
	timeout?: string;
	format?: string;
	cwd: string;
}

/** Registers the `queue-status` command on the given Commander program. */
export function registerQueueStatusCommand(program: Command): void {
	program
		.command("queue-status")
		.description("Report whether memory-summary generation is still in progress (skill/agent consumption)")
		.option("--wait", "Block until the queue drains or the timeout elapses")
		.option("--timeout <seconds>", "Max seconds to wait with --wait (default 120)")
		.addOption(new Option("--format <fmt>", "Output format").choices(["json"]))
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: QueueStatusOptions) => {
			try {
				const projectDir = options.cwd;
				setLogDir(projectDir);

				// Guard against NaN/negative/Infinity: an invalid --timeout must fall
				// back to `undefined` so waitForQueueDrained applies its 120s default.
				// A raw `NaN` would make `waitedMs >= NaN` always false and hang forever.
				let timeoutMs: number | undefined;
				if (options.timeout !== undefined) {
					const seconds = Number(options.timeout);
					timeoutMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
				}
				const result = options.wait
					? await waitForQueueDrained(projectDir, { timeoutMs })
					: await getQueueStatus(projectDir);

				if (options.format === "json") {
					// Emit a stable, type-tagged shape: a `type` discriminator (matching
					// the `{type:"error"}` failure payload and the repo's other JSON
					// unions) and an always-present `waitedMs` (0 without --wait) so a
					// consumer never has to branch on which flags were passed.
					const waitedMs = "waitedMs" in result ? result.waitedMs : 0;
					console.log(JSON.stringify({ type: "status", ...result, waitedMs }));
				} else if (result.drained) {
					console.log("\n  Memory generation is idle (queue drained).\n");
				} else if (result.active === 0) {
					// Queue is empty but the worker is still blocking-busy: it's
					// wrapping up the last summary rather than "generating 0" of them.
					console.log("\n  Finishing the last memory summary...\n");
				} else {
					console.log(`\n  ${result.active} memory summary(ies) still generating.\n`);
				}
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				if (options.format === "json") {
					console.log(JSON.stringify({ type: "error", message }));
				} else {
					console.error(`\n  Error: ${message}\n`);
				}
				process.exitCode = 1;
			}
		});
}

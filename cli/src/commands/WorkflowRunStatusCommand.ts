/**
 * `workflow-run-status <runId>` — monitor a remote workflow run to a terminal
 * state and print its report as JSON. The `jolli-remote-run` recipe shells this
 * once (after `run_remote_workflow` returns a run id) instead of driving the poll
 * loop itself; the monitor owns backoff, terminal detection, and the timeout.
 *
 * Output (always JSON on stdout, one line):
 *   - the `RunReport` shape (`{ status, openableUrls, cancel?, troubleshooting? }`)
 *     with an added `timedOut?: boolean` when the attempt cap was hit while still
 *     running. Exit 0.
 *   - `{ type: "error", message }` — a persistent fetch failure / platform tools
 *     off. Exit 1.
 *
 * This command never opens a browser itself — the recipe offers `jolli open-url`
 * per URL the user chooses.
 */

import type { Command } from "commander";
import { JolliMemoryPushClient } from "../core/JolliMemoryPushClient.js";
import { monitorRun, realSleep } from "../core/WorkflowRunMonitor.js";

/** Registers the `workflow-run-status` command on the given Commander program. */
export function registerWorkflowRunStatusCommand(program: Command): void {
	program
		.command("workflow-run-status <runId>")
		.description(
			"Monitor a remote workflow run to a terminal state and print its report as JSON (agent/recipe consumption)",
		)
		.action(async (runId: string) => {
			try {
				const client = new JolliMemoryPushClient();
				const report = await monitorRun(
					{ getRunStatus: (id) => client.getRunStatus(id), sleep: realSleep },
					runId,
				);
				console.log(JSON.stringify(report));
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				console.log(JSON.stringify({ type: "error", message }));
				process.exitCode = 1;
			}
		});
}

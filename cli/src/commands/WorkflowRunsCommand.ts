/**
 * `workflow-runs <workflowId>` — list a workflow's run history (newest first) as
 * JSON. The `/jolli` menu's "Workflow history" action and the run recipes shell
 * this to enumerate past runs and offer to open any listed URL via
 * `jolli open-url`; it never opens a browser itself.
 *
 * Output (always JSON on stdout, one line):
 *   - `{ type: "runs", runs: RunHistoryEntry[] }` — one row per run (status,
 *     timestamp, workflow/run deep-links, the PR URL when the payload carried one,
 *     and the active article URLs), each projected through `shapeRunHistoryEntry`.
 *     Exit 0.
 *   - `{ type: "runs", runs: [] }` — degraded: platform tools off / tool absent
 *     from the manifest / transport failure. `listWorkflowRuns` fails loudly and
 *     this command catches it, so an unavailable history is a normal empty
 *     outcome, never a crash. Exit 0.
 *
 * The argument is the workflow's numeric id; a numeric positional is coerced to a
 * number to honor the `list_workflow_runs({ id: number })` contract (a
 * non-numeric value is passed verbatim for the backend to reject).
 */

import type { Command } from "commander";
import { JolliMemoryPushClient } from "../core/JolliMemoryPushClient.js";
import { shapeRunHistoryEntry } from "../core/WorkflowRunReport.js";

/** Registers the `workflow-runs` command on the given Commander program. */
export function registerWorkflowRunsCommand(program: Command): void {
	program
		.command("workflow-runs <workflowId>")
		.description(
			"List a workflow's run history (status, timestamps, deep-links, article/PR URLs) as JSON (agent/recipe consumption)",
		)
		.action(async (workflowId: string) => {
			const id = /^\d+$/.test(workflowId) ? Number(workflowId) : workflowId;
			const client = new JolliMemoryPushClient();
			try {
				const runs = await client.listWorkflowRuns(id);
				console.log(JSON.stringify({ type: "runs", runs: runs.map(shapeRunHistoryEntry) }));
			} catch {
				console.log(JSON.stringify({ type: "runs", runs: [] }));
			}
		});
}

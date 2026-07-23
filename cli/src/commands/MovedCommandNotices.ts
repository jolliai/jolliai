/**
 * MovedCommandNotices — hidden compatibility shims for the flat workflow-run
 * command names removed when the workflow-run surface moved to the
 * `@jolli.ai/workflow-cli` plugin (`local-run-workflows` → `workflow local-run`,
 * `workflow-run-status` → `workflow run-status`, `workflow-runs` → `workflow
 * runs`).
 *
 * These are NOT functional forwarders — they print a one-line "this command
 * moved, your skills were refreshed, re-run" notice and exit non-zero. They exist
 * only so a stale on-disk recipe (written by a pre-migration `jolli enable`, on a
 * host upgraded WITHOUT a re-enable) that still shells an old flat name gets a
 * clear, self-explaining message instead of Commander's bare "unknown command"
 * error. The paired {@link autoRefreshSkillsIfStale} has, by the time this fires,
 * already rewritten the recipe to the new command names in the same invocation,
 * so the "re-run your request" guidance resolves on the next agent step.
 *
 * Registered UNCONDITIONALLY (not gated on plugin presence): even when the plugin
 * IS installed the old flat name still does not exist (the plugin uses the
 * namespaced `workflow <sub>` form), so the notice is the correct response either
 * way. Hidden from `--help`; the registration is collision-tolerant so it never
 * shadows a real command that happens to own the name.
 *
 * These are a bounded migration aid — safe to delete in a future major once the
 * pre-migration recipe revisions are well out of circulation.
 */

import type { Command } from "commander";

/** Old flat command name → its namespaced replacement under the `workflow` command. */
const MOVED_WORKFLOW_COMMANDS: ReadonlyArray<{ readonly from: string; readonly to: string }> = [
	{ from: "local-run-workflows", to: "workflow local-run" },
	{ from: "workflow-run-status", to: "workflow run-status" },
	{ from: "workflow-runs", to: "workflow runs" },
];

const INSTALL_COMMAND = "npm i -g @jolli.ai/cli @jolli.ai/workflow-cli";

/**
 * Registers a hidden notice command for each removed flat workflow-run command
 * name. Skips any name already registered (a real plugin/builtin always wins).
 */
export function registerMovedCommandNotices(program: Command): void {
	const occupied = new Set<string>();
	for (const c of program.commands) {
		occupied.add(c.name());
		for (const a of c.aliases()) occupied.add(a);
	}

	for (const { from, to } of MOVED_WORKFLOW_COMMANDS) {
		if (occupied.has(from)) continue;
		program
			.command(from, { hidden: true })
			.allowUnknownOption()
			.argument("[args...]", "forwarded arguments (ignored — this command has moved)")
			.action(() => {
				console.error("");
				console.error(`  \`jolli ${from}\` has moved to \`jolli ${to}\` (provided by @jolli.ai/workflow-cli).`);
				console.error("");
				console.error(
					"  Your Jolli skills have just been refreshed to the new commands — re-run your request.",
				);
				console.error("  If it still fails, install the plugin:");
				console.error(`      ${INSTALL_COMMAND}`);
				console.error("");
				process.exitCode = 1;
			});
	}
}

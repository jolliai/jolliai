/**
 * WorkflowCommandStubs — placeholder commander for the Jolli `workflow` command
 * when the `@jolli.ai/workflow-cli` plugin is not installed.
 *
 * Why this exists
 * ----------------
 *
 * The workflow-run surface (`workflow local-run` / `workflow runs` /
 * `workflow run-status`) lives in the `@jolli.ai/workflow-cli` plugin package.
 * The host CLI discovers it through `PluginLoader` (allow-listed by
 * `jolliPluginId`, not by name). When the plugin is installed alongside the host
 * CLI, its `register()` adds the real `workflow` command with those three
 * subcommands. When it isn't installed, `PluginLoader` falls back to registering
 * the stub in this file so:
 *
 *   - `jolli --help` still shows the `workflow` command under the "Jolli
 *     Workflows" section, so users discover the feature exists.
 *   - Running a workflow subcommand prints a clear install hint instead of an
 *     "unknown command" error.
 *
 * This mirrors `SpaceCommandStubs` / `SiteCommandStubs`, with one shape
 * difference: the workflow surface is a SINGLE top-level `workflow` command with
 * subcommands (`local-run`, `runs`, `run-status`), not a flat family of
 * top-level commands. So this registers exactly one `workflow` stub whose action
 * inspects the forwarded subcommand and branches:
 *
 *   - `workflow local-run` — the local-run recipe parses this command's stdout
 *     as JSON, so the stub emits a machine-readable
 *     `{ "type": "workflow_cli_required", "installHint": "…" }` object on stdout
 *     (exit 0, a "needs input" state — NOT the prose-`exit 1` error pattern).
 *     This matches how the real plugin surfaces `space_cli_required` for the same
 *     recipe, so the recipe's JSON-first parse handles both uniformly.
 *   - any other subcommand (`runs`, `run-status`, or none) — prints the prose
 *     install hint on stderr and exits non-zero so scripts fail loudly.
 *
 * No auto-install path here — global npm installs need user consent for
 * sudo / package-manager UX, and the install command varies by environment
 * (npm, pnpm, yarn, bun, system package manager wrappers). We print the
 * canonical npm command and exit; the user can adapt.
 */

import type { Command } from "commander";
import { setHelpGroup } from "./HelpGroups.js";

/**
 * The install hint surfaced when the workflow-cli plugin is absent. Names BOTH
 * the host CLI and the plugin because a user hitting this path may have neither
 * on their PATH at the right versions. This exact string is echoed verbatim in
 * the `workflow_cli_required` JSON the local-run recipe parses.
 */
const INSTALL_COMMAND = "npm i -g @jolli.ai/cli @jolli.ai/workflow-cli";

/**
 * Registers the stub `workflow` command. `.argument("[args...]")` +
 * `.allowUnknownOption()` keep the user's original argv (subcommand + flags)
 * from tripping Commander's "unknown option" rejection, so the action always
 * fires and can branch on the forwarded subcommand.
 *
 * Registration is collision-tolerant (see `SpaceCommandStubs` for the rationale):
 * if `workflow` is already registered — by a real plugin that loaded, or a
 * builtin — the stub is skipped rather than letting Commander's duplicate-name
 * throw abort registration.
 */
export function registerWorkflowCommandStubs(program: Command): void {
	const occupied = new Set<string>();
	for (const c of program.commands) {
		occupied.add(c.name());
		for (const a of c.aliases()) occupied.add(a);
	}
	if (occupied.has("workflow")) return;

	const cmd = program
		.command("workflow")
		.description("Run Jolli workflows locally or remotely and view run history (requires @jolli.ai/workflow-cli)")
		.argument("[args...]", "Subcommand and arguments forwarded to the real command once installed")
		.allowUnknownOption()
		.action((args: string[]) => {
			const subcommand = args[0];
			if (subcommand === "local-run") {
				// The local-run recipe parses this command's stdout as JSON and
				// treats `workflow_cli_required` as a "needs input" state (install
				// the plugin), NOT an error — so emit JSON on stdout and exit 0.
				console.log(JSON.stringify({ type: "workflow_cli_required", installHint: INSTALL_COMMAND }));
				return;
			}
			// `runs`, `run-status`, or anything else: prose install hint + fail loudly.
			const shown = subcommand ? `workflow ${subcommand}` : "workflow";
			console.error("");
			console.error(`  \`jolli ${shown}\` requires the @jolli.ai/workflow-cli plugin.`);
			console.error("");
			console.error(`  Install it with:`);
			console.error(`      ${INSTALL_COMMAND}`);
			console.error("");
			console.error(`  Then re-run: jolli ${shown} ...`);
			console.error("");
			process.exit(1);
		});
	setHelpGroup(cmd, "workflow");
}

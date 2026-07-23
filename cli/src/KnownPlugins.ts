/**
 * Allow-list of CLI plugins the host knows by stable random ID.
 *
 * Each entry binds a `jolliPluginId` (the opaque string the plugin embeds in
 * its own `package.json`) to:
 *
 *   - `packageName` — the npm package name, for diagnostics only. Discovery
 *     is gated by ID, never by name (names can change as the ecosystem
 *     evolves and binding the host to a specific name would leak it into the
 *     open-source codebase).
 *   - `installHint` — shell command the user can run to add the plugin.
 *     Surfaced in `--help` and in the stub action's diagnostic output.
 *   - `registerStub` — optional fallback. When a plugin in this list is NOT
 *     discovered on disk, `PluginLoader` calls `registerStub(program)` so
 *     the plugin's commands still appear in `jolli --help` (printing an
 *     install hint when invoked). Plugins that should silently no-op when
 *     missing simply omit this field.
 *
 * Adding a plugin to this list does not in itself install or load anything —
 * it just whitelists the ID so `PluginLoader.discoverPlugins` will recognize
 * it on disk, and registers a stub fallback for the missing case.
 */

import type { Command } from "commander";
import type { HelpGroup } from "./commands/HelpGroups.js";
import { registerSiteCommandStubs } from "./commands/SiteCommandStubs.js";
import { registerSpaceCommandStubs } from "./commands/SpaceCommandStubs.js";
import { registerWorkflowCommandStubs } from "./commands/WorkflowCommandStubs.js";

export interface KnownPlugin {
	id: string;
	packageName: string;
	installHint: string;
	/**
	 * Which `jolli --help` section this plugin's commands render under. When set,
	 * `PluginLoader` tags every command the plugin registers with this group so
	 * the help formatter buckets them by provenance rather than by name (see
	 * {@link HelpGroup}). Plugins whose commands should fall under "Other
	 * commands:" simply omit it.
	 */
	helpGroup?: HelpGroup;
	registerStub?: (program: Command) => void;
}

export const KNOWN_PLUGINS: ReadonlyArray<KnownPlugin> = [
	{
		// @jolli.ai/space-cli — Jolli proprietary plugin (separate repository).
		// When missing, stubs keep the Space commands (init / space / source /
		// impact / sync / agent) visible in `--help` and emit a one-line install
		// hint on invocation — identical UX to site-cli below.
		id: "c56530c4-3f2f-467f-a4a4-db4d44c79c1c",
		packageName: "@jolli.ai/space-cli",
		installHint: "npm install -g @jolli.ai/space-cli",
		helpGroup: "space",
		registerStub: registerSpaceCommandStubs,
	},
	{
		// @jolli.ai/site-cli — documentation site generation. When missing,
		// stubs keep the seven Site commands visible in `--help` and emit a
		// one-line install hint on invocation.
		id: "290e6c2f-d894-446c-9763-94a863f3a2cd",
		packageName: "@jolli.ai/site-cli",
		installHint: "npm install -g @jolli.ai/site-cli",
		helpGroup: "site",
		registerStub: registerSiteCommandStubs,
	},
	{
		// @jolli.ai/workflow-cli — Jolli Workflows (run local/remote, run history).
		// When missing, the stub keeps the `workflow` command visible in `--help`
		// and, per-subcommand, either emits the machine-readable
		// `workflow_cli_required` JSON (`workflow local-run`, parsed by the recipe)
		// or a one-line install hint (`workflow runs` / `workflow run-status`).
		id: "5ea2fc8c-a0cb-416f-9276-219f1d51c51f",
		packageName: "@jolli.ai/workflow-cli",
		// Single-package hint (this is the surface `doctor` / the update-check print
		// to upgrade an already-known plugin). Intentionally NOT the two-package
		// `npm i -g @jolli.ai/cli @jolli.ai/workflow-cli` the stub + local-run recipe
		// use — those name both packages because a user on that path may have neither
		// at the right versions. Matches the single-package hint on the site/space
		// entries; don't "reconcile" the two forms.
		installHint: "npm install -g @jolli.ai/workflow-cli",
		helpGroup: "workflow",
		registerStub: registerWorkflowCommandStubs,
	},
];

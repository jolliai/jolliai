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
];

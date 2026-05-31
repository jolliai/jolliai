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
import { registerSiteCommandStubs } from "./commands/SiteCommandStubs.js";

export interface KnownPlugin {
	id: string;
	packageName: string;
	installHint: string;
	registerStub?: (program: Command) => void;
}

export const KNOWN_PLUGINS: ReadonlyArray<KnownPlugin> = [
	{
		// @jolli.ai/cli-pro — Jolli proprietary plugin (separate repository).
		// No stub: commands provided by cli-pro do not have a host-side
		// placeholder; users who do not have cli-pro simply do not see its
		// commands at all.
		id: "c56530c4-3f2f-467f-a4a4-db4d44c79c1c",
		packageName: "@jolli.ai/cli-pro",
		installHint: "npm install -g @jolli.ai/cli-pro",
	},
	{
		// @jolli.ai/site-cli — documentation site generation. When missing,
		// stubs keep the seven Site commands visible in `--help` and emit a
		// one-line install hint on invocation.
		id: "290e6c2f-d894-446c-9763-94a863f3a2cd",
		packageName: "@jolli.ai/site-cli",
		installHint: "npm install -g @jolli.ai/site-cli",
		registerStub: registerSiteCommandStubs,
	},
];

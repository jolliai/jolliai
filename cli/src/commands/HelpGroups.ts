/**
 * HelpGroups — provenance tagging for `jolli --help` section grouping.
 *
 * `formatGroupedHelp` in `Api.ts` renders top-level commands under product
 * sections ("Jolli Site", "Jolli Space", …). It used to bucket commands by a
 * static name set, but that mis-classifies any command whose name happens to
 * overlap another section's set — e.g. a plugin registering a generic `init`
 * or `sync` would be rendered under the wrong product. Names are not a reliable
 * key once more than one plugin is in play.
 *
 * Instead each command carries an explicit group tag set by whoever registered
 * it: plugin stubs tag their own commands, and `PluginLoader` tags the commands
 * a known plugin adds during `register()` (looked up by `helpGroup` in
 * `KnownPlugins`). The help formatter then groups by tag, so a command lands in
 * a section because of where it came from, not what it is called.
 *
 * The tag is a non-enumerable-free own property on the Command instance; the
 * Memory builtins are never tagged and are still grouped by name in `Api.ts`.
 */

import type { Command } from "commander";

/** Identifies the `jolli --help` section a plugin's commands belong to. */
export type HelpGroup = "site" | "space";

/** Property key under which the group tag is stashed on a Command instance. */
const HELP_GROUP_KEY = "__jolliHelpGroup";

/**
 * Tag a command with the help section it belongs to. Called by plugin stubs and
 * by `PluginLoader` after a known plugin's `register()`.
 */
export function setHelpGroup(cmd: Command, group: HelpGroup): void {
	(cmd as unknown as Record<string, HelpGroup>)[HELP_GROUP_KEY] = group;
}

/** Read a command's group tag, or `undefined` if it was never tagged. */
export function getHelpGroup(cmd: Command): HelpGroup | undefined {
	return (cmd as unknown as Record<string, HelpGroup | undefined>)[HELP_GROUP_KEY];
}

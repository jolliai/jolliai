/**
 * SpaceCommandStubs — placeholder commanders for the Jolli Space commands when
 * the `@jolli.ai/space-cli` plugin is not installed.
 *
 * Why this exists
 * ----------------
 *
 * The `space` command — and all of its subcommands (`init` / `status` /
 * `switch` / `ls` / `clones` / `source` / `impact` / `sync` / `agent`) — lives
 * in the `@jolli.ai/space-cli` plugin package. The host CLI discovers it
 * through `PluginLoader` (allow-listed by `jolliPluginId`, not by name). When
 * the plugin is installed alongside the host CLI, its `register()` adds the
 * real top-level `space` command with all its subcommands. When it isn't
 * installed, `PluginLoader` falls back to registering the stub in this file so:
 *
 *   - `jolli --help` still shows the `space` command under the "Jolli Space"
 *     section, so users discover the feature exists.
 *   - Running a Space command (e.g. `jolli space sync up`) prints a clear
 *     install hint instead of an "unknown command" error.
 *
 * This mirrors `SiteCommandStubs` for `@jolli.ai/site-cli` — the two plugins
 * present identically in `--help` whether or not they are installed.
 *
 * No auto-install path here — global npm installs need user consent for
 * sudo / package-manager UX, and the install command varies by environment
 * (npm, pnpm, yarn, bun, system package manager wrappers). We print the
 * canonical npm command and exit; the user can adapt.
 */

import type { Command } from "commander";
import { setHelpGroup } from "./HelpGroups.js";

interface StubSpec {
	name: string;
	description: string;
}

/**
 * Mirrors the real space-cli command description so `jolli --help` shows the
 * same text whether or not space-cli is installed. Only the top-level command
 * surface is mirrored — since the 0.99.x namespace overhaul that surface is a
 * single `space` command, and the real plugin owns every subcommand (e.g.
 * `space status`, `space sync up`). `.argument("[args...]")` +
 * `.allowUnknownOption()` forward any subcommand/flag to the stub action so it
 * still prints the install hint. The `(requires @jolli.ai/space-cli)` suffix is
 * appended so the user understands why invoking the command might prompt for
 * installation.
 */
const SPACE_COMMAND_STUBS: ReadonlyArray<StubSpec> = [
	{ name: "space", description: "Manage Jolli spaces, synchronization, sources, impact analysis, and agents" },
];

const INSTALL_COMMAND = "npm install -g @jolli.ai/space-cli";

/**
 * Registers the `space` stub commander. It prints a one-line install hint and
 * exits non-zero so scripts that depended on the real command fail loudly
 * rather than silently no-op.
 *
 * `.allowUnknownOption()` + `.argument("[args...]")` keep the user's
 * original argv from triggering Commander's "unknown option" rejection,
 * so a user typing `jolli space sync up --some-flag` sees the install hint
 * instead of a parser error.
 *
 * Registration is collision-tolerant: Commander's `program.command(name)`
 * throws on a duplicate name, and an unguarded throw here would abort help
 * rendering entirely. We snapshot the occupied namespace (names + aliases) up
 * front and skip the `space` stub if that name is already taken (by a builtin
 * or another plugin), so a collision degrades gracefully to "no Space section"
 * rather than throwing. Kept as a loop so re-expanding the top-level surface
 * later is a one-line array change.
 */
export function registerSpaceCommandStubs(program: Command): void {
	const occupied = new Set<string>();
	for (const c of program.commands) {
		occupied.add(c.name());
		for (const a of c.aliases()) occupied.add(a);
	}

	for (const { name, description } of SPACE_COMMAND_STUBS) {
		if (occupied.has(name)) continue;
		const cmd = program
			.command(name)
			.description(`${description} (requires @jolli.ai/space-cli)`)
			.argument("[args...]", "Arguments forwarded to the real command once installed")
			.allowUnknownOption()
			.action(() => {
				console.error("");
				console.error(`  Space command \`${name}\` requires the @jolli.ai/space-cli plugin.`);
				console.error("");
				console.error(`  Install it with:`);
				console.error(`      ${INSTALL_COMMAND}`);
				console.error("");
				console.error(`  Then re-run: jolli ${name} ...`);
				console.error("");
				process.exit(1);
			});
		setHelpGroup(cmd, "space");
		occupied.add(name);
	}
}

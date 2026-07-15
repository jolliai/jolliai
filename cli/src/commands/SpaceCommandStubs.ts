/**
 * SpaceCommandStubs — placeholder commanders for the Jolli Space commands when
 * the `@jolli.ai/space-cli` plugin is not installed.
 *
 * Why this exists
 * ----------------
 *
 * The space / sync / source / impact / docs / agent commands live in the
 * `@jolli.ai/space-cli` plugin package. The host CLI discovers it through
 * `PluginLoader` (allow-listed by `jolliPluginId`, not by name). When the
 * plugin is installed alongside the host CLI, its `register()` adds the real
 * `init` / `space` / `source` / `impact` / `sync` / `docs` / `agent` commands.
 * When it isn't installed, `PluginLoader` falls back to registering the stubs
 * in this file so:
 *
 *   - `jolli --help` still shows the Space commands under the "Jolli Space"
 *     section, so users discover the feature exists.
 *   - Running a Space command prints a clear install hint instead of an
 *     "unknown command" error.
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
 * Mirrors the real space-cli command descriptions so `jolli --help` shows the
 * same text whether or not space-cli is installed. Only the top-level command
 * surface is mirrored — the real plugin owns the subcommands (e.g. `sync up`,
 * `space status`); `.argument("[args...]")` + `.allowUnknownOption()` forward
 * any subcommand/flag to the stub action so it still prints the install hint.
 * The `(requires @jolli.ai/space-cli)` suffix is appended so the user
 * understands why invoking the command might prompt for installation.
 */
const SPACE_COMMAND_STUBS: ReadonlyArray<StubSpec> = [
	{ name: "init", description: "Initialize this directory: login (if needed) and select a space" },
	{ name: "space", description: "Inspect Jolli auth state and select a space for sync" },
	{ name: "source", description: "Manage source repositories for impact analysis" },
	{ name: "impact", description: "Documentation impact analysis tools" },
	{ name: "sync", description: "Sync markdown files with the server" },
	{ name: "docs", description: "Pull and publish documents for a git-backed space" },
	{ name: "agent", description: "Interactive LLM agent with local tool execution" },
];

const INSTALL_COMMAND = "npm install -g @jolli.ai/space-cli";

/**
 * Registers stub commanders for every Space command. Each stub prints a
 * one-line install hint and exits non-zero so scripts that depended on the
 * real command fail loudly rather than silently no-op.
 *
 * `.allowUnknownOption()` + `.argument("[args...]")` keep the user's
 * original argv from triggering Commander's "unknown option" rejection,
 * so a user typing `jolli sync up --some-flag` sees the install hint
 * instead of a parser error.
 *
 * Registration is collision-tolerant: Commander's `program.command(name)`
 * throws on a duplicate name, and a single throw would abort the whole loop —
 * one already-occupied name (e.g. a builtin or another plugin owning `sync` or
 * `init`) would otherwise drop every remaining stub and the entire Space
 * section. We snapshot the occupied namespace (names + aliases) up front and
 * skip any stub whose name is already taken, so the rest of the batch still
 * registers.
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

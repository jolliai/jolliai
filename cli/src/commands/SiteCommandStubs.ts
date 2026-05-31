/**
 * SiteCommandStubs — placeholder commanders for the seven site commands when
 * the `@jolli.ai/site-cli` plugin is not installed.
 *
 * Why this exists
 * ----------------
 *
 * Site generation lives in the `@jolli.ai/site-cli` plugin package. The host
 * CLI discovers it through `PluginLoader` (allow-listed by `jolliPluginId`,
 * not by name). When the plugin is installed alongside the host CLI, its
 * `register()` adds the real `new` / `build` / `dev` / `start` / `convert`
 * / `reverse` / `theme` commands. When it isn't installed, `PluginLoader`
 * falls back to registering the stubs in this file so:
 *
 *   - `jolli --help` still shows the Site commands under the "Jolli Site"
 *     section, so users discover the feature exists.
 *   - Running a site command prints a clear install hint instead of an
 *     "unknown command" error.
 *
 * No auto-install path here — global npm installs need user consent for
 * sudo / package-manager UX, and the install command varies by environment
 * (npm, pnpm, yarn, bun, system package manager wrappers). We print the
 * canonical npm command and exit; the user can adapt.
 */

import type { Command } from "commander";

interface StubSpec {
	name: string;
	description: string;
}

/**
 * Mirrors the real site command descriptions so `jolli --help` shows the
 * same text whether or not site-cli is installed. The `(requires
 * @jolli.ai/site-cli)` suffix is appended so the user understands why
 * invoking the command might prompt for installation.
 */
const SITE_COMMAND_STUBS: ReadonlyArray<StubSpec> = [
	{ name: "new", description: "Scaffold a new documentation project" },
	{ name: "convert", description: "Convert a documentation folder to Nextra-compatible structure" },
	{ name: "dev", description: "Start a dev server with hot reload" },
	{ name: "build", description: "Build a static site with search indexing" },
	{ name: "start", description: "Build and serve a production site" },
	{ name: "reverse", description: "Reverse-engineer a site.json from a Jolli build output" },
	{ name: "theme", description: "Manage documentation themes" },
];

const INSTALL_COMMAND = "npm install -g @jolli.ai/site-cli";

/**
 * Registers stub commanders for every site command. Each stub prints a
 * one-line install hint and exits non-zero so scripts that depended on the
 * real command fail loudly rather than silently no-op.
 *
 * `.allowUnknownOption()` + `.argument("[args...]")` keep the user's
 * original argv from triggering Commander's "unknown option" rejection,
 * so a user typing `jolli new my-site --some-flag` sees the install hint
 * instead of a parser error.
 */
export function registerSiteCommandStubs(program: Command): void {
	for (const { name, description } of SITE_COMMAND_STUBS) {
		program
			.command(name)
			.description(`${description} (requires @jolli.ai/site-cli)`)
			.argument("[args...]", "Arguments forwarded to the real command once installed")
			.allowUnknownOption()
			.action(() => {
				console.error("");
				console.error(`  Site command \`${name}\` requires the @jolli.ai/site-cli plugin.`);
				console.error("");
				console.error(`  Install it with:`);
				console.error(`      ${INSTALL_COMMAND}`);
				console.error("");
				console.error(`  Then re-run: jolli ${name} ...`);
				console.error("");
				process.exit(1);
			});
	}
}

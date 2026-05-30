/**
 * SiteCommandStubs — placeholder commanders for the seven site commands when
 * `@jolli.ai/site-core` is not installed.
 *
 * Why this exists
 * ----------------
 *
 * The CLI bundles `@jolli.ai/site-core` as an `optionalDependencies` entry.
 * On `npm install -g @jolli.ai/cli` the package manager tries to fetch site-core
 * but a failure (private registry, network, pre-publish window) is silent —
 * the CLI installs without it.
 *
 * Memory / auth / doctor / etc. don't import site-core, so they keep working.
 * Site commands (new / build / dev / start / convert / reverse / theme), if
 * registered via their real implementations, would crash at module load
 * (Api.ts → NewCommand.ts → StarterKit.ts → `@jolli.ai/site-core` → ERR_MODULE_NOT_FOUND).
 *
 * `Api.ts` checks `isSiteCoreInstalled()` at startup:
 *   - true  → dynamic import + register the real site command modules.
 *   - false → register THIS module's stubs instead.
 *
 * The stubs keep the command names visible in `jolli --help` (grouped under
 * "Jolli Site") so users still discover the feature exists, and on invocation
 * they prompt the user to install site-core. The auto-install path uses
 * `ensureSiteCoreInstalled`, which runs `npm install -g @jolli.ai/site-core`.
 * After a successful install the stub asks the user to re-run their command —
 * the current process's static import graph is already fixed, so a clean
 * second invocation is the simplest path to the real implementation.
 */

import type { Command } from "commander";
import { ensureSiteCoreInstalled } from "../site/EnsureSiteCore.js";

interface StubSpec {
	name: string;
	description: string;
}

/**
 * Mirrors the real site command descriptions so `jolli --help` shows the
 * same text whether or not site-core is installed. The `(requires
 * @jolli.ai/site-core)` suffix is appended so the user understands why
 * the command might prompt for installation.
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

/**
 * Registers stub commanders for every site command. Each stub:
 *   1. Prints a message explaining the command needs site-core.
 *   2. Invokes `ensureSiteCoreInstalled`, which (on TTY) prompts and runs
 *      `npm install -g @jolli.ai/site-core`. On non-TTY it prints the
 *      manual command and exits 1.
 *   3. On a successful install, prints "please re-run" and exits 0.
 *      Re-running the binary triggers the `isSiteCoreInstalled() === true`
 *      branch in `Api.ts` and the real command module loads.
 *
 * `.allowUnknownOption()` and `.argument("[args...]")` keep the user's
 * original argv from triggering Commander's "unknown option" rejection,
 * so a user typing `jolli new my-site --some-flag` sees the install
 * prompt instead of a parser error.
 */
export function registerSiteCommandStubs(program: Command): void {
	for (const { name, description } of SITE_COMMAND_STUBS) {
		program
			.command(name)
			.description(`${description} (requires @jolli.ai/site-core)`)
			.argument("[args...]", "Arguments forwarded to the real command after install")
			.allowUnknownOption()
			.action(async () => {
				console.error("");
				console.error(`  Site command \`${name}\` requires \`@jolli.ai/site-core\`.`);
				console.error("");
				await ensureSiteCoreInstalled();
				// ensureSiteCoreInstalled either succeeded (npm install -g ran
				// to completion) or threw / called process.exit. If we reach
				// this line, site-core is now on disk — but the current
				// process's module graph is locked in. Tell the user to
				// re-invoke. A fresh process will load the real command.
				console.error("");
				console.error(`  ✓ Installation complete. Please re-run: jolli ${name} ...`);
				console.error("");
				process.exit(0);
			});
	}
}

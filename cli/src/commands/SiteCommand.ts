/**
 * Site Command Module
 *
 * Registers `jolli new`, `jolli dev`, and `jolli build` commands for
 * scaffolding, developing, and building Nextra-powered doc/blog sites.
 */

import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { type Command, Option } from "commander";
import { createLogger, setLogDir } from "../Logger.js";
import { build, dev } from "../site/SiteRunner.js";
import { scaffold } from "../site/SiteScaffolder.js";
import { isInteractive, promptText, resolveProjectDir } from "./CliUtils.js";

const log = createLogger("SiteCommand");

export function registerSiteCommands(program: Command): void {
	// ── jolli new ───────────────────────────────────────────────────────────

	program
		.command("new")
		.description("Scaffold a new Nextra documentation site")
		.argument("[folder]", "Target directory for the new site")
		.addOption(
			new Option("--template <template>", "Project template").choices(["minimal", "starter"]).default("starter"),
		)
		.option("--name <name>", "Site name (default: derived from folder name)")
		.option("--force", "Overwrite existing files in the target directory")
		.option("--skip-install", "Skip running npm install after scaffolding")
		.option("-y, --yes", "Skip interactive prompts")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(
			async (
				folder: string | undefined,
				options: {
					template: "minimal" | "starter";
					name?: string;
					force?: boolean;
					skipInstall?: boolean;
					yes?: boolean;
					cwd: string;
				},
			) => {
				setLogDir(options.cwd);
				log.info("Running 'new' command");

				// Resolve folder — prompt if interactive and not provided
				let targetFolder = folder;
				if (!targetFolder && isInteractive() && !options.yes) {
					targetFolder = await promptText("  Folder name: ");
				}
				if (!targetFolder) {
					console.error("\n  Error: folder argument is required.\n");
					process.exitCode = 1;
					return;
				}

				const targetDir = resolve(options.cwd, targetFolder);
				const defaultName = options.template === "starter" ? "Jolli Starter Kit" : basename(targetDir);
				const name = options.name ?? defaultName;

				try {
					const result = scaffold({
						targetDir,
						theme: "docs",
						template: options.template,
						name,
						force: options.force ?? false,
					});

					console.log(`\n  Created ${result.filesWritten} files in ${result.targetDir}`);
					console.log(`  Template: ${options.template}`);

					// Run npm install unless skipped
					if (!options.skipInstall) {
						const shouldInstall =
							options.yes || !isInteractive() || (await promptText("  Run npm install? [Y/n] ")) !== "n";

						if (shouldInstall) {
							console.log("\n  Installing dependencies...\n");
							try {
								execFileSync("npm", ["install"], {
									cwd: targetDir,
									stdio: "inherit",
								});
								console.log("\n  Dependencies installed.");
							} catch {
								console.error(
									`\n  npm install failed. Run it manually: cd ${targetFolder} && npm install`,
								);
							}
						}
					}

					console.log(`\n  Next steps:`);
					console.log(`    cd ${targetFolder}`);
					console.log(`    jolli dev\n`);
				} catch (error) {
					console.error(`\n  Error: ${error instanceof Error ? error.message : error}\n`);
					process.exitCode = 1;
				}
			},
		);

	// ── jolli dev ───────────────────────────────────────────────────────────

	program
		.command("dev")
		.description("Start a local Nextra dev server with hot reload")
		.argument("[folder]", "Site directory (default: current directory)")
		.option("--port <number>", "Dev server port", "3000")
		.option("--no-open", "Don't auto-open the browser")
		.option("--cwd <dir>", "Project directory (default: current directory)", process.cwd())
		.action(
			(
				folder: string | undefined,
				options: {
					port: string;
					open: boolean;
					cwd: string;
				},
			) => {
				setLogDir(options.cwd);
				log.info("Running 'dev' command");

				const targetDir = folder ? resolve(options.cwd, folder) : options.cwd;
				const port = Number.parseInt(options.port, 10) || 3000;

				try {
					dev({ targetDir, port, open: options.open });
				} catch (error) {
					console.error(`\n  Error: ${error instanceof Error ? error.message : error}\n`);
					process.exitCode = 1;
				}
			},
		);

	// ── jolli build ─────────────────────────────────────────────────────────

	program
		.command("build")
		.description("Build a production-ready static site")
		.argument("[folder]", "Site directory (default: current directory)")
		.option("--out <dir>", "Output directory")
		.option("--cwd <dir>", "Project directory (default: current directory)", process.cwd())
		.action(
			(
				folder: string | undefined,
				options: {
					out?: string;
					cwd: string;
				},
			) => {
				setLogDir(options.cwd);
				log.info("Running 'build' command");

				const targetDir = folder ? resolve(options.cwd, folder) : options.cwd;

				try {
					build({ targetDir, outDir: options.out });
				} catch (error) {
					console.error(`\n  Error: ${error instanceof Error ? error.message : error}\n`);
					process.exitCode = 1;
				}
			},
		);
}

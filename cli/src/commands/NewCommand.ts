/**
 * NewCommand — Registers the `jolli new [folder-name]` command.
 *
 * Scaffolds a new Content_Folder at the given folder name (relative to cwd)
 * using StarterKit.scaffoldProject. If no folder name is provided,
 * interactively prompts the user to enter one.
 *
 * On success, prints the created directory path and a brief next-steps
 * message. On failure, prints the error message and sets process.exitCode = 1.
 */

import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Command } from "commander";
import { scaffoldProject } from "../site/StarterKit.js";

/**
 * Prompts the user interactively for a folder name via stdin/stdout.
 */
function promptFolderName(): Promise<string> {
	if (!process.stdin.isTTY) return Promise.resolve("");
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question("Folder name: ", (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

/**
 * Registers the `jolli new [folder-name]` sub-command on the given Commander
 * program.
 */
export function registerNewCommand(program: Command): void {
	program
		.command("new")
		.description("Scaffold a new documentation project")
		.argument("[folder-name]", "Name of the new content folder to create")
		.action(async (folderNameArg?: string) => {
			let folderName = folderNameArg;

			if (!folderName) {
				folderName = await promptFolderName();
				if (!folderName) {
					console.error("\n  Error: Folder name is required.\n");
					process.exitCode = 1;
					return;
				}
			}

			const targetDir = join(process.cwd(), folderName);
			const result = await scaffoldProject(targetDir);

			if (result.success) {
				console.log(`\n  Created ${result.targetDir}`);
				console.log(`  Run \`jolli dev\` inside that folder to preview your site.\n`);
			} else {
				console.error(`\n  Error: ${result.message}\n`);
				process.exitCode = 1;
			}
		});
}

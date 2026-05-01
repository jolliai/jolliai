/**
 * SiteRunner — spawns Next.js dev/build processes for a Nextra site.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import open from "open";
import { createLogger } from "../Logger.js";

const log = createLogger("SiteRunner");

export interface DevOptions {
	readonly targetDir: string;
	readonly port: number;
	readonly open: boolean;
}

export interface BuildOptions {
	readonly targetDir: string;
	readonly outDir?: string;
}

function assertProjectExists(targetDir: string): void {
	const pkgPath = join(targetDir, "package.json");
	if (!existsSync(pkgPath)) {
		throw new Error(`No package.json found in "${targetDir}". Run \`jolli site new\` first.`);
	}
}

function assertNodeModulesExist(targetDir: string): void {
	const nmPath = join(targetDir, "node_modules");
	if (!existsSync(nmPath)) {
		throw new Error(`No node_modules/ found in "${targetDir}". Run \`npm install\` first.`);
	}
}

/**
 * Starts a local Next.js dev server for the Nextra site.
 * The child process inherits stdio so the user sees Next.js output directly.
 */
export function dev(options: DevOptions): void {
	const { targetDir, port, open: shouldOpen } = options;
	assertProjectExists(targetDir);
	assertNodeModulesExist(targetDir);

	const nextBin = join(targetDir, "node_modules", ".bin", "next");
	const args = ["dev", "--webpack", "--port", String(port)];

	log.info(`Starting dev server on port ${port} in ${targetDir}`);
	console.log(`\n  Starting Nextra dev server at http://localhost:${port}\n`);

	/* v8 ignore start -- interactive process spawn not testable in unit tests */
	const child = spawn(nextBin, args, {
		cwd: targetDir,
		stdio: "inherit",
		env: { ...process.env },
	});

	if (shouldOpen) {
		setTimeout(() => {
			open(`http://localhost:${port}`).catch(() => {
				// Ignore errors opening browser
			});
		}, 3000);
	}

	child.on("error", (err) => {
		console.error(`\n  Failed to start dev server: ${err.message}\n`);
		process.exitCode = 1;
	});
	/* v8 ignore stop */
}

/**
 * Runs a production build for the Nextra site.
 */
export function build(options: BuildOptions): void {
	const { targetDir, outDir } = options;
	assertProjectExists(targetDir);
	assertNodeModulesExist(targetDir);

	const nextBin = join(targetDir, "node_modules", ".bin", "next");
	const args = ["build", "--webpack"];

	log.info(`Building site in ${targetDir}`);
	console.log("\n  Building Nextra site...\n");

	/* v8 ignore start -- synchronous exec with inherited stdio not unit-testable */
	const env = { ...process.env };
	if (outDir) {
		env.NEXT_OUTPUT_DIR = outDir;
	}

	try {
		execFileSync(nextBin, args, {
			cwd: targetDir,
			stdio: "inherit",
			env,
		});
		console.log("\n  Build complete.\n");
	} catch {
		console.error("\n  Build failed.\n");
		process.exitCode = 1;
	}
	/* v8 ignore stop */
}

/**
 * NpmRunner — runs npm commands inside the Hidden Build Directory.
 *
 * Uses `child_process.spawnSync` with `stdio: 'pipe'` to capture output.
 * Returns `{ success: false, output }` on non-zero exit codes rather than
 * throwing, so the caller can print the error and set the exit code.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { engineNeedsInstall, ensureEngine, linkEngineModules } from "./EngineManager.js";
import { createOutputFilter } from "./OutputFilter.js";
import type { NpmRunResult } from "./Types.js";

/**
 * On Windows, npm/npx are batch scripts (.cmd) that require `shell: true`
 * for spawn/spawnSync since Node 22.5+ (CVE-2024-27980 hardened child_process
 * to reject .cmd/.bat files without a shell). To avoid the DEP0190 warning
 * ("Passing args to a child process with shell option true"), we join the
 * command and args into a single string when shell mode is active.
 */
const IS_WIN = process.platform === "win32";
const SHELL_OPTS = IS_WIN ? /* v8 ignore next */ ({ shell: true } as const) : {};

/** Merges cmd + args into the format expected by spawn/spawnSync. */
function shellCmd(cmd: string, args: string[]): [string, string[]] {
	/* v8 ignore next */
	return IS_WIN ? [`${cmd} ${args.join(" ")}`, []] : [cmd, args];
}

export type { NpmRunResult };

/**
 * Returns `true` if the shared engine needs (re)installation or
 * the project's `node_modules` symlink is missing.
 */
export function needsInstall(buildDir: string): boolean {
	if (engineNeedsInstall()) return true;
	return !existsSync(join(buildDir, "node_modules"));
}

/**
 * Ensures the shared engine is installed and creates a symlink
 * from `buildDir/node_modules` to the engine's `node_modules`.
 */
export async function runNpmInstall(buildDir: string): Promise<NpmRunResult> {
	const engineResult = await ensureEngine();
	if (!engineResult.success) {
		return { success: false, output: engineResult.output || "Engine install failed" };
	}
	await linkEngineModules(buildDir);
	return { success: true, output: "" };
}

/**
 * Runs `npm run build` inside `buildDir`.
 */
export async function runNpmBuild(buildDir: string): Promise<NpmRunResult> {
	const [cmd, args] = shellCmd("npm", ["run", "build"]);
	const result = spawnSync(cmd, args, {
		cwd: buildDir,
		stdio: "pipe",
		...SHELL_OPTS,
	});

	const stdout = result.stdout ? result.stdout.toString() : "";
	const stderr = result.stderr ? result.stderr.toString() : "";
	const output = [stdout, stderr].filter(Boolean).join("\n");

	if (result.status === 0) {
		return { success: true, output };
	}

	return { success: false, output };
}

/** Result from a long-running server process. */
export interface ServerResult extends NpmRunResult {
	/** The localhost URL extracted from server output. */
	url?: string;
}

/**
 * Runs `npm run dev` (next dev) inside `buildDir` as a long-running process.
 *
 * Output is piped through an OutputFilter. In default mode, only errors
 * and the server URL are shown. In verbose mode, all output is streamed.
 */
export function runNpmDev(buildDir: string, verbose = false): Promise<ServerResult> {
	return runLongProcess("npm", ["run", "dev"], buildDir, verbose);
}

/**
 * Serves the static `out/` directory inside `buildDir` using `npx serve`.
 */
export function runServe(buildDir: string, verbose = false): Promise<ServerResult> {
	return runLongProcess("npx", ["serve", "out"], buildDir, verbose);
}

/**
 * Shared implementation for long-running server processes.
 * Pipes output through OutputFilter and extracts the server URL.
 */
function runLongProcess(rawCmd: string, rawArgs: string[], cwd: string, verbose: boolean): Promise<ServerResult> {
	return new Promise((resolve) => {
		const filter = createOutputFilter(verbose);
		const [cmd, args] = shellCmd(rawCmd, rawArgs);

		const child = spawn(cmd, args, {
			cwd,
			stdio: "pipe",
			...SHELL_OPTS,
		});

		child.stdout?.on("data", (data: Buffer) => {
			filter.write(data.toString());
		});

		child.stderr?.on("data", (data: Buffer) => {
			filter.write(data.toString());
		});

		child.on("close", (code) => {
			resolve({
				success: code === 0 || code === null,
				output: "",
				url: filter.getUrl(),
			});
		});

		child.on("error", (err) => {
			resolve({
				success: false,
				output: err.message,
			});
		});
	});
}

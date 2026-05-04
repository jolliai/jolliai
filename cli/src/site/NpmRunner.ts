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

/** On Windows, npm/npx must be invoked as npm.cmd/npx.cmd. */
const NPM = process.platform === "win32" ? /* v8 ignore next */ "npm.cmd" : "npm";
const NPX = process.platform === "win32" ? /* v8 ignore next */ "npx.cmd" : "npx";

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
	const result = spawnSync(NPM, ["run", "build"], {
		cwd: buildDir,
		stdio: "pipe",
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
	return runLongProcess(NPM, ["run", "dev"], buildDir, verbose);
}

/**
 * Serves the static `out/` directory inside `buildDir` using `npx serve`.
 */
export function runServe(buildDir: string, verbose = false): Promise<ServerResult> {
	return runLongProcess(NPX, ["serve", "out"], buildDir, verbose);
}

/**
 * Shared implementation for long-running server processes.
 * Pipes output through OutputFilter and extracts the server URL.
 */
function runLongProcess(cmd: string, args: string[], cwd: string, verbose: boolean): Promise<ServerResult> {
	return new Promise((resolve) => {
		const filter = createOutputFilter(verbose);

		const child = spawn(cmd, args, {
			cwd,
			stdio: "pipe",
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

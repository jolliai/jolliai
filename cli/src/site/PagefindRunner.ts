/**
 * PagefindRunner — runs the Pagefind indexer against the built site output.
 *
 * Runs `npx pagefind --site out/` inside `buildDir` using `child_process.spawnSync`
 * with `stdio: 'pipe'` to capture output. Parses the output to extract the number
 * of pages indexed.
 *
 * Returns `{ success: false, output }` on non-zero exit codes rather than
 * throwing, so the caller can print the error and set the exit code.
 */

import { spawnSync } from "node:child_process";
import type { PagefindResult } from "./Types.js";

/** On Windows, npx must be invoked as npx.cmd. */
const NPX = process.platform === "win32" ? /* v8 ignore next */ "npx.cmd" : "npx";

export type { PagefindResult };

/**
 * Runs `npx pagefind --site out/` inside `buildDir`.
 *
 * Captures stdout and stderr. Parses the output to extract the number of pages
 * indexed (e.g. "Indexed 42 pages"). Returns `{ success: true, output, pagesIndexed }`
 * on exit code 0, or `{ success: false, output }` on any non-zero exit code.
 */
export function runPagefind(buildDir: string): PagefindResult {
	const result = spawnSync(NPX, ["pagefind", "--site", "out", "--output-path", "out/_pagefind"], {
		cwd: buildDir,
		stdio: "pipe",
	});

	const stdout = result.stdout ? result.stdout.toString() : "";
	const stderr = result.stderr ? result.stderr.toString() : "";
	const output = [stdout, stderr].filter(Boolean).join("\n");

	if (result.status === 0) {
		const match = output.match(/(\d+)\s+pages?/i);
		const pagesIndexed = match ? parseInt(match[1], 10) : undefined;
		return { success: true, output, pagesIndexed };
	}

	return { success: false, output };
}

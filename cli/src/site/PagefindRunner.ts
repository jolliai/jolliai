/**
 * PagefindRunner — runs the Pagefind indexer against the built site output.
 *
 * Runs `npx pagefind --site <site>` inside `buildDir` and parses the output
 * to extract the number of pages indexed.
 *
 * Returns `{ success: false, output }` on non-zero exit codes rather than
 * throwing, so the caller can print the error and set the exit code.
 */

import { spawnHidden } from "../util/Subprocess.js";
import type { PagefindResult } from "./Types.js";

/**
 * On Windows, npx is a .cmd script that requires shell: true since
 * Node 22.5+ (CVE-2024-27980). Command + args are joined into a single
 * string to avoid the DEP0190 warning about shell + separate args.
 */
const IS_WIN = process.platform === "win32";
const SHELL_OPTS = IS_WIN ? /* v8 ignore next */ ({ shell: true } as const) : {};

export type { PagefindResult };

/**
 * Runs `npx pagefind --site <site> --output-path <outputPath>` inside `buildDir`.
 *
 * Async via `spawn` (not `spawnSync`) so the dev-mode background indexer can
 * keep the event loop free while a rebuild is in flight. Captures stdout and
 * stderr. Parses the output to extract the number of pages indexed (e.g.
 * "Indexed 42 pages"). Returns `{ success: true, output, pagesIndexed }` on
 * exit code 0, or `{ success: false, output }` on any non-zero exit code.
 */
export function runPagefind(buildDir: string, site = "out", outputPath = "out/_pagefind"): Promise<PagefindResult> {
	return new Promise((resolve) => {
		const rawArgs = ["pagefind", "--site", site, "--output-path", outputPath];
		const [cmd, args] = IS_WIN ? /* v8 ignore next */ [`npx ${rawArgs.join(" ")}`, []] : ["npx", rawArgs];
		const child = spawnHidden(cmd, args, {
			cwd: buildDir,
			stdio: "pipe",
			...SHELL_OPTS,
		});

		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		child.on("close", (code) => {
			const output = [stdout, stderr].filter(Boolean).join("\n");
			if (code === 0) {
				const match = output.match(/(\d+)\s+pages?/i);
				const pagesIndexed = match ? parseInt(match[1], 10) : undefined;
				resolve({ success: true, output, pagesIndexed });
				return;
			}
			resolve({ success: false, output });
		});

		child.on("error", (err) => {
			resolve({ success: false, output: err.message });
		});
	});
}

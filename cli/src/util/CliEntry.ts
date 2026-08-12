/**
 * Locates the `Cli.js` this process's own bundle ships, for the two places that
 * spawn a detached `jolli` subcommand (the MCP daemon and the global daemon).
 *
 * ## Why NOT `process.argv[1]`
 *
 * argv[1] is "the script Node was launched with", which is the CLI entry only
 * when the caller happens to BE the CLI. Both daemon triggers are reached from
 * hook entry points too — `run-hook` execs `node <dist>/PostCommitHook.js`, and
 * the Claude/Codex plugin manifests exec `node <dist>/PluginBootstrapHook.js` —
 * so argv[1] there names the hook. Spawning it re-runs that hook (its own
 * basename entry guard matches), against `homedir()`, which reaches the trigger
 * again, which spawns again: an unbounded chain of detached processes while the
 * daemon it was asked for never starts.
 *
 * ## Why a SIBLING lookup is the right answer
 *
 * `dirname(import.meta.url)` names the directory the caller's module was loaded
 * from, and every bundle that ships this code puts `Cli.js` in exactly that
 * directory: the CLI's vite build emits entries AND shared chunks flat into
 * `dist/` (`chunkFileNames: "[name].js"`), while the VS Code extension and both
 * plugin dists are esbuild bundles whose `import.meta.url` is defined as the
 * bundle's own `__filename`. `Cli.js` is in `DistPathWriter`'s
 * `REQUIRED_RUNTIME_FILES`, so a registered dist is guaranteed to carry one.
 *
 * This is the rule `QueueWorker.launchWorker` already follows for the same
 * reason, including the `existsSync` guard: a `tsx` run against the source tree
 * has no `Cli.js` anywhere near this module, and answering `undefined` lets the
 * caller log that instead of exec'ing a path that does not exist.
 *
 * `moduleUrl` is a parameter rather than this module's own `import.meta.url` so
 * the resolution is testable, and so the directory that is searched is the
 * CALLER's — which is what makes the rule hold under both bundlers.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The dist filename every surface's CLI entry is emitted under. */
export const CLI_ENTRY_FILENAME = "Cli.js";
/** The source filename the repo's dev entry runs through `tsx`. */
export const CLI_SOURCE_ENTRY_FILENAME = "Cli.ts";

export interface CliInvocation {
	readonly entry: string;
	readonly nodeArgs: ReadonlyArray<string>;
}

/**
 * Returns the absolute path of the `Cli.js` beside `moduleUrl`, or `undefined`
 * when there is none. Callers pass their own `import.meta.url`.
 */
export function resolveCliEntry(moduleUrl: string): string | undefined {
	const entry = join(dirname(fileURLToPath(moduleUrl)), CLI_ENTRY_FILENAME);
	return existsSync(entry) ? entry : undefined;
}

/**
 * Returns the CLI invocation this module's own runtime can re-exec.
 *
 * Built surfaces spawn the sibling `Cli.js`. Source-mode `tsx` runs fall back to
 * `../Cli.ts` plus the current process's loader args, so detached helpers keep
 * working during development too.
 */
export function resolveCliInvocation(
	moduleUrl: string,
	argv1: string | undefined = process.argv[1],
	execArgv: ReadonlyArray<string> = process.execArgv,
): CliInvocation | undefined {
	const builtEntry = resolveCliEntry(moduleUrl);
	if (builtEntry) return { entry: builtEntry, nodeArgs: [] };

	const here = dirname(fileURLToPath(moduleUrl));
	const sourceEntry = join(dirname(here), CLI_SOURCE_ENTRY_FILENAME);
	if (argv1?.endsWith(".ts") && existsSync(sourceEntry)) {
		return { entry: sourceEntry, nodeArgs: execArgv };
	}
	return undefined;
}

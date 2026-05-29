#!/usr/bin/env node
/// <reference types="node" />
/**
 * Jolli Memory CLI — bin entry point.
 *
 * Two-phase startup so a missing `@jolli.ai/site-core` produces a clean
 * install prompt instead of an ERR_MODULE_NOT_FOUND crash:
 *
 *   1. Statically import only `EnsureSiteCore` (which itself does NOT
 *      import site-core — it probes via `require.resolve`).
 *   2. Run `ensureSiteCoreInstalled` *before* any other import. On TTY
 *      we prompt + spawn `npm install -g`; non-TTY prints the manual
 *      command and exits.
 *   3. Only after site-core is reachable do we dynamically import
 *      `Api.ts` and `Logger.ts`. Those transitively pull site command
 *      modules whose own imports of `@jolli.ai/site-core` would
 *      otherwise fail at module load.
 *
 * Programmatic callers that import `@jolli.ai/cli/api` directly skip
 * this binary entirely and reach `Api.ts`'s exports without the prompt
 * — they're expected to provide site-core themselves.
 */

import { ensureSiteCoreInstalled } from "./site/EnsureSiteCore.js";

/* v8 ignore start */
if (!process.env.VITEST) {
	void runCli();
}
/* v8 ignore stop */

async function runCli(): Promise<void> {
	await ensureSiteCoreInstalled();

	// Lazy-load so the static imports inside Api.ts (and its transitive
	// site command modules) only fire after site-core is guaranteed
	// resolvable. See module-level docstring above.
	const { main } = await import("./Api.js");
	const { setSilentConsole } = await import("./Logger.js");

	// Suppress info/debug log output to stderr in CLI mode — users only need
	// to see command results (via console.log), not internal diagnostics.
	// warn/error still go to stderr; all levels still write to debug.log.
	// Kept here in the bin shim rather than inside `main()` so programmatic
	// callers of `main()` (e.g. embedders) don't pick up the global side
	// effect by accident.
	setSilentConsole(true);

	try {
		await main();
	} catch (error: unknown) {
		console.error("Fatal error:", error);
		process.exit(1);
	}
}

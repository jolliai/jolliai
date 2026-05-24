#!/usr/bin/env node
/// <reference types="node" />
/**
 * Jolli Memory CLI — bin entry point.
 *
 * Thin shim: delegates all logic to `Api.ts` so the same code is reachable
 * both as a CLI and as a programmatic import (`@jolli.ai/cli/api`).
 */

import { main } from "./Api.js";
import { setSilentConsole } from "./Logger.js";

// Auto-execute when run as a script (skip in test environment).
/* v8 ignore start */
if (!process.env.VITEST) {
	// Suppress info/debug log output to stderr in CLI mode — users only need
	// to see command results (via console.log), not internal diagnostics.
	// warn/error still go to stderr; all levels still write to debug.log.
	// Kept here in the bin shim rather than inside `main()` so programmatic
	// callers of `main()` (e.g. embedders) don't pick up the global side
	// effect by accident.
	setSilentConsole(true);
	main().catch((error: unknown) => {
		console.error("Fatal error:", error);
		process.exit(1);
	});
}
/* v8 ignore stop */

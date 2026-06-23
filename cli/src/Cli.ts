#!/usr/bin/env node
/// <reference types="node" />
/**
 * Jolli Memory CLI — bin entry point.
 *
 * Thin shim: delegates all logic to `Api.ts` so the same code is reachable
 * both as a CLI and as a programmatic import (`@jolli.ai/cli/api`).
 */

import { main } from "./Api.js";
import { bootstrapTelemetry, maybeShowCliTelemetryNotice } from "./core/TelemetryStartup.js";
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
	void (async () => {
		// Prime telemetry before command dispatch so the commander preAction
		// auto-emit and any in-command track() calls have a live context.
		// Never throws and adds only a couple of local config reads — and the
		// VITEST guard keeps it (and its installId mint) out of unit tests.
		// Print the one-time, content-free telemetry disclosure FIRST (stderr), so a
		// user who only wants to run a single command sees the disclosure before the
		// first `app_installed` event is buffered. Independent of the telemetry
		// context; no-op once shown or when opted out.
		await maybeShowCliTelemetryNotice();
		// Then prime telemetry before command dispatch so the commander preAction
		// auto-emit and any in-command track() calls have a live context. Never
		// throws; the VITEST guard keeps it (and its installId mint) out of tests.
		await bootstrapTelemetry({ cwd: process.cwd() });
		try {
			await main();
		} catch (error: unknown) {
			console.error("Fatal error:", error);
			process.exit(1);
		}
	})();
}
/* v8 ignore stop */

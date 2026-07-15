#!/usr/bin/env node
/// <reference types="node" />
/**
 * Jolli Memory CLI — bin entry point.
 *
 * Thin shim: delegates all logic to `Api.ts` so the same code is reachable
 * both as a CLI and as a programmatic import (`@jolli.ai/cli/api`).
 */

import { main } from "./Api.js";
import { bootstrapTelemetry, flushTelemetryNow, maybeShowCliTelemetryNotice } from "./core/TelemetryStartup.js";
import { runWithTrace, traceIdFromEnv } from "./core/TraceContext.js";
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
	// One trace per CLI invocation. Adopt JOLLI_TRACE_ID if a parent process set
	// it, else mint a fresh id; all logs + outbound backend calls for this
	// command share it.
	runWithTrace(traceIdFromEnv(), () =>
		(async () => {
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
			// JOLLI-1955: drain the shared telemetry buffer on command exit so CLI
			// usage that never commits or runs an agent still uploads. Skip the
			// `telemetry` command group — `off` clears the buffer and `inspect` must
			// not send. Bounded timeout (not the flusher's 10s default) so a slow
			// network can't stall the prompt; best-effort and never throws.
			if (process.argv[2] !== "telemetry") {
				await flushTelemetryNow(process.cwd(), { timeoutMs: 2_000 });
			}
		})(),
	);
}
/* v8 ignore stop */

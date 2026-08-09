#!/usr/bin/env node
/**
 * ServerEntry — detached-process entry point for the read-only dashboard
 * server.
 *
 * Spawned by `jolli dashboard` (and the enable auto-start) with
 * `detached: true` + `unref()`, so it outlives the command that launched it.
 *
 * The process is read-only by construction: it only ever opens the database
 * through `withReadonlyDashboardDb`. When the idle timeout fires (or a signal
 * arrives) it clears `dashboard.json` — so launchers do not chase a dead pid —
 * and exits.
 */

import { createLogger, errMsg } from "../Logger.js";
import { canUseDashboardDb, DashboardRuntimeError } from "./DashboardDb.js";
import { clearDashboardState, startDashboardServer } from "./DashboardServer.js";
import { startServerTelemetry } from "./ServerTelemetry.js";

const log = createLogger("DashboardServerEntry");

/** Optional explicit port from the launcher's `--port` flag. */
export const DASHBOARD_PORT_ENV = "JOLLI_DASHBOARD_PORT";

export interface RunServerEntryResult {
	/** Tears the server down, clears dashboard.json, then calls `exit(0)`. */
	readonly shutdown: () => void;
}

/**
 * Runs the server until idle shutdown or a signal. `exit` is injectable so
 * tests can drive the shutdown path without terminating the test process.
 */
export async function runServerEntry(
	env: NodeJS.ProcessEnv = process.env,
	exit: (code: number) => void = process.exit,
): Promise<RunServerEntryResult> {
	if (!canUseDashboardDb()) {
		// Refuse loudly rather than serving errors: the launcher's /health probe
		// fails fast and its own error message tells the user about the Node floor.
		throw new DashboardRuntimeError(process.versions.node);
	}
	const portRaw = env[DASHBOARD_PORT_ENV];
	const port = portRaw !== undefined ? Number.parseInt(portRaw, 10) : undefined;
	// Prime telemetry for this long-lived process and start its periodic flush,
	// so the `/api/telemetry` beacon's `web-local` events are actually recorded
	// and shipped (see ServerTelemetry). Best-effort; never blocks serving.
	const telemetry = await startServerTelemetry();
	// Both teardown paths clear the state file guarded by our own pid: if the
	// record has moved on to another server, it is that server's now and deleting
	// it would leave a live dashboard no launcher can find. The final telemetry
	// flush runs first so a clean shutdown ships what the last interval did not.
	const finish = async (): Promise<void> => {
		await telemetry.stop();
		await clearOwnState();
		exit(0);
	};
	const clearOwnState = () => clearDashboardState(undefined, process.pid);
	const { server } = await startDashboardServer({
		...(port !== undefined && Number.isFinite(port) ? { port } : {}),
		onIdleShutdown: () => {
			void finish();
		},
	});
	const shutdown = () => {
		server.closeAllConnections();
		server.close();
		void finish();
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	return { shutdown };
}

/* v8 ignore start -- process-level bootstrap, exercised end-to-end not in unit tests */
const isDirectRun = process.argv[1]?.endsWith("ServerEntry.js") || process.argv.includes("--dashboard-server");
if (isDirectRun) {
	runServerEntry().catch((err) => {
		log.error("dashboard server failed to start: %s", errMsg(err));
		console.error(errMsg(err));
		process.exit(1);
	});
}
/* v8 ignore stop */

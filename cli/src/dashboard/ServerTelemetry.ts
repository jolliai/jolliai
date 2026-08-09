/**
 * ServerTelemetry — telemetry lifecycle for the detached dashboard server.
 *
 * A one-shot CLI command primes telemetry at startup and flushes the buffer on
 * exit. The dashboard server is neither: it is long-lived, and it is the process
 * the `/api/telemetry` beacon runs inside. So it needs two things a command does
 * not:
 *
 *   1. Its telemetry context primed once at boot. Without it, `trackAs` in
 *      `DashboardServer.handleTelemetry` is a no-op and every `web-local` event
 *      is silently dropped.
 *   2. A PERIODIC flush. Nothing else drains this process's buffer while it runs
 *      — a CLI command flushes on its own exit, but this server can stay up for
 *      hours, so its events would sit on disk (and eventually age out of the
 *      ring buffer) until it happens to be stopped.
 *
 * Consent is honored entirely by the shared helpers this wraps: an opted-out
 * install primes a disabled context (so `trackAs` no-ops) and `flushTelemetryNow`
 * clears the buffer instead of sending it. Everything here is best-effort and
 * never throws — telemetry must not keep the server from serving.
 */

import { bootstrapTelemetry, flushTelemetryNow } from "../core/TelemetryStartup.js";
import { createLogger, errMsg } from "../Logger.js";

const log = createLogger("ServerTelemetry");

/** Default periodic flush cadence for the long-lived server. */
export const DEFAULT_SERVER_FLUSH_MS = 60_000;

export interface ServerTelemetryDeps {
	/** Prime the telemetry context. Defaults to the real `bootstrapTelemetry`. */
	readonly bootstrap?: (cwd: string) => Promise<void>;
	/** Flush the buffer once. Defaults to the real `flushTelemetryNow`. */
	readonly flush?: (cwd: string) => Promise<void>;
	/** Periodic flush cadence. Defaults to {@link DEFAULT_SERVER_FLUSH_MS}. */
	readonly flushIntervalMs?: number;
	/** Buffer/init working dir. Defaults to `process.cwd()` — init and flush MUST agree on it. */
	readonly cwd?: string;
}

export interface ServerTelemetryHandle {
	/** Clears the flush timer and does one final best-effort flush. Idempotent. */
	readonly stop: () => Promise<void>;
}

/**
 * Primes telemetry for the server process and starts a periodic flush. Never
 * throws. The returned `stop` clears the timer and flushes once more, so a
 * clean shutdown ships what the last interval did not.
 */
export async function startServerTelemetry(deps: ServerTelemetryDeps = {}): Promise<ServerTelemetryHandle> {
	const cwd = deps.cwd ?? process.cwd();
	const bootstrap = deps.bootstrap ?? ((c: string) => bootstrapTelemetry({ cwd: c }));
	const flush = deps.flush ?? flushTelemetryNow;
	const intervalMs = deps.flushIntervalMs ?? DEFAULT_SERVER_FLUSH_MS;

	try {
		await bootstrap(cwd);
	} catch (err) {
		log.warn("telemetry bootstrap failed: %s", errMsg(err));
	}

	const timer = setInterval(() => {
		void flush(cwd).catch(() => {});
	}, intervalMs);
	// Never let the flush timer keep the event loop (or a test runner) alive.
	timer.unref?.();

	let stopped = false;
	const stop = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		try {
			await flush(cwd);
		} catch {
			// best-effort final flush — the process is going away regardless
		}
	};
	return { stop };
}

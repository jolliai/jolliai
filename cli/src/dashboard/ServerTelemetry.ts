/**
 * ServerTelemetry — the periodic telemetry flush the dashboard server needs.
 *
 * A one-shot CLI command primes telemetry at startup and flushes the buffer on
 * exit, and that is enough for a command that returns in a second. `jolli
 * dashboard` serves in that same process but stays up for as long as the user
 * leaves the tab open, and it is the process the `/api/telemetry` beacon runs
 * inside — so its events would sit on disk (and eventually age out of the ring
 * buffer) until Ctrl+C.
 *
 * Priming is deliberately NOT done here. `Cli.ts` already called
 * `bootstrapTelemetry` with `resolveProjectDir()` before dispatching the
 * command, and `TelemetryBuffer` requires every initializer and flusher for one
 * project to agree on that directory — so re-initializing with a second cwd is
 * exactly how events end up in a buffer nothing else drains. This module reads
 * the same `resolveProjectDir()` for the same reason. (The detached server this
 * replaced DID prime its own context, because it never went through `Cli.ts`.)
 *
 * Consent is honored entirely by the shared helper this wraps: an opted-out
 * install has a disabled context (so `trackAs` no-ops) and `flushTelemetryNow`
 * clears the buffer instead of sending it. Everything here is best-effort and
 * never throws — telemetry must not keep the server from serving.
 */

import { resolveProjectDir } from "../core/ProjectDir.js";
import { flushTelemetryNow } from "../core/TelemetryStartup.js";
import { createLogger } from "../Logger.js";

const log = createLogger("ServerTelemetry");

/** Default periodic flush cadence for the long-lived server. */
export const DEFAULT_SERVER_FLUSH_MS = 60_000;

/**
 * Per-flush network cap. Well under the flusher's 10 s default: the final flush
 * runs on the Ctrl+C path, and a slow network must not hold the user's terminal
 * for ten seconds after they asked for it back. A dropped batch is best-effort
 * and recovered on the next run.
 */
export const SERVER_FLUSH_TIMEOUT_MS = 2_000;

export interface ServerTelemetryDeps {
	/** Flush the buffer once. Defaults to the real `flushTelemetryNow`. */
	readonly flush?: (cwd: string) => Promise<void>;
	/** Periodic flush cadence. Defaults to {@link DEFAULT_SERVER_FLUSH_MS}. */
	readonly flushIntervalMs?: number;
	/** Buffer directory. Defaults to `resolveProjectDir()` — the one `Cli.ts` primed. */
	readonly cwd?: string;
}

export interface ServerTelemetryHandle {
	/** Clears the flush timer and does one final best-effort flush. Idempotent. */
	readonly stop: () => Promise<void>;
}

/**
 * Starts the periodic flush. Never throws. The returned `stop` clears the timer
 * and flushes once more, so a clean shutdown ships what the last interval did
 * not.
 */
export async function startServerTelemetry(deps: ServerTelemetryDeps = {}): Promise<ServerTelemetryHandle> {
	const cwd = deps.cwd ?? resolveProjectDir();
	const flush = deps.flush ?? ((c: string) => flushTelemetryNow(c, { timeoutMs: SERVER_FLUSH_TIMEOUT_MS }));
	const intervalMs = deps.flushIntervalMs ?? DEFAULT_SERVER_FLUSH_MS;

	const timer = setInterval(() => {
		void flush(cwd).catch((err: unknown) => log.warn("periodic telemetry flush failed: %s", String(err)));
	}, intervalMs);
	// Never let the flush timer keep the event loop (or a test runner) alive —
	// the listening socket is what holds this process open.
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

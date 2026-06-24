/**
 * Jolli trace context — ambient correlation id for logs and outbound HTTP.
 *
 * A uniform `traceId` ties together every log line and backend request
 * belonging to one logical operation (a commit's summarize/consolidate run, a
 * sync round, a CLI command), and propagates to the Jolli backend for
 * cross-process / cross-service correlation.
 *
 * This module is the single source of trace state. It is inlined into the
 * VS Code extension bundle (esbuild pulls in `cli/src/**`), so the extension
 * host and the CLI share one implementation.
 *
 * Propagation has two layers because the work spans multiple OS processes:
 *  - In-process: an `AsyncLocalStorage` scope set by `runWithTrace` makes the
 *    id ambient, so `Logger` and the HTTP call sites can read it without
 *    threading a parameter through every function.
 *  - Cross-process: two channels feed the same `runWithTrace` adoption.
 *    1. The persisted `GitOperation` queue entry (`op.traceId`) is the system
 *       of record for hook→worker handoff: the worker adopts it per entry, so
 *       a commit's summarize/consolidate work keeps the enqueuing hook's id.
 *    2. The `JOLLI_TRACE_ID` env var carries the ambient id to a directly
 *       spawned child: `launchWorker` stamps it onto the detached worker so the
 *       worker's *process-level* logs (startup, lock, chain-spawn) share the
 *       enqueuer's id, and any external orchestrator that spawns `jolli` /
 *       a git hook can seed a trace the same way. The receiving entry point
 *       (`Cli.ts`, the hooks, the worker `main`) seeds `runWithTrace` from it.
 *
 * Outbound header presence is uniform across all three ports: every backend
 * request carries `x-jolli-trace`. Inside an operation scope it carries that
 * operation's id; outside any scope the call site mints a fresh standalone
 * value (`newTraceHeader`) rather than omitting the header — so every request
 * is traceable. The `<spanId>` segment is a flat per-request marker (a fresh
 * id per outbound call); there is no client-side span hierarchy — correlation
 * is by `traceId`, and the backend owns any span tree it builds.
 *
 * Wire contract — deliberately **Jolli-private, not W3C**: the header is
 * `x-jolli-trace` (NOT the W3C-reserved `traceparent`, which standards-aware
 * middleboxes would try to parse) and the value is `<traceId>-<spanId>` (no
 * `00-` version byte, no `-01` trace-flags — both are constant / never consulted
 * in our closed loop). This MUST stay byte-for-byte in lockstep with the backend
 * (`jolli-common` `TraceContext.ts` `TRACE_HEADER_NAME` / `parseTraceparent`)
 * and the IntelliJ Kotlin port (`core/TraceContext.kt`) — same spirit as the
 * `parseJolliApiKey` lockstep rule.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/** Env var carrying the trace id to a directly-spawned child process. */
export const TRACE_ID_ENV = "JOLLI_TRACE_ID";

/** HTTP header carrying the Jolli trace context. Matches backend `TRACE_HEADER_NAME`. */
export const TRACE_HEADER_NAME = "x-jolli-trace";

/** Matches a trace id: 32 lowercase hex chars (16 bytes). */
const TRACE_ID_RE = /^[0-9a-f]{32}$/;

/** All-zero trace id — the invalid sentinel the backend rejects; never adopt or emit it. */
const INVALID_TRACE_ID = "0".repeat(32);

/** True for a 32-hex trace id that is not the all-zero sentinel. */
function isValidTraceId(id: string): boolean {
	return TRACE_ID_RE.test(id) && id !== INVALID_TRACE_ID;
}

interface TraceStore {
	readonly traceId: string;
}

const storage = new AsyncLocalStorage<TraceStore>();

/**
 * Generates a trace id: 16 random bytes rendered as 32 lowercase hex. Loops on
 * the astronomically unlikely all-zero result, which the backend rejects as the
 * invalid sentinel.
 */
export function generateTraceId(): string {
	return randomNonZeroHex(16);
}

/** Generates a span id: 8 random bytes rendered as 16 lowercase hex (never all-zero). */
export function generateSpanId(): string {
	return randomNonZeroHex(8);
}

/** Random `byteCount` bytes as lowercase hex, regenerating on the all-zero result. */
function randomNonZeroHex(byteCount: number): string {
	const allZero = "0".repeat(byteCount * 2);
	while (true) {
		const hex = randomBytes(byteCount).toString("hex");
		if (hex !== allZero) {
			return hex;
		}
	}
}

/**
 * Builds a Jolli trace header value: `<traceId>-<spanId>`. Jolli-private
 * 2-segment shape (no W3C `00-` version / `-01` flags) carried on the
 * `x-jolli-trace` header.
 */
export function buildTraceHeader(traceId: string, spanId: string): string {
	return `${traceId}-${spanId}`;
}

/**
 * Runs `fn` inside a trace scope. `traceId` is the id to adopt — when omitted
 * (or not a well-formed trace id) a fresh one is generated. Returns whatever
 * `fn` returns; nested calls override the id for their own subtree.
 */
export function runWithTrace<T>(traceId: string | undefined, fn: () => T): T {
	const id = traceId && isValidTraceId(traceId) ? traceId : generateTraceId();
	return storage.run({ traceId: id }, fn);
}

/**
 * Runs `fn` with NO ambient trace, even when called inside a `runWithTrace`
 * scope — `getCurrentTraceId()` returns `undefined` for its duration. Use when
 * spawning work that is deliberately *not* part of the current operation (e.g.
 * waking a queued worker for a different repo) so the current trace id does not
 * leak into it. Built on `AsyncLocalStorage.exit`.
 */
export function runWithoutTrace<T>(fn: () => T): T {
	return storage.exit(fn);
}

/** Returns the ambient trace id, or `undefined` outside any `runWithTrace` scope. */
export function getCurrentTraceId(): string | undefined {
	return storage.getStore()?.traceId;
}

/**
 * Returns an `x-jolli-trace` value for the ambient trace with a fresh span id
 * (each outbound request is its own client span), or `undefined` when no trace
 * is active so callers can omit the header.
 *
 * Use this from code running inside a `runWithTrace` scope (hooks, the queue
 * worker, sync rounds, CLI commands) so the request joins that operation's
 * trace. Standalone one-shot callers with no ambient operation should use
 * `newTraceHeader()` instead.
 */
export function currentTraceHeader(): string | undefined {
	const traceId = getCurrentTraceId();
	return traceId ? buildTraceHeader(traceId, generateSpanId()) : undefined;
}

/**
 * Returns a fresh `x-jolli-trace` value (new trace id + span id) for a single,
 * standalone outbound request. For callers that are not part of a larger
 * ambient operation — e.g. the VS Code one-shot push / API calls — where there
 * is nothing to correlate beyond the request itself.
 */
export function newTraceHeader(): string {
	return buildTraceHeader(generateTraceId(), generateSpanId());
}

/**
 * Resolves the trace id a freshly-started process should adopt: the
 * `JOLLI_TRACE_ID` env var if a parent passed one, else `undefined` so the
 * caller generates a new id. Centralizes the env-var contract.
 */
export function traceIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const fromEnv = env[TRACE_ID_ENV];
	return fromEnv && isValidTraceId(fromEnv) ? fromEnv : undefined;
}

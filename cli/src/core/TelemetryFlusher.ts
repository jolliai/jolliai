/**
 * TelemetryFlusher — drains the on-disk telemetry buffer to the jolli backend
 * (JOLLI-1785 Phase 2). Batched, fire-and-forget, and best-effort:
 *
 *   - POSTs to `<origin>/api/telemetry/events` in chunks of at most
 *     `maxBatch` (the backend enforces its own `TELEMETRY_MAX_BATCH` cap, so
 *     we chunk below it). HTTP scaffolding mirrors `sync/BackendClient.ts`:
 *     `x-jolli-client` header, injected `fetchImpl` test seam, `AbortController`
 *     timeout.
 *   - **Anonymous vs signed-in**: when a `jolliApiKey` is supplied it is sent
 *     as `Authorization: Bearer …` and the request targets the key's tenant
 *     origin — the backend decodes `account_id` from the key (the endpoint is
 *     mounted before tenant middleware, so anonymous requests with no key are
 *     accepted and stored with `account_id = null`).
 *   - **Never throws, keeps events on failure**: a non-2xx or network error
 *     stops the drain and leaves the un-acked events in the buffer for the
 *     next flush. Only the ring cap (`MAX_EVENTS`, drop-oldest) ever discards.
 *     The post-send rewrite re-reads the buffer and removes the acked envelopes
 *     by identity (not by count), so events appended concurrently (by a
 *     `track()` during the flush) are preserved even if the ring cap trimmed
 *     the buffer head mid-flush.
 *
 * Wire contract: body is `{ "events": TelemetryEnvelope[] }`, matching the
 * backend `TelemetryRouter` batch schema; a 204 (or any 2xx) is success.
 */
import { JOLLI_CLIENT_HEADER } from "./ClientHeader.js";
import { assertJolliOriginAllowed, parseJolliApiKey } from "./JolliApiUtils.js";
import { readTelemetryEvents, replaceTelemetryEvents, type TelemetryEnvelope } from "./TelemetryBuffer.js";

const TELEMETRY_PATH = "/api/telemetry/events";
const DEFAULT_TIMEOUT_MS = 10_000;
/** Conservative client-side chunk size; the backend caps server-side too. */
export const DEFAULT_MAX_BATCH = 100;

export interface FlushOptions {
	/** Project dir whose telemetry buffer is drained. */
	readonly cwd: string;
	/** Base origin to POST to when anonymous (e.g. the configured `jolliUrl`). */
	readonly origin?: string;
	/** When present and decodable, sent as Bearer and overrides the origin with the key's tenant URL. */
	readonly jolliApiKey?: string;
	/** Test seam — defaults to global `fetch`. */
	readonly fetchImpl?: typeof fetch;
	readonly timeoutMs?: number;
	readonly maxBatch?: number;
}

export interface FlushResult {
	readonly sent: number;
	readonly remaining: number;
}

/**
 * Flush buffered telemetry. Resolves with how many events were acked and how
 * many remain. Designed to be called fire-and-forget from the QueueWorker
 * drain / process exit (CLI) and the 60s sidebar tick (VS Code).
 */
export async function flushTelemetry(opts: FlushOptions): Promise<FlushResult> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBatch = Math.max(1, opts.maxBatch ?? DEFAULT_MAX_BATCH);

	// Resolve the target origin + optional bearer. A signed-in key targets its
	// own tenant origin; an undecodable key falls back to anonymous.
	let origin = opts.origin;
	let authKey: string | undefined;
	if (opts.jolliApiKey) {
		const meta = parseJolliApiKey(opts.jolliApiKey);
		if (meta) {
			origin = meta.u;
			authKey = opts.jolliApiKey;
		}
	}

	const events = await readTelemetryEvents(opts.cwd);
	if (events.length === 0) return { sent: 0, remaining: 0 };
	if (!origin) return { sent: 0, remaining: events.length };

	// Defense-in-depth: never POST telemetry (or a Bearer key) to a non-Jolli
	// host. Save-time validation already screens config, but the flusher
	// re-derives origin from raw config in a detached worker, so re-assert the
	// HTTPS + allowlist boundary here — consistent with the repo's SSRF posture.
	try {
		assertJolliOriginAllowed(origin);
	} catch {
		return { sent: 0, remaining: events.length };
	}

	let url: string;
	try {
		url = new URL(TELEMETRY_PATH, origin).toString();
	} catch {
		return { sent: 0, remaining: events.length };
	}

	let sent = 0;
	for (let i = 0; i < events.length; i += maxBatch) {
		const batch = events.slice(i, i + maxBatch);
		const ok = await postBatch(url, batch, authKey, fetchImpl, timeoutMs);
		if (!ok) break;
		sent += batch.length;
	}

	if (sent === 0) return { sent: 0, remaining: events.length };

	// Re-read so events appended during the flush survive, then remove the exact
	// envelopes we acked by identity rather than by count: under the ring cap a
	// concurrent append can trim the buffer head, so a positional `slice(sent)`
	// would discard the wrong (newest) events. Identity removal is correct
	// regardless of trimming and tolerant of acked events already dropped by the cap.
	const current = await readTelemetryEvents(opts.cwd);
	const remaining = removeAcked(current, events.slice(0, sent));
	await replaceTelemetryEvents(opts.cwd, remaining);
	return { sent, remaining: remaining.length };
}

/**
 * Return `current` with the acked envelopes removed by identity (first match
 * per duplicate), preserving order. Matching is on the serialized envelope, so
 * a head-trim by the ring cap during the flush can't cause the wrong events to
 * be dropped — acked events already gone from `current` are simply skipped.
 */
function removeAcked(current: readonly TelemetryEnvelope[], acked: readonly TelemetryEnvelope[]): TelemetryEnvelope[] {
	const counts = new Map<string, number>();
	for (const e of acked) {
		const key = JSON.stringify(e);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const out: TelemetryEnvelope[] = [];
	for (const e of current) {
		const key = JSON.stringify(e);
		const n = counts.get(key) ?? 0;
		if (n > 0) {
			counts.set(key, n - 1);
		} else {
			out.push(e);
		}
	}
	return out;
}

async function postBatch(
	url: string,
	batch: readonly TelemetryEnvelope[],
	authKey: string | undefined,
	fetchImpl: typeof fetch,
	timeoutMs: number,
): Promise<boolean> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"x-jolli-client": JOLLI_CLIENT_HEADER,
	};
	if (authKey) headers.Authorization = `Bearer ${authKey}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchImpl(url, {
			method: "POST",
			headers,
			body: JSON.stringify({ events: batch }),
			signal: controller.signal,
		});
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

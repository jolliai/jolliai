/**
 * LLM Client -- Plugin-side routing layer
 *
 * Routes LLM calls based on available credentials:
 * 1. Direct mode: Anthropic API key present -> local SDK call
 * 2. Proxy mode: Jolli API key present -> POST to backend, receive text + tokens
 * 3. Neither -> throw error
 */

import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "../Logger.js";
import type { LlmCredentialSource } from "../Types.js";
import { JOLLI_CLIENT_HEADER } from "./ClientHeader.js";
import { parseBaseUrl, parseJolliApiKey } from "./JolliApiUtils.js";
import { fillTemplate, findUnfilledPlaceholders, TEMPLATES } from "./PromptTemplates.js";
import { resolveModelId } from "./Summarizer.js";

// Re-export so existing imports of LlmCredentialSource from this module keep
// working — the source-of-truth definition lives in Types.ts because
// LlmCallMetadata references it (Types → LlmClient would cycle).
export type { LlmCredentialSource } from "../Types.js";

/** Module-level cache: reuse Anthropic client instances keyed by API key */
const clientCache = new Map<string, Anthropic>();

/** Returns a cached Anthropic client for the given API key. */
function getOrCreateClient(apiKey: string): Anthropic {
	let client = clientCache.get(apiKey);
	if (!client) {
		client = new Anthropic({ apiKey });
		clientCache.set(apiKey, client);
	}
	return client;
}

const log = createLogger("LlmClient");

/**
 * Flattens an Error's `cause` chain into a single line for logging.
 *
 * Node's undici fetch wraps transport-layer failures in a TypeError("fetch failed")
 * and stashes the actual reason (DNS, TLS, ECONNREFUSED, ETIMEDOUT, ECONNRESET, ...)
 * in `error.cause`, sometimes nested two levels deep. Logging only `error.message`
 * leaves operators with "fetch failed" and no way to diagnose. This helper extracts
 * Node syscall fields (code/errno/syscall/hostname/address/port) plus name/message,
 * and recurses when the cause itself has a cause.
 */
function formatCause(cause: unknown): string {
	if (cause == null) return "(none)";
	if (!(cause instanceof Error)) return String(cause);
	const fields: string[] = [];
	if (cause.name && cause.name !== "Error") fields.push(`name=${cause.name}`);
	if (cause.message) fields.push(`message=${cause.message}`);
	for (const key of ["code", "errno", "syscall", "hostname", "address", "port"] as const) {
		const value = (cause as unknown as Record<string, unknown>)[key];
		if (value !== undefined) fields.push(`${key}=${String(value)}`);
	}
	const inner = (cause as { cause?: unknown }).cause;
	if (inner !== undefined) fields.push(`cause=[${formatCause(inner)}]`);
	return fields.join(" ") || "(empty)";
}

/**
 * Backend route path for LLM proxy requests.
 * Must stay in sync with the route mounted in backend/src/router/LlmProxyRouter.ts.
 */
const LLM_PROXY_PATH = "/api/push/llm/complete";

/**
 * End-to-end timeout for proxy LLM calls (covers connect + headers + body).
 * The backend invokes Anthropic non-streaming inside this request, so 180s is
 * generous for a full LLM round-trip while bounding how long a stuck request
 * can hold the QueueWorker file lock. Moved in lockstep with
 * `DIRECT_FETCH_TIMEOUT_MS` so both paths share one wall-clock budget.
 * Exported so a regression test can pin the value.
 */
export const PROXY_FETCH_TIMEOUT_MS = 180_000;

/**
 * End-to-end timeout for direct Anthropic API calls. The SDK's `fetch` has
 * no default deadline, so a half-open TCP connection (firewall blackhole,
 * silently-dropped packets on a flaky network, suspended cloud-edge) would
 * hold the in-flight LLM call indefinitely — observed in production
 * holding a SyncEngine `ConflictResolver.resolveAll` for 2+ hours and
 * leaving the sidebar's "Sorting out conflicts…" label up the whole time.
 * 180 s matches the proxy path and is sized for the largest prompts the engine
 * sends — notably a regenerate of a large squash commit, which aggregates the
 * whole tree's transcripts + diff into one non-streaming request and was being
 * aborted mid-flight at the previous 120 s ceiling ("Request was aborted.").
 * The extra headroom still fails fast when the connection is genuinely wedged.
 * The QueueWorker refreshes its file lock every 60 s, so a call running this
 * long never loses the lock. Exported so a regression test can pin the value.
 */
export const DIRECT_FETCH_TIMEOUT_MS = 180_000;

/**
 * `max_tokens` above which a direct Anthropic call switches from non-streaming
 * `messages.create` to `messages.stream` (see the call site for the SDK's
 * "Streaming is strongly recommended" guard). Exported because callers tune
 * `maxTokens` *relative to this value* to force one path or the other — most
 * notably the ingest route call (`ROUTE_MAX_TOKENS`), which sits just above it
 * on purpose. Keeping it a shared constant means changing the threshold can't
 * silently flip a caller onto the other path's timeout behaviour.
 */
export const STREAMING_THRESHOLD_TOKENS = 16_384;

/**
 * Inactivity budget for the streaming direct path. Streaming is selected for
 * responses that may legitimately exceed `DIRECT_FETCH_TIMEOUT_MS` (a 64K merge
 * response can take many minutes), so a fixed wall-clock cap would kill valid
 * large responses. Instead the stream is aborted only when NO stream event
 * arrives within this window. Anthropic emits `ping` events throughout
 * generation, so a healthy-but-slow stream keeps resetting the timer while a
 * wedged / half-open socket (firewall blackhole, suspended cloud-edge, a
 * silently-dropped `ANTHROPIC_BASE_URL` relay) produces nothing and trips it.
 * This restores the fail-fast guarantee the non-streaming path has — a hung
 * streaming call can no longer hold the QueueWorker lock (or a SyncEngine
 * conflict resolve) indefinitely, the regression introduced when the streaming
 * branch dropped its `AbortSignal`. Exported so a regression test can pin it.
 */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

// `x-jolli-client` header value lives in `./ClientHeader.ts` so both this
// module and `cli/src/sync/BackendClient.ts` share one source of truth.
// Build-time `__JOLLI_CLIENT_KIND__` + `__PKG_VERSION__` resolution happens
// there. Tests stub those globals via `vi.stubGlobal` + `vi.resetModules`,
// and `JOLLI_CLIENT_HEADER` re-evaluates on re-import accordingly.

/**
 * LLM provider credentials and model selection.
 *
 * Two modes:
 * - Direct: provide `apiKey` to call the Anthropic API locally.
 * - Proxy:  provide `jolliApiKey` to route through the Jolli backend.
 *           The base URL is derived from the API key metadata.
 */
interface LlmCredentials {
	/** Anthropic API key for direct mode (falls back to ANTHROPIC_API_KEY env var) */
	readonly apiKey?: string;
	/** Model alias or full ID (e.g. "haiku", "sonnet") */
	readonly model?: string;
	/** Jolli Space API key for proxy mode (sk-jol-...) */
	readonly jolliApiKey?: string;
	/**
	 * Explicit user preference from Settings UI / config.json. When set, takes
	 * priority over the credential-presence precedence so the UI's "Provider"
	 * dropdown is actually authoritative — without this, picking "Jolli" while
	 * also having ANTHROPIC_API_KEY in config would silently route to Anthropic
	 * (the "Settings says Jolli, doctor says Anthropic" bug).
	 *
	 * Optional — legacy configs without this field fall through to the
	 * credential-presence precedence below.
	 */
	readonly aiProvider?: "anthropic" | "jolli";
}

/**
 * Resolves which credential source `callLlm` would use for these credentials,
 * or `null` if none are available.
 *
 * Must stay aligned with the dispatch logic in `callLlm` — and it does, because
 * `callLlm` itself routes through this function.
 *
 * Resolution order:
 *   1. **Explicit `aiProvider` choice** (Settings UI / config.json). When set,
 *      only the matching credential is considered. If that credential is
 *      missing, returns `null` rather than silently falling back to the other
 *      provider — silent cross-provider fallback was the root cause of the
 *      "Settings says Jolli, doctor reports Anthropic" mismatch.
 *   2. **Legacy precedence** (apiKey > ANTHROPIC_API_KEY env > jolliApiKey),
 *      used when `aiProvider` is undefined so existing configs continue to
 *      work unchanged.
 */
export function resolveLlmCredentialSource(
	credentials: Pick<LlmCredentials, "apiKey" | "jolliApiKey" | "aiProvider">,
): LlmCredentialSource | null {
	if (credentials.aiProvider === "jolli") {
		return credentials.jolliApiKey ? "jolli-proxy" : null;
	}
	if (credentials.aiProvider === "anthropic") {
		if (credentials.apiKey) return "anthropic-config";
		if (process.env.ANTHROPIC_API_KEY) return "anthropic-env";
		return null;
	}
	if (credentials.apiKey) return "anthropic-config";
	if (process.env.ANTHROPIC_API_KEY) return "anthropic-env";
	if (credentials.jolliApiKey) return "jolli-proxy";
	return null;
}

/** Options for making an LLM call */
export interface LlmCallOptions extends LlmCredentials {
	/** Template key (e.g. "summarize", "commit-message") */
	readonly action: string;
	/** Params to fill {{placeholder}} tokens in the template */
	readonly params: Record<string, string>;
	/** Max output tokens (direct mode only, default 8192) */
	readonly maxTokens?: number;
	/** Optional prompt revision to pin (proxy mode only) */
	readonly version?: number;
}

/** Result from an LLM call */
export interface LlmCallResult {
	/** Raw LLM text output */
	readonly text?: string;
	/** Actual model ID used (e.g. "claude-sonnet-4-6"); undefined in proxy mode */
	readonly model?: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly apiLatencyMs: number;
	/** Stop reason from the API (e.g. "end_turn"); undefined in proxy mode */
	readonly stopReason?: string | null;
	/**
	 * Which credential source produced this result. Populated by `callLlm`
	 * from the same `resolveLlmCredentialSource` call that picked the path,
	 * so it's authoritative — callers shouldn't try to re-derive it.
	 * Persisted into `LlmCallMetadata.source` for traceability of past summaries.
	 */
	readonly source: LlmCredentialSource;
}

/**
 * Routes an LLM call to either the Anthropic SDK (direct) or the Jolli backend (proxy).
 */
export async function callLlm(options: LlmCallOptions): Promise<LlmCallResult> {
	const source = resolveLlmCredentialSource(options);

	// Single dispatch-site log so every call leaves a "which provider was used"
	// trace, regardless of mode. Unifies what was previously asymmetric: only
	// proxy mode logged on success (`callProxy` line below), direct mode was
	// silent unless it errored. With this log, users can grep `debug.log`
	// after a commit to verify Settings UI's provider choice was honored
	// end-to-end. Skipped when source is null because the next switch branch
	// throws "No LLM provider available" — no provider was actually used.
	if (source) {
		log.info("LLM call: action=%s source=%s", options.action, source);
	}

	switch (source) {
		case "anthropic-config":
			// resolveLlmCredentialSource returned "anthropic-config" → options.apiKey is set
			return callDirect(options, options.apiKey as string, source);
		case "anthropic-env":
			// resolveLlmCredentialSource returned "anthropic-env" → env var is set
			return callDirect(options, process.env.ANTHROPIC_API_KEY as string, source);
		case "jolli-proxy": {
			const jolliApiKey = options.jolliApiKey as string;
			const baseUrl = parseJolliApiKey(jolliApiKey)?.u;
			if (!baseUrl) {
				throw new Error("Could not derive Jolli site URL from API key. Please regenerate your Jolli API Key.");
			}
			return callProxy(options, baseUrl, source);
		}
		default:
			throw new LlmCredentialError();
	}
}

/**
 * User-facing message for the "no provider could be resolved" failure. Kept
 * exported so callers that need to render the message inline (status panels,
 * onboarding hints) don't duplicate the string.
 */
export const NO_LLM_PROVIDER_MESSAGE =
	"No LLM provider available. Set an Anthropic API key (ANTHROPIC_API_KEY) or configure a Jolli Space API key (jolliApiKey).";

/**
 * Thrown by `callLlm` when no provider can be resolved from the supplied
 * credentials and `aiProvider` choice. Identified via `instanceof` so
 * recognition survives any future tweak to `NO_LLM_PROVIDER_MESSAGE` (i18n,
 * prefixing, wrapping with action context) without silently breaking the
 * QueueWorker's "skip retry / placeholder writes" guard.
 */
export class LlmCredentialError extends Error {
	constructor(message: string = NO_LLM_PROVIDER_MESSAGE) {
		super(message);
		this.name = "LlmCredentialError";
	}
}

/**
 * True when `err` is the "no LLM provider available" failure — i.e. a
 * credential-config error that won't recover on retry. Callers use this to
 * skip retry loops and placeholder writes that would otherwise hide the
 * "fix your Settings" signal from the user.
 */
export function isLlmCredentialError(err: unknown): err is LlmCredentialError {
	return err instanceof LlmCredentialError;
}

/** Direct mode: call Anthropic SDK locally */
async function callDirect(
	options: LlmCallOptions,
	apiKey: string,
	source: LlmCredentialSource,
): Promise<LlmCallResult> {
	const entry = TEMPLATES.get(options.action);
	if (!entry) {
		throw new Error(`Unknown LLM action: "${options.action}". Available: ${[...TEMPLATES.keys()].join(", ")}`);
	}
	const missing = findUnfilledPlaceholders(entry.template, options.params);
	if (missing.length > 0) {
		log.warn("Direct LLM call has unfilled placeholders for action=%s: %s", options.action, missing.join(", "));
	}
	const prompt = fillTemplate(entry.template, options.params);

	const model = resolveModelId(options.model);
	const maxTokens = options.maxTokens ?? 8192;

	const client = getOrCreateClient(apiKey);
	const startTime = Date.now();

	// Anthropic SDK refuses non-streaming `messages.create` when the request's
	// estimated duration exceeds 10 minutes (sees `max_tokens` and the model's
	// output speed and errors out with "Streaming is strongly recommended").
	// Empirically the threshold lands around `max_tokens > ~20k` for the
	// current generation; cross it via `messages.stream` instead so any caller
	// (the merge path raised this to 64k) keeps working without a per-call
	// switch. `finalMessage()` resolves to the same `Anthropic.Message` shape
	// `messages.create` returns, so the downstream code is unchanged.
	const useStreaming = maxTokens > STREAMING_THRESHOLD_TOKENS;

	let response: Anthropic.Message;
	try {
		const body = {
			model,
			max_tokens: maxTokens,
			temperature: 0,
			messages: [{ role: "user" as const, content: prompt }],
		};
		if (useStreaming) {
			// A fixed `AbortSignal.timeout` would kill legitimate large responses
			// (streaming is selected *because* the call may exceed the non-streaming
			// budget, e.g. a 64K merge response). Guard with an INACTIVITY watchdog
			// instead: abort only when no stream event arrives within
			// STREAM_IDLE_TIMEOUT_MS. Anthropic emits `ping` events throughout
			// generation, so a healthy-but-slow stream keeps resetting the timer
			// while a wedged socket produces nothing and is aborted — restoring the
			// fail-fast guarantee without capping valid long responses.
			const stream = client.messages.stream(body);
			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			const armIdleWatchdog = (): void => {
				clearTimeout(idleTimer);
				idleTimer = setTimeout(() => stream.abort(), STREAM_IDLE_TIMEOUT_MS);
				// Never let the watchdog keep a CLI process alive past its work.
				idleTimer.unref?.();
			};
			armIdleWatchdog();
			stream.on("streamEvent", armIdleWatchdog);
			try {
				response = await stream.finalMessage();
			} finally {
				clearTimeout(idleTimer);
			}
		} else {
			// Hard cap on the in-flight HTTP request — see `DIRECT_FETCH_TIMEOUT_MS`.
			// AbortSignal.timeout fires once after the given delay; the SDK
			// surfaces it as an AbortError that the outer `catch` already
			// logs with `cause`, so a wedged socket fails fast instead of
			// holding the caller (e.g. `ConflictResolver.resolveAll`)
			// indefinitely.
			response = await client.messages.create(body, {
				signal: AbortSignal.timeout(DIRECT_FETCH_TIMEOUT_MS),
			});
		}
	} catch (err) {
		// Surface the effective baseURL so users can tell whether a 3rd-party relay
		// (e.g. an ANTHROPIC_BASE_URL override) returned the error versus Anthropic itself.
		// Also surface error.cause: undici wraps transport-layer reasons (DNS, TLS,
		// ECONNREFUSED, ECONNRESET, ETIMEDOUT) inside `cause`, so logging only the
		// outer message leaves "fetch failed" with no diagnostic information.
		const baseUrl = client.baseURL;
		const message = err instanceof Error ? err.message : String(err);
		const cause = err instanceof Error ? formatCause((err as { cause?: unknown }).cause) : "(non-error)";
		// model / maxTokens / promptChars / elapsedMs turn a wall-clock-timeout
		// abort ("Request was aborted." with cause=(none)) into something
		// actionable: they show how large the prompt was and how long the call
		// ran before aborting, so "prompt too big for the 180s budget" is
		// distinguishable from a genuinely wedged connection without re-running.
		const elapsedMs = Date.now() - startTime;
		log.error(
			"Direct LLM call failed: action=%s model=%s maxTokens=%d promptChars=%d elapsedMs=%d baseUrl=%s error=%s cause=%s",
			options.action,
			model,
			maxTokens,
			prompt.length,
			elapsedMs,
			baseUrl,
			message,
			cause,
		);
		throw new Error(`LLM direct request to ${baseUrl} failed: ${message}`);
	}

	const elapsed = Date.now() - startTime;

	const textBlock = response.content.find((block) => block.type === "text");
	if (!textBlock || textBlock.type !== "text") {
		throw new Error("No text content in API response");
	}

	return {
		text: textBlock.text.trim(),
		model: response.model,
		inputTokens: response.usage.input_tokens,
		outputTokens: response.usage.output_tokens,
		apiLatencyMs: elapsed,
		stopReason: response.stop_reason,
		source,
	};
}

/** Proxy mode: POST structured request to Jolli backend */
async function callProxy(
	options: LlmCallOptions,
	baseUrl: string,
	source: LlmCredentialSource,
): Promise<LlmCallResult> {
	const { jolliApiKey } = options;
	/* v8 ignore start -- callProxy is only reached via callLlm which already guards jolliApiKey */
	if (!jolliApiKey) {
		throw new Error("Proxy mode requires jolliApiKey");
	}
	/* v8 ignore stop */

	const parsed = parseBaseUrl(baseUrl);
	const keyMeta = parseJolliApiKey(jolliApiKey);
	const orgSlug = keyMeta?.o;
	// Tenant slug from URL path (dev path-based) or API key metadata
	const tenantSlug = parsed.tenantSlug ?? keyMeta?.t;

	// Tenant is resolved via X-Jolli-Tenant header, not path — the path is always the same.
	const url = `${parsed.origin}${LLM_PROXY_PATH}`;

	// Resolve the version to send to the proxy:
	// 1. Caller-supplied `options.version` wins (used for pinning to a specific
	//    revision in tests / debug scenarios).
	// 2. Otherwise auto-inject the version from the TEMPLATES entry. This is the
	//    normal path — every action has a known version baked into the CLI build.
	// 3. If neither is present (action unknown to TEMPLATES — should be unreachable
	//    given direct mode validates the same map), omit `version` so the backend
	//    falls back to its max-revision lookup.
	const templateEntry = TEMPLATES.get(options.action);
	const versionToSend = options.version ?? templateEntry?.version;

	const body = JSON.stringify({
		action: options.action,
		params: options.params as Record<string, unknown>,
		...(versionToSend !== undefined ? { version: versionToSend } : {}),
	});

	log.info("Proxy LLM call: action=%s url=%s", options.action, url);

	const startTime = Date.now();

	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${jolliApiKey}`,
				"x-jolli-client": JOLLI_CLIENT_HEADER,
				...(tenantSlug ? { "x-tenant-slug": tenantSlug } : {}),
				...(orgSlug ? { "x-org-slug": orgSlug } : {}),
			},
			body,
			signal: AbortSignal.timeout(PROXY_FETCH_TIMEOUT_MS),
		});
	} catch (err) {
		// Transport-layer failure (DNS, TLS handshake, connect, reset, timeout).
		// undici wraps the real reason in `cause` — without surfacing it the log
		// is just "fetch failed" and the operator has no way to diagnose.
		const message = err instanceof Error ? err.message : String(err);
		const cause = err instanceof Error ? formatCause((err as { cause?: unknown }).cause) : "(non-error)";
		log.error("Proxy LLM fetch failed: action=%s url=%s error=%s cause=%s", options.action, url, message, cause);
		throw err;
	}
	const elapsed = Date.now() - startTime;

	if (!response.ok) {
		const errorBody = await response.text();
		log.error("Proxy LLM error: status=%d body=%s", response.status, errorBody.substring(0, 500));
		throw new Error(`LLM proxy request failed with status ${response.status}: ${errorBody.substring(0, 200)}`);
	}

	const result = (await response.json()) as Record<string, unknown>;

	log.info("Proxy LLM response: action=%s latency=%dms", options.action, elapsed);

	/* v8 ignore start -- defensive: proxy response always includes token counts, ?? 0 is a safety net */
	return {
		text: result.text as string | undefined,
		inputTokens: (result.inputTokens as number) ?? 0,
		outputTokens: (result.outputTokens as number) ?? 0,
		apiLatencyMs: elapsed,
		source,
	};
	/* v8 ignore stop */
}

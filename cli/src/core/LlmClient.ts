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
import { parseBaseUrl, parseJolliApiKey } from "./JolliApiUtils.js";
import { fillTemplate, findUnfilledPlaceholders, TEMPLATES } from "./PromptTemplates.js";
import { resolveModelId } from "./Summarizer.js";

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
 * The backend invokes Anthropic non-streaming inside this request, so 120s is
 * generous for a full LLM round-trip while bounding how long a stuck request
 * can hold the QueueWorker file lock.
 */
const PROXY_FETCH_TIMEOUT_MS = 120_000;

/**
 * Value sent on every Jolli backend request as the `x-jolli-client` header so
 * the server can identify the caller and gate on min version per surface.
 *
 * The (kind, version) pair is resolved at build time:
 *  - kind comes from `__JOLLI_CLIENT_KIND__`, defined as `"cli"` by vite (CLI
 *    build) and `"vscode-plugin"` by esbuild (VSCode build).
 *  - version comes from `__PKG_VERSION__`, which each bundler already defines
 *    as the surface's own version — under VSCode that's the extension version
 *    (the surface the user installed and would upgrade), not the inlined CLI
 *    package version, which is what we want.
 *
 * This module is inlined into both the native CLI bundle and the VSCode
 * plugin's `dist/` (Cli.js + hook scripts), so reading the kind from a
 * build-time token is what lets a hook installed by the VSCode plugin
 * correctly self-identify as `vscode-plugin/<vscode-version>` instead of
 * `cli/...`. Tests stub these globals via `vi.stubGlobal`.
 */
/* v8 ignore start -- compile-time ternary: both globals are always defined in bundled builds */
const CLI_CLIENT_HEADER =
	typeof __JOLLI_CLIENT_KIND__ !== "undefined" && typeof __PKG_VERSION__ !== "undefined"
		? `${__JOLLI_CLIENT_KIND__}/${__PKG_VERSION__}`
		: "cli/dev";
/* v8 ignore stop */

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
}

/**
 * Which credential source `callLlm` will pick, in the same precedence order
 * the dispatcher uses. Exported so diagnostic tooling (e.g. `doctor`) can
 * report the exact source without re-implementing the precedence rules.
 */
export type LlmCredentialSource = "anthropic-config" | "anthropic-env" | "jolli-proxy";

/**
 * Resolves which credential source `callLlm` would use for these credentials,
 * or `null` if none are available.
 *
 * Must stay aligned with the dispatch logic in `callLlm` — and it does, because
 * `callLlm` itself routes through this function.
 */
export function resolveLlmCredentialSource(
	credentials: Pick<LlmCredentials, "apiKey" | "jolliApiKey">,
): LlmCredentialSource | null {
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
}

/**
 * Routes an LLM call to either the Anthropic SDK (direct) or the Jolli backend (proxy).
 */
export async function callLlm(options: LlmCallOptions): Promise<LlmCallResult> {
	const source = resolveLlmCredentialSource(options);

	switch (source) {
		case "anthropic-config":
			// resolveLlmCredentialSource returned "anthropic-config" → options.apiKey is set
			return callDirect(options, options.apiKey as string);
		case "anthropic-env":
			// resolveLlmCredentialSource returned "anthropic-env" → env var is set
			return callDirect(options, process.env.ANTHROPIC_API_KEY as string);
		case "jolli-proxy": {
			const jolliApiKey = options.jolliApiKey as string;
			const baseUrl = parseJolliApiKey(jolliApiKey)?.u;
			if (!baseUrl) {
				throw new Error("Could not derive Jolli site URL from API key. Please regenerate your Jolli API Key.");
			}
			return callProxy(options, baseUrl);
		}
		default:
			throw new Error(
				"No LLM provider available. Set an Anthropic API key (ANTHROPIC_API_KEY) or configure a Jolli Space API key (jolliApiKey).",
			);
	}
}

/** Direct mode: call Anthropic SDK locally */
async function callDirect(options: LlmCallOptions, apiKey: string): Promise<LlmCallResult> {
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

	let response: Anthropic.Message;
	try {
		response = await client.messages.create({
			model,
			max_tokens: maxTokens,
			temperature: 0,
			messages: [{ role: "user", content: prompt }],
		});
	} catch (err) {
		// Surface the effective baseURL so users can tell whether a 3rd-party relay
		// (e.g. an ANTHROPIC_BASE_URL override) returned the error versus Anthropic itself.
		// Also surface error.cause: undici wraps transport-layer reasons (DNS, TLS,
		// ECONNREFUSED, ECONNRESET, ETIMEDOUT) inside `cause`, so logging only the
		// outer message leaves "fetch failed" with no diagnostic information.
		const baseUrl = client.baseURL;
		const message = err instanceof Error ? err.message : String(err);
		const cause = err instanceof Error ? formatCause((err as { cause?: unknown }).cause) : "(non-error)";
		log.error(
			"Direct LLM call failed: action=%s baseUrl=%s error=%s cause=%s",
			options.action,
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
	};
}

/** Proxy mode: POST structured request to Jolli backend */
async function callProxy(options: LlmCallOptions, baseUrl: string): Promise<LlmCallResult> {
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
				"x-jolli-client": CLI_CLIENT_HEADER,
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
	};
	/* v8 ignore stop */
}

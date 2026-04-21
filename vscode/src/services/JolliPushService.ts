/**
 * JolliPushService
 *
 * HTTP client for pushing JolliMemory commit summaries to a Jolli Space.
 * Authenticates via API key (Bearer token) and posts Markdown content
 * to the `/api/push/jollimemory` endpoint.
 *
 * Uses Node.js http/https modules instead of fetch to support self-signed
 * certificates in local development environments.
 *
 * Handles two URL patterns for multi-tenant support:
 * - Path-based (dev): "https://jolli-local.me/test1/" → calls /api/push/... with X-Tenant-Slug header
 * - Subdomain-based (prod): "https://test1.jolli.ai" → subdomain resolved by backend
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** Thrown when the server rejects the request due to outdated plugin version (HTTP 426). */
export class PluginOutdatedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PluginOutdatedError";
	}
}

/** Payload sent to the Jolli push endpoint */
export interface JolliPushPayload {
	readonly title: string;
	readonly content: string;
	readonly commitHash: string;
	readonly branch?: string;
	/** Optional subfolder name under the push target folder (e.g. "Plans") */
	readonly subFolder?: string;
	/** Server-side document ID for direct update on subsequent pushes. */
	readonly docId?: number;
	/** Plugin version string (e.g. "0.87.1"). Sent for server-side version gate. */
	readonly pluginVersion?: string;
}

/** Response from a successful push */
export interface JolliPushResult {
	readonly url: string;
	readonly docId: number;
	readonly jrn: string;
	readonly created: boolean;
}

/**
 * Parsed base URL with optional tenant slug extracted from the path.
 *
 * Path-based: "https://jolli-local.me/test1/" → origin "https://jolli-local.me", tenantSlug "test1"
 * Subdomain:  "https://test1.jolli.ai"       → origin "https://test1.jolli.ai", tenantSlug undefined
 */
interface ParsedBaseUrl {
	/** The origin without any path prefix (e.g. "https://jolli-local.me") */
	readonly origin: string;
	/** Tenant slug extracted from the first path segment, if present */
	readonly tenantSlug: string | undefined;
}

/**
 * Extracts the origin and optional tenant slug from a Jolli base URL.
 * If the URL has a non-empty path (e.g. "/test1/"), the first segment is the tenant slug.
 */
function parseBaseUrl(baseUrl: string): ParsedBaseUrl {
	const url = new URL(baseUrl);
	// Strip leading/trailing slashes and extract first segment
	const pathSegments = url.pathname
		.replace(/^\/+|\/+$/g, "")
		.split("/")
		.filter(Boolean);
	return {
		origin: url.origin,
		tenantSlug: pathSegments.length > 0 ? pathSegments[0] : undefined,
	};
}

/**
 * Metadata embedded in a new-format Jolli API key.
 * - `t`: tenant slug (used as x-tenant-slug header for path-based tenants)
 * - `u`: full base URL (e.g., "https://ibm.jolli.ai" or "https://jolli.ai/ibm")
 * - `o`: org slug (used as x-org-slug header for multi-org routing; absent in old keys)
 */
export interface JolliApiKeyMeta {
	readonly t: string;
	readonly u: string;
	readonly o?: string;
}

/**
 * Parses the tenant metadata embedded in a new-format Jolli API key.
 *
 * New format: sk-jol-{base64url(JSON meta)}.{base64url(32 random bytes)}
 * Old format: sk-jol-{32 hex chars} — returns null
 *
 * @param key - Jolli API key string
 * @returns Parsed metadata, or null if the key uses the old format or cannot be decoded
 */
export function parseJolliApiKey(key: string): JolliApiKeyMeta | null {
	if (!key.startsWith("sk-jol-")) {
		return null;
	}
	const rest = key.slice("sk-jol-".length);
	const dotIndex = rest.indexOf(".");
	if (dotIndex === -1) {
		return null;
	}
	try {
		const metaJson = Buffer.from(rest.slice(0, dotIndex), "base64url").toString(
			"utf-8",
		);
		const meta = JSON.parse(metaJson) as Record<string, unknown>;
		if (typeof meta.t === "string" && typeof meta.u === "string") {
			return {
				t: meta.t,
				u: meta.u,
				...(typeof meta.o === "string" ? { o: meta.o } : {}),
			};
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Pushes a commit summary to a Jolli Space via the push API.
 *
 * @param baseUrl - Jolli site base URL. If undefined, falls back to the URL embedded in the API key.
 * @param apiKey - Jolli API key (sk-jol-...)
 * @param payload - Summary content to push
 * @returns Push result with article URL and metadata
 * @throws Error if the push fails (network error, non-2xx response, or missing base URL)
 */
export function pushToJolli(
	baseUrl: string | undefined,
	apiKey: string,
	payload: JolliPushPayload,
): Promise<JolliPushResult> {
	// Parse key metadata once — used for base URL fallback and org routing
	const keyMeta = parseJolliApiKey(apiKey);
	const resolvedBaseUrl = baseUrl ?? keyMeta?.u;
	if (!resolvedBaseUrl) {
		return Promise.reject(
			new Error(
				"Jolli site URL could not be determined. Please regenerate your Jolli API Key and set it again (STATUS panel → ...).",
			),
		);
	}
	const parsed = parseBaseUrl(resolvedBaseUrl);
	// Always call /api/push/jollimemory at the origin (without tenant path prefix)
	const targetUrl = new URL("/api/push/jollimemory", parsed.origin);
	const body = JSON.stringify(payload);
	const isHttps = targetUrl.protocol === "https:";

	// Build request headers
	const headers: Record<string, string | number> = {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(body),
		Authorization: `Bearer ${apiKey}`,
	};

	// For path-based multi-tenancy (e.g. /test1/), send the tenant slug as a header
	// so the backend TenantMiddleware can resolve the tenant without JWT or subdomain.
	if (parsed.tenantSlug) {
		headers["x-tenant-slug"] = parsed.tenantSlug;
	}

	// Send org slug so TenantMiddleware routes to the correct org schema.
	// Old keys without `o` omit this header, causing a fallback to the default org.
	if (keyMeta?.o) {
		headers["x-org-slug"] = keyMeta.o;
	}

	// Use http or https depending on the URL scheme.
	const requestFn = isHttps ? httpsRequest : httpRequest;

	return new Promise<JolliPushResult>((resolve, reject) => {
		const req = requestFn(
			targetUrl,
			{
				method: "POST",
				headers,
			},
			(res) => {
				const chunks: Array<Buffer> = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const raw = Buffer.concat(chunks).toString("utf-8");
					try {
						const json = JSON.parse(raw) as JolliPushResult & {
							error?: string;
							message?: string;
						};
						const status = res.statusCode ?? 0;
						if (status >= 200 && status < 300) {
							resolve(json);
						} else if (status === 426) {
							reject(
								new PluginOutdatedError(
									json.message ??
										"Plugin version is outdated. Please update to the latest version.",
								),
							);
						} else {
							reject(new Error(json.error ?? `HTTP ${status}`));
						}
					} catch {
						reject(
							new Error(
								`Invalid JSON response (HTTP ${res.statusCode}): ${raw.slice(0, 200)}`,
							),
						);
					}
				});
			},
		);

		req.on("error", (err) => {
			reject(new Error(`Network error: ${err.message}`));
		});

		req.write(body);
		req.end();
	});
}

/**
 * Deletes an orphaned JolliMemory article from the server.
 * Used to clean up articles from squashed/rebased commits.
 */
export function deleteFromJolli(
	baseUrl: string | undefined,
	apiKey: string,
	docId: number,
): Promise<void> {
	const keyMeta = parseJolliApiKey(apiKey);
	const resolvedBaseUrl = baseUrl ?? keyMeta?.u;
	if (!resolvedBaseUrl) {
		return Promise.reject(new Error("Jolli site URL could not be determined."));
	}
	const parsed = parseBaseUrl(resolvedBaseUrl);
	const targetUrl = new URL(`/api/push/jollimemory/${docId}`, parsed.origin);
	const isHttps = targetUrl.protocol === "https:";

	const headers: Record<string, string> = {
		Authorization: `Bearer ${apiKey}`,
	};
	if (parsed.tenantSlug) {
		headers["x-tenant-slug"] = parsed.tenantSlug;
	}
	if (keyMeta?.o) {
		headers["x-org-slug"] = keyMeta.o;
	}

	const requestFn = isHttps ? httpsRequest : httpRequest;
	const options: Record<string, unknown> = {
		method: "DELETE",
		hostname: targetUrl.hostname,
		port: targetUrl.port || (isHttps ? 443 : 80),
		path: targetUrl.pathname,
		headers,
	};

	return new Promise((resolve, reject) => {
		const req = requestFn(options, (res) => {
			// Consume response body
			res.resume();
			if (res.statusCode === 204 || res.statusCode === 200) {
				resolve();
			} else {
				reject(new Error(`Delete failed with status ${res.statusCode}`));
			}
		});
		req.on("error", (err) =>
			reject(new Error(`Network error: ${err.message}`)),
		);
		req.end();
	});
}

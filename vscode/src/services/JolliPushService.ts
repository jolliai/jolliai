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
 *
 * Implements the JOLLI-1335 push contract:
 * - Sends `x-jolli-client: <kind>/<version>` header (e.g. `vscode-plugin/1.2.3`)
 *   so the server can identify the caller, gate on version, and route through
 *   the per-repo binding flow without parsing the body. (Here `<kind>` is the
 *   *client* kind — distinct from the body's `docType` field below.)
 * - Sends `repoUrl` (canonical, normalized — see GitRemoteUtils) and
 *   `relativePath` (flat — `<branchSlug>` for all kinds) in the body so the
 *   server can place the doc under `repoFolder → branchSlug`.
 * - Sends `docType: "summary" | "plan" | "note"` in the body. With the flat
 *   path layout this is the sole disambiguator the server uses to set
 *   `sourceMetadata.docType` and route TreeItem icons on the frontend.
 * - Maps `412 binding_required` → `BindingRequiredError` and
 *   `409 binding_already_exists` → `BindingAlreadyExistsError` so the call
 *   site can run the chooser flow.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
	type JolliApiKeyMeta,
	parseBaseUrl,
	parseJolliApiKey,
} from "../../../cli/src/core/JolliApiUtils.js";
import { type ClientInfo, VSCODE_CLIENT_INFO } from "./ClientInfo.js";

export { parseJolliApiKey, type JolliApiKeyMeta, type ClientInfo };

/** Thrown when the server rejects the request due to outdated plugin version (HTTP 426). */
export class PluginOutdatedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PluginOutdatedError";
	}
}

/**
 * Thrown when the server returns 412 binding_required — the repo at `repoUrl`
 * has no JM space binding yet. The call site should run the chooser flow
 * (BindingChooserWebviewPanel), register a binding, and retry the push.
 */
export class BindingRequiredError extends Error {
	readonly repoUrl: string;
	constructor(repoUrl: string, message?: string) {
		super(message ?? `binding_required for ${repoUrl}`);
		this.name = "BindingRequiredError";
		this.repoUrl = repoUrl;
	}
}

/**
 * Thrown when a `POST /api/jolli-memory/bindings` collides with an existing
 * binding (server's `UNIQUE(org_id, repo_url)`). The body carries the winner's
 * binding info — the chooser uses it to resolve gracefully.
 */
export class BindingAlreadyExistsError extends Error {
	readonly winner: BindingExistsBody;
	constructor(body: BindingExistsBody, message?: string) {
		super(message ?? "binding_already_exists");
		this.name = "BindingAlreadyExistsError";
		this.winner = body;
	}
}

/** Body shape returned alongside `409 binding_already_exists`. */
export interface BindingExistsBody {
	readonly error: "binding_already_exists";
	readonly id?: number;
	readonly jmSpaceId?: number;
	readonly jmSpaceName?: string;
	readonly repoName?: string;
	readonly repoUrl?: string;
}

/** Payload sent to the Jolli push endpoint */
export interface JolliPushPayload {
	readonly title: string;
	readonly content: string;
	readonly commitHash: string;
	/**
	 * Document type — distinct from the *client* kind in `x-jolli-client`.
	 * With the flat per-branch layout, this is the sole disambiguator the
	 * server uses to set `sourceMetadata.docType` and to drive TreeItem icons.
	 * Required: a missing value would silently mis-tag every push.
	 */
	readonly docType: "summary" | "plan" | "note";
	readonly branch?: string;
	/** Server-side document ID for direct update on subsequent pushes. */
	readonly docId?: number;
	/** Canonical, normalized remote URL — server's identity key for the repo. */
	readonly repoUrl?: string;
	/** Folder chain below the repo folder — flat `<branchSlug>` for all docTypes. No leading `/`. */
	readonly relativePath?: string;
}

/** Response from a successful push */
export interface JolliPushResult {
	readonly url: string;
	readonly docId: number;
	readonly jrn: string;
	readonly created: boolean;
}

/** Body shape the server emits for non-2xx responses we explicitly handle. */
interface ErrorBody {
	error?: string;
	message?: string;
	repoUrl?: string;
}

/**
 * Builds the standard request headers for any Jolli Memory API call:
 * Authorization, Content-Type, Content-Length, the multi-tenant
 * `x-tenant-slug` / `x-org-slug` headers when applicable, and the
 * `x-jolli-client` header identifying this plugin (read once from
 * `package.json` via `VSCODE_CLIENT_INFO`).
 *
 * Shared between push (this file) and the new endpoints in JolliMemoryApiService.
 */
export function buildJolliApiHeaders(params: {
	apiKey: string;
	keyMeta: JolliApiKeyMeta | null;
	tenantSlug: string | undefined;
	bodyByteLength?: number;
}): Record<string, string | number> {
	const headers: Record<string, string | number> = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${params.apiKey}`,
		"x-jolli-client": `${VSCODE_CLIENT_INFO.kind}/${VSCODE_CLIENT_INFO.version}`,
	};
	if (params.bodyByteLength !== undefined) {
		headers["Content-Length"] = params.bodyByteLength;
	}
	if (params.tenantSlug) {
		headers["x-tenant-slug"] = params.tenantSlug;
	}
	if (params.keyMeta?.o) {
		headers["x-org-slug"] = params.keyMeta.o;
	}
	return headers;
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
	const targetUrl = new URL("/api/push/jollimemory", parsed.origin);
	const body = JSON.stringify(payload);
	const isHttps = targetUrl.protocol === "https:";

	const headers = buildJolliApiHeaders({
		apiKey,
		keyMeta,
		tenantSlug: parsed.tenantSlug,
		bodyByteLength: Buffer.byteLength(body),
	});

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
						const json = JSON.parse(raw) as JolliPushResult & ErrorBody;
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
						} else if (status === 412 && json.error === "binding_required") {
							reject(
								new BindingRequiredError(
									json.repoUrl ?? payload.repoUrl ?? "",
									json.message,
								),
							);
						} else if (
							status === 409 &&
							json.error === "binding_already_exists"
						) {
							reject(
								new BindingAlreadyExistsError(
									json as unknown as BindingExistsBody,
									json.message,
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

	const headers = buildJolliApiHeaders({
		apiKey,
		keyMeta,
		tenantSlug: parsed.tenantSlug,
	});

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

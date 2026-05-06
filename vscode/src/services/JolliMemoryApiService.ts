/**
 * JolliMemoryApiService
 *
 * HTTP client for the Jolli Memory endpoints the VS Code plugin needs
 * to support the JOLLI-1335 first-bind chooser flow:
 *
 *   - GET  /api/jolli-memory/spaces            -> list existing JM spaces
 *   - POST /api/jolli-memory/bindings          -> bind a repo to a JM space
 *
 * Creating, renaming, deleting, or moving spaces/bindings is intentionally
 * outside the plugin. Those governance-heavy flows live on the jolli.ai web
 * frontend; the IDE only binds the current repo to an existing space.
 *
 * Reuses `buildJolliApiHeaders` from JolliPushService for the standard
 * Authorization + multi-tenant headers, and uses node:http/https directly
 * (matching pushToJolli) so self-signed certs in local dev keep working.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { parseBaseUrl } from "../../../cli/src/core/JolliApiUtils.js";
import {
	BindingAlreadyExistsError,
	type BindingExistsBody,
	buildJolliApiHeaders,
	PluginOutdatedError,
	parseJolliApiKey,
} from "./JolliPushService.js";

/** Minimal JM space shape used by the chooser's existing-space list. */
export interface JmSpaceSummary {
	readonly id: number;
	readonly name: string;
	readonly slug: string;
}

/**
 * Result of `GET /api/jolli-memory/spaces`. Carries the listed spaces plus the
 * server-designated default space id (if any). The chooser uses
 * `defaultSpaceId` to pre-select the right radio option; relying on
 * `spaces[0]` would be brittle since the API does not guarantee order.
 * `defaultSpaceId` is `null` when the server omitted it (legacy / pre-default
 * envelopes) or returned a flat array body.
 */
export interface JmSpacesListResult {
	readonly spaces: ReadonlyArray<JmSpaceSummary>;
	readonly defaultSpaceId: number | null;
}

/**
 * Transient binding-info shape the chooser uses internally — never persisted.
 * Mirrors the body shape returned by `POST /api/jolli-memory/bindings` (or the
 * 409-conflict body for the loser of a race).
 */
export interface BindingInfo {
	readonly id: number;
	readonly jmSpaceId: number;
	readonly jmSpaceName: string;
	readonly repoName: string;
}

/** Internal: build the absolute URL + tenant slug for a Jolli Memory endpoint. */
function buildEndpoint(
	baseUrl: string,
	pathname: string,
): { url: URL; tenantSlug: string | undefined; isHttps: boolean } {
	const parsed = parseBaseUrl(baseUrl);
	const url = new URL(pathname, parsed.origin);
	return {
		url,
		tenantSlug: parsed.tenantSlug,
		isHttps: url.protocol === "https:",
	};
}

interface ResponseBody {
	error?: string;
	message?: string;
	[key: string]: unknown;
}

/**
 * Internal: dispatches an HTTP request and returns parsed JSON on 2xx.
 * Maps 426 → PluginOutdatedError and 409 binding_already_exists →
 * BindingAlreadyExistsError so callers don't repeat the same handling.
 */
function sendJson<T>(params: {
	url: URL;
	method: "GET" | "POST";
	headers: Record<string, string | number>;
	body?: string;
	isHttps: boolean;
}): Promise<T> {
	const { url, method, headers, body, isHttps } = params;
	const requestFn = isHttps ? httpsRequest : httpRequest;

	return new Promise<T>((resolve, reject) => {
		const req = requestFn(url, { method, headers }, (res) => {
			const chunks: Array<Buffer> = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf-8");
				let json: ResponseBody;
				try {
					json = raw.length > 0 ? (JSON.parse(raw) as ResponseBody) : {};
				} catch {
					reject(
						new Error(
							`Invalid JSON response (HTTP ${res.statusCode}): ${raw.slice(0, 200)}`,
						),
					);
					return;
				}

				const status = res.statusCode ?? 0;
				if (status >= 200 && status < 300) {
					resolve(json as unknown as T);
				} else if (status === 426) {
					reject(
						new PluginOutdatedError(
							json.message ??
								"Plugin version is outdated. Please update to the latest version.",
						),
					);
				} else if (status === 409 && json.error === "binding_already_exists") {
					reject(
						new BindingAlreadyExistsError(
							json as unknown as BindingExistsBody,
							typeof json.message === "string" ? json.message : undefined,
						),
					);
				} else {
					reject(new Error(json.error ?? `HTTP ${status}`));
				}
			});
		});

		req.on("error", (err) => {
			reject(new Error(`Network error: ${err.message}`));
		});

		if (body !== undefined) {
			req.write(body);
		}
		req.end();
	});
}

/**
 * GET /api/jolli-memory/spaces
 *
 * Accepts either a flat array body or a `{ spaces, defaultSpaceId }` envelope.
 * The flat-array form has no place to express a default, so `defaultSpaceId`
 * is reported as `null` in that case. When the envelope is present but
 * `defaultSpaceId` is missing or not a number, it is also coerced to `null` —
 * the chooser leaves every radio unchecked in that case (no `spaces[0]`
 * fallback) so the user is forced to make an explicit pick.
 */
export function listJolliMemorySpaces(
	baseUrl: string,
	apiKey: string,
): Promise<JmSpacesListResult> {
	const { url, tenantSlug, isHttps } = buildEndpoint(
		baseUrl,
		"/api/jolli-memory/spaces",
	);
	const headers = buildJolliApiHeaders({
		apiKey,
		keyMeta: parseJolliApiKey(apiKey),
		tenantSlug,
	});
	return sendJson<
		| {
				spaces: Array<JmSpaceSummary>;
				defaultSpaceId?: number | null;
		  }
		| Array<JmSpaceSummary>
	>({
		url,
		method: "GET",
		headers,
		isHttps,
	}).then((body) => {
		if (Array.isArray(body)) {
			return { spaces: body, defaultSpaceId: null };
		}
		const spaces = body.spaces ?? [];
		const defaultSpaceId =
			typeof body.defaultSpaceId === "number" ? body.defaultSpaceId : null;
		return { spaces, defaultSpaceId };
	});
}

/**
 * POST /api/jolli-memory/bindings
 * Throws BindingAlreadyExistsError on 409 — caller resolves with the winner.
 */
export function createJolliMemoryBinding(
	baseUrl: string,
	apiKey: string,
	params: {
		readonly repoUrl: string;
		readonly repoName: string;
		readonly jmSpaceId: number;
	},
): Promise<BindingInfo> {
	const { url, tenantSlug, isHttps } = buildEndpoint(
		baseUrl,
		"/api/jolli-memory/bindings",
	);
	const body = JSON.stringify(params);
	const headers = buildJolliApiHeaders({
		apiKey,
		keyMeta: parseJolliApiKey(apiKey),
		tenantSlug,
		bodyByteLength: Buffer.byteLength(body),
	});
	return sendJson<BindingInfo>({
		url,
		method: "POST",
		headers,
		body,
		isHttps,
	});
}

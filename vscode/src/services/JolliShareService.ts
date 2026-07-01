/**
 * JolliShareService
 *
 * HTTP client for the public branch-share feature. Three operations:
 *
 * - `createBranchShare` (sharer side, authed) — POST a branch snapshot
 *   (summary + plan + notes, never transcripts) and get back a public `shareUrl`.
 * - `revokeBranchShare` (sharer side, authed) — DELETE a share.
 * - `fetchSharedSnapshot` (recipient side, **login-free**) — GET a snapshot by
 *   token to render in the read-only share viewer. The token is the credential;
 *   no Authorization header is sent. The origin is validated against the Jolli
 *   allowlist before any request leaves the machine.
 *
 * Mirrors JolliPushService: Node http/https (not fetch) to tolerate self-signed
 * certs in local dev, and the shared `buildJolliApiHeaders` for authed calls.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
	assertJolliOriginAllowed,
	type JolliApiKeyMeta,
	parseBaseUrl,
	parseJolliApiKey,
} from "../../../cli/src/core/JolliApiUtils.js";
import type { LiveRef } from "../../../cli/src/core/BranchShareStore.js";
import { currentTraceHeader, newTraceHeader, TRACE_HEADER_NAME } from "../../../cli/src/core/TraceContext.js";
import { VSCODE_CLIENT_INFO } from "./ClientInfo.js";
import { buildJolliApiHeaders, PluginOutdatedError } from "./JolliPushService.js";

export { PluginOutdatedError };

/** Thrown when a share has been revoked or expired (HTTP 410 / `revoked: true`). */
export class ShareRevokedError extends Error {
	constructor(message?: string) {
		super(message ?? "This share has been stopped.");
		this.name = "ShareRevokedError";
	}
}

/** Snapshot scope — summary always, plans/notes opt-in, transcripts never (conversations stay local). */
export interface ShareScope {
	readonly summary: true;
	readonly plans: boolean;
	readonly notes: boolean;
	readonly transcripts: false;
}

/** Body posted to create/refresh a public share (branch or single commit). */
export interface BranchSharePayload {
	readonly repoUrl: string;
	readonly repoName: string;
	readonly branch: string;
	readonly branchSlug: string;
	/**
	 * "branch" → every commit's summary, organized by commit. "commit" → a single
	 * commit's summary. The server keys idempotency on this `kind` (commit shares
	 * additionally on `headCommitHash`), so a branch share and a commit share on
	 * the same branch are distinct resources with distinct tokens. The field name
	 * MUST be `kind` — the backend's zod schema strips unknown keys, so a misnamed
	 * field silently defaults to "branch" and collapses both onto one resource.
	 */
	readonly kind: "branch" | "commit";
	readonly headCommitHash: string;
	readonly commitHashes: ReadonlyArray<string>;
	readonly decisionCount: number;
	readonly scope: ShareScope;
	readonly content: string;
}

/** Response from a successful expiry update (PATCH). */
export interface ShareExpiryResult {
	readonly shareId: number | string;
	readonly expiresAt: string;
	readonly visibility: "public";
}

/** Response from a successful create. */
export interface BranchShareResult {
	/** Server share id — numeric in practice (auto-increment), but treated as opaque. */
	readonly shareId: number | string;
	readonly token: string;
	readonly shareUrl: string;
	readonly expiresAt: string;
	readonly visibility: "public";
}

/** Login-free snapshot returned to the recipient viewer. */
export interface SharedSnapshot {
	readonly branch: string;
	readonly repoName: string;
	readonly repoUrl?: string;
	readonly decisionCount: number;
	readonly headCommitHash: string;
	readonly generatedAt: string;
	readonly scope: {
		readonly summary: boolean;
		readonly plans: boolean;
		readonly notes: boolean;
		readonly transcripts: boolean;
	};
	readonly content: string;
	readonly revoked?: boolean;
}

interface ErrorBody {
	error?: string;
	message?: string;
}

/** Resolves the base URL from an explicit arg or the API key's embedded URL. */
function resolveBaseUrl(baseUrl: string | undefined, keyMeta: JolliApiKeyMeta | null): string | undefined {
	return baseUrl ?? keyMeta?.u;
}

/**
 * Creates (or refreshes, idempotent per repo+branch) a public branch share.
 * Returns the share URL and token.
 */
export function createBranchShare(
	baseUrl: string | undefined,
	apiKey: string,
	payload: BranchSharePayload,
): Promise<BranchShareResult> {
	const keyMeta = parseJolliApiKey(apiKey);
	const resolvedBaseUrl = resolveBaseUrl(baseUrl, keyMeta);
	if (!resolvedBaseUrl) {
		return Promise.reject(
			new Error(
				"Jolli site URL could not be determined. Please regenerate your Jolli API Key and set it again (STATUS panel → ...).",
			),
		);
	}
	const parsed = parseBaseUrl(resolvedBaseUrl);
	const targetUrl = new URL("/api/share/branch", parsed.origin);
	const body = JSON.stringify(payload);
	const isHttps = targetUrl.protocol === "https:";
	const headers = buildJolliApiHeaders({
		apiKey,
		keyMeta,
		tenantSlug: parsed.tenantSlug,
		bodyByteLength: Buffer.byteLength(body),
	});
	const requestFn = isHttps ? httpsRequest : httpRequest;

	return new Promise<BranchShareResult>((resolve, reject) => {
		const req = requestFn(targetUrl, { method: "POST", headers }, (res) => {
			const chunks: Array<Buffer> = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf-8");
				try {
					const json = JSON.parse(raw) as BranchShareResult & ErrorBody;
					const status = res.statusCode ?? 0;
					if (status >= 200 && status < 300) {
						// A 2xx whose body is missing shareId/token/shareUrl means the
						// server's response shape doesn't match this client's contract
						// (e.g. a stub, or a different field naming). Fail loud with the
						// raw body instead of crashing later on `token.slice(...)`.
						if (
							json?.shareId === undefined ||
							json?.shareId === null ||
							typeof json?.token !== "string" ||
							typeof json?.shareUrl !== "string"
						) {
							reject(
								new Error(
									`Share endpoint returned an unexpected response (missing shareId/token/shareUrl). HTTP ${status}: ${raw.slice(0, 300)}`,
								),
							);
							return;
						}
						resolve(json);
					} else if (status === 426) {
						reject(
							new PluginOutdatedError(
								json.message ?? "Plugin version is outdated. Please update to the latest version.",
							),
						);
					} else {
						const detail = [json.error, json.message].filter(Boolean).join(" — ");
						reject(new Error(`${detail || "request failed"} (HTTP ${status})`));
					}
				} catch {
					reject(new Error(`Invalid JSON response (HTTP ${res.statusCode}): ${raw.slice(0, 200)}`));
				}
			});
		});
		req.on("error", (err) => reject(new Error(`Network error: ${err.message}`)));
		req.write(body);
		req.end();
	});
}

/** Revokes a public branch share by id. */
export function revokeBranchShare(baseUrl: string | undefined, apiKey: string, shareId: string): Promise<void> {
	const keyMeta = parseJolliApiKey(apiKey);
	const resolvedBaseUrl = resolveBaseUrl(baseUrl, keyMeta);
	if (!resolvedBaseUrl) {
		return Promise.reject(new Error("Jolli site URL could not be determined."));
	}
	const parsed = parseBaseUrl(resolvedBaseUrl);
	const targetUrl = new URL(`/api/share/branch/${encodeURIComponent(shareId)}`, parsed.origin);
	const isHttps = targetUrl.protocol === "https:";
	const headers = buildJolliApiHeaders({ apiKey, keyMeta, tenantSlug: parsed.tenantSlug });
	const requestFn = isHttps ? httpsRequest : httpRequest;

	return new Promise<void>((resolve, reject) => {
		const req = requestFn(targetUrl, { method: "DELETE", headers }, (res) => {
			res.resume();
			const status = res.statusCode ?? 0;
			// 404 = already gone → idempotent success.
			if (status === 200 || status === 204 || status === 404) resolve();
			else reject(new Error(`Revoke failed with status ${status}`));
		});
		req.on("error", (err) => reject(new Error(`Network error: ${err.message}`)));
		req.end();
	});
}

/**
 * Adjusts an existing share's expiry via `PATCH /api/share/branch/:shareId`.
 * `expiresAt` is an absolute ISO timestamp (server requires future, ≤ now+365d).
 * Returns the server-confirmed `expiresAt`.
 */
export function updateBranchShareExpiry(
	baseUrl: string | undefined,
	apiKey: string,
	shareId: string,
	expiresAt: string,
): Promise<ShareExpiryResult> {
	const keyMeta = parseJolliApiKey(apiKey);
	const resolvedBaseUrl = resolveBaseUrl(baseUrl, keyMeta);
	if (!resolvedBaseUrl) {
		return Promise.reject(new Error("Jolli site URL could not be determined."));
	}
	const parsed = parseBaseUrl(resolvedBaseUrl);
	const targetUrl = new URL(`/api/share/branch/${encodeURIComponent(shareId)}`, parsed.origin);
	const body = JSON.stringify({ expiresAt });
	const isHttps = targetUrl.protocol === "https:";
	const headers = buildJolliApiHeaders({
		apiKey,
		keyMeta,
		tenantSlug: parsed.tenantSlug,
		bodyByteLength: Buffer.byteLength(body),
	});
	const requestFn = isHttps ? httpsRequest : httpRequest;

	return new Promise<ShareExpiryResult>((resolve, reject) => {
		const req = requestFn(targetUrl, { method: "PATCH", headers }, (res) => {
			const chunks: Array<Buffer> = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf-8");
				const status = res.statusCode ?? 0;
				try {
					const json = JSON.parse(raw) as ShareExpiryResult & ErrorBody;
					if (status >= 200 && status < 300 && typeof json.expiresAt === "string") {
						resolve(json);
					} else {
						const detail = [json.error, json.message].filter(Boolean).join(" — ");
						reject(new Error(`${detail || "expiry update failed"} (HTTP ${status})`));
					}
				} catch {
					reject(new Error(`Invalid JSON response (HTTP ${status}): ${raw.slice(0, 200)}`));
				}
			});
		});
		req.on("error", (err) => reject(new Error(`Network error: ${err.message}`)));
		req.write(body);
		req.end();
	});
}

// ─── Live (Space-backed) shares ────────────────────────────────────────────────
// These target the SAME /api/share/branch routes, now live-only: the share
// references live Space docs (a `covered` allowlist) instead of a frozen `content`
// blob. `visibility` is `public` (bearer link) or `org` (auth-gated, no token).

/** Body posted to create a live share. No `content` blob. */
export interface LiveSharePayload {
	readonly repoUrl: string;
	readonly repoName: string;
	readonly branch: string;
	readonly kind: "branch" | "commit";
	readonly visibility: "public" | "org" | "people";
	readonly decisionCount: number;
	/** Still sent: backs the NOT-NULL columns + the server's idempotency indexes. */
	readonly headCommitHash: string;
	readonly commitHashes: ReadonlyArray<string>;
	/** Display slug (slugify) — distinct from the push folder identity in `ref`. */
	readonly branchSlug?: string;
	readonly ref: LiveRef;
	/** `people` access allowlist (lowercased emails). Server-gated; omit for public/org. */
	readonly recipients?: ReadonlyArray<string>;
}

/** Response from creating a live share. `token` is absent for `org`/`people` shares. */
export interface LiveShareResult {
	readonly shareId: number | string;
	readonly shareUrl: string;
	readonly expiresAt: string;
	readonly visibility: "public" | "org" | "people";
	readonly token?: string;
	/** Server-confirmed `people` allowlist (echoed back). */
	readonly recipients?: ReadonlyArray<string>;
}

/** Response from updating a live share. PATCH endpoints may echo only changed fields. */
export type LiveShareUpdateResult = Partial<LiveShareResult>;

/** An org member offered as a recipient candidate (name + deliverable email). */
export interface OrgMember {
	readonly name: string;
	readonly email: string;
}

/**
 * Sends an authed JSON request to a Jolli API path and returns the status + parsed
 * body. Centralizes the http/https + header + parse boilerplate the live endpoints
 * share (the older snapshot functions predate this and inline it).
 */
function requestJson<T>(
	method: "POST" | "PATCH" | "GET",
	baseUrl: string | undefined,
	apiKey: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; json: (T & ErrorBody) | null; raw: string }> {
	const keyMeta = parseJolliApiKey(apiKey);
	const resolvedBaseUrl = resolveBaseUrl(baseUrl, keyMeta);
	if (!resolvedBaseUrl) {
		return Promise.reject(
			new Error(
				"Jolli site URL could not be determined. Please regenerate your Jolli API Key and set it again (STATUS panel → ...).",
			),
		);
	}
	const parsed = parseBaseUrl(resolvedBaseUrl);
	const targetUrl = new URL(path, parsed.origin);
	const payload = body === undefined ? undefined : JSON.stringify(body);
	const headers = buildJolliApiHeaders({
		apiKey,
		keyMeta,
		tenantSlug: parsed.tenantSlug,
		...(payload !== undefined && { bodyByteLength: Buffer.byteLength(payload) }),
	});
	const requestFn = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;

	return new Promise((resolve, reject) => {
		const req = requestFn(targetUrl, { method, headers }, (res) => {
			const chunks: Array<Buffer> = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf-8");
				let json: (T & ErrorBody) | null = null;
				try {
					json = raw.length > 0 ? (JSON.parse(raw) as T & ErrorBody) : null;
				} catch {
					json = null;
				}
				resolve({ status: res.statusCode ?? 0, json, raw });
			});
		});
		req.on("error", (err) => reject(new Error(`Network error: ${err.message}`)));
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

/** Maps a non-2xx response to the right error (426 → outdated, else detail + status). */
function rejectForStatus(status: number, json: ErrorBody | null, raw: string): Error {
	if (status === 426) {
		return new PluginOutdatedError(json?.message ?? "Plugin version is outdated. Please update to the latest version.");
	}
	const detail = [json?.error, json?.message].filter(Boolean).join(" — ");
	return new Error(`${detail || "request failed"} (HTTP ${status})${json ? "" : `: ${raw.slice(0, 200)}`}`);
}

/** Creates a live share. Requires `shareId` + `shareUrl`; `token` only for `public`. */
export async function createLiveShare(
	baseUrl: string | undefined,
	apiKey: string,
	payload: LiveSharePayload,
): Promise<LiveShareResult> {
	const { status, json, raw } = await requestJson<LiveShareResult>(
		"POST",
		baseUrl,
		apiKey,
		"/api/share/branch",
		payload,
	);
	if (status >= 200 && status < 300) {
		if (json?.shareId === undefined || json?.shareId === null || typeof json?.shareUrl !== "string") {
			throw new Error(
				`Share endpoint returned an unexpected response (missing shareId/shareUrl). HTTP ${status}: ${raw.slice(0, 300)}`,
			);
		}
		return json;
	}
	throw rejectForStatus(status, json, raw);
}

/** Patch type for a live share update — expiry, visibility, recipients, and/or the `covered` ref. */
export interface LiveSharePatch {
	readonly visibility?: "public" | "org" | "people";
	readonly expiresAt?: string;
	readonly ref?: LiveRef;
	/** `people` allowlist (lowercased emails); sent when changing audience. */
	readonly recipients?: ReadonlyArray<string>;
}

/** Updates a live share (visibility / covered ref / expiry) via PATCH. */
export async function updateLiveShare(
	baseUrl: string | undefined,
	apiKey: string,
	shareId: string,
	patch: LiveSharePatch,
): Promise<LiveShareUpdateResult> {
	const { status, json, raw } = await requestJson<LiveShareUpdateResult>(
		"PATCH",
		baseUrl,
		apiKey,
		`/api/share/branch/${encodeURIComponent(shareId)}`,
		patch,
	);
	// A recipients-only / non-`public`-toggle PATCH legitimately returns NO `shareUrl`
	// (the link didn't change), so accept any 2xx with a body — the caller falls back to
	// the existing URL. Only a missing body or a non-2xx is an error.
	if (status >= 200 && status < 300 && json) {
		return json;
	}
	throw rejectForStatus(status, json, raw);
}

/**
 * Lists active org members as recipient candidates (name + email), via the
 * API-key-authenticated `GET /api/jolli-memory/org-members`. The server returns
 * `{ members: [{ email, name }] }` (active users only, deactivated excluded).
 * Best-effort: skips entries without a deliverable email and returns `[]` on any
 * error (the recipient picker still has git contributors + manual entry).
 */
export async function listOrgMembers(baseUrl: string | undefined, apiKey: string): Promise<OrgMember[]> {
	try {
		const { status, json } = await requestJson<{ members?: Array<Record<string, unknown>> }>(
			"GET",
			baseUrl,
			apiKey,
			"/api/jolli-memory/org-members",
		);
		if (status < 200 || status >= 300 || json === null) return [];
		const rows = Array.isArray(json.members) ? json.members : [];
		const members: OrgMember[] = [];
		for (const row of rows) {
			const email = typeof row.email === "string" ? row.email.trim() : "";
			if (!email) continue;
			const name = typeof row.name === "string" ? row.name : "";
			members.push({ name, email });
		}
		return members;
	} catch {
		return [];
	}
}

/**
 * Fetches a shared snapshot by token (login-free). Validates `origin` against
 * the Jolli allowlist first. Throws `ShareRevokedError` on 410 / `revoked`.
 */
export function fetchSharedSnapshot(origin: string, token: string): Promise<SharedSnapshot> {
	if (token.length === 0) {
		return Promise.reject(new Error("Missing share token."));
	}
	return new Promise<SharedSnapshot>((resolve, reject) => {
		const parsed = parseBaseUrl(origin);
		// Refuse off-allowlist / non-HTTPS origins before any request leaves the machine.
		// Inside the executor so a bad origin rejects rather than throwing synchronously.
		assertJolliOriginAllowed(parsed.origin);
		const targetUrl = new URL(`/api/share/snapshot/${encodeURIComponent(token)}`, parsed.origin);
		const headers: Record<string, string> = {
			"x-jolli-client": `${VSCODE_CLIENT_INFO.kind}/${VSCODE_CLIENT_INFO.version}`,
			// Carry a trace id so this login-free outbound call is correlated in logs.
			[TRACE_HEADER_NAME]: currentTraceHeader() ?? newTraceHeader(),
		};
		if (parsed.tenantSlug) headers["x-tenant-slug"] = parsed.tenantSlug;
		// assertJolliOriginAllowed guarantees https, so no http fallback is needed here.
		const req = httpsRequest(targetUrl, { method: "GET", headers }, (res) => {
			const chunks: Array<Buffer> = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf-8");
				const status = res.statusCode ?? 0;
				if (status === 410) {
					reject(new ShareRevokedError());
					return;
				}
				try {
					const json = JSON.parse(raw) as SharedSnapshot & ErrorBody;
					if (status >= 200 && status < 300) {
						if (json.revoked) reject(new ShareRevokedError());
						else resolve(json);
					} else if (status === 426) {
						reject(
							new PluginOutdatedError(
								json.message ?? "Plugin version is outdated. Please update to the latest version.",
							),
						);
					} else {
						const detail = [json.error, json.message].filter(Boolean).join(" — ");
						reject(new Error(`${detail || "request failed"} (HTTP ${status})`));
					}
				} catch {
					reject(new Error(`Invalid JSON response (HTTP ${status}): ${raw.slice(0, 200)}`));
				}
			});
		});
		req.on("error", (err) => reject(new Error(`Network error: ${err.message}`)));
		req.end();
	});
}

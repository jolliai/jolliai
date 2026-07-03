/**
 * JolliShareService
 *
 * HTTP client for the live (Space-backed) branch-share feature:
 *
 * - `createLiveShare` / `updateLiveShare` (sharer side, authed) — POST/PATCH a
 *   share that references live Space docs and get back a `shareUrl`.
 * - `revokeBranchShare` (sharer side, authed) — DELETE a share.
 * - `sendShareInviteAndGrantAccess` — grant recipients access + email them.
 * - `listOrgMembers` — recipient-picker candidates.
 *
 * Mirrors JolliPushService: Node http/https (not fetch) to tolerate self-signed
 * certs in local dev, and the shared `buildJolliApiHeaders` for authed calls.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { type JolliApiKeyMeta, parseBaseUrl, parseJolliApiKey } from "../../../cli/src/core/JolliApiUtils.js";
import type { LiveRef } from "../../../cli/src/core/BranchShareStore.js";
import { buildJolliApiHeaders, PluginOutdatedError } from "./JolliPushService.js";

export { PluginOutdatedError };

interface ErrorBody {
	error?: string;
	message?: string;
}

/** Resolves the base URL from an explicit arg or the API key's embedded URL. */
function resolveBaseUrl(baseUrl: string | undefined, keyMeta: JolliApiKeyMeta | null): string | undefined {
	return baseUrl ?? keyMeta?.u;
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

// ─── Live (Space-backed) shares ────────────────────────────────────────────────
// These target the SAME /api/share/branch routes, now live-only: the share
// references live Space docs (a `covered` allowlist) instead of a frozen `content`
// blob. `visibility` is `public` (bearer link) or the auth-gated member tier
// (no token). The member-tier value is `"org"` end-to-end — the record, the webview
// value, and the wire all use `"org"` (the server gates it to the share's own org).

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

/** Narrow an unknown wire visibility to the plugin's tier union, or undefined when unrecognized. */
function asVisibility(v: unknown): "public" | "org" | "people" | undefined {
	return v === "public" || v === "org" || v === "people" ? v : undefined;
}

/** Wire shape of a live-share create/update response — `visibility` may be absent (e.g. expiry-only PATCH). */
type WireLiveShareResult = Omit<LiveShareResult, "visibility"> & { readonly visibility?: string };

/** Creates a live share. Requires `shareId` + `shareUrl`; `token` only for `public`. */
export async function createLiveShare(
	baseUrl: string | undefined,
	apiKey: string,
	payload: LiveSharePayload,
): Promise<LiveShareResult> {
	const { status, json, raw } = await requestJson<WireLiveShareResult>(
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
		return { ...json, visibility: asVisibility(json.visibility) ?? payload.visibility };
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
	const { status, json, raw } = await requestJson<Partial<WireLiveShareResult>>(
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
		const { visibility: wireVisibility, ...rest } = json;
		const visibility = asVisibility(wireVisibility);
		return { ...rest, ...(visibility && { visibility }) };
	}
	throw rejectForStatus(status, json, raw);
}

/** What the invite endpoint reports back: who got the email, and who couldn't be reached. */
export interface ShareInviteResult {
	/** Emails an invite mail was sent to. */
	readonly sent: ReadonlyArray<string>;
	/** Emails whose mail failed — access was still granted (mail is notification, not permission). */
	readonly failed: ReadonlyArray<string>;
}

/**
 * Invites people to a member share — **this has a permission side effect**, it is
 * not just email: the server first MERGES the emails into the member link's
 * recipients allowlist (granting them access to the `/view` URL), then sends each
 * one an invite mail with the link + optional note. A mail failure never revokes
 * the granted access; it shows up in `failed`. Owner-only server-side (403
 * otherwise); rejects public shares (404).
 */
export async function sendShareInviteAndGrantAccess(
	baseUrl: string | undefined,
	apiKey: string,
	shareId: string,
	body: { readonly recipients: ReadonlyArray<string>; readonly message?: string },
): Promise<ShareInviteResult> {
	const { status, json, raw } = await requestJson<ShareInviteResult>(
		"POST",
		baseUrl,
		apiKey,
		`/api/share/branch/${encodeURIComponent(shareId)}/invite`,
		body,
	);
	if (status >= 200 && status < 300) {
		if (json && Array.isArray(json.sent) && Array.isArray(json.failed)) {
			return json;
		}
		// A 2xx with no per-recipient breakdown (e.g. 202 Accepted: access granted,
		// mail queued for async delivery) is still success — treat every requested
		// recipient as sent. Guard against a non-JSON body: a misrouted host can 200
		// with an SPA HTML page, which is NOT a real API success.
		if (json !== null || raw.trim() === "") {
			return { sent: [...body.recipients], failed: [] };
		}
	}
	throw rejectForStatus(status, json, raw);
}

/** Directory cap: the share popover's suggestion list never needs more than this many members. */
const ORG_MEMBERS_MAX = 100;
/** Successful member lists are reused for 3 minutes so reopening Share doesn't re-hit the API. */
const ORG_MEMBERS_TTL_MS = 3 * 60 * 1000;
const orgMembersCache = new Map<string, { members: OrgMember[]; ts: number }>();

/** Test hook: drops all cached member lists so cases don't leak into each other. */
export function clearOrgMembersCache(): void {
	orgMembersCache.clear();
}

/**
 * Lists active org members as recipient candidates (name + email), via the
 * API-key-authenticated `GET /api/jolli-memory/org-members`. The server returns
 * `{ members: [{ email, name }] }` (active users only, deactivated excluded).
 * Best-effort: skips entries without a deliverable email and returns `[]` on any
 * error (the recipient picker still has git contributors + manual entry).
 *
 * Capped at {@link ORG_MEMBERS_MAX} and cached per (baseUrl, apiKey) for
 * {@link ORG_MEMBERS_TTL_MS} — only successful fetches are cached, so a transient
 * failure never sticks for the TTL.
 */
export async function listOrgMembers(baseUrl: string | undefined, apiKey: string): Promise<OrgMember[]> {
	// NUL joiner: can't occur in a URL or an API key, so keys never collide.
	const cacheKey = `${baseUrl ?? ""}\u0000${apiKey}`;
	const cached = orgMembersCache.get(cacheKey);
	if (cached && Date.now() - cached.ts < ORG_MEMBERS_TTL_MS) {
		return cached.members;
	}
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
			if (members.length >= ORG_MEMBERS_MAX) break;
			const email = typeof row.email === "string" ? row.email.trim() : "";
			if (!email) continue;
			const name = typeof row.name === "string" ? row.name : "";
			members.push({ name, email });
		}
		orgMembersCache.set(cacheKey, { members, ts: Date.now() });
		return members;
	} catch {
		return [];
	}
}

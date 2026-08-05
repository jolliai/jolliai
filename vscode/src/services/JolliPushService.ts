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
 * Implements the push contract:
 * - Sends `x-jolli-client: <kind>/<version>` header (e.g. `vscode-plugin/1.2.3`)
 *   so the server can identify the caller, gate on version, and route through
 *   the per-repo binding flow without parsing the body. (Here `<kind>` is the
 *   *client* kind — distinct from the body's `docType` field below.)
 * - Sends `repoUrl` (canonical, normalized — see GitRemoteUtils) and
 *   `relativePath` (flat — `<branchSlug>` for all kinds) in the body so the
 *   server can place the doc under `repoFolder → branchSlug`.
 * - Sends `docType` in the body — `"summary"`, or a context kind's tag from the
 *   shared registry (`cli/src/core/push/kinds/`). With the flat path layout this
 *   is the sole disambiguator the server uses to set `sourceMetadata.docType`
 *   and route TreeItem icons on the frontend.
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
import { DocTypeNotAllowedError } from "../../../cli/src/core/JolliMemoryPushClient.js";
import { isOutboundPushAllowed } from "../../../cli/src/core/PushControl.js";
import { currentTraceHeader, newTraceHeader, TRACE_HEADER_NAME } from "../../../cli/src/core/TraceContext.js";
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

/**
 * The server accepted the credential but refused the push. Two server shapes map
 * here: a 412 `repo_not_allowlisted` (the repo is not registered in a restricted
 * Space — an admin must add it) and a push-path 403 (an ownership mismatch).
 * Distinct from an auth failure (401): the user should contact an admin, not
 * re-login. Mirrors the CLI's `PermissionDeniedError` so all three clients
 * surface the same actionable text.
 */
export class PermissionDeniedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PermissionDeniedError";
	}
}

/**
 * Thrown before any network call when the repo has opted out of outbound push
 * (spec 306, per-repo push control). The opt-out lives in the machine-global,
 * identity-keyed push-control store (NOT `profile.json`); see spec 306. Memory
 * stays recorded locally; the call site should surface a "re-enable to push"
 * message rather than treating it as a failure.
 */
export class PushDisabledError extends Error {
	constructor(message = "Outbound push is disabled for this repo. Re-enable it in Settings → Sync to Jolli to push.") {
		super(message);
		this.name = "PushDisabledError";
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
	 *
	 * Typed as `string`, not a union, on purpose: `"summary"` is the reserved tag
	 * for the memory itself, and every other value is a context kind's `docType`
	 * from the shared registry (`cli/src/core/push/kinds/`) — a union here would
	 * have to grow by one member per new kind, the exact per-kind edit the
	 * registry exists to remove. The server's supported-docType configuration is
	 * the authority; an unknown tag is rejected with `412 doctype_not_allowed`.
	 */
	readonly docType: string;
	readonly branch?: string;
	/** Server-side document ID for direct update on subsequent pushes. */
	readonly docId?: number;
	/** Canonical, normalized remote URL — server's identity key for the repo. */
	readonly repoUrl?: string;
	/** Folder chain below the repo folder — flat `<branchSlug>` for all docTypes. No leading `/`. */
	readonly relativePath?: string;
	/**
	 * Serialized structured summary JSON (summary docType only). The server stores
	 * it as a hidden sidecar at `<repoFolder>/.jolli/summaries/<commitHash>.json`
	 * for the share page's structured rendering. Optional: old servers strip the
	 * unknown field and the push succeeds unchanged.
	 */
	readonly summaryJson?: string;
}

/** Response from a successful push */
export interface JolliPushResult {
	readonly url: string;
	readonly docId: number;
	readonly jrn: string;
	readonly created: boolean;
	/**
	 * Doc id of the hidden summary-JSON sidecar the server upserted (summary
	 * pushes that carried `summaryJson` only). Informational — the server keys
	 * the sidecar by commit hash, so the client never needs to track this id.
	 */
	readonly summaryJsonDocId?: number;
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
	// Jolli trace context: carry the ambient operation's trace id (set by the
	// `runWithTrace` scope around the webview dispatch) so this request shares one
	// id with the operation's log lines. Outside any scope (standalone one-shot
	// callers) fall back to a fresh value so the request is still traceable.
	headers[TRACE_HEADER_NAME] = currentTraceHeader() ?? newTraceHeader();
	return headers;
}

/**
 * A short, single-line excerpt of a response body, for error messages whose body
 * could not be parsed as JSON. Returns null when there is nothing to show, so
 * callers can `??` their way to a static fallback.
 *
 * Collapses whitespace because the bodies this exists for — CDN / WAF / gateway
 * refusals — are multi-line HTML, and a raw paste turns a one-line error into a
 * screenful. Capped at 200 chars: enough to identify the intermediary (`<title>`,
 * a Cloudflare ray id) without dumping a page into a toast or a log line.
 */
function rawSnippet(raw: string): string | null {
	const collapsed = raw.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) return null;
	return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed;
}

/**
 * Pushes a commit summary to a Jolli Space via the push API.
 *
 * @param baseUrl - Jolli site base URL. If undefined, falls back to the URL embedded in the API key.
 * @param apiKey - Jolli API key (sk-jol-...)
 * @param payload - Summary content to push
 * @param cwd - A path inside the repo, used to enforce the per-repo outbound-push
 *   opt-out (spec 306). This function is the choke for every VS Code push of
 *   MEMORY CONTENT, so the gate lives here — not just at the orchestrator — to
 *   close the "separate HTTP implementation" gap. **Required**: a new caller that
 *   forgot to thread a workspace through would otherwise silently bypass the gate
 *   with no compile-time signal, defeating the whole point of this choke.
 *
 *   Not the extension's only outbound HTTP path, though: `JolliShareService.ts`
 *   issues its own `node:http`/`node:https` requests for `createLiveShare` /
 *   `updateLiveShare`. Those are deliberately ungated — they carry share
 *   metadata (visibility, recipients, a `ref` pointing at already-pushed Space
 *   docs), not memory content, and every path that reaches them runs a gated
 *   push first. If you add a send there that carries memory content, gate it.
 * @returns Push result with article URL and metadata
 * @throws PushDisabledError when the repo opted out; Error otherwise (network,
 *   non-2xx, or missing base URL)
 */
export async function pushToJolli(
	baseUrl: string | undefined,
	apiKey: string,
	payload: JolliPushPayload,
	cwd: string,
): Promise<JolliPushResult> {
	if (!(await isOutboundPushAllowed(cwd))) {
		throw new PushDisabledError();
	}
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
					const status = res.statusCode ?? 0;
					// Parse tolerantly: error statuses are decided on the status code
					// alone, so a proxy/gateway 403 (or any non-2xx) with an empty or
					// non-JSON body still maps to the right error rather than a generic
					// "Invalid JSON" one. Only the 2xx success path requires valid JSON.
					// Mirrors the CLI's `call()` + `push()`.
					let parsed: (JolliPushResult & ErrorBody) | null = null;
					try {
						parsed = JSON.parse(raw) as JolliPushResult & ErrorBody;
					} catch {
						parsed = null;
					}
					const body = parsed ?? ({} as JolliPushResult & ErrorBody);

					if (status === 426) {
						reject(
							new PluginOutdatedError(
								body.message ?? "Plugin version is outdated. Please update to the latest version.",
							),
						);
					} else if (status === 412 && body.error === "binding_required") {
						reject(new BindingRequiredError(body.repoUrl ?? payload.repoUrl ?? "", body.message));
					} else if (status === 412 && body.error === "repo_not_allowlisted") {
						// The allowlist refusal — the server emits it as 412 (NOT 403;
						// that status is the bind path's `space_restricted`). Map it to
						// PermissionDeniedError so callers stop retrying and surface the
						// admin-action sentence, not a generic "(HTTP 412)".
						reject(
							new PermissionDeniedError(
								body.message ?? body.error ?? "You don't have permission to push to this Space.",
							),
						);
					} else if (status === 412 && body.error === "doctype_not_allowed") {
						// The server has no config row enabling this docType. Same 412 +
						// machine-tag shape as `repo_not_allowlisted`, but deliberately NOT
						// PermissionDeniedError: that class is a repo-wide refusal (see
						// cli PushRefusal.ts) and would abort the whole attachment loop —
						// one unconfigured kind must only short-circuit ITS kind (the
						// orchestrator handles DocTypeNotAllowedError per kind).
						reject(new DocTypeNotAllowedError(payload.docType, body.message));
					} else if (status === 409 && body.error === "binding_already_exists") {
						reject(new BindingAlreadyExistsError(body as unknown as BindingExistsBody, body.message));
					} else if (status === 403) {
						// Credential OK but the push was refused — on the push path a 403
						// is an ownership mismatch (the target doc belongs to another user
						// / was not created by JolliMemory). Surface the server's sentence,
						// not an auth message, matching the CLI's
						// PermissionDeniedError).
						reject(
							new PermissionDeniedError(
								body.message ?? body.error ?? "You don't have permission to push to this Space.",
							),
						);
					} else if (status < 200 || status >= 300) {
						// Prefer the human `message`, then the `error` slug, so a slug
						// like `repo_not_allowlisted` never surfaces alone when the
						// server also sent a sentence.
						//
						// When NOTHING parsed, fall back to a truncated snippet of the raw
						// body rather than a bare "request failed": an unparseable non-2xx
						// is the CDN / WAF / reverse-proxy case, and that HTML is the only
						// thing identifying which intermediary refused the request. Deciding
						// the branch on status alone (above) is what makes such a body
						// reachable here at all, so dropping it would trade one blind spot
						// for another.
						const detail = body.message ?? body.error ?? rawSnippet(raw) ?? "request failed";
						reject(new Error(`${detail} (HTTP ${status})`));
					} else if (parsed === null) {
						// 2xx but the body isn't parseable — there is no result to return.
						reject(new Error(`Invalid JSON response (HTTP ${status}): ${rawSnippet(raw) ?? ""}`));
					} else {
						resolve(parsed);
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
 *
 * @param cwd - A path inside the repo; deletes are outbound too, so a
 *   push-disabled repo (spec 306) must not emit them either. **Required** for the
 *   same reason as {@link pushToJolli}: the gate must not be silently bypassable.
 */
export async function deleteFromJolli(
	baseUrl: string | undefined,
	apiKey: string,
	docId: number,
	cwd: string,
): Promise<void> {
	if (!(await isOutboundPushAllowed(cwd))) {
		throw new PushDisabledError();
	}
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

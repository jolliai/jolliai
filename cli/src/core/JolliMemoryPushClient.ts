/**
 * HTTP client for the Jolli Memory push endpoints (spaces + bindings; push
 * itself lands in a follow-up task).
 *
 * Models its constructor/auth/header/timeout plumbing on
 * `cli/src/sync/BackendClient.ts` — same `Authorization: Bearer <jolliApiKey>`
 * + tenant-subdomain routing + `x-tenant-slug` / `x-org-slug` / trace-header
 * pattern — but is not built on top of it: `BackendClient` is GET/POST-only
 * and scoped to the `/api/mb-sync/*` Memory Bank sync surface, while this
 * client targets `/api/jolli-memory/*` with a push-specific error taxonomy
 * (`NotAuthenticatedError`, `ClientOutdatedError`, `BindingAlreadyExistsError`,
 * `BindingRequiredError`).
 *
 * `createBinding` parses the REAL server response shape — `{ binding,
 * repoFolder }` — there is no top-level `jmSpaceName` field, despite the
 * VS Code `BindingInfo` type suggesting one.
 */

import { JOLLI_CLIENT_HEADER } from "./ClientHeader.js";
import { type JolliApiKeyMeta, parseBaseUrl, parseJolliApiKey } from "./JolliApiUtils.js";
import { loadConfig } from "./SessionTracker.js";
import { currentTraceHeader, newTraceHeader, TRACE_HEADER_NAME } from "./TraceContext.js";

/** No `jolliApiKey` configured, or no Jolli URL could be resolved from it. */
export class NotAuthenticatedError extends Error {
	constructor(message?: string) {
		super(message ?? "Not signed in to Jolli.");
		this.name = "NotAuthenticatedError";
	}
}

/** Server returned 426 — the installed CLI/extension is too old for this endpoint's contract. */
export class ClientOutdatedError extends Error {
	constructor(message?: string) {
		super(message ?? "Client outdated — update the CLI/extension.");
		this.name = "ClientOutdatedError";
	}
}

/**
 * Server returned 409 `binding_already_exists` for `createBinding`. The server
 * includes the existing binding on this response, so `existingSpaceId` carries
 * the space the repo is *actually* bound to (undefined only for the rare
 * unique-race with no observable winner) — callers that requested a specific
 * space use it to detect a bind-to-the-wrong-space mismatch.
 */
export class BindingAlreadyExistsError extends Error {
	readonly existingSpaceId?: number;
	constructor(message?: string, existingSpaceId?: number) {
		super(message ?? "binding_already_exists");
		this.name = "BindingAlreadyExistsError";
		this.existingSpaceId = existingSpaceId;
	}
}

/**
 * The repo has no binding yet and the caller needs one to proceed (e.g. push
 * attempted before `createBinding`). Carries `repoUrl` so callers can drive
 * an interactive "create a binding for this repo" flow.
 */
export class BindingRequiredError extends Error {
	readonly repoUrl: string;
	constructor(repoUrl: string, message?: string) {
		super(message ?? "binding_required");
		this.name = "BindingRequiredError";
		this.repoUrl = repoUrl;
	}
}

/** A space as returned by `GET /api/jolli-memory/spaces`. */
export interface JolliMemorySpace {
	readonly id: number;
	readonly name: string;
	readonly slug: string;
}

/** Test seam — swap in a stub `fetch` / api key / base URL to drive unit tests deterministically. */
export interface JolliMemoryPushClientOpts {
	readonly fetchImpl?: typeof fetch;
	/** Override the resolved base URL — useful for tests. When omitted, the base URL comes from `parseJolliApiKey(apiKey).u`. */
	readonly baseUrlOverride?: string;
	/** Override the jolliApiKey loader. Default: read `jolliApiKey` from `SessionTracker.loadConfig`. */
	readonly apiKeyProvider?: () => Promise<string | undefined>;
	/** Default 30 s per request. */
	readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Raw shape of `GET /api/jolli-memory/spaces` — validated field-by-field at parse time. */
interface ListSpacesResponseBody {
	readonly spaces?: ReadonlyArray<{ readonly id: number; readonly name: string; readonly slug: string }>;
	readonly defaultSpaceId?: number | null;
}

/** Raw shape of `POST /api/jolli-memory/bindings` — server returns `{ binding, repoFolder }`, no top-level `jmSpaceName`. */
interface CreateBindingResponseBody {
	readonly binding?: { readonly id: number; readonly jmSpaceId: number; readonly repoName: string };
	readonly repoFolder?: unknown;
}

/** Generic error-shaped JSON body: `{ error?: string; message?: string }`. */
interface ErrorResponseBody {
	readonly error?: string;
	readonly message?: string;
}

/**
 * Payload for `POST /api/push/jollimemory`. Mirrors `JolliPushPayload`
 * (`vscode/src/services/JolliPushService.ts`) field-for-field — see that
 * file's docstring for what each field drives server-side.
 */
export interface PushPayload {
	readonly title: string;
	readonly content: string;
	readonly commitHash: string;
	readonly docType: "summary" | "plan" | "note";
	readonly branch?: string;
	readonly docId?: number;
	readonly repoUrl?: string;
	readonly relativePath?: string;
	readonly summaryJson?: string;
}

/** Response from a successful push. Mirrors `JolliPushResult`. */
export interface PushResult {
	readonly url: string;
	readonly docId: number;
	readonly jrn: string;
	readonly created: boolean;
	readonly summaryJsonDocId?: number;
}

/**
 * Raw shape of `POST /api/push/jollimemory`. The success fields are only
 * actually present on a 2xx response — every error branch throws before they
 * are read, mirroring the `pushToJolli` (`JolliPushService.ts`) response cast.
 */
interface PushResponseBody {
	readonly url: string;
	readonly docId: number;
	readonly jrn: string;
	readonly created: boolean;
	readonly summaryJsonDocId?: number;
	readonly error?: string;
	readonly message?: string;
	readonly repoUrl?: string;
}

export class JolliMemoryPushClient {
	private readonly fetchImpl: typeof fetch;
	private readonly baseUrlOverride?: string;
	private readonly apiKeyProvider: () => Promise<string | undefined>;
	private readonly timeoutMs: number;

	constructor(opts: JolliMemoryPushClientOpts = {}) {
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.baseUrlOverride = opts.baseUrlOverride;
		this.apiKeyProvider = opts.apiKeyProvider ?? defaultApiKeyProvider;
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** Lists the spaces the current tenant can bind a repo to, plus the tenant's configured default. */
	async listSpaces(): Promise<{ spaces: JolliMemorySpace[]; defaultSpaceId: number | null }> {
		const { status, json, parseFailed } = await this.call<ListSpacesResponseBody>(
			"GET",
			"/api/jolli-memory/spaces",
		);
		if (status === 426) {
			throw new ClientOutdatedError(errorMessage(json));
		}
		if (status < 200 || status >= 300) {
			throw new Error(errorMessage(json) ?? `HTTP ${status}`);
		}
		if (parseFailed) {
			// A 2xx whose body isn't JSON (proxy/gateway HTML) would otherwise fall
			// back to `{}` and surface as an empty Space list — masking the outage as
			// "no Spaces available". Fail loudly instead. (An empty but valid `{}`
			// JSON body is not a parse failure and still yields [].)
			throw new Error(`Malformed (non-JSON) response from /api/jolli-memory/spaces (HTTP ${status})`);
		}
		const spaces = (json.spaces ?? []).map((s) => ({ id: s.id, name: s.name, slug: s.slug }));
		return { spaces, defaultSpaceId: json.defaultSpaceId ?? null };
	}

	/** Binds a repo to a Jolli Memory space. Server response has no `jmSpaceName` — only `{ binding, repoFolder }`. */
	async createBinding(args: { repoUrl: string; repoName: string; jmSpaceId: number }): Promise<{
		bindingId: number;
		jmSpaceId: number;
		repoName: string;
	}> {
		const { status, json } = await this.call<CreateBindingResponseBody>("POST", "/api/jolli-memory/bindings", args);
		// Read the existing-binding space id before any `isErrorBody` narrowing
		// strips the `binding` field off the type — the 409 body carries the
		// binding the repo is already bound to.
		const existingSpaceId = json.binding?.jmSpaceId;
		if (status === 426) {
			throw new ClientOutdatedError(errorMessage(json));
		}
		if (status === 409 && isErrorBody(json) && json.error === "binding_already_exists") {
			throw new BindingAlreadyExistsError(errorMessage(json), existingSpaceId);
		}
		if (status < 200 || status >= 300 || !json.binding) {
			throw new Error(errorMessage(json) ?? `HTTP ${status}`);
		}
		return { bindingId: json.binding.id, jmSpaceId: json.binding.jmSpaceId, repoName: json.binding.repoName };
	}

	/**
	 * Pushes a commit summary/plan/note to a Jolli Space. Mirrors `pushToJolli`'s
	 * error mapping (`JolliPushService.ts:184-277`): 426 → outdated client, 412
	 * `binding_required` → the repo needs a binding first, 409
	 * `binding_already_exists` → a concurrent binding won the race.
	 */
	async push(payload: PushPayload): Promise<PushResult> {
		const { status, json } = await this.call<PushResponseBody>("POST", "/api/push/jollimemory", payload);
		if (status === 426) {
			throw new ClientOutdatedError(json.message ?? "Client outdated — update the CLI/extension.");
		}
		if (status === 412 && json.error === "binding_required") {
			throw new BindingRequiredError(json.repoUrl ?? payload.repoUrl ?? "", json.message);
		}
		if (status === 409 && json.error === "binding_already_exists") {
			throw new BindingAlreadyExistsError(json.message ?? "binding_already_exists");
		}
		if (status === 401 || status === 403) {
			throw new NotAuthenticatedError();
		}
		if (status < 200 || status >= 300) {
			// Read `message ?? error` like listSpaces/createBinding (and the vscode
			// parent) — the server may carry the human-readable reason in `message`.
			throw new Error(errorMessage(json) ?? `HTTP ${status}`);
		}
		if (typeof json.docId !== "number" || typeof json.url !== "string") {
			// A 2xx whose body is empty / non-JSON / missing fields (call() falls
			// those back to `{}`) would otherwise yield an undefined docId — poisoning
			// the article link (`?doc=undefined`) and forcing a re-CREATE instead of
			// an UPDATE on the next push. Fail loudly rather than persist a bad docId.
			throw new Error(`Push returned HTTP ${status} but the response was missing a docId/url`);
		}
		return {
			url: json.url,
			docId: json.docId,
			jrn: json.jrn,
			created: json.created,
			summaryJsonDocId: json.summaryJsonDocId,
		};
	}

	/**
	 * Deletes an orphaned push doc (e.g. from a squashed/rebased commit).
	 * Mirrors `deleteFromJolli` (`JolliPushService.ts:283-326`) — best-effort,
	 * throws on any non-2xx so the caller can decide whether to retry.
	 */
	async deleteDoc(docId: number): Promise<void> {
		const { status } = await this.call("DELETE", `/api/push/jollimemory/${docId}`);
		if (status === 401 || status === 403) {
			throw new NotAuthenticatedError();
		}
		if (status < 200 || status >= 300) {
			throw new Error(`delete failed: HTTP ${status}`);
		}
	}

	/**
	 * Resolves the base URL used for building article links
	 * (`${baseUrl}/articles?doc=...`) — the orchestrator's push loop needs this
	 * ahead of any single push call, so it's exposed rather than re-derived from
	 * `parseJolliApiKey` at the call site.
	 */
	async resolveBaseUrl(): Promise<string> {
		const { baseUrl } = await this.resolveAuth();
		return baseUrl;
	}

	private async resolveAuth(): Promise<{
		apiKey: string;
		baseUrl: string;
		keyMeta: JolliApiKeyMeta | null;
		tenantSlug: string | undefined;
	}> {
		const apiKey = await this.apiKeyProvider();
		if (!apiKey) {
			throw new NotAuthenticatedError(
				"Not signed in to Jolli. Run `jolli auth login` or sign in via the extension.",
			);
		}
		const keyMeta = parseJolliApiKey(apiKey);
		const rawBase = this.baseUrlOverride ?? keyMeta?.u;
		if (!rawBase) {
			throw new NotAuthenticatedError("No Jolli URL configured. Regenerate your Jolli API key or set jolliUrl.");
		}
		const { tenantSlug } = parseBaseUrl(rawBase);
		return { apiKey, baseUrl: rawBase, keyMeta, tenantSlug };
	}

	private buildHeaders(
		apiKey: string,
		keyMeta: JolliApiKeyMeta | null,
		tenantSlug: string | undefined,
		hasBody: boolean,
	): Record<string, string> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${apiKey}`,
			"x-jolli-client": JOLLI_CLIENT_HEADER,
		};
		if (hasBody) {
			headers["Content-Type"] = "application/json";
		}
		if (tenantSlug) {
			headers["x-tenant-slug"] = tenantSlug;
		}
		if (keyMeta?.o) {
			headers["x-org-slug"] = keyMeta.o;
		}
		headers[TRACE_HEADER_NAME] = currentTraceHeader() ?? newTraceHeader();
		return headers;
	}

	private async call<T>(
		method: "GET" | "POST" | "DELETE",
		path: string,
		body?: unknown,
	): Promise<{ status: number; json: T; parseFailed: boolean }> {
		const { apiKey, baseUrl, keyMeta, tenantSlug } = await this.resolveAuth();
		const { origin } = parseBaseUrl(baseUrl);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await this.fetchImpl(new URL(path, origin).toString(), {
				method,
				headers: this.buildHeaders(apiKey, keyMeta, tenantSlug, body !== undefined),
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: controller.signal,
			});
			const text = await res.text();
			// Parse defensively: an intermediary (reverse proxy / gateway) can
			// answer 5xx with an HTML page or a status like 426 with a plain-text
			// body. Throwing a SyntaxError here would bypass the callers'
			// status-based error taxonomy (426 → ClientOutdatedError, 412/409, …)
			// and surface an opaque "Unexpected token" instead. Fall back to `{}`
			// so the status dispatch still runs and the right error is raised.
			let json: T;
			let parseFailed = false;
			try {
				json = (text ? JSON.parse(text) : {}) as T;
			} catch {
				json = {} as T;
				parseFailed = true;
			}
			return { status: res.status, json, parseFailed };
		} finally {
			clearTimeout(timer);
		}
	}
}

function isErrorBody(value: unknown): value is ErrorResponseBody {
	return typeof value === "object" && value !== null;
}

function errorMessage(body: unknown): string | undefined {
	if (!isErrorBody(body)) {
		return undefined;
	}
	return body.message ?? body.error;
}

async function defaultApiKeyProvider(): Promise<string | undefined> {
	const config = await loadConfig();
	return config.jolliApiKey;
}

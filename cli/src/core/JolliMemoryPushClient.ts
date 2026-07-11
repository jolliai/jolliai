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
import { deriveJolliEnvKey, type JolliApiKeyMeta, parseBaseUrl, parseJolliApiKey } from "./JolliApiUtils.js";
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

/**
 * Outcome of `POST /api/jolli-memory/front-door` — the single round-trip
 * "binding status + setup-if-needed" call the guided front door makes on every
 * bare `jolli`. `bound` covers both a pre-existing binding and the server-side
 * auto-bind when exactly one Space is bindable. `jmSpaceId` and `spaceName` are
 * `null` when the caller lacks `spaces.view` on the bound Space; the server
 * withholds the Space details but not the bound-ness. `unbound` means several
 * Spaces are bindable and the caller should prompt, then bind via
 * {@link JolliMemoryPushClient.createBinding}.
 */
export type FrontDoorResult =
	| {
			readonly status: "bound";
			readonly binding: { readonly jmSpaceId: number | null; readonly spaceName: string | null };
	  }
	| {
			readonly status: "unbound";
			readonly spaces: JolliMemorySpace[];
			readonly defaultSpaceId: number | null;
	  }
	| { readonly status: "no_spaces" };

/** How to reach a platform tool's backend endpoint, as advertised by the manifest. */
export interface PlatformToolBinding {
	readonly method: string;
	readonly path: string;
}

/**
 * Opt-in metadata that surfaces a platform tool in the curated `/jolli` menu
 * prompt. The backend flags a tool for the menu by attaching this block; an entry
 * without it is a normal, directly-callable tool that simply never appears in the
 * menu. `label` is the human-facing menu entry, `description` overrides the tool's
 * own description in the menu, and `order` is an optional sort hint.
 */
export interface PlatformToolMenuEntry {
	readonly label: string;
	readonly description?: string;
	readonly order?: number;
}

/**
 * A backend-defined Jolli-platform tool as advertised by `GET /api/mcp/manifest`.
 * The `name` / `description` / `inputSchema` triple structurally matches the MCP
 * server's tool definition so the server can splice these straight into its tool
 * registry (the extra `binding` field is internal routing metadata, not part of
 * the advertised tool schema). Declared here — with no MCP-SDK coupling — because
 * this client owns the fetch, field validation, and the generic executor.
 */
export interface PlatformToolManifestEntry {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
	/** REST binding the generic executor calls. Falls back to POST /api/mcp/tools/<name> when absent. */
	readonly binding?: PlatformToolBinding;
	/** Present only when the backend flags this tool for the curated `/jolli` menu. */
	readonly menu?: PlatformToolMenuEntry;
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

/**
 * Manifest fetch runs at MCP-server startup, so it uses a much tighter timeout
 * than a normal request: a reachable-but-slow backend must not stall server
 * startup for the full default window. A timeout collapses to "no platform
 * tools" like any other manifest failure.
 */
const MANIFEST_TIMEOUT_MS = 5_000;

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

/** Raw shape of `POST /api/jolli-memory/front-door` — validated field-by-field at parse time. */
interface FrontDoorResponseBody {
	readonly status?: "bound" | "unbound" | "no_spaces";
	readonly binding?: { readonly jmSpaceId?: number | null; readonly spaceName?: string | null };
	readonly spaces?: ReadonlyArray<{ readonly id: number; readonly name: string; readonly slug: string }>;
	readonly defaultSpaceId?: number | null;
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
	readonly docType: "summary" | "plan" | "note" | "reference";
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

	/**
	 * Resolves the repo's Space-binding state in one round-trip (see
	 * {@link FrontDoorResult}). The server auto-binds when exactly one Space is
	 * bindable, so callers only ever follow up with `createBinding` after an
	 * `unbound` (several Spaces → user picked one).
	 */
	async frontDoor(args: { repoUrl: string; repoName: string }): Promise<FrontDoorResult> {
		const { status, json, parseFailed } = await this.call<FrontDoorResponseBody>(
			"POST",
			"/api/jolli-memory/front-door",
			args,
		);
		if (status === 426) {
			throw new ClientOutdatedError(errorMessage(json));
		}
		if (status === 401 || status === 403) {
			throw new NotAuthenticatedError();
		}
		if (status < 200 || status >= 300) {
			throw new Error(errorMessage(json) ?? `HTTP ${status}`);
		}
		if (parseFailed) {
			// Same rationale as listSpaces: a 2xx with an HTML/plain-text body
			// (proxy/gateway) must fail loudly, not read as an empty/unknown state.
			throw new Error(`Malformed (non-JSON) response from /api/jolli-memory/front-door (HTTP ${status})`);
		}
		if (
			json.status === "bound" &&
			json.binding &&
			(json.binding.jmSpaceId === undefined ||
				json.binding.jmSpaceId === null ||
				typeof json.binding.jmSpaceId === "number")
		) {
			return {
				status: "bound",
				binding: { jmSpaceId: json.binding.jmSpaceId ?? null, spaceName: json.binding.spaceName ?? null },
			};
		}
		if (json.status === "unbound") {
			const spaces = (json.spaces ?? []).map((s) => ({ id: s.id, name: s.name, slug: s.slug }));
			return { status: "unbound", spaces, defaultSpaceId: json.defaultSpaceId ?? null };
		}
		if (json.status === "no_spaces") {
			return { status: "no_spaces" };
		}
		// A 2xx whose body carries no recognizable status (field renamed, contract
		// drift) — fail loudly rather than have the caller misread the repo state.
		throw new Error(`Unexpected front-door response shape (HTTP ${status})`);
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

	/**
	 * Resolves the env key (`deriveJolliEnvKey`) of the tenant this client pushes
	 * to — the orchestrator tags each minted `jolliDocId` with it and only reuses
	 * an id as an update target when the tag matches. Same no-network auth resolve
	 * as {@link resolveBaseUrl}; `resolveAuth` guarantees a base URL, so the key is
	 * always defined here.
	 */
	async resolveEnvKey(): Promise<string> {
		const { baseUrl } = await this.resolveAuth();
		return deriveJolliEnvKey(baseUrl) ?? "";
	}

	/**
	 * Fetches the tenant's backend-defined Jolli-platform tool manifest
	 * (`GET /api/mcp/manifest`). Best-effort by contract: EVERY failure mode —
	 * a non-2xx status (including 404 when the surface is off and 403 when the
	 * key lacks permission to invoke it), no api key configured, a network /
	 * abort / timeout error, a non-JSON body, or a missing / empty tool array —
	 * resolves to `[]` and NEVER throws, so a disabled or older backend silently
	 * degrades to "no platform tools" instead of breaking MCP-server startup.
	 * Malformed individual entries are dropped rather than failing the whole
	 * manifest. Accepts either a `{ tools: [...] }` envelope or a bare array.
	 */
	async fetchManifest(): Promise<PlatformToolManifestEntry[]> {
		try {
			const { status, json, parseFailed } = await this.call<unknown>(
				"GET",
				"/api/mcp/manifest",
				undefined,
				MANIFEST_TIMEOUT_MS,
			);
			if (status < 200 || status >= 300 || parseFailed) {
				return [];
			}
			return extractManifestTools(json)
				.map(toPlatformToolEntry)
				.filter((entry): entry is PlatformToolManifestEntry => entry !== null);
		} catch {
			// NotAuthenticatedError (no key / no resolvable URL), a rejected fetch,
			// or an abort — all collapse to "no platform tools".
			return [];
		}
	}

	/**
	 * Relays a Jolli-platform tool call to the endpoint the manifest advertised
	 * for it (its `binding`), falling back to `POST /api/mcp/tools/<name>` when no
	 * binding is present. Args are forwarded as-is — the backend validates them
	 * against the tool's manifest schema, so the CLI does not re-validate.
	 * Deliberately asymmetric to {@link fetchManifest}: a failed INVOCATION must
	 * surface, so this THROWS on a non-2xx status or a 2xx body that isn't JSON
	 * (the loud-fail pattern `push` / `listSpaces` use), letting the MCP server's
	 * existing catch wrap it as an error response. A 2xx JSON body is returned
	 * verbatim so the server's own envelope rules (a `type: "error"` result is an
	 * error; a "needs input" result is not) apply to the backend's response shape
	 * unchanged.
	 */
	async invokePlatformTool(tool: PlatformToolManifestEntry, args: Record<string, unknown>): Promise<unknown> {
		const { baseUrl } = await this.resolveAuth();
		const { origin } = parseBaseUrl(baseUrl);
		const { method, path } = resolveToolEndpoint(tool, origin);
		const { status, json, parseFailed } = await this.call<unknown>(method, path, args);
		if (status === 426) {
			throw new ClientOutdatedError(errorMessage(json));
		}
		if (status < 200 || status >= 300) {
			throw new Error(errorMessage(json) ?? `HTTP ${status}`);
		}
		if (parseFailed) {
			throw new Error(`Malformed (non-JSON) response from ${path} (HTTP ${status})`);
		}
		return json;
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
		method: string,
		path: string,
		body?: unknown,
		timeoutMs: number = this.timeoutMs,
	): Promise<{ status: number; json: T; parseFailed: boolean }> {
		const { apiKey, baseUrl, keyMeta, tenantSlug } = await this.resolveAuth();
		const { origin } = parseBaseUrl(baseUrl);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
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

/** HTTP methods a platform tool binding may use; anything else falls back to the conventional endpoint. */
const ALLOWED_TOOL_METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Resolves the endpoint for a platform tool call. Honors the manifest-advertised
 * `binding` only when, after full WHATWG URL normalization against the tenant
 * origin, it stays same-origin AND its method is a known HTTP method — otherwise
 * it falls back to the conventional `POST /api/mcp/tools/<name>`. Comparing the
 * *resolved* origin (not the raw string) is essential: a prefix check is defeated
 * by inputs the URL parser rewrites — e.g. `/\host` (backslash becomes `/`) or a
 * path with an embedded tab/CR/LF — which would otherwise smuggle an off-origin
 * host and leak the bearer token. Mirrors the origin-allowlist comparison done at
 * key-save time.
 */
function resolveToolEndpoint(tool: PlatformToolManifestEntry, origin: string): { method: string; path: string } {
	const fallback = { method: "POST", path: `/api/mcp/tools/${encodeURIComponent(tool.name)}` };
	const binding = tool.binding;
	if (!binding) {
		return fallback;
	}
	const method = binding.method.toUpperCase();
	if (!ALLOWED_TOOL_METHODS.has(method)) {
		return fallback;
	}
	try {
		const resolved = new URL(binding.path, origin);
		if (resolved.origin !== origin) {
			return fallback;
		}
		return { method, path: resolved.pathname + resolved.search };
	} catch {
		return fallback;
	}
}

/** Pulls the tool array out of a manifest body — `{ tools: [...] }` or a bare array. */
function extractManifestTools(json: unknown): unknown[] {
	if (Array.isArray(json)) {
		return json;
	}
	if (json !== null && typeof json === "object") {
		const tools = (json as { tools?: unknown }).tools;
		if (Array.isArray(tools)) {
			return tools;
		}
	}
	return [];
}

/**
 * Validates and normalizes one raw manifest entry, mirroring the MCP tool-input
 * schema contract. Requires a non-empty string `name`, a string `description`,
 * and an `inputSchema` object whose `type` is `"object"`. `properties` is
 * OPTIONAL (a zero-arg tool omits it) and is defaulted to `{}` so the advertised
 * schema always carries one; when present it must be a plain (non-array) object.
 * `required`, when present, must be an array of strings. An optional `binding`
 * must be a `{ method, path }` string pair. Any other shape is rejected (returns
 * `null`) so a single malformed tool can neither survive into the advertised
 * registry — where it could make the whole `tools/list` response fail a client's
 * schema validation — nor drop a valid neighbor. Other JSON-Schema keywords on
 * `inputSchema` are preserved.
 *
 * An optional `menu` block is validated at FIELD granularity (see
 * `toPlatformMenuEntry`): unlike `binding`, a malformed `menu` never drops the
 * whole entry — the tool stays callable, it just doesn't appear in the `/jolli`
 * menu. This lets a partially-rolled-out backend add menu metadata without any
 * risk of dropping a working tool.
 */
function toPlatformToolEntry(value: unknown): PlatformToolManifestEntry | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const { name, description, inputSchema, binding, menu } = value as {
		name?: unknown;
		description?: unknown;
		inputSchema?: unknown;
		binding?: unknown;
		menu?: unknown;
	};
	if (typeof name !== "string" || name.trim() === "" || typeof description !== "string") {
		return null;
	}
	if (typeof inputSchema !== "object" || inputSchema === null || Array.isArray(inputSchema)) {
		return null;
	}
	const schema = inputSchema as Record<string, unknown>;
	if (schema.type !== "object") {
		return null;
	}
	// `properties` is optional; when present it must be a plain object, not an array.
	if (
		schema.properties !== undefined &&
		(typeof schema.properties !== "object" || schema.properties === null || Array.isArray(schema.properties))
	) {
		return null;
	}
	// `required`, when present, must be an array of strings.
	if (
		schema.required !== undefined &&
		(!Array.isArray(schema.required) || (schema.required as unknown[]).some((item) => typeof item !== "string"))
	) {
		return null;
	}
	let normalizedBinding: PlatformToolBinding | undefined;
	if (binding !== undefined) {
		if (typeof binding !== "object" || binding === null) {
			return null;
		}
		const { method, path } = binding as { method?: unknown; path?: unknown };
		if (typeof method !== "string" || typeof path !== "string") {
			return null;
		}
		normalizedBinding = { method, path };
	}
	// A zero-arg tool omits `properties`; default it to `{}` without dropping any
	// other schema keywords the backend supplied.
	const inputSchemaOut = (
		schema.properties === undefined ? { ...schema, properties: {} } : schema
	) as PlatformToolManifestEntry["inputSchema"];
	const normalizedMenu = toPlatformMenuEntry(menu);
	return {
		name,
		description,
		inputSchema: inputSchemaOut,
		...(normalizedBinding ? { binding: normalizedBinding } : {}),
		...(normalizedMenu ? { menu: normalizedMenu } : {}),
	};
}

/**
 * Normalizes an optional `menu` block, degrading at field granularity so a bad
 * block never drops the parent tool. A missing/non-object `menu`, or one without a
 * non-empty string `label`, yields `undefined` (the tool is simply absent from the
 * menu). A valid `label` with a malformed `description` / `order` keeps the label
 * and drops only the offending field.
 */
function toPlatformMenuEntry(value: unknown): PlatformToolMenuEntry | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const { label, description, order } = value as { label?: unknown; description?: unknown; order?: unknown };
	if (typeof label !== "string" || label.trim() === "") {
		return undefined;
	}
	const validDescription = typeof description === "string" ? description : undefined;
	const validOrder = typeof order === "number" && Number.isFinite(order) ? order : undefined;
	return {
		label,
		...(validDescription !== undefined ? { description: validDescription } : {}),
		...(validOrder !== undefined ? { order: validOrder } : {}),
	};
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

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

import { createLogger } from "../Logger.js";
import { JOLLI_CLIENT_HEADER } from "./ClientHeader.js";
import { deriveJolliEnvKey, type JolliApiKeyMeta, parseBaseUrl, parseJolliApiKey } from "./JolliApiUtils.js";
import type { WorkflowSummary } from "./LocalRunEligibility.js";
import { loadConfig } from "./SessionTracker.js";
import { currentTraceHeader, newTraceHeader, TRACE_HEADER_NAME } from "./TraceContext.js";
import type {
	JobStatus,
	WorkflowRunPayload,
	WorkflowRunPullRequest,
	WorkflowRunWrittenArticle,
} from "./WorkflowRunReport.js";

const log = createLogger("JolliMemoryPushClient");

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

/**
 * `POST /api/push/jollimemory/batch` returned 404 — the server predates the
 * batch endpoint. Callers leave their pending entries untouched (no retry
 * burn) so a later server deploy picks them up.
 */
export class BatchUnsupportedError extends Error {
	constructor(message?: string) {
		super(message ?? "Jolli server does not support batch push yet");
		this.name = "BatchUnsupportedError";
	}
}

/**
 * Server returned 403 — the API key is valid but lacks permission to write
 * (no `articles.edit` on the bound Space, or a key scope restriction).
 * Distinct from {@link NotAuthenticatedError} so user-facing surfaces (the
 * pre-push result list) don't mislabel a permission problem as "not signed
 * in". Config-class: retrying without a permission change cannot succeed.
 */
export class PermissionDeniedError extends Error {
	constructor(message?: string) {
		super(message ?? "No permission to write to the bound Jolli Space.");
		this.name = "PermissionDeniedError";
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
 * withholds the Space details but not the bound-ness. `canPush` mirrors the
 * server-side `articles.edit` check on the bound Space — the exact permission
 * the push endpoint enforces — so `false` means the next push will 403 (e.g.
 * the caller was demoted to viewer); `null` means an older server that
 * predates the flag (unknown, not broken). A degraded bound response
 * (`canPush === false`) additionally carries the caller's bindable pool in
 * `spaces` + `defaultSpaceId` — the same list `unbound` returns — so a client
 * can offer a rebind (`createBinding` with `replace: true`) without a second
 * read call; both stay `[]`/null on healthy bindings and older servers.
 * `unbound` means several Spaces are bindable and the caller should prompt,
 * then bind via {@link JolliMemoryPushClient.createBinding}.
 */
export type FrontDoorResult =
	| {
			readonly status: "bound";
			readonly binding: {
				readonly jmSpaceId: number | null;
				readonly spaceName: string | null;
				readonly canPush: boolean | null;
			};
			readonly spaces: ReadonlyArray<JolliMemorySpace>;
			readonly defaultSpaceId: number | null;
	  }
	| {
			readonly status: "unbound";
			readonly spaces: ReadonlyArray<JolliMemorySpace>;
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

/**
 * Space-binding probes on interactive paths (`jolli status`, the bare-`jolli`
 * front door) use a much tighter timeout than the 30 s default — same
 * rationale as {@link MANIFEST_TIMEOUT_MS}: a slow-but-reachable server must
 * not stall a command a human is waiting on. A timeout renders as the
 * existing unreachable/skip copy. Background workers (pre-push sync) keep the
 * default — nobody waits on them, and the wider window helps weak networks.
 */
export const SPACE_PROBE_TIMEOUT_MS = 5_000;

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
	readonly binding?: {
		readonly jmSpaceId?: number | null;
		readonly spaceName?: string | null;
		readonly canPush?: boolean | null;
	};
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
	/**
	 * The bound Space the push landed in, echoed by newer servers on
	 * repoUrl-routed pushes. Callers persist it as the local binding cache
	 * (`SpaceBindingCache`) — a successful push proves both the binding and
	 * push rights. Absent on older servers and on legacy default-space pushes.
	 */
	readonly jmSpace?: { readonly id: number; readonly name: string };
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
	readonly jmSpace?: { readonly id?: unknown; readonly name?: unknown };
	readonly error?: string;
	readonly message?: string;
	readonly repoUrl?: string;
}

/**
 * Validates the optional Space echo of a push/pushBatch 2xx body field-by-field
 * so a drifted shape degrades to "absent" rather than poisoning the caller's
 * binding cache.
 */
function parseJmSpaceEcho(
	raw: { readonly id?: unknown; readonly name?: unknown } | undefined,
): { readonly id: number; readonly name: string } | undefined {
	return raw && typeof raw.id === "number" && typeof raw.name === "string" && raw.name.length > 0
		? { id: raw.id, name: raw.name }
		: undefined;
}

// ─── Batch push (POST /api/push/jollimemory/batch) ──────────────────────────

/**
 * Max commits per batch request. MUST stay in lockstep with the server's
 * `BATCH_MAX_ITEMS` (`backend/src/router/PushRouter.ts`) — the server rejects
 * larger payloads with 400.
 */
export const BATCH_MAX_ITEMS = 30;

/**
 * Remaining batch request limits. These MUST stay in lockstep with
 * `BatchPushRequestSchema` in the server's `PushRouter.ts`.
 */
export const BATCH_MAX_ATTACHMENTS_PER_ITEM = 50;
export const BATCH_MAX_CONTENT_CHARS = 2_000_000;
export const BATCH_MAX_TOTAL_CONTENT_CHARS = 8_000_000;

/** One attachment (plan/note/reference) inside a batch item. */
export interface BatchPushAttachment {
	readonly clientKey: string;
	readonly docType: "plan" | "note" | "reference";
	readonly title: string;
	readonly content: string;
	readonly relativePath?: string;
	readonly docId?: number;
}

/** One commit's summary + owned attachments inside a batch payload. */
export interface BatchPushItem {
	readonly commitHash: string;
	readonly branch?: string;
	readonly summary: {
		readonly title: string;
		readonly content: string;
		readonly relativePath?: string;
		readonly docId?: number;
		readonly summaryJson?: string;
	};
	readonly attachments: ReadonlyArray<BatchPushAttachment>;
}

/** Payload for `POST /api/push/jollimemory/batch`. */
export interface BatchPushPayload {
	readonly repoUrl?: string;
	readonly items: ReadonlyArray<BatchPushItem>;
}

/** Per-attachment entry in a batch item result. */
export interface BatchAttachmentResult {
	readonly clientKey: string;
	readonly ok: boolean;
	readonly docId?: number;
	readonly url?: string;
	readonly jrn?: string;
	readonly created?: boolean;
	readonly error?: string;
}

/** Doc fields reported for a successfully pushed batch summary. */
export interface BatchDocResult {
	readonly docId: number;
	readonly url: string;
	readonly jrn: string;
	readonly created: boolean;
	readonly summaryJsonDocId?: number;
}

/** Per-item (= per-commit) entry of the batch response, in request order. */
export interface BatchItemResult {
	readonly commitHash: string;
	readonly ok: boolean;
	readonly summary?: BatchDocResult;
	readonly attachments: ReadonlyArray<BatchAttachmentResult>;
	readonly error?: string;
	readonly errorCode?: string;
}

/** Validated response of `POST /api/push/jollimemory/batch`. */
export interface BatchPushResult {
	readonly results: ReadonlyArray<BatchItemResult>;
	/**
	 * The bound Space the batch landed in, echoed once at the top level by
	 * newer servers on repoUrl-routed pushes (the server resolves the binding
	 * and checks push rights before processing any item, so the echo holds even
	 * when individual items fail). Callers persist it as the local binding
	 * cache (`SpaceBindingCache`). Absent on older servers and on legacy
	 * default-space pushes.
	 */
	readonly jmSpace?: { readonly id: number; readonly name: string };
}

/** Raw shape of `POST /api/push/jollimemory/batch` — validated entry-by-entry. */
interface BatchPushResponseBody {
	readonly results?: unknown;
	readonly jmSpace?: { readonly id?: unknown; readonly name?: unknown };
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
				binding: {
					jmSpaceId: json.binding.jmSpaceId ?? null,
					spaceName: json.binding.spaceName ?? null,
					// Anything but a real boolean (older server, drifted value)
					// collapses to null = unknown, so it can never false-alarm.
					canPush: typeof json.binding.canPush === "boolean" ? json.binding.canPush : null,
				},
				// The rebind pool, present only on degraded bound responses.
				spaces: (json.spaces ?? []).map((s) => ({ id: s.id, name: s.name, slug: s.slug })),
				defaultSpaceId: json.defaultSpaceId ?? null,
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

	/**
	 * Binds a repo to a Jolli Memory space. Server response has no `jmSpaceName` — only `{ binding, repoFolder }`.
	 * `replace: true` is the rebind escape hatch: the server honors it only when
	 * the existing binding is unusable for the caller (no `articles.edit` on its
	 * Space) and answers 409 `binding_replace_not_allowed` otherwise.
	 */
	async createBinding(args: { repoUrl: string; repoName: string; jmSpaceId: number; replace?: boolean }): Promise<{
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
		if (status === 401) {
			throw new NotAuthenticatedError();
		}
		if (status === 403) {
			throw new PermissionDeniedError(errorMessage(json));
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
		// Optional Space echo (newer servers, repoUrl-routed pushes only).
		const jmSpace = parseJmSpaceEcho(json.jmSpace);
		return {
			url: json.url,
			docId: json.docId,
			jrn: json.jrn,
			created: json.created,
			summaryJsonDocId: json.summaryJsonDocId,
			...(jmSpace !== undefined ? { jmSpace } : {}),
		};
	}

	/**
	 * Pushes up to {@link BATCH_MAX_ITEMS} commits (one summary + its owned
	 * plans/notes/references each) in a single `POST /api/push/jollimemory/batch`
	 * request. Whole-request error taxonomy mirrors {@link push}; 404 maps to
	 * {@link BatchUnsupportedError} so the pre-push flow can leave its entries
	 * pending instead of burning retries against a server that predates the
	 * endpoint. Per-item success/failure is reported in `results` (request
	 * order), HTTP 200 even on partial failure.
	 */
	async pushBatch(payload: BatchPushPayload): Promise<BatchPushResult> {
		const { status, json } = await this.call<BatchPushResponseBody>("POST", "/api/push/jollimemory/batch", payload);
		if (status === 404) {
			throw new BatchUnsupportedError();
		}
		if (status === 426) {
			throw new ClientOutdatedError(errorMessage(json) ?? "Client outdated — update the CLI/extension.");
		}
		if (status === 412 && json.error === "binding_required") {
			throw new BindingRequiredError(json.repoUrl ?? payload.repoUrl ?? "", json.message);
		}
		if (status === 401) {
			throw new NotAuthenticatedError();
		}
		if (status === 403) {
			throw new PermissionDeniedError(errorMessage(json));
		}
		if (status < 200 || status >= 300) {
			throw new Error(errorMessage(json) ?? `HTTP ${status}`);
		}
		if (!Array.isArray(json.results)) {
			// Same rationale as push(): a 2xx with a gateway/HTML body must not be
			// mistaken for "everything pushed" — the caller would delete pending
			// entries it never actually synced.
			throw new Error(`Batch push returned HTTP ${status} but the response was missing results`);
		}
		const results: BatchItemResult[] = [];
		for (const entry of json.results) {
			const item = toBatchItemResult(entry);
			if (!item) {
				throw new Error(`Batch push returned HTTP ${status} but a result entry was malformed`);
			}
			results.push(item);
		}
		const okCount = results.filter((r) => r.ok).length;
		log.debug(
			"pushBatch: %d item(s) sent — ok=%d failed=%d",
			payload.items.length,
			okCount,
			results.length - okCount,
		);
		// Optional top-level Space echo (newer servers, repoUrl-routed pushes only).
		const jmSpace = parseJmSpaceEcho(json.jmSpace);
		return { results, ...(jmSpace !== undefined ? { jmSpace } : {}) };
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

	/**
	 * Fetches the candidate local-run workflows by invoking the backend-defined
	 * `list_workflows` platform tool through the manifest path (there is no bespoke
	 * REST endpoint). Best-effort by contract, mirroring {@link fetchManifest}'s
	 * posture: EVERY degrade — platform tools disabled or the tool absent from the
	 * manifest (both yield an empty manifest so the tool is not found), a failed
	 * invocation (non-2xx, network / abort / timeout, a non-JSON body, or an
	 * outdated client), or a malformed workflow body — resolves to `[]` and NEVER
	 * throws. Because it rides the platform-tool path, an empty result is the
	 * normal state when the surface is off or the backend does not yet serve the
	 * tool. Individual malformed workflow entries are dropped rather than failing
	 * the whole list. Accepts either a `{ workflows: [...] }` envelope or a bare
	 * array.
	 *
	 * Deliberately asymmetric to {@link invokePlatformTool} (which throws on a
	 * failed invocation): the eligibility path treats "can't list workflows" as
	 * "nothing to offer", never as an error, so the try/catch here swallows the
	 * invocation throw.
	 */
	async listWorkflows(): Promise<WorkflowSummary[]> {
		// fetchManifest is itself best-effort ([] on every failure, never throws),
		// so an unauthenticated / disabled / unreachable backend simply yields no
		// `list_workflows` entry here.
		const manifest = await this.fetchManifest();
		const tool = manifest.find((entry) => entry.name === LIST_WORKFLOWS_TOOL_NAME);
		if (!tool) {
			return [];
		}
		try {
			const raw = await this.invokePlatformTool(tool, {});
			return parseWorkflowList(raw);
		} catch {
			// A failed invocation (non-2xx / network / abort / malformed body /
			// ClientOutdated) degrades to "no workflows" — unlike a direct platform
			// tool call, the eligibility path must never surface an error.
			return [];
		}
	}

	/**
	 * Fetches one workflow run's enriched status by invoking the backend-defined
	 * `get_run_status` platform tool through the manifest path, unwrapping the
	 * `{ run }` envelope (a bare run object is tolerated defensively).
	 *
	 * Deliberately LOUD-FAIL (unlike {@link listWorkflows}): every failure — the
	 * tool absent from the manifest (platform tools off / older backend), a failed
	 * invocation (non-2xx / 426 / network / abort / non-JSON body), or a
	 * malformed run payload — THROWS, so the remote-run monitor can distinguish
	 * "still running" from "fetch failed" and own retry/terminal/degrade itself.
	 */
	async getRunStatus(runId: string): Promise<WorkflowRunPayload> {
		const manifest = await this.fetchManifest();
		const tool = manifest.find((entry) => entry.name === GET_RUN_STATUS_TOOL_NAME);
		if (!tool) {
			throw new Error(
				`Platform tool "${GET_RUN_STATUS_TOOL_NAME}" is unavailable (platform tools off or backend too old).`,
			);
		}
		const raw = await this.invokePlatformTool(tool, { runId });
		const run = toWorkflowRun(unwrapRun(raw));
		if (!run) {
			throw new Error(`"${GET_RUN_STATUS_TOOL_NAME}" returned a malformed run payload.`);
		}
		return run;
	}

	/**
	 * Lists a workflow's run history (newest first) by invoking the backend-defined
	 * `list_workflow_runs` platform tool through the manifest path, parsing the
	 * `{ runs: [...] }` envelope (a bare array is tolerated defensively) and
	 * dropping malformed entries, mirroring {@link parseWorkflowList}.
	 *
	 * The tool takes the workflow's numeric `id` (NOT a `workflowId` key). LOUD-FAIL
	 * like {@link getRunStatus}: the tool absent from the manifest or a failed
	 * invocation THROWS, and the history command catches and degrades to an empty
	 * list — the failure posture lives in the command, not here.
	 */
	async listWorkflowRuns(workflowId: string | number): Promise<WorkflowRunPayload[]> {
		const manifest = await this.fetchManifest();
		const tool = manifest.find((entry) => entry.name === LIST_WORKFLOW_RUNS_TOOL_NAME);
		if (!tool) {
			throw new Error(
				`Platform tool "${LIST_WORKFLOW_RUNS_TOOL_NAME}" is unavailable (platform tools off or backend too old).`,
			);
		}
		const raw = await this.invokePlatformTool(tool, { id: workflowId });
		return parseRunList(raw);
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

/** Field-by-field validation of one batch summary doc result; undefined on shape mismatch. */
function toBatchDocResult(value: unknown): BatchDocResult | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const raw = value as {
		docId?: unknown;
		url?: unknown;
		jrn?: unknown;
		created?: unknown;
		summaryJsonDocId?: unknown;
	};
	if (typeof raw.docId !== "number" || typeof raw.url !== "string" || typeof raw.jrn !== "string") {
		return undefined;
	}
	return {
		docId: raw.docId,
		url: raw.url,
		jrn: raw.jrn,
		created: raw.created === true,
		...(typeof raw.summaryJsonDocId === "number" && { summaryJsonDocId: raw.summaryJsonDocId }),
	};
}

/**
 * Field-by-field validation of one batch attachment result; undefined on shape
 * mismatch. An `ok: true` entry without a usable docId/url is DOWNGRADED to a
 * failure — same rationale as {@link toBatchItemResult}'s summary downgrade: a
 * malformed success would silently skip the write-back and re-CREATE the
 * attachment on the next push.
 */
function toBatchAttachmentResult(value: unknown): BatchAttachmentResult | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const raw = value as {
		clientKey?: unknown;
		ok?: unknown;
		docId?: unknown;
		url?: unknown;
		jrn?: unknown;
		created?: unknown;
		error?: unknown;
	};
	if (typeof raw.clientKey !== "string" || typeof raw.ok !== "boolean") {
		return undefined;
	}
	if (raw.ok && (typeof raw.docId !== "number" || typeof raw.url !== "string")) {
		return {
			clientKey: raw.clientKey,
			ok: false,
			error: "Batch attachment result was missing docId/url",
		};
	}
	return {
		clientKey: raw.clientKey,
		ok: raw.ok,
		...(typeof raw.docId === "number" && { docId: raw.docId }),
		...(typeof raw.url === "string" && { url: raw.url }),
		...(typeof raw.jrn === "string" && { jrn: raw.jrn }),
		...(typeof raw.created === "boolean" && { created: raw.created }),
		...(typeof raw.error === "string" && { error: raw.error }),
	};
}

/**
 * Field-by-field validation of one batch item result. An `ok: true` entry whose
 * summary fields are unusable is DOWNGRADED to a failure (not dropped): the
 * caller must keep that commit pending rather than delete it blind on a
 * malformed success. Returns undefined only when the entry itself is garbage.
 */
function toBatchItemResult(value: unknown): BatchItemResult | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const raw = value as {
		commitHash?: unknown;
		ok?: unknown;
		summary?: unknown;
		attachments?: unknown;
		error?: unknown;
		errorCode?: unknown;
	};
	if (typeof raw.commitHash !== "string" || typeof raw.ok !== "boolean") {
		return undefined;
	}
	const attachments: BatchAttachmentResult[] = [];
	if (Array.isArray(raw.attachments)) {
		for (const entry of raw.attachments) {
			const attachment = toBatchAttachmentResult(entry);
			if (attachment) {
				attachments.push(attachment);
			}
		}
	}
	if (raw.ok) {
		const summary = toBatchDocResult(raw.summary);
		if (!summary) {
			return {
				commitHash: raw.commitHash,
				ok: false,
				attachments,
				errorCode: "malformed_response",
				error: "Batch item result was missing docId/url",
			};
		}
		return { commitHash: raw.commitHash, ok: true, summary, attachments };
	}
	return {
		commitHash: raw.commitHash,
		ok: false,
		attachments,
		...(typeof raw.error === "string" && { error: raw.error }),
		...(typeof raw.errorCode === "string" && { errorCode: raw.errorCode }),
	};
}

function isErrorBody(value: unknown): value is ErrorResponseBody {
	return typeof value === "object" && value !== null;
}

/**
 * HTTP methods a platform-tool binding may use; anything else falls back to the
 * conventional endpoint. GET (and HEAD) are deliberately excluded: the tool-call
 * contract always relays the invocation's `args` as a JSON request body, and those
 * methods cannot carry one (Node's `fetch` throws `Request with GET/HEAD method
 * cannot have body`). A GET/HEAD-natured binding therefore falls back to the
 * conventional `POST /api/mcp/tools/<name>` endpoint that every tool supports,
 * rather than advertising a method that would throw before reaching the network.
 */
const ALLOWED_TOOL_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Resolves the endpoint for a platform tool call. Honors the manifest-advertised
 * `binding` only when, after full WHATWG URL normalization against the tenant
 * origin, it stays same-origin AND its method is a body-carrying HTTP method
 * (POST/PUT/PATCH/DELETE) — otherwise it falls back to the conventional
 * `POST /api/mcp/tools/<name>` (see {@link ALLOWED_TOOL_METHODS}). Comparing the
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

/** Backend tool name that lists the candidate local-run workflows. */
const LIST_WORKFLOWS_TOOL_NAME = "list_workflows";

/** Backend tool name that returns one run's enriched status (an `{ run }` envelope). */
const GET_RUN_STATUS_TOOL_NAME = "get_run_status";

/** Backend tool name that lists a workflow's runs (a `{ runs }` envelope, newest first). */
const LIST_WORKFLOW_RUNS_TOOL_NAME = "list_workflow_runs";

/** The frozen set of valid wire run statuses; anything else rejects the run entry. */
const RUN_STATUSES: ReadonlySet<string> = new Set<JobStatus>(["queued", "active", "completed", "failed", "cancelled"]);

/** The frozen set of valid run triggers; an unrecognized value is dropped (field-granular). */
const RUN_TRIGGERS: ReadonlySet<string> = new Set(["manual", "schedule", "event"]);

/** The frozen set of valid execution modes; an unrecognized value is dropped (field-granular). */
const RUN_EXECUTION_MODES: ReadonlySet<string> = new Set(["server", "local"]);

/** The frozen set of valid article operations; an unrecognized op drops the article entry. */
const ARTICLE_OPERATIONS: ReadonlySet<string> = new Set(["created", "edited", "deleted"]);

/** The frozen set of valid PR states; an unrecognized state drops the (field-granular) PR. */
const PR_STATES: ReadonlySet<string> = new Set(["open", "merged", "closed"]);

/** Unwraps a `get_run_status` body's `{ run }` envelope; a bare run object is tolerated. */
function unwrapRun(json: unknown): unknown {
	if (json !== null && typeof json === "object" && !Array.isArray(json)) {
		const run = (json as { run?: unknown }).run;
		if (run !== undefined) {
			return run;
		}
	}
	return json;
}

/**
 * Parses a `list_workflow_runs` invocation body into validated
 * {@link WorkflowRunPayload} entries, mirroring {@link parseWorkflowList}: a
 * `{ runs: [...] }` envelope or a bare array is accepted, and any entry that is
 * not a well-formed run (no usable string `id`, or an unrecognized `status`) is
 * dropped rather than failing the whole list.
 */
function parseRunList(json: unknown): WorkflowRunPayload[] {
	return extractRunArray(json)
		.map(toWorkflowRun)
		.filter((run): run is WorkflowRunPayload => run !== null);
}

/** Pulls the run array out of the body — `{ runs: [...] }` or a bare array. */
function extractRunArray(json: unknown): unknown[] {
	if (Array.isArray(json)) {
		return json;
	}
	if (json !== null && typeof json === "object") {
		const runs = (json as { runs?: unknown }).runs;
		if (Array.isArray(runs)) {
			return runs;
		}
	}
	return [];
}

/**
 * Validates one raw run entry into a {@link WorkflowRunPayload}, or `null` if it is
 * malformed. The two load-bearing fields are required: a non-empty string `id` and
 * a `status` in the frozen vocabulary (an unclassifiable status can't be shaped).
 * Every other field is carried through at FIELD granularity — a bad optional value
 * is simply dropped, never failing the whole run — and the never-consumed wire
 * fields (`outputSummary`, `stats`) are ignored. Nested `writtenArticles` entries
 * and the `pullRequest` are each validated the same way (a malformed article is
 * dropped from the manifest; a malformed PR leaves the field absent).
 */
function toWorkflowRun(value: unknown): WorkflowRunPayload | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== "string" || raw.id.trim() === "") {
		return null;
	}
	if (typeof raw.status !== "string" || !RUN_STATUSES.has(raw.status)) {
		return null;
	}
	const completionInfo = toCompletionInfo(raw.completionInfo);
	const pullRequest = toPullRequest(raw.pullRequest);
	return {
		id: raw.id,
		status: raw.status as JobStatus,
		...(typeof raw.workflowId === "number" && Number.isFinite(raw.workflowId) && { workflowId: raw.workflowId }),
		...(typeof raw.createdAt === "string" && { createdAt: raw.createdAt }),
		...(typeof raw.triggeredBy === "string" &&
			RUN_TRIGGERS.has(raw.triggeredBy) && { triggeredBy: raw.triggeredBy as WorkflowRunPayload["triggeredBy"] }),
		...(typeof raw.executionMode === "string" &&
			RUN_EXECUTION_MODES.has(raw.executionMode) && {
				executionMode: raw.executionMode as WorkflowRunPayload["executionMode"],
			}),
		...(typeof raw.startedAt === "string" && { startedAt: raw.startedAt }),
		...(typeof raw.completedAt === "string" && { completedAt: raw.completedAt }),
		...(typeof raw.error === "string" && { error: raw.error }),
		...(completionInfo !== undefined && { completionInfo }),
		...(Array.isArray(raw.writtenArticles) && { writtenArticles: toWrittenArticles(raw.writtenArticles) }),
		...(pullRequest !== undefined && { pullRequest }),
		...(typeof raw.workflowUrl === "string" && { workflowUrl: raw.workflowUrl }),
		...(typeof raw.runUrl === "string" && { runUrl: raw.runUrl }),
		...(typeof raw.canceledBy === "string" && { canceledBy: raw.canceledBy }),
		...(typeof raw.canceledAt === "string" && { canceledAt: raw.canceledAt }),
	};
}

/** Validates the success-only `completionInfo` — an object with a string `message` — else undefined. */
function toCompletionInfo(value: unknown): { message: string } | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const message = (value as { message?: unknown }).message;
	return typeof message === "string" ? { message } : undefined;
}

/** Maps a raw `writtenArticles` array to validated entries, dropping malformed ones. */
function toWrittenArticles(value: unknown[]): WorkflowRunWrittenArticle[] {
	return value.map(toWrittenArticle).filter((article): article is WorkflowRunWrittenArticle => article !== null);
}

/**
 * Validates one raw `writtenArticles` entry, or `null` if malformed. Requires a
 * valid `operation`, a string `path`, and a boolean `active`; `url` must be a
 * string or `null` (an absent/other value is normalized to `null` — not-yet-
 * openable). `docId` / `title` are carried through only when well-typed.
 */
function toWrittenArticle(value: unknown): WorkflowRunWrittenArticle | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const raw = value as Record<string, unknown>;
	if (typeof raw.operation !== "string" || !ARTICLE_OPERATIONS.has(raw.operation)) {
		return null;
	}
	if (typeof raw.path !== "string" || typeof raw.active !== "boolean") {
		return null;
	}
	return {
		operation: raw.operation as WorkflowRunWrittenArticle["operation"],
		path: raw.path,
		active: raw.active,
		url: typeof raw.url === "string" ? raw.url : null,
		...(typeof raw.docId === "number" && Number.isFinite(raw.docId) && { docId: raw.docId }),
		...(typeof raw.title === "string" && { title: raw.title }),
	};
}

/**
 * Validates the `pullRequest` reference, or undefined when absent/malformed (a
 * withheld or no-PR run — normal, never an error). Requires a numeric `number`, a
 * string `url`, and a `state` in the frozen set.
 */
function toPullRequest(value: unknown): WorkflowRunPullRequest | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	if (typeof raw.number !== "number" || !Number.isFinite(raw.number)) {
		return undefined;
	}
	if (typeof raw.url !== "string" || typeof raw.state !== "string" || !PR_STATES.has(raw.state)) {
		return undefined;
	}
	return { number: raw.number, url: raw.url, state: raw.state as WorkflowRunPullRequest["state"] };
}

/**
 * Parses the `list_workflows` invocation body into validated {@link WorkflowSummary}
 * entries, mirroring the defensive manifest parse: a `{ workflows: [...] }`
 * envelope or a bare array is accepted, and any entry that is not a well-formed
 * workflow (no usable `id`/`slug`, or a `destination` lacking a string
 * `syncProtocol`, a boolean `autoApply`, or a non-empty string `jrn`) is dropped
 * rather than failing the whole list.
 */
function parseWorkflowList(json: unknown): WorkflowSummary[] {
	return extractWorkflowArray(json)
		.map(toWorkflowSummary)
		.filter((workflow): workflow is WorkflowSummary => workflow !== null);
}

/** Pulls the workflow array out of the body — `{ workflows: [...] }` or a bare array. */
function extractWorkflowArray(json: unknown): unknown[] {
	if (Array.isArray(json)) {
		return json;
	}
	if (json !== null && typeof json === "object") {
		const workflows = (json as { workflows?: unknown }).workflows;
		if (Array.isArray(workflows)) {
			return workflows;
		}
	}
	return [];
}

/**
 * Validates one raw workflow entry into a {@link WorkflowSummary}, or `null` if it
 * is malformed. The identifier is read from `id` (a finite number — the backend's
 * shape — or a non-empty string), falling back to a non-empty `slug`; the
 * `destination` must carry a string `syncProtocol`, a boolean `autoApply`, and a
 * non-empty string `jrn`. A non-empty string `name` is carried through for display
 * (advisory only); any other extra fields (type, sources, …) are ignored.
 */
function toWorkflowSummary(value: unknown): WorkflowSummary | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const { id, slug, name, destination } = value as {
		id?: unknown;
		slug?: unknown;
		name?: unknown;
		destination?: unknown;
	};
	const identifier = resolveWorkflowId(id, slug);
	if (identifier === null) {
		return null;
	}
	if (typeof destination !== "object" || destination === null || Array.isArray(destination)) {
		return null;
	}
	const { syncProtocol, autoApply, jrn } = destination as {
		syncProtocol?: unknown;
		autoApply?: unknown;
		jrn?: unknown;
	};
	if (typeof syncProtocol !== "string" || typeof autoApply !== "boolean") {
		return null;
	}
	if (typeof jrn !== "string" || jrn.trim() === "") {
		return null;
	}
	const displayName = typeof name === "string" && name.trim() !== "" ? name : undefined;
	return { id: identifier, name: displayName, destination: { syncProtocol, autoApply, jrn } };
}

/**
 * The workflow identifier for `start_local_run`: a finite numeric `id` (the
 * backend's shape — carried as a number so it stays usable as the integer the
 * tool expects), else a non-empty string `id`, else a non-empty `slug`, else
 * `null` (malformed).
 */
function resolveWorkflowId(id: unknown, slug: unknown): string | number | null {
	if (typeof id === "number" && Number.isFinite(id)) {
		return id;
	}
	if (typeof id === "string" && id.trim() !== "") {
		return id;
	}
	if (typeof slug === "string" && slug.trim() !== "") {
		return slug;
	}
	return null;
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
 * `required`, when present, must be an array of strings. A malformed *advertised
 * schema* field — a missing/blank name, a non-string description, or an
 * `inputSchema` that is not an object schema — rejects the whole entry (returns
 * `null`) so a single malformed tool can neither survive into the advertised
 * registry — where it could make the whole `tools/list` response fail a client's
 * schema validation — nor drop a valid neighbor. Other JSON-Schema keywords on
 * `inputSchema` are preserved.
 *
 * The optional `binding` and `menu` blocks are internal routing / curation
 * metadata, never part of the advertised tool schema, so — unlike the schema
 * fields above — a malformed one degrades at FIELD granularity and never drops
 * the tool (see `toPlatformBinding` / `toPlatformMenuEntry`): a bad `binding` is
 * discarded and the generic executor falls back to the conventional
 * `POST /api/mcp/tools/<name>` endpoint; a bad `menu` just leaves the tool absent
 * from the `/jolli` menu. This lets a partially-rolled-out backend ship either
 * without any risk of dropping a working tool.
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
	// A zero-arg tool omits `properties`; default it to `{}` without dropping any
	// other schema keywords the backend supplied.
	const inputSchemaOut = (
		schema.properties === undefined ? { ...schema, properties: {} } : schema
	) as PlatformToolManifestEntry["inputSchema"];
	const normalizedBinding = toPlatformBinding(binding);
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
 * Normalizes an optional `binding` block. Like `menu`, a malformed binding never
 * drops the parent tool: `binding` is internal routing metadata, never part of the
 * advertised tool schema, so a bad one can't poison `tools/list`. A missing,
 * non-object, or array `binding`, or one whose `method`/`path` are not both
 * strings, yields `undefined` — the tool stays callable and the generic executor
 * falls back to the conventional `POST /api/mcp/tools/<name>` endpoint (which is
 * also where a structurally-valid but off-origin/unknown-method binding lands at
 * call time), so a working tool is never lost to a broken binding.
 */
function toPlatformBinding(value: unknown): PlatformToolBinding | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const { method, path } = value as { method?: unknown; path?: unknown };
	if (typeof method !== "string" || typeof path !== "string") {
		return undefined;
	}
	return { method, path };
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

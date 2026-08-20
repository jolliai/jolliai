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

/**
 * The API key is valid but the server refused the push. Two server shapes map
 * here: a 412 `repo_not_allowlisted` (the repo is not registered in a Space that
 * restricts memory repos — an admin must add it) and a push-path 403 (an
 * ownership mismatch, or a missing `articles.edit`/key-scope restriction).
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

/**
 * The server does not have this `docType` enabled (its supported-docType config
 * has no row for it). Raised for `412` + `error: "doctype_not_allowed"`.
 *
 * **Deliberately NOT a `PermissionDeniedError`, and deliberately NOT a member of
 * `REPO_WIDE_REFUSAL_NAMES`.** Mapping it onto the existing admin-action-required
 * class — the way `repo_not_allowlisted` is mapped — reads as the natural choice
 * and is wrong: `PermissionDeniedError` IS a repo-wide refusal, so one unconfigured
 * context kind would abort the whole attachment loop and fail the summary push,
 * i.e. a single missing config row would stop the repo pushing anything at all.
 *
 * Its correct scope is a third tier between "skip one item" and "abort everything":
 * every item of THIS kind will fail for the same reason, so the push loop
 * short-circuits that kind for the rest of the run and keeps pushing the others
 * (see `ContextPush`). It must also not burn a retry budget or mark the commit
 * failed — the summary itself pushes fine.
 */
export class DocTypeNotAllowedError extends Error {
	constructor(
		readonly docType: string,
		message?: string,
	) {
		super(message ?? `The server does not have docType "${docType}" enabled.`);
		this.name = "DocTypeNotAllowedError";
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
 *
 * `no_spaces` means nothing is bindable. Its `restricted` flag distinguishes the
 * two reasons the caller must act on differently: `false` — the caller genuinely
 * has no Space to bind to (create one), the historical meaning; `true` — Spaces
 * exist but every one repo-allowlists its memory repos and THIS repo is on none
 * of those allowlists. That second case is the same admin-action-required
 * condition the push path surfaces as a 412 `repo_not_allowlisted`, so guidance
 * must point at an administrator, not at "create a Space". Older servers omit the
 * field → `restricted: false`, i.e. today's "no Spaces available" behavior.
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
	| { readonly status: "no_spaces"; readonly restricted: boolean };

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
	/**
	 * Override the `x-jolli-client` header for this instance. Set by the IDE
	 * bridge when a plugin surface (IntelliJ, VS Code) proxies its own HTTP
	 * through the CLI: without this, every proxied request would identify as
	 * `cli/<bundled-cli-version>` (because the header is bundler-baked, and
	 * the bundle running is the CLI's), silently rerouting the server's
	 * per-surface min-version gate and per-surface API attribution. Values
	 * follow the `<kind>/<version>` shape enforced by the server, e.g.
	 * `intellij-plugin/0.99.4`. Undefined → default `JOLLI_CLIENT_HEADER`.
	 */
	readonly clientHeaderOverride?: string;
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

/**
 * Raw shape of `GET /api/jolli-memory/spaces` — validated field-by-field at parse time.
 *
 * Two shapes are accepted (spec 95, "Notable"): the envelope form used by
 * current backends, and a raw flat-array body used by pre-default backends.
 * Tolerating both keeps the Binding Chooser rendering Spaces from older
 * servers instead of masking the response as an empty list; the flat form
 * has no `defaultSpaceId`, which callers treat as `null`.
 */
type ListSpaceEntry = { readonly id: number; readonly name: string; readonly slug: string };
type ListSpacesResponseBody =
	| {
			readonly spaces?: ReadonlyArray<ListSpaceEntry>;
			readonly defaultSpaceId?: number | null;
	  }
	| ReadonlyArray<ListSpaceEntry>;

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
	/** On `no_spaces`: Spaces exist but all repo-allowlist and this repo is on none. Absent on older servers → false. */
	readonly restricted?: boolean;
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
	/**
	 * Document-type tag. `"summary"` is the reserved tag for the memory itself;
	 * every other value is a context kind's `docType`, supplied by its
	 * `ContextKindDefinition` (see `core/push/kinds/`).
	 *
	 * Typed as `string`, not a union, on purpose: a union here would have to grow by
	 * one member for every new context kind — the exact per-kind edit the definition
	 * table exists to remove. The authority on which tags are accepted is the server's
	 * supported-docType configuration, which rejects an unknown one with
	 * `412 doctype_not_allowed` → {@link DocTypeNotAllowedError}. The read path has
	 * always typed this field as a plain string (`SyncTypes.docType`).
	 */
	readonly docType: string;
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
 * Validates the optional Space echo of a push 2xx body field-by-field
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

// ─── Context attachment payload shape ───────────────────────────────────────

/**
 * One context attachment (plan/note/reference/skill/…) as assembled per commit.
 *
 * The batch endpoint that consumed these in bulk is gone (see the note in
 * `PushExecutor`), so nothing here sends a `BatchPushAttachment` any more — the
 * shape survives because `buildContextBatchAttachments` in `push/ContextPush.ts`
 * still assembles one per registered kind, and its tests are what pin the
 * per-kind title/body/docId-reuse rules the single-doc {@link push} path relies
 * on. Keep it in sync with a kind definition's output, not with any request body.
 */
export interface BatchPushAttachment {
	readonly clientKey: string;
	/** A context kind's `docType` — see the note on {@link PushPayload.docType} for why this is `string`. */
	readonly docType: string;
	readonly title: string;
	readonly content: string;
	readonly relativePath?: string;
	readonly docId?: number;
}

/**
 * The server's cursor is BEHIND the one the client sent, so this backend is
 * missing a range the client believes it already delivered. Raised for `409` +
 * `error: "cursor_ahead"`, carrying the server's own cursor to fall back to.
 *
 * The case it exists for is mundane and otherwise silent: a user pushes to a dev
 * backend, then points the same install at prod. The local cursor still says
 * "delivered up to T" while prod has nothing, so without this the range before T
 * would never be sent anywhere again. A wiped, rolled-back or restored-from-
 * backup server is the same shape.
 *
 * ⚠ A server with NO record must answer this too, not 200 — see
 * `SessionSyncRunner` for why "no opinion" is the one reading that loses data.
 */
export class SessionCursorAheadError extends Error {
	constructor(readonly serverCursor: Readonly<Record<string, SessionPushCursor | number | null>>) {
		super("the server is missing a range this client considers delivered");
		this.name = "SessionCursorAheadError";
	}
}

/**
 * How far one table has been delivered — the wire form of `TableCursor`.
 *
 * `key` is the PRIMARY KEY of the last row accepted, in the order the client's
 * `KEYSET_COLUMNS` declares, and it exists because a millisecond is not a unique
 * position: rows written together share a stamp, and when more of them share one
 * than a batch holds, a stamp-only cursor cannot get past that millisecond at
 * all. The server stores and returns the pair verbatim; it never has to
 * interpret `key`, only keep it beside its stamp.
 *
 * An EMPTY key means the start of that millisecond, so a position carrying only
 * a stamp is a valid position on the same scale — see `SessionPushResult.cursor`
 * for why the wire still has to read one.
 */
export interface SessionPushCursor {
	readonly stamp: number;
	readonly key: ReadonlyArray<string>;
}

/**
 * This backend does not have the session endpoint — a `404`, or a 2xx whose body
 * is not JSON (a single-page app answering an unknown route with its
 * `index.html`, which is what production actually did).
 *
 * ⚠ A CLASS, deliberately, and never a regex over the message. It replaces a
 * `/HTTP 404/` test in `SessionSyncRunner`, which was fragile by construction:
 * a non-2xx here is raised as `errorMessage(json) ?? \`HTTP ${status}\``, so any
 * backend or gateway that answers 404 with a JSON error body (`{"error":"Not
 * Found"}` is the normal shape) produced the message `Not Found` — with no
 * status in it, no match, and therefore NO 24h silence: the channel then retried
 * a missing endpoint every 30 minutes for ever, logging one `info` line each
 * time. 403 and 426 already had status-keyed classes; these two are the ones that
 * were left to string matching.
 */
export class SessionEndpointMissingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionEndpointMissingError";
	}
}

/**
 * The server made a binding a precondition for the session channel (`412`).
 *
 * Should be unreachable — session statistics need no Space, since the API key
 * already carries the organisation. Its own class for the same reason as
 * {@link SessionEndpointMissingError}: it is the branch that has to be FINDABLE
 * rather than retried into the ground, and a 412 is the response most likely of
 * all to carry the server's own explanatory prose in `message` — which is
 * exactly what made a `/HTTP 412/` regex miss it.
 */
export class SessionPreconditionFailedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionPreconditionFailedError";
	}
}

/** The session channel's request envelope. `tables` carries local column names verbatim. */
export interface SessionPushPayload {
	/** 1 — this channel's only protocol. `cursor` is `{stamp, key}` throughout. */
	readonly version: 1;
	readonly clientId: string;
	/** Client progress, per table — reconciled by the server on every request. */
	readonly cursor: Readonly<Record<string, SessionPushCursor>>;
	readonly tables: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>;
}

export interface SessionPushResult {
	readonly accepted: Readonly<Record<string, number>>;
	/**
	 * The server's cursor AFTER this batch. The client adopts it as-is.
	 *
	 * A bare `number` is accepted and read as `{stamp, key: []}`. The CLI and the
	 * backend deploy independently, so this is wire tolerance rather than a
	 * migration: a backend that echoes only a stamp keeps working, at the cost of
	 * re-delivering one millisecond per pass into an upsert.
	 */
	readonly cursor: Readonly<Record<string, SessionPushCursor | number | null>>;
}

export class JolliMemoryPushClient {
	private readonly fetchImpl: typeof fetch;
	private readonly baseUrlOverride?: string;
	private readonly apiKeyProvider: () => Promise<string | undefined>;
	private readonly timeoutMs: number;
	private readonly clientHeaderOverride?: string;

	constructor(opts: JolliMemoryPushClientOpts = {}) {
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.baseUrlOverride = opts.baseUrlOverride;
		this.apiKeyProvider = opts.apiKeyProvider ?? defaultApiKeyProvider;
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.clientHeaderOverride = opts.clientHeaderOverride;
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
		// Accept both the `{ spaces, defaultSpaceId }` envelope and a raw flat-array
		// body (pre-default backends): spec 95 mandates this two-shape tolerance so
		// the Binding Chooser renders Spaces from older servers instead of masking
		// the response as an empty list. Flat form implies `defaultSpaceId = null`.
		if (Array.isArray(json)) {
			const spaces = json.map((s) => ({ id: s.id, name: s.name, slug: s.slug }));
			return { spaces, defaultSpaceId: null };
		}
		const envelope = json as {
			readonly spaces?: ReadonlyArray<ListSpaceEntry>;
			readonly defaultSpaceId?: number | null;
		};
		const spaces = (envelope.spaces ?? []).map((s) => ({ id: s.id, name: s.name, slug: s.slug }));
		return { spaces, defaultSpaceId: envelope.defaultSpaceId ?? null };
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
			// Older servers omit `restricted` → false, preserving today's
			// "no Spaces available" guidance. `true` = Spaces exist but this repo
			// isn't allowlisted on any of them (admin-action-required).
			return { status: "no_spaces", restricted: json.restricted === true };
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
		// The allowlist refusal: the server emits `repo_not_allowlisted` as 412 (NOT
		// 403 — that status is the bind path's `space_restricted`). Treat it like the
		// other admin-action-required rejections so `classifyError` holds the retry
		// budget instead of hammering the server with doomed pushes.
		if (status === 412 && json.error === "repo_not_allowlisted") {
			throw new PermissionDeniedError(errorMessage(json));
		}
		// The server has no config row enabling this docType. Same 412 + machine-tag
		// shape as `repo_not_allowlisted` (it is likewise a configuration problem, not
		// a transient one) but a DIFFERENT error class on purpose — see
		// `DocTypeNotAllowedError` for why reusing PermissionDeniedError would stop
		// the repo pushing anything at all.
		if (status === 412 && json.error === "doctype_not_allowed") {
			throw new DocTypeNotAllowedError(payload.docType, errorMessage(json));
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
	 * Sends one session-sync batch.
	 *
	 * ⚠ This channel's failures do NOT mean what the memory push's do, and reusing
	 * that mapping would produce a user-visible regression in an unrelated place.
	 * `push()` treats 401/403/412 as "the binding was refused" and clears the
	 * cached repo→Space binding; this channel never consults a binding at all (the
	 * API key already carries the org, so nothing has to be bound for session
	 * statistics to have a home). Clearing that cache here would make `jolli
	 * status` and the editors' Space panel re-probe, and briefly show a degraded
	 * Space — over a failure that has nothing to do with Spaces.
	 *
	 * So: 403 and 404 are "not enabled here", to be silenced machine-wide by the
	 * caller; 412 should be impossible and is treated the same way but logged as a
	 * warning, because seeing one means the server has made a binding a
	 * precondition after all.
	 */
	async pushSessions(payload: SessionPushPayload): Promise<SessionPushResult> {
		const { status, json, parseFailed } = await this.call<{
			error?: string;
			message?: string;
			accepted?: Record<string, number>;
			cursor?: Record<string, SessionPushCursor | number | null>;
		}>("POST", "/api/push/jollimemory/sessions", payload);
		if (status === 409 && json.error === "cursor_ahead") {
			throw new SessionCursorAheadError(json.cursor ?? {});
		}
		if (status === 401) throw new NotAuthenticatedError();
		if (status === 403) throw new PermissionDeniedError(errorMessage(json));
		if (status === 426)
			throw new ClientOutdatedError(json.message ?? "Client outdated — update the CLI/extension.");
		// 404 and 412 are classified HERE, by status, and the two lines are the whole
		// point: the caller silences a scope for 24h on either, and it used to decide
		// that by matching `/HTTP 404/` and `/HTTP 412/` against the message raised on
		// the generic line below. That message is `errorMessage(json)` whenever the
		// body carries one, so a backend answering 404 with `{"error":"Not Found"}` —
		// the ordinary gateway shape — produced `Not Found`, matched neither regex, and
		// got retried every 30 minutes for ever. A status is not a substring of prose;
		// keep these keyed on the number.
		if (status === 404)
			throw new SessionEndpointMissingError(
				errorMessage(json) ?? "HTTP 404 — the backend does not implement /api/push/jollimemory/sessions",
			);
		if (status === 412) throw new SessionPreconditionFailedError(errorMessage(json) ?? `HTTP ${status}`);
		if (status < 200 || status >= 300) throw new Error(errorMessage(json) ?? `HTTP ${status}`);
		if (parseFailed) {
			// ⚠ THE most important check on this path, and it was the one missing.
			// A single-page app answers an unknown route with 200 and its index.html,
			// so a backend that has not deployed this endpoint is indistinguishable
			// from one that has — the defensive parse in `call` turns that HTML into
			// `{}`, `accepted` and `cursor` both read as empty, the caller falls back
			// to its own high-water mark, and the cursor advances over rows that
			// reached nobody. Measured against production: every request answered
			// `200` with `<!doctype html>`, the channel reported success for months,
			// and nothing had ever been ingested.
			//
			// Every other method here already checks this. Failing loudly costs a
			// retry; not checking costs the data silently, which is the one outcome
			// a sync must never have.
			// Same CLASS as a 404, because it means the same thing: this deployment
			// does not have the endpoint. Raising it as a bare `Error` left the caller
			// recognising it by the phrase "may not implement this endpoint", which is
			// the same fragility as the status regexes above one step removed.
			throw new SessionEndpointMissingError(
				`Malformed (non-JSON) response from /api/push/jollimemory/sessions (HTTP ${status}) — ` +
					"the backend may not implement this endpoint",
			);
		}
		if (Object.keys(payload.tables).length > 0 && json.accepted === undefined && json.cursor === undefined) {
			// A well-formed JSON 2xx that carries NEITHER an accepted count nor a
			// cursor is not a valid acknowledgement — an ingesting endpoint always
			// answers with at least one. Left as "full success" it defaulted both to
			// `{}`, so every table fell through to the batch's own high-water mark and
			// the cursor advanced over rows the server never stored (the parse-failure
			// case above is only the non-JSON shape of this same hole). Same CLASS as a
			// missing endpoint: fail loudly, never advance. A conforming backend that
			// genuinely has no per-table cursor opinion still returns an `accepted`
			// map, so this rejects only the empty-ack shape.
			//
			// GATED on rows actually being SENT. This guard's whole rationale is "do not
			// advance the cursor over unstored rows", and the empty-batch RECONCILE ping
			// (`SessionSyncRunner.sync`'s one request per throttle window with `tables:
			// {}`) has no rows to advance over — its `localMaxima` is empty, so it cannot
			// move the cursor regardless of the answer, and its purpose is served entirely
			// by the server's own 409/cursor-behind reply, not by this ack. Without the
			// gate, a backend that answers that idle ping with a bare `{}` would silence
			// the whole channel for 24h over the steady-state request of an idle machine.
			throw new SessionEndpointMissingError(
				`Response from /api/push/jollimemory/sessions (HTTP ${status}) carried neither an accepted count nor a ` +
					"cursor — treating as an unimplemented endpoint rather than advancing the cursor over unstored rows",
			);
		}
		return { accepted: json.accepted ?? {}, cursor: json.cursor ?? {} };
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
	 * (`GET /api/mcp/manifest`). Best-effort by contract: it NEVER throws, so a
	 * disabled or older backend degrades to "no platform tools" instead of
	 * breaking MCP-server startup. Malformed individual entries are dropped
	 * rather than failing the whole manifest. Accepts either a `{ tools: [...] }`
	 * envelope or a bare array.
	 *
	 * `undefined` means the fetch FAILED — a non-2xx status (including 404 when
	 * the surface is off and 403 when the key lacks permission), no api key
	 * configured, a network / abort / timeout error, or a non-JSON body. `[]`
	 * means the backend answered and this tenant genuinely has no platform tools.
	 * Both used to be `[]`, which cost the caller the only signal it had: the
	 * daemon retries a failed fetch on the next connection, and an empty tenant
	 * therefore re-fetched the manifest on EVERY connection, forever, with the
	 * await sitting in front of that client's server construction.
	 */
	async fetchManifest(): Promise<PlatformToolManifestEntry[] | undefined> {
		try {
			const { status, json, parseFailed } = await this.call<unknown>(
				"GET",
				"/api/mcp/manifest",
				undefined,
				MANIFEST_TIMEOUT_MS,
			);
			if (status < 200 || status >= 300 || parseFailed) {
				return undefined;
			}
			return extractManifestTools(json)
				.map(toPlatformToolEntry)
				.filter((entry): entry is PlatformToolManifestEntry => entry !== null);
		} catch {
			// NotAuthenticatedError (no key / no resolvable URL), a rejected fetch,
			// or an abort — none of which distinguish "no tools" from "could not ask".
			return undefined;
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
			"x-jolli-client": this.clientHeaderOverride ?? JOLLI_CLIENT_HEADER,
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

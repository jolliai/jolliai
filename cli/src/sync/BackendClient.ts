/**
 * HTTP client for the Memory Bank sync backend endpoints (JOLLI-1316).
 *
 * Four endpoints, all under `/api/mb-sync/*`, matching backend
 * `MemoryBankSyncRouter.ts`:
 *
 *   - `POST /credentials` — mint a short-lived Installation Token and learn
 *     the personal space's current backing (`db` or `git`). On the first
 *     call the backend transparently provisions the GitHub repo + space row
 *     as a side effect; the client receives the same response shape either
 *     way (`alreadyVaultBound` carries the state).
 *
 *   - `POST /notify-push` — fire-and-forget "I just pushed sha X on branch Y"
 *     notification, the primary trigger for the backend's read-mirror fetch.
 *     Body shape (zod-validated server-side): `{ commitSha: hex7-40, branch }`.
 *     Errors are swallowed by callers; the GitHub webhook + reconciler cover
 *     the lost-message case.
 *
 *   - `GET /legacy-content` — dump every alive doc in the caller's
 *     `backing_type=db` personal space so the plugin can merge it into the
 *     vault repo on first sync. Idempotent: once the space is git-backed the
 *     response is `alreadyMigrated: true` with an empty `docs[]`.
 *
 *   - `POST /complete-migration` — flip the personal space from
 *     `backing_type=db` to `git` once the plugin has finished pushing the
 *     merged content. Idempotent: re-calling on an already-git space is a
 *     200 no-op.
 *
 * All calls use the **same auth pattern as `JolliPushService.pushToJolli`** —
 * the Jolli backend uses tenant-scoped routing, so every `/api/*` request:
 *
 *   1. Authenticates with `Authorization: Bearer <jolliApiKey>` where
 *      `jolliApiKey` is the `sk-jol-*` key from `~/.jolli/jollimemory/config.json`
 *      (NOT the OAuth `authToken`). The key encodes the tenant URL in its
 *      base64url-decoded payload.
 *   2. Is sent to the **tenant subdomain** derived from
 *      `parseJolliApiKey(key).u` — sending to the bare `jolli-local.me` /
 *      `jolli.ai` origin yields `403 tenant_resolution_failed`.
 *   3. Carries `x-tenant-slug` (from the URL path) and `x-org-slug`
 *      (from `keyMeta.o`) so the backend's tenant middleware can route.
 *
 * Errors are wrapped in typed exceptions (`SyncBackendError` /
 * `SyncBackendUnauthorizedError` / `SyncBackendNetworkError`) so the engine
 * can pattern-match: 401 → re-mint and retry, network error → degrade to
 * `offline`, other 4xx/5xx → bubble up with diagnostics.
 */

import { JOLLI_CLIENT_HEADER } from "../core/ClientHeader.js";
import { parseBaseUrl, parseJolliApiKey } from "../core/JolliApiUtils.js";
import type { GitCredentials, LegacyContentResponse } from "./SyncTypes.js";

/** Generic non-2xx response from the sync backend. */
export class SyncBackendError extends Error {
	readonly status: number;
	readonly body: string;
	constructor(status: number, message: string, body: string) {
		super(message);
		this.name = "SyncBackendError";
		this.status = status;
		this.body = body;
	}
}

/**
 * Specific 401 case — the cached/saved token is invalid. The engine maps
 * this to "clear token cache + re-mint once before giving up".
 */
export class SyncBackendUnauthorizedError extends SyncBackendError {
	constructor(body: string) {
		super(401, "Sync backend rejected the auth token (401)", body);
		this.name = "SyncBackendUnauthorizedError";
	}
}

/**
 * Specific 423 case (plan §0.8) — the vault-write lock is currently held
 * by another device. The engine retries `mintGitCredentials` with a fixed
 * 5 s delay up to 6 times before giving up.
 *
 * `message` is user-facing (flows into `SyncRoundResult.lastError.message`
 * → status bar tooltip), so it uses the product-level label "Personal
 * Space" instead of the internal "vault" / "lock" jargon.
 */
export class VaultLockedError extends SyncBackendError {
	constructor(body: string) {
		super(423, "Personal Space is being synced by another device", body);
		this.name = "VaultLockedError";
	}
}

/**
 * Wrapped network-layer failure (DNS, ECONNREFUSED, ETIMEDOUT, AbortError).
 * Distinct from `SyncBackendError` because the engine treats these as
 * "transient — drop to `offline` state, retry next poll tick".
 */
export class SyncBackendNetworkError extends Error {
	readonly cause: unknown;
	constructor(cause: unknown) {
		super("Sync backend unreachable");
		this.name = "SyncBackendNetworkError";
		this.cause = cause;
	}
}

/**
 * Specific 503 case — the backend's web-side flusher has not yet flushed
 * pending Web UI edits to GitHub. Minting credentials right now would let
 * the CLI clone a stale tree and then overwrite the pending web edits, so
 * the backend deliberately refuses with `pending_flush_failed` + a
 * `retryAfterSeconds` hint. Engine mirrors the 423 retry path: emit
 * `waiting`, sleep `retryAfterSeconds`, retry within the mint budget.
 */
export class WebFlushPendingError extends SyncBackendError {
	readonly retryAfterSeconds: number;
	constructor(body: string, retryAfterSeconds: number) {
		super(503, "Waiting for web edits to upload to GitHub", body);
		this.name = "WebFlushPendingError";
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

/**
 * Raw shape of the JSON response from `POST /api/mb-sync/credentials`. All
 * fields optional at the type level because we validate them at parse time
 * and produce a typed `SyncBackendError(502)` for any missing required field.
 */
interface MintResponseBody {
	readonly token?: string;
	readonly expiresAt?: string | number;
	readonly repoFullName?: string;
	readonly repoCloneUrl?: string;
	readonly defaultBranch?: string;
	readonly githubRepoCreated?: boolean;
	readonly alreadyVaultBound?: boolean;
	readonly lockOwnerToken?: string;
}

/** Test seam — swap in a stub `fetch` to drive unit tests deterministically. */
export interface BackendClientOpts {
	readonly fetchImpl?: typeof fetch;
	/**
	 * Override the resolved base URL — useful for tests against `file://` or
	 * local mocks. When omitted, the base URL comes from
	 * `parseJolliApiKey(jolliApiKey).u`.
	 */
	readonly baseUrlOverride?: string;
	/** Override the jolliApiKey loader. Default: read `jolliApiKey` from `SessionTracker.loadConfig`. */
	readonly jolliApiKeyProvider?: () => Promise<string | undefined>;
	/** Default 10 s per request (mint should be sub-second; tighten if needed). */
	readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class BackendClient {
	private readonly fetchImpl: typeof fetch;
	private readonly baseUrlOverride?: string;
	private readonly jolliApiKeyProvider: () => Promise<string | undefined>;
	private readonly timeoutMs: number;

	constructor(opts: BackendClientOpts = {}) {
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.baseUrlOverride = opts.baseUrlOverride;
		this.jolliApiKeyProvider = opts.jolliApiKeyProvider ?? defaultJolliApiKeyProvider;
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/**
	 * Mints a fresh Installation Token + reports the personal space's current
	 * backing. On the user's first ever call, the backend provisions the
	 * GitHub repo before responding (transparent to the client). Returns
	 * `alreadyVaultBound: false` until the plugin completes the legacy
	 * migration (see `getLegacyContent` + `completeMigration`).
	 */
	async mintGitCredentials(): Promise<GitCredentials> {
		const body = await this.request<MintResponseBody>("POST", "/api/mb-sync/credentials", {});

		const missing = missingMintFields(body);
		if (missing.length > 0) {
			throw new SyncBackendError(
				502,
				`Sync backend returned an incomplete mint response (missing ${missing.join(", ")})`,
				JSON.stringify(body),
			);
		}

		// Defense in depth: the askpass helper injects a bearer token into
		// the clone URL. If a misconfigured / compromised backend ever
		// returned `http://…`, that token would flow over cleartext. The
		// product contract is "always https://github.com/…", so a
		// non-https scheme is a hard server-side bug rather than a value
		// to recover from — fail loud at the boundary instead of letting
		// `injectGithubAppUsername`'s silent pass-through carry it down.
		const cloneUrl = body.repoCloneUrl as string;
		let parsedCloneUrl: URL;
		try {
			parsedCloneUrl = new URL(cloneUrl);
		} catch {
			throw new SyncBackendError(
				502,
				`Sync backend returned an unparseable repoCloneUrl: ${cloneUrl}`,
				JSON.stringify(body),
			);
		}
		if (parsedCloneUrl.protocol !== "https:") {
			throw new SyncBackendError(
				502,
				`Sync backend returned a non-https repoCloneUrl (${parsedCloneUrl.protocol}//…); refusing to attach bearer token over cleartext`,
				JSON.stringify(body),
			);
		}

		const expiresAtRaw = body.expiresAt as string | number;
		const expiresAt = typeof expiresAtRaw === "number" ? expiresAtRaw : Date.parse(expiresAtRaw);
		if (!Number.isFinite(expiresAt)) {
			throw new SyncBackendError(
				502,
				`Sync backend returned an invalid expiresAt: ${String(body.expiresAt)}`,
				JSON.stringify(body),
			);
		}

		return {
			// `repoCloneUrl` is backend's canonical name; mirror it into `gitUrl`
			// because the rest of the client refers to the clone URL by that name.
			gitUrl: cloneUrl,
			token: body.token as string,
			expiresAt,
			repoFullName: body.repoFullName as string,
			defaultBranch: body.defaultBranch as string,
			/* v8 ignore next -- backend always emits `githubRepoCreated`; ?? fallback is defensive belt-and-suspenders for older backend versions */
			githubRepoCreated: body.githubRepoCreated ?? false,
			alreadyVaultBound: body.alreadyVaultBound as boolean,
			lockOwnerToken: body.lockOwnerToken as string,
		};
	}

	/**
	 * Fire-and-forget notification that `commitSha` was just pushed on
	 * `branch`. Backend zod-validates: `commitSha` must be 7-40 hex,
	 * `branch` 1-255 chars, `lockOwnerToken` 32-char lowercase hex.
	 * Callers should swallow errors — the webhook + reconciler paths
	 * cover lost messages — but we still surface typed errors here for
	 * tests / logs.
	 *
	 * Plan §0.8: the personal-space write lock is acquired by the matching
	 * `/credentials` call and released by this call on the steady-state
	 * push success path. The backend verifies ownership via
	 * `lockOwnerToken`, which must be the value the matching `/credentials`
	 * response returned.
	 *
	 * Failure-path release: a round that mints but never reaches a
	 * successful `notifyPush` / `completeMigration` (push rejected, pull-
	 * rebase abort, idle short-circuit, network drop, exception inside
	 * `doRound`) goes through `SyncEngine.runRound`'s finally and calls
	 * `releaseLock` against the same token — see `releaseLock` below.
	 * Backend's 5–9 min TTL is only the backstop for cases where neither
	 * client-side release path can run (SIGKILL, power loss, etc.).
	 *
	 * A missing or malformed `lockOwnerToken` is rejected with 400
	 * `invalid_request` — that signals a client bug (token not threaded
	 * through the round), never a recoverable runtime condition.
	 */
	async notifyPush(args: {
		readonly commitSha: string;
		readonly branch: string;
		readonly lockOwnerToken: string;
	}): Promise<void> {
		await this.request<unknown>("POST", "/api/mb-sync/notify-push", {
			commitSha: args.commitSha,
			branch: args.branch,
			lockOwnerToken: args.lockOwnerToken,
		});
	}

	/**
	 * JOLLI-1577 — per-round teardown safety net. Releases the backend
	 * Personal Space write-lock identified by `lockOwnerToken`. Called from
	 * `SyncEngine.runRound`'s finally on every round outcome that did NOT
	 * already release via `notifyPush` (steady-state push success) or
	 * `completeMigration` (first-bind success).
	 *
	 * Without this call, every failure-path mint would leave the lock
	 * held until the backend's 5–9 min TTL expired, during which every
	 * other device the same user owns would see "Personal Space is being
	 * synced by another device" with no possible action.
	 *
	 * Backend returns `202 { released: true }`. Idempotent: 404 from a
	 * never-held / TTL-expired token is recoverable (the finally caller
	 * swallows it); 400 `invalid_request` indicates a client bug
	 * (malformed token) and should surface in logs.
	 *
	 * Rate-limited backend-side (`vault_release_lock`) so the plugin MUST
	 * call at most once per round teardown.
	 *
	 * Callers MUST swallow errors — the backend's TTL is the backstop,
	 * and propagating release failure into the round result would mask
	 * the original outcome the user cares about.
	 */
	async releaseLock(args: { readonly lockOwnerToken: string }): Promise<void> {
		await this.request<unknown>("POST", "/api/mb-sync/release-lock", {
			lockOwnerToken: args.lockOwnerToken,
		});
	}

	/**
	 * Fetch the caller's legacy `backing_type=db` content so the plugin can
	 * merge it into the new git-backed vault. Idempotent — if the space is
	 * already git-backed, the response is `alreadyMigrated: true` with an
	 * empty `docs[]`, and the caller should skip the migration step.
	 */
	async getLegacyContent(): Promise<LegacyContentResponse> {
		return await this.request<LegacyContentResponse>("GET", "/api/mb-sync/legacy-content", undefined);
	}

	/**
	 * Tell the backend that the plugin has finished pushing the merged
	 * content to the vault repo, so it can flip the space's backing from
	 * legacy DB to git and release the per-space write lock. Idempotent —
	 * re-calling on an already-git space returns `alreadyMigrated: true`.
	 *
	 * `commitSha` is the migration HEAD just pushed; `lockOwnerToken` is
	 * the value the matching `/credentials` call returned. Both are
	 * required by the backend's zod schema — pre-fix the plugin sent an
	 * empty body and got hard-blocked by 400, which silently prevented
	 * `metadata.vault` from ever being written.
	 */
	async completeMigration(args: {
		readonly commitSha: string;
		readonly lockOwnerToken: string;
	}): Promise<{ readonly alreadyMigrated: boolean }> {
		const body = await this.request<{ readonly alreadyMigrated?: boolean }>(
			"POST",
			"/api/mb-sync/complete-migration",
			{ commitSha: args.commitSha, lockOwnerToken: args.lockOwnerToken },
		);
		return { alreadyMigrated: Boolean(body.alreadyMigrated) };
	}

	/**
	 * Exposes the currently-resolved `jolliApiKey` so the engine can scope
	 * `pending-lock.json` entries by a hash of the key (account-switch
	 * invalidation). Returns `undefined` when the user is signed out — the
	 * engine treats that as "no self-lock evidence available".
	 */
	async getJolliApiKey(): Promise<string | undefined> {
		return this.jolliApiKeyProvider();
	}

	private async request<T>(method: "GET" | "POST", path: string, payload: unknown): Promise<T> {
		const apiKey = await this.jolliApiKeyProvider();
		if (!apiKey) {
			throw new SyncBackendUnauthorizedError('{"error":"no_jolli_api_key"}');
		}
		const keyMeta = parseJolliApiKey(apiKey);
		if (!keyMeta) {
			throw new SyncBackendUnauthorizedError('{"error":"invalid_jolli_api_key"}');
		}

		const baseUrl = this.baseUrlOverride ?? keyMeta.u;
		const parsed = parseBaseUrl(baseUrl);
		const url = new URL(path, parsed.origin).toString();

		const headers: Record<string, string> = {
			Authorization: `Bearer ${apiKey}`,
			"x-jolli-client": JOLLI_CLIENT_HEADER,
		};
		if (method === "POST") {
			headers["Content-Type"] = "application/json";
		}
		if (parsed.tenantSlug) {
			headers["x-tenant-slug"] = parsed.tenantSlug;
		}
		if (keyMeta.o) {
			headers["x-org-slug"] = keyMeta.o;
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);

		let response: Response;
		try {
			const init: RequestInit = {
				method,
				headers,
				signal: controller.signal,
			};
			if (method === "POST") {
				/* v8 ignore next -- every POST caller in this file passes an explicit payload object; the `?? {}` only protects against future callers that forget */
				init.body = JSON.stringify(payload ?? {});
			}
			response = await this.fetchImpl(url, init);
		} catch (cause) {
			throw new SyncBackendNetworkError(cause);
		} finally {
			clearTimeout(timer);
		}

		const text = await response.text();
		if (response.status === 401 || response.status === 403) {
			throw new SyncBackendUnauthorizedError(text);
		}
		if (response.status === 423) {
			// Vault is locked by another device's in-flight sync round (plan §0.8).
			// Caller `mintGitCredentials` retries with backoff; other endpoints
			// shouldn't normally see 423 but propagate the typed error all the
			// same so they fail fast instead of being mis-classified as generic.
			throw new VaultLockedError(text);
		}
		if (response.status === 503) {
			// `pending_flush_failed` is the backend's "web has unsent edits"
			// signal — see `WebFlushPendingError`. Parse the structured body
			// and surface it as a typed error so the engine can route it to
			// the same waiting-retry path as 423. Any other 503 falls through
			// to the generic `SyncBackendError` below — those are real backend
			// availability issues, not the cooperative back-off.
			const parsed = tryParsePendingFlush(text);
			if (parsed !== null) {
				throw new WebFlushPendingError(text, parsed.retryAfterSeconds);
			}
		}
		if (!response.ok) {
			throw new SyncBackendError(response.status, `Sync backend returned ${response.status}`, text);
		}
		if (text.length === 0) return {} as T;
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new SyncBackendError(502, "Sync backend returned non-JSON 2xx body", text.slice(0, 1024));
		}
	}
}

/* v8 ignore start -- delegates to a tested SessionTracker API; exercised only via real bundle */
async function defaultJolliApiKeyProvider(): Promise<string | undefined> {
	const { loadConfig } = await import("../core/SessionTracker.js");
	const config = await loadConfig();
	return config.jolliApiKey;
}
/* v8 ignore stop */

function missingMintFields(body: MintResponseBody): string[] {
	const missing: string[] = [];
	if (!body.token) missing.push("token");
	if (body.expiresAt == null) missing.push("expiresAt");
	if (!body.repoCloneUrl) missing.push("repoCloneUrl");
	if (!body.repoFullName) missing.push("repoFullName");
	if (!body.defaultBranch) missing.push("defaultBranch");
	if (typeof body.alreadyVaultBound !== "boolean") {
		missing.push("alreadyVaultBound");
	}
	if (!body.lockOwnerToken) missing.push("lockOwnerToken");
	return missing;
}

/**
 * Recognize the backend's `pending_flush_failed` 503 body. Backend shape:
 *
 *   { "error": "pending_flush_failed", "message": "...", "retryAfterSeconds": 30 }
 *
 * Returns `null` for any 503 that doesn't match — those flow through to the
 * generic `SyncBackendError` path (real backend availability problems should
 * not get re-cast as "wait for web flush"). Defaults `retryAfterSeconds` to
 * 30 s if the field is missing or non-numeric so the engine still has
 * something sensible to sleep on.
 */
function tryParsePendingFlush(text: string): { readonly retryAfterSeconds: number } | null {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof body !== "object" || body === null) return null;
	const errField = (body as { error?: unknown }).error;
	if (errField !== "pending_flush_failed") return null;
	const raw = (body as { retryAfterSeconds?: unknown }).retryAfterSeconds;
	const retryAfterSeconds = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 30;
	return { retryAfterSeconds };
}

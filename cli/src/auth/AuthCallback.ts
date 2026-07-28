/**
 * Shared OAuth Callback Resolution
 *
 * Used by the IntelliJ plugin (via the `auth` / `handle-auth-callback`
 * ide-bridge action in `commands/IdeBridgeCommand.ts`) as its whole callback
 * decision tree, replacing the previous Kotlin port. The CLI (`Login.ts`) and
 * VS Code extension (`vscode/src/services/AuthService.ts`) keep their own
 * inline copies of the same tree — those two haven't switched to this shared
 * module because their pre-JOLLI-1270 handling has residual behavioural
 * subtleties that don't warrant folding in as part of the IntelliJ migration.
 *
 * The tree mirrors what main CLI / main VS Code do, so IntelliJ signs in with
 * exactly the same rules:
 *
 *   - `?error=` reported before any nonce check — those redirects carry no
 *     `state`, and demanding one would report plain user cancellations as
 *     attacks.
 *   - `?code=` requires the CSRF nonce echoed back on top-level `state=`,
 *     then redeemed via `/api/auth/cli-exchange`.
 *   - `?token=` (legacy — pre-JOLLI-1270 servers) is accepted directly, with
 *     no CSRF check: those servers never echo `state`, and demanding it here
 *     would lock those tenants out of sign-in entirely. Remove the branch
 *     once every deployed frontend issues `?code=`.
 *
 * See {@link resolveAuthCallback}.
 */

import { timingSafeEqual } from "node:crypto";
import { assertJolliOriginAllowed } from "../core/JolliApiUtils.js";
import { loadConfig } from "../core/SessionTracker.js";
import { resolveSignInJolliUrl, saveAuthCredentials } from "./AuthConfig.js";
import { type CliExchangeResult, exchangeCliCode } from "./CliExchange.js";

/**
 * Server-issued OAuth error codes → user-facing text. Shared so the CLI
 * console, the IntelliJ balloon, and any future surface phrase the same
 * failure identically.
 *
 * `user_denied` is deliberately absent: its retry hint is surface-specific
 * (`jolli auth login` vs the IDE settings panel), so it is templated in
 * {@link getAuthErrorMessage} instead.
 */
export const AUTH_ERROR_MESSAGES: Readonly<Record<string, string>> = {
	access_denied: "Access was denied. Please try again.",
	auth_fetch_failed: "Failed to fetch user information from the authentication provider.",
	failed_to_get_token: "We couldn't retrieve your credentials. Please try signing in again.",
	invalid_callback: "The sign-in callback was rejected by the server. Please try again.",
	invalid_provider: "Invalid authentication provider.",
	invalid_request: "Invalid login request. Please try again.",
	no_verified_emails: "No verified email addresses found on your account.",
	oauth_failed: "OAuth authentication failed. Please try again.",
	server_error: "An unexpected server error occurred. Please try again later.",
	session_missing: "Session expired or missing. Please try again.",
	temporarily_unavailable: "Service temporarily unavailable. Please try again later.",
};

/** Default `user_denied` retry hint for surfaces that don't supply one. */
const DEFAULT_RETRY_HINT = "You can try again.";

/**
 * Maps a server-returned error code to a friendly message.
 *
 * @param retryHint Surface-specific "how to retry" sentence appended to the
 *   `user_denied` message (the CLI names its command, an IDE names its UI).
 */
export function getAuthErrorMessage(code: string, retryHint: string = DEFAULT_RETRY_HINT): string {
	if (code === "user_denied") return `Sign-in was cancelled. ${retryHint}`;
	return AUTH_ERROR_MESSAGES[code] ?? `Authentication error: ${code}`;
}

/**
 * Constant-time string equality. The nonce is high-entropy on every surface
 * (256-bit from the CLI, 128-bit from IntelliJ), so timing leaks are infeasible
 * in practice — but `timingSafeEqual` costs nothing extra and keeps the
 * comparison correct-by-construction.
 *
 * Length is compared on the encoded byte buffers, not the JS strings:
 * `String.prototype.length` counts UTF-16 code units while `Buffer.from`
 * defaults to UTF-8, so an attacker-supplied non-ASCII state of matching
 * char-length would otherwise crash `timingSafeEqual` with RangeError.
 */
export function constantTimeStringEqual(a: string, b: string): boolean {
	const ba = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ba.length !== bb.length) return false;
	return timingSafeEqual(ba, bb);
}

/**
 * Builds a URL for a page on the Jolli site, preserving any tenant path
 * prefix and validating the origin against the allowlist.
 *
 * `new URL(path, jolliUrl)` is WRONG here and was a real regression: a
 * root-relative path resolves against the *origin*, so a path-based tenant
 * (`https://jolli-local.me/dev`) silently loses its `/dev` prefix and the
 * page 404s. Concatenating keeps the prefix, matching how `Login.ts` and the
 * VS Code extension build their login URLs.
 *
 * The allowlist assertion is not decorative: callers feed the result into an
 * HTTP `Location` header, and the tenant URL can come from a `JOLLI_URL`
 * environment variable that no other layer validates.
 */
export function jolliPageUrl(jolliUrl: string, path: string, params?: Record<string, string>): string {
	const base = jolliUrl.trim().replace(/\/+$/, "");
	assertJolliOriginAllowed(base);
	const url = new URL(`${base}${path}`);
	for (const [key, value] of Object.entries(params ?? {})) {
		url.searchParams.set(key, value);
	}
	return url.toString();
}

/** Successful callback: credentials are already persisted to the global config. */
export interface AuthCallbackSuccess extends CliExchangeResult {
	readonly ok: true;
}

/** Failed callback, with the code to forward to `/cli-complete` and text to show locally. */
export interface AuthCallbackFailure {
	readonly ok: false;
	/** Frontend-facing error code (`invalid_callback`, `failed_to_get_token`, a server code, …). */
	readonly code: string;
	/** User-facing message for the local surface (CLI console / IDE balloon). */
	readonly message: string;
}

export type AuthCallbackOutcome = AuthCallbackSuccess | AuthCallbackFailure;

export interface AuthCallbackOptions {
	/** Jolli origin used to redeem the exchange code (server-to-server POST). */
	readonly jolliUrl: string;
	/** Parsed callback query parameters. */
	readonly params: URLSearchParams;
	/** CSRF nonce (RFC 6749 §10.12) the server echoes on the `?code=` callback. */
	readonly expectedState: string;
	/** Surface-specific retry hint for `user_denied` — see {@link getAuthErrorMessage}. */
	readonly retryHint?: string;
	/** Invoked when the legacy `?token=` shape is taken, so surfaces can log residual usage. */
	readonly onLegacyFallback?: () => void;
}

/**
 * Resolves an OAuth callback: validates it, redeems the code (or accepts the
 * legacy token), and persists the credentials.
 *
 * Accepts two callback shapes, in priority order:
 *
 *   1. Code-exchange (preferred — issued by upgraded servers): `?code=<hex>`.
 *      Redeemed via {@link exchangeCliCode}; the token never appears in the
 *      browser address bar, history, or referer logs. CSRF-checked against
 *      the caller's `expectedState`.
 *   2. Legacy token-in-URL (pre-code-exchange servers):
 *      `?token=<jwt>&jolli_api_key=<sk-jol-…>`. Less secure, but required so
 *      users on a current client can still sign in to a server that hasn't
 *      shipped the exchange endpoint. **No CSRF check on this branch** —
 *      pre-code-exchange servers never echo `state`, so demanding it would
 *      lock those tenants out of sign-in. Remove this branch (and the CSRF
 *      exemption) once every deployed frontend issues `?code=`.
 *
 * Order matters and is load-bearing: a server-sent `error` is reported before
 * anything else (those redirects carry no `state`), and the CSRF check is
 * scoped to the `?code=` path only.
 *
 * NEVER REJECTS — every failure, including a thrown exchange POST or a refused
 * credential write, comes back as an {@link AuthCallbackFailure}. Keep every
 * new failure path inside the returned union.
 */
export async function resolveAuthCallback(options: AuthCallbackOptions): Promise<AuthCallbackOutcome> {
	const { jolliUrl, params, expectedState, retryHint, onLegacyFallback } = options;

	const serverError = params.get("error");
	if (serverError) {
		return {
			ok: false,
			code: serverError,
			message: getAuthErrorMessage(serverError, retryHint),
		};
	}

	// New and legacy shapes are mutually exclusive in practice (a given server
	// emits one or the other), so this just selects the right path — no version
	// probe needed.
	const code = params.get("code");
	const legacyToken = params.get("token");

	// CSRF check (RFC 6749 §10.12). Only on the code path. Deliberately NOT
	// applied to the `?error=` branch above (carries no credentials) or to the
	// legacy `?token=` branch below (pre-code-exchange servers don't echo state
	// — demanding it there would lock those tenants out of sign-in).
	if (code) {
		const receivedState = params.get("state");
		if (!receivedState || !constantTimeStringEqual(receivedState, expectedState)) {
			return {
				ok: false,
				code: "invalid_callback",
				message: "Invalid sign-in callback (state mismatch). Please try again.",
			};
		}
	}

	try {
		if (code) {
			const exchanged = await exchangeAndPersist(jolliUrl, code);
			return { ok: true, ...exchanged };
		}
		if (legacyToken) {
			const legacyApiKey = params.get("jolli_api_key");
			const legacySpace = params.get("space");
			onLegacyFallback?.();
			await persistLegacyCredentials(jolliUrl, legacyToken, legacyApiKey ?? undefined);
			return {
				ok: true,
				token: legacyToken,
				...(legacyApiKey ? { jolliApiKey: legacyApiKey } : {}),
				...(legacySpace ? { space: legacySpace } : {}),
			};
		}
		return {
			ok: false,
			code: "invalid_callback",
			message: "No authorization code or token received",
		};
	} catch (err) {
		// Covers the exchange POST *and* persistence: saveAuthCredentials
		// rejects an off-allowlist origin, a malformed key, and a key minted
		// for a different tenant. Those messages are already user-facing.
		return {
			ok: false,
			code: "failed_to_get_token",
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Redeems a single-use authorization code and atomically persists the
 * resulting credentials to the global config.
 *
 * The persisted `jolliUrl` is the tenant the minted key actually targets, not
 * the sign-in origin: with no `JOLLI_URL` set the latter is the auth hub
 * (`auth.jolli.ai`) while the key's `meta.u` is the user's real tenant.
 * Persisting the hub would (a) make `saveAuthCredentials`'s same-tenant
 * symmetry check reject every normal key and (b) leave the routing fallback
 * pointing at the hub. See `resolveSignInJolliUrl`.
 */
export async function exchangeAndPersist(jolliUrl: string, code: string): Promise<CliExchangeResult> {
	const exchanged = await exchangeCliCode(jolliUrl, code);
	// Pass the on-disk key as the existing-key fallback so an idempotent-replay
	// callback (no `jolliApiKey` in the response — common on per-`device_name`
	// backends) doesn't wipe a working key when the caller-supplied `jolliUrl`
	// is a generic auth hub. See `resolveSignInJolliUrl` for the rule.
	const existing = await loadConfig();
	await saveAuthCredentials({
		token: exchanged.token,
		jolliUrl: resolveSignInJolliUrl(exchanged.jolliApiKey, jolliUrl, existing.jolliApiKey ?? undefined),
		...(exchanged.jolliApiKey ? { jolliApiKey: exchanged.jolliApiKey } : {}),
	});
	return exchanged;
}

/** Persists credentials delivered directly in the callback query (legacy servers). */
export async function persistLegacyCredentials(jolliUrl: string, token: string, jolliApiKey?: string): Promise<void> {
	const existing = await loadConfig();
	await saveAuthCredentials({
		token,
		jolliUrl: resolveSignInJolliUrl(jolliApiKey, jolliUrl, existing.jolliApiKey ?? undefined),
		...(jolliApiKey ? { jolliApiKey } : {}),
	});
}

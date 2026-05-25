/**
 * Auth Configuration
 *
 * Manages OAuth auth token storage and Jolli server URL resolution.
 * Tokens are stored in ~/.jolli/jollimemory/config.json alongside other config fields.
 */

import {
	assertJolliOriginAllowed,
	parseBaseUrl,
	parseJolliApiKey,
	validateJolliApiKey,
} from "../core/JolliApiUtils.js";
import { loadConfig, saveConfig } from "../core/SessionTracker.js";

const DEFAULT_JOLLI_URL = "https://auth.jolli.ai";

/**
 * Returns the Jolli server URL. Checks JOLLI_URL env var, then falls back to default.
 * Strips trailing slashes and enforces the Jolli origin allowlist — a
 * socially-engineered `JOLLI_URL=https://evil.com` would otherwise send the
 * user's OAuth credentials to the attacker before any API key is involved.
 */
export function getJolliUrl(): string {
	const url = (process.env.JOLLI_URL?.trim() || DEFAULT_JOLLI_URL).replace(/\/+$/, "");
	assertJolliOriginAllowed(url);
	return url;
}

/** Saves the OAuth auth token to global config. */
export async function saveAuthToken(token: string): Promise<void> {
	await saveConfig({ authToken: token });
}

/**
 * Saves the OAuth auth token, the Jolli server URL the user signed into, and
 * an optional Jolli API key in a single atomic write. Use this when receiving
 * these fields from the same auth callback, so a partial failure can't leave
 * the config with a token but no API key (or vice versa).
 *
 * `jolliUrl` is required: every successful login knows the origin it signed
 * into, and persisting it lets cli-pro recover the tenant when
 * `jolliApiKey` is missing or stale. Trailing slash is stripped so the
 * persisted value matches `getJolliUrl`. CLI / VS Code only — IntelliJ
 * writes its own auth state to `config-intellij.json`.
 *
 * Also writes `aiProvider: "jolli"` because clicking "Sign in to Jolli" is the
 * user's explicit declaration of intent to use Jolli for AI summaries — UNLESS
 * the user has already explicitly chosen `aiProvider: "anthropic"` in
 * Settings. In that case we leave the choice alone: a deliberate Anthropic
 * pick should outlast a sign-in (e.g. user signs in just to push, not to
 * switch providers). When `aiProvider` is unset or already "jolli", we write
 * "jolli" to align the dispatcher's `resolveLlmCredentialSource` with the
 * user's onboarding choice — without it, a returning user who already had an
 * Anthropic API key in config would see Settings UI promise "using Jolli" but
 * the dispatcher would still pick Anthropic via the legacy precedence path.
 *
 * `clearAuthCredentials` rolls back this auto-write on logout (only when the
 * stored value is still "jolli") so the config doesn't keep a "jolli"
 * preference whose credentials are gone.
 *
 * Cross-tenant safety: if the caller passes no `jolliApiKey` but the on-disk
 * config still has one whose embedded origin points at a different tenant
 * than the new `jolliUrl`, the stale key is cleared in the same write.
 * Without this, `resolveLlmCredentialSource` and `BackendClient` would keep
 * extracting the tenant URL from the old key and silently route LLM / sync
 * traffic to the prior tenant instead of falling back to the new `jolliUrl`.
 */
export async function saveAuthCredentials(credentials: {
	readonly token: string;
	readonly jolliApiKey?: string;
	readonly jolliUrl: string;
}): Promise<void> {
	const config = await loadConfig();
	const normalizedJolliUrl = credentials.jolliUrl.replace(/\/+$/, "");
	// Validate at the persistence boundary, symmetric with `validateJolliApiKey`
	// below. Production callers route through `getJolliUrl()`, which already
	// applies the same allowlist — repeating it here keeps a future caller
	// (cli-pro, IntelliJ port, refactored VS Code path) from persisting an
	// off-allowlist origin and downstream readers (`apiKeyMatchesTenant`,
	// cli-pro's tenant resolver) from trusting an attacker-supplied URL.
	assertJolliOriginAllowed(normalizedJolliUrl);
	const update: { authToken: string; jolliUrl: string; jolliApiKey?: string; aiProvider?: "jolli" } = {
		authToken: credentials.token,
		jolliUrl: normalizedJolliUrl,
	};
	if (config.aiProvider !== "anthropic") {
		update.aiProvider = "jolli";
	}
	if (credentials.jolliApiKey) {
		validateJolliApiKey(credentials.jolliApiKey);
		// Symmetry check: the freshly-minted key must target the same tenant
		// recorded in `jolliUrl`. Undecodable keys are exempt — they have no
		// embedded tenant to check against, matching `apiKeyMatchesTenant`'s
		// "can't prove stale" rule below.
		//
		// NOTE ON SCOPE: the two production sign-in callers derive `jolliUrl`
		// FROM this same key via `resolveSignInJolliUrl` (the key's `meta.u` is
		// authoritative — at the hub the user named no tenant, so there is no
		// independent intent to validate against). For those callers this
		// comparison is therefore a tautology and never throws. The check is
		// NOT dead, though: it stays meaningful for any caller that supplies
		// `jolliUrl` independently of the key (direct `saveAuthCredentials`
		// use, a future cli-pro / IntelliJ path), where a key whose `meta.u`
		// disagrees with the supplied URL is rejected rather than silently
		// persisted and routed to a third tenant. `resolveSignInJolliUrl`
		// already drops an off-allowlist `meta.u`, so the residual case this
		// guards is a key for a *different allowlisted* tenant.
		if (!apiKeyMatchesTenant(credentials.jolliApiKey, normalizedJolliUrl)) {
			throw new Error(
				`Server returned a Jolli API key targeting a different tenant than ${normalizedJolliUrl}. Refusing to persist — please try signing in again.`,
			);
		}
		update.jolliApiKey = credentials.jolliApiKey;
	} else if (config.jolliApiKey && !apiKeyMatchesTenant(config.jolliApiKey, normalizedJolliUrl)) {
		// No new key arrived on the callback, but the persisted one targets a
		// different tenant — clear it so `resolveLlmCredentialSource` and
		// `BackendClient` (which extract the tenant from `parseJolliApiKey(...)?.u`,
		// not from `jolliUrl`) fall back to the fresh `jolliUrl` instead of
		// silently routing requests to the old tenant.
		update.jolliApiKey = undefined;
	}
	await saveConfig(update);
}

/**
 * Returns true when `existingKey`'s embedded `u` targets the same tenant as
 * `jolliUrl`. "Tenant" is the `(origin, first-path-segment)` tuple — the path
 * segment is the routing key that flows downstream as the `x-tenant-slug`
 * header (see `parseBaseUrl` consumers in `BackendClient`, `LlmClient`, and
 * `CliExchange`). Comparing only `.origin` would treat
 * `https://jolli-local.me/dev` and `https://jolli-local.me/prod` as the same
 * tenant and leave proxy/sync traffic pinned to the old slug after a
 * cross-tenant re-login.
 *
 * An undecodable key counts as a match (legacy / hand-typed). We can't prove
 * it's stale from the key alone, and dropping a key the user just typed in
 * would surprise them. The consequence is that a user holding a legacy/
 * hand-typed key and signing into a different tenant lands in a half-state:
 * `jolliUrl` updates to the new tenant, but the legacy key stays on disk and
 * `shouldRequestFreshApiKey` (sibling helper) returns false, so the server
 * is never asked to mint a fresh key. Downstream consumers fail loudly rather
 * than route to the wrong tenant — `resolveLlmCredentialSource` in LlmClient.ts
 * returns null when it can't extract `meta.u`, and `BackendClient.request`
 * throws `SyncBackendUnauthorizedError("invalid_jolli_api_key")` — so the
 * user sees an auth error on the next commit instead of silent cross-tenant
 * routing. A second `jolli auth login` (with no existing key) then provisions
 * cleanly. The "two-step provision" outcome is preferred to surprise-dropping
 * a hand-typed key whose owner may not have a way to mint a replacement.
 */
function apiKeyMatchesTenant(existingKey: string, jolliUrl: string): boolean {
	const meta = parseJolliApiKey(existingKey);
	if (!meta) return true;
	try {
		const fromKey = parseBaseUrl(meta.u);
		const target = parseBaseUrl(jolliUrl);
		// `origin` compares case-insensitively because `URL.origin` lowercases
		// the host (DNS is case-insensitive, RFC 3986 §6.2.2.1). `tenantSlug`
		// compares case-SENSITIVELY on purpose: the slug is the first path
		// segment, paths are case-sensitive per RFC 3986, and it flows downstream
		// VERBATIM as the `x-tenant-slug` routing header (LlmClient / CliExchange
		// / BackendClient send `parsed.tenantSlug` unchanged). Lowercasing here
		// would diverge from that header and could KEEP a key whose slug is a
		// case-variant of `jolliUrl` — silently routing to a tenant the user
		// didn't sign into if the backend treats `/Acme` and `/acme` as distinct.
		// Staying case-sensitive fails safe: a case-mismatch is treated as a
		// different tenant (key cleared / fresh key requested), never misrouted.
		return fromKey.origin === target.origin && fromKey.tenantSlug === target.tenantSlug;
	} catch {
		// The only reachable parse failure is `parseBaseUrl(meta.u)` on a
		// corrupted key whose `meta.u` is not a valid URL (tampered or legacy
		// with embedded garbage).  `parseBaseUrl(jolliUrl)` is unreachable from
		// the two public call sites — both `saveAuthCredentials` and
		// `shouldRequestFreshApiKey` receive `jolliUrl` that has already passed
		// through `assertJolliOriginAllowed(new URL(...))`.  We keep the key on
		// any parse failure: a corrupted key can't be compared (so we can't
		// claim it belongs to a *different* tenant either), and dropping it
		// without the user's explicit sign-out would lock them out.
		return true;
	}
}

/**
 * Sign-in helper: returns true when the upcoming login should ask the server
 * to mint a fresh Jolli API key.
 *
 * The rule:
 *   - No key on disk → request a fresh one (otherwise the user can't push).
 *   - Key on disk whose embedded tenant differs from `jolliUrl` → request a
 *     fresh one so cross-tenant switch completes in a single sign-in instead
 *     of two (without this, the callback returns no new key, the stale-key
 *     clear in `saveAuthCredentials` empties the slot, and the user has to
 *     log in again to actually provision).
 *   - Otherwise (key matches the target tenant, or is undecodable legacy)
 *     → don't request a fresh one; a sign-in here is a re-auth, not a
 *     provision, and overwriting the existing key would surprise the user
 *     (especially for hand-typed keys with no embedded `u`).
 *
 * Mirrors the cross-tenant logic in `saveAuthCredentials`'s
 * `apiKeyMatchesTenant` check so the two halves of the sign-in flow agree
 * on what "stale" means.
 */
export function shouldRequestFreshApiKey(existingKey: string | undefined, jolliUrl: string): boolean {
	if (!existingKey) return true;
	return !apiKeyMatchesTenant(existingKey, jolliUrl);
}

/**
 * Resolves the `jolliUrl` to persist after a sign-in callback.
 *
 * The minted Jolli API key's embedded `meta.u` is the authoritative tenant the
 * account routes to (LLM proxy + sync both extract it via `parseJolliApiKey`).
 * The sign-in *origin* is not: with no `JOLLI_URL` set it is the auth hub
 * (`auth.jolli.ai`), which is not where the user's data lives. Persisting the
 * hub would leave the missing-/stale-key routing fallback pointing at the hub
 * instead of the tenant. So we prefer the key's embedded tenant, and fall back
 * to `signInOrigin` only when no key was issued or the key is legacy/hand-typed
 * and carries no `meta.u`.
 *
 * The adopted `meta.u` is origin-allowlisted here (via {@link isAllowedOrigin})
 * so this helper never emits an off-allowlist origin, even to a future caller
 * that doesn't route its result through `saveAuthCredentials`'s validation. An
 * off-allowlist tenant (a buggy/compromised server) falls back to
 * `signInOrigin`, which `getJolliUrl` has already allowlisted.
 */
export function resolveSignInJolliUrl(jolliApiKey: string | undefined, signInOrigin: string): string {
	if (jolliApiKey) {
		const tenant = parseJolliApiKey(jolliApiKey)?.u;
		if (tenant && isAllowedOrigin(tenant)) return tenant;
	}
	return signInOrigin;
}

/**
 * Non-throwing wrapper over `assertJolliOriginAllowed` — returns false instead
 * of throwing so callers can use it as a guard. Used to keep
 * `resolveSignInJolliUrl` from ever returning an off-allowlist tenant lifted
 * from a key's `meta.u`.
 */
function isAllowedOrigin(url: string): boolean {
	try {
		assertJolliOriginAllowed(url);
		return true;
	} catch {
		return false;
	}
}

/** Loads the OAuth auth token. JOLLI_AUTH_TOKEN env var takes priority. */
export async function loadAuthToken(): Promise<string | undefined> {
	const envToken = process.env.JOLLI_AUTH_TOKEN?.trim();
	if (envToken) return envToken;
	const config = await loadConfig();
	return config.authToken;
}

/**
 * Clears the auth token, Jolli API key, and (only if it equals "jolli") the
 * `aiProvider` preference. Symmetric with `saveAuthCredentials`: that path
 * writes "jolli" only when the current value isn't already "anthropic", so the
 * "explicit anthropic survives a Jolli sign-in / logout round-trip" property
 * holds end-to-end. Leaving "jolli" behind on logout would pin
 * `resolveLlmCredentialSource` to the proxy after the credentials are gone —
 * subsequent commits would then fail silently in VS Code (where the CLI
 * warning copy never reaches the user).
 *
 * `jolliUrl` is intentionally **not** cleared. It's not secret material,
 * and cli-pro still needs to resolve the tenant after logout — that's the
 * entire reason `saveAuthCredentials` persists it. The next successful
 * sign-in (potentially against a different tenant) overwrites the value,
 * and the bare URL on its own grants no access.
 */
export async function clearAuthCredentials(): Promise<void> {
	const config = await loadConfig();
	const update: { authToken: undefined; jolliApiKey: undefined; aiProvider?: undefined } = {
		authToken: undefined,
		jolliApiKey: undefined,
	};
	if (config.aiProvider === "jolli") {
		update.aiProvider = undefined;
	}
	await saveConfig(update);
}

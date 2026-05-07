/**
 * CLI Code Exchange
 *
 * Trades a single-use authorization code (received via the `cli_callback`
 * URL) for the actual auth token and any auto-generated Jolli API key.
 *
 * The token never appears in the browser address bar, history, or referer
 * logs — it travels client→server only, in the JSON body of
 * POST `/api/auth/cli-exchange`.
 *
 * Shared by the CLI's loopback callback server (`Login.ts`) and the VSCode
 * extension's URI handler (`AuthService.ts`).
 */

import { assertJolliOriginAllowed, parseBaseUrl } from "../core/JolliApiUtils.js";

export interface CliExchangeResult {
	readonly token: string;
	readonly jolliApiKey?: string;
	readonly space?: string;
}

/**
 * End-to-end timeout for the cli-exchange POST. The backend just reads a
 * single-use code from a short-lived store and returns the issued token, so
 * 20s is generous; without a bound, a half-open socket leaves the OAuth
 * callback thread (CLI loopback server / VSCode URI handler) hung indefinitely
 * with no user-facing way to abort.
 */
const CLI_EXCHANGE_TIMEOUT_MS = 20_000;

/**
 * POSTs `code` to the Jolli backend and returns the freshly-minted credentials.
 *
 * Throws `Error` with a user-facing message on every failure mode (network
 * error, timeout, non-OK status, malformed JSON, missing token) so callers can
 * surface the message directly without having to map status codes themselves.
 *
 * @param jolliUrl Jolli server URL. Accepts both subdomain-based
 *   (`https://app.jolli.ai`) and path-based (`https://jolli-local.me/dev`)
 *   tenant URLs. The cli-exchange route is mounted at the origin, not under
 *   the tenant path, so we strip any path prefix and forward the tenant slug
 *   as `x-tenant-slug` — same pattern as JolliPushService and LlmClient.
 *   Re-validated against the origin allowlist before issuing the request — a
 *   long-lived process could otherwise hold a stale, off-allowlist value.
 * @param code 32-byte hex code minted by the consent page.
 */
export async function exchangeCliCode(jolliUrl: string, code: string): Promise<CliExchangeResult> {
	assertJolliOriginAllowed(jolliUrl);
	const parsed = parseBaseUrl(jolliUrl);
	const targetUrl = new URL("/api/auth/cli-exchange", parsed.origin);

	const headers: Record<string, string> = { "content-type": "application/json" };
	if (parsed.tenantSlug) {
		headers["x-tenant-slug"] = parsed.tenantSlug;
	}

	let response: Response;
	try {
		response = await fetch(targetUrl, {
			method: "POST",
			headers,
			body: JSON.stringify({ code }),
			signal: AbortSignal.timeout(CLI_EXCHANGE_TIMEOUT_MS),
		});
	} catch (err) {
		if (err instanceof DOMException && err.name === "TimeoutError") {
			throw new Error(
				`Sign-in timed out after ${CLI_EXCHANGE_TIMEOUT_MS / 1000}s waiting for Jolli. Please try again.`,
			);
		}
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Couldn't reach Jolli to complete sign-in: ${message}`);
	}

	if (response.status === 404) {
		throw new Error("Sign-in code expired or already used. Please try signing in again.");
	}
	if (!response.ok) {
		throw new Error(`Sign-in failed (HTTP ${response.status}). Please try again.`);
	}

	let payload: { token?: unknown; jolliApiKey?: unknown; space?: unknown };
	try {
		payload = (await response.json()) as typeof payload;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Sign-in failed: server returned malformed response (${message}).`);
	}

	if (typeof payload.token !== "string" || !payload.token) {
		throw new Error("Sign-in failed: server response did not include a token.");
	}

	return {
		token: payload.token,
		...(typeof payload.jolliApiKey === "string" && payload.jolliApiKey ? { jolliApiKey: payload.jolliApiKey } : {}),
		...(typeof payload.space === "string" && payload.space ? { space: payload.space } : {}),
	};
}

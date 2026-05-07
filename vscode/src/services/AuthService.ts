/**
 * AuthService
 *
 * Manages OAuth login/signup state for the Jolli Memory VSCode extension.
 * Wraps core auth functions with VSCode-specific URI handling and context keys.
 *
 * Credentials are stored in ~/.jolli/jollimemory/config.json (shared with the CLI),
 * NOT in VSCode SecretStorage — this keeps the CLI and extension in sync.
 *
 * Auth state is determined by the presence of `authToken` in config.
 * Display info (site URL, tenant) is derived from the API key metadata.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import * as vscode from "vscode";
import {
	clearAuthCredentials,
	getJolliUrl,
	saveAuthCredentials,
} from "../../../cli/src/auth/AuthConfig.js";
import { exchangeCliCode } from "../../../cli/src/auth/CliExchange.js";
import { loadConfig } from "../../../cli/src/core/SessionTracker.js";
import type { JolliMemoryConfig } from "../../../cli/src/Types.js";
import { log } from "../util/Logger.js";
import { EXTENSION_ID, resolveUriScheme } from "../util/UriSchemeResolver.js";

/** VSCode URI callback path for OAuth redirects */
const AUTH_CALLBACK_PATH = "/auth-callback";

/**
 * Result of handling an auth callback URI. Discriminated on `success` so the
 * error branch is guaranteed to carry a message — prevents UIs from surfacing
 * "...: undefined" when something goes wrong.
 */
export type AuthCallbackResult =
	| { readonly success: true }
	| { readonly success: false; readonly error: string };

/**
 * Manages OAuth login/signup flow and auth state.
 *
 * - `handleAuthCallback()` parses the `vscode://` URI from the browser redirect
 * - `signOut()` clears credentials from config.json
 * - `openSignInPage()` launches the browser to the Jolli login page
 * - `isSignedIn()` / `refreshContextKey()` manage the `jollimemory.signedIn` context key
 *
 * All reads and writes go through the global `~/.jolli/jollimemory/config.json`
 * via the `saveConfig` / `clearAuthCredentials` helpers, so there's no need to
 * inject a config directory at construction time.
 */
export class AuthService {
	/**
	 * CSRF state nonce for the in-flight login attempt (RFC 6749 §10.12).
	 * Set in {@link openSignInPage} before opening the browser; consumed and
	 * cleared on the next {@link handleAuthCallback} so a captured state can't
	 * be replayed against a future login. `null` between attempts.
	 *
	 * Lives in memory only — extension reload during a sign-in invalidates
	 * the in-flight attempt by design (the user retries).
	 */
	private pendingState: string | null = null;

	/**
	 * Handles the OAuth callback URI from the browser redirect.
	 *
	 * Two callback shapes are accepted, in priority order:
	 *
	 *   1. Code-exchange (preferred — issued by upgraded servers):
	 *        vscode://jolli.jollimemory-vscode/auth-callback?code=<32-byte-hex>
	 *      The `code` is single-use and TTL-bound; we POST it to
	 *      `/api/auth/cli-exchange` to redeem the actual token + API key over a
	 *      channel the browser never sees.
	 *
	 *   2. Legacy token-in-URL (fallback — issued by pre-code-exchange servers):
	 *        vscode://jolli.jollimemory-vscode/auth-callback?token=<jwt>&jolli_api_key=<sk-jol-…>
	 *      Server delivers credentials directly in query params. Less secure
	 *      (token visible to URI handler chain), but required so users on the
	 *      latest extension can still sign in to a server that hasn't shipped
	 *      the code-exchange endpoint yet. Remove once all server tenants
	 *      issue `?code=` callbacks.
	 *
	 *   3. Error: ?error=<code>
	 */
	async handleAuthCallback(uri: vscode.Uri): Promise<AuthCallbackResult> {
		if (uri.path !== AUTH_CALLBACK_PATH) {
			log.warn("AuthService", "Ignoring unknown URI path: %s", uri.path);
			return { success: false, error: "Unknown callback path" };
		}

		const params = new URLSearchParams(uri.query);
		const error = params.get("error");
		if (error) {
			const message = getErrorMessage(error);
			log.error("AuthService", "Auth callback error: %s", message);
			return { success: false, error: message };
		}

		// Prefer the code-exchange flow when the server offers it. The two
		// shapes are mutually exclusive in practice (a given server emits one
		// or the other), so this just selects the right path automatically.
		const code = params.get("code");
		const token = params.get("token");

		// CSRF check (RFC 6749 §10.12). Only enforced on the code-exchange
		// path; the legacy token-in-URL fallback predates state support and
		// older servers don't echo state. Tightening it here would lock
		// those users out of sign-in. The legacy gap closes when the fallback
		// is removed.
		//
		// One-shot: clearing pendingState before validation prevents an
		// attacker who rapidly fires two callbacks (one with the right
		// state, one without) from getting two attempts at the same nonce.
		const expectedState = this.pendingState;
		this.pendingState = null;
		if (code) {
			const receivedState = params.get("state");
			if (
				!expectedState ||
				!receivedState ||
				!constantTimeStringEqual(receivedState, expectedState)
			) {
				log.error(
					"AuthService",
					"Auth callback state mismatch — rejecting (possible CSRF attempt)",
				);
				return {
					success: false,
					error: "Invalid sign-in callback (state mismatch). Please try again.",
				};
			}
		}

		let credentials: { token: string; jolliApiKey?: string };
		if (code) {
			try {
				const exchanged = await exchangeCliCode(getJolliUrl(), code);
				credentials = {
					token: exchanged.token,
					...(exchanged.jolliApiKey
						? { jolliApiKey: exchanged.jolliApiKey }
						: {}),
				};
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				log.error("AuthService", "Failed to exchange code: %s", message);
				return { success: false, error: message };
			}
		} else if (token) {
			// Legacy fallback. Logged at warn level so we can track residual
			// usage and decide when it's safe to drop this branch.
			log.warn(
				"AuthService",
				"Using legacy token-in-URL callback — server has not been upgraded to the code-exchange flow",
			);
			const legacyApiKey = params.get("jolli_api_key");
			credentials = {
				token,
				...(legacyApiKey ? { jolliApiKey: legacyApiKey } : {}),
			};
		} else {
			log.error("AuthService", "Auth callback missing code and token");
			return {
				success: false,
				error: "No authorization code or token received",
			};
		}

		try {
			// Single atomic write — avoids leaving the config in a half-written state
			// (token saved, API key dropped) if the second write were to fail.
			await saveAuthCredentials(credentials);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			log.error("AuthService", "Failed to save credentials: %s", message);
			return {
				success: false,
				error: `Failed to save credentials: ${message}`,
			};
		}

		// Updating the context key is best-effort — a failure here shouldn't
		// invalidate a successful save, so it lives outside the try/catch above.
		try {
			await vscode.commands.executeCommand(
				"setContext",
				"jollimemory.signedIn",
				true,
			);
		} catch (err: unknown) {
			log.warn("AuthService", "Failed to update signedIn context key: %s", err);
		}
		log.info("AuthService", "Sign-in successful");
		return { success: true };
	}

	/** Clears auth credentials from config.json and resets the context key. */
	async signOut(): Promise<void> {
		// Writes `{ authToken: undefined, jolliApiKey: undefined }` to the global
		// config — JSON.stringify omits undefined fields so both are removed.
		await clearAuthCredentials();
		await vscode.commands.executeCommand(
			"setContext",
			"jollimemory.signedIn",
			false,
		);
		log.info("AuthService", "Signed out");
	}

	/** Opens the browser to the Jolli login page with a VSCode callback URI. */
	async openSignInPage(): Promise<void> {
		// Derive the callback scheme from the host IDE. `vscode.env.uriScheme`
		// is unreliable here — most forks inherit upstream's "vscode" default
		// for that API even though they register their own scheme at the OS
		// level. `appName` is consistently rebranded (forks surface it in window
		// titles and About dialogs), so it's the stable signal — see
		// resolveUriScheme() at the bottom of this file.
		const callbackUri = `${resolveUriScheme()}://${EXTENSION_ID}${AUTH_CALLBACK_PATH}`;
		// Only ask the server to issue a fresh Jolli API key when the user has
		// none configured — otherwise sign-in would overwrite a manually
		// configured key (and a subsequent sign-out would then delete it).
		// Mirrors the CLI's browserLogin() behaviour in Login.ts.
		const { jolliApiKey } = await loadConfig();
		const generateKeyParam = jolliApiKey ? "" : "&generate_api_key=true";
		// 256-bit CSRF nonce per RFC 6749 §10.12. Sent on the login URL and
		// validated on the matching handleAuthCallback().
		const state = randomBytes(32).toString("hex");
		// `getJolliUrl()` throws if `JOLLI_URL` env var points off the
		// allowlist — catch it here so an attacker-pointed env var surfaces as
		// a friendly error dialog instead of an unhandled command exception.
		let loginUrl: string;
		try {
			loginUrl = `${getJolliUrl()}/login?cli_callback=${encodeURIComponent(callbackUri)}&state=${state}${generateKeyParam}&client=vscode`;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			log.error("AuthService", "getJolliUrl rejected: %s", message);
			vscode.window.showErrorMessage(
				`Cannot sign in: ${message} Unset JOLLI_URL (or set it to a trusted Jolli host) and retry.`,
			);
			return;
		}
		// Commit pendingState only after the URL builds — otherwise a thrown
		// getJolliUrl() would leave behind a state that pairs with no
		// outgoing nonce.
		this.pendingState = state;
		log.info("AuthService", "Opening browser for sign-in");
		try {
			const opened = await vscode.env.openExternal(vscode.Uri.parse(loginUrl));
			if (!opened) {
				this.pendingState = null;
				log.warn("AuthService", "openExternal returned false for login URL");
				vscode.window.showErrorMessage(
					"Couldn't launch the browser for sign-in. Please try again.",
				);
			}
		} catch (err: unknown) {
			this.pendingState = null;
			const message = err instanceof Error ? err.message : String(err);
			log.error("AuthService", "openExternal failed: %s", message);
			vscode.window.showErrorMessage(
				`Couldn't launch the browser for sign-in: ${message}`,
			);
		}
	}

	/** Returns true if the user is signed in via OAuth (authToken present in config). */
	isSignedIn(config: JolliMemoryConfig): boolean {
		return !!config.authToken;
	}

	/** Updates the `jollimemory.signedIn` context key based on config state. */
	refreshContextKey(config: JolliMemoryConfig): void {
		vscode.commands.executeCommand(
			"setContext",
			"jollimemory.signedIn",
			this.isSignedIn(config),
		);
	}
}

/**
 * Constant-time string equality. Mirrors Login.ts. The 256-bit nonce makes
 * timing leaks infeasible in practice, but `timingSafeEqual` costs nothing
 * extra and keeps the comparison correct-by-construction.
 *
 * Length is compared on the encoded byte buffers, not the JS strings:
 * `String.prototype.length` counts UTF-16 code units while `Buffer.from`
 * defaults to UTF-8, so an attacker-supplied non-ASCII state of matching
 * char-length would otherwise crash `timingSafeEqual` with RangeError.
 */
function constantTimeStringEqual(a: string, b: string): boolean {
	const ba = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ba.length !== bb.length) return false;
	return timingSafeEqual(ba, bb);
}

/** Maps server-returned error codes to user-friendly messages. Mirrors Login.ts. */
function getErrorMessage(errorCode: string): string {
	const errorMessages: Record<string, string> = {
		oauth_failed: "OAuth authentication failed. Please try again.",
		session_missing: "Session expired or missing. Please try again.",
		invalid_provider: "Invalid authentication provider.",
		auth_fetch_failed:
			"Failed to fetch user information from the authentication provider.",
		no_verified_emails: "No verified email addresses found on your account.",
		server_error:
			"An unexpected server error occurred. Please try again later.",
		failed_to_get_token:
			"We couldn't retrieve your credentials. Please try signing in again.",
		user_denied:
			"Sign-in was cancelled. You can try again from the side panel.",
		invalid_callback:
			"The sign-in callback was rejected by the server. Please try again.",
	};
	return errorMessages[errorCode] ?? `Authentication error: ${errorCode}`;
}

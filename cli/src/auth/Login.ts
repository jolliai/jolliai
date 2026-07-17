/**
 * Browser OAuth Login Flow
 *
 * Opens the user's browser to the Jolli login page and starts a local
 * HTTP server to receive the OAuth callback. On success, redeems the
 * single-use exchange code and persists the auth token (and optionally an API
 * key) to the global config.
 */

/// <reference path="../Globals.d.ts" />

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import open from "open";
import { getOrCreateInstallId, loadConfig } from "../core/SessionTracker.js";
import { track } from "../core/Telemetry.js";
import { getJolliUrl, resolveSignInJolliUrl, saveAuthCredentials, shouldRequestFreshApiKey } from "./AuthConfig.js";
import { exchangeCliCode } from "./CliExchange.js";
import { getDeviceLabel } from "./DeviceLabel.js";

/**
 * Surface version sent on the login URL as `client_version`. Pairs with
 * `client=cli` so the server can gate sign-in (and downstream auto-prompts)
 * on the same min-version policy applied to subsequent `x-jolli-client`
 * HTTP requests. Build-time `__PKG_VERSION__` is the `cli/package.json`
 * version in the standalone CLI bundle and falls back to `"dev"` under
 * tsx / tests, matching the convention in `core/LlmClient.ts`.
 */
/* v8 ignore start -- compile-time ternary: __PKG_VERSION__ is always defined in bundled builds */
const CLIENT_VERSION = typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "dev";
/* v8 ignore stop */

/**
 * Options for {@link runBrowserLoginFlow}. Every field is optional — omit to
 * get the CLI's default behavior. Non-CLI surfaces (desktop, VS Code, IntelliJ)
 * override what makes sense for their host platform: `openBrowser` to use the
 * host's native URL opener, `notify` to route status text somewhere other than
 * stdout, `clientKind`/`clientVersion` to identify their surface, and
 * `loginTimeoutMs` to bound how long a user has to complete sign-in.
 */
export interface BrowserLoginOptions {
	/**
	 * Jolli origin (e.g. `https://app.jolli.ai`). Defaults to the current
	 * config's `jolliUrl` via `getJolliUrl()`. The same origin drives the login
	 * page URL AND the server-to-server exchange, so the two halves of the flow
	 * can't disagree on which tenant is being signed into.
	 */
	readonly jolliUrl?: string;
	/**
	 * Called with the login URL to hand it to a browser. Default: the `open`
	 * npm package (matches CLI behavior). Desktop passes Electron's
	 * `shell.openExternal`; the returned promise should resolve as soon as the
	 * OS accepts the URL — the callback loopback below owns waiting for the
	 * user to complete sign-in.
	 */
	readonly openBrowser?: (url: string) => Promise<void>;
	/**
	 * Surface identifier for the `client=` query param on the login URL. The
	 * server gates min-version and records signin_started attribution per
	 * client. Default: `"cli"`. Desktop currently also passes `"cli"` so it
	 * inherits the CLI's min-version policy — server-side surface distinction
	 * happens at a later step, via `x-jolli-client` on subsequent API calls.
	 */
	readonly clientKind?: string;
	/**
	 * Value for `client_version=` on the login URL. Default: build-time
	 * `__PKG_VERSION__` (the CLI's own package version in bundled builds).
	 * Desktop passes `app.getVersion()` so the min-version gate operates on
	 * the desktop's own release version.
	 */
	readonly clientVersion?: string;
	/**
	 * User-facing status messages emitted at each step of the flow. Default:
	 * `console.log`. Desktop suppresses (no-op) so its GUI-side status UI owns
	 * the messaging surface.
	 */
	readonly notify?: (message: string) => void;
	/**
	 * Whether to emit the `signin_started` telemetry event when the browser
	 * opens. Default: `true` for CLI. Desktop leaves it as-is — the join row
	 * is written by the backend regardless.
	 */
	readonly emitStartTelemetry?: boolean;
	/**
	 * Hard timeout — reject with `new Error("Sign-in timed out.")` after this
	 * many ms if the user hasn't completed OAuth. Default: no timeout (CLI
	 * blocks until the user finishes or Ctrl+C's out). Desktop passes 5 min so
	 * an unattended login doesn't leak a listening socket forever.
	 */
	readonly loginTimeoutMs?: number;
}

/**
 * Opens the browser to `${jolliUrl}/login` with a CLI callback URL, waits for
 * the OAuth redirect, redeems the exchange code, and saves the resulting
 * credentials.
 *
 * Uses port 0 so the OS assigns a free port — avoids EADDRINUSE conflicts.
 *
 * This is the parameterised entry point every Jolli surface consumes — CLI,
 * desktop, VS Code, IntelliJ. The legacy {@link browserLogin} wrapper
 * (unchanged signature) forwards to this with all defaults. All security-
 * critical logic (CSRF state check, tenant allowlist, credential persistence)
 * lives in the shared helpers this composes; per-surface options only steer
 * platform integration (browser opener, notification sink, telemetry, timeout).
 */
export function runBrowserLoginFlow(opts: BrowserLoginOptions = {}): Promise<void> {
	const openBrowser =
		opts.openBrowser ??
		(async (url: string) => {
			// Detach the browser process so it doesn't block Node from exiting.
			const child = await open(url);
			child.unref();
		});
	const clientKind = opts.clientKind ?? "cli";
	const clientVersion = opts.clientVersion ?? CLIENT_VERSION;
	const notify = opts.notify ?? ((message: string) => console.log(message));
	const emitStartTelemetry = opts.emitStartTelemetry ?? true;
	const loginTimeoutMs = opts.loginTimeoutMs;

	return new Promise((resolve, reject) => {
		// Resolve the tenant URL INSIDE the executor: `getJolliUrl()` calls
		// `assertJolliOriginAllowed` and throws on a disallowed origin (e.g. a
		// poisoned JOLLI_URL). Resolving it here means that throw rejects the
		// returned promise — so a caller that omits `opts.jolliUrl` and relies on
		// `.catch()` (external integrators) sees a rejection, not a synchronous
		// throw that escapes it.
		let jolliUrl: string;
		try {
			jolliUrl = opts.jolliUrl ?? getJolliUrl();
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
			return;
		}
		// 256-bit CSRF nonce per RFC 6749 §10.12. Sent on the login URL and
		// echoed back unchanged on the `?code=` callback; mismatch means the
		// callback didn't originate from the login flow we just opened.
		const expectedState = randomBytes(32).toString("hex");
		let timeoutHandle: NodeJS.Timeout | null = null;
		let settled = false;

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			fn();
		};

		const server = createLoginServer({
			port: 0,
			jolliUrl,
			expectedState,
			async onListen() {
				try {
					const addr = server.address();
					/* v8 ignore start - server.address() always returns AddressInfo when listening */
					const actualPort = typeof addr === "object" && addr ? addr.port : 0;
					/* v8 ignore stop */

					const callbackUrl = `http://127.0.0.1:${actualPort}/callback`;

					// `client=<kind>` identifies the originating surface. `client_version`
					// pairs with it so server-side min-version gating can run at
					// sign-in, not only on later API calls. `generate_api_key=true` is
					// gated by `shouldRequestFreshApiKey` — asked for when no key is on
					// disk, or the on-disk key targets a different tenant than
					// `jolliUrl` (so cross-tenant switch completes in one sign-in).
					const config = await loadConfig();
					let loginUrl = `${jolliUrl}/login?cli_callback=${encodeURIComponent(callbackUrl)}&state=${expectedState}&client=${encodeURIComponent(clientKind)}&client_version=${encodeURIComponent(clientVersion)}`;
					// JOLLI-1785: carry the anonymous installId through OAuth so the
					// backend can write the install→account conversion-join row when it
					// mints the key (it reads `install_id`, strict lowercase UUID, and
					// records attribution regardless of generate_api_key). This is the
					// pre-signup funnel's only link between the anonymous identity and
					// the account the user is about to create.
					const { installId } = await getOrCreateInstallId();
					loginUrl += `&install_id=${encodeURIComponent(installId)}`;
					if (shouldRequestFreshApiKey(config.jolliApiKey, jolliUrl)) {
						loginUrl += "&generate_api_key=true";
						// `device_name` scopes the server's per-user idempotency key so
						// signing in from a second machine doesn't invalidate the first
						// machine's auto-generated API key. Only meaningful when we're
						// asking the server to mint a new key — paired with generate_api_key.
						const deviceLabel = getDeviceLabel();
						if (deviceLabel) {
							loginUrl += `&device_name=${encodeURIComponent(deviceLabel)}`;
						}
					}

					if (emitStartTelemetry) track("signin_started", { trigger: clientKind });

					notify("Opening browser to login...");
					notify(`If the browser doesn't open automatically, visit: ${loginUrl}`);

					await openBrowser(loginUrl);
				} catch (err) {
					closeServer(server);
					settle(() => reject(err instanceof Error ? err : new Error(String(err))));
				}
			},
			onSuccess: () => settle(resolve),
			onError: (err) => settle(() => reject(err)),
		});

		if (typeof loginTimeoutMs === "number" && loginTimeoutMs > 0) {
			timeoutHandle = setTimeout(() => {
				closeServer(server);
				settle(() => reject(new Error("Sign-in timed out.")));
			}, loginTimeoutMs);
		}
	});
}

/**
 * Legacy positional wrapper — kept so cli's own callers (`commands/AuthLogin.ts`)
 * don't need to migrate right now. New callers should use
 * {@link runBrowserLoginFlow} which accepts overrides.
 */
export function browserLogin(jolliUrl: string): Promise<void> {
	return runBrowserLoginFlow({ jolliUrl });
}

interface LoginServerOptions {
	readonly port: number;
	/** Jolli origin used to redeem the exchange code (server-to-server POST). */
	readonly jolliUrl: string;
	/**
	 * CSRF nonce (RFC 6749 §10.12) the server is expected to echo on the
	 * `?code=` callback. Required on the production code-exchange path; the
	 * legacy `?token=` fallback bypasses this check because older servers
	 * don't echo state and we'd otherwise lock those users out of sign-in.
	 */
	readonly expectedState: string;
	onListen(): void;
	onSuccess(): void;
	onError(error: Error): void;
}

/**
 * Creates the local HTTP callback server. Exported for testing.
 *
 * Accepts two callback shapes, in priority order:
 *
 *   1. Code-exchange (preferred — issued by upgraded servers):
 *        /callback?code=<32-byte-hex>
 *      Redeemed via {@link exchangeCliCode}; the token never appears in the
 *      browser address bar, history, or referer logs — it arrives only as the
 *      JSON response of the server-to-server exchange POST.
 *
 *   2. Legacy token-in-URL (fallback — issued by pre-code-exchange servers):
 *        /callback?token=<jwt>&jolli_api_key=<sk-jol-…>
 *      Server delivers credentials directly in query params. Less secure
 *      (token visible to browser history/referer), but required so users on
 *      the latest CLI can still sign in to a server that hasn't shipped the
 *      code-exchange endpoint yet. Remove once all server tenants issue
 *      `?code=` callbacks.
 */
export function createLoginServer(options: LoginServerOptions): Server {
	const { port, jolliUrl, expectedState, onListen, onSuccess, onError } = options;

	const server = createServer(async (req, res) => {
		const url = new URL((req as { url: string }).url, `http://127.0.0.1:${port}`);
		if (url.pathname !== "/callback") {
			res.writeHead(404);
			res.end("Not found");
			return;
		}

		const error = url.searchParams.get("error");
		if (error) {
			const errorMessage = getErrorMessage(error);
			sendHtml(res, 400, "Login Failed", errorMessage);
			closeServer(server);
			onError(new Error(errorMessage));
			return;
		}

		// New and legacy shapes are mutually exclusive in practice (a given
		// server emits one or the other), so this just selects the right path
		// automatically — no version probe needed.
		const code = url.searchParams.get("code");
		const legacyToken = url.searchParams.get("token");

		// CSRF check (RFC 6749 §10.12): only enforced on the code-exchange
		// path. The legacy token-in-URL branch predates state support; older
		// servers don't echo state, and demanding it here would lock those
		// users out of sign-in. The legacy gap closes when the fallback is
		// removed.
		if (code) {
			const receivedState = url.searchParams.get("state");
			if (!receivedState || !constantTimeStringEqual(receivedState, expectedState)) {
				const message = "Invalid sign-in callback (state mismatch). Please try again.";
				sendHtml(res, 400, "Login Failed", message);
				closeServer(server);
				onError(new Error(message));
				return;
			}
		}

		try {
			let credentials: { token: string; jolliApiKey?: string; jolliUrl: string };
			if (code) {
				const exchanged = await exchangeCliCode(jolliUrl, code);
				credentials = {
					token: exchanged.token,
					// Persist the tenant the minted key actually targets, not the
					// sign-in origin `jolliUrl`. With no `JOLLI_URL` set the latter
					// is the auth hub (`auth.jolli.ai`), while the key's `meta.u` is
					// the user's real tenant — persisting the hub would (a) make
					// `saveAuthCredentials`'s same-tenant symmetry check reject every
					// normal key and (b) leave the routing fallback pointing at the
					// hub instead of the tenant. See `resolveSignInJolliUrl`.
					jolliUrl: resolveSignInJolliUrl(exchanged.jolliApiKey, jolliUrl),
					...(exchanged.jolliApiKey ? { jolliApiKey: exchanged.jolliApiKey } : {}),
				};
			} else if (legacyToken) {
				// Legacy fallback. Logged at warn level so we can track residual
				// usage and decide when it's safe to drop this branch.
				console.warn(
					"Using legacy token-in-URL callback — server has not been upgraded to the code-exchange flow",
				);
				const legacyApiKey = url.searchParams.get("jolli_api_key");
				credentials = {
					token: legacyToken,
					jolliUrl: resolveSignInJolliUrl(legacyApiKey ?? undefined, jolliUrl),
					...(legacyApiKey ? { jolliApiKey: legacyApiKey } : {}),
				};
			} else {
				const message = "No authorization code or token received";
				sendHtml(res, 400, "Login Failed", message);
				closeServer(server);
				onError(new Error(message));
				return;
			}
			await saveAuthCredentials(credentials);
			// The conversion event. `is_first_signup` is deliberately omitted —
			// the backend derives it authoritatively (from the account's creation
			// time) when it writes the join row; the client cannot know it.
			track("signin_completed", { api_key_minted: Boolean(credentials.jolliApiKey) });
			sendHtml(res, 200, "Login Successful!", "Your account has been connected to Jolli.");
			closeServer(server);
			onSuccess();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			sendHtml(res, 500, "Login Failed", message);
			closeServer(server);
			onError(err instanceof Error ? err : new Error(message));
		}
	});

	server.on("error", (err) => {
		closeServer(server);
		onError(err);
	});
	server.listen(port, "127.0.0.1", onListen);

	return server;
}

/** Forcefully closes the server and destroys all open connections so the process can exit. */
function closeServer(server: Server): void {
	server.closeAllConnections();
	server.close();
}

/**
 * Constant-time string equality. The 256-bit nonce makes timing leaks
 * infeasible in practice, but `timingSafeEqual` costs nothing extra and keeps
 * the comparison correct-by-construction.
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

/** Escapes HTML special characters to prevent XSS in rendered callback pages. */
function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Sends a styled HTML response to the browser callback tab. */
function sendHtml(res: ServerResponse, statusCode: number, title: string, message: string): void {
	title = escapeHtml(title);
	message = escapeHtml(message);
	const isSuccess = statusCode === 200;
	const icon = isSuccess ? "✓" : "✗";
	const accentColor = isSuccess ? "#10b981" : "#ef4444";

	res.writeHead(statusCode, { "Content-Type": "text/html" });
	res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Jolli</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #fafafa;
    color: #1a1a1a;
  }
  .card {
    text-align: center;
    padding: 3rem 2.5rem;
    max-width: 420px;
    width: 100%;
  }
  .icon {
    width: 64px; height: 64px;
    border-radius: 50%;
    background: ${accentColor};
    color: #fff;
    font-size: 32px;
    line-height: 64px;
    margin: 0 auto 1.5rem;
    font-weight: 600;
  }
  h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.5rem; }
  p { color: #666; font-size: 0.95rem; line-height: 1.5; }
  .hint { margin-top: 1.5rem; font-size: 0.8rem; color: #999; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    ${isSuccess ? '<p class="hint" id="hint">This tab will close automatically...</p>' : ""}
  </div>
  ${isSuccess ? '<script>setTimeout(function(){window.close()},1500);setTimeout(function(){document.getElementById("hint").textContent="You can close this tab now."},2000);</script>' : ""}
</body>
</html>`);
}

/** Maps server-returned error codes to user-friendly messages. */
function getErrorMessage(errorCode: string): string {
	const errorMessages: Record<string, string> = {
		oauth_failed: "OAuth authentication failed. Please try again.",
		session_missing: "Session expired or missing. Please try again.",
		invalid_provider: "Invalid authentication provider.",
		auth_fetch_failed: "Failed to fetch user information from the authentication provider.",
		no_verified_emails: "No verified email addresses found on your account.",
		server_error: "An unexpected server error occurred. Please try again later.",
		failed_to_get_token: "We couldn't retrieve your credentials. Please try signing in again.",
		user_denied: "Sign-in was cancelled. You can try again with `jolli auth login`.",
		invalid_callback: "The sign-in callback was rejected by the server. Please try again.",
	};

	return errorMessages[errorCode] || `Authentication error: ${errorCode}`;
}

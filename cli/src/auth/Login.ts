/**
 * Browser OAuth Login Flow
 *
 * Opens the user's browser to the Jolli login/signup page and starts a local
 * HTTP server to receive the OAuth callback. On success, redeems the
 * single-use exchange code (JOLLI-1270) and persists the auth token (and
 * optionally an API key) to the global config.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import open from "open";
import { loadConfig } from "../core/SessionTracker.js";
import { saveAuthCredentials } from "./AuthConfig.js";
import { exchangeCliCode } from "./CliExchange.js";

/**
 * Opens the browser to `${jolliUrl}/login` with a CLI callback URL, waits for
 * the OAuth redirect, redeems the exchange code, and saves the resulting
 * credentials.
 *
 * Uses port 0 so the OS assigns a free port — avoids EADDRINUSE conflicts.
 *
 * @param jolliUrl Origin of the Jolli server (e.g. `https://app.jolli.ai`).
 *   The same origin is used to build the login page URL and to redeem the
 *   exchange code, so the two halves of the flow can never disagree on which
 *   tenant is being signed into.
 */
export function browserLogin(jolliUrl: string): Promise<void> {
	return new Promise((resolve, reject) => {
		// 256-bit CSRF nonce per RFC 6749 §10.12. Sent on the login URL and
		// echoed back unchanged on the `?code=` callback; mismatch means the
		// callback didn't originate from the login flow we just opened.
		const expectedState = randomBytes(32).toString("hex");
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

					// If no jolliApiKey yet, ask the server to generate one during login
					const config = await loadConfig();
					let loginUrl = `${jolliUrl}/login?cli_callback=${encodeURIComponent(callbackUrl)}&state=${expectedState}`;
					if (!config.jolliApiKey) {
						loginUrl += "&generate_api_key=true&client=cli";
					}

					console.log("Opening browser to login...");
					console.log(`If the browser doesn't open automatically, visit: ${loginUrl}`);

					// Detach the browser process so it doesn't block Node.js from exiting
					const child = await open(loginUrl);
					child.unref();
				} catch (err) {
					closeServer(server);
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			},
			onSuccess: resolve,
			onError: reject,
		});
	});
}

interface LoginServerOptions {
	readonly port: number;
	/** Jolli origin used to redeem the exchange code (server-to-server POST). */
	readonly jolliUrl: string;
	/**
	 * CSRF nonce (RFC 6749 §10.12) the server is expected to echo on the
	 * `?code=` callback. Required on the production code-exchange path; the
	 * legacy `?token=` fallback bypasses this check because pre-1270 servers
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
 *   1. JOLLI-1270 code-exchange (preferred — issued by upgraded servers):
 *        /callback?code=<32-byte-hex>
 *      Redeemed via {@link exchangeCliCode}; the token never appears in the
 *      browser address bar, history, or referer logs — it arrives only as the
 *      JSON response of the server-to-server exchange POST.
 *
 *   2. Legacy token-in-URL (fallback — issued by pre-1270 servers):
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
		// path. The legacy token-in-URL branch predates state support; pre-1270
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
			let credentials: { token: string; jolliApiKey?: string };
			if (code) {
				const exchanged = await exchangeCliCode(jolliUrl, code);
				credentials = {
					token: exchanged.token,
					...(exchanged.jolliApiKey ? { jolliApiKey: exchanged.jolliApiKey } : {}),
				};
			} else if (legacyToken) {
				// Legacy fallback. Logged at warn level so we can track residual
				// usage and decide when it's safe to drop this branch.
				console.warn(
					"Using legacy token-in-URL callback — server has not been upgraded to JOLLI-1270 code-exchange",
				);
				const legacyApiKey = url.searchParams.get("jolli_api_key");
				credentials = {
					token: legacyToken,
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

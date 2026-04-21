/**
 * Browser OAuth Login Flow
 *
 * Opens the user's browser to the Jolli login/signup page and starts a local
 * HTTP server to receive the OAuth callback. On success, persists the auth
 * token (and optionally an API key) to the global config.
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import open from "open";
import { loadConfig } from "../core/SessionTracker.js";
import { saveAuthCredentials } from "./AuthConfig.js";

/**
 * Opens the browser to `baseUrl` with a CLI callback URL, waits for the OAuth
 * redirect, and saves the resulting credentials.
 *
 * Uses port 0 so the OS assigns a free port — avoids EADDRINUSE conflicts.
 *
 * @param baseUrl - Full login page URL (e.g. `https://app.jolli.ai/login`)
 */
export function browserLogin(baseUrl: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const server = createLoginServer({
			port: 0,
			async onListen() {
				try {
					const addr = server.address();
					/* v8 ignore start - server.address() always returns AddressInfo when listening */
					const actualPort = typeof addr === "object" && addr ? addr.port : 0;
					/* v8 ignore stop */

					const callbackUrl = `http://127.0.0.1:${actualPort}/callback`;

					// If no jolliApiKey yet, ask the server to generate one during login
					const config = await loadConfig();
					let loginUrl = `${baseUrl}?cli_callback=${encodeURIComponent(callbackUrl)}`;
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
	onListen(): void;
	onSuccess(): void;
	onError(error: Error): void;
}

/**
 * Creates the local HTTP callback server. Exported for testing.
 */
export function createLoginServer(options: LoginServerOptions): Server {
	const { port, onListen, onSuccess, onError } = options;

	const server = createServer(async (req, res) => {
		const url = new URL((req as { url: string }).url, `http://127.0.0.1:${port}`);
		if (url.pathname !== "/callback") {
			res.writeHead(404);
			res.end("Not found");
			return;
		}

		const token = url.searchParams.get("token");
		const jolliApiKey = url.searchParams.get("jolli_api_key");
		const error = url.searchParams.get("error");

		// Space param is intentionally ignored — JolliMemory doesn't use space slug

		if (error) {
			const errorMessage = getErrorMessage(error);
			sendHtml(res, 400, "Login Failed", errorMessage);
			closeServer(server);
			onError(new Error(errorMessage));
			return;
		}

		if (!token) {
			sendHtml(res, 400, "Login Failed", "No token received");
			closeServer(server);
			onError(new Error("No token received"));
			return;
		}

		try {
			await saveAuthCredentials({ token, jolliApiKey: jolliApiKey ?? undefined });
			sendHtml(res, 200, "Login Successful!", "Your account has been connected to Jolli.");
			closeServer(server);
			onSuccess();
		} catch (err) {
			sendHtml(res, 500, "Error", `Failed to save token: ${err}`);
			closeServer(server);
			onError(err instanceof Error ? err : new Error(String(err)));
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
	};

	return errorMessages[errorCode] || `Authentication error: ${errorCode}`;
}

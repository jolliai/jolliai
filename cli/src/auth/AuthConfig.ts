/**
 * Auth Configuration
 *
 * Manages OAuth auth token storage and Jolli server URL resolution.
 * Tokens are stored in ~/.jolli/jollimemory/config.json alongside other config fields.
 */

import { assertJolliOriginAllowed, validateJolliApiKey } from "../core/JolliApiUtils.js";
import { loadConfig, saveConfig } from "../core/SessionTracker.js";

const DEFAULT_JOLLI_URL = "https://app.jolli.ai";

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
 * Saves the OAuth auth token and an optional Jolli API key in a single atomic
 * write. Use this when receiving both fields from the same auth callback, so
 * a partial failure can't leave the config with a token but no API key (or vice
 * versa).
 *
 * Also writes `aiProvider: "jolli"` because clicking "Sign in to Jolli" is the
 * user's explicit declaration of intent to use Jolli for AI summaries. This
 * aligns the dispatcher's `resolveLlmCredentialSource` with the user's
 * onboarding choice — without it, a returning user who already had an
 * Anthropic API key in config would see Settings UI promise "using Jolli" but
 * the dispatcher would still pick Anthropic via the legacy precedence path.
 *
 * `clearAuthCredentials` rolls back this auto-write on logout so the config
 * doesn't keep a "jolli" preference whose credentials are gone.
 */
export async function saveAuthCredentials(credentials: {
	readonly token: string;
	readonly jolliApiKey?: string;
}): Promise<void> {
	const update: { authToken: string; jolliApiKey?: string; aiProvider: "jolli" } = {
		authToken: credentials.token,
		aiProvider: "jolli",
	};
	if (credentials.jolliApiKey) {
		validateJolliApiKey(credentials.jolliApiKey);
		update.jolliApiKey = credentials.jolliApiKey;
	}
	await saveConfig(update);
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
 * `aiProvider` preference, since `saveAuthCredentials` writes that preference
 * automatically on sign-in. Leaving it behind would keep
 * `resolveLlmCredentialSource` pinned to the proxy after the credentials are
 * gone — making subsequent commits fail silently in VS Code (where the CLI
 * warning copy never reaches the user). An explicit `aiProvider: "anthropic"`
 * choice is preserved so a user who deliberately picked Anthropic in Settings
 * isn't reset by an unrelated logout.
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

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
 * versa). Symmetric with `clearAuthCredentials`.
 */
export async function saveAuthCredentials(credentials: {
	readonly token: string;
	readonly jolliApiKey?: string;
}): Promise<void> {
	const update: { authToken: string; jolliApiKey?: string } = { authToken: credentials.token };
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

/** Clears both auth token and Jolli API key from global config for a complete logout. */
export async function clearAuthCredentials(): Promise<void> {
	await saveConfig({ authToken: undefined, jolliApiKey: undefined });
}

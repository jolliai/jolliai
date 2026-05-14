/**
 * Device label helper for the OAuth login URL.
 *
 * The server uses the optional `device_name` query param to scope the
 * idempotency key when minting an auto-generated Jolli API key, so the same
 * user signing in from two machines under the same account ends up with two
 * distinct API-key rows (one per device) instead of clobbering each other.
 *
 * Sanitization rules mirror the server's `sanitizeDeviceLabel` exactly —
 * trim, keep only `[A-Za-z0-9 _.-]`, max 32 chars — so a sketchy hostname
 * doesn't get silently dropped server-side and produce a name-column mismatch.
 *
 * Both CLI (`browserLogin`) and the VSCode extension (`AuthService.openSignInPage`)
 * import this helper so the wire format stays identical across surfaces.
 */

import { hostname } from "node:os";

const DEVICE_LABEL_ALLOWED = /[^A-Za-z0-9 _.-]/g;
const DEVICE_LABEL_MAX_LEN = 32;

/**
 * Normalizes a raw device label to the server-accepted shape.
 *
 * Returns `undefined` when the result would be empty so callers can use
 * `if (label)` to decide whether to append the query param at all.
 */
export function sanitizeDeviceLabel(raw: string): string | undefined {
	const cleaned = raw.trim().replace(DEVICE_LABEL_ALLOWED, "").slice(0, DEVICE_LABEL_MAX_LEN);
	return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Returns the sanitized host machine name, or `undefined` if the hostname is
 * empty / made up entirely of disallowed characters.
 */
export function getDeviceLabel(): string | undefined {
	return sanitizeDeviceLabel(hostname());
}

/**
 * Jolli API Utilities
 *
 * Shared URL/Key parsing functions used by both the CLI hooks (jollimemory)
 * and the VS Code extension (jollimemory-vscode).
 */

/** Result of parsing a Jolli Space base URL */
export interface ParsedBaseUrl {
	/** The origin without any path prefix (e.g. "https://jolli-local.me") */
	readonly origin: string;
	/** Tenant slug extracted from the first path segment, if present */
	readonly tenantSlug: string | undefined;
}

/** Decoded metadata from a Jolli API key (sk-jol-...) */
export interface JolliApiKeyMeta {
	/** Tenant identifier */
	readonly t: string;
	/** Site base URL (e.g. "https://example.jolli.dev") */
	readonly u: string;
	/** Organization slug (optional) */
	readonly o?: string;
}

/**
 * Parses a Jolli Space base URL into its origin and optional tenant slug.
 * The tenant slug is extracted from the first path segment if present.
 */
export function parseBaseUrl(baseUrl: string): ParsedBaseUrl {
	const url = new URL(baseUrl);
	const pathSegments = url.pathname
		.replace(/^\/+|\/+$/g, "")
		.split("/")
		.filter(Boolean);
	return {
		origin: url.origin,
		tenantSlug: pathSegments.length > 0 ? pathSegments[0] : undefined,
	};
}

/**
 * Parses a Jolli API key (sk-jol-...) and extracts its metadata.
 * Returns null for old-format (no-dot) keys and for unrecognized shapes.
 *
 * Scans every `.`-separated segment after the `sk-jol-` prefix and returns
 * the first one that base64url-decodes to a JSON object containing string
 * `t` and `u` fields. This covers:
 *   - Format A (1 dot):   `sk-jol-<metaB64>.<secretB64>` — meta in segment 0
 *   - Format B (JWT, 2 dots): `sk-jol-<headerB64>.<payloadB64>.<sigB64>` — meta in segment 1
 *
 * Scanning (rather than fixing on a specific segment index) means the allowlist
 * check in `assertJolliOriginAllowed` runs for both formats — a key whose
 * claimed `u` is off-allowlist is rejected regardless of which segment carries it.
 */
export function parseJolliApiKey(key: string): JolliApiKeyMeta | null {
	if (!key.startsWith("sk-jol-")) {
		return null;
	}
	const rest = key.slice("sk-jol-".length);
	if (!rest.includes(".")) {
		// Old format: `sk-jol-<32 hex chars>` — no embedded meta.
		return null;
	}
	for (const segment of rest.split(".")) {
		try {
			const json = Buffer.from(segment, "base64url").toString("utf-8");
			const meta = JSON.parse(json) as Record<string, unknown>;
			if (typeof meta.t === "string" && typeof meta.u === "string") {
				return {
					t: meta.t,
					u: meta.u,
					...(typeof meta.o === "string" ? { o: meta.o } : {}),
				};
			}
		} catch {
			// Segment isn't valid base64url JSON — try the next one.
		}
	}
	return null;
}

/**
 * Rejects any Jolli API key we cannot decode, and any whose embedded `.u`
 * claim points off the allowlist. Called from every save path (OAuth callback,
 * settings UI, `configure --set`).
 *
 * Two checks, both enforced:
 *   1. `parseJolliApiKey(key)` must return meta with `t` and `u` strings —
 *      anything we can't decode (wrong prefix, non-base64url chars, no dot,
 *      legacy-only shape, garbage) is refused.
 *   2. `assertJolliOriginAllowed(meta.u)` must pass.
 */
export function validateJolliApiKey(key: string): void {
	const meta = parseJolliApiKey(key);
	if (!meta) {
		throw new Error("Rejected Jolli API key: cannot be decoded. Paste the key exactly as issued by Jolli.");
	}
	assertJolliOriginAllowed(meta.u);
}

const ALLOWED_JOLLI_HOSTS = ["jolli.ai", "jolli.dev", "jolli-local.me"];

/**
 * Rejects origins that are not on the Jolli allowlist. Called from the
 * settings save path (and the `JOLLI_URL` env-var resolver) so a crafted key
 * or a socially-engineered env var is refused before it can be persisted or
 * used as an OAuth target.
 *
 * Not intended for the network boundary — by the time a saved config is
 * loaded for a request, the save-time check has already screened it, and
 * adding another layer there is just "defense against scenarios that can't
 * happen".
 */
export function assertJolliOriginAllowed(origin: string): void {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		throw new Error(`Rejected Jolli origin (unparseable): ${origin}`);
	}
	const host = url.hostname.toLowerCase();
	const ok =
		url.protocol === "https:" &&
		host !== "" &&
		ALLOWED_JOLLI_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
	if (ok) {
		return;
	}
	throw new Error(
		`Rejected Jolli origin "${url.origin}". Only https://*.jolli.ai, https://*.jolli.dev, and https://*.jolli-local.me are permitted.`,
	);
}

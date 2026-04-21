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
	/** Site base URL (e.g. "https://example.jolli.app") */
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
 * Returns null if the key format is invalid.
 */
export function parseJolliApiKey(key: string): JolliApiKeyMeta | null {
	if (!key.startsWith("sk-jol-")) {
		return null;
	}
	const rest = key.slice("sk-jol-".length);
	const dotIndex = rest.indexOf(".");
	if (dotIndex === -1) {
		return null;
	}
	try {
		const metaJson = Buffer.from(rest.slice(0, dotIndex), "base64url").toString("utf-8");
		const meta = JSON.parse(metaJson) as Record<string, unknown>;
		if (typeof meta.t === "string" && typeof meta.u === "string") {
			return { t: meta.t, u: meta.u, ...(typeof meta.o === "string" ? { o: meta.o } : {}) };
		}
		return null;
	} catch {
		return null;
	}
}

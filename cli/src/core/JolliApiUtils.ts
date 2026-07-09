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
 * Resolves the browsable article URL for a pushed doc.
 *
 * Prefers the server-returned `serverUrl` (absolute is used as-is; relative is
 * prefixed with `displayBase`). Falls back to the `?doc=<id>` alias only when
 * the server returned no URL. Shared by the CLI and VS Code push orchestrators
 * so the stored/displayed URL matches the web app's canonical article path.
 */
export function resolveArticleUrl(displayBase: string, serverUrl: string | undefined, docId: number): string {
	if (!serverUrl) return `${displayBase}/articles?doc=${docId}`;
	return /^https?:\/\//i.test(serverUrl)
		? serverUrl
		: `${displayBase}${serverUrl.startsWith("/") ? "" : "/"}${serverUrl}`;
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
 * Derives a stable "environment key" identifying the BACKEND a push targets:
 * the lowercased origin (e.g. `https://jolli.ai`). A server-minted id (`jolliDocId`,
 * branch `shareId`) is only reused as an update/reopen target when the current
 * push's env key matches the one it was minted against — otherwise the id belongs
 * to a different backend and must not be sent.
 *
 * Origin only — deliberately NOT org/tenant. The id namespaces are per-backend
 * (each of jolli-local.me / jolli.ai / jolli.cloud is its own database), so origin
 * is what distinguishes them, and it's the only cross-environment switch that
 * actually happens (local↔prod). The server still re-validates space/repo/owner on
 * every push (`isValidJolliDoc`), so this key is a cleanliness optimization, never a
 * correctness guard: the worst a mismatch can do is skip a reuse and let the server
 * create a fresh doc. Keying on the mutable org/tenant slugs instead would only add
 * rename-fragility (a renamed org would spuriously look like a new environment) for
 * a same-origin org-switch case the server backstop already handles safely.
 *
 * Returns undefined when there is no base URL to key on; callers treat "no current
 * env key" as "don't reuse a tagged id". Throws on an unparseable non-empty input
 * (callers feeding stored/untrusted URLs — e.g. `canReuseDocId` — guard for it).
 */
export function deriveJolliEnvKey(baseUrl: string | undefined): string | undefined {
	return baseUrl ? parseBaseUrl(baseUrl).origin.toLowerCase() : undefined;
}

/**
 * Convenience over {@link deriveJolliEnvKey} for callers that hold only an API key:
 * the key's embedded `.u` claim IS the base URL. Returns undefined when the key is
 * absent or can't be decoded.
 */
export function deriveJolliEnvKeyFromApiKey(apiKey: string | undefined): string | undefined {
	return deriveJolliEnvKey(apiKey ? parseJolliApiKey(apiKey)?.u : undefined);
}

/**
 * Coarser sibling of {@link deriveJolliEnvKey}: the DEPLOYMENT backend key, reduced
 * to the registrable domain so every tenant of a backend collapses to one key
 * (`acme.jolli.ai` → `https://jolli.ai`, `jolli-local.me` → `https://jolli-local.me`).
 *
 * Used where the only URL available is the tenant-free base-domain form — the branch
 * share `shareUrl` (built from the server's `BASE_DOMAIN`, never a tenant host). A
 * share minted on any tenant of a backend must match the current key targeting that
 * same backend, so the tenant subdomain is stripped. Trade-off vs the tenant-precise
 * `deriveJolliEnvKey`: a same-deployment cross-tenant switch is treated as the same
 * backend (an accepted, rare case). The allowlisted backends use a single-label public
 * suffix, so the registrable domain is the last two labels; dot-less hosts (`localhost`)
 * and IPv4 are kept whole; scheme and non-default port are preserved.
 *
 * Returns undefined for a missing/unparseable input.
 */
export function deriveJolliBackendKey(url: string | undefined): string | undefined {
	if (!url) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	const labels = parsed.hostname.split(".");
	const isIpv4 = /^\d+$/.test(labels[labels.length - 1]);
	const registrable = labels.length > 2 && !isIpv4 ? labels.slice(-2).join(".") : parsed.hostname;
	const port = parsed.port ? `:${parsed.port}` : "";
	return `${parsed.protocol}//${registrable}${port}`.toLowerCase();
}

/** Convenience over {@link deriveJolliBackendKey} for callers that hold only an API key. */
export function deriveJolliBackendKeyFromApiKey(apiKey: string | undefined): string | undefined {
	return deriveJolliBackendKey(apiKey ? parseJolliApiKey(apiKey)?.u : undefined);
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

/**
 * Allowlist of host suffixes the Jolli API key / OAuth callback may target.
 * Exported so the VS Code Settings webview can inline this exact list at
 * extension build time (`SettingsScriptBuilder.buildSettingsScript`),
 * eliminating drift between the CLI's `assertJolliOriginAllowed` and the
 * webview-side validator. The IntelliJ port (`JolliApiClient.kt`) is the
 * remaining cross-language sibling — keep all three in lockstep.
 */
export const ALLOWED_JOLLI_HOSTS: readonly string[] = ["jolli.ai", "jolli.dev", "jolli.cloud", "jolli-local.me"];

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
		`Rejected Jolli origin "${url.origin}". Only https://*.jolli.ai, https://*.jolli.dev, https://*.jolli.cloud, and https://*.jolli-local.me are permitted.`,
	);
}

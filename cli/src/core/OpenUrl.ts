/**
 * The CLI's single browser-open primitive: open one backend-supplied `https`
 * URL in the developer's default browser, or fall back to printing it (headless
 * / no browser / launch failure). It NEVER throws for a launch problem and NEVER
 * blocks — the only thrown error is for invalid input (a non-`https` or
 * unparseable URL), which the calling command turns into a `{ type: "error" }`
 * result. The URL is opened verbatim; this primitive constructs nothing.
 *
 * Contract:
 *   - non-`https:` scheme (or an unparseable URL) ⇒ throws a typed Error (the
 *     caller surfaces `{ type: "error", message }`, exit 1). Deliberately stricter
 *     than the VS Code reference sink (which allows `http`+`https`) because every
 *     URL this feature opens is a backend-supplied `https` deep-link.
 *   - off-allowlist origin ⇒ **refused, not launched**: print the URL, return
 *     `{ opened: false, url, refused: true, reason: "origin-not-allowlisted" }`
 *     (exit 0). A buggy or compromised payload can therefore never turn this into
 *     an arbitrary-launch / open-redirect primitive. The allowlist has three tiers:
 *     the canonical jolli-origin allowlist (workflow / run / article deep-links,
 *     via `assertJolliOriginAllowed`, reused verbatim — a 3-impl lockstep artifact,
 *     never forked here), a small known-git-host set (PR links), and an **opt-in
 *     dev-origins tier that is empty by default** — a local-development affordance for
 *     tunnel deep-links, sourced from the `openUrlAllowedOrigins` config key and the
 *     `JOLLI_OPEN_URL_ALLOWED_ORIGINS` env var (merged; see {@link resolveDevOriginHosts}).
 *     With neither set, the gate is identical to the two-tier default (production/normal
 *     users unaffected).
 *   - headless (a CI marker, or Linux with no `DISPLAY`/`WAYLAND_DISPLAY`) ⇒ skip
 *     the launch, print the URL, return `{ opened: false, url }`.
 *   - `open()` failure ⇒ print the URL, return `{ opened: false, url }`.
 *   - success ⇒ detach the browser child (`unref()`), return `{ opened: true, url }`.
 *
 * The fallback print goes to stderr so the command's single stdout JSON line
 * (`{ opened, url }`) stays clean for the agent/recipe that consumes it.
 */

import { assertJolliOriginAllowed } from "./JolliApiUtils.js";

/** The one capability {@link openUrlOrPrint} needs from a launched browser process. */
interface DetachableChild {
	unref(): void;
}

/** Injectable seams for {@link openUrlOrPrint}; the defaults hit the real environment. */
export interface OpenUrlDeps {
	/** Launch the URL in the default browser, resolving to a detachable child process. */
	launch: (url: string) => Promise<DetachableChild>;
	/** Whether the environment cannot show a browser (⇒ print instead of launching). */
	isHeadless: () => boolean;
	/** Emit the URL as a human-readable fallback (defaults to stderr). */
	print: (url: string) => void;
	/**
	 * Extra opt-in dev origins from persisted config (`openUrlAllowedOrigins`), merged
	 * with the `JOLLI_OPEN_URL_ALLOWED_ORIGINS` env var to form tier 3. The caller
	 * (the command) loads config and passes it — mirroring how `isPlatformToolsEnabled`
	 * takes an injected config rather than reading the file itself. Defaults to none.
	 */
	configOrigins: readonly string[];
}

/** Result of {@link openUrlOrPrint}: whether the browser launched, and the URL acted on. */
export interface OpenUrlResult {
	opened: boolean;
	url: string;
	/** `true` only when the URL was refused for being off the origin allowlist (never launched, still printed). */
	refused?: boolean;
	/** Machine-readable refusal reason; present only alongside `refused: true`. */
	reason?: string;
}

/** Machine-readable `reason` on an off-allowlist refusal — stable for recipe/menu consumers. */
export const ORIGIN_NOT_ALLOWLISTED = "origin-not-allowlisted";

/**
 * Known external git hosts whose PR URLs `open-url` may auto-launch. PR links point
 * at a git host (not a jolli origin) and are withheld entirely for private
 * `jolli-git` destinations, so this is a small, explicit set matched with the same
 * https + suffix-boundary rule as {@link assertJolliOriginAllowed}. A self-hosted
 * git PR URL (e.g. GitHub Enterprise on a custom domain) falls outside it and
 * degrades to print-only. Kept here — NOT in `JolliApiUtils.ts`, which stays
 * jolli-only and unforked (its three implementations are kept in lockstep).
 */
const ALLOWED_GIT_HOSTS: readonly string[] = ["github.com", "gitlab.com", "bitbucket.org"];

/**
 * Env var naming the opt-in dev-origins allowlist (tier 3): a comma-separated list of
 * tunnel hosts a local dev explicitly trusts. Empty / unset by default — see
 * {@link parseDevOriginHosts}.
 */
const DEV_ORIGINS_ENV = "JOLLI_OPEN_URL_ALLOWED_ORIGINS";

/** Shared host match used by every non-jolli tier: exact host, or a dotted subdomain of it. */
function hostMatches(host: string, allowed: string): boolean {
	return host === allowed || host.endsWith(`.${allowed}`);
}

/**
 * Normalize one dev-origins entry to a lowercase host, or `undefined` if it is
 * unparseable. Accepts a bare host (`x.ngrok-free.dev`) or a full origin
 * (`https://x.ngrok-free.dev`) — both resolve to the host. A malformed entry is
 * dropped rather than thrown so a bad env value can never crash `open-url`.
 */
function devOriginToHost(entry: string): string | undefined {
	const withScheme = entry.includes("://") ? entry : `https://${entry}`;
	try {
		return new URL(withScheme).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

/**
 * Resolve the opt-in dev-origins allowlist (tier 3) as normalized hosts, merging the
 * persisted `openUrlAllowedOrigins` config (passed by the caller) with the
 * `JOLLI_OPEN_URL_ALLOWED_ORIGINS` env var (comma-separated) — **env adds to config,
 * it does not replace it**. A **local-development affordance**: in a tunnel/dev
 * deployment the backend renders absolute deep-links from its configured public base
 * URL (e.g. an ngrok host), which is neither a jolli origin nor a known git host, so
 * tiers 1–2 correctly refuse them. A dev names their tunnel origin(s) here to let those
 * `https` deep-links launch; everything else stays refused-and-printed. Both sources
 * empty ⇒ no dev origins (the gate is then byte-identical to the two-tier default, so
 * production is unaffected). Each entry is normalized to a host and matched with the
 * same suffix-boundary rule as the other tiers; the URL being opened is still
 * `https`-only (enforced upstream).
 */
function resolveDevOriginHosts(configOrigins: readonly string[]): string[] {
	const entries = [...configOrigins];
	const envRaw = process.env[DEV_ORIGINS_ENV];
	if (envRaw) {
		entries.push(...envRaw.split(","));
	}
	const hosts: string[] = [];
	for (const entry of entries) {
		const trimmed = entry.trim();
		if (!trimmed) {
			continue;
		}
		const host = devOriginToHost(trimmed);
		if (host) {
			hosts.push(host);
		}
	}
	return hosts;
}

/**
 * Whether `parsed`'s origin is on the open-url allowlist: tier 1 = the canonical
 * jolli-origin allowlist (reused verbatim from `JolliApiUtils`, no fork); tier 2 =
 * the known external git-host set for PR links; tier 3 = the opt-in dev-origins set
 * (`devHosts`, empty by default). `parsed` is already a valid `https` URL by the time
 * this runs (see {@link assertHttpsUrl}), so tiers 2–3 only need a suffix-boundary host
 * match. Any other origin is off-allowlist.
 */
function isOriginAllowlisted(parsed: URL, devHosts: readonly string[]): boolean {
	try {
		assertJolliOriginAllowed(parsed.href);
		return true;
	} catch {
		// Not a jolli origin — fall through to the git-host + dev-origin tiers.
	}
	const host = parsed.hostname.toLowerCase();
	if (ALLOWED_GIT_HOSTS.some((h) => hostMatches(host, h))) {
		return true;
	}
	return devHosts.some((h) => hostMatches(host, h));
}

/**
 * Lazy-import the already-declared `open` package (kept out of the hot path, and
 * injectable in tests) and launch the URL. Mirrors the `GraphCommand`/`Login`
 * usage: `open(url)` resolves to a child process we detach with `unref()`.
 */
async function defaultLaunch(url: string): Promise<DetachableChild> {
	const open = (await import("open")).default;
	return open(url);
}

/**
 * True when we should not attempt a browser launch: a CI environment (any
 * platform), or Linux with no display server (`DISPLAY`/`WAYLAND_DISPLAY` unset).
 */
function defaultIsHeadless(): boolean {
	if (process.env.CI) {
		return true;
	}
	if (process.platform === "linux") {
		return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
	}
	return false;
}

/** Print the URL to stderr, keeping stdout reserved for the command's JSON line. */
function defaultPrint(url: string): void {
	process.stderr.write(`${url}\n`);
}

/** Returns the parsed URL, throwing a typed Error unless `url` parses and uses the `https:` scheme. */
function assertHttpsUrl(url: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`open-url requires a valid https URL, got: ${url}`);
	}
	if (parsed.protocol !== "https:") {
		throw new Error(`open-url only opens https URLs, got scheme: ${parsed.protocol}`);
	}
	return parsed;
}

/**
 * Open `url` in the default browser, or print it as a fallback. See the file
 * header for the full contract. Rejects only for invalid input; a launch failure
 * or a headless environment resolves to `{ opened: false, url }`.
 */
export async function openUrlOrPrint(url: string, deps: Partial<OpenUrlDeps> = {}): Promise<OpenUrlResult> {
	const parsed = assertHttpsUrl(url);
	const launch = deps.launch ?? defaultLaunch;
	const isHeadless = deps.isHeadless ?? defaultIsHeadless;
	const print = deps.print ?? defaultPrint;
	const devHosts = resolveDevOriginHosts(deps.configOrigins ?? []);

	// Refuse (never launch) an off-allowlist origin — the last-line guard against a
	// crafted payload turning open-url into an arbitrary-launch primitive. Still
	// print the URL so the user can open it manually; a refusal is a safe outcome.
	if (!isOriginAllowlisted(parsed, devHosts)) {
		print(url);
		return { opened: false, url, refused: true, reason: ORIGIN_NOT_ALLOWLISTED };
	}

	if (isHeadless()) {
		print(url);
		return { opened: false, url };
	}
	try {
		const child = await launch(url);
		child.unref();
		return { opened: true, url };
	} catch {
		print(url);
		return { opened: false, url };
	}
}

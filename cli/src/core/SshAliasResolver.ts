/**
 * SshAliasResolver — resolves an SSH host token to its real `HostName`.
 *
 * A user's `~/.ssh/config` can define host aliases, e.g.
 *
 *     Host github-jolli
 *         HostName github.com
 *
 * so `git@github-jolli:owner/repo.git` and `git@github.com:owner/repo.git`
 * point at the SAME GitHub repo. Every git-remote canonicalizer that compares
 * the *literal* host token would treat those as two different repos — which is
 * exactly what split one repo into `<repo>` and `<repo>-2` Memory Bank folders.
 *
 * `resolveHostEndpoint` runs `ssh -G <host>` (offline — it only parses the ssh
 * config, no network) and returns the resolved `hostname` and `port`
 * (`resolveHostAlias` is the host-only convenience wrapper). A resolved host
 * that is a KNOWN connection endpoint (e.g. `ssh.github.com`, GitHub's
 * ssh-over-443 target) is mapped back to its forge identity host so it does not
 * split from an https clone. It is:
 *
 *  - **Memoized** per host (the ssh config is static for a process lifetime),
 *    so at most one subprocess per distinct host token.
 *  - **Fail-safe**: any error — `ssh` missing from PATH, a timeout, an
 *    unparseable output — returns the original host unchanged, never throws.
 *    A host with no matching `Host` block resolves to itself anyway (ssh
 *    echoes the token back as `hostname`), so a bare `github.com` is a no-op.
 *
 * Hermetic in tests: the default runner short-circuits under `VITEST`, so the
 * many `foldGitTransportToHttps` folding assertions stay pure and never spawn a
 * subprocess. Tests that exercise resolution inject a fake runner via
 * {@link __setSshRunnerForTests}.
 */

import { createLogger } from "../Logger.js";
import { execFileSyncHidden } from "../util/Subprocess.js";

const log = createLogger("SshAliasResolver");

// `ssh -G` is a local config parse, near-instant; the timeout only bounds a
// genuinely wedged ssh (e.g. one blocked on a ProxyCommand). A miss just falls
// back to the literal host, so a tight cap costs nothing.
const SSH_G_TIMEOUT_MS = 5_000;

/** The canonical endpoint an SSH host token resolves to. */
export interface ResolvedSshEndpoint {
	/**
	 * The identity host: the `~/.ssh/config` `HostName` (or the literal token
	 * when nothing resolves), after mapping a known SSH connection endpoint back
	 * to its forge host (see {@link KNOWN_SSH_ENDPOINT_ALIASES}).
	 */
	host: string;
	/**
	 * The `~/.ssh/config` `Port` for the host, or `""` when none was reported or
	 * it was dropped as a known-endpoint alt port. Callers apply their own
	 * default-port canonicalization (a bare `ssh -G` reports `22`, which carries
	 * no identity and is dropped downstream).
	 */
	port: string;
	/**
	 * True when `host` was mapped back from a {@link KNOWN_SSH_ENDPOINT_ALIASES}
	 * connection endpoint (`ssh.github.com` → `github.com`). The alt port belongs
	 * to the *connection*, not the repo identity, so a caller MUST drop even an
	 * EXPLICIT URL port when this is set — not just the config `port` (which this
	 * function already zeroed). Without honoring it, `ssh://git@ssh.github.com:443/o/r`
	 * keeps its `:443` and splits from the `https://github.com/o/r` clone.
	 */
	endpointRemapped: boolean;
}

/**
 * Known SSH connection ENDPOINTS that are NOT repo-identity hosts. A user's
 * `~/.ssh/config` may point a real forge host at an alternate SSH endpoint to
 * tunnel git over `:443` — GitHub's own documented "Using SSH over the HTTPS
 * port":
 *
 *     Host github.com
 *         HostName ssh.github.com
 *         Port 443
 *
 * `ssh -G github.com` then reports `HostName ssh.github.com` — a *connection*
 * endpoint, not the repo's identity host. Left as-is it would split a github.com
 * SSH clone from an https clone (the JOLLI-2135 bug, inverted). Each of these
 * endpoints serves exactly one forge, so mapping it back — and dropping the alt
 * port, which belongs to the endpoint and not the identity — is unambiguous.
 * Kept in step with `CASE_INSENSITIVE_PATH_HOSTS` (github/gitlab/bitbucket).
 */
const KNOWN_SSH_ENDPOINT_ALIASES: ReadonlyMap<string, string> = new Map([
	["ssh.github.com", "github.com"],
	["altssh.gitlab.com", "gitlab.com"],
	["altssh.bitbucket.org", "bitbucket.org"],
]);

/**
 * Runs `ssh -G <host>` and returns raw stdout, or `null` on any failure. The
 * bare `host` is the FIRST arg on purpose (test runners switch on it and stay
 * backward compatible); an optional `user` is threaded through so `Match user …`
 * blocks in `~/.ssh/config` apply — see {@link resolveHostEndpoint}.
 */
type SshRunner = (host: string, user?: string) => string | null;

const cache = new Map<string, ResolvedSshEndpoint>();
let sshRunner: SshRunner = defaultSshRunner;

/* v8 ignore start -- spawns a real subprocess; unit tests inject a fake runner */
function defaultSshRunner(host: string, user?: string): string | null {
	// Never spawn during tests — keeps the folding-assertion suites hermetic.
	// Resolution is covered via an injected runner in SshAliasResolver.test.ts.
	if (process.env.VITEST) return null;
	// The git remote is always `git@host`, and `ssh -G host` runs as the current
	// login user — so a `Match user git` block never fires without the `user@`.
	const destination = user ? `${user}@${host}` : host;
	try {
		return execFileSyncHidden("ssh", ["-G", destination], {
			encoding: "utf-8",
			timeout: SSH_G_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		log.debug("ssh -G %s failed: %s", destination, err instanceof Error ? err.message : String(err));
		return null;
	}
}
/* v8 ignore stop */

/** Extracts the first `<key> <value>` line from `ssh -G` output. */
function parseField(sshGOutput: string, key: string): string | null {
	const re = new RegExp(`^${key}\\s+(\\S+)`, "i");
	for (const line of sshGOutput.split(/\r?\n/)) {
		const m = line.match(re);
		if (m?.[1]) return m[1];
	}
	return null;
}

/**
 * Resolves an SSH host token to its canonical identity endpoint (host + port),
 * or returns it unchanged when there is no alias (or resolution fails). The
 * `HostName` is then mapped back through {@link KNOWN_SSH_ENDPOINT_ALIASES} so a
 * connection endpoint (`ssh.github.com`) does not masquerade as an identity
 * host. The optional `user` (the git remote's `git@` part) is passed to
 * `ssh -G user@host` so `Match user …` config blocks fire; results are memoized
 * per `user + host` so a resolution with a user and one without stay distinct.
 */
export function resolveHostEndpoint(host: string, user?: string): ResolvedSshEndpoint {
	if (!host) return { host, port: "", endpointRemapped: false };
	const cacheKey = `${user ?? ""}\x00${host}`;
	const cached = cache.get(cacheKey);
	if (cached !== undefined) return cached;

	let resolvedHost = host;
	let resolvedPort = "";
	const raw = sshRunner(host, user);
	if (raw) {
		const hostname = parseField(raw, "hostname");
		if (hostname) resolvedHost = hostname;
		const port = parseField(raw, "port");
		if (port) resolvedPort = port;
	}

	// Map a known SSH connection endpoint back to its forge host; the alt port is
	// the endpoint's, not the identity's, so it is dropped and the remap is flagged
	// (callers must drop even an explicit URL port — see ResolvedSshEndpoint).
	const forge = KNOWN_SSH_ENDPOINT_ALIASES.get(resolvedHost.toLowerCase());
	const result: ResolvedSshEndpoint = forge
		? { host: forge, port: "", endpointRemapped: true }
		: { host: resolvedHost, port: resolvedPort, endpointRemapped: false };
	cache.set(cacheKey, result);
	return result;
}

/**
 * Formats a resolved host as a URL authority: a bare IPv6 literal is bracketed
 * (`2001:db8::1` → `[2001:db8::1]`) so `https://<host>/…` parses. `ssh -G`
 * reports an IPv6 `HostName` WITHOUT brackets, so an alias resolving to one would
 * otherwise splice into an invalid URL that also fails to match a bracketed https
 * clone of the same repo. Idempotent — an already-bracketed host (a WHATWG
 * `URL.hostname` for IPv6) is returned unchanged — and a normal DNS host, which
 * never contains a colon, passes straight through.
 */
export function formatHostForUrl(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Resolves an SSH host token to its configured `HostName` (or returns it
 * unchanged). Convenience over {@link resolveHostEndpoint} for callers that do
 * not need the port. Memoized per host.
 */
export function resolveHostAlias(host: string): string {
	return resolveHostEndpoint(host).host;
}

/**
 * Test seam: inject a fake `ssh -G` runner (returning raw stdout, or `null`
 * for a failure) and clear the cache. Pass `null` to restore the default
 * runner. Not for production use.
 */
export function __setSshRunnerForTests(runner: SshRunner | null): void {
	sshRunner = runner ?? defaultSshRunner;
	cache.clear();
}

/** Test seam: clear the memoization cache without changing the runner. */
export function __resetSshAliasCacheForTests(): void {
	cache.clear();
}

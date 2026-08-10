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
 * `resolveHostAlias` runs `ssh -G <host>` (offline — it only parses the ssh
 * config, no network) and returns the resolved `hostname`. It is:
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

/** Runs `ssh -G <host>` and returns raw stdout, or `null` on any failure. */
type SshRunner = (host: string) => string | null;

const cache = new Map<string, string>();
let sshRunner: SshRunner = defaultSshRunner;

/* v8 ignore start -- spawns a real subprocess; unit tests inject a fake runner */
function defaultSshRunner(host: string): string | null {
	// Never spawn during tests — keeps the folding-assertion suites hermetic.
	// Resolution is covered via an injected runner in SshAliasResolver.test.ts.
	if (process.env.VITEST) return null;
	try {
		return execFileSyncHidden("ssh", ["-G", host], {
			encoding: "utf-8",
			timeout: SSH_G_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		log.debug("ssh -G %s failed: %s", host, err instanceof Error ? err.message : String(err));
		return null;
	}
}
/* v8 ignore stop */

/** Extracts the `hostname <value>` line from `ssh -G` output. */
function parseHostname(sshGOutput: string): string | null {
	for (const line of sshGOutput.split(/\r?\n/)) {
		const m = line.match(/^hostname\s+(\S+)/i);
		if (m?.[1]) return m[1];
	}
	return null;
}

/**
 * Resolves an SSH host token to its configured `HostName`, or returns it
 * unchanged when there is no alias (or resolution fails). Memoized per host.
 */
export function resolveHostAlias(host: string): string {
	if (!host) return host;
	const cached = cache.get(host);
	if (cached !== undefined) return cached;

	let resolved = host;
	const raw = sshRunner(host);
	if (raw) {
		const hostname = parseHostname(raw);
		if (hostname) resolved = hostname;
	}
	cache.set(host, resolved);
	return resolved;
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

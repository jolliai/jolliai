/**
 * GitRemoteUtils
 *
 * Resolves a workspace's canonical remote URL for the Jolli Memory push
 * contract. The returned string is the stable identity key the server uses
 * to look up `jolli_memory_repo_bindings`, so the same physical repo must
 * always yield the same string regardless of clone transport or owner/repo
 * casing the user happened to type in their `git clone` invocation.
 *
 * This is the CLI-owned source of truth. VS Code bundles it verbatim; IntelliJ
 * reaches it over the `git-remote` ide-bridge action (its Kotlin `GitRemoteUtils`
 * keeps a local copy only as a no-Node fallback), so the binding's primary key
 * is computed here on every surface that can reach the daemon.
 *
 * Normalization rules:
 *   - SSH form `git@host:owner/repo[.git]`              → `https://host/owner/repo`
 *   - SSH URL  `ssh://git@host[:port]/path[.git]`       → `https://host[:port]/path`
 *   - git URL  `git://host[:port]/path[.git]`           → `https://host[:port]/path`
 *   - HTTP(S):  strip trailing `.git`, lower-case scheme + host
 *   - No remote configured: fall back to `file://<workspaceRoot>` (forward slashes)
 *
 * SSH host aliases (`~/.ssh/config`):
 *   - For the ssh transports ONLY (`git@host:` scp form and `ssh://`), the host
 *     token is resolved through {@link resolveHostEndpoint} — a `Host` alias
 *     expands to its configured `HostName` (`git@github-jolli:o/r` →
 *     `https://github.com/o/r` when `github-jolli` aliases `github.com`), so an
 *     alias clone maps to the same binding key as a canonical clone. The alias's
 *     config `Port` (and an explicit `ssh://…:port`) is an ssh CONNECTION
 *     coordinate, NOT the repo's https identity, so for a self-hosted host it is
 *     dropped (see {@link sshIdentityPort}) — an ssh clone then folds onto the
 *     same key as the https clone. The `git@` user is threaded into `ssh -G` so
 *     `Match user …` config blocks resolve. Resolution is offline and fail-safe:
 *     an unknown alias or unreadable config leaves the literal host unchanged.
 *   - `git://` is the Git protocol, not ssh — it never reads `~/.ssh/config`, so
 *     its host is left untouched. HTTP(S) hosts are real DNS names, never
 *     aliases, and are likewise untouched.
 *   - A resolved `HostName` that is a KNOWN ssh connection endpoint
 *     (`ssh.github.com` and the gitlab/bitbucket ssh-over-443 targets) is mapped
 *     back to its forge identity host, dropping the alt port — even an EXPLICIT
 *     URL port (`ssh://git@ssh.github.com:443/o/r`), which belongs to the
 *     connection and not the identity — otherwise an ssh-over-443 clone of
 *     github.com would split from an https clone.
 *   - A resolved IPv6 `HostName` (which `ssh -G` reports without brackets) is
 *     bracketed via {@link formatHostForUrl} so the canonical URL stays valid.
 *
 * Port handling:
 *   - HTTP(S): always preserve the port (self-hosted forges on non-default
 *     HTTPS ports are common — there the port IS part of the identity).
 *   - ssh: the port is a CONNECTION coordinate, not the https identity, so for a
 *     self-hosted host it is dropped entirely (default AND non-default) via
 *     {@link sshIdentityPort} — an ssh clone via `ssh://host:2222/x` (or a
 *     `git@host:` alias whose config sets a Port) then folds onto the
 *     `https://host/x` clone's key (JOLLI-2135 follow-up). Accepted cost: two
 *     distinct repos on one host reachable only via different SSH ports (:2222
 *     vs :2223) collapse into one binding key — the dominant real case (one repo
 *     via ssh AND https) wins over that rare one.
 *   - git: the Git protocol is a distinct transport; preserve its port unless
 *     it's the scheme's default (9418).
 *
 * Path-case handling:
 *   - For known case-insensitive hosts (github.com, gitlab.com, bitbucket.org)
 *     the path is lower-cased so that e.g. `git@github.com:JolliAI/Jolli.git`
 *     and `https://github.com/jolliai/jolli` collapse to the same key — these
 *     hosts route owner/repo case-insensitively, so a per-clone casing drift
 *     would otherwise produce two different `repoUrl` keys for the one repo
 *     (one teammate binds, another teammate gets 412 or a duplicate binding).
 *   - For all other hosts (self-hosted Gitea / GitLab / etc.) path case is
 *     preserved, since their owner/repo segments may be case-sensitive.
 *
 * Trailing slashes and a single trailing `.git` are stripped.
 */

import { execGit } from "./GitOps.js";
// Shared with the vault identity / folder-reuse canonicalizers in
// cli/src/core/KBPathResolver.ts — one host list, so the server binding key
// and the local identity comparers can never drift on which hosts get their
// path case folded.
import { CASE_INSENSITIVE_PATH_HOSTS, sshIdentityPort } from "./KBPathResolver.js";
import { stripTrailingSlashes, toForwardSlash } from "./PathUtils.js";
// Resolves a `~/.ssh/config` `Host` alias to its real `HostName` + `Port`
// (offline `ssh -G`, memoized, fail-safe). Only the SSH transports consult it —
// the same machinery the local folder-identity canonicalizer already uses.
import { formatHostForUrl, resolveHostEndpoint } from "./SshAliasResolver.js";

/** Returns the canonical, server-facing repo URL for the given workspace root. */
export async function getCanonicalRepoUrl(workspaceRoot: string): Promise<string> {
	const result = await execGit(["config", "--get", "remote.origin.url"], workspaceRoot);
	const remote = result.exitCode === 0 ? result.stdout.trim() : "";
	if (remote.length === 0) {
		return toFileUrl(workspaceRoot);
	}
	return normalizeRemoteUrl(remote, workspaceRoot);
}

/** Normalizes a remote URL string into the canonical form. Exported for tests. */
export function normalizeRemoteUrl(remote: string, workspaceRootForFallback: string): string {
	const trimmed = remote.trim();
	if (trimmed.length === 0) {
		return toFileUrl(workspaceRootForFallback);
	}

	const sshScpMatch = /^([A-Za-z0-9_.+-]+@)([^:/\s]+):(.+)$/.exec(trimmed);
	if (sshScpMatch && !trimmed.includes("://")) {
		// Resolve an `~/.ssh/config` Host alias on the raw token (that is what ssh
		// keys its `Host` blocks on), THEN lower-case the real HostName so the
		// CASE_INSENSITIVE_PATH_HOSTS fold and the canonical form both see it. The
		// alias's config Port is an ssh CONNECTION coordinate, not the repo's https
		// identity, so it is dropped for a self-hosted host (sshIdentityPort) — the
		// alias scp clone then folds onto the same key as the https clone. The
		// `git@` user is threaded through so `Match user …` config blocks resolve
		// (group 1 carries the trailing `@`).
		const endpoint = resolveHostEndpoint(sshScpMatch[2], sshScpMatch[1].slice(0, -1) || undefined);
		const host = endpoint.host.toLowerCase();
		const pathPart = normalizePathCase(host, stripGitSuffixAndSlashes(sshScpMatch[3]));
		const port = canonicalPortSegment("ssh", sshIdentityPort(host, endpoint.port));
		return `https://${formatHostForUrl(host)}${port}/${pathPart}`;
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return toFileUrl(workspaceRootForFallback);
	}

	const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
	if (scheme === "ssh" || scheme === "git" || scheme === "http" || scheme === "https") {
		// Alias resolution is an ssh-transport concern only. `git://` is the Git
		// protocol — it never consults `~/.ssh/config` — and an http/https host is
		// a real DNS name, never an alias, so both are left untouched.
		const isSshTransport = scheme === "ssh";
		const endpoint = isSshTransport
			? resolveHostEndpoint(parsed.hostname, parsed.username || undefined)
			: { host: parsed.hostname, port: "", endpointRemapped: false };
		const host = endpoint.host.toLowerCase();
		const pathPart = normalizePathCase(host, stripGitSuffixAndSlashes(parsed.pathname.replace(/^\/+/, "")));
		// http/https: the port IS part of the identity (self-hosted git on a
		// non-default HTTPS port is real), so keep it. git://: a distinct transport,
		// keep its non-default port. ssh: the port is a CONNECTION coordinate, not
		// the https identity, so for a self-hosted host it is dropped (sshIdentityPort)
		// — an ssh clone then folds onto the `https://host/x` key. A host remapped
		// from a known ssh connection endpoint (`ssh.github.com:443`) already zeroed
		// its alt port upstream (endpointRemapped).
		const rawPort = endpoint.endpointRemapped ? "" : parsed.port !== "" ? parsed.port : endpoint.port;
		const effectivePort = scheme === "ssh" ? sshIdentityPort(host, rawPort) : rawPort;
		const portSegment = canonicalPortSegment(scheme, effectivePort);
		return `https://${formatHostForUrl(host)}${portSegment}/${pathPart}`;
	}

	if (scheme === "file") {
		return toFileUrl(parsed.pathname);
	}

	return toFileUrl(workspaceRootForFallback);
}

/** Mirrors the server's `deriveRepoName` spec — used as the chooser default only. */
export function deriveRepoNameFromUrl(repoUrl: string): string {
	const trimmed = repoUrl.trim();
	if (trimmed.length === 0) {
		return "";
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return trimmed.slice(0, 120);
	}

	const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
	const lastSegment = lastNonEmptyPathSegment(parsed.pathname);
	if (scheme === "http" || scheme === "https" || scheme === "ssh" || scheme === "git") {
		if (lastSegment.length > 0) {
			return stripGitSuffixOnly(lastSegment);
		}
		return parsed.hostname.toLowerCase();
	}
	if (scheme === "file") {
		return lastSegment.length > 0 ? lastSegment : trimmed.slice(0, 120);
	}
	return trimmed.slice(0, 120);
}

/**
 * Derives the "owner/repo" full name from a remote URL's path (e.g.
 * `https://github.com/jolliai/jolli` → `jolliai/jolli`), for the two-segment
 * "owner / repo" display on the share page. Returns `""` when the URL carries no
 * owner segment — a `file://` local URL, a bare host, or a single-segment path —
 * so callers can fall back to the bare repo name.
 */
export function deriveOwnerRepoFromUrl(repoUrl: string): string {
	const trimmed = repoUrl.trim();
	if (trimmed.length === 0) {
		return "";
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return "";
	}
	const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
	if (scheme !== "http" && scheme !== "https" && scheme !== "ssh" && scheme !== "git") {
		return "";
	}
	const path = stripGitSuffixAndSlashes(parsed.pathname.replace(/^\/+/, ""));
	// A "full name" needs at least owner/repo; a single segment is just the bare repo.
	return path.includes("/") ? path : "";
}

/**
 * Whether two raw remote strings denote the same repo, compared CANONICALLY (see
 * {@link normalizeRemoteUrl}). Guards the `file:///` sentinel: an empty or unparseable
 * remote canonicalizes to `file:///` via the empty fallback, and two DISTINCT unparseable
 * remotes must NOT be judged equal just because they both collapse to that sentinel. A
 * real `file://` remote normalizes to `file:///<path>` and still compares by path.
 */
export function sameCanonicalRemote(a: string, b: string): boolean {
	const na = normalizeRemoteUrl(a, "");
	const nb = normalizeRemoteUrl(b, "");
	if (na !== nb) {
		return false;
	}
	// Equal canonical form. If it's the empty-fallback `file:///` sentinel, the inputs were
	// empty or unparseable (e.g. a bare local path like `/srv/git/foo.git`): fall back to
	// raw-string equality so two DIFFERENT unparseable remotes don't collapse into a false
	// match, while an identical local-path remote still matches (preserving the pre-canonical
	// `===` behavior). Two empty strings are never a real repo, so require non-empty.
	if (na === "file:///") {
		const rawA = a.trim();
		return rawA.length > 0 && rawA === b.trim();
	}
	return true;
}

/**
 * Mirror of the backend's `sanitizeRepoNameInput` (BranchShareRouter →
 * `GitRemoteUrl.sanitizeRepoNameInput`): the share row stores `repoName` with the
 * path-unsafe chars — crucially `/` — stripped, so `owner/repo` becomes `ownerrepo`.
 * Only the `/`-class strip matters for URL-derived input (the backend's extra
 * control-char sweep and 120-char clip never fire here). Kept in lockstep with the
 * backend regex; drift only ever yields a safe false-negative (the share falls through
 * to the read-only sandbox), never a wrong-repo write.
 */
function sanitizeSharedRepoName(name: string): string {
	return name.replace(/[/\\:*?"<>|]/g, "");
}

/**
 * Whether a local repo (`candidate*`) is the repo a share was made from (`share*`). The
 * single identity rule shared by the foreign-bank lookup
 * (`JolliMemoryBridge.createStorageForRepo`) and the current-repo lookup
 * (`SharedBranchImporter`), so both paths benefit from every case below:
 *
 *  1. Both sides carry a remote → canonical remote compare ({@link sameCanonicalRemote}).
 *     The `/export` payload carries the backend's normalized `repoUrl` while the local
 *     bank keeps the raw git remote, so a strict `===` would miss (`…/x.git` vs `…/x`).
 *  2. Public-tier share (`shareRepoUrl == null`, the backend withholds the URL) but the
 *     candidate has a remote → reconstruct the backend's `ownerrepo` form from the
 *     candidate remote and compare to `shareRepoName` CASE-INSENSITIVELY. GitHub-family
 *     owner/repo is case-insensitive (and `normalizeRemoteUrl` already folds those host
 *     paths), so `Acme/Widgets` and `acme/widgets` are the same repo. This preserves the
 *     owner dimension — two repos sharing a basename under different owners don't collide.
 *  3. Last-ditch bare-name compare for the remote-less-on-both-sides case (the backend
 *     stored a basename, not `owner/repo`).
 */
export function sharedRepoIdentityMatches(
	shareRepoName: string,
	shareRepoUrl: string | null,
	candidateRepoName: string,
	candidateRemoteUrl: string | null,
): boolean {
	if (shareRepoUrl != null && candidateRemoteUrl != null) {
		return sameCanonicalRemote(shareRepoUrl, candidateRemoteUrl);
	}
	if (candidateRemoteUrl != null) {
		const ownerRepo = deriveOwnerRepoFromUrl(candidateRemoteUrl);
		if (ownerRepo.length > 0 && sanitizeSharedRepoName(ownerRepo).toLowerCase() === shareRepoName.toLowerCase()) {
			return true;
		}
	}
	return candidateRepoName === shareRepoName;
}

/**
 * Sanitizes a branch name into a path-safe slug for use inside `relativePath`.
 * Mirrors the server's `stripPathUnsafeChars` (replace anything outside
 * `[A-Za-z0-9._-]` and `/` with `_`, collapse runs, trim leading/trailing
 * separators).
 */
export function sanitizeBranchSlug(branch: string | undefined): string {
	const raw = (branch ?? "").trim();
	if (raw.length === 0) {
		return "_";
	}
	const replaced = raw.replace(/[^A-Za-z0-9._\-/]/g, "_");
	const collapsed = replaced.replace(/_+/g, "_").replace(/\/+/g, "/");
	const trimmed = collapsed.replace(/^[_/]+|[_/]+$/g, "");
	return trimmed.length === 0 ? "_" : trimmed;
}

/**
 * Returns the `relativePath` for any push: `<branchSlug>`. Summary, plan, and
 * note docs all share this flat per-branch path; the server distinguishes them
 * via the body's `docType` field and writes it to `sourceMetadata.docType`.
 */
export function buildBranchRelativePath(branch: string | undefined): string {
	return sanitizeBranchSlug(branch);
}

function toFileUrl(absolutePath: string): string {
	const forward = stripTrailingSlashes(toForwardSlash(absolutePath));
	if (forward.length === 0) {
		return "file:///";
	}
	if (forward.startsWith("/")) {
		return `file://${forward}`;
	}
	return `file:///${forward}`;
}

function stripGitSuffixAndSlashes(path: string): string {
	let p = stripTrailingSlashes(path);
	if (p.toLowerCase().endsWith(".git")) {
		p = p.slice(0, -4);
	}
	return stripTrailingSlashes(p);
}

function normalizePathCase(host: string, pathPart: string): string {
	return CASE_INSENSITIVE_PATH_HOSTS.has(host) ? pathPart.toLowerCase() : pathPart;
}

/**
 * Default wire ports for the schemes whose default we drop. A port equal to
 * the scheme's default carries no identity information, so `ssh://host:22/x`
 * collapses with `ssh://host/x` (and onto the `https://host/x` form). Non-
 * default ports are preserved so two repos on the same host but different
 * ports stay distinct. http/https are intentionally absent — self-hosted
 * forges sometimes serve on `:443`/`:80` explicitly and we keep the wire form
 * the user typed.
 */
const SSH_GIT_DEFAULT_PORTS: Readonly<Record<string, string>> = {
	ssh: "22",
	git: "9418",
};

function canonicalPortSegment(scheme: string, port: string): string {
	if (port.length === 0) {
		return "";
	}
	if (scheme === "ssh" || scheme === "git") {
		return port === SSH_GIT_DEFAULT_PORTS[scheme] ? "" : `:${port}`;
	}
	return `:${port}`;
}

function stripGitSuffixOnly(segment: string): string {
	return segment.toLowerCase().endsWith(".git") ? segment.slice(0, -4) : segment;
}

function lastNonEmptyPathSegment(pathname: string): string {
	const parts = pathname.split("/").filter((p) => p.length > 0);
	return parts.length > 0 ? parts[parts.length - 1] : "";
}

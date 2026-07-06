/**
 * GitRemoteUtils
 *
 * Resolves a workspace's canonical remote URL for the Jolli Memory push
 * contract. The returned string is the stable identity key the server uses
 * to look up `jolli_memory_repo_bindings`, so the same physical repo must
 * always yield the same string regardless of clone transport or owner/repo
 * casing the user happened to type in their `git clone` invocation.
 *
 * Normalization rules (any future IntelliJ / CLI port of this logic must stay
 * in lockstep — the canonical URL is the binding's primary key):
 *   - SSH form `git@host:owner/repo[.git]`              → `https://host/owner/repo`
 *   - SSH URL  `ssh://git@host[:port]/path[.git]`       → `https://host[:port]/path`
 *   - git URL  `git://host[:port]/path[.git]`           → `https://host[:port]/path`
 *   - HTTP(S):  strip trailing `.git`, lower-case scheme + host
 *   - No remote configured: fall back to `file://<workspaceRoot>` (forward slashes)
 *
 * Port handling:
 *   - HTTP(S): always preserve the port (self-hosted forges on non-default
 *     HTTPS ports are common).
 *   - ssh / git: preserve the port unless it's the scheme's default (22 / 9418).
 *     Dropping the default lets a clone via `ssh://host/x` collapse with the
 *     `https://host/x` clone of the same self-hosted repo. Preserving a
 *     non-default port keeps two distinct repos on the same host (e.g. one
 *     SSH gateway on :2222 and another on :2223) from colliding into one
 *     binding key.
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
import { CASE_INSENSITIVE_PATH_HOSTS } from "./KBPathResolver.js";
import { stripTrailingSlashes, toForwardSlash } from "./PathUtils.js";

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
		const host = sshScpMatch[2].toLowerCase();
		const pathPart = normalizePathCase(host, stripGitSuffixAndSlashes(sshScpMatch[3]));
		return `https://${host}/${pathPart}`;
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return toFileUrl(workspaceRootForFallback);
	}

	const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
	if (scheme === "ssh" || scheme === "git" || scheme === "http" || scheme === "https") {
		const host = parsed.hostname.toLowerCase();
		const pathPart = normalizePathCase(host, stripGitSuffixAndSlashes(parsed.pathname.replace(/^\/+/, "")));
		// Preserve port for http/https (self-hosted git on non-default ports is real).
		// For ssh/git, only drop the port when it's the scheme's default — that
		// keeps `ssh://host/x` collapsing with `https://host/x` for the standard
		// case, while two distinct repos on `ssh://host:2222/x` vs
		// `ssh://host:2223/x` stay distinct.
		const portSegment = canonicalPortSegment(scheme, parsed.port);
		return `https://${host}${portSegment}/${pathPart}`;
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

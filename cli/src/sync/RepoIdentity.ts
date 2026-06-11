/**
 * Source-repo identity + vault subdirectory naming.
 *
 * Two pieces of data are computed locally (never round-trip through backend):
 *
 *   - **`repoIdentity`**: stable string derived from the source repo's git
 *     remote URL (preferred) or its workspace folder basename (fallback).
 *     Hashed to produce the vault subdirectory prefix.
 *
 *   - **`slug`**: source-repo slug derived from `KBPathResolver.extractRepoName`,
 *     normalized to `[a-z0-9-]`. Used as the human-readable half of the vault
 *     subdirectory name so users browsing the vault on GitHub can tell what's
 *     what.
 *
 * Together they produce `<repoFolderName> = <sha256(repoIdentity)[:8]>-<slug>`,
 * matching the source plan §2.2 layout
 * (vscode-plugin-memory-bank-final-plan.md).
 */

import { createHash } from "node:crypto";
import {
	CASE_INSENSITIVE_PATH_HOSTS,
	extractRepoName,
	foldGitTransportToHttps,
	getRemoteUrl,
} from "../core/KBPathResolver.js";
import type { RepoIdentity } from "./SyncTypes.js";

/**
 * Computes a source-repo's identity from its working tree path.
 *
 * Fallback chain:
 *
 *   1. `git remote get-url origin` → normalized URL
 *   2. `extractRepoName(projectPath)` — only when no remote is configured.
 *      NOT `basename(projectPath)` (the original §2.2 wording): for a git
 *      worktree of a remote-less repo, basename is the worktree dir name
 *      while `extractRepoName` resolves to the MAIN repo's name via
 *      git-common-dir — which is also what `writeKBIdentity` persists as
 *      `repoName` in the folder config. Using basename made the live round
 *      and `repoIdentityFromConfig` derive two different identities for the
 *      same repo, so reconcile added a second row and the same folder got a
 *      persistent bogus collision warning. For a normal (non-worktree)
 *      checkout the two agree, so this is worktree-only behavior.
 */
export function computeRepoIdentity(projectPath: string): RepoIdentity {
	const remote = getRemoteUrl(projectPath);
	const name = extractRepoName(projectPath);
	const repoIdentity = remote ? normalizeGitUrl(remote) : name;
	return { repoIdentity, slug: slugify(name) };
}

/**
 * Derives the same `repoIdentity` that `computeRepoIdentity` would produce, but
 * from an already-persisted `<folder>/.jolli/config.json` identity instead of a
 * live git checkout. Used by the `repos.json` reconcile pass to map an on-disk
 * Memory Bank folder back to its repo identity without re-running git.
 *
 * Mirrors `computeRepoIdentity`'s fallback chain: a `remoteUrl` normalizes to
 * the canonical key; otherwise `repoName` stands in for the live
 * `extractRepoName(projectPath)` value — both come from the same helper
 * (`writeKBIdentity` persists `extractRepoName`'s result), so the two agree
 * even for git worktrees. Returns `null` when the config carries neither —
 * the caller skips such folders rather than inventing a key.
 */
export function repoIdentityFromConfig(config: { remoteUrl?: string; repoName?: string }): string | null {
	const remote = config.remoteUrl?.trim();
	if (remote) return normalizeGitUrl(remote);
	const name = config.repoName?.trim();
	if (name) return name;
	return null;
}

/**
 * Default vault subdirectory name for a source repo — just the slug
 * (`<localFolder>/<slug>/` style, matching the local Memory Bank layout).
 *
 * **Collision handling lives in `RepoMapping`**, not here: the engine reads
 * `<memoryBankRoot>/.jolli/repos.json` after clone to look up (or allocate) the
 * actual folder for the current `repoIdentity`. If the slug is already
 * claimed by a different `repoIdentity`, `RepoMapping.resolveOrAssignFolder`
 * appends a short hash suffix so the two repos coexist. The 90% case where
 * no collision exists yields `<repoFolderName> === <slug>`, i.e. vault dir
 * name matches the local Memory Bank dir name 1:1.
 *
 * `computeFallbackHashSuffix` is exported so `RepoMapping` can produce the
 * same `-<hash6>` suffix when it needs to disambiguate.
 */
export function computeRepoFolderName(identity: RepoIdentity): string {
	return identity.slug;
}

/**
 * Short deterministic suffix derived from the full `repoIdentity`. Used by
 * `RepoMapping` to disambiguate two repos that would otherwise share the
 * same slug (e.g. `github.com/foo/bar` vs `gitlab.com/foo/bar`).
 *
 * 6 hex chars (24 bits of sha256) keeps the directory name compact while
 * keeping the birthday-collision probability negligible at the scale of
 * "repos in one user's personal Memory Bank" (~10s, not 10^6).
 */
export function computeFallbackHashSuffix(repoIdentity: string): string {
	return createHash("sha256").update(repoIdentity).digest("hex").slice(0, 6);
}

/**
 * Encodes a git branch name into a folder name safe for both git and the
 * filesystem.
 *
 * The only character we need to substitute is `/` (used by git for nested
 * branch names like `feature/foo`, but not legal as a directory separator
 * inside a single path segment). `^` is illegal in git branch names per
 * `git check-ref-format`, so it can never round-trip back into a real
 * branch — collision-free by construction.
 */
export function encodeBranchFolderName(branch: string): string {
	return branch.replace(/\//g, "^");
}

/** Inverse of `encodeBranchFolderName`. */
export function decodeBranchFolderName(folder: string): string {
	return folder.replace(/\^/g, "/");
}

/** Scheme-prefixed remote (`https://…`, `ssh://…`, `git://…`, `file://…`). */
const URL_LIKE_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
/** SCP-style remote (`user@host:path`) — the only scheme-less URL form git accepts. */
const SCP_LIKE_RE = /^[^@/:]+@[^/:]+:.+$/;

/**
 * Re-normalizes an already-persisted `repoIdentity` string through the same
 * normalizer `computeRepoIdentity` uses. Rows written by clients that
 * predate SSH→https transport folding carry the SCP form
 * (`git@github.com:owner/repo`); folding them lets `RepoMapping` collapse
 * the style-duplicates those clients left behind.
 *
 * Normalization is GATED to identities that are recognizably remote URLs
 * (scheme-prefixed or SCP-style). Bare fallback identities — folder/repo
 * names from the no-remote path — never went through `normalizeGitUrl` at
 * compute time, so re-normalizing them here would desynchronize the stored
 * row from the live value: a remote-less repo named `foo.git` computes
 * identity `foo.git`, but the un-gated normalizer would strip the suffix
 * and rewrite the row to `foo` (re-adding a duplicate every round, and
 * collapsing it with a genuinely distinct repo named `foo`).
 */
export function canonicalizeRepoIdentity(identity: string): string {
	if (!URL_LIKE_RE.test(identity) && !SCP_LIKE_RE.test(identity)) return identity;
	return normalizeGitUrl(identity);
}

/**
 * Normalizes a git remote URL so variations that don't change which repo is
 * meant collapse to the same identity: trailing slash, `.git` suffix, https
 * user-info, host case, and — critically — the SSH transport forms
 * (`git@host:path`, `ssh://…`, `git://…`), which fold into the equivalent
 * https form. The same repo reached via SSH on one device and https on
 * another MUST produce one identity: distinct strings mean duplicate
 * `repos.json` rows that the identity-keyed dedupe in
 * `resolveOrAssignFolder` / `mergeRepoMapping` / `reconcileMappingAdditive`
 * cannot see through, and the duplicates then claim the same folder and
 * trip `findRepoMappingConflicts`' cross-repo collision warning.
 *
 * Path case is folded ONLY for hosts known to route owner/repo
 * case-insensitively (`CASE_INSENSITIVE_PATH_HOSTS` — github.com etc., the
 * same set and rule as the server-facing canonicalizer in
 * `vscode/src/util/GitRemoteUtils.ts`): `JolliAI/Jolli` and `jolliai/jolli`
 * are one repo there, and distinct identities re-open the duplicate-row
 * hazard on the casing axis. For every other host path case is preserved —
 * self-hosted forges may be case-sensitive, and a path-rename should
 * produce a new vault subdirectory, not silently reuse the old one.
 */
function normalizeGitUrl(url: string): string {
	// Transport folding is shared with `KBPathResolver.isSameRepo` so the
	// vault identity and the local folder-reuse predicate agree on "same
	// repo" across SSH/https clones.
	let trimmed = foldGitTransportToHttps(url.trim());
	// Strip user-info from https URLs: `https://user:pass@host/...` → `https://host/...`
	trimmed = trimmed.replace(/^(https?:\/\/)[^@/]+@/i, "$1");
	// Strip trailing `.git` and any trailing slashes.
	trimmed = trimmed.replace(/\.git\/*$/i, "");
	trimmed = trimmed.replace(/\/+$/, "");
	// Lowercase scheme + host (also covers the host of a just-folded SSH form).
	trimmed = trimmed.replace(
		/^([A-Za-z+]+:\/\/)([^/]+)/,
		(_, scheme: string, host: string) => `${scheme.toLowerCase()}${host.toLowerCase()}`,
	);
	// Lowercase the path too — but only for known case-insensitive hosts.
	const parts = trimmed.match(/^(https?:\/\/)([^/]+)(\/.*)$/);
	if (parts && CASE_INSENSITIVE_PATH_HOSTS.has((parts[2] ?? "").split(":")[0] ?? "")) {
		trimmed = `${parts[1]}${parts[2]}${(parts[3] ?? "").toLowerCase()}`;
	}
	return trimmed;
}

/**
 * Slug for `repoFolderName`. NFKD + lowercase + non-`[a-z0-9-]` → `-` +
 * collapse repeats + trim. Aligns with the existing convention in
 * `common/src/util/SlugUtils.ts` minus the random suffix (`repoFolderName`
 * uses the hash prefix for uniqueness instead).
 */
function slugify(name: string): string {
	const cleaned = name
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return cleaned || "repo";
}

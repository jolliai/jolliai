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
import { basename } from "node:path";
import { extractRepoName, getRemoteUrl } from "../core/KBPathResolver.js";
import type { RepoIdentity } from "./SyncTypes.js";

/**
 * Computes a source-repo's identity from its working tree path.
 *
 * Fallback chain per source plan §2.2:
 *
 *   1. `git remote get-url origin` → normalized URL
 *   2. `basename(projectPath)` — only when no remote is configured
 */
export function computeRepoIdentity(projectPath: string): RepoIdentity {
	const remote = getRemoteUrl(projectPath);
	const repoIdentity = remote ? normalizeGitUrl(remote) : basename(projectPath);
	const name = extractRepoName(projectPath);
	return { repoIdentity, slug: slugify(name) };
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

/**
 * Normalizes a git remote URL so trivial variations (trailing slash, `.git`
 * suffix, https user-info, host case) collapse to the same identity. Path
 * case is preserved because case-sensitive filesystems do exist on Linux
 * and a path-rename should produce a new vault subdirectory, not silently
 * reuse the old one.
 */
function normalizeGitUrl(url: string): string {
	let trimmed = url.trim();
	// Strip user-info from https URLs: `https://user:pass@host/...` → `https://host/...`
	trimmed = trimmed.replace(/^(https?:\/\/)[^@/]+@/i, "$1");
	// Strip trailing `.git` and any trailing slashes.
	trimmed = trimmed.replace(/\.git\/*$/i, "");
	trimmed = trimmed.replace(/\/+$/, "");
	// Lowercase scheme + host. SCP-style `git@host:owner/repo` URLs aren't
	// rewritten — the `@` is a valid separator, not user-info, and rewriting
	// would lose info.
	trimmed = trimmed.replace(
		/^([A-Za-z+]+:\/\/)([^/]+)/,
		(_, scheme: string, host: string) => `${scheme.toLowerCase()}${host.toLowerCase()}`,
	);
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

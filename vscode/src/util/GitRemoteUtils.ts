/**
 * GitRemoteUtils (VS Code) — a thin re-export of the canonical CLI module.
 *
 * The remote-URL canonicalization is the SERVER BINDING'S PRIMARY KEY: the CLI
 * push path and the VS Code push path must derive byte-identical `repoUrl` keys
 * for the same repo, or one client binds and another gets a 412 / duplicate
 * binding (the exact "split Memory Banks" bug this logic was written to fix).
 * Keeping two copies invited drift, so the implementation lives once in
 * `cli/src/core/GitRemoteUtils.ts` and is re-exported here. The extension
 * bundles `cli/src/**` at esbuild time, so this import resolves at build time —
 * the same pattern CLAUDE.md documents for `JolliApiUtils` and the other
 * cli↔vscode shared helpers.
 */

export {
	buildBranchRelativePath,
	deriveOwnerRepoFromUrl,
	deriveRepoNameFromUrl,
	getCanonicalRepoUrl,
	normalizeRemoteUrl,
	sameCanonicalRemote,
	sanitizeBranchSlug,
	sharedRepoIdentityMatches,
} from "../../../cli/src/core/GitRemoteUtils.js";

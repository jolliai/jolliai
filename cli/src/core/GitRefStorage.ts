/**
 * GitRefStorage — a read-only {@link StorageProvider} pinned to one immutable
 * commit.
 *
 * Why pinning is the whole point: an import that reads by BRANCH NAME is a
 * race. `listFiles` resolves the name once and any `readFile` after it resolves
 * the name again — so a writer advancing the branch mid-import makes the run
 * see a mixture of two versions, and worse, makes a reconciliation pass prune
 * rows for paths that merely do not exist yet at the older tip it listed. Every
 * read here goes through `<sha>:<path>`, so the view cannot move no matter what
 * happens to the ref that produced the sha.
 *
 * This is also why the importer must not fall back to `OrphanBranchStorage`:
 * that backend hard-codes the movable `ORPHAN_BRANCH`, which can never prove
 * that one import saw one version. And it must not use `createStorage`, which
 * could return a folder/dual-write provider or claim a Memory Bank directory as
 * a side effect. Resolve a tip once with {@link resolveCommittish}, construct
 * this with it, and everything downstream is coherent by construction.
 *
 * Deliberately not writable and not creatable: `writeFiles` and `ensure` throw.
 * A pinned snapshot has nothing to initialize, and `exists` only verifies the
 * commit resolves — it must never call anything in the `ensureOrphanBranch`
 * family, whose job is to create refs.
 */

import type { FileWrite } from "../Types.js";
import { batchReadFilesFromBranch, execGit, listFilesInBranch, readFileFromBranch } from "./GitOps.js";
import type { StorageKind, StorageProvider } from "./StorageProvider.js";

/**
 * Resolves a committish (branch name, sha, tag) to its full commit hash, or
 * null when it does not resolve. The `^{commit}` peel makes a tag answer with
 * the commit it points at, and makes a blob/tree sha fail rather than pass.
 */
export async function resolveCommittish(committish: string, cwd?: string): Promise<string | null> {
	const result = await execGit(["rev-parse", "--verify", `${committish}^{commit}`], cwd);
	if (result.exitCode !== 0) return null;
	const sha = result.stdout.trim();
	return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

export class GitRefStorage implements StorageProvider {
	readonly kind: StorageKind = "git-ref";

	/**
	 * @param commit - The pinned commit sha (from {@link resolveCommittish}).
	 *   Accepting any committish here would re-open the race this class exists
	 *   to close, so callers resolve first and pass the result.
	 */
	constructor(
		private readonly commit: string,
		private readonly cwd?: string,
	) {}

	async readFile(path: string): Promise<string | null> {
		return readFileFromBranch(this.commit, path, this.cwd);
	}

	async batchReadFiles(paths: ReadonlyArray<string>): Promise<Map<string, string | null>> {
		return batchReadFilesFromBranch(this.commit, paths, this.cwd);
	}

	async listFiles(prefix: string): Promise<string[]> {
		return [...(await listFilesInBranch(this.commit, prefix, this.cwd))];
	}

	async writeFiles(_files: FileWrite[], _message: string): Promise<void> {
		// Loud, not silent: a caller that reaches for a write picked the wrong
		// backend, and a no-op here would let it believe the write landed.
		throw new Error("GitRefStorage is read-only: it serves one pinned commit and cannot accept writes");
	}

	async exists(): Promise<boolean> {
		return (await resolveCommittish(this.commit, this.cwd)) !== null;
	}

	async ensure(): Promise<void> {
		throw new Error("GitRefStorage cannot be initialized: a pinned commit either resolves or it does not");
	}
}

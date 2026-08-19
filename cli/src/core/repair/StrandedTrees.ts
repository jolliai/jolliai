import type { CommitSummary } from "../../Types.js";
import type { StorageProvider } from "../StorageProvider.js";
import { getIndex, getSummary } from "../SummaryStore.js";
import { listReachableCommits } from "./GitReachability.js";

export interface StrandedTree {
	readonly oldHash: string;
	readonly root: CommitSummary;
	readonly conversationCount: number;
	readonly skillCount: number;
}

export interface StrandedDeps {
	readonly reachableCommits?: (cwd: string) => Promise<ReadonlySet<string>>;
	readonly listRootHashes?: (cwd: string, storage?: StorageProvider) => Promise<ReadonlyArray<string>>;
	readonly loadRoot?: (hash: string, cwd: string, storage?: StorageProvider) => Promise<CommitSummary | null>;
	readonly storage?: StorageProvider;
}

function walk(node: CommitSummary, visit: (n: CommitSummary) => void): void {
	visit(node);
	for (const child of node.children ?? []) walk(child, visit);
}

function countTree(root: CommitSummary): { conversations: number; skills: number } {
	let conversations = 0;
	let skills = 0;
	walk(root, (n) => {
		conversations += n.transcripts?.length ?? 0;
		skills += n.skills?.length ?? 0;
	});
	return { conversations, skills };
}

/**
 * Root hashes straight off the index, without loading a single payload.
 *
 * The reason this is not `listSummaries`: `doctor` runs this check on every
 * invocation, and `listSummaries` loads the FULL summary of every root it
 * returns (one `getSummary` each) purely so this function can read a
 * `commitHash` off it. Measured on this repository — 221 roots, ~12 ms per
 * summary load — that is ~2.6 s of reads to answer a question the index
 * already holds, before the per-root git probes even start. Reachability is a
 * predicate on the hash alone, so the payload is only needed for the roots
 * that come back UNREACHABLE, which is normally none.
 *
 * `parentCommitHash == null` covers v3 roots (null) and v1 legacy entries
 * (undefined), matching `SummaryStore`'s own `isRootEntry`.
 */
async function defaultListRootHashes(cwd: string, storage?: StorageProvider): Promise<ReadonlyArray<string>> {
	const index = await getIndex(cwd, storage);
	return (index?.entries ?? []).filter((e) => e.parentCommitHash == null).map((e) => e.commitHash);
}

export async function findStrandedRoots(cwd: string, deps: StrandedDeps = {}): Promise<ReadonlyArray<StrandedTree>> {
	const reachableCommits = deps.reachableCommits ?? listReachableCommits;
	const listRootHashes = deps.listRootHashes ?? defaultListRootHashes;
	const loadRoot =
		deps.loadRoot ?? ((hash: string, dir: string, storage?: StorageProvider) => getSummary(hash, dir, storage));
	const hashes = await listRootHashes(cwd, deps.storage);
	// No roots → nothing to check, and no reason to spawn git. This runs on every
	// `jolli doctor`, so the empty case must stay free.
	if (hashes.length === 0) return [];

	// One `git rev-list --all` answers reachability for every root, replacing the
	// two git spawns PER root the per-hash predicate cost — ~442 serial spawns on
	// a 221-root repo, on a check that only warns.
	const reachable = await reachableCommits(cwd);

	const stranded: StrandedTree[] = [];
	for (const hash of hashes) {
		if (reachable.has(hash)) continue;
		// Only now is the payload worth reading. A null here is an index row
		// whose file is gone — nothing to reattach, and not this command's
		// repair (`doctor` has its own integrity checks), so it is skipped
		// rather than reported as a stranded tree with an empty root.
		const root = await loadRoot(hash, cwd, deps.storage);
		if (!root) continue;
		const counts = countTree(root);
		stranded.push({
			oldHash: hash,
			root,
			conversationCount: counts.conversations,
			skillCount: counts.skills,
		});
	}
	return stranded;
}

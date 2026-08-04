/**
 * TranscriptOwnership
 *
 * Answers one question for the whole summary tree: **which single node's token /
 * cost figures cover the sessions in `transcripts/<id>.json`?**
 *
 * Every consumer that corrects a committed memory's conversation usage needs
 * that answer, and none of them can read it off a field. `summary.transcripts`
 * means two different things depending on where it sits:
 *   - on a leaf — the ids whose sessions this node's token fields cover;
 *   - on a consolidated root — the tree-wide authoritative INDEX. Amend
 *     (`QueueWorker`'s `amendTranscripts` = inherited ∪ delta), rebase-pick
 *     (`migrateOneToOne`) and squash (`mergeManyToOne`, union over children) all
 *     re-list every descendant id at the root so `getTranscriptIds` finds every
 *     file — while the root's token fields cover its DELTA only (amend/pick), or
 *     nothing at all (squash).
 *
 * Attribution is therefore per NODE, resolved structurally, and each id resolves
 * to at most ONE owner: an amend/squash root and its children each carry their own
 * token fields, and the tree aggregation in `SummaryTree.ts` walks both, so an id
 * counted at two nodes is counted twice on every surface.
 *
 * Two independent kinds of evidence exist, and they are consulted in this order:
 *
 *  1. **A claim** — the deepest node that lists the id. Post-order resolution, so
 *     a node only becomes a claimant once its whole subtree has had the chance to
 *     claim it; that is what stops a consolidated root's index from outranking the
 *     leaf whose figures actually cover the id.
 *  2. **The filename** — `transcripts/<id>.json` is written under the commit hash
 *     of the commit whose sessions it holds, so a node with `commitHash === id` is
 *     the node those sessions were counted at. This is what rescues a **v5-migrated
 *     legacy tree**: `SchemaV5Migration.upgradeOneSummary` puts every descendant
 *     commit hash on the ROOT's `transcripts` and leaves the children without the
 *     field at all, so the root is the sole claimant of ids a child counted.
 *
 * The hash is only allowed to move ownership DOWN, inside the claimant's own
 * subtree (and it is consulted alone when nothing claims the id at all, which is
 * every pre-v5 tree). A hash match outside the claimant's subtree is ignored on
 * purpose: a stale id that happens to equal an unrelated node's commit hash would
 * otherwise hand that node someone else's sessions, and the claim is the stronger
 * evidence there.
 *
 * Anything that cannot be pinned to exactly one node — no claimant and no unique
 * hash match, or sibling claimants (neither is the other's descendant, so there is
 * no deepest one) — is reported as unresolved rather than guessed at. Callers
 * surface that and leave the figures EXACTLY as they are: replacing a known-stale
 * number with an invented one is strictly worse, and a silently wrong figure reads
 * as settled truth.
 */

import type { CommitSummary } from "../Types.js";

export interface TranscriptOwnershipResult {
	/** Transcript id → the single node whose usage figures cover it. */
	readonly ownerById: ReadonlyMap<string, CommitSummary>;
	/**
	 * Ids of interest that could not be pinned to exactly one node. Callers must
	 * treat these as "unknown" — see the module header on why guessing is worse.
	 */
	readonly unresolved: ReadonlyArray<string>;
}

/**
 * Post-order walk recording a claimant for an id the moment a node lists it and
 * no descendant did. Returns what this subtree claimed, so the parent can tell
 * whether its own listing is a claim or just an index entry.
 *
 * `interest` restricts everything, so walking a consolidated root's tree-wide
 * index costs nothing when only one id is being corrected.
 */
function collectClaimants(
	node: CommitSummary,
	interest: ReadonlySet<string>,
	claimants: Map<string, CommitSummary[]>,
): Set<string> {
	const claimedBelow = new Set<string>();
	for (const child of node.children ?? []) {
		for (const id of collectClaimants(child, interest, claimants)) claimedBelow.add(id);
	}
	const claimed = new Set(claimedBelow);
	for (const id of node.transcripts ?? []) {
		if (!interest.has(id)) continue;
		claimed.add(id);
		if (claimedBelow.has(id)) continue;
		const existing = claimants.get(id);
		if (existing) existing.push(node);
		else claimants.set(id, [node]);
	}
	return claimed;
}

/** Collects, per id of interest, every node in the tree whose commitHash matches. */
function collectHashNodes(node: CommitSummary, interest: ReadonlySet<string>, out: Map<string, CommitSummary[]>): void {
	if (interest.has(node.commitHash)) {
		const existing = out.get(node.commitHash);
		if (existing) existing.push(node);
		else out.set(node.commitHash, [node]);
	}
	for (const child of node.children ?? []) collectHashNodes(child, interest, out);
}

/**
 * Resolves the owning node of each id in `ids`. See the module header for the
 * evidence order (claim, then filename-within-subtree) and for why unresolvable
 * ids are reported instead of assigned.
 */
export function resolveTranscriptOwnership(root: CommitSummary, ids: ReadonlySet<string>): TranscriptOwnershipResult {
	const ownerById = new Map<string, CommitSummary>();
	const unresolved: string[] = [];
	if (ids.size === 0) return { ownerById, unresolved };

	const claimants = new Map<string, CommitSummary[]>();
	collectClaimants(root, ids, claimants);

	// Hash matches are re-collected per claimant subtree below; the tree-wide map
	// is what the no-claimant fallback needs (every pre-v5 tree lands there).
	const treeHashNodes = new Map<string, CommitSummary[]>();
	collectHashNodes(root, ids, treeHashNodes);

	for (const id of ids) {
		const claiming = claimants.get(id) ?? [];
		if (claiming.length > 1) {
			// Ambiguous claim — see the module header.
			unresolved.push(id);
			continue;
		}
		if (claiming.length === 0) {
			const hashMatches = treeHashNodes.get(id) ?? [];
			if (hashMatches.length === 1) ownerById.set(id, hashMatches[0]);
			else unresolved.push(id);
			continue;
		}
		const claimant = claiming[0];
		// The hash may only move ownership DOWN, into the claimant's own subtree.
		const withinClaimant = new Map<string, CommitSummary[]>();
		collectHashNodes(claimant, ids, withinClaimant);
		const candidates = withinClaimant.get(id) ?? [];
		ownerById.set(id, candidates.length === 1 ? candidates[0] : claimant);
	}

	return { ownerById, unresolved };
}

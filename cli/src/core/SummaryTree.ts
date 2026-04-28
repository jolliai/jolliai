/**
 * SummaryTree — Utility functions for traversing the CommitSummary tree structure.
 *
 * All functions are pure (no side effects) and operate recursively on the
 * CommitSummary tree. Children are stored newest-first (commitDate descending),
 * so traversal helpers reverse them when chronological order is needed.
 */
import type { CommitSummary, DiffStats, TopicSummary } from "../Types.js";

/**
 * Discriminator: returns true when the summary node was written by the unified
 * Hoist pipeline (schema v4 onward). v4 roots have authoritative `topics` and
 * `recap` on the root itself; v3 (legacy) roots may have data scattered across
 * children (legacy squash) or split between root and children (legacy amend),
 * and require recursive collection via collectAllTopics() to recover them.
 *
 * Used by resolveEffectiveTopics, expandSourcesForConsolidation, and
 * collectDisplayTopics to choose between root-authoritative and recursive paths.
 */
export function isUnifiedHoistFormat(s: Pick<CommitSummary, "version">): boolean {
	return s.version >= 4;
}

/** A topic decorated with the date of the node it came from */
export interface TopicWithDate extends TopicSummary {
	readonly commitDate?: string;
	/**
	 * Summary (re)generation time of the source node (set on commit / amend /
	 * squash / rebase). Preferred over commitDate by display code via
	 * getDisplayDate.
	 */
	readonly generatedAt?: string;
	/** Original index in the tree traversal order (from collectAllTopics), used by edit/delete operations */
	readonly treeIndex?: number;
}

function reverseCopy<T>(items: ReadonlyArray<T> | undefined): T[] {
	return [...(items ?? [])].reverse();
}

/**
 * Recursively collects all topics from the tree in chronological order
 * (oldest first). Each topic is annotated with the commitDate of its source node.
 */
export function collectAllTopics(node: CommitSummary): ReadonlyArray<TopicWithDate> {
	// Children are stored newest-first; reverse to process oldest-first
	const childTopics = reverseCopy(node.children).flatMap(collectAllTopics);
	const own: ReadonlyArray<TopicWithDate> = (node.topics ?? []).map((t) => ({
		...t,
		commitDate: node.commitDate,
		generatedAt: node.generatedAt,
	}));
	return [...childTopics, ...own];
}

/**
 * Recursively aggregates diff statistics across the entire tree.
 * Pure function — does not mutate the original node.
 *
 * NOTE: Display code must NOT call this directly. Use resolveDiffStats() instead,
 * which prefers the persisted `diffStats` field and only falls back here for v3
 * legacy data. This function is retained as the fallback implementation and for
 * internal use (e.g. SessionStartHook's branch-level aggregation).
 */
export function aggregateStats(node: CommitSummary): DiffStats {
	const s = node.stats;
	let filesChanged = s?.filesChanged ?? 0;
	let insertions = s?.insertions ?? 0;
	let deletions = s?.deletions ?? 0;
	for (const child of node.children ?? []) {
		const cs = aggregateStats(child);
		filesChanged += cs.filesChanged;
		insertions += cs.insertions;
		deletions += cs.deletions;
	}
	return { filesChanged, insertions, deletions };
}

/**
 * Single source of truth for display code's diff stats.
 *
 * Decision tree:
 *   1. node.diffStats present                → return it (new data, authoritative).
 *   2. node is a LEAF (no children)          → return node.stats ?? zeros.
 *      Leaves always have a well-defined `stats` = this commit's own diff.
 *   3. node is a CONTAINER (has children)    → return aggregateStats(node).
 *      Rationale: on legacy container roots, `stats` may be:
 *        - absent (squash / rebase-pick roots)  → must aggregate
 *        - a delta diff (amend root, Scenario 1) → mixing delta with
 *          children.stats (the pre-amend full diff) is exactly what today's
 *          aggregateStats() does. Preserving aggregate keeps the display
 *          pixel-identical to today for legacy amend data.
 *
 * Display code MUST use this helper. Never call aggregateStats() directly, and
 * never read node.stats as a display field.
 */
export function resolveDiffStats(node: CommitSummary): DiffStats {
	if (node.diffStats) return node.diffStats;
	const hasChildren = (node.children?.length ?? 0) > 0;
	if (!hasChildren) {
		return node.stats ?? { filesChanged: 0, insertions: 0, deletions: 0 };
	}
	return aggregateStats(node);
}

/** Recursively sums conversationTurns across the entire tree. */
export function aggregateTurns(node: CommitSummary): number {
	const own = node.conversationTurns ?? 0;
	const childTurns = (node.children ?? []).reduce((acc, c) => acc + aggregateTurns(c), 0);
	return own + childTurns;
}

/** Recursively counts total topics across the entire tree. */
export function countTopics(node: CommitSummary): number {
	const own = node.topics?.length ?? 0;
	const childCount = (node.children ?? []).reduce((acc, c) => acc + countTopics(c), 0);
	return own + childCount;
}

/**
 * Returns the LEAF descendant nodes of root (NOT root itself, NOT intermediate
 * containers). Used for the "Source Commits" drill-down section and for
 * computeDurationDays date aggregation.
 *
 * After the unified Hoist rollout, children are stripped of own topics/recap,
 * so the old "has own topics" discriminator stops working. The new rule is
 * purely structural: leaf descendants are the original commits whose work is
 * embedded in this root. Intermediate squash/amend containers are skipped
 * because they're internal structure, not user-meaningful sources.
 *
 * Examples:
 * - Normal commit (no children) → []
 * - Squash of leaves [A1, A2, A3] → [A1, A2, A3]
 * - Rebase Pick (A → A', A leaf) → [A]
 * - Amend (A → A', A leaf) → [A] (root excluded)
 * - Amend over Squash (A' wraps S wraps [A1,A2,A3]) → [A1,A2,A3] (S skipped)
 * - Rebase Pick over Squash → [A1,A2,A3] (S skipped)
 *
 * Children are stored newest-first; the leaf-only walk preserves that order.
 */
export function collectSourceNodes(node: CommitSummary): ReadonlyArray<CommitSummary> {
	const out: CommitSummary[] = [];
	const walk = (n: CommitSummary) => {
		if (!n.children?.length) {
			out.push(n);
		} else {
			for (const child of n.children) walk(child);
		}
	};
	for (const child of node.children ?? []) walk(child);
	return out;
}

/**
 * Returns the topics to display for a summary. Schema v4 (unified Hoist)
 * summaries have authoritative root.topics (which may legitimately be []
 * for recap-only commits); recursion is the legacy fallback for v3 data.
 *
 * Discriminator is `version` (via isUnifiedHoistFormat), not topics.length.
 * This avoids two failure modes:
 *   - legacy amend root has root.topics (delta) AND children topics (pre-amend);
 *     topics.length > 0 would mistreat it as v4 and lose the children data.
 *   - v4 recap-only commit has topics === []; topics.length > 0 would mistreat
 *     it as legacy and recurse into stripped children, losing the recap.
 */
export function collectDisplayTopics(node: CommitSummary): ReadonlyArray<TopicWithDate> {
	if (isUnifiedHoistFormat(node)) {
		return (node.topics ?? []).map((t) => ({
			...t,
			commitDate: node.commitDate,
			generatedAt: node.generatedAt,
		}));
	}
	return collectAllTopics(node);
}

/**
 * Recursively collects every node's commitHash in tree order (root first,
 * then children). Used by display code to look up `transcripts/{hash}.json`
 * files for all commits whose work is embedded in this summary tree.
 *
 * Companion to readTranscript(hash) in SummaryStore — together they implement
 * the "transcripts are by-hash, not Hoisted" model: physical files stay at
 * `transcripts/{originalHash}.json`, display walks the tree to discover hashes.
 */
export function collectAllTranscriptHashes(node: CommitSummary): ReadonlyArray<string> {
	const hashes: string[] = [node.commitHash];
	for (const child of node.children ?? []) {
		hashes.push(...collectAllTranscriptHashes(child));
	}
	return hashes;
}

/**
 * Updates a topic at a global index within the tree, returning a new tree.
 * The global index follows the same chronological order as `collectAllTopics`.
 * Returns null if the index is out of range.
 */
export function updateTopicInTree(
	node: CommitSummary,
	globalIndex: number,
	updates: Partial<TopicSummary>,
): { result: CommitSummary; consumed: number } | null {
	let offset = 0;

	// Process children oldest-first (same order as collectAllTopics)
	const reversedChildren = reverseCopy(node.children);
	const newReversedChildren: CommitSummary[] = [];
	let childModified = false;

	for (const child of reversedChildren) {
		if (childModified) {
			newReversedChildren.push(child);
			continue;
		}
		const childResult = updateTopicInTree(child, globalIndex - offset, updates);
		/* v8 ignore start -- recursive traversal always returns a consumed count for valid CommitSummary nodes */
		if (!childResult) return null;
		/* v8 ignore stop */
		offset += childResult.consumed;
		if (childResult.result !== child) {
			childModified = true;
			newReversedChildren.push(childResult.result);
		} else {
			newReversedChildren.push(child);
		}
	}

	// Check own topics
	const ownTopics = node.topics ?? [];
	const localIndex = globalIndex - offset;
	if (!childModified && localIndex >= 0 && localIndex < ownTopics.length) {
		const newTopics = ownTopics.map((t, i) => (i === localIndex ? { ...t, ...updates } : t));
		return {
			result: { ...node, topics: newTopics, children: reverseCopy(newReversedChildren) },
			consumed: offset + ownTopics.length,
		};
	}

	const newChildren = childModified ? reverseCopy(newReversedChildren) : node.children;
	return {
		result: childModified ? { ...node, children: newChildren } : node,
		consumed: offset + ownTopics.length,
	};
}

/**
 * Deletes a topic at a global index within the tree, returning a new tree.
 * The global index follows the same chronological order as `collectAllTopics`.
 * Returns null if the index is out of range.
 */
export function deleteTopicInTree(
	node: CommitSummary,
	globalIndex: number,
): { result: CommitSummary; consumed: number } | null {
	let offset = 0;

	const reversedChildren = reverseCopy(node.children);
	const newReversedChildren: CommitSummary[] = [];
	let childModified = false;

	for (const child of reversedChildren) {
		if (childModified) {
			newReversedChildren.push(child);
			continue;
		}
		const childResult = deleteTopicInTree(child, globalIndex - offset);
		/* v8 ignore start -- recursive traversal always returns a consumed count for valid CommitSummary nodes */
		if (!childResult) return null;
		/* v8 ignore stop */
		offset += childResult.consumed;
		if (childResult.result !== child) {
			childModified = true;
			newReversedChildren.push(childResult.result);
		} else {
			newReversedChildren.push(child);
		}
	}

	const ownTopics = node.topics ?? [];
	const localIndex = globalIndex - offset;
	if (!childModified && localIndex >= 0 && localIndex < ownTopics.length) {
		const newTopics = ownTopics.filter((_, i) => i !== localIndex);
		return {
			result: { ...node, topics: newTopics, children: reverseCopy(newReversedChildren) },
			consumed: offset + ownTopics.length,
		};
	}

	const newChildren = childModified ? reverseCopy(newReversedChildren) : node.children;
	return {
		result: childModified ? { ...node, children: newChildren } : node,
		consumed: offset + ownTopics.length,
	};
}

/** Returns true if this node has no children (leaf node). */
export function isLeafNode(node: CommitSummary): boolean {
	return !node.children?.length;
}

/**
 * Computes the work duration in days across the entire tree.
 * Collects activity dates (generatedAt, falling back to commitDate) from nodes
 * with data, returns the day span.
 */
export function computeDurationDays(node: CommitSummary): number {
	const sources = collectSourceNodes(node);
	if (sources.length <= 1) return 1;
	const dateStrings = new Set(
		sources.map((s) => new Date(s.generatedAt || s.commitDate).toISOString().substring(0, 10)),
	);
	return dateStrings.size;
}

/**
 * Formats a human-readable duration label.
 * Returns "1 day" for single-source nodes, "N days (from — to)" for multi-source.
 */
export function formatDurationLabel(node: CommitSummary): string {
	const days = computeDurationDays(node);
	const dayStr = days === 1 ? "1 day" : `${days} days`;
	const sources = collectSourceNodes(node);
	if (sources.length <= 1) return dayStr;
	const timestamps = sources.map((s) => new Date(s.generatedAt || s.commitDate).getTime());
	const earliest = new Date(Math.min(...timestamps));
	const latest = new Date(Math.max(...timestamps));
	const fmt = (d: Date): string => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
	return `${dayStr} (${fmt(earliest)} — ${fmt(latest)})`;
}

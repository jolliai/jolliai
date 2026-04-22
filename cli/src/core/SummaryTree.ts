/**
 * SummaryTree — Utility functions for traversing the CommitSummary tree structure.
 *
 * All functions are pure (no side effects) and operate recursively on the
 * CommitSummary tree. Children are stored newest-first (commitDate descending),
 * so traversal helpers reverse them when chronological order is needed.
 */
import type { CommitSummary, DiffStats, TopicSummary } from "../Types.js";

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
 * Collects all nodes that have their own data (topics.length > 0), in reverse
 * chronological order (newest first). Used for the "Source Commits" display section.
 *
 * Note: This includes amend nodes that have both own topics AND children — they are
 * not skipped just because they have children.
 */
export function collectSourceNodes(node: CommitSummary): ReadonlyArray<CommitSummary> {
	// Children are stored newest-first; keep that order for newest-first output
	const childNodes = (node.children ?? []).flatMap(collectSourceNodes);
	const hasOwnData = (node.topics?.length ?? 0) > 0;
	return hasOwnData ? [node, ...childNodes] : childNodes;
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

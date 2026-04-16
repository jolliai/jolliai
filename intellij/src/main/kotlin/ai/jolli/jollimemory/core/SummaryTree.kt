package ai.jolli.jollimemory.core

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * SummaryTree — Kotlin port of SummaryTree.ts
 *
 * Pure utility functions for traversing the CommitSummary tree structure.
 */
object SummaryTree {

    /** A topic annotated with the commitDate of the node it came from */
    data class TopicWithDate(
        val topic: TopicSummary,
        val commitDate: String? = null,
        val treeIndex: Int? = null,
    )

    /** Recursively collects all topics in chronological order (oldest first). */
    fun collectAllTopics(node: CommitSummary): List<TopicWithDate> {
        val childTopics = (node.children ?: emptyList()).reversed().flatMap { collectAllTopics(it) }
        val own = (node.topics ?: emptyList()).map { TopicWithDate(it, node.commitDate) }
        return childTopics + own
    }

    /** Recursively aggregates diff statistics across the entire tree. */
    fun aggregateStats(node: CommitSummary): DiffStats {
        var filesChanged = node.stats?.filesChanged ?: 0
        var insertions = node.stats?.insertions ?: 0
        var deletions = node.stats?.deletions ?: 0
        for (child in node.children ?: emptyList()) {
            val cs = aggregateStats(child)
            filesChanged += cs.filesChanged
            insertions += cs.insertions
            deletions += cs.deletions
        }
        return DiffStats(filesChanged, insertions, deletions)
    }

    /** Recursively sums conversationTurns across the entire tree. */
    fun aggregateTurns(node: CommitSummary): Int {
        val own = node.conversationTurns ?: 0
        val childTurns = (node.children ?: emptyList()).sumOf { aggregateTurns(it) }
        return own + childTurns
    }

    /** Recursively counts total topics across the entire tree. */
    fun countTopics(node: CommitSummary): Int {
        val own = node.topics?.size ?: 0
        val childCount = (node.children ?: emptyList()).sumOf { countTopics(it) }
        return own + childCount
    }

    /** Collects all nodes that have their own topics, newest first. */
    fun collectSourceNodes(node: CommitSummary): List<CommitSummary> {
        val childNodes = (node.children ?: emptyList()).flatMap { collectSourceNodes(it) }
        val hasOwnData = (node.topics?.size ?: 0) > 0
        return if (hasOwnData) listOf(node) + childNodes else childNodes
    }

    /** Result from updateTopicInTree / deleteTopicInTree */
    data class UpdateResult(val result: CommitSummary, val consumed: Int)

    /**
     * Updates a topic at a global index within the tree, returning a new tree.
     * The global index follows the same chronological order as collectAllTopics.
     * Returns null if the index is out of range.
     */
    fun updateTopicInTree(
        node: CommitSummary,
        globalIndex: Int,
        updates: TopicUpdates,
    ): UpdateResult? {
        var offset = 0

        // Process children oldest-first (same order as collectAllTopics)
        val reversedChildren = (node.children ?: emptyList()).reversed()
        val newReversedChildren = mutableListOf<CommitSummary>()
        var childModified = false

        for (child in reversedChildren) {
            if (childModified) {
                newReversedChildren.add(child)
                continue
            }
            val childResult = updateTopicInTree(child, globalIndex - offset, updates) ?: return null
            offset += childResult.consumed
            if (childResult.result !== child) {
                childModified = true
                newReversedChildren.add(childResult.result)
            } else {
                newReversedChildren.add(child)
            }
        }

        // Check own topics
        val ownTopics = node.topics ?: emptyList()
        val localIndex = globalIndex - offset
        if (!childModified && localIndex >= 0 && localIndex < ownTopics.size) {
            val newTopics = ownTopics.mapIndexed { i, t ->
                if (i == localIndex) t.copy(
                    title = updates.title ?: t.title,
                    trigger = updates.trigger ?: t.trigger,
                    response = updates.response ?: t.response,
                    decisions = updates.decisions ?: t.decisions,
                    todo = updates.todo ?: t.todo,
                    filesAffected = updates.filesAffected ?: t.filesAffected,
                ) else t
            }
            return UpdateResult(
                result = node.copy(topics = newTopics, children = newReversedChildren.reversed()),
                consumed = offset + ownTopics.size,
            )
        }

        val newChildren = if (childModified) newReversedChildren.reversed() else node.children
        return UpdateResult(
            result = if (childModified) node.copy(children = newChildren) else node,
            consumed = offset + ownTopics.size,
        )
    }

    /**
     * Deletes a topic at a global index within the tree, returning a new tree.
     * The global index follows the same chronological order as collectAllTopics.
     * Returns null if the index is out of range.
     */
    fun deleteTopicInTree(
        node: CommitSummary,
        globalIndex: Int,
    ): UpdateResult? {
        var offset = 0

        val reversedChildren = (node.children ?: emptyList()).reversed()
        val newReversedChildren = mutableListOf<CommitSummary>()
        var childModified = false

        for (child in reversedChildren) {
            if (childModified) {
                newReversedChildren.add(child)
                continue
            }
            val childResult = deleteTopicInTree(child, globalIndex - offset) ?: return null
            offset += childResult.consumed
            if (childResult.result !== child) {
                childModified = true
                newReversedChildren.add(childResult.result)
            } else {
                newReversedChildren.add(child)
            }
        }

        val ownTopics = node.topics ?: emptyList()
        val localIndex = globalIndex - offset
        if (!childModified && localIndex >= 0 && localIndex < ownTopics.size) {
            val newTopics = ownTopics.filterIndexed { i, _ -> i != localIndex }
            return UpdateResult(
                result = node.copy(topics = newTopics, children = newReversedChildren.reversed()),
                consumed = offset + ownTopics.size,
            )
        }

        val newChildren = if (childModified) newReversedChildren.reversed() else node.children
        return UpdateResult(
            result = if (childModified) node.copy(children = newChildren) else node,
            consumed = offset + ownTopics.size,
        )
    }

    /** Returns true if this node has no children (leaf node). */
    fun isLeafNode(node: CommitSummary): Boolean {
        return node.children.isNullOrEmpty()
    }

    /** Computes the work duration in days across the entire tree. */
    fun computeDurationDays(node: CommitSummary): Int {
        val sources = collectSourceNodes(node)
        if (sources.size <= 1) return 1
        val dates = sources.map { it.commitDate.take(10) }.toSet()
        return dates.size
    }

    /** Formats a human-readable duration label. */
    fun formatDurationLabel(node: CommitSummary): String {
        val days = computeDurationDays(node)
        val dayStr = if (days == 1) "1 day" else "$days days"
        val sources = collectSourceNodes(node)
        if (sources.size <= 1) return dayStr

        val timestamps = sources.map { Instant.parse(it.commitDate).toEpochMilli() }
        val earliest = Instant.ofEpochMilli(timestamps.min())
        val latest = Instant.ofEpochMilli(timestamps.max())
        val fmt = DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.US).withZone(ZoneId.systemDefault())
        return "$dayStr (${fmt.format(earliest)} — ${fmt.format(latest)})"
    }
}

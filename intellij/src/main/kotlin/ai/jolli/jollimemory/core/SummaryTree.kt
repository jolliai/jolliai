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

    /** Summary schema version that marks root topics as authoritative (unified hoist). */
    const val UNIFIED_HOIST_VERSION = 4

    /** Current schema version written by this plugin. */
    const val CURRENT_SCHEMA_VERSION = 5

    /** A topic annotated with the commitDate of the node it came from */
    data class TopicWithDate(
        val topic: TopicSummary,
        val commitDate: String? = null,
        val treeIndex: Int? = null,
    )

    /** Returns true when the summary uses the unified hoist format (v4+),
     *  meaning root topics are authoritative and children are archival only. */
    fun isUnifiedHoistFormat(summary: CommitSummary): Boolean {
        return (summary.version ?: 3) >= UNIFIED_HOIST_VERSION
    }

    /**
     * Collects topics for display. For v4+ summaries, returns only root topics
     * (authoritative after LLM consolidation). For v3, recurses into children.
     */
    fun collectDisplayTopics(node: CommitSummary): List<TopicWithDate> {
        if (isUnifiedHoistFormat(node)) {
            return (node.topics ?: emptyList()).map { TopicWithDate(it, node.commitDate) }
        }
        return collectAllTopics(node)
    }

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

    /**
     * A node's OWN token breakdown, applying the same fallback the Commits-list brief uses
     * ([JolliMemoryService.getBranchCommits]): prefer the canonical [CommitSummary.conversationTokenBreakdown],
     * else map the legacy `tokenUsage` (cached = cache_creation; cache_read dropped to match TS).
     * Returns zeros when neither is present. Keeping this in one place stops the detail view and
     * the list from disagreeing on the same underlying counts.
     */
    private fun ownBreakdown(node: CommitSummary): ConversationTokenBreakdown {
        node.conversationTokenBreakdown?.let { return ConversationTokenBreakdown(it.input, it.output, it.cached) }
        node.tokenUsage?.let {
            return ConversationTokenBreakdown(it.inputTokens, it.outputTokens, it.cacheWriteTokens)
        }
        return ConversationTokenBreakdown(0, 0, 0)
    }

    /**
     * Recursively sums conversationTokens across the entire tree. A consolidated
     * (squash/amend/rebase) memory carries its tokens on the folded children, so
     * the detail view must aggregate the whole tree, not read the root's scalar.
     * Falls back to the node's breakdown total when the scalar is absent, so a
     * summary that recorded only a breakdown still reports a nonzero total.
     */
    fun aggregateConversationTokens(node: CommitSummary): Long {
        val bd = ownBreakdown(node)
        val own = node.conversationTokens?.toLong() ?: (bd.input + bd.output + bd.cached)
        return own + (node.children ?: emptyList()).sumOf { aggregateConversationTokens(it) }
    }

    /** Recursively sums the per-segment conversation-token breakdown across the tree. */
    fun aggregateConversationTokenBreakdown(node: CommitSummary): ConversationTokenBreakdown {
        val own = ownBreakdown(node)
        var input = own.input
        var output = own.output
        var cached = own.cached
        for (child in node.children ?: emptyList()) {
            val c = aggregateConversationTokenBreakdown(child)
            input += c.input
            output += c.output
            cached += c.cached
        }
        return ConversationTokenBreakdown(input, output, cached)
    }

    /**
     * Recursively sums the estimated USD cost across the tree. Per node, prefers the stored
     * [CommitSummary.estimatedCostUsd]; when absent, re-derives it from [CommitSummary.conversationModels]
     * at current [ModelPricing] rates — the SAME fallback the Commits-list brief applies, so opening a
     * memory's detail view never loses a cost the list showed. 0.0 only when a node carries neither a
     * priced estimate nor priced models (a lower bound on legacy/unpriced trees).
     */
    fun aggregateEstimatedCost(node: CommitSummary): Double {
        val own = node.estimatedCostUsd
            ?: node.conversationModels?.let { ModelPricing.estimateCostUsd(it) }
            ?: 0.0
        return own + (node.children ?: emptyList()).sumOf { aggregateEstimatedCost(it) }
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

package ai.jolli.jollimemory.core

import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class SummaryTreeTest {

    private fun makeTopic(title: String = "Test Topic") = TopicSummary(
        title = title,
        trigger = "Test trigger",
        response = "Test response",
        decisions = "Test decisions",
    )

    private fun makeLeaf(
        hash: String = "abc123",
        topics: List<TopicSummary> = listOf(makeTopic()),
        stats: DiffStats = DiffStats(3, 100, 50),
        turns: Int = 5,
        date: String = "2026-01-15T10:00:00Z",
    ) = CommitSummary(
        commitHash = hash,
        commitMessage = "Test commit",
        commitAuthor = "Alice",
        commitDate = date,
        branch = "main",
        generatedAt = "2026-01-15T10:00:00Z",
        topics = topics,
        stats = stats,
        conversationTurns = turns,
    )

    private fun makeSquash(children: List<CommitSummary>) = CommitSummary(
        commitHash = "squash123",
        commitMessage = "Squash commit",
        commitAuthor = "Bob",
        commitDate = "2026-01-20T10:00:00Z",
        branch = "main",
        generatedAt = "2026-01-20T10:00:00Z",
        commitType = CommitType.squash,
        children = children,
    )

    // ── collectAllTopics ────────────────────────────────────────────────

    @Nested
    inner class CollectAllTopics {
        @Test
        fun `collects topics from leaf node`() {
            val node = makeLeaf(topics = listOf(makeTopic("A"), makeTopic("B")))
            val result = SummaryTree.collectAllTopics(node)
            result shouldHaveSize 2
            result[0].topic.title shouldBe "A"
            result[1].topic.title shouldBe "B"
        }

        @Test
        fun `collects topics from children first, then own`() {
            val child1 = makeLeaf(hash = "c1", topics = listOf(makeTopic("Child1")), date = "2026-01-10T10:00:00Z")
            val child2 = makeLeaf(hash = "c2", topics = listOf(makeTopic("Child2")), date = "2026-01-12T10:00:00Z")
            val parent = makeSquash(listOf(child1, child2))

            val result = SummaryTree.collectAllTopics(parent)
            // Children are reversed (oldest first), so child2 first (it's second in list, reversed = first)
            result shouldHaveSize 2
            result[0].topic.title shouldBe "Child2"
            result[1].topic.title shouldBe "Child1"
        }

        @Test
        fun `returns empty for node without topics`() {
            val node = makeLeaf(topics = emptyList())
            SummaryTree.collectAllTopics(node).shouldHaveSize(0)
        }
    }

    // ── aggregateStats ──────────────────────────────────────────────────

    @Nested
    inner class AggregateStats {
        @Test
        fun `returns own stats for leaf node`() {
            val node = makeLeaf(stats = DiffStats(5, 200, 100))
            val result = SummaryTree.aggregateStats(node)
            result.filesChanged shouldBe 5
            result.insertions shouldBe 200
            result.deletions shouldBe 100
        }

        @Test
        fun `sums stats across children`() {
            val child1 = makeLeaf(hash = "c1", stats = DiffStats(2, 50, 10))
            val child2 = makeLeaf(hash = "c2", stats = DiffStats(3, 75, 25))
            val parent = makeSquash(listOf(child1, child2))

            val result = SummaryTree.aggregateStats(parent)
            result.filesChanged shouldBe 5
            result.insertions shouldBe 125
            result.deletions shouldBe 35
        }

        @Test
        fun `handles null stats`() {
            val node = CommitSummary(
                commitHash = "x", commitMessage = "x", commitAuthor = "x",
                commitDate = "2026-01-01T00:00:00Z", branch = "main",
                generatedAt = "2026-01-01T00:00:00Z",
            )
            val result = SummaryTree.aggregateStats(node)
            result.filesChanged shouldBe 0
            result.insertions shouldBe 0
            result.deletions shouldBe 0
        }
    }

    // ── aggregateTurns ──────────────────────────────────────────────────

    @Nested
    inner class AggregateTurns {
        @Test
        fun `returns own turns for leaf`() {
            SummaryTree.aggregateTurns(makeLeaf(turns = 7)) shouldBe 7
        }

        @Test
        fun `sums turns across tree`() {
            val child1 = makeLeaf(hash = "c1", turns = 3)
            val child2 = makeLeaf(hash = "c2", turns = 4)
            val parent = makeSquash(listOf(child1, child2))
            SummaryTree.aggregateTurns(parent) shouldBe 7
        }
    }

    // ── aggregateConversationTokens / Breakdown / EstimatedCost ─────────

    @Nested
    inner class AggregateConversationUsage {
        @Test
        fun `sums tokens, breakdown, and cost across the tree`() {
            val c1 = makeLeaf(hash = "c1").copy(
                conversationTokens = 100,
                conversationTokenBreakdown = ConversationTokenBreakdown(60, 30, 10),
                estimatedCostUsd = 0.25,
            )
            val c2 = makeLeaf(hash = "c2").copy(
                conversationTokens = 200,
                conversationTokenBreakdown = ConversationTokenBreakdown(120, 60, 20),
                estimatedCostUsd = 0.50,
            )
            val root = makeSquash(listOf(c1, c2))
            SummaryTree.aggregateConversationTokens(root) shouldBe 300L
            SummaryTree.aggregateConversationTokenBreakdown(root) shouldBe ConversationTokenBreakdown(180, 90, 30)
            SummaryTree.aggregateEstimatedCost(root) shouldBe 0.75
        }

        @Test
        fun `returns zeros when no node carries usage`() {
            val root = makeSquash(listOf(makeLeaf(hash = "c1")))
            SummaryTree.aggregateConversationTokens(root) shouldBe 0L
            SummaryTree.aggregateEstimatedCost(root) shouldBe 0.0
            SummaryTree.aggregateConversationTokenBreakdown(root) shouldBe ConversationTokenBreakdown(0, 0, 0)
        }

        @Test
        fun `aggregateEstimatedCost is a pure stored sum with no fallback`() {
            // The Sonnet/model fallback lives in the display layer (matching VS Code), so the
            // aggregate itself stays pure: a node with models/breakdown but no stored cost is 0.
            val node = makeLeaf().copy(
                conversationTokens = 3_000_000,
                conversationTokenBreakdown = ConversationTokenBreakdown(1_000_000, 1_000_000, 1_000_000),
                conversationModels = listOf(
                    ModelTokenUsage("claude-opus-4-8", ModelPricing.providerOf("claude-opus-4-8"), output = 1_000_000),
                ),
                estimatedCostUsd = null,
            )
            SummaryTree.aggregateEstimatedCost(node) shouldBe 0.0
        }

        @Test
        fun `falls back to legacy tokenUsage for breakdown and total`() {
            val node = makeLeaf().copy(
                conversationTokens = null,
                conversationTokenBreakdown = null,
                tokenUsage = TokenUsage(inputTokens = 100, outputTokens = 50, cacheWriteTokens = 10),
            )
            SummaryTree.aggregateConversationTokenBreakdown(node) shouldBe ConversationTokenBreakdown(100, 50, 10)
            SummaryTree.aggregateConversationTokens(node) shouldBe 160L
        }
    }

    // ── countTopics ─────────────────────────────────────────────────────

    @Nested
    inner class CountTopics {
        @Test
        fun `counts own topics`() {
            SummaryTree.countTopics(makeLeaf(topics = listOf(makeTopic(), makeTopic()))) shouldBe 2
        }

        @Test
        fun `counts across tree`() {
            val child1 = makeLeaf(hash = "c1", topics = listOf(makeTopic()))
            val child2 = makeLeaf(hash = "c2", topics = listOf(makeTopic(), makeTopic()))
            val parent = makeSquash(listOf(child1, child2))
            SummaryTree.countTopics(parent) shouldBe 3
        }
    }

    // ── collectSourceNodes ──────────────────────────────────────────────

    @Nested
    inner class CollectSourceNodes {
        @Test
        fun `returns leaf with topics`() {
            val node = makeLeaf()
            val result = SummaryTree.collectSourceNodes(node)
            result shouldHaveSize 1
        }

        @Test
        fun `skips nodes without topics`() {
            val node = makeLeaf(topics = emptyList())
            SummaryTree.collectSourceNodes(node).shouldHaveSize(0)
        }

        @Test
        fun `collects from children`() {
            val child1 = makeLeaf(hash = "c1")
            val child2 = makeLeaf(hash = "c2")
            val parent = makeSquash(listOf(child1, child2))
            SummaryTree.collectSourceNodes(parent) shouldHaveSize 2
        }
    }

    // ── isLeafNode ──────────────────────────────────────────────────────

    @Test
    fun `isLeafNode returns true for node without children`() {
        SummaryTree.isLeafNode(makeLeaf()) shouldBe true
    }

    @Test
    fun `isLeafNode returns false for node with children`() {
        val parent = makeSquash(listOf(makeLeaf()))
        SummaryTree.isLeafNode(parent) shouldBe false
    }

    // ── computeDurationDays ─────────────────────────────────────────────

    @Test
    fun `computeDurationDays returns 1 for single source`() {
        SummaryTree.computeDurationDays(makeLeaf()) shouldBe 1
    }

    @Test
    fun `computeDurationDays counts distinct dates`() {
        val child1 = makeLeaf(hash = "c1", date = "2026-01-10T10:00:00Z")
        val child2 = makeLeaf(hash = "c2", date = "2026-01-12T10:00:00Z")
        val child3 = makeLeaf(hash = "c3", date = "2026-01-12T15:00:00Z") // same day as child2
        val parent = makeSquash(listOf(child1, child2, child3))
        SummaryTree.computeDurationDays(parent) shouldBe 2
    }

    // ── formatDurationLabel ─────────────────────────────────────────────

    @Test
    fun `formatDurationLabel shows day count and date range`() {
        val child1 = makeLeaf(hash = "c1", date = "2026-01-10T10:00:00Z")
        val child2 = makeLeaf(hash = "c2", date = "2026-01-12T10:00:00Z")
        val parent = makeSquash(listOf(child1, child2))
        val label = SummaryTree.formatDurationLabel(parent)
        label shouldContain "2 days"
        label shouldContain "Jan"
    }

    @Test
    fun `formatDurationLabel shows 1 day for single source`() {
        SummaryTree.formatDurationLabel(makeLeaf()) shouldBe "1 day"
    }

    // ── updateTopicInTree ───────────────────────────────────────────────

    @Nested
    inner class UpdateTopicInTree {
        @Test
        fun `updates topic at index 0 in leaf`() {
            val node = makeLeaf(topics = listOf(makeTopic("Original")))
            val updates = TopicUpdates(title = "Updated")
            val result = SummaryTree.updateTopicInTree(node, 0, updates)

            result shouldNotBe null
            result!!.result.topics!![0].title shouldBe "Updated"
        }

        @Test
        fun `preserves unchanged fields`() {
            val original = TopicSummary("Title", "Trigger", "Response", "Decisions", todo = "Todo")
            val node = makeLeaf(topics = listOf(original))
            val updates = TopicUpdates(title = "New Title")
            val result = SummaryTree.updateTopicInTree(node, 0, updates)!!

            val updated = result.result.topics!![0]
            updated.title shouldBe "New Title"
            updated.trigger shouldBe "Trigger"
            updated.response shouldBe "Response"
            updated.decisions shouldBe "Decisions"
            updated.todo shouldBe "Todo"
        }

        @Test
        fun `updates topic in child node`() {
            val child = makeLeaf(hash = "c1", topics = listOf(makeTopic("Child Topic")))
            val parent = makeSquash(listOf(child))
            val updates = TopicUpdates(title = "Updated Child")
            val result = SummaryTree.updateTopicInTree(parent, 0, updates)!!

            result.result.children!![0].topics!![0].title shouldBe "Updated Child"
        }
    }

    // ── deleteTopicInTree ───────────────────────────────────────────────

    @Nested
    inner class DeleteTopicInTree {
        @Test
        fun `deletes topic at index 0`() {
            val node = makeLeaf(topics = listOf(makeTopic("A"), makeTopic("B")))
            val result = SummaryTree.deleteTopicInTree(node, 0)!!
            result.result.topics!! shouldHaveSize 1
            result.result.topics!![0].title shouldBe "B"
        }

        @Test
        fun `deletes topic from child node`() {
            val child = makeLeaf(hash = "c1", topics = listOf(makeTopic("Only")))
            val parent = makeSquash(listOf(child))
            val result = SummaryTree.deleteTopicInTree(parent, 0)!!
            result.result.children!![0].topics!! shouldHaveSize 0
        }
    }
}

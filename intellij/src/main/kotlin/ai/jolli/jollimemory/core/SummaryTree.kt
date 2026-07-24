package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations
import com.google.gson.Gson
import com.google.gson.JsonObject

/** Thin DTO adapter for the CLI-owned summary-tree traversal and edit rules. */
object SummaryTree {
	private val gson = Gson()
	private const val ACTION = "summary-tree"

	data class TopicWithDate(
		val topic: TopicSummary,
		val commitDate: String? = null,
		val treeIndex: Int? = null,
	)

	data class UpdateResult(val result: CommitSummary, val consumed: Int)

	private data class Analysis(
		val unified: Boolean,
		val allTopics: List<TopicWithDate>,
		val displayTopics: List<TopicWithDate>,
		val stats: DiffStats,
		val turns: Int,
		val tokens: Long,
		val breakdown: ConversationTokenBreakdown,
		val estimatedCost: Double,
		val topicCount: Int,
		val sourceNodes: List<CommitSummary>,
		val leaf: Boolean,
		val durationDays: Int,
		val durationLabel: String,
		/** v5 transcript IDs (UUIDs) — falls back to commit hashes on v3/v4 data, resolved CLI-side. */
		val transcriptIds: List<String>? = null,
	)

	/**
	 * Small access-ordered LRU so a Commits panel that fans out N `analyze()`
	 * calls (topic counts, token meter, cost, duration label…) over the same
	 * scrolling window collapses to one CLI round per unique summary instead
	 * of one per call. Sized at 32: enough to cover a full sidebar page plus
	 * a couple of open detail views, small enough that the retained summary
	 * JSON strings never dominate the plugin's heap footprint. The map is
	 * mutated under `synchronized(cache)`; the CLI round itself runs outside
	 * the lock so a slow bridge call can't block unrelated analyses.
	 */
	private const val CACHE_SIZE = 32
	private val cache: LinkedHashMap<String, Analysis> =
		object : LinkedHashMap<String, Analysis>(16, 0.75f, true) {
			override fun removeEldestEntry(eldest: Map.Entry<String, Analysis>): Boolean = size > CACHE_SIZE
		}

	fun isUnifiedHoistFormat(summary: CommitSummary): Boolean = analyze(summary).unified
	fun collectDisplayTopics(node: CommitSummary): List<TopicWithDate> = analyze(node).displayTopics
	fun collectAllTopics(node: CommitSummary): List<TopicWithDate> = analyze(node).allTopics
	fun aggregateStats(node: CommitSummary): DiffStats = analyze(node).stats
	fun aggregateTurns(node: CommitSummary): Int = analyze(node).turns
	fun aggregateConversationTokens(node: CommitSummary): Long = analyze(node).tokens
	fun aggregateConversationTokenBreakdown(node: CommitSummary): ConversationTokenBreakdown = analyze(node).breakdown
	fun aggregateEstimatedCost(node: CommitSummary): Double = analyze(node).estimatedCost
	fun countTopics(node: CommitSummary): Int = analyze(node).topicCount
	fun collectSourceNodes(node: CommitSummary): List<CommitSummary> = analyze(node).sourceNodes
	fun isLeafNode(node: CommitSummary): Boolean = analyze(node).leaf
	fun computeDurationDays(node: CommitSummary): Int = analyze(node).durationDays
	fun formatDurationLabel(node: CommitSummary): String = analyze(node).durationLabel

	/**
	 * Transcript IDs this summary references — CLI-owned `getTranscriptIds`:
	 * the v5 `summary.transcripts` field verbatim, falling back to walking
	 * children (legacy commit-hash filenames) on v3/v4 data.
	 */
	fun getTranscriptIds(node: CommitSummary): List<String> = analyze(node).transcriptIds ?: emptyList()

	fun updateTopicInTree(node: CommitSummary, globalIndex: Int, updates: TopicUpdates): UpdateResult? =
		mutation("update-topic", node, globalIndex) { add("updates", gson.toJsonTree(updates)) }

	fun deleteTopicInTree(node: CommitSummary, globalIndex: Int): UpdateResult? =
		mutation("delete-topic", node, globalIndex)

	private fun analyze(node: CommitSummary): Analysis {
		val summaryJson = gson.toJson(node)
		synchronized(cache) { cache[summaryJson] }?.let { return it }
		val result = requestAnalysis(node)
		synchronized(cache) { cache[summaryJson] = result }
		return result
	}

	private fun requestAnalysis(node: CommitSummary): Analysis {
		val request = baseRequest("analyze", node)
		val result = CliIntegrations.runIdeBridge(CliIntegrations.resolveDefaultCwd(), ACTION, gson.toJson(request))
		return gson.fromJson(result, Analysis::class.java)
	}

	private fun mutation(
		operation: String,
		node: CommitSummary,
		globalIndex: Int,
		configure: JsonObject.() -> Unit = {},
	): UpdateResult? {
		val request = baseRequest(operation, node).apply {
			addProperty("globalIndex", globalIndex)
			configure()
		}
		val result = CliIntegrations.runIdeBridge(CliIntegrations.resolveDefaultCwd(), ACTION, gson.toJson(request))
		return if (result.isJsonNull) null else gson.fromJson(result, UpdateResult::class.java)
	}

	private fun baseRequest(operation: String, node: CommitSummary): JsonObject = JsonObject().apply {
		addProperty("operation", operation)
		add("summary", gson.toJsonTree(node))
	}
}

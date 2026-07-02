package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.toolwindow.views.SummaryMarkdownBuilder

/**
 * BranchShareSnapshot — assembles snapshot data from branch summaries
 * for the POST /api/share/branch payload.
 */
object BranchShareSnapshot {

	private val log = JmLogger.create("BranchShareSnapshot")

	data class BranchShareSnapshotResult(
		val branch: String,
		val headCommitHash: String,
		val commitHashes: List<String>,
		val decisionCount: Int,
		val titles: List<String>,
		val content: String,
	)

	/**
	 * Assembles a share snapshot from all summaries on the current branch.
	 *
	 * @param service JolliMemoryService for listing/loading summaries
	 * @param branch Current branch name
	 * @return Snapshot result, or null if no summaries found
	 */
	fun assemble(service: JolliMemoryService, branch: String): BranchShareSnapshotResult? {
		val (entries, _) = service.listMemoryEntries(Int.MAX_VALUE, scope = "branch")
		if (entries.isEmpty()) {
			log.info("assemble: no entries found for branch '%s'", branch)
			return null
		}

		val summaries = entries.mapNotNull { entry ->
			service.getSummary(entry.commitHash)
		}

		if (summaries.isEmpty()) {
			log.info("assemble: no summaries could be loaded for branch '%s'", branch)
			return null
		}

		// Sort chronologically (oldest first) for content rendering
		val sorted = summaries.sortedBy { it.commitDate }

		// Build content: render each summary as markdown, join with separators
		val contentParts = sorted.map { SummaryMarkdownBuilder.buildMarkdown(it) }
		val content = contentParts.joinToString("\n\n---\n\n")

		// Count decisions (topics) across all summaries
		val decisionCount = sorted.sumOf { it.topics?.size ?: 0 }

		// Collect up to 5 distinct topic titles
		val titles = sorted.flatMap { summary ->
			summary.topics?.map { it.title } ?: emptyList()
		}.distinct().take(5)

		// Head commit hash = most recent entry
		val headCommitHash = entries.first().commitHash

		// All commit hashes
		val commitHashes = entries.map { it.commitHash }

		log.info(
			"assemble: branch='%s', summaries=%d, decisions=%d, headHash=%s",
			branch, sorted.size, decisionCount, headCommitHash.take(8),
		)

		return BranchShareSnapshotResult(
			branch = branch,
			headCommitHash = headCommitHash,
			commitHashes = commitHashes,
			decisionCount = decisionCount,
			titles = titles,
			content = content,
		)
	}
}

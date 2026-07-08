package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.bridge.CommitSummaryBrief
import java.util.Locale

/**
 * Pure (UI-free, git-free) helpers backing the redesigned Committed Memories
 * panel — token formatting and per-branch aggregation. Kept separate from
 * [CommitsPanel] so the arithmetic is unit-testable without spinning up Swing
 * or a git repo.
 *
 * Conversation-row parsing lives in `SummaryReader.parseConversations` (it sits
 * next to the orphan-branch read it depends on); token math lives here because
 * it's a property of the already-loaded commit list.
 */

/**
 * Aggregate token usage across a branch's committed memories.
 *
 * Only memory-bearing commits whose summarizer reported usage contribute. When
 * `partial` is true, at least one memory-bearing commit reported no usage (the
 * source — e.g. Cursor — doesn't expose token counts, or the summary predates
 * usage capture), so [total] understates reality. The token meter surfaces this
 * in its help popover so the number isn't read as exact.
 */
data class BranchTokenTotals(
	val input: Long,
	val output: Long,
	val cacheRead: Long,
	val cacheWrite: Long,
	val partial: Boolean,
	/**
	 * Sum of the per-commit estimated USD cost across the branch (null when no
	 * contributing memory carried a priced estimate). A lower bound for the same
	 * reasons [partial] is: unpriced models and pre-capture memories contribute
	 * nothing. Priced per model at write time via [ai.jolli.jollimemory.core.ModelPricing].
	 */
	val estimatedCostUsd: Double? = null,
) {
	/** Cache read + write, shown as one "cached" segment. */
	val cached: Long get() = cacheRead + cacheWrite

	val total: Long get() = input + output + cached

	/** True when there is any reported usage worth rendering a meter for. */
	val hasData: Boolean get() = total > 0
}

object CommitMemoryFormat {

	/**
	 * Compact token count for display: `842`, `61k`, `1.4M`. Mirrors the
	 * reference mockup (`1.2M`, `96k`). One decimal is kept below 100 of a unit
	 * (so `1.4M`, `9.2M`) and dropped above it (so `308k`, `120M`); a trailing
	 * `.0` is always trimmed.
	 */
	fun formatTokens(n: Long): String {
		if (n < 1_000) return n.toString()
		if (n < 1_000_000) return scale(n / 1_000.0) + "k"
		return scale(n / 1_000_000.0) + "M"
	}

	private fun scale(value: Double): String {
		val formatted = if (value >= 100) "%.0f".format(value) else "%.1f".format(value)
		return formatted.removeSuffix(".0")
	}

	/**
	 * Compact cost label: `≈$0.42`, or `<$0.01` for a tiny non-zero estimate.
	 * Mirrors the VS Code branch bar. Callers only invoke this when a cost exists.
	 */
	fun formatCost(usd: Double): String =
		if (usd >= 0.01) "≈$" + "%.2f".format(usd) else "<$0.01"

	/**
	 * Exact token count with thousands separators (`3000000` → `"3,000,000"`), for the
	 * pushed/shared-memory Markdown "Task usage" line — which shows precise figures rather
	 * than the compact `formatTokens` form the space-constrained UI bar uses. Mirrors the
	 * CLI/VS Code `formatTokensExact`.
	 */
	fun formatTokensExact(n: Long): String = String.format(Locale.US, "%,d", n)

	/**
	 * Exact USD cost for the shared-memory "Task usage" line: two decimals at/above a cent
	 * (`"$21.75"`), four for a sub-cent value (`"$0.0034"`), and the floor `"<$0.0001"` for a
	 * real amount too small to survive four decimals — so a real cost never shows as all-zeros.
	 * No `≈` prefix (the article surfaces the precise computed figure). Mirrors the CLI/VS Code
	 * `formatExactCostUsd`; the value is still a Sonnet-rate estimate.
	 */
	fun formatExactCostUsd(usd: Double): String = when {
		usd >= 0.01 -> "$" + String.format(Locale.US, "%.2f", usd)
		usd >= 0.00005 -> "$" + String.format(Locale.US, "%.4f", usd)
		usd > 0 -> "<$0.0001"
		else -> "$0.00"
	}

	/**
	 * Sum input/output tokens over the branch's commits. A commit contributes
	 * only when it carries both token counts; a memory-bearing commit missing
	 * them flips [BranchTokenTotals.partial] (the displayed total is then a lower
	 * bound). Code-only commits (no summary) are ignored entirely.
	 */
	fun aggregateTokens(commits: List<CommitSummaryBrief>): BranchTokenTotals {
		var input = 0L
		var output = 0L
		var cached = 0L
		var partial = false
		// Σ per-commit cost; stays null unless at least one memory carried a priced
		// estimate, so a branch with no cost data renders tokens only (no "≈$0.00").
		var cost: Double? = null
		for (c in commits) {
			if (!c.hasSummary) continue
			val bd = c.conversationTokenBreakdown
			if (bd == null) {
				// A memory with no recorded usage (old data / unreported source).
				partial = true
				continue
			}
			input += bd.input
			output += bd.output
			cached += bd.cached
			c.estimatedCostUsd?.let { cost = (cost ?: 0.0) + it }
		}
		// cache_read is excluded from the breakdown (see ConversationTokenBreakdown),
		// so it's always 0 here; `cached` carries cache_creation.
		return BranchTokenTotals(input, output, cacheRead = 0, cacheWrite = cached, partial = partial, estimatedCostUsd = cost)
	}
}

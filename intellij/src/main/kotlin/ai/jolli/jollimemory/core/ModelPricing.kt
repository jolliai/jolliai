package ai.jolli.jollimemory.core

/**
 * ModelPricing — Kotlin port of the CLI's `core/Pricing.ts`.
 *
 * No AI-agent transcript records a dollar cost directly; they record raw token
 * counts plus the model. Cost is therefore always an estimate of
 * `tokens x per-model price`. This object owns that estimate: one hand-maintained
 * multi-provider price table plus a uniform cost formula.
 *
 * Cost formula: `input*inputRate + output*outputRate + cacheWrite*cacheWriteRate`,
 * all rates in USD per 1,000,000 tokens.
 *
 * cache_read is deliberately EXCLUDED (unlike the token *meter*, which shows it):
 * real Claude transcripts emit cache_read as a cumulative running total per turn,
 * so summing it across a session double-counts the cached prefix and would inflate
 * the cost by an order of magnitude. Pricing input + cache_creation (write) +
 * output matches the CLI/VS Code estimate exactly and keeps the figure a floor —
 * a session's re-read of an already-cached prefix is real spend we deliberately do
 * not count, which is why the UI says actual spend may be higher.
 *
 * Prices are hand-maintained (no official machine-readable pricing API exists) and
 * stamped by [PRICES_AS_OF]. Estimates assume standard list pricing — no
 * promotional/intro, batch, or volume discounts (so Sonnet 5 is priced at its
 * standard $3/$15, not the introductory rate). Keep this table in lockstep with
 * the CLI's `MODEL_PRICES`.
 *
 * Official pricing pages — re-verify against these when editing a rate, and bump
 * [PRICES_AS_OF]:
 *   - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 *   - OpenAI:    https://developers.openai.com/api/docs/pricing
 */
object ModelPricing {

	/** Per-model list price in USD per 1,000,000 tokens, per billing segment. */
	data class ModelPrice(
		val provider: String,
		val inputPerMTok: Double,
		val outputPerMTok: Double,
		/**
		 * Cache-*write* (cache_creation) rate. For Anthropic this is ~1.25x the
		 * input rate (a write costs more than fresh input); cache_read is not
		 * priced here (see the object docstring).
		 */
		val cacheWritePerMTok: Double,
	)

	/**
	 * Date this table was last verified against published pricing. Bump it
	 * whenever a rate below changes; stored/surfaced so a reader can judge
	 * staleness.
	 */
	const val PRICES_AS_OF: String = "2026-07-30"

	/**
	 * List prices keyed by the exact model id that appears in the transcript
	 * (`message.model` for Claude). Anthropic figures are from the published
	 * pricing table (cacheWrite = 1.25x input). OpenAI figures are from
	 * developers.openai.com/api/docs/pricing, verified on [PRICES_AS_OF]; for
	 * those models the third segment is a cache *read* (0.1x input), not a write —
	 * the field name reflects the Anthropic case, and the values match the CLI's
	 * `cachedPerMTok` so the two surfaces cost a conversation identically.
	 */
	val MODEL_PRICES: Map<String, ModelPrice> = mapOf(
		// Anthropic (input / output verified; cacheWrite = 1.25x input)
		"claude-fable-5" to ModelPrice("anthropic", 10.0, 50.0, 12.5),
		// Mythos 5 is listed on the pricing page as limited-availability at the SAME
		// rates as Fable 5 — verified there, not copied from the row above. Stated
		// explicitly because identical adjacent numbers are what an unverified copy
		// looks like, and this table forbids guessing a rate (see the `-pro` note).
		"claude-mythos-5" to ModelPrice("anthropic", 10.0, 50.0, 12.5),
		"claude-opus-5" to ModelPrice("anthropic", 5.0, 25.0, 6.25),
		"claude-opus-4-8" to ModelPrice("anthropic", 5.0, 25.0, 6.25),
		"claude-opus-4-7" to ModelPrice("anthropic", 5.0, 25.0, 6.25),
		"claude-opus-4-6" to ModelPrice("anthropic", 5.0, 25.0, 6.25),
		"claude-opus-4-5" to ModelPrice("anthropic", 5.0, 25.0, 6.25),
		"claude-sonnet-5" to ModelPrice("anthropic", 3.0, 15.0, 3.75),
		"claude-sonnet-4-6" to ModelPrice("anthropic", 3.0, 15.0, 3.75),
		"claude-sonnet-4-5" to ModelPrice("anthropic", 3.0, 15.0, 3.75),
		"claude-haiku-4-5" to ModelPrice("anthropic", 1.0, 5.0, 1.25),
		// OpenAI / Codex — verified list prices; third segment is the cached-input
		// (cache read) rate. The previous values here were placeholders mirroring the
		// GPT-5 tier with the cached rate zeroed, so Codex cost was understated twice
		// over; these mirror the CLI table entry-for-entry.
		"gpt-5.6-sol" to ModelPrice("openai", 5.0, 30.0, 0.5),
		"gpt-5.6-terra" to ModelPrice("openai", 2.5, 15.0, 0.25),
		"gpt-5.6-luna" to ModelPrice("openai", 1.0, 6.0, 0.1),
		"gpt-5.5" to ModelPrice("openai", 5.0, 30.0, 0.5),
		"gpt-5.4" to ModelPrice("openai", 2.5, 15.0, 0.25),
		"gpt-5.4-mini" to ModelPrice("openai", 0.75, 4.5, 0.075),
		"gpt-5.4-nano" to ModelPrice("openai", 0.2, 1.25, 0.02),
		"gpt-5.3-codex" to ModelPrice("openai", 1.75, 14.0, 0.175),
		"gpt-5.2" to ModelPrice("openai", 1.75, 14.0, 0.175),
		"gpt-5.2-codex" to ModelPrice("openai", 1.75, 14.0, 0.175),
		"gpt-5.1" to ModelPrice("openai", 1.25, 10.0, 0.125),
		"gpt-5.1-codex-max" to ModelPrice("openai", 1.25, 10.0, 0.125),
		"gpt-5.1-codex" to ModelPrice("openai", 1.25, 10.0, 0.125),
		"gpt-5" to ModelPrice("openai", 1.25, 10.0, 0.125),
		"gpt-5-codex" to ModelPrice("openai", 1.25, 10.0, 0.125),
		"gpt-5-mini" to ModelPrice("openai", 0.25, 2.0, 0.025),
		"gpt-5-nano" to ModelPrice("openai", 0.05, 0.4, 0.005),
		// OpenAI `-pro`: input and output are published, the cached-input column shows
		// "-". These were absent while that dash was read as "unpriceable", but absence
		// is the worse error — an unpriced model contributes nothing, so the whole
		// conversation falls to [estimateSonnetCostUsd] ($3/$15) instead of gpt-5.5-pro's
		// real $30/$180. Pricing the two published segments and billing the undocumented
		// one at the full input rate confines the error to the cached segment: the dash
		// means either no prompt caching (segment always 0) or caching at list price, and
		// neither reading supports a discount. Lockstep with the CLI table.
		"gpt-5.5-pro" to ModelPrice("openai", 30.0, 180.0, 30.0),
		"gpt-5.4-pro" to ModelPrice("openai", 30.0, 180.0, 30.0),
		"gpt-5.2-pro" to ModelPrice("openai", 21.0, 168.0, 21.0),
		"gpt-5-pro" to ModelPrice("openai", 15.0, 120.0, 15.0),
	)

	/** Provider for a model id, or "unknown" when it's absent from the table. */
	fun providerOf(model: String): String = MODEL_PRICES[model]?.provider ?: "unknown"

	/** Estimated USD cost of one model's usage, or null when the model is unpriced. */
	fun estimateModelCostUsd(usage: ModelTokenUsage): Double? {
		val price = MODEL_PRICES[usage.model] ?: return null
		return (usage.input * price.inputPerMTok +
			usage.output * price.outputPerMTok +
			usage.cached * price.cacheWritePerMTok) / 1_000_000.0
	}

	/**
	 * Total estimated USD cost across per-model buckets. Unpriced models are
	 * skipped (never guessed), so the result is a lower bound when [usageByModel]
	 * contains a model absent from the table. Returns 0.0 for empty/all-unpriced.
	 */
	fun estimateCostUsd(usageByModel: List<ModelTokenUsage>): Double {
		var total = 0.0
		for (u in usageByModel) {
			val cost = estimateModelCostUsd(u)
			if (cost != null) total += cost
		}
		return total
	}

	/** Model id whose list price backs the model-unknown fallback estimate. */
	const val FALLBACK_ESTIMATE_MODEL: String = "claude-sonnet-5"

	/**
	 * Rough cost estimate for a memory whose per-model split is unknown (legacy
	 * summaries recorded tokens but not conversationModels). Mirrors the VS Code
	 * `estimateCost(b, total)` (SummaryHtmlBuilder.ts) exactly so the two tools agree
	 * on the fallback figure: when a [breakdown] is present, price its three segments
	 * at Sonnet list rates; otherwise price the scalar [totalTokens] at the input
	 * rate. Deliberately approximate — the true model may be cheaper (Haiku) or
	 * dearer (Opus) — so callers use it only when no stored cost exists and the UI
	 * keeps the leading "≈". Returns 0.0 when there is nothing to price.
	 */
	fun estimateSonnetCostUsd(breakdown: ConversationTokenBreakdown, totalTokens: Long): Double {
		val p = MODEL_PRICES.getValue(FALLBACK_ESTIMATE_MODEL)
		val hasBreakdown = breakdown.input > 0 || breakdown.output > 0 || breakdown.cached > 0
		val raw = if (hasBreakdown) {
			breakdown.input * p.inputPerMTok +
				breakdown.output * p.outputPerMTok +
				breakdown.cached * p.cacheWritePerMTok
		} else {
			totalTokens * p.inputPerMTok
		}
		return raw / 1_000_000.0
	}
}

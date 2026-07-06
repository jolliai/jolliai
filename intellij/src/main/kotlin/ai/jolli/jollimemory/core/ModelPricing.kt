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
 * promotional/intro, batch, or volume discounts. Keep this table in lockstep with
 * the CLI's `MODEL_PRICES`.
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
	const val PRICES_AS_OF: String = "2026-07-04"

	/**
	 * List prices keyed by the exact model id that appears in the transcript
	 * (`message.model` for Claude). Anthropic figures are from the published
	 * pricing table (cacheWrite = 1.25x input). OpenAI GPT-5-family figures are
	 * best-known list prices and MUST be re-verified before shipping user-facing
	 * cost — treat them as provisional.
	 */
	val MODEL_PRICES: Map<String, ModelPrice> = mapOf(
		// Anthropic (input / output verified; cacheWrite = 1.25x input)
		"claude-fable-5" to ModelPrice("anthropic", 10.0, 50.0, 12.5),
		"claude-opus-4-8" to ModelPrice("anthropic", 5.0, 25.0, 6.25),
		"claude-opus-4-7" to ModelPrice("anthropic", 5.0, 25.0, 6.25),
		"claude-opus-4-6" to ModelPrice("anthropic", 5.0, 25.0, 6.25),
		"claude-opus-4-5" to ModelPrice("anthropic", 5.0, 25.0, 6.25),
		"claude-sonnet-5" to ModelPrice("anthropic", 3.0, 15.0, 3.75),
		"claude-sonnet-4-6" to ModelPrice("anthropic", 3.0, 15.0, 3.75),
		"claude-sonnet-4-5" to ModelPrice("anthropic", 3.0, 15.0, 3.75),
		"claude-haiku-4-5" to ModelPrice("anthropic", 1.0, 5.0, 1.25),
		// OpenAI / Codex (PROVISIONAL — re-verify before shipping)
		"gpt-5.5" to ModelPrice("openai", 1.25, 10.0, 0.0),
		"gpt-5.4" to ModelPrice("openai", 1.25, 10.0, 0.0),
		"gpt-5.2-codex" to ModelPrice("openai", 1.25, 10.0, 0.0),
	)

	/** Provider for a model id, or "unknown" when it's absent from the table. */
	fun providerOf(model: String): String = MODEL_PRICES[model]?.provider ?: "unknown"

	/** Estimated USD cost of one model's usage, or null when the model is unpriced. */
	fun estimateModelCostUsd(usage: ModelUsage): Double? {
		val price = MODEL_PRICES[usage.model] ?: return null
		return (usage.input * price.inputPerMTok +
			usage.output * price.outputPerMTok +
			usage.cacheWrite * price.cacheWritePerMTok) / 1_000_000.0
	}

	/**
	 * Total estimated USD cost across per-model buckets. Unpriced models are
	 * skipped (never guessed), so the result is a lower bound when [usageByModel]
	 * contains a model absent from the table. Returns 0.0 for empty/all-unpriced.
	 */
	fun estimateCostUsd(usageByModel: List<ModelUsage>): Double {
		var total = 0.0
		for (u in usageByModel) {
			val cost = estimateModelCostUsd(u)
			if (cost != null) total += cost
		}
		return total
	}
}

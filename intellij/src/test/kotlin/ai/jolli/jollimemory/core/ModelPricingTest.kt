package ai.jolli.jollimemory.core

import io.kotest.assertions.withClue
import io.kotest.matchers.doubles.shouldBeGreaterThan
import io.kotest.matchers.doubles.shouldBeLessThan
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

class ModelPricingTest {

    private fun usage(model: String, input: Long = 0, output: Long = 0, cached: Long = 0) =
        ModelTokenUsage(model, ModelPricing.providerOf(model), input, output, cached)

    @Test
    fun `prices the three segments at the model's rates`() {
        // Opus 4.8: $5 input, $25 output, $6.25 cacheWrite per 1M.
        val cost = ModelPricing.estimateModelCostUsd(
            usage("claude-opus-4-8", input = 1_000_000, output = 1_000_000, cached = 1_000_000),
        )!!
        cost shouldBe (5.0 + 25.0 + 6.25)
    }

    @Test
    fun `scales linearly below 1M tokens`() {
        // Haiku 4.5: $1 input, $5 output.
        val cost = ModelPricing.estimateModelCostUsd(usage("claude-haiku-4-5", input = 500_000, output = 200_000))!!
        cost shouldBe (0.5 + 1.0)
    }

    @Test
    fun `cacheWrite is priced above the input rate for Anthropic`() {
        val p = ModelPricing.MODEL_PRICES.getValue("claude-opus-4-8")
        p.cacheWritePerMTok shouldBeGreaterThan p.inputPerMTok
    }

    // Replaces an earlier assertion that OpenAI input was cheaper than Opus input.
    // That stopped being true once the table was verified against published pricing:
    // gpt-5.5 and gpt-5.6-sol are both $5/MTok input, the same as Opus. The invariant
    // that does hold is the segment direction — OpenAI's third segment is a cache
    // READ (0.1x input), the opposite of Anthropic's cache WRITE (1.25x input).
    @Test
    fun `openai cached rate is below input while anthropic cacheWrite is above`() {
        for ((model, p) in ModelPricing.MODEL_PRICES) {
            withClue(model) {
                when {
                    // `-pro` publishes no cached-input rate, so it is billed at the full
                    // input rate — never below. See `pro models`, below.
                    model.endsWith("-pro") -> p.cacheWritePerMTok shouldBe p.inputPerMTok
                    p.provider == "openai" -> p.cacheWritePerMTok shouldBeLessThan p.inputPerMTok
                    else -> p.cacheWritePerMTok shouldBeGreaterThan p.inputPerMTok
                }
            }
        }
    }

    // Lockstep with the CLI table (cli/src/core/Pricing.ts). Absent here, a gpt-5.5-pro
    // conversation would fall to the Sonnet fallback — $3/$15 against a real $30/$180.
    @Test
    fun `prices the pro models with their cached segment at the input rate`() {
        ModelPricing.MODEL_PRICES.getValue("gpt-5.5-pro") shouldBe
            ModelPricing.ModelPrice("openai", 30.0, 180.0, 30.0)
        ModelPricing.MODEL_PRICES.getValue("gpt-5.4-pro") shouldBe
            ModelPricing.ModelPrice("openai", 30.0, 180.0, 30.0)
        ModelPricing.MODEL_PRICES.getValue("gpt-5.2-pro") shouldBe
            ModelPricing.ModelPrice("openai", 21.0, 168.0, 21.0)
        ModelPricing.MODEL_PRICES.getValue("gpt-5-pro") shouldBe
            ModelPricing.ModelPrice("openai", 15.0, 120.0, 15.0)
        // 1M in + 1M out = $210, where the unpriced path yielded $0 and the caller then
        // estimated $18 at Sonnet rates.
        ModelPricing.estimateModelCostUsd(usage("gpt-5.5-pro", input = 1_000_000, output = 1_000_000))!! shouldBe 210.0
    }

    // Kept in lockstep with the CLI's MODEL_PRICES (cli/src/core/Pricing.ts). A model
    // missing here but present there means IntelliJ silently falls back to the Sonnet
    // estimate for work VS Code prices correctly — the two tools then disagree on the
    // cost of the same memory.
    @Test
    fun `prices the models real transcripts record today`() {
        ModelPricing.MODEL_PRICES.getValue("claude-opus-5") shouldBe
            ModelPricing.ModelPrice("anthropic", 5.0, 25.0, 6.25)
        // Mythos 5 is listed at the Fable 5 rates (limited availability). Pinned as a
        // deliberate equality, not left as two coincidentally-matching rows.
        ModelPricing.MODEL_PRICES.getValue("claude-mythos-5") shouldBe
            ModelPricing.MODEL_PRICES.getValue("claude-fable-5")
        ModelPricing.MODEL_PRICES.getValue("claude-mythos-5") shouldBe
            ModelPricing.ModelPrice("anthropic", 10.0, 50.0, 12.5)
        ModelPricing.MODEL_PRICES.getValue("gpt-5.4") shouldBe
            ModelPricing.ModelPrice("openai", 2.5, 15.0, 0.25)
        ModelPricing.MODEL_PRICES.getValue("gpt-5.4-mini") shouldBe
            ModelPricing.ModelPrice("openai", 0.75, 4.5, 0.075)
        ModelPricing.MODEL_PRICES.getValue("gpt-5.6-sol") shouldBe
            ModelPricing.ModelPrice("openai", 5.0, 30.0, 0.5)
        ModelPricing.MODEL_PRICES.getValue("gpt-5.6-terra") shouldBe
            ModelPricing.ModelPrice("openai", 2.5, 15.0, 0.25)
        ModelPricing.MODEL_PRICES.getValue("gpt-5.6-luna") shouldBe
            ModelPricing.ModelPrice("openai", 1.0, 6.0, 0.1)
    }

    @Test
    fun `unknown model is unpriced`() {
        ModelPricing.estimateModelCostUsd(usage("mystery-model", input = 1_000_000)).shouldBeNull()
        ModelPricing.providerOf("mystery-model") shouldBe "unknown"
    }

    @Test
    fun `estimateCostUsd sums priced models and excludes unpriced ones`() {
        val total = ModelPricing.estimateCostUsd(
            listOf(
                usage("claude-opus-4-8", output = 1_000_000), // $25
                usage("claude-haiku-4-5", output = 1_000_000), // $5
                usage("mystery-model", output = 1_000_000), // excluded
            ),
        )
        total shouldBe 30.0
    }

    @Test
    fun `estimateCostUsd is zero for empty input`() {
        ModelPricing.estimateCostUsd(emptyList()) shouldBe 0.0
    }

    @Test
    fun `prices-as-of is an ISO date`() {
        ModelPricing.PRICES_AS_OF.matches(Regex("""\d{4}-\d{2}-\d{2}""")) shouldBe true
    }

    @Test
    fun `sonnet fallback prices a breakdown at sonnet segment rates`() {
        // Sonnet: $3 input, $15 output, $3.75 cacheWrite per 1M. Breakdown present -> segments.
        ModelPricing.estimateSonnetCostUsd(
            ConversationTokenBreakdown(input = 1_000_000, output = 1_000_000, cached = 1_000_000),
            totalTokens = 3_000_000,
        ) shouldBe (3.0 + 15.0 + 3.75)
    }

    @Test
    fun `sonnet fallback prices a bare total at the input rate when no breakdown`() {
        // Mirrors VS Code estimateCost's `total * SONNET_INPUT_PER_TOKEN` branch.
        ModelPricing.estimateSonnetCostUsd(ConversationTokenBreakdown(), totalTokens = 1_000_000) shouldBe 3.0
    }

    @Test
    fun `sonnet fallback is zero when there is nothing to price`() {
        ModelPricing.estimateSonnetCostUsd(ConversationTokenBreakdown(), totalTokens = 0) shouldBe 0.0
    }
}

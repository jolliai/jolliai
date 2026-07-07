package ai.jolli.jollimemory.core

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

    @Test
    fun `openai input rate is below the anthropic opus input rate`() {
        val gpt = ModelPricing.MODEL_PRICES.getValue("gpt-5.5")
        val opus = ModelPricing.MODEL_PRICES.getValue("claude-opus-4-8")
        gpt.inputPerMTok shouldBeLessThan opus.inputPerMTok
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

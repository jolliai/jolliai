package ai.jolli.jollimemory.core.telemetry

import ai.jolli.jollimemory.core.JolliMemoryConfig
import ai.jolli.jollimemory.core.fakeHookEnv
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

/**
 * Guards the `captureMethodOf` port against drift from the CLI's
 * `resolveLlmCredentialSource` (cli/src/core/LlmClient.ts) — the same routes,
 * collapsed to the funnel's coarse discriminator. Env reads go through
 * `fakeHookEnv` so no test touches the real JVM environment (global-state gate).
 */
class OnboardingFunnelTest {
    private val noEnv = fakeHookEnv()

    @Test
    fun `local-agent is always a capture route, no key required`() {
        OnboardingFunnel.captureMethodOf(JolliMemoryConfig(aiProvider = "local-agent"), noEnv) shouldBe "local-agent"
    }

    @Test
    fun `jolli provider requires the jolli key`() {
        OnboardingFunnel.captureMethodOf(
            JolliMemoryConfig(aiProvider = "jolli", jolliApiKey = "sk-jol-x"),
            noEnv,
        ) shouldBe "jolli"
        OnboardingFunnel.captureMethodOf(JolliMemoryConfig(aiProvider = "jolli"), noEnv) shouldBe "none"
    }

    @Test
    fun `anthropic provider accepts a config key or an env key`() {
        OnboardingFunnel.captureMethodOf(JolliMemoryConfig(aiProvider = "anthropic", apiKey = "sk-ant"), noEnv) shouldBe
            "anthropic"
        OnboardingFunnel.captureMethodOf(
            JolliMemoryConfig(aiProvider = "anthropic"),
            fakeHookEnv(env = mapOf("ANTHROPIC_API_KEY" to "sk-ant")),
        ) shouldBe "anthropic"
        OnboardingFunnel.captureMethodOf(JolliMemoryConfig(aiProvider = "anthropic"), noEnv) shouldBe "none"
    }

    @Test
    fun `undefined provider falls back anthropic (config or env) then jolli then none`() {
        OnboardingFunnel.captureMethodOf(JolliMemoryConfig(apiKey = "sk-ant"), noEnv) shouldBe "anthropic"
        OnboardingFunnel.captureMethodOf(
            JolliMemoryConfig(),
            fakeHookEnv(env = mapOf("ANTHROPIC_API_KEY" to "sk-ant")),
        ) shouldBe "anthropic"
        OnboardingFunnel.captureMethodOf(JolliMemoryConfig(jolliApiKey = "sk-jol-x"), noEnv) shouldBe "jolli"
        OnboardingFunnel.captureMethodOf(JolliMemoryConfig(), noEnv) shouldBe "none"
    }
}

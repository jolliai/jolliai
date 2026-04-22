package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.services.JolliApiClient

/**
 * LlmClient — Routes LLM calls between direct Anthropic API and Jolli proxy.
 *
 * Credential priority: Anthropic API key > ANTHROPIC_API_KEY env var > Jolli API key (proxy).
 * Direct mode: caller provides a pre-built prompt, we call AnthropicClient.
 * Proxy mode: we send action + params to Jolli backend which owns the prompt template.
 */
object LlmClient {

    private val log = JmLogger.create("LlmClient")

    enum class CredentialSource { ANTHROPIC_CONFIG, ANTHROPIC_ENV, JOLLI_PROXY }

    data class LlmCallResult(
        val text: String?,
        val model: String?,
        val inputTokens: Int,
        val outputTokens: Int,
        val apiLatencyMs: Long,
        val stopReason: String?,
    )

    /**
     * Determines which credential source to use.
     * Returns null if no credentials are available.
     */
    fun resolveCredentialSource(apiKey: String?, jolliApiKey: String?): CredentialSource? {
        if (!apiKey.isNullOrBlank()) return CredentialSource.ANTHROPIC_CONFIG
        if (!System.getenv("ANTHROPIC_API_KEY").isNullOrBlank()) return CredentialSource.ANTHROPIC_ENV
        if (!jolliApiKey.isNullOrBlank()) return CredentialSource.JOLLI_PROXY
        return null
    }

    /**
     * Makes an LLM call, routing to direct Anthropic or Jolli proxy based on available credentials.
     *
     * @param action Template key (e.g. "summarize:small", "commit-message") — used for proxy mode
     * @param params Template params — used for proxy mode
     * @param apiKey Anthropic API key for direct mode
     * @param jolliApiKey Jolli API key for proxy mode
     * @param model Model alias or full ID (direct mode only)
     * @param maxTokens Max output tokens (direct mode only)
     * @param prompt Pre-built prompt string (direct mode only)
     */
    fun callLlm(
        action: String,
        params: Map<String, String>,
        apiKey: String?,
        jolliApiKey: String?,
        model: String?,
        maxTokens: Int?,
        prompt: String?,
    ): LlmCallResult {
        val source = resolveCredentialSource(apiKey, jolliApiKey)
            ?: throw RuntimeException("No LLM credentials available. Sign in to Jolli or configure an Anthropic API key.")

        log.info("LLM call: action=%s, source=%s", action, source)

        return when (source) {
            CredentialSource.ANTHROPIC_CONFIG -> callDirect(prompt!!, apiKey!!, model, maxTokens)
            CredentialSource.ANTHROPIC_ENV -> callDirect(prompt!!, System.getenv("ANTHROPIC_API_KEY"), model, maxTokens)
            CredentialSource.JOLLI_PROXY -> callProxy(jolliApiKey!!, action, params)
        }
    }

    private fun callDirect(prompt: String, apiKey: String, model: String?, maxTokens: Int?): LlmCallResult {
        val resolvedModel = Summarizer.resolveModelId(model)
        val resolvedMaxTokens = maxTokens ?: 8192
        val client = AnthropicClient(apiKey)
        val startTime = System.currentTimeMillis()

        val response = client.createMessage(
            model = resolvedModel,
            maxTokens = resolvedMaxTokens,
            temperature = 0.0,
            messages = listOf(AnthropicClient.Message("user", prompt)),
        )

        val elapsed = System.currentTimeMillis() - startTime
        val text = response.content.firstOrNull { it.type == "text" }?.text?.trim()

        return LlmCallResult(
            text = text,
            model = response.model,
            inputTokens = response.usage.inputTokens,
            outputTokens = response.usage.outputTokens,
            apiLatencyMs = elapsed,
            stopReason = response.stopReason,
        )
    }

    private fun callProxy(jolliApiKey: String, action: String, params: Map<String, String>): LlmCallResult {
        val startTime = System.currentTimeMillis()
        val result = JolliApiClient.callLlmProxy(jolliApiKey, action, params)
        val elapsed = System.currentTimeMillis() - startTime

        return LlmCallResult(
            text = result.text,
            model = null,
            inputTokens = result.inputTokens,
            outputTokens = result.outputTokens,
            apiLatencyMs = elapsed,
            stopReason = null,
        )
    }
}

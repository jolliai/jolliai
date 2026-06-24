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

    enum class CredentialSource(val wireValue: String) {
        ANTHROPIC_CONFIG("anthropic-config"),
        ANTHROPIC_ENV("anthropic-env"),
        JOLLI_PROXY("jolli-proxy"),
    }

    data class LlmCallResult(
        val text: String?,
        val model: String?,
        val inputTokens: Int,
        val outputTokens: Int,
        val apiLatencyMs: Long,
        val stopReason: String?,
        /** Which credential source produced this result (e.g. "anthropic-config", "jolli-proxy"). */
        val source: String? = null,
    )

    /**
     * Determines which credential source to use.
     *
     * When [aiProvider] is set, it controls preference order; the other source is the fallback
     * when the preferred one has no credentials. When null, defers to the historical
     * "Anthropic wins" order. Returns null if no credentials are available.
     */
    fun resolveCredentialSource(
        apiKey: String?,
        jolliApiKey: String?,
        aiProvider: String? = null,
    ): CredentialSource? {
        val anthropicConfig = if (!apiKey.isNullOrBlank()) CredentialSource.ANTHROPIC_CONFIG else null
        val anthropicEnv = if (!System.getenv("ANTHROPIC_API_KEY").isNullOrBlank()) CredentialSource.ANTHROPIC_ENV else null
        val jolliProxy = if (!jolliApiKey.isNullOrBlank()) CredentialSource.JOLLI_PROXY else null

        return when (aiProvider) {
            "jolli" -> jolliProxy ?: anthropicConfig ?: anthropicEnv
            "anthropic" -> anthropicConfig ?: anthropicEnv ?: jolliProxy
            else -> anthropicConfig ?: anthropicEnv ?: jolliProxy
        }
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
        aiProvider: String? = null,
        // One trace per LLM operation: tags the "LLM call" log + the proxy call's
        // own logs + the outbound x-jolli-trace header with one grep-able id.
    ): LlmCallResult = TraceContext.withTrace {
        val source = resolveCredentialSource(apiKey, jolliApiKey, aiProvider)
            ?: throw RuntimeException("No LLM credentials available. Sign in to Jolli or configure an Anthropic API key.")

        log.info("LLM call: action=%s, source=%s", action, source)

        // Direct (Anthropic) mode needs a caller-built prompt. A template-only action
        // (proxy-style action+params, prompt=null) routed here would otherwise NPE on
        // `prompt!!`; fail loud with a clear message instead — the real fix for callers
        // like the wiki ingest, which have no local prompt template.
        if ((source == CredentialSource.ANTHROPIC_CONFIG || source == CredentialSource.ANTHROPIC_ENV) && prompt == null) {
            throw IllegalStateException(
                "Direct-mode LLM call for action '$action' requires a prompt, but none was supplied " +
                    "(no local template for this action — use proxy mode / Jolli sign-in).",
            )
        }

        val result = when (source) {
            CredentialSource.ANTHROPIC_CONFIG -> callDirect(prompt!!, apiKey!!, model, maxTokens)
            CredentialSource.ANTHROPIC_ENV -> callDirect(prompt!!, System.getenv("ANTHROPIC_API_KEY"), model, maxTokens)
            CredentialSource.JOLLI_PROXY -> callProxy(jolliApiKey!!, action, params)
        }
        result.copy(source = source.wireValue)
    }

    /** Above this `max_tokens`, use streaming: Anthropic refuses long non-streaming
     *  requests and the non-streaming client timeout can't cover them. */
    private const val STREAMING_THRESHOLD_TOKENS = 16_384

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
            stream = resolvedMaxTokens > STREAMING_THRESHOLD_TOKENS,
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

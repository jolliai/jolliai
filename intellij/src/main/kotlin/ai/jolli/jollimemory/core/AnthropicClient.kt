package ai.jolli.jollimemory.core

import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * AnthropicClient — Raw HTTP client for the Anthropic Messages API.
 *
 * No SDK dependency — uses java.net.http.HttpClient (JDK 11+).
 */
class AnthropicClient(private val apiKey: String) {

    private val log = JmLogger.create("AnthropicClient")
    private val gson = Gson()
    private val client = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(30))
        .build()

    companion object {
        private const val API_URL = "https://api.anthropic.com/v1/messages"
        private const val API_VERSION = "2023-06-01"
    }

    /** Creates a message and returns the response. */
    fun createMessage(model: String, maxTokens: Int, temperature: Double, messages: List<Message>): MessageResponse {
        val body = gson.toJson(CreateMessageRequest(model, maxTokens, temperature, messages))

        val request = HttpRequest.newBuilder()
            .uri(URI.create(API_URL))
            .header("x-api-key", apiKey)
            .header("anthropic-version", API_VERSION)
            .header("content-type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .timeout(Duration.ofSeconds(120))
            .build()

        val response = client.send(request, HttpResponse.BodyHandlers.ofString(Charsets.UTF_8))

        if (response.statusCode() != 200) {
            val errorBody = response.body()
            log.error("Anthropic API error %d: %s", response.statusCode(), errorBody.take(500))
            throw RuntimeException("Anthropic API error ${response.statusCode()}: ${errorBody.take(200)}")
        }

        return gson.fromJson(response.body(), MessageResponse::class.java)
    }

    // ── Request/Response types ───────────────────────────────────────────────

    data class Message(
        val role: String,
        val content: String,
    )

    data class CreateMessageRequest(
        val model: String,
        @SerializedName("max_tokens") val maxTokens: Int,
        val temperature: Double,
        val messages: List<Message>,
    )

    data class ContentBlock(
        val type: String,
        val text: String? = null,
    )

    data class Usage(
        @SerializedName("input_tokens") val inputTokens: Int,
        @SerializedName("output_tokens") val outputTokens: Int,
    )

    data class MessageResponse(
        val id: String,
        val model: String,
        val content: List<ContentBlock>,
        val usage: Usage,
        @SerializedName("stop_reason") val stopReason: String?,
    )
}

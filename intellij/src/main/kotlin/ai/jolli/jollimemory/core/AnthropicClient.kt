package ai.jolli.jollimemory.core

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.annotations.SerializedName
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.stream.Collectors
import java.util.stream.Stream

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

    /**
     * Creates a message and returns the response.
     *
     * When [stream] is true the call uses Server-Sent-Events (`stream: true`) and
     * accumulates the deltas into the same [MessageResponse] shape. Streaming is
     * required for long generations: Anthropic refuses non-streaming requests whose
     * `max_tokens` implies >10 min of output (e.g. the 64k-token reconcile call), and
     * the non-streaming 120s client timeout can't cover them either.
     */
    fun createMessage(
        model: String,
        maxTokens: Int,
        temperature: Double,
        messages: List<Message>,
        stream: Boolean = false,
    ): MessageResponse {
        val body = gson.toJson(CreateMessageRequest(model, maxTokens, temperature, messages, stream = stream))

        val request = HttpRequest.newBuilder()
            .uri(URI.create(API_URL))
            .header("x-api-key", apiKey)
            .header("anthropic-version", API_VERSION)
            .header("content-type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            // Streaming generations can run for minutes; give them a generous ceiling.
            .timeout(if (stream) Duration.ofMinutes(10) else Duration.ofSeconds(120))
            .build()

        if (!stream) {
            val response = client.send(request, HttpResponse.BodyHandlers.ofString(Charsets.UTF_8))
            if (response.statusCode() != 200) {
                val errorBody = response.body()
                log.error("Anthropic API error %d: %s", response.statusCode(), errorBody.take(500))
                throw RuntimeException("Anthropic API error ${response.statusCode()}: ${errorBody.take(200)}")
            }
            return gson.fromJson(response.body(), MessageResponse::class.java)
        }

        val response = client.send(request, HttpResponse.BodyHandlers.ofLines())
        if (response.statusCode() != 200) {
            val errorBody = response.body().collect(Collectors.joining("\n"))
            log.error("Anthropic API error %d (stream): %s", response.statusCode(), errorBody.take(500))
            throw RuntimeException("Anthropic API error ${response.statusCode()}: ${errorBody.take(200)}")
        }
        return parseSseStream(response.body(), model)
    }

    /** Accumulates an SSE message stream into a [MessageResponse]. */
    private fun parseSseStream(lines: Stream<String>, fallbackModel: String): MessageResponse {
        val text = StringBuilder()
        var id = ""
        var model = fallbackModel
        var stopReason: String? = null
        var inputTokens = 0
        var outputTokens = 0
        lines.forEach { raw ->
            val line = raw.trim()
            if (!line.startsWith("data:")) return@forEach
            val json = line.removePrefix("data:").trim()
            if (json.isEmpty()) return@forEach
            val ev = try {
                gson.fromJson(json, JsonObject::class.java)
            } catch (_: Exception) {
                return@forEach
            } ?: return@forEach
            when (ev.get("type")?.asString) {
                "message_start" -> ev.getAsJsonObject("message")?.let { msg ->
                    msg.get("id")?.takeIf { !it.isJsonNull }?.let { id = it.asString }
                    msg.get("model")?.takeIf { !it.isJsonNull }?.let { model = it.asString }
                    msg.getAsJsonObject("usage")?.get("input_tokens")?.takeIf { !it.isJsonNull }?.let { inputTokens = it.asInt }
                }
                "content_block_delta" -> ev.getAsJsonObject("delta")?.let { delta ->
                    if (delta.get("type")?.asString == "text_delta") {
                        delta.get("text")?.takeIf { !it.isJsonNull }?.let { text.append(it.asString) }
                    }
                }
                "message_delta" -> {
                    ev.getAsJsonObject("delta")?.get("stop_reason")?.takeIf { !it.isJsonNull }?.let { stopReason = it.asString }
                    ev.getAsJsonObject("usage")?.get("output_tokens")?.takeIf { !it.isJsonNull }?.let { outputTokens = it.asInt }
                }
            }
        }
        return MessageResponse(
            id = id,
            model = model,
            content = listOf(ContentBlock("text", text.toString())),
            usage = Usage(inputTokens, outputTokens),
            stopReason = stopReason,
        )
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
        val stream: Boolean = false,
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

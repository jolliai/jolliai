package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class AnthropicClientTest {

    private fun sse(vararg events: String): java.util.stream.Stream<String> =
        events.flatMap { listOf("data: $it", "") }.stream()

    @Test
    fun `parseSseStream accumulates a complete stream`() {
        val client = AnthropicClient("test-key")
        val response = client.parseSseStream(
            sse(
                """{"type":"message_start","message":{"id":"msg_1","model":"claude","usage":{"input_tokens":5}}}""",
                """{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}""",
                """{"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}""",
                """{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}""",
                """{"type":"message_stop"}""",
            ),
            "fallback-model",
        )
        response.id shouldBe "msg_1"
        response.content.single().text shouldBe "Hello world"
        response.usage.inputTokens shouldBe 5
        response.usage.outputTokens shouldBe 2
        response.stopReason shouldBe "end_turn"
    }

    @Test
    fun `parseSseStream throws on a mid-stream error event`() {
        val client = AnthropicClient("test-key")
        val ex = assertThrows<RuntimeException> {
            client.parseSseStream(
                sse(
                    """{"type":"message_start","message":{"id":"msg_1","model":"claude"}}""",
                    """{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}""",
                ),
                "fallback-model",
            )
        }
        ex.message shouldContain "overloaded_error"
        ex.message shouldContain "Overloaded"
    }

    @Test
    fun `parseSseStream throws when the stream ends without message_stop`() {
        val client = AnthropicClient("test-key")
        val ex = assertThrows<RuntimeException> {
            client.parseSseStream(
                sse(
                    """{"type":"message_start","message":{"id":"msg_1","model":"claude"}}""",
                    """{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}""",
                ),
                "fallback-model",
            )
        }
        ex.message shouldContain "prematurely"
    }

    @Test
    fun `Message data class fields`() {
        val msg = AnthropicClient.Message("user", "Hello")
        msg.role shouldBe "user"
        msg.content shouldBe "Hello"
    }

    @Test
    fun `CreateMessageRequest fields`() {
        val req = AnthropicClient.CreateMessageRequest("sonnet", 1024, 0.0, listOf(AnthropicClient.Message("user", "Hi")))
        req.model shouldBe "sonnet"
        req.maxTokens shouldBe 1024
        req.temperature shouldBe 0.0
        req.messages.size shouldBe 1
    }

    @Test
    fun `ContentBlock with text`() {
        val block = AnthropicClient.ContentBlock("text", "Hello")
        block.type shouldBe "text"
        block.text shouldBe "Hello"
    }

    @Test
    fun `ContentBlock without text`() {
        val block = AnthropicClient.ContentBlock("tool_use")
        block.text shouldBe null
    }

    @Test
    fun `Usage fields`() {
        val usage = AnthropicClient.Usage(100, 200)
        usage.inputTokens shouldBe 100
        usage.outputTokens shouldBe 200
    }

    @Test
    fun `MessageResponse fields`() {
        val response = AnthropicClient.MessageResponse(
            id = "msg_123",
            model = "claude-sonnet-4-6",
            content = listOf(AnthropicClient.ContentBlock("text", "Hello")),
            usage = AnthropicClient.Usage(50, 100),
            stopReason = "end_turn",
        )
        response.id shouldBe "msg_123"
        response.model shouldBe "claude-sonnet-4-6"
        response.content.size shouldBe 1
        response.stopReason shouldBe "end_turn"
    }

    @Test
    fun `MessageResponse with null stopReason`() {
        val response = AnthropicClient.MessageResponse(
            id = "msg_456", model = "model", content = emptyList(),
            usage = AnthropicClient.Usage(0, 0), stopReason = null,
        )
        response.stopReason shouldBe null
    }
}

package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

class AnthropicClientTest {

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

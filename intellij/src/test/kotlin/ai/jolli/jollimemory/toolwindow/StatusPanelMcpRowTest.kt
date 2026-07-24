package ai.jolli.jollimemory.toolwindow

import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Test

/**
 * Tests the pure state → row mapping for the "MCP & Skills" status row. The three states
 * must always be visible and self-explanatory (the durable replacement for the transient
 * balloon), so we assert icon + description + the key tooltip contents.
 */
class StatusPanelMcpRowTest {

    @Test
    fun `node present and integrations active is OK active`() {
        val row = StatusPanel.mcpStatusRow(nodeAvailable = true, integrationsActive = true)
        row.icon shouldBe StatusPanel.Icon.OK
        row.label shouldBe "MCP & Skills"
        row.description shouldBe "active"
    }

    @Test
    fun `node missing warns and lists the unavailable features`() {
        val row = StatusPanel.mcpStatusRow(nodeAvailable = false, integrationsActive = false)
        row.icon shouldBe StatusPanel.Icon.WARN
        row.description shouldBe "Node.js not found"
        row.tooltip!! shouldContain "/jolli-recall"
        row.tooltip!! shouldContain "/jolli-search"
        row.tooltip!! shouldContain "MCP"
    }

    @Test
    fun `node present but integrations inactive is setup incomplete`() {
        val row = StatusPanel.mcpStatusRow(nodeAvailable = true, integrationsActive = false)
        row.icon shouldBe StatusPanel.Icon.WARN
        row.description shouldBe "setup incomplete"
        row.tooltip!! shouldContain "jollimemory-install-debug.log"
    }
}

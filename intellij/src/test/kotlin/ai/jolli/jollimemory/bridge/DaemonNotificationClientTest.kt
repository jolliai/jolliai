package ai.jolli.jollimemory.bridge

import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeInstanceOf
import org.junit.jupiter.api.Test

class DaemonNotificationClientTest {

    @Test
    fun `parseNotification returns Ready with the advertised protocol`() {
        val event = parseNotification(
            """{"jsonrpc":"2.0","method":"ready","params":{"protocol":"jolli-daemon-notify-v1","pid":42}}""",
        )
        event.shouldBeInstanceOf<DaemonEvent.Ready>()
        event.protocol shouldBe "jolli-daemon-notify-v1"
    }

    @Test
    fun `parseNotification carries a future protocol string verbatim (dispatch decides)`() {
        // Version-bump handling lives in the dispatch code so an unrecognised protocol
        // gets logged and disconnected there — the parser just relays what the daemon
        // said, so a future -v2 bump is observable rather than silently coerced.
        val event = parseNotification(
            """{"jsonrpc":"2.0","method":"ready","params":{"protocol":"jolli-daemon-notify-v2","pid":42}}""",
        )
        event.shouldBeInstanceOf<DaemonEvent.Ready>()
        event.protocol shouldBe "jolli-daemon-notify-v2"
    }

    @Test
    fun `parseNotification defaults missing ready params to empty protocol`() {
        // Ready without params is an old daemon shape (never shipped, but the parser
        // must not throw); the dispatch code treats "" as a mismatch and disconnects.
        val event = parseNotification("""{"jsonrpc":"2.0","method":"ready"}""")
        event.shouldBeInstanceOf<DaemonEvent.Ready>()
        event.protocol shouldBe ""
    }

    @Test
    fun `parseNotification returns Refresh with kind and cwd`() {
        val event = parseNotification(
            """{"jsonrpc":"2.0","method":"refresh","params":{"kind":"queue","cwd":"/repo"}}""",
        )
        event.shouldBeInstanceOf<DaemonEvent.Refresh>()
        event.kind shouldBe "queue"
        event.cwd shouldBe "/repo"
    }

    @Test
    fun `parseNotification defaults missing cwd to empty string`() {
        val event = parseNotification(
            """{"jsonrpc":"2.0","method":"refresh","params":{"kind":"orphan-ref"}}""",
        )
        event.shouldBeInstanceOf<DaemonEvent.Refresh>()
        event.kind shouldBe "orphan-ref"
        event.cwd shouldBe ""
    }

    @Test
    fun `parseNotification returns null when kind is missing`() {
        val event = parseNotification(
            """{"jsonrpc":"2.0","method":"refresh","params":{"cwd":"/repo"}}""",
        )
        event shouldBe null
    }

    @Test
    fun `parseNotification returns null when params is missing`() {
        val event = parseNotification("""{"jsonrpc":"2.0","method":"refresh"}""")
        event shouldBe null
    }

    @Test
    fun `parseNotification returns null for unknown method`() {
        val event = parseNotification("""{"jsonrpc":"2.0","method":"pong"}""")
        event shouldBe null
    }

    @Test
    fun `parseNotification returns null for missing method`() {
        val event = parseNotification("""{"jsonrpc":"2.0"}""")
        event shouldBe null
    }

    @Test
    fun `parseNotification returns null for malformed JSON`() {
        val event = parseNotification("this is not JSON")
        event shouldBe null
    }

    @Test
    fun `parseNotification returns null for non-object JSON`() {
        val event = parseNotification("""["method","refresh"]""")
        event shouldBe null
    }
}

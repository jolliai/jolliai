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

    // ── params.names (claude-plans) ─────────────────────────────────────────

    @Test
    fun `parseNotification reads the plan filenames off a claude-plans refresh`() {
        val event = parseNotification(
            """{"jsonrpc":"2.0","method":"refresh","params":""" +
                """{"kind":"claude-plans","cwd":"/repo","names":["add-dark-mode.md","fix-login.md"]}}""",
        )
        event.shouldBeInstanceOf<DaemonEvent.Refresh>()
        event.kind shouldBe RefreshKinds.CLAUDE_PLANS
        // Raw directory entries, extension intact — turning these into slugs is
        // the CLI's job (`plans-register-new`), never this parser's.
        event.names shouldBe listOf("add-dark-mode.md", "fix-login.md")
    }

    @Test
    fun `parseNotification defaults names to empty when the kind does not carry them`() {
        val event = parseNotification(
            """{"jsonrpc":"2.0","method":"refresh","params":{"kind":"working-context","cwd":"/repo"}}""",
        )
        event.shouldBeInstanceOf<DaemonEvent.Refresh>()
        event.kind shouldBe RefreshKinds.WORKING_CONTEXT
        event.names shouldBe emptyList()
    }

    @Test
    fun `parseNotification tolerates an empty names array (platform withheld the filenames)`() {
        val event = parseNotification(
            """{"jsonrpc":"2.0","method":"refresh","params":{"kind":"claude-plans","cwd":"/repo","names":[]}}""",
        )
        event.shouldBeInstanceOf<DaemonEvent.Refresh>()
        event.names shouldBe emptyList()
    }

    @Test
    fun `parseNotification keeps the well-formed names beside a malformed one`() {
        // A bad element must not cost us its siblings — the alternative is
        // dropping a real new plan because something else on the wire was odd.
        val event = parseNotification(
            """{"jsonrpc":"2.0","method":"refresh","params":""" +
                """{"kind":"claude-plans","cwd":"/repo","names":["ok.md",7,null,{"a":1},"  ","also-ok.md"]}}""",
        )
        event.shouldBeInstanceOf<DaemonEvent.Refresh>()
        event.names shouldBe listOf("ok.md", "also-ok.md")
    }

    @Test
    fun `parseNotification ignores a names field that is not an array`() {
        val event = parseNotification(
            """{"jsonrpc":"2.0","method":"refresh","params":{"kind":"claude-plans","cwd":"/r","names":"nope"}}""",
        )
        event.shouldBeInstanceOf<DaemonEvent.Refresh>()
        event.names shouldBe emptyList()
    }

    @Test
    fun `refresh kind constants stay in lockstep with the CLI's RefreshKind`() {
        // These two strings are the wire, and the daemon side of them lives in
        // cli/src/daemon/DaemonProtocol.ts. A rename there that is not mirrored
        // here fails silently: the kind stops matching, the light-refresh branch
        // never runs, and the panel simply goes back to being slow.
        RefreshKinds.WORKING_CONTEXT shouldBe "working-context"
        RefreshKinds.CLAUDE_PLANS shouldBe "claude-plans"
    }
}

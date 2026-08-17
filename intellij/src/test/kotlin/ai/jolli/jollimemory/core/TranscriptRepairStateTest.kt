package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

/**
 * The JVM host's half of the three-state memory-detail copy (spec §9).
 *
 * Two things are pinned here. The WORDING — three sentences that must read
 * identically on the CLI dashboard, the VS Code memory detail and this host, so
 * one memory is never described three different ways — and the DEGRADE, which is
 * the whole reason a wrong answer here matters: "repair may still be possible"
 * invites the user to run a repair that has nothing to work from, so every
 * unknown must land on the plainest sentence instead.
 *
 * [TranscriptRepairState.fetch]'s bridge round-trip is not exercised: it goes
 * through [ai.jolli.jollimemory.bridge.CliIntegrations.runIdeBridge], which has
 * no injectable seam, and the JVM-global-state rule forbids stubbing a Kotlin
 * singleton — the same limit [FileDiscarderTest] documents. What is reachable is
 * the guard that answers before any I/O, plus the deserialization default the
 * catch-all leans on.
 *
 * Pure in-memory: no Project, no VFS, no JVM globals.
 */
class TranscriptRepairStateTest {

    @Test
    fun `a repairable memory says a repair is still possible`() {
        TranscriptRepairState.emptyConversationsText("repairable") shouldBe
            "Conversation capture is missing but repair may still be possible"
    }

    @Test
    fun `a repaired memory says where its conversations came from`() {
        TranscriptRepairState.emptyConversationsText("repaired") shouldBe
            "Conversation capture was repaired from local transcript history"
    }

    @Test
    fun `an unrepairable memory says the capture failed outright`() {
        // Not "no conversations linked YET" — that reads as a capture still in
        // flight, which is exactly the lie this replaces.
        TranscriptRepairState.emptyConversationsText("unrepairable") shouldBe
            "No conversations were captured for this memory"
    }

    @Test
    fun `an unknown state degrades to the plainest sentence, never the optimistic one`() {
        // `present` is deliberately in this bucket: a pre-v5 summary reads as
        // `present` unconditionally, so it is no evidence that anything was
        // captured. `null` is what a failed fetch yields, and a state string this
        // build has never heard of is what a newer CLI can send.
        for (state in listOf(null, "present", "", "REPAIRABLE", "something-new")) {
            TranscriptRepairState.emptyConversationsText(state) shouldBe
                "No conversations were captured for this memory"
        }
    }

    @Test
    fun `the hydrate message carries the sentence under the key the webview reads`() {
        // The producer end of a cross-language pair with no compiler between it
        // and `SummaryScriptBuilder`'s handler. `SummaryScriptBuilderTest` pins
        // the other end against the same literals.
        TranscriptRepairState.hydrateMessage("repairable") shouldBe
            ("conversationsEmptyText" to mapOf("text" to "Conversation capture is missing but repair may still be possible"))
    }

    @Test
    fun `no hydrate is posted before a verdict has been fetched`() {
        // Null is what the panel holds until its background pass answers, and it
        // is exactly what the server-rendered HTML already prints — posting would
        // be an executeJavaScript round trip that changes nothing.
        TranscriptRepairState.hydrateMessage(null) shouldBe null
    }

    @Test
    fun `fetch answers unrepairable without touching the bridge when it has nothing to ask about`() {
        // The one branch reachable without a live CLI. Both arguments are
        // required to identify a memory, so an absent one is not a reason to
        // guess the hopeful answer.
        TranscriptRepairState.fetch("", "abc123") shouldBe "unrepairable"
        TranscriptRepairState.fetch("/repo", "") shouldBe "unrepairable"
    }
}

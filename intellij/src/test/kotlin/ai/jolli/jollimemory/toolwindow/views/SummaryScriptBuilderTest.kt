package ai.jolli.jollimemory.toolwindow.views

import ai.jolli.jollimemory.core.TranscriptRepairState
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Test

/**
 * Pins the webview end of the deferred-hydrate contract.
 *
 * The script is a JS string; the panel that posts to it is Kotlin. Nothing
 * between them is compiled together, so a message renamed on one side is a
 * silent no-op — the handler simply never runs. That failure is invisible here
 * in the worst possible way: the server-rendered HTML already carries the
 * PLAINEST empty-Conversations sentence, so a memory whose capture is still
 * repairable just keeps being described as one that was never captured.
 *
 * The producer side goes through [TranscriptRepairState.hydrateMessage] rather
 * than spelling the command, so it cannot drift from the constant on its own —
 * and the assertion below is against the LITERAL rather than the constant, so
 * changing the constant's value without updating the handler fails here instead
 * of passing tautologically.
 *
 * `SummaryPanel` itself needs a `Project` and has no unit seam, so "the panel
 * still posts this at all" stays unpinned; see the task report.
 *
 * Pure in-memory: no Project, no VFS, no JVM globals.
 */
class SummaryScriptBuilderTest {

    private val script = SummaryScriptBuilder.buildScript()

    @Test
    fun `handles the empty-conversations hydrate message the panel posts`() {
        script shouldContain "msg.command === 'conversationsEmptyText'"
        // Deliberately textContent, not innerHTML: the sentence is ours, but this
        // element must never become an HTML sink.
        script shouldContain "conversationsEmpty.textContent = msg.text"
    }

    @Test
    fun `the handler matches the command and payload key the producer sends`() {
        // The other direction of the same pair. Both ends are strings; this is
        // what makes a one-sided rename fail rather than go quiet.
        script shouldContain "'${TranscriptRepairState.HYDRATE_COMMAND}'"
        script shouldContain "msg.${TranscriptRepairState.HYDRATE_TEXT_KEY}"
    }
}
